"use strict";
/*
 * 프로필 전환.
 *
 * 프로필 하나 = SQLite 파일 하나다. data/ 안의 .db 파일을 훑어 목록을 만들고,
 * 선택한 파일로 열려 있는 DB 를 바꾼다.
 *
 * 쓰임새
 *  - 수업 시연: 본인 자료 대신 예시 프로필로 화면을 보여줄 때
 *  - 실습: 예시와 본인 프로필을 오가며 비교할 때
 *
 * 선택은 data/current.txt 에 남겨 서버를 다시 띄워도 유지된다.
 */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ROOT, DB_PATH } = require("./config");
const { switchTo, currentFile } = require("./db");

const DATA_DIR = path.join(ROOT, "data");
const MARKER = path.join(DATA_DIR, "current.txt");

/* WAL·SHM 같은 부속 파일은 프로필이 아니다 */
const isProfileDb = (name) => /\.db$/i.test(name);

/* 파일을 열어 이름만 읽는다. 열 수 없으면 목록에서 뺀다 */
function labelOf(file) {
  let h = null;
  try {
    h = new DatabaseSync(file, { readOnly: true });
    const r = h.prepare("SELECT name FROM profile_basic WHERE id=1").get();
    const n = h.prepare("SELECT COUNT(*) c FROM projects").get();
    return { name: (r && r.name) || null, activities: n.c };
  } catch (_) {
    return null;
  } finally {
    if (h) { try { h.close(); } catch (_) {} }
  }
}

function list() {
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter(isProfileDb);
  } catch (_) {
    return [];
  }
  const cur = path.resolve(currentFile());
  const out = [];
  for (const f of files.sort()) {
    const full = path.join(DATA_DIR, f);
    const info = labelOf(full);
    if (!info) continue; // 스키마가 없는 파일(빈 DB 등)은 건너뛴다
    out.push({
      file: f,
      path: full,
      name: info.name || f.replace(/\.db$/i, ""),
      activities: info.activities,
      current: path.resolve(full) === cur,
      isDefault: path.resolve(full) === path.resolve(DB_PATH),
    });
  }
  return out;
}

/* 저장해 둔 선택을 서버 기동 시 적용한다 */
function restore() {
  try {
    const want = fs.readFileSync(MARKER, "utf8").trim();
    if (!want) return;
    const full = path.join(DATA_DIR, path.basename(want));
    if (fs.existsSync(full) && labelOf(full)) switchTo(full);
  } catch (_) {}
}

function select(fileName) {
  const safe = path.basename(String(fileName || "")); // 경로 탈출 방지
  if (!isProfileDb(safe)) throw new Error("프로필 파일이 아닙니다.");
  const full = path.join(DATA_DIR, safe);
  if (!fs.existsSync(full)) throw new Error("없는 프로필입니다: " + safe);
  if (!labelOf(full)) throw new Error("열 수 없는 프로필입니다: " + safe);

  switchTo(full);
  try {
    fs.writeFileSync(MARKER, safe, "utf8");
  } catch (_) {}
  return safe;
}

const current = () => path.basename(currentFile());

module.exports = { list, select, restore, current };
