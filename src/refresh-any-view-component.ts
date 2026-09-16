import type { App } from 'obsidian';

import {
  FileView,
  ItemView,
  MarkdownView,
  TAbstractFile,
  TextFileView,
  View,
  WorkspaceLeaf
} from 'obsidian';
import {
  convertAsyncToSync,
  invokeAsyncSafely
} from 'obsidian-dev-utils/async';
import { registerAsyncEvent } from 'obsidian-dev-utils/obsidian/components/async-events-component';
import { LayoutReadyComponent } from 'obsidian-dev-utils/obsidian/components/layout-ready-component';
import { isFile } from 'obsidian-dev-utils/obsidian/file-system';
import { getCacheSafe } from 'obsidian-dev-utils/obsidian/metadata-cache';

import type { PluginSettingsComponent } from './plugin-settings-component.ts';

import { LocalImageRefreshComponent } from './local-image-refresh-component.ts';
import { WorkspaceLeafOnOpenTabHeaderMenuPatchComponent } from './patches/workspace-leaf-on-open-tab-header-menu-patch-component.ts';
import { AutoRefreshMode } from './plugin-settings.ts';

interface RefreshAnyViewComponentConstructorParams {
  readonly app: App;
  readonly pluginSettingsComponent: PluginSettingsComponent;
}

export class RefreshAnyViewComponent extends LayoutReadyComponent {
  private autoRefreshIntervalId: null | number = null;

  private readonly itemViews = new WeakSet<ItemView>();
  private readonly lightboxImageRefreshComponents = new Map<HTMLElement, LocalImageRefreshComponent>();
  private readonly lightboxObservers = new Map<Document, MutationObserver>();
  private readonly localImageRefreshComponents = new Map<View, LocalImageRefreshComponent>();
  private readonly pluginSettingsComponent: PluginSettingsComponent;

  public constructor(params: RefreshAnyViewComponentConstructorParams) {
    super(params.app);
    this.pluginSettingsComponent = params.pluginSettingsComponent;
  }

  public getActiveView(): null | View {
    return this.app.workspace.getActiveViewOfType(View);
  }

  public override onload(): void {
    super.onload();
    this.registerEvent(this.app.workspace.on('layout-change', this.handleLayoutChange.bind(this)));
    registerAsyncEvent(
      this,
      this.pluginSettingsComponent.on('loadSettings', () => {
        this.syncImageWatching();
      })
    );
    this.register(() => {
      for (const [view, component] of this.localImageRefreshComponents) {
        view.removeChild(component);
      }
      this.localImageRefreshComponents.clear();
      for (const observer of this.lightboxObservers.values()) {
        observer.disconnect();
      }
      this.lightboxObservers.clear();
      this.lightboxImageRefreshComponents.clear();
    });
  }

  public async refreshAllOpenViews(): Promise<void> {
    await this.refreshViews(() => true);
  }

  public async refreshAllVisibleViews(): Promise<void> {
    await this.refreshViews(this.isVisibleView.bind(this));
  }

  public async refreshView(view: View): Promise<void> {
    const leaf = view.leaf;

    const viewScrollTop = view.containerEl.scrollTop;
    const viewScrollLeft = view.containerEl.scrollLeft;

    await leaf.loadIfDeferred();

    if (view instanceof TextFileView && view.dirty) {
      await view.save();
    }

    if (view instanceof MarkdownView) {
      if (view.file) {
        await getCacheSafe(this.app, view.file);
      }

      if (view.getMode() === 'preview') {
        if (this.pluginSettingsComponent.settings.shouldUseQuickMarkdownViewRefresh) {
          view.previewMode.rerender(true);
        } else {
          await leaf.rebuildView();
        }

        this.refreshLocalImages(leaf.view);
        restoreScrollPosition();

        return;
      }

      let cm = view.editor.cm;
      const scrollTop = cm.scrollDOM.scrollTop;
      const text = cm.state.doc;
      const selection = cm.state.selection;
      if (this.pluginSettingsComponent.settings.shouldUseQuickMarkdownViewRefresh) {
        cm.dispatch({
          changes: {
            from: 0,
            to: text.length
          }
        });
        cm.dispatch({
          changes: {
            from: 0,
            insert: text,
            to: 0
          },
          selection
        });
      } else {
        await leaf.rebuildView();
        // eslint-disable-next-line require-atomic-updates -- Ignore possible race condition.
        cm = view.editor.cm;
      }
      window.requestAnimationFrame(() => {
        cm.scrollDOM.scrollTop = scrollTop;
      });
      this.refreshLocalImages(leaf.view);
      return;
    }

    await leaf.rebuildView();
    this.refreshLocalImages(leaf.view);
    restoreScrollPosition();

    function restoreScrollPosition(): void {
      window.requestAnimationFrame(() => {
        view.containerEl.scrollTop = viewScrollTop;
        view.containerEl.scrollLeft = viewScrollLeft;
      });
    }
  }

