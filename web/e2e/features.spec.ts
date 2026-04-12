import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate } from "./helpers";

let server: ReturnType<typeof startServer>;
let page: Page;

test.describe("features", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    server = startServer();
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    await authenticate(page, server.url);
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
    // Switch to log.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[2] as HTMLElement)?.click();
    });
    await page.waitForTimeout(1000);

    const commitCount = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const log = app?.shadowRoot?.querySelector("gc-commit-log");
      return log?.shadowRoot?.querySelectorAll(".commit-row")?.length ?? 0;
    });
    expect(commitCount).toBeGreaterThan(0);

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
      return !!log?.shadowRoot?.querySelector(".detail-header");
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
});
