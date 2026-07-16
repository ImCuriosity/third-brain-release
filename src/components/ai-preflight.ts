import { App, Modal } from 'obsidian';
import type { ThirdBrainSettings } from '../types';
import {
	estimateAIOperation,
	formatTokens,
	formatCostUsd,
	formatDuration,
	modelLabel,
	type AIOperationRequest,
	type AICostEstimate,
	type AIOperationKind,
} from '../engine/cost-estimator';

// 작업 종류별 표시 이름
const OP_LABEL: Record<AIOperationKind, { ko: string; en: string }> = {
	'pipeline':       { ko: '생성 — 명제·엣지 추출', en: 'Generate — extract propositions & edges' },
	'analysis':       { ko: '폴더 분석', en: 'Folder analysis' },
	'bridge':         { ko: '연결 — 크로스 커넥션', en: 'Bridge — cross connections' },
	'graph-analysis': { ko: '그래프 분석', en: 'Graph analysis' },
	'orphan-lint':    { ko: '고립 노드 린팅', en: 'Orphan node linting' },
	'transcript':     { ko: '전사본 분석', en: 'Transcript analysis' },
	'audio':          { ko: '음성 전사', en: 'Audio transcription' },
	'workbench':      { ko: '작업대 — 폴더 그라운딩 Q&A', en: 'Workbench — folder-grounded Q&A' },
};

class AICostPreflightModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private est: AICostEstimate,
		private lang: 'en' | 'ko',
		private resolve: (proceed: boolean) => void,
	) { super(app); }

	private get ko() { return this.lang === 'ko'; }

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-preflight');
		this.setTitle(this.ko ? '⚡ AI 실행 확인' : '⚡ Confirm AI run');

		const opName = OP_LABEL[this.est.operation][this.ko ? 'ko' : 'en'];
		contentEl.createDiv({ cls: 'tb-preflight-op', text: opName });
		contentEl.createDiv({
			cls: 'tb-preflight-model',
			text: modelLabel(this.est.provider, this.est.tier),
		});

		const grid = contentEl.createDiv({ cls: 'tb-preflight-grid' });
		const cell = (label: string, value: string, accent = false) => {
			const c = grid.createDiv({ cls: 'tb-preflight-cell' });
			c.createDiv({ cls: 'tb-preflight-cell-label', text: label });
			const v = c.createDiv({ cls: 'tb-preflight-cell-value', text: value });
			if (accent) v.addClass('is-accent');
		};

		cell(this.ko ? '예상 호출' : 'Est. calls', `${this.est.calls}`);
		cell(
			this.ko ? '예상 토큰' : 'Est. tokens',
			`~${formatTokens(this.est.totalTokens)}`,
		);
		cell(
			this.ko ? '예상 비용' : 'Est. cost',
			`~${formatCostUsd(this.est.costUsd)}`,
			true,
		);
		cell(
			this.ko ? '예상 시간' : 'Est. time',
			formatDuration(this.est.seconds, this.ko),
		);

		// 입력/출력 토큰 분해
		contentEl.createDiv({
			cls: 'tb-preflight-breakdown',
			text: this.ko
				? `입력 ~${formatTokens(this.est.inputTokens)} · 출력 ~${formatTokens(this.est.outputTokens)}`
				: `in ~${formatTokens(this.est.inputTokens)} · out ~${formatTokens(this.est.outputTokens)}`,
		});

		if (this.est.isSubscription) {
			contentEl.createDiv({
				cls: 'tb-preflight-note',
				text: this.ko
					? '※ Claude CLI는 구독 사용량에서 차감됩니다 (별도 과금 아님). 비용은 API 환산 참고치입니다.'
					: '※ Claude CLI draws from your subscription (no separate billing). Cost is an API-equivalent reference.',
			});
		}

		contentEl.createDiv({
			cls: 'tb-preflight-disclaimer',
			text: this.ko
				? '추정치입니다 — 실제 사용량과 다를 수 있습니다.'
				: 'Estimate only — actual usage may differ.',
		});

		const btns = contentEl.createDiv({ cls: 'tb-preflight-btns' });
		const cancelBtn = btns.createEl('button', { cls: 'tb-btn tb-preflight-cancel', text: this.ko ? '취소' : 'Cancel' });
		cancelBtn.addEventListener('click', () => { this.finish(false); });
		const goBtn = btns.createEl('button', { cls: 'tb-btn tb-preflight-go', text: this.ko ? '진행' : 'Proceed' });
		goBtn.addEventListener('click', () => { this.finish(true); });
	}

	private finish(proceed: boolean) {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(proceed);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		// 창을 그냥 닫으면(취소로 간주) 미해결 프라미스가 남지 않도록
		if (!this.resolved) { this.resolved = true; this.resolve(false); }
	}
}

/**
 * AI 실행 전 토큰·비용·시간 확인 게이트.
 * - `settings.showCostPreflight === false` 이면 즉시 true (게이트 우회, 설정 토글로 끈 경우)
 * - 그 외에는 추정치 모달을 띄우고 사용자가 '진행'을 눌러야 true 반환
 */
export function confirmAICost(app: App, settings: ThirdBrainSettings, req: AIOperationRequest): Promise<boolean> {
	if (settings.showCostPreflight === false) return Promise.resolve(true);
	const est = estimateAIOperation(req);
	return new Promise<boolean>((resolve) => {
		new AICostPreflightModal(app, est, settings.lang ?? 'en', resolve).open();
	});
}
