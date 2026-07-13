import { App, Modal, Notice } from 'obsidian';
import { getT } from '../../i18n';
import type { TKey, Lang } from '../../i18n';
import { GraphStore } from '../../engine/graph-store';
import { analyzeTranscriptNodes } from '../../engine/serial-pipeline';
import type { TranscriptAnalysisMode } from '../../engine/serial-pipeline';
import { buildTensor, findPath, findTransitivePaths, addNodeToTensor } from '../../engine/adjacency-tensor';
import type { TBNode, TBEdge, GraphPath, SummaryResult, ThirdBrainSettings } from '../../types';
import { makeDraggable, relLabel, shortText } from './shared';
import { SaveFolderModal } from './ingest-modals';
import { confirmAICost } from '../ai-preflight';

function getAnalysisIntents(lang?: Lang): Array<{ label: string; prompt: string; mode: 'rich' | 'summary' }> {
	const t = getT(lang);
	return [
		{ label: t('intent_core_label'), prompt: t('intent_core_prompt'), mode: 'summary' },
		{ label: t('intent_logic_label'), prompt: t('intent_logic_prompt'), mode: 'rich' },
		{ label: t('intent_conflict_label'), prompt: t('intent_conflict_prompt'), mode: 'rich' },
		{ label: t('intent_present_label'), prompt: t('intent_present_prompt'), mode: 'summary' },
		{ label: t('intent_decision_label'), prompt: t('intent_decision_prompt'), mode: 'rich' },
	];
}

// ── 분석 탭 모달 (그래프 분석 + 경로 탐색) ──────────────────
export class AnalysisTabbedModal extends Modal {
	private loadedNodes: TBNode[] = [];
	private lang: Lang;

	private transcriptJob: { running: boolean; mode?: TranscriptAnalysisMode; result?: string; error?: string } | null;
	private onTranscriptJobUpdate: (job: { running: boolean; mode?: TranscriptAnalysisMode; result?: string; error?: string } | null) => void;

	constructor(
		app: App,
		private readonly folders: string[],
		private readonly store: GraphStore,
		private readonly onRun: (folder: string, mode: 'rich' | 'summary', intent?: string, includeActions?: boolean) => void,
		lang?: Lang,
		private readonly settings?: ThirdBrainSettings,
		initialJob: { running: boolean; mode?: TranscriptAnalysisMode; result?: string; error?: string } | null = null,
		onJobUpdate: (job: { running: boolean; mode?: TranscriptAnalysisMode; result?: string; error?: string } | null) => void = () => { /* no-op */ },
		private readonly isAnythingBusy: () => boolean = () => false,
	) {
		super(app);
		this.lang = lang ?? 'en';
		this.transcriptJob = initialJob;
		this.onTranscriptJobUpdate = onJobUpdate;
		this.modalEl.addClass('tb-popup');
	}

	private t(key: TKey): string { return getT(this.lang)(key); }

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_analysis_title') });
		makeDraggable(this.modalEl, titleEl);

		const tabBar = contentEl.createEl('div', { cls: 'tb-tab-bar' });
		const tabAnalysis = tabBar.createEl('button', { cls: 'tb-tab is-active', text: this.t('tab_graph_analysis') });
		const tabExpr = tabBar.createEl('button', { cls: 'tb-tab', text: this.t('tab_expression_analysis') });

		const paneAnalysis = contentEl.createEl('div', { cls: 'tb-analysis-tab-pane' });
		const paneExpr = contentEl.createEl('div', { cls: 'tb-analysis-tab-pane' });
		paneExpr.hide();

		const switchTab = (active: HTMLButtonElement, activePane: HTMLElement) => {
			for (const [tab, pane] of [[tabAnalysis, paneAnalysis], [tabExpr, paneExpr]] as [HTMLButtonElement, HTMLElement][]) {
				tab.toggleClass('is-active', tab === active);
				if (pane === activePane) pane.show(); else pane.hide();
			}
		};

		tabAnalysis.addEventListener('click', () => switchTab(tabAnalysis, paneAnalysis));
		tabExpr.addEventListener('click', () => switchTab(tabExpr, paneExpr));

