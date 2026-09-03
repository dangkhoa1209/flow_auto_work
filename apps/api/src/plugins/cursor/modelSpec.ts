import {
  formatCursorModelLabel,
  toSdkCursorModel,
  type CursorModelSpec,
} from "@flow/shared";

/** Stored settings value → Cursor SDK `model` field (`default` + optional mode). */
export function toAgentModel(raw?: string | null): CursorModelSpec {
  return toSdkCursorModel(raw);
}

export function cursorModelLogLabel(raw?: string | null): string {
  return formatCursorModelLabel(raw);
}
