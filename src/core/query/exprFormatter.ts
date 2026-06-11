/**
 * Форматер произвольных выражений SDBL (фаза 6.10).
 *
 * Конструктор 1С переотрисовывает произвольные выражения (условия ГДЕ/ИМЕЮЩИЕ,
 * условия соединений ПО, поля выборки) в собственном каноническом виде: дерево
 * булевых операторов (ИЛИ < И < НЕ) и оператора ВЫБОР раскладывается по строкам
 * с фиксированными отступами и скобками; ЛИСТЬЯ (сравнения, вызовы функций,
 * арифметика, МЕЖДУ a И b, ЕСТЬ [НЕ] NULL, ПОДОБНО … СПЕЦСИМВОЛ …) сохраняются
 * ДОСЛОВНО срезом исходной строки по позициям токенов.
 *
 * Самодостаточный модуль: переиспользует `tokenize` из sdblLexer (без правок
 * лексера). Распознаёт не-ключевые слова ИЛИ/НЕ/ВЫБОР/КОГДА/ТОГДА/ИНАЧЕ/КОНЕЦ/ЕСТЬ
 * по `.value.toUpperCase()`.
 */
import { tokenize, type Token } from './sdblLexer';

export type ExprSlot = 'where' | 'having' | 'join' | 'select';

const TAB = '\t';

// --- AST --------------------------------------------------------------------

type Node =
  | { kind: 'or'; operands: Node[] }
  | { kind: 'and'; operands: Node[] }
  | { kind: 'not'; child: Node }
  | { kind: 'group'; child: Node } // скобочная группа верхнего уровня
  | { kind: 'case'; clauses: CaseClause[]; elseExpr?: Node | null; elseText?: string }
  | { kind: 'leaf'; text: string };

interface CaseClause {
  // условие после КОГДА (булев слот)
  whenNode: Node;
  // значение после ТОГДА (value-слот): либо вложенный ВЫБОР, либо дословный текст
  thenNode: Node;
}

// --- helpers для распознавания слов-операторов ------------------------------

function up(t: Token): string {
  return t.value.toUpperCase();
}
function isWord(t: Token, w: string): boolean {
  return (t.type === 'ident' || t.type === 'keyword') && up(t) === w;
}
function isOr(t: Token): boolean {
  return isWord(t, 'ИЛИ');
}
function isAnd(t: Token): boolean {
  return t.type === 'keyword' && t.value === 'И';
}
function isNot(t: Token): boolean {
  return isWord(t, 'НЕ');
}
function isCase(t: Token): boolean {
  return isWord(t, 'ВЫБОР');
}
function isWhen(t: Token): boolean {
  return isWord(t, 'КОГДА');
}
function isThen(t: Token): boolean {
  return isWord(t, 'ТОГДА');
}
function isElse(t: Token): boolean {
  return isWord(t, 'ИНАЧЕ');
}
function isEnd(t: Token): boolean {
  return isWord(t, 'КОНЕЦ');
}

// --- Parser -----------------------------------------------------------------

class Parser {
  private toks: Token[];
  private raw: string;
  private i = 0;

  constructor(raw: string) {
    this.raw = raw;
    // исключаем eof из рабочего набора (но позиция eof нужна для среза «до конца»)
    this.toks = tokenize(raw);
  }

  private peek(): Token {
    return this.toks[this.i];
  }
  private atEof(): boolean {
    return this.peek().type === 'eof';
  }

  /** Срез исходной строки [from, to) с обрезкой хвостовых пробелов. */
  private slice(from: number, to: number): string {
    return this.raw.slice(from, to).replace(/\s+$/u, '');
  }

  parse(): Node {
    const node = this.parseOr();
    return node;
  }

  /**
   * Дословный хвост: всё от КОНЦА последнего потреблённого токена до конца строки
   * (включая исходные пробелы/переносы перед хвостом). '' если хвоста нет.
   * Сохраняет, например, ошибочно захваченные парсером SDBL `\n\nУПОРЯДОЧИТЬ ПО …`.
   */
  tail(): string {
    if (this.peek().type === 'eof') return '';
    // конец последнего потреблённого токена
    const prev = this.i > 0 ? this.toks[this.i - 1] : undefined;
    const from = prev ? prev.pos + prev.text.length : this.peek().pos;
    return this.raw.slice(from);
  }

