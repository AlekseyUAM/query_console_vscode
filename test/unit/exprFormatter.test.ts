import { describe, it, expect } from 'vitest';
import { needsFormatting, formatExpression, stripNegatedFieldParens } from '../../src/core/query/exprFormatter';

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

  // Фаза 6.12: несколько КОГДА — каждое условие ИНЛАЙН после `КОГДА `, ТОГДА @ E+2.
  it('multi-КОГДА CASE: each condition inline after КОГДА', () => {
    const raw =
      'ВЫБОР\n' +
      '\t\tКОГДА\n' +
      '\t\t\tТ.Тип = ЗНАЧЕНИЕ(Перечисление.Типы.А)\n' +
      '\t\t\tТОГДА &А\n' +
      '\t\tКОГДА\n' +
      '\t\t\tТ.Тип = ЗНАЧЕНИЕ(Перечисление.Типы.Б)\n' +
      '\t\t\tТОГДА &Б\n' +
      '\tКОНЕЦ';
    expect(formatExpression(raw, 'select')).toBe(
      'ВЫБОР\n' +
        '\t\tКОГДА Т.Тип = ЗНАЧЕНИЕ(Перечисление.Типы.А)\n' +
        '\t\t\tТОГДА &А\n' +
        '\t\tКОГДА Т.Тип = ЗНАЧЕНИЕ(Перечисление.Типы.Б)\n' +
        '\t\t\tТОГДА &Б\n' +
        '\tКОНЕЦ'
    );
  });

  // Фаза 6.12: длинный лист условия КОГДА (список В(...)) — сплющивается в одну строку.
  it('long КОГДА condition (multi-line В-list) flattens to one line', () => {
    const raw =
      'ВЫБОР\n' +
      '\t\tКОГДА Т.Поле В (НЕОПРЕДЕЛЕНО,\n' +
      '\t\t\tЗНАЧЕНИЕ(Справочник.С.ПустаяСсылка),\n' +
      '\t\t\tЗНАЧЕНИЕ(Справочник.Д.ПустаяСсылка))\n' +
      '\t\t\tТОГДА Т.Наименование\n' +
      '\t\tИНАЧЕ Т.ИмяДанных\n' +
      '\tКОНЕЦ';
    expect(formatExpression(raw, 'select')).toBe(
      'ВЫБОР\n' +
        '\t\tКОГДА Т.Поле В (НЕОПРЕДЕЛЕНО, ЗНАЧЕНИЕ(Справочник.С.ПустаяСсылка), ЗНАЧЕНИЕ(Справочник.Д.ПустаяСсылка))\n' +
        '\t\t\tТОГДА Т.Наименование\n' +
        '\t\tИНАЧЕ Т.ИмяДанных\n' +
        '\tКОНЕЦ'
    );
  });

  // Фаза 6.12: лист с вложенным подзапросом НЕ сплющивается (структура сохраняется).
  it('leaf with a subquery (В (ВЫБРАТЬ …)) is NOT flattened', () => {
    const raw =
      'ВЫБОР\n' +
      '\t\tКОГДА Т.Ссылка В (ВЫБРАТЬ\n' +
      '\t\t\tР.Родитель\n' +
      '\tИЗ\n' +
      '\t\tСправочник.В КАК Р)\n' +
      '\t\t\tТОГДА 1\n' +
      '\t\tИНАЧЕ 0\n' +
      '\tКОНЕЦ';
    // Лист-подзапрос остаётся многострочным дословно (не сплющивается в одну строку).
    expect(formatExpression(raw, 'select')).toContain('В (ВЫБРАТЬ\n');
  });

  // Фаза 6.12: значение-слот с верхнеуровневым ИЛИ НЕ сплющивается (булева структура).
  it('value slot with top-level OR keeps its line breaks (not flattened)', () => {
    const raw =
      'ВЫБОР\n' +
      '\t\tКОГДА Т.Тип = 1\n' +
      '\t\t\tТОГДА Т.А <> ""\n' +
      '\t\t\t\tИЛИ Т.Б <> ""\n' +
      '\t\tИНАЧЕ ИСТИНА\n' +
      '\tКОНЕЦ';
    // Значение `Т.А <> "" ИЛИ Т.Б <> ""` содержит верхнеуровневый ИЛИ → не сплющиваем.
    expect(formatExpression(raw, 'select')).toContain('ИЛИ Т.Б');
    expect(formatExpression(raw, 'select')).not.toContain('"" ИЛИ Т.Б <> ""\n\tКОНЕЦ КАК');
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

// --- Нормализация регистра ключевых слов в листьях (фаза 6.12) ---------------
import { normalizeLeafCase } from '../../src/core/query/exprFormatter';

describe('normalizeLeafCase — uppercases recognized keywords only', () => {
  it('uppercases a function name in call position (WORD(...))', () => {
    expect(normalizeLeafCase('Представление(Таблица.Поле)')).toBe('ПРЕДСТАВЛЕНИЕ(Таблица.Поле)');
    expect(normalizeLeafCase('ЕстьNull(t.X, "")')).toBe('ЕСТЬNULL(t.X, "")');
    expect(normalizeLeafCase('ДатаВремя(1, 1, 1)')).toBe('ДАТАВРЕМЯ(1, 1, 1)');
    expect(normalizeLeafCase('Значение(Перечисление.Типы.А)')).toBe('ЗНАЧЕНИЕ(Перечисление.Типы.А)');
  });

  it('uppercases literal keywords standalone', () => {
    expect(normalizeLeafCase('t.X = Неопределено')).toBe('t.X = НЕОПРЕДЕЛЕНО');
    expect(normalizeLeafCase('t.X = Ложь')).toBe('t.X = ЛОЖЬ');
    expect(normalizeLeafCase('t.X = Истина')).toBe('t.X = ИСТИНА');
    expect(normalizeLeafCase('t.X ЕСТЬ null')).toBe('t.X ЕСТЬ NULL');
  });

  it('uppercases primitive type after КАК inside ВЫРАЗИТЬ', () => {
    expect(normalizeLeafCase('ВЫРАЗИТЬ(t.X КАК Строка(1024))')).toBe('ВЫРАЗИТЬ(t.X КАК СТРОКА(1024))');
    expect(normalizeLeafCase('ВЫРАЗИТЬ(t.X КАК Число(15, 2))')).toBe('ВЫРАЗИТЬ(t.X КАК ЧИСЛО(15, 2))');
    expect(normalizeLeafCase('ВЫРАЗИТЬ(t.X КАК Дата)')).toBe('ВЫРАЗИТЬ(t.X КАК ДАТА)');
    expect(normalizeLeafCase('ВЫРАЗИТЬ(t.X КАК Булево)')).toBe('ВЫРАЗИТЬ(t.X КАК БУЛЕВО)');
  });

  it('uppercases primitive type as first token inside ТИП(...)', () => {
    expect(normalizeLeafCase('ТИП(число)')).toBe('ТИП(ЧИСЛО)');
  });

  it('keeps metadata type refs verbatim inside ТИП(...)', () => {
    expect(normalizeLeafCase('ТИП(Справочник.группыПользователей)')).toBe('ТИП(Справочник.группыПользователей)');
  });

  it('does NOT uppercase identifiers: fields, aliases, params, path segments', () => {
    // alias position (not followed by `(`)
    expect(normalizeLeafCase('t.Ссылка КАК Представление')).toBe('t.Ссылка КАК Представление');
    expect(normalizeLeafCase('Календарь.Год КАК Год')).toBe('Календарь.Год КАК Год');
    // field path segment after dot
    expect(normalizeLeafCase('Контакты.Строка')).toBe('Контакты.Строка');
    // parameter keeps its case
    expect(normalizeLeafCase('t.X = &КонецПериода')).toBe('t.X = &КонецПериода');
    // a table alias spelled like a word stays as-is
    expect(normalizeLeafCase('Таб.Ссылка <> &Ссылка')).toBe('Таб.Ссылка <> &Ссылка');
  });

  it('leaves strings untouched', () => {
    expect(normalizeLeafCase('t.X = "представление"')).toBe('t.X = "представление"');
  });

  it('is a no-op when there is nothing to normalize', () => {
    expect(normalizeLeafCase('t.X = t.Y')).toBe('t.X = t.Y');
  });
});

describe('formatExpression — leaf case normalization inside structure', () => {
  it('uppercases literal and function inside an OR chain', () => {
    const raw =
      't.X = Значение(Перечисление.А.Б)\n' +
      'ИЛИ t.Y = Неопределено';
    expect(formatExpression(raw, 'where')).toBe(
      '(t.X = ЗНАЧЕНИЕ(Перечисление.А.Б)\n' +
        '\t\t\tИЛИ t.Y = НЕОПРЕДЕЛЕНО)'
    );
  });
});

// Класс C-paren (фаза 6.12): конструктор в ГДЕ/ИМЕЮЩИЕ снимает скобки вокруг
// отрицания одиночной ссылки на поле — `(НЕ Алиас.Поле)` → `НЕ Алиас.Поле`.
// Если под НЕ стоит что-то сложнее ссылки (сравнение, ЕСТЬ NULL, В(…), группа),
// скобки сохраняются; в условии соединения скобки также сохраняются.
describe('stripNegatedFieldParens — bare negation of a field', () => {
  it('strips parens around a simple negated field', () => {
    expect(stripNegatedFieldParens('(НЕ Таблица.ПометкаУдаления)')).toBe('НЕ Таблица.ПометкаУдаления');
  });
  it('strips parens around a negated dotted-nav field', () => {
    expect(stripNegatedFieldParens('(НЕ Таблица.Ссылка.ПометкаУдаления)')).toBe('НЕ Таблица.Ссылка.ПометкаУдаления');
  });
  it('keeps parens when negation wraps ЕСТЬ NULL', () => {
    expect(stripNegatedFieldParens('(НЕ Таблица.Поле ЕСТЬ NULL)')).toBe('(НЕ Таблица.Поле ЕСТЬ NULL)');
  });
  it('keeps parens when negation wraps a В(…) predicate', () => {
    expect(stripNegatedFieldParens('(НЕ Таблица.Поле В (&Список))')).toBe('(НЕ Таблица.Поле В (&Список))');
  });
  it('leaves an already-bare negation untouched', () => {
    expect(stripNegatedFieldParens('НЕ Таблица.ПометкаУдаления')).toBe('НЕ Таблица.ПометкаУдаления');
  });
});

describe('formatExpression — НЕ-conjunct parens (WHERE/HAVING vs join)', () => {
  it('strips parens around a standalone negated field in WHERE', () => {
    expect(formatExpression('(НЕ Таблица.ПометкаУдаления)', 'where')).toBe('НЕ Таблица.ПометкаУдаления');
  });
  it('strips parens around a negated field conjunct in WHERE', () => {
    expect(formatExpression('Таблица.Поле = &П И (НЕ Таблица.ПометкаУдаления)', 'where')).toBe(
      'Таблица.Поле = &П\n\tИ НЕ Таблица.ПометкаУдаления'
    );
  });
  it('strips parens in HAVING too', () => {
    expect(formatExpression('(НЕ Таблица.ПометкаУдаления)', 'having')).toBe('НЕ Таблица.ПометкаУдаления');
  });
  it('strips parens when НЕ wraps a comparison (ЕСТЬ NULL) in WHERE', () => {
    // Живой оракул (validate_query, 2026-06-13): `И (НЕ Поле ЕСТЬ NULL)` и
    // `И НЕ (Поле ЕСТЬ NULL)` ОБА печатаются как `И НЕ Поле ЕСТЬ NULL` — конструктор
    // снимает избыточные скобки вокруг отрицания предиката в ГДЕ/ИМЕЮЩИЕ (в ПО — НЕТ).
    expect(formatExpression('Таблица.Поле = &П И (НЕ Таблица.Идентификатор ЕСТЬ NULL)', 'where')).toBe(
      'Таблица.Поле = &П\n\tИ НЕ Таблица.Идентификатор ЕСТЬ NULL'
    );
  });
  it('keeps parens around a negated field inside a join condition', () => {
    expect(formatExpression('a.X = b.Y И (НЕ Таблица.ПометкаУдаления)', 'join')).toBe(
      'a.X = b.Y\n\t\t\tИ (НЕ Таблица.ПометкаУдаления)'
    );
  });
});
