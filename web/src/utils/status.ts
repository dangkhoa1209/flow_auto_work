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

/**
 * Ant Design tag color — semantic map for workbench.
 * draft→gray, running→blue, clarify→orange, handoff→teal, success→green, danger→red
 */
export function statusColor(status: string | null | undefined): string {
  const st = status || "";
  if (st === "succeeded") return "success";
  if (st === "failed") return "error";
  if (st === "running" || st === "queued") return "processing";
  if (st === "awaiting_clarification") return "orange";
  if (st === "awaiting_handoff") return "cyan";
  if (st === "awaiting_docs_approval" || st === "awaiting_diff_approval") {
    return "purple";
  }
  if (st === "draft") return "default";
  if (st.startsWith("awaiting")) return "warning";
  return "default";
}

/** Tailwind classes for semantic status chips (non-Ant) */
export function statusToneClass(status: string | null | undefined): string {
  const st = status || "";
  if (st === "succeeded") return "bg-green-50 text-green-700 border-green-200";
  if (st === "failed") return "bg-red-50 text-red-700 border-red-200";
  if (st === "running" || st === "queued") {
    return "bg-blue-50 text-blue-700 border-blue-200";
  }
  if (st === "awaiting_clarification") {
    return "bg-orange-50 text-orange-700 border-orange-200";
  }
  if (st === "awaiting_handoff") {
    return "bg-teal-50 text-teal-700 border-teal-200";
  }
  if (st === "awaiting_docs_approval" || st === "awaiting_diff_approval") {
    return "bg-violet-50 text-violet-700 border-violet-200";
  }
  return "bg-gray-50 text-gray-600 border-gray-200";
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
