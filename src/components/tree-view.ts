import type { TBNode } from '../types';

interface TreeItem {
	node: TBNode;
	children: TreeItem[];
}

const TYPE_ORDER: Record<string, number> = {
	claim: 0, core: 0, premise: 1, conclusion: 2,
	application: 3, example: 4, contrast: 5, action: 6, summary: 7,
};

export class TreeView {
	private container: HTMLElement;
	private itemEls = new Map<string, HTMLElement>(); // id → row element
	private expandedSet = new Set<string>();
	private onToggleCb: (nodeId: string, expanded: boolean) => void;
	private onSelectCb: (nodeId: string) => void;

	constructor(
		container: HTMLElement,
		callbacks: {
			onToggle: (nodeId: string, expanded: boolean) => void;
			onSelect: (nodeId: string) => void;
		}
	) {
		this.container = container;
		this.onToggleCb = callbacks.onToggle;
		this.onSelectCb = callbacks.onSelect;
	}

	render(nodes: TBNode[]): void {
		this.container.empty();
		this.itemEls.clear();
		this.expandedSet.clear();

		if (nodes.length === 0) {
			this.container.createEl('div', {
				cls: 'tb-tree-empty',
				text: '노드 없음. 인제스트 탭에서 텍스트를 추가하세요.',
			});
			return;
		}

		const tree = this.buildTree(nodes);
		const ul = this.container.createEl('ul', { cls: 'tb-tree' });
		for (const item of tree) this.renderItem(ul, item, 0);
	}

	private buildTree(nodes: TBNode[]): TreeItem[] {
		// 타입 우선순위로 정렬
		const sorted = [...nodes].sort((a, b) => {
			const oa = TYPE_ORDER[a.type] ?? 9;
			const ob = TYPE_ORDER[b.type] ?? 9;
			return oa - ob || a.title.localeCompare(b.title);
		});

		// 확정 엣지 기반: 누가 자식인지 파악
		const nodeByTitle = new Map(nodes.map(n => [n.title, n]));
		const isChild = new Set<string>();
		for (const n of nodes) {
			for (const e of n.edges.filter(ed => ed.confirmed)) {
				const title = e.target.replace(/\[\[(.+?)(?:\|.+?)?\]\]/, '$1').trim();
				const t = nodeByTitle.get(title);
				if (t) isChild.add(t.id);
			}
		}

		// DFS로 트리 구성
		const visited = new Set<string>();
		const makeItem = (n: TBNode): TreeItem => {
			visited.add(n.id);
			const children: TreeItem[] = n.edges
				.filter(e => e.confirmed)
				.map(e => {
					const title = e.target.replace(/\[\[(.+?)(?:\|.+?)?\]\]/, '$1').trim();
					const t = nodeByTitle.get(title);
					return t && !visited.has(t.id) ? makeItem(t) : null;
				})
				.filter((x): x is TreeItem => x !== null);
			return { node: n, children };
		};

		// 루트 = 다른 노드의 자식이 아닌 것 먼저, 나머지는 추가
		const roots: TreeItem[] = [];
		for (const n of sorted) {
			if (!visited.has(n.id)) roots.push(makeItem(n));
		}
		return roots;
	}

	private renderItem(ul: HTMLElement, item: TreeItem, depth: number): void {
		const li = ul.createEl('li', { cls: 'tb-tree-li' });
		const hasChildren = item.children.length > 0;

		const row = li.createEl('div', {
			cls: `tb-tree-item is-${item.node.type}`,
			attr: { style: `padding-left: ${8 + depth * 14}px` },
		});

		const chevron = row.createEl('span', {
			cls: 'tb-tree-chevron',
			text: hasChildren ? '▶' : '·',
		});
		row.createEl('span', {
			cls: `tb-tag is-${item.node.type}`,
			text: item.node.type.slice(0, 3).toUpperCase(),
		});
		row.createEl('span', { cls: 'tb-tree-label', text: item.node.title });

		this.itemEls.set(item.node.id, row);

		// 자식 UL (기본 숨김)
		if (hasChildren) {
			const childUl = li.createEl('ul', { cls: 'tb-tree tb-tree-children is-hidden' });
			for (const child of item.children) this.renderItem(childUl, child, depth + 1);

			chevron.addEventListener('click', (ev) => {
				ev.stopPropagation();
				const wasHidden = childUl.hasClass('is-hidden');
				childUl.toggleClass('is-hidden', !wasHidden);
				chevron.textContent = wasHidden ? '▼' : '▶';
				const expanded = wasHidden; // wasHidden=true → now expanding
				if (expanded) this.expandedSet.add(item.node.id);
				else this.expandedSet.delete(item.node.id);
				this.onToggleCb(item.node.id, expanded);
			});
		}

		row.addEventListener('click', () => {
			this.itemEls.forEach(el => el.removeClass('is-active'));
			row.addClass('is-active');
			this.onSelectCb(item.node.id);
		});
	}

	/** 그래프에서 노드 클릭 시 → 트리에서 해당 항목 하이라이트 */
	highlightNode(nodeId: string): void {
		this.itemEls.forEach((el, id) => el.toggleClass('is-active', id === nodeId));
		this.itemEls.get(nodeId)?.scrollIntoView({ block: 'nearest' });
	}
}
