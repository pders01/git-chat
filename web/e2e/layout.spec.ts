import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate } from "./helpers";

// Shared state: one server, one auth, all tests reuse the same page.
let server: ReturnType<typeof startServer>;
let page: Page;

test.describe("layout", () => {
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

  test("chat: messages and composer aligned", async () => {
    const vw = page.viewportSize()?.width ?? 1440;
    if (vw <= 768) return;
    const rects = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      if (!chat?.shadowRoot) return null;
      const sr = chat.shadowRoot;
      const inner = sr.querySelector(".messages-inner");
      const composer = sr.querySelector(".composer-inner");
      return {
        inner: inner ? { x: Math.round(inner.getBoundingClientRect().x), w: Math.round(inner.getBoundingClientRect().width) } : null,
        composer: composer ? { x: Math.round(composer.getBoundingClientRect().x), w: Math.round(composer.getBoundingClientRect().width) } : null,
      };
    });
    expect(rects).not.toBeNull();
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
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[1] as HTMLElement)?.click();
    });
    await page.waitForTimeout(500);

    const browseWidth = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const browser = app?.shadowRoot?.querySelector("gc-repo-browser");
      return browser?.shadowRoot?.querySelector("aside")?.getBoundingClientRect().width ?? -1;
    });

    expect(chatWidth).toBeGreaterThan(0);
    expect(chatWidth).toBe(browseWidth);

    // Go back to chat.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[0] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
  });

  test("tab navigation via clicks", async () => {
    await expect(page).toHaveURL(/#\/.*\/chat$/);

    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[1] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#\/.*\/browse$/);

    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[2] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#\/.*\/log$/);

    // Back to chat.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[0] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#\/.*\/chat$/);
  });

  test("Ctrl+1/2/3 switch tabs", async () => {
    await page.locator("body").click();

    await page.keyboard.press("Control+2");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#\/.*\/browse$/);

    await page.keyboard.press("Control+3");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#\/.*\/log$/);

    await page.keyboard.press("Control+1");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#\/.*\/chat$/);
  });

  test("? opens shortcut modal", async () => {
    await page.locator("body").click();
    await page.keyboard.press("?");
    await page.waitForTimeout(300);

    const visible = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      return !!app?.shadowRoot?.querySelector('div[role="dialog"]');
    });
    expect(visible).toBe(true);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

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
      return chat?.shadowRoot?.querySelectorAll(".example")?.length ?? 0;
    });
    expect(count).toBe(2);
  });

  test("log shows commits", async () => {
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

    // Back to chat for other tests.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const tabs = app?.shadowRoot?.querySelectorAll('button[role="tab"]');
      (tabs?.[0] as HTMLElement)?.click();
    });
  });
});
