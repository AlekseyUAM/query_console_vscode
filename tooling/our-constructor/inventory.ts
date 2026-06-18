import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { chromium, type Browser, type Page } from '@playwright/test';
import { QUERIES } from './queries';
import { loadMetaTables, writeHarnessMetadata } from './metadata';
import { saveScreenshot } from '../real-constructor/screenshot';
import { createLogger } from '../real-constructor/logger';

/**
 * Опись UI НАШЕГО конструктора на тех же 10 сложных запросах, что и реальный (7.3).
 * Поднимает собранный webview-бандл в headless Chromium через статический harness,
 * кормит реальными метаданными, на каждый запрос шлёт loadModel и снимает все видимые
 * вкладки. Не падает на отдельном запросе — пишет WARN и идёт дальше (как real:inventory).
 */

const HARNESS_DIR = path.resolve('tooling/our-constructor/harness');
const WEBVIEW_BUNDLE = path.resolve('out/webview/main.js');
const PORT = 5566;
const SCREENSHOT_ROOT = path.resolve('tmp/phase7.4-our-constructor');

/** Готовит harness-каталог: копирует свежий бандл и пишет metadata.json. */
function prepareHarness(): number {
  if (!fs.existsSync(WEBVIEW_BUNDLE)) {
    throw new Error(`Нет бандла webview: ${WEBVIEW_BUNDLE}. Сначала npm run build:webview.`);
  }
  fs.copyFileSync(WEBVIEW_BUNDLE, path.join(HARNESS_DIR, 'main.js'));
  const tables = loadMetaTables();
  writeHarnessMetadata(HARNESS_DIR, tables);
  return tables.length;
}

/** Поднимает статический сервер harness на фиксированном порту; ждёт его готовности. */
async function startServer(): Promise<ChildProcess> {
  const proc = spawn(
    'npx',
    ['serve', HARNESS_DIR, '-p', String(PORT), '--no-port-switching'],
    { stdio: 'ignore' },
  );
  const url = `http://localhost:${PORT}/index.html`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return proc;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise(r => setTimeout(r, 300));
  }
  proc.kill();
  throw new Error(`serve не поднялся на порту ${PORT} за отведённое время`);
}

async function main(): Promise<void> {
  const log = createLogger('tmp/our-constructor.log');
  const tableCount = prepareHarness();
  log.info(`метаданные: ${tableCount} таблиц`);
  console.log(`Метаданные: ${tableCount} таблиц`);

  const server = await startServer();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', e => log.warn(`pageerror: ${e.message}`));

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });

    // Дождаться применённого metadataTree: появляется заполненное дерево «База данных».
    // Маркер — группа «Справочники» (рендерится DbTreePanel при наличии таблиц).
    await page.waitForFunction(() => (window as any).__metaApplied === true, undefined, {
      timeout: 60_000,
    });
    await page.getByText('Справочники', { exact: false }).first().waitFor({ timeout: 60_000 });
    log.info('metadataTree применён, дерево «База данных» заполнено');

    for (const name of QUERIES) {
      const file = path.join('tmp/query1c', name);
      const slug = name.replace(/\.[^.]+$/, '');
      const dir = path.join(SCREENSHOT_ROOT, slug);
      if (!fs.existsSync(file)) {
        log.warn(`нет файла запроса: ${name}`);
        console.log(`${slug}: НЕТ ФАЙЛА`);
        continue;
      }
      try {
        const text = fs.readFileSync(file, 'utf8');
        await page.evaluate(t => (window as any).__inv.loadQuery(t), text);

        // Дождаться отрисовки вкладок и дать дереву/панелям устаканиться.
        await page.locator('[data-testid="tabsbar"] [data-tab]').first().waitFor({ timeout: 30_000 });
        await page.waitForTimeout(800);

        await saveScreenshot(page, dir, 0, 'constructor-opened');

        // Видимый набор вкладок читаем из DOM (он динамический — см. App.tsx).
        const labels: string[] = await page.$$eval('[data-testid="tabsbar"] [data-tab]', els =>
          els.map(e => (e as HTMLElement).getAttribute('data-tab') || ''),
        );
        let idx = 1;
        for (const label of labels) {
          await page.locator(`[data-testid="tabsbar"] [data-tab="${label}"]`).first().click();
          await page.waitForTimeout(350);
          await saveScreenshot(page, dir, idx, label);
          idx++;
        }
        // Вернуться на первую вкладку, чтобы следующий запрос стартовал предсказуемо.
        if (labels.length) {
          await page.locator(`[data-testid="tabsbar"] [data-tab="${labels[0]}"]`).first().click();
          await page.waitForTimeout(150);
        }
        log.info(`${slug}: вкладок ${labels.length} [${labels.join(', ')}]`);
        console.log(`${slug}: ${labels.length} вкладок — ${labels.join(', ')}`);
      } catch (e) {
        log.warn(`${slug}: ${(e as Error).message}`);
        console.log(`${slug}: ОШИБКА — ${(e as Error).message}`);
      }
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
