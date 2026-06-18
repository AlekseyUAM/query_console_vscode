import * as fs from 'fs';
import * as path from 'path';
import { launch, login, close } from './session';
import { openQueryConsole } from './console';
import { loadQueryIntoConstructor, walkTabs } from './constructor';
import { saveScreenshot } from './screenshot';
import { createLogger } from './logger';
import { RecursionGuard } from './recursionGuard';

/**
 * Smoke — приёмка выполнимости управления реальным «Конструктором запроса» через Playwright.
 * Логин → «Консоль запросов» → вставка эталонного запроса → ПКМ → «Конструктор запроса…» →
 * скриншот каждой вкладки. Эталон — документ «ЗаказПокупателя» (много полей, ВЫБОР, условия).
 */
const SAMPLE = path.join(
  'tmp/query1c',
  'CommonModules-УправлениеНебольшойФирмойЭлектронныеДокументыСервер-Ext-Module.bsl_9.txt',
);

async function main(): Promise<void> {
  const slug = path.basename(SAMPLE).replace(/\.[^.]+$/, '');
  // Скриншоты-референс пишем в tmp/ (gitignored) — в репозиторий не коммитим.
  const dir = path.resolve('tmp/phase7.3-real-constructor', slug);
  const log = createLogger('tmp/real-constructor.log');
  const s = await launch();
  try {
    await login(s);
    await openQueryConsole(s);
    await loadQueryIntoConstructor(s, fs.readFileSync(SAMPLE, 'utf8'));
    await saveScreenshot(s.page, dir, 0, 'constructor-opened');
    const n = await walkTabs(s, dir, log, new RecursionGuard({ maxDepth: 2 }));
    log.info(`smoke готов: вкладок ${n}, скриншоты в ${dir}`);
    console.log(`smoke OK: ${n} вкладок, скриншоты → ${dir}`);
  } finally {
    await close(s);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