		this.buildAnalysisPane(paneAnalysis);
		this.buildExpressionPane(paneExpr);
	}

	private buildAnalysisPane(container: HTMLElement) {
		container.createEl('div', {
			cls: 'tb-popup-sub',
			text: this.t('analysis_sub'),
		});

		if (this.folders.length === 0) {
			container.createEl('div', { cls: 'tb-popup-empty', text: this.t('analysis_no_folder') });
			const footer = container.createEl('div', { cls: 'tb-popup-footer' });
			footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_close') }).addEventListener('click', () => this.close());
			return;
		}

		const makeSelect = (label: string): HTMLSelectElement => {
			const row = container.createEl('div', { cls: 'tb-popup-select-row' });
			row.createEl('label', { cls: 'tb-popup-select-label', text: label });
			return row.createEl('select', { cls: 'tb-popup-select' });
		};

		// ── 폴더 선택 체크박스 리스트 ────
		container.createEl('div', { cls: 'tb-popup-select-label', text: this.t('analysis_folder_label') });
		const analysisFolders = this.folders.filter(f => !f.endsWith('/_actions') && f !== '_actions');
		const folderList = container.createEl('div', { cls: 'tb-popup-folder-list' });
		const analysisCbs: Array<{ folder: string; cb: HTMLInputElement }> = [];
		for (const f of analysisFolders) {
			const depth = f.split('/').length - 1;
			const name = f.split('/').pop() ?? f;
			const label = folderList.createEl('label', { cls: 'tb-popup-folder-item' });
			label.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
			const cb = label.createEl('input', { attr: { type: 'checkbox' } });
			cb.addClass('tb-popup-cb');
			label.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
			label.createEl('span', { cls: 'tb-popup-folder-name', text: name });
			analysisCbs.push({ folder: f, cb });
		}
		// 상위 폴더 체크 시 하위 폴더 자동 체크 (그래프 모달과 동일)
		for (let i = 0; i < analysisCbs.length; i++) {
			const { folder, cb } = analysisCbs[i];
			cb.addEventListener('change', () => {
				for (let j = i + 1; j < analysisCbs.length; j++) {
					if (analysisCbs[j].folder.startsWith(folder + '/')) {
						analysisCbs[j].cb.checked = cb.checked;
					}
				}
				updateActionsRow(analysisCbs.filter(c => c.cb.checked)[0]?.folder ?? '');
			});
		}

		// ── _actions 포함 여부 ────
		const actionsRow = container.createEl('div', { cls: 'tb-popup-select-row tb-actions-include-row' });
		actionsRow.hide();
		const actionsChk = actionsRow.createEl('input', {
			attr: { type: 'checkbox', id: 'tb-include-actions' },
		});
		const actionsLbl = actionsRow.createEl('label', {
			cls: 'tb-actions-include-label',
			attr: { for: 'tb-include-actions' },
			text: this.t('analysis_actions_label'),
		});
		void actionsLbl;

		const updateActionsRow = (folder: string) => {
			const hasActions = !!this.app.vault.getFolderByPath(`${folder}/_actions`);
			if (hasActions) actionsRow.show(); else actionsRow.hide();
			if (!hasActions) actionsChk.checked = false;
		};
		updateActionsRow('');

		container.createEl('div', { cls: 'tb-popup-select-label', text: this.t('analysis_intent_label') });
		const chipRow = container.createEl('div', { cls: 'tb-intent-chips' });
		let selectedIntent: string | undefined;
		let activeChip: HTMLElement | null = null;

		for (const intent of getAnalysisIntents(this.lang)) {
			const chip = chipRow.createEl('button', { cls: 'tb-intent-chip', text: intent.label });
			chip.addEventListener('click', () => {
				activeChip?.removeClass('is-active');
				if (activeChip === chip) {
					activeChip = null;
					selectedIntent = undefined;
				} else {
					chip.addClass('is-active');
					activeChip = chip;
					selectedIntent = intent.prompt;
					modeSel.value = intent.mode;
					customInput.value = '';
				}
			});
		}

		const customRow = container.createEl('div', { cls: 'tb-popup-select-row' });
		customRow.createEl('label', { cls: 'tb-popup-select-label', text: this.t('analysis_custom_label') });
		const customInput = customRow.createEl('textarea', {
			cls: 'tb-intent-custom',
			attr: { placeholder: this.t('analysis_custom_placeholder'), rows: '2' },
		});
		customInput.addEventListener('input', () => {
			if (customInput.value.trim()) {
				activeChip?.removeClass('is-active');
				activeChip = null;
				selectedIntent = undefined;
			}
		});

		const modeSel = makeSelect(this.t('analysis_depth_label'));
		modeSel.createEl('option', { attr: { value: 'summary' }, text: this.t('analysis_depth_summary') });
		modeSel.createEl('option', { attr: { value: 'rich' }, text: this.t('analysis_depth_rich') });

		const footer = container.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_cancel') }).addEventListener('click', () => this.close());
		const analyzeStartBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_analyze_start') });
		analyzeStartBtn.disabled = this.isAnythingBusy();
		analyzeStartBtn.addEventListener('click', () => {
			if (this.isAnythingBusy()) { new Notice(this.t('notice_ai_busy')); return; }
			const folder = analysisCbs.filter(c => c.cb.checked)[0]?.folder ?? '';
			const mode = modeSel.value as 'rich' | 'summary';
			if (!folder) { new Notice(this.t('notice_select_folder_analysis')); return; }
			const intent = customInput.value.trim() || selectedIntent;
			const includeActions = actionsChk.checked;
			this.close();
			this.onRun(folder, mode, intent, includeActions);
		});
	}

	private buildPathPane(container: HTMLElement) {
		container.createEl('div', {
			cls: 'tb-popup-sub',
			text: this.t('path_sub'),
		});

		// ── 폴더 선택 라디오 리스트 ────
		container.createEl('div', { cls: 'tb-popup-select-label', text: this.t('path_folder_label') });
		const pathFolderList = container.createEl('div', { cls: 'tb-popup-folder-list' });

		const srcRow = container.createEl('div', { cls: 'tb-popup-select-row' });
		srcRow.createEl('label', { cls: 'tb-popup-select-label', text: this.t('path_src_label') });
		const srcSel = srcRow.createEl('select', { cls: 'tb-popup-select' });
		srcSel.createEl('option', { attr: { value: '' }, text: this.t('path_src_placeholder') });
		srcSel.disabled = true;

		const dstRow = container.createEl('div', { cls: 'tb-popup-select-row' });
		dstRow.createEl('label', { cls: 'tb-popup-select-label', text: this.t('path_dst_label') });
		const dstSel = dstRow.createEl('select', { cls: 'tb-popup-select' });
		dstSel.createEl('option', { attr: { value: '' }, text: this.t('path_dst_placeholder') });
		dstSel.disabled = true;

		const resultEl = container.createEl('div', { cls: 'tb-path-result' });

		const loadPathFolder = async (folder: string) => {
			srcSel.disabled = true; dstSel.disabled = true;
			srcSel.empty(); dstSel.empty();
			srcSel.createEl('option', { attr: { value: '' }, text: this.t('path_loading') });
			dstSel.createEl('option', { attr: { value: '' }, text: this.t('path_loading') });
			resultEl.empty();

			const nodes = await this.store.loadNodesInFolder(folder);
			this.loadedNodes = nodes;

			srcSel.empty(); dstSel.empty();
			srcSel.createEl('option', { attr: { value: '' }, text: this.t('path_src_loaded') });
			dstSel.createEl('option', { attr: { value: '' }, text: this.t('path_dst_loaded') });
			for (const n of nodes) {
				srcSel.createEl('option', { attr: { value: n.id }, text: n.title });
				dstSel.createEl('option', { attr: { value: n.id }, text: n.title });
			}
			srcSel.disabled = false; dstSel.disabled = false;
		};

		const pathCbs: Array<{ folder: string; cb: HTMLInputElement }> = [];
		for (const f of this.folders) {
			const depth = f.split('/').length - 1;
			const name = f.split('/').pop() ?? f;
			const label = pathFolderList.createEl('label', { cls: 'tb-popup-folder-item' });
			label.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
			const cb = label.createEl('input', { attr: { type: 'checkbox' } });
			cb.addClass('tb-popup-cb');
			label.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
			label.createEl('span', { cls: 'tb-popup-folder-name', text: name });
			pathCbs.push({ folder: f, cb });
		}
		for (let i = 0; i < pathCbs.length; i++) {
			const { folder, cb } = pathCbs[i];
			cb.addEventListener('change', () => {
				// 단일 선택 + 하위 폴더 자동 체크
				for (let j = 0; j < pathCbs.length; j++) {
					if (j === i) continue;
					if (pathCbs[j].folder.startsWith(folder + '/')) {
						pathCbs[j].cb.checked = cb.checked;
					} else {
						pathCbs[j].cb.checked = false;
					}
				}
				if (cb.checked) void loadPathFolder(folder);
			});
		}

		const footer = container.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_close') }).addEventListener('click', () => this.close());
		const searchBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_search') });

		searchBtn.addEventListener('click', () => void (async () => {
			const srcId = srcSel.value;
			const dstId = dstSel.value;
			if (!srcId || !dstId) {
				resultEl.empty();
				resultEl.createEl('div', { cls: 'tb-path-empty', text: this.t('path_select_nodes') });
				return;
			}
			if (srcId === dstId) {
				resultEl.empty();
				resultEl.createEl('div', { cls: 'tb-path-empty', text: this.t('path_same_node') });
				return;
			}

			searchBtn.disabled = true;
			searchBtn.textContent = this.t('btn_searching');
			resultEl.empty();

			try {
				const nodes = this.loadedNodes;
				const tensor = buildTensor(nodes);
				resultEl.createEl('div', {
					cls: 'tb-path-meta',
					text: `${nodes.length}${this.t('path_node_count_suffix')} / ${tensor.edges.length}${this.t('path_edge_count_suffix')}`,
				});

				const path = findPath(tensor, srcId, dstId, 6);
				if (path) {
					this.renderPathCard(resultEl, path, nodes, tensor);
				} else {
					const transitivePaths = findTransitivePaths(tensor, srcId, dstId, 6);
					if (transitivePaths.length > 0) {
						for (const tp of transitivePaths) this.renderPathCard(resultEl, tp, nodes, tensor);
					} else {
						const srcTitle = nodes.find(n => n.id === srcId)?.title ?? srcId;
						const dstTitle = nodes.find(n => n.id === dstId)?.title ?? dstId;
						resultEl.createEl('div', {
							cls: 'tb-path-empty',
							text: `"${srcTitle}" → "${dstTitle}" ${this.t('path_no_path')}`,
						});
					}
				}
			} catch (err) {
				resultEl.empty();
				resultEl.createEl('div', {
					cls: 'tb-path-empty',
					text: `${this.t('path_error_prefix')}${err instanceof Error ? err.message : String(err)}`,
				});
			} finally {
				searchBtn.disabled = false;
				searchBtn.textContent = this.t('btn_search');
			}
		})());
	}

	private renderPathCard(
		container: HTMLElement,
		path: GraphPath,
		nodes: TBNode[],
		tensor: ReturnType<typeof buildTensor>
	) {
		const titleById = new Map(nodes.map(n => [n.id, n.title]));
		const card = container.createEl('div', {
			cls: path.isTransitive ? 'tb-path-card tb-path-transitive' : 'tb-path-card',
		});

		const header = card.createEl('div', { cls: 'tb-path-header' });
		if (path.isTransitive) {
			header.createEl('span', { cls: 'tb-path-transitive-badge', text: this.t('path_transitive_badge') });
		}
		header.createEl('span', {
			cls: 'tb-path-meta-inline',
			text: `${path.nodes.length - 1}${this.t('path_hop')} · ${this.t('path_confidence')} ${(path.totalConfidence * 100).toFixed(0)}%`,
		});

		const chain = card.createEl('div', { cls: 'tb-path-chain' });
		for (let i = 0; i < path.nodes.length; i++) {
			const nodeId = path.nodes[i];
			const nodeTitle = titleById.get(nodeId) ?? nodeId;
			const nodeEl = chain.createEl('span', { cls: 'tb-path-node', text: nodeTitle });

			nodeEl.addEventListener('click', () => {
				const node = nodes.find(n => n.id === nodeId);
				if (node?.filePath) {
					const file = this.app.vault.getFileByPath(node.filePath);
					if (file) void this.app.workspace.getLeaf().openFile(file);
				}
			});

			if (i < path.relations.length) {
				const rel = path.relations[i];
				const relStr = relLabel(rel, this.lang);
				chain.createEl('span', { cls: 'tb-path-arrow', text: `→[${relStr}]→` });
			}
		}

		if (path.isTransitive && path.nodes.length >= 3) {
			const srcId = path.nodes[0];
			const dstId = path.nodes[path.nodes.length - 1];
			const inferredRel = path.relations[0];

			const confirmBtn = card.createEl('button', {
				cls: 'tb-btn tb-path-confirm-btn',
				text: `${this.t('path_save_transitive')} (${relLabel(inferredRel, this.lang)})`,
			});
			confirmBtn.addEventListener('click', () => void (async () => {
				confirmBtn.disabled = true;
				try {
					const srcNode = nodes.find(n => n.id === srcId);
					const dstNode = nodes.find(n => n.id === dstId);
					if (!srcNode || !dstNode) throw new Error('노드를 찾을 수 없습니다.');

					const srcFile = this.app.vault.getFileByPath(srcNode.filePath);
					if (!srcFile) throw new Error('파일을 찾을 수 없습니다.');

					const newEdge: TBEdge = {
						target: `[[${dstNode.title}]]`,
						label: inferredRel,
						confirmed: true,
						reason: `${this.t('path_transitive_badge')} (${path.nodes.map(id => titleById.get(id) ?? id).join(' → ')})`,
						confidence: path.totalConfidence,
						axiom_basis: `${this.t('path_transitive_badge')}: ${path.nodes.map(id => titleById.get(id) ?? id).join(' → ')}`,
					};
					await this.store.confirmEdge(srcFile, newEdge);
					confirmBtn.textContent = `${this.t('btn_save_done')} ✓`;
					confirmBtn.addClass('tb-chip-connect-done');

					addNodeToTensor(tensor, { ...srcNode, edges: [...srcNode.edges, newEdge] });
				} catch (err) {
					confirmBtn.disabled = false;
					new Notice(`${this.t('notice_analysis_save_fail')}${err instanceof Error ? err.message : String(err)}`);
				}
			})());
		}
	}

	private buildExpressionPane(container: HTMLElement) {
		container.createEl('div', { cls: 'tb-popup-sub', text: this.t('expression_analysis_sub') });

		if (this.folders.length === 0) {
			container.createEl('div', { cls: 'tb-popup-empty', text: this.t('analysis_no_folder') });
			const footer = container.createEl('div', { cls: 'tb-popup-footer' });
			footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_close') })
				.addEventListener('click', () => this.close());
			return;
		}

		// ── 폴더 선택
		container.createEl('div', { cls: 'tb-popup-select-label', text: this.t('analysis_folder_label') });
		const analysisFolders = this.folders.filter(f => !f.endsWith('/_actions') && f !== '_actions');
		const folderList = container.createEl('div', { cls: 'tb-popup-folder-list' });
		const exprCbs: Array<{ folder: string; cb: HTMLInputElement }> = [];
		for (const f of analysisFolders) {
			const depth = f.split('/').length - 1;
			const name = f.split('/').pop() ?? f;
			const label = folderList.createEl('label', { cls: 'tb-popup-folder-item' });
			label.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
			const cb = label.createEl('input', { attr: { type: 'checkbox' } });
			cb.addClass('tb-popup-cb');
			label.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
			label.createEl('span', { cls: 'tb-popup-folder-name', text: name });
			exprCbs.push({ folder: f, cb });
		}
		for (let i = 0; i < exprCbs.length; i++) {
			const { folder, cb } = exprCbs[i];
			cb.addEventListener('change', () => {
				for (let j = i + 1; j < exprCbs.length; j++) {
					if (exprCbs[j].folder.startsWith(folder + '/')) exprCbs[j].cb.checked = cb.checked;
				}
			});
		}

		// ── 모드 선택 (드롭다운)
		const modeOptions: Array<{ id: TranscriptAnalysisMode; labelKey: TKey; descKey: TKey }> = [
			{ id: 'language',  labelKey: 'expression_mode1_label', descKey: 'expression_mode1_desc' },
			{ id: 'info',      labelKey: 'expression_mode2_label', descKey: 'expression_mode2_desc' },
			{ id: 'directive', labelKey: 'expression_mode3_label', descKey: 'expression_mode3_desc' },
			{ id: 'para',      labelKey: 'expression_mode4_label', descKey: 'expression_mode4_desc' },
		];
		let selectedMode: TranscriptAnalysisMode | null = null;
		const modeRow = container.createEl('div', { cls: 'tb-popup-select-row' });
		modeRow.createEl('label', { cls: 'tb-popup-select-label', text: this.t('expression_mode_title') });
		const modeSelect = modeRow.createEl('select', { cls: 'tb-popup-select' });
		modeSelect.createEl('option', { attr: { value: '' }, text: this.t('expression_mode_placeholder') });
		for (const opt of modeOptions) {
			modeSelect.createEl('option', { attr: { value: opt.id }, text: this.t(opt.labelKey) });
		}
		modeSelect.addEventListener('change', () => {
			selectedMode = (modeSelect.value as TranscriptAnalysisMode) || null;
		});

		// ── 결과 영역
		const resultEl = container.createEl('div', { cls: 'tb-expression-result' });

		const footer = container.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_close') })
			.addEventListener('click', () => this.close());
		const analyzeBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('expression_analyze_btn') });

		// ── UI 상태 토글 헬퍼
		const setRunningUI = (on: boolean) => {
			analyzeBtn.disabled = on;
			analyzeBtn.textContent = on ? this.t('expression_analyzing') : this.t('expression_analyze_btn');
			modeSelect.disabled = on;
			for (const { cb } of exprCbs) cb.disabled = on;
		};

		// ── 결과 표시 헬퍼
		const showResult = (text: string) => {
			resultEl.empty();
			const textarea = resultEl.createEl('textarea', { cls: 'tb-expr-result-textarea' });
			textarea.value = text;
			if (!footer.querySelector('.tb-expr-save-btn')) {
				const saveBtn = footer.createEl('button', { cls: 'tb-btn tb-expr-save-btn', text: this.t('expression_save_btn') });
				saveBtn.addEventListener('click', () => void (async () => {
					saveBtn.disabled = true;
					saveBtn.textContent = this.t('btn_saving');
					try {
						new SaveFolderModal(
							this.app, this.folders, this.folders[0] ?? '',
							(targetFolder: string) => void (async (f: string) => {
								const currentText = textarea.value;
								const timestamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
								const filename = `transcript-analysis_${timestamp}.md`;
								if (!this.app.vault.getFolderByPath(f)) await this.app.vault.createFolder(f);
								await this.app.vault.create(`${f}/${filename}`, currentText);
								new Notice(filename);
							})(targetFolder),
							this.lang,
							this.settings?.rootFolder ?? '',
						).open();
					} finally {
						saveBtn.disabled = false;
						saveBtn.textContent = this.t('expression_save_btn');
					}
				})());
			}
		};

		// ── 이전 작업 상태 복원
		if (this.transcriptJob?.running) {
			setRunningUI(true);
			resultEl.createEl('div', { cls: 'tb-popup-empty', text: this.t('expression_analyzing') });
		} else if (this.transcriptJob?.result) {
			showResult(this.transcriptJob.result);
		} else if (this.transcriptJob?.error) {
			resultEl.createEl('div', { cls: 'tb-path-empty', text: this.transcriptJob.error });
		}

		// ── 분석 시작 (백그라운드 — 모달 닫혀도 계속 실행)
		analyzeBtn.addEventListener('click', () => {
			const selectedFolders = exprCbs.filter(c => c.cb.checked).map(c => c.folder);
			if (selectedFolders.length === 0) { new Notice(this.t('notice_select_folder_analysis')); return; }
			if (!selectedMode) { new Notice(this.t('expression_mode_not_selected')); return; }
			if (this.transcriptJob?.running) return;

			const mode = selectedMode;
			this.transcriptJob = { running: true, mode };
			this.onTranscriptJobUpdate(this.transcriptJob);
			setRunningUI(true);
			resultEl.empty();
			resultEl.createEl('div', { cls: 'tb-popup-empty', text: this.t('expression_analyzing') });

			void (async () => {
				try {
					const allNodes: Array<{ title: string; type: string; content: string }> = [];
					for (const f of selectedFolders) {
						const nodes = await this.store.loadNodesInFolder(f);
						for (const n of nodes) allNodes.push({ title: n.title, type: n.type, content: n.content });
					}
					if (allNodes.length === 0) {
						const msg = this.t('expression_no_nodes');
						this.transcriptJob = { running: false, mode, error: msg };
						this.onTranscriptJobUpdate(this.transcriptJob);
						if (activeDocument.body.contains(resultEl)) {
							setRunningUI(false);
							resultEl.empty();
							resultEl.createEl('div', { cls: 'tb-popup-empty', text: msg });
						}
						return;
					}

					const settings = this.settings ?? { rootFolder: 'ThirdBrainRoot', cliBin: 'claude', maxEdgeCandidates: 3, aiProvider: 'claude-cli' as const };

					// AI 비용 확인 게이트
					const analysisChars = allNodes.reduce((s, n) => s + n.title.length + n.content.length, 0);
					if (!(await confirmAICost(this.app, settings, {
						operation: 'transcript', charCount: analysisChars, units: 1, tier: 'fast', provider: settings.aiProvider,
					}))) {
						this.transcriptJob = { running: false, mode };
						this.onTranscriptJobUpdate(this.transcriptJob);
						if (activeDocument.body.contains(resultEl)) { setRunningUI(false); resultEl.empty(); }
						return;
					}

					const resultText = await analyzeTranscriptNodes(allNodes, mode, settings);

					this.transcriptJob = { running: false, mode, result: resultText };
					this.onTranscriptJobUpdate(this.transcriptJob);

					if (activeDocument.body.contains(resultEl)) {
						setRunningUI(false);
						showResult(resultText);
					} else {
						new Notice(this.t('expression_analyze_btn') + ' ✓');
					}
				} catch (err) {
					const msg = `${this.t('path_error_prefix')}${err instanceof Error ? err.message : String(err)}`;
					this.transcriptJob = { running: false, mode, error: msg };
					this.onTranscriptJobUpdate(this.transcriptJob);
					if (activeDocument.body.contains(resultEl)) {
						setRunningUI(false);
						resultEl.empty();
						resultEl.createEl('div', { cls: 'tb-path-empty', text: msg });
					} else {
						new Notice(msg, 8000);
					}
				}
			})();
		});
	}

	onClose() { this.contentEl.empty(); }
}

