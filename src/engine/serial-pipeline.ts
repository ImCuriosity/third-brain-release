// ============================================================
// ThirdBrain v2 — 직렬 파이프라인
//  0차: distillText()           — 대용량 입력 핵심 압축 (유저 확인 후 실행)
//  1차: extractContexts()       — 의미 단위 분절
//  1.5차: extractInsights()     — 문맥을 관통하는 핵심 인사이트 2~4개
//  2차: extractPropositions()   — 인사이트 가이드 하 명제 추출 (엣지 없음)
//  2.5차: extractEdges()        — 문맥 보존 엣지 추출 (인사이트 앵커 활용)
//  4차: generateEdgeCandidates() — vault 외부 파일 연결 추천
//  뷰어: summarizeSubgraph()   — 폴더 핵심 서브그래프 요약 (풍부한 분석)
// ============================================================

import { callClaude, callClaudeWithModel, type ModelTier } from './cli-bridge';
import { toRelation } from '../types';
import type {
	ContextLayer,
	Insight,
	Proposition,
	LogicEdge,
	LogicLayer,
	ActionNetResult,
	EdgeCandidate,
	IngestResult,
	PropositionRole,
	FolderBridgeNode,
	BridgeEdge,
	FolderBridgeResult,
	SummaryResult,
	ThirdBrainSettings,
	TBNode,
	TBEdgeRelation,
	TopologyFilterConfig,
	NodeClassification,
	ActionNode,
	ActionLinkType,
} from '../types';
import {
	filterCandidatePairs,
	formatCandidatesForPrompt,
} from './topology-engine';

export const DISTILL_THRESHOLD = 10000;  // 압축 분할 기준 높여서 덜 압축하도록

// ── 0차: 대용량 입력 핵심 압축 ───────────────────────────

const SYSTEM_DISTILL = `당신은 'Third-Brain'의 핵심 정제 엔진입니다.
입력 텍스트에서 '지식 그래프화에 필요한 핵심'만 남기고 압축합니다.

남길 것: 핵심 주장·사실·결정·인과/전제/결론·대조·핵심 고유명사·수치.
버릴 것: 중복, 수사, 잡담, 인사말, 서식 군더더기, 부수적 디테일.
분량: 원문의 약 1/4~1/3 수준으로 과감히 줄인다.
구조: 서로 다른 의미 단위(주제/안건/사건/장)가 여럿이면 소제목(## )으로 구분하고, 각 단위 아래 핵심을 간결한 불릿으로.
의미를 왜곡하거나 없는 내용을 지어내지 말 것.
모두 한국어. JSON만 반환(코드블록 없이): {"core":"압축된 마크다운 내용"}`;

export async function distillText(
	rawText: string,
	cliBin: string,
	onProgress?: (msg: string) => void
): Promise<string> {
	const chunks = splitIntoChunks(rawText, 8000);  // 청크 크기 축소 (더 자주 분할)
	const out: string[] = [];

	for (let i = 0; i < chunks.length; i++) {
		onProgress?.(`핵심 정제 중... (${i + 1}/${chunks.length} 조각)`);
		const prompt = `${SYSTEM_DISTILL}\n\n다음 텍스트의 핵심만 압축하라:\n\n"""\n${chunks[i]}\n"""`;
		try {
			const raw = await callClaude(prompt, cliBin);
			const result = parseJson<{ core?: string }>(raw, {});
			if (result.core) out.push(result.core);
		} catch {
			out.push(chunks[i].slice(0, 3000));
		}
	}

	return out.join('\n\n---\n\n').trim() || rawText.slice(0, 8000);
}

// ── 1차: 문맥 레이어 추출 ────────────────────────────────

const SYSTEM_CONTEXT = `당신은 'Third-Brain'의 문맥 정제 엔진입니다.
사용자의 Raw 텍스트(회의록/아이디어/메모/분석)를 받아 풍부한 문맥을 다층적으로 추출합니다.

★ 핵심 원칙: 단일 수준이 아닌 **다층적 독립 단위** 모두 찾기

분절 규칙:

1. 모든 구조 계층 분석:
   - # 제목 → 최상위 주제 (개별 context 후보)
   - ## 부제목 → 중간 주제 (개별 context 후보)
   - ### 소제목 → 세부 주제 (개별 context 후보)
   - - 항목 → 개별 항목 (개별 context 후보)

2. 카테고리도 독립 문맥 가능:
   - "회의", "프로젝트", "버그" 같은 분류명도 그 자체로 context 가능
   - 아래 항목들뿐만 아니라 분류 범주 자체도 추출

3. 다층성 극대화:
   - 최상위 주제 (예: "Phase 2 인제스트 파이프라인")
   - 중간 주제 (예: "UI-5 버튼 애니메이션")
   - 세부 항목 (예: "shimmer 그라데이션")
   - 모두 별도 context로 추출

4. 주제 간 관계도 문맥화:
   - "Phase 2는 Phase 1 완료 후 진행" → "의존성" context
   - "UI-30은 UI-31 용어 정의 필요" → "선행작업" context
   - 항목들의 교집합/연관성도 context 가능

5. 독립성 검증:
   - "이 블럭만 읽어도 완결된가?" YES → context
   - "다른 정보와 함께 읽어야 하나?" NO → context
   - 단, 관계도 명시적으로 context화

각 context:
- title: 단위를 대표하는 간결한 명사형 (1~10단어)
- date: 본문 날짜 또는 오늘
- summary: 핵심만 정돈된 마크다운 (5~15줄)
- tags: 분류 태그 2~8개(# 없이, 다양한 각도)
- keywords: 중요 키워드 3~12개 (관계어 포함: "의존", "선행", "연관", "파급")

★ 강제 규칙 (반드시 지킬 것):
- 텍스트에 ## 제목이 N개 있으면 → 최소 N개 context 추출
- 섹션이 없어도 최소 3개 이상 context로 분절
- context를 1개만 반환하는 것은 오답 — 반드시 거부하고 재분절
- 전체 문서를 하나의 context로 묶지 말 것

목표: 같은 텍스트에서 최소 3~5개 이상의 다층적 문맥 추출
모두 한국어. JSON만 반환(코드블록 없이).`;