  // ИЛИ — низший приоритет
  private parseOr(): Node {
    const first = this.parseAnd();
    const operands = [first];
    while (!this.atEof() && isOr(this.peek())) {
      this.i++; // съесть ИЛИ
      operands.push(this.parseAnd());
    }
    return operands.length === 1 ? first : { kind: 'or', operands };
  }

  private parseAnd(): Node {
    const first = this.parseNot();
    const operands = [first];
    while (!this.atEof() && isAnd(this.peek())) {
      this.i++; // съесть И
      operands.push(this.parseNot());
    }
    return operands.length === 1 ? first : { kind: 'and', operands };
  }

  private parseNot(): Node {
    if (!this.atEof() && isNot(this.peek())) {
      // НЕ как булев префикс ТОЛЬКО если за ним идёт структурный примитив
      // (ВЫБОР, скобочная группа или булево подвыражение). Иначе НЕ — часть листа
      // (НЕ поле, НЕ &Параметр), и лист поглотит его дословно.
      if (this.notIsStructural()) {
        this.i++; // съесть НЕ
        return { kind: 'not', child: this.parseNot() };
      }
    }
    return this.parsePrimary();
  }

  /**
   * Является ли текущее `НЕ` структурным булевым отрицанием. Структурно — если
   * за ним ВЫБОР или открывающая скобка, чьё содержимое содержит верхнеуровневый
   * И/ИЛИ (булева группа). Иначе `НЕ` — унарный оператор внутри листа (`НЕ a.Флаг`,
   * `НЕ a.X В (…)`), и обрабатывается листом дословно.
   */
  private notIsStructural(): boolean {
    const next = this.toks[this.i + 1];
    if (!next) return false;
    if (isCase(next)) return true;
    if (next.type === 'punct' && next.value === '(') {
      return this.parenHasTopBoolean(this.i + 1);
    }
    return false;
  }

  /** Содержит ли скобочная группа, открытая на индексе `open`, верхнеур. И/ИЛИ. */
  private parenHasTopBoolean(open: number): boolean {
    let depth = 0;
    for (let k = open; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.type === 'eof') break;
      if (t.type === 'punct' && t.value === '(') {
        depth++;
        continue;
      }
      if (t.type === 'punct' && t.value === ')') {
        depth--;
        if (depth === 0) break;
        continue;
      }
      if (depth === 1 && (isAnd(t) || isOr(t))) return true;
    }
    return false;
  }

  private parsePrimary(): Node {
    const t = this.peek();
    // ВЫБОР … КОНЕЦ
    if (isCase(t)) {
      return this.parseCase();
    }
    // скобочная группа верхнего уровня — раскрываем в под-дерево ТОЛЬКО если
    // содержит верхнеуровневый булев И/ИЛИ или ВЫБОР; иначе это листовая скобка
    // (вызов/группировка арифметики) — поглощается листом дословно.
    if (t.type === 'punct' && t.value === '(' && this.parenIsStructuralGroup(this.i)) {
      this.i++; // съесть (
      const inner = this.parseOr();
      // закрывающая )
      if (!this.atEof() && this.peek().type === 'punct' && this.peek().value === ')') {
        this.i++;
      }
      return { kind: 'group', child: inner };
    }
    return this.parseLeaf();
  }

  /** Скобка структурна, если содержит верхнеур. И/ИЛИ или ВЫБОР. */
  private parenIsStructuralGroup(open: number): boolean {
    let depth = 0;
    for (let k = open; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.type === 'eof') break;
      if (t.type === 'punct' && t.value === '(') {
        depth++;
        continue;
      }
      if (t.type === 'punct' && t.value === ')') {
        depth--;
        if (depth === 0) break;
        continue;
      }
      if (depth === 1 && (isAnd(t) || isOr(t) || isCase(t))) return true;
    }
    return false;
  }

  /**
   * Лист: диапазон токенов до следующего верхнеуровневого булева И/ИЛИ, конца,
   * закрывающей скобки или КОГДА/ТОГДА/ИНАЧЕ/КОНЕЦ. Поглощает внутренние скобки,
   * вызовы, МЕЖДУ a И b (И после МЕЖДУ — не разделитель), ЕСТЬ [НЕ] NULL, ПОДОБНО.
   */
  private parseLeaf(): Node {
    const startTok = this.peek();
    const from = startTok.pos;
    let to = from;
    let depth = 0;
    let betweenPending = 0; // сколько И ждём «съесть» внутри МЕЖДУ

    while (!this.atEof()) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '(') {
        depth++;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (t.type === 'punct' && t.value === ')') {
        if (depth === 0) break; // закрывающая чужой группы — стоп
        depth--;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (depth === 0) {
        // границы листа на верхнем уровне
        if (isOr(t)) break;
        if (isAnd(t)) {
          if (betweenPending > 0) {
            betweenPending--; // это И из МЕЖДУ a И b
          } else {
            break;
          }
        }
        if (isThen(t) || isElse(t) || isEnd(t) || isWhen(t)) break;
        if (isWord(t, 'МЕЖДУ')) betweenPending++;
      }
      to = t.pos + t.value.length;
      this.i++;
    }
    return { kind: 'leaf', text: this.raw.slice(from, to).replace(/\s+$/u, '') };
  }

  private parseCase(): Node {
    this.i++; // съесть ВЫБОР
    const clauses: CaseClause[] = [];
    let elseNode: Node | null = null;
    while (!this.atEof()) {
      const t = this.peek();
      if (isWhen(t)) {
        this.i++; // КОГДА
        const whenNode = this.parseOr(); // булев слот
        // ТОГДА
        if (!this.atEof() && isThen(this.peek())) this.i++;
        const thenNode = this.parseValue(); // value-слот
        clauses.push({ whenNode, thenNode });
        continue;
      }
      if (isElse(t)) {
        this.i++; // ИНАЧЕ
        elseNode = this.parseValue();
        continue;
      }
      if (isEnd(t)) {
        this.i++; // КОНЕЦ
        break;
      }
      break;
    }
    return { kind: 'case', clauses, elseExpr: elseNode };
  }

  /**
   * Value-слот (после ТОГДА/ИНАЧЕ или поле выборки): либо вложенный ВЫБОР, либо
   * дословный текст до следующего КОГДА/ИНАЧЕ/КОНЕЦ верхнего уровня.
   */
  private parseValue(): Node {
    if (!this.atEof() && isCase(this.peek())) {
      return this.parseCase();
    }
    const startTok = this.peek();
    const from = startTok.pos;
    let to = from;
    let depth = 0;
    while (!this.atEof()) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '(') {
        depth++;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (t.type === 'punct' && t.value === ')') {
        if (depth === 0) break;
        depth--;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (depth === 0 && (isWhen(t) || isElse(t) || isEnd(t))) break;
      to = t.pos + t.value.length;
      this.i++;
    }
    return { kind: 'leaf', text: this.raw.slice(from, to).replace(/\s+$/u, '') };
  }
}

