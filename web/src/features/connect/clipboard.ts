/**
 * clipboard
 * ─────────
 * Putting a subscription link on the clipboard in the places this cabinet
 * actually runs: the Mini App's webview on the connect screen, and whatever
 * browser the trampoline page lands in — Telegram's in-app browser among them.
 *
 * One copy of the fallback for both screens. It used to live privately in
 * `connect-page.tsx`; the trampoline page needs the same thing for the same
 * reasons, and two copies of a workaround are two things to forget to fix.
 */

/**
 * Copies `value` and answers whether it actually reached the clipboard.
 *
 * `navigator.clipboard` first. The selection path when it is absent — an
 * insecure context, several in-app browsers — and when it rejects, because a
 * refused write is not a reason to tell somebody the copy failed while an
 * older path would have worked.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // The selection path below is the answer to a rejected write too.
  }
  return copyViaSelection(value);
}

/**
 * The last-resort copy: put the link in a field, select it, ask the document.
 *
 * `navigator.clipboard` is absent in an insecure context and in several in-app
 * browsers, and "select the link and copy it yourself" is not an instruction
 * anybody can follow against a one-line truncated address.
 */
export function copyViaSelection(value: string): boolean {
  try {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    return copied;
  } catch {
    return false;
  }
}
