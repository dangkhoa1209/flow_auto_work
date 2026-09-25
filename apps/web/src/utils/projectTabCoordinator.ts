/**
 * Cross-tab coordination for the same workspace project.
 * One repo clone per user+project — only one browser tab should drive agent/git work at a time.
 * Other tabs may stay open for read-only; Send/Run is blocked until the active tab is idle.
 */
import {
  safeGetItem,
  safeRemoveItem,
  safeSessionGetItem,
  safeSessionSetItem,
  safeSetItem,
} from "@/utils/safeStorage";

const TAB_ID_KEY = "flow_tab_id";
const LOCK_PREFIX = "flow_agent_tab_lock";
/** Lock expires when the owning tab stops heartbeating (crash / closed tab). */
const LOCK_STALE_MS = 45_000;

export type TabAgentLock = {
  tabId: string;
  at: number;
  jobId?: string;
};

type LockGate = { ok: true } | { ok: false; reason: string };

function agentLockKey(username: string, projectId: string): string {
  return `${LOCK_PREFIX}:${username.trim().toLowerCase()}:${projectId.trim()}`;
}

function readLock(key: string): TabAgentLock | null {
  try {
    const raw = safeGetItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TabAgentLock;
    if (!parsed?.tabId || typeof parsed.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLock(key: string, lock: TabAgentLock): void {
  safeSetItem(key, JSON.stringify(lock));
}

/** Stable id for this browser tab (sessionStorage). */
export function getTabId(): string {
  let id = safeSessionGetItem(TAB_ID_KEY)?.trim() || "";
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    safeSessionSetItem(TAB_ID_KEY, id);
  }
  return id;
}

function isFresh(lock: TabAgentLock): boolean {
  return Date.now() - lock.at < LOCK_STALE_MS;
}

/** Another tab currently owns agent work on this project. */
export function foreignTabHoldsAgentLock(
  username: string | null | undefined,
  projectId: string | null | undefined,
): boolean {
  const user = username?.trim();
  const project = projectId?.trim();
  if (!user || !project) return false;
  const lock = readLock(agentLockKey(user, project));
  if (!lock || !isFresh(lock)) return false;
  return lock.tabId !== getTabId();
}

export function readForeignAgentLock(
  username: string | null | undefined,
  projectId: string | null | undefined,
): TabAgentLock | null {
  const user = username?.trim();
  const project = projectId?.trim();
  if (!user || !project) return null;
  const lock = readLock(agentLockKey(user, project));
  if (!lock || !isFresh(lock) || lock.tabId === getTabId()) return null;
  return lock;
}

/** Try to become the active agent tab for this project. */
export function acquireAgentLock(
  username: string | null | undefined,
  projectId: string | null | undefined,
  jobId?: string,
): LockGate {
  const user = username?.trim();
  const project = projectId?.trim();
  if (!user || !project) return { ok: true };

  const key = agentLockKey(user, project);
  const cur = readLock(key);
  const tabId = getTabId();
  const now = Date.now();

  if (cur && cur.tabId !== tabId && isFresh(cur)) {
    return {
      ok: false,
      reason:
        "Tab khác đang chạy agent trên project này. Dùng tab đó, đợi xong, hoặc Force Stop rồi thử lại.",
    };
  }

  writeLock(key, { tabId, at: now, jobId: jobId?.trim() || cur?.jobId });
  return { ok: true };
}

/** Keep lock alive while agent/queue is active in this tab. */
export function touchAgentLock(
  username: string | null | undefined,
  projectId: string | null | undefined,
  jobId?: string,
): void {
  const user = username?.trim();
  const project = projectId?.trim();
  if (!user || !project) return;
  const key = agentLockKey(user, project);
  const cur = readLock(key);
  const tabId = getTabId();
  if (cur && cur.tabId !== tabId && isFresh(cur)) return;
  writeLock(key, { tabId, at: Date.now(), jobId: jobId?.trim() || cur?.jobId });
}

export function releaseAgentLock(
  username: string | null | undefined,
  projectId: string | null | undefined,
): void {
  const user = username?.trim();
  const project = projectId?.trim();
  if (!user || !project) return;
  const key = agentLockKey(user, project);
  const cur = readLock(key);
  if (cur?.tabId === getTabId()) safeRemoveItem(key);
}

export function agentLockBlockMessage(): string {
  return "Tab khác đang chạy agent trên project này. Dùng tab đó, đợi xong, hoặc Force Stop rồi thử lại.";
}
