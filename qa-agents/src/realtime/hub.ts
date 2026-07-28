/**
 * In-process pub/sub for QA UI realtime (SSE).
 * Isolated from Flow coding hub so events never cross services.
 */

export type QaProgressLine = {
  id: number;
  at: string;
  kind: string;
  text: string;
};

export type QaRealtimeEvent =
  | {
      type: "status";
      currentJobId: string | null;
      currentJobIds?: string[];
      queueLength: number;
      running: boolean;
    }
  | { type: "jobs"; reason?: string; jobId?: string }
  | {
      type: "progress";
      jobId: string;
      line: QaProgressLine;
      live: boolean;
    }
  | { type: "job"; jobId: string; status?: string }
  | {
      type: "screenshot";
      jobId: string;
      path: string;
      url: string;
    };

type Listener = (event: QaRealtimeEvent) => void;

const listeners = new Set<Listener>();

export function subscribeQaRealtime(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishQaRealtime(event: QaRealtimeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore broken subscriber */
    }
  }
}
