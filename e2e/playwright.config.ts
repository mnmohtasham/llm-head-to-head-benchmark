import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { E2E_AGENT_PORTS, E2E_APP_PORT, E2E_CLOUD_PORTS, E2E_MOCK_PORTS } from './ports';

const root = fileURLToPath(new URL('..', import.meta.url));

// Use an installed Google Chrome when there is one, so no browser download is needed.
// Otherwise run `npx playwright install chromium` once. E2E_BROWSER=chromium forces the bundled one.
const CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser =
  process.env.E2E_BROWSER ?? (CHROME_PATHS.some((p) => existsSync(p)) ? 'chrome' : 'chromium');

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
  projects: [
    {
      name: browser,
      use: { ...devices['Desktop Chrome'], ...(browser === 'chrome' ? { channel: 'chrome' } : {}) },
    },
  ],
  webServer: {
    command: `npx tsx scripts/demo.ts --port ${E2E_APP_PORT} --mock-ports ${E2E_MOCK_PORTS.join(',')} --agent-ports ${E2E_AGENT_PORTS.join(',')} --cloud-ports ${E2E_CLOUD_PORTS.join(',')} --data-dir e2e/.data --no-seed`,
    cwd: root,
    url: `http://127.0.0.1:${E2E_APP_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    // A short telemetry baseline keeps every race in the suite quick.
    env: { MODEL_DUEL_TELEMETRY_BASELINE_MS: '300' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
