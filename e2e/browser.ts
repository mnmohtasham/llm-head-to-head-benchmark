import { existsSync } from 'node:fs';
import { devices, type Project } from '@playwright/test';

// Use an installed Google Chrome when there is one, so no browser download is needed.
// Otherwise run `npx playwright install chromium` once. E2E_BROWSER=chromium forces the bundled one.
const CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/** The one browser the browser tests and the smoke test run in. */
export function browserProject(): Project {
  const browser =
    process.env.E2E_BROWSER ?? (CHROME_PATHS.some((p) => existsSync(p)) ? 'chrome' : 'chromium');
  return {
    name: browser,
    use: { ...devices['Desktop Chrome'], ...(browser === 'chrome' ? { channel: 'chrome' } : {}) },
  };
}
