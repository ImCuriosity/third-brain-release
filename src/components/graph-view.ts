import * as d3 from 'd3';
import type { TBNode } from '../types';

// ── 내부 시뮬레이션 타입 ──────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
	id: string;
	title: string;
	type: string;
	degree: number;
	block_id?: string;
	raw_path?: string;
	heading_path?: string;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
	relation: string;
	confirmed: boolean;
}

// ── 엣지 타입별 색상 (10종 공리) ─────────────────────────

export const EDGE_COLOR: Record<string, string> = {
	causes:          '#ff8800',
	precedes:        '#cc6600',
	precondition_of: '#ffbb00',
	supports:        '#00aa44',
	conflicts_with:  '#ff2200',
	contrasts_with:  '#cc3300',
	exemplifies:     '#0088ff',
	applies_to:      '#00aabb',
	analogous_to:    '#9944cc',
	isomorphic_to:   '#cc44aa',
	implements:      '#7755cc',
};

const PROP_COLOR  = '#5577ee';  // 명제 계열 공통
const NODE_COLOR: Record<string, string> = {
	raw:         '#888888',
	context:     '#33aa77',
	insight:     '#aa44cc',
	claim:       PROP_COLOR,
	core:        PROP_COLOR,
	premise:     PROP_COLOR,
	conclusion:  PROP_COLOR,
	example:     PROP_COLOR,
	contrast:    PROP_COLOR,
	application: PROP_COLOR,
	summary:     PROP_COLOR,
	action:      '#ff7744',
};

const NODE_LABEL: Record<string, { ko: string; en: string }> = {
	raw:         { ko: 'Raw',     en: 'Raw' },
	context:     { ko: '문맥',    en: 'Context' },
	insight:     { ko: '인사이트', en: 'Insight' },
	claim:       { ko: '명제',    en: 'Proposition' },
	core:        { ko: '명제',    en: 'Proposition' },
	premise:     { ko: '명제',    en: 'Proposition' },
	conclusion:  { ko: '명제',    en: 'Proposition' },
	example:     { ko: '명제',    en: 'Proposition' },
	contrast:    { ko: '명제',    en: 'Proposition' },
	application: { ko: '명제',    en: 'Proposition' },
	summary:     { ko: '명제',    en: 'Proposition' },
	action:      { ko: '액션',    en: 'Action' },
};

// ── 유틸 ─────────────────────────────────────────────────

function nodeRadius(degree: number): number {
	return Math.max(5, Math.min(18, 5 + Math.sqrt(degree) * 2.2));
}

// ── GraphView (Canvas 렌더러) ────────────────────────────

export class GraphView {
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;
	private simNodes: SimNode[] = [];
	private simLinks: SimLink[] = [];
	private simulation!: d3.Simulation<SimNode, SimLink>;
	private zoomBehavior!: d3.ZoomBehavior<HTMLCanvasElement, unknown>;
	private transform: d3.ZoomTransform = d3.zoomIdentity;
	private hoveredNode: SimNode | null = null;
	private draggingNode: SimNode | null = null;
	private activeRelations: Set<string> | null = null;
	private hasFitted = false;
	private w = 600;
	private h = 500;
	private legendEntries: Array<{ color: string; label: string }> = [];
	private nodePopupEl: HTMLElement | null = null;

	constructor(
		private container: HTMLElement,
		private onNodeClickCb: (nodeId: string) => void,
		private lang: string = 'en',
		private openSourceCb?: (rawPath: string, blockId: string) => void,
	) {}

	setLegend(entries: Array<{ color: string; label: string }>): void {
		this.legendEntries = entries;
	}

