/**
 * In-process pub/sub for UI realtime (SSE).
 * Server pushes; clients listen — no /status|/jobs polling loop.
 */

export type ProgressLineEvent = {
  id: number;
  at: string;
  kind: string;
  text: string;
};

export type ChatMessageEvent = {
  id?: string;
  jobId?: string;
  issueIid: number;
  role: "user" | "agent" | "system";
  kind: "clarify" | "qa" | "note";
  body: string;
  createdAt: string;
};

export type RealtimeEvent =
  | {
      type: "status";
      currentJobId: string | null;
      /** All lanes currently executing (parallel per project) */
      currentJobIds?: string[];
      queueLength: number;
      running: boolean;
    }
  | {
      type: "jobs";
      reason?: string;
      jobId?: string;
    }
  | {
      type: "progress";
      jobId: string;
      line: ProgressLineEvent;
      live: boolean;
    }
  | {
      type: "job";
      jobId: string;
      status?: string;
    }
  | {
      type: "chat";
      jobId: string;
      message?: ChatMessageEvent;
    };

type Listener = (event: RealtimeEvent) => void;

const listeners = new Set<Listener>();

export function subscribeRealtime(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishRealtime(event: RealtimeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore broken subscriber */
    }
  }
}

export function realtimeSubscriberCount(): number {
  return listeners.size;
}
