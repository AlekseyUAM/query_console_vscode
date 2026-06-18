import * as fs from 'fs';
import * as path from 'path';
import { launch, login, close } from './session';
import { openQueryConsole } from './console';
import { loadQueryIntoConstructor, walkTabs, closeConstructor } from './constructor';
import { saveScreenshot } from './screenshot';
import { createLogger } from './logger';
import { RecursionGuard } from './recursionGuard';

/**
 * Inventory — опись UI реального конструктора на 10 сложных репрезентативных запросах.
 * Для каждого: «Консоль запросов» → вставка текста → «Конструктор запроса…» → скриншоты
 * всех вкладок. Не падает на отдельном запросе — пишет WARN в лог и идёт дальше.
 */
const QUERIES = [
  'Documents-ОтчетКомиссионера-Ext-ManagerModule.bsl_24.txt',
  'CommonModules-ЗарплатаКадрыОбщиеНаборыДанныхБазовый-Ext-Module.bsl_1.txt',
  'CommonModules-УчетСтраховыхВзносовАрхивныеАлгоритмы-Ext-Module.bsl_249.txt',
  'Documents-ЗаказПокупателя-Ext-ManagerModule.bsl_89.txt',
  'CommonModules-УчетСтраховыхВзносов-Ext-Module.bsl_66.txt',
  'Documents-ПриходнаяНакладная-Ext-ManagerModule.bsl_44.txt',
  'Reports-КарточкаУчетаПоСтраховымВзносам-Ext-ObjectModule.bsl_3.txt',
  'CommonModules-СкидкиНаценкиСервер-Ext-Module.bsl_19.txt',
  'Documents-ОтчетОРозничныхПродажах-Ext-ManagerModule.bsl_27.txt',
  'CommonModules-УправлениеНебольшойФирмойЭлектронныеДокументыСервер-Ext-Module.bsl_9.txt',
];

async function main(): Promise<void> {
  const log = createLogger('tmp/real-constructor.log');
  const s = await launch();
  try {
    await login(s);
    for (const name of QUERIES) {
      const file = path.join('tmp/query1c', name);
      if (!fs.existsSync(file)) {
        log.warn(`нет файла запроса: ${name}`);
        continue;
      }
      const slug = name.replace(/\.[^.]+$/, '');
      // Скриншоты-референс пишем в tmp/ (gitignored) — в репозиторий не коммитим.
      const dir = path.resolve('tmp/phase7.3-real-constructor', slug);
      try {
        await openQueryConsole(s);
        await loadQueryIntoConstructor(s, fs.readFileSync(file, 'utf8'));
        await saveScreenshot(s.page, dir, 0, 'constructor-opened');
        const n = await walkTabs(s, dir, log, new RecursionGuard({ maxDepth: 2 }));
        log.info(`${slug}: вкладок ${n}`);
        console.log(`${slug}: ${n} вкладок`);
      } catch (e) {
        log.warn(`${slug}: ${(e as Error).message}`);
        console.log(`${slug}: ОШИБКА — ${(e as Error).message}`);
      } finally {
        // Закрыть конструктор, чтобы следующий запрос стартовал с чистой консоли.
        await closeConstructor(s).catch(() => {});
      }
    }
  } finally {
    await close(s);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