	render(nodes: TBNode[], activeRelations?: Set<string>): void {
		this.activeRelations = activeRelations ?? null;
		this.hoveredNode = null;
		this.container.empty();

		this.w = Math.max(this.container.clientWidth || 600, 400);
		this.h = Math.max(this.container.clientHeight || 500, 400);

		// ── 데이터 변환 ───────────────────────────────────
		const nodeMap = new Map<string, TBNode>(nodes.map(n => [n.title, n]));
		const idMap = new Map<string, string>(nodes.map(n => [n.title, n.id]));

		// 노드 초기 위치를 중앙 근처에 집중 → 수렴 과정(장력/인력)이 시각적으로 보임
		this.simNodes = nodes.map(n => ({
			id: n.id, title: n.title, type: n.type, degree: 0,
			block_id: n.block_id,
			raw_path: n.raw_path,
			heading_path: n.heading_path,
			x: this.w / 2 + (Math.random() - 0.5) * 80,
			y: this.h / 2 + (Math.random() - 0.5) * 80,
		}));
		const simNodeById = new Map(this.simNodes.map(n => [n.id, n]));

		this.simLinks = [];
		for (const n of nodes) {
			for (const e of n.edges) {
				const title = e.target.replace(/\[\[(.+?)(?:\|.+?)?\]\]/, '$1').trim();
				const targetNode = nodeMap.get(title);
				if (!targetNode) continue;
				this.simLinks.push({
					source: n.id,
					target: targetNode.id,
					relation: String(e.label),
					confirmed: e.confirmed !== false,
				});
				const sn = simNodeById.get(n.id);
				const tn = simNodeById.get(targetNode.id);
				if (sn) sn.degree++;
				if (tn) tn.degree++;
			}
		}
		void idMap;

		// ── Canvas 설치 ───────────────────────────────────
		this.canvas = this.container.createEl('canvas', { cls: 'tb-graph-canvas' });
		this.canvas.width = this.w;
		this.canvas.height = this.h;

		const ctx = this.canvas.getContext('2d');
		if (!ctx) return;
		this.ctx = ctx;

		// ── d3-zoom (노드 클릭 시 pan 비활성화) ──────────
		this.transform = d3.zoomIdentity;
		this.hasFitted = false;
		this.zoomBehavior = d3.zoom<HTMLCanvasElement, unknown>()
			.filter((event: Event) => {
				if (event.type === 'mousedown') {
					const e = event as MouseEvent;
					const rect = (e.target as HTMLElement).getBoundingClientRect();
					return this.hitTest(e.clientX - rect.left, e.clientY - rect.top) === null;
				}
				return !(event as MouseEvent).button;
			})
			.scaleExtent([0.05, 10])
			.on('zoom', (ev: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
				this.transform = ev.transform;
				this.draw();
			});
		d3.select(this.canvas).call(this.zoomBehavior);

		// ── 마우스 이벤트 ─────────────────────────────────
		this.canvas.addEventListener('mousedown', (e) => {
			if (e.button !== 0) return;
			const rect = this.canvas.getBoundingClientRect();
			const node = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
			if (!node) return;
			this.draggingNode = node;
			node.fx = node.x ?? 0;
			node.fy = node.y ?? 0;
			this.simulation.alphaTarget(0.3).restart();
			this.canvas.addClass('tb-graph-canvas--grabbing');
		});

		this.canvas.addEventListener('mousemove', (e) => {
			const rect = this.canvas.getBoundingClientRect();
			if (this.draggingNode) {
				const wx = (e.clientX - rect.left - this.transform.x) / this.transform.k;
				const wy = (e.clientY - rect.top - this.transform.y) / this.transform.k;
				this.draggingNode.fx = wx;
				this.draggingNode.fy = wy;
				return;
			}
			const node = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
			if (node !== this.hoveredNode) {
				this.hoveredNode = node;
				this.canvas.toggleClass('tb-graph-canvas--pointer', node != null);
				this.draw();
			}
		});

		this.canvas.addEventListener('mouseup', () => {
			if (!this.draggingNode) return;
			this.draggingNode.fx = null;
			this.draggingNode.fy = null;
			this.simulation.alphaTarget(0);
			this.draggingNode = null;
			this.canvas.removeClass('tb-graph-canvas--grabbing');
		});

		this.canvas.addEventListener('click', (e) => {
			if (e.detail > 1) return;
			const rect = this.canvas.getBoundingClientRect();
			const node = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
			if (node) {
				this.showNodePopup(node, e.clientX - rect.left, e.clientY - rect.top);
			} else {
				this.closeNodePopup();
			}
		});

		this.canvas.addEventListener('mouseleave', () => {
			if (this.draggingNode) {
				this.draggingNode.fx = null;
				this.draggingNode.fy = null;
				this.simulation.alphaTarget(0);
				this.draggingNode = null;
				this.canvas.removeClass('tb-graph-canvas--grabbing');
			}
			if (this.hoveredNode) { this.hoveredNode = null; this.draw(); }
		});

		// ── 포스 시뮬레이션 ───────────────────────────────
		// 인력(척력): charge가 노드들을 밀어냄
		// 장력(탄성): link force가 연결된 노드들을 당김
		// 중력: center force가 전체를 중앙으로 끌어당김
		// 세 힘의 균형으로 자연스러운 클러스터 배치 형성
		this.simulation = d3.forceSimulation<SimNode, SimLink>(this.simNodes)
			.force('link',
				d3.forceLink<SimNode, SimLink>(this.simLinks)
					.id(d => d.id)
					.distance((d) => {
						// 고차수 노드끼리는 조금 더 멀리 — 허브가 중앙으로
						const src = d.source as SimNode;
						const tgt = d.target as SimNode;
						return 55 + Math.sqrt((src.degree + tgt.degree) * 0.5) * 8;
					})
					.strength(0.45))
			.force('charge',
				d3.forceManyBody<SimNode>()
					.strength(d => -80 - d.degree * 12)
					.distanceMax(280))   // 근거리 척력만 — 멀리 퍼지지 않게
			.force('center',
				d3.forceCenter(this.w / 2, this.h / 2).strength(0.35)) // 강한 중앙 인력
			.force('collide',
				d3.forceCollide<SimNode>()
					.radius(d => nodeRadius(d.degree) + 6)
					.strength(0.6))
			.alphaDecay(0.008)   // 천천히 수렴 — 장력/인력 운동이 오래 보임
			.velocityDecay(0.28) // 낮은 감쇠 → 스프링처럼 탄성 있는 움직임
			.on('tick', () => {
				this.draw();
				// 노드들이 어느 정도 퍼진 후 화면에 꽉 차도록 자동 맞춤
				if (!this.hasFitted && this.simulation.alpha() < 0.4) {
					this.hasFitted = true;
					this.fitView(48);
				}
			});

		this.draw();
	}

