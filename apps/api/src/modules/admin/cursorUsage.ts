import type { Filter } from "mongodb";
import { CursorUsageModel, type CursorUsageDoc, type CursorUsageEvent } from "../../models/cursorUsage.js";
import { WorkspaceUserModel } from "../../models/workspace.js";
import {
  CURSOR_USAGE_KINDS,
  USAGE_KIND_LABELS,
  type CursorUsageKind,
} from "../../plugins/cursor/usageNormalize.js";
import {
  dayKeyFromIso,
  enumerateDays,
  shiftYmd,
  STATS_TZ,
} from "../stats/calendar.js";

const EVENT_SCAN_LIMIT = 50_000;
const DETAIL_EVENTS = 120;

export type AdminCursorUsageQuery = {
  days?: number;
  from?: string;
  to?: string;
  userId?: string;
  kind?: string;
};

function parseYmd(s: string | undefined): string | null {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function ymdToUtcRange(ymd: string, endOfDay: boolean): Date {
  const [Y, M, D] = ymd.split("-").map(Number);
  if (!endOfDay) {
    return new Date(Date.UTC(Y, M - 1, D) - 7 * 3600_000);
  }
  return new Date(Date.UTC(Y, M - 1, D, 16, 59, 59, 999));
}

function windowYmd(daysRaw: number, from?: string, to?: string) {
  const days = Math.min(365, Math.max(1, Number(daysRaw || 30)));
  const toYmd =
    parseYmd(to) ||
    new Intl.DateTimeFormat("en-CA", {
      timeZone: STATS_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  const fromParsed = parseYmd(from);
  const fromYmd = fromParsed || shiftYmd(toYmd, -(days - 1));
  const span =
    (Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) /
      86400000 +
    1;
  return {
    days: Math.min(365, Math.max(1, Math.round(span))),
    fromYmd,
    toYmd,
  };
}

function parseKind(raw?: string): CursorUsageKind | undefined {
  if (!raw?.trim()) return undefined;
  const k = raw.trim() as CursorUsageKind;
  return (CURSOR_USAGE_KINDS as readonly string[]).includes(k) ? k : undefined;
}

export type UsageBucket = {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costCents: number;
  chargedCents: number;
  estimatedCents: number;
  sdkEvents: number;
};

function emptyBucket(): UsageBucket {
  return {
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costCents: 0,
    chargedCents: 0,
    estimatedCents: 0,
    sdkEvents: 0,
  };
}

function addEvent(b: UsageBucket, e: CursorUsageEvent): void {
  b.events += 1;
  b.inputTokens += e.inputTokens || 0;
  b.outputTokens += e.outputTokens || 0;
  b.cacheReadTokens += e.cacheReadTokens || 0;
  b.cacheWriteTokens += e.cacheWriteTokens || 0;
  b.totalTokens += e.totalTokens || 0;
  b.costCents += e.costCents || 0;
  b.chargedCents += e.chargedCents || 0;
  b.estimatedCents += e.estimatedCents || 0;
  if (e.costSource === "sdk") b.sdkEvents += 1;
}

function withUsd(b: UsageBucket) {
  return {
    ...b,
    costUsd: Math.round(b.costCents) / 100,
    chargedUsd: Math.round(b.chargedCents) / 100,
    estimatedUsd: Math.round(b.estimatedCents) / 100,
  };
}

export function rollupCursorUsageEvents(
  events: CursorUsageEvent[],
  fromYmd: string,
  toYmd: string,
) {
  const totals = emptyBucket();
  const byUser = new Map<string, UsageBucket>();
  const byKind = new Map<string, UsageBucket>();
  const byDay = new Map<string, UsageBucket>();
  const byUserDay = new Map<string, Map<string, UsageBucket>>();

  for (const e of events) {
    addEvent(totals, e);
    const uid = (e.userId || "unknown").trim() || "unknown";
    let u = byUser.get(uid);
    if (!u) {
      u = emptyBucket();
      byUser.set(uid, u);
    }
    addEvent(u, e);

    const kind = e.kind || "job_legacy";
    let k = byKind.get(kind);
    if (!k) {
      k = emptyBucket();
      byKind.set(kind, k);
    }
    addEvent(k, e);

    const day = dayKeyFromIso(e.createdAt) || e.createdAt.slice(0, 10);
    let d = byDay.get(day);
    if (!d) {
      d = emptyBucket();
      byDay.set(day, d);
    }
    addEvent(d, e);

    let ud = byUserDay.get(uid);
    if (!ud) {
      ud = new Map();
      byUserDay.set(uid, ud);
    }
    let udd = ud.get(day);
    if (!udd) {
      udd = emptyBucket();
      ud.set(day, udd);
    }
    addEvent(udd, e);
  }

  const days = enumerateDays(fromYmd, toYmd).map((date) => ({
    date,
    ...withUsd(byDay.get(date) || emptyBucket()),
  }));

  return {
    totals: withUsd(totals),
    byUser: [...byUser.entries()]
      .map(([userId, b]) => ({ userId, ...withUsd(b) }))
      .sort((a, b) => b.costCents - a.costCents || b.totalTokens - a.totalTokens),
    byKind: [...byKind.entries()]
      .map(([kind, b]) => ({
        kind,
        label: USAGE_KIND_LABELS[kind as CursorUsageKind] || kind,
        ...withUsd(b),
      }))
      .sort((a, b) => b.costCents - a.costCents),
    byDay: days,
    byUserDay,
  };
}

export async function adminGetCursorUsage(query: AdminCursorUsageQuery) {
  const { days, fromYmd, toYmd } = windowYmd(query.days ?? 30, query.from, query.to);
  const userId = query.userId?.trim().toLowerCase() || undefined;
  const kind = parseKind(query.kind);
  const rangeStart = ymdToUtcRange(fromYmd, false);
  const rangeEnd = ymdToUtcRange(toYmd, true);

  const filter: Filter<CursorUsageDoc> = {
    createdAt: {
      $gte: rangeStart.toISOString(),
      $lte: rangeEnd.toISOString(),
    },
  };
  if (userId) filter.userId = userId;
  if (kind) filter.kind = kind;

  const scanned = await CursorUsageModel.findMany({
    filter,
    sort: { createdAt: -1 },
    limit: EVENT_SCAN_LIMIT + 1,
  });
  const truncated = scanned.length > EVENT_SCAN_LIMIT;
  const rows = (truncated ? scanned.slice(0, EVENT_SCAN_LIMIT) : scanned) as CursorUsageEvent[];

  const rolled = rollupCursorUsageEvents(rows, fromYmd, toYmd);

  const users = await WorkspaceUserModel.findMany({ limit: 5000 });
  const nameById = new Map<string, string>();
  for (const u of users) {
    const id = String(u.id || u.gitlabUsername || "").toLowerCase();
    if (id) nameById.set(id, u.displayName || u.gitlabUsername || id);
  }

  const byUser = rolled.byUser.map((row) => ({
    ...row,
    displayName: nameById.get(row.userId) || undefined,
  }));

  const selectedUserDays =
    userId && rolled.byUserDay.get(userId)
      ? enumerateDays(fromYmd, toYmd).map((date) => ({
          date,
          ...withUsd(rolled.byUserDay.get(userId)!.get(date) || emptyBucket()),
        }))
      : undefined;

  const events = userId
    ? rows.slice(0, DETAIL_EVENTS).map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        kindLabel: USAGE_KIND_LABELS[e.kind] || e.kind,
        model: e.model || null,
        jobId: e.jobId || null,
        threadId: e.threadId || null,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens,
        totalTokens: e.totalTokens,
        costCents: e.costCents,
        costUsd: Math.round(e.costCents) / 100,
        costSource: e.costSource,
        fromSdk: e.fromSdk,
      }))
    : undefined;

  return {
    timezone: STATS_TZ,
    days,
    from: fromYmd,
    to: toYmd,
    truncated,
    userId: userId || null,
    kind: kind || null,
    kinds: CURSOR_USAGE_KINDS.map((k) => ({
      id: k,
      label: USAGE_KIND_LABELS[k],
    })),
    totals: rolled.totals,
    byUser,
    byKind: rolled.byKind,
    byDay: rolled.byDay,
    userDays: selectedUserDays,
    events,
  };
}
