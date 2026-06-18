import { featureKey, type FeatureVector } from './features';

export interface CorpusEntry { name: string; fv: FeatureVector }
export interface ClassInfo { key: string; members: string[] }

export function classifyCorpus(entries: CorpusEntry[]): ClassInfo[] {
  const map = new Map<string, string[]>();
  for (const e of entries) {
    const k = featureKey(e.fv);
    (map.get(k) ?? map.set(k, []).get(k)!).push(e.name);
  }
  const classes: ClassInfo[] = [...map.entries()].map(([key, members]) => ({
    key, members: [...members].sort(),
  }));
  classes.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
  return classes;
}

export function sampleRepresentatives(classes: ClassInfo[], perClass: number): string[] {
  const picked: string[] = [];
  for (const c of classes) picked.push(...c.members.slice(0, perClass));
  return picked.sort();
}