  protected override async onLayoutReady(): Promise<void> {
    this.handleLayoutChange();
    this.registerEvent(this.app.vault.on('modify', this.handleModify.bind(this)));
    await this.loadDeferredViews();
    this.registerAutoRefreshTimer();

    registerAsyncEvent(
      this,
      this.pluginSettingsComponent.on('saveSettings', () => {
        this.registerAutoRefreshTimer();
        this.syncImageWatching();
      })
    );

    this.addChild(new WorkspaceLeafOnOpenTabHeaderMenuPatchComponent(this));
  }

  private canAutoRefreshView(view: View): boolean {
    if (!this.pluginSettingsComponent.settings.isViewTypeIncluded(view.getViewType())) {
      return false;
    }

    if (view.leaf.isDeferred && !this.pluginSettingsComponent.settings.shouldLoadDeferredViewsOnAutoRefresh) {
      return false;
    }

    if (view instanceof MarkdownView && view.getMode() === 'source' && !this.pluginSettingsComponent.settings.shouldAutoRefreshMarkdownViewInSourceMode) {
      return false;
    }

    return true;
  }

  private async executeKeepingFocus(callback: () => Promise<void>): Promise<void> {
    const activeElement = activeDocument.activeElement;
    try {
      await callback();
    } finally {
      if (activeElement instanceof HTMLElement) {
        activeElement.focus();
      }
    }
  }

