import { describe, it, expect } from 'vitest';
import { screenshotName } from '../../tooling/real-constructor/screenshot';

describe('screenshotName', () => {
  it('дополняет индекс ведущим нулём', () => {
    expect(screenshotName(1, 'Таблицы и поля')).toBe('01-таблицы-и-поля.png');
  });

  it('двузначный индекс не трогает', () => {
    expect(screenshotName(12, 'Итоги')).toBe('12-итоги.png');
  });

  it('схлопывает спецсимволы в дефисы и обрезает края', () => {
    expect(screenshotName(3, '  Объединения / Псевдонимы!  ')).toBe('03-объединения-псевдонимы.png');
  });

  it('пустая подпись → screen', () => {
    expect(screenshotName(0, '   ')).toBe('00-screen.png');
  });
});
