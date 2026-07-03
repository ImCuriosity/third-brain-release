import { App, ItemView, Modal, Notice, TFile, WorkspaceLeaf, requestUrl, sanitizeHTMLToDom } from 'obsidian';
import type ThirdBrainPlugin from './main';
import { getT } from './i18n';
import type { TKey, Lang } from './i18n';
import { DONATE_QR_BASE64 } from './donate-qr';
import { SOOTBALL_LOGO, SOOTBALL_WAITING, SOOTBALL_HUNGRY } from './sootball';
import {
	CHUNK_SIZE,
	splitIntoChunks,
	extractContexts,
	extractPropositions,
	extractEdges,
	bridgeFolders,
	summarizeFolder,
	recommendTransplantEdges,
	findCrossConnections,
} from './engine/serial-pipeline';
import type { FolderDigestNode, CrossConnection } from './engine/serial-pipeline';
import { getSessionStats, setRequestUrl } from './engine/cli-bridge';
import { GraphStore } from './engine/graph-store';
import type { TBFrontMatter } from './engine/graph-store';
import { buildTensor, findPath, findTransitivePaths, addNodeToTensor } from './engine/adjacency-tensor';
import { detectConflicts } from './engine/contradiction-engine';
import { extractPdfText } from './engine/pdf-extractor';
import { extractActions, linkActionsToPropositions, rankEdgeRelations, parseGraphQuery, analyzeTranscriptNodes, type TranscriptAnalysisMode } from './engine/serial-pipeline';
import type { EdgeRank, GraphQuerySpec } from './engine/serial-pipeline';
import { GraphView, EDGE_COLOR } from './components/graph-view';
import { OrphanQueueModal } from './components/vault-lint';
import {
	toRelation,
} from './types';
import type {
	TBNode,
	TBEdge,
	TBEdgeRelation,
	ContextLayer,
	Insight,
	Proposition,
	LogicLayer,
	EdgeCandidate,
	BridgeEdge,
	FolderBridgeResult,
	SummaryResult,
	GraphPath,
	ConflictReport,
	ActionNode,
	ActionStatus,
	MeetingType,
	ThirdBrainSettings,
} from './types';

export const VIEW_TYPE = 'thirdbrain-view';

const RELATION_KO: Record<string, string> = {
	causes:          '유발',
	precedes:        '선행',
	conflicts_with:  '충돌',
	supports:        '뒷받침',
	precondition_of: '전제조건',
	exemplifies:     '예시',
	contrasts_with:  '대조',
	applies_to:      '적용',
	isomorphic_to:   '구조동형',
	analogous_to:    '유사',
};

function relLabel(relation: string, lang?: string): string {
	return lang === 'en' ? relation : (RELATION_KO[relation] ?? relation);
}

function progressBar(filled: number): string {
	const n = Math.max(0, Math.min(Math.round(filled), 10));
	return '[' + '='.repeat(n) + ' '.repeat(10 - n) + ']';
}

function sanitizeId(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim().slice(0, 50);
}

