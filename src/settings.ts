import { App, Platform, PluginSettingTab, Setting, sanitizeHTMLToDom } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type ThirdBrainPlugin from './main';
import { SOOTBALL_LOGO } from './sootball';
import { getT } from './i18n';
import type { Lang } from './i18n';
import type { AIProvider } from './types';

export class ThirdBrainSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ThirdBrainPlugin) {
		super(app, plugin);
	}

	// 이중 구현 전략 — display()는 모든 Obsidian 버전에서 실제 렌더링을 담당하고(1.13 미만은
	// 선언형 API 자체가 없어 이것만이 유일한 경로. 실측: 1.10.6에서 선언형만 두면 빈 설정창),
	// getSettingDefinitions()는 1.13+의 설정 "검색" 인덱싱에 쓰인다. minAppVersion을 1.13으로
	// 올리지 않기 위한 의도적 병행 — display() deprecated 권고는 감수한다.

	// 선언형 설정 API (Obsidian 1.13+) — 값 읽기/쓰기는 아래 get/setControlValue가 담당하고,
	// 여기서는 구조만 선언한다. visible 콜백은 매 렌더마다 재평가되므로 프로바이더 전환 시
	// API 키 필드가 자동으로 나타나고 사라진다.
	getSettingDefinitions(): SettingDefinitionItem[] {
		const t = getT(this.plugin.settings.lang);
		const ko = this.plugin.settings.lang === 'ko';
		const en = this.plugin.settings.lang === 'en';

		const providerOptions: Record<string, string> = {};
		if (!Platform.isMobile) {
			providerOptions['claude-cli'] = en ? 'Claude CLI (local, default)' : 'Claude CLI (로컬, 기본값)';
		}
		providerOptions['claude-api'] = en ? 'Claude API (API key required)' : 'Claude API (API 키 필요)';
		providerOptions['gemini'] = en ? 'Gemini (API key required)' : 'Gemini (API 키 필요)';
		providerOptions['openai'] = en ? 'OpenAI GPT (API key required)' : 'OpenAI GPT (API 키 필요)';

		return [
			{
				name: 'ThirdBrain',
				searchable: false,
				render: (setting: Setting) => {
					setting.settingEl.empty();
					const header = setting.settingEl.createDiv({ cls: 'tb-settings-header' });
					const logoEl = header.createDiv({ cls: 'tb-settings-logo' });
					logoEl.appendChild(sanitizeHTMLToDom(SOOTBALL_LOGO));
					header.createDiv({ cls: 'tb-settings-title', text: 'ThirdBrain' });
				},
			},
			{
				name: t('settings_lang_name'),
				desc: t('settings_lang_desc'),
				control: { type: 'dropdown', key: 'lang', options: { ko: '한국어', en: 'English' } },
			},
			{
				name: ko ? 'AI 실행 전 비용 확인' : 'Confirm cost before AI runs',
				desc: ko
					? '생성·분석·연결 등 AI 작업 전에 예상 토큰·비용·시간을 보여주고 진행 여부를 확인합니다.'
					: 'Before any AI operation, show estimated tokens, cost, and time and ask to proceed.',
				control: { type: 'toggle', key: 'showCostPreflight', defaultValue: true },
			},
			{
				name: t('settings_root_folder_name'),
				desc: t('settings_root_folder_desc'),
				control: { type: 'text', key: 'rootFolder', placeholder: 'ThirdBrainRoot' },
			},
			{
				name: t('settings_cli_name'),
				desc: t('settings_cli_desc'),
				visible: () => !Platform.isMobile,
				control: { type: 'text', key: 'cliBin', placeholder: 'claude' },
			},
			{
				name: t('settings_max_edge_name'),
				desc: t('settings_max_edge_desc'),
				control: { type: 'slider', key: 'maxEdgeCandidates', min: 1, max: 5, step: 1 },
			},
			{
				name: t('settings_bridge_top_k_name'),
				desc: t('settings_bridge_top_k_desc'),
				control: { type: 'slider', key: 'bridgeTopKPerNode', min: 1, max: 5, step: 1, defaultValue: 3 },
			},
			{
				name: t('settings_ai_provider_name'),
				desc: t('settings_ai_provider_desc'),
				control: { type: 'dropdown', key: 'aiProvider', options: providerOptions },
			},
			{
				name: t('settings_claude_api_key_name'),
				desc: t('settings_claude_api_key_desc'),
				visible: () => this.plugin.settings.aiProvider === 'claude-api',
				control: { type: 'text', key: 'claudeApiKey', placeholder: 'sk-ant-...' },
			},
			{
				name: t('settings_gemini_api_key_name'),
				desc: t('settings_gemini_api_key_desc'),
				visible: () => this.plugin.settings.aiProvider === 'gemini',
				control: { type: 'text', key: 'geminiApiKey', placeholder: 'AIza...' },
			},
			{
				name: t('settings_openai_api_key_name'),
				desc: t('settings_openai_api_key_desc'),
				visible: () => this.plugin.settings.aiProvider === 'openai',
				control: { type: 'text', key: 'openaiApiKey', placeholder: 'sk-...' },
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		switch (key) {
			case 'lang':              return s.lang ?? 'en';
			case 'showCostPreflight': return s.showCostPreflight !== false;
			case 'rootFolder':        return s.rootFolder;
			case 'cliBin':            return s.cliBin;
			case 'maxEdgeCandidates': return s.maxEdgeCandidates;
			case 'bridgeTopKPerNode': return s.bridgeTopKPerNode ?? 3;
			// 모바일은 CLI가 없으므로 저장값이 claude-cli여도 표시값은 gemini로 강제 (기존 display() 동작 유지)
			case 'aiProvider':        return Platform.isMobile && s.aiProvider === 'claude-cli' ? 'gemini' : s.aiProvider;
			case 'claudeApiKey':      return s.claudeApiKey || '';
			case 'geminiApiKey':      return s.geminiApiKey || '';
			case 'openaiApiKey':      return s.openaiApiKey || '';
			// 선언한 모든 컨트롤 키를 위에서 커버 — super 호출은 1.13 API라 minAppVersion(1.7.2)과 충돌
			default:                  return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		switch (key) {
			case 'lang':              s.lang = value as typeof s.lang; break;
			case 'showCostPreflight': s.showCostPreflight = value as boolean; break;
			case 'rootFolder':        s.rootFolder = (value as string) || 'ThirdBrainRoot'; break;
			case 'cliBin':            s.cliBin = (value as string) || 'claude'; break;
			case 'maxEdgeCandidates': s.maxEdgeCandidates = value as number; break;
			case 'bridgeTopKPerNode': s.bridgeTopKPerNode = value as number; break;
			case 'aiProvider':        s.aiProvider = value as AIProvider; break;
			case 'claudeApiKey':      s.claudeApiKey = (value as string) || ''; break;
			case 'geminiApiKey':      s.geminiApiKey = (value as string) || ''; break;
			case 'openaiApiKey':      s.openaiApiKey = (value as string) || ''; break;
			// 선언한 모든 컨트롤 키를 위에서 커버 — super 호출은 1.13 API라 minAppVersion(1.7.2)과 충돌
			default:                  return;
		}
		await this.plugin.saveSettings();
		if (key === 'lang') void this.plugin.refreshView();
	}

	// 명령형 렌더링 — 1.13 미만에서는 유일한 렌더 경로, 1.13+에서도 오버라이드가 우선 적용된다.
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const t = getT(this.plugin.settings.lang);

		const header = containerEl.createDiv({ cls: 'tb-settings-header' });
		const logoEl = header.createDiv({ cls: 'tb-settings-logo' });
		logoEl.appendChild(sanitizeHTMLToDom(SOOTBALL_LOGO));
		header.createDiv({ cls: 'tb-settings-title', text: 'ThirdBrain' });

		new Setting(containerEl)
			.setName(t('settings_lang_name'))
			.setDesc(t('settings_lang_desc'))
			.addDropdown(dropdown => dropdown
				.addOption('ko', '한국어')
				.addOption('en', 'English')
				.setValue(this.plugin.settings.lang ?? 'en')
				.onChange(async (value) => {
					this.plugin.settings.lang = value as Lang;
					await this.plugin.saveSettings();
					this.display();
					void this.plugin.refreshView();
				})
			);

		const ko = this.plugin.settings.lang === 'ko';
		new Setting(containerEl)
			.setName(ko ? 'AI 실행 전 비용 확인' : 'Confirm cost before AI runs')
			.setDesc(ko
				? '생성·분석·연결 등 AI 작업 전에 예상 토큰·비용·시간을 보여주고 진행 여부를 확인합니다.'
				: 'Before any AI operation, show estimated tokens, cost, and time and ask to proceed.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showCostPreflight !== false)
				.onChange(async (value) => {
					this.plugin.settings.showCostPreflight = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('settings_root_folder_name'))
			.setDesc(t('settings_root_folder_desc'))
			.addText(text => text
				.setPlaceholder('ThirdBrainRoot')
				.setValue(this.plugin.settings.rootFolder)
				.onChange(async (value) => {
					this.plugin.settings.rootFolder = value || 'ThirdBrainRoot';
					await this.plugin.saveSettings();
				})
			);

		if (!Platform.isMobile) {
			new Setting(containerEl)
				.setName(t('settings_cli_name'))
				.setDesc(t('settings_cli_desc'))
				.addText(text => text
					.setPlaceholder('claude')
					.setValue(this.plugin.settings.cliBin)
					.onChange(async (value) => {
						this.plugin.settings.cliBin = value || 'claude';
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName(t('settings_max_edge_name'))
			.setDesc(t('settings_max_edge_desc'))
			.addSlider(slider => slider
				.setLimits(1, 5, 1)
				.setValue(this.plugin.settings.maxEdgeCandidates)
				.onChange(async (value) => {
					this.plugin.settings.maxEdgeCandidates = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('settings_bridge_top_k_name'))
			.setDesc(t('settings_bridge_top_k_desc'))
			.addSlider(slider => slider
				.setLimits(1, 5, 1)
				.setValue(this.plugin.settings.bridgeTopKPerNode ?? 3)
				.onChange(async (value) => {
					this.plugin.settings.bridgeTopKPerNode = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('settings_ai_provider_name'))
			.setDesc(t('settings_ai_provider_desc'))
			.addDropdown(dropdown => {
				if (!Platform.isMobile) {
					dropdown.addOption('claude-cli', this.plugin.settings.lang === 'en' ? 'Claude CLI (local, default)' : 'Claude CLI (로컬, 기본값)');
				}
				dropdown
					.addOption('claude-api', this.plugin.settings.lang === 'en' ? 'Claude API (API key required)' : 'Claude API (API 키 필요)')
					.addOption('gemini', this.plugin.settings.lang === 'en' ? 'Gemini (API key required)' : 'Gemini (API 키 필요)')
					.addOption('openai', this.plugin.settings.lang === 'en' ? 'OpenAI GPT (API key required)' : 'OpenAI GPT (API 키 필요)')
					.setValue(Platform.isMobile && this.plugin.settings.aiProvider === 'claude-cli' ? 'gemini' : this.plugin.settings.aiProvider)
					.onChange(async (value) => {
						this.plugin.settings.aiProvider = value as AIProvider;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.aiProvider === 'claude-api') {
			new Setting(containerEl)
				.setName(t('settings_claude_api_key_name'))
				.setDesc(t('settings_claude_api_key_desc'))
				.addText(text => text
					.setPlaceholder('sk-ant-...')
					.setValue(this.plugin.settings.claudeApiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.claudeApiKey = value || '';
						await this.plugin.saveSettings();
					})
				);
		}

		if (this.plugin.settings.aiProvider === 'gemini') {
			new Setting(containerEl)
				.setName(t('settings_gemini_api_key_name'))
				.setDesc(t('settings_gemini_api_key_desc'))
				.addText(text => text
					.setPlaceholder('AIza...')
					.setValue(this.plugin.settings.geminiApiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value || '';
						await this.plugin.saveSettings();
					})
				);
		}

		if (this.plugin.settings.aiProvider === 'openai') {
			new Setting(containerEl)
				.setName(t('settings_openai_api_key_name'))
				.setDesc(t('settings_openai_api_key_desc'))
				.addText(text => text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.openaiApiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.openaiApiKey = value || '';
						await this.plugin.saveSettings();
					})
				);
		}
	}
}
