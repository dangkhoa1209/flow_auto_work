export type TaskType = "bug" | "feature" | "refactor" | "chore" | "other";

export type TaskTypeLabelMapping = {
  bug: string[];
  feature: string[];
  refactor: string[];
  chore: string[];
};

export const DEFAULT_TASK_TYPE_LABELS: TaskTypeLabelMapping = {
  bug: ["bug", "fix", "hotfix", "defect"],
  feature: ["feature", "enhancement", "story"],
  refactor: ["refactor", "cleanup"],
  chore: ["chore", "maintenance", "ci", "docs"],
};

const TYPE_ORDER: (keyof TaskTypeLabelMapping)[] = [
  "bug",
  "refactor",
  "chore",
  "feature",
];

function normLabel(s: string): string {
  return s.trim().toLowerCase();
}

function normList(items: string[]): string[] {
  return [...new Set(items.map(normLabel).filter(Boolean))];
}

/** Normalize admin mapping — fall back to defaults for empty groups. */
export function normalizeTaskTypeLabels(
  raw?: Partial<TaskTypeLabelMapping> | null,
): TaskTypeLabelMapping {
  const d = DEFAULT_TASK_TYPE_LABELS;
  return {
    bug: normList(raw?.bug?.length ? raw.bug : d.bug),
    feature: normList(raw?.feature?.length ? raw.feature : d.feature),
    refactor: normList(raw?.refactor?.length ? raw.refactor : d.refactor),
    chore: normList(raw?.chore?.length ? raw.chore : d.chore),
  };
}

function labelMatches(issueLabel: string, configured: string): boolean {
  const a = normLabel(issueLabel);
  const b = normLabel(configured);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Classify from GitLab labels using admin mapping; no labels → feature. */
export function classifyTaskType(
  _title: string,
  labels: string[] = [],
  mapping: TaskTypeLabelMapping = DEFAULT_TASK_TYPE_LABELS,
): TaskType {
  const issueLabels = labels.map((l) => l.trim()).filter(Boolean);
  if (!issueLabels.length) return "feature";

  const cfg = normalizeTaskTypeLabels(mapping);
  for (const type of TYPE_ORDER) {
    const configured = cfg[type];
    if (
      issueLabels.some((il) =>
        configured.some((cl) => labelMatches(il, cl)),
      )
    ) {
      return type;
    }
  }
  return "feature";
}

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  bug: "Bug fix",
  feature: "Tính năng",
  refactor: "Refactor",
  chore: "Chore / CI",
  other: "Khác",
};
