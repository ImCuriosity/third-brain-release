import { App, ItemView, Modal, Notice, TFile, WorkspaceLeaf, requestUrl } from 'obsidian';
import type ThirdBrainPlugin from './main';
import { DONATE_QR_BASE64 } from './donate-qr';
import { SOOTBALL_LOGO, SOOTBALL_WAITING, SOOTBALL_HUNGRY } from './sootball';
import {
	DISTILL_THRESHOLD,
	distillText,
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
import { buildTensor, findPath, findTransitivePaths, addNodeToTensor } from './engine/adjacency-tensor';
import { detectConflicts } from './engine/contradiction-engine';
import { compareSubgraphs } from './engine/isomorphism-engine';
import { extractActions, linkActionsToPropositions } from './engine/serial-pipeline';
import { computeNodeSalience } from './engine/topology-engine';
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
	FolderBridgeNode,
	BridgeEdge,
	FolderBridgeResult,
	SummaryResult,
	GraphPath,
	ConflictReport,
	ActionNode,
	ActionStatus,
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

	// 재분석용 문맥 캐시
	private _cachedContexts: ContextLayer[] | null = null;


	constructor(leaf: WorkspaceLeaf, plugin: ThirdBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return 'ThirdBrain'; }
	getIcon(): string { return 'sootball'; }

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

		this.resultsEl = this.ingestContainer.createEl('div', { cls: 'tb-results' });
	}

	async onClose() { /* no-op */ }

	// ── 헤더 ─────────────────────────────────────────────

	private buildHeader(root: HTMLElement) {
		const hdr = root.createEl('div', { cls: 'tb-header' });

		const titleRow = hdr.createEl('div', { cls: 'tb-header-title' });
		titleRow.createEl('span', { cls: 'tb-header-name', text: 'Third-Brain' });
		titleRow.createEl('span', { cls: 'tb-header-badge', text: 'v2' });

		// 후원 QR 버튼
		const donateWrap = titleRow.createEl('div', { cls: 'tb-donate-wrap' });
		const donateBtn = donateWrap.createEl('button', { cls: 'tb-donate-btn', text: '🍦' });
		const donatePopup = donateWrap.createEl('div', { cls: 'tb-donate-popup' });
		donatePopup.createEl('div', { cls: 'tb-donate-msg', text: '실례가 안 된다면 아이스크림 하나만 사주십시오...🍦' });
		if (DONATE_QR_BASE64) {
			const img = donatePopup.createEl('img', { cls: 'tb-donate-qr', attr: { src: DONATE_QR_BASE64, alt: 'KakaoPay QR' } });
			img.draggable = false;
		}
		donateBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			donatePopup.toggleClass('is-visible', !donatePopup.hasClass('is-visible'));
		});
		document.addEventListener('click', () => donatePopup.removeClass('is-visible'), { passive: true });

		hdr.createEl('div', { cls: 'tb-header-subtitle', text: '당신의 생각 조각을 먹고 자라는 지식 유기체' });

		this.usageEl = hdr.createEl('div', { cls: 'tb-usage-bar', text: '─' });
	}

	// ── 인제스트 패널 ─────────────────────────────────────

	private buildIngestPanel(parent: HTMLElement) {
		const panel = parent.createEl('div', { cls: 'tb-ingest' });

		// 드롭존
		const dropZone = panel.createEl('div', { cls: 'tb-dropzone' });
		const faceEl = dropZone.createEl('div', { cls: 'tb-dropzone-face' });
		faceEl.innerHTML = SOOTBALL_WAITING;
		const dropLabel = dropZone.createEl('div', { cls: 'tb-dropzone-label', text: '.md / .txt 먹여주세요' });
		const fileInput = dropZone.createEl('input', {
			attr: { type: 'file', accept: '.md,.txt', multiple: true, style: 'display:none' },
		}) as HTMLInputElement;
		const fileBtn = dropZone.createEl('button', { cls: 'tb-file-btn', text: '📁 파일 선택' });
		fileBtn.addEventListener('click', () => fileInput.click());
		fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

		// dragenter 카운터 — 자식 요소 이동 시 dragleave 오작동 방지
		let dragDepth = 0;
		const setFaceHungry = (hungry: boolean) => {
			faceEl.innerHTML = hungry ? SOOTBALL_HUNGRY : SOOTBALL_WAITING;
			dropLabel.textContent = hungry ? '냠냠 — 여기 넣어주세요!' : '.md / .txt 먹여주세요';
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
		sep.createEl('span', { cls: 'tb-or-text', text: '또는 회의록·아이디어를 직접 입력하세요.' });
		sep.createEl('span', { cls: 'tb-or-line' });

		// 텍스트에어리어
		this.ingestTextarea = panel.createEl('textarea', {
			cls: 'tb-ingest-textarea',
			attr: { placeholder: '예) 우리 서비스는 사용자가 첫 노트를 쓰기 전까지 아무 가치도 주지 못한다...' },
		});

		// 글자수 표시
		this.charCountEl = panel.createEl('div', { cls: 'tb-char-count', text: '0자' });
		this.ingestTextarea.addEventListener('input', () => {
			this.updateCharCount();
			this.syncIngestBtnState();
		});

		// 2×2 액션 버튼 그룹
		const actions = parent.createEl('div', { cls: 'tb-action-group' });

		this.ingestBtn = actions.createEl('button', { cls: 'tb-btn-primary', text: '✦ 생성' });
		this.ingestBtn.addEventListener('click', () => {
			void this.runIngest();
		});

		this.analysisBtn = actions.createEl('button', { cls: 'tb-btn-secondary', text: '🔍 분석' });
		this.analysisBtn.addEventListener('click', () => {
			new AnalysisModal(this.app, this.getFolderPaths(), this.store, (folder, mode, intent, includeActions) => {
				void this.runFolderAnalysis(folder, mode, intent, includeActions);
			}).open();
		});

		const graphBtn = actions.createEl('button', { cls: 'tb-btn-secondary', text: '⊕ 그래프' });
		graphBtn.addEventListener('click', () => {
			new GraphViewModal(this.app, this.getFolderPaths(), (f) => this.openNativeGraph(f)).open();
		});

		this.bridgeBtn = actions.createEl('button', { cls: 'tb-btn-secondary', text: '🌉 연결' });
		this.bridgeBtn.addEventListener('click', () => {
			new BridgeModal(this.app, this.getFolderPaths(), (a, b) => this.runBridgeWithFolders(a, b)).open();
		});


		this.fileCountEl = actions.createEl('div', { cls: 'tb-file-count', text: this.vaultCountText() });
	}

	private handleFileDrop(e: DragEvent) {
		// Case 1: OS 파일 시스템에서 외부 드래그
		const externalFiles = Array.from(e.dataTransfer?.files ?? []);
		if (externalFiles.length > 0) {
			void this.loadFilesToTextarea(externalFiles);
			return;
		}

		// Case 2: Obsidian 파일 탐색기에서 내부 드래그
		const dm = (this.app as any).dragManager;
		const drg = dm?.draggable;
		if (drg) {
			const tfiles: TFile[] = [];
			if (drg.type === 'file' && drg.file instanceof TFile) {
				tfiles.push(drg.file);
			} else if (Array.isArray(drg.files)) {
				tfiles.push(...(drg.files as unknown[]).filter((f): f is TFile => f instanceof TFile));
			}
			if (tfiles.length > 0) {
				void this.loadVaultFilesToTextarea(tfiles);
				return;
			}
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
		const filtered = files.filter(f => /\.(md|txt)$/i.test(f.name));
		if (filtered.length === 0) {
			new Notice('[ThirdBrain] .md 또는 .txt 파일만 지원합니다.');
			return;
		}
		const texts: string[] = [];
		for (const f of filtered) texts.push(await f.text());
		this.ingestTextarea.value = texts.join('\n\n---\n\n');
		this.updateCharCount();
		this.syncIngestBtnState();
		new Notice(`[ThirdBrain] ${filtered.length}개 파일 로드됨`);
	}

	// 내부(Obsidian vault) TFile → 볼트에서 읽기
	// TB 노드인 경우 핵심 속성을 헤더로 표시해 사용자가 인지할 수 있도록 함
	private async loadVaultFilesToTextarea(files: TFile[]) {
		const filtered = files.filter(f => /\.(md|txt)$/i.test(f.name));
		if (filtered.length === 0) {
			new Notice('[ThirdBrain] .md 또는 .txt 파일만 지원합니다.');
			return;
		}
		const texts: string[] = [];
		for (const f of filtered) {
			const raw = await this.app.vault.read(f);
			const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;

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
		sootball.innerHTML = SOOTBALL_LOGO;
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
		this.setBusy(true);
		this.resultsEl.empty();
		this.stepLogEl?.empty();
		await this.runPipeline(content, undefined, targetFolder);
	}

	// ── 인제스트 진입점 ───────────────────────────────────

	private async runIngest() {
		const text = this.ingestTextarea.value.trim();
		if (!text) { new Notice('[ThirdBrain] 텍스트를 입력하세요.'); return; }

		// Step 0: 저장할 폴더를 먼저 선택 (중복 저장 방지)
		const folders = this.getFolderPaths();
		const selectedFolder = await new Promise<string | null>((resolve) => {
			new SaveFolderModal(this.app, folders, '', (folder: string) => {
				resolve(folder);
			}).open();
		});

		if (selectedFolder === null) {
			new Notice('[ThirdBrain] 폴더를 선택하지 않았습니다.');
			return;
		}

		// TB 노드 감지: 텍스트 헤더에서 파일 경로 파싱 → 메모리 상태에 의존하지 않음
		const tbMatch = this.ingestTextarea.value.match(/^\[TB 노드:(.+?)\]/);

		// 텍스트 소비 — 인제스트 시작 즉시 비움
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

		this.setBusy(true);
		this.resultsEl.empty();
		this.pipelineModal?.close();
		this.pipelineModal = null;

		if (text.length > DISTILL_THRESHOLD) {
			this.setProgress(1, '0/3  핵심 정제 중... (대용량 입력)');
			let distilled: string;
			try {
				distilled = await distillText(text, this.plugin.settings.cliBin,
					(msg) => this.setProgress(1, msg));
			} catch {
				distilled = text.slice(0, 8000);
			}
			this.hideProgress();
			await this.runPipeline(distilled, undefined, selectedFolder);
		} else {
			await this.runPipeline(text, undefined, selectedFolder);
		}
	}

	// ── 0차: 핵심 정제 + 유저 확인 ───────────────────────

	private async showDistillStep(rawText: string, targetFolder: string) {
		this.setProgress(1, '0/3  핵심 정제 중... (대용량 입력)');
		let distilled: string;
		try {
			distilled = await distillText(rawText, this.plugin.settings.cliBin,
				(msg) => this.setProgress(1, msg));
		} catch {
			distilled = rawText.slice(0, 8000);
		}
		this.hideProgress();
		this.setBusy(false);

		// Distill Confirm UI (유저가 편집 후 계속)
		const panel = this.resultsEl.createEl('div', { cls: 'tb-distill-confirm' });
		panel.createEl('div', { cls: 'tb-distill-label', text: '[ 0차 핵심 정제 완료 — 검토 후 분석 진행 ]' });

		// 원문 vs 압축 글자수 표시
		const originalLen = rawText.length;
		const compressedLen = distilled.length;
		const ratio = Math.round((1 - compressedLen / originalLen) * 100);
		const statsText = `원문: ${originalLen.toLocaleString()}자 → 압축: ${compressedLen.toLocaleString()}자 (${ratio}% 감소)`;
		panel.createEl('div', { cls: 'tb-distill-stats', text: statsText });

		panel.createEl('div', { cls: 'tb-distill-hint', text: '핵심 내용만 압축됐습니다. 수정 후 분석하거나 그대로 진행하세요.' });
		const ta = panel.createEl('textarea', { cls: 'tb-distill-textarea' });
		ta.value = distilled;
		const actions = panel.createEl('div', { cls: 'tb-distill-actions' });
		actions.createEl('button', { cls: 'tb-btn', text: '[ 취소 ]' })
			.addEventListener('click', () => { this.resultsEl.empty(); this.setBusy(false); });
		actions.createEl('button', { cls: 'tb-btn is-primary', text: '[ 이 내용으로 분석 시작 ]' })
			.addEventListener('click', async () => {
				const t = ta.value.trim() || distilled;
				panel.remove();
				this.setBusy(true);
				await this.runPipeline(t, undefined, targetFolder);
			});
	}

	// ── 메인 파이프라인 (Auto vs Architect 모드) ──────

	private async runPipeline(
		text: string,
		cachedContexts?: ContextLayer[],
		targetFolder?: string
	) {
		const cliBin = this.plugin.settings.cliBin;
		const existingFiles = this.app.vault.getMarkdownFiles().map((f: TFile) => f.name);

		// 파이프라인 결과 모달 생성 (다음 인제스트까지 유지)
		this.pipelineModal = new PipelineInfoModal(this.app);
		this.pipelineModal.open();
		this.stepLogEl = this.pipelineModal.stepLogEl;

		// 결과 패널 상단에 재오픈 버튼 고정
		const reopenBtn = this.resultsEl.createEl('button', {
			cls: 'tb-btn tb-reopen-btn',
			text: '[ 분석 결과 보기 ]',
		});
		reopenBtn.addEventListener('click', () => this.pipelineModal?.open());

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
				this.setProgress(2, '1/4  문맥 분절 중...');
				contexts = await timed('① 문맥 분절', () => extractContexts(text, this.plugin.settings));
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
			}

			// 2차: 명제 추출 (인사이트는 분석 단계에서만)
			this.setProgress(4, '2/3  명제 추출 중...');
			const propositions = await timed('② 명제 추출',
				() => extractPropositions(contexts, this.plugin.settings));

			// 2.5차: 엣지 추출 (명제 간 크로스-컨텍스트만)
			this.setProgress(6, '3/3  논리 엣지 추출 중...');
			const rawEdges = await timed('③ 논리 엣지',
				() => extractEdges(propositions, contexts, [], this.plugin.settings));
			const logic: LogicLayer = { propositions, edges: rawEdges };
			this.hideProgress();
			this.setBusy(false);

			this.renderLogicLayer(logic);

			// 폴더 브리지는 별도 기능으로 분리 (generateEdgeCandidates 제거)
			this.hideProgress();
			this.setBusy(false);

			// targetFolder가 있으면 자동 저장 (중복 저장 방지)
			if (targetFolder) {
				// ⑨ 저장 전에 기존 노드 스냅샷 (새 파일 생성 전이어야 타이밍 문제 없음)
				const preExistingNodes = await this.store.loadNodesInFolder(targetFolder);

				this.setProgress(8, '⑧ 그래프 저장 중...');
				try {
					const result = await this.saveNodes(contexts, logic, targetFolder);
					const { contextFileMap } = result;
					this.hideProgress();
					new Notice(`✅ 그래프 저장 완료! (${logic.propositions.length}개 명제, ${logic.edges.length}개 엣지)`);

					// Phase 2: 모순 감지 — 강제 해소 없이 결과 패널에 알림만 표시
					const savedNodes = await this.store.loadNodesInFolder(targetFolder);
					const conflicts = detectConflicts(savedNodes);
					if (conflicts.length > 0) {
						this.renderConflictNotice(conflicts);
					}

					// Phase 8: 액션 레이어 추출 (그래프 생성 필수 단계, 원문 기준)
					this.setProgress(9, '⑩ 액션 레이어 추출 중...');
					await this.extractAndSaveActions(
						text,
						logic.propositions,
						contexts,
						contextFileMap,
						targetFolder
					);

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
					setTimeout(() => {
						this.openNativeGraph([targetFolder]);
					}, 300);
				} catch (err) {
					this.hideProgress();
					new Notice(`⚠️ 저장 중 오류: ${err instanceof Error ? err.message : String(err)}`);
				}
			} else {
				// 폴더를 선택하지 않았으면 (예외 상황) 사용자에게 선택 요구
				this.renderSaveSection(
					async (folder: string) => {
						const result = await this.saveNodes(contexts, logic, folder);
						return result;
					},
					async () => {},
					undefined
				);
			}

		} catch (e) {
			this.hideProgress();
			this.setBusy(false);

			const msg = e instanceof Error ? e.message : String(e);
			const stack = e instanceof Error ? e.stack : '';

			// UI에 대형 에러 표시
			this.resultsEl.empty();
			const errorDiv = this.resultsEl.createEl('div', { cls: 'tb-error-container' });

			errorDiv.createEl('div', { cls: 'tb-error-title', text: '❌ 오류 발생' });
			errorDiv.createEl('div', { cls: 'tb-error-message', text: msg });

			if (stack) {
				const detailsDiv = errorDiv.createEl('div', { cls: 'tb-error-details' });
				detailsDiv.createEl('div', { cls: 'tb-error-label', text: '상세 정보:' });
				detailsDiv.createEl('pre', { cls: 'tb-error-stack', text: stack.split('\n').slice(0, 5).join('\n') });
			}

			// 도움말 표시
			if (msg.includes('Claude API')) {
				const helpDiv = errorDiv.createEl('div', { cls: 'tb-error-help' });
				helpDiv.createEl('div', { cls: 'tb-error-label', text: '✓ 해결 방법:' });
				helpDiv.createEl('ul', {}).createEl('li', { text: '1. Settings 탭에서 AI 제공자 확인' });
				helpDiv.createEl('ul', {}).createEl('li', { text: '2. API 키가 올바른지 확인 (sk-ant-로 시작)' });
				helpDiv.createEl('ul', {}).createEl('li', { text: '3. 인터넷 연결 확인' });
				helpDiv.createEl('ul', {}).createEl('li', { text: '4. Anthropic 콘솔에서 credit 확인' });
			}

			// 알림도 함께
			new Notice(`⚠️ ${msg}`);
		}
	}

	// ── 1차 결과: 문맥 레이어 ────────────────────────────

	private renderContextLayer(contexts: ContextLayer[]) {
		const { content } = this.makeSectionToggle(
			`① 문맥 레이어 · ${contexts.length}개 단위`, true
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
			`⬡ 핵심 인사이트 · ${insights.length}개`, false
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
		const label = `② 논리 레이어 · 명제 ${logic.propositions.length} · 엣지 ${logic.edges.length}`;
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
				head.createEl('span', { cls: 'tb-hub-badge', text: '⬡ 인사이트' });
			} else if (p.is_core_concept) {
				head.createEl('span', { cls: 'tb-core-badge', text: '⬡ 핵심' });
			}
			head.createEl('span', { cls: `tb-tag is-${p.role}`, text: p.role.toUpperCase() });
			head.createEl('span', { cls: 'tb-card-title', text: p.title });
			// Phase 6-4: 출처 없음 배지
			if (!hasSource) {
				head.createEl('span', { cls: 'tb-no-source-badge', text: '출처 없음' });
			}
			card.createEl('div', { cls: 'tb-card-body', text: p.text });
			if (hasSource) {
				const footer = card.createEl('div', { cls: 'tb-card-footer' });
				const srcToggle = footer.createEl('button', { cls: 'tb-source-toggle', text: '⌗ 출처' });
				const srcBox = card.createEl('div', { cls: 'tb-source-box' });
				srcBox.createEl('p', { cls: 'tb-source-text', text: p.source_span!.text });
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

		// 엣지 목록
		if (logic.edges.length > 0) {
			content.createEl('div', { cls: 'tb-block-label', text: '논리 엣지' });
			const list = content.createEl('div', { cls: 'tb-edgelist' });
			for (const e of logic.edges) {
				const s = byId.get(e.source);
				const t = byId.get(e.target);
				if (!s || !t) continue;
				const rel = RELATION_KO[e.relation] ?? e.relation;
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
			content.createEl('div', { cls: 'tb-empty', text: '기존 볼트에서 연결할 노드를 찾지 못했습니다.' });
		} else {
			content.createEl('div', {
				cls: 'tb-hint',
				text: '그래프 저장 후 연결 버튼이 활성화됩니다.',
			});
			const chipRow = content.createEl('div', { cls: 'tb-edge-chips' });

			for (const rec of recs) {
				const chip = chipRow.createEl('div', { cls: 'tb-chip' });
				const top = chip.createEl('div', { cls: 'tb-chip-top' });
				top.createEl('span', { cls: 'tb-chip-icon', text: '◎' });
				const rel = RELATION_KO[rec.label] ?? rec.label;
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
					text: '연결',
					attr: { disabled: 'true' },
				}) as HTMLButtonElement;
				connectBtns.push({ btn, rec });
			}
		}

		// 저장 완료 후 coreFile을 받아 연결 버튼 활성화
		return (coreFile: TFile) => {
			let linking = false;
			for (const { btn, rec } of connectBtns) {
				btn.removeAttribute('disabled');
				btn.addEventListener('click', async () => {
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
				});
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

		const saveBtn = btnRow.createEl('button', { cls: 'tb-btn is-primary tb-save-main', text: '[ 그래프 저장 ]' });
		const resultArea = block.createEl('div', { cls: 'tb-save-result-area' });

		const doSave = async (folder: string) => {
			saveBtn.disabled = true;
			saveBtn.textContent = '[ 저장 중... ]';
			resultArea.empty();
			try {
				const { files, folder: dest, actualPath } = await onSave(folder);
				this.fileCountEl.textContent = this.vaultCountText();
				saveBtn.textContent = `[ 저장 완료 ✓ (${files.length}개) ]`;
				new Notice(`[ThirdBrain] ${files.length}개 노드 저장 완료 → ${dest}`);

				if (files.length > 0) {
					const destLabel = dest === '루트' ? '볼트 루트' : `${dest}/`;
					resultArea.createEl('div', { cls: 'tb-save-result-label', text: `✓ ${destLabel} 에 저장됨` });
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
				saveBtn.textContent = '[ 그래프 저장 ]';
				saveBtn.disabled = false;
				resultArea.createEl('div', { cls: 'tb-save-result-error', text: `저장 실패: ${e instanceof Error ? e.message : String(e)}` });
				new Notice(`저장 실패: ${e instanceof Error ? e.message : String(e)}`);
			}
		};

		saveBtn.addEventListener('click', () => {
			new SaveFolderModal(
				this.app,
				this.getFolderPaths(),
				'',
				(folder) => void doSave(folder)
			).open();
		});

		const reportBtn = btnRow.createEl('button', { cls: 'tb-btn tb-btn-report', text: '[ 📋 리포트 저장 ]' });
		reportBtn.addEventListener('click', async () => {
			reportBtn.disabled = true;
			reportBtn.textContent = '[ 저장 중... ]';
			try {
				await onSaveReport();
				reportBtn.textContent = '[ 리포트 완료 ✓ ]';
			} catch {
				reportBtn.disabled = false;
				reportBtn.textContent = '[ 📋 리포트 저장 ]';
			}
		});
	}

	// ── vault 저장 ────────────────────────────────────────

	private async saveNodes(
		contexts: ContextLayer[],
		logic: LogicLayer,
		targetFolder = ''
	): Promise<{ files: TFile[]; folder: string; actualPath: string; propFileMap: Map<string, TFile>; contextFileMap: Map<string, TFile> }> {
		if (logic.propositions.length === 0) {
			throw new Error('저장할 노드가 없습니다. 파이프라인을 먼저 실행해주세요.');
		}

		const contextTags = contexts.flatMap(c => c.keywords).slice(0, 8);
		const folder = targetFolder || '루트';

		// 1) 문맥 레이어 먼저 저장
		const contextFileMap = await this.store.createContextBatch(contexts, targetFolder);

		// 2) 명제 저장 (각 명제 → 소속 문맥 방향 supports 엣지 포함)
		const propFileMap = await this.store.createPropositionBatch(
			logic.propositions, logic.edges, contextTags, targetFolder, contextFileMap
		);

		const allFiles = [...contextFileMap.values(), ...propFileMap.values()];

		// Context ↔ Proposition 엣지 생성
		await this.connectContextsToPropositions(
			contexts, logic.propositions, contextFileMap, propFileMap
		);

		// 기존 노드 연결은 findAndRenderCrossConnections에서 처리 (integrateWithExistingNodes 제거)

		return { files: allFiles, folder, actualPath: targetFolder, propFileMap, contextFileMap };
	}

	// ── Phase 8: 액션 레이어 결과 렌더 ─────────────────────────

	private renderActionCard(parent: HTMLElement, node: ActionNode) {
		const card = parent.createEl('div', { cls: `tb-action-card is-${node.status}` });

		const head = card.createEl('div', { cls: 'tb-action-card-head' });
		// 기원 배지
		if (node.origin === 'from_resolution') {
			head.createEl('span', { cls: 'tb-action-badge-conflict', text: '모순해소' });
		} else if (node.origin === 'extracted') {
			head.createEl('span', { cls: 'tb-action-origin', text: 'AI 추출' });
		}
		head.createEl('span', { cls: 'tb-action-title', text: node.title });

		// 상태 드롭다운
		const statusRow = card.createEl('div', { cls: 'tb-action-meta-row' });
		const statusSel = statusRow.createEl('select', { cls: `tb-action-status-sel is-${node.status}` }) as HTMLSelectElement;
		(['pending', 'in_progress', 'done', 'blocked'] as ActionStatus[]).forEach(s => {
			const labels: Record<ActionStatus, string> = {
				pending: '대기', in_progress: '진행 중', done: '완료', blocked: '차단',
			};
			const opt = statusSel.createEl('option', { value: s, text: labels[s] });
			if (s === node.status) opt.selected = true;
		});

		if (node.owner) statusRow.createEl('span', { cls: 'tb-action-owner', text: node.owner });
		if (node.deadline) statusRow.createEl('span', { cls: 'tb-action-deadline', text: node.deadline.slice(0, 10) });

		statusSel.addEventListener('change', async () => {
			const newStatus = statusSel.value as ActionStatus;
			card.className = `tb-action-card is-${newStatus}`;
			statusSel.className = `tb-action-status-sel is-${newStatus}`;
			const file = this.app.vault.getFileByPath(node.filePath);
			if (file) await this.store.updateActionStatus(file, newStatus);
		});

		if (node.content) {
			card.createEl('div', { cls: 'tb-action-content', text: node.content.slice(0, 120) });
		}

		// 동기 명제 링크
		if (node.motivation_ids.length > 0) {
			const motivRow = card.createEl('div', { cls: 'tb-action-motiv' });
			motivRow.createEl('span', { cls: 'tb-action-motiv-label', text: '동기: ' });
			for (const id of node.motivation_ids) {
				const chip = motivRow.createEl('span', { cls: 'tb-action-motiv-chip', text: id });
				chip.addEventListener('click', () => {
					const f = this.app.vault.getMarkdownFiles().find(f =>
						this.app.metadataCache.getFileCache(f)?.frontmatter?.tb_id === id
					);
					if (f) this.app.workspace.openLinkText(f.basename, '', false);
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
		folder: string
	): Promise<void> {
		try {
			let actions = await extractActions(text, propositions, contexts, this.plugin.settings);
			if (actions.length === 0) return;
			actions = await linkActionsToPropositions(actions, propositions, this.plugin.settings);

			const ctxById = new Map(contexts.map(c => [c.id, c]));

			for (const a of actions) {
				const actionFile = await this.store.createActionNode(a, folder);

				// 문맥 → 액션: precondition_of 엣지 (문맥이 액션의 존재 전제)
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
			}
			this.renderActionResults(actions as ActionNode[]);
		} catch (e) {
			new Notice(`[ThirdBrain] 액션 추출 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private renderActionResults(actions: Omit<ActionNode, 'filePath'>[]) {
		if (actions.length === 0) return;
		const { content } = this.makeSectionToggle(
			`⑩ 액션 레이어 · ${actions.length}개`, false
		);
		for (const a of actions) {
			this.renderActionCard(content, { ...a, filePath: '' });
		}
	}

	private renderConflictNotice(conflicts: ConflictReport[]) {
		const { content } = this.makeSectionToggle(
			`⚠ 논리 모순 · ${conflicts.length}개 (그래프에 보존됨)`, false
		);
		content.createEl('div', {
			cls: 'tb-conflict-notice-hint',
			text: 'conflicts_with 엣지로 그래프에 기록됩니다. 나중에 그래프 분석에서 확인하세요.',
		});
		for (const c of conflicts) {
			const row = content.createEl('div', { cls: 'tb-conflict-notice-row' });
			row.createEl('span', { cls: 'tb-conflict-notice-a', text: c.nodeA.title });
			row.createEl('span', { cls: 'tb-conflict-notice-vs', text: '⟷' });
			row.createEl('span', { cls: 'tb-conflict-notice-b', text: c.nodeB.title });
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
				new Notice('[ThirdBrain] ⑨ 연결 후보 없음 (기존 노드와 연관성 낮음)');
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
		await this.app.fileManager.processFrontMatter(newFile, (fm) => {
			const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
			if (!edges.find(e => e.target === fwd.target)) edges.push(fwd);
			fm.tb_edges = edges;
		});
		await this.app.fileManager.processFrontMatter(existFile, (fm) => {
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
		toggle.createEl('span', { cls: 'tb-section-label', text: `✓ ⑨ ${autoSaved.size}개 연결 자동 저장` });
		const content = block.createEl('div', { cls: 'tb-section-content' });
		toggle.addEventListener('click', () => {
			const collapsed = content.hasClass('is-collapsed');
			content.toggleClass('is-collapsed', !collapsed);
			toggle.querySelector<HTMLElement>('.tb-section-chevron')!.textContent = collapsed ? '▾' : '▸';
		});
		for (const conn of connections) {
			const key = `${conn.new_title}→${conn.existing_title}`;
			if (!autoSaved.has(key)) continue;
			const rel = RELATION_KO[conn.relation] ?? conn.relation;
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
		const labelEl = toggle.createEl('span', { cls: 'tb-section-label', text: `⑨ 연결 후보 ${pending.length}개 — 선택 후 저장` });
		const content = block.createEl('div', { cls: 'tb-section-content' });
		toggle.addEventListener('click', () => {
			const collapsed = content.hasClass('is-collapsed');
			content.toggleClass('is-collapsed', !collapsed);
			toggle.querySelector<HTMLElement>('.tb-section-chevron')!.textContent = collapsed ? '▾' : '▸';
		});

		content.createEl('div', { cls: 'tb-hint', text: preSelectFirst ? 'Auto: 기준 미달 — 최상위 1개 선택됨. 확인 후 저장하세요.' : '선택한 연결만 저장됩니다.' });

		const chipRow = content.createEl('div', { cls: 'tb-edge-chips' });
		const states: Array<{ conn: CrossConnection; selected: boolean }> = [];
		let locked = false;

		for (let i = 0; i < pending.length; i++) {
			const conn = pending[i];
			const rel = RELATION_KO[conn.relation] ?? conn.relation;
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
		const saveBtn = bar.createEl('button', { cls: 'tb-btn is-primary', text: '[ 선택 연결 저장 ]' });
		saveBtn.addEventListener('click', async () => {
			const selected = states.filter(s => s.selected);
			if (selected.length === 0) { new Notice('[ThirdBrain] 저장할 연결을 선택하세요.'); return; }
			locked = true;
			chipRow.addClass('is-locked');
			saveBtn.disabled = true; saveBtn.textContent = '[ 저장 중... ]';
			try {
				for (const { conn } of selected) {
					const newFile = newTitleToFile.get(conn.new_title);
					const existFile = existingTitleToFile.get(conn.existing_title);
					if (!newFile || !existFile) continue;
					await this.saveCrossEdge(conn, newFile, existFile);
				}
				new Notice(`✅ 연결 ${selected.length}개 저장 완료`);
				bar.remove();
				labelEl.textContent = `✓ ⑨ 연결 ${selected.length}개 저장됨`;
			} catch (err) {
				locked = false;
				chipRow.removeClass('is-locked');
				saveBtn.disabled = false; saveBtn.textContent = '[ 선택 연결 저장 ]';
				new Notice(`⚠️ 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
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
			new Notice(`[ThirdBrain] 리포트 저장: ${fileName}`);
		} catch (e) {
			new Notice(`리포트 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
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
			this.openNativeGraph([folder]);

			new Notice(`📊 그래프 뷰 열기: ${folderPath || '루트'}`);
		} catch {
			// 실패해도 사용자가 수동으로 열 수 있음
		}
	}

	// ── 8-2: 폴더 분석 실행 ──────────────────────────────

	private async runFolderAnalysis(folderPath: string, mode: 'rich' | 'summary', intent?: string, includeActions?: boolean) {
		this.resultsEl.empty();
		this.setBusy(true);
		this.setProgress(5, `폴더 분석 중... (${mode === 'rich' ? '깊은 분석' : '빠른 요약'})`);

		const folder = this.app.vault.getFolderByPath(folderPath);
		if (!folder) {
			new Notice('[ThirdBrain] 폴더를 찾을 수 없습니다.');
			this.setBusy(false);
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
								target: String(edge.target ?? '').replace(/^\[\[|\]\]$/g, ''),
								relation: String(edge.label ?? 'supports'),
								reason: String(edge.reason ?? ''),
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
			this.setBusy(false);
			this.hideProgress();
			return;
		}

		try {
			const result = await summarizeFolder(nodes, this.plugin.settings, mode, intent);
			this.hideProgress();
			this.setBusy(false);
			this.renderSummaryResult(result, folderPath, mode, intent);
		} catch (e) {
			this.hideProgress();
			this.setBusy(false);
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
		const openBtn = btnRow.createEl('button', { cls: 'tb-btn is-primary', text: '전체 결과 보기' });

		const openModal = () => {
			new AnalysisResultModal(this.app, result, folderPath, mode, intent, () => {
				const folders = this.getFolderPaths();
				new SaveFolderModal(this.app, folders, '', (tf: string) => {
					void this.saveAnalysisResult(result, folderPath, tf, openBtn, mode, intent);
				}).open();
			}).open();
		};
		openBtn.addEventListener('click', openModal);

		// 분석 완료 즉시 모달 오픈
		openModal();
	}

	// 🆕 분석 결과 저장
	private async saveAnalysisResult(
		result: SummaryResult,
		sourceFolderPath: string,
		targetFolderPath: string,
		saveBtn: HTMLButtonElement,
		mode?: 'rich' | 'summary',
		intent?: string
	) {
		saveBtn.disabled = true;
		const originalText = saveBtn.textContent;
		saveBtn.textContent = '[ 저장 중... ]';

		try {
			const folder = this.app.vault.getFolderByPath(targetFolderPath);
			if (!folder) {
				new Notice('[ThirdBrain] 대상 폴더를 찾을 수 없습니다.');
				return;
			}

			const timestamp = new Date().toISOString().slice(0, 10);
			const modeTag = mode === 'rich' ? '깊은분석' : '빠른요약';
			const intentTag = intent
				? `_${intent.slice(0, 12).replace(/[\\/:*?"<>|#\s]/g, '')}`
				: '';
			const filename = `그래프분석_${sourceFolderPath.replace(/\//g, '_')}_${modeTag}${intentTag}_${timestamp}.md`;
			const filepath = `${targetFolderPath}/${filename}`;

			// 마크다운 컨텐츠 생성
			let content = `# 📊 그래프 분석 결과\n\n`;
			content += `**분석 대상**: ${sourceFolderPath}\n`;
			content += `**분석 방식**: ${mode === 'rich' ? '깊은 분석' : '빠른 요약'}${intent ? ` · ${intent}` : ''}\n`;
			content += `**분석 일시**: ${new Date().toLocaleString('ko-KR')}\n\n`;

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
			saveBtn.textContent = '[ 저장 완료 ✓ ]';
			new Notice(`[ThirdBrain] 분석 결과 저장 완료: ${filename}`);

			// 🆕 저장된 파일 자동 열기
			setTimeout(() => {
				void this.app.workspace.getLeaf().openFile(file);
			}, 300);
		} catch (e) {
			saveBtn.disabled = false;
			saveBtn.textContent = originalText;
			new Notice(`[ThirdBrain] 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
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
		saveBtn.addEventListener('click', async () => {
			saveBtn.disabled = true; skipBtn.disabled = true;
			saveBtn.textContent = '[ 저장 중... ]';
			try {
				await onSave();
				saveBtn.textContent = '[ 저장 완료 ✓ ]';
			} catch (e) {
				saveBtn.textContent = '[ 저장 실패 ]';
				saveBtn.disabled = false;
				new Notice(`저장 실패: ${e instanceof Error ? e.message : String(e)}`);
			}
		});
	}

	// ── 상태 헬퍼 ────────────────────────────────────────

	private setBusy(busy: boolean) {
		this.analysisBtn.disabled = busy;
		this.bridgeBtn.disabled = busy;
		this.ingestBtn.toggleClass('is-busy', busy);
		if (busy) {
			this.ingestBtn.disabled = true;
			this.ingestBtn.textContent = '✦ 처리 중...';
		} else {
			this.ingestBtn.textContent = '✦ 생성';
			this.syncIngestBtnState(); // 텍스트 있어야만 활성
		}
	}

	private updateCharCount() {
		const len = this.ingestTextarea.value.length;
		this.charCountEl.textContent = `${len}자`;
	}

	private syncIngestBtnState() {
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
		if ((this.app.vault as any).getAllFolders) {
			return (this.app.vault as any)
				.getAllFolders()
				.map((f: { path: string }) => f.path)
				.filter((p: string) => p && p !== '/')
				.sort() as string[];
		}
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
		return [...set].sort();
	}

	/** Obsidian 네이티브 그래프 뷰를 새 탭으로 열고 path 필터 주입 (v0 포팅) */
	private async openNativeGraph(folders: string[]): Promise<void> {
		const query = folders.map(f => `path:"${f}"`).join(' OR ');
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: 'graph', active: true });
		this.app.workspace.revealLeaf(leaf);

		const t0 = Date.now();
		let applied = false;

		for (const targetMs of [200, 500, 1000, 1800]) {
			if (applied) break;
			const wait = targetMs - (Date.now() - t0);
			if (wait > 0) await new Promise<void>(r => setTimeout(r, wait));
			if (leaf.view?.getViewType() !== 'graph') break;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const v = leaf.view as any;

			// 방법 1: setState API
			try {
				const cur = v.getState?.()?.settings ?? {};
				await v.setState({ settings: { ...cur, search: query } }, { history: false });
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

			// 방법 3: DOM 검색 입력창 직접 주입
			try {
				const containers = [v.containerEl, this.app.workspace.containerEl].filter(Boolean) as HTMLElement[];
				for (const root of containers) {
					const input = root.querySelector(
						'.graph-settings input, .search-input-container input, input[placeholder]'
					) as HTMLInputElement | null;
					if (input) {
						input.value = query;
						input.dispatchEvent(new Event('input', { bubbles: true }));
						applied = true; break;
					}
				}
				if (applied) break;
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
		this.setBusy(true);
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
			this.hideProgress(); this.setBusy(false);
			new Notice(`[ThirdBrain] 파일 복사 실패: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (!movedFile) {
			this.hideProgress(); this.setBusy(false);
			new Notice('[ThirdBrain] 이동된 파일을 찾을 수 없습니다.');
			return;
		}

		this.setProgress(3, '노드 로드 중...');
		// vault.create 직후엔 메타데이터 캐시가 아직 파싱되지 않음 → changed 이벤트 대기
		const movedNode = await new Promise<import('./types').TBNode | null>(resolve => {
			// 이미 캐시에 있으면 즉시 반환
			const immediate = this.app.metadataCache.getFileCache(movedFile);
			if (immediate?.frontmatter) {
				this.store.fileToNode(movedFile).then(resolve);
				return;
			}
			const timeout = window.setTimeout(() => {
				this.app.metadataCache.offref(ref);
				this.store.fileToNode(movedFile).then(resolve);
			}, 3000);
			const ref = this.app.metadataCache.on('changed', (changedFile) => {
				if (changedFile.path === movedFile.path) {
					window.clearTimeout(timeout);
					this.app.metadataCache.offref(ref);
					this.store.fileToNode(movedFile).then(resolve);
				}
			});
		});
		if (!movedNode) {
			this.hideProgress(); this.setBusy(false);
			new Notice('[ThirdBrain] 노드 메타데이터를 읽을 수 없습니다.');
			return;
		}

		const targetNodes = (await this.store.loadNodesInFolder(targetFolder))
			.filter(n => n.filePath !== movedFile.path);

		if (targetNodes.length === 0) {
			this.hideProgress(); this.setBusy(false);
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

			this.hideProgress(); this.setBusy(false);
			this.ingestTextarea.value = '';
			this.updateCharCount();
			await this.renderSingleNodeBridge(movedFile, movedNode.title, candidates, targetNodes);
		} catch (e) {
			this.hideProgress(); this.setBusy(false);
			new Notice(`[ThirdBrain] 브릿지 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ── Phase 5: 폴더 브리지 실행 ──────────────────────────

	private async runBridgeWithFolders(folderAPath: string, folderBPath: string) {
		this.resultsEl.empty();
		this.setBusy(true);

		this.setProgress(2, '폴더 노드 로드 중...');

		try {
			// Phase 12: loadNodesInFolder 사용으로 완전한 TBNode[] 로드
			const [tbNodesA, tbNodesB] = await Promise.all([
				this.store.loadNodesInFolder(folderAPath),
				this.store.loadNodesInFolder(folderBPath),
			]);

			if (tbNodesA.length === 0 || tbNodesB.length === 0) {
				this.resultsEl.createEl('div', {
					cls: 'tb-error-msg',
					text: '선택한 폴더에 명제 노드가 없습니다.',
				});
				this.hideProgress();
				this.setBusy(false);
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
			const result = await bridgeFolders(
				tbNodesA,
				tbNodesB,
				folderAPath,
				folderBPath,
				this.plugin.settings,
				undefined,
				(msg) => this.setProgress(6, msg)
			);

			this.hideProgress();
			this.setBusy(false);
			await this.renderBridgeResult(result, fileMapA, fileMapB, folderAPath, folderBPath);
		} catch (e) {
			this.hideProgress();
			this.setBusy(false);
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`[ThirdBrain] 브리지 분석 실패: ${msg}`);
			this.resultsEl.createEl('div', { cls: 'tb-error-msg', text: `오류: ${msg}` });
		}
	}

	private async renderBridgeResult(
		result: FolderBridgeResult,
		fileMapA: Map<string, TFile>,
		fileMapB: Map<string, TFile>,
		folderAName: string,
		folderBName: string
	) {
		// 인사이트 카드
		const insightBlock = this.resultsEl.createEl('div', { cls: 'tb-block tb-bridge-insight-block' });
		insightBlock.createEl('div', { cls: 'tb-bridge-insight-label', text: `${folderAName}  <->  ${folderBName}` });
		if (result.insight) insightBlock.createEl('div', { cls: 'tb-bridge-insight', text: result.insight });

		if (result.edges.length === 0) {
			insightBlock.createEl('div', { cls: 'tb-empty', text: '연결 가능한 엣지를 찾지 못했습니다.' });
			return;
		}

		// confidence ≥ 0.75 즉시 저장
		const autoSaved = new Set<string>();
		const highConf = result.edges.filter(e => (e.confidence ?? 0) >= 0.75);
		if (highConf.length > 0) {
			await this.store.saveBridgeEdges(highConf, fileMapA, fileMapB);
			for (const e of highConf) autoSaved.add(`${e.source_file}→${e.target_file}`);
			new Notice(`[ThirdBrain] Auto: 폴더 브릿지 ${autoSaved.size}개 연결 자동 저장`);
			// 그래프 자동 표시
			setTimeout(() => this.openNativeGraph([folderAName, folderBName]), 300);
		}

		// high-conf 없어서 자동 저장 0개면 → 칩 UI 표시
		const showChips = autoSaved.size === 0;
		if (!showChips) {
			// auto + 모두 자동 저장됨 → 간략 로그만
			const doneBlock = this.resultsEl.createEl('div', { cls: 'tb-block' });
			const toggle = doneBlock.createEl('div', { cls: 'tb-section-toggle' });
			toggle.createEl('span', { cls: 'tb-section-chevron', text: '▾' });
			toggle.createEl('span', { cls: 'tb-section-label', text: `✓ ${autoSaved.size}개 연결 자동 저장 완료` });
			const content = doneBlock.createEl('div', { cls: 'tb-section-content' });
			toggle.addEventListener('click', () => {
				const collapsed = content.hasClass('is-collapsed');
				content.toggleClass('is-collapsed', !collapsed);
				toggle.querySelector<HTMLElement>('.tb-section-chevron')!.textContent = collapsed ? '▾' : '▸';
			});
			for (const e of result.edges) {
				if (!autoSaved.has(`${e.source_file}→${e.target_file}`)) continue;
				const rel = RELATION_KO[e.relation] ?? e.relation;
				const pct = Math.round((e.confidence ?? 0.5) * 100);
				const src = e.source_title ?? e.source_file.replace(/\.md$/, '');
				const tgt = e.target_title ?? e.target_file.replace(/\.md$/, '');
				content.createEl('div', { cls: 'tb-chip is-saved', text: `[${pct}%] ${src} ―${rel}→ ${tgt}` });
			}
			return;
		}

		// 칩 UI (고신뢰 없을 때)
		const edgeBlock = this.resultsEl.createEl('div', { cls: 'tb-block' });
		const toggle = edgeBlock.createEl('div', { cls: 'tb-section-toggle' });
		toggle.createEl('span', { cls: 'tb-section-chevron', text: '▾' });
		const label = `연결 후보 ${result.edges.length}개 — 높은 신뢰도 없음, 직접 선택`;
		toggle.createEl('span', { cls: 'tb-section-label', text: label });
		const edgeContent = edgeBlock.createEl('div', { cls: 'tb-section-content' });
		toggle.addEventListener('click', () => {
			const collapsed = edgeContent.hasClass('is-collapsed');
			edgeContent.toggleClass('is-collapsed', !collapsed);
			toggle.querySelector<HTMLElement>('.tb-section-chevron')!.textContent = collapsed ? '▾' : '▸';
		});

		edgeContent.createEl('div', { cls: 'tb-hint', text: '선택한 연결만 양쪽 파일에 저장됩니다.' });

		const chipRow = edgeContent.createEl('div', { cls: 'tb-edge-chips' });
		type BState = { edge: BridgeEdge; selected: boolean };
		const states: BState[] = [];
		let bridgeLocked = false;
		// 저장 0개면 top-1 자동 선택
		const preSelectFirst = autoSaved.size === 0;

		for (let i = 0; i < result.edges.length; i++) {
			const edge = result.edges[i];
			const rel = RELATION_KO[edge.relation] ?? edge.relation;
			const pct = Math.round((edge.confidence ?? 0.5) * 100);
			const srcLabel = edge.source_title ?? edge.source_file.replace(/\.md$/, '');
			const tgtLabel = edge.target_title ?? edge.target_file.replace(/\.md$/, '');
			const isPreSelected = preSelectFirst && i === 0;

			const chip = chipRow.createEl('div', { cls: 'tb-chip' });
			const top = chip.createEl('div', { cls: 'tb-chip-top' });
			const icon = top.createEl('span', { cls: 'tb-chip-icon', text: isPreSelected ? '✓' : '◎' });
			top.createEl('span', { cls: 'tb-chip-conf', text: `[${pct}%]` });
			top.createEl('span', { cls: 'tb-chip-source', text: shortText(srcLabel, 14) });
			top.createEl('span', { cls: 'tb-chip-arrow', text: ` ―${rel}→ ` });
			top.createEl('span', { cls: 'tb-chip-target', text: tgtLabel });
			if (edge.reason) chip.createEl('div', { cls: 'tb-chip-reason', text: edge.reason });

			if (isPreSelected) chip.toggleClass('is-selected', true);
			const state: BState = { edge, selected: isPreSelected };
			states.push(state);
			chip.addEventListener('click', () => {
				if (bridgeLocked) return;
				state.selected = !state.selected;
				chip.toggleClass('is-selected', state.selected);
				icon.textContent = state.selected ? '✓' : '◎';
			});
		}

		const bar = edgeBlock.createEl('div', { cls: 'tb-savebar' });
		const saveBtn = bar.createEl('button', { cls: 'tb-btn is-primary', text: '[ 선택 연결 저장 ]' });
		saveBtn.addEventListener('click', async () => {
			const selected = states.filter(s => s.selected).map(s => s.edge);
			if (selected.length === 0) { new Notice('[ThirdBrain] 저장할 연결을 선택하세요.'); return; }
			bridgeLocked = true;
			chipRow.addClass('is-locked');
			saveBtn.disabled = true; saveBtn.textContent = '[ 저장 중... ]';
			try {
				await this.store.saveBridgeEdges(selected, fileMapA, fileMapB);
				new Notice(`[ThirdBrain] 폴더 브리지 ${selected.length}개 연결 저장 완료`);
				edgeBlock.remove();
				setTimeout(() => this.openNativeGraph([folderAName, folderBName]), 300);
			} catch (e) {
				bridgeLocked = false;
				chipRow.removeClass('is-locked');
				saveBtn.disabled = false; saveBtn.textContent = '[ 선택 연결 저장 ]';
				new Notice(`저장 실패: ${e instanceof Error ? e.message : String(e)}`);
			}
		});

		// Phase 5-3: 위상 동형성 근사 결과 카드
		const isoBlock = this.resultsEl.createEl('div', { cls: 'tb-block tb-iso-block' });
		const isoToggle = isoBlock.createEl('div', { cls: 'tb-section-toggle' });
		isoToggle.createEl('span', { cls: 'tb-section-chevron', text: '▸' });
		isoToggle.createEl('span', { cls: 'tb-section-label', text: '위상 동형 근사 (NP-Complete 근사 · 코사인 유사도)' });
		const isoContent = isoBlock.createEl('div', { cls: 'tb-section-content is-collapsed' });
		isoToggle.addEventListener('click', async () => {
			const collapsed = isoContent.hasClass('is-collapsed');
			isoContent.toggleClass('is-collapsed', !collapsed);
			isoToggle.querySelector<HTMLElement>('.tb-section-chevron')!.textContent = collapsed ? '▾' : '▸';
			if (collapsed && isoContent.children.length === 0) {
				const allNodes = await Promise.all([
					this.store.loadNodesInFolder(folderAName),
					this.store.loadNodesInFolder(folderBName),
				]);
				const candidates = compareSubgraphs(allNodes[0], allNodes[1], 5);
				if (candidates.length === 0) {
					isoContent.createEl('div', { cls: 'tb-empty', text: '구조적 유사 쌍을 찾지 못했습니다.' });
				} else {
					for (const c of candidates) {
						const pct = Math.round(c.cosineSimilarity * 100);
						const card = isoContent.createEl('div', { cls: 'tb-iso-card' });
						card.createEl('span', { cls: 'tb-iso-sim', text: `${pct}%` });
						card.createEl('span', { cls: 'tb-iso-pair', text: c.explanation });
					}
				}
			}
		});
	}

	// ── 단일 노드 브릿지 결과 렌더 ──────────────────────────
	// recommendTransplantEdges 결과 → 칩 UI (confidence 표시, auto 모드 지원)

	private async renderSingleNodeBridge(
		movedFile: TFile,
		sourceTitle: string,
		candidates: Array<{ target_title: string; relation: string; confidence?: number; reason: string }>,
		targetNodes: import('./types').TBNode[]
	) {
		const titleToFile = new Map<string, TFile>();
		for (const n of targetNodes) {
			const f = this.app.vault.getFileByPath(n.filePath);
			if (f) titleToFile.set(n.title, f);
		}

		const saveSingleEdge = async (c: typeof candidates[0]) => {
			const targetFile = titleToFile.get(c.target_title);
			if (!targetFile) return;
			const fwd: TBEdge = { target: `[[${c.target_title}]]`, label: toRelation(c.relation), confirmed: true, reason: c.reason, confidence: c.confidence ?? 1.0, axiom_basis: '' };
			const bwd: TBEdge = { target: `[[${movedFile.basename}]]`, label: toRelation(c.relation), confirmed: true, reason: c.reason, confidence: c.confidence ?? 1.0, axiom_basis: '' };
			await this.app.fileManager.processFrontMatter(movedFile, (fm) => {
				const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
				if (!edges.find(e => e.target === fwd.target)) edges.push(fwd);
				fm.tb_edges = edges; fm.tb_links = edges.map(e => e.target);
			});
			await this.app.fileManager.processFrontMatter(targetFile, (fm) => {
				const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
				if (!edges.find(e => e.target === bwd.target)) edges.push(bwd);
				fm.tb_edges = edges; fm.tb_links = edges.map(e => e.target);
			});
		};

		const insightBlock = this.resultsEl.createEl('div', { cls: 'tb-block tb-bridge-insight-block' });
		insightBlock.createEl('div', { cls: 'tb-bridge-insight-label', text: `이식 완료: ${sourceTitle}` });

		if (candidates.length === 0) {
			insightBlock.createEl('div', { cls: 'tb-empty', text: '연결 가능한 엣지를 찾지 못했습니다.' });
			return;
		}

		// confidence ≥ 0.75 자동 저장
		const autoSaved = new Set<string>();
		const highConf = candidates.filter(c => (c.confidence ?? 0) >= 0.75);
		if (highConf.length > 0) {
			for (const c of highConf) {
				await saveSingleEdge(c);
				autoSaved.add(c.target_title);
			}
			new Notice(`[ThirdBrain] Auto: ${autoSaved.size}개 연결 자동 저장 (confidence ≥ 75%)`);
		}

		// 칩 섹션
		const edgeBlock = this.resultsEl.createEl('div', { cls: 'tb-block' });
		const toggle = edgeBlock.createEl('div', { cls: 'tb-section-toggle' });
		toggle.createEl('span', { cls: 'tb-section-chevron', text: '▾' });
		const autoLabel = autoSaved.size > 0 ? ` (${autoSaved.size}개 자동 저장됨)` : '';
		toggle.createEl('span', {
			cls: 'tb-section-label',
			text: `연결 후보 ${candidates.length}개${autoLabel}`,
		});
		const edgeContent = edgeBlock.createEl('div', { cls: 'tb-section-content' });
		toggle.addEventListener('click', () => {
			const collapsed = edgeContent.hasClass('is-collapsed');
			edgeContent.toggleClass('is-collapsed', !collapsed);
			toggle.querySelector<HTMLElement>('.tb-section-chevron')!.textContent = collapsed ? '▾' : '▸';
		});

		const hintText = autoSaved.size === 0
			? '높은 신뢰도 연결이 없습니다. 연결할 항목을 직접 선택하세요.'
			: '선택한 연결을 추가로 저장할 수 있습니다.';
		edgeContent.createEl('div', { cls: 'tb-hint', text: hintText });

		const chipRow = edgeContent.createEl('div', { cls: 'tb-edge-chips' });
		type State = { c: typeof candidates[0]; selected: boolean; saved: boolean };
		const states: State[] = [];
		let transplantLocked = false;

		// high-conf 없으면 1위 자동 선택
		const preSelectFirst = autoSaved.size === 0;

		for (let i = 0; i < candidates.length; i++) {
			const c = candidates[i];
			const rel = RELATION_KO[c.relation] ?? c.relation;
			const pct = Math.round((c.confidence ?? 0.5) * 100);
			const isSaved = autoSaved.has(c.target_title);
			const isPreSelected = preSelectFirst && i === 0;

			const chip = chipRow.createEl('div', { cls: `tb-chip${isSaved ? ' is-saved' : ''}` });
			const top  = chip.createEl('div', { cls: 'tb-chip-top' });
			const icon = top.createEl('span', { cls: 'tb-chip-icon', text: isSaved ? '✓' : (isPreSelected ? '✓' : '◎') });
			top.createEl('span', { cls: 'tb-chip-conf', text: `[${pct}%]` });
			top.createEl('span', { cls: 'tb-chip-source', text: shortText(sourceTitle, 14) });
			top.createEl('span', { cls: 'tb-chip-arrow', text: ` ―${rel}→ ` });
			top.createEl('span', { cls: 'tb-chip-target', text: c.target_title });
			if (c.reason) chip.createEl('div', { cls: 'tb-chip-reason', text: c.reason });

			if (isSaved) chip.toggleClass('is-selected', true);

			const state: State = { c, selected: isSaved || isPreSelected, saved: isSaved };
			states.push(state);
			if (isPreSelected) chip.toggleClass('is-selected', true);

			if (!isSaved) {
				chip.addEventListener('click', () => {
					if (transplantLocked) return;
					state.selected = !state.selected;
					chip.toggleClass('is-selected', state.selected);
					icon.textContent = state.selected ? '✓' : '◎';
				});
			}
		}

		const bar = edgeBlock.createEl('div', { cls: 'tb-savebar' });
		const saveBtn = bar.createEl('button', { cls: 'tb-btn is-primary', text: '[ 선택 연결 저장 ]' });

		saveBtn.addEventListener('click', async () => {
			const toSave = states.filter(s => s.selected && !s.saved);
			if (toSave.length === 0) { new Notice('[ThirdBrain] 저장할 연결을 선택하세요.'); return; }
			transplantLocked = true;
			chipRow.addClass('is-locked');
			saveBtn.disabled = true;
			saveBtn.textContent = '[ 저장 중... ]';
			try {
				for (const { c } of toSave) await saveSingleEdge(c);
				new Notice(`[ThirdBrain] ${toSave.length}개 연결 저장 완료`);
				edgeBlock.remove();
			} catch (e) {
				transplantLocked = false;
				chipRow.removeClass('is-locked');
				saveBtn.disabled = false;
				saveBtn.textContent = '[ 선택 연결 저장 ]';
				new Notice(`저장 실패: ${e instanceof Error ? e.message : String(e)}`);
			}
		});
	}

}

// ── 파이프라인 결과 모달 ──────────────────────────────────

class PipelineInfoModal extends Modal {
	stepLogEl!: HTMLElement;

	onOpen() {
		this.modalEl.addClass('tb-pipeline-modal');
		this.titleEl.setText('파이프라인 결과');

		// 최초 open 시에만 stepLogEl 생성 (재오픈 시 이미 존재)
		if (!this.stepLogEl) {
			this.stepLogEl = this.contentEl.createEl('div', { cls: 'tb-step-log' });
		}

		this.contentEl.style.overflowY = 'auto';
		this.contentEl.style.maxHeight = '80vh';
	}

	onClose() { /* 내용 유지 — 다음 파이프라인 실행 시 새 인스턴스로 교체됨 */ }
}

// ── 그래프 보기 모달 ──────────────────────────────────────

class GraphViewModal extends Modal {
	private folders: string[];
	private onChoose: (folders: string[]) => void;

	constructor(app: App, folders: string[], onChoose: (f: string[]) => void) {
		super(app);
		this.folders = folders;
		this.onChoose = onChoose;
		this.modalEl.addClass('tb-popup');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: '그래프 보기' });
		makeDraggable(this.modalEl, titleEl);
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: '여러 폴더를 선택할 수 있습니다.' });

		const list = contentEl.createEl('div', { cls: 'tb-popup-folder-list' });

		if (this.folders.length === 0) {
			list.createEl('div', { cls: 'tb-popup-empty', text: '폴더 없음' });
			return;
		}

		const checkboxes: Array<{ folder: string; cb: HTMLInputElement }> = [];

		for (const folder of this.folders) {
			const depth = folder.split('/').length - 1;
			const name = folder.split('/').pop() ?? folder;
			const label = list.createEl('label', { cls: 'tb-popup-folder-item' });
			label.style.paddingLeft = `${14 + depth * 18}px`;
			const cb = label.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
			cb.addClass('tb-popup-cb');
			label.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
			label.createEl('span', { cls: 'tb-popup-folder-name', text: name });
			checkboxes.push({ folder, cb });
		}

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: '취소' })
			.addEventListener('click', () => this.close());
		const confirmBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: '그래프 열기' });
		confirmBtn.addEventListener('click', () => {
			const selected = checkboxes.filter(c => c.cb.checked).map(c => c.folder);
			if (selected.length === 0) { new Notice('[ThirdBrain] 폴더를 하나 이상 선택하세요.'); return; }
			this.close();
			this.onChoose(selected);
		});
	}

	onClose() { this.contentEl.empty(); }
}

// ── 폴더 브리지 모달 ──────────────────────────────────────

class BridgeModal extends Modal {
	private folders: string[];
	private onRun: (folderA: string, folderB: string) => void;

	constructor(app: App, folders: string[], onRun: (a: string, b: string) => void) {
		super(app);
		this.folders = folders;
		this.onRun = onRun;
		this.modalEl.addClass('tb-popup');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const bridgeTitleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: '폴더 브리지' });
		makeDraggable(this.modalEl, bridgeTitleEl);
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: '두 폴더를 선택하면 AI가 구조적 연결을 찾아드립니다.' });

		const makeSelect = (label: string): HTMLSelectElement => {
			const row = contentEl.createEl('div', { cls: 'tb-popup-select-row' });
			row.createEl('label', { cls: 'tb-popup-select-label', text: label });
			const sel = row.createEl('select', { cls: 'tb-popup-select' });
			for (const f of this.folders) {
				sel.createEl('option', { attr: { value: f }, text: f });
			}
			return sel;
		};

		const selA = makeSelect('폴더 A');
		const selB = makeSelect('폴더 B');
		if (this.folders.length > 1) selB.value = this.folders[1];

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: '취소' })
			.addEventListener('click', () => this.close());
		const runBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: '브리지 실행' });
		runBtn.addEventListener('click', () => {
			const a = selA.value;
			const b = selB.value;
			if (!a || !b) { new Notice('[ThirdBrain] 두 폴더를 모두 선택하세요.'); return; }
			if (a === b) { new Notice('[ThirdBrain] 서로 다른 폴더를 선택하세요.'); return; }
			this.close();
			this.onRun(a, b);
		});
	}

	onClose() { this.contentEl.empty(); }
}

// ── 저장 폴더 선택 모달 ──────────────────────────────────

class SaveFolderModal extends Modal {
	private folders: string[];
	private currentFolder: string;
	private onChoose: (folder: string) => void;

	constructor(app: App, folders: string[], currentFolder: string, onChoose: (folder: string) => void) {
		super(app);
		this.folders = folders;
		this.currentFolder = currentFolder;
		this.onChoose = onChoose;
		this.modalEl.addClass('tb-popup');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: '저장 폴더 선택' });
		makeDraggable(this.modalEl, titleEl);
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: '노드를 저장할 폴더를 선택하세요.' });

		const list = contentEl.createEl('div', { cls: 'tb-popup-folder-list' });

		let selected = this.currentFolder;

		const items: Array<{ el: HTMLElement; path: string }> = [];

		const updateSelected = () => {
			for (const item of items) {
				item.el.toggleClass('is-selected', item.path === selected);
				const nameEl = item.el.querySelector<HTMLElement>('.tb-popup-folder-name');
				if (nameEl) nameEl.style.color = item.path === selected ? 'var(--tb-primary)' : '';
			}
		};

		// 루트 옵션
		const rootItem = list.createEl('div', { cls: 'tb-popup-folder-item' });
		rootItem.createEl('span', { cls: 'tb-popup-folder-icon', text: '🏠' });
		rootItem.createEl('span', { cls: 'tb-popup-folder-name', text: '루트 (최상위)' });
		rootItem.addEventListener('click', () => { selected = ''; updateSelected(); });
		items.push({ el: rootItem, path: '' });

		for (const folder of this.folders) {
			const depth = folder.split('/').length - 1;
			const name = folder.split('/').pop() ?? folder;
			const item = list.createEl('div', { cls: 'tb-popup-folder-item' });
			item.style.paddingLeft = `${14 + depth * 18}px`;
			item.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
			item.createEl('span', { cls: 'tb-popup-folder-name', text: name });
			item.addEventListener('click', () => { selected = folder; updateSelected(); });
			items.push({ el: item, path: folder });
		}

		updateSelected();

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: '취소' })
			.addEventListener('click', () => this.close());
		footer.createEl('button', { cls: 'tb-btn is-primary', text: '저장' })
			.addEventListener('click', () => { this.close(); this.onChoose(selected); });
	}

	onClose() { this.contentEl.empty(); }
}

// ── 그래프 분석 모달 (경로 탐색 포함) ─────────────────────

const ANALYSIS_INTENTS: Array<{ label: string; prompt: string; mode: 'rich' | 'summary' }> = [
	{ label: '핵심 파악', prompt: '가장 중요한 주장 3개와 그 근거를 중심으로 정리하라.', mode: 'summary' },
	{ label: '논리 구조', prompt: 'causes·precedes·precondition_of 체인을 따라 인과 흐름과 전제-결론 관계를 중심으로 분석하라.', mode: 'rich' },
	{ label: '모순 탐지', prompt: 'conflicts_with·contrasts_with 엣지 중심으로 상충하는 주장들을 전면에 드러내고, 어디서 충돌하는지 명확히 분석하라.', mode: 'rich' },
	{ label: '발표 준비', prompt: '청중에게 설명하는 스토리라인 형태로 재구성하라. 핵심 메시지 → 근거 → 예시 순서로 정리하라.', mode: 'summary' },
	{ label: '의사결정', prompt: 'precondition_of·causes 엣지 기반으로 선택지와 각 선택의 전제·결과·위험을 대비하여 정리하라.', mode: 'rich' },
];

class AnalysisModal extends Modal {
	constructor(
		app: App,
		private readonly folders: string[],
		private readonly store: GraphStore,
		private readonly onRun: (folder: string, mode: 'rich' | 'summary', intent?: string, includeActions?: boolean) => void
	) {
		super(app);
		this.modalEl.addClass('tb-popup');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: '그래프 분석' });
		makeDraggable(this.modalEl, titleEl);
		contentEl.createEl('div', {
			cls: 'tb-popup-sub',
			text: '폴더 내 노드를 분석해 개요·주제·통찰·연결 맥락을 추출합니다.',
		});

		if (this.folders.length === 0) {
			contentEl.createEl('div', { cls: 'tb-popup-empty', text: '볼트에 폴더가 없습니다. 먼저 노드를 저장하세요.' });
			const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
			footer.createEl('button', { cls: 'tb-btn', text: '닫기' }).addEventListener('click', () => this.close());
			return;
		}

		const makeSelect = (label: string): HTMLSelectElement => {
			const row = contentEl.createEl('div', { cls: 'tb-popup-select-row' });
			row.createEl('label', { cls: 'tb-popup-select-label', text: label });
			return row.createEl('select', { cls: 'tb-popup-select' }) as HTMLSelectElement;
		};

		const folderSel = makeSelect('폴더');
		for (const f of this.folders) {
			if (f.endsWith('/_actions') || f === '_actions') continue;
			folderSel.createEl('option', { attr: { value: f }, text: f });
		}

		// ── _actions 포함 여부 (해당 폴더에 _actions 있을 때만 표시) ────
		const actionsRow = contentEl.createEl('div', { cls: 'tb-popup-select-row tb-actions-include-row' });
		actionsRow.style.display = 'none';
		const actionsChk = actionsRow.createEl('input', {
			attr: { type: 'checkbox', id: 'tb-include-actions' },
		}) as HTMLInputElement;
		const actionsLbl = actionsRow.createEl('label', {
			cls: 'tb-actions-include-label',
			attr: { for: 'tb-include-actions' },
			text: '_actions 폴더도 포함해서 분석',
		});
		void actionsLbl; // suppress unused warning

		const updateActionsRow = (folder: string) => {
			const hasActions = !!this.app.vault.getFolderByPath(`${folder}/_actions`);
			actionsRow.style.display = hasActions ? 'flex' : 'none';
			if (!hasActions) actionsChk.checked = false;
		};
		updateActionsRow(folderSel.value);
		folderSel.addEventListener('change', () => updateActionsRow(folderSel.value));

		// ── 분석 목적 칩 ────
		contentEl.createEl('div', { cls: 'tb-popup-select-label', text: '분석 목적 (선택 시 깊이 자동 추천)' });
		const chipRow = contentEl.createEl('div', { cls: 'tb-intent-chips' });
		let selectedIntent: string | undefined;
		let activeChip: HTMLElement | null = null;

		for (const intent of ANALYSIS_INTENTS) {
			const chip = chipRow.createEl('button', { cls: 'tb-intent-chip', text: intent.label });
			chip.addEventListener('click', () => {
				activeChip?.removeClass('is-active');
				if (activeChip === chip) {
					// 두 번 클릭 → 선택 해제
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

		// ── 직접 입력 ────
		const customRow = contentEl.createEl('div', { cls: 'tb-popup-select-row' });
		customRow.createEl('label', { cls: 'tb-popup-select-label', text: '또는 직접 입력' });
		const customInput = customRow.createEl('textarea', {
			cls: 'tb-intent-custom',
			attr: { placeholder: '예) 투자자에게 발표할 요약을 만들어줘', rows: '2' },
		}) as HTMLTextAreaElement;
		customInput.addEventListener('input', () => {
			if (customInput.value.trim()) {
				activeChip?.removeClass('is-active');
				activeChip = null;
				selectedIntent = undefined;
			}
		});

		// ── 분석 깊이 ────
		const modeSel = makeSelect('분석 깊이');
		modeSel.createEl('option', { attr: { value: 'summary' }, text: '빠른 요약' });
		modeSel.createEl('option', { attr: { value: 'rich' }, text: '깊은 분석' });

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: '취소' }).addEventListener('click', () => this.close());
		footer.createEl('button', { cls: 'tb-btn is-secondary', text: '경로 탐색 →' }).addEventListener('click', () => {
			this.close();
			new PathFinderModal(this.app, this.folders, this.store).open();
		});
		footer.createEl('button', { cls: 'tb-btn is-primary', text: '분석 시작' }).addEventListener('click', () => {
			const folder = folderSel.value;
			const mode = modeSel.value as 'rich' | 'summary';
			if (!folder) { new Notice('[ThirdBrain] 폴더를 선택하세요.'); return; }
			const intent = customInput.value.trim() || selectedIntent;
			const includeActions = actionsChk.checked;
			this.close();
			this.onRun(folder, mode, intent, includeActions);
		});
	}

	onClose() { this.contentEl.empty(); }
}

// ── 분석 결과 모달 ─────────────────────────────────────────

class AnalysisResultModal extends Modal {
	constructor(
		app: App,
		private result: SummaryResult,
		private folderPath: string,
		private mode: 'rich' | 'summary' | undefined,
		private intent: string | undefined,
		private onSave: () => void,
	) { super(app); }

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass('tb-analysis-result-modal');

		// 가로 스크롤 방지, 세로는 자연스럽게 늘어나도록
		modalEl.style.maxWidth = 'min(640px, 92vw)';
		modalEl.style.width = '100%';
		modalEl.style.overflowX = 'hidden';
		modalEl.style.overflowY = 'auto';
		modalEl.style.maxHeight = '85vh';

		// 헤더
		const hdr = contentEl.createEl('div', { cls: 'tb-ar-header' });
		hdr.createEl('div', { cls: 'tb-ar-folder', text: `📊 ${this.folderPath}` });

		// 분석 기준 표시
		const modeLabel = this.mode === 'rich' ? '깊은 분석' : '빠른 요약';
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
			synthCard.createEl('div', { cls: 'tb-ar-synthesis-label', text: '종합 결론' });
			synthCard.createEl('div', { cls: 'tb-ar-synthesis-text', text: this.result.synthesis });
		}

		// 개요
		if (this.result.overview) {
			this.makeSection(body, '개요', el => {
				el.createEl('div', { cls: 'tb-ar-overview', text: this.result.overview });
			}, true);
		}

		// 주요 통찰
		if (this.result.highlights.length > 0) {
			this.makeSection(body, `💡 주요 통찰 · ${this.result.highlights.length}개`, el => {
				for (const h of this.result.highlights) {
					const row = el.createEl('div', { cls: 'tb-ar-highlight' });
					row.createEl('span', { cls: 'tb-ar-bullet', text: '·' });
					row.createEl('span', { text: h });
				}
			}, true);
		}

		// 주제 묶음
		if (this.result.themes.length > 0) {
			this.makeSection(body, `🏷 주제 묶음 · ${this.result.themes.length}개`, el => {
				for (const theme of this.result.themes) {
					const card = el.createEl('div', { cls: 'tb-ar-theme-card' });
					card.createEl('div', { cls: 'tb-ar-theme-title', text: theme.title });
					card.createEl('div', { cls: 'tb-ar-theme-desc', text: theme.description });
				}
			}, false);
		}

		// 연결 맥락
		if (this.result.link_contexts.length > 0) {
			this.makeSection(body, `🔗 연결 맥락 · ${this.result.link_contexts.length}개`, el => {
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
		footer.createEl('button', { cls: 'tb-btn', text: '닫기' }).addEventListener('click', () => this.close());
		footer.createEl('button', { cls: 'tb-btn is-primary', text: '결과 저장' }).addEventListener('click', () => {
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
		if (!open) content.style.display = 'none';
		fill(content);
		toggler.addEventListener('click', () => {
			const isOpen = content.style.display !== 'none';
			content.style.display = isOpen ? 'none' : '';
			toggler.toggleClass('is-open', !isOpen);
			toggler.querySelector('.tb-ar-chevron')!.textContent = isOpen ? '▸' : '▾';
		});
	}

	onClose() { this.contentEl.empty(); }
}

// ── 경로 탐색 모달 ─────────────────────────────────────────

class PathFinderModal extends Modal {
	private loadedNodes: TBNode[] = [];

	constructor(
		app: App,
		private readonly folders: string[],
		private readonly store: GraphStore
	) {
		super(app);
		this.modalEl.addClass('tb-popup');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: '경로 탐색' });
		makeDraggable(this.modalEl, titleEl);
		contentEl.createEl('div', {
			cls: 'tb-popup-sub',
			text: '노드 간 논리 경로를 BFS로 탐색합니다. causes/precedes 추이 체인도 감지합니다.',
		});

		// 폴더 선택 → 노드 로드
		const folderRow = contentEl.createEl('div', { cls: 'tb-popup-select-row' });
		folderRow.createEl('label', { cls: 'tb-popup-select-label', text: '폴더' });
		const folderSel = folderRow.createEl('select', { cls: 'tb-popup-select' }) as HTMLSelectElement;
		folderSel.createEl('option', { attr: { value: '' }, text: '— 폴더 선택 —' });
		for (const f of this.folders) folderSel.createEl('option', { attr: { value: f }, text: f });

		// 출발·도착 SELECT (폴더 선택 후 활성화)
		const srcRow = contentEl.createEl('div', { cls: 'tb-popup-select-row' });
		srcRow.createEl('label', { cls: 'tb-popup-select-label', text: '출발' });
		const srcSel = srcRow.createEl('select', { cls: 'tb-popup-select' }) as HTMLSelectElement;
		srcSel.createEl('option', { attr: { value: '' }, text: '— 노드 선택 —' });
		srcSel.disabled = true;

		const dstRow = contentEl.createEl('div', { cls: 'tb-popup-select-row' });
		dstRow.createEl('label', { cls: 'tb-popup-select-label', text: '도착' });
		const dstSel = dstRow.createEl('select', { cls: 'tb-popup-select' }) as HTMLSelectElement;
		dstSel.createEl('option', { attr: { value: '' }, text: '— 노드 선택 —' });
		dstSel.disabled = true;

		const resultEl = contentEl.createEl('div', { cls: 'tb-path-result' });

		// 폴더 변경 → 노드 로드
		folderSel.addEventListener('change', async () => {
			if (!folderSel.value) return;
			srcSel.disabled = true; dstSel.disabled = true;
			srcSel.empty(); dstSel.empty();
			srcSel.createEl('option', { attr: { value: '' }, text: '로딩 중...' });
			dstSel.createEl('option', { attr: { value: '' }, text: '로딩 중...' });
			resultEl.empty();

			const nodes = await this.store.loadNodesInFolder(folderSel.value);
			this.loadedNodes = nodes;

			srcSel.empty(); dstSel.empty();
			srcSel.createEl('option', { attr: { value: '' }, text: '— 출발 노드 선택 —' });
			dstSel.createEl('option', { attr: { value: '' }, text: '— 도착 노드 선택 —' });
			for (const n of nodes) {
				srcSel.createEl('option', { attr: { value: n.id }, text: n.title });
				dstSel.createEl('option', { attr: { value: n.id }, text: n.title });
			}
			srcSel.disabled = false; dstSel.disabled = false;
		});

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: '닫기' }).addEventListener('click', () => this.close());
		const searchBtn = footer.createEl('button', { cls: 'tb-btn is-primary', text: '탐색' });

		searchBtn.addEventListener('click', async () => {
			const srcId = srcSel.value;
			const dstId = dstSel.value;
			if (!srcId || !dstId) {
				resultEl.empty();
				resultEl.createEl('div', { cls: 'tb-path-empty', text: '출발·도착 노드를 선택하세요.' });
				return;
			}
			if (srcId === dstId) {
				resultEl.empty();
				resultEl.createEl('div', { cls: 'tb-path-empty', text: '출발과 도착이 같습니다.' });
				return;
			}

			searchBtn.disabled = true;
			searchBtn.textContent = '탐색 중...';
			resultEl.empty();

			try {
				const nodes = this.loadedNodes;
				const tensor = buildTensor(nodes);
				resultEl.createEl('div', {
					cls: 'tb-path-meta',
					text: `${nodes.length}개 노드 / ${tensor.edges.length}개 엣지`,
				});

				const path = findPath(tensor, srcId, dstId, 6);
				if (path) {
					this.renderPath(resultEl, path, nodes, tensor);
				} else {
					const transitivePaths = findTransitivePaths(tensor, srcId, dstId, 6);
					if (transitivePaths.length > 0) {
						for (const tp of transitivePaths) this.renderPath(resultEl, tp, nodes, tensor);
					} else {
						const srcTitle = nodes.find(n => n.id === srcId)?.title ?? srcId;
						const dstTitle = nodes.find(n => n.id === dstId)?.title ?? dstId;
						resultEl.createEl('div', {
							cls: 'tb-path-empty',
							text: `"${srcTitle}" → "${dstTitle}" 사이에 6홉 이내 경로 없음.`,
						});
					}
				}
			} catch (err) {
				resultEl.empty();
				resultEl.createEl('div', {
					cls: 'tb-path-empty',
					text: `탐색 실패: ${err instanceof Error ? err.message : String(err)}`,
				});
			} finally {
				searchBtn.disabled = false;
				searchBtn.textContent = '탐색';
			}
		});
	}

	private renderPath(
		container: HTMLElement,
		path: GraphPath,
		nodes: TBNode[],
		tensor: ReturnType<typeof buildTensor>
	) {
		const titleById = new Map(nodes.map(n => [n.id, n.title]));
		const card = container.createEl('div', {
			cls: path.isTransitive ? 'tb-path-card tb-path-transitive' : 'tb-path-card',
		});

		// 헤더
		const header = card.createEl('div', { cls: 'tb-path-header' });
		if (path.isTransitive) {
			header.createEl('span', { cls: 'tb-path-transitive-badge', text: '추이 추론' });
		}
		header.createEl('span', {
			cls: 'tb-path-meta-inline',
			text: `${path.nodes.length - 1}홉 · 신뢰도 ${(path.totalConfidence * 100).toFixed(0)}%`,
		});

		// 홉 시각화
		const chain = card.createEl('div', { cls: 'tb-path-chain' });
		for (let i = 0; i < path.nodes.length; i++) {
			const nodeId = path.nodes[i];
			const nodeTitle = titleById.get(nodeId) ?? nodeId;
			const nodeEl = chain.createEl('span', { cls: 'tb-path-node', text: nodeTitle });

			// 클릭 → 해당 노드 열기
			nodeEl.addEventListener('click', () => {
				const node = nodes.find(n => n.id === nodeId);
				if (node?.filePath) {
					const file = this.app.vault.getFileByPath(node.filePath);
					if (file) this.app.workspace.getLeaf().openFile(file);
				}
			});

			if (i < path.relations.length) {
				const rel = path.relations[i];
				const relKo = RELATION_KO[rel] ?? rel;
				chain.createEl('span', { cls: 'tb-path-arrow', text: `→[${relKo}]→` });
			}
		}

		// 추이 경로: 볼트에 저장 버튼
		if (path.isTransitive && path.nodes.length >= 3) {
			const srcId = path.nodes[0];
			const dstId = path.nodes[path.nodes.length - 1];
			const inferredRel = path.relations[0]; // 체인의 첫 관계 유형

			const confirmBtn = card.createEl('button', {
				cls: 'tb-btn tb-path-confirm-btn',
				text: `볼트에 추이 엣지 저장 (${RELATION_KO[inferredRel] ?? inferredRel})`,
			});
			confirmBtn.addEventListener('click', async () => {
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
						reason: `추이 추론 (${path.nodes.map(id => titleById.get(id) ?? id).join(' → ')})`,
						confidence: path.totalConfidence,
						axiom_basis: `causes/precedes 체인 추이성: ${path.nodes.map(id => titleById.get(id) ?? id).join(' → ')}`,
					};
					await this.store.confirmEdge(srcFile, newEdge);
					confirmBtn.textContent = '저장됨 ✓';
					confirmBtn.addClass('tb-chip-connect-done');

					// 텐서 증분 업데이트
					addNodeToTensor(tensor, { ...srcNode, edges: [...srcNode.edges, newEdge] });
				} catch (err) {
					confirmBtn.disabled = false;
					new Notice(`[ThirdBrain] 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
				}
			});
		}
	}

	onClose() { this.contentEl.empty(); }
}



function makeDraggable(modalEl: HTMLElement, handle: HTMLElement): void {
	handle.addEventListener('mousedown', (e: MouseEvent) => {
		e.preventDefault();
		const rect = modalEl.getBoundingClientRect();
		modalEl.style.position = 'fixed';
		modalEl.style.margin = '0';
		modalEl.style.left = rect.left + 'px';
		modalEl.style.top = rect.top + 'px';
		modalEl.style.transform = 'none';

		const dx = e.clientX - rect.left;
		const dy = e.clientY - rect.top;

		const onMove = (e: MouseEvent) => {
			modalEl.style.left = (e.clientX - dx) + 'px';
			modalEl.style.top  = (e.clientY - dy) + 'px';
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	});
}
