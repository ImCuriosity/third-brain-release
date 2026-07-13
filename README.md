<div align="right">

🇰🇷 한국어 | [🇺🇸 English](#english)

</div>

<div align="center">

<img src="assets/sootball.svg" width="96" height="96" alt="Curioso, the ThirdBrain mascot"/>

# ThirdBrain

**노트를 모순 없는 지식 그래프로 바꾸고, 그 그래프로 문제를 푼다.**

</div>

ThirdBrain은 글에서 명제를 추출하고, 논리적으로 유형화된 엣지로 지식 그래프를 구축하며, 모순을 감지하고, 그 그래프 위에서 문제를 푸는 Obsidian 플러그인입니다 — 모두 로컬에서, 원하는 AI 제공자로.

> 마스코트 **Curioso**를 소개합니다. 텍스트를 먹여주면 지식 유기체로 자랍니다.

---

## 목차

1. [1분 요약](#1분-요약)
2. [설치](#설치)
3. [AI 제공자 설정](#ai-제공자-설정)
4. [핵심 개념](#핵심-개념)
5. [화면 구성](#화면-구성)
6. [워크플로우 ① 그래프 생성 (인제스트)](#워크플로우--그래프-생성-인제스트)
7. [워크플로우 ② 뇌 상태](#워크플로우--뇌-상태)
8. [워크플로우 ③ 미션 컨트롤 (폴더 RAG 작업대)](#워크플로우--미션-컨트롤-폴더-rag-작업대)
9. [워크플로우 ④ 폴더 분석](#워크플로우--폴더-분석)
10. [워크플로우 ⑤ 그래프 보기](#워크플로우--그래프-보기)
11. [AI 비용 확인 게이트](#ai-비용-확인-게이트)
12. [저장 구조](#저장-구조)
13. [설정](#설정)
14. [커맨드](#커맨드)
15. [자주 묻는 질문](#자주-묻는-질문)
16. [엔터프라이즈 활용](#엔터프라이즈-활용)
17. [요구 사항 · 라이선스](#요구-사항--라이선스)

---

## 1분 요약

1. 리본의 **Curioso 아이콘**을 눌러 ThirdBrain 패널을 엽니다.
2. 회의록·문서·대화 텍스트를 붙여넣거나 파일을 드롭하고 **`✦ 그래프 추출`** → 명제·엣지·문제로 분해된 그래프가 만들어집니다.
3. **Curioso를 클릭**하면 **뇌 상태**가 열립니다 — 폴더별로 아직 안 끝난 **미션·미연결 명제·모순**을 처리합니다.
4. **`🎯 미션 컨트롤`** 에서 쌓인 그래프를 근거로 삼아 **대화형으로 문제를 풉니다** (모든 답이 `[[노드]]`로 역추적).
5. **`🔍 폴더 분석`** 으로 종합 인사이트를, **`⊕ 그래프 보기`** 로 시각화를 얻습니다.

> AI 작업 전에는 항상 **예상 토큰·비용·시간 확인 창**이 뜹니다 (설정에서 끌 수 있음).

---

## 설치

- **커뮤니티 플러그인(권장)**: Obsidian → 설정 → 커뮤니티 플러그인 → 탐색 → `ThirdBrain` 검색 → 설치·활성화
- **수동**: [릴리즈](https://github.com/ImCuriosity/third-brain-release/releases/latest)에서 `main.js`·`manifest.json`·`styles.css` 다운로드 → `{볼트}/.obsidian/plugins/thirdbrain/`에 복사 → 활성화

---

## AI 제공자 설정

ThirdBrain은 네 가지 백엔드를 지원합니다. 최초 실행 시 온보딩에서, 또는 **설정 → ThirdBrain**에서 선택합니다.

| 제공자 | 발급처 | 비고 |
|--------|--------|------|
| **Gemini** | [Google AI Studio](https://aistudio.google.com/) | 무료 티어 넉넉 |
| **Claude API** | [Anthropic Console](https://console.anthropic.com/) | `sk-ant-…` |
| **GPT (OpenAI)** | [OpenAI Platform](https://platform.openai.com/) | MP3 전사에 필수 |
| **Claude Code (CLI)** | [claude.ai/code](https://claude.ai/code) | 로컬 구독 사용, 데스크톱 전용 |

> 모든 AI 호출은 사용자 기기에서 직접 이루어집니다. ThirdBrain 서버로 데이터가 전송되지 않습니다.
> Claude Code(CLI) 모드는 로컬 서브프로세스를 실행하므로 데스크톱에서만 동작합니다. API 모드(Gemini/Claude API/GPT)는 Obsidian 내장 네트워크로 모바일에서도 동작합니다.

---

## 핵심 개념

- **명제(proposition)**: 원문 한 구절에 고정된 원자적 주장. 모든 명제는 자기가 나온 **원문 구절(source_span)** 을 기억합니다.
- **엣지(edge)**: 명제 사이의 **유형화된 논리 관계**. 아래 4축 10종만 허용되며, 각 엣지는 근거(`axiom_basis`)를 반드시 인용합니다.

  | 축 | 관계 |
  |----|------|
  | 인과·전제 | `causes` · `precedes` · `precondition_of` |
  | 진리·증명 | `supports` · `conflicts_with` · `contrasts_with` |
  | 계층·적용 | `exemplifies` · `applies_to` |
  | 위상 교차 | `analogous_to` · `isomorphic_to` |

- **문맥(context/토픽)**: 명제들이 소속되는 주제 묶음. 논리 엣지가 아니라 소속(membership) 필드로 관리됩니다.
- **액션(action)**: 토픽 내 명제들을 종합해 도출된 실행 태스크. `_actions/`에 저장.
- **문제(problem) = 미션**: 의도와 현실 사이의 긴장(장애·공백·리스크) 또는 승격된 모순. `_problems/`에 저장되고 `open → resolved` 라이프사이클을 가집니다.
- **원본 격리(raw)**: 넣은 원본은 `raw/`에 그대로 박제되고, 모든 명제가 위키링크로 원문 구절까지 역추적됩니다.

---

## 화면 구성

패널 위에서 아래로:

- **헤더**: 로고 · 부제 · 세션 사용량 표시줄
- **Curioso 드롭존** *(Curioso는 ThirdBrain의 마스코트입니다)*: `.md / .txt / .pdf / .mp3 먹여주세요`
  - **드래그해서 밥 주기** = 인제스트(파일 로드)
  - **Curioso 클릭** = **뇌 상태** 열기
  - 미해소 모순이 있으면 Curioso에 **빨간 `!` 말풍선**이 떠, 클릭하면 뇌 상태로 이동
  - `📁 파일 선택` 버튼 / 텍스트 입력창 / 글자 수
- **버튼 4개**
  | 버튼 | 기능 |
  |------|------|
  | `✦ 그래프 추출` | 입력한 텍스트를 그래프로 생성(파이프라인 실행) |
  | `🔍 폴더 분석` | 폴더 종합 인사이트 + 전사본(표현) 분석 |
  | `⊕ 그래프 보기` | 네이티브/캔버스 그래프 · 내보내기 · 삭제 |
  | `🎯 미션 컨트롤` | 폴더 그래프를 근거로 문제를 푸는 대화형 작업대 |
- **파일 수 표시**

---

## 워크플로우 ① 그래프 생성 (인제스트)

가장 기본이 되는 흐름입니다.

1. **입력**: 텍스트를 붙여넣거나, `.md/.txt/.pdf/.mp3`를 Curioso에 드롭(또는 `📁 파일 선택`).
   - **PDF**는 자동으로 텍스트 추출.
   - **MP3**는 OpenAI(Whisper)로 전사 → 화자 분리 → 제목 추론 (OpenAI 제공자 + 키 필요).
2. **`✦ 그래프 추출`** 클릭.
3. **콘텐츠 타입 선택**: 문서 / 강의 / 회의 / 대화.
   - 회의는 하위 유형(브레인스토밍·실행·리뷰)에서 **액션 레이어**가 함께 도출됩니다.
   - 대화는 하위 유형(영어회화·통화·인터뷰).
4. **저장 폴더 선택**: 루트 하위에서 고르거나 새 폴더 생성.
5. **AI 비용 확인 창**: 예상 토큰·비용·시간을 보고 **진행**을 눌러야 실행됩니다. (취소하면 입력이 보존됩니다.)
6. **파이프라인 실행** (진행바 + 스텝 로그):

   | 단계 | 하는 일 |
   |------|---------|
   | 원본 박제 | 원본을 `raw/`에 저장 |
   | 문맥 | 핵심 주제·개념 추출 |
   | 명제 | 원문 구절에 고정된 원자적 주장 추출 |
   | 엣지 | 4축 10관계 논리 엣지 생성(근거 인용 필수) |
   | 액션(선택) | 토픽별 복합 실행 태스크 도출 → `_actions/` |
   | 문제 | 의도·현실의 긴장 감지 → `_problems/` |
   | 자동 연결 | 기존 그래프와의 연결 스캔 (신뢰도 ≥75% 자동 저장, 그 미만은 칩으로 제시) |
   | 나이브 요약 | 원문 전체를 산문 그대로 요약 → `summaries/` (구조화에서 놓친 뉘앙스 보완) |

7. **결과 패널**: 문맥·명제·논리·액션·문제 레이어가 카드로 표시됩니다.
   - **모순이 감지되면** 결과 상단에 알림이 뜨고, 해소는 **뇌 상태**에서 진행합니다.

> 큰 텍스트는 자동으로 청크 분할되어 순차 처리되며, 중간에 끊겨도 완료된 청크는 보존됩니다.

---

## 워크플로우 ② 뇌 상태

**Curioso를 클릭**하면 열립니다. 미션·미연결·모순은 볼트 전역 경보가 아니라 **"폴더 안에서 아직 안 끝난 일"** 이므로, 폴더 단위로 드릴인해서 처리합니다.

### Level 1 — 폴더 목록

미션·미연결·모순이 하나라도 있는 폴더가 배지와 함께 나열됩니다.

```
📁 7월_기획회의      ⚠ 모순 1   🎯 미션 2   ◈ 미연결 3
📁 리서치_노트                   🎯 미션 1
```

폴더를 클릭 → 상세로 진입.

### Level 2 — 폴더 상세

- **⚠ 미해소 모순**: 각 모순 카드의 `해소하기` → **모순 해소 모달**. 세 옵션:
  1. **엣지 재분류** — AI가 더 정확한 관계(예: `contrasts_with`)를 추천, 클릭 시 교체
  2. **상위 전제 추가** — 두 모순을 포괄하는 상위 개념 노트를 만들어 `precondition_of`로 연결 (AI 제목 추론 지원)
  3. **한쪽 폐기** — 거짓으로 판별한 명제 삭제
  - 어떤 방식이든 **어떻게 해소했는지**가 문제 노드에 기록됩니다.
- **🎯 미션**: 각 미션 카드에서
  - `🎯 작업대` — 해당 폴더·미션으로 **미션 컨트롤** 진입
  - `내용` — 미션 서술 + 증거 원문(위키링크 클릭 가능) 열람
  - `해소` — 미션을 resolved 처리
- **◈ 미연결 명제**: `연결하기 (AI 린팅)` → 같은 폴더 안에서 AI가 연결 후보를 찾아 제시. 후보마다 대상 노드·관계·신뢰도·근거가 표시되고, 수락하면 엣지가 저장됩니다.

---

## 워크플로우 ③ 미션 컨트롤 (폴더 RAG 작업대)

**`🎯 미션 컨트롤`** 버튼, 또는 뇌 상태의 미션 `🎯 작업대`로 진입합니다.
쌓인 그래프로 문제를 **푸는** 메인 기능입니다. 일반 챗봇과 달리 **답의 출처가 증발하지 않습니다** — 모든 답이 실존하는 `[[노드]]`로 역추적 보장됩니다.

### Level 1 — 폴더 선택

폴더별 열린 미션 수·노드 수를 보고 작업할 폴더를 고릅니다.
하단의 **`폴더 간 연결 탐색`** 보조 버튼으로 두 폴더 사이의 구조적 브릿지(크로스 도메인 연결·모순)를 찾을 수도 있습니다.

### Level 2 — 작업대

- **헤더**: 폴더명 · 그라운딩 노드 수 · 세션 누적 토큰
- **미션 리스트**: 그 폴더의 열린 문제들. 미션을 고르면 그 미션 기준으로 대화가 이어집니다.
- **채팅**: 질문을 입력하면 폴더 그래프(문맥·명제·액션·논리엣지·raw)를 근거로 답합니다.
  - 답변의 `[[노드]]` 인용은 **실존 검증**되며, 없는 노드를 지어내면 취소선·경고로 표시됩니다.
  - 근거가 없으면 "근거 없음"이라고 답하도록 강제됩니다.
- **서브그래프 참여**: 다른 폴더의 그래프를 **참고인**으로 잠시 끌어올 수 있습니다. 참여 중인 서브그래프는 칩으로 표시되고 `✕`로 해제합니다. 서브그래프 출신 인용은 `[[노드]] (from: 폴더명)`으로 출신이 병기됩니다.
- **미션 승격**: 대화 중 발견한 문제를 문제 노드로 승격(장애/공백/리스크 분류 + 증거 노드 선택 → `_problems/` 저장).
- **대화 박제**: 문답이 `_solving/` 노트에 마크다운으로 기록됩니다. 미션 기반이면 해당 미션 노트에 이어쓰기, 자유 채팅이면 `작업대-{폴더}-{날짜}.md`.

> 비용 게이트는 **세션 첫 질문에 1회**만 뜨고, 이후 턴은 비게이트로 진행됩니다.

---

## 워크플로우 ④ 폴더 분석

**`🔍 폴더 분석`** — 두 개의 탭.

### 그래프 분석 탭

폴더를 선택하고, 분석 목적(핵심 파악·논리 구조·모순 탐지·발표용·의사결정 등) 프리셋을 고르거나 직접 입력한 뒤 깊이(요약/심층)를 선택합니다. `_actions` 하위 포함 여부도 선택할 수 있습니다.
결과는 **종합 결론 + 개요 + 주요 통찰 + 주제 묶음 + 연결 맥락**으로 구성된 리포트이며, 저장할 수 있습니다.

### 표현/전사본 분석 탭

폴더 노드를 대상으로 언어·정보·지시·문단 관점의 분석을 수행합니다. 백그라운드로 돌아 모달을 닫아도 계속 실행되며, 결과를 폴더에 저장할 수 있습니다.

---

## 워크플로우 ⑤ 그래프 보기

**`⊕ 그래프 보기`** — 네 개의 탭.

| 탭 | 하는 일 |
|----|---------|
| **네이티브** | Obsidian 기본 그래프를 선택 폴더로 필터링해 열기 (모순 엣지 제외 옵션) |
| **캔버스** | ThirdBrain 전용 캔버스 그래프. 관계 프리셋 필터 + AI 자연어 쿼리로 원하는 관계만 시각화 |
| **다운로드** | 폴더 그래프를 AI 친화 마크다운으로 내보내기 (원문·메타데이터·길이 옵션) |
| **삭제** | 폴더 선택 → 삭제 대상(노드·raw 원본·요약·하위) 집계 → 확인 → **휴지통으로 이동**(복구 가능) |

---

## AI 비용 확인 게이트

사용자가 직접 시작하는 모든 AI 작업(생성·폴더 분석·미션 컨트롤 첫 질문·전사본 분석·고립 린팅·음성 전사) 전에 확인 창이 뜹니다.

- 표시: **예상 호출 수 · 예상 토큰(입력/출력) · 예상 비용(USD) · 예상 시간**
- **진행**을 눌러야 실행, **취소** 시 실행하지 않음(생성은 입력 보존).
- Claude CLI는 구독 사용량에서 차감되므로 비용은 API 환산 참고치로 표시됩니다.
- 값은 **추정치**입니다(실제 사용량과 다를 수 있음).
- 화면 열 때 딸려오는 소량 자동 호출은 게이트하지 않습니다.
- **끄기**: 설정 → ThirdBrain → "AI 실행 전 비용 확인" 토글.

---

## 저장 구조

루트 폴더(기본 `ThirdBrainRoot`) 아래 세션(주제)별로 정리됩니다.

```
ThirdBrainRoot/
├─ raw/                     원본 박제(허브-스포크 위키링크)
├─ summaries/               나이브 산문 요약
└─ {세션}/
   ├─ {명제·문맥 노드}.md
   ├─ _actions/             실행 태스크
   ├─ _problems/            문제(미션) 노드
   └─ _solving/             작업대 대화 기록
```

각 노드 `.md`의 프론트매터: `tb_id` · `tb_type` · `tb_edges` · `tb_tags` · `tb_source_span` · `tb_axiom_basis` 등. 엣지는 위키링크로도 저장되어 Obsidian 네이티브 그래프가 관계를 렌더합니다.

---

## 설정

**설정 → ThirdBrain**:

- **언어** (한국어/English) — UI와 AI 출력 언어
- **AI 실행 전 비용 확인** — 게이트 on/off (기본 on)
- **루트 폴더** — 모든 ThirdBrain 파일의 최상위 폴더
- **Claude CLI 경로** (데스크톱) — `claude` 또는 절대 경로
- **AI 제공자** + 각 제공자 **API 키**

---

## 커맨드

- **ThirdBrain: Open panel** — 패널 열기
- **ThirdBrain: Open mission workbench (active problem note)** — 현재 연 문제 노트의 작업대를 바로 열기

---

## 자주 묻는 질문

**Q. 모순이 생기면 어떻게 되나요?**
새 명제가 기존 지식과 충돌하면 즉시 `conflicts_with` 엣지로 표시되고 문제 노드로 승격됩니다. Curioso의 빨간 `!`로 알림이 오며, 뇌 상태에서 세 옵션(재분류·상위 전제·폐기)으로 해소합니다. 어떤 모순도 조용히 묻히지 않습니다.

**Q. 미션 컨트롤이 일반 챗봇과 뭐가 다른가요?**
답이 반드시 폴더 그래프에 그라운딩되고 실존 `[[노드]]`로 인용되어야 합니다. 근거가 없으면 지어내지 않고 "근거 없음"이라고 답합니다 — 출처가 증발하지 않는 것이 핵심입니다.

**Q. 넣은 원문은 안전한가요?**
원본은 `raw/`에 그대로 보존되고, 모든 명제가 원문 구절까지 역추적됩니다. 그래프 삭제도 영구 삭제가 아니라 휴지통 이동(복구 가능)입니다.

**Q. 비용이 걱정됩니다.**
모든 사용자 시작 AI 작업 전에 예상 토큰·비용·시간이 표시되고, 진행을 눌러야 실행됩니다. 작은 테스트 텍스트로 먼저 감을 잡는 것을 권합니다.

**Q. 모바일에서 되나요?**
API 제공자(Gemini/Claude API/GPT)를 쓰면 모바일에서도 동작합니다. Claude Code(CLI) 모드는 데스크톱 전용입니다.

---

## 엔터프라이즈 활용

ThirdBrain의 아키텍처 — 유형화된 논리 엣지, 완전한 출처 역추적, 모순 감지 — 는 조직의 고위험 문제에 그대로 적용됩니다.

- **아이디어에서 코드까지 완전한 역추적**: 제품 기획서·도메인 문서를 넣으면 `raw/`에 보존되고, 정확한 출처 구절과 함께 명제로 해체되며, 이를 구현하는 개발 액션과 동기 링크로 연결됩니다. 동기 링크가 감사 추적이 됩니다.
- **시맨틱 콜라이더**: 두 도메인의 문서를 각각 다른 폴더에 인제스트한 뒤 폴더 브릿지(미션 컨트롤 → 폴더 간 연결 탐색)를 실행하세요. `conflicts_with` 엣지가 코드를 쓰기 전에 충돌 지점을 드러냅니다.
- **논리적 API 게이트키퍼**: 핵심 결정으로 마스터 그래프를 구축하세요. 새 요청을 인제스트했을 때 마스터 그래프와 `conflicts_with`가 생기면 정확히 어떤 명제와 충돌하는지 제시하고 해소를 요구합니다 — 소모전이 아니라 논리로.

---

## 요구 사항 · 라이선스

- Obsidian 1.7.2 이상
- 다음 중 하나: Gemini API 키, Anthropic API 키, OpenAI API 키, 또는 Claude Code CLI (데스크톱)

MIT

---
---

<a id="english"></a>

<div align="right">

[🇰🇷 한국어](#thirdbrain) | 🇺🇸 English

</div>

<div align="center">

<img src="assets/sootball.svg" width="96" height="96" alt="Curioso, the ThirdBrain mascot"/>

# ThirdBrain — English

**Turn your notes into a contradiction-free knowledge graph — then solve problems with it.**

</div>

ThirdBrain is an Obsidian plugin that extracts propositions from your writing, builds a logical knowledge graph with typed edges, detects contradictions, and lets you solve problems on top of the graph — all locally with your choice of AI provider.

> Meet **Curioso**, the ThirdBrain mascot. You feed it text; it grows a knowledge organism.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Installation](#installation)
3. [AI Provider Setup](#ai-provider-setup)
4. [Core Concepts](#core-concepts)
5. [Panel Layout](#panel-layout)
6. [Workflow ① Graph Generation (Ingest)](#workflow--graph-generation-ingest)
7. [Workflow ② Brain Status](#workflow--brain-status)
8. [Workflow ③ Mission Control (Folder RAG Workbench)](#workflow--mission-control-folder-rag-workbench)
9. [Workflow ④ Folder Analysis](#workflow--folder-analysis)
10. [Workflow ⑤ Graph View](#workflow--graph-view)
11. [AI Cost Preflight Gate](#ai-cost-preflight-gate)
12. [Storage Structure](#storage-structure)
13. [Settings](#settings)
14. [Commands](#commands)
15. [FAQ](#faq)
16. [Enterprise Use Cases](#enterprise-use-cases)
17. [Requirements & License](#requirements--license)

---

## Quick Start

1. Click the **Curioso icon** in the ribbon to open the ThirdBrain panel.
2. Paste meeting notes, a document, or a dialogue — or drop a file — and click **`✦ Extract Graph`**. You get a graph decomposed into propositions, typed edges, and problems.
3. **Click Curioso** to open **Brain Status** — resolve each folder's open **missions, unlinked propositions, and contradictions**.
4. Open **`🎯 Mission Control`** to **solve problems conversationally**, grounded in your accumulated graph (every answer is traceable to real `[[nodes]]`).
5. Use **`🔍 Folder Analysis`** for synthesized insight and **`⊕ Graph View`** for visualization.

> Before any AI operation, a **token / cost / time confirmation dialog** appears (can be disabled in settings).

---

## Installation

- **Community Plugins (recommended)**: Obsidian → Settings → Community plugins → Browse → search **ThirdBrain** → Install & Enable.
- **Manual**: Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/ImCuriosity/third-brain-release/releases/latest) → copy to `{vault}/.obsidian/plugins/thirdbrain/` → enable.

---

## AI Provider Setup

ThirdBrain supports four backends. Choose one during onboarding or in **Settings → ThirdBrain**.

| Provider | Get a key | Notes |
|----------|-----------|-------|
| **Gemini** | [Google AI Studio](https://aistudio.google.com/) | Generous free tier |
| **Claude API** | [Anthropic Console](https://console.anthropic.com/) | `sk-ant-…` |
| **GPT (OpenAI)** | [OpenAI Platform](https://platform.openai.com/) | Required for MP3 transcription |
| **Claude Code (CLI)** | [claude.ai/code](https://claude.ai/code) | Local subscription, desktop only |

> All AI calls run locally from your machine. No data is sent to any ThirdBrain server.
> Claude Code (CLI) mode spawns a local subprocess, so it is desktop-only. API modes (Gemini / Claude API / GPT) work on mobile through Obsidian's built-in networking.

---

## Core Concepts

- **Proposition** — an atomic claim anchored to one exact passage. Every proposition remembers the **source span** it came from.
- **Edge** — a **typed logical relation** between propositions. Only these 4 axes / 10 relations are allowed, and every edge must cite its grounding (`axiom_basis`):

  | Axis | Relations |
  |------|-----------|
  | Causal / premise | `causes` · `precedes` · `precondition_of` |
  | Truth / proof | `supports` · `conflicts_with` · `contrasts_with` |
  | Hierarchy / application | `exemplifies` · `applies_to` |
  | Topological | `analogous_to` · `isomorphic_to` |

- **Context (topic)** — the theme a proposition belongs to, tracked as membership (not as a logical edge).
- **Action** — a composite task synthesized from a topic's propositions. Stored in `_actions/`.
- **Problem (= Mission)** — a tension between intent and reality (obstacle / gap / risk) or a promoted contradiction. Stored in `_problems/` with an `open → resolved` lifecycle.
- **Raw isolation** — your original input is archived verbatim in `raw/`, and every proposition traces back to its exact source passage.

---

## Panel Layout

Top to bottom:

- **Header** — logo · subtitle · session usage bar
- **Curioso drop zone** *(Curioso is the ThirdBrain mascot)*: `Drop .md / .txt / .pdf / .mp3 here`
  - **Drag to feed** = ingest (load files)
  - **Click Curioso** = open **Brain Status**
  - If unresolved contradictions exist, Curioso shows a red **`!` bubble** — click it to jump to Brain Status
  - `📁 Choose file` button / text input / character count
- **Four buttons**
  | Button | Function |
  |--------|----------|
  | `✦ Extract Graph` | Run the pipeline on the input text |
  | `🔍 Folder Analysis` | Synthesized folder report + transcript (expression) analysis |
  | `⊕ Graph View` | Native / canvas graph · export · delete |
  | `🎯 Mission Control` | Conversational workbench that solves problems grounded in a folder's graph |
- **File count**

---

## Workflow ① Graph Generation (Ingest)

The foundational flow.

1. **Input**: paste text, or drop `.md/.txt/.pdf/.mp3` onto Curioso (or use `📁 Choose file`).
   - **PDF** is auto-extracted to text.
   - **MP3** is transcribed via OpenAI (Whisper) → speaker separation → title inference (requires the OpenAI provider + key).
2. Click **`✦ Extract Graph`**.
3. **Choose content type**: Document / Lecture / Meeting / Dialogue.
   - Meetings (subtype: brainstorm / execution / review) also derive an **action layer**.
   - Dialogues have subtypes (English conversation / phone call / interview).
4. **Choose the save folder**: pick a subfolder or create a new one.
5. **AI cost confirmation**: review estimated tokens / cost / time and click **Proceed** to run. (Cancel keeps your input.)
6. **Pipeline runs** (progress bar + step log):

   | Stage | What it does |
   |-------|--------------|
   | Archive raw | Save the original to `raw/` |
   | Context | Extract key themes / concepts |
   | Propositions | Extract atomic claims anchored to source passages |
   | Edges | Build 4-axis / 10-relation logical edges (grounding required) |
   | Actions (optional) | Derive composite tasks per topic → `_actions/` |
   | Problems | Detect intent-vs-reality tensions → `_problems/` |
   | Auto-connect | Scan the existing graph for links (≥75% confidence auto-saved; the rest shown as chips) |
   | Naive summary | Summarize the whole source as prose → `summaries/` (covers nuance the structuring may drop) |

7. **Result panel**: context / proposition / logic / action / problem layers shown as cards.
   - **If contradictions are detected**, a notice appears at the top; resolve them in **Brain Status**.

> Large text is auto-chunked and processed sequentially; if interrupted, completed chunks are preserved.

---

## Workflow ② Brain Status

Opens when you **click Curioso**. Missions, unlinked propositions, and contradictions are not vault-wide alarms — they are **"unfinished work inside a folder"**, so you drill in per folder.

### Level 1 — Folder list

Folders with any mission / unlinked node / contradiction are listed with badges.

```
📁 Jul_Planning     ⚠ conflicts 1   🎯 missions 2   ◈ unlinked 3
📁 Research_Notes                    🎯 missions 1
```

Click a folder to drill in.

### Level 2 — Folder detail

- **⚠ Unresolved contradictions**: each card's `Resolve` → **Conflict Resolution modal** with three options:
  1. **Reclassify edge** — AI recommends a more accurate relation (e.g. `contrasts_with`); click to replace.
  2. **Add parent premise** — create a higher-level note that encompasses both, linked via `precondition_of` (AI title inference supported).
  3. **Discard one** — delete the proposition judged false.
  - Either way, *how* it was resolved is recorded on the problem node.
- **🎯 Missions**: each card offers
  - `🎯 Workbench` — open **Mission Control** for that folder + mission
  - `Details` — read the mission's description + evidence source text (clickable wikilinks)
  - `Resolve` — mark the mission resolved
- **◈ Unlinked propositions**: `Connect (AI lint)` → AI finds connection candidates within the same folder. Each shows the target node, relation, confidence, and reasoning; accept to save the edge.

---

## Workflow ③ Mission Control (Folder RAG Workbench)

Enter via the **`🎯 Mission Control`** button, or a mission's `🎯 Workbench` in Brain Status.
This is the core feature for **solving** problems with your accumulated graph. Unlike a generic chatbot, **the source never evaporates** — every answer is guaranteed traceable to real `[[nodes]]`.

### Level 1 — Folder selection

See each folder's open-mission count and node count, and pick one to work on.
The **`Explore folder bridges`** helper button finds structural bridges between two folders (cross-domain links and contradictions).

### Level 2 — Workbench

- **Header**: folder name · number of grounding nodes · cumulative session tokens
- **Mission list**: the folder's open problems. Pick one to anchor the conversation to it.
- **Chat**: ask a question and get an answer grounded in the folder graph (context / propositions / actions / logical edges / raw).
  - `[[node]]` citations are **verified against reality**; invented nodes are struck through / warned.
  - With no grounding, the model must answer "no basis" instead of hallucinating.
- **Attach subgraph**: temporarily bring another folder's graph in as a **witness**. Attached subgraphs show as chips and can be removed with `✕`. Citations from a subgraph carry their origin: `[[node]] (from: folder)`.
- **Promote to mission**: turn a problem found mid-conversation into a problem node (obstacle / gap / risk + evidence node selection → saved to `_problems/`).
- **Conversation archive**: Q&A is recorded to a `_solving/` note. Mission-based chats append to the mission note; free chats go to `workbench-{folder}-{date}.md`.

> The cost gate appears **once, on the first question of a session**; later turns run without it.

---

## Workflow ④ Folder Analysis

**`🔍 Folder Analysis`** — two tabs.

### Graph Analysis tab

Select folders, pick an intent preset (core insight / logical structure / contradiction detection / presentation / decision, etc.) or type your own, then choose depth (summary / rich). You can include the `_actions` subfolder.
The result is a report of **synthesis + overview + key highlights + theme clusters + link contexts**, and can be saved.

### Expression / Transcript Analysis tab

Analyze folder nodes from language / information / directive / paragraph angles. It runs in the background (keeps going even if you close the modal) and can be saved to a folder.

---

## Workflow ⑤ Graph View

**`⊕ Graph View`** — four tabs.

| Tab | What it does |
|-----|--------------|
| **Native** | Open Obsidian's native graph filtered to the selected folders (option to exclude conflict edges) |
| **Canvas** | ThirdBrain's own canvas graph. Relation preset filters + AI natural-language queries to visualize only the relations you want |
| **Download** | Export a folder graph as AI-friendly Markdown (source text / metadata / length options) |
| **Delete** | Select folders → tally deletion targets (nodes, raw originals, summaries, subfolders) → confirm → **move to trash** (recoverable) |

---

## AI Cost Preflight Gate

Before every user-initiated AI operation (generation, folder analysis, Mission Control's first question, transcript analysis, orphan linting, audio transcription), a confirmation dialog appears.

- Shows: **estimated calls · estimated tokens (in / out) · estimated cost (USD) · estimated time**.
- You must click **Proceed** to run; **Cancel** does nothing (generation preserves your input).
- Claude CLI draws from your subscription, so its cost is shown as an API-equivalent reference.
- Values are **estimates** (actual usage may differ).
- Small automatic helper calls triggered by opening a view are not gated.
- **Turn it off**: Settings → ThirdBrain → "Confirm cost before AI runs".

---

## Storage Structure

Under the root folder (default `ThirdBrainRoot`), everything is organized per session (topic).

```
ThirdBrainRoot/
├─ raw/                     Verbatim originals (hub-spoke wikilinks)
├─ summaries/               Naive prose summaries
└─ {session}/
   ├─ {proposition & context nodes}.md
   ├─ _actions/             Executable tasks
   ├─ _problems/            Problem (mission) nodes
   └─ _solving/             Workbench conversation logs
```

Each node's frontmatter: `tb_id` · `tb_type` · `tb_edges` · `tb_tags` · `tb_source_span` · `tb_axiom_basis`, etc. Edges are also stored as wikilinks so Obsidian's native graph renders the relations.

---

## Settings

**Settings → ThirdBrain**:

- **Language** (한국어 / English) — UI and AI output language
- **Confirm cost before AI runs** — gate on/off (default on)
- **Root folder** — top-level folder for all ThirdBrain files
- **Claude CLI path** (desktop) — `claude` or an absolute path
- **AI provider** + each provider's **API key**

---

## Commands

- **ThirdBrain: Open panel** — open the panel
- **ThirdBrain: Open mission workbench (active problem note)** — open the workbench for the currently open problem note

---

## FAQ

**What happens when a contradiction appears?**
A new proposition conflicting with existing knowledge is immediately flagged with a `conflicts_with` edge and promoted to a problem node. Curioso shows a red `!`; resolve it in Brain Status with three options (reclassify / parent premise / discard). No contradiction is silently buried.

**How is Mission Control different from a normal chatbot?**
Answers must be grounded in the folder graph and cited with real `[[nodes]]`. With no basis, it says "no basis" instead of inventing — the source never evaporates.

**Is my original text safe?**
Originals are preserved verbatim in `raw/`, and every proposition traces back to its source passage. Even graph deletion moves files to trash (recoverable), not permanent deletion.

**I'm worried about cost.**
Every user-initiated AI operation shows estimated tokens / cost / time and requires Proceed. Try a small test text first to get a feel.

**Does it work on mobile?**
Yes, with an API provider (Gemini / Claude API / GPT). Claude Code (CLI) mode is desktop-only.

---

## Enterprise Use Cases

ThirdBrain's architecture — typed logical edges, absolute source traceability, and contradiction detection — maps directly onto high-stakes organizational problems.

- **Absolute traceability from idea to code**: Drop a PRD or domain doc — it's archived in `raw/`, decomposed into propositions with exact source spans, and linked to the development actions that implement them. The motivation link is your audit trail.
- **Semantic collider**: Ingest documents from two domains into separate folders and run a folder bridge (Mission Control → Explore folder bridges). `conflicts_with` edges reveal collisions before anyone writes code.
- **Logical API gatekeeper**: Build a master graph of core decisions. Ingest a new request; if it produces a `conflicts_with` edge against the master graph, the exact contradicted proposition is surfaced and resolution is demanded — by logic, not by exhaustion.

---

## Requirements & License

- Obsidian 1.7.2+
- One of: Gemini API key, Anthropic API key, OpenAI API key, or Claude Code CLI (desktop)

MIT
