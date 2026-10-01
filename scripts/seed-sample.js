"use strict";
/*
 * 예시 프로필 심기 — 수업·실습용.
 *
 *   node scripts/seed-sample.js
 *   node scripts/seed-sample.js --reset   # 기존 큐레이션 데이터를 지우고 다시
 *
 * 가상의 인물 '김하늘' 데이터를 넣어 시스템이 바로 돌아가는 상태를 만든다.
 * 화면이 어떻게 생겼는지, 데이터가 어떤 모양이어야 하는지 보고 나서
 * 본인 자료로 바꾸는 순서를 염두에 둔 것이다.
 *
 * 본인 것으로 바꾸는 방법
 *   1) 이 파일을 scripts/seed-profile.js 로 복사한다
 *   2) 아래 BASIC·EDUCATION·CAREER·CERTS·ACTIVITIES 를 본인 내용으로 고친다
 *   3) npm run seed -- --reset 으로 다시 심는다
 *   혹은 화면(프로필 › 내용 편집, 포트폴리오 › 활동 추가)에서 직접 입력해도 된다.
 */
const { db } = require("../src/db");

const RESET = process.argv.includes("--reset");
const now = () => new Date().toISOString();

/* ── 인적사항 ─────────────────────────────────── */
const BASIC = {
  name: "김하늘",
  name_sub: "예시 데이터",
  birth: "1999-04-12",
  headline: "데이터로 문제를 찾고, 코드로 답을 만듭니다",
  org: "한국대학교 컴퓨터공학과",
  position: "4학년 재학",
  email: "sky.kim@example.com",
  phone: "010-0000-0000",
  office: "",
  address: "대전광역시 유성구 (예시)",
  summary: [
    "데이터 분석과 백엔드 개발을 함께 다루며, 문제 정의부터 배포까지 한 흐름으로 경험했습니다.",
    "교내 창업동아리에서 팀을 이끌며 실제 사용자를 받는 서비스를 운영해 보았습니다.",
    "공공데이터를 활용한 분석으로 교내 경진대회에서 수상한 경험이 있습니다.",
  ].join("\n"),
  photo: "",
};

/* ── 학력 ────────────────────────────────────── */
const EDUCATION = [
  ["한국대학교 컴퓨터공학과", "한국대학교", "2019-03", "", "학사 재학 (4학년)"],
  ["한국고등학교", "한국고등학교", "2016-03", "2019-02", "졸업"],
];

/* ── 경력 ────────────────────────────────────── */
const CAREER = [
  ["백엔드 개발 인턴", "㈜예시테크", "2025-07", "2025-08", "주문 API 개선, 응답시간 단축 작업"],
  ["교내 창업동아리 팀장", "한국대학교", "2024-03", "2025-02", "팀 5명 운영, 서비스 기획·개발 총괄"],
];

/* ── 자격 ────────────────────────────────────── */
const CERTS = [
  ["정보처리기사", "한국산업인력공단", "2025-08-20", ""],
  ["SQLD", "한국데이터산업진흥원", "2024-12-06", ""],
  ["컴퓨터활용능력 1급", "대한상공회의소", "2023-05-12", ""],
];

/* ── 어학 ────────────────────────────────────── */
const LANGUAGE = [["영어 (TOEIC)", "ETS", "870점"]];

/*
 * ── 활동(포트폴리오) ──────────────────────────
 * [분류, 제목, 기관, 역할, 시작, 종료, 요약, 성과, 태그]
 * 분류는 기술개발 · 정책연구 · 논문 · 저서 · 창업활동 · 수상내역 · 대외활동
 */
