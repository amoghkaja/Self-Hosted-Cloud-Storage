import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
};

// 1x1 blue PNG scaled up by the server's thumbnailer.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const ADMIN = { email: 'admin@example.com', password: 'correct horse battery staple' };
// Unique names per run so the test can be repeated against the same install.
const RUN = Date.now().toString(36);
const FOLDER = `Photos ${RUN}`;
const MOM = `mom+${RUN}@example.com`;
const folderRow = (page: import('@playwright/test').Page) =>
  page.getByRole('row', { name: new RegExp(FOLDER) });

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
}

test.describe
  .serial('family cloud smoke', () => {
    test('first-run setup creates the admin', async ({ page }) => {
      const status = await (await page.request.get('/api/v1/auth/setup-status')).json();
      test.skip(!status.needsSetup, 'already set up');
      await page.goto('/');
      await expect(page).toHaveURL(/\/setup$/);
      await shot(page, '01-setup');
      await page.getByLabel('Setup token').fill(process.env.E2E_SETUP_TOKEN ?? '');
      await page.getByLabel('Your name').fill('Alex');
      await page.getByLabel('Email').fill(ADMIN.email);
      await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
      await page.getByLabel('Confirm password').fill(ADMIN.password);
      await page.getByRole('button', { name: 'Create admin account' }).click();
      await expect(page).toHaveURL(/\/files$/);
      await expect(page.getByText('This folder is empty')).toBeVisible();
      await shot(page, '02-empty-files');
    });

    test('folders, uploads, preview, trash and restore', async ({ page }) => {
      await login(page);

      await page.getByRole('button', { name: 'New folder' }).click();
      await page.getByLabel('Folder name').fill(FOLDER);
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(folderRow(page)).toBeVisible();
      await folderRow(page).dblclick();
      await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText(FOLDER);

      await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles([
        { name: 'beach.png', mimeType: 'image/png', buffer: PNG },
        {
          name: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Packing list:\n- sunscreen\n- towels\n'),
        },
      ]);
      await expect(page.getByRole('region', { name: 'Uploads' })).toContainText(
        '2 uploads complete',
        { timeout: 20_000 },
      );
      await expect(page.getByRole('row', { name: /beach\.png/ })).toBeVisible();
      await shot(page, '03-folder-with-files');

      await page.getByRole('row', { name: /notes\.txt/ }).dblclick();
      await expect(page.getByRole('dialog')).toContainText('sunscreen');
      await shot(page, '04-text-preview');
      await page.keyboard.press('Escape');

      await page.getByRole('row', { name: /notes\.txt/ }).click();
      await page.keyboard.press('Delete');
      await expect(page.getByText('Moved “notes.txt” to trash', { exact: true })).toBeVisible();
      await expect(page.getByRole('row', { name: /notes\.txt/ })).toHaveCount(0);

      await page.getByRole('link', { name: 'Trash' }).first().click();
      const item = page
        .getByRole('main')
        .getByRole('listitem')
        .filter({ hasText: 'notes.txt' })
        .first();
      await expect(item).toBeVisible();
      await shot(page, '05-trash');
      await item.getByRole('button', { name: 'Restore' }).click();
      await expect(page.getByText('Restored “notes.txt”', { exact: true })).toBeVisible();
    });

    test('admin can see storage, invite family and share', async ({ page, browser }) => {
      await login(page);
      await page.goto('/admin');
      await expect(page.getByText('Used by family')).toBeVisible();
      await shot(page, '06-admin-overview');
      await page.getByRole('tab', { name: 'Storage' }).click();
      await expect(page.getByText('disk1', { exact: true })).toBeVisible();
      await shot(page, '07-admin-storage');

      await page.getByRole('tab', { name: 'People' }).click();
      await page.getByRole('button', { name: 'Invite' }).click();
      await page.getByLabel('Email (optional)').fill(MOM);
      await page.getByRole('button', { name: 'Create invite link' }).click();
      const url = await page.locator('code').filter({ hasText: '/invite/' }).innerText();
      await shot(page, '08-invite');

      const mom = await browser.newPage();
      await mom.goto(new URL(url).pathname);
      await mom.getByLabel('Your name').fill('Mom');
      await mom.getByLabel('Password', { exact: true }).fill('mom password 123');
      await mom.getByLabel('Confirm password').fill('mom password 123');
      await mom.getByRole('button', { name: 'Create account' }).click();
      await expect(mom).toHaveURL(/\/files$/);

      await page.goto('/files');
      await folderRow(page)
        .getByRole('button', { name: /More actions/ })
        .click();
      await page.getByRole('menuitem', { name: 'Share…' }).click();
      await page.getByLabel('Family member').selectOption({ label: `Mom (${MOM})` });
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await expect(page.getByRole('dialog').getByText(MOM)).toBeVisible();
      await shot(page, '09-share-dialog');
      // Choosing a menu item must not also select the row underneath (portal event bubbling).
      await expect(page.getByRole('toolbar', { name: 'Selection actions' })).toHaveCount(0);

      await mom.goto('/shared');
      await expect(folderRow(mom)).toBeVisible();
      await folderRow(mom).dblclick();
      await expect(mom.getByRole('row', { name: /beach\.png/ })).toBeVisible();
      await expect(mom.getByText('view only')).toBeVisible();
      await mom.close();
    });

    test('network drive setup and mobile layout', async ({ page }) => {
      await login(page);
      await page.goto('/settings');
      await page.getByRole('button', { name: 'Connect a device' }).click();
      await page.getByLabel('Device name').fill("Mom's iPad");
      await page.getByLabel('Your password').fill(ADMIN.password);
      await page.getByRole('button', { name: 'Create password' }).click();
      await page.getByRole('tab', { name: 'iPhone / iPad' }).click();
      await expect(page.getByText('WebDAV', { exact: true })).toBeVisible();
      await shot(page, '10-connect-device');
      await page.getByRole('button', { name: 'Done' }).click();

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/files');
      const tabs = page.getByRole('navigation', { name: 'Main' });
      await expect(tabs.getByRole('link', { name: 'Files' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await shot(page, '11-mobile-files');
      // Recent lives behind the Files tab, which stays selected there.
      await page
        .getByRole('navigation', { name: 'Files' })
        .getByRole('link', { name: 'Recent' })
        .click();
      await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
      await expect(tabs.getByRole('link', { name: 'Files' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await tabs.getByRole('link', { name: 'Search' }).click();
      await expect(page.getByRole('searchbox', { name: 'Search your files' })).toBeFocused();
      await shot(page, '12-mobile-search');
    });
  });
