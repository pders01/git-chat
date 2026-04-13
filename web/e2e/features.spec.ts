import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate } from "./helpers";

let server: Awaited<ReturnType<typeof startServer>>;
let page: Page;

test.describe("features", () => {
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

  // ── Global search ──────────────────────────────────────────

  test("⌘F opens search overlay", async () => {
    await page.locator("body").click();
    await page.keyboard.press("Control+f");
    await page.waitForTimeout(500);

    const visible = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      return !!app?.shadowRoot?.querySelector(".search-input");
    });
    expect(visible).toBe(true);
  });

  test("search returns file results", async () => {
    // Type a query into the search input.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const input = app?.shadowRoot?.querySelector(".search-input") as HTMLInputElement;
      if (input) {
        input.value = "Makefile";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await page.waitForTimeout(500);

    const hitCount = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      return app?.shadowRoot?.querySelectorAll(".search-hit")?.length ?? 0;
    });
    expect(hitCount).toBeGreaterThan(0);

    // Close search.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  // ── Settings ───────────────────────────────────────────────

  test("settings modal opens via gear icon", async () => {
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const btn = app?.shadowRoot?.querySelector(".settings-btn") as HTMLElement;
      btn?.click();
    });
    await page.waitForTimeout(300);

    const visible = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const dialog = app?.shadowRoot?.querySelector('div[role="dialog"][aria-label="Settings"]');
      return !!dialog;
    });
    expect(visible).toBe(true);

    // Close.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const backdrop = app?.shadowRoot?.querySelector(".modal-backdrop") as HTMLElement;
      backdrop?.click();
    });
    await page.waitForTimeout(300);
  });

  // ── Composer ───────────────────────────────────────────────

  test("composer has proper a11y attributes", async () => {
    const attrs = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const ta = chat?.shadowRoot?.querySelector("textarea");
      if (!ta) return null;
      return {
        ariaLabel: ta.getAttribute("aria-label"),
        ariaDescribedby: ta.getAttribute("aria-describedby"),
        ariaAutocomplete: ta.getAttribute("aria-autocomplete"),
      };
    });
    expect(attrs).not.toBeNull();
    expect(attrs!.ariaLabel).toContain("Message input");
    expect(attrs!.ariaDescribedby).toBe("composer-status");
    expect(attrs!.ariaAutocomplete).toBe("list");
  });

  test("composer status has role=status", async () => {
    const role = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const hint = chat?.shadowRoot?.querySelector("#composer-status");
      return hint?.getAttribute("role");
    });
    expect(role).toBe("status");
  });

  // ── Focus mode ─────────────────────────────────────────────

  test("focus toggle hides sidebar", async () => {
    // Click focus button.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const btn = chat?.shadowRoot?.querySelector(".focus-btn") as HTMLElement;
      btn?.click();
    });
    await page.waitForTimeout(300);

    const sidebarWidth = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const sidebar = chat?.shadowRoot?.querySelector(".sidebar");
      return sidebar?.getBoundingClientRect().width ?? -1;
    });
    // Sidebar should be collapsed (0 or very small).
    expect(sidebarWidth).toBeLessThanOrEqual(1);

    // Toggle back.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const btn = chat?.shadowRoot?.querySelector(".focus-btn") as HTMLElement;
      btn?.click();
    });
    await page.waitForTimeout(300);
  });

  // ── Export button ──────────────────────────────────────────

  test("export button not visible when no session selected", async () => {
    const visible = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      return !!chat?.shadowRoot?.querySelector(".export-btn");
    });
    expect(visible).toBe(false);
  });

  // ── Log view ───────────────────────────────────────────────

  test("log commit list loads and is clickable", async () => {
    // Switch to log tab via the tab button with id="tab-log".
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const logTab = app?.shadowRoot?.querySelector('#tab-log') as HTMLElement;
      logTab?.click();
    });
    // Verify tab is active, then poll for commit rows.
    await expect(async () => {
      const info = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const log = app?.shadowRoot?.querySelector("gc-commit-log");
        return {
          exists: !!log,
          hidden: log?.hasAttribute("hidden") ?? true,
          rows: log?.shadowRoot?.querySelectorAll(".commit-row")?.length ?? 0,
          phase: (log as any)?.state?.phase ?? "unknown",
        };
      });
      // Log must exist, be visible, and have rows.
      expect(info.hidden).toBe(false);
      expect(info.rows).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000 });

    // Click first commit.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const log = app?.shadowRoot?.querySelector("gc-commit-log");
      const row = log?.shadowRoot?.querySelector(".commit-row") as HTMLElement;
      row?.click();
    });
    await page.waitForTimeout(1000);

    // Detail header should appear.
    const hasDetail = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const log = app?.shadowRoot?.querySelector("gc-commit-log");
      return !!log?.shadowRoot?.querySelector(".diff-header");
    });
    expect(hasDetail).toBe(true);

    // Back to chat.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[0] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
  });

  // ── Search navigation ───────────────────────────────────────

  test("search: ↑↓ keyboard navigation highlights results", async () => {
    await page.locator("body").click();
    await page.keyboard.press("Control+f");
    await page.waitForTimeout(300);

    // Type query that returns results.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const input = app?.shadowRoot?.querySelector(".search-input") as HTMLInputElement;
      if (input) {
        input.value = "go";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await page.waitForTimeout(300);

    // Arrow down should move selection.
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);

    const selectedIdx = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const selected = app?.shadowRoot?.querySelector(".search-hit.selected");
      if (!selected) return -1;
      const hits = [...(app?.shadowRoot?.querySelectorAll(".search-hit") ?? [])];
      return hits.indexOf(selected);
    });
    expect(selectedIdx).toBeGreaterThanOrEqual(0);

    // Close search.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("search: Enter on file result opens browse with file", async () => {
    // Switch back to chat first.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[0] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);

    // Open search and find Makefile.
    await page.locator("body").click();
    await page.keyboard.press("Control+f");
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const input = app?.shadowRoot?.querySelector(".search-input") as HTMLInputElement;
      if (input) {
        input.value = "Makefile";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await page.waitForTimeout(500);

    // Press Enter to activate first result.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    // Should be on browse tab.
    await expect(page).toHaveURL(/#\/.*\/browse/);

    // File should be selected (file-view header visible).
    const hasFileHeader = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      const fileView = browser?.shadowRoot?.querySelector("gc-file-view");
      return !!fileView?.shadowRoot?.querySelector(".hd");
    });
    expect(hasFileHeader).toBe(true);

    // Back to chat.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[0] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
  });

  test("search: command palette style (not centered modal)", async () => {
    await page.locator("body").click();
    await page.keyboard.press("Control+f");
    await page.waitForTimeout(300);

    const rect = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const palette = app?.shadowRoot?.querySelector(".search-palette");
      if (!palette) return null;
      const r = palette.getBoundingClientRect();
      return { top: Math.round(r.top), width: Math.round(r.width) };
    });
    expect(rect).not.toBeNull();
    // Should be near top of viewport (60px), not vertically centered.
    expect(rect!.top).toBeLessThan(100);
    // Should be max ~560px wide (+ 2px border).
    expect(rect!.width).toBeLessThanOrEqual(564);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  // ── Browse file view ───────────────────────────────────────

  test("browse: clicking file shows content", async () => {
    // Switch to browse.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[1] as HTMLElement)?.click();
    });
    await page.waitForTimeout(1000);

    // Click README.md (or first file).
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      const files = browser?.shadowRoot?.querySelectorAll(".entry.file");
      (files?.[0] as HTMLElement)?.click();
    });
    await page.waitForTimeout(1000);

    // File view should have content (header visible).
    const hasHeader = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      const fileView = browser?.shadowRoot?.querySelector("gc-file-view");
      return !!fileView?.shadowRoot?.querySelector(".hd");
    });
    expect(hasHeader).toBe(true);

    // Back to chat.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[0] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
  });

  // ── Blame → Log navigation ─────────────────────────────────

  test("blame: 'view in log' navigates to log and selects commit", async () => {
    // Switch to browse.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[1] as HTMLElement)?.click();
    });
    await page.waitForTimeout(1000);

    // Click first file.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      const files = browser?.shadowRoot?.querySelectorAll(".entry.file");
      (files?.[0] as HTMLElement)?.click();
    });
    await page.waitForTimeout(1000);

    // Toggle blame on.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      const fileView = browser?.shadowRoot?.querySelector("gc-file-view");
      const blameBtns = fileView?.shadowRoot?.querySelectorAll(".hd-btn");
      // blame is the second .hd-btn (after history)
      (blameBtns?.[1] as HTMLElement)?.click();
    });
    await page.waitForTimeout(1500);

    // Check blame table rendered.
    const hasBlameTable = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      const fileView = browser?.shadowRoot?.querySelector("gc-file-view");
      return !!fileView?.shadowRoot?.querySelector(".blame-table");
    });
    expect(hasBlameTable).toBe(true);

    // Grab a full SHA from the first blame cell via the DOM's dataset.
    // The blame-cell has data-idx; we read the commit SHA from the tooltip data.
    const sha = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      const fileView = browser?.shadowRoot?.querySelector("gc-file-view");
      // The blame-sha span shows 7 chars; get the full SHA via the bt-sha in the tooltip.
      // Easier: simulate a hover to populate hoveredBlame, then read bt-sha.
      // Simplest: just grab from the rendered blame-sha text (short) — the commit-log
      // can match by prefix.
      const shaSpan = fileView?.shadowRoot?.querySelector(".blame-sha");
      return shaSpan?.textContent?.trim() ?? "";
    });
    expect(sha.length).toBeGreaterThan(0);

    // Simulate the blame → log bridge by dispatching gc:view-commit.
    await page.evaluate(async (commitSha) => {
      const app = document.querySelector("gc-app");
      if (!app) return;
      const browser = app.shadowRoot?.querySelector("gc-repo-browser");
      const fileView = browser?.shadowRoot?.querySelector("gc-file-view");
      const source = fileView ?? app;
      source.dispatchEvent(new CustomEvent("gc:view-commit", {
        bubbles: true,
        composed: true,
        detail: { sha: commitSha },
      }));
    }, sha);
    await page.waitForTimeout(4000);

    // Should be on log tab now.
    await expect(page).toHaveURL(/#\/.*\/log/);

    // Wait for commit list to load and selection to apply.
    await page.waitForTimeout(1000);

    // A commit row should be selected.
    const hasSelectedCommit = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const log = app?.shadowRoot?.querySelector("gc-commit-log");
      return !!log?.shadowRoot?.querySelector(".commit-row.selected");
    });
    expect(hasSelectedCommit).toBe(true);
  });
});