  private getLeaves(checkLeaf: (leaf: WorkspaceLeaf) => boolean): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (checkLeaf(leaf)) {
        leaves.push(leaf);
      }
    });
    return leaves;
  }

  private getLocalImageRefreshComponent(view: View): LocalImageRefreshComponent {
    let component = this.localImageRefreshComponents.get(view);
    if (!component) {
      component = view.addChild(new LocalImageRefreshComponent(view.containerEl));
      this.localImageRefreshComponents.set(view, component);
      view.register(() => {
        this.localImageRefreshComponents.delete(view);
      });
    }
    return component;
  }

  private handleLayoutChange(): void {
    this.syncImageWatching();
    const itemView = this.app.workspace.getActiveViewOfType(ItemView);
    if (!itemView) {
      return;
    }

    if (this.itemViews.has(itemView)) {
      return;
    }
    this.itemViews.add(itemView);

    const buttonEl = itemView.addAction('refresh-cw', 'Refresh view', convertAsyncToSync(async () => this.refreshView(itemView)));

    this.register(() => {
      buttonEl.remove();
    });
  }

  private handleModify(file: TAbstractFile): void {
    if (this.pluginSettingsComponent.settings.shouldAutoRefreshEmbeddedImages && isFile(file)) {
      for (const component of [...this.localImageRefreshComponents.values(), ...this.lightboxImageRefreshComponents.values()]) {
        component.refreshFile(this.app.vault.getResourcePath(file));
      }
    }
    if (!this.pluginSettingsComponent.settings.shouldAutoRefreshOnFileChange) {
      return;
    }

    if (!isFile(file)) {
      return;
    }

    invokeAsyncSafely(() => this.refreshViews((view) => view instanceof FileView && view.file === file && this.canAutoRefreshView(view)));
  }

  private isMatchingAutoRefreshMode(view: View): boolean {
    switch (this.pluginSettingsComponent.settings.autoRefreshMode) {
      case AutoRefreshMode.ActiveView: {
        return view === this.app.workspace.getActiveViewOfType(View);
      }
      case AutoRefreshMode.AllOpenViews: {
        return true;
      }
      case AutoRefreshMode.AllVisibleViews: {
        return view.leaf.isVisible();
      }
      case AutoRefreshMode.Off: {
        return false;
      }
      default: {
        return false;
      }
    }
  }

  private isVisibleView(view: View): boolean {
    return view.leaf.isVisible();
  }

  private async loadDeferredViews(): Promise<void> {
    if (!this.pluginSettingsComponent.settings.shouldLoadDeferredViewsOnStart) {
      return;
    }

    const DELAY_IN_MILLISECONDS = 100;
    await sleep(DELAY_IN_MILLISECONDS);

    const leaves = this.getLeaves(() => true);
    const promises = leaves.map((leaf) => leaf.loadIfDeferred());
    await Promise.all(promises);
  }

  private refreshLocalImages(view: View): void {
    this.getLocalImageRefreshComponent(view).refresh();
  }

  private async refreshViews(checkView: (view: View) => boolean): Promise<void> {
    const leaves = this.getLeaves((leaf) => checkView(leaf.view));

    await this.executeKeepingFocus(async () => {
      const promises = leaves.map((leaf) => this.refreshView(leaf.view));
      await Promise.all(promises);
    });
  }

  private registerAutoRefreshTimer(): void {
    const MILLISECONDS_IN_SECOND = 1000;
    if (this.autoRefreshIntervalId) {
      window.clearInterval(this.autoRefreshIntervalId);
      this.autoRefreshIntervalId = null;
    }

    if (this.pluginSettingsComponent.settings.autoRefreshMode === AutoRefreshMode.Off) {
      return;
    }

    this.autoRefreshIntervalId = window.setInterval(
      () => {
        invokeAsyncSafely(() => this.refreshViews((view) => this.isMatchingAutoRefreshMode(view) && this.canAutoRefreshView(view)));
      },
      this.pluginSettingsComponent.settings.autoRefreshIntervalInSeconds * MILLISECONDS_IN_SECOND
    );

    this.registerInterval(this.autoRefreshIntervalId);
  }

  private syncImageWatching(): void {
    const isEnabled = this.pluginSettingsComponent.settings.shouldAutoRefreshEmbeddedImages;
    const documents = new Set<Document>();
    if (isEnabled) {
      for (const leaf of this.getLeaves((candidate) => !candidate.isDeferred)) {
        this.getLocalImageRefreshComponent(leaf.view);
        documents.add(leaf.view.containerEl.ownerDocument);
      }
    }
    for (const [view, component] of this.localImageRefreshComponents) {
      component.setWatching(isEnabled && this.pluginSettingsComponent.settings.isViewTypeIncluded(view.getViewType()), isEnabled ? this.app.vault.adapter.getResourcePath('') : '');
    }
    this.syncLightboxImages(documents);
  }

  private syncLightboxImages(documents: ReadonlySet<Document>): void {
    const lightboxElements = new Set<HTMLElement>();
    for (const doc of documents) {
      if (!this.lightboxObservers.has(doc)) {
        // Obsidian appends its zoom viewer directly to the body, outside every View.
        const observer = new MutationObserver(() => {
          this.syncImageWatching();
        });
        observer.observe(doc.body, { childList: true });
        this.lightboxObservers.set(doc, observer);
      }
      for (const lightbox of doc.body.querySelectorAll<HTMLElement>(':scope > .lightbox')) {
        lightboxElements.add(lightbox);
        if (!this.lightboxImageRefreshComponents.has(lightbox)) {
          const component = this.addChild(new LocalImageRefreshComponent(lightbox));
          this.lightboxImageRefreshComponents.set(lightbox, component);
          component.setWatching(true, this.app.vault.adapter.getResourcePath(''));
        }
      }
    }
    for (const [lightbox, component] of this.lightboxImageRefreshComponents) {
      if (lightboxElements.has(lightbox)) {
        continue;
      }

      this.removeChild(component);
      this.lightboxImageRefreshComponents.delete(lightbox);
    }
    for (const [doc, observer] of this.lightboxObservers) {
      if (documents.has(doc)) {
        continue;
      }

      observer.disconnect();
      this.lightboxObservers.delete(doc);
    }
  }
}
