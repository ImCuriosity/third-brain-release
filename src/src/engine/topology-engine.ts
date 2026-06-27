import type {
	TBNode,
	TBEdgeRelation,
	TopologyFeatureVector,
	BridgeCandidatePair,
	TopologyFilterConfig,
	NodeSalienceScore,
} from '../types';

// ── 상수 ──────────────────────────────────────────────────

const TYPE_WEIGHT_MAP: Record<string, number> = {
	insight: 1.0,
	claim: 0.9,
	core: 0.9,
	conclusion: 0.75,
	premise: 0.7,
	example: 0.55,
	contrast: 0.55,
	application: 0.55,
	action: 0.4,
};

const BRIDGE_COMPATIBLE_RELATIONS: TBEdgeRelation[] = [
	'isomorphic_to',
	'analogous_to',
	'applies_to',
	'supports',
	'causes',
];

// ── 공개 함수 ──────────────────────────────────────────────

/** 단일 노드의 토폴로지 특징 벡터 계산 */
export function computeFeatureVector(node: TBNode): TopologyFeatureVector {
	const degree = node.edges.filter(e => e.confirmed).length;
	const coreness = node.is_core_concept ? 1 : 0;
	const typeWeight = TYPE_WEIGHT_MAP[node.type] ?? 0.5;
	const tagFingerprint = node.tags
		.map(t => t.toLowerCase().trim())
		.filter(t => t.length > 0)
		.sort();
	const outRelations = node.edges
		.filter(e => e.confirmed)
		.map(e => e.label);

	return {
		degree,
		coreness,
		typeWeight,
		tagFingerprint,
		outRelations,
	};
}

/** 노드 배열 전체에 대한 특징 벡터 맵 계산 */
export function buildFeatureMap(
	nodes: TBNode[]
): Map<string, TopologyFeatureVector> {
	const map = new Map<string, TopologyFeatureVector>();
	for (const node of nodes) {
		map.set(node.id, computeFeatureVector(node));
	}
	return map;
}

/** 두 특징 벡터 사이의 위상 유사도 점수 계산 (0.0 ~ 1.0) */
export function scorePair(
	vecA: TopologyFeatureVector,
	vecB: TopologyFeatureVector
): {
	score: number;
	breakdown: {
		tagOverlap: number;
		typeAffinity: number;
		relationalPattern: number;
		coreness: number;
	};
} {
	// tagOverlap: Jaccard similarity
	const tagOverlap = jaccardSimilarity(vecA.tagFingerprint, vecB.tagFingerprint);

	// typeAffinity: 가중치 근접성
	const typeAffinity = 1.0 - Math.abs(vecA.typeWeight - vecB.typeWeight);

	// relationalPattern: bridge-compatible 관계 공유도
	const aRelSet = new Set(vecA.outRelations.filter(r =>
		BRIDGE_COMPATIBLE_RELATIONS.includes(r)
	));
	const bRelSet = new Set(vecB.outRelations.filter(r =>
		BRIDGE_COMPATIBLE_RELATIONS.includes(r)
	));
	const sharedRelCount = aRelSet.size + bRelSet.size;
	const relationalPattern = Math.min(sharedRelCount / 4, 1.0);

	// coreness: 핵심 개념 여부 평균
	const coreness = (vecA.coreness + vecB.coreness) / 2;

	// 가중 합산
	const score =
		0.35 * tagOverlap +
		0.25 * typeAffinity +
		0.25 * relationalPattern +
		0.15 * coreness;

	const breakdown = {
		tagOverlap,
		typeAffinity,
		relationalPattern,
		coreness,
	};

	return { score, breakdown };
}

/** 두 폴더의 TBNode[]를 받아 상위 후보 쌍 목록 반환 */
export function filterCandidatePairs(
	nodesA: TBNode[],
	nodesB: TBNode[],
	config: TopologyFilterConfig
): BridgeCandidatePair[] {
	// 특징 벡터 맵 생성
	const mapA = buildFeatureMap(nodesA);
	const mapB = buildFeatureMap(nodesB);

	// 모든 (A, B) 쌍 스코어링
	const allPairs: BridgeCandidatePair[] = [];
	for (const nodeA of nodesA) {
		for (const nodeB of nodesB) {
			const vecA = mapA.get(nodeA.id)!;
			const vecB = mapB.get(nodeB.id)!;
			const { score, breakdown } = scorePair(vecA, vecB);

			if (score >= config.minScore) {
				allPairs.push({
					nodeA,
					nodeB,
					score,
					scoreBreakdown: breakdown,
				});
			}
		}
	}

	// nodeA 각 노드별로 상위 topKPerNode개 유지 (다양성 보장)
	const perNodeMap = new Map<string, BridgeCandidatePair[]>();
	for (const pair of allPairs) {
		const key = pair.nodeA.id;
		if (!perNodeMap.has(key)) {
			perNodeMap.set(key, []);
		}
		perNodeMap.get(key)!.push(pair);
	}

	const diversePairs: BridgeCandidatePair[] = [];
	for (const pairs of perNodeMap.values()) {
		// 점수 기준 내림차순 정렬
		pairs.sort((a, b) => b.score - a.score);
		// 상위 topKPerNode개 추가
		diversePairs.push(...pairs.slice(0, config.topKPerNode));
	}

	// 전체 score 기준 내림차순 정렬
	diversePairs.sort((a, b) => b.score - a.score);

	// 상위 maxCandidatePairs개 반환
	return diversePairs.slice(0, config.maxCandidatePairs);
}

