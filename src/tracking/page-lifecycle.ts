/** What to do as the page is hidden and shown, and goes offline and online. */
type PageLifecycleHandlers = {
  /** The page was hidden: often the last chance to do anything before the tab closes. */
  onHidden(): void;
  /** The visitor came back to the page. */
  onReturn(): void;
  /** Every `intervalMs` while the page is visible. */
  whileVisible(): void;
  /** The browser is back online. */
  onOnline(): void;
};

/**
 * Watches the page's visibility and connection. Returns a function that stops watching.
 * Only call it where there's a `document`.
 */
export function watchPageLifecycle(
  handlers: PageLifecycleHandlers,
  intervalMs: number,
): () => void {
  let whileVisible: ReturnType<typeof setInterval> | undefined;
  const onVisibility = (returned: boolean) => {
    clearInterval(whileVisible);
    if (document.visibilityState !== 'visible') {
      handlers.onHidden();
      return;
    }
    if (returned) handlers.onReturn();
    whileVisible = setInterval(() => handlers.whileVisible(), intervalMs);
  };
  const onVisibilityChange = () => onVisibility(true);
  const onOnline = () => handlers.onOnline();
  document.addEventListener('visibilitychange', onVisibilityChange);
  addEventListener('online', onOnline);
  onVisibility(false);
  return () => {
    clearInterval(whileVisible);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    removeEventListener('online', onOnline);
  };
}
