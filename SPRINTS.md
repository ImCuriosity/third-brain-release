# ThirdBrain — Sprint 관리

---

## v1 Archive (한 줄 요약)

| Phase | 내용 |
|-------|------|
| Phase 0 | 철학 문서화 (PHILOSOPHY.md, core-engine.md, CLAUDE.md) |
| Phase 1 | TypeScript + esbuild 골격, styles.css, Obsidian 정션 |
| Phase 2 | 인제스트 파이프라인 3단계 직렬 CLI + 결과 카드 UI |
| Phase 3 | D3 force 그래프 + 트리 뷰어 + 양방향 sync |
| Phase 4 | 2.5차 엣지 큐레이션 칩 UI (확정/거절) |
| Phase 5 | 폴더 브리지 (구조적 동형성 교차 인사이트 추출) |
| Phase 6 | 크로스폴더 엣지 점선 시각화 + 폴더 드롭다운 필터 |
| Phase 7 | 추상 허브 노드 강조 + 파이프라인 3함수 분리 |
| Phase 8 | 폴더 요약 (summarizeFolder) + AnalysisModal |
| Phase 9 | 파일 드롭존, 재분석 버튼, 리포트 저장, 드래그 리사이즈 |
| Phase 10 | 프롬프트 극도 단순화, 작업 로그 드롭다운, 명제 섹션 기본 닫힘 |
| Phase 11 | 그래프 토폴로지 재설계 (Insight 제거, 크로스-컨텍스트 엣지 강화) |
| Phase 12 | GNN-inspired 위상 사전 필터로 폴더 브리지 성능 최적화 |
| Phase 13 | 노드 이식 (일반 .md → ThirdBrain 노드 흡수) |
| Infra | 멀티 프로바이더 LLM (Claude CLI/API, Gemini), requestUrl CORS 우회 |
| UI 누적 | Dual Ingest 모드, Confidence 점수, Auto 자동화, 글자수/압축률 표시 등 |

---

## v2 — 무모순의 우주 (4축 텐서 공리계)

> **핵심 전환**: 확률적 LLM 사후 정당화 → 수학적 공리 강제
> **데이터 모델**: `TBEdgeRelation` 10종 + `SparseAdjacencyTensor` + `source_span` + `axiom_basis`
> **이중 레이어**: 명제 그래프(Epistemic) + 액션 그래프(Pragmatic) 분리
> **고립 정책**: 폴백 연결 금지. 고립 노드 = 연결 대기 신호. Semantic Novelty로 우선순위 결정.

---

## Phase 1 (v2) — 4축 10관계 공리 강제 시스템

> 확률 기반 자유 엣지 생성을 철폐. 10종 외 엣지는 런타임 throw.
> `source_span`과 `axiom_basis` 누락 시 파이프라인 즉시 Reject.

- [x] **1-1** `src/types.ts` — `TBEdgeRelation` 10종 확정, `EDGE_AXES` 상수, `SourceSpan` 인터페이스 ✅ (이전 PR)
- [x] **1-2** `src/types.ts` — `Proposition.source_span`, `LogicEdge.axiom_basis`, `LogicEdge.confidence` 추가 ✅ (이전 PR)
- [x] **1-3** `src/types.ts` — `toRelation()` fallback 제거 → 10종 외 즉시 throw ✅ (이전 PR)
- [x] **1-4** `src/engine/serial-pipeline.ts` — `extractPropositions` 프롬프트 재설계
  - AI 응답에 `source_span.text` (원문 인용구) 필수 포함 요청
  - `source_span.text`가 빈 문자열이면 해당 명제 Reject
- [x] **1-5** `src/engine/serial-pipeline.ts` — `extractEdges` 프롬프트 재설계
  - 10종 중 하나만 선택 강제 (자유 서술 금지)
  - `axiom_basis` (엣지 타입 선택 근거 원문) 필수 포함
  - `axiom_basis`가 빈 문자열이면 해당 엣지 Reject
- [x] **1-6** `src/engine/serial-pipeline.ts` — confidence 임계값 필터
  - `confidence < 0.75` 엣지 자동 소거
  - 소거 후 노드가 고립되어도 **폴백 연결 없음** → Phase 7 Orphan Queue에서 처리