// --- needsFormatting --------------------------------------------------------

/** Содержит ли дерево узел OR или CASE (структуру, требующую переотрисовки). */
function treeHasStructure(node: Node): boolean {
  switch (node.kind) {
    case 'or':
      return true;
    case 'case':
      return true;
    case 'and':
      return node.operands.some(treeHasStructure);
    case 'not':
      return treeHasStructure(node.child);
    case 'group':
      return treeHasStructure(node.child);
    case 'leaf':
      return false;
  }
}

/**
 * Требует ли выражение форматирования. Консервативно: true ТОЛЬКО если в
 * структурном дереве есть OR или CASE. Чистый лист, простая И-цепочка без OR/CASE,
 * простые скобки без ИЛИ/ВЫБОР → false (чтобы принятые запросы остались байт-в-байт).
 */
export function needsFormatting(raw: string): boolean {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  let tree: Node;
  try {
    tree = new Parser(trimmed).parse();
  } catch {
    return false;
  }
  return treeHasStructure(tree);
}

// --- Printer (boolean) ------------------------------------------------------

/**
 * Рендер булева дерева. Возвращает массив строк; первая строка БЕЗ ведущего
 * отступа (отступ первой строки добавляет родитель/вызывающий через `firstPrefix`
 * и базовый отступ). Остальные строки — с абсолютными табами.
 *
 * `ind` — число табов первой строки узла; `andCont` — табы строк «И x»; `orLvl` —
 * глубина вложения OR. `cont` — контентный отступ секции (для CASE E).
 */
interface RenderCtx {
  cont: number; // C — контентный отступ секции
  caseBoolean: boolean; // CASE в этой позиции — булев слот (E=C+1) или value (E=C)
}

function tabs(n: number): string {
  return TAB.repeat(n);
}

