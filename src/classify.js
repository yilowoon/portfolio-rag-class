"use strict";
/*
 * 파일명·경로에서 포트폴리오 메타(문서유형·연도·제목)를 규칙으로 뽑는다.
 * LLM 없이 동작하는 1차 분류이며, 웹 UI 에서 수정할 수 있다.
 */
const path = require("path");

const TYPE_RULES = [
  ["지원서류", /이력서|자기소개서|입사지원|응시원서|직무계획|경력기술|지원서/],
  ["증빙", /증명서|확인서|인증서|수료증|재직|경력증명|자격증|졸업|학위/],
  ["제안서", /제안서|제안|proposal|_제안/i],
  ["사업계획", /사업계획|계획서|추진계획|기획안|blueprint|business.?plan/i],
  ["보고서", /보고서|리포트|report|진단|분석|결과보고/i],
  ["논문", /논문|학술|journal|paper/i],
  ["계약·협약", /계약서|협약서|약정|mou|양수도/i],
  ["공문", /공문|발송|협조요청/],
  ["보도자료", /보도자료|press|기사/i],
  ["규정", /정관|규정|규칙|지침|약관|방침/],
  ["회의", /회의록|총회|이사회|간담회|kick.?off|회의/i],
  ["안내·공고", /안내문|안내|공고|모집|통지|초청/],
  ["발표자료", /introduction|소개|발표|pitch|deck|ppt/i],
  ["정책건의", /건의|제언|정책|질의/],
];

const EXT_TYPE = { ".pptx": "발표자료", ".xlsx": "데이터" };

function docType(fileName, relPath) {
  const hay = (relPath + " " + fileName).toLowerCase();
  for (const [type, re] of TYPE_RULES) if (re.test(hay)) return type;
  return EXT_TYPE[path.extname(fileName).toLowerCase()] || "기타";
}

/* 파일명/경로에서 연도 추출. 미래·과거로 지나친 값은 버린다. */
function guessYear(fileName, relPath, mtimeMs) {
  const nowYear = new Date().getFullYear();
  const ok = (y) => y >= 1995 && y <= nowYear + 1;
  const hay = fileName + " " + relPath;

  const patterns = [
    /(19|20)\d{2}\s*[.\-년]\s*(0?[1-9]|1[0-2])\s*[.\-월]/, // 2026.08 / 2026-08 / 2026년 8월
    /\b((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/, // 20260315
    /\b((?:19|20)\d{2})년/,
    /\b((?:19|20)\d{2})\b/,
  ];
  for (const re of patterns) {
    const m = hay.match(re);
    if (m) {
      const y = Number((m[0].match(/(19|20)\d{2}/) || [])[0]);
      if (ok(y)) return y;
    }
  }
  const y = new Date(mtimeMs).getFullYear();
  return ok(y) ? y : null;
}

/* 파일명을 사람이 읽을 제목으로 정돈 */
function titleOf(fileName) {
  let t = fileName.replace(/\.[^.]+$/, "");
  t = t.replace(/[_]+/g, " ");
  t = t.replace(/\s*\b(?:19|20)\d{6}\b\s*/g, " ");
  t = t.replace(/\s*[(\[]?\s*v?\d+\.\d+\s*[)\]]?\s*$/i, " ");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t || fileName;
}

/* 태그: 자주 쓰는 도메인 키워드를 붙여 필터/추천에 쓴다. */
const TAG_RULES = [
  ["세종", /세종/], ["충남", /충남|천안|아산/], ["대전", /대전/], ["울산", /울산/],
  ["ESG", /esg|지속가능/i], ["창업·스타트업", /창업|스타트업|startup|액셀러|투자/i],
  ["AI·디지털", /\bai\b|인공지능|디지털|데이터|플랫폼|dx/i],
  ["지역혁신", /지역혁신|균형발전|지역산업|리쇼어|rise/i],
  ["공동체", /공동체|커뮤니티|주민|마을/],
  ["교육", /교육|강의|연수|커리큘럼|program/i],
  ["정책", /정책|조례|제도|거버넌스/],
  ["특허·지식재산", /특허|상표|지식재산|출원/],
  ["ESG심사", /심사원|인증심사/],
];

function tagsOf(fileName, relPath, text) {
  const hay = (fileName + " " + relPath + " " + (text || "").slice(0, 4000)).toLowerCase();
  const out = [];
  for (const [tag, re] of TAG_RULES) if (re.test(hay)) out.push(tag);
  return out;
}

module.exports = { docType, guessYear, titleOf, tagsOf };
