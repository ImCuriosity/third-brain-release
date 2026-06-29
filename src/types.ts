// ============================================================
// ThirdBrain v2 — 핵심 타입 정의
// 4축 텐서 공리계 기반 무모순 지식 그래프
// ============================================================

// ── 노드 타입 ─────────────────────────────────────────────

/** Proposition role (v0 포팅) + v1 추가 역할 */
export type PropositionRole =
	| 'insight'       // 핵심 인사이트 (cross-cut 허브 노드)
	| 'claim'         // 핵심 주장
	| 'premise'       // 전제
	| 'conclusion'    // 결론
	| 'example'       // 예시
	| 'contrast'      // 대조
	| 'application';  // 응용

export type TBNodeType =
	| PropositionRole
	| 'context'       // 원본 문맥 단위 (명제·액션의 precondition)
	| 'action'        // 액션 아이템
	| 'summary'       // 컨텍스트 요약
	| 'core';         // 레거시 호환 (= claim과 동치)

// ── 엣지 ─────────────────────────────────────────────────

/**
 * 4축 10관계 이항 공리계 (Binary Relation Axiom System)
 *
 * Axis 1 — 인과·전제 (방향성 엔진):   causes | precedes | precondition_of
 * Axis 2 — 진리·증명 (모순 탐지):     supports | conflicts_with | contrasts_with
 * Axis 3 — 계층·적용 (구체화):         exemplifies | applies_to
 * Axis 4 — 위상 교차 (도메인 초월):   analogous_to | isomorphic_to
 *
 * 이 10종 외의 엣지는 런타임에서 throw 처리.
 */
export type TBEdgeRelation =
	// Axis 1
	| 'causes'
	| 'precedes'
	| 'precondition_of'
	// Axis 2
	| 'supports'
	| 'conflicts_with'
	| 'contrasts_with'
	// Axis 3
	| 'exemplifies'
	| 'applies_to'
	// Axis 4
	| 'analogous_to'
	| 'isomorphic_to';

export const EDGE_AXES: Record<string, TBEdgeRelation[]> = {
	causal:       ['causes', 'precedes', 'precondition_of'],
	truth:        ['supports', 'conflicts_with', 'contrasts_with'],
	hierarchy:    ['exemplifies', 'applies_to'],
	topological:  ['analogous_to', 'isomorphic_to'],
};

/** 모순 탐지 대상 관계 (Axis 2 중 충돌 의미를 가진 것) */
export const CONFLICT_RELATIONS = new Set<TBEdgeRelation>(['conflicts_with']);

/** 추이성 전파 대상 관계 (Axis 1의 인과·순서 체인에만 적용) */
export const TRANSITIVE_RELATIONS = new Set<TBEdgeRelation>(['causes', 'precedes']);

/** 인접 텐서 레이어 인덱스 (10개 관계 → 인덱스 0~9) */
export const ALL_RELATIONS: TBEdgeRelation[] = [
	'causes', 'precedes', 'precondition_of',
	'supports', 'conflicts_with', 'contrasts_with',
	'exemplifies', 'applies_to',
	'analogous_to', 'isomorphic_to',
];

const VALID_RELATIONS = new Set<TBEdgeRelation>(ALL_RELATIONS);

export function toRelation(raw: string): TBEdgeRelation {
	if (VALID_RELATIONS.has(raw as TBEdgeRelation)) return raw as TBEdgeRelation;
	throw new Error(`[ThirdBrain] Invalid edge relation: "${raw}". Must be one of ${ALL_RELATIONS.join(', ')}`);
}

// 2.5차 큐레이션: confirmed=false → AI 제안, confirmed=true → 유저 확정
export interface TBEdge {
	target: string;            // 대상 파일 경로 또는 위키링크
	label: TBEdgeRelation;
	confirmed: boolean;
	reason: string;            // 연결 근거 (없으면 빈 문자열)
	confidence: number;        // 퍼지 논리 신뢰도 0.0~1.0 (기본 임계값 0.75)
	axiom_basis: string;       // 엣지 타입 선택의 논리적 근거 (원시 텍스트 인용)
}

