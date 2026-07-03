import { App, TFile, normalizePath } from 'obsidian';
import { toRelation } from '../types';
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
	tb_source_span?: { text: string; start: number; end: number };
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

	// 배지용 — vault 전체 고립 명제 수 빠르게 집계
	async countOrphanPropositions(): Promise<number> {
		const allNodes = await this.loadNodesInFolder(this.settings.rootFolder || '/');
		const NON_PROP_TYPES: TBNodeType[] = ['context', 'action', 'summary', 'expression'];
		return allNodes.filter(n =>
			!NON_PROP_TYPES.includes(n.type) &&
			!n.folder.split('/').includes('raw') &&
			n.edges.filter(e => e.confirmed).length === 0
		).length;
	}

	// 특정 폴더 내 고립 명제 스캔 — salience 내림차순, 연결 후보도 같은 폴더에서
	async scanOrphanPropositions(folderPath: string): Promise<{ orphans: TBNode[]; candidates: TBNode[] }> {
		const allNodes = await this.loadNodesInFolder(folderPath);
		const NON_PROP_TYPES: TBNodeType[] = ['context', 'action', 'summary', 'expression'];
		const propositions = allNodes.filter(n =>
			!NON_PROP_TYPES.includes(n.type) &&
			!n.folder.split('/').includes('raw')
		);
		const orphans = propositions.filter(n => n.edges.filter(e => e.confirmed).length === 0);
		const candidates = propositions.filter(n => n.edges.filter(e => e.confirmed).length > 0);

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

		return {
			id: file.basename,
			title: fm.tb_title ?? file.basename,
			type: (fm.tb_type ?? 'claim') as TBNodeType,
			content: body,
			summary: typeof fm.tb_summary === 'string' ? fm.tb_summary : undefined,
			tags: Array.isArray(fm.tb_tags) ? fm.tb_tags : [],
			folder: file.parent?.path ?? '',
			created: fm.tb_created ?? new Date(file.stat.ctime).toISOString(),
			edges: Array.isArray(fm.tb_edges) ? fm.tb_edges : [],
			filePath: file.path,
			is_core_concept: fm.tb_is_core === true,
			proposition_type: fm.tb_proposition_type === 'fact' ? 'fact' : 'claim',
			block_id: typeof fm.tb_block_id === 'string' ? fm.tb_block_id : undefined,
			heading_path: typeof fm.tb_heading_path === 'string' ? fm.tb_heading_path : undefined,
			raw_path: typeof fm.tb_raw_path === 'string' ? fm.tb_raw_path : undefined,
		};
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
	): Promise<void> {
		if (items.length === 0) return;
		let content = await this.app.vault.read(rawFile);

		const paraEnd = (src: string, from: number): number => {
			const next = src.indexOf('\n\n', from);
			return next !== -1 ? next : src.length;
		};

		const insertions = new Map<number, string>();
		for (const { blockId, spanText } of items) {
			const trimmed = spanText.trim();
			if (!trimmed || !content.includes(trimmed)) continue;
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
	 * contextFileMap이 있으면 각 명제에 소속 문맥 노드로의 엣지를 추가한다.
	 * @returns propositionId → TFile 매핑
	 */
	async createPropositionBatch(
		propositions: Proposition[],
		logicEdges: LogicEdge[],
		contextTags: string[],
		sessionFolder: string,
		contextFileMap?: Map<string, TFile>,
		rawSourcePath?: string
	): Promise<Map<string, TFile>> {
		const now = new Date().toISOString();

		// 먼저 id → title 매핑 수집 (엣지 위키링크 생성에 필요) — / 포함 제목은 Obsidian이 경로로 해석하므로 반드시 정규화
		const titleMap = new Map<string, string>();
		for (const p of propositions) titleMap.set(p.id, cleanNodeTitle(p.title));

		const fileMap = new Map<string, TFile>();

		for (const p of propositions) {
			// Phase 1-7: source_span 밸리데이션 게이트 (user_synthesized 면제)
			const origin = (p as { origin?: string }).origin;
			if (origin !== 'user_synthesized') {
				const spanText = p.source_span?.text ?? '';
				if (spanText.trim().length === 0) {
					continue;
				}
			}

			// 논리 엣지 — confidence ≥ 0.75 필터 통과 = 파이프라인 승인, confirmed: true
			const outEdges: TBEdge[] = logicEdges
				.filter(e => e.source === p.id)
				.map(e => ({
					target: `[[${titleMap.get(e.target) ?? e.target}]]`,
					label: toRelation(e.relation),
					confirmed: true,
					reason: e.reason,
					confidence: typeof e.confidence === 'number' ? e.confidence : 1.0,
					axiom_basis: typeof e.axiom_basis === 'string' ? e.axiom_basis : '',
				}));

			// 소속 문맥 노드로의 엣지 (확정) — insight 노드는 교차 문맥이라 제외
			if (p.context && contextFileMap?.has(p.context)) {
				const ctxFile = contextFileMap.get(p.context)!;
				outEdges.push({
					target: `[[${ctxFile.basename}]]`,
					label: 'supports',
					confirmed: true,
					reason: `"${p.context}" 문맥에서 추출`,
					confidence: 1.0,
					axiom_basis: '파이프라인 자동 연결',
				});
			}

			try {
				const file = await this.createNode({
					id: sanitizeId(p.title),
					title: cleanNodeTitle(p.title),
					type: p.role,
					content: p.text,
					tags: contextTags,
					folder: sessionFolder,
					created: now,
					edges: outEdges,
					is_core_concept: p.is_core_concept === true,
					source_span: p.source_span,
					proposition_type: p.proposition_type,
					block_id: p.block_id,
					heading_path: p.heading_path,
					raw_path: rawSourcePath,
				}, rawSourcePath);
				fileMap.set(p.id, file);
			} catch {
				// 개별 노드 실패는 전체를 중단시키지 않음
			}
		}

		return fileMap;
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

	// 브리지 엣지 양방향 저장 (Phase 5)
	async saveBridgeEdges(
		bridgeEdges: BridgeEdge[],
		fileMapA: Map<string, TFile>,
		fileMapB: Map<string, TFile>
	): Promise<void> {
		for (const edge of bridgeEdges) {
			// title 우선, 없으면 filename fallback
			const srcFile = (edge.source_title && fileMapA.get(edge.source_title))
				?? fileMapA.get(edge.source_file);
			const tgtFile = (edge.target_title && fileMapB.get(edge.target_title))
				?? fileMapB.get(edge.target_file);

			const srcLabel = edge.source_title ?? edge.source_file.replace(/\.md$/, '');
			const tgtLabel = edge.target_title ?? edge.target_file.replace(/\.md$/, '');

			if (srcFile) {
				const edgeAtoB: TBEdge = {
					target: `[[${tgtLabel}]]`,
					label: toRelation(edge.relation),
					confirmed: true,
					reason: edge.reason,
					confidence: edge.confidence ?? 1.0,
					axiom_basis: '',
				};
				await this.app.fileManager.processFrontMatter(srcFile, (fm: TBFrontMatter) => {
					const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
					if (!edges.find(e => e.target === edgeAtoB.target)) edges.push(edgeAtoB);
					fm.tb_edges = edges;
				});
			}

			if (tgtFile) {
				const edgeBtoA: TBEdge = {
					target: `[[${srcLabel}]]`,
					label: toRelation(edge.relation),
					confirmed: true,
					reason: edge.reason,
					confidence: edge.confidence ?? 1.0,
					axiom_basis: '',
				};
				await this.app.fileManager.processFrontMatter(tgtFile, (fm: TBFrontMatter) => {
					const edges: TBEdge[] = Array.isArray(fm.tb_edges) ? fm.tb_edges : [];
					if (!edges.find(e => e.target === edgeBtoA.target)) edges.push(edgeBtoA);
					fm.tb_edges = edges;
				});
			}
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
			`tb_title: "${node.title.replace(/"/g, '\\"')}"`,
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
		if (node.heading_path) lines.push(`tb_heading_path: "${node.heading_path.replace(/"/g, '\\"')}"`);
		if (node.raw_path) lines.push(`tb_raw_path: "${node.raw_path.replace(/"/g, '\\"')}"`);
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

		// 동기 명제 → tb_edges (implements/investigates)
		const motivEdges = (node.motivation_ids ?? [])
			.map(id => propFileMap?.get(id))
			.filter((f): f is TFile => !!f)
			.map(f => ({
				target: `[[${f.basename}]]`,
				label: node.link_type ?? 'implements',
				confirmed: true,
				reason: '동기 명제',
				confidence: 1.0,
				axiom_basis: '파이프라인 자동 연결',
			}));

		const edgesJson = JSON.stringify(motivEdges);
		const linksStr = motivEdges.length > 0
			? '\n' + motivEdges.map(e => `  - "${e.target}"`).join('\n')
			: ' []';
		const motivCtxIds = JSON.stringify(node.motivation_context_ids ?? []);

		const frontmatter = [
			'---',
			`tb_id: "${node.id}"`,
			`tb_title: "${node.title.replace(/"/g, '\\"')}"`,
			`tb_type: action`,
			`tb_created: "${node.created}"`,
			`tb_tags: []`,
			`tb_links:${linksStr}`,
			`tb_edges: ${edgesJson}`,
			`tb_status: ${node.status}`,
			`tb_owner: "${(node.owner ?? '').replace(/"/g, '\\"')}"`,
			`tb_deadline: "${node.deadline ?? ''}"`,
			`tb_link_type: ${node.link_type}`,
			`tb_origin: ${node.origin}`,
			`tb_motivation_context_ids: ${motivCtxIds}`,
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
			motivation_ids:         Array.isArray(fm?.tb_action_motivation_ids) ? fm.tb_action_motivation_ids : [],
			motivation_context_ids: Array.isArray(fm?.tb_motivation_context_ids ?? fm?.tb_action_motivation_context_ids)
				? ((fm?.tb_motivation_context_ids ?? fm?.tb_action_motivation_context_ids) as string[])
				: [],
			link_type:    (fm?.tb_link_type ?? fm?.tb_action_link_type ?? 'implements') as ActionLinkType,
			origin:       (fm?.tb_origin ?? fm?.tb_action_origin ?? 'extracted') as 'extracted' | 'user' | 'from_resolution',
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
