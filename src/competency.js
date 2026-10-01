"use strict";
/*
 * 역량 매칭 엔진.
 *
 *  1) 내 역량 벡터  — 포트폴리오 활동에서 6개 축의 점수(0~100)를 계산한다.
 *  2) 기업 요구 벡터 — 업종(KSIC 2자리)별 가중치 표에서 가져온다.
 *  3) 적합도        — 기업이 중요하게 보는 축에서 내가 얼마나 강한지를 가중평균한다.
 *  4) 격차·보완점   — 요구 수준에 못 미치는 축을 찾아 무엇을 채워야 하는지 알려준다.
 *
 * 기업 요구 벡터는 공시 데이터로 알 수 없는 값이라 config/industry-weights.json 의
 * 추정치를 쓴다. 이 점은 화면에도 표시한다.
 */
const fs = require("fs");
const path = require("path");
const { db, onSwitch } = require("./db");

const AXES = ["기술개발", "정책공공", "창업투자", "글로벌", "연구학술", "경영리더십"];

const AXIS_META = {
  기술개발: { label: "기술개발", desc: "제품·기술을 직접 설계하고 개발한 경험" },
  정책공공: { label: "정책·공공", desc: "산업·지역 정책 기획과 공공기관 운영 경험" },
  창업투자: { label: "창업·투자", desc: "창업·펀드 조성·액셀러레이팅 경험" },
  글로벌: { label: "글로벌", desc: "해외 사업·국제협력·글로벌 네트워크" },
  연구학술: { label: "연구·학술", desc: "논문·저술·학위 등 연구 역량" },
  경영리더십: { label: "경영·리더십", desc: "조직을 맡아 성과를 낸 경험" },
};

/*
 * 활동 분류가 어느 축에 얼마나 기여하는지.
 * 한 활동이 여러 축에 걸칠 수 있어 분류 기여도 + 태그 보정을 함께 쓴다.
 */
const CATEGORY_AXIS = {
  기술개발: { 기술개발: 1.0, 연구학술: 0.2 },
  정책연구: { 정책공공: 1.0, 연구학술: 0.3 },
  논문: { 연구학술: 1.0, 정책공공: 0.2 },
  저서: { 연구학술: 1.0 },
  창업활동: { 창업투자: 1.0, 경영리더십: 0.4 },
  // 수상은 그 자체가 특정 역량이 아니다. 아래 TAG_AXIS 가 상의 성격(기술·창업·정책)을
  // 보고 해당 축에 얹도록 두고, 여기서는 축을 직접 주지 않는다.
  수상내역: {},
  대외활동: { 글로벌: 0.6, 경영리더십: 0.4, 정책공공: 0.2 },
};

/* 태그로 축을 보정한다(예: 대외활동이라도 ODA·글로벌이면 글로벌을 더 준다) */
const TAG_AXIS = [
  [/글로벌|ODA|해외|MIT|실리콘밸리|중남미|인도네시아|페루|국제/i, "글로벌", 0.6],
  [/특허|실용신안|지식재산|개발|기술/i, "기술개발", 0.4],
  [/펀드|투자|액셀러|창업|IPO/i, "창업투자", 0.5],
  [/정책|제도|거버넌스|공공|지역산업|균형발전/i, "정책공공", 0.4],
  [/논문|연구|학회|리포트/i, "연구학술", 0.4],
];

/* 경력 직위에서 리더십 점수를 얹는다 */
const ROLE_LEADERSHIP = [
  [/대표이사|상임대표|Founder/i, 14],
  [/기관장|본부장|이사(?!회)/i, 10],
  [/팀장|과장/i, 5],
];

/*
 * 가중치 표 캐시.
 * 기업 수천 건을 평가하므로 매번 파일을 읽으면 안 된다.
 * 파일이 바뀌면(mtime) 자동으로 다시 읽어, 표를 고친 뒤 서버를 재시작할 필요는 없다.
 */
const WEIGHTS_PATH = path.join(__dirname, "..", "config", "industry-weights.json");
let _weights = null;
let _weightsMtime = 0;
let _weightsCheckedAt = 0;
const STAT_INTERVAL_MS = 2000;

function loadWeights() {
  // 기업 수천 건을 평가하므로 statSync 조차 건건이 하면 부담이 된다.
  // 2초에 한 번만 변경 여부를 확인한다 — 표를 고치면 곧 반영되면서 비용은 없다.
  const now = Date.now();
  if (_weights && now - _weightsCheckedAt < STAT_INTERVAL_MS) return _weights;
  _weightsCheckedAt = now;

  const mtime = fs.statSync(WEIGHTS_PATH).mtimeMs;
  if (!_weights || mtime !== _weightsMtime) {
    _weights = JSON.parse(fs.readFileSync(WEIGHTS_PATH, "utf8"));
    _weightsMtime = mtime;
  }
  return _weights;
}

