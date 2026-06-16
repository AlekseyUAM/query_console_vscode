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

    expect(fields[0].types).toEqual([{ primitive: 'Строка', length: 100 }]);
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

  it('maps unknown/timestamp ref types to empty MetaType', () => {
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
    // Перечисление is now a supported kind, so ref resolves correctly
    expect(fields[2].types).toEqual([{ ref: { kind: 'Перечисление', name: 'СтатусыЗаказов' } }]);
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

  it('maps tabular sections onto parent table and into flat tables[]', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Документ', name: 'Заказ', fullName: 'Документ.Заказ', file: 'Documents/Заказ.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Documents/Заказ.yaml', {
      version: 1,
      kind: 'Документ',
      name: 'Заказ',
      fullName: 'Документ.Заказ',
      uuid: 'doc-1',
      fields: [
        { name: 'Ссылка', category: 'standard', types: [] },
      ],
      tabularSections: [
        {
          name: 'Товары',
          uuid: 'ts-1',
          fields: [
            { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число', digits: 5 }] },
            { name: 'Номенклатура', category: 'attribute', types: [] },
          ],
        },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);

    // flat tables[]: parent + TS entry
    expect(result.tables).toHaveLength(2);

    const parent = result.tables.find(t => t.fullName === 'Документ.Заказ')!;
    expect(parent.kind).toBe('Документ');
    expect(parent.tabularSections).toHaveLength(1);
    expect(parent.tabularSections![0].name).toBe('Товары');
    expect(parent.tabularSections![0].fullName).toBe('Документ.Заказ.Товары');
    expect(parent.tabularSections![0].kind).toBe('ТабличнаяЧасть');
    expect(parent.tabularSections![0].fields).toHaveLength(3); // Ссылка + НомерСтроки + Номенклатура

    // TS also present as flat entry for lookup by fullName
    const tsFlat = result.tables.find(t => t.fullName === 'Документ.Заказ.Товары')!;
    expect(tsFlat.kind).toBe('ТабличнаяЧасть');
    expect(tsFlat.fields[0].name).toBe('Ссылка');
    expect(tsFlat.fields[2].name).toBe('Номенклатура');
  });

  it('parent without tabular sections has no tabularSections property', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Справочник', name: 'Простой', fullName: 'Справочник.Простой', file: 'Catalogs/Простой.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Catalogs/Простой.yaml', {
      version: 1,
      kind: 'Справочник',
      name: 'Простой',
      fullName: 'Справочник.Простой',
      uuid: 'x',
      fields: [{ name: 'Код', category: 'standard', types: [] }],
    });

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].tabularSections).toBeUndefined();
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

  it('loads a РегистрСведений with dimension fields', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'РегистрСведений', name: 'Курсы', fullName: 'РегистрСведений.Курсы', file: 'InformationRegisters/Курсы.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'InformationRegisters/Курсы.yaml', {
      version: 1,
      kind: 'РегистрСведений',
      name: 'Курсы',
      fullName: 'РегистрСведений.Курсы',
      uuid: 'ir-1',
      fields: [
        { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число', digits: 9, fractionDigits: 0 }] },
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата', dateFractions: 'DateTime' }] },
        { name: 'Валюта', category: 'dimension', types: [{ kind: 'ref', ref: 'Справочник.Валюты' }] },
        { name: 'Курс', category: 'resource', types: [{ kind: 'Число', digits: 15, fractionDigits: 4 }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.kind).toBe('РегистрСведений');
    expect(table.name).toBe('Курсы');

    const валюта = table.fields.find(f => f.name === 'Валюта')!;
    expect(валюта.kind).toBe('dimension');

    const курс = table.fields.find(f => f.name === 'Курс')!;
    expect(курс.kind).toBe('resource');
    expect(курс.types).toEqual([{ primitive: 'Число' }]);
  });

  it('loads a Константа with Значение field', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Константа', name: 'НомерВерсии', fullName: 'Константа.НомерВерсии', file: 'Constants/НомерВерсии.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Constants/НомерВерсии.yaml', {
      version: 1,
      kind: 'Константа',
      name: 'НомерВерсии',
      fullName: 'Константа.НомерВерсии',
      uuid: 'const-1',
      types: [{ kind: 'Строка', length: 20 }],
    });

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.kind).toBe('Константа');
    expect(table.fields).toHaveLength(1);
    expect(table.fields[0].name).toBe('Значение');
    expect(table.fields[0].kind).toBe('standard');
    expect(table.fields[0].types).toEqual([{ primitive: 'Строка', length: 20 }]);
  });

  it('loads a Перечисление with Ссылка and Порядок fields', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Перечисление', name: 'Статусы', fullName: 'Перечисление.Статусы', file: 'Enums/Статусы.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Enums/Статусы.yaml', {
      version: 1,
      kind: 'Перечисление',
      name: 'Статусы',
      fullName: 'Перечисление.Статусы',
      uuid: 'enum-1',
      fields: [
        { name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: 'Перечисление.Статусы' }] },
        { name: 'Порядок', category: 'standard', types: [{ kind: 'Число' }] },
      ],
      values: [{ name: 'Новый' }, { name: 'ВРаботе' }],
    });

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.kind).toBe('Перечисление');
    expect(table.fields.map(f => f.name)).toContain('Ссылка');
    expect(table.fields.map(f => f.name)).toContain('Порядок');
  });

  it('emits СрезПервых and СрезПоследних for a periodical information register', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'РегистрСведений', name: 'Курсы', fullName: 'РегистрСведений.Курсы', file: 'InformationRegisters/Курсы.yaml' },
      ],
    });
    // Независимый периодический РС (parseInformationRegister не добавляет
    // Регистратор/НомерСтроки/Активность для независимых): Период + измерения/ресурсы.
    writeCfYaml(tmpDir, 'InformationRegisters/Курсы.yaml', {
      version: 1, kind: 'РегистрСведений', name: 'Курсы', fullName: 'РегистрСведений.Курсы',
      properties: { periodicity: 'Day' },
      fields: [
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата' }] },
        { name: 'Валюта', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Курс', category: 'resource', types: [{ kind: 'Число' }] },
      ],
    });

    const result: MetadataModel = loadMetadataFromYaml(tmpDir);
    const names = result.tables.map(t => t.fullName);
    expect(names).toContain('РегистрСведений.Курсы');
    expect(names).toContain('РегистрСведений.Курсы.СрезПервых');
    expect(names).toContain('РегистрСведений.Курсы.СрезПоследних');

    const slice = result.tables.find(t => t.fullName === 'РегистрСведений.Курсы.СрезПоследних')!;
    expect(slice.virtual).toEqual({ slice: 'СрезПоследних', baseFullName: 'РегистрСведений.Курсы' });
    // Срез = поля реальной таблицы (копия). Синтетический ПериодОкончание не добавляется.
    const fieldNames = slice.fields.map(f => f.name);
    expect(fieldNames).toEqual(['Период', 'Валюта', 'Курс']);
    expect(fieldNames).not.toContain('ПериодОкончание');
  });

  it('keeps Регистратор/НомерСтроки/Активность for a recorder-subordinate slice', () => {
    // Подчинённый регистратору периодический РС — каждая строка среза соответствует
    // конкретной записи, поэтому срез сохраняет Регистратор/НомерСтроки/Активность.
    // Поля среза = копия полей реальной таблицы (в порядке parseInformationRegister:
    // Регистратор, Период, НомерСтроки, Активность, затем измерения/ресурсы/реквизиты).
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'РегистрСведений', name: 'Согласия', fullName: 'РегистрСведений.Согласия', file: 'InformationRegisters/Согласия.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'InformationRegisters/Согласия.yaml', {
      version: 1, kind: 'РегистрСведений', name: 'Согласия', fullName: 'РегистрСведений.Согласия',
      properties: { periodicity: 'Day' },
      fields: [
        { name: 'Регистратор', category: 'standard', types: [{ kind: 'unknown' }] },
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата' }] },
        { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число' }] },
        { name: 'Активность', category: 'standard', types: [{ kind: 'Булево' }] },
        { name: 'Субъект', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Организация', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Действует', category: 'resource', types: [{ kind: 'Булево' }] },
        { name: 'СрокДействия', category: 'attribute', types: [{ kind: 'Дата' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const slice = result.tables.find(t => t.fullName === 'РегистрСведений.Согласия.СрезПоследних')!;
    const fieldNames = slice.fields.map(f => f.name);
    expect(fieldNames).toEqual(['Регистратор', 'Период', 'НомерСтроки', 'Активность', 'Субъект', 'Организация', 'Действует', 'СрокДействия']);
    expect(fieldNames).not.toContain('ПериодОкончание');
  });

  it('does not emit slices for a non-periodical information register', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'РегистрСведений', name: 'Иерархия', fullName: 'РегистрСведений.Иерархия', file: 'InformationRegisters/Иерархия.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'InformationRegisters/Иерархия.yaml', {
      version: 1, kind: 'РегистрСведений', name: 'Иерархия', fullName: 'РегистрСведений.Иерархия',
      properties: { periodicity: 'Nonperiodical' },
      fields: [
        { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число' }] },
        { name: 'Активность', category: 'standard', types: [{ kind: 'Булево' }] },
        { name: 'Узел', category: 'dimension', types: [{ kind: 'Строка' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const names = result.tables.map(t => t.fullName);
    expect(names).toContain('РегистрСведений.Иерархия');
    expect(names.some(n => n.includes('Срез'))).toBe(false);
  });

  it('maps dimension/resource category to MetaField.kind correctly', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'РегистрНакопления', name: 'Продажи', fullName: 'РегистрНакопления.Продажи', file: 'AccumulationRegisters/Продажи.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'AccumulationRegisters/Продажи.yaml', {
      version: 1,
      kind: 'РегистрНакопления',
      name: 'Продажи',
      fullName: 'РегистрНакопления.Продажи',
      uuid: 'ar-1',
      fields: [
        { name: 'Номенклатура', category: 'dimension', types: [{ kind: 'ref', ref: 'Справочник.Номенклатура' }] },
        { name: 'Количество', category: 'resource', types: [{ kind: 'Число', digits: 15, fractionDigits: 3 }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const table = result.tables[0];
    expect(table.fields.find(f => f.name === 'Номенклатура')?.kind).toBe('dimension');
    expect(table.fields.find(f => f.name === 'Количество')?.kind).toBe('resource');
  });

  it('emits Остатки, Обороты, ОстаткиИОбороты for a balance accumulation register', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'РегистрНакопления', name: 'РегистрНакопленияОст', fullName: 'РегистрНакопления.РегистрНакопленияОст', file: 'AccumulationRegisters/Ост.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'AccumulationRegisters/Ост.yaml', {
      version: 1, kind: 'РегистрНакопления', name: 'РегистрНакопленияОст', fullName: 'РегистрНакопления.РегистрНакопленияОст',
      properties: { registerType: 'Balance' },
      fields: [
        { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число' }] },
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата' }] },
        { name: 'Регистратор', category: 'standard', types: [{ kind: 'unknown' }] },
        { name: 'Измерение1', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Ресурс1', category: 'resource', types: [{ kind: 'Число' }] },
      ],
    });

    const result: MetadataModel = loadMetadataFromYaml(tmpDir);
    const names = result.tables.map(t => t.fullName);
    expect(names).toContain('РегистрНакопления.РегистрНакопленияОст.Остатки');
    expect(names).toContain('РегистрНакопления.РегистрНакопленияОст.Обороты');
    expect(names).toContain('РегистрНакопления.РегистрНакопленияОст.ОстаткиИОбороты');

    const ostatki = result.tables.find(t => t.fullName.endsWith('.Остатки'))!;
    expect(ostatki.virtual).toEqual({ slice: 'Остатки', baseFullName: 'РегистрНакопления.РегистрНакопленияОст' });
    expect(ostatki.fields.map(f => f.name)).toEqual(['Измерение1', 'Ресурс1Остаток']);

    const oboroty = result.tables.find(t => t.fullName.endsWith('.Обороты'))!;
    expect(oboroty.fields.map(f => f.name)).toEqual(['Измерение1', 'Ресурс1Оборот', 'Ресурс1Приход', 'Ресурс1Расход']);

    const oio = result.tables.find(t => t.fullName.endsWith('.ОстаткиИОбороты'))!;
    // Порядок развёртки ресурса по эталону 1С: НачальныйОстаток, Оборот, Приход, Расход, КонечныйОстаток.
    expect(oio.fields.map(f => f.name)).toEqual([
      'Измерение1', 'Ресурс1НачальныйОстаток', 'Ресурс1Оборот', 'Ресурс1Приход', 'Ресурс1Расход', 'Ресурс1КонечныйОстаток',
    ]);
  });

  it('emits 5 accounting VTs (corr) resolving subconto count from chart of accounts', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'ПланСчетов', name: 'ПланСчетов1', fullName: 'ПланСчетов.ПланСчетов1', file: 'ChartsOfAccounts/ПланСчетов1.yaml' },
        { type: 'РегистрБухгалтерии', name: 'РБ1', fullName: 'РегистрБухгалтерии.РБ1', file: 'AccountingRegisters/РБ1.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'ChartsOfAccounts/ПланСчетов1.yaml', {
      version: 1, kind: 'ПланСчетов', name: 'ПланСчетов1', fullName: 'ПланСчетов.ПланСчетов1',
      properties: { maxExtDimensionCount: 3, extDimensionTypes: 'ВидыСубконто' },
      fields: [{ name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: 'ПланСчетов.ПланСчетов1' }] }],
    });
    writeCfYaml(tmpDir, 'AccountingRegisters/РБ1.yaml', {
      version: 1, kind: 'РегистрБухгалтерии', name: 'РБ1', fullName: 'РегистрБухгалтерии.РБ1',
      properties: { correspondence: true, chartOfAccounts: 'ПланСчетов1' },
      fields: [
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата' }] },
        { name: 'СчетДт', category: 'standard', types: [{ kind: 'ref', ref: 'ПланСчетов.ПланСчетов1' }] },
        { name: 'СчетКт', category: 'standard', types: [{ kind: 'ref', ref: 'ПланСчетов.ПланСчетов1' }] },
        { name: 'Организация', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Сумма', category: 'resource', types: [{ kind: 'Число' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const vtNames = result.tables.filter(t => t.virtual).map(t => t.fullName.split('.')[2]);
    expect(vtNames).toEqual(['Остатки', 'Обороты', 'ОборотыДтКт', 'ОстаткиИОбороты', 'ДвиженияССубконто']);
    const ostatki = result.tables.find(t => t.fullName === 'РегистрБухгалтерии.РБ1.Остатки')!;
    expect(ostatki.fields.map(f => f.name)).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Организация',
      'СуммаОстаток', 'СуммаОстатокДт', 'СуммаОстатокКт', 'СуммаРазвернутыйОстатокДт', 'СуммаРазвернутыйОстатокКт',
    ]);
    expect(ostatki.virtual?.correspondence).toBe(true);
  });

  it('emits only Обороты (with Оборот resource) for a turnover accumulation register', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'РегистрНакопления', name: 'РегистрНакопленияОбор', fullName: 'РегистрНакопления.РегистрНакопленияОбор', file: 'AccumulationRegisters/Обор.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'AccumulationRegisters/Обор.yaml', {
      version: 1, kind: 'РегистрНакопления', name: 'РегистрНакопленияОбор', fullName: 'РегистрНакопления.РегистрНакопленияОбор',
      properties: { registerType: 'Turnovers' },
      fields: [
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата' }] },
        { name: 'Измерение1', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Ресурс1', category: 'resource', types: [{ kind: 'Число' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const vtNames = result.tables.filter(t => t.virtual).map(t => t.fullName);
    expect(vtNames).toEqual(['РегистрНакопления.РегистрНакопленияОбор.Обороты']);
    const oboroty = result.tables.find(t => t.virtual)!;
    expect(oboroty.fields.map(f => f.name)).toEqual(['Измерение1', 'Ресурс1Оборот']);
  });
});