function renderBool(
  node: Node,
  ind: number,
  andCont: number,
  orLvl: number,
  ctx: RenderCtx,
  caseE: number = ind + 1
): string[] {
  switch (node.kind) {
    case 'or': {
      const orDelta = orLvl === 0 ? 2 : 1;
      const iliInd = ind + orDelta;
      const childAnd = iliInd + 1;
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          // operand0 печатается на отступе ind; CASE-операнд → E=ind.
          const sub = renderBool(op, ind, childAnd, orLvl + 1, ctx, ind);
          sub[0] = '(' + sub[0];
          lines.push(...sub);
        } else {
          // operandK на отступе iliInd; CASE-операнд → E=iliInd.
          const sub = renderBool(op, iliInd, childAnd, orLvl + 1, ctx, iliInd);
          sub[0] = tabs(iliInd) + 'ИЛИ ' + sub[0];
          lines.push(...sub);
        }
      });
      lines[lines.length - 1] += ')';
      return lines;
    }
    case 'and': {
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderBool(op, ind, andCont, orLvl, ctx, caseE));
        } else {
          // operandK на отступе andCont; CASE-операнд → E=andCont+1.
          const sub = renderBool(op, andCont, andCont + 1, orLvl, ctx, andCont + 1);
          sub[0] = tabs(andCont) + 'И ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'not': {
      const sub = renderBool(node.child, ind, andCont, orLvl, ctx, caseE);
      sub[0] = 'НЕ ' + sub[0];
      return sub;
    }
    case 'group': {
      const child = node.child;
      if (child.kind === 'or') {
        return renderBool(child, ind, andCont, orLvl, ctx, caseE);
      }
      const sub = renderBool(child, ind, andCont, orLvl, ctx, caseE);
      sub[0] = '(' + sub[0];
      sub[sub.length - 1] += ')';
      return sub;
    }
    case 'case': {
      // E задаётся вызывающим (caseE); печатаем с явным E.
      return renderCaseE(node, caseE, ctx);
    }
    case 'leaf': {
      return [node.text];
    }
  }
}

// --- Printer (КОГДА-condition) ----------------------------------------------

/**
 * Условие после КОГДА (булев слот). Особенности конструктора:
 *   - верхняя OR/группа НЕ оборачивается в скобки (границы задаёт КОГДА…ТОГДА);
 *   - продолжения (`ИЛИ x` / `И x`) — на отступе whenInd + 2;
 *   - первый операнд печатается инлайн после `КОГДА ` (первая строка без отступа).
 */
function renderWhenCondition(node: Node, whenInd: number, ctx: RenderCtx): string[] {
  const contInd = whenInd + 2;
  switch (node.kind) {
    case 'group':
      return renderWhenCondition(node.child, whenInd, ctx);
    case 'or': {
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderBool(op, whenInd, contInd + 1, 1, ctx));
        } else {
          const sub = renderBool(op, contInd, contInd + 1, 1, ctx);
          sub[0] = tabs(contInd) + 'ИЛИ ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'and': {
      // OR-конъюнкты внутри КОГДА-условия используют orDelta=1 (orLvl=1).
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderBool(op, whenInd, contInd, 1, ctx));
        } else {
          const sub = renderBool(op, contInd, contInd + 1, 1, ctx);
          sub[0] = tabs(contInd) + 'И ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    default:
      return renderBool(node, whenInd, contInd, 1, ctx);
  }
}

// --- Printer (CASE) ---------------------------------------------------------

/**
 * Рендер ВЫБОР. `cursorInd` — табы строки `ВЫБОР` (она печатается инлайн родителем,
 * поэтому возвращаемая первая строка = 'ВЫБОР' без отступа). `boolean` — слот
 * (true → E=C+1, false → E=C). Возвращает строки; первая — 'ВЫБОР'.
 */
function renderCase(node: Node & { kind: 'case' }, cursorInd: number, ctx: RenderCtx, boolean: boolean): string[] {
  // E — отступ КОНЕЦ. В value-слоте E=cursorInd, в булевом E=cursorInd+1.
  return renderCaseE(node, boolean ? cursorInd + 1 : cursorInd, ctx);
}

/**
 * Рендер ВЫБОР с явным отступом КОНЕЦ = E. Раскладка:
 *   КОГДА=E+1, ТОГДА=E+2, ИНАЧЕ=E+1, КОНЕЦ=E. Первая строка = 'ВЫБОР' (инлайн).
 * Вложенный ВЫБОР после ТОГДА@t/ИНАЧЕ@t → его E = t+1 (value-слот).
 */
