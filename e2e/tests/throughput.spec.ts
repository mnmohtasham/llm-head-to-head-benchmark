import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_MOCK_PORTS } from '../ports';

// Phase 11 demo script: switch the Text tab to throughput, let pre-flight reload each model with
// four slots, and race four requests at once per machine.
const MOCKS = [`http://127.0.0.1:${E2E_MOCK_PORTS[0]}`, `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`];

test.describe.configure({ mode: 'serial' });

async function resetMocks(request: APIRequestContext) {
  for (const mock of MOCKS) {
    await request.post(`${mock}/__mock/reset`);
    await request.post(`${mock}/__mock/config`, {
      data: {
        loadMs: 300,
        stream: { startupMs: 150, tokenMs: 12, jitterMs: 0, reasoningTokens: 0, answerTokens: 40 },
      },
    });
  }
}

const pane = (page: Page, name: string) =>
  page.getByTestId('run-pane').and(page.locator(`[data-machine="${name}"]`));

const choose = (page: Page, group: string, option: string) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

test.beforeAll(async ({ request }) => {
  // The machines spec added both machines; this one only uses them.
  const machines = (await (await request.get('/api/machines')).json()) as unknown[];
  expect(machines.length).toBeGreaterThanOrEqual(2);
});
test.beforeEach(async ({ request }) => {
  await resetMocks(request);
});
test.afterAll(async ({ request }) => {
  await resetMocks(request);
});

test('races four requests at once per machine, after reloading with four slots', async ({
  page,
}) => {
  await page.goto('/#/text');
  for (const machine of DEMO_MACHINES) {
    const box = page.getByRole('checkbox', { name: new RegExp(machine.name) });
    await expect(box).toBeEnabled();
    await box.setChecked(true);
  }
  await choose(page, 'Thinking', 'Off');
  await choose(page, 'Warm-up', 'Off');
  await choose(page, 'Prompt', 'Custom');
  await page.getByRole('textbox', { name: 'Rounds', exact: true }).fill('1');
  await page.getByLabel('Pause between rounds, seconds').fill('0');
  await choose(page, 'Mode', 'Throughput');
  await page.getByLabel('Requests at once').fill('4');

  const blockers = page.getByTestId('start-blockers');
  await expect(blockers).toContainText('serves 1 request at once, so 3 of the 4 would wait');
  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  for (const button of await page.getByRole('button', { name: 'Reload with 4 slots' }).all()) {
    await button.click();
  }
  await expect(page.getByTestId('preflight-status')).toContainText('All clear', {
    timeout: 20_000,
  });

  await page.getByRole('button', { name: 'Start' }).click();
  for (const machine of DEMO_MACHINES) {
    await expect(pane(page, machine.name).getByTestId('run-state')).toHaveText('Done', {
      timeout: 20_000,
    });
    await expect(pane(page, machine.name).getByTestId('requests-done')).toHaveText('4/4');
    await expect(pane(page, machine.name).getByTestId('aggregate')).not.toHaveText('n/a');
    await expect(pane(page, machine.name).getByTestId('batch-note')).toContainText(
      'request 1 of 4',
    );
  }
  await expect(
    page.getByTestId('compare').getByRole('row', { name: /Aggregate output speed/ }),
  ).toBeVisible();
  const details = page.locator('details.run-details').first();
  await details.locator('summary').click();
  await expect(details.getByTestId('throughput-table')).toContainText('4 requests at once');
  await expect(details.getByTestId('throughput-table')).toContainText(
    'No request waited for a slot',
  );
  await expect(page.getByTestId('session-row').first()).toContainText('tok/s together');
});
