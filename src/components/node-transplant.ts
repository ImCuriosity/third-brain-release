import { App, Modal, Notice, TFile, normalizePath, sanitizeHTMLToDom } from 'obsidian';
import type ThirdBrainPlugin from '../main';
import { GraphStore } from '../engine/graph-store';
import type { TBFrontMatter } from '../engine/graph-store';
import { bridgeFolders } from '../engine/serial-pipeline';
import { toRelation } from '../types';
import type { TBEdge } from '../types';
import { SOOTBALL_LOGO } from '../sootball';
import { ThirdBrainView, VIEW_TYPE } from '../view';

// ── 유틸 ─────────────────────────────────────────────────

function makeDraggable(modal: HTMLElement, handle: HTMLElement) {
	let ox = 0, oy = 0;
	handle.addClass('tb-draggable-handle');
	handle.addEventListener('mousedown', (e) => {
		e.preventDefault();
		ox = modal.offsetLeft - e.clientX;
		oy = modal.offsetTop  - e.clientY;
		const onMove = (ev: MouseEvent) => {
			modal.setCssStyles({ left: `${ev.clientX + ox}px`, top: `${ev.clientY + oy}px` });
		};
		const onUp = () => {
			activeDocument.removeEventListener('mousemove', onMove);
			activeDocument.removeEventListener('mouseup', onUp);
		};
		activeDocument.addEventListener('mousemove', onMove);
		activeDocument.addEventListener('mouseup', onUp);
	});
}

function isTBNode(app: App, file: TFile): boolean {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return !!(fm?.tb_id);
}

// ── NodeTransplantModal ──────────────────────────────────

export class NodeTransplantModal extends Modal {
	private plugin: ThirdBrainPlugin;
	private store: GraphStore;
	private folders: string[];

