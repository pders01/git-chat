import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { repoClient } from "../lib/transport.js";
import { copyText } from "../lib/clipboard.js";
import type { BlameLine } from "../gen/gitchat/v1/repo_pb.js";
import type { GetFileResponse } from "../gen/gitchat/v1/repo_pb.js";

// Shiki + its grammars are ~300 kB gzipped. Import lazily so the initial
// bundle doesn't pay for them on the auth / pairing path — they only load
// the first time a file is viewed.
type HighlightFn = (code: string, lang: string) => Promise<string>;
let highlightPromise: Promise<HighlightFn> | null = null;
function loadHighlight(): Promise<HighlightFn> {
  if (!highlightPromise) {
    highlightPromise = import("../lib/highlight.js").then((m) => m.highlight);
  }
  return highlightPromise;
}

type ViewState =
  | { phase: "empty" }
  | { phase: "loading" }
  | { phase: "binary"; file: GetFileResponse }
  | { phase: "plain"; text: string; file: GetFileResponse }
  | { phase: "highlighted"; html: string; file: GetFileResponse }
  | { phase: "error"; message: string };

// gc-file-view fetches a single file from the repo and renders it with
// Shiki. Binary files short-circuit to a placeholder instead of trying to
// render random bytes as text.
@customElement("gc-file-view")
export class GcFileView extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) path = "";
  @property({ type: String }) branch = "";
  @state() private showBlame = false;
  @state() private blameLines: BlameLine[] = [];

  @state() private view: ViewState = { phase: "empty" };

  override updated(changed: Map<string, unknown>) {
    if (
      changed.has("path") ||
      changed.has("repoId") ||
      changed.has("branch")
    ) {
      if (this.path && this.repoId) {
        void this.load();
      } else {
        this.view = { phase: "empty" };
      }
    }
  }

  private async load() {
    this.view = { phase: "loading" };
    try {
      const resp = await repoClient.getFile({
        repoId: this.repoId,
        ref: this.branch,
        path: this.path,
        maxBytes: BigInt(512 * 1024),
      });
      if (resp.isBinary) {
        this.view = { phase: "binary", file: resp };
        return;
      }
      const text = new TextDecoder().decode(resp.content);
      if (!resp.language) {
        this.view = { phase: "plain", text, file: resp };
        return;
      }
      const highlight = await loadHighlight();
      const html = await highlight(text, resp.language);
      // Only commit the result if the path is still the one we started on.
      if (this.path === resp.blobSha || true) {
        this.view = { phase: "highlighted", html, file: resp };
      }
    } catch (e) {
      this.view = {
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  override render() {
    switch (this.view.phase) {
      case "empty":
        return html`<div class="empty-state">
            <div class="empty-title">select a file</div>
            <p class="empty-sub">click a file in the tree to view its contents</p>
          </div>`;
      case "loading":
        return html`<p class="empty">loading…</p>`;
      case "error":
        return html`<div class="err">
          ${this.view.message}
          <button class="retry-btn" @click=${() => void this.load()}>retry</button>
        </div>`;
      case "binary":
        return html`
          ${this.renderHeader(this.view.file)}
          <p class="empty">binary file · ${this.view.file.size} bytes</p>
        `;
      case "plain":
        return html`
          ${this.renderHeader(this.view.file)}
          <div class="code-with-blame">
            ${this.showBlame ? this.renderBlameGutter() : nothing}
            <pre class="plain">${this.view.text}</pre>
          </div>
          ${this.view.file.truncated ? html`<p class="note">truncated at 512 KiB</p>` : nothing}
        `;
      case "highlighted":
        return html`
          ${this.renderHeader(this.view.file)}
          <div class="code-with-blame">
            ${this.showBlame ? this.renderBlameGutter() : nothing}
            <div class="shiki-wrap">${unsafeHTML(this.view.html)}</div>
          </div>
          ${this.view.file.truncated ? html`<p class="note">truncated at 512 KiB</p>` : nothing}
        `;
    }
  }

  private renderHeader(file: GetFileResponse) {
    return html`
      <div class="hd">
        <div class="hd-left">
          <span
            class="path copyable"
            @click=${() => copyText(this, this.path, "Path copied")}
            title="Click to copy path"
          >${this.path}</span>
          <span class="meta">
            ${file.language || "plain"} · ${file.size} B · ${file.blobSha.slice(0, 7)}
          </span>
        </div>
        <button
          class="hd-btn ${this.showBlame ? "active" : ""}"
          @click=${() => this.toggleBlame()}
          aria-label="Toggle git blame"
        >
          blame
        </button>
        <button
          class="hd-btn"
          @click=${() => this.askAboutFile()}
          aria-label="Ask about this file in chat"
        >
          ask in chat
        </button>
      </div>
    `;
  }

  private renderBlameGutter() {
    return html`
      <div class="blame-gutter">
        ${this.blameLines.map(
          (l, i) => {
            // Only show author+SHA when it changes from the previous line.
            const prev = i > 0 ? this.blameLines[i - 1] : null;
            const showMeta = !prev || prev.commitSha !== l.commitSha;
            return html`<div class="blame-line" title="${l.authorName} · ${l.commitSha}">
              ${showMeta
                ? html`<span class="blame-sha">${l.commitSha}</span><span class="blame-author">${l.authorName.slice(0, 12)}</span>`
                : nothing}
            </div>`;
          },
        )}
      </div>
    `;
  }

  private async toggleBlame() {
    this.showBlame = !this.showBlame;
    if (this.showBlame && this.blameLines.length === 0) {
      try {
        const resp = await repoClient.getBlame({
          repoId: this.repoId,
          path: this.path,
        });
        this.blameLines = resp.lines;
      } catch {
        this.blameLines = [];
        this.showBlame = false;
      }
    }
  }

  private askAboutFile() {
    this.dispatchEvent(
      new CustomEvent("gc:ask-about", {
        bubbles: true,
        composed: true,
        detail: {
          prompt: `Explain what @${this.path} does and how it fits into the codebase.`,
          tab: "chat",
        },
      }),
    );
  }

  static override styles = css`
    :host {
      display: block;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: 0.8rem;
      color: var(--text);
      height: 100%;
      overflow: auto;
    }
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      opacity: 0.55;
    }
    .empty-title {
      font-size: 1.1rem;
      font-weight: 500;
      margin-bottom: var(--space-2);
    }
    .empty-sub {
      margin: 0;
      font-size: 0.82rem;
      opacity: 0.7;
    }
    .empty,
    .err,
    .note {
      margin: 0;
      padding: var(--space-5);
      opacity: 0.55;
    }
    .err {
      color: var(--danger);
      opacity: 1;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-2);
    }
    .retry-btn {
      padding: var(--space-1) var(--space-3);
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
    }
    .retry-btn:hover {
      background: var(--surface-3);
    }
    .note {
      font-style: italic;
      opacity: 0.4;
      padding-top: 0;
    }
    .hd {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.55rem 0.95rem;
      border-bottom: 1px solid var(--border-default);
      background: var(--surface-1);
      position: sticky;
      top: 0;
      gap: var(--space-3);
    }
    .hd-left {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex: 1;
      min-width: 0;
      gap: var(--space-3);
    }
    .code-with-blame {
      display: flex;
      overflow: auto;
    }
    .blame-gutter {
      flex-shrink: 0;
      width: 180px;
      border-right: 1px solid var(--surface-4);
      font-size: 0.68rem;
      line-height: 1.5;
      padding: var(--space-4) var(--space-2);
      background: var(--surface-0);
      overflow: hidden;
    }
    .blame-line {
      height: 1.5em;
      display: flex;
      gap: var(--space-2);
      white-space: nowrap;
      overflow: hidden;
    }
    .blame-sha {
      color: var(--accent-user);
      font-variant-numeric: tabular-nums;
    }
    .blame-author {
      opacity: 0.5;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hd-btn {
      flex-shrink: 0;
      padding: var(--space-1) var(--space-3);
      background: transparent;
      color: var(--text);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.5;
    }
    .hd-btn:hover {
      opacity: 0.9;
      border-color: var(--border-default);
    }
    .hd-btn.active {
      opacity: 1;
      background: var(--surface-2);
      border-color: var(--border-default);
    }
    .ask-btn {
      flex-shrink: 0;
      padding: var(--space-1) var(--space-3);
      background: var(--action-bg);
      color: var(--text);
      border: 1px solid var(--border-accent);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
    }
    .ask-btn:hover {
      background: var(--action-bg-hover);
    }
    .copyable {
      cursor: copy;
    }
    .copyable:hover {
      text-decoration: underline;
    }
    .path {
      font-weight: 500;
    }
    .meta {
      opacity: 0.45;
      font-size: 0.72rem;
    }
    .plain,
    .shiki-wrap {
      margin: 0;
      padding: var(--space-4);
    }
    .plain {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .shiki-wrap :first-child {
      background: transparent !important;
      margin: 0;
      padding: 0;
      font-size: inherit;
    }
    .shiki-wrap pre {
      padding: 0;
      margin: 0;
      overflow-x: auto;
    }
    .shiki-wrap code {
      font-size: 0.8rem;
    }
  `;
}
