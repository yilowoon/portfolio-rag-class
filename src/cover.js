"use strict";
/*
 * 자기소개서 생성기.
 *
 * 원칙: 지어내지 않는다.
 *   - 근거는 myprofile 원본 문서(자기소개서·이력서 등)와 포트폴리오 DB 뿐이다.
 *   - 자료가 모자란 항목은 억지로 채우지 말고 무엇이 없는지 알려준다.
 *     본인이 '추가 정보'를 넣고 다시 생성하면 그 내용을 반영한다.
 *
 * 제출용 문서를 만드는 기능이므로, 없는 경력이나 수치를 만들어 넣으면
 * 본인에게 해가 돌아간다. 프롬프트에서 이 점을 못박는다.
 */
const { db } = require("./db");
const { gemini } = require("./config");
const { keywordSearch } = require("./search");
const { AXIS_META } = require("./competency");

const SECTIONS = [
  {
    key: "growth",
    label: "성장배경",
    query: "성장 가정 부모 어린시절 학창시절 대학 동아리 유학",
    ask: "자라온 환경과 그 안에서 형성된 태도를 쓰십시오. 가정·학창시절·대학 시절의 구체적 장면을 하나 이상 넣으십시오.",
  },
  {
    key: "personality",
    label: "성격 장단점",
    query: "성격 장점 단점 책임감 끈기 리더십 태도 몰입 도전",
    ask:
      "장점 하나와 단점 하나를 분명히 밝히고, 각각을 뒷받침하는 실제 경험을 붙이십시오. " +
      "단점은 숨기지 말고, 그것을 어떻게 다루고 있는지까지 쓰십시오.",
  },
  {
    key: "activities",
    label: "주요활동",
    query: "프로젝트 개발 사업 총괄 성과",
    ask:
      "지원 회사의 업종과 관련이 큰 활동부터 2~3건을 골라 쓰십시오. " +
      "무엇을 맡았고 어떤 결과가 나왔는지를 자료에 있는 수치 그대로 쓰십시오.",
  },
  {
    key: "values",
    label: "가치관",
    query: "가치관 신념 철학 사명감 책임 본립도생 지역 발전 공공",
    ask: "일할 때 지키는 기준이 무엇인지 쓰고, 그 기준이 드러난 선택이나 경험을 함께 적으십시오.",
  },
  {
    key: "motivation",
    label: "지원동기 및 포부",
    query: "지원 동기 목표 계획 비전",
    ask:
      "왜 이 회사인지를 회사의 업종·사업 내용과 본인 경력을 연결해 쓰고, " +
      "입사 후 맡고 싶은 역할과 기여 방향을 구체적으로 적으십시오.",
  },
];

const SECTION_MAP = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));

/* 이름은 프로필에서 읽는다 — 코드에 박아 두면 다른 사람이 쓸 수 없다 */
function ownerName() {
  try {
    const r = db().prepare("SELECT name FROM profile_basic WHERE id=1").get();
    return (r && r.name) || "본인";
  } catch (_) {
    return "본인";
  }
}

const SYSTEM = (who) => `당신은 ${who} 본인의 자기소개서를 대신 써 주는 조력자입니다.

지켜야 할 것:
- 아래 '확인된 자료'에 있는 사실만 쓰십시오. 경력·수치·상훈을 지어내면 안 됩니다.
- 자료에 없는 내용이 필요하면 억지로 채우지 말고 그 문단을 짧게 끝내십시오.
- 1인칭('저는')으로, 담백한 한국어 서술체로 쓰십시오. 과장된 수식어는 빼십시오.
- 한 문단이 아니라 3~5개 문단으로 나누어 쓰고, 각 문단은 3~5문장으로 하십시오.
- 제목이나 머리말을 붙이지 말고 본문만 쓰십시오.
- 분량은 공백 포함 600~900자로 맞추십시오.`;

/* ── 근거 모으기 ─────────────────────────────── */

function profileFacts() {
  const d = db();
  const me = d.prepare("SELECT * FROM profile_basic WHERE id=1").get() || {};
  const item = (kind) =>
    d.prepare("SELECT title, org, period_start, period_end, description FROM profile_items WHERE kind=? ORDER BY sort_order").all(kind);
  return {
    me,
    career: item("경력"),
    education: item("학력"),
    certs: item("자격"),
  };
}

