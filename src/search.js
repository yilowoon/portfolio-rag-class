"use strict";
/*
 * 검색 계층.
 *  - 기본: FTS5(trigram) 전문검색 + BM25 랭킹
 *  - 2글자 이하 토큰(한국어에 흔함)은 trigram 색인이 못 잡으므로 LIKE 로 보완
 *  - 임베딩이 있으면 벡터 유사도와 RRF(순위 융합)로 합친다
 */
const { db } = require("./db");
const { cosineTopK, hasEmbeddings, embedQuery } = require("./embed");

const MAX_CANDIDATES = 400;

/* 질문투 어휘는 검색에 도움이 되지 않으므로 뺀다 */
const STOPWORDS = new Set([
  "무엇", "무엇인가", "무엇인지", "뭐야", "뭔가", "어떻게", "어떤", "어디", "언제", "누가", "왜",
  "알려줘", "알려주세요", "정리해줘", "정리해주세요", "설명해줘", "설명해주세요", "요약해줘",
  "대해", "대해서", "관련", "관련해", "관련해서", "관해", "관해서", "있나", "있는지", "있어",
  "해줘", "주세요", "그리고", "그러나", "내가", "제가", "나의", "저의", "우리", "한번", "좀",
]);

/* 한국어 조사 — trigram 은 부분일치라 조사가 붙으면 원형을 못 찾는다 */
const PARTICLES = [
  "으로부터", "에서는", "으로써", "이라는", "으로서", "에게서", "라는", "에서", "에게", "한테",
  "까지", "부터", "으로", "에는", "이나", "이란", "라고", "이며", "와의", "과의", "들의", "에도",
  "이라", "으며", "하고", "인가", "인지", "이다", "입니다", "했던", "하는", "했던", "한", "의",
  "은", "는", "이", "가", "을", "를", "에", "로", "와", "과", "도", "만", "며",
];

function stem(token) {
  for (const p of PARTICLES) {
    if (token.length - p.length >= 3 && token.endsWith(p)) return token.slice(0, -p.length);
  }
  return null;
}

