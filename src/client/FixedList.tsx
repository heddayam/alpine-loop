import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";

const OVERSCAN = 5;
/** Continuous native scrolling with only the visible rows and a small margin mounted. */
export function FixedList<T>({ items, rowHeight, children }: {
  items: T[];
  rowHeight: number;
  children: (item: T, index: number) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const frame = useRef(0);
  const measure = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const node = container.current;
      if (node) setView({ top: node.scrollTop, height: node.clientHeight });
    });
  };
  useEffect(() => {
    const node = container.current!;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, []);
  useEffect(() => {
    if (container.current) container.current.scrollTop = 0;
    measure();
  }, [items]);
  const start = Math.min(items.length,
    Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN),
  );
  const end = Math.max(start,
    Math.min(items.length, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN),
  );
  return (
    <div
      className="virtual-list"
      style={{ "--row-height": `${rowHeight}px` } as CSSProperties}
      ref={container}
      onScroll={measure}
      onKeyDown={(event) => {
        const current = Number((event.target as HTMLElement).dataset.row);
        if (!Number.isFinite(current)) return;
        const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? current + 1 : event.key === "ArrowUp" ? current - 1 : undefined;
        if (index === undefined || index < 0 || index >= items.length) return;
        event.preventDefault();
        const node = container.current!;
        const top = index * rowHeight;
        if (top < node.scrollTop) node.scrollTop = top;
        else if (top + rowHeight > node.scrollTop + node.clientHeight) node.scrollTop = top + rowHeight - node.clientHeight;
        setView({ top: node.scrollTop, height: node.clientHeight });
        requestAnimationFrame(() =>
          node.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus(),
        );
      }}
    >
      <ul className="hike-list">
        <li aria-hidden="true" className="list-spacer" style={{ height: start * rowHeight }} />
        {items.slice(start, end).map((item, offset) => children(item, start + offset))}
        <li aria-hidden="true" className="list-spacer" style={{ height: (items.length - end) * rowHeight }} />
      </ul>
    </div>
  );
}
