import * as fs from 'fs';
import * as path from 'path';
import { parseXml, firstElementChild, childByLocalName, nodeText, clean } from './dom';
import { writeYaml } from './yamlWriter';
import { parseCatalog } from './catalog';
import { parseDocument } from './document';
import { parseConstant } from './constant';
import { parseEnum } from './enum';
import { parseExchangePlan } from './exchangePlan';
import { parseChartOfCharacteristicTypes } from './chartOfCharacteristicTypes';
import { parseChartOfAccounts } from './chartOfAccounts';
import { parseChartOfCalculationTypes } from './chartOfCalculationTypes';
import { parseBusinessProcess } from './businessProcess';
import { parseTask } from './task';
import { parseInformationRegister } from './informationRegister';
import { parseAccumulationRegister } from './accumulationRegister';
import { parseAccountingRegister } from './accountingRegister';
import { parseCalculationRegister } from './calculationRegister';
import { parseSequence } from './sequence';
import { parseDocumentJournal } from './documentJournal';
import { parseFilterCriteria } from './filterCriteria';
import { parseCommonAttribute } from './commonAttribute';
import type { ParsedObject, ParsedCommonAttribute } from './model';

interface TypeHandler {
  subdir: string;
  parse: (el: any) => ParsedObject | null;
}

const HANDLERS: TypeHandler[] = [
  { subdir: 'Catalogs',                    parse: parseCatalog },
  { subdir: 'Documents',                   parse: parseDocument },
  { subdir: 'Constants',                   parse: parseConstant },
  { subdir: 'Enums',                       parse: parseEnum },
  { subdir: 'ExchangePlans',               parse: parseExchangePlan },
  { subdir: 'ChartsOfCharacteristicTypes', parse: parseChartOfCharacteristicTypes },
  { subdir: 'ChartsOfAccounts',            parse: parseChartOfAccounts },
  { subdir: 'ChartsOfCalculationTypes',    parse: parseChartOfCalculationTypes },
  { subdir: 'BusinessProcesses',           parse: parseBusinessProcess },
  { subdir: 'Tasks',                       parse: parseTask },
  { subdir: 'InformationRegisters',        parse: parseInformationRegister },
  { subdir: 'AccumulationRegisters',       parse: parseAccumulationRegister },
  { subdir: 'AccountingRegisters',         parse: parseAccountingRegister },
  { subdir: 'CalculationRegisters',        parse: parseCalculationRegister },
  { subdir: 'Sequences',                   parse: parseSequence },
  { subdir: 'DocumentJournals',            parse: parseDocumentJournal },
  { subdir: 'FilterCriteria',              parse: parseFilterCriteria },
];

export interface ParseSummary {
  counts: Record<string, number>;
  skipped: number;
  outCfDir: string;
}

interface IndexEntry {
  type: string;
  name: string;
  fullName: string;
  file: string;
}

export function parseConfiguration(cfPath: string, outPath: string): ParseSummary {
  const outCfDir = path.join(outPath, 'cf');
  fs.rmSync(outCfDir, { recursive: true, force: true });
  fs.mkdirSync(outCfDir, { recursive: true });

  const counts: Record<string, number> = {};
  let skipped = 0;
  const objects: IndexEntry[] = [];

  for (const h of HANDLERS) {
    const dir = path.join(cfPath, h.subdir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.xml')) continue;
      let obj: ParsedObject | null = null;
      try {
        const xml = fs.readFileSync(path.join(dir, file), 'utf8');
        const doc = parseXml(xml);
        const objectEl = doc ? firstElementChild(doc.documentElement) : null;
        obj = objectEl ? h.parse(objectEl) : null;
      } catch {
        obj = null;
      }
      if (!obj) {
        skipped++;
        continue;
      }
      obj.source = `${h.subdir}/${file}`;
      writeYaml(path.join(outCfDir, h.subdir, `${obj.name}.yaml`), obj);
      counts[obj.kind] = (counts[obj.kind] || 0) + 1;
      objects.push({
        type: obj.kind,
        name: obj.name,
        fullName: obj.fullName,
        file: `${h.subdir}/${obj.name}.yaml`,
      });
    }
  }

  const commonAttributes = parseCommonAttributes(cfPath);

  writeConfigurationIndex(cfPath, outCfDir, objects, commonAttributes);
  return { counts, skipped, outCfDir };
}

function parseCommonAttributes(cfPath: string): ParsedCommonAttribute[] {
  const dir = path.join(cfPath, 'CommonAttributes');
  if (!fs.existsSync(dir)) return [];
  const result: ParsedCommonAttribute[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.xml')) continue;
    try {
      const xml = fs.readFileSync(path.join(dir, file), 'utf8');
      const doc = parseXml(xml);
      const el = doc ? firstElementChild(doc.documentElement) : null;
      const ca = el ? parseCommonAttribute(el) : null;
      if (ca) result.push(ca);
    } catch { /* пропустить нечитаемый общий реквизит */ }
  }
  return result;
}

function writeConfigurationIndex(
  cfPath: string,
  outCfDir: string,
  objects: IndexEntry[],
  commonAttributes: ParsedCommonAttribute[],
): void {
  let name = '';
  let synonym: string | undefined;
  const confXml = path.join(cfPath, 'Configuration.xml');
  if (fs.existsSync(confXml)) {
    const doc = parseXml(fs.readFileSync(confXml, 'utf8'));
    const el = doc ? firstElementChild(doc.documentElement) : null;
    const props = el ? childByLocalName(el, 'Properties') : null;
    if (props) {
      name = nodeText(childByLocalName(props, 'Name'));
      const syn = childByLocalName(props, 'Synonym');
      const item = syn ? childByLocalName(syn, 'item') : null;
      synonym = item ? nodeText(childByLocalName(item, 'content')) || undefined : undefined;
    }
  }
  writeYaml(
    path.join(outCfDir, 'configuration.yaml'),
    clean({ version: 1, name, synonym, objects, commonAttributes: commonAttributes.length ? commonAttributes : undefined }),
  );
}
