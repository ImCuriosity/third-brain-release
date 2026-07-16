import { App, Modal } from 'obsidian';
import { getT } from '../../i18n';
import type { TKey, Lang } from '../../i18n';

// ── 파이프라인 결과(스텝 로그) 모달 ────────────────────────
export class PipelineInfoModal extends Modal {
	stepLogEl!: HTMLElement;
	private t: (key: TKey) => string;

	constructor(app: App, lang?: Lang) {
		super(app);
		this.t = getT(lang);
	}

	onOpen() {
		this.modalEl.addClass('tb-pipeline-modal');
		this.titleEl.setText(this.t('label_pipeline_result'));

		// 최초 open 시에만 stepLogEl 생성 (재오픈 시 이미 존재)
		if (!this.stepLogEl) {
			this.stepLogEl = this.contentEl.createDiv({ cls: 'tb-step-log' });
		}

		this.contentEl.addClass('tb-pipeline-modal-body');
	}

	onClose() { /* 내용 유지 — 다음 파이프라인 실행 시 새 인스턴스로 교체됨 */ }
}

// ── OpenAI 설정 필요 안내 모달 (MP3 전사용) ─────────────────
export class RequireOpenAIModal extends Modal {
	constructor(app: App, private pluginId: string) { super(app); }
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'OpenAI 설정 필요' });
		contentEl.createEl('p', { text: 'MP3 전사 기능은 OpenAI(Whisper)가 필요합니다. 설정에서 AI 공급자를 OpenAI로 변경하고 API 키를 입력해 주세요.' });
		const btn = contentEl.createEl('button', { cls: 'tb-btn', text: '설정 열기' });
		btn.addEventListener('click', () => {
			this.close();
			const setting = (this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } }).setting;
			if (setting) {
				setting.open();
				window.setTimeout(() => setting.openTabById(this.pluginId), 60);
			}
		});
	}
	onClose() { this.contentEl.empty(); }
}
