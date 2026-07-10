// ============================================================
// ThirdBrain v2 — 모순 감지 엔진 (Phase 2)
// conflicts_with 엣지 스캔 → ConflictReport[] 생성
// ============================================================

import type { TBNode, ConflictReport } from '../types';

/**
 * 노드 배열에서 conflicts_with 엣지를 스캔하여 ConflictReport를 생성한다.
 * 동일한 쌍 중복 제거 (A↔B = B↔A).
 */
export function detectConflicts(nodes: TBNode[]): ConflictReport[] {
	const nodeById  = new Map(nodes.map(n => [n.id,    n]));
	const nodeByTitle = new Map(nodes.map(n => [n.title, n]));

	const reports: ConflictReport[] = [];
	const seen = new Set<string>();

	for (const node of nodes) {
		for (const edge of node.edges) {
			if (edge.label !== 'conflicts_with') continue;

			const rawTarget = edge.target.replace(/^\[\[|\]\]$/g, '');
			const targetNode = nodeById.get(rawTarget) ?? nodeByTitle.get(rawTarget);
			if (!targetNode) continue;

			const pairKey = [node.id, targetNode.id].sort().join('↔');
			if (seen.has(pairKey)) continue;
			seen.add(pairKey);

			reports.push({
				nodeA:      node,
				nodeB:      targetNode,
				relation:   'conflicts_with',
				evidence:   edge.axiom_basis || edge.reason,
				detectedAt: new Date().toISOString(),
			});
		}
	}

	return reports;
}

// [Phase 10] 구 createActionFromResolution(모순 해소 → 기록용 액션 생성)은 호출부 없는
// 죽은 코드였고, 해소 기록 역할은 문제 노드(species: contradiction)의 라이프사이클이 대체한다.
// (조정 루프: GraphStore.reconcileContradictionProblems / 모달 기록: resolveContradictionProblem)
