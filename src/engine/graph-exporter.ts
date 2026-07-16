import type { TBNode } from '../types';
import type { GraphStore } from './graph-store';

export interface ExportOptions {
	includeSourceText: boolean;
	includeMetadata: boolean;
	maxTextLength?: number;
}

interface NodeSummary {
	id: string;
	title: string;
	type: string;
	content?: string;
	tags?: string[];
}

interface EdgeSummary {
	source: string;
	target: string;
	relation: string;
	confidence: number;
	confirmed: boolean;
}

export class GraphExporter {
	async exportFolderGraph(
		folders: string[],
		store: GraphStore,
		options: ExportOptions,
	): Promise<string> {
		// 폴더에서 모든 노드 로드
		const allNodesByFolder = await Promise.all(
			folders.map(f => store.loadNodesInFolder(f)),
		);
		// 선택 폴더에 부모와 하위(_actions)가 함께 들어오면 재귀 로드로 노드가 중복된다 → id로 dedupe
		const seenNodeIds = new Set<string>();
		const allNodes = allNodesByFolder.flat().filter(n => {
			if (seenNodeIds.has(n.id)) return false;
			seenNodeIds.add(n.id);
			return true;
		});

		if (allNodes.length === 0) {
			return this.buildEmptyExport(folders);
		}

		// 노드별 엣지 수집
		const edges = await this.collectEdges(store, allNodes);

		// 통계 계산
		const stats = {
			totalNodes: allNodes.length,
			totalEdges: edges.length,
			density: allNodes.length > 1 ? edges.length / (allNodes.length * (allNodes.length - 1)) : 0,
			nodeTypes: this.countByType(allNodes),
			edgeTypes: this.countByRelation(edges),
		};

		// 마크다운 부분 생성
		const markdownPart = this.buildMarkdown(folders, stats, allNodes, edges, options);

		// JSON 부분 생성
		const jsonPart = this.buildJson(allNodes, edges, options, stats);

		return `${markdownPart}\n\n---\n\n## Full Data (JSON)\n\`\`\`json\n${JSON.stringify(jsonPart, null, 2)}\n\`\`\``;
	}

	/**
	 * [작업대] LLM 그라운딩용 마크다운-only 직렬화 (JSON 파트 없음).
	 * 이미 로드된 노드를 받으므로 질문별 retrieval로 축소된 서브셋도 그대로 직렬화할 수 있다.
	 */
	async exportForGrounding(
		label: string,
		nodes: TBNode[],
		store: GraphStore,
		options: ExportOptions,
	): Promise<string> {
		if (nodes.length === 0) return `# Graph: ${label}\n(노드 없음)`;
		const edges = await this.collectEdges(store, nodes);
		const stats = {
			totalNodes: nodes.length,
			totalEdges: edges.length,
			density: nodes.length > 1 ? edges.length / (nodes.length * (nodes.length - 1)) : 0,
			nodeTypes: this.countByType(nodes),
			edgeTypes: this.countByRelation(edges),
		};
		return this.buildMarkdown([label], stats, nodes, edges, options);
	}

	private async collectEdges(store: GraphStore, nodes: TBNode[]): Promise<EdgeSummary[]> {
		const edges: EdgeSummary[] = [];
		// Obsidian은 wikilink를 파일명(basename = id)으로 resolve → title이 아닌 id로 인덱싱해야
		// 같은 title의 두 노드(커넥터 기능 / 커넥터 기능-2)가 있을 때 Map이 덮어쓰이는 self-loop 버그 방지
		const nodesByWikilink = new Map(nodes.map(n => [`[[${n.id}]]`, n]));

		for (const node of nodes) {
			if (!node.edges) continue;

			for (const edge of node.edges) {
				// 위키링크로 대상 노드 찾기
				const targetNode = nodesByWikilink.get(edge.target);
				if (targetNode) {
					edges.push({
						source: node.id,
						target: targetNode.id,
						relation: edge.label,
						confidence: edge.confidence,
						confirmed: edge.confirmed,
					});
				}
			}
		}

		return edges;
	}

