import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RuntimeContext } from "../../../workspace/runtime.js";
import { runWithRuntimeContext } from "../../../workspace/runtime.js";

const gitMock = vi.fn();
const fetchWithPatMock = vi.fn();

vi.mock("../exec.js", () => ({
  git: (...args: unknown[]) => gitMock(...args),
}));

vi.mock("../remote-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../remote-auth.js")>(
    "../remote-auth.js",
  );
  return {
    ...actual,
    fetchWithPat: (...args: unknown[]) => fetchWithPatMock(...args),
  };
});

function baseCtx(): RuntimeContext {
  return {
    gitlabUsername: "dev",
    gitlabToken: "glpat-secret-token",
    projectId: "p1",
    gitProvider: "gitlab",
    gitlabHost: "https://gitlab.com",
    gitlabPath: "kiemnv/jobtest",
    repoPath: "/tmp/repo",
  };
}

describe("syncLocalToRemoteCommit uses fetchWithPat", () => {
  beforeEach(() => {
    gitMock.mockReset();
    fetchWithPatMock.mockReset();
    fetchWithPatMock.mockResolvedValue({ stdout: "", stderr: "" });
    gitMock.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("fetches branch refspec via PAT then hard-resets to sha", async () => {
    const { syncLocalToRemoteCommit } = await import("../changes-for-api.js");
    const sha = "ec76d5156ec5abcdef0123456789abcdef0123";

    await runWithRuntimeContext(baseCtx(), async () => {
      await syncLocalToRemoteCommit("/tmp/repo", "uat", sha);
    });

    expect(fetchWithPatMock).toHaveBeenCalledWith("/tmp/repo", [
      "+refs/heads/uat:refs/remotes/origin/uat",
    ]);
    expect(gitMock).toHaveBeenCalledWith("/tmp/repo", ["checkout", "-B", "uat"]);
    expect(gitMock).toHaveBeenCalledWith("/tmp/repo", ["reset", "--hard", sha]);
  });

  it("falls back to fetch sha when branch refspec fails", async () => {
    fetchWithPatMock
      .mockRejectedValueOnce(new Error("branch fetch failed"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const { syncLocalToRemoteCommit } = await import("../changes-for-api.js");
    const sha = "ec76d5156ec5abcdef0123456789abcdef0123";

    await runWithRuntimeContext(baseCtx(), async () => {
      await syncLocalToRemoteCommit("/tmp/repo", "uat", sha);
    });

    expect(fetchWithPatMock).toHaveBeenNthCalledWith(1, "/tmp/repo", [
      "+refs/heads/uat:refs/remotes/origin/uat",
    ]);
    expect(fetchWithPatMock).toHaveBeenNthCalledWith(2, "/tmp/repo", [sha]);
    expect(gitMock).toHaveBeenCalledWith("/tmp/repo", ["reset", "--hard", sha]);
  });

  it("surfaces original branch-fetch error when both fetches fail", async () => {
    fetchWithPatMock
      .mockRejectedValueOnce(new Error("branch 404"))
      .mockRejectedValueOnce(new Error("sha 404"));

    const { syncLocalToRemoteCommit } = await import("../changes-for-api.js");

    await expect(
      runWithRuntimeContext(baseCtx(), () =>
        syncLocalToRemoteCommit(
          "/tmp/repo",
          "uat",
          "ec76d5156ec5abcdef0123456789abcdef0123",
        ),
      ),
    ).rejects.toThrow(/Could not fetch GitLab commit ec76d5156ec5.*branch 404/);
  });

  it("falls back to origin/branch hard-reset when sha reset fails", async () => {
    gitMock.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "reset" && args[1] === "--hard" && args[2]?.startsWith("ec76")) {
        throw new Error("unknown revision");
      }
      return { stdout: "", stderr: "" };
    });

    const { syncLocalToRemoteCommit } = await import("../changes-for-api.js");
    const sha = "ec76d5156ec5abcdef0123456789abcdef0123";

    await runWithRuntimeContext(baseCtx(), async () => {
      await syncLocalToRemoteCommit("/tmp/repo", "uat", sha);
    });

    expect(gitMock).toHaveBeenCalledWith("/tmp/repo", [
      "reset",
      "--hard",
      "origin/uat",
    ]);
  });
});