- [x] **1-7** `src/engine/graph-store.ts` — `createPropositionBatch()` 저장 전 밸리데이션 게이트
  - `source_span.text` 빈 문자열 → 명제 건너뜀 (warn 로그)
  - `confidence`/`axiom_basis` LogicEdge → TBEdge 전파
  - `toRelation()` throw 전파 (10종 외 저장 불가)
  - `origin: 'user_synthesized'`인 노드는 `source_span` 검증 면제
  - `tb_source_span` 프론트매터 저장
- [x] **1-8** `src/styles.css` — 10종 엣지별 고유 색상/패턴 범례 (Axis별 색상 분류)

---

## Phase 2 (v2) — 모순 감지 & 3옵션 해소 UI

> `conflicts_with` 엣지는 에러가 아닌 진화의 트리거.
> 유저가 선택한 해소 경로는 즉시 액션 그래프(Phase 8)에 ActionNode로 기록된다.

- [x] **2-1** `src/types.ts` — `ConflictReport`, `ContradictionResolutionType`, `ContradictionResolution` 인터페이스 ✅ (이전 PR)
- [x] **2-2** `src/engine/contradiction-engine.ts` 신규
  - 인제스트 완료 후 볼트 스캔: 신규 명제 ↔ 기존 명제 `conflicts_with` 자동 감지
  - 출력: `ConflictReport[]`
- [x] **2-3** `src/view.ts` — `ContradictionModal` 신규
  - 충돌 두 명제 병렬 표시 (붉은 강조 배경)
  - 3가지 해소 옵션 버튼 강제 (모달 닫기 불가, 반드시 선택)
    1. "명제 A 폐기" → `tb_discarded: true` 마킹 (삭제 X)
    2. "명제 B 폐기" → 동일
    3. "상위 전제 추가" → 텍스트 입력창 → 새 `precondition_of` 노드 생성 (`origin: 'user_synthesized'`)
  - 선택 완료 → `ContradictionResolution` 객체 생성
- [x] **2-4** `src/graph-store.ts` — `conflicts_with` 엣지 저장 시 `tb_conflict: true` 프론트매터
- [x] **2-5** `src/styles.css` — 모순 카드 붉은 링 + 점멸 애니메이션 (`.tb-conflict` 클래스)

---

## Phase 3 & 4 (v2) — 희소 인접 텐서 엔진 + 온더플라이 추이성 증명

> $T \in \mathbb{R}^{N \times N \times 10}$ 희소 텐서 구축.
> 전체 Warshall $O(V^3)$ 금지. 쿼리 시점 BFS $O(V + E)$ 목표.
> 추이성은 `causes`, `precedes` 축에만 적용.

- [x] **3-1** `src/engine/adjacency-tensor.ts` 신규 — `SparseAdjacencyTensor` 빌더
  - 볼트 TBNode[] 로드 → 노드 인덱싱 → `SparseEdgeEntry[]` 구성 (10레이어)
  - confirmed=true 엣지만 포함, confidence 가중치 저장
  - 증분 업데이트: `addNodeToTensor()` O(E_new)
- [x] **3-2** `src/engine/adjacency-tensor.ts` — 온더플라이 BFS 쿼리
  - `findPath(tensor, srcId, dstId, maxHops, layerFilter?)` → `GraphPath`
  - `reachableFrom(tensor, srcId, hops, layerFilter?)` → Set<string>
  - layerFilter로 특정 축만 탐색 가능
- [x] **3-3** `src/engine/adjacency-tensor.ts` — 추이성 온더플라이 (`causes`, `precedes` 레이어만)
  - `findTransitivePaths()` — 2홉 이상 간접 체인만 `isTransitive=true`로 반환
  - 볼트 저장 안 함 (읽기 전용 추론 레이어)
  - PathFinderModal 확인 버튼 → `store.confirmEdge()` 로 볼트 저장
