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

import { callClaudeWithModel } from './cli-bridge';
import { jsonLangInstr, type Lang } from '../i18n';
import { toRelation, isValidRelation } from '../types';
import type {
	ContextLayer,
	Insight,
	Proposition,
	LogicEdge,
	EdgeCandidate,
	PropositionRole,
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
	ProblemSpecies,
	ContentType,
	DialogueSubtype,
} from '../types';
import {
	filterCandidatePairs,
	formatCandidatesForPrompt,
} from './topology-engine';
import {
	SYSTEM_DISTILL,
	SYSTEM_SPEAKER_ROSTER,
	SYSTEM_NORMALIZE_SPEAKERS,
	SYSTEM_CONTEXT,
	SYSTEM_INSIGHT,
	SYSTEM_PROP_BASE,
	SYSTEM_PROP_DOCUMENT_ADDON,
	SYSTEM_PROP_LECTURE_ADDON,
	SYSTEM_PROP_MEETING_ADDON,
	SYSTEM_PROP_DIALOGUE_ADDONS,
	SYSTEM_EDGES,
	SYSTEM_CONTRASTS,
	SYSTEM_ACTIONS,
	SYSTEM_PROBLEMS,
	SYSTEM_BRIDGE,
	SYSTEM_SUMMARY,
	SYSTEM_CLASSIFY,
	SYSTEM_TRANSPLANT_EDGES,
	SYSTEM_CROSS,
} from './prompts';
import { splitIntoParagraphs, shortHash, splitIntoChunks, repairJson, parseJson, redactPhoneNumbers } from './text-utils';

export const DISTILL_THRESHOLD = 10000;  // 하위 호환 — 더 이상 메인 플로우에서 사용 안 함
export const CHUNK_SIZE = 5000;           // 청크별 풀파이프라인 분할 기준 (cmd.exe 8191자 한계 대응)


// ── 0차: 대용량 입력 핵심 압축 ───────────────────────────


export async function distillText(
	rawText: string,
	settings: ThirdBrainSettings,
	onProgress?: (msg: string) => void
): Promise<string> {
	const chunks = splitIntoChunks(rawText, 8000);  // 청크 크기 축소 (더 자주 분할)
	const out: string[] = [];

	for (let i = 0; i < chunks.length; i++) {
		onProgress?.(`핵심 정제 중... (${i + 1}/${chunks.length} 조각)`);
		const prompt = `${SYSTEM_DISTILL}\n\n다음 텍스트의 핵심만 압축하라:\n\n"""\n${chunks[i]}\n"""`;
		try {
			const raw = await callClaudeWithModel(prompt, settings.cliBin, 'fast', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey);
			const result = parseJson<{ core?: string }>(raw, {});
			if (result.core) out.push(result.core);
		} catch {
			out.push(chunks[i].slice(0, 3000));
		}
	}

	return out.join('\n\n---\n\n').trim() || rawText.slice(0, 8000);
}

// ── 0.5차: 화자 정규화 (회의/대화 전용) ──────────────────

export interface SpeakerNormResult {
	text: string;
	speakers: Record<string, string>; // label → 실명 또는 ""
}

// ── 0.4차: 전역 화자 명단 (청킹 전 1회) ──────────────────
// 화자 정체성은 문서 전체에서 일관돼야 한다. 청크별 정규화는 라벨이 조각나므로,
// 먼저 전체 텍스트에서 화자 명단(로스터)만 확정하고 그것을 각 청크 정규화에 주입한다.
// (전체 텍스트를 한 콜로 '리라이트'하는 건 출력 토큰 한계로 뒷부분이 잘려 불가능 → 명단만 뽑는다.)

export interface SpeakerRoster {
	speakers: Record<string, string>; // label → 실명 또는 ""
	cues: string;                     // 화자 구분 핵심 단서 (청크별 적용 일관성용)
}


/**
 * [비용] STT(Plaud 등)가 이미 붙인 발화자 라벨을 정규식으로 감지 — 있으면 LLM 없이 결정적으로 명단 구성.
 * 전문을 읽는 로스터 LLM 콜(최대 30K자, standard 티어)이 재발견하는 정보라 통째로 생략 가능.
 * 내용 속 인물(외부인)은 명단에 없지만, 정규화가 실명 기반(외부인_이름)으로 라벨링하므로 청크 간 자연 일치.
 */
function rosterFromTranscriptLabels(fullText: string): SpeakerRoster | null {
	const re = /(?:^|\n)\s*(?:\d{1,2}:\d{2}(?::\d{2})?\s+)?((?:Speaker|화자|참석자|발표자|팀원)\s?\d+)\s*(?:$|[\n:.])/gim;
	const counts = new Map<string, number>();
	let m: RegExpExecArray | null;
	let total = 0;
	while ((m = re.exec(fullText)) !== null) {
		const label = m[1].replace(/\s+/g, ' ').trim();
		counts.set(label, (counts.get(label) ?? 0) + 1);
		total++;
	}
	// 우연 매칭 방지: 서로 다른 화자 2명 이상 + 발화 5회 이상일 때만 라벨 전사로 인정
	if (counts.size < 2 || total < 5) return null;
	// STT 라벨을 프롬프트 어휘(화자N)로 정규화해 주입한다. 영문 라벨("Speaker N")을 그대로 주입하면
	// 정규화 프롬프트의 화자N 규칙과 충돌해 청크마다 Speaker N/화자N/팀원N이 뒤섞이는 표류가 실측됨 (2026-07-09).
	const speakers: Record<string, string> = {};
	const mappings: string[] = [];
	for (const label of [...counts.keys()].sort()) {
		const num = label.match(/\d+/)?.[0] ?? '';
		const canonical = `화자${num}`;
		speakers[canonical] = '';
		if (label !== canonical) mappings.push(`"${label}" → "${canonical}"`);
	}
	return {
		speakers,
		cues: mappings.length > 0
			? `발화자 라벨은 원문 전사에 표기되어 있음. 원문 라벨을 반드시 다음과 같이 치환하고 다른 표기(팀원N·스피커N 등)를 만들지 마라: ${mappings.join(', ')}`
			: '발화자 라벨은 원문 전사에 이미 표기되어 있음 — 표기된 라벨을 그대로 사용하라',
	};
}

/** 전체 텍스트에서 화자 명단만 확정한다 (출력이 작아 잘림 없음). 청킹 전 1회 호출. */
export async function identifySpeakerRoster(
	fullText: string,
	settings: ThirdBrainSettings,
	onProgress?: (msg: string) => void,
): Promise<SpeakerRoster> {
	// 전사에 발화자 라벨이 이미 있으면 LLM 생략 (결정적 + 0원)
	const detected = rosterFromTranscriptLabels(fullText);
	if (detected) {
		onProgress?.(`화자 명단: 전사 라벨 ${Object.keys(detected.speakers).length}명 감지 (LLM 생략)`);
		return detected;
	}
	onProgress?.('화자 명단 식별 중...');
	// CLI -p 인자 길이 한계(win32 ~32k) 대비 상한. 화자는 대개 앞부분에 모두 등장하므로 충분.
	const prompt = `${SYSTEM_SPEAKER_ROSTER}\n\n전체 전사본:\n${fullText.slice(0, 30000)}`;
	try {
		const raw = await withRetry(() => callClaudeWithModel(
			prompt, settings.cliBin, 'standard',
			settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey,
		));
		const parsed = parseJson<{ speakers?: Record<string, string>; cues?: string }>(raw, {});
		return {
			speakers: (typeof parsed.speakers === 'object' && parsed.speakers !== null) ? parsed.speakers : {},
			cues: typeof parsed.cues === 'string' ? parsed.cues : '',
		};
	} catch { /* 실패 시 빈 명단 → 청크별 정규화가 자체 식별로 폴백 */ }
	return { speakers: {}, cues: '' };
}


export async function normalizeSpeakers(
	rawText: string,
	settings: ThirdBrainSettings,
	roster?: SpeakerRoster,
	onProgress?: (msg: string) => void,
): Promise<SpeakerNormResult> {
	onProgress?.('화자 정규화 중...');
	// 전역 로스터가 있으면 주입해 청크 간 라벨 일관성을 강제한다 (새 레이블 생성 금지).
	const rosterBlock = roster && Object.keys(roster.speakers).length > 0
		? `\n\n★ 확정된 화자 명단 — 반드시 이 레이블만 일관되게 사용하라 (새 레이블 생성 금지):\n${JSON.stringify(roster.speakers)}${roster.cues ? `\n구분 단서: ${roster.cues}` : ''}`
		: '';
	const prompt = `${SYSTEM_NORMALIZE_SPEAKERS}${rosterBlock}\n\n텍스트:\n${rawText.slice(0, 12000)}`;
	try {
		// [품질] 정규화는 standard 고정. fast(mini) 실측 결과(2026-07-09) 라벨 혼용(Speaker N ↔ 팀원N)과
		// 문장 중간 라벨 침투("Then 팀원4: we have to...")가 발생해 명제 귀속·엣지 판별까지 연쇄 오염됨.
		// 정규화본은 raw/에 저장되는 정본이라 여기서의 품질 손실은 전 파이프라인의 손실이다.
		const raw = await withRetry(() => callClaudeWithModel(
			prompt, settings.cliBin, 'standard',
			settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey,
		));
		const parsed = parseJson<{ normalized_text?: string; speakers?: Record<string, string> }>(raw, {});
		if (typeof parsed.normalized_text === 'string' && parsed.normalized_text.trim().length > 50) {
			const parsedSpeakers = (typeof parsed.speakers === 'object' && parsed.speakers !== null) ? parsed.speakers : {};
			return {
				text: redactPhoneNumbers(parsed.normalized_text.trim()),
				// 전역 로스터를 우선 유지 (청크가 명단을 축소/변형하지 않도록)
				speakers: roster && Object.keys(roster.speakers).length > 0 ? roster.speakers : parsedSpeakers,
			};
		}
	} catch { /* 정규화 실패 시 원본 그대로 사용 */ }
	return { text: redactPhoneNumbers(rawText), speakers: roster?.speakers ?? {} };
}

