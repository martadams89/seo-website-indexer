import { useEffect } from 'react';
const navigationEvent = 'discovery:before-navigate';
/** Site/tool switches are buttons and selects, so they need the same guard as links. */
export function requestDraftNavigation() {
  return window.dispatchEvent(new Event(navigationEvent, { cancelable: true }));
}
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const confirm = () => window.confirm('This draft has unsaved changes. Leave without saving?');
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const navigate = (event: Event) => {
      if (!confirm()) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const next = new URL(link.href, location.href);
      if (next.pathname === location.pathname && next.search === location.search) return;
      if (!confirm()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener(navigationEvent, navigate);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener(navigationEvent, navigate);
      document.removeEventListener('click', click, true);
    };
  }, [dirty]);
  return () => !dirty || window.confirm('Discard the unsaved changes in this draft?');
}
