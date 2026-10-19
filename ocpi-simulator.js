const crypto = require("node:crypto");
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.randomUUID) {
  globalThis.crypto = crypto;
}
if (typeof global.crypto === "undefined") {
  global.crypto = crypto;
}

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const mongoose = require("mongoose");

const { connectDb, disconnectDb, getConnectionStatus } = require("./src/db/connection");
const OcpiConnectionProfile = require("./src/models/OcpiConnectionProfile");
const OcpiVersion = require("./src/models/OcpiVersion");
const OcpiEndpoint = require("./src/models/OcpiEndpoint");
const OcpiApiLog = require("./src/models/OcpiApiLog");
const {
  recordTransaction,
  recordLog,
  getMemoryLogs,
  clearMemoryLogs,
  safeHeaders,
  redact,
  detectModule,
} = require("./src/services/logger");

const app = express();
const CONFIG = {
  port: Number(process.env.PORT || 3000),
  version: "2.2.1",
  baseUrl: (process.env.OCPI_BASE_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ""),
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

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Friendly dashboard aliases, so users can open /emsp instead of remembering the .html filename.
app.get("/emsp", (req, res) => res.sendFile(path.join(__dirname, "public", "emsp.html")));
app.get("/cpo", (req, res) => res.sendFile(path.join(__dirname, "public", "cpo.html")));
app.get("/logs", (req, res) => res.sendFile(path.join(__dirname, "public", "logs.html")));

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

// Capture incoming OCPI requests and responses as single unified transactions.
app.use((req, res, next) => {
  if (!req.path.startsWith("/ocpi/")) return next();

  const requestId = req.get("x-request-id") || crypto.randomUUID();
  const correlationId = req.get("x-correlation-id") || crypto.randomUUID();
  const startedAt = Date.now();
  let responseBody;

  // Snapshot incoming request details
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
        try { responseBody = JSON.parse(body); } catch { responseBody = body; }
      } else responseBody = body;
    }
    return originalSend(body);
  };

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const ocpiCode = (responseBody && typeof responseBody === "object" && typeof responseBody.status_code === "number")
      ? responseBody.status_code
      : null;
    const ocpiMsg = (responseBody && typeof responseBody === "object" && typeof responseBody.status_message === "string")
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
      error: res.statusCode >= 400 ? {
        code: `HTTP_${res.statusCode}`,
        message: ocpiMsg || `HTTP ${res.statusCode}`,
      } : null,
    }).catch((err) => {
      console.error("[Logger] Inbound transaction logging error:", err.stack || err.message);
    });
  });

  next();
});

function requestHeaders(token, correlationId) {
  return {
    Authorization: `Token ${token}`,
    "X-Request-ID": crypto.randomUUID(),
    "X-Correlation-ID": correlationId || crypto.randomUUID(),
    "Content-Type": "application/json",
  };
}

