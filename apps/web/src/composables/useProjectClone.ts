import { message, Modal } from "ant-design-vue";
import { api, ApiError } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";

type CloneStatusResponse = {
  ok?: boolean;
  level?: "good" | "partial" | "bad";
  message?: string;
  localPath?: string;
  project?: {
    localPath?: string;
    repoPath?: string;
    cloneStatus?: string;
    cloneError?: string | null;
  };
};

export function isCloneNotReadyError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return (
      err.code === "clone_not_ready" ||
      /source not cloned/i.test(err.message) ||
      /no git repo at/i.test(err.message)
    );
  }
  if (err instanceof Error) {
    return (
      /source not cloned/i.test(err.message) ||
      /no git repo at/i.test(err.message)
    );
  }
  return false;
}

function projectLocalPath(
  projectId: string,
  hint?: string,
): string {
  if (hint?.trim()) return hint.trim();
  const session = useSessionStore();
  const m = session.memberships.find((x) => x.projectId === projectId);
  const p = m?.project;
  return (p?.localPath || p?.repoPath || "").trim();
}

async function fetchCloneStatus(
  projectId: string,
): Promise<CloneStatusResponse | null> {
  try {
    return await api<CloneStatusResponse>(API.projects.cloneStatus(projectId));
  } catch {
    return null;
  }
}

function cloneIsReady(st: CloneStatusResponse | null | undefined): boolean {
  return Boolean(st?.ok && st.level !== "bad");
}

async function pollUntilCloned(
  projectId: string,
  maxMs = 10 * 60_000,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await fetchCloneStatus(projectId);
    const status = st?.project?.cloneStatus;
    if (cloneIsReady(st)) return true;
    if (status === "failed") {
      message.error(st?.project?.cloneError || "Clone thất bại");
      return false;
    }
  }
  message.error("Clone quá lâu — thử lại sau");
  return false;
}

export function useProjectClone() {
  const session = useSessionStore();

  async function startClone(projectId: string): Promise<boolean> {
    const hide = message.loading("Đang clone source…", 0);
    try {
      await api(API.projects.clone(projectId), {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      const ok = await pollUntilCloned(projectId);
      if (ok) await session.refreshMe();
      return ok;
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      hide();
    }
  }

  function promptClone(projectId: string, detail?: string): Promise<boolean> {
    const localPath = projectLocalPath(projectId, detail);
    return new Promise((resolve) => {
      Modal.confirm({
        title: "Chưa có source local",
        centered: true,
        okText: "Clone ngay",
        cancelText: "Hủy",
        content:
          localPath
            ? `Source chưa clone tại:\n${localPath}\n\nClone xong sẽ tiếp tục thao tác vừa chọn.`
            : "Source project chưa clone. Clone xong sẽ tiếp tục thao tác vừa chọn.",
        async onOk() {
          const ok = await startClone(projectId);
          if (!ok) throw new Error("Clone failed");
          resolve(true);
        },
        onCancel() {
          resolve(false);
        },
      });
    });
  }

  /** True when git repo exists at project local path. */
  async function ensureCloned(projectId?: string | null): Promise<boolean> {
    const pid = (projectId || session.projectId || "").trim();
    if (!pid) {
      message.warning("Chọn project trước");
      return false;
    }
    const st = await fetchCloneStatus(pid);
    if (cloneIsReady(st)) return true;
    return promptClone(pid, st?.localPath || st?.message);
  }

  async function withCloneRetry<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (!isCloneNotReadyError(e)) throw e;
      const pid = session.projectId?.trim();
      if (!pid) return undefined;
      const detail =
        e instanceof Error ? e.message : String(e);
      const ok = await promptClone(pid, detail);
      if (!ok) return undefined;
      return await fn();
    }
  }

  return {
    ensureCloned,
    isCloneNotReadyError,
    withCloneRetry,
  };
}
