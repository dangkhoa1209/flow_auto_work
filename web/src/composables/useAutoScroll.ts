import { nextTick, ref, watch, type Ref, type WatchSource } from "vue";

/**
 * Keep an overflow container scrolled to the bottom when `source` changes,
 * unless the user has scrolled up intentionally.
 */
export function useAutoScroll(
  elRef: Ref<HTMLElement | null>,
  source: WatchSource,
  opts?: { thresholdPx?: number },
) {
  const thresholdPx = opts?.thresholdPx ?? 80;
  const pinnedToBottom = ref(true);

  function onScroll() {
    const el = elRef.value;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottom.value = dist <= thresholdPx;
  }

  async function scrollToBottom(force = false) {
    await nextTick();
    const el = elRef.value;
    if (!el) return;
    if (!force && !pinnedToBottom.value) return;
    el.scrollTop = el.scrollHeight;
  }

  watch(source, () => {
    void scrollToBottom();
  });

  return { pinnedToBottom, onScroll, scrollToBottom };
}
