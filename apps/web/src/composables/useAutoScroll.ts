import { nextTick, ref, watch, type Ref, type WatchSource } from "vue";

/**
 * Follow the bottom when `source` changes, only if the user is already there.
 * Scrolling up to read history must not be yanked back — including delayed
 * force jumps from layout / job load.
 */
export function useAutoScroll(
  elRef: Ref<HTMLElement | null>,
  source: WatchSource,
  opts?: { thresholdPx?: number },
) {
  const thresholdPx = opts?.thresholdPx ?? 80;
  const pinnedToBottom = ref(true);
  /** Sticky until the user returns to the bottom. */
  let readingHistory = false;

  function distanceFromBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  function syncFromEl(el: HTMLElement) {
    // Collapsed pane reports "at bottom" (height 0) — keep the real pin.
    if (el.clientHeight < 8) return;
    const atBottom = distanceFromBottom(el) <= thresholdPx;
    pinnedToBottom.value = atBottom;
    readingHistory = !atBottom;
  }

  function onScroll() {
    const el = elRef.value;
    if (el) syncFromEl(el);
  }

  /** Unpin on the same frame as wheel-up so a pending nextTick cannot yank. */
  function onWheel(e: WheelEvent) {
    if (e.deltaY < 0) {
      pinnedToBottom.value = false;
      readingHistory = true;
    }
  }

  function onTouchMove() {
    const el = elRef.value;
    if (el) syncFromEl(el);
  }

  function resetPin() {
    pinnedToBottom.value = true;
    readingHistory = false;
  }

  async function scrollToBottom(force = false) {
    await nextTick();
    const el = elRef.value;
    if (!el) return;
    if (readingHistory) return;
    if (!force && !pinnedToBottom.value) return;
    el.scrollTop = el.scrollHeight;
  }

  watch(
    source,
    () => {
      void scrollToBottom();
    },
    { flush: "post" },
  );

  return {
    pinnedToBottom,
    onScroll,
    onWheel,
    onTouchMove,
    resetPin,
    scrollToBottom,
  };
}
