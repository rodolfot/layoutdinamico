/**
 * Bootstrap da API + serve a UI dinamica estatica.
 * Inclui: request-id + logs estruturados por requisicao e healthcheck profundo.
 */
import path from "path";
import { randomUUID } from "crypto";
import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { initPool, closePool, pingDb } from "./db/pool";
import { registroRouter } from "./registros/registroController";
import { formRouter } from "./forms/formController";
import { metadataRouter } from "./metadata/metadataController";
import { layoutVersionRouter } from "./metadata/layoutVersionController";
import { auditRouter } from "./audit/auditController";
import { dashboardRouter } from "./dashboard/dashboardController";
import { clearCache } from "./metadata/metadataRepo";
import { getTenant, getActor } from "./audit/actor";
import { authRouter } from "./auth/authController";
import { authenticate, requireRole } from "./auth/middleware";
import { logger } from "./logger";

dotenv.config();

const app = express();
app.use(express.json({ limit: "256kb" })); // limite de corpo (hardening basico)

// Request-id + log estruturado por requisicao (uma linha JSON por request).
app.use((req: Request, res: Response, next: NextFunction) => {
  const reqId = req.header("X-Request-Id") || randomUUID();
  (req as any).reqId = reqId;
  res.setHeader("X-Request-Id", reqId);
  const t0 = Date.now();
  res.on("finish", () => {
    logger.info("request", {
      reqId, method: req.method, path: req.path, status: res.statusCode,
      ms: Date.now() - t0, tenant: getTenant(req), actor: getActor(req),
    });
  });
  next();
});

// Healthcheck PROFUNDO: valida conectividade com o Oracle.
app.get("/health", async (_req: Request, res: Response) => {
  const db = await pingDb();
  return res.status(db ? 200 : 503).json({ status: db ? "ok" : "degraded", db: db ? "up" : "down" });
});

// Login (publico, pre-auth)
app.use(authRouter);

// A partir daqui, exige JWT valido (rotas publicas: /auth/login, /health, /ui, /).
app.use(authenticate);

// Util em demos: forca recarga do cache de metadados (admin).
app.post("/admin/reload-metadata", requireRole("admin"), (_req, res) => {
  clearCache();
  res.json({ reloaded: true });
});

app.use(registroRouter);
app.use(formRouter);
app.use(metadataRouter);
app.use(layoutVersionRouter);
app.use(auditRouter);
app.use(dashboardRouter);

// Home -> dashboard consolidado
app.get("/", (_req, res) => res.redirect("/ui/dashboard.html"));

// UI dinamica (HTML + JS puro)
app.use("/ui", express.static(path.join(__dirname, "ui")));

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  await initPool();
  app.listen(PORT, () => {
    logger.info("startup", { port: PORT, ui: `http://localhost:${PORT}/ui/dashboard.html` });
  });
}

main().catch((err) => {
  logger.error("startup_failed", { detail: err?.message });
  process.exit(1);
});

process.on("SIGINT", async () => {
  await closePool();
  process.exit(0);
});
