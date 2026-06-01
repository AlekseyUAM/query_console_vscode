import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildCachePath, writeCache } from '../../src/core/metadata/cacheBuilder';
import { isCacheValid, readCache } from '../../src/core/metadata/cacheLoader';
import type { MetadataModel } from '../../src/core/metadata/types';

const MODEL: MetadataModel = {
  version: 1,
  tables: [
    {
      kind: 'Справочник',
      name: 'Тест',
      fullName: 'Справочник.Тест',
      fields: [],
    },
  ],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildCachePath', () => {
  it('returns a path inside storageUri with .json extension', () => {
    const p = buildCachePath(tmpDir, '/some/path/src/cf');
    expect(p).toMatch(/\.json$/);
    expect(p.startsWith(tmpDir)).toBe(true);
  });

  it('produces different paths for different cfPaths', () => {
    const p1 = buildCachePath(tmpDir, '/project-a/src/cf');
    const p2 = buildCachePath(tmpDir, '/project-b/src/cf');
    expect(p1).not.toBe(p2);
  });
});

describe('writeCache + readCache round-trip', () => {
  it('persists and restores the model exactly', () => {
    const cachePath = buildCachePath(tmpDir, '/test/src/cf');
    writeCache(cachePath, MODEL);
    const restored = readCache(cachePath);
    expect(restored).toEqual(MODEL);
  });

  it('readCache returns null for missing file', () => {
    expect(readCache('/no/such/file.json')).toBeNull();
  });

  it('readCache returns null when version mismatches', () => {
    const cachePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(cachePath, JSON.stringify({ version: 99, tables: [] }));
    expect(readCache(cachePath)).toBeNull();
  });
});

describe('isCacheValid', () => {
  it('returns false when cache file does not exist', () => {
    const cfPath = tmpDir;
    expect(isCacheValid('/no/cache.json', cfPath)).toBe(false);
  });

  it('returns true when cache is newer than all cf files', () => {
    // Write a cf file, then write the cache (newer)
    const cfDir = path.join(tmpDir, 'cf');
    fs.mkdirSync(cfDir);
    const xmlFile = path.join(cfDir, 'test.xml');
    fs.writeFileSync(xmlFile, '<x/>');

    const cachePath = buildCachePath(tmpDir, cfDir);
    writeCache(cachePath, MODEL);

    // Touch cache mtime to be newer (1 second in future via utime)
    const futureMs = Date.now() + 2000;
    fs.utimesSync(cachePath, futureMs / 1000, futureMs / 1000);

    expect(isCacheValid(cachePath, cfDir)).toBe(true);
  });

  it('returns false when cf has a file newer than cache', () => {
    const cfDir = path.join(tmpDir, 'cf');
    fs.mkdirSync(cfDir);
    const cachePath = buildCachePath(tmpDir, cfDir);
    writeCache(cachePath, MODEL);

    // Write an xml file AFTER the cache
    const xmlFile = path.join(cfDir, 'new.xml');
    fs.writeFileSync(xmlFile, '<x/>');
    const futureMs = Date.now() + 2000;
    fs.utimesSync(xmlFile, futureMs / 1000, futureMs / 1000);

    expect(isCacheValid(cachePath, cfDir)).toBe(false);
  });
});
