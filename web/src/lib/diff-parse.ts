// Parses a unified diff ("diff --git …" output) into a structured form
// suitable for driving a three-pane view with line-matched scrolling.
//
// For each hunk `@@ -oldStart,oldLen +newStart,newLen @@`, we walk the
// hunk body and record one entry per hunk line:
//   - " x" (context): oldLine, newLine both advance
//   - "-x" (deletion): only oldLine advances
//   - "+x" (addition): only newLine advances
//
// The returned maps let callers resolve any old-file line number to its
// corresponding new-file line number (and both to a diff-line index in
// the middle pane), which is what the scroll-sync handler needs.

export interface DiffLine {
  /** 0-based index into the parsed diff lines (drives middle-pane position). */
  index: number;
  /** 1-based line number in the old file, or null if this is an addition. */
  oldLine: number | null;
  /** 1-based line number in the new file, or null if this is a deletion. */
  newLine: number | null;
  /** Raw hunk line text, including its leading ' ', '-', or '+'. */
  text: string;
  /** Kind of line for rendering. */
  kind: "context" | "addition" | "deletion" | "header";
}

export interface ParsedDiff {
  lines: DiffLine[];
  /** old-file line number → diff line index (only lines present in old). */
  oldToDiff: Map<number, number>;
  /** new-file line number → diff line index (only lines present in new). */
  newToDiff: Map<number, number>;
  /** old → new projection for context + deletion-with-adjacent-addition lines. */
  oldToNew: Map<number, number>;
  /** new → old projection. */
  newToOld: Map<number, number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff. Accepts the output of `git diff` / `diff -u`,
 * including (and ignoring) the `diff --git`, `index`, `---`, `+++`
 * header block that typically precedes the first hunk.
 */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  const lines: DiffLine[] = [];
  const oldToDiff = new Map<number, number>();
  const newToDiff = new Map<number, number>();
  const oldToNew = new Map<number, number>();
  const newToOld = new Map<number, number>();

  if (!raw) return { lines, oldToDiff, newToDiff, oldToNew, newToOld };

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const src = raw.split("\n");
  for (const text of src) {
    const hunkMatch = HUNK_HEADER.exec(text);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1] ?? "1", 10);
      newLine = parseInt(hunkMatch[3] ?? "1", 10);
      inHunk = true;
      lines.push({ index: lines.length, oldLine: null, newLine: null, text, kind: "header" });
      continue;
    }
    if (!inHunk) {
      // File header lines (diff --git, index, ---, +++) — surface them
      // as header rows so the middle pane renders them at top, but they
      // carry no line-number mapping.
      if (
        text.startsWith("diff ") ||
        text.startsWith("index ") ||
        text.startsWith("--- ") ||
        text.startsWith("+++ ")
      ) {
        lines.push({ index: lines.length, oldLine: null, newLine: null, text, kind: "header" });
      }
      continue;
    }
    // "\ No newline at end of file" is a marker, not a line — skip the
    // mapping update. We still emit it so it appears in the middle
    // pane verbatim.
    if (text.startsWith("\\")) {
      lines.push({ index: lines.length, oldLine: null, newLine: null, text, kind: "context" });
      continue;
    }
    const prefix = text[0];
    if (prefix === " " || prefix === undefined) {
      const entry: DiffLine = {
        index: lines.length,
        oldLine,
        newLine,
        text,
        kind: "context",
      };
      lines.push(entry);
      oldToDiff.set(oldLine, entry.index);
      newToDiff.set(newLine, entry.index);
      oldToNew.set(oldLine, newLine);
      newToOld.set(newLine, oldLine);
      oldLine++;
      newLine++;
      continue;
    }
    if (prefix === "-") {
      const entry: DiffLine = {
        index: lines.length,
        oldLine,
        newLine: null,
        text,
        kind: "deletion",
      };
      lines.push(entry);
      oldToDiff.set(oldLine, entry.index);
      // Project deletion to the last-known new line so scroll handlers
      // have a target to jump to on the new side. Using newLine-1 keeps
      // the new-pane viewport just above the (absent) deleted text.
      oldToNew.set(oldLine, Math.max(newLine - 1, 1));
      oldLine++;
      continue;
    }
    if (prefix === "+") {
      const entry: DiffLine = {
        index: lines.length,
        oldLine: null,
        newLine,
        text,
        kind: "addition",
      };
      lines.push(entry);
      newToDiff.set(newLine, entry.index);
      newToOld.set(newLine, Math.max(oldLine - 1, 1));
      newLine++;
      continue;
    }
    // Any other prefix (e.g. stray diff artifact) — emit as a context
    // row with no mapping. Keeps the middle-pane output faithful.
    lines.push({ index: lines.length, oldLine: null, newLine: null, text, kind: "context" });
  }

  return { lines, oldToDiff, newToDiff, oldToNew, newToOld };
}
