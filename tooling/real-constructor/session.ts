import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { getRealConstructorConfig, type RealConstructorConfig } from './config';

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cfg: RealConstructorConfig;
}

export async function launch(): Promise<Session> {
  const cfg = getRealConstructorConfig();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  return { browser, context, page, cfg };
}

/** Текст, по которому считаем рабочий стол загруженным (имя конфигурации / раздел). */
const DESKTOP_MARKER = /Управление нашей фирмой|Администратор|НА СЕГОДНЯ|Главное/i;
/** Заголовок/текст экрана-сплэша «1С:Предприятие», который НЕ считается готовностью. */
const SPLASH_ONLY = /^(\s*1С:Предприятие[\s\S]{0,40})?$/i;

/**
 * Закрыть блокирующий стартовый диалог веб-клиента, если он появился. Самый частый —
 * «На сервере отсутствуют шрифты из состава Microsoft Core Fonts …» (лечится установкой
 * msttcorefonts, см. post-create.sh), но драйвер всё равно дожимает любую модалку с
 * кнопкой подтверждения, чтобы не зависнуть. Возвращает true, если что-то закрыли.
 */
export async function dismissStartupDialog(s: Session): Promise<boolean> {
  const { page } = s;
  const labels = ['ОК', 'OK', 'Закрыть', 'Продолжить', 'Продолжить работу', 'Да'];
  for (const label of labels) {
    const btn = page.getByRole('button', { name: label, exact: false });
    if ((await btn.count()) > 0 && (await btn.first().isVisible().catch(() => false))) {
      await btn.first().click().catch(() => {});
      await page.waitForTimeout(800);
      return true;
    }
  }
  return false;
}

/**
 * Дождаться полной загрузки рабочего стола веб-клиента. Веб-клиент держит long-poll —
 * `networkidle` зависает, поэтому опрашиваем `body.innerText` до появления маркера
 * рабочего стола. По пути дожимаем стартовые модалки (шрифты и т.п.).
 */
async function waitForDesktop(s: Session, timeoutMs = 90_000): Promise<void> {
  const { page } = s;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissStartupDialog(s);
    const txt = await page
      .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim())
      .catch(() => '');
    if (DESKTOP_MARKER.test(txt) && !SPLASH_ONLY.test(txt)) return;
    await page.waitForTimeout(3000);
  }
  throw new Error('Рабочий стол веб-клиента не загрузился за отведённое время.');
}

export async function login(s: Session): Promise<void> {
  const { page, cfg } = s;
  // NOTE: 1С web client holds persistent/long-poll connections — networkidle HANGS.
  // Use domcontentloaded + poll for the rendered desktop instead.
  // login() may be called after page.goto() already ran — navigate only if blank.
  const currentUrl = page.url();
  if (!currentUrl || currentUrl === 'about:blank') {
    await page.goto(cfg.webUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  }

  // Step 1: «В данный момент вход в приложение невозможен» — занята ЕДИНСТВЕННАЯ лицензия 1С.
  // Диалог даёт кнопку «Выполнить запуск (NN)» — счётчик автоповтора. Терпеливо жмём её и ждём,
  // пока прежняя сессия не освободит лицензию и приложение не загрузится. Окно ожидания — до ~4 мин.
  // Зомби-сессию, держащую лицензию, снимают через RAS (см. docs/ras-sessions.md).
  const launchBtn = page
    .locator('button, input[type="button"]')
    .filter({ hasText: /Выполнить запуск/i });
  const POLL_MS = 15_000;
  const deadline = Date.now() + 240_000;
  let attempts = 0;
  while ((await launchBtn.count()) > 0 && Date.now() < deadline) {
    attempts++;
    console.log(`Лицензия занята — подталкиваю запуск #${attempts}, жду ${POLL_MS / 1000}с…`);
    await launchBtn.first().click().catch(() => {});
    await page.waitForTimeout(POLL_MS);
  }
  if ((await launchBtn.count()) > 0) {
    throw new Error(
      'Лицензия 1С занята: за окно ожидания (4 мин) единственная лицензия не освободилась. ' +
        'Снимите зомби-сессию через RAS (docs/ras-sessions.md) и повторите.',
    );
  }

  // Step 2: на типовой публикации smallb вход автоматический (сессия Администратора
  // стартует сразу). Форма логина — только если она реально отрисовалась.
  const inputs = page.locator('input:visible');
  const inputCount = await inputs.count();
  if (inputCount > 1 && cfg.user) {
    // Несколько видимых полей ⇒ это форма аутентификации (не строка поиска рабочего стола).
    console.log(`Форма логина (${inputCount} полей) — заполняю креды`);
    await inputs.nth(0).fill(cfg.user);
    await inputs.nth(1).fill(cfg.password);
    const submitBtn = page.locator('button[type="submit"], input[type="submit"]');
    if ((await submitBtn.count()) > 0) await submitBtn.first().click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
  }

  // Step 3: дождаться рабочего стола (с дожиманием стартовых модалок по пути).
  await waitForDesktop(s);
  console.log('Рабочий стол загружен.');
}

export async function close(s: Session): Promise<void> {
  await s.context.close();
  await s.browser.close();
}
