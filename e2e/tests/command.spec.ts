import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_AGENT_PORTS, E2E_MOCK_PORTS } from '../ports';

// Phase 12 demo script: each machine has a fake agent; the Command tab runs the same encode on
// both, shows frames per second and speed side by side, and the faster agent wins.
const [MAC, LINUX] = DEMO_MACHINES;

test.describe.configure({ mode: 'serial' });

/** Machines this file added, removed again at the end: the machines spec starts from none. */
const added: string[] = [];

async function ensureMachines(request: APIRequestContext) {
  const existing = (await (await request.get('/api/machines')).json()) as Array<{ name: string }>;
  for (const [index, machine] of DEMO_MACHINES.entries()) {
    if (existing.some((m) => m.name === machine.name)) continue;
    const created = await request.post('/api/machines', {
      data: {
        name: machine.name,
        baseUrl: `127.0.0.1:${E2E_MOCK_PORTS[index]}`,
        apiKey: machine.apiKey,
        agentUrl: `127.0.0.1:${E2E_AGENT_PORTS[index]}`,
        agentToken: machine.agentToken,
      },
    });
    added.push(((await created.json()) as { id: string }).id);
  }
}

const pane = (page: Page, name: string) =>
  page.getByTestId('run-pane').and(page.locator(`[data-machine="${name}"]`));

const choose = (page: Page, group: string, option: string) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

test.beforeAll(async ({ request }) => {
  await ensureMachines(request);
});
test.afterAll(async ({ request }) => {
  for (const id of added) await request.delete(`/api/machines/${id}`);
});

test('runs the same encode on both agents, and the faster one wins', async ({ page }) => {
  await page.goto('/#/command');
  for (const machine of DEMO_MACHINES) {
    const box = page.getByRole('checkbox', { name: new RegExp(machine.name) });
    await expect(box).toBeEnabled();
    await box.setChecked(true);
    await expect(box.locator('xpath=..')).toContainText('fake');
  }
  await expect(
    page.getByRole('radiogroup', { name: 'Encode' }).getByRole('radio', { name: 'Fake encode' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Clip')).toHaveValue('fake-clip.mp4');
  await choose(page, 'Warm-up', 'Off');
  await page.getByRole('textbox', { name: 'Rounds', exact: true }).fill('1');
  await page.getByLabel('Pause between rounds, seconds').fill('0');
  await expect(page.getByTestId('race-notes')).toContainText('The fake encode is scripted');
  await expect(page.getByTestId('preflight-status')).toContainText('All clear');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(pane(page, MAC.name).getByTestId('frame-progress')).toBeVisible();
  for (const machine of DEMO_MACHINES) {
    await expect(pane(page, machine.name).getByTestId('run-state')).toHaveText('Done', {
      timeout: 20_000,
    });
  }
  const fps = async (name: string) =>
    Number(await pane(page, name).getByTestId('encode-fps').textContent());
  expect(await fps(LINUX.name)).toBeGreaterThan(await fps(MAC.name));
  await expect(pane(page, LINUX.name).getByTestId('encode-speed')).toContainText('×');
  await expect(page.getByTestId('frame-chart')).toBeVisible();
  await expect(
    page.getByTestId('compare').getByRole('row', { name: /Frames per second/ }),
  ).toContainText(LINUX.name);
  const details = page.locator('details.run-details').first();
  await details.locator('summary').click();
  await expect(details.getByTestId('command-argv')).toHaveText('fake-encode fake-clip.mp4');
  const row = page.getByTestId('session-row').first();
  await expect(row).toContainText('Encode fake-clip.mp4 with Fake encode');
  await expect(row).toContainText('fps');
});

test('stops a machine whose agent refuses the token', async ({ page, request }) => {
  const machines = (await (await request.get('/api/machines')).json()) as Array<{
    id: string;
    name: string;
    baseUrl: string;
  }>;
  const linux = machines.find((m) => m.name === LINUX.name);
  expect(linux).toBeDefined();
  await request.put(`/api/machines/${linux?.id}`, {
    data: { name: linux?.name, baseUrl: linux?.baseUrl, agentToken: 'not-the-token' },
  });
  try {
    await page.goto('/#/command');
    const box = page.getByRole('checkbox', { name: new RegExp(LINUX.name) });
    await expect(box).toBeEnabled();
    await box.setChecked(true);
    await expect(page.getByTestId('start-blockers')).toContainText(
      'The agent did not accept the token.',
    );
    await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  } finally {
    await request.put(`/api/machines/${linux?.id}`, {
      data: { name: linux?.name, baseUrl: linux?.baseUrl, agentToken: LINUX.agentToken },
    });
  }
});

test('fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/command');
  await expect(page.getByRole('radiogroup', { name: 'Encode' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
