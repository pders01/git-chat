import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { chatClient } from "../../lib/transport.js";
import { messageOf } from "../../lib/chat-types.js";
import type { ChatSession } from "../../gen/gitchat/v1/chat_pb.js";

@customElement("gc-session-sidebar")
export class GcSessionSidebar extends LitElement {
  @property({ type: Array }) sessions: ChatSession[] = [];
  @property({ type: String }) selected = "";
  @property({ type: String }) repoId = "";

  @state() private editingSessionId = "";
  @state() private sessionFilter = "";
  @state() private confirmingDeleteSession = "";
  private confirmResetTimer: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.confirmResetTimer) {
      clearTimeout(this.confirmResetTimer);
      this.confirmResetTimer = null;
    }
  }

  private fire<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  private startRename(sessionId: string) {
    this.editingSessionId = sessionId;
    requestAnimationFrame(() => {
      const input = this.renderRoot.querySelector<HTMLInputElement>(
        `.rename-input[data-id="${sessionId}"]`,
      );
      input?.focus();
      input?.select();
    });
  }

  private async renameSession(sessionId: string, title: string) {
    this.editingSessionId = "";
    title = title.trim();
    if (!title) return;
    try {
      await chatClient.renameSession({ sessionId, title });
      this.fire("gc:sessions-changed", {});
    } catch {
      // Silently fail — title stays as-is.
    }
  }

  private async pinSession(sessionId: string, pinned: boolean) {
    try {
      await chatClient.pinSession({ sessionId, pinned });
      this.fire("gc:sessions-changed", {});
    } catch (e) {
      this.fire("gc:error", { message: messageOf(e) });
    }
  }

  private deleteSession(sessionId: string) {
    if (this.confirmingDeleteSession !== sessionId) {
      this.confirmingDeleteSession = sessionId;
      if (this.confirmResetTimer) clearTimeout(this.confirmResetTimer);
      this.confirmResetTimer = setTimeout(() => {
        this.confirmingDeleteSession = "";
        this.confirmResetTimer = null;
      }, 3000);
      return;
    }
    if (this.confirmResetTimer) {
      clearTimeout(this.confirmResetTimer);
      this.confirmResetTimer = null;
    }
    this.confirmingDeleteSession = "";
    this.fire("gc:delete-session", { sessionId });
  }

  override render() {
    return html`
      <button
        class="new"
        @click=${() => this.fire("gc:new-chat", {})}
        aria-label="New chat (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}K)"
      >
        <span class="plus" aria-hidden="true">+</span> new chat
      </button>
      <input
        class="session-filter"
        type="search"
        placeholder="filter sessions…"
        .value=${this.sessionFilter}
        @input=${(e: Event) => {
          this.sessionFilter = (e.target as HTMLInputElement).value;
        }}
        aria-label="Filter sessions"
      />
      <div class="sidebar-label" id="sessions-label">sessions</div>
      <ul class="sessions" role="list" aria-labelledby="sessions-label">
        ${this.sessions.length === 0
          ? html`<li class="sidebar-empty">no sessions yet</li>`
          : this.sessions
              .filter(
                (sess) =>
                  !this.sessionFilter ||
                  sess.title.toLowerCase().includes(this.sessionFilter.toLowerCase()),
              )
              .map(
                (sess) => html`
                  <li>
                    <div class="sess-row">
                      <button
                        class="sess ${sess.id === this.selected ? "selected" : ""}"
                        @click=${() => this.fire("gc:select-session", { sessionId: sess.id })}
                        @dblclick=${(e: Event) => {
                          e.preventDefault();
                          this.startRename(sess.id);
                        }}
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key === "F2") {
                            e.preventDefault();
                            this.startRename(sess.id);
                          }
                        }}
                        title="Double-click or F2 to rename"
                        aria-current=${sess.id === this.selected ? "true" : "false"}
                      >
                        ${this.editingSessionId === sess.id
                          ? html`<input
                              class="rename-input"
                              data-id=${sess.id}
                              .value=${sess.title}
                              @keydown=${(e: KeyboardEvent) => {
                                if (e.key === "Enter") {
                                  void this.renameSession(
                                    sess.id,
                                    (e.target as HTMLInputElement).value,
                                  );
                                }
                                if (e.key === "Escape") this.editingSessionId = "";
                              }}
                              @blur=${(e: Event) =>
                                void this.renameSession(
                                  sess.id,
                                  (e.target as HTMLInputElement).value,
                                )}
                              @click=${(e: Event) => e.stopPropagation()}
                            />`
                          : html`<span class="sess-title">${sess.title}</span>`}
                        <span class="sess-meta" aria-label="${sess.messageCount} messages"
                          >${sess.messageCount}</span
                        >
                      </button>
                      <button
                        class="sess-pin ${sess.pinned ? "pinned" : ""}"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          void this.pinSession(sess.id, !sess.pinned);
                        }}
                        aria-label=${sess.pinned ? "Unpin session" : "Pin session"}
                        title=${sess.pinned ? "Unpin" : "Pin"}
                      >
                        ${sess.pinned ? "\u2605" : "\u2606"}
                      </button>
                      <button
                        class="sess-delete ${this.confirmingDeleteSession === sess.id
                          ? "confirming"
                          : ""}"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          this.deleteSession(sess.id);
                        }}
                        aria-label=${this.confirmingDeleteSession === sess.id
                          ? "Click again to confirm delete"
                          : "Delete session"}
                        title=${this.confirmingDeleteSession === sess.id
                          ? "Click again to confirm"
                          : "Delete"}
                      >
                        ${this.confirmingDeleteSession === sess.id ? "?" : "×"}
                      </button>
                    </div>
                  </li>
                `,
              )}
      </ul>
    `;
  }

  /** Focus the "new chat" button — called by parent when drawer opens. */
  focusNew() {
    const target = this.renderRoot.querySelector<HTMLElement>(".new");
    target?.focus();
  }

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: 0.82rem;
      color: var(--text);
    }
    .new {
      margin: 0.85rem 0.85rem 0.6rem;
      padding: var(--space-2) 0.7rem;
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      cursor: pointer;
      text-align: left;
      display: flex;
      align-items: center;
      gap: var(--space-2);
      transition:
        background 0.12s ease,
        border-color 0.12s ease;
    }
    .new:hover {
      background: var(--surface-3);
      border-color: var(--border-strong);
    }
    .new .plus {
      color: var(--accent-assistant);
      font-weight: 600;
    }
    .session-filter {
      margin: 0 0.85rem var(--space-2);
      padding: var(--space-1) var(--space-2);
      background: var(--surface-0);
      color: var(--text);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      width: calc(100% - 1.7rem);
      box-sizing: border-box;
    }
    .session-filter:focus {
      outline: none;
      border-color: var(--border-strong);
    }
    .sidebar-label {
      padding: var(--space-2) 0.95rem 0.35rem;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.4;
    }
    .sessions {
      list-style: none;
      padding: 0 0.4rem 0.4rem;
      margin: 0;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .sessions li {
      margin: 0;
    }
    .sess {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      padding: 0.4rem 0.6rem;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--text);
      font-family: inherit;
      font-size: 0.76rem;
      text-align: left;
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .sess:hover {
      background: var(--surface-2);
    }
    .sess.selected {
      background: var(--surface-2);
      border-color: var(--border-default);
    }
    .sess-row {
      display: flex;
      align-items: center;
    }
    .sess-row .sess {
      flex: 1;
      min-width: 0;
    }
    .sess-delete {
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      background: transparent;
      color: var(--text);
      border: none;
      font-size: 0.9rem;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.1s;
      border-radius: var(--radius-sm);
    }
    .sess-row:hover .sess-delete {
      opacity: 0.4;
    }
    .sess-delete:hover {
      opacity: 1 !important;
      color: var(--danger);
    }
    .sess-delete:focus-visible {
      opacity: 0.7;
      outline: 2px solid var(--accent-user);
      outline-offset: -2px;
    }
    .sess-delete.confirming {
      opacity: 1 !important;
      color: var(--danger);
      background: color-mix(in srgb, var(--danger) 15%, transparent);
    }
    .rename-input {
      width: 100%;
      background: var(--surface-0);
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: 0.1rem 0.3rem;
      font-family: inherit;
      font-size: inherit;
      outline: none;
    }
    .sess-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .sess-meta {
      opacity: 0.35;
      font-size: 0.68rem;
      flex-shrink: 0;
    }
    .sidebar-empty {
      padding: var(--space-2) 0.85rem;
      opacity: 0.35;
      font-size: 0.72rem;
      font-style: italic;
    }
    .sess-pin {
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      background: transparent;
      color: var(--text);
      border: none;
      font-size: 0.8rem;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.1s;
      border-radius: var(--radius-sm);
      padding: 0;
      line-height: 24px;
      text-align: center;
    }
    .sess-pin.pinned {
      opacity: 0.6;
      color: var(--accent-user);
    }
    .sess-row:hover .sess-pin {
      opacity: 0.4;
    }
    .sess-pin:hover {
      opacity: 1 !important;
      color: var(--accent-user);
    }
    /* Scrollbar */
    .sessions::-webkit-scrollbar {
      width: 8px;
    }
    .sessions::-webkit-scrollbar-thumb {
      background: var(--surface-4);
      border-radius: 4px;
    }
    .sessions::-webkit-scrollbar-thumb:hover {
      background: var(--border-strong);
    }
    .sessions::-webkit-scrollbar-track {
      background: transparent;
    }
    /* Focus */
    :focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: 2px;
    }
    button:focus-visible,
    .sess:focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: -1px;
      border-radius: var(--radius-md);
    }
    @media (prefers-reduced-motion: reduce) {
      .new,
      .sess {
        transition: none;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-session-sidebar": GcSessionSidebar;
  }
}