/** Текст value-узла (после ТОГДА/ИНАЧЕ). parseValue даёт только leaf или case. */
function valueText(node: Node): string {
  return node.kind === 'leaf' ? node.text : '';
}

function renderCaseE(node: Node & { kind: 'case' }, E: number, ctx: RenderCtx): string[] {
  const lines: string[] = ['ВЫБОР'];
  for (const cl of node.clauses) {
    const whenInd = E + 1;
    const whenLines = renderWhenCondition(cl.whenNode, whenInd, ctx);
    whenLines[0] = tabs(whenInd) + 'КОГДА ' + whenLines[0];
    lines.push(...whenLines);
    const thenInd = E + 2;
    if (cl.thenNode.kind === 'case') {
      const sub = renderCaseE(cl.thenNode, thenInd + 1, ctx);
      sub[0] = tabs(thenInd) + 'ТОГДА ' + sub[0];
      lines.push(...sub);
    } else {
      lines.push(tabs(thenInd) + 'ТОГДА ' + valueText(cl.thenNode));
    }
  }
  if (node.elseExpr) {
    const elseInd = E + 1;
    if (node.elseExpr.kind === 'case') {
      const sub = renderCaseE(node.elseExpr, elseInd + 1, ctx);
      sub[0] = tabs(elseInd) + 'ИНАЧЕ ' + sub[0];
      lines.push(...sub);
    } else {
      lines.push(tabs(elseInd) + 'ИНАЧЕ ' + valueText(node.elseExpr));
    }
  }
  lines.push(tabs(E) + 'КОНЕЦ');
  return lines;
}

// --- public formatExpression ------------------------------------------------

/**
 * Печатает выражение в каноническом виде конструктора для указанного слота.
 * Первая строка БЕЗ ведущего отступа (его добавляет вызывающий, прибавляя базовый
 * таб слота); продолжения — с абсолютными табами.
 */
export function formatExpression(raw: string, slot: ExprSlot): string {
  const trimmed = raw.trim();
  const parser = new Parser(trimmed);
  const tree = parser.parse();

  // Дословный хвост: то, что парсер не потребил (например, ошибочно захваченные
  // парсером SDBL `\n\nУПОРЯДОЧИТЬ ПО …` / `\nИТОГИ ПО …` после КОНЕЦ/скобки).
  // Сохраняем как есть (с исходными пробелами), чтобы не терять текст.
  const tail = parser.tail();

  let body: string;
  if (slot === 'where' || slot === 'having') {
    const ctx: RenderCtx = { cont: 1, caseBoolean: true };
    if (tree.kind === 'case') {
      body = renderCase(tree, ctx.cont, ctx, true).join('\n');
    } else {
      // ИМЕЮЩИЕ: верхний OR использует orDelta=1 (ИЛИ на отступе 2), в отличие от
      // ГДЕ (orDelta=2, ИЛИ на 3) — эмулируем стартовым orLvl=1.
      const startOrLvl = slot === 'having' ? 1 : 0;
      body = renderBool(tree, 1, 1, startOrLvl, ctx).join('\n');
    }
  } else if (slot === 'select') {
    const ctx: RenderCtx = { cont: 1, caseBoolean: false };
    if (tree.kind === 'case') {
      body = renderCase(tree, ctx.cont, ctx, false).join('\n');
    } else {
      // Поле выборки = булево выражение (OR/AND/НЕ): value-слот, orDelta=1, без
      // оборачивающих скобок. operand0 @ base 1, ИЛИ @ base+1.
      body = renderSelectBool(tree, 1, 1, 0, ctx).join('\n');
    }
  } else {
    // join
    const ctx: RenderCtx = { cont: 2, caseBoolean: true };
    body = renderJoin(tree, ctx);
  }

  return body + tail;
}

/**
 * Рендер булева выражения в value-слоте поля выборки. Отличия от ГДЕ:
 *   - OR не оборачивается в скобки;
 *   - orDelta = 1 (а не 2): operand0 @ ind, строки `ИЛИ x` @ ind+1.
 * Листья и НЕ — как обычно (НЕ инлайн).
 */
