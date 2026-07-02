import { App, PluginSettingTab, Setting, sanitizeHTMLToDom } from 'obsidian';
import type ThirdBrainPlugin from './main';
import { SOOTBALL_LOGO } from './sootball';
import { getT } from './i18n';
import type { Lang } from './i18n';
import type { AIProvider } from './types';

export class ThirdBrainSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ThirdBrainPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const t = getT(this.plugin.settings.lang);

		const header = containerEl.createDiv({ cls: 'tb-settings-header' });
		const logoEl = header.createEl('div', { cls: 'tb-settings-logo' });
		logoEl.appendChild(sanitizeHTMLToDom(SOOTBALL_LOGO));
		header.createEl('div', { cls: 'tb-settings-title', text: 'ThirdBrain' });

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
			.addDropdown(dropdown => dropdown
				.addOption('claude-cli', this.plugin.settings.lang === 'en' ? 'Claude CLI (local, default)' : 'Claude CLI (로컬, 기본값)')
				.addOption('claude-api', this.plugin.settings.lang === 'en' ? 'Claude API (API key required)' : 'Claude API (API 키 필요)')
				.addOption('gemini', this.plugin.settings.lang === 'en' ? 'Gemini (API key required)' : 'Gemini (API 키 필요)')
				.addOption('openai', this.plugin.settings.lang === 'en' ? 'OpenAI GPT (API key required)' : 'OpenAI GPT (API 키 필요)')
				.setValue(this.plugin.settings.aiProvider)
				.onChange(async (value) => {
					this.plugin.settings.aiProvider = value as AIProvider;
					await this.plugin.saveSettings();
					this.display();
				})
			);

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
