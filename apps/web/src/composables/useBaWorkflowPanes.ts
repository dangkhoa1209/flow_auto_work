import { computed, onMounted, ref } from "vue";

const STORAGE_KEY = "flow.ba.workflow.panes";

type PaneState = {
  sizes: [number, number, number];
};

const DEFAULT: PaneState = {
  sizes: [22, 42, 36],
};

function load(): PaneState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sizes: [...DEFAULT.sizes] };
    const parsed = JSON.parse(raw) as Partial<PaneState>;
    const sizes = Array.isArray(parsed.sizes)
      ? (parsed.sizes.map(Number) as number[])
      : DEFAULT.sizes;
    if (sizes.length !== 3 || sizes.some((n) => !Number.isFinite(n) || n < 0)) {
      return { sizes: [...DEFAULT.sizes] };
    }
    const sum = sizes[0] + sizes[1] + sizes[2];
    if (sum < 90 || sum > 110) return { sizes: [...DEFAULT.sizes] };
    return { sizes: [sizes[0], sizes[1], sizes[2]] };
  } catch {
    return { sizes: [...DEFAULT.sizes] };
  }
}

/** Resizable 3-pane layout for BA workflow (YC | steps | chat). */
export function useBaWorkflowPanes() {
  const state = ref<PaneState>(load());

  const leftSize = computed(() => state.value.sizes[0]);
  const midSize = computed(() => state.value.sizes[1]);
  const rightSize = computed(() => state.value.sizes[2]);

  function onResized(panes: Array<{ size: number }>) {
    if (panes.length >= 3) {
      state.value = {
        sizes: [panes[0].size, panes[1].size, panes[2].size],
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value));
    }
  }

  onMounted(() => {
    state.value = load();
  });

  return { leftSize, midSize, rightSize, onResized };
}
