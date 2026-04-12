import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: "http://127.0.0.1:18080",
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "desktop",
      testMatch: /layout\.spec|features\.spec/,
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec/,
      use: { viewport: { width: 375, height: 812 } },
    },
  ],
  // Server is started externally via `make test-e2e` — Playwright
  // doesn't manage the Go binary lifecycle.
  webServer: undefined,
});
