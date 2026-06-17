import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMetadataCached, modelCachePath, MODEL_CACHE_VERSION } from '../../src/core/metadata/modelCache';

const CONFIG_YAML = `version: 1
objects:
  - type: Справочник
    name: Валюты
    fullName: Справочник.Валюты
    file: Catalogs/Валюты.yaml
`;

const CURRENCY_YAML = `version: 1
kind: Справочник
name: Валюты
fullName: Справочник.Валюты
uuid: "00000000-0000-0000-0000-000000000001"
fields:
  - name: Код
    category: standard
    types:
      - kind: Строка
        length: 3
`;

let tmpDir: string;

function buildTmp(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelcache-'));
  const cfDir = path.join(tmpDir, 'cf');
  fs.mkdirSync(path.join(cfDir, 'Catalogs'), { recursive: true });
  fs.writeFileSync(path.join(cfDir, 'configuration.yaml'), CONFIG_YAML);
  fs.writeFileSync(path.join(cfDir, 'Catalogs', 'Валюты.yaml'), CURRENCY_YAML);
  return cfDir;
}

function tamperedCache(): string {
  return JSON.stringify({
    cacheVersion: MODEL_CACHE_VERSION,
    model: { version: 1, tables: [{ kind: 'Справочник', name: 'Marker', fullName: 'TAMPERED.Marker', fields: [] }] },
  });
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadMetadataCached', () => {
  it('builds on miss and writes the cache file', () => {
    const cfDir = buildTmp();
    const model = loadMetadataCached(cfDir);
    expect(model.tables.some(t => t.fullName === 'Справочник.Валюты')).toBe(true);
    expect(fs.existsSync(modelCachePath(cfDir))).toBe(true);
  });

  it('reads the cache on hit (does not re-parse YAML)', () => {
    const cfDir = buildTmp();
    loadMetadataCached(cfDir); // build
    const cachePath = modelCachePath(cfDir);
    fs.writeFileSync(cachePath, tamperedCache());
    const futureSec = Date.now() / 1000 + 3600;
    fs.utimesSync(cachePath, futureSec, futureSec);
    const model = loadMetadataCached(cfDir);
    expect(model.tables.some(t => t.fullName === 'TAMPERED.Marker')).toBe(true);
  });

  it('invalidates by mtime when a YAML file is newer than the cache', () => {
    const cfDir = buildTmp();
    loadMetadataCached(cfDir); // build cache
    const futureSec = Date.now() / 1000 + 3600;
    fs.utimesSync(path.join(cfDir, 'Catalogs', 'Валюты.yaml'), futureSec, futureSec);
    const model = loadMetadataCached(cfDir);
    expect(model.tables.some(t => t.fullName === 'Справочник.Валюты')).toBe(true);
    expect(model.tables.some(t => t.fullName === 'TAMPERED.Marker')).toBe(false);
    // cache was refreshed: reading it back gives the real model
    const onDisk = JSON.parse(fs.readFileSync(modelCachePath(cfDir), 'utf8'));
    expect(onDisk.model.tables.some((t: { fullName: string }) => t.fullName === 'Справочник.Валюты')).toBe(true);
  });

  it('invalidates by version mismatch', () => {
    const cfDir = buildTmp();
    const cachePath = modelCachePath(cfDir);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      cacheVersion: MODEL_CACHE_VERSION + 1,
      model: { version: 1, tables: [{ kind: 'Справочник', name: 'Marker', fullName: 'TAMPERED.Marker', fields: [] }] },
    }));
    const model = loadMetadataCached(cfDir);
    expect(model.tables.some(t => t.fullName === 'Справочник.Валюты')).toBe(true);
    expect(model.tables.some(t => t.fullName === 'TAMPERED.Marker')).toBe(false);
  });
});
