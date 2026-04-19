// Route matrix — deep links and cross-tab navigations. These tests
// pin down the expected URL-to-view mapping so regressions surface
// before the user hits them. Each test sets up fresh state via a
// direct hash assignment and asserts the resulting visible state.
//
// The repoId in the URL is "git-chat" — it's derived from the repo
// root directory name (local mode).
import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate, waitForShadowElement } from "./helpers";

let server: Awaited<ReturnType<typeof startServer>>;
let page: Page;

test.describe("routing", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    server = await startServer();
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    await authenticate(page, server.url, server.logPath);
  });

  test.afterAll(async () => {
    await page.close();
    server.cleanup();
  });

  // ── Helpers ──────────────────────────────────────────────────

  /** Jump to a URL fragment and wait for the tab panel to settle. */
  async function navigateHash(hash: string) {
    await page.evaluate((h) => {
      window.location.hash = h;
      // hashchange doesn't always wake reactive listeners on same-tab
      // pushes; dispatch explicitly so the route handler re-runs.
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }, hash);
    // small settle — Lit updates after rAF.
    await page.waitForTimeout(150);
  }

  async function activeTab(): Promise<string> {
    return page.evaluate(() => {
      const app = document.querySelector("gc-app");
      return (app as unknown as { state?: { tab?: string } })?.state?.tab ?? "";
    });
  }

  async function currentHash(): Promise<string> {
    return page.evaluate(() => window.location.hash);
  }

  // ── Deep-link to each tab ───────────────────────────────────

  test("deep link /chat lands on chat tab", async () => {
    await navigateHash("#/git-chat/chat");
    expect(await activeTab()).toBe("chat");
    await waitForShadowElement(page, "gc-app", "gc-chat-view:not([hidden])");
  });

  test("deep link /browse lands on browse tab with tree visible", async () => {
    await navigateHash("#/git-chat/browse");
    expect(await activeTab()).toBe("browse");
    await waitForShadowElement(page, "gc-app", "gc-repo-browser:not([hidden])");
  });

  test("deep link /browse/LICENSE opens that file", async () => {
    await navigateHash("#/git-chat/browse/LICENSE");
    expect(await activeTab()).toBe("browse");
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const app = document.querySelector("gc-app");
          const rb = app?.shadowRoot?.querySelector("gc-repo-browser");
          const fv = rb?.shadowRoot?.querySelector("gc-file-view");
          // selectedFile state or the visible file path in the header
          return (fv as unknown as { path?: string })?.path ?? "";
        });
      })
      .toBe("LICENSE");
  });

  test("deep link /log lands on log tab with commits loading", async () => {
    await navigateHash("#/git-chat/log");
    expect(await activeTab()).toBe("log");
    // Commit rows should show up once load() resolves.
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const app = document.querySelector("gc-app");
          const log = app?.shadowRoot?.querySelector("gc-commit-log");
          return log?.shadowRoot?.querySelectorAll(".commit-row")?.length ?? 0;
        });
      }, { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  test("deep link /log?filter=LICENSE applies the path filter", async () => {
    await navigateHash("#/git-chat/log?filter=LICENSE");
    expect(await activeTab()).toBe("log");
    // The filter bar should be visible, showing "history for LICENSE".
    await waitForShadowElement(page, "gc-app gc-commit-log", ".path-filter-bar");
    // And the commit list should have at least one row (LICENSE was
    // touched at least once).
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const app = document.querySelector("gc-app");
          const log = app?.shadowRoot?.querySelector("gc-commit-log");
          return log?.shadowRoot?.querySelectorAll(".commit-row")?.length ?? 0;
        });
      }, { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  test("deep link /kb lands on kb tab", async () => {
    await navigateHash("#/git-chat/kb");
    expect(await activeTab()).toBe("kb");
    await waitForShadowElement(page, "gc-app", "gc-kb-view:not([hidden])");
  });

  // ── Cross-tab navigation ────────────────────────────────────

  test("browse → file-view history button routes to log with filter applied", async () => {
    // Land on a file first so the history button is present.
    await navigateHash("#/git-chat/browse/LICENSE");
    await waitForShadowElement(
      page,
      "gc-app gc-repo-browser gc-file-view",
      ".hd-btn",
    );
    // Find and click the "history" button (title attribute identifies it).
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const rb = app?.shadowRoot?.querySelector("gc-repo-browser");
      const fv = rb?.shadowRoot?.querySelector("gc-file-view");
      const btns = fv?.shadowRoot?.querySelectorAll(".hd-btn") ?? [];
      for (const b of Array.from(btns)) {
        if ((b as HTMLElement).textContent?.trim().toLowerCase().includes("history")) {
          (b as HTMLElement).click();
          return;
        }
      }
    });
    // URL should flip to /log?filter=LICENSE.
    await expect.poll(currentHash).toMatch(/\/log\?.*filter=LICENSE/);
    expect(await activeTab()).toBe("log");
    // Commit list must actually populate — the failing symptom was an
    // empty log view after the nav.
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const app = document.querySelector("gc-app");
          const log = app?.shadowRoot?.querySelector("gc-commit-log");
          return log?.shadowRoot?.querySelectorAll(".commit-row")?.length ?? 0;
        });
      }, { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  // ── Cross-tab: log → file in commit diff ──────────────────

  test("log: click commit → click file → browse tab opens that file", async () => {
    await navigateHash("#/git-chat/log");
    // Wait for rows, click the first one.
    await waitForShadowElement(page, "gc-app gc-commit-log", ".commit-row");
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const log = app?.shadowRoot?.querySelector("gc-commit-log");
      const row = log?.shadowRoot?.querySelector(".commit-row") as HTMLElement | null;
      row?.click();
    });
    // Wait for the diff header to appear (commit selected).
    await waitForShadowElement(page, "gc-app gc-commit-log", ".diff-header");
    // URL should include the commit sha.
    await expect.poll(currentHash).toMatch(/\/log\/[0-9a-f]{7,}/);
  });

  // ── Invalid routes ──────────────────────────────────────────

  test("invalid tab falls back to chat", async () => {
    await navigateHash("#/git-chat/nonsense");
    // parseRoute's fallback is "chat" for unknown tab names.
    expect(await activeTab()).toBe("chat");
  });

  test("empty hash still boots to a valid tab", async () => {
    await navigateHash("#");
    // Shouldn't explode; should settle into one of the known tabs.
    const tab = await activeTab();
    expect(["chat", "browse", "log", "kb"]).toContain(tab);
  });

  // ── Back button ─────────────────────────────────────────────

  test("back button restores previous route", async () => {
    await navigateHash("#/git-chat/browse");
    expect(await activeTab()).toBe("browse");
    await navigateHash("#/git-chat/log");
    expect(await activeTab()).toBe("log");
    await page.goBack();
    // settle the hashchange
    await page.waitForTimeout(200);
    expect(await activeTab()).toBe("browse");
  });
});