	private fitView(padding = 48): void {
		if (this.simNodes.length === 0) return;
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (const n of this.simNodes) {
			if (n.x == null || n.y == null) continue;
			const r = nodeRadius(n.degree);
			minX = Math.min(minX, n.x - r);
			maxX = Math.max(maxX, n.x + r);
			minY = Math.min(minY, n.y - r);
			maxY = Math.max(maxY, n.y + r);
		}
		if (!isFinite(minX)) return;
		const gw = maxX - minX || 1;
		const gh = maxY - minY || 1;
		const scale = Math.min(
			(this.w - padding * 2) / gw,
			(this.h - padding * 2) / gh,
			1.8,  // 너무 크게 확대하지 않음
		);
		const tx = (this.w - gw * scale) / 2 - minX * scale;
		const ty = (this.h - gh * scale) / 2 - minY * scale;
		const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
		const sel = d3.select(this.canvas);
		// eslint-disable-next-line @typescript-eslint/unbound-method -- d3 API requires passing .transform as a callable
		sel.call(this.zoomBehavior.transform, t);
	}

	private draw(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const { width: w, height: h } = this.canvas;
		const k = this.transform.k;

		ctx.save();
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, w, h);

		// 회색 격자
		const gridStep = 40 * this.transform.k;
		const ox = this.transform.x % gridStep;
		const oy = this.transform.y % gridStep;
		ctx.save();
		ctx.strokeStyle = 'rgba(0,0,0,0.07)';
		ctx.lineWidth = 1;
		for (let x = ox; x < w; x += gridStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
		for (let y = oy; y < h; y += gridStep) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
		ctx.restore();
		ctx.translate(this.transform.x, this.transform.y);
		ctx.scale(k, k);

		const hovered = this.hoveredNode;
		const activeRel = this.activeRelations;

		// 호버 연결 노드 집합
		const connectedIds = new Set<string>();
		if (hovered) {
			connectedIds.add(hovered.id);
			for (const l of this.simLinks) {
				const src = (l.source as SimNode).id;
				const tgt = (l.target as SimNode).id;
				if (src === hovered.id) connectedIds.add(tgt);
				if (tgt === hovered.id) connectedIds.add(src);
			}
		}

		// ── 엣지 렌더 ─────────────────────────────────────
		for (const l of this.simLinks) {
			const src = l.source as SimNode;
			const tgt = l.target as SimNode;
			if (src.x == null || tgt.x == null) continue;

			const isActive = !activeRel || activeRel.has(l.relation);
			const isConnected = !hovered || (connectedIds.has(src.id) && connectedIds.has(tgt.id));

			let color = l.confirmed ? (EDGE_COLOR[l.relation] ?? '#999') : '#b8b8b8';
			if (!isActive) color = '#ddd';

			ctx.globalAlpha = isConnected ? (isActive ? 1 : 0.4) : 0.08;
			this.drawArrow(src.x, src.y ?? 0, tgt.x, tgt.y ?? 0, nodeRadius(tgt.degree), color, !l.confirmed);
			ctx.globalAlpha = 1;
		}

		// ── 노드 렌더 ─────────────────────────────────────
		for (const n of this.simNodes) {
			if (n.x == null) continue;
			const r = nodeRadius(n.degree);
			const isFaded = hovered != null && !connectedIds.has(n.id);

			ctx.globalAlpha = isFaded ? 0.12 : 1;
			ctx.beginPath();
			ctx.arc(n.x, n.y ?? 0, r, 0, Math.PI * 2);
			ctx.fillStyle = NODE_COLOR[n.type] ?? '#555';
			ctx.fill();

			if (n === hovered) {
				ctx.strokeStyle = '#0066ff';
				ctx.lineWidth = 2.5 / k;
				ctx.stroke();
			}
			ctx.globalAlpha = 1;
		}

		// ── 레이블 ────────────────────────────────────────
		if (k > 0.45) {
			const maxLen = k > 1.2 ? 40 : 14;
			ctx.font = `${11 / k}px 'Cascadia Code', Consolas, monospace`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';

			for (const n of this.simNodes) {
				if (n.x == null) continue;
				const isFaded = hovered != null && !connectedIds.has(n.id);
				ctx.globalAlpha = isFaded ? 0.15 : 1;
				ctx.fillStyle = n === hovered ? '#111111' : '#444444';

				const label = n.title.length > maxLen ? n.title.slice(0, maxLen - 1) + '…' : n.title;
				ctx.fillText(label, n.x, (n.y ?? 0) + nodeRadius(n.degree) + 3 / k);
				ctx.globalAlpha = 1;
			}
		}

		ctx.restore();
		this.drawLegend();
	}

