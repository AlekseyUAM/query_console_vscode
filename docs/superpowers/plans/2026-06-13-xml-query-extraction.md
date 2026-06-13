# XML `<query>` Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run extract` additionally pull `<query>…</query>` queries from СКД XML templates under `CONFIG_DIR/Reports/`, XML-unescaping their entities so the text matches `.bsl`-extracted queries.

**Architecture:** Two new pure functions in `src/cli/extractQueries.ts` — `unescapeXmlEntities` (decode XML entities) and `extractQueriesFromXml` (find `<query>` blocks, unescape, filter by query keyword) — plus a second walk in `run()` over `Reports/**/*.xml` that shares the existing dedup set and output-naming scheme.

**Tech Stack:** TypeScript, Node `fs`/`path`, Vitest, esbuild bundling (`npm run extract`).

**Reference spec:** `docs/superpowers/specs/2026-06-13-xml-query-extraction-design.md`

---

### Task 1: `unescapeXmlEntities`

**Files:**
- Modify: `src/cli/extractQueries.ts` (add exported function near top, after imports)
- Test: `test/unit/extractQueries.test.ts` (add new `describe` block)

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/extractQueries.test.ts`. First update the import on line 2 to include the new symbols:

```ts
import {
  extractQueryStrings,
  unescapeXmlEntities,
  extractQueriesFromXml,
} from '../../src/cli/extractQueries';
```

Then append this `describe` block to the file:

```ts
describe('unescapeXmlEntities', () => {
  it('декодирует основные сущности', () => {
    expect(unescapeXmlEntities('a &lt; b &gt; c &amp; d')).toBe('a < b > c & d');
  });

  it('декодирует &quot; и &apos;', () => {
    expect(unescapeXmlEntities('&quot;x&quot; &apos;y&apos;')).toBe('"x" \'y\'');
  });

  it('приоритет слева направо: &amp;lt; → литерал &lt;, а не <', () => {
    expect(unescapeXmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('декодирует числовые сущности (dec и hex)', () => {
    expect(unescapeXmlEntities('&#1041;&#x42E;')).toBe('БЮ');
  });

  it('строку без сущностей возвращает без изменений', () => {
    expect(unescapeXmlEntities('ВЫБРАТЬ Поле')).toBe('ВЫБРАТЬ Поле');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/extractQueries.test.ts`
Expected: FAIL — `unescapeXmlEntities is not a function` (or import error).

- [ ] **Step 3: Implement `unescapeXmlEntities`**

In `src/cli/extractQueries.ts`, after the `import` lines and before `export interface ExtractedQuery`, add:

```ts
const NAMED_XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Декодирует XML-сущности в тексте за один проход слева направо.
 * Обрабатывает именованные (&lt; &gt; &amp; &quot; &apos;) и числовые
 * (&#nn; / &#xHH;) сущности. Проход слева направо корректно разбирает
 * `&amp;lt;` → литерал `&lt;` (а не `<`).
 */
export function unescapeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (_m, ent: string) => {
    if (ent[0] === '#') {
      const code =
        ent[1] === 'x' || ent[1] === 'X'
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return NAMED_XML_ENTITIES[ent];
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/extractQueries.test.ts`
Expected: PASS (the new `unescapeXmlEntities` block passes; `extractQueriesFromXml` tests are added in Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/cli/extractQueries.ts test/unit/extractQueries.test.ts
git commit -m "feat(extract): unescapeXmlEntities для декодирования XML-сущностей"
```

---

### Task 2: `extractQueriesFromXml`

**Files:**
- Modify: `src/cli/extractQueries.ts` (add exported function after `extractQueryStrings`)
- Test: `test/unit/extractQueries.test.ts` (add new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to `test/unit/extractQueries.test.ts`:

```ts
describe('extractQueriesFromXml', () => {
  it('извлекает один <query>, декодируя сущности', () => {
    const xml = '<dataSet><query>ВЫБРАТЬ Т.Поле\nГДЕ Т.А &lt;&gt; &amp;П</query></dataSet>';
    const res = extractQueriesFromXml(xml);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('ВЫБРАТЬ Т.Поле\nГДЕ Т.А <> &П');
  });

  it('извлекает несколько <query> с корректным lineStart', () => {
    const xml = [
      '<schema>',
      '  <query>ВЫБРАТЬ Поле1</query>',
      '  <other>x</other>',
      '  <query>ВЫБРАТЬ Поле2</query>',
      '</schema>',
    ].join('\n');
    const res = extractQueriesFromXml(xml);
    expect(res).toHaveLength(2);
    expect(res[0].text).toBe('ВЫБРАТЬ Поле1');
    expect(res[0].lineStart).toBe(2);
    expect(res[1].text).toBe('ВЫБРАТЬ Поле2');
    expect(res[1].lineStart).toBe(4);
  });

  it('игнорирует <query>, не начинающийся с ключевого слова', () => {
    const xml = '<query>не запрос</query>';
    expect(extractQueriesFromXml(xml)).toHaveLength(0);
  });

  it('игнорирует прочие теги (dataSource и т.п.)', () => {
    const xml = '<dataSource>ИсточникДанных1</dataSource>';
    expect(extractQueriesFromXml(xml)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/extractQueries.test.ts`
Expected: FAIL — `extractQueriesFromXml is not a function`.

- [ ] **Step 3: Implement `extractQueriesFromXml`**

In `src/cli/extractQueries.ts`, immediately after the `extractQueryStrings` function (before the `// ---- CLI ----` comment), add:

```ts
/**
 * Извлекает запросы из XML-макета СКД: каждый блок <query>…</query>.
 * Безопасно регэкспом — внутри текста запроса любой `<` экранирован как
 * `&lt;`, поэтому `</query>` в теле встретиться не может. Тело декодируется
 * из XML-сущностей и фильтруется по тому же критерию, что и BSL-литералы
 * (начинается с ВЫБРАТЬ/УНИЧТОЖИТЬ). Тело отдаётся дословно (без trim).
 */
export function extractQueriesFromXml(xmlSource: string): ExtractedQuery[] {
  const result: ExtractedQuery[] = [];
  const re = /<query>([\s\S]*?)<\/query>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xmlSource)) !== null) {
    const lineStart = xmlSource.slice(0, m.index).split('\n').length;
    const text = unescapeXmlEntities(m[1]);
    if (startsWithQueryKeyword(text)) {
      result.push({ text, lineStart });
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/extractQueries.test.ts`
Expected: PASS (all `extractQueriesFromXml` and `unescapeXmlEntities` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/cli/extractQueries.ts test/unit/extractQueries.test.ts
git commit -m "feat(extract): extractQueriesFromXml — <query> из XML-макетов СКД"
```

---

### Task 3: Round-trip test against the real fixture

**Files:**
- Test: `test/unit/extractQueries.test.ts` (add one `it` to the `extractQueriesFromXml` block or a new block)

- [ ] **Step 1: Write the failing test**

Append to `test/unit/extractQueries.test.ts`. Add `fs`/`path` imports at the top if not present:

```ts
import * as fs from 'fs';
import * as path from 'path';
```

Then the test:

```ts
describe('extractQueriesFromXml — реальный макет', () => {
  it('round-trip на Reports/Задачи Template.xml: сущности декодированы', () => {
    const file = path.resolve(
      __dirname,
      '../../src/cf/Reports/Задачи/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml',
    );
    const xml = fs.readFileSync(file, 'utf8');
    const res = extractQueriesFromXml(xml);
    expect(res.length).toBeGreaterThanOrEqual(1);
    const q = res[0].text;
    expect(q.startsWith('ВЫБРАТЬ РАЗРЕШЕННЫЕ')).toBe(true);
    // Сущности декодированы обратно в символы:
    expect(q).toContain('<>');
    expect(q).toContain('>=');
    expect(q).toContain('&КрайнийСрок');
    // В тексте не остаётся сырых XML-сущностей:
    expect(q).not.toContain('&lt;');
    expect(q).not.toContain('&amp;');
    expect(q).not.toContain('&gt;');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (fixture already correct)**

Run: `npx vitest run test/unit/extractQueries.test.ts`
Expected: PASS — `extractQueriesFromXml` was implemented in Task 2; this test confirms it works on the real file. (If it fails, the implementation has a bug — fix before continuing.)

- [ ] **Step 3: Commit**

```bash
git add test/unit/extractQueries.test.ts
git commit -m "test(extract): round-trip XML <query> на реальном макете Задачи"
```

---

### Task 4: Wire XML walk into `run()`

**Files:**
- Modify: `src/cli/extractQueries.ts` — `run()` (currently `src/cli/extractQueries.ts:123-160`)

- [ ] **Step 1: Add the Reports XML walk in `run()`**

In `src/cli/extractQueries.ts`, the current `.bsl` loop ends and then logs. Locate this block (the `.bsl` walk + per-file loop, ending with the `console.log`):

```ts
  const files = walk(cfRoot, '.bsl').sort();
  const seen = new Set<string>();
  let found = 0;
  let uniqueWritten = 0;

  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const queries = extractQueryStrings(source);
    const rel = path.relative(cfRoot, file).split(path.sep).join('-');
    queries.forEach((q, idx) => {
      found++;
      if (seen.has(q.text)) return;
      seen.add(q.text);
      uniqueWritten++;
      const outFile = path.join(outDir, `${rel}_${idx + 1}.txt`);
      fs.writeFileSync(outFile, q.text, 'utf8');
    });
  }

  console.log(`found=${found} uniqueWritten=${uniqueWritten}`);
```

Replace it with (adds the XML walk over `Reports/` sharing `seen`/`found`/`uniqueWritten`):

```ts
  const seen = new Set<string>();
  let found = 0;
  let uniqueWritten = 0;

  const writeQuery = (q: ExtractedQuery, rel: string, idx: number): void => {
    found++;
    if (seen.has(q.text)) return;
    seen.add(q.text);
    uniqueWritten++;
    const outFile = path.join(outDir, `${rel}_${idx + 1}.txt`);
    fs.writeFileSync(outFile, q.text, 'utf8');
  };

  // .bsl: код модулей по всему CONFIG_DIR.
  const bslFiles = walk(cfRoot, '.bsl').sort();
  for (const file of bslFiles) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(cfRoot, file).split(path.sep).join('-');
    extractQueryStrings(source).forEach((q, idx) => writeQuery(q, rel, idx));
  }

  // .xml: макеты СКД — только поддерево Reports/ (см. spec 2026-06-13).
  const reportsDir = path.join(cfRoot, 'Reports');
  if (fs.existsSync(reportsDir)) {
    const xmlFiles = walk(reportsDir, '.xml').sort();
    for (const file of xmlFiles) {
      let source: string;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(cfRoot, file).split(path.sep).join('-');
      extractQueriesFromXml(source).forEach((q, idx) => writeQuery(q, rel, idx));
    }
  }

  console.log(`found=${found} uniqueWritten=${uniqueWritten}`);
```

- [ ] **Step 2: Verify the unit suite still passes**

Run: `npm run test:unit`
Expected: PASS — full unit suite green (no regression; corpus gate fixtures unaffected since they read from `test/fixtures/corpus`, not `tmp/`).

- [ ] **Step 3: Smoke-test the real CLI against the repo config**

Run:
```bash
npm run extract
ls tmp/query1c/ | grep -i 'Reports' | head
```
Expected: `found=… uniqueWritten=…` printed, and at least one `Reports-…_1.txt` file present in `tmp/query1c/`. Spot-check one:
```bash
grep -l 'ВЫБРАТЬ РАЗРЕШЕННЫЕ' tmp/query1c/Reports-Задачи-* 2>/dev/null | head -1 | xargs head -3
```
Expected: decoded query text (contains `<>`, `&КрайнийСрок`; no `&lt;`/`&amp;`).

- [ ] **Step 4: Commit**

```bash
git add src/cli/extractQueries.ts
git commit -m "feat(extract): сканировать <query> в Reports/**/*.xml в run()"
```

---

### Task 5: Document Step 4

**Files:**
- Modify: `docs/corpus-testing.md` (Step 4 description, around line 70-71)

- [ ] **Step 1: Add the doc note**

In `docs/corpus-testing.md`, find this bullet under Шаг 4:

```markdown
- `extract` сканирует `*.bsl` в `CONFIG_DIR`, выделяет литералы запросов
  («ВЫБРАТЬ …») и складывает их в `QUERY_CORPUS_DIR`.
```

Replace it with:

```markdown
- `extract` сканирует `*.bsl` в `CONFIG_DIR`, выделяет литералы запросов
  («ВЫБРАТЬ …») и складывает их в `QUERY_CORPUS_DIR`. Дополнительно извлекает
  запросы из элемента `<query>` XML-макетов СКД в `Reports/**/*.xml`
  (с декодированием XML-сущностей `&lt;`/`&gt;`/`&amp;`).
```

- [ ] **Step 2: Commit**

```bash
git add docs/corpus-testing.md
git commit -m "docs(corpus-testing): отметить извлечение <query> из Reports XML в Шаге 4"
```

---

## Notes for the implementer

- **Do NOT run `npm run corpus:snapshot`.** That re-bakes the committed gate. Enriching the live corpus in `tmp/` is the goal; promoting it to the committed 1976 gate is a separate, deliberate decision (see spec "Вне области" and `docs/corpus-testing.md`).
- `ExtractedQuery` is already exported from `extractQueries.ts`; both new functions reuse it and the existing `startsWithQueryKeyword` helper.
- `tmp/query1c` is gitignored — the smoke test in Task 4 won't dirty the tree.
