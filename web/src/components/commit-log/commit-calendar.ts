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

@customElement("gc-commit-calendar")
export class GcCommitCalendar extends LitElement {
  @property({ type: Array }) commits: CommitEntry[] = [];
  @property({ type: Number }) loadedCount = 0;
  @property({ type: Boolean }) loading = false;

  @state() private entries: CalendarEntry[] = [];
  // The commit the user clicked on most recently in the calendar.
  // Kalendus opens its own detail tooltip on entry click — we hold
  // the SHA here so a companion "View commit" button can navigate
  // on explicit button press, consistent with code-city's
  // building-click → detail panel → "View File" action flow.
  @state() private armedCommit: CommitEntry | null = null;
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
        return;
      }
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
        .yearDensityMode=${"heatmap"}
        .yearDrillTarget=${"day"}
        color="var(--accent-user, #3b82f6)"
        @open-menu=${this.onOpenMenu}
      ></lms-calendar>
      ${this.armedCommit
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
            <button
              class="action-close"
              @click=${() => (this.armedCommit = null)}
              aria-label="Dismiss"
              title="Dismiss"
            >
              ×
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
    .action-close {
      background: transparent;
      color: var(--text-muted);
      border: none;
      padding: 0 var(--space-1);
      font-size: var(--text-sm);
      cursor: pointer;
      opacity: 0.6;
    }
    .action-close:hover {
      opacity: 1;
    }
    lms-calendar {
      flex: 1;
      min-height: 0;
      min-width: 0;
      color: var(--text);
      /* Outer edges stay rectangular so the calendar butts up
         against the sidebar's vertical rule without a visible
         seam or corner halo — matches the rest of git-chat's
         pane-against-pane flat layout. Inner pills/cells keep
         their small radii (set via --border-radius-* tokens). */
      border-radius: 0;

      /* ── Palette ─────────────────────────────────────────── */
      --background-color: var(--surface-1);
      --context-bg: var(--surface-0);
      --primary-color: var(--accent-user);
      --header-text-color: var(--text-muted);
      /* Kalendus's outer container + many inner hairlines use
         --separator-light for their border colour. We want the
         outer edge invisible so it butts flush against the
         sidebar's own border-right. Transparent here drops ALL
         hairlines — in exchange git-chat's flat pane-against-
         pane look reads coherently. --separator-mid stays
         available for the spots that truly need a visible rule. */
      --separator-light: transparent;
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
