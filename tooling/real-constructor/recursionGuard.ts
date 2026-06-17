/**
 * Страж рекурсивного обхода под-окон конструктора: ограничивает глубину и не даёт
 * повторно входить в уже виденное окно (ключ — нормализованный заголовок).
 */
export interface RecursionGuardOptions {
  maxDepth?: number;
}

export class RecursionGuard {
  private readonly maxDepth: number;
  private readonly seen = new Set<string>();

  constructor(opts: RecursionGuardOptions = {}) {
    this.maxDepth = opts.maxDepth ?? 3;
  }

  /** Можно ли войти в окно `title` на глубине `depth`? Помечает заголовок виденным при входе. */
  shouldEnter(title: string, depth: number): boolean {
    if (depth > this.maxDepth) return false;
    const key = title.trim().toLowerCase();
    if (key === '') return false;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  get visitedCount(): number {
    return this.seen.size;
  }
}
