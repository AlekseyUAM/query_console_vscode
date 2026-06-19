import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/core/query/sdblLexer';

describe('sdblLexer comments (Step 2)', () => {
  const SRC = 'ВЫБРАТЬ\n\tА.Б КАК В, // hi\n// full line\nИЗ Справочник.С КАК С';

  it('default tokenize() discards comments — no comment tokens emitted', () => {
    const tokens = tokenize(SRC);
    const comments = tokens.filter((t) => t.type === 'comment');
    expect(comments).toHaveLength(0);

    // Non-comment token stream is exactly the query tokens (plus eof).
    const seq = tokens.map((t) => `${t.type}:${t.value}`);
    expect(seq).toEqual([
      'keyword:ВЫБРАТЬ',
      'ident:А',
      'punct:.',
      'ident:Б',
      'keyword:КАК',
      'keyword:В',
      'punct:,',
      'keyword:ИЗ',
      'ident:Справочник',
      'punct:.',
      'ident:С',
      'keyword:КАК',
      'ident:С',
      'eof:',
    ]);
  });

  it('tokenize(text, { comments: true }) emits comment tokens with text and line', () => {
    const tokens = tokenize(SRC, { comments: true });
    const comments = tokens.filter((t) => t.type === 'comment');

    expect(comments.map((c) => c.text)).toEqual(['// hi', '// full line']);
    expect(comments.map((c) => c.value)).toEqual(['// hi', '// full line']);
    expect(comments.map((c) => c.line)).toEqual([2, 3]);

    // The non-comment tokens are unchanged vs. default behavior.
    const nonComment = tokens.filter((t) => t.type !== 'comment').map((t) => `${t.type}:${t.value}`);
    expect(nonComment).toEqual(tokenize(SRC).map((t) => `${t.type}:${t.value}`));
  });

  it('comment token text does NOT include the trailing newline', () => {
    const tokens = tokenize('// hi\nВЫБРАТЬ 1', { comments: true });
    const c = tokens.find((t) => t.type === 'comment');
    expect(c).toBeDefined();
    expect(c!.text).toBe('// hi');
    expect(c!.text.includes('\n')).toBe(false);
    expect(c!.line).toBe(1);
    expect(c!.col).toBe(1);
    expect(c!.pos).toBe(0);
  });

  it('comment at end of file without trailing newline is captured', () => {
    const tokens = tokenize('ВЫБРАТЬ 1 // tail', { comments: true });
    const c = tokens.find((t) => t.type === 'comment');
    expect(c).toBeDefined();
    expect(c!.text).toBe('// tail');
  });
});
