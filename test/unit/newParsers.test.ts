import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { parseXml, firstElementChild } from '../../src/core/metadata/parser/dom';
import { parseChildObjects } from '../../src/core/metadata/parser/attribute';

const CF_DIR = path.join(__dirname, '..', '..', 'src', 'cf');

function readObjectEl(subdir: string, filename: string): any {
  const xml = fs.readFileSync(path.join(CF_DIR, subdir, filename), 'utf8');
  const doc = parseXml(xml)!;
  return firstElementChild(doc.documentElement);
}

describe('parseChildObjects — dimension/resource', () => {
  it('parses Dimension children with category dimension', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const { dimensions } = parseChildObjects(el);
    expect(dimensions.length).toBeGreaterThan(0);
    expect(dimensions.every(d => d.category === 'dimension')).toBe(true);
    expect(dimensions[0].name).toBeTruthy();
  });

  it('parses Resource children with category resource', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const { resources } = parseChildObjects(el);
    expect(resources.length).toBeGreaterThan(0);
    expect(resources[0].category).toBe('resource');
    expect(resources[0].name).toBe('Ресурс1');
  });

  it('returns empty dimensions and resources for objects without those children', () => {
    const el = readObjectEl('Enums', 'ВариантыВажностиВзаимодействия.xml');
    const result = parseChildObjects(el);
    expect(Array.isArray(result.dimensions)).toBe(true);
    expect(Array.isArray(result.resources)).toBe(true);
    expect(result.dimensions).toHaveLength(0);
    expect(result.resources).toHaveLength(0);
  });
});
