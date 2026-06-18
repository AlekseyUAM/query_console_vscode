import * as path from 'path';
import { launch, login } from './session';
import { saveScreenshot } from './screenshot';

async function main(): Promise<void> {
  const dir = path.resolve('tmp/real-constructor-probe');
  const s = await launch();

  s.page.on('response', async (response) => {
    const status = response.status();
    if (status >= 400) console.error(`[HTTP ${status}] ${response.url()}`);
  });
  s.page.on('console', (m) => console.log(`[page console] ${m.text()}`));

  try {
    await s.page.goto(s.cfg.webUrl, { waitUntil: 'domcontentloaded' });
    await s.page.waitForTimeout(5000);
    await saveScreenshot(s.page, dir, 0, 'landing');
    console.log('title (landing):', await s.page.title());

    await login(s);
    await saveScreenshot(s.page, dir, 1, 'after-login');
    console.log('title (after-login):', await s.page.title());

    // Попытка открыть «Консоль запросов» прямой навигационной ссылкой.
    try {
      await s.page.goto(s.cfg.webUrl + '#e1cib/app/Обработка.КонсольЗапросов', {
        waitUntil: 'domcontentloaded',
      });
      await s.page.waitForTimeout(8000);
      await saveScreenshot(s.page, dir, 2, 'query-console');
      console.log('title (query-console):', await s.page.title());
    } catch (e) {
      console.error('nav to console failed:', (e as Error).message);
      await saveScreenshot(s.page, dir, 2, 'query-console-failed');
    }
  } finally {
    await s.context.close();
    await s.browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
