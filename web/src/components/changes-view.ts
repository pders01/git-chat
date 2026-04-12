import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { repoClient } from "../lib/transport.js";
import type { StatusFile } from "../gen/gitchat/v1/repo_pb.js";
import { onChange as onSettingsChange } from "../lib/settings.js";

let highlightModule: Promise<typeof import("../lib/highlight.js")> | null = null;
function loadHighlight() {
  if (!highlightModule) highlightModule = import("../lib/highlight.js");
  return highlightModule;
}

function statusLabel(status: string): string {
  switch (status) {
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    default: return "M";
  }
}

function fileName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

@customElement("gc-changes-view")
export class GcChangesView extends LitElement {
  @property({ type: String }) repoId = "";

  @state() private staged: StatusFile[] = [];
  @state() private unstaged: StatusFile[] = [];
  @state() private untracked: StatusFile[] = [];
  @state() private selectedFile = "";
  @state() private diffHtml = "";
  @state() private diffLoading = false;
  @state() private diffError = "";
  @state() private statusLoading = true;
  @state() private statusError = "";
  private loadGeneration = 0;
  private rawDiff = "";
  private unsubSettings: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubSettings = onSettingsChange(() => void this.rehighlight());
    if (this.repoId) void this.loadStatus();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubSettings?.();
    this.unsubSettings = null;
  }

  private async rehighlight() {
    if (!this.rawDiff) return;
    const { highlight } = await loadHighlight();
    this.diffHtml = await highlight(this.rawDiff, "diff");
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("repoId") && this.repoId) {
      void this.loadStatus();
    }
  }

  private async loadStatus() {
    const gen = ++this.loadGeneration;
    this.statusLoading = true;
    this.statusError = "";
    this.staged = [];
    this.unstaged = [];
    this.untracked = [];
    this.selectedFile = "";
    this.diffHtml = "";
    this.diffError = "";

    try {
      const resp = await repoClient.getStatus({ repoId: this.repoId });
      if (gen !== this.loadGeneration) return;
      this.staged = resp.staged;
      this.unstaged = resp.unstaged;
      this.untracked = resp.untracked;
    } catch (e) {
      if (gen !== this.loadGeneration) return;
      this.statusError = e instanceof Error ? e.message : String(e);
    } finally {
      if (gen === this.loadGeneration) this.statusLoading = false;
    }
  }

  private async selectFile(path: string) {
    if (this.selectedFile === path) return;
    this.selectedFile = path;
    this.diffError = "";
    this.diffHtml = "";
    this.diffLoading = true;

    const gen = this.loadGeneration;

    try {
      const resp = await repoClient.getWorkingTreeDiff({
        repoId: this.repoId,
        path,
      });
      if (gen !== this.loadGeneration || this.selectedFile !== path) return;
      if (resp.empty) {
        this.diffHtml = "";
        this.rawDiff = "";
      } else {
        const { highlight } = await loadHighlight();
        const highlighted = await highlight(resp.unifiedDiff, "diff");
        if (gen !== this.loadGeneration || this.selectedFile !== path) return;
        this.diffHtml = highlighted;
        this.rawDiff = resp.unifiedDiff;
      }
    } catch (e) {
      if (gen !== this.loadGeneration || this.selectedFile !== path) return;
      this.diffError = e instanceof Error ? e.message : String(e);
    } finally {
      if (gen === this.loadGeneration && this.selectedFile === path) this.diffLoading = false;
    }
  }

  private openInBrowse(path: string) {
    this.dispatchEvent(
      new CustomEvent("gc:open-file", { bubbles: true, composed: true, detail: { path } }),
    );
  }

  private get totalCount() {
    return this.staged.length + this.unstaged.length + this.untracked.length;
  }

  private renderFileGroup(label: string, files: StatusFile[], prefix: string) {
    if (files.length === 0) return nothing;
    return html`
      <div class="group-header">
        <span>${label}</span>
        <span class="group-count">${files.length}</span>
      </div>
      ${files.map((f) => html`
        <li>
          <button
            class="file-entry ${this.selectedFile === f.path ? "selected" : ""}"
            @click=${(e: MouseEvent) => { if (e.metaKey || e.ctrlKey) { this.openInBrowse(f.path); } else { this.selectFile(f.path); } }}
            title="${f.path} (⌘+click to open in browse)"
          >
            <span class="file-status ${f.status}">${prefix === "?" ? "?" : statusLabel(f.status)}</span>
            <span class="file-path">${fileName(f.path)}</span>
          </button>
        </li>
      `)}
    `;
  }

  override render() {
    if (this.statusLoading) {
      return html`<div class="hint">loading status…</div>`;
    }
    if (this.statusError) {
      return html`<div class="hint err">${this.statusError}
        <button class="retry-btn" @click=${() => this.loadStatus()}>retry</button>
      </div>`;
    }
    if (this.totalCount === 0) {
      return html`<div class="hint clean">working tree clean</div>`;
    }

    return html`
      <div class="changes-layout">
        <aside class="file-sidebar">
          <ul class="file-list" role="list">
            ${this.renderFileGroup("staged", this.staged, "")}
            ${this.renderFileGroup("unstaged", this.unstaged, "")}
            ${this.renderFileGroup("untracked", this.untracked, "?")}
          </ul>
        </aside>

        <section class="diff-pane">
          <div class="diff-header">
            ${this.selectedFile
              ? html`<span class="diff-filepath">${this.selectedFile}</span>`
              : html`<span class="diff-label">diff</span>`}
            <span class="diff-spacer"></span>
            <button class="refresh-btn" @click=${() => this.loadStatus()} title="Refresh status">↻</button>
          </div>
          <div class="diff-body">
            ${this.diffLoading
              ? html`<div class="diff-loading">loading diff…</div>`
              : this.diffError
                ? html`<p class="diff-err">${this.diffError}</p>`
                : this.diffHtml
                  ? html`<div class="diff-content">${unsafeHTML(this.diffHtml)}</div>`
                  : html`<div class="diff-empty">${this.selectedFile ? "no changes" : "select a file to view its diff"}</div>`}
          </div>
        </section>
      </div>
    `;
  }

  static override styles = css`
    :host([hidden]) { display: none !important; }
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: var(--text-base);
      color: var(--text);
      background: var(--surface-1);
    }
    .hint {
      padding: var(--space-4);
      opacity: 0.5;
      font-size: var(--text-sm);
    }
    .hint.err { color: var(--danger); opacity: 1; }
    .hint.clean {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      font-style: italic;
      opacity: 0.4;
    }
    .retry-btn {
      margin-left: var(--space-3);
      padding: var(--space-1) var(--space-3);
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
    }

    .changes-layout {
      display: grid;
      grid-template-columns: 280px 1fr;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }

    .file-sidebar {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--surface-4);
      background: var(--surface-0);
    }
    .file-list {
      list-style: none;
      padding: 0;
      margin: 0;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .group-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-3);
      font-size: var(--text-xs);
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-top: 1px solid var(--surface-4);
    }
    .group-header:first-child { border-top: none; }
    .group-count { opacity: 0.7; }
    .file-entry {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      padding: var(--space-1) var(--space-3);
      background: transparent;
      border: none;
      border-left: 2px solid transparent;
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-xs);
      text-align: left;
      cursor: pointer;
      transition: background 0.08s ease;
    }
    .file-entry:hover { background: var(--surface-2); }
    .file-entry.selected {
      background: var(--surface-2);
      border-left-color: var(--accent-assistant);
    }
    .file-entry:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: -2px;
    }
    .file-status {
      flex-shrink: 0;
      width: 1.2em;
      text-align: center;
      font-weight: 600;
      font-size: 0.65rem;
    }
    .file-status.modified { color: var(--accent-user); }
    .file-status.added { color: var(--accent-assistant); }
    .file-status.deleted { color: var(--danger); }
    .file-status.renamed { color: var(--warning, #e0a040); }
    .file-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .diff-pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
    }
    .diff-header {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: 0 var(--space-4);
      height: 36px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--surface-4);
      background: var(--surface-1);
      flex-shrink: 0;
      font-size: var(--text-sm);
    }
    .diff-label {
      opacity: 0.4;
      font-size: var(--text-xs);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .diff-filepath {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--text-xs);
    }
    .diff-spacer { flex: 1; }
    .refresh-btn {
      padding: var(--space-1);
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
      cursor: pointer;
      opacity: 0.5;
      line-height: 1;
    }
    .refresh-btn:hover { opacity: 1; background: var(--surface-2); }
    .refresh-btn:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .diff-body {
      flex: 1;
      overflow: auto;
      min-height: 0;
    }
    .diff-loading {
      padding: var(--space-6);
      opacity: 0.5;
    }
    .diff-err {
      color: var(--danger);
      padding: var(--space-4);
    }
    .diff-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      opacity: 0.4;
      font-size: var(--text-sm);
      font-style: italic;
    }
    .diff-content {
      font-size: var(--text-xs);
      line-height: 1.55;
      overflow-x: auto;
    }
    .diff-content pre {
      margin: 0;
      padding: var(--space-3) var(--space-5);
    }
    .diff-content .shiki {
      background: transparent !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .file-entry { transition: none; }
    }
    @media (max-width: 768px) {
      .changes-layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      .file-sidebar {
        border-right: none;
        border-bottom: 1px solid var(--surface-4);
        max-height: 40vh;
      }
    }
  `;
}
