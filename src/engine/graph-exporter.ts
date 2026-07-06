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
		const allNodes = allNodesByFolder.flat();

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

	private async collectEdges(store: GraphStore, nodes: TBNode[]): Promise<EdgeSummary[]> {
		const edges: EdgeSummary[] = [];
		// 위키링크 [[제목]] 형식으로 노드를 인덱싱
		const nodesByWikilink = new Map(nodes.map(n => [`[[${n.title}]]`, n]));

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
		md += `\n## Edges\n\n`;
		for (const edge of edges) {
			const sourceNode = nodes.find(n => n.id === edge.source);
			const targetNode = nodes.find(n => n.id === edge.target);
			const sourceTitle = sourceNode?.title ?? edge.source;
			const targetTitle = targetNode?.title ?? edge.target;
			const conf = `${(edge.confidence * 100).toFixed(0)}%`;
			md += `- **${sourceTitle}** \`${edge.relation}\` **${targetTitle}** (confidence: ${conf})\n`;
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
		const link = document.createElement('a');
		link.setAttribute('href', url);
		link.setAttribute('download', filename);
		link.className = 'tb-hidden-download-link';
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}
}
