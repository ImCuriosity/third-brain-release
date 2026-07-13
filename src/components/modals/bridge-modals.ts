import { App, Modal, Notice, TFile } from 'obsidian';
import { getT } from '../../i18n';
import type { TKey, Lang } from '../../i18n';
import { GraphStore } from '../../engine/graph-store';
import type { TBFrontMatter } from '../../engine/graph-store';
import { toRelation } from '../../types';
import type { TBNode, TBEdge, FolderBridgeResult, BridgeEdge } from '../../types';
import { makeDraggable, relLabel, shortText } from './shared';

// ── 폴더 브리지 모달 ──────────────────────────────────────
export class BridgeModal extends Modal {
	private lang: Lang;

	constructor(
		app: App,
		private readonly folders: string[],
		private readonly onRun: (a: string[], b: string[]) => void,
		lang?: Lang,
	) {
		super(app);
		this.lang = lang ?? 'en';
		this.modalEl.addClass('tb-popup');
	}

	private t(key: TKey): string { return getT(this.lang)(key); }

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const bridgeTitleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_bridge_title') });
		makeDraggable(this.modalEl, bridgeTitleEl);
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_bridge_sub') });

		// raw 폴더 제외
		const eligible = this.folders.filter(f => {
			const parts = f.split('/');
			return !parts.some(p => p === 'raw');
		});

		const cols = contentEl.createEl('div', { cls: 'tb-popup-bridge-cols' });

		type ColEntry = { folder: string; cb: HTMLInputElement; labelEl: HTMLElement };

		const buildCol = (colLabel: string): { entries: ColEntry[]; getSelected: () => string[] } => {
			const col = cols.createEl('div', { cls: 'tb-popup-bridge-col' });
			col.createEl('div', { cls: 'tb-popup-bridge-col-label', text: colLabel });
			const list = col.createEl('div', { cls: 'tb-popup-folder-list' });
			const entries: ColEntry[] = [];
			for (const f of eligible) {
				const depth = f.split('/').length - 1;
				const name = f.split('/').pop() ?? f;
				const labelEl = list.createEl('label', { cls: 'tb-popup-folder-item' });
				labelEl.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
				const cb = labelEl.createEl('input', { attr: { type: 'checkbox' } });
				cb.addClass('tb-popup-cb');
				labelEl.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
				labelEl.createEl('span', { cls: 'tb-popup-folder-name', text: name });
				entries.push({ folder: f, cb, labelEl });
			}
			return { entries, getSelected: () => entries.filter(e => e.cb.checked).map(e => e.folder) };
		};

		const colAData = buildCol(this.t('bridge_col_a'));
		const colBData = buildCol(this.t('bridge_col_b'));

		// 상호 배제 + 하위 폴더 cascade
		const syncExclusion = (
			changed: ColEntry[], other: ColEntry[], idx: number, checked: boolean
		) => {
			const folder = changed[idx].folder;
			// 하위 폴더 cascade
			for (let j = idx + 1; j < changed.length; j++) {
				if (changed[j].folder.startsWith(folder + '/')) changed[j].cb.checked = checked;
			}
			// 반대편 동일 폴더 비활성화/활성화
			for (const o of other) {
				const isConflict = changed.filter(e => e.cb.checked).some(e =>
					o.folder === e.folder || o.folder.startsWith(e.folder + '/') || e.folder.startsWith(o.folder + '/')
				);
				o.cb.disabled = isConflict;
				o.labelEl.toggleClass('is-disabled', isConflict);
				if (isConflict) o.cb.checked = false;
			}
		};

		for (let i = 0; i < colAData.entries.length; i++) {
			colAData.entries[i].cb.addEventListener('change', () =>
				syncExclusion(colAData.entries, colBData.entries, i, colAData.entries[i].cb.checked));
		}
		for (let i = 0; i < colBData.entries.length; i++) {
			colBData.entries[i].cb.addEventListener('change', () =>
				syncExclusion(colBData.entries, colAData.entries, i, colBData.entries[i].cb.checked));
		}

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_cancel') })
			.addEventListener('click', () => this.close());
		footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_bridge_run') })
			.addEventListener('click', () => {
				const a = colAData.getSelected();
				const b = colBData.getSelected();
				if (a.length === 0 || b.length === 0) { new Notice(this.t('notice_select_two_folders')); return; }
				this.close();
				this.onRun(a, b);
			});
	}

	onClose() { this.contentEl.empty(); }
}

// ── 브리지 결과 모달 ──────────────────────────────────────
export class BridgeResultModal extends Modal {
	private lang: Lang;
	private _t: (key: TKey) => string;

