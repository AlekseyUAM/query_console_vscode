import type { MetaField, MetaTable, VirtualTableInfo } from './types';
import type { ParsedObject } from './parser/model';

export interface AccChartInfo {
  maxExtDimensionCount: number;
  extDimensionTypes: string; // имя ПВХ, напр. 'ВидыСубконто'
}

const RESOURCE_SUFFIXES: Record<string, string[]> = {
  Остатки: ['Остаток', 'ОстатокДт', 'ОстатокКт', 'РазвернутыйОстатокДт', 'РазвернутыйОстатокКт'],
  Обороты: ['Оборот', 'ОборотДт', 'ОборотКт'],
  ОборотыДтКт: ['Оборот'],
  ОстаткиИОбороты: [
    'НачальныйОстаток', 'НачальныйОстатокДт', 'НачальныйОстатокКт',
    'НачальныйРазвернутыйОстатокДт', 'НачальныйРазвернутыйОстатокКт',
    'Оборот', 'ОборотДт', 'ОборотКт',
    'КонечныйОстаток', 'КонечныйОстатокДт', 'КонечныйОстатокКт',
    'КонечныйРазвернутыйОстатокДт', 'КонечныйРазвернутыйОстатокКт',
  ],
};

export function buildAccountingRegSlices(
  obj: ParsedObject,
  base: MetaTable,
  charts: Map<string, AccChartInfo>,
): MetaTable[] {
  if (obj.kind !== 'РегистрБухгалтерии') return [];
  const props = obj.properties as { correspondence?: boolean; chartOfAccounts?: string } | undefined;
  const corr = props?.correspondence === true;
  const chartName = props?.chartOfAccounts ?? '';
  const chart = charts.get(chartName);
  const n = chart?.maxExtDimensionCount ?? 0;
  const vidName = chart?.extDimensionTypes ?? '';

  const dims = base.fields.filter(f => f.kind === 'dimension').map(d => ({ ...d }));
  const resources = base.fields.filter(f => f.kind === 'resource');
  const attrs = base.fields.filter(f => f.kind === 'attribute').map(a => ({ ...a }));

  const acct = (name: string): MetaField =>
    ({ name, kind: 'standard', types: [{ ref: { kind: 'ПланСчетов', name: chartName } }] });
  const sub = (prefix: string, i: number): MetaField =>
    ({ name: `${prefix}${i}`, kind: 'standard', types: [{}] });
  const vidSub = (prefix: string, i: number): MetaField =>
    ({ name: `Вид${prefix}${i}`, kind: 'standard', types: [{ ref: { kind: 'ПланВидовХарактеристик', name: vidName } }] });
  const subs = (prefix: string): MetaField[] =>
    Array.from({ length: n }, (_, k) => sub(prefix, k + 1));
  const subsWithVid = (prefix: string): MetaField[] =>
    Array.from({ length: n }, (_, k) => [sub(prefix, k + 1), vidSub(prefix, k + 1)]).flat();
  const expand = (slice: string): MetaField[] =>
    resources.flatMap(r => RESOURCE_SUFFIXES[slice].map((s): MetaField =>
      ({ name: `${r.name}${s}`, kind: 'resource', types: r.types })));

  const makeVT = (slice: VirtualTableInfo['slice'], fields: MetaField[]): MetaTable => ({
    kind: 'РегистрБухгалтерии',
    name: `${obj.name}.${slice}`,
    fullName: `${obj.fullName}.${slice}`,
    fields,
    virtual: { slice, baseFullName: obj.fullName, correspondence: corr },
  });

  const dvStd: MetaField[] = [
    { name: 'Период', kind: 'standard', types: [{ primitive: 'Дата' }] },
    { name: 'Регистратор', kind: 'standard', types: [{}] },
    { name: 'НомерСтроки', kind: 'standard', types: [{ primitive: 'Число' }] },
    { name: 'Активность', kind: 'standard', types: [{ primitive: 'Булево' }] },
  ];
  const vidDvizh: MetaField = { name: 'ВидДвижения', kind: 'standard', types: [{}] };

  const result: MetaTable[] = [];

  result.push(makeVT('Остатки', [acct('Счет'), ...subs('Субконто'), ...dims, ...expand('Остатки')]));

  result.push(makeVT('Обороты', corr
    ? [acct('Счет'), ...subs('Субконто'), ...dims, acct('КорСчет'), ...subs('КорСубконто'), ...expand('Обороты')]
    : [acct('Счет'), ...subs('Субконто'), ...dims, ...expand('Обороты')]));

  if (corr) {
    result.push(makeVT('ОборотыДтКт',
      [acct('СчетДт'), ...subs('СубконтоДт'), acct('СчетКт'), ...subs('СубконтоКт'), ...dims, ...expand('ОборотыДтКт')]));
  }

  result.push(makeVT('ОстаткиИОбороты', [acct('Счет'), ...subs('Субконто'), ...dims, ...expand('ОстаткиИОбороты')]));

  const dvAccount = corr
    ? [acct('СчетДт'), ...subsWithVid('СубконтоДт'), acct('СчетКт'), ...subsWithVid('СубконтоКт')]
    : [acct('Счет'), ...subsWithVid('Субконто')];
  const dvFields = [...dvStd, ...dvAccount, ...dims, ...resources.map(r => ({ ...r })), ...attrs];
  if (!corr) dvFields.push(vidDvizh);
  result.push(makeVT('ДвиженияССубконто', dvFields));

  return result;
}