// ── 볼트 저장 노드 ────────────────────────────────────────

export interface TBNode {
	id: string;
	title: string;
	type: TBNodeType;
	content: string;
	summary?: string;         // tb_summary 프론트매터
	tags: string[];
	folder: string;
	created: string;          // ISO 8601
	edges: TBEdge[];
	filePath: string;         // vault 내 경로
	is_core_concept?: boolean; // 추상 허브 판별용 (tb_is_core 프론트매터)
	source_span?: SourceSpan; // 원문 역추적 (ingested 노드에 필수)
}

// ── 파이프라인 레이어 타입 (v0 포팅) ─────────────────────

/** 1차: 문맥 정제 결과 (의미 단위별) */
export interface ContextLayer {
	id: string;          // ctx-{sanitized-title}-{timestamp}
	title: string;
	date: string;        // YYYY-MM-DD
	summary: string;     // 정제된 마크다운
	tags: string[];
	keywords: string[];
}

/** 원시 텍스트 출처 스팬 (역추적 투명성 레이어) */
export interface SourceSpan {
	text: string;    // 원시 입력에서 인용한 근거 텍스트 (빈 문자열이면 저장 거부)
	offset: number;  // 원시 입력 내 문자 오프셋
}

/** 2차: 명제 (단일 검증 가능한 주장) */
export interface Proposition {
	id: string;                 // p1, p2, ...
	title: string;              // 짧은 명사구 (≤40자)
	text: string;               // 명제 본문 (한 문장)
	role: PropositionRole;
	context: string;            // 소속 문맥 단위 제목 (없으면 빈 문자열)
	is_core_concept: boolean;   // 핵심 개념 여부 (최대 2개)
	source_span: SourceSpan;    // 원문 역추적 (필수 — 누락 시 파이프라인 Reject)
}

/** 2차: 명제 간 방향 논리 엣지 */
export interface LogicEdge {
	source: string;          // proposition id
	target: string;          // proposition id
	relation: TBEdgeRelation;
	reason: string;          // 관계 근거 (없으면 빈 문자열)
	axiom_basis: string;     // 엣지 타입 선택 근거 원문 (필수 — 누락 시 파이프라인 Reject)
	confidence: number;      // 퍼지 논리 신뢰도 0.0~1.0 (0.75 미만 자동 소거 + 고립 방지 폴백)
}

/** 1.5차: 핵심 인사이트 (문맥을 관통하는 핵심 발견) */
export interface Insight {
	id: string;           // ins1, ins2, ...
	title: string;        // 인사이트 제목
	why_central: string;  // 핵심인 이유 (한 문장)
}

/** 2차 파이프라인 결과 */
export interface LogicLayer {
	propositions: Proposition[];
	edges: LogicEdge[];
}

/** 3차: 액션 아이템 */
export interface ActionNetResult {
	action_nodes: Array<{
		title: string;
		content: string;
		priority: 'high' | 'medium' | 'low';
	}>;
}

/** 인제스트 세션 전체 결과 */
export interface IngestResult {
	sessionId: string;    // YYYYMMDDHHMMSS
	createdAt: string;    // ISO 8601
	contexts: ContextLayer[];
	logic: LogicLayer;
	actions: ActionNetResult;
	recommendations: EdgeCandidate[];
}

// ── 4차: 외부 엣지 추천 (vault 기존 파일) ────────────────

export interface EdgeCandidate {
	target_file: string;
	label: TBEdgeRelation;
	reason: string;
	source_node: string;   // 출발 명제 제목 (없으면 빈 문자열)
}

// ── 폴더 브리지 (Phase 5, v0 포팅) ───────────────────────

export interface FolderBridgeNode {
	file: string;
	label: string;
	summary?: string;
}

export interface BridgeEdge {
	source_file: string;
	target_file: string;
	source_title?: string;
	target_title?: string;
	relation: TBEdgeRelation;
	confidence?: number;
	reason: string;
}

export interface FolderBridgeResult {
	edges: BridgeEdge[];
	insight: string;
}

// ── Phase 12: 폴더 브리지 위상학적 최적화 ─────────────────

