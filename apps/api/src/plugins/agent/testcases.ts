/**
 * Senior Manual QC — generate test cases from task + code, post to GitLab issue.
 */
import { Agent } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { getReviewDiff } from "../git/diff.js";
import { collectLinkedIssueContext } from "../gitlab/linked-context.js";
import { commentOnIssue } from "../scm/index.js";
import { withAiGeneratedMarker } from "../gitlab/agent-comment.js";
import { logger } from "../../logger.js";
import type { IssueJob } from "../../types.js";
import {
  resolveCursorApiKey,
  resolveCursorModel,
  resolveCursorModelSpec,
  resolveRepoPath,
} from "../../workspace/creds.js";
import { cursorModelLogLabel } from "../cursor/modelSpec.js";
import {
  appendJobProgress,
  appendPromptSending,
  appendSdkMessage,
  clearJobProgress,
  recordTokenUsage,
  type JobTokenSnapshot,
} from "./progress.js";
import {
  beginCancellableJob,
  cancelActiveAgentRun,
  errorFromCursorRunStatus,
} from "./run.js";

setMaxListeners(50);

const TESTCASE_TIMEOUT_MS = 10 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `${label} timed out after ${Math.round(ms / 1000)}s — thử lại hoặc thu hẹp scope task`,
            ),
          ),
        ms,
      );
    }),
  ]);
}

const QC_TESTCASE_PROMPT = `# Prompt: Senior Manual QC — Sinh Test Case từ Task + Code

## Vai trò
Bạn là Senior Manual QC Engineer với 8+ năm kinh nghiệm kiểm thử các hệ thống web (Laravel, Vue, MongoDB, REST API). Bạn có tư duy "phá hệ thống" (break the system), luôn đặt câu hỏi "Nếu người dùng làm khác đi thì sao?" và có khả năng đọc code để suy luận ra hành vi UI mà tài liệu nghiệp vụ không mô tả hết.

Nhiệm vụ của bạn: Phân tích Yêu cầu nghiệp vụ (Task) và Mã nguồn thực tế (Code) để viết bộ Test Case kiểm thử thủ công đầy đủ, có thể giao trực tiếp cho Tester thực thi mà không cần hỏi lại.

## 1. Dữ liệu đầu vào
Đã được cung cấp bên dưới (Task + Diff/Code). Bạn **được phép** grep/đọc thêm vài file liên quan trong repo nếu diff chưa đủ — rồi **dừng và viết test case**. Không sửa code, không commit.

## 2. Nguyên tắc phân tích (Bắt buộc thực hiện theo thứ tự)

**Bước 1 — Đối chiếu Task vs Code để tìm khoảng trống (Gap Analysis)**
So sánh từng yêu cầu trong Task với logic thực tế trong Code. Liệt kê ngắn gọn (trước khi vào bảng test case):
- Những gì Code làm đúng như Task mô tả.
- Những gì Code làm nhiều hơn Task yêu cầu (validation, giới hạn, message lỗi ẩn) → đây là nguồn chính để sinh Negative/Edge case.
- Những gì Task yêu cầu nhưng không thấy trong Code → đánh dấu là "Cần làm rõ với Dev/BA", không tự suy diễn.

**Bước 2 — Dịch Code thành hành vi UI**
Với mỗi đoạn logic xử lý, suy luận người dùng sẽ thấy và thao tác gì:
- Validation (required, min/max, regex, unique…) → nhập sai/thiếu, message lỗi ở đâu (inline/toast).
- Ràng buộc dữ liệu (schema, FK, enum) → trùng, sai kiểu, tham chiếu không tồn tại.
- State (loading, disabled, computed) → thao tác nhanh liên tục, mạng chậm.
- Phân quyền (middleware, role) → user không đủ quyền.

**Bước 3 — Tìm "Góc khuất" của Code (Hidden Business Rules)**
Bắt buộc TC riêng khi Code có mà Task không nhắc: maxlength/minlength, file size/type, timeout/debounce/rate-limit/retry, phân trang, try/catch & HTTP error, trim/timezone/làm tròn.

**Bước 4 — Đề xuất dữ liệu test cụ thể**
Không viết chung chung. Ví dụ: max:255 → 256 ký tự; file 2MB → 2.1MB + định dạng ngoài whitelist; regex email/phone đúng code; emoji/khoảng trắng đầu cuối; biên 0, âm, =min, =max, =max+1.

**Bước 5 — Priority & Severity**
- Priority: High / Medium / Low (tần suất + ảnh hưởng nghiệp vụ)
- Severity: Critical / Major / Minor (crash, mất data, UI nhỏ…)

**Bước 6 — Phi chức năng** chỉ khi code cho thấy dấu hiệu (XSS/CSRF/sensitive data; N+1/không phân trang; breakpoint/browser đặc thù).

## 3. Cấu trúc đầu ra
a) **Gap Analysis** (3–6 gạch đầu dòng, theo Bước 1).
b) Bảng Test Case, chia rõ \`#### Happy Path\`, \`#### Negative Cases\`, \`#### Edge Cases\` — mỗi nhóm 1 bảng:

| ID | Priority | Severity | Tiêu đề Test Case | Điều kiện tiên quyết | Các bước thực hiện | Dữ liệu Test | Kết quả mong đợi |
|---|---|---|---|---|---|---|---|
| TC_HP_01 | High | Major | ... | ... | 1. ...<br>2. ... | ... | ... |

c) **Cần làm rõ với Dev/BA:** Chỉ liệt kê câu hỏi nếu Bước 1 phát hiện có sự sai lệch hoặc thiếu sót. Nếu Code và Task đã khớp nhau 100% (Dev đã giải quyết đủ yêu cầu), hãy ghi chú ngắn gọn: *"Mã nguồn đã cover đủ yêu cầu của Task, không có điểm bất thường cần làm rõ"* (không cố suy diễn ra câu hỏi).

## 4. Quy tắc trình bày
- ID: \`TC_HP_\`, \`TC_NEG_\`, \`TC_EDGE_\`.
- Bước đánh số; trong ô bảng dùng \`<br>\` xuống dòng.
- Không trùng lặp giữa nhóm. Thiếu thông tin → ghi \`[Cần xác nhận]\`, không tự bịa.
- Viết tiếng Việt tự nhiên, dễ hiểu.
- **Tuyệt đối không** dùng các thẻ điều khiển hệ thống như \`<<<DONE>>>\` hay \`<<<GITLAB_COMMENT>>>\` — chỉ xuất nội dung test case thuần túy (hệ thống Flow sẽ tự động xử lý việc đăng bài lên issue).
`;

