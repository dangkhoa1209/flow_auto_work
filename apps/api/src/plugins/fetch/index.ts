import type { Request } from "express";
import type { Sort } from "mongodb";

export type SortModelItem = {
  colId: string;
  sort: "asc" | "desc";
};

export type ListQuery = {
  sort: Sort;
  skip: number;
  limit: number;
  /** Raw sortModel when provided (HTS / ag-grid style) */
  sortModel: SortModelItem[];
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

type SortMap = Record<string, 1 | -1>;

function parseSortString(raw: string): SortMap {
  const sort: SortMap = {};
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const [field, dir] = token.includes(":")
      ? token.split(":")
      : token.startsWith("-")
        ? [token.slice(1), "desc"]
        : [token, "asc"];
    if (!field) continue;
    const key = field.trim();
    if (!/^[a-zA-Z0-9_.]+$/.test(key)) continue;
    const d = (dir || "asc").toLowerCase();
    sort[key] = d === "desc" || d === "-1" ? -1 : 1;
  }
  return sort;
}

function sortFromModel(model: SortModelItem[]): SortMap {
  const sort: SortMap = {};
  for (const item of model) {
    const key = String(item.colId || "").trim();
    if (!key || !/^[a-zA-Z0-9_.]+$/.test(key)) continue;
    sort[key] = item.sort === "desc" ? -1 : 1;
  }
  return sort;
}

function parseSortModel(raw: unknown): SortModelItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SortModelItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const colId = String((item as { colId?: unknown }).colId || "").trim();
    const sortRaw = String((item as { sort?: unknown }).sort || "asc")
      .toLowerCase()
      .trim();
    if (!colId) continue;
    out.push({
      colId,
      sort: sortRaw === "desc" ? "desc" : "asc",
    });
  }
  return out;
}

/**
 * Parse list/sort/pagination from query or JSON body (HTS `req.fetch`-lite).
 *
 * Supported:
 * - `sort=updatedAt:desc` or `sort=-createdAt,name`
 * - `sortModel=[{colId,sort}]` (query JSON string or body)
 * - `limit`, `skip`, or `page` (1-based with limit)
 */
export function listQuery(
  req: Request,
  defaults?: { sort?: Sort; limit?: number },
): ListQuery {
  const q = req.query as Record<string, unknown>;
  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};

  let sortModel = parseSortModel(body.sortModel);
  if (!sortModel.length && typeof q.sortModel === "string") {
    try {
      sortModel = parseSortModel(JSON.parse(q.sortModel));
    } catch {
      sortModel = [];
    }
  }

  let sort: Sort = defaults?.sort ?? { updatedAt: -1 };
  if (sortModel.length) {
    const fromModel = sortFromModel(sortModel);
    if (Object.keys(fromModel).length) sort = fromModel;
  } else {
    const sortRaw = String(q.sort ?? body.sort ?? "").trim();
    if (sortRaw) {
      const parsed = parseSortString(sortRaw);
      if (Object.keys(parsed).length) sort = parsed;
    }
  }

  const rawLimit = Number(q.limit ?? body.limit ?? defaults?.limit ?? DEFAULT_LIMIT);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT),
  );

  let skip = Number(q.skip ?? body.skip ?? 0);
  if (!Number.isFinite(skip) || skip < 0) skip = 0;
  const page = Number(q.page ?? body.page ?? 0);
  if (Number.isFinite(page) && page >= 1) {
    skip = (page - 1) * limit;
  }

  return { sort, skip, limit, sortModel };
}
