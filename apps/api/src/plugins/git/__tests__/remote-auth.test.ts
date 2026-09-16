import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RuntimeContext } from "../../../workspace/runtime.js";
import { runWithRuntimeContext } from "../../../workspace/runtime.js";

const gitMock = vi.fn();

vi.mock("../exec.js", () => ({
  git: (...args: unknown[]) => gitMock(...args),
}));

function baseCtx(over: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    gitlabUsername: "dev",
    gitlabToken: "glpat-secret-token",
    projectId: "p1",
    gitProvider: "gitlab",
    gitlabHost: "https://gitlab.com",
    gitlabPath: "kiemnv/jobtest",
    repoPath: "/tmp/repo",
    ...over,
  };
}

function decodeBasicAuth(header: string | undefined): string {
  const m = String(header || "").match(/^AUTHORIZATION: basic (.+)$/i);
  if (!m?.[1]) throw new Error("missing basic auth header");
  return Buffer.from(m[1], "base64").toString("utf8");
}

describe("resolvePatRemoteUrl / resolvePatGitAuth", () => {
  beforeEach(() => {
    gitMock.mockReset();
  });

  it("uses project GitLab PAT HTTPS URL, not origin or SSH", async () => {
    const { resolvePatGitAuth, resolvePatRemoteUrl } = await import(
      "../remote-auth.js"
    );
    await runWithRuntimeContext(baseCtx(), () => {
      const remote = resolvePatRemoteUrl();
      expect(remote).toContain("oauth2:");
      expect(remote).toContain("glpat-secret-token");
      expect(remote).toContain("gitlab.com/kiemnv/jobtest.git");
      expect(remote).not.toMatch(/^git@/);
      expect(remote).not.toContain("origin");

      const { publicUrl, authEnv } = resolvePatGitAuth();
      expect(publicUrl).toBe("https://gitlab.com/kiemnv/jobtest.git");
      expect(publicUrl).not.toContain("glpat");
      expect(publicUrl).not.toContain("@");
      expect(authEnv.GIT_TERMINAL_PROMPT).toBe("0");
      expect(authEnv.GIT_CONFIG_KEY_0).toBe(
        "http.https://gitlab.com/.extraheader",
      );
      expect(String(authEnv.GIT_CONFIG_VALUE_0)).not.toContain(
        "glpat-secret-token",
      );
      expect(decodeBasicAuth(String(authEnv.GIT_CONFIG_VALUE_0))).toBe(
        "oauth2:glpat-secret-token",
      );
    });
  });

  it("uses GitHub x-access-token scheme when provider is github", async () => {
    const { resolvePatGitAuth, resolvePatRemoteUrl } = await import(
      "../remote-auth.js"
    );
    const token = ["github_pat_", "00TEST00TEST00TEST00TEST_", "0".repeat(60)].join(
      "",
    );
    await runWithRuntimeContext(
      baseCtx({
        gitProvider: "github",
        gitlabHost: "https://github.com",
        gitlabPath: "acme/app",
        gitlabToken: token,
      }),
      () => {
        const remote = resolvePatRemoteUrl();
        expect(remote).toContain("x-access-token:");
        expect(remote).toContain("github.com/acme/app.git");
        expect(remote).not.toContain("oauth2:");

        const { publicUrl, authEnv } = resolvePatGitAuth();
        expect(publicUrl).toBe("https://github.com/acme/app.git");
        expect(publicUrl).not.toContain(token);
        expect(decodeBasicAuth(String(authEnv.GIT_CONFIG_VALUE_0))).toBe(
          `x-access-token:${token}`,
        );
      },
    );
  });

  it("defaults host to gitlab.com when empty", async () => {
    const { resolvePatRemoteUrl } = await import("../remote-auth.js");
    await runWithRuntimeContext(baseCtx({ gitlabHost: "" }), () => {
      expect(resolvePatRemoteUrl()).toContain("https://oauth2:");
      expect(resolvePatRemoteUrl()).toContain("@gitlab.com/kiemnv/jobtest.git");
    });
  });

  it("throws when runtime has no PAT", async () => {
    const { resolvePatGitAuth } = await import("../remote-auth.js");
    expect(() => resolvePatGitAuth()).toThrow(/No remote PAT/);
  });

  it("throws when token is whitespace only", async () => {
    const { resolvePatGitAuth } = await import("../remote-auth.js");
    await runWithRuntimeContext(baseCtx({ gitlabToken: "   " }), () => {
      expect(() => resolvePatGitAuth()).toThrow(/No remote PAT/);
    });
  });

  it("throws when gitlabPath is missing", async () => {
    const { resolvePatGitAuth } = await import("../remote-auth.js");
    await runWithRuntimeContext(baseCtx({ gitlabPath: "" }), () => {
      expect(() => resolvePatGitAuth()).toThrow(/No remote PAT/);
    });
  });
});

