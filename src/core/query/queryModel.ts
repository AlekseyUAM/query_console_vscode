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

export interface SelectedTabSectionField {
  tableId: string;
  tsName: string;
  tsFullName: string;
  fields: string[];
}

export interface QueryModel {
  tables: SelectedTable[];
  fields: SelectedField[];
  tabSectionFields?: SelectedTabSectionField[];
}