// ── 분석 결과 모달 ─────────────────────────────────────────
export class AnalysisResultModal extends Modal {
	private lang: Lang;

	constructor(
		app: App,
		private result: SummaryResult,
		private folderPath: string,
		private mode: 'rich' | 'summary' | undefined,
		private intent: string | undefined,
		private onSave: () => void,
		lang?: Lang
	) {
		super(app);
		this.lang = lang ?? 'en';
	}

	private t(key: TKey): string { return getT(this.lang)(key); }

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass('tb-analysis-result-modal');

		modalEl.addClass('tb-analysis-result-container');

		// 헤더
		const hdr = contentEl.createEl('div', { cls: 'tb-ar-header' });
		hdr.createEl('div', { cls: 'tb-ar-folder', text: `📊 ${this.folderPath}` });

		// 분석 기준 표시
		const modeLabel = this.mode === 'rich' ? this.t('analysis_depth_rich') : this.t('analysis_depth_summary');
		const metaRow = hdr.createEl('div', { cls: 'tb-ar-meta' });
		metaRow.createEl('span', { cls: 'tb-ar-meta-mode', text: modeLabel });
		if (this.intent) {
			metaRow.createEl('span', { cls: 'tb-ar-meta-sep', text: '·' });
			metaRow.createEl('span', { cls: 'tb-ar-meta-intent', text: this.intent });
		}

