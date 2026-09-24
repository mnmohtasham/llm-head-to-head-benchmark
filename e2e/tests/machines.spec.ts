import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_MOCK_PORTS } from '../ports';

// Phase 1 demo script: add two machines, probe them, break one, fix it, edit, export, delete.
const [MAC, LINUX] = DEMO_MACHINES;
const MAC_ADDRESS = `127.0.0.1:${E2E_MOCK_PORTS[0]}`;
const LINUX_ADDRESS = `127.0.0.1:${E2E_MOCK_PORTS[1]}`;
const LINUX_CONTROL = `http://127.0.0.1:${E2E_MOCK_PORTS[1]}/__mock`;
const CAPABILITIES = ['reachable', 'key', 'text', 'stt', 'image', 'telemetry'];

test.describe.configure({ mode: 'serial' });

function card(page: Page, name: string) {
  return page
    .getByTestId('machine-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}

async function addMachine(page: Page, name: string, address: string, key?: string) {
  await page.getByRole('button', { name: 'Add machine' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add machine' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Address', { exact: true }).fill(address);
  if (key) await dialog.getByLabel('API key', { exact: true }).fill(key);
  await dialog.getByRole('button', { name: 'Add and probe' }).click();
  await expect(dialog).toBeHidden();
}

test('adds two fake machines and probes them: every chip is green', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No machines yet' })).toBeVisible();

  await addMachine(page, MAC.name, MAC_ADDRESS, MAC.apiKey);
  await addMachine(page, LINUX.name, LINUX_ADDRESS, LINUX.apiKey);

  for (const machine of [MAC, LINUX]) {
    const machineCard = card(page, machine.name);
    await expect(machineCard.getByTestId('overall')).toHaveText('Ready');
    for (const capability of CAPABILITIES) {
      await expect(machineCard.getByTestId(`cap-${capability}`)).toHaveAttribute(
        'data-status',
        'ok',
      );
    }
    await expect(machineCard).toContainText('sk-unsloth-…');
    await expect(machineCard).not.toContainText(machine.apiKey);
  }
  await expect(card(page, MAC.name)).toContainText('Apple M3 Ultra');
  await expect(card(page, MAC.name)).toContainText('whisper.cpp is not installed');
  await expect(card(page, LINUX.name)).toContainText('NVIDIA GeForce RTX 5090');
  await expect(page.getByRole('region', { name: 'Activity' })).toContainText(
    `2 machines: ${MAC.name}, ${LINUX.name}.`,
  );
});

test('a key that Unsloth stopped accepting shows the auth error, and a new probe clears it', async ({
  page,
  request,
}) => {
  const linuxCard = card(page, LINUX.name);
  const probeButton = linuxCard.getByRole('button', { name: 'Probe', exact: true });
  await page.goto('/');
  await request.post(`${LINUX_CONTROL}/config`, { data: { rejectKey: true } });
  try {
    await probeButton.click();
    await expect(linuxCard.getByTestId('overall')).toHaveText('Error');
    await expect(linuxCard.getByTestId('cap-reachable')).toHaveAttribute('data-status', 'ok');
    await expect(linuxCard.getByTestId('cap-key')).toHaveAttribute('data-status', 'error');
    await expect(linuxCard.getByTestId('cap-text')).toHaveAttribute('data-status', 'unknown');
    await expect(linuxCard).toContainText('The API key was rejected.');
  } finally {
    await request.post(`${LINUX_CONTROL}/reset`);
  }
  await probeButton.click();
  await expect(linuxCard.getByTestId('overall')).toHaveText('Ready');
});

test('an address where nothing listens gets a plain-language error, and can be deleted', async ({
  page,
}) => {
  await page.goto('/');
  await addMachine(page, 'Nowhere', '127.0.0.1:18899');
  const nowhere = card(page, 'Nowhere');
  await expect(nowhere.getByTestId('cap-reachable')).toHaveAttribute('data-status', 'error');
  await expect(nowhere).toContainText('Nothing is listening at 127.0.0.1:18899.');

  await nowhere.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete machine' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(nowhere).toHaveCount(0);
});

test('editing keeps the saved key, and the exported probe does not contain it', async ({
  page,
}) => {
  await page.goto('/');
  const macCard = card(page, MAC.name);
  await macCard.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit machine' });
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveAttribute(
    'placeholder',
    /^Leave empty to keep sk-unsloth-…/,
  );
  await dialog.getByLabel('Notes', { exact: true }).fill('Edited in the browser test');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(macCard).toContainText('Edited in the browser test');

  const probeButton = macCard.getByRole('button', { name: 'Probe', exact: true });
  await probeButton.click();
  await expect(probeButton).toBeEnabled();
  await expect(macCard.getByTestId('cap-key')).toHaveAttribute('data-status', 'ok');

  const download = page.waitForEvent('download');
  await macCard.getByRole('link', { name: 'Export probe' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^probe-mock-mac-studio-\d{8}-\d{4}\.json$/);
  const text = await readFile(await file.path(), 'utf8');
  expect(text).not.toContain(MAC.apiKey);
  expect(JSON.parse(text)).toMatchObject({ kind: 'model-duel-probe', report: { overall: 'ok' } });
});

test('the add form explains a bad address and a missing name before saving', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add machine' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add machine' });
  const address = dialog.getByLabel('Address', { exact: true });
  await address.fill('ftp://somewhere');
  await expect(dialog).toContainText('Use an http:// or https:// address.');
  await address.fill('192.168.1.10');
  await expect(dialog).toContainText('Will connect to http://192.168.1.10:8888');
  await dialog.getByRole('button', { name: 'Add and probe' }).click();
  await expect(dialog).toContainText('Give the machine a name.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('machine-card')).toHaveCount(2);
});

test('fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(card(page, MAC.name)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
