import type { EdgeCandidate, TBEdge } from '../types';

// Phase 4에서 구현: 2.5차 큐레이션 팝업 칩 UI
// AI가 제안한 엣지 후보를 칩으로 노출 → 유저 클릭으로 확정
export class ChipUI {
	private container: HTMLElement;
	private onConfirm: (edge: TBEdge) => Promise<void>;

	constructor(
		container: HTMLElement,
		onConfirm: (edge: TBEdge) => Promise<void>
	) {
		this.container = container;
		this.onConfirm = onConfirm;
	}

	// 칩 목록 렌더링 (AI 제안 상태 = confirmed: false)
	render(_candidates: EdgeCandidate[]): void {
		// Phase 4 구현 예정
		this.container.createEl('p', { text: '[ChipUI — Phase 4]', cls: 'tb-stub' });
	}

	clear(): void {
		this.container.empty();
	}
}
