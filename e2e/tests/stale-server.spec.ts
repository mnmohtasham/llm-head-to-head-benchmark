import { expect, test, type APIRequestContext } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_MOCK_PORTS } from '../ports';

// A server left running through a rebuild serves the new page but still has the old routes. The
// page must say so, instead of failing with a bare "Not found".

async function ensureMachines(request: APIRequestContext) {
  const existing = (await (await request.get('/api/machines')).json()) as Array<{ name: string }>;
  for (const [index, machine] of DEMO_MACHINES.entries()) {
    if (existing.some((m) => m.name === machine.name)) continue;
    await request.post('/api/machines', {
      data: {
        name: machine.name,
        baseUrl: `127.0.0.1:${E2E_MOCK_PORTS[index]}`,
        apiKey: machine.apiKey,
      },
    });
  }
}

test.beforeAll(async ({ request }) => {
  await ensureMachines(request);
});

test('shows no warning when the page and the server come from the same build', async ({ page }) => {
  const health = page.waitForResponse((response) => response.url().endsWith('/api/health'));
  await page.goto('/#/models');
  await health;
  await expect(page.getByTestId('model-pane').first()).toBeVisible();
  await expect(page.getByTestId('stale-server')).toHaveCount(0);
});

test('explains an older server instead of showing "Not found"', async ({ page }) => {
  // What a server started before phase 3 answers.
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { ok: true, app: 'model-duel', version: '0.1.0' } }),
  );
  await page.route(/\/api\/machines\/[^/]+\/(status|models)/, (route) =>
    route.fulfill({ status: 404, json: { error: 'not_found', message: 'Not found.' } }),
  );
  await page.goto('/#/models');
  await expect(page.getByTestId('stale-server')).toContainText('come from different builds');
  await expect(page.getByTestId('stale-server')).toContainText('npm start');
  const pane = page.getByTestId('model-pane').first();
  await expect(pane).toContainText('probably older than this page');
  await expect(pane).not.toContainText('Not found.');
});
