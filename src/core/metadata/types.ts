export type FieldKind = 'standard' | 'attribute';

export type TableKind = 'Справочник' | 'Документ';

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
}

export interface MetadataModel {
  version: 1;
  tables: MetaTable[];
}
