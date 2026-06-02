import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stringify } from 'yaml';
import { loadMetadataFromYaml } from '../../src/core/metadata/yamlLoader';
import type { MetadataModel } from '../../src/core/metadata/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-loader-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCfYaml(cfDir: string, relPath: string, data: unknown): void {
  const full = path.join(cfDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, stringify(data, { lineWidth: 0 }));
}

describe('loadMetadataFromYaml', () => {
  it('returns empty model when directory does not exist', () => {
    const result = loadMetadataFromYaml(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual({ version: 1, tables: [] });
  });

  it('returns empty model when configuration.yaml is absent', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const result = loadMetadataFromYaml(tmpDir);
    expect(result).toEqual({ version: 1, tables: [] });
  });

  it('returns empty model when configuration.yaml has no objects', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', { version: 1, name: 'Test', objects: [] });
    const result = loadMetadataFromYaml(tmpDir);
    expect(result).toEqual({ version: 1, tables: [] });
  });

  it('loads a Справочник with standard and attribute fields', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      name: 'TestConf',
      objects: [
        { type: 'Справочник', name: 'Валюты', fullName: 'Справочник.Валюты', file: 'Catalogs/Валюты.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Catalogs/Валюты.yaml', {
      version: 1,
      kind: 'Справочник',
      name: 'Валюты',
      fullName: 'Справочник.Валюты',
      uuid: 'abc-123',
      fields: [
        { name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: 'Справочник.Валюты' }] },
        { name: 'ПометкаУдаления', category: 'standard', types: [{ kind: 'Булево' }] },
        { name: 'ОсновнаяВалюта', category: 'attribute', types: [{ kind: 'ref', ref: 'Справочник.Валюты' }] },
        { name: 'Наценка', category: 'attribute', types: [{ kind: 'Число', digits: 10, fractionDigits: 2 }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);

    expect(result.version).toBe(1);
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.kind).toBe('Справочник');
    expect(table.name).toBe('Валюты');
    expect(table.fullName).toBe('Справочник.Валюты');
    expect(table.fields).toHaveLength(4);
  });

  it('maps primitive types correctly', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Справочник', name: 'Тест', fullName: 'Справочник.Тест', file: 'Catalogs/Тест.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Catalogs/Тест.yaml', {
      version: 1,
      kind: 'Справочник',
      name: 'Тест',
      fullName: 'Справочник.Тест',
      uuid: 'x',
      fields: [
        { name: 'СтроковоеПоле', category: 'attribute', types: [{ kind: 'Строка', length: 100 }] },
        { name: 'ЧисловоеПоле', category: 'attribute', types: [{ kind: 'Число', digits: 10, fractionDigits: 2 }] },
        { name: 'ДатовоеПоле', category: 'attribute', types: [{ kind: 'Дата' }] },
        { name: 'БулевоПоле', category: 'attribute', types: [{ kind: 'Булево' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const fields = result.tables[0].fields;

    expect(fields[0].types).toEqual([{ primitive: 'Строка' }]);
    expect(fields[1].types).toEqual([{ primitive: 'Число' }]);
    expect(fields[2].types).toEqual([{ primitive: 'Дата' }]);
    expect(fields[3].types).toEqual([{ primitive: 'Булево' }]);
  });

  it('maps ref types to Справочник correctly', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Справочник', name: 'Тест', fullName: 'Справочник.Тест', file: 'Catalogs/Тест.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Catalogs/Тест.yaml', {
      version: 1,
      kind: 'Справочник',
      name: 'Тест',
      fullName: 'Справочник.Тест',
      uuid: 'x',
      fields: [
        { name: 'СсылкаНаСправочник', category: 'attribute', types: [{ kind: 'ref', ref: 'Справочник.Валюты' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const field = result.tables[0].fields[0];

    expect(field.types).toEqual([{ ref: { kind: 'Справочник', name: 'Валюты' } }]);
  });

  it('maps ref types to Документ correctly', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Справочник', name: 'Тест', fullName: 'Справочник.Тест', file: 'Catalogs/Тест.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Catalogs/Тест.yaml', {
      version: 1,
      kind: 'Справочник',
      name: 'Тест',
      fullName: 'Справочник.Тест',
      uuid: 'x',
      fields: [
        { name: 'ДокументОснование', category: 'attribute', types: [{ kind: 'ref', ref: 'Документ.РасходнаяНакладная' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const field = result.tables[0].fields[0];

    expect(field.types).toEqual([{ ref: { kind: 'Документ', name: 'РасходнаяНакладная' } }]);
  });

  it('maps unknown/timestamp/enum ref types to empty MetaType', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Справочник', name: 'Тест', fullName: 'Справочник.Тест', file: 'Catalogs/Тест.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Catalogs/Тест.yaml', {
      version: 1,
      kind: 'Справочник',
      name: 'Тест',
      fullName: 'Справочник.Тест',
      uuid: 'x',
      fields: [
        { name: 'ВерсияДанных', category: 'standard', types: [{ kind: 'timestamp' }] },
        { name: 'НеизвестноеПоле', category: 'attribute', types: [{ kind: 'unknown' }] },
        { name: 'СсылкаНаПеречисление', category: 'attribute', types: [{ kind: 'ref', ref: 'Перечисление.СтатусыЗаказов' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const fields = result.tables[0].fields;

    expect(fields[0].types).toEqual([{}]);
    expect(fields[1].types).toEqual([{}]);
    expect(fields[2].types).toEqual([{}]);
  });

  it('loads a Документ with fields', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Документ', name: 'РасходнаяНакладная', fullName: 'Документ.РасходнаяНакладная', file: 'Documents/РасходнаяНакладная.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Documents/РасходнаяНакладная.yaml', {
      version: 1,
      kind: 'Документ',
      name: 'РасходнаяНакладная',
      fullName: 'Документ.РасходнаяНакладная',
      uuid: 'doc-1',
      fields: [
        { name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: 'Документ.РасходнаяНакладная' }] },
        { name: 'Организация', category: 'attribute', types: [{ kind: 'ref', ref: 'Справочник.Организации' }] },
        { name: 'Сумма', category: 'attribute', types: [{ kind: 'Число', digits: 15, fractionDigits: 2 }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);

    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.kind).toBe('Документ');
    expect(table.name).toBe('РасходнаяНакладная');
    expect(table.fullName).toBe('Документ.РасходнаяНакладная');
    expect(table.fields).toHaveLength(3);
    expect(table.fields[0].kind).toBe('standard');
    expect(table.fields[1].kind).toBe('attribute');
    expect(table.fields[2].types).toEqual([{ primitive: 'Число' }]);
  });

  it('skips objects of unsupported types (Перечисление, Константа)', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Перечисление', name: 'Статусы', fullName: 'Перечисление.Статусы', file: 'Enums/Статусы.yaml' },
        { type: 'Константа', name: 'НомерВерсии', fullName: 'Константа.НомерВерсии', file: 'Constants/НомерВерсии.yaml' },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(0);
  });

  it('skips objects whose YAML file is missing', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Справочник', name: 'Несуществующий', fullName: 'Справочник.Несуществующий', file: 'Catalogs/Несуществующий.yaml' },
      ],
    });
    // The actual YAML file is not written - should be skipped gracefully

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(0);
  });

  it('loads multiple tables of mixed types', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Справочник', name: 'Валюты', fullName: 'Справочник.Валюты', file: 'Catalogs/Валюты.yaml' },
        { type: 'Документ', name: 'ПриходнаяНакладная', fullName: 'Документ.ПриходнаяНакладная', file: 'Documents/ПриходнаяНакладная.yaml' },
        { type: 'Перечисление', name: 'СтатусыЗаказов', fullName: 'Перечисление.СтатусыЗаказов', file: 'Enums/СтатусыЗаказов.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Catalogs/Валюты.yaml', {
      version: 1,
      kind: 'Справочник',
      name: 'Валюты',
      fullName: 'Справочник.Валюты',
      uuid: 'c-1',
      fields: [{ name: 'Код', category: 'standard', types: [{ kind: 'Строка', length: 3 }] }],
    });
    writeCfYaml(tmpDir, 'Documents/ПриходнаяНакладная.yaml', {
      version: 1,
      kind: 'Документ',
      name: 'ПриходнаяНакладная',
      fullName: 'Документ.ПриходнаяНакладная',
      uuid: 'd-1',
      fields: [{ name: 'Номер', category: 'standard', types: [{ kind: 'Строка', length: 11 }] }],
    });

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(2);
    expect(result.tables.map(t => t.kind)).toContain('Справочник');
    expect(result.tables.map(t => t.kind)).toContain('Документ');
  });

  it('skips objects whose YAML file is malformed', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Справочник', name: 'Плохой', fullName: 'Справочник.Плохой', file: 'Catalogs/Плохой.yaml' },
      ],
    });
    const badPath = path.join(tmpDir, 'Catalogs/Плохой.yaml');
    fs.mkdirSync(path.dirname(badPath), { recursive: true });
    fs.writeFileSync(badPath, ':\tinvalid: yaml: :::');

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(0);
  });
});
