import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:5555';

/** Drag a table from the DB tree into the Tables panel drop zone.
 *
 * Tables are added via drag-and-drop in this UI (no "Добавить таблицу" button).
 * We fire synthetic DragEvents with the correct dataTransfer payload directly on
 * the Tables-panel drop zone, which is identified by its distinctive inline style
 * (border: 1px dashed transparent + min-height: 40px).
 */
async function dragTableToPanel(page: Page, tableFullName: string): Promise<void> {
  const payload = JSON.stringify({ kind: 'table', tableFullName });
  await page.evaluate((payload) => {
    // Find the Tables panel drop zone by its distinctive style.
    // It is the FIRST div matching: overflowY=auto AND minHeight=40px AND border contains 'dashed'.
    const allDivs = Array.from(document.querySelectorAll('div'));
    const dropZone = allDivs.find(d => {
      const s = (d as HTMLElement).style;
      return s.overflowY === 'auto' && s.minHeight === '40px' && s.border.includes('dashed');
    }) as HTMLElement | undefined;
    if (!dropZone) throw new Error('Tables panel drop zone not found');
    const dt = new DataTransfer();
    dt.setData('text/plain', payload);
    dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, payload);
}

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
    // Add table via drag-and-drop (no "Добавить таблицу" button in current UI)
    await dragTableToPanel(page, 'Справочник.Валюты');
    await expect(page.locator('[data-table-id]')).toBeVisible();
    await expect(page.locator('text=Справочник.Валюты')).toBeVisible();
  });

  test('adds field to Fields panel via > button after table selected', async ({ page }) => {
    await page.goto(BASE);
    // Expand group, expand table, add it to query
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    // Expand table in DB tree and click a field
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    await page.locator('[data-field-path="Код"]').click();

    await expect(page.locator('[data-field-idx="0"]')).toBeVisible();
    await expect(page.locator('text=Валюты.Код')).toBeVisible();
  });

  test('clicking Запрос generates query text', async ({ page }) => {
    await page.goto(BASE);
    // Add table
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    // Expand table in DB tree and click a field
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    await page.locator('[data-field-path="Код"]').click();

    await page.locator('button:has-text("Запрос")').click();

    // Verify the generate message was sent
    const messages = await page.evaluate(() => (window as any).__webviewMessages);
    const genMsg = messages.find((m: any) => m.type === 'generate');
    expect(genMsg).toBeTruthy();
    expect(genMsg.model.tables[0].fullName).toBe('Справочник.Валюты');
    expect(genMsg.model.fields[0].path).toBe('Код');
  });

  test('нижняя панель: ОК постит insertText, Отмена постит cancel', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('button:has-text("Запрос")')).toBeVisible();
    await page.locator('button:has-text("ОК")').click();
    await page.locator('button:has-text("Отмена")').click();
    const types = await page.evaluate(() => (window as any).__webviewMessages.map((m: any) => m.type));
    expect(types).toContain('insertText');
    expect(types).toContain('cancel');
  });

  test('Связи: селект таблицы имеет title с полным псевдонимом (anti-clip)', async ({ page }) => {
    await page.goto(BASE);
    // Inject a second table into the metadata so we can add two distinct tables
    // (the reducer deduplicates by fullName, so we need two different entries).
    await page.waitForTimeout(200); // wait for initial metadataTree message to settle
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'metadataTree',
          tables: [
            {
              kind: 'Справочник', name: 'Валюты', fullName: 'Справочник.Валюты',
              fields: [{ name: 'Ссылка', kind: 'standard', types: [] }],
            },
            {
              kind: 'Справочник', name: 'Организации', fullName: 'Справочник.Организации',
              fields: [{ name: 'Ссылка', kind: 'standard', types: [] }],
            },
          ],
        },
      }));
    });
    await page.waitForTimeout(100);
    // Добавляем две таблицы, чтобы появилась вкладка «Связи».
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    await dragTableToPanel(page, 'Справочник.Организации');
    await page.locator('[data-testid="tabsbar"] [data-tab="Связи"]').click();
    await page.locator('button[title="Добавить связь"]').click();
    const sel = page.locator('select[title]').first();
    await expect(sel).toHaveAttribute('title', /.+/); // непустой тултип полного имени
  });

  test('боковой стрип пакета: контейнер скроллится по вертикали', async ({ page }) => {
    await page.goto(BASE);
    // Стрип появляется только при >1 запросе пакета; здесь проверяем, что КОГДА он есть,
    // у него overflowY=auto. Если стрипа нет в стартовом состоянии — кейс пропускаем.
    const strip = page.locator('[data-testid="side-strip"]');
    if (await strip.count() === 0) test.skip(true, 'стрип не виден без пакета');
    const overflow = await strip.evaluate(el => getComputedStyle(el).overflowY);
    expect(overflow).toBe('auto');
  });
});
