/**
 * Квалификация ГОЛЫХ (неквалифицированных) ссылок на поля псевдонимом
 * источника-владельца (фаза 6.17).
 *
 * Конструктор 1С печатает КАЖДУЮ ссылку на колонку источника квалифицированно —
 * `<псевдонимТаблицы>.<поле>` — даже если разработчик написал её голой
 * (`ГДЕ ПолноеИмя = …` → `ГДЕ ИдентификаторыОбъектовМетаданных.ПолноеИмя = …`).
 * Наш парсер сохраняет голые ссылки как есть (в сырых выражениях условий/полей и
 * в нерезолвенных секциях УПОРЯДОЧИТЬ/СГРУППИРОВАТЬ/ИТОГИ). Этот пост-разбор-пасс
 * восстанавливает префикс владельца.
 *
 * Владелец голого поля определяется так:
 *  • Ровно ОДИН источник в запросе → им и квалифицируем (метаданные не нужны —
 *    источник может быть параметром `&Имя`/временной `#Имя`/подзапросом).
 *  • Несколько источников → квалифицируем ТОЛЬКО когда владелец однозначен по
 *    метаданным (ровно один источник несёт это поле) И нет источников с
 *    неизвестным составом колонок (параметр/временная без метаданных/подзапрос),
 *    которые могли бы тоже владеть полем. Иначе — оставляем голым (неверная
 *    квалификация хуже отсутствия).
 *
 * НЕ квалифицируются: параметры (`&П`), литералы (NULL/ИСТИНА/ЛОЖЬ/НЕОПРЕДЕЛЕНО),
 * вызовы функций (имя перед `(`), структурные слова (ВЫБОР/КОГДА/ЕСТЬ/И/ИЛИ/…),
 * имена типов метаданных (`Справочник.X` в ЗНАЧЕНИЕ(…)/ТИП(…)), уже
 * квалифицированные ссылки (`Алиас.Поле`, где голова — псевдоним источника) и
 * псевдонимы после `КАК`.
 */
import { tokenize, type Token } from './sdblLexer';
import type { QueryModel, SelectedField, Condition, FieldRef } from './queryModel';
import type { MetadataResolver } from './metadataResolver';
import type { QueryDocument } from './unionModel';
import { resolveAliases } from './sdblGenerator';

/** Структурные слова-операторы, никогда не являющиеся полем. */
const STRUCTURAL = new Set([
  'ВЫБОР', 'КОГДА', 'ТОГДА', 'ИНАЧЕ', 'КОНЕЦ', 'ЕСТЬ', 'И', 'ИЛИ', 'НЕ',
  'В', 'МЕЖДУ', 'ПОДОБНО', 'СПЕЦСИМВОЛ', 'КАК', 'УБЫВ', 'ВОЗР',
  'ИЕРАРХИИ', 'ИЕРАРХИЯ', 'ВЫБРАТЬ', 'ИЗ', 'ГДЕ', 'ПО',
  // Модификаторы выборки/агрегата внутри выражений (`КОЛИЧЕСТВО(РАЗЛИЧНЫЕ …)`).
  'РАЗЛИЧНЫЕ', 'РАЗРЕШЕННЫЕ', 'ПЕРВЫЕ', 'ВСЕ', 'ОБЪЕДИНИТЬ',
  // Структурные слова СЕКЦИЙ/СОЕДИНЕНИЙ встроенного подзапроса (тело разбирается
  // как `ВЫБРАТЬ … ИЗ … СОЕДИНЕНИЕ … ГДЕ … СГРУППИРОВАТЬ … ПОМЕСТИТЬ`): они не поля.
  'ЛЕВОЕ', 'ПРАВОЕ', 'ВНУТРЕННЕЕ', 'ПОЛНОЕ', 'ВНЕШНЕЕ', 'СОЕДИНЕНИЕ',
  'СГРУППИРОВАТЬ', 'УПОРЯДОЧИТЬ', 'ИМЕЮЩИЕ', 'ИТОГИ', 'ИНДЕКСИРОВАТЬ', 'ПОМЕСТИТЬ',
  'ДЛЯ', 'ИЗМЕНЕНИЯ',
  // Английские эквиваленты операторов/литералов (встречаются в нетиповых запросах).
  'IS', 'NULL', 'AND', 'OR', 'NOT', 'AS', 'BETWEEN', 'LIKE', 'TRUE', 'FALSE',
]);

/** Литералы-ключевые слова. */
const LITERALS = new Set(['НЕОПРЕДЕЛЕНО', 'ИСТИНА', 'ЛОЖЬ', 'NULL']);

