import { App, Modal, Notice, TFile } from 'obsidian';
import { getT } from '../../i18n';
import type { TKey, Lang } from '../../i18n';
import { GraphStore } from '../../engine/graph-store';
import { parseGraphQuery } from '../../engine/serial-pipeline';
import type { GraphQuerySpec } from '../../engine/serial-pipeline';
import { GraphView, EDGE_COLOR } from '../graph-view';
import { GraphExporter } from '../../engine/graph-exporter';
import type { TBNode, ThirdBrainSettings } from '../../types';
import { makeDraggable, relLabel } from './shared';

const PRESET_QUERIES: Array<{ key: TKey; relations: string[] }> = [
	{ key: 'modal_query_preset_causal',     relations: ['causes', 'precedes', 'precondition_of'] },
	{ key: 'modal_query_preset_evidence',   relations: ['supports', 'conflicts_with', 'contrasts_with'] },
	{ key: 'modal_query_preset_hierarchy',  relations: ['exemplifies', 'applies_to'] },
	{ key: 'modal_query_preset_structural', relations: ['analogous_to', 'isomorphic_to'] },
];

// ── Canvas 그래프 모달 ────────────────────────────────────
export class GraphCanvasModal extends Modal {
	private graphView!: GraphView;

	constructor(
		app: App,
		private nodes: TBNode[],
		private activeRelations: Set<string>,
		private lang: Lang,
	) {
		super(app);
		this.modalEl.addClass('tb-canvas-modal');
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(this.lang === 'ko' ? '지식 그래프' : 'Knowledge Graph');

		// 캔버스 — 전체 영역
		const canvasWrap = contentEl.createEl('div', { cls: 'tb-canvas-wrap' });
		this.graphView = new GraphView(canvasWrap, () => { }, this.lang, (rawPath, blockId) => {
			void this.app.workspace.openLinkText(`${rawPath}#^${blockId}`, '');
		});
		const legendEntries = [...this.activeRelations].map(rel => ({
			color: EDGE_COLOR[rel] ?? '#888',
			label: relLabel(rel, this.lang),
		}));
		this.graphView.setLegend(legendEntries);
		window.setTimeout(() => { this.graphView.render(this.nodes, this.activeRelations); }, 0);
	}

	onClose() {
		this.graphView?.cleanup();
		this.contentEl.empty();
	}
}

// ── 그래프 보기 모달 (폴더 선택 + 쿼리 필터 통합) ───────
export class GraphViewModal extends Modal {
	private lang: Lang;
	private activeRelations = new Set<string>([
		'causes', 'precedes', 'precondition_of',
		'supports', 'conflicts_with', 'contrasts_with',
		'exemplifies', 'applies_to', 'analogous_to', 'isomorphic_to',
	]);
	private querySpec: GraphQuerySpec | null = null;

	constructor(
		app: App,
		private folders: string[],
		private onNative: (folders: string[], excludeConflicts: boolean) => void,
		private onCanvas: (folders: string[], relations: Set<string>) => Promise<void>,
		private store: GraphStore,
		private settings: ThirdBrainSettings,
	) {
		super(app);
		this.lang = settings.lang ?? 'en';
		this.modalEl.addClass('tb-popup');
	}

	private t(key: TKey): string { return getT(this.lang)(key); }

