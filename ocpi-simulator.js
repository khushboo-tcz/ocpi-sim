const crypto = require("node:crypto");
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.randomUUID) {
  globalThis.crypto = crypto;
}
if (typeof global.crypto === "undefined") {
  global.crypto = crypto;
}

require("dotenv").config();
const express = require("express");
const path = require("path");
const swaggerUi = require("swagger-ui-express");
const { getSwaggerSpec } = require("./src/docs/swaggerSpec");
const { connectDb, disconnectDb, getConnectionStatus } = require("./src/db/connection");
const {
  CONFIG,
  simulator,
  state,
  restoreStateFromDb,
} = require("./src/services/simulatorState");
const { ensureDefaultTariff } = require("./src/services/cpoLocationService");
const { recordTransaction, detectModule } = require("./src/services/logger");

// Import modular routers
const commonOcpiRoutes = require("./src/routes/commonOcpiRoutes");
const cpoRoutes = require("./src/routes/cpoRoutes");
const emspRoutes = require("./src/routes/emspRoutes");
const uiRoutes = require("./src/routes/uiRoutes");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Friendly dashboard aliases
app.get("/emsp", (req, res) => res.sendFile(path.join(__dirname, "public", "emsp.html")));
app.get("/cpo", (req, res) => res.sendFile(path.join(__dirname, "public", "cpo.html")));
app.get("/logs", (req, res) => res.sendFile(path.join(__dirname, "public", "logs.html")));
app.get("/cpo-locations", (req, res) => res.sendFile(path.join(__dirname, "public", "cpo-locations.html")));
app.get("/location-builder", (req, res) => res.sendFile(path.join(__dirname, "public", "cpo-locations.html")));

// Swagger UI and OpenAPI 3.0 Documentation Endpoints
const swaggerCustomCss = `
  .swagger-ui .topbar { background-color: #0f172a; border-bottom: 3px solid #3b82f6; }
  .swagger-ui .topbar .topbar-wrapper a { display: flex; align-items: center; }
  .swagger-ui .topbar .topbar-wrapper a::after { content: " · OCPI 2.2.1 Protocol & Simulator API"; color: #94a3b8; font-size: 14px; font-weight: normal; margin-left: 8px; }
  .swagger-ui .info { margin: 24px 0; }
  .swagger-ui .info .title { color: #0f172a; font-family: Inter, system-ui, sans-serif; font-weight: 750; }
  .swagger-ui .btn.authorize { background-color: #2563eb; color: white; border-color: #2563eb; font-weight: bold; }
  .swagger-ui .btn.authorize svg { fill: white; }
`;

function getSwaggerUiOptions(config = {}, state = {}) {
  const localToken = state.localToken || config.localToken || "simulator-local-token";
  const bootstrapToken = state.bootstrapToken || config.inboundBootstrapToken || "replace-with-inbound-bootstrap-token";
  const activeToken = state.status === "CONNECTED" ? localToken : bootstrapToken;

  return {
    customSiteTitle: "OCPI 2.2.1 Simulator · Swagger API Docs & Testing",
    customCss: swaggerCustomCss,
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: "list",
      filter: true,
      tryItOutEnabled: true,
      preauthorizeApiKey: {
        authDefinitionKey: "OcpiTokenAuth",
        apiKeyValue: `Token ${activeToken}`,
      },
      requestInterceptor: (req) => {
        if (req.url && (req.url.indexOf("/ocpi/") !== -1 || req.url.startsWith("/ocpi/"))) {
          req.headers = req.headers || {};
          const existing = req.headers["Authorization"] || req.headers["authorization"];
          if (!existing) {
            req.headers["Authorization"] = "Token " + activeToken;
          } else if (!existing.toLowerCase().startsWith("token ") && !existing.toLowerCase().startsWith("bearer ")) {
            req.headers["Authorization"] = "Token " + existing;
          }
        }
        return req;
      },
    },
  };
}

// Warm up Swagger UI setup at boot
swaggerUi.setup(getSwaggerSpec(CONFIG, simulator, state), getSwaggerUiOptions(CONFIG, state));

app.get("/swagger.json", (req, res) => {
  res.json(getSwaggerSpec(CONFIG, simulator, state));
});
app.get("/api-docs/swagger.json", (req, res) => {
  res.json(getSwaggerSpec(CONFIG, simulator, state));
});
app.use("/docs", swaggerUi.serve, (req, res, next) => {
  swaggerUi.setup(getSwaggerSpec(CONFIG, simulator, state), getSwaggerUiOptions(CONFIG, state))(req, res, next);
});
app.use("/api-docs", swaggerUi.serve, (req, res, next) => {
  swaggerUi.setup(getSwaggerSpec(CONFIG, simulator, state), getSwaggerUiOptions(CONFIG, state))(req, res, next);
});
app.get("/swagger", (req, res) => res.redirect("/docs"));