	constructor(
		app: App,
		private result: FolderBridgeResult,
		private fileMapA: Map<string, TFile>,
		private fileMapB: Map<string, TFile>,
		private folderAName: string,
		private folderBName: string,
		private store: GraphStore,
		lang: Lang | undefined,
		private openGraph: (folders: string[]) => void
	) {
		super(app);
		this.lang = lang ?? 'en';
		this._t = getT(this.lang);
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this._t('modal_bridge_title') });
		contentEl.createEl('div', { cls: 'tb-bridge-modal-sub', text: `${this.folderAName}  ↔  ${this.folderBName}` });

		if (this.result.insight) {
			contentEl.createEl('div', { cls: 'tb-bridge-insight', text: this.result.insight });
		}

		if (this.result.edges.length === 0) {
			contentEl.createEl('div', { cls: 'tb-empty', text: this._t('label_no_edges') });
			contentEl.createEl('button', { cls: 'tb-btn is-primary', text: this._t('btn_close') })
				.addEventListener('click', () => this.close());
			return;
		}

		// confidence ≥ 0.6 만 표시, ≥ 0.75 는 미리 선택
		const visibleEdges = this.result.edges.filter(e => (e.confidence ?? 0) >= 0.6);

		let bridgeLocked = false;
		type BState = { edge: BridgeEdge; selected: boolean };
		const states: BState[] = [];
		let chipRow: HTMLElement | null = null;

		if (visibleEdges.length > 0) {
			contentEl.createEl('div', { cls: 'tb-hint', text: this._t('label_edge_save_hint') });

			chipRow = contentEl.createEl('div', { cls: 'tb-edge-chips' });

			for (const edge of visibleEdges) {
				const rel = relLabel(edge.relation, this.lang);
				const pct = Math.round((edge.confidence ?? 0.5) * 100);
				const srcLabel = edge.source_title ?? edge.source_file.replace(/\.md$/, '');
				const tgtLabel = edge.target_title ?? edge.target_file.replace(/\.md$/, '');
				const preSelected = (edge.confidence ?? 0) >= 0.75;

				const chip = chipRow.createEl('div', { cls: `tb-chip${preSelected ? ' is-selected' : ''}` });
				const top = chip.createEl('div', { cls: 'tb-chip-top' });
				const icon = top.createEl('span', { cls: 'tb-chip-icon', text: preSelected ? '✓' : '◎' });
				top.createEl('span', { cls: 'tb-chip-conf', text: `[${pct}%]` });
				top.createEl('span', { cls: 'tb-chip-source', text: shortText(srcLabel, 14) });
				top.createEl('span', { cls: 'tb-chip-arrow', text: ` ―${rel}→ ` });
				top.createEl('span', { cls: 'tb-chip-target', text: tgtLabel });
				if (edge.reason) chip.createEl('div', { cls: 'tb-chip-reason', text: edge.reason });

				const state: BState = { edge, selected: preSelected };
				states.push(state);
				chip.addEventListener('click', () => {
					if (bridgeLocked) return;
					state.selected = !state.selected;
					chip.toggleClass('is-selected', state.selected);
					icon.textContent = state.selected ? '✓' : '◎';
				});
			}
		}

		const footer = contentEl.createEl('div', { cls: 'tb-bridge-modal-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this._t('btn_close') })
			.addEventListener('click', () => this.close());

		if (states.length > 0) {
			const saveBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: this._t('btn_save_connection') });
			saveBtn.addEventListener('click', () => void (async () => {
				const toSave = states.filter(s => s.selected).map(s => s.edge);
				if (toSave.length === 0) { new Notice(this._t('notice_no_selection')); return; }
				bridgeLocked = true;
				saveBtn.disabled = true;
				saveBtn.textContent = this._t('btn_saving');
				try {
					await this.store.saveBridgeEdges(toSave, this.fileMapA, this.fileMapB);
					new Notice(`${this._t('notice_bridge_saved_prefix')}${toSave.length}${this._t('notice_bridge_saved_suffix')}`);
					chipRow?.addClass('is-locked');
					saveBtn.textContent = this.lang === 'ko'
						? `${toSave.length}개 저장 완료`
						: `${toSave.length} saved`;
					this.openGraph([this.folderAName, this.folderBName]);
				} catch (e) {
					bridgeLocked = false;
					saveBtn.disabled = false;
					saveBtn.textContent = this._t('btn_save_connection');
					new Notice(`${this._t('save_error_prefix')}${e instanceof Error ? e.message : String(e)}`);
				}
			})());
		}
	}

	onClose() { this.contentEl.empty(); }
}

// ── 단일 노드 연결 후보 팝업 ──────────────────────────────────
export class SingleNodeBridgeModal extends Modal {
	private lang: Lang;

