/**
 * Тонкий MCP-over-HTTP клиент для инструмента 1c-md validate_query.
 * Только разработка/тесты — в бандл расширения не входит.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ValidateQueryResult {
  valid: boolean;
  message: string;
  query_text: string;
}

/** Снять BOM, CRLF→LF, хвостовой перевод строки — симметрично sdblGolden.ref(). */
export function normalizeQueryText(s: string): string {
  return s.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

/** Прочитать URL сервера 1c-md из .mcp.json. */
export function readMcpUrl(root = process.cwd()): string {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  const url = cfg?.mcpServers?.['1c-md']?.url;
  if (typeof url !== 'string') throw new Error('Не найден mcpServers.1c-md.url в .mcp.json');
  return url;
}

/** Разобрать JSON-RPC ответ tools/call в ValidateQueryResult. */
export function parseValidateResponse(raw: any): ValidateQueryResult {
  const result = raw?.result;
  if (!result || result.isError) {
    const text = result?.content?.[0]?.text ?? JSON.stringify(raw);
    throw new Error(`MCP вернул ошибку: ${text}`);
  }
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('Пустой content в ответе MCP');
  const inner = JSON.parse(text);
  return {
    valid: Boolean(inner.valid),
    message: String(inner.message ?? ''),
    query_text: normalizeQueryText(String(inner.query_text ?? '')),
  };
}

let nextId = 1;

/** Вызвать validate_query через MCP HTTP. */
export async function validateQuery(text: string, url = readMcpUrl()): Promise<ValidateQueryResult> {
  const body = {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: { name: 'validate_query', arguments: { queryText: text } },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} от MCP`);
  const raw = await resp.json();
  return parseValidateResponse(raw);
}
