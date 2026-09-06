export const COPY_FEEDBACK_MS = 1_500;

export async function copyTextToClipboard(
  text: string | undefined,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  fallbackCopy?: (value: string) => boolean,
): Promise<boolean> {
  if (!text) return false;
  let clipboardCopy: Promise<boolean> | undefined;
  if (clipboard) {
    try {
      // Start the preferred API while the click's browser activation is live.
      clipboardCopy = clipboard.writeText(text).then(() => true, () => false);
    } catch {
      clipboardCopy = undefined;
    }
  }
  try {
    // Run the compatibility path before this synchronous click stack unwinds.
    if (fallbackCopy?.(text)) {
      void clipboardCopy;
      return true;
    }
  } catch {
    // The preferred API may still succeed when the compatibility path cannot.
  }
  return clipboardCopy ? await clipboardCopy : false;
}

export function copyTextWithDocument(text: string, copyDocument: Document | undefined): boolean {
  if (!copyDocument?.body || typeof copyDocument.execCommand !== "function") return false;
  const activeElement = copyDocument.activeElement;
  const textarea = copyDocument.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "-9999px auto auto -9999px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  copyDocument.body.appendChild(textarea);
  textarea.select();
  try {
    return copyDocument.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (activeElement && "focus" in activeElement) (activeElement as HTMLElement).focus({ preventScroll: true });
  }
}
