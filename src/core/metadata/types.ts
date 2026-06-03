export type FieldKind = 'standard' | 'attribute' | 'dimension' | 'resource';

export type TableKind =
  | 'Справочник' | 'Документ' | 'ТабличнаяЧасть'
  | 'Константа' | 'Перечисление'
  | 'ПланОбмена' | 'ПланВидовХарактеристик' | 'ПланСчетов' | 'ПланВидовРасчета'
  | 'БизнесПроцесс' | 'Задача'
  | 'РегистрСведений' | 'РегистрНакопления' | 'РегистрБухгалтерии' | 'РегистрРасчета'
  | 'Последовательность' | 'ЖурналДокументов' | 'КритерийОтбора';

export interface MetaType {
  primitive?: 'Строка' | 'Число' | 'Булево' | 'Дата';
  ref?: { kind: TableKind; name: string };
}

export interface MetaField {
  name: string;
  kind: FieldKind;
  types: MetaType[];
}

export interface MetaTable {
  kind: TableKind;
  name: string;
  fullName: string;
  fields: MetaField[];
  tabularSections?: MetaTable[];
}

export interface MetadataModel {
  version: 1;
  tables: MetaTable[];
}
