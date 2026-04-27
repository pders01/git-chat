// Pure DOM transforms on Shiki-highlighted diff HTML. Kept in lib/
// (not the component) so the logic is testable against happy-dom
// without pulling in Lit or the component's render pipeline.
//
// The shape of the input matters: Shiki emits <pre><code class="line">...</code>...</pre>,
// with each line wrapped in a `.line` element and the raw prefix
// character ('-' / '+' / ' ') as part of the line's text content.
// We key everything off that structural contract; drift in Shiki's
// output shape would show up here first, which is on purpose — the
// render pipeline depends on this assumption.

/** Convert a unified-diff HTML blob (as emitted by Shiki's diff
 * grammar) into side-by-side pairs. Consecutive -/+ runs are zipped
 * row-by-row; unchanged context lines mirror on both sides. Orphan
 * deletes get an empty right side; orphan adds get an empty left side.
 *
 * The input can come in two shapes: Shiki's `.line`-wrapped variant
 * (preferred) or a plain newline-split body. Both are handled. */
export function splitDiffHtml(unifiedHtml: string): Array<{ left: string; right: string }> {
  const tmp = document.createElement("div");
  tmp.innerHTML = unifiedHtml;
  const code = tmp.querySelector("code");
  if (!code) return [{ left: unifiedHtml, right: "" }];
  const lineEls = code.querySelectorAll(".line");
  const lines =
    lineEls.length > 0 ? Array.from(lineEls).map((el) => el.innerHTML) : code.innerHTML.split("\n");
  const pairs: Array<{ left: string; right: string }> = [];
  const delBuf: string[] = [];
  const addBuf: string[] = [];
  const flushBuffers = () => {
    const max = Math.max(delBuf.length, addBuf.length);
    for (let i = 0; i < max; i++) {
      pairs.push({ left: delBuf[i] ?? "", right: addBuf[i] ?? "" });
    }
    delBuf.length = 0;
    addBuf.length = 0;
  };
  for (const lineHtml of lines) {
    const tempEl = document.createElement("span");
    tempEl.innerHTML = lineHtml;
    const text = tempEl.textContent ?? "";
    // File-header lines (`--- a/foo`, `+++ b/foo`) start with '-'/'+' but
    // are not real del/add edits — mirror them on both sides so they
    // don't get zipped into a fake del/add pair.
    if (text.startsWith("---") || text.startsWith("+++")) {
      flushBuffers();
      pairs.push({ left: lineHtml, right: lineHtml });
    } else if (text.startsWith("-")) delBuf.push(lineHtml);
    else if (text.startsWith("+")) addBuf.push(lineHtml);
    else {
      flushBuffers();
      pairs.push({ left: lineHtml, right: lineHtml });
    }
  }
  flushBuffers();
  return pairs;
}

/** Post-process Shiki diff HTML to add <mark> around changed words
 * within adjacent -/+ line pairs. Returns a fresh HTML string; the
 * input is not mutated. Lines that changed >80% on both sides are
 * left alone — they're treated as unrelated edits, not word-level
 * diffs, so we don't spam marks across a rewritten line. */
export function highlightWordDiffs(htmlStr: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = htmlStr;
  const code = tmp.querySelector("code");
  if (!code) return htmlStr;
  const lineEls = Array.from(code.querySelectorAll(".line"));
  if (lineEls.length === 0) return htmlStr;
  // File-header lines (`--- a/foo`, `+++ b/foo`) start with '-'/'+' but
  // are not real edits — exclude them so the pair detection below
  // doesn't word-diff `--- a/foo` against `+++ b/foo`.
  const isFileHeader = (t: string) => t.startsWith("---") || t.startsWith("+++");
  const isDel = (t: string) => t.startsWith("-") && !isFileHeader(t);
  const isAdd = (t: string) => t.startsWith("+") && !isFileHeader(t);
  let i = 0;
  while (i < lineEls.length) {
    const text = lineEls[i].textContent ?? "";
    if (isDel(text)) {
      const delStart = i;
      while (i < lineEls.length && isDel(lineEls[i].textContent ?? "")) i++;
      const addStart = i;
      while (i < lineEls.length && isAdd(lineEls[i].textContent ?? "")) i++;
      const delEnd = addStart;
      const addEnd = i;
      const pairCount = Math.min(delEnd - delStart, addEnd - addStart);
      for (let p = 0; p < pairCount; p++) {
        markWordDiffs(lineEls[delStart + p], lineEls[addStart + p]);
      }
    } else {
      i++;
    }
  }
  return tmp.innerHTML;
}

