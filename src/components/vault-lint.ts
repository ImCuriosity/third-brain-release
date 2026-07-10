import { App, Modal, Notice } from 'obsidian';
import { GraphStore } from '../engine/graph-store';
import { findOrphanConnections } from '../engine/serial-pipeline';
import type { OrphanConnectionResult } from '../engine/serial-pipeline';
import type { TBNode, ThirdBrainSettings } from '../types';
import { getT } from '../i18n';

const MAX_ORPHANS = 10;

export class OrphanQueueModal extends Modal {
	constructor(
		app: App,
		private store: GraphStore,
		private settings: ThirdBrainSettings,
		private folders: string[],
		private onResolved: () => void
	) {
		super(app);
	}

	private get isKo() { return this.settings.lang === 'ko'; }
	private get t() { return getT(this.settings.lang); }

	onOpen() {
		this.renderFolderSelect();
	}

	// ── Phase 1: 폴더 선택 ───────────────────────────────────

	private renderFolderSelect() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('tb-popup-content', 'tb-orphan-lint-modal');
		this.setTitle(this.isKo ? '고립 노드 린팅' : 'Orphan Node Linting');

		contentEl.createEl('div', {
			cls: 'tb-popup-sub',
			text: this.isKo
				? '린팅할 폴더를 선택하세요. 선택한 폴더 내 고립 명제에서 연결 후보를 탐색합니다.'
				: 'Select a folder to lint. AI will search for connections within that folder.',
		});

		const rootFolder = this.settings.rootFolder || '';
		const eligible = this.folders.filter(f =>
			f !== rootFolder &&
			!f.split('/').includes('raw') &&
			!f.split('/').includes('_actions') &&
			!f.split('/').includes('_problems')
		);

		if (eligible.length === 0) {
			contentEl.createEl('div', {
				cls: 'tb-manual-conflict-empty',
				text: this.isKo ? '폴더가 없습니다.' : 'No folders found.',
			});
			return;
		}

		const list = contentEl.createEl('div', { cls: 'tb-popup-folder-list' });
		let selected: string | null = null;

		for (const folder of eligible) {
			const depth = folder.split('/').length - 1;
			const name = folder.split('/').pop() ?? folder;
			const label = list.createEl('label', { cls: 'tb-popup-folder-item' });
			label.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
			const radio = label.createEl('input', { attr: { type: 'radio', name: 'orphan-folder' } });
			radio.addClass('tb-popup-cb');
			radio.addEventListener('change', () => { selected = folder; });
			label.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
			label.createEl('span', { cls: 'tb-popup-folder-name', text: name });
		}