// Inbound OCPI transaction logger middleware
app.use((req, res, next) => {
  if (!req.path.startsWith("/ocpi/")) return next();

  const requestId = req.get("x-request-id") || crypto.randomUUID();
  const correlationId = req.get("x-correlation-id") || crypto.randomUUID();
  const startedAt = Date.now();
  let responseBody;

  const reqSnapshot = {
    method: req.method,
    url: req.originalUrl,
    headers: { ...req.headers },
    body: req.body !== undefined ? req.body : null,
  };

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (responseBody === undefined) {
      if (typeof body === "string") {
        try {
          responseBody = JSON.parse(body);
        } catch {
          responseBody = body;
        }
      } else responseBody = body;
    }
    return originalSend(body);
  };

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const ocpiCode =
      responseBody && typeof responseBody === "object" && typeof responseBody.status_code === "number"
        ? responseBody.status_code
        : null;
    const ocpiMsg =
      responseBody && typeof responseBody === "object" && typeof responseBody.status_message === "string"
        ? responseBody.status_message
        : null;

    recordTransaction({
      direction: "INBOUND",
      simulatorRole: simulator.role,
      module: detectModule(reqSnapshot.url),
      requestId,
      correlationId,
      durationMs,
      request: {
        method: reqSnapshot.method,
        url: reqSnapshot.url,
        headers: reqSnapshot.headers,
        body: reqSnapshot.body,
      },
      response: {
        httpStatus: res.statusCode,
        headers: res.getHeaders(),
        body: responseBody ?? null,
        ocpiStatusCode: ocpiCode,
        ocpiStatusMessage: ocpiMsg,
      },
      error:
        res.statusCode >= 400
          ? {
              code: `HTTP_${res.statusCode}`,
              message: ocpiMsg || `HTTP ${res.statusCode}`,
            }
          : null,
    }).catch((err) => {
      console.error("[Logger] Inbound transaction logging error:", err.stack || err.message);
    });
  });

  next();
});

/* -------------------------------------------------------------------------- */
/* MOUNT MODULAR ROUTERS                                                      */
/* -------------------------------------------------------------------------- */

// 1. Common OCPI (Version Discovery & Credentials Handshake)
app.use("/ocpi", commonOcpiRoutes);

// 2. CPO Role Endpoints (Locations, Tariffs, Sessions, CDRs, Tokens, Commands, Profiles)
app.use("/ocpi/cpo/2.2.1", cpoRoutes);
app.use("/ocpi/cpo/2.2", cpoRoutes);

// 3. eMSP Role Endpoints (Locations, Tariffs, Sessions, CDRs, Tokens, Callbacks)
app.use("/ocpi/emsp/2.2.1", emspRoutes);
app.use("/ocpi/emsp/2.2", emspRoutes);

// 4. Simulator UI & Internal Management APIs
app.use("/api", uiRoutes);

/* -------------------------------------------------------------------------- */
/* SERVER INITIALIZATION                                                      */
/* -------------------------------------------------------------------------- */

let serverInstance = null;

async function startServer() {
  await connectDb();
  await restoreStateFromDb();
  await ensureDefaultTariff();

  return new Promise((resolve) => {
    serverInstance = app.listen(CONFIG.port, () => {
      console.log(`\n===============================================================`);
      console.log(`  OCPI 2.2.1 Simulator running on port ${CONFIG.port}`);
      console.log(`===============================================================`);
      console.log(`  Interactive UI Dashboards:`);
      console.log(`    - Handshake & Connections: ${CONFIG.baseUrl}/`);
      console.log(`    - eMSP Explorer:          ${CONFIG.baseUrl}/emsp`);
      console.log(`    - CPO Dashboard:          ${CONFIG.baseUrl}/cpo`);
      console.log(`    - CPO Location Builder:   ${CONFIG.baseUrl}/cpo-locations`);
      console.log(`    - Traffic & Audit Logs:   ${CONFIG.baseUrl}/logs`);
      console.log(`\n  API Documentation:`);
      console.log(`    - Interactive Swagger UI: ${CONFIG.baseUrl}/docs`);
      console.log(`    - Raw OpenAPI Spec:       ${CONFIG.baseUrl}/swagger.json`);
      console.log(`\n  Protocol Routes:`);
      console.log(`    - Common (Discovery):     ${CONFIG.baseUrl}/ocpi/versions`);
      console.log(`    - CPO 2.2.1 Endpoints:    ${CONFIG.baseUrl}/ocpi/cpo/2.2.1/...`);
      console.log(`    - eMSP 2.2.1 Endpoints:   ${CONFIG.baseUrl}/ocpi/emsp/2.2.1/...`);
      console.log(`    - Internal UI APIs:       ${CONFIG.baseUrl}/api/...`);
      console.log(`===============================================================\n`);
      resolve(serverInstance);
    });
  });
}

async function stopServer() {
  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
    serverInstance = null;
  }
  await disconnectDb();
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}

module.exports = { app, startServer, stopServer };
