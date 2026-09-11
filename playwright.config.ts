import { defineConfig, devices } from "@playwright/test";

// The tests build the page they need and load the built library into it, so there is no server and
// no site to keep in step: what runs is the tarball's own `dist/index.js`.
export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "on-first-retry" },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "webkit", use: devices["Desktop Safari"] },
    { name: "firefox", use: devices["Desktop Firefox"] },
  ],
});
