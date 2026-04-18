import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { chatClient, repoClient } from "../lib/transport.js";
import { readFocus, writeFocus } from "../lib/focus.js";
import {
  type Turn,
  type ClientAttachment,
  type ViewState,
  MessageRole,
  estimateCost,
  fmtNum,
  messageOf,
  turnFromMessage,
} from "../lib/chat-types.js";
import "./loading-indicator.js";
import "./chat-view/chat-dashboard.js";
import "./chat-view/session-sidebar.js";
import "./chat-view/message-list.js";
import "./chat-view/composer.js";
import type { GcComposer } from "./chat-view/composer.js";
import type { GcMessageList } from "./chat-view/message-list.js";
import type { GcSessionSidebar } from "./chat-view/session-sidebar.js";

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

@customElement("gc-chat-view")
export class GcChatView extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) branch = "";
  @property({ type: String }) initialSessionId = "";
  @property({ attribute: false }) pendingPrefill: { text: string; nonce: number } | null = null;
  @property({ attribute: false }) pendingFileMention: { path: string; nonce: number } | null = null;
  @property({ type: Number }) newChatNonce = 0;
  @property({ type: Number }) focusNonce = 0;

  @state() private state: ViewState = { phase: "loading" };
  @state() private turns: Turn[] = [];
  @state() private sending = false;
  @state() private error = "";
  private abortController: AbortController | null = null;
  @state() private focused = readFocus();
  @state() private drawerOpen = false;
  @state() private sessionTokensIn = 0;
  @state() private sessionTokensOut = 0;

  private _lastRestoredSession = "";
  private _lastPrefillNonce = 0;
  private _lastFileMentionNonce = 0;
  private _lastNewChatNonce = 0;
  private _lastFocusNonce = 0;

  private toggleFocus = () => {
    this.focused = !this.focused;
    writeFocus(this.focused);
  };

  override updated(changed: Map<string, unknown>) {
    if (changed.has("repoId") && this.repoId) {
      this._lastRestoredSession = "";
      void this.loadSessions();
    }
    if (
      changed.has("initialSessionId") &&
      this.initialSessionId &&
      this.initialSessionId !== this._lastRestoredSession
    ) {
      this._lastRestoredSession = this.initialSessionId;
      if (this.state.phase === "ready") {
        void this.selectSession(this.initialSessionId);
      }
    }
    if (
      changed.has("pendingPrefill") &&
      this.pendingPrefill &&
      this.pendingPrefill.nonce !== this._lastPrefillNonce
    ) {
      this._lastPrefillNonce = this.pendingPrefill.nonce;
      const text = this.pendingPrefill.text;
      this.newChat();
      requestAnimationFrame(() => {
        const composer = this.getComposer();
        composer?.setInput(text);
        composer?.focusInput();
      });
    }
    if (
      changed.has("pendingFileMention") &&
      this.pendingFileMention &&
      this.pendingFileMention.nonce !== this._lastFileMentionNonce
    ) {
      this._lastFileMentionNonce = this.pendingFileMention.nonce;
      this.getComposer()?.insertFileMention(this.pendingFileMention.path);
    }
    if (
      changed.has("newChatNonce") &&
      this.newChatNonce > 0 &&
      this.newChatNonce !== this._lastNewChatNonce
    ) {
      this._lastNewChatNonce = this.newChatNonce;
      this.newChat();
    }
    if (
      changed.has("focusNonce") &&
      this.focusNonce > 0 &&
      this.focusNonce !== this._lastFocusNonce
    ) {
      this._lastFocusNonce = this.focusNonce;
      this.focused = readFocus();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.repoId) {
      void this.loadSessions();
    }
    this.addEventListener("keydown", this.onKeydownLocal);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this.onKeydownLocal);
  }

  private onKeydownLocal = (e: KeyboardEvent) => {
    // "/" focuses the composer when not already in an input.
    const origin = e.composedPath()[0];
    const inInput =
      origin instanceof HTMLTextAreaElement ||
      origin instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLInputElement;
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !inInput) {
      e.preventDefault();
      this.getComposer()?.focusInput();
      return;
    }
  };

  private getComposer(): GcComposer | null {
    return this.renderRoot.querySelector<GcComposer>("gc-composer");
  }
  private getMessageList(): GcMessageList | null {
    return this.renderRoot.querySelector<GcMessageList>("gc-message-list");
  }
  private getSidebar(): GcSessionSidebar | null {
    return this.renderRoot.querySelector<GcSessionSidebar>("gc-session-sidebar");
  }

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

  private async refreshSessions() {
    if (this.state.phase !== "ready") return;
    try {
      const resp = await chatClient.listSessions({ repoId: this.repoId });
      this.state = { ...this.state, sessions: resp.sessions };
    } catch (e) {
      this.error = messageOf(e);
    }
  }

  private async selectSession(sessionId: string) {
    if (this.state.phase !== "ready") return;
    // Toggle: clicking selected session returns to dashboard.
    if (this.state.selected === sessionId) {
      this.state = { ...this.state, selected: null };
      this.turns = [];
      this.dispatchNav({ sessionId: undefined });
      return;
    }
    this.drawerOpen = false;
    this.state = { ...this.state, selected: sessionId };
    // Reset the scroll anchor — the new transcript should land at the
    // bottom, not wherever the old one was.
    this.getMessageList()?.pinToBottom();
    this.sessionTokensIn = 0;
    this.sessionTokensOut = 0;
    try {
      const resp = await chatClient.getSession({ sessionId });
      this.turns = resp.messages.map(turnFromMessage);
      for (const m of resp.messages) {
        this.sessionTokensIn += Number(m.tokenCountIn) || 0;
        this.sessionTokensOut += Number(m.tokenCountOut) || 0;
      }
      void this.renderHistoricalMarkdown();
      this._lastRestoredSession = sessionId;
      this.dispatchNav({ sessionId });
    } catch (e) {
      this.error = messageOf(e);
      this.turns = [];
    }
  }

  private dispatchNav(detail: Record<string, string | undefined>) {
    this.dispatchEvent(new CustomEvent("gc:nav", { bubbles: true, composed: true, detail }));
  }

  private async renderHistoricalMarkdown() {
    const targets = this.turns.filter((t) => t.role === MessageRole.ASSISTANT && !t.html);
    if (targets.length === 0) return;
    const { renderMarkdown } = await loadMarkdown();
    const diffResolver = this.diffResolver();
    await Promise.all(
      targets.map(async (t) => {
        const rendered = await renderMarkdown(t.content, diffResolver);
        this.turns = this.turns.map((x) => (x.id === t.id ? { ...x, html: rendered } : x));
      }),
    );
  }

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
        return "";
      }
    };
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

  private async handleDeleteSession(sessionId: string) {
    try {
      await chatClient.deleteSession({ sessionId });
      if (this.state.phase === "ready" && this.state.selected === sessionId) {
        this.state = { ...this.state, selected: null };
        this.turns = [];
      }
      void this.refreshSessions();
    } catch (err) {
      this.error = messageOf(err);
    }
  }

  private toggleDrawer() {
    this.drawerOpen = !this.drawerOpen;
    if (this.drawerOpen) {
      void this.updateComplete.then(() => {
        this.getSidebar()?.focusNew();
      });
    }
  }

  private newChat() {
    if (this.state.phase !== "ready") return;
    this.drawerOpen = false;
    this.state = { ...this.state, selected: null };
    this.turns = [];
    this.error = "";
    this.sessionTokensIn = 0;
    this.sessionTokensOut = 0;
  }

  private async send(
    opts: {
      text?: string;
      attachments?: ClientAttachment[];
      replaceFromMessageId?: string;
    } = {},
  ) {
    const text = (opts.text ?? "").trim();
    const attachments = opts.attachments ?? [];
    if (!text && attachments.length === 0) return;
    if (this.sending || this.state.phase !== "ready") return;

    const sessionId = this.state.selected ?? "";
    const userTurn: Turn = {
      id: `local-${Date.now()}`,
      role: MessageRole.USER,
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    const assistantTurn: Turn = {
      id: `local-${Date.now()}-a`,
      role: MessageRole.ASSISTANT,
      content: "",
      streaming: true,
    };
    this.turns = [...this.turns, userTurn, assistantTurn];
    this.getMessageList()?.pinToBottom();
    this.getMessageList()?.scrollToBottom();
    this.sending = true;
    this.error = "";
    this.announce("Sending message");

    const ac = new AbortController();
    this.abortController = ac;

    try {
      const stream = chatClient.sendMessage(
        {
          sessionId,
          repoId: this.repoId,
          text,
          replaceFromMessageId: opts.replaceFromMessageId ?? "",
          attachments: attachments.map((a) => ({
            id: "",
            mimeType: a.mimeType,
            filename: a.filename,
            size: BigInt(a.size),
            data: a.data,
          })),
        },
        { signal: ac.signal },
      );
      for await (const chunk of stream) {
        if (chunk.kind.case === "started") {
          const started = chunk.kind.value;
          if (started.userMessageId) userTurn.id = started.userMessageId;
          if (started.warnings && started.warnings.length > 0) {
            userTurn.warnings = [...started.warnings];
          }
          if (started.sessionId && this.state.phase === "ready" && !this.state.selected) {
            const newId = started.sessionId;
            this.state = { ...this.state, selected: newId };
            this._lastRestoredSession = newId;
            this.dispatchNav({ sessionId: newId });
            void this.refreshSessions();
          }
          this.turns = [...this.turns];
        } else if (chunk.kind.case === "token") {
          assistantTurn.content += chunk.kind.value;
          this.turns = [...this.turns];
          this.getMessageList()?.scrollToBottom();
        } else if (chunk.kind.case === "thinking") {
          assistantTurn.thinking = (assistantTurn.thinking ?? "") + chunk.kind.value;
          this.turns = [...this.turns];
        } else if (chunk.kind.case === "toolCall") {
          const tc = chunk.kind.value;
          if (!assistantTurn.tools) assistantTurn.tools = [];
          assistantTurn.tools = [
            ...assistantTurn.tools,
            {
              id: tc.id,
              name: tc.name,
              argsJson: tc.argsJson,
              state: "running",
            },
          ];
          this.turns = [...this.turns];
          this.getMessageList()?.scrollToBottom();
        } else if (chunk.kind.case === "toolResult") {
          const tr = chunk.kind.value;
          if (assistantTurn.tools) {
            assistantTurn.tools = assistantTurn.tools.map((t) =>
              t.id === tr.id
                ? {
                    ...t,
                    state: tr.isError ? "error" : "done",
                    content: tr.content,
                  }
                : t,
            );
            this.turns = [...this.turns];
          }
        } else if (chunk.kind.case === "cardHit") {
          const hit = chunk.kind.value;
          assistantTurn.content = hit.answerMd;
          assistantTurn.model = `${hit.model} · cached`;
          assistantTurn.streaming = false;
          this.turns = [...this.turns];
          this.getMessageList()?.scrollToBottom();
          this.announce(`Answer served from knowledge base cache, hit ${hit.hitCount} times`);
          const diffResolver = this.diffResolver();
          void loadMarkdown()
            .then(({ renderMarkdown }) => renderMarkdown(assistantTurn.content, diffResolver))
            .then((htmlStr) => {
              assistantTurn.html = htmlStr;
              this.turns = [...this.turns];
            });
        } else if (chunk.kind.case === "done") {
          assistantTurn.streaming = false;
          assistantTurn.id = chunk.kind.value.assistantMessageId;
          assistantTurn.model = chunk.kind.value.model;
          const tIn = Number(chunk.kind.value.tokenCountIn) || 0;
          const tOut = Number(chunk.kind.value.tokenCountOut) || 0;
          assistantTurn.tokensIn = tIn;
          assistantTurn.tokensOut = tOut;
          this.sessionTokensIn += tIn;
          this.sessionTokensOut += tOut;
          if (chunk.kind.value.error) {
            this.error = chunk.kind.value.error;
            assistantTurn.error = chunk.kind.value.error;
            if (!assistantTurn.content) {
              assistantTurn.content = `⚠ ${chunk.kind.value.error}`;
            }
          }
          const diffResolver = this.diffResolver();
          void loadMarkdown()
            .then(({ renderMarkdown }) => renderMarkdown(assistantTurn.content, diffResolver))
            .then((htmlStr) => {
              assistantTurn.html = htmlStr;
              this.turns = [...this.turns];
            });
          if (!sessionId && chunk.kind.value.sessionId) {
            const newId = chunk.kind.value.sessionId;
            chatClient
              .listSessions({ repoId: this.repoId })
              .then((list) => {
                this.state = {
                  phase: "ready",
                  sessions: list.sessions,
                  selected: newId,
                };
                this._lastRestoredSession = newId;
                this.dispatchNav({ sessionId: newId });
              })
              .catch(() => {
                /* sidebar refresh failed — cosmetic only */
              });
          }
          this.turns = [...this.turns];
        }
      }
    } catch (e) {
      this.error = messageOf(e);
      assistantTurn.streaming = false;
      assistantTurn.error = this.error;
      if (!assistantTurn.content) assistantTurn.content = `⚠ ${this.error}`;
      this.turns = [...this.turns];
    } finally {
      this.abortController = null;
      this.sending = false;
      if (this.error) {
        this.announce(`Error: ${this.error}`);
      } else {
        this.announce("Response complete");
      }
    }
  }

  private stop() {
    this.abortController?.abort();
  }

  // Retry after a mid-stream failure.
  private retryLast() {
    const last = this.turns.length - 1;
    if (last < 1) return;
    const assistant = this.turns[last];
    const user = this.turns[last - 1];
    if (!assistant?.error || user?.role !== MessageRole.USER) return;
    const replaceId = user.id.startsWith("local-") ? "" : user.id;
    const attachments = user.attachments ?? [];
    this.turns = this.turns.slice(0, last - 1);
    void this.send({ text: user.content, attachments, replaceFromMessageId: replaceId });
  }

  // Regenerate: drop the last user+assistant pair from the client view
  // and re-run generation with the same user text.
  private regenerateLast() {
    const last = this.turns.length - 1;
    if (last < 1 || this.sending) return;
    const a = this.turns[last];
    const u = this.turns[last - 1];
    if (!a || !u) return;
    if (a.role !== MessageRole.ASSISTANT || u.role !== MessageRole.USER) return;
    if (a.streaming) return;
    if (a.id.startsWith("local-") || u.id.startsWith("local-")) return;
    const attachments = u.attachments ?? [];
    this.turns = this.turns.slice(0, last - 1);
    void this.send({ text: u.content, attachments, replaceFromMessageId: u.id });
  }

  @state() private announcement = "";
  private announce(msg: string) {
    this.announcement = msg;
    setTimeout(() => {
      this.announcement = "";
    }, 3000);
  }

  // ── Child component event handlers ──────────────────────────────
  private onComposerSend = (e: CustomEvent<{ text: string; attachments: ClientAttachment[] }>) => {
    void this.send({ text: e.detail.text, attachments: e.detail.attachments });
    this.getComposer()?.clearAfterSend();
  };

  private onComposerStop = () => this.stop();

  private onComposerError = (e: CustomEvent<{ message: string }>) => {
    this.error = e.detail.message;
  };

  private onComposerAnnounce = (e: CustomEvent<{ message: string }>) => {
    this.announce(e.detail.message);
  };

  private onMessageRetry = () => this.retryLast();
  private onMessageRegenerate = () => this.regenerateLast();
  private onMessageEdit = (
    e: CustomEvent<{ text: string; replaceFromMessageId: string; sliceAt: number }>,
  ) => {
    // Drop the edited turn and everything after it locally; the server
    // will truncate matching rows when we send.
    const target = this.turns[e.detail.sliceAt];
    const attachments = target?.attachments ?? [];
    this.turns = this.turns.slice(0, e.detail.sliceAt);
    void this.send({
      text: e.detail.text,
      attachments,
      replaceFromMessageId: e.detail.replaceFromMessageId,
    });
  };
  private onUpdateTurns = (e: CustomEvent<{ updater: (turns: Turn[]) => Turn[] }>) => {
    this.turns = e.detail.updater(this.turns);
  };

  private onPrefillExample = (e: CustomEvent<{ text: string }>) => {
    requestAnimationFrame(() => {
      const composer = this.getComposer();
      composer?.setInput(e.detail.text);
      composer?.focusInput();
    });
  };

  private onSidebarSelect = (e: CustomEvent<{ sessionId: string }>) => {
    void this.selectSession(e.detail.sessionId);
  };
  private onSidebarNew = () => this.newChat();
  private onSidebarDelete = (e: CustomEvent<{ sessionId: string }>) =>
    void this.handleDeleteSession(e.detail.sessionId);
  private onSidebarSessionsChanged = () => void this.refreshSessions();

  override render() {
    if (this.state.phase === "loading") {
      return html`<gc-loading-banner heading="loading chat…"></gc-loading-banner>`;
    }
    if (this.state.phase === "error") {
      return html`<div class="boot">
        <span class="err">${this.state.message}</span>
        <button class="retry-btn" @click=${() => void this.loadSessions()}>retry</button>
      </div>`;
    }
    const s = this.state;
    return html`
      <div
        class=${classMap({ layout: true, focused: this.focused, "drawer-open": this.drawerOpen })}
        role="main"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Escape" && this.drawerOpen) {
            this.drawerOpen = false;
          }
        }}
      >
        <button
          class="drawer-toggle"
          @click=${() => this.toggleDrawer()}
          aria-label="Toggle sidebar"
          aria-expanded=${this.drawerOpen ? "true" : "false"}
        >
          ☰
        </button>
        ${this.drawerOpen
          ? html`<div class="drawer-backdrop" @click=${() => (this.drawerOpen = false)}></div>`
          : nothing}
        <aside class="sidebar" aria-label="Chat sessions" tabindex="-1">
          <gc-session-sidebar
            .sessions=${s.sessions}
            .selected=${s.selected ?? ""}
            .repoId=${this.repoId}
            @gc:select-session=${this.onSidebarSelect}
            @gc:new-chat=${this.onSidebarNew}
            @gc:delete-session=${this.onSidebarDelete}
            @gc:sessions-changed=${this.onSidebarSessionsChanged}
            @gc:error=${this.onComposerError}
          ></gc-session-sidebar>
        </aside>

        <section class="pane">
          <div class="pane-hd">
            ${this.sessionTokensIn || this.sessionTokensOut
              ? html`<span class="session-tokens"
                  >${fmtNum(this.sessionTokensIn)} in · ${fmtNum(this.sessionTokensOut)} out ·
                  ${estimateCost("", this.sessionTokensIn, this.sessionTokensOut)}</span
                >`
              : nothing}
            ${s.selected
              ? html`<button
                  class="export-btn"
                  @click=${() => this.exportSession()}
                  title="Export as markdown"
                  aria-label="Export session"
                >
                  ↓ export
                </button>`
              : nothing}
            <button
              class="focus-btn"
              @click=${this.toggleFocus}
              aria-label=${this.focused ? "Show sidebar" : "Hide sidebar"}
              aria-pressed=${this.focused ? "true" : "false"}
            >
              ${this.focused ? "◀" : "▶"}
              <span class="focus-label"> ${this.focused ? "exit focus" : "focus"} </span>
            </button>
          </div>

          ${this.turns.length === 0
            ? html`<div class="dashboard-wrap">
                <gc-chat-dashboard
                  .repoId=${this.repoId}
                  @gc:prefill-example=${this.onPrefillExample}
                ></gc-chat-dashboard>
              </div>`
            : html`<gc-message-list
                .turns=${this.turns}
                .sending=${this.sending}
                ?unfocused=${this.focused}
                @gc:retry=${this.onMessageRetry}
                @gc:regenerate=${this.onMessageRegenerate}
                @gc:edit-turn=${this.onMessageEdit}
                @gc:update-turns=${this.onUpdateTurns}
              ></gc-message-list>`}

          <gc-composer
            .repoId=${this.repoId}
            .sending=${this.sending}
            .errorMsg=${this.error}
            ?unfocused=${this.focused}
            @gc:send=${this.onComposerSend}
            @gc:stop=${this.onComposerStop}
            @gc:error=${this.onComposerError}
            @gc:announce=${this.onComposerAnnounce}
          ></gc-composer>
        </section>
        <div class="sr-only" role="status" aria-live="assertive">${this.announcement}</div>
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
    .layout.focused {
      grid-template-columns: 0 1fr;
    }
    .layout.focused .sidebar {
      overflow: hidden;
      border-right-width: 0;
    }
    .sidebar {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      border-right: 1px solid var(--surface-4);
      background: var(--surface-0);
    }
    .sidebar gc-session-sidebar {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
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
      transition:
        opacity 0.12s ease,
        background 0.12s ease,
        border-color 0.12s ease;
    }
    .focus-btn:hover {
      opacity: 0.9;
      background: var(--surface-2);
      border-color: var(--border-default);
    }
    .focus-label {
      letter-spacing: 0.05em;
    }
    .session-tokens {
      font-size: var(--text-xs);
      opacity: 0.4;
      margin-right: auto;
      letter-spacing: 0.01em;
    }
    .dashboard-wrap {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--space-6) var(--space-7) var(--space-4);
    }
    gc-message-list {
      flex: 1;
      min-height: 0;
      display: flex;
    }
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
    .err {
      color: var(--danger);
    }
    /* Screen-reader only */
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
      .layout {
        transition: none;
      }
      .focus-btn {
        transition: none;
      }
    }
    /* Mobile drawer */
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
        box-shadow: var(--shadow-dropdown);
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
        background: rgba(0, 0, 0, 0.5);
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