	private drawLegend(): void {
		if (this.legendEntries.length === 0) return;
		const ctx = this.ctx;
		const W = this.w;
		const H = this.h;
		const rowH = 24;
		const padV = 6;
		const startX = 16;
		const maxW = W - startX - 16;

		ctx.font = '11px sans-serif';

		const isKo = this.lang === 'ko';
		const edgeItems = [
			...this.legendEntries.map(e => ({ ...e, dashed: false })),
			{ color: '#aaaaaa', label: isKo ? '미확인' : 'Unconfirmed', dashed: true },
		];
		// 중복 라벨 제거 — 명제 계열은 하나로 표시
		const seenLabels = new Set<string>();
		const nodeItems = Object.entries(NODE_COLOR)
			.map(([type, color]) => ({ color, label: (NODE_LABEL[type]?.[isKo ? 'ko' : 'en']) ?? type }))
			.filter(item => { if (seenLabels.has(item.label)) return false; seenLabels.add(item.label); return true; });

		const edgeRows = this.wrapLegendItems(ctx, edgeItems, maxW, true);
		const nodeRows = this.wrapLegendItems(ctx, nodeItems, maxW, false);

		const totalRows = edgeRows.length + nodeRows.length;
		const barH = totalRows * rowH + padV * 2 + 6; // +6 for separator
		const y = H - barH;

		ctx.save();
		ctx.textBaseline = 'middle';

		ctx.fillStyle = 'rgba(248,248,248,0.95)';
		ctx.fillRect(0, y, W, barH);
		ctx.strokeStyle = 'rgba(0,0,0,0.10)';
		ctx.lineWidth = 1;
		ctx.setLineDash([]);
		ctx.beginPath();
		ctx.moveTo(0, y + 0.5);
		ctx.lineTo(W, y + 0.5);
		ctx.stroke();

		let curY = y + padV + rowH / 2;

		for (const row of edgeRows) {
			let x = startX;
			for (const item of row) {
				x = this.drawEdgeLegendItem(ctx, x, curY, item.color, item.label, item.dashed);
			}
			curY += rowH;
		}

		// 엣지/노드 구분선
		ctx.strokeStyle = 'rgba(0,0,0,0.07)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(12, curY - rowH / 2 + 4);
		ctx.lineTo(W - 12, curY - rowH / 2 + 4);
		ctx.stroke();
		curY += 3;

		for (const row of nodeRows) {
			let x = startX;
			for (const { color, label } of row) {
				ctx.beginPath();
				ctx.arc(x + 5, curY, 5, 0, Math.PI * 2);
				ctx.fillStyle = color;
				ctx.fill();
				x += 13;
				ctx.fillStyle = '#444444';
				ctx.textAlign = 'left';
				ctx.fillText(label, x, curY);
				x += ctx.measureText(label).width + 14;
			}
			curY += rowH;
		}

		ctx.restore();
	}

