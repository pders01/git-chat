import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { chatClient, repoClient } from "../lib/transport.js";
import { readFocus, writeFocus } from "../lib/focus.js";
import { copyText } from "../lib/clipboard.js";
import { type ChatSession, type ChatMessage, MessageRole } from "../gen/gitchat/v1/chat_pb.js";
import { EntryType } from "../gen/gitchat/v1/repo_pb.js";
import "./loading-indicator.js";

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
  tokensIn?: number;
  tokensOut?: number;
  // Non-empty when the assistant turn errored mid-stream or completed
  // with Done.error. Surfaces a retry button on that turn and lets
  // the regenerate path distinguish "rerun a good answer" from
  // "recover from a failure".
  error?: string;
  attachments?: ClientAttachment[];
  // Soft server-side notices ("images stripped — model doesn't support
  // vision"). Rendered below the user turn so the degradation is
  // visible without blocking the stream.
  warnings?: string[];
  // Agentic tool invocations the assistant triggered during this
  // turn, in the order they were emitted. A ToolEvent starts with
  // state="running" on the ToolCall chunk and flips to "done" on
  // the matching ToolResult. Rendered as a compact summary block
  // above the assistant prose; expand to see args + result.
  tools?: ToolEvent[];
  // Reasoning-model chain-of-thought accumulated during this turn.
  // Rendered as a collapsible "thinking" block above the reply.
  // Kept separate from `content` so the user's clipboard copy of
  // the assistant turn stays clean.
  thinking?: string;
  thinkingExpanded?: boolean;
};

type ToolEvent = {
  id: string;
  name: string;
  argsJson: string;
  state: "running" | "done" | "error";
  content?: string;
  expanded?: boolean;
};

// ClientAttachment is the composer/rendering shape for a user-uploaded
// file. `url` is an object URL created once for image previews — we
// lean on browser-tab lifetime rather than bookkeeping revocations,
// since the upload caps keep total memory bounded.
type ClientAttachment = {
  mimeType: string;
  filename: string;
  size: number;
  data: Uint8Array;
  url?: string;
};

// Client-side attachment validation mirrors the server (see
// internal/chat/service.go). Drift is not checked — keep in sync.
const ALLOWED_ATTACHMENT_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 8;

async function readFileToAttachment(file: File): Promise<ClientAttachment> {
  const buf = await file.arrayBuffer();
  const data = new Uint8Array(buf);
  const att: ClientAttachment = {
    mimeType: file.type || "application/octet-stream",
    filename: file.name || "attachment",
    size: data.byteLength,
    data,
  };
  if (att.mimeType.startsWith("image/")) {
    att.url = bytesToDataURL(data, att.mimeType);
  }
  return att;
}

function attachmentFromProto(a: {
  mimeType: string;
  filename: string;
  size: bigint;
  data: Uint8Array;
}): ClientAttachment {
  const out: ClientAttachment = {
    mimeType: a.mimeType,
    filename: a.filename,
    size: Number(a.size),
    data: a.data,
  };
  if (out.mimeType.startsWith("image/") && a.data.byteLength > 0) {
    out.url = bytesToDataURL(a.data, out.mimeType);
  }
  return out;
}

// bytesToDataURL builds a data: URL from raw bytes. Data URLs sidestep
// Blob lifetime and object-URL revocation entirely, and our attachment
// caps keep the resulting string from growing pathologically.
function bytesToDataURL(data: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

// Per-model pricing in dollars per million tokens.
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4": { in: 15, out: 75 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "gpt-4o": { in: 2.5, out: 10 },
};
const DEFAULT_PRICING = { in: 5, out: 15 };