/** Гранулярность периода (аргумент функций дат) — не поле. */
const PERIOD_WORDS = new Set([
  'ГОД', 'ПОЛУГОДИЕ', 'КВАРТАЛ', 'МЕСЯЦ', 'ДЕКАДА', 'НЕДЕЛЯ', 'ДЕНЬ', 'ЧАС', 'МИНУТА', 'СЕКУНДА',
]);

/** Примитивные типы (позиция типа после КАК/в ТИП(…)) — не поле. */
const PRIMITIVE_TYPES = new Set(['СТРОКА', 'ЧИСЛО', 'ДАТА', 'БУЛЕВО']);

/**
 * Префиксы имён типов метаданных: голова `<Тип>.<Имя>[.<Значение>]` в
 * ЗНАЧЕНИЕ(…)/ТИП(…)/ссылках на пустые ссылки. Такую голову квалифицировать нельзя.
 */
const TYPE_PREFIXES = new Set([
  'СПРАВОЧНИК', 'ДОКУМЕНТ', 'ПЕРЕЧИСЛЕНИЕ', 'РЕГИСТРСВЕДЕНИЙ', 'РЕГИСТРНАКОПЛЕНИЯ',
  'РЕГИСТРБУХГАЛТЕРИИ', 'РЕГИСТРРАСЧЕТА', 'ПЛАНВИДОВХАРАКТЕРИСТИК', 'ПЛАНСЧЕТОВ',
  'ПЛАНВИДОВРАСЧЕТА', 'БИЗНЕСПРОЦЕСС', 'ЗАДАЧА', 'ПЛАНОБМЕНА', 'КОНСТАНТА',
  'ОПРЕДЕЛЯЕМЫЙТИП', 'ХРАНИЛИЩЕНАСТРОЕК', 'ВНЕШНИЙИСТОЧНИКДАННЫХ', 'ТАБЛИЦА',
]);

interface SourceInfo {
  alias: string;
  /** Известный состав колонок (метаданные таблицы или выходные псевдонимы подзапроса). */
  fields?: Set<string>;
  /** Состав колонок НЕИЗВЕСТЕН (параметр/временная без метаданных/подзапрос без модели). */
  wildcard: boolean;
}

interface OwnerContext {
  aliases: Set<string>; // ВСЕ псевдонимы источников (верхний регистр) — для распознавания уже квалифицированных
  /** Карта ВЕРХНИЙ→объявленное написание псевдонима источника (нормализация регистра квалификатора). */
  aliasSpelling: Map<string, string>;
  /** Псевдонимы источников ОБЪЕМЛЮЩИХ запросов (коррелированные ссылки в подзапросе). */
  outerAliases: Set<string>;
  /** Источники объемлющих запросов (для разрешения коррелированных голых полей). */
  outerSources: SourceInfo[];
  sources: SourceInfo[];
  /** Резолвер метаданных (для контекста встроенных в сырое выражение подзапросов). */
  resolver?: MetadataResolver;
  /**
   * Разбор текста подзапроса в документ (инжектится парсером во избежание
   * циклического импорта). Нужен для квалификации голых полей внутри встроенного в
   * СЫРОЕ выражение подзапроса `(ВЫБРАТЬ … ИЗ …)` (tuple-LHS `В`, булева цепочка,
   * подзапрос в `ВЫБОР`), который не разобран структурно в `c.subquery`.
   */
  parseDoc?: ParseDocFn;
}

/** Сигнатура `parseDocument` (инжектится, чтобы не импортировать парсер). */
export type ParseDocFn = (text: string, resolver?: MetadataResolver) => QueryDocument;

/**
 * Инжектированный разборщик подзапросов (модульный уровень — пасс синхронный,
 * однопоточный). Парсер вызывает `setSubqueryParser(parseDocument)` один раз при
 * загрузке модуля; так избегаем циклического импорта `qualifyBareFields ↔ sdblParser`.
 */
let activeParseDoc: ParseDocFn | undefined;
export function setSubqueryParser(fn: ParseDocFn): void {
  activeParseDoc = fn;
}

function up(s: string): string {
  return s.toUpperCase();
}

/** Выходные псевдонимы участника объединения 0 подзапроса (имена колонок). */
function subqueryColumns(doc: QueryDocument): Set<string> {
  const cols = new Set<string>();
  const m0 = doc.members[0]?.model;
  if (!m0) return cols;
  for (const f of m0.fields) {
    const name = f.alias ?? (f.path ? f.path.split('.').pop() : undefined);
    if (name) cols.add(up(name));
  }
  return cols;
}

