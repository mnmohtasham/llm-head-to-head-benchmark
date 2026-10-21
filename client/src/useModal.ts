import { useEffect, useRef, type RefObject } from 'react';

/**
 * Opens a dialog as a modal once it is on the page. When it goes away, focus goes back to what
 * had it before, such as the button that opened it: a dialog removed without being closed skips
 * the browser's own return. When the opener is gone too, such as the row of a deleted race, focus
 * goes to the heading of the section the opener was in.
 */
export function useModal(ref: RefObject<HTMLDialogElement | null>) {
  const before = useRef<{ opener: HTMLElement | null; section: Element | null } | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) {
      const active = document.activeElement;
      const opener = active instanceof HTMLElement && active !== document.body ? active : null;
      before.current = { opener, section: opener?.closest('section, main') ?? null };
      dialog.showModal();
    }
    return () => {
      // Still on the page: React is only running the effect twice in development.
      if (dialog.isConnected) return;
      const { opener, section } = before.current ?? { opener: null, section: null };
      before.current = null;
      if (opener?.isConnected && !opener.matches(':disabled')) {
        opener.focus();
        return;
      }
      const heading = section?.isConnected
        ? section.querySelector<HTMLElement>('h1, h2, h3')
        : null;
      if (!heading) return;
      if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
      heading.focus();
    };
  }, [ref]);
}
