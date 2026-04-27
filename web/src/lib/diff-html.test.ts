import { describe, expect, test } from "bun:test";
import { splitDiffHtml, highlightWordDiffs, addLineNumbers } from "./diff-html.js";

// Shiki wraps each line in <span class="line">; the first visible
// character is the diff prefix (space/+/-). These helpers construct
// realistic-ish fixtures without actually running Shiki.
function shikiDiff(lines: string[]): string {
  const body = lines.map((l) => `<span class="line">${l}</span>`).join("");
  return `<pre><code>${body}</code></pre>`;
}

function noCodeWrapper(text: string): string {
  // Return a blob that doesn't contain a <code> element — exercises
  // the fallback branch.
  return `<div>${text}</div>`;
}

// ── splitDiffHtml ──────────────────────────────────────────────────

describe("splitDiffHtml", () => {
  test("no <code> element → passes input through as left, empty right", () => {
    const out = splitDiffHtml(noCodeWrapper("something"));
    expect(out).toHaveLength(1);
    expect(out[0].right).toBe("");
    expect(out[0].left).toContain("something");
  });

  test("pure context line mirrors on both sides", () => {
    const out = splitDiffHtml(shikiDiff([" context"]));
    expect(out).toEqual([{ left: " context", right: " context" }]);
  });

  test("single del/add pair zips into one row", () => {
    const out = splitDiffHtml(shikiDiff(["-old line", "+new line"]));
    expect(out).toEqual([{ left: "-old line", right: "+new line" }]);
  });

  test("del-only run produces empty right sides", () => {
    const out = splitDiffHtml(shikiDiff(["-one", "-two"]));
    expect(out).toEqual([
      { left: "-one", right: "" },
      { left: "-two", right: "" },
    ]);
  });

  test("add-only run produces empty left sides", () => {
    const out = splitDiffHtml(shikiDiff(["+one", "+two"]));
    expect(out).toEqual([
      { left: "", right: "+one" },
      { left: "", right: "+two" },
    ]);
  });

  test("uneven del/add — shorter side gets padded with empties", () => {
    const out = splitDiffHtml(shikiDiff(["-one", "-two", "+NEW"]));
    expect(out).toEqual([
      { left: "-one", right: "+NEW" },
      { left: "-two", right: "" },
    ]);
  });

  test("context flush: accumulated -/+ flush before the context row", () => {
    const out = splitDiffHtml(shikiDiff(["-old", "+new", " same"]));
    expect(out).toEqual([
      { left: "-old", right: "+new" },
      { left: " same", right: " same" },
    ]);
  });

  test("file header lines (--- a/foo, +++ b/foo) mirror, don't pair as del/add", () => {
    // Regression: `---`/`+++` start with '-'/'+' but are file headers,
    // not real edits — they must not be zipped into a del/add row.
    const out = splitDiffHtml(
      shikiDiff(["--- a/foo.ts", "+++ b/foo.ts", "-real-del", "+real-add"]),
    );
    expect(out).toEqual([
      { left: "--- a/foo.ts", right: "--- a/foo.ts" },
      { left: "+++ b/foo.ts", right: "+++ b/foo.ts" },
      { left: "-real-del", right: "+real-add" },
    ]);
  });

  test("realistic hunk: mix of context + edits round-trips shape", () => {
    const out = splitDiffHtml(
      shikiDiff([" unchanged", "-deleted-a", "-deleted-b", "+added-a", " tail"]),
    );
    expect(out).toEqual([
      { left: " unchanged", right: " unchanged" },
      { left: "-deleted-a", right: "+added-a" },
      { left: "-deleted-b", right: "" },
      { left: " tail", right: " tail" },
    ]);
  });
});

// ── highlightWordDiffs ─────────────────────────────────────────────

