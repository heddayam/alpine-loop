import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from "react";

/** Shared dismissal and viewport placement for the search settings popovers. */
export function useAnchoredPopover(disabled: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    if (!open || !root.current || !panel.current) return;
    const left = root.current.getBoundingClientRect().left;
    const width = panel.current.getBoundingClientRect().width;
    setOffset(Math.max(9 - left, Math.min(0, window.innerWidth - width - 9 - left)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  };
  return { root, button, panel, open, offset, onBlur, toggle: () => setOpen(value => !value) };
}