export type TestcaseGenResult = {
  body: string;
  agentId: string;
  usage: JobTokenSnapshot | null;
  commented: boolean;
};

export async function generateTestcasesForIssue(opts: {
  issue: IssueJob;
  jobId: string;
  branch?: string;
  baseBranch?: string;
  commitSha?: string;
}): Promise<TestcaseGenResult> {
  const jobId = opts.jobId;
  if (!opts.issue.issueIid || opts.issue.issueIid <= 0) {
    throw new Error(
      "Adhoc job chưa có GitLab issue — tạo issue trước khi sinh testcase",
    );
  }

  const [diff, linked] = await Promise.all([
    getReviewDiff({
      issueIid: opts.issue.issueIid,
      branch: opts.branch,
      baseBranch: opts.baseBranch,
      commitSha: opts.commitSha,
    }).catch(() => null),
    collectLinkedIssueContext(opts.issue).catch(() => ({
      promptBlock: "",
      linked: [],
      commentExcerpts: [],
    })),
  ]);

  const diffClip = diff
    ? [diff.rangeDiff, diff.staged, diff.unstaged]
        .filter((s) => s.trim())
        .join("\n\n")
        .slice(0, 40_000)
    : "(không lấy được diff — hãy đọc code liên quan trong repo)";

  const prompt = `${QC_TESTCASE_PROMPT}

## Yêu cầu nghiệp vụ (Task)
- Issue: #${opts.issue.issueIid}
- Title: ${opts.issue.title}
- URL: ${opts.issue.url || "(none)"}
- Labels: ${opts.issue.labels.join(", ") || "(none)"}

### Description
${opts.issue.description || "(empty)"}

${linked.promptBlock || ""}

## Mã nguồn / Diff
Branch: ${diff?.branch || opts.branch || "(unknown)"} (base ${diff?.base || opts.baseBranch || "?"})
Recent commits:
${diff?.recentCommits || "(none)"}

\`\`\`diff
${diffClip}
\`\`\`

Hãy sinh bộ test case theo đúng cấu trúc mục 3.`;

  const model = resolveCursorModelSpec();
  const modelLabel = cursorModelLogLabel(resolveCursorModel());
  logger.info("Testcase generation starting", {
    issueIid: opts.issue.issueIid,
    model: modelLabel,
    jobId,
  });

  const work = async (): Promise<TestcaseGenResult> => {
    const session = beginCancellableJob(jobId);
    try {
      clearJobProgress(jobId);
      appendJobProgress(jobId, "status", `Sinh testcase QC · model ${modelLabel}`);
      session.check();

      const agent = await Agent.create({
        apiKey: resolveCursorApiKey(),
        model,
        local: { cwd: resolveRepoPath() },
      });

      await using disposed = agent;
      appendJobProgress(
        jobId,
        "status",
        `Testcase agent window ${disposed.agentId}`,
      );
      appendPromptSending(jobId, prompt);

      session.check();
      const run = await disposed.send(prompt);
      session.attach(run);

      let streamed = "";
      let lastTurnInput = 0;
      try {
        if (
          typeof run.stream === "function" &&
          run.supports?.("stream") !== false
        ) {
          for await (const message of run.stream()) {
            session.check();
            appendSdkMessage(jobId, message);
            if (message.type === "assistant") {
              for (const block of message.message.content) {
                if (block.type === "text") streamed += block.text;
              }
            }
            const raw = message as {
              type?: string;
              usage?: { inputTokens?: number };
            };
            if (raw.type === "usage" && raw.usage?.inputTokens) {
              lastTurnInput = raw.usage.inputTokens;
            }
          }
        }
      } catch (err) {
        session.check();
        appendJobProgress(
          jobId,
          "status",
          `testcase stream error: ${String(err)}`,
        );
        logger.warn("Testcase stream failed; wait()", { err: String(err) });
      }

      const result = await run.wait();
      session.check();
      if (result.status === "cancelled") {
        throw new Error("Testcase generation cancelled (force stop)");
      }
      if (result.status === "error") {
        throw errorFromCursorRunStatus(
          result as {
            id: string;
            result?: string;
            durationMs?: number;
            errorCode?: string;
            requestId?: string;
          },
          { label: "Testcase" },
        );
      }

      const text = (result.result ?? streamed).trim();
      if (!text) throw new Error("Agent returned empty testcase body");

      const sdkU = (result as { usage?: Parameters<typeof recordTokenUsage>[1] })
        .usage;
      const hasSdk =
        Boolean(sdkU) &&
        (Number(sdkU?.inputTokens) > 0 || Number(sdkU?.totalTokens) > 0);
      const inEst = Math.max(1, Math.ceil(prompt.length / 4));
      const outEst = Math.max(0, Math.ceil(text.length / 4));
      const usage = recordTokenUsage(
        jobId,
        hasSdk
          ? sdkU
          : {
              inputTokens: inEst,
              outputTokens: outEst,
              totalTokens: inEst + outEst,
            },
        { lastTurnInput: lastTurnInput || (hasSdk ? undefined : inEst) },
      );

      let commented = false;
      try {
        const body = withAiGeneratedMarker(
          `## Testcase (Manual QC)\n\n${text}`.slice(0, 900_000),
        );
        await commentOnIssue(opts.issue.projectId, opts.issue.issueIid, body);
        commented = true;
        appendJobProgress(
          jobId,
          "status",
          `Đã comment testcase lên GitLab #${opts.issue.issueIid}`,
        );
      } catch (err) {
        logger.warn("Testcase GitLab comment failed", { err: String(err) });
        appendJobProgress(
          jobId,
          "status",
          `Sinh testcase xong nhưng comment GitLab thất bại: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      return {
        body: text,
        agentId: disposed.agentId,
        usage,
        commented,
      };
    } finally {
      session.end();
    }
  };

  try {
    return await withTimeout(work(), TESTCASE_TIMEOUT_MS, "Testcase gen");
  } catch (err) {
    await cancelActiveAgentRun(jobId).catch(() => undefined);
    throw err;
  }
}
