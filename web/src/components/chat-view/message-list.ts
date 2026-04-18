import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { copyText } from "../../lib/clipboard.js";
import {
  type Turn,
  type ToolEvent,
  type ClientAttachment,
  MessageRole,
  estimateCost,
  fmtNum,
  fmtBytes,
  fmtToolSummary,
  fmtJSON,
} from "../../lib/chat-types.js";

@customElement("gc-message-list")
export class GcMessageList extends LitElement {
  @property({ type: Array }) turns: Turn[] = [];
  @property({ type: Boolean }) sending = false;

  @state() private editingTurnId = "";

  // True when the messages pane is scrolled within 64px of its bottom.
  private scrollPinnedToBottom = true;

  private onScroll = (e: Event) => {
    const pane = e.currentTarget as HTMLElement;
    const nearBottomPx = 64;
    this.scrollPinnedToBottom =
      pane.scrollHeight - pane.scrollTop - pane.clientHeight <= nearBottomPx;
  };

  scrollToBottom() {
    if (!this.scrollPinnedToBottom) return;
    requestAnimationFrame(() => {
      const pane = this.renderRoot.querySelector(".messages");
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  }

  pinToBottom() {
    this.scrollPinnedToBottom = true;
  }

  override render() {
    return html`
      <div
        class="messages"
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        @click=${this.onMessagesClick}
        @scroll=${this.onScroll}
      >
        <div class="messages-inner">
          ${repeat(
            this.turns,
            (t) => t.id,
            (t) => this.renderTurn(t),
          )}
        </div>
      </div>
    `;
  }

  private renderTurn(t: Turn) {
    const roleClass =
      t.role === MessageRole.USER
        ? "user"
        : t.role === MessageRole.ASSISTANT
          ? "assistant"
          : "system";
    const body =
      t.role === MessageRole.ASSISTANT && !t.streaming && t.html
        ? html`<div class="body md">${unsafeHTML(t.html)}</div>`
        : html`<div class="body">
            ${t.content}${t.streaming ? html`<span class="cursor">▍</span>` : nothing}
          </div>`;

    if (t.role === MessageRole.USER) {
      const pair = this.editablePair();
      const isEditable = !!pair && this.turns[pair.userIdx]?.id === t.id;
      const isEditing = this.editingTurnId === t.id;
      return html`
        <article class="turn user">
          <div class="turn-label">you</div>
          <div class="turn-actions">
            ${isEditable && !isEditing
              ? html`<button
                  class="turn-action"
                  @click=${() => this.beginEditLast()}
                  aria-label="Edit message and resend"
                  title="Edit message and resend"
                >
                  edit
                </button>`
              : nothing}
            <button
              class="turn-action"
              @click=${(e: Event) => this.copyTurn(e, t)}
              aria-label="Copy message"
              title="Copy message"
            >
              copy
            </button>
          </div>
          ${t.attachments && t.attachments.length > 0
            ? html`<div class="turn-attachments" role="list">
                ${t.attachments.map((a) => this.renderAttachmentChip(a))}
              </div>`
            : nothing}
          ${isEditing ? this.renderEditTurn(t) : body}
          ${t.warnings && t.warnings.length > 0
            ? html`<div class="turn-warnings" role="status">
                ${t.warnings.map((w) => html`<div class="turn-warning">⚠ ${w}</div>`)}
              </div>`
            : nothing}
        </article>
      `;
    }

    const tokenInfo = t.streaming
      ? html`<div class="token-info">streaming...</div>`
      : t.tokensIn || t.tokensOut
        ? html`<div class="token-info">
            ${t.model ? t.model.toLowerCase() : ""}${t.model ? " · " : ""}${fmtNum(t.tokensIn ?? 0)}
            in · ${fmtNum(t.tokensOut ?? 0)} out ·
            ${estimateCost(t.model ?? "", t.tokensIn ?? 0, t.tokensOut ?? 0)}
          </div>`
        : nothing;

    const pair = this.editablePair();
    const isRegeneratable = !!pair && this.turns[pair.assistantIdx]?.id === t.id;
    const lastIdx = this.turns.length - 1;
    const isRetryable =
      !!t.error &&
      !t.streaming &&
      lastIdx > 0 &&
      this.turns[lastIdx]?.id === t.id &&
      this.turns[lastIdx - 1]?.role === MessageRole.USER;

    return html`
      <article class="turn ${roleClass}">
        <div class="turn-label">
          assistant${t.model
            ? html`<span class="turn-model">${t.model.toLowerCase()}</span>`
            : nothing}
        </div>
        ${t.streaming
          ? nothing
          : html`<div class="turn-actions">
              ${isRetryable
                ? html`<button
                    class="turn-action primary"
                    @click=${() => this.fireRetry()}
                    aria-label="Retry"
                    title="Retry"
                  >
                    retry
                  </button>`
                : nothing}
              ${isRegeneratable
                ? html`<button
                    class="turn-action"
                    @click=${() => this.fireRegenerate()}
                    aria-label="Regenerate response"
                    title="Regenerate response"
                  >
                    regenerate
                  </button>`
                : nothing}
              <button
                class="turn-action"
                @click=${(e: Event) => this.copyTurn(e, t)}
                aria-label="Copy message"
                title="Copy message"
              >
                copy
              </button>
            </div>`}
        ${this.renderThinking(t)}
        ${t.tools && t.tools.length > 0 ? this.renderToolEvents(t.tools) : nothing} ${body}
        ${tokenInfo}
      </article>
    `;
  }

  private renderThinking(t: Turn) {
    if (!t.thinking) return nothing;
    const label = t.streaming ? "thinking…" : "thinking";
    return html`<div class="thinking-block ${t.streaming ? "is-streaming" : ""}">
      <button
        class="thinking-head"
        aria-expanded=${t.thinkingExpanded ? "true" : "false"}
        @click=${() => this.toggleThinking(t.id)}
      >
        <span class="thinking-label">${label}</span>
        <span class="thinking-caret" aria-hidden="true">${t.thinkingExpanded ? "▾" : "▸"}</span>
      </button>
      ${t.thinkingExpanded ? html`<pre class="thinking-body">${t.thinking}</pre>` : nothing}
    </div>`;
  }

  private toggleThinking(id: string) {
    this.fire("gc:update-turns", {
      updater: (turns: Turn[]) =>
        turns.map((t) => (t.id === id ? { ...t, thinkingExpanded: !t.thinkingExpanded } : t)),
    });
  }

  private renderToolEvents(events: ToolEvent[]) {
    return html`<div class="tool-events" role="list">
      ${events.map((ev) => this.renderToolEvent(ev))}
    </div>`;
  }

  private renderToolEvent(ev: ToolEvent) {
    const icon =
      ev.state === "running"
        ? html`<span class="tool-dot tool-dot--running" aria-hidden="true"></span>`
        : ev.state === "error"
          ? html`<span class="tool-dot tool-dot--error" aria-hidden="true">✗</span>`
          : html`<span class="tool-dot tool-dot--done" aria-hidden="true">✓</span>`;
    const summary = fmtToolSummary(ev);
    const canExpand = ev.state !== "running";
    return html`<div class="tool-event ${ev.state}" role="listitem">
      <button
        class="tool-event-head"
        ?disabled=${!canExpand}
        aria-expanded=${ev.expanded ? "true" : "false"}
        @click=${() => this.toggleToolEvent(ev.id)}
      >
        ${icon}
        <span class="tool-name">${ev.name}</span>
        <span class="tool-summary">${summary}</span>
        ${canExpand
          ? html`<span class="tool-caret" aria-hidden="true">${ev.expanded ? "▾" : "▸"}</span>`
          : nothing}
      </button>
      ${ev.expanded
        ? html`<div class="tool-body">
            <div class="tool-body-label">args</div>
            <pre class="tool-body-pre">${fmtJSON(ev.argsJson)}</pre>
            ${ev.content !== undefined
              ? html`<div class="tool-body-label">
                    result${ev.state === "error" ? " (error)" : ""}
                  </div>
                  <pre class="tool-body-pre ${ev.state === "error" ? "is-error" : ""}">
${ev.content}</pre
                  >`
              : nothing}
          </div>`
        : nothing}
    </div>`;
  }

  private toggleToolEvent(id: string) {
    this.fire("gc:update-turns", {
      updater: (turns: Turn[]) =>
        turns.map((t) =>
          t.tools
            ? {
                ...t,
                tools: t.tools.map((ev) => (ev.id === id ? { ...ev, expanded: !ev.expanded } : ev)),
              }
            : t,
        ),
    });
  }

  private renderAttachmentChip(a: ClientAttachment) {
    const isImage = a.mimeType.startsWith("image/") && a.url;
    const tooltip = `${a.filename} · ${fmtBytes(a.size)}`;
    if (isImage) {
      return html`<div class="attachment-chip is-image" role="listitem" title=${tooltip}>
        <img src=${a.url!} alt=${a.filename} class="attachment-thumb" />
      </div>`;
    }
    return html`<div class="attachment-chip is-file" role="listitem" title=${tooltip}>
      <span class="attachment-glyph" aria-hidden="true">📄</span>
      <span class="attachment-meta">
        <span class="attachment-name">${a.filename}</span>
        <span class="attachment-size">${fmtBytes(a.size)}</span>
      </span>
    </div>`;
  }

  private renderEditTurn(t: Turn) {
    const rows = Math.max(2, Math.min(12, t.content.split("\n").length));
    return html`
      <div class="body edit">
        <textarea
          class="edit-input"
          rows=${rows}
          .value=${t.content}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.preventDefault();
              this.cancelEdit();
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const v = (e.target as HTMLTextAreaElement).value;
              this.commitEdit(t.id, v);
            }
          }}
          @input=${(e: Event) => {
            const ta = e.target as HTMLTextAreaElement;
            ta.style.height = "auto";
            ta.style.height = `${ta.scrollHeight}px`;
          }}
        ></textarea>
        <div class="edit-actions">
          <button class="turn-action" @click=${() => this.cancelEdit()}>cancel</button>
          <button
            class="turn-action primary"
            @click=${(e: Event) => {
              const ta = (
                e.currentTarget as HTMLElement
              ).parentElement?.parentElement?.querySelector<HTMLTextAreaElement>(".edit-input");
              if (ta) this.commitEdit(t.id, ta.value);
            }}
          >
            send
          </button>
        </div>
      </div>
    `;
  }

  private editablePair(): { userIdx: number; assistantIdx: number } | null {
    if (this.sending) return null;
    const last = this.turns.length - 1;
    if (last < 1) return null;
    const a = this.turns[last];
    const u = this.turns[last - 1];
    if (!a || !u) return null;
    if (a.role !== MessageRole.ASSISTANT || u.role !== MessageRole.USER) return null;
    if (a.streaming) return null;
    if (a.id.startsWith("local-") || u.id.startsWith("local-")) return null;
    return { userIdx: last - 1, assistantIdx: last };
  }

  private beginEditLast() {
    const pair = this.editablePair();
    if (!pair) return;
    const user = this.turns[pair.userIdx]!;
    this.editingTurnId = user.id;
  }

  private cancelEdit() {
    this.editingTurnId = "";
  }

  private commitEdit(turnId: string, newText: string) {
    const trimmed = newText.trim();
    const idx = this.turns.findIndex((t) => t.id === turnId);
    if (idx < 0 || trimmed === "" || trimmed === this.turns[idx]?.content) {
      this.editingTurnId = "";
      return;
    }
    const target = this.turns[idx]!;
    this.editingTurnId = "";
    this.fire("gc:edit-turn", { text: trimmed, replaceFromMessageId: target.id, sliceAt: idx });
  }

  private fireRetry() {
    this.fire("gc:retry", {});
  }

  private fireRegenerate() {
    this.fire("gc:regenerate", {});
  }

  private copyTurn(e: Event, t: Turn) {
    e.stopPropagation();
    void copyText(e.currentTarget as HTMLElement, t.content, "Message copied");
  }

  private onMessagesClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.classList.contains("copy-code")) return;
    const block = target.closest(".code-block");
    const pre = block?.querySelector("pre");
    const text = pre?.textContent ?? "";
    if (!text) return;
    void copyText(target, text, "Code copied");
  };

