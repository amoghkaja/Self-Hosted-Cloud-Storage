import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke test against a running stack (dev servers or docker compose).
 *   E2E_BASE_URL=http://localhost:5173 E2E_SETUP_TOKEN=... pnpm e2e
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
