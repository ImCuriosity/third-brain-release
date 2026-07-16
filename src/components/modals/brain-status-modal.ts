import { App, Modal, Notice, TFile } from 'obsidian';
import { getT } from '../../i18n';
import { GraphStore } from '../../engine/graph-store';
import type { BrainFolderStatus } from '../../engine/graph-store';
import { rankEdgeRelations } from '../../engine/serial-pipeline';
import type { EdgeRank } from '../../engine/serial-pipeline';
import { callClaudeWithModel } from '../../engine/cli-bridge';
import type { TBNode, TBEdgeRelation, ConflictReport, ThirdBrainSettings } from '../../types';
import { OrphanQueueModal } from '../vault-lint';
import { ProblemDetailModal } from '../workbench';
import { conflictNodeDetail } from './shared';

// ── 모순 해소 모달 ─────────────────────────────────────────────
export class ConflictResolutionModal extends Modal {
	private ranks: EdgeRank[] = [];
	private rankLoading = true;

	constructor(
		app: App,
		private conflict: ConflictReport,
		private store: GraphStore,
		private settings: ThirdBrainSettings,
		private onResolved?: (msg: string) => void,
	) {
		super(app);
	}

	private get t() { return getT(this.settings.lang); }

	private get dimension(): 'fact_vs_fact' | 'claim_vs_claim' | 'fact_vs_claim' {
		const aIsFact = this.conflict.nodeA.proposition_type === 'fact';
		const bIsFact = this.conflict.nodeB.proposition_type === 'fact';
		if (aIsFact && bIsFact) return 'fact_vs_fact';
		if (!aIsFact && !bIsFact) return 'claim_vs_claim';
		return 'fact_vs_claim';
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('tb-popup-content', 'tb-conflict-modal');

		const dim = this.dimension;
		const titleKey = dim === 'fact_vs_fact' ? 'conflict_title_fact_fact'
			: dim === 'claim_vs_claim' ? 'conflict_title_claim_claim'
			: 'conflict_title_fact_claim';
		const descKey = dim === 'fact_vs_fact' ? 'conflict_desc_fact_fact'
			: dim === 'claim_vs_claim' ? 'conflict_desc_claim_claim'
			: 'conflict_desc_fact_claim';

		contentEl.createEl('h3', { text: this.t(titleKey), cls: 'tb-conflict-modal-title' });
		contentEl.createEl('p', { text: this.t(descKey), cls: 'tb-conflict-modal-desc' });

		// 충돌 요약 — 제목·명제문·원문 인용을 양쪽 모두 표시 (제목만으로는 모순 성립 판단 불가)
		const summary = contentEl.createDiv({ cls: 'tb-conflict-summary' });
		const renderSide = (node: TBNode, cls: string) => {
			const box = summary.createDiv({ cls: `tb-conflict-side ${cls}` });
			box.createDiv({ cls: 'tb-conflict-side-title', text: node.title });
			const { claim, quote } = conflictNodeDetail(node);
			if (claim) box.createDiv({ cls: 'tb-conflict-side-claim', text: claim });
			if (quote) box.createDiv({ cls: 'tb-conflict-side-quote', text: quote });
		};
		renderSide(this.conflict.nodeA, 'tb-conflict-node-a');
		summary.createDiv({ cls: 'tb-conflict-vs', text: '⟷' });
		renderSide(this.conflict.nodeB, 'tb-conflict-node-b');
		if (this.conflict.evidence) {
			const evidenceLabel = this.settings.lang === 'en' ? 'Evidence: ' : '근거: ';
			contentEl.createDiv({ cls: 'tb-conflict-evidence', text: `${evidenceLabel}${this.conflict.evidence}` });
		}

		contentEl.createEl('hr');

		// ── 옵션 1: 엣지 재분류 ──────────────────────────────────
		const opt1Label = this.settings.lang === 'en'
			? 'Option 1 — Reclassify with a more accurate edge'
			: '옵션 1 — 더 정확한 엣지로 재분류';
		contentEl.createDiv({ cls: 'tb-conflict-section-title', text: opt1Label });
		const rankArea = contentEl.createDiv({ cls: 'tb-conflict-rank-area' });
		const loadingText = this.settings.lang === 'en' ? 'AI is analyzing the relation...' : 'AI가 관계를 분석 중...';
		const noRankText = this.settings.lang === 'en' ? 'No recommendation (conflict may be genuine)' : '추천 관계 없음 (모순이 실제일 수 있음)';
		const aiFailText = this.settings.lang === 'en' ? 'AI analysis failed' : 'AI 분석 실패';
		const loadingEl = rankArea.createDiv({ cls: 'tb-conflict-loading', text: loadingText });

		const relLabels: Record<string, string> = this.settings.lang === 'en'
			? { causes: 'Causes', precedes: 'Precedes', precondition_of: 'Precondition', supports: 'Supports', contrasts_with: 'Contrasts', exemplifies: 'Exemplifies', applies_to: 'Applies to', analogous_to: 'Analogous', isomorphic_to: 'Isomorphic' }
			: { causes: '유발', precedes: '선행', precondition_of: '전제조건', supports: '뒷받침', contrasts_with: '대조', exemplifies: '예시', applies_to: '적용', analogous_to: '유사', isomorphic_to: '동형' };

		rankEdgeRelations(
			{ title: this.conflict.nodeA.title, content: this.conflict.nodeA.edges.map(e => e.reason).join(' ') },
			{ title: this.conflict.nodeB.title, content: this.conflict.nodeB.edges.map(e => e.reason).join(' ') },
			this.conflict.evidence,
			this.settings,
		).then(ranks => {
			this.ranks = ranks;
			this.rankLoading = false;
			loadingEl.remove();
			if (ranks.length === 0) {
				rankArea.createDiv({ cls: 'tb-conflict-no-rank', text: noRankText });
				return;
			}
			for (const r of ranks) {
				const chip = rankArea.createDiv({ cls: 'tb-conflict-rank-chip' });
				const pct = Math.round(r.confidence * 100);
				chip.createSpan({ cls: 'tb-rank-label', text: relLabels[r.relation] ?? r.relation });
				chip.createSpan({ cls: 'tb-rank-pct', text: `${pct}%` });
				if (r.reason) chip.createSpan({ cls: 'tb-rank-reason', text: r.reason });
				chip.addEventListener('click', () => { void this.applyReclassify(r.relation, r.reason); });
			}
		}).catch(() => {
			loadingEl.setText(aiFailText);
		});

		contentEl.createEl('hr');

		// ── 옵션 2: 상위 노트 추가 ───────────────────────────────
		const ko = this.settings.lang !== 'en';
		const opt2Label = ko ? '옵션 2 — 상위 개념 노트 추가 (precondition_of)' : 'Option 2 — Add parent premise (precondition_of)';
		contentEl.createDiv({ cls: 'tb-conflict-section-title', text: opt2Label });
		const parentArea = contentEl.createDiv({ cls: 'tb-conflict-parent-area' });

		const contentTextarea = parentArea.createEl('textarea', {
			cls: 'tb-conflict-parent-textarea',
			placeholder: ko ? '상위 개념의 내용을 입력하세요...' : 'Describe the parent concept...',
		});

		const titleRow = parentArea.createDiv({ cls: 'tb-conflict-parent-title-row' });
		const titleInput = titleRow.createEl('input', {
			type: 'text',
			cls: 'tb-conflict-parent-input',
			placeholder: ko ? '제목 (AI가 자동 추론하거나 직접 입력)' : 'Title (AI-inferred or manual)',
		});
		const inferBtn = titleRow.createEl('button', { cls: 'tb-btn tb-btn-sm', text: ko ? 'AI 제목 추론' : 'Infer title' });
		inferBtn.addEventListener('click', () => {
			const body = contentTextarea.value.trim();
			if (!body) { new Notice(ko ? '내용을 먼저 입력해주세요.' : 'Enter content first.'); return; }
			inferBtn.disabled = true;
			inferBtn.textContent = ko ? '추론 중...' : 'Inferring...';
			const prompt = ko
				? `다음 내용을 보고 짧은 제목(한국어 20자 이내, 파일명 특수문자 제외)을 만드세요.\n내용: ${body.slice(0, 800)}\n반드시 JSON만 반환: {"title":"제목"}`
				: `Create a short title (under 25 chars, filename-safe) for:\n${body.slice(0, 800)}\nReturn only JSON: {"title":"title"}`;
			callClaudeWithModel(prompt, 'claude', 'standard',
				this.settings.aiProvider, this.settings.claudeApiKey, this.settings.geminiApiKey, this.settings.openaiApiKey
			).then((raw) => {
				const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { title?: string };
				titleInput.value = (parsed.title ?? '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30);
			}).catch(() => {
				new Notice(ko ? 'AI 제목 추론 실패. 직접 입력해주세요.' : 'Title inference failed. Enter manually.');
			}).finally(() => {
				inferBtn.disabled = false;
				inferBtn.textContent = ko ? 'AI 제목 추론' : 'Infer title';
			});
		});

		const parentBtnLabel = ko ? '노트 생성 후 연결' : 'Create & link note';
		const parentBtn = parentArea.createEl('button', { cls: 'tb-btn', text: parentBtnLabel });
		parentBtn.addEventListener('click', () => {
			const title = titleInput.value.trim();
			const body = contentTextarea.value.trim();
			if (!title) { new Notice(ko ? '제목을 입력하거나 AI로 추론해주세요.' : 'Enter or infer a title first.'); return; }
			void this.applyAddParent(title, body);
		});

		contentEl.createEl('hr');

		// ── 옵션 3: 폐기 (차원별 레이블 분기) ───────────────────
		const opt3Label = this.settings.lang === 'en' ? 'Option 3 — Discard a proposition' : '옵션 3 — 한쪽 명제 폐기';
		contentEl.createDiv({ cls: 'tb-conflict-section-title', text: opt3Label });
		const deleteArea = contentEl.createDiv({ cls: 'tb-conflict-delete-area' });

		const aIsFact = this.conflict.nodeA.proposition_type === 'fact';
		const bIsFact = this.conflict.nodeB.proposition_type === 'fact';
		const delPrefixA = aIsFact ? this.t('conflict_delete_bad_data') : (bIsFact ? this.t('conflict_delete_claim') : this.t('conflict_delete_node'));
		const delPrefixB = bIsFact ? this.t('conflict_delete_bad_data') : (aIsFact ? this.t('conflict_delete_claim') : this.t('conflict_delete_node'));

		const delABtn = deleteArea.createEl('button', { cls: 'tb-btn tb-btn-danger', text: `${delPrefixA}${this.conflict.nodeA.title.slice(0, 28)}` });
		const delBBtn = deleteArea.createEl('button', { cls: 'tb-btn tb-btn-danger', text: `${delPrefixB}${this.conflict.nodeB.title.slice(0, 28)}` });
		delABtn.addEventListener('click', () => { void this.applyDelete(this.conflict.nodeA); });
		delBBtn.addEventListener('click', () => { void this.applyDelete(this.conflict.nodeB); });

		contentEl.createEl('hr');
		const footerText = this.settings.lang === 'en'
			? 'Closing without action keeps the conflict edge in the graph.'
			: '닫기 시 모순 엣지가 그래프에 그대로 유지됩니다.';
		contentEl.createDiv({ cls: 'tb-conflict-footer', text: footerText });
	}

	private async applyReclassify(relation: TBEdgeRelation, reason: string): Promise<void> {
		const nodeAFile = this.app.vault.getAbstractFileByPath(this.conflict.nodeA.filePath);
		if (!(nodeAFile instanceof TFile)) { new Notice('[ThirdBrain] 파일을 찾을 수 없습니다.'); return; }
		try {
			await this.store.replaceEdge(nodeAFile, `[[${this.conflict.nodeB.title}]]`, relation, reason);
			// [Phase 10] 문제 노드에 해소 방법 기록
			const folder = this.conflict.nodeA.filePath.split('/').slice(0, -1).join('/');
			void this.store.resolveContradictionProblem(folder, this.conflict.nodeA.id, this.conflict.nodeB.id, `엣지를 '${relation}'(으)로 재분류하여 해소`);
			new Notice(`[ThirdBrain] 엣지를 '${relation}'(으)로 교체했습니다.`);
			this.close();
			this.onResolved?.(`엣지를 '${relation}'(으)로 재분류`);
		} catch (e) {
			new Notice(`[ThirdBrain] 엣지 교체 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async applyAddParent(parentTitle: string, parentContent: string): Promise<void> {
		const folder = this.conflict.nodeA.filePath.split('/').slice(0, -1).join('/');
		try {
			const body = parentContent.trim() || `${this.conflict.nodeA.title}와 ${this.conflict.nodeB.title}를 포괄하는 상위 전제`;
			const parentNode: Omit<TBNode, 'filePath'> = {
				id: `prop-${Date.now().toString(36)}`,
				title: parentTitle,
				type: 'claim',
				content: body,
				tags: [],
				folder,
				edges: [],
				is_core_concept: true,
				source_span: { text: body.slice(0, 80), offset: 0 },
				created: new Date().toISOString(),
			};
			const parentFile = await this.store.createNode(parentNode);

			// A → 부모, B → 부모 (precondition_of)
			const nodeAFile = this.app.vault.getAbstractFileByPath(this.conflict.nodeA.filePath);
			const nodeBFile = this.app.vault.getAbstractFileByPath(this.conflict.nodeB.filePath);
			const parentWikilink = `[[${parentFile.basename}]]`;
			const edge = (file: TFile) => this.store.confirmEdge(file, {
				target: parentWikilink, label: 'precondition_of', confirmed: true,
				reason: '모순 해소를 위한 상위 전제', confidence: 1.0, axiom_basis: '사용자 지정',
			});
			if (nodeAFile instanceof TFile) {
				await edge(nodeAFile);
				// 기존 conflicts_with 엣지 양방향 제거
				await this.store.removeConflictEdge(nodeAFile, `[[${this.conflict.nodeB.title}]]`);
			}
			if (nodeBFile instanceof TFile) await edge(nodeBFile);

			// [Phase 10] 문제 노드에 해소 방법 기록
			void this.store.resolveContradictionProblem(folder, this.conflict.nodeA.id, this.conflict.nodeB.id, `상위 전제 '${parentTitle}' 추가로 해소`);

			new Notice(`[ThirdBrain] 상위 노트 '${parentTitle}' 생성 및 연결 완료`);
			this.close();
			this.onResolved?.(`상위 전제 '${parentTitle}' 추가됨`);
		} catch (e) {
			new Notice(`[ThirdBrain] 상위 노트 생성 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async applyDelete(node: TBNode): Promise<void> {
		const folder = node.filePath.split('/').slice(0, -1).join('/');
		try {
			await this.store.deleteNodeAndCleanEdges(node, folder);
			// [Phase 10] 문제 노드에 해소 방법 기록 — "거짓 판별로 폐기됨"도 지식으로 남긴다
			void this.store.resolveContradictionProblem(folder, this.conflict.nodeA.id, this.conflict.nodeB.id, `'${node.title}' 폐기(거짓 판별)로 해소`);
			new Notice(`[ThirdBrain] '${node.title}' 삭제 완료`);
			this.close();
			this.onResolved?.(`'${node.title}' 폐기됨`);
		} catch (e) {
			new Notice(`[ThirdBrain] 삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onClose() { this.contentEl.empty(); }
}

// ── 뇌 상태 모달 (폴더별 미션·미연결 → 폴더 드릴인) ──────────
// 미션·미연결은 글로벌 경보가 아니라 "폴더 안에서 아직 안 끝난 일". 숯검댕이 클릭 → 폴더 목록 → 드릴인.
export class BrainStatusModal extends Modal {
	constructor(
		app: App,
		private store: GraphStore,
		private settings: ThirdBrainSettings,
		private onOpenWorkbench: (folder: string, missionId: string) => void,
		private folders: string[],
	) { super(app); }

	private get ko() { return this.settings.lang === 'ko'; }

	async onOpen() {
		this.contentEl.addClass('tb-mission-board');
		await this.renderFolderList();
	}

	// ── Level 1: 폴더 목록 ───────────────────────────────
	private async renderFolderList() {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.ko ? '🧠 뇌 상태' : '🧠 Brain Status');

		let status: BrainFolderStatus[] = [];
		try { status = await this.store.loadBrainStatus(); } catch { /* 로드 실패는 빈 목록 처리 */ }

		if (status.length === 0) {
			contentEl.createDiv({
				cls: 'tb-mission-empty',
				text: this.ko ? '✓ 모든 폴더가 정리됨 — 미션·미연결·모순 없음' : '✓ All folders clear — no missions, unlinked nodes or conflicts',
			});
			return;
		}

		contentEl.createDiv({
			cls: 'tb-mission-sub',
			text: this.ko ? '폴더를 눌러 그 안의 미션·미연결·모순을 처리하세요.' : 'Open a folder to work on its missions, unlinked nodes and conflicts.',
		});

		for (const st of status) {
			const name = st.sessionFolder.split('/').pop() ?? st.sessionFolder;
			const row = contentEl.createEl('button', { cls: 'tb-brain-folder-row' });
			row.createSpan({ cls: 'tb-brain-folder-name', text: `📁 ${name}` });
			const badges = row.createSpan({ cls: 'tb-brain-folder-badges' });
			if (st.conflicts.length > 0) {
				badges.createSpan({ cls: 'tb-brain-badge is-conflict', text: this.ko ? `⚠ 모순 ${st.conflicts.length}` : `⚠ ${st.conflicts.length}` });
			}
			if (st.missions.length > 0) {
				badges.createSpan({ cls: 'tb-brain-badge is-mission', text: this.ko ? `🎯 미션 ${st.missions.length}` : `🎯 ${st.missions.length}` });
			}
			if (st.orphanCount > 0) {
				badges.createSpan({ cls: 'tb-brain-badge is-orphan', text: this.ko ? `◈ 미연결 ${st.orphanCount}` : `◈ ${st.orphanCount}` });
			}
			row.addEventListener('click', () => { this.renderFolderDetail(st); });
		}
	}

	// ── Level 2: 폴더 상세 (미션 인라인 + 미연결 린팅 진입) ──────
	private renderFolderDetail(st: BrainFolderStatus) {
		const { contentEl } = this;
		contentEl.empty();
		const name = st.sessionFolder.split('/').pop() ?? st.sessionFolder;
		this.setTitle(`🧠 ${name}`);

		const back = contentEl.createEl('button', { cls: 'tb-btn tb-content-type-back-btn', text: this.ko ? '← 폴더 목록' : '← Folders' });
		back.addEventListener('click', () => { void this.renderFolderList(); });

		if (st.conflicts.length > 0) {
			contentEl.createDiv({ cls: 'tb-brain-section-title', text: this.ko ? `⚠ 미해소 모순 ${st.conflicts.length}건` : `⚠ Unresolved conflicts (${st.conflicts.length})` });
			for (const c of st.conflicts) this.renderConflictCard(contentEl, c, st);
		}

		if (st.missions.length > 0) {
			contentEl.createDiv({ cls: 'tb-brain-section-title', text: this.ko ? `🎯 미션 ${st.missions.length}건` : `🎯 Missions (${st.missions.length})` });
			for (const p of st.missions) this.renderMissionCard(contentEl, p, st);
		}

		if (st.orphanCount > 0) {
			contentEl.createDiv({ cls: 'tb-brain-section-title', text: this.ko ? `◈ 미연결 명제 ${st.orphanCount}건` : `◈ Unlinked propositions (${st.orphanCount})` });
			contentEl.createDiv({
				cls: 'tb-mission-sub',
				text: this.ko ? '같은 폴더 안에서 AI가 연결 후보를 찾아 붙여줍니다.' : 'AI finds connection candidates within this folder.',
			});
			const linkBtn = contentEl.createEl('button', { cls: 'tb-btn tb-brain-link-btn', text: this.ko ? '연결하기 (AI 린팅)' : 'Connect (AI lint)' });
			linkBtn.addEventListener('click', () => {
				this.close();
				new OrphanQueueModal(
					this.app, this.store, this.settings, this.folders,
					() => { /* 린팅 결과는 모달 자체가 반영 */ },
					st.sessionFolder,
				).open();
			});
		}
	}

	private renderConflictCard(container: HTMLElement, c: ConflictReport, st: BrainFolderStatus) {
		const card = container.createDiv({ cls: 'tb-conflict-notice-row' });
		card.createSpan({ cls: 'tb-conflict-notice-a', text: c.nodeA.title });
		card.createSpan({ cls: 'tb-conflict-notice-vs', text: '⟷' });
		card.createSpan({ cls: 'tb-conflict-notice-b', text: c.nodeB.title });
		const btn = card.createEl('button', { cls: 'tb-btn tb-conflict-resolve-btn', text: this.ko ? '해소하기' : 'Resolve' });
		const resolvedMsg = card.createSpan({ cls: 'tb-conflict-resolved-msg' });
		btn.addEventListener('click', () => {
			new ConflictResolutionModal(this.app, c, this.store, this.settings, (msg) => {
				btn.remove();
				resolvedMsg.textContent = `✓ ${msg}`;
				resolvedMsg.addClass('is-visible');
				st.conflicts = st.conflicts.filter(x => x !== c);
			}).open();
		});
	}

	private renderMissionCard(container: HTMLElement, p: TBNode, st: BrainFolderStatus) {
		const species = p.problem_species ?? 'obstacle';
		const card = container.createDiv({ cls: `tb-problem-card is-${species}` });
		const head = card.createDiv({ cls: 'tb-problem-card-head' });
		head.createSpan({ cls: `tb-problem-species is-${species}`, text: species });
		head.createSpan({ cls: 'tb-problem-title', text: p.title });

		const desc = ((p.content.split('\n---\n')[0] ?? '').trim().split('\n')[0] ?? '').trim();
		if (desc) card.createDiv({ cls: 'tb-problem-desc', text: desc });

		const btnRow = card.createDiv({ cls: 'tb-problem-card-btns' });
		const workbenchBtn = btnRow.createEl('button', { cls: 'tb-btn tb-btn-sm tb-problem-workbench-btn', text: this.ko ? '🎯 작업대' : '🎯 Workbench' });
		workbenchBtn.addEventListener('click', () => {
			this.close();
			this.onOpenWorkbench(st.sessionFolder, p.id);
		});
		// 미션 내용 보기 — 제목·한 줄 요약만으로는 판단이 어려우므로 상세(서술+증거 원문) 열람
		const detailBtn = btnRow.createEl('button', { cls: 'tb-btn tb-btn-sm', text: this.ko ? '내용' : 'Details' });
		detailBtn.addEventListener('click', () => { new ProblemDetailModal(this.app, p).open(); });
		const resolveBtn = btnRow.createEl('button', { cls: 'tb-btn tb-btn-sm tb-problem-resolve-btn', text: this.ko ? '해소' : 'Resolve' });
		resolveBtn.addEventListener('click', () => {
			const file = this.app.vault.getFileByPath(p.filePath);
			if (!file) return;
			void this.store.updateProblemStatus(file, 'resolved', this.ko ? '뇌 상태에서 해소' : 'resolved via brain status').then(() => {
				card.addClass('is-resolved');
				resolveBtn.disabled = true;
				workbenchBtn.disabled = true;
				st.missions = st.missions.filter(m => m.id !== p.id);
			});
		});
	}

	onClose() { this.contentEl.empty(); }
}
