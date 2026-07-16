import { App, Platform, PluginSettingTab, sanitizeHTMLToDom } from 'obsidian';
import type { Setting, SettingDefinitionItem } from 'obsidian';
import type ThirdBrainPlugin from './main';
import { SOOTBALL_LOGO } from './sootball';
import { getT } from './i18n';
import type { AIProvider } from './types';

export class ThirdBrainSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ThirdBrainPlugin) {
		super(app, plugin);
	}

	// 선언형 설정 API (Obsidian 1.13+) — 값 읽기/쓰기는 아래 get/setControlValue가 담당하고,
	// 여기서는 구조만 선언한다. visible 콜백은 매 렌더마다 재평가되므로 프로바이더 전환 시
	// API 키 필드가 자동으로 나타나고 사라진다 (기존 display() 수동 재렌더 대체).
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
			default:                  return super.getControlValue(key);
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
			default:                  await super.setControlValue(key, value); return;
		}
		await this.plugin.saveSettings();
		if (key === 'lang') void this.plugin.refreshView();
	}
}
