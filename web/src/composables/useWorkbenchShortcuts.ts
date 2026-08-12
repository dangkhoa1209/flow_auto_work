import {
  onMounted,
  onUnmounted,
  type Ref,
} from "vue";

type WorkbenchShortcutsOpts = {
  run: () => void | Promise<void>;
  saveNotes: () => void | Promise<void>;
  /** Close top-most modal if any is open; return true if handled */
  closeModal: () => boolean;
  /** Skip shortcuts when typing in inputs — caller can refine */
  enabled?: Ref<boolean>;
};

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest("[contenteditable='true']"));
}

/**
 * Pro keyboard shortcuts for Workbench (IDE-style).
 * - ⌘/Ctrl+Enter → Run (skipped while focus is in an input/textarea — chat uses Enter to send)
 * - ⌘/Ctrl+S → save Dev Notes (works even inside textarea)
 * - Esc → close modal
 */
export function useWorkbenchShortcuts(opts: WorkbenchShortcutsOpts): void {
  function onKeydown(e: KeyboardEvent) {
    if (opts.enabled && !opts.enabled.value) return;

    const meta = e.metaKey || e.ctrlKey;

    if (e.key === "Escape") {
      if (opts.closeModal()) {
        e.preventDefault();
      }
      return;
    }

    if (meta && e.key === "Enter") {
      // Don't steal Enter/Cmd+Enter from chat composers or other fields.
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      void opts.run();
      return;
    }

    if (meta && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      void opts.saveNotes();
      return;
    }
  }

  onMounted(() => {
    window.addEventListener("keydown", onKeydown, true);
  });
  onUnmounted(() => {
    window.removeEventListener("keydown", onKeydown, true);
  });
}

export { isEditableTarget };
