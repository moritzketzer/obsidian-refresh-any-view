import { Component } from 'obsidian';

export class LocalImageRefreshComponent extends Component {
  private readonly containerEl: HTMLElement;
  private version = '';

  public constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }

  public override onload(): void {
    const observer = new MutationObserver(() => {
      this.refreshImages();
    });
    observer.observe(this.containerEl, {
      attributeFilter: ['src'],
      attributes: true,
      childList: true,
      subtree: true
    });
    this.register(() => {
      observer.disconnect();
    });
  }

  public refresh(): void {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Obsidian provides the browser Web Crypto API.
    this.version = window.crypto.randomUUID();
    this.refreshImages();
  }

  private refreshImages(): void {
    for (const image of this.containerEl.querySelectorAll('img[src]')) {
      const src = image.getAttribute('src') ?? '';
      if (!src.startsWith('app://') && !src.startsWith('file://')) {
        continue;
      }

      const url = new URL(src);
      if (url.searchParams.get('refresh-preview') === this.version) {
        continue;
      }

      url.searchParams.set('refresh-preview', this.version);
      image.setAttribute('src', url.href);
    }
  }
}
