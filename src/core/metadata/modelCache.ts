import * as fs from 'fs';
import * as path from 'path';
import type { MetadataModel } from './types';
import { loadMetadataFromYaml } from './yamlLoader';

export const MODEL_CACHE_VERSION = 1;

export function modelCachePath(cfYamlDir: string): string {
  return path.join(path.dirname(cfYamlDir), 'model-cache.json');
}

/** Recursive scan returning the newest mtimeMs under dirPath; 0 if inaccessible. */
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

interface CacheFile {
  cacheVersion: number;
  model: MetadataModel;
}

/** Best-effort write of the model cache file in the canonical CacheFile shape. */
function writeModelCache(cachePath: string, model: MetadataModel): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ cacheVersion: MODEL_CACHE_VERSION, model } satisfies CacheFile));
  } catch {
    // best-effort: ignore write failures
  }
}

/**
 * Loads the consolidated metadata model, using a single-JSON cache file when fresh.
 *
 * Cache is "fresh" when: it exists, parses, has the current cacheVersion, and its
 * own mtime is >= the newest mtime of any YAML file under cfYamlDir. On a miss the
 * model is rebuilt from YAML and the cache is best-effort rewritten.
 */
export function loadMetadataCached(cfYamlDir: string): MetadataModel {
  const cachePath = modelCachePath(cfYamlDir);

  try {
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CacheFile;
      if (parsed.cacheVersion === MODEL_CACHE_VERSION) {
        const cacheMtime = fs.statSync(cachePath).mtimeMs;
        if (cacheMtime >= newestMtime(cfYamlDir)) {
          return parsed.model;
        }
      }
    }
  } catch {
    // missing/corrupt/unreadable cache — fall through to rebuild
  }

  const model = loadMetadataFromYaml(cfYamlDir);
  writeModelCache(cachePath, model);
  return model;
}

/**
 * Unconditionally rebuilds the consolidated metadata model from YAML and writes it
 * to the JSON cache file (same shape/version as {@link loadMetadataCached}).
 *
 * Called right after the user clicks «Обновить кэш»: the host re-parses the
 * configuration, which rewrites the YAML files with newer mtimes and would
 * otherwise invalidate `model-cache.json`. By eagerly rebuilding here we keep the
 * JSON model cache warm, so the next open is a fast cache HIT instead of a cold
 * (~13s) rebuild. The write is best-effort; the freshly built model is returned
 * even if the cache write fails.
 */
export function rebuildModelCache(cfYamlDir: string): MetadataModel {
  const model = loadMetadataFromYaml(cfYamlDir);
  writeModelCache(modelCachePath(cfYamlDir), model);
  return model;
}
