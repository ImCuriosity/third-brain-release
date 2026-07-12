// ============================================================
// [v0.3.5] 미션 컨트롤 — 폴더 RAG 작업대 (PHILOSOPHY.md §6)
//
// 폴더 그래프(문맥·명제·액션·논리엣지)만을 그라운딩으로 무는 대화형 작업대.
// - 모든 답변 주장은 [[노드]] 인용 동반 강제, 인용 실존 여부는 시스템이 검증
// - 서브그래프는 미션 해결을 위한 임시 참여자 (생애주기 분리, 칩으로 참여/해제)
// - 대화는 _solving/ 노트에 마크다운 박제 (미션 채팅은 기존 미션 노트에 이어쓰기)
// - 비용 게이트는 작업대 세션 첫 질문에 1회, 이후 턴은 비게이트 (헤더에 누적 토큰 표시)
// ============================================================

import { App, Modal, Notice, TFile, normalizePath } from 'obsidian';
import type { GraphStore } from '../engine/graph-store';
import { contextRelevanceScore, buildSolvingNote } from '../engine/graph-store';
import type { TBNode, ThirdBrainSettings, ProblemSpecies } from '../types';
import { GraphExporter } from '../engine/graph-exporter';
import { callClaudeWithModel, getSessionStats } from '../engine/cli-bridge';
import { confirmAICost } from './ai-preflight';

// ── 상수 ────────────────────────────────────────────────────
const MAIN_BUDGET = 26000;      // 메인 폴더 그라운딩 문자 예산
const SUBGRAPH_BUDGET = 12000;  // 서브그래프당 문자 예산 (참고인은 발췌만)
const RETRIEVAL_TOP_N = 30;     // 예산 초과 시 질문 관련성 상위 노드 수
const HISTORY_TURNS = 6;        // 프롬프트에 동봉할 직전 문답 수 (Q+A 쌍 기준)

interface ChatTurn {
	role: 'q' | 'a';
	text: string;
	citations?: string[];        // 검증 통과 인용
	invalidCitations?: string[]; // 실존하지 않는 인용 (환각 표시)
}

interface SubgraphAttachment {
	folder: string;   // 전체 경로
	label: string;    // 표시명 (basename)
	nodes: TBNode[];
}

export interface WorkbenchDeps {
	getFolderPaths?: () => string[];
	onOpenBridge?: () => void;             // 기존 A↔B 폴더 브릿지 (보조 기능) — 없으면 버튼 숨김
	setAIBusy?: (on: boolean) => void;
	isBusy?: () => boolean;
}

/** 미션 컨트롤을 특정 폴더·미션으로 바로 진입시키는 초기 상태 (작업대 버튼·커맨드용) */
export interface WorkbenchInitial {
	folder: string;
	missionId?: string;
}

// 폴더별 작업대 세션 캐시 — 모달을 닫았다 다시 열어도 대화가 이어진다 (Obsidian 세션 내 유지).
// 영구 기록은 _solving/ 노트가 담당하고, 이 캐시는 UI 연속성만 책임진다.
interface WorkbenchSession {
	history: ChatTurn[];
	subgraphs: SubgraphAttachment[];
	activeMissionId: string | null;
	gatePassed: boolean;
	solvingNoteFile: TFile | null;
	tokenSnap: ReturnType<typeof getSessionStats>;
}
const sessionCache = new Map<string, WorkbenchSession>();

function baseName(path: string): string {
	return path.split('/').pop() ?? path;
}

function sanitizeFileName(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim().slice(0, 50);
}

/** 답변 텍스트에서 [[인용]] 추출 (alias 형태 [[id|표시명]] 지원) */
function extractCitations(text: string): string[] {
	const out: string[] = [];
	const re = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const id = m[1].trim();
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}

// ── 미션 컨트롤 모달 (Level 1: 폴더 목록 → Level 2: 작업대) ──
export class MissionControlModal extends Modal {
	private folder: string | null = null;

	// 작업대 세션 상태
	private mainNodes: TBNode[] = [];
	private missions: TBNode[] = [];
	private subgraphs: SubgraphAttachment[] = [];
	private history: ChatTurn[] = [];
	private activeMission: TBNode | null = null;
	private gatePassed = false;
	private tokenSnap = getSessionStats();
	private solvingNoteFile: TFile | null = null;

	// UI refs
	private chatLogEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private tokenEl!: HTMLElement;
	private chipsEl!: HTMLElement;
	private missionListEl!: HTMLElement;

	constructor(
		app: App,
		private store: GraphStore,
		private settings: ThirdBrainSettings,
		private deps: WorkbenchDeps = {},
		private initial?: WorkbenchInitial,
	) {
		super(app);
		this.modalEl.addClass('tb-workbench-modal');
	}

	private get ko() { return this.settings.lang !== 'en'; }

