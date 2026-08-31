import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type Collection } from "mongodb";
import { getConfig } from "../../config.js";
import { connectMongo } from "../../models/connection.js";
import { withActive, softDeleteActiveFields, purgeSoftDeleted } from "../../models/base.js";
import { BuildScriptModel, type BuildScriptDoc } from "../../models/devops.js";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import type { WhitelistedScript } from "./types.js";

export type { BuildScriptDoc } from "../../models/devops.js";

export const SCRIPT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const scriptSchema = z.object({
  id: z.string().regex(SCRIPT_ID_RE, "id: chữ, số, gạch ngang/dưới"),
  label: z.string().trim().min(1).max(80),
  command: z.string().min(1).max(4000),
  workingDir: z.string().min(1).max(500),
  timeoutSec: z.number().int().positive().max(86_400).optional(),
  description: z.string().trim().max(240).optional(),
  active: z.boolean().optional(),
});

export type ScriptInput = {
  id?: string;
  label?: string;
  command?: string;
  workingDir?: string;
  timeoutSec?: number | null;
  description?: string;
  active?: boolean;
};

const COLLECTION = "build_scripts";
let indexesReady = false;

async function scriptsCol(): Promise<Collection<BuildScriptDoc>> {
  if (!indexesReady) {
    await BuildScriptModel.ensureIndexes();
    indexesReady = true;
  }
  return (await BuildScriptModel.col()) as Collection<BuildScriptDoc>;
}

function normalizeCommand(command: string): string {
  if (command.includes("\0")) {
    throw new AppError("command chứa ký tự không hợp lệ", 400, "invalid_script");
  }
  const joined = command
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" && ");
  if (!joined) {
    throw new AppError("command required", 400, "invalid_script");
  }
  if (joined.length > 4000) {
    throw new AppError("command quá dài (max 4000)", 400, "invalid_script");
  }
  return joined;
}

/** Relative paths and `~/…` resolve against the process cwd / home. */
export function resolveWorkingDir(workingDir: string): string {
  const trimmed = workingDir.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new AppError("workingDir required", 400, "invalid_script");
  }
  const expanded =
    trimmed === "~"
      ? process.env.HOME || trimmed
      : trimmed.startsWith("~/")
        ? path.join(process.env.HOME || "", trimmed.slice(2))
        : trimmed;
  return path.resolve(expanded);
}

export function slugScriptId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "script";
}