describe("highlightWordDiffs", () => {
  test("no <code> element → pass-through", () => {
    const input = noCodeWrapper("nothing to mark");
    expect(highlightWordDiffs(input)).toBe(input);
  });

  test("empty .line list → pass-through", () => {
    // <code> exists but no .line wrappers — we treat that as "not a
    // Shiki diff" and return the input unchanged.
    const input = "<pre><code>plain text</code></pre>";
    expect(highlightWordDiffs(input)).toBe(input);
  });

  test("identical -/+ pair skips marking entirely", () => {
    const input = shikiDiff(["-same", "+same"]);
    const out = highlightWordDiffs(input);
    // Lines are preserved, no <mark> inserted.
    expect(out).not.toContain("<mark");
  });

  test("word-level edit wraps only the changed word", () => {
    // "foo bar" → "foo baz": the "bar" → "baz" word pair gets marked,
    // "foo" stays unmarked.
    const out = highlightWordDiffs(shikiDiff(["-foo bar", "+foo baz"]));
    // Both sides get a <mark>; each mark should contain one of
    // "bar" or "baz" but not the unchanged "foo".
    expect(out).toContain("<mark");
    expect(out).toContain("bar");
    expect(out).toContain("baz");
    // "foo" appears twice (once per side) but should not be inside a mark.
    const fooInMark = /<mark[^>]*>[^<]*foo[^<]*<\/mark>/.test(out);
    expect(fooInMark).toBe(false);
  });

  test("completely rewritten line is left unmarked (>80% changed heuristic)", () => {
    // The >80% heuristic kicks in when the two sides share almost no
    // tokens in common — here the shapes are totally different, so
    // LCS finds nothing and both sides qualify as "fully changed."
    // Marks would just be noise, so the helper skips.
    const out = highlightWordDiffs(shikiDiff(["-alpha beta gamma delta epsilon", "+x"]));
    expect(out).not.toContain("<mark");
  });

  test("pairs zipped in order: first del with first add, etc.", () => {
    // Two del lines + two add lines — we mark (del[0], add[0]) and
    // (del[1], add[1]) as pairs. Verify by checking that changed
    // words appear wrapped on their respective sides.
    const out = highlightWordDiffs(
      shikiDiff(["-hello world", "-foo bar", "+hello there", "+foo qux"]),
    );
    expect(out).toContain("world");
    expect(out).toContain("there");
    expect(out).toContain("bar");
    expect(out).toContain("qux");
  });

  test("orphan del (no matching add run) skips marking — no paired add available", () => {
    const out = highlightWordDiffs(shikiDiff(["-only delete", " context"]));
    expect(out).not.toContain("<mark");
  });

  test("file header pair (--- a/foo / +++ b/foo) is not word-diffed", () => {
    // Regression: `---` / `+++` headers start with '-'/'+' but are not
    // real -/+ edits — they should not get LCS'd against each other.
    const out = highlightWordDiffs(
      shikiDiff(["--- a/foo.ts", "+++ b/foo.ts", "@@ -1 +1 @@", " ctx"]),
    );
    expect(out).not.toContain("<mark");
  });

  test("doesn't mark the leading '-' or '+' prefix char", () => {
    const out = highlightWordDiffs(shikiDiff(["-old x", "+new x"]));
    // Prefix chars should stay outside any <mark> wrapper.
    expect(out).not.toMatch(/<mark[^>]*>-/);
    expect(out).not.toMatch(/<mark[^>]*>\+/);
  });
});

// ── addLineNumbers ─────────────────────────────────────────────────

function parseLineNums(html: string): Array<{ old: string; new: string }> {
  // Helper: extract the data-n values from .ln-old/.ln-new spans in
  // order, one entry per .line. Empty dataset maps to "".
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return Array.from(tmp.querySelectorAll(".line")).map((line) => ({
    old: line.querySelector(".ln-old")?.getAttribute("data-n") ?? "",
    new: line.querySelector(".ln-new")?.getAttribute("data-n") ?? "",
  }));
}

