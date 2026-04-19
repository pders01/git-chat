import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { chatClient, repoClient } from "../lib/transport.js";
import { readFocus, writeFocus } from "../lib/focus.js";
import {
  isProviderAvailable,
  isLocalhostURL,
  hostOf,
  findModelPricing,
  estimateTokensFromChars,
  estimateCostUsd,
} from "../lib/catalog.js";
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

// Route metadata for pre-send consent + cost estimation. Computed from
// live config/profiles/catalog on each send; gated by isLocal so local
// endpoints skip confirmation altogether.
interface RouteInfo {
  model: string;
  baseUrl: string;
  backend: string;
  profileId: string;
  profileName: string;
  destinationHost: string;
  isLocal: boolean;
  isFree: boolean;
}

function routeKey(r: RouteInfo): string {
  return `${r.backend}::${r.baseUrl}::${r.model}::${r.profileId}`;
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
  // Cumulative USD spend for the current session. Updated on each
  // turn's done event from the reported token counts × active pricing.
  // Resets on new-session. Used by the pre-send cap check.
  @state() private sessionCostUsd = 0;
  @state() private sessionMaxCostUsd = 1.0;

  // Active-model indicator. Shown above the composer as a persistent
  // reminder of what the next turn will hit. Refreshed on mount and
  // after every slash-action (/model, /profile).
  @state() private activeModel = "";
  @state() private activeProfileName = "";
  // Pricing for the active model, used to render a live cost estimate
  // in the indicator as the user types. Null when the model isn't in
  // the catalog or pricing isn't known; indicator falls back to
  // showing tokens only in that case.
  @state() private activeModelPricing: import("../lib/catalog.js").ModelPricing | null = null;
  @state() private activeRouteIsLocal = true;
  @state() private composerTextLength = 0;
  @state() private composerAttachmentBytes = 0;

  // Pre-send confirmation state. Set when the user invokes send() on
  // a remote paid route that hasn't been confirmed yet in this session;
  // rendered as an inline confirmation card above the composer. The
  // consent key caches "this route is OK" so subsequent turns through
  // the same (model, baseUrl, profile) combo skip the prompt — changing
  // any of those re-triggers confirmation.
  @state() private pendingSend: {
    text: string;
    attachments: ClientAttachment[];
    replaceFromMessageId?: string;
    route: RouteInfo;
    inputTokensEstimate: number;
    costEstimateUsd: number;
    overCap: boolean;
  } | null = null;
  private confirmedRouteKey: string | null = null;

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
    void this.loadActiveModel();
    this.addEventListener("keydown", this.onKeydownLocal);
  }

  // Resolve what model/profile the next chat turn will use. Mirrors the
  // settings panel's effectiveLLMStatus: profile.model > LLM_MODEL
  // override > compiled default. Kept intentionally lightweight — two
  // small RPCs, no cache, runs on mount and after slash actions. Fails
  // silently: indicator just stays blank if the server is unreachable.
  private async loadActiveModel() {
    try {
      const [cfg, profs] = await Promise.all([
        repoClient.getConfig({}),
        repoClient.listProfiles({}),
      ]);
      const modelEntry = cfg.entries?.find((e) => e.key === "LLM_MODEL");
      const activeId = profs.activeProfileId ?? "";
      const active = profs.profiles?.find((p) => p.id === activeId);
      this.activeProfileName = active?.name ?? "";
      this.activeModel = active?.model || modelEntry?.value || modelEntry?.defaultValue || "";

      // Load routing + pricing so the indicator can surface the
      // live-cost estimate without further RPCs per keystroke.
      const route = await this.resolveRoute();
      this.activeRouteIsLocal = route.isLocal;
      this.activeModelPricing = this.activeModel
        ? await this.priceFor(this.activeModel)
        : null;

      // Session cost cap — pre-send check compares projected spend
      // against this value. Stored as a float; falls back to the
      // compiled default if the config value is missing or unparseable.
      const capEntry = cfg.entries?.find((e) => e.key === "GITCHAT_SESSION_MAX_COST_USD");
      const capStr = capEntry?.value || capEntry?.defaultValue || "1.00";
      const capVal = parseFloat(capStr);
      if (Number.isFinite(capVal) && capVal > 0) {
        this.sessionMaxCostUsd = capVal;
      }
    } catch {
      // Unreachable backend → leave indicator blank rather than error.
    }
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
    this.sessionCostUsd = 0;
    // Reset consent on new session — a fresh session is a fresh
    // decision point; don't carry confirmation across boundaries.
    this.confirmedRouteKey = null;
  }

  /** Route send() through pre-send consent for remote paid providers.
   * Returns true if the turn was dispatched (caller can clear input),
   * false if we're blocked on confirmation or rejected the send.
   *
   * Consent is cached per-route per-session: once the user confirms
   * sending to (model, baseUrl, profile), subsequent turns through the
   * same combo go straight through. Any config change re-triggers. */
  private async send(
    opts: {
      text?: string;
      attachments?: ClientAttachment[];
      replaceFromMessageId?: string;
    } = {},
  ): Promise<boolean> {
    const text = (opts.text ?? "").trim();
    const attachments = opts.attachments ?? [];
    if (!text && attachments.length === 0) return false;
    if (this.sending || this.state.phase !== "ready") return false;

    const route = await this.resolveRoute();
    if (!route.isLocal) {
      const tokens = estimateTokensFromChars(
        text.length + attachments.reduce((n, a) => n + a.size, 0),
      );
      const pricing = await this.priceFor(route.model);
      const turnCost = estimateCostUsd(tokens, tokens, pricing);
      const overCap = this.sessionCostUsd + turnCost > this.sessionMaxCostUsd;
      const routeUnconfirmed = routeKey(route) !== this.confirmedRouteKey;

      // Force confirmation on either a new route OR when crossing the
      // session cap. Over-cap confirmation is NOT cached — every
      // subsequent over-cap turn re-prompts, because budget overruns
      // deserve per-turn consent, not session-wide pre-approval.
      if (routeUnconfirmed || overCap) {
        this.pendingSend = {
          text,
          attachments,
          replaceFromMessageId: opts.replaceFromMessageId,
          route,
          inputTokensEstimate: tokens,
          // Assume parity output for the estimate — most chat turns come
          // back within 0.5–2× the input. The real number will be known
          // after the turn; this one is just to prevent sticker shock.
          costEstimateUsd: turnCost,
          overCap,
        };
        return false;
      }
    }

    void this.doSend({ text, attachments, replaceFromMessageId: opts.replaceFromMessageId });
    return true;
  }

  /** The actual streaming send. Split from send() so the confirmation
   * path can bypass the route check on user approval without re-running
   * the (model, baseUrl, profile) resolution. */
  private async doSend(opts: {
    text: string;
    attachments: ClientAttachment[];
    replaceFromMessageId?: string;
  }): Promise<void> {
    const text = opts.text;
    const attachments = opts.attachments;
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
          // Accrue session USD spend — used by the pre-send cap check
          // before the next turn. Uses current activeModelPricing
          // (loaded during loadActiveModel); cost stays 0 for unknown
          // pricing, which errs on the side of "don't spuriously hit
          // the cap" for local or unpriced models.
          this.sessionCostUsd += estimateCostUsd(tIn, tOut, this.activeModelPricing);
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

  /** Resolve the (model, baseUrl, profile) the next turn will hit.
   * Profile-active routes take precedence; otherwise we use the raw
   * LLM_* overrides. Anthropic backend is marked non-local since the
   * protocol URL is hardcoded and remote. */
  private async resolveRoute(): Promise<RouteInfo> {
    try {
      const [cfg, profs] = await Promise.all([
        repoClient.getConfig({}),
        repoClient.listProfiles({}),
      ]);
      const readConfig = (key: string) =>
        cfg.entries?.find((e) => e.key === key)?.value ?? "";

      const activeId = profs.activeProfileId ?? "";
      const active = profs.profiles?.find((p) => p.id === activeId);

      const backend = active?.backend || readConfig("LLM_BACKEND") || "openai";
      const baseUrl = active?.baseUrl || readConfig("LLM_BASE_URL") || "";
      const model =
        active?.model ||
        readConfig("LLM_MODEL") ||
        (cfg.entries?.find((e) => e.key === "LLM_MODEL")?.defaultValue ?? "");

      const isLocal = backend !== "anthropic" && !!baseUrl && isLocalhostURL(baseUrl);
      const destinationHost =
        backend === "anthropic" ? "api.anthropic.com" : hostOf(baseUrl) || "(unset)";

      return {
        model,
        baseUrl,
        backend,
        profileId: active?.id ?? "",
        profileName: active?.name ?? "",
        destinationHost,
        isLocal,
        isFree: false, // filled in by price lookup
      };
    } catch {
      return {
        model: "",
        baseUrl: "",
        backend: "openai",
        profileId: "",
        profileName: "",
        destinationHost: "(unknown)",
        isLocal: false,
        isFree: false,
      };
    }
  }

  /** Pricing lookup for a model id via the catalog. Catalog fetch is
   * cheap and cached server-side, so we just call it each time rather
   * than wiring a per-component cache. Returns null when the model
   * isn't listed — cost displays as "?" in that case. */
  private async priceFor(modelId: string) {
    if (!modelId) return null;
    try {
      const cat = await repoClient.getProviderCatalog({});
      return findModelPricing(modelId, cat.providers ?? []);
    } catch {
      return null;
    }
  }

  private confirmPendingSend() {
    if (!this.pendingSend) return;
    // Route consent is session-wide, but only cache it when we're NOT
    // over-cap. Over-cap confirmations are per-turn: every turn that
    // would push session spend above the cap prompts again.
    if (!this.pendingSend.overCap) {
      this.confirmedRouteKey = routeKey(this.pendingSend.route);
    }
    const { text, attachments, replaceFromMessageId } = this.pendingSend;
    this.pendingSend = null;
    void this.doSend({ text, attachments, replaceFromMessageId });
    this.getComposer()?.clearAfterSend();
  }

  private cancelPendingSend() {
    // Leave the composer populated — user may want to tweak before
    // resending. Only the confirmation state resets.
    this.pendingSend = null;
  }

  /** Live estimate under the model indicator. Only renders on non-local
   * routes — local models don't cost money and don't need a cost nag.
   * Shows nothing until the composer has any content, so an empty
   * composer on a remote route stays clean. */
  private renderCostEstimate() {
    if (this.activeRouteIsLocal) return nothing;
    const bytes = this.composerTextLength + this.composerAttachmentBytes;
    if (bytes === 0) return nothing;
    const tokens = estimateTokensFromChars(bytes);
    const cost = estimateCostUsd(tokens, tokens, this.activeModelPricing);
    const costStr =
      cost === 0
        ? this.activeModelPricing
          ? "free"
          : "?"
        : cost < 0.001
          ? "<$0.001"
          : `~$${cost.toFixed(3)}`;
    return html`<span class="model-indicator-sep">·</span>
      <span
        class="model-indicator-estimate"
        title="Rough estimate: input tokens are chars/4; output assumed equal. Real cost comes back with the turn."
      >
        ≈${tokens.toLocaleString()}t · ${costStr}
      </span>`;
  }

  private renderPendingConfirmation() {
    if (!this.pendingSend) return nothing;
    const p = this.pendingSend;
    const costStr =
      p.costEstimateUsd > 0
        ? `~$${p.costEstimateUsd.toFixed(3)}`
        : "pricing unknown — check catalog";
    const routeLine = p.route.profileName
      ? `${p.route.destinationHost} · profile: ${p.route.profileName}`
      : p.route.destinationHost;
    const projectedTotal = this.sessionCostUsd + p.costEstimateUsd;
    const title = p.overCap ? "Session budget cap reached" : "Confirm remote call";
    return html`
      <div
        class="presend-confirm ${p.overCap ? "over-cap" : ""}"
        role="alertdialog"
        aria-labelledby="presend-title"
      >
        <div class="presend-head">
          <span class="presend-icon" aria-hidden="true">${p.overCap ? "🛑" : "⚠"}</span>
          <strong id="presend-title">${title}</strong>
        </div>
        <dl class="presend-meta">
          <dt>destination</dt>
          <dd>${routeLine}</dd>
          <dt>model</dt>
          <dd>${p.route.model || "(unset)"}</dd>
          <dt>input</dt>
          <dd>≈ ${p.inputTokensEstimate.toLocaleString()} tokens</dd>
          <dt>turn cost</dt>
          <dd>${costStr}</dd>
          ${this.sessionCostUsd > 0 || p.overCap
            ? html`<dt>session so far</dt>
                <dd>$${this.sessionCostUsd.toFixed(3)} of $${this.sessionMaxCostUsd.toFixed(2)} cap</dd>
                <dt>projected total</dt>
                <dd
                  class=${p.overCap ? "over-cap-value" : ""}
                >
                  $${projectedTotal.toFixed(3)}
                </dd>`
            : nothing}
        </dl>
        <p class="presend-note">
          ${p.overCap
            ? html`This turn would push session spend past the
                <code>GITCHAT_SESSION_MAX_COST_USD</code> cap. Confirming
                proceeds with this turn; the next over-cap turn will prompt
                again. Raise the cap in settings if you want to turn the
                prompts off.`
            : html`Your API key + this prompt will be sent to
                <code>${p.route.destinationHost}</code>. Confirming remembers
                the route for this session — subsequent turns on the same
                route don't re-prompt until the model, base URL, or profile
                changes.`}
        </p>
        <div class="presend-actions">
          <button
            type="button"
            class="presend-btn cancel"
            @click=${() => this.cancelPendingSend()}
          >
            cancel
          </button>
          <button
            type="button"
            class="presend-btn confirm"
            @click=${() => this.confirmPendingSend()}
          >
            send
          </button>
        </div>
      </div>
    `;
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
  private onComposerSend = async (
    e: CustomEvent<{ text: string; attachments: ClientAttachment[] }>,
  ) => {
    const dispatched = await this.send({
      text: e.detail.text,
      attachments: e.detail.attachments,
    });
    // Only clear the composer if the turn actually went out. If we're
    // blocked on pre-send confirmation, keep the input so the user can
    // tweak it after cancelling without retyping.
    if (dispatched) this.getComposer()?.clearAfterSend();
  };

  private onComposerStop = () => this.stop();

  private onComposerError = (e: CustomEvent<{ message: string }>) => {
    this.error = e.detail.message;
  };

  private onComposerAnnounce = (e: CustomEvent<{ message: string }>) => {
    this.announce(e.detail.message);
  };

  private onComposerInputChanged = (
    e: CustomEvent<{ textLength: number; attachmentBytes: number }>,
  ) => {
    this.composerTextLength = e.detail.textLength;
    this.composerAttachmentBytes = e.detail.attachmentBytes;
  };

  // Slash-action dispatch. Composer parses /model, /profile etc. and
  // fires this event; we handle the RPC and surface success/failure
  // through the toast system. Keeping the RPC out of the composer
  // means new actions can be added by editing chat-view alone.
  private onComposerSlashAction = async (e: CustomEvent<{ command: string; args: string[] }>) => {
    const { command, args } = e.detail;
    try {
      if (command === "model") {
        const modelId = args[0] ?? "";
        if (!modelId) {
          this.toast("warn", "usage: /model <model-id>");
          return;
        }
        // Validate before committing. Setting LLM_MODEL to an ID that
        // isn't callable on the current backend leaves the config in
        // a broken state where every subsequent turn 404s — or worse,
        // accidentally sends a request under a misconfigured route.
        // `/profile` already validates (line below) via listProfiles;
        // `/model` needs to check catalog + local + routing context.
        const availability = await this.checkModelAvailability(modelId);
        if (!availability.ok) {
          this.toast("warn", availability.reason);
          return;
        }
        await repoClient.updateConfig({ key: "LLM_MODEL", value: modelId });
        this.toast("success", `model set to ${modelId}`);
      } else if (command === "profile") {
        const name = args[0] ?? "";
        if (!name) {
          this.toast("warn", "usage: /profile <name>");
          return;
        }
        const resp = await repoClient.listProfiles({});
        const match = resp.profiles?.find((p) => p.name === name);
        if (!match) {
          this.toast("warn", `no profile named "${name}" — check spelling`);
          return;
        }
        await repoClient.activateProfile({ id: match.id });
        this.toast("success", `profile "${name}" activated`);
      } else {
        this.toast("warn", `unknown slash command: /${command}`);
      }
      // Refresh the persistent model indicator so the chip under the
      // composer reflects the change the user just made.
      void this.loadActiveModel();
    } catch (err) {
      this.toast("error", err instanceof Error ? err.message : String(err));
    }
  };

  private toast(kind: "info" | "success" | "warn" | "error", message: string) {
    this.dispatchEvent(
      new CustomEvent("gc:toast", { bubbles: true, composed: true, detail: { kind, message } }),
    );
  }

  /** Verify that a model ID is callable under the current config.
   * Returns {ok:true} if the ID matches either a local endpoint's
   * advertised model list or a model on a catalog provider whose
   * route (base URL or anthropic backend) is actually configured.
   * The message on failure is actionable — tells the user what's
   * wrong and how to fix it, not just "invalid". */
  private async checkModelAvailability(
    modelId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const [catResp, localResp, profilesResp, configResp] = await Promise.all([
        repoClient.getProviderCatalog({}).catch(() => null),
        repoClient.discoverLocalEndpoints({}).catch(() => null),
        repoClient.listProfiles({}).catch(() => null),
        repoClient.getConfig({}).catch(() => null),
      ]);

      // Any local endpoint advertising this model id → always ok
      // (local providers need no auth).
      for (const ep of localResp?.endpoints ?? []) {
        if ((ep.models ?? []).includes(modelId)) return { ok: true };
      }

      const readConfig = (key: string) =>
        (configResp?.entries ?? []).find((e) => e.key === key)?.value ?? "";
      const ctx = {
        localUrls: (localResp?.endpoints ?? [])
          .map((ep) => ep.url ?? "")
          .filter(Boolean),
        profileBaseUrls: (profilesResp?.profiles ?? [])
          .map((p) => p.baseUrl ?? "")
          .filter(Boolean),
        profileBackends: (profilesResp?.profiles ?? [])
          .map((p) => p.backend ?? "")
          .filter(Boolean),
        configBaseUrl: readConfig("LLM_BASE_URL"),
        configBackend: readConfig("LLM_BACKEND") || "openai",
        configHasKey: !!readConfig("LLM_API_KEY"),
      };

      // Find the catalog provider(s) advertising this model id.
      const providers = (catResp?.providers ?? []).filter((prov) =>
        (prov.models ?? []).some((m) => m.id === modelId),
      );
      if (providers.length === 0) {
        return {
          ok: false,
          reason: `"${modelId}" isn't in the catalog — refresh catalog in settings, or type the model ID exactly`,
        };
      }
      const reachable = providers.filter((p) => isProviderAvailable(p, ctx));
      if (reachable.length === 0) {
        const names = providers.map((p) => p.name).join(", ");
        return {
          ok: false,
          reason: `"${modelId}" needs a configured route for ${names}. Add an API key in settings or create a profile.`,
        };
      }
      return { ok: true };
    } catch (err) {
      // On lookup failure, fail closed: better to reject and let the
      // user retry than to commit a config the validator can't vouch
      // for. The error message surfaces the cause.
      return {
        ok: false,
        reason: `could not verify model availability: ${messageOf(err)}`,
      };
    }
  }

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
          ${this.pendingSend ? this.renderPendingConfirmation() : nothing}
          ${this.activeModel
            ? html`<div class="model-indicator" role="status" aria-live="polite">
                <span class="model-indicator-label">model</span>
                <span class="model-indicator-value">${this.activeModel}</span>
                ${this.activeProfileName
                  ? html`<span class="model-indicator-sep">·</span>
                      <span class="model-indicator-profile">${this.activeProfileName}</span>`
                  : nothing}
                ${this.renderCostEstimate()}
              </div>`
            : nothing}
          <gc-composer
            .repoId=${this.repoId}
            .sending=${this.sending}
            .errorMsg=${this.error}
            ?unfocused=${this.focused}
            @gc:send=${this.onComposerSend}
            @gc:stop=${this.onComposerStop}
            @gc:error=${this.onComposerError}
            @gc:announce=${this.onComposerAnnounce}
            @gc:slash-action=${this.onComposerSlashAction}
            @gc:input-changed=${this.onComposerInputChanged}
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
    /* Pre-send confirmation card. Rendered above the composer when the
       user submits a turn that would call a remote paid provider they
       haven't confirmed yet this session. Deliberately prominent —
       we're asking for explicit consent before money leaves the wallet. */
    .presend-confirm {
      max-width: var(--content-max-width);
      margin: 0 auto var(--space-2);
      padding: var(--space-3) var(--space-4);
      background: var(--surface-2);
      border: 1px solid var(--border-accent);
      border-left: 3px solid var(--danger, #e88);
      border-radius: 6px;
      font-size: var(--text-sm);
    }
    .presend-confirm.over-cap {
      border-left-width: 4px;
      background: color-mix(in srgb, var(--danger, #e88) 6%, var(--surface-2));
    }
    .over-cap-value {
      color: var(--danger, #e88);
      font-weight: 600;
    }
    .presend-head {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-2);
    }
    .presend-icon {
      font-size: 1rem;
    }
    .presend-meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      column-gap: var(--space-3);
      row-gap: var(--space-1);
      margin: var(--space-2) 0;
      font-size: var(--text-xs);
    }
    .presend-meta dt {
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.55;
      font-size: 0.65rem;
    }
    .presend-meta dd {
      margin: 0;
      font-family: var(--font-mono, ui-monospace, monospace);
    }
    .presend-note {
      font-size: var(--text-xs);
      opacity: 0.75;
      margin: var(--space-2) 0;
      line-height: 1.5;
    }
    .presend-note code {
      font-family: var(--font-mono, ui-monospace, monospace);
      background: var(--surface-3);
      padding: 0 0.25em;
      border-radius: 3px;
    }
    .presend-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-2);
    }
    .presend-btn {
      padding: var(--space-1) var(--space-4);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
    }
    .presend-btn.confirm {
      background: var(--accent-assistant);
      color: #fff;
      border-color: var(--accent-assistant);
    }
    .presend-btn:hover {
      border-color: var(--border-strong);
    }

    /* Persistent active-model indicator, pinned directly above the
       composer. Kept small and subdued — it's a reminder, not UI chrome.
       Sits inside the same vertical stack as the composer so it doesn't
       overlap messages when scrolled. */
    .model-indicator {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      max-width: var(--content-max-width);
      margin: 0 auto var(--space-1);
      padding: 0 var(--space-7);
      font-size: var(--text-xs);
      opacity: 0.55;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .model-indicator-label {
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 0.6rem;
      opacity: 0.7;
    }
    .model-indicator-value {
      font-family: var(--font-mono, ui-monospace, monospace);
      color: var(--accent-assistant);
    }
    .model-indicator-sep {
      opacity: 0.4;
    }
    .model-indicator-profile {
      font-style: italic;
    }
    .model-indicator-estimate {
      font-family: var(--font-mono, ui-monospace, monospace);
      opacity: 0.85;
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
