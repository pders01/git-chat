import { describe, expect, test } from "bun:test";
import { transformSlashCommands, SLASH_COMMANDS } from "./slash.js";

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

  test("/diff without args stays literal", () => {
    expect(transformSlashCommands("/diff")).toBe("/diff");
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
});
