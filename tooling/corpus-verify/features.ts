import type { BatchDocument } from '../../src/core/query/batchModel';
import type { QueryModel, JoinKind, QueryType, Join } from '../../src/core/query/queryModel';

export interface ActiveView {
  tableCount: number;
  queryType: QueryType;
}

export interface FeatureVector {
  isPackage: boolean;
  hasUnions: boolean;
  maxTables: number;
  hasJoins: boolean;
  joinKinds: JoinKind[];
  queryTypes: QueryType[];
  hasIndexing: boolean;
  hasGrouping: boolean;
  hasTotals: boolean;
  hasOrder: boolean;
  hasConditions: boolean;
  hasHaving: boolean;
  hasSubquery: boolean;
  hasVirtual: boolean;
  hasParams: boolean;
  hasBuilder: boolean;
  hasTabSections: boolean;
  hasExpressions: boolean;
  top: boolean;
  distinct: boolean;
  allowed: boolean;
  active: ActiveView;
}

function joinKind(j: Join): JoinKind {
  if (j.leftAll && j.rightAll) return 'full';
  if (j.leftAll || j.rightAll) return 'left'; // правое нормализуется к левому
  return 'inner';
}

function modelHasBuilder(m: QueryModel): boolean {
  const b = m.builder;
  return !!b && (b.fields.length + b.conditions.length + b.order.length + b.totals.length) > 0;
}

export function extractFeatures(batch: BatchDocument): FeatureVector {
  const models: QueryModel[] = [];
  let hasUnions = false;
  for (const doc of batch.members) {
    if (doc.members.length > 1) hasUnions = true;
    for (const um of doc.members) models.push(um.model);
  }
  const joinKinds = new Set<JoinKind>();
  const queryTypes = new Set<QueryType>();
  let maxTables = 0;
  const fv: FeatureVector = {
    isPackage: batch.members.length > 1,
    hasUnions,
    maxTables: 0,
    hasJoins: false,
    joinKinds: [],
    queryTypes: [],
    hasIndexing: false, hasGrouping: false, hasTotals: false, hasOrder: false,
    hasConditions: false, hasHaving: false, hasSubquery: false, hasVirtual: false,
    hasParams: false, hasBuilder: false, hasTabSections: false, hasExpressions: false,
    top: false, distinct: false, allowed: false,
    active: { tableCount: 0, queryType: 'select' },
  };
  for (const m of models) {
    maxTables = Math.max(maxTables, m.tables.length);
    queryTypes.add(m.queryType ?? 'select');
    for (const j of m.joins ?? []) { fv.hasJoins = true; joinKinds.add(joinKind(j)); }
    if ((m.indexing?.indexes.length ?? 0) > 0) fv.hasIndexing = true;
    if (m.grouping && (m.grouping.groupFields.length || m.grouping.aggregates.length || m.grouping.groupSets.length)) fv.hasGrouping = true;
    if (m.totals && (m.totals.groupFields.length || m.totals.totalFields.length)) fv.hasTotals = true;
    if (m.order && (m.order.fields.length || m.order.auto)) fv.hasOrder = true;
    if ((m.conditions?.length ?? 0) > 0) fv.hasConditions = true;
    if ((m.having?.length ?? 0) > 0) fv.hasHaving = true;
    if (m.conditions?.some(c => c.subquery) || m.tables.some(t => t.subquery)) fv.hasSubquery = true;
    if (m.tables.some(t => t.virtual)) fv.hasVirtual = true;
    if (m.conditions?.some(c => c.param)) fv.hasParams = true;
    if (modelHasBuilder(m)) fv.hasBuilder = true;
    if ((m.tabSectionFields?.length ?? 0) > 0) fv.hasTabSections = true;
    if (m.fields.some(f => f.expression)) fv.hasExpressions = true;
    if (m.selection?.top !== undefined) fv.top = true;
    if (m.selection?.distinct) fv.distinct = true;
    if (m.selection?.allowed) fv.allowed = true;
  }
  fv.maxTables = maxTables;
  fv.joinKinds = [...joinKinds].sort();
  fv.queryTypes = [...queryTypes].sort();
  const active = batch.members[0]?.members[0]?.model;
  fv.active = {
    tableCount: active?.tables.length ?? 0,
    queryType: active?.queryType ?? 'select',
  };
  return fv;
}

export function featureKey(fv: FeatureVector): string {
  return JSON.stringify({
    isPackage: fv.isPackage, hasUnions: fv.hasUnions,
    tables: fv.maxTables > 1 ? 'multi' : fv.maxTables, // схлопываем точное число >1
    hasJoins: fv.hasJoins, joinKinds: fv.joinKinds, queryTypes: fv.queryTypes,
    hasIndexing: fv.hasIndexing, hasGrouping: fv.hasGrouping, hasTotals: fv.hasTotals,
    hasOrder: fv.hasOrder, hasConditions: fv.hasConditions, hasHaving: fv.hasHaving,
    hasSubquery: fv.hasSubquery, hasVirtual: fv.hasVirtual, hasParams: fv.hasParams,
    hasBuilder: fv.hasBuilder, hasTabSections: fv.hasTabSections, hasExpressions: fv.hasExpressions,
    top: fv.top, distinct: fv.distinct, allowed: fv.allowed,
  });
}
