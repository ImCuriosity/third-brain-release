<div align="right">

🇺🇸 English | [🇰🇷 한국어](#korean)

</div>

<div align="center">

<img src="assets/sootball.svg" width="96" height="96" alt="ThirdBrain mascot"/>

# ThirdBrain

</div>

**Turn your notes into a contradiction-free knowledge graph.**

ThirdBrain is an Obsidian plugin that extracts propositions from your writing, builds a logical knowledge graph with typed edges, detects contradictions, and analyzes connections — all locally using your choice of AI provider.

---

## Features

### ✦ Graph Generation
Paste or drop any text. ThirdBrain runs a multi-stage pipeline that builds three layers of structured knowledge:

| Stage | Layer | What it produces |
|-------|-------|-----------------|
| ① | **Context** | Key themes and concepts extracted from the source text |
| ② | **Propositions** | Atomic logical claims, each anchored to the exact source paragraph |
| ③ | **Edges** | Typed logical relations between propositions across 4 axes |
| ④ | **Actions** *(optional)* | Composite tasks synthesized from the propositions within each topic |
| ⑤ | **Problems** | Tensions between intent and reality — obstacles, gaps, risks, and promoted contradictions |

**10 logical relation types across 4 axes:**

| Axis | Relations |
|------|-----------|
| Causal | `causes`, `precedes`, `precondition_of` |
| Truth | `supports`, `conflicts_with`, `contrasts_with` |
| Hierarchy | `exemplifies`, `applies_to` |
| Topology | `analogous_to`, `isomorphic_to` |

**Auto-connection to your existing graph:**
After the pipeline runs, ThirdBrain scans your existing knowledge graph for connections to the new nodes. Every candidate must cite the exact passage that grounds the relation (`axiom_basis`) — ungrounded candidates are discarded. High-confidence connections (≥75%) are saved automatically with a visible log; the rest are presented as chips for you to curate.

**Contradiction handling:**
When a new proposition conflicts with existing knowledge, ThirdBrain flags it immediately with a `conflicts_with` edge and presents three resolution options: discard one proposition, discard the other, or introduce a parent premise that encompasses both. Each contradiction is also promoted to a problem node that stays open until resolved — and records *how* it was resolved. No contradiction is silently buried.

### 🔍 Folder Analysis
Select any folder and get a synthesized insight report — not just a summary of connections, but concrete conclusions derived from the logical structure. Supports intent presets (core insight, contradiction detection, action extraction, etc.) and optional `_actions` subfolder inclusion.

### ⊕ Graph View
Open Obsidian's native graph view filtered to any folder for visual exploration.

### 🌉 Folder Bridge
Find structural bridges between two folders — cross-domain connections your notes imply but haven't made explicit.

### Action Layer
Actions are synthesized from the propositions within each topic — composite tasks, not one-line restatements — and stored in `_actions/` subfolders, linked back to the propositions that motivated them. Owners and deadlines are recorded only when the source text states them explicitly.

### ⚠ Problem Layer
ThirdBrain scans each folder's propositions for **tensions between intent and reality**: obstacles (intent blocked by a constraint), gaps (a decision blocked by missing information), and risks (an unverified assumption load-bearing a plan). Detected problems are stored in `_problems/` subfolders with their evidence propositions, live through an `open → resolved` lifecycle, and can suggest a resolution action. Contradictions in the logic graph are automatically promoted to problem nodes and auto-resolved when the underlying edge is cleared.

### ⚠ Conflict Resolution
When contradictions are detected, a badge appears in the panel showing the number of unresolved conflicts. Click it to open the resolution queue — each conflict presents three options: discard proposition A, discard proposition B, or introduce a parent premise that reconciles both. No contradiction is left unaddressed.

### ◈ Unlinked Node Linting
Propositions with no edges are surfaced as a badge in the panel. Click it to open the linting queue, select a folder, and let AI search for connection candidates within that folder. Each candidate shows the target node, relation type, confidence score, and reasoning — accept to save the edge, or ignore to revisit later.

---

## AI Provider Setup

ThirdBrain supports four AI backends. Set your preferred provider on first launch or in **Settings → ThirdBrain**.

| Provider | How to get started |
|----------|-------------------|
| **Gemini** | [Google AI Studio](https://aistudio.google.com/) → API keys → Create |
| **Claude API** | [Anthropic Console](https://console.anthropic.com/) → API Keys → Create |
| **GPT (OpenAI)** | [OpenAI Platform](https://platform.openai.com/) → API keys → Create |
| **Claude Code** | [claude.ai/code](https://claude.ai/code) → Install CLI → set path |

> All AI calls happen locally from your machine. No data is sent to any ThirdBrain server.

> **Shell access notice:** Claude Code (CLI) mode spawns a local subprocess to call the Claude CLI. This requires shell execution via Node.js `child_process`. API-based modes (Gemini, Claude API, GPT) do not use shell access — all calls go through Obsidian's built-in `requestUrl`.

---

## Installation

### Community Plugins (recommended)
1. Open Obsidian → **Settings → Community plugins → Browse**
2. Search for **ThirdBrain**
3. Install and enable

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Copy to `{vault}/.obsidian/plugins/thirdbrain/`
3. Enable in **Settings → Community plugins**

---

## Usage

1. Open the ThirdBrain panel (click the sootball icon in the ribbon, or run **Open ThirdBrain panel** from the command palette)
2. Paste text into the input area and click **✦ Extract Graph** to run the pipeline
3. Click **⊕ Graph View** to open the filtered graph view for any folder
4. Click **🔍 Folder Analysis** to get a synthesized insight report for a folder
5. Click **🌉 Folder Bridge** to find cross-folder connections

---

## Requirements

- Obsidian 1.4.0+
- Desktop only (uses local AI CLI or network API calls)
- One of: Gemini API key, Anthropic API key, OpenAI API key, or Claude Code CLI

---

## Enterprise Use Cases

ThirdBrain's architecture — typed logical edges, absolute source traceability, and contradiction detection — maps directly onto high-stakes organizational problems.

### Absolute Traceability from Idea to Code

Every business decision leaves a verifiable trail. Drop a product spec or domain document into ThirdBrain: it's archived as-is in `raw/`, decomposed into propositions with exact source spans, and linked to the development actions that implement them via motivation links. When a developer writes code, they can trace it back — without ambiguity — to the business proposition that demanded it, and to the original paragraph that proposition came from.

> Works today. Ingest your PRD, let ThirdBrain extract propositions, then create action nodes for each sprint task. The motivation link is the audit trail.

### Semantic Collider — Cross-Domain Contradiction Detection

Different teams use different words for the same concepts, or the same words for conflicting ones. Feed documents from two domains (e.g. engineering specs and security policy) into separate folders, then run **🌉 Folder Bridge** between them. ThirdBrain surfaces the structural connections your teams haven't made explicit — and the `conflicts_with` edges reveal where the two bodies of knowledge are on a collision course before anyone writes a line of code.

> Works today via the Folder Bridge feature. Cross-folder analysis finds implicit agreements and contradictions across organizational silos.

### Logical API Gatekeeper — Contradiction-Driven Requirements Review

Build a master graph of your core architecture decisions and non-negotiable principles. When a new feature request or policy change arrives, ingest it. If it generates a `conflicts_with` edge against the master graph, the system surfaces the exact proposition it contradicts and demands resolution — not negotiation by exhaustion, but resolution by logic.

> Works today as a workflow. Automated rejection (blocking ingestion on conflict) is a planned extension.

---

## License

MIT

---
---

<a id="korean"></a>

<div align="right">

[🇺🇸 English](#thirdbrain) | 🇰🇷 한국어

</div>

# ThirdBrain — 한국어

**노트를 모순 없는 지식 그래프로.**

ThirdBrain은 Obsidian 플러그인입니다. 글에서 명제를 추출하고, 논리적으로 유형화된 엣지로 지식 그래프를 구축하며, 모순을 감지하고 연결을 분석합니다 — 모두 로컬에서, 원하는 AI 제공자로.

---

## 기능

### ✦ 그래프 추출
텍스트를 붙여넣거나 드롭하세요. ThirdBrain이 단계별 파이프라인으로 세 가지 지식 레이어를 구축합니다.

| 단계 | 레이어 | 생성 내용 |
|------|--------|----------|
| ① | **문맥** | 원본 텍스트에서 핵심 주제와 개념 추출 |
| ② | **명제** | 원본 단락에 정확히 고정된 원자적 논리 주장 |
| ③ | **엣지** | 4축 기준 명제 간 유형화된 논리 관계 |
| ④ | **액션** *(선택)* | 토픽 내 명제들을 종합해 도출된 복합 실행 태스크 |
| ⑤ | **문제** | 의도와 현실 사이의 긴장 — 장애·공백·리스크, 그리고 승격된 모순 |

**4축 10가지 논리 관계 유형:**

| 축 | 관계 |
|------|-----------|
| 인과 | `causes`, `precedes`, `precondition_of` |
| 진리 | `supports`, `conflicts_with`, `contrasts_with` |
| 계층 | `exemplifies`, `applies_to` |
| 위상 | `analogous_to`, `isomorphic_to` |

**기존 그래프와 자동 연결:**
파이프라인이 완료되면 ThirdBrain이 기존 지식 그래프에서 새 노드와의 연결을 스캔합니다. 모든 후보는 관계를 성립시키는 원문 구절 인용(`axiom_basis`)을 통과해야 하며, 근거 없는 후보는 폐기됩니다. 신뢰도 75% 이상 연결은 로그와 함께 자동 저장되고, 그 미만은 칩으로 제시되어 직접 선별합니다.

**모순 처리:**
새로운 명제가 기존 지식과 충돌하면 ThirdBrain이 `conflicts_with` 엣지로 즉시 표시하고 세 가지 해소 옵션을 제시합니다: 한쪽 명제 폐기, 다른 쪽 폐기, 또는 두 모순을 포괄하는 상위 전제 추가. 각 모순은 해결될 때까지 열려 있는 문제 노드로도 승격되며, *어떻게* 해소했는지가 기록으로 남습니다. 어떤 모순도 조용히 묻히지 않습니다.

### 🔍 폴더 분석
폴더를 선택하면 단순한 연결 요약이 아니라 논리 구조에서 도출된 구체적인 결론을 담은 종합 인사이트 리포트를 생성합니다. 분석 목적 프리셋(핵심 파악, 모순 탐지, 액션 추출 등)과 `_actions` 하위 폴더 포함 여부를 선택할 수 있습니다.

### ⊕ 그래프 보기
Obsidian 네이티브 그래프 뷰를 특정 폴더 기준으로 필터링해 시각적으로 탐색합니다.

### 🌉 폴더 브릿지
두 폴더 사이의 구조적 연결 고리를 찾습니다 — 노트가 암시하고 있지만 아직 명시하지 않은 크로스 도메인 연결을 발견합니다.

### 액션 레이어
액션은 토픽 내 명제들을 종합해 도출됩니다 — 한 줄 재진술이 아닌 복합 태스크. `_actions/` 하위 폴더에 저장되며 동기가 된 명제들과 연결됩니다. 담당자·기한은 원문에 명시된 경우에만 기록합니다.

### ⚠ 문제 레이어
ThirdBrain은 폴더의 명제들에서 **의도와 현실 사이의 긴장**을 스캔합니다: 장애(의도가 제약에 막힘), 공백(정보 부재로 결정 불가), 리스크(검증 안 된 가정 위에 계획이 서 있음). 감지된 문제는 증거 명제와 함께 `_problems/` 하위 폴더에 저장되고, `open → resolved` 라이프사이클을 가지며, 해결 액션을 제안할 수 있습니다. 논리 그래프의 모순은 자동으로 문제 노드로 승격되고, 원인 엣지가 해소되면 자동으로 닫힙니다.

### ⚠ 모순 해결
모순이 감지되면 패널에 미해결 건수 배지가 나타납니다. 클릭하면 해결 큐가 열리며, 모순마다 세 가지 옵션을 제시합니다: 명제 A 폐기, 명제 B 폐기, 또는 두 모순을 포괄하는 상위 전제 추가. 어떤 모순도 그냥 넘어가지 않습니다.

### ◈ 미연결 명제 린팅
엣지가 없는 고립 명제 수가 패널 배지로 표시됩니다. 클릭하면 린팅 큐가 열리고, 폴더를 선택하면 AI가 같은 폴더 내에서 연결 후보를 탐색합니다. 후보마다 대상 노드·관계 유형·신뢰도·근거가 표시되며, 수락하면 엣지가 저장됩니다. 넘긴 항목은 다음 린팅 시 다시 나타납니다.

---

## AI 제공자 설정

ThirdBrain은 네 가지 AI 백엔드를 지원합니다. 최초 실행 시 또는 **설정 → ThirdBrain**에서 원하는 제공자를 선택하세요.

| 제공자 | 시작 방법 |
|----------|-------------------|
| **Gemini** | [Google AI Studio](https://aistudio.google.com/) → API 키 → 만들기 |
| **Claude API** | [Anthropic Console](https://console.anthropic.com/) → API 키 → 만들기 |
| **GPT (OpenAI)** | [OpenAI Platform](https://platform.openai.com/) → API keys → 만들기 |
| **Claude Code** | [claude.ai/code](https://claude.ai/code) → CLI 설치 → 경로 설정 |

> 모든 AI 호출은 사용자 기기에서 직접 이루어집니다. ThirdBrain 서버로 데이터가 전송되지 않습니다.

> **셸 접근 안내:** Claude Code(CLI) 모드는 Claude CLI를 호출하기 위해 Node.js `child_process`로 로컬 서브프로세스를 실행합니다. API 기반 모드(Gemini, Claude API, GPT)는 셸 접근을 사용하지 않으며, 모든 호출은 Obsidian 내장 `requestUrl`을 통해 이루어집니다.

---

## 설치

### 커뮤니티 플러그인 (권장)
1. Obsidian → **설정 → 커뮤니티 플러그인 → 탐색**
2. **ThirdBrain** 검색
3. 설치 후 활성화

### 수동 설치
1. [최신 릴리즈](../../releases/latest)에서 `main.js`, `manifest.json`, `styles.css` 다운로드
2. `{볼트 경로}/.obsidian/plugins/thirdbrain/` 폴더 생성 후 복사
3. **설정 → 커뮤니티 플러그인**에서 활성화

---

## 사용법

1. ThirdBrain 패널 열기 (리본의 숯볼 아이콘 클릭, 또는 커맨드 팔레트에서 **Open ThirdBrain panel** 실행)
2. 입력 영역에 텍스트를 붙여넣고 **✦ 그래프 추출** 클릭 → 파이프라인 실행
3. **⊕ 그래프 보기** 로 폴더 그래프 뷰 열기
4. **🔍 폴더 분석** 으로 폴더 종합 인사이트 리포트 확인
5. **🌉 폴더 브릿지** 로 폴더 간 연결 탐색

---

## 요구 사항

- Obsidian 1.4.0 이상
- 데스크톱 전용 (로컬 AI CLI 또는 네트워크 API 호출 사용)
- 다음 중 하나: Gemini API 키, Anthropic API 키, OpenAI API 키, 또는 Claude Code CLI

---

## 엔터프라이즈 활용

ThirdBrain의 아키텍처 — 유형화된 논리 엣지, 완전한 출처 역추적, 모순 감지 — 는 조직의 고위험 문제에 그대로 적용됩니다.

### 아이디어에서 코드까지 완전한 역추적

모든 비즈니스 의사결정이 검증 가능한 흔적을 남깁니다. 제품 기획서나 도메인 문서를 ThirdBrain에 넣으면: 원본이 `raw/`에 그대로 보존되고, 정확한 출처 구절과 함께 명제로 해체되며, 동기 링크로 이를 구현하는 개발 액션과 연결됩니다.

> **지금 바로 사용 가능.** PRD를 인제스트하고 각 스프린트 태스크에 액션 노드를 생성하세요. 동기 링크가 감사 추적이 됩니다.

### 시맨틱 콜라이더 — 크로스 도메인 모순 검증기

두 도메인(예: 개발팀 기획서와 보안팀 정책)의 문서를 각각 다른 폴더에 인제스트한 뒤 **브릿지**를 실행하세요. `conflicts_with` 엣지로 코드를 한 줄 쓰기 전에 충돌 지점을 드러냅니다.

> **지금 바로 사용 가능.** 브릿지 기능이 조직 사일로 간 암묵적 합의와 모순을 동시에 찾아냅니다.

### 논리적 API 게이트키퍼 — 모순 기반 요구사항 검토

핵심 아키텍처 결정으로 마스터 그래프를 구축하세요. 새로운 기능 요청이 들어오면 인제스트합니다. 마스터 그래프에서 `conflicts_with`가 생성되면 정확히 어떤 명제와 충돌하는지 제시하고 해소를 요구합니다.

> **지금 워크플로우로 가능.** 자동 거부는 추후 지원 예정입니다.

---

## 라이선스

MIT
