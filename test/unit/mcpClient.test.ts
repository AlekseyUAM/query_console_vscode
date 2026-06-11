import { describe, it, expect, vi } from 'vitest';
import { parseValidateResponse, normalizeQueryText } from '../../src/cli/mcpClient';

describe('normalizeQueryText', () => {
  it('снимает BOM, CRLF→LF и хвостовой перевод строки', () => {
    expect(normalizeQueryText('﻿А\r\nБ\n')).toBe('А\nБ');
  });
});

describe('parseValidateResponse', () => {
  it('достаёт valid/message/query_text из вложенного JSON content', () => {
    const raw = {
      jsonrpc: '2.0', id: 2,
      result: { content: [{ type: 'text', text: JSON.stringify({ valid: true, message: 'ок', query_text: 'ВЫБРАТЬ\n	Т.П' }) }], isError: false },
    };
    const r = parseValidateResponse(raw);
    expect(r.valid).toBe(true);
    expect(r.message).toBe('ок');
    expect(r.query_text).toBe('ВЫБРАТЬ\n\tТ.П');
  });

  it('бросает на isError', () => {
    expect(() => parseValidateResponse({ result: { content: [{ type: 'text', text: 'boom' }], isError: true } }))
      .toThrow();
  });
});
