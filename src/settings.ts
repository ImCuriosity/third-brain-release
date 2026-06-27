import { App, PluginSettingTab, Setting } from 'obsidian';
import type ThirdBrainPlugin from './main';
import { SOOTBALL_LOGO } from './sootball';

export class ThirdBrainSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ThirdBrainPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const header = containerEl.createDiv({ attr: { style: 'text-align:center; padding: 1.5rem 0 1rem;' } });
		header.innerHTML = SOOTBALL_LOGO
			+ `<div style="font-size:1.1em; font-weight:600; margin-top:0.5rem; color:var(--text-normal);">ThirdBrain</div>`;

		new Setting(containerEl)
			.setName('노드 저장 폴더')
			.setDesc('인제스트된 노드 .md 파일이 생성될 vault 폴더명')
			.addText(text => text
				.setPlaceholder('ThirdBrain')
				.setValue(this.plugin.settings.nodeFolder)
				.onChange(async (value) => {
					this.plugin.settings.nodeFolder = value || 'ThirdBrain';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('claude CLI 경로')
			.setDesc('claude 실행 파일 경로. PATH에 있으면 기본값(claude) 사용.')
			.addText(text => text
				.setPlaceholder('claude')
				.setValue(this.plugin.settings.cliBin)
				.onChange(async (value) => {
					this.plugin.settings.cliBin = value || 'claude';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('최대 엣지 후보 수')
			.setDesc('AI가 제안하는 최대 엣지 후보 개수 (2~5 권장)')
			.addSlider(slider => slider
				.setLimits(1, 5, 1)
				.setValue(this.plugin.settings.maxEdgeCandidates)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxEdgeCandidates = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('브리지 후보 수 (노드당)')
			.setDesc('폴더 브리지 시 노드당 LLM에 전달할 최대 후보 수 (1~5 권장, 낮을수록 빠름)')
			.addSlider(slider => slider
				.setLimits(1, 5, 1)
				.setValue(this.plugin.settings.bridgeTopKPerNode ?? 3)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.bridgeTopKPerNode = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('AI 제공자')
			.setDesc('사용할 LLM 제공자 선택')
			.addDropdown(dropdown => dropdown
				.addOption('claude-cli', 'Claude CLI (로컬, 기본값)')
				.addOption('claude-api', 'Claude API (API 키 필요)')
				.addOption('gemini', 'Gemini (API 키 필요)')
				.setValue(this.plugin.settings.aiProvider)
				.onChange(async (value) => {
					this.plugin.settings.aiProvider = value as any;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.aiProvider === 'claude-api') {
			new Setting(containerEl)
				.setName('Claude API 키')
				.setDesc('Anthropic API 키. https://console.anthropic.com')
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
				.setName('Gemini API 키')
				.setDesc('Google Generative AI 키. https://aistudio.google.com')
				.addText(text => text
					.setPlaceholder('AIza...')
					.setValue(this.plugin.settings.geminiApiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value || '';
						await this.plugin.saveSettings();
					})
				);
		}
	}
}
