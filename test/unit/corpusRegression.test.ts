/**
 * Корпусный регресс-тест: байт-в-байт воспроизведение оракула на всём корпусе
 * из 1976 запросов. Это закоммиченная версия гейта `npm run accept:oracle`,
 * не зависящая от `tmp/` и MCP — данные лежат в `test/fixtures/corpus/`:
 *   - golden.jsonl       — {file, valid, input, query_text} по каждому запросу
 *   - metadata/cf/       — YAML-кэш метаданных для развёртки `ВЫБРАТЬ *` (6.15.15)
 *
 * Критерий приёмки одного запроса: generateBatch(parseBatch(input, resolver))
 * === query_text оракула. ГЕЙТ: расхождений быть НЕ должно (см. accept:oracle = 1976/1976).
 *
 * Обновление эталона после осознанных изменений конструктора: `npm run corpus:snapshot`
 * (перельёт свежие golden.jsonl + metadata из рабочего прогона harvest/parse).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseBatch } from '../../src/core/query/sdblParser';
import { generateBatch } from '../../src/core/query/sdblGenerator';
import { buildYamlResolver } from '../../src/core/metadata/buildYamlResolver';

interface Golden { file: string; valid: boolean; input: string; query_text: string; }

const CORPUS_DIR = path.resolve(__dirname, '../fixtures/corpus');
const GOLDEN = path.join(CORPUS_DIR, 'golden.jsonl');

const golden: Golden[] = fs.existsSync(GOLDEN)
  ? fs.readFileSync(GOLDEN, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];

describe('корпус 1С: байт-в-байт против оракула (закоммиченный гейт)', () => {
  // Резолвер метаданных для развёртки `*`/`Таблица.*` — из закоммиченного YAML-кэша.
  const resolver = buildYamlResolver(path.join(CORPUS_DIR, 'metadata', 'cf'));

  it('golden-эталон присутствует и непуст', () => {
    expect(golden.length).toBeGreaterThan(0);
  });

  it('каждый запрос корпуса воспроизводится байт-в-байт', () => {
    const failures: Array<{ file: string; reason: string }> = [];
    for (const g of golden) {
      if (!g.valid) continue;
      let ours: string;
      try {
        ours = generateBatch(parseBatch(g.input, resolver));
      } catch (e) {
        failures.push({ file: g.file, reason: `parse-exception: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      if (ours !== g.query_text) {
        // Первая расходящаяся строка — для быстрой локализации.
        const la = ours.split('\n');
        const lb = g.query_text.split('\n');
        let line = 0;
        for (let i = 0; i < Math.max(la.length, lb.length); i++) {
          if ((la[i] ?? '') !== (lb[i] ?? '')) { line = i + 1; break; }
        }
        failures.push({ file: g.file, reason: `mismatch @L${line}` });
      }
    }
    // Сообщение перечисляет первые расхождения, если гейт упал.
    const preview = failures.slice(0, 20).map((f) => `  ${f.file} — ${f.reason}`).join('\n');
    expect(failures, `Корпусных расхождений: ${failures.length}\n${preview}`).toEqual([]);
  });
});
