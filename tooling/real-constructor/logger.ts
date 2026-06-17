import * as fs from 'fs';
import * as path from 'path';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  lines(): string[];
}

/** Простой логгер: дублирует строки в память и дописывает в файл (с созданием каталога). */
export function createLogger(file: string): Logger {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', 'utf8');
  const buf: string[] = [];
  const write = (level: string, msg: string): void => {
    const line = `[${level}] ${msg}`;
    buf.push(line);
    fs.appendFileSync(file, line + '\n', 'utf8');
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    lines: () => [...buf],
  };
}