// ── 1차: 문맥 레이어 추출 ────────────────────────────────


export async function extractContexts(text: string, settings: ThirdBrainSettings): Promise<ContextLayer[]> {
	const today = new Date().toISOString().split('T')[0];
	const prompt =
		`${SYSTEM_CONTEXT}\n${jsonLangInstr(settings.lang)}\n\n오늘 날짜: ${today}\n\n` +
		`다음 텍스트를 의미 단위별로 정제하라:\n\n` +
		`{"contexts":[{"title":"...","date":"YYYY-MM-DD","summary":"...","tags":["..."],"keywords":["..."]}]}\n\n` +
		`---\n\n${text}`;

	const raw = await callClaudeWithModel(
		prompt,
		settings.cliBin,
		'fast',
		settings.aiProvider,
		settings.claudeApiKey,
		settings.geminiApiKey,
		settings.openaiApiKey
	);
	const parsed = parseJson<{ contexts?: Partial<ContextLayer>[] }>(raw, { contexts: [] });

	const list = Array.isArray(parsed.contexts) ? parsed.contexts : [];
	const mapped = list
		.filter(c => c && c.title && typeof c.summary === 'string' && c.summary.trim().length > 20)
		.map((c, i) => assignContextId({
			title: typeof c.title === 'string' ? c.title.trim() : (settings.lang === 'en' ? 'Untitled' : '제목 없음'),
			date: typeof c.date === 'string' ? c.date.trim() : today,
			summary: typeof c.summary === 'string' ? c.summary : '',
			tags: Array.isArray(c.tags)
				? (c.tags).filter(t => typeof t === 'string').slice(0, 6)
				: [],
			keywords: Array.isArray(c.keywords)
				? (c.keywords).filter(k => typeof k === 'string').slice(0, 10)
				: [],
		}, i));

	// LLM이 0개 반환 시에만 재시도 — 1개도 유효한 결과로 수용
	if (mapped.length === 0) {
		return retryContextSplit(text, today, settings);
	}
	return mapped;
}

async function retryContextSplit(text: string, today: string, settings: ThirdBrainSettings): Promise<ContextLayer[]> {
	const prompt =
		`텍스트를 반드시 3~6개의 독립 의미 단위로 분절하라.\n` +
		`헤딩·제목이 없어도 된다. 주제 전환, 관점 변화, 시간 변화, 내용 범주 차이로 나눠라.\n` +
		`1개로 반환하는 것은 절대 허용하지 않는다.\n` +
		`${jsonLangInstr(settings.lang)}\n` +
		`{"contexts":[{"title":"...","date":"${today}","summary":"...","tags":[],"keywords":[]}]}\n\n` +
		`텍스트:\n${text.slice(0, 6000)}`;

	// CLI/API 에러는 throw — chunkByParagraph 폴백은 LLM 응답 불량 시에만 사용
	const raw = await callClaudeWithModel(
		prompt,
		settings.cliBin,
		'fast',
		settings.aiProvider,
		settings.claudeApiKey,
		settings.geminiApiKey,
		settings.openaiApiKey
	);
	const parsed = parseJson<{ contexts?: Partial<ContextLayer>[] }>(raw, { contexts: [] });
	const list = Array.isArray(parsed.contexts) ? parsed.contexts : [];
	const result = list
		.filter(c => c && c.title && typeof c.summary === 'string' && c.summary.trim().length > 20)
		.map((c, i) => assignContextId({
			title: typeof c.title === 'string' ? c.title.trim() : (settings.lang === 'en' ? 'Paragraph' : '단락'),
			date: typeof c.date === 'string' ? c.date.trim() : today,
			summary: typeof c.summary === 'string' ? c.summary : '',
			tags: Array.isArray(c.tags) ? (c.tags).slice(0, 6) : [],
			keywords: Array.isArray(c.keywords) ? (c.keywords).slice(0, 10) : [],
		}, i));
	if (result.length === 0) return chunkByParagraph(text, today, settings.lang);
	return result;
}

function chunkByParagraph(text: string, today: string, lang?: Lang): ContextLayer[] {
	const isEn = lang === 'en';
	const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 30);
	if (paragraphs.length === 0) return [assignContextId({ title: isEn ? 'All' : '전체', date: today, summary: text.slice(0, 800), tags: [], keywords: [] }, 0)];
	const chunkSize = Math.ceil(paragraphs.length / 4);
	const chunks: ContextLayer[] = [];
	for (let i = 0; i < paragraphs.length; i += chunkSize) {
		const body = paragraphs.slice(i, i + chunkSize).join('\n\n');
		const title = isEn ? `Paragraph ${chunks.length + 1}` : `단락 ${chunks.length + 1}`;
		chunks.push(assignContextId({ title, date: today, summary: body.slice(0, 800), tags: [], keywords: [] }, chunks.length));
	}
	return chunks;
}

function assignContextId(c: Omit<ContextLayer, 'id'>, index: number): ContextLayer {
	const slug = c.title.replace(/[^\wㄱ-힣]/g, '-').toLowerCase().slice(0, 30);
	return { id: `ctx-${slug}-${Date.now().toString(36)}-${index}`, ...c };
}

// ── 1.5차: 핵심 인사이트 추출 ────────────────────────────


