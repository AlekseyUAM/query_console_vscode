import type { Session } from './session';
import type { Logger } from './logger';
import { RecursionGuard } from './recursionGuard';
import { saveScreenshot } from './screenshot';
import { dismissStartupDialog } from './session';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Координаты самого крупного видимого textarea формы — это редактор «Текст запроса». */
async function queryEditorBox(s: Session): Promise<Box | null> {
  return s.page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('textarea')).filter(
      (e) => (e as HTMLElement).offsetParent !== null,
    );
    let best: HTMLElement | null = null;
    let bestArea = 0;
    for (const e of cands) {
      const r = e.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) {
        bestArea = a;
        best = e as HTMLElement;
      }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
}

/** Маркеры открытого «Конструктора запроса» (его вкладки / заголовок). */
const CONSTRUCTOR_MARKER = /Таблицы и поля|Конструктор запроса/i;

/**
 * Вставить текст запроса в поле «Текст запроса» «Консоли запросов» и открыть
 * «Конструктор запроса» через контекстное меню поля (ПКМ → «Конструктор запроса…»).
 *
 * Поток выверен probe-driven на реальном веб-клиенте:
 *  - поле запроса = самый крупный <textarea> формы;
 *  - текст вставляется целиком (`insertText`, не по символу);
 *  - «Конструктор запроса…» — пункт КОНТЕКСТНОГО меню поля, не кнопка панели.
 */
export async function loadQueryIntoConstructor(s: Session, queryText: string): Promise<void> {
  const { page } = s;
  const box = await queryEditorBox(s);
  if (!box) throw new Error('Поле «Текст запроса» не найдено (нет видимого textarea).');
  const cx = box.x + box.w / 2;
  const cy = box.y + 30;

  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  // Очистить поле и вставить запрос целиком.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(queryText);
  await page.waitForTimeout(600);

  // ПКМ в поле → «Конструктор запроса…».
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.waitForTimeout(900);
  await page.getByText('Конструктор запроса', { exact: false }).first().click();

  // Дождаться модального окна конструктора (вкладки/заголовок).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await dismissStartupDialog(s);
    const txt = await page
      .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim())
      .catch(() => '');
    if (CONSTRUCTOR_MARKER.test(txt)) {
      await page.waitForTimeout(1000);
      return;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error('«Конструктор запроса» не открылся за отведённое время.');
}

/**
 * Закрыть открытое окно «Конструктор запроса», отменив изменения, чтобы следующий запрос
 * стартовал с чистой «Консоли запросов». Без этого модальное окно конструктора от прошлого
 * запроса перехватывает клики и ломает загрузку следующего (inventory-прогон).
 */