	private buildFolderList(container: HTMLElement): Array<{ folder: string; cb: HTMLInputElement }> {
		const list = container.createEl('div', { cls: 'tb-popup-folder-list' });
		if (this.folders.length === 0) {
			list.createEl('div', { cls: 'tb-popup-empty', text: this.t('modal_graph_empty') });
			return [];
		}
		const checkboxes: Array<{ folder: string; cb: HTMLInputElement }> = [];
		for (const folder of this.folders) {
			const depth = folder.split('/').length - 1;
			const name = folder.split('/').pop() ?? folder;
			const label = list.createEl('label', { cls: 'tb-popup-folder-item' });
			label.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
			const cb = label.createEl('input', { attr: { type: 'checkbox' } });
			cb.addClass('tb-popup-cb');
			label.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
			label.createEl('span', { cls: 'tb-popup-folder-name', text: name });
			checkboxes.push({ folder, cb });
		}
		// 상위 폴더 체크 시 하위 폴더 자동 체크
		for (let i = 0; i < checkboxes.length; i++) {
			const { folder, cb } = checkboxes[i];
			cb.addEventListener('change', () => {
				for (let j = i + 1; j < checkboxes.length; j++) {
					if (checkboxes[j].folder.startsWith(folder + '/')) {
						checkboxes[j].cb.checked = cb.checked;
					}
				}
			});
		}
		return checkboxes;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_graph_title') });
		makeDraggable(this.modalEl, titleEl);

		const tabBar = contentEl.createEl('div', { cls: 'tb-tab-bar' });
		const tabNative = tabBar.createEl('button', { cls: 'tb-tab is-active', text: this.t('modal_query_open_native') });
		const tabCanvas = tabBar.createEl('button', { cls: 'tb-tab', text: this.t('modal_query_open_canvas') });
		const tabDownload = tabBar.createEl('button', { cls: 'tb-tab', text: this.t('modal_query_open_download') });
		const tabDelete = tabBar.createEl('button', { cls: 'tb-tab tb-tab-danger', text: this.t('modal_query_open_delete') });

		const paneNative = contentEl.createEl('div', { cls: 'tb-analysis-tab-pane' });
		const paneCanvas = contentEl.createEl('div', { cls: 'tb-analysis-tab-pane' });
		const paneDownload = contentEl.createEl('div', { cls: 'tb-analysis-tab-pane' });
		const paneDelete = contentEl.createEl('div', { cls: 'tb-analysis-tab-pane' });
		paneCanvas.hide();
		paneDownload.hide();
		paneDelete.hide();

		const setActiveTab = (active: HTMLElement) => {
			tabNative.removeClass('is-active'); tabCanvas.removeClass('is-active'); tabDownload.removeClass('is-active'); tabDelete.removeClass('is-active');
			paneNative.hide(); paneCanvas.hide(); paneDownload.hide(); paneDelete.hide();
			if (active === paneNative) tabNative.addClass('is-active');
			else if (active === paneCanvas) tabCanvas.addClass('is-active');
			else if (active === paneDownload) tabDownload.addClass('is-active');
			else if (active === paneDelete) tabDelete.addClass('is-active');
			active.show();
		};

		tabNative.addEventListener('click', () => setActiveTab(paneNative));
		tabCanvas.addEventListener('click', () => setActiveTab(paneCanvas));
		tabDownload.addEventListener('click', () => setActiveTab(paneDownload));
		tabDelete.addEventListener('click', () => setActiveTab(paneDelete));

		this.buildNativePane(paneNative);
		this.buildCanvasPane(paneCanvas);
		this.buildDownloadPane(paneDownload);
		this.buildDeletePane(paneDelete);
	}

	private buildNativePane(container: HTMLElement) {
		container.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_graph_native_sub') });

		container.createEl('div', { cls: 'tb-popup-select-label', text: this.t('analysis_folder_label') });
		const checkboxes = this.buildFolderList(container);

		const footer = container.createEl('div', { cls: 'tb-popup-footer' });
		const filterRow = footer.createEl('label', { cls: 'tb-graph-filter-row is-active' });
		const conflictCb = filterRow.createEl('input', { attr: { type: 'checkbox' } });
		conflictCb.addClass('tb-popup-cb');
		conflictCb.checked = true;
		filterRow.createEl('span', { cls: 'tb-graph-filter-label', text: this.t('graph_exclude_conflicts') });
		conflictCb.addEventListener('change', () => filterRow.toggleClass('is-active', conflictCb.checked));

		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_cancel') })
			.addEventListener('click', () => this.close());
		footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_open_graph') })
			.addEventListener('click', () => {
				const selected = checkboxes.filter(c => c.cb.checked).map(c => c.folder);
				if (selected.length === 0) { new Notice(this.t('notice_select_folder')); return; }
				this.close();
				this.onNative(selected, conflictCb.checked);
			});
	}

