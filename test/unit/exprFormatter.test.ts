import { describe, it, expect } from 'vitest';
import { needsFormatting, formatExpression } from '../../src/core/query/exprFormatter';

describe('needsFormatting', () => {
  it('false for a pure leaf comparison', () => {
    expect(needsFormatting('a.X = &P')).toBe(false);
  });
  it('false for a simple AND chain without OR/CASE', () => {
    expect(needsFormatting('a.X = 1 И b.Y = 2')).toBe(false);
  });
  it('false for МЕЖДУ (the И inside is not a boolean separator)', () => {
    expect(needsFormatting('a.X МЕЖДУ 1 И 10')).toBe(false);
  });
  it('false for ЕСТЬ НЕ NULL leaf', () => {
    expect(needsFormatting('a.X ЕСТЬ НЕ NULL')).toBe(false);
  });
  it('false for a function call with parens (no structural group)', () => {
    expect(needsFormatting('ЕСТЬNULL(a.X, "") = ""')).toBe(false);
  });
  it('true when a top-level ИЛИ is present', () => {
    expect(needsFormatting('a.X = 1 ИЛИ b.Y = 2')).toBe(true);
  });
  it('true when ВЫБОР is present', () => {
    expect(needsFormatting('ВЫБОР КОГДА a.X ТОГДА 1 ИНАЧЕ 2 КОНЕЦ')).toBe(true);
  });
  it('true for parenthesised OR group inside an AND chain', () => {
    expect(needsFormatting('a.X = 1 И (b.Y = 2 ИЛИ c.Z = 3)')).toBe(true);
  });
});

describe('formatExpression — WHERE boolean chains', () => {
  // ВерсииФайлов: И [leaf, (a ИЛИ (b И c))]
  it('AND with a trailing OR group (depth 1)', () => {
    const raw =
      'ВерсииФайлов.ТипХраненияФайла = ЗНАЧЕНИЕ(Перечисление.ТипыХраненияФайлов.ВТомахНаДиске)\n' +
      'И (ВерсииФайлов.ДатаМодификацииУниверсальная < &ДатаМодификации\n' +
      'ИЛИ ВерсииФайлов.ДатаМодификацииУниверсальная = &ДатаМодификации\n' +
      'И ВерсииФайлов.Ссылка < &Ссылка)';
    const out = formatExpression(raw, 'where');
    expect(out).toBe(
      'ВерсииФайлов.ТипХраненияФайла = ЗНАЧЕНИЕ(Перечисление.ТипыХраненияФайлов.ВТомахНаДиске)\n' +
        '\tИ (ВерсииФайлов.ДатаМодификацииУниверсальная < &ДатаМодификации\n' +
        '\t\t\tИЛИ ВерсииФайлов.ДатаМодификацииУниверсальная = &ДатаМодификации\n' +
        '\t\t\t\tИ ВерсииФайлов.Ссылка < &Ссылка)'
    );
  });

  // ВнешниеКомпоненты: pure OR at top  (a ИЛИ (b И c))
  it('pure OR at top of WHERE', () => {
    const raw =
      'ВнешниеКомпоненты.Идентификатор = &Идентификатор\n' +
      'ИЛИ ВнешниеКомпоненты.Идентификатор = &Идентификатор2\n' +
      'И ВнешниеКомпоненты.Версия ПОДОБНО "3.1.0.%"';
    const out = formatExpression(raw, 'where');
    expect(out).toBe(
      '(ВнешниеКомпоненты.Идентификатор = &Идентификатор\n' +
        '\t\t\tИЛИ ВнешниеКомпоненты.Идентификатор = &Идентификатор2\n' +
        '\t\t\t\tИ ВнешниеКомпоненты.Версия ПОДОБНО "3.1.0.%")'
    );
  });

  // ВидыКонтактнойИнформации: И [leaf, OR(5 leaves)] with ЕСТЬ NULL leaf
  it('AND with a 5-operand OR group, ЕСТЬ NULL leaf swallowed', () => {
    const raw =
      'ВидыКонтактнойИнформации.ЭтоГруппа = ЛОЖЬ\n' +
      'И (ЕСТЬNULL(ВидыКонтактнойИнформации.ИдентификаторДляФормул, "") = ""\n' +
      'ИЛИ ЕСТЬNULL(ВидыКонтактнойИнформации.ВидРедактирования, "") = ""\n' +
      'ИЛИ ЕСТЬNULL(ВидыКонтактнойИнформации.ИмяГруппы, "") = ""\n' +
      'ИЛИ ВидыКонтактнойИнформации.ОтображатьВсегда = ЛОЖЬ\n' +
      'ИЛИ ПредставленияВида.Ссылка ЕСТЬ NULL)';
    const out = formatExpression(raw, 'where');
    expect(out).toBe(
      'ВидыКонтактнойИнформации.ЭтоГруппа = ЛОЖЬ\n' +
        '\tИ (ЕСТЬNULL(ВидыКонтактнойИнформации.ИдентификаторДляФормул, "") = ""\n' +
        '\t\t\tИЛИ ЕСТЬNULL(ВидыКонтактнойИнформации.ВидРедактирования, "") = ""\n' +
        '\t\t\tИЛИ ЕСТЬNULL(ВидыКонтактнойИнформации.ИмяГруппы, "") = ""\n' +
        '\t\t\tИЛИ ВидыКонтактнойИнформации.ОтображатьВсегда = ЛОЖЬ\n' +
        '\t\t\tИЛИ ПредставленияВида.Ссылка ЕСТЬ NULL)'
    );
  });
});

