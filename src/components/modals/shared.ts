// view.ts에서 분리한 모달 공용 헬퍼 — 여러 모달과 ThirdBrainView가 함께 쓴다.

import type { TBNode } from '../../types';

// 모순 표시 공용: 노드 content에서 명제문(위키링크 구분선 이전)과 원문 인용을 뽑는다.
// 제목만으로는 두 명제가 왜 모순인지 판단할 수 없으므로 모든 모순 UI가 이걸 동봉한다.
export function conflictNodeDetail(n: TBNode): { claim: string; quote: string } {
	const claim = (n.content?.split('\n---\n')[0] ?? '').trim();
	const quote = (n.source_span?.text ?? '').replace(/\s+/g, ' ').trim();
	return { claim, quote: quote.length > 240 ? `${quote.slice(0, 240)}…` : quote };
}

export const RELATION_KO: Record<string, string> = {
	causes:          '유발',
	precedes:        '선행',
	conflicts_with:  '충돌',
	supports:        '뒷받침',
	precondition_of: '전제조건',
	exemplifies:     '예시',
	contrasts_with:  '대조',
	applies_to:      '적용',
	isomorphic_to:   '구조동형',
	analogous_to:    '유사',
};

export function relLabel(relation: string, lang?: string): string {
	return lang === 'en' ? relation : (RELATION_KO[relation] ?? relation);
}

export function progressBar(filled: number): string {
	const n = Math.max(0, Math.min(Math.round(filled), 10));
	return '[' + '='.repeat(n) + ' '.repeat(10 - n) + ']';
}

export function sanitizeId(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim().slice(0, 50);
}

export function shortText(s: string, max = 26): string {
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** 모달을 핸들 드래그로 이동 가능하게 만든다 (팝업형 모달용). */
export function makeDraggable(modalEl: HTMLElement, handle: HTMLElement): void {
	handle.addEventListener('mousedown', (e: MouseEvent) => {
		e.preventDefault();
		const rect = modalEl.getBoundingClientRect();
		modalEl.setCssStyles({ position: 'fixed', margin: '0', left: rect.left + 'px', top: rect.top + 'px', transform: 'none' });

		const dx = e.clientX - rect.left;
		const dy = e.clientY - rect.top;

		const onMove = (e: MouseEvent) => {
			modalEl.setCssStyles({ left: (e.clientX - dx) + 'px', top: (e.clientY - dy) + 'px' });
		};
		const onUp = () => {
			activeDocument.removeEventListener('mousemove', onMove);
			activeDocument.removeEventListener('mouseup', onUp);
		};
		activeDocument.addEventListener('mousemove', onMove);
		activeDocument.addEventListener('mouseup', onUp);
	});
}
