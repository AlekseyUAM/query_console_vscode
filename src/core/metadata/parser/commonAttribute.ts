import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import { MD_PREFIX } from './typeParser';
import type { ParsedCommonAttribute } from './model';

/**
 * Преобразует английский fullName из состава общего реквизита
 * (`Catalog.ЗначенияСвойствОбъектов`) в русский (`Справочник.ЗначенияСвойствОбъектов`).
 * Возвращает null для типов, которые не являются таблицами запроса (напр. ScheduledJob).
 */
function mapContentRef(raw: string): string | null {
  const m = raw.match(/^([A-Za-z]+)\.(.+)$/);
  if (!m) return null;
  const ru = MD_PREFIX[m[1]];
  if (!ru) return null;
  return `${ru}.${m[2]}`;
}

/**
 * Парсит общий реквизит (ОбщийРеквизит) из элемента <CommonAttribute>.
 *
 * Состав (`Content`) — список объектов с признаком использования (`Use`):
 *   Use     — объект явно входит в состав;
 *   DontUse — объект явно исключён;
 *   Auto    — использование определяется свойством AutoUse реквизита.
 *
 * `content` собирает русские fullName объектов, входящих в состав
 * (Use, либо Auto при AutoUse=Use). `dontUse` — явно исключённые (для разделителей
 * с AutoUse=Use, чтобы слой слияния не добавил реквизит в исключённый объект).
 */
export function parseCommonAttribute(objectEl: any): ParsedCommonAttribute | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;

  const autoUse = nodeText(childByLocalName(props, 'AutoUse')) === 'Use';

  const content: string[] = [];
  const dontUse: string[] = [];

  const contentEl = childByLocalName(props, 'Content');
  if (contentEl) {
    for (const item of childrenByLocalName(contentEl, 'Item')) {
      const ref = mapContentRef(nodeText(childByLocalName(item, 'Metadata')));
      if (!ref) continue;
      const use = nodeText(childByLocalName(item, 'Use'));
      if (use === 'Use' || (use === 'Auto' && autoUse)) {
        content.push(ref);
      } else if (use === 'DontUse') {
        dontUse.push(ref);
      }
    }
  }

  if (!content.length && !autoUse) return null;

  const result: ParsedCommonAttribute = { name, content };
  if (autoUse) {
    result.autoUse = true;
    if (dontUse.length) result.dontUse = dontUse;
  }
  return result;
}
