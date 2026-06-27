import { App, TFile, normalizePath } from 'obsidian';
import { toRelation } from '../types';
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
	SourceSpan,
	ActionNode,
	ActionStatus,
} from '../types';

export class GraphStore {
	constructor(private app: App, private settings: ThirdBrainSettings) {}

	// vault에서 모든 ThirdBrain 노드 로드
	async loadAllNodes(): Promise<TBNode[]> {
		const folder = this.app.vault.getFolderByPath(this.settings.nodeFolder);
		if (!folder) return [];

		const nodes: TBNode[] = [];
		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== 'md') continue;
			const node = await this.fileToNode(child);
			if (node) nodes.push(node);
		}
		return nodes;
	}

	// 특정 폴더 내 노드만 로드 — 서브폴더 재귀 탐색, 루트('')도 지원
	async loadNodesInFolder(folderPath: string): Promise<TBNode[]> {
		const nodes: TBNode[] = [];
		await this.collectNodes(folderPath || '/', nodes);
		return nodes;
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

		const fm = cache.frontmatter;
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
		};
	}

	// 새 노드 .md 파일을 vault에 생성
	// node.folder = 절대 vault 경로 (비어있으면 settings.nodeFolder 사용)
	async createNode(node: Omit<TBNode, 'filePath'>): Promise<TFile> {
		// node.folder가 비면 폴더 없이 볼트 루트에 저장 (ThirdBrain 폴백 없음)
		const folderPath = node.folder ? normalizePath(node.folder) : '';
		if (folderPath) await this.ensureFolder(folderPath);

		const rawTitle = node.title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
		const safeTitle = rawTitle || node.id.replace(/[\\/:*?"<>|#^[\]]/g, '-').slice(0, 50) || 'untitled';
		const filePath = folderPath
			? normalizePath(`${folderPath}/${safeTitle}.md`)
			: `${safeTitle}.md`;
		const finalPath = await this.resolveConflict(filePath);

		const content = `${this.buildFrontmatter(node)}\n\n${node.content}`;
		return this.app.vault.create(finalPath, content);
	}

	/** 문맥 레이어 배치 생성 — 각 ContextLayer를 summary 타입 노드로 저장 */
	async createContextBatch(
		contexts: ContextLayer[],
		sessionFolder: string
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
					type: 'context' as TBNodeType,
					content: ctx.summary,
					tags: ctx.keywords.slice(0, 5),
					folder: sessionFolder,
					created: ctx.date || now,
					edges: [],
				});
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
		contextFileMap?: Map<string, TFile>
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

			// 논리 엣지 (미확정) — confidence/axiom_basis 전파
			const outEdges: TBEdge[] = logicEdges
				.filter(e => e.source === p.id)
				.map(e => ({
					target: `[[${titleMap.get(e.target) ?? e.target}]]`,
					label: toRelation(e.relation),
					confirmed: false,
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
					type: p.role as TBNodeType,
					content: p.text,
					tags: contextTags,
					folder: sessionFolder,
					created: now,
					edges: outEdges,
					is_core_concept: p.is_core_concept === true,
					source_span: p.source_span,
				});
				fileMap.set(p.id, file);
			} catch {
				// 개별 노드 실패는 전체를 중단시키지 않음
			}
		}

		return fileMap;
	}

	// 유저가 칩 확정 → 프론트매터에 엣지 주입 (2.5차 큐레이션 완료)
	async confirmEdge(sourceFile: TFile, edge: TBEdge): Promise<void> {
		await this.app.fileManager.processFrontMatter(sourceFile, (fm) => {
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
				await this.app.fileManager.processFrontMatter(srcFile, (fm) => {
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
				await this.app.fileManager.processFrontMatter(tgtFile, (fm) => {
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
		await this.app.fileManager.processFrontMatter(movedFile, (fm) => {
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
		parentFolder: string
	): Promise<TFile> {
		const folder = parentFolder
			? normalizePath(`${parentFolder}/_actions`)
			: '_actions';
		await this.ensureFolder(folder);

		const safeTitle = sanitizeId(node.title) || node.id.slice(0, 50) || 'action-untitled';
		let filePath = normalizePath(`${folder}/${safeTitle}.md`);
		filePath = await this.resolveConflict(filePath);

		const motivIds = JSON.stringify(node.motivation_ids ?? []);
		const motivCtxIds = JSON.stringify(node.motivation_context_ids ?? []);
		const frontmatter = [
			'---',
			`tb_action_id: "${node.id}"`,
			`tb_action_title: "${node.title.replace(/"/g, '\\"')}"`,
			`tb_action_status: ${node.status}`,
			`tb_action_owner: "${(node.owner ?? '').replace(/"/g, '\\"')}"`,
			`tb_action_deadline: "${node.deadline ?? ''}"`,
			`tb_action_link_type: ${node.link_type}`,
			`tb_action_origin: ${node.origin}`,
			`tb_action_motivation_ids: ${motivIds}`,
			`tb_action_motivation_context_ids: ${motivCtxIds}`,
			`tb_action_created: "${node.created}"`,
			'---',
		].join('\n');

		const content = `${frontmatter}\n\n${node.content}`;
		return this.app.vault.create(filePath, content);
	}

	/** ActionNode 상태만 업데이트 */
	async updateActionStatus(file: TFile, status: ActionStatus): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, fm => {
			fm.tb_action_status = status;
		});
	}

	/** ActionNode owner / deadline 업데이트 */
	async updateActionMeta(file: TFile, owner: string, deadline: string): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, fm => {
			fm.tb_action_owner    = owner;
			fm.tb_action_deadline = deadline;
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
		const fm = cache?.frontmatter;
		if (!fm?.tb_action_id) return null;

		return {
			id:             String(fm.tb_action_id ?? ''),
			title:          String(fm.tb_action_title ?? file.basename),
			content:        await this.readBodyAfterFrontmatter(file),
			owner:          String(fm.tb_action_owner ?? ''),
			deadline:       String(fm.tb_action_deadline ?? ''),
			status:         (fm.tb_action_status as ActionStatus) ?? 'pending',
			motivation_ids:         Array.isArray(fm.tb_action_motivation_ids) ? fm.tb_action_motivation_ids : [],
			motivation_context_ids: Array.isArray(fm.tb_action_motivation_context_ids) ? fm.tb_action_motivation_context_ids : [],
			link_type:      fm.tb_action_link_type ?? 'implements',
			origin:         fm.tb_action_origin ?? 'extracted',
			created:        String(fm.tb_action_created ?? ''),
			filePath:       file.path,
		};
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