describe("fetchWithPat", () => {
  beforeEach(() => {
    gitMock.mockReset();
    gitMock.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("fetches public HTTPS URL with PAT in env, never origin remote name", async () => {
    const { fetchWithPat } = await import("../remote-auth.js");
    const refspec = "+refs/heads/uat:refs/remotes/origin/uat";

    await runWithRuntimeContext(baseCtx(), async () => {
      await fetchWithPat("/tmp/repo", [refspec]);
    });

    expect(gitMock).toHaveBeenCalledTimes(1);
    const [repoPath, args, maxBuffer, authEnv] = gitMock.mock.calls[0]!;
    expect(repoPath).toBe("/tmp/repo");
    expect(args[0]).toBe("fetch");
    expect(args[1]).toBe("https://gitlab.com/kiemnv/jobtest.git");
    expect(args[2]).toBe(refspec);
    expect(args).not.toContain("origin");
    expect(String(args[1])).not.toContain("glpat");
    expect(maxBuffer).toBeUndefined();
    expect(authEnv.GIT_CONFIG_VALUE_0).toMatch(/^AUTHORIZATION: basic /);
    expect(decodeBasicAuth(String(authEnv.GIT_CONFIG_VALUE_0))).toBe(
      "oauth2:glpat-secret-token",
    );
  });

  it("forwards extra flags (e.g. --quiet, --depth)", async () => {
    const { fetchWithPat } = await import("../remote-auth.js");
    await runWithRuntimeContext(baseCtx(), async () => {
      await fetchWithPat("/tmp/repo", [
        "+refs/heads/main:refs/remotes/origin/main",
        "--quiet",
        "--depth=50",
      ]);
    });
    const args = gitMock.mock.calls[0]![1] as string[];
    expect(args).toEqual([
      "fetch",
      "https://gitlab.com/kiemnv/jobtest.git",
      "+refs/heads/main:refs/remotes/origin/main",
      "--quiet",
      "--depth=50",
    ]);
  });

  it("propagates git failures", async () => {
    gitMock.mockRejectedValueOnce(
      new Error(
        "Command failed: git fetch https://gitlab.com/kiemnv/jobtest.git\nremote: The project you were looking for could not be found",
      ),
    );
    const { fetchWithPat } = await import("../remote-auth.js");
    await expect(
      runWithRuntimeContext(baseCtx({ gitlabToken: "glpat-bad" }), () =>
        fetchWithPat("/tmp/repo", ["+refs/heads/uat:refs/remotes/origin/uat"]),
      ),
    ).rejects.toThrow(/could not be found/i);
  });

  it("fails closed when no runtime PAT (does not fall back to bare origin)", async () => {
    const { fetchWithPat } = await import("../remote-auth.js");
    await expect(fetchWithPat("/tmp/repo", ["HEAD"])).rejects.toThrow(
      /No remote PAT/,
    );
    expect(gitMock).not.toHaveBeenCalled();
  });
});
