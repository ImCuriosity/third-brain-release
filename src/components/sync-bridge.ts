import type { TreeView } from './tree-view';
import type { GraphView } from './graph-view';

/**
 * 트리 ↔ 그래프 동기화 이벤트 버스
 * - 트리 접힘/펼침 → 그래프 잔챙이 은닉/복원
 * - 트리 선택 → 그래프 하이라이트
 * - 그래프 클릭 → 트리 하이라이트 + 스크롤
 */
export class SyncBridge {
	constructor(
		private treeView: TreeView,
		private graphView: GraphView,
	) {}

	/** TreeView 이벤트 → GraphView 처리 */
	onTreeToggle(nodeId: string, expanded: boolean): void {
		this.graphView.onNodeToggle(nodeId, expanded);
	}

	onTreeSelect(nodeId: string): void {
		this.graphView.highlightNode(nodeId);
	}

	/** GraphView 클릭 이벤트 → TreeView 처리 */
	onGraphNodeClick(nodeId: string): void {
		this.treeView.highlightNode(nodeId);
	}
}
