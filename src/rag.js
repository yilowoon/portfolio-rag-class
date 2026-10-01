"use strict";
/*
 * RAG 질의응답.
 * 1) 하이브리드 검색으로 근거 청크를 모으고
 * 2) 키가 있으면 Gemini 로 근거 기반 답변을 만든다(각 문장에 [n] 출처 번호).
 * 키가 없으면 답변 없이 근거만 돌려준다 — 검색 도구로는 그대로 쓸 수 있다.
 */
const { db } = require("./db");
const { gemini } = require("./config");
const { hybridSearch } = require("./search");

/* 이름은 프로필에서 읽는다 — 코드에 박아 두면 다른 사람이 쓸 수 없다 */
function ownerName() {
  try {
    const r = db().prepare("SELECT name FROM profile_basic WHERE id=1").get();
    return (r && r.name) || "본인";
  } catch (_) {
    return "본인";
  }
}

const SYSTEM = (who) => `당신은 ${who}의 업무 자료 아카이브를 다루는 리서치 보조입니다.
반드시 아래 '근거 자료'에 적힌 내용만 사용해 한국어로 답하십시오.
규칙:
- 근거에 없는 사실은 만들어 내지 말고, 모르면 "제공된 자료에서 확인되지 않습니다"라고 쓰십시오.
- 사실을 서술한 문장 끝에는 근거 번호를 [1] [2] 형태로 붙이십시오.
- 답변은 핵심부터 3~8문장으로 간결하게 쓰고, 필요하면 짧은 항목 목록을 쓰십시오.
- 자료마다 연도가 다를 수 있으니 시점이 중요하면 연도를 함께 밝히십시오.`;

function buildContext(hits, maxChars = 14000) {
  const parts = [];
  let total = 0;
  hits.forEach((h, i) => {
    const head = `[${i + 1}] ${h.title} (${h.org || "-"} / ${h.doc_type || "-"} / ${h.year || "연도미상"})`;
    const body = h.text.slice(0, 1800);
    const block = head + "\n" + body;
    if (total + block.length > maxChars) return;
    total += block.length;
    parts.push(block);
  });
  return parts.join("\n\n---\n\n");
}

async function generate(question, context) {
  const key = gemini.key();
  const url = `${gemini.base()}/v1beta/models/${gemini.textModel()}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM(ownerName()) }] },
      contents: [{ role: "user", parts: [{ text: `질문: ${question}\n\n근거 자료:\n${context}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
    }),
  });
  if (!r.ok) throw new Error(`생성 실패 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const cand = (j.candidates || [])[0];
  return ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("").trim();
}

async function ask(question, opts = {}) {
  const hits = await hybridSearch(question, { ...opts, limit: Number(opts.limit || 8) });
  const sources = hits.map((h, i) => ({
    n: i + 1,
    chunk_id: h.id,
    doc_id: h.doc_id,
    title: h.title,
    org: h.org,
    doc_type: h.doc_type,
    year: h.year,
    rel_path: h.rel_path,
    excerpt: h.text.slice(0, 500),
  }));

  if (!hits.length) {
    return { answer: null, note: "관련 자료를 찾지 못했습니다. 다른 표현으로 검색해 보세요.", sources: [] };
  }
  if (!gemini.enabled()) {
    return {
      answer: null,
      note: "GEMINI_API_KEY 가 없어 답변 생성은 꺼져 있습니다. 아래 근거 자료를 확인하세요.",
      sources,
    };
  }

  let answer = null;
  let note = null;
  try {
    answer = await generate(question, buildContext(hits));
  } catch (e) {
    note = "답변 생성에 실패해 근거 자료만 표시합니다: " + e.message;
  }

  try {
    db()
      .prepare("INSERT INTO ask_log (asked_at, question, answer, sources) VALUES (?,?,?,?)")
      .run(new Date().toISOString(), question, answer || "", JSON.stringify(sources.map((s) => s.doc_id)));
  } catch (_) {}

  return { answer, note, sources };
}

module.exports = { ask };
