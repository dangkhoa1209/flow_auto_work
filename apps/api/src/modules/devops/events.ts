import type { BuildEvent } from "./types.js";

type Listener = (event: BuildEvent) => void;

const listeners = new Set<Listener>();

export function subscribeBuildEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishBuildEvent(event: BuildEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore broken subscriber */
    }
  }
}

export function buildEventSubscriberCount(): number {
  return listeners.size;
}
