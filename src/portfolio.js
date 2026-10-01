"use strict";
/* 포트폴리오(활동) 분류·타임라인·자료 충실도 집계 */
const { db } = require("./db");

/* 활동 분류 — 화면 순서도 이 순서를 따른다 */
const CATEGORIES = ["기술개발", "정책연구", "논문", "저서", "창업활동", "수상내역", "대외활동"];

const CATEGORY_META = {
  기술개발: { icon: "◆", desc: "제품·기술을 직접 설계하고 개발한 이력" },
  정책연구: { icon: "◇", desc: "산업·지역 정책을 기획하고 제도로 만든 이력" },
  논문: { icon: "▣", desc: "학술지·학회에 발표한 연구" },
  저서: { icon: "▤", desc: "단행본·보고서 등 저술" },
  창업활동: { icon: "▲", desc: "창업·투자·액셀러레이팅으로 기업을 키운 이력" },
  수상내역: { icon: "★", desc: "대외적으로 인정받은 성과" },
  대외활동: { icon: "◉", desc: "이사회·글로벌 협력·네트워크 활동" },
};

const PROFILE_KINDS = ["경력", "학력", "자격", "어학", "기타"];

/* 분류별 건수(빈 분류도 0 으로 채워 반환) */
function byCategory() {
  const rows = db().prepare("SELECT category k, COUNT(*) c FROM projects GROUP BY category").all();
  const map = new Map(rows.map((r) => [r.k, r.c]));
  return CATEGORIES.map((k) => ({
    key: k,
    count: map.get(k) || 0,
    icon: (CATEGORY_META[k] || {}).icon || "·",
    desc: (CATEGORY_META[k] || {}).desc || "",
  }));
}

/* 기간 문자열에서 연도만 뽑는다 (정렬·그룹 기준) */
function yearOf(a) {
  const s = String(a.period_end || a.period_start || "");
  const m = s.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

function periodLabel(a) {
  const s = (a.period_start || "").trim();
  const e = (a.period_end || "").trim();
  if (!s && !e) return "시기 미상";
  if (s && e && s === e) return s;
  if (s && !e) return s + " ~ 현재";
  if (!s && e) return e;
  return s + " ~ " + e;
}

/*
 * 연도 역순 타임라인.
 * cat 이 주어지면 그 분류만, 아니면 전체를 연도별로 묶어 돌려준다.
 */
function timeline(cat) {
  const where = cat ? " WHERE category = ?" : "";
  const rows = db()
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM project_docs pd WHERE pd.project_id=p.id) AS doc_count
       FROM projects p${where}`
    )
    .all(...(cat ? [cat] : []));

  for (const r of rows) {
    r.year = yearOf(r);
    r.period = periodLabel(r);
    r.tagList = String(r.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
    r.icon = (CATEGORY_META[r.category] || {}).icon || "·";
  }
  rows.sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title, "ko"));

  const groups = [];
  let cur = null;
  for (const r of rows) {
    const key = r.year || "시기 미상";
    if (!cur || cur.year !== key) {
      cur = { year: key, items: [] };
      groups.push(cur);
    }
    cur.items.push(r);
  }
  return groups;
}

/*
 * 활동의 연도별 분포.
 * 빈 연도도 0 으로 채워 돌려준다 — 활동이 없던 시기도 궤적의 일부라 간격이 보여야 한다.
 * (문서 기준으로 집계하면 프로필 파일 8건이 전부 같은 해라 막대 하나만 남는다)
 */
function byYear() {
  const rows = db().prepare("SELECT category, period_start s, period_end e FROM projects").all();
  const counts = new Map();
  for (const r of rows) {
    const y = yearOf({ period_start: r.s, period_end: r.e });
    if (y) counts.set(y, (counts.get(y) || 0) + 1);
  }
  if (!counts.size) return { data: [], max: 0, from: null, to: null, total: 0 };

  const years = [...counts.keys()];
  const from = Math.min(...years);
  const to = Math.max(...years);
  const data = [];
  for (let y = from; y <= to; y++) data.push({ year: y, count: counts.get(y) || 0 });
  return {
    data,
    max: Math.max(...counts.values()),
    from,
    to,
    total: rows.length,
    peak: data.reduce((a, b) => (b.count > a.count ? b : a), data[0]),
  };
}

/*
 * 자료 충실도.
 * 분류별로 항목이 있는지, 근거 문서가 붙어 있는지를 보고 보완이 필요한 곳을 알려준다.
 */
function coverage() {
  const d = db();
  const rows = d
    .prepare(
      `SELECT p.category k, COUNT(*) c,
              SUM(CASE WHEN (SELECT COUNT(*) FROM project_docs pd WHERE pd.project_id=p.id) > 0 THEN 1 ELSE 0 END) withdoc
       FROM projects p GROUP BY p.category`
    )
    .all();
  const map = new Map(rows.map((r) => [r.k, r]));
  const out = CATEGORIES.map((k) => {
    const r = map.get(k) || { c: 0, withdoc: 0 };
    return {
      key: k,
      count: r.c || 0,
      withDoc: r.withdoc || 0,
      status: r.c === 0 ? "없음" : r.withdoc === 0 ? "근거부족" : "확보",
    };
  });
  const years = d
    .prepare("SELECT period_start s, period_end e FROM projects")
    .all()
    .flatMap((r) => [r.s, r.e])
    .map((x) => (String(x || "").match(/(19|20)\d{2}/) || [])[0])
    .filter(Boolean)
    .map(Number);
  return {
    items: out,
    missing: out.filter((x) => x.count === 0).map((x) => x.key),
    thin: out.filter((x) => x.count > 0 && x.withDoc === 0).map((x) => x.key),
    spanFrom: years.length ? Math.min(...years) : null,
    spanTo: years.length ? Math.max(...years) : null,
    total: out.reduce((n, x) => n + x.count, 0),
  };
}

module.exports = { CATEGORIES, CATEGORY_META, PROFILE_KINDS, byCategory, byYear, timeline, coverage, periodLabel };
