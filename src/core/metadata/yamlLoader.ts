import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import type { MetadataModel, MetaTable, MetaField, MetaType, TableKind, VirtualTableInfo } from './types';
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

// Служебные поля базового регистра, которые в срезе пересобираются в фиксированном
// порядке (а не копируются из базы как есть).
const SLICE_SERVICE_FIELDS: ReadonlySet<string> =
  new Set(['НомерСтроки', 'Активность', 'Период', 'Регистратор', 'ПериодОкончание']);

function buildInfoRegSlices(obj: ParsedObject, base: MetaTable): MetaTable[] {
  if (obj.kind !== 'РегистрСведений') return [];
  const periodicity = (obj.properties as { periodicity?: string } | undefined)?.periodicity;
  if (!periodicity || periodicity === 'Nonperiodical') return [];

  const byName = new Map(base.fields.map(f => [f.name, f]));
  const pull = (name: string, types: MetaType[]): MetaField =>
    byName.get(name) ?? { name, kind: 'standard', types };

  // Состав полей среза по эталону конструктора 1С зависит от режима записи:
  //  - подчинённый регистратору (есть Регистратор): Период, Регистратор, НомерСтроки,
  //    Активность + измерения/ресурсы/реквизиты; ПериодОкончание отсутствует;
  //  - независимый (нет Регистратора): Период, ПериодОкончание + измерения/ресурсы/реквизиты.
  const subordinate = byName.has('Регистратор');
  const standard: MetaField[] = [pull('Период', [{ primitive: 'Дата' }])];
  if (subordinate) {
    standard.push(pull('Регистратор', [{}]));
    standard.push(pull('НомерСтроки', [{ primitive: 'Число' }]));
    standard.push(pull('Активность', [{ primitive: 'Булево' }]));
  } else {
    standard.push({ name: 'ПериодОкончание', kind: 'standard', types: [{ primitive: 'Дата' }] });
  }

  const rest = base.fields.filter(f => !SLICE_SERVICE_FIELDS.has(f.name));
  const sliceFields: MetaField[] = [...standard, ...rest];

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

// Развёртка ресурса <R> по виду виртуальной таблицы (по эталону конструктора 1С):
//  Остатки           → <R>Остаток
//  Обороты (Остатки) → <R>Оборот, <R>Приход, <R>Расход
//  Обороты (Обороты) → <R>Оборот
//  ОстаткиИОбороты   → <R>НачальныйОстаток, <R>КонечныйОстаток, <R>Оборот, <R>Приход, <R>Расход
function expandResources(resources: MetaField[], suffixes: string[]): MetaField[] {
  return resources.flatMap(r =>
    suffixes.map((s): MetaField => ({ name: `${r.name}${s}`, kind: 'resource', types: r.types }))
  );
}

function buildAccumRegSlices(obj: ParsedObject, base: MetaTable): MetaTable[] {
  if (obj.kind !== 'РегистрНакопления') return [];
  const registerType = (obj.properties as { registerType?: string } | undefined)?.registerType ?? 'Balance';
  const isBalance = registerType !== 'Turnovers';

  const dims = base.fields.filter(f => f.kind === 'dimension');
  const resources = base.fields.filter(f => f.kind === 'resource');

  const makeVT = (slice: VirtualTableInfo['slice'], resourceFields: MetaField[]): MetaTable => ({
    kind: 'РегистрНакопления',
    name: `${obj.name}.${slice}`,
    fullName: `${obj.fullName}.${slice}`,
    // Период-независимая часть: измерения + развёрнутые ресурсы. Период-поля
    // (зависят от выбранной периодичности) добавляются на слое webview.
    fields: [...dims.map(d => ({ ...d })), ...resourceFields],
    virtual: { slice, baseFullName: obj.fullName },
  });

  const oborotSuffixes = isBalance ? ['Оборот', 'Приход', 'Расход'] : ['Оборот'];

  const result: MetaTable[] = [];
  if (isBalance) {
    result.push(makeVT('Остатки', expandResources(resources, ['Остаток'])));
  }
  result.push(makeVT('Обороты', expandResources(resources, oborotSuffixes)));
  if (isBalance) {
    result.push(makeVT('ОстаткиИОбороты',
      expandResources(resources, ['НачальныйОстаток', 'КонечныйОстаток', 'Оборот', 'Приход', 'Расход'])));
  }
  return result;
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

    for (const slice of buildAccumRegSlices(obj, metaTable)) {
      tables.push(slice);
    }
  }

  return { version: 1, tables };
}