	private isBusy(): boolean { return this.deps.isBusy?.() ?? false; }
	private setAIBusy(on: boolean): void { this.deps.setAIBusy?.(on); }

	/** deps 미제공 시(커맨드 등 뷰 밖 진입) vault에서 직접 폴더 목록 파생 */
	private folderPaths(): string[] {
		if (this.deps.getFolderPaths) return this.deps.getFolderPaths();
		const root = this.settings.rootFolder;
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
		return [...set].filter(p => p === root || p.startsWith(root + '/')).sort();
	}

	async onOpen() {
		this.contentEl.addClass('tb-workbench-body');
		if (this.initial) {
			const { folder, missionId } = this.initial;
			this.initial = undefined; // 1회성 — 이후 네비게이션은 자유
			await this.openWorkbench(folder, missionId);
			return;
		}
		await this.renderFolderList();
	}

	onClose() {
		this.saveSession();
		this.contentEl.empty();
	}

	// ── Level 1: 세션 폴더 목록 ───────────────────────────────
	private sessionFolders(): string[] {
		const root = this.settings.rootFolder;
		const EXCLUDE = new Set(['raw', 'summaries', '_solving', '_problems', '_actions']);
		return this.folderPaths()
			.filter(p => {
				if (p === root) return false;
				const rel = root ? p.slice(root.length).replace(/^\/+/, '') : p;
				return !rel.includes('/') && !EXCLUDE.has(rel);
			});
	}

	private async renderFolderList() {
		this.saveSession(); // 작업대 → 폴더 목록 이동 시 세션 보존
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.ko ? '🎯 미션 컨트롤' : '🎯 Mission Control');

		contentEl.createEl('div', {
			cls: 'tb-mission-sub',
			text: this.ko
				? '폴더를 선택하면 그 폴더의 그래프만을 근거로 답하는 작업대가 열립니다.'
				: 'Pick a folder to open a workbench grounded only in that folder\'s graph.',
		});

		const folders = this.sessionFolders();
		if (folders.length === 0) {
			contentEl.createEl('div', { cls: 'tb-mission-empty', text: this.ko ? '세션 폴더가 없습니다. 먼저 그래프를 생성하세요.' : 'No session folders yet — run the pipeline first.' });
		}

		// 폴더별 open 미션 수 배지 (뇌 상태 집계 재사용)
		let missionCount = new Map<string, number>();
		try {
			const status = await this.store.loadBrainStatus();
			missionCount = new Map(status.map(s => [s.sessionFolder, s.missions.length]));
		} catch { /* 배지 없이 진행 */ }

		for (const f of folders) {
			const row = contentEl.createEl('button', { cls: 'tb-brain-folder-row' });
			row.createEl('span', { cls: 'tb-brain-folder-name', text: `📁 ${baseName(f)}` });
			const badges = row.createEl('span', { cls: 'tb-brain-folder-badges' });
			const mc = missionCount.get(f) ?? 0;
			if (mc > 0) badges.createEl('span', { cls: 'tb-brain-badge is-mission', text: this.ko ? `🎯 미션 ${mc}` : `🎯 ${mc}` });
			row.addEventListener('click', () => { void this.openWorkbench(f); });
		}

