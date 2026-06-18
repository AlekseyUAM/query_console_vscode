import type { Session } from './session';
import { dismissStartupDialog } from './session';

/**
 * Внутренняя ссылка 1С на обработку «Консоль запросов» (имя выверено через MCP
 * list_metadata_objects: Обработка.КонсольЗапросов, синоним «Консоль запросов»).
 */
const CONSOLE_LINK = 'e1cib/app/Обработка.КонсольЗапросов';

/** Маркеры готовности формы обработки «Консоль запросов» в body.innerText. */
const CONSOLE_MARKER = /Конструктор запроса|Выполнить запрос|Текст запроса|Консоль запросов/i;

/**
 * Перейти по внутренней ссылке 1С (`e1cib/...`) через штатный диалог
 * «Сервис и настройки» → «Перейти по ссылке…» → поле «Ссылка» → «Перейти».
 *
 * Почему так, а не сменой URL-хэша: на уже загруженном веб-клиенте (SPA) смена ТОЛЬКО
 * хэша приложение не перезагружает и ссылку не подхватывает. Диалог «Переход по ссылке» —
 * штатный путь 1С, работает с любого экрана без перезагрузки и потери сессии.
 */
export async function navigateByLink(s: Session, link: string): Promise<void> {
  const { page } = s;
  await dismissStartupDialog(s);
  // Меню «Сервис и настройки» — кнопка в правом верхнем углу (title выверен по DOM).
  await page.getByTitle('Сервис и настройки').click();
  await page.waitForTimeout(700);
  // Пункт «Перейти по ссылке…».
  await page.getByText('Перейти по ссылке', { exact: false }).first().click();
  await page.waitForTimeout(1000);
  // Диалог «Переход по ссылке»: поле «Ссылка» открывается в фокусе — печатаем ссылку.
  await page.keyboard.type(link, { delay: 8 });
  // «Перейти» — кнопка по умолчанию (жёлтая), поэтому подтверждаем Enter (надёжнее, чем
  // искать её локатором: в веб-клиенте это не нативный <button>).
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
}

/**
 * Открыть обработку «Консоль запросов» и дождаться её формы. По пути дожимаем стартовые
 * модалки (предупреждение о шрифтах и т.п.). Бросает, если форма не появилась.
 */
export async function openQueryConsole(s: Session): Promise<void> {
  const { page } = s;
  await navigateByLink(s, CONSOLE_LINK);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await dismissStartupDialog(s);
    const txt = await page
      .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim())
      .catch(() => '');
    if (CONSOLE_MARKER.test(txt)) {
      await page.waitForTimeout(1000);
      return;
    }
    await page.waitForTimeout(2500);
  }
  throw new Error('Форма «Консоль запросов» не открылась за отведённое время.');
}