export function normalizeScriptInput(
  raw: ScriptInput,
  opts?: { requireId?: boolean },
): WhitelistedScript {
  const idRaw = (raw.id || slugScriptId(String(raw.label || ""))).trim();
  const parsed = scriptSchema.safeParse({
    id: idRaw,
    label: String(raw.label || "").trim(),
    command: normalizeCommand(String(raw.command || "")),
    workingDir: resolveWorkingDir(String(raw.workingDir || "")),
    timeoutSec:
      raw.timeoutSec == null ||
      raw.timeoutSec === ("" as never) ||
      !Number.isFinite(Number(raw.timeoutSec)) ||
      Number(raw.timeoutSec) <= 0
        ? undefined
        : Number(raw.timeoutSec),
    description: raw.description?.trim() || undefined,
    active: raw.active === undefined ? undefined : Boolean(raw.active),
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new AppError(detail || "Invalid script", 400, "invalid_script");
  }
  if (opts?.requireId && !SCRIPT_ID_RE.test(idRaw)) {
    throw new AppError("id không hợp lệ", 400, "invalid_script");
  }
  const data = parsed.data;
  return {
    id: data.id,
    label: data.label,
    command: data.command,
    workingDir: data.workingDir,
    timeoutSec: data.timeoutSec,
    description: data.description,
    active: data.active ?? true,
  };
}

/**
 * Parse a JSON array of scripts (env seed / tests).
 */
export function parseBuildScripts(raw: string): WhitelistedScript[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AppError(
      "BUILD_SCRIPTS is not valid JSON — expected an array of {id,label,command,workingDir}",
      500,
      "build_catalog_invalid",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new AppError(
      "BUILD_SCRIPTS must be a JSON array",
      500,
      "build_catalog_invalid",
    );
  }
  const seen = new Set<string>();
  const scripts: WhitelistedScript[] = [];
  for (const item of parsed) {
    const rec = (item ?? {}) as ScriptInput;
    const data = normalizeScriptInput(rec, { requireId: true });
    if (seen.has(data.id)) {
      throw new AppError(
        `Duplicate build script id: ${data.id}`,
        500,
        "build_catalog_invalid",
      );
    }
    seen.add(data.id);
    scripts.push(data);
  }
  return scripts;
}

function envSeedScripts(): WhitelistedScript[] {
  const cfg = getConfig();
  const file = cfg.BUILD_SCRIPTS_FILE?.trim();
  if (file) {
    const abs = path.resolve(file);
    if (!existsSync(abs)) {
      throw new AppError(
        `BUILD_SCRIPTS_FILE not found: ${abs}`,
        500,
        "build_catalog_invalid",
      );
    }
    return parseBuildScripts(readFileSync(abs, "utf8"));
  }
  return parseBuildScripts(cfg.BUILD_SCRIPTS ?? "");
}

export async function seedBuildScriptsIfEmpty(): Promise<number> {
  const col = await scriptsCol();
  const count = await col.countDocuments(withActive({}));
  if (count > 0) return 0;
  const seed = envSeedScripts();
  if (!seed.length) return 0;
  const now = new Date().toISOString();
  await col.insertMany(
    seed.map((s) => ({
      ...s,
      createdBy: "env",
      createdAt: now,
      updatedAt: now,
      ...softDeleteActiveFields(),
    })),
  );
  logger.info("Seeded build scripts from env", {
    count: seed.length,
    ids: seed.map((s) => s.id),
  });
  return seed.length;
}

function toPublic(doc: BuildScriptDoc): WhitelistedScript {
  return {
    id: doc.id,
    label: doc.label,
    command: doc.command,
    workingDir: doc.workingDir,
    timeoutSec: doc.timeoutSec,
    description: doc.description,
    active: doc.active !== false,
  };
}

export async function listWhitelistedScripts(): Promise<WhitelistedScript[]> {
  const docs = await (await scriptsCol())
    .find(withActive({}))
    .sort({ updatedAt: -1 })
    .toArray();
  return docs.map(toPublic);
}

export async function getWhitelistedScript(
  scriptId: string,
): Promise<WhitelistedScript | null> {
  const id = scriptId.trim();
  if (!SCRIPT_ID_RE.test(id)) return null;
  const doc = await (await scriptsCol()).findOne(withActive({ id }));
  return doc ? toPublic(doc) : null;
}

export async function requireWhitelistedScript(
  scriptId: string,
): Promise<WhitelistedScript> {
  const id = (scriptId || "").trim();
  if (!SCRIPT_ID_RE.test(id)) {
    throw new AppError(
      "scriptId must be alphanumeric (dash/underscore allowed)",
      400,
      "invalid_script",
    );
  }
  const script = await getWhitelistedScript(id);
  if (!script) {
    throw new AppError(
      `Unknown scriptId "${id}" — thêm lệnh trên trang Devops trước`,
      400,
      "script_not_whitelisted",
    );
  }
  return script;
}

export async function createBuildScript(
  raw: ScriptInput,
  createdBy: string,
): Promise<WhitelistedScript> {
  const data = normalizeScriptInput(raw, { requireId: true });
  const now = new Date().toISOString();
  const col = await scriptsCol();
  await purgeSoftDeleted(col, { id: data.id });
  try {
    await col.insertOne({
      ...data,
      createdBy,
      createdAt: now,
      updatedAt: now,
      ...softDeleteActiveFields(),
    });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new AppError(
        `Script id "${data.id}" đã tồn tại`,
        409,
        "script_exists",
      );
    }
    throw err;
  }
  return data;
}

export async function updateBuildScript(
  scriptId: string,
  raw: ScriptInput,
): Promise<WhitelistedScript> {
  const existing = await requireWhitelistedScript(scriptId);
  const data = normalizeScriptInput(
    {
      id: existing.id,
      label: raw.label ?? existing.label,
      command: raw.command ?? existing.command,
      workingDir: raw.workingDir ?? existing.workingDir,
      timeoutSec:
        raw.timeoutSec === undefined ? existing.timeoutSec : raw.timeoutSec,
      description:
        raw.description === undefined ? existing.description : raw.description,
      active: raw.active === undefined ? existing.active : raw.active,
    },
    { requireId: true },
  );
  const now = new Date().toISOString();
  await (
    await scriptsCol()
  ).updateOne(
    { id: existing.id },
    {
      $set: {
        label: data.label,
        command: data.command,
        workingDir: data.workingDir,
        timeoutSec: data.timeoutSec,
        description: data.description,
        active: data.active,
        updatedAt: now,
      },
    },
  );
  return data;
}

export async function deleteBuildScript(scriptId: string): Promise<void> {
  const id = scriptId.trim();
  const n = await BuildScriptModel.softDeleteMany({ id });
  if (!n) {
    throw new AppError("Script not found", 404, "script_not_found");
  }
}
