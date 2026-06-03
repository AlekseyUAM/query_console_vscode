import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import type { MetadataModel, MetaTable, MetaField, MetaType, TableKind } from './types';
import type { ParsedObject, ParsedField, ParsedType } from './parser/model';

const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
  'Справочник', 'Документ', 'Константа', 'Перечисление',
  'ПланОбмена', 'ПланВидовХарактеристик', 'ПланСчетов', 'ПланВидовРасчета',
  'БизнесПроцесс', 'Задача',
  'РегистрСведений', 'РегистрНакопления', 'РегистрБухгалтерии', 'РегистрРасчета',
  'Последовательность', 'ЖурналДокументов', 'КритерийОтбора',
]);

function mapParsedType(pt: ParsedType): MetaType {
  const k = pt.kind;
  if (k === 'Строка' || k === 'Число' || k === 'Булево' || k === 'Дата') {
    return { primitive: k };
  }
  if (k === 'ref' && pt.ref) {
    const match = pt.ref.match(
      /^(Справочник|Документ|Константа|Перечисление|ПланОбмена|ПланВидовХарактеристик|ПланСчетов|ПланВидовРасчета|БизнесПроцесс|Задача|РегистрСведений|РегистрНакопления|РегистрБухгалтерии|РегистрРасчета|Последовательность|ЖурналДокументов|КритерийОтбора)\.(.+)$/
    );
    if (match) {
      return { ref: { kind: match[1] as TableKind, name: match[2] } };
    }
  }
  return {};
}

function mapParsedField(pf: ParsedField): MetaField {
  return {
    name: pf.name,
    kind: pf.category,
    types: (pf.types ?? []).map(mapParsedType),
  };
}

function parsedObjectToMetaTable(obj: ParsedObject): MetaTable {
  if (obj.kind === 'Константа') {
    return {
      kind: 'Константа',
      name: obj.name,
      fullName: obj.fullName,
      fields: [{
        name: 'Значение',
        kind: 'standard',
        types: (obj.types ?? []).map(mapParsedType),
      }],
    };
  }

  const tabularSections: MetaTable[] = (obj.tabularSections ?? []).map(ts => ({
    kind: 'ТабличнаяЧасть' as TableKind,
    name: ts.name,
    fullName: `${obj.fullName}.${ts.name}`,
    fields: [
      { name: 'Ссылка', kind: 'standard' as const, types: [{ ref: { kind: obj.kind as TableKind, name: obj.name } }] },
      ...(ts.fields ?? []).map(mapParsedField),
    ],
  }));

  return {
    kind: obj.kind as TableKind,
    name: obj.name,
    fullName: obj.fullName,
    fields: (obj.fields ?? []).map(mapParsedField),
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}

const SLICE_EXCLUDED: ReadonlySet<string> = new Set(['НомерСтроки', 'Активность', 'Регистратор', 'Период']);

function buildInfoRegSlices(obj: ParsedObject, base: MetaTable): MetaTable[] {
  if (obj.kind !== 'РегистрСведений') return [];
  const periodicity = (obj.properties as { periodicity?: string } | undefined)?.periodicity;
  if (!periodicity || periodicity === 'Nonperiodical') return [];

  // Поля среза по скриншотам конструктора 1С: Период + ПериодОкончание (именно
  // «ПериодОкончание», как в эталонном тексте запроса) + измерения/ресурсы/реквизиты
  // базового регистра без стандартных служебных полей.
  const sliceFields: MetaField[] = [
    { name: 'Период', kind: 'standard', types: [{ primitive: 'Дата' }] },
    { name: 'ПериодОкончание', kind: 'standard', types: [{ primitive: 'Дата' }] },
    ...base.fields.filter(f => !SLICE_EXCLUDED.has(f.name)),
  ];

  const slices: ('СрезПервых' | 'СрезПоследних')[] = ['СрезПервых', 'СрезПоследних'];
  // Каждый срез получает собственную копию массива полей, чтобы будущие потребители
  // не могли случайно мутировать поля обоих срезов сразу.
  return slices.map((slice): MetaTable => ({
    kind: 'РегистрСведений',
    name: `${obj.name}.${slice}`,
    fullName: `${obj.fullName}.${slice}`,
    fields: [...sliceFields],
    virtual: { slice, baseFullName: obj.fullName },
  }));
}

interface IndexEntry {
  type: string;
  name: string;
  fullName: string;
  file: string;
}

interface ConfigurationIndex {
  version: number;
  name?: string;
  objects?: IndexEntry[];
}

export function loadMetadataFromYaml(cfYamlDir: string): MetadataModel {
  const empty: MetadataModel = { version: 1, tables: [] };

  const configPath = path.join(cfYamlDir, 'configuration.yaml');
  if (!fs.existsSync(configPath)) {
    return empty;
  }

  let index: ConfigurationIndex;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    index = parse(raw) as ConfigurationIndex;
  } catch {
    return empty;
  }

  if (!index?.objects?.length) {
    return empty;
  }

  const tables: MetaTable[] = [];

  for (const entry of index.objects) {
    if (!SUPPORTED_KINDS.has(entry.type)) {
      continue;
    }

    const filePath = path.join(cfYamlDir, entry.file);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    let obj: ParsedObject;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      obj = parse(raw) as ParsedObject;
      if (!obj || !obj.name || !obj.kind) continue;
    } catch {
      continue;
    }

    const metaTable = parsedObjectToMetaTable(obj);
    tables.push(metaTable);

    for (const ts of metaTable.tabularSections ?? []) {
      tables.push(ts);
    }

    for (const slice of buildInfoRegSlices(obj, metaTable)) {
      tables.push(slice);
    }
  }

  return { version: 1, tables };
}
