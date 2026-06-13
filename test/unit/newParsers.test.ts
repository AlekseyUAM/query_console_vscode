import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { parseXml, firstElementChild } from '../../src/core/metadata/parser/dom';
import { parseChildObjects } from '../../src/core/metadata/parser/attribute';
import { parseExchangePlan } from '../../src/core/metadata/parser/exchangePlan';
import { parseChartOfCharacteristicTypes } from '../../src/core/metadata/parser/chartOfCharacteristicTypes';
import { parseChartOfAccounts } from '../../src/core/metadata/parser/chartOfAccounts';
import { parseChartOfCalculationTypes } from '../../src/core/metadata/parser/chartOfCalculationTypes';
import { parseBusinessProcess } from '../../src/core/metadata/parser/businessProcess';
import { parseTask } from '../../src/core/metadata/parser/task';
import { parseInformationRegister } from '../../src/core/metadata/parser/informationRegister';
import { parseAccumulationRegister } from '../../src/core/metadata/parser/accumulationRegister';
import { parseAccountingRegister } from '../../src/core/metadata/parser/accountingRegister';
import { parseCalculationRegister } from '../../src/core/metadata/parser/calculationRegister';
import { parseSequence } from '../../src/core/metadata/parser/sequence';
import { parseDocumentJournal } from '../../src/core/metadata/parser/documentJournal';
import { parseFilterCriteria } from '../../src/core/metadata/parser/filterCriteria';

// Закоммиченные XML-фикстуры (подмножество реальной выгрузки), чтобы тесты не
// зависели от gitignored src/cf — см. test/fixtures/cf-objects.
const CF_DIR = path.join(__dirname, '..', 'fixtures', 'cf-objects');

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

describe('parseExchangePlan', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('ExchangePlans', 'ОбновлениеИнформационнойБазы.xml');
    const result = parseExchangePlan(el);
    expect(result?.name).toBe('ОбновлениеИнформационнойБазы');
    expect(result?.fullName).toBe('ПланОбмена.ОбновлениеИнформационнойБазы');
    expect(result?.kind).toBe('ПланОбмена');
  });

  it('includes always-present standard fields', () => {
    const el = readObjectEl('ExchangePlans', 'ОбновлениеИнформационнойБазы.xml');
    const result = parseExchangePlan(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('Ссылка');
    expect(stdNames).toContain('ЭтотУзел');
    expect(stdNames).toContain('НомерПринятого');
    expect(stdNames).toContain('НомерОтправленного');
  });

  it('includes Код and Наименование when lengths > 0', () => {
    const el = readObjectEl('ExchangePlans', 'ОбновлениеИнформационнойБазы.xml');
    const result = parseExchangePlan(el)!;
    const names = result.fields.map(f => f.name);
    expect(names).toContain('Код');
    expect(names).toContain('Наименование');
  });

  it('parses attribute fields', () => {
    const el = readObjectEl('ExchangePlans', 'ОбновлениеИнформационнойБазы.xml');
    const result = parseExchangePlan(el)!;
    const attrNames = result.fields.filter(f => f.category === 'attribute').map(f => f.name);
    expect(attrNames).toContain('Очередь');
  });
});

describe('parseChartOfCharacteristicTypes', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('ChartsOfCharacteristicTypes', 'ДополнительныеРеквизитыИСведения.xml');
    const result = parseChartOfCharacteristicTypes(el);
    expect(result?.name).toBe('ДополнительныеРеквизитыИСведения');
    expect(result?.fullName).toBe('ПланВидовХарактеристик.ДополнительныеРеквизитыИСведения');
    expect(result?.kind).toBe('ПланВидовХарактеристик');
  });

  it('includes ТипЗначения standard field and Ссылка', () => {
    const el = readObjectEl('ChartsOfCharacteristicTypes', 'ДополнительныеРеквизитыИСведения.xml');
    const result = parseChartOfCharacteristicTypes(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('ТипЗначения');
    expect(stdNames).toContain('Ссылка');
  });

  it('omits Код when CodeLength=0 and includes Наименование when DescriptionLength>0', () => {
    const el = readObjectEl('ChartsOfCharacteristicTypes', 'ДополнительныеРеквизитыИСведения.xml');
    const result = parseChartOfCharacteristicTypes(el)!;
    const names = result.fields.map(f => f.name);
    expect(names).not.toContain('Код');
    expect(names).toContain('Наименование');
  });

  it('omits ЭтоГруппа/Родитель when not hierarchical', () => {
    const el = readObjectEl('ChartsOfCharacteristicTypes', 'ДополнительныеРеквизитыИСведения.xml');
    const result = parseChartOfCharacteristicTypes(el)!;
    const names = result.fields.map(f => f.name);
    expect(names).not.toContain('ЭтоГруппа');
    expect(names).not.toContain('Родитель');
  });
});

