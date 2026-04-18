import { describe, expect, test } from "bun:test";
import { splitDiffHtml, highlightWordDiffs } from "./diff-pane.js";

// Minimal Shiki-shape: <pre><code><span class="line">...</span>...</code></pre>.
// The real component feeds whatever highlight() returns, so shape is what
// matters — not the tokenization inside each line.
function shikiHtml(lines: string[]): string {
  const body = lines.map((l) => `<span class="line">${l}</span>`).join("\n");
  return `<pre><code>${body}</code></pre>`;
}

describe("splitDiffHtml", () => {
  test("returns single pair with input verbatim when there is no <code>", () => {
    const pairs = splitDiffHtml("<div>no code here</div>");
    expect(pairs).toHaveLength(1);
    expect(pairs[0].left).toBe("<div>no code here</div>");
    expect(pairs[0].right).toBe("");
  });

  test("pure context lines appear on both sides", () => {
    const html = shikiHtml([" context one", " context two"]);
    const pairs = splitDiffHtml(html);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].left).toBe(pairs[0].right);
    expect(pairs[1].left).toBe(pairs[1].right);
  });

  test("adjacent -/+ lines pair into one row", () => {
    const html = shikiHtml(["-foo", "+bar"]);
    const pairs = splitDiffHtml(html);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].left).toBe("-foo");
    expect(pairs[0].right).toBe("+bar");
  });

  test("uneven hunks get empty partner on the short side", () => {
    const html = shikiHtml(["-a", "-b", "+c"]);
    const pairs = splitDiffHtml(html);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ left: "-a", right: "+c" });
    expect(pairs[1]).toEqual({ left: "-b", right: "" });
  });

  test("context between hunks flushes the buffer", () => {
    const html = shikiHtml(["-foo", "+bar", " ctx", "-baz", "+qux"]);
    const pairs = splitDiffHtml(html);
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toEqual({ left: "-foo", right: "+bar" });
    expect(pairs[1].left).toBe(" ctx");
    expect(pairs[1].right).toBe(" ctx");
    expect(pairs[2]).toEqual({ left: "-baz", right: "+qux" });
  });

  test("pure-addition tail produces rows with empty left", () => {
    const html = shikiHtml([" ctx", "+added1", "+added2"]);
    const pairs = splitDiffHtml(html);
    expect(pairs).toHaveLength(3);
    expect(pairs[1]).toEqual({ left: "", right: "+added1" });
    expect(pairs[2]).toEqual({ left: "", right: "+added2" });
  });
});

describe("highlightWordDiffs", () => {
  test("returns input unchanged when there is no <code>", () => {
    const input = "<div>plain</div>";
    expect(highlightWordDiffs(input)).toBe(input);
  });

  test("returns input unchanged when there are no -/+ pairs", () => {
    const html = shikiHtml([" context only"]);
    const out = highlightWordDiffs(html);
    // No <mark> should be injected.
    expect(out).not.toContain("<mark");
  });

  test("wraps the single changed word in a pair", () => {
    const html = shikiHtml(["-hello world", "+hello there"]);
    const out = highlightWordDiffs(html);
    // Changed words should each be wrapped.
    expect(out).toContain('<mark class="word-del">world</mark>');
    expect(out).toContain('<mark class="word-add">there</mark>');
    // Unchanged "hello" should NOT be inside a mark.
    expect(out).not.toContain('<mark class="word-del">hello</mark>');
  });

  test("skips when >80% of both sides changed (treat as unrelated lines)", () => {
    // Single fully-different words reliably trip the 80% threshold:
    // each side is 1 token, 1/1 = 100% changed. Multi-word cases like
    // "alpha bravo" vs "xxxx yyyy" only reach ~60% because single-space
    // separator tokens match between the two sides — see the LCS in
    // markWordDiffs, which tokenizes via /(\s+)/ and counts whitespace.
    const html = shikiHtml(["-alpha", "+xxxx"]);
    const out = highlightWordDiffs(html);
    expect(out).not.toContain("<mark");
  });

  test("multiple -/+ pairs each get their own highlights", () => {
    const html = shikiHtml(["-one two", "+one three", " ctx", "-four five", "+four six"]);
    const out = highlightWordDiffs(html);
    expect(out).toContain('<mark class="word-del">two</mark>');
    expect(out).toContain('<mark class="word-add">three</mark>');
    expect(out).toContain('<mark class="word-del">five</mark>');
    expect(out).toContain('<mark class="word-add">six</mark>');
  });

  test("does not highlight when the payload after -/+ is identical", () => {
    const html = shikiHtml(["-same", "+same"]);
    const out = highlightWordDiffs(html);
    expect(out).not.toContain("<mark");
  });
});
