import { expect, test } from '@playwright/test';

// Optional performance check against a folder with many items (not part of the default run).
//   E2E_PERF_FOLDER=<folder id> pnpm e2e e2e/perf.spec.ts
const FOLDER = process.env.E2E_PERF_FOLDER;

test('large folder renders fast and stays virtualized', async ({ page }) => {
  test.skip(!FOLDER, 'set E2E_PERF_FOLDER to a folder id with thousands of items');
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL ?? 'admin@example.com');
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.E2E_PASSWORD ?? 'correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);

  const start = Date.now();
  await page.goto(`/files/${FOLDER}`);
  await expect(page.getByRole('grid').getByRole('row').nth(5)).toBeVisible();
  const firstRows = Date.now() - start;

  const domRows = await page.getByRole('grid').getByRole('row').count();
  // Scroll to the very end, letting infinite scroll load every page.
  const scrollStart = Date.now();
  let lastCount = 0;
  for (let i = 0; i < 200; i++) {
    await page.mouse.wheel(0, 20_000);
    await page.waitForTimeout(40);
    const total = await page.getByRole('grid').getAttribute('aria-rowcount');
    if (Number(total) === lastCount && i > 5) break;
    lastCount = Number(total);
  }
  const scrollAll = Date.now() - scrollStart;
  const heap = await page.evaluate(
    () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      0,
  );
  console.info(
    JSON.stringify({
      firstRowsMs: firstRows,
      domRowsRendered: domRows,
      itemsLoaded: lastCount - 1,
      scrollAllMs: scrollAll,
      jsHeapMB: Math.round(heap / 1048576),
    }),
  );
  expect(domRows).toBeLessThan(100); // virtualized: never thousands of DOM rows
  expect(firstRows).toBeLessThan(3000);
});
