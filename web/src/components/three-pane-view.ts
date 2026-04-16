import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { parseUnifiedDiff, type ParsedDiff } from "../lib/diff-parse.js";
import "./loading-indicator.js";

// Lazy-load highlight — same lazy pattern other views use.
let highlightModule: Promise<typeof import("../lib/highlight.js")> | null = null;
function loadHighlight() {
  if (!highlightModule) highlightModule = import("../lib/highlight.js");
  return highlightModule;
}

/**
 * Three-pane diff view: old file | unified diff | new file. The three
 * columns scroll in line-matched lockstep — scrolling one projects the
 * top-visible line through the parsed diff's old↔new↔diff maps and
 * drives the other two.
 *
 * The component takes all three texts as properties so the caller can
 * fetch them however it prefers (file-view caches, getFile, etc.) and
 * doesn't need to care about the internal highlighting or parsing.
 */
@customElement("gc-three-pane-view")
export class GcThreePaneView extends LitElement {
  @property({ type: String }) leftText = "";
  @property({ type: String }) rightText = "";
  @property({ type: String }) rawDiff = "";
  /** Shiki language id; used for left and right panes. Middle is always "diff". */
  @property({ type: String }) language = "plaintext";
  /** Shown above each pane for context. Purely cosmetic. */
  @property({ type: String }) leftLabel = "before";
  @property({ type: String }) rightLabel = "after";

  @state() private leftHtml = "";
  @state() private rightHtml = "";
  @state() private middleLines: { text: string; kind: string }[] = [];
  @state() private ready = false;

  private parsed: ParsedDiff | null = null;
  // Sorted-keys projections of parsed.{oldToNew,newToOld,oldToDiff,newToDiff}.
  // Rebuilt only when rawDiff changes, queried via binary search on every
  // scroll event. Previously each scroll walked every map linearly.
  private parsedIndex: {
    oldToNew: SortedIndex;
    newToOld: SortedIndex;
    oldToDiff: SortedIndex;
    newToDiff: SortedIndex;
  } | null = null;
  // Cached pixel line-heights, measured once per render so we don't
  // read layout on every scroll event.
  private leftLineHeight = 0;
  private rightLineHeight = 0;
  private middleLineHeight = 0;

  // Guard against infinite scroll-sync loops: setting scrollTop on a
  // pane fires a scroll event. Chromium/Firefox dispatch it
  // synchronously from the assignment, so syncSource (set to the driving
  // pane) keeps the re-entrant call from re-entering the handler.
  // Safari, however, batches scrollTop writes until the next paint —
  // the re-entrant scroll arrives *after* we've released the guard on
  // rAF. We now count pending programmatic writes and only release
  // syncSource when each target has been observed back, eliminating the
  // ping-pong window entirely.
  private syncSource: "left" | "middle" | "right" | null = null;
  private pendingSyncAcks = 0;

  override updated(changed: Map<string, unknown>) {
    if (changed.has("rawDiff")) {
      this.parsed = parseUnifiedDiff(this.rawDiff);
      this.parsedIndex = {
        oldToNew: buildSortedIndex(this.parsed.oldToNew),
        newToOld: buildSortedIndex(this.parsed.newToOld),
        oldToDiff: buildSortedIndex(this.parsed.oldToDiff),
        newToDiff: buildSortedIndex(this.parsed.newToDiff),
      };
      this.middleLines = this.parsed.lines.map((l) => ({ text: l.text, kind: l.kind }));
    }
    if (
      changed.has("leftText") ||
      changed.has("rightText") ||
      changed.has("rawDiff") ||
      changed.has("language")
    ) {
      void this.rebuild();
    }
  }

  private async rebuild() {
    this.ready = false;
    const { highlight } = await loadHighlight();
    const [leftHtml, rightHtml] = await Promise.all([
      this.leftText ? highlight(this.leftText, this.language) : Promise.resolve(""),
      this.rightText ? highlight(this.rightText, this.language) : Promise.resolve(""),
    ]);
    this.leftHtml = leftHtml;
    this.rightHtml = rightHtml;
    this.ready = true;
    // Measure line heights on the next frame once the new HTML is
    // painted. Assumes monospace so every line has the same height.
    requestAnimationFrame(() => this.measureLineHeights());
  }

