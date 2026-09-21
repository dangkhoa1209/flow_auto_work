/**
 * Admin console navigation registry.
 * Single source for desktop sidebar + mobile chips.
 */

export type AdminSectionId =
  | "dashboard"
  | "users"
  | "usage"
  | "chatbox"
  | "ai-engine"
  | "task-types"
  | "ba-features"
  | "sync-db";

export type AdminIconKey =
  | "dashboard"
  | "users"
  | "usage"
  | "chatbox"
  | "robot"
  | "tag"
  | "features"
  | "sync";

export type AdminTab = {
  id: AdminSectionId;
  to: string;
  label: string;
  short: string;
  description: string;
  icon: AdminIconKey;
};

export const ADMIN_TABS: AdminTab[] = [
  {
    id: "dashboard",
    to: "/admin",
    label: "Dashboard",
    short: "Home",
    description: "Overview and alerts",
    icon: "dashboard",
  },
  {
    id: "users",
    to: "/admin/users",
    label: "Users",
    short: "Users",
    description: "Accounts, roles, passwords",
    icon: "users",
  },
  {
    id: "usage",
    to: "/admin/usage",
    label: "Usage",
    short: "Usage",
    description: "Cursor tokens and cost",
    icon: "usage",
  },
  {
    id: "chatbox",
    to: "/admin/chatbox",
    label: "Project Chatbox",
    short: "Chatbox",
    description: "BA project catalog",
    icon: "chatbox",
  },
  {
    id: "ai-engine",
    to: "/admin/ai-engine",
    label: "AI Engine",
    short: "AI",
    description: "Shared Cursor API keys",
    icon: "robot",
  },
  {
    id: "task-types",
    to: "/admin/task-types",
    label: "Task labels",
    short: "Labels",
    description: "GitLab label → task type",
    icon: "tag",
  },
  {
    id: "ba-features",
    to: "/admin/ba-features",
    label: "BA features",
    short: "Features",
    description: "ChatBox feature flags",
    icon: "features",
  },
  {
    id: "sync-db",
    to: "/admin/sync-db",
    label: "Sync DB",
    short: "Sync",
    description: "SSH + source Mongo",
    icon: "sync",
  },
];

export function isAdminTabActive(tab: AdminTab, path: string): boolean {
  if (tab.id === "dashboard") {
    return path === "/admin" || path === "/admin/";
  }
  return path === tab.to || path.startsWith(`${tab.to}/`);
}