export async function extractInsights(contexts: ContextLayer[], settings: ThirdBrainSettings): Promise<Insight[]> {
	const contextBlock = contexts
		.map((c, i) => `### 단위 ${i + 1}: ${c.title}\n${c.summary}`)
		.join('\n\n');

	const prompt =
		`${SYSTEM_INSIGHT}\n\n` +
		`다음 ${contexts.length}개 문맥 단위를 관통하는 핵심 인사이트를 추출하라:\n\n` +
		`{"insights":[{"id":"ins1","title":"인사이트 제목(10~25자)","why_central":"핵심인 이유 한 문장"}]}\n\n` +
		`---\n\n${contextBlock}`;

	try {
		const raw = await callClaudeWithModel(prompt, settings.cliBin, 'fast', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey);
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

// ── 2차: 명제 추출 — 단락 우선 출처 (Paragraph-First Provenance) ──────

const ALLOWED_ROLES: readonly PropositionRole[] = [
	'claim', 'premise', 'conclusion', 'example', 'contrast', 'application',
] as const;

// ── 2차 명제 추출 프롬프트 — 유형별 변형 ─────────────────


function buildPropSystemPrompt(contentType: ContentType, dialogueSubtype?: DialogueSubtype): string {
	switch (contentType) {
		case 'lecture':  return SYSTEM_PROP_BASE + SYSTEM_PROP_LECTURE_ADDON;
		case 'meeting':  return SYSTEM_PROP_BASE + SYSTEM_PROP_MEETING_ADDON;
		case 'dialogue': return SYSTEM_PROP_BASE + (SYSTEM_PROP_DIALOGUE_ADDONS[dialogueSubtype ?? 'phone_call'] ?? '');
		default:         return SYSTEM_PROP_BASE + SYSTEM_PROP_DOCUMENT_ADDON;
	}
}

/**
 * rawText를 단락 단위로 분리한다.
 * 반환값의 offset은 rawText 내 해당 단락의 시작 위치 (trim 후 첫 글자 기준).
 */

// CLI 동시 호출 수. claude -p는 호출마다 에이전트 런타임을 콜드스타트하므로
// 순차(1)면 콜드스타트가 직렬로 쌓여 느리고, 무제한이면 프로세스가 폭주한다. 중간값으로 겹쳐 처리.
// 8 ≈ 30단락 기준 ~50s. 머신 RAM·백엔드 레이트리밋이 상한 — 스왑/429 나면 낮춰라.
const CLI_CONCURRENCY = 8;

/** 실패 시 짧은 backoff 후 재시도. 높은 동시성에서 순간 레이트리밋에 단락이 조용히 누락되는 것 방지. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 800): Promise<T> {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try { return await fn(); }
		catch (e) { lastErr = e; if (i < attempts - 1) await new Promise(r => window.setTimeout(r, delayMs)); }
	}
	throw lastErr;
}

/**
 * items를 최대 limit개씩 동시 처리하고 입력 순서대로 결과를 반환한다.
 * limit=1이면 순차, limit≥items.length면 전체 병렬과 동일.
 * primeFirst: 첫 아이템을 단독 실행해 프로바이더의 프롬프트 캐시를 채운 뒤 나머지를 병렬 처리.
 * (OpenAI/Claude/Gemini 자동 캐싱은 ≥1024토큰 공유 프리픽스에 발동 — 동시 발사하면 전부 캐시 미스)
 */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
	primeFirst = false,
): Promise<R[]> {
	const results: R[] = new Array<R>(items.length);
	let next = 0;
	if (primeFirst && items.length > 1) {
		results[0] = await fn(items[0], 0);
		next = 1;
	}
	const worker = async (): Promise<void> => {
		for (let i = next++; i < items.length; i = next++) {
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

// 단락 최소 길이 — 50자였던 과거 값은 "제가 다음 주 금요일까지 초안을 만들어볼게요" 같은
// 실제 커밋먼트·짧은 사실 문장(40자대)까지 통째로 드롭시켰다(실측: 액션 담당자 귀속 오류의
// 근본 원인). 순수 잡음(인사말·타임스탬프 단독) 배제는 이미 SYSTEM_PROP_BASE 프롬프트가
// "{"propositions": []}" 반환으로 처리하므로, 코드 레벨 하한은 최소한으로만 유지한다.
const MIN_PARAGRAPH_CHARS = 20;

export async function extractPropositions(
	contexts: ContextLayer[],
	rawText: string,
	settings: ThirdBrainSettings,
	contentType: ContentType = 'document',
	dialogueSubtype?: DialogueSubtype,
): Promise<Proposition[]> {
	// 섹션 헤딩(#, ##, ###)을 각 단락에 부착 — GPT가 소속 그룹을 오인하지 않도록
	// splitIntoParagraphs는 \n\n 기준으로 헤딩과 본문을 분리하므로, 여기서 직접 추적한다
	const paragraphs: Array<{ text: string; offset: number; sectionHint: string; headingPath: string }> = [];
	{
		const headings: [string, string, string] = ['', '', ''];
		const re2 = /\n{2,}/g;
		let lastIdx = 0;
		let m2: RegExpExecArray | null;
		while ((m2 = re2.exec(rawText)) !== null) {
			const seg = rawText.slice(lastIdx, m2.index);
			const trimmed = seg.trim();
			if (trimmed.startsWith('#')) {
				const level = (trimmed.match(/^(#+)/)?.[1] ?? '').length;
				const headingText = trimmed.replace(/^#+\s*/, '').trim();
				if (level === 1) { headings[0] = headingText; headings[1] = ''; headings[2] = ''; }
				else if (level === 2) { headings[1] = headingText; headings[2] = ''; }
				else { headings[2] = headingText; }
			} else if (trimmed.length >= MIN_PARAGRAPH_CHARS) {
				const lws = seg.length - seg.trimStart().length;
				const sectionHint = headings[2] || headings[1] || headings[0];
				const headingPath = headings.filter(Boolean).join(' > ');
				paragraphs.push({ text: trimmed, offset: lastIdx + lws, sectionHint, headingPath });
			}
			lastIdx = m2.index + m2[0].length;
		}
		const lastSeg = rawText.slice(lastIdx);
		const lastTrimmed = lastSeg.trim();
		if (!lastTrimmed.startsWith('#') && lastTrimmed.length >= MIN_PARAGRAPH_CHARS) {
			const lws = lastSeg.length - lastSeg.trimStart().length;
			const sectionHint = headings[2] || headings[1] || headings[0];
			const headingPath = headings.filter(Boolean).join(' > ');
			paragraphs.push({ text: lastTrimmed, offset: lastIdx + lws, sectionHint, headingPath });
		}
	}
	if (paragraphs.length === 0) {
		throw new Error('[명제 추출 0개]\n단락 분리 결과 없음 (rawText가 비어있거나 단락 구분이 없음)');
	}

	const contextList = contexts.map((c, i) => `[${i + 1}] ${c.title}`).join('\n');
	const schema = `{"propositions":[{"id":"p1","para":1,"title":"명사구","text":"한 문장 주장","role":"claim","proposition_type":"claim","context":"문맥 단위 제목","is_core_concept":false},{"id":"p2","para":2,"title":"명사구2","text":"한 문장 주장2","role":"claim","proposition_type":"fact","context":"문맥 단위 제목","is_core_concept":false}]}`;

	type RawProp = { id?: string; para?: number; title?: string; text?: string; role?: string; proposition_type?: string; context?: string; is_core_concept?: boolean };
	type Para = { text: string; offset: number; sectionHint: string; headingPath: string };
	type PropWithPara = { para: Para; prop: RawProp };

	let lastError: string | null = null;
	let errorCount = 0;

	const systemPropPrompt = buildPropSystemPrompt(contentType, dialogueSubtype);

	// [비용] 단락을 2~3개(≤2,000자)씩 묶어 한 콜로 — 콜마다 반복되는 시스템 프롬프트+문맥 목록이
	// 입력 토큰의 절반 이상이라 콜 수를 줄이는 게 캐싱보다 큰 절감. 묶음이 커질수록 명제 누락
	// 위험이 커지므로 보수적으로 유지. 명제→원 단락 그라운딩은 para 번호로 복원한다.
	const PROP_BATCH_MAX_CHARS = 2000;
	const PROP_BATCH_MAX_COUNT = 3;
	const batches: Array<{ paras: Para[]; firstIdx: number }> = [];
	{
		let cur: Para[] = [];
		let curChars = 0;
		let firstIdx = 0;
		paragraphs.forEach((p, i) => {
			if (cur.length > 0 && (cur.length >= PROP_BATCH_MAX_COUNT || curChars + p.text.length > PROP_BATCH_MAX_CHARS)) {
				batches.push({ paras: cur, firstIdx });
				cur = [];
				curChars = 0;
			}
			if (cur.length === 0) firstIdx = i;
			cur.push(p);
			curChars += p.text.length;
		});
		if (cur.length > 0) batches.push({ paras: cur, firstIdx });
	}

	const callBatch = async (batch: { paras: Para[]; firstIdx: number }): Promise<PropWithPara[]> => {
		// 이전 단락 컨텍스트 — 대명사·지시어 해소용 (회의/대화에서 특히 중요). 묶음 내부는 서로가 컨텍스트.
		const prevPara = batch.firstIdx > 0 ? paragraphs[batch.firstIdx - 1].text : '';
		const prevLine = prevPara ? `[이전 단락 — 대명사·지시어 참조]\n${prevPara.slice(0, 400)}\n\n` : '';
		const paraBlock = batch.paras.map((p, i) =>
			`[단락 ${i + 1}${p.sectionHint ? ` | 섹션: ${p.sectionHint}` : ''}]\n${p.text}`
		).join('\n\n');
		const prompt =
			`${systemPropPrompt}\n${jsonLangInstr(settings.lang)}\n\n` +
			`[문맥 단위 목록 — context 필드 선택용]\n${contextList}\n\n` +
			prevLine +
			`${paraBlock}\n\n` +
			`모든 [단락 N]을 빠짐없이 처리하고, 각 명제의 "para"에 그 명제가 나온 단락 번호 N을 기입하라.\n` +
			schema;
		try {
			const raw = await withRetry(() => callClaudeWithModel(
				prompt, settings.cliBin, 'fast',
				settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey,
			settings.openaiApiKey
			));
			const parsed = parseJson<{ propositions?: RawProp[] }>(raw, { propositions: [] });
			const out: PropWithPara[] = [];
			for (const p of (parsed.propositions ?? []).filter(p => p && p.text?.trim())) {
				// para 번호로 원 단락 그라운딩. 무효면 명제 서두가 포함된 단락 → 묶음 첫 단락 순 폴백.
				const byIdx = typeof p.para === 'number' ? batch.paras[p.para - 1] : undefined;
				const para = byIdx
					?? batch.paras.find(pp => pp.text.includes(String(p.text).trim().slice(0, 12)))
					?? batch.paras[0];
				out.push({ para, prop: p });
			}
			return out;
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
			errorCount++;
			return [];
		}
	};

	// CLI: 캐시 없음 → 워밍업 없이 제한 병렬 (콜드스타트 겹침 + 프로세스 폭주 방지).
	// API: 첫 콜 단독으로 프롬프트 캐시를 채운 뒤 병렬 — 동시 발사하면 전부 캐시 미스.
	const primeCache = settings.aiProvider !== 'claude-cli';
	const batchResults = await mapWithConcurrency(batches, CLI_CONCURRENCY, (b) => callBatch(b), primeCache);

	// 수집
	const allProps: Proposition[] = [];
	let propIdx = 1;
	for (const r of batchResults) {
		for (const { para, prop: p } of r) {
			allProps.push({
				id: `p${propIdx++}`,
				title: String(p.title || p.text).trim().slice(0, 40),
				text: String(p.text).trim(),
				role: (ALLOWED_ROLES.includes(p.role as PropositionRole) ? p.role : 'claim') as PropositionRole,
				proposition_type: p.proposition_type === 'fact' ? 'fact' : 'claim',
				context: typeof p.context === 'string' ? p.context.trim() : '',
				is_core_concept: p.is_core_concept === true,
				source_span: { text: para.text, offset: para.offset },
				block_id: `tb-${shortHash(para.text)}`,
				heading_path: para.headingPath || undefined,
			});
		}
	}

	if (allProps.length === 0) {
		if (lastError && errorCount > 0) {
			const errMsg: string = lastError ?? '';
			throw new Error(`[AI 호출 실패] ${errorCount}개 단락에서 오류:\n${errMsg}`);
		}
		throw new Error(`[명제 추출 0개]\n단락 ${paragraphs.length}개 처리 후 유효한 명제 없음`);
	}

	return allProps.slice(0, 20);
}

// ── 2.5차: 엣지 추출 (명제 간 크로스-컨텍스트) ──────────


// ── conflicts_with 오발 억제 게이트 (모순 판별 전용) ─────────────────────────
// AXIOM 프롬프트의 같은-사안 게이트가 놓친 잔여 모순 오발을 코드 레벨에서 차단한다.
// conflicts_with 후보에만 적용되며 다른 관계·액션 추출에는 관여하지 않는다.
// 순수 화폐/비용 단위 어휘만 등록한다. '인건비·반납·지급' 등 사안을 가리키는 단어는
// 두 명제가 같은 대상을 논하는지 가리는 핵심 단서라 제외한다(지우면 진짜 금액 모순을 놓친다).
const MONEY_UNIT_SRC = '비용|금액|예산|단가|경비|자금|억\\s*원|만\\s*원|[0-9]+\\s*원|돈';
const MONEY_UNIT_TEST = new RegExp(MONEY_UNIT_SRC);
const MONEY_UNIT_STRIP = new RegExp(MONEY_UNIT_SRC, 'g');
const KO_STOPCHUNK = /화자\d*|한다|하다|있다|없다|된다|되어|이다|그것|이것|우리|합니다|입니다/g;

/** 화폐 단위·불용 어절·조사 제거 후 길이 2+ 내용 토큰 집합 */
function conflictContentTokens(text: string): Set<string> {
	const stripped = text
		.replace(MONEY_UNIT_STRIP, ' ')
		.replace(KO_STOPCHUNK, ' ')
		.replace(/[^가-힣a-zA-Z0-9\s]/g, ' ');
	const out = new Set<string>();
	for (let tok of stripped.split(/\s+/)) {
		tok = tok.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|까지|부터|께|에게)$/, '');
		if (tok.length >= 2) out.add(tok);
	}
	return out;
}

/** 두 토큰 집합이 길이 2+ 공통 부분문자열(한국어 어근)조차 없으면 true = 완전 무관 */
function conflictNoOverlap(a: Set<string>, b: Set<string>): boolean {
	for (const x of a) {
		for (let i = 0; i <= x.length - 2; i++) {
			const frag = x.slice(i, i + 2);
			for (const y of b) if (y.includes(frag)) return false;
		}
	}
	return true;
}

/**
 * 두 명제가 화폐 단위를 공유하지만 금액 외 실제 사안은 전혀 겹치지 않으면 = 금액 어휘 오발.
 * 진짜 금액 모순(같은 돈의 처분을 두고 대립)은 '반납·할당' 등 사안 어근이 겹쳐 통과한다.
 */
function isMoneyVocabFalseConflict(aText: string, bText: string): boolean {
	if (!MONEY_UNIT_TEST.test(aText) || !MONEY_UNIT_TEST.test(bText)) return false;
	return conflictNoOverlap(conflictContentTokens(aText), conflictContentTokens(bText));
}

export async function extractEdges(
	allPropositions: Proposition[],
	contexts: ContextLayer[],
	_insights: Insight[], // 무시됨 (분석 단계에서만)
	settings: ThirdBrainSettings
): Promise<LogicEdge[]> {
	if (allPropositions.length < 2) return [];

	// 컨텍스트별 그룹핑 — 소속 문맥을 ### 헤더로 분리해 모델이 within/cross-context 관계를 구분하도록
	const ctxToProps = new Map<string, Array<{ idx: number; p: Proposition }>>();
	allPropositions.forEach((p, idx) => {
		const key = p.context || '(기타)';
		if (!ctxToProps.has(key)) ctxToProps.set(key, []);
		ctxToProps.get(key)!.push({ idx, p });
	});
	// 제목만 주면 모델이 어휘 유사성(비용·돈·시간)으로 무관한 명제를 모순으로 오판한다.
	// 관계 판정은 명제가 실제로 무엇을 주장하는지에 의존하므로 본문을 반드시 동봉한다.
	const propBlock = [...ctxToProps.entries()]
		.map(([ctx, items]) =>
			`### ${ctx}\n` +
			items.map(({ idx, p }) => {
				const stmt = p.text.replace(/\s+/g, ' ').trim().slice(0, 160);
				return `p${idx + 1} [${p.role}] ${p.title.slice(0, 40)}: ${stmt}`;
			}).join('\n')
		)
		.join('\n\n');
	// 컨텍스트 요약은 reason 작성 힌트용 — 요약당 150자, 전체 1500자 제한
	const contextBlock = contexts
		.map(c => `- ${c.title}: ${c.summary.slice(0, 150)}`)
		.join('\n')
		.slice(0, 1500);

	const edgeSchema = `{"edges":[{"source":"p1","target":"p2","relation":"supports","reason":"...","axiom_basis":"이 관계를 선택한 근거 원문","confidence":0.85}]}`;
	const prompt =
		`${SYSTEM_EDGES}\n${jsonLangInstr(settings.lang)}\n\n` +
		`[명제 목록]\n${propBlock}\n\n` +
		`[원본 문맥 요약 (reason/axiom_basis 근거로 활용)]\n${contextBlock}\n\n` +
		edgeSchema;

	type RawEdge = { source: string; target: string; relation: string; reason: string; axiom_basis?: string; confidence?: number };
	try {
		// [일관성] 다른 모든 추출 콜(명제·액션·대조 등)은 withRetry로 감싸져 있으나 이 콜만 단발이었다 —
		// 일시적 CLI 실패 시 catch가 빈 배열로 조용히 폴백하면서 문서 전체의 논리 엣지가 통째로 소실됐다
		// (실측: 명제 20개 규모 문서에서 재현). 다른 콜과 동일하게 재시도로 통일한다.
		const raw = await withRetry(() => callClaudeWithModel(
			prompt,
			settings.cliBin,
			'standard',
			settings.aiProvider,
			settings.claudeApiKey,
			settings.geminiApiKey,
			settings.openaiApiKey
		));
		const parsed = parseJson<{ edges?: RawEdge[] }>(raw, { edges: [] });

		// p1, p2... → 원본 ID로 매핑 (GPT가 "1" 형식으로 반환하는 경우도 처리)
		const pIndexMap = new Map<string, string>();
		allPropositions.forEach((p, idx) => {
			pIndexMap.set(`p${idx + 1}`, p.id);
			pIndexMap.set(String(idx + 1), p.id);
		});

		type ValidEdge = { source: string; target: string; relation: ReturnType<typeof toRelation>; reason: string; axiom_basis: string; confidence: number };

		// 1단계: 기본 유효성 검사 (자기루프·노드 누락·axiom_basis 없음 제거)
		const structurallyValid: ValidEdge[] = (parsed.edges ?? [])
			.map(e => {
				const source = pIndexMap.get(String(e.source)) || String(e.source);
				const target = pIndexMap.get(String(e.target)) || String(e.target);
				const confidence = typeof e.confidence === 'number' ? e.confidence : 0.0;
				const reason = String(e.reason ?? '').trim();
				const axiom_basis = (typeof e.axiom_basis === 'string' && e.axiom_basis.trim())
					? e.axiom_basis.trim()
					: reason;
				try {
					return { source, target, relation: toRelation(String(e.relation)), reason, axiom_basis, confidence };
				} catch {
					return null;
				}
			})
			.filter((e): e is ValidEdge => {
				if (!e) return false;
				if (e.axiom_basis.length === 0) return false;
				const hasSource = allPropositions.some(p => p.id === e.source);
				const hasTarget = allPropositions.some(p => p.id === e.target);
				if (!hasSource || !hasTarget) return false;
				if (e.source === e.target) return false;
				return true;
			});

		// conflicts_with·contrasts_with 오발 억제 — AXIOM_RELATIONS가 이 둘을 "같은 대상·같은
		// 사안일 때만 후보"라는 동일 규칙으로 묶으므로 게이트도 둘 다에 적용한다. 다른 관계는 그대로 통과.
		// 화폐 어휘만 겹치고 실제 사안은 무관한 쌍(예: 서버비용 ↔ 마케팅예산)을 걸러낸다.
		//
		// 주의: "같은 원문 블록 출처면 차단"(구 게이트①)은 폐기했다 — 전사본 재정형(reflowTranscript)
		// 도입 이후 블록 하나가 여러 화자의 여러 발화를 묶을 수 있어, "같은 발화를 쪼갠 두 명제라 모순
		// 아니다"라는 전제가 깨졌다. 오히려 진짜 대립 쌍(예: 예산 300 vs 500)이 같은 블록에서 나오는
		// 경우가 흔해져 이 게이트가 정답 엣지를 걸러버리는 위험이 더 커졌다.
		const propById = new Map(allPropositions.map(p => [p.id, p]));
		const conflictFiltered = structurallyValid.filter(e => {
			if (e.relation !== 'conflicts_with' && e.relation !== 'contrasts_with') return true;
			const a = propById.get(e.source);
			const b = propById.get(e.target);
			if (!a || !b) return true;
			if (isMoneyVocabFalseConflict(a.text, b.text)) return false;
			return true;
		});

		// 중복 제거: 대칭 관계(isomorphic_to·analogous_to·conflicts_with·contrasts_with)는
		// A→B와 B→A가 수학적으로 동일하므로 순서 무관 키로 정규화해 역방향 중복을 제거한다.
		// 신뢰도 높은 엣지를 남기기 위해 내림차순 정렬 후 dedup.
		const SYMMETRIC_RELATIONS = new Set(['isomorphic_to', 'analogous_to', 'conflicts_with', 'contrasts_with']);
		const seen = new Set<string>();
		const validEdges: ValidEdge[] = [...conflictFiltered]
			.sort((a, b) => b.confidence - a.confidence)
			.filter(e => {
				const key = SYMMETRIC_RELATIONS.has(e.relation)
					? [e.source, e.target].sort().join('↔')
					: `${e.source}→${e.target}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});

		// 2단계: confidence >= 0.75 필터
		const highConf = validEdges.filter(e => e.confidence >= 0.75);

		// 3단계: 고립 노드 폴백 — 연결 없는 명제에 최고 신뢰도 엣지 1개 연결 (CLAUDE.md 스펙)
		const connected = new Set(highConf.flatMap(e => [e.source, e.target]));
		for (const prop of allPropositions) {
			if (connected.has(prop.id)) continue;
			const fallback = validEdges
				.filter(e => e.source === prop.id || e.target === prop.id)
				.sort((a, b) => b.confidence - a.confidence)[0];
			if (fallback) highConf.push(fallback);
		}

		return highConf.map(e => ({
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

// ── 2.6차: 대조·유사성 전용 스캔 (Layer 3) ───────────────


export async function findContrastsAnalogies(
	allPropositions: Proposition[],
	settings: ThirdBrainSettings,
): Promise<LogicEdge[]> {
	if (allPropositions.length < 3) return [];

	const propList = allPropositions
		.map((p, i) => `p${i + 1} [${p.role}/${p.proposition_type}]: ${p.title.slice(0, 80)}`)
		.join('\n');

	const prompt =
		`${SYSTEM_CONTRASTS}\n${jsonLangInstr(settings.lang)}\n\n` +
		`[명제 목록]\n${propList}\n\n` +
		`{"edges":[{"source":"p1","target":"p3","relation":"contrasts_with","reason":"...","axiom_basis":"...","confidence":0.82}]}`;

	type RawEdge = { source: string; target: string; relation: string; reason: string; axiom_basis?: string; confidence?: number };
	try {
		const raw = await callClaudeWithModel(
			prompt, settings.cliBin, 'standard',
			settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey,
		);
		const parsed = parseJson<{ edges?: RawEdge[] }>(raw, { edges: [] });

		const pIndexMap = new Map<string, string>();
		allPropositions.forEach((p, idx) => {
			pIndexMap.set(`p${idx + 1}`, p.id);
			pIndexMap.set(String(idx + 1), p.id);
		});

		const seen = new Set<string>();
		const results: LogicEdge[] = [];
		for (const e of (parsed.edges ?? [])) {
			const source = pIndexMap.get(String(e.source)) || String(e.source);
			const target = pIndexMap.get(String(e.target)) || String(e.target);
			const confidence = typeof e.confidence === 'number' ? e.confidence : 0;
			if (confidence < 0.75 || source === target) continue;
			if (!allPropositions.some(p => p.id === source)) continue;
			if (!allPropositions.some(p => p.id === target)) continue;
			const reason = String(e.reason ?? '').trim();
			const axiom_basis = (typeof e.axiom_basis === 'string' && e.axiom_basis.trim())
				? e.axiom_basis.trim() : reason;
			if (!axiom_basis) continue;
			try {
				const rel = toRelation(String(e.relation));
				if (rel !== 'contrasts_with' && rel !== 'analogous_to' && rel !== 'isomorphic_to') continue;
				// extractEdges와 동일한 화폐 어휘 오발 게이트를 contrasts_with에도 적용
				// (같은-블록 차단은 폐기 — reflowTranscript 도입 이후 전제가 깨짐, extractEdges 주석 참조)
				if (rel === 'contrasts_with') {
					const srcProp = allPropositions.find(p => p.id === source);
					const tgtProp = allPropositions.find(p => p.id === target);
					if (srcProp && tgtProp && isMoneyVocabFalseConflict(srcProp.text, tgtProp.text)) continue;
				}
				// 이 단계는 대칭 관계만 생성 → 순서 무관 키로 A↔B 역방향 중복 제거
				const key = [source, target].sort().join('↔');
				if (seen.has(key)) continue;
				seen.add(key);
				results.push({ source, target, relation: rel, reason, axiom_basis, confidence });
			} catch { continue; }
		}
		return results;
	} catch {
		return [];
	}
}

// ── 3차: 액션망 추출 ────────────────────────────────────

// ── Phase 8-2: 액션 추출 v2 ──────────────────────────────────


type RawAction = {
	title?: string;
	content?: string;
	owner?: string;
	deadline?: string;
	link_type?: string;
	motivation_prop_titles?: string[];
};

/**
 * 액션 도출 (명제 우선, 토픽 내 종합).
 * 명제를 소속 토픽(context)별로 묶고, 각 토픽의 명제들을 종합해 복합 액션을 도출한다.
 * - [비용] 토픽 5개씩 한 콜로 배칭 — 시스템 프롬프트 반복 제거.
 * - 토픽 경계를 넘는 종합 금지는 검증으로 강제: 근거 명제들의 토픽이 하나로 일치하지 않으면 버린다.
 * - motivation_ids ≥ 1 필수: 명제에 뿌리 없는 붕 뜬 액션은 버린다.
 * - 원문 텍스트를 다시 읽지 않는다 — 명제는 이미 화자 정규화본에서 도출된 정제 소스.
 */
export async function extractActions(
	propositions: Proposition[],
	contexts: ContextLayer[],
	settings: ThirdBrainSettings
): Promise<Omit<ActionNode, 'filePath'>[]> {
	if (propositions.length === 0) return [];

	const byTopic = new Map<string, Proposition[]>();
	for (const p of propositions) {
		const key = p.context?.trim();
		if (!key) continue; // 토픽 없는 명제는 액션 도출 대상에서 제외
		if (!byTopic.has(key)) byTopic.set(key, []);
		byTopic.get(key)!.push(p);
	}
	if (byTopic.size === 0) return [];

	const ctxByTitle = new Map(contexts.map(c => [c.title, c]));
	const propByTitle = new Map(propositions.map(p => [p.title, p]));
	const results: Omit<ActionNode, 'filePath'>[] = [];

	// 토픽 5개씩 묶어 제한된 병렬로 처리. API는 첫 콜로 프롬프트 캐시를 채운 뒤 병렬.
	const ACTION_TOPICS_PER_CALL = 5;
	const topicEntries = [...byTopic.entries()];
	const topicGroups: Array<Array<[string, Proposition[]]>> = [];
	for (let i = 0; i < topicEntries.length; i += ACTION_TOPICS_PER_CALL) {
		topicGroups.push(topicEntries.slice(i, i + ACTION_TOPICS_PER_CALL));
	}

	const perGroupActions = await mapWithConcurrency(topicGroups, CLI_CONCURRENCY, async (group) => {
		const topicsBlock = group.map(([topicTitle, props]) =>
			`### 토픽: "${topicTitle}"\n${props.map(p => `- 「${p.title}」: ${p.text}`).join('\n')}`
		).join('\n\n');
		const prompt = `${SYSTEM_ACTIONS}\n${jsonLangInstr(settings.lang)}\n\n${topicsBlock}`;
		const out: Omit<ActionNode, 'filePath'>[] = [];
		try {
			const raw = await withRetry(() => callClaudeWithModel(
				prompt, settings.cliBin, 'fast',
				settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey,
			));
			const parsed = parseJson<{ actions?: RawAction[] }>(raw, { actions: [] });
			for (const a of parsed.actions ?? []) {
				if (!a.title?.trim()) continue;
				const motivProps = (a.motivation_prop_titles ?? [])
					.map(t => propByTitle.get(t))
					.filter((p): p is Proposition => !!p);
				if (motivProps.length === 0) continue; // 그라운딩 필수 — 명제 근거 없으면 버림
				// 토픽 경계 강제: 근거 명제가 전부 같은 토픽 소속이어야 한다 (교차 종합은 오염)
				const topicOf = motivProps[0].context?.trim() ?? '';
				if (!topicOf || motivProps.some(p => (p.context?.trim() ?? '') !== topicOf)) continue;
				const ctx = ctxByTitle.get(topicOf);
				const linkType: ActionLinkType = a.link_type === 'investigates' ? 'investigates' : 'implements';
				out.push({
					id:                      sanitizeActionId(a.title),
					title:                   a.title.trim().slice(0, 60),
					content:                 typeof a.content === 'string' ? a.content : '',
					owner:                   typeof a.owner === 'string' ? a.owner : '',
					deadline:                typeof a.deadline === 'string' ? a.deadline : '',
					status:                  'pending' as const,
					motivation_ids:          motivProps.map(p => p.id),
					motivation_context_ids:  ctx ? [ctx.id] : [],
					link_type:               linkType,
					origin:                  'extracted' as const,
					created:                 new Date().toISOString(),
				});
			}
		} catch { /* 이 그룹 실패 시 건너뜀 */ }
		return out;
	}, settings.aiProvider !== 'claude-cli');
	for (const arr of perGroupActions) results.push(...arr);
	return results;
}

function sanitizeActionId(s: string): string {
	return `act-${s.replace(/[\\/:*?"<>|#^[\]\s]/g, '-').toLowerCase().slice(0, 40)}-${Date.now().toString(36)}`;
}

// ── Phase 10: 문제 감지 (장애/공백/리스크) ─────────────────────
// 문제 = 의도를 서술하는 명제와 현실을 서술하는 명제 사이의 긴장.
// 모순(contradiction)은 conflicts_with 전담 기계가 처리 → 여기서 명시적 제외.
// 지시사항은 액션 레이어가 처리 → "시켜서 하는 일"은 문제가 아님.

export interface DetectedProblem {
	title: string;
	description: string;
	species: Exclude<ProblemSpecies, 'contradiction'>;
	evidence_ids: string[];   // 해석된 증거 명제 basename (≥1 보장)
	suggested_action?: { title: string; content: string; link_type: ActionLinkType };
}


type RawProblem = {
	title?: string;
	description?: string;
	species?: string;
	evidence_titles?: string[];
	suggested_action?: { title?: string; content?: string; link_type?: string };
};

/**
 * 폴더 전체 명제에서 긴장(장애/공백/리스크)을 감지한다.
 * - propositions: 저장된 명제 노드 (id=basename). ~60개 상한.
 * - openProblemTitles: 이미 열린 문제 제목 — 중복 생성 방지용 프롬프트 주입.
 * - 검증 게이트: species 화이트리스트 + evidence 해석 실패 시 해당 문제 폐기.
 */
export async function detectProblems(
	propositions: Array<{ id: string; title: string; text: string }>,
	openProblemTitles: string[],
	settings: ThirdBrainSettings,
): Promise<DetectedProblem[]> {
	if (propositions.length === 0) return [];
	const props = propositions.slice(0, 60);
	const propBlock = props.map(p => `- 「${p.title}」: ${p.text.slice(0, 200)}`).join('\n');
	const openBlock = openProblemTitles.length > 0
		? `\n\n이미 열린 문제 (중복 생성 금지):\n${openProblemTitles.map(t => `- ${t}`).join('\n')}`
		: '';
	const prompt = `${SYSTEM_PROBLEMS}\n${jsonLangInstr(settings.lang)}\n\n명제 목록:\n${propBlock}${openBlock}`;

	// 제목→basename 해석 (title 또는 id 어느 쪽으로 인용해도 수용)
	const idByTitle = new Map<string, string>();
	for (const p of props) {
		idByTitle.set(p.title, p.id);
		idByTitle.set(p.id, p.id);
	}
	const VALID_SPECIES = new Set(['obstacle', 'gap', 'risk']);

	try {
		const raw = await withRetry(() => callClaudeWithModel(
			prompt, settings.cliBin, 'standard',
			settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey,
		));
		const parsed = parseJson<{ problems?: RawProblem[] }>(raw, { problems: [] });
		const results: DetectedProblem[] = [];
		for (const p of parsed.problems ?? []) {
			if (!p.title?.trim() || !VALID_SPECIES.has(String(p.species))) continue;
			const evidenceIds = (p.evidence_titles ?? [])
				.map(t => idByTitle.get(String(t).trim()))
				.filter((id): id is string => !!id);
			if (evidenceIds.length === 0) continue; // 그라운딩 필수 — 증거 해석 실패 시 폐기
			const sa = p.suggested_action;
			results.push({
				title: p.title.trim().slice(0, 60),
				description: typeof p.description === 'string' ? p.description.trim() : '',
				species: p.species as DetectedProblem['species'],
				evidence_ids: [...new Set(evidenceIds)],
				suggested_action: sa?.title?.trim()
					? {
						title: sa.title.trim().slice(0, 60),
						content: typeof sa.content === 'string' ? sa.content : '',
						link_type: sa.link_type === 'investigates' ? 'investigates' : 'implements',
					}
					: undefined,
			});
		}
		return results;
	} catch {
		return []; // 감지 실패는 파이프라인을 중단시키지 않음
	}
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
		`Map each action to the propositions it implements or investigates.\n` +
		`${jsonLangInstr(settings.lang)}\n` +
		`{"mappings":[{"action_id":"...","prop_ids":["prop-id-1"]}]}\n\n` +
		`Actions:\n${actionList}\n\nPropositions:\n${propList}`;

	try {
		const raw = await callClaudeWithModel(
			prompt,
			settings.cliBin,
			'fast',
			settings.aiProvider,
			settings.claudeApiKey,
			settings.geminiApiKey,
		settings.openaiApiKey
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
	settings: ThirdBrainSettings
): Promise<EdgeCandidate[]> {
	if (existingFiles.length === 0) return [];

	const fileList = existingFiles.slice(0, 60).join('\n');
	const prompt =
		`핵심 명제와 기존 파일 목록을 비교하여 논리적 연관성이 높은 파일 최대 ${maxCandidates}개를 추천하라. ` +
		`연관이 약하거나 억지스러우면 빈 배열 반환(과잉 추천 금지). JSON만 반환(코드블록 없이).\n\n` +
		`핵심 명제: "${coreTitle}"\n요약: ${contextSummary.slice(0, 1500)}\n\n기존 파일:\n${fileList}\n\n` +
		`{"recommendations":[{"target_file":"파일명.md","label":"supports","reason":"연결 근거 한 줄","source_node":"출발 명제 제목"}]}`;

	try {
		const raw = await callClaudeWithModel(prompt, settings.cliBin, 'fast', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey);
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

	const prompt = `${SYSTEM_BRIDGE}\n${jsonLangInstr(settings.lang)}\n\n${candidatesText}\n\n` +
		`JSON 응답 예시:\n{"edges":[{"source_title":"폴더A 노드 제목","target_title":"폴더B 노드 제목","relation":"isomorphic_to","confidence":0.85,"reason":"근거 한 줄","axiom_basis":"두 노드 내용에서 인용한 근거 구절"}],"insight":"통찰 2~3문장"}`;

	// Phase 12: 모델 라우팅 추가 (standard 티어)
	const raw = await callClaudeWithModel(
		prompt,
		settings.cliBin,
		'standard',
		settings.aiProvider,
		settings.claudeApiKey,
		settings.geminiApiKey,
		settings.openaiApiKey
	);
	const parsed = parseJson<{ edges?: Array<Record<string, unknown>>; insight?: string }>(
		raw, { edges: [], insight: '' }
	);

	const edges: BridgeEdge[] = (parsed.edges ?? [])
		.filter(e => e && (e['source_title'] || e['source_file']) && (e['target_title'] || e['target_file']))
		// 엄격 게이트: 근거 인용(axiom_basis) 없는 연결은 폐기 — 밸리데이션 레이어와 동일 기준
		.filter(e => typeof e['axiom_basis'] === 'string' && e['axiom_basis'].trim().length > 0)
		.map(e => ({
			source_title: typeof e['source_title'] === 'string' ? e['source_title'] : undefined,
			target_title: typeof e['target_title'] === 'string' ? e['target_title'] : undefined,
			source_file:  typeof e['source_file'] === 'string' ? e['source_file'] : (typeof e['source_title'] === 'string' ? e['source_title'] + '.md' : ''),
			target_file:  typeof e['target_file'] === 'string' ? e['target_file'] : (typeof e['target_title'] === 'string' ? e['target_title'] + '.md' : ''),
			relation: toRelation(typeof e['relation'] === 'string' ? e['relation'] : 'analogous_to'),
			confidence: typeof e['confidence'] === 'number' ? e['confidence'] : 0.5,
			reason: typeof e['reason'] === 'string' ? e['reason'] : '',
			axiom_basis: (e['axiom_basis'] as string).trim(),
		}));

	return {
		edges,
		insight: typeof parsed.insight === 'string' ? parsed.insight : '',
	};
}

// ── 뷰어: 폴더 핵심 서브그래프 요약 (풍부한 분석) ──────


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
		`${SYSTEM_SUMMARY}\n${jsonLangInstr(settings.lang)}\n\n${modeDirective}\n${intentDirective}\n` +
		`다음 핵심 서브그래프 다이제스트를 요약하라:\n\n` +
		`{"synthesis":"...","overview":"...","themes":[{"title":"...","description":"..."}],"highlights":["..."],"link_contexts":[{"source":"...","target":"...","relation":"...","context":"..."}]}\n\n` +
		`---\n\n${digest}`;

	const raw = await callClaudeWithModel(
		prompt,
		settings.cliBin,
		'standard',
		settings.aiProvider,
		settings.claudeApiKey,
		settings.geminiApiKey,
		settings.openaiApiKey
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


export async function classifyNode(
	content: string,
	settings: ThirdBrainSettings,
	onProgress?: (msg: string) => void
): Promise<NodeClassification> {
	onProgress?.('노드 속성 분류 중...');
	const prompt = `${SYSTEM_CLASSIFY}\n\n다음 노트를 분류하라:\n\n"""\n${content.slice(0, 6000)}\n"""`;

	const raw = await callClaudeWithModel(prompt, settings.cliBin, 'standard', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey);
	const result = parseJson<Partial<NodeClassification>>(raw, {});

	return {
		title: result.title?.trim() || '미분류 노트',
		type: (result.type as NodeClassification['type']) || 'claim',
		tags: Array.isArray(result.tags) ? result.tags.slice(0, 6) : [],
		summary: result.summary?.trim() || '',
	};
}

// ── 이식 시 대상 폴더 연결 추천 ──────────────────────────


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

	const prompt = `${SYSTEM_TRANSPLANT_EDGES}\n${jsonLangInstr(settings.lang)}\n\n## 새로 이식할 노트\n제목: ${newTitle}\n\n${newContent.slice(0, 4000)}\n\n---\n## 기존 노드 목록\n${nodeList}`;

	try {
		const raw = await callClaudeWithModel(prompt, settings.cliBin, 'standard', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey);
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

// ── 나이브 요약: 그래프화와 별개로 원문 전체를 훑는 커버리지 체크용 ────

/**
 * 명제 추출·엣지 타입화 없이 원문 전체를 자연스러운 산문으로 요약한다.
 * 구조화 파이프라인이 축·공리 기준에 맞지 않아 누락시킨 뉘앙스·맥락을 보완하는 용도.
 */
export async function generateNaiveSummary(
	text: string,
	settings: ThirdBrainSettings,
): Promise<{ title: string; summary: string }> {
	const ko = settings.lang !== 'en';
	const excerpt = text.slice(0, 30000);
	const prompt = ko
		? `다음 텍스트 전체를 항목별로 쪼개지 말고, 자연스러운 산문으로 요약하세요.
구조화된 명제나 논리 관계로 나누지 말고, 사람이 이 글을 처음 읽고 이해한 것처럼 전체 맥락과 뉘앙스를 살려 요약하세요.
짧은 제목(한국어 20자 이내, 파일명에 쓸 수 있게 특수문자 없이)도 함께 만드세요.

텍스트:
"""
${excerpt}
"""

JSON만 반환(코드블록 없이):
{"title":"제목","summary":"요약 본문"}`
		: `Summarize the following text as a whole, in natural prose — do not break it into itemized propositions or logical relations.
Capture the overall context and nuance as a human reader would understand it on first read.
Also create a short title (under 25 characters, filename-safe).

Text:
"""
${excerpt}
"""

Return JSON only (no code blocks):
{"title":"title","summary":"summary body"}`;

	const raw = await callClaudeWithModel(prompt, settings.cliBin, 'standard', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey);
	const parsed = parseJson<{ title?: string; summary?: string }>(raw, {});

	return {
		title: (parsed.title ?? '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30) || (ko ? '요약' : 'Summary'),
		summary: parsed.summary?.trim() || '',
	};
}

// ── 저장 후 Cross-Connection: 새 명제 ↔ 기존 폴더 노드 ────


export interface CrossConnection {
	new_title: string;
	existing_title: string;
	relation: string;
	confidence: number;
	reason: string;
	axiom_basis: string;
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

	const prompt = `${SYSTEM_CROSS}\n${jsonLangInstr(settings.lang)}\n\n## 새로 저장된 명제들\n${newList}\n\n---\n## 폴더 기존 노드들\n${existingList}`;

	try {
		const raw = await callClaudeWithModel(
			prompt, settings.cliBin, 'standard',
			settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey,
		settings.openaiApiKey
		);
		const result = parseJson<{ connections?: unknown[] }>(raw, { connections: [] });
		if (!Array.isArray(result.connections)) return [];
		// 엄격 게이트: 10공리 밖 relation·근거 인용(axiom_basis) 없는 연결은 폐기 — 밸리데이션 레이어와 동일 기준
		return (result.connections as CrossConnection[])
			.map(c => ({
				...c,
				confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
				axiom_basis: typeof c.axiom_basis === 'string' ? c.axiom_basis.trim() : '',
			}))
			.filter(c => isValidRelation(c.relation) && c.axiom_basis.length > 0)
			.slice(0, 8);
	} catch {
		return [];
	}
}

// ── Phase 5 bridgeFolders 이미 위에 있음 ─────────────────

// ── 유틸 ─────────────────────────────────────────────────


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
				ctxNew: contextsA[p.new_idx],
				ctxExisting: contextsB[p.existing_idx],
				similarity: p.similarity,
			}))
			.sort((a, b) => b.similarity - a.similarity);
	} catch {
		return [];
	}
}

// ── 모순 해소: 엣지 재분류 ──────────────────────────────────────

export interface EdgeRank {
	relation: TBEdgeRelation;
	confidence: number;
	reason: string;
}

/**
 * 두 명제 사이의 관계를 conflicts_with 제외 9종 중에서 재평가.
 * 신뢰도 내림차순 상위 4개를 반환한다.
 */

export async function rankEdgeRelations(
	nodeA: { title: string; content?: string },
	nodeB: { title: string; content?: string },
	evidence: string,
	settings: ThirdBrainSettings
): Promise<EdgeRank[]> {
	const ko = settings.lang !== 'en';
	const prompt = ko
		? `두 명제 사이의 관계를 분석하세요. 겉으로 충돌처럼 보여도 더 정확한 관계가 있을 수 있습니다.
모두 한국어로 작성. JSON만 반환(코드블록 없이).

명제 A: "${nodeA.title}"${nodeA.content ? `\n내용: ${nodeA.content.slice(0, 300)}` : ''}
명제 B: "${nodeB.title}"${nodeB.content ? `\n내용: ${nodeB.content.slice(0, 300)}` : ''}
기존 충돌 근거: "${evidence}"

아래 9가지 관계 중 신뢰도 높은 순으로 최대 4개를 반환하세요.
(conflicts_with 제외 — 이미 해당 관계로 분류됨)

관계:
causes | precedes | precondition_of | supports | contrasts_with | exemplifies | applies_to | analogous_to | isomorphic_to

JSON만 반환:
{"relations":[{"relation":"supports","confidence":0.85,"reason":"A가 B의 근거를 제공함"}]}`
		: `Analyze the relationship between two propositions. Although they may conflict, a more precise relation may exist.
All output in English. Return JSON only (no code blocks).

Proposition A: "${nodeA.title}"${nodeA.content ? `\nContent: ${nodeA.content.slice(0, 300)}` : ''}
Proposition B: "${nodeB.title}"${nodeB.content ? `\nContent: ${nodeB.content.slice(0, 300)}` : ''}
Existing conflict evidence: "${evidence}"

Return up to 4 of the 9 relations below, ranked by confidence descending.
(conflicts_with excluded — already classified as such)

Relations:
causes | precedes | precondition_of | supports | contrasts_with | exemplifies | applies_to | analogous_to | isomorphic_to

Return JSON only (no code blocks):
{"relations":[{"relation":"supports","confidence":0.85,"reason":"A provides evidence for B"}]}`;

	try {
		const raw = await callClaudeWithModel(
			prompt,
			settings.cliBin,
			'standard',
			settings.aiProvider,
			settings.claudeApiKey,
			settings.geminiApiKey,
		settings.openaiApiKey
		);
		const parsed = parseJson<{ relations?: Array<{ relation: string; confidence: number; reason: string }> }>(raw, { relations: [] });
		return (parsed.relations ?? [])
			.slice(0, 4)
			.map(r => {
				try {
					return { relation: toRelation(r.relation), confidence: r.confidence ?? 0, reason: r.reason ?? '' };
				} catch {
					return null;
				}
			})
			.filter((r): r is EdgeRank => r !== null);
	} catch {
		return [];
	}
}

// ── 그래프 쿼리 파싱 ──────────────────────────────────────

export interface GraphQuerySpec {
	relations: TBEdgeRelation[];
	startNodeTitle?: string;
	maxHops?: number;
}

// ── 전사본 분석 3모드 (그래프 노드 → 텍스트 보고서) ─────────

export type TranscriptAnalysisMode = 'language' | 'info' | 'directive' | 'para';

export async function analyzeTranscriptNodes(
	nodes: Array<{ title: string; type: string; content: string }>,
	mode: TranscriptAnalysisMode,
	settings: ThirdBrainSettings,
): Promise<string> {
	const isKo = (settings.lang ?? 'en') === 'ko';
	const nodeList = nodes
		.map(n => `[${n.type}] ${n.title}\n${n.content.slice(0, 600)}`)
		.join('\n\n---\n\n');
	const titleIndex = nodes.map(n => `[[${n.title}]]`).join(', ');
	const wikilinkRule = isKo
		? `\n\n## 위키링크 규칙\n출처 노드를 언급할 때는 반드시 [[노드 제목]] 형식의 위키링크를 사용하세요.\n사용 가능한 노드: ${titleIndex}`
		: `\n\n## Wikilink Rule\nWhen referencing a source node, always use [[Node Title]] wikilink syntax.\nAvailable nodes: ${titleIndex}`;

	const systemPrompt = (() => {
		if (mode === 'language') return isKo
			? `당신은 영어 회화 코치입니다. 아래는 영어 스터디 세션에서 추출된 표현/문맥 노드들입니다.\n반복 패턴, 문법 문제를 짚어주고 더 자연스러운 대안 표현을 추천해 주세요. 마크다운으로 정리하세요.${wikilinkRule}\n\n## 노드 목록\n\n${nodeList}`
			: `You are an English conversation coach. Below are expression/context nodes from a language study session.\nPoint out recurring patterns and grammar issues, and recommend more natural alternatives. Organize in markdown.${wikilinkRule}\n\n## Node List\n\n${nodeList}`;
		if (mode === 'info') return isKo
			? `당신은 지식 정리 전문가입니다. 아래는 정보 공유 회의에서 추출된 맥락·명제·인사이트 노드들입니다.\n핵심 정보를 체계적으로 정리하고 논리 흐름을 요약해 주세요. 마크다운으로 작성하세요.${wikilinkRule}\n\n## 노드 목록\n\n${nodeList}`
			: `You are a knowledge organizer. Below are context/proposition/insight nodes from an information-sharing meeting.\nOrganize the key information systematically and summarize the logical flow. Write in markdown.${wikilinkRule}\n\n## Node List\n\n${nodeList}`;
		if (mode === 'para') return isKo
			? `당신은 PARA 방법론 전문가입니다. 아래 노드들을 티아고 포르테의 PARA 체계로 분류해 주세요.\n\n- **Project (프로젝트)**: 명확한 기한과 목표가 있는 단기 업무\n- **Area (영역)**: 지속적으로 관리해야 할 책임 분야\n- **Resource (자원)**: 나중에 참고할 정보 및 관심사\n- **Archive (아카이브)**: 완료되었거나 비활성화된 정보\n\n각 범주 아래 해당 노드를 나열하고 분류 이유를 한 줄로 설명하세요. 마크다운으로 작성하세요.${wikilinkRule}\n\n## 노드 목록\n\n${nodeList}`
			: `You are a PARA methodology expert. Classify the nodes below using Tiago Forte's PARA system.\n\n- **Project**: Short-term efforts with a clear deadline and goal\n- **Area**: Ongoing responsibilities to maintain over time\n- **Resource**: Reference information and interests for future use\n- **Archive**: Completed or inactive information\n\nList nodes under each category with a one-line reason. Write in markdown.${wikilinkRule}\n\n## Node List\n\n${nodeList}`;
		return isKo
			? `당신은 업무 정리 전문가입니다. 아래는 지시성 회의에서 추출된 맥락·액션 노드들입니다.\n지시 사항을 담당자별, 우선순위별로 명확하게 정리해 주세요. 마크다운으로 작성하세요.${wikilinkRule}\n\n## 노드 목록\n\n${nodeList}`
			: `You are a task management expert. Below are context/action nodes from a directive meeting.\nClearly organize the directives by assignee and priority. Write in markdown.${wikilinkRule}\n\n## Node List\n\n${nodeList}`;
	})();

	const rawUnknown = await callClaudeWithModel(systemPrompt, settings.cliBin, 'fast', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey, false);
	const raw = typeof rawUnknown === 'string' ? rawUnknown : JSON.stringify(rawUnknown);
	return raw.trim();
}

export async function parseGraphQuery(
	prompt: string,
	nodeContext: Array<{ title: string; type: string }>,
	settings: ThirdBrainSettings,
): Promise<GraphQuerySpec> {
	const sampleTitles = nodeContext.slice(0, 50).map(n => `"${n.title}" (${n.type})`).join(', ');
	const systemPrompt =
`You are a graph query assistant that translates natural-language requests into structured filter specs.

Available relation types (return only these exact strings):
- causes: A directly causes B
- precedes: A temporally precedes B
- precondition_of: A is a prerequisite for B
- supports: A provides evidence for B
- conflicts_with: A contradicts B
- contrasts_with: A differs from B in a notable way
- exemplifies: A is a concrete example of B
- applies_to: A applies a principle to domain B
- analogous_to: A has similar structure to B
- isomorphic_to: A has identical logical structure to B

Sample nodes available: ${sampleTitles}

User request: "${prompt}"

Return ONLY compact JSON (no markdown, no explanation):
{"relations":["relation1","relation2"],"startNodeTitle":"optional exact title from sample","maxHops":3}
- relations: which edge types to highlight (required, 1–10)
- startNodeTitle: BFS origin node if user mentions a specific concept (optional, must be from sample list)
- maxHops: BFS depth if startNodeTitle set (optional, default 3)`;

	try {
		const rawUnknown = await callClaudeWithModel(systemPrompt, settings.cliBin, 'fast', settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey);
		const raw = typeof rawUnknown === 'string' ? rawUnknown : JSON.stringify(rawUnknown);
		const json = raw.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
		const parsed = JSON.parse(json) as { relations?: string[]; startNodeTitle?: string; maxHops?: number };
		const validRelations = (parsed.relations ?? [])
			.map(r => { try { return toRelation(r); } catch { return null; } })
			.filter((r): r is TBEdgeRelation => r !== null);
		return {
			relations: validRelations.length > 0 ? validRelations : (['causes', 'supports'] as TBEdgeRelation[]),
			startNodeTitle: typeof parsed.startNodeTitle === 'string' ? parsed.startNodeTitle : undefined,
			maxHops: typeof parsed.maxHops === 'number' ? parsed.maxHops : 3,
		};
	} catch {
		return { relations: ['causes', 'supports'] as TBEdgeRelation[] };
	}
}

// ── 고립 노드 연결 후보 탐색 ──────────────────────────────

export interface OrphanConnectionResult {
	targetId: string;
	targetTitle: string;
	relation: TBEdgeRelation;
	confidence: number;
	reason: string;
}

export async function findOrphanConnections(
	orphan: TBNode,
	candidates: TBNode[],
	settings: ThirdBrainSettings
): Promise<OrphanConnectionResult[]> {
	if (candidates.length === 0) return [];

	// salience 기준 상위 8개로 압축
	const sample = candidates.slice(0, 8);

	const candidateList = sample
		.map((n, i) => `[${i}] "${n.title}"${n.content ? `: ${n.content.slice(0, 120)}` : ''}`)
		.join('\n');

	const prompt =
`You are analyzing an isolated knowledge node with no connections to the rest of the graph.
${jsonLangInstr(settings.lang)}

Isolated node: "${orphan.title}"${orphan.content ? `\nContent: ${orphan.content.slice(0, 300)}` : ''}

Candidate nodes in the graph:
${candidateList}

Find the best logical connection(s) between the isolated node and one or more candidates.
Only suggest connections with confidence >= 0.65. If none qualify, return an empty array.
Relations: causes | precedes | precondition_of | supports | conflicts_with | contrasts_with | exemplifies | applies_to | analogous_to | isomorphic_to

Return JSON only (no code blocks):
{"connections":[{"index":0,"relation":"supports","confidence":0.82,"reason":"..."}]}`;

	try {
		const raw = await callClaudeWithModel(
			prompt,
			settings.cliBin,
			'fast',
			settings.aiProvider,
			settings.claudeApiKey,
			settings.geminiApiKey,
			settings.openaiApiKey
		);
		const parsed = parseJson<{ connections?: Array<{ index: number; relation: string; confidence: number; reason: string }> }>(raw, { connections: [] });
		return (parsed.connections ?? [])
			.filter(c => typeof c.index === 'number' && c.index >= 0 && c.index < sample.length)
			.map(c => {
				try {
					return {
						targetId: sample[c.index].id,
						targetTitle: sample[c.index].title,
						relation: toRelation(c.relation),
						confidence: c.confidence ?? 0,
						reason: c.reason ?? '',
					};
				} catch {
					return null;
				}
			})
			.filter((r): r is OrphanConnectionResult => r !== null)
			.filter(r => r.confidence >= 0.65);
	} catch {
		return [];
	}
}
