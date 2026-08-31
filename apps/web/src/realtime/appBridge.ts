import { watch } from "vue";
import {
  reconnectRealtime,
  subscribeRealtime,
  type RealtimeHandlers,
} from "@/realtime/client";
import { useSessionStore } from "@/stores/session";
import { useWorkStore } from "@/stores/work";
import { useBaChatStore } from "@/stores/baChat";
import { useDevopsStore } from "@/stores/devops";

let unsub: (() => void) | undefined;
let bound = false;

function coreHandlers(): RealtimeHandlers {
  const work = useWorkStore();
  const ba = useBaChatStore();
  return {
    onOpen: () => {
      void work.resyncRealtime();
      void ba.resyncRealtime();
    },
    onStatus: (ev) => {
      work.applyStatusSnapshot({
        currentJobId: ev.currentJobId,
        currentJobIds: ev.currentJobIds,
        queueLength: ev.queueLength,
      });
    },
    onProgress: (ev) => work.applyRealtimeProgress(ev),
    onJobs: () => work.scheduleLoadJobs(),
    onJob: (ev) => work.applyRealtimeJob(ev),
    onChat: (ev) => work.applyRealtimeChat(ev),
    onBaMessage: (ev) => ba.applyBaMessage(ev),
    onBaDelta: (ev) => ba.applyBaDelta(ev),
    onBaDone: (ev) => ba.applyBaDone(ev),
    onBaError: (ev) => ba.applyBaError(ev),
    onBaProgress: (ev) => ba.applyBaProgress(ev),
    onBaIssueDraftProgress: (ev) => ba.applyBaIssueDraftProgress(ev),
    onBaIssueDraftDone: (ev) => ba.applyBaIssueDraftDone(ev),
    onBaIssueDraftError: (ev) => ba.applyBaIssueDraftError(ev),
  };
}

function ensureCoreRealtime() {
  if (unsub) return;
  unsub = subscribeRealtime(coreHandlers());
}

function stopCoreRealtime() {
  unsub?.();
  unsub = undefined;
}

/**
 * Keep Work/BA SSE + Build queue SSE for the logged-in session.
 * Layout remounts (Chat ↔ Work ↔ Build) no longer drop the streams.
 */
export function bindAppRealtimeToSession() {
  if (bound) return;
  bound = true;
  const session = useSessionStore();

  watch(
    () => session.isLoggedIn,
    (ok) => {
      if (ok) {
        ensureCoreRealtime();
      } else {
        stopCoreRealtime();
        useDevopsStore().disconnect();
      }
    },
    { immediate: true },
  );

  watch(
    () => session.isLoggedIn && session.canAccessDevops,
    (ok) => {
      const devops = useDevopsStore();
      if (ok) devops.connectEvents();
      else devops.disconnect();
    },
    { immediate: true },
  );

  watch(
    () => session.projectId,
    (next, prev) => {
      if (!session.isLoggedIn) return;
      if (!next || next === prev) return;
      reconnectRealtime();
    },
  );
}