/* ── 1) 내 역량 벡터 ─────────────────────────── */

function myVector() {
  const d = db();
  const acts = d.prepare("SELECT category, tags, outcomes, period_start, period_end, org FROM projects").all();
  const careers = d.prepare("SELECT title, description FROM profile_items WHERE kind='경력'").all();
  const certs = d.prepare("SELECT COUNT(*) c FROM profile_items WHERE kind='자격'").get().c;

  const raw = Object.fromEntries(AXES.map((a) => [a, 0]));
  const counts = Object.fromEntries(AXES.map((a) => [a, 0]));

  for (const a of acts) {
    const base = CATEGORY_AXIS[a.category] || {};
    // 성과가 적힌 활동은 무게를 더 준다 — 실적이 검증된 항목이므로
    const weight = 1 + (a.outcomes && a.outcomes.trim() ? 0.5 : 0);
    for (const [axis, share] of Object.entries(base)) {
      raw[axis] += share * weight;
      if (share >= 0.3) counts[axis] += 1;
    }
    const hay = [a.tags, a.org, a.outcomes].filter(Boolean).join(" ");
    for (const [re, axis, share] of TAG_AXIS) {
      if (re.test(hay)) raw[axis] += share * weight * 0.5;
    }
  }

  /*
   * 리더십은 '가장 높이 올라간 자리'로 본다.
   * 경력 9건을 모두 더하면 자리를 많이 옮긴 것이 곧 리더십으로 잡혀 과대평가된다.
   * 최고 직위 점수에 경력 기관 수를 소폭만 얹는다.
   */
  let topRole = 0;
  for (const c of careers) {
    const hay = c.title + " " + (c.description || "");
    for (const [re, pts] of ROLE_LEADERSHIP) {
      if (re.test(hay)) { topRole = Math.max(topRole, pts / 10); break; }
    }
  }
  raw.경영리더십 += topRole + Math.min(careers.length * 0.15, 1.5);
  raw.기술개발 += Math.min(certs, 13) / 13; // 자격은 기술·전문성의 보조 지표

  /*
   * 0~100 환산 — '축 간 상대 강도'로 읽는다.
   * 절대 기준치를 두면 본인 기록만으로 계산하는 구조상 모든 축이 100 으로 포화된다.
   * 그래서 가장 두꺼운 축을 100 으로 놓고 나머지를 비율로 환산한다.
   * 즉 100 은 '완벽'이 아니라 '내 안에서 가장 강한 축'이라는 뜻이다.
   * ANCHOR 는 포트폴리오가 빈약할 때 100 이 찍히는 것을 막는 하한선이다.
   */
  const ANCHOR = 10;
  const top = Math.max(ANCHOR, ...AXES.map((a) => raw[a]));
  const score = {};
  for (const a of AXES) {
    score[a] = Math.max(0, Math.min(100, Math.round((raw[a] / top) * 100)));
  }
  return { score, counts, raw, top };
}

/* ── 2) 기업 요구 벡터 ───────────────────────── */

function industryOf(indutyCode) {
  const cfg = loadWeights();
  const key = String(indutyCode || "").padStart(2, "0").slice(0, 2);
  const hit = cfg.industries[key];
  return {
    code: key,
    label: hit ? hit.label : cfg._default.label,
    w: hit ? hit.w : cfg._default.w,
    estimated: true,
  };
}

/* ── 3) 적합도 ───────────────────────────────── */

/*
 * 적합도 = 두 관점을 절반씩 섞는다.
 *
 *  ① 전반 적합  — 요구 가중치로 내 점수를 가중평균. 업종 전반의 눈높이에서 본 점수.
 *  ② 강조축 적합 — 그 업종이 '평균보다 특히 중시하는' 축만 골라 본 점수.
 *
 * ①만 쓰면 업종별 차이가 거의 안 나고(가중치 총합이 비슷해서), ②만 쓰면 축 한두 개로
 * 점수가 출렁인다. 섞으면 업종 성격 차이가 드러나면서도 안정적이다.
 */