	private wrapLegendItems<T extends { label: string }>(
		ctx: CanvasRenderingContext2D,
		items: T[],
		maxW: number,
		isEdge: boolean,
	): T[][] {
		const rows: T[][] = [];
		let row: T[] = [];
		let x = 0;
		for (const item of items) {
			const tw = ctx.measureText(item.label).width;
			const itemW = isEdge ? (27 + tw + 14) : (13 + tw + 14);
			if (row.length > 0 && x + itemW > maxW) {
				rows.push(row);
				row = [item];
				x = itemW;
			} else {
				row.push(item);
				x += itemW;
			}
		}
		if (row.length > 0) rows.push(row);
		return rows;
	}

	private drawEdgeLegendItem(ctx: CanvasRenderingContext2D, x: number, cy: number, color: string, label: string, dashed: boolean): number {
		const lineW = 22;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = dashed ? 1.2 : 2;
		if (dashed) ctx.setLineDash([4, 3]);
		ctx.beginPath();
		ctx.moveTo(x, cy);
		ctx.lineTo(x + lineW, cy);
		ctx.stroke();
		ctx.setLineDash([]);
		if (!dashed) {
			// 화살촉
			ctx.beginPath();
			ctx.moveTo(x + lineW, cy);
			ctx.lineTo(x + lineW - 6, cy - 3.5);
			ctx.lineTo(x + lineW - 6, cy + 3.5);
			ctx.closePath();
			ctx.fillStyle = color;
			ctx.fill();
		}
		ctx.restore();
		x += lineW + 5;
		ctx.fillStyle = '#444444';
		ctx.textAlign = 'left';
		ctx.fillText(label, x, cy);
		return x + ctx.measureText(label).width + 14;
	}

	private drawArrow(x1: number, y1: number, x2: number, y2: number, targetR: number, color: string, dashed: boolean): void {
		const ctx = this.ctx;
		const k = this.transform.k;
		const angle = Math.atan2(y2 - y1, x2 - x1);
		const endX = x2 - (targetR + 2) * Math.cos(angle);
		const endY = y2 - (targetR + 2) * Math.sin(angle);

		ctx.beginPath();
		if (dashed) ctx.setLineDash([5 / k, 4 / k]);
		ctx.moveTo(x1, y1);
		ctx.lineTo(endX, endY);
		ctx.strokeStyle = color;
		ctx.lineWidth = (dashed ? 0.8 : 1.5) / k;
		ctx.stroke();
		ctx.setLineDash([]);

		if (!dashed) {
			const al = 8 / k;
			const aa = Math.PI / 6;
			ctx.beginPath();
			ctx.moveTo(endX, endY);
			ctx.lineTo(endX - al * Math.cos(angle - aa), endY - al * Math.sin(angle - aa));
			ctx.lineTo(endX - al * Math.cos(angle + aa), endY - al * Math.sin(angle + aa));
			ctx.closePath();
			ctx.fillStyle = color;
			ctx.fill();
		}
	}

	private closeNodePopup(): void {
		this.nodePopupEl?.remove();
		this.nodePopupEl = null;
	}

