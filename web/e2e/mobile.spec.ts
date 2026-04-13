import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate } from "./helpers";

let server: ReturnType<typeof startServer>;
let page: Page;

test.describe("mobile", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    server = startServer();
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    page = await ctx.newPage();
    await authenticate(page, server.url, server.logPath);
  });

  test.afterAll(async () => {
    await page.close();
    server.cleanup();
  });

  test("sidebar hidden by default", async () => {
    const sidebarX = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const sidebar = chat?.shadowRoot?.querySelector(".sidebar");
      return sidebar?.getBoundingClientRect().x ?? 999;
    });
    expect(sidebarX).toBeLessThan(0);
  });

  test("drawer toggle opens sidebar", async () => {
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const btn = chat?.shadowRoot?.querySelector(".drawer-toggle") as HTMLElement;
      btn?.click();
    });
    await page.waitForTimeout(400);

    const sidebarX = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const sidebar = chat?.shadowRoot?.querySelector(".sidebar");
      return sidebar?.getBoundingClientRect().x ?? -999;
    });
    expect(sidebarX).toBeGreaterThanOrEqual(0);

    // Close via backdrop.
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const backdrop = chat?.shadowRoot?.querySelector(".drawer-backdrop") as HTMLElement;
      backdrop?.click();
    });
    await page.waitForTimeout(400);
  });

  test("chat content readable (not zero-width)", async () => {
    const width = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const pane = chat?.shadowRoot?.querySelector(".pane");
      return pane?.getBoundingClientRect().width ?? 0;
    });
    expect(width).toBeGreaterThan(300);
  });

  test("composer usable", async () => {
    const w = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const c = chat?.shadowRoot?.querySelector(".composer-inner");
      return c?.getBoundingClientRect().width ?? 0;
    });
    expect(w).toBeGreaterThan(250);
  });
});
