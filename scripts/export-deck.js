"use strict";
/*
 * NotebookLM 등 외부 도구에 올릴 소스 문서를 만든다.
 *
 * DB 에 흩어져 있는 프로필·활동을 사람이 읽는 순서대로 한 파일에 펼친다.
 * 생성물은 deck/ 아래에 쌓이며 저장소에는 올리지 않는다(.gitignore).
 *
 * 연락처는 기본적으로 빼둔다. 슬라이드 대본을 쓰는 데 생년월일·주소·전화번호가
 * 필요하지 않은데, 외부 서비스에 올리는 파일이라 한 번 나가면 회수할 수 없다.
 * 정말 넣어야 한다면 --with-contact 를 준다.
 *
 *   node scripts/export-deck.js                 프로필 + 활동
 *   node scripts/export-deck.js --with-docs     원본 문서 본문까지
 *   node scripts/export-deck.js --with-contact  연락처 포함
 */
const fs = require("fs");
const path = require("path");
const { ROOT } = require("../src/config");
const { db } = require("../src/db");
const { CATEGORIES } = require("../src/portfolio");

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const WITH_DOCS = has("--with-docs");
const WITH_CONTACT = has("--with-contact");

const OUT_DIR = path.join(ROOT, "deck");

/* 기간: 시작만 있으면 시작만, 둘 다 있으면 범위로. */
function period(a, b) {
  if (!a && !b) return "";
  if (a && b && a !== b) return `${a} ~ ${b}`;
  return a || b;
}

function line(label, value) {
  return value ? `- **${label}**: ${value}\n` : "";
}

function profileSection(d) {
  const me = d.prepare("SELECT * FROM profile_basic WHERE id = 1").get() || {};
  let s = `# ${me.name || "이름 미등록"} 프로필\n\n`;
  if (me.headline) s += `> ${me.headline}\n\n`;

  s += "## 인적 개요\n\n";
  s += line("소속", [me.org, me.position].filter(Boolean).join(" · "));
  if (me.name_sub) s += line("한자", me.name_sub);
  if (WITH_CONTACT) {
    s += line("생년월일", me.birth);
    s += line("휴대전화", me.phone);
    s += line("이메일", me.email);
    s += line("주소", me.address);
  }
  s += "\n";

  if (me.summary) {
    s += "## 핵심 역량\n\n";
    for (const l of me.summary.split("\n").filter(Boolean)) s += `- ${l}\n`;
    s += "\n";
  }
  return s;
}

/* 경력·학력·자격·어학. 이력서에 쓰는 순서를 그대로 따른다. */
function itemsSection(d) {
  const KINDS = [
    ["경력", "경력"],
    ["학력", "학력"],
    ["자격", "자격 및 면허"],
    ["어학", "어학"],
  ];
  const rows = d
    .prepare("SELECT * FROM profile_items ORDER BY kind, COALESCE(period_start,'0') DESC")
    .all();

  let s = "";
  for (const [kind, heading] of KINDS) {
    const list = rows.filter((r) => r.kind === kind);
    if (!list.length) continue;
    s += `## ${heading}\n\n`;
    for (const r of list) {
      const when = period(r.period_start, r.period_end);
      s += `- ${when ? `(${when}) ` : ""}**${r.title}**`;
      // 경력 제목은 "직책 · 기관" 꼴이라 기관명이 이미 들어 있는 경우가 많다
      if (r.org && r.org !== "-" && !r.title.includes(r.org)) s += ` — ${r.org}`;
      if (r.description) s += `\n  - ${r.description}`;
      s += "\n";
    }
    s += "\n";
  }
  return s;
}

