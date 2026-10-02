"use strict";
/*
 * 포트폴리오 체계화 DB 웹사이트.
 * 로컬 전용을 기본으로 하되, APP_PASSWORD 를 지정하면 비밀번호 게이트가 붙는다.
 */
const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");

const { PORT, APP_PASSWORD, SESSION_SECRET, sources, gemini } = require("./src/config");
const { db } = require("./src/db");
const { hybridSearch, keywordSearch, snippet } = require("./src/search");
const { ask } = require("./src/rag");
const stats = require("./src/stats");
const { CATEGORIES, PROFILE_KINDS, byCategory, byYear, timeline, coverage } = require("./src/portfolio");
const comp = require("./src/competency");
const cover = require("./src/cover");
const profiles = require("./src/profiles");

/* 지난번에 고른 프로필로 복원한다 */
profiles.restore();

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));
app.use("/static", express.static(path.join(__dirname, "public")));

/* 개인 이력이 담긴 사이트라 검색엔진 수집을 막는다(인증 게이트와 별개의 안전장치) */
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 12 },
  })
);

/*
 * 운영 환경 안전장치.
 * 이 앱은 이력서(생년월일·주소·연락처)와 전체 경력을 그대로 보여준다.
 * 배포해 놓고 APP_PASSWORD 를 빠뜨리면 주소를 아는 누구나 열람하게 되므로,
 * 로컬이 아닌 곳에서 비밀번호가 없으면 아예 서비스하지 않는다.
 */
const LOCKED = process.env.NODE_ENV === "production" && !APP_PASSWORD;
if (LOCKED) {
  app.use((req, res) => {
    res.status(503).type("text/plain").send(
      "APP_PASSWORD 가 설정되지 않아 서비스를 중단했습니다.\n" +
        "개인 이력이 담긴 사이트라 인증 없이 공개할 수 없습니다.\n" +
        "Render 대시보드 > Environment 에서 APP_PASSWORD 를 지정한 뒤 다시 배포하세요."
    );
  });
}

/* ── 인증(선택) ───────────────────────────────── */
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.session && req.session.ok) return next();
  if (req.path === "/login") return next();
  return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
}
app.get("/login", (req, res) => {
  if (!APP_PASSWORD) return res.redirect("/");
  res.render("login", { title: "로그인", error: null, next: req.query.next || "/", nav: false });
});
app.post("/login", (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    req.session.ok = true;
    return res.redirect(req.body.next || "/");
  }
  res.status(401).render("login", { title: "로그인", error: "비밀번호가 맞지 않습니다.", next: req.body.next || "/", nav: false });
});
app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
app.use(requireAuth);

/* 공통 뷰 변수 */
app.use((req, res, next) => {
  res.locals.nav = true;
  res.locals.hasKey = gemini.enabled();
  res.locals.path = req.path;
  try {
    res.locals.profiles = profiles.list();
  } catch (_) {
    res.locals.profiles = [];
  }
  next();
});

/* 프로필 전환 — 열려 있는 DB 파일을 바꾼다 */
app.post("/profiles/switch", (req, res) => {
  try {
    profiles.select(req.body.file);
  } catch (e) {
    console.warn("프로필 전환 실패:", e.message);
  }
  res.redirect(req.body.back || "/");
});

const nowISO = () => new Date().toISOString();
const basic = () => db().prepare("SELECT * FROM profile_basic WHERE id=1").get() || {};

const facets = () => ({
  orgs: db().prepare("SELECT DISTINCT org k FROM documents WHERE org IS NOT NULL ORDER BY org").all().map((r) => r.k),
  types: db().prepare("SELECT DISTINCT doc_type k FROM documents WHERE doc_type IS NOT NULL ORDER BY doc_type").all().map((r) => r.k),
  years: db().prepare("SELECT DISTINCT year k FROM documents WHERE year IS NOT NULL ORDER BY year DESC").all().map((r) => r.k),
});

/* ── 대시보드 ─────────────────────────────────── */
app.get("/", (req, res) => {
  res.render("index", {
    title: "대시보드",
    ov: stats.overview(),
    me: basic(),
    cats: byCategory(),
    byType: stats.byType(),
    yc: byYear(),
    recent: stats.recent(8),
    biggest: stats.biggest(6),
    cover: coverage(),
  });
});

app.get("/health", (req, res) => {
  res.render("health", {
    title: "수집 상태",
    ov: stats.overview(),
    failures: stats.failures(100),
    redacted: stats.redacted(),
    cfg: sources(),
  });
});