function fitScore(my, want) {
  const ws = AXES.map((a) => want[a] || 0);
  const mean = ws.reduce((s, x) => s + x, 0) / AXES.length;

  let n1 = 0, d1 = 0, n2 = 0, d2 = 0;
  AXES.forEach((a, i) => {
    const w = ws[i];
    const m = my[a] || 0;
    n1 += w * m;
    d1 += w;
    const emph = Math.max(0, w - mean); // 평균을 넘는 만큼만 강조축으로 본다
    n2 += emph * m;
    d2 += emph;
  });

  const overall = d1 ? n1 / d1 : 0;
  const emphasis = d2 ? n2 / d2 : overall;
  return Math.round(overall * 0.5 + emphasis * 0.5);
}

/* 축별 격차 — 요구 수준에 못 미치는 정도 */
function gaps(my, want) {
  return AXES.map((a) => ({
    axis: a,
    label: AXIS_META[a].label,
    mine: my[a] || 0,
    want: want[a] || 0,
    gap: Math.max(0, (want[a] || 0) - (my[a] || 0)),
  })).sort((x, y) => y.gap - x.gap);
}

/* ── 4) 보완 추천 ────────────────────────────── */

const TIPS = {
  기술개발: [
    "최근 개발 이력을 항목으로 추가하세요. 특허·실용신안은 등록번호까지 적어야 검증 가능한 실적이 됩니다.",
    "이 업종은 기술 실적을 가장 크게 봅니다. 담당한 기술의 난이도와 상용화 여부를 성과란에 수치로 남기세요.",
  ],
  정책공공: [
    "정책 수립·제도화 경험을 사업명과 예산 규모까지 적어 두면 공공 성격이 강한 기업에 설득력이 생깁니다.",
    "정부·지자체 사업 수주 실적이 있다면 정책연구 분야에 항목으로 추가하세요.",
  ],
  창업투자: [
    "펀드 조성·투자 실적은 금액과 회수율까지 적으세요. 이 업종은 그 수치를 직접 봅니다.",
    "창업·EXIT 경험이 있다면 시기와 결과를 분명히 적어 두는 편이 낫습니다.",
  ],
  글로벌: [
    "해외 사업 경험을 국가·사업명·역할로 나눠 적으면 글로벌 축이 올라갑니다.",
    "영어 등 어학 능력이나 해외 거주·근무 이력이 있다면 프로필에 추가하세요.",
  ],
  연구학술: [
    "논문·저술이 이 업종에서 중요하게 작용합니다. 최근 논문과 게재 학술지를 추가하세요.",
    "저서 분야가 비어 있습니다. 출간물이나 연구보고서가 있다면 rawdata 에 넣고 다시 수집하세요.",
  ],
  경영리더십: [
    "조직 규모(인원·예산)와 맡은 기간을 경력에 적으면 리더십 축이 구체화됩니다.",
    "조직을 맡아 만든 성과를 수치로 적으세요. 등급 상승·수주액 같은 것이 좋습니다.",
  ],
};

function tipsFor(gapList, limit = 3) {
  return gapList
    .filter((g) => g.gap >= 10)
    .slice(0, limit)
    .map((g) => ({
      axis: g.axis,
      label: g.label,
      gap: g.gap,
      tip: (TIPS[g.axis] || ["해당 분야 실적을 포트폴리오에 추가하세요."])[g.gap >= 25 ? 1 % (TIPS[g.axis] || [""]).length : 0],
    }));
}

/* ── 기업 한 곳을 평가 ───────────────────────── */

/*
 * 업종별 계산 결과 캐시.
 * 기업은 수천 건이지만 업종은 60여 종뿐이라, 같은 업종이면 적합도·격차가 똑같다.
 * 내 역량이 바뀌면 키가 달라져 자동으로 다시 계산된다.
 */
const _evalCache = new Map();
onSwitch(() => _evalCache.clear());

function industryEval(indutyCode, my) {
  const ind = industryOf(indutyCode);
  const cacheKey = ind.code + "|" + AXES.map((a) => my[a] || 0).join(",");
  const hit = _evalCache.get(cacheKey);
  if (hit) return hit;

  const g = gaps(my, ind.w);
  const out = {
    industry: ind,
    fit: fitScore(my, ind.w),
    demand: Math.round(AXES.reduce((s, a) => s + (ind.w[a] || 0), 0) / AXES.length),
    gaps: g,
    topGap: g[0] && g[0].gap > 0 ? g[0] : null,
    strengths: g.filter((x) => x.mine >= x.want && x.want >= 50).map((x) => x.label),
  };
  out.priority = Math.round(out.fit * (0.55 + 0.45 * (out.demand / 100)));
  _evalCache.set(cacheKey, out);
  return out;
}

