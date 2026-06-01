export interface SelectedTable {
  id: string;
  fullName: string;
  alias?: string;
}

export interface SelectedField {
  tableId: string;
  path: string;
  alias?: string;
}

export interface QueryModel {
  tables: SelectedTable[];
  fields: SelectedField[];
}
