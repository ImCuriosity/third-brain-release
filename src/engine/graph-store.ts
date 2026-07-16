import { App, TFile, normalizePath } from 'obsidian';
import { toRelation, isValidRelation } from '../types';
import { detectConflicts } from './contradiction-engine';
import { computeNodeSalience } from './topology-engine';
import type {
	TBNode,
	TBEdge,
	TBNodeType,
	TBEdgeRelation,
	ThirdBrainSettings,
	Proposition,
	LogicEdge,
	BridgeEdge,
	ContextLayer,
	ActionNode,
	ActionStatus,
	ActionLinkType,
	ProblemSpecies,
	ProblemStatus,
	MeetingType,
	ConflictReport,
} from '../types';

export interface TBFrontMatter {
	tb_id?: string;
	tb_title?: string;
	tb_type?: string;
	tb_summary?: string;
	tb_tags?: string[];
	tb_created?: string;
	tb_edges?: TBEdge[];
	tb_is_core?: boolean;
	tb_source_span?: { text: string; offset?: number };
	tb_axiom_basis?: string;
	tb_links?: string[];
	tb_insight_anchors?: string[];
	tb_logic?: unknown;
	tb_conflict?: boolean;
	tb_proposition_type?: 'fact' | 'claim';
	// action node fields (both new and legacy schema)
	tb_action_id?: string;
	tb_action_title?: string;
	tb_status?: string;
	tb_owner?: string;
	tb_deadline?: string;
	tb_action_status?: string;
	tb_action_owner?: string;
	tb_action_deadline?: string;
	tb_action_motivation_ids?: string[];
	tb_motivation_context_ids?: string[];
	tb_action_motivation_context_ids?: string[];
	tb_link_type?: string;
	tb_action_link_type?: string;
	tb_origin?: string;
	tb_action_origin?: string;
	tb_action_created?: string;
	tb_meeting_type?: string;
	tb_block_id?: string;
	tb_heading_path?: string;
	tb_raw_path?: string;
	tb_topic?: string;
	// [Phase 10] problem node fields
	tb_problem_species?: string;
	tb_problem_evidence_ids?: string[];
	tb_problem_pair?: string;
	tb_resolution_note?: string;
	tb_problem_id?: string;   // action(from_problem) → 해결 대상 문제 basename
}

export class GraphStore {
	constructor(private app: App, private settings: ThirdBrainSettings) {}

	// 특정 폴더 내 노드만 로드 — 서브폴더 재귀 탐색, 루트('')도 지원
	async loadNodesInFolder(folderPath: string): Promise<TBNode[]> {
		const nodes: TBNode[] = [];
		await this.collectNodes(folderPath || '/', nodes);
		return nodes;
	}

	// 볼트 전체(rootFolder) conflicts_with 엣지 스캔 → 미해소 모순 목록
	async scanConflicts(): Promise<ConflictReport[]> {
		const nodes = await this.loadNodesInFolder(this.settings.rootFolder || '/');
		return detectConflicts(nodes);
	}

	// [Phase 2] 명제가 미연결인지 판정: 확정 논리 엣지도 없고 소속 토픽(tb_topic)도 없어야 진짜 미연결.
	// (토픽에 묶여 있으면 그래프상 그룹핑된 상태이므로 "미연결"이 아니다 — membership은 tb_topic 필드)
	private isUnlinkedProp(n: TBNode): boolean {
		return n.edges.filter(e => e.confirmed).length === 0 && !n.topic;
	}

	// 배지용 — vault 전체 고립 명제 수 빠르게 집계
	async countOrphanPropositions(): Promise<number> {
		const allNodes = await this.loadNodesInFolder(this.settings.rootFolder || '/');
		const NON_PROP_TYPES: TBNodeType[] = ['context', 'action', 'problem', 'summary', 'expression'];
		return allNodes.filter(n =>
			!NON_PROP_TYPES.includes(n.type) &&
			!n.folder.split('/').includes('raw') &&
			this.isUnlinkedProp(n)
		).length;
	}

	// 특정 폴더 내 고립 명제 스캔 — salience 내림차순, 연결 후보도 같은 폴더에서
	async scanOrphanPropositions(folderPath: string): Promise<{ orphans: TBNode[]; candidates: TBNode[] }> {
		const allNodes = await this.loadNodesInFolder(folderPath);
		const NON_PROP_TYPES: TBNodeType[] = ['context', 'action', 'problem', 'summary', 'expression'];
		const propositions = allNodes.filter(n =>
			!NON_PROP_TYPES.includes(n.type) &&
			!n.folder.split('/').includes('raw')
		);
		const orphans = propositions.filter(n => this.isUnlinkedProp(n));
		const candidates = propositions.filter(n => !this.isUnlinkedProp(n));

		const scored = orphans.map(n => ({ node: n, score: computeNodeSalience(n, allNodes).composite }));
		scored.sort((a, b) => b.score - a.score);

		return { orphans: scored.map(s => s.node), candidates };
	}

	// 고립 노드 린팅: 엣지 양방향 저장 (확정 상태)
	async addLintEdge(
		orphanFile: TFile,
		targetFile: TFile,
		orphanTitle: string,
		targetTitle: string,
		relation: TBEdgeRelation,
		reason: string,
		confidence: number
	): Promise<void> {
		const edgeAtoB: TBEdge = { target: `[[${targetTitle}]]`, label: relation, confirmed: true, reason, confidence, axiom_basis: '' };
		const edgeBtoA: TBEdge = { target: `[[${orphanTitle}]]`, label: relation, confirmed: true, reason, confidence, axiom_basis: '' };

		await this.app.fileManager.processFrontMatter(orphanFile, (fm: TBFrontMatter) => {
			const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
			if (!edges.find(e => e.target === edgeAtoB.target)) edges.push(edgeAtoB);
			fm.tb_edges = edges;
		});
		await this.app.fileManager.processFrontMatter(targetFile, (fm: TBFrontMatter) => {
			const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
			if (!edges.find(e => e.target === edgeBtoA.target)) edges.push(edgeBtoA);
			fm.tb_edges = edges;
		});
	}

