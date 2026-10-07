# 포트폴리오 RAG 시스템 — 수업 실습용

내 자료를 모아 **검색하고, 근거를 확인하고, 이력서·자기소개서·발표자료로 정리하는** 웹 애플리케이션입니다.
RAG(검색증강생성)가 실제 제품에서 어떤 모습인지 한 덩어리로 보라고 만든 실습 과제입니다.

예시 데이터가 들어 있어 **받자마자 돌려볼 수 있고**, 그다음 본인 자료로 바꿔 나갑니다.

### 이 문서를 읽는 법

| 지금 상황 | 가는 곳 |
| --- | --- |
| 처음 받았다 | [1장](#1-5분-만에-띄우기) → [2장](#2-무엇을-보게-되는가) |
| 코드를 뜯어보고 싶다 | [3장](#3-전체-구조) → [4장](#4-읽어볼-만한-코드) |
| 내 자료로 바꾸고 싶다 | [6장](#6-내-자료로-바꾸기) |
| 발표자료를 만들어야 한다 | [9장](#9-슬라이드-덱-만들기--노트북lm) |
| 인터넷에 올리고 싶다 | [10장](#10-배포하기--render) |
| **에러가 났다 / 안 된다** | **[11장 문제 해결](#11-막혔을-때--문제-해결)** |
| 명령어만 보고 싶다 | [12장](#12-명령어-정리) |

> **명령어는 한 줄씩 실행하세요.** 이 문서의 코드블록은 한 칸에 한 줄씩 넣어두었습니다.
> Windows PowerShell 에서는 `&&` 가, 명령 프롬프트(cmd)에서는 `;` 가 동작하지 않습니다.
> 여러 줄을 한 번에 붙여넣다 실패하는 일이 가장 흔한 사고입니다.

---

## 1. 5분 만에 띄우기

필요한 것은 **Node.js 22.5 이상**뿐입니다. 데이터베이스 서버도, 도커도 필요 없습니다.

버전부터 확인합니다.

```bash
node -v
```

`v22.5.0` 보다 낮으면 먼저 Node 를 올리세요. 이 프로젝트는 Node 에 내장된 `node:sqlite` 를 쓰는데,
그 이전 버전에는 없는 기능입니다.

```bash
npm install
```

```bash
npm run seed
```

```bash
npm run index:activities
```

```bash
npm start
```

브라우저에서 `http://localhost:4300` 을 엽니다. 가상 인물 '김하늘'의 프로필로 화면이 채워져 있습니다.

> **API 키가 없어도 동작합니다.** 키워드 검색·포트폴리오·이력서는 그대로 쓸 수 있고,
> 의미검색과 AI 답변 생성만 꺼집니다. 키를 넣는 방법은 [7장](#7-ai-기능-켜기-선택)에 있습니다.

---

## 2. 무엇을 보게 되는가

| 메뉴 | 하는 일 |
| --- | --- |
| 대시보드 | 수집 현황, 연도별 활동 분포 차트 |
| 포트폴리오 | 활동을 7개 분야로 나눠 연도 역순 타임라인으로 |
| 프로필 | 이력서 형식 페이지 (인쇄·PDF 저장 가능) |
| 기업매칭 | 내 역량을 업종별 요구와 비교, 방사형 그래프와 보완점 |
| 검색 / 질의응답 | 자료 전문검색, 근거를 붙인 답변 |
| 자기소개서 | 5개 항목 자동 작성, 항목별 추가정보로 재생성 |

우측 상단 아이콘으로 다크/라이트 모드를 바꿀 수 있습니다.

---

## 3. 전체 구조

```
원본 파일            텍스트 추출          청크 분할           저장
(pdf/hwp/docx   →   형식별 파서    →    약 900자,     →    SQLite 한 파일
 pptx/xlsx)                             150자 겹침         ├ documents  문서 메타
                                                           ├ chunks     검색 단위
                                                           ├ chunks_fts 전문검색(FTS5)
                                                           └ embeddings 벡터(선택)
                                                                  │
질문  →  키워드(BM25) + 의미(코사인)  →  RRF 순위융합  →  근거 청크
                                                                  │
                                            질문 + 근거  →  LLM  →  답변 [1][2]
```

### 왜 이렇게 나눴는가

**추출과 검색을 분리한 이유** — 파일에서 글자를 꺼내는 일(`src/extract/`)과 찾는 일(`src/search.js`)은
바뀌는 속도가 다릅니다. 새 파일 형식은 추출기만 늘리면 되고, 검색 방식을 바꿔도 추출은 건드리지 않습니다.

**청크로 쪼개는 이유** — 임베딩은 "이 덩어리가 무슨 뜻인가"를 숫자로 바꿉니다.
글자 하나에는 의미가 없고 문맥이 있어야 뜻이 생기므로, 문단 단위로 묶어 벡터화합니다.
문장이 경계에서 잘리지 않도록 앞뒤를 150자씩 겹칩니다. → `src/chunk.js`

**키워드와 의미를 섞는 이유** — 둘은 서로 다른 것을 잘합니다.

| 질의 | 키워드 | 의미검색 |
| --- | --- | --- |
| "ESG인증심사원" (정확한 명칭) | 강함 | 보통 |
| "해외에서 일한 경험" (표현이 다름) | **0건** | 찾아냄 |

그래서 둘의 순위를 RRF로 합칩니다. → `src/search.js`

---

## 4. 읽어볼 만한 코드

처음 본다면 이 순서를 권합니다.

| 파일 | 무엇을 배우나 |
| --- | --- |
| `src/db.js` | 스키마 한눈에 보기. 테이블이 왜 이렇게 나뉘었는지 |
| `src/chunk.js` | 문단 경계를 지키며 자르기, 겹침 처리 |
| `src/search.js` | 한국어 검색의 실제 문제들 — 조사, 2글자 단어, 불용어 |
| `src/rag.js` | 근거를 모아 프롬프트를 만들고 출처를 붙이는 방법 |
| `src/competency.js` | 점수 설계. 정규화를 잘못하면 왜 전부 100점이 되는가 |
| `src/extract/hwp.js` | HWP 바이너리를 직접 파싱 (OLE 컨테이너 + 레코드) |
| `src/redact.js` | 무엇을 가리고 무엇을 남길지 정하는 기준 |

### 한국어 검색에서 겪은 문제

`src/search.js` 주석에 과정이 남아 있습니다.

1. **조사** — `창업생태계와` 로 검색하면 본문의 `창업생태계` 를 못 찾습니다. 조사를 떼어 함께 질의합니다.
2. **2글자 단어** — FTS5 trigram 색인은 3글자부터라 `축산`, `악취` 가 안 잡힙니다. 이들만 LIKE로 따로 찾아 합칩니다.
3. **질문투** — "~에 대해 알려줘" 같은 말이 AND 조건에 끼면 결과가 0건이 됩니다. 불용어로 거릅니다.

### 점수 설계에서 겪은 문제

`src/competency.js` 는 6개 역량 축을 0~100으로 매깁니다.
처음에는 절대 기준을 뒀는데 **모든 축이 100점으로 포화**됐습니다. 본인 기록만으로 계산하는 구조라
기준치를 넘기기 쉬웠던 것입니다. 지금은 **가장 두꺼운 축을 100으로 두는 상대 강도**로 바꿨습니다.

적합도도 마찬가지였습니다. 단순 가중평균으로 줄을 세우니 **요구 수준이 낮은 업종이 1위**로 올라왔습니다.
기준이 낮으니 잘 맞는 게 당연한데, 목표를 고르는 데는 쓸모가 없었습니다.
그래서 요구 수준을 따로 계산해 "눈높이가 높은데도 내가 맞는" 쪽이 위로 오게 했습니다.

---

## 5. 프로필 여러 개 두기

`data/` 안의 `.db` 파일 하나가 프로필 하나입니다. 두 개 이상이면 **우측 상단에 선택기**가 나타나
화면에서 오갈 수 있습니다.

예시는 그대로 두고 내 프로필을 따로 만들려면 — PowerShell:

```bash
$env:DB_PATH="data/mine.db"
```

명령 프롬프트(cmd):

```bash
set DB_PATH=data/mine.db
```

macOS·Linux:

```bash
export DB_PATH=data/mine.db
```

그다음 평소대로:

```bash
npm run seed
```

이렇게 하면 `portfolio.db`(예시)와 `mine.db`(내 것)를 비교하며 작업할 수 있습니다.
선택은 `data/current.txt` 에 남아 서버를 다시 띄워도 유지됩니다.

> 프로필을 바꾸면 임베딩 행렬 같은 메모리 캐시도 함께 비워집니다.
> `src/db.js` 의 `switchTo()` 와 `onSwitch()` 가 그 일을 합니다 — 캐시가 있는 시스템에서
> 데이터 출처가 바뀔 때 무엇을 신경 써야 하는지 보여주는 예입니다.

---

## 6. 내 자료로 바꾸기

### 6-1. 프로필 입력

두 가지 방법이 있습니다.

**화면에서 입력** — 프로필 › 내용 편집, 포트폴리오 › 활동 추가. 바로 반영됩니다.

**코드로 입력** — `scripts/seed-sample.js` 를 열어 `BASIC`, `EDUCATION`, `CAREER`,
`CERTS`, `ACTIVITIES` 를 본인 내용으로 고친 뒤:

```bash
npm run seed -- --reset
```

```bash
npm run index:activities
```

### 6-2. 원본 자료 넣기

`myprofile/` 폴더에 이력서·자기소개서·수상 증빙 등을 넣습니다.
pdf · hwp · hwpx · docx · pptx · xlsx · txt 를 읽습니다.

```bash
npm run ingest
```

변경된 파일만 처리합니다. 전부 다시 읽히려면 `npm run ingest -- --force` 를 줍니다.

> **이 폴더는 저장소에 올라가지 않습니다**(`.gitignore`). 개인정보가 들어가기 때문입니다.
> 과제를 제출할 때도 코드만 올라갑니다.

### 6-3. 활동사진 배너

`myprofile/photos/` 에 사진을 넣으면 프로필 맨 위에 롤링 배너가 생깁니다.
한 장이 5초 머물고 1.2초에 걸쳐 다음 장으로 넘어가며, 머무는 동안 천천히 확대·이동합니다(켄번스).

```bash
npm run ingest
```

사진이 한 장도 없으면 배너는 아예 그려지지 않습니다. 넣고 싶지 않다면 폴더를 비워두면 됩니다.

파일명이 그대로 화면의 사진 설명이 됩니다. 앞에 `01_`, `02_` 처럼 번호를 붙이면
그 순서로 돌고 번호는 설명에서 빠지므로, `01_창업경진대회_발표_2024.jpg` 처럼 지어두면 좋습니다.

**비율이 달라도 잘리지 않습니다.** 가로로 긴 사진과 세로로 긴 사진이 섞이는 게 보통인데,
틀에 꽉 채우면(`object-fit: cover`) 세로 사진은 가운데 띠만 남고 얼굴이 잘립니다.
그래서 원본은 전부 보이게 두고(`contain`), 같은 사진을 크게 흐려 뒤에 깔아 여백을 메웁니다.
코드는 `views/partials/banner.ejs` 와 `public/css/pages.css` 의 배너 블록입니다.

> 사진도 `myprofile/` 안에 있으므로 저장소에는 올라가지 않습니다.
> 대신 이미지 바이트가 DB 에 담겨서, 배포한 화면에서도 그대로 보입니다(한 장 4MB 까지).
>
> **다른 사람 얼굴이 나온 단체사진은 넣기 전에 한 번 더 생각하세요.** 본인 자료를 다루는 도구라도
> 사진에 찍힌 사람은 본인이 아닙니다. 당사자 동의 없이 올릴 사진인지는 따로 판단할 문제입니다.

### 6-4. 민감정보 자동 마스킹

경력증명서 같은 증빙에는 주민등록번호가 그대로 있는 경우가 많습니다.
`src/redact.js` 가 **DB에 저장하기 전에** 주민등록번호·여권번호를 가립니다. 원본 파일은 건드리지 않습니다.

무엇이 가려졌는지는 `수집상태` 화면에서 확인합니다.

사업자등록번호나 자격증 등록번호는 이력서에 필요한 값이라 가리지 않습니다.
**무엇을 가리고 무엇을 남길지 정하는 것도 설계의 일부**입니다.

---

## 7. AI 기능 켜기 (선택)

[Google AI Studio](https://aistudio.google.com/apikey) 에서 무료 키를 받습니다.

```bash
cp .env.example .env
```

`.env` 를 열어 `GEMINI_API_KEY=발급받은키` 를 넣고:

```bash
npm run embed
```

이제 의미검색, 질의응답, 자기소개서 생성이 동작합니다.

> **키는 절대 저장소에 올리지 마세요.** `.env` 는 `.gitignore` 대상입니다.
> `.env.example` 에 실제 키를 적는 실수가 흔하니 주의하세요. 거기에 적으면 그대로 커밋됩니다.

---

## 8. 기업 데이터 (선택)

[OpenDART](https://opendart.fss.or.kr) 에서 무료 인증키를 받으면 공시 기업 정보를 받아올 수 있습니다.
`.env` 에 `DART_API_KEY=발급받은키` 로 넣습니다.

```bash
npm run dart codes
```

```bash
npm run dart enrich -- --listed
```

```bash
npm run dart clean -- --dry-run
```

```bash
npm run dart clean
```

`clean` 은 매칭 대상이 될 수 없는 기업을 뺍니다 — SPAC(합병 전까지 실질 영업 없음)과
구분이 '기타법인'이면서 재무가 한 해도 없는 곳입니다.
**구분이 `E` 라고 전부 지우지는 않습니다.** 상장만 폐지되고 사업보고서는 계속 내는
영업 중인 회사가 같은 구분에 섞여 있어, '재무가 하나도 없을 것' 을 함께 겁니다.
데이터를 지울 때 조건 하나로 뭉뚱그리면 무엇이 함께 날아가는지 보여주는 예입니다.

하루 20,000건 제한이 있고, 한도에 걸리면 멈췄다가 다음 날 이어서 받습니다.
**기업매칭의 업종별 요구 프로필은 추정치**이며 `config/industry-weights.json` 에서 고칠 수 있습니다.

---

## 9. 슬라이드 덱 만들기 — 노트북LM

정리한 프로필을 **발표자료(40장)로** 만드는 과정입니다.
구글 노트북LM(NotebookLM)의 슬라이드 생성 기능을 쓰고, 전체 네 단계입니다.

```
0단계  소스 내보내기   이 저장소      →  마크다운 파일
1단계  디자인 프롬프트  제미나이/클로드 →  영문 800자 이내
2단계  마스터 대본     노트북LM       →  40쪽 대본
3단계  슬라이드 렌더링  노트북LM       →  완성 덱
```

> **핵심을 먼저 말하면** — 노트북LM 은 *업로드된 소스 문서*만 읽습니다.
> 내 프로필은 SQLite DB 안에 있어서 올릴 파일이 없습니다. 그래서 0단계가 필요합니다.

### 0단계. 소스 문서 내보내기

```bash
npm run export:deck
```

`deck/01_프로필_활동.md` 가 생깁니다. 프로필·경력·학력·자격과 활동 전체를
사람이 읽는 순서대로 펼친 파일입니다.

자기소개서처럼 **구어체 문장이 필요한 대본**을 쓰려면 원본 본문까지 함께 내보냅니다.

```bash
npm run export:deck -- --with-docs
```

| 플래그 | 결과 |
| --- | --- |
| (없음) | `01_프로필_활동.md` — 구조화된 프로필·활동 |
| `--with-docs` | `02_원본자료.md` 추가 — 이력서·자기소개서 본문 |
| `--with-contact` | 생년월일·주소·전화·이메일 포함 |

**연락처는 기본적으로 빠집니다.** 노트북LM 에 올린다는 것은 구글 서버로 보낸다는 뜻이고,
한 번 나간 개인정보는 회수할 수 없습니다. 슬라이드 대본에 전화번호는 필요하지 않습니다.
원본 본문 안에 적혀 있는 연락처도 같은 기준으로 `●●●` 로 가립니다.

> `deck/` 폴더는 `.gitignore` 대상입니다. 내보낸 파일이 실수로 커밋되지 않습니다.

### 1단계. 디자인 프롬프트 만들기

덱 전체의 색과 레이아웃 규칙을 **영문 800자 이내**로 압축한 명령문입니다.
참고할 이미지(마음에 드는 슬라이드, 브랜드 화면 등)를 제미나이나 클로드에 올리고 아래를 요청합니다.

<details>
<summary><b>1단계 프롬프트 — 펼쳐서 복사</b></summary>

```
업로드한 [이미지]의 디자인 스타일(전체 콘셉트, 컬러 HEX코드, 톤앤매너, 주요 도형 및
그래픽 특징)을 정밀하게 분석하십시오.

분석한 내용을 바탕으로, NotebookLM의 자동화 시스템 파라미터에 바로 붙여넣을 수 있는
[Adaptive Presentation Design System] 형식의 영문 프롬프트를 작성하여 코드블록에
출력해 주십시오.

[출력 제한 및 필수 지시 조건]
1. 길이 제한: 전체 길이는 공백을 포함하여 800자 이내로 엄격히 제한하십시오.
2. 형식 통제: 모든 이모지와 불필요한 서술어를 배제하고, AI가 명확히 인식할 수 있는
   구조화된 명령어로만 작성하십시오.
3. 단일 모드 강제: 컬러 HEX 코드는 라이트/다크 모드를 절대 혼용하지 마십시오.
   원본 이미지의 지배적인 톤에 맞춰 단 1개의 배경색(BG), 1개의 텍스트색(Text),
   1개의 포인트 컬러(Accent)로만 단일화하여 확정하십시오.

[반드시 다음 구조를 따르십시오]
1. Visual Identity: 테마 명칭, 단일 고대비 Hex 코드(BG/Text/Accent),
   핵심 그래픽 요소 및 여백 활용법.
2. Dynamic Layout Rules:
   - Type A (Impact/Title): 대형 타이포그래피 중심의 시선 집중형
   - Type B (Content/Body): 가독성과 정보 위계를 강조한 본문형
   - Type C (Data/Metrics): 차트·지표 강조형
   - Type D (Structure/Diagram): 프로세스·비교 등 분할 화면형
3. Execution: 메인 JSON 시스템이 통제하는 '슬라이드 개수와 콘텐츠 경계'를 엄격히
   준수할 것. 개별 슬라이드의 논리적 섹션에 맞춰 Type A~D 중 가장 대비와 시각적
   위계가 높은 레이아웃을 배정할 것.
```

</details>

**올릴 이미지가 마땅치 않다면** 이 앱의 화면을 그대로 쓰면 됩니다.
프로필 페이지를 캡처해 올리거나, 아래 값을 직접 넣어도 됩니다 — `public/css/app.css` 의 실제 토큰입니다.

| 모드 | BG | Text | Accent |
| --- | --- | --- | --- |
| 다크 | `#0F1420` | `#E8ECF4` | `#D9A441` |
| 라이트 | `#F6F9FC` | `#0E1621` | `#E35D05` |

밝은 강의실에서 빔프로젝터로 쏜다면 **라이트** 쪽이 안전합니다.

**이 단계의 확인 지점**

- 결과가 800자를 넘지 않았는가 (넘으면 "800자로 줄여줘"라고 다시 요청)
- 색이 3개로 확정되었는가 (라이트/다크가 섞여 나오면 다시 요청)
- 이모지가 없는가

### 2단계. 마스터 대본 뽑기

노트북LM 에 새 노트북을 만들고 **0단계에서 만든 `.md` 파일을 소스로 업로드**합니다.
그다음 아래를 입력합니다. **꺾쇠 두 곳을 반드시 본인 상황으로 채우세요.**

<details>
<summary><b>2단계 프롬프트 — 펼쳐서 복사</b></summary>

```
# Role: Chief Content Architect
Task: Analyze ALL uploaded sources and generate a consistent 40-page [Master Script Report].

## [Variables: Please Fill Below]
- Target Audience: <<<여기에 타겟을 입력하세요>>>
- Presentation Objective: <<<발표 목적을 입력하세요>>>

## Instruction Guidelines
1. 업로드된 모든 소스 문서의 핵심 팩트와 데이터를 통합하여 논리적 흐름(서론-본론-결론)을
   구축하라.
2. 지정된 [Target Audience]의 수준과 관심사에 맞춘 전문적인 용어와 설득력 있는 문체를
   사용하라.

## Output Format (Strictly Follow)
슬라이드 번호: (1~40)
제목: (해당 페이지의 핵심 헤드라인)
화면 텍스트: (핵심 데이터 및 키워드 3~4줄 요약)
상세 대본: (발표자가 읽을 구어체 설명 3~5줄)
```

</details>

**이 두 변수가 덱 전체를 결정합니다.** 같은 자료로도 완전히 다른 덱이 나옵니다.

| Target Audience | Presentation Objective | 앞으로 나오는 내용 |
| --- | --- | --- |
| 투자심사역 | 투자 유치 | 창업활동·성과 수치·시장 |
| 채용 담당자 | 입사 지원 | 경력·직무 역량·프로젝트 |
| 대학생 | 특강 | 성장 과정·실패 경험·조언 |
| 심사위원 | 사업 제안 | 정책연구·공공 경력·실행력 |

**이 단계의 확인 지점**

- 40개가 다 나왔는가 (중간에 끊기면 "41번부터 이어서"가 아니라 "21~40번을 다시"로 요청)
- 네 줄 형식(번호/제목/화면 텍스트/상세 대본)이 지켜졌는가
- **지어낸 내용이 없는가** — 소스에 없는 수상이나 숫자가 섞이는 일이 있습니다. 반드시 눈으로 확인하세요

### 3단계. 슬라이드 렌더링

2단계 대본을 실제 슬라이드로 그리는 단계입니다. **A안을 먼저 시도하고, 안 되면 B안으로 갑니다.**

`<<< >>>` 자리에 **1단계에서 만든 영문 디자인 프롬프트**를 그대로 붙여넣습니다.

<details>
<summary><b>A안 — 한 번에 40장 (먼저 시도)</b></summary>

```
[SYSTEM KERNEL OVERRIDE]
Role: API Execution Terminal
Task: Execute the following algorithmic sequence STRICTLY. Do not summarize, do not
combine, do not output conversational text.

## [Global Design System]
<<< 1단계 영문 디자인 프롬프트를 붙여넣으세요 >>>

## EXECUTION_SCRIPT_RUN()
WARNING: Merging 40 slides into a single API call causes a FATAL_MEMORY_CRASH. You MUST
execute the two functions below sequentially and independently.

FUNCTION_01_CALL_STUDIO() {
  target_data: "Source Script Slides 1 to 20"
  deck_type: "presentation"
  length: "dynamic"
  user_steering_prompt: "
    1. Apply [Global Design System] exactly.
    2. Match Source content 1:1.
    3. RULE: DO NOT generate any ending/thank you slide at slide 20. End with body content.
  "
}

// WAIT FOR FUNCTION_01 TO INITIATE, THEN IMMEDIATELY EXECUTE FUNCTION_02

FUNCTION_02_CALL_STUDIO() {
  target_data: "Source Script Slides 21 to 40"
  deck_type: "presentation"
  length: "dynamic"
  user_steering_prompt: "
    1. Apply [Global Design System] exactly.
    2. Match Source content 1:1.
    3. RULE: DO NOT generate a cover or title slide. Start immediately with slide 21 body
       content. Place the ONLY ending slide at slide 40.
  "
}
```

</details>

노트북LM 업데이트에 따라 **A안으로는 한 번에 두 덱이 안 만들어지는 경우가 있습니다.**
20장만 나오고 멈추면 B안으로 나눠 넣습니다.

<details>
<summary><b>B안 1/2 — 전반부 (첫 번째 입력)</b></summary>

```
[SYSTEM KERNEL OVERRIDE]
Role: API Execution Terminal
Task: Execute the following presentation rendering sequence STRICTLY. Do not summarize,
do not combine, do not output conversational text.

## [Global Design System]
<<< 1단계 영문 디자인 프롬프트를 붙여넣으세요 >>>

## EXECUTION_SCRIPT_RUN()
WARNING: Merging 40 presentation slides into a single API call causes a
FATAL_MEMORY_CRASH. You MUST isolate and execute FUNCTION_01 first.

FUNCTION_01_CALL_STUDIO() {
  target_data: "Source Script Slides 1 to 20"
  deck_type: "presentation"
  length: "dynamic"
  user_steering_prompt: "
    1. Apply [Global Design System] exactly to the visual layout.
    2. Match Source content 1:1 without omitting any headline, on-screen text, or
       presenter scripts.
    3. RULE: DO NOT generate any ending/thank you slide at slide 20. End strictly with
       slide 20 body content.
    4. Format: Render immediately as an executable text-based layout template.
  "
}
```

</details>

<details>
<summary><b>B안 2/2 — 후반부 (두 번째 입력)</b></summary>

```
[SYSTEM KERNEL OVERRIDE]
Role: API Execution Terminal
Task: Execute the remaining algorithmic sequence STILL IN THE KERNEL. Do not summarize,
do not combine, do not output conversational text.

## [Global Design System]
<<< 1단계와 동일한 영문 디자인 프롬프트를 붙여넣으세요 >>>

## EXECUTION_SCRIPT_RUN()
WARNING: Continual rendering for slides 21 to 40 is now initiated. Maintain 100% visual
consistency with FUNCTION_01.

FUNCTION_02_CALL_STUDIO() {
  target_data: "Source Script Slides 21 to 40"
  deck_type: "presentation"
  length: "dynamic"
  user_steering_prompt: "
    1. Apply [Global Design System] exactly.
    2. Match Source content 1:1 without any omission or text compression.
    3. RULE: DO NOT generate a cover or title slide. Start immediately with slide 21 body
       content.
    4. PLACE THE ONLY ending/Q&A slide at slide 40.
    5. Format: Complete the 40-slide master deck structure seamlessly.
  "
}
```

</details>

**B안을 쓸 때 꼭 지킬 것**

- **같은 대화창에 이어서** 넣으세요. 새 창에서 넣으면 "Maintain 100% visual consistency with
  FUNCTION_01" 이 가리킬 대상이 없어 앞뒤 디자인이 달라집니다.
- 디자인 프롬프트는 **두 번 다 똑같이** 붙여넣습니다. 생략하면 후반부만 기본 테마로 나옵니다.

### 자주 나는 문제

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| 20장에서 멈춘다 | A안이 두 번째 함수를 실행하지 않음 | B안으로 나눠 입력 |
| 21장에 표지가 또 나온다 | `DO NOT generate a cover` 가 안 먹음 | 그 줄만 다시 강조해 재요청 |
| 앞뒤 디자인이 다르다 | 다른 대화창에서 후반부를 생성 | 같은 창에서 처음부터 다시 |
| 내용이 요약돼 버린다 | 분량이 많아 압축됨 | `without any omission or text compression` 유지 확인 |
| 없는 경력이 나온다 | 모델이 추론으로 채움 | 2단계 대본에서 잡아야 함. 렌더링 후에는 찾기 어려움 |
| 한글이 깨진다 | 글꼴 미지원 | 디자인 프롬프트에 글꼴 지정을 빼고 기본값에 맡김 |

### 완성 후

노트북LM 에서 구글 슬라이드나 PDF 로 내보냅니다.
**숫자와 고유명사는 반드시 눈으로 검수하세요.** 생성형 도구는 그럴듯한 값을 만들어 넣습니다.
0단계에서 내보낸 `deck/01_프로필_활동.md` 가 원본이니 그것과 대조하면 됩니다.

---

## 10. 배포하기 — Render

[Render](https://render.com) 무료 플랜에 올릴 수 있습니다. `render.yaml` 이 들어 있어
**New › Blueprint** 로 저장소를 고르면 설정이 자동으로 채워집니다.

| 환경변수 | 필요성 | 비고 |
| --- | --- | --- |
| `APP_PASSWORD` | **필수** | 직접 입력. 없으면 서비스가 멈춤 |
| `SESSION_SECRET` | 권장 | Render 의 `Generate` 버튼으로 생성 |
| `NODE_ENV` | 권장 | `production` |
| `GEMINI_API_KEY` | 선택 | AI 기능을 쓸 때만 |
| `DART_API_KEY` | **불필요** | 수집은 내 컴퓨터에서만 함 |

**`APP_PASSWORD` 가 없으면 배포본이 503 으로 멈춥니다.** 일부러 그렇게 만들었습니다 —
이 사이트는 생년월일·주소·연락처와 전체 경력을 그대로 보여주는데, 주소만 알면
누구나 열람할 수 있는 상태로 떠 있는 것이 더 위험하기 때문입니다. → `server.js` 의 `LOCKED`

`DART_API_KEY` 는 서버에 넣지 않습니다. OpenDART 호출은 `scripts/dart-sync.js` 에서만 일어나고
서버는 이미 만들어진 DB 를 읽기만 합니다. **키는 적게 퍼뜨릴수록 좋습니다.**

> 무료 플랜은 디스크가 임시입니다. 배포된 화면에서 고친 내용은 재시작하면 사라집니다.
> 영구 보관할 내용은 내 컴퓨터에서 고치고 DB 째 올리는 것이 맞습니다.

---

## 11. 막혔을 때 — 문제 해결

### 설치·실행

**`node:sqlite` 를 찾을 수 없다고 나온다**
Node 버전이 낮습니다. `node -v` 로 확인하고 22.5 이상으로 올리세요.

**`&&` 부근에서 구문 오류가 난다**
PowerShell 은 `&&` 를 지원하지 않습니다. **명령을 한 줄씩 따로 실행하세요.**
반대로 명령 프롬프트(cmd)에서는 `;` 가 동작하지 않습니다.

**포트 4300 이 이미 사용 중이라고 나온다**
이전에 띄운 서버가 남아 있습니다. 해당 프로세스를 끄거나, 다른 포트로 띄웁니다.

```bash
$env:PORT="4301"
```

### 수집(ingest)

**`본문 없음` 으로 남는 PDF 가 있다**
스캔본(이미지로 된 PDF)입니다. 글자가 들어 있지 않아 추출할 것이 없습니다. OCR 은 넣지 않았습니다.

**파일을 넣었는데 수집이 0건이다**
`npm run ingest` 는 **변경된 파일만** 처리합니다. 이미 넣었던 파일이면 건너뜁니다.
전부 다시 읽히려면:

```bash
npm run ingest -- --force
```

**무엇이 걸러졌는지 보고 싶다**

```bash
npm run ingest -- --dry-run
```

### 검색

**검색 결과가 0건이다**
먼저 활동 색인이 되었는지 확인하세요.

```bash
npm run index:activities
```

그래도 안 나오면 `수집상태` 화면에서 문서가 `ok` 인지 봅니다.
2글자 단어는 FTS5 trigram 색인에 안 잡혀 LIKE 로 따로 찾습니다(`src/search.js`).

**임베딩이 0 이다**
`GEMINI_API_KEY` 가 없거나 `npm run embed` 를 아직 안 돌렸습니다.
키 없이도 키워드 검색은 동작하므로, 급하지 않으면 그대로 두어도 됩니다.

**임베딩 중 429 오류가 난다**
무료 키의 분당 한도에 걸린 것입니다. 잠시 뒤 다시 돌리면 **이미 만든 것은 건너뛰고** 이어서 합니다.

### 화면

**프로필 사진이 안 나온다**
이미지는 DB 에 바이트째 담깁니다(`doc_blobs`). 4MB 를 넘으면 담기지 않으니 줄여서 넣으세요.

**활동사진 배너가 안 보인다**
`myprofile/photos/` 가 비어 있으면 배너 자체를 그리지 않습니다. 사진을 넣고 `npm run ingest` 를 돌리세요.

**화면을 고쳤는데 반영이 안 된다**
EJS 템플릿은 서버 재시작이 필요합니다. `npm run dev` 로 띄우면 자동으로 다시 뜹니다.

### 배포

**배포한 사이트가 503 이다**
`APP_PASSWORD` 가 없습니다. [10장](#10-배포하기--render)을 보세요.

**배포본이 옛날 데이터를 보여준다**
SQLite 는 변경분을 WAL 파일에 먼저 씁니다. 체크포인트 없이 `.db` 만 커밋하면 변경이 빠집니다.
`npm run sync` 가 그 순서를 지켜줍니다.

### 데이터

**실수로 키를 커밋했다**
키를 **먼저 폐기하고 새로 발급**하세요. 커밋을 지워도 이미 올라간 값은 유출된 것으로 봐야 합니다.

**예시 데이터를 지우고 처음부터 하고 싶다**

```bash
npm run seed -- --reset
```

---

## 12. 명령어 정리

| 명령 | 하는 일 |
| --- | --- |
| `npm run seed` | 예시(또는 내) 프로필 심기 |
| `npm run ingest` | `myprofile` 폴더 수집 (변경분만) |
| `npm run index:activities` | 활동을 검색 대상에 포함 |
| `npm run embed` | 임베딩 생성 (키 필요) |
| `npm run export:deck` | 슬라이드용 소스 문서를 `deck/` 에 생성 |
| `npm run dart` | 기업 데이터 수집·정리 (키 필요) |
| `npm run stats` | 수집 현황 요약 |
| `npm start` | 서버 실행 |
| `npm run dev` | 서버 실행 (파일 바뀌면 자동 재시작) |
| `npm run sync` | 수집 → 색인 → 임베딩 → 체크포인트 → 커밋·푸시 |

자료를 고쳤을 때의 표준 순서입니다.

```bash
npm run ingest
```

```bash
npm run index:activities
```

```bash
npm run embed
```

---

## 13. 생각해 볼 거리

- 청크를 900자가 아니라 300자로 하면 검색 결과가 어떻게 달라질까? (`src/chunk.js`)
- 키워드와 의미검색의 비중을 바꾸려면 어디를 손대야 할까? (`src/search.js` 의 `fuse`)
- 역량 축을 6개가 아닌 다른 기준으로 짜면? (`src/competency.js` 의 `CATEGORY_AXIS`)
- 자기소개서가 없는 사실을 지어내지 않게 하려면 프롬프트에 무엇을 써야 할까? (`src/cover.js`)
- 내 전공·직무라면 업종별 요구 프로필을 어떻게 다시 매길까? (`config/industry-weights.json`)
- 슬라이드 생성 도구가 지어낸 내용을 **자동으로** 잡아내려면 무엇을 비교해야 할까?

---

## 기술 구성

Node.js (Express + EJS) · SQLite(`node:sqlite` 내장, 네이티브 의존성 없음) ·
FTS5 전문검색 · Gemini 임베딩/생성(선택) · 외부 차트 라이브러리 없이 인라인 SVG
