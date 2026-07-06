import type { TBNode, SubgraphCache } from '../types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

// 반경 N 엣지 이내 서브그래프 BFS 격리
// 전체 노드 탐색 없이 회의 비서가 연산하도록 메모리 캐싱
export class SubgraphEngine {
	private cache = new Map<string, SubgraphCache>();

	// keyword 기준으로 반경 radius 이내 노드만 추출
	extract(allNodes: TBNode[], keyword: string, radius: number): TBNode[] {
		const cacheKey = `${keyword}:${radius}`;
		const cached = this.cache.get(cacheKey);

		if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
			return cached.nodes;
		}

		const seedNodes = this.findSeedNodes(allNodes, keyword);
		if (seedNodes.length === 0) return [];

		const nodeMap = new Map(allNodes.map(n => [n.id, n]));
		const visited = new Set<string>();
		const queue: Array<{ node: TBNode; depth: number }> = seedNodes.map(n => ({ node: n, depth: 0 }));

		while (queue.length > 0) {
			const { node, depth } = queue.shift()!;
			if (visited.has(node.id) || depth > radius) continue;
			visited.add(node.id);

			for (const edge of node.edges) {
				if (!edge.confirmed) continue; // 미확정 엣지는 서브그래프에서 제외
				const targetId = edge.target.replace(/\[\[(.+?)(?:\|.+?)?\]\]/, '$1');
				const target = nodeMap.get(targetId);
				if (target && !visited.has(target.id)) {
					queue.push({ node: target, depth: depth + 1 });
				}
			}
		}

		const result = allNodes.filter(n => visited.has(n.id));
		this.cache.set(cacheKey, { keyword, radius, nodes: result, cachedAt: Date.now() });
		return result;
	}

	invalidate(keyword?: string): void {
		if (keyword) {
			for (const key of this.cache.keys()) {
				if (key.startsWith(`${keyword}:`)) this.cache.delete(key);
			}
		} else {
			this.cache.clear();
		}
	}

	private findSeedNodes(nodes: TBNode[], keyword: string): TBNode[] {
		const kw = keyword.toLowerCase();
		return nodes.filter(n =>
			n.title.toLowerCase().includes(kw) ||
			n.tags.some(t => t.toLowerCase().includes(kw)) ||
			n.content.toLowerCase().includes(kw)
		);
	}
}
