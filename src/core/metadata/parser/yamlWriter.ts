import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'yaml';

export function writeYaml(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringify(data, { lineWidth: 0 }));
}
