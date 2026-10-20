/** Invoke from a click handler. HTTP deployments need the legacy, user-gesture copy path. */
export async function copyLink(text: string, field?: HTMLInputElement | HTMLTextAreaElement): Promise<'copied' | 'manual'> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch { /* A denied modern permission may still permit user-initiated legacy copy. */ }
  if (typeof document === 'undefined') return 'manual';
  const previous = document.activeElement as HTMLElement | null;
  const input = field ?? document.createElement('textarea');
  const temporary = !field;
  input.value = text;
  if (temporary) {
    input.readOnly = true;
    input.setAttribute('aria-label', '完整链接，请手动复制');
    input.style.position = 'fixed'; input.style.left = '12px'; input.style.bottom = '12px';
    input.style.width = 'calc(100% - 24px)'; input.style.maxWidth = '620px'; input.style.zIndex = '2147483647';
    document.body.appendChild(input);
  }
  input.focus({ preventScroll: true });
  input.select();
  // Explicitly select the full value on mobile Safari as well as desktop browsers.
  input.setSelectionRange?.(0, text.length);
  let copied = false;
  try { copied = document.execCommand?.('copy') === true; } catch { /* Keep the selected link available. */ }
  if (!copied) return 'manual';
  if (temporary) input.remove();
  if (previous?.isConnected && previous !== input) previous.focus({ preventScroll: true });
  return 'copied';
}
