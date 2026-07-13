// graph-store.ts에서 분리한 문맥 관련성/링크 판정 로직.
// Hub 오염 방지(오배정 context 차단) + 고립 구제(최적 context 재연결)를 담당하는 this 비의존 순수 함수.

/**
 * [Hub 오염 방지] 명제가 배정된 context와 실제로 다른 섹션 소속인지 판정한다.
 *
 * 다중 토픽 원문(예: 여러 뉴스 아이템)에서 AI가 명제의 context를 잘못 배정하면
 * 무관한 context 노드가 그 명제를 precondition_of/supports 로 흡수해 hub가 오염된다.
 * heading_path(문서 구조)를 근거로 재검증한다:
 *   - heading_path 첫 섹션이 배정 context와 매칭되면 정상 (false)
 *   - 배정 context와 불일치하고 *다른* context와는 매칭되면 오배정으로 판단 (true)
 * heading_path가 없거나 context가 1개뿐이면 판정 불가 → 통과(false).
 */
export function isMisassignedContext(
	propContext: string,
	headingPath: string | undefined,
	allContextTitles: string[]
): boolean {
	if (!headingPath || allContextTitles.length <= 1) return false;
	const firstHeading = headingPath.split('>')[0].trim().toLowerCase();
	if (!firstHeading) return false;

	const assigned = propContext.toLowerCase();
	const assignedMatches = firstHeading.includes(assigned) || assigned.includes(firstHeading);
	if (assignedMatches) return false;

	// 배정 context는 안 맞는데 다른 context가 첫 섹션과 매칭 → 오배정
	return allContextTitles.some(t => {
		if (t === propContext) return false;
		const tl = t.toLowerCase();
		return firstHeading.includes(tl) || tl.includes(firstHeading);
	});
}

// 모든 노드에 편재해 변별력이 없는 일반 용어 — 관련성 점수 계산에서 제외
const GENERIC_CONTEXT_TERMS = new Set(['ai', '인공지능', '기술', '모델', '서비스', '기능', '공개']);

type CtxLike = { title: string; keywords?: string[]; tags?: string[] };

/** context의 대표 토큰(keywords + tags + 제목 분절) 집합. 일반 용어·1글자는 제외. */
function contextTerms(ctx: CtxLike): string[] {
	const rawTerms = [
		...(ctx.keywords ?? []),
		...(ctx.tags ?? []),
		...ctx.title.split(/[\s/·,]+/),
	];
	return [...new Set(
		rawTerms
			.map(t => t.trim().toLowerCase())
			.filter(t => t.length >= 2 && !GENERIC_CONTEXT_TERMS.has(t))
	)];
}

/**
 * [Hub 오염 방지] 명제 신호(제목+본문+원문 발췌)와 context의 대표 토큰의 겹침 비율을 계산한다.
 * heading_path가 없는 원문(뉴스레터 등)에서도 동작하는 콘텐츠 무관 신호.
 *
 * 한국어 조사( "노트북LM은" )를 흡수하기 위해 토큰 완전일치가 아닌 substring 포함으로 매칭한다.
 * @returns 0~1 (context 대표 토큰 중 명제 신호에 등장한 비율). 판정 근거 없으면 1(통과).
 */
export function contextRelevanceScore(propSignal: string, ctx: CtxLike): number {
	const terms = contextTerms(ctx);
	if (terms.length === 0) return 1; // 판정 근거 없음 → 통과
	const hay = propSignal.toLowerCase();
	const hits = terms.filter(t => hay.includes(t)).length;
	return hits / terms.length;
}

/**
 * [고립 구제] AI 배정 context 연결이 실패한 명제를, 전체 context 중 관련성 점수가 가장 높은
 * context에 연결하기 위해 최적 후보를 찾는다. AI 판단을 덮어쓰므로 가드(0.12)보다 엄격한 임계값 사용.
 * @returns 임계값 초과 최적 context, 없으면 null. 대표 토큰이 없는 context는 후보에서 제외.
 */
export function bestContextByRelevance<T extends CtxLike>(
	prop: { title: string; text: string; source_span?: { text: string } },
	contexts: T[],
	threshold = 0.1  // [Phase 2] membership은 저위험 필드 → 공격적 배정 (오그룹핑은 grouping 오류일 뿐 논리 그래프 무오염)
): T | null {
	const signal = `${prop.title} ${prop.text} ${prop.source_span?.text ?? ''}`;
	let best: T | null = null;
	let bestScore = threshold; // 초기값=임계값 → 이를 초과해야 채택
	for (const ctx of contexts) {
		if (contextTerms(ctx).length === 0) continue; // 판정 불가 context는 구제 대상 아님
		const score = contextRelevanceScore(signal, ctx);
		if (score > bestScore) {
			bestScore = score;
			best = ctx;
		}
	}
	return best;
}

/** 명제를 배정 context에 auto-link해도 되는지 최종 판정.
 *  heading_path 오배정(강신호) 또는 의미 관련성 부족(약신호)이면 연결 금지. */
export function shouldLinkContext(
	prop: { context: string; heading_path?: string; title: string; text: string; source_span?: { text: string } },
	ctx: { title: string; keywords?: string[]; tags?: string[] },
	allContextTitles: string[],
	relevanceThreshold = 0.05  // [Phase 2] membership 저위험 → 관대하게 (egregious 불일치만 차단)
): boolean {
	if (isMisassignedContext(prop.context, prop.heading_path, allContextTitles)) return false;
	const signal = `${prop.title} ${prop.text} ${prop.source_span?.text ?? ''}`;
	return contextRelevanceScore(signal, ctx) >= relevanceThreshold;
}
