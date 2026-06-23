import * as React from 'react';

/**
 * 8.3.7: перетаскиваемый разделитель границ панелей/колонок. Между двумя соседними
 * блоками: левый (или верхний) блок держит ширину/высоту в state, второй — flex:1.
 * При перетаскивании вызывает `onResize(delta)` с приращением в пикселях по оси.
 *
 *   const [w, setW] = React.useState(280);
 *   <div style={{ width: w, flexShrink: 0 }}>…</div>
 *   <ResizeHandle onResize={d => setW(v => clamp(v + d))} />
 *   <div style={{ flex: 1, minWidth: 0 }}>…</div>
 *
 * axis='x' — вертикальная полоса (изменяет ширину); axis='y' — горизонтальная
 * (изменяет высоту). Захват мыши на window — перетаскивание не теряется за пределами
 * хэндла.
 */
export function ResizeHandle({
  onResize,
  axis = 'x',
}: {
  onResize: (delta: number) => void;
  axis?: 'x' | 'y';
}): React.ReactElement {
  const onMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      let last = axis === 'x' ? e.clientX : e.clientY;
      const move = (ev: MouseEvent) => {
        const cur = axis === 'x' ? ev.clientX : ev.clientY;
        if (cur !== last) {
          onResize(cur - last);
          last = cur;
        }
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [axis, onResize]
  );

  const base: React.CSSProperties = {
    flexShrink: 0,
    cursor: axis === 'x' ? 'col-resize' : 'row-resize',
    background: 'transparent',
    zIndex: 1,
  };
  const style: React.CSSProperties =
    axis === 'x'
      ? { ...base, width: 7, alignSelf: 'stretch', margin: '0 -2px' }
      : { ...base, height: 7, width: '100%', margin: '-2px 0' };

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onMouseDown={onMouseDown}
      style={style}
    />
  );
}
