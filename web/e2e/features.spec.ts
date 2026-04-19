import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate, waitForShadowElement, clickShadowElement, typeInShadowInput, getShadowElementCount } from "./helpers";

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
    
    await waitForShadowElement(page, "gc-app", ".search-input", { timeout: 5000 });
    
    const visible = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      return !!app?.shadowRoot?.querySelector(".search-input");
    });
    expect(visible).toBe(true);
    
    // Close search - ensure input is focused first
    await clickShadowElement(page, "gc-app", ".search-input");
    await page.keyboard.press("Escape");
    
    // Wait for search to be removed from DOM
    await expect.poll(async () => {
      const hasSearch = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        return !!app?.shadowRoot?.querySelector(".search-input");
      });
      return hasSearch;
    }, { timeout: 5000 }).toBe(false);
  });

  test("search returns file results", async () => {
    await page.locator("body").click();
    await page.keyboard.press("Control+f");
    await waitForShadowElement(page, "gc-app", ".search-input");

    // Type a query into the search input; poll for results (debounce + render).
    await typeInShadowInput(page, "gc-app", ".search-input", "Makefile");
    await waitForShadowElement(page, "gc-app", ".search-hit");
    
    const hitCount = await getShadowElementCount(page, "gc-app", ".search-hit");
    expect(hitCount).toBeGreaterThan(0);

    // Close search - ensure focus first
    await clickShadowElement(page, "gc-app", ".search-input");
    await page.keyboard.press("Escape");
    await waitForShadowElement(page, "gc-app", ".search-input", { state: 'hidden' });
  });

  // ── Settings ───────────────────────────────────────────────

  test("settings modal opens via gear icon", async () => {
    await clickShadowElement(page, "gc-app", ".settings-btn");
    await waitForShadowElement(page, "gc-app gc-settings-panel", '[role="dialog"][aria-label="Settings"]');

    const visible = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
      const dialog = panel?.shadowRoot?.querySelector('div[role="dialog"][aria-label="Settings"]');
      return !!dialog;
    });
    expect(visible).toBe(true);

    // Close.
    await clickShadowElement(page, "gc-app gc-settings-panel", ".modal-backdrop");
    await waitForShadowElement(page, "gc-app gc-settings-panel", '[role="dialog"][aria-label="Settings"]', { state: 'hidden' });
  });

  // ── Composer ───────────────────────────────────────────────

  test("composer has proper a11y attributes", async () => {
    const attrs = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const composer = chat?.shadowRoot?.querySelector("gc-composer");
      const ta = composer?.shadowRoot?.querySelector("textarea");
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
      const composer = chat?.shadowRoot?.querySelector("gc-composer");
      const hint = composer?.shadowRoot?.querySelector("#composer-status");
      return hint?.getAttribute("role");
    });
    expect(role).toBe("status");
  });

  // ── Focus mode ─────────────────────────────────────────────

  test("focus toggle hides sidebar", async () => {
    // Get initial sidebar width
    const initialWidth = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const sidebar = chat?.shadowRoot?.querySelector(".sidebar");
      return sidebar?.getBoundingClientRect().width ?? -1;
    });
    
    // Click focus button.
    await clickShadowElement(page, "gc-app gc-chat-view", ".focus-btn");
    
    // Wait for sidebar to collapse (animation + state change)
    await expect.poll(async () => {
      const width = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const chat = app?.shadowRoot?.querySelector("gc-chat-view");
        const sidebar = chat?.shadowRoot?.querySelector(".sidebar");
        return sidebar?.getBoundingClientRect().width ?? -1;
      });
      return width;
    }, { timeout: 5000 }).toBeLessThanOrEqual(1);

    // Toggle back.
    await clickShadowElement(page, "gc-app gc-chat-view", ".focus-btn");
    
    // Wait for sidebar to expand back
    await expect.poll(async () => {
      const width = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const chat = app?.shadowRoot?.querySelector("gc-chat-view");
        const sidebar = chat?.shadowRoot?.querySelector(".sidebar");
        return sidebar?.getBoundingClientRect().width ?? -1;
      });
      return width;
    }, { timeout: 5000 }).toBeGreaterThan(1);
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
    await clickShadowElement(page, "gc-app gc-commit-log", ".commit-row");

    // Wait for detail header to appear.
    await waitForShadowElement(page, "gc-app gc-commit-log", ".diff-header");

    // Back to chat.
    await clickShadowElement(page, "gc-app", '#tab-chat');
    await expect(page).toHaveURL(/#\/.*\/chat$/);
  });

  test("diff pane: split toggle renders two columns", async () => {
    // Re-enter log + pick a commit so the diff pane has something to
    // render. Sequential test sharing state with the one above would
    // be fragile, so we set the stage fresh.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const logTab = app?.shadowRoot?.querySelector("#tab-log") as HTMLElement;
      logTab?.click();
    });
    await expect(async () => {
      const rows = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const log = app?.shadowRoot?.querySelector("gc-commit-log");
        return log?.shadowRoot?.querySelectorAll(".commit-row")?.length ?? 0;
      });
      expect(rows).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });
    await clickShadowElement(page, "gc-app gc-commit-log", ".commit-row");
    await waitForShadowElement(page, "gc-app gc-commit-log", ".diff-header");
    // Wait for the diff pane to finish loading so the toggle button
    // actually reacts (it's disabled / no-op on an empty pane).
    await waitForShadowElement(page, "gc-app gc-commit-log gc-diff-pane", ".diff-content");

    // Click the split toggle in commit-log's shadow root.
    await clickShadowElement(page, "gc-app gc-commit-log", ".split-toggle");

    // Verify the pane now renders the split layout (.split-diff is
    // only present in the split branch of diff-pane's render).
    await expect(async () => {
      const hasSplit = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const log = app?.shadowRoot?.querySelector("gc-commit-log");
        const pane = log?.shadowRoot?.querySelector("gc-diff-pane");
        return !!pane?.shadowRoot?.querySelector(".split-diff");
      });
      expect(hasSplit).toBe(true);
    }).toPass({ timeout: 5_000 });

    // Toggle back to unified. `.split-diff` should disappear.
    await clickShadowElement(page, "gc-app gc-commit-log", ".split-toggle");
    await expect(async () => {
      const hasSplit = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const log = app?.shadowRoot?.querySelector("gc-commit-log");
        const pane = log?.shadowRoot?.querySelector("gc-diff-pane");
        return !!pane?.shadowRoot?.querySelector(".split-diff");
      });
      expect(hasSplit).toBe(false);
    }).toPass({ timeout: 5_000 });
  });

  // ── Search navigation ───────────────────────────────────────

  test("search: ↑↓ keyboard navigation highlights results", async () => {
    await page.locator("body").click();
    await page.keyboard.press("Control+f");
    await waitForShadowElement(page, "gc-app", ".search-input");

    // Type query that returns results; poll for results (debounce + render).
    await typeInShadowInput(page, "gc-app", ".search-input", "go");
    await waitForShadowElement(page, "gc-app", ".search-hit");

    // Ensure input has focus before keyboard navigation
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const input = app?.shadowRoot?.querySelector(".search-input") as HTMLInputElement;
      input?.focus();
    });

    // Arrow down should move selection.
    await page.keyboard.press("ArrowDown");
    
    // Wait for selection to move (Lit render + RAF)
    await expect.poll(async () => {
      const hasSelection = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        return !!app?.shadowRoot?.querySelector(".search-hit.selected");
      });
      return hasSelection;
    }, { timeout: 5000 }).toBe(true);

    const selectedIdx = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const selected = app?.shadowRoot?.querySelector(".search-hit.selected");
      if (!selected) return -1;
      const hits = [...(app?.shadowRoot?.querySelectorAll(".search-hit") ?? [])];
      return hits.indexOf(selected);
    });
    expect(selectedIdx).toBeGreaterThanOrEqual(0);

    // Close search.
    await clickShadowElement(page, "gc-app", ".search-input");
    await page.keyboard.press("Escape");
    await waitForShadowElement(page, "gc-app", ".search-input", { state: 'hidden' });
  });

  test("search: Enter on file result opens browse with file", async () => {
    // Ensure we're on chat tab first.
    await clickShadowElement(page, "gc-app", '#tab-chat');
    await expect(page).toHaveURL(/#\/.*\/chat$/);

    // Open search and find Makefile.
    await page.locator("body").click();
    await page.keyboard.press("Control+f");
    await waitForShadowElement(page, "gc-app", ".search-input");

    await typeInShadowInput(page, "gc-app", ".search-input", "Makefile");
    await waitForShadowElement(page, "gc-app", ".search-hit");

    // Ensure focus and select first result
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const input = app?.shadowRoot?.querySelector(".search-input") as HTMLInputElement;
      input?.focus();
    });
    await page.keyboard.press("ArrowDown");
    
    // Wait for selection
    await expect.poll(async () => {
      const selected = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        return !!app?.shadowRoot?.querySelector(".search-hit.selected");
      });
      return selected;
    }, { timeout: 3000 }).toBe(true);
    
    await page.keyboard.press("Enter");

    // Should be on browse tab.
    await expect(page).toHaveURL(/#\/.*\/browse/);

    // File should be selected (file-view header visible).
    await waitForShadowElement(page, "gc-app gc-repo-browser gc-file-view", ".hd");

    // Back to chat.
    await clickShadowElement(page, "gc-app", '#tab-chat');
    await expect(page).toHaveURL(/#\/.*\/chat$/);
  });

  test("search: command palette style (not centered modal)", async () => {
    await page.locator("body").click();
    await page.keyboard.press("Control+f");
    await waitForShadowElement(page, "gc-app", ".search-palette", { timeout: 10000 });

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

    // Click on input to ensure focus is in search, then close
    await clickShadowElement(page, "gc-app", ".search-input");
    await page.keyboard.press("Escape");
    
    // Palette is removed from DOM when closed (conditional rendering)
    await expect.poll(async () => {
      const hasPalette = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        return !!app?.shadowRoot?.querySelector(".search-palette");
      });
      return hasPalette;
    }, { timeout: 5000 }).toBe(false);
  });

  // ── Browse file view ───────────────────────────────────────

  test("browse: clicking file shows content", async () => {
    // Switch to browse.
    await clickShadowElement(page, "gc-app", '#tab-browse');
    await expect(page).toHaveURL(/#\/.*\/browse$/);

    // Wait for file tree and click first file.
    await waitForShadowElement(page, "gc-app gc-repo-browser", ".entry.file");
    await clickShadowElement(page, "gc-app gc-repo-browser", ".entry.file");
    
    // File view should have content (header visible).
    await waitForShadowElement(page, "gc-app gc-repo-browser gc-file-view", ".hd");

    // Back to chat.
    await clickShadowElement(page, "gc-app", '#tab-chat');
    await expect(page).toHaveURL(/#\/.*\/chat$/);
  });

  // ── Blame → Log navigation ─────────────────────────────────

  test("blame: 'view in log' navigates to log and selects commit", async () => {
    // Switch to browse.
    await clickShadowElement(page, "gc-app", '#tab-browse');
    await expect(page).toHaveURL(/#\/.*\/browse$/);

    // Wait for and click first file.
    await waitForShadowElement(page, "gc-app gc-repo-browser", ".entry.file");
    await clickShadowElement(page, "gc-app gc-repo-browser", ".entry.file");
    
    // Wait for file view to load.
    await waitForShadowElement(page, "gc-app gc-repo-browser gc-file-view", ".hd");

    // Toggle blame on (second .hd-btn after history).
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      const fileView = browser?.shadowRoot?.querySelector("gc-file-view");
      const blameBtns = fileView?.shadowRoot?.querySelectorAll(".hd-btn");
      (blameBtns?.[1] as HTMLElement)?.click();
    });
    
    // Wait for blame table to render with content.
    await waitForShadowElement(page, "gc-app gc-repo-browser gc-file-view", ".blame-table", { timeout: 10000 });
    
    // Wait for blame data to load (SHA text appears)
    await expect.poll(async () => {
      const sha = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
        const fileView = browser?.shadowRoot?.querySelector("gc-file-view");
        const shaSpan = fileView?.shadowRoot?.querySelector(".blame-sha");
        return shaSpan?.textContent?.trim() ?? "";
      });
      return sha.length;
    }, { timeout: 10000 }).toBeGreaterThan(0);

    // Grab the SHA for the event dispatch
    const sha = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      const fileView = browser?.shadowRoot?.querySelector("gc-file-view");
      const shaSpan = fileView?.shadowRoot?.querySelector(".blame-sha");
      return shaSpan?.textContent?.trim() ?? "";
    });

    // Simulate the blame → log bridge by dispatching gc:view-commit.
    await page.evaluate((commitSha) => {
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

    // Should be on log tab now.
    await expect(page).toHaveURL(/#\/.*\/log/);

    // Wait for commit list to load and selection to apply.
    await waitForShadowElement(page, "gc-app gc-commit-log", ".commit-row.selected", { timeout: 10000 });
  });

  // ── Multi-repo command palette ──────────────────────────────

  test.skip("command palette shows repo switcher when multiple repos", async () => {
    // Skipped: e2e setup only has a single repo, so this test cannot assert
    // repo-switcher presence. Enable when multi-repo e2e fixture exists.
    await page.keyboard.press("Control+k");
    await waitForShadowElement(page, "gc-app", ".palette");

    const hasRepoSwitcher = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const palette = app?.shadowRoot?.querySelector(".palette");
      const items = palette?.querySelectorAll(".palette-item");
      let found = false;
      items?.forEach((item) => {
        if (item.textContent?.includes("Switch to:")) {
          found = true;
        }
      });
      return found;
    });

    expect(hasRepoSwitcher).toBe(true);

    await page.keyboard.press("Escape");
    await waitForShadowElement(page, "gc-app", ".palette", { state: 'hidden' });
  });
});
