import { DOMParser } from '@xmldom/xmldom';

/**
 * Парсит XML 1С в DOM. Срезает UTF-8 BOM (1С выгружает XML с BOM, иначе
 * @xmldom/xmldom падает с ParseError). Возвращает null при ошибке парсинга.
 */
export function parseXml(xml: string): any | null {
  try {
    const parser = new DOMParser({ onError: () => {} } as any);
    const doc = parser.parseFromString(xml.replace(/^﻿/, ''), 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    return doc;
  } catch {
    return null;
  }
}

export function firstElementChild(parent: any): any | null {
  const nodes = parent?.childNodes;
  if (!nodes) return null;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType === 1) return nodes[i];
  }
  return null;
}

export function childByLocalName(parent: any, localName: string): any | null {
  const nodes = parent?.childNodes;
  if (!nodes) return null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && n.localName === localName) return n;
  }
  return null;
}

export function childrenByLocalName(parent: any, localName: string): any[] {
  const result: any[] = [];
  const nodes = parent?.childNodes;
  if (!nodes) return result;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && n.localName === localName) result.push(n);
  }
  return result;
}

export function nodeText(el: any | null): string {
  return el?.textContent?.trim() ?? '';
}

export function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o)) {
    if ((o as Record<string, unknown>)[k] === undefined) delete (o as Record<string, unknown>)[k];
  }
  return o;
}
