import { describe, expect, test } from "bun:test";
import { splitDiffHtml, highlightWordDiffs } from "./diff-html.js";

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

  test("doesn't mark the leading '-' or '+' prefix char", () => {
    const out = highlightWordDiffs(shikiDiff(["-old x", "+new x"]));
    // Prefix chars should stay outside any <mark> wrapper.
    expect(out).not.toMatch(/<mark[^>]*>-/);
    expect(out).not.toMatch(/<mark[^>]*>\+/);
  });
});
