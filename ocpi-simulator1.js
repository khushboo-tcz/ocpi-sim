const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");

const app = express();
const CONFIG = {
  port: Number(process.env.PORT || 3000),
  version: "2.2.1",
  baseUrl: process.env.OCPI_BASE_URL || "http://localhost:3000",
  inboundBootstrapToken:
    process.env.OCPI_INBOUND_BOOTSTRAP_TOKEN || "replace-with-inbound-bootstrap-token",
  localToken: process.env.OCPI_LOCAL_TOKEN || crypto.randomBytes(32).toString("hex"),
};

const simulator = {
  role: "EMSP",
  countryCode: "IN",
  partyId: "CZS",
  businessName: "OCPI Test Simulator",
};

const state = {
  status: "DISCONNECTED",
  partnerRoles: [],
  remoteToken: null,
  remoteVersionsUrl: null,
  remoteCredentialsUrl: null,
  partnerEndpoints: [],
  partnerLocationsUrl: null,
  lastError: null,
};

const trafficLogs = [];
const MAX_TRAFFIC_LOGS = 2000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Friendly dashboard aliases, so users can open /emsp instead of remembering the .html filename.
app.get("/emsp", (req, res) => res.sendFile(path.join(__dirname, "public", "emsp.html")));
app.get("/cpo", (req, res) => res.sendFile(path.join(__dirname, "public", "cpo.html")));
app.get("/logs", (req, res) => res.sendFile(path.join(__dirname, "public", "logs.html")));

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [
      key,
      /authorization|token|secret|password/i.test(key) ? "[REDACTED]" : redact(val),
    ]));
  }
  return value;
}

function safeHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = /authorization|token|secret|password/i.test(key) ? "[REDACTED]" : value;
  }
  return result;
}

function addTrafficLog(entry) {
  trafficLogs.push({ id: crypto.randomUUID(), time: new Date().toISOString(), ...entry });
  if (trafficLogs.length > MAX_TRAFFIC_LOGS) {
    trafficLogs.splice(0, trafficLogs.length - MAX_TRAFFIC_LOGS);
  }
}

function log(message, details = {}) {
  console.log({ time: new Date().toISOString(), message, details: redact(details) });
}

function ocpiResponse(data, statusCode = 1000, message = "Success") {
  return { data, status_code: statusCode, status_message: message, timestamp: new Date().toISOString() };
}

function isAuthorized(req, token) {
  return req.get("Authorization") === `Token ${token}`;
}

function localRoles() {
  return [{
    role: simulator.role,
    party_id: simulator.partyId,
    country_code: simulator.countryCode,
    business_details: { name: simulator.businessName },
  }];
}

function localCredentials() {
  return {
    token: CONFIG.localToken,
    url: `${CONFIG.baseUrl}/ocpi/versions`,
    roles: localRoles(),
  };
}

function unwrapOcpiResponse(result) {
  const body = result.data;
  if (!body || body.status_code !== 1000) {
    throw new Error(body?.status_message || "Invalid OCPI response");
  }
  return body.data;
}

// Capture incoming OCPI requests and responses.
app.use((req, res, next) => {
  if (!req.path.startsWith("/ocpi/")) return next();

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let responseBody;

  addTrafficLog({
    type: "REQUEST", direction: "INBOUND", requestId,
    method: req.method, url: req.originalUrl,
    headers: safeHeaders(req.headers), body: redact(req.body ?? null),
  });

  const originalJson = res.json.bind(res);
  res.json = (body) => { responseBody = body; return originalJson(body); };

  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (responseBody === undefined) {
      if (typeof body === "string") {
        try { responseBody = JSON.parse(body); } catch { responseBody = body; }
      } else responseBody = body;
    }
    return originalSend(body);
  };

  res.on("finish", () => addTrafficLog({
    type: "RESPONSE", direction: "INBOUND", requestId,
    method: req.method, url: req.originalUrl,
    httpStatus: res.statusCode, ocpiStatus: responseBody?.status_code ?? null,
    durationMs: Date.now() - startedAt,
    headers: safeHeaders(res.getHeaders()), body: redact(responseBody ?? null),
  }));

  next();
});

function requestHeaders(token, correlationId) {
  return {
    Authorization: `Token ${token}`,
    "X-Request-ID": crypto.randomUUID(),
    "X-Correlation-ID": correlationId,
    "Content-Type": "application/json",
  };
}

