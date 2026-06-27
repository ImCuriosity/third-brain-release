import * as d3 from 'd3';
import type { TBNode } from '../types';

// ── D3 시뮬레이션 내부 타입 ───────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
	id: string;
	title: string;
	type: string;
	visible: boolean;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
	relation: string;
	confirmed: boolean;
}

// ── 노드 타입별 색상 ──────────────────────────────────────

const NODE_COLOR: Record<string, string> = {
	claim:       '#cc9900',
	core:        '#cc9900',
	premise:     '#0066cc',
	conclusion:  '#00aa44',
	example:     '#555555',
	contrast:    '#cc2200',
	application: '#0088cc',
	action:      '#00ff88',
	summary:     '#2a2a2a',
};

const EXILE_DIST = 4; // width * EXILE_DIST 위치로 숨긴 노드 추방

// ── GraphView ────────────────────────────────────────────

export class GraphView {
	private container: HTMLElement;
	private onNodeClickCb: (nodeId: string) => void;

	private simNodes: SimNode[] = [];
	private simLinks: SimLink[] = [];
	private simulation!: d3.Simulation<SimNode, SimLink>;

	private nodeSel!: d3.Selection<SVGCircleElement, SimNode, SVGGElement, unknown>;
	private textSel!: d3.Selection<SVGTextElement, SimNode, SVGGElement, unknown>;
	private linkSel!: d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown>;

	private w = 600;
	private h = 500;

	constructor(container: HTMLElement, onNodeClick: (nodeId: string) => void) {
		this.container = container;
		this.onNodeClickCb = onNodeClick;
	}

	render(nodes: TBNode[]): void {
		this.container.empty();
		this.w = Math.max(this.container.clientWidth, 300);
		this.h = Math.max(this.container.clientHeight, 300);

		// ── 시뮬레이션 데이터 변환 ──────────────────────────
		this.simNodes = nodes.map(n => ({
			id: n.id, title: n.title, type: n.type, visible: true,
		}));

		const nodeByTitle = new Map(nodes.map(n => [n.title, n]));
		this.simLinks = [];

		for (const n of nodes) {
			for (const e of n.edges) {
				const title = e.target.replace(/\[\[(.+?)(?:\|.+?)?\]\]/, '$1').trim();
				const t = nodeByTitle.get(title);
				if (t) {
					this.simLinks.push({
						source: n.id,
						target: t.id,
						relation: String(e.label),
						confirmed: e.confirmed,
					});
				}
			}
		}

		// ── SVG 설치 ────────────────────────────────────────
		const svg = d3.select(this.container)
			.append('svg')
			.attr('width', '100%')
			.attr('height', '100%')
			.attr('viewBox', `0 0 ${this.w} ${this.h}`)
			.attr('preserveAspectRatio', 'xMidYMid meet')
			.style('background', '#0a0a0a')
			.style('display', 'block');

		// 화살표 마커
		const defs = svg.append('defs');
		[
			{ id: 'arr-ok', color: '#00ff88' },
			{ id: 'arr-pend', color: '#333333' },
		].forEach(({ id, color }) => {
			defs.append('marker')
				.attr('id', id)
				.attr('viewBox', '0 -4 8 8')
				.attr('refX', 19).attr('refY', 0)
				.attr('markerWidth', 6).attr('markerHeight', 6)
				.attr('orient', 'auto')
				.append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', color);
		});

		// 줌/패닝 레이어
		const g = svg.append('g').attr('class', 'tb-g-zoom');
		svg.call(
			d3.zoom<SVGSVGElement, unknown>()
				.scaleExtent([0.1, 6])
				.on('zoom', ev => g.attr('transform', ev.transform))
		);

		const linkG = g.append('g').attr('class', 'tb-g-links');
		const nodeG = g.append('g').attr('class', 'tb-g-nodes');

		// ── 포스 시뮬레이션 ─────────────────────────────────
		this.simulation = d3.forceSimulation<SimNode, SimLink>(this.simNodes)
			.force('link',
				d3.forceLink<SimNode, SimLink>(this.simLinks)
					.id(d => d.id)
					.distance(110)
					.strength(0.35)
			)
			.force('charge',
				d3.forceManyBody<SimNode>()
					.strength(d => d.visible ? -220 : 0)
			)
			.force('center',
				d3.forceCenter(this.w / 2, this.h / 2).strength(0.05)
			)
			.force('collision',
				d3.forceCollide<SimNode>(26)
			)
			.alphaDecay(0.018);

		// ── 엣지 ────────────────────────────────────────────
		this.linkSel = linkG.selectAll<SVGLineElement, SimLink>('line')
			.data(this.simLinks)
			.join('line')
			.attr('stroke', d => d.confirmed ? '#2a5a2a' : '#1e1e1e')
			.attr('stroke-width', d => d.confirmed ? 1.5 : 0.8)
			.attr('stroke-dasharray', d => d.confirmed ? '' : '4,3')
			.attr('marker-end', d => `url(#${d.confirmed ? 'arr-ok' : 'arr-pend'})`);

		// ── 노드 원 ──────────────────────────────────────────
		this.nodeSel = nodeG.selectAll<SVGCircleElement, SimNode>('circle')
			.data(this.simNodes)
			.join('circle')
			.attr('r', d => ['claim', 'core'].includes(d.type) ? 9 : 6)
			.attr('fill', d => NODE_COLOR[d.type] ?? '#444')
			.attr('stroke', '#0a0a0a')
			.attr('stroke-width', 1.5)
			.attr('cursor', 'pointer')
			.call(this.makeDrag())
			.on('click', (_, d) => this.onNodeClickCb(d.id))
			.on('mouseenter', function () {
				d3.select<SVGCircleElement, SimNode>(this)
					.attr('stroke', '#00ff88')
					.attr('stroke-width', 2.5);
			})
			.on('mouseleave', function () {
				d3.select<SVGCircleElement, SimNode>(this)
					.attr('stroke', '#0a0a0a')
					.attr('stroke-width', 1.5);
			});

		// SVG title 툴팁
		this.nodeSel.each(function (d) {
			d3.select(this).append<SVGTitleElement>('title')
				.text(`[${d.type}] ${d.title}`);
		});

		// ── 레이블 ──────────────────────────────────────────
		this.textSel = nodeG.selectAll<SVGTextElement, SimNode>('text')
			.data(this.simNodes)
			.join('text')
			.text(d => d.title.length > 16 ? d.title.slice(0, 15) + '…' : d.title)
			.attr('font-family', "'Cascadia Code', 'Consolas', monospace")
			.attr('font-size', '8.5px')
			.attr('fill', '#666')
			.attr('text-anchor', 'middle')
			.attr('dy', '1.6em')
			.attr('pointer-events', 'none');

		// ── 틱 ──────────────────────────────────────────────
		this.simulation.on('tick', () => {
			this.linkSel
				.attr('x1', d => (d.source as SimNode).x ?? 0)
				.attr('y1', d => (d.source as SimNode).y ?? 0)
				.attr('x2', d => (d.target as SimNode).x ?? 0)
				.attr('y2', d => (d.target as SimNode).y ?? 0);
			this.nodeSel.attr('cx', d => d.x ?? 0).attr('cy', d => d.y ?? 0);
			this.textSel.attr('x', d => d.x ?? 0).attr('y', d => d.y ?? 0);
		});
	}

