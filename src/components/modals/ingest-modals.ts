import { App, Modal } from 'obsidian';
import { getT } from '../../i18n';
import type { TKey, Lang } from '../../i18n';
import type { ContentType, MeetingType, DialogueSubtype } from '../../types';
import { makeDraggable } from './shared';

export interface ContentTypeSelection {
	contentType: ContentType;
	includeActionLayer: boolean;
	meetingType?: MeetingType;
	dialogueSubtype?: DialogueSubtype;
}

// ── 콘텐츠 타입 선택 모달 ────────────────────────────────
export class ContentTypeModal extends Modal {
	private resolved = false;
	private lang: Lang;

	constructor(
		app: App,
		private onSelect: (result: ContentTypeSelection | null) => void,
		lang?: Lang
	) {
		super(app);
		this.lang = lang ?? 'en';
	}

	private t(key: TKey): string { return getT(this.lang)(key); }

	private resolve(result: ContentTypeSelection | null) {
		if (this.resolved) return;
		this.resolved = true;
		this.onSelect(result);
	}

	onOpen() {
		this.modalEl.addClass('tb-popup');
		this.renderTypeScreen();
	}

	private renderTypeScreen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_content_type_title') });
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_content_type_sub') });

		const row = contentEl.createEl('div', { cls: 'tb-content-type-modal-row' });

		// 정보/문서
		const btnDoc = row.createEl('button', { cls: 'tb-content-type-btn', text: this.t('modal_content_type_document') });
		btnDoc.addEventListener('click', () => {
			this.resolve({ contentType: 'document', includeActionLayer: false });
			this.close();
		});

		// 강의
		const btnLecture = row.createEl('button', { cls: 'tb-content-type-btn', text: this.t('modal_content_type_lecture') });
		btnLecture.addEventListener('click', () => {
			this.resolve({ contentType: 'lecture', includeActionLayer: false });
			this.close();
		});

		// 회의
		const btnMeeting = row.createEl('button', { cls: 'tb-content-type-btn', text: this.t('modal_content_type_meeting') });
		btnMeeting.addEventListener('click', () => { this.renderMeetingSubtypeScreen(); });

		// 대화
		const btnDialogue = row.createEl('button', { cls: 'tb-content-type-btn', text: this.t('modal_content_type_dialogue') });
		btnDialogue.addEventListener('click', () => { this.renderDialogueSubtypeScreen(); });
	}

	private renderMeetingSubtypeScreen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_content_type_subtype_title') });
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_content_type_subtype_sub') });

		const row = contentEl.createEl('div', { cls: 'tb-content-type-modal-row' });
		const types: Array<{ key: TKey; val: MeetingType }> = [
			{ key: 'modal_content_type_brainstorm', val: 'brainstorm' },
			{ key: 'modal_content_type_execution',  val: 'execution' },
			{ key: 'modal_content_type_review',     val: 'review' },
		];
		for (const { key, val } of types) {
			const btn = row.createEl('button', { cls: 'tb-content-type-btn', text: this.t(key) });
			btn.addEventListener('click', () => {
				this.resolve({ contentType: 'meeting', includeActionLayer: true, meetingType: val });
				this.close();
			});
		}

		const backBtn = contentEl.createEl('button', { cls: 'tb-btn tb-content-type-back-btn', text: '← 뒤로' });
		backBtn.addEventListener('click', () => { this.renderTypeScreen(); });
	}

	private renderDialogueSubtypeScreen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_content_type_dialogue') });
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_content_type_dialogue_sub') });

		const row = contentEl.createEl('div', { cls: 'tb-content-type-modal-row' });
		const types: Array<{ key: TKey; val: DialogueSubtype }> = [
			{ key: 'modal_content_type_dialogue_english',   val: 'english_conversation' },
			{ key: 'modal_content_type_dialogue_call',      val: 'phone_call' },
			{ key: 'modal_content_type_dialogue_interview', val: 'interview' },
		];
		for (const { key, val } of types) {
			const btn = row.createEl('button', { cls: 'tb-content-type-btn', text: this.t(key) });
			btn.addEventListener('click', () => {
				this.resolve({ contentType: 'dialogue', includeActionLayer: false, dialogueSubtype: val });
				this.close();
			});
		}

		const backBtn = contentEl.createEl('button', { cls: 'tb-btn tb-content-type-back-btn', text: '← 뒤로' });
		backBtn.addEventListener('click', () => { this.renderTypeScreen(); });
	}

	onClose() {
		this.contentEl.empty();
		this.resolve(null);
	}
}

// ── 저장 폴더 선택 모달 ──────────────────────────────────
export class SaveFolderModal extends Modal {
	private folders: string[];
	private currentFolder: string;
	private onChoose: (folder: string) => void;
	private lang: Lang;
	private rootFolder: string;

	constructor(
		app: App,
		folders: string[],
		currentFolder: string,
		onChoose: (folder: string) => void,
		lang?: Lang,
		rootFolder = ''
	) {
		super(app);
		this.folders = folders;
		this.currentFolder = currentFolder;
		this.onChoose = onChoose;
		this.lang = lang ?? 'en';
		this.rootFolder = rootFolder;
		this.modalEl.addClass('tb-popup');
	}

