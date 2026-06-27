// ============================================================
// ThirdBrain v2 — 희소 인접 텐서 엔진
// T ∈ R^{N×N×10} — Warshall O(V³) 금지, 온더플라이 BFS O(V+E)
// ============================================================

import type {
	TBNode,
	TBEdgeRelation,
	SparseAdjacencyTensor,
	SparseEdgeEntry,
	GraphPath,
} from '../types';
import { ALL_RELATIONS, TRANSITIVE_RELATIONS } from '../types';

// 관계명 → 레이어 인덱스 (0~9)
const RELATION_INDEX = new Map<TBEdgeRelation, number>(
	ALL_RELATIONS.map((r, i) => [r, i] as [TBEdgeRelation, number])
);

// layerMasks 인코딩: from * MASK_STRIDE + to (최대 65535 노드 지원)
const MASK_STRIDE = 65536;

// ── 텐서 빌더 ────────────────────────────────────────────────

/**
 * TBNode[] → SparseAdjacencyTensor
 * confirmed=true 엣지만 포함, confidence 가중치 보존.
 */
export function buildTensor(nodes: TBNode[]): SparseAdjacencyTensor {
	const nodeIndex = new Map<string, number>();
	const indexNode: string[] = [];

	// 1-pass: 인덱스 구축 — id와 title 둘 다 같은 인덱스에 매핑
	const titleToIdx = new Map<string, number>();
	for (const node of nodes) {
		const idx = indexNode.length;
		nodeIndex.set(node.id, idx);
		indexNode.push(node.id);
		titleToIdx.set(node.title, idx);
		if (node.title !== node.id) {
			// title도 nodeIndex에 alias로 등록 (엣지 타겟 매핑용)
			nodeIndex.set(node.title, idx);
		}
	}

	const edges: SparseEdgeEntry[] = [];
	const layerMasks: Set<number>[] = ALL_RELATIONS.map(() => new Set<number>());

	// 2-pass: 엣지 구축
	for (const node of nodes) {
		const fromIdx = nodeIndex.get(node.id);
		if (fromIdx === undefined) continue;

		for (const edge of node.edges) {
			const rawTarget = edge.target.replace(/^\[\[|\]\]$/g, '');
			// id 직접 매핑 먼저, 없으면 title 매핑
			const toIdx = nodeIndex.get(rawTarget) ?? titleToIdx.get(rawTarget);
			if (toIdx === undefined) continue;

			const layerIdx = RELATION_INDEX.get(edge.label);
			if (layerIdx === undefined) continue;

			const maskKey = fromIdx * MASK_STRIDE + toIdx;
			if (!layerMasks[layerIdx].has(maskKey)) {
				edges.push({ from: fromIdx, to: toIdx, layerIdx, confidence: edge.confidence ?? 1.0 });
				layerMasks[layerIdx].add(maskKey);
			}
		}
	}

	return { nodeIndex, indexNode, edges, layerMasks, nodeCount: indexNode.length };
}

// ── 증분 업데이트 ────────────────────────────────────────────

/** 신규 노드 추가 — 전체 재빌드 없이 O(E_new) */
export function addNodeToTensor(tensor: SparseAdjacencyTensor, node: TBNode): void {
	let fromIdx = tensor.nodeIndex.get(node.id);
	if (fromIdx === undefined) {
		fromIdx = tensor.nodeCount;
		tensor.nodeIndex.set(node.id, fromIdx);
		tensor.nodeIndex.set(node.title, fromIdx); // title alias
		tensor.indexNode.push(node.id);
		tensor.nodeCount++;
	}
	_injectEdges(tensor, node.edges, fromIdx);
}

function _injectEdges(
	tensor: SparseAdjacencyTensor,
	edges: TBNode['edges'],
	fromIdx: number
): void {
	for (const edge of edges) {
		const rawTarget = edge.target.replace(/^\[\[|\]\]$/g, '');
		const toIdx = tensor.nodeIndex.get(rawTarget);
		if (toIdx === undefined) continue;
		const layerIdx = RELATION_INDEX.get(edge.label);
		if (layerIdx === undefined) continue;
		const maskKey = fromIdx * MASK_STRIDE + toIdx;
		if (!tensor.layerMasks[layerIdx].has(maskKey)) {
			tensor.edges.push({ from: fromIdx, to: toIdx, layerIdx, confidence: edge.confidence ?? 1.0 });
			tensor.layerMasks[layerIdx].add(maskKey);
		}
	}
}

// ── BFS 내부 유틸 ────────────────────────────────────────────

type AdjEntry = { to: number; rel: TBEdgeRelation; confidence: number };

