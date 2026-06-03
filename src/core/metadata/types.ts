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

export interface VirtualTableInfo {
  slice: 'СрезПервых' | 'СрезПоследних';
  baseFullName: string;
}

export interface MetaTable {
  kind: TableKind;
  name: string;
  fullName: string;
  fields: MetaField[];
  tabularSections?: MetaTable[];
  virtual?: VirtualTableInfo;
}

export interface MetadataModel {
  version: 1;
  tables: MetaTable[];
}