- [x] **3-4** `src/view.ts` — "⊛ 경로 탐색" 버튼 + `PathFinderModal`
  - 폴더/출발/도착/홉 입력 → BFS 경로 카드 표시 (홉·신뢰도·ms 표기)
  - 추이 경로: 점선 보라 테두리 + "추이 추론" 배지 + 볼트 저장 버튼
  - 노드 클릭 → Obsidian에서 해당 파일 열기
- [x] **3-5** 성능: BFS O(V+E), 인접 리스트 레이지 빌드, 전체 Warshall 없음

---

## Phase 5 (v2) — 위상 동형성 근사 탐지

> NP-Complete 완전 계산 금지.
> 특징 벡터 + 코사인 유사도 휴리스틱으로 도메인 교차 영감 근사.

- [x] **5-1** `src/engine/isomorphism-engine.ts` 신규 — `TopologyFeatureVectorV2` 추출
  - 노드별: 진입/진출 차수, 클러스터링 계수, 10축 엣지 타입 분포
  - `EDGE_AXES` 레이어별 가중치 분리
- [x] **5-2** `src/engine/isomorphism-engine.ts` — 폴더 간 서브그래프 코사인 유사도 비교
  - `compareSubgraphs(folderA, folderB, topK)` → `IsomorphismCandidate[]` 반환
  - Phase 12 (v1) `TopologyFeatureVector` 통합/대체
- [x] **5-3** `src/view.ts` — "위상 동형 근사" 접이식 카드 (브리지 결과 하단)
  - 코사인 유사도 % + 노드 쌍 설명
  - 명칭: "위상 동형성 근사 (NP-Complete 근사 · 코사인 유사도)" UI에 명시

---

## Phase 6 (v2) — 역추적 투명성 레이어

> 모든 명제는 `source_span`, 모든 엣지는 `axiom_basis`로 원시 텍스트 100% 역추적.
> 누락 시 파이프라인 Reject (Phase 1에서 게이트 구현, 여기서는 UX 완성).

- [x] **6-1** `src/graph-store.ts` — `tb_source_span` 프론트매터 저장 (axiom_basis는 tb_edges JSON에 내포)
- [x] **6-2** `src/view.ts` — 명제 카드에 "출처 보기" 토글
  - 클릭 시 `source_span.text` 원문 인용구 팝업 (노란 형광펜 스타일)
- [x] **6-3** `src/view.ts` — 엣지 관계 칩에 `axiom_basis` title 툴팁 (hover)
- [x] **6-4** `src/view.ts` — `source_span` 누락 명제는 "출처 없음" 배지 (빨간)

---

## Phase 7 (v2) — NodeSalience & Orphan Queue

> 고립 노드는 소외가 아닌 신호다.
> 중요도 판단을 연결된 노드(구조적 중심성)와 고립 노드(구조적 고유성) 두 트랙으로 분리한다.
> 시간 경과에 따른 중요도 감소(소프트 망각) 금지.

### 데이터 모델

- [x] **7-1** `src/types.ts` — `NodeSalienceScore` 인터페이스 추가
  ```typescript
  interface NodeSalienceScore {
    structuralCentrality: number; // degree + coreness 기반 (연결 노드용)
    semanticNovelty: number;      // 기존 연결 노드 태그 집합과의 비유사도 (고립 노드용)
    typeWeight: number;           // insight=1.0, claim=0.9, ...
    composite: number;            // 두 트랙 가중 평균
    isOrphan: boolean;            // degree === 0
  }
  ```

### 엔진

- [x] **7-2** `src/engine/topology-engine.ts` — `computeSemanticNovelty()` 추가
  - 입력: 대상 노드 태그 집합 + 볼트 내 연결 노드 전체 태그 합집합
  - 출력: Jaccard 비유사도 (1 - 유사도). 기존 태그와 겹칠수록 낮음
  - 고립 노드에만 적용 (connected 노드는 structuralCentrality 사용)
- [x] **7-3** `src/engine/topology-engine.ts` — `computeNodeSalience()` 추가
  - connected 노드: `composite = typeWeight × 0.4 + structuralCentrality × 0.6`
  - orphan 노드: `composite = typeWeight × 0.5 + semanticNovelty × 0.5`
  - **시간 기반 가중치 일절 없음**
