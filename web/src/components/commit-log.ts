import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { svg } from "lit";
import "./diff-pane.js";
import { repoClient } from "../lib/transport.js";
import type { CommitEntry, ChangedFile } from "../gen/gitchat/v1/repo_pb.js";
import { copyText } from "../lib/clipboard.js";
import { statusLabel, fileName } from "../lib/diff-types.js";
import { layoutGraph } from "../lib/commit-graph.js";
import "./loading-indicator.js";
import "./commit-log/commit-calendar.js";
import { readFocus, type FocusMode } from "../lib/focus.js";

type LogState =
  | { phase: "loading" }
  | {
      phase: "ready";
      commits: CommitEntry[];
      hasMore: boolean;
      offset: number;
    }
  | { phase: "error"; message: string };

// insertByAuthorTime splices a commit into a desc-sorted commit
// array at the right chronological position. Used when a commit
// selection originates from outside the currently paginated list
// (calendar drill-in, blame short-SHA lookup) — keeps the list
// visually coherent instead of appending out-of-order at the end.
function insertByAuthorTime(list: CommitEntry[], c: CommitEntry): CommitEntry[] {
  const t = Number(c.authorTime);
  let i = 0;
  while (i < list.length && Number(list[i]!.authorTime) >= t) i++;
  return [...list.slice(0, i), c, ...list.slice(i)];
}