export async function closeConstructor(s: Session): Promise<void> {
  const { page } = s;
  // Кнопки конструктора («Запрос»/«ОК»/«Отмена») — это <span class="pressBox"> с обычным
  // textContent (в отличие от вкладок на data-content). «Отмена» закрывает форму без записи.
  const cancel = page.locator('span.pressBox', { hasText: 'Отмена' }).first();
  if ((await cancel.count()) > 0) {
    await cancel.click({ force: true }).catch(() => {});
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(800);
  // Возможный вопрос «Сохранить изменения?» — отвечаем «Нет».
  const no = page.locator('span.pressBox', { hasText: /^Нет$/ }).first();
  if ((await no.count()) > 0) {
    await no.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await dismissStartupDialog(s);
}

/**
 * Подписи вкладок конструктора рисуются CSS-ом из атрибута `data-content` на
 * `div.tabsItemTitle` (сам элемент текстового содержимого не имеет — поэтому
 * `getByText`/`textContent` их не находят). Локатор — по этому атрибуту.
 */
const TAB_TITLE_SEL = '.tabsItemTitle[data-content]';

/** Считать набор вкладок конструктора (динамический: «Связи» есть только при >1 таблице). */
export async function discoverTabs(s: Session): Promise<string[]> {
  return s.page.evaluate((sel) => {
    const names: string[] = [];
    document.querySelectorAll(sel).forEach((el) => {
      if ((el as HTMLElement).offsetParent === null) return;
      const c = el.getAttribute('data-content');
      if (c && !names.includes(c)) names.push(c);
    });
    return names;
  }, TAB_TITLE_SEL);
}

/**
 * Обойти вкладки конструктора: клик по вкладке → скриншот → рекурсивный заход в под-окна
 * (через guard). Возвращает число сохранённых скриншотов. Не падает на отдельном элементе —
 * пишет WARN в лог и продолжает. Набор вкладок берётся из DOM (data-content), а не хардкодом.
 */
export async function walkTabs(
  s: Session,
  shotDir: string,
  log: Logger,
  guard: RecursionGuard,
): Promise<number> {
  const { page } = s;
  const tabs = await discoverTabs(s);
  log.info(`вкладки конструктора: ${tabs.join(' · ')}`);
  let count = 0;
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    try {
      const tabLoc = page.locator(`.tabsItemTitle[data-content="${tab.replace(/"/g, '\\"')}"]`).first();
      if ((await tabLoc.count()) === 0) {
        log.warn(`вкладка не найдена: ${tab}`);
        continue;
      }
      await tabLoc.click({ timeout: 4000, force: true });
      await page.waitForTimeout(500);
      await saveScreenshot(page, shotDir, i + 1, tab);
      count++;
      log.info(`вкладка снята: ${tab}`);
      count += await walkSubWindows(s, shotDir, log, guard, 2, i + 1);
    } catch (e) {
      log.warn(`ошибка на вкладке ${tab}: ${(e as Error).message}`);
    }
  }
  return count;
}

/**
 * На текущей вкладке/окне найти кнопки, открывающие под-диалоги, и рекурсивно их обойти.
 * Защита от зацикливания — через guard (глубина + дедуп заголовков). Возвращает число скриншотов.
 */
export async function walkSubWindows(
  s: Session,
  shotDir: string,
  log: Logger,
  guard: RecursionGuard,
  depth: number,
  baseIndex: number,
): Promise<number> {
  const { page } = s;
  let count = 0;
  // Кнопки командных панелей ТОЛЬКО внутри области конструктора (x>270): левое меню
  // разделов (Главное/CRM/…) НЕ трогаем — клик по нему увёл бы со страницы конструктора.
  const targets = await page.evaluate(() => {
    const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
    const res: Array<{ title: string; x: number; y: number }> = [];
    document.querySelectorAll('[title]').forEach((el) => {
      const he = el as HTMLElement;
      const cls = he.className?.toString() || '';
      const role = he.getAttribute('role') || '';
      const isBtn =
        he.tagName === 'BUTTON' || role === 'button' || /button|cmdBtn|commandBar/i.test(cls);
      if (!isBtn || !vis(he)) return;
      const r = he.getBoundingClientRect();
      if (r.left < 270 || r.top < 110 || r.top > 980 || r.width < 6) return;
      const title = he.getAttribute('title') || '';
      if (title) res.push({ title, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    });
    return res;
  });

  const bodyLen = async (): Promise<number> =>
    page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
  const baseLen = await bodyLen();

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!guard.shouldEnter(`d${depth}:${t.title}`, depth)) continue;
    try {
      await page.mouse.click(t.x, t.y);
      await page.waitForTimeout(350);
      // Под-диалог считаем открытым, если заметно изменился объём текста на экране.
      const len = await bodyLen();
      if (Math.abs(len - baseLen) > 60) {
        await saveScreenshot(page, shotDir, baseIndex * 100 + i, `d${depth}-${t.title}`);
        count++;
        count += await walkSubWindows(s, shotDir, log, guard, depth + 1, baseIndex * 100 + i);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }
    } catch (e) {
      log.warn(`под-окно d${depth} «${t.title}»: ${(e as Error).message}`);
    }
  }
  return count;
}
