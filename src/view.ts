import { ItemView, Notice, Platform, TFile, WorkspaceLeaf, normalizePath, requestUrl, sanitizeHTMLToDom } from 'obsidian';
import type ThirdBrainPlugin from './main';
import { getT } from './i18n';
import type { TKey } from './i18n';
import { DONATE_QR_BASE64 } from './donate-qr';
import { SOOTBALL_LOGO, SOOTBALL_WAITING, SOOTBALL_HUNGRY } from './sootball';
import {
	CHUNK_SIZE,
	extractContexts,
	extractPropositions,
	extractEdges,
	findContrastsAnalogies,
	normalizeSpeakers,
	identifySpeakerRoster,
	detectProblems,
	bridgeFolders,
	summarizeFolder,
	recommendTransplantEdges,
	findCrossConnections,
} from './engine/serial-pipeline';
import type { FolderDigestNode, CrossConnection, SpeakerNormResult, SpeakerRoster, DetectedProblem } from './engine/serial-pipeline';
import { splitIntoChunks, reflowTranscript } from './engine/text-utils';
import { getSessionStats, setRequestUrl } from './engine/cli-bridge';
import { GraphStore } from './engine/graph-store';
import { isMisassignedContext, shouldLinkContext, bestContextByRelevance, contextRelevanceScore } from './engine/context-relevance';
import type { TBFrontMatter } from './engine/graph-store';
import { detectConflicts } from './engine/contradiction-engine';
import { extractPdfText } from './engine/pdf-extractor';
import { transcribeAudioFile } from './engine/audio-transcriber';
import { MissionControlModal } from './components/workbench';
import { extractActions, linkActionsToPropositions, generateNaiveSummary, extractCoreFlow, type TranscriptAnalysisMode } from './engine/serial-pipeline';
import { confirmAICost } from './components/ai-preflight';
import { relLabel, progressBar, sanitizeId, shortText, conflictNodeDetail } from './components/modals/shared';
import { PipelineInfoModal, RequireOpenAIModal } from './components/modals/misc-modals';
import { ContentTypeModal, SaveFolderModal, type ContentTypeSelection } from './components/modals/ingest-modals';
import { BridgeModal, BridgeResultModal, SingleNodeBridgeModal } from './components/modals/bridge-modals';
import { GraphCanvasModal, GraphViewModal } from './components/modals/graph-modals';
import { AnalysisTabbedModal, AnalysisResultModal } from './components/modals/analysis-modals';
import { BrainStatusModal, ConflictResolutionModal } from './components/modals/brain-status-modal';
import {
	toRelation,
} from './types';
import type {
	TBNode,
	TBEdge,
	ContextLayer,
	Insight,
	Proposition,
	LogicEdge,
	LogicLayer,
	EdgeCandidate,
	SummaryResult,
	ConflictReport,
	ActionNode,
	ActionStatus,
	MeetingType,
	ContentType,
	DialogueSubtype,
} from './types';

export const VIEW_TYPE = 'thirdbrain-view';

/** 문제 노트 파일 → 세션 폴더 경로 (`{session}/_problems/문제.md` → `{session}`) */
export function sessionFolderOfProblem(problemFile: TFile): string {
	return (problemFile.parent?.path ?? '').replace(/\/?_problems$/, '');
}

/** [v0.3.5] 액션 실질 중복 판정 — from_problem 액션과 회의 액션 레이어가 서로 모른 채
 *  같은 일을 두 번 만드는 것을 막는다. 제목 토큰 겹침(양방향 최대) 또는 동기 명제 겹침으로 판단. */
