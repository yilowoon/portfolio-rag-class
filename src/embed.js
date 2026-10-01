"use strict";
/*
 * 임베딩(선택 기능).
 * GEMINI_API_KEY 가 있으면 청크를 벡터로 바꿔 저장하고, 질의도 같은 방식으로 벡터화한다.
 * 키가 없으면 모든 함수가 조용히 비활성 상태로 동작하고, 검색은 키워드만으로 돌아간다.
 */
const { db, onSwitch } = require("./db");
const { gemini } = require("./config");

let _cache = null; // { ids: Int32Array, dim, mat: Float32Array }

function toBlob(arr) {
  const f = Float32Array.from(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
function fromBlob(buf, dim) {
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + dim * 4));
}

function hasEmbeddings() {
  try {
    return db().prepare("SELECT COUNT(*) c FROM embeddings").get().c > 0;
  } catch (_) {
    return false;
  }
}

function invalidateCache() {
  _cache = null;
}

/* 프로필을 바꾸면 이 행렬은 이전 DB 의 벡터다 — 반드시 버린다 */
onSwitch(invalidateCache);

/* 전체 벡터를 하나의 Float32Array 로 올려 코사인 유사도를 계산한다(수만 건까지 충분). */
function loadMatrix() {
  if (_cache) return _cache;
  const rows = db().prepare("SELECT chunk_id, dim, vec FROM embeddings ORDER BY chunk_id").all();
  if (!rows.length) return (_cache = { ids: [], dim: 0, mat: new Float32Array(0) });
  const dim = rows[0].dim;
  const mat = new Float32Array(rows.length * dim);
  const ids = new Int32Array(rows.length);
  rows.forEach((r, i) => {
    ids[i] = r.chunk_id;
    const v = fromBlob(Buffer.from(r.vec), dim);
    // 저장 시 정규화해 두므로 내적 = 코사인
    mat.set(v.subarray(0, dim), i * dim);
  });
  return (_cache = { ids, dim, mat });
}

function normalize(arr) {
  let n = 0;
  for (const x of arr) n += x * x;
  n = Math.sqrt(n) || 1;
  return arr.map((x) => x / n);
}

function cosineTopK(queryVec, k = 60) {
  const { ids, dim, mat } = loadMatrix();
  if (!dim || !ids.length) return [];
  const q = Float32Array.from(normalize(Array.from(queryVec)));
  const n = ids.length;
  const scored = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j++) s += mat[off + j] * q[j];
    scored[i] = { chunk_id: ids[i], sim: s };
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k);
}

async function callEmbed(texts, taskType) {
  const key = gemini.key();
  if (!key) return null;
  const model = gemini.embedModel();
  const url = `${gemini.base()}/v1beta/models/${model}:batchEmbedContents?key=${encodeURIComponent(key)}`;
  const body = {
    requests: texts.map((t) => ({
      model: "models/" + model,
      content: { parts: [{ text: t.slice(0, 8000) }] },
      taskType,
    })),
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`임베딩 실패 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.embeddings || []).map((e) => e.values);
}

async function embedQuery(text) {
  if (!gemini.enabled()) return null;
  const out = await callEmbed([text], "RETRIEVAL_QUERY");
  return out && out[0] ? out[0] : null;
}

async function embedChunks(rows, { batch = 32, onProgress } = {}) {
  if (!gemini.enabled()) throw new Error("GEMINI_API_KEY 가 없어 임베딩을 만들 수 없습니다.");
  const d = db();
  const ins = d.prepare("INSERT OR REPLACE INTO embeddings (chunk_id, dim, model, vec) VALUES (?,?,?,?)");
  const model = gemini.embedModel();
  let done = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const vecs = await callEmbed(slice.map((r) => r.text), "RETRIEVAL_DOCUMENT");
    if (!vecs) break;
    d.exec("BEGIN");
    try {
      slice.forEach((r, j) => {
        const v = vecs[j];
        if (!v) return;
        const nv = normalize(v);
        ins.run(r.id, nv.length, model, toBlob(nv));
      });
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    done += slice.length;
    if (onProgress) onProgress(done, rows.length);
  }
  invalidateCache();
  return done;
}

module.exports = { hasEmbeddings, cosineTopK, embedQuery, embedChunks, invalidateCache };
