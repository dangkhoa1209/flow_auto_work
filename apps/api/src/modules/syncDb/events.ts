import type { SyncDbEvent } from "./types.js";

type Listener = (event: SyncDbEvent) => void;

const listeners = new Set<Listener>();

export function subscribeSyncDbEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishSyncDbEvent(event: SyncDbEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore broken subscriber */
    }
  }
}
