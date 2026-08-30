import { describe, expect, it } from "vitest";
import { listQuery } from "../index.js";
import type { Request } from "express";

function fakeReq(partial: {
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): Request {
  return {
    query: partial.query ?? {},
    body: partial.body ?? {},
  } as unknown as Request;
}

describe("listQuery", () => {
  it("parses sort=field:desc", () => {
    const q = listQuery(fakeReq({ query: { sort: "updatedAt:desc" } }));
    expect(q.sort).toEqual({ updatedAt: -1 });
  });

  it("parses -field shorthand", () => {
    const q = listQuery(fakeReq({ query: { sort: "-createdAt,name" } }));
    expect(q.sort).toEqual({ createdAt: -1, name: 1 });
  });

  it("parses HTS sortModel from body", () => {
    const q = listQuery(
      fakeReq({
        body: {
          sortModel: [
            { colId: "name", sort: "asc" },
            { colId: "updatedAt", sort: "desc" },
          ],
        },
      }),
    );
    expect(q.sort).toEqual({ name: 1, updatedAt: -1 });
  });

  it("applies page + limit to skip", () => {
    const q = listQuery(
      fakeReq({ query: { page: "2", limit: "25" } }),
      { sort: { createdAt: -1 } },
    );
    expect(q.limit).toBe(25);
    expect(q.skip).toBe(25);
  });

  it("caps limit at 500", () => {
    const q = listQuery(fakeReq({ query: { limit: "9999" } }));
    expect(q.limit).toBe(500);
  });
});