function isSimilarAction(
	aTitle: string, aMotivs: string[],
	bTitle: string, bMotivs: string[],
): boolean {
	const titleScore = Math.max(
		contextRelevanceScore(aTitle, { title: bTitle }),
		contextRelevanceScore(bTitle, { title: aTitle }),
	);
	if (titleScore >= 0.5) return true;
	if (aMotivs.length > 0 && bMotivs.length > 0) {
		const setB = new Set(bMotivs);
		const inter = aMotivs.filter(m => setB.has(m)).length;
		if (inter / Math.min(aMotivs.length, bMotivs.length) >= 0.67 && titleScore >= 0.25) return true;
	}
	return false;
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
	private conflictBubbleEl!: HTMLElement;
	private badgeRefreshTimer: number | null = null;
	private dropZoneEl!: HTMLElement;
	private fileBtnEl!: HTMLButtonElement;
	private fileInputEl!: HTMLInputElement;

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
		void this.refreshConflictBubble();

		// 노드 파일 삭제 시 배지 갱신 — 유저가 그래프를 지우면 미해소 모순 카운트도 즉시 반영
		this.registerEvent(this.app.vault.on('delete', () => this.scheduleBadgeRefresh()));
		this.registerEvent(this.app.vault.on('rename', () => this.scheduleBadgeRefresh()));

		this.resultsEl = this.ingestContainer.createEl('div', { cls: 'tb-results' });
	}

	async onClose() {
		if (this.badgeRefreshTimer !== null) { window.clearTimeout(this.badgeRefreshTimer); this.badgeRefreshTimer = null; }
	}

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
		this.dropZoneEl = dropZone;
		const faceEl = dropZone.createEl('div', { cls: 'tb-dropzone-face is-clickable' });
		faceEl.appendChild(sanitizeHTMLToDom(SOOTBALL_WAITING));
		faceEl.setAttribute('title', this.plugin.settings.lang === 'ko'
			? '클릭 — 뇌 상태 (폴더별 미션·미연결·모순)'
			: 'Click — Brain status (missions, unlinked & conflicts by folder)');
		const openBrainStatus = () => {
			new BrainStatusModal(
				this.app, this.store, this.plugin.settings,
				// 작업대 = 미션 컨트롤 (해당 폴더·미션으로 바로 진입)
				(folder, missionId) => { this.openMissionControl({ folder, missionId }); },
				this.getFolderPaths(),
			).open();
		};
		// 숯검댕이 클릭 → 뇌 상태(폴더 단위 미션·미연결·모순). 드래그 밥주기와 공존(클릭 이벤트만 가로챔).
		faceEl.addEventListener('click', (e) => {
			e.stopPropagation();
			openBrainStatus();
		});
		// 모순 경고 말풍선 — faceEl은 드래그 시 empty()되므로 형제 요소로 둔다
		this.conflictBubbleEl = dropZone.createEl('div', { cls: 'tb-conflict-bubble', text: '!' });
		this.conflictBubbleEl.setAttribute('title', this.plugin.settings.lang === 'ko'
			? '미해소 모순 있음 — 클릭해서 확인'
			: 'Unresolved conflicts — click to review');
		this.conflictBubbleEl.hide();
		this.conflictBubbleEl.addEventListener('click', (e) => {
			e.stopPropagation();
			openBrainStatus();
		});
		const dropLabel = dropZone.createEl('div', { cls: 'tb-dropzone-label', text: this.t('dropzone_label') });
		const fileInput = dropZone.createEl('input', {
			attr: { type: 'file', accept: '.md,.txt,.pdf,.mp3', multiple: true },
		});
		this.fileInputEl = fileInput;
		fileInput.hide();
		const fileBtn = dropZone.createEl('button', { cls: 'tb-file-btn', text: this.t('file_btn') });
		this.fileBtnEl = fileBtn;
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

		// [v0.3.5] 🎯 미션 컨트롤 — 폴더 RAG 작업대 (기존 A↔B 브릿지는 Level 1 보조 버튼으로 이동)
		this.bridgeBtn = actions.createEl('button', { cls: 'tb-btn-secondary', text: this.t('btn_bridge') });
		this.bridgeBtn.addEventListener('click', () => { this.openMissionControl(); });


		this.fileCountEl = actions.createEl('div', { cls: 'tb-file-count', text: this.vaultCountText() });
	}

	/** 🎯 미션 컨트롤 열기 — initial을 주면 해당 폴더·미션 작업대로 바로 진입 (구 작업대 대체) */
	private openMissionControl(initial?: { folder: string; missionId?: string }) {
		new MissionControlModal(this.app, this.store, this.plugin.settings, {
			getFolderPaths: () => this.getFolderPaths(),
			onOpenBridge: () => {
				new BridgeModal(this.app, this.getFolderPaths(), (a, b) => { void this.runBridgeWithFolders(a, b); }, this.plugin.settings.lang).open();
			},
			setAIBusy: (on) => this.setAIBusy(on),
			isBusy: () => this._busyAI || this._busyIngest || this._busyBridge,
		}, initial).open();
	}

	// 모순 존재 시 숯검댕이 말풍선 "!" 표시 — 해소는 뇌 상태(폴더별)에서
	private async refreshConflictBubble(): Promise<void> {
		try {
			const conflicts = await this.store.scanConflicts();
			if (conflicts.length > 0) this.conflictBubbleEl.show();
			else this.conflictBubbleEl.hide();
		} catch {
			this.conflictBubbleEl.hide();
		}
	}

	// vault 파일 삭제/이름변경 시 배지 갱신 — 대량 삭제 대비 디바운스
	private scheduleBadgeRefresh(): void {
		if (this.badgeRefreshTimer !== null) window.clearTimeout(this.badgeRefreshTimer);
		this.badgeRefreshTimer = window.setTimeout(() => {
			this.badgeRefreshTimer = null;
			void this.refreshConflictBubble();
		}, 400);
	}

	private handleFileDrop(e: DragEvent) {
		if (this.dropZoneEl.hasClass('tb-dropzone-locked')) return;
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
		const mp3Files = files.filter(f => /\.mp3$/i.test(f.name));
		if (mp3Files.length > 0) {
			if (files.length > 1) new Notice(this.t('stt_notice_mp3_only'));
			await this.handleAudioFile(mp3Files[0]);
			return;
		}
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

	private setSTTInputLock(locked: boolean) {
		if (locked) {
			this.ingestTextarea.setAttribute('disabled', '');
			this.fileBtnEl.setAttribute('disabled', '');
			this.fileInputEl.setAttribute('disabled', '');
			this.dropZoneEl.addClass('tb-dropzone-locked');
		} else {
			this.ingestTextarea.removeAttribute('disabled');
			this.fileBtnEl.removeAttribute('disabled');
			this.fileInputEl.removeAttribute('disabled');
			this.dropZoneEl.removeClass('tb-dropzone-locked');
		}
	}

	private async handleAudioFile(file: File) {
		const settings = this.plugin.settings;
		if (settings.aiProvider !== 'openai') {
			new RequireOpenAIModal(this.app, this.plugin.manifest.id).open();
			return;
		}
		if (!settings.openaiApiKey?.trim()) {
			new Notice(this.t('stt_notice_need_key'));
			return;
		}
		if (file.size > 25 * 1024 * 1024) {
			new Notice(this.t('stt_notice_too_large'));
			return;
		}

		// AI 비용 확인 게이트 — mp3 크기로 길이·전사 규모를 근사(≈1MB/분, 분당 ~900자).
		const estMinutes = Math.max(1, Math.round(file.size / (1024 * 1024)));
		if (!(await confirmAICost(this.app, settings, {
			operation: 'audio', charCount: estMinutes * 900, units: 2, tier: 'fast', provider: 'openai',
		}))) return;

		this.setAIBusy(true);
		this.setIngestBusy(true);
		this.setSTTInputLock(true);
		try {
			const buf = await file.arrayBuffer();
			const result = await transcribeAudioFile(buf, file.name, settings, (step) => {
				const key = step === 'whisper' ? 'stt_progress_whisper'
					: step === 'speakers' ? 'stt_progress_speakers'
					: 'stt_progress_title';
				new Notice(this.t(key));
			});

			const dateStr = new Date().toISOString().slice(0, 10);
			const safeTitle = result.title.replace(/[\\/:*?"<>|]/g, '').trim();
			const fileName = `${safeTitle}_${dateStr}.md`;
			const folderPath = normalizePath(`${settings.rootFolder}/raw/stt_raw`);
			const filePath = normalizePath(`${folderPath}/${fileName}`);

			try {
				await this.app.vault.createFolder(folderPath);
			} catch { /* already exists */ }
			const sttFile = await this.app.vault.create(filePath, result.transcript);

			this.ingestTextarea.value = result.transcript;
			this.updateCharCount();
			this.syncIngestBtnState();
			// vault TFile로 넘겨야 파이프라인이 기존 stt_raw 파일에 위키링크를 달 수 있음
			this.ingestSource = { kind: 'vault', file: sttFile };

			new Notice(`${this.t('stt_saved')}: ${fileName}`);
		} catch (err) {
			new Notice(`[ThirdBrain] STT 오류: ${String(err)}`);
		} finally {
			this.setAIBusy(false);
			this.setIngestBusy(false);
			this.setSTTInputLock(false);
		}
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
		try {
			await this.runPipeline(content, undefined, targetFolder);
		} finally {
			// runPipeline은 성공 경로에서 busy를 끄지 않으므로 여기서 보장 해제
			this.setIngestBusy(false);
		}
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
		const selection = await new Promise<ContentTypeSelection | null>((resolve) => {
			new ContentTypeModal(this.app, resolve, this.plugin.settings.lang).open();
		});
		if (!selection) return;
		const { contentType, includeActionLayer, meetingType, dialogueSubtype } = selection;

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

		// AI 비용 확인 게이트 — 텍스트 소비 전에 물어본다(취소 시 입력 보존).
		// tbMatch(노드 재브릿지) 경로는 runBridgeFromIngest가 자체 게이트를 갖는다.
		if (!tbMatch) {
			const ok = await confirmAICost(this.app, this.plugin.settings, {
				operation: 'pipeline', charCount: text.length, tier: 'fast', provider: this.plugin.settings.aiProvider,
			});
			if (!ok) return;
		}

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

		if (Platform.isMobile) {
			new Notice(this.t('notice_mobile_keep_screen'), 6000);
		}

		type RawLink = { file: TFile; sourceSpan?: { text: string; offset: number } };
		const allRawLinks: RawLink[] = [];
		const allBlockIdSpans: Array<{ blockId: string; spanText: string }> = [];
		const canonicalParts: string[] = []; // 전사본: 청크별 정규화·재정형 텍스트 (raw 정본 교체용)
		const allPropositions: Proposition[] = []; // 핵심 플로우 추출용 — 이번 인제스트가 만든 명제 전체
		const allEdges: LogicEdge[] = [];          // 핵심 플로우 추출용 — 이번 인제스트가 만든 엣지 전체

		try {
			// 화자 정체성은 청크 경계를 넘어 일관돼야 한다 → 청킹 전에 전체 텍스트로 화자 명단을 1회 확정.
			// 확정된 로스터를 각 청크 정규화에 주입해 라벨이 조각나지 않게 한다.
			let speakerRoster: SpeakerRoster | undefined;
			if (contentType === 'meeting' || contentType === 'dialogue') {
				this.setProgress(1, this.t('progress_normalize'));
				speakerRoster = await identifySpeakerRoster(text, this.plugin.settings);
			}

			if (text.length > CHUNK_SIZE) {
				const chunks = splitIntoChunks(text, CHUNK_SIZE);
				for (let i = 0; i < chunks.length; i++) {
					this.setIngestBusy(true);
					this.setProgress(1, `(${i + 1}/${chunks.length}) ${this.t('progress_chunk')}`);
					const isLast = i === chunks.length - 1;
					const res = await this.runPipeline(chunks[i], undefined, selectedFolder, `청크 ${i + 1}/${chunks.length}`, includeActionLayer, rawFile, i === 0 && needsAutoTitle, isLast, meetingType, contentType, dialogueSubtype, speakerRoster);
					if (res) {
						allRawLinks.push(...res.rawLinks);
						allBlockIdSpans.push(...res.blockIdSpans);
						if (res.canonicalText) canonicalParts.push(res.canonicalText);
						if (res.propositions) allPropositions.push(...res.propositions);
						if (res.edges) allEdges.push(...res.edges);
					}
				}
			} else {
				const res = await this.runPipeline(text, undefined, selectedFolder, undefined, includeActionLayer, rawFile, needsAutoTitle, true, meetingType, contentType, dialogueSubtype, speakerRoster);
				if (res) {
					allRawLinks.push(...res.rawLinks);
					allBlockIdSpans.push(...res.blockIdSpans);
					if (res.canonicalText) canonicalParts.push(res.canonicalText);
					if (res.propositions) allPropositions.push(...res.propositions);
					if (res.edges) allEdges.push(...res.edges);
				}
			}

			// 모든 청크의 rawLinks를 한 번에 원본 파일에 기록 (청크별 덮어쓰기 방지)
			if (rawFile) {
				// [철학 §5] 전사본은 정규화·재정형본이 raw 정본 — 원본을 교체해야
				// source_span 문자열 검색(앵커·📌 인용)이 정확히 그 발화 그룹에 붙는다.
				// (익명화된 정본이 닻이 되므로 PII가 남지 않는 효과도 겸함)
				if (canonicalParts.length > 0) {
					await this.app.vault.modify(rawFile, canonicalParts.join('\n\n') + '\n').catch(() => {});
				}
				if (allBlockIdSpans.length > 0) {
					const anchorStats = await this.store.insertBlockIds(rawFile, allBlockIdSpans).catch(() => null);
					// 앵커 미매칭 가시화 — 그라운딩 품질 계측 (미매칭 0이 정상)
					if (anchorStats && anchorStats.missed > 0) {
						new Notice(this.plugin.settings.lang === 'ko'
							? `[ThirdBrain] 원문 앵커 ${anchorStats.matched}/${anchorStats.matched + anchorStats.missed} 매칭 — ${anchorStats.missed}건 미매칭`
							: `[ThirdBrain] Source anchors ${anchorStats.matched}/${anchorStats.matched + anchorStats.missed} matched — ${anchorStats.missed} missed`, 8000);
					}
				}
				if (allRawLinks.length > 0) {
					await this.store.appendLinksToRawFile(rawFile, allRawLinks).catch(() => {});
				}

				// 나이브 요약: 그래프화와 별개로 원문 전체를 훑어 커버리지를 보완 (실패해도 파이프라인은 유지)
				try {
					this.setProgress(10, this.t('progress_naive_summary'));
					const { title, summary } = await generateNaiveSummary(text, this.plugin.settings);
					if (summary) {
						// 핵심 플로우: 이번 인제스트가 만든 명제·엣지에서 causes/precedes/precondition_of
						// 연쇄 하나를 뽑아 요약 노트에 덧붙인다. 흐름이 없으면 빈 문자열 — 섹션 생략.
						this.setProgress(10, this.t('progress_core_flow'));
						const coreFlow = await extractCoreFlow(allPropositions, allEdges, this.plugin.settings)
							.catch(() => '');
						await this.store.saveNaiveSummary(title, summary, rawFile, coreFlow || undefined);
					}
				} catch {
					// 나이브 요약 실패는 무시 — 핵심 그래프화 결과에 영향 없음
				}
			}
		} catch {
			// 파이프라인 오류는 downstream에서 이미 Notice 처리됨 — 여기선 삼킴
		} finally {
			// 성공·실패 모두 전체 파이프라인(⑨ 크로스 연결 포함)이 끝난 뒤에만 busy 해제
			this.hideProgress();
			this.setIngestBusy(false);
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
		meetingType?: MeetingType,
		contentType: ContentType = 'document',
		dialogueSubtype?: DialogueSubtype,
		speakerRoster?: SpeakerRoster,
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

		// 0.5차: 화자 정규화 (회의/대화 전용) — 청킹 전에 확정한 전역 로스터를 주입해 라벨 일관성 보장
		let workingText = text;
		let _speakerNorm: SpeakerNormResult | null = null;
		const isTranscript = contentType === 'meeting' || contentType === 'dialogue';
		if (isTranscript) {
			this.setProgress(1, this.t('progress_normalize'));
			_speakerNorm = await timed(this.t('step_normalize'),
				() => normalizeSpeakers(text, this.plugin.settings, speakerRoster));
			// 재정형: 발화 그룹(빈 줄 구분)으로 재조립 — 명제 단락·raw 정본·^tb 앵커 경계를 일치시킨다.
			// 이 workingText가 runIngest에서 raw 정본으로 저장된다 (철학 §5: 정규화본이 물리적 닻).
			workingText = reflowTranscript(_speakerNorm.text);
		}

		try {
			// 1차: 문맥 분절
			let contexts: ContextLayer[];
			if (cachedContexts) {
				contexts = cachedContexts;
				this.renderContextLayer(contexts);
			} else {
				this.setProgress(2, this.t('progress_context'));
				contexts = await timed(this.t('step_context'), () => extractContexts(workingText, this.plugin.settings));
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
					() => extractPropositions(contexts, workingText, this.plugin.settings, contentType, dialogueSubtype));
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

			// Layer 3: 대조·유사성 전용 스캔 (contrasts_with / analogous_to)
			const contrastEdges = await timed(this.t('step_contrast'),
				() => findContrastsAnalogies(propositions, this.plugin.settings));
			// 중복 제거 후 병합
			const edgeKeys = new Set(rawEdges.map(e => `${e.source}→${e.target}`));
			const mergedEdges = [...rawEdges, ...contrastEdges.filter(e => !edgeKeys.has(`${e.source}→${e.target}`))];

			// 같은 쌍에 contrasts_with와 conflicts_with가 동시에 있으면 conflicts_with를 버린다.
			// contrasts_with는 "동시 참 가능" 판정이므로, 같은 쌍의 모순 판정은 자기모순인 거짓 경보다.
			const pairKey = (e: { source: string; target: string }) =>
				[e.source, e.target].sort().join('⟷');
			const contrastPairs = new Set(
				mergedEdges.filter(e => e.relation === 'contrasts_with').map(pairKey));
			const finalEdges = mergedEdges.filter(
				e => !(e.relation === 'conflicts_with' && contrastPairs.has(pairKey(e))));

			const logic: LogicLayer = { propositions, edges: finalEdges };
			this.hideProgress();
			// busy는 여기서 끄지 않는다 — 저장·액션·⑨ 크로스 연결까지 파이프라인이 이어지므로
			// 전체 완료(runIngest finally)까지 유지해야 그동안 버튼이 열리지 않는다.

			this.renderLogicLayer(logic);

			// targetFolder가 있으면 자동 저장 (중복 저장 방지)
			if (targetFolder) {
				// ⑨ 저장 전에 기존 노드 스냅샷 (새 파일 생성 전이어야 타이밍 문제 없음)
				const preExistingNodes = await this.store.loadNodesInFolder(targetFolder);

				this.setProgress(8, this.t('progress_save'));
				try {
					const result = await this.saveNodes(contexts, logic, targetFolder, rawSourcePath, rawFile);
					const { propFileMap, rawLinks, blockIdSpans } = result;
					this.hideProgress();
					new Notice(`${this.t('notice_graph_save_done_full')} (${logic.propositions.length}${this.t('notice_prop_suffix')}${logic.edges.length}${this.t('notice_edge_suffix')})`);

					// Phase 2: 모순 감지 — 마지막 청크에서만 실행 (중간 청크 중복 방지)
					if (isLastChunk) {
						const savedNodes = await this.store.loadNodesInFolder(targetFolder);
						const conflicts = detectConflicts(savedNodes);
						if (conflicts.length > 0) {
							this.renderConflictNotice(conflicts);
						}
						void this.refreshConflictBubble();

						// [Phase 10] 모순 → 문제 노드 조정 루프 (라이프사이클 부여, 진실의 원천은 엣지)
						await this.store.reconcileContradictionProblems(targetFolder, conflicts, savedNodes)
							.catch(() => { /* 조정 실패는 파이프라인 중단 안 함 */ });

						// [Phase 10] 문제 감지 (장애/공백/리스크) — 폴더 전체 명제의 긴장 스캔
						await this.detectAndSaveProblems(targetFolder, savedNodes, includeActionLayer);
					}

					// Phase 8: 액션 레이어 추출 (회의·일정 선택 시에만)
					// 명제 우선(토픽 내 종합)으로 도출 — 명제는 이미 화자 정규화본에서 나온 정제 소스.
					if (includeActionLayer) {
						this.setProgress(9, this.t('progress_action'));
						await this.extractAndSaveActions(
							logic.propositions,
							contexts,
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

					// 전사본은 정규화·재정형된 workingText가 정본 — runIngest가 raw 파일을 이것으로 교체
					return {
						rawLinks, blockIdSpans, canonicalText: isTranscript ? workingText : undefined,
						propositions: logic.propositions, edges: logic.edges,
					};
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

		// 2) 명제 저장 (명제↔문맥 엣지는 아래 connectContextsToPropositions에서 관련성 가드와 함께 생성)
		const propFileMap = await this.store.createPropositionBatch(
			logic.propositions, logic.edges, contextTags, targetFolder, rawSourcePath
		);

		const allFiles = [...contextFileMap.values(), ...propFileMap.values()];

		// [Phase 2] 명제에 소속 토픽(tb_topic) 기입 (membership — 논리 엣지 아님)
		await this.assignTopicMembership(
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
		propositions: Proposition[],
		contexts: ContextLayer[],
		propFileMap: Map<string, TFile>,
		folder: string,
		meetingType?: MeetingType
	): Promise<void> {
		try {
			// 액션은 명제 우선(토픽 내 종합)으로 도출 — 원문 텍스트를 다시 읽지 않는다.
			let actions = await extractActions(propositions, contexts, this.plugin.settings);
			if (actions.length === 0) return;
			actions = await linkActionsToPropositions(actions, propositions, this.plugin.settings);

			// [v0.3.5] 실질 중복 게이트 — 같은 폴더에 이미 저장된 액션(from_problem·이전 청크)과
			// 겹치는 후보는 생성을 생략한다. 동기 명제는 basename으로 비교(motivation_ids는 저장 시 basename화됨).
			const actionsDir = `${folder}/_actions/`;
			const existingActions = this.app.vault.getMarkdownFiles()
				.filter(f => f.path.startsWith(actionsDir))
				.map(f => {
					const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as TBFrontMatter | undefined;
					return {
						title: (typeof fm?.tb_title === 'string' ? fm.tb_title : undefined) ?? f.basename,
						motivs: Array.isArray(fm?.tb_action_motivation_ids) ? fm.tb_action_motivation_ids : [],
					};
				});
			if (existingActions.length > 0) {
				const motivBasenames = (ids: string[]) => ids
					.map(id => propFileMap.get(id)?.basename ?? id);
				actions = actions.filter(a => {
					const dup = existingActions.find(e =>
						isSimilarAction(a.title, motivBasenames(a.motivation_ids ?? []), e.title, e.motivs));
					return !dup;
				});
				if (actions.length === 0) return;
			}

			const propById = new Map(propositions.map(p => [p.id, p]));
			const savedActions: ActionNode[] = [];

			for (const a of actions) {
				const actionWithMeeting = meetingType ? { ...a, meeting_type: meetingType } : a;
				const actionFile = await this.store.createActionNode(actionWithMeeting, folder, propFileMap);
				// [옵션A] context→action은 논리 엣지(precondition_of)로 만들지 않는다.
				// 액션의 문맥 소속은 tb_motivation_context_ids 필드에 저장됨 (10공리 그래프 불변).
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

	// ── [Phase 10] 문제 레이어: 감지 → 저장 → from_problem 액션 → 카드 렌더 ──

	private async detectAndSaveProblems(
		folder: string,
		savedNodes: TBNode[],
		includeActionLayer: boolean,
	): Promise<void> {
		try {
			const NON_PROP_TYPES = new Set(['context', 'action', 'problem', 'summary', 'expression', 'raw']);
			const props = savedNodes
				.filter(n => !NON_PROP_TYPES.has(n.type) && n.content.trim().length > 0)
				.map(n => ({ id: n.id, title: n.title, text: n.content }));
			if (props.length === 0) return;

			const openProblemTitles = savedNodes
				.filter(n => n.type === 'problem' && n.problem_status === 'open')
				.map(n => n.title);

			this.setProgress(9, this.t('progress_problem'));
			const problems = await detectProblems(props, openProblemTitles, this.plugin.settings);
			if (problems.length === 0) return;

			// 증거 basename → TFile (from_problem 액션의 tb_links 해석용)
			const fileByBasename = new Map<string, TFile>();
			for (const n of savedNodes) {
				const f = this.app.vault.getFileByPath(n.filePath);
				if (f) fileByBasename.set(n.id, f);
			}

			// 증거 명제의 원문 인용을 문제 본문에 동봉 — 긴장이 실제 발화·문장에 뿌리내렸음을
			// 유저가 직접 확인할 수 있어야 한다 (역추적 철학: 인용 없는 문제는 공감 불가)
			const nodeById = new Map(savedNodes.map(n => [n.id, n]));
			const evidenceQuotes = (ids: string[]) => ids
				.map(id => {
					const n = nodeById.get(id);
					const quote = (n?.source_span?.text ?? '').replace(/\s+/g, ' ').trim();
					if (!n || !quote) return '';
					return `- **${n.title}**\n  > ${quote.length > 240 ? `${quote.slice(0, 240)}…` : quote}`;
				})
				.filter(Boolean)
				.join('\n');

			const saved: Array<{ file: TFile; problem: DetectedProblem }> = [];
			for (const p of problems) {
				const quotes = evidenceQuotes(p.evidence_ids);
				const file = await this.store.createProblemNode({
					title: p.title,
					description: quotes ? `${p.description}\n\n**증거 원문**\n${quotes}` : p.description,
					species: p.species,
					evidence_ids: p.evidence_ids,
				}, folder);
				saved.push({ file, problem: p });

				// 문제 해결 액션 — 액션 레이어를 켠 경우만 (기존 UX 게이트 존중)
				// [v0.3.5] 이전 청크의 회의 액션과 실질 중복이면 생성 생략 (역방향 중복 방지)
				const actionsDir = `${folder}/_actions/`;
				const dupWithExisting = includeActionLayer && p.suggested_action
					? this.app.vault.getMarkdownFiles()
						.filter(f => f.path.startsWith(actionsDir))
						.some(f => {
							const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as TBFrontMatter | undefined;
							const title = (typeof fm?.tb_title === 'string' ? fm.tb_title : undefined) ?? f.basename;
							const motivs = Array.isArray(fm?.tb_action_motivation_ids) ? fm.tb_action_motivation_ids : [];
							return isSimilarAction(p.suggested_action!.title, p.evidence_ids, title, motivs);
						})
					: false;
				if (includeActionLayer && p.suggested_action && !dupWithExisting) {
					await this.store.createActionNode({
						id: `act-prob-${Date.now().toString(36)}`,
						title: p.suggested_action.title,
						content: p.suggested_action.content,
						owner: '',
						deadline: '',
						status: 'pending',
						motivation_ids: p.evidence_ids,
						motivation_context_ids: [],
						link_type: p.suggested_action.link_type,
						origin: 'from_problem',
						problem_id: file.basename,
						created: new Date().toISOString(),
					}, folder, fileByBasename).catch(() => {});
				}
			}
			this.renderProblemResults(saved);
		} catch { /* 문제 감지 실패는 파이프라인을 중단시키지 않음 */ }
	}

	private renderProblemResults(items: Array<{ file: TFile; problem: DetectedProblem }>) {
		if (items.length === 0) return;
		const { content } = this.makeSectionToggle(
			`${this.t('layer_problem_header')} · ${items.length}${this.t('layer_count_generic')}`, false
		);
		for (const { file, problem } of items) {
			const card = content.createEl('div', { cls: `tb-problem-card is-${problem.species}` });
			const head = card.createEl('div', { cls: 'tb-problem-card-head' });
			head.createEl('span', {
				cls: `tb-problem-species is-${problem.species}`,
				text: this.t(`problem_species_${problem.species}` as TKey),
			});
			head.createEl('span', { cls: 'tb-problem-title', text: problem.title });
			if (problem.description) {
				card.createEl('div', { cls: 'tb-problem-desc', text: problem.description });
			}
			card.createEl('div', {
				cls: 'tb-problem-evidence',
				text: `${this.t('problem_evidence_label')}${problem.evidence_ids.join(', ')}`,
			});
			const btnRow = card.createEl('div', { cls: 'tb-problem-card-btns' });
			const workbenchBtn = btnRow.createEl('button', { cls: 'tb-btn tb-btn-sm tb-problem-workbench-btn', text: '🎯 작업대' });
			workbenchBtn.addEventListener('click', () => {
				this.openMissionControl({ folder: sessionFolderOfProblem(file), missionId: file.basename });
			});
			const resolveBtn = btnRow.createEl('button', { cls: 'tb-btn tb-btn-sm tb-problem-resolve-btn', text: this.t('problem_mark_resolved') });
			resolveBtn.addEventListener('click', () => {
				void this.store.updateProblemStatus(file, 'resolved', this.t('problem_resolved_by_user')).then(() => {
					card.addClass('is-resolved');
					resolveBtn.disabled = true;
				});
			});
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
			// 제목 아래 명제문 동봉 — 제목만으로는 왜 모순인지 유추할 수 없다
			const dA = conflictNodeDetail(c.nodeA);
			const dB = conflictNodeDetail(c.nodeB);
			if (dA.claim || dB.claim) {
				const detail = content.createEl('div', { cls: 'tb-conflict-notice-detail' });
				if (dA.claim) detail.createEl('div', { cls: 'tb-conflict-notice-claim', text: `A · ${dA.claim}` });
				if (dB.claim) detail.createEl('div', { cls: 'tb-conflict-notice-claim', text: `B · ${dB.claim}` });
			}
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
			// 크로스 연결은 명제↔명제 10공리 전용 → 액션·문맥·요약 등 비명제 노드는 대상에서 제외.
			// (제외하지 않으면 명제→액션 precondition_of 같은 논리 엣지가 생겨 그래프 순수성이 깨진다.)
			const NON_PROP_TYPES = new Set(['context', 'action', 'problem', 'summary', 'expression']);
			const propExistingNodes = preExistingNodes.filter(n => !NON_PROP_TYPES.has(n.type));
			if (propExistingNodes.length === 0) return;

			const newItems = newPropositions.slice(0, 15).map(p => ({
				title: p.title,
				content: p.text,
				tags: p.context ? [p.context] : [],
			}));

			const connections = await findCrossConnections(
				newItems,
				propExistingNodes,
				this.plugin.settings
			);

			if (connections.length === 0) {
				new Notice(this.t('notice_no_connection'));
				return;
			}

			// 파일 매핑
			const existingTitleToFile = new Map<string, TFile>();
			for (const n of propExistingNodes) {
				const f = this.app.vault.getFileByPath(n.filePath);
				if (f) existingTitleToFile.set(n.title, f);
			}
			const newTitleToFile = new Map<string, TFile>();
			for (const p of newPropositions) {
				const f = this.app.vault.getMarkdownFiles()
					.find(f => f.basename === p.title);
				if (f) newTitleToFile.set(p.title, f);
			}

			// 하이브리드: ≥0.75는 자동 저장(모든 후보가 axiom_basis 인용을 통과한 상태), 미만은 칩으로 유저 확정.
			// 기준 미달 시 최상위 1개를 강제 저장하던 폴백은 억지 연결이므로 폐기된 상태를 유지한다.
			const sorted = [...connections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
			const autoTargets = sorted.filter(c => (c.confidence ?? 0) >= 0.75);
			const pending = sorted.filter(c => (c.confidence ?? 0) < 0.75);

			const saved: CrossConnection[] = [];
			for (const conn of autoTargets) {
				const newFile = newTitleToFile.get(conn.new_title);
				const existFile = existingTitleToFile.get(conn.existing_title);
				if (!newFile || !existFile) continue;
				await this.saveCrossEdge(conn, newFile, existFile);
				saved.push(conn);
			}
			if (saved.length > 0) {
				this.renderCrossConnectionSavedLog(saved);
				new Notice(`[ThirdBrain] ⑨ ${saved.length}${this.t('conn_auto_saved_suffix')}`);
			}
			if (pending.length > 0) {
				new Notice(`[ThirdBrain] ⑨ ${pending.length}개 연결 후보 — 패널에서 확인 후 저장하세요`);
				this.renderCrossConnectionChips(pending, newTitleToFile, existingTitleToFile);
			}
		} catch (err) {
			new Notice(`[ThirdBrain] ⑨ 연결 탐색 실패: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async saveCrossEdge(conn: CrossConnection, newFile: TFile, existFile: TFile): Promise<void> {
		// 단방향 저장 — 방향성 관계(precedes/precondition_of 등)에 역방향 같은 라벨을 함께 쓰면
		// "A precondition_of B ∧ B precondition_of A" 같은 논리 모순이 생긴다. 파이프라인 규약과 동일하게
		// 출발 노드에만 기록하고, 대상 파일 존재 확인 용도로만 existFile을 받는다.
		void existFile;
		const fwd: TBEdge = { target: `[[${conn.existing_title}]]`, label: toRelation(conn.relation), confirmed: true, reason: conn.reason, confidence: conn.confidence ?? 1.0, axiom_basis: conn.axiom_basis };
		await this.app.fileManager.processFrontMatter(newFile, (fm: TBFrontMatter) => {
			const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
			if (!edges.find(e => e.target === fwd.target)) edges.push(fwd);
			fm.tb_edges = edges;
		});
	}

	// ⑨ 자동 저장(≥0.75) 로그 — 접을 수 있는 저장 내역 표시
	private renderCrossConnectionSavedLog(saved: CrossConnection[]): void {
		const container = this.pipelineModal?.contentEl ?? this.resultsEl;
		const block = container.createEl('div', { cls: 'tb-block' });
		const toggle = block.createEl('div', { cls: 'tb-section-toggle' });
		toggle.createEl('span', { cls: 'tb-section-chevron', text: '▾' });
		toggle.createEl('span', { cls: 'tb-section-label', text: `✓ ⑨ ${saved.length}${this.t('conn_auto_saved_suffix')}` });
		const content = block.createEl('div', { cls: 'tb-section-content' });
		toggle.addEventListener('click', () => {
			const collapsed = content.hasClass('is-collapsed');
			content.toggleClass('is-collapsed', !collapsed);
			toggle.querySelector<HTMLElement>('.tb-section-chevron')!.textContent = collapsed ? '▾' : '▸';
		});
		for (const conn of saved) {
			const rel = relLabel(conn.relation, this.plugin.settings.lang);
			const pct = Math.round((conn.confidence ?? 0.5) * 100);
			const chip = content.createEl('div', { cls: 'tb-chip is-saved', text: `[${pct}%] ${conn.new_title} ―${rel}→ ${conn.existing_title}` });
			if (conn.reason) chip.createEl('div', { cls: 'tb-chip-reason', text: conn.reason });
		}
	}

	// 인제스트 후 기존 노드 연결 후보 칩 UI — <0.75 후보만 도착하므로 사전선택 없이 유저가 직접 고른다
	private renderCrossConnectionChips(
		connections: CrossConnection[],
		newTitleToFile: Map<string, TFile>,
		existingTitleToFile: Map<string, TFile>
	): void {
		const pending = connections;
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

		content.createEl('div', { cls: 'tb-hint', text: this.t('conn_manual_hint') });

		const chipRow = content.createEl('div', { cls: 'tb-edge-chips' });
		const states: Array<{ conn: CrossConnection; selected: boolean }> = [];
		let locked = false;

		for (let i = 0; i < pending.length; i++) {
			const conn = pending[i];
			const rel = relLabel(conn.relation, this.plugin.settings.lang);
			const pct = Math.round((conn.confidence ?? 0.5) * 100);
			const chip = chipRow.createEl('div', { cls: 'tb-chip' });
			const top  = chip.createEl('div', { cls: 'tb-chip-top' });
			const icon = top.createEl('span', { cls: 'tb-chip-icon', text: '◎' });
			top.createEl('span', { cls: 'tb-chip-conf', text: `[${pct}%]` });
			top.createEl('span', { cls: 'tb-chip-source', text: shortText(conn.new_title, 14) });
			top.createEl('span', { cls: 'tb-chip-arrow', text: ` ―${rel}→ ` });
			top.createEl('span', { cls: 'tb-chip-target', text: conn.existing_title });
			if (conn.reason) chip.createEl('div', { cls: 'tb-chip-reason', text: conn.reason });

			const state = { conn, selected: false };
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
	 * [Phase 2] 저장된 Proposition 노드에 소속 토픽(tb_topic)을 기입한다.
	 * membership을 논리 엣지(precondition_of/supports)가 아니라 프론트매터 필드로 표현하여
	 * 논리 그래프에는 10공리만 남긴다. 가드/구제는 "어느 토픽인지" 판정에만 사용.
	 * (PROMPT-ARCHITECTURE.md — 레이어 분리)
	 */
	private async assignTopicMembership(
		contexts: ContextLayer[],
		propositions: Proposition[],
		contextFileMap: Map<string, TFile>,
		propFileMap: Map<string, TFile>
	) {
		for (const prop of propositions) {
			const propFile = propFileMap.get(prop.id);
			if (!propFile) continue;

			// Step 1: AI 배정 토픽 — 관련성 가드 통과 시에만 채택
			// [Bug #2] hub 오염 방지: 배정 토픽과 의미 관련성이 낮으면(heading_path 오배정 포함) 배정하지 않음.
			const ctxLayer = prop.context ? contexts.find(c => c.title === prop.context) : undefined;
			const canAssign = !!prop.context && (
				!ctxLayer // ContextLayer 조회 실패 시엔 판정 근거 없음 → 기존 동작대로 배정
					? !isMisassignedContext(prop.context, prop.heading_path, contexts.map(c => c.title))
					: shouldLinkContext(prop, ctxLayer, contexts.map(c => c.title))
			);
			let topicFile = canAssign ? contextFileMap.get(prop.context) : undefined;

			// Step 2: 고립 구제 — 배정 실패 시 관련성 최고 토픽으로 재배정 (없으면 미배정 → 미연결 명제 린팅이 처리)
			if (!topicFile) {
				const best = bestContextByRelevance(prop, contexts);
				topicFile = best ? contextFileMap.get(best.title) : undefined;
			}

			// tb_topic = 토픽 노드 basename (엣지의 [[basename]]과 동일 규약 → 뷰/exporter 매칭 robust)
			if (topicFile && topicFile.basename !== propFile.basename) {
				await this.store.setNodeTopic(propFile, topicFile.basename);
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

		// AI 비용 확인 게이트 — 노드 규모를 알고 난 뒤 물어본다.
		const analysisChars = nodes.reduce((s, n) => s + n.title.length + n.content.length, 0);
		if (!(await confirmAICost(this.app, this.plugin.settings, {
			operation: 'analysis', charCount: analysisChars, units: 1, tier: 'standard', provider: this.plugin.settings.aiProvider,
		}))) {
			this.hideProgress();
			this.setAIBusy(false);
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
		// AI 비용 확인 게이트 — 파일 복사·연결 전에 물어본다.
		const srcLen = (await this.app.vault.cachedRead(sourceFile).catch(() => '')).length;
		if (!(await confirmAICost(this.app, this.plugin.settings, {
			operation: 'bridge', charCount: srcLen, tier: 'standard', provider: this.plugin.settings.aiProvider,
		}))) return;

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

			// AI 비용 확인 게이트 — 양쪽 폴더 노드 규모를 알고 난 뒤 물어본다.
			const bridgeChars = [...tbNodesA, ...tbNodesB].reduce((s, n) => s + n.title.length + n.content.length, 0);
			if (!(await confirmAICost(this.app, this.plugin.settings, {
				operation: 'bridge', charCount: bridgeChars, tier: 'standard', provider: this.plugin.settings.aiProvider,
			}))) {
				this.hideProgress();
				this.setBridgeBusy(false);
				return;
			}

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

