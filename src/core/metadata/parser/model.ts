export type Primitive = 'Строка' | 'Число' | 'Дата' | 'Булево';
export type TypeKind = Primitive | 'timestamp' | 'ref' | 'unknown';

export interface ParsedType {
  kind: TypeKind;
  length?: number;
  allowedLength?: string;
  digits?: number;
  fractionDigits?: number;
  allowedSign?: string;
  dateFractions?: string;
  ref?: string;
  raw?: string;
}

export interface ParsedField {
  name: string;
  category: 'standard' | 'attribute' | 'dimension' | 'resource';
  types: ParsedType[];
}

export interface ParsedTabularSection {
  name: string;
  uuid: string;
  fields: ParsedField[];
}

export interface ParsedObject {
  version: 1;
  kind:
    | 'Справочник' | 'Документ' | 'Константа' | 'Перечисление'
    | 'ПланОбмена' | 'ПланВидовХарактеристик' | 'ПланСчетов' | 'ПланВидовРасчета'
    | 'БизнесПроцесс' | 'Задача'
    | 'РегистрСведений' | 'РегистрНакопления' | 'РегистрБухгалтерии' | 'РегистрРасчета'
    | 'Последовательность' | 'ЖурналДокументов' | 'КритерийОтбора';
  name: string;
  fullName: string;
  uuid: string;
  source?: string;
  properties?: Record<string, unknown>;
  fields?: ParsedField[];
  tabularSections?: ParsedTabularSection[];
  values?: { name: string }[];
  types?: ParsedType[];
}