export async function extractContexts(text: string, settings: ThirdBrainSettings): Promise<ContextLayer[]> {
	const today = new Date().toISOString().split('T')[0];
	const prompt =
		`${SYSTEM_CONTEXT}\n\n오늘 날짜: ${today}\n\n` +
		`다음 텍스트를 의미 단위별로 정제하라:\n\n` +
		`{"contexts":[{"title":"...","date":"YYYY-MM-DD","summary":"...","tags":["..."],"keywords":["..."]}]}\n\n` +
		`---\n\n${text}`;

	const raw = await callClaudeWithModel(
		prompt,
		settings.cliBin,
		'fast',
		settings.aiProvider,
		settings.claudeApiKey,
		settings.geminiApiKey
	);
	const parsed = parseJson<{ contexts?: Partial<ContextLayer>[] }>(raw, { contexts: [] });

	const list = Array.isArray(parsed.contexts) ? parsed.contexts : [];
	const mapped = list
		.filter(c => c && c.title && typeof c.summary === 'string' && c.summary.trim().length > 20)
		.map((c, i) => assignContextId({
			title: typeof c.title === 'string' ? c.title.trim() : '제목 없음',
			date: typeof c.date === 'string' ? c.date.trim() : today,
			summary: typeof c.summary === 'string' ? c.summary : '',
			tags: Array.isArray(c.tags)
				? (c.tags as string[]).filter(t => typeof t === 'string').slice(0, 6)
				: [],
			keywords: Array.isArray(c.keywords)
				? (c.keywords as string[]).filter(k => typeof k === 'string').slice(0, 10)
				: [],
		}, i));

	// LLM이 1개로 뭉쳤으면 더 강한 프롬프트로 재시도 (구조 무관, 내용 기반 분절)
	if (mapped.length <= 1) {
		return retryContextSplit(text, today, settings);
	}
	return mapped;
}

async function retryContextSplit(text: string, today: string, settings: ThirdBrainSettings): Promise<ContextLayer[]> {
	const prompt =
		`텍스트를 반드시 3~6개의 독립 의미 단위로 분절하라.\n` +
		`헤딩·제목이 없어도 된다. 주제 전환, 관점 변화, 시간 변화, 내용 범주 차이로 나눠라.\n` +
		`1개로 반환하는 것은 절대 허용하지 않는다.\n\n` +
		`JSON만 반환(코드블록 없이):\n` +
		`{"contexts":[{"title":"...","date":"${today}","summary":"...","tags":[],"keywords":[]}]}\n\n` +
		`텍스트:\n${text.slice(0, 6000)}`;

	try {
		const raw = await callClaudeWithModel(
			prompt,
			settings.cliBin,
			'fast',
			settings.aiProvider,
			settings.claudeApiKey,
			settings.geminiApiKey
		);
		const parsed = parseJson<{ contexts?: Partial<ContextLayer>[] }>(raw, { contexts: [] });
		const list = Array.isArray(parsed.contexts) ? parsed.contexts : [];
		const result = list
			.filter(c => c && c.title && typeof c.summary === 'string' && c.summary.trim().length > 20)
			.map((c, i) => assignContextId({
				title: typeof c.title === 'string' ? c.title.trim() : '단락',
				date: typeof c.date === 'string' ? c.date.trim() : today,
				summary: typeof c.summary === 'string' ? c.summary : '',
				tags: Array.isArray(c.tags) ? (c.tags as string[]).slice(0, 6) : [],
				keywords: Array.isArray(c.keywords) ? (c.keywords as string[]).slice(0, 10) : [],
			}, i));
		// 재시도도 실패하면 단락 기반 청크
		if (result.length <= 1) return chunkByParagraph(text, today);
		return result;
	} catch {
		return chunkByParagraph(text, today);
	}
}

function chunkByParagraph(text: string, today: string): ContextLayer[] {
	const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 30);
	if (paragraphs.length === 0) return [assignContextId({ title: '전체', date: today, summary: text.slice(0, 800), tags: [], keywords: [] }, 0)];
	const chunkSize = Math.ceil(paragraphs.length / 4);
	const chunks: ContextLayer[] = [];
	for (let i = 0; i < paragraphs.length; i += chunkSize) {
		const body = paragraphs.slice(i, i + chunkSize).join('\n\n');
		chunks.push(assignContextId({ title: `단락 ${chunks.length + 1}`, date: today, summary: body.slice(0, 800), tags: [], keywords: [] }, chunks.length));
	}
	return chunks;
}

function assignContextId(c: Omit<ContextLayer, 'id'>, index: number): ContextLayer {
	const slug = c.title.replace(/[^\wㄱ-힣]/g, '-').toLowerCase().slice(0, 30);
	return { id: `ctx-${slug}-${Date.now().toString(36)}-${index}`, ...c };
}

// ── 1.5차: 핵심 인사이트 추출 ────────────────────────────

const SYSTEM_INSIGHT = `당신은 'Third-Brain'의 핵심 인사이트 추출 엔진입니다.
여러 문맥 단위를 관통하는 핵심 통찰 2~4개를 추출합니다.

인사이트 기준:
- 단일 문맥에 국한되지 않고 전체 내용을 꿰뚫는 핵심 발견.
- "이 내용의 핵심이 무엇인가?"에 대한 답.
- 단순 요약·주제 레이블이 아닌, 발견적(aha-moment) 주장.
- 나머지 명제들이 이것을 향해 수렴하거나 이것에서 파생될 수 있어야 한다.

모두 한국어. JSON만 반환(코드블록 없이).`;

export async function extractInsights(contexts: ContextLayer[], cliBin: string): Promise<Insight[]> {
	const contextBlock = contexts
		.map((c, i) => `### 단위 ${i + 1}: ${c.title}\n${c.summary}`)
		.join('\n\n');

	const prompt =
		`${SYSTEM_INSIGHT}\n\n` +
		`다음 ${contexts.length}개 문맥 단위를 관통하는 핵심 인사이트를 추출하라:\n\n` +
		`{"insights":[{"id":"ins1","title":"인사이트 제목(10~25자)","why_central":"핵심인 이유 한 문장"}]}\n\n` +
		`---\n\n${contextBlock}`;

	try {
		const raw = await callClaude(prompt, cliBin);
		const parsed = parseJson<{ insights?: Partial<Insight>[] }>(raw, { insights: [] });
		return (Array.isArray(parsed.insights) ? parsed.insights : [])
			.filter(i => i && i.id && i.title)
			.slice(0, 4)
			.map((i, idx) => ({
				id: typeof i.id === 'string' ? i.id : `ins${idx + 1}`,
				title: String(i.title ?? '').trim().slice(0, 40),
				why_central: String(i.why_central ?? '').trim(),
			}));
	} catch {
		return [];
	}
}

// ── 2차: 명제 추출 (엣지 없음, 인사이트 가이드) ──────────

const ALLOWED_ROLES: readonly PropositionRole[] = [
	'claim', 'premise', 'conclusion', 'example', 'contrast', 'application',
] as const;