export interface TopologyFeatureVector {
	degree: number;                   // confirmed 엣지 수 (in + out)
	coreness: number;                 // is_core_concept ? 1 : 0
	typeWeight: number;               // 타입별 가중치
	tagFingerprint: string[];         // 정규화된 태그 배열
	outRelations: TBEdgeRelation[];   // 나가는 confirmed 엣지의 relation 배열
}

export interface BridgeCandidatePair {
	nodeA: TBNode;
	nodeB: TBNode;
	score: number;
	scoreBreakdown: {
		tagOverlap: number;
		typeAffinity: number;
		relationalPattern: number;
		coreness: number;
	};
}

export interface TopologyFilterConfig {
	topKPerNode: number;          // 노드당 최대 후보 수 (기본 3)
	minScore: number;             // 최소 점수 임계값 (기본 0.15)
	maxCandidatePairs: number;    // LLM에 보낼 최대 총 쌍 수 (기본 20)
	useConfirmedEdgesOnly: boolean; // confirmed=true 엣지만 사용
}

// ── 뷰어: 서브그래프 요약 (Phase 8 / 풍부한 분석) ──────────

export interface SummaryTheme {
	title: string;
	description: string;
}

export interface SummaryLinkContext {
	source: string;
	target: string;
	relation: string;
	context: string;
}

export interface SummaryResult {
	synthesis: string;
	overview: string;
	themes: SummaryTheme[];
	highlights: string[];
	link_contexts: SummaryLinkContext[];
}

// ── 노드 이식: AI 분류 결과 ──────────────────────────────

export interface NodeClassification {
	title: string;
	type: TBNodeType;
	tags: string[];
	summary: string;
}

// ── 서브그래프 캐시 ───────────────────────────────────────

export interface SubgraphCache {
	keyword: string;
	radius: number;
	nodes: TBNode[];
	cachedAt: number;
}

// ── v2: 3차원 인접 텐서 T ∈ R^{N×N×10} ─────────────────────
// 전체 Warshall O(V³) 금지. 희소 구조 + 쿼리 시점 온더플라이 BFS 사용.

/** 희소 인접 텐서의 단일 엣지 엔트리 */
export interface SparseEdgeEntry {
	from: number;              // 노드 인덱스
	to: number;                // 노드 인덱스
	layerIdx: number;          // ALL_RELATIONS 기준 관계 인덱스 (0~9)
	confidence: number;        // 0.0~1.0
}

/**
 * 희소 3차원 인접 텐서
 * - nodeIndex: nodeId → 행렬 인덱스 매핑
 * - edges: 실제 연결 목록 (0이 아닌 엔트리만 저장)
 * - layerMasks: 레이어별 adjacency Set<from*N+to> (빠른 존재 확인)
 */
export interface SparseAdjacencyTensor {
	nodeIndex: Map<string, number>;   // nodeId → 인덱스
	indexNode: string[];              // 인덱스 → nodeId
	edges: SparseEdgeEntry[];
	layerMasks: Set<number>[];        // length = 10
	nodeCount: number;
}

/** 온더플라이 경로 탐색 결과 */
export interface GraphPath {
	nodes: string[];           // nodeId 체인
	relations: TBEdgeRelation[];
	totalConfidence: number;   // 경로 상 confidence 곱
	isTransitive: boolean;     // 추이성 추론으로 도출된 경로인지
}

// ── v2: 모순 감지 & 해소 ────────────────────────────────────

/** conflicts_with 엣지 감지 결과 */
export interface ConflictReport {
	nodeA: TBNode;
	nodeB: TBNode;
	relation: 'conflicts_with';
	evidence: string;          // 충돌 근거 (axiom_basis 기반)
	detectedAt: string;        // ISO 8601
}

/** 유저에게 강제 제시하는 3가지 수학적 해소 옵션 */
export type ContradictionResolutionType =
	| 'discard_a'           // 명제 A 폐기 (거짓 판별)
	| 'discard_b'           // 명제 B 폐기 (거짓 판별)
	| 'add_precondition';   // 상위 precondition_of 노드 추가 (두 모순을 포괄하는 새 전제)

