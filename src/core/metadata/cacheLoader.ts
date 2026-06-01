import * as fs from 'fs';
import * as path from 'path';
import type { MetadataModel } from './types';

export function readCache(cachePath: string): MetadataModel | null {
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (data.version === 1) return data as MetadataModel;
  } catch {
    // missing file or invalid JSON
  }
  return null;
}

function newestMtime(dirPath: string): number {
  let max = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        max = Math.max(max, newestMtime(full));
      } else {
        max = Math.max(max, fs.statSync(full).mtimeMs);
      }
    }
  } catch {
    // inaccessible directory — treat as 0
  }
  return max;
}

export function isCacheValid(cachePath: string, cfPath: string): boolean {
  if (!fs.existsSync(cachePath)) return false;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw);
    if (data.version !== 1) return false;
    const cacheMtime = fs.statSync(cachePath).mtimeMs;
    const cfMtime = newestMtime(cfPath);
    return cfMtime <= cacheMtime;
  } catch {
    return false;
  }
}
