/**
 * Оркестратор корпусного тестирования: parse → extract → ingest:meta → harvest →
 * accept. Каждая ступень запускается ОТДЕЛЬНЫМ процессом (`npm run <ступень>`),
 * а не импортом её `run()`: при бандлинге esbuild страж `require.main === module`
 * у всех вложённых модулей схлопывается в `true`, и они самозапускаются на импорте.
 * Отдельный процесс заодно изолирует `process.exit` внутри ступеней.
 *
 * Флаги:
 *   --skip-parse    пропустить обновление кэша метаданных (npm run parse)
 *   --skip-harvest  пропустить сбор golden через MCP (резюмирование на готовом корпусе)
 *
 * Запуск: node out/cli/corpusTest.js [--skip-parse] [--skip-harvest]
 */
import { spawnSync } from 'child_process';

function log(msg: string): void {
  console.log(`\n=== ${msg} ===`);
}

/** Запустить ступень как `npm run <script>`; при ненулевом коде — прервать весь прогон. */
function step(scriptName: string): void {
  const r = spawnSync('npm', ['run', scriptName], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`Ступень "${scriptName}" завершилась с кодом ${r.status ?? 'null'} — прерывание.`);
    process.exit(r.status ?? 1);
  }
}

function main(): void {
  const skipParse = process.argv.includes('--skip-parse');
  const skipHarvest = process.argv.includes('--skip-harvest');

  if (!skipParse) {
    log('parse — обновление кэша метаданных конструктора');
    step('parse');
  } else {
    log('parse — пропущено (--skip-parse)');
  }

  log('extract — извлечение текстов запросов из конфигурации');
  step('extract');

  log('ingest:meta — внедрение эталонов к метаданным в корпус');
  step('ingest:meta');

  if (!skipHarvest) {
    log('harvest — сбор golden через MCP-оракул');
    step('harvest');
  } else {
    log('harvest — пропущено (--skip-harvest)');
  }

  log('accept — приёмка корпуса против оракула');
  step('accept:oracle');

  log('Готово');
}

if (require.main === module) main();
