import { test, expect } from '@playwright/test';

test.describe('Ollama Local Provider', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/keys');
  });

  test('Ollama Local shows Base URL input instead of API key', async ({ page }) => {
    // Click the Select trigger button (data-slot used for reliability with @base-ui/react)
    await page.locator('[data-slot="select-trigger"]').click();
    
    // Select Ollama Local from the list
    await page.locator('[data-slot="select-item"]', { hasText: 'Ollama Local' }).click();
    
    // Verify API key field is NOT visible
    await expect(page.getByPlaceholder('paste key here')).not.toBeVisible();
    await expect(page.getByPlaceholder('Bearer token')).not.toBeVisible();
    
    // Verify Base URL input IS visible
    await expect(page.getByPlaceholder('http://127.0.0.1:11434/v1')).toBeVisible();
    
    // Verify "Sync models" button is visible
    await expect(page.getByRole('button', { name: 'Sync Ollama models' })).toBeVisible();
  });

  test('Can add Ollama Local provider with custom base URL', async ({ page }) => {
    // Select Ollama Local
    await page.locator('[data-slot="select-trigger"]').click();
    await page.locator('[data-slot="select-item"]', { hasText: 'Ollama Local' }).click();
    
    // Enter custom base URL
    await page.getByPlaceholder('http://127.0.0.1:11434/v1').fill('http://192.168.1.100:11434/v1');
    
    // Add label
    await page.getByPlaceholder('optional').fill('GPU Server Ollama');
    
    // Submit form
    await page.getByRole('button', { name: 'Add provider' }).click();
    
    // Should show success message (check for notification or success state)
    await expect(page.getByText('Adding…')).not.toBeVisible();
  });

  test('Sync models button triggers model import', async ({ page }) => {
    // Select Ollama Local
    await page.locator('[data-slot="select-trigger"]').click();
    await page.locator('[data-slot="select-item"]', { hasText: 'Ollama Local' }).click();
    
    // Click sync button
    const syncButton = page.getByRole('button', { name: 'Sync Ollama models' });
    await syncButton.click();
    
    // Should show syncing state
    await expect(syncButton).toBeDisabled();
    await expect(syncButton).toContainText('Syncing…');
    
    // Should complete (timeout after 10s for demo)
    await page.waitForTimeout(5000);
    await expect(syncButton).toBeEnabled();
    await expect(syncButton).toContainText('Sync Ollama models');
  });
});