		// 보조: 기존 폴더 간 연결 탐색 (브릿지) — 뷰 밖 진입(deps 없음)이면 숨김
		if (this.deps.onOpenBridge) {
			const footer = contentEl.createEl('div', { cls: 'tb-workbench-l1-footer' });
			const bridgeBtn = footer.createEl('button', { cls: 'tb-btn tb-btn-sm', text: this.ko ? '🌉 폴더 간 연결 탐색' : '🌉 Explore cross-folder links' });
			bridgeBtn.addEventListener('click', () => { this.close(); this.deps.onOpenBridge!(); });
		}
	}

	// ── Level 2: 작업대 ───────────────────────────────────────
	private async openWorkbench(folder: string, selectMissionId?: string) {
		this.folder = folder;
		// 노드·미션은 항상 신선하게 재로드 (그 사이 vault가 바뀌었을 수 있음)
		this.mainNodes = await this.store.loadNodesInFolder(folder);
		this.missions = this.mainNodes.filter(n => n.type === 'problem' && n.problem_status === 'open');

		// 세션 캐시 복원 — 모달을 닫았다 열어도 대화·서브그래프·게이트 상태가 이어진다
		const cached = sessionCache.get(folder);
		if (cached) {
			this.history = cached.history;
			this.subgraphs = cached.subgraphs;
			this.activeMission = cached.activeMissionId
				? this.missions.find(m => m.id === cached.activeMissionId) ?? null
				: null;
			this.gatePassed = cached.gatePassed;
			this.solvingNoteFile = cached.solvingNoteFile;
			this.tokenSnap = cached.tokenSnap;
		} else {
			this.subgraphs = [];
			this.history = [];
			this.activeMission = null;
			this.gatePassed = false;
			this.solvingNoteFile = null;
			this.tokenSnap = getSessionStats();
		}
		// 명시적 진입 미션(작업대 버튼·커맨드)이 있으면 캐시보다 우선
		if (selectMissionId) {
			const target = this.missions.find(m => m.id === selectMissionId);
			if (target && this.activeMission?.id !== target.id) {
				this.activeMission = target;
				this.solvingNoteFile = null; // 박제 대상을 해당 미션 노트로 전환
			}
		}
		this.renderWorkbench();
		if (cached) this.updateTokenCounter();
	}

	/** 현재 작업대 상태를 폴더 키로 캐시 — 모달 닫힘·턴 완료 시 호출 */
	private saveSession() {
		if (!this.folder) return;
		sessionCache.set(this.folder, {
			history: this.history,
			subgraphs: this.subgraphs,
			activeMissionId: this.activeMission?.id ?? null,
			gatePassed: this.gatePassed,
			solvingNoteFile: this.solvingNoteFile,
			tokenSnap: this.tokenSnap,
		});
	}

	private renderWorkbench() {
		const { contentEl } = this;
		contentEl.empty();
		const name = baseName(this.folder ?? '');
		this.setTitle(`🎯 ${name}`);

		// 헤더: 뒤로 + 그라운딩 정보 + 누적 토큰
		const head = contentEl.createEl('div', { cls: 'tb-workbench-head' });
		const back = head.createEl('button', { cls: 'tb-btn tb-btn-sm', text: this.ko ? '← 폴더' : '← Folders' });
		back.addEventListener('click', () => { void this.renderFolderList(); });
		head.createEl('span', {
			cls: 'tb-workbench-ground-info',
			text: this.ko ? `그라운딩 ${this.mainNodes.length}개 노드` : `Grounded on ${this.mainNodes.length} nodes`,
		});
		this.tokenEl = head.createEl('span', { cls: 'tb-workbench-tokens', text: '↑0 ↓0' });

		// 서브그래프 칩
		this.chipsEl = contentEl.createEl('div', { cls: 'tb-workbench-chips' });
		this.renderChips();

		// 미션 리스트 (컴팩트)
		this.missionListEl = contentEl.createEl('div', { cls: 'tb-workbench-missions' });
		this.renderMissionList();

		// 채팅 로그
		this.chatLogEl = contentEl.createEl('div', { cls: 'tb-workbench-chat' });
		if (this.history.length === 0) {
			this.chatLogEl.createEl('div', {
				cls: 'tb-workbench-hint',
				text: this.ko
					? '이 폴더의 그래프만을 근거로 답합니다. 모든 주장에 [[노드]] 인용이 붙고, 근거가 없으면 없다고 답합니다.'
					: 'Answers are grounded only in this folder\'s graph. Every claim cites [[nodes]]; no basis → says so.',
			});
		}
		for (const t of this.history) this.renderTurn(t);

		// 입력 영역
		const inputRow = contentEl.createEl('div', { cls: 'tb-workbench-input-row' });
		this.inputEl = inputRow.createEl('textarea', {
			cls: 'tb-workbench-input',
			attr: { rows: '2', placeholder: this.ko ? '질문을 입력하세요… (Shift+Enter 줄바꿈)' : 'Ask a question… (Shift+Enter for newline)' },
		});
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.submit();
			}
		});
		this.sendBtn = inputRow.createEl('button', { cls: 'tb-btn is-primary tb-workbench-send', text: this.ko ? '질문' : 'Ask' });
		this.sendBtn.addEventListener('click', () => { void this.submit(); });

		// 하단 액션
		const footer = contentEl.createEl('div', { cls: 'tb-workbench-footer' });
		const attachBtn = footer.createEl('button', { cls: 'tb-btn tb-btn-sm', text: this.ko ? '＋ 서브그래프 참여' : '＋ Attach subgraph' });
		attachBtn.addEventListener('click', () => { this.pickSubgraph(); });
		const promoteBtn = footer.createEl('button', { cls: 'tb-btn tb-btn-sm tb-workbench-promote', text: this.ko ? '⚑ 미션 승격' : '⚑ Promote to mission' });
		promoteBtn.addEventListener('click', () => { void this.promoteMission(); });
	}

	private updateTokenCounter() {
		const now = getSessionStats();
		const inTok = now.inputTokens - this.tokenSnap.inputTokens;
		const outTok = now.outputTokens - this.tokenSnap.outputTokens;
		this.tokenEl.setText(`↑${inTok.toLocaleString()} ↓${outTok.toLocaleString()}`);
	}

	// ── 서브그래프 칩 ─────────────────────────────────────────
	private renderChips() {
		this.chipsEl.empty();
		if (this.subgraphs.length === 0) return;
		this.chipsEl.createEl('span', { cls: 'tb-workbench-chips-label', text: this.ko ? '서브그래프:' : 'Subgraphs:' });
		for (const sg of this.subgraphs) {
			const chip = this.chipsEl.createEl('span', { cls: 'tb-workbench-chip' });
			chip.createEl('span', { text: `⊂ ${sg.label} (${sg.nodes.length})` });
			const x = chip.createEl('button', { cls: 'tb-workbench-chip-x', text: '✕' });
			x.setAttribute('title', this.ko ? '참여 해제 — 다음 턴부터 제외' : 'Detach — excluded from next turn');
			x.addEventListener('click', () => {
				this.subgraphs = this.subgraphs.filter(s => s !== sg);
				this.renderChips();
				this.saveSession(); // 배열 재할당으로 캐시 참조가 끊기므로 즉시 갱신
			});
		}
	}

	private pickSubgraph() {
		const candidates = this.sessionFolders()
			.filter(f => f !== this.folder && !this.subgraphs.some(s => s.folder === f));
		if (candidates.length === 0) {
			new Notice(this.ko ? '[ThirdBrain] 참여 가능한 다른 폴더가 없습니다.' : '[ThirdBrain] No other folders to attach.');
			return;
		}
		new SubgraphPickerModal(this.app, candidates, this.ko, (picked) => {
			void (async () => {
				const nodes = await this.store.loadNodesInFolder(picked);
				if (nodes.length === 0) {
					new Notice(this.ko ? '[ThirdBrain] 해당 폴더에 노드가 없습니다.' : '[ThirdBrain] That folder has no nodes.');
					return;
				}
				this.subgraphs.push({ folder: picked, label: baseName(picked), nodes });
				this.renderChips();
				new Notice(this.ko
					? `[ThirdBrain] 서브그래프 참여: ${baseName(picked)} (${nodes.length}개 노드)`
					: `[ThirdBrain] Subgraph attached: ${baseName(picked)} (${nodes.length} nodes)`);
			})();
		}).open();
	}

	// ── 미션 리스트 ───────────────────────────────────────────
	private renderMissionList() {
		this.missionListEl.empty();
		if (this.missions.length === 0) return;
		this.missionListEl.createEl('span', { cls: 'tb-workbench-chips-label', text: this.ko ? '미션:' : 'Missions:' });
		for (const m of this.missions) {
			const group = this.missionListEl.createEl('span', { cls: 'tb-workbench-mission-group' });
			const chip = group.createEl('button', { cls: 'tb-workbench-mission-chip' });
			if (this.activeMission?.id === m.id) chip.addClass('is-active');
			chip.setText(`🎯 ${m.title.length > 24 ? m.title.slice(0, 23) + '…' : m.title}`);
			chip.setAttribute('title', m.title);
			chip.addEventListener('click', () => { this.setActiveMission(this.activeMission?.id === m.id ? null : m); });
			// 미션 내용 보기 — 제목만으로는 판단이 어려우므로 상세(서술+증거 원문) 열람
			const info = group.createEl('button', { cls: 'tb-workbench-mission-info', text: 'ⓘ' });
			info.setAttribute('title', this.ko ? '미션 내용 보기' : 'View mission details');
			info.addEventListener('click', (e) => {
				e.stopPropagation();
				new ProblemDetailModal(this.app, m).open();
			});
		}
	}

	private setActiveMission(m: TBNode | null) {
		this.activeMission = m;
		this.solvingNoteFile = null; // 박제 대상 노트 변경
		this.renderMissionList();
		const note = this.chatLogEl.createEl('div', { cls: 'tb-workbench-sysline' });
		note.setText(m
			? (this.ko ? `— 미션 컨텍스트: ${m.title} —` : `— Mission context: ${m.title} —`)
			: (this.ko ? '— 미션 컨텍스트 해제 —' : '— Mission context cleared —'));
		this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
	}

	// ── 그라운딩 조립 ─────────────────────────────────────────
	private async buildGroundingSection(label: string, nodes: TBNode[], question: string, budget: number): Promise<string> {
		const exporter = new GraphExporter();
		const opts = { includeSourceText: true, includeMetadata: true, maxTextLength: 240 };
		const full = await exporter.exportForGrounding(label, nodes, this.store, opts);
		if (full.length <= budget) return full;

		// 예산 초과 → retrieval: 문맥·문제는 항상, 나머지는 질문 관련성 top-N + 엣지 1홉 이웃
		const always = nodes.filter(n => n.type === 'context' || n.type === 'problem');
		const rest = nodes.filter(n => n.type !== 'context' && n.type !== 'problem');
		const scored = rest
			.map(n => ({ n, s: contextRelevanceScore(question, { title: n.title, tags: n.tags }) }))
			.sort((a, b) => b.s - a.s);
		const picked = new Set<string>(always.map(n => n.id));
		for (const { n } of scored) {
			if (picked.size >= always.length + RETRIEVAL_TOP_N) break;
			picked.add(n.id);
		}
		// 엣지 1홉 이웃 확장 — 논리 사슬이 끊긴 채 인용되지 않도록
		const byId = new Map(nodes.map(n => [n.id, n]));
		for (const id of [...picked]) {
			const n = byId.get(id);
			for (const e of n?.edges ?? []) {
				const m = /^\[\[(.+?)\]\]$/.exec(e.target);
				if (m && byId.has(m[1])) picked.add(m[1]);
			}
		}
		const subset = nodes.filter(n => picked.has(n.id));
		const md = await exporter.exportForGrounding(
			`${label} — ${this.ko ? '질문 관련 발췌' : 'question-relevant excerpt'} ${subset.length}/${nodes.length}`,
			subset, this.store, opts,
		);
		return md.length <= budget * 1.5 ? md : md.slice(0, budget) + '\n…(truncated)';
	}

	private knownIds(): Set<string> {
		const ids = new Set<string>();
		for (const n of this.mainNodes) ids.add(n.id);
		for (const sg of this.subgraphs) for (const n of sg.nodes) ids.add(n.id);
		return ids;
	}

	// ── 질문 → 답변 ───────────────────────────────────────────
	private async submit() {
		const q = this.inputEl.value.trim();
		if (!q || !this.folder) return;
		if (this.isBusy()) {
			new Notice(this.ko ? '[ThirdBrain] AI 작업이 진행 중입니다.' : '[ThirdBrain] An AI task is already running.');
			return;
		}

		// 비용 게이트 — 세션 첫 질문에만
		if (!this.gatePassed) {
			const groundChars = Math.min(this.mainNodes.length * 400, MAIN_BUDGET)
				+ this.subgraphs.reduce((a, s) => a + Math.min(s.nodes.length * 400, SUBGRAPH_BUDGET), 0);
			const ok = await confirmAICost(this.app, this.settings, {
				operation: 'workbench', charCount: groundChars + q.length, tier: 'standard', provider: this.settings.aiProvider,
			});
			if (!ok) return;
			this.gatePassed = true;
		}

		this.inputEl.value = '';
		this.pushTurn({ role: 'q', text: q });
		this.setSending(true);
		this.setAIBusy(true);

		const thinking = this.chatLogEl.createEl('div', { cls: 'tb-workbench-sysline', text: this.ko ? '…그래프 해석 중' : '…interpreting graph' });
		this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;

		try {
			const answer = await this.askLLM(q);
			thinking.remove();

			const known = this.knownIds();
			const cited = extractCitations(answer);
			const valid: string[] = [];
			const invalid: string[] = [];
			for (const c of cited) {
				// 노드 id 이거나, 볼트에서 resolve 가능한 링크(raw 경로 등)면 유효
				if (known.has(c) || this.app.metadataCache.getFirstLinkpathDest(c, '') !== null) valid.push(c);
				else invalid.push(c);
			}
			const turn: ChatTurn = { role: 'a', text: answer, citations: valid, invalidCitations: invalid };
			this.pushTurn(turn);
			this.updateTokenCounter();
			await this.persistTurns(q, turn);
		} catch (e) {
			thinking.remove();
			this.chatLogEl.createEl('div', {
				cls: 'tb-workbench-sysline is-error',
				text: `${this.ko ? '오류' : 'Error'}: ${e instanceof Error ? e.message : String(e)}`,
			});
		} finally {
			this.setSending(false);
			this.setAIBusy(false);
		}
	}

	private setSending(on: boolean) {
		this.sendBtn.disabled = on;
		this.inputEl.disabled = on;
		this.sendBtn.setText(on ? '…' : (this.ko ? '질문' : 'Ask'));
	}

	private async askLLM(question: string): Promise<string> {
		const mainLabel = `${this.ko ? '메인 폴더' : 'Main folder'}: ${baseName(this.folder ?? '')}`;
		const sections: string[] = [await this.buildGroundingSection(mainLabel, this.mainNodes, question, MAIN_BUDGET)];
		for (const sg of this.subgraphs) {
			sections.push(await this.buildGroundingSection(
				`${this.ko ? '서브그래프(참고인)' : 'Subgraph (advisory)'}: ${sg.label}`,
				sg.nodes, question, SUBGRAPH_BUDGET,
			));
		}

		const missionBlock = this.activeMission
			? `\n## ${this.ko ? '현재 미션' : 'Current mission'}\n[[${this.activeMission.id}]] — ${this.activeMission.title}\n${(this.activeMission.content.split('\n---\n')[0] ?? '').trim()}\n${this.ko ? '증거' : 'Evidence'}: ${(this.activeMission.evidence_ids ?? []).map(i => `[[${i}]]`).join(', ') || '(없음)'}\n`
			: '';

		const historyTail = this.history
			.slice(-(HISTORY_TURNS * 2))
			.map(t => `${t.role === 'q' ? 'Q' : 'A'}: ${t.text}`)
			.join('\n');

		const rules = this.ko
			? `당신은 ThirdBrain의 작업대 엔진입니다. 아래 지식 그래프만을 근거로 답하세요.

절대 규칙:
1. 답변의 모든 주장에는 근거 노드 인용 [[노드id]]를 붙인다. 인용 없는 주장은 금지.
2. 그래프에 없는 지식(당신의 사전지식·추측)으로 답하지 않는다. 근거가 없으면 "그래프에 근거 없음"이라고 명시한다.
3. 서브그래프는 참고인이다 — 메인 폴더의 문제 해결에 필요한 만큼만 인용하고, 서브그래프 출신 인용은 (from: 폴더명)을 병기한다.
4. 노드 간 논리 엣지(causes/supports/conflicts_with 등)를 적극 활용해 추론 사슬을 보여준다.
5. 답은 한국어 산문으로, 간결하게.`
			: `You are ThirdBrain's workbench engine. Answer ONLY from the knowledge graph below.

Hard rules:
1. Every claim must cite its basis node as [[nodeId]]. Uncited claims are forbidden.
2. Never answer from prior knowledge or guesses. If the graph lacks basis, say "no basis in graph".
3. Subgraphs are advisory witnesses — cite them only as needed, appending (from: folder).
4. Use logic edges (causes/supports/conflicts_with…) to show reasoning chains.
5. Answer in concise English prose.`;

		const prompt = [
			rules,
			'',
			...sections,
			missionBlock,
			historyTail ? `## ${this.ko ? '직전 대화' : 'Recent turns'}\n${historyTail}` : '',
			`## ${this.ko ? '질문' : 'Question'}\n${question}`,
		].filter(Boolean).join('\n\n');

		const raw = await callClaudeWithModel(
			prompt, this.settings.cliBin, 'standard',
			this.settings.aiProvider, this.settings.claudeApiKey, this.settings.geminiApiKey, this.settings.openaiApiKey,
			false, // 채팅은 산문 — JSON 모드 금지
		);
		if (typeof raw === 'string') return raw.trim();
		return JSON.stringify(raw);
	}

	// ── 채팅 렌더 ─────────────────────────────────────────────
	private pushTurn(t: ChatTurn) {
		this.history.push(t);
		this.renderTurn(t);
		this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
	}

	private renderTurn(t: ChatTurn) {
		const row = this.chatLogEl.createEl('div', { cls: `tb-workbench-turn is-${t.role}` });
		if (t.role === 'q') {
			row.setText(t.text);
			return;
		}
		this.renderAnswerText(row, t.text, new Set(t.citations ?? []), new Set(t.invalidCitations ?? []));
		if ((t.invalidCitations ?? []).length > 0) {
			row.createEl('div', {
				cls: 'tb-workbench-invalid-note',
				text: this.ko
					? `⚠ 검증 실패 인용 ${t.invalidCitations!.length}건 — 그래프에 없는 노드입니다`
					: `⚠ ${t.invalidCitations!.length} citation(s) failed validation — not in graph`,
			});
		}
	}

	/** [[인용]]을 클릭 가능한 링크로 렌더 — 유효 인용은 노트 열기, 미실존 인용은 경고 표시 */
	private renderAnswerText(container: HTMLElement, text: string, valid: Set<string>, invalid: Set<string>) {
		const re = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			if (m.index > last) container.appendText(text.slice(last, m.index));
			const id = m[1].trim();
			const display = (m[2] ?? id).trim() || id;
			if (invalid.has(id) && !valid.has(id)) {
				const bad = container.createEl('span', { cls: 'tb-workbench-cite is-invalid', text: `[[${display}]]` });
				bad.setAttribute('title', this.ko ? '그래프에 존재하지 않는 인용 (환각 가능성)' : 'Citation not found in graph (possible hallucination)');
			} else {
				const link = container.createEl('a', { cls: 'tb-workbench-cite', text: `[[${display}]]` });
				link.addEventListener('click', (e) => {
					e.preventDefault();
					void this.app.workspace.openLinkText(id, '');
				});
			}
			last = re.lastIndex;
		}
		if (last < text.length) container.appendText(text.slice(last));
	}

	// ── 대화 박제 (_solving) ──────────────────────────────────
	private async ensureSolvingNote(): Promise<TFile> {
		if (this.solvingNoteFile) return this.solvingNoteFile;

		if (this.activeMission) {
			// 미션 채팅 → 기존 미션 노트 재사용 (없으면 생성)
			const evidenceIds = new Set(this.activeMission.evidence_ids ?? []);
			const evidenceNodes = this.mainNodes.filter(n => evidenceIds.has(n.id));
			const content = buildSolvingNote(this.activeMission, evidenceNodes, []);
			this.solvingNoteFile = await this.store.createSolvingNote(this.activeMission, content);
			return this.solvingNoteFile;
		}

		// 자유 채팅 → 작업대-{폴더}-{날짜}.md
		const folder = this.folder ?? '';
		const solvingDir = normalizePath(`${folder}/_solving`);
		if (!this.app.vault.getFolderByPath(solvingDir)) {
			await this.app.vault.createFolder(solvingDir);
		}
		const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
		const path = normalizePath(`${solvingDir}/작업대-${sanitizeFileName(baseName(folder))}-${date}.md`);
		const existing = this.app.vault.getFileByPath(path);
		if (existing) { this.solvingNoteFile = existing; return existing; }

		const fm = [
			'---',
			'tb_type: solving',
			`tb_created: "${new Date().toISOString()}"`,
			'---',
			'',
			`# ${this.ko ? '작업대' : 'Workbench'}: ${baseName(folder)}`,
			'',
		].join('\n');
		this.solvingNoteFile = await this.app.vault.create(path, fm);
		return this.solvingNoteFile;
	}

	private async persistTurns(q: string, a: ChatTurn): Promise<void> {
		try {
			const file = await this.ensureSolvingNote();
			const time = new Date().toTimeString().slice(0, 5);
			const cites = (a.citations ?? []).map(c => `[[${c}]]`).join(', ') || (this.ko ? '(인용 없음)' : '(none)');
			const invalids = (a.invalidCitations ?? []).length > 0
				? `\n> ⚠ ${this.ko ? '검증 실패' : 'invalid'}: ${a.invalidCitations!.join(', ')}`
				: '';
			const subs = this.subgraphs.length > 0
				? `\n> ${this.ko ? '서브그래프' : 'subgraphs'}: ${this.subgraphs.map(s => s.label).join(', ')}`
				: '';
			const block = `\n\n### Q (${time})\n${q}\n\n### A\n${a.text}\n\n> ${this.ko ? '인용' : 'cited'}: ${cites}${invalids}${subs}\n`;
			await this.app.vault.process(file, (data) => data + block);
		} catch {
			// 박제 실패는 채팅을 막지 않는다
		}
	}

	// ── 미션 승격 (Phase D) ───────────────────────────────────
	private async promoteMission(): Promise<void> {
		if (!this.folder) return;
		if (this.history.length === 0) {
			new Notice(this.ko ? '[ThirdBrain] 승격할 대화가 없습니다. 먼저 질문해보세요.' : '[ThirdBrain] Nothing to promote — ask something first.');
			return;
		}
		if (this.isBusy()) {
			new Notice(this.ko ? '[ThirdBrain] AI 작업이 진행 중입니다.' : '[ThirdBrain] An AI task is already running.');
			return;
		}

		this.setAIBusy(true);
		const sysline = this.chatLogEl.createEl('div', { cls: 'tb-workbench-sysline', text: this.ko ? '…미션 승격 분석 중' : '…analyzing for promotion' });
		this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;

		try {
			const chatTail = this.history.slice(-8).map(t => `${t.role === 'q' ? 'Q' : 'A'}: ${t.text}`).join('\n');
			// 증거 후보 = 문제·요약 제외한 실제 노드 (id + 제목)
			const candidates = this.mainNodes
				.filter(n => n.type !== 'problem' && n.type !== 'summary')
				.slice(0, 120);
			const idList = candidates.map(n => `- ${n.id}`).join('\n');

			const prompt = this.ko
				? `아래 작업대 대화에서 "우리가 해결해야 할 문제(미션)"를 하나 추출하세요.

대화:
${chatTail}

증거 후보 노드 (이 목록의 id만 사용):
${idList}

규칙:
- species는 obstacle(장애)/gap(공백)/risk(리스크) 중 하나. 모순(contradiction)은 여기서 만들지 않는다.
- evidence_ids는 위 후보 목록에 실존하는 id만, 1개 이상. 대화의 문제 진술을 뒷받침하는 노드를 고른다.
- 긴장이 분명하지 않으면 {"none":true}만 반환.

JSON만 반환(코드블록 없이):
{"title":"문제 제목(30자 이내)","description":"문제 서술 2~3문장","species":"obstacle","evidence_ids":["노드id"]}`
				: `Extract ONE problem (mission) worth solving from this workbench chat.

Chat:
${chatTail}

Evidence candidates (use only these ids):
${idList}

Rules:
- species ∈ obstacle/gap/risk. Never contradiction (that's the reconcile loop's job).
- evidence_ids must exist in the list above, at least 1.
- If no clear tension, return {"none":true}.

Return JSON only:
{"title":"...","description":"...","species":"obstacle","evidence_ids":["id"]}`;

			const raw = await callClaudeWithModel(
				prompt, this.settings.cliBin, 'standard',
				this.settings.aiProvider, this.settings.claudeApiKey, this.settings.geminiApiKey, this.settings.openaiApiKey,
			);
			const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
				none?: boolean; title?: string; description?: string; species?: string; evidence_ids?: string[];
			};
			sysline.remove();

			if (parsed.none || !parsed.title) {
				new Notice(this.ko ? '[ThirdBrain] 대화에서 뚜렷한 문제 긴장을 찾지 못했습니다.' : '[ThirdBrain] No clear problem tension found in chat.');
				return;
			}

			// 증거 실존 검증 — 증거 없는 문제는 존재할 수 없다 (PHILOSOPHY §2)
			const candidateIds = new Set(candidates.map(n => n.id));
			const evidence = (parsed.evidence_ids ?? []).filter(id => candidateIds.has(id));
			if (evidence.length === 0) {
				new Notice(this.ko ? '[ThirdBrain] 유효한 증거 노드가 없어 승격을 중단합니다. (증거 없는 문제 금지)' : '[ThirdBrain] Promotion aborted — no valid evidence nodes.');
				return;
			}
			const species: ProblemSpecies = (['obstacle', 'gap', 'risk'] as const).includes(parsed.species as 'obstacle' | 'gap' | 'risk')
				? parsed.species as ProblemSpecies : 'gap';

			const file = await this.store.createProblemNode({
				title: parsed.title.slice(0, 60),
				description: (parsed.description ?? '').trim() || parsed.title,
				species,
				evidence_ids: evidence,
			}, this.folder);

			// 미션 리스트 갱신 + 새 미션을 활성 컨텍스트로
			const node = await this.store.fileToNode(file);
			if (node) {
				this.missions.push(node);
				this.setActiveMission(node);
			}
			new Notice(this.ko
				? `[ThirdBrain] 미션 승격: ${parsed.title} (증거 ${evidence.length}개)`
				: `[ThirdBrain] Promoted: ${parsed.title} (${evidence.length} evidence)`);
		} catch (e) {
			sysline.remove();
			new Notice(`[ThirdBrain] ${this.ko ? '승격 실패' : 'Promotion failed'}: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.setAIBusy(false);
		}
	}
}

// ── 미션(문제) 상세 모달 — 서술 + 증거 원문 열람 ─────────────
export class ProblemDetailModal extends Modal {
	constructor(
		app: App,
		private problem: TBNode,
	) {
		super(app);
		this.modalEl.addClass('tb-problem-detail-modal');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-problem-detail-body');
		const species = this.problem.problem_species ?? 'obstacle';
		this.setTitle(`🎯 ${this.problem.title}`);

		const head = contentEl.createEl('div', { cls: 'tb-problem-card-head' });
		head.createEl('span', { cls: `tb-problem-species is-${species}`, text: species });
		if (this.problem.problem_status === 'resolved') {
			head.createEl('span', { cls: 'tb-problem-species', text: 'resolved' });
		}

		// 본문(서술 + 증거 원문 인용) — [[위키링크]]는 클릭 시 해당 노트 열림
		const body = contentEl.createEl('div', { cls: 'tb-problem-detail-content' });
		this.renderWikiText(body, this.problem.content);

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		const openBtn = footer.createEl('button', { cls: 'tb-btn', text: '📄 노트 열기' });
		openBtn.addEventListener('click', () => {
			this.close();
			void this.app.workspace.openLinkText(this.problem.id, '');
		});
	}

	private renderWikiText(container: HTMLElement, text: string) {
		const re = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			if (m.index > last) container.appendText(text.slice(last, m.index));
			const id = m[1].trim();
			const display = (m[2] ?? id).trim() || id;
			const link = container.createEl('a', { cls: 'tb-workbench-cite', text: display });
			link.addEventListener('click', (e) => {
				e.preventDefault();
				this.close();
				void this.app.workspace.openLinkText(id, '');
			});
			last = re.lastIndex;
		}
		if (last < text.length) container.appendText(text.slice(last));
	}

	onClose() { this.contentEl.empty(); }
}

// ── 서브그래프 폴더 선택 미니 모달 ───────────────────────────
class SubgraphPickerModal extends Modal {
	constructor(
		app: App,
		private candidates: string[],
		private ko: boolean,
		private onPick: (folder: string) => void,
	) { super(app); }

	onOpen() {
		this.setTitle(this.ko ? '서브그래프 참여' : 'Attach subgraph');
		this.contentEl.createEl('div', {
			cls: 'tb-mission-sub',
			text: this.ko
				? '이 미션의 해답을 찾기 위한 임시 참고인입니다. 칩의 ✕로 언제든 해제됩니다.'
				: 'A temporary advisory witness for this mission. Detach anytime via the chip\'s ✕.',
		});
		for (const f of this.candidates) {
			const row = this.contentEl.createEl('button', { cls: 'tb-brain-folder-row' });
			row.createEl('span', { cls: 'tb-brain-folder-name', text: `⊂ ${baseName(f)}` });
			row.addEventListener('click', () => { this.close(); this.onPick(f); });
		}
	}

	onClose() { this.contentEl.empty(); }
}
