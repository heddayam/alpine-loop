"use client";

import { useEffect, useRef } from "react";

/** Keep keyboard navigation inside an open dialog and restore its trigger. */
export function useDialogFocus(open: boolean, close: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const eligible = () => [...dialog.querySelectorAll<HTMLElement>("button, input, select, textarea, [href], [tabindex]")]
      .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled, input[type="hidden"]') && !element.closest("[inert], [hidden]"));
    eligible()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const controls = eligible();
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      const active = document.activeElement;
      if (!controls.some((element) => element === active) || active === (event.shiftKey ? first : last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [close, open]);
  return dialogRef;
}
