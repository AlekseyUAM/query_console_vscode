// tooling/corpus-verify/verify.ts
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { chromium, type Browser } from '@playwright/test';
import { parseBatch } from '../../src/core/query/sdblParser';
import { extractFeatures } from './features';
import { classifyCorpus, sampleRepresentatives, type CorpusEntry } from './classes';
import { checkStructure, checkContent, type UiSnapshot, type Violation } from './invariants';
import { formatCoverageReport, type QueryResult } from './report';
import { SNAPSHOT_FN } from './snapshot';
import { saveScreenshot } from '../real-constructor/screenshot';
import { loadMetaTables, writeHarnessMetadata } from '../our-constructor/metadata';

const CORPUS_DIR = path.resolve('tmp/query1c');
const OUT_DIR = path.resolve('tmp/phase7.6-corpus-verify');
const HARNESS_DIR = path.resolve('tooling/our-constructor/harness');
const WEBVIEW_BUNDLE = path.resolve('out/webview/main.js');
const PER_CLASS = Number(process.env.PER_CLASS ?? 2);
const MAX_SAMPLE = process.env.MAX_SAMPLE ? Number(process.env.MAX_SAMPLE) : undefined;
const PORT = 5599;

/** Готовит harness-каталог: копирует свежий бандл и пишет metadata.json (in-process). */
function prepareHarness(): number {
  if (!fs.existsSync(WEBVIEW_BUNDLE)) {
    throw new Error(`Нет бандла webview: ${WEBVIEW_BUNDLE}. Сначала npm run build:webview.`);
  }
  fs.copyFileSync(WEBVIEW_BUNDLE, path.join(HARNESS_DIR, 'main.js'));
  const tables = loadMetaTables();
  writeHarnessMetadata(HARNESS_DIR, tables);
  return tables.length;
}

/** Поднимает статический сервер harness; ждёт готовности через readiness-poll. */
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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Подготовка harness (in-process, до запуска сервера).
  const tableCount = prepareHarness();
  console.log(`Метаданные: ${tableCount} таблиц`);

  // 1. Классификация всего корпуса (pure, без браузера).
  const files = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith('.txt')).sort();
  const entries: CorpusEntry[] = [];
  const parseFailures: string[] = [];
  for (const name of files) {
    try {
      const fv = extractFeatures(parseBatch(fs.readFileSync(path.join(CORPUS_DIR, name), 'utf8')));
      entries.push({ name, fv });
    } catch (e) {
      parseFailures.push(`${name}: ${(e as Error).message}`);
    }
  }
  const classes = classifyCorpus(entries);
  // При ограничении MAX_SAMPLE берём представителей из САМЫХ КРУПНЫХ классов (наибольшее
  // покрытие корпуса), т.к. `classes` отсортированы по размеру убыв.; иначе — полный
  // детерминированный набор представителей (по одному+ на каждый класс).
  let sampled: string[];
  if (MAX_SAMPLE !== undefined) {
    const picked: string[] = [];
    outer: for (const c of classes) {
      for (const m of c.members.slice(0, PER_CLASS)) {
        picked.push(m);
        if (picked.length >= MAX_SAMPLE) break outer;
      }
    }
    sampled = picked;
  } else {
    sampled = sampleRepresentatives(classes, PER_CLASS);
  }
  const fvByName = new Map(entries.map(e => [e.name, e.fv]));
  console.log(`Корпус: ${files.length}, классов: ${classes.length}, выборка: ${sampled.length}${MAX_SAMPLE !== undefined ? ` (ограничено MAX_SAMPLE=${MAX_SAMPLE})` : ''}, parse-fail: ${parseFailures.length}`);

  // 2. Прогон выборки через webview (DOM-снимок → инварианты, скриншот только на провал).
  const server = await startServer();
  let browser: Browser | undefined;
  const results: QueryResult[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();
    const url = `http://localhost:${PORT}/index.html`;
    // Свежая страница на КАЖДЫЙ запрос — как боевой extension (createPanel создаёт новый
    // webview и шлёт loadModel один раз). Многократный loadModel в одном долгоживущем
    // webview накапливал состояние и после ~3 загрузок переставал отрисовывать панель
    // «Таблицы» (артефакт harness, не баг для пользователя: panel.ts не переиспользует
    // webview). Перезагрузка на каждый запрос устраняет накопление.
    let pageError: string | null = null;
    page.on('pageerror', e => { pageError = e.message; });
    for (const name of sampled) {
      const text = fs.readFileSync(path.join(CORPUS_DIR, name), 'utf8');
      const fv = fvByName.get(name)!;
      try {
        pageError = null;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => (window as any).__metaApplied === true, undefined, { timeout: 60_000 });
        await page.evaluate(t => (window as any).__inv.loadQuery(t), text);
        await page.locator('[data-testid="tabsbar"] [data-tab]').first().waitFor({ timeout: 30_000 });
        // Холодный рендер дерева «База данных» (6899 таблиц) + loadModel: даём устаканиться.
        await page.waitForTimeout(1000);
        const snap0 = (await page.evaluate(`(${SNAPSHOT_FN})()`)) as UiSnapshot;
        if (pageError) {
          results.push({ name, key: '', violations: [{ code: 'TABS', detail: `pageerror: ${pageError}` }] });
          await saveScreenshot(page, path.join(OUT_DIR, name.replace(/\.[^.]+$/, '')), 0, 'violation');
          continue;
        }
        // Структурные инварианты (вкладки/число таблиц) — один раз на дефолтной вкладке.
        // Контентные (дубли полей/обрезка) — на КАЖДОЙ видимой вкладке: обходим их,
        // аккумулируя и дедуплицируя нарушения (с пометкой вкладки). Так инварианты
        // DUP_FIELDS/CLIP реально срабатывают на «Порядок»/«Связи»/… а не только на старте.
        const seen = new Set<string>();
        const violations: Violation[] = [];
        const add = (vs: Violation[], tab: string) => {
          for (const v of vs) {
            const k = `${v.code}|${v.detail}`;
            if (seen.has(k)) continue;
            seen.add(k);
            violations.push({ code: v.code, detail: `[${tab}] ${v.detail}` });
          }
        };
        add(checkStructure(snap0, fv), 'Таблицы и поля');
        add(checkContent(snap0), 'Таблицы и поля');
        for (const tab of snap0.tabs) {
          if (tab === 'Таблицы и поля') continue;
          await page.locator(`[data-testid="tabsbar"] [data-tab="${tab}"]`).first().click();
          await page.waitForTimeout(350);
          add(checkContent((await page.evaluate(`(${SNAPSHOT_FN})()`)) as UiSnapshot), tab);
        }
        results.push({ name, key: '', violations });
        if (violations.length > 0) {
          await saveScreenshot(page, path.join(OUT_DIR, name.replace(/\.[^.]+$/, '')), 0, 'violation');
        }
      } catch (e) {
        results.push({ name, key: '', violations: [{ code: 'TABS', detail: `прогон упал: ${(e as Error).message}` }] });
      }
    }
  } finally {
    await browser?.close();
    server.kill();
  }

  // 3. Отчёт.
  const report = formatCoverageReport({ classes, sampled, results })
    + (parseFailures.length ? `\n## Parse-фейлы (${parseFailures.length})\n` + parseFailures.slice(0, 50).map(s => `- ${s}`).join('\n') + '\n' : '');
  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), report);
  console.log(`Отчёт: ${path.join(OUT_DIR, 'REPORT.md')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
