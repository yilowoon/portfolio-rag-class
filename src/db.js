"use strict";
/* node:sqlite(내장) 기반 저장소. 네이티브 의존성 없음. */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { DB_PATH } = require("./config");

let _db = null;
let _dbFile = DB_PATH;
const _onSwitch = []; // DB 가 바뀔 때 캐시를 비워야 하는 모듈들이 등록한다

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY,
  abs_path     TEXT UNIQUE NOT NULL,
  rel_path     TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  ext          TEXT,
  org          TEXT,
  org_type     TEXT,
  title        TEXT,
  doc_type     TEXT,
  year         INTEGER,
  size         INTEGER,
  mtime        INTEGER,
  content_hash TEXT,
  kind         TEXT,     -- text | media
  status       TEXT,     -- ok | empty | error
  error        TEXT,
  text_chars   INTEGER DEFAULT 0,
  chunk_count  INTEGER DEFAULT 0,
  redacted     TEXT,     -- 마스킹한 항목 요약(예: 주민등록번호 1건)
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_org  ON documents(org);
CREATE INDEX IF NOT EXISTS idx_doc_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_doc_year ON documents(year);
CREATE INDEX IF NOT EXISTS idx_doc_kind ON documents(kind);

/*
 * 이미지 원본 바이트.
 * 사진·표창장 같은 미디어는 myprofile 폴더에서 경로로 읽어 왔는데,
 * 그 폴더는 개인정보 때문에 저장소에 올리지 않아 배포 환경에는 파일이 없다.
 * DB 는 배포를 따라가므로 작은 이미지는 여기에 담아 같이 옮긴다.
 */
CREATE TABLE IF NOT EXISTS doc_blobs (
  doc_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  mime   TEXT NOT NULL,
  bytes  BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_text (
  doc_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  text   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id      INTEGER PRIMARY KEY,
  doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  text    TEXT NOT NULL,
  chars   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunks(doc_id);

-- 한국어 부분일치를 위해 trigram 토크나이저 사용(2글자 이하 질의는 LIKE 로 대체)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  dim      INTEGER NOT NULL,
  model    TEXT,
  vec      BLOB NOT NULL
);

-- ── 체계화(큐레이션) 레이어 ─────────────────────────────

-- 이력서 머리말에 쓰는 인적사항(항상 1행)
CREATE TABLE IF NOT EXISTS profile_basic (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT,
  name_sub   TEXT,   -- 본관·한자 등 부가 표기
  birth      TEXT,
  headline   TEXT,   -- 한 줄 소개
  org        TEXT,
  position   TEXT,
  email      TEXT,
  phone      TEXT,
  office     TEXT,
  address    TEXT,
  summary    TEXT,   -- 핵심 역량 요약(여러 줄)
  photo      TEXT,   -- /static 기준 경로
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  org          TEXT,
  role         TEXT,
  category     TEXT,
  period_start TEXT,
  period_end   TEXT,
  summary      TEXT,
  outcomes     TEXT,
  tags         TEXT,
  featured     INTEGER DEFAULT 0,
  visibility   TEXT DEFAULT 'private',   -- private | public
  created_at   TEXT,
  updated_at   TEXT
);
CREATE TABLE IF NOT EXISTS project_docs (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doc_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, doc_id)
);

CREATE TABLE IF NOT EXISTS profile_items (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,   -- 경력 | 학력 | 자격 | 수상 | 특허 | 논문 | 활동
  title        TEXT NOT NULL,
  org          TEXT,
  period_start TEXT,
  period_end   TEXT,
  description  TEXT,
  tags         TEXT,
  sort_order   INTEGER DEFAULT 0,
  visibility   TEXT DEFAULT 'private',
  created_at   TEXT,
  updated_at   TEXT
);
CREATE TABLE IF NOT EXISTS profile_docs (
  item_id INTEGER NOT NULL REFERENCES profile_items(id) ON DELETE CASCADE,
  doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, doc_id)
);

