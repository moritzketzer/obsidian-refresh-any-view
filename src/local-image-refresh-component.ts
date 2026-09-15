import {
  Component,
  Platform
} from 'obsidian';
import { castTo } from 'obsidian-dev-utils/object-utils';

interface ImageDirectoryWatcher {
  close(): void;
}

export class LocalImageRefreshComponent extends Component {
  private readonly containerEl: HTMLElement;
  private readonly fileVersions = new Map<string, string>();
  private readonly pendingRefreshes = new Map<string, number>();
  private vaultPath = '';
  private version = '';
  private readonly watchers = new Map<string, ImageDirectoryWatcher>();
  private watching = false;

  public constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }

  public override onload(): void {
    const observer = new MutationObserver(() => {
      this.refreshImages();
      this.syncWatchers();
    });
    observer.observe(this.containerEl, {
      attributeFilter: ['src'],
      attributes: true,
      childList: true,
      subtree: true
    });
    this.register(() => {
      observer.disconnect();
      this.setWatching(false);
    });
  }

  public refresh(): void {
    this.version = this.newVersion();
    this.fileVersions.clear();
    this.refreshImages();
  }

  public refreshFile(src: string): void {
    if (!this.watching) {
      return;
    }
    const path = this.getImagePath(src);
    if (path && this.getImages().some((image) => this.getImagePath(image.src) === path)) {
      const previous = this.pendingRefreshes.get(path);
      if (previous !== undefined) {
        window.clearTimeout(previous);
      }
      const WRITE_SETTLE_DELAY_IN_MILLISECONDS = 150;
      this.pendingRefreshes.set(
        path,
        window.setTimeout(() => {
          this.pendingRefreshes.delete(path);
          this.fileVersions.set(path, this.newVersion());
          this.refreshImages();
        }, WRITE_SETTLE_DELAY_IN_MILLISECONDS)
      );
    }
  }

  public setWatching(isEnabled: boolean, vaultResourcePath = ''): void {
    if (isEnabled && !this.watching) {
      this.fileVersions.clear();
    }
    this.watching = isEnabled;
    this.vaultPath = this.getImagePath(vaultResourcePath) ?? '';
    if (isEnabled) {
      this.refreshImages();
      this.syncWatchers();
      return;
    }
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    for (const timeout of this.pendingRefreshes.values()) {
      window.clearTimeout(timeout);
    }
    this.pendingRefreshes.clear();
  }

  private getImagePath(src: string): null | string {
    if (!src.startsWith('app://') && !src.startsWith('file://')) {
      return null;
    }
    try {
      const url = new URL(src);
      return decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }

  private getImages(): HTMLImageElement[] {
    return [...this.containerEl.querySelectorAll<HTMLImageElement>('img[src]')];
  }

  private newVersion(): string {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Obsidian provides the browser Web Crypto API.
    return window.crypto.randomUUID();
  }

  private refreshImages(): void {
    const paths = new Set<string>();
    for (const image of this.getImages()) {
      const path = this.getImagePath(image.src);
      if (!path) {
        continue;
      }
      paths.add(path);
      if (this.watching && !this.fileVersions.has(path)) {
        this.fileVersions.set(path, this.newVersion());
      }
      const version = this.fileVersions.get(path) ?? this.version;
      if (!version) {
        continue;
      }
      const url = new URL(image.src);
      if (url.searchParams.get('refresh-preview') === version) {
        continue;
      }
      url.searchParams.set('refresh-preview', version);
      image.setAttribute('src', url.href);
    }
    for (const path of this.fileVersions.keys()) {
      if (!paths.has(path)) {
        this.fileVersions.delete(path);
      }
    }
  }

  private syncWatchers(): void {
    if (!Platform.isDesktop) {
      return;
    }
    if (!this.watching) {
      return;
    }
    // Electron's renderer resolves Node builtins through require, not browser import().
    /* eslint-disable import-x/no-nodejs-modules, @typescript-eslint/no-require-imports -- Obsidian supplies require on desktop. */
    const { watch } = castTo<typeof import('node:fs')>(require('node:fs'));
    const { basename, dirname } = castTo<typeof import('node:path')>(require('node:path'));
    const { fileURLToPath } = castTo<typeof import('node:url')>(require('node:url'));
    /* eslint-enable import-x/no-nodejs-modules, @typescript-eslint/no-require-imports -- End guarded native imports. */
    const directories = new Set<string>();
    for (const image of this.getImages()) {
      const path = this.getImagePath(image.src);
      if (!path || (this.vaultPath && path.startsWith(`${this.vaultPath.replace(/\/$/, '')}/`))) {
        continue;
      }
      const url = new URL(image.src);
      const fileUrl = url.protocol === 'file:' ? url : new URL(`file://${url.pathname}`);
      const directory = dirname(fileURLToPath(fileUrl));
      directories.add(directory);
      if (this.watchers.has(directory)) {
        continue;
      }
      try {
        // Watch the directory so replacing the file does not leave a watcher on the old inode.
        const watcher = watch(directory, (_event, filename) => {
          for (const currentImage of this.getImages()) {
            const currentPath = this.getImagePath(currentImage.src);
            if (!currentPath) {
              continue;
            }
            const currentUrl = new URL(currentImage.src);
            const currentFileUrl = currentUrl.protocol === 'file:' ? currentUrl : new URL(`file://${currentUrl.pathname}`);
            const nativePath = fileURLToPath(currentFileUrl);
            if (dirname(nativePath) === directory && (filename === null || basename(nativePath) === filename)) {
              this.refreshFile(currentImage.src);
            }
          }
        });
        watcher.on('error', (error) => {
          console.error('Refresh Any View: cannot watch image directory', directory, error);
          watcher.close();
          this.watchers.delete(directory);
        });
        this.watchers.set(directory, watcher);
      } catch (error) {
        console.error('Refresh Any View: cannot watch image directory', directory, error);
      }
    }
    for (const [directory, watcher] of this.watchers) {
      if (directories.has(directory)) {
        continue;
      }

      watcher.close();
      this.watchers.delete(directory);
    }
  }
}
