import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate, clickShadowElement, waitForShadowElement } from "./helpers";

// Shared state: one server, one auth, all tests reuse the same page.
let server: Awaited<ReturnType<typeof startServer>>;
let page: Page;

test.describe("layout", () => {
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

  test("chat: messages and composer aligned", async () => {
    const vw = page.viewportSize()?.width ?? 1440;
    if (vw <= 768) return;
    // The chat pane renders either gc-message-list (when turns exist)
    // or gc-chat-dashboard (empty state). Both apply the same
    // max-width: var(--content-max-width); margin: auto centering that
    // gc-composer uses, so they should share x/w with the composer
    // regardless of which view is active. Fresh auth lands on the
    // empty dashboard; populated sessions exercise the message-list
    // branch.
    const rects = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      if (!chat?.shadowRoot) return null;
      const sr = chat.shadowRoot;
      const inner =
        sr.querySelector("gc-message-list")?.shadowRoot?.querySelector(".messages-inner") ??
        sr.querySelector("gc-chat-dashboard")?.shadowRoot?.querySelector(".empty-chat");
      const composer = sr
        .querySelector("gc-composer")
        ?.shadowRoot?.querySelector(".composer-inner");
      return {
        inner: inner ? { x: Math.round(inner.getBoundingClientRect().x), w: Math.round(inner.getBoundingClientRect().width) } : null,
        composer: composer ? { x: Math.round(composer.getBoundingClientRect().x), w: Math.round(composer.getBoundingClientRect().width) } : null,
      };
    });
    expect(rects).not.toBeNull();
    expect(rects!.inner).not.toBeNull();
    expect(rects!.composer).not.toBeNull();
    expect(rects!.inner!.x).toBe(rects!.composer!.x);
    expect(rects!.inner!.w).toBe(rects!.composer!.w);
  });

  test("sidebar width consistent across chat and browse", async () => {
    const vw = page.viewportSize()?.width ?? 1440;
    if (vw <= 768) return;
    const chatWidth = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      return chat?.shadowRoot?.querySelector(".sidebar")?.getBoundingClientRect().width ?? -1;
    });

    // Switch to browse.
    await clickShadowElement(page, "gc-app", '#tab-browse');
    await expect(page).toHaveURL(/#\/.*\/browse$/);

    const browseWidth = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      return browser?.shadowRoot?.querySelector("aside")?.getBoundingClientRect().width ?? -1;
    });

    expect(chatWidth).toBeGreaterThan(0);
    expect(chatWidth).toBe(browseWidth);

    // Go back to chat.
    await clickShadowElement(page, "gc-app", '#tab-chat');
    await expect(page).toHaveURL(/#\/.*\/chat$/);
  });

  test("tab navigation via clicks", async () => {
    await expect(page).toHaveURL(/#\/.*\/chat$/);

    await clickShadowElement(page, "gc-app", '#tab-browse');
    await expect(page).toHaveURL(/#\/.*\/browse$/);

    await clickShadowElement(page, "gc-app", '#tab-log');
    await expect(page).toHaveURL(/#\/.*\/log$/);

    // Back to chat.
    await clickShadowElement(page, "gc-app", '#tab-chat');
    await expect(page).toHaveURL(/#\/.*\/chat$/);
  });

  test("Ctrl+1/2/3 switch tabs", async () => {
    await page.locator("body").click();

    await page.keyboard.press("Control+2");
    await expect(page).toHaveURL(/#\/.*\/browse$/);

    await page.keyboard.press("Control+3");
    await expect(page).toHaveURL(/#\/.*\/log$/);

    await page.keyboard.press("Control+1");
    await expect(page).toHaveURL(/#\/.*\/chat$/);
  });

  test("? opens shortcut modal", async () => {
    await page.locator("body").click();
    await page.keyboard.press("?");
    await waitForShadowElement(page, "gc-app", 'div[role="dialog"]');

    const visible = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      return !!app?.shadowRoot?.querySelector('div[role="dialog"]');
    });
    expect(visible).toBe(true);

    await page.keyboard.press("Escape");
    await waitForShadowElement(page, "gc-app", 'div[role="dialog"]', { state: 'hidden' });

    const gone = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      return !app?.shadowRoot?.querySelector('div[role="dialog"]');
    });
    expect(gone).toBe(true);
  });

  test("chat empty state shows example buttons", async () => {
    const count = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const dashboard = chat?.shadowRoot?.querySelector("gc-chat-dashboard");
      return dashboard?.shadowRoot?.querySelectorAll(".example")?.length ?? 0;
    });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("log shows commits", async () => {
    await clickShadowElement(page, "gc-app", '#tab-log');
    
    // Wait for commit rows to appear
    await waitForShadowElement(page, "gc-app gc-commit-log", ".commit-row", { timeout: 20000 });
    
    const info = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const log = app?.shadowRoot?.querySelector("gc-commit-log");
      return {
        hidden: log?.hasAttribute("hidden") ?? true,
        rows: log?.shadowRoot?.querySelectorAll(".commit-row")?.length ?? 0,
      };
    });
    expect(info.hidden).toBe(false);
    expect(info.rows).toBeGreaterThan(0);

    // Back to chat for other tests.
    await clickShadowElement(page, "gc-app", '#tab-chat');
  });
});
