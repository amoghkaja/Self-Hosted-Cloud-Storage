import { expect, type Page, test } from '@playwright/test';

// Runs after smoke.spec.ts (same admin). Unique names per run, so it can be repeated.
const ADMIN = { email: 'admin@example.com', password: 'correct horse battery staple' };
const RUN = Date.now().toString(36);

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
}

/**
 * A new folder for this test, opened by its address: the lists stay short, and a folder made
 * in a long, virtualized list might not be on screen to click.
 */
async function freshFolder(page: Page, name: string) {
  const me = await (await page.request.get('/api/v1/auth/me')).json();
  const res = await page.request.post('/api/v1/folders', {
    data: { parentId: me.rootNodeId, name },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(res.ok()).toBe(true);
  await page.goto(`/files/${(await res.json()).id}`);
  await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText(name);
}

const pick = (page: Page, name: string, text: string) =>
  page
    .locator('input[type=file]:not([webkitdirectory])')
    .first()
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

const menu = async (page: Page, name: string, item: string) => {
  await page
    .getByRole('row', { name: new RegExp(name.replace(/[.()]/g, '\\$&')) })
    .getByRole('button', { name: /More actions/ })
    .click();
  await page.getByRole('menuitem', { name: item }).click();
};

test.describe
  .serial('standard workflows', () => {
    test('uploading a file that exists asks, and Replace keeps the old one in Version history', async ({
      page,
    }) => {
      const name = `report-${RUN}.txt`;
      await login(page);
      await freshFolder(page, `Versions ${RUN}`);
      await pick(page, name, 'first draft');
      await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();

      await pick(page, name, 'second draft, much better');
      const ask = page.getByRole('dialog', { name: `“${name}” is already here` });
      await ask.getByRole('button', { name: 'Replace' }).click();
      await expect(page.getByRole('region', { name: 'Uploads' })).toContainText('complete');

      await menu(page, name, 'Version history…');
      const history = page.getByRole('dialog', { name: /Version history/ });
      await expect(history.getByText('Current')).toBeVisible();
      await history.getByRole('button', { name: /^Restore the version/ }).click();
      await expect(page.getByText(/^Restored the version from /)).toBeVisible();
      // (Escape would first dismiss the toast: Radix gives the newest layer the key.)
      await history.getByRole('button', { name: 'Close' }).last().click();

      await page.getByRole('row', { name: new RegExp(name) }).dblclick();
      await expect(page.getByRole('dialog')).toContainText('first draft');
    });

    test('make a copy, and star it', async ({ page }) => {
      const name = `plan-${RUN}.txt`;
      await login(page);
      await freshFolder(page, `Copies ${RUN}`);
      await pick(page, name, 'the plan');
      await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
      await menu(page, name, 'Make a copy');
      const copy = `plan-${RUN} (copy).txt`;
      await expect(
        page.getByRole('row', { name: new RegExp(copy.replace(/[()]/g, '\\$&')) }),
      ).toBeVisible();

      await menu(page, copy, 'Add to Starred');
      await page.getByRole('link', { name: 'Starred' }).first().click();
      await expect(
        page.getByRole('row', { name: new RegExp(copy.replace(/[.()]/g, '\\$&')) }),
      ).toBeVisible();
    });

    test('a file request lets someone without an account send files, and nothing more', async ({
      page,
      browser,
    }) => {
      const folder = `Inbox ${RUN}`;
      await login(page);
      await freshFolder(page, `Requests ${RUN}`);
      await page.getByRole('button', { name: 'New folder' }).click();
      await page.getByLabel('Folder name').fill(folder);
      await page.getByRole('button', { name: 'Create' }).click();
      await menu(page, folder, 'Share…');
      const share = page.getByRole('dialog', { name: `Share “${folder}”` });
      await share.getByRole('tab', { name: 'Request files' }).click();
      await share.getByLabel('What are you asking for?').fill('Your holiday photos');
      await share.getByRole('button', { name: 'Create request link' }).click();
      const url = await share.locator('p.font-mono').filter({ hasText: '/s/' }).first().innerText();

      const guest = await browser.newPage();
      await guest.goto(new URL(url).pathname);
      await expect(guest.getByRole('heading', { name: 'Your holiday photos' })).toBeVisible();
      await expect(guest.getByRole('grid')).toHaveCount(0);
      await guest.getByLabel('Your name').fill('Cousin Meera');
      await guest
        .locator('input[type=file]')
        .setInputFiles({ name: 'beach.txt', mimeType: 'text/plain', buffer: Buffer.from('sun') });
      await expect(guest.getByText('1 file sent')).toBeVisible();
      await guest.close();

      await share.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('row', { name: new RegExp(folder) }).dblclick();
      await page.getByRole('row', { name: /Cousin Meera/ }).dblclick();
      await expect(page.getByRole('row', { name: /beach\.txt/ })).toBeVisible();
    });
  });