async function trackedRequest(method, url, config = {}, body) {
  const requestId = config.headers?.["X-Request-ID"] || config.headers?.["x-request-id"] || crypto.randomUUID();
  const correlationId = config.headers?.["X-Correlation-ID"] || config.headers?.["x-correlation-id"] || crypto.randomUUID();
  const startedAt = Date.now();
  const reqHeaders = { ...(config.headers || {}) };
  const reqBody = body !== undefined ? body : null;

  try {
    const result = await axios({
      ...config,
      method,
      url,
      ...(body !== undefined ? { data: body } : {}),
    });

    const durationMs = Date.now() - startedAt;
    const resData = result.data;
    const ocpiCode = (resData && typeof resData === "object" && typeof resData.status_code === "number")
      ? resData.status_code
      : null;
    const ocpiMsg = (resData && typeof resData === "object" && typeof resData.status_message === "string")
      ? resData.status_message
      : null;

    await recordTransaction({
      direction: "OUTBOUND",
      simulatorRole: simulator.role,
      module: detectModule(url),
      requestId,
      correlationId,
      durationMs,
      request: {
        method,
        url,
        headers: reqHeaders,
        body: reqBody,
      },
      response: {
        httpStatus: result.status,
        headers: result.headers,
        body: resData,
        ocpiStatusCode: ocpiCode,
        ocpiStatusMessage: ocpiMsg,
      },
      error: (ocpiCode && ocpiCode !== 1000) ? {
        code: `OCPI_${ocpiCode}`,
        message: ocpiMsg || `OCPI status ${ocpiCode}`,
      } : null,
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;

    if (error.response) {
      const resData = error.response.data;
      const ocpiCode = (resData && typeof resData === "object" && typeof resData.status_code === "number")
        ? resData.status_code
        : null;
      const ocpiMsg = (resData && typeof resData === "object" && typeof resData.status_message === "string")
        ? resData.status_message
        : null;

      await recordTransaction({
        direction: "OUTBOUND",
        simulatorRole: simulator.role,
        module: detectModule(url),
        requestId,
        correlationId,
        durationMs,
        request: {
          method,
          url,
          headers: reqHeaders,
          body: reqBody,
        },
        response: {
          httpStatus: error.response.status,
          headers: error.response.headers,
          body: resData,
          ocpiStatusCode: ocpiCode,
          ocpiStatusMessage: ocpiMsg,
        },
        error: {
          code: `HTTP_${error.response.status}`,
          message: ocpiMsg || error.message,
        },
      });
    } else {
      // Network failure, timeout, ECONNREFUSED, EPROTO, etc. (No HTTP response)
      await recordTransaction({
        direction: "OUTBOUND",
        simulatorRole: simulator.role,
        module: detectModule(url),
        requestId,
        correlationId,
        durationMs,
        request: {
          method,
          url,
          headers: reqHeaders,
          body: reqBody,
        },
        response: null,
        error: {
          code: error.code || "NETWORK_ERROR",
          message: error.message,
        },
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

    await persistHandshakeToDb({
      role: simulator.role,
      partnerRoles: remoteCredentials.roles,
      remoteToken: remoteCredentials.token,
      remoteVersionsUrl: remoteCredentials.url,
      remoteCredentialsUrl: credentialsEndpoint.url,
      endpoints,
      partnerLocationsUrl: state.partnerLocationsUrl,
    });

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

// Helper to persist handshake profile and discovered endpoints to MongoDB
async function persistHandshakeToDb({ role, partnerRoles, remoteToken, remoteVersionsUrl, remoteCredentialsUrl, endpoints, partnerLocationsUrl }) {
  try {
    if (getConnectionStatus() === "CONNECTED") {
      let profile = await OcpiConnectionProfile.findOne({ simulatorRole: role });
      if (!profile) {
        profile = new OcpiConnectionProfile({ simulatorRole: role });
      }
      profile.status = "CONNECTED";
      profile.connectionMode = "HANDSHAKE";
      profile.partnerRoles = partnerRoles;
      profile.remoteToken = remoteToken;
      profile.localToken = CONFIG.localToken;
      profile.remoteVersionsUrl = remoteVersionsUrl;
      profile.remoteCredentialsUrl = remoteCredentialsUrl;
      profile.partnerLocationsUrl = partnerLocationsUrl;
      profile.lastError = null;
      profile.lastHandshakeAt = new Date();
      await profile.save();

      let versionDoc = await OcpiVersion.findOne({ profileId: profile._id, version: CONFIG.version });
      if (!versionDoc) {
        versionDoc = new OcpiVersion({
          profileId: profile._id,
          version: CONFIG.version,
          versionsUrl: remoteVersionsUrl,
          discoveryStatus: "DISCOVERED",
          source: "DISCOVERED",
          enabled: true,
        });
      } else {
        versionDoc.versionsUrl = remoteVersionsUrl;
        versionDoc.discoveryStatus = "DISCOVERED";
      }
      await versionDoc.save();

      if (Array.isArray(endpoints)) {
        for (const ep of endpoints) {
          await OcpiEndpoint.findOneAndUpdate(
            { profileId: profile._id, identifier: ep.identifier, role: ep.role },
            {
              profileId: profile._id,
              versionId: versionDoc._id,
              identifier: ep.identifier,
              role: ep.role,
              url: ep.url,
              source: "DISCOVERED",
              enabled: true,
            },
            { upsert: true, new: true }
          );
        }
      }
    }
  } catch (err) {
    console.error("[MongoDB] Failed to persist handshake state:", err.message);
  }
}

async function persistDirectLocationProfile({ role, endpoint, token }) {
  try {
    if (getConnectionStatus() === "CONNECTED") {
      let profile = await OcpiConnectionProfile.findOne({ simulatorRole: role });
      if (!profile) {
        profile = new OcpiConnectionProfile({ simulatorRole: role });
      }
      profile.connectionMode = "DIRECT_BYPASS";
      profile.partnerLocationsUrl = endpoint;
      profile.remoteToken = token;
      profile.status = "CONNECTED";
      await profile.save();

      await OcpiEndpoint.findOneAndUpdate(
        { profileId: profile._id, identifier: "locations", role: "SENDER" },
        {
          profileId: profile._id,
          identifier: "locations",
          role: "SENDER",
          url: endpoint,
          source: "MANUAL",
          enabled: true,
        },
        { upsert: true, new: true }
      );
    }
  } catch (err) {
    console.error("[MongoDB] Failed to persist direct location profile:", err.message);
  }
}

async function restoreStateFromDb() {
  try {
    if (getConnectionStatus() === "CONNECTED") {
      const profile = await OcpiConnectionProfile.findOne({ simulatorRole: simulator.role }).sort({ updatedAt: -1 });
      if (profile) {
        state.status = profile.status || "DISCONNECTED";
        state.partnerRoles = profile.partnerRoles || [];
        state.remoteToken = profile.remoteToken;
        state.remoteVersionsUrl = profile.remoteVersionsUrl;
        state.remoteCredentialsUrl = profile.remoteCredentialsUrl;
        state.partnerLocationsUrl = profile.partnerLocationsUrl;
        state.lastError = profile.lastError;

        const endpoints = await OcpiEndpoint.find({ profileId: profile._id });
        if (endpoints.length > 0) {
          state.partnerEndpoints = endpoints.map((e) => ({
            identifier: e.identifier,
            role: e.role,
            url: e.url,
          }));
        }
        console.log(`[State] Restored connection state from MongoDB: status=${state.status}`);
      } else {
        console.log("[State] No existing profile found in MongoDB; initialized with clean default state.");
      }
    }
  } catch (err) {
    console.error("[State] Could not restore state from MongoDB:", err.stack || err.message);
  }
}

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
      locations = result.data;
    }
    if (!Array.isArray(locations)) {
      throw new Error("Unexpected Locations response: expected an array in data or a raw array.");
    }

    state.partnerLocationsUrl = parsedUrl.toString();
    state.lastError = null;

    await persistDirectLocationProfile({
      role: simulator.role,
      endpoint: parsedUrl.toString(),
      token: token.trim(),
    });

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
    return res.json({
      endpoint: state.partnerLocationsUrl, count: locations.length, locations, pagination: {
        link: result.headers.link || null, xTotalCount: result.headers["x-total-count"] || null, xLimit: result.headers["x-limit"] || null,
      }
    });
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
  database: {
    status: getConnectionStatus(),
    provider: "MongoDB",
  },
}));

// MongoDB-backed + Memory-fallback Logs API
app.get("/api/logs", async (req, res) => {
  const filter = String(req.query.filter || req.query.type || "ALL").toUpperCase();
  const moduleFilter = req.query.module ? String(req.query.module).toLowerCase() : null;
  const roleFilter = req.query.role ? String(req.query.role).toUpperCase() : null;
  const directionFilter = req.query.direction ? String(req.query.direction).toUpperCase() : null;
  const statusFilter = req.query.status !== undefined ? Number(req.query.status) : null;
  const searchQuery = req.query.search ? String(req.query.search).trim() : null;
  const startDate = req.query.startDate || req.query.date_from ? new Date(req.query.startDate || req.query.date_from) : null;
  const endDate = req.query.endDate || req.query.date_to ? new Date(req.query.endDate || req.query.date_to) : null;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));

  try {
    if (getConnectionStatus() === "CONNECTED") {
      const query = {};

      if (filter === "REQUEST") {
        query.$or = [{ type: "REQUEST" }, { type: "TRANSACTION" }];
      } else if (filter === "RESPONSE") {
        query.$or = [{ type: "RESPONSE" }, { type: "TRANSACTION", response: { $ne: null } }];
      } else if (filter === "ERROR") {
        query.$or = [
          { type: "ERROR" },
          { "error.message": { $ne: null } },
          { transportErrorMessage: { $ne: null } },
          { transportErrorCode: { $ne: null } },
        ];
      } else if (filter === "SUCCESS") {
        query.$or = [
          { httpStatus: { $gte: 200, $lt: 300 } },
          { "response.httpStatus": { $gte: 200, $lt: 300 } },
        ];
      } else if (filter === "HTTP_ERROR") {
        query.$or = [
          { httpStatus: { $gte: 400 } },
          { ocpiStatusCode: { $gt: 1000 } },
          { "response.httpStatus": { $gte: 400 } },
          { "response.ocpiStatusCode": { $gt: 1000 } },
        ];
      } else if (filter === "TRANSPORT_ERROR") {
        query.$or = [
          { type: "ERROR" },
          { transportErrorCode: { $ne: null } },
          { "error.code": { $ne: null } },
          { response: null, type: "TRANSACTION" },
        ];
      } else if (filter === "INBOUND") {
        query.direction = "INBOUND";
      } else if (filter === "OUTBOUND") {
        query.direction = "OUTBOUND";
      }

      if (moduleFilter) query.module = moduleFilter;
      if (roleFilter) query.simulatorRole = roleFilter;
      if (directionFilter && !["INBOUND", "OUTBOUND"].includes(filter)) query.direction = directionFilter;
      if (statusFilter !== null && !isNaN(statusFilter)) {
        query.$or = [{ httpStatus: statusFilter }, { "response.httpStatus": statusFilter }];
      }

      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate && !isNaN(startDate.getTime())) query.timestamp.$gte = startDate;
        if (endDate && !isNaN(endDate.getTime())) query.timestamp.$lte = endDate;
      }

      if (searchQuery) {
        query.$and = query.$and || [];
        query.$and.push({
          $or: [
            { url: { $regex: searchQuery, $options: "i" } },
            { "request.url": { $regex: searchQuery, $options: "i" } },
            { requestId: { $regex: searchQuery, $options: "i" } },
            { correlationId: { $regex: searchQuery, $options: "i" } },
            { transportErrorMessage: { $regex: searchQuery, $options: "i" } },
            { "error.message": { $regex: searchQuery, $options: "i" } },
            { ocpiStatusMessage: { $regex: searchQuery, $options: "i" } },
            { "response.ocpiStatusMessage": { $regex: searchQuery, $options: "i" } },
          ],
        });
      }

      const totalDocuments = await OcpiApiLog.countDocuments(query);
      const totalTransactions = await OcpiApiLog.countDocuments({ type: "TRANSACTION" });
      const legacyRequests = await OcpiApiLog.countDocuments({ type: "REQUEST" });
      const legacyResponses = await OcpiApiLog.countDocuments({ type: "RESPONSE" });
      const totalRequests = totalTransactions + legacyRequests;
      const totalResponses = totalTransactions + legacyResponses;
      const totalErrors = await OcpiApiLog.countDocuments({
        $or: [
          { type: "ERROR" },
          { "error.message": { $ne: null } },
          { transportErrorMessage: { $ne: null } },
          { transportErrorCode: { $ne: null } },
          { httpStatus: { $gte: 400 } },
          { "response.httpStatus": { $gte: 400 } },
        ],
      });

      const docs = await OcpiApiLog.find(query)
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      function formatLogDoc(doc) {
        const reqObj = doc.request || {
          method: doc.method,
          url: doc.url,
          headers: doc.requestHeaders || {},
          body: doc.requestBody ?? null,
        };
        const resObj = doc.response !== undefined ? doc.response : (doc.httpStatus != null || doc.responseBody != null ? {
          httpStatus: doc.httpStatus,
          headers: doc.responseHeaders || {},
          body: doc.responseBody ?? null,
          ocpiStatusCode: doc.ocpiStatusCode,
          ocpiStatusMessage: doc.ocpiStatusMessage,
        } : null);
        const errObj = doc.error || (doc.transportErrorMessage || doc.transportErrorCode ? {
          code: doc.transportErrorCode,
          message: doc.transportErrorMessage,
        } : null);

        return {
          id: doc._id ? doc._id.toString() : doc.id,
          time: doc.timestamp ? (doc.timestamp.toISOString ? doc.timestamp.toISOString() : doc.timestamp) : new Date().toISOString(),
          type: doc.type || "TRANSACTION",
          direction: doc.direction,
          method: reqObj.method || doc.method,
          url: reqObj.url || doc.url,
          httpStatus: resObj ? resObj.httpStatus : doc.httpStatus ?? null,
          ocpiStatus: resObj ? (resObj.ocpiStatusCode ?? resObj.ocpiStatus) : (doc.ocpiStatusCode ?? null),
          ocpiStatusMessage: resObj ? (resObj.ocpiStatusMessage ?? null) : (doc.ocpiStatusMessage ?? null),
          durationMs: doc.durationMs,
          requestId: doc.requestId,
          correlationId: doc.correlationId,
          module: doc.module,
          request: reqObj,
          response: resObj,
          error: errObj,
          headers: reqObj.headers || doc.requestHeaders || {},
          body: reqObj.body !== undefined ? reqObj.body : (doc.requestBody ?? null),
          responseHeaders: resObj ? (resObj.headers || {}) : (doc.responseHeaders || {}),
          responseBody: resObj ? (resObj.body ?? null) : (doc.responseBody ?? null),
          transportErrorCode: errObj ? errObj.code : doc.transportErrorCode,
          transportErrorMessage: errObj ? errObj.message : doc.transportErrorMessage,
          simulatorRole: doc.simulatorRole,
        };
      }

      const logs = docs.map(formatLogDoc);

      return res.json({
        totalRequests,
        totalResponses,
        totalErrors,
        retainedEvents: totalDocuments,
        page,
        limit,
        totalPages: Math.ceil(totalDocuments / limit) || 1,
        source: "MONGODB",
        logs,
      });
    }

    // Memory fallback if MongoDB is not connected
    const memoryLogs = getMemoryLogs();
    const filtered = memoryLogs.filter((entry) => {
      const isTx = entry.type === "TRANSACTION" || Boolean(entry.request);
      const http = entry.response ? entry.response.httpStatus : entry.httpStatus;
      const ocpi = entry.response ? entry.response.ocpiStatusCode : entry.ocpiStatus;
      const err = entry.error || entry.transportErrorMessage || entry.transportErrorCode;

      if (filter === "REQUEST" && !isTx && entry.type !== "REQUEST") return false;
      if (filter === "RESPONSE" && !isTx && entry.type !== "RESPONSE") return false;
      if (filter === "ERROR" && !err && entry.type !== "ERROR") return false;
      if (filter === "INBOUND" && entry.direction !== "INBOUND") return false;
      if (filter === "OUTBOUND" && entry.direction !== "OUTBOUND") return false;
      if (filter === "SUCCESS" && (http == null || http < 200 || http >= 300)) return false;
      if (filter === "HTTP_ERROR" && !((http != null && http >= 400) || (ocpi != null && ocpi !== 1000))) return false;
      if (filter === "TRANSPORT_ERROR" && !(entry.type === "ERROR" || Boolean(err) || (isTx && entry.response === null))) return false;
      if (moduleFilter && entry.module !== moduleFilter) return false;
      if (roleFilter && entry.simulatorRole !== roleFilter) return false;
      if (searchQuery) {
        const str = JSON.stringify(entry).toLowerCase();
        if (!str.includes(searchQuery.toLowerCase())) return false;
      }
      return true;
    });

    return res.json({
      totalRequests: memoryLogs.filter((e) => e.type === "TRANSACTION" || e.type === "REQUEST").length,
      totalResponses: memoryLogs.filter((e) => (e.type === "TRANSACTION" && e.response !== null) || e.type === "RESPONSE").length,
      totalErrors: memoryLogs.filter((e) => e.type === "ERROR" || (e.error && e.error.message) || (e.response && e.response.httpStatus >= 400) || e.httpStatus >= 400).length,
      retainedEvents: memoryLogs.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit) || 1,
      source: "MEMORY",
      logs: filtered.slice().reverse().slice((page - 1) * limit, page * limit),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to retrieve logs: " + err.message });
  }
});