/* 활동 80건. 분야별로 묶고 그 안에서는 최근 순으로 둔다. */
function projectsSection(d) {
  const rows = d
    .prepare("SELECT * FROM projects ORDER BY COALESCE(period_start,'0') DESC")
    .all();

  let s = `## 활동 상세 (총 ${rows.length}건)\n\n`;
  for (const cat of CATEGORIES) {
    const list = rows.filter((r) => r.category === cat);
    if (!list.length) continue;
    s += `### ${cat} (${list.length}건)\n\n`;
    for (const r of list) {
      const when = period(r.period_start, r.period_end);
      s += `#### ${r.title}\n\n`;
      s += line("기간", when);
      s += line("기관", r.org);
      s += line("역할", r.role);
      if (r.summary) s += line("내용", r.summary);
      if (r.outcomes) {
        s += "- **성과**:\n";
        for (const o of r.outcomes.split(" / ").filter(Boolean)) s += `  - ${o}\n`;
      }
      if (r.tags) s += line("키워드", r.tags.split(",").join(", "));
      s += "\n";
    }
  }
  return s;
}

/*
 * 원본 본문에는 이력서에 적어둔 연락처가 그대로 들어 있다.
 * 구조화 섹션에서 뺐더라도 여기로 새면 의미가 없으므로 같은 기준으로 가린다.
 * 임의의 숫자를 지우지 않도록 profile_basic 에 적힌 실제 값만 골라서 바꾼다.
 */
function scrubContact(text, me) {
  const targets = [me.phone, me.office, me.email, me.address, me.birth].filter(Boolean);
  let out = text;
  for (const raw of targets) {
    const v = String(raw).trim();
    if (v.length < 4) continue;
    const forms = new Set([v]);
    if (/[\d-]/.test(v)) {
      forms.add(v.replace(/-/g, ""));          // 01012345678
      forms.add(v.replace(/-/g, " "));         // 010 1234 5678
      forms.add(v.replace(/-/g, "."));         // 010.1234.5678
    }
    for (const f of forms) {
      out = out.split(f).join("●●●");
    }
  }
  return out;
}

/* 원본 문서 본문. 자기소개서처럼 구어체 대본의 재료가 되는 글이 들어 있다. */
function docsSection(d) {
  const rows = d
    .prepare(
      `SELECT dc.title, dc.file_name, t.text
         FROM documents dc JOIN doc_text t ON t.doc_id = dc.id
        WHERE dc.kind = 'text' AND dc.status = 'ok'
        ORDER BY dc.file_name`
    )
    .all();
  if (!rows.length) return "";

  const me = d.prepare("SELECT * FROM profile_basic WHERE id = 1").get() || {};

  let s = `# 원본 자료 본문 (${rows.length}건)\n\n`;
  s += "주민등록번호·여권번호는 수집 단계에서 이미 가려진 상태다.\n";
  if (!WITH_CONTACT) s += "연락처는 ●●● 로 가렸다.\n";
  s += "\n";
  for (const r of rows) {
    const body = WITH_CONTACT ? r.text : scrubContact(r.text, me);
    s += `## ${r.title}\n\n\`\`\`\n${body.trim()}\n\`\`\`\n\n`;
  }
  return s;
}

function main() {
  const d = db();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = [];
  const put = (name, body) => {
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, body, "utf8");
    written.push([name, body.length]);
  };

  put(
    "01_프로필_활동.md",
    profileSection(d) + itemsSection(d) + projectsSection(d)
  );
  if (WITH_DOCS) {
    const body = docsSection(d);
    if (body) put("02_원본자료.md", body);
  }

  console.log(`\n내보냄 → ${path.relative(ROOT, OUT_DIR)}/`);
  for (const [name, n] of written) {
    console.log(`  ${name.padEnd(22)} ${n.toLocaleString()}자`);
  }
  if (!WITH_CONTACT) {
    console.log("\n연락처(생년월일·주소·전화·이메일)는 제외했습니다. 넣으려면 --with-contact");
  }
  if (!WITH_DOCS) {
    console.log("원본 문서 본문은 제외했습니다. 넣으려면 --with-docs");
  }
}

main();
