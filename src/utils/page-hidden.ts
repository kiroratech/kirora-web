/** The page is hidden: perhaps closing, so what's left to do should be done at once. */
export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
