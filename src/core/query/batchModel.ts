import type { QueryDocument } from './unionModel';

/** Документ пакета запросов: последовательность запросов-участников пакета. */
export interface BatchDocument {
  members: QueryDocument[];
}
