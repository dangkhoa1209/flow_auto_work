import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);
const inFlight = new Set<string>();

/** Stamp in graphify-out — skip rebuild when HEAD + dirty tree unchanged. */
const STAMP_NAME = ".flow-graphify-stamp";

/**
 * WorkBench-owned graphify output for a customer checkout.
 * Never writes inside `source/` — keeps customer git clean.
 *
 * - `…/<slug>/source` → `…/<slug>/graphify-out`
 * - custom path → `<path>.graphify-out` (sibling-style suffix)
 */
export function graphifyOutDirForSource(sourcePath: string): string {
  const abs = path.resolve(sourcePath.trim());
  if (path.basename(abs) === "source") {
    return path.join(path.dirname(abs), "graphify-out");
  }
  return `${abs}.graphify-out`;
}

export function graphifyGraphJsonForSource(sourcePath: string): string {
  return path.join(graphifyOutDirForSource(sourcePath), "graph.json");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveGraphifyBin(): Promise<string | null> {
  const fromEnv = process.env.GRAPHIFY_BIN?.trim();
  if (fromEnv) {
    // Bare command name → PATH lookup. Absolute path must exist on this host.
    if (!fromEnv.includes("/") && !fromEnv.includes("\\")) {
      return fromEnv;
    }
    if (await pathExists(fromEnv)) return fromEnv;
    logger.warn("GRAPHIFY_BIN not found — falling back to auto-detect", {
      GRAPHIFY_BIN: fromEnv,
    });
  }

  const home = homedir();
  const candidates = [
    path.join(home, ".local/bin/graphify"),
    path.join(home, ".local/pipx/venvs/graphifyy/bin/graphify"),
    "/usr/local/bin/graphify",
    "/usr/bin/graphify",
    "/opt/flow-graphify/bin/graphify",
    // macOS user pip (dev laptops only)
    path.join(home, "Library/Python/3.12/bin/graphify"),
    path.join(home, "Library/Python/3.11/bin/graphify"),
    path.join(home, "Library/Python/3.10/bin/graphify"),
    "/opt/homebrew/bin/graphify",
  ];
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  // Last resort: process PATH (put graphify on PATH in systemd/docker).
  return "graphify";
}

export function graphifyEnabled(): boolean {
  const v = (process.env.GRAPHIFY_ENABLED || "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

function runSpawn(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: 1,
        stdout,
        stderr: err instanceof Error ? err.message : String(err),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function stampPath(outDir: string): string {
  return path.join(outDir, STAMP_NAME);
}

/** HEAD + porcelain status — detect commits and uncommitted edits. */
async function sourceChangeStamp(source: string): Promise<string | null> {
  try {
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const { stdout: dirty } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: source, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    return `${String(head).trim()}\n${String(dirty).trim()}`;
  } catch {
    return null;
  }
}

async function readStamp(outDir: string): Promise<string | null> {
  try {
    return (await readFile(stampPath(outDir), "utf8")).trim();
  } catch {
    return null;
  }
}

async function writeStamp(outDir: string, stamp: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(stampPath(outDir), `${stamp}\n`, "utf8");
}

async function runProjectGraphifyUpdate(
  source: string,
  reason: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  if (!(await pathExists(source))) {
    logger.warn("graphify skip — source missing", { source, reason });
    return false;
  }
  const bin = await resolveGraphifyBin();
  if (!bin) {
    logger.warn("graphify skip — binary not found", { source, reason });
    return false;
  }
  const outDir = graphifyOutDirForSource(source);
  const graphJson = path.join(outDir, "graph.json");
  const hasGraph = await pathExists(graphJson);
  const force = opts?.force === true || !hasGraph;

  const currentStamp = await sourceChangeStamp(source);
  if (!force && currentStamp) {
    const prev = await readStamp(outDir);
    if (prev && prev === currentStamp) {
      logger.info("graphify skip — source unchanged since last build", {
        source,
        reason,
      });
      return true;
    }
  }

  const args = force
    ? ["update", source, "--force"]
    : ["update", source];
  logger.info("graphify update starting", {
    source,
    outDir,
    reason,
    bin,
    mode: force ? "full" : "incremental",
  });
  const { code, stdout, stderr } = await runSpawn(
    bin,
    args,
    { ...process.env, GRAPHIFY_OUT: outDir },
    path.dirname(outDir),
    force ? 5 * 60_000 : 3 * 60_000,
  );
  if (code === 0) {
    if (currentStamp) {
      await writeStamp(outDir, currentStamp).catch(() => undefined);
    } else {
      const after = await sourceChangeStamp(source);
      if (after) await writeStamp(outDir, after).catch(() => undefined);
    }
    logger.info("graphify update ready", {
      source,
      outDir,
      reason,
      mode: force ? "full" : "incremental",
      detail: stdout.trim().slice(-400),
    });
    return true;
  }
  logger.warn("graphify update failed", {
    source,
    outDir,
    reason,
    code,
    stderr: stderr.trim().slice(-800),
  });
  return false;
}

/**
 * Fire-and-forget AST rebuild of the customer corpus into a sibling graphify-out.
 */
export function scheduleProjectGraphify(
  sourcePath: string,
  reason = "clone",
): void {
  if (!graphifyEnabled()) return;
  const source = path.resolve(sourcePath.trim());
  if (!source) return;
  if (inFlight.has(source)) return;
  inFlight.add(source);
  void (async () => {
    try {
      await runProjectGraphifyUpdate(source, reason);
    } finally {
      inFlight.delete(source);
    }
  })();
}

/**
 * Ensure sibling graph.json exists (build if missing). Returns false if disabled / failed.
 */
export async function ensureProjectGraphifyReady(
  sourcePath: string,
  opts?: { timeoutMs?: number },
): Promise<boolean> {
  if (!graphifyEnabled()) return false;
  const source = path.resolve(sourcePath.trim());
  const graphJson = graphifyGraphJsonForSource(source);
  if (await pathExists(graphJson)) return true;

  const timeoutMs = opts?.timeoutMs ?? 90_000;
  if (!inFlight.has(source)) {
    inFlight.add(source);
    void (async () => {
      try {
        await runProjectGraphifyUpdate(source, "ensure");
      } finally {
        inFlight.delete(source);
      }
    })();
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pathExists(graphJson)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return await pathExists(graphJson);
}

/**
 * Scoped graphify query against the sibling graph (for BA / agent prompts).
 */
export async function queryProjectGraphify(
  sourcePath: string,
  question: string,
  opts?: { budget?: number; timeoutMs?: number },
): Promise<string | null> {
  return runGraphifyReadCommand(sourcePath, ["query", question], opts);
}

export async function pathProjectGraphify(
  sourcePath: string,
  fromNode: string,
  toNode: string,
  opts?: { timeoutMs?: number },
): Promise<string | null> {
  return runGraphifyReadCommand(
    sourcePath,
    ["path", fromNode, toNode],
    opts,
  );
}

export async function explainProjectGraphify(
  sourcePath: string,
  concept: string,
  opts?: { timeoutMs?: number },
): Promise<string | null> {
  return runGraphifyReadCommand(sourcePath, ["explain", concept], opts);
}

async function runGraphifyReadCommand(
  sourcePath: string,
  cmdArgs: string[],
  opts?: { budget?: number; timeoutMs?: number },
): Promise<string | null> {
  if (!graphifyEnabled()) return null;
  const source = path.resolve(sourcePath.trim());
  const graphJson = graphifyGraphJsonForSource(source);
  if (!(await pathExists(graphJson))) return null;

  const cleaned = cmdArgs.map((a) => a.trim().replace(/\s+/g, " ").slice(0, 400));
  if (cleaned.some((a) => !a)) return null;

  const bin = await resolveGraphifyBin();
  if (!bin) return null;

  const args = [...cleaned];
  // insert after subcommand
  const sub = args[0];
  const rest = args.slice(1);
  const fullArgs =
    sub === "query"
      ? [
          "query",
          ...rest,
          "--graph",
          graphJson,
          "--budget",
          String(opts?.budget ?? 1800),
        ]
      : [sub, ...rest, "--graph", graphJson];

  const { code, stdout, stderr } = await runSpawn(
    bin,
    fullArgs,
    { ...process.env },
    path.dirname(graphJson),
    opts?.timeoutMs ?? 45_000,
  );
  if (code !== 0) {
    logger.warn("graphify command failed", {
      source,
      cmd: sub,
      code,
      stderr: stderr.trim().slice(-400),
    });
    return null;
  }
  const text = stdout.trim();
  return text || null;
}

/** Prompt block for BA agents — prefer custom tool code_map_* over grep. */
export function formatBaGraphifyPromptBlock(opts: {
  sourcePath: string;
  queryText: string | null;
}): string {
  const graphJson = graphifyGraphJsonForSource(opts.sourcePath);
  const outDir = graphifyOutDirForSource(opts.sourcePath);
  const map =
    opts.queryText?.trim() ||
    "(chưa có map sẵn — BẮT BUỘC gọi tool code_map_query trước khi Grep/Shell.)";
  return `## Code map (graphify — WorkBench)
Graph file (host): \`${graphJson}\` · out: \`${outDir}\` — **không** ghi gì trong \`source/\`.

**BẮT BUỘC khi INTENT = case 3 (cần tra source):**
1. Gọi tool **\`code_map_query\`** với câu hỏi nghiệp vụ (tiếng Việt OK) — **trước** mọi Grep / rg / find / Glob.
2. Chỉ sau map: đọc 1–3 file được map gợi ý, hoặc locale \`vi\`.
3. **Cấm** quét toàn repo bằng Grep/rg làm bước đầu. Grep chỉ khi map không đủ và đã thử \`code_map_query\` / \`code_map_explain\`.
4. Tools: \`code_map_query\`, \`code_map_path\`, \`code_map_explain\` (đã gắn sẵn — gọi như DB tool).

### Map sẵn cho câu hỏi hiện tại (điểm khởi đầu)
${map}`;
}

/** How Work agents should use graphify — no precomputed dump (title is too thin, full task is too noisy). */
export function formatWorkGraphifyPromptBlock(opts: {
  sourcePath: string;
}): string {
  const graphJson = graphifyGraphJsonForSource(opts.sourcePath);
  const outDir = graphifyOutDirForSource(opts.sourcePath);
  return `## How to use Graphify (code map)
Sibling graph (host): \`${graphJson}\` · \`${outDir}\` — do **not** write inside \`source/\`.
Tools already attached: \`code_map_query\`, \`code_map_path\`, \`code_map_explain\`.

**You choose the query.** Do not wait for a precomputed map. Do not paste the whole GitLab issue, description, or chat.

1. **Before** Grep / rg / Glob / find: call \`code_map_query\` with **one short locator** you extract from the task — a screen, module, feature slug, or symbol.
   - Good: \`cấu hình rules chấm công\`, \`staff import update by column\`, \`TimekeeperSync\`, \`QualityAppraisal.vue\`.
   - Bad: the full ticket text; only a vague title with no screen/symbol; chat like "dữ liệu như này chạy thành công chưa".
2. If the map is thin or noisy, refine: \`code_map_explain\` on one name, or \`code_map_path\` from A to B.
3. Then read 1–5 **source** files (\`.vue\`, \`.php\`, \`node_app/\`, \`resources/\`). Skip webpack bundles (\`public/js/app.js\`), CKEditor, and unrelated docs.
4. Narrow Grep only after the map tools.`;
}

const GRAPHIFY_NOISE_SRC =
  /(^|\/)(public\/js\/|ckeditor|node_modules|vendor\/|dist\/)|changes\.md$/i;
const GRAPHIFY_CODE_SRC = /\.(vue|ts|tsx|js|jsx|php)$/i;
const GRAPHIFY_DOC_SRC = /\.(md|mdc)$/i;

function normalizeGraphifySrc(src: string): string {
  return src.replace(/\\/g, "/").replace(/^["']|["']$/g, "").trim();
}

function isNoiseGraphifySrc(src: string): boolean {
  const n = src.toLowerCase();
  if (GRAPHIFY_NOISE_SRC.test(n)) return true;
  if (/(^|\/)public\/js\//.test(n)) return true;
  return false;
}

/**
 * Collapse a raw graphify query dump into a short file list.
 * Drops webpack bundles, vendor, and heading-only docs noise.
 */
export function compactGraphifyQueryOutput(
  raw: string | null,
  opts?: { maxCode?: number; maxDocs?: number; asToolResult?: boolean },
): string | null {
  const text = raw?.trim() || "";
  if (!text) return null;
  const maxCode = opts?.maxCode ?? 8;
  const maxDocs = opts?.maxDocs ?? 4;
  const seen = new Set<string>();
  const code: string[] = [];
  const docs: string[] = [];
  const re = /\bsrc=([^\s\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const src = normalizeGraphifySrc(m[1] || "");
    if (!src || seen.has(src) || isNoiseGraphifySrc(src)) continue;
    seen.add(src);
    if (GRAPHIFY_CODE_SRC.test(src)) {
      if (code.length < maxCode) code.push(src);
    } else if (
      GRAPHIFY_DOC_SRC.test(src) &&
      /(^|\/)docs\//.test(src.replace(/\\/g, "/"))
    ) {
      if (docs.length < maxDocs) docs.push(src);
    }
  }
  if (!code.length && !docs.length) return null;
  const lines: string[] = [];
  if (code.length) {
    lines.push("Source:");
    for (const p of code) lines.push(`- \`${p}\``);
  }
  if (docs.length) {
    lines.push("Feature docs:");
    for (const p of docs) lines.push(`- \`${p}\``);
  }
  lines.push(
    opts?.asToolResult
      ? "If this is off-target, call code_map_query again with a tighter screen/symbol name."
      : "This list is a hint only — call `code_map_query` with a precise symbol/screen name next.",
  );
  return lines.join("\n");
}

export type WorkGraphifyPrep = {
  block: string;
  queryText: string | null;
  status: "disabled" | "ready" | "empty";
};

/** Ensure sibling graph exists; return how-to-use instructions (agent queries the tools itself). */
export async function prepareWorkGraphifyContext(opts: {
  sourcePath: string;
  timeoutMs?: number;
}): Promise<WorkGraphifyPrep> {
  if (!graphifyEnabled()) {
    return { block: "", queryText: null, status: "disabled" };
  }
  const ok = await ensureProjectGraphifyReady(opts.sourcePath, {
    timeoutMs: opts.timeoutMs ?? 45_000,
  });
  return {
    block: formatWorkGraphifyPromptBlock({ sourcePath: opts.sourcePath }),
    queryText: null,
    status: ok ? "ready" : "empty",
  };
}