describe('parseChartOfAccounts', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('ChartsOfAccounts', 'ПланСчетов1.xml');
    const result = parseChartOfAccounts(el);
    expect(result?.name).toBe('ПланСчетов1');
    expect(result?.fullName).toBe('ПланСчетов.ПланСчетов1');
    expect(result?.kind).toBe('ПланСчетов');
  });

  it('includes Вид and Забалансовый standard fields', () => {
    const el = readObjectEl('ChartsOfAccounts', 'ПланСчетов1.xml');
    const result = parseChartOfAccounts(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('Вид');
    expect(stdNames).toContain('Забалансовый');
    expect(stdNames).toContain('Ссылка');
  });
});

describe('parseChartOfCalculationTypes', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('ChartsOfCalculationTypes', 'ПланВидовРасчета1.xml');
    const result = parseChartOfCalculationTypes(el);
    expect(result?.name).toBe('ПланВидовРасчета1');
    expect(result?.fullName).toBe('ПланВидовРасчета.ПланВидовРасчета1');
    expect(result?.kind).toBe('ПланВидовРасчета');
  });

  it('includes Ссылка standard field and attribute fields', () => {
    const el = readObjectEl('ChartsOfCalculationTypes', 'ПланВидовРасчета1.xml');
    const result = parseChartOfCalculationTypes(el)!;
    expect(result.fields.map(f => f.name)).toContain('Ссылка');
    expect(result.fields.filter(f => f.category === 'attribute').map(f => f.name)).toContain('Реквизит1');
  });

  it('parses tabular sections', () => {
    const el = readObjectEl('ChartsOfCalculationTypes', 'ПланВидовРасчета1.xml');
    const result = parseChartOfCalculationTypes(el)!;
    expect(result.tabularSections).toBeDefined();
    expect(result.tabularSections!.length).toBeGreaterThan(0);
    expect(result.tabularSections![0].name).toBe('ТабличнаяЧасть1');
  });
});

describe('parseBusinessProcess', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('BusinessProcesses', 'Задание.xml');
    const result = parseBusinessProcess(el);
    expect(result?.name).toBe('Задание');
    expect(result?.fullName).toBe('БизнесПроцесс.Задание');
    expect(result?.kind).toBe('БизнесПроцесс');
  });

  it('includes always-present standard fields', () => {
    const el = readObjectEl('BusinessProcesses', 'Задание.xml');
    const result = parseBusinessProcess(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('Ссылка');
    expect(stdNames).toContain('Дата');
    expect(stdNames).toContain('Стартован');
    expect(stdNames).toContain('Завершен');
    expect(stdNames).toContain('ВедущаяЗадача');
  });

  it('includes Номер when NumberLength > 0', () => {
    const el = readObjectEl('BusinessProcesses', 'Задание.xml');
    const result = parseBusinessProcess(el)!;
    expect(result.fields.map(f => f.name)).toContain('Номер');
  });
});

describe('parseTask', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('Tasks', 'ЗадачаИсполнителя.xml');
    const result = parseTask(el);
    expect(result?.name).toBe('ЗадачаИсполнителя');
    expect(result?.fullName).toBe('Задача.ЗадачаИсполнителя');
    expect(result?.kind).toBe('Задача');
  });

  it('includes standard fields including Выполнена, ТочкаМаршрута, БизнесПроцесс', () => {
    const el = readObjectEl('Tasks', 'ЗадачаИсполнителя.xml');
    const result = parseTask(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('Ссылка');
    expect(stdNames).toContain('Выполнена');
    expect(stdNames).toContain('ТочкаМаршрута');
    expect(stdNames).toContain('БизнесПроцесс');
    expect(stdNames).toContain('Номер');
    expect(stdNames).toContain('Наименование');
  });
});

const SYNTHETIC_INFOREG_PERIODICAL_RECORDER = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <InformationRegister uuid="test-ir-1">
    <Properties>
      <Name>ТестРегистр</Name>
      <InformationRegisterPeriodicity>Year</InformationRegisterPeriodicity>
      <WriteMode>RecorderSubordinate</WriteMode>
    </Properties>
    <ChildObjects>
      <Dimension uuid="dim-1">
        <Properties>
          <Name>Измерение1</Name>
          <Type><v8:Type xmlns:v8="http://v8.1c.ru/8.1/data/core">xs:string</v8:Type></Type>
        </Properties>
      </Dimension>
      <Resource uuid="res-1">
        <Properties>
          <Name>Ресурс1</Name>
          <Type><v8:Type xmlns:v8="http://v8.1c.ru/8.1/data/core">xs:decimal</v8:Type></Type>
        </Properties>
      </Resource>
    </ChildObjects>
  </InformationRegister>
