import { describe, expect, test } from "bun:test";
import {
  transformSlashCommands,
  parseSlashAction,
  matchActionArgContext,
  splitArgPartial,
  SLASH_COMMANDS,
} from "./slash.js";

describe("transformSlashCommands", () => {
  test("passes through text with no slash commands", () => {
    expect(transformSlashCommands("hello world")).toBe("hello world");
    expect(transformSlashCommands("")).toBe("");
    expect(transformSlashCommands("multi\nline\ntext")).toBe("multi\nline\ntext");
  });

  test("two-dot range becomes from/to", () => {
    expect(transformSlashCommands("/diff HEAD~3..HEAD")).toBe("[[diff from=HEAD~3 to=HEAD]]");
  });

  test("three-dot range also becomes from/to", () => {
    expect(transformSlashCommands("/diff main...feature")).toBe(
      "[[diff from=main to=feature]]",
    );
  });

  test("single ref defaults to HEAD", () => {
    expect(transformSlashCommands("/diff HEAD~5")).toBe("[[diff from=HEAD~5 to=HEAD]]");
  });

  test("trailing path is captured", () => {
    expect(transformSlashCommands("/diff HEAD~3..HEAD web/src/foo.ts")).toBe(
      "[[diff from=HEAD~3 to=HEAD path=web/src/foo.ts]]",
    );
    expect(transformSlashCommands("/diff v1.2.0 README.md")).toBe(
      "[[diff from=v1.2.0 to=HEAD path=README.md]]",
    );
  });

  test("surrounding lines are preserved verbatim", () => {
    const input = "compare:\n/diff HEAD~3..HEAD web/src/foo.ts\nwhat broke?";
    const expected =
      "compare:\n[[diff from=HEAD~3 to=HEAD path=web/src/foo.ts]]\nwhat broke?";
    expect(transformSlashCommands(input)).toBe(expected);
  });

  test("leading whitespace on a slash line is allowed", () => {
    expect(transformSlashCommands("  /diff HEAD~1..HEAD")).toBe("[[diff from=HEAD~1 to=HEAD]]");
  });

  test("mid-line /diff is NOT transformed (literal text)", () => {
    expect(transformSlashCommands("see /diff HEAD~3..HEAD for context")).toBe(
      "see /diff HEAD~3..HEAD for context",
    );
  });

  test("/diff with no args becomes bare [[diff]] (latest commit)", () => {
    expect(transformSlashCommands("/diff")).toBe("[[diff]]");
  });

  test("path-looking single arg becomes path-only marker", () => {
    expect(transformSlashCommands("/diff README.md")).toBe("[[diff path=README.md]]");
    expect(transformSlashCommands("/diff web/src/foo.ts")).toBe(
      "[[diff path=web/src/foo.ts]]",
    );
  });

  test("ref-looking single arg becomes from=<ref> to=HEAD", () => {
    expect(transformSlashCommands("/diff HEAD~3")).toBe("[[diff from=HEAD~3 to=HEAD]]");
    expect(transformSlashCommands("/diff main")).toBe("[[diff from=main to=HEAD]]");
  });

  test("tagged versions are treated as refs, not paths", () => {
    // "v1.2.0" has dots but matches neither looksLikePath heuristic:
    // no slash, no alpha extension at the end. Falls through as a ref.
    expect(transformSlashCommands("/diff v1.2.0")).toBe("[[diff from=v1.2.0 to=HEAD]]");
  });

  test("three args: revspec is first, path is second, rest would be extra", () => {
    // The regex anchors with \s*$ after optional path, so "foo bar baz"
    // beyond the path doesn't match. Falls through as literal — user
    // clearly meant prose, not a marker.
    expect(transformSlashCommands("/diff HEAD~1..HEAD foo bar")).toBe(
      "/diff HEAD~1..HEAD foo bar",
    );
  });

  test("multiple /diff lines all transform", () => {
    const input = "/diff HEAD~1..HEAD\n/diff HEAD~2..HEAD web/foo.ts";
    const expected =
      "[[diff from=HEAD~1 to=HEAD]]\n[[diff from=HEAD~2 to=HEAD path=web/foo.ts]]";
    expect(transformSlashCommands(input)).toBe(expected);
  });
});

describe("SLASH_COMMANDS", () => {
  test("includes /diff with canonical example", () => {
    const diff = SLASH_COMMANDS.find((c) => c.trigger === "diff");
    expect(diff).toBeDefined();
    expect(diff?.label).toBe("/diff");
    expect(diff?.example).toContain("..");
  });

  test("each command has a kind", () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.kind === "transform" || c.kind === "action").toBe(true);
    }
  });
});