		const startBtn = contentEl.createEl('button', {
			cls: 'tb-btn tb-orphan-start-btn',
			text: this.isKo ? '린팅 시작' : 'Start Linting',
		});
		startBtn.addEventListener('click', () => {
			if (!selected) {
				new Notice(this.isKo ? '[ThirdBrain] 폴더를 선택하세요.' : '[ThirdBrain] Select a folder.');
				return;
			}
			void this.renderLintResults(selected);
		});
	}

	// ── Phase 2: 린팅 결과 ──────────────────────────────────

	private async renderLintResults(folderPath: string) {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.isKo ? `고립 노드 린팅 — ${folderPath}` : `Orphan Linting — ${folderPath}`);

		const loading = contentEl.createEl('div', {
			cls: 'tb-manual-conflict-empty',
			text: this.isKo ? '스캔 중...' : 'Scanning…',
		});

		let orphans: TBNode[];
		let candidates: TBNode[];
		let totalCount: number;

		try {
			const result = await this.store.scanOrphanPropositions(folderPath);
			totalCount = result.orphans.length;
			orphans = result.orphans.slice(0, MAX_ORPHANS);
			candidates = result.candidates;
		} catch {
			loading.textContent = this.isKo ? '스캔 실패' : 'Scan failed';
			return;
		}
		loading.remove();

		const backBtn = contentEl.createEl('button', {
			cls: 'tb-btn tb-content-type-back-btn',
			text: this.isKo ? '← 폴더 선택' : '← Back',
		});
		backBtn.addEventListener('click', () => { this.renderFolderSelect(); });

		if (orphans.length === 0) {
			contentEl.createEl('div', {
				cls: 'tb-manual-conflict-empty',
				text: this.isKo ? '✓ 이 폴더에 고립 명제 없음' : '✓ No isolated propositions in this folder',
			});
			return;
		}

		const desc = contentEl.createEl('div', { cls: 'tb-manual-conflict-count' });
		let descText = this.isKo
			? `${totalCount}개의 고립 명제를 발견했습니다.`
			: `Found ${totalCount} isolated propositions.`;
		if (candidates.length === 0) {
			descText += this.isKo
				? ' 연결 후보 노드가 없습니다 (폴더에 연결된 노드가 없음).'
				: ' No candidate nodes found (no connected nodes in folder yet).';
		} else {
			descText += this.isKo
				? ` AI가 ${candidates.length}개 노드에서 연결 후보를 탐색합니다.`
				: ` AI will search among ${candidates.length} nodes.`;
		}
		if (totalCount > MAX_ORPHANS) {
			descText += this.isKo ? ` (상위 ${MAX_ORPHANS}개 표시)` : ` (showing top ${MAX_ORPHANS})`;
		}
		desc.textContent = descText;

		const listEl = contentEl.createEl('div', { cls: 'tb-manual-conflict-list' });

		for (const orphan of orphans) {
			this.renderOrphanCard(listEl, orphan, candidates);
		}
	}

	private renderOrphanCard(container: HTMLElement, orphan: TBNode, candidates: TBNode[]) {
		const card = container.createEl('div', { cls: 'tb-orphan-card' });

		const header = card.createEl('div', { cls: 'tb-orphan-card-header' });
		header.createEl('div', { cls: 'tb-orphan-card-title', text: orphan.title });
		if (orphan.content) {
			header.createEl('div', {
				cls: 'tb-orphan-card-preview',
				text: orphan.content.slice(0, 100) + (orphan.content.length > 100 ? '…' : ''),
			});
		}

		const suggestArea = card.createEl('div', { cls: 'tb-orphan-suggest-area' });

		if (candidates.length === 0) {
			suggestArea.createEl('div', {
				cls: 'tb-orphan-no-result',
				text: this.isKo ? '연결 가능한 노드 없음' : 'No connectable nodes in this folder',
			});
			return;
		}

		const loadingEl = suggestArea.createEl('div', {
			cls: 'tb-orphan-loading',
			text: this.isKo ? 'AI 탐색 중...' : 'Searching…',
		});

		void (async () => {
			let results: OrphanConnectionResult[];
			try {
				results = await findOrphanConnections(orphan, candidates, this.settings);
			} catch {
				if (activeDocument.body.contains(loadingEl)) {
					loadingEl.textContent = this.isKo ? '탐색 실패' : 'Search failed';
				}
				return;
			}

			if (!activeDocument.body.contains(loadingEl)) return;
			loadingEl.remove();

			if (results.length === 0) {
				suggestArea.createEl('div', {
					cls: 'tb-orphan-no-result',
					text: this.isKo ? '연결 후보 없음' : 'No connection candidates found',
				});
				return;
			}

			for (const res of results) {
				this.renderSuggestion(suggestArea, orphan, res);
			}
		})();
	}

	private renderSuggestion(container: HTMLElement, orphan: TBNode, res: OrphanConnectionResult) {
		const row = container.createEl('div', { cls: 'tb-orphan-suggest-row' });

		const topLine = row.createEl('div', { cls: 'tb-orphan-suggest-top' });
		topLine.createEl('span', { cls: 'tb-orphan-suggest-target', text: res.targetTitle });
		topLine.createEl('span', { cls: 'tb-orphan-suggest-relation', text: res.relation });
		topLine.createEl('span', {
			cls: 'tb-orphan-suggest-conf',
			text: `${Math.round(res.confidence * 100)}%`,
		});
		const acceptBtn = topLine.createEl('button', {
			cls: 'tb-btn tb-orphan-accept-btn',
			text: this.isKo ? '연결' : 'Connect',
		});
		const doneMsg = topLine.createEl('span', { cls: 'tb-orphan-done-msg' });

		row.createEl('div', { cls: 'tb-orphan-suggest-reason', text: res.reason });

		acceptBtn.addEventListener('click', () => {
			void (async () => {
				acceptBtn.disabled = true;
				try {
					const orphanFile = this.app.vault.getFileByPath(orphan.filePath ?? '');
					const targetFilePath = this.findFilePath(res.targetTitle);
					const targetFile = targetFilePath ? this.app.vault.getFileByPath(targetFilePath) : null;

					if (!orphanFile || !targetFile) {
						new Notice(this.isKo ? '[ThirdBrain] 파일을 찾을 수 없습니다.' : '[ThirdBrain] File not found.');
						acceptBtn.disabled = false;
						return;
					}

					await this.store.addLintEdge(
						orphanFile, targetFile,
						orphan.title, res.targetTitle,
						res.relation, res.reason, res.confidence
					);

					acceptBtn.remove();
					doneMsg.textContent = this.isKo ? '✓ 연결됨' : '✓ Connected';
					doneMsg.addClass('is-visible');
					this.onResolved();
				} catch {
					new Notice(this.isKo ? '[ThirdBrain] 연결 저장 실패' : '[ThirdBrain] Failed to save connection.');
					acceptBtn.disabled = false;
				}
			})();
		});
	}

	private findFilePath(title: string): string | null {
		const match = this.app.vault.getMarkdownFiles().find(f => f.basename === title);
		return match?.path ?? null;
	}

	onClose() {
		this.contentEl.empty();
	}
}
