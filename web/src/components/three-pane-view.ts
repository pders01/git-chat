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

/** Unchanged context lines shown around each hunk before collapsing. */
const CONTEXT_AROUND_HUNK = 3;

// One row in the unified split-view. Every row is rendered in all
// three columns (left / middle / right) with identical height, so the
// outer scroll container drives all three in lockstep without any
// JS-level sync.
//
//   - context    : line exists in both files → left=oldText, right=newText
//   - deletion   : line only in old          → left=oldText, right=spacer
//   - addition   : line only in new          → left=spacer,  right=newText
//
// `collapsed` rows are unchanged context far from any hunk. They
// render with transparent text to hide the noise but keep their
// vertical space so the hunk rows stay anchored to their real file-y
// positions on both sides.
interface Row {
  kind: "context" | "deletion" | "addition";
  oldLine: number | null;
  newLine: number | null;
  leftHtml: string; // pre-rendered HTML (Shiki inner) or "" for spacer
  rightHtml: string;
  middleText: string; // " " / "-" / "+" prefix + raw text
  collapsed: boolean;
}

/**
 * Three-pane diff view, rendered as a single scrollable grid:
 *
 *     before  |  changes  |  after
 *     -------+-----------+-------
 *      line    <diff>       line
 *      line    <diff>       line
 *      ...
 *
 * Every logical row exists in all three columns (with spacers on the
 * side that doesn't have that line), so the whole thing scrolls as one
 * element — no per-pane scroll events, no sync math, no jank.
 */
@customElement("gc-three-pane-view")
export class GcThreePaneView extends LitElement {
  @property({ type: String }) leftText = "";
  @property({ type: String }) rightText = "";
  @property({ type: String }) rawDiff = "";
  /** Shiki language id; used for left and right panes. */
  @property({ type: String }) language = "plaintext";
  @property({ type: String }) leftLabel = "before";
  @property({ type: String }) rightLabel = "after";

  @state() private rows: Row[] = [];
  @state() private ready = false;

  private parsed: ParsedDiff | null = null;

  override updated(changed: Map<string, unknown>) {
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
    this.parsed = parseUnifiedDiff(this.rawDiff);

    // Highlight both sides in parallel.
    const { highlight } = await loadHighlight();
    const [leftFullHtml, rightFullHtml] = await Promise.all([
      this.leftText ? highlight(this.leftText, this.language) : Promise.resolve(""),
      this.rightText ? highlight(this.rightText, this.language) : Promise.resolve(""),
    ]);

    // Split the highlighted output into per-line HTML strings so we
    // can render each file line inside our own row wrappers (needed
    // because left and right must share a row grid with the middle
    // for single-scroll sync).
    const leftShikiLines = extractShikiLines(leftFullHtml);
    const rightShikiLines = extractShikiLines(rightFullHtml);

    this.rows = this.buildRows(leftShikiLines, rightShikiLines);
    this.ready = true;

    // Scroll to the first hunk so the user lands on the change, not on
    // hundreds of lines of collapsed context above it. rAF waits for
    // the rows to actually be in the DOM after ready=true triggers a
    // re-render.
    requestAnimationFrame(() => this.scrollToFirstHunk());
  }