/** BridgeCandidatePair[] → LLM 프롬프트용 압축 텍스트 생성 */
export function formatCandidatesForPrompt(
	pairs: BridgeCandidatePair[],
	folderAName: string,
	folderBName: string
): string {
	const lines: string[] = [
		'[후보 쌍 목록 — 위상학적 유사도 기준 선별]',
		`폴더 A: ${folderAName}  폴더 B: ${folderBName}`,
		'',
	];

	for (let i = 0; i < pairs.length; i++) {
		const pair = pairs[i];
		const scorePercent = (pair.score * 100).toFixed(0);

		lines.push(`쌍 ${i + 1} (점수: ${scorePercent}%):`);
		lines.push(`  A: [${pair.nodeA.type}] ${pair.nodeA.title}`);
		lines.push(`     ${pair.nodeA.content.slice(0, 200).replace(/\n/g, ' ')}${pair.nodeA.tags.length ? ` (태그: ${pair.nodeA.tags.slice(0, 4).join(', ')})` : ''}`);
		lines.push(`  B: [${pair.nodeB.type}] ${pair.nodeB.title}`);
		lines.push(`     ${pair.nodeB.content.slice(0, 200).replace(/\n/g, ' ')}${pair.nodeB.tags.length ? ` (태그: ${pair.nodeB.tags.slice(0, 4).join(', ')})` : ''}`);

		// 위상 힌트
		const hints: string[] = [];
		if (pair.scoreBreakdown.tagOverlap > 0) {
			const commonTags = intersection(
				pair.nodeA.tags.map(t => t.toLowerCase()),
				pair.nodeB.tags.map(t => t.toLowerCase())
			);
			if (commonTags.length > 0) {
				hints.push(`공통 태그=[${commonTags.join(', ')}]`);
			}
		}
		if (pair.scoreBreakdown.relationalPattern > 0) {
			const aRels = pair.nodeA.edges
				.filter(
					e =>
						e.confirmed &&
						BRIDGE_COMPATIBLE_RELATIONS.includes(e.label)
				)
				.map(e => e.label);
			const bRels = pair.nodeB.edges
				.filter(
					e =>
						e.confirmed &&
						BRIDGE_COMPATIBLE_RELATIONS.includes(e.label)
				)
				.map(e => e.label);
			if (aRels.length > 0 || bRels.length > 0) {
				hints.push(`A관계=[${aRels.join(', ')}], B관계=[${bRels.join(', ')}]`);
			}
		}
		if (hints.length > 0) {
			lines.push(`  위상 힌트: ${hints.join('; ')}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

// ── v2: NodeSalience 이중 트랙 (Phase 7) ────────────────────

/**
 * Jaccard 비유사도 (1 - 유사도).
 * 대상 노드의 태그가 기존 연결 노드 태그 합집합과 겹칠수록 낮아진다.
 * 고립 노드에만 적용 (connected 노드는 structuralCentrality 사용).
 */
export function computeSemanticNovelty(
	node: TBNode,
	connectedTagUnion: Set<string>
): number {
	const tags = new Set(node.tags.map(t => t.toLowerCase().trim()).filter(Boolean));
	if (tags.size === 0) return 0.5;
	if (connectedTagUnion.size === 0) return 1.0;

	const intersection = [...tags].filter(t => connectedTagUnion.has(t)).length;
	const union = new Set([...tags, ...connectedTagUnion]).size;
	return 1 - intersection / union;
}

/**
 * 이중 트랙 중요도 점수.
 * connected: typeWeight × 0.4 + structuralCentrality × 0.6
 * orphan:    typeWeight × 0.5 + semanticNovelty × 0.5
 * 시간 기반 가중치 없음 (소프트 망각 금지).
 */
export function computeNodeSalience(
	node: TBNode,
	allNodes: TBNode[]
): NodeSalienceScore {
	const degree = node.edges.filter(e => e.confirmed).length;
	const isOrphan = degree === 0;
	const typeWeight = TYPE_WEIGHT_MAP[node.type] ?? 0.7;

	let structuralCentrality = 0;
	let semanticNovelty = 0;

	if (!isOrphan) {
		const coreness = node.is_core_concept ? 1 : 0;
		structuralCentrality = 0.7 * Math.min(degree / 10, 1) + 0.3 * coreness;
	} else {
		const connectedTagUnion = new Set<string>();
		for (const n of allNodes) {
			if (n.id === node.id) continue;
			if (n.edges.filter(e => e.confirmed).length > 0) {
				n.tags.forEach(t => connectedTagUnion.add(t.toLowerCase().trim()));
			}
		}
		semanticNovelty = computeSemanticNovelty(node, connectedTagUnion);
	}

	const composite = isOrphan
		? typeWeight * 0.5 + semanticNovelty * 0.5
		: typeWeight * 0.4 + structuralCentrality * 0.6;

	return { nodeId: node.id, structuralCentrality, semanticNovelty, typeWeight, composite, isOrphan };
}

// ── 내부 헬퍼 함수 ────────────────────────────────────────

function jaccardSimilarity(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) return 0;

	const setA = new Set(a);
	const setB = new Set(b);

	const intersection = [...setA].filter(x => setB.has(x)).length;
	const union = new Set([...a, ...b]).size;

	return union === 0 ? 0 : intersection / union;
}

function intersection(a: string[], b: string[]): string[] {
	const setB = new Set(b);
	return [...new Set(a)].filter(x => setB.has(x));
}
