import { logger } from "../../logger.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import {
  loadBaGitlabTaskBlock,
  type BaIssueRef,
} from "./ba-issue-read.js";

/**
 * /work chat parity with BA: when the human pastes `#id`, `issue 123`, or a
 * GitLab issue/work_item URL, fetch title/description/comments into the prompt
 * (read-only). Uses workspace runtime PAT + project path.
 */
export async function prepareWorkGitlabTaskBlock(opts: {
  texts: string[];
  /** Primary linked job iid — already in the work prompt; do not re-fetch. */
  excludeIid?: number;
}): Promise<{
  block: string;
  refs: BaIssueRef[];
  progressLabel?: string;
}> {
  const rt = getRuntimeContext();
  if (!rt?.gitlabPath?.trim()) {
    return { block: "", refs: [] };
  }
  // ba-issue-read is GitLab API only
  if (rt.gitProvider === "github") {
    return { block: "", refs: [] };
  }

  try {
    const { refs, block } = await loadBaGitlabTaskBlock({
      gitlabHost: rt.gitlabHost || "https://gitlab.com",
      gitlabPath: rt.gitlabPath,
      token: rt.gitlabToken?.trim() || null,
      texts: opts.texts,
      excludeIids:
        opts.excludeIid && opts.excludeIid > 0 ? [opts.excludeIid] : undefined,
    });
    if (!refs.length) return { block: "", refs: [] };
    return {
      block,
      refs,
      progressLabel: `Reading GitLab ${refs.map((r) => `#${r.iid}`).join(", ")}…`,
    };
  } catch (err) {
    logger.warn("Work chat GitLab task load failed", { err: String(err) });
    return { block: "", refs: [] };
  }
}
