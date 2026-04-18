import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { svg } from "lit";
import { repoClient } from "../lib/transport.js";
import type { CommitEntry, ChangedFile } from "../gen/gitchat/v1/repo_pb.js";
import { copyText } from "../lib/clipboard.js";
import { onChange as onSettingsChange } from "../lib/settings.js";
import "./loading-indicator.js";
import "./three-pane-view.js";
import "./commit-log/commit-calendar.js";
import { readFocus } from "../lib/focus.js";
import type { SideFilesState } from "../lib/diff-types.js";

// Lazy-load highlight for diff rendering.
let highlightModule: Promise<typeof import("../lib/highlight.js")> | null = null;
function loadHighlight() {
  if (!highlightModule) highlightModule = import("../lib/highlight.js");
  return highlightModule;
}

type LogState =
  | { phase: "loading" }
  | {
      phase: "ready";
      commits: CommitEntry[];
      hasMore: boolean;
      offset: number;
    }
  | { phase: "error"; message: string };

// DiffPaneState models the right-hand diff area of the log view. It
// replaces the earlier cluster of booleans (diffLoading, diffError,
// diffHtml, rawDiff, parentSha) with a discriminated union so render
// and mutation sites both stay legible under a single switch. Cached
// "all files" diff lives separately (see fullDiff below) since it's a
// plain optimisation, not user-facing state.
type DiffPaneState =
  | { phase: "empty" } // no commit selected yet
  | { phase: "loading" } // fetching the diff for the current selection
  | { phase: "error"; message: string }
  | { phase: "ready"; rawDiff: string; diffHtml: string; parentSha: string };

