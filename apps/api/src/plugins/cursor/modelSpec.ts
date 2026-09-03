import {
  formatCursorModelLabel,
  parseCursorModel,
  type CursorModelSpec,
} from "@flow/shared";

/** Stored settings value → Cursor SDK `model` field. */
export function toAgentModel(raw?: string | null): CursorModelSpec {
  return parseCursorModel(raw);
}

export function cursorModelLogLabel(raw?: string | null): string {
  return formatCursorModelLabel(raw);
}
