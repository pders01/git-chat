import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate, clickShadowElement } from "./helpers";

let server: Awaited<ReturnType<typeof startServer>>;
let page: Page;

test.describe("mobile", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    server = await startServer();
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
    await clickShadowElement(page, "gc-app gc-chat-view", ".drawer-toggle");

    // Wait for sidebar animation
    await expect.poll(async () => {
      const sidebarX = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const chat = app?.shadowRoot?.querySelector("gc-chat-view");
        const sidebar = chat?.shadowRoot?.querySelector(".sidebar");
        return sidebar?.getBoundingClientRect().x ?? -999;
      });
      return sidebarX;
    }, { timeout: 5000 }).toBeGreaterThanOrEqual(0);

    // Close via backdrop.
    await clickShadowElement(page, "gc-app gc-chat-view", ".drawer-backdrop");
    
    // Wait for sidebar to close
    await expect.poll(async () => {
      const sidebarX = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const chat = app?.shadowRoot?.querySelector("gc-chat-view");
        const sidebar = chat?.shadowRoot?.querySelector(".sidebar");
        return sidebar?.getBoundingClientRect().x ?? 999;
      });
      return sidebarX;
    }, { timeout: 5000 }).toBeLessThan(0);
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
      const composer = chat?.shadowRoot?.querySelector("gc-composer");
      const c = composer?.shadowRoot?.querySelector(".composer-inner");
      return c?.getBoundingClientRect().width ?? 0;
    });
    expect(w).toBeGreaterThan(250);
  });
});
