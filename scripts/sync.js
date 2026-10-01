"use strict";
/*
 * 수집부터 배포까지 한 번에.
 *
 *   npm run sync                 # 수집 → 활동색인 → 임베딩 → 체크포인트 → 커밋 → 푸시
 *   npm run sync -- --force      # 전체 재추출부터
 *   npm run sync -- --no-push    # 커밋까지만
 *   npm run sync -- --no-git     # DB 갱신까지만
 *   npm run sync -- -m "메모"    # 커밋 메시지 지정
 *
 * 단계가 넷이라 하나라도 빠뜨리면 배포본이 옛 데이터를 받는다.
 * 특히 WAL 체크포인트를 건너뛰면 git 은 DB 가 안 바뀐 것으로 보고,
 * 방금 만든 내용이 통째로 빠진 채 푸시된다. 그 순서를 여기에 고정해 둔다.
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const DB = path.join(ROOT, "data", "portfolio.db");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const line = (s) => console.log("\n\u001b[1m" + s + "\u001b[0m");
const ok = (s) => console.log("  " + s);

function node(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(script + " 실패 (exit " + r.status + ")");
}

function git(args, { quiet = false } = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: quiet ? "pipe" : ["pipe", "pipe", "pipe"] });
}

function hasKey() {
  require("../src/config");
  return Boolean((process.env.GEMINI_API_KEY || "").trim());
}

(function main() {
  const steps = [];

  /* 1) 원본 자료 수집 */
  line("1/5  자료 수집");
  node("ingest.js", has("--force") ? ["--force"] : []);
  steps.push("수집");

  /* 2) 포트폴리오 활동 색인 */
  line("2/5  활동 색인");
  node("index-activities.js");
  steps.push("활동색인");

  /* 3) 임베딩 — 키가 없으면 건너뛴다(키워드 검색은 그대로 동작) */
  line("3/5  임베딩");
  if (hasKey()) {
    // 임베딩이 실패해도 뒤 단계(체크포인트·커밋)는 진행한다.
    // 키워드 검색은 임베딩 없이도 되고, 남은 청크는 다음 실행이 이어서 채운다.
    try {
      node("embed.js");
      steps.push("임베딩");
    } catch (e) {
      console.warn("  ⚠ 임베딩을 끝내지 못했습니다: " + e.message);
      console.warn("    나중에 'npm run embed' 로 이어서 채우세요.");
      steps.push("임베딩(일부)");
    }
  } else {
    ok("GEMINI_API_KEY 가 없어 건너뜁니다. 키워드 검색은 그대로 동작합니다.");
  }

  /* 4) WAL 체크포인트 — 이걸 빠뜨리면 변경분이 본체에 안 합쳐진다 */
  line("4/5  DB 정리(WAL 체크포인트)");
  const db = new DatabaseSync(DB);
  const cp = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM documents WHERE kind='text') docs,
              (SELECT COUNT(*) FROM chunks) chunks,
              (SELECT COUNT(*) FROM embeddings) embs,
              (SELECT COUNT(*) FROM projects) acts`
    )
    .get();
  db.close();

  const walPath = DB + "-wal";
  const walLeft = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  ok(`무결성 ${integrity} · 문서 ${counts.docs} · 활동 ${counts.acts} · 청크 ${counts.chunks} · 임베딩 ${counts.embs}`);

  if (cp.busy || walLeft > 0) {
    console.error(
      "\n  ⚠ 체크포인트가 완료되지 않았습니다(busy=" + cp.busy + ", WAL " + walLeft + "바이트).\n" +
        "    실행 중인 서버(npm start)가 DB 를 잡고 있을 수 있습니다.\n" +
        "    서버를 멈추고 다시 실행하세요. 이 상태로 커밋하면 변경분이 빠진 DB 가 올라갑니다."
    );
    process.exit(1);
  }
  steps.push("체크포인트");

  /* 5) 커밋 & 푸시 */
  if (has("--no-git")) {
    line("5/5  git 건너뜀 (--no-git)");
    console.log("\n완료: " + steps.join(" → "));
    return;
  }

  line("5/5  커밋 & 푸시");
  const dirty = git(["status", "--porcelain", "data/portfolio.db"], { quiet: true }).trim();
  if (!dirty) {
    ok("DB 에 변경이 없어 커밋할 것이 없습니다.");
    console.log("\n완료: " + steps.join(" → "));
    return;
  }

  const msg =
    val("-m", "") ||
    `DB 갱신: 문서 ${counts.docs} · 활동 ${counts.acts} · 청크 ${counts.chunks} · 임베딩 ${counts.embs}`;
  git(["add", "data/portfolio.db"]);
  git(["commit", "-q", "-m", msg]);
  ok("커밋: " + msg);
  steps.push("커밋");

  if (has("--no-push")) {
    ok("푸시는 건너뜁니다 (--no-push)");
  } else {
    try {
      git(["push", "-q", "origin", "HEAD"]);
      ok("푸시 완료 → origin");
      steps.push("푸시");
    } catch (e) {
      console.error("  푸시 실패: " + (e.stderr || e.message || "").toString().trim());
      console.error("  커밋은 남아 있으니 네트워크 확인 후 'git push' 하세요.");
      process.exit(1);
    }
  }

  console.log("\n완료: " + steps.join(" → "));
})();