-- ── 기업 DB (OpenDART 동기화) ─────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  corp_code     TEXT PRIMARY KEY,   -- DART 고유번호 8자리
  corp_name     TEXT NOT NULL,
  corp_eng_name TEXT,
  stock_code    TEXT,               -- 있으면 상장사
  modify_date   TEXT,
  -- 아래는 기업개황(company.json)을 받아와야 채워진다
  corp_cls      TEXT,               -- Y:유가 K:코스닥 N:코넥스 E:기타
  ceo_nm        TEXT,
  adres         TEXT,
  region        TEXT,               -- 주소에서 뽑은 시·도
  induty_code   TEXT,               -- 표준산업분류 코드
  est_dt        TEXT,               -- 설립일
  acc_mt        TEXT,               -- 결산월
  hm_url        TEXT,
  phn_no        TEXT,
  enriched_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_co_region ON companies(region);
CREATE INDEX IF NOT EXISTS idx_co_cls    ON companies(corp_cls);
CREATE INDEX IF NOT EXISTS idx_co_stock  ON companies(stock_code);
CREATE INDEX IF NOT EXISTS idx_co_induty ON companies(induty_code);

-- 연도별 주요계정(매출·자산·영업이익 등)을 계정명 그대로 보관
CREATE TABLE IF NOT EXISTS company_financials (
  corp_code  TEXT NOT NULL REFERENCES companies(corp_code) ON DELETE CASCADE,
  bsns_year  TEXT NOT NULL,
  account_nm TEXT NOT NULL,
  fs_div     TEXT,
  amount     TEXT,
  updated_at TEXT,
  PRIMARY KEY (corp_code, bsns_year, account_nm, fs_div)
);

-- ── 자기소개서 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cover_letters (
  id         INTEGER PRIMARY KEY,
  corp_code  TEXT,          -- 대상 기업(없으면 일반용)
  corp_name  TEXT,
  industry   TEXT,
  job_title  TEXT,          -- 지원 직무(직접 입력)
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS cover_sections (
  letter_id    INTEGER NOT NULL REFERENCES cover_letters(id) ON DELETE CASCADE,
  section_key  TEXT NOT NULL,   -- growth | personality | activities | values | motivation
  content      TEXT,            -- 생성되거나 직접 고친 본문
  extra_info   TEXT,            -- 재생성 때 반영할 추가 정보
  status       TEXT,            -- ok | empty | error
  note         TEXT,            -- 자료가 모자랄 때의 안내
  generated_at TEXT,
  PRIMARY KEY (letter_id, section_key)
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id         INTEGER PRIMARY KEY,
  started_at TEXT,
  ended_at   TEXT,
  scanned    INTEGER,
  indexed    INTEGER,
  skipped    INTEGER,
  failed     INTEGER,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS ask_log (
  id         INTEGER PRIMARY KEY,
  asked_at   TEXT,
  question   TEXT,
  answer     TEXT,
  sources    TEXT
);
`;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(_dbFile), { recursive: true });
  _db = new DatabaseSync(_dbFile);
  _db.exec(SCHEMA);
  return _db;
}

const currentFile = () => _dbFile;

/*
 * 열려 있는 DB 를 다른 파일로 바꾼다.
 * 프로필 하나 = SQLite 파일 하나라는 구조를 그대로 살린 방식이라,
 * 테이블마다 profile_id 를 달고 모든 질의를 고치는 것보다 손댈 곳이 적다.
 *
 * 주의: 모듈 수준 캐시(임베딩 행렬 등)는 이전 DB 의 내용이므로 반드시 비운다.
 */
function switchTo(file) {
  const next = path.resolve(file);
  if (next === path.resolve(_dbFile) && _db) return _db;
  if (_db) {
    try { _db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch (_) {}
    try { _db.close(); } catch (_) {}
    _db = null;
  }
  _dbFile = next;
  const handle = db();
  for (const fn of _onSwitch) {
    try { fn(); } catch (_) {}
  }
  return handle;
}

/* 캐시를 가진 모듈이 전환 시 호출받도록 등록한다 */
const onSwitch = (fn) => { _onSwitch.push(fn); };

/* chunks ↔ chunks_fts 동기화(외부 콘텐츠 테이블이므로 수동 관리) */
function ftsInsert(chunkId, text) {
  db().prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)").run(chunkId, text);
}
function ftsDeleteDoc(docId) {
  const rows = db().prepare("SELECT id, text FROM chunks WHERE doc_id = ?").all(docId);
  const del = db().prepare("INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)");
  for (const r of rows) del.run(r.id, r.text);
}

module.exports = { db, ftsInsert, ftsDeleteDoc, currentFile, switchTo, onSwitch };
