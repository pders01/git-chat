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
  @state() private hoveredBlame: BlameLine | null = null;
  @state() private blameTooltipStyle = "";
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;

  @state() private view: ViewState = { phase: "empty" };
  private cachedShikiLines: string[] | null = null;
  private cachedShikiSrc = "";

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.hoveredBlame = null;
  }

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
    const requestedPath = this.path;
    this.view = { phase: "loading" };
    this.blameLines = [];
    this.hoveredBlame = null;
    this.showBlame = false;
    try {
      const resp = await repoClient.getFile({
        repoId: this.repoId,
        ref: this.branch,
        path: this.path,
        maxBytes: BigInt(512 * 1024),
      });
      if (this.path !== requestedPath) return; // user navigated away
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
      if (this.path !== requestedPath) return; // navigated during highlight
      this.view = { phase: "highlighted", html, file: resp };
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
          ${this.showBlame ? this.renderBlameTooltip() : nothing}
          ${this.showBlame
            ? this.renderBlameTable(this.view.text.split("\n"), false)
            : html`<pre class="plain">${this.view.text}</pre>`}
          ${this.view.file.truncated ? html`<p class="note">truncated at 512 KiB</p>` : nothing}
        `;
      case "highlighted":
        return html`
          ${this.renderHeader(this.view.file)}
          ${this.showBlame ? this.renderBlameTooltip() : nothing}
          ${this.showBlame
            ? this.renderBlameTable(this.getShikiLines(this.view.html), true)
            : html`<div class="shiki-wrap">${unsafeHTML(this.view.html)}</div>`}
          ${this.view.file.truncated ? html`<p class="note">truncated at 512 KiB</p>` : nothing}
        `;
    }
  }

  private renderBlameTooltip() {
    const b = this.hoveredBlame;
    if (!b) return nothing;
    const age = new Date(Number(b.date) * 1000).toISOString().slice(0, 10);
    const lines = (b.commitMessage || "").split("\n");
    const subject = lines[0] || "(no message)";
    const body = lines.slice(2).join("\n").trim();
    return html`
      <div class="blame-tip" style=${this.blameTooltipStyle}
        @mouseenter=${() => { if (this.hoverTimer) clearTimeout(this.hoverTimer); }}
        @mouseleave=${this.onGutterLeave}
      >
        <div class="bt-header">
          <span class="bt-sha">${b.commitSha}</span>
          <span class="bt-meta">${b.authorName} · ${age}</span>
        </div>
        <div class="bt-subject">${subject}</div>
        ${body ? html`<div class="bt-body">${body}</div>` : nothing}
        <div class="bt-actions">
          <button class="bt-btn" @click=${() => this.viewCommitInLog(b.commitSha)}>view in log</button>
          <button class="bt-btn" @click=${() => this.askAboutCommit(b.commitSha, subject)}>ask in chat</button>
        </div>
      </div>
    `;
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

  // Event delegation on the gutter container — one listener for all
  // lines, not one per line. O(1) listeners regardless of file size.
  private onGutterHover = (e: MouseEvent) => {
    const row = (e.target as HTMLElement).closest?.("tr") as HTMLElement | null;
    if (!row) return;
    const cell = row.querySelector(".blame-cell") as HTMLElement | null;
    if (!cell) return;
    const idx = parseInt(cell.dataset.idx ?? "-1");
    if (idx < 0 || idx >= this.blameLines.length) return;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => {
      this.hoveredBlame = this.blameLines[idx]!;
      // Position to the right of the gutter, clamped to viewport.
      // Defer one frame so the tooltip DOM exists and we can measure it.
      requestAnimationFrame(() => {
        const tip = this.renderRoot.querySelector(".blame-tip") as HTMLElement | null;
        const tipW = tip?.offsetWidth ?? 560;
        const tipH = tip?.offsetHeight ?? 200;
        // Position near cursor, offset right+below. Clamp to viewport.
        let left = e.clientX + 16;
        let top = e.clientY + 12;
        if (left + tipW > window.innerWidth - 8) left = e.clientX - tipW - 8;
        if (top + tipH > window.innerHeight - 8) top = e.clientY - tipH - 8;
        if (top < 8) top = 8;
        if (left < 8) left = 8;
        this.blameTooltipStyle = `top:${top}px;left:${left}px`;
      });
    }, 200);
  };

  private onGutterLeave = () => {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => { this.hoveredBlame = null; }, 150);
  };

  /** Cached wrapper — avoids re-parsing Shiki HTML on every render. */
  private getShikiLines(shikiHtml: string): string[] {
    if (this.cachedShikiSrc === shikiHtml && this.cachedShikiLines) {
      return this.cachedShikiLines;
    }
    this.cachedShikiSrc = shikiHtml;
    this.cachedShikiLines = this.splitShikiLines(shikiHtml);
    return this.cachedShikiLines;
  }

  /** Extract individual line HTML strings from Shiki output. */
  private splitShikiLines(shikiHtml: string): string[] {
    const tmp = document.createElement("div");
    tmp.innerHTML = shikiHtml;
    const lines = tmp.querySelectorAll(".line");
    if (lines.length > 0) {
      return Array.from(lines).map((el) => el.innerHTML);
    }
    // Fallback: split by newline inside the <code> tag.
    const code = tmp.querySelector("code");
    if (code) return code.innerHTML.split("\n");
    return shikiHtml.split("\n");
  }

  private renderBlameTable(lines: string[], isHighlighted: boolean) {
    let blockIdx = -1;
    return html`
      <div class="blame-table-wrap"
        @mouseover=${this.onGutterHover}
        @mouseout=${this.onGutterLeave}
      >
        <table class="blame-table">
          <colgroup>
            <col class="blame-col" />
            <col class="lno-col" />
            <col />
          </colgroup>
          <tbody>
            ${lines.map((line, i) => {
              const blame = this.blameLines[i];
              const prev = i > 0 ? this.blameLines[i - 1] : undefined;
              const isNewBlock = blame != null && (!prev || prev.commitSha !== blame.commitSha);
              if (isNewBlock) blockIdx++;
              return html`
                <tr class="${isNewBlock ? "blame-start" : ""}">
                  <td class="blame-cell" data-idx=${i}>
                    ${isNewBlock && blame
                      ? html`<span class="blame-sha">${blame.commitSha.slice(0, 7)}</span> <span class="blame-msg">${(blame.commitMessage || "").split("\n")[0].slice(0, 20)}</span>`
                      : nothing}
                  </td>
                  <td class="lno-cell">${i + 1}</td>
                  <td class="code-cell ${isHighlighted ? "highlighted" : "plain-cell"}">${isHighlighted ? unsafeHTML(line) : line}</td>
                </tr>`;
            })}
          </tbody>
        </table>
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

  private viewCommitInLog(sha: string) {
    this.hoveredBlame = null;
    this.dispatchEvent(
      new CustomEvent("gc:view-commit", {
        bubbles: true,
        composed: true,
        detail: { sha, tab: "log" },
      }),
    );
  }

  private askAboutCommit(sha: string, subject: string) {
    this.hoveredBlame = null;
    this.dispatchEvent(
      new CustomEvent("gc:ask-about", {
        bubbles: true,
        composed: true,
        detail: {
          prompt: `Explain commit ${sha.slice(0, 7)} "${subject}" — what changed and why?`,
          tab: "chat",
        },
      }),
    );
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
      padding: 0 0.95rem;
      height: 36px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--border-default);
      background: var(--surface-1);
      position: sticky;
      top: 0;
      z-index: 10;
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
    /* ── Blame tooltip (hover popup) ────────────── */
    .blame-tip {
      position: fixed;
      z-index: 50;
      width: min(560px, calc(100vw - 32px));
      padding: var(--space-3) var(--space-4);
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-size: var(--text-xs);
      box-shadow: 0 4px 24px rgba(0,0,0,0.35);
    }
    .bt-header {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin-bottom: var(--space-1);
    }
    .bt-sha {
      color: var(--accent-user);
      font-variant-numeric: tabular-nums;
    }
    .bt-meta {
      opacity: 0.5;
      margin-left: auto;
    }
    .bt-subject {
      font-size: var(--text-sm);
      font-weight: 500;
      margin-bottom: var(--space-1);
      word-break: break-word;
    }
    .bt-body {
      opacity: 0.6;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: min(200px, 40vh);
      overflow-y: auto;
      line-height: 1.5;
    }
    .bt-actions {
      display: flex;
      gap: var(--space-2);
      margin-top: var(--space-2);
      padding-top: var(--space-2);
      border-top: 1px solid var(--border-default);
    }
    .bt-btn {
      padding: var(--space-1) var(--space-3);
      background: var(--surface-3);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
    }
    .bt-btn:hover {
      background: var(--action-bg-hover);
      border-color: var(--border-accent);
    }
    /* ── Blame table layout ──────────────────────── */
    .blame-table-wrap {
      font-size: 0.8rem;
    }
    .blame-table {
      table-layout: fixed;
      border-collapse: collapse;
      width: 100%;
      font-family: inherit;
      font-size: inherit;
    }
    .blame-col {
      width: 180px;
    }
    .lno-col {
      width: 3.5em;
    }
    .blame-table tr.blame-start:not(:first-child) td {
      border-top: 1px solid var(--surface-4);
    }
    .blame-cell {
      padding: 0 var(--space-2);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 0.7rem;
      background: var(--surface-1-alt);
      border-right: 1px solid var(--surface-4);
      cursor: pointer;
      vertical-align: top;
    }
    .blame-table tr:hover .blame-cell,
    .blame-table tr:hover .lno-cell {
      background: var(--surface-3);
    }
    .blame-cont {
      opacity: 0.3;
      color: var(--surface-4);
    }
    .lno-cell {
      padding: 0 var(--space-2);
      text-align: right;
      color: var(--text);
      opacity: 0.25;
      font-size: 0.7rem;
      user-select: none;
      border-right: 1px solid var(--surface-4);
      vertical-align: top;
    }
    .code-cell {
      padding: 0 var(--space-4);
      white-space: pre;
      vertical-align: top;
    }
    .code-cell.plain-cell {
      white-space: pre-wrap;
      word-break: break-word;
    }
    /* ── Blame info bar (below file header, inline) ─────────── */
    .blame-bar {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2) var(--space-4);
      background: var(--surface-2);
      border-bottom: 1px solid var(--surface-4);
      font-size: var(--text-xs);
      white-space: nowrap;
      overflow: hidden;
    }
    .bb-sha {
      color: var(--accent-user);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .bb-subject {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bb-meta {
      opacity: 0.5;
      flex-shrink: 0;
    }
    .bb-btn {
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
    .bb-btn:hover {
      background: var(--action-bg-hover);
    }

    .blame-sha {
      color: var(--accent-user);
      font-variant-numeric: tabular-nums;
    }
    .blame-msg {
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