	private async collectNodes(folderPath: string, out: TBNode[]): Promise<void> {
		const folder = this.app.vault.getFolderByPath(folderPath);
		if (!folder) return;

		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				const node = await this.fileToNode(child);
				if (node && node.type !== 'summary') out.push(node);
			} else if (!(child instanceof TFile)) {
				await this.collectNodes(child.path, out);
			}
		}
	}

	// TFile → TBNode (메타데이터 캐시 기반)
	async fileToNode(file: TFile): Promise<TBNode | null> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) return null;

		const fm = cache.frontmatter as TBFrontMatter;
		const raw = await this.app.vault.read(file);
		const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
		const nodeType = (fm.tb_type ?? 'claim') as TBNodeType;

		// [옵션A] 엄격 게이트: 액션·문제 노드는 논리 엣지가 없다(edges=[]). 그 외 노드는 tb_edges에서
		// 10공리 외 라벨(구 스키마의 implements 등)을 로드 시 제거해 논리 그래프 순수성을 강제한다.
		const edges: TBEdge[] = (nodeType === 'action' || nodeType === 'problem')
			? []
			: (Array.isArray(fm.tb_edges) ? fm.tb_edges : []).filter(e => isValidRelation(e?.label));

		return {
			id: file.basename,
			title: fm.tb_title ?? file.basename,
			type: nodeType,
			content: body,
			summary: typeof fm.tb_summary === 'string' ? fm.tb_summary : undefined,
			tags: Array.isArray(fm.tb_tags) ? fm.tb_tags : [],
			folder: file.parent?.path ?? '',
			created: fm.tb_created ?? new Date(file.stat.ctime).toISOString(),
			edges,
			filePath: file.path,
			is_core_concept: fm.tb_is_core === true,
			proposition_type: fm.tb_proposition_type === 'fact' ? 'fact' : 'claim',
			block_id: typeof fm.tb_block_id === 'string' ? fm.tb_block_id : undefined,
			// 원문 인용 복원 — 문제 승격 등 로드된 노드에서 출처 구절을 인용할 수 있어야 한다
			source_span: (fm.tb_source_span && typeof fm.tb_source_span.text === 'string')
				? { text: fm.tb_source_span.text, offset: fm.tb_source_span.offset ?? 0 }
				: undefined,
			heading_path: typeof fm.tb_heading_path === 'string' ? fm.tb_heading_path : undefined,
			raw_path: typeof fm.tb_raw_path === 'string' ? fm.tb_raw_path : undefined,
			// tb_topic은 네이티브 그래프 인식용으로 "[[basename]]" 위키링크로 저장됨 → 내부용 basename으로 환원
			topic: typeof fm.tb_topic === 'string'
				? fm.tb_topic.replace(/^\[\[(.+?)(?:\|.+?)?\]\]$/, '$1').trim()
				: undefined,
			// [옵션A] 액션 노드의 동기 명제 basename (canvas 렌더 전용). 구 스키마(implements in tb_edges) 폴백.
			motivation_ids: nodeType === 'action'
				? this.readActionMotivations(fm)
				: undefined,
			link_type: nodeType === 'action'
				? ((fm.tb_link_type ?? fm.tb_action_link_type ?? 'implements') as ActionLinkType)
				: undefined,
			// [Phase 10] 문제 노드 필드
			problem_species: nodeType === 'problem'
				? ((fm.tb_problem_species ?? 'obstacle') as ProblemSpecies)
				: undefined,
			problem_status: nodeType === 'problem'
				? (fm.tb_status === 'resolved' ? 'resolved' : 'open')
				: undefined,
			evidence_ids: nodeType === 'problem' && Array.isArray(fm.tb_problem_evidence_ids)
				? fm.tb_problem_evidence_ids
				: undefined,
			problem_pair: nodeType === 'problem' && typeof fm.tb_problem_pair === 'string'
				? fm.tb_problem_pair
				: undefined,
			resolution_note: nodeType === 'problem' && typeof fm.tb_resolution_note === 'string'
				? fm.tb_resolution_note
				: undefined,
		};
	}

	// 액션 노드의 동기 명제 basename 목록을 읽는다.
	// 신규: tb_action_motivation_ids. 하위호환: 구 스키마의 tb_edges implements/investigates 타깃에서 폴백.
	private readActionMotivations(fm: TBFrontMatter): string[] {
		if (Array.isArray(fm.tb_action_motivation_ids) && fm.tb_action_motivation_ids.length > 0) {
			return fm.tb_action_motivation_ids;
		}
		if (Array.isArray(fm.tb_edges)) {
			return fm.tb_edges
				.filter(e => { const l = String(e?.label); return l === 'implements' || l === 'investigates'; })
				.map(e => String(e.target).replace(/^\[\[(.+?)(?:\|.+?)?\]\]$/, '$1').trim())
				.filter(Boolean);
		}
		return [];
	}

	// 새 노드 .md 파일을 vault에 생성
	// node.folder = 절대 vault 경로 (비어있으면 settings.nodeFolder 사용)
	// rawSourcePath = raw/ 원본 파일 경로(확장자 제외). 있으면 본문에 위키링크 + 발췌 삽입
	async createNode(node: Omit<TBNode, 'filePath'>, rawSourcePath?: string): Promise<TFile> {
		// node.folder가 비면 폴더 없이 볼트 루트에 저장 (ThirdBrain 폴백 없음)
		const folderPath = node.folder ? normalizePath(node.folder) : '';
		if (folderPath) await this.ensureFolder(folderPath);

		const rawTitle = node.title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
		const safeTitle = rawTitle || node.id.replace(/[\\/:*?"<>|#^[\]]/g, '-').slice(0, 50) || 'untitled';
		const filePath = folderPath
			? normalizePath(`${folderPath}/${safeTitle}.md`)
			: `${safeTitle}.md`;
		const finalPath = await this.resolveConflict(filePath);

		// 출처 블록: 원본 위키링크 + (있으면) source_span 발췌 인용구
		let body = node.content;
		if (rawSourcePath) {
			const anchor = node.block_id ? `#^${node.block_id}` : '';
			body += `\n\n---\n[[${rawSourcePath}${anchor}]]`;
			if (node.source_span?.text.trim()) {
				body += `\n\n> ${node.source_span.text.replace(/\n/g, '\n> ')}`;
			}
		}

		const content = `${this.buildFrontmatter(node)}\n\n${body}`;
		return this.app.vault.create(finalPath, content);
	}

	/**
	 * 원본 데이터를 raw/ 폴더에 박제한다.
	 * - 볼트 내 raw/ 하위 파일이면 이미 존재하는 TFile을 반환 (중복 방지)
	 * - 외부 텍스트/파일이면 새 .md 파일을 생성하여 반환
	 * @param text     저장할 원본 텍스트
	 * @param sourceName  파일명 힌트 (확장자 제외). 없으면 타임스탬프만 사용
	 * @param existingVaultPath  이미 볼트 내에 있는 파일 경로 (raw/ 하위이면 생성 생략)
	 */
	async createRawFile(
		text: string,
		sourceName: string,
		existingVaultPath?: string
	): Promise<TFile> {
		const rawFolder = normalizePath(`${this.settings.rootFolder}/raw`);
		await this.ensureFolder(rawFolder);

		// 이미 raw/ 안에 있으면 그 파일 그대로 반환
		if (existingVaultPath && existingVaultPath.startsWith(rawFolder + '/')) {
			const existing = this.app.vault.getFileByPath(existingVaultPath);
			if (existing) return existing;
		}

		const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
		const safeName = sourceName
			.replace(/\.[^.]+$/, '')                    // 확장자 제거
			.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
			.replace(/\s+/g, '_')
			.slice(0, 40)
			|| 'paste';
		const fileName = `${date}_${safeName}.md`;
		const filePath = await this.resolveConflict(normalizePath(`${rawFolder}/${fileName}`));

		return this.app.vault.create(filePath, text);
	}

	/**
	 * 나이브 요약을 summaries/ 폴더에 저장하고 원본(raw) 파일로 위키링크를 건다.
	 * 그래프 노드가 아닌 일반 마크다운 — tb_id·tb_edges 없음, 축·공리 게이트 대상 아님.
	 */
	async saveNaiveSummary(title: string, summary: string, rawFile: TFile, coreFlow?: string): Promise<TFile> {
		const summaryFolder = normalizePath(`${this.settings.rootFolder}/summaries`);
		await this.ensureFolder(summaryFolder);

		const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
		const safeTitle = title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, '_').slice(0, 40) || 'summary';
		const filePath = await this.resolveConflict(normalizePath(`${summaryFolder}/${date}_${safeTitle}.md`));

		const rawWikilink = rawFile.path.replace(/\.md$/, '');
		const flowSection = coreFlow ? `\n\n${coreFlow}` : '';
		const body = `# ${title}\n\n${summary}${flowSection}\n\n---\n[[${rawWikilink}]]`;

		return this.app.vault.create(filePath, body);
	}

	/**
	 * raw/ 파일의 이름을 변경한다. YYYYMMDD 프리픽스는 유지하고 basename만 교체.
	 * extractContexts() 완료 후 의미 있는 제목으로 개명할 때 사용.
	 */
	async renameRawFile(file: TFile, newTitle: string): Promise<TFile> {
		const safeName = newTitle
			.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
			.replace(/\s+/g, '_')
			.slice(0, 50)
			|| 'untitled';
		// 기존 파일명에서 날짜 프리픽스(YYYYMMDD_) 보존
		const datePrefix = file.basename.match(/^(\d{8})_?/)?.[1];
		const newBasename = datePrefix ? `${datePrefix}_${safeName}` : safeName;
		const parentPath = file.parent?.path ? file.parent.path + '/' : '';
		const newPath = await this.resolveConflict(normalizePath(`${parentPath}${newBasename}.md`));
		// vault.rename() 사용 — fileManager.renameFile()은 링크 업데이트 다이얼로그를 트리거하므로 제외
		// 방금 생성된 raw 파일이라 기존 링크가 없어 다이얼로그가 불필요함
		await this.app.vault.rename(file, newPath);
		return this.app.vault.getFileByPath(newPath) ?? file;
	}

	/**
	 * raw 파일의 각 단락 끝에 Obsidian 블록 ID(^tb-XXXXXX)를 삽입한다.
	 * 이미 ^tb- 로 시작하는 앵커가 있는 단락은 건너뛴다 (중복 방지).
	 */
	async insertBlockIds(
		rawFile: TFile,
		items: Array<{ blockId: string; spanText: string }>
	): Promise<{ matched: number; missed: number }> {
		if (items.length === 0) return { matched: 0, missed: 0 };
		let content = await this.app.vault.read(rawFile);

		const paraEnd = (src: string, from: number): number => {
			const next = src.indexOf('\n\n', from);
			return next !== -1 ? next : src.length;
		};

		let matched = 0;
		let missed = 0;
		const insertions = new Map<number, string>();
		for (const { blockId, spanText } of items) {
			const trimmed = spanText.trim();
			if (!trimmed || !content.includes(trimmed)) { missed++; continue; }
			matched++;
			const pos = content.indexOf(trimmed);
			const end = paraEnd(content, pos + trimmed.length);
			const near = content.slice(Math.max(0, end - 30), end);
			if (!near.includes('^tb-')) {
				insertions.set(end, blockId);
			}
		}

		const positions = [...insertions.keys()].sort((a, b) => b - a);
		let result = content;
		for (const pos of positions) {
			const bid = insertions.get(pos)!;
			result = result.slice(0, pos) + ` ^${bid}` + result.slice(pos);
		}

		await this.app.vault.modify(rawFile, result);
		return { matched, missed };
	}

	/**
	 * raw 원본 파일에 명제 출처 주석을 삽입한다.
	 * source_span.offset이 속한 단락 바로 아래에 블록쿼트 형태로 링크를 배치한다.
	 * 재실행 시 <!-- tb-cite --> 마커가 있는 줄을 제거 후 재삽입 (중복 방지).
	 */
	async appendLinksToRawFile(
		rawFile: TFile,
		links: Array<{ file: TFile; sourceSpan?: { text: string; offset: number } }>
	): Promise<void> {
		if (links.length === 0) return;

		let content = await this.app.vault.read(rawFile);

		// 기존 tb-cite 주석 라인 제거 (재실행 대비)
		content = content
			.split('\n')
			.filter(line => !line.includes('<!-- tb-cite -->'))
			.join('\n')
			.trimEnd();

		// 단락 끝 위치를 찾는다 (이중 개행 또는 파일 끝)
		const paragraphEnd = (src: string, from: number): number => {
			const next = src.indexOf('\n\n', from);
			return next !== -1 ? next : src.length;
		};

		// source_span.text를 raw 파일 본문에서 직접 검색 — offset은 summary 기준이라 신뢰 불가
		const withSpan: typeof links = [];
		const withoutSpan: typeof links = [];
		for (const item of links) {
			const spanText = item.sourceSpan?.text?.trim();
			if (spanText && content.includes(spanText)) {
				withSpan.push(item);
			} else {
				withoutSpan.push(item);
			}
		}

		// 텍스트 발견 위치 기준으로 단락 끝 그룹화
		const groups = new Map<number, typeof withSpan>();
		for (const item of withSpan) {
			const textPos = content.indexOf(item.sourceSpan!.text.trim());
			const pos = paragraphEnd(content, textPos + item.sourceSpan!.text.length);
			if (!groups.has(pos)) groups.set(pos, []);
			groups.get(pos)!.push(item);
		}

		// 뒤에서 앞으로 삽입 (앞 삽입이 뒤 오프셋에 영향 안 주도록)
		const sortedPositions = [...groups.keys()].sort((a, b) => b - a);
		let body = content;
		for (const pos of sortedPositions) {
			const items = groups.get(pos)!;
			const annotation = items
				.map(l => `> 📌 [[${l.file.path.replace(/\.md$/, '')}|${l.file.basename}]] <!-- tb-cite -->`)
				.join('\n');
			body = body.slice(0, pos) + '\n' + annotation + body.slice(pos);
		}

		// source_span 없는 링크는 파일 끝에 추가
		if (withoutSpan.length > 0) {
			const tail = withoutSpan
				.map(l => `> 📌 [[${l.file.path.replace(/\.md$/, '')}|${l.file.basename}]] <!-- tb-cite -->`)
				.join('\n');
			body = body.trimEnd() + '\n\n' + tail;
		}

		await this.app.vault.modify(rawFile, body + '\n');
	}

	/** 문맥 레이어 배치 생성 — 각 ContextLayer를 summary 타입 노드로 저장 */
	async createContextBatch(
		contexts: ContextLayer[],
		sessionFolder: string,
		rawSourcePath?: string
	): Promise<Map<string, TFile>> {
		const now = new Date().toISOString();
		const fileMap = new Map<string, TFile>();

		for (const ctx of contexts) {
			if (!ctx.summary || ctx.summary.trim().length < 20) continue; // 내용 없는 노드 방지
			const cleanTitle = cleanNodeTitle(ctx.title);
			try {
				const file = await this.createNode({
					id: ctx.id,
					title: cleanTitle,
					type: 'context',
					content: ctx.summary,
					tags: ctx.keywords.slice(0, 5),
					folder: sessionFolder,
					created: ctx.date || now,
					edges: [],
				}, rawSourcePath);
				fileMap.set(ctx.title, file);
				fileMap.set(cleanTitle, file); // sanitized 제목으로도 조회 가능하도록
			} catch {
				// 개별 문맥 노드 실패는 전체를 중단시키지 않음
			}
		}
		return fileMap;
	}

	/**
	 * 명제 배치 생성 — 세션의 모든 Proposition을 한 번에 vault에 저장.
	 * 세션 내 LogicEdge는 confirmed=false (미확정) 상태로 tb_edges에 주입.
	 * 명제→문맥 auto-edge는 connectContextsToPropositions(view.ts)가 관련성 가드와 함께 담당한다.
	 * @returns propositionId → TFile 매핑
	 */
	async createPropositionBatch(
		propositions: Proposition[],
		logicEdges: LogicEdge[],
		contextTags: string[],
		sessionFolder: string,
		rawSourcePath?: string
	): Promise<Map<string, TFile>> {
		const now = new Date().toISOString();

		// 엣지 위키링크 폴백용 id → title 매핑 (배치 밖 노드 대비) — / 포함 제목은 Obsidian이 경로로 해석하므로 정규화
		const titleMap = new Map<string, string>();
		for (const p of propositions) titleMap.set(p.id, cleanNodeTitle(p.title));

		const fileMap = new Map<string, TFile>();
		// resolveConflict가 동일 제목 노드(예: 같은 제목의 context) 존재 시 파일 basename을 `X-2`로 바꾸므로,
		// 엣지 위키링크를 title(`[[X]]`)로 걸면 엉뚱한 동명 노드(basename=X)로 오연결된다.
		// 실제 생성된 basename을 수집해 두었다가(Pass 1) basename 위키링크로 엣지를 건다(Pass 2).
		const idToBasename = new Map<string, string>();

		// Pass 1: 명제 파일 생성 (엣지는 대상 basename이 모두 확정된 뒤 Pass 2에서 주입)
		for (const p of propositions) {
			// Phase 1-7: source_span 밸리데이션 게이트 (user_synthesized 면제)
			const origin = (p as { origin?: string }).origin;
			if (origin !== 'user_synthesized') {
				const spanText = p.source_span?.text ?? '';
				if (spanText.trim().length === 0) {
					continue;
				}
			}

			// 명제→문맥 auto-edge는 connectContextsToPropositions(view.ts)가 관련성 가드와 함께
			// 단독으로 생성한다. 여기서 중복 생성하면 가드를 우회하므로 만들지 않는다. [Bug #2]

			try {
				const file = await this.createNode({
					id: sanitizeId(p.title),
					title: cleanNodeTitle(p.title),
					type: p.role,
					content: p.text,
					tags: contextTags,
					folder: sessionFolder,
					created: now,
					edges: [],
					is_core_concept: p.is_core_concept === true,
					source_span: p.source_span,
					proposition_type: p.proposition_type,
					block_id: p.block_id,
					heading_path: p.heading_path,
					raw_path: rawSourcePath,
				}, rawSourcePath);
				fileMap.set(p.id, file);
				idToBasename.set(p.id, file.basename);
			} catch {
				// 개별 노드 실패는 전체를 중단시키지 않음
			}
		}

		// Pass 2: 논리 엣지를 실제 basename 위키링크로 주입 — confidence ≥ 0.75 필터 통과 = 파이프라인 승인, confirmed: true
		for (const p of propositions) {
			const file = fileMap.get(p.id);
			if (!file) continue;
			const outEdges: TBEdge[] = logicEdges
				.filter(e => e.source === p.id)
				.map(e => ({
					target: `[[${idToBasename.get(e.target) ?? titleMap.get(e.target) ?? e.target}]]`,
					label: toRelation(e.relation),
					confirmed: true,
					reason: e.reason,
					confidence: typeof e.confidence === 'number' ? e.confidence : 1.0,
					axiom_basis: typeof e.axiom_basis === 'string' ? e.axiom_basis : '',
				}));
			if (outEdges.length === 0) continue;
			await this.app.fileManager.processFrontMatter(file, (fm: TBFrontMatter) => {
				fm.tb_edges = outEdges;
			});
		}

		return fileMap;
	}

	// [Phase 2] 명제 노드의 소속 토픽(tb_topic) 기입 — membership은 논리 엣지가 아니라 프론트매터 필드
	async setNodeTopic(file: TFile, topicBasename: string): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm: TBFrontMatter) => {
			// Obsidian 네이티브 그래프가 소속선을 그리도록 위키링크로 저장 (tb_edges 논리 그래프는 불변)
			fm.tb_topic = `[[${topicBasename}]]`;
		});
	}

	// 유저가 칩 확정 → 프론트매터에 엣지 주입 (2.5차 큐레이션 완료)
	async confirmEdge(sourceFile: TFile, edge: TBEdge): Promise<void> {
		await this.app.fileManager.processFrontMatter(sourceFile, (fm: TBFrontMatter) => {
			const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
			const idx = edges.findIndex(e => e.target === edge.target);
			if (idx >= 0) {
				edges[idx] = { ...edge, confirmed: true };
			} else {
				edges.push({ ...edge, confirmed: true });
			}
			fm.tb_edges = edges;
		});
	}

	// 브리지 엣지 저장 (Phase 5) — 단방향.
	// 역방향에 같은 라벨을 함께 쓰면 방향성 관계(precedes/precondition_of 등)에서
	// "A→B ∧ B→A" 논리 모순이 생기고, 대칭 관계는 중복 엣지가 된다. 출발 노드에만 기록한다.
	// (위키링크가 이미 걸리므로 네이티브 그래프·백링크에는 양쪽 모두 보인다.)
	async saveBridgeEdges(
		bridgeEdges: BridgeEdge[],
		fileMapA: Map<string, TFile>,
		fileMapB: Map<string, TFile>
	): Promise<void> {
		for (const edge of bridgeEdges) {
			// title 우선, 없으면 filename fallback — 양쪽 파일이 실재해야 저장 (댕글링 링크 방지)
			const srcFile = (edge.source_title && fileMapA.get(edge.source_title))
				?? fileMapA.get(edge.source_file);
			const tgtFile = (edge.target_title && fileMapB.get(edge.target_title))
				?? fileMapB.get(edge.target_file);
			if (!srcFile || !tgtFile) continue;

			const tgtLabel = edge.target_title ?? edge.target_file.replace(/\.md$/, '');
			const edgeAtoB: TBEdge = {
				target: `[[${tgtLabel}]]`,
				label: toRelation(edge.relation),
				confirmed: true,
				reason: edge.reason,
				confidence: edge.confidence ?? 1.0,
				axiom_basis: edge.axiom_basis,
			};
			await this.app.fileManager.processFrontMatter(srcFile, (fm: TBFrontMatter) => {
				const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
				if (!edges.find(e => e.target === edgeAtoB.target)) edges.push(edgeAtoB);
				fm.tb_edges = edges;
			});
		}
	}

	/**
	 * 노드 이식: 일반 .md 파일을 ThirdBrain 노드로 변환하여 대상 폴더로 이동
	 * - 기존 프론트매터가 있으면 tb_ 속성만 추가/덮어쓰기 (기존 내용 보존)
	 * - 파일 이름 충돌 시 자동 넘버링
	 */
	async transplantNode(
		file: TFile,
		targetFolder: string,
		props: import('../types').NodeClassification,
		confirmedEdges: import('../types').TBEdge[]
	): Promise<TFile> {
		await this.ensureFolder(targetFolder);

		const targetPath = await this.resolveConflict(
			normalizePath(targetFolder ? `${targetFolder}/${file.name}` : file.name)
		);

		// 파일 이동
		await this.app.fileManager.renameFile(file, targetPath);

		const movedFile = this.app.vault.getFileByPath(targetPath);
		if (!movedFile) throw new Error(`이동된 파일을 찾을 수 없습니다: ${targetPath}`);

		const now = new Date().toISOString();
		const id = sanitizeId(props.title || movedFile.basename);

		// 프론트매터 원자적 삽입/병합
		await this.app.fileManager.processFrontMatter(movedFile, (fm: TBFrontMatter) => {
			fm.tb_id       = fm.tb_id       ?? id;
			fm.tb_title    = props.title;
			fm.tb_type     = props.type;
			fm.tb_tags     = props.tags;
			fm.tb_summary  = props.summary;
			fm.tb_created  = fm.tb_created  ?? now;
			fm.tb_edges    = confirmedEdges.length > 0 ? confirmedEdges : (fm.tb_edges ?? []);
			fm.tb_links    = confirmedEdges.map(e => e.target).filter(Boolean);
		});

		return movedFile;
	}

	/** YAML 큰따옴표 문자열로 안전하게 이스케이프. 개행이 raw로 섞이면 quoted scalar가 깨져
	 *  프론트매터 파싱 자체가 실패하므로(모든 필드가 함께 죽음), 개행류는 공백으로 치환한다. */
	private yamlQuote(s: string): string {
		return s.replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim();
	}

	private buildFrontmatter(node: Omit<TBNode, 'filePath'>): string {
		const edges = node.edges ?? [];
		const edgesJson = JSON.stringify(edges);
		const tags = node.tags ?? [];

		const tagsStr = tags.length > 0
			? '\n' + tags.map(t => `  - "${t}"`).join('\n')
			: ' []';

		// Obsidian 네이티브 그래프/백링크 감지용 — tb_edges JSON 속 [[target]] 을 YAML 리스트로 노출
		const linkTargets = edges.map(e => e.target).filter(Boolean);
		const linksStr = linkTargets.length > 0
			? '\n' + linkTargets.map(t => `  - "${t}"`).join('\n')
			: ' []';

		const lines = [
			'---',
			`tb_title: "${this.yamlQuote(node.title)}"`,
			`tb_id: "${node.id}"`,
			`tb_type: ${node.type}`,
			`tb_created: "${node.created}"`,
			`tb_tags:${tagsStr}`,
			`tb_links:${linksStr}`,
			`tb_edges: ${edgesJson}`,
		];
		if (node.is_core_concept) lines.push('tb_is_core: true');
		if (node.source_span?.text) {
			lines.push(`tb_source_span: ${JSON.stringify(node.source_span)}`);
		}
		if (node.proposition_type === 'fact') lines.push('tb_proposition_type: fact');
		if (node.block_id) lines.push(`tb_block_id: "${node.block_id}"`);
		if (node.heading_path) lines.push(`tb_heading_path: "${this.yamlQuote(node.heading_path)}"`);
		if (node.raw_path) lines.push(`tb_raw_path: "${this.yamlQuote(node.raw_path)}"`);
		if (node.topic) lines.push(`tb_topic: "[[${node.topic}]]"`);
		// Phase 2-4: conflicts_with 엣지가 있으면 tb_conflict 마킹
		const hasConflict = edges.some(e => e.label === 'conflicts_with' && e.confirmed);
		if (hasConflict) lines.push('tb_conflict: true');
		lines.push('---');
		return lines.join('\n');
	}

	private async ensureFolder(path: string): Promise<void> {
		if (!this.app.vault.getFolderByPath(path)) {
			await this.app.vault.createFolder(path);
		}
	}

	private async resolveConflict(filePath: string): Promise<string> {
		if (!this.app.vault.getFileByPath(filePath)) return filePath;
		const base = filePath.replace(/\.md$/, '');
		let i = 2;
		while (this.app.vault.getFileByPath(`${base}-${i}.md`)) i++;
		return `${base}-${i}.md`;
	}

	// ── Phase 8-5: ActionNode CRUD ───────────────────────────

	/**
	 * ActionNode를 _actions 서브폴더에 저장한다.
	 * 명제 노드와 물리적으로 분리됨.
	 */
	async createActionNode(
		node: Omit<ActionNode, 'filePath'>,
		parentFolder: string,
		propFileMap?: Map<string, TFile>
	): Promise<TFile> {
		const folder = parentFolder
			? normalizePath(`${parentFolder}/_actions`)
			: '_actions';
		await this.ensureFolder(folder);

		const safeTitle = sanitizeId(node.title) || node.id.slice(0, 50) || 'action-untitled';
		let filePath = normalizePath(`${folder}/${safeTitle}.md`);
		filePath = await this.resolveConflict(filePath);

		// [옵션A] 액션→명제 소속은 논리 엣지(tb_edges)가 아니라 별도 필드(tb_action_motivation_ids)로 저장한다.
		// tb_edges는 10공리 명제↔명제 전용 → 액션은 항상 []. 네이티브 그래프 provenance는 tb_links 위키링크로 보존.
		const motivBasenames = (node.motivation_ids ?? [])
			.map(id => propFileMap?.get(id))
			.filter((f): f is TFile => !!f)
			.map(f => f.basename);

		const linksStr = motivBasenames.length > 0
			? '\n' + motivBasenames.map(b => `  - "[[${b}]]"`).join('\n')
			: ' []';
		// 파이프라인 내부 명제 id(p1, p2…)는 저장 후 무의미 → 실제 저장 파일 basename으로 해석해 저장한다.
		const motivIdsJson = JSON.stringify(motivBasenames);
		const motivCtxIds = JSON.stringify(node.motivation_context_ids ?? []);

		const frontmatter = [
			'---',
			`tb_id: "${node.id}"`,
			`tb_title: "${node.title.replace(/"/g, '\\"')}"`,
			`tb_type: action`,
			`tb_created: "${node.created}"`,
			`tb_tags: []`,
			`tb_links:${linksStr}`,
			`tb_edges: []`,
			`tb_action_motivation_ids: ${motivIdsJson}`,
			`tb_status: ${node.status}`,
			`tb_owner: "${(node.owner ?? '').replace(/"/g, '\\"')}"`,
			`tb_deadline: "${node.deadline ?? ''}"`,
			`tb_link_type: ${node.link_type}`,
			`tb_origin: ${node.origin}`,
			`tb_motivation_context_ids: ${motivCtxIds}`,
			...(node.problem_id ? [`tb_problem_id: "${node.problem_id.replace(/"/g, '\\"')}"`] : []),
			...(node.meeting_type ? [`tb_meeting_type: ${node.meeting_type}`] : []),
			'---',
		].join('\n');

		const content = `${frontmatter}\n\n${node.content}`;
		return this.app.vault.create(filePath, content);
	}

	/** ActionNode 상태만 업데이트 */
	async updateActionStatus(file: TFile, status: ActionStatus): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm: TBFrontMatter) => {
			fm.tb_status = status;
		});
	}

	/** ActionNode owner / deadline 업데이트 */
	async updateActionMeta(file: TFile, owner: string, deadline: string): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm: TBFrontMatter) => {
			fm.tb_owner   = owner;
			fm.tb_deadline = deadline;
		});
	}

	/** 폴더(및 하위 _actions/) 내 모든 ActionNode 로드 */
	async loadActionNodes(folderPath: string): Promise<ActionNode[]> {
		const actionFolder = folderPath
			? normalizePath(`${folderPath}/_actions`)
			: '_actions';
		const folder = this.app.vault.getFolderByPath(actionFolder);
		if (!folder) return [];

		const nodes: ActionNode[] = [];
		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== 'md') continue;
			const node = await this.fileToActionNode(child);
			if (node) nodes.push(node);
		}
		return nodes;
	}

	// ── Phase 10: 문제 노드 CRUD ─────────────────────────────
	// 문제 = 명제 간 긴장. 해결까지 지속(open→resolved). tb_edges는 항상 [] (논리 그래프 순수성).
	// 증거 명제는 tb_problem_evidence_ids 필드 + tb_links 위키링크(네이티브 그래프 provenance).

	async createProblemNode(
		problem: {
			title: string;
			description: string;
			species: ProblemSpecies;
			evidence_ids: string[];
			pair?: string; // contradiction 승격용 안정 식별자 (정렬된 "A↔B")
		},
		parentFolder: string,
	): Promise<TFile> {
		const folder = parentFolder
			? normalizePath(`${parentFolder}/_problems`)
			: '_problems';
		await this.ensureFolder(folder);

		const safeTitle = sanitizeId(problem.title) || `problem-${Date.now().toString(36)}`;
		let filePath = normalizePath(`${folder}/${safeTitle}.md`);
		filePath = await this.resolveConflict(filePath);

		const linksStr = problem.evidence_ids.length > 0
			? '\n' + problem.evidence_ids.map(b => `  - "[[${b}]]"`).join('\n')
			: ' []';

		const frontmatter = [
			'---',
			`tb_id: "prob-${Date.now().toString(36)}"`,
			`tb_title: "${problem.title.replace(/"/g, '\\"')}"`,
			`tb_type: problem`,
			`tb_created: "${new Date().toISOString()}"`,
			`tb_tags: []`,
			`tb_links:${linksStr}`,
			`tb_edges: []`,
			`tb_problem_species: ${problem.species}`,
			`tb_status: open`,
			`tb_problem_evidence_ids: ${JSON.stringify(problem.evidence_ids)}`,
			...(problem.pair ? [`tb_problem_pair: "${problem.pair.replace(/"/g, '\\"')}"`] : []),
			'---',
		].join('\n');

		return this.app.vault.create(filePath, `${frontmatter}\n\n${problem.description}`);
	}

	/** 문제 상태 갱신 (open ↔ resolved). resolved 시 해소 방법을 tb_resolution_note에 기록. */
	async updateProblemStatus(file: TFile, status: ProblemStatus, resolutionNote?: string): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm: TBFrontMatter) => {
			fm.tb_status = status;
			if (status === 'resolved' && resolutionNote) fm.tb_resolution_note = resolutionNote;
			if (status === 'open') delete fm.tb_resolution_note;
		});
	}

	/** [문제 작업공간] 볼트 전체의 열린(open) 문제 노드 목록 — 미션 보드/배지용. */
	async loadOpenProblems(): Promise<TBNode[]> {
		const all = await this.loadNodesInFolder(this.settings.rootFolder || '/');
		return all.filter(n => n.type === 'problem' && n.problem_status === 'open');
	}

	/**
	 * [뇌 상태] 세션 폴더별로 열린 미션(문제)과 미연결 명제 수를 집계.
	 * 미션·미연결은 글로벌 경보가 아니라 "폴더 안에서 아직 안 끝난 일" → 폴더 단위로 드릴인한다.
	 * 미션이나 미연결이 하나라도 있는 폴더만 반환(미션 많은 순 → 미연결 많은 순).
	 */
	async loadBrainStatus(): Promise<BrainFolderStatus[]> {
		const root = this.settings.rootFolder || '';
		const all = await this.loadNodesInFolder(root || '/');
		const NON_PROP_TYPES: TBNodeType[] = ['context', 'action', 'problem', 'summary', 'expression'];
		const sessionOf = (folder: string): string => {
			let rel = folder;
			if (root && (folder === root || folder.startsWith(`${root}/`))) {
				rel = folder.slice(root.length).replace(/^\/+/, '');
			}
			const first = rel.split('/')[0] ?? '';
			return root ? (first ? `${root}/${first}` : root) : first;
		};

		const map = new Map<string, BrainFolderStatus>();
		const statusOf = (session: string): BrainFolderStatus => {
			let st = map.get(session);
			if (!st) { st = { sessionFolder: session, missions: [], orphanCount: 0, conflicts: [] }; map.set(session, st); }
			return st;
		};
		for (const n of all) {
			if (n.folder.split('/').includes('raw')) continue;
			const st = statusOf(sessionOf(n.folder));
			if (n.type === 'problem' && n.problem_status === 'open') {
				st.missions.push(n);
			} else if (!NON_PROP_TYPES.includes(n.type) && this.isUnlinkedProp(n)) {
				st.orphanCount++;
			}
		}

		// 미해소 모순도 폴더 단위로 귀속 (nodeA의 세션 폴더 기준)
		for (const c of detectConflicts(all)) {
			statusOf(sessionOf(c.nodeA.folder)).conflicts.push(c);
		}

		return [...map.values()]
			.filter(s => s.missions.length > 0 || s.orphanCount > 0 || s.conflicts.length > 0)
			.sort((a, b) =>
				(b.conflicts.length - a.conflicts.length) ||
				(b.missions.length - a.missions.length) ||
				(b.orphanCount - a.orphanCount));
	}

	/**
	 * [그래프 삭제] 선택 폴더의 그래프 전체 삭제 대상 수집.
	 * 폴더 하위 전체(md — _problems/_solving/_actions 포함) + 노드가 참조하는 raw 원본
	 * + 그 raw를 링크하는 summaries 요약본까지. 실제 삭제는 호출자가 확인 후 수행.
	 */
	async collectGraphDeletionTargets(folders: string[]): Promise<TFile[]> {
		const targets = new Map<string, TFile>();
		const rawBasenames = new Set<string>();

		for (const folder of folders) {
			// 폴더 하위 md 전부 (재귀) — TB 노드 여부와 무관하게 세션 폴더 통째
			const prefix = folder.endsWith('/') ? folder : `${folder}/`;
			for (const f of this.app.vault.getMarkdownFiles()) {
				if (f.path.startsWith(prefix)) targets.set(f.path, f);
			}
			// 노드의 tb_raw_path → raw 원본
			const nodes = await this.loadNodesInFolder(folder);
			for (const n of nodes) {
				if (!n.raw_path) continue;
				const rawFile = this.app.metadataCache.getFirstLinkpathDest(n.raw_path, '');
				if (rawFile) {
					targets.set(rawFile.path, rawFile);
					rawBasenames.add(rawFile.basename);
				}
			}
		}

		// summaries/ 에서 해당 raw를 링크하는 요약본
		if (rawBasenames.size > 0) {
			const summariesDir = normalizePath(`${this.settings.rootFolder}/summaries`);
			for (const f of this.app.vault.getMarkdownFiles()) {
				if (!f.path.startsWith(`${summariesDir}/`)) continue;
				const content = await this.app.vault.cachedRead(f);
				for (const base of rawBasenames) {
					if (content.includes(`[[`) && content.includes(base)) {
						targets.set(f.path, f);
						break;
					}
				}
			}
		}

		return [...targets.values()];
	}

	/** [그래프 삭제] 수집된 대상을 휴지통으로 이동 (영구삭제 아님 — 복구 가능).
	 *  선택 폴더는 서브폴더(_problems/_solving/_actions 등)까지 통째로 휴지통에 들어간다. */
	async deleteGraphTargets(files: TFile[], folders: string[]): Promise<number> {
		const inSelected = (path: string) =>
			folders.some(f => path.startsWith(f.endsWith('/') ? f : `${f}/`));
		let deleted = 0;

		// 1) 폴더 밖 대상(raw 원본·summaries 요약본)만 개별 삭제
		for (const f of files) {
			if (inSelected(f.path)) continue;
			try {
				await this.app.fileManager.trashFile(f);
				deleted++;
			} catch { /* 개별 실패는 계속 진행 */ }
		}

		// 2) 선택 폴더는 통째로 휴지통 — 내부 파일·서브폴더가 함께 이동 (trashFile은 TAbstractFile 수용)
		for (const folder of folders) {
			const tf = this.app.vault.getFolderByPath(folder);
			if (!tf) continue;
			const innerCount = files.filter(x => x.path.startsWith(folder.endsWith('/') ? folder : `${folder}/`)).length;
			try {
				await this.app.fileManager.trashFile(tf);
				deleted += innerCount;
			} catch { /* 폴더 삭제 실패는 무시 — 파일은 다음 시도에서 개별 처리 가능 */ }
		}
		return deleted;
	}

	/** [문제 작업공간] 미션 작업 노트를 세션 `_solving/` 하위에 생성. 이미 있으면 재사용(유저의 해결 작업 보존). */
	async createSolvingNote(problem: TBNode, content: string): Promise<TFile> {
		const sessionRoot = problem.folder.replace(/[\\/]_problems$/, '');
		const folder = sessionRoot ? normalizePath(`${sessionRoot}/_solving`) : '_solving';
		await this.ensureFolder(folder);
		const safe = sanitizeId(problem.title) || `mission-${Date.now().toString(36)}`;
		const path = normalizePath(`${folder}/미션-${safe}.md`);
		const existing = this.app.vault.getFileByPath(path);
		if (existing) return existing;
		return this.app.vault.create(path, content);
	}

	/**
	 * 모순 → 문제 노드 조정 루프 (진실의 원천은 conflicts_with 엣지, 문제 노드는 상태 추적자).
	 * - 엣지가 있는데 문제 노드가 없으면 → contradiction 문제 노드 생성 (라이프사이클 부여)
	 * - 엣지가 사라졌는데 문제 노드가 open이면 → resolved 마킹 (모달 밖 해소도 자동 반영)
	 */
	async reconcileContradictionProblems(
		folder: string,
		conflicts: ConflictReport[],
		allNodes: TBNode[],
	): Promise<void> {
		const pairOf = (a: string, b: string) => [a, b].sort().join('↔');
		const activePairs = new Set(conflicts.map(c => pairOf(c.nodeA.id, c.nodeB.id)));
		const problemNodes = allNodes.filter(n => n.type === 'problem' && n.problem_species === 'contradiction');
		const knownPairs = new Set(problemNodes.map(n => n.problem_pair).filter(Boolean));

		// 명제문 + 원문 인용 + 원본 블록 링크 동봉 — 유저가 원문을 직접 열어보고
		// 진짜 모순인지 판단할 수 있어야 한다 (역추적 철학). 인용만 있고 링크가 없으면
		// 정확히 어느 발화인지 다시 찾아 헤매야 하므로 반드시 함께 붙인다.
		const evidenceBlock = (n: TBNode) => {
			const claim = (n.content.split('\n---\n')[0] ?? '').trim().split('\n')[0] ?? n.title;
			const quote = (n.source_span?.text ?? '').replace(/\s+/g, ' ').trim();
			const quoteLine = quote ? `\n  > ${quote.length > 240 ? `${quote.slice(0, 240)}…` : quote}` : '';
			const anchor = n.raw_path
				? `\n  [[${n.raw_path}${n.block_id ? `#^${n.block_id}` : ''}|원문 보기]]`
				: '';
			return `- **${n.title}** — ${claim}${quoteLine}${anchor}`;
		};

		// 신규 모순 → 문제 노드 승격
		for (const c of conflicts) {
			const pair = pairOf(c.nodeA.id, c.nodeB.id);
			if (knownPairs.has(pair)) continue;
			try {
				await this.createProblemNode({
					title: `모순: ${c.nodeA.title.slice(0, 20)} ↔ ${c.nodeB.title.slice(0, 20)}`,
					description: [
						'두 명제가 동시에 참일 수 없습니다.',
						evidenceBlock(c.nodeA),
						evidenceBlock(c.nodeB),
						`근거: ${c.evidence || '—'}`,
					].join('\n'),
					species: 'contradiction',
					evidence_ids: [c.nodeA.id, c.nodeB.id],
					pair,
				}, folder);
			} catch { /* 개별 생성 실패는 조정 루프를 중단시키지 않음 */ }
		}

		// 엣지가 사라진 open 문제 → 자동 resolved
		for (const p of problemNodes) {
			if (p.problem_status !== 'open' || !p.problem_pair) continue;
			if (activePairs.has(p.problem_pair)) continue;
			const file = this.app.vault.getFileByPath(p.filePath);
			if (file) {
				await this.updateProblemStatus(file, 'resolved', '모순 엣지 해소됨 (자동 감지)').catch(() => {});
			}
		}
	}

	/** 모순 해소 모달에서 호출 — 해당 쌍의 open 문제 노드에 구체적 해소 방법을 기록. */
	async resolveContradictionProblem(folder: string, nodeAId: string, nodeBId: string, note: string): Promise<void> {
		const pair = [nodeAId, nodeBId].sort().join('↔');
		const problems = await this.loadNodesInFolder(
			folder ? normalizePath(`${folder}/_problems`) : '_problems',
		);
		for (const p of problems) {
			if (p.type !== 'problem' || p.problem_pair !== pair || p.problem_status !== 'open') continue;
			const file = this.app.vault.getFileByPath(p.filePath);
			if (file) await this.updateProblemStatus(file, 'resolved', note).catch(() => {});
		}
	}

	/** _actions 폴더를 재귀 포함 전체 볼트에서 ActionNode 로드 */
	async loadAllActionNodes(): Promise<ActionNode[]> {
		const nodes: ActionNode[] = [];
		const files = this.app.vault.getMarkdownFiles();
		for (const f of files) {
			if (!f.path.includes('/_actions/') && !f.path.startsWith('_actions/')) continue;
			const node = await this.fileToActionNode(f);
			if (node) nodes.push(node);
		}
		return nodes;
	}

	private async fileToActionNode(file: TFile): Promise<ActionNode | null> {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter as TBFrontMatter | undefined;
		// 신규 스키마(tb_type: action) 또는 구형 스키마(tb_action_id) 모두 인식
		const isNew = fm?.tb_type === 'action';
		const isLegacy = !!fm?.tb_action_id;
		if (!isNew && !isLegacy) return null;

		return {
			id:      String(fm?.tb_id ?? fm?.tb_action_id ?? ''),
			title:   String(fm?.tb_title ?? fm?.tb_action_title ?? file.basename),
			content: await this.readBodyAfterFrontmatter(file),
			owner:   String(fm?.tb_owner ?? fm?.tb_action_owner ?? ''),
			deadline: String(fm?.tb_deadline ?? fm?.tb_action_deadline ?? ''),
			status:  ((fm?.tb_status ?? fm?.tb_action_status) as ActionStatus) ?? 'pending',
			motivation_ids:         fm ? this.readActionMotivations(fm) : [],
			motivation_context_ids: Array.isArray(fm?.tb_motivation_context_ids ?? fm?.tb_action_motivation_context_ids)
				? ((fm?.tb_motivation_context_ids ?? fm?.tb_action_motivation_context_ids) as string[])
				: [],
			link_type:    (fm?.tb_link_type ?? fm?.tb_action_link_type ?? 'implements') as ActionLinkType,
			origin:       (fm?.tb_origin ?? fm?.tb_action_origin ?? 'extracted') as ActionNode['origin'],
			problem_id:   typeof fm?.tb_problem_id === 'string' ? fm.tb_problem_id : undefined,
			created:      String(fm?.tb_created ?? fm?.tb_action_created ?? ''),
			filePath:     file.path,
			meeting_type: fm?.tb_meeting_type ? (fm.tb_meeting_type as MeetingType) : undefined,
		};
	}

	/**
	 * conflicts_with 엣지를 다른 엣지 타입으로 교체한다.
	 * 양방향 엣지 모두 업데이트하고 tb_conflict 플래그를 제거한다.
	 */
	async replaceEdge(
		nodeFile: TFile,
		targetWikilink: string,
		newLabel: TBEdgeRelation,
		newReason: string,
	): Promise<void> {
		await this.app.fileManager.processFrontMatter(nodeFile, (fm: TBFrontMatter) => {
			const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
			const idx = edges.findIndex(e => e.target === targetWikilink && e.label === 'conflicts_with');
			if (idx >= 0) {
				edges[idx] = { ...edges[idx], label: newLabel, reason: newReason };
			}
			fm.tb_edges = edges;
			// conflicts_with 엣지가 더 이상 없으면 tb_conflict 플래그 제거
			if (!edges.some(e => e.label === 'conflicts_with')) {
				delete fm.tb_conflict;
			}
		});

		// 역방향 엣지도 교체 (targetFile → nodeFile)
		const targetName = targetWikilink.replace(/^\[\[|\]\]$/g, '');
		const targetFile = this.app.metadataCache.getFirstLinkpathDest(targetName, '');
		if (targetFile) {
			const reverseTarget = `[[${nodeFile.basename}]]`;
			await this.app.fileManager.processFrontMatter(targetFile, (fm: TBFrontMatter) => {
				const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
				const idx = edges.findIndex(e => e.target === reverseTarget && e.label === 'conflicts_with');
				if (idx >= 0) {
					edges[idx] = { ...edges[idx], label: newLabel, reason: newReason };
				}
				fm.tb_edges = edges;
				if (!edges.some(e => e.label === 'conflicts_with')) {
					delete fm.tb_conflict;
				}
			});
		}
	}

	/**
	 * conflicts_with 엣지를 양방향으로 제거하고 tb_conflict 플래그를 삭제한다.
	 */
	async removeConflictEdge(nodeAFile: TFile, nodeBWikilink: string): Promise<void> {
		const removeSide = async (file: TFile, targetWikilink: string) => {
			await this.app.fileManager.processFrontMatter(file, (fm: TBFrontMatter) => {
				const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
				fm.tb_edges = edges.filter(e => !(e.target === targetWikilink && e.label === 'conflicts_with'));
				if (!fm.tb_edges.some((e: TBEdge) => e.label === 'conflicts_with')) {
					delete fm.tb_conflict;
				}
			});
		};

		await removeSide(nodeAFile, nodeBWikilink);
		const targetName = nodeBWikilink.replace(/^\[\[|\]\]$/g, '');
		const nodeBFile = this.app.metadataCache.getFirstLinkpathDest(targetName, '');
		if (nodeBFile instanceof TFile) {
			await removeSide(nodeBFile, `[[${nodeAFile.basename}]]`);
		}
	}

	/**
	 * 노드 파일을 삭제하고, 같은 폴더 내 다른 노드에서 해당 노드를 가리키는 엣지를 모두 제거한다.
	 */
	async deleteNodeAndCleanEdges(node: TBNode, folder: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(node.filePath);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}

		const deletedWikilink = `[[${node.title}]]`;
		const allFiles = this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(folder));

		for (const f of allFiles) {
			const cache = this.app.metadataCache.getFileCache(f);
			const edges: unknown[] = (cache?.frontmatter as TBFrontMatter | undefined)?.tb_edges ?? [];
			if (!Array.isArray(edges)) continue;
			if (!edges.some((e: unknown) => (e as { target?: string })?.target === deletedWikilink)) continue;

			await this.app.fileManager.processFrontMatter(f, (fm: TBFrontMatter) => {
				const curr: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
				fm.tb_edges = curr.filter(e => e.target !== deletedWikilink);
				if (!fm.tb_edges.some((e: TBEdge) => e.label === 'conflicts_with')) {
					delete fm.tb_conflict;
				}
			});
		}
	}

	private async readBodyAfterFrontmatter(file: TFile): Promise<string> {
		const raw = await this.app.vault.read(file);
		const match = raw.match(/^---[\s\S]*?---\n?([\s\S]*)$/);
		return match ? match[1].trim() : raw.trim();
	}
}