	private showNodePopup(node: SimNode, screenX: number, screenY: number): void {
		this.closeNodePopup();

		// document.body에 fixed 팝업 — .tb-canvas-wrap의 overflow:hidden 우회
		const popup = activeDocument.body.createEl('div', { cls: 'tb-node-popup' });
		this.nodePopupEl = popup;

		// 제목
		popup.createEl('div', { cls: 'tb-node-popup-title', text: node.title });

		// 타입 뱃지
		const typeColors: Record<string, string> = {
			claim: '#cc9900', core: '#ffcc00', premise: '#44aaff',
			context: '#33aa77', insight: '#cc44cc', action: '#ff7744',
		};
		const badge = popup.createEl('div', { cls: 'tb-node-popup-type', text: node.type });
		badge.setCssStyles({ background: typeColors[node.type] ?? '#888' });

		// 연결 목록
		const edges: Array<{ dir: '→' | '←'; title: string; relation: string; color: string }> = [];
		for (const l of this.simLinks) {
			const src = l.source as SimNode;
			const tgt = l.target as SimNode;
			if (src.id === node.id) {
				edges.push({ dir: '→', title: tgt.title, relation: l.relation, color: EDGE_COLOR[l.relation] ?? '#999' });
			} else if (tgt.id === node.id) {
				edges.push({ dir: '←', title: src.title, relation: l.relation, color: EDGE_COLOR[l.relation] ?? '#999' });
			}
		}

		if (edges.length > 0) {
			const list = popup.createEl('div', { cls: 'tb-node-popup-edges' });
			for (const e of edges) {
				const row = list.createEl('div', { cls: 'tb-node-popup-edge-row' });
				row.createEl('span', { cls: 'tb-node-popup-dir', text: e.dir });
				row.createEl('span', { cls: 'tb-node-popup-edge-title', text: e.title });
				const rel = row.createEl('span', { cls: 'tb-node-popup-rel', text: e.relation });
				rel.setCssStyles({ color: e.color });
			}
		} else {
			popup.createEl('div', { cls: 'tb-node-popup-empty', text: '연결 없음' });
		}

		// 원본 위치 링크
		if (node.raw_path && node.block_id) {
			const sourceDiv = popup.createEl('div', { cls: 'tb-node-popup-source' });
			if (node.heading_path) {
				sourceDiv.createEl('div', { cls: 'tb-node-popup-heading', text: node.heading_path });
			}
			if (this.openSourceCb) {
				const rawPath = node.raw_path;
				const blockId = node.block_id;
				const link = sourceDiv.createEl('div', { cls: 'tb-node-popup-source-link', text: '↗ 원본 위치로 이동' });
				link.addEventListener('click', (e) => {
					e.stopPropagation();
					this.openSourceCb!(rawPath, blockId);
					this.closeNodePopup();
				});
			}
		}

		// 뷰포트 기준 fixed 위치 계산 (canvas 로컬 좌표 → 뷰포트 좌표)
		const canvasRect = this.canvas.getBoundingClientRect();
		const PAD = 10;
		let left = canvasRect.left + screenX + 14;
		let top  = canvasRect.top  + screenY - 10;
		const vpW = window.innerWidth;
		const vpH = window.innerHeight;
		if (left + 240 > vpW) left = canvasRect.left + screenX - 250;
		if (top  + 200 > vpH) top  = vpH - 210;
		if (top < PAD) top = PAD;
		// position/z-index 인라인 강제 — styles.css 미반영 환경 대응
		popup.setCssStyles({ position: 'fixed', zIndex: '1000', left: `${left}px`, top: `${top}px` });
	}

	cleanup(): void {
		this.closeNodePopup();
	}

	private hitTest(screenX: number, screenY: number): SimNode | null {
		const wx = (screenX - this.transform.x) / this.transform.k;
		const wy = (screenY - this.transform.y) / this.transform.k;
		for (const n of this.simNodes) {
			if (n.x == null) continue;
			const r = nodeRadius(n.degree);
			const dx = n.x - wx;
			const dy = (n.y ?? 0) - wy;
			if (dx * dx + dy * dy <= r * r) return n;
		}
		return null;
	}

	// ── SyncBridge 인터페이스 ─────────────────────────────

	onNodeToggle(nodeId: string, expanded: boolean): void {
		const exX = this.w * 4;
		const exY = this.h * 4;
		const parent = this.simNodes.find(n => n.id === nodeId);
		const linked = new Set<string>();
		for (const l of this.simLinks) {
			const src = typeof l.source === 'object' ? (l.source as { id: string }).id : String(l.source);
			const tgt = typeof l.target === 'object' ? (l.target as { id: string }).id : String(l.target);
			if (src === nodeId) linked.add(tgt);
		}
		for (const n of this.simNodes) {
			if (!linked.has(n.id)) continue;
			if (!expanded) { n.fx = exX; n.fy = exY; }
			else {
				n.fx = null; n.fy = null;
				if (parent?.x != null) { n.x = parent.x + (Math.random() - 0.5) * 80; n.y = (parent.y ?? 0) + (Math.random() - 0.5) * 80; }
			}
		}
		this.simulation?.alpha(0.3).restart();
	}

	highlightNode(nodeId: string): void {
		const node = this.simNodes.find(n => n.id === nodeId);
		this.hoveredNode = node ?? null;
		this.draw();
	}
}
