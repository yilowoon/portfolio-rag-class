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

/*
 * 기업 재무를 '연도 × 주요계정' 표로 정리한다.
 * 원자료는 계정이 30종 넘고 개별(OFS)·연결(CFS)이 섞여 있어, 그대로 늘어놓으면 읽히지 않는다.
 * 규모와 흐름을 보는 데 쓰는 6개 계정만 골라 연도별로 나란히 둔다.
 * 연결이 있으면 연결을 쓴다 — 종속회사를 포함한 쪽이 기업 규모에 가깝다.
 */
const FIN_ACCOUNTS = ["매출액", "영업이익", "당기순이익(손실)", "자산총계", "부채총계", "자본총계"];

function companyFinance(corpCode) {
  const rows = db()
    .prepare("SELECT bsns_year, account_nm, fs_div, amount FROM company_financials WHERE corp_code = ?")
    .all(corpCode);
  if (!rows.length) return null;

  const num = (v) => {
    const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const years = [...new Set(rows.map((r) => r.bsns_year))].sort().reverse().slice(0, 3);
  const pick = (year, account) => {
    const cand = rows.filter((r) => r.bsns_year === year && r.account_nm === account);
    const cfs = cand.find((r) => r.fs_div === "CFS");
    const ofs = cand.find((r) => r.fs_div === "OFS");
    const hit = cfs || ofs;
    return hit ? { value: num(hit.amount), basis: hit.fs_div === "CFS" ? "연결" : "개별" } : null;
  };

  const accounts = FIN_ACCOUNTS.map((name) => ({
    name,
    cells: years.map((y) => pick(y, name)),
  })).filter((a) => a.cells.some(Boolean));

  if (!accounts.length) return null;

  /* 가장 최근 두 해가 모두 있으면 증감률을 낸다 */
  for (const a of accounts) {
    const [cur, prev] = a.cells;
    a.change =
      cur && prev && cur.value !== null && prev.value !== null && prev.value !== 0
        ? ((cur.value - prev.value) / Math.abs(prev.value)) * 100
        : null;
  }

  const bases = [...new Set(accounts.flatMap((a) => a.cells.filter(Boolean).map((c) => c.basis)))];
  return { years, accounts, basis: bases.join("·") };
}

module.exports = { overview, byOrg, byType, byYear, recent, biggest, failures, redacted, companyFinance };