function buildContext(
  model: QueryModel,
  resolver: MetadataResolver | undefined,
  outerAliases: Set<string> = new Set(),
  outerSources: SourceInfo[] = []
): OwnerContext {
  const sources: SourceInfo[] = [];
  const aliases = new Set<string>();
  const aliasSpelling = new Map<string, string>();
  // Те же псевдонимы, что печатает генератор (синтез по `defaultTableAlias` с
  // дедупликацией) — иначе квалификация навесит неверный префикс.
  const aliasMap = resolveAliases(model.tables);
  for (const t of model.tables) {
    const alias = aliasMap.get(t.id) ?? t.alias ?? t.fullName;
    if (alias) { aliases.add(up(alias)); aliasSpelling.set(up(alias), alias); }
    if (t.subquery) {
      const cols = subqueryColumns(t.subquery);
      sources.push({ alias, fields: cols.size > 0 ? cols : undefined, wildcard: cols.size === 0 });
      continue;
    }
    const fullName = t.fullName;
    // Источник-параметр (`&Имя`) и виртуальная таблица (срез/обороты) — состав
    // колонок неизвестен. Для реальных таблиц (`Тип.Имя`) и ВРЕМЕННЫХ таблиц
    // (`#Имя`/односегментное имя, зарегистрированных предыдущим `ПОМЕСТИТЬ`)
    // резолвер знает поля — пробуем его.
    const lookupName = fullName.startsWith('#') ? fullName.slice(1).replace(/#$/, '') : fullName;
    // Реальная таблица/временная по `tableByFullName`; ВИРТУАЛЬНАЯ (срез/остатки-
    // обороты РН/РБ) — по `virtualTableByFullName` (резолвер знает её колонки).
    const meta = resolver && !fullName.startsWith('&') && fullName !== ''
      ? (t.virtual
          ? resolver.virtualTableByFullName?.(lookupName)
          : resolver.tableByFullName(lookupName))
      : undefined;
    if (meta) {
      // Состав «полей» источника для квалификации голов голых путей включает и
      // ИМЕНА ТАБЛИЧНЫХ ЧАСТЕЙ: `Товары.Ссылка` при источнике-документе `Шапка`
      // (где `Товары` — ТЧ) конструктор квалифицирует как `Шапка.Товары.Ссылка`
      // (навигация документ→ТЧ→поле). Без них голова-ТЧ не находила владельца. (6.17)
      const names = new Set(meta.fields.map(f => up(f.name)));
      for (const ts of meta.tabularSections ?? []) names.add(up(ts.name));
      sources.push({ alias, fields: names, wildcard: false });
    } else {
      sources.push({ alias, wildcard: true });
    }
  }
  return { aliases, aliasSpelling, outerAliases, outerSources, sources, resolver, parseDoc: activeParseDoc };
}

/**
 * Псевдоним источника-владельца голого поля `name`, либо undefined, если владелец
 * не определён однозначно (и поле остаётся голым). `requireMeta` — требовать
 * подтверждения по метаданным (голова составного пути `X.rest`: квалифицируем
 * только если `X` — РЕАЛЬНОЕ поле источника, иначе это может быть нераспознанный
 * префикс типа метаданных или коррелированный псевдоним).
 */
function ownerAlias(ctx: OwnerContext, name: string, requireMeta: boolean): string | undefined {
  const N = up(name);
  const owners = ctx.sources.filter(s => s.fields?.has(N));
  const wildcards = ctx.sources.filter(s => s.wildcard);
  if (requireMeta) {
    // Только подтверждённое по метаданным владение (ровно один известный владелец).
    if (owners.length === 1) return owners[0].alias;
    return undefined;
  }
  // Единственный источник → он и владелец (метаданные не нужны). НО в
  // КОРРЕЛИРОВАННОМ подзапросе (есть внешние псевдонимы): если состав колонок
  // единственного источника известен и поля среди них НЕТ — поле принадлежит
  // внешнему запросу. Тогда квалифицируем ВНЕШНИМ источником, если он однозначно
  // несёт поле по метаданным (оракул резолвит коррелированную ссылку на внешний
  // источник); иначе оставляем голым.
  if (ctx.sources.length === 1) {
    const s = ctx.sources[0];
    if (ctx.outerAliases.size > 0 && s.fields && !s.fields.has(N)) {
      const outerOwners = ctx.outerSources.filter(os => os.fields?.has(N));
      return outerOwners.length === 1 ? outerOwners[0].alias : undefined;
    }
    return s.alias;
  }
  // Ровно один известный (по метаданным) владелец поля → квалифицируем им, даже
  // если присутствуют источники с неизвестным составом колонок (временная таблица
  // /параметр/подзапрос). Оракул резолвит голое поле на единственный РЕАЛЬНЫЙ
  // источник, несущий его (`СрокУплаты` РН + временная `ВТКурсы…` → РН), а не
  // оставляет голым.
  if (owners.length === 1) return owners[0].alias;
  // Ни один известный источник не несёт поле, но есть РОВНО ОДИН источник с
  // неизвестным составом колонок (параметр/временная/подзапрос).
  if (owners.length === 0 && wildcards.length === 1) return wildcards[0].alias;
  return undefined;
}

/** Индекс парной `)` для `(` на позиции `openIdx` в массиве токенов, иначе -1. */
function matchCloseIndex(sig: Token[], openIdx: number): number {
  let d = 0;
  for (let k = openIdx; k < sig.length; k++) {
    const tk = sig[k];
    if (tk.type === 'punct' && tk.value === '(') d++;
    else if (tk.type === 'punct' && tk.value === ')') {
      d--;
      if (d === 0) return k;
    }
  }
  return -1;
}

/**
 * Квалификация голых полей внутри ВСТРОЕННОГО в сырое выражение подзапроса
 * `ВЫБРАТЬ … ИЗ …` (текст БЕЗ внешних скобок). Подзапрос несёт собственную область
 * видимости: разбираем его текст инжектированным `parseDoc`, строим контекст по его
 * `ИЗ`, и квалифицируем тело тем же `qualifyExpression` (псевдонимы внешнего запроса
 * — как коррелированные, чтобы их не трогать и распознавать корреляции). Имена
 * источников после `ИЗ`/`КАК` и так пропускаются (они в `aliases`/после `КАК`/типы),
 * а структурные слова соединений — в `STRUCTURAL`. Без `parseDoc` — текст как есть.
 */
function qualifySubquerySpan(innerRaw: string, outerCtx: OwnerContext): string {
  const parseDoc = outerCtx.parseDoc;
  if (!parseDoc) return innerRaw;
  let innerDoc: QueryDocument;
  try {
    innerDoc = parseDoc(innerRaw, outerCtx.resolver);
  } catch {
    return innerRaw;
  }
  const m0 = innerDoc.members[0]?.model;
  if (!m0) return innerRaw;
  // Внешние псевдонимы/источники подзапроса = текущие + унаследованные внешние
  // (коррелированные ссылки на колонки объемлющих запросов).
  const innerOuterAliases = new Set([...outerCtx.outerAliases, ...outerCtx.aliases]);
  const innerOuterSources = [...outerCtx.outerSources, ...outerCtx.sources];
  const innerCtx = buildContext(m0, outerCtx.resolver, innerOuterAliases, innerOuterSources);
  if (innerCtx.sources.length === 0) return innerRaw;
  return qualifyExpression(innerRaw, innerCtx);
}

/**
 * Квалифицирует голые ссылки на поля в сыром выражении. Возвращает переписанный
 * текст (или исходный, если ничего не изменилось/не токенизируется).
 */
function qualifyExpression(raw: string, ctx: OwnerContext): string {
  if (ctx.sources.length === 0) return raw;
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return raw;
  }
  const sig = toks.filter(t => t.type !== 'eof');

  // Глубина скобок, на которой открыт вызов ЗНАЧЕНИЕ(…)/ТИП(…): внутри его аргументов
  // ВСЕ идентификаторы — имена типов метаданных (`ВидДвиженияНакопления.Приход`,
  // `Справочник.X.ПустаяСсылка`), а не поля. Квалифицировать их нельзя.
  const metaCallDepths: number[] = [];
  let depth = 0;

  // Правки текста по позициям: чистая вставка `alias+'.'` (start===end) ИЛИ замена
  // подстроки встроенного подзапроса на квалифицированную версию. Применяем с конца.
  const edits: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.type === 'punct' && t.value === '(') {
      const head = sig[i - 1];
      const headV = head ? up(head.text ?? head.value) : '';
      // Встроенный подзапрос `(ВЫБРАТЬ …)` в СЫРОМ выражении (tuple-LHS `В`, булева
      // цепочка, подзапрос в `ВЫБОР`) — у него СОБСТВЕННАЯ область видимости. Не
      // трогаем его внешним контекстом: находим парную `)`, строим внутренний
      // контекст по его `ИЗ` и рекурсивно квалифицируем тело (внешние псевдонимы —
      // как коррелированные). Перепрыгиваем токены подзапроса.
      const nextT = sig[i + 1];
      if (nextT && (nextT.type === 'keyword' || nextT.type === 'ident')
          && up(nextT.text ?? nextT.value) === 'ВЫБРАТЬ') {
        const close = matchCloseIndex(sig, i);
        if (close > i) {
          const innerStart = sig[i].pos + 1;            // сразу после `(`
          const innerEnd = sig[close].pos;              // позиция `)`
          const innerRaw = raw.slice(innerStart, innerEnd);
          const rewritten = qualifySubquerySpan(innerRaw, ctx);
          if (rewritten !== innerRaw) edits.push({ start: innerStart, end: innerEnd, text: rewritten });
          i = close;
          continue;
        }
      }
      depth++;
      if (headV === 'ЗНАЧЕНИЕ' || headV === 'ТИП') metaCallDepths.push(depth);
      continue;
    }
    if (t.type === 'punct' && t.value === ')') {
      if (metaCallDepths.length > 0 && metaCallDepths[metaCallDepths.length - 1] === depth) {
        metaCallDepths.pop();
      }
      if (depth > 0) depth--;
      continue;
    }
    if (t.type !== 'ident' && t.type !== 'keyword') continue;
    // Внутри аргументов ЗНАЧЕНИЕ(…)/ТИП(…) — имя типа метаданных, не поле.
    if (metaCallDepths.length > 0) continue;
    const word = up(t.text ?? t.value);
    // Нормализация РЕГИСТРА квалификатора-псевдонима источника к объявленному
    // написанию (`Итоги.Количество` при `… КАК ИТОГИ` → `ИТОГИ.Количество`). Делаем
    // ДО STRUCTURAL-фильтра: имя источника может совпасть со структурным словом
    // (`ИТОГИ`), но как ГОЛОВА квалифицированной ссылки (`.` следом, не продолжение
    // пути) это псевдоним, а не ключевое слово. Только при отличии регистра. (6.17)
    {
      const prevTok = sig[i - 1];
      const nextTok = sig[i + 1];
      const isPathHead = !(prevTok && prevTok.type === 'punct' && prevTok.value === '.');
      const hasDot = nextTok && nextTok.type === 'punct' && nextTok.value === '.';
      const declared = ctx.aliasSpelling.get(word);
      if (isPathHead && hasDot && (ctx.aliases.has(word) || ctx.outerAliases.has(word))
          && declared !== undefined && declared !== (t.text ?? t.value)) {
        edits.push({ start: t.pos, end: t.pos + (t.text ?? t.value).length, text: declared });
        continue;
      }
    }
    if (STRUCTURAL.has(word) || LITERALS.has(word) || PERIOD_WORDS.has(word)) continue;

    const prev = sig[i - 1];
    const next = sig[i + 1];
    const prevV = prev ? up(prev.text ?? prev.value) : '';
    const nextV = next ? (next.text ?? next.value) : '';

    // Оператор проверки типа `<expr> ССЫЛКА <Тип>`: слово ССЫЛКА перед префиксом типа
    // метаданных — это оператор, а не поле (поле `Ссылка` стоит как значение, без типа
    // следом). Пропускаем.
    if (word === 'ССЫЛКА' && next && (next.type === 'ident' || next.type === 'keyword')
        && TYPE_PREFIXES.has(up(next.text ?? next.value))) continue;

    // Голова пути после `.` — это сегмент уже-квалифицированной ссылки/типа; пропускаем.
    if (prev && prev.type === 'punct' && prev.value === '.') continue;
    // Псевдоним после `КАК` — не поле.
    if (prevV === 'КАК') continue;
    // ИМЯ ИСТОЧНИКА встроенного подзапроса (`ИЗ <Имя>`, `СОЕДИНЕНИЕ <Имя>`,
    // `ПОМЕСТИТЬ <Имя>`) — не поле (и не нуждается в префиксе): пропускаем. Покрывает
    // временные таблицы `#Имя` и односегментные имена, не попавшие в `aliases`.
    if (prevV === 'ИЗ' || prevV === 'СОЕДИНЕНИЕ' || prevV === 'ПОМЕСТИТЬ') continue;
    // Имя примитивного типа после `КАК` уже отсечено; в ТИП(СТРОКА) — пропускаем тип.
    if (PRIMITIVE_TYPES.has(word) && (prevV === 'КАК' || prevV === '(')) continue;
    // Вызов функции — имя перед `(`.
    if (nextV === '(') continue;

    // Псевдоним источника текущего ИЛИ объемлющего запроса (коррелированная ссылка) —
    // уже квалифицировано; не трогаем (нормализация регистра — выше, до STRUCTURAL).
    if (ctx.aliases.has(word) || ctx.outerAliases.has(word)) continue;

    // Голова `X.` — либо префикс типа метаданных (`Справочник.X`), либо голое
    // поле-путь (`Ссылка.Контрагент`). Для составного пути требуем подтверждения по
    // метаданным (X — реальное поле источника), иначе это может быть нераспознанный
    // префикс типа или коррелированный псевдоним из внешней области.
    const hasDotAfter = next && next.type === 'punct' && next.value === '.';
    // Голова — слово-омоним префикса типа метаданных (`Документ`, `Справочник`, …),
    // НО при этом ПОДТВЕРЖДЁННОЕ по метаданным поле источника (`СтатусыДокументовЕГАИС`
    // несёт реквизит `Документ`): это голое поле-путь (`Документ.Грузоотправитель`),
    // а не префикс типа — квалифицируем. Реальные префиксы типа (`Справочник.X` в
    // ЗНАЧЕНИЕ/ТИП/ССЫЛКА) уже отсечены выше (metaCallDepths / оператор ССЫЛКА), а
    // совпадение `Документ`/… с полем источника проверяется по составу колонок.
    // После оператора `ССЫЛКА` идёт ИМЯ ТИПА (`… ССЫЛКА Документ.ТТНИсходящаяЕГАИС`),
    // даже если слово-омоним совпадает с полем источника — не квалифицируем.
    const afterRefOp = prevV === 'ССЫЛКА';
    const isSourceField = !afterRefOp && ctx.sources.filter(s => s.fields?.has(word)).length === 1;
    if (hasDotAfter && TYPE_PREFIXES.has(word) && !isSourceField) continue; // Справочник.X — тип

    const alias = ownerAlias(ctx, t.text ?? t.value, !!hasDotAfter);
    if (alias === undefined) continue;
    edits.push({ start: t.pos, end: t.pos, text: alias + '.' });
  }
  if (edits.length === 0) return raw;
  edits.sort((a, b) => b.start - a.start);
  let out = raw;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/**
 * Множество псевдонимов выходных колонок выборки (верхний регистр). Поле секции
 * УПОРЯДОЧИТЬ/ИТОГИ, чьё имя совпадает с псевдонимом колонки, адресуется ПО
 * псевдониму (печатается голым) — конструктор 1С его НЕ квалифицирует.
 */