- [ ] **7-4** `src/engine/topology-engine.ts` — `filterCandidatePairs()` 계층화 샘플링으로 교체
  - 현재: 상위 K개 단순 score 정렬
  - 변경: 상위 K/2 (structuralCentrality 기준) + 상위 K/2 (semanticNovelty 기준, degree ≤ 1 노드에서만)
  - 고립 노드의 브리지 후보 진입 구조적 보장

### UI

- [x] **7-5** `src/view.ts` — Orphan Queue 모달 (`OrphanQueueModal`) — "🗂 Orphan Queue" 버튼
  - degree=0 노드 목록: `semanticNovelty` 내림차순 정렬
  - 각 카드: [제목] [타입 배지] [신규성 %]
  - degree=1 노드(약결합) 별도 섹션
- [x] **7-6** `src/styles.css` — Orphan Queue 스타일 (`.tb-orphan-card`, `.tb-novelty-badge`)

---

## Phase 8 (v2) — 액션 그래프 레이어 (Pragmatic Layer)

> 명제 그래프(is, 진리 주장)와 액션 그래프(ought, 행동 지시)를 엄격히 분리한다.
> 액션은 명제를 동기(Motivation)로 연결하지만 동일한 엣지 공리계를 공유하지 않는다.
> 모순 해소 선택 → ActionNode 자동 생성 연동 (Phase 2).

### 데이터 모델

- [x] **8-1** `src/types.ts` — `ActionNode`, `ActionLink`, `ActionLinkType`, `ActionStatus` 추가
  ```typescript
  type ActionStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

  // 액션 ↔ 명제 연결 (공리계와 무관한 별도 관계)
  type ActionLinkType =
    | 'resolves_conflict'   // conflicts_with 모순을 해소하기 위한 액션
    | 'implements'          // 명제를 실현하는 액션
    | 'investigates'        // 불확실한 명제를 조사하는 액션
    | 'depends_on';         // 다른 액션 선행 필요

  interface ActionNode {
    id: string;
    title: string;
    content: string;
    owner?: string;
    deadline?: string;        // ISO 8601
    status: ActionStatus;
    motivation_ids: string[]; // 동기가 된 Proposition/ActionNode ID 목록
    link_type: ActionLinkType;
    origin: 'extracted' | 'user' | 'from_resolution'; // 파이프라인/직접입력/모순해소
    created: string;
    filePath: string;
  }
  ```

### 파이프라인

- [x] **8-2** `src/engine/serial-pipeline.ts` — `extractActions()` v2 재작성
  - 추출 대상: 행동 지시, 해야 할 일, 결정 사항, 담당자, 기한
  - 출력: `ActionNode[]` (status='pending', origin='extracted')
  - `motivation_ids`: 명제 title → id 매핑 (LLM 응답에서 직접)
- [x] **8-3** `src/engine/serial-pipeline.ts` — `linkActionsToPropositions()` 추가
  - motivation_ids 없는 액션만 LLM으로 재매핑 (단일 추가 호출)

### 모순 해소 연동

- [x] **8-4** `src/engine/contradiction-engine.ts` — `createActionFromResolution()` 추가
  - `ContradictionResolution` 수신 → `ActionNode` 자동 생성
  - `discard_a/b` → title="[검토] {명제} 폐기 처리", link_type='resolves_conflict'
  - `add_precondition` → title="[상위전제 생성] ...", link_type='resolves_conflict'
  - origin='from_resolution', status='pending'
  - `applyResolution()` 말미에 자동 연결

### 저장

- [x] **8-5** `src/engine/graph-store.ts` — `createActionNode()`, `updateActionStatus()`, `updateActionMeta()`, `loadActionNodes()`, `loadAllActionNodes()` 추가
  - 저장 폴더: `{parentFolder}/_actions/` (명제 노드와 물리적으로 분리)
  - 프론트매터: `tb_action_id`, `tb_action_status`, `tb_action_owner`, `tb_action_deadline`, `tb_action_link_type`, `tb_action_origin`, `tb_action_motivation_ids`

