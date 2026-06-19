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

/** Drag a field from the DB tree into the Fields panel drop zone.
 *
 * Fields are added via drag-and-drop. The payload shape matches DbTreePanel's
 * handleDragStart: { kind: 'field', tableFullName, fieldPath }.
 * The Fields panel drop zone has the same style signature as the Tables panel
 * (overflowY=auto, minHeight=40px, border dashed) — it is the SECOND such div.
 */
async function dragFieldToPanel(page: Page, tableFullName: string, fieldPath: string): Promise<void> {
  const payload = JSON.stringify({ kind: 'field', tableFullName, fieldPath });
  await page.evaluate((payload) => {
    const allDivs = Array.from(document.querySelectorAll('div'));
    const dropZones = allDivs.filter(d => {
      const s = (d as HTMLElement).style;
      return s.overflowY === 'auto' && s.minHeight === '40px' && s.border.includes('dashed');
    }) as HTMLElement[];
    // Fields panel is the second drop zone (Tables panel is the first).
    const dropZone = dropZones[1];
    if (!dropZone) throw new Error('Fields panel drop zone not found (need at least 2 dashed drop zones)');
    const dt = new DataTransfer();
    dt.setData('text/plain', payload);
    dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, payload);
}

/** Drop an arbitrary drag payload onto the Fields panel drop zone (the 2nd dashed zone). */
async function dropPayloadOnFieldsPanel(page: Page, payload: string): Promise<void> {
  await page.evaluate((payload) => {
    const allDivs = Array.from(document.querySelectorAll('div'));
    const dropZones = allDivs.filter(d => {
      const s = (d as HTMLElement).style;
      return s.overflowY === 'auto' && s.minHeight === '40px' && s.border.includes('dashed');
    }) as HTMLElement[];
    const dropZone = dropZones[1];
    if (!dropZone) throw new Error('Fields panel drop zone not found');
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
    // 7.8.12: строка таблицы показывает синоним, а не полное имя.
    await expect(page.locator('[data-table-alias="Валюты"]')).toBeVisible();
  });

  test('7.8.16: двойной клик по таблице добавляет все поля', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    await page.locator('[data-table-id]').first().dblclick();
    // Валюты имеет поля Код, Наименование, Ссылка и др. → минимум 3 строки полей.
    await expect(page.locator('[data-field-idx]').nth(2)).toBeVisible();
  });

  test('7.8.14: двойной клик по ВТ открывает окно с полями', async ({ page }) => {
    await page.goto(BASE);
    // Открыть окно «Временная таблица».
    await page.locator('[data-testid="add-temp-table"]').click();
    await page.locator('[data-testid="tt-name"]').fill('ВТТовары');
    await page.locator('[data-testid="tt-field-name-0"]').fill('Товар');
    await page.locator('[data-testid="tt-add-row"]').click();
    await page.locator('[data-testid="tt-field-name-1"]').fill('Количество');
    await page.locator('[data-testid="tt-ok"]').click();

    // Источник-ВТ появляется в списке «Таблицы» с синонимом = имя ВТ.
    await expect(page.locator('[data-table-alias="ВТТовары"]')).toBeVisible();

    // Двойной клик переоткрывает окно, предзаполненное именем.
    await page.locator('[data-table-alias="ВТТовары"]').dblclick();
    await expect(page.locator('[data-testid="tt-name"]')).toHaveValue('ВТТовары');
  });

  test('7.8.8: кнопка ВЗ открывает вложенный конструктор', async ({ page }) => {
    await page.goto(BASE);
    // Кнопка переименована ⊂З → ВЗ.
    const btn = page.locator('[data-testid="add-subquery"]');
    await expect(btn).toHaveText('ВЗ');

    // Клик открывает вложенный рекурсивный конструктор.
    await btn.click();
    const nested = page.locator('[data-testid="subquery-constructor"]');
    await expect(nested).toBeVisible();

    // У вложенной модалки своя нижняя панель — её «Отмена» (последняя на странице) закрывает её.
    await page.locator('button:has-text("Отмена")').last().click();
    await expect(nested).toBeHidden();
  });

  test('adds field to Fields panel via > button after table selected', async ({ page }) => {
    await page.goto(BASE);
    // Expand group, add table to query via drag
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    // Drag field from DB tree into Fields panel drop zone
    await dragFieldToPanel(page, 'Справочник.Валюты', 'Код');

    await expect(page.locator('[data-field-idx="0"]')).toBeVisible();
    await expect(page.locator('text=Валюты.Код')).toBeVisible();
  });

  test('clicking Запрос generates query text', async ({ page }) => {
    await page.goto(BASE);
    // Add table
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    // Add field via drag
    await dragFieldToPanel(page, 'Справочник.Валюты', 'Код');

    await page.locator('button:has-text("Запрос")').click();

    // «Запрос» opens a preview modal — assert the modal is visible with generated SQL
    await expect(page.locator('text=Текст запроса')).toBeVisible();
    // The generated query must contain the SELECT keyword and reference the table/field
    const previewText = page.locator('pre');
    await expect(previewText).toContainText('ВЫБРАТЬ');
    await expect(previewText).toContainText('Валюты');
  });

  test('нижняя панель: ОК постит insertText, Отмена постит cancel', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('button:has-text("Запрос")')).toBeVisible();
    // ОК is disabled when the constructor is empty (guard against data loss).
    // Add a table and field first so ОК is enabled.
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    await dragFieldToPanel(page, 'Справочник.Валюты', 'Код');
    await page.locator('button:has-text("ОК")').click();
    await page.locator('button:has-text("Отмена")').click();
    const types = await page.evaluate(() => (window as any).__webviewMessages.map((m: any) => m.type));
    expect(types).toContain('insertText');
    expect(types).toContain('cancel');
  });

  test('7.8.10: ОК на некорректном запросе показывает ошибку и не сохраняет', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');

    // Добавляем произвольное выражение, дающее некорректный SDBL (ключевое слово «ИЗ»
    // как тело выражения ломает разбор: «ВЫБРАТЬ ИЗ КАК Поле1 ИЗ ...»).
    await page.locator('button[title="Добавить поле (произвольное выражение)"]').click();
    await expect(page.locator('text=Произвольное выражение')).toBeVisible();
    await page.locator('textarea').fill('ИЗ');
    await page.locator('[data-testid="expr-ok"]').click();
    await expect(page.locator('[data-field-idx="0"]')).toBeVisible();

    // Чистим зафиксированные сообщения моста.
    await page.evaluate(() => { (window as any).__webviewMessages = []; });

    // Нижняя панель ОК доступна (текст пакета непустой), но валидация должна заблокировать.
    await page.locator('button:has-text("ОК")').click();

    await expect(page.locator('[data-testid="ok-error"]')).toBeVisible();
    const msgs = await page.evaluate(() => (window as any).__webviewMessages);
    expect(msgs.some((m: any) => m.type === 'insertText')).toBe(false);
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

  // 7.8.4: кнопка «+» в списке «Поля» открывает «Произвольное выражение» и вставляет результат новым полем.
  test('Поля: «+» открывает Произвольное выражение и добавляет новое поле', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    // «+» доступна, как только есть хотя бы одна таблица (фокус не обязателен).
    await page.locator('button[title="Добавить поле (произвольное выражение)"]').click();
    await expect(page.locator('text=Произвольное выражение')).toBeVisible();
    await page.locator('textarea').fill('1 + 1');
    await page.locator('[data-testid="expr-ok"]').click();
    // Новое поле-выражение появилось в списке «Поля».
    await expect(page.locator('[data-field-idx="0"]')).toBeVisible();
    await expect(page.locator('[data-field-idx="0"]')).toContainText('1 + 1');
  });

  // 7.8.5: двойной клик по полю открывает «Произвольное выражение» для правки этого поля.
  test('Поля: двойной клик открывает Произвольное выражение для правки поля', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    await dragFieldToPanel(page, 'Справочник.Валюты', 'Код');
    await expect(page.locator('[data-field-idx="0"]')).toContainText('Валюты.Код');
    await page.locator('[data-field-idx="0"]').dblclick();
    await expect(page.locator('text=Произвольное выражение')).toBeVisible();
    // Текст предзаполнен квалифицированным путём редактируемого поля.
    await expect(page.locator('textarea')).toHaveValue('Валюты.Код');
    await page.locator('textarea').fill('ВЫРАЗИТЬ(Валюты.Код КАК Строка(10))');
    await page.locator('[data-testid="expr-ok"]').click();
    // Поле обновлено на месте (не появилось второе поле).
    await expect(page.locator('[data-field-idx="0"]')).toContainText('ВЫРАЗИТЬ(Валюты.Код КАК Строка(10))');
    await expect(page.locator('[data-field-idx="1"]')).toHaveCount(0);
  });

  // 7.8.6: перетаскивание таблицы в список «Поля» добавляет ВСЕ её поля.
  test('Поля: перетаскивание таблицы добавляет все её поля', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('text=Справочники').click();
    await dragTableToPanel(page, 'Справочник.Валюты');
    // Бросаем саму таблицу в список «Поля» (а не отдельный реквизит).
    await dropPayloadOnFieldsPanel(page, JSON.stringify({ kind: 'table', tableFullName: 'Справочник.Валюты' }));
    // У Валюты в harness 4 поля → индексы 0..3.
    await expect(page.locator('[data-field-idx="0"]')).toBeVisible();
    await expect(page.locator('[data-field-idx="3"]')).toBeVisible();
    await expect(page.locator('[data-field-idx="4"]')).toHaveCount(0);
  });

  test('боковой стрип пакета: появляется при >1 запросе и скроллится по вертикали', async ({ page }) => {
    await page.goto(BASE);
    // Создаём пакет из >1 запроса через вкладку «Пакет запросов» (кнопка «Добавить»),
    // тогда появляется боковой вертикальный стрип имён запросов.
    await page.locator('[data-testid="tabsbar"] [data-tab="Пакет запросов"]').click();
    await page.locator('button[title="Добавить"]').click();
    // Стрип виден только ВНЕ вкладки «Пакет запросов» — переключаемся на «Таблицы и поля».
    await page.locator('[data-testid="tabsbar"] [data-tab="Таблицы и поля"]').click();
    const strip = page.locator('[data-testid="side-strip"]');
    await expect(strip).toBeVisible();
    const overflow = await strip.evaluate(el => getComputedStyle(el).overflowY);
    expect(overflow).toBe('auto');
  });
});