describe('formatExpression — CASE in select (value slot)', () => {
  it('simple КОГДА/ТОГДА/ИНАЧЕ/КОНЕЦ at value slot', () => {
    const raw =
      'ВЫБОР\n' +
      'КОГДА ВидыКонтактнойИнформации.ИмяПредопределенногоВида <> ""\n' +
      'ТОГДА ВидыКонтактнойИнформации.ИмяПредопределенногоВида\n' +
      'ИНАЧЕ ВидыКонтактнойИнформации.ИмяПредопределенныхДанных\n' +
      'КОНЕЦ';
    const out = formatExpression(raw, 'select');
    expect(out).toBe(
      'ВЫБОР\n' +
        '\t\tКОГДА ВидыКонтактнойИнформации.ИмяПредопределенногоВида <> ""\n' +
        '\t\t\tТОГДА ВидыКонтактнойИнформации.ИмяПредопределенногоВида\n' +
        '\t\tИНАЧЕ ВидыКонтактнойИнформации.ИмяПредопределенныхДанных\n' +
        '\tКОНЕЦ'
    );
  });

  // МашиночитаемыеДоверенности: КОГДА-условие — И-цепочка, продолжения @ КОГДА+2.
  it('value-slot CASE with an AND in the КОГДА condition (continuation at when+2)', () => {
    const raw =
      'ВЫБОР\n' +
      'КОГДА &ТекущаяДата > КОНЕЦПЕРИОДА(М.ДатаОкончания, ДЕНЬ)\n' +
      'И М.Статус = ЗНАЧЕНИЕ(Перечисление.СтатусыМЧД.Действует)\n' +
      'ТОГДА 4\n' +
      'ИНАЧЕ 5\n' +
      'КОНЕЦ';
    expect(formatExpression(raw, 'select')).toBe(
      'ВЫБОР\n' +
        '\t\tКОГДА &ТекущаяДата > КОНЕЦПЕРИОДА(М.ДатаОкончания, ДЕНЬ)\n' +
        '\t\t\t\tИ М.Статус = ЗНАЧЕНИЕ(Перечисление.СтатусыМЧД.Действует)\n' +
        '\t\t\tТОГДА 4\n' +
        '\t\tИНАЧЕ 5\n' +
        '\tКОНЕЦ'
    );
  });

  // ГруппыДоступа: булево выражение-поле (OR) в value-слоте: orDelta=1, без скобок.
  it('select field that is a bare OR (no wrapping parens, ИЛИ at base+1)', () => {
    const raw =
      'НЕ a.X ЕСТЬ NULL\n' +
      'ИЛИ НЕ b.Y ЕСТЬ NULL\n' +
      'ИЛИ c.Z = &П';
    expect(formatExpression(raw, 'select')).toBe(
      'НЕ a.X ЕСТЬ NULL\n' +
        '\t\tИЛИ НЕ b.Y ЕСТЬ NULL\n' +
        '\t\tИЛИ c.Z = &П'
    );
  });
});

describe('formatExpression — CASE in WHERE (boolean slot)', () => {
  // Взаимодействия: И ВЫБОР … КОНЕЦ — boolean slot, E=2.
  it('CASE as an AND operand in WHERE (E = cursor+1)', () => {
    const raw =
      'ВЫБОР\n' +
      'КОГДА a.Дата = ДАТАВРЕМЯ(1, 1, 1)\n' +
      'ТОГДА ИСТИНА\n' +
      'ИНАЧЕ a.Дата < &Текущая\n' +
      'КОНЕЦ';
    // как одиночное условие ГДЕ (caller prepends \t, prefixes И for k>0)
    expect(formatExpression(raw, 'where')).toBe(
      'ВЫБОР\n' +
        '\t\t\tКОГДА a.Дата = ДАТАВРЕМЯ(1, 1, 1)\n' +
        '\t\t\t\tТОГДА ИСТИНА\n' +
        '\t\t\tИНАЧЕ a.Дата < &Текущая\n' +
        '\t\tКОНЕЦ'
    );
  });

  // ДатыЗапретаИзменения: КОГДА-условие — OR (ИЛИ @ КОГДА+2), без скобок.
  it('CASE whose КОГДА condition is an OR (ИЛИ at when+2, no parens)', () => {
    const raw =
      'ВЫБОР\n' +
      'КОГДА ТИПЗНАЧЕНИЯ(d.П) = ТИП(Справочник.Пользователи)\n' +
      'ИЛИ ТИПЗНАЧЕНИЯ(d.П) = ТИП(Справочник.ГруппыПользователей)\n' +
      'ТОГДА &A = ЛОЖЬ\n' +
      'ИНАЧЕ &A = ИСТИНА\n' +
      'КОНЕЦ';
    // Верхний ВЫБОР в ГДЕ — boolean-слот: E=2, КОГДА=3, ТОГДА=4, ИНАЧЕ=3, КОНЕЦ=2.
    // КОГДА-условие OR: ИЛИ @ КОГДА+2 = 5.
    expect(formatExpression(raw, 'where')).toBe(
      'ВЫБОР\n' +
        '\t\t\tКОГДА ТИПЗНАЧЕНИЯ(d.П) = ТИП(Справочник.Пользователи)\n' +
        '\t\t\t\t\tИЛИ ТИПЗНАЧЕНИЯ(d.П) = ТИП(Справочник.ГруппыПользователей)\n' +
        '\t\t\t\tТОГДА &A = ЛОЖЬ\n' +
        '\t\t\tИНАЧЕ &A = ИСТИНА\n' +
        '\t\tКОНЕЦ'
    );
  });
});