		const body = contentEl.createEl('div', { cls: 'tb-ar-body' });

		// 종합 결론 (synthesis) — 항상 맨 위, 펼쳐진 상태
		if (this.result.synthesis) {
			const synthCard = body.createEl('div', { cls: 'tb-ar-synthesis-card' });
			synthCard.createEl('div', { cls: 'tb-ar-synthesis-label', text: this.t('ar_synthesis_label') });
			synthCard.createEl('div', { cls: 'tb-ar-synthesis-text', text: this.result.synthesis });
		}

		// 개요
		if (this.result.overview) {
			this.makeSection(body, this.t('ar_overview_label'), el => {
				el.createEl('div', { cls: 'tb-ar-overview', text: this.result.overview });
			}, true);
		}

		// 주요 통찰
		if (this.result.highlights.length > 0) {
			this.makeSection(body, `💡 ${this.t('ar_highlights_label')} · ${this.result.highlights.length}`, el => {
				for (const h of this.result.highlights) {
					const row = el.createEl('div', { cls: 'tb-ar-highlight' });
					row.createEl('span', { cls: 'tb-ar-bullet', text: '·' });
					row.createEl('span', { text: h });
				}
			}, true);
		}

		// 주제 묶음
		if (this.result.themes.length > 0) {
			this.makeSection(body, `🏷 ${this.t('ar_themes_label')} · ${this.result.themes.length}`, el => {
				for (const theme of this.result.themes) {
					const card = el.createEl('div', { cls: 'tb-ar-theme-card' });
					card.createEl('div', { cls: 'tb-ar-theme-title', text: theme.title });
					card.createEl('div', { cls: 'tb-ar-theme-desc', text: theme.description });
				}
			}, false);
		}

