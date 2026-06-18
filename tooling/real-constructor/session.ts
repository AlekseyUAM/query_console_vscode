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

export async function login(s: Session): Promise<void> {
  const { page, cfg } = s;
  // NOTE: 1С web client holds persistent/long-poll connections — networkidle HANGS.
  // Use domcontentloaded + explicit wait for visible element instead.
  // Also: login() is called after page.goto() already ran in probe.ts — do NOT navigate again.
  // We only navigate if the page is blank/unloaded.
  const currentUrl = page.url();
  if (!currentUrl || currentUrl === 'about:blank') {
    await page.goto(cfg.webUrl, { waitUntil: 'domcontentloaded' });
    // Give the JS shell time to render initial dialog/form
    await page.waitForTimeout(5000);
  }

  // Step 1: «В данный момент вход в приложение невозможен» — занята ЕДИНСТВЕННАЯ лицензия 1С.
  // Диалог даёт кнопку «Выполнить запуск (NN)» — счётчик автоповтора. Терпеливо жмём её и ждём,
  // пока прежняя сессия не освободит лицензию и приложение не загрузится. Окно ожидания — до ~4 мин.
  const launchBtn = page
    .locator('button, input[type="button"]')
    .filter({ hasText: /Выполнить запуск/i });
  // ВАЖНО: НЕ спамить. Диалог 1С сам отсчитывает «(NN)» и повторяет попытку входа. Мы лишь
  // изредка подталкиваем кнопку и ждём фиксированный интервал, опрашивая состояние. Без спама.
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
        'Закройте сторонние сеансы (клиент/зомби-сессию) и повторите.',
    );
  }
  if (attempts > 0) {
    console.log(`Лицензия освободилась после ${attempts} подталкиваний — приложение запускается.`);
    await page.waitForTimeout(5000);
  }

  // Step 2: Handle the login form (standard <input> fields for user/password).
  // After startup dialog is dismissed, the login form may appear.
  const inputs = page.locator('input:visible');
  const inputCount = await inputs.count();
  if (inputCount > 0 && cfg.user) {
    console.log(`Found ${inputCount} input(s) — filling login form`);
    await inputs.nth(0).fill(cfg.user);
    if (inputCount > 1) await inputs.nth(1).fill(cfg.password);
    // Try clicking a submit button first; fall back to Enter
    const submitBtn = page.locator('button[type="submit"], input[type="submit"]');
    if ((await submitBtn.count()) > 0) {
      await submitBtn.first().click();
    } else {
      await page.keyboard.press('Enter');
    }
    // Wait for the desktop to load after submitting credentials
    await page.waitForTimeout(10000);
  } else {
    console.log(`No login inputs found (count=${inputCount}) — may be auto-logged in or different UI`);
  }

  // Wait for desktop to appear — give the 1С shell up to 60s to finish loading.
  // networkidle is avoided; use domcontentloaded + extra wait for JS-heavy shell.
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
  await page.waitForTimeout(3000);
}

export async function close(s: Session): Promise<void> {
  await s.context.close();
  await s.browser.close();
}