function renderSelectBool(node: Node, ind: number, andCont: number, orLvl: number, ctx: RenderCtx): string[] {
  switch (node.kind) {
    case 'or': {
      const iliInd = ind + 1;
      const childAnd = iliInd + 1;
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderSelectBool(op, ind, childAnd, orLvl + 1, ctx));
        } else {
          const sub = renderSelectBool(op, iliInd, childAnd, orLvl + 1, ctx);
          sub[0] = tabs(iliInd) + 'ИЛИ ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'and': {
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderSelectBool(op, ind, andCont, orLvl, ctx));
        } else {
          const sub = renderSelectBool(op, andCont, andCont + 1, orLvl, ctx);
          sub[0] = tabs(andCont) + 'И ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'not': {
      const sub = renderSelectBool(node.child, ind, andCont, orLvl, ctx);
      sub[0] = 'НЕ ' + sub[0];
      return sub;
    }
    case 'group': {
      const sub = renderSelectBool(node.child, ind, andCont, orLvl, ctx);
      sub[0] = '(' + sub[0];
      sub[sub.length - 1] += ')';
      return sub;
    }
    case 'case':
      return renderCase(node, ind, ctx, false);
    case 'leaf':
      return [node.text];
  }
}

// --- Printer (join ПО) ------------------------------------------------------

/**
 * Условие соединения ПО (составное / со структурой). База — контентный отступ 2.
 * Конструктор трактует условие как И-цепочку конъюнктов и переотрисовывает только
 * отступы/переносы; текст каждого конъюнкта (в т.ч. наличие/отсутствие скобок)
 * сохраняется ДОСЛОВНО из исходника. Первый конъюнкт — на строке `ПО ` (вызывающий
 * уже напечатал `ПО `); каждый следующий — `И <конъюнкт>` на отступе base+1.
 *   - конъюнкт-лист → дословный текст (скобки из исходника НЕ добавляются и НЕ
 *     снимаются);
 *   - конъюнкт с OR/CASE → структурная переотрисовка (ИЛИ на отступе +1).
 */
function renderJoin(tree: Node, ctx: RenderCtx): string {
  const base = ctx.cont; // 2
  const conjuncts: Node[] = tree.kind === 'and' ? tree.operands : [tree];
  const lines: string[] = [];
  conjuncts.forEach((c, k) => {
    const ind = k === 0 ? base : base + 1;
    // Первый конъюнкт сидит на base — его OR использует orDelta=2 (ИЛИ на base+2);
    // OR внутри последующего И-конъюнкта — orDelta=1 (ИЛИ на ind+1).
    const orLvl = k === 0 ? 0 : 1;
    const sub = renderJoinConjunct(c, ind, ctx, orLvl);
    if (k > 0) sub[0] = tabs(ind) + 'И ' + sub[0];
    lines.push(...sub);
  });
  return lines.join('\n');
}

/**
 * Один конъюнкт условия ПО. Лист — дословно (скобки как в исходнике). Структурная
 * скобочная группа с OR — раскрывается с сохранением внешних скобок и отступом
 * ИЛИ = ind+1. CASE — раскладка булева слота.
 */
function renderJoinConjunct(node: Node, ind: number, ctx: RenderCtx, orLvl: number): string[] {
  switch (node.kind) {
    case 'leaf':
      return node.text.split('\n');
    case 'case':
      return renderCase(node, ind, ctx, true);
    case 'not': {
      const sub = renderJoinConjunct(node.child, ind, ctx, orLvl);
      sub[0] = 'НЕ ' + sub[0];
      return sub;
    }
    case 'group': {
      // Скобочная группа в исходнике (например `(a ИЛИ b)`). Если содержимое — OR,
      // оно само оборачивается в (…) — не дублируем скобки.
      const child = node.child;
      if (child.kind === 'or') {
        return renderBool(child, ind, ind + 1, orLvl, ctx);
      }
      if (child.kind === 'case') {
        // `(ВЫБОР … КОНЕЦ)` в ПО: КОНЕЦ на отступе ind (value-слот), внешние скобки.
        const sub = renderCaseE(child, ind, ctx);
        sub[0] = '(' + sub[0];
        sub[sub.length - 1] += ')';
        return sub;
      }
      const sub = renderBool(child, ind, ind + 1, orLvl, ctx);
      sub[0] = '(' + sub[0];
      sub[sub.length - 1] += ')';
      return sub;
    }
    case 'or':
      return renderBool(node, ind, ind + 1, orLvl, ctx);
    case 'and':
      return renderBool(node, ind, ind + 1, orLvl, ctx);
    default:
      return [''];
  }
}
