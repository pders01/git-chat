import { describe, expect, test } from "bun:test";
import { parseRoute, buildRoute, routesEqual, clearStaleState, type ParsedRoute } from "./routing.js";

// Helper: parse a hash string as if it were a full URL.
function parse(hash: string): ParsedRoute {
  return parseRoute(new URL(`http://localhost/${hash}`));
}

describe("parseRoute", () => {
  test("basic tab route", () => {
    const r = parse("#/my-repo/chat");
    expect(r.repoId).toBe("my-repo");
    expect(r.tab).toBe("chat");
    expect(r.sessionId).toBeUndefined();
  });

  test("chat with session ID", () => {
    const r = parse("#/repo/chat/uuid-123");
    expect(r.tab).toBe("chat");
    expect(r.sessionId).toBe("uuid-123");
  });

  test("browse with file path", () => {
    const r = parse("#/repo/browse/src%2Fmain.go");
    expect(r.tab).toBe("browse");
    expect(r.filePath).toBe("src/main.go");
  });

  test("browse with blame param", () => {
    const r = parse("#/repo/browse/file.ts?blame=1");
    expect(r.filePath).toBe("file.ts");
    expect(r.blame).toBe(true);
  });

  test("browse with compare param", () => {
    const r = parse("#/repo/browse?compare=main..feature");
    expect(r.compareBase).toBe("main");
    expect(r.compareHead).toBe("feature");
  });

  test("log with commit SHA", () => {
    const r = parse("#/repo/log/abc123");
    expect(r.tab).toBe("log");
    expect(r.commitSha).toBe("abc123");
  });

  test("log with query params", () => {
    const r = parse("#/repo/log/abc?file=src/main.go&split=1&filter=internal");
    expect(r.commitSha).toBe("abc");
    expect(r.logFile).toBe("src/main.go");
    expect(r.splitView).toBe(true);
    expect(r.filterPath).toBe("internal");
  });

  test("kb with card ID", () => {
    const r = parse("#/repo/kb/card-42");
    expect(r.tab).toBe("kb");
    expect(r.cardId).toBe("card-42");
  });

  test("invalid tab defaults to chat", () => {
    const r = parse("#/repo/invalid");
    expect(r.tab).toBe("chat");
  });

  test("empty hash", () => {
    const r = parse("");
    expect(r.repoId).toBe("");
    expect(r.tab).toBe("chat");
  });

  test("no subpath", () => {
    const r = parse("#/repo/log");
    expect(r.commitSha).toBeUndefined();
  });
});

describe("buildRoute", () => {
  test("basic tab", () => {
    expect(buildRoute({ repoId: "repo", tab: "chat" })).toBe("#/repo/chat");
  });

  test("chat with session", () => {
    expect(buildRoute({ repoId: "r", tab: "chat", sessionId: "s1" })).toBe("#/r/chat/s1");
  });

  test("browse with encoded file path", () => {
    const url = buildRoute({ repoId: "r", tab: "browse", filePath: "src/main.go" });
    expect(url).toBe("#/r/browse/src%2Fmain.go");
  });

  test("browse with blame", () => {
    const url = buildRoute({ repoId: "r", tab: "browse", filePath: "f.ts", blame: true });
    expect(url).toBe("#/r/browse/f.ts?blame=1");
  });

  test("log with all params", () => {
    const url = buildRoute({
      repoId: "r",
      tab: "log",
      commitSha: "abc",
      logFile: "main.go",
      splitView: true,
      filterPath: "internal",
    });
    expect(url).toContain("#/r/log/abc");
    expect(url).toContain("file=main.go");
    expect(url).toContain("split=1");
    expect(url).toContain("filter=internal");
  });

  test("omits falsy params", () => {
    const url = buildRoute({ repoId: "r", tab: "log", commitSha: "abc" });
    expect(url).toBe("#/r/log/abc");
    expect(url).not.toContain("?");
  });
});

describe("roundtrip", () => {
  test("chat session survives roundtrip", () => {
    const original: ParsedRoute = { repoId: "repo", tab: "chat", sessionId: "uuid-123" };
    const rebuilt = parse(buildRoute(original));
    expect(rebuilt.repoId).toBe("repo");
    expect(rebuilt.tab).toBe("chat");
    expect(rebuilt.sessionId).toBe("uuid-123");
  });

  test("browse file with blame survives roundtrip", () => {
    const original: ParsedRoute = { repoId: "r", tab: "browse", filePath: "src/lib/foo.ts", blame: true };
    const rebuilt = parse(buildRoute(original));
    expect(rebuilt.filePath).toBe("src/lib/foo.ts");
    expect(rebuilt.blame).toBe(true);
  });

  test("log with all params survives roundtrip", () => {
    const original: ParsedRoute = {
      repoId: "r",
      tab: "log",
      commitSha: "deadbeef",
      logFile: "internal/auth/ssh.go",
      splitView: true,
      filterPath: "internal/auth",
    };
    const rebuilt = parse(buildRoute(original));
    expect(rebuilt.commitSha).toBe("deadbeef");
    expect(rebuilt.logFile).toBe("internal/auth/ssh.go");
    expect(rebuilt.splitView).toBe(true);
    expect(rebuilt.filterPath).toBe("internal/auth");
  });

  test("kb card survives roundtrip", () => {
    const original: ParsedRoute = { repoId: "r", tab: "kb", cardId: "card-abc" };
    const rebuilt = parse(buildRoute(original));
    expect(rebuilt.cardId).toBe("card-abc");
  });
});

describe("routesEqual", () => {
  test("same routes are equal", () => {
    const a: ParsedRoute = { repoId: "r", tab: "chat", sessionId: "s1" };
    const b: ParsedRoute = { repoId: "r", tab: "chat", sessionId: "s1" };
    expect(routesEqual(a, b)).toBe(true);
  });

  test("different session IDs are not equal", () => {
    const a: ParsedRoute = { repoId: "r", tab: "chat", sessionId: "s1" };
    const b: ParsedRoute = { repoId: "r", tab: "chat", sessionId: "s2" };
    expect(routesEqual(a, b)).toBe(false);
  });

  test("different tabs are not equal", () => {
    const a: ParsedRoute = { repoId: "r", tab: "chat" };
    const b: ParsedRoute = { repoId: "r", tab: "log" };
    expect(routesEqual(a, b)).toBe(false);
  });
});

describe("clearStaleState", () => {
  test("switching to chat clears log state", () => {
    const dirty: ParsedRoute = {
      repoId: "r",
      tab: "chat",
      commitSha: "abc",
      logFile: "main.go",
      splitView: true,
    };
    const clean = clearStaleState(dirty);
    expect(clean.commitSha).toBeUndefined();
    expect(clean.logFile).toBeUndefined();
    expect(clean.splitView).toBeUndefined();
  });

  test("switching to log preserves log state", () => {
    const route: ParsedRoute = {
      repoId: "r",
      tab: "log",
      commitSha: "abc",
      splitView: true,
    };
    const clean = clearStaleState(route);
    expect(clean.commitSha).toBe("abc");
    expect(clean.splitView).toBe(true);
  });

  test("switching to browse preserves browse state", () => {
    const route: ParsedRoute = {
      repoId: "r",
      tab: "browse",
      filePath: "main.go",
      blame: true,
    };
    const clean = clearStaleState(route);
    expect(clean.filePath).toBe("main.go");
    expect(clean.blame).toBe(true);
  });
});