/*
 * 적합도만으로 줄을 세우면 요구 수준이 낮은 업종(인쇄·목재 등)이 위로 올라온다.
 * 기준이 낮으니 잘 맞는 것이라, 목표 기업을 고르는 데는 도움이 안 된다.
 * 그래서 요구 수준(demand)을 함께 계산하고,
 * '눈높이가 높은데도 내가 맞는' 쪽이 위로 오도록 우선순위(priority)를 따로 둔다.
 */
function evaluate(company, my) {
  return { ...company, ...industryEval(company.induty_code, my) };
}

/*
 * 가중치 표를 '업종 한 줄' 형식으로 직렬화한다.
 * JSON.stringify(cfg, null, 2) 를 쓰면 w 객체가 줄마다 펼쳐져
 * 70줄짜리 파일이 770줄이 되고, 한 값만 고쳐도 커밋 diff 가 전체로 번진다.
 */
function serializeWeights(cfg) {
  const inline = (w) =>
    "{ " + AXES.filter((a) => w[a] !== undefined).map((a) => `"${a}": ${w[a]}`).join(", ") + " }";
  const q = (s) => JSON.stringify(s);
  const out = [];

  out.push("{");
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "industries" || k === "_default" || k === "_axes") continue;
    out.push(`  ${q(k)}: ${q(v)},`);
  }
  out.push(`  "_axes": [${AXES.map(q).join(", ")}],`);
  out.push(`  "_default": {`);
  out.push(`    "label": ${q(cfg._default.label)},`);
  out.push(`    "w": ${inline(cfg._default.w)}`);
  out.push(`  },`);
  out.push(`  "industries": {`);
  const codes = Object.keys(cfg.industries).sort();
  codes.forEach((code, i) => {
    const v = cfg.industries[code];
    out.push(`    ${q(code)}: { "label": ${q(v.label)}, "w": ${inline(v.w)} }${i < codes.length - 1 ? "," : ""}`);
  });
  out.push(`  }`);
  out.push("}");
  return out.join("\n") + "\n";
}

/*
 * 가중치 표 저장.
 * config/industry-weights.json 을 그대로 다시 쓴다 — 파일이 계속 정본이고,
 * 화면 편집은 그 파일을 고치는 또 하나의 방법일 뿐이다.
 * (mtime 이 바뀌므로 loadWeights 캐시가 알아서 다시 읽는다)
 */
function saveWeights(updates) {
  const cfg = JSON.parse(fs.readFileSync(WEIGHTS_PATH, "utf8"));
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  let changed = 0;

  for (const [code, w] of Object.entries(updates || {})) {
    const target = code === "_default" ? cfg._default : cfg.industries[code];
    if (!target) continue;
    for (const a of AXES) {
      if (w[a] === undefined || w[a] === "") continue;
      const next = clamp(w[a]);
      if (target.w[a] !== next) {
        target.w[a] = next;
        changed++;
      }
    }
  }

  if (changed) {
    /*
     * 원자적 쓰기.
     * writeFileSync 는 파일을 비우고 다시 채우므로, 그 사이에 서버가 읽으면
     * 비었거나 잘린 내용을 본다. 임시 파일에 다 쓴 뒤 rename 하면
     * 읽는 쪽은 항상 이전 파일 아니면 새 파일을 보게 된다.
     */
    const tmp = WEIGHTS_PATH + ".tmp";
    fs.writeFileSync(tmp, serializeWeights(cfg), "utf8");
    fs.renameSync(tmp, WEIGHTS_PATH);
    _weights = null; // 다음 읽기에서 새로 불러오도록
    _weightsCheckedAt = 0;
    _evalCache.clear();
  }
  return changed;
}

/* 편집 화면용 — 업종별 가중치에 해당 업종 기업 수를 붙여 돌려준다 */
function industryList() {
  const cfg = loadWeights();
  let counts = new Map();
  try {
    counts = new Map(
      db()
        .prepare(
          "SELECT substr(induty_code,1,2) k, COUNT(*) c FROM companies WHERE enriched_at IS NOT NULL AND induty_code IS NOT NULL GROUP BY k"
        )
        .all()
        .map((r) => [r.k, r.c])
    );
  } catch (_) {}

  const rows = Object.entries(cfg.industries).map(([code, v]) => ({
    code,
    label: v.label,
    w: v.w,
    companies: counts.get(code) || 0,
  }));
  rows.sort((a, b) => b.companies - a.companies || a.label.localeCompare(b.label, "ko"));
  return { rows, fallback: { code: "_default", label: cfg._default.label, w: cfg._default.w, companies: 0 } };
}

module.exports = {
  AXES, AXIS_META, myVector, industryOf, fitScore, gaps, tipsFor, evaluate,
  loadWeights, saveWeights, industryList,
};
