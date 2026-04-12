import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { chatClient, repoClient } from "../lib/transport.js";
import { readFocus, writeFocus } from "../lib/focus.js";
import {
  type ChatSession,
  type ChatMessage,
  MessageRole,
} from "../gen/gitchat/v1/chat_pb.js";
import { EntryType } from "../gen/gitchat/v1/repo_pb.js";

// The markdown renderer pulls in `marked` + Shiki (via highlight.ts),
// which together weigh ~270 kB gzipped. Loading them eagerly would
// balloon the cold-start bundle for users who haven't sent a chat turn
// yet, so we lazy-import the module the first time it's needed. The
// same module instance is cached across calls via this memoized promise.
let markdownModule: Promise<typeof import("../lib/markdown.js")> | null = null;
function loadMarkdown() {
  if (!markdownModule) {
    markdownModule = import("../lib/markdown.js");
  }
  return markdownModule;
}

// A turn in the in-memory transcript. For messages loaded from history it
// maps 1:1 onto ChatMessage; for the in-flight assistant turn, `streaming`
// is true and `content` grows as tokens arrive.
//
// `html` is the DOMPurify-sanitized markdown rendering of `content`. We
// populate it lazily — once after streaming finishes for live turns, and
// immediately after load for historical turns. While a turn is actively
// streaming, `html` stays undefined and the UI falls back to plain text.
// Re-parsing markdown on every token would produce visual flicker (fenced
// code blocks opening and closing) and wastes CPU on Shiki calls that
// would be invalidated on the next chunk.
type Turn = {
  id: string;
  role: MessageRole;
  content: string;
  model?: string;
  streaming?: boolean;
  html?: string;
};

type ViewState =
  | { phase: "loading" }
  | { phase: "ready"; sessions: ChatSession[]; selected: string | null }
  | { phase: "error"; message: string };

@customElement("gc-chat-view")
export class GcChatView extends LitElement {
  @property({ type: String }) repoId = "";

  @state() private state: ViewState = { phase: "loading" };
  @state() private turns: Turn[] = [];
  @state() private input = "";
  @state() private sending = false;
  @state() private error = "";
  @state() private editingSessionId = "";
  @state() private sessionFilter = "";
  // @-mention autocomplete state.
  @state() private mentionResults: string[] = [];
  @state() private showMentions = false;
  @state() private mentionIdx = -1;
  /** Cache of directory path → full entry paths (dirs suffixed with /). */
  private dirCache = new Map<string, string[]>();
  // Focus mode hides the session sidebar and removes the messages
  // reader-width cap so the whole main area is chat content. Persisted
  // per-browser via localStorage.
  @state() private focused = readFocus();
  // Mobile drawer state — sidebar slides in as overlay on narrow viewports.
  @state() private drawerOpen = false;

  private toggleFocus = () => {
    this.focused = !this.focused;
    writeFocus(this.focused);
  };

