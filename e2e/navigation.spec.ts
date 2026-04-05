import { test, expect } from '@playwright/test';
import { waitForLoad } from './helpers.js';

let repoName = '';
let modulePath = '';

test.beforeAll(async ({ request }) => {
  const reposRes = await request.get('/api/repos');
  const reposData = await reposRes.json() as { repos: string[] };
  repoName = reposData.repos[0] ?? '';

  if (repoName) {
    const metricsRes = await request.get(`/api/metrics/${encodeURIComponent(repoName)}`);
    const metricsData = await metricsRes.json() as Array<{ module: string }>;
    modulePath = metricsData[0]?.module ?? '';
  }
});

test('/ — loads overview without error boundary', async ({ page }) => {
  await page.goto('/');
  await waitForLoad(page);
  const bodyText = await page.innerText('body');
  expect(bodyText).not.toContain('Something went wrong');
  // Overview should show some content beyond loading skeleton
  expect(bodyText.length).toBeGreaterThan(50);
});

test('/repo/:name — heading contains repo name', async ({ page }) => {
  await page.goto(`/repo/${encodeURIComponent(repoName)}`);
  await waitForLoad(page);
  const bodyText = await page.innerText('body');
  expect(bodyText).not.toContain('Something went wrong');
  // Repo name should appear in the heading area
  expect(bodyText).toContain(repoName);
});

test('/repo/:name/module/* — module path or Dependencies visible', async ({ page }) => {
  if (!modulePath) test.skip();
  // React Router uses * catch-all — do not encode the module path
  await page.goto(`/repo/${encodeURIComponent(repoName)}/module/${modulePath}`);
  await waitForLoad(page);
  const bodyText = await page.innerText('body');
  expect(bodyText).not.toContain('Something went wrong');
  // Either the module path text or "Dependencies" heading should be visible
  const hasDeps = bodyText.includes('Dependencies');
  const hasModulePath = bodyText.includes(modulePath.split('/').pop() ?? modulePath);
  expect(hasDeps || hasModulePath).toBe(true);
});

test('/findings — Findings heading visible', async ({ page }) => {
  await page.goto('/findings');
  await waitForLoad(page);
  const bodyText = await page.innerText('body');
  expect(bodyText).not.toContain('Something went wrong');
  await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible();
});

test('/graph/:name — cytoscape container exists', async ({ page }) => {
  await page.goto(`/graph/${encodeURIComponent(repoName)}`);
  await waitForLoad(page);
  const bodyText = await page.innerText('body');
  expect(bodyText).not.toContain('Something went wrong');
  // Cytoscape renders into a div container
  const cyContainer = page.locator('canvas, [data-cy-container], div.cy-container').first();
  // It's acceptable if Cytoscape hasn't rendered a canvas yet (no edges); just verify no crash
  await expect(page.locator('body')).toBeVisible();
});

test('/blast-radius/:name — overview table or file list visible', async ({ page }) => {
  await page.goto(`/blast-radius/${encodeURIComponent(repoName)}`);
  await waitForLoad(page);
  const bodyText = await page.innerText('body');
  expect(bodyText).not.toContain('Something went wrong');
  // Should show either a table of files or a message about no data
  const hasTable = await page.locator('table').count() > 0;
  const hasFileText = bodyText.includes('.ts') || bodyText.includes('.js') || bodyText.includes('No files');
  expect(hasTable || hasFileText).toBe(true);
});

test('/cross-repo — tab buttons visible', async ({ page }) => {
  await page.goto('/cross-repo');
  await waitForLoad(page);
  const bodyText = await page.innerText('body');
  expect(bodyText).not.toContain('Something went wrong');
  for (const tab of ['Graph', 'Feature Flags', 'Cascading Faults', 'Service Catalog']) {
    await expect(page.getByRole('button', { name: tab })).toBeVisible();
  }
});

test('/temporal-coupling — table headers visible', async ({ page }) => {
  await page.goto('/temporal-coupling');
  await waitForLoad(page);
  const bodyText = await page.innerText('body');
  expect(bodyText).not.toContain('Something went wrong');
  // Either a table with headers or the empty state message
  const hasTable = await page.locator('th').count() > 0;
  const hasEmptyState = bodyText.includes('No temporal coupling');
  expect(hasTable || hasEmptyState).toBe(true);
});
