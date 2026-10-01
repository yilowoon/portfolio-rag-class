"use strict";
/* 대시보드·필터에 쓰는 집계 질의 모음 */
const { db } = require("./db");

function overview() {
  const d = db();
  const one = (sql, ...a) => d.prepare(sql).get(...a) || {};
  return {
    docs: one("SELECT COUNT(*) c FROM documents WHERE kind='text'").c || 0,
    media: one("SELECT COUNT(*) c FROM documents WHERE kind='media'").c || 0,
    ok: one("SELECT COUNT(*) c FROM documents WHERE status='ok' AND kind != 'activity'").c || 0,
    empty: one("SELECT COUNT(*) c FROM documents WHERE status='empty'").c || 0,
    failed: one("SELECT COUNT(*) c FROM documents WHERE status='error'").c || 0,
    chunks: one("SELECT COUNT(*) c FROM chunks").c || 0,
    // 활동 색인(kind='activity')은 파일에서 뽑은 글이 아니므로 추출량에서 뺀다
    chars: one("SELECT COALESCE(SUM(text_chars),0) c FROM documents WHERE kind='text'").c || 0,
    embeddings: one("SELECT COUNT(*) c FROM embeddings").c || 0,
    projects: one("SELECT COUNT(*) c FROM projects").c || 0,
    profileItems: one("SELECT COUNT(*) c FROM profile_items").c || 0,
    lastRun: one("SELECT ended_at FROM ingest_runs ORDER BY id DESC LIMIT 1").ended_at || null,
  };
}

const byOrg = () =>
  db().prepare("SELECT org AS k, COUNT(*) c FROM documents WHERE kind='text' GROUP BY org ORDER BY c DESC").all();
const byType = () =>
  db().prepare("SELECT doc_type AS k, COUNT(*) c FROM documents WHERE kind='text' GROUP BY doc_type ORDER BY c DESC").all();
const byYear = () =>
  db()
    .prepare("SELECT year AS k, COUNT(*) c FROM documents WHERE kind='text' AND year IS NOT NULL GROUP BY year ORDER BY year")
    .all();

const recent = (n = 12) =>
  db()
    .prepare(
      "SELECT id, title, org, doc_type, year, text_chars FROM documents WHERE kind='text' AND status='ok' ORDER BY mtime DESC LIMIT ?"
    )
    .all(n);

const biggest = (n = 10) =>
  db()
    .prepare(
      "SELECT id, title, org, doc_type, year, text_chars FROM documents WHERE status='ok' AND kind='text' ORDER BY text_chars DESC LIMIT ?"
    )
    .all(n);

/* 수집 중 마스킹이 적용된 문서 */
const redacted = () =>
  db().prepare("SELECT id, title, redacted FROM documents WHERE redacted IS NOT NULL ORDER BY title").all();

const failures = (n = 30) =>
  db()
    .prepare("SELECT id, title, rel_path, ext, error FROM documents WHERE status IN ('error','empty') ORDER BY ext, title LIMIT ?")
    .all(n);

module.exports = { overview, byOrg, byType, byYear, recent, biggest, failures, redacted };
