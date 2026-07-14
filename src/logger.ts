/**
 * Logger estruturado (JSON lines). Cada linha e um evento com timestamp e nivel,
 * facil de ingerir por ELK/Loki/CloudWatch. Inclua sempre reqId quando houver.
 */
type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, fields: Record<string, any> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, fields?: Record<string, any>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, any>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, any>) => emit("error", msg, fields),
};
