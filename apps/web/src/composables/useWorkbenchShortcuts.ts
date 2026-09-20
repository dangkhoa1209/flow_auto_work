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
  /** Force-stop the selected running job (Esc when no modal). */
  forceStop?: () => void | Promise<void>;
  /** Whether Force Stop is available for Esc. */
  canForceStop?: Ref<boolean>;
  /** Focus task search (/). */
  focusTaskSearch?: () => void;
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
 * - / → focus task search (when not editing)
 * - Esc → close modal, else Force Stop when a run is active
 */
export function useWorkbenchShortcuts(opts: WorkbenchShortcutsOpts): void {
  function onKeydown(e: KeyboardEvent) {
    if (opts.enabled && !opts.enabled.value) return;

    const meta = e.metaKey || e.ctrlKey;
    const editing = isEditableTarget(e.target);

    if (e.key === "Escape") {
      if (opts.closeModal()) {
        e.preventDefault();
        return;
      }
      if (
        opts.forceStop &&
        opts.canForceStop?.value &&
        !editing
      ) {
        e.preventDefault();
        void opts.forceStop();
      }
      return;
    }

    if (
      e.key === "/" &&
      !meta &&
      !e.altKey &&
      !editing &&
      opts.focusTaskSearch
    ) {
      e.preventDefault();
      opts.focusTaskSearch();
      return;
    }

    if (meta && e.key === "Enter") {
      // Don't steal Enter/Cmd+Enter from chat composers or other fields.
      if (editing) return;
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
