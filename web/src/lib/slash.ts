// Composer slash commands.
//
// The LLM emits `[[diff from=X to=Y path=Z]]` markers that the frontend
// resolves via GetDiff. Users can now hand-author those markers using a
// composer slash command: `/diff HEAD~3..HEAD path/to/file.ts` at the
// start of a line transforms into the same marker on submit. Anything
// else on the line — or lines above/below — is preserved verbatim.

export interface SlashCommand {
  /** Trigger word after the leading `/`, e.g. "diff". */
  trigger: string;
  /** Display label for the menu, e.g. "/diff". */
  label: string;
  /** One-line description shown in the menu. */
  hint: string;
  /** Example syntax shown under the hint. */
  example: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    trigger: "diff",
    label: "/diff",
    hint: "insert a diff marker",
    example: "/diff HEAD~3..HEAD web/src/foo.ts",
  },
];

/** Transform `/diff`-style slash commands to `[[diff ...]]` markers.
 *
 * Matches only at the start of a line (after optional whitespace).
 * Preserves everything else. Accepted forms:
 *
 *   /diff                          → [[diff]]                 (latest commit)
 *   /diff A..B                     → [[diff from=A to=B]]
 *   /diff A..B path                → [[diff from=A to=B path=path]]
 *   /diff A...B  (three-dot)       → same as two-dot
 *   /diff <ref>                    → [[diff from=<ref> to=HEAD]]
 *   /diff <ref> path               → [[diff from=<ref> to=HEAD path=path]]
 *   /diff <path-looking>           → [[diff path=<path>]]     (latest change to file)
 *
 * Path heuristic for the single-arg case: if it contains a `/` or a
 * file extension (`.ts`, `.go`, etc.) it's a path; otherwise it's a
 * ref. Matches how humans write — `/diff README.md` reads as "show
 * this file", `/diff HEAD~3` reads as "show since this ref".
 */
export function transformSlashCommands(raw: string): string {
  return raw
    .split("\n")
    .map((line) => transformLine(line))
    .join("\n");
}

function transformLine(line: string): string {
  // Anchored: `/diff` at line start, optional args, nothing extra.
  // Args can be empty (just `/diff`), one token, or two tokens.
  const m = line.match(/^\s*\/diff(?:\s+(\S+)(?:\s+(\S+))?)?\s*$/);
  if (!m) return line;
  const first = m[1];
  const second = m[2];

  // Zero-arg: latest commit.
  if (!first) return "[[diff]]";

  // Range form (two- or three-dot).
  const range = first.match(/^(.+?)(?:\.\.\.|\.\.)(.+)$/);
  if (range) {
    const path = second ?? "";
    return `[[diff from=${range[1]} to=${range[2]}${path ? ` path=${path}` : ""}]]`;
  }

  // Two-arg (ref + path): from=ref to=HEAD with the path.
  if (second) {
    return `[[diff from=${first} to=HEAD path=${second}]]`;
  }

  // Single arg, no range: disambiguate ref vs path.
  if (looksLikePath(first)) {
    return `[[diff path=${first}]]`;
  }
  return `[[diff from=${first} to=HEAD]]`;
}

function looksLikePath(s: string): boolean {
  if (s.includes("/")) return true;
  // File-extension heuristic: trailing .<word> where <word> is short
  // and alphanumeric. Tight enough to skip "HEAD~3", "v1.2.0".
  return /\.[a-z][a-z0-9]{0,5}$/i.test(s);
}