	constructor(
		app: App,
		private movedFile: TFile,
		private sourceTitle: string,
		private candidates: Array<{ target_title: string; relation: string; confidence?: number; reason: string }>,
		private targetNodes: TBNode[],
		lang?: Lang,
	) {
		super(app);
		this.lang = lang ?? 'en';
		this.modalEl.addClass('tb-popup');
	}

	onOpen() {
		const { contentEl } = this;
		const t = getT(this.lang);
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: t('label_connect') });
		makeDraggable(this.modalEl, titleEl);
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: this.sourceTitle });

		const titleToFile = new Map<string, TFile>();
		for (const n of this.targetNodes) {
			const f = this.app.vault.getAbstractFileByPath(n.filePath);
			if (f instanceof TFile) titleToFile.set(n.title, f);
		}

		const saveSingleEdge = async (c: typeof this.candidates[0]) => {
			const targetFile = titleToFile.get(c.target_title);
			if (!targetFile) return;
			const fwd: TBEdge = { target: `[[${c.target_title}]]`, label: toRelation(c.relation), confirmed: true, reason: c.reason, confidence: c.confidence ?? 1.0, axiom_basis: '' };
			const bwd: TBEdge = { target: `[[${this.movedFile.basename}]]`, label: toRelation(c.relation), confirmed: true, reason: c.reason, confidence: c.confidence ?? 1.0, axiom_basis: '' };
			await this.app.fileManager.processFrontMatter(this.movedFile, (fm: TBFrontMatter) => {
				const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
				if (!edges.find(e => e.target === fwd.target)) edges.push(fwd);
				fm.tb_edges = edges; fm.tb_links = edges.map((e: TBEdge) => e.target);
			});
			await this.app.fileManager.processFrontMatter(targetFile, (fm: TBFrontMatter) => {
				const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
				if (!edges.find(e => e.target === bwd.target)) edges.push(bwd);
				fm.tb_edges = edges; fm.tb_links = edges.map((e: TBEdge) => e.target);
			});
		};

		// confidence ≥ 0.6 만 표시
		const visible = this.candidates.filter(c => (c.confidence ?? 0) >= 0.6);

		if (visible.length === 0) {
			contentEl.createEl('div', { cls: 'tb-popup-empty', text: t('label_no_edges') });
			const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
			footer.createEl('button', { cls: 'tb-btn', text: t('btn_close') })
				.addEventListener('click', () => this.close());
			return;
		}

		contentEl.createEl('div', { cls: 'tb-hint', text: t('label_edge_save_hint') });

		const chipRow = contentEl.createEl('div', { cls: 'tb-edge-chips' });
		type State = { c: { target_title: string; relation: string; confidence?: number; reason: string }; selected: boolean };
		const states: State[] = [];
		let locked = false;

		for (const c of visible) {
			const rel = relLabel(c.relation, this.lang);
			const pct = Math.round((c.confidence ?? 0.5) * 100);

			const chip = chipRow.createEl('div', { cls: 'tb-chip' });
			const top = chip.createEl('div', { cls: 'tb-chip-top' });
			const icon = top.createEl('span', { cls: 'tb-chip-icon', text: '◎' });
			top.createEl('span', { cls: 'tb-chip-conf', text: `[${pct}%]` });
			top.createEl('span', { cls: 'tb-chip-source', text: shortText(this.sourceTitle, 14) });
			top.createEl('span', { cls: 'tb-chip-arrow', text: ` ―${rel}→ ` });
			top.createEl('span', { cls: 'tb-chip-target', text: c.target_title });
			if (c.reason) chip.createEl('div', { cls: 'tb-chip-reason', text: c.reason });

			const state: State = { c, selected: false };
			states.push(state);
			chip.addEventListener('click', () => {
				if (locked) return;
				state.selected = !state.selected;
				chip.toggleClass('is-selected', state.selected);
				icon.textContent = state.selected ? '✓' : '◎';
			});
		}

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: t('btn_close') })
			.addEventListener('click', () => this.close());

		const saveBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: t('btn_save_connection') });
		saveBtn.addEventListener('click', () => void (async () => {
			const toSave = states.filter(s => s.selected);
			if (toSave.length === 0) { new Notice(t('notice_no_selection')); return; }
			locked = true;
			chipRow.addClass('is-locked');
			saveBtn.disabled = true;
			saveBtn.textContent = t('btn_saving');
			try {
				for (const { c } of toSave) await saveSingleEdge(c);
				new Notice(`${t('notice_auto_saved_prefix')}${toSave.length}${t('conn_saved_notice_suffix')}`);
				this.close();
			} catch (e) {
				locked = false;
				chipRow.removeClass('is-locked');
				saveBtn.disabled = false;
				saveBtn.textContent = t('btn_save_connection');
				new Notice(`${t('save_error_prefix')}${e instanceof Error ? e.message : String(e)}`);
			}
		})());
	}

	onClose() { this.contentEl.empty(); }
}