async function trackedRequest(method, url, config = {}, body) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  addTrafficLog({
    type: "REQUEST", direction: "OUTBOUND", requestId, method, url,
    headers: safeHeaders(config.headers || {}), body: redact(body ?? null),
  });

  try {
    const result = await axios({
      ...config, method, url,
      ...(body !== undefined ? { data: body } : {}),
    });

    addTrafficLog({
      type: "RESPONSE", direction: "OUTBOUND", requestId, method, url,
      httpStatus: result.status, ocpiStatus: result.data?.status_code ?? null,
      durationMs: Date.now() - startedAt,
      headers: safeHeaders(result.headers), body: redact(result.data),
    });
    return result;
  } catch (error) {
    if (error.response) {
      addTrafficLog({
        type: "RESPONSE", direction: "OUTBOUND", requestId, method, url,
        httpStatus: error.response.status,
        ocpiStatus: error.response.data?.status_code ?? null,
        durationMs: Date.now() - startedAt,
        headers: safeHeaders(error.response.headers),
        body: redact(error.response.data), error: error.message,
      });
    } else {
      addTrafficLog({
        type: "ERROR", direction: "OUTBOUND", requestId, method, url,
        durationMs: Date.now() - startedAt, error: error.message,
      });
    }
    throw error;
  }
}

// OCPI version discovery for this simulator.
app.get("/ocpi/versions", (req, res) => res.json(ocpiResponse([{
  version: CONFIG.version,
  url: `${CONFIG.baseUrl}/ocpi/2.2.1/details`,
}])));

app.get("/ocpi/2.2.1/details", (req, res) => res.json(ocpiResponse({
  version: CONFIG.version,
  endpoints: [{
    identifier: "credentials",
    role: "RECEIVER",
    url: `${CONFIG.baseUrl}/ocpi/2.2.1/credentials`,
  }],
})));

// Incoming credentials registration.
app.post("/ocpi/2.2.1/credentials", (req, res) => {
  if (!isAuthorized(req, CONFIG.inboundBootstrapToken)) {
    return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized"));
  }

  const credentials = req.body;
  if (!credentials || typeof credentials.token !== "string" || !credentials.token ||
      typeof credentials.url !== "string" || !credentials.url ||
      !Array.isArray(credentials.roles) || credentials.roles.length === 0) {
    return res.status(200).json(ocpiResponse(null, 2001, "Invalid credentials payload"));
  }

  state.remoteToken = credentials.token;
  state.remoteVersionsUrl = credentials.url;
  state.partnerRoles = credentials.roles;
  state.status = "CONNECTED";
  state.lastError = null;

  log("Incoming credentials registration received", {
    partnerRoles: credentials.roles.map(({ role, party_id, country_code }) => ({ role, party_id, country_code })),
  });
  return res.json(ocpiResponse(localCredentials()));
});

app.get("/ocpi/2.2.1/credentials", (req, res) => {
  if (!isAuthorized(req, CONFIG.localToken)) {
    return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized"));
  }
  return res.json(ocpiResponse(localCredentials()));
});

