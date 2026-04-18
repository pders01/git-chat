import { LitElement, html, css, unsafeCSS } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "@jpahd/kalendus";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — vite raw import gives us the theme CSS as a string.
import kalendusTheme from "@jpahd/kalendus/themes/default.css?raw";
import type { CommitEntry } from "../../gen/gitchat/v1/repo_pb.js";

// commitEntryToCalendar maps one CommitEntry → one CalendarEntry.
// author_time is unix seconds; we convert to a local Date and derive
// the CalendarDate + CalendarTime shape kalendus expects. Commits
// are instantaneous, but kalendus requires a non-zero time range —
// we give each a 15-minute slot so week-view chips are legible
// without overwhelming the grid.
function commitToEntry(c: CommitEntry): CalendarEntry {
  const d = new Date(Number(c.authorTime) * 1000);
  const startMin = d.getMinutes();
  const endMin = startMin + 15;
  const endHour = d.getHours() + Math.floor(endMin / 60);
  return {
    date: {
      start: { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() },
      end: { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() },
    },
    time: {
      start: { hour: d.getHours(), minute: startMin },
      end: { hour: endHour % 24, minute: endMin % 60 },
    },
    heading: `${c.shortSha} ${c.message}`,
    content:
      `${c.authorName} · ${c.filesChanged} file${c.filesChanged === 1 ? "" : "s"} · +${c.additions} -${c.deletions}\n\n${c.body || ""}`.trim(),
    color: "var(--accent-user, #3b82f6)",
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

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("commits")) {
      this.entries = this.commits.map(commitToEntry);
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
        padding: var(--space-4);
        box-sizing: border-box;
        background: var(--surface-1);
        color: var(--text);
      }
      lms-calendar {
        flex: 1;
        min-height: 0;
        min-width: 0;
        --background-color: var(--surface-1);
        --primary-color: var(--accent-user, #3b82f6);
        --header-text-color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-commit-calendar": GcCommitCalendar;
  }
}
