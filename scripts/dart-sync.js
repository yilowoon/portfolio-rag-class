"use strict";
/*
 * OpenDART 기업 데이터 동기화.
 *
 * 1단계 — 고유번호 전체 내려받기 (API 호출 1회)
 *   node scripts/dart-sync.js codes
 *
 * 2단계 — 기업개황 채우기 (회사당 API 호출 1회, 1일 한도 20,000건)
 *   node scripts/dart-sync.js enrich --listed            # 상장사만(약 2,700개)
 *   node scripts/dart-sync.js enrich --limit 500         # 개수 제한
 *   node scripts/dart-sync.js enrich --name 테크노       # 회사명에 포함된 것만
 *
 * 3단계 — 재무 주요계정 (100개사씩 묶어 호출)
 *   node scripts/dart-sync.js finance --year 2024 --region 대전
 *
 * 4단계 — 매칭 대상이 아닌 기업 정리
 *   node scripts/dart-sync.js clean --dry-run
 *   node scripts/dart-sync.js clean
 *
 * 확인
 *   node scripts/dart-sync.js status
 */
const { db } = require("../src/db");
const dart = require("../src/dart");
require("../src/config"); // .env 로드

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY = has("--dry-run");

/* ── 1단계: 고유번호 ─────────────────────────── */
async function syncCodes() {
  console.log("고유번호 목록을 내려받는 중… (ZIP, 수 MB)");
  const xml = await dart.fetchCorpCodes();
  const rows = dart.parseCorpCodes(xml);
  console.log(`파싱 완료: ${rows.length.toLocaleString()}개사`);

  const d = db();
  const up = d.prepare(
    `INSERT INTO companies (corp_code, corp_name, corp_eng_name, stock_code, modify_date)
     VALUES (?,?,?,?,?)
     ON CONFLICT(corp_code) DO UPDATE SET
       corp_name=excluded.corp_name, corp_eng_name=excluded.corp_eng_name,
       stock_code=excluded.stock_code, modify_date=excluded.modify_date`
  );
  d.exec("BEGIN");
  try {
    for (const r of rows) up.run(r.corp_code, r.corp_name, r.corp_eng_name, r.stock_code || null, r.modify_date);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  const listed = d.prepare("SELECT COUNT(*) c FROM companies WHERE stock_code IS NOT NULL AND stock_code != ''").get().c;
  console.log(`저장 완료 — 전체 ${rows.length.toLocaleString()}개사 / 상장사 ${listed.toLocaleString()}개사`);
  console.log(`API 호출 ${dart.calls()}회 사용`);
}

/* ── 2단계: 기업개황 ─────────────────────────── */
async function enrich() {
  const d = db();
  const limit = Number(val("--limit", 0)) || 0;
  const name = val("--name", "");

  const where = ["enriched_at IS NULL"];
  const args = [];
  if (has("--listed")) where.push("stock_code IS NOT NULL AND stock_code != ''");
  // SPAC 은 매칭 대상이 아니므로 애초에 받지 않는다(호출 수도 아낀다)
  if (!has("--include-spac")) where.push("corp_name NOT LIKE '%기업인수목적%' AND corp_name NOT LIKE '%스팩%'");
  if (name) { where.push("corp_name LIKE ?"); args.push("%" + name + "%"); }
  if (has("--refresh")) where.shift();

  const targets = d
    .prepare(`SELECT corp_code, corp_name FROM companies WHERE ${where.join(" AND ")} ORDER BY corp_name` +
      (limit ? " LIMIT " + limit : ""))
    .all(...args);

  if (!targets.length) {
    console.log("채울 대상이 없습니다. (이미 처리됐거나 조건에 맞는 회사가 없음)");
    return;
  }
  console.log(`기업개황 ${targets.length.toLocaleString()}개사 조회 시작 — 1일 한도 20,000건`);

  const up = d.prepare(
    `UPDATE companies SET corp_cls=?, ceo_nm=?, adres=?, region=?, induty_code=?,
       est_dt=?, acc_mt=?, hm_url=?, phn_no=?, enriched_at=? WHERE corp_code=?`
  );

  let ok = 0, empty = 0;
  for (const [i, t] of targets.entries()) {
    try {
      const c = await dart.company(t.corp_code);
      up.run(c.corp_cls || null, c.ceo_nm || null, c.adres || null, dart.regionOf(c.adres),
        c.induty_code || null, c.est_dt || null, c.acc_mt || null, c.hm_url || null,
        c.phn_no || null, now(), t.corp_code);
      ok++;
    } catch (e) {
      if (e.status === "013") {
        // 조회 결과 없음 — 다시 시도하지 않도록 표시만 남긴다
        up.run(null, null, null, null, null, null, null, null, null, now(), t.corp_code);
        empty++;
      } else if (e.status === "020") {
        console.log(`\n일일 한도에 도달했습니다. ${ok}개사까지 저장했습니다. 내일 이어서 실행하세요.`);
        break;
      } else {
        console.log(`\n  ${t.corp_name}: ${e.message}`);
      }
    }
    if ((i + 1) % 25 === 0) process.stdout.write(`\r  ${i + 1}/${targets.length} (성공 ${ok}) …`);
    await sleep(60); // 서버 부담을 줄이려고 약간 쉬어간다
  }
  console.log(`\n완료 — 저장 ${ok} / 데이터없음 ${empty} / API 호출 ${dart.calls()}회`);
}

/* ── 3단계: 재무 주요계정 ────────────────────── */
async function finance() {
  const d = db();
  const year = val("--year", String(new Date().getFullYear() - 1));
  const region = val("--region", "");
  const limit = Number(val("--limit", 0)) || 0;

  const where = ["stock_code IS NOT NULL", "stock_code != ''"];
  const args = [];
  if (region) { where.push("region = ?"); args.push(region); }

  const targets = d
    .prepare(`SELECT corp_code, corp_name FROM companies WHERE ${where.join(" AND ")} ORDER BY corp_name` +
      (limit ? " LIMIT " + limit : ""))
    .all(...args);

  if (!targets.length) {
    console.log("대상 기업이 없습니다. 먼저 codes → enrich 를 실행하세요.");
    return;
  }
  console.log(`${year}년 사업보고서 주요계정 — ${targets.length}개사 (100개씩 묶어 호출)`);

  const up = d.prepare(
    `INSERT INTO company_financials (corp_code, bsns_year, account_nm, fs_div, amount, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(corp_code, bsns_year, account_nm, fs_div) DO UPDATE SET
       amount=excluded.amount, updated_at=excluded.updated_at`
  );

  let saved = 0;
  for (let i = 0; i < targets.length; i += 100) {
    const batch = targets.slice(i, i + 100);
    try {
      const res = await dart.financeMulti(batch.map((t) => t.corp_code), year);
      d.exec("BEGIN");
      try {
        for (const row of res.list || []) {
          up.run(row.corp_code, row.bsns_year, row.account_nm, row.fs_div, row.thstrm_amount, now());
          saved++;
        }
        d.exec("COMMIT");
      } catch (e) {
        d.exec("ROLLBACK");
        throw e;
      }
    } catch (e) {
      if (e.status === "013") console.log(`  ${i + 1}~${i + batch.length}: 해당 연도 데이터 없음`);
      else if (e.status === "020") { console.log("일일 한도 도달 — 중단합니다."); break; }
      else console.log(`  ${i + 1}~${i + batch.length}: ${e.message}`);
    }
    process.stdout.write(`\r  ${Math.min(i + 100, targets.length)}/${targets.length} …`);
    await sleep(120);
  }
  console.log(`\n완료 — 계정 ${saved.toLocaleString()}건 저장 / API 호출 ${dart.calls()}회`);
}

/* ── 정리 ────────────────────────────────────── */
/*
 * 매칭 대상이 될 수 없는 기업을 지운다.
 *
 *  SPAC(기업인수목적회사) — 합병 전까지 실질 영업이 없다. 재무가 찍혀 있어도
 *    공모자금이 자본금으로 잡힌 것뿐이라, 사람의 경력과 맞춰 볼 대상이 아니다.
 *  폐업 추정 — 구분이 '기타법인'이면서 재무가 한 해도 없는 곳.
 *
 * 주의: 구분 'E' 를 전부 지우면 안 된다. 상장만 폐지되고 사업보고서는 계속 내는
 * 영업 중인 회사(위노바·잘만테크 등 229곳)가 같은 구분에 들어 있다.
 * 그래서 '재무가 하나도 없을 것' 을 함께 건다.
 */
const SPAC_SQL = "(corp_name LIKE '%기업인수목적%' OR corp_name LIKE '%스팩%')";
const DEAD_SQL =
  "(corp_cls = 'E' AND NOT EXISTS (SELECT 1 FROM company_financials f WHERE f.corp_code = companies.corp_code))";

function clean() {
  const d = db();
  const where = `enriched_at IS NOT NULL AND (${SPAC_SQL} OR ${DEAD_SQL})`;
  const spac = d.prepare(`SELECT COUNT(*) c FROM companies WHERE enriched_at IS NOT NULL AND ${SPAC_SQL}`).get().c;
  const dead = d.prepare(`SELECT COUNT(*) c FROM companies WHERE enriched_at IS NOT NULL AND ${DEAD_SQL}`).get().c;
  const total = d.prepare(`SELECT COUNT(*) c FROM companies WHERE ${where}`).get().c;
  const keep = d.prepare(`SELECT COUNT(*) c FROM companies WHERE enriched_at IS NOT NULL AND NOT (${SPAC_SQL} OR ${DEAD_SQL})`).get().c;

  console.log(`SPAC ${spac} / 폐업추정 ${dead} → 중복 제외 ${total}곳 삭제 대상`);
  console.log(`남는 기업 ${keep.toLocaleString()}곳`);

  if (DRY) {
    console.log("");
    console.log("표본:");
    d.prepare(`SELECT corp_name, corp_cls FROM companies WHERE ${where} LIMIT 8`).all()
      .forEach((r) => console.log(`  ${r.corp_name} (${r.corp_cls})`));
    console.log("");
    console.log("(--dry-run 이므로 지우지 않음)");
    return;
  }

  d.exec("BEGIN");
  try {
    // company_financials 는 ON DELETE CASCADE 로 함께 지워진다
    const r = d.prepare(`DELETE FROM companies WHERE ${where}`).run();
    d.exec("COMMIT");
    console.log(`삭제 완료 ${r.changes.toLocaleString()}곳`);
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/* ── 현황 ────────────────────────────────────── */
function status() {
  const d = db();
  const one = (sql) => d.prepare(sql).get().c;
  const total = one("SELECT COUNT(*) c FROM companies");
  if (!total) {
    console.log("기업 DB 가 비어 있습니다. 먼저 `node scripts/dart-sync.js codes` 를 실행하세요.");
    return;
  }
  console.log(`전체 ${total.toLocaleString()}개사`);
  console.log(`  상장사        ${one("SELECT COUNT(*) c FROM companies WHERE stock_code IS NOT NULL AND stock_code != ''").toLocaleString()}`);
  console.log(`  개황 확보     ${one("SELECT COUNT(*) c FROM companies WHERE enriched_at IS NOT NULL").toLocaleString()}`);
  console.log(`  재무 확보     ${one("SELECT COUNT(DISTINCT corp_code) c FROM company_financials").toLocaleString()}`);
  const regions = d
    .prepare("SELECT region k, COUNT(*) c FROM companies WHERE region IS NOT NULL AND region != '' GROUP BY region ORDER BY c DESC LIMIT 10")
    .all();
  if (regions.length) {
    console.log("\n지역별(상위 10)");
    for (const r of regions) console.log(`  ${String(r.c).padStart(6)}  ${r.k}`);
  }
}

(async () => {
  if (cmd !== "status" && !dart.hasKey()) {
    console.error("DART_API_KEY 가 .env 에 없습니다.");
    console.error("OpenDART 에서 발급받은 40자리 키를 .env 에 DART_API_KEY=... 로 넣으세요.");
    process.exit(1);
  }
  if (cmd === "codes") await syncCodes();
  else if (cmd === "enrich") await enrich();
  else if (cmd === "finance") await finance();
  else if (cmd === "clean") clean();
  else if (cmd === "status") status();
  else {
    console.log("사용법: node scripts/dart-sync.js [codes|enrich|finance|clean|status]");
    process.exit(1);
  }
})().catch((e) => {
  console.error("\n실패:", e.message);
  process.exit(1);
});
