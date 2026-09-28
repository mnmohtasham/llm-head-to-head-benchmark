import { defineConfig } from '@playwright/test';
import { browserProject } from '../e2e/browser';

/** The browser half of the smoke test, against a running Model Duel: npm run smoke:browser. */
export default defineConfig({
  testDir: '.',
  testMatch: 'browser.spec.ts',
  outputDir: './test-results',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.SMOKE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [browserProject()],
});