	/** 트리에서 노드 접힘/펼침 → 그래프 자식 노드 은닉/복원 (잔챙이 노드 은닉) */
	onNodeToggle(nodeId: string, expanded: boolean): void {
		if (!this.nodeSel) return;

		// 이 노드에서 나가는 링크의 타겟 수집
		const linked = new Set<string>();
		for (const l of this.simLinks) {
			const src = typeof l.source === 'object'
				? (l.source as SimNode).id : String(l.source);
			const tgt = typeof l.target === 'object'
				? (l.target as SimNode).id : String(l.target);
			if (src === nodeId) linked.add(tgt);
		}
		if (linked.size === 0) return;

		const exX = this.w * EXILE_DIST;
		const exY = this.h * EXILE_DIST;
		const parent = this.simNodes.find(n => n.id === nodeId);

		for (const n of this.simNodes) {
			if (!linked.has(n.id)) continue;
			n.visible = expanded;
			if (!expanded) {
				// 화면 밖으로 고정 (잔챙이 은닉)
				n.x = exX; n.y = exY;
				n.fx = exX; n.fy = exY;
			} else {
				// 부모 근방에 배치 후 해제
				n.fx = null; n.fy = null;
				if (parent?.x != null && parent?.y != null) {
					n.x = parent.x + (Math.random() - 0.5) * 80;
					n.y = parent.y + (Math.random() - 0.5) * 80;
				}
			}
		}

		// 반발력 업데이트
		(this.simulation.force('charge') as d3.ForceManyBody<SimNode>)
			.strength(d => d.visible ? -220 : 0);

		// 불투명도 전환
		this.nodeSel.transition().duration(250)
			.attr('opacity', d => d.visible ? 1 : 0);
		this.textSel.transition().duration(250)
			.attr('opacity', d => d.visible ? 1 : 0);

		this.simulation.alpha(0.3).restart();
	}

	/** 트리에서 노드 선택 → 그래프에서 하이라이트 */
	highlightNode(nodeId: string): void {
		if (!this.nodeSel) return;
		this.nodeSel
			.attr('stroke', d => d.id === nodeId ? '#00ff88' : '#0a0a0a')
			.attr('stroke-width', d => d.id === nodeId ? 3 : 1.5);
		this.textSel
			.attr('fill', d => d.id === nodeId ? '#cccccc' : '#666666');
	}

	// ── 드래그 ──────────────────────────────────────────────

	private makeDrag() {
		return d3.drag<SVGCircleElement, SimNode>()
			.on('start', (ev, d) => {
				if (!ev.active) this.simulation.alphaTarget(0.3).restart();
				d.fx = d.x; d.fy = d.y;
			})
			.on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
			.on('end', (ev, d) => {
				if (!ev.active) this.simulation.alphaTarget(0);
				d.fx = null; d.fy = null;
			});
	}
}
