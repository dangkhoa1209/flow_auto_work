import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareWorktreeGraphify } from "../pipelines/graphifyWarmCache.js";

describe("prepareWorktreeGraphify", () => {
  it("rewrites cache source paths in graph.json and verifies samples", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gf-warm-"));
    const cacheSource = path.join(root, "cache", "source");
    const cacheOut = path.join(root, "cache", "graphify-out");
    const workSource = path.join(root, "job", "source");
    const workOut = path.join(root, "job", "graphify-out");
    await mkdir(cacheSource, { recursive: true });
    await mkdir(cacheOut, { recursive: true });
    await mkdir(workSource, { recursive: true });

    const sampleRel = "apps/api/src/index.ts";
    const sampleInCache = path.join(cacheSource, sampleRel);
    const sampleInWork = path.join(workSource, sampleRel);
    await mkdir(path.dirname(sampleInCache), { recursive: true });
    await mkdir(path.dirname(sampleInWork), { recursive: true });
    await writeFile(sampleInCache, "// cache\n", "utf8");
    await writeFile(sampleInWork, "// work\n", "utf8");

    await writeFile(
      path.join(cacheOut, "graph.json"),
      JSON.stringify({
        nodes: [{ id: 1, file: sampleInCache.replace(/\\/g, "/") }],
      }),
      "utf8",
    );

    const result = await prepareWorktreeGraphify({
      cacheGraphifyOut: cacheOut,
      worktreeSource: workSource,
      worktreeGraphifyOut: workOut,
      cacheSourcePath: cacheSource,
    });

    expect(result.ok).toBe(true);
    const rewritten = await readFile(path.join(workOut, "graph.json"), "utf8");
    expect(rewritten).toContain(workSource.replace(/\\/g, "/"));
    expect(rewritten).not.toContain(cacheSource.replace(/\\/g, "/"));
  });
});
