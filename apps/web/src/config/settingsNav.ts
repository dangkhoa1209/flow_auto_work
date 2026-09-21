/**
 * Unified Settings navigation registry.
 * Each shell keeps its own route prefix; tabs are filtered here by shell.
 */

export type SettingsShellId = "code" | "chatbox" | "build" | "admin";

export type SettingsSectionId =
  | "project"
  | "integrations"
  | "ai-engine"
  | "labels"
  | "account"
  | "gitlab"
  | "google";

export type SettingsIconKey =
  | "project"
  | "api"
  | "robot"
  | "tag"
  | "user"
  | "key"
  | "google";

export type SettingsSectionDef = {
  id: SettingsSectionId;
  label: string;
  /** Short hint under the label (desktop sidebar). */
  description: string;
  path: string;
  icon: SettingsIconKey;
};

export type SettingsTab = {
  id: SettingsSectionId;
  to: string;
  label: string;
  description: string;
  icon: SettingsIconKey;
};

const ACCOUNT: SettingsSectionDef = {
  id: "account",
  label: "Account",
  description: "Password and session",
  path: "account",
  icon: "user",
};

export const SETTINGS_BY_SHELL: Record<SettingsShellId, SettingsSectionDef[]> =
  {
    code: [
      {
        id: "project",
        label: "Project",
        description: "Repos, branches, verify",
        path: "project",
        icon: "project",
      },
      {
        id: "integrations",
        label: "Integrations",
        description: "Google and Figma",
        path: "integrations",
        icon: "api",
      },
      {
        id: "ai-engine",
        label: "AI Engine",
        description: "Cursor PATs and model",
        path: "ai-engine",
        icon: "robot",
      },
      {
        id: "labels",
        label: "Labels",
        description: "GitLab labels and milestones",
        path: "labels",
        icon: "tag",
      },
      ACCOUNT,
    ],
    chatbox: [
      {
        id: "gitlab",
        label: "GitLab PAT",
        description: "Personal access token",
        path: "gitlab",
        icon: "key",
      },
      {
        id: "google",
        label: "Google",
        description: "Docs and Sheets OAuth",
        path: "google",
        icon: "google",
      },
      ACCOUNT,
    ],
    build: [ACCOUNT],
    admin: [ACCOUNT],
  };

/** Shell subtitle shown in the settings sidebar header. */
export const SETTINGS_SHELL_SUBTITLE: Record<SettingsShellId, string> = {
  code: "Code workspace preferences",
  chatbox: "ChatBox integrations and account",
  build: "Build console account",
  admin: "Admin account",
};

export function resolveSettingsShell(path: string): SettingsShellId {
  if (
    path === "/ba" ||
    path.startsWith("/ba/") ||
    path === "/qc" ||
    path.startsWith("/qc/")
  ) {
    return "chatbox";
  }
  if (path === "/devops" || path.startsWith("/devops/")) return "build";
  if (path === "/admin" || path.startsWith("/admin/")) return "admin";
  return "code";
}

/** Base path for settings under the current shell (no trailing slash). */
export function settingsBasePath(path: string): string {
  if (path === "/qc" || path.startsWith("/qc/")) return "/qc/settings";
  if (path === "/ba" || path.startsWith("/ba/")) return "/ba/settings";
  if (path === "/devops" || path.startsWith("/devops/"))
    return "/devops/settings";
  if (path === "/admin" || path.startsWith("/admin/")) return "/admin/settings";
  return "/settings";
}

/** Default landing URL for a shell or current path.
 * Prefer a route path (`/qc/...`) over shell id `chatbox` when QC vs BA matters —
 * shell id `chatbox` maps to `/ba/settings` only.
 */
export function settingsDefaultPath(pathOrShell: string | SettingsShellId): string {
  if (
    pathOrShell === "code" ||
    pathOrShell === "chatbox" ||
    pathOrShell === "build" ||
    pathOrShell === "admin"
  ) {
    const baseByShell: Record<SettingsShellId, string> = {
      code: "/settings",
      chatbox: "/ba/settings",
      build: "/devops/settings",
      admin: "/admin/settings",
    };
    const first = SETTINGS_BY_SHELL[pathOrShell][0];
    return `${baseByShell[pathOrShell]}/${first.path}`;
  }

  const shell = resolveSettingsShell(pathOrShell);
  const base = settingsBasePath(pathOrShell);
  const first = SETTINGS_BY_SHELL[shell][0];
  return `${base}/${first.path}`;
}

export function resolveSettingsTabs(path: string): {
  shell: SettingsShellId;
  basePath: string;
  subtitle: string;
  /** ChatBox shares BA/QC prefixes — use prefix match for active state. */
  prefixMatch: boolean;
  tabs: SettingsTab[];
} {
  const shell = resolveSettingsShell(path);
  const basePath = settingsBasePath(path);
  const sections = SETTINGS_BY_SHELL[shell];
  return {
    shell,
    basePath,
    subtitle: SETTINGS_SHELL_SUBTITLE[shell],
    prefixMatch: shell === "chatbox",
    tabs: sections.map((s) => ({
      id: s.id,
      to: `${basePath}/${s.path}`,
      label: s.label,
      description: s.description,
      icon: s.icon,
    })),
  };
}