/** Inject before/after line-number spans into each `.line`. Returns a
 * fresh HTML string; the input is not mutated.
 *
 * The spans are *empty* at the DOM level — the actual digit is rendered
 * via CSS `::before { content: attr(data-n); }`. That matters because
 * splitDiffHtml and highlightWordDiffs classify lines by
 * `textContent.startsWith("-"|"+"|" ")`; baking the digit into the
 * element's text would corrupt that check. Pseudo-element content is
 * purely presentational and never lands in textContent.
 *
 * Numbers are real old/new line numbers seeded from `@@ -N,M +P,Q @@`
 * hunk headers — matches what GitHub / GitLab show in a diff view, as
 * opposed to sequential "line N of the diff" counting.
 *
 * Line type → what spans get populated:
 *   - `@@` hunk header: both empty (consumes gutter width, no digit)
 *   - `---` / `+++` file headers: both empty
 *   - `-del`: only .ln-old gets data-n (old line ticks)
 *   - `+add`: only .ln-new gets data-n (new line ticks)
 *   - ` ctx`: both get data-n
 *   - `\ No newline …`: both empty
 *
 * Consumers must provide CSS like:
 *   .ln-old, .ln-new { display: inline-block; user-select: none; }
 *   .ln-old::before { content: attr(data-n); }
 *   .ln-new::before { content: attr(data-n); }
 */
export function addLineNumbers(htmlStr: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = htmlStr;
  const code = tmp.querySelector("code");
  if (!code) return htmlStr;
  const lineEls = Array.from(code.querySelectorAll(".line"));
  if (lineEls.length === 0) return htmlStr;

  const hunkRE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let oldLine = 0;
  let newLine = 0;

  for (const el of lineEls) {
    const text = el.textContent ?? "";
    let oldNum = "";
    let newNum = "";

    const hunk = text.match(hunkRE);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      // Hunk header itself gets no digits — gutter stays blank.
    } else if (text.startsWith("---") || text.startsWith("+++")) {
      // File header. No digits.
    } else if (text.startsWith("-")) {
      oldNum = String(oldLine);
      oldLine++;
    } else if (text.startsWith("+")) {
      newNum = String(newLine);
      newLine++;
    } else if (text.startsWith(" ")) {
      oldNum = String(oldLine);
      newNum = String(newLine);
      oldLine++;
      newLine++;
    }
    // Fallthrough (e.g. "\ No newline at end of file") → both empty.

    const oldSp = document.createElement("span");
    oldSp.className = "ln-old";
    if (oldNum) oldSp.dataset.n = oldNum;
    const newSp = document.createElement("span");
    newSp.className = "ln-new";
    if (newNum) newSp.dataset.n = newNum;
    // Insert at the head so the line prefix (' ', '+', '-') follows.
    el.insertBefore(newSp, el.firstChild);
    el.insertBefore(oldSp, el.firstChild);
  }
  return tmp.innerHTML;
}

// Compare two line elements word-by-word and wrap differing words in
// <mark> elements. Skips highlighting when >80% of both sides changed
// (treating the lines as unrelated rather than edits of each other).
function markWordDiffs(delEl: Element, addEl: Element) {
  const delText = (delEl.textContent ?? "").slice(1);
  const addText = (addEl.textContent ?? "").slice(1);
  if (delText === addText) return;
  const delWords = delText.split(/(\s+)/);
  const addWords = addText.split(/(\s+)/);
  const lcsSet = (a: string[], b: string[]): { inA: Set<number>; inB: Set<number> } => {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array.from({ length: n + 1 }, () => 0),
    );
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const inA = new Set<number>();
    const inB = new Set<number>();
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        inA.add(i - 1);
        inB.add(j - 1);
        i--;
        j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
      else j--;
    }
    return { inA, inB };
  };
  const { inA: commonDel, inB: commonAdd } = lcsSet(delWords, addWords);
  const delChanged = new Set<number>();
  const addChanged = new Set<number>();
  for (let i = 0; i < delWords.length; i++) if (!commonDel.has(i)) delChanged.add(i);
  for (let i = 0; i < addWords.length; i++) if (!commonAdd.has(i)) addChanged.add(i);
  if (delChanged.size > delWords.length * 0.8 && addChanged.size > addWords.length * 0.8) return;
  const findChangedRanges = (words: string[], changed: Set<number>): Array<[number, number]> => {
    const ranges: Array<[number, number]> = [];
    let pos = 0;
    for (let i = 0; i < words.length; i++) {
      if (changed.has(i) && words[i].trim()) ranges.push([pos, pos + words[i].length]);
      pos += words[i].length;
    }
    return ranges;
  };
  const wrapTextNodes = (el: Element, ranges: Array<[number, number]>, cssClass: string) => {
    if (ranges.length === 0) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Array<{ node: Text; start: number; end: number }> = [];
    let offset = 0;
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      nodes.push({ node: t, start: offset, end: offset + t.length });
      offset += t.length;
    }
    // Skip the leading '-' or '+' character.
    const shifted = ranges.map(([s, e]) => [s + 1, e + 1] as [number, number]);
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