		// 연결 맥락
		if (this.result.link_contexts.length > 0) {
			this.makeSection(body, `🔗 ${this.t('ar_link_contexts_label')} · ${this.result.link_contexts.length}`, el => {
				for (const lc of this.result.link_contexts) {
					const row = el.createEl('div', { cls: 'tb-ar-lc-row' });
					const top = row.createEl('div', { cls: 'tb-ar-lc-top' });
					top.createEl('span', { cls: 'tb-lc-node', text: shortText(lc.source, 16) });
					top.createEl('span', { cls: 'tb-lc-arrow', text: ` ―${lc.relation}→ ` });
					top.createEl('span', { cls: 'tb-lc-node', text: shortText(lc.target, 16) });
					row.createEl('div', { cls: 'tb-lc-context', text: lc.context });
				}
			}, false);
		}

		// 푸터
		const footer = contentEl.createEl('div', { cls: 'tb-ar-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_close') }).addEventListener('click', () => this.close());
		footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_save') }).addEventListener('click', () => {
			this.close();
			this.onSave();
		});
	}

	private makeSection(parent: HTMLElement, label: string, fill: (el: HTMLElement) => void, open: boolean) {
		const wrap = parent.createEl('div', { cls: 'tb-ar-section' });
		const toggler = wrap.createEl('div', { cls: `tb-ar-section-toggle${open ? ' is-open' : ''}` });
		toggler.createEl('span', { cls: 'tb-ar-chevron', text: open ? '▾' : '▸' });
		toggler.createEl('span', { text: label });
		const content = wrap.createEl('div', { cls: 'tb-ar-section-content' });
		if (!open) content.hide();
		fill(content);
		toggler.addEventListener('click', () => {
			const isOpen = content.isShown();
			if (isOpen) content.hide(); else content.show();
			toggler.toggleClass('is-open', !isOpen);
			toggler.querySelector('.tb-ar-chevron')!.textContent = isOpen ? '▸' : '▾';
		});
	}

	onClose() { this.contentEl.empty(); }
}