  private fire<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  static override styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: 0.82rem;
      color: var(--text);
    }
    .messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--space-6) var(--space-7) var(--space-4);
      scroll-behavior: smooth;
    }
    .messages-inner {
      max-width: var(--content-max-width);
      margin: 0 auto;
    }
    :host([unfocused]) .messages-inner {
      max-width: none;
    }

    /* ── Turns ───────────────────────────────────────────────────── */
    .turn {
      position: relative;
      margin-bottom: var(--space-7);
    }
    .turn:last-child {
      margin-bottom: var(--space-2);
    }
    .turn-actions {
      position: absolute;
      top: 0;
      right: 0;
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.1s;
    }
    .turn:hover .turn-actions,
    .turn-actions:focus-within {
      opacity: 1;
    }
    .turn-action {
      padding: 2px 8px;
      background: var(--surface-2);
      color: var(--text-muted);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
    }
    .turn-action:hover {
      background: var(--surface-3);
      color: var(--text);
    }
    .turn-action.primary {
      background: var(--action-bg);
      color: var(--text);
      border-color: var(--surface-4);
    }
    .turn-action.primary:hover {
      background: var(--action-bg-hover);
    }
    .turn-action:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .body.edit {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .edit-input {
      width: 100%;
      resize: none;
      background: var(--surface-0);
      color: var(--text);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-sm);
      padding: var(--space-2);
      font-family: inherit;
      font-size: inherit;
      line-height: 1.5;
    }
    .edit-input:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .edit-actions {
      display: flex;
      gap: 4px;
      justify-content: flex-end;
    }
    .md .code-block {
      position: relative;
    }
    .md .copy-code {
      position: absolute;
      top: var(--space-2);
      right: var(--space-2);
      padding: 2px 8px;
      background: var(--surface-2);
      color: var(--text-muted);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.1s;
    }
    .md .code-block:hover .copy-code,
    .md .copy-code:focus-visible {
      opacity: 1;
    }
    .md .copy-code:hover {
      background: var(--surface-3);
      color: var(--text);
    }
    .md .copy-code:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .turn-label {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 0.45rem;
      opacity: 0.5;
    }
    .turn.assistant .turn-label {
      color: var(--accent-assistant);
      opacity: 0.9;
    }
    .turn.user .turn-label {
      color: var(--accent-user);
      opacity: 0.85;
    }
    .turn-model {
      opacity: 0.55;
      font-weight: 400;
      color: var(--text);
      text-transform: none;
      letter-spacing: 0;
      font-size: 0.65rem;
    }
    .turn-model::before {
      content: "·";
      margin-right: var(--space-2);
      opacity: 0.5;
    }
    .turn.user .body {
      padding: 0.55rem 0.85rem;
      background: var(--surface-1-alt);
      border-left: 2px solid var(--border-user-rule);
      border-radius: 0 4px 4px 0;
      color: var(--text-secondary);
    }
    .turn.assistant .body {
      color: var(--text);
    }
    .body {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.6;
      font-size: var(--text-base);
    }
    .body.md {
      white-space: normal;
    }
    .body.md > *:first-child {
      margin-top: 0;
    }
    .body.md > *:last-child {
      margin-bottom: 0;
    }
    .body.md p {
      margin: 0.55em 0;
    }
    .body.md ul,
    .body.md ol {
      margin: 0.55em 0;
      padding-left: 1.4em;
    }
    .body.md li {
      margin: 0.2em 0;
    }
    .body.md li::marker {
      color: var(--accent-assistant);
      opacity: 0.6;
    }
    .body.md h1,
    .body.md h2,
    .body.md h3,
    .body.md h4 {
      margin: 1em 0 0.4em;
      font-weight: 600;
      line-height: 1.3;
      letter-spacing: -0.01em;
    }
    .body.md h1 {
      font-size: 1.05rem;
    }
    .body.md h2 {
      font-size: 0.98rem;
    }
    .body.md h3 {
      font-size: 0.9rem;
    }
    .body.md h4 {
      font-size: var(--text-base);
    }
    .body.md code {
      font-family: inherit;
      padding: 0.08em 0.4em;
      background: var(--surface-2);
      border: 1px solid var(--surface-4);
      border-radius: 3px;
      font-size: 0.92em;
    }
    .body.md pre {
      margin: 0.8em 0;
      padding: 0.9rem 1.1rem;
      background: var(--surface-0);
      border: 1px solid var(--surface-4);
      border-radius: 5px;
      overflow-x: auto;
      font-size: 0.76rem;
      line-height: 1.55;
    }
    .body.md pre code {
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 0;
      font-size: inherit;
    }
    .body.md .diff-block {
      margin: 0.8em 0;
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }
    .body.md .diff-block > summary {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      background: var(--surface-0);
      font-size: var(--text-xs);
      color: var(--text);
      opacity: 0.75;
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    .body.md .diff-block > summary::-webkit-details-marker {
      display: none;
    }
    .body.md .diff-block > summary::before {
      content: "▶";
      font-size: 0.6em;
      transition: transform 0.15s ease;
    }
    .body.md .diff-block[open] > summary::before {
      transform: rotate(90deg);
    }
    .body.md .diff-block > summary:hover {
      opacity: 1;
    }
    .body.md .diff-block > pre,
    .body.md .diff-block > .shiki {
      margin: 0;
      border-radius: 0;
      border: none;
      border-top: 1px solid var(--surface-4);
    }
    .body.md blockquote {
      margin: 0.7em 0;
      padding: 0.1em 0.95em;
      border-left: 2px solid var(--border-strong);
      color: var(--text-muted);
    }
    .body.md a {
      color: var(--accent-user);
      text-decoration: underline;
      text-decoration-color: var(--accent-link-dim);
    }
    .body.md a:hover {
      text-decoration-color: var(--accent-user);
    }
    .body.md hr {
      border: none;
      border-top: 1px solid var(--border-default);
      margin: 1.2em 0;
    }
    .body.md table {
      border-collapse: collapse;
      margin: 0.7em 0;
      font-size: var(--text-sm);
    }
    .body.md th,
    .body.md td {
      border: 1px solid var(--border-default);
      padding: 0.35em 0.7em;
      text-align: left;
    }
    .body.md th {
      background: var(--surface-2);
      font-weight: 600;
    }
    .cursor {
      display: inline-block;
      margin-left: 0.1ch;
      width: 0.5ch;
      animation: blink 1s infinite steps(1);
    }
    @keyframes blink {
      50% {
        opacity: 0;
      }
    }
    .token-info {
      margin-top: var(--space-2);
      font-size: var(--text-xs);
      opacity: 0.4;
      letter-spacing: 0.01em;
    }
    .turn-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-2);
    }
    .turn-warnings {
      margin-top: var(--space-2);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .turn-warning {
      font-size: 0.7rem;
      opacity: 0.65;
      color: var(--warning, var(--text));
    }
    .thinking-block {
      margin: var(--space-2) 0;
      border: 1px dashed var(--border-default);
      border-radius: 6px;
      background: var(--surface-2);
      font-size: var(--text-xs);
      opacity: 0.75;
    }
    .thinking-block.is-streaming {
      opacity: 1;
      border-style: solid;
      border-color: var(--border-accent, var(--border-default));
    }
    .thinking-head {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 0.5rem;
      padding: 4px 8px;
      background: transparent;
      border: none;
      color: var(--text);
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
      text-align: left;
    }
    .thinking-head:hover {
      background: var(--surface-3);
    }
    .thinking-label {
      font-style: italic;
      flex: 1;
    }
    .thinking-block.is-streaming .thinking-label::after {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-left: 0.4rem;
      border-radius: 50%;
      background: var(--accent-user);
      animation: toolPulse 1s ease-in-out infinite;
      vertical-align: middle;
    }
    .thinking-caret {
      opacity: 0.4;
      font-size: 10px;
    }
    .thinking-body {
      margin: 0;
      padding: 6px 10px 8px;
      max-height: 240px;
      overflow: auto;
      font-family: var(--font-mono, monospace);
      font-size: 0.7rem;
      white-space: pre-wrap;
      word-break: break-word;
      border-top: 1px solid var(--border-default);
      opacity: 0.9;
    }
    .tool-events {
      margin: var(--space-2) 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .tool-event {
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--surface-2);
      font-size: var(--text-xs);
    }
    .tool-event-head {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 4px 8px;
      background: transparent;
      border: none;
      color: var(--text);
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
      text-align: left;
    }
    .tool-event-head[disabled] {
      cursor: default;
      opacity: 0.8;
    }
    .tool-event-head:hover:not([disabled]) {
      background: var(--surface-3);
    }
    .tool-dot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      font-size: 10px;
      flex-shrink: 0;
    }
    .tool-dot--running {
      background: var(--accent-user);
      opacity: 0.6;
      animation: toolPulse 1s ease-in-out infinite;
    }
    .tool-dot--done {
      background: var(--accent-assistant, var(--accent-user));
      color: var(--surface-0);
    }
    .tool-dot--error {
      background: var(--danger, #d34);
      color: #fff;
    }
    @keyframes toolPulse {
      0%,
      100% {
        opacity: 0.3;
      }
      50% {
        opacity: 0.8;
      }
    }
    .tool-name {
      font-weight: 600;
      font-family: var(--font-mono, monospace);
    }
    .tool-summary {
      opacity: 0.65;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .tool-caret {
      opacity: 0.4;
      font-size: 10px;
    }
    .tool-body {
      padding: 0 8px 8px 28px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .tool-body-label {
      opacity: 0.5;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .tool-body-pre {
      margin: 0;
      padding: 6px 8px;
      background: var(--surface-3);
      border-radius: 4px;
      max-height: 240px;
      overflow: auto;
      font-family: var(--font-mono, monospace);
      font-size: 0.7rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .tool-body-pre.is-error {
      color: var(--danger, #d34);
    }
    .attachment-chip {
      position: relative;
      display: inline-flex;
      align-items: center;
      background: var(--surface-3);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: var(--text-xs);
    }
    .attachment-chip.is-image {
      padding: 0;
      overflow: hidden;
      width: 56px;
      height: 56px;
    }
    .attachment-chip.is-file {
      gap: 0.4rem;
      padding: 5px 6px 5px 8px;
      max-width: 240px;
    }
    .attachment-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .attachment-glyph {
      font-size: 14px;
      opacity: 0.65;
    }
    .attachment-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      line-height: 1.2;
    }
    .attachment-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .attachment-size {
      opacity: 0.55;
      font-size: 0.65rem;
    }
    /* Scrollbar */
    .messages::-webkit-scrollbar {
      width: 8px;
    }
    .messages::-webkit-scrollbar-thumb {
      background: var(--surface-4);
      border-radius: 4px;
    }
    .messages::-webkit-scrollbar-thumb:hover {
      background: var(--border-strong);
    }
    .messages::-webkit-scrollbar-track {
      background: transparent;
    }
    /* Focus */
    :focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: 2px;
    }
    button:focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: -1px;
      border-radius: var(--radius-md);
    }
    @media (prefers-reduced-motion: reduce) {
      .cursor {
        animation: none;
      }
      .messages {
        scroll-behavior: auto;
      }
    }
  `;
}

// Re-export MessageRole so the parent can use it without a separate import.
export { MessageRole };

declare global {
  interface HTMLElementTagNameMap {
    "gc-message-list": GcMessageList;
  }
}