function selectOutputAliases(model: QueryModel): Set<string> {
  const out = new Set<string>();
  const addName = (n: string | undefined): void => { if (n) out.add(up(n)); };
  const add = (f: SelectedField): void => {
    if (f.alias) { addName(f.alias); return; }
    if (f.expression !== undefined) return; // авто `ПолеN` назначается позже
    addName(f.path.split('.').pop());
  };
  model.fields.forEach(add);
  (model.trailingFields ?? []).forEach(add);
  // Колонки проекций табличных частей — тоже выходные псевдонимы выборки.
  for (const tsf of model.tabSectionFields ?? []) {
    addName(tsf.alias ?? tsf.tsName);
    for (const c of tsf.columns ?? []) {
      if (c.kind === 'field') addName(c.alias ?? c.field);
      else addName(c.alias);
    }
    (tsf.fields ?? []).forEach((f, i) => addName(tsf.fieldAliases?.[i] ?? f));
    for (const ef of tsf.exprFields ?? []) addName(ef.alias);
  }
  return out;
}

/** Голое простое поле (без выражения), чей источник не определён парсером. */
function qualifyBareSimpleRef(
  ref: { tableId: string; path: string; qualified?: boolean; expression?: string },
  model: QueryModel,
  ctx: OwnerContext,
  selectAliases: Set<string>
): void {
  if (ref.expression !== undefined) return;
  if (ref.qualified) return;
  // tableId уже привязан к источнику — генератор сам печатает `alias.path`.
  if (ref.tableId && model.tables.some(t => t.id === ref.tableId)) return;
  // Поле адресует выходную колонку выборки (по псевдониму) — остаётся голым.
  if (selectAliases.has(up(ref.path))) return;
  const segs = ref.path.split('.');
  const head = segs[0];
  // Голова — псевдоним источника (уже квалифицировано) — не трогаем.
  if (ctx.aliases.has(up(head)) || ctx.outerAliases.has(up(head))) return;
  // Составной путь (`Поле.Подполе`) квалифицируем только при подтверждении головы
  // по метаданным.
  const alias = ownerAlias(ctx, head, segs.length > 1);
  if (alias === undefined) return;
  const aliasMap = resolveAliases(model.tables);
  const t = model.tables.find(tb => (aliasMap.get(tb.id) ?? tb.alias ?? tb.fullName) === alias);
  if (!t) return;
  ref.tableId = t.id;
  ref.qualified = true;
}

