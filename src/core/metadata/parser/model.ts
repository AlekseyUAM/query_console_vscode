export type Primitive = 'Строка' | 'Число' | 'Дата' | 'Булево';
export type TypeKind = Primitive | 'ref' | 'unknown';

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
  category: 'standard' | 'attribute';
  types: ParsedType[];
}

export interface ParsedTabularSection {
  name: string;
  uuid: string;
  fields: ParsedField[];
}

export interface ParsedObject {
  version: 1;
  kind: 'Справочник' | 'Документ' | 'Константа' | 'Перечисление';
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