	private buildCanvasPane(container: HTMLElement) {
		container.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_graph_canvas_sub') });

		container.createEl('div', { cls: 'tb-popup-select-label', text: this.t('analysis_folder_label') });
		const checkboxes = this.buildFolderList(container);

		// ── 프리셋 필터 (드롭다운) ──────────────────────────
		const presetRow = container.createEl('div', { cls: 'tb-popup-select-row' });
		presetRow.createEl('label', { cls: 'tb-popup-select-label', text: this.t('modal_query_preset_label') });
		const presetSelect = presetRow.createEl('select', { cls: 'tb-popup-select' });
		presetSelect.createEl('option', { attr: { value: 'all' }, text: this.t('modal_query_preset_all') });
		for (const preset of PRESET_QUERIES) {
			presetSelect.createEl('option', { attr: { value: preset.key }, text: this.t(preset.key) });
		}
		presetSelect.addEventListener('change', () => {
			const val = presetSelect.value;
			if (val === 'all') {
				this.activeRelations = new Set([
					'causes', 'precedes', 'precondition_of',
					'supports', 'conflicts_with', 'contrasts_with',
					'exemplifies', 'applies_to', 'analogous_to', 'isomorphic_to',
				]);
			} else {
				const found = PRESET_QUERIES.find(p => p.key === val);
				if (found) this.activeRelations = new Set(found.relations);
			}
			this.querySpec = null;
		});

		// ── AI 자연어 쿼리 ───────────────────────────────
		container.createEl('div', { cls: 'tb-popup-select-label', text: this.t('modal_query_ai_label') });
		const customRow = container.createEl('div', { cls: 'tb-popup-select-row' });
		const aiInput = customRow.createEl('textarea', {
			cls: 'tb-intent-custom',
			attr: { placeholder: this.t('modal_query_ai_placeholder'), rows: '2' },
		});

		const aiFooterRow = container.createEl('div', { cls: 'tb-popup-select-row' });
		const aiBtn = aiFooterRow.createEl('button', { cls: 'tb-btn', text: this.t('modal_query_ai_btn') });
		const aiStatus = aiFooterRow.createEl('div', { cls: 'tb-gvm-ai-status' });

		aiBtn.addEventListener('click', () => void (async () => {
			const prompt = aiInput.value.trim();
			if (!prompt) return;
			aiBtn.disabled = true;
			aiStatus.setText(this.t('modal_query_ai_running'));
			const selected = checkboxes.filter(c => c.cb.checked).map(c => c.folder);
			const target = selected.length > 0 ? selected : this.folders;
			const allNodes = (await Promise.all(target.map(f => this.store.loadNodesInFolder(f)))).flat();
			const spec = await parseGraphQuery(prompt, allNodes.map(n => ({ title: n.title, type: n.type })), this.settings);
			this.querySpec = spec;
			this.activeRelations = new Set(spec.relations);
			const matched = PRESET_QUERIES.find(p =>
				p.relations.length === spec.relations.length &&
				p.relations.every(r => this.activeRelations.has(r))
			);
			presetSelect.value = matched ? matched.key : 'all';
			const labelStr = spec.relations.map(r => relLabel(r, this.lang)).join(', ');
			aiStatus.setText(labelStr + (spec.startNodeTitle ? ` · BFS: ${spec.startNodeTitle}` : ''));
			aiBtn.disabled = false;
		})());

		// ── 하단 버튼 ─────────────────────────────────────
		const footer = container.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_cancel') })
			.addEventListener('click', () => this.close());
		footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_open_graph') })
			.addEventListener('click', () => {
				const selected = checkboxes.filter(c => c.cb.checked).map(c => c.folder);
				if (selected.length === 0) { new Notice(this.t('notice_select_folder')); return; }
				void this.onCanvas(selected, new Set(this.activeRelations));
				this.close();
			});
	}

