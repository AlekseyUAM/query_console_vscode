import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseBatch } from '../../src/core/query/sdblParser';
import { generateBatch } from '../../src/core/query/sdblGenerator';

const DIR = path.resolve(__dirname, '../fixtures/oracle');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

describe('oracle golden (курируемые эталоны конструктора)', () => {
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (f.includes('todo')) {
      // Расхождение задокументировано под 6.8 — регистрируем имя без проверки.
      it.todo(`${f}: ${c.name}`);
      continue;
    }
    it(`${f}: ${c.name}`, () => {
      expect(generateBatch(parseBatch(c.input))).toBe(c.expected);
    });
  }
});