function processDocument(
  doc: QueryDocument,
  resolver: MetadataResolver | undefined,
  outerAliases: Set<string>,
  outerSources: SourceInfo[]
): void {
  for (const member of doc.members) processModel(member.model, resolver, outerAliases, outerSources);
}

function processModel(
  model: QueryModel,
  resolver: MetadataResolver | undefined,
  outerAliases: Set<string>,
  outerSources: SourceInfo[]
): void {
  const ctx = buildContext(model, resolver, outerAliases, outerSources);

  // Рекурсия в источники-подзапросы и подзапросы-условия: каждый разбирается со
  // СВОИМ контекстом владельцев, НО с псевдонимами текущего (и внешних) запросов в
  // области видимости — для распознавания коррелированных ссылок (`Регионы.Поле`).
  const innerOuter = new Set([...outerAliases, ...ctx.aliases]);
  const innerOuterSources = [...outerSources, ...ctx.sources];
  for (const t of model.tables) {
    if (t.subquery) processDocument(t.subquery, resolver, innerOuter, innerOuterSources);
  }
  for (const c of model.conditions ?? []) {
    if (c.subquery) processDocument(c.subquery, resolver, innerOuter, innerOuterSources);
  }
  for (const c of model.having ?? []) {
    if (c.subquery) processDocument(c.subquery, resolver, innerOuter, innerOuterSources);
  }

  if (ctx.sources.length === 0) return;

  // КОРРЕЛИРОВАННАЯ привязка колонки выборки подзапроса: парсер привязал голое поле к
  // ЕДИНСТВЕННОМУ источнику подзапроса (soleSource), но по метаданным этого источника
  // такого реквизита НЕТ, а у РОВНО ОДНОГО объемлющего источника он есть. Конструктор
  // 1С трактует такую ссылку как коррелированную — `СоответствиеНоменклатуры.ПАТ`, а не
  // `ИмпортируемаяПартияСАТУРН.ПАТ`. Перепривязываем поле к внешнему источнику-владельцу
  // (помечаем qualified, чтобы генератор печатал `<внешнийАлиас>.<path>`). (6.17)
  if (outerAliases.size > 0 && ctx.sources.length === 1 && ctx.sources[0].fields) {
    const innerFields = ctx.sources[0].fields;
    const rebind = (f: { tableId: string; path: string; expression?: string; qualified?: boolean }): void => {
      if (f.expression !== undefined || f.qualified) return;
      if (!f.tableId || !model.tables.some(t => t.id === f.tableId)) return;
      const head = up(f.path.split('.')[0]);
      if (innerFields.has(head)) return;
      const owners = outerSources.filter(os => os.fields?.has(head));
      if (owners.length !== 1) return;
      f.tableId = '';
      // Генератор печатает выражение-форму для коррелированной ссылки нельзя — оставляем
      // как голое поле, но префиксуем псевдонимом внешнего источника через expression.
      (f as { expression?: string }).expression = `${owners[0].alias}.${f.path}`;
      f.path = '';
    };
    model.fields.forEach(rebind);
  }

  const doField = (f: SelectedField): void => {
    if (f.expression !== undefined) f.expression = qualifyExpression(f.expression, ctx);
  };
  model.fields.forEach(doField);
  (model.trailingFields ?? []).forEach(doField);

  const doCond = (c: Condition): void => {
    if (c.custom && c.expression !== undefined && c.expression.trim()) {
      c.expression = qualifyExpression(c.expression, ctx);
    }
  };
  (model.conditions ?? []).forEach(doCond);
  (model.having ?? []).forEach(doCond);

  // Произвольные условия СОЕДИНЕНИЯ (`ПО …`): встроенный подзапрос
  // `(ВЫБРАТЬ … ИЗ …)` в сыром тексте `ПО` несёт собственную область видимости —
  // его голые поля квалифицируем владельцем подзапроса (псевдонимы соединяемых
  // источников — как коррелированные). Уже квалифицированные ссылки `Алиас.Поле`
  // самого `ПО` идемпотентно пропускаются (голова — псевдоним источника).
  for (const j of model.joins ?? []) {
    if (j.custom && j.expression !== undefined && j.expression.trim()) {
      j.expression = qualifyExpression(j.expression, ctx);
    }
    for (const jc of j.conditions ?? []) {
      if (jc.custom && jc.expression !== undefined && jc.expression.trim()) {
        jc.expression = qualifyExpression(jc.expression, ctx);
      }
    }
  }

  const doFieldRef = (fr: FieldRef): void => {
    if (fr.expression !== undefined) fr.expression = qualifyExpression(fr.expression, ctx);
  };
  if (model.grouping) {
    model.grouping.groupFields.forEach(doFieldRef);
    model.grouping.groupSets.forEach(set => set.forEach(doFieldRef));
    model.grouping.aggregates.forEach(doFieldRef);
  }

  // Секционные поля-ВЫРАЖЕНИЯ (УПОРЯДОЧИТЬ/ИТОГИ) квалифицируются здесь же (они не
  // зависят от выравнивания колонок объединения). Простые голые секционные поля
  // обрабатываются на уровне документа (qualifySectionRefs) — после выравнивания
  // псевдонимов участников, когда известны выходные колонки объединения (участник 0).
  if (model.order) {
    for (const o of model.order.fields) {
      if (o.expression !== undefined) o.expression = qualifyExpression(o.expression, ctx);
    }
  }
  if (model.totals) {
    for (const tg of model.totals.groupFields) {
      if (tg.expression !== undefined) tg.expression = qualifyExpression(tg.expression, ctx);
    }
  }
}

