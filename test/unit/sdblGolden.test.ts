import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadMetadataFromYaml } from '../../src/core/metadata/yamlLoader';
import { generate } from '../../src/core/query/sdblGenerator';
import { buildSelectAllModel } from '../../src/core/query/buildSelectAllModel';
import type { MetaTable } from '../../src/core/metadata/types';

const REF_DIR = path.resolve(__dirname, '../../tmp/meta1c');
const YAML_DIR = path.resolve(__dirname, '../../tmp/parser_data/cf');
const model = loadMetadataFromYaml(YAML_DIR);
const byFull = new Map(model.tables.map(t => [t.fullName, t]));

/**
 * Убирает удвоение полей табличных частей в эталоне. Скрипт-выгрузка 1С,
 * сформировавший tmp/meta1c, дублирует каждое поле ТЧ (второй раз — с числовым
 * суффиксом псевдонима: `Ссылка КАК Ссылка1`). Это артефакт выгрузки, а не вывод
 * конструктора 1С, поэтому для сравнения с generate() дубли удаляются.
 *
 * Внутри блока `<...>.( ... )` оставляем только строки-подполя, где псевдоним
 * совпадает с именем поля (`X КАК X`), и заново расставляем запятые.
 */
function dedupeTabSections(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let buf: string[] | null = null; // накопитель подполей внутри ТЧ-блока
  const flush = () => {
    if (!buf) return;
    const kept = buf.filter(l => {
      const m = l.trim().replace(/,\s*$/, '').match(/^(.+?) КАК (.+)$/);
      return m ? m[1] === m[2] : true;
    });
    kept.forEach((l, i) => {
      const core = l.replace(/,\s*$/, '');
      out.push(i < kept.length - 1 ? core + ',' : core);
    });
    buf = null;
  };
  for (const line of lines) {
    if (buf === null && /\.\($/.test(line.trimEnd())) { out.push(line); buf = []; continue; }
    if (buf !== null && /^\t\)\s*КАК/.test(line)) { flush(); out.push(line); continue; }
    if (buf !== null) { buf.push(line); continue; }
    out.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * Читает эталонный файл и нормализует его:
 * - снимает BOM (U+FEFF / EF BB BF): файлы 1С сохраняются с BOM
 * - нормализует CRLF → LF: файлы 1С используют CRLF, generate() — LF
 * - снимает удвоение полей ТЧ (артефакт выгрузки, см. dedupeTabSections)
 * Trailing-newline: файлы не содержат завершающего перевода строки, generate() тоже.
 */
function ref(file: string): string {
  const raw = fs.readFileSync(path.join(REF_DIR, file), 'utf8')
    .replace(/^﻿/, '')        // снять BOM
    .replace(/\r\n/g, '\n');  // нормализовать CRLF → LF
  return dedupeTabSections(raw);
}

function gen(fullName: string, periodicity?: string): string {
  const t = byFull.get(fullName) as MetaTable;
  expect(t, `таблица ${fullName} есть в модели`).toBeTruthy();
  return generate(buildSelectAllModel(t, periodicity));
}

describe('golden: справочники', () => {
  it('Справочник.Валюты', () => {
    expect(gen('Справочник.Валюты')).toBe(ref('СправочникВалюты.txt'));
  });
});