function sanitizeId(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim().slice(0, 50);
}

/** Obsidian 파일명·위키링크 양쪽에서 안전한 노드 제목으로 변환.
 *  파일명 금지 문자(* " # / \ < > : | ?)를 모두 공백으로 치환.
 *  createNode의 filename sanitize와 동일한 문자셋을 적용해야 wikilink ↔ 파일명이 일치한다.
 */
function cleanNodeTitle(title: string): string {
	return title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}


// ── [문제 작업공간] 크로스폴더 해결 재료 수집 + 미션 작업 노트 조립 ──────────
// 문제(미션)를 다른 폴더에 축적된 지식으로 풀기 위한 재료를 모은다.
// 관련성은 기존 contextRelevanceScore(어휘 substring 겹침)를 재사용한다.
// AI 없이 동작(Phase 1) — 콜드스타트 없음. AI 제안은 이후 단계에서 노트 섹션으로 추가.

export interface ProblemMaterial {
	node: TBNode;
	score: number;
}

/** [뇌 상태] 세션 폴더 하나의 미해결 현황 — 열린 미션 목록 + 미연결 명제 수 + 미해소 모순. */
export interface BrainFolderStatus {
	sessionFolder: string;
	missions: TBNode[];
	orphanCount: number;
	conflicts: ConflictReport[];
}