/**
 * Квалификация простых голых полей секций УПОРЯДОЧИТЬ/ИТОГИ на уровне документа
 * (объединения). Поле, чьё имя совпадает с псевдонимом ВЫХОДНОЙ колонки объединения
 * (участник 0), адресуется по псевдониму — остаётся голым. Иначе — привязываем к
 * источнику-владельцу. Применяется ТОЛЬКО к одиночному (не-объединённому) запросу,
 * где выходные колонки определимы локально; объединения оставляем как есть
 * (неоднозначность псевдонимов колонок участников — высокий риск регрессии).
 */
function qualifySectionRefs(
  doc: QueryDocument,
  resolver: MetadataResolver | undefined,
  outerAliases: Set<string> = new Set()
): void {
  // Рекурсия в подзапросы-источники.
  for (const qd of doc.members) {
    const inner = new Set([...outerAliases, ...buildContext(qd.model, resolver).aliases]);
    for (const t of qd.model.tables) if (t.subquery) qualifySectionRefs(t.subquery, resolver, inner);
    for (const c of qd.model.conditions ?? []) if (c.subquery) qualifySectionRefs(c.subquery, resolver, inner);
  }
  // Секции (УПОРЯДОЧИТЬ/ИТОГИ) живут на модели участника, где встретились в тексте.
  // При объединении (>1 участника) выходные псевдонимы колонок берутся у участника 0
  // и могут не совпадать с локальными — не трогаем (консервативно).
  if (doc.members.length !== 1) return;
  const model = doc.members[0].model;
  const ctx = buildContext(model, resolver, outerAliases);
  if (ctx.sources.length === 0) return;
  const selectAliases = selectOutputAliases(model);
  if (model.order) {
    for (const o of model.order.fields) {
      if (o.expression === undefined) qualifyBareSimpleRef(o, model, ctx, selectAliases);
    }
  }
  if (model.totals) {
    for (const tg of model.totals.groupFields) {
      if (tg.expression === undefined) qualifyBareSimpleRef(tg, model, ctx, selectAliases);
    }
  }
}

/**
 * Документ-уровневый пасс: квалифицирует простые голые поля секций УПОРЯДОЧИТЬ/ИТОГИ
 * (см. qualifySectionRefs). Вызывается ПОСЛЕ назначения автопсевдонимов и выравнивания
 * колонок объединения.
 */
export function qualifyBareSectionFields(doc: QueryDocument, resolver?: MetadataResolver): void {
  qualifySectionRefs(doc, resolver);
}

/**
 * Точка входа пасса: квалифицирует голые ссылки на поля во всех слотах модели
 * (поля-выражения выборки, условия ГДЕ/ИМЕЮЩИЕ, группировка, УПОРЯДОЧИТЬ/ИТОГИ).
 */
export function qualifyBareFields(model: QueryModel, resolver?: MetadataResolver): void {
  processModel(model, resolver, new Set(), []);
}
