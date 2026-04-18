import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "@jpahd/kalendus";
import type { CommitEntry } from "../../gen/gitchat/v1/repo_pb.js";

// commitEntryToCalendar maps one CommitEntry → one CalendarEntry.
// author_time is unix seconds; we convert to a local Date and
// derive the CalendarDate + CalendarTime shape kalendus expects.
// Commits are instantaneous, but kalendus requires end > start —
// we use a 5-minute slot: long enough that the chip renders with
// readable text in week view, short enough that 20 commits/hour
// don't all visually collapse on top of each other.
function commitToEntry(c: CommitEntry): CalendarEntry {
  const d = new Date(Number(c.authorTime) * 1000);
  const startMin = d.getMinutes();
  const totalEnd = startMin + 5;
  const endHour = (d.getHours() + Math.floor(totalEnd / 60)) % 24;
  return {
    date: {
      start: { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() },
      end: { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() },
    },
    time: {
      start: { hour: d.getHours(), minute: startMin },
      end: { hour: endHour, minute: totalEnd % 60 },
    },
    heading: `${c.shortSha} ${c.message}`,
    content:
      `${c.authorName} · ${c.filesChanged} file${c.filesChanged === 1 ? "" : "s"} · +${c.additions} -${c.deletions}\n\n${c.body || ""}`.trim(),
    // Kalendus accepts any CSS color; the wrapper's :host sets
    // --commit-color so a theme swap can retune entry colors
    // from one place.
    color: "var(--commit-color)",
    isContinuation: false,
  };
}

// entryKey reconstructs the lookup key from an open-menu event
// detail. Uses heading because it contains the short SHA — unique
// enough for round-tripping clicks back to a commit.
function keyFor(heading: string): string {
  return heading.split(" ", 1)[0] ?? heading;
}

function todayDate(): CalendarDate {
  const d = new Date();
  return { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() };
}

// Subset of kalendus's internal ViewState controller we poke at —
// enough to navigate imperatively without depending on its private
// full shape. Matches the runtime methods in dist/kalendus.js.
interface CalendarViewState {
  setActiveDate(date: CalendarDate): void;
  switchToDayView(): void;
}

// Kalendus's public openMenu API + the internal _viewState accessor
// we also reach for to navigate. Typed narrowly so a future kalendus
// version breaking either contract trips TS rather than silently
// no-op'ing at runtime.
interface KalendusAPI extends HTMLElement {
  openMenu(details: {
    heading: string;
    content: string;
    time?: CalendarTimeInterval;
    displayTime: string;
    date?: CalendarDate;
    anchorRect?: DOMRect;
  }): void;
  updateComplete: Promise<boolean>;
  _viewState: CalendarViewState;
}

@customElement("gc-commit-calendar")
export class GcCommitCalendar extends LitElement {
  @property({ type: Array }) commits: CommitEntry[] = [];
  @property({ type: Number }) loadedCount = 0;
  @property({ type: Boolean }) loading = false;
  // External arming from the sidebar commit list: when the parent
  // sets this to a full SHA, the matching commit is armed in the
  // calendar (tooltip-ready via the action bar) and the calendar
  // navigates its activeDate to the commit's author date, so the
  // year heatmap / week grid scrolls to reveal it. Empty = no
  // external arming; internal clicks on calendar entries still
  // arm independently via onOpenMenu.
  @property({ type: String }) armedSha = "";

