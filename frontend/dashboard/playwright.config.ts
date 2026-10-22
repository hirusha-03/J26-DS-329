import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    channel: "chromium",
    baseURL: "http://127.0.0.1:3101",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } } },
    { name: "narrow", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, reducedMotion: "reduce" } },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3101",
    url: "http://127.0.0.1:3101/disease-detection",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_API_URL: "http://127.0.0.1:8000", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