  private measureLineHeights() {
    const left = this.renderRoot.querySelector<HTMLElement>(".pane-left .line");
    const right = this.renderRoot.querySelector<HTMLElement>(".pane-right .line");
    const middle = this.renderRoot.querySelector<HTMLElement>(".pane-middle .diff-line");
    if (left) this.leftLineHeight = left.offsetHeight || 20;
    if (right) this.rightLineHeight = right.offsetHeight || 20;
    if (middle) this.middleLineHeight = middle.offsetHeight || 20;
  }

  private onScroll(source: "left" | "middle" | "right", e: Event) {
    if (!this.parsed || !this.ready) return;

    // If a sync is in flight, this is an ack for a programmatic scroll.
    // Count it off and bail before we re-project — re-entry from the
    // same pane that just received the write is how Safari's
    // out-of-paint scroll delivery used to start a ping-pong.
    if (this.syncSource !== null) {
      if (this.syncSource !== source && this.pendingSyncAcks > 0) {
        this.pendingSyncAcks--;
        if (this.pendingSyncAcks <= 0) this.syncSource = null;
      }
      return;
    }

    const el = e.currentTarget as HTMLElement;
    const scrollTop = el.scrollTop;
    const lh =
      source === "left"
        ? this.leftLineHeight
        : source === "middle"
          ? this.middleLineHeight
          : this.rightLineHeight;
    if (lh <= 0) return;

    const topLine = Math.max(0, Math.round(scrollTop / lh));

    // Project the top-visible line in the driver pane to the other two.
    let targetOld: number | null = null;
    let targetNew: number | null = null;
    let targetDiffIdx: number | null = null;

    const idx = this.parsedIndex;
    if (source === "left") {
      targetOld = topLine + 1;
      targetNew =
        this.parsed.oldToNew.get(targetOld) ??
        (idx ? (nearestFrom(idx.oldToNew, targetOld) ?? null) : null);
      targetDiffIdx =
        this.parsed.oldToDiff.get(targetOld) ??
        (idx ? (nearestFrom(idx.oldToDiff, targetOld) ?? null) : null);
    } else if (source === "right") {
      targetNew = topLine + 1;
      targetOld =
        this.parsed.newToOld.get(targetNew) ??
        (idx ? (nearestFrom(idx.newToOld, targetNew) ?? null) : null);
      targetDiffIdx =
        this.parsed.newToDiff.get(targetNew) ??
        (idx ? (nearestFrom(idx.newToDiff, targetNew) ?? null) : null);
    } else {
      targetDiffIdx = topLine;
      const line = this.parsed.lines[topLine];
      if (line) {
        targetOld = line.oldLine ?? null;
        targetNew = line.newLine ?? null;
      }
    }

    const leftEl = this.renderRoot.querySelector<HTMLElement>(".pane-left");
    const rightEl = this.renderRoot.querySelector<HTMLElement>(".pane-right");
    const middleEl = this.renderRoot.querySelector<HTMLElement>(".pane-middle");

    // Stage the guard BEFORE any scrollTop writes so Safari's later
    // scroll dispatch sees syncSource set.
    const writes: Array<() => void> = [];
    const planWrite = (el: HTMLElement, top: number) => {
      // Skip no-op writes so we don't count a scroll event that
      // won't actually fire.
      if (Math.round(el.scrollTop) === Math.round(top)) return;
      writes.push(() => {
        el.scrollTop = top;
      });
    };
    if (source !== "left" && leftEl && targetOld != null && this.leftLineHeight > 0) {
      planWrite(leftEl, Math.max(0, (targetOld - 1) * this.leftLineHeight));
    }
    if (source !== "right" && rightEl && targetNew != null && this.rightLineHeight > 0) {
      planWrite(rightEl, Math.max(0, (targetNew - 1) * this.rightLineHeight));
    }
    if (source !== "middle" && middleEl && targetDiffIdx != null && this.middleLineHeight > 0) {
      planWrite(middleEl, Math.max(0, targetDiffIdx * this.middleLineHeight));
    }

    if (writes.length === 0) return;
    this.syncSource = source;
    this.pendingSyncAcks = writes.length;
    for (const w of writes) w();

    // Safety net: if a write somehow doesn't generate a scroll event
    // (e.g. the element was detached between plan and write), release
    // the guard on the next macrotask so user scrolls aren't blocked.
    setTimeout(() => {
      if (this.syncSource === source) {
        this.syncSource = null;
        this.pendingSyncAcks = 0;
      }
    }, 0);
  }