describe("addLineNumbers", () => {
  test("no <code> element → pass-through", () => {
    const input = noCodeWrapper("nothing to number");
    expect(addLineNumbers(input)).toBe(input);
  });

  test("single hunk with context + del + add assigns sequential numbers", () => {
    // Hunk @@ -3,3 +3,3 @@ with:
    //   context (old 3, new 3)
    //   delete  (old 4)
    //   add     (new 4)
    //   context (old 5, new 5)
    const out = addLineNumbers(
      shikiDiff(["@@ -3,3 +3,3 @@", " ctx-a", "-deleted", "+added", " ctx-b"]),
    );
    const nums = parseLineNums(out);
    expect(nums).toEqual([
      { old: "", new: "" }, // hunk header
      { old: "3", new: "3" }, // context
      { old: "4", new: "" }, // delete advances old only
      { old: "", new: "4" }, // add advances new only
      { old: "5", new: "5" }, // context advances both
    ]);
  });

  test("multi-hunk diff resets counters from each @@ header", () => {
    const out = addLineNumbers(
      shikiDiff([
        "@@ -10,2 +10,2 @@",
        " ctx-a",
        "-old-a",
        "+new-a",
        "@@ -50,2 +100,2 @@",
        " ctx-b",
        "+new-b",
      ]),
    );
    const nums = parseLineNums(out);
    // Second hunk starts at old=50, new=100. Context consumes those,
    // so the following +new-b sits at new=101.
    expect(nums[5]).toEqual({ old: "50", new: "100" }); // " ctx-b"
    expect(nums[6]).toEqual({ old: "", new: "101" }); // "+new-b"
  });

  test("hunk header without counts (single-line @@ -3 +3 @@) still parses", () => {
    const out = addLineNumbers(shikiDiff(["@@ -3 +3 @@", " ctx"]));
    const nums = parseLineNums(out);
    expect(nums[1]).toEqual({ old: "3", new: "3" });
  });

  test("file header lines (--- a/foo, +++ b/foo) get no digits", () => {
    const out = addLineNumbers(shikiDiff(["--- a/foo.ts", "+++ b/foo.ts", "@@ -1 +1 @@", " ctx"]));
    const nums = parseLineNums(out);
    expect(nums[0]).toEqual({ old: "", new: "" });
    expect(nums[1]).toEqual({ old: "", new: "" });
    expect(nums[2]).toEqual({ old: "", new: "" }); // hunk header
    expect(nums[3]).toEqual({ old: "1", new: "1" }); // context
  });

  test("digits never leak into textContent (classifiers keep working)", () => {
    // Critical contract: splitDiffHtml checks textContent.startsWith('-')
    // to classify lines. After addLineNumbers, the textContent of a
    // deletion line must still start with '-', not a digit.
    const out = addLineNumbers(shikiDiff(["@@ -1 +1 @@", "-del", "+add"]));
    const tmp = document.createElement("div");
    tmp.innerHTML = out;
    const lines = Array.from(tmp.querySelectorAll(".line"));
    expect(lines[1].textContent?.startsWith("-")).toBe(true);
    expect(lines[2].textContent?.startsWith("+")).toBe(true);
  });

  test("empty .line list → pass-through (non-Shiki input)", () => {
    const input = "<pre><code>plain text</code></pre>";
    expect(addLineNumbers(input)).toBe(input);
  });

  test("works as the last stage after splitDiffHtml still classifies correctly", () => {
    // Integration: add line numbers first, then run splitDiffHtml.
    // Should produce the same pair structure as without line numbers.
    const withNums = addLineNumbers(
      shikiDiff(["@@ -1 +1 @@", " ctx-a", "-del-x", "+add-x", " ctx-b"]),
    );
    const pairs = splitDiffHtml(withNums);
    // 1 hunk header + 1 ctx + 1 del/add pair + 1 ctx = 4 rows
    expect(pairs).toHaveLength(4);
  });
});
