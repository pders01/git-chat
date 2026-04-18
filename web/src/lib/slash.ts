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
 *   - Matches only at the start of a line (after optional whitespace).
 *   - Preserves all other lines and any trailing text on non-matching lines.
 *   - `<from>..<to>` or `<from>...<to>` becomes `from=<from> to=<to>`.
 *   - A bare ref is treated as "since that ref": `from=<ref> to=HEAD`.
 *   - Optional trailing token is the path.
 *
 * Example:
 *   "compare:\n/diff HEAD~3..HEAD web/src/foo.ts\nwhat broke?"
 *   →
 *   "compare:\n[[diff from=HEAD~3 to=HEAD path=web/src/foo.ts]]\nwhat broke?"
 */
export function transformSlashCommands(raw: string): string {
  return raw
    .split("\n")
    .map((line) => transformLine(line))
    .join("\n");
}

function transformLine(line: string): string {
  const m = line.match(/^\s*\/diff\s+(\S+)(?:\s+(\S+))?\s*$/);
  if (!m) return line;
  const revspec = m[1];
  const path = m[2] ?? "";
  const range = revspec.match(/^(.+?)(?:\.\.\.|\.\.)(.+)$/);
  if (range) {
    return `[[diff from=${range[1]} to=${range[2]}${path ? ` path=${path}` : ""}]]`;
  }
  return `[[diff from=${revspec} to=HEAD${path ? ` path=${path}` : ""}]]`;
}