/* ── 검색 ────────────────────────────────────── */
app.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  const opts = { org: req.query.org || "", docType: req.query.type || "", year: req.query.year || "", limit: 25 };
  let hits = [];
  let error = null;
  if (q) {
    try {
      hits = await hybridSearch(q, opts);
    } catch (e) {
      error = e.message;
      try { hits = keywordSearch(q, opts); } catch (_) {}
    }
  }
  res.render("search", {
    title: "검색",
    q,
    hits: hits.map((h) => ({ ...h, snip: snippet(h.text, q) })),
    facets: facets(),
    sel: opts,
    error,
  });
});

/* ── 질의응답(RAG) ───────────────────────────── */
app.get("/ask", (req, res) => {
  const recentQ = db().prepare("SELECT question FROM ask_log ORDER BY id DESC LIMIT 8").all().map((r) => r.question);
  res.render("ask", { title: "질의응답", question: "", result: null, recentQ });
});
app.post("/ask", async (req, res) => {
  const question = (req.body.question || "").trim();
  let result = null;
  if (question) {
    try {
      result = await ask(question, { limit: 8 });
    } catch (e) {
      result = { answer: null, note: "오류: " + e.message, sources: [] };
    }
  }
  const recentQ = db().prepare("SELECT question FROM ask_log ORDER BY id DESC LIMIT 8").all().map((r) => r.question);
  res.render("ask", { title: "질의응답", question, result, recentQ });
});

