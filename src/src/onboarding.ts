import { App, Modal } from 'obsidian';
import type ThirdBrainPlugin from './main';
import type { AIProvider } from './types';

// ── 온보딩 모달 ────────────────────────────────────────────────
// 최초 실행 시 AI 제공자를 선택하게 하는 welcome flow.
// claude CLI가 PATH에 없을 때만 표시된다.
// X 버튼·ESC 비활성화 — "시작하기" 또는 "나중에 설정하기" 로만 닫힘.

export class OnboardingModal extends Modal {
	private selected: AIProvider | null = null;
	private apiKeyInput: HTMLInputElement | null = null;
	private cliPathInput: HTMLInputElement | null = null;
	private step2El: HTMLElement | null = null;

	constructor(app: App, private plugin: ThirdBrainPlugin) {
		super(app);
		// ESC 키로 닫히지 않도록
		this.scope.register([], 'Escape', () => false);
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass('tb-onboarding');

		// X 버튼 제거
		modalEl.querySelector('.modal-close-button')?.remove();

		// ── 헤더 ────
		const hdr = contentEl.createDiv({ cls: 'tb-ob-header' });
		hdr.createEl('div', { cls: 'tb-ob-logo', text: '🧠' });
		hdr.createEl('h2', { cls: 'tb-ob-title', text: 'ThirdBrain에 오신 것을 환영해요' });
		hdr.createEl('p', { cls: 'tb-ob-subtitle', text: '어떤 AI를 주로 활용하시나요? 언제든지 설정에서 변경할 수 있어요.' });

		// ── 제공자 카드 ────
		const cards = contentEl.createDiv({ cls: 'tb-ob-cards' });
		this.renderProviderCard(cards, 'gemini',      '✦', 'Gemini',      'Google Gemini API\nAPI 키로 바로 연결');
		this.renderProviderCard(cards, 'claude-api',  '◆', 'Claude API',  'Anthropic Console\nAPI 키로 바로 연결');
		this.renderProviderCard(cards, 'claude-cli',  '⌘', 'Claude Code', 'Claude CLI (로컬)\n무료, 설치 필요');

		// ── Step 2: 세부 입력 ────
		this.step2El = contentEl.createDiv({ cls: 'tb-ob-step2' });
		this.step2El.hide();

		// ── 푸터: 시작하기 + 나중에 설정하기 ────
		const footer = contentEl.createDiv({ cls: 'tb-ob-footer' });
		const skipLink = footer.createEl('span', { cls: 'tb-ob-skip', text: '나중에 설정하기' });
		skipLink.addEventListener('click', () => this.close());

		const confirmBtn = footer.createEl('button', { cls: 'tb-ob-confirm mod-cta', text: '시작하기' });
		confirmBtn.disabled = true;
		confirmBtn.addEventListener('click', () => this.confirm(confirmBtn));

		this.onProviderSelect = (provider) => {
			this.selected = provider;
			confirmBtn.disabled = false;
			this.renderStep2(provider);
		};
	}

	private onProviderSelect: (p: AIProvider) => void = () => {};

	private renderProviderCard(
		parent: HTMLElement,
		provider: AIProvider,
		icon: string,
		name: string,
		desc: string
	) {
		const card = parent.createDiv({ cls: 'tb-ob-card' });
		card.createEl('div', { cls: 'tb-ob-card-icon', text: icon });
		card.createEl('div', { cls: 'tb-ob-card-name', text: name });
		const descEl = card.createEl('div', { cls: 'tb-ob-card-desc' });
		descEl.setText(desc);
		descEl.addClass('tb-ob-card-desc-preline');

		card.addEventListener('click', () => {
			parent.findAll('.tb-ob-card').forEach(c => c.removeClass('is-selected'));
			card.addClass('is-selected');
			this.onProviderSelect(provider);
		});
	}

	private renderStep2(provider: AIProvider) {
		const el = this.step2El!;
		el.empty();
		el.show();

		if (provider === 'gemini') {
			el.createEl('label', { cls: 'tb-ob-label', text: 'Gemini API 키' });
			el.createEl('div', { cls: 'tb-ob-hint', text: 'Google AI Studio → API keys 에서 발급 (AIza...)' });
			this.apiKeyInput = el.createEl('input', { cls: 'tb-ob-input', attr: { type: 'password', placeholder: 'AIza...' } });
			this.cliPathInput = null;
		} else if (provider === 'claude-api') {
			el.createEl('label', { cls: 'tb-ob-label', text: 'Claude API 키' });
			el.createEl('div', { cls: 'tb-ob-hint', text: 'console.anthropic.com → API Keys 에서 발급 (sk-ant-...)' });
			this.apiKeyInput = el.createEl('input', { cls: 'tb-ob-input', attr: { type: 'password', placeholder: 'sk-ant-...' } });
			this.cliPathInput = null;
		} else {
			this.apiKeyInput = null;
			el.createEl('div', { cls: 'tb-ob-hint', text: 'Claude Code가 설치되어 있지 않은 것 같아요.' });
			const dlRow = el.createDiv({ cls: 'tb-ob-dl-row' });
			dlRow.createEl('span', { text: '설치 링크 →' });
			dlRow.createEl('a', {
				cls: 'tb-ob-link',
				text: 'claude.ai/code',
				href: 'https://claude.ai/code',
				attr: { target: '_blank' }
			});
			el.createEl('label', { cls: 'tb-ob-label', text: '설치 경로 (PATH에 있으면 기본값 사용)' });
			this.cliPathInput = el.createEl('input', {
				cls: 'tb-ob-input',
				attr: { type: 'text', placeholder: 'claude (기본값, PATH에 등록된 경우)' }
			});
		}
	}

	private async confirm(btn: HTMLButtonElement) {
		if (!this.selected) return;
		btn.disabled = true;
		btn.setText('저장 중…');

		this.plugin.settings.aiProvider = this.selected;

		if (this.selected === 'gemini' && this.apiKeyInput?.value.trim()) {
			this.plugin.settings.geminiApiKey = this.apiKeyInput.value.trim();
		} else if (this.selected === 'claude-api' && this.apiKeyInput?.value.trim()) {
			this.plugin.settings.claudeApiKey = this.apiKeyInput.value.trim();
		} else if (this.selected === 'claude-cli') {
			const path = this.cliPathInput?.value.trim();
			if (path) this.plugin.settings.cliBin = path;
		}

		this.plugin.settings.onboardingComplete = true;
		await this.plugin.saveSettings();
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Claude CLI 가용 여부 확인 ────────────────────────────────────
// 로컬 환경에서만 의미 있으며 Mobile에서는 항상 false 반환.

export async function isClaudeCLIAvailable(cliBin: string): Promise<boolean> {
	try {
		const { exec } = (window as any).require('child_process') as typeof import('child_process');
		return await new Promise<boolean>((resolve) => {
			exec(`${cliBin} --version`, { timeout: 3000 }, (err: any) => resolve(!err));
		});
	} catch {
		return false;
	}
}
