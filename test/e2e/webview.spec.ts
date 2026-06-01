import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5555';

test.describe('Query Constructor Webview', () => {
  test('shows Справочники group in DB tree', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('text=Справочники')).toBeVisible();
  });

  test('expands Справочники group to show Валюты', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('text=Справочники').click();
    await expect(page.locator('[data-table-fullname="Справочник.Валюты"]')).toBeVisible();
  });

  test('expands Валюты to show fields', async ({ page }) => {
    await page.goto(BASE);
    // First expand the group
    await page.locator('text=Справочники').click();
    // Then click the table to expand it
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    await expect(page.locator('[data-field-path="Код"]')).toBeVisible();
    await expect(page.locator('[data-field-path="Наименование"]')).toBeVisible();
  });

  test('adds table to Tables panel via > button', async ({ page }) => {
    await page.goto(BASE);
    // Expand group and click table to focus it
    await page.locator('text=Справочники').click();
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    // Click > in Tables panel
    await page.locator('button[title="Добавить таблицу"]').click();
    await expect(page.locator('[data-table-id]')).toBeVisible();
    await expect(page.locator('text=Справочник.Валюты')).toBeVisible();
  });

  test('adds field to Fields panel via > button after table selected', async ({ page }) => {
    await page.goto(BASE);
    // Expand group, expand table, add it to query
    await page.locator('text=Справочники').click();
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    await page.locator('button[title="Добавить таблицу"]').click();

    // Click a field to focus it
    await page.locator('[data-field-path="Код"]').click();
    await page.locator('button[title="Добавить поле"]').click();

    await expect(page.locator('[data-field-idx="0"]')).toBeVisible();
    await expect(page.locator('text=Валюты.Код')).toBeVisible();
  });

  test('clicking Запрос generates query text', async ({ page }) => {
    await page.goto(BASE);
    // Add table
    await page.locator('text=Справочники').click();
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    await page.locator('button[title="Добавить таблицу"]').click();
    // Add field
    await page.locator('[data-field-path="Код"]').click();
    await page.locator('button[title="Добавить поле"]').click();

    await page.locator('[data-testid="btn-generate"]').click();

    // Verify the generate message was sent
    const messages = await page.evaluate(() => (window as any).__webviewMessages);
    const genMsg = messages.find((m: any) => m.type === 'generate');
    expect(genMsg).toBeTruthy();
    expect(genMsg.model.tables[0].fullName).toBe('Справочник.Валюты');
    expect(genMsg.model.fields[0].path).toBe('Код');
  });
});
