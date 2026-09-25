import type { Filter } from "mongodb";
import { CursorUsageModel, type CursorUsageDoc, type CursorUsageEvent } from "../../models/cursorUsage.js";
import { WorkspaceUserModel } from "../../models/workspace.js";
import {
  CURSOR_USAGE_KINDS,
  CURSOR_USAGE_STATUSES,
  USAGE_KIND_LABELS,
  USAGE_STATUS_LABELS,
  type CursorUsageKind,
  type CursorUsageStatus,
} from "../../plugins/cursor/usageNormalize.js";
import {
  dayKeyFromIso,
  enumerateDays,
  shiftYmd,
  STATS_TZ,
} from "../stats/calendar.js";
import {
  normalizeUserRoles,
  type UserRole,
} from "../../workspace/types.js";

const EVENT_SCAN_LIMIT = 50_000;
const DETAIL_EVENTS = 200;

const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  ba: "BA",
  pd: "PD",
  dev: "Dev",
  qc: "QC",
  devops: "DevOps",
};

export type AdminCursorUsageQuery = {
  days?: number;
  from?: string;
  to?: string;
  userId?: string;
  kind?: string;
  role?: string;
  status?: string;
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

function parseStatus(raw?: string): CursorUsageStatus | undefined {
  if (!raw?.trim()) return undefined;
  const s = raw.trim() as CursorUsageStatus;
  return (CURSOR_USAGE_STATUSES as readonly string[]).includes(s) ? s : undefined;
}

function parseRole(raw?: string): UserRole | undefined {
  if (!raw?.trim()) return undefined;
  const r = raw.trim().toLowerCase() as UserRole;
  return r in ROLE_LABELS ? r : undefined;
}

export type UsageBucket = {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  errorEvents: number;
  cancelledEvents: number;
};

function emptyBucket(): UsageBucket {
  return {
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    errorEvents: 0,
    cancelledEvents: 0,
  };
}

function addEvent(b: UsageBucket, e: CursorUsageEvent): void {
  b.events += 1;
  b.inputTokens += e.inputTokens || 0;
  b.outputTokens += e.outputTokens || 0;
  b.cacheReadTokens += e.cacheReadTokens || 0;
  b.cacheWriteTokens += e.cacheWriteTokens || 0;
  b.totalTokens += e.totalTokens || 0;
  const st = e.status || "ok";
  if (st === "error") b.errorEvents += 1;
  if (st === "cancelled") b.cancelledEvents += 1;
}

function eventRoles(
  e: CursorUsageEvent,
  rolesByUser: Map<string, UserRole[]>,
): UserRole[] {
  if (e.roles?.length) return normalizeUserRoles(e.roles);
  const uid = (e.userId || "").trim().toLowerCase();
  return rolesByUser.get(uid) || [];
}

export function rollupCursorUsageEvents(
  events: CursorUsageEvent[],
  fromYmd: string,
  toYmd: string,
  rolesByUser: Map<string, UserRole[]> = new Map(),
) {
  const totals = emptyBucket();
  const byUser = new Map<string, UsageBucket>();
  const byKind = new Map<string, UsageBucket>();
  const byRole = new Map<string, UsageBucket>();
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

    const roles = eventRoles(e, rolesByUser);
    const roleKeys = roles.length ? roles : (["unknown"] as const);
    for (const role of roleKeys) {
      let r = byRole.get(role);
      if (!r) {
        r = emptyBucket();
        byRole.set(role, r);
      }
      addEvent(r, e);
    }

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
    ...(byDay.get(date) || emptyBucket()),
  }));

  return {
    totals,
    byUser: [...byUser.entries()]
      .map(([userId, b]) => ({ userId, ...b }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.events - a.events),
    byKind: [...byKind.entries()]
      .map(([kind, b]) => ({
        kind,
        label: USAGE_KIND_LABELS[kind as CursorUsageKind] || kind,
        ...b,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    byRole: [...byRole.entries()]
      .map(([role, b]) => ({
        role,
        label: ROLE_LABELS[role as UserRole] || role,
        ...b,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.events - a.events),
    byDay: days,
    byUserDay,
  };
}

function mapEventDetail(e: CursorUsageEvent, nameById: Map<string, string>) {
  const roles = normalizeUserRoles(e.roles);
  return {
    id: e.id,
    createdAt: e.createdAt,
    kind: e.kind,
    kindLabel: USAGE_KIND_LABELS[e.kind] || e.kind,
    status: e.status || "ok",
    statusLabel: USAGE_STATUS_LABELS[(e.status || "ok") as CursorUsageStatus],
    roles,
    roleLabels: roles.map((r) => ROLE_LABELS[r] || r),
    userId: e.userId,
    displayName: nameById.get(e.userId) || undefined,
    model: e.model || null,
    jobId: e.jobId || null,
    threadId: e.threadId || null,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheReadTokens: e.cacheReadTokens,
    totalTokens: e.totalTokens,
    fromSdk: e.fromSdk,
  };
}

export async function adminGetCursorUsage(query: AdminCursorUsageQuery) {
  const { days, fromYmd, toYmd } = windowYmd(query.days ?? 30, query.from, query.to);
  const userId = query.userId?.trim().toLowerCase() || undefined;
  const kind = parseKind(query.kind);
  const role = parseRole(query.role);
  const status = parseStatus(query.status);
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
  if (status) filter.status = status;
  // Role filter is applied in memory so legacy rows (no roles[]) still match
  // via the user's current workspace roles.

  const scanned = await CursorUsageModel.findMany({
    filter,
    sort: { createdAt: -1 },
    limit: EVENT_SCAN_LIMIT + 1,
  });
  const truncated = scanned.length > EVENT_SCAN_LIMIT;
  let rows = (truncated ? scanned.slice(0, EVENT_SCAN_LIMIT) : scanned) as CursorUsageEvent[];

  const users = await WorkspaceUserModel.findMany({ limit: 5000 });
  const nameById = new Map<string, string>();
  const rolesByUser = new Map<string, UserRole[]>();
  for (const u of users) {
    const id = String(u.id || u.gitlabUsername || "").toLowerCase();
    if (!id) continue;
    nameById.set(id, u.displayName || u.gitlabUsername || id);
    rolesByUser.set(id, normalizeUserRoles(u.roles));
  }

  if (role) {
    rows = rows.filter((e) => eventRoles(e, rolesByUser).includes(role));
  }

  const rolled = rollupCursorUsageEvents(rows, fromYmd, toYmd, rolesByUser);

  const byUser = rolled.byUser.map((row) => ({
    ...row,
    displayName: nameById.get(row.userId) || undefined,
    roles: rolesByUser.get(row.userId) || [],
    roleLabels: (rolesByUser.get(row.userId) || []).map(
      (r) => ROLE_LABELS[r] || r,
    ),
  }));

  const selectedUserDays =
    userId && rolled.byUserDay.get(userId)
      ? enumerateDays(fromYmd, toYmd).map((date) => ({
          date,
          ...(rolled.byUserDay.get(userId)!.get(date) || emptyBucket()),
        }))
      : undefined;

  const events = rows.slice(0, DETAIL_EVENTS).map((e) =>
    mapEventDetail(e, nameById),
  );

  return {
    timezone: STATS_TZ,
    days,
    from: fromYmd,
    to: toYmd,
    truncated,
    userId: userId || null,
    kind: kind || null,
    role: role || null,
    status: status || null,
    kinds: CURSOR_USAGE_KINDS.map((k) => ({
      id: k,
      label: USAGE_KIND_LABELS[k],
    })),
    roles: (Object.keys(ROLE_LABELS) as UserRole[]).map((r) => ({
      id: r,
      label: ROLE_LABELS[r],
    })),
    statuses: CURSOR_USAGE_STATUSES.map((s) => ({
      id: s,
      label: USAGE_STATUS_LABELS[s],
    })),
    totals: rolled.totals,
    byUser,
    byKind: rolled.byKind,
    byRole: rolled.byRole,
    byDay: rolled.byDay,
    userDays: selectedUserDays,
    events,
  };
}
