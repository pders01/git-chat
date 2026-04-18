// Composer slash commands.
//
// The LLM emits `[[diff from=X to=Y path=Z]]` markers that the frontend
// resolves via GetDiff. Users can now hand-author those markers using a
// composer slash command: `/diff HEAD~3..HEAD path/to/file.ts` at the
// start of a line transforms into the same marker on submit. Anything
// else on the line — or lines above/below — is preserved verbatim.

// Slash commands come in two flavors:
//
//   - "transform" commands rewrite the message text at submit time
//     (e.g. /diff → [[diff ...]]). They still flow to the LLM.
//   - "action" commands trigger a side effect (switch model, show help)
//     and don't submit to the LLM. The composer fires a gc:slash-action
//     event; the parent (chat-view) handles the RPC + user feedback.
//
// Commands that overlap with the command palette (new chat, focus,
// theme, tab navigation) are deliberately NOT exposed here — palette
// is the right entry point for app-wide actions; slash is for chat-
// context operations only.
export type SlashCommandKind = "transform" | "action";

/** Controls how the composer stitches an autocomplete suggestion back
 * into the input when a command has arg autocomplete. */
export type ArgCompletionMode =
  /** Single argument, may contain spaces (e.g. profile names like "Local
   * Gemma"). Accepting a suggestion replaces everything after `/cmd `. */
  | "whole"
  /** Multi-arg or single-word arg. Accepting replaces only the last
   * whitespace-delimited token; earlier args are preserved. */
  | "word";

export interface SlashCommand {
  /** Trigger word after the leading `/`, e.g. "diff". */
  trigger: string;
  /** Display label for the menu, e.g. "/diff". */
  label: string;
  /** One-line description shown in the menu. */
  hint: string;
  /** Example syntax shown under the hint. */
  example: string;
  /** How the composer handles this command on submit. */
  kind: SlashCommandKind;
  /** Set to enable arg autocomplete. Dictates suggestion stitching. */
  argCompletion?: ArgCompletionMode;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    trigger: "diff",
    label: "/diff",
    hint: "insert a diff marker",
    example: "/diff HEAD~3..HEAD web/src/foo.ts",
    kind: "transform",
    argCompletion: "word",
  },
  {
    trigger: "model",
    label: "/model",
    hint: "switch the model for this chat",
    example: "/model claude-opus-4-7",
    kind: "action",
    argCompletion: "word",
  },
  {
    trigger: "profile",
    label: "/profile",
    hint: "activate a saved LLM profile",
    example: "/profile Local Gemma",
    kind: "action",
    argCompletion: "whole",
  },
  {
    trigger: "help",
    label: "/help",
    hint: "list all slash commands",
    example: "/help",
    kind: "action",
  },
];

/** Parsed action command result. For non-action input, returns null. */
export interface ParsedAction {
  command: string;
  args: string[];
}

/** Arg-completion context: set when the cursor is on an action
 * command's arg position (e.g. `/model <partial>`). `partial` is the
 * text already typed for the arg — the composer's autocomplete
 * filters suggestions against it. Returns null if the line isn't
 * `/ACTION ARGS`. */
export interface ActionArgContext {
  command: SlashCommand;
  partial: string;
}

/** Detect whether the current line puts the cursor in arg-completion
 * mode for any command with `argCompletion` set. Triggered only after
 * the command is fully typed and followed by whitespace — `/mod` stays
 * in command-selection mode, `/model ` (note trailing space) enters
 * arg mode with partial="". */
export function matchActionArgContext(line: string): ActionArgContext | null {
  const m = line.match(/^\s*\/(\w+)\s+(.*)$/);
  if (!m) return null;
  const trigger = m[1];
  const partial = m[2];
  if (partial.includes("\n")) return null;
  const spec = SLASH_COMMANDS.find((c) => c.trigger === trigger && c.argCompletion);
  if (!spec) return null;
  return { command: spec, partial };
}

/** Split a partial into (prior args, current token) so the composer can
 * filter/replace correctly. For "whole" mode the current token IS the
 * whole partial — profile names can have spaces. For "word" mode the
 * current token is everything after the last whitespace, and prior
 * tokens are stitched back during replacement. */
export function splitArgPartial(
  mode: ArgCompletionMode,
  partial: string,
): { priorArgs: string[]; currentToken: string } {
  if (mode === "whole") {
    return { priorArgs: [], currentToken: partial };
  }
  // "word" mode: last whitespace-delimited fragment, even if partial
  // ends with a space (currentToken = "" means "about to type the next
  // arg" — still valid for suggestion fetching).
  const trailingSpace = /\s$/.test(partial);
  const tokens = partial.split(/\s+/).filter((t) => t.length > 0);
  if (trailingSpace || tokens.length === 0) {
    return { priorArgs: tokens, currentToken: "" };
  }
  return {
    priorArgs: tokens.slice(0, -1),
    currentToken: tokens[tokens.length - 1],
  };
}

/** Parse a composer input as a slash action command. Returns null if
 * the input is not a recognized action (transform commands return null
 * too — they're handled by transformSlashCommands instead). Matches
 * only when the FIRST non-whitespace line is the slash command and
 * nothing else follows — we don't want `/profile foo\nextra prose`
 * to look like a bare action.
 */
export function parseSlashAction(raw: string): ParsedAction | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  // Action commands must be a single line.
  if (trimmed.includes("\n")) return null;
  const rest = trimmed.slice(1);
  const firstSpace = rest.indexOf(" ");
  const command = firstSpace < 0 ? rest : rest.slice(0, firstSpace);
  const argsStr = firstSpace < 0 ? "" : rest.slice(firstSpace + 1).trim();
  const spec = SLASH_COMMANDS.find((c) => c.trigger === command);
  if (!spec || spec.kind !== "action") return null;
  // Profile names can have spaces ("Local Gemma") — keep args as a
  // single-element array containing the whole remainder. Individual
  // commands that need tokenization can split themselves.
  const args = argsStr ? [argsStr] : [];
  return { command, args };
}

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