const SYSTEM_PROPOSITIONS = `당신은 'Third-Brain'의 명제 추출 엔진입니다.
문맥 단위(들)를 받아, 각 문맥 내 단위 명제만 추출합니다. 엣지는 추출하지 않는다.

명제 규칙:
- 각 명제: 하나의 검증 가능한 단일 주장.
- id: p1, p2, ... | title: 8~20자 명사구 | text: 완결된 한 문장
- role: claim | premise | conclusion | example | contrast | application
- context: 이 명제가 속한 문맥 단위 제목 (반드시 채울 것)
- is_core_concept: 각 문맥 내 핵심 명제만 true (최대 2~3개)
- source_span.text: 원문(summary)에서 이 명제를 뒷받침하는 구절을 그대로 인용 (반드시 비어 있지 않아야 함)
- source_span.offset: 인용 구절이 시작되는 문자 위치 (모르면 0)

★ source_span 규칙 (엄격):
- text가 빈 문자열("")이면 해당 명제는 무효다. 반드시 원문 구절을 인용하라.
- 없는 내용을 지어내지 말 것 — summary에서 실제로 근거가 되는 문장/구절만.

★ 구성 원칙:
1. 각 문맥 단위 안에서 premise→claim→conclusion 논리 사슬이 가능한 명제를 구성하라.
2. 독립적인 주장, 핵심 사실, 결론만 추출.
3. 총 명제 수: 문맥 단위당 3~6개, 전체 15개 초과 금지.

인사이트는 생성하지 마라. 일반 명제만 추출.
모두 한국어. JSON만 반환(코드블록 없이).`;

export async function extractPropositions(
	contexts: ContextLayer[],
	settings: ThirdBrainSettings
): Promise<Proposition[]> {
	const contextBlock = contexts
		.map((c, i) => {
			const keywords = c.keywords.length > 0 ? `\n【키워드】${c.keywords.join(', ')}` : '';
			return `### 단위 ${i + 1}: ${c.title}\n${c.summary}${keywords}`;
		})
		.join('\n\n');

	const schemaExample = `{"propositions":[{"id":"p1","title":"...","text":"...","role":"claim","context":"...","is_core_concept":false,"source_span":{"text":"원문 인용 구절","offset":0}}]}`;
	const prompt =
		`${SYSTEM_PROPOSITIONS}\n\n` +
		`다음 ${contexts.length}개 문맥 단위에서 명제를 추출하라:\n\n` +
		`${schemaExample}\n\n` +
		`---\n\n${contextBlock}`;

	const raw = await callClaudeWithModel(
		prompt,
		settings.cliBin,
		'fast',
		settings.aiProvider,
		settings.claudeApiKey,
		settings.geminiApiKey
	);
	type RawProp = Proposition & { source_span?: { text?: string; offset?: number } };
	const parsed = parseJson<{ propositions?: RawProp[] }>(raw, { propositions: [] });

	return (parsed.propositions ?? [])
		.filter(p => {
			if (!p || !p.id || !p.text) return false;
			const spanText = p.source_span?.text ?? '';
			return spanText.trim().length > 0; // source_span.text 빈 문자열 → Reject
		})
		.slice(0, 15)
		.map(p => ({
			id: String(p.id),
			title: String(p.title || p.text).trim().slice(0, 40),
			text: String(p.text).trim(),
			role: (ALLOWED_ROLES.includes(p.role as PropositionRole) ? p.role : 'claim') as PropositionRole,
			context: typeof p.context === 'string' ? p.context.trim() : '',
			is_core_concept: p.is_core_concept === true,
			source_span: {
				text: String(p.source_span?.text ?? '').trim(),
				offset: typeof p.source_span?.offset === 'number' ? p.source_span.offset : 0,
			},
		}));
}

// ── 2.5차: 엣지 추출 (명제 간 크로스-컨텍스트) ──────────

const SYSTEM_EDGES = `당신은 'Third-Brain'의 논리 엣지 추출 엔진입니다.
명제들 사이의 의미있는 연결을 찾아 방향 엣지를 추출합니다.

★ 관계 선택 (4축 10종 — 이 10종 외 절대 사용 금지):
Axis 1 (인과·전제): causes | precedes | precondition_of
Axis 2 (진리·증명): supports | conflicts_with | contrasts_with
Axis 3 (계층·적용): exemplifies | applies_to
Axis 4 (위상 교차): analogous_to | isomorphic_to

각 관계 선택 시 axiom_basis(선택 근거 원문 인용)를 반드시 작성하라.

★ 각 필드:
- source, target: 명제 ID (p1, p2, ...)
- relation: 위 10종 중 정확히 하나 선택
- reason: 연결 근거 한국어 한 문장
- axiom_basis: 이 relation을 선택한 논리적 근거 (원문 구절 인용 또는 이유 설명, 빈 문자열 금지)
- confidence: 이 연결의 확신도 0.0~1.0 (0.75 미만이면 저장 안 됨)

★ 중요:
- 고립 노드는 허용됨 — 억지 연결로 채우지 말 것. confidence가 0.75 미만이면 해당 엣지는 소거된다.
- 명확하게 성립하는 관계만 포함 (confidence >= 0.75 기준으로 자기 검토)
- conflicts_with는 실제 모순이 존재할 때만 사용

모두 한국어. JSON만 반환(코드블록 없이).`;

