import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../../tooling/real-constructor/logger';

describe('createLogger', () => {
  it('пишет строки в память и в файл', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-log-')), 'r.log');
    const log = createLogger(file);
    log.info('старт');
    log.warn('окно не найдено');
    expect(log.lines()).toEqual(['[INFO] старт', '[WARN] окно не найдено']);
    expect(fs.readFileSync(file, 'utf8')).toBe('[INFO] старт\n[WARN] окно не найдено\n');
  });
});
