import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRealConstructorConfig } from '../../tooling/real-constructor/config';

function tmpRoot(envContent: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cfg-'));
  fs.writeFileSync(path.join(dir, '.env'), envContent, 'utf8');
  return dir;
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('getRealConstructorConfig', () => {
  it('берёт значения из .env', () => {
    const root = tmpRoot('WEB_1C_URL=http://host.docker.internal/smallb/ru_RU/\nUSER_1C=Администратор\nPASSWORD_1C=\n');
    const cfg = getRealConstructorConfig(root);
    expect(cfg.webUrl).toBe('http://host.docker.internal/smallb/ru_RU/');
    expect(cfg.user).toBe('Администратор');
    expect(cfg.password).toBe('');
  });

  it('добавляет завершающий слэш к webUrl', () => {
    const root = tmpRoot('WEB_1C_URL=http://host.docker.internal/smallb/ru_RU\n');
    expect(getRealConstructorConfig(root).webUrl).toBe('http://host.docker.internal/smallb/ru_RU/');
  });

  it('дефолт webUrl, если .env отсутствует', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cfg-empty-'));
    expect(getRealConstructorConfig(dir).webUrl).toBe('http://host.docker.internal/smallb/ru_RU/');
  });

  it('process.env перекрывает .env', () => {
    const root = tmpRoot('USER_1C=ИзФайла\n');
    process.env.USER_1C = 'ИзОкружения';
    expect(getRealConstructorConfig(root).user).toBe('ИзОкружения');
  });
});