@customElement("gc-commit-log")
export class GcCommitLog extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) branch = "";
  @property({ type: String }) initialCommitSha = "";
  @property({ type: String }) initialLogFile = "";
  @property({ type: Boolean }) initialSplitView = false;
  @property({ type: Boolean }) initialThreePane = false;
  @property({ type: String }) initialLogView: "commits" | "calendar" = "commits";
  @property({ type: Boolean }) initialGraphMode = false;
  @property({ type: String }) initialCommitFilter = "";
  @property({ type: Number }) focusNonce = 0;
  @state() private state: LogState = { phase: "loading" };
  @state() private selectedSha = "";
  @state() private drawerOpen = false;
  @state() private focusMode: FocusMode = readFocus();
  @state() private graphMode = false;
  // "commits" shows the three-pane commit-list + info + diff layout.
  // "calendar" hands the whole pane to gc-commit-calendar for a
  // timeline overview (year heatmap + week grid). Clicking an entry
  // in calendar mode flips back to commits mode with that SHA
  // selected so the diff flow resumes without losing context.
  @state() private viewMode: "commits" | "calendar" = "commits";
  // Full commit history for calendar view. The main commits array
  // pages lazily via "load more", but a heatmap is misleading
  // without the complete dataset — a busy day looks identical to
  // an empty one if half the commits haven't been fetched yet.
  // Populated by a background fetch-loop on first switch to
  // calendar; reset on repo/branch change via the existing updated
  // hook path.
  @state() private calendarCommits: CommitEntry[] = [];
  @state() private calendarLoading = false;
  private calendarLoaded = false;
  // When the user clicks a commit row in the sidebar while
  // calendar view is active, we DON'T navigate to the diff
  // (the diff pane is hidden behind the calendar). Instead we
  // arm the commit in the calendar — child jumps activeDate to
  // the commit's author time and the action bar appears for
  // explicit drill-in.
  @state() private calendarArmedSha = "";
  // Infinite-scroll plumbing for the commits list. The sentinel
  // sits at the tail of the commits list; whenever it crosses
  // into the scroll viewport, we fire the next page load. The
  // observer is wired in updated() because the sentinel's
  // presence depends on state.hasMore, which changes at runtime.
  @state() private loadingMore = false;
  private listObserver: IntersectionObserver | null = null;
  // Files list owns the commit-info sidebar (between the commit list and
  // the diff pane). Populated by gc:diff-files-loaded from <gc-diff-pane>
  // when it finishes fetching the whole-commit diff.
  @state() private files: ChangedFile[] = [];
  @state() private selectedFile = ""; // "" = all files
  @state() private commitFilter = "";
  @state() private splitView = false;
  // Three-pane diff view: before | unified diff | after. Only meaningful
  // when a single file is selected; toggle is disabled for the "all
  // files" combined view.
  @state() private threePane = false;
  // Progressive-enhancement flag flipped after the initial diff lands
  // when the file list has both adds and deletes — tells <gc-diff-pane>
  // to fire a follow-up rename-aware fetch. Parent-controlled so the
  // pane stays dumb about what the log-specific heuristic is.
  @state() private wantRenameDetection = false;
  @property({ type: String }) filterPath = "";
  private pendingSha = "";
  private commitFilterNavTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (this.repoId) void this.load(0);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("gc:select-commit", this.onSelectCommit);
    this.removeEventListener("gc:set-filter-path", this.onSetFilterPath);
    this.listObserver?.disconnect();
    this.listObserver = null;
    if (this.commitFilterNavTimer !== null) {
      clearTimeout(this.commitFilterNavTimer);
      this.commitFilterNavTimer = null;
    }
  }

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

  private clearFilterPath() {
    this.filterPath = "";
    this.dispatchNav({ filterPath: undefined });
  }

  private _lastRestoredSha = "";
  private _lastFocusNonce = 0;

  // Synchronous @state mutations (calendar invalidation, armed-sha
  // reset) move into willUpdate so they fold into the current render
  // cycle. Writing them in updated() produced Lit's "scheduled an
  // update after an update completed" dev-mode warning — benign in
  // prod but noise under HMR, and occasionally causes visible
  // half-rendered state in dev-mode reactivity loops.
  override willUpdate(changed: Map<string, unknown>) {
    if (
      (changed.has("repoId") || changed.has("branch") || changed.has("filterPath")) &&
      this.repoId
    ) {
      this.calendarLoaded = false;
      this.calendarArmedSha = "";
      this.calendarCommits = [];
    }
  }

  override updated(changed: Map<string, unknown>) {
    if (
      (changed.has("repoId") || changed.has("branch") || changed.has("filterPath")) &&
      this.repoId
    ) {
      // RPC kickoff stays in updated() — fine for async work that
      // resolves in a later tick; the synchronous state resets moved
      // to willUpdate above.
      void this.load(0);
    }
    if (
      changed.has("focusNonce") &&
      this.focusNonce > 0 &&
      this.focusNonce !== this._lastFocusNonce
    ) {
      this._lastFocusNonce = this.focusNonce;
      this.focusMode = readFocus();
    }
    // Kick off the full-history fetch the first time the user
    // switches into calendar view. Cached until the invalidation
    // above fires.
    if (
      changed.has("viewMode") &&
      this.viewMode === "calendar" &&
      !this.calendarLoaded &&
      !this.calendarLoading &&
      this.repoId
    ) {
      void this.loadAllCommits();
    }
    if (changed.has("initialCommitSha")) {
      if (
        this.initialCommitSha &&
        this.initialCommitSha !== this._lastRestoredSha
      ) {
        this._lastRestoredSha = this.initialCommitSha;
        if (this.state.phase === "ready") {
          void this.selectCommit(this.initialCommitSha);
        } else {
          this.pendingSha = this.initialCommitSha;
        }
      } else if (!this.initialCommitSha && this.selectedSha) {
        // URL cleared the SHA (e.g. back-button from /log/sha to /log,
        // or a nav that lands on the log tab without a selection).
        // Drop the stale selection so the detail/diff panes reset.
        this.selectedSha = "";
        this.selectedFile = "";
        this._lastRestoredSha = "";
      }
    }
    if (changed.has("initialSplitView")) {
      this.splitView = this.initialSplitView;
    }
    if (changed.has("initialThreePane")) {
      this.threePane = this.initialThreePane;
    }
    if (changed.has("initialGraphMode")) {
      this.graphMode = this.initialGraphMode;
    }
    // Only sync the commit-filter input from the URL when the value
    // differs — avoids stomping the user's in-progress edits that
    // haven't yet fired their 300ms nav debounce.
    if (
      changed.has("initialCommitFilter") &&
      this.initialCommitFilter !== this.commitFilter
    ) {
      this.commitFilter = this.initialCommitFilter;
    }
    // URL drives viewMode: when the route changes (deep link, back
    // button, bridge from another view), sync the internal mode.
    if (changed.has("initialLogView") && this.initialLogView !== this.viewMode) {
      this.viewMode = this.initialLogView;
    }
    // Re-attach the infinite-scroll sentinel observer every render
    // in commits view — the sentinel is recreated whenever
    // hasMore flips or the list re-renders. Calling observe() on
    // the same element is idempotent, and we disconnect/null the
    // observer when the sentinel disappears so we don't hold a
    // stale reference.
    this.rewireListObserver();
  }

  private rewireListObserver() {
    // The commit-list sidebar is rendered in both commits and calendar
    // viewMode (calendar mode keeps the sidebar visible alongside the
    // heatmap), so pagination should work in either. Graph mode swaps
    // the ul for the absolute-positioned graph rows; query the matching
    // scroller and let the absence-check below handle cleanup when no
    // sidebar list is on screen at all.
    const sentinel = this.renderRoot.querySelector<HTMLElement>(".load-sentinel");
    const scroller = this.renderRoot.querySelector<HTMLElement>(
      this.graphMode ? ".graph-scroll" : ".commits",
    );
    if (!sentinel || !scroller) {
      this.listObserver?.disconnect();
      this.listObserver = null;
      return;
    }
    // The scroll root differs between list and graph views, so any
    // existing observer is stale on mode toggle — tear it down so the
    // new one is created with the correct `root`.
    if (this.listObserver && this.listObserver.root !== scroller) {
      this.listObserver.disconnect();
      this.listObserver = null;
    }
    if (!this.listObserver) {
      this.listObserver = new IntersectionObserver(
        (entries) => {
          if (
            entries.some((e) => e.isIntersecting) &&
            this.state.phase === "ready" &&
            this.state.hasMore &&
            !this.loadingMore
          ) {
            this.loadingMore = true;
            const nextOffset = this.state.offset + 50;
            void this.load(nextOffset).finally(() => {
              this.loadingMore = false;
            });
          }
        },
        { root: scroller, rootMargin: "200px" },
      );
    }
    this.listObserver.observe(sentinel);
  }

  // loadAllCommits pages through listCommits in small batches so
  // the calendar heatmap fills in progressively via Lit reactivity
  // rather than blocking on a single huge fetch. Each batch
  // assigns to calendarCommits (a @state), which re-renders
  // gc-commit-calendar with the growing dataset. Small page size
  // keeps the first-paint latency bounded on large repos; the
  // loading flag drives a count indicator in the view-switch bar.
  private async loadAllCommits() {
    this.calendarLoading = true;
    this.calendarCommits = [];
    const pageSize = 100;
    let offset = 0;
    try {
      for (;;) {
        const resp = await repoClient.listCommits({
          repoId: this.repoId,
          ref: this.branch,
          limit: pageSize,
          offset,
          path: "", // whole-repo for the heatmap, not the filtered view
        });
        this.calendarCommits =
          offset === 0 ? resp.commits : [...this.calendarCommits, ...resp.commits];
        offset += resp.commits.length;
        if (!resp.hasMore || resp.commits.length === 0) break;
        // Yield to the event loop so Lit can paint the growing
        // heatmap between batches — otherwise large repos hold
        // the main thread across the whole loop.
        await new Promise((r) => setTimeout(r, 0));
      }
      this.calendarLoaded = true;
    } catch {
      // Leave calendarLoaded=false so a subsequent switch can
      // retry. Whatever batches already landed keep rendering.
    } finally {
      this.calendarLoading = false;
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
      const commits =
        offset > 0 && this.state.phase === "ready"
          ? [...this.state.commits, ...resp.commits]
          : resp.commits;
      this.state = {
        phase: "ready",
        commits,
        hasMore: resp.hasMore,
        offset,
      };
      // If a prior selection points at a commit that's not in the
      // freshly-loaded list (filter changed, branch switched, repo
      // switched), clear it so the detail pane doesn't show stale
      // state and the diff pane doesn't fetch against a SHA the user
      // can't see in the sidebar. A subsequent explicit selection (via
      // click or initialCommitSha) restores a fresh selection.
      if (
        offset === 0 &&
        this.selectedSha &&
        !commits.some(
          (c) => c.sha === this.selectedSha || c.sha.startsWith(this.selectedSha),
        )
      ) {
        this.selectedSha = "";
        this.selectedFile = "";
      }
      if (this.pendingSha) {
        const sha = this.pendingSha;
        this.pendingSha = "";
        void this.selectCommit(sha);
      } else if (offset === 0 && !this.selectedSha && commits.length > 0) {
        // Auto-select the most recent commit so landing on /log
        // (or /log?filter=path) shows the top commit's diff instead
        // of an empty detail pane. Deliberately does NOT dispatch
        // nav — keeping the default /log URL clean, so share-links
        // to plain /log still land users on the default view
        // (newest commit diff of whatever filter applies) rather
        // than a specific SHA.
        this.selectedSha = commits[0].sha;
        this._lastRestoredSha = this.selectedSha;
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

  // pickCommit is the sidebar-row click entry point. In commits
  // view it drills to the diff (full selectCommit flow); in
  // calendar view it only arms the commit in the child so the
  // calendar jumps to the relevant date — drill-in then happens
  // via the action bar's "view commit" button, matching the
  // click-on-calendar-entry flow.
  private pickCommit(sha: string) {
    if (this.viewMode === "calendar") {
      this.calendarArmedSha = sha;
      return;
    }
    void this.selectCommit(sha);
  }

  private async selectCommit(sha: string) {
    // Resolve and splice-in commits that aren't in the paginated
    // state.commits page yet. Two entry paths need this:
    //   - short SHA from blame ("b7f7cd0") → listCommits with ref
    //     to expand to full SHA + entry
    //   - full SHA from the calendar drill-in → commit lives in
    //     calendarCommits (full history), not state.commits. We
    //     copy it over so the sidebar can highlight the selection
    //     without a round-trip.
    if (this.state.phase === "ready") {
      const inList = this.state.commits.find(
        (c) => c.sha === sha || (sha.length < 40 && c.sha.startsWith(sha)),
      );
      if (inList) {
        sha = inList.sha;
      } else {
        const fromCalendar =
          sha.length === 40 ? this.calendarCommits.find((c) => c.sha === sha) : undefined;
        if (fromCalendar) {
          this.state = {
            ...this.state,
            commits: insertByAuthorTime(this.state.commits, fromCalendar),
          };
        } else if (this.state.hasMore) {
          // Not in either list — resolve via listCommits with ref.
          try {
            const resp = await repoClient.listCommits({
              repoId: this.repoId,
              ref: sha,
              limit: 1,
            });
            if (resp.commits.length > 0) {
              sha = resp.commits[0].sha;
              this.state = {
                ...this.state,
                commits: insertByAuthorTime(this.state.commits, resp.commits[0]),
              };
            }
          } catch {
            // Can't resolve — proceed with best-effort SHA.
          }
        }
      }
    }
    if (this.selectedSha === sha) {
      // Toggle off — clearing selectedSha unmounts the pane, which
      // disconnects its settings listener and cancels any in-flight
      // rename fetch in its disconnectedCallback.
      this.selectedSha = "";
      this.selectedFile = "";
      this.files = [];
      this.wantRenameDetection = false;
      this.threePane = false;
      return;
    }
    this.selectedSha = sha;
    this.selectedFile = "";
    this.drawerOpen = false;
    this.files = [];
    this.wantRenameDetection = false;
    this._lastRestoredSha = this.selectedSha;
    this.dispatchNav({ commitSha: this.selectedSha || undefined, logFile: undefined });
  }

  // onDiffFilesLoaded runs when <gc-diff-pane> finishes its whole-commit
  // fetch (and again after rename detection). Populates the file-list
  // sidebar and gates the progressive rename-aware second fetch.
  private onDiffFilesLoaded = (
    e: CustomEvent<{ files: ChangedFile[]; parentSha: string; toCommit: string }>,
  ) => {
    this.files = e.detail.files;
    // Progressive enhancement: if the fast list has both adds and
    // deletes, ask the pane for a rename-aware refetch. The heuristic
    // stays log-side so the pane doesn't have to know which contexts
    // want detection.
    if (
      !this.wantRenameDetection &&
      this.files.some((f) => f.status === "added") &&
      this.files.some((f) => f.status === "deleted")
    ) {
      this.wantRenameDetection = true;
    }
  };

  // Commit filter updates the URL on trailing-edge debounce instead
  // of per-keystroke — otherwise every character push_states a new
  // history entry, polluting back-button and spamming the hash.
  private scheduleCommitFilterNav() {
    if (this.commitFilterNavTimer !== null) clearTimeout(this.commitFilterNavTimer);
    this.commitFilterNavTimer = setTimeout(() => {
      this.commitFilterNavTimer = null;
      this.dispatchNav({ commitFilter: this.commitFilter || undefined });
    }, 300);
  }

  private dispatchNav(detail: Record<string, string | boolean | undefined>) {
    this.dispatchEvent(new CustomEvent("gc:nav", { bubbles: true, composed: true, detail }));
  }

  // setSelectedFile is the file-list onclick target. The pane reacts to
  // path changes itself via its updated() hook, so all we do here is
  // flip the state and dispatch the URL update.
  private setSelectedFile(path: string) {
    if (this.selectedFile === path) return;
    this.selectedFile = path;
    this.dispatchNav({ logFile: this.selectedFile || undefined });
  }

  private selectedFileEntry(): ChangedFile | undefined {
    return this.files.find((f) => f.path === this.selectedFile);
  }

  private selectedCommit(): CommitEntry | undefined {
    if (this.state.phase !== "ready" || !this.selectedSha) return undefined;
    return this.state.commits.find(
      (c) => c.sha === this.selectedSha || c.sha.startsWith(this.selectedSha),
    );
  }

  private renderGraph(commits: CommitEntry[]) {
    // Lane assignment is a pure function — see lib/commit-graph.ts for
    // the algorithm + tests. Here we only render the SVG on top of it.
    const ROW_H = 32;
    const LANE_W = 16;
    const DOT_R = 4;
    const { nodes, maxLane } = layoutGraph(commits);
    const shaToRow = new Map<string, number>();
    for (let i = 0; i < commits.length; i++) shaToRow.set(commits[i].sha, i);
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

    const hasMore = this.state.phase === "ready" && this.state.hasMore;
    const sentinelH = 32;
    const totalH = svgH + (hasMore ? sentinelH : 0);
    return html`
      <div class="graph-scroll">
        <div class="graph-view" @keydown=${this.onListKeydown} style="height:${totalH}px">
          <svg class="graph-svg" width="${svgW}" height="${svgH}">${svgLines} ${svgDots}</svg>
          ${repeat(
            commits,
            (c) => c.sha,
            (c, i) => {
              const y = i * ROW_H;
              const inCal = this.viewMode === "calendar";
              const armed = inCal && c.sha === this.calendarArmedSha;
              const selected = !inCal && c.sha === this.selectedSha;
              return html` <button
                data-sha=${c.sha}
                class=${classMap({ "graph-row": true, selected, armed })}
                style="height:${ROW_H}px; top:${y}px; padding-left:${svgW + 4}px"
                @click=${() => this.pickCommit(c.sha)}
                title="${c.message} — ${c.authorName}"
              >
                <span class="graph-msg">${c.shortSha} ${c.message}</span>
                <span class="graph-age">${formatAge(Number(c.authorTime))}</span>
              </button>`;
            },
          )}
          ${hasMore
            ? html`<div
                class="load-sentinel graph-sentinel"
                role="presentation"
                aria-hidden="true"
                style="top:${svgH}px; height:${sentinelH}px"
              >
                ${this.loadingMore ? "loading…" : ""}
              </div>`
            : nothing}
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
    const { commits: rawCommits, hasMore } = this.state;
    const lowerFilter = this.commitFilter.toLowerCase();
    const commits = lowerFilter
      ? rawCommits.filter(
          (c) =>
            c.message.toLowerCase().includes(lowerFilter) ||
            c.authorName.toLowerCase().includes(lowerFilter),
        )
      : rawCommits;
    const sel = this.selectedCommit();
    return html`
      <div class="log-root">
        <div
          class=${classMap({
            layout: true,
            "calendar-mode": this.viewMode === "calendar",
            "drawer-open": this.drawerOpen,
            focused: this.focusMode !== "off",
            zen: this.focusMode === "zen",
          })}
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
                  this.scheduleCommitFilterNav();
                }}
                aria-label="Filter commits by message or author"
              />
              <button
                class="hd-btn ${this.viewMode === "calendar" ? "active" : ""}"
                @click=${() =>
                  this.setViewMode(this.viewMode === "calendar" ? "commits" : "calendar")}
                aria-label="Toggle commit calendar"
                aria-pressed=${this.viewMode === "calendar" ? "true" : "false"}
                title="Commit calendar"
              >
                ▦
              </button>
              <button
                class="hd-btn ${this.graphMode ? "active" : ""}"
                @click=${() => {
                  this.graphMode = !this.graphMode;
                  this.dispatchNav({ graphMode: this.graphMode || undefined });
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
                  ${repeat(
                    commits,
                    (c) => c.sha,
                    (c) => {
                      const inCal = this.viewMode === "calendar";
                      const armed = inCal && c.sha === this.calendarArmedSha;
                      const selected = !inCal && c.sha === this.selectedSha;
                      return html`
                        <li>
                          <button
                            data-sha=${c.sha}
                            class=${classMap({ "commit-row": true, selected, armed })}
                            aria-pressed=${selected || armed ? "true" : "false"}
                            @click=${() => this.pickCommit(c.sha)}
                            title="${c.message} — ${c.authorName}"
                          >
                            <div class="commit-line1">
                              <span class="sha">${c.shortSha}</span>
                              <span class="commit-msg">${c.message}</span>
                            </div>
                            <div class="commit-line2">
                              <span class="commit-author">${c.authorName}</span>
                              <span class="commit-age"
                                >${formatAge(Number(c.authorTime), true)}</span
                              >
                              ${c.filesChanged
                                ? html`<span class="commit-stats">
                                    <span class="adds">+${c.additions}</span>
                                    <span class="dels">-${c.deletions}</span>
                                  </span>`
                                : nothing}
                            </div>
                          </button>
                        </li>
                      `;
                    },
                  )}
                  ${hasMore
                    ? html`<li class="load-sentinel" role="presentation" aria-hidden="true">
                        ${this.loadingMore ? "loading…" : ""}
                      </li>`
                    : nothing}
                </ul>`}
          </aside>

          ${this.viewMode === "calendar"
            ? html`<gc-commit-calendar
                class="calendar-pane"
                .commits=${this.calendarCommits}
                .loadedCount=${this.calendarCommits.length}
                .loading=${this.calendarLoading}
                .armedSha=${this.calendarArmedSha}
                @gc:select-commit=${this.onCalendarPick}
                @gc:arm-commit=${this.onCalendarArm}
              ></gc-commit-calendar>`
            : html` <!-- Middle: commit info pane — split vertically, top is the
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
                                    @click=${() => this.setSelectedFile("")}
                                  >
                                    <span class="file-status all">∗</span>
                                    <span class="file-path">all files</span>
                                    <span class="file-stats">
                                      <span class="adds">+${sel.additions}</span>
                                      <span class="dels">-${sel.deletions}</span>
                                    </span>
                                  </button>
                                </li>
                                ${repeat(
                                  this.files,
                                  (f) => f.path,
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
                                            this.setSelectedFile(f.path);
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
                            ? html` <span
                                  class="file-status ${this.selectedFileEntry()?.status ?? ""}"
                                  >${statusLabel(this.selectedFileEntry()?.status ?? "")}</span
                                >
                                <span class="diff-filepath">${this.selectedFile}</span>
                                <span class="diff-spacer"></span>
                                ${this.selectedFileEntry()
                                  ? html`<span class="detail-stats">
                                      <span class="adds"
                                        >+${this.selectedFileEntry()!.additions}</span
                                      >
                                      <span class="dels"
                                        >-${this.selectedFileEntry()!.deletions}</span
                                      >
                                    </span>`
                                  : nothing}`
                            : html` <span class="detail-sha">${sel.shortSha}</span>
                                <span class="diff-label">diff</span>
                                <span class="diff-spacer"></span>
                                ${sel.filesChanged
                                  ? html`<span class="detail-stats">
                                      <span class="info-files"
                                        >${sel.filesChanged}
                                        file${sel.filesChanged > 1 ? "s" : ""}</span
                                      >
                                      <span class="adds">+${sel.additions}</span>
                                      <span class="dels">-${sel.deletions}</span>
                                    </span>`
                                  : nothing}`}
                          <button
                            class="split-toggle ${this.splitView ? "active" : ""}"
                            @click=${() => {
                              this.splitView = !this.splitView;
                              // split and 3-pane are mutually exclusive in
                              // the diff pane's render (3-pane wins); make
                              // the UI reflect that so the user doesn't
                              // click split and see nothing change.
                              if (this.splitView) this.threePane = false;
                              this.dispatchNav({
                                splitView: this.splitView || undefined,
                                threePane: this.threePane || undefined,
                              });
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
                                @click=${() => {
                                  this.threePane = !this.threePane;
                                  if (this.threePane) this.splitView = false;
                                  this.dispatchNav({
                                    threePane: this.threePane || undefined,
                                    splitView: this.splitView || undefined,
                                  });
                                }}
                                aria-label="Toggle 3-pane diff view (before | diff | after)"
                                aria-pressed=${this.threePane ? "true" : "false"}
                                title="Toggle 3-pane view (before | diff | after)"
                              >
                                3-pane
                              </button>`
                            : nothing}
                        </div>
                        <gc-diff-pane
                          class="diff-body"
                          .repoId=${this.repoId}
                          .toRef=${this.selectedSha}
                          .path=${this.selectedFile}
                          .fromPath=${this.selectedFileEntry()?.fromPath ?? ""}
                          .splitView=${this.splitView}
                          .threePane=${this.threePane}
                          .detectRenames=${this.wantRenameDetection}
                          @gc:diff-files-loaded=${this.onDiffFilesLoaded}
                        ></gc-diff-pane>`
                    : html`<div class="empty-detail">
                        <p class="empty-sub">click a commit to view its diff</p>
                      </div>`}
                </section>`}
        </div>
      </div>
    `;
  }

  private setViewMode(next: "commits" | "calendar") {
    if (this.viewMode === next) return;
    this.viewMode = next;
    // Sync to the URL — `logView` is "commits" by default, so
    // clearing it (undefined) keeps the hash compact for the
    // default case while ?view=calendar persists the toggle
    // across reloads and deep-links.
    this.dispatchNav({ logView: next === "calendar" ? "calendar" : undefined });
  }

  // Calendar emitted a pick — flip back to commits mode so the
  // diff pane becomes visible, and select the picked SHA. We also
  // listen for `gc:select-commit` on this host (connectedCallback);
  // halt propagation so the bubbling listener doesn't re-fire and
  // toggle the selection back off.
  private onCalendarPick = (e: CustomEvent<{ sha: string }>) => {
    e.stopPropagation();
    this.calendarArmedSha = "";
    this.setViewMode("commits");
    void this.selectCommit(e.detail.sha);
  };

  // User clicked a calendar entry — child reports which SHA so the
  // sidebar row can reflect the same armed state. If the commit
  // lives in the full-history calendarCommits but hasn't paged into
  // the paginated sidebar yet, splice it in at its chronological
  // position so the row exists to highlight. Then scroll into view
  // so the user sees the selection echo even if the list was
  // scrolled elsewhere. Safe to echo the sidebar-driven path too:
  // same SHA = no-op identity match.
  private onCalendarArm = (e: CustomEvent<{ sha: string }>) => {
    const sha = e.detail.sha;
    if (this.state.phase === "ready" && !this.state.commits.some((c) => c.sha === sha)) {
      const fromCal = this.calendarCommits.find((c) => c.sha === sha);
      if (fromCal) {
        this.state = {
          ...this.state,
          commits: insertByAuthorTime(this.state.commits, fromCal),
        };
      }
    }
    this.calendarArmedSha = sha;
    void this.updateComplete.then(() => {
      const row = this.renderRoot.querySelector<HTMLElement>(`[data-sha="${sha}"]`);
      row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
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
    .log-root {
      display: flex;
      flex: 1;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
    }
    /* View-switch lives inside .list-header in commits mode
       (keeps total pane height unchanged) and inside gc-commit-
       calendar's own header in calendar mode. Both placements
       share this tab-underline styling so the toggle looks the
       same regardless of which view is active. */
    .view-switch {
      display: inline-flex;
      align-items: center;
      gap: var(--space-3);
      margin-right: var(--space-2);
    }
    .view-opt {
      padding: 6px 0;
      background: transparent;
      color: var(--text);
      border: none;
      border-bottom: 2px solid transparent;
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.5;
      transition:
        opacity 0.12s ease,
        border-color 0.12s ease;
    }
    .view-opt:hover {
      opacity: 0.85;
    }
    .view-opt.active {
      opacity: 1;
      color: var(--accent-user);
      border-bottom-color: var(--accent-user);
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
    /* Calendar mode collapses the info+diff panes into a single
       main area so the year heatmap has room to breathe while the
       commit-list sidebar stays visible for direct selection. */
    .layout.calendar-mode {
      grid-template-columns: var(--sidebar-width) 1fr;
    }
    gc-commit-calendar.calendar-pane {
      min-height: 0;
      min-width: 0;
      display: flex;
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
    /* Zen extends focus by dropping the diff-header toolbar too —
       the bar shows shortSha, file path, and split/3-pane toggles,
       all of which are also visible in the URL or reachable via
       keyboard/palette. Leaving only the diff body matches how
       zen works in chat-view and file-view. */
    .layout.zen .diff-header {
      display: none;
    }
    /* Center the diff column on wide monitors and cap its reading
       width. 140ch is wider than file-view's 120ch because split /
       3-pane diffs need the extra horizontal room. */
    .layout.zen .diff-pane {
      max-width: 140ch;
      width: 100%;
      margin: 0 auto;
      padding: var(--space-6) var(--space-4);
      box-sizing: border-box;
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
    /* Armed = "calendar has this commit focused" — parallel to
       .selected but uses the user accent so the two states are
       distinguishable when both happen to apply (e.g., user
       previously selected a commit then switched to calendar mode
       and armed a different one). */
    .commit-row.armed {
      background: var(--surface-2);
      border-left-color: var(--accent-user);
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

    /* Invisible target for the IntersectionObserver; when it
       scrolls into the viewport we auto-fetch the next page.
       A small height reserves space for the "loading…" glyph
       so the list doesn't jitter on page boundaries. */
    .load-sentinel {
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.4;
      font-size: var(--text-xs);
      padding: var(--space-2);
    }
    /* Graph view positions its rows absolutely inside .graph-view, so
       the sentinel has to play by the same rules — absolute at the
       bottom of the virtual stack so it crosses into view when the
       user scrolls past the last row. */
    .graph-sentinel {
      position: absolute;
      left: 0;
      right: 0;
      padding: 0;
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
    /* Shared header-button style — same pattern as repo-browser's
       .hd-btn so the two tabs feel visually consistent and a user
       who learned one affordance applies it to the other. */
    .hd-btn {
      padding: 2px var(--space-2);
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.4;
      transition:
        opacity 0.12s ease,
        background 0.12s ease,
        border-color 0.12s ease;
    }
    .hd-btn:hover {
      opacity: 0.8;
    }
    .hd-btn.active {
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
    .graph-row.armed {
      background: var(--surface-2);
      border-left-color: var(--accent-user);
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
