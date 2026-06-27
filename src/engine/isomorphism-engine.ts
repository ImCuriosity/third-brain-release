// ============================================================
// ThirdBrain v2 — 위상 동형성 근사 엔진 (Phase 5)
// NP-Complete 완전 계산 금지. 특징 벡터 + 코사인 유사도 휴리스틱.
// ============================================================

import type { TBNode, TopologyFeatureVectorV2, IsomorphismCandidate } from '../types';
import { ALL_RELATIONS } from '../types';

// ── 특징 벡터 추출 ────────────────────────────────────────────

export function extractFeatureVectorV2(
	node: TBNode,
	allNodes: TBNode[]
): TopologyFeatureVectorV2 {
	const confirmed = node.edges.filter(e => e.confirmed);
	const outDegree = confirmed.length;

	// inDegree: 다른 노드에서 이 노드를 향하는 confirmed 엣지 수
	let inDegree = 0;
	const myId    = node.id;
	const myTitle = node.title;
	for (const n of allNodes) {
		if (n.id === myId) continue;
		for (const e of n.edges) {
			if (!e.confirmed) continue;
			const t = e.target.replace(/^\[\[|\]\]$/g, '');
			if (t === myId || t === myTitle) inDegree++;
		}
	}

	// clusteringCoeff: 이웃 노드들 사이의 실제 연결 / 가능한 최대 연결
	const neighborTitles = new Set(confirmed.map(e => e.target.replace(/^\[\[|\]\]$/g, '')));
	let neighborLinks = 0;
	for (const n of allNodes) {
		const nKey = n.title;
		if (!neighborTitles.has(nKey) && !neighborTitles.has(n.id)) continue;
		for (const e of n.edges) {
			if (!e.confirmed) continue;
			const t = e.target.replace(/^\[\[|\]\]$/g, '');
			if (neighborTitles.has(t)) neighborLinks++;
		}
	}
	const k = neighborTitles.size;
	const clusteringCoeff = k > 1 ? neighborLinks / (k * (k - 1)) : 0;

	// edgeTypeDistribution: 10축 분포 비율
	const dist = new Array(10).fill(0);
	for (const e of confirmed) {
		const idx = ALL_RELATIONS.indexOf(e.label);
		if (idx >= 0) dist[idx]++;
	}
	const total = confirmed.length;
	const edgeTypeDistribution = total > 0 ? dist.map(d => d / total) : dist;

	return {
		nodeId: node.id,
		inDegree,
		outDegree,
		clusteringCoeff,
		edgeTypeDistribution,
		isHub: node.is_core_concept === true,
	};
}

// ── 코사인 유사도 ──────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na  += a[i] * a[i];
		nb  += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

// TopologyFeatureVectorV2 → 정규화 배열 (14차원)
function toArray(v: TopologyFeatureVectorV2): number[] {
	return [
		Math.min(v.inDegree  / 20, 1),
		Math.min(v.outDegree / 20, 1),
		v.clusteringCoeff,
		v.isHub ? 1 : 0,
		...v.edgeTypeDistribution,  // 10차원
	];
}

// ── 서브그래프 비교 ────────────────────────────────────────────

/**
 * 두 폴더의 노드 간 구조적 유사도를 계산한다.
 * NP-Complete 완전 동형 탐지 금지 — 특징 벡터 코사인 근사만 사용.
 * @returns topK 쌍 (중복 없음, 유사도 내림차순)
 */
export function compareSubgraphs(
	folderANodes: TBNode[],
	folderBNodes: TBNode[],
	topK = 3
): IsomorphismCandidate[] {
	if (folderANodes.length === 0 || folderBNodes.length === 0) return [];

	const allNodes = [...folderANodes, ...folderBNodes];
	const vecsA = folderANodes.map(n => extractFeatureVectorV2(n, allNodes));
	const vecsB = folderBNodes.map(n => extractFeatureVectorV2(n, allNodes));

	type Pair = { ia: number; ib: number; sim: number };
	const pairs: Pair[] = [];

	for (let ia = 0; ia < vecsA.length; ia++) {
		for (let ib = 0; ib < vecsB.length; ib++) {
			const sim = cosineSim(toArray(vecsA[ia]), toArray(vecsB[ib]));
			pairs.push({ ia, ib, sim });
		}
	}

	pairs.sort((a, b) => b.sim - a.sim);

	const candidates: IsomorphismCandidate[] = [];
	const usedA = new Set<number>();
	const usedB = new Set<number>();

	for (const { ia, ib, sim } of pairs) {
		if (candidates.length >= topK) break;
		if (usedA.has(ia) || usedB.has(ib)) continue;
		usedA.add(ia); usedB.add(ib);

		const nA = folderANodes[ia];
		const nB = folderBNodes[ib];

		candidates.push({
			subgraphA:       [nA.id],
			subgraphB:       [nB.id],
			cosineSimilarity: sim,
			explanation:     `[${nA.type}] ${nA.title}  ↔  [${nB.type}] ${nB.title}`,
		});
	}

	return candidates;
}
