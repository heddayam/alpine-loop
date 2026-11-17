import type { ReactNode } from "react";

export function CollapseTab({ id, edge, collapsed, controls, label, onToggle, children }: {
  id?: string;
  edge: "side" | "top";
  collapsed: boolean;
  controls: string;
  label: string;
  onToggle: () => void;
  /** Optional visible text, for tabs that double as a collapsed summary. */
  children?: ReactNode;
}) {
  return (
    <button id={id} className={`collapse-tab collapse-tab--${edge}`} type="button"
      aria-controls={controls} aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
      aria-expanded={!collapsed} onClick={onToggle}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="m10 4-4 4 4 4" fill="none" stroke="currentColor" strokeWidth="1.4"
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children}
    </button>
  );
}
