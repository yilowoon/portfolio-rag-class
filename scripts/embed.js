"use strict";
/*
 * 청크 임베딩 생성(선택). GEMINI_API_KEY 가 있을 때만 동작한다.
 *
 *   node scripts/embed.js               # 아직 임베딩이 없는 청크 전부
 *   node scripts/embed.js --limit 2000  # 일부만
 *   node scripts/embed.js --reset       # 전부 다시 만들기
 */
const { db } = require("../src/db");
const { gemini } = require("../src/config");
const { embedChunks } = require("../src/embed");

const argv = process.argv.slice(2);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const LIMIT = Number(val("--limit", 0)) || 0;

(async () => {
  if (!gemini.enabled()) {
    console.error("GEMINI_API_KEY 가 .env 에 없습니다. 키워드 검색만 사용됩니다.");
    process.exit(1);
  }
  const d = db();
  if (argv.includes("--reset")) {
    d.exec("DELETE FROM embeddings");
    console.log("기존 임베딩 삭제");
  }
  const rows = d
    .prepare(
      `SELECT c.id, c.text FROM chunks c
       LEFT JOIN embeddings e ON e.chunk_id = c.id
       WHERE e.chunk_id IS NULL
       ORDER BY c.id` + (LIMIT ? " LIMIT " + LIMIT : "")
    )
    .all();

  if (!rows.length) {
    console.log("임베딩할 청크가 없습니다.");
    return;
  }
  console.log(`임베딩 대상 ${rows.length}개 청크 (모델: ${gemini.embedModel()})`);
  const t0 = Date.now();
  const done = await embedChunks(rows, {
    onProgress: (n, total) => {
      const pct = ((n / total) * 100).toFixed(1);
      process.stdout.write(`\r  ${n}/${total} (${pct}%) …`);
    },
  });
  console.log(`\n완료: ${done}개, ${((Date.now() - t0) / 1000).toFixed(1)}초`);
})().catch((e) => {
  console.error("\n실패:", e.message);
  process.exit(1);
});