export async function extractEdges(
	allPropositions: Proposition[],
	contexts: ContextLayer[],
	_insights: Insight[], // 무시됨 (분석 단계에서만)
	settings: ThirdBrainSettings
): Promise<LogicEdge[]> {
	if (allPropositions.length < 2) return [];

	// 간단한 p1, p2, ... 형식으로 변환 (파싱 용이)
	const propBlock = allPropositions
		.map((p, idx) => {
			const ctx = p.context ? ` (${p.context})` : '';
			const text = p.title.slice(0, 80); // 제목만, 너무 길지 않게
			return `p${idx + 1} [${p.role}${ctx}]: ${text}`;
		})
		.join('\n');
	// 컨텍스트 요약은 reason 작성 힌트용 — 요약당 150자, 전체 1500자 제한
	const contextBlock = contexts
		.map(c => `- ${c.title}: ${c.summary.slice(0, 150)}`)
		.join('\n')
		.slice(0, 1500);

	const edgeSchema = `{"edges":[{"source":"p1","target":"p2","relation":"supports","reason":"...","axiom_basis":"이 관계를 선택한 근거 원문","confidence":0.85}]}`;
	const prompt =
		`${SYSTEM_EDGES}\n\n` +
		`[명제 목록]\n${propBlock}\n\n` +
		`[원본 문맥 요약 (reason/axiom_basis 근거로 활용)]\n${contextBlock}\n\n` +
		edgeSchema;

	type RawEdge = { source: string; target: string; relation: string; reason: string; axiom_basis?: string; confidence?: number };
	try {
		const raw = await callClaudeWithModel(
			prompt,
			settings.cliBin,
			'standard',
			settings.aiProvider,
			settings.claudeApiKey,
			settings.geminiApiKey
		);
		const parsed = parseJson<{ edges?: RawEdge[] }>(raw, { edges: [] });

		// p1, p2... → 원본 ID로 매핑
		const pIndexMap = new Map<string, string>();
		allPropositions.forEach((p, idx) => {
			pIndexMap.set(`p${idx + 1}`, p.id);
		});

		const seen = new Set<string>();

		return (parsed.edges ?? [])
			.map(e => {
				const source = pIndexMap.get(String(e.source)) || String(e.source);
				const target = pIndexMap.get(String(e.target)) || String(e.target);
				const confidence = typeof e.confidence === 'number' ? e.confidence : 0.0;
				const axiom_basis = typeof e.axiom_basis === 'string' ? e.axiom_basis.trim() : '';
				try {
					return { source, target, relation: toRelation(String(e.relation)), reason: String(e.reason ?? ''), axiom_basis, confidence };
				} catch {
					return null;
				}
			})
			.filter((e): e is NonNullable<typeof e> => {
				if (!e) return false;
				if (e.axiom_basis.length === 0) return false;  // axiom_basis 빈 문자열 → Reject
				if (e.confidence < 0.75) return false;         // confidence 임계값 필터 (폴백 없음)
				const hasSource = allPropositions.some(p => p.id === e.source);
				const hasTarget = allPropositions.some(p => p.id === e.target);
				if (!hasSource || !hasTarget) return false;
				if (e.source === e.target) return false;
				const key = `${e.source}→${e.target}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.map(e => ({
				source: e.source,
				target: e.target,
				relation: e.relation,
				reason: e.reason.trim(),
				axiom_basis: e.axiom_basis,
				confidence: e.confidence,
			}));
	} catch {
		return [];
	}
}

// ── 3차: 액션망 추출 ────────────────────────────────────

// ── Phase 8-2: 액션 추출 v2 ──────────────────────────────────

const SYSTEM_ACTIONS = `당신은 'Third-Brain'의 액션 그래프 추출 엔진입니다.
주어진 텍스트에서 "해야 할 일 / 행동 지시 / 결정 사항"만 추출하라.
사실 서술(is), 명제, 설명은 추출하지 마라 — 그것들은 명제 그래프에서 처리한다.
액션만 추출: 실행 가능하고, 담당자가 특정되거나 기한이 있거나, 구체적 행동을 기술하는 것.

JSON만 반환 (코드블록 없이):
{"actions": [
  {
    "title": "액션 제목 (동사로 시작, 30자 이내)",
    "content": "구체적 실행 방법",
    "owner": "담당자 (없으면 빈 문자열)",
    "deadline": "기한 ISO 8601 (없으면 빈 문자열)",
    "link_type": "implements | investigates",
    "motivation_prop_titles": ["동기가 된 명제 제목 배열"],
    "motivation_context_titles": ["이 액션이 속한 문맥 단위 제목 배열 (반드시 1개 이상)"]
  }
]}
액션이 없으면 {"actions": []}.`;

export async function extractActions(
	text: string,
	propositions: Proposition[],
	contexts: ContextLayer[],
	settings: ThirdBrainSettings
): Promise<Omit<ActionNode, 'filePath'>[]> {
	if (!text.trim()) return [];

	const propList = propositions.slice(0, 20)
		.map(p => `- "${p.title}"`)
		.join('\n');

	const ctxList = contexts
		.map(c => `- id:"${c.id}" 제목:"${c.title}"`)
		.join('\n');

	// 텍스트가 길면 앞부분(8000) + 뒷부분(7000)을 합쳐 액션 섹션 누락 방지
	const textForActions = text.length > 15000
		? text.slice(0, 8000) + '\n...(중략)...\n' + text.slice(-7000)
		: text;
	const prompt = `${SYSTEM_ACTIONS}\n\n텍스트:\n${textForActions}\n\n문맥 단위 목록:\n${ctxList || '(없음)'}\n\n명제 목록:\n${propList || '(없음)'}`;

	try {
		const raw = await callClaudeWithModel(
			prompt,
			settings.cliBin,
			'fast',
			settings.aiProvider,
			settings.claudeApiKey,
			settings.geminiApiKey
		);
		type RawAction = {
			title?: string;
			content?: string;
			owner?: string;
			deadline?: string;
			link_type?: string;
			motivation_prop_titles?: string[];
			motivation_context_titles?: string[];
		};
		const parsed = parseJson<{ actions?: RawAction[] }>(raw, { actions: [] });
		const propByTitle = new Map(propositions.map(p => [p.title, p.id]));
		const ctxByTitle = new Map(contexts.map(c => [c.title, c.id]));

		return (parsed.actions ?? [])
			.filter((a): a is RawAction & { title: string } => !!a.title?.trim())
			.map(a => {
				const id = sanitizeActionId(a.title!);
				const linkType: ActionLinkType =
					a.link_type === 'investigates' ? 'investigates' : 'implements';
				const motivationIds = (a.motivation_prop_titles ?? [])
					.map(t => propByTitle.get(t))
					.filter((id): id is string => !!id);
				const motivationContextIds = (a.motivation_context_titles ?? [])
					.map(t => ctxByTitle.get(t))
					.filter((id): id is string => !!id);
				return {
					id,
					title:                   a.title!.trim().slice(0, 60),
					content:                 typeof a.content === 'string' ? a.content : '',
					owner:                   typeof a.owner === 'string' ? a.owner : '',
					deadline:                typeof a.deadline === 'string' ? a.deadline : '',
					status:                  'pending' as const,
					motivation_ids:          motivationIds,
					motivation_context_ids:  motivationContextIds,
					link_type:               linkType,
					origin:                  'extracted' as const,
					created:                 new Date().toISOString(),
				};
			});
	} catch {
		return [];
	}
}

function sanitizeActionId(s: string): string {
	return `act-${s.replace(/[\\/:*?"<>|#^[\]\s]/g, '-').toLowerCase().slice(0, 40)}-${Date.now().toString(36)}`;
}

// ── Phase 8-3: 액션 ↔ 명제 연결 ──────────────────────────────

/**
 * 이미 추출된 actions의 motivation_ids를 보강한다.
 * extractActions에서 매핑 못한 항목을 LLM으로 재시도.
 */
export async function linkActionsToPropositions(
	actions: Omit<ActionNode, 'filePath'>[],
	propositions: Proposition[],
	settings: ThirdBrainSettings
): Promise<Omit<ActionNode, 'filePath'>[]> {
	const unlinked = actions.filter(a => a.motivation_ids.length === 0);
	if (unlinked.length === 0 || propositions.length === 0) return actions;

	const propList = propositions.map(p => `- id:"${p.id}" 제목:"${p.title}"`).join('\n');
	const actionList = unlinked.map(a => `- id:"${a.id}" 제목:"${a.title}"`).join('\n');

	const prompt =
		`다음 액션 각각이 어떤 명제를 실현(implements)하거나 조사(investigates)하기 위한 것인지 매핑하라.\n` +
		`JSON만 반환:\n{"mappings":[{"action_id":"...","prop_ids":["prop-id-1"]}]}\n\n` +
		`액션:\n${actionList}\n\n명제:\n${propList}`;

	try {
		const raw = await callClaudeWithModel(
			prompt,
			settings.cliBin,
			'fast',
			settings.aiProvider,
			settings.claudeApiKey,
			settings.geminiApiKey
		);
		type Mapping = { action_id?: string; prop_ids?: string[] };
		const parsed = parseJson<{ mappings?: Mapping[] }>(raw, { mappings: [] });
		const mapped = new Map<string, string[]>();
		for (const m of (parsed.mappings ?? [])) {
			if (m.action_id && Array.isArray(m.prop_ids)) {
				mapped.set(m.action_id, m.prop_ids.filter(id => !!id));
			}
		}
		return actions.map(a => ({
			...a,
			motivation_ids: a.motivation_ids.length > 0
				? a.motivation_ids
				: (mapped.get(a.id) ?? []),
		}));
	} catch {
		return actions;
	}
}


// ── 4차: vault 파일 연결 엣지 후보 ─────────────────────

export async function generateEdgeCandidates(
	coreTitle: string,
	contextSummary: string,
	existingFiles: string[],
	maxCandidates: number,
	cliBin: string
): Promise<EdgeCandidate[]> {
	if (existingFiles.length === 0) return [];

	const fileList = existingFiles.slice(0, 60).join('\n');
	const prompt =
		`핵심 명제와 기존 파일 목록을 비교하여 논리적 연관성이 높은 파일 최대 ${maxCandidates}개를 추천하라. ` +
		`연관이 약하거나 억지스러우면 빈 배열 반환(과잉 추천 금지). JSON만 반환(코드블록 없이).\n\n` +
		`핵심 명제: "${coreTitle}"\n요약: ${contextSummary.slice(0, 1500)}\n\n기존 파일:\n${fileList}\n\n` +
		`{"recommendations":[{"target_file":"파일명.md","label":"supports","reason":"연결 근거 한 줄","source_node":"출발 명제 제목"}]}`;

	try {
		const raw = await callClaude(prompt, cliBin);
		const parsed = parseJson<{ recommendations: EdgeCandidate[] }>(raw, { recommendations: [] });
		return (parsed.recommendations ?? []).map(r => ({
			target_file: String(r.target_file ?? ''),
			label: r.label ?? 'supports',
			reason: typeof r.reason === 'string' ? r.reason : '',
			source_node: typeof r.source_node === 'string' ? r.source_node : '',
		}));
	} catch {
		return [];
	}
}

// ── Phase 5: 폴더 브리지 ─────────────────────────────────

const SYSTEM_BRIDGE = `당신은 'Third-Brain'의 폴더 브리지 엔진입니다.
두 개의 독립적인 지식 폴더(사일로)의 노드 목록을 받아, 폴더 간 숨어 있는 연결을 최대한 풍부하게 도출합니다.
사용자가 칩으로 최종 확정하므로, 가능성 있는 연결은 적극적으로 포함하세요.

분석 방법:
1. 폴더 A의 각 노드와 폴더 B의 각 노드 사이의 관계를 빠짐없이 탐색하라.
2. 직접 연결(동일 주제, 인과, 지지/반박)과 간접 연결(구조적 동형성, 유사 패턴, 맥락 공유)을 모두 찾아라.
3. 두 폴더를 교차할 때만 발생하는 인사이트를 insight로 도출하라.

출력 규칙:
- edges: 최대 10개, 연관도 높은 순.
- insight: 두 폴더 교차 시 나오는 새로운 통찰 2~3문장.
- relation: isomorphic_to | analogous_to | supports | contrasts_with | causes | applies_to | exemplifies | precondition_of
- JSON만 반환(코드블록 없이).`;

export async function bridgeFolders(
	nodesA: TBNode[],
	nodesB: TBNode[],
	folderAName: string,
	folderBName: string,
	settings: ThirdBrainSettings,
	filterConfig?: Partial<TopologyFilterConfig>,
	onProgress?: (msg: string) => void
): Promise<FolderBridgeResult> {
	// Phase 12: 위상 필터링 설정
	const config: TopologyFilterConfig = {
		topKPerNode: filterConfig?.topKPerNode ?? settings.bridgeTopKPerNode ?? 5,
		minScore: filterConfig?.minScore ?? 0.1,
		maxCandidatePairs: filterConfig?.maxCandidatePairs ?? 30,
		useConfirmedEdgesOnly: filterConfig?.useConfirmedEdgesOnly ?? false,
	};

	// Phase 12: 위상학적 후보 쌍 필터링
	const pairs = filterCandidatePairs(nodesA, nodesB, config);

	// 후보가 없으면 LLM 호출 없이 반환
	if (pairs.length === 0) {
		return {
			edges: [],
			insight: '두 폴더 간 위상학적 유사도가 낮아 후보를 찾지 못했습니다.',
		};
	}

	// Phase 12: 압축 프롬프트 생성
	const candidatesText = formatCandidatesForPrompt(pairs, folderAName, folderBName);
	onProgress?.(
		`후보 ${pairs.length}쌍 → LLM 분석 중... (standard 모델)`
	);

	const prompt = `${SYSTEM_BRIDGE}\n\n${candidatesText}\n\n` +
		`JSON 응답 예시:\n{"edges":[{"source_title":"폴더A 노드 제목","target_title":"폴더B 노드 제목","relation":"isomorphic_to","confidence":0.85,"reason":"근거 한 줄"}],"insight":"통찰 2~3문장"}`;

	// Phase 12: 모델 라우팅 추가 (standard 티어)
	const raw = await callClaudeWithModel(
		prompt,
		settings.cliBin,
		'standard',
		settings.aiProvider,
		settings.claudeApiKey,
		settings.geminiApiKey
	);
	const parsed = parseJson<{ edges?: Array<Record<string, unknown>>; insight?: string }>(
		raw, { edges: [], insight: '' }
	);

	const edges: BridgeEdge[] = (parsed.edges ?? [])
		.filter(e => e && (e['source_title'] || e['source_file']) && (e['target_title'] || e['target_file']))
		.map(e => ({
			source_title: e['source_title'] ? String(e['source_title']) : undefined,
			target_title: e['target_title'] ? String(e['target_title']) : undefined,
			source_file:  e['source_file']  ? String(e['source_file'])  : String(e['source_title'] ?? '') + '.md',
			target_file:  e['target_file']  ? String(e['target_file'])  : String(e['target_title'] ?? '') + '.md',
			relation: toRelation(String(e['relation'] || 'analogous_to')),
			confidence: typeof e['confidence'] === 'number' ? e['confidence'] : 0.5,
			reason: typeof e['reason'] === 'string' ? e['reason'] : '',
		}));

	return {
		edges,
		insight: typeof parsed.insight === 'string' ? parsed.insight : '',
	};
}

// ── 뷰어: 폴더 핵심 서브그래프 요약 (풍부한 분석) ──────

const SYSTEM_SUMMARY = `당신은 지식 그래프에서 실제 인사이트를 추출하는 분석가입니다.
입력은 명제(노드)들과 그 사이의 논리 관계(엣지)로 구성된 다이제스트입니다.
각 노드는 하나의 주장·사실·개념이고, 엣지는 인과·지지·모순·예시·유비 같은 명확한 논리 관계입니다.

## 출력 필드

**synthesis** (3~5문장)
- 노드와 관계를 바탕으로 "이 지식 덩어리가 말하는 바"를 직접 진술하라.
- [사용자 분석 목적]이 있으면 그 질문에 정면으로 답하라. "A이기 때문에 B다", "X가 Y를 가능하게 한다"처럼 인과 구조로 서술하라.
- 막연한 표현("다양한", "중요한", "살펴볼 필요가") 금지. 노드 이름을 직접 인용하라.

**overview** (2문장)
- 이 명제 집합이 다루는 핵심 주제를 한 줄로, 그 주제가 왜 중요한지 한 줄로.

**themes** (묶음)
- 관계가 밀집된 명제군을 묶어 패턴에 이름을 붙여라.
- description: "A → B → C 인과 사슬이 존재한다", "X와 Y가 충돌하는 지점이 있다"처럼 구체적으로.

**highlights** (주요 발견)
- 각 항목은 반드시 "노드A [관계] 노드B → 그것이 의미하는 바" 형식으로 작성하라.
- "~을 확인할 수 있다", "~가 드러난다" 같은 수동 표현 금지. 직접 단언하라.

**link_contexts** (연결 맥락)
- 각 항목: source, target, relation, context(이 관계가 성립하는 구체적 이유 1~2문장)

## 절대 금지
- "이 폴더는", "데이터가", "노드들이" 같은 메타 언어로 시작하는 문장
- 내용 없이 구조만 설명하는 문장 ("A와 B가 연결되어 있습니다")
- 모든 메타 코멘트 ("분석이 어렵습니다", "더 많은 데이터가 필요합니다")

모두 한국어. JSON만 반환(코드블록 없이).`;

export async function summarizeSubgraph(
	digest: string,
	settings: ThirdBrainSettings,
	mode: 'rich' | 'summary' = 'summary',
	intent?: string
): Promise<SummaryResult> {
	const modeDirective = mode === 'rich'
		? `[깊은 분석 모드]
themes 5개 이상: 관계가 밀집된 명제군을 최대한 세분화하라.
highlights 6개 이상: 각 항목은 "노드A [relation] 노드B → 의미" 형식. 단순 사실 나열 금지, 반드시 추론을 포함하라.
link_contexts 5개 이상: 가장 의외이거나 강력한 연결을 우선 선정하라.`
		: `[빠른 요약 모드]
themes 3개: 가장 강한 클러스터만.
highlights 4개: 이 명제 집합에서 가장 충격적이거나 핵심적인 발견만. 자명한 것은 제외.
link_contexts 3개: 가장 결정적인 인과·지지 관계만.`;

	const intentDirective = intent
		? `[사용자 분석 목적] "${intent}"
synthesis를 포함한 모든 필드를 이 목적의 렌즈로 재구성하라.
목적과 직결되는 명제와 관계를 최우선으로 다루고, 목적에 답하지 못하는 일반론은 생략하라.
synthesis 마지막 문장은 반드시 이 목적에 대한 직접적 결론이어야 한다.\n`
		: '';

	const prompt =
		`${SYSTEM_SUMMARY}\n\n${modeDirective}\n${intentDirective}\n` +
		`다음 핵심 서브그래프 다이제스트를 요약하라:\n\n` +
		`{"synthesis":"...","overview":"...","themes":[{"title":"...","description":"..."}],"highlights":["..."],"link_contexts":[{"source":"...","target":"...","relation":"...","context":"..."}]}\n\n` +
		`---\n\n${digest}`;

	const raw = await callClaudeWithModel(
		prompt,
		settings.cliBin,
		'standard',
		settings.aiProvider,
		settings.claudeApiKey,
		settings.geminiApiKey
	);
	const parsed = parseJson<SummaryResult>(raw, {
		synthesis: '',
		overview: '',
		themes: [],
		highlights: [],
		link_contexts: [],
	});

	return {
		synthesis: typeof parsed.synthesis === 'string' ? parsed.synthesis : '',
		overview: typeof parsed.overview === 'string' ? parsed.overview : '',
		themes: Array.isArray(parsed.themes)
			? parsed.themes.filter(t => t && t.title).map(t => ({
				title: String(t.title),
				description: String(t.description ?? ''),
			}))
			: [],
		highlights: Array.isArray(parsed.highlights)
			? parsed.highlights.filter(h => typeof h === 'string')
			: [],
		link_contexts: Array.isArray(parsed.link_contexts)
			? parsed.link_contexts.filter(l => l && (l.source || l.target)).map(l => ({
				source: String(l.source ?? ''),
				target: String(l.target ?? ''),
				relation: String(l.relation ?? ''),
				context: String(l.context ?? ''),
			}))
			: [],
	};
}

// ── Phase 8: 폴더 요약 ──────────────────────────────────

export interface FolderDigestNode {
	title: string;
	content: string;
	nodeType: string;
	edges: Array<{ target: string; relation: string; reason: string }>;
}

export async function summarizeFolder(
	nodes: FolderDigestNode[],
	settings: ThirdBrainSettings,
	mode: 'rich' | 'summary' = 'summary',
	intent?: string
): Promise<SummaryResult> {
	if (nodes.length === 0) return { synthesis: '', overview: '', themes: [], highlights: [], link_contexts: [] };
	const digest = nodes
		.map(n => {
			const edgePart = n.edges.length > 0
				? '\n연결: ' + n.edges.slice(0, 3).map(e => `[${e.relation}]→${e.target}`).join(', ')
				: '';
			return `### ${n.title} [${n.nodeType}]\n${n.content.slice(0, 250)}${edgePart}`;
		})
		.join('\n\n');
	return summarizeSubgraph(digest, settings, mode, intent);
}

// ── 노드 이식: 단일 .md 분류 ─────────────────────────────

const SYSTEM_CLASSIFY = `당신은 ThirdBrain의 노드 분류 엔진입니다.
사용자가 작성한 마크다운 노트를 읽고 ThirdBrain 노드 속성을 결정합니다.

type 선택 기준:
- claim: 명확한 주장/관점/의견
- premise: 전제/배경 사실
- conclusion: 결론/판단
- example: 구체적 사례/예시
- contrast: 대조/반박
- application: 적용/실천 방안
- insight: 여러 개념을 관통하는 핵심 발견
- summary: 문맥 요약/개요
- action: 해야 할 일/태스크

규칙:
- title: 노트 핵심을 담은 짧은 명사구 (40자 이내, 한국어)
- tags: 핵심 키워드 3~6개 (소문자 영문 또는 한국어)
- summary: 노트 전체 내용을 2~3문장으로 요약 (한국어)
- 없는 내용 지어내지 말 것

JSON만 반환(코드블록 없이):
{"title":"...","type":"claim","tags":["a","b"],"summary":"..."}`;

export async function classifyNode(
	content: string,
	settings: ThirdBrainSettings,
	onProgress?: (msg: string) => void
): Promise<NodeClassification> {
	onProgress?.('노드 속성 분류 중...');
	const prompt = `${SYSTEM_CLASSIFY}\n\n다음 노트를 분류하라:\n\n"""\n${content.slice(0, 6000)}\n"""`;

	const raw = await callClaudeWithModel(prompt, settings.cliBin, 'standard', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey);
	const result = parseJson<Partial<NodeClassification>>(raw, {});

	return {
		title: result.title?.trim() || '미분류 노트',
		type: (result.type as NodeClassification['type']) || 'claim',
		tags: Array.isArray(result.tags) ? result.tags.slice(0, 6) : [],
		summary: result.summary?.trim() || '',
	};
}

// ── 이식 시 대상 폴더 연결 추천 ──────────────────────────

const SYSTEM_TRANSPLANT_EDGES = `당신은 ThirdBrain의 연결 추천 엔진입니다.
새로 이식할 노트와 기존 노드들 사이의 연결 후보를 추천합니다.
사용자가 칩을 눌러 최종 확정하므로, 가능성 있는 연결은 적극적으로 포함하세요.

규칙:
- 직접 연결(동일 주제, 인과, 지지/반박)뿐 아니라 간접 연결(유사 구조, 맥락 공유)도 포함
- 기존 노드의 "연결 노드" 힌트를 활용해 의미 클러스터 파악
- 최대 6개, 연관도 높은 순
- relation: supports | causes | conflicts_with | exemplifies | applies_to | contrasts_with | precondition_of | isomorphic_to | analogous_to
- confidence: 연결 확신도 0.0~1.0 (직접·강한 연결=0.9+, 간접·맥락 공유=0.5~0.7)

JSON만 반환(코드블록 없이):
{"edges":[{"target_title":"기존노드제목","relation":"supports","confidence":0.85,"reason":"연결 근거 — 구체적으로 어떤 개념이 왜 연결되는지"}]}`;

export async function recommendTransplantEdges(
	newContent: string,
	newTitle: string,
	existingNodes: Array<{ title: string; content: string }>,
	settings: ThirdBrainSettings,
	onProgress?: (msg: string) => void
): Promise<Array<{ target_title: string; relation: string; reason: string }>> {
	if (existingNodes.length === 0) return [];
	onProgress?.('연결 후보 탐색 중...');

	// 노드당 500자 — 주제 파악에 충분한 컨텍스트 확보
	const nodeList = existingNodes
		.slice(0, 15)
		.map(n => `### [${n.title}]\n${n.content.slice(0, 500)}`)
		.join('\n\n');

	const prompt = `${SYSTEM_TRANSPLANT_EDGES}\n\n## 새로 이식할 노트\n제목: ${newTitle}\n\n${newContent.slice(0, 4000)}\n\n---\n## 기존 노드 목록\n${nodeList}`;

	try {
		const raw = await callClaudeWithModel(prompt, settings.cliBin, 'standard', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey);
		const result = parseJson<{ edges?: unknown[] }>(raw, { edges: [] });
		return Array.isArray(result.edges)
			? (result.edges as Array<{ target_title: string; relation: string; confidence?: number; reason: string }>)
				.map(e => ({ ...e, confidence: typeof e.confidence === 'number' ? e.confidence : 0.5 }))
				.slice(0, 6)
			: [];
	} catch {
		return [];
	}
}

// ── 저장 후 Cross-Connection: 새 명제 ↔ 기존 폴더 노드 ────

const SYSTEM_CROSS = `당신은 ThirdBrain의 연결 탐색 엔진입니다.
새로 저장된 명제들과 폴더 안 기존 노드들 사이의 연결 후보를 찾습니다.
사용자가 칩으로 최종 확정하므로, 가능성 있는 연결은 적극적으로 포함하세요.

규칙:
- 직접 연결(동일 주제, 인과, 지지/반박)과 간접 연결(유사 구조, 맥락 공유) 모두 포함
- 각 새 명제와 각 기존 노드를 짝지어 검토
- 최대 8개, 연관도 높은 순
- relation: supports | causes | conflicts_with | exemplifies | applies_to | contrasts_with | precondition_of | isomorphic_to | analogous_to
- confidence: 연결 확신도 0.0~1.0 (직접·강한 연결=0.9+, 간접·맥락 공유=0.5~0.7)

JSON만 반환(코드블록 없이):
{"connections":[{"new_title":"새명제제목","existing_title":"기존노드제목","relation":"supports","confidence":0.85,"reason":"연결 근거 구체적으로"}]}`;

export interface CrossConnection {
	new_title: string;
	existing_title: string;
	relation: string;
	confidence: number;
	reason: string;
}

export async function findCrossConnections(
	newPropositions: Array<{ title: string; content: string; tags: string[] }>,
	existingNodes: Array<{ title: string; content: string; tags: string[]; edges: Array<{ target: string }> }>,
	settings: ThirdBrainSettings,
	onProgress?: (msg: string) => void
): Promise<CrossConnection[]> {
	if (newPropositions.length === 0 || existingNodes.length === 0) return [];
	onProgress?.('기존 노드와 연결 후보 탐색 중...');

	const newList = newPropositions.slice(0, 15).map(p =>
		`### [${p.title}]\n${p.content.slice(0, 300)}${p.tags.length ? `\n태그: ${p.tags.join(', ')}` : ''}`
	).join('\n\n');

	const existingList = existingNodes.slice(0, 20).map(n => {
		const connectedTitles = n.edges
			.map(e => e.target.replace(/^\[\[|\]\]$/g, ''))
			.filter(Boolean).slice(0, 4);
		return [
			`### [${n.title}]`,
			n.content.slice(0, 300),
			n.tags.length         ? `태그: ${n.tags.join(', ')}` : '',
			connectedTitles.length ? `연결 노드: ${connectedTitles.join(', ')}` : '',
		].filter(Boolean).join('\n');
	}).join('\n\n');

	const prompt = `${SYSTEM_CROSS}\n\n## 새로 저장된 명제들\n${newList}\n\n---\n## 폴더 기존 노드들\n${existingList}`;

	try {
		const raw = await callClaudeWithModel(
			prompt, settings.cliBin, 'standard',
			settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey
		);
		const result = parseJson<{ connections?: unknown[] }>(raw, { connections: [] });
		return Array.isArray(result.connections)
			? (result.connections as CrossConnection[])
				.map(c => ({ ...c, confidence: typeof c.confidence === 'number' ? c.confidence : 0.5 }))
				.slice(0, 8)
			: [];
	} catch {
		return [];
	}
}

// ── Phase 5 bridgeFolders 이미 위에 있음 ─────────────────

// ── 유틸 ─────────────────────────────────────────────────

export function splitIntoChunks(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];

	const paragraphs = text.split(/\n{2,}/);
	const chunks: string[] = [];
	let current = '';

	for (const para of paragraphs) {
		if (para.length > maxChars) {
			if (current) { chunks.push(current.trim()); current = ''; }
			for (let i = 0; i < para.length; i += maxChars) chunks.push(para.slice(i, i + maxChars));
			continue;
		}
		if (current.length + para.length + 2 > maxChars) {
			if (current) chunks.push(current.trim());
			current = para;
		} else {
			current = current ? `${current}\n\n${para}` : para;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks.length > 0 ? chunks : [text.slice(0, maxChars)];
}

function repairJson(raw: string): string {
	let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	// 선행 설명문 제거 — 첫 { 또는 [ 앞의 텍스트 제거
	const firstBrace = Math.min(
		s.indexOf('{') === -1 ? Infinity : s.indexOf('{'),
		s.indexOf('[') === -1 ? Infinity : s.indexOf('[')
	);
	if (firstBrace > 0 && firstBrace !== Infinity) s = s.slice(firstBrace);

	const stack: string[] = [];
	let inStr = false;
	let escaped = false;

	for (const ch of s) {
		if (escaped) { escaped = false; continue; }
		if (ch === '\\' && inStr) { escaped = true; continue; }
		if (ch === '"') { inStr = !inStr; continue; }
		if (inStr) continue;
		if (ch === '{') stack.push('}');
		else if (ch === '[') stack.push(']');
		else if (ch === '}' || ch === ']') {
			if (stack.at(-1) === ch) stack.pop();
		}
	}
	s = s.replace(/,\s*$/, '');
	return s + stack.reverse().join('');
}

function parseJson<T>(raw: unknown, fallback: T): T {
	if (raw !== null && typeof raw === 'object') return raw as T;
	if (typeof raw !== 'string') return fallback;
	try {
		return JSON.parse(repairJson(raw)) as T;
	} catch {
		return fallback;
	}
}

// ── 저장 시 통합 (Context 레벨 필터링) ─────────────────────

/**
 * 새 Proposition과 기존 폴더 Proposition 간 엣지 추출
 * Context 유사도로 필터링 → 유사 Context 쌍만 비교 (O(N²) 방지)
 */
export async function extractIntegrationEdges(
	newContexts: ContextLayer[],
	newPropositions: Proposition[],
	existingPropositions: Proposition[],
	existingContexts: ContextLayer[],
	settings: ThirdBrainSettings
): Promise<LogicEdge[]> {
	if (existingPropositions.length === 0 || newPropositions.length === 0) {
		return [];
	}

	// Step 1: Context 유사도 분석 (한 번의 LLM 호출)
	const contextPairs = await matchContextsBySemanticSimilarity(
		newContexts,
		existingContexts,
		settings.cliBin
	);

	// Step 2: 유사도 높은 쌍만 선택 (상위 10개)
	const topPairs = contextPairs
		.filter(pair => pair.similarity > 0.5)
		.slice(0, 10);

	if (topPairs.length === 0) return [];

	// Step 3: 각 Context 쌍 내에서 Proposition 엣지만 추출
	const allEdges: LogicEdge[] = [];

	for (const { ctxNew, ctxExisting } of topPairs) {
		const propsNew = newPropositions.filter(p => p.context === ctxNew.title);
		const propsExisting = existingPropositions.filter(p => p.context === ctxExisting.title);

		if (propsNew.length === 0 || propsExisting.length === 0) continue;

		// Context 쌍 내에서만 엣지 추출
		const edges = await extractEdges(
			[...propsNew, ...propsExisting],
			[ctxNew, ctxExisting],
			[],
			settings
		);

		// 새 Prop ↔ 기존 Prop만 필터링 (같은 Context 내 엣지는 제외)
		const crossEdges = edges.filter(e => {
			const sourceIsNew = propsNew.some(p => p.id === e.source);
			const targetIsExisting = propsExisting.some(p => p.id === e.target);
			const sourceIsExisting = propsExisting.some(p => p.id === e.source);
			const targetIsNew = propsNew.some(p => p.id === e.target);

			return (sourceIsNew && targetIsExisting) || (sourceIsExisting && targetIsNew);
		});

		allEdges.push(...crossEdges);
	}

	return allEdges;
}

/**
 * Context 유사도 분석 (한 번의 LLM 호출)
 * 폴더 브리지의 Step 2와 동일
 */
async function matchContextsBySemanticSimilarity(
	contextsA: ContextLayer[],
	contextsB: ContextLayer[],
	cliBin: string
): Promise<Array<{ ctxNew: ContextLayer; ctxExisting: ContextLayer; similarity: number }>> {
	const contextABlock = contextsA
		.map(c => `- ${c.title}: ${c.summary.slice(0, 100)}`)
		.join('\n');
	const contextBBlock = contextsB
		.map(c => `- ${c.title}: ${c.summary.slice(0, 100)}`)
		.join('\n');

	const prompt = `당신은 Context 유사도 분석 엔진입니다.
두 Context 목록의 의미적 유사성을 분석하고, 유사한 쌍을 추출합니다.

【새 Context 목록】
${contextABlock}

【기존 Context 목록】
${contextBBlock}

유사한 쌍을 찾으세요 (0~1 점수, 0.5 이상만):
{"pairs": [{"new_idx": 0, "existing_idx": 0, "similarity": 0.8, "reason": "..."}]}`;

	try {
		const raw = await callClaudeWithModel(prompt, cliBin, 'fast');
		const parsed = parseJson<{
			pairs?: Array<{ new_idx: number; existing_idx: number; similarity: number }>;
		}>(raw, { pairs: [] });

		return (parsed.pairs ?? [])
			.filter(p => p.new_idx >= 0 && p.existing_idx >= 0)
			.map(p => ({
				ctxNew: contextsA[p.new_idx]!,
				ctxExisting: contextsB[p.existing_idx]!,
				similarity: p.similarity,
			}))
			.sort((a, b) => b.similarity - a.similarity);
	} catch {
		return [];
	}
}
