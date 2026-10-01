"use strict";
/*
 * OpenDART(금융감독원 전자공시) 오픈API 클라이언트.
 *
 * 인증키는 .env 의 DART_API_KEY 에서만 읽는다. 코드·저장소에 넣지 않는다.
 * 하루 요청 한도는 20,000건(에러코드 020). 스크립트가 호출 수를 세어 알려준다.
 *
 * 문서: https://opendart.fss.or.kr/guide/main.do
 */
const { unzipSync } = require("fflate");

const BASE = "https://opendart.fss.or.kr/api";

/* 공식 응답코드 — 숫자만 보면 원인을 알기 어려워 메시지를 붙여둔다 */
const STATUS = {
  "000": "정상",
  "010": "등록되지 않은 키입니다.",
  "011": "사용할 수 없는 키입니다(일시 중지).",
  "012": "접근할 수 없는 IP입니다.",
  "013": "조회된 데이터가 없습니다.",
  "014": "파일이 존재하지 않습니다.",
  "020": "요청 제한(1일 20,000건)을 초과했습니다.",
  "021": "조회 가능한 회사 개수를 초과했습니다(최대 100건).",
  "100": "필드 값이 부적절합니다.",
  "101": "부적절한 접근입니다.",
  "800": "시스템 점검으로 서비스가 중지 중입니다.",
  "900": "정의되지 않은 오류입니다.",
  "901": "개인정보 보유기간 만료로 사용할 수 없는 키입니다.",
};

let callCount = 0;
const calls = () => callCount;

function key() {
  const k = (process.env.DART_API_KEY || "").trim();
  if (!k) throw new Error("DART_API_KEY 가 .env 에 없습니다. OpenDART 에서 발급받은 40자리 키를 넣으세요.");
  if (k.length !== 40) throw new Error(`DART_API_KEY 길이가 ${k.length}자입니다. 정상 키는 40자리입니다.`);
  return k;
}

class DartError extends Error {
  constructor(status, message) {
    super(`[${status}] ${STATUS[status] || message || "알 수 없는 오류"}`);
    this.status = status;
  }
}

async function call(endpoint, params = {}) {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("crtfc_key", key());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  callCount++;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${endpoint}`);
  const j = await r.json();
  if (j.status && j.status !== "000") throw new DartError(j.status, j.message);
  return j;
}

/* ── 공시정보 ────────────────────────────────── */

/* 고유번호 전체 목록. ZIP 안에 XML 하나가 들어 있다. */
async function fetchCorpCodes() {
  const url = new URL(`${BASE}/corpCode.xml`);
  url.searchParams.set("crtfc_key", key());
  callCount++;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} — corpCode.xml`);
  const buf = Buffer.from(await r.arrayBuffer());

  // 키가 잘못되면 ZIP 대신 에러 XML 이 온다
  if (buf.slice(0, 2).toString() !== "PK") {
    const text = buf.toString("utf8").slice(0, 500);
    const st = (text.match(/<status>(\d+)<\/status>/) || [])[1];
    throw new DartError(st || "900", text);
  }

  const files = unzipSync(new Uint8Array(buf));
  const name = Object.keys(files).find((f) => f.toLowerCase().endsWith(".xml"));
  if (!name) throw new Error("ZIP 안에서 XML 을 찾지 못했습니다.");
  return Buffer.from(files[name]).toString("utf8");
}

function parseCorpCodes(xml) {
  const out = [];
  const pick = (block, tag) => {
    const m = block.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
    return m ? m[1].trim() : "";
  };
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const b = m[1];
    const corp_code = pick(b, "corp_code");
    if (!corp_code) continue;
    out.push({
      corp_code,
      corp_name: pick(b, "corp_name"),
      corp_eng_name: pick(b, "corp_eng_name"),
      stock_code: pick(b, "stock_code"),
      modify_date: pick(b, "modify_date"),
    });
  }
  return out;
}

/* 기업개황 — 주소·업종코드·설립일·대표자 등 */
const company = (corp_code) => call("company.json", { corp_code });

/* 공시검색 */
const disclosures = (params) => call("list.json", params);

/* ── 재무정보 ────────────────────────────────── */
const REPORT = { 사업보고서: "11011", "1분기": "11013", 반기: "11012", "3분기": "11014" };

/* 단일회사 주요계정 */
const finance = (corp_code, bsns_year, reprt_code = REPORT.사업보고서) =>
  call("fnlttSinglAcnt.json", { corp_code, bsns_year, reprt_code });

/*
 * 다중회사 주요계정 — 한 번에 최대 100개사.
 * 회사별로 부르면 호출 수가 빠르게 소진되므로 목록 조회는 이쪽을 쓴다.
 */
function financeMulti(corpCodes, bsns_year, reprt_code = REPORT.사업보고서) {
  if (corpCodes.length > 100) throw new Error("다중회사 조회는 한 번에 100개사까지 가능합니다.");
  return call("fnlttMultiAcnt.json", { corp_code: corpCodes.join(","), bsns_year, reprt_code });
}

/* ── 정기보고서 주요정보(매칭에 쓸 만한 것들) ── */
const employees = (corp_code, bsns_year, reprt_code = REPORT.사업보고서) =>
  call("empSttus.json", { corp_code, bsns_year, reprt_code });
const executives = (corp_code, bsns_year, reprt_code = REPORT.사업보고서) =>
  call("exctvSttus.json", { corp_code, bsns_year, reprt_code });
const investments = (corp_code, bsns_year, reprt_code = REPORT.사업보고서) =>
  call("otrCprInvstmntSttus.json", { corp_code, bsns_year, reprt_code });

/* 주소 맨 앞의 시·도를 뽑아 지역 필터에 쓴다 */
function regionOf(address) {
  const s = String(address || "").trim();
  if (!s) return "";
  const head = s.split(/\s+/)[0];
  const map = {
    서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천",
    광주광역시: "광주", 대전광역시: "대전", 울산광역시: "울산", 세종특별자치시: "세종",
    경기도: "경기", 강원도: "강원", 강원특별자치도: "강원", 충청북도: "충북",
    충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북", 전라남도: "전남",
    경상북도: "경북", 경상남도: "경남", 제주특별자치도: "제주",
  };
  return map[head] || head.replace(/(특별시|광역시|특별자치시|특별자치도|도)$/, "");
}

module.exports = {
  BASE, STATUS, REPORT, DartError,
  calls, hasKey: () => Boolean((process.env.DART_API_KEY || "").trim()),
  call, fetchCorpCodes, parseCorpCodes, company, disclosures,
  finance, financeMulti, employees, executives, investments, regionOf,
};