// (구 작업대의 gatherProblemMaterial은 v0.3.5에서 제거 — 크로스폴더 재료 수집은
//  미션 컨트롤의 서브그래프 참여가 대체한다)

/** 미션 작업 노트(마크다운) 조립 — 문제 + 증거 + 크로스폴더 재료 + 빈 해결 작업 섹션. */
export function buildSolvingNote(
	problem: TBNode,
	evidenceNodes: TBNode[],
	material: ProblemMaterial[],
): string {
	const firstLine = (s: string) => ((s.split('\n---\n')[0] ?? '').trim().split('\n')[0] ?? '').trim();
	const fm = [
		'---',
		`tb_solving_for: "${problem.id.replace(/"/g, '\\"')}"`,
		'tb_type: solving',
		`tb_created: "${new Date().toISOString()}"`,
		'---',
	].join('\n');

	let md = `\n# 미션: ${problem.title}\n`;
	const stmt = firstLine(problem.content);
	if (stmt) md += `\n${stmt}\n`;

	md += `\n## 문제 (증거)\n`;
	if (evidenceNodes.length === 0) md += `- (증거 명제 없음)\n`;
	for (const e of evidenceNodes) {
		const link = e.raw_path ? ` ([[${e.raw_path}${e.block_id ? `#^${e.block_id}` : ''}|원문]])` : '';
		md += `- **[[${e.id}]]** — ${firstLine(e.content)}${link}\n`;
	}

	md += `\n## 다른 폴더 재료 (자동 수집)\n`;
	if (material.length === 0) md += `- (관련 재료 없음)\n`;
	for (const m of material) {
		md += `- [[${m.node.id}]] (${m.node.type}, ${Math.round(m.score * 100)}%) — ${firstLine(m.node.content)}\n`;
	}

	md += `\n## 해결 작업\n\n`;
	return `${fm}\n${md}`;
}