  override render() {
    if (!this.ready) {
      return html`<gc-loading-banner heading="preparing 3-pane view…"></gc-loading-banner>`;
    }
    return html`
      <div class="grid">
        <header class="lbl lbl-left">${this.leftLabel}</header>
        <header class="lbl lbl-middle">changes</header>
        <header class="lbl lbl-right">${this.rightLabel}</header>

        <div class="pane pane-left" @scroll=${(e: Event) => this.onScroll("left", e)}>
          ${this.leftHtml ? unsafeHTML(this.leftHtml) : html`<pre class="empty">(empty)</pre>`}
        </div>

        <div class="pane pane-middle" @scroll=${(e: Event) => this.onScroll("middle", e)}>
          ${this.middleLines.length === 0
            ? html`<pre class="empty">(no changes)</pre>`
            : this.middleLines.map(
                (l) => html`<div class="diff-line ${l.kind}">${l.text || "\u00a0"}</div>`,
              )}
        </div>

        <div class="pane pane-right" @scroll=${(e: Event) => this.onScroll("right", e)}>
          ${this.rightHtml ? unsafeHTML(this.rightHtml) : html`<pre class="empty">(empty)</pre>`}
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1.2fr 1fr;
      grid-template-rows: auto 1fr;
      height: 100%;
      gap: 1px;
      background: var(--border-default);
    }
    .lbl {
      background: var(--surface-1);
      padding: var(--space-1) var(--space-3);
      font-size: var(--text-xs);
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-default);
    }
    .pane {
      background: var(--surface-1);
      overflow: auto;
      min-height: 0;
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 0.8rem;
      line-height: 1.45;
    }
    .pane-middle {
      padding: 0;
    }
    .pane-left,
    .pane-right {
      padding: var(--space-2);
    }
    .pane pre {
      margin: 0;
      padding: 0;
      background: transparent !important;
    }
    .pane .empty {
      color: var(--text-muted);
      padding: var(--space-4);
    }
    .diff-line {
      white-space: pre;
      padding: 0 var(--space-3);
      min-height: 1.45em;
    }
    .diff-line.addition {
      background: color-mix(in srgb, var(--success, #2ea043) 18%, transparent);
      color: var(--text);
    }
    .diff-line.deletion {
      background: color-mix(in srgb, var(--danger, #f85149) 18%, transparent);
      color: var(--text);
    }
    .diff-line.header {
      color: var(--text-muted);
      opacity: 0.7;
    }
  `;
}

// A sorted-keys projection over a Map<number, number>. Built once per
// diff parse; reused by every scroll event for O(log n) neighbour lookup
// instead of the original O(n) Map iteration that ran on every tick.
interface SortedIndex {
  keys: number[];
  values: number[];
}

function buildSortedIndex(map: Map<number, number>): SortedIndex {
  const keys = [...map.keys()].sort((a, b) => a - b);
  const values = keys.map((k) => map.get(k)!);
  return { keys, values };
}

// nearestFrom returns the value for the largest key in the index that
// is <= the target. O(log n). Returns undefined if every key > target.
function nearestFrom(idx: SortedIndex, key: number): number | undefined {
  const { keys, values } = idx;
  if (keys.length === 0 || key < keys[0]) return undefined;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    // Ceil mid so lo advances when keys[mid] <= key.
    const mid = (lo + hi + 1) >>> 1;
    if (keys[mid] <= key) lo = mid;
    else hi = mid - 1;
  }
  return values[lo];
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-three-pane-view": GcThreePaneView;
  }
}
