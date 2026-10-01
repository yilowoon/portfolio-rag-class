"use strict";
/*
 * 포트폴리오 활동을 검색·질의응답 대상에 포함시킨다.
 *
 *   node scripts/index-activities.js
 *   node scripts/index-activities.js --force   # 내용이 같아도 전부 다시 만든다
 *
 * 왜 필요한가
 *   원본 문서(myprofile)만 색인돼 있어서 "펀드 조성한 적 있나" 같은 질문에
 *   정리해 둔 활동이 걸리지 않았다. 활동은 구조화 데이터라 포트폴리오 화면에서만
 *   보였는데, 검색과 질의응답에서도 쓸 수 있게 한다.
 *
 * 방식
 *   활동 1건당 documents 행 하나(kind='activity')를 만들고 본문을 청크로 넣는다.
 *   기존 검색·RAG 가 documents 를 기준으로 제목·기관·연도를 읽으므로 그대로 재사용된다.
 *   kind 가 'text' 가 아니라서 대시보드의 '문서의 숫자' 통계에는 섞이지 않는다.
 *
 *   내용이 바뀐 활동만 다시 만든다. 전부 지웠다 새로 넣으면 청크가 새 ID 를 받아
 *   임베딩이 CASCADE 로 함께 삭제되고, 실행할 때마다 전체를 다시 임베딩하게 된다.
 *   (실제로 그렇게 만들었다가 API 일일 할당량을 태웠다)
 */
const crypto = require("crypto");
const { db } = require("../src/db");
const { chunk } = require("../src/chunk");
const { CATEGORY_META } = require("../src/portfolio");

const FORCE = process.argv.includes("--force");
const now = () => new Date().toISOString();
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);

/* 활동 한 건을 검색용 본문으로 편다 */
function activityText(a) {
  const period =
    [a.period_start, a.period_end].filter(Boolean).join(" ~ ") ||
    (a.period_start ? a.period_start + " ~ 현재" : "시기 미상");
  const lines = [`[${a.category}] ${a.title}`, `기간: ${period}`];
  if (a.org) lines.push(`기관: ${a.org}`);
  if (a.role) lines.push(`역할: ${a.role}`);
  if (a.summary) lines.push("", a.summary);
  if (a.outcomes) {
    lines.push("", "성과:");
    for (const o of String(a.outcomes).split(" / ")) lines.push(`- ${o}`);
  }
  if (a.tags) lines.push("", `관련: ${String(a.tags).split(",").map((t) => t.trim()).filter(Boolean).join(", ")}`);
  const meta = CATEGORY_META[a.category];
  if (meta) lines.push("", `분야 설명: ${meta.desc}`);
  return lines.join("\n");
}

function yearOf(a) {
  const m = String(a.period_end || a.period_start || "").match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

function main() {
  const d = db();
  const acts = d.prepare("SELECT * FROM projects ORDER BY id").all();
  if (!acts.length) {
    console.log("정리된 활동이 없습니다. 먼저 npm run seed 를 실행하세요.");
    return;
  }

  const existing = new Map(
    d.prepare("SELECT id, abs_path, content_hash FROM documents WHERE kind='activity'").all()
      .map((r) => [r.abs_path, r])
  );

  const delFts = d.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)");
  const getChunks = d.prepare("SELECT id, text FROM chunks WHERE doc_id=?");
  const delDoc = d.prepare("DELETE FROM documents WHERE id=?"); // chunks·doc_text·embeddings 는 CASCADE
  const insDoc = d.prepare(
    `INSERT INTO documents (abs_path, rel_path, file_name, ext, org, org_type, title, doc_type, year,
                            size, mtime, content_hash, kind, status, error, text_chars, chunk_count, redacted, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insText = d.prepare("INSERT INTO doc_text (doc_id, text) VALUES (?,?)");
  const insChunk = d.prepare("INSERT INTO chunks (doc_id, seq, text, chars) VALUES (?,?,?,?)");
  const insFts = d.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?,?)");
  const lastId = d.prepare("SELECT last_insert_rowid() AS id");

  const dropDoc = (docId) => {
    for (const c of getChunks.all(docId)) delFts.run(c.id, c.text);
    delDoc.run(docId);
  };

  let added = 0, updated = 0, unchanged = 0, chunks = 0;
  const seen = new Set();

  d.exec("BEGIN");
  try {
    for (const a of acts) {
      const key = "activity:" + a.id;
      seen.add(key);
      const text = activityText(a);
      const h = hash(text);
      const prev = existing.get(key);

      if (prev && prev.content_hash === h && !FORCE) {
        unchanged++;
        continue; // 청크와 임베딩을 그대로 둔다
      }
      if (prev) dropDoc(prev.id);

      const parts = chunk(text);
      if (!parts.length) continue;
      insDoc.run(
        key,
        `포트폴리오/${a.category}/${a.title}`,
        a.title, "",
        a.org || "포트폴리오", "활동",
        a.title, a.category, yearOf(a),
        text.length, Date.parse(a.updated_at || now()) || Date.now(),
        h, "activity", "ok", null, text.length, parts.length, null, now()
      );
      const docId = lastId.get().id;
      insText.run(docId, text);
      parts.forEach((p, i) => {
        insChunk.run(docId, i, p, p.length);
        insFts.run(lastId.get().id, p);
        chunks++;
      });
      if (prev) updated++; else added++;
    }

    /* 삭제된 활동의 색인은 거둬들인다 */
    let removed = 0;
    for (const [key, row] of existing) {
      if (!seen.has(key)) { dropDoc(row.id); removed++; }
    }
    d.exec("COMMIT");

    const total = d.prepare("SELECT COUNT(*) c FROM chunks").get().c;
    const embedded = d.prepare("SELECT COUNT(*) c FROM embeddings").get().c;
    const pending = total - embedded;
    console.log(
      `활동 ${acts.length}건 — 추가 ${added} / 갱신 ${updated} / 변경없음 ${unchanged}` +
        (removed ? ` / 삭제 ${removed}` : "")
    );
    console.log(
      `청크 ${chunks}개 생성 · 전체 ${total}개` +
        (pending > 0 ? ` (임베딩 대기 ${pending}개)` : " (임베딩 모두 완료)")
    );
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

main();