function tokenize(q) {
  return String(q || "")
    .replace(/["*()?!,.]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOPWORDS.has(t));
}

function buildFilters(opts) {
  const where = [];
  const args = [];
  if (opts.org) { where.push("d.org = ?"); args.push(opts.org); }
  if (opts.docType) { where.push("d.doc_type = ?"); args.push(opts.docType); }
  if (opts.year) { where.push("d.year = ?"); args.push(Number(opts.year)); }
  if (opts.yearFrom) { where.push("d.year >= ?"); args.push(Number(opts.yearFrom)); }
  if (opts.yearTo) { where.push("d.year <= ?"); args.push(Number(opts.yearTo)); }
  return { sql: where.length ? " AND " + where.join(" AND ") : "", args };
}

/*
 * FTS5 MATCH 식.
 * 토큰마다 (원형 OR 조사뗀형) 을 만들고, 토큰들 사이는 join(AND/OR)으로 묶는다.
 * 3글자 미만은 trigram 색인이 없으므로 제외한다.
 */
function ftsExpr(tokens, join) {
  const groups = [];
  for (const t of tokens) {
    const variants = [];
    if (t.length >= 3) variants.push(t);
    const s = stem(t);
    if (s && s.length >= 3 && s !== t) variants.push(s);
    if (variants.length) {
      groups.push("(" + variants.map((v) => '"' + v.replace(/"/g, "") + '"').join(" OR ") + ")");
    }
  }
  if (!groups.length) return null;
  return groups.join(" " + join + " ");
}

function keywordSearch(q, opts = {}) {
  const d = db();
  const tokens = tokenize(q);
  if (!tokens.length) return [];
  const limit = Number(opts.limit || 30);
  const f = buildFilters(opts);
  const short = tokens.filter((t) => t.length < 3);

  const runFts = (expr) =>
    d
      .prepare(
        `SELECT c.id, c.doc_id, c.seq, c.text,
                bm25(chunks_fts) AS bm,
                d.title, d.org, d.doc_type, d.year, d.rel_path, d.ext
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN documents d ON d.id = c.doc_id
         WHERE chunks_fts MATCH ?${f.sql}
         ORDER BY bm
         LIMIT ?`
      )
      .all(expr, ...f.args, MAX_CANDIDATES);

  /* 2글자 토큰(예: 축산, 악취)은 trigram 색인에 없으므로 LIKE 로 후보를 따로 모은다 */
  const runLike = (terms) =>
    d
      .prepare(
        `SELECT c.id, c.doc_id, c.seq, c.text, 0 AS bm,
                d.title, d.org, d.doc_type, d.year, d.rel_path, d.ext
         FROM chunks c JOIN documents d ON d.id = c.doc_id
         WHERE ${terms.map(() => "c.text LIKE ?").join(" AND ")}${f.sql}
         LIMIT ?`
      )
      .all(...terms.map((t) => "%" + t + "%"), ...f.args, MAX_CANDIDATES);

  /* 질의어가 몇 개나 실제로 들어있는지를 1순위, BM25 를 2순위로 삼는다 */
  const rerank = (list) => {
    for (const r of list) {
      let n = 0;
      for (const t of tokens) {
        const st = stem(t);
        if (r.text.includes(t) || (st && r.text.includes(st))) n++;
      }
      r.hits = n;
    }
    list.sort((a, b) => b.hits - a.hits || a.bm - b.bm);
    return list;
  };

  const candidates = new Map();
  const add = (list) => { for (const r of list) if (!candidates.has(r.id)) candidates.set(r.id, r); };

  const andExpr = ftsExpr(tokens, "AND");
  if (andExpr) {
    const andRows = runFts(andExpr);
    const strict = short.length ? andRows.filter((r) => short.every((s) => r.text.includes(s))) : andRows;
    add(strict);
    // 질문투처럼 토큰이 많으면 AND 로는 결과가 거의 없다 → OR 로 완화
    if (strict.length < limit) add(runFts(ftsExpr(tokens, "OR")));
  }
  if (short.length) add(runLike(short));
  if (!candidates.size) add(runLike(tokens));

  // 같은 문서의 청크가 결과를 독차지하지 않도록 문서당 최대 2개로 제한
  const perDoc = new Map();
  const diversified = [];
  for (const r of rerank([...candidates.values()])) {
    const n = perDoc.get(r.doc_id) || 0;
    if (n >= 2) continue;
    perDoc.set(r.doc_id, n + 1);
    diversified.push(r);
    if (diversified.length >= limit) break;
  }
  return diversified.map((r, i) => ({ ...r, rank: i + 1, source: "keyword" }));
}

async function vectorSearch(q, opts = {}) {
  if (!hasEmbeddings()) return [];
  const vec = await embedQuery(q);
  if (!vec) return [];
  const hits = cosineTopK(vec, Number(opts.limit || 30) * 3);
  if (!hits.length) return [];
  const d = db();
  const f = buildFilters(opts);
  const ids = hits.map((h) => h.chunk_id);
  const rows = d
    .prepare(
      `SELECT c.id, c.doc_id, c.seq, c.text, d.title, d.org, d.doc_type, d.year, d.rel_path, d.ext
       FROM chunks c JOIN documents d ON d.id = c.doc_id
       WHERE c.id IN (${ids.map(() => "?").join(",")})${f.sql}`
    )
    .all(...ids, ...f.args);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  hits.forEach((h) => {
    const r = byId.get(h.chunk_id);
    if (r) out.push({ ...r, sim: h.sim, rank: out.length + 1, source: "vector" });
  });
  return out.slice(0, Number(opts.limit || 30));
}

/* Reciprocal Rank Fusion: 서로 다른 랭킹을 순위 기반으로 합친다 */
function fuse(lists, limit) {
  const K = 60;
  const acc = new Map();
  for (const list of lists) {
    list.forEach((r, i) => {
      const cur = acc.get(r.id) || { ...r, score: 0, sources: [] };
      cur.score += 1 / (K + i + 1);
      if (!cur.sources.includes(r.source)) cur.sources.push(r.source);
      if (r.sim !== undefined) cur.sim = r.sim;
      acc.set(r.id, cur);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

async function hybridSearch(q, opts = {}) {
  const limit = Number(opts.limit || 20);
  const kw = keywordSearch(q, { ...opts, limit: limit * 2 });
  let vec = [];
  if (opts.useVector !== false) {
    try { vec = await vectorSearch(q, { ...opts, limit: limit * 2 }); } catch (_) {}
  }
  if (!vec.length) return kw.slice(0, limit);
  return fuse([kw, vec], limit);
}

/* 검색어 주변 발췌 + <mark> 강조 */
function snippet(text, q, width = 220) {
  const base = tokenize(q);
  const tokens = [...new Set(base.concat(base.map(stem).filter(Boolean)))].sort((a, b) => b.length - a.length);
  let at = -1;
  for (const t of tokens) {
    at = text.toLowerCase().indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(width / 3));
  let s = text.slice(start, start + width);
  if (start > 0) s = "… " + s;
  if (start + width < text.length) s = s + " …";
  const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = esc(s);
  for (const t of tokens) {
    if (t.length < 1) continue;
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    s = s.replace(re, (m) => "<mark>" + m + "</mark>");
  }
  return s;
}

module.exports = { keywordSearch, vectorSearch, hybridSearch, snippet, tokenize };
