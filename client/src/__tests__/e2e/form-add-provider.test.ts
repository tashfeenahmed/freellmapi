import { test, expect } from '@playwright/test';

test.describe('Provider Addition UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/keys');
  });

  test('Add provider button text is correct', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Add provider' })).toBeVisible();
  });

  test('Base URL field appears when Ollama-local is selected', async ({ page }) => {
    // Click the Select trigger button (data-slot used for reliability with @base-ui/react)
    await page.locator('[data-slot="select-trigger"]').click();
    
    // Select Ollama Local from the list
    await page.locator('[data-slot="select-item"]', { hasText: 'Ollama Local' }).click();
    
    // Verify Base URL input appears
    await expect(page.getByPlaceholder('http://127.0.0.1:11434/v1')).toBeVisible();
  });

  test('Form fields and button are vertically aligned with same height', async ({ page }) => {
    await page.goto('/keys');
    const form = page.locator('form');

    // Collect all visual form controls including the submit button
    const controls = form.locator('input, select, button[type="submit"]');
    const boxes: { height: number; y: number }[] = [];

    for (const el of await controls.all()) {
      const box = await el.boundingBox();
      if (box) boxes.push({ height: Math.round(box.height), y: Math.round(box.y) });
    }

    // Debug output
    console.log('Control boxes (height, y):', JSON.stringify(boxes));

    // Filter out hidden / zero-height elements
    const visible = boxes.filter(b => b.height > 5);
    expect(visible.length).toBeGreaterThanOrEqual(2);

    // All visible controls must share the same height
    const targetHeight = visible[0].height;
    expect(visible.every(b => b.height === targetHeight)).toBe(true);

    // All visible controls must be vertically aligned (same y origin)
    const targetY = visible[0].y;
    expect(visible.every(b => b.y === targetY)).toBe(true);
  });
});
