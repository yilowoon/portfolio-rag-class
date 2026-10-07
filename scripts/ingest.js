"use strict";
/*
 * 원천 폴더를 훑어 문서를 추출·분할해 DB에 적재한다.
 *
 *   node scripts/ingest.js                 # 증분 수집(변경된 파일만)
 *   node scripts/ingest.js --dry-run       # 수집 대상만 집계하고 쓰지 않음
 *   node scripts/ingest.js --force         # 이미 있는 문서도 다시 추출
 *   node scripts/ingest.js --limit 50      # 처음 N건만
 *   node scripts/ingest.js --only 제안서   # 경로에 문자열이 포함된 것만
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sources } = require("../src/config");
const { db, ftsInsert, ftsDeleteDoc } = require("../src/db");
const { extractText } = require("../src/extract");
const { chunk } = require("../src/chunk");
const { redact } = require("../src/redact");
const { docType, guessYear, titleOf, tagsOf } = require("../src/classify");

/* DB 에 담을 이미지 형식과 크기 상한 */
const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};
const BLOB_MAX = 4 * 1024 * 1024;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DRY = has("--dry-run");
const FORCE = has("--force");
const LIMIT = Number(val("--limit", 0)) || 0;
const ONLY = val("--only", "");

const cfg = sources();
const WORK = cfg.workRoot.replace(/\\/g, "/");
const TEXT_EXT = new Set(cfg.textExt);
const MEDIA_EXT = new Set(cfg.mediaExt);
const SKIP_EXT = new Set(cfg.skipExt.map((e) => e.toLowerCase()));
const MAX_BYTES = cfg.maxFileSizeMB * 1024 * 1024;

const excludeNameRe = new RegExp(
  cfg.excludeName.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i"
);

function skipFile(name) {
  for (const p of cfg.skipFilePrefixes) if (name.startsWith(p)) return "임시/숨김파일";
  const ext = path.extname(name).toLowerCase();
  if (SKIP_EXT.has(ext)) return "제외 확장자";
  if (excludeNameRe.test(name)) return "민감/개인정보 규칙";
  return null;
}

function walk(dir, org, orgType, maxDepth, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (cfg.excludeDirs.some((d) => e.name === d)) continue;
      if (excludeNameRe.test(e.name)) continue;
      // maxDepth=1 이면 그 폴더의 직속 파일만 본다(하위 폴더는 각자의 source 가 담당)
      if (maxDepth && depth + 1 >= maxDepth) continue;
      walk(full, org, orgType, maxDepth, depth + 1, out);
      continue;
    }
    if (!e.isFile()) continue;
    const reason = skipFile(e.name);
    if (reason) { out.skipped.push({ full, reason }); continue; }
    const ext = path.extname(e.name).toLowerCase();
    const kind = TEXT_EXT.has(ext) ? "text" : MEDIA_EXT.has(ext) ? "media" : null;
    if (!kind) { out.skipped.push({ full, reason: "대상 아닌 형식" }); continue; }
    if (ONLY && !full.includes(ONLY)) continue;
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.size > MAX_BYTES) { out.skipped.push({ full, reason: "용량 초과" }); continue; }
    if (out.seen.has(full)) continue; // source 범위가 겹쳐도 한 번만
    out.seen.add(full);
    out.files.push({ full, org, orgType, kind, ext, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  return out;
}

/* 같은 이름의 .hwp / .pdf 가 함께 있으면 추출이 안정적인 쪽만 남긴다. */
function dedupeTwins(files) {
  if (!cfg.preferPdfOverHwp) return { kept: files, dropped: [] };
  const byKey = new Map();
  for (const f of files) {
    const key = path.dirname(f.full) + "|" + path.basename(f.full, path.extname(f.full));
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  const rank = { ".pdf": 3, ".hwpx": 2, ".hwp": 1 };
  const kept = [];
  const dropped = [];
  for (const group of byKey.values()) {
    const docs = group.filter((f) => rank[f.ext]);
    const others = group.filter((f) => !rank[f.ext]);
    kept.push(...others);
    if (docs.length <= 1) { kept.push(...docs); continue; }
    docs.sort((a, b) => rank[b.ext] - rank[a.ext]);
    kept.push(docs[0]);
    dropped.push(...docs.slice(1).map((f) => ({ full: f.full, reason: "동일명 " + docs[0].ext + " 우선" })));
  }
  return { kept, dropped };
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 32);
}

async function main() {
  const started = new Date().toISOString();
  const scan = { files: [], skipped: [], seen: new Set() };
  for (const s of cfg.sources) {
    const base = s.path === "." ? WORK : path.join(WORK, s.path);
    if (!fs.existsSync(base)) { console.warn("없는 경로 건너뜀:", base); continue; }
    walk(base, s.org, s.orgType, s.maxDepth || 0, 0, scan);
  }
  const { kept, dropped } = dedupeTwins(scan.files);
  scan.skipped.push(...dropped);

  const files = LIMIT ? kept.slice(0, LIMIT) : kept;
  const textFiles = files.filter((f) => f.kind === "text");
  console.log(
    `대상 ${files.length}건 (본문 ${textFiles.length} / 미디어 ${files.length - textFiles.length}), 제외 ${scan.skipped.length}건`
  );

  if (DRY) {
    const byReason = {};
    for (const s of scan.skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    console.log("\n[제외 사유]");
    for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(5)}  ${k}`);
    const byOrg = {};
    for (const f of files) byOrg[f.org] = (byOrg[f.org] || 0) + 1;
    console.log("\n[조직별 수집 대상]");
    for (const [k, v] of Object.entries(byOrg).sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(5)}  ${k}`);
    console.log("\n(--dry-run 이므로 DB에 쓰지 않음)");
    return;
  }

  const d = db();
  const selExisting = d.prepare("SELECT id, size, mtime, status FROM documents WHERE abs_path = ?");
  const upsert = d.prepare(`
    INSERT INTO documents (abs_path, rel_path, file_name, ext, org, org_type, title, doc_type, year,
                           size, mtime, content_hash, kind, status, error, text_chars, chunk_count, redacted, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(abs_path) DO UPDATE SET
      rel_path=excluded.rel_path, file_name=excluded.file_name, ext=excluded.ext,
      org=excluded.org, org_type=excluded.org_type, title=excluded.title,
      doc_type=excluded.doc_type, year=excluded.year, size=excluded.size, mtime=excluded.mtime,
      content_hash=excluded.content_hash, kind=excluded.kind, status=excluded.status,
      error=excluded.error, text_chars=excluded.text_chars, chunk_count=excluded.chunk_count,
      redacted=excluded.redacted, updated_at=excluded.updated_at
  `);
  const getId = d.prepare("SELECT id FROM documents WHERE abs_path = ?");
  const delText = d.prepare("DELETE FROM doc_text WHERE doc_id = ?");
  const delChunks = d.prepare("DELETE FROM chunks WHERE doc_id = ?");
  const insText = d.prepare("INSERT INTO doc_text (doc_id, text) VALUES (?, ?)");
  const insChunk = d.prepare("INSERT INTO chunks (doc_id, seq, text, chars) VALUES (?,?,?,?)");
  const lastId = d.prepare("SELECT last_insert_rowid() AS id");

  const insBlob = d.prepare("INSERT OR REPLACE INTO doc_blobs (doc_id, mime, bytes) VALUES (?,?,?)");
  const delBlob = d.prepare("DELETE FROM doc_blobs WHERE doc_id = ?");

  let indexed = 0, unchanged = 0, failed = 0, media = 0, blobbed = 0;
  const failures = [];
  const redactions = [];

  for (const f of files) {
    const rel = f.full.replace(/\\/g, "/").replace(WORK + "/", "");
    const name = path.basename(f.full);
    const prev = selExisting.get(f.full);
    if (!FORCE && prev && prev.size === f.size && prev.mtime === f.mtime && prev.status !== "error") {
      unchanged++;
      continue;
    }

    if (f.kind === "media") {
      // photos/ 아래 이미지는 프로필 상단 롤링 배너에 쓴다
      const mediaType = /(^|\/)photos\//.test(rel) ? "활동사진" : "이미지·미디어";
      upsert.run(f.full, rel, name, f.ext, f.org, f.orgType, titleOf(name), mediaType,
        guessYear(name, rel, f.mtime), f.size, f.mtime, null, "media", "ok", null, 0, 0, null, new Date().toISOString());
      // 작은 이미지는 바이트째 DB 에 담는다 — 배포 환경에는 원본 폴더가 없기 때문
      const mid = getId.get(f.full).id;
      if (MIME[f.ext] && f.size <= BLOB_MAX) {
        insBlob.run(mid, MIME[f.ext], fs.readFileSync(f.full));
        blobbed++;
      } else {
        delBlob.run(mid);
      }
      media++;
      continue;
    }

    let text = "", status = "ok", error = null, redacted = null;
    try {
      text = (await extractText(f.full)) || "";
      // 주민등록번호 등 식별정보는 DB 에 넣기 전에 가린다(원본 파일은 그대로)
      const r = redact(text);
      text = r.text;
      if (r.hits.length) {
        redacted = r.hits.map((h) => `${h.rule} ${h.count}건`).join(", ");
        redactions.push({ file: rel, note: redacted });
      }
      if (!text.replace(/\s/g, "")) { status = "empty"; error = "추출된 텍스트 없음(스캔본일 수 있음)"; }
    } catch (e) {
      status = "error";
      error = String(e && e.message ? e.message : e).slice(0, 300);
      failed++;
      failures.push({ file: rel, error });
    }

    const parts = status === "ok" ? chunk(text) : [];
    upsert.run(f.full, rel, name, f.ext, f.org, f.orgType, titleOf(name),
      docType(name, rel), guessYear(name, rel, f.mtime), f.size, f.mtime,
      status === "ok" ? sha256(f.full) : null, "text", status, error,
      text.length, parts.length, redacted, new Date().toISOString());

    const id = getId.get(f.full).id;
    d.exec("BEGIN");
    try {
      ftsDeleteDoc(id);
      delChunks.run(id);
      delText.run(id);
      if (status === "ok") {
        insText.run(id, text);
        parts.forEach((p, i) => {
          insChunk.run(id, i, p, p.length);
          ftsInsert(lastId.get().id, p);
        });
      }
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    if (status === "ok") indexed++;

    if ((indexed + failed + media) % 50 === 0) {
      process.stdout.write(`\r  진행 ${indexed + failed + media + unchanged}/${files.length} …`);
    }
  }

  /*
   * 실제로 한 일이 있을 때만 기록을 남긴다.
   * 아무것도 안 바뀐 실행까지 적으면 DB 파일이 매번 달라져서,
   * 변경이 없는데도 커밋이 하나씩 쌓인다.
   */
  if (indexed || media || failed) {
    d.prepare(
      "INSERT INTO ingest_runs (started_at, ended_at, scanned, indexed, skipped, failed, note) VALUES (?,?,?,?,?,?,?)"
    ).run(started, new Date().toISOString(), files.length, indexed, scan.skipped.length + unchanged, failed,
      FORCE ? "force" : "incremental");
  }

  console.log(
    `\n완료: 본문 색인 ${indexed} / 미디어 ${media} / 변경없음 ${unchanged} / 실패 ${failed}`
  );
  if (failures.length) {
    console.log("\n[실패 상위 15건]");
    for (const f of failures.slice(0, 15)) console.log("  -", f.file, "→", f.error);
    if (failures.length > 15) console.log(`  … 외 ${failures.length - 15}건`);
  }
  if (redactions.length) {
    console.log("");
    console.log("[민감정보 마스킹]");
    for (const r of redactions) console.log("  -", r.file, "→", r.note);
  }
  const tags = d.prepare("SELECT COUNT(*) c FROM chunks").get().c;
  console.log(`청크 ${tags}개 / DB: data/portfolio.db`);
}

main().catch((e) => {
  console.error("실패:", e);
  process.exit(1);
});
