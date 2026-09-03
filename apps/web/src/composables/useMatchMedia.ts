import { onMounted, onUnmounted, ref, type Ref } from "vue";

function readMatches(query: string): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(query).matches;
}

/**
 * Reactive `window.matchMedia(query).matches`.
 * Reads immediately in the browser so the first paint picks the right tree.
 */
export function useMatchMedia(query: string): Ref<boolean> {
  const matches = ref(readMatches(query));
  let mql: MediaQueryList | null = null;

  function sync() {
    if (mql) matches.value = mql.matches;
  }

  onMounted(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    mql = window.matchMedia(query);
    sync();
    mql.addEventListener("change", sync);
  });

  onUnmounted(() => {
    mql?.removeEventListener("change", sync);
    mql = null;
  });

  return matches;
}

/** Tailwind `lg` and up (≥1024px). */
export function useIsDesktopLg(): Ref<boolean> {
  return useMatchMedia("(min-width: 1024px)");
}
