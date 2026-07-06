// ============================================================
// ThirdBrain v2 — 모순 감지 엔진 (Phase 2)
// conflicts_with 엣지 스캔 → ConflictReport[] 생성
// ============================================================

import type { TBNode, ConflictReport, ContradictionResolution, ActionNode } from '../types';

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

// ── Phase 8-4: 모순 해소 → ActionNode 자동 생성 ──────────────

/**
 * ContradictionResolution 수신 → ActionNode 자동 생성.
 * origin='from_resolution', status='pending', link_type='resolves_conflict'.
 */
export function createActionFromResolution(
	resolution: ContradictionResolution,
	conflict: ConflictReport
): Omit<ActionNode, 'filePath'> {
	const now = new Date().toISOString();
	const id = `act-res-${conflict.nodeA.id}-${conflict.nodeB.id}-${Date.now().toString(36)}`;

	let title: string;
	let content: string;
	let motivationIds: string[];

	switch (resolution.resolution) {
		case 'discard_a':
			title   = `[검토] "${conflict.nodeA.title}" 폐기 처리`;
			content = `모순 해소: "${conflict.nodeA.title}"을 거짓으로 판별하여 폐기했습니다.\n근거: ${conflict.evidence ?? '—'}`;
			motivationIds = [conflict.nodeA.id, conflict.nodeB.id];
			break;
		case 'discard_b':
			title   = `[검토] "${conflict.nodeB.title}" 폐기 처리`;
			content = `모순 해소: "${conflict.nodeB.title}"을 거짓으로 판별하여 폐기했습니다.\n근거: ${conflict.evidence ?? '—'}`;
			motivationIds = [conflict.nodeA.id, conflict.nodeB.id];
			break;
		case 'add_precondition':
			title   = `[상위전제 생성] ${(resolution.newPreconditionText ?? '').slice(0, 40)}`;
			content = `모순 해소: 두 명제를 포괄하는 상위 전제를 추가했습니다.\n전제 내용: ${resolution.newPreconditionText ?? '—'}\n충돌 명제: "${conflict.nodeA.title}" ↔ "${conflict.nodeB.title}"`;
			motivationIds = [conflict.nodeA.id, conflict.nodeB.id];
			break;
	}

	return {
		id,
		title,
		content,
		owner: '',
		deadline: '',
		status:                'pending',
		motivation_ids:        motivationIds,
		motivation_context_ids: [],
		link_type:             'resolves_conflict',
		origin:                'from_resolution',
		created:               now,
	};
}
