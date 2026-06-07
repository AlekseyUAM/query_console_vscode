import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import type { MetadataModel, MetaTable, MetaField, MetaType, TableKind, VirtualTableInfo } from './types';
import type { ParsedObject, ParsedField, ParsedType } from './parser/model';
import { buildAccountingRegSlices, type AccChartInfo } from './accountingVirtualTables';

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

function buildInfoRegSlices(obj: ParsedObject, base: MetaTable): MetaTable[] {
  if (obj.kind !== 'РегистрСведений') return [];
  const periodicity = (obj.properties as { periodicity?: string } | undefined)?.periodicity;
  if (!periodicity || periodicity === 'Nonperiodical') return [];

  // Поля среза совпадают с полями реальной таблицы (она уже в порядке 1С: Период /
  // Регистратор / НомерСтроки / Активность — если есть — затем измерения, ресурсы,
  // реквизиты). Срез подчинённого регистра сохраняет Регистратор/НомерСтроки/Активность
  // (каждая строка среза — конкретная запись). ПериодОкончание отдельным полем не
  // добавляется: если оно есть, это обычное измерение и уже присутствует в base.
  const slices: ('СрезПервых' | 'СрезПоследних')[] = ['СрезПервых', 'СрезПоследних'];
  // Каждый срез получает собственную копию массива полей, чтобы будущие потребители
  // не могли случайно мутировать поля обоих срезов сразу.
  return slices.map((slice): MetaTable => ({
    kind: 'РегистрСведений',
    name: `${obj.name}.${slice}`,
    fullName: `${obj.fullName}.${slice}`,
    fields: base.fields.map(f => ({ ...f })),
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
      expandResources(resources, ['НачальныйОстаток', 'Оборот', 'Приход', 'Расход', 'КонечныйОстаток'])));
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

  const charts = new Map<string, AccChartInfo>();
  for (const entry of index.objects) {
    if (entry.type !== 'ПланСчетов') continue;
    const fp = path.join(cfYamlDir, entry.file);
    if (!fs.existsSync(fp)) continue;
    try {
      const o = parse(fs.readFileSync(fp, 'utf8')) as ParsedObject;
      const p = o?.properties as { maxExtDimensionCount?: number; extDimensionTypes?: string } | undefined;
      charts.set(o.name, {
        maxExtDimensionCount: p?.maxExtDimensionCount ?? 0,
        extDimensionTypes: p?.extDimensionTypes ?? '',
      });
    } catch { /* пропустить нечитаемый план счетов */ }
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

    for (const slice of buildAccountingRegSlices(obj, metaTable, charts)) {
      tables.push(slice);
    }
  }

  return { version: 1, tables };
}
