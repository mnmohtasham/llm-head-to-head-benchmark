import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserProject } from './browser';
import { E2E_APP_PORT, E2E_AUTH_APP_PORT } from './ports';

const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${E2E_APP_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [browserProject()],
  webServer: [
    {
      command: 'npx tsx e2e/serve.ts',
      cwd: root,
      url: `http://127.0.0.1:${E2E_APP_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      // A short telemetry baseline keeps every race in the suite quick.
      env: { DUEL_TELEMETRY_BASELINE_MS: '300' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npx tsx e2e/serve.ts --auth',
      cwd: root,
      url: `http://127.0.0.1:${E2E_AUTH_APP_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
