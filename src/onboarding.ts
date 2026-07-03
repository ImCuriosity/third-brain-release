import { App, Modal, Platform } from 'obsidian';
import type ThirdBrainPlugin from './main';
import type { AIProvider } from './types';
import { getT } from './i18n';
import type { Lang } from './i18n';

// ── 온보딩 모달 ────────────────────────────────────────────────

export class OnboardingModal extends Modal {
	private selected: AIProvider | null = null;
	private apiKeyInput: HTMLInputElement | null = null;
	private cliPathInput: HTMLInputElement | null = null;
	private step2El: HTMLElement | null = null;
	private currentLang: Lang;

	constructor(app: App, private plugin: ThirdBrainPlugin) {
		super(app);
		this.currentLang = plugin.settings.lang ?? 'en';
		this.scope.register([], 'Escape', () => false);
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass('tb-onboarding');

		modalEl.querySelector('.modal-close-button')?.remove();

		const t = getT(this.currentLang);

		// ── 언어 선택 칩 ────
		const langRow = contentEl.createDiv({ cls: 'tb-ob-lang-row' });
		langRow.createEl('span', { cls: 'tb-ob-lang-label', text: t('ob_lang_label') + ':' });
		const chipKo = langRow.createEl('button', { cls: 'tb-ob-lang-chip', text: '🇰🇷 한국어' });
		const chipEn = langRow.createEl('button', { cls: 'tb-ob-lang-chip', text: '🇺🇸 English' });

		const updateChips = () => {
			chipKo.toggleClass('is-active', this.currentLang === 'ko');
			chipEn.toggleClass('is-active', this.currentLang === 'en');
		};
		updateChips();

		chipKo.addEventListener('click', () => {
			this.currentLang = 'ko';
			this.plugin.settings.lang = 'ko';
			this.onOpen();
		});
		chipEn.addEventListener('click', () => {
			this.currentLang = 'en';
			this.plugin.settings.lang = 'en';
			this.onOpen();
		});

		// ── 헤더 ────
		const hdr = contentEl.createDiv({ cls: 'tb-ob-header' });
		hdr.createEl('div', { cls: 'tb-ob-logo', text: '🧠' });
		hdr.createEl('h2', { cls: 'tb-ob-title', text: t('ob_title') });
		hdr.createEl('p', { cls: 'tb-ob-subtitle', text: t('ob_subtitle') });

		// ── 제공자 카드 ────
		const cards = contentEl.createDiv({ cls: 'tb-ob-cards' });
		this.renderProviderCard(cards, 'gemini',      '✦', 'Gemini',      t('ob_gemini_desc'));
		this.renderProviderCard(cards, 'claude-api',  '◆', 'Claude API',  t('ob_claude_api_desc'));
		if (!Platform.isMobile) {
			this.renderProviderCard(cards, 'claude-cli', '⌘', 'Claude Code', t('ob_claude_cli_desc'));
		}

		// ── Step 2: 세부 입력 ────
		this.step2El = contentEl.createDiv({ cls: 'tb-ob-step2' });
		this.step2El.hide();

		// ── 푸터 ────
		const footer = contentEl.createDiv({ cls: 'tb-ob-footer' });
		const skipLink = footer.createEl('span', { cls: 'tb-ob-skip', text: t('ob_skip') });
		skipLink.addEventListener('click', () => this.close());

		const confirmBtn = footer.createEl('button', { cls: 'tb-ob-confirm mod-cta', text: t('ob_confirm') });
		confirmBtn.disabled = true;
		confirmBtn.addEventListener('click', () => { void this.confirm(confirmBtn); });

		this.onProviderSelect = (provider) => {
			this.selected = provider;
			confirmBtn.disabled = false;
			this.renderStep2(provider);
		};

		// 이미 선택된 게 있으면 복원
		if (this.selected) {
			cards.findAll('.tb-ob-card').forEach(c => {
				if (c.getAttribute('data-provider') === this.selected) c.addClass('is-selected');
			});
			confirmBtn.disabled = false;
		}
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
		card.setAttribute('data-provider', provider);
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
		const t = getT(this.currentLang);
		el.empty();
		el.show();

		if (provider === 'gemini') {
			el.createEl('label', { cls: 'tb-ob-label', text: t('ob_gemini_key_label') });
			el.createEl('div', { cls: 'tb-ob-hint', text: t('ob_gemini_key_hint') });
			this.apiKeyInput = el.createEl('input', { cls: 'tb-ob-input', attr: { type: 'password', placeholder: 'AIza...' } });
			this.cliPathInput = null;
		} else if (provider === 'claude-api') {
			el.createEl('label', { cls: 'tb-ob-label', text: t('ob_claude_api_key_label') });
			el.createEl('div', { cls: 'tb-ob-hint', text: t('ob_claude_api_key_hint') });
			this.apiKeyInput = el.createEl('input', { cls: 'tb-ob-input', attr: { type: 'password', placeholder: 'sk-ant-...' } });
			this.cliPathInput = null;
		} else {
			this.apiKeyInput = null;
			el.createEl('div', { cls: 'tb-ob-hint', text: t('ob_cli_not_found') });
			const dlRow = el.createDiv({ cls: 'tb-ob-dl-row' });
			dlRow.createEl('span', { text: t('ob_cli_install') });
			dlRow.createEl('a', {
				cls: 'tb-ob-link',
				text: 'claude.ai/code',
				href: 'https://claude.ai/code',
				attr: { target: '_blank' }
			});
			el.createEl('label', { cls: 'tb-ob-label', text: t('ob_cli_path_label') });
			this.cliPathInput = el.createEl('input', {
				cls: 'tb-ob-input',
				attr: { type: 'text', placeholder: t('ob_cli_path_placeholder') }
			});
		}
	}

	private async confirm(btn: HTMLButtonElement) {
		if (!this.selected) return;
		const t = getT(this.currentLang);
		btn.disabled = true;
		btn.setText(t('ob_saving'));

		this.plugin.settings.aiProvider = this.selected;
		this.plugin.settings.lang = this.currentLang;

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

export async function isClaudeCLIAvailable(cliBin: string): Promise<boolean> {
	try {
		type LocalExec = (cmd: string, opts: { timeout: number }, cb: (err: unknown) => void) => void;
		const req = (window as Window & { require?: (m: string) => unknown }).require;
		if (!req) return false;
		const { exec } = req('child_process') as { exec: LocalExec };
		return await new Promise<boolean>((resolve) => {
			exec(`${cliBin} --version`, { timeout: 3000 }, (err) => resolve(!err));
		});
	} catch {
		return false;
	}
}
