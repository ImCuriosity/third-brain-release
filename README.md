# ThirdBrain

**파편화된 사유를 무모순의 지식 그래프로.**  
**Turn your scattered thoughts into a contradiction-free knowledge graph.**

---

## 한국어

ThirdBrain은 노트를 논리적 명제로 해체하고, 10종의 관계 타입으로 연결하며, 모순을 감지하고 분석하는 Obsidian 플러그인입니다. AI는 원자재를 추출하는 도구일 뿐 — 공리 강제는 파이프라인이 책임집니다.

### 핵심 기능

**✦ 그래프 생성**  
텍스트를 붙여넣으면 명제(주장·개념·통찰)를 추출하고, 4축 10관계 공리계로 연결합니다.

| 축 | 관계 |
|----|------|
| 인과·전제 | `causes`, `precedes`, `precondition_of` |
| 진리·증명 | `supports`, `conflicts_with`, `contrasts_with` |
| 계층·적용 | `exemplifies`, `applies_to` |
| 위상 교차 | `analogous_to`, `isomorphic_to` |

**🔍 폴더 분석**  
폴더를 선택하면 노드 간 구조적 관계에서 인사이트를 추출합니다. "이 폴더는 다양한 주제를 다룹니다" 같은 메타 언어 없이, 노드 이름과 관계 타입을 직접 인용한 종합 결론을 제시합니다.  
분석 목적 5가지 프리셋: 핵심 파악 / 모순 탐지 / 행동 도출 / 비교 분석 / 브리핑 준비

**⊕ 그래프 보기**  
Obsidian 기본 그래프 뷰를 폴더 기준으로 열어 지식 구조를 시각적으로 탐색합니다.

**🌉 폴더 연결**  
두 폴더 사이의 구조적 교차 연결을 발견합니다. 노트가 암시하지만 아직 명시되지 않은 도메인 간 연결을 제안합니다.

**모순 감지 & 해소**  
`conflicts_with` 엣지가 생성될 때 3가지 해소 옵션을 강제 제시합니다:
1. 명제 A 폐기
2. 명제 B 폐기
3. 두 명제를 포괄하는 상위 전제(`precondition_of`) 추가

### AI 설정

최초 실행 시 온보딩 화면에서 제공자를 선택합니다. **Settings → ThirdBrain**에서 언제든 변경할 수 있습니다.

| 제공자 | 설정 방법 |
|--------|----------|
| **Gemini** | [Google AI Studio](https://aistudio.google.com/) → API 키 생성 |
| **Claude API** | [Anthropic Console](https://console.anthropic.com/) → API 키 생성 |
| **Claude Code** | [claude.ai/code](https://claude.ai/code) → CLI 설치 후 경로 입력 |

> 모든 AI 호출은 사용자 기기에서 직접 이루어집니다. ThirdBrain 서버로 데이터가 전송되지 않습니다.

### 설치

**커뮤니티 플러그인 (권장)**
1. Obsidian → **설정 → 커뮤니티 플러그인 → 탐색**
2. **ThirdBrain** 검색 → 설치 → 활성화

**수동 설치**
1. [최신 릴리즈](../../releases/latest)에서 `main.js`, `manifest.json`, `styles.css` 다운로드
2. `{볼트 경로}/.obsidian/plugins/thirdbrain/` 폴더에 복사
3. **설정 → 커뮤니티 플러그인**에서 활성화

### 사용법

1. 리본 아이콘 클릭 또는 커맨드 팔레트에서 **Open ThirdBrain panel** 실행
2. 텍스트를 입력창에 붙여넣고 **✦ 생성** → 명제 그래프 생성
3. **🔍 분석** → 폴더 선택 → 분석 목적 설정 → 종합 결론 확인
4. **🌉 연결** → 두 폴더 선택 → 교차 연결 발견

### 요구 사항

- Obsidian 1.4.0 이상
- 데스크탑 전용 (Windows / macOS / Linux)
- AI 제공자 중 하나: Gemini API 키 / Claude API 키 / Claude Code CLI

---

## English

ThirdBrain is an Obsidian plugin that breaks notes into logical propositions, connects them using 10 typed relations across 4 axes, detects contradictions, and synthesizes insights — all through your choice of AI provider.

### Features

**✦ Graph Generation**  
Paste any text. ThirdBrain extracts propositions and connects them using a 4-axis, 10-relation axiom system.

| Axis | Relations |
|------|-----------|
| Causal | `causes`, `precedes`, `precondition_of` |
| Truth | `supports`, `conflicts_with`, `contrasts_with` |
| Hierarchy | `exemplifies`, `applies_to` |
| Topology | `analogous_to`, `isomorphic_to` |

**🔍 Folder Analysis**  
Select a folder and get a synthesized insight report — concrete conclusions that cite node names and relation types directly, not vague meta-summaries.  
5 intent presets: Core insight / Contradiction detection / Action extraction / Comparative analysis / Briefing prep

**⊕ Graph View**  
Open Obsidian's native graph view filtered to a folder.

**🌉 Bridge**  
Find structural cross-connections between two folders — links your notes imply but haven't made explicit.

**Contradiction Detection & Resolution**  
When a `conflicts_with` edge is created, 3 resolution options are forced:
1. Discard proposition A
2. Discard proposition B
3. Add a higher-level precondition (`precondition_of`) that encompasses both

### AI Provider Setup

Choose your provider on first launch, or change it anytime in **Settings → ThirdBrain**.

| Provider | How to get started |
|----------|-------------------|
| **Gemini** | [Google AI Studio](https://aistudio.google.com/) → API keys → Create |
| **Claude API** | [Anthropic Console](https://console.anthropic.com/) → API Keys → Create |
| **Claude Code** | [claude.ai/code](https://claude.ai/code) → Install CLI → set path in settings |

> All AI calls happen locally from your machine. No data is sent to any ThirdBrain server.

### Installation

**Community Plugins (recommended)**
1. Obsidian → **Settings → Community plugins → Browse**
2. Search **ThirdBrain** → Install → Enable

**Manual**
1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases/latest)
2. Copy to `{vault}/.obsidian/plugins/thirdbrain/`
3. Enable in **Settings → Community plugins**

### Requirements

- Obsidian 1.4.0+
- Desktop only (Windows / macOS / Linux)
- One of: Gemini API key, Anthropic API key, or Claude Code CLI

---

## License

MIT © ImCuriosity
