import { expect, test } from '@playwright/test';

// The browser half of the smoke test: every tab of a running Model Duel opens without a script
// error or a Content-Security-Policy violation. It only looks, so real machines are safe.
const TABS = ['Machines', 'Models', 'Text', 'Transcribe', 'Image', 'Results'];

test('every tab opens without script errors or blocked content', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`script error: ${error.message}`));
  page.on('console', (message) => {
    // Machines that are off answer with errors of their own; blocked content and crashes do not.
    const text = message.text();
    if (message.type() === 'error' && !text.startsWith('Failed to load resource')) {
      problems.push(`console: ${text}`);
    }
  });

  // The browser reports every blocked script, style, image or connection as an event.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { cspViolations: seen });
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} blocked ${event.blockedURI || 'inline code'}`);
    });
  });

  await page.goto('/');
  const password = page.getByLabel('Password');
  if (await password.isVisible().catch(() => false)) {
    const secret = process.env.SMOKE_PASSWORD ?? '';
    expect(secret, 'This Model Duel has a password: set SMOKE_PASSWORD.').not.toBe('');
    await password.fill(secret);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  for (const tab of TABS) {
    await page.getByRole('link', { name: tab, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: tab, exact: true })).toBeVisible();
  }
  const violations = await page.evaluate(
    () => (window as unknown as { cspViolations: string[] }).cspViolations,
  );
  expect(violations, 'Content-Security-Policy violations').toEqual([]);
  expect(problems).toEqual([]);
});