	constructor(app: App, plugin: ThirdBrainPlugin, folders: string[]) {
		super(app);
		this.plugin = plugin;
		this.store  = new GraphStore(app, plugin.settings);
		this.folders = folders;
		this.modalEl.addClass('tb-popup');
		this.modalEl.addClass('tb-transplant-modal');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: '📥 노드 이식' });
		makeDraggable(this.modalEl, titleEl);
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: '파일을 선택하면 자동으로 처리 방식을 결정합니다.' });

		// ── Step 1: 소스 파일 선택 ───────────────────────
		const step1 = contentEl.createEl('div', { cls: 'tb-transplant-section' });
		step1.createEl('div', { cls: 'tb-transplant-label', text: '1. 이식할 파일 선택' });

		const fileSearch = step1.createEl('input', {
			cls: 'tb-transplant-search',
			attr: { type: 'text', placeholder: '파일명 검색 (비우면 폴더 트리)...' },
		});

		const fileList = step1.createEl('div', { cls: 'tb-transplant-file-list' });
		let selectedFile: TFile | null = null;

		// 파일 선택 시 TB 노드 여부 배지 표시
		const modeEl = step1.createEl('div', { cls: 'tb-transplant-mode-badge' });
		modeEl.hide();

		const allMdFiles = this.app.vault.getMarkdownFiles()
			.sort((a, b) => {
				const pa = a.parent?.path ?? '';
				const pb = b.parent?.path ?? '';
				if (pa !== pb) return pa.localeCompare(pb);
				return a.basename.localeCompare(b.basename);
			});

		const selectFile = (f: TFile, nameEl: HTMLElement) => {
			selectedFile = f;
			fileList.querySelectorAll('.tb-transplant-file-item').forEach(el => {
				el.removeClass('is-selected');
				el.querySelector<HTMLElement>('.tb-transplant-file-name')?.classList.remove('is-selected');
			});
			nameEl.closest('.tb-transplant-file-item')?.addClass('is-selected');
			nameEl.classList.add('is-selected');

			const isTB = isTBNode(this.app, f);
			modeEl.show();
			modeEl.removeClass('is-tb', 'is-raw');
			modeEl.addClass(isTB ? 'is-tb' : 'is-raw');
			modeEl.textContent = isTB
				? '🔷 TB 노드 — 이동 후 브릿지 연결 탐색'
				: '📄 일반 노트 — 전체 인제스트 파이프라인 실행';
		};

		// 메타데이터 캐시 조회 — 순수 메모리, I/O 없음
		const fileIcon = (f: TFile) => isTBNode(this.app, f) ? '🔷' : '📄';

		const makeFileItem = (
			container: HTMLElement,
			f: TFile,
			extraCls?: string,
			indentPx?: number
		) => {
			const item = container.createEl('div', { cls: `tb-transplant-file-item${extraCls ? ' ' + extraCls : ''}` });
			if (indentPx !== undefined) item.setCssStyles({ paddingLeft: `${indentPx}px` });
			item.createEl('span', { cls: 'tb-transplant-file-icon', text: fileIcon(f) });
			const nameEl = item.createEl('span', { cls: 'tb-transplant-file-name', text: f.basename });
			item.addEventListener('click', () => selectFile(f, nameEl));
		};

		const renderFolderTree = () => {
			fileList.empty();
			const groups = new Map<string, TFile[]>();
			for (const f of allMdFiles) {
				const folder = f.parent?.path ?? '';
				if (!groups.has(folder)) groups.set(folder, []);
				groups.get(folder)!.push(f);
			}

			for (const f of (groups.get('') ?? [])) {
				makeFileItem(fileList, f, 'tb-transplant-root-file');
			}

			for (const folder of [...groups.keys()].filter(k => k !== '').sort()) {
				const files = groups.get(folder)!;
				const depth = folder.split('/').length - 1;

				const folderRow = fileList.createEl('div', { cls: 'tb-transplant-folder-row' });
				folderRow.setCssStyles({ paddingLeft: `${10 + depth * 14}px` });
				const chevron = folderRow.createEl('span', { cls: 'tb-transplant-folder-chevron', text: '▶' });
				folderRow.createEl('span', { text: '📁 ' + (folder.split('/').pop() ?? folder) });
				folderRow.createEl('span', {
					cls: 'tb-transplant-folder-count',
					text: ` (${files.length})`,
				});

				const filesEl = fileList.createEl('div', { cls: 'tb-transplant-folder-files' });
				for (const f of files) {
					makeFileItem(filesEl, f, undefined, 24 + depth * 14);
				}

				folderRow.addEventListener('click', () => {
					const isOpen = filesEl.hasClass('is-open');
					filesEl.toggleClass('is-open', !isOpen);
					chevron.textContent = isOpen ? '▶' : '▼';
					chevron.toggleClass('is-open', !isOpen);
				});
			}

			if (allMdFiles.length === 0) {
				fileList.createEl('div', { cls: 'tb-transplant-empty', text: 'vault에 .md 파일이 없습니다.' });
			}
		};

		const renderSearch = (query: string) => {
			fileList.empty();
			const q = query.toLowerCase();
			const filtered = allMdFiles.filter(f =>
				f.basename.toLowerCase().includes(q) ||
				(f.parent?.path ?? '').toLowerCase().includes(q)
			).slice(0, 50);

			for (const f of filtered) {
				const item = fileList.createEl('div', { cls: 'tb-transplant-file-item tb-transplant-root-file' });
				item.createEl('span', { cls: 'tb-transplant-file-icon', text: fileIcon(f) });
				const nameEl = item.createEl('span', { cls: 'tb-transplant-file-name', text: f.basename });
				item.createEl('span', { cls: 'tb-transplant-file-path', text: f.parent?.path ?? '' });
				item.addEventListener('click', () => selectFile(f, nameEl));
			}
			if (filtered.length === 0) {
				fileList.createEl('div', { cls: 'tb-transplant-empty', text: '검색 결과 없음' });
			}
		};

		renderFolderTree();
		fileSearch.addEventListener('input', () => {
			const q = fileSearch.value.trim();
			if (q) renderSearch(q);
			else renderFolderTree();
		});

		// ── Step 2: 대상 폴더 선택 ───────────────────────
		const step2 = contentEl.createEl('div', { cls: 'tb-transplant-section' });
		step2.createEl('div', { cls: 'tb-transplant-label', text: '2. 대상 폴더 선택' });

		const folderSelect = step2.createEl('select', { cls: 'tb-transplant-folder-select' });
		folderSelect.createEl('option', { value: '', text: '🏠 루트 (최상위)' });
		for (const folder of this.folders) {
			const depth = folder.split('/').length - 1;
			const indent = '　'.repeat(depth);
			folderSelect.createEl('option', { value: folder, text: `${indent}📁 ${folder}` });
		}

		// ── 실행 버튼 ────────────────────────────────────
		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: '취소' })
			.addEventListener('click', () => this.close());

		const runBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: '▶ 실행' });
		runBtn.addEventListener('click', () => {
			if (!selectedFile) {
				new Notice('[ThirdBrain] 파일을 선택하세요.');
				return;
			}
			void this.run(selectedFile, folderSelect.value, contentEl, footer);
		});
	}

	// ── 분기 실행 ────────────────────────────────────────

	private async run(
		file: TFile,
		targetFolder: string,
		contentEl: HTMLElement,
		footer: HTMLElement
	) {
		const isTB = isTBNode(this.app, file);
		footer.remove();

		const loadingEl = contentEl.createEl('div', { cls: 'tb-loading-overlay' });
		const sootEl = loadingEl.createEl('div', { cls: 'tb-loading-sootball' });
		sootEl.appendChild(sanitizeHTMLToDom(SOOTBALL_LOGO));
		const statusEl = loadingEl.createEl('div', { cls: 'tb-loading-status' });
		const setStatus = (msg: string) => { statusEl.textContent = msg; };

		if (isTB) {
			await this.runBridge(file, targetFolder, loadingEl, setStatus, contentEl);
		} else {
			await this.runIngest(file, targetFolder, loadingEl, setStatus);
		}
	}

	// ── Case A: 일반 .md → 인제스트 파이프라인 ──────────

	private async runIngest(
		file: TFile,
		targetFolder: string,
		loadingEl: HTMLElement,
		setStatus: (msg: string) => void
	) {
		setStatus('파일 읽는 중...');
		const raw  = await this.app.vault.read(file);
		const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim();

		if (!body) {
			loadingEl.remove();
			new Notice('[ThirdBrain] 파일 내용이 비어 있습니다.');
			return;
		}

		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		const view = leaves[0]?.view as ThirdBrainView | undefined;

		if (!view) {
			loadingEl.remove();
			new Notice('[ThirdBrain] ThirdBrain 패널이 열려있지 않습니다.');
			return;
		}

		setStatus('인제스트 파이프라인 시작...');
		this.close();
		await view.ingestContent(body, targetFolder);
	}

	// ── Case B: TB 노드 → 이동 + 브릿지 ─────────────────

	private async runBridge(
		file: TFile,
		targetFolder: string,
		loadingEl: HTMLElement,
		setStatus: (msg: string) => void,
		contentEl: HTMLElement
	) {
		setStatus('노드 이동 중...');

		// 파일 이동
		const targetPath = await this.resolveConflict(
			normalizePath(targetFolder ? `${targetFolder}/${file.name}` : file.name)
		);
		try {
			await this.app.fileManager.renameFile(file, targetPath);
		} catch (e) {
			loadingEl.remove();
			new Notice(`[ThirdBrain] 파일 이동 실패: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		const movedFile = this.app.vault.getFileByPath(targetPath);
		if (!movedFile) {
			loadingEl.remove();
			new Notice('[ThirdBrain] 이동된 파일을 찾을 수 없습니다.');
			return;
		}

		setStatus('노드 로드 중...');
		const movedNode = await this.store.fileToNode(movedFile);
		if (!movedNode) {
			loadingEl.remove();
			new Notice('[ThirdBrain] 노드 메타데이터를 읽을 수 없습니다.');
			return;
		}

		setStatus('대상 폴더 노드 탐색 중...');
		const targetNodes = (await this.store.loadNodesInFolder(targetFolder))
			.filter(n => n.filePath !== movedFile.path);

		if (targetNodes.length === 0) {
			loadingEl.remove();
			new Notice(`✅ 이식 완료: ${movedFile.basename} (연결 후보 없음)`);
			this.close();
			void this.app.workspace.getLeaf('tab').openFile(movedFile);
			return;
		}

		setStatus(`브릿지 분석 중... (${targetNodes.length}개 노드)`);
		let result: import('../types').FolderBridgeResult;
		try {
			result = await bridgeFolders(
				[movedNode],
				targetNodes,
				movedNode.title,
				targetFolder || '루트',
				this.plugin.settings,
				{ topKPerNode: 4, useConfirmedEdgesOnly: false },
				setStatus
			);
		} catch (e) {
			loadingEl.remove();
			new Notice(`[ThirdBrain] 브릿지 분석 실패: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		loadingEl.remove();
		this.renderBridgeResult(contentEl, movedFile, result);
	}

	// ── 브릿지 결과 UI ───────────────────────────────────

	private renderBridgeResult(
		contentEl: HTMLElement,
		movedFile: TFile,
		result: import('../types').FolderBridgeResult
	) {
		const preview = contentEl.createEl('div', { cls: 'tb-transplant-preview' });

		if (result.insight) {
			const insightEl = preview.createEl('div', { cls: 'tb-transplant-insight' });
			insightEl.createEl('span', { cls: 'tb-transplant-insight-label', text: '브릿지 인사이트' });
			insightEl.createEl('p', { text: result.insight });
		}

		const selectedEdges: TBEdge[] = [];

		if (result.edges.length > 0) {
			preview.createEl('div', { cls: 'tb-transplant-label', text: '연결 추천 (선택 후 확정)' });
			const chipRow = preview.createEl('div', { cls: 'tb-edge-chips' });

			for (const e of result.edges) {
				const chip = chipRow.createEl('div', { cls: 'tb-chip' });
				const top  = chip.createEl('div', { cls: 'tb-chip-top' });
				const icon = top.createEl('span', { cls: 'tb-chip-icon', text: '◎' });
				// source_file = 이식된 노드, target_file = 대상 노드
				const label = `${e.source_file} ─${e.relation}→ ${e.target_file}`;
				top.createEl('span', { cls: 'tb-chip-target', text: label });
				chip.createEl('div', { cls: 'tb-chip-reason', text: e.reason });

				let on = false;
				chip.addEventListener('click', () => {
					on = !on;
					chip.toggleClass('is-selected', on);
					icon.textContent = on ? '✓' : '◎';
					if (on) {
						selectedEdges.push({
							target: `[[${e.target_file.replace(/\.md$/, '')}]]`,
							label: toRelation(e.relation),
							confirmed: true,
							reason: e.reason,
							confidence: e.confidence ?? 1.0,
							axiom_basis: e.axiom_basis,
						});
					} else {
						const idx = selectedEdges.findIndex(
							se => se.target === `[[${e.target_file.replace(/\.md$/, '')}]]`
						);
						if (idx >= 0) selectedEdges.splice(idx, 1);
					}
				});
			}
		} else {
			preview.createEl('div', { cls: 'tb-transplant-empty',
				text: '위상학적 유사도가 낮아 연결 후보를 찾지 못했습니다.' });
		}

		const footer = preview.createEl('div', { cls: 'tb-popup-footer' });
		const confirmBtn = footer.createEl('button', {
			cls: 'tb-btn is-primary',
			text: result.edges.length > 0 ? '✓ 선택 연결 저장' : '✓ 완료',
		});
		footer.createEl('button', { cls: 'tb-btn', text: '취소' })
			.addEventListener('click', () => this.close());

		confirmBtn.addEventListener('click', () => {
			confirmBtn.disabled = true;
			void this.saveEdgesAndOpen(movedFile, selectedEdges, confirmBtn);
		});
	}

	// ── 엣지 저장 + 파일 오픈 ────────────────────────────

	private async saveEdgesAndOpen(
		movedFile: TFile,
		selectedEdges: TBEdge[],
		confirmBtn: HTMLButtonElement
	) {
		try {
			// 이식된 노드에 선택된 엣지 주입 — 단방향.
			// 역방향에 같은 라벨을 쓰면 방향성 관계에서 "A→B ∧ B→A" 논리 모순이 생긴다.
			// 위키링크로 네이티브 그래프·백링크에는 양쪽 모두 보인다.
			if (selectedEdges.length > 0) {
				await this.app.fileManager.processFrontMatter(movedFile, (fm: TBFrontMatter) => {
					const existing: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
					for (const e of selectedEdges) {
						if (!existing.find(ex => ex.target === e.target)) existing.push(e);
					}
					fm.tb_edges = existing;
					fm.tb_links = existing.map(e => e.target);
				});
			}

			new Notice(`✅ 이식 완료: ${movedFile.basename}`);
			this.close();
			void this.app.workspace.getLeaf('tab').openFile(movedFile);
		} catch (e) {
			confirmBtn.disabled = false;
			confirmBtn.textContent = '✓ 선택 연결 저장';
			new Notice(`[ThirdBrain] 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async resolveConflict(filePath: string): Promise<string> {
		if (!this.app.vault.getFileByPath(filePath)) return filePath;
		const base = filePath.replace(/\.md$/, '');
		let i = 2;
		while (this.app.vault.getFileByPath(`${base}-${i}.md`)) i++;
		return `${base}-${i}.md`;
	}

	onClose() { this.contentEl.empty(); }
}