function buildAdjList(
	tensor: SparseAdjacencyTensor,
	layerFilter?: TBEdgeRelation[]
): Map<number, AdjEntry[]> {
	const filterSet = layerFilter
		? new Set(layerFilter.map(r => RELATION_INDEX.get(r)).filter((v): v is number => v !== undefined))
		: null;

	const adj = new Map<number, AdjEntry[]>();
	for (const entry of tensor.edges) {
		if (filterSet && !filterSet.has(entry.layerIdx)) continue;
		let list = adj.get(entry.from);
		if (!list) { list = []; adj.set(entry.from, list); }
		list.push({ to: entry.to, rel: ALL_RELATIONS[entry.layerIdx], confidence: entry.confidence });
	}
	return adj;
}

// ── 공개 쿼리 API ────────────────────────────────────────────

/**
 * 출발 → 도착 최단 경로 BFS. O(V+E) per query.
 * @param layerFilter 탐색할 관계 축 필터 (생략 시 전체 10축)
 */
export function findPath(
	tensor: SparseAdjacencyTensor,
	srcId: string,
	dstId: string,
	maxHops: number,
	layerFilter?: TBEdgeRelation[]
): GraphPath | null {
	const srcIdx = tensor.nodeIndex.get(srcId);
	const dstIdx = tensor.nodeIndex.get(dstId);
	if (srcIdx === undefined || dstIdx === undefined) return null;
	if (srcIdx === dstIdx) {
		return { nodes: [srcId], relations: [], totalConfidence: 1.0, isTransitive: false };
	}

	const adj = buildAdjList(tensor, layerFilter);

	type State = { idx: number; path: number[]; rels: TBEdgeRelation[]; conf: number };
	const queue: State[] = [{ idx: srcIdx, path: [srcIdx], rels: [], conf: 1.0 }];
	const visited = new Set<number>([srcIdx]);

	while (queue.length > 0) {
		const { idx, path, rels, conf } = queue.shift()!;
		if (path.length - 1 >= maxHops) continue;

		for (const { to, rel, confidence } of (adj.get(idx) ?? [])) {
			if (visited.has(to)) continue;
			const newConf = conf * confidence;
			const newPath = [...path, to];
			const newRels = [...rels, rel];

			if (to === dstIdx) {
				return {
					nodes: newPath.map(i => tensor.indexNode[i]),
					relations: newRels,
					totalConfidence: newConf,
					isTransitive: false,
				};
			}

			visited.add(to);
			queue.push({ idx: to, path: newPath, rels: newRels, conf: newConf });
		}
	}

	return null;
}

/**
 * 출발 노드에서 maxHops 이내 도달 가능한 nodeId 집합. O(V+E).
 */
export function reachableFrom(
	tensor: SparseAdjacencyTensor,
	srcId: string,
	maxHops: number,
	layerFilter?: TBEdgeRelation[]
): Set<string> {
	const srcIdx = tensor.nodeIndex.get(srcId);
	if (srcIdx === undefined) return new Set();

	const adj = buildAdjList(tensor, layerFilter);
	const visited = new Set<number>([srcIdx]);
	const queue: Array<{ idx: number; hops: number }> = [{ idx: srcIdx, hops: 0 }];

	while (queue.length > 0) {
		const { idx, hops } = queue.shift()!;
		if (hops >= maxHops) continue;
		for (const { to } of (adj.get(idx) ?? [])) {
			if (!visited.has(to)) {
				visited.add(to);
				queue.push({ idx: to, hops: hops + 1 });
			}
		}
	}

	visited.delete(srcIdx);
	return new Set([...visited].map(i => tensor.indexNode[i]));
}

/**
 * 추이성 경로 탐색 — causes/precedes 레이어만 (Axis 1).
 * 직접 엣지가 아닌 2홉 이상의 간접 체인만 반환.
 * 볼트에 저장하지 않음 — 읽기 전용 추론 레이어.
 */
export function findTransitivePaths(
	tensor: SparseAdjacencyTensor,
	srcId: string,
	dstId: string,
	maxHops = 6
): GraphPath[] {
	const transitiveFilter = [...TRANSITIVE_RELATIONS] as TBEdgeRelation[];
	const path = findPath(tensor, srcId, dstId, maxHops, transitiveFilter);

	// 직접 엣지(1홉)는 추이 추론이 아님
	if (!path || path.nodes.length <= 2) return [];

	// 직접 엣지가 없는 경우에만 추이 경로로 마킹
	const directLayerFilter = transitiveFilter;
	const isDirect = _hasDirectEdge(tensor, srcId, dstId, directLayerFilter);
	if (isDirect) return [];

	return [{ ...path, isTransitive: true }];
}

function _hasDirectEdge(
	tensor: SparseAdjacencyTensor,
	srcId: string,
	dstId: string,
	layerFilter: TBEdgeRelation[]
): boolean {
	const srcIdx = tensor.nodeIndex.get(srcId);
	const dstIdx = tensor.nodeIndex.get(dstId);
	if (srcIdx === undefined || dstIdx === undefined) return false;

	for (const rel of layerFilter) {
		const layerIdx = RELATION_INDEX.get(rel);
		if (layerIdx === undefined) continue;
		if (tensor.layerMasks[layerIdx].has(srcIdx * MASK_STRIDE + dstIdx)) return true;
	}
	return false;
}