describe('formatExpression — ИМЕЮЩИЕ', () => {
  // УправлениеДоступомСлужебный_74: верхний OR в ИМЕЮЩИЕ — orDelta=1 (ИЛИ @ 2).
  it('top OR in HAVING uses orDelta 1 (ИЛИ at tab 2)', () => {
    const raw =
      'МИНИМУМ(t.ЭтоЗапуск) = ЛОЖЬ\n' +
      'ИЛИ КОЛИЧЕСТВО(t.ЭтоЗапуск) < &КоличествоПотоков';
    expect(formatExpression(raw, 'having')).toBe(
      '(МИНИМУМ(t.ЭтоЗапуск) = ЛОЖЬ\n' +
        '\t\tИЛИ КОЛИЧЕСТВО(t.ЭтоЗапуск) < &КоличествоПотоков)'
    );
  });
});

describe('formatExpression — join ПО', () => {
  // ВариантыОтчетов: первый конъюнкт дословно (без скобок), И (…) @ 3.
  it('compound join: first conjunct verbatim, И (…) at tab 3', () => {
    const raw = 'a.Ссылка = b.Ссылка\nИ (b.КодЯзыка = &КодЯзыка)';
    expect(formatExpression(raw, 'join')).toBe(
      'a.Ссылка = b.Ссылка\n' +
        '\t\t\tИ (b.КодЯзыка = &КодЯзыка)'
    );
  });

  // ЭлектроннаяПодпись: первый конъюнкт — OR (orDelta=2, ИЛИ @ 4), затем И-конъюнкты.
  it('compound join: first conjunct OR (ИЛИ at tab 4), then AND conjuncts', () => {
    const raw =
      '(a.КомуВыдан <> ""\nИЛИ a.Фирма <> "")\n' +
      'И a.Ссылка <> b.Ссылка';
    expect(formatExpression(raw, 'join')).toBe(
      '(a.КомуВыдан <> ""\n' +
        '\t\t\t\tИЛИ a.Фирма <> "")\n' +
        '\t\t\tИ a.Ссылка <> b.Ссылка'
    );
  });

  // УправлениеДоступомСлужебный_195: (ВЫБОР … КОНЕЦ) конъюнкт — КОНЕЦ @ ind, в скобках.
  it('join conjunct (ВЫБОР … КОНЕЦ): E = conjunct indent, wrapped in parens', () => {
    const raw =
      'a.Тип = ЗНАЧЕНИЕ(Справочник.Пользователи.ПустаяСсылка)\n' +
      'И (ВЫБОР\n' +
      'КОГДА n.Ссылка = r.Пользователь\n' +
      'ТОГДА ИСТИНА\n' +
      'ИНАЧЕ n.Набор = r.Пользователь\n' +
      'КОНЕЦ)';
    expect(formatExpression(raw, 'join')).toBe(
      'a.Тип = ЗНАЧЕНИЕ(Справочник.Пользователи.ПустаяСсылка)\n' +
        '\t\t\tИ (ВЫБОР\n' +
        '\t\t\t\tКОГДА n.Ссылка = r.Пользователь\n' +
        '\t\t\t\t\tТОГДА ИСТИНА\n' +
        '\t\t\t\tИНАЧЕ n.Набор = r.Пользователь\n' +
        '\t\t\tКОНЕЦ)'
    );
  });
});

describe('formatExpression — verbatim tail preservation', () => {
  // Парсер SDBL иногда захватывает ИТОГИ ПО / УПОРЯДОЧИТЬ ПО в текст условия —
  // форматер сохраняет хвост дословно (с исходными пробелами).
  it('preserves trailing УПОРЯДОЧИТЬ ПО after a structural group', () => {
    const raw =
      '(a.X = &П\nИЛИ a.X = "")\n\nУПОРЯДОЧИТЬ ПО\n\tКоррСчет УБЫВ';
    expect(formatExpression(raw, 'where')).toBe(
      '(a.X = &П\n' +
        '\t\t\tИЛИ a.X = "")\n\nУПОРЯДОЧИТЬ ПО\n\tКоррСчет УБЫВ'
    );
  });
});