export interface ContradictionResolution {
	conflictId: string;
	resolution: ContradictionResolutionType;
	newPreconditionText?: string;   // 'add_precondition' 선택 시 유저가 입력한 전제 텍스트
}

// ── v2: 위상 동형성 근사 (Topological Isomorphism Approximation) ──
// 서브그래프 동형성은 NP-Complete. 특징 벡터 + 코사인 유사도 휴리스틱으로 근사.

export interface TopologyFeatureVectorV2 {
	nodeId: string;
	inDegree: number;
	outDegree: number;
	clusteringCoeff: number;        // 실제 연결 / 가능한 최대 연결
	edgeTypeDistribution: number[]; // length=10, 각 축별 비율
	isHub: boolean;
}

export interface IsomorphismCandidate {
	subgraphA: string[];            // nodeId[]
	subgraphB: string[];            // nodeId[]
	cosineSimilarity: number;       // 0.0~1.0
	explanation: string;
}

// ── v2: NodeSalience — 이중 트랙 중요도 점수 (Phase 7) ──────
// connected 노드: structuralCentrality. orphan 노드: semanticNovelty.
// 시간 기반 감소 없음 (소프트 망각 금지).

export interface NodeSalienceScore {
	nodeId: string;
	structuralCentrality: number; // degree + coreness 기반 (연결 노드용)
	semanticNovelty: number;      // 볼트 연결 노드 태그 집합과의 Jaccard 비유사도 (고립 노드용)
	typeWeight: number;           // insight=1.0, claim=0.9, premise=0.8, 나머지=0.7
	composite: number;            // 가중 평균 (connected: 0.4×type+0.6×central, orphan: 0.5×type+0.5×novelty)
	isOrphan: boolean;            // degree === 0
}

// ── v2: 액션 그래프 레이어 (Phase 8) ─────────────────────────
// 명제 그래프(is, 진리 주장)와 분리된 실천 레이어.
// 명제는 공리계(10종 엣지)로 연결; 액션은 ActionLinkType으로 연결.

export type ActionStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export type ActionLinkType =
	| 'resolves_conflict'  // conflicts_with 모순 해소를 위한 액션
	| 'implements'         // 명제를 실현하는 액션
	| 'investigates'       // 불확실 명제를 조사하는 액션
	| 'depends_on';        // 다른 액션 선행 필요

export interface ActionLink {
	targetId: string;        // 연결 대상 ActionNode 또는 Proposition ID
	linkType: ActionLinkType;
	note?: string;
}

export interface ActionNode {
	id: string;
	title: string;
	content: string;
	owner?: string;
	deadline?: string;           // ISO 8601
	status: ActionStatus;
	motivation_ids: string[];         // 동기가 된 Proposition ID 목록
	motivation_context_ids: string[]; // 동기가 된 ContextLayer(TBNode) ID 목록
	link_type: ActionLinkType;
	origin: 'extracted' | 'user' | 'from_resolution';
	created: string;             // ISO 8601
	filePath: string;
}

// ── 플러그인 설정 ─────────────────────────────────────────

export type AIProvider = 'claude-cli' | 'claude-api' | 'gemini';

export interface ThirdBrainSettings {
	rootFolder: string;               // 모든 ThirdBrain 파일의 최상위 폴더
	cliBin: string;
	maxEdgeCandidates: number;
	aiProvider: AIProvider;           // AI 제공자 선택
	claudeApiKey?: string;            // Claude API 키
	geminiApiKey?: string;            // Gemini API 키
	bridgeTopKPerNode?: number;       // 폴더 브리지 위상 필터링 - 노드당 후보 수 (기본 3)
	onboardingComplete?: boolean;     // 최초 설정 완료 여부
	lang?: 'en' | 'ko';              // UI 및 AI 출력 언어
}

export const DEFAULT_SETTINGS: ThirdBrainSettings = {
	rootFolder: 'ThirdBrainRoot',
	cliBin: 'claude',
	maxEdgeCandidates: 3,
	aiProvider: 'claude-cli',
	bridgeTopKPerNode: 3,
	onboardingComplete: false,
	lang: 'en',
};
