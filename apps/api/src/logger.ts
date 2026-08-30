type Level = "debug" | "info" | "warn" | "error";

function log(level: Level, message: string, meta?: unknown) {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta !== undefined ? { meta } : {}),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (message: string, meta?: unknown) => log("debug", message, meta),
  info: (message: string, meta?: unknown) => log("info", message, meta),
  warn: (message: string, meta?: unknown) => log("warn", message, meta),
  error: (message: string, meta?: unknown) => log("error", message, meta),
};
