import { type Page } from '@playwright/test';

/**
 * Wait until the page finishes loading by polling until the body no longer
 * contains the text "Loading".
 */
export async function waitForLoad(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.body.innerText.includes('Loading'),
    { timeout: 15_000 },
  );
}
