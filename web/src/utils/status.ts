/** Human-readable job/task status for UI */
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  queued: "Queued",
  running: "Running",
  awaiting_clarification: "Awaiting clarification",
  awaiting_docs_approval: "Awaiting docs approval",
  awaiting_diff_approval: "Awaiting diff approval",
  awaiting_handoff: "Awaiting handoff",
  succeeded: "Done",
  failed: "Failed",
};

/** Statuses that can be set manually from the Jobs list */
export const MANUAL_JOB_STATUSES = [
  "draft",
  "awaiting_handoff",
  "succeeded",
  "failed",
] as const;

export type ManualJobStatus = (typeof MANUAL_JOB_STATUSES)[number];

/** succeeded → Done; others Title case / spaced */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  const mapped = STATUS_LABELS[status];
  if (mapped) return mapped;
  return status
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export type ContextQualityLevel = "good" | "searchable" | "bad";

const CONTEXT_QUALITY_LABELS: Record<ContextQualityLevel, string> = {
  good: "Good context",
  searchable: "Searchable",
  bad: "Bad context",
};

export function contextQualityLabel(
  level: string | null | undefined,
): string {
  if (!level) return "—";
  return (
    CONTEXT_QUALITY_LABELS[level as ContextQualityLevel] ||
    statusLabel(level)
  );
}

/** Ant Design tag color */
export function contextQualityColor(
  level: string | null | undefined,
): string {
  if (level === "good") return "success";
  if (level === "searchable") return "processing";
  if (level === "bad") return "error";
  return "default";
}

/** Tiêu chuẩn 3 mức — hiện trong modal UI (không dump thẳng lên màn hình). */
export const CONTEXT_QUALITY_STANDARDS: Record<
  ContextQualityLevel,
  { title: string; items: string[] }
> = {
  good: {
    title: "Good",
    items: [
      "Feature: route/URL + Input/Output + Model/Component (vd. EmployeeList.vue)",
      "Bug: Steps to reproduce + Current vs Expected + error log/stack trace",
      "Hoặc Dev Notes rõ ràng (≥ ~25 từ + tín hiệu kỹ thuật: file/route/field/I/O/repro/docs)",
    ],
  },
  searchable: {
    title: "Searchable",
    items: [
      "Có mỏ neo để search: UI text, field name, API path, hoặc route — nhưng chưa chỉ rõ file",
      "Agent phải grep/search trước khi sửa",
    ],
  },
  bad: {
    title: "Bad",
    items: [
      "Chỉ title mơ hồ / mô tả chung chung, thiếu route, file, bước tái hiện",
      "Bổ sung Dev Notes hoặc chat rồi Run lại",
    ],
  },
};