	private t(key: TKey): string { return getT(this.lang)(key); }

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tb-popup-content');

		const titleEl = contentEl.createEl('div', { cls: 'tb-popup-title', text: this.t('modal_save_folder_title') });
		makeDraggable(this.modalEl, titleEl);
		contentEl.createEl('div', { cls: 'tb-popup-sub', text: this.t('modal_save_folder_sub') });

		const list = contentEl.createEl('div', { cls: 'tb-popup-folder-list' });

		// rootFolder 자체는 선택 불가 — 서브폴더만 선택 가능
		let selected = (this.rootFolder && this.currentFolder === this.rootFolder) ? '' : this.currentFolder;

		const items: Array<{ el: HTMLElement; path: string }> = [];

		const updateSelected = () => {
			for (const item of items) {
				item.el.toggleClass('is-selected', item.path === selected);
			}
		};

		if (this.rootFolder) {
			// rootFolder 모드: 최상위 루트 아이템은 헤더 표시만 — 선택 불가
			const rootItem = list.createEl('div', { cls: 'tb-popup-folder-item tb-popup-folder-header' });
			rootItem.createEl('span', { cls: 'tb-popup-folder-icon', text: '🏠' });
			rootItem.createEl('span', { cls: 'tb-popup-folder-name', text: this.rootFolder });

			// rootFolder 하위 폴더 표시 (raw/ 제외, depth는 rootFolder 기준 상대 계산)
			const rootDepth = this.rootFolder.split('/').length;
			const rawPath = `${this.rootFolder}/raw`;
			for (const folder of this.folders) {
				if (folder === this.rootFolder) continue;
				if (folder === rawPath || folder.startsWith(rawPath + '/')) continue; // raw/ 숨김
				const depth = folder.split('/').length - rootDepth;
				const name = folder.split('/').pop() ?? folder;
				const item = list.createEl('div', { cls: 'tb-popup-folder-item' });
				item.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
				item.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
				item.createEl('span', { cls: 'tb-popup-folder-name', text: name });
				item.addEventListener('click', () => { selected = folder; updateSelected(); });
				items.push({ el: item, path: folder });
			}
		} else {
			// 레거시 모드: 볼트 루트 포함 전체 폴더 표시
			const rootItem = list.createEl('div', { cls: 'tb-popup-folder-item' });
			rootItem.createEl('span', { cls: 'tb-popup-folder-icon', text: '🏠' });
			rootItem.createEl('span', { cls: 'tb-popup-folder-name', text: this.t('modal_save_folder_root') });
			rootItem.addEventListener('click', () => { selected = ''; updateSelected(); });
			items.push({ el: rootItem, path: '' });

			for (const folder of this.folders) {
				const depth = folder.split('/').length - 1;
				const name = folder.split('/').pop() ?? folder;
				const item = list.createEl('div', { cls: 'tb-popup-folder-item' });
				item.setCssStyles({ paddingLeft: `${14 + depth * 18}px` });
				item.createEl('span', { cls: 'tb-popup-folder-icon', text: depth > 0 ? '↳' : '📁' });
				item.createEl('span', { cls: 'tb-popup-folder-name', text: name });
				item.addEventListener('click', () => { selected = folder; updateSelected(); });
				items.push({ el: item, path: folder });
			}
		}

		updateSelected();

		// 새 폴더 만들기 (rootFolder 모드에서만)
		if (this.rootFolder) {
			const newFolderRow = contentEl.createEl('div', { cls: 'tb-popup-new-folder-row' });
			const newFolderInput = newFolderRow.createEl('input', {
				cls: 'tb-popup-new-folder-input',
				attr: { type: 'text', placeholder: this.t('modal_save_folder_new_placeholder') },
			});
			const newFolderBtn = newFolderRow.createEl('button', {
				cls: 'tb-btn tb-popup-new-folder-btn',
				text: this.t('modal_save_folder_new_btn'),
			});

			const createNewFolder = () => {
				const raw = newFolderInput.value.trim();
				if (!raw) return;
				const safeName = raw.replace(/[\\/:*?"<>|#^[\]]/g, '_').replace(/\s+/g, '_');
				const newPath = `${this.rootFolder}/${safeName}`;
				// 목록에 추가 + 선택
				const item = list.createEl('div', { cls: 'tb-popup-folder-item' });
				item.setCssStyles({ paddingLeft: '32px' });
				item.createEl('span', { cls: 'tb-popup-folder-icon', text: '↳' });
				item.createEl('span', { cls: 'tb-popup-folder-name', text: safeName });
				item.addEventListener('click', () => { selected = newPath; updateSelected(); });
				items.push({ el: item, path: newPath });
				selected = newPath;
				updateSelected();
				newFolderInput.value = '';
			};

			newFolderBtn.addEventListener('click', createNewFolder);
			newFolderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createNewFolder(); });
		}

		const footer = contentEl.createEl('div', { cls: 'tb-popup-footer' });
		footer.createEl('button', { cls: 'tb-btn', text: this.t('btn_cancel') })
			.addEventListener('click', () => this.close());
		footer.createEl('button', { cls: 'tb-btn is-primary', text: this.t('btn_save') })
			.addEventListener('click', () => { this.close(); this.onChoose(selected); });
	}

	onClose() { this.contentEl.empty(); }
}