function shortText(s: string, max = 26): string {
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export class ThirdBrainView extends ItemView {
	private plugin: ThirdBrainPlugin;
	private store!: GraphStore;

	// 사용량 표시 엘리먼트
	private usageEl!: HTMLElement;

	// 인제스트 컨테이너
	private ingestContainer!: HTMLElement;
	private ingestTextarea!: HTMLTextAreaElement;
	private ingestBtn!: HTMLButtonElement;
	private analysisBtn!: HTMLButtonElement;
	private bridgeBtn!: HTMLButtonElement;
	private charCountEl!: HTMLElement;
	private fileCountEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private progressBarEl!: HTMLElement;
	private progressMsgEl!: HTMLElement;
	private stepLogEl!: HTMLElement;
	private pipelineModal: PipelineInfoModal | null = null;
	private resultsEl!: HTMLElement;
	private conflictBadgeEl!: HTMLElement;
	private orphanBadgeEl!: HTMLElement;

	// 전사본 분석 백그라운드 작업 상태 (모달 닫혀도 유지)
	private transcriptJob: { running: boolean; mode?: TranscriptAnalysisMode; result?: string; error?: string } | null = null;

	// 재분석용 문맥 캐시
	private _cachedContexts: ContextLayer[] | null = null;

	// 인제스트 소스 추적 (raw 폴더 박제용)
	private ingestSource: { kind: 'vault'; file: TFile } | { kind: 'external'; name: string } | { kind: 'paste' } | null = null;


	constructor(leaf: WorkspaceLeaf, plugin: ThirdBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return 'ThirdBrain'; }
	getIcon(): string { return 'sootball'; }

	private t(key: TKey): string { return getT(this.plugin.settings.lang)(key); }

	async onOpen() {
		// requestUrl 초기화 (Claude API/Gemini API용 - v0 호환)
		setRequestUrl(requestUrl);

		this.store = new GraphStore(this.app, this.plugin.settings);
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('tb-root');

		this.buildHeader(root);

		// 인제스트 컨테이너
		this.ingestContainer = root.createEl('div', { cls: 'tb-ingest-container' });

		// 입력 패널 래퍼 (드래그 리사이즈 대상)
		const inputPane = this.ingestContainer.createEl('div', { cls: 'tb-input-pane' });
		this.buildIngestPanel(inputPane);
		this.buildProgressBar(inputPane);
		this.syncIngestBtnState(); // 초기 빈 상태에서 버튼 비활성
		void this.refreshConflictBadge();
		void this.refreshOrphanBadge();

		this.resultsEl = this.ingestContainer.createEl('div', { cls: 'tb-results' });
	}

	async onClose() { /* no-op */ }

	// ── 헤더 ─────────────────────────────────────────────

	private buildHeader(root: HTMLElement) {
		const hdr = root.createEl('div', { cls: 'tb-header' });

		const titleRow = hdr.createEl('div', { cls: 'tb-header-title' });
		titleRow.createEl('span', { cls: 'tb-header-name', text: 'ThirdBrain' });

		// 후원 QR 버튼
		const donateWrap = titleRow.createEl('div', { cls: 'tb-donate-wrap' });
		const donateBtn = donateWrap.createEl('button', { cls: 'tb-donate-btn', text: '🍦' });
		const donatePopup = donateWrap.createEl('div', { cls: 'tb-donate-popup' });
		donatePopup.createEl('div', { cls: 'tb-donate-msg', text: this.t('donate_msg') });
		if (DONATE_QR_BASE64) {
			const img = donatePopup.createEl('img', { cls: 'tb-donate-qr', attr: { src: DONATE_QR_BASE64, alt: 'KakaoPay QR' } });
			img.draggable = false;
		}
		donateBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			donatePopup.toggleClass('is-visible', !donatePopup.hasClass('is-visible'));
		});
		this.registerDomEvent(activeDocument, 'click', () => donatePopup.removeClass('is-visible'), { passive: true });

		hdr.createEl('div', { cls: 'tb-header-subtitle', text: this.t('subtitle') });

		this.usageEl = hdr.createEl('div', { cls: 'tb-usage-bar', text: '─' });
	}

	// ── 인제스트 패널 ─────────────────────────────────────

	private buildIngestPanel(parent: HTMLElement) {
		const panel = parent.createEl('div', { cls: 'tb-ingest' });

		// 드롭존
		const dropZone = panel.createEl('div', { cls: 'tb-dropzone' });
		const faceEl = dropZone.createEl('div', { cls: 'tb-dropzone-face' });
		faceEl.appendChild(sanitizeHTMLToDom(SOOTBALL_WAITING));
		const dropLabel = dropZone.createEl('div', { cls: 'tb-dropzone-label', text: this.t('dropzone_label') });
		const fileInput = dropZone.createEl('input', {
			attr: { type: 'file', accept: '.md,.txt,.pdf', multiple: true },
		});
		fileInput.hide();
		const fileBtn = dropZone.createEl('button', { cls: 'tb-file-btn', text: this.t('file_btn') });
		fileBtn.addEventListener('click', () => fileInput.click());
		fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
		dropZone.createEl('div', { cls: 'tb-dropzone-raw-hint', text: this.t('dropzone_raw_hint') });

		// dragenter 카운터 — 자식 요소 이동 시 dragleave 오작동 방지
		let dragDepth = 0;
		const setFaceHungry = (hungry: boolean) => {
			faceEl.empty();
			faceEl.appendChild(sanitizeHTMLToDom(hungry ? SOOTBALL_HUNGRY : SOOTBALL_WAITING));
			dropLabel.textContent = hungry ? this.t('dropzone_hungry') : this.t('dropzone_label');
		};

		dropZone.addEventListener('dragenter', (e: DragEvent) => {
			e.preventDefault();
			if (dragDepth++ === 0) {
				dropZone.addClass('is-drag-over');
				setFaceHungry(true);
			}
		});
		dropZone.addEventListener('dragleave', () => {
			if (--dragDepth <= 0) {
				dragDepth = 0;
				dropZone.removeClass('is-drag-over');
				setFaceHungry(false);
			}
		});
		dropZone.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); });
		dropZone.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			dragDepth = 0;
			dropZone.removeClass('is-drag-over');
			setFaceHungry(false);
			this.handleFileDrop(e);
		});

		// OR 구분선
		const sep = panel.createEl('div', { cls: 'tb-or-sep' });
		sep.createEl('span', { cls: 'tb-or-line' });
		sep.createEl('span', { cls: 'tb-or-text', text: this.t('or_sep') });
		sep.createEl('span', { cls: 'tb-or-line' });

		// 텍스트에어리어
		this.ingestTextarea = panel.createEl('textarea', {
			cls: 'tb-ingest-textarea',
			attr: { placeholder: this.t('ingest_placeholder') },
		});

		// 글자수 표시
		this.charCountEl = panel.createEl('div', { cls: 'tb-char-count', text: `0${this.t('char_suffix')}` });
		this.ingestTextarea.addEventListener('input', () => {
			this.updateCharCount();
			this.syncIngestBtnState();
		});

		// 2×2 액션 버튼 그룹
		const actions = parent.createEl('div', { cls: 'tb-action-group' });

		this.ingestBtn = actions.createEl('button', { cls: 'tb-btn-primary', text: this.t('btn_generate') });
		this.ingestBtn.addEventListener('click', () => {
			void this.runIngest();
		});

		this.analysisBtn = actions.createEl('button', { cls: 'tb-btn-secondary', text: this.t('btn_analyze') });
		this.analysisBtn.addEventListener('click', () => {
			new AnalysisTabbedModal(
				this.app, this.getFolderPaths(), this.store,
				(folder, mode, intent, includeActions) => { void this.runFolderAnalysis(folder, mode, intent, includeActions); },
				this.plugin.settings.lang,
				this.plugin.settings,
				this.transcriptJob,
				(job) => {
					this.transcriptJob = job;
					this.setAIBusy(job?.running ?? false);
				},
				() => this._busyAI || this._busyIngest || this._busyBridge,
			).open();
		});

		const graphBtn = actions.createEl('button', { cls: 'tb-btn-secondary', text: this.t('btn_graph') });
		graphBtn.addEventListener('click', () => {
			new GraphViewModal(
				this.app,
				this.getFolderPaths(),
				(f, exc) => { void this.openNativeGraph(f, exc); },
				async (folders, relSet) => {
					const allNodes = (await Promise.all(folders.map(f => this.store.loadNodesInFolder(f)))).flat();
					new GraphCanvasModal(this.app, allNodes, relSet, this.plugin.settings.lang ?? 'en').open();
				},
				this.store,
				this.plugin.settings,
			).open();
		});

		this.bridgeBtn = actions.createEl('button', { cls: 'tb-btn-secondary', text: this.t('btn_bridge') });
		this.bridgeBtn.addEventListener('click', () => {
			new BridgeModal(this.app, this.getFolderPaths(), (a, b) => { void this.runBridgeWithFolders(a, b); }, this.plugin.settings.lang).open();
		});


		this.fileCountEl = actions.createEl('div', { cls: 'tb-file-count', text: this.vaultCountText() });

		// 미해소 모순 배지 (모순이 있을 때만 표시)
		this.conflictBadgeEl = parent.createEl('button', { cls: 'tb-conflict-badge' });
		this.conflictBadgeEl.hide();
		this.conflictBadgeEl.addEventListener('click', () => {
			new ManualConflictModal(
				this.app, this.store, this.plugin.settings,
				() => { void this.refreshConflictBadge(); }
			).open();
		});

		// 고립 노드 배지 (고립 명제가 있을 때만 표시)
		this.orphanBadgeEl = parent.createEl('button', { cls: 'tb-orphan-badge' });
		this.orphanBadgeEl.hide();
		this.orphanBadgeEl.addEventListener('click', () => {
			new OrphanQueueModal(
				this.app, this.store, this.plugin.settings,
				this.getFolderPaths(),
				() => { void this.refreshOrphanBadge(); }
			).open();
		});
	}

	private async refreshConflictBadge(): Promise<void> {
		try {
			const conflicts = await this.store.scanConflicts();
			if (conflicts.length > 0) {
				this.conflictBadgeEl.textContent = this.plugin.settings.lang === 'ko'
					? `⚠ 미해소 모순 ${conflicts.length}건`
					: `⚠ ${conflicts.length} unresolved conflict${conflicts.length > 1 ? 's' : ''}`;
				this.conflictBadgeEl.show();
			} else {
				this.conflictBadgeEl.hide();
			}
		} catch {
			this.conflictBadgeEl.hide();
		}
	}

	private async refreshOrphanBadge(): Promise<void> {
		try {
			const count = await this.store.countOrphanPropositions();
			if (count > 0) {
				this.orphanBadgeEl.textContent = this.plugin.settings.lang === 'ko'
					? `◈ 미연결 명제 ${count}건`
					: `◈ ${count} unlinked node${count > 1 ? 's' : ''}`;
				this.orphanBadgeEl.show();
			} else {
				this.orphanBadgeEl.hide();
			}
		} catch {
			this.orphanBadgeEl.hide();
		}
	}

	private handleFileDrop(e: DragEvent) {
		// Case 1: Obsidian 파일 탐색기에서 내부 드래그 — 먼저 확인해야 함
		// (Obsidian이 dataTransfer.files도 채우기 때문에 순서를 바꾸면 OS 파일로 오인됨)
		type ObsidianDragManager = { dragManager?: { draggable?: { type?: string; file?: TFile; files?: unknown[] } } };
		const dm = (this.app as unknown as ObsidianDragManager).dragManager;
		const drg = dm?.draggable;
		if (drg) {
			const tfiles: TFile[] = [];
			if (drg.type === 'file' && drg.file instanceof TFile) {
				tfiles.push(drg.file);
			} else if (Array.isArray(drg.files)) {
				tfiles.push(...drg.files.filter((f): f is TFile => f instanceof TFile));
			}
			if (tfiles.length > 0) {
				void this.loadVaultFilesToTextarea(tfiles);
				return;
			}
		}

		// Case 2: OS 파일 시스템에서 외부 드래그
		const externalFiles = Array.from(e.dataTransfer?.files ?? []);
		if (externalFiles.length > 0) {
			void this.loadFilesToTextarea(externalFiles);
			return;
		}

		// Case 3: Fallback — dataTransfer text/plain에 볼트 경로가 담긴 경우
		const plainText = e.dataTransfer?.getData('text/plain')?.trim() ?? '';
		if (plainText) {
			const tf = this.app.vault.getFileByPath(plainText);
			if (tf instanceof TFile) {
				void this.loadVaultFilesToTextarea([tf]);
			}
		}
	}

	private handleFileSelect(e: Event) {
		const files = Array.from((e.target as HTMLInputElement).files ?? []);
		void this.loadFilesToTextarea(files);
	}

	// 외부(OS) 파일 → 텍스트 읽기
	private async loadFilesToTextarea(files: File[]) {
		const filtered = files.filter(f => /\.(md|txt|pdf)$/i.test(f.name));
		if (filtered.length === 0) {
			new Notice(this.t('notice_file_type'));
			return;
		}
		const texts: string[] = [];
		for (const f of filtered) {
			if (/\.pdf$/i.test(f.name)) {
				const buf = await f.arrayBuffer();
				texts.push(await extractPdfText(buf));
			} else {
				texts.push(await f.text());
			}
		}
		this.ingestTextarea.value = texts.join('\n\n---\n\n');
		this.updateCharCount();
		this.syncIngestBtnState();
		// 소스 추적: 외부 파일 (단일 파일이면 이름 저장, 복수면 paste로 취급)
		this.ingestSource = filtered.length === 1
			? { kind: 'external', name: filtered[0].name }
			: { kind: 'paste' };
		new Notice(`[ThirdBrain] ${filtered.length} files loaded`);
	}

	// 내부(Obsidian vault) TFile → 볼트에서 읽기
	// TB 노드인 경우 핵심 속성을 헤더로 표시해 사용자가 인지할 수 있도록 함
	private async loadVaultFilesToTextarea(files: TFile[]) {
		const filtered = files.filter(f => /\.(md|txt|pdf)$/i.test(f.name));
		if (filtered.length === 0) {
			new Notice(this.t('notice_file_type'));
			return;
		}
		const texts: string[] = [];
		for (const f of filtered) {
			if (/\.pdf$/i.test(f.name)) {
				const buf = await this.app.vault.readBinary(f);
				texts.push(await extractPdfText(buf));
				continue;
			}
			const raw = await this.app.vault.read(f);
			const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as TBFrontMatter | undefined;

			if (fm?.tb_id) {
				// TB 노드: 파일 경로를 헤더에 포함 → 인제스트 재클릭 시 텍스트에서 분기 가능
				const lines: string[] = [`[TB 노드:${f.path}] ${fm.tb_type ?? 'claim'}`];
				const tags: string[] = Array.isArray(fm.tb_tags) ? fm.tb_tags : [];
				if (tags.length) lines.push(`태그: ${tags.join(', ')}`);
				const edges: Array<{ target: string }> = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
				const edgeTitles = edges
					.map(e => e.target?.replace(/^\[\[|\]\]$/g, '') ?? '')
					.filter(Boolean).slice(0, 6);
				if (edgeTitles.length) lines.push(`연결: ${edgeTitles.join(', ')}`);
				lines.push('---', body || '(본문 없음)');
				texts.push(lines.join('\n'));
			} else {
				texts.push(body || raw);
			}
		}
		this.ingestTextarea.value = texts.join('\n\n---\n\n');
		this.updateCharCount();
		this.syncIngestBtnState();
		// 소스 추적: 볼트 내부 파일 (단일 파일이면 TFile 저장)
		this.ingestSource = filtered.length === 1
			? { kind: 'vault', file: filtered[0] }
			: { kind: 'paste' };

		if (filtered.length === 1) {
			const isTB = !!this.app.metadataCache.getFileCache(filtered[0])?.frontmatter?.tb_id;
			new Notice(`[ThirdBrain] ${filtered[0].basename} 로드됨${isTB ? ' — TB 노드 (인제스트 → 브릿지 실행)' : ''}`);
		} else {
			new Notice(`[ThirdBrain] ${filtered.length}개 노트 로드됨`);
		}
	}

	private buildProgressBar(parent: HTMLElement) {
		this.progressEl = parent.createEl('div', { cls: 'tb-progress' });
		const sootball = this.progressEl.createEl('span', { cls: 'tb-progress-sootball' });
		sootball.appendChild(sanitizeHTMLToDom(SOOTBALL_LOGO));
		this.progressBarEl = this.progressEl.createEl('span', { cls: 'tb-progress-bar', text: progressBar(0) });
		this.progressMsgEl = this.progressEl.createEl('span', { cls: 'tb-progress-msg', text: '' });
		this.stepLogEl = parent.createEl('div', { cls: 'tb-step-log' });
	}

	private appendStepStat(label: string, elapsedMs: number, snapBefore: ReturnType<typeof getSessionStats>) {
		const after = getSessionStats();
		const inTok = after.inputTokens - snapBefore.inputTokens;
		const outTok = after.outputTokens - snapBefore.outputTokens;
		const sec = (elapsedMs / 1000).toFixed(1);
		const fmt = (n: number) => n > 0 ? n.toLocaleString() : '─';
		const row = this.stepLogEl.createEl('div', { cls: 'tb-step-row' });
		row.createEl('span', { cls: 'tb-step-name', text: label });
		row.createEl('span', { cls: 'tb-step-time', text: `${sec}s` });
		row.createEl('span', { cls: 'tb-step-in',   text: `↑${fmt(inTok)}` });
		row.createEl('span', { cls: 'tb-step-out',  text: `↓${fmt(outTok)}` });
	}

	// 외부 호출용 (NodeTransplantModal → raw 파일 인제스트)
	public async ingestContent(content: string, targetFolder: string): Promise<void> {
		this.setIngestBusy(true);
		this.resultsEl.empty();
		this.stepLogEl?.empty();
		await this.runPipeline(content, undefined, targetFolder);
	}

	// ── 인제스트 진입점 ───────────────────────────────────

	private async runIngest() {
		const text = this.ingestTextarea.value.trim();
		if (!text) { new Notice(this.t('notice_no_text')); return; }

		// Step 0: ThirdBrainRoot 구조 보장 — 없으면 자동 생성
		const root = this.plugin.settings.rootFolder;
		if (!this.app.vault.getFolderByPath(root)) {
			await this.app.vault.createFolder(root);
		}
		const rawDir = `${root}/raw`;
		if (!this.app.vault.getFolderByPath(rawDir)) {
			await this.app.vault.createFolder(rawDir);
		}

		// Step 1: 콘텐츠 타입 선택
		const [includeActionLayer, meetingType] = await new Promise<[boolean | null, MeetingType | undefined]>((resolve) => {
			new ContentTypeModal(this.app, (inc, mt) => resolve([inc, mt]), this.plugin.settings.lang).open();
		});
		if (includeActionLayer === null) return;

		// Step 2: 저장할 폴더 선택
		const folders = this.getFolderPaths();
		const selectedFolder = await new Promise<string | null>((resolve) => {
			new SaveFolderModal(this.app, folders, this.plugin.settings.rootFolder, (folder: string) => {
				resolve(folder);
			}, this.plugin.settings.lang, this.plugin.settings.rootFolder).open();
		});

		if (selectedFolder === null) {
			new Notice(this.t('notice_no_folder'));
			return;
		}

		// TB 노드 감지: 텍스트 헤더에서 파일 경로 파싱 → 메모리 상태에 의존하지 않음
		const tbMatch = this.ingestTextarea.value.match(/^\[TB 노드:(.+?)\]/);

		// 텍스트 소비 — 인제스트 시작 즉시 비움
		const capturedSource = this.ingestSource;
		this.ingestSource = null;
		this.ingestTextarea.value = '';
		this.updateCharCount();
		this.syncIngestBtnState();

		if (tbMatch) {
			const srcFile = this.app.vault.getFileByPath(tbMatch[1]);
			if (srcFile) {
				await this.runBridgeFromIngest(srcFile, selectedFolder);
				return;
			}
		}

		// Step 2: raw 폴더 박제 — 파이프라인 실행 전 원본 저장
		let rawFile: TFile | undefined;
		// 새로 생성된 raw 파일이면 항상 context 제목으로 rename (paste·외부파일·볼트복사 모두)
		// 이미 raw/ 안에 있는 파일을 재사용하는 경우만 rename 생략
		let needsAutoTitle = false;
		try {
			const existingVaultPath = capturedSource?.kind === 'vault' ? capturedSource.file.path : undefined;
			const root = this.plugin.settings.rootFolder;
			const isAlreadyInRaw = !!existingVaultPath?.startsWith(`${root}/raw/`);
			const sourceName = capturedSource?.kind === 'external'
				? capturedSource.name
				: capturedSource?.kind === 'vault'
					// frontmatter title 우선, 없으면 파일명(basename)
					? (this.app.metadataCache.getFileCache(capturedSource.file)?.frontmatter?.title as string | undefined
						|| capturedSource.file.basename)
					: 'paste';
			rawFile = await this.store.createRawFile(text, sourceName, existingVaultPath);
			needsAutoTitle = !isAlreadyInRaw; // 새로 만든 파일만 자동 개명
		} catch {
			// raw 박제 실패는 파이프라인을 중단시키지 않음
		}

		this.setIngestBusy(true);
		this.resultsEl.empty();
		this.pipelineModal?.close();
		this.pipelineModal = null;

		type RawLink = { file: TFile; sourceSpan?: { text: string; offset: number } };
		const allRawLinks: RawLink[] = [];
		const allBlockIdSpans: Array<{ blockId: string; spanText: string }> = [];

		if (text.length > CHUNK_SIZE) {
			const chunks = splitIntoChunks(text, CHUNK_SIZE);
			for (let i = 0; i < chunks.length; i++) {
				this.setIngestBusy(true);
				this.setProgress(1, `(${i + 1}/${chunks.length}) ${this.t('progress_chunk')}`);
				const isLast = i === chunks.length - 1;
				const res = await this.runPipeline(chunks[i], undefined, selectedFolder, `청크 ${i + 1}/${chunks.length}`, includeActionLayer, rawFile, i === 0 && needsAutoTitle, isLast, meetingType);
				if (res) { allRawLinks.push(...res.rawLinks); allBlockIdSpans.push(...res.blockIdSpans); }
			}
		} else {
			const res = await this.runPipeline(text, undefined, selectedFolder, undefined, includeActionLayer, rawFile, needsAutoTitle, true, meetingType);
			if (res) { allRawLinks.push(...res.rawLinks); allBlockIdSpans.push(...res.blockIdSpans); }
		}

		// 모든 청크의 rawLinks를 한 번에 원본 파일에 기록 (청크별 덮어쓰기 방지)
		if (rawFile) {
			if (allBlockIdSpans.length > 0) {
				await this.store.insertBlockIds(rawFile, allBlockIdSpans).catch(() => {});
			}
			if (allRawLinks.length > 0) {
				await this.store.appendLinksToRawFile(rawFile, allRawLinks).catch(() => {});
			}
		}
	}

	// ── 메인 파이프라인 (Auto vs Architect 모드) ──────

	private async runPipeline(
		text: string,
		cachedContexts?: ContextLayer[],
		targetFolder?: string,
		chunkLabel?: string,
		includeActionLayer = false,
		rawFile?: TFile,
		needsAutoTitle = false,
		isLastChunk = true,
		meetingType?: MeetingType
	) {
		let rawSourcePath = rawFile ? rawFile.path.replace(/\.md$/, '') : undefined;

		// 파이프라인 결과 모달 생성 — 로컬 변수로 캡처해야 청크별 버튼이 각자 모달 참조
		this.pipelineModal?.close();
		const modal = new PipelineInfoModal(this.app, this.plugin.settings.lang);
		this.pipelineModal = modal;
		modal.open();
		this.stepLogEl = modal.stepLogEl;

		// 결과 패널 상단에 재오픈 버튼 고정
		const btnLabel = chunkLabel ? `[ ${chunkLabel} ${this.t('result_view')} ]` : this.t('result_view');
		const reopenBtn = this.resultsEl.createEl('button', {
			cls: 'tb-btn tb-reopen-btn',
			text: btnLabel,
		});
		reopenBtn.addEventListener('click', () => modal.open());

		// 스탭 타이머 헬퍼 — 각 CLI 단계 래핑
		const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
			const snap = getSessionStats();
			const t0 = Date.now();
			const result = await fn();
			this.appendStepStat(label, Date.now() - t0, snap);
			return result;
		};

		try {
			// 1차: 문맥 분절
			let contexts: ContextLayer[];
			if (cachedContexts) {
				contexts = cachedContexts;
				this.renderContextLayer(contexts);
			} else {
				this.setProgress(2, this.t('progress_context'));
				contexts = await timed(this.t('step_context'), () => extractContexts(text, this.plugin.settings));
				if (contexts.length === 0) {
					contexts = [{
						id: `ctx-fallback-${Date.now().toString(36)}`,
						title: '전체 내용',
						date: new Date().toISOString().split('T')[0],
						summary: text.slice(0, 3000),
						tags: [], keywords: [],
					}];
				}
				this._cachedContexts = contexts;
				this.renderContextLayer(contexts);

				// raw 파일 자동 개명: paste 출처이고 제목이 의미 있으면 YYYYMMDD_제목.md 로 변경
				if (needsAutoTitle && rawFile && contexts[0]?.title) {
					try {
						const renamed = await this.store.renameRawFile(rawFile, contexts[0].title);
						rawFile = renamed;
						rawSourcePath = renamed.path.replace(/\.md$/, '');
					} catch {
						// 개명 실패는 무시 — 원래 이름으로 계속 진행
					}
				}
			}

			// 2차: 명제 추출 (인사이트는 분석 단계에서만)
			this.setProgress(4, this.t('progress_proposition'));
			let propositions: Awaited<ReturnType<typeof extractPropositions>>;
			try {
				propositions = await timed(this.t('step_proposition'),
					() => extractPropositions(contexts, text, this.plugin.settings));
			} catch (propErr) {
				const diagMsg = propErr instanceof Error ? propErr.message : String(propErr);
				new Notice(`[ThirdBrain] ${chunkLabel ? chunkLabel + ' ' : ''}명제 추출 실패\n${diagMsg}`, 15000);
				this.resultsEl.createEl('div', {
					cls: 'tb-error-msg',
					text: `명제 추출 실패 (${chunkLabel ?? '단일 청크'}):\n${diagMsg}`,
				});
				this.hideProgress();
				this.setIngestBusy(false);
				return undefined;
			}

			// 2.5차: 엣지 추출 (명제 간 크로스-컨텍스트만)
			this.setProgress(6, this.t('progress_edge'));
			const rawEdges = await timed(this.t('step_edge'),
				() => extractEdges(propositions, contexts, [], this.plugin.settings));
			const logic: LogicLayer = { propositions, edges: rawEdges };
			this.hideProgress();
			this.setIngestBusy(false);

			this.renderLogicLayer(logic);

			// 폴더 브리지는 별도 기능으로 분리 (generateEdgeCandidates 제거)
			this.hideProgress();
			this.setIngestBusy(false);

			// targetFolder가 있으면 자동 저장 (중복 저장 방지)
			if (targetFolder) {
				// ⑨ 저장 전에 기존 노드 스냅샷 (새 파일 생성 전이어야 타이밍 문제 없음)
				const preExistingNodes = await this.store.loadNodesInFolder(targetFolder);

				this.setProgress(8, this.t('progress_save'));
				try {
					const result = await this.saveNodes(contexts, logic, targetFolder, rawSourcePath, rawFile);
					const { contextFileMap, propFileMap, rawLinks, blockIdSpans } = result;
					this.hideProgress();
					new Notice(`${this.t('notice_graph_save_done_full')} (${logic.propositions.length}${this.t('notice_prop_suffix')}${logic.edges.length}${this.t('notice_edge_suffix')})`);

					// Phase 2: 모순 감지 — 마지막 청크에서만 실행 (중간 청크 중복 방지)
					if (isLastChunk) {
						const savedNodes = await this.store.loadNodesInFolder(targetFolder);
						const conflicts = detectConflicts(savedNodes);
						if (conflicts.length > 0) {
							this.renderConflictNotice(conflicts);
						}
						void this.refreshConflictBadge();
					}

					// Phase 8: 액션 레이어 추출 (회의·일정 선택 시에만)
					if (includeActionLayer) {
						this.setProgress(9, this.t('progress_action'));
						await this.extractAndSaveActions(
							text,
							logic.propositions,
							contexts,
							contextFileMap,
							propFileMap,
							targetFolder,
							meetingType
						);
					}

					// ⑨ 기존 노드와 cross-connection 탐색 (LLM API 호출)
					if (preExistingNodes.length > 0) {
						this.setProgress(9, `⑨ 기존 ${preExistingNodes.length}개 노드와 연결 탐색 중...`);
						await this.findAndRenderCrossConnections(
							logic.propositions,
							preExistingNodes
						);
					}
					this.hideProgress();

					// 🆕 그래프 뷰 자동 오픈
					window.setTimeout(() => {
						void this.openNativeGraph([targetFolder]);
					}, 300);

					return { rawLinks, blockIdSpans };
				} catch (err) {
					this.hideProgress();
					new Notice(`${this.t('save_error_ingest_prefix')}${err instanceof Error ? err.message : String(err)}`);
				}
			} else {
				// 폴더를 선택하지 않았으면 (예외 상황) 사용자에게 선택 요구
				this.renderSaveSection(
					async (folder: string) => {
						const result = await this.saveNodes(contexts, logic, folder, rawSourcePath, rawFile);
						return result;
					},
					async () => {},
					undefined
				);
			}

		} catch (e) {
			this.hideProgress();
			this.setIngestBusy(false);

			const msg = e instanceof Error ? e.message : String(e);
			const stack = e instanceof Error ? e.stack : '';

			// UI에 대형 에러 표시
			this.resultsEl.empty();
			const errorDiv = this.resultsEl.createEl('div', { cls: 'tb-error-container' });

			errorDiv.createEl('div', { cls: 'tb-error-title', text: this.t('error_title') });
			errorDiv.createEl('div', { cls: 'tb-error-message', text: msg });

			if (stack) {
				const detailsDiv = errorDiv.createEl('div', { cls: 'tb-error-details' });
				detailsDiv.createEl('div', { cls: 'tb-error-label', text: this.t('error_detail_label') });
				detailsDiv.createEl('pre', { cls: 'tb-error-stack', text: stack.split('\n').slice(0, 5).join('\n') });
			}

			if (msg.includes('Claude API')) {
				const helpDiv = errorDiv.createEl('div', { cls: 'tb-error-help' });
				helpDiv.createEl('div', { cls: 'tb-error-label', text: this.t('error_help_label') });
				helpDiv.createEl('ul', {}).createEl('li', { text: this.t('error_help_1') });
				helpDiv.createEl('ul', {}).createEl('li', { text: this.t('error_help_2') });
				helpDiv.createEl('ul', {}).createEl('li', { text: this.t('error_help_3') });
				helpDiv.createEl('ul', {}).createEl('li', { text: this.t('error_help_4') });
			}

			// 알림도 함께
			new Notice(`⚠️ ${msg}`);
		}
	}

	// ── 1차 결과: 문맥 레이어 ────────────────────────────

	private renderContextLayer(contexts: ContextLayer[]) {
		const { content } = this.makeSectionToggle(
			`${this.t('layer_context_header')} · ${contexts.length}${this.t('layer_count_unit')}`, true
		);
		for (const ctx of contexts) {
			const card = content.createEl('div', { cls: 'tb-card is-summary' });
			const head = card.createEl('div', { cls: 'tb-card-head' });
			head.createEl('span', { cls: 'tb-tag is-summary', text: `CTX · ${ctx.date}` });
			head.createEl('span', { cls: 'tb-card-title', text: ctx.title });
			card.createEl('div', { cls: 'tb-card-body', text: ctx.summary });
			if (ctx.tags.length || ctx.keywords.length) {
				const tagRow = card.createEl('div', { cls: 'tb-tagrow' });
				for (const t of ctx.tags) tagRow.createEl('span', { cls: 'tb-keyword', text: `#${t}` });
				for (const k of ctx.keywords) tagRow.createEl('span', { cls: 'tb-keyword is-kw', text: k });
			}
			if (contexts.length > 1) card.addClass('is-collapsed');
			head.addEventListener('click', () =>
				card.toggleClass('is-collapsed', !card.hasClass('is-collapsed'))
			);
		}
	}

	// ── 1.5차 결과: 핵심 인사이트 레이어 ────────────────────

	private renderInsightLayer(insights: Insight[]) {
		if (insights.length === 0) return;
		const { content } = this.makeSectionToggle(
			`${this.t('layer_insight_header')} · ${insights.length}${this.t('layer_count_generic')}`, false
		);
		for (const ins of insights) {
			const card = content.createEl('div', { cls: 'tb-card is-insight' });
			const head = card.createEl('div', { cls: 'tb-card-head' });
			head.createEl('span', { cls: 'tb-insight-badge', text: '⬡ 인사이트' });
			head.createEl('span', { cls: 'tb-card-title', text: ins.title });
			card.createEl('div', { cls: 'tb-card-body', text: ins.why_central });
			head.addEventListener('click', () =>
				card.toggleClass('is-collapsed', !card.hasClass('is-collapsed'))
			);
		}
	}

	// ── 2차 결과: 논리 레이어 (최종) ──────────────────────

	private renderLogicLayer(logic: LogicLayer) {
		const byId = new Map(logic.propositions.map(p => [p.id, p]));
		const label = `${this.t('layer_logic_header')} · ${this.t('layer_logic_prop_label')} ${logic.propositions.length} · ${this.t('layer_logic_edge_label')} ${logic.edges.length}`;
		const { content } = this.makeSectionToggle(label, true);

		// 핵심 개념 먼저
		const sorted = [...logic.propositions].sort((a, b) => {
			const rank = (p: typeof a) => (p.is_core_concept ? 0 : 1);
			return rank(a) - rank(b);
		});

		for (const p of sorted) {
			const isInsight = p.role === 'insight';
			const hasSource = !!p.source_span?.text;
			const card = content.createEl('div', {
				cls: `tb-card is-${p.role}${p.is_core_concept ? ' is-core-concept' : ''}${isInsight ? ' is-hub' : ''}`,
			});
			const head = card.createEl('div', { cls: 'tb-card-head' });
			if (isInsight) {
				head.createEl('span', { cls: 'tb-hub-badge', text: this.t('badge_insight') });
			} else if (p.is_core_concept) {
				head.createEl('span', { cls: 'tb-core-badge', text: this.t('badge_core') });
			}
			head.createEl('span', { cls: `tb-tag is-${p.role}`, text: p.role.toUpperCase() });
			head.createEl('span', { cls: 'tb-card-title', text: p.title });
			if (!hasSource) {
				head.createEl('span', { cls: 'tb-no-source-badge', text: this.t('badge_no_source') });
			}
			card.createEl('div', { cls: 'tb-card-body', text: p.text });
			if (hasSource) {
				const footer = card.createEl('div', { cls: 'tb-card-footer' });
				const srcToggle = footer.createEl('button', { cls: 'tb-source-toggle', text: this.t('source_toggle') });
				const srcBox = card.createEl('div', { cls: 'tb-source-box' });
				srcBox.createEl('p', { cls: 'tb-source-text', text: p.source_span.text });
				srcToggle.addEventListener('click', (e) => {
					e.stopPropagation();
					const open = card.hasClass('source-open');
					card.toggleClass('source-open', !open);
					srcToggle.toggleClass('is-active', !open);
				});
			}
			head.addEventListener('click', () =>
				card.toggleClass('is-collapsed', !card.hasClass('is-collapsed'))
			);
		}

		if (logic.edges.length > 0) {
			content.createEl('div', { cls: 'tb-block-label', text: this.t('label_logic_edge') });
			const list = content.createEl('div', { cls: 'tb-edgelist' });
			for (const e of logic.edges) {
				const s = byId.get(e.source);
				const t = byId.get(e.target);
				if (!s || !t) continue;
				const rel = relLabel(e.relation, this.plugin.settings.lang);
				const row = list.createEl('div', { cls: 'tb-edge-row' });
				row.createEl('span', { cls: 'tb-edge-node', text: shortText(s.text, 24) });
				// Phase 6-3: axiom_basis hover tooltip
				const relChip = row.createEl('span', {
					cls: `tb-edge-rel tb-edge-${e.relation}`,
					text: ` ―${rel}→ `,
				});
				if (e.axiom_basis) relChip.setAttr('title', `근거: ${e.axiom_basis}`);
				row.createEl('span', { cls: 'tb-edge-node', text: shortText(t.text, 24) });
			}
		}
	}

	// ── ③ 볼트 연결 추천 칩 ────────────────────────────────

	private renderIngestLinks(recs: EdgeCandidate[]): (coreFile: TFile) => void {
		const { content } = this.makeSectionToggle(
			`③ 볼트 연결 추천 · ${recs.length}개`, false
		);

		const connectBtns: Array<{ btn: HTMLButtonElement; rec: EdgeCandidate }> = [];

		if (recs.length === 0) {
			content.createEl('div', { cls: 'tb-empty', text: this.t('label_no_vault_nodes') });
		} else {
			content.createEl('div', {
				cls: 'tb-hint',
				text: this.t('label_graph_save_hint'),
			});
			const chipRow = content.createEl('div', { cls: 'tb-edge-chips' });

			for (const rec of recs) {
				const chip = chipRow.createEl('div', { cls: 'tb-chip' });
				const top = chip.createEl('div', { cls: 'tb-chip-top' });
				top.createEl('span', { cls: 'tb-chip-icon', text: '◎' });
				const rel = relLabel(rec.label, this.plugin.settings.lang);
				if (rec.source_node) {
					top.createEl('span', { cls: 'tb-chip-source', text: shortText(rec.source_node, 16) });
					top.createEl('span', { cls: 'tb-chip-arrow', text: ` ―${rel}→ ` });
					top.createEl('span', { cls: 'tb-chip-target', text: rec.target_file.replace(/\.md$/, '') });
				} else {
					top.createEl('span', { cls: 'tb-chip-target', text: rec.target_file.replace(/\.md$/, '') });
					top.createEl('span', { cls: 'tb-chip-arrow', text: ` (${rel})` });
				}
				chip.createEl('div', { cls: 'tb-chip-reason', text: rec.reason });

				const btn = chip.createEl('button', {
					cls: 'tb-chip-connect-btn',
					text: this.t('label_connect'),
					attr: { disabled: 'true' },
				});
				connectBtns.push({ btn, rec });
			}
		}

		// 저장 완료 후 coreFile을 받아 연결 버튼 활성화
		return (coreFile: TFile) => {
			let linking = false;
			for (const { btn, rec } of connectBtns) {
				btn.removeAttribute('disabled');
				btn.addEventListener('click', () => void (async () => {
					if (linking) return;
					linking = true;
					connectBtns.forEach(({ btn: b }) => { b.disabled = true; });
					btn.textContent = '연결 중...';
					try {
						const edge: TBEdge = {
							target: `[[${rec.target_file.replace(/\.md$/, '')}]]`,
							label: toRelation(rec.label),
							confirmed: true,
							reason: rec.reason,
							confidence: 1.0,
							axiom_basis: '',
						};
						await this.store.confirmEdge(coreFile, edge);
						btn.textContent = '연결됨 ✓';
						btn.addClass('tb-chip-connect-done');
						connectBtns.forEach(({ btn: b }) => {
							if (b !== btn) { b.disabled = false; }
						});
						linking = false;
					} catch {
						linking = false;
						connectBtns.forEach(({ btn: b }) => { b.disabled = false; });
						btn.textContent = '연결';
					}
				})());
			}
		};
	}

	// ── ④ 그래프 저장 전용 섹션 ────────────────────────────

	private renderSaveSection(
		onSave: (folder: string) => Promise<{ files: TFile[]; folder: string; actualPath: string }>,
		onSaveReport: () => Promise<void>,
		onSaved?: (coreFile: TFile) => void
	) {
		const block = this.resultsEl.createEl('div', { cls: 'tb-block tb-save-block' });
		const btnRow = block.createEl('div', { cls: 'tb-save-btn-row' });

		const saveBtn = btnRow.createEl('button', { cls: 'tb-btn is-primary tb-save-main', text: this.t('btn_save_graph') });
		const resultArea = block.createEl('div', { cls: 'tb-save-result-area' });

		const doSave = async (folder: string) => {
			saveBtn.disabled = true;
			saveBtn.textContent = this.t('btn_saving');
			resultArea.empty();
			try {
				const { files, folder: dest, actualPath } = await onSave(folder);
				this.fileCountEl.textContent = this.vaultCountText();
				saveBtn.textContent = `${this.t('btn_save_done').replace(']', '')} (${files.length}) ]`;
				new Notice(`[ThirdBrain] ${files.length}${this.t('notice_graph_save_done_suffix')} ${dest}`);

				if (files.length > 0) {
					const destLabel = dest === this.t('fallback_folder_root') ? this.t('label_vault_root') : `${dest}/`;
					resultArea.createEl('div', { cls: 'tb-save-result-label', text: `✓ ${destLabel}${this.t('label_saved_in_suffix')}` });
					const list = resultArea.createEl('div', { cls: 'tb-save-result-list' });
					for (const file of files) {
						const item = list.createEl('div', { cls: 'tb-save-result-item' });
						item.createEl('span', { cls: 'tb-save-result-icon', text: '▸' });
						const link = item.createEl('span', { cls: 'tb-save-result-name', text: file.basename });
						link.addEventListener('click', () => {
							void this.app.workspace.getLeaf('tab').openFile(file);
						});
					}
					// 볼트 연결 버튼 활성화 (첫 번째 저장 파일에 연결)
					onSaved?.(files[0]);

					// 🆕 저장 완료 후 그래프 뷰 자동 열기
					void this.openGraphViewWithFolder(actualPath);
				}
			} catch (e) {
				saveBtn.textContent = this.t('btn_save_graph');
				saveBtn.disabled = false;
				resultArea.createEl('div', { cls: 'tb-save-result-error', text: `${this.t('save_error_prefix')}${e instanceof Error ? e.message : String(e)}` });
				new Notice(`${this.t('save_error_prefix')}${e instanceof Error ? e.message : String(e)}`);
			}
		};

		saveBtn.addEventListener('click', () => {
			new SaveFolderModal(
				this.app,
				this.getFolderPaths(),
				this.plugin.settings.rootFolder,
				(folder) => void doSave(folder),
				this.plugin.settings.lang,
				this.plugin.settings.rootFolder
			).open();
		});

		const reportBtn = btnRow.createEl('button', { cls: 'tb-btn tb-btn-report', text: this.t('btn_save_report') });
		reportBtn.addEventListener('click', () => void (async () => {
			reportBtn.disabled = true;
			reportBtn.textContent = this.t('btn_saving');
			try {
				await onSaveReport();
				reportBtn.textContent = this.t('btn_report_done');
			} catch {
				reportBtn.disabled = false;
				reportBtn.textContent = this.t('btn_save_report');
			}
		})());
	}

	// ── vault 저장 ────────────────────────────────────────

	private async saveNodes(
		contexts: ContextLayer[],
		logic: LogicLayer,
		targetFolder = '',
		rawSourcePath?: string,
		rawFile?: TFile
	): Promise<{ files: TFile[]; folder: string; actualPath: string; propFileMap: Map<string, TFile>; contextFileMap: Map<string, TFile>; rawLinks: Array<{ file: TFile; sourceSpan?: { text: string; offset: number } }>; blockIdSpans: Array<{ blockId: string; spanText: string }> }> {
		if (logic.propositions.length === 0) {
			throw new Error('저장할 노드가 없습니다. 파이프라인을 먼저 실행해주세요.');
		}

		const contextTags = contexts.flatMap(c => c.keywords).slice(0, 8);
		const folder = targetFolder || '루트';

		// 1) 문맥 레이어 먼저 저장 (rawSourcePath 전달 → context 노드 본문에 원본 위키링크 삽입)
		const contextFileMap = await this.store.createContextBatch(contexts, targetFolder, rawSourcePath);

		// 2) 명제 저장 (각 명제 → 소속 문맥 방향 supports 엣지 포함)
		const propFileMap = await this.store.createPropositionBatch(
			logic.propositions, logic.edges, contextTags, targetFolder, contextFileMap, rawSourcePath
		);

		const allFiles = [...contextFileMap.values(), ...propFileMap.values()];

		// Context ↔ Proposition 엣지 생성
		await this.connectContextsToPropositions(
			contexts, logic.propositions, contextFileMap, propFileMap
		);

		// rawLinks + blockIdSpans 수집 (appendLinksToRawFile/insertBlockIds는 호출하지 않음 — 호출자가 청크 누적 후 일괄 처리)
		const propLinks = logic.propositions
			.map(p => ({ file: propFileMap.get(p.id)!, sourceSpan: p.source_span }))
			.filter(l => l.file);
		const ctxLinks = [...new Set(contextFileMap.values())].map(f => ({ file: f }));
		const rawLinks = [...propLinks, ...ctxLinks];
		const blockIdSpans = logic.propositions
			.filter(p => p.block_id && p.source_span?.text)
			.map(p => ({ blockId: p.block_id!, spanText: p.source_span.text }));

		return { files: allFiles, folder, actualPath: targetFolder, propFileMap, contextFileMap, rawLinks, blockIdSpans };
	}

	// ── Phase 8: 액션 레이어 결과 렌더 ─────────────────────────

	private renderActionCard(parent: HTMLElement, node: ActionNode, propById?: Map<string, Proposition>) {
		const card = parent.createEl('div', { cls: `tb-action-card is-${node.status}` });

		const head = card.createEl('div', { cls: 'tb-action-card-head' });
		if (node.meeting_type) {
			const mtKey = `action_meeting_${node.meeting_type}` as TKey;
			head.createEl('span', { cls: `tb-action-meeting-badge is-${node.meeting_type}`, text: this.t(mtKey) });
		}
		if (node.origin === 'from_resolution') {
			head.createEl('span', { cls: 'tb-action-badge-conflict', text: this.t('badge_conflict_resolved') });
		} else if (node.origin === 'extracted') {
			head.createEl('span', { cls: 'tb-action-origin', text: this.t('badge_ai_extracted') });
		}
		head.createEl('span', { cls: 'tb-action-title', text: node.title });

		// 상태 드롭다운
		const statusRow = card.createEl('div', { cls: 'tb-action-meta-row' });
		const statusSel = statusRow.createEl('select', { cls: `tb-action-status-sel is-${node.status}` });
		(['pending', 'in_progress', 'done', 'blocked'] as ActionStatus[]).forEach(s => {
			const labels: Record<ActionStatus, string> = {
				pending: '대기', in_progress: '진행 중', done: '완료', blocked: '차단',
			};
			const opt = statusSel.createEl('option', { value: s, text: labels[s] });
			if (s === node.status) opt.selected = true;
		});

		if (node.owner) statusRow.createEl('span', { cls: 'tb-action-owner', text: node.owner });
		if (node.deadline) statusRow.createEl('span', { cls: 'tb-action-deadline', text: node.deadline.slice(0, 10) });

		statusSel.addEventListener('change', () => void (async () => {
			const newStatus = statusSel.value as ActionStatus;
			card.classList.remove('is-pending', 'is-in_progress', 'is-done', 'is-blocked');
			card.classList.add(`is-${newStatus}`);
			statusSel.classList.remove('is-pending', 'is-in_progress', 'is-done', 'is-blocked');
			statusSel.classList.add(`is-${newStatus}`);
			const file = this.app.vault.getFileByPath(node.filePath);
			if (file) await this.store.updateActionStatus(file, newStatus);
		})());

		if (node.content) {
			card.createEl('div', { cls: 'tb-action-content', text: node.content.slice(0, 120) });
		}

		// 동기 명제 링크
		if (node.motivation_ids.length > 0) {
			const motivRow = card.createEl('div', { cls: 'tb-action-motiv' });
			motivRow.createEl('span', { cls: 'tb-action-motiv-label', text: this.t('label_motiv') });
			for (const id of node.motivation_ids) {
				const label = propById?.get(id)?.title ?? id;
				const chip = motivRow.createEl('span', { cls: 'tb-action-motiv-chip', text: label });
				chip.addEventListener('click', () => {
					const f = this.app.vault.getMarkdownFiles().find(f =>
						this.app.metadataCache.getFileCache(f)?.frontmatter?.tb_id === id
					);
					if (f) void this.app.workspace.openLinkText(f.basename, '', false);
				});
			}
		}
	}


	// Phase 8: 액션 레이어 추출 → 저장 → 문맥 엣지 연결 → 결과 패널 렌더
	private async extractAndSaveActions(
		text: string,
		propositions: Proposition[],
		contexts: ContextLayer[],
		contextFileMap: Map<string, TFile>,
		propFileMap: Map<string, TFile>,
		folder: string,
		meetingType?: MeetingType
	): Promise<void> {
		try {
			let actions = await extractActions(text, propositions, contexts, this.plugin.settings);
			if (actions.length === 0) return;
			actions = await linkActionsToPropositions(actions, propositions, this.plugin.settings);

			const ctxById = new Map(contexts.map(c => [c.id, c]));
			const propById = new Map(propositions.map(p => [p.id, p]));
			const savedActions: ActionNode[] = [];

			for (const a of actions) {
				const actionWithMeeting = meetingType ? { ...a, meeting_type: meetingType } : a;
				const actionFile = await this.store.createActionNode(actionWithMeeting, folder, propFileMap);

				// 문맥 → 액션: precondition_of 엣지
				for (const ctxId of (a.motivation_context_ids ?? [])) {
					const ctx = ctxById.get(ctxId);
					if (!ctx) continue;
					const ctxFile = contextFileMap.get(ctx.title);
					if (!ctxFile) continue;
					await this.store.confirmEdge(ctxFile, {
						target: `[[${actionFile.basename}]]`,
						label: 'precondition_of',
						confirmed: true,
						reason: `이 문맥에서 도출된 액션`,
						confidence: 1.0,
						axiom_basis: '파이프라인 자동 연결',
					});
				}
				savedActions.push({ ...actionWithMeeting, filePath: actionFile.path, _propById: propById } as ActionNode & { _propById: Map<string, Proposition> });
			}
			this.renderActionResults(savedActions, propById);
		} catch (e) {
			new Notice(`[ThirdBrain] 액션 추출 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private renderActionResults(actions: ActionNode[], propById?: Map<string, Proposition>) {
		if (actions.length === 0) return;
		const { content } = this.makeSectionToggle(
			`${this.t('layer_action_header')} · ${actions.length}${this.t('layer_count_generic')}`, false
		);

		// meeting_type별 그룹핑: 타입이 있는 경우에만 그룹 헤더 표시
		const hasMeetingType = actions.some(a => !!a.meeting_type);
		if (hasMeetingType) {
			const groups = new Map<string, ActionNode[]>();
			for (const a of actions) {
				const key = a.meeting_type ?? 'none';
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key)!.push(a);
			}
			const groupOrder: Array<MeetingType | 'none'> = ['brainstorm', 'execution', 'review', 'none'];
			for (const key of groupOrder) {
				const group = groups.get(key);
				if (!group || group.length === 0) continue;
				const labelKey: TKey = key === 'none' ? 'action_meeting_none' : `action_meeting_${key}` as TKey;
				content.createEl('div', { cls: 'tb-action-group-header', text: this.t(labelKey) });
				for (const a of group) this.renderActionCard(content, a, propById);
			}
		} else {
			for (const a of actions) this.renderActionCard(content, a, propById);
		}
	}

	private renderConflictNotice(conflicts: ConflictReport[]) {
		const { content } = this.makeSectionToggle(
			`⚠ 논리 모순 · ${conflicts.length}개 (그래프에 보존됨)`, false
		);
		content.createEl('div', {
			cls: 'tb-conflict-notice-hint',
			text: this.t('label_conflict_notice'),
		});
		for (const c of conflicts) {
			const row = content.createEl('div', { cls: 'tb-conflict-notice-row' });
			row.createEl('span', { cls: 'tb-conflict-notice-a', text: c.nodeA.title });
			row.createEl('span', { cls: 'tb-conflict-notice-vs', text: '⟷' });
			row.createEl('span', { cls: 'tb-conflict-notice-b', text: c.nodeB.title });
			const btn = row.createEl('button', { cls: 'tb-btn tb-conflict-resolve-btn', text: '해소하기' });
			const resolvedMsg = row.createEl('span', { cls: 'tb-conflict-resolved-msg' });
			btn.addEventListener('click', () => {
				new ConflictResolutionModal(this.app, c, this.store, this.plugin.settings, (msg) => {
					btn.remove();
					resolvedMsg.textContent = `✓ ${msg}`;
					resolvedMsg.addClass('is-visible');
				}).open();
			});
		}
	}

	// ── ⑨ Cross-Connection: 새 명제 ↔ 기존 폴더 노드 ──────────
	// preExistingNodes: saveNodes 호출 전에 스냅샷한 기존 노드 목록 (타이밍 문제 없음)

	private async findAndRenderCrossConnections(
		newPropositions: Proposition[],
		preExistingNodes: TBNode[]
	): Promise<void> {
		try {
			const newItems = newPropositions.slice(0, 15).map(p => ({
				title: p.title,
				content: p.text,
				tags: p.context ? [p.context] : [],
			}));

			const connections = await findCrossConnections(
				newItems,
				preExistingNodes,
				this.plugin.settings
			);

			if (connections.length === 0) {
				new Notice(this.t('notice_no_connection'));
				return;
			}

			// 파일 매핑
			const existingTitleToFile = new Map<string, TFile>();
			for (const n of preExistingNodes) {
				const f = this.app.vault.getFileByPath(n.filePath);
				if (f) existingTitleToFile.set(n.title, f);
			}
			const newTitleToFile = new Map<string, TFile>();
			for (const p of newPropositions) {
				const f = this.app.vault.getMarkdownFiles()
					.find(f => f.basename === p.title);
				if (f) newTitleToFile.set(p.title, f);
			}

			// confidence ≥ 0.75 전부 저장, 하나도 없으면 최상위 1개 저장
			const sorted = [...connections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
			const toSave = sorted.filter(c => (c.confidence ?? 0) >= 0.75);
			const targets = toSave.length > 0 ? toSave : sorted.slice(0, 1);
			const saved = new Set<string>();
			for (const conn of targets) {
				const newFile = newTitleToFile.get(conn.new_title);
				const existFile = existingTitleToFile.get(conn.existing_title);
				if (!newFile || !existFile) continue;
				await this.saveCrossEdge(conn, newFile, existFile);
				saved.add(`${conn.new_title}→${conn.existing_title}`);
			}
			if (saved.size > 0) {
				this.renderCrossConnectionLog(connections, saved);
				new Notice(`[ThirdBrain] ⑨ Auto: ${saved.size}개 연결 자동 저장`);
			}
			const showChips = saved.size === 0;
			if (showChips) {
				new Notice(`[ThirdBrain] ⑨ ${connections.length}개 연결 후보 — 패널을 스크롤해 확인하세요`);
				const preSelectFirst = saved.size === 0;
				this.renderCrossConnectionChips(connections, newTitleToFile, existingTitleToFile, saved, preSelectFirst);
			}
		} catch (err) {
			new Notice(`[ThirdBrain] ⑨ 연결 탐색 실패: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async saveCrossEdge(conn: CrossConnection, newFile: TFile, existFile: TFile): Promise<void> {
		const fwd: TBEdge = { target: `[[${conn.existing_title}]]`, label: toRelation(conn.relation), confirmed: true, reason: conn.reason, confidence: conn.confidence ?? 1.0, axiom_basis: '' };
		const bwd: TBEdge = { target: `[[${conn.new_title}]]`, label: toRelation(conn.relation), confirmed: true, reason: conn.reason, confidence: conn.confidence ?? 1.0, axiom_basis: '' };
		await this.app.fileManager.processFrontMatter(newFile, (fm: TBFrontMatter) => {
			const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
			if (!edges.find(e => e.target === fwd.target)) edges.push(fwd);
			fm.tb_edges = edges;
		});
		await this.app.fileManager.processFrontMatter(existFile, (fm: TBFrontMatter) => {
			const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
			if (!edges.find(e => e.target === bwd.target)) edges.push(bwd);
			fm.tb_edges = edges;
		});
	}

	private renderCrossConnectionLog(connections: CrossConnection[], autoSaved: Set<string>): void {
		const container = this.pipelineModal?.contentEl ?? this.resultsEl;
		const block = container.createEl('div', { cls: 'tb-block' });
		const toggle = block.createEl('div', { cls: 'tb-section-toggle' });
		toggle.createEl('span', { cls: 'tb-section-chevron', text: '▾' });
		toggle.createEl('span', { cls: 'tb-section-label', text: `✓ ⑨ ${autoSaved.size}${this.t('conn_auto_saved_suffix')}` });
		const content = block.createEl('div', { cls: 'tb-section-content' });
		toggle.addEventListener('click', () => {
			const collapsed = content.hasClass('is-collapsed');
			content.toggleClass('is-collapsed', !collapsed);
			toggle.querySelector<HTMLElement>('.tb-section-chevron')!.textContent = collapsed ? '▾' : '▸';
		});
		for (const conn of connections) {
			const key = `${conn.new_title}→${conn.existing_title}`;
			if (!autoSaved.has(key)) continue;
			const rel = relLabel(conn.relation, this.plugin.settings.lang);
			const pct = Math.round((conn.confidence ?? 0.5) * 100);
			content.createEl('div', { cls: 'tb-chip is-saved', text: `[${pct}%] ${conn.new_title} ―${rel}→ ${conn.existing_title}` });
		}
	}

	// 인제스트 후 기존 노드 연결 후보 칩 UI
	private renderCrossConnectionChips(
		connections: CrossConnection[],
		newTitleToFile: Map<string, TFile>,
		existingTitleToFile: Map<string, TFile>,
		autoSaved: Set<string> = new Set(),
		preSelectFirst = false
	): void {
		const pending = connections.filter(c => !autoSaved.has(`${c.new_title}→${c.existing_title}`));
		const container = this.pipelineModal?.contentEl ?? this.resultsEl;
		const block = container.createEl('div', { cls: 'tb-block' });
		const toggle = block.createEl('div', { cls: 'tb-section-toggle' });
		toggle.createEl('span', { cls: 'tb-section-chevron', text: '▾' });
		const labelEl = toggle.createEl('span', { cls: 'tb-section-label', text: `${this.t('conn_pending_prefix')}${pending.length}${this.t('conn_pending_suffix')}` });
		const content = block.createEl('div', { cls: 'tb-section-content' });
		toggle.addEventListener('click', () => {
			const collapsed = content.hasClass('is-collapsed');
			content.toggleClass('is-collapsed', !collapsed);
			toggle.querySelector<HTMLElement>('.tb-section-chevron')!.textContent = collapsed ? '▾' : '▸';
		});

		content.createEl('div', { cls: 'tb-hint', text: preSelectFirst ? this.t('conn_auto_select_hint') : this.t('conn_manual_hint') });

		const chipRow = content.createEl('div', { cls: 'tb-edge-chips' });
		const states: Array<{ conn: CrossConnection; selected: boolean }> = [];
		let locked = false;

		for (let i = 0; i < pending.length; i++) {
			const conn = pending[i];
			const rel = relLabel(conn.relation, this.plugin.settings.lang);
			const pct = Math.round((conn.confidence ?? 0.5) * 100);
			const initSelected = preSelectFirst && i === 0;
			const chip = chipRow.createEl('div', { cls: `tb-chip${initSelected ? ' is-selected' : ''}` });
			const top  = chip.createEl('div', { cls: 'tb-chip-top' });
			const icon = top.createEl('span', { cls: 'tb-chip-icon', text: initSelected ? '✓' : '◎' });
			top.createEl('span', { cls: 'tb-chip-conf', text: `[${pct}%]` });
			top.createEl('span', { cls: 'tb-chip-source', text: shortText(conn.new_title, 14) });
			top.createEl('span', { cls: 'tb-chip-arrow', text: ` ―${rel}→ ` });
			top.createEl('span', { cls: 'tb-chip-target', text: conn.existing_title });
			if (conn.reason) chip.createEl('div', { cls: 'tb-chip-reason', text: conn.reason });

			const state = { conn, selected: initSelected };
			states.push(state);
			chip.addEventListener('click', () => {
				if (locked) return;
				state.selected = !state.selected;
				chip.toggleClass('is-selected', state.selected);
				icon.textContent = state.selected ? '✓' : '◎';
			});
		}

		const bar = block.createEl('div', { cls: 'tb-savebar' });
		const saveBtn = bar.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_save_connection') });
		saveBtn.addEventListener('click', () => void (async () => {
			const selected = states.filter(s => s.selected);
			if (selected.length === 0) { new Notice(this.t('notice_no_selection')); return; }
			locked = true;
			chipRow.addClass('is-locked');
			saveBtn.disabled = true; saveBtn.textContent = this.t('btn_saving');
			try {
				for (const { conn } of selected) {
					const newFile = newTitleToFile.get(conn.new_title);
					const existFile = existingTitleToFile.get(conn.existing_title);
					if (!newFile || !existFile) continue;
					await this.saveCrossEdge(conn, newFile, existFile);
				}
				new Notice(`${this.t('conn_saved_notice')}${selected.length}${this.t('conn_saved_notice_suffix')}`);
				bar.remove();
				labelEl.textContent = `✓ ⑨ ${selected.length}${this.t('conn_saved_label_suffix')}`;
			} catch (err) {
				locked = false;
				chipRow.removeClass('is-locked');
				saveBtn.disabled = false; saveBtn.textContent = this.t('btn_save_connection');
				new Notice(`${this.t('save_error_notice_prefix')}${err instanceof Error ? err.message : String(err)}`);
			}
		})());
	}

	// ── Context ↔ Proposition 후생성 ───────────────────────

	/**
	 * 저장된 Context와 Proposition 노드들을 연결
	 * - 명제의 context 필드 기반: context → proposition (정보 제공)
	 * - 역방향: proposition → context (뒷받침)
	 * - 크로스-컨텍스트도 자유롭게 연결
	 */
	private async connectContextsToPropositions(
		contexts: ContextLayer[],
		propositions: Proposition[],
		contextFileMap: Map<string, TFile>,
		propFileMap: Map<string, TFile>
	) {
		for (const prop of propositions) {
			const propFile = propFileMap.get(prop.id);
			if (!propFile) continue;

			// Step 1: 명제의 context 필드가 있으면 해당 Context와 연결
			if (prop.context) {
				const ctxFile = contextFileMap.get(prop.context);
				if (ctxFile) {
					// context → proposition: precondition_of (문맥이 명제의 존재 전제)
					await this.store.confirmEdge(ctxFile, {
						target: `[[${propFile.basename}]]`,
						label: 'precondition_of',
						confirmed: true,
						reason: `이 문맥에서 추출된 명제`,
						confidence: 1.0,
						axiom_basis: '파이프라인 자동 연결',
					});

					// proposition → context: supports (문맥을 뒷받침)
					await this.store.confirmEdge(propFile, {
						target: `[[${ctxFile.basename}]]`,
						label: 'supports',
						confirmed: true,
						reason: `"${prop.context}" 문맥의 근거`,
						confidence: 1.0,
						axiom_basis: '파이프라인 자동 연결',
					});
				}
			}

			// Step 2: 모든 Context에 대해 연결 검토
			// (명제가 다른 context와도 관련 있을 수 있음)
			for (const ctx of contexts) {
				if (ctx.title === prop.context) continue; // Step 1에서 처리함

				const ctxFile = contextFileMap.get(ctx.title);
				if (!ctxFile) continue;

				// 크로스-컨텍스트 연결은 추후 분석 단계에서 처리
				// (여기서는 명제의 문맥 필드만 기반)
			}
		}
	}

	// ── 9-3: 리포트 저장 ─────────────────────────────────

	private async saveReport(
		insights: Insight[],
		logic: LogicLayer,
		selectedRecs: EdgeCandidate[],
		targetFolder = ''
	) {
		const now = new Date();
		const date = now.toISOString().split('T')[0];
		const title = insights[0]?.title ?? logic.propositions[0]?.title ?? '인제스트 리포트';

		const lines: string[] = [
			'---',
			`tb_type: report`,
			`tb_created: "${now.toISOString()}"`,
			'---',
			'',
			`# ${title}`,
			'',
		];

		if (insights.length > 0) {
			lines.push('## ⬡ 핵심 인사이트', '');
			for (const ins of insights) {
				lines.push(`**${ins.title}**  `, ins.why_central, '');
			}
		}

		const regularProps = logic.propositions.filter(p => !p.id.startsWith('ins'));
		if (regularProps.length > 0) {
			lines.push('## 명제 논리망', '');
			for (const p of regularProps) {
				lines.push(`- **[${p.role}]** ${p.title}: ${p.text}`);
			}
			lines.push('');
		}

		if (logic.edges.length > 0) {
			lines.push('## 논리 엣지', '');
			const byId = new Map(logic.propositions.map(p => [p.id, p]));
			for (const e of logic.edges) {
				const s = byId.get(e.source);
				const t = byId.get(e.target);
				if (s && t) lines.push(`- ${s.title} →[${e.relation}]→ ${t.title}: ${e.reason}`);
			}
			lines.push('');
		}

		if (selectedRecs.length > 0) {
			lines.push('## 볼트 연결 추천', '');
			for (const rec of selectedRecs) {
				lines.push(`- ${rec.source_node || '?'} →[${rec.label}]→ ${rec.target_file}: ${rec.reason}`);
			}
			lines.push('');
		}

		const content = lines.join('\n');
		const fileName = `리포트-${date}-${sanitizeId(title)}.md`;
		const path = targetFolder ? `${targetFolder}/${fileName}` : fileName;

		try {
			await this.app.vault.create(path, content);
			new Notice(`${this.t('notice_analysis_saved_prefix')}${fileName}`);
		} catch (e) {
			new Notice(`${this.t('save_error_prefix')}${e instanceof Error ? e.message : String(e)}`);
			throw e;
		}
	}

	// ── 그래프 뷰 자동 열기 ──────────────────────────────────

	/**
	 * 저장 완료 후 그래프 뷰를 자동으로 열기
	 * 해당 폴더를 자동 선택
	 */
	private openGraphViewWithFolder(folderPath: string) {
		try {
			// 폴더가 비어있으면 루트
			const folder = folderPath || '';

			// openNativeGraph를 직접 호출 (폴더 선택 모달 생략)
			void this.openNativeGraph([folder]);

			new Notice(`📊 그래프 뷰 열기: ${folderPath || '루트'}`);
		} catch {
			// 실패해도 사용자가 수동으로 열 수 있음
		}
	}

	// ── 8-2: 폴더 분석 실행 ──────────────────────────────

	private async runFolderAnalysis(folderPath: string, mode: 'rich' | 'summary', intent?: string, includeActions?: boolean) {
		this.resultsEl.empty();
		this.setAIBusy(true);
		this.setProgress(5, `${this.t('analysis_progress_label')} (${mode === 'rich' ? this.t('analysis_depth_rich') : this.t('analysis_depth_summary')})`);

		const folder = this.app.vault.getFolderByPath(folderPath);
		if (!folder) {
			new Notice('[ThirdBrain] 폴더를 찾을 수 없습니다.');
			this.setAIBusy(false);
			this.hideProgress();
			return;
		}

		const readFilesFromFolder = async (files: unknown[], nodeType?: string): Promise<FolderDigestNode[]> => {
			const result: FolderDigestNode[] = [];
			for (const child of files) {
				if (!(child instanceof TFile) || child.extension !== 'md') continue;
				const raw = await this.app.vault.cachedRead(child);
				const cache = this.app.metadataCache.getFileCache(child);
				const fm = cache?.frontmatter;
				const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
				result.push({
					title: (fm?.tb_title as string | undefined) ?? child.basename,
					content: body.slice(0, 300),
					nodeType: nodeType ?? (fm?.tb_type as string | undefined) ?? 'claim',
					edges: Array.isArray(fm?.tb_edges)
						? (fm.tb_edges as unknown[]).slice(0, 3).map((e: unknown) => {
							const edge = e as Record<string, unknown>;
							return {
								target: (typeof edge.target === 'string' ? edge.target : '').replace(/^\[\[|\]\]$/g, ''),
								relation: typeof edge.label === 'string' ? edge.label : 'supports',
								reason: typeof edge.reason === 'string' ? edge.reason : '',
							};
						})
						: [],
				});
			}
			return result;
		};

		const nodes: FolderDigestNode[] = await readFilesFromFolder(folder.children);

		if (includeActions) {
			const actionsFolder = this.app.vault.getFolderByPath(`${folderPath}/_actions`);
			if (actionsFolder) {
				const actionNodes = await readFilesFromFolder(actionsFolder.children, 'action');
				nodes.push(...actionNodes);
			}
		}

		if (nodes.length === 0) {
			new Notice('[ThirdBrain] 폴더에 마크다운 파일이 없습니다.');
			this.setAIBusy(false);
			this.hideProgress();
			return;
		}

		try {
			const result = await summarizeFolder(nodes, this.plugin.settings, mode, intent);
			this.hideProgress();
			this.setAIBusy(false);
			this.renderSummaryResult(result, folderPath, mode, intent);
		} catch (e) {
			this.hideProgress();
			this.setAIBusy(false);
			new Notice(`[ThirdBrain] 분석 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ── 8-2: 폴더 분석 결과 렌더링 ─────────────────────────

	private renderSummaryResult(result: SummaryResult, folderPath: string, mode?: 'rich' | 'summary', intent?: string) {
		this.resultsEl.empty();

		// 인라인: synthesis 요약 + 버튼만
		const doneCard = this.resultsEl.createEl('div', { cls: 'tb-block tb-analysis-done-card' });
		doneCard.createEl('div', { cls: 'tb-analysis-done-folder', text: `📊 ${folderPath}` });
		if (result.synthesis) {
			doneCard.createEl('div', { cls: 'tb-analysis-done-synthesis', text: result.synthesis });
		}
		const btnRow = doneCard.createEl('div', { cls: 'tb-analysis-done-actions' });
		const openBtn = btnRow.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_view_all') });

		const openModal = () => {
			new AnalysisResultModal(this.app, result, folderPath, mode, intent, () => {
				void this.saveAnalysisResult(result, folderPath, openBtn, mode, intent);
			}, this.plugin.settings.lang).open();
		};
		openBtn.addEventListener('click', openModal);

		// 분석 완료 즉시 모달 오픈
		openModal();
	}

	// 🆕 분석 결과 저장 — ThirdBrainRoot/분석/ 자동 사용
	private async saveAnalysisResult(
		result: SummaryResult,
		sourceFolderPath: string,
		saveBtn: HTMLButtonElement,
		mode?: 'rich' | 'summary',
		intent?: string
	) {
		saveBtn.disabled = true;
		const originalText = saveBtn.textContent;
		saveBtn.textContent = this.t('btn_saving');

		const targetFolderPath = `${this.plugin.settings.rootFolder}/분석`;

		try {
			// 폴더 없으면 자동 생성
			if (!this.app.vault.getFolderByPath(targetFolderPath)) {
				await this.app.vault.createFolder(targetFolderPath);
			}

			const timestamp = new Date().toISOString().slice(0, 10);
			const modeTag = mode === 'rich' ? 'deep' : 'summary';
			const intentTag = intent
				? `_${intent.slice(0, 12).replace(/[\\/:*?"<>|#\s]/g, '')}`
				: '';
			const filename = `graph-analysis_${sourceFolderPath.replace(/\//g, '_')}_${modeTag}${intentTag}_${timestamp}.md`;
			const filepath = `${targetFolderPath}/${filename}`;

			const modeLabel = mode === 'rich' ? this.t('analysis_depth_rich') : this.t('analysis_depth_summary');
			let content = `# 📊 Graph Analysis Result\n\n`;
			content += `${this.t('ar_target_label')}: ${sourceFolderPath}\n`;
			content += `${this.t('ar_mode_label')}: ${modeLabel}${intent ? ` · ${intent}` : ''}\n`;
			content += `${this.t('ar_date_label')}: ${new Date().toLocaleString()}\n\n`;

			if (result.synthesis) {
				content += `## 종합 결론\n\n${result.synthesis}\n\n`;
			}

			if (result.overview) {
				content += `## 개요\n\n${result.overview}\n\n`;
			}

			if (result.themes.length > 0) {
				content += `## 🏷 주제 묶음 (${result.themes.length}개)\n\n`;
				for (const theme of result.themes) {
					content += `### ${theme.title}\n${theme.description}\n\n`;
				}
			}

			if (result.highlights.length > 0) {
				content += `## 💡 주요 통찰\n\n`;
				for (const h of result.highlights) {
					content += `- ${h}\n`;
				}
				content += '\n';
			}

			if (result.link_contexts.length > 0) {
				content += `## 🔗 연결 맥락\n\n`;
				for (const lc of result.link_contexts) {
					content += `**${lc.source} → ${lc.target}** (${lc.relation})\n`;
					content += `${lc.context}\n\n`;
				}
			}

			const file = await this.app.vault.create(filepath, content);
			saveBtn.textContent = this.t('btn_save_done');
			new Notice(`${this.t('notice_analysis_saved_prefix')}${filename}`);

			// 🆕 저장된 파일 자동 열기
			window.setTimeout(() => {
				void this.app.workspace.getLeaf().openFile(file);
			}, 300);
		} catch (e) {
			saveBtn.disabled = false;
			saveBtn.textContent = originalText;
			new Notice(`${this.t('notice_analysis_save_fail')}${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ── UI 유틸 ──────────────────────────────────────────

	/** 접기/펼치기 섹션 블록 생성 — 모달이 열려 있으면 모달에, 없으면 resultsEl에 */
	private makeSectionToggle(label: string, collapsed: boolean): {
		block: HTMLElement; content: HTMLElement;
	} {
		const container = this.pipelineModal?.contentEl ?? this.resultsEl;
		const block = container.createEl('div', { cls: 'tb-block' });
		const toggle = block.createEl('div', { cls: 'tb-section-toggle' });
		const chevron = toggle.createEl('span', { cls: 'tb-section-chevron', text: collapsed ? '▸' : '▾' });
		toggle.createEl('span', { cls: 'tb-section-label', text: label });
		const content = block.createEl('div', { cls: 'tb-section-content' });
		if (collapsed) content.addClass('is-collapsed');

		toggle.addEventListener('click', () => {
			const now = content.hasClass('is-collapsed');
			content.toggleClass('is-collapsed', !now);
			chevron.textContent = now ? '▾' : '▸';
		});
		return { block, content };
	}

	/** 단순 저장 바 (skip + save 버튼) */
	private makeSaveBar(
		parent: HTMLElement,
		skipLabel: string,
		saveLabel: string,
		onSave: () => Promise<void>
	) {
		const bar = parent.createEl('div', { cls: 'tb-savebar' });
		const skipBtn = bar.createEl('button', { cls: 'tb-btn', text: skipLabel });
		const saveBtn = bar.createEl('button', { cls: 'tb-btn is-primary', text: saveLabel });

		skipBtn.addEventListener('click', () => { /* no-op */ });
		saveBtn.addEventListener('click', () => void (async () => {
			saveBtn.disabled = true; skipBtn.disabled = true;
			saveBtn.textContent = this.t('btn_saving');
			try {
				await onSave();
				saveBtn.textContent = this.t('btn_save_done');
			} catch (e) {
				saveBtn.textContent = this.t('btn_save_fail');
				saveBtn.disabled = false;
				new Notice(`${this.t('save_error_prefix')}${e instanceof Error ? e.message : String(e)}`);
			}
		})());
	}

	// ── 상태 헬퍼 ────────────────────────────────────────

	// 버튼 비활성 규칙 (독립 3축 — CLAUDE.md "버튼 Busy 규칙" 참조):
	//   생성(ingest)        : _busyAI || _busyBridge || _busyIngest
	//   분석(analysis)      : _busyIngest || _busyBridge  (AI 백그라운드는 허용)
	//   연결(bridge)        : _busyAI || _busyIngest || _busyBridge
	//   그래프분석-AI분석   : _busyAI || _busyIngest || _busyBridge
	private _busyAI     = false;   // 백그라운드 AI (전사본·그래프 분석 등)
	private _busyIngest = false;   // 생성 파이프라인
	private _busyBridge = false;   // 연결 파이프라인

	private updateBusyUI() {
		this.ingestBtn.toggleClass('is-busy', this._busyIngest);
		this.ingestBtn.disabled = this._busyAI || this._busyBridge || this._busyIngest;
		if (this._busyIngest) {
			this.ingestBtn.textContent = this.t('progress_chunk');
		} else {
			this.ingestBtn.textContent = this.t('btn_generate');
			if (!this._busyAI && !this._busyBridge) this.syncIngestBtnState();
		}
		this.analysisBtn.disabled = this._busyIngest || this._busyBridge;
		this.bridgeBtn.disabled = this._busyAI || this._busyIngest || this._busyBridge;
	}

	private setAIBusy(on: boolean)     { this._busyAI     = on; this.updateBusyUI(); }
	private setIngestBusy(on: boolean) { this._busyIngest = on; this.updateBusyUI(); }
	private setBridgeBusy(on: boolean) { this._busyBridge = on; this.updateBusyUI(); }

	private updateCharCount() {
		const len = this.ingestTextarea.value.length;
		this.charCountEl.textContent = `${len}${this.t('char_suffix')}`;
	}

	private syncIngestBtnState() {
		if (this._busyAI || this._busyIngest || this._busyBridge) return;
		const empty = this.ingestTextarea.value.trim().length === 0;
		this.ingestBtn.disabled = empty;
		this.ingestBtn.toggleClass('is-empty', empty);
	}

	private setProgress(filled: number, msg: string) {
		this.progressEl.addClass('is-visible');
		this.progressBarEl.textContent = progressBar(filled);
		this.progressMsgEl.textContent = msg;
	}

	private hideProgress() {
		this.progressEl.removeClass('is-visible');
	}

	private vaultCountText(): string {
		return `vault: ${this.app.vault.getMarkdownFiles().length} files`;
	}

	private refreshUsageBar() {
		const s = getSessionStats();
		if (s.callCount === 0) { this.usageEl.textContent = '─'; return; }
		const inK  = s.inputTokens  > 0 ? ` · in ${(s.inputTokens  / 1000).toFixed(1)}k`  : '';
		const outK = s.outputTokens > 0 ? ` · out ${(s.outputTokens / 1000).toFixed(1)}k` : '';
		const cost = s.costUsd       > 0 ? ` · $${s.costUsd.toFixed(4)}` : '';
		this.usageEl.textContent = `Claude 세션: ${s.callCount}회 호출${inK}${outK}${cost}`;
	}

	// ── 폴더 목록 수집 ──────────────────────────────────────

	private getFolderPaths(): string[] {
		const root = this.plugin.settings.rootFolder;
		type VaultWithGetAllFolders = { getAllFolders?: () => Array<{ path: string }> };
		const vaultExt = this.app.vault as unknown as VaultWithGetAllFolders;
		let all: string[];
		if (vaultExt.getAllFolders) {
			all = vaultExt.getAllFolders()
				.map(f => f.path)
				.filter(p => p && p !== '/');
		} else {
			const set = new Set<string>();
			for (const f of this.app.vault.getMarkdownFiles()) {
				let p = f.parent?.path ?? '';
				while (p && p !== '/') {
					set.add(p);
					const parts = p.split('/');
					parts.pop();
					p = parts.join('/');
				}
			}
			all = [...set];
		}
		// rootFolder 자신 + 그 하위 폴더만 반환
		return all
			.filter(p => p === root || p.startsWith(root + '/'))
			.sort();
	}

	private _graphOpening = false;

	private async openNativeGraphWithQuery(query: string): Promise<void> {
		if (this._graphOpening) return;
		this._graphOpening = true;
		try { await this._applyNativeGraphQuery(query); }
		finally { this._graphOpening = false; }
	}

	private async _applyNativeGraphQuery(query: string): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType('graph')[0] ?? null;
		const leaf = existingLeaf ?? this.app.workspace.getLeaf('tab');
		if (!existingLeaf) await leaf.setViewState({ type: 'graph', active: true });
		void this.app.workspace.revealLeaf(leaf);
		const t0 = Date.now();
		for (const ms of [200, 500, 1000, 1800]) {
			if (Date.now() - t0 < ms) await new Promise<void>(r => window.setTimeout(r, ms - (Date.now() - t0)));
			if (leaf.view?.getViewType() !== 'graph') break;
			const v = leaf.view as unknown as {
				getState?: () => { settings?: Record<string, unknown> };
				setState?: (s: unknown, o: unknown) => Promise<void>;
				renderer?: { changed?: () => void; filterOptions?: { search?: string | { query?: string } } };
			};
			try {
				const cur = v.getState?.()?.settings ?? {};
				await v.setState?.({ settings: { ...cur, search: query } }, { history: false });
				v.renderer?.changed?.();
				break;
			} catch { /* retry */ }
		}
	}

	/** Obsidian 네이티브 그래프 뷰를 새 탭으로 열고 path 필터 주입 (v0 포팅) */
	private async openNativeGraph(folders: string[], excludeConflicts = false): Promise<void> {
		// 동시 중복 호출 방지 — 파이프라인 자동 오픈과 수동 클릭 경쟁 방지
		if (this._graphOpening) return;
		this._graphOpening = true;
		try { await this._openNativeGraphImpl(folders, excludeConflicts); }
		finally { this._graphOpening = false; }
	}

	private async _openNativeGraphImpl(folders: string[], excludeConflicts: boolean): Promise<void> {
		let excludePaths: Set<string> = new Set();
		if (excludeConflicts) {
			const allNodes = (await Promise.all(folders.map(f => this.store.loadNodesInFolder(f)))).flat();
			for (const node of allNodes) {
				for (const edge of node.edges) {
					if (edge.label === 'conflicts_with') {
						// conflicts_with 엣지의 source 와 target 양쪽 파일 경로 수집
						excludePaths.add(node.filePath);
						const targetName = edge.target.replace(/^\[\[/, '').replace(/\]\]$/, '');
						const targetNode = allNodes.find(n => n.title === targetName || n.filePath.replace(/\.md$/, '') === targetName);
						if (targetNode) excludePaths.add(targetNode.filePath);
					}
				}
			}
		}

		const includeQuery = folders.map(f => `path:"${f}"`).join(' OR ');
		const excludeQuery = [...excludePaths].map(p => `-path:"${p}"`).join(' ');
		const query = excludePaths.size > 0 ? `(${includeQuery}) ${excludeQuery}` : includeQuery;
		// 기존 그래프 탭 재사용 — setViewState 재호출 시 발생하는 새로고침 방지
		const existingGraphLeaf = this.app.workspace.getLeavesOfType('graph')[0] ?? null;
		const leaf = existingGraphLeaf ?? this.app.workspace.getLeaf('tab');
		if (!existingGraphLeaf) {
			await leaf.setViewState({ type: 'graph', active: true });
		}
		void this.app.workspace.revealLeaf(leaf);

		const t0 = Date.now();
		let applied = false;

		for (const targetMs of [200, 500, 1000, 1800]) {
			if (applied) break;
			const wait = targetMs - (Date.now() - t0);
			if (wait > 0) await new Promise<void>(r => window.setTimeout(r, wait));
			if (leaf.view?.getViewType() !== 'graph') break;

			const v = leaf.view as unknown as {
				getState?: () => { settings?: Record<string, unknown> };
				setState?: (s: unknown, o: unknown) => Promise<void>;
				renderer?: { changed?: () => void; filterOptions?: { search?: string | { query?: string } } };
				engine?: { filterOptions?: { search?: string | { query?: string } } };
				graphEngine?: { filterOptions?: { search?: string | { query?: string } } };
				containerEl?: HTMLElement;
			};

			// 방법 1: setState API
			try {
				const cur = v.getState?.()?.settings ?? {};
				await v.setState?.({ settings: { ...cur, search: query } }, { history: false });
				v.renderer?.changed?.();
				if (v.getState?.()?.settings?.search === query) { applied = true; break; }
			} catch { /* continue */ }

			// 방법 2: filterOptions 직접 조작
			try {
				const fo = v.renderer?.filterOptions ?? v.engine?.filterOptions ?? v.graphEngine?.filterOptions;
				if (fo != null) {
					if (typeof fo.search === 'string') fo.search = query;
					else if (fo.search != null) fo.search.query = query;
					v.renderer?.changed?.();
					applied = true; break;
				}
			} catch { /* continue */ }

			// 방법 3: 해당 leaf의 containerEl 내에서만 입력창 검색 (타 그래프 탭 오염 방지)
			try {
				if (v.containerEl) {
					const input = (v.containerEl).querySelector<HTMLInputElement>(
						'.graph-settings input, .search-input-container input, input[placeholder]'
					);
					if (input) {
						input.value = query;
						input.dispatchEvent(new Event('input', { bubbles: true }));
						applied = true; break;
					}
				}
			} catch { /* continue */ }
		}

		if (applied) {
			new Notice(`[ThirdBrain] 그래프 열림 (${folders.length}개 폴더)`);
		} else {
			try { await navigator.clipboard.writeText(query); } catch { /* ignore */ }
			new Notice(`[ThirdBrain] 그래프 검색창에 붙여넣기:\n${query}`);
		}
	}

	// ── Phase 5: 폴더 브리지 ─────────────────────────────

	// ── TB 노드 인제스트 → 브릿지 ──────────────────────────
	// vault 파일 1개가 TB 노드일 때 인제스트 버튼을 누르면 여기로 진입

	private async runBridgeFromIngest(sourceFile: TFile, targetFolder: string) {
		this.setBridgeBusy(true);
		this.resultsEl.empty();
		this.setProgress(2, `"${sourceFile.basename}" 복사 중...`);

		// 파일 복사 (원본 유지)
		const base = targetFolder ? `${targetFolder}/${sourceFile.name}` : sourceFile.name;
		let targetPath = base;
		if (this.app.vault.getFileByPath(targetPath)) {
			const stem = targetPath.replace(/\.md$/, '');
			let i = 2;
			while (this.app.vault.getFileByPath(`${stem}-${i}.md`)) i++;
			targetPath = `${stem}-${i}.md`;
		}

		let movedFile: TFile | null;
		try {
			if (targetFolder) {
				const folder = this.app.vault.getFolderByPath(targetFolder);
				if (!folder) await this.app.vault.createFolder(targetFolder);
			}
			const content = await this.app.vault.read(sourceFile);
			movedFile = await this.app.vault.create(targetPath, content);
		} catch (e) {
			this.hideProgress(); this.setBridgeBusy(false);
			new Notice(`[ThirdBrain] 파일 복사 실패: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (!movedFile) {
			this.hideProgress(); this.setBridgeBusy(false);
			new Notice('[ThirdBrain] 이동된 파일을 찾을 수 없습니다.');
			return;
		}

		this.setProgress(3, '노드 로드 중...');
		// vault.create 직후엔 메타데이터 캐시가 아직 파싱되지 않음 → changed 이벤트 대기
		const movedNode = await new Promise<import('./types').TBNode | null>(resolve => {
			// 이미 캐시에 있으면 즉시 반환
			const immediate = this.app.metadataCache.getFileCache(movedFile);
			if (immediate?.frontmatter) {
				void this.store.fileToNode(movedFile).then(resolve);
				return;
			}
			const timeout = window.setTimeout(() => {
				this.app.metadataCache.offref(ref);
				void this.store.fileToNode(movedFile).then(resolve);
			}, 3000);
			const ref = this.app.metadataCache.on('changed', (changedFile) => {
				if (changedFile.path === movedFile.path) {
					window.clearTimeout(timeout);
					this.app.metadataCache.offref(ref);
					void this.store.fileToNode(movedFile).then(resolve);
				}
			});
		});
		if (!movedNode) {
			this.hideProgress(); this.setBridgeBusy(false);
			new Notice('[ThirdBrain] 노드 메타데이터를 읽을 수 없습니다.');
			return;
		}

		const targetNodes = (await this.store.loadNodesInFolder(targetFolder))
			.filter(n => n.filePath !== movedFile.path);

		if (targetNodes.length === 0) {
			this.hideProgress(); this.setBridgeBusy(false);
			new Notice(`✅ 이식 완료: ${movedFile.basename} → ${targetFolder || '루트'} (연결 후보 없음)`);
			this.ingestTextarea.value = '';
			this.updateCharCount();
			return;
		}

		this.setProgress(5, `연결 후보 분석 중... (${targetNodes.length}개 노드)`);

		try {
			// 소스 노드: 본문 + 태그 + 요약 + 기존 엣지 타이틀 (한 문장 명제도 충분한 컨텍스트 확보)
			const existingEdgeTitles = movedNode.edges
				.map(e => e.target.replace(/^\[\[|\]\]$/g, ''))
				.filter(Boolean);
			const enrichedSource = [
				movedNode.content,
				movedNode.tags.length          ? `태그: ${movedNode.tags.join(', ')}` : '',
				movedNode.summary              ? `요약: ${movedNode.summary}` : '',
				existingEdgeTitles.length      ? `기존 연결 노드: ${existingEdgeTitles.join(', ')}` : '',
			].filter(Boolean).join('\n');

			// 대상 노드: 본문 + 태그 + 기존 연결 타이틀 (의미 클러스터 힌트)
			const nodeSnippets = targetNodes.map(n => {
				const connectedTitles = n.edges
					.map(e => e.target.replace(/^\[\[|\]\]$/g, ''))
					.filter(Boolean)
					.slice(0, 6);
				return {
					title: n.title,
					content: [
						n.content,
						n.tags.length         ? `태그: ${n.tags.join(', ')}` : '',
						connectedTitles.length ? `연결 노드: ${connectedTitles.join(', ')}` : '',
					].filter(Boolean).join('\n'),
				};
			});

			const candidates = await recommendTransplantEdges(
				enrichedSource, movedNode.title, nodeSnippets,
				this.plugin.settings,
				(msg) => this.setProgress(7, msg)
			);

			this.hideProgress(); this.setBridgeBusy(false);
			this.ingestTextarea.value = '';
			this.updateCharCount();
			await this.renderSingleNodeBridge(movedFile, movedNode.title, candidates, targetNodes);
		} catch (e) {
			this.hideProgress(); this.setBridgeBusy(false);
			new Notice(`[ThirdBrain] 브릿지 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ── Phase 5: 폴더 브리지 실행 ──────────────────────────

	private async runBridgeWithFolders(folderAPath: string | string[], folderBPath: string | string[]) {
		const foldersA = Array.isArray(folderAPath) ? folderAPath : [folderAPath];
		const foldersB = Array.isArray(folderBPath) ? folderBPath : [folderBPath];
		this.resultsEl.empty();
		this.setBridgeBusy(true);

		this.setProgress(2, '폴더 노드 로드 중...');

		try {
			const [tbNodesA, tbNodesB] = await Promise.all([
				Promise.all(foldersA.map(f => this.store.loadNodesInFolder(f))).then(r => r.flat()),
				Promise.all(foldersB.map(f => this.store.loadNodesInFolder(f))).then(r => r.flat()),
			]);

			if (tbNodesA.length === 0 || tbNodesB.length === 0) {
				this.resultsEl.createEl('div', {
					cls: 'tb-error-msg',
					text: this.t('label_no_propositions'),
				});
				this.hideProgress();
				this.setBridgeBusy(false);
				return;
			}

			// fileMap: 파일명 → TFile (saveBridgeEdges 호환) + 제목 → TFile (LLM 응답 매핑)
			const fileMapA = new Map<string, TFile>();
			const fileMapB = new Map<string, TFile>();

			for (const node of tbNodesA) {
				const f = this.app.vault.getFileByPath(node.filePath);
				if (f) { fileMapA.set(f.name, f); fileMapA.set(node.title, f); }
			}

			for (const node of tbNodesB) {
				const f = this.app.vault.getFileByPath(node.filePath);
				if (f) { fileMapB.set(f.name, f); fileMapB.set(node.title, f); }
			}

			this.setProgress(4, `위상 분석 중... (A: ${tbNodesA.length}개, B: ${tbNodesB.length}개)`);

			// Phase 12: 새 bridgeFolders 시그니처 사용 + onProgress 콜백
			const folderAName = foldersA.map(f => f.split('/').pop()).join(', ');
			const folderBName = foldersB.map(f => f.split('/').pop()).join(', ');

			const result = await bridgeFolders(
				tbNodesA,
				tbNodesB,
				folderAName,
				folderBName,
				this.plugin.settings,
				undefined,
				(msg) => this.setProgress(6, msg)
			);

			this.hideProgress();
			this.setBridgeBusy(false);
			new BridgeResultModal(
				this.app, result,
				fileMapA, fileMapB,
				folderAName, folderBName,
				this.store, this.plugin.settings.lang,
				(folders) => { void this.openNativeGraph([`${this.plugin.settings.rootFolder}/raw`, ...folders], true); }
			).open();
		} catch (e) {
			this.hideProgress();
			this.setBridgeBusy(false);
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`[ThirdBrain] ${this.t('save_error_prefix')}${msg}`);
			this.resultsEl.createEl('div', { cls: 'tb-error-msg', text: `${this.t('error_title')}: ${msg}` });
		}
	}

	// ── 단일 노드 브릿지 결과 렌더 ──────────────────────────
	// recommendTransplantEdges 결과 → 칩 UI (confidence 표시, auto 모드 지원)

	private async renderSingleNodeBridge(
		movedFile: TFile,
		sourceTitle: string,
		candidates: Array<{ target_title: string; relation: string; confidence?: number; reason: string }>,
		targetNodes: import('./types').TBNode[]
	) {
		new SingleNodeBridgeModal(
			this.app,
			movedFile,
			sourceTitle,
			candidates,
			targetNodes,
			this.plugin.settings.lang,
		).open();
	}

}

// ── 파이프라인 결과 모달 ──────────────────────────────────

class PipelineInfoModal extends Modal {
	stepLogEl!: HTMLElement;
	private t: (key: TKey) => string;

	constructor(app: App, lang?: import('./i18n').Lang) {
		super(app);
		this.t = getT(lang);
	}

	onOpen() {
		this.modalEl.addClass('tb-pipeline-modal');
		this.titleEl.setText(this.t('label_pipeline_result'));

		// 최초 open 시에만 stepLogEl 생성 (재오픈 시 이미 존재)
		if (!this.stepLogEl) {
			this.stepLogEl = this.contentEl.createEl('div', { cls: 'tb-step-log' });
		}

		this.contentEl.addClass('tb-pipeline-modal-body');
	}

	onClose() { /* 내용 유지 — 다음 파이프라인 실행 시 새 인스턴스로 교체됨 */ }
}

// ── 그래프 쿼리 모달 ──────────────────────────────────────

const PRESET_QUERIES: Array<{ key: TKey; relations: string[] }> = [
	{ key: 'modal_query_preset_causal',     relations: ['causes', 'precedes', 'precondition_of'] },
	{ key: 'modal_query_preset_evidence',   relations: ['supports', 'conflicts_with', 'contrasts_with'] },
	{ key: 'modal_query_preset_hierarchy',  relations: ['exemplifies', 'applies_to'] },
	{ key: 'modal_query_preset_structural', relations: ['analogous_to', 'isomorphic_to'] },
];

// ── Canvas 그래프 모달 ────────────────────────────────────

class GraphCanvasModal extends Modal {
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

class GraphViewModal extends Modal {
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

		const paneNative = contentEl.createEl('div', { cls: 'tb-analysis-tab-pane' });
		const paneCanvas = contentEl.createEl('div', { cls: 'tb-analysis-tab-pane' });
		paneCanvas.hide();

		tabNative.addEventListener('click', () => {
			tabNative.addClass('is-active'); tabCanvas.removeClass('is-active');
			paneNative.show(); paneCanvas.hide();
		});
		tabCanvas.addEventListener('click', () => {
			tabCanvas.addClass('is-active'); tabNative.removeClass('is-active');
			paneCanvas.show(); paneNative.hide();
		});

		this.buildNativePane(paneNative);
		this.buildCanvasPane(paneCanvas);
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

	onClose() { this.contentEl.empty(); }
}

// ── 폴더 브리지 모달 ──────────────────────────────────────

class BridgeModal extends Modal {
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

class BridgeResultModal extends Modal {
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

// ── 콘텐츠 타입 선택 모달 ────────────────────────────────

class ContentTypeModal extends Modal {
	private resolved = false;
	private lang: Lang;

	constructor(
		app: App,
		private onSelect: (includeAction: boolean | null, meetingType?: MeetingType) => void,
		lang?: Lang
	) {
		super(app);
		this.lang = lang ?? 'en';
	}

	private t(key: TKey): string { return getT(this.lang)(key); }

	private resolve(value: boolean | null, meetingType?: MeetingType) {
		if (this.resolved) return;
		this.resolved = true;
		this.onSelect(value, meetingType);
	}

	onOpen() {
		this.modalEl.addClass('tb-popup');
		this.renderTypeScreen();
	}

	private renderTypeScreen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_content_type_title') });
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_content_type_sub') });

		const row = contentEl.createEl('div', { cls: 'tb-content-type-modal-row' });
		const btnInfo = row.createEl('button', { cls: 'tb-content-type-btn', text: this.t('modal_content_type_info') });
		const btnAction = row.createEl('button', { cls: 'tb-content-type-btn', text: this.t('modal_content_type_action') });

		btnInfo.addEventListener('click', () => { this.resolve(false); this.close(); });
		btnAction.addEventListener('click', () => { this.renderSubtypeScreen(); });
	}

	private renderSubtypeScreen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_content_type_subtype_title') });
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_content_type_subtype_sub') });

		const row = contentEl.createEl('div', { cls: 'tb-content-type-modal-row' });
		const types: Array<{ key: TKey; val: MeetingType }> = [
			{ key: 'modal_content_type_brainstorm', val: 'brainstorm' },
			{ key: 'modal_content_type_execution',  val: 'execution' },
			{ key: 'modal_content_type_review',     val: 'review' },
		];
		for (const { key, val } of types) {
			const btn = row.createEl('button', { cls: 'tb-content-type-btn', text: this.t(key) });
			btn.addEventListener('click', () => { this.resolve(true, val); this.close(); });
		}

		const backBtn = contentEl.createEl('button', { cls: 'tb-btn tb-content-type-back-btn', text: '← 뒤로' });
		backBtn.addEventListener('click', () => { this.renderTypeScreen(); });
	}

	onClose() {
		this.contentEl.empty();
		this.resolve(null);
	}
}

// ── 저장 폴더 선택 모달 ──────────────────────────────────

class SaveFolderModal extends Modal {
	private folders: string[];
	private currentFolder: string;
	private onChoose: (folder: string) => void;
	private lang: Lang;
	private rootFolder: string;

	constructor(
		app: App,
		folders: string[],
		currentFolder: string,
		onChoose: (folder: string) => void,
		lang?: Lang,
		rootFolder = ''
	) {
		super(app);
		this.folders = folders;
		this.currentFolder = currentFolder;
		this.onChoose = onChoose;
		this.lang = lang ?? 'en';
		this.rootFolder = rootFolder;
		this.modalEl.addClass('tb-popup');
	}

	private t(key: TKey): string { return getT(this.lang)(key); }

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_save_folder_title') });
		makeDraggable(this.modalEl, titleEl);
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_save_folder_sub') });

		const list = contentEl.createEl('div', { cls: 'tb-popup-folder-list' });

		// rootFolder 자체는 선택 불가 — 서브폴더만 선택 가능
		let selected = (this.rootFolder && this.currentFolder === this.rootFolder) ? '' : this.currentFolder;

		const items: Array<{ el: HTMLElement; path: string }> = [];

		const updateSelected = () => {
			for (const item of items) {
				item.el.toggleClass('is-selected', item.path === selected);
			}
		};

		if (this.rootFolder) {
			// rootFolder 모드: 최상위 루트 아이템은 헤더 표시만 — 선택 불가
			const rootItem = list.createEl('div', { cls: 'tb-popup-folder-item tb-popup-folder-header' });
			rootItem.createEl('span', { cls: 'tb-popup-folder-icon', text: '🏠' });
			rootItem.createEl('span', { cls: 'tb-popup-folder-name', text: this.rootFolder });

			// rootFolder 하위 폴더 표시 (raw/ 제외, depth는 rootFolder 기준 상대 계산)
			const rootDepth = this.rootFolder.split('/').length;
			const rawPath = `${this.rootFolder}/raw`;
			for (const folder of this.folders) {
				if (folder === this.rootFolder) continue;
				if (folder === rawPath || folder.startsWith(rawPath + '/')) continue; // raw/ 숨김
				const depth = folder.split('/').length - rootDepth;
				const name = folder.split('/').pop() ?? folder;
				const item = list.createEl('div', { cls: 'tb-popup-folder-item' });
				item.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
				item.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
				item.createEl('span', { cls: 'tb-popup-folder-name', text: name });
				item.addEventListener('click', () => { selected = folder; updateSelected(); });
				items.push({ el: item, path: folder });
			}
		} else {
			// 레거시 모드: 볼트 루트 포함 전체 폴더 표시
			const rootItem = list.createEl('div', { cls: 'tb-popup-folder-item' });
			rootItem.createEl('span', { cls: 'tb-popup-folder-icon', text: '🏠' });
			rootItem.createEl('span', { cls: 'tb-popup-folder-name', text: this.t('modal_save_folder_root') });
			rootItem.addEventListener('click', () => { selected = ''; updateSelected(); });
			items.push({ el: rootItem, path: '' });

			for (const folder of this.folders) {
				const depth = folder.split('/').length - 1;
				const name = folder.split('/').pop() ?? folder;
				const item = list.createEl('div', { cls: 'tb-popup-folder-item' });
				item.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
				item.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
				item.createEl('span', { cls: 'tb-popup-folder-name', text: name });
				item.addEventListener('click', () => { selected = folder; updateSelected(); });
				items.push({ el: item, path: folder });
			}
		}

		updateSelected();

		// 새 폴더 만들기 (rootFolder 모드에서만)
		if (this.rootFolder) {
			const newFolderRow = contentEl.createEl('div', { cls: 'tb-popup-new-folder-row' });
			const newFolderInput = newFolderRow.createEl('input', {
				cls: 'tb-popup-new-folder-input',
				attr: { type: 'text', placeholder: this.t('modal_save_folder_new_placeholder') },
			});
			const newFolderBtn = newFolderRow.createEl('button', {
				cls: 'tb-btn tb-popup-new-folder-btn',
				text: this.t('modal_save_folder_new_btn'),
			});

			const createNewFolder = () => {
				const raw = newFolderInput.value.trim();
				if (!raw) return;
				const safeName = raw.replace(/[\\/:*?"<>|#^[\]]/g, '_').replace(/\s+/g, '_');
				const newPath = `${this.rootFolder}/${safeName}`;
				// 목록에 추가 + 선택
				const item = list.createEl('div', { cls: 'tb-popup-folder-item' });
				item.setCssStyles({ paddingLeft: '32px' });
				item.createEl('span', { cls: 'tb-popup-folder-icon', text: '↳' });
				item.createEl('span', { cls: 'tb-popup-folder-name', text: safeName });
				item.addEventListener('click', () => { selected = newPath; updateSelected(); });
				items.push({ el: item, path: newPath });
				selected = newPath;
				updateSelected();
				newFolderInput.value = '';
			};

			newFolderBtn.addEventListener('click', createNewFolder);
			newFolderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createNewFolder(); });
		}

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_cancel') })
			.addEventListener('click', () => this.close());
		footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_save') })
			.addEventListener('click', () => { this.close(); this.onChoose(selected); });
	}

	onClose() { this.contentEl.empty(); }
}

// ── 분석 탭 모달 (그래프 분석 + 경로 탐색) ──────────────────

class AnalysisTabbedModal extends Modal {
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

// ── 그래프 분석 모달 (경로 탐색 포함) ─────────────────────

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

// ── 분석 결과 모달 ─────────────────────────────────────────

class AnalysisResultModal extends Modal {
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



function makeDraggable(modalEl: HTMLElement, handle: HTMLElement): void {
	handle.addEventListener('mousedown', (e: MouseEvent) => {
		e.preventDefault();
		const rect = modalEl.getBoundingClientRect();
		modalEl.setCssStyles({ position: 'fixed', margin: '0', left: rect.left + 'px', top: rect.top + 'px', transform: 'none' });

		const dx = e.clientX - rect.left;
		const dy = e.clientY - rect.top;

		const onMove = (e: MouseEvent) => {
			modalEl.setCssStyles({ left: (e.clientX - dx) + 'px', top: (e.clientY - dy) + 'px' });
		};
		const onUp = () => {
			activeDocument.removeEventListener('mousemove', onMove);
			activeDocument.removeEventListener('mouseup', onUp);
		};
		activeDocument.addEventListener('mousemove', onMove);
		activeDocument.addEventListener('mouseup', onUp);
	});
}

// ── 단일 노드 연결 후보 팝업 ──────────────────────────────────

class SingleNodeBridgeModal extends Modal {
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

// ── 모순 해소 모달 ─────────────────────────────────────────────

class ConflictResolutionModal extends Modal {
	private ranks: EdgeRank[] = [];
	private rankLoading = true;

	constructor(
		app: App,
		private conflict: ConflictReport,
		private store: GraphStore,
		private settings: ThirdBrainSettings,
		private onResolved?: (msg: string) => void,
	) {
		super(app);
	}

	private get t() { return getT(this.settings.lang); }

	private get dimension(): 'fact_vs_fact' | 'claim_vs_claim' | 'fact_vs_claim' {
		const aIsFact = this.conflict.nodeA.proposition_type === 'fact';
		const bIsFact = this.conflict.nodeB.proposition_type === 'fact';
		if (aIsFact && bIsFact) return 'fact_vs_fact';
		if (!aIsFact && !bIsFact) return 'claim_vs_claim';
		return 'fact_vs_claim';
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('tb-popup-content', 'tb-conflict-modal');

		const dim = this.dimension;
		const titleKey = dim === 'fact_vs_fact' ? 'conflict_title_fact_fact'
			: dim === 'claim_vs_claim' ? 'conflict_title_claim_claim'
			: 'conflict_title_fact_claim';
		const descKey = dim === 'fact_vs_fact' ? 'conflict_desc_fact_fact'
			: dim === 'claim_vs_claim' ? 'conflict_desc_claim_claim'
			: 'conflict_desc_fact_claim';

		contentEl.createEl('h3', { text: this.t(titleKey), cls: 'tb-conflict-modal-title' });
		contentEl.createEl('p', { text: this.t(descKey), cls: 'tb-conflict-modal-desc' });

		// 충돌 요약
		const summary = contentEl.createEl('div', { cls: 'tb-conflict-summary' });
		summary.createEl('span', { cls: 'tb-conflict-node-a', text: this.conflict.nodeA.title });
		summary.createEl('span', { cls: 'tb-conflict-vs', text: ' ⟷ ' });
		summary.createEl('span', { cls: 'tb-conflict-node-b', text: this.conflict.nodeB.title });
		if (this.conflict.evidence) {
			const evidenceLabel = this.settings.lang === 'en' ? 'Evidence: ' : '근거: ';
			contentEl.createEl('div', { cls: 'tb-conflict-evidence', text: `${evidenceLabel}${this.conflict.evidence}` });
		}

		contentEl.createEl('hr');

		// ── 옵션 1: 엣지 재분류 ──────────────────────────────────
		const opt1Label = this.settings.lang === 'en'
			? 'Option 1 — Reclassify with a more accurate edge'
			: '옵션 1 — 더 정확한 엣지로 재분류';
		contentEl.createEl('div', { cls: 'tb-conflict-section-title', text: opt1Label });
		const rankArea = contentEl.createEl('div', { cls: 'tb-conflict-rank-area' });
		const loadingText = this.settings.lang === 'en' ? 'AI is analyzing the relation...' : 'AI가 관계를 분석 중...';
		const noRankText = this.settings.lang === 'en' ? 'No recommendation (conflict may be genuine)' : '추천 관계 없음 (모순이 실제일 수 있음)';
		const aiFailText = this.settings.lang === 'en' ? 'AI analysis failed' : 'AI 분석 실패';
		const loadingEl = rankArea.createEl('div', { cls: 'tb-conflict-loading', text: loadingText });

		const relLabels: Record<string, string> = this.settings.lang === 'en'
			? { causes: 'Causes', precedes: 'Precedes', precondition_of: 'Precondition', supports: 'Supports', contrasts_with: 'Contrasts', exemplifies: 'Exemplifies', applies_to: 'Applies to', analogous_to: 'Analogous', isomorphic_to: 'Isomorphic' }
			: { causes: '유발', precedes: '선행', precondition_of: '전제조건', supports: '뒷받침', contrasts_with: '대조', exemplifies: '예시', applies_to: '적용', analogous_to: '유사', isomorphic_to: '동형' };

		rankEdgeRelations(
			{ title: this.conflict.nodeA.title, content: this.conflict.nodeA.edges.map(e => e.reason).join(' ') },
			{ title: this.conflict.nodeB.title, content: this.conflict.nodeB.edges.map(e => e.reason).join(' ') },
			this.conflict.evidence,
			this.settings,
		).then(ranks => {
			this.ranks = ranks;
			this.rankLoading = false;
			loadingEl.remove();
			if (ranks.length === 0) {
				rankArea.createEl('div', { cls: 'tb-conflict-no-rank', text: noRankText });
				return;
			}
			for (const r of ranks) {
				const chip = rankArea.createEl('div', { cls: 'tb-conflict-rank-chip' });
				const pct = Math.round(r.confidence * 100);
				chip.createEl('span', { cls: 'tb-rank-label', text: relLabels[r.relation] ?? r.relation });
				chip.createEl('span', { cls: 'tb-rank-pct', text: `${pct}%` });
				if (r.reason) chip.createEl('span', { cls: 'tb-rank-reason', text: r.reason });
				chip.addEventListener('click', () => { void this.applyReclassify(r.relation, r.reason); });
			}
		}).catch(() => {
			loadingEl.setText(aiFailText);
		});

		contentEl.createEl('hr');

		// ── 옵션 2: 상위 노트 추가 ───────────────────────────────
		const opt2Label = this.settings.lang === 'en'
			? 'Option 2 — Add parent premise (precondition_of)'
			: '옵션 2 — 상위 개념 노트 추가 (precondition_of)';
		const parentPlaceholder = this.settings.lang === 'en' ? 'Enter parent concept title...' : '상위 개념 제목 입력...';
		const parentBtnLabel = this.settings.lang === 'en' ? 'Create & link note' : '노트 생성 후 연결';
		contentEl.createEl('div', { cls: 'tb-conflict-section-title', text: opt2Label });
		const parentArea = contentEl.createEl('div', { cls: 'tb-conflict-parent-area' });
		const parentInput = parentArea.createEl('input', {
			type: 'text',
			cls: 'tb-conflict-parent-input',
			placeholder: parentPlaceholder,
		});
		const parentBtn = parentArea.createEl('button', { cls: 'tb-btn', text: parentBtnLabel });
		parentBtn.addEventListener('click', () => {
			const title = parentInput.value.trim();
			if (!title) return;
			void this.applyAddParent(title);
		});

		contentEl.createEl('hr');

		// ── 옵션 3: 폐기 (차원별 레이블 분기) ───────────────────
		const opt3Label = this.settings.lang === 'en' ? 'Option 3 — Discard a proposition' : '옵션 3 — 한쪽 명제 폐기';
		contentEl.createEl('div', { cls: 'tb-conflict-section-title', text: opt3Label });
		const deleteArea = contentEl.createEl('div', { cls: 'tb-conflict-delete-area' });

		const aIsFact = this.conflict.nodeA.proposition_type === 'fact';
		const bIsFact = this.conflict.nodeB.proposition_type === 'fact';
		const delPrefixA = aIsFact ? this.t('conflict_delete_bad_data') : (bIsFact ? this.t('conflict_delete_claim') : this.t('conflict_delete_node'));
		const delPrefixB = bIsFact ? this.t('conflict_delete_bad_data') : (aIsFact ? this.t('conflict_delete_claim') : this.t('conflict_delete_node'));

		const delABtn = deleteArea.createEl('button', { cls: 'tb-btn tb-btn-danger', text: `${delPrefixA}${this.conflict.nodeA.title.slice(0, 28)}` });
		const delBBtn = deleteArea.createEl('button', { cls: 'tb-btn tb-btn-danger', text: `${delPrefixB}${this.conflict.nodeB.title.slice(0, 28)}` });
		delABtn.addEventListener('click', () => { void this.applyDelete(this.conflict.nodeA); });
		delBBtn.addEventListener('click', () => { void this.applyDelete(this.conflict.nodeB); });

		contentEl.createEl('hr');
		const footerText = this.settings.lang === 'en'
			? 'Closing without action keeps the conflict edge in the graph.'
			: '닫기 시 모순 엣지가 그래프에 그대로 유지됩니다.';
		contentEl.createEl('div', { cls: 'tb-conflict-footer', text: footerText });
	}

	private async applyReclassify(relation: TBEdgeRelation, reason: string): Promise<void> {
		const nodeAFile = this.app.vault.getAbstractFileByPath(this.conflict.nodeA.filePath);
		if (!(nodeAFile instanceof TFile)) { new Notice('[ThirdBrain] 파일을 찾을 수 없습니다.'); return; }
		try {
			await this.store.replaceEdge(nodeAFile, `[[${this.conflict.nodeB.title}]]`, relation, reason);
			new Notice(`[ThirdBrain] 엣지를 '${relation}'(으)로 교체했습니다.`);
			this.close();
			this.onResolved?.(`엣지를 '${relation}'(으)로 재분류`);
		} catch (e) {
			new Notice(`[ThirdBrain] 엣지 교체 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async applyAddParent(parentTitle: string): Promise<void> {
		const folder = this.conflict.nodeA.filePath.split('/').slice(0, -1).join('/');
		try {
			// 상위 노트 생성
			const parentNode: Omit<TBNode, 'filePath'> = {
				id: `prop-${Date.now().toString(36)}`,
				title: parentTitle,
				type: 'claim',
				content: `${this.conflict.nodeA.title}와 ${this.conflict.nodeB.title}를 포괄하는 상위 전제`,
				tags: [],
				folder,
				edges: [],
				is_core_concept: true,
				source_span: { text: parentTitle, offset: 0 },
				created: new Date().toISOString(),
			};
			const parentFile = await this.store.createNode(parentNode);

			// A → 부모, B → 부모 (precondition_of)
			const nodeAFile = this.app.vault.getAbstractFileByPath(this.conflict.nodeA.filePath);
			const nodeBFile = this.app.vault.getAbstractFileByPath(this.conflict.nodeB.filePath);
			const parentWikilink = `[[${parentFile.basename}]]`;
			const edge = (file: TFile) => this.store.confirmEdge(file, {
				target: parentWikilink, label: 'precondition_of', confirmed: true,
				reason: '모순 해소를 위한 상위 전제', confidence: 1.0, axiom_basis: '사용자 지정',
			});
			if (nodeAFile instanceof TFile) await edge(nodeAFile);
			if (nodeBFile instanceof TFile) await edge(nodeBFile);

			new Notice(`[ThirdBrain] 상위 노트 '${parentTitle}' 생성 및 연결 완료`);
			this.close();
			this.onResolved?.(`상위 전제 '${parentTitle}' 추가됨`);
		} catch (e) {
			new Notice(`[ThirdBrain] 상위 노트 생성 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async applyDelete(node: TBNode): Promise<void> {
		const folder = node.filePath.split('/').slice(0, -1).join('/');
		try {
			await this.store.deleteNodeAndCleanEdges(node, folder);
			new Notice(`[ThirdBrain] '${node.title}' 삭제 완료`);
			this.close();
			this.onResolved?.(`'${node.title}' 폐기됨`);
		} catch (e) {
			new Notice(`[ThirdBrain] 삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onClose() { this.contentEl.empty(); }
}

// ── 모순 수동 해결 모달 ────────────────────────────────────

class ManualConflictModal extends Modal {
	constructor(
		app: App,
		private store: GraphStore,
		private settings: ThirdBrainSettings,
		private onResolved: () => void,
	) {
		super(app);
	}

	private get t() { return getT(this.settings.lang); }

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('tb-popup-content', 'tb-manual-conflict-modal');
		this.setTitle(this.settings.lang === 'ko' ? '미해소 모순 목록' : 'Unresolved Conflicts');

		const loading = contentEl.createEl('div', { text: this.settings.lang === 'ko' ? '스캔 중...' : 'Scanning…' });

		let conflicts: ConflictReport[];
		try {
			conflicts = await this.store.scanConflicts();
		} catch {
			loading.textContent = this.settings.lang === 'ko' ? '스캔 실패' : 'Scan failed';
			return;
		}
		loading.remove();

		if (conflicts.length === 0) {
			contentEl.createEl('div', {
				cls: 'tb-manual-conflict-empty',
				text: this.settings.lang === 'ko' ? '✓ 미해소 모순 없음' : '✓ No unresolved conflicts',
			});
			return;
		}

		contentEl.createEl('div', {
			cls: 'tb-manual-conflict-count',
			text: this.settings.lang === 'ko'
				? `${conflicts.length}건의 미해소 모순이 있습니다.`
				: `${conflicts.length} unresolved conflict${conflicts.length > 1 ? 's' : ''} found.`,
		});

		const list = contentEl.createEl('div', { cls: 'tb-manual-conflict-list' });

		for (const c of conflicts) {
			const card = list.createEl('div', { cls: 'tb-conflict-notice-row' });
			card.createEl('span', { cls: 'tb-conflict-notice-a', text: c.nodeA.title });
			card.createEl('span', { cls: 'tb-conflict-notice-vs', text: '⟷' });
			card.createEl('span', { cls: 'tb-conflict-notice-b', text: c.nodeB.title });
			const btn = card.createEl('button', { cls: 'tb-btn tb-conflict-resolve-btn', text: this.t('conflict_btn_resolve') });
			const resolvedMsg = card.createEl('span', { cls: 'tb-conflict-resolved-msg' });
			btn.addEventListener('click', () => {
				new ConflictResolutionModal(this.app, c, this.store, this.settings, (msg) => {
					btn.remove();
					resolvedMsg.textContent = `✓ ${msg}`;
					resolvedMsg.addClass('is-visible');
					this.onResolved();
				}).open();
			});
		}
	}

	onClose() { this.contentEl.empty(); }
}
