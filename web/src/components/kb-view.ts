import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { chatClient } from "../lib/transport.js";
import type { KBCard } from "../gen/gitchat/v1/chat_pb.js";

// Lazy-load markdown renderer (same pattern as chat-view).
let markdownModule: Promise<typeof import("../lib/markdown.js")> | null = null;
function loadMarkdown() {
  if (!markdownModule) {
    markdownModule = import("../lib/markdown.js");
  }
  return markdownModule;
}

// Detail shape matching the GetCard RPC response.
type CardDetail = {
  id: string;
  question: string;
  answerMd: string;
  model: string;
  createdBy: string;
  hitCount: number;
  createdAt: bigint;
  invalidated: boolean;
  createdCommit: string;
  provenance: Array<{ path: string; blobSha: string }>;
};

@customElement("gc-kb-view")
export class GcKbView extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) initialCardId = "";

  @state() private cards: KBCard[] = [];
  @state() private selectedCardId = "";
  @state() private cardDetail: CardDetail | null = null;
  @state() private detailLoading = false;
  @state() private detailHtml = "";
  @state() private filter = "";
  @state() private loading = false;

  private onSelectCard = ((e: CustomEvent<{ cardId: string }>) => {
    void this.selectCard(e.detail.cardId);
  }) as EventListener;

  override connectedCallback() {
    super.connectedCallback();
    if (this.repoId) {
      void this.loadCards();
    }
    this.addEventListener("gc:select-card", this.onSelectCard);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("gc:select-card", this.onSelectCard);
  }

  private _lastRestoredCard = "";

  override updated(changed: Map<string, unknown>) {
    if (changed.has("repoId") && this.repoId) {
      void this.loadCards();
    }
    if (
      changed.has("initialCardId") &&
      this.initialCardId &&
      this.initialCardId !== this._lastRestoredCard
    ) {
      this._lastRestoredCard = this.initialCardId;
      void this.selectCard(this.initialCardId);
    }
  }

  private async loadCards() {
    this.loading = true;
    try {
      const resp = await chatClient.listCards({ repoId: this.repoId });
      this.cards = resp.cards;
      // If the previously selected card is gone, clear detail.
      if (this.selectedCardId && !this.cards.some((c) => c.id === this.selectedCardId)) {
        this.selectedCardId = "";
        this.cardDetail = null;
        this.detailHtml = "";
      }
    } catch {
      this.cards = [];
    } finally {
      this.loading = false;
    }
  }

  private async selectCard(cardId: string) {
    this.selectedCardId = cardId;
    this.dispatchEvent(
      new CustomEvent("gc:nav", {
        bubbles: true,
        composed: true,
        detail: { cardId },
      }),
    );
    this.detailLoading = true;
    this.cardDetail = null;
    this.detailHtml = "";
    try {
      const resp = await (chatClient as any).getCard({ cardId });
      this.cardDetail = {
        id: resp.id,
        question: resp.question,
        answerMd: resp.answerMd,
        model: resp.model,
        createdBy: resp.createdBy,
        hitCount: resp.hitCount,
        createdAt: resp.createdAt,
        invalidated: resp.invalidated,
        createdCommit: resp.createdCommit,
        provenance: (resp.provenance ?? []).map((p: any) => ({
          path: p.path,
          blobSha: p.blobSha,
        })),
      };
      // Render markdown.
      const md = await loadMarkdown();
      this.detailHtml = await md.renderMarkdown(this.cardDetail.answerMd);
    } catch {
      this.cardDetail = null;
      this.detailHtml = "";
    } finally {
      this.detailLoading = false;
    }
  }

  private async deleteCard(cardId: string) {
    try {
      await chatClient.deleteCard({ cardId });
      this.cards = this.cards.filter((c) => c.id !== cardId);
      if (this.selectedCardId === cardId) {
        this.selectedCardId = "";
        this.cardDetail = null;
        this.detailHtml = "";
      }
    } catch {
      /* swallow */
    }
  }

  private viewInLog(sha: string) {
    this.dispatchEvent(
      new CustomEvent("gc:view-commit", {
        bubbles: true,
        composed: true,
        detail: { sha },
      }),
    );
  }

  private askAgain() {
    if (!this.cardDetail) return;
    this.dispatchEvent(
      new CustomEvent("gc:ask-about", {
        detail: { prompt: this.cardDetail.question },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private navigateToFile(path: string) {
    this.dispatchEvent(
      new CustomEvent("gc:navigate-browse", {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
    // Also switch tab via hash to browse and open file.
    // Use the existing gc:ask-about pattern — dispatch to parent
    // which handles tab switching. We'll do it directly here by
    // manipulating the hash and dispatching the open-file event.
    const repoId = this.repoId;
    window.location.hash = `#/${repoId}/browse`;
    requestAnimationFrame(() => {
      // The parent gc-app listens for hashchange and switches tab.
      // Then we need to tell the browser to open the file.
      const app = this.closest("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      browser?.dispatchEvent(
        new CustomEvent("gc:open-file", {
          detail: { path },
        }),
      );
    });
  }

  private get filteredCards() {
    if (!this.filter.trim()) return this.cards;
    const q = this.filter.toLowerCase();
    return this.cards.filter((c) => c.question.toLowerCase().includes(q));
  }

  private formatDate(ts: bigint): string {
    if (!ts) return "";
    const d = new Date(Number(ts) * 1000);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  override render() {
    return html`
      <div class="layout">
        <aside class="sidebar">
          <input
            class="filter"
            type="search"
            placeholder="filter cards..."
            .value=${this.filter}
            @input=${(e: Event) => {
              this.filter = (e.target as HTMLInputElement).value;
            }}
          />
          ${this.loading
            ? html`<p class="hint">loading cards...</p>`
            : this.filteredCards.length === 0
              ? html`<p class="hint">${this.cards.length === 0 ? "no cards yet" : "no matches"}</p>`
              : html`
                  <ul class="card-list" role="listbox">
                    ${this.filteredCards.map(
                      (c) => html`
                        <li
                          class="card-item ${c.id === this.selectedCardId
                            ? "selected"
                            : ""} ${c.invalidated ? "stale" : ""}"
                          role="option"
                          tabindex="0"
                          aria-selected=${c.id === this.selectedCardId ? "true" : "false"}
                          @click=${() => this.selectCard(c.id)}
                          @keydown=${(e: KeyboardEvent) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              this.selectCard(c.id);
                            }
                          }}
                        >
                          ${c.invalidated
                            ? html`<span class="stale-icon" title="invalidated">!</span>`
                            : html`<span class="valid-icon"></span>`}
                          <span class="card-question">${c.question}</span>
                          <span class="card-hits">${c.hitCount}</span>
                        </li>
                      `,
                    )}
                  </ul>
                `}
        </aside>
        <section class="detail">
          ${this.detailLoading
            ? html`<p class="hint">loading card...</p>`
            : this.cardDetail
              ? this.renderDetail()
              : html`<p class="hint">select a card to view details</p>`}
        </section>
      </div>
    `;
  }

  private renderDetail() {
    const d = this.cardDetail!;
    return html`
      <div class="detail-inner">
        <h2 class="detail-question">${d.question}</h2>
        <div class="detail-meta">
          <span>${d.createdBy || "system"}</span>
          <span class="meta-sep">&middot;</span>
          <span>${this.formatDate(d.createdAt)}</span>
          <span class="meta-sep">&middot;</span>
          <span>${d.hitCount} hits</span>
          <span class="meta-sep">&middot;</span>
          <span>model: ${d.model}</span>
          ${d.invalidated
            ? html`<span class="meta-sep">&middot;</span><span class="stale-badge">stale</span>`
            : nothing}
          ${d.createdCommit
            ? html`<span class="meta-sep">&middot;</span
                ><button
                  class="commit-link"
                  title="View in log"
                  @click=${() => this.viewInLog(d.createdCommit)}
                >
                  ${d.createdCommit.slice(0, 7)}
                </button>`
            : nothing}
        </div>
        <div class="detail-answer">${unsafeHTML(this.detailHtml)}</div>
        ${d.provenance.length > 0
          ? html`
              <div class="provenance">
                <h3 class="provenance-title">Provenance</h3>
                <ul class="provenance-list">
                  ${d.provenance.map(
                    (p) => html`
                      <li>
                        <button class="prov-link" @click=${() => this.navigateToFile(p.path)}>
                          ${p.path}
                        </button>
                      </li>
                    `,
                  )}
                </ul>
              </div>
            `
          : nothing}
        <div class="detail-actions">
          <button class="action-btn danger" @click=${() => this.deleteCard(d.id)}>delete</button>
          <button class="action-btn" @click=${() => this.askAgain()}>ask again</button>
        </div>
      </div>
    `;
  }

  static override styles = css`
    :host([hidden]) {
      display: none !important;
    }
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: 0.82rem;
      color: var(--text);
      background: var(--surface-1);
    }
    .layout {
      display: grid;
      grid-template-columns: var(--sidebar-width) 1fr;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }

    /* ── Sidebar ─────────────────────────────────────────────── */
    .sidebar {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--surface-4);
      background: var(--surface-0);
    }
    .filter {
      margin: 0.85rem 0.85rem 0.6rem;
      padding: var(--space-2) var(--space-2);
      background: var(--surface-0);
      color: var(--text);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      box-sizing: border-box;
      width: calc(100% - 1.7rem);
      outline: none;
    }
    .filter:focus {
      border-color: var(--border-strong);
    }
    .hint {
      padding: var(--space-4) 0.95rem;
      opacity: 0.45;
      font-size: var(--text-xs);
    }
    .card-list {
      list-style: none;
      padding: 0 0.4rem 0.4rem;
      margin: 0;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .card-item {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) 0.55rem;
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: background 0.1s ease;
      font-size: var(--text-xs);
    }
    .card-item:hover {
      background: var(--surface-2);
    }
    .card-item.selected {
      background: var(--surface-3);
    }
    .card-item:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: -2px;
    }
    .card-item.stale {
      opacity: 0.55;
    }
    .stale-icon {
      flex-shrink: 0;
      width: 1rem;
      text-align: center;
      color: var(--accent-user);
      font-weight: 700;
      font-size: 0.75rem;
    }
    .valid-icon {
      flex-shrink: 0;
      width: 1rem;
      text-align: center;
    }
    .valid-icon::before {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent-assistant);
    }
    .card-question {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-hits {
      flex-shrink: 0;
      font-size: 0.65rem;
      opacity: 0.5;
      padding: 0.05rem 0.35rem;
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-sm);
      font-variant-numeric: tabular-nums;
    }

    /* ── Detail pane ─────────────────────────────────────────── */
    .detail {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow-y: auto;
      padding: var(--space-5) var(--space-6);
    }
    .detail-inner {
      max-width: var(--content-max-width);
    }
    .detail-question {
      margin: 0 0 var(--space-3);
      font-size: var(--text-lg);
      font-weight: 500;
      line-height: 1.3;
    }
    .detail-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-xs);
      opacity: 0.55;
      margin-bottom: var(--space-5);
    }
    .meta-sep {
      opacity: 0.4;
    }
    .stale-badge {
      color: var(--accent-user);
      opacity: 1;
      font-weight: 600;
    }
    .commit-link {
      font-family: inherit;
      font-size: inherit;
      color: var(--accent-user);
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .commit-link:hover {
      opacity: 0.8;
    }
    .detail-answer {
      line-height: 1.65;
      overflow-wrap: break-word;
    }
    /* Markdown content styling — matches chat-view's .msg .md */
    .detail-answer p {
      margin: 0 0 0.75em;
    }
    .detail-answer p:last-child {
      margin-bottom: 0;
    }
    .detail-answer pre {
      margin: 0.75em 0;
      padding: var(--space-3);
      background: var(--surface-0);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-md);
      overflow-x: auto;
      font-size: 0.78rem;
    }
    .detail-answer code {
      font-family: inherit;
      font-size: 0.88em;
      padding: 0.1em 0.3em;
      background: var(--surface-0);
      border-radius: var(--radius-sm);
    }
    .detail-answer pre code {
      padding: 0;
      background: none;
    }
    .detail-answer ul,
    .detail-answer ol {
      margin: 0.5em 0;
      padding-left: 1.4em;
    }
    .detail-answer blockquote {
      margin: 0.75em 0;
      padding-left: var(--space-4);
      border-left: 3px solid var(--surface-4);
      opacity: 0.8;
    }
    .detail-answer a {
      color: var(--accent-assistant);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .detail-answer h1,
    .detail-answer h2,
    .detail-answer h3,
    .detail-answer h4 {
      margin: 1em 0 0.5em;
      font-weight: 600;
    }
    .detail-answer table {
      border-collapse: collapse;
      margin: 0.75em 0;
      font-size: var(--text-xs);
    }
    .detail-answer th,
    .detail-answer td {
      border: 1px solid var(--surface-4);
      padding: var(--space-1) var(--space-2);
    }
    .detail-answer th {
      background: var(--surface-0);
      font-weight: 600;
    }

    /* ── Provenance ──────────────────────────────────────────── */
    .provenance {
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--surface-4);
    }
    .provenance-title {
      margin: 0 0 var(--space-2);
      font-size: var(--text-xs);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.5;
      font-weight: 500;
    }
    .provenance-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .prov-link {
      background: none;
      border: none;
      color: var(--accent-assistant);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      padding: var(--space-1) 0;
      text-align: left;
      text-decoration: underline;
      text-underline-offset: 2px;
      opacity: 0.8;
    }
    .prov-link:hover {
      opacity: 1;
    }

    /* ── Actions ─────────────────────────────────────────────── */
    .detail-actions {
      display: flex;
      gap: var(--space-2);
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--surface-4);
    }
    .action-btn {
      font-family: inherit;
      font-size: var(--text-xs);
      padding: var(--space-1) var(--space-3);
      background: var(--action-bg);
      color: var(--text);
      border: 1px solid var(--border-accent);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition:
        background 0.12s ease,
        border-color 0.12s ease;
    }
    .action-btn:hover {
      background: var(--action-bg-hover);
      border-color: var(--border-strong);
    }
    .action-btn.danger:hover {
      color: var(--danger);
      border-color: var(--danger-border);
    }

    /* ── Focus-visible ────────────────────────────────────────── */
    :focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: 2px;
    }

    /* ── Responsive ───────────────────────────────────────────── */
    @media (max-width: 768px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .detail {
        padding: var(--space-3) var(--space-4);
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-kb-view": GcKbView;
  }
}
