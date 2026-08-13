import { getConfig } from "../../config.js";

/** True for 127.0.0.1 / ::1 / localhost (with or without brackets). */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  let h = addr.trim().toLowerCase();
  if (h.startsWith("::ffff:")) h = h.slice(7);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // Strip :port for IPv4 host:port
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(h)) h = h.replace(/:\d+$/, "");
  return (
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "localhost" ||
    h === "0:0:0:0:0:0:0:1"
  );
}

/**
 * Terminal is on only when WORKBENCH_TERMINAL=1 and either the server HOST
 * is loopback or the client remote address is loopback.
 */
export function isWorkbenchTerminalAllowed(remoteAddr?: string | null): boolean {
  const cfg = getConfig();
  if (!cfg.WORKBENCH_TERMINAL) return false;
  if (isLoopbackAddress(cfg.HOST)) return true;
  if (isLoopbackAddress(remoteAddr)) return true;
  return false;
}

export function terminalStatusPayload(remoteAddr?: string | null): {
  enabled: boolean;
  reason?: string;
} {
  const cfg = getConfig();
  if (!cfg.WORKBENCH_TERMINAL) {
    return { enabled: false, reason: "WORKBENCH_TERMINAL off" };
  }
  if (isWorkbenchTerminalAllowed(remoteAddr)) {
    return { enabled: true };
  }
  return {
    enabled: false,
    reason: "Terminal chỉ nội bộ (loopback HOST hoặc client localhost)",
  };
}
