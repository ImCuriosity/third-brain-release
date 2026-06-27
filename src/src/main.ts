import { Plugin, WorkspaceLeaf, addIcon } from 'obsidian';
import { ThirdBrainSettings, DEFAULT_SETTINGS } from './types';
import { ThirdBrainView, VIEW_TYPE } from './view';
import { ThirdBrainSettingTab } from './settings';
import { SOOTBALL_ICON } from './sootball';
import { OnboardingModal, isClaudeCLIAvailable } from './onboarding';

export default class ThirdBrainPlugin extends Plugin {
	settings: ThirdBrainSettings;

	async onload() {
		await this.loadSettings();

		addIcon('sootball', SOOTBALL_ICON);

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) =>
			new ThirdBrainView(leaf, this)
		);

		this.addRibbonIcon('sootball', 'ThirdBrain', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open-thirdbrain',
			name: 'Open panel',
			callback: () => { void this.activateView(); },
		});

		this.addSettingTab(new ThirdBrainSettingTab(this.app, this));
	}

	onunload() { /* leaves are managed by Obsidian */ }

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);

		// 온보딩: 최초 실행이고 claude CLI도 없는 경우에만 표시
		if (!this.settings.onboardingComplete) {
			const cliOk = await isClaudeCLIAvailable(this.settings.cliBin);
			if (cliOk) {
				this.settings.onboardingComplete = true;
				await this.saveSettings();
			} else {
				new OnboardingModal(this.app, this).open();
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