// Initiate outgoing credentials handshake and remember discovered partner endpoints.
app.post("/api/handshake", async (req, res) => {
  const { partnerVersionsUrl, bootstrapToken, role, partyId, countryCode, businessName } = req.body || {};

  try {
    if (!partnerVersionsUrl || !bootstrapToken) {
      return res.status(400).json({ status: "ERROR", error: "Partner Versions URL and bootstrap token are required." });
    }

    const nextRole = role || simulator.role;
    const nextCountry = countryCode || simulator.countryCode;
    const nextParty = partyId || simulator.partyId;

    if (!["CPO", "EMSP"].includes(nextRole)) {
      return res.status(400).json({ status: "ERROR", error: "Role must be CPO or EMSP." });
    }
    if (!/^[A-Z]{2}$/.test(nextCountry)) {
      return res.status(400).json({ status: "ERROR", error: "Country code must be two uppercase letters." });
    }
    if (!/^[A-Z]{3}$/.test(nextParty)) {
      return res.status(400).json({ status: "ERROR", error: "Party ID must be three uppercase letters." });
    }

    simulator.role = nextRole;
    simulator.countryCode = nextCountry;
    simulator.partyId = nextParty;
    simulator.businessName = businessName || simulator.businessName;

    state.status = "CONNECTING";
    state.lastError = null;
    state.partnerEndpoints = [];
    state.partnerLocationsUrl = null;

    const correlationId = crypto.randomUUID();
    log("Outgoing handshake started", { partnerVersionsUrl, role: simulator.role });

    const versionsResult = await trackedRequest("GET", partnerVersionsUrl, {
      headers: requestHeaders(bootstrapToken, correlationId), timeout: 15000,
    });
    const versions = unwrapOcpiResponse(versionsResult);
    if (!Array.isArray(versions)) throw new Error("Partner returned an invalid versions list.");

    const selectedVersion = versions.find((item) => item.version === CONFIG.version);
    if (!selectedVersion?.url) throw new Error("Partner does not advertise OCPI 2.2.1.");

    const detailsResult = await trackedRequest("GET", selectedVersion.url, {
      headers: requestHeaders(bootstrapToken, correlationId), timeout: 15000,
    });
    const details = unwrapOcpiResponse(detailsResult);
    const endpoints = details.endpoints || [];
    const credentialsEndpoint = endpoints.find((item) => item.identifier === "credentials");
    if (!credentialsEndpoint?.url) throw new Error("Partner credentials endpoint was not found.");

    const registrationResult = await trackedRequest("POST", credentialsEndpoint.url, {
      headers: requestHeaders(bootstrapToken, correlationId), timeout: 15000,
    }, {
      token: CONFIG.localToken,
      url: `${CONFIG.baseUrl}/ocpi/versions`,
      roles: localRoles(),
    });

    const remoteCredentials = unwrapOcpiResponse(registrationResult);
    if (!remoteCredentials || typeof remoteCredentials.token !== "string" || !remoteCredentials.token ||
        typeof remoteCredentials.url !== "string" || !remoteCredentials.url ||
        !Array.isArray(remoteCredentials.roles) || remoteCredentials.roles.length === 0) {
      throw new Error("Partner returned invalid credentials.");
    }

    state.remoteToken = remoteCredentials.token;
    state.remoteVersionsUrl = remoteCredentials.url;
    state.remoteCredentialsUrl = credentialsEndpoint.url;
    state.partnerRoles = remoteCredentials.roles;
    state.partnerEndpoints = endpoints;
    const locationsEndpoint = endpoints.find((item) =>
      item.identifier === "locations" && item.role === "SENDER"
    );
    state.partnerLocationsUrl = locationsEndpoint?.url || null;
    state.status = "CONNECTED";
    state.lastError = null;

    log("Credentials exchange completed", {
      role: simulator.role,
      partnerRoles: remoteCredentials.roles.map(({ role, party_id, country_code }) => ({ role, party_id, country_code })),
      partnerLocationsUrl: state.partnerLocationsUrl,
    });

    return res.json({
      status: "CONNECTED",
      role: simulator.role,
      redirectUrl: simulator.role === "EMSP" ? "/emsp.html" : "/cpo.html",
      version: CONFIG.version,
      partnerRoles: state.partnerRoles,
      locationsEndpointAvailable: Boolean(state.partnerLocationsUrl),
      message: "Credentials exchange completed successfully.",
    });
  } catch (error) {
    state.status = "ERROR";
    state.lastError = error.response?.data?.status_message || error.message || "Handshake failed";
    log("Handshake failed", { error: state.lastError, httpStatus: error.response?.status ?? null });
    return res.status(502).json({ status: "ERROR", error: state.lastError });
  }
});

// Direct Locations fetch: bypasses Versions, Version Details, and Credentials handshake.
// Use only an endpoint and token supplied by the user for a trusted OCPI partner/sandbox.
app.post("/api/locations/direct", async (req, res) => {
  const { endpoint, token, limit = 100 } = req.body || {};
  if (simulator.role !== "EMSP") {
    return res.status(409).json({ error: "Switch the simulator role to eMSP to fetch Locations." });
  }
  if (typeof endpoint !== "string" || !endpoint.trim() || typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "A direct Locations endpoint and OCPI token are required." });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(endpoint.trim());
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Only HTTP/HTTPS URLs are supported.");
  } catch (error) {
    return res.status(400).json({ error: `Invalid Locations endpoint URL: ${error.message}` });
  }

  try {
    const correlationId = crypto.randomUUID();
    const result = await trackedRequest("GET", parsedUrl.toString(), {
      headers: {
        ...requestHeaders(token.trim(), correlationId),
        "X-Limit": String(Math.min(Math.max(Number(limit) || 100, 1), 1000)),
      },
      timeout: 20000,
    });

    let locations;
    if (result.data && typeof result.data === "object" && "status_code" in result.data) {
      if (result.data.status_code !== 1000) {
        throw new Error(result.data.status_message || `OCPI status ${result.data.status_code}`);
      }
      locations = result.data.data;
    } else {
      // Also allow a partner that returns the raw Locations array instead of an OCPI envelope.
      locations = result.data;
    }
    if (!Array.isArray(locations)) {
      throw new Error("Unexpected Locations response: expected an array in data or a raw array.");
    }

    state.partnerLocationsUrl = parsedUrl.toString();
    state.lastError = null;
    return res.json({
      mode: "DIRECT_BYPASS",
      endpoint: parsedUrl.toString(),
      count: locations.length,
      locations,
      pagination: {
        link: result.headers.link || null,
        xTotalCount: result.headers["x-total-count"] || null,
        xLimit: result.headers["x-limit"] || null,
      },
    });
  } catch (error) {
    const message = error.response?.data?.status_message || error.response?.data?.message || error.message || "Locations request failed";
    state.lastError = message;
    return res.status(error.response?.status || 502).json({
      error: message,
      httpStatus: error.response?.status ?? null,
      ocpiStatus: error.response?.data?.status_code ?? null,
    });
  }
});

