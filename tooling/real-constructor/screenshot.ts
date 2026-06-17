import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';

/** Безопасное имя файла из произвольной подписи вкладки/окна; кириллица сохраняется. */
export function screenshotName(index: number, label: string): string {
  const nn = String(index).padStart(2, '0');
  const slug =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'screen';
  return `${nn}-${slug}.png`;
}

/** Сохранить скриншот страницы в каталог под предсказуемым именем. Возвращает путь. */
export async function saveScreenshot(
  page: Page,
  dir: string,
  index: number,
  label: string,
): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, screenshotName(index, label));
  await page.screenshot({ path: file, fullPage: false });
  return file;
}
