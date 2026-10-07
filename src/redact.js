"use strict";
/*
 * 추출한 본문에서 민감 식별정보를 가린다.
 * 경력증명서·신분 증빙에는 주민등록번호가 그대로 들어 있는 경우가 많아,
 * DB 에 저장하기 전에 한 번 거른다. 원본 파일은 건드리지 않는다.
 */

const RULES = [
  // 주민등록번호 900101-1234567 → 900101-*******  (예시 번호다. 실제 값을 주석에 적지 말 것)
  {
    name: "주민등록번호",
    re: /(\d{6})\s*[-–]\s*([1-4]\d{6})/g,
    to: (_, a) => a + "-*******",
  },
  // 여권번호(M/S/R/G/D + 8자리)
  {
    name: "여권번호",
    re: /\b([MSRGD])(\d{8})\b/g,
    to: (m, a) => a + "********",
  },
];
/*
 * 계좌번호 마스킹은 넣지 않는다.
 * 사업자등록번호(123-45-67890), 자격증 등록번호(00-00-0-0000), 문서번호처럼
 * 이력서에 꼭 필요한 값과 형태가 겹쳐 정상 데이터를 망가뜨린다.
 */

function redact(text) {
  if (!text) return { text: "", hits: [] };
  let out = String(text);
  const hits = [];
  for (const r of RULES) {
    let n = 0;
    out = out.replace(r.re, (...args) => {
      const replaced = r.to(...args);
      if (replaced !== args[0]) n++;
      return replaced;
    });
    if (n) hits.push({ rule: r.name, count: n });
  }
  return { text: out, hits };
}

module.exports = { redact };