function facts_text(f) {
  const lines = [];
  if (f.me.name) lines.push(`이름: ${f.me.name}${f.me.birth ? ` (${f.me.birth}생)` : ""}`);
  if (f.me.org) lines.push(`현재: ${f.me.org} ${f.me.position || ""}`.trim());
  if (f.me.summary) lines.push("핵심 역량:\n" + f.me.summary);
  if (f.career.length) {
    lines.push("경력:");
    for (const c of f.career) {
      lines.push(`  - ${c.period_start || ""}~${c.period_end || "현재"} ${c.title}${c.description ? " / " + c.description : ""}`);
    }
  }
  if (f.education.length) {
    lines.push("학력:");
    for (const e of f.education) lines.push(`  - ${e.period_start || ""}~${e.period_end || ""} ${e.title} ${e.description || ""}`);
  }
  if (f.certs.length) lines.push("자격: " + f.certs.map((c) => c.title).join(", "));
  return lines.join("\n");
}

/* 지원 회사의 업종과 가까운 활동을 앞세워 고른다 */
function activityFacts(industryLabel, limit = 14) {
  const d = db();
  const rows = d
    .prepare("SELECT category, title, org, role, period_start, period_end, summary, outcomes, tags FROM projects")
    .all();
  const key = String(industryLabel || "");
  const score = (a) => {
    let s = 0;
    if (a.outcomes && a.outcomes.trim()) s += 2;
    if (key && (a.tags || "").split(",").some((t) => key.includes(t.trim()) && t.trim())) s += 3;
    if (["기술개발", "창업활동", "정책연구"].includes(a.category)) s += 1;
    const y = Number((String(a.period_end || a.period_start || "").match(/(19|20)\d{2}/) || [])[0] || 0);
    if (y >= 2015) s += 1;
    return s;
  };
  return rows
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map((a) => {
      const period = [a.period_start, a.period_end].filter(Boolean).join("~") || "시기미상";
      return `  - [${a.category}] ${a.title} (${a.org || "-"}, ${a.role || "-"}, ${period})` +
        (a.summary ? `\n    ${a.summary}` : "") +
        (a.outcomes ? `\n    성과: ${a.outcomes}` : "");
    })
    .join("\n");
}

/* 원본 문서에서 해당 주제 대목을 끌어온다 */
function docFacts(query, limit = 5) {
  try {
    const hits = keywordSearch(query, { limit });
    if (!hits.length) return "";
    return hits.map((h) => `  - (${h.title}) ${h.text.slice(0, 700)}`).join("\n");
  } catch (_) {
    return "";
  }
}

function companyFacts(letter, ev) {
  if (!letter.corp_name) return "";
  const lines = [`지원 회사: ${letter.corp_name}`];
  if (letter.industry) lines.push(`업종: ${letter.industry}`);
  if (letter.job_title) lines.push(`지원 직무: ${letter.job_title}`);
  if (ev) {
    if (ev.co && ev.co.adres) lines.push(`소재지: ${ev.co.adres}`);
    if (ev.co && ev.co.est_dt) lines.push(`설립: ${ev.co.est_dt.slice(0, 4)}년`);
    const strong = ev.gaps.filter((g) => g.mine >= g.want && g.want >= 50).map((g) => g.label);
    const weak = ev.gaps.filter((g) => g.gap >= 10).map((g) => `${g.label}(부족 ${g.gap})`);
    if (strong.length) lines.push(`이 업종이 중시하는 역량 중 내가 갖춘 것: ${strong.join(", ")}`);
    if (weak.length) lines.push(`상대적으로 약한 축: ${weak.join(", ")} — 이 점은 포부 문단에서 배우고 채우겠다는 방향으로만 쓰고, 과장하지 말 것`);
  }
  return lines.join("\n");
}

/* ── 생성 ────────────────────────────────────── */

async function callGemini(prompt) {
  const key = gemini.key();
  const url = `${gemini.base()}/v1beta/models/${gemini.textModel()}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM(ownerName()) }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.55, maxOutputTokens: 1600 },
    }),
  });
  if (!r.ok) throw new Error(`생성 실패 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const cand = (j.candidates || [])[0];
  return ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("").trim();
}