@customElement("gc-commit-log")
export class GcCommitLog extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) branch = "";
  @property({ type: String }) initialCommitSha = "";
  @property({ type: String }) initialLogFile = "";
  @property({ type: Boolean }) initialSplitView = false;
  @state() private state: LogState = { phase: "loading" };
  @state() private selectedSha = "";
  @state() private drawerOpen = false;
  @state() private focused = readFocus();
  @state() private graphMode = false;
  // "commits" shows the three-pane commit-list + info + diff layout.
  // "calendar" hands the whole pane to gc-commit-calendar for a
  // timeline overview (year heatmap + week grid). Clicking an entry
  // in calendar mode flips back to commits mode with that SHA
  // selected so the diff flow resumes without losing context.
  @state() private viewMode: "commits" | "calendar" = "commits";
  @state() private files: ChangedFile[] = [];
  @state() private selectedFile = ""; // "" = all files
  @state() private commitFilter = "";
  @state() private splitView = false;
  // Three-pane diff view: before | unified diff | after. Only meaningful
  // when a single file is selected; toggle is disabled for the "all
  // files" combined view.
  @state() private threePane = false;
  // Right-hand diff area state. See DiffPaneState above.
  @state() private diff: DiffPaneState = { phase: "empty" };
  // Enrichment data for the 3-pane view (before/after file bodies).
  @state() private sideFiles: SideFilesState = { phase: "idle" };
  @property({ type: String }) filterPath = "";
  // Cached whole-commit diff so switching back to "all files" after
  // looking at a single file is instant. Stays alongside @state as a
  // plain cache — nothing here drives the view directly.
  private fullDiff: { rawDiff: string; diffHtml: string; parentSha: string } | null = null;
  private pendingSha = "";
  private unsubSettings: (() => void) | null = null;
  // Abort signal for the progressive-enhancement rename call fired at
  // the tail of selectCommit. Rapid commit switching cancels the
  // in-flight request so the server's expensive similarity-matrix work
  // doesn't accumulate after the user moved on.
  private renameAbort: AbortController | null = null;

  private onSelectCommit = ((e: CustomEvent<{ sha: string }>) => {
    if (this.state.phase === "ready") {
      void this.selectCommit(e.detail.sha);
    } else {
      this.pendingSha = e.detail.sha;
    }
  }) as EventListener;

  private onSetFilterPath = ((e: CustomEvent<{ path: string }>) => {
    this.filterPath = e.detail.path;
  }) as EventListener;

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("gc:select-commit", this.onSelectCommit);
    this.addEventListener("gc:set-filter-path", this.onSetFilterPath);
    this.addEventListener("gc:toggle-focus", this.onSyncFocus);
    this.unsubSettings = onSettingsChange(() => void this.rehighlight());
    if (this.repoId) void this.load(0);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("gc:select-commit", this.onSelectCommit);
    this.removeEventListener("gc:set-filter-path", this.onSetFilterPath);
    this.removeEventListener("gc:toggle-focus", this.onSyncFocus);
    this.unsubSettings?.();
    this.unsubSettings = null;
    this.renameAbort?.abort();
    this.renameAbort = null;
  }

  private onSyncFocus = () => {
    this.focused = readFocus();
  };

  private toggleDrawer() {
    this.drawerOpen = !this.drawerOpen;
    if (this.drawerOpen) {
      void this.updateComplete.then(() => {
        const target =
          this.renderRoot.querySelector<HTMLElement>(".commit-filter-input") ??
          this.renderRoot.querySelector<HTMLElement>(".commit-list");
        target?.focus();
      });
    }
  }

  private async rehighlight() {
    if (this.diff.phase !== "ready" || !this.diff.rawDiff) return;
    const raw = this.diff.rawDiff;
    const { highlight } = await loadHighlight();
    let highlighted = await highlight(raw, "diff");
    // Bail if the user navigated away while highlight() was running.
    if (this.diff.phase !== "ready" || this.diff.rawDiff !== raw) return;
    highlighted = this.highlightWordDiffs(highlighted);
    this.diff = { ...this.diff, diffHtml: highlighted };
    // Keep the "all files" cache in step so toggling back later doesn't
    // show a stale-themed render.
    if (this.selectedFile === "" && this.fullDiff) {
      this.fullDiff = { ...this.fullDiff, diffHtml: highlighted };
    }
  }

  private clearFilterPath() {
    this.filterPath = "";
    this.dispatchNav({ filterPath: undefined });
  }

  private _lastRestoredSha = "";

  override updated(changed: Map<string, unknown>) {
    if (
      (changed.has("repoId") || changed.has("branch") || changed.has("filterPath")) &&
      this.repoId
    ) {
      void this.load(0);
    }
    if (
      changed.has("initialCommitSha") &&
      this.initialCommitSha &&
      this.initialCommitSha !== this._lastRestoredSha
    ) {
      this._lastRestoredSha = this.initialCommitSha;
      if (this.state.phase === "ready") {
        void this.selectCommit(this.initialCommitSha);
      } else {
        this.pendingSha = this.initialCommitSha;
      }
    }
    if (changed.has("initialSplitView")) {
      this.splitView = this.initialSplitView;
    }
  }

  private async load(offset: number) {
    try {
      const resp = await repoClient.listCommits({
        repoId: this.repoId,
        ref: this.branch,
        limit: 50,
        offset,
        path: this.filterPath,
      });
      this.state = {
        phase: "ready",
        commits:
          offset > 0 && this.state.phase === "ready"
            ? [...this.state.commits, ...resp.commits]
            : resp.commits,
        hasMore: resp.hasMore,
        offset,
      };
      if (this.pendingSha) {
        const sha = this.pendingSha;
        this.pendingSha = "";
        void this.selectCommit(sha);
      }
    } catch (e) {
      this.state = {
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private openInBrowse(path: string) {
    this.dispatchEvent(
      new CustomEvent("gc:open-file", {
        bubbles: true,
        composed: true,
        detail: { path, tab: "browse" },
      }),
    );
  }

  private askAboutCommit(c: CommitEntry) {
    this.dispatchEvent(
      new CustomEvent("gc:ask-about", {
        bubbles: true,
        composed: true,
        detail: {
          prompt: `Explain commit ${c.shortSha} ("${c.message}"). What does it change and why?\n\n[[diff to=${c.sha}]]`,
          tab: "chat" as const,
        },
      }),
    );
  }

  private onListKeydown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...this.renderRoot.querySelectorAll<HTMLElement>(".commit-row")];
    const current = (this.renderRoot as ShadowRoot).activeElement as HTMLElement | null;
    const idx = current ? rows.indexOf(current) : -1;
    const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
    rows[next]?.focus();
  };

  private async selectCommit(sha: string) {
    // Support prefix matching (e.g. 7-char short SHA from blame).
    if (this.state.phase === "ready" && sha.length < 40) {
      const match = this.state.commits.find((c) => c.sha.startsWith(sha));
      if (match) {
        sha = match.sha;
      } else if (this.state.hasMore) {
        // Commit not in loaded page — resolve via listCommits with ref.
        try {
          const resp = await repoClient.listCommits({
            repoId: this.repoId,
            ref: sha,
            limit: 1,
          });
          if (resp.commits.length > 0) {
            sha = resp.commits[0].sha;
            // Append to loaded commits so it's selectable.
            this.state = {
              ...this.state,
              commits: [...this.state.commits, resp.commits[0]],
            };
          }
        } catch {
          // Can't resolve — proceed with short SHA anyway.
        }
      }
    }
    if (this.selectedSha === sha) {
      // Toggle off.
      this.selectedSha = "";
      this.selectedFile = "";
      this.files = [];
      this.diff = { phase: "empty" };
      this.sideFiles = { phase: "idle" };
      this.fullDiff = null;
      this.threePane = false;
      return;
    }
    const requestedSha = sha;
    // Cancel any in-flight rename-detection request from the previous
    // commit selection. Its result would be stale-guarded anyway, but
    // we want the server to stop the similarity-matrix work, not just
    // drop the answer on the client.
    this.renameAbort?.abort();
    this.renameAbort = null;
    this.selectedSha = sha;
    this.selectedFile = "";
    this.drawerOpen = false;
    this.files = [];
    this.fullDiff = null;
    this.sideFiles = { phase: "idle" };
    this.diff = { phase: "loading" };

    try {
      const resp = await repoClient.getDiff({
        repoId: this.repoId,
        toRef: sha,
      });
      if (this.selectedSha !== requestedSha) return; // stale
      this.files = resp.files;
      const parentSha = resp.fromCommit || "";
      if (resp.empty) {
        const ready = { phase: "ready" as const, rawDiff: "", diffHtml: "", parentSha };
        this.diff = ready;
        this.fullDiff = { rawDiff: "", diffHtml: "", parentSha };
      } else {
        const { highlight } = await loadHighlight();
        let highlighted = await highlight(resp.unifiedDiff, "diff");
        if (this.selectedSha !== requestedSha) return; // stale
        highlighted = this.highlightWordDiffs(highlighted);
        this.diff = {
          phase: "ready",
          rawDiff: resp.unifiedDiff,
          diffHtml: highlighted,
          parentSha,
        };
        this.fullDiff = { rawDiff: resp.unifiedDiff, diffHtml: highlighted, parentSha };
      }
    } catch (e) {
      if (this.selectedSha !== requestedSha) return;
      this.diff = { phase: "error", message: e instanceof Error ? e.message : String(e) };
    }
    this._lastRestoredSha = this.selectedSha;
    this.dispatchNav({ commitSha: this.selectedSha || undefined, logFile: undefined });

    // Progressive enhancement: fire a rename-aware second request once
    // the fast list is rendered. If any renames land we swap this.files,
    // collapsing matching add/delete pairs.
    if (
      this.files.some((f) => f.status === "added") &&
      this.files.some((f) => f.status === "deleted")
    ) {
      void this.detectRenamesBackground(requestedSha);
    }
  }

  private async detectRenamesBackground(requestedSha: string) {
    const ac = new AbortController();
    this.renameAbort = ac;
    try {
      const resp = await repoClient.getDiff(
        {
          repoId: this.repoId,
          toRef: requestedSha,
          detectRenames: true,
        },
        { signal: ac.signal },
      );
      if (this.selectedSha !== requestedSha) return; // stale
      this.files = resp.files;
    } catch {
      // Silent — aborted or failed; fast list is already on screen.
    } finally {
      if (this.renameAbort === ac) this.renameAbort = null;
    }
  }

  private dispatchNav(detail: Record<string, string | boolean | undefined>) {
    this.dispatchEvent(new CustomEvent("gc:nav", { bubbles: true, composed: true, detail }));
  }

  private async selectFile(path: string) {
    if (this.selectedFile === path) return;
    this.selectedFile = path;

    // "All files" — restore cached full diff.
    if (path === "") {
      if (this.fullDiff) {
        this.diff = { phase: "ready", ...this.fullDiff };
      } else {
        this.diff = { phase: "empty" };
      }
      this.sideFiles = { phase: "idle" };
      return;
    }

    const requestedSha = this.selectedSha;
    this.diff = { phase: "loading" };
    this.sideFiles = { phase: "idle" };

    try {
      const resp = await repoClient.getDiff({
        repoId: this.repoId,
        toRef: this.selectedSha,
        path,
      });
      if (this.selectedSha !== requestedSha || this.selectedFile !== path) return;
      const parentSha = resp.fromCommit || "";
      if (resp.empty) {
        this.diff = { phase: "ready", rawDiff: "", diffHtml: "", parentSha };
      } else {
        const { highlight } = await loadHighlight();
        let highlighted = await highlight(resp.unifiedDiff, "diff");
        if (this.selectedSha !== requestedSha || this.selectedFile !== path) return;
        highlighted = this.highlightWordDiffs(highlighted);
        this.diff = {
          phase: "ready",
          rawDiff: resp.unifiedDiff,
          diffHtml: highlighted,
          parentSha,
        };
      }
    } catch (e) {
      if (this.selectedSha !== requestedSha || this.selectedFile !== path) return;
      this.diff = { phase: "error", message: e instanceof Error ? e.message : String(e) };
    }
    this.dispatchNav({ logFile: this.selectedFile || undefined });

    if (this.threePane) void this.loadSideFiles(path, requestedSha);
  }

  // Fetch the full old- and new-file contents for the 3-pane view at
  // the selected commit. Either fetch can legitimately fail (added file
  // has no parent blob; deleted file has no child blob) — swallow and
  // leave the side empty so add/delete commits still render sensibly.
  private async loadSideFiles(path: string, forSha: string) {
    if (!path || !forSha) return;
    if (this.diff.phase !== "ready") return; // nothing to pane against yet
    const parentSha = this.diff.parentSha;
    this.sideFiles = { phase: "loading" };
    const [leftResp, rightResp] = await Promise.all([
      parentSha
        ? repoClient
            .getFile({
              repoId: this.repoId,
              ref: parentSha,
              path,
              maxBytes: BigInt(512 * 1024),
            })
            .catch(() => null)
        : Promise.resolve(null),
      repoClient
        .getFile({
          repoId: this.repoId,
          ref: forSha,
          path,
          maxBytes: BigInt(512 * 1024),
        })
        .catch(() => null),
    ]);
    if (this.selectedSha !== forSha || this.selectedFile !== path) return;
    const td = new TextDecoder();
    this.sideFiles = {
      phase: "ready",
      leftText: leftResp && !leftResp.isBinary ? td.decode(leftResp.content) : "",
      rightText: rightResp && !rightResp.isBinary ? td.decode(rightResp.content) : "",
      language: rightResp?.language || leftResp?.language || "plaintext",
    };
  }

  private toggleThreePane() {
    this.threePane = !this.threePane;
    if (this.threePane && this.selectedFile && this.sideFiles.phase === "idle") {
      void this.loadSideFiles(this.selectedFile, this.selectedSha);
    }
  }

  // ── Split diff helpers ──────────────────────────────────────────
  /**
   * Parse unified diff HTML into left/right paired line arrays for
   * side-by-side rendering. Each entry is { left, right } where each
   * side is an HTML string (or empty if the line doesn't exist on that
   * side).
   */
  private splitDiffHtml(unifiedHtml: string): Array<{ left: string; right: string }> {
    const tmp = document.createElement("div");
    tmp.innerHTML = unifiedHtml;
    const code = tmp.querySelector("code");
    if (!code) return [{ left: unifiedHtml, right: "" }];
    const lineEls = code.querySelectorAll(".line");
    const lines =
      lineEls.length > 0
        ? Array.from(lineEls).map((el) => el.innerHTML)
        : code.innerHTML.split("\n");

    const pairs: Array<{ left: string; right: string }> = [];
    const delBuf: string[] = [];
    const addBuf: string[] = [];

    const flushBuffers = () => {
      const max = Math.max(delBuf.length, addBuf.length);
      for (let i = 0; i < max; i++) {
        pairs.push({
          left: delBuf[i] ?? "",
          right: addBuf[i] ?? "",
        });
      }
      delBuf.length = 0;
      addBuf.length = 0;
    };

    for (const lineHtml of lines) {
      // Extract the plain text to determine the line type.
      const tempEl = document.createElement("span");
      tempEl.innerHTML = lineHtml;
      const text = tempEl.textContent ?? "";

      if (text.startsWith("-")) {
        delBuf.push(lineHtml);
      } else if (text.startsWith("+")) {
        addBuf.push(lineHtml);
      } else {
        flushBuffers();
        // Context line or header — show on both sides.
        pairs.push({ left: lineHtml, right: lineHtml });
      }
    }
    flushBuffers();
    return pairs;
  }

  // ── Word-level diff highlighting ──────────────────────────────
  /**
   * Post-process Shiki diff HTML to add <mark> around changed words
   * within adjacent -/+ line pairs.
   */
  private highlightWordDiffs(htmlStr: string): string {
    const tmp = document.createElement("div");
    tmp.innerHTML = htmlStr;
    const code = tmp.querySelector("code");
    if (!code) return htmlStr;
    const lineEls = Array.from(code.querySelectorAll(".line"));
    if (lineEls.length === 0) return htmlStr;

    // Group adjacent -/+ pairs.
    let i = 0;
    while (i < lineEls.length) {
      const el = lineEls[i];
      const text = el.textContent ?? "";
      if (text.startsWith("-")) {
        // Collect consecutive - lines.
        const delStart = i;
        while (i < lineEls.length && (lineEls[i].textContent ?? "").startsWith("-")) i++;
        // Collect consecutive + lines.
        const addStart = i;
        while (i < lineEls.length && (lineEls[i].textContent ?? "").startsWith("+")) i++;
        const delEnd = addStart;
        const addEnd = i;
        // Pair up for word-diff.
        const pairCount = Math.min(delEnd - delStart, addEnd - addStart);
        for (let p = 0; p < pairCount; p++) {
          this.markWordDiffs(lineEls[delStart + p], lineEls[addStart + p]);
        }
      } else {
        i++;
      }
    }
    return tmp.innerHTML;
  }

  /**
   * Compare two line elements word-by-word and wrap differing words in <mark>.
   */
  private markWordDiffs(delEl: Element, addEl: Element) {
    const delText = (delEl.textContent ?? "").slice(1); // strip leading -
    const addText = (addEl.textContent ?? "").slice(1); // strip leading +
    if (delText === addText) return;

    const delWords = delText.split(/(\s+)/);
    const addWords = addText.split(/(\s+)/);

    // LCS to find which words are common between the two lines.
    const lcsSet = (a: string[], b: string[]): { inA: Set<number>; inB: Set<number> } => {
      const m = a.length,
        n = b.length;
      const dp: number[][] = Array.from({ length: m + 1 }, () =>
        Array.from({ length: n + 1 }, () => 0),
      );
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          dp[i][j] =
            a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
      // Backtrack to find matched indices.
      const inA = new Set<number>();
      const inB = new Set<number>();
      let i = m,
        j = n;
      while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) {
          inA.add(i - 1);
          inB.add(j - 1);
          i--;
          j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
          i--;
        } else {
          j--;
        }
      }
      return { inA, inB };
    };

    const { inA: commonDel, inB: commonAdd } = lcsSet(delWords, addWords);
    const delChanged = new Set<number>();
    const addChanged = new Set<number>();
    for (let i = 0; i < delWords.length; i++) if (!commonDel.has(i)) delChanged.add(i);
    for (let i = 0; i < addWords.length; i++) if (!commonAdd.has(i)) addChanged.add(i);

    // Only apply if there's a meaningful diff (not everything changed).
    if (delChanged.size > delWords.length * 0.8 && addChanged.size > addWords.length * 0.8) return;

    // Find character ranges that changed.
    const findChangedRanges = (words: string[], changed: Set<number>): Array<[number, number]> => {
      const ranges: Array<[number, number]> = [];
      let pos = 0;
      for (let i = 0; i < words.length; i++) {
        if (changed.has(i) && words[i].trim()) {
          ranges.push([pos, pos + words[i].length]);
        }
        pos += words[i].length;
      }
      return ranges;
    };

    const wrapTextNodes = (el: Element, ranges: Array<[number, number]>, cssClass: string) => {
      if (ranges.length === 0) return;
      // Walk text nodes, track global offset, wrap ranges in <mark>.
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: Array<{ node: Text; start: number; end: number }> = [];
      let offset = 0;
      while (walker.nextNode()) {
        const t = walker.currentNode as Text;
        nodes.push({ node: t, start: offset, end: offset + t.length });
        offset += t.length;
      }
      // Skip the first character (- or +) by shifting ranges by 1.
      const shifted = ranges.map(([s, e]) => [s + 1, e + 1] as [number, number]);
      // Process ranges right-to-left; within each range, iterate nodes
      // right-to-left so DOM mutations don't affect nodes we haven't
      // visited yet. A single range may span multiple Shiki text nodes
      // (e.g. "console.log" split across tokens).
      for (const [rs, re] of shifted.reverse()) {
        for (let ni = nodes.length - 1; ni >= 0; ni--) {
          const n = nodes[ni];
          if (rs >= n.end || re <= n.start) continue;
          const localStart = Math.max(0, rs - n.start);
          const localEnd = Math.min(n.node.length, re - n.start);
          if (localStart >= localEnd) continue;
          const before = n.node.splitText(localStart);
          before.splitText(localEnd - localStart);
          const mark = document.createElement("mark");
          mark.className = cssClass;
          before.parentNode!.insertBefore(mark, before);
          mark.appendChild(before);
        }
      }
    };

    wrapTextNodes(delEl, findChangedRanges(delWords, delChanged), "word-del");
    wrapTextNodes(addEl, findChangedRanges(addWords, addChanged), "word-add");
  }

  private selectedFileEntry(): ChangedFile | undefined {
    return this.files.find((f) => f.path === this.selectedFile);
  }

  private renderDiffPane() {
    switch (this.diff.phase) {
      case "empty":
        return nothing;
      case "loading":
        return html`<gc-loading-banner
          heading="loading diff…"
          detail="fetching the commit's changes from git; large commits can take a second"
        ></gc-loading-banner>`;
      case "error":
        return html`<p style="color:var(--danger);padding:var(--space-4)">${this.diff.message}</p>`;
      case "ready": {
        if (this.threePane && this.selectedFile) return this.renderThreePane(this.diff);
        if (!this.diff.diffHtml) return html`<div class="diff-empty">no changes</div>`;
        return this.splitView
          ? this.renderSplitDiff()
          : html`<div class="diff-content">${unsafeHTML(this.diff.diffHtml)}</div>`;
      }
    }
  }

  private renderThreePane(ready: DiffPaneState & { phase: "ready" }) {
    switch (this.sideFiles.phase) {
      case "idle":
      case "loading":
        return html`<gc-loading-banner heading="loading 3-pane…"></gc-loading-banner>`;
      case "ready":
        return html`<gc-three-pane-view
          .leftText=${this.sideFiles.leftText}
          .rightText=${this.sideFiles.rightText}
          .rawDiff=${ready.rawDiff}
          .language=${this.sideFiles.language}
          .leftLabel=${ready.parentSha ? ready.parentSha.slice(0, 12) + " (before)" : "(no parent)"}
          .rightLabel=${this.selectedSha.slice(0, 12) + " (after)"}
        ></gc-three-pane-view>`;
    }
  }

  private renderSplitDiff() {
    const diffHtml = this.diff.phase === "ready" ? this.diff.diffHtml : "";
    const pairs = this.splitDiffHtml(diffHtml);
    return html`
      <div class="diff-content split-diff">
        <table class="split-table">
          <colgroup>
            <col class="split-col" />
            <col class="split-col" />
          </colgroup>
          <tbody>
            ${pairs.map(
              ({ left, right }) => html`
                <tr>
                  <td class="split-cell del-cell">${left ? unsafeHTML(left) : nothing}</td>
                  <td class="split-cell add-cell">${right ? unsafeHTML(right) : nothing}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private selectedCommit(): CommitEntry | undefined {
    if (this.state.phase !== "ready" || !this.selectedSha) return undefined;
    return this.state.commits.find(
      (c) => c.sha === this.selectedSha || c.sha.startsWith(this.selectedSha),
    );
  }

  private renderGraph(commits: CommitEntry[]) {
    // Assign each commit to a lane. Simple algorithm:
    // - First commit gets lane 0
    // - If a commit's parent is in a different lane, draw a merge line
    const ROW_H = 32;
    const LANE_W = 16;
    const DOT_R = 4;
    const shaToRow = new Map<string, number>();
    const lanes: string[] = []; // lane[i] = SHA currently "active" in that lane

    interface NodeInfo {
      row: number;
      lane: number;
      parents: string[];
    }
    const nodes: NodeInfo[] = [];

    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      shaToRow.set(c.sha, i);

      // Find lane: reuse lane where this commit was expected, or take a new one
      let lane = lanes.indexOf(c.sha);
      if (lane === -1) {
        lane = lanes.indexOf("");
        if (lane === -1) {
          lane = lanes.length;
          lanes.push("");
        }
      }

      // Assign first parent to this lane (continues the line)
      const parentShas = ((c as any).parentShas as string[]) ?? [];
      if (parentShas.length > 0) {
        lanes[lane] = parentShas[0];
      } else {
        lanes[lane] = "";
      }

      // Additional parents get new lanes
      for (let p = 1; p < parentShas.length; p++) {
        const existing = lanes.indexOf(parentShas[p]);
        if (existing === -1) {
          const free = lanes.indexOf("");
          if (free !== -1) lanes[free] = parentShas[p];
          else lanes.push(parentShas[p]);
        }
      }

      nodes.push({ row: i, lane, parents: parentShas });
    }

    const maxLane = Math.max(0, ...nodes.map((n) => n.lane));
    const svgW = (maxLane + 1) * LANE_W + 8;
    const svgH = commits.length * ROW_H;

    // Build SVG elements using Lit's svg tagged template
    const svgLines: ReturnType<typeof svg>[] = [];
    const svgDots: ReturnType<typeof svg>[] = [];

    for (const node of nodes) {
      const x = node.lane * LANE_W + LANE_W / 2 + 4;
      const y = node.row * ROW_H + ROW_H / 2;

      const isSelected = commits[node.row].sha === this.selectedSha;
      svgDots.push(
        svg`<circle cx=${x} cy=${y} r=${DOT_R} fill=${isSelected ? "var(--accent-user)" : "var(--accent-assistant)"} />`,
      );

      for (const pSha of node.parents) {
        const pRow = shaToRow.get(pSha);
        if (pRow === undefined) {
          svgLines.push(
            svg`<line x1=${x} y1=${y} x2=${x} y2=${svgH} stroke="var(--surface-4)" stroke-width="1.5" />`,
          );
          continue;
        }
        const pNode = nodes[pRow];
        const px = pNode.lane * LANE_W + LANE_W / 2 + 4;
        const py = pRow * ROW_H + ROW_H / 2;

        if (px === x) {
          svgLines.push(
            svg`<line x1=${x} y1=${y} x2=${px} y2=${py} stroke="var(--surface-4)" stroke-width="1.5" />`,
          );
        } else {
          const midY = (y + py) / 2;
          svgLines.push(
            svg`<path d=${"M" + x + "," + y + " C" + x + "," + midY + " " + px + "," + midY + " " + px + "," + py} fill="none" stroke="var(--accent-user)" stroke-width="1.5" opacity="0.4" />`,
          );
        }
      }
    }

    return html`
      <div class="graph-scroll">
        <div class="graph-view" @keydown=${this.onListKeydown} style="height:${svgH}px">
          <svg class="graph-svg" width="${svgW}" height="${svgH}">${svgLines} ${svgDots}</svg>
          ${commits.map((c, i) => {
            const y = i * ROW_H;
            return html` <button
              class="graph-row ${c.sha === this.selectedSha ? "selected" : ""}"
              style="height:${ROW_H}px; top:${y}px; padding-left:${svgW + 4}px"
              @click=${() => this.selectCommit(c.sha)}
              title="${c.message} — ${c.authorName}"
            >
              <span class="graph-msg">${c.shortSha} ${c.message}</span>
              <span class="graph-age">${formatAge(Number(c.authorTime))}</span>
            </button>`;
          })}
        </div>
      </div>
    `;
  }

  override render() {
    if (this.state.phase === "loading") {
      return html`
        <gc-loading-banner
          heading="loading commits…"
          detail="walking git history; first load on a large repo or with a path filter can take a second"
        ></gc-loading-banner>
      `;
    }
    if (this.state.phase === "error") {
      return html`<div class="err">
        ${this.state.message}
        <button class="retry-btn" @click=${() => void this.load(0)}>retry</button>
      </div>`;
    }
    const { commits: rawCommits, hasMore, offset } = this.state;
    const lowerFilter = this.commitFilter.toLowerCase();
    const commits = lowerFilter
      ? rawCommits.filter(
          (c) =>
            c.message.toLowerCase().includes(lowerFilter) ||
            c.authorName.toLowerCase().includes(lowerFilter),
        )
      : rawCommits;
    const sel = this.selectedCommit();
    if (this.viewMode === "calendar") {
      return html`
        <div class="log-root">
          ${this.renderViewSwitch()}
          <gc-commit-calendar
            .commits=${commits}
            @gc:select-commit=${this.onCalendarPick}
          ></gc-commit-calendar>
        </div>
      `;
    }
    return html`
      <div class="log-root">
        ${this.renderViewSwitch()}
        <div
          class="layout ${this.drawerOpen ? "drawer-open" : ""} ${this.focused ? "focused" : ""}"
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Escape" && this.drawerOpen) {
              this.drawerOpen = false;
            }
          }}
        >
          <button
            class="drawer-toggle"
            @click=${() => this.toggleDrawer()}
            aria-label="Toggle commit list"
            aria-expanded=${this.drawerOpen ? "true" : "false"}
          >
            ☰
          </button>
          ${this.drawerOpen
            ? html`<div class="drawer-backdrop" @click=${() => (this.drawerOpen = false)}></div>`
            : nothing}
          <!-- Left: commit list sidebar -->
          <aside class="commit-list" aria-label="Commit history" tabindex="-1">
            <div class="list-header">
              <input
                class="commit-filter-input"
                type="search"
                placeholder="filter commits…"
                .value=${this.commitFilter}
                @input=${(e: Event) => {
                  this.commitFilter = (e.target as HTMLInputElement).value;
                }}
                aria-label="Filter commits by message or author"
              />
              <button
                class="graph-toggle ${this.graphMode ? "active" : ""}"
                @click=${() => {
                  this.graphMode = !this.graphMode;
                }}
                aria-label="Toggle graph view"
                aria-pressed=${this.graphMode ? "true" : "false"}
                title="Toggle graph view"
              >
                ⑂
              </button>
            </div>
            ${this.filterPath
              ? html`
                  <div class="path-filter-bar">
                    <span class="path-filter-label">history for</span>
                    <span class="path-filter-path">${this.filterPath}</span>
                    <button
                      class="path-filter-clear"
                      @click=${() => this.clearFilterPath()}
                      aria-label="Clear file filter"
                    >
                      x
                    </button>
                  </div>
                `
              : nothing}
            ${this.graphMode
              ? this.renderGraph(commits)
              : html`<ul class="commits" role="list" @keydown=${this.onListKeydown}>
                  ${commits.map(
                    (c) => html`
                      <li>
                        <button
                          class="commit-row ${c.sha === this.selectedSha ? "selected" : ""}"
                          aria-pressed=${c.sha === this.selectedSha ? "true" : "false"}
                          @click=${() => this.selectCommit(c.sha)}
                          title="${c.message} — ${c.authorName}"
                        >
                          <div class="commit-line1">
                            <span class="sha">${c.shortSha}</span>
                            <span class="commit-msg">${c.message}</span>
                          </div>
                          <div class="commit-line2">
                            <span class="commit-author">${c.authorName}</span>
                            <span class="commit-age">${formatAge(Number(c.authorTime), true)}</span>
                            ${c.filesChanged
                              ? html`<span class="commit-stats">
                                  <span class="adds">+${c.additions}</span>
                                  <span class="dels">-${c.deletions}</span>
                                </span>`
                              : nothing}
                          </div>
                        </button>
                      </li>
                    `,
                  )}
                </ul>`}
            ${hasMore
              ? html`<button class="load-more" @click=${() => this.load(offset + 50)}>
                  load more
                </button>`
              : nothing}
          </aside>

          <!-- Middle: commit info pane — split vertically, top is the
             commit metadata capped at 50% of the pane height, bottom is
             the file list filling the remainder. -->
          <section class="info-pane">
            ${sel
              ? html`
                  <div class="info-meta-section">
                    <div class="info-sha">
                      <span
                        class="detail-sha copyable"
                        tabindex="0"
                        role="button"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          copyText(this, sel.sha, "SHA copied");
                        }}
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            copyText(this, sel.sha, "SHA copied");
                          }
                        }}
                        title="Press Enter to copy full SHA"
                        >${sel.shortSha}</span
                      >
                    </div>
                    <div class="info-subject">${sel.message}</div>
                    ${sel.body ? html`<pre class="info-body">${sel.body}</pre>` : nothing}
                    <div class="info-meta">
                      <span>${sel.authorName}</span>
                      <span class="info-age">${formatAge(Number(sel.authorTime))}</span>
                    </div>
                    <button
                      class="action-btn"
                      @click=${() => this.askAboutCommit(sel)}
                      aria-label="Explain commit ${sel.shortSha} in chat"
                    >
                      explain in chat
                    </button>
                  </div>
                  ${this.files.length
                    ? html` <div class="info-files-section">
                        <div class="file-list-header">
                          <span>files</span>
                          <span class="info-files">${this.files.length}</span>
                        </div>
                        <ul class="file-list" role="list">
                          <li>
                            <button
                              class="file-entry ${this.selectedFile === "" ? "selected" : ""}"
                              @click=${() => this.selectFile("")}
                            >
                              <span class="file-status all">∗</span>
                              <span class="file-path">all files</span>
                              <span class="file-stats">
                                <span class="adds">+${sel.additions}</span>
                                <span class="dels">-${sel.deletions}</span>
                              </span>
                            </button>
                          </li>
                          ${this.files.map(
                            (f) => html`
                              <li>
                                <button
                                  class="file-entry ${this.selectedFile === f.path
                                    ? "selected"
                                    : ""}"
                                  @click=${(e: MouseEvent) => {
                                    if (e.metaKey || e.ctrlKey) {
                                      this.openInBrowse(f.path);
                                    } else {
                                      this.selectFile(f.path);
                                    }
                                  }}
                                  title="${f.fromPath
                                    ? `${f.fromPath} → ${f.path} (renamed)`
                                    : f.path} (⌘+click to open in browse)"
                                >
                                  <span class="file-status ${f.status}"
                                    >${statusLabel(f.status)}</span
                                  >
                                  <span class="file-path"
                                    >${fileName(f.path)}${f.fromPath
                                      ? html`<span class="rename-from"
                                          >← ${fileName(f.fromPath)}</span
                                        >`
                                      : nothing}</span
                                  >
                                  <span class="file-stats">
                                    <span class="adds">+${f.additions}</span>
                                    <span class="dels">-${f.deletions}</span>
                                  </span>
                                </button>
                              </li>
                            `,
                          )}
                        </ul>
                      </div>`
                    : nothing}
                `
              : html`<div class="info-empty">select a commit</div>`}
          </section>

          <!-- Right: diff pane -->
          <section class="diff-pane">
            ${sel
              ? html` <div class="diff-header">
                    ${this.selectedFile
                      ? html` <span class="file-status ${this.selectedFileEntry()?.status ?? ""}"
                            >${statusLabel(this.selectedFileEntry()?.status ?? "")}</span
                          >
                          <span class="diff-filepath">${this.selectedFile}</span>
                          <span class="diff-spacer"></span>
                          ${this.selectedFileEntry()
                            ? html`<span class="detail-stats">
                                <span class="adds">+${this.selectedFileEntry()!.additions}</span>
                                <span class="dels">-${this.selectedFileEntry()!.deletions}</span>
                              </span>`
                            : nothing}`
                      : html` <span class="detail-sha">${sel.shortSha}</span>
                          <span class="diff-label">diff</span>
                          <span class="diff-spacer"></span>
                          ${sel.filesChanged
                            ? html`<span class="detail-stats">
                                <span class="info-files"
                                  >${sel.filesChanged} file${sel.filesChanged > 1 ? "s" : ""}</span
                                >
                                <span class="adds">+${sel.additions}</span>
                                <span class="dels">-${sel.deletions}</span>
                              </span>`
                            : nothing}`}
                    <button
                      class="split-toggle ${this.splitView ? "active" : ""}"
                      @click=${() => {
                        this.splitView = !this.splitView;
                        this.dispatchNav({ splitView: this.splitView });
                      }}
                      aria-label="Toggle split diff view"
                      aria-pressed=${this.splitView ? "true" : "false"}
                      title="Toggle split/unified diff"
                    >
                      ${this.splitView ? "unified" : "split"}
                    </button>
                    ${this.selectedFile
                      ? html`<button
                          class="split-toggle ${this.threePane ? "active" : ""}"
                          @click=${() => this.toggleThreePane()}
                          aria-label="Toggle 3-pane diff view (before | diff | after)"
                          aria-pressed=${this.threePane ? "true" : "false"}
                          title="Toggle 3-pane view (before | diff | after)"
                        >
                          3-pane
                        </button>`
                      : nothing}
                  </div>
                  <div class="diff-body">${this.renderDiffPane()}</div>`
              : html`<div class="empty-detail">
                  <p class="empty-sub">click a commit to view its diff</p>
                </div>`}
          </section>
        </div>
      </div>
    `;
  }

  private renderViewSwitch() {
    return html`
      <div class="view-switch" role="tablist" aria-label="Log view mode">
        <button
          role="tab"
          class="view-opt ${this.viewMode === "commits" ? "active" : ""}"
          aria-selected=${this.viewMode === "commits" ? "true" : "false"}
          @click=${() => (this.viewMode = "commits")}
        >
          commits
        </button>
        <button
          role="tab"
          class="view-opt ${this.viewMode === "calendar" ? "active" : ""}"
          aria-selected=${this.viewMode === "calendar" ? "true" : "false"}
          @click=${() => (this.viewMode = "calendar")}
        >
          calendar
        </button>
      </div>
    `;
  }

  // Calendar emitted a pick — flip back to the commits view with
  // that SHA selected, so the diff pane resumes where the user
  // zoomed in from.
  private onCalendarPick = (e: CustomEvent<{ sha: string }>) => {
    this.viewMode = "commits";
    void this.selectCommit(e.detail.sha);
  };

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
      font-size: var(--text-base);
      color: var(--text);
      background: var(--surface-1);
    }
    /* log-root stacks the view-mode switch over either the three-
       pane commit layout or the full-pane calendar. Inherits the
       host's flex column so inner panes keep their scroll chain. */
    .log-root {
      display: flex;
      flex: 1;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
    }
    .view-switch {
      display: flex;
      gap: 2px;
      padding: var(--space-2) var(--space-3) 0;
      flex-shrink: 0;
    }
    .view-opt {
      padding: var(--space-1) var(--space-3);
      background: transparent;
      color: var(--text-muted);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.7;
      transition:
        background 0.12s ease,
        opacity 0.12s ease,
        border-color 0.12s ease;
    }
    .view-opt:hover {
      opacity: 1;
      background: var(--surface-2);
    }
    .view-opt.active {
      opacity: 1;
      color: var(--text);
      background: var(--surface-2);
      border-color: var(--border-default);
    }
    gc-commit-calendar {
      flex: 1;
      min-height: 0;
      min-width: 0;
      display: flex;
    }
    .loading,
    .err {
      padding: var(--space-6);
      opacity: 0.55;
    }
    .err {
      color: var(--danger);
      opacity: 1;
    }
    .retry-btn {
      margin-top: var(--space-3);
      padding: var(--space-1) var(--space-3);
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

    /* ── Sidebar + panel grid (matches chat/browse) ──────────── */
    .layout {
      display: grid;
      grid-template-columns: var(--sidebar-width) 280px 1fr;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }
    /* Focus mode (⌘\): hide commit list and metadata pane so the
       diff area — whether unified, split, or 3-pane — gets the full
       viewport width for reviewing one file at a time. */
    .layout.focused {
      grid-template-columns: 1fr;
    }
    .layout.focused .commit-list,
    .layout.focused .info-pane {
      display: none;
    }

    /* ── Left: commit list ───────────────────────────────────── */
    .commit-list {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--surface-4);
      background: var(--surface-0);
    }
    .commits {
      list-style: none;
      padding: var(--space-1) 0;
      margin: 0;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .commits li {
      margin: 0;
    }
    .commit-row {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      width: 100%;
      padding: var(--space-2) var(--space-3);
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
    .commit-row:hover {
      background: var(--surface-2);
    }
    .commit-row.selected {
      background: var(--surface-2);
      border-left-color: var(--accent-assistant);
    }
    .commit-row:focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: -2px;
    }
    .commit-line1 {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      overflow: hidden;
    }
    .sha {
      color: var(--accent-user);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .commit-msg {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--text-sm);
    }
    .commit-line2 {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 0.65rem;
      opacity: 0.5;
    }
    .commit-author {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .commit-age {
      flex-shrink: 0;
    }
    .commit-stats {
      flex-shrink: 0;
      display: flex;
      gap: var(--space-1);
    }
    .adds {
      color: var(--accent-assistant);
    }
    .dels {
      color: var(--danger);
      margin-left: var(--space-1);
    }

    .load-more {
      margin: var(--space-2);
      padding: var(--space-1) var(--space-3);
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      text-align: center;
    }
    .load-more:hover {
      background: var(--surface-3);
    }

    /* ── List header + graph toggle ─────────────────────────── */
    .list-header {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: var(--space-1) var(--space-2);
      border-bottom: 1px solid var(--surface-4);
      flex-shrink: 0;
      height: 36px;
      box-sizing: border-box;
    }
    .graph-toggle {
      padding: 2px var(--space-2);
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.4;
    }
    .graph-toggle:hover {
      opacity: 0.8;
    }
    .graph-toggle.active {
      opacity: 1;
      background: var(--surface-3);
      border-color: var(--accent-user);
    }

    /* ── Graph view ──────────────────────────────────────────── */
    .graph-scroll {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
    }
    .graph-view {
      position: relative;
    }
    .graph-svg {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 1;
      pointer-events: none;
    }
    .graph-row {
      display: flex;
      align-items: center;
      position: absolute;
      left: 0;
      right: 0;
      z-index: 2;
      padding: 0 var(--space-2) 0 48px;
      background: transparent;
      border: none;
      border-left: 2px solid transparent;
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-xs);
      text-align: left;
      cursor: pointer;
      gap: var(--space-2);
    }
    .graph-row:hover {
      background: var(--surface-2);
    }
    .graph-row.selected {
      background: var(--surface-2);
      border-left-color: var(--accent-assistant);
    }
    .graph-msg {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .graph-age {
      flex-shrink: 0;
      opacity: 0.45;
      font-size: 0.65rem;
    }

    /* ── Right: diff pane ─────────────────────────────────────── */
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
    .diff-spacer {
      flex: 1;
    }
    .diff-body {
      flex: 1;
      overflow: auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .diff-body > gc-three-pane-view {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    /* ── Middle: commit info pane ──────────────────────────────── */
    .info-pane {
      display: flex;
      flex-direction: column;
      padding: var(--space-4);
      gap: var(--space-3);
      border-right: 1px solid var(--surface-4);
      background: var(--surface-1);
      min-height: 0;
      overflow: hidden;
    }
    /* Top half: commit metadata. max-height: 50% lets short commits
       collapse to their natural size; long ones cap at half the pane
       and scroll internally so the file list below keeps its half. */
    .info-meta-section {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      max-height: 50%;
      overflow-y: auto;
      flex-shrink: 0;
    }
    /* Bottom half: file list. flex: 1 + min-height: 0 lets it fill
       whatever space the metadata section didn't claim and scroll
       within that remainder. */
    .info-files-section {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .info-sha .detail-sha {
      font-size: var(--text-sm);
    }
    .info-subject {
      font-size: var(--text-sm);
      font-weight: 500;
      line-height: 1.4;
    }
    .info-body {
      margin: 0;
      padding: var(--space-2) 0 var(--space-2) var(--space-3);
      border-left: 2px solid var(--surface-4);
      font-family: inherit;
      font-size: var(--text-xs);
      white-space: pre-wrap;
      opacity: 0.75;
      line-height: 1.6;
    }
    .info-meta {
      display: flex;
      gap: var(--space-2);
      font-size: var(--text-xs);
      opacity: 0.6;
    }
    .info-files {
      opacity: 0.5;
    }
    .info-empty {
      opacity: 0.4;
      padding: var(--space-4);
    }

    /* ── File list ──────────────────────────────────────────────── */
    .file-list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: var(--space-2);
      border-top: 1px solid var(--surface-4);
      font-size: var(--text-xs);
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      height: 28px;
      box-sizing: border-box;
    }
    .file-list {
      list-style: none;
      padding: 0;
      margin: var(--space-1) 0 0;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .file-entry {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      padding: var(--space-1) var(--space-2);
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
    .file-entry:hover {
      background: var(--surface-2);
    }
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
    .file-status.modified {
      color: var(--accent-user);
    }
    .file-status.added {
      color: var(--accent-assistant);
    }
    .file-status.deleted {
      color: var(--danger);
    }
    .file-status.renamed {
      color: var(--warning);
    }
    .file-status.all {
      color: var(--text);
      opacity: 0.5;
    }
    .file-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rename-from {
      margin-left: var(--space-2);
      font-size: 0.9em;
      opacity: 0.6;
    }
    .file-stats {
      flex-shrink: 0;
      display: flex;
      gap: var(--space-1);
      font-size: 0.6rem;
      opacity: 0.7;
    }
    .diff-filepath {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--text-xs);
    }

    .copyable {
      cursor: copy;
    }
    .copyable:hover {
      text-decoration: underline;
    }
    .detail-sha {
      color: var(--accent-user);
      font-size: var(--text-sm);
      flex-shrink: 0;
    }
    .detail-stats {
      display: flex;
      gap: var(--space-1);
      font-size: var(--text-xs);
      flex-shrink: 0;
    }
    .action-btn {
      padding: var(--space-1) var(--space-3);
      background: var(--action-bg);
      color: var(--text);
      border: 1px solid var(--border-accent);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
    }
    .action-btn:focus-visible,
    .commit-row:focus-visible,
    .detail-sha:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .action-btn:hover {
      background: var(--action-bg-hover);
    }
    .diff-loading {
      padding: var(--space-6);
      opacity: 0.5;
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
    .diff-content mark.word-del {
      background: rgba(248, 81, 73, 0.4);
      border-radius: 2px;
      padding: 0 1px;
    }
    .diff-content mark.word-add {
      background: rgba(63, 185, 80, 0.4);
      border-radius: 2px;
      padding: 0 1px;
    }

    /* ── Commit filter input ───────────────────────────────────── */
    .commit-filter-input {
      flex: 1;
      min-width: 0;
      padding: 2px var(--space-2);
      background: var(--surface-0);
      color: var(--text);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
      outline: none;
    }
    .commit-filter-input:focus {
      border-color: var(--accent-assistant);
    }
    .commit-filter-input::placeholder {
      opacity: 0.35;
    }

    /* ── Path filter bar ───────────────────────────────────────── */
    .path-filter-bar {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-1) var(--space-3);
      background: var(--surface-2);
      border-bottom: 1px solid var(--surface-4);
      font-size: var(--text-xs);
      flex-shrink: 0;
    }
    .path-filter-label {
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 0.6rem;
    }
    .path-filter-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--accent-user);
    }
    .path-filter-clear {
      padding: 0 var(--space-1);
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: 0.6rem;
      cursor: pointer;
      opacity: 0.5;
      line-height: 1.2;
    }
    .path-filter-clear:hover {
      opacity: 1;
    }

    /* ── Split diff toggle ─────────────────────────────────────── */
    .split-toggle {
      padding: 2px var(--space-2);
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.4;
      flex-shrink: 0;
    }
    .split-toggle:hover {
      opacity: 0.8;
    }
    .split-toggle.active {
      opacity: 1;
      background: var(--surface-3);
      border-color: var(--accent-user);
    }

    /* ── Split diff table ──────────────────────────────────────── */
    .split-diff {
      overflow-x: auto;
    }
    .split-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: var(--text-xs);
      line-height: 1.55;
    }
    .split-col {
      width: 50%;
    }
    .split-cell {
      padding: 0 var(--space-3);
      white-space: pre;
      vertical-align: top;
      border-right: 1px solid var(--surface-4);
      overflow: hidden;
    }
    .split-cell:last-child {
      border-right: none;
    }
    .del-cell:not(:empty) {
      background: rgba(255, 100, 100, 0.04);
    }
    .add-cell:not(:empty) {
      background: rgba(100, 255, 100, 0.04);
    }
    .empty-detail {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      opacity: 0.55;
    }
    .empty-sub {
      margin: 0;
      font-size: 0.82rem;
      opacity: 0.7;
    }

    @media (prefers-reduced-motion: reduce) {
      .commit-row {
        transition: none;
      }
    }
    @media (max-width: 1100px) and (min-width: 769px) {
      .layout {
        grid-template-columns: var(--sidebar-width) 1fr;
        grid-template-rows: auto 1fr;
      }
      .commit-list {
        grid-row: 1 / -1;
      }
      .info-pane {
        grid-column: 2;
        grid-row: 1;
        border-right: none;
        border-bottom: 1px solid var(--surface-4);
      }
      .diff-pane {
        grid-column: 2;
        grid-row: 2;
      }
    }
    .drawer-toggle {
      display: none;
    }
    .drawer-backdrop {
      display: none;
    }
    @media (max-width: 768px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      .info-pane {
        border-right: none;
        border-bottom: 1px solid var(--surface-4);
        max-height: 40vh;
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
      .commit-list {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: 280px;
        z-index: 40;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        border-right: 1px solid var(--surface-4);
      }
      .drawer-open .commit-list {
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
    }
  `;
}

function statusLabel(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

function fileName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

// Returns either a plain string or an {age, iso} object for tooltip.
function formatAge(unixSeconds: number, withTooltip: true): ReturnType<typeof html>;
function formatAge(unixSeconds: number, withTooltip?: false): string;
function formatAge(unixSeconds: number, withTooltip = false): string | ReturnType<typeof html> {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;
  let age: string;
  if (diff < 60) age = "now";
  else if (diff < 3600) age = Math.floor(diff / 60) + "m";
  else if (diff < 86400) age = Math.floor(diff / 3600) + "h";
  else if (diff < 604800) age = Math.floor(diff / 86400) + "d";
  else if (diff < 2592000) age = Math.floor(diff / 604800) + "w";
  else age = Math.floor(diff / 2592000) + "mo";

  if (!withTooltip) return age;
  const iso = new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);
  return html`<span title=${iso}>${age}</span>`;
}