	private buildDownloadPane(container: HTMLElement) {
		container.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_graph_download_sub') });

		container.createEl('div', { cls: 'tb-popup-select-label', text: this.t('analysis_folder_label') });
		const checkboxes = this.buildFolderList(container);

		// ── 옵션 섹션 ──────────────────────────────────
		container.createEl('div', { cls: 'tb-popup-select-label', text: 'Export Options' });
		const optionsRow = container.createEl('div', { cls: 'tb-popup-options-section' });

		// 원본 텍스트 포함 (기본값: true)
		const sourceLabel = optionsRow.createEl('label', { cls: 'tb-popup-checkbox-row' });
		const sourceCb = sourceLabel.createEl('input', { attr: { type: 'checkbox' } });
		sourceCb.checked = true;
		sourceCb.addClass('tb-popup-cb');
		sourceLabel.createEl('span', { text: this.t('graph_export_option_source') });

		// 메타데이터 포함
		const metaLabel = optionsRow.createEl('label', { cls: 'tb-popup-checkbox-row' });
		const metaCb = metaLabel.createEl('input', { attr: { type: 'checkbox' } });
		metaCb.checked = true;
		metaCb.addClass('tb-popup-cb');
		metaLabel.createEl('span', { text: this.t('graph_export_option_metadata') });

		// 최대 텍스트 길이 입력
		const lengthRow = optionsRow.createEl('div', { cls: 'tb-popup-input-row' });
		lengthRow.createEl('label', { cls: 'tb-popup-select-label', text: this.t('graph_export_option_length') });
		const lengthInput = lengthRow.createEl('input', {
			cls: 'tb-popup-input',
			attr: { type: 'number', value: '500', min: '0', placeholder: '0 = unlimited' },
		});

		// 하단 버튼
		const footer = container.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_cancel') })
			.addEventListener('click', () => this.close());

		const exportBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('graph_export_btn') });
		exportBtn.addEventListener('click', () => void (async () => {
			const selected = checkboxes.filter(c => c.cb.checked).map(c => c.folder);
			if (selected.length === 0) {
				new Notice(this.t('notice_select_folder'));
				return;
			}

			exportBtn.disabled = true;
			exportBtn.setText(this.t('graph_export_exporting'));

			try {
				const maxLength = parseInt(lengthInput.value) || undefined;
				const exporter = new GraphExporter();
				const content = await exporter.exportFolderGraph(selected, this.store, {
					includeSourceText: sourceCb.checked,
					includeMetadata: metaCb.checked,
					maxTextLength: maxLength,
				});

				if (content.trim().length === 0) {
					new Notice(this.t('graph_export_empty'));
				} else {
					// 의미있는 파일명: 폴더이름_[content]_날짜.md
					const folderName = selected.map(f => f.split('/').pop()).join('-');
					const dateStr = new Date().toISOString().split('T')[0];
					const contentLabel = sourceCb.checked ? '_content' : '';
					const filename = `graph_${folderName}${contentLabel}_${dateStr}.md`;
					GraphExporter.downloadFile(content, filename);
					new Notice(this.t('graph_export_success'));
				}

				this.close();
			} catch (e) {
				new Notice(`Error: ${String(e)}`);
			} finally {
				exportBtn.disabled = false;
				exportBtn.setText(this.t('graph_export_btn'));
			}
		})());
	}

	// ── [v0.3.5] 그래프 삭제 탭 — 폴더 선택 → 대상 집계 → 확인 → 휴지통 ──
	private buildDeletePane(container: HTMLElement) {
		const ko = this.lang !== 'en';
		container.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_graph_delete_sub') });

		container.createEl('div', { cls: 'tb-popup-select-label', text: this.t('analysis_folder_label') });
		const checkboxes = this.buildFolderList(container);

		const previewEl = container.createEl('div', { cls: 'tb-delete-preview' });
		let pendingTargets: TFile[] = [];
		let pendingFolders: string[] = [];

		const footer = container.createEl('div', { cls: 'tb-popup-footer' });
		const scanBtn = footer.createEl('button', { cls: 'tb-btn', text: ko ? '삭제 대상 확인' : 'Scan targets' });
		const deleteBtn = footer.createEl('button', { cls: 'tb-btn tb-btn-danger', text: ko ? '휴지통으로 이동' : 'Move to trash' });
		deleteBtn.disabled = true;

		scanBtn.addEventListener('click', () => void (async () => {
			const selected = checkboxes.filter(c => c.cb.checked).map(c => c.folder);
			if (selected.length === 0) { new Notice(this.t('notice_select_folder')); return; }
			scanBtn.disabled = true;
			previewEl.empty();
			previewEl.createEl('div', { cls: 'tb-mission-sub', text: ko ? '집계 중…' : 'Scanning…' });
			try {
				pendingTargets = await this.store.collectGraphDeletionTargets(selected);
				pendingFolders = selected;
				previewEl.empty();
				if (pendingTargets.length === 0) {
					previewEl.createEl('div', { cls: 'tb-mission-sub', text: ko ? '삭제할 파일이 없습니다.' : 'Nothing to delete.' });
					deleteBtn.disabled = true;
					return;
				}
				previewEl.createEl('div', {
					cls: 'tb-delete-count',
					text: ko
						? `⚠ 폴더 통째 + ${pendingTargets.length}개 파일이 휴지통으로 이동됩니다 (노드·raw 원본·요약 포함, 복구 가능)`
						: `⚠ Folder itself + ${pendingTargets.length} files will be trashed (nodes, raw originals & summaries — recoverable)`,
				});
				const list = previewEl.createEl('div', { cls: 'tb-delete-list' });
				for (const f of pendingTargets.slice(0, 12)) {
					list.createEl('div', { cls: 'tb-delete-item', text: f.path });
				}
				if (pendingTargets.length > 12) {
					list.createEl('div', { cls: 'tb-delete-item', text: `… +${pendingTargets.length - 12}` });
				}
				deleteBtn.disabled = false;
			} finally {
				scanBtn.disabled = false;
			}
		})());

		deleteBtn.addEventListener('click', () => void (async () => {
			if (pendingTargets.length === 0) return;
			deleteBtn.disabled = true;
			scanBtn.disabled = true;
			const n = await this.store.deleteGraphTargets(pendingTargets, pendingFolders);
			new Notice(ko ? `[ThirdBrain] ${n}개 파일을 휴지통으로 이동했습니다.` : `[ThirdBrain] Moved ${n} files to trash.`);
			this.close();
		})());
	}

	onClose() { this.contentEl.empty(); }
}
