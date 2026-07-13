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