function buildPrompt(section, letter, ev, extraInfo) {
  const f = profileFacts();
  const parts = [`[항목] ${section.label}`, `[작성 지침] ${section.ask}`, "", "[확인된 자료]", facts_text(f)];

  if (section.key === "activities") {
    parts.push("", "활동 기록:", activityFacts(letter.industry));
  } else {
    const doc = docFacts(section.query);
    if (doc) parts.push("", "본인 문서에서 찾은 관련 대목:", doc);
    if (section.key === "motivation") parts.push("", "활동 기록(일부):", activityFacts(letter.industry, 8));
  }

  const co = companyFacts(letter, ev);
  if (co) parts.push("", "[지원 회사]", co);

  if (extraInfo && extraInfo.trim()) {
    parts.push(
      "",
      "[본인이 추가로 알려준 내용 — 위 자료보다 우선하며, 반드시 반영할 것]",
      extraInfo.trim()
    );
  }

  parts.push(
    "",
    "위 자료만 근거로 '" + section.label + "' 문단을 작성하십시오.",
    "자료가 부족해 쓸 수 없는 부분이 있으면 그 부분은 비우고, 마지막 줄에 '[보완필요] ...' 형태로 무엇이 더 필요한지 한 줄 적으십시오."
  );
  return parts.join("\n");
}

/* 결과에서 [보완필요] 줄을 떼어 별도 안내로 돌린다 */
function splitNote(text) {
  const lines = String(text || "").split(/\r?\n/);
  const notes = [];
  const body = [];
  for (const ln of lines) {
    if (/^\s*\[보완필요\]/.test(ln)) notes.push(ln.replace(/^\s*\[보완필요\]\s*/, "").trim());
    else body.push(ln);
  }
  return { body: body.join("\n").trim(), note: notes.join(" / ") || null };
}

async function generateSection(letterId, sectionKey) {
  const d = db();
  const section = SECTION_MAP[sectionKey];
  if (!section) throw new Error("알 수 없는 항목: " + sectionKey);

  const letter = d.prepare("SELECT * FROM cover_letters WHERE id=?").get(letterId);
  if (!letter) throw new Error("자기소개서를 찾을 수 없습니다.");

  const row = d.prepare("SELECT extra_info FROM cover_sections WHERE letter_id=? AND section_key=?").get(letterId, sectionKey);
  const extra = row ? row.extra_info : "";

  let ev = null;
  if (letter.corp_code) {
    const co = d.prepare("SELECT * FROM companies WHERE corp_code=?").get(letter.corp_code);
    if (co) {
      const comp = require("./competency");
      ev = comp.evaluate(co, comp.myVector().score);
      ev.co = co;
    }
  }

  const upsert = d.prepare(
    `INSERT INTO cover_sections (letter_id, section_key, content, extra_info, status, note, generated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(letter_id, section_key) DO UPDATE SET
       content=excluded.content, status=excluded.status, note=excluded.note, generated_at=excluded.generated_at`
  );

  if (!gemini.enabled()) {
    upsert.run(letterId, sectionKey, "", extra || "", "error",
      "GEMINI_API_KEY 가 없어 생성할 수 없습니다.", new Date().toISOString());
    return { status: "error", note: "GEMINI_API_KEY 가 없어 생성할 수 없습니다." };
  }

  try {
    const out = await callGemini(buildPrompt(section, letter, ev, extra));
    const { body, note } = splitNote(out);
    upsert.run(letterId, sectionKey, body, extra || "", body ? "ok" : "empty", note, new Date().toISOString());
    d.prepare("UPDATE cover_letters SET updated_at=? WHERE id=?").run(new Date().toISOString(), letterId);
    return { status: body ? "ok" : "empty", content: body, note };
  } catch (e) {
    upsert.run(letterId, sectionKey, "", extra || "", "error", e.message, new Date().toISOString());
    return { status: "error", note: e.message };
  }
}

async function generateAll(letterId) {
  const out = [];
  for (const s of SECTIONS) out.push({ key: s.key, ...(await generateSection(letterId, s.key)) });
  return out;
}

function createLetter({ corp_code, corp_name, industry, job_title }) {
  const now = new Date().toISOString();
  const r = db()
    .prepare("INSERT INTO cover_letters (corp_code, corp_name, industry, job_title, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(corp_code || null, corp_name || null, industry || null, job_title || null, now, now);
  return Number(r.lastInsertRowid);
}

function getLetter(id) {
  const d = db();
  const letter = d.prepare("SELECT * FROM cover_letters WHERE id=?").get(id);
  if (!letter) return null;
  const rows = d.prepare("SELECT * FROM cover_sections WHERE letter_id=?").all(id);
  const map = Object.fromEntries(rows.map((r) => [r.section_key, r]));
  return {
    ...letter,
    sections: SECTIONS.map((s) => ({ ...s, ...(map[s.key] || { content: "", extra_info: "", status: null, note: null }) })),
  };
}

module.exports = { SECTIONS, SECTION_MAP, createLetter, getLetter, generateSection, generateAll, AXIS_META };
