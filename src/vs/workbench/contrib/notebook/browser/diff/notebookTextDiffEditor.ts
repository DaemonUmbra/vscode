/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as DOM from 'vs/base/browser/dom';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { EditorOptions, IEditorOpenContext } from 'vs/workbench/common/editor';
import { notebookCellBorder, NotebookEditorWidget, notebookOutputContainerColor } from 'vs/workbench/contrib/notebook/browser/notebookEditorWidget';
import { IEditorGroup } from 'vs/workbench/services/editor/common/editorGroupsService';
import { NotebookDiffEditorInput } from '../notebookDiffEditorInput';
import { CancellationToken } from 'vs/base/common/cancellation';
import { WorkbenchList } from 'vs/platform/list/browser/listService';
import { CellDiffViewModel } from 'vs/workbench/contrib/notebook/browser/diff/celllDiffViewModel';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { CellDiffRenderer, NotebookCellTextDiffListDelegate, NotebookTextDiffList } from 'vs/workbench/contrib/notebook/browser/diff/notebookTextDiffList';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { diffDiagonalFill, editorBackground, focusBorder, foreground } from 'vs/platform/theme/common/colorRegistry';
import { INotebookEditorWorkerService } from 'vs/workbench/contrib/notebook/common/services/notebookWorkerService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { BareFontInfo } from 'vs/editor/common/config/fontInfo';
import { getZoomLevel } from 'vs/base/browser/browser';
import { NotebookLayoutInfo } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { INotebookTextDiffEditor } from 'vs/workbench/contrib/notebook/browser/diff/common';
import { Emitter } from 'vs/base/common/event';
import { IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { NotebookDiffEditorEventDispatcher, NotebookLayoutChangedEvent } from 'vs/workbench/contrib/notebook/browser/viewModel/eventDispatcher';
import { EditorPane } from 'vs/workbench/browser/parts/editor/editorPane';

export class NotebookTextDiffEditor extends EditorPane implements INotebookTextDiffEditor {
	static readonly ID: string = 'workbench.editor.notebookTextDiffEditor';

	private _rootElement!: HTMLElement;
	private _dimension: DOM.Dimension | null = null;
	private _list!: WorkbenchList<CellDiffViewModel>;
	private _fontInfo: BareFontInfo | undefined;

	private readonly _onMouseUp = this._register(new Emitter<{ readonly event: MouseEvent; readonly target: CellDiffViewModel; }>());
	public readonly onMouseUp = this._onMouseUp.event;
	private _eventDispatcher: NotebookDiffEditorEventDispatcher | undefined;

	constructor(
		@IInstantiationService readonly instantiationService: IInstantiationService,
		@IThemeService readonly themeService: IThemeService,
		@IContextKeyService readonly contextKeyService: IContextKeyService,
		@INotebookEditorWorkerService readonly notebookEditorWorkerService: INotebookEditorWorkerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,

		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService storageService: IStorageService,
	) {
		super(NotebookTextDiffEditor.ID, telemetryService, themeService, storageService);
		const editorOptions = this.configurationService.getValue<IEditorOptions>('editor');
		this._fontInfo = BareFontInfo.createFromRawSettings(editorOptions, getZoomLevel());
	}

	protected createEditor(parent: HTMLElement): void {
		this._rootElement = DOM.append(parent, DOM.$('.notebook-text-diff-editor'));

		const renderer = this.instantiationService.createInstance(CellDiffRenderer, this);

		this._list = this.instantiationService.createInstance(
			NotebookTextDiffList,
			'NotebookTextDiff',
			this._rootElement,
			this.instantiationService.createInstance(NotebookCellTextDiffListDelegate),
			[
				renderer
			],
			this.contextKeyService,
			{
				setRowLineHeight: false,
				setRowHeight: false,
				supportDynamicHeights: true,
				horizontalScrolling: false,
				keyboardSupport: false,
				mouseSupport: true,
				multipleSelectionSupport: false,
				enableKeyboardNavigation: true,
				additionalScrollHeight: 0,
				// transformOptimization: (isMacintosh && isNative) || getTitleBarStyle(this.configurationService, this.environmentService) === 'native',
				styleController: (_suffix: string) => { return this._list!; },
				overrideStyles: {
					listBackground: editorBackground,
					listActiveSelectionBackground: editorBackground,
					listActiveSelectionForeground: foreground,
					listFocusAndSelectionBackground: editorBackground,
					listFocusAndSelectionForeground: foreground,
					listFocusBackground: editorBackground,
					listFocusForeground: foreground,
					listHoverForeground: foreground,
					listHoverBackground: editorBackground,
					listHoverOutline: focusBorder,
					listFocusOutline: focusBorder,
					listInactiveSelectionBackground: editorBackground,
					listInactiveSelectionForeground: foreground,
					listInactiveFocusBackground: editorBackground,
					listInactiveFocusOutline: editorBackground,
				},
				accessibilityProvider: {
					getAriaLabel() { return null; },
					getWidgetAriaLabel() {
						return nls.localize('notebookTreeAriaLabel', "Notebook Text Diff");
					}
				},
				// focusNextPreviousDelegate: {
				// 	onFocusNext: (applyFocusNext: () => void) => this._updateForCursorNavigationMode(applyFocusNext),
				// 	onFocusPrevious: (applyFocusPrevious: () => void) => this._updateForCursorNavigationMode(applyFocusPrevious),
				// }
			}
		);

		this._register(this._list.onMouseUp(e => {
			if (e.element) {
				this._onMouseUp.fire({ event: e.browserEvent, target: e.element });
			}
		}));
	}

	async setInput(input: NotebookDiffEditorInput, options: EditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const model = await input.resolve();
		if (model === null) {
			return;
		}

		this._eventDispatcher = new NotebookDiffEditorEventDispatcher();

		const diffResult = await this.notebookEditorWorkerService.computeDiff(model.original.resource, model.modified.resource);
		const cellChanges = diffResult.cellsDiff.changes;

		const cellDiffViewModels: CellDiffViewModel[] = [];
		const originalModel = model.original.notebook;
		const modifiedModel = model.modified.notebook;
		let originalCellIndex = 0;
		let modifiedCellIndex = 0;

		for (let i = 0; i < cellChanges.length; i++) {
			const change = cellChanges[i];
			// common cells

			cellDiffViewModels.push(...originalModel.cells.slice(originalCellIndex, change.originalStart).map(cell => {
				return new CellDiffViewModel(
					cell,
					undefined,
					'unchanged',
					this._eventDispatcher!
				);
			}));

			// modified cells
			const modifiedLen = Math.min(change.originalLength, change.modifiedLength);

			for (let j = 0; j < modifiedLen; j++) {
				cellDiffViewModels.push(new CellDiffViewModel(
					originalModel.cells[change.originalStart + j],
					modifiedModel.cells[change.modifiedStart + j],
					'modified',
					this._eventDispatcher!
				));
			}

			for (let j = modifiedLen; j < change.originalLength; j++) {
				// deletion
				cellDiffViewModels.push(new CellDiffViewModel(
					originalModel.cells[change.originalStart + j],
					undefined,
					'delete',
					this._eventDispatcher!
				));
			}

			for (let j = modifiedLen; j < change.modifiedLength; j++) {
				// insertion
				cellDiffViewModels.push(new CellDiffViewModel(
					undefined,
					modifiedModel.cells[change.modifiedStart + j],
					'insert',
					this._eventDispatcher!
				));
			}

			originalCellIndex = change.originalStart + change.originalLength;
			modifiedCellIndex = change.modifiedStart + change.modifiedLength;
		}

		for (let i = originalCellIndex; i < originalModel.cells.length; i++) {
			cellDiffViewModels.push(new CellDiffViewModel(
				originalModel.cells[i],
				undefined,
				'delete',
				this._eventDispatcher!
			));
		}

		for (let i = modifiedCellIndex; i < modifiedModel.cells.length; i++) {
			cellDiffViewModels.push(new CellDiffViewModel(
				undefined,
				modifiedModel.cells[i],
				'insert',
				this._eventDispatcher!
			));
		}

		this._list.splice(0, this._list.length, cellDiffViewModels);
	}

	private pendingLayouts = new WeakMap<CellDiffViewModel, IDisposable>();


	layoutNotebookCell(cell: CellDiffViewModel, height: number) {
		const relayout = (cell: CellDiffViewModel, height: number) => {
			const viewIndex = this._list!.indexOf(cell);

			this._list?.updateElementHeight(viewIndex, height);
		};

		if (this.pendingLayouts.has(cell)) {
			this.pendingLayouts.get(cell)!.dispose();
		}

		let r: () => void;
		const layoutDisposable = DOM.scheduleAtNextAnimationFrame(() => {
			this.pendingLayouts.delete(cell);

			relayout(cell, height);
			r();
		});

		this.pendingLayouts.set(cell, toDisposable(() => {
			layoutDisposable.dispose();
			r();
		}));

		return new Promise(resolve => { r = resolve; });
	}

	getDomNode() {
		return this._rootElement;
	}

	getControl(): NotebookEditorWidget | undefined {
		return undefined;
	}

	setEditorVisible(visible: boolean, group: IEditorGroup | undefined): void {
		super.setEditorVisible(visible, group);
	}

	focus() {
		super.focus();
	}

	clearInput(): void {
		super.clearInput();
	}

	getLayoutInfo(): NotebookLayoutInfo {
		if (!this._list) {
			throw new Error('Editor is not initalized successfully');
		}

		return {
			width: this._dimension!.width,
			height: this._dimension!.height,
			fontInfo: this._fontInfo!
		};
	}

	layout(dimension: DOM.Dimension): void {
		this._rootElement.classList.toggle('mid-width', dimension.width < 1000 && dimension.width >= 600);
		this._rootElement.classList.toggle('narrow-width', dimension.width < 600);
		this._dimension = dimension;
		this._rootElement.style.height = `${dimension.height}px`;

		this._list?.layout(this._dimension.height, this._dimension.width);
		this._eventDispatcher?.emit([new NotebookLayoutChangedEvent({ width: true, fontInfo: true }, this.getLayoutInfo())]);
	}
}

registerThemingParticipant((theme, collector) => {
	const cellBorderColor = theme.getColor(notebookCellBorder);
	if (cellBorderColor) {
		collector.addRule(`.notebook-text-diff-editor .cell-body { border: 1px solid ${cellBorderColor};}`);
		collector.addRule(`.notebook-text-diff-editor .metadata-editor-container {
			border-top: 1px solid ${cellBorderColor}
		}`);
		collector.addRule(`.notebook-text-diff-editor .cell-diff-editor-container .metadata-header-container {
			border-top: 1px solid ${cellBorderColor};
		}`);
	}

	const diffDiagonalFillColor = theme.getColor(diffDiagonalFill);
	collector.addRule(`
	.notebook-text-diff-editor .diagonal-fill {
		background-image: linear-gradient(
			-45deg,
			${diffDiagonalFillColor} 12.5%,
			#0000 12.5%, #0000 50%,
			${diffDiagonalFillColor} 50%, ${diffDiagonalFillColor} 62.5%,
			#0000 62.5%, #0000 100%
		);
		background-size: 8px 8px;
	}
	`);

	const containerBackground = theme.getColor(notebookOutputContainerColor);
	if (containerBackground) {
		collector.addRule(`.notebook-text-diff-editor .cell-diff-editor-container .metadata-header-container { background-color: ${containerBackground}; }`);
	}

});