</MetaDataObject>`;

describe('parseInformationRegister', () => {
  it('parses name, fullName, kind from real XML', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el);
    expect(result?.name).toBe('АдминистративнаяИерархия');
    expect(result?.fullName).toBe('РегистрСведений.АдминистративнаяИерархия');
    expect(result?.kind).toBe('РегистрСведений');
  });

  it('omits Период when Nonperiodical', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el)!;
    expect(result.fields.map(f => f.name)).not.toContain('Период');
  });

  it('omits Регистратор when Independent', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el)!;
    expect(result.fields.map(f => f.name)).not.toContain('Регистратор');
  });

  it('includes Период when periodicity is not Nonperiodical', () => {
    const el = readObjectEl('InformationRegisters', 'АрхивСообщенийОбменов.xml');
    const result = parseInformationRegister(el)!;
    expect(result.fields.map(f => f.name)).toContain('Период');
  });

  it('includes Регистратор when WriteMode is not Independent', () => {
    const doc = parseXml(SYNTHETIC_INFOREG_PERIODICAL_RECORDER)!;
    const el = firstElementChild(doc.documentElement);
    const result = parseInformationRegister(el)!;
    expect(result.fields.map(f => f.name)).toContain('Регистратор');
  });

  it('includes dimension fields from ChildObjects', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el)!;
    const dims = result.fields.filter(f => f.category === 'dimension');
    expect(dims.length).toBeGreaterThan(0);
  });

  it('synthetic register has dimension and resource fields', () => {
    const doc = parseXml(SYNTHETIC_INFOREG_PERIODICAL_RECORDER)!;
    const el = firstElementChild(doc.documentElement);
    const result = parseInformationRegister(el)!;
    const dim = result.fields.find(f => f.name === 'Измерение1');
    const res = result.fields.find(f => f.name === 'Ресурс1');
    expect(dim?.category).toBe('dimension');
    expect(res?.category).toBe('resource');
  });
});

describe('parseAccumulationRegister', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el);
    expect(result?.name).toBe('РегистрНакопленияОбор');
    expect(result?.fullName).toBe('РегистрНакопления.РегистрНакопленияОбор');
    expect(result?.kind).toBe('РегистрНакопления');
  });

  it('standard fields of a turnovers register: Период, Регистратор, НомерСтроки, Активность (no ВидДвижения)', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    // Порядок как в конструкторе 1С; ВидДвижения только у регистра вида Остатки (Balance).
    expect(stdNames).toEqual(['Период', 'Регистратор', 'НомерСтроки', 'Активность']);
    expect(stdNames).not.toContain('ВидДвижения');
  });

  it('balance register includes ВидДвижения after Активность', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОст.xml');
    const result = parseAccumulationRegister(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toEqual(['Период', 'Регистратор', 'НомерСтроки', 'Активность', 'ВидДвижения']);
  });

  it('includes dimension and resource fields', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el)!;
    const dim = result.fields.find(f => f.name === 'Измерение1');
    const res = result.fields.find(f => f.name === 'Ресурс1');
    expect(dim?.category).toBe('dimension');
    expect(res?.category).toBe('resource');
  });

  it('has no tabularSections', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el)!;
    expect(result.tabularSections).toBeUndefined();
  });
});

describe('parseAccountingRegister', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const result = parseAccountingRegister(el);
    expect(result?.name).toBe('РегистрБухгалтерии1');
    expect(result?.fullName).toBe('РегистрБухгалтерии.РегистрБухгалтерии1');
    expect(result?.kind).toBe('РегистрБухгалтерии');
  });

  it('includes НомерСтроки, Период, Регистратор, Активность standard fields', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const result = parseAccountingRegister(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('НомерСтроки');
    expect(stdNames).toContain('Период');
    expect(stdNames).toContain('Регистратор');
    expect(stdNames).toContain('Активность');
  });

  it('includes dimension, resource, and attribute fields', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const result = parseAccountingRegister(el)!;
    const dim = result.fields.find(f => f.name === 'Организация');
    const res = result.fields.find(f => f.name === 'Сумма');
    const attr = result.fields.find(f => f.name === 'Реквизит1');
    expect(dim?.category).toBe('dimension');
    expect(res?.category).toBe('resource');
    expect(attr?.category).toBe('attribute');
  });

  it('reads Correspondence and ChartOfAccounts name into properties', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const r = parseAccountingRegister(el)!;
    expect((r.properties as any).correspondence).toBe(true);
    expect((r.properties as any).chartOfAccounts).toBe('ПланСчетов1');
  });

  it('base table of a correspondence register has СчетДт/СчетКт, no ВидДвижения', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const names = parseAccountingRegister(el)!.fields.map(f => f.name);
    expect(names.slice(0, 6)).toEqual(['Период', 'Регистратор', 'НомерСтроки', 'Активность', 'СчетДт', 'СчетКт']);
    expect(names).not.toContain('ВидДвижения');
    expect(names).not.toContain('Счет');
  });

  it('base table of a non-correspondence register has ВидДвижения + Счет', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии2.xml');
    const r = parseAccountingRegister(el)!;
    expect((r.properties as any).correspondence).toBe(false);
    const names = r.fields.map(f => f.name);
    expect(names.slice(0, 6)).toEqual(['Период', 'Регистратор', 'НомерСтроки', 'Активность', 'ВидДвижения', 'Счет']);
  });
});

describe('parseCalculationRegister', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('CalculationRegisters', 'РегистрРасчета1.xml');
    const result = parseCalculationRegister(el);
    expect(result?.name).toBe('РегистрРасчета1');
    expect(result?.fullName).toBe('РегистрРасчета.РегистрРасчета1');
    expect(result?.kind).toBe('РегистрРасчета');
  });

  it('includes НомерСтроки, Период, Регистратор, ВидРасчета standard fields', () => {
    const el = readObjectEl('CalculationRegisters', 'РегистрРасчета1.xml');
    const result = parseCalculationRegister(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('НомерСтроки');
    expect(stdNames).toContain('Период');
    expect(stdNames).toContain('Регистратор');
    expect(stdNames).toContain('ВидРасчета');
  });
});

describe('parseSequence', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('Sequences', 'ПоследовательностьТест.xml');
    const result = parseSequence(el);
    expect(result?.name).toBe('ПоследовательностьТест');
    expect(result?.fullName).toBe('Последовательность.ПоследовательностьТест');
    expect(result?.kind).toBe('Последовательность');
  });

  it('includes НомерСтроки, Период, Регистратор standard fields', () => {
    const el = readObjectEl('Sequences', 'ПоследовательностьТест.xml');
    const result = parseSequence(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('НомерСтроки');
    expect(stdNames).toContain('Период');
    expect(stdNames).toContain('Регистратор');
  });

  it('includes dimension fields from ChildObjects', () => {
    const el = readObjectEl('Sequences', 'ПоследовательностьТест.xml');
    const result = parseSequence(el)!;
    const dim = result.fields.find(f => f.name === 'Измерение1');
    expect(dim?.category).toBe('dimension');
  });

  it('has no tabularSections', () => {
    const el = readObjectEl('Sequences', 'ПоследовательностьТест.xml');
    const result = parseSequence(el)!;
    expect(result.tabularSections).toBeUndefined();
  });
});

describe('parseDocumentJournal', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('DocumentJournals', 'Взаимодействия.xml');
    const result = parseDocumentJournal(el);
    expect(result?.name).toBe('Взаимодействия');
    expect(result?.fullName).toBe('ЖурналДокументов.Взаимодействия');
    expect(result?.kind).toBe('ЖурналДокументов');
  });

  it('includes standard fields Ссылка, Дата, Номер, ТипДокумента', () => {
    const el = readObjectEl('DocumentJournals', 'Взаимодействия.xml');
    const result = parseDocumentJournal(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('Ссылка');
    expect(stdNames).toContain('Дата');
    expect(stdNames).toContain('Номер');
    expect(stdNames).toContain('ТипДокумента');
  });

  it('includes Column fields as attribute', () => {
    const el = readObjectEl('DocumentJournals', 'Взаимодействия.xml');
    const result = parseDocumentJournal(el)!;
    const colNames = result.fields.filter(f => f.category === 'attribute').map(f => f.name);
    expect(colNames).toContain('Автор');
    expect(colNames).toContain('Ответственный');
  });
});

describe('parseFilterCriteria', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('FilterCriteria', 'СвязанныеДокументы.xml');
    const result = parseFilterCriteria(el);
    expect(result?.name).toBe('СвязанныеДокументы');
    expect(result?.fullName).toBe('КритерийОтбора.СвязанныеДокументы');
    expect(result?.kind).toBe('КритерийОтбора');
  });

  it('includes only Ссылка field', () => {
    const el = readObjectEl('FilterCriteria', 'СвязанныеДокументы.xml');
    const result = parseFilterCriteria(el)!;
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('Ссылка');
    expect(result.fields[0].category).toBe('standard');
  });
});

describe('parseInformationRegister — periodicity property', () => {
  it('stores periodicity in properties for a periodical register', () => {
    const el = readObjectEl('InformationRegisters', 'АрхивСообщенийОбменов.xml');
    const result = parseInformationRegister(el)!;
    expect(result.properties?.periodicity).toBe('Second');
  });

  it('stores periodicity Nonperiodical for a non-periodical register', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el)!;
    expect(result.properties?.periodicity).toBe('Nonperiodical');
  });
});

describe('parseAccumulationRegister — registerType property', () => {
  it('stores Balance for a balance (Остатки) register', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОст.xml');
    const result = parseAccumulationRegister(el)!;
    expect(result.properties?.registerType).toBe('Balance');
  });

  it('stores Turnovers for a turnover (Обороты) register', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el)!;
    expect(result.properties?.registerType).toBe('Turnovers');
  });

  it('defaults registerType to Balance when RegisterType node is absent', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">' +
      '<AccumulationRegister uuid="x"><Properties><Name>БезВида</Name></Properties></AccumulationRegister>' +
      '</MetaDataObject>';
    const el = firstElementChild(parseXml(xml)!.documentElement);
    const result = parseAccumulationRegister(el)!;
    expect(result.properties?.registerType).toBe('Balance');
  });
});

describe('parseChartOfAccounts subconto', () => {
  it('reads MaxExtDimensionCount and ExtDimensionTypes name into properties', () => {
    const el = readObjectEl('ChartsOfAccounts', 'ПланСчетов1.xml');
    const result = parseChartOfAccounts(el)!;
    expect((result.properties as any).maxExtDimensionCount).toBe(3);
    expect((result.properties as any).extDimensionTypes).toBe('ВидыСубконто');
  });
});
