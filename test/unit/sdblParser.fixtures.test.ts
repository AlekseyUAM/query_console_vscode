import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { generateBatch } from '../../src/core/query/sdblGenerator';
import { parseBatch } from '../../src/core/query/sdblParser';
import { assertValidSdbl } from '../helpers/assertValidSdbl';

/**
 * Фикстуры запросов — канонический вывод генератора (см. tmp/genFixtures.mts),
 * сохранённый дословно. Каждая фикстура покрывает класс конструкций визуальной
 * модели (минимальная выборка, агрегаты, виртуальные таблицы РН/РС/РБ, ГДЕ,
 * соединения, группировка/наборы, упорядочивание, итоги, индекс, временные
 * таблицы, построитель, табличные части, объединение, пакет).
 *
 * Свойства, проверяемые для каждой фикстуры:
 *  - parseBatch не бросает;
 *  - идемпотентность: generateBatch(parseBatch(out1)) === out1;
 *  - точность: out1 === исходный текст (фикстуры канонические);
 *  - грамматическая валидность out1 (если вендорена грамматика wasm; иначе пропуск).
 */
const DIR = path.join(__dirname, '..', 'fixtures', 'queries');
const files = fs
  .readdirSync(DIR)
  .filter(f => f.endsWith('.sdbl'))
  .sort();

describe('sdblParser — фикстуры запросов (идемпотентность и точность)', () => {
  it('каталог фикстур не пуст', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');

    it(`${file}: parseBatch не бросает`, () => {
      expect(() => parseBatch(text)).not.toThrow();
    });

    it(`${file}: идемпотентность и точность round-trip`, async () => {
      const out1 = generateBatch(parseBatch(text));
      const out2 = generateBatch(parseBatch(out1));
      expect(out2).toBe(out1);
      // Фикстуры сгенерированы канонически → точное совпадение.
      expect(out1).toBe(text);
      // Грамматическая валидность (самопропуск без wasm-грамматики).
      await assertValidSdbl(out1);
    });
  }
});
