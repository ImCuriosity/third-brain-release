// serial-pipeline.ts에서 분리한 순수 텍스트/JSON 유틸 — this 비의존, AI 호출 없음.

export function splitIntoParagraphs(text: string, minLen = 50): { text: string; offset: number }[] {
	const result: { text: string; offset: number }[] = [];
	const re = /\n{2,}/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = re.exec(text)) !== null) {
		const segment = text.slice(lastIndex, match.index);
		const trimmed = segment.trim();
		if (trimmed.length >= minLen) {
			const leadingWS = segment.length - segment.trimStart().length;
			result.push({ text: trimmed, offset: lastIndex + leadingWS });
		}
		lastIndex = match.index + match[0].length;
	}
	const last = text.slice(lastIndex);
	const lastTrimmed = last.trim();
	if (lastTrimmed.length >= minLen) {
		const leadingWS = last.length - last.trimStart().length;
		result.push({ text: lastTrimmed, offset: lastIndex + leadingWS });
	}
	return result;
}

export function shortHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < Math.min(text.length, 300); i++) {
		h = ((h << 5) + h) ^ text.charCodeAt(i);
		h |= 0;
	}
	return Math.abs(h).toString(36).slice(0, 6).padStart(6, '0');
}

export function splitIntoChunks(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];

	const paragraphs = text.split(/\n{2,}/);
	const chunks: string[] = [];
	let current = '';

	for (const para of paragraphs) {
		if (para.length > maxChars) {
			if (current) { chunks.push(current.trim()); current = ''; }
			// 초과 단락은 문장 중간이 아니라 마지막 개행(발화 경계)에서 절단.
			// 개행이 너무 앞쪽(30% 미만)이면 기존 하드컷 유지 — 무한루프·초미니 청크 방지.
			let rest = para;
			while (rest.length > maxChars) {
				let cut = rest.lastIndexOf('\n', maxChars);
				if (cut < maxChars * 0.3) cut = maxChars;
				chunks.push(rest.slice(0, cut).trim());
				rest = rest.slice(cut);
			}
			if (rest.trim()) chunks.push(rest.trim());
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

// 국내 전화번호(휴대폰/유선, +82 표기 포함) 결정적 마스킹 — LLM 정규화 프롬프트는
// 이름은 일관되게 익명화하지만 숫자열 마스킹은 누락시킬 수 있어(실측: 010-1234-5678 원문 그대로 통과),
// 정규화본이 raw/ 정본으로 영구 저장되는 지점에서 코드 레벨 정규식으로 이중 방어한다.
const PHONE_PATTERN = /(?:\+?82[-.\s]?0?|0)\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g;

export function redactPhoneNumbers(text: string): string {
	return text.replace(PHONE_PATTERN, '[전화번호 비공개]');
}

/**
 * 전사본 재정형 — 발화(개행) 단위를 보존하면서 연속 발화를 그룹(≤maxGroupChars)으로 묶고,
 * 그룹 사이를 빈 줄(\n\n)로 구분한다. 단어는 그대로, 공백 구조만 바꾼다.
 *
 * 목적: 빈 줄 없는 STT 전사본은 청크 전체(≤5,000자)가 단락 하나로 붙어
 * source_span·블록 앵커가 거대 덩어리를 가리키게 된다. 재정형하면
 * "명제 추출 단락 = raw 정본의 Obsidian 블록 = ^tb 앵커 위치"가 한 몸이 된다.
 *
 * 그룹 크기(350자 ≈ 발화 2~4턴)는 SYSTEM_PROP_BASE의 "단락 하나당 명제 최대 3개" 상한과
 * 맞물린다 — 그룹이 크면(예: 800자, 발화 6턴 이상) 한 단락 안에 서로 다른 주장이 여럿
 * 몰려도 여전히 3개까지만 뽑혀 값 있는 명제가 소리 없이 소실된다(실측: 논쟁 6턴짜리 회의에서
 * 화자 한쪽의 핵심 수치 주장이 통째로 누락됨). 그룹을 작게 쪼개 단락 수를 늘리면
 * 단락당 캡은 유지하면서 총 슬롯(3×단락 수)이 늘어 소실을 줄인다.
 *
 * - 그룹은 50자 미만으로 flush하지 않는다(약간의 초과 허용) — 명제 추출 최소 단락(50자) 미달 소실 방지
 * - 꼬리 그룹이 50자 미만이면 직전 그룹에 병합
 */
export function reflowTranscript(text: string, maxGroupChars = 200): string {
	const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
	if (lines.length === 0) return text.trim();

	const groups: string[][] = [];
	let cur: string[] = [];
	let curLen = 0;
	const flush = () => {
		if (cur.length > 0) { groups.push(cur); cur = []; curLen = 0; }
	};
	// "00:00:05 김민수" 같은 화자 라벨 줄(짧고 문장종결어미로 안 끝남) 판정.
	// 라벨 줄 바로 뒤에서 그룹을 끊으면 다음 그룹이 화자 없는 내용으로 시작해
	// "화자 귀속 필수" 규칙이 깨지고, 대사 하나가 두 단락으로 잘려 문맥이 끊긴다.
	const isLabelLike = (line: string): boolean =>
		line.length <= 20 && !/[.!?다요죠까]$/.test(line);

	for (const line of lines) {
		// 마크다운 헤딩(#)은 항상 독립 그룹 — extractPropositions의 헤딩 감지가
		// "문단 = 헤딩 전용 한 줄"을 전제하므로, 발화와 섞이면 그룹 전체(개행 포함)가
		// 헤딩 텍스트로 오인되어 heading_path에 raw 개행이 박히고 frontmatter YAML이 깨진다.
		if (/^#+\s/.test(line)) {
			flush();
			groups.push([line]);
			continue;
		}
		const prevWasLabel = cur.length > 0 && isLabelLike(cur[cur.length - 1]);
		if (cur.length > 0 && !prevWasLabel && curLen + line.length + 1 > maxGroupChars && curLen >= 50) {
			flush();
		}
		cur.push(line);
		curLen += line.length + 1;
	}
	flush();

	// 꼬리 그룹 병합 — 마지막 짧은 발화가 단락 최소치 미달로 소실되지 않게.
	// 헤딩 그룹은 병합 대상·목적지 어느 쪽으로도 섞지 않는다(위 헤딩 오인 버그 재발 방지).
	// 병합 후 크기가 maxGroupChars를 넘으면 병합하지 않는다 — 직전 그룹이 이미 라벨-쌍
	// 보호로 상한 근처까지 찬 상태에서 꼬리까지 얹으면 발화 4턴 이상이 한 단락에 몰려
	// SYSTEM_PROP_BASE의 "단락당 명제 최대 3개" 상한에 걸려 꼬리 발화가 소리 없이 소실된다
	// (실측: 짧은 회의 4턴 중 마지막 화자의 커밋먼트가 통째로 누락).
	const isHeadingGroup = (g: string[]) => g.length === 1 && /^#+\s/.test(g[0]);
	if (groups.length >= 2) {
		const last = groups[groups.length - 1];
		const prev = groups[groups.length - 2];
		const lastLen = last.reduce((s, l) => s + l.length, 0);
		const prevLen = prev.reduce((s, l) => s + l.length, 0);
		if (lastLen < 50 && !isHeadingGroup(last) && !isHeadingGroup(prev) && prevLen + lastLen <= maxGroupChars) {
			const tail = groups.pop()!;
			groups[groups.length - 1].push(...tail);
		}
	}

	return groups.map(g => g.join('\n')).join('\n\n');
}

export function repairJson(raw: string): string {
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
			if (stack[stack.length - 1] === ch) stack.pop();
		}
	}
	s = s.replace(/,\s*$/, '');
	return s + stack.reverse().join('');
}

export function parseJson<T>(raw: unknown, fallback: T): T {
	if (raw !== null && typeof raw === 'object') return raw as T;
	if (typeof raw !== 'string') return fallback;
	// CLI가 마크다운 코드펜스로 감싸서 반환하는 경우 제거
	const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
	try {
		return JSON.parse(repairJson(stripped)) as T;
	} catch {
		return fallback;
	}
}
