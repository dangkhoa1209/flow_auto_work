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
    }
  | {
      type: "ba_message";
      userId: string;
      threadId: string;
      message: {
        id: string;
        threadId: string;
        role: "user" | "assistant" | "system";
        content: string;
        createdAt: string;
      };
    }
  | {
      type: "ba_delta";
      userId: string;
      threadId: string;
      messageId: string;
      delta: string;
    }
  | {
      type: "ba_done";
      userId: string;
      threadId: string;
      messageId: string;
      content: string;
    }
  | {
      type: "ba_error";
      userId: string;
      threadId: string;
      messageId?: string;
      error: string;
    }
  | {
      type: "ba_progress";
      userId: string;
      threadId: string;
      messageId?: string;
      /** Machine step id for UI timeline */
      step:
        | "pull"
        | "start"
        | "read"
        | "write"
        | "done"
        | "error";
      label: string;
      detail?: string;
    }
  | {
      type: "ba_issue_draft_progress";
      userId: string;
      threadId: string;
      label: string;
      step?: string;
    }
  | {
      type: "ba_issue_draft_done";
      userId: string;
      threadId: string;
      baProjectId: string;
      cached: boolean;
      draft: {
        title: string;
        description: string;
        labels: string[];
        acceptanceCriteria: string[];
      };
    }
  | {
      type: "ba_issue_draft_error";
      userId: string;
      threadId: string;
      error: string;
    }
  | {
      type: "ba_wf_step_progress";
      userId: string;
      requirementId: string;
      step: string;
      label: string;
    }
  | {
      type: "ba_wf_step_done";
      userId: string;
      requirementId: string;
      step: string;
      requirement: {
        id: string;
        title: string;
        status: string;
        steps: Array<{ key: string; content: string; ranAt: string }>;
      };
      taskDrafts: Array<{
        id: string;
        title: string;
        status: string;
        gitlabIid?: number | null;
        gitlabUrl?: string | null;
      }>;
      gate: {
        status: "ok" | "blocked" | "invalid";
        openQuestions: string[];
      };
    }
  | {
      type: "ba_wf_step_error";
      userId: string;
      requirementId: string;
      step: string;
      error: string;
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