function estimateCost(model: string, tokensIn: number, tokensOut: number): string {
  const key = Object.keys(MODEL_PRICING).find((k) => model.toLowerCase().includes(k));
  const rate = key ? MODEL_PRICING[key] : DEFAULT_PRICING;
  const cost = (tokensIn * rate.in + tokensOut * rate.out) / 1_000_000;
  if (cost < 0.001) return "<$0.001";
  return `~$${cost.toFixed(3)}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// fmtToolSummary renders a one-line recap of a tool invocation that
// still reads at a glance: the top-level string args joined compactly.
// We prefer this over raw JSON because ~80% of our tools take a single
// path/query, and users care about "what file/query" far more than
// "what shape did the JSON have".
function fmtToolSummary(ev: ToolEvent): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = ev.argsJson ? JSON.parse(ev.argsJson) : {};
  } catch {
    return ev.argsJson.slice(0, 80);
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v.length > 0) parts.push(`${k}=${v}`);
  }
  return parts.join(" · ");
}

// fmtJSON reformats a JSON blob for the expanded tool panel. Falls
// back to the raw string if the payload isn't valid JSON so we never
// hide what actually went on the wire.
function fmtJSON(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

type ViewState =
  | { phase: "loading" }
  | { phase: "ready"; sessions: ChatSession[]; selected: string | null }
  | { phase: "error"; message: string };

@customElement("gc-chat-view")
export class GcChatView extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) branch = "";
  @property({ type: String }) initialSessionId = "";

  @state() private state: ViewState = { phase: "loading" };
  @state() private turns: Turn[] = [];
  @state() private input = "";
  @state() private sending = false;
  @state() private error = "";
  @state() private pendingAttachments: ClientAttachment[] = [];
  @state() private dragActive = false;
  private dragDepth = 0;
  @state() private editingSessionId = "";
  @state() private sessionFilter = "";
  // @-mention autocomplete state.
  @state() private mentionResults: string[] = [];
  @state() private showMentions = false;
  @state() private mentionIdx = -1;
  /** Cache of directory path → full entry paths (dirs suffixed with /). */
  private dirCache = new Map<string, string[]>();
  /** Sequence counter so an in-flight checkMention ignored once a newer
   * keystroke has started a fresh invocation. Prevents stale dropdown
   * flicker and, more importantly, prevents Enter from completing
   * against results that don't match the current input. */
  private checkMentionSeq = 0;
  private abortController: AbortController | null = null;
  // Focus mode hides the session sidebar and removes the messages
  // reader-width cap so the whole main area is chat content. Persisted
  // per-browser via localStorage.
  @state() private focused = readFocus();
  // Mobile drawer state — sidebar slides in as overlay on narrow viewports.
  @state() private drawerOpen = false;
  // Two-step delete for sessions: session id being armed, or "" if none.
  @state() private confirmingDeleteSession = "";
  private confirmResetTimer: ReturnType<typeof setTimeout> | null = null;
  // Cumulative token counts for the current session.
  @state() private sessionTokensIn = 0;
  @state() private sessionTokensOut = 0;
  // Dashboard: recent commits + auto-generated suggestions.
  @state() private activitySummary = "";
  @state() private summaryLoading = false;
  private cachedSummaryKey = ""; // repoId:headSha — only re-fetch on new commits
  @state() private suggestions: Array<{ label: string; prompt: string }> = [];

  private toggleFocus = () => {
    this.focused = !this.focused;
    writeFocus(this.focused);
  };

  private _lastRestoredSession = "";

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
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.repoId) {
      void this.loadSessions();
    }
    // Listen for global shortcut events from gc-app.
    this.addEventListener("gc:new-chat", this.onNewChat);
    this.addEventListener("gc:toggle-focus", this.onSyncFocus);
    this.addEventListener("gc:select-session", this.onSelectSession as EventListener);
    this.addEventListener("gc:prefill", this.onPrefill as EventListener);
    this.addEventListener("keydown", this.onKeydownLocal);
  }

  private onNewChat = () => this.newChat();
  private onSyncFocus = () => {
    this.focused = readFocus();
  };
  private onSelectSession = ((e: CustomEvent<{ sessionId: string }>) => {
    void this.selectSession(e.detail.sessionId);
  }) as EventListener;
  private onPrefill = ((e: CustomEvent<{ text: string }>) => {
    this.newChat();
    this.input = e.detail.text;
    requestAnimationFrame(() => {
      const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
      ta?.focus();
    });
  }) as EventListener;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("gc:new-chat", this.onNewChat);
    this.removeEventListener("gc:toggle-focus", this.onSyncFocus);
    this.removeEventListener("gc:select-session", this.onSelectSession as EventListener);
    this.removeEventListener("gc:prefill", this.onPrefill as EventListener);
    this.removeEventListener("keydown", this.onKeydownLocal);
    if (this.confirmResetTimer) {
      clearTimeout(this.confirmResetTimer);
      this.confirmResetTimer = null;
    }
  }

  private onKeydownLocal = (e: KeyboardEvent) => {
    // "/" focuses the composer when not already in an input.
    // Use composedPath() to properly handle shadow DOM retargeting.
    const origin = e.composedPath()[0];
    const inInput =
      origin instanceof HTMLTextAreaElement ||
      origin instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLInputElement;
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !inInput) {
      e.preventDefault();
      const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
      ta?.focus();
      return;
    }
    // Escape blurs the composer textarea. Explicitly scope to the
    // main composer input so Escape inside the edit-turn textarea
    // (which has its own cancel handler that swaps the element out)
    // doesn't also fire a blur on an element the edit handler is
    // already tearing down.
    if (e.key === "Escape") {
      const root = this.renderRoot as ShadowRoot;
      const active = root.activeElement;
      if (active instanceof HTMLTextAreaElement && !active.classList.contains("edit-input")) {
        active.blur();
      }
    }

    // Arrow keys in session list: roving tabindex.
    if (
      (e.key === "ArrowDown" || e.key === "ArrowUp") &&
      (e.target as HTMLElement)?.closest?.(".sessions")
    ) {
      e.preventDefault();
      const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>(".sess")];
      if (buttons.length === 0) return;
      const current = buttons.findIndex((b) => b === (this.renderRoot as ShadowRoot).activeElement);
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
      void this.loadDashboard();
    } catch (e) {
      this.state = { phase: "error", message: messageOf(e) };
    }
  }

  private async loadDashboard() {
    // 1. Suggestions from commits — instant, no LLM.
    try {
      const commits = await repoClient.listCommits({ repoId: this.repoId, limit: 5, offset: 0 });
      const sug: Array<{ label: string; prompt: string }> = [];
      sug.push({ label: "overview", prompt: "What is this project about?" });
      if (commits.commits.length > 0) {
        const latest = commits.commits[0];
        sug.push({
          label: "latest",
          prompt: `What changed in commit ${latest.shortSha} ("${latest.message}")?`,
        });
      }
      if (commits.commits.length > 2) {
        sug.push({
          label: "recent",
          prompt: "What areas of the codebase have been worked on recently?",
        });
      }
      this.suggestions = sug.slice(0, 3);
    } catch {
      this.suggestions = [{ label: "overview", prompt: "What is this project about?" }];
    }

    // 2. LLM summary — cached by HEAD SHA, only re-fetch on new commits.
    try {
      const repos = await repoClient.listRepos({});
      const repo = repos.repos.find((r) => r.id === this.repoId);
      const headSha = repo?.headCommit ?? "";
      const cacheKey = `${this.repoId}:${headSha}`;
      if (cacheKey === this.cachedSummaryKey && this.activitySummary) return;

      this.summaryLoading = true;
      const resp = await (chatClient as any).summarizeActivity({ repoId: this.repoId });
      this.activitySummary = resp.summary || "";
      this.cachedSummaryKey = cacheKey;
    } catch {
      this.activitySummary = "";
    } finally {
      this.summaryLoading = false;
    }
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
    // Switching sessions resets the scroll anchor — the new
    // transcript should land at the bottom, not wherever the old
    // one was.
    this.scrollPinnedToBottom = true;
    this.sessionTokensIn = 0;
    this.sessionTokensOut = 0;
    try {
      const resp = await chatClient.getSession({ sessionId });
      this.turns = resp.messages.map(turnFromMessage);
      // Tally historical token counts for the session summary.
      for (const m of resp.messages) {
        this.sessionTokensIn += Number(m.tokenCountIn) || 0;
        this.sessionTokensOut += Number(m.tokenCountOut) || 0;
      }
      // Kick off markdown rendering for all assistant turns in
      // parallel. Each resolution triggers an incremental re-render
      // via the triggered state update inside renderTurnMarkdown.
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

  // renderHistoricalMarkdown walks the freshly-loaded transcript and
  // resolves markdown HTML for every assistant turn in parallel. Each
  // completion triggers a lit update by assigning a new turns array.
  private async renderHistoricalMarkdown() {
    const targets = this.turns.filter((t) => t.role === MessageRole.ASSISTANT && !t.html);
    if (targets.length === 0) return;
    const { renderMarkdown } = await loadMarkdown();
    const diffResolver = this.diffResolver();
    await Promise.all(
      targets.map(async (t) => {
        const rendered = await renderMarkdown(t.content, diffResolver);
        // Re-find the turn in the current array (it may have been replaced
        // by a concurrent send() creating a new array).
        this.turns = this.turns.map((x) => (x.id === t.id ? { ...x, html: rendered } : x));
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

  private async pinSession(sessionId: string, pinned: boolean) {
    if (this.state.phase !== "ready") return;
    try {
      await chatClient.pinSession({ sessionId, pinned });
      const resp = await chatClient.listSessions({ repoId: this.repoId });
      this.state = {
        ...this.state,
        sessions: resp.sessions,
      };
    } catch (e) {
      this.error = messageOf(e);
    }
  }

  private async deleteSession(sessionId: string) {
    // Two-step delete: first click arms and flips the row into a
    // "confirm" state for a short window; second click within that
    // window actually deletes. Replaces window.confirm() which
    // bypassed the app's Esc handling and is blocked / inconsistent
    // on mobile.
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

  private toggleDrawer() {
    this.drawerOpen = !this.drawerOpen;
    if (this.drawerOpen) {
      // Move focus into the sidebar so keyboard / AT users don't have
      // to Tab through the whole page from the FAB to reach it.
      void this.updateComplete.then(() => {
        const target =
          this.renderRoot.querySelector<HTMLElement>(".sidebar .new") ??
          this.renderRoot.querySelector<HTMLElement>(".sidebar");
        target?.focus();
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

  private onInput(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    this.input = ta.value;
    this.autoResize(ta);
    this.checkMention();
  }

  private autoResize(ta: HTMLTextAreaElement) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + "px";
  }

  private async checkMention() {
    const seq = ++this.checkMentionSeq;
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = this.input.slice(0, pos);
    const atMatch = before.match(/@([\w\-./]*)$/);
    if (!atMatch) {
      this.showMentions = false;
      this.mentionResults = [];
      return;
    }
    const query = atMatch[1];
    // Determine which directory to list based on the query.
    // e.g. "src/comp" → dir "src", filter "comp"
    // e.g. "src/components/" → dir "src/components", filter ""
    const lastSlash = query.lastIndexOf("/");
    const dirPath = lastSlash >= 0 ? query.slice(0, lastSlash) : "";
    const filterPart = (lastSlash >= 0 ? query.slice(lastSlash + 1) : query).toLowerCase();
    // Lazy-load directory entries with caching. If we'd have to fetch,
    // eagerly clear the stale results so Enter mid-flight can't
    // complete against a leftover match from the previous keystroke.
    if (!this.dirCache.has(dirPath)) {
      this.mentionResults = [];
      this.showMentions = false;
      try {
        const resp = await repoClient.listTree({ repoId: this.repoId, path: dirPath });
        const prefix = dirPath ? dirPath + "/" : "";
        this.dirCache.set(
          dirPath,
          resp.entries.map((e) => prefix + e.name + (e.type === EntryType.DIR ? "/" : "")),
        );
      } catch {
        this.dirCache.set(dirPath, []);
      }
      // A newer keystroke may have replaced us while we were awaiting —
      // drop this resolution so we don't flash stale matches against
      // the user's current query.
      if (seq !== this.checkMentionSeq) return;
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

  /** Public method to insert a file mention at the current cursor position */
  insertFileMention(path: string) {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = this.input.slice(0, pos);
    const after = this.input.slice(pos);
    // Check if there's an @ trigger already, otherwise insert fresh
    const atIdx = before.lastIndexOf("@");
    if (atIdx >= 0 && !before.slice(atIdx).includes(" ")) {
      this.input = before.slice(0, atIdx) + "@" + path + " " + after;
      requestAnimationFrame(() => {
        ta.focus();
        const newPos = atIdx + path.length + 2;
        ta.setSelectionRange(newPos, newPos);
      });
    } else {
      this.input = before + " @" + path + " " + after;
      requestAnimationFrame(() => {
        ta.focus();
        const newPos = pos + path.length + 3;
        ta.setSelectionRange(newPos, newPos);
      });
    }
  }

  private async addFiles(files: FileList | File[] | null | undefined) {
    if (!files || files.length === 0) return;
    const existing = this.pendingAttachments;
    const additions: ClientAttachment[] = [];
    const rejections: string[] = [];
    let runningTotal = existing.reduce((n, a) => n + a.size, 0);
    for (const f of Array.from(files)) {
      if (existing.length + additions.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        rejections.push(`max ${MAX_ATTACHMENTS_PER_MESSAGE} attachments reached`);
        break;
      }
      if (!ALLOWED_ATTACHMENT_MIMES.has(f.type)) {
        rejections.push(`${f.name}: unsupported type ${f.type || "unknown"}`);
        continue;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        rejections.push(
          `${f.name}: too large (${fmtBytes(f.size)} > ${fmtBytes(MAX_ATTACHMENT_BYTES)})`,
        );
        continue;
      }
      if (runningTotal + f.size > MAX_ATTACHMENTS_TOTAL_BYTES) {
        rejections.push(`${f.name}: would exceed total size cap`);
        continue;
      }
      try {
        const att = await readFileToAttachment(f);
        additions.push(att);
        runningTotal += att.size;
      } catch (e) {
        rejections.push(`${f.name}: ${messageOf(e)}`);
      }
    }
    if (additions.length > 0) {
      this.pendingAttachments = [...existing, ...additions];
      this.announce(`${additions.length} attachment${additions.length === 1 ? "" : "s"} added`);
    }
    if (rejections.length > 0) {
      this.error = rejections.join("; ");
    }
  }

  private removeAttachment(index: number) {
    const next = this.pendingAttachments.slice();
    next.splice(index, 1);
    this.pendingAttachments = next;
  }

  private async onPickFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    await this.addFiles(input.files);
    input.value = ""; // allow re-picking the same file
  }

  private async onPasteAttach(e: ClipboardEvent) {
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      e.preventDefault();
      await this.addFiles(items);
    }
  }

  private onDragEnter(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    this.dragDepth++;
    this.dragActive = true;
  }

  private onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
  }

  private onDragLeave(e: DragEvent) {
    e.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragActive = false;
  }

  private async onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragDepth = 0;
    this.dragActive = false;
    await this.addFiles(e.dataTransfer?.files);
  }

  private insertMention(path: string) {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = this.input.slice(0, pos);
    const after = this.input.slice(pos);
    const atIdx = before.lastIndexOf("@");
    // Directories end in `/` in the candidate list. Leave them open
    // for further narrowing — appending a space would break the
    // autocomplete regex and force the user to backspace before they
    // could keep drilling in. File picks get the trailing space so
    // typing the rest of the sentence feels natural.
    const isDirectory = path.endsWith("/");
    const suffix = isDirectory ? "" : " ";
    this.input = before.slice(0, atIdx) + "@" + path + suffix + after;
    if (isDirectory) {
      // Keep the dropdown open — we're about to refetch for the new
      // dir prefix on the next checkMention tick.
      requestAnimationFrame(() => {
        ta.focus();
        const newPos = atIdx + path.length + 1;
        ta.setSelectionRange(newPos, newPos);
        void this.checkMention();
      });
      return;
    }
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
        this.mentionIdx =
          this.mentionIdx <= 0 ? this.mentionResults.length - 1 : this.mentionIdx - 1;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // Fall back to the first candidate when nothing is arrow-
        // selected — matches how every other autocomplete UI behaves
        // and stops Enter from leaking through to the submit handler
        // below with "@partial" in the buffer.
        e.preventDefault();
        const idx = this.mentionIdx >= 0 ? this.mentionIdx : 0;
        this.insertMention(this.mentionResults[idx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.showMentions = false;
        return;
      }
    }
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void this.send();
    }
  }

  private async send(opts: { text?: string; replaceFromMessageId?: string } = {}) {
    // Default to the composer input. opts.text overrides it for
    // regenerate / edit paths where the source isn't the textarea.
    const text = (opts.text ?? this.input).trim();
    // Attachments only flow from the composer path — regenerate / edit
    // replay an existing user turn whose attachments, if any, are
    // already on the server. Day-one regenerate doesn't re-upload.
    const composerPath = opts.text === undefined;
    const attachments = composerPath ? this.pendingAttachments : [];
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
    // Sending a message is an explicit "show me the response" — re-
    // pin to bottom regardless of whether the user had scrolled up.
    this.scrollPinnedToBottom = true;
    this.scrollToBottom();
    // Only clear the composer if this send was driven by it. Regen /
    // edit paths pass opts.text directly and shouldn't wipe a draft
    // the user has typed while reading the previous response.
    if (composerPath) {
      this.input = "";
      this.pendingAttachments = [];
    }
    this.sending = true;
    this.error = "";
    this.announce("Sending message");
    // Reset textarea height after clearing input.
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (ta && opts.text === undefined) ta.style.height = "auto";

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
          // Server just persisted the user turn; adopt its canonical
          // ID so retry-after-error can target it via
          // replace_from_message_id. Also surface a newly-created
          // session ID so the next retry in this call's lifetime
          // skips the create-session branch.
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
            void chatClient
              .listSessions({ repoId: this.repoId })
              .then((list) => {
                if (this.state.phase === "ready") {
                  this.state = { ...this.state, sessions: list.sessions };
                }
              })
              .catch(() => {});
          }
          this.turns = [...this.turns];
        } else if (chunk.kind.case === "token") {
          assistantTurn.content += chunk.kind.value;
          this.turns = [...this.turns]; // trigger re-render
          this.scrollToBottom();
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
          this.scrollToBottom();
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
            .then(({ renderMarkdown }) => renderMarkdown(assistantTurn.content, diffResolver))
            .then((htmlStr) => {
              assistantTurn.html = htmlStr;
              this.turns = [...this.turns];
            });
        } else if (chunk.kind.case === "done") {
          assistantTurn.streaming = false;
          assistantTurn.id = chunk.kind.value.assistantMessageId;
          assistantTurn.model = chunk.kind.value.model;
          // Capture token counts from the Done payload.
          const tIn = Number(chunk.kind.value.tokenCountIn) || 0;
          const tOut = Number(chunk.kind.value.tokenCountOut) || 0;
          assistantTurn.tokensIn = tIn;
          assistantTurn.tokensOut = tOut;
          this.sessionTokensIn += tIn;
          this.sessionTokensOut += tOut;
          if (chunk.kind.value.error) {
            this.error = chunk.kind.value.error;
            // Attach the error to the turn itself so the retry button
            // has something to latch onto, and falls back to showing
            // the error inline when the turn had no partial content.
            assistantTurn.error = chunk.kind.value.error;
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
            .then(({ renderMarkdown }) => renderMarkdown(assistantTurn.content, diffResolver))
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
            this._lastRestoredSession = newId;
            this.dispatchNav({ sessionId: newId });
          }
          this.turns = [...this.turns];
        }
      }
    } catch (e) {
      this.error = messageOf(e);
      assistantTurn.streaming = false;
      assistantTurn.error = this.error;
      // Surface the error on the turn body too if no partial tokens
      // arrived — otherwise the bubble is empty and the only signal
      // is the status bar.
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

  private scrollToBottom() {
    // Respect a user who has scrolled up to read earlier content. If
    // they're not near the bottom, don't yank them back on every
    // incoming token — extremely annoying during long streams. Once
    // they scroll back to the bottom, scrollPinnedToBottom flips
    // back to true and autoscroll resumes.
    if (!this.scrollPinnedToBottom) return;
    requestAnimationFrame(() => {
      const pane = this.renderRoot.querySelector(".messages");
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  }

  // True when the messages pane is scrolled within 64px of its bottom.
  // Updated on the pane's scroll event; used as a gate for
  // scrollToBottom so we don't yank the viewport back during a
  // long stream that the user has scrolled up to re-read.
  private scrollPinnedToBottom = true;
  private onMessagesScroll = (e: Event) => {
    const pane = e.currentTarget as HTMLElement;
    const nearBottomPx = 64;
    this.scrollPinnedToBottom =
      pane.scrollHeight - pane.scrollTop - pane.clientHeight <= nearBottomPx;
  };

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
      return html`<gc-loading-banner heading="loading chat…"></gc-loading-banner>`;
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
      <div
        class="layout ${this.focused ? "focused" : ""} ${this.drawerOpen ? "drawer-open" : ""}"
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
          <button
            class="new"
            @click=${() => this.newChat()}
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
            ${s.sessions.length === 0
              ? html`<li class="sidebar-empty">no sessions yet</li>`
              : s.sessions
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
                              void this.deleteSession(sess.id);
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
          <div
            class="messages"
            role="log"
            aria-live="polite"
            aria-label="Chat messages"
            @click=${this.onMessagesClick}
            @scroll=${this.onMessagesScroll}
          >
            <div class="messages-inner">
              ${this.turns.length === 0
                ? this.renderEmptyState()
                : this.turns.map((t) => this.renderTurn(t))}
            </div>
          </div>

          <form
            class="composer ${this.dragActive ? "drag-active" : ""}"
            role="search"
            aria-label="Chat composer"
            @submit=${(e: Event) => {
              e.preventDefault();
              void this.send();
            }}
            @dragenter=${this.onDragEnter}
            @dragover=${this.onDragOver}
            @dragleave=${this.onDragLeave}
            @drop=${this.onDrop}
          >
            <div class="composer-inner">
              ${this.pendingAttachments.length > 0
                ? html`<div class="attachment-strip" role="list">
                    ${this.pendingAttachments.map((a, i) => this.renderAttachmentChip(a, i, true))}
                  </div>`
                : nothing}
              <textarea
                .value=${this.input}
                @input=${this.onInput}
                @keydown=${this.onKeydown}
                @paste=${this.onPasteAttach}
                placeholder="ask about the repo — use @path/to/file to pin content"
                ?disabled=${this.sending}
                rows="1"
                aria-label="Message input — type @ for file autocomplete, Enter to send, drop files to attach"
                aria-describedby="composer-status"
                aria-autocomplete="list"
                aria-expanded=${this.showMentions ? "true" : "false"}
              ></textarea>
              ${this.showMentions
                ? html`<ul class="mention-list" role="listbox">
                    ${this.mentionResults.map(
                      (p, i) => html`<li
                        role="option"
                        aria-selected=${i === this.mentionIdx ? "true" : "false"}
                      >
                        <button
                          class="mention-item ${i === this.mentionIdx ? "active" : ""}"
                          @click=${() => this.insertMention(p)}
                        >
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
                      : html`<span class="dim"
                          >↵ send · shift+↵ newline · drag or paste to attach</span
                        >`}
                </span>
                <input
                  type="file"
                  class="attach-input"
                  multiple
                  accept="image/png,image/jpeg,image/gif,image/webp,text/plain"
                  @change=${(e: Event) => void this.onPickFiles(e)}
                  aria-hidden="true"
                  tabindex="-1"
                />
                <button
                  type="button"
                  class="attach-btn"
                  aria-label="Attach file"
                  title="Attach file"
                  ?disabled=${this.sending ||
                  this.pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                  @click=${() => {
                    const el = this.renderRoot.querySelector<HTMLInputElement>(".attach-input");
                    el?.click();
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M10.5 6.5 6 11a2.5 2.5 0 0 1-3.54-3.54L7.5 2.5a1.75 1.75 0 0 1 2.47 2.47L5.5 9.44"
                    />
                  </svg>
                </button>
                ${this.sending
                  ? html`<button
                      type="button"
                      class="stop"
                      aria-label="Stop generating"
                      @click=${() => this.stop()}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                        <rect x="2" y="2" width="10" height="10" rx="1.5" />
                      </svg>
                      stop
                    </button>`
                  : html`<button
                      type="submit"
                      aria-label="Send message"
                      class="send"
                      ?disabled=${!this.input.trim() && this.pendingAttachments.length === 0}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M8 12V4M4 7l4-4 4 4" />
                      </svg>
                    </button>`}
              </div>
            </div>
          </form>
        </section>
        <div class="sr-only" role="status" aria-live="assertive">${this.announcement}</div>
      </div>
    `;
  }

  private renderEmptyState() {
    return html`
      <div class="empty-chat">
        <div class="empty-title">ready when you are</div>
        <p class="empty-sub">
          ask about the repo — use <code>@path/to/file</code> to include file contents
        </p>

        ${this.suggestions.length > 0
          ? html`
              <div class="empty-examples">
                ${this.suggestions.map(
                  (s) => html`
                    <button class="example" @click=${() => this.prefillExample(s.prompt)}>
                      <span class="example-head">${s.label}</span>
                      <span class="example-body">${s.prompt.split("\n")[0].slice(0, 80)}</span>
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}

        <div class="recent-activity">
          <div class="recent-title">recent activity</div>
          ${this.summaryLoading
            ? html`<p class="activity-text loading">
                <gc-spinner></gc-spinner>
                summarizing recent changes…
              </p>`
            : this.activitySummary
              ? html`<p class="activity-text">${this.activitySummary}</p>`
              : nothing}
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
    this.turns = this.turns.map((t) =>
      t.id === id ? { ...t, thinkingExpanded: !t.thinkingExpanded } : t,
    );
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
    this.turns = this.turns.map((t) =>
      t.tools
        ? {
            ...t,
            tools: t.tools.map((ev) => (ev.id === id ? { ...ev, expanded: !ev.expanded } : ev)),
          }
        : t,
    );
  }

  private renderAttachmentChip(a: ClientAttachment, index: number, removable: boolean) {
    const isImage = a.mimeType.startsWith("image/") && a.url;
    const tooltip = `${a.filename} · ${fmtBytes(a.size)}`;
    const remove = removable
      ? html`<button
          type="button"
          class="attachment-remove"
          aria-label="Remove ${a.filename}"
          title="Remove"
          @click=${() => this.removeAttachment(index)}
        >
          ×
        </button>`
      : nothing;
    if (isImage) {
      return html`<div class="attachment-chip is-image" role="listitem" title=${tooltip}>
        <img src=${a.url!} alt=${a.filename} class="attachment-thumb" />
        ${remove}
      </div>`;
    }
    return html`<div class="attachment-chip is-file" role="listitem" title=${tooltip}>
      <span class="attachment-glyph" aria-hidden="true">📄</span>
      <span class="attachment-meta">
        <span class="attachment-name">${a.filename}</span>
        <span class="attachment-size">${fmtBytes(a.size)}</span>
      </span>
      ${remove}
    </div>`;
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
        : html`<div class="body">
            ${t.content}${t.streaming ? html`<span class="cursor">▍</span>` : nothing}
          </div>`;
    // Assistant turns are rendered as flowing prose with a tiny label
    // above. User turns get a muted left-border block — enough visual
    // weight to separate them from assistant prose without hijacking
    // attention. Neither side uses the chat-bubble pattern.
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
                ${t.attachments.map((a, i) => this.renderAttachmentChip(a, i, false))}
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
    // Token info: show "streaming..." while live, final counts once done.
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
    // Retry appears on the last assistant turn that errored, even if
    // editablePair rejects the pair (happens when the stream died
    // before Started so assistant has a local-id). Retry uses the
    // preceding user turn's id — which Started gives us even on
    // catch-path failures.
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
                    @click=${() => this.retryLast()}
                    aria-label="Retry"
                    title="Retry"
                  >
                    retry
                  </button>`
                : nothing}
              ${isRegeneratable
                ? html`<button
                    class="turn-action"
                    @click=${() => this.regenerateLast()}
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

  // Retry after a mid-stream failure. Same shape as regenerate: drop
  // the failed pair from the client view and re-run send with the
  // preceding user text + replaceFromMessageId, so the server
  // truncates the errored rows before appending a fresh attempt.
  private retryLast() {
    const last = this.turns.length - 1;
    if (last < 1) return;
    const assistant = this.turns[last];
    const user = this.turns[last - 1];
    if (!assistant?.error || user?.role !== MessageRole.USER) return;
    // If Started never arrived (network died very early), user.id
    // is still a local stub. Fall back to a plain re-send without
    // truncation — user gets a duplicate pair but at least recovers.
    const replaceId = user.id.startsWith("local-") ? "" : user.id;
    this.turns = this.turns.slice(0, last - 1);
    void this.send({ text: user.content, replaceFromMessageId: replaceId });
  }

  // Inline edit view for a user turn. Enter commits, Esc cancels,
  // Shift+Enter inserts a newline (same conventions as the main
  // composer). The textarea autosizes — simplest approach is to
  // set rows based on the initial content line count and let the
  // browser's default auto-wrap do the rest.
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
            // Live-resize so the textarea grows with content.
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

  // Per-turn copy: full text goes to the clipboard regardless of
  // whether the turn has been promoted to rendered markdown — we
  // copy the raw source so snippets paste back into an editor as
  // the user wrote them, not as the rendered HTML.
  private copyTurn(e: Event, t: Turn) {
    e.stopPropagation();
    void copyText(e.currentTarget as HTMLElement, t.content, "Message copied");
  }

  // Index into this.turns where edit / regenerate are actually
  // applicable: the last assistant turn (regenerate) and its
  // preceding user turn (edit). Gated on:
  //   - nothing is streaming
  //   - the assistant turn has a non-local id (server-assigned, so
  //     it's safe to reference in replace_from_message_id)
  //   - the user turn likewise has a real id
  // Returns [-1, -1] when the pair isn't available.
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

  // Regenerate: drop the last user+assistant pair from the client
  // view and re-run generation with the same user text. Server
  // receives replace_from_message_id=<userId>, which truncates that
  // message plus the assistant reply before appending afresh.
  private regenerateLast() {
    const pair = this.editablePair();
    if (!pair) return;
    const user = this.turns[pair.userIdx]!;
    this.turns = this.turns.slice(0, pair.userIdx);
    void this.send({ text: user.content, replaceFromMessageId: user.id });
  }

  // Start editing the last user turn in place. The turn renders a
  // textarea prefilled with its own content; commit swaps in the
  // new text and truncates on the server, cancel restores the view.
  @state() private editingTurnId = "";

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
    // Drop the edited turn and everything after it locally; the
    // server will truncate matching rows when we send.
    this.turns = this.turns.slice(0, idx);
    this.editingTurnId = "";
    void this.send({ text: trimmed, replaceFromMessageId: target.id });
  }

  // Event delegation: the messages container catches clicks on copy
  // buttons embedded inside rendered markdown (see markdown.ts). We
  // find the enclosing .code-block's <pre> and copy its textContent,
  // which Shiki leaves as the unstyled source text.
  private onMessagesClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.classList.contains("copy-code")) return;
    const block = target.closest(".code-block");
    const pre = block?.querySelector("pre");
    const text = pre?.textContent ?? "";
    if (!text) return;
    void copyText(target, text, "Code copied");
  };

  static override styles = css`
    /* ── Scroll chain ─────────────────────────────────────────────────
       The parent <main> in gc-app is a flex item with min-height:0. This
       host element fills it (display:flex + min-height:0), the .layout
       grid fills the host, the .pane section is a flex column with
       min-height:0, and .messages is flex:1 + overflow-y:auto. Every
       link in the chain has min-height:0 — that's what makes the
       messages region clamp and scroll instead of growing forever. */
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
      overflow: hidden;
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
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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
      transition:
        background 0.12s ease,
        border-color 0.12s ease;
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
      font-size: 0.78rem;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* ── Recent activity ──────────────────────────────────────────── */
    .recent-activity {
      margin-top: var(--space-4);
      text-align: left;
    }
    .recent-title {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.4;
      margin-bottom: var(--space-2);
    }
    .activity-text {
      font-size: var(--text-xs);
      line-height: 1.6;
      opacity: 0.6;
      margin: 0;
    }
    .activity-text.loading {
      opacity: 0.35;
      font-style: italic;
    }

    /* ── Turns ───────────────────────────────────────────────────── */
    .turn {
      position: relative;
      margin-bottom: var(--space-7);
    }
    .turn:last-child {
      margin-bottom: var(--space-2);
    }
    /* Hover-only action row, pinned to the turn's top-right corner so
       it lines up with the turn-label row without crowding the prose. */
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
    /* Inline edit for a user turn: the body swaps for a textarea
       that keeps the surrounding turn spacing, plus a small action
       row below it. */
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
    /* Per-code-block copy button. Positioned inside markdown's
       .code-block wrapper; shows on hover like the per-turn copy. */
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

    /* ── Session pin ──────────────────────────────────────────────── */
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

    /* ── Token info ───────────────────────────────────────────────── */
    .token-info {
      margin-top: var(--space-2);
      font-size: var(--text-xs);
      opacity: 0.4;
      letter-spacing: 0.01em;
    }
    .session-tokens {
      font-size: var(--text-xs);
      opacity: 0.4;
      margin-right: auto;
      letter-spacing: 0.01em;
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
      field-sizing: content;
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
    .composer.drag-active .composer-inner {
      border-color: var(--border-accent);
      background: color-mix(in srgb, var(--accent-user) 8%, var(--surface-2));
    }
    .attach-input {
      display: none;
    }
    .attach-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      background: transparent;
      color: var(--text);
      border: none;
      border-radius: 50%;
      cursor: pointer;
      opacity: 0.4;
      flex-shrink: 0;
      margin-left: auto;
      transition:
        opacity 0.12s ease,
        background 0.12s ease;
    }
    .attach-btn:hover:not([disabled]) {
      opacity: 0.85;
      background: var(--surface-3);
    }
    .attach-btn[disabled] {
      opacity: 0.15;
      cursor: not-allowed;
    }
    .attachment-strip,
    .turn-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .turn-attachments {
      margin-top: var(--space-2);
    }
    .turn-warnings {
      margin-top: var(--space-2);
      display: flex;
      flex-direction: column;
      gap: 2px;
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
    .turn-warning {
      font-size: 0.7rem;
      opacity: 0.65;
      color: var(--warning, var(--text));
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
    .attachment-remove {
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 0;
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .attachment-chip.is-image .attachment-remove {
      position: absolute;
      top: 3px;
      right: 3px;
      opacity: 0;
      transition: opacity 0.12s ease;
    }
    .attachment-chip.is-image:hover .attachment-remove,
    .attachment-chip.is-image:focus-within .attachment-remove {
      opacity: 1;
    }
    .attachment-chip.is-file .attachment-remove {
      margin-left: 0.2rem;
      background: transparent;
      color: var(--text);
      opacity: 0.45;
      width: 16px;
      height: 16px;
    }
    .attachment-chip.is-file .attachment-remove:hover {
      opacity: 1;
    }
    .composer-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
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
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      background: var(--accent-user);
      color: var(--surface-0);
      border: none;
      border-radius: 50%;
      cursor: pointer;
      transition: opacity 0.12s ease;
      flex-shrink: 0;
    }
    .send:hover:not(:disabled) {
      opacity: 0.85;
    }
    .send:disabled {
      opacity: 0.25;
      cursor: not-allowed;
    }
    .stop {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.25rem 0.7rem;
      background: var(--surface-3);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: 0.72rem;
      cursor: pointer;
      transition: background 0.12s ease;
      flex-shrink: 0;
    }
    .stop:hover {
      background: var(--surface-4);
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
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
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

function turnFromMessage(m: ChatMessage): Turn {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model || undefined,
    tokensIn: Number(m.tokenCountIn) || undefined,
    tokensOut: Number(m.tokenCountOut) || undefined,
    attachments:
      m.attachments && m.attachments.length > 0
        ? m.attachments.map(attachmentFromProto)
        : undefined,
    tools:
      m.toolEvents && m.toolEvents.length > 0
        ? m.toolEvents.map((e) => ({
            id: e.toolCallId,
            name: e.name,
            argsJson: e.argsJson,
            state: e.isError ? ("error" as const) : ("done" as const),
            content: e.resultContent,
          }))
        : undefined,
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
