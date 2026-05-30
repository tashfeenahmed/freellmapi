import { test, expect } from '@playwright/test';

test.describe('Provider Add Form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/keys');
  });

  test('Base URL field appears when Ollama-local provider is selected', async ({ page }) => {
    // Click the Select trigger button (data-slot used for reliability with @base-ui/react)
    await page.locator('[data-slot="select-trigger"]').click();
    
    // Select Ollama Local from the list
    await page.locator('[data-slot="select-item"]', { hasText: 'Ollama Local' }).click();
    
    // Base URL input should become visible
    await expect(page.getByPlaceholder('http://127.0.0.1:11434/v1')).toBeVisible({ timeout: 15000 });
  });
});