	private countByType(nodes: TBNode[]): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const node of nodes) {
			counts[node.type] = (counts[node.type] ?? 0) + 1;
		}
		return counts;
	}

	private countByRelation(edges: EdgeSummary[]): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const edge of edges) {
			counts[edge.relation] = (counts[edge.relation] ?? 0) + 1;
		}
		return counts;
	}

	private buildMarkdown(
		folders: string[],
		stats: { totalNodes: number; totalEdges: number; density: number; nodeTypes: Record<string, number>; edgeTypes: Record<string, number> },
		nodes: TBNode[],
		edges: EdgeSummary[],
		options: ExportOptions,
	): string {
		const timestamp = new Date().toISOString().split('T')[0];
		const folderStr = folders.join(', ');

		let md = `# Graph Export: ${folderStr}\n`;
		md += `**Generated:** ${timestamp}\n\n`;

		// 통계
		md += `## Statistics\n`;
		md += `- **Total Nodes:** ${stats.totalNodes}\n`;
		md += `- **Total Edges:** ${stats.totalEdges}\n`;
		md += `- **Density:** ${(stats.density * 100).toFixed(2)}%\n`;

		// 노드 타입 분포
		md += `\n### Node Types\n`;
		for (const [type, count] of Object.entries(stats.nodeTypes)) {
			md += `- ${type}: ${count}\n`;
		}

		// 엣지 관계 분포
		md += `\n### Edge Relations\n`;
		for (const [relation, count] of Object.entries(stats.edgeTypes)) {
			md += `- ${relation}: ${count}\n`;
		}

		// 토픽 멤버십 (tb_topic — 논리 엣지가 아닌 소속 필드) [Phase 2]
		md += `\n## Topics (membership)\n`;
		const byTopic = new Map<string, TBNode[]>();
		const noTopic: TBNode[] = [];
		for (const n of nodes) {
			if (n.type === 'context') continue; // 토픽 노드 자신은 제외
			if (n.type === 'action') continue;  // 액션은 아래 Action Links 섹션에서 별도 처리
			if (n.type === 'problem') continue; // 문제는 아래 Problems 섹션에서 별도 처리
			if (n.topic) {
				if (!byTopic.has(n.topic)) byTopic.set(n.topic, []);
				byTopic.get(n.topic)!.push(n);
			} else {
				noTopic.push(n);
			}
		}
		const topicTitle = (id: string): string => nodes.find(t => t.id === id)?.title ?? id;
		for (const [topicId, members] of byTopic) {
			md += `\n### ${topicTitle(topicId)} (${members.length})\n`;
			for (const m of members) md += `- ${m.title}\n`;
		}
		if (noTopic.length > 0) {
			md += `\n### (미배정/고립) (${noTopic.length})\n`;
			for (const m of noTopic) md += `- ${m.title}\n`;
		}

		// 액션 링크 (tb_action_motivation_ids — 논리 엣지가 아닌 액션→동기명제 provenance) [Phase 9]
		const actionNodes = nodes.filter(n => n.type === 'action');
		if (actionNodes.length > 0) {
			const titleById = new Map(nodes.map(n => [n.id, n.title]));
			md += `\n## Action Links (provenance)\n`;
			for (const a of actionNodes) {
				const motiv = (a.motivation_ids ?? []).map(id => titleById.get(id) ?? id);
				md += `- **${a.title}**\n`;
				if (motiv.length > 0) md += `  ← ${a.link_type ?? 'implements'}: ${motiv.join(', ')}\n`;
			}
		}

		// 문제 레이어 (tb_problem_* — 명제 간 긴장, 해결까지 지속) [Phase 10]
		const problemNodes = nodes.filter(n => n.type === 'problem');
		if (problemNodes.length > 0) {
			const nodeById = new Map(nodes.map(n => [n.id, n]));
			md += `\n## Problems\n`;
			for (const p of problemNodes) {
				const status = p.problem_status ?? 'open';
				md += `- [${status === 'resolved' ? 'x' : ' '}] **${p.title}** (${p.problem_species ?? '?'})\n`;
				// 근거는 제목만으로는 문제 성립 여부를 판단할 수 없으므로 명제문 + 원문 블록 링크를 함께 기재
				for (const id of p.evidence_ids ?? []) {
					const n = nodeById.get(id);
					if (!n) { md += `  - ${id}\n`; continue; }
					const claim = (n.content?.split('\n---\n')[0] ?? '').trim().replace(/\s+/g, ' ');
					const anchor = n.raw_path
						? ` ([[${n.raw_path}${n.block_id ? `#^${n.block_id}` : ''}|원문]])`
						: '';
					md += `  - **${n.title}**${claim ? ` — ${claim}` : ''}${anchor}\n`;
				}
				if (p.resolution_note) md += `  해소: ${p.resolution_note}\n`;
			}
		}

		// 노드 목록
		md += `\n## Nodes\n\n`;
		for (const node of nodes) {
			const content = options.includeSourceText && node.content
				? `\n  **Content:** ${this.truncateText(node.content, options.maxTextLength)}`
				: '';
			const tags = options.includeMetadata && node.tags
				? `\n  **Tags:** ${node.tags.join(', ')}`
				: '';
			md += `- **${node.title}** (${node.type}, id: \`${node.id}\`)${content}${tags}\n`;
		}

		// 엣지 목록 (관계도)
		// 제목이 중복되는 노드가 있으면 (충돌 해결로 -2 접미사가 붙은 경우) 라벨에 id를 병기해
		// 서로 다른 노드가 self-loop처럼 표시되는 것을 방지한다.
		const titleCounts = new Map<string, number>();
		for (const n of nodes) titleCounts.set(n.title, (titleCounts.get(n.title) ?? 0) + 1);
		const labelOf = (id: string): string => {
			const node = nodes.find(n => n.id === id);
			if (!node) return id;
			// 같은 제목 노드가 둘 이상이면 id를 병기해 구분
			return (titleCounts.get(node.title) ?? 0) > 1 ? `${node.title} (${node.id})` : node.title;
		};

		md += `\n## Edges\n\n`;
		for (const edge of edges) {
			const conf = `${(edge.confidence * 100).toFixed(0)}%`;
			md += `- **${labelOf(edge.source)}** \`${edge.relation}\` **${labelOf(edge.target)}** (confidence: ${conf})\n`;
		}

		return md;
	}

	private buildJson(
		nodes: TBNode[],
		edges: EdgeSummary[],
		options: ExportOptions,
		stats: { totalNodes: number; totalEdges: number; density: number; nodeTypes: Record<string, number>; edgeTypes: Record<string, number> },
	): { metadata: object; nodes: NodeSummary[]; edges: EdgeSummary[] } {
		const nodeSummaries: NodeSummary[] = nodes.map(n => {
			const summary: NodeSummary = {
				id: n.id,
				title: n.title,
				type: n.type,
			};
			if (options.includeSourceText && n.content) {
				summary.content = this.truncateText(n.content, options.maxTextLength);
			}
			if (options.includeMetadata && n.tags?.length) {
				summary.tags = n.tags;
			}
			return summary;
		});

		return {
			metadata: {
				exportDate: new Date().toISOString(),
				version: '1.0',
				options: {
					includeSourceText: options.includeSourceText,
					includeMetadata: options.includeMetadata,
					maxTextLength: options.maxTextLength,
				},
				stats,
			},
			nodes: nodeSummaries,
			edges,
		};
	}

	private truncateText(text: string, maxLength?: number): string {
		if (!maxLength) return text;
		if (text.length <= maxLength) return text;
		return text.substring(0, maxLength) + '…';
	}

	private buildEmptyExport(folders: string[]): string {
		const timestamp = new Date().toISOString().split('T')[0];
		const folderStr = folders.join(', ');

		return `# Graph Export: ${folderStr}
**Generated:** ${timestamp}

## ⚠️ No Data

Selected folders contain no nodes.

---

## Full Data (JSON)
\`\`\`json
{
  "metadata": {
    "exportDate": "${new Date().toISOString()}",
    "version": "1.0",
    "warning": "No nodes in selected folders"
  },
  "nodes": [],
  "edges": []
}
\`\`\``;
	}

	static downloadFile(content: string, filename: string): void {
		const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		// activeDocument 기준으로 생성해야 팝아웃 창에서도 올바른 문서에 붙는다
		const link = activeDocument.body.createEl('a', {
			cls: 'tb-hidden-download-link',
			attr: { href: url, download: filename },
		});
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	}
}
