import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type FsEntry = {
  name: string;
  path: string;
  type: "dir";
};

export type BrowseResult = {
  path: string;
  parent: string | null;
  home: string;
  entries: FsEntry[];
  isGitRepo: boolean;
};

/** Resolve and ensure path is an existing directory. */
async function resolveDir(input: string): Promise<string> {
  const abs = resolve(input.trim() || homedir());
  const real = await realpath(abs).catch(() => abs);
  const st = await stat(real);
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${real}`);
  }
  return real;
}

export async function browseDirectory(
  rawPath?: string | null,
): Promise<BrowseResult> {
  const home = homedir();
  const path = await resolveDir(rawPath?.trim() || home);
  const parent = dirname(path) === path ? null : dirname(path);

  const names = await readdir(path);
  const entries: FsEntry[] = [];
  for (const name of names) {
    if (name === "." || name === "..") continue;
    // Skip heavy / noisy dirs in listing UX
    if (name === "node_modules" || name === ".git" || name === "Library") {
      // still allow .git parent detect; skip entering node_modules
      if (name === "node_modules") continue;
    }
    if (name.startsWith(".") && name !== ".cursor") continue;
    const full = join(path, name);
    try {
      const st = await stat(full);
      if (st.isDirectory()) {
        entries.push({ name, path: full, type: "dir" });
      }
    } catch {
      /* permission */
    }
  }
  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  let isGitRepo = false;
  try {
    const git = await stat(join(path, ".git"));
    isGitRepo = git.isDirectory() || git.isFile();
  } catch {
    isGitRepo = false;
  }

  return {
    path,
    parent,
    home,
    entries,
    isGitRepo,
  };
}

export function defaultBrowsePath(): string {
  return homedir();
}

export function pathBasename(p: string): string {
  return basename(p);
}