describe("parseSlashAction", () => {
  test("returns null for non-slash text", () => {
    expect(parseSlashAction("hello world")).toBeNull();
    expect(parseSlashAction("")).toBeNull();
  });

  test("returns null for transform commands (not actions)", () => {
    // /diff is a transform, not an action — transformSlashCommands
    // handles it elsewhere. parseSlashAction should ignore it.
    expect(parseSlashAction("/diff HEAD~3..HEAD")).toBeNull();
  });

  test("returns null for unknown slash triggers", () => {
    expect(parseSlashAction("/nonsense foo")).toBeNull();
  });

  test("/model with id parses to {command, args}", () => {
    const p = parseSlashAction("/model claude-opus-4-7");
    expect(p).toEqual({ command: "model", args: ["claude-opus-4-7"] });
  });

  test("/profile with multi-word name keeps the name whole", () => {
    // Profile names can have spaces — whole remainder stays in args[0].
    const p = parseSlashAction("/profile Local Gemma");
    expect(p).toEqual({ command: "profile", args: ["Local Gemma"] });
  });

  test("/help with no args parses cleanly", () => {
    expect(parseSlashAction("/help")).toEqual({ command: "help", args: [] });
  });

  test("action commands only parse on a single line", () => {
    // Mixing an action command with extra prose means the user likely
    // meant to send a message, not trigger an action.
    expect(parseSlashAction("/profile Local\nextra text")).toBeNull();
  });

  test("leading/trailing whitespace is trimmed", () => {
    expect(parseSlashAction("  /model gpt-4o  ")).toEqual({
      command: "model",
      args: ["gpt-4o"],
    });
  });
});

describe("matchActionArgContext", () => {
  test("returns null for no slash", () => {
    expect(matchActionArgContext("hello")).toBeNull();
    expect(matchActionArgContext("")).toBeNull();
  });

  test("returns null when command is not yet followed by space", () => {
    // Bare command selection — still in command-picker mode, not arg mode.
    expect(matchActionArgContext("/mod")).toBeNull();
    expect(matchActionArgContext("/model")).toBeNull();
  });

  test("triggers on known action command + space (partial empty)", () => {
    const ctx = matchActionArgContext("/model ");
    expect(ctx?.command.trigger).toBe("model");
    expect(ctx?.partial).toBe("");
  });

  test("triggers on known action command + partial text", () => {
    const ctx = matchActionArgContext("/profile Loc");
    expect(ctx?.command.trigger).toBe("profile");
    expect(ctx?.partial).toBe("Loc");
  });

  test("transform commands with argCompletion also match (e.g. /diff)", () => {
    // /diff is a transform but has argCompletion:"word" so the composer
    // can suggest refs + paths as the user types args.
    const ctx = matchActionArgContext("/diff HEAD~3");
    expect(ctx?.command.trigger).toBe("diff");
    expect(ctx?.partial).toBe("HEAD~3");
  });

  test("returns null for unknown commands", () => {
    expect(matchActionArgContext("/unknown foo")).toBeNull();
  });

  test("leading whitespace on the line is allowed", () => {
    const ctx = matchActionArgContext("  /model gp");
    expect(ctx?.command.trigger).toBe("model");
    expect(ctx?.partial).toBe("gp");
  });
});

describe("splitArgPartial", () => {
  test("whole mode: currentToken is the full partial, no priorArgs", () => {
    expect(splitArgPartial("whole", "Local Gemma")).toEqual({
      priorArgs: [],
      currentToken: "Local Gemma",
    });
  });

  test("whole mode: empty partial yields empty token", () => {
    expect(splitArgPartial("whole", "")).toEqual({ priorArgs: [], currentToken: "" });
  });

  test("word mode: last token is the currentToken", () => {
    expect(splitArgPartial("word", "HEAD~3..HEAD web/foo")).toEqual({
      priorArgs: ["HEAD~3..HEAD"],
      currentToken: "web/foo",
    });
  });

  test("word mode: trailing space means next arg is starting", () => {
    expect(splitArgPartial("word", "HEAD~3..HEAD ")).toEqual({
      priorArgs: ["HEAD~3..HEAD"],
      currentToken: "",
    });
  });

  test("word mode: single token with no space", () => {
    expect(splitArgPartial("word", "HEAD~3")).toEqual({
      priorArgs: [],
      currentToken: "HEAD~3",
    });
  });

  test("word mode: empty partial", () => {
    expect(splitArgPartial("word", "")).toEqual({ priorArgs: [], currentToken: "" });
  });
});
