"use strict";
/* 환경변수(.env) + 수집 설정(config/sources.json) 로더 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function loadEnv() {
  const p = path.join(ROOT, ".env");
  try {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch (_) {}
}
loadEnv();

function sources() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "sources.json"), "utf8"));
  /*
   * workRoot 는 상대경로로 적어도 되게 한다.
   * 절대경로를 박아 두면 다른 PC 에서 받자마자 고쳐야 하고,
   * 저장소를 공유할 때 개인 폴더 구조가 그대로 드러난다.
   */
  if (cfg.workRoot && !path.isAbsolute(cfg.workRoot)) {
    cfg.workRoot = path.resolve(ROOT, cfg.workRoot).split(path.sep).join("/");
  }
  return cfg;
}

const gemini = {
  key: () => (process.env.GEMINI_API_KEY || "").trim(),
  enabled: () => Boolean((process.env.GEMINI_API_KEY || "").trim()),
  base: () => (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, ""),
  textModel: () => process.env.GEMINI_TEXT_MODEL || "gemini-3.1-flash-lite",
  embedModel: () => process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001",
};

module.exports = {
  ROOT,
  DB_PATH: process.env.DB_PATH || path.join(ROOT, "data", "portfolio.db"),
  PORT: Number(process.env.PORT || 4300),
  APP_PASSWORD: (process.env.APP_PASSWORD || "").trim(),
  SESSION_SECRET: process.env.SESSION_SECRET || "profile-job-dev-secret",
  sources,
  gemini,
};