// Retrieve single transaction log by ID
app.get("/api/logs/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "Log ID is required." });

  try {
    if (getConnectionStatus() === "CONNECTED" && mongoose.Types.ObjectId.isValid(id)) {
      const doc = await OcpiApiLog.findById(id).lean();
      if (doc) {
        const reqObj = doc.request || {
          method: doc.method,
          url: doc.url,
          headers: doc.requestHeaders || {},
          body: doc.requestBody ?? null,
        };
        const resObj = doc.response !== undefined ? doc.response : (doc.httpStatus != null || doc.responseBody != null ? {
          httpStatus: doc.httpStatus,
          headers: doc.responseHeaders || {},
          body: doc.responseBody ?? null,
          ocpiStatusCode: doc.ocpiStatusCode,
          ocpiStatusMessage: doc.ocpiStatusMessage,
        } : null);
        const errObj = doc.error || (doc.transportErrorMessage || doc.transportErrorCode ? {
          code: doc.transportErrorCode,
          message: doc.transportErrorMessage,
        } : null);

        return res.json({
          id: doc._id.toString(),
          time: doc.timestamp ? doc.timestamp.toISOString() : new Date().toISOString(),
          type: doc.type || "TRANSACTION",
          direction: doc.direction,
          method: reqObj.method || doc.method,
          url: reqObj.url || doc.url,
          httpStatus: resObj ? resObj.httpStatus : doc.httpStatus ?? null,
          ocpiStatus: resObj ? (resObj.ocpiStatusCode ?? resObj.ocpiStatus) : (doc.ocpiStatusCode ?? null),
          ocpiStatusMessage: resObj ? (resObj.ocpiStatusMessage ?? null) : (doc.ocpiStatusMessage ?? null),
          durationMs: doc.durationMs,
          requestId: doc.requestId,
          correlationId: doc.correlationId,
          module: doc.module,
          request: reqObj,
          response: resObj,
          error: errObj,
          headers: reqObj.headers || doc.requestHeaders || {},
          body: reqObj.body !== undefined ? reqObj.body : (doc.requestBody ?? null),
          responseHeaders: resObj ? (resObj.headers || {}) : (doc.responseHeaders || {}),
          responseBody: resObj ? (resObj.body ?? null) : (doc.responseBody ?? null),
          transportErrorCode: errObj ? errObj.code : doc.transportErrorCode,
          transportErrorMessage: errObj ? errObj.message : doc.transportErrorMessage,
          simulatorRole: doc.simulatorRole,
        });
      }
    }

    const memLog = getMemoryLogs().find((l) => l.id === id || l.requestId === id);
    if (memLog) return res.json(memLog);

    return res.status(404).json({ error: "Log record not found." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/logs", async (req, res) => {
  clearMemoryLogs();
  try {
    if (getConnectionStatus() === "CONNECTED") {
      await OcpiApiLog.deleteMany({});
    }
    return res.json({ message: "Traffic logs cleared." });
  } catch (err) {
    return res.status(500).json({ error: "Failed to clear logs: " + err.message });
  }
});

let serverInstance = null;

async function startServer() {
  await connectDb();
  await restoreStateFromDb();

  return new Promise((resolve) => {
    serverInstance = app.listen(CONFIG.port, () => {
      console.log("---------------------------------------");
      console.log("OCPI 2.2.1 Test Simulator (MongoDB Enabled)");
      console.log(`Database:  ${getConnectionStatus()}`);
      console.log(`Handshake: ${CONFIG.baseUrl}/`);
      console.log(`eMSP page: ${CONFIG.baseUrl}/emsp.html`);
      console.log(`CPO page:  ${CONFIG.baseUrl}/cpo.html`);
      console.log(`Logs:      ${CONFIG.baseUrl}/logs.html`);
      console.log(`Versions:  ${CONFIG.baseUrl}/ocpi/versions`);
      console.log("---------------------------------------");
      resolve(serverInstance);
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error("Failed to start OCPI simulator server:", err);
  });
}

module.exports = {
  app,
  startServer,
  CONFIG,
  simulator,
  state,
};
