import { describe, it, expect } from 'vitest';
import { TABS } from '../../src/webview/components/TabsBar';

describe('TABS', () => {
  it('uses plural «Индексы» (parity with real constructor), not «Индекс»', () => {
    expect(TABS).toContain('Индексы');
    expect(TABS).not.toContain('Индекс');
  });
});