// Original handshake-based Locations fetch remains available.
app.get("/api/locations", async (req, res) => {
  if (state.status !== "CONNECTED" || !state.remoteToken) {
    return res.status(409).json({ error: "No handshake token is available. Use POST /api/locations/direct to bypass the handshake." });
  }
  if (simulator.role !== "EMSP") return res.status(409).json({ error: "Fetching Locations is an eMSP-side operation." });
  if (!state.partnerLocationsUrl) return res.status(404).json({ error: "Partner did not advertise a Locations SENDER endpoint." });
  try {
    const result = await trackedRequest("GET", state.partnerLocationsUrl, {
      headers: { ...requestHeaders(state.remoteToken, crypto.randomUUID()), "X-Limit": "100" }, timeout: 20000,
    });
    const locations = unwrapOcpiResponse(result);
    if (!Array.isArray(locations)) throw new Error("Partner returned an unexpected Locations response; expected an array.");
    return res.json({ endpoint: state.partnerLocationsUrl, count: locations.length, locations, pagination: {
      link: result.headers.link || null, xTotalCount: result.headers["x-total-count"] || null, xLimit: result.headers["x-limit"] || null,
    }});
  } catch (error) {
    const message = error.response?.data?.status_message || error.message || "Locations request failed";
    state.lastError = message;
    return res.status(502).json({ error: message, httpStatus: error.response?.status ?? null, ocpiStatus: error.response?.data?.status_code ?? null });
  }
});

app.get("/api/status", (req, res) => res.json({
  status: state.status,
  role: simulator.role,
  version: CONFIG.version,
  countryCode: simulator.countryCode,
  partyId: simulator.partyId,
  businessName: simulator.businessName,
  partnerRoles: state.partnerRoles,
  locationsEndpointAvailable: Boolean(state.partnerLocationsUrl),
  partnerLocationsUrl: state.partnerLocationsUrl,
  partnerEndpoints: state.partnerEndpoints.map(({ identifier, role, url }) => ({ identifier, role, url })),
  lastError: state.lastError,
}));

app.get("/api/logs", (req, res) => {
  const filter = String(req.query.type || "ALL").toUpperCase();
  if (!["ALL", "REQUEST", "RESPONSE", "ERROR"].includes(filter)) {
    return res.status(400).json({ error: "Invalid log filter." });
  }
  const filtered = trafficLogs.filter((entry) => filter === "ALL" || entry.type === filter);
  return res.json({
    totalRequests: trafficLogs.filter((entry) => entry.type === "REQUEST").length,
    totalResponses: trafficLogs.filter((entry) => entry.type === "RESPONSE").length,
    totalErrors: trafficLogs.filter((entry) => entry.type === "ERROR").length,
    retainedEvents: trafficLogs.length,
    maxEvents: MAX_TRAFFIC_LOGS,
    logs: filtered.slice().reverse(),
  });
});

app.delete("/api/logs", (req, res) => {
  trafficLogs.length = 0;
  return res.json({ message: "Traffic logs cleared." });
});

app.listen(CONFIG.port, () => {
  console.log("---------------------------------------");
  console.log("OCPI 2.2.1 Test Simulator");
  console.log(`Handshake: http://localhost:${CONFIG.port}/`);
  console.log(`eMSP page: http://localhost:${CONFIG.port}/emsp.html`);
  console.log(`CPO page:  http://localhost:${CONFIG.port}/cpo.html`);
  console.log(`Logs:      http://localhost:${CONFIG.port}/logs.html`);
  console.log(`Versions:  ${CONFIG.baseUrl}/ocpi/versions`);
  console.log("---------------------------------------");
});