/* ── 문서 ────────────────────────────────────── */
app.get("/docs", (req, res) => {
  const { org = "", type = "", year = "", sort = "recent" } = req.query;
  // 활동 색인(kind='activity')은 검색용이라 자료 목록에는 띄우지 않는다
  const where = ["kind != 'activity'"];
  const args = [];
  if (org) { where.push("org=?"); args.push(org); }
  if (type) { where.push("doc_type=?"); args.push(type); }
  if (year) { where.push("year=?"); args.push(Number(year)); }
  const order = sort === "size" ? "text_chars DESC" : sort === "title" ? "title COLLATE NOCASE" : "mtime DESC";
  const page = Math.max(1, Number(req.query.page || 1));
  const per = 50;
  const total = db().prepare(`SELECT COUNT(*) c FROM documents WHERE ${where.join(" AND ")}`).get(...args).c;
  const rows = db()
    .prepare(
      `SELECT id,title,org,doc_type,year,ext,text_chars,status,kind FROM documents
       WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .all(...args, per, (page - 1) * per);
  res.render("docs", { title: "문서", rows, total, page, per, facets: facets(), sel: { org, type, year, sort } });
});

app.get("/doc/:id", (req, res) => {
  const d = db();
  const doc = d.prepare("SELECT * FROM documents WHERE id=?").get(Number(req.params.id));
  if (!doc) return res.status(404).send("문서 없음");
  // 활동 색인은 원본이 포트폴리오 항목이므로 그쪽으로 보낸다
  if (doc.kind === "activity" && /^activity:(\d+)$/.test(doc.abs_path)) {
    return res.redirect("/portfolio/" + doc.abs_path.split(":")[1]);
  }
  const text = (d.prepare("SELECT text FROM doc_text WHERE doc_id=?").get(doc.id) || {}).text || "";
  const links = d
    .prepare("SELECT p.id, p.title, p.category FROM projects p JOIN project_docs pd ON pd.project_id=p.id WHERE pd.doc_id=?")
    .all(doc.id);
  res.render("doc", {
    title: doc.title,
    doc,
    text,
    links,
    exists: fs.existsSync(doc.abs_path),
    activities: d.prepare("SELECT id,title,category FROM projects ORDER BY category, title").all(),
  });
});

/* 원본 파일 열기 — 수집 루트 밖 경로는 거부 */
app.get("/doc/:id/file", (req, res) => {
  const doc = db().prepare("SELECT abs_path, file_name FROM documents WHERE id=?").get(Number(req.params.id));
  if (!doc) return res.status(404).end();
  const root = path.resolve(sources().workRoot);
  const target = path.resolve(doc.abs_path);
  if (!target.startsWith(root)) return res.status(403).send("허용되지 않은 경로");
  if (!fs.existsSync(target)) return res.status(404).send("원본 파일이 없습니다");
  res.download(target, doc.file_name);
});

/*
 * 이미지 미리보기(프로필 사진·표창장 등).
 * DB 에 담아 둔 바이트를 먼저 쓴다 — 배포 환경에는 myprofile 원본 폴더가 없다.
 * 로컬에서 아직 색인하지 않았을 때를 위해 파일시스템을 대비책으로 남긴다.
 */
app.get("/doc/:id/raw", (req, res) => {
  const id = Number(req.params.id);
  const blob = db().prepare("SELECT mime, bytes FROM doc_blobs WHERE doc_id=?").get(id);
  if (blob) {
    res.type(blob.mime);
    res.set("Cache-Control", "private, max-age=3600");
    return res.send(Buffer.from(blob.bytes));
  }
  const doc = db().prepare("SELECT abs_path FROM documents WHERE id=?").get(id);
  if (!doc) return res.status(404).end();
  const root = path.resolve(sources().workRoot);
  const target = path.resolve(doc.abs_path);
  if (!target.startsWith(root) || !fs.existsSync(target)) return res.status(404).end();
  res.sendFile(target);
});

app.post("/doc/:id/link", (req, res) => {
  const docId = Number(req.params.id);
  const pid = Number(req.body.activity_id);
  if (pid && docId) db().prepare("INSERT OR IGNORE INTO project_docs (project_id, doc_id) VALUES (?,?)").run(pid, docId);
  res.redirect("/doc/" + docId);
});

/* ── 포트폴리오(활동) ────────────────────────── */
app.get("/portfolio", (req, res) => {
  const cat = req.query.cat || "";
  res.render("portfolio", {
    title: "포트폴리오",
    cat,
    categories: CATEGORIES,
    cats: byCategory(),
    groups: timeline(cat),
    cover: coverage(),
    me: basic(),
  });
});

app.get("/portfolio/new", (req, res) => {
  res.render("activity", {
    title: "활동 추가",
    a: { id: 0, category: req.query.cat || CATEGORIES[0], visibility: "private" },
    docs: [],
    categories: CATEGORIES,
    allDocs: db().prepare("SELECT id,title FROM documents ORDER BY title").all(),
  });
});

app.post("/portfolio", (req, res) => {
  const b = req.body;
  const r = db()
    .prepare(
      `INSERT INTO projects (title,org,role,category,period_start,period_end,summary,outcomes,tags,featured,visibility,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(b.title || "제목 없음", b.org || "", b.role || "", b.category || CATEGORIES[0],
      b.period_start || "", b.period_end || "", b.summary || "", b.outcomes || "", b.tags || "",
      b.featured ? 1 : 0, b.visibility || "private", nowISO(), nowISO());
  res.redirect("/portfolio/" + r.lastInsertRowid);
});

app.get("/portfolio/:id", (req, res) => {
  const d = db();
  const a = d.prepare("SELECT * FROM projects WHERE id=?").get(Number(req.params.id));
  if (!a) return res.status(404).send("없는 활동");
  res.render("activity", {
    title: a.title,
    a,
    docs: d
      .prepare(
        `SELECT dd.id, dd.title, dd.doc_type, dd.year, dd.ext FROM documents dd
         JOIN project_docs pd ON pd.doc_id=dd.id WHERE pd.project_id=? ORDER BY dd.year DESC, dd.title`
      )
      .all(a.id),
    categories: CATEGORIES,
    allDocs: d.prepare("SELECT id,title FROM documents ORDER BY title").all(),
  });
});

app.post("/portfolio/:id", (req, res) => {
  const b = req.body;
  db()
    .prepare(
      `UPDATE projects SET title=?,org=?,role=?,category=?,period_start=?,period_end=?,summary=?,outcomes=?,tags=?,featured=?,visibility=?,updated_at=? WHERE id=?`
    )
    .run(b.title || "", b.org || "", b.role || "", b.category || CATEGORIES[0], b.period_start || "",
      b.period_end || "", b.summary || "", b.outcomes || "", b.tags || "", b.featured ? 1 : 0,
      b.visibility || "private", nowISO(), Number(req.params.id));
  res.redirect("/portfolio/" + req.params.id);
});

app.post("/portfolio/:id/delete", (req, res) => {
  db().prepare("DELETE FROM projects WHERE id=?").run(Number(req.params.id));
  res.redirect("/portfolio");
});

app.post("/portfolio/:id/docs", (req, res) => {
  const pid = Number(req.params.id);
  const docId = Number(req.body.doc_id);
  if (pid && docId) db().prepare("INSERT OR IGNORE INTO project_docs (project_id, doc_id) VALUES (?,?)").run(pid, docId);
  res.redirect("/portfolio/" + pid);
});

app.post("/portfolio/:id/docs/:docId/remove", (req, res) => {
  db().prepare("DELETE FROM project_docs WHERE project_id=? AND doc_id=?").run(Number(req.params.id), Number(req.params.docId));
  res.redirect("/portfolio/" + req.params.id);
});

/* ── 프로필(이력서) ──────────────────────────── */
app.get("/profile", (req, res) => {
  const d = db();
  const items = (kind) =>
    d.prepare("SELECT * FROM profile_items WHERE kind=? ORDER BY sort_order, COALESCE(period_start,'') DESC").all(kind);
  res.render("profile", {
    title: "프로필",
    me: basic(),
    education: items("학력"),
    career: items("경력"),
    certs: items("자격"),
    languages: items("어학"),
    awards: d.prepare("SELECT * FROM projects WHERE category='수상내역' ORDER BY COALESCE(period_start,'0') DESC").all(),
    // 이력서의 '논문·저술' 은 논문과 저서를 함께 싣는다
    papers: d
      .prepare("SELECT * FROM projects WHERE category IN ('논문','저서') ORDER BY COALESCE(period_start,'0') DESC")
      .all(),
    // 특허·실용신안은 기술개발 활동 중 해당 태그가 붙은 것을 모아 보여준다
    patents: d
      .prepare("SELECT * FROM projects WHERE tags LIKE '%특허%' OR tags LIKE '%실용신안%' ORDER BY COALESCE(period_start,'0') DESC")
      .all(),
    photoDoc: d.prepare("SELECT id FROM documents WHERE kind='media' AND file_name LIKE '%프로필%' LIMIT 1").get(),
  });
});

app.get("/profile/edit", (req, res) => {
  const d = db();
  res.render("profile-edit", {
    title: "프로필 편집",
    me: basic(),
    kinds: PROFILE_KINDS,
    items: d.prepare("SELECT * FROM profile_items ORDER BY kind, sort_order, COALESCE(period_start,'') DESC").all(),
  });
});

app.post("/profile/basic", (req, res) => {
  const b = req.body;
  db()
    .prepare(
      `INSERT INTO profile_basic (id,name,name_sub,birth,headline,org,position,email,phone,office,address,summary,photo,updated_at)
       VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_sub=excluded.name_sub,birth=excluded.birth,
         headline=excluded.headline,org=excluded.org,position=excluded.position,email=excluded.email,
         phone=excluded.phone,office=excluded.office,address=excluded.address,summary=excluded.summary,
         photo=excluded.photo,updated_at=excluded.updated_at`
    )
    .run(b.name || "", b.name_sub || "", b.birth || "", b.headline || "", b.org || "", b.position || "",
      b.email || "", b.phone || "", b.office || "", b.address || "", b.summary || "", b.photo || "", nowISO());
  res.redirect("/profile/edit");
});

app.post("/profile/item", (req, res) => {
  const b = req.body;
  if (b.id) {
    db()
      .prepare("UPDATE profile_items SET kind=?,title=?,org=?,period_start=?,period_end=?,description=?,sort_order=?,updated_at=? WHERE id=?")
      .run(b.kind, b.title, b.org || "", b.period_start || "", b.period_end || "", b.description || "",
        Number(b.sort_order || 0), nowISO(), Number(b.id));
  } else {
    db()
      .prepare("INSERT INTO profile_items (kind,title,org,period_start,period_end,description,tags,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(b.kind, b.title, b.org || "", b.period_start || "", b.period_end || "", b.description || "", "",
        Number(b.sort_order || 0), nowISO(), nowISO());
  }
  res.redirect("/profile/edit");
});

app.post("/profile/item/:id/delete", (req, res) => {
  db().prepare("DELETE FROM profile_items WHERE id=?").run(Number(req.params.id));
  res.redirect("/profile/edit");
});

/* ── 기업매칭 ────────────────────────────────── */
const dartStatus = () => {
  const d = db();
  const one = (sql) => { try { return d.prepare(sql).get().c; } catch (_) { return 0; } };
  return {
    hasKey: Boolean((process.env.DART_API_KEY || "").trim()),
    total: one("SELECT COUNT(*) c FROM companies"),
    listed: one("SELECT COUNT(*) c FROM companies WHERE stock_code IS NOT NULL AND stock_code != ''"),
    enriched: one("SELECT COUNT(*) c FROM companies WHERE enriched_at IS NOT NULL"),
    withFin: one("SELECT COUNT(DISTINCT corp_code) c FROM company_financials"),
  };
};

app.get("/matching", (req, res) => {
  const d = db();
  const dart = dartStatus();
  const my = comp.myVector();

  const region = req.query.region || "";
  const industry = req.query.industry || "";
  const sort = req.query.sort || "priority";
  const q = (req.query.q || "").trim();

  const where = ["enriched_at IS NOT NULL", "induty_code IS NOT NULL"];
  const args = [];
  if (region) { where.push("region = ?"); args.push(region); }
  if (industry) { where.push("substr(induty_code,1,2) = ?"); args.push(industry); }
  if (q) { where.push("corp_name LIKE ?"); args.push("%" + q + "%"); }

  const rows = dart.enriched
    ? d.prepare(`SELECT corp_code, corp_name, stock_code, corp_cls, region, adres, induty_code, est_dt
                 FROM companies WHERE ${where.join(" AND ")}`).all(...args)
    : [];

  const evaluated = rows.map((r) => comp.evaluate(r, my.score));
  const key = sort === "fit" ? "fit" : sort === "demand" ? "demand" : "priority";
  evaluated.sort((a, b) => b[key] - a[key] || a.corp_name.localeCompare(b.corp_name, "ko"));

  const regions = d
    .prepare("SELECT region k, COUNT(*) c FROM companies WHERE enriched_at IS NOT NULL AND region != '' GROUP BY region ORDER BY c DESC")
    .all();
  const industries = [...new Map(
    d.prepare("SELECT DISTINCT substr(induty_code,1,2) k FROM companies WHERE enriched_at IS NOT NULL AND induty_code IS NOT NULL").all()
      .map((r) => [r.k, comp.industryOf(r.k).label])
  ).entries()].sort((a, b) => a[1].localeCompare(b[1], "ko"));

  res.render("matching", {
    title: "기업매칭",
    dart, my,
    axes: comp.AXES, meta: comp.AXIS_META,
    rows: evaluated.slice(0, 60),
    total: evaluated.length,
    regions, industries,
    sel: { region, industry, sort, q },
    cover: coverage(),
  });
});

/*
 * 업종 요구 프로필 편집.
 * ':corp_code' 라우트보다 먼저 등록해야 'weights' 가 기업코드로 해석되지 않는다.
 */
app.get("/matching/weights", (req, res) => {
  const list = comp.industryList();
  res.render("weights", {
    title: "업종 요구 프로필",
    axes: comp.AXES,
    meta: comp.AXIS_META,
    rows: list.rows,
    fallback: list.fallback,
    saved: req.query.saved ? Number(req.query.saved) : null,
  });
});

app.post("/matching/weights", (req, res) => {
  const changed = comp.saveWeights(req.body.w || {});
  res.redirect("/matching/weights?saved=" + changed);
});

app.get("/matching/:corp_code", (req, res) => {
  const d = db();
  const co = d.prepare("SELECT * FROM companies WHERE corp_code = ?").get(req.params.corp_code);
  if (!co) return res.status(404).send("없는 기업");
  const my = comp.myVector();
  const ev = comp.evaluate(co, my.score);
  const fin = stats.companyFinance(co.corp_code);
  const finNote = fin ? null : stats.financeAbsence(co);
  res.render("match-detail", {
    title: co.corp_name,
    co, ev, my,
    axes: comp.AXES, meta: comp.AXIS_META,
    tips: comp.tipsFor(ev.gaps),
    fin,
    finNote,
  });
});

/* ── 자기소개서 ──────────────────────────────── */
app.get("/cover", (req, res) => {
  const rows = db()
    .prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM cover_sections s WHERE s.letter_id=l.id AND s.status='ok') AS done
       FROM cover_letters l ORDER BY l.updated_at DESC`
    )
    .all();
  res.render("cover", {
    title: "자기소개서",
    rows,
    sections: cover.SECTIONS,
    hasKey: gemini.enabled(),
    companies: db()
      .prepare("SELECT corp_code, corp_name FROM companies WHERE enriched_at IS NOT NULL ORDER BY corp_name LIMIT 4000")
      .all(),
  });
});

/* 기업매칭에서 넘어오는 생성 진입점 */
app.post("/cover/new", async (req, res) => {
  const d = db();
  const code = (req.body.corp_code || "").trim();
  let corp_name = (req.body.corp_name || "").trim();
  let industry = "";
  if (code) {
    const co = d.prepare("SELECT * FROM companies WHERE corp_code=?").get(code);
    if (co) {
      corp_name = co.corp_name;
      industry = comp.industryOf(co.induty_code).label;
    }
  }
  const id = cover.createLetter({ corp_code: code || null, corp_name, industry, job_title: req.body.job_title || "" });
  try {
    await cover.generateAll(id);
  } catch (_) {
    /* 개별 항목의 실패는 각 섹션에 기록된다 */
  }
  res.redirect("/cover/" + id);
});

app.get("/cover/:id", (req, res) => {
  const letter = cover.getLetter(Number(req.params.id));
  if (!letter) return res.status(404).send("자기소개서를 찾을 수 없습니다");
  res.render("cover-detail", { title: "자기소개서", letter, hasKey: gemini.enabled() });
});

/* 항목별 추가정보 저장 + 재생성 */
app.post("/cover/:id/section/:key", async (req, res) => {
  const id = Number(req.params.id);
  const key = req.params.key;
  const d = db();
  d.prepare(
    `INSERT INTO cover_sections (letter_id, section_key, content, extra_info, status, generated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(letter_id, section_key) DO UPDATE SET extra_info=excluded.extra_info`
  ).run(id, key, "", req.body.extra_info || "", null, new Date().toISOString());

  if (req.body.action === "regenerate") {
    try { await cover.generateSection(id, key); } catch (_) {}
  } else if (req.body.action === "save_content") {
    d.prepare("UPDATE cover_sections SET content=?, status='ok' WHERE letter_id=? AND section_key=?")
      .run(req.body.content || "", id, key);
  }
  res.redirect("/cover/" + id + "#" + key);
});

app.post("/cover/:id/regenerate", async (req, res) => {
  try { await cover.generateAll(Number(req.params.id)); } catch (_) {}
  res.redirect("/cover/" + req.params.id);
});

app.post("/cover/:id/meta", (req, res) => {
  db().prepare("UPDATE cover_letters SET job_title=?, updated_at=? WHERE id=?")
    .run(req.body.job_title || "", new Date().toISOString(), Number(req.params.id));
  res.redirect("/cover/" + req.params.id);
});

app.post("/cover/:id/delete", (req, res) => {
  db().prepare("DELETE FROM cover_letters WHERE id=?").run(Number(req.params.id));
  res.redirect("/cover");
});

/* ── 간단 API ────────────────────────────────── */
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ q, hits: [] });
  const hits = await hybridSearch(q, { limit: Number(req.query.limit || 10) });
  res.json({
    q,
    hits: hits.map((h) => ({
      doc_id: h.doc_id, title: h.title, doc_type: h.doc_type, year: h.year,
      rel_path: h.rel_path, excerpt: h.text.slice(0, 400),
    })),
  });
});

app.post("/api/ask", async (req, res) => {
  const q = (req.body.question || req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "question 이 필요합니다" });
  res.json(await ask(q, { limit: Number(req.body.limit || 8) }));
});

/* 포트폴리오 전체를 JSON 으로 — 기업매칭 설계 때 입력으로 쓴다 */
app.get("/api/portfolio", (req, res) => {
  const d = db();
  res.json({
    profile: basic(),
    education: d.prepare("SELECT kind,title,org,period_start,period_end,description FROM profile_items WHERE kind='학력' ORDER BY sort_order").all(),
    career: d.prepare("SELECT kind,title,org,period_start,period_end,description FROM profile_items WHERE kind='경력' ORDER BY sort_order").all(),
    certs: d.prepare("SELECT kind,title,org,period_start,description FROM profile_items WHERE kind='자격' ORDER BY sort_order").all(),
    activities: d.prepare("SELECT category,title,org,role,period_start,period_end,summary,outcomes,tags FROM projects ORDER BY category, COALESCE(period_start,'0') DESC").all(),
    coverage: coverage(),
  });
});

/* 예전 경로 호환 */
app.get("/projects", (req, res) => res.redirect("/portfolio"));
app.get("/projects/:id", (req, res) => res.redirect("/portfolio/" + req.params.id));

app.use((req, res) => res.status(404).render("404", { title: "없는 페이지" }));

app.listen(PORT, () => {
  const ov = stats.overview();
  console.log(`포트폴리오 DB → http://localhost:${PORT}`);
  console.log(`문서 ${ov.docs} / 청크 ${ov.chunks} / 활동 ${ov.projects} / 답변생성 ${gemini.enabled() ? "켜짐" : "꺼짐(키 없음)"}`);
});
