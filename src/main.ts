import { Platform, Plugin, WorkspaceLeaf, addIcon } from 'obsidian';
import { ThirdBrainSettings, DEFAULT_SETTINGS } from './types';
import { ThirdBrainView, VIEW_TYPE, sessionFolderOfProblem } from './view';
import { GraphStore } from './engine/graph-store';
import { MissionControlModal } from './components/workbench';
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
			id: 'open',
			name: 'Open panel',
			callback: () => { void this.activateView(); },
		});

		// [v0.3.5] 활성 파일이 문제 노드일 때만 노출 — 미션 컨트롤 작업대를 해당 미션으로 연다
		this.addCommand({
			id: 'open-mission-workbench',
			name: 'Open mission workbench (active problem note)',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				const isProblem = this.app.metadataCache.getFileCache(file)?.frontmatter?.tb_type === 'problem';
				if (!isProblem) return false;
				if (!checking) {
					new MissionControlModal(
						this.app, new GraphStore(this.app, this.settings), this.settings, {},
						{ folder: sessionFolderOfProblem(file), missionId: file.basename },
					).open();
				}
				return true;
			},
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
		void workspace.revealLeaf(leaf);

		// 온보딩: 최초 실행이고 claude CLI도 없는 경우에만 표시
		if (!this.settings.onboardingComplete) {
			// 이미 API 키가 설정된 경우 온보딩 스킵 (모바일 재진입 방지)
			const hasApiKey = !!(this.settings.geminiApiKey || this.settings.claudeApiKey || this.settings.openaiApiKey);
			const isApiProvider = this.settings.aiProvider !== 'claude-cli';
			if (hasApiKey && isApiProvider) {
				this.settings.onboardingComplete = true;
				await this.saveSettings();
				return;
			}
			// 모바일은 CLI 없음 — CLI 체크 스킵
			const cliOk = Platform.isMobile ? false : await isClaudeCLIAvailable(this.settings.cliBin);
			if (cliOk) {
				this.settings.onboardingComplete = true;
				await this.saveSettings();
			} else {
				new OnboardingModal(this.app, this).open();
			}
		}
	}

	async refreshView() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
		await this.activateView();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ThirdBrainSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
