import { expect, test } from '@playwright/test';
import { E2E_AUTH_APP_PORT, E2E_PASSWORD } from '../ports';

// With DUEL_PASSWORD set, the app asks for it before anything else, and the API answers only a
// signed-in page.
const APP = `http://127.0.0.1:${E2E_AUTH_APP_PORT}`;

test('asks for the password first, refuses a wrong one, and signs out again', async ({
  page,
  playwright,
}) => {
  await page.goto(APP);
  const password = page.getByLabel('Password');
  await expect(password).toBeVisible();
  await password.fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That password is wrong.');

  await password.fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Machines' })).toBeVisible();

  // The session is the page's alone: a request without its cookie gets nothing.
  const stranger = await playwright.request.newContext();
  expect((await stranger.get(`${APP}/api/machines`)).status()).toBe(401);
  await stranger.dispose();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
});
