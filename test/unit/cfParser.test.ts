import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseCf, parseCatalogXml, parseDocumentXml } from '../../src/core/metadata/cfParser';

const FIXTURES_CF = path.join(__dirname, '..', 'fixtures', 'cf');

describe('parseCatalogXml', () => {
  it('extracts name and fullName', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Catalogs', 'Тест.xml'), 'utf8'
    );
    const table = parseCatalogXml(xml);
    expect(table?.name).toBe('Тест');
    expect(table?.fullName).toBe('Справочник.Тест');
    expect(table?.kind).toBe('Справочник');
  });

  it('includes standard Catalog fields first', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Catalogs', 'Тест.xml'), 'utf8'
    );
    const table = parseCatalogXml(xml)!;
    const stdNames = table.fields.filter(f => f.kind === 'standard').map(f => f.name);
    expect(stdNames).toEqual(['Ссылка', 'Код', 'Наименование', 'ПометкаУдаления', 'Предопределенный']);
  });

  it('parses xs:boolean attribute type', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Catalogs', 'Тест.xml'), 'utf8'
    );
    const table = parseCatalogXml(xml)!;
    const активен = table.fields.find(f => f.name === 'Активен');
    expect(активен?.kind).toBe('attribute');
    expect(активен?.types).toEqual([{ primitive: 'Булево' }]);
  });

  it('parses cfg:CatalogRef type as ref', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Catalogs', 'Тест.xml'), 'utf8'
    );
    const table = parseCatalogXml(xml)!;
    const валюта = table.fields.find(f => f.name === 'Валюта');
    expect(валюта?.types).toEqual([{ ref: { kind: 'Справочник', name: 'Валюты' } }]);
  });

  it('returns null for malformed XML', () => {
    expect(parseCatalogXml('<broken xml<<')).toBeNull();
  });

  it('parses XML with a leading UTF-8 BOM', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Catalogs', 'Тест.xml'), 'utf8'
    );
    const table = parseCatalogXml('﻿' + xml);
    expect(table?.name).toBe('Тест');
  });
});

describe('parseDocumentXml', () => {
  it('extracts Document with correct kind and standard fields', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Documents', 'ТестДок.xml'), 'utf8'
    );
    const table = parseDocumentXml(xml);
    expect(table?.name).toBe('ТестДок');
    expect(table?.kind).toBe('Документ');
    const stdNames = table!.fields.filter(f => f.kind === 'standard').map(f => f.name);
    expect(stdNames).toEqual(['Ссылка', 'Номер', 'Дата', 'Проведен', 'ПометкаУдаления']);
  });

  it('parses xs:decimal as Число', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Documents', 'ТестДок.xml'), 'utf8'
    );
    const table = parseDocumentXml(xml)!;
    const сумма = table.fields.find(f => f.name === 'Сумма');
    expect(сумма?.types).toEqual([{ primitive: 'Число' }]);
  });
});

describe('parseCf', () => {
  it('scans Catalogs/ and Documents/ subdirectories', () => {
    const model = parseCf(FIXTURES_CF);
    expect(model.version).toBe(1);
    const names = model.tables.map(t => t.name);
    expect(names).toContain('Тест');
    expect(names).toContain('ТестДок');
  });

  it('returns empty tables when cfPath does not exist', () => {
    const model = parseCf('/nonexistent/path/cf');
    expect(model.version).toBe(1);
    expect(model.tables).toEqual([]);
  });
});