  override updated(changed: Map<string, unknown>) {
    if (changed.has("repoId") && this.repoId) {
      void this.loadSessions();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.repoId) {
      void this.loadSessions();
    }
    // Listen for global shortcut events from gc-app.
    this.addEventListener("gc:new-chat", () => this.newChat());
    this.addEventListener("gc:toggle-focus", () => this.toggleFocus());
    // Cross-view bridge: select a specific session (from search).
    this.addEventListener("gc:select-session", ((e: CustomEvent<{ sessionId: string }>) => {
      void this.selectSession(e.detail.sessionId);
    }) as EventListener);
    // Cross-view bridge: prefill composer from other views.
    this.addEventListener("gc:prefill", ((e: CustomEvent<{ text: string }>) => {
      this.newChat();
      this.input = e.detail.text;
      requestAnimationFrame(() => {
        const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
        ta?.focus();
      });
    }) as EventListener);
    // Component-local shortcuts (/, Escape, arrow keys in sidebar).
    this.addEventListener("keydown", this.onKeydownLocal);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this.onKeydownLocal);
  }

  private onKeydownLocal = (e: KeyboardEvent) => {
    // "/" focuses the composer when not already in an input.
    if (
      e.key === "/" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !(e.target instanceof HTMLTextAreaElement) &&
      !(e.target instanceof HTMLInputElement)
    ) {
      e.preventDefault();
      const ta =
        this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
      ta?.focus();
      return;
    }
    // Escape blurs the composer.
    if (e.key === "Escape") {
      const root = this.renderRoot as ShadowRoot;
      if (root.activeElement instanceof HTMLTextAreaElement) {
        root.activeElement.blur();
      }
    }

    // Arrow keys in session list: roving tabindex.
    if (
      (e.key === "ArrowDown" || e.key === "ArrowUp") &&
      (e.target as HTMLElement)?.closest?.(".sessions")
    ) {
      e.preventDefault();
      const buttons = [
        ...this.renderRoot.querySelectorAll<HTMLButtonElement>(".sess"),
      ];
      if (buttons.length === 0) return;
      const current = buttons.findIndex(
        (b) => b === (this.renderRoot as ShadowRoot).activeElement,
      );
      const next =
        e.key === "ArrowDown"
          ? (current + 1) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

  private async loadSessions() {
    try {
      const resp = await chatClient.listSessions({ repoId: this.repoId });
      this.state = {
        phase: "ready",
        sessions: resp.sessions,
        selected: null,
      };
      this.turns = [];
      this.error = "";
    } catch (e) {
      this.state = { phase: "error", message: messageOf(e) };
    }
  }

  private startRename(sessionId: string) {
    this.editingSessionId = sessionId;
    requestAnimationFrame(() => {
      const input = this.renderRoot.querySelector<HTMLInputElement>(`.rename-input[data-id="${sessionId}"]`);
      input?.focus();
      input?.select();
    });
  }

  private async selectSession(sessionId: string) {
    if (this.state.phase !== "ready") return;
    this.drawerOpen = false;
    this.state = { ...this.state, selected: sessionId };
    try {
      const resp = await chatClient.getSession({ sessionId });
      this.turns = resp.messages.map(turnFromMessage);
      // Kick off markdown rendering for all assistant turns in
      // parallel. Each resolution triggers an incremental re-render
      // via the triggered state update inside renderTurnMarkdown.
      void this.renderHistoricalMarkdown();
    } catch (e) {
      this.error = messageOf(e);
      this.turns = [];
    }
  }

  // renderHistoricalMarkdown walks the freshly-loaded transcript and
  // resolves markdown HTML for every assistant turn in parallel. Each
  // completion triggers a lit update by assigning a new turns array.
  private async renderHistoricalMarkdown() {
    const targets = this.turns.filter(
      (t) => t.role === MessageRole.ASSISTANT && !t.html,
    );
    if (targets.length === 0) return;
    const { renderMarkdown } = await loadMarkdown();
    const diffResolver = this.diffResolver();
    await Promise.all(
      targets.map(async (t) => {
        t.html = await renderMarkdown(t.content, diffResolver);
        this.turns = [...this.turns];
      }),
    );
  }

  // diffResolver returns a DiffResolver closure bound to the current
  // repoId. Passed into renderMarkdown so `[[diff …]]` markers in
  // assistant prose get replaced with fenced ```diff blocks that
  // Shiki then highlights. Returns null when repoId is empty so
  // markdown still renders during auth/init phases.
  private diffResolver() {
    const repoId = this.repoId;
    if (!repoId) return undefined;
    return async (ref: { from: string; to: string; path: string }) => {
      try {
        const resp = await repoClient.getDiff({
          repoId,
          fromRef: ref.from,
          toRef: ref.to,
          path: ref.path,
        });
        if (resp.empty) {
          return `(no changes to ${ref.path})`;
        }
        return resp.unifiedDiff;
      } catch {
        // Swallow errors; unresolved markers are left as-is by the
        // markdown pipeline so the user sees the raw LLM output.
        return "";
      }
    };
  }

  private async renameSession(sessionId: string, title: string) {
    this.editingSessionId = "";
    title = title.trim();
    if (!title) return;
    try {
      await chatClient.renameSession({ sessionId, title });
      void this.loadSessions();
    } catch {
      // Silently fail — title stays as-is.
    }
  }

  private exportSession() {
    if (this.turns.length === 0) return;
    const lines: string[] = [];
    for (const t of this.turns) {
      const role = t.role === MessageRole.USER ? "**You**" : `**Assistant** (${t.model || "?"})`;
      lines.push(`${role}\n\n${t.content}\n\n---\n`);
    }
    const md = lines.join("\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-export-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async deleteSession(sessionId: string) {
    if (!confirm("Delete this session? This cannot be undone.")) return;
    try {
      await chatClient.deleteSession({ sessionId });
      if (this.state.phase === "ready" && this.state.selected === sessionId) {
        this.state = { ...this.state, selected: null };
        this.turns = [];
      }
      void this.loadSessions();
    } catch (e) {
      this.error = messageOf(e);
    }
  }

  private newChat() {
    if (this.state.phase !== "ready") return;
    this.drawerOpen = false;
    this.state = { ...this.state, selected: null };
    this.turns = [];
    this.error = "";
  }

  private onInput(e: Event) {
    this.input = (e.target as HTMLTextAreaElement).value;
    this.checkMention();
  }

  private async checkMention() {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = this.input.slice(0, pos);
    const atMatch = before.match(/@([\w\-./]*)$/);
    if (!atMatch) {
      this.showMentions = false;
      return;
    }
    const query = atMatch[1];
    // Determine which directory to list based on the query.
    // e.g. "src/comp" → dir "src", filter "comp"
    // e.g. "src/components/" → dir "src/components", filter ""
    const lastSlash = query.lastIndexOf("/");
    const dirPath = lastSlash >= 0 ? query.slice(0, lastSlash) : "";
    const filterPart = (lastSlash >= 0 ? query.slice(lastSlash + 1) : query).toLowerCase();
    // Lazy-load directory entries with caching.
    if (!this.dirCache.has(dirPath)) {
      try {
        const resp = await repoClient.listTree({ repoId: this.repoId, path: dirPath });
        const prefix = dirPath ? dirPath + "/" : "";
        this.dirCache.set(
          dirPath,
          resp.entries.map((e) =>
            prefix + e.name + (e.type === EntryType.DIR ? "/" : ""),
          ),
        );
      } catch {
        this.dirCache.set(dirPath, []);
      }
    }
    this.mentionResults = (this.dirCache.get(dirPath) || [])
      .filter((p) => {
        const name = p.slice(p.lastIndexOf("/", p.length - 2) + 1).toLowerCase();
        return name.includes(filterPart);
      })
      .slice(0, 8);
    this.mentionIdx = -1;
    this.showMentions = this.mentionResults.length > 0;
  }

  private insertMention(path: string) {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = this.input.slice(0, pos);
    const after = this.input.slice(pos);
    const atIdx = before.lastIndexOf("@");
    this.input = before.slice(0, atIdx) + "@" + path + " " + after;
    this.showMentions = false;
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = atIdx + path.length + 2;
      ta.setSelectionRange(newPos, newPos);
    });
  }

  private onKeydown(e: KeyboardEvent) {
    // Mention autocomplete keyboard navigation.
    if (this.showMentions && this.mentionResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.mentionIdx = (this.mentionIdx + 1) % this.mentionResults.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.mentionIdx = this.mentionIdx <= 0 ? this.mentionResults.length - 1 : this.mentionIdx - 1;
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && this.mentionIdx >= 0) {
        e.preventDefault();
        this.insertMention(this.mentionResults[this.mentionIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.showMentions = false;
        return;
      }
    }
    // Cmd+Enter / Ctrl+Enter sends; plain Enter inserts a newline.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void this.send();
    }
  }

  private async send() {
    const text = this.input.trim();
    if (!text || this.sending || this.state.phase !== "ready") return;

    const sessionId = this.state.selected ?? "";
    const userTurn: Turn = {
      id: `local-${Date.now()}`,
      role: MessageRole.USER,
      content: text,
    };
    const assistantTurn: Turn = {
      id: `local-${Date.now()}-a`,
      role: MessageRole.ASSISTANT,
      content: "",
      streaming: true,
    };
    this.turns = [...this.turns, userTurn, assistantTurn];
    this.input = "";
    this.sending = true;
    this.error = "";
    this.announce("Sending message");

    try {
      const stream = chatClient.sendMessage({
        sessionId,
        repoId: this.repoId,
        text,
      });
      for await (const chunk of stream) {
        if (chunk.kind.case === "token") {
          assistantTurn.content += chunk.kind.value;
          this.turns = [...this.turns]; // trigger re-render
          this.scrollToBottom();
        } else if (chunk.kind.case === "cardHit") {
          // M5 fast-path: answer came from the knowledge base,
          // not a fresh LLM call. Populate the assistant turn
          // directly with the cached answer content.
          const hit = chunk.kind.value;
          assistantTurn.content = hit.answerMd;
          assistantTurn.model = `${hit.model} · cached`;
          assistantTurn.streaming = false;
          this.turns = [...this.turns];
          this.scrollToBottom();
          this.announce(`Answer served from knowledge base cache, hit ${hit.hitCount} times`);
          // Render markdown immediately (no more tokens coming).
          const diffResolver = this.diffResolver();
          void loadMarkdown()
            .then(({ renderMarkdown }) =>
              renderMarkdown(assistantTurn.content, diffResolver),
            )
            .then((htmlStr) => {
              assistantTurn.html = htmlStr;
              this.turns = [...this.turns];
            });
        } else if (chunk.kind.case === "done") {
          assistantTurn.streaming = false;
          assistantTurn.id = chunk.kind.value.assistantMessageId;
          assistantTurn.model = chunk.kind.value.model;
          if (chunk.kind.value.error) {
            this.error = chunk.kind.value.error;
            // Surface the error inside the assistant bubble too, not
            // just in the status line — a silent empty bubble is
            // worse UX than an explicit failure note.
            if (!assistantTurn.content) {
              assistantTurn.content = `⚠ ${chunk.kind.value.error}`;
            }
          }
          // Now that the full assistant text is known, promote it
          // from plain text to rendered markdown. Fire-and-forget;
          // the update below re-renders once the Shiki passes resolve.
          // Diff markers are resolved in parallel inside renderMarkdown
          // via the resolver closure.
          const diffResolver = this.diffResolver();
          void loadMarkdown()
            .then(({ renderMarkdown }) =>
              renderMarkdown(assistantTurn.content, diffResolver),
            )
            .then((htmlStr) => {
              assistantTurn.html = htmlStr;
              this.turns = [...this.turns];
            });
          // If this was a new session, re-fetch the session list so the
          // sidebar reflects the newly-created entry.
          if (!sessionId && chunk.kind.value.sessionId) {
            const newId = chunk.kind.value.sessionId;
            const list = await chatClient.listSessions({ repoId: this.repoId });
            this.state = {
              phase: "ready",
              sessions: list.sessions,
              selected: newId,
            };
          }
          this.turns = [...this.turns];
        }
      }
    } catch (e) {
      this.error = messageOf(e);
      assistantTurn.streaming = false;
      this.turns = [...this.turns];
    } finally {
      this.sending = false;
      if (this.error) {
        this.announce(`Error: ${this.error}`);
      } else {
        this.announce("Response complete");
      }
    }
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      const pane = this.renderRoot.querySelector(".messages");
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  }

  // Screen-reader announcements via an aria-live region. The content
  // is set, read by the SR, then cleared after a tick so subsequent
  // announcements aren't suppressed by dedup.
  @state() private announcement = "";
  private announce(msg: string) {
    this.announcement = msg;
    setTimeout(() => {
      this.announcement = "";
    }, 3000);
  }

  override render() {
    if (this.state.phase === "loading") {
      return html`<div class="boot">loading chat…</div>`;
    }
    if (this.state.phase === "error") {
      return html`<div class="boot">
        <span class="err">${this.state.message}</span>
        <button class="retry-btn" @click=${() => void this.loadSessions()}>retry</button>
      </div>`;
    }
    // Narrow once up here so all the template references are type-safe.
    const s = this.state;
    return html`
      <div class="layout ${this.focused ? "focused" : ""} ${this.drawerOpen ? "drawer-open" : ""}" role="main"
        @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape" && this.drawerOpen) { this.drawerOpen = false; } }}>
        <button
          class="drawer-toggle"
          @click=${() => (this.drawerOpen = !this.drawerOpen)}
          aria-label="Toggle sidebar"
        >☰</button>
        ${this.drawerOpen ? html`<div class="drawer-backdrop" @click=${() => (this.drawerOpen = false)}></div>` : nothing}
        <aside class="sidebar" aria-label="Chat sessions">
          <button class="new" @click=${() => this.newChat()} aria-label="New chat (⌘K)">
            <span class="plus" aria-hidden="true">+</span> new chat
          </button>
          ${s.sessions.length > 5
            ? html`<input
                class="session-filter"
                type="search"
                placeholder="filter sessions…"
                .value=${this.sessionFilter}
                @input=${(e: Event) => { this.sessionFilter = (e.target as HTMLInputElement).value; }}
                aria-label="Filter sessions"
              />`
            : nothing}
          <div class="sidebar-label" id="sessions-label">sessions</div>
          <ul class="sessions" role="list" aria-labelledby="sessions-label">
            ${s.sessions.length === 0
              ? html`<li class="sidebar-empty">no sessions yet</li>`
              : s.sessions
                  .filter((sess) => !this.sessionFilter || sess.title.toLowerCase().includes(this.sessionFilter.toLowerCase()))
                  .map(
                  (sess) => html`
                    <li>
                      <div class="sess-row">
                        <button
                          class="sess ${sess.id === s.selected ? "selected" : ""}"
                          @click=${() => this.selectSession(sess.id)}
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
                          aria-current=${sess.id === s.selected ? "true" : "false"}
                        >
                          ${this.editingSessionId === sess.id
                            ? html`<input
                                class="rename-input"
                                data-id=${sess.id}
                                .value=${sess.title}
                                @keydown=${(e: KeyboardEvent) => {
                                  if (e.key === "Enter") {
                                    void this.renameSession(sess.id, (e.target as HTMLInputElement).value);
                                  }
                                  if (e.key === "Escape") this.editingSessionId = "";
                                }}
                                @blur=${(e: Event) => void this.renameSession(sess.id, (e.target as HTMLInputElement).value)}
                                @click=${(e: Event) => e.stopPropagation()}
                              />`
                            : html`<span class="sess-title">${sess.title}</span>`}
                          <span class="sess-meta" aria-label="${sess.messageCount} messages">${sess.messageCount}</span>
                        </button>
                        <button
                          class="sess-delete"
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            void this.deleteSession(sess.id);
                          }}
                          aria-label="Delete session"
                          title="Delete"
                        >×</button>
                      </div>
                    </li>
                  `,
                )}
          </ul>
        </aside>

        <section class="pane">
          <div class="pane-hd">
            ${s.selected
              ? html`<button
                  class="export-btn"
                  @click=${() => this.exportSession()}
                  title="Export as markdown"
                  aria-label="Export session"
                >↓ export</button>`
              : nothing}
            <button
              class="focus-btn"
              @click=${this.toggleFocus}
              aria-label=${this.focused ? "Show sidebar" : "Hide sidebar"}
              aria-pressed=${this.focused ? "true" : "false"}
            >
              ${this.focused ? "◀" : "▶"}
              <span class="focus-label">
                ${this.focused ? "exit focus" : "focus"}
              </span>
            </button>
          </div>
          <div class="messages" role="log" aria-live="polite" aria-label="Chat messages">
            <div class="messages-inner">
              ${this.turns.length === 0
                ? this.renderEmptyState()
                : this.turns.map((t) => this.renderTurn(t))}
            </div>
          </div>

          <form
            class="composer"
            role="search"
            aria-label="Chat composer"
            @submit=${(e: Event) => {
              e.preventDefault();
              void this.send();
            }}
          >
            <div class="composer-inner">
              <textarea
                .value=${this.input}
                @input=${this.onInput}
                @keydown=${this.onKeydown}
                placeholder="ask about the repo — use @path/to/file to pin content"
                ?disabled=${this.sending}
                rows="1"
                aria-label="Message input — type @ for file autocomplete, ⌘↵ to send"
                aria-describedby="composer-status"
                aria-autocomplete="list"
                aria-expanded=${this.showMentions ? "true" : "false"}
              ></textarea>
              ${this.showMentions
                ? html`<ul class="mention-list" role="listbox">
                    ${this.mentionResults.map(
                      (p, i) => html`<li role="option" aria-selected=${i === this.mentionIdx ? "true" : "false"}>
                        <button class="mention-item ${i === this.mentionIdx ? "active" : ""}" @click=${() => this.insertMention(p)}>
                          ${p}
                        </button>
                      </li>`,
                    )}
                  </ul>`
                : nothing}
              <div class="composer-row">
                <span class="composer-hint" id="composer-status" role="status">
                  ${this.error
                    ? html`<span class="err">⚠ ${this.error}</span>`
                    : this.sending
                      ? html`<span class="dim">streaming…</span>`
                      : html`<span class="dim">⌘↵ or ctrl↵ to send</span>`}
                </span>
                <button
                  type="submit"
                  aria-label="Send message"
                  class="send"
                  ?disabled=${this.sending || !this.input.trim()}
                >
                  send
                </button>
              </div>
            </div>
          </form>
        </section>
        <div class="sr-only" role="status" aria-live="assertive">
          ${this.announcement}
        </div>
      </div>
    `;
  }

  private renderEmptyState() {
    return html`
      <div class="empty-chat">
        <div class="empty-title">ready when you are</div>
        <p class="empty-sub">
          ask a question about the repo. pin files with
          <code>@path/to/file</code> to inject their contents into context.
        </p>
        <div class="empty-examples">
          <button
            class="example"
            @click=${() => this.prefillExample("What is this project about?")}
          >
            <span class="example-head">overview</span>
            <span class="example-body">What is this project about?</span>
          </button>
          <button
            class="example"
            @click=${() =>
              this.prefillExample(
                "Summarize the architecture in @docs/ARCHITECTURE.md",
              )}
          >
            <span class="example-head">with @file</span>
            <span class="example-body">
              Summarize the architecture in @docs/ARCHITECTURE.md
            </span>
          </button>
        </div>
      </div>
    `;
  }

  // prefillExample drops an example prompt into the composer and focuses
  // it, so clicking an example feels like "start here" rather than
  // auto-sending.
  private prefillExample(text: string) {
    this.input = text;
    requestAnimationFrame(() => {
      const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  }

  private renderTurn(t: Turn) {
    const roleClass =
      t.role === MessageRole.USER
        ? "user"
        : t.role === MessageRole.ASSISTANT
          ? "assistant"
          : "system";
    // Assistant turns that have finished streaming and whose markdown
    // has finished rendering get the rich HTML path. Everything else
    // (user input, in-flight streams, turns still awaiting their
    // markdown promise) falls through to a plain pre-wrap <div>.
    const body =
      t.role === MessageRole.ASSISTANT && !t.streaming && t.html
        ? html`<div class="body md">${unsafeHTML(t.html)}</div>`
        : html`<div class="body">${t.content}${t.streaming
              ? html`<span class="cursor">▍</span>`
              : nothing}</div>`;
    // Assistant turns are rendered as flowing prose with a tiny label
    // above. User turns get a muted left-border block — enough visual
    // weight to separate them from assistant prose without hijacking
    // attention. Neither side uses the chat-bubble pattern.
    if (t.role === MessageRole.USER) {
      return html`
        <article class="turn user">
          <div class="turn-label">you</div>
          ${body}
        </article>
      `;
    }
    return html`
      <article class="turn ${roleClass}">
        <div class="turn-label">
          assistant${t.model
            ? html`<span class="turn-model">${t.model.toLowerCase()}</span>`
            : nothing}
        </div>
        ${body}
      </article>
    `;
  }

  static override styles = css`
    /* ── Scroll chain ─────────────────────────────────────────────────
       The parent <main> in gc-app is a flex item with min-height:0. This
       host element fills it (display:flex + min-height:0), the .layout
       grid fills the host, the .pane section is a flex column with
       min-height:0, and .messages is flex:1 + overflow-y:auto. Every
       link in the chain has min-height:0 — that's what makes the
       messages region clamp and scroll instead of growing forever. */
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
    .boot {
      padding: var(--space-7);
      opacity: 0.5;
      font-size: 0.85rem;
    }
    .layout {
      display: grid;
      grid-template-columns: var(--sidebar-width) 1fr;
      flex: 1;
      min-height: 0;
      min-width: 0;
      transition: grid-template-columns 0.2s ease;
    }
    /* Focus mode collapses the sidebar column to zero and stretches
       the messages/composer reader-width cap so the whole main area
       becomes content. Toggled via .focus-btn in .pane-hd. */
    .layout.focused {
      grid-template-columns: 0 1fr;
    }
    .layout.focused .sidebar {
      overflow: hidden;
      border-right-width: 0;
    }
    .layout.focused .messages-inner {
      max-width: none;
    }
    .layout.focused .composer-inner {
      max-width: 1000px;
    }

    /* ── Sidebar ─────────────────────────────────────────────────── */
    .sidebar {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--surface-4);
      background: var(--surface-0);
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
      transition: background 0.12s ease, border-color 0.12s ease;
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

    /* ── Main pane ───────────────────────────────────────────────── */
    .pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      background: var(--surface-1);
      position: relative;
    }
    .pane-hd {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 0.4rem var(--space-3) 0;
      flex-shrink: 0;
    }
    .export-btn {
      padding: var(--space-1) var(--space-3);
      background: transparent;
      color: var(--text);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.4;
      transition: opacity 0.12s ease;
    }
    .export-btn:hover {
      opacity: 0.9;
      border-color: var(--border-default);
    }
    .focus-btn {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: var(--space-1) 0.55rem;
      background: transparent;
      color: var(--text);
      border: 1px solid transparent;
      border-radius: 3px;
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.4;
      transition: opacity 0.12s ease, background 0.12s ease, border-color 0.12s ease;
    }
    .focus-btn:hover {
      opacity: 0.9;
      background: var(--surface-2);
      border-color: var(--border-default);
    }
    .focus-label {
      letter-spacing: 0.05em;
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

    /* ── Empty state ─────────────────────────────────────────────── */
    .empty-chat {
      max-width: var(--content-max-width);
      margin: 4rem auto 0;
      text-align: center;
    }
    .empty-title {
      font-size: 1.1rem;
      font-weight: 500;
      margin-bottom: var(--space-2);
      color: var(--text);
    }
    .empty-sub {
      margin: 0 0 var(--space-7);
      opacity: 0.55;
      font-size: 0.82rem;
      line-height: 1.6;
    }
    .empty-sub code {
      font-family: inherit;
      padding: 0.08em 0.4em;
      background: var(--surface-2);
      border: 1px solid var(--surface-4);
      border-radius: 3px;
      font-size: 0.9em;
    }
    .empty-examples {
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
      text-align: left;
    }
    .example {
      padding: var(--space-3) 0.95rem;
      background: var(--surface-1-alt);
      border: 1px solid var(--surface-4);
      border-radius: 5px;
      color: var(--text);
      font-family: inherit;
      font-size: inherit;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      text-align: left;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .example:hover {
      background: var(--surface-2);
      border-color: var(--border-strong);
    }
    .example-head {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.5;
      color: var(--accent-assistant);
    }
    .example-body {
      font-size: 0.82rem;
    }

    /* ── Turns ───────────────────────────────────────────────────── */
    .turn {
      margin-bottom: var(--space-7);
    }
    .turn:last-child {
      margin-bottom: var(--space-2);
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

    /* User turns: muted block with a subtle left rule — visually
       lighter than assistant prose so the eye lands on the answer. */
    .turn.user .body {
      padding: 0.55rem 0.85rem;
      background: var(--surface-1-alt);
      border-left: 2px solid var(--border-user-rule);
      border-radius: 0 4px 4px 0;
      color: var(--text-secondary);
    }

    /* Assistant turns: document-style, no container. */
    .turn.assistant .body {
      color: var(--text);
    }

    .body {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.6;
      font-size: var(--text-base);
    }
    /* Markdown path: HTML handles structure, so normal whitespace. */
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
    .body.md h1 { font-size: 1.05rem; }
    .body.md h2 { font-size: 0.98rem; }
    .body.md h3 { font-size: 0.9rem; }
    .body.md h4 { font-size: var(--text-base); }
    .body.md code {
      font-family: inherit;
      padding: 0.08em 0.4em;
      background: var(--surface-2);
      border: 1px solid var(--surface-4);
      border-radius: 3px;
      font-size: 0.92em;
    }
    /* Shiki <pre> blocks: reset the inline code styling inside. */
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
    /* Diff block framing: <details class="diff-block"> wraps every
       resolved [[diff]] marker. The <summary> shows the ref range
       and path; clicking it collapses/expands the diff. */
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
      list-style: none; /* hide default disclosure triangle */
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
    /* The <pre> inside the open <details> should sit flush against
       the summary with no extra margin from .body.md pre. */
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

    /* ── Composer ────────────────────────────────────────────────── */
    /* Sits at the bottom of .pane. We give it a subtle top gradient
       fade so content scrolling behind it dims slightly before reaching
       the composer edge — makes the "now" area feel anchored without
       a hard border. */
    .composer {
      flex-shrink: 0;
      padding: var(--space-3) var(--space-7) var(--space-5);
      background: var(--surface-1);
      position: relative;
    }
    .composer::before {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: -24px;
      height: 24px;
      background: linear-gradient(to top, var(--surface-1), transparent);
      pointer-events: none;
    }
    .composer-inner {
      max-width: var(--content-max-width);
      margin: 0 auto;
      box-sizing: border-box;
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      padding: 0.65rem 0.85rem var(--space-2);
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      transition: border-color 0.12s ease;
    }
    .composer-inner:focus-within {
      border-color: var(--border-accent);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      resize: none;
      background: transparent;
      color: var(--text);
      border: none;
      padding: 0.15rem 0.05rem;
      font-family: inherit;
      font-size: var(--text-base);
      line-height: 1.5;
      min-height: 1.5em;
      max-height: 40vh;
      overflow-y: auto;
    }
    textarea:focus {
      outline: none;
    }
    textarea::placeholder {
      opacity: 0.35;
    }
    .mention-list {
      list-style: none;
      margin: 0;
      padding: var(--space-1) 0;
      border-top: 1px solid var(--surface-4);
      max-height: 160px;
      overflow-y: auto;
    }
    .mention-item {
      display: block;
      width: 100%;
      padding: var(--space-1) var(--space-2);
      background: transparent;
      color: var(--accent-user);
      border: none;
      font-family: inherit;
      font-size: var(--text-xs);
      text-align: left;
      cursor: pointer;
    }
    .mention-item:hover,
    .mention-item.active {
      background: var(--surface-3);
    }
    .composer-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-3);
    }
    .composer-hint {
      font-size: 0.68rem;
    }
    .dim {
      opacity: 0.4;
    }
    .err {
      color: var(--danger);
    }
    .send {
      padding: 0.3rem 0.95rem;
      background: var(--action-bg);
      color: var(--text);
      border: 1px solid var(--border-accent);
      border-radius: 4px;
      font-family: inherit;
      font-size: 0.76rem;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .send:hover:not(:disabled) {
      background: var(--action-bg-hover);
    }
    .send:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    /* ── Scrollbar polish ────────────────────────────────────────── */
    .messages::-webkit-scrollbar,
    .sessions::-webkit-scrollbar,
    textarea::-webkit-scrollbar {
      width: 8px;
    }
    .messages::-webkit-scrollbar-thumb,
    .sessions::-webkit-scrollbar-thumb,
    textarea::-webkit-scrollbar-thumb {
      background: var(--surface-4);
      border-radius: 4px;
    }
    .messages::-webkit-scrollbar-thumb:hover,
    .sessions::-webkit-scrollbar-thumb:hover,
    textarea::-webkit-scrollbar-thumb:hover {
      background: var(--border-strong);
    }
    .messages::-webkit-scrollbar-track,
    .sessions::-webkit-scrollbar-track,
    textarea::-webkit-scrollbar-track {
      background: transparent;
    }

    /* ── Retry button ──────────────────────────────────────────── */
    .retry-btn {
      margin-top: var(--space-3);
      padding: var(--space-2) var(--space-4);
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
    }
    .retry-btn:hover {
      background: var(--surface-3);
    }

    /* ── Screen-reader only ───────────────────────────────────── */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    /* ── Focus-visible ─────────────────────────────────────────── */
    /* Visible ring for keyboard nav; hidden for mouse clicks. */
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
    textarea:focus-visible {
      outline: none; /* composer-inner handles focus state */
    }

    /* ── Reduced motion ────────────────────────────────────────── */
    @media (prefers-reduced-motion: reduce) {
      .cursor {
        animation: none;
      }
      .messages {
        scroll-behavior: auto;
      }
      .layout {
        transition: none;
      }
      .focus-btn,
      .new,
      .sess,
      .example,
      .send {
        transition: none;
      }
    }
    /* ── Mobile drawer ──────────────────────────────────────────── */
    .drawer-toggle {
      display: none;
    }
    .drawer-backdrop {
      display: none;
    }
    @media (max-width: 768px) {
      .layout,
      .layout.focused {
        grid-template-columns: 1fr;
      }
      .drawer-toggle {
        display: block;
        position: fixed;
        bottom: var(--space-5);
        left: var(--space-4);
        z-index: 30;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: var(--surface-2);
        color: var(--text);
        border: 1px solid var(--border-default);
        font-size: 1.1rem;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
      .sidebar {
        position: fixed;
        top: 44px;
        left: 0;
        bottom: 0;
        width: 280px;
        z-index: 40;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        border-right: 1px solid var(--surface-4);
      }
      .drawer-open .sidebar {
        transform: translateX(0);
      }
      .drawer-backdrop {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.5);
        z-index: 35;
      }
      .drawer-open .drawer-backdrop {
        display: block;
      }
      .pane-hd {
        display: none;
      }
    }
  `;
}

function turnFromMessage(m: ChatMessage): Turn {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model || undefined,
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
