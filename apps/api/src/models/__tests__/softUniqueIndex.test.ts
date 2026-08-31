/**
 * Soft-delete + unique index interaction.
 * Unique indexes MUST use partialFilterExpression for active rows only
 * (or softUnique) so soft-deleted rows do not block re-create of username/slug/job.
 */
import { describe, expect, it } from "vitest";
import { softUniqueOptions, withActive } from "../base.js";

describe("soft-delete index helpers", () => {
  it("softUniqueOptions sets partialFilterExpression for active rows only", () => {
    const opts = softUniqueOptions("slug_soft_unique");
    expect(opts.unique).toBe(true);
    expect(opts.name).toBe("slug_soft_unique");
    expect(opts.partialFilterExpression).toEqual({ deleted: false });
  });

  it("withActive excludes deleted:true and keeps missing/false", () => {
    expect(withActive({ id: "a" })).toEqual({
      $and: [
        { id: "a" },
        { $or: [{ deleted: { $exists: false } }, { deleted: false }] },
      ],
    });
  });
});
