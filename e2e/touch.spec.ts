import { expect, type Page, test } from '@playwright/test';

// Runs after smoke.spec.ts (same admin; files run in name order), on a small phone. Unique
// names per run.
const ADMIN = { email: 'admin@example.com', password: 'correct horse battery staple' };
const RUN = Date.now().toString(36);

test.use({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
}

async function folder(page: Page, parentId: string, name: string): Promise<string> {
  const res = await page.request.post('/api/v1/folders', {
    data: { parentId, name },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).id;
}

/** Wider than the screen: phones then zoom the page out and fixed bars slide off it. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe
  .serial('on a phone', () => {
    test('the folder toolbar fits, and its other actions are in a menu', async ({ page }) => {
      await login(page);
      const me = await (await page.request.get('/api/v1/auth/me')).json();
      const name = `Phone ${RUN}`;
      await page.goto(`/files/${await folder(page, me.rootNodeId, name)}`);
      await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText(name);

      expect(await sideways(page)).toBeLessThanOrEqual(0);
      await expect(page.getByRole('button', { name: 'Show as grid' })).toBeInViewport();
      await expect(
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Files' }),
      ).toBeInViewport();

      await page.getByRole('button', { name: 'More folder actions' }).click();
      await page.getByRole('menuitem', { name: 'Request files…' }).click();
      const request = page.getByRole('dialog', { name: 'Request files' });
      await expect(request).toBeVisible();
      await request.getByRole('button', { name: 'Close' }).click();

      await page.getByRole('button', { name: 'More folder actions' }).click();
      await page.getByRole('menuitem', { name: 'Rewind this folder…' }).click();
      await expect(page.getByRole('dialog', { name: `Rewind “${name}”` })).toBeVisible();
    });

    test('a deep folder path scrolls instead of cutting every name short', async ({ page }) => {
      await login(page);
      const me = await (await page.request.get('/api/v1/auth/me')).json();
      let id = me.rootNodeId;
      for (const name of [`Documents ${RUN}`, 'Taxes', '2024', 'Receipts']) {
        id = await folder(page, id, name);
      }
      await page.goto(`/files/${id}`);
      const path = page.getByRole('navigation', { name: 'Folder path' });
      // The end of the trail is shown: where you are.
      await expect(path.getByText('Receipts', { exact: true })).toBeInViewport({ ratio: 1 });
      const year = path.getByRole('link', { name: '2024' });
      await expect(year).toBeInViewport({ ratio: 1 });
      expect(await year.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });

    test('as an iPhone home-screen app, the selection bar stays below the notch-high header', async ({
      page,
    }) => {
      // The status bar area (safe-area-inset-top) makes the header taller than 4rem.
      const cdp = await page.context().newCDPSession(page);
      const emulated = await cdp
        .send('Emulation.setSafeAreaInsetsOverride', {
          insets: { top: 47, bottom: 34, left: 0, right: 0 },
        })
        .then(
          () => true,
          () => false,
        );
      test.skip(!emulated, 'this Chromium cannot emulate safe-area insets');
      await login(page);
      const me = await (await page.request.get('/api/v1/auth/me')).json();
      const id = await folder(page, me.rootNodeId, `Notch ${RUN}`);
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
        await folder(page, id, `Folder ${name}`);
      }
      await page.goto(`/files/${id}`);
      await page
        .getByRole('row', { name: /Folder a/ })
        .getByRole('button', { name: /More actions/ })
        .click();
      await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const header = await page.locator('header').first().boundingBox();
      const bar = await page.getByRole('toolbar', { name: 'Selection actions' }).boundingBox();
      expect(bar!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
    });
  });