### UI

- [x] **8-6** `src/view.ts` — ACTION 탭 추가 (INGEST / ACTION 2탭)
  - 상단: 상태별 카운트 배지 (대기 N / 진행 N / 완료 N / 차단 N)
  - 액션 카드: [제목] [상태 드롭다운] [담당자] [기한] [동기 명제 링크]
  - "동기 명제" 클릭 → 해당 명제 노드 Obsidian에서 열기
  - 모순 해소 액션: `⚡ 모순해소` 배지 / AI 추출: `AI 추출` 배지
  - 인제스트 저장 후 extractAndSaveActions() 백그라운드 실행
- [x] **8-7** `src/styles.css` — 액션 탭 스타일
  - 탭 바: `.tb-tab-bar`, `.tb-tab.is-active` (보라 언더라인)
  - 상태별 색상: pending(회색), in_progress(파랑), done(초록), blocked(빨강)
  - `.tb-action-card`, `.tb-action-status-sel`, `.tb-action-badge-conflict`

---

## 세션 외 추가 개발 기록

### UX / UI 개선

- [x] 출처 보기 버튼 pill chip + 슬라이드 애니메이션 리디자인 (`.tb-source-toggle`, `.tb-source-box`)
- [x] 파일명 특수문자 전체 정제 — `cleanNodeTitle()` Obsidian 금지 문자 `[\\/:*?"<>|#^[\]]` 제거
- [x] 온보딩 모달 — 최초 실행 시 AI 제공자 선택 (Gemini / Claude API / Claude Code), X·ESC 비활성화
- [x] 도네이션 QR 코드 헤더 추가 (🍦 버튼 + 팝업, `donate-qr.ts`)
- [x] AI 작업 중 버튼 전체 비활성화 — `setBusy()` → `ingestBtn` / `analysisBtn` / `bridgeBtn` 동시 잠금
- [x] 메인 버튼 4개 2×2 그리드 + 이름 단순화 (✦ 생성 / 🔍 분석 / ⊕ 그래프 / 🌉 연결)
- [x] 텍스트 입력 영역 2배 확장 (`min-height: 96→192px`, `max-height: 200→400px`)

### 파이프라인 / AI 연동

- [x] `completeEdges` 멀티 프로바이더 수정 — `callClaude` → `callClaudeWithModel` (Gemini/Claude API 지원)
- [x] `summarizeSubgraph` / `summarizeFolder` 멀티 프로바이더 수정 — `cliBin` → `settings` 파라미터
- [x] 양방향 엣지 중복 차단 로직 수정 — A→B 차단 시 B→A는 허용

### Architect 모드 제거

- [x] `ingestMode` 드롭다운 / Architect 전용 로직 / `showLogicEdgeSelection` 전부 제거
- [x] 인제스트 버튼 단일화 (Auto 모드 고정)

### 분석 기능 고도화

- [x] AnalysisModal — 5가지 분석 목적 프리셋 칩 (핵심 파악 / 모순 탐지 / 행동 도출 / 비교 분석 / 브리핑 준비)
- [x] AnalysisModal — 직접 입력 textarea + 모드 자동 추천
- [x] AnalysisModal — `_actions` 폴더 포함 옵션 (해당 폴더에 `_actions` 있을 때만 체크박스 표시)
- [x] AnalysisModal — 폴더 드롭다운에서 `_actions` 폴더 제외
- [x] `SummaryResult` — `synthesis` 필드 추가 (인과 구조 기반 종합 결론)
- [x] `SYSTEM_SUMMARY` 프롬프트 전면 재작성 — 메타 언어 금지, "노드A [relation] 노드B → 의미" 형식 강제
- [x] `AnalysisResultModal` 신규 — 분석 완료 즉시 모달 오픈, synthesis 최상단 고정, 섹션 아코디언
- [x] 모달 헤더 — 분석 모드 pill + 사용자 목적 표시
- [x] 분석 결과 저장 파일명 — `모드+intent` 포함으로 중복 방지 (`깊은분석_모순탐지_2026-06-27`)
- [x] 저장 파일 내 `종합 결론` 섹션 추가
