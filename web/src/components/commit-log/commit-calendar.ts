import { LitElement, html, css, unsafeCSS } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "@jpahd/kalendus";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — vite raw import gives us the theme CSS as a string.
import kalendusTheme from "@jpahd/kalendus/themes/midnight.css?raw";
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
    color: "#818cf8",
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

  @state() private entries: CalendarEntry[] = [];
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
    this.dispatchEvent(
      new CustomEvent("gc:select-commit", {
        bubbles: true,
        composed: true,
        detail: { sha: commit.sha },
      }),
    );
  };

  override render() {
    return html`
      <lms-calendar
        heading="commits"
        .entries=${this.entries}
        yearDensityMode="heatmap"
        yearDrillTarget="day"
        color="var(--accent-user, #3b82f6)"
        @open-menu=${this.onOpenMenu}
      ></lms-calendar>
    `;
  }

  static override styles = [
    // Kalendus ships its theme targeting `lms-calendar { … }`. Custom
    // properties inherit across shadow boundaries, but the selector
    // itself doesn't pierce — so the theme sheet must live inside
    // this wrapper's shadow root for the child <lms-calendar> to pick
    // up its design tokens. `?raw` pulls the CSS in as text; vite
    // tree-shakes the original file since nothing else imports it.
    unsafeCSS(kalendusTheme),
    css`
      :host {
        display: flex;
        flex: 1;
        min-height: 0;
        min-width: 0;
        padding: var(--space-3);
        box-sizing: border-box;
        background: var(--surface-1);
      }
      /* The midnight theme already provides a full dark palette —
         we only tweak the background to match our app surface
         and the accent to our app accent, so the calendar reads
         as a native part of git-chat rather than a third-party
         widget. Everything else (text color, borders, shadows)
         comes from the theme unchanged. */
      lms-calendar {
        flex: 1;
        min-height: 0;
        min-width: 0;
        --background-color: var(--surface-1);
        --primary-color: var(--accent-user, #818cf8);
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-commit-calendar": GcCommitCalendar;
  }
}
