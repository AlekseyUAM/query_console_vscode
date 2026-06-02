import { describe, it, expect } from 'vitest';
import { parseXml, firstElementChild } from '../../src/core/metadata/parser/dom';
import { parseTypeBlock, mapMdObjectRef } from '../../src/core/metadata/parser/typeParser';

function typeEl(inner: string): any {
  const doc = parseXml(`<r xmlns:v8="urn:v8"><Type>${inner}</Type></r>`);
  return firstElementChild(doc!.documentElement);
}

describe('parseTypeBlock', () => {
  it('строка с квалификаторами', () => {
    const el = typeEl(
      '<v8:Type>xs:string</v8:Type>' +
        '<v8:StringQualifiers><v8:Length>50</v8:Length><v8:AllowedLength>Variable</v8:AllowedLength></v8:StringQualifiers>'
    );
    expect(parseTypeBlock(el)).toEqual([{ kind: 'Строка', length: 50, allowedLength: 'Variable' }]);
  });

  it('число с квалификаторами', () => {
    const el = typeEl(
      '<v8:Type>xs:decimal</v8:Type>' +
        '<v8:NumberQualifiers><v8:Digits>10</v8:Digits><v8:FractionDigits>2</v8:FractionDigits><v8:AllowedSign>Any</v8:AllowedSign></v8:NumberQualifiers>'
    );
    expect(parseTypeBlock(el)).toEqual([
      { kind: 'Число', digits: 10, fractionDigits: 2, allowedSign: 'Any' },
    ]);
  });

  it('дата с DateFractions', () => {
    const el = typeEl(
      '<v8:Type>xs:dateTime</v8:Type>' +
        '<v8:DateQualifiers><v8:DateFractions>Date</v8:DateFractions></v8:DateQualifiers>'
    );
    expect(parseTypeBlock(el)).toEqual([{ kind: 'Дата', dateFractions: 'Date' }]);
  });

  it('булево', () => {
    const el = typeEl('<v8:Type>xs:boolean</v8:Type>');
    expect(parseTypeBlock(el)).toEqual([{ kind: 'Булево' }]);
  });

  it('ссылки CatalogRef/DocumentRef/EnumRef', () => {
    expect(parseTypeBlock(typeEl('<v8:Type>cfg:CatalogRef.Валюты</v8:Type>'))).toEqual([
      { kind: 'ref', ref: 'Справочник.Валюты' },
    ]);
    expect(parseTypeBlock(typeEl('<v8:Type>cfg:DocumentRef.Встреча</v8:Type>'))).toEqual([
      { kind: 'ref', ref: 'Документ.Встреча' },
    ]);
    expect(parseTypeBlock(typeEl('<v8:Type>cfg:EnumRef.СпособыУстановкиКурсаВалюты</v8:Type>'))).toEqual([
      { kind: 'ref', ref: 'Перечисление.СпособыУстановкиКурсаВалюты' },
    ]);
  });

  it('составной тип: строка + число с раздельными квалификаторами', () => {
    const el = typeEl(
      '<v8:Type>xs:string</v8:Type>' +
        '<v8:Type>xs:decimal</v8:Type>' +
        '<v8:StringQualifiers><v8:Length>10</v8:Length></v8:StringQualifiers>' +
        '<v8:NumberQualifiers><v8:Digits>5</v8:Digits></v8:NumberQualifiers>'
    );
    expect(parseTypeBlock(el)).toEqual([
      { kind: 'Строка', length: 10 },
      { kind: 'Число', digits: 5 },
    ]);
  });

  it('неизвестный тип сохраняется как unknown+raw', () => {
    const el = typeEl('<v8:Type>cfg:ChartOfAccountsRef.Основной</v8:Type>');
    expect(parseTypeBlock(el)).toEqual([
      { kind: 'unknown', raw: 'cfg:ChartOfAccountsRef.Основной' },
    ]);
  });

  it('mapMdObjectRef: формат Catalog./Document./Enum.', () => {
    expect(mapMdObjectRef('Catalog.Контрагенты')).toEqual({ kind: 'ref', ref: 'Справочник.Контрагенты' });
    expect(mapMdObjectRef('Document.ЗаказПокупателя')).toEqual({ kind: 'ref', ref: 'Документ.ЗаказПокупателя' });
    expect(mapMdObjectRef('Что-тоНепонятное')).toEqual({ kind: 'unknown', raw: 'Что-тоНепонятное' });
  });
});
