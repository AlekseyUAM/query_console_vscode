import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { MetadataModel } from './types';

export function buildCachePath(storageUri: string, cfPath: string): string {
  const hash = crypto.createHash('sha1').update(cfPath).digest('hex');
  return path.join(storageUri, `metadata-${hash}.json`);
}

export function writeCache(cachePath: string, model: MetadataModel): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(model));
}