  private scrollToFirstHunk() {
    const firstHunkIdx = this.rows.findIndex((r) => !r.collapsed);
    if (firstHunkIdx < 0) return;
    const scrollArea = this.renderRoot.querySelector<HTMLElement>(".scroll-area");
    if (!scrollArea) return;
    const row = this.renderRoot.querySelector<HTMLElement>(
      `.col-middle .row:nth-child(${firstHunkIdx + 1})`,
    );
    if (!row) return;
    // Use bounding-rect deltas instead of offsetTop: offsetTop is
    // relative to the nearest *positioned* ancestor, which shifts if
    // any wrapping element ever gets position:relative (e.g. to anchor
    // a sticky header). getBoundingClientRect gives the same viewport
    // coordinates regardless.
    const rowRect = row.getBoundingClientRect();
    const areaRect = scrollArea.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(scrollArea).lineHeight) || 20;
    const target = rowRect.top - areaRect.top + scrollArea.scrollTop;
    scrollArea.scrollTop = Math.max(0, target - lineHeight * CONTEXT_AROUND_HUNK);
  }

  private buildRows(leftShikiLines: string[], rightShikiLines: string[]): Row[] {
    if (!this.parsed) return [];

    const leftLines = splitLines(this.leftText);
    const rightLines = splitLines(this.rightText);

    // Pair hunk lines into row shapes. Walk parsed.lines and produce
    // a structure that says which old or new line each row uses, and
    // whether the OTHER side is an empty spacer. For context lines
    // that fall outside any hunk, we'll emit rows ourselves when
    // filling between hunks.
    const rows: Row[] = [];

    const pushContext = (oldLine: number, newLine: number, collapsed: boolean) => {
      rows.push({
        kind: "context",
        oldLine,
        newLine,
        leftHtml: leftShikiLines[oldLine - 1] ?? "",
        rightHtml: rightShikiLines[newLine - 1] ?? "",
        middleText: " " + (leftLines[oldLine - 1] ?? ""),
        collapsed,
      });
    };

    const pushDeletion = (oldLine: number) => {
      rows.push({
        kind: "deletion",
        oldLine,
        newLine: null,
        leftHtml: leftShikiLines[oldLine - 1] ?? "",
        rightHtml: "",
        middleText: "-" + (leftLines[oldLine - 1] ?? ""),
        collapsed: false,
      });
    };

    const pushAddition = (newLine: number) => {
      rows.push({
        kind: "addition",
        oldLine: null,
        newLine,
        leftHtml: "",
        rightHtml: rightShikiLines[newLine - 1] ?? "",
        middleText: "+" + (rightLines[newLine - 1] ?? ""),
        collapsed: false,
      });
    };

    // Walk the parsed diff, keeping track of where we are in the old
    // file. For each hunk line, fill unchanged context before it from
    // leftText/rightText, then emit the hunk line itself.
    let oldPos = 1;
    let newPos = 1;

    const hunkOldLines = new Set<number>();
    for (const l of this.parsed.lines) {
      if (l.oldLine != null) hunkOldLines.add(l.oldLine);
    }
    const isNearHunk = (oldLine: number) => {
      for (let k = -CONTEXT_AROUND_HUNK; k <= CONTEXT_AROUND_HUNK; k++) {
        if (hunkOldLines.has(oldLine + k)) return true;
      }
      return false;
    };

    for (const pl of this.parsed.lines) {
      if (pl.kind === "header") continue;
      if (pl.oldLine != null) {
        // Catch up with unchanged context from both files.
        while (oldPos < pl.oldLine) {
          const collapsed = !isNearHunk(oldPos);
          pushContext(oldPos, newPos, collapsed);
          oldPos++;
          newPos++;
        }
        if (pl.kind === "deletion") {
          pushDeletion(pl.oldLine);
          oldPos = pl.oldLine + 1;
        } else {
          // context inside a hunk
          pushContext(pl.oldLine, pl.newLine ?? newPos, false);
          oldPos = pl.oldLine + 1;
          if (pl.newLine != null) newPos = pl.newLine + 1;
        }
      } else if (pl.newLine != null) {
        pushAddition(pl.newLine);
        newPos = pl.newLine + 1;
      }
    }
    // Trailing content past the last hunk. Three cases:
    //  - both sides have the same tail → emit context rows pairing them
    //  - new file has extra lines (pure-addition tail) → emit addition rows
    //  - old file has extra lines (pure-deletion tail) → emit deletion rows
    // Each branch advances exactly one or both counters so the loop
    // always terminates.
    while (oldPos <= leftLines.length && newPos <= rightLines.length) {
      const collapsed = !isNearHunk(oldPos);
      pushContext(oldPos, newPos, collapsed);
      oldPos++;
      newPos++;
    }
    while (newPos <= rightLines.length) {
      pushAddition(newPos);
      newPos++;
    }
    while (oldPos <= leftLines.length) {
      pushDeletion(oldPos);
      oldPos++;
    }

    return rows;
  }

  override render() {
    if (!this.ready) {
      return html`<gc-loading-banner heading="preparing 3-pane view…"></gc-loading-banner>`;
    }
    if (this.rows.length === 0) {
      return html`<div class="empty">(no changes)</div>`;
    }
    return html`
      <div class="scroll-area">
        <div class="grid">
          <header class="hdr hdr-left">${this.leftLabel}</header>
          <header class="hdr hdr-middle">changes</header>
          <header class="hdr hdr-right">${this.rightLabel}</header>

          <div class="col col-left">
            ${this.rows.map(
              (r) => html`<div class="row ${r.kind} ${r.collapsed ? "collapsed" : ""}">
                <span class="num">${r.oldLine ?? ""}</span>
                <span class="code"
                  >${r.leftHtml
                    ? unsafeHTML(r.leftHtml)
                    : html`<span class="spacer"> </span>`}</span
                >
              </div>`,
            )}
          </div>

          <div class="col col-middle">
            ${this.rows.map(
              (r) => html`<div class="row ${r.kind} ${r.collapsed ? "collapsed" : ""}">
                <span class="num">${r.oldLine ?? ""}</span>
                <span class="num num-new">${r.newLine ?? ""}</span>
                <span class="code">${r.middleText || "\u00a0"}</span>
              </div>`,
            )}
          </div>

          <div class="col col-right">
            ${this.rows.map(
              (r) => html`<div class="row ${r.kind} ${r.collapsed ? "collapsed" : ""}">
                <span class="num">${r.newLine ?? ""}</span>
                <span class="code"
                  >${r.rightHtml
                    ? unsafeHTML(r.rightHtml)
                    : html`<span class="spacer"> </span>`}</span
                >
              </div>`,
            )}
          </div>
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
    .scroll-area {
      height: 100%;
      overflow: auto;
      background: var(--surface-1);
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 0.8rem;
      line-height: 1.45;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1.2fr 1fr;
      /* Let rows auto-size to content. Cols then have an intrinsic
         height equal to total content height, which lets us turn on
         per-col overflow-x: auto without browsers silently forcing
         overflow-y: auto (which would create nested vertical scrolls
         inside the outer single-scroll container). */
      min-height: 100%;
      gap: 0 1px;
      background: var(--border-default);
    }
    .hdr {
      background: var(--surface-1);
      padding: var(--space-1) var(--space-3);
      font-size: var(--text-xs);
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-default);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .col {
      background: var(--surface-1);
      min-width: 0;
      /* Per-column horizontal scroll when a line is wider than the
         column. overflow-y stays hidden (content height == col height,
         so no clipping) to keep the outer scroll-area as the sole
         vertical scroller. scrollbar-gutter: stable reserves the
         scrollbar row height even when horizontal scroll isn't
         active, so cols without long lines stay row-aligned with
         cols that do. */
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-gutter: stable;
    }
    .row {
      display: grid;
      grid-template-columns: 3.5em 1fr;
      column-gap: var(--space-2);
      white-space: pre;
      min-height: 1.45em;
      padding-right: var(--space-2);
      /* Let the row extend wider than the column when a code line
         overflows. min-width: min-content asks the row to be at least
         as wide as its content's natural min-width (which, with
         white-space: pre, is the full line width). The col's
         overflow-x: auto then picks up that overflow and lets the
         user scroll horizontally. */
      min-width: min-content;
    }
    .col-middle .row {
      grid-template-columns: 3.5em 3.5em 1fr;
    }
    .row .num {
      color: var(--text-muted);
      text-align: right;
      padding: 0 var(--space-1);
      background: color-mix(in srgb, var(--surface-1) 100%, var(--border-default) 40%);
      user-select: none;
      font-variant-numeric: tabular-nums;
      /* Keep line numbers pinned to the left while the row scrolls
         horizontally — otherwise they drift off-screen when a long
         line is scrolled into view. */
      position: sticky;
      left: 0;
      z-index: 1;
    }
    .col-middle .row .num-new {
      left: 3.5em;
    }
    .col-middle .row .num-new {
      border-right: 1px solid var(--border-default);
    }
    /* No min-width override on .code: with white-space: pre, its
       natural min-width is the full line width, which makes the 1fr
       grid cell expand to content width. The row then also expands
       (via min-width: min-content on .row), so the row's addition /
       deletion / collapsed backgrounds cover the full rendered line
       — otherwise they'd stop at the initial viewport width. */
    /* Addition / deletion highlight lives on the .code cell only (not
       the whole row) so it terminates exactly at the end of the line
       — no extra shade across the row's padding, column gap, or
       empty space past content. And only the side that actually has
       the added / deleted line gets the tint (the opposite side is a
       spacer row and shouldn't look highlighted). */
    .col-right .row.addition .code,
    .col-middle .row.addition .code {
      background: color-mix(in srgb, var(--success) 18%, transparent);
    }
    .col-left .row.deletion .code,
    .col-middle .row.deletion .code {
      background: color-mix(in srgb, var(--danger) 18%, transparent);
    }
    .col-right .row.addition .num,
    .col-middle .row.addition .num,
    .col-left .row.deletion .num,
    .col-middle .row.deletion .num {
      background: color-mix(in srgb, var(--surface-1) 80%, var(--border-default) 60%);
    }
    /* Collapsed context applies only to the middle (diff) column:
       left and right show the full before / after files, the middle
       hides the unchanged noise between hunks with transparent text
       and a faint dashed line so scroll space stays accounted for
       but the changes stand out. */
    .col-middle .row.collapsed {
      background: repeating-linear-gradient(
        to bottom,
        transparent 0,
        transparent calc(0.725em - 0.5px),
        color-mix(in srgb, var(--border-default) 50%, transparent) calc(0.725em - 0.5px),
        color-mix(in srgb, var(--border-default) 50%, transparent) calc(0.725em + 0.5px),
        transparent calc(0.725em + 0.5px),
        transparent 1.45em
      );
    }
    .col-middle .row.collapsed .code,
    .col-middle .row.collapsed .code * {
      color: transparent !important;
    }
    .col-middle .row.collapsed .num {
      color: transparent;
    }
    .row .spacer {
      display: inline-block;
      width: 1ch;
    }
    .empty {
      padding: var(--space-4);
      color: var(--text-muted);
    }
  `;
}

// Extract the per-line HTML bodies from Shiki's output. Shiki emits
// `<pre><code><span class="line">...</span>\n<span class="line">...</span>...</code></pre>`
// where each `.line` span holds the highlighted tokens for one source
// line. We want the inner HTML of each `.line` so we can re-wrap
// lines inside our own row structure without dragging along Shiki's
// outer pre/code/newline formatting.
function extractShikiLines(fullHtml: string): string[] {
  if (!fullHtml) return [];
  const tmp = document.createElement("div");
  tmp.innerHTML = fullHtml;
  const lines = tmp.querySelectorAll(".line");
  return Array.from(lines).map((l) => l.innerHTML);
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split("\n");
  // Trailing newline leaves an empty tail entry; drop it so line
  // counts match git's view of the file.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-three-pane-view": GcThreePaneView;
  }
}