const ACTIVITIES = [
  ["기술개발", "교내 중고거래 웹서비스 개발", "한국대학교 창업동아리", "백엔드 담당", "2024-03", "2024-12",
    "학생 간 중고거래를 중개하는 웹서비스를 기획부터 배포까지 맡았다.",
    "누적 가입 320명 / 월 거래 80건 / 서버 비용 월 1만원 이하로 운영", "웹개발,백엔드,창업동아리"],
  ["기술개발", "공공데이터 기반 버스 혼잡도 예측 모델", "한국대학교", "개발", "2025-03", "2025-06",
    "지자체 공공데이터로 노선별 혼잡도를 예측하는 모델을 만들었다.",
    "예측 정확도 82% / 교내 데이터분석 경진대회 출품", "데이터분석,머신러닝,공공데이터"],
  ["기술개발", "주문 API 응답시간 개선", "㈜예시테크", "인턴", "2025-07", "2025-08",
    "인턴 기간에 느린 조회 API 를 분석해 쿼리와 캐싱을 개선했다.",
    "평균 응답시간 1.8초 → 0.4초", "성능개선,백엔드,인턴"],
  ["창업활동", "교내 창업동아리 팀 운영", "한국대학교", "팀장", "2024-03", "2025-02",
    "5명 팀의 일정과 역할을 나누고 주간 회고를 운영했다.",
    "2개 서비스 출시 / 교내 창업지원금 300만원 선정", "창업,팀운영,리더십"],
  ["수상내역", "교내 데이터분석 경진대회 최우수상", "한국대학교", "", "2025-06-20", "2025-06-20",
    "버스 혼잡도 예측 모델로 수상.", "", "수상,데이터분석"],
  ["수상내역", "창업아이디어 경진대회 장려상", "한국대학교", "", "2024-05-15", "2024-05-15", "", "", "수상,창업"],
  ["대외활동", "오픈소스 컨트리뷰션 아카데미 참여", "정보통신산업진흥원", "참여자", "2025-07", "2025-10",
    "오픈소스 프로젝트에 기여하며 협업 도구와 코드리뷰 문화를 익혔다.",
    "PR 6건 머지", "오픈소스,협업,깃허브"],
  ["대외활동", "교내 신입생 멘토링", "한국대학교", "멘토", "2024-03", "2024-06",
    "신입생 4명을 대상으로 학습 계획과 진로 상담을 진행했다.", "", "멘토링,교육"],
  ["논문", "공공데이터를 활용한 대중교통 혼잡도 예측 연구", "한국대학교 학부생 학술제", "제1저자", "2025-06", "2025-06",
    "학부생 학술제에 발표한 소논문.", "", "데이터분석,학술제"],
];

function main() {
  const d = db();

  if (RESET) {
    d.exec(
      "DELETE FROM project_docs; DELETE FROM projects; DELETE FROM profile_docs; DELETE FROM profile_items; DELETE FROM profile_basic;"
    );
    console.log("기존 큐레이션 데이터 삭제");
  }

  if (!d.prepare("SELECT COUNT(*) c FROM profile_basic").get().c) {
    d.prepare(
      `INSERT INTO profile_basic (id,name,name_sub,birth,headline,org,position,email,phone,office,address,summary,photo,updated_at)
       VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(BASIC.name, BASIC.name_sub, BASIC.birth, BASIC.headline, BASIC.org, BASIC.position,
      BASIC.email, BASIC.phone, BASIC.office, BASIC.address, BASIC.summary, BASIC.photo, now());
    console.log("인적사항 1건");
  }

  const insItem = d.prepare(
    `INSERT INTO profile_items (kind,title,org,period_start,period_end,description,tags,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const hasItem = d.prepare("SELECT COUNT(*) c FROM profile_items WHERE kind=? AND title=?");
  let n = 0;
  const add = (kind, title, org, s, e, desc, i) => {
    if (hasItem.get(kind, title).c) return;
    insItem.run(kind, title, org, s, e, desc, "", i, now(), now());
    n++;
  };
  EDUCATION.forEach(([t, o, s, e, dsc], i) => add("학력", t, o, s, e, dsc, i));
  CAREER.forEach(([t, o, s, e, dsc], i) => add("경력", t + " · " + o, o, s, e, dsc, i));
  CERTS.forEach(([t, o, date, no], i) => add("자격", t, o, date, date, no ? "등록번호 " + no : "", i));
  LANGUAGE.forEach(([t, o, dsc], i) => add("어학", t, o, "", "", dsc, i));
  console.log(`프로필 항목 ${n}건`);

  const insAct = d.prepare(
    `INSERT INTO projects (title,org,role,category,period_start,period_end,summary,outcomes,tags,featured,visibility,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const hasAct = d.prepare("SELECT COUNT(*) c FROM projects WHERE title=?");
  let m = 0;
  for (const [category, title, org, role, s, e, summary, outcomes, tags] of ACTIVITIES) {
    if (hasAct.get(title).c) continue;
    insAct.run(title, org, role, category, s, e, summary, outcomes, tags, 0, "private", now(), now());
    m++;
  }
  console.log(`활동 ${m}건`);
  console.log("\n다음: npm run index:activities && npm start");
}

main();