  @state() private entries: CalendarEntry[] = [];
  @state() private activeDate: CalendarDate = todayDate();
  // The commit the user clicked on most recently in the calendar.
  // Kalendus opens its own detail tooltip on entry click — we hold
  // the SHA here so a companion "View commit" button can navigate
  // on explicit button press, consistent with code-city's
  // building-click → detail panel → "View File" action flow.
  @state() private armedCommit: CommitEntry | null = null;
  // Tracks whether kalendus's detail menu is currently open. While
  // it is, the toast is suppressed — the tooltip already shows the
  // same heading/content and they'd otherwise collide at the bottom
  // of the pane. When the user dismisses the menu, the toast
  // re-appears so "view commit" is reachable without re-arming.
  @state() private menuOpen = false;
  // Cache the mapped CalendarEntry per SHA so progressive batches
  // from the parent (fetch-loop) only convert new commits, not
  // the whole array each tick. Kalendus still reprocesses the
  // entries array on each setter call — that part is intrinsic —
  // but we avoid the per-batch commitToEntry cost which dominates
  // on large repos.
  private entryCache = new Map<string, CalendarEntry>();

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("commits")) {
      // When the parent resets commits (repo/branch change), wipe
      // the cache so stale entries don't leak into the new view.
      if (this.commits.length === 0) {
        this.entryCache.clear();
        this.entries = [];
      } else {
        this.entries = this.commits.map((c) => {
          let entry = this.entryCache.get(c.sha);
          if (!entry) {
            entry = commitToEntry(c);
            this.entryCache.set(c.sha, entry);
          }
          return entry;
        });
      }
    }
    // External arming: sidebar row click in calendar mode drives
    // this. Reacts to armedSha changes OR late commits arrivals
    // (if the SHA was set before its commit loaded, we re-try once
    // the batch lands).
    if ((changed.has("armedSha") || changed.has("commits")) && this.armedSha) {
      const commit = this.commits.find((c) => c.sha === this.armedSha);
      if (commit) {
        this.armedCommit = commit;
        const d = new Date(Number(commit.authorTime) * 1000);
        this.activeDate = {
          day: d.getDate(),
          month: d.getMonth() + 1,
          year: d.getFullYear(),
        };
      }
    }
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("armedSha") && this.armedSha) {
      void this.revealArmedCommit();
    }
    // Kalendus ships a built-in "export as .ics" button in its
    // detail menu. That's useful for real calendar events but
    // nonsensical for git commits, so we inject a scoped stylesheet
    // into the lms-menu shadow root to hide it. Idempotent — the
    // sheet is only added once per menu instance.
    this.hideExportButtonOnce();
  }

  private exportStyleInjected = false;
  private hideExportButtonOnce() {
    if (this.exportStyleInjected) return;
    const cal = this.renderRoot.querySelector("lms-calendar");
    const menuRoot = cal?.shadowRoot?.querySelector("lms-menu")?.shadowRoot;
    if (!menuRoot) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".export-btn { display: none !important; }");
    menuRoot.adoptedStyleSheets = [...menuRoot.adoptedStyleSheets, sheet];
    this.exportStyleInjected = true;
  }

  // Navigate to the armed commit's date, switch to day view, scroll
  // the entry chip into view, and click it to trigger kalendus's
  // native selection flow (highlight + open-menu anchored to the
  // chip). We prefer simulating the click over calling openMenu
  // directly because kalendus's click handler:
  //   - sets the chip's _highlighted state → visible focus ring
  //   - dispatches open-menu with the chip's own getBoundingClientRect
  //     so the tooltip positions correctly beside the chip
  //   - re-triggers our own onOpenMenu as a no-op harmless echo
  // Fallback: if no matching chip is found (e.g., the entry got
  // consolidated), center-anchor the menu on the calendar host.
  private async revealArmedCommit() {
    const commit = this.commits.find((c) => c.sha === this.armedSha);
    if (!commit) return;
    const cal = this.renderRoot.querySelector("lms-calendar") as KalendusAPI | null;
    if (!cal) return;
    const d = new Date(Number(commit.authorTime) * 1000);
    const date: CalendarDate = {
      day: d.getDate(),
      month: d.getMonth() + 1,
      year: d.getFullYear(),
    };
    cal._viewState.setActiveDate(date);
    cal._viewState.switchToDayView();
    // Wait for kalendus to render the day view so the entry chip
    // exists in its shadow DOM.
    await cal.updateComplete;
    const heading = `${commit.shortSha} ${commit.message}`;
    const entry = this.findEntryByHeading(cal, heading);
    if (entry) {
      // Instant (non-smooth) so the chip is at its final position
      // before click() reads getBoundingClientRect.
      entry.scrollIntoView({ block: "center", behavior: "auto" });
      entry.click();
      return;
    }
    // Fallback — no chip matched, center the menu on the calendar.
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    cal.openMenu({
      heading,
      content: `${commit.authorName} · ${commit.filesChanged} file${commit.filesChanged === 1 ? "" : "s"} · +${commit.additions} -${commit.deletions}`,
      time: {
        start: { hour: d.getHours(), minute: d.getMinutes() },
        end: { hour: d.getHours(), minute: (d.getMinutes() + 5) % 60 },
      },
      displayTime: `${hh}:${mm}`,
      date,
      anchorRect: cal.getBoundingClientRect(),
    });
    this.menuOpen = true;
  }

  private findEntryByHeading(cal: KalendusAPI, heading: string): HTMLElement | undefined {
    const entryNodes = cal.shadowRoot?.querySelectorAll<HTMLElement>("lms-calendar-entry");
    let match: HTMLElement | undefined;
    entryNodes?.forEach((node) => {
      if ((node as unknown as { heading?: string }).heading === heading) match = node;
    });
    return match;
  }

  private onOpenMenu = (e: Event) => {
    const detail = (e as CustomEvent<{ heading?: string }>).detail;
    const heading = detail?.heading ?? "";
    const shortSha = keyFor(heading);
    if (!shortSha) return;
    const commit = this.commits.find((c) => c.shortSha === shortSha);
    if (!commit) return;
    // Arm but don't navigate — user explicitly hits "view commit"
    // in the action bar to drill in. Kalendus's own detail popup
    // still opens from the click for quick reading.
    this.armedCommit = commit;
    this.menuOpen = true;
    // Let the parent know so it can sync calendarArmedSha — the
    // sidebar commit row for this SHA then gets .armed highlighting
    // and both surfaces stay in sync (calendar click → sidebar
    // highlights; sidebar click → calendar reveals). Idempotent:
    // if parent already has this SHA armed (sidebar-driven path),
    // the re-assignment is a no-op identity match.
    this.dispatchEvent(
      new CustomEvent("gc:arm-commit", {
        bubbles: true,
        composed: true,
        detail: { sha: commit.sha },
      }),
    );
  };

  private onMenuClose = () => {
    this.menuOpen = false;
  };

  private viewArmedCommit() {
    if (!this.armedCommit) return;
    this.dispatchEvent(
      new CustomEvent("gc:select-commit", {
        bubbles: true,
        composed: true,
        detail: { sha: this.armedCommit.sha },
      }),
    );
  }

  override render() {
    // The kalendus heading area doubles as our progress indicator —
    // while batches stream in we show the current commit count; once
    // done, clear so the built-in view header ("Apr 2026" etc.) reads
    // unobstructed. Keeps the indicator visible without adding chrome
    // or colliding with kalendus's own « » Today nav.
    const heading = this.loading
      ? `loading ${this.loadedCount} commits…`
      : this.loadedCount > 0
        ? `${this.loadedCount} commits`
        : "";
    return html`
      <lms-calendar
        .heading=${heading}
        .entries=${this.entries}
        .activeDate=${this.activeDate}
        .yearDensityMode=${"heatmap"}
        .yearDrillTarget=${"day"}
        color="var(--accent-user, #3b82f6)"
        @open-menu=${this.onOpenMenu}
        @menu-close=${this.onMenuClose}
      ></lms-calendar>
      ${this.armedCommit && !this.menuOpen
        ? html`<div class="action-bar" role="region" aria-label="Selected commit">
            <span class="action-sha">${this.armedCommit.shortSha}</span>
            <span class="action-msg">${this.armedCommit.message}</span>
            <button
              class="action-btn"
              @click=${() => this.viewArmedCommit()}
              aria-label="View commit diff"
            >
              view commit →
            </button>
          </div>`
        : nothing}
    `;
  }

  // Flat token-driven styling — no kalendus theme file. We let
  // kalendus render with its unstyled base (which uses CSS system
  // colors / `color: inherit`) and override the tokens we care
  // about directly with app design vars. That way the calendar
  // automatically follows whatever theme the app is on (dark or
  // light) without importing or fighting a theme sheet.
  static override styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
      box-sizing: border-box;
      background: var(--surface-1);
      color: var(--text);
      position: relative;
      /* Local default; the calendar's entries read this via the
         CalendarEntry.color string the wrapper sets. Exposing it
         as a single var lets callers or a future theme re-tune
         commit chip color from one place. */
      --commit-color: var(--accent-user);
    }
    /* Floating action bar at the bottom of the calendar, shown
       when the user clicks a commit entry. Mirrors code-city's
       detail-panel → "View File" pattern: click opens kalendus's
       tooltip for info, dedicated button drills into the diff. */
    .action-bar {
      position: absolute;
      left: 50%;
      bottom: var(--space-4);
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: var(--space-3);
      max-width: calc(100% - var(--space-8));
      padding: var(--space-2) var(--space-3);
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-dropdown);
      font-size: var(--text-xs);
      z-index: 20;
    }
    .action-sha {
      color: var(--accent-user);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .action-msg {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 380px;
      opacity: 0.85;
    }
    .action-btn {
      background: var(--accent-user);
      color: var(--surface-0);
      border: none;
      border-radius: var(--radius-sm);
      padding: 4px var(--space-3);
      font-family: inherit;
      font-size: var(--text-xs);
      font-weight: 500;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity 0.12s ease;
    }
    .action-btn:hover {
      opacity: 0.85;
    }
    lms-calendar {
      flex: 1;
      min-height: 0;
      min-width: 0;
      color: var(--text);
      /* Crops the outer 1px border drawn by kalendus on its
         .calendar-container (inside the shadow root) — that border
         uses --separator-light, which we can't transparent-out
         without losing internal hairlines. clip-path crops final
         pixels including shadow DOM, no stacking context side
         effects. */
      clip-path: inset(1px);

      /* ── Palette ─────────────────────────────────────────── */
      --background-color: var(--surface-1);
      --context-bg: var(--surface-0);
      --primary-color: var(--accent-user);
      --header-text-color: var(--text-muted);
      --separator-light: var(--surface-4);
      --separator-mid: var(--border-default);
      /* Despite the name, kalendus uses --separator-dark for primary
         text color in several views (commit-row text in month view,
         hour labels). Its default fallback is rgba(0,0,0,0.7), which
         is invisible against our dark surface. */
      --separator-dark: var(--text);
      --hover-bg: var(--surface-2);
      --hover-color: var(--text);
      --focus-bg: var(--surface-3);
      --cw-hover-bg: var(--surface-2);
      --cw-hover-color: var(--text);
      --year-month-label-hover-color: var(--text);
      --year-cw-color: var(--text-muted);
      --hour-indicator-color: var(--text-muted);
      --entry-month-text-color: var(--text);
      --entry-handle-color: var(--accent-user);
      --context-text-color: var(--text);

      /* ── Today accent ────────────────────────────────────── */
      --current-day-bg: var(--accent-user);
      --current-day-color: var(--surface-0);
      --current-dot-bg: var(--accent-user);
      --current-day-hover-opacity: 0.85;
      --current-day-font-weight: 600;

      /* ── Year heatmap ─────────────────────────────────────
         Four intensity levels sit atop --surface-1. color-mix
         lets the tint re-adapt automatically when the theme's
         accent changes. --year-heatmap-4-text must contrast
         with a solid-accent cell; --surface-0 is always the
         opposite end of the surface scale from --accent-user,
         so it inverts cleanly per theme without a media query. */
      --year-heatmap-1: color-mix(in srgb, var(--accent-user) 18%, transparent);
      --year-heatmap-2: color-mix(in srgb, var(--accent-user) 38%, transparent);
      --year-heatmap-3: color-mix(in srgb, var(--accent-user) 62%, transparent);
      --year-heatmap-4: var(--accent-user);
      --year-heatmap-4-text: var(--surface-0);

      /* ── Entries (commit chips) ──────────────────────────── */
      --entry-background-color: var(--surface-2);
      --entry-color: var(--text);
      --entry-highlight-color: var(--surface-3);
      --entry-border-radius: var(--radius-sm);
      --entry-title-weight: 500;
      --entry-time-opacity: 0.55;
      --indicator-color: var(--accent-user);
      --indicator-font-weight: 600;

      /* ── Typography — inherit app mono font for SHAs ─────── */
      --system-ui: ui-monospace, "JetBrains Mono", Menlo, monospace;
      --monospace-ui: ui-monospace, "JetBrains Mono", Menlo, monospace;
      --day-label-font-weight: 500;
      --day-label-number-font-weight: 600;
      --month-label-font-weight: 600;
      --year-weekday-font-weight: 500;
      --menu-item-font-weight: 500;
      --menu-title-font-weight: 600;
      --title-column-weight: 500;

      /* ── Radii — match app's flat style ──────────────────── */
      --border-radius-sm: var(--radius-sm);
      --border-radius-md: var(--radius-md);
      --border-radius-lg: var(--radius-lg);
      /* Kalendus's outermost wrapper reads --calendar-border-radius
         with a fallback of --border-radius-lg. Pin it to 0 so the
         outer edge is rectangular regardless of what the lg radius
         is set to — inner pills and indicators keep their own radii. */
      --calendar-border-radius: 0;
      --month-indicator-border-radius: var(--radius-sm);
      --year-day-cell-border-radius: var(--radius-sm);
      --float-text-border-radius: var(--radius-sm);

      /* ── Shadows — flat; rely on borders/surfaces for depth ── */
      --shadow-sm: none;
      --shadow-md: none;
      --shadow-lg: none;
      --shadow-hv: none;
      --active-indicator-shadow: none;
      --float-text-shadow: none;

      /* Active pill (Day/Week/Month/Year, « » Today): subtle
         surface lift, no shadow — matches the app's flat style. */
      --active-indicator-bg: var(--surface-3);

      /* Peek day cells (drill targets): no separate background,
         just a slightly lifted surface. */
      --peek-active-bg: var(--surface-3);

      /* Floating text chip (tooltips etc.): plain surface. */
      --float-text-bg: var(--surface-2);

      /* Context menu (entry detail popup): plain surface + our
         app border, so it reads as a native card. */
      --context-bg: var(--surface-0);

      --transition-speed: 0.12s;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-commit-calendar": GcCommitCalendar;
  }
}
