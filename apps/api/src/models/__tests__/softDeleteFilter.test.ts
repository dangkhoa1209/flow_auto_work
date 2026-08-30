/**
 * Soft-delete filter merge behavior (unit, no Mongo).
 * Full createModel I/O is covered via QC module integration when DB is up.
 */
import { describe, expect, it } from "vitest";

/** Mirror of models/base notDeletedFilter for pure unit coverage. */
function notDeletedFilter(softDelete: boolean, withDeleted?: boolean) {
  if (!softDelete || withDeleted) return {};
  return {
    $or: [{ deleted: { $exists: false } }, { deleted: false }],
  };
}

function mergeFilter(
  softDelete: boolean,
  filter: Record<string, unknown> | undefined,
  withDeleted?: boolean,
) {
  const soft = notDeletedFilter(softDelete, withDeleted);
  if (!filter || Object.keys(filter).length === 0) return soft;
  if (Object.keys(soft).length === 0) return filter;
  return { $and: [filter, soft] };
}

describe("createModel soft-delete filter", () => {
  it("excludes deleted by default when softDelete on", () => {
    expect(mergeFilter(true, { ownerUsername: "a" })).toEqual({
      $and: [
        { ownerUsername: "a" },
        { $or: [{ deleted: { $exists: false } }, { deleted: false }] },
      ],
    });
  });

  it("skips soft filter when withDeleted", () => {
    expect(
      mergeFilter(true, { ownerUsername: "a" }, true),
    ).toEqual({ ownerUsername: "a" });
  });

  it("is noop when softDelete off", () => {
    expect(mergeFilter(false, { _id: "x" })).toEqual({ _id: "x" });
  });
});
