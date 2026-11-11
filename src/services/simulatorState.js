const crypto = require("node:crypto");
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.randomUUID) {
  globalThis.crypto = crypto;
}
if (typeof global.crypto === "undefined") {
  global.crypto = crypto;
}

const axios = require("axios");
const mongoose = require("mongoose");
const { getConnectionStatus } = require("../db/connection");
const OcpiConnectionProfile = require("../models/OcpiConnectionProfile");
const OcpiVersion = require("../models/OcpiVersion");
const OcpiEndpoint = require("../models/OcpiEndpoint");
const { OcpiLocation } = require("../models/OcpiLocation");
const OcpiTariff = require("../models/OcpiTariff");
const OcpiSession = require("../models/OcpiSession");
const OcpiCdr = require("../models/OcpiCdr");
const OcpiToken = require("../models/OcpiToken");
const { recordTransaction, detectModule, redact } = require("./logger");
const { memoryLocations, memoryTariffs, toCleanOcpiLocation, toCleanOcpiTariff, omitNulls } = require("./cpoLocationService");

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
  activeProfileId: null,
  status: "DISCONNECTED",
  partnerRoles: [],
  remoteToken: null,
  localToken: CONFIG.localToken,
  bootstrapToken: CONFIG.inboundBootstrapToken,
  remoteVersionsUrl: null,
  remoteCredentialsUrl: null,
  partnerEndpoints: [],
  partnerLocationsUrl: null,
  lastError: null,
};

// In-Memory resource maps (synced with MongoDB if connected)
const memorySessions = new Map();
const memoryCdrs = new Map();
const memoryTokens = new Map();
const memoryCommands = new Map();
const memoryChargingProfiles = new Map();

// Seed initial realistic OCPI 2.2.1 mock data
function seedInitialData() {
  const now = new Date().toISOString();

  // Mock Tokens
  const sampleToken1 = {
    country_code: "IN",
    party_id: "CZS",
    uid: "TOK-998877",
    type: "RFID",
    contract_id: "CZS-CONTRACT-001",
    visual_number: "RFID-998877",
    issuer: "ChargeZone Simulator",
    group_id: null,
    valid: true,
    whitelist: "ALWAYS",
    language: "en",
    default_profile_type: "REGULAR",
    last_updated: now,
  };
  const sampleToken2 = {
    country_code: "IN",
    party_id: "CZS",
    uid: "APP-USER-4242",
    type: "APP_USER",
    contract_id: "CZS-APP-002",
    visual_number: "APP-4242",
    issuer: "ChargeZone Simulator",
    group_id: null,
    valid: true,
    whitelist: "ALLOWED",
    language: "en",
    default_profile_type: "FAST",
    last_updated: now,
  };
  memoryTokens.set(sampleToken1.uid, sampleToken1);
  memoryTokens.set(sampleToken2.uid, sampleToken2);

  // Mock Sessions
  const sampleSession1 = {
    country_code: "IN",
    party_id: "CZS",
    id: "SES-1001",
    start_date_time: new Date(Date.now() - 3600000).toISOString(),
    end_date_time: null,
    kwh: 14.85,
    cdr_token: {
      country_code: "IN",
      party_id: "CZS",
      uid: "TOK-998877",
      type: "RFID",
      contract_id: "CZS-CONTRACT-001",
    },
    auth_method: "WHITELIST",
    authorization_reference: "AUTH-REF-1001",
    location_id: "LOC-001",
    evse_uid: "EVSE-01",
    connector_id: "CONN-1",
    meter_id: "METER-12345",
    currency: "INR",
    charging_periods: [
      {
        start_date_time: new Date(Date.now() - 3600000).toISOString(),
        dimensions: [
          { type: "ENERGY", volume: 14.85 },
          { type: "TIME", volume: 1.0 },
        ],
      },
    ],
    total_cost: { excl_vat: 267.3, incl_vat: 315.41 },
    status: "ACTIVE",
    last_updated: now,
  };
  memorySessions.set(sampleSession1.id, sampleSession1);

  // Mock CDRs
  const sampleCdr1 = {
    country_code: "IN",
    party_id: "CZS",
    id: "CDR-8801",
    start_date_time: new Date(Date.now() - 7200000).toISOString(),
    stop_date_time: new Date(Date.now() - 3600000).toISOString(),
    session_id: "SES-0999",
    cdr_token: {
      country_code: "IN",
      party_id: "CZS",
      uid: "TOK-998877",
      type: "RFID",
      contract_id: "CZS-CONTRACT-001",
    },
    auth_method: "WHITELIST",
    authorization_reference: "AUTH-REF-0999",
    cdr_location: {
      id: "LOC-001",
      name: "Connaught Place Hub 1",
      address: "Inner Circle, Connaught Place",
      city: "New Delhi",
      postal_code: "110001",
      country: "IND",
      coordinates: { latitude: "28.6315", longitude: "77.2167" },
      evse_uid: "EVSE-01",
      evse_id: "IN*CZS*E001",
      connector_id: "CONN-1",
      connector_standard: "IEC_62196_T2",
      connector_format: "SOCKET",
      connector_power_type: "AC_3_PHASE",
    },
    currency: "INR",
    tariffs: [],
    charging_periods: [
      {
        start_date_time: new Date(Date.now() - 7200000).toISOString(),
        dimensions: [
          { type: "ENERGY", volume: 22.5 },
          { type: "TIME", volume: 1.0 },
        ],
      },
    ],
    total_cost: { excl_vat: 405.0, incl_vat: 477.9 },
    total_fixed_cost: { excl_vat: 0, incl_vat: 0 },
    total_energy: 22.5,
    total_energy_cost: { excl_vat: 405.0, incl_vat: 477.9 },
    total_time: 1.0,
    total_time_cost: { excl_vat: 0, incl_vat: 0 },
    total_parking_time: 0,
    total_parking_cost: { excl_vat: 0, incl_vat: 0 },
    remark: "Standard simulated AC fast charge",
    credit: false,
    last_updated: now,
  };
  memoryCdrs.set(sampleCdr1.id, sampleCdr1);
}

seedInitialData();

function log(message, details = {}) {
  console.log({ time: new Date().toISOString(), message, details: redact(details) });
}

function ocpiResponse(data, statusCode = 1000, message = "Success") {
  return {
    data: data === null || data === undefined ? null : omitNulls(data),
    status_code: statusCode,
    status_message: message,
    timestamp: new Date().toISOString(),
  };
}

function isAuthorized(req, expectedToken) {
  if (!expectedToken) return false;
  const header = req.get("Authorization") || req.get("X-Ocpi-Token") || req.get("X-Token");
  if (!header) return false;
  const trimmed = header.trim();
  const parts = trimmed.split(/\s+/);
  const tokenInHeader = (parts.length === 2 && (parts[0].toLowerCase() === "token" || parts[0].toLowerCase() === "bearer"))
    ? parts[1]
    : trimmed.replace(/^Token\s+/i, "").replace(/^Bearer\s+/i, "").trim();

  // 1. Direct raw token match
  if (tokenInHeader === expectedToken) return true;

  // 2. Base64 encoded match (Standard OCPI 2.2.1: Authorization: Token <base64(rawToken)>)
  const expectedBase64 = Buffer.from(expectedToken, "utf8").toString("base64");
  if (tokenInHeader === expectedBase64) return true;

  // 3. Base64 decoded match: token in header decoded from Base64 matches raw token
  try {
    const decoded = Buffer.from(tokenInHeader, "base64").toString("utf8");
    if (decoded && decoded === expectedToken) return true;
  } catch (_) {}

  // 4. In case expectedToken itself was stored as Base64 in state/DB
  try {
    const expectedDecoded = Buffer.from(expectedToken, "base64").toString("utf8");
    if (expectedDecoded && (tokenInHeader === expectedDecoded || tokenInHeader === expectedToken)) return true;
  } catch (_) {}

  return false;
}

function getActiveSimulatorToken() {
  if (state.status === "CONNECTED" && state.localToken) {
    return state.localToken;
  }
  return state.bootstrapToken || CONFIG.inboundBootstrapToken;
}

function localRoles() {
  return [
    {
      role: simulator.role,
      party_id: simulator.partyId,
      country_code: simulator.countryCode,
      business_details: { name: simulator.businessName },
    },
  ];
}

function localCredentials() {
  return {
    token: state.localToken || CONFIG.localToken,
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

function encodeTokenForHeader(token) {
  if (!token) return "";
  const clean = String(token).trim().replace(/^Token\s+/i, "").replace(/^Bearer\s+/i, "").trim();
  const isBase64Pattern = clean.length > 0 && clean.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(clean);
  if (isBase64Pattern) {
    try {
      const decoded = Buffer.from(clean, "base64").toString("utf8");
      const reencoded = Buffer.from(decoded, "utf8").toString("base64");
      if (reencoded === clean && /^[\x20-\x7E\s]+$/.test(decoded) && decoded !== clean) {
        return clean;
      }
    } catch (_) {}
  }
  return Buffer.from(clean, "utf8").toString("base64");
}

function requestHeaders(token, correlationId, options = {}) {
  const cleanToken = String(token || "").trim().replace(/^Token\s+/i, "").replace(/^Bearer\s+/i, "").trim();
  // Standard OCPI 2.2.1 requires the credentials token to be Base64-encoded in the HTTP Authorization header
  const headerToken = options.raw ? cleanToken : encodeTokenForHeader(cleanToken);

  return {
    Authorization: `Token ${headerToken}`,
    "X-Request-ID": crypto.randomUUID(),
    "X-Correlation-ID": correlationId || crypto.randomUUID(),
    "Content-Type": "application/json",
  };
}

function buildLinkHeader(baseUrl, offset, limit, total) {
  const links = [];
  const nextOffset = offset + limit;
  if (nextOffset < total) {
    links.push(`<${baseUrl}?offset=${nextOffset}&limit=${limit}>; rel="next"`);
  }
  if (offset > 0) {
    const prevOffset = Math.max(0, offset - limit);
    links.push(`<${baseUrl}?offset=${prevOffset}&limit=${limit}>; rel="prev"`);
  }
  return links.length ? links.join(", ") : null;
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

async function restoreStateFromDb(profileId = null) {
  try {
    if (getConnectionStatus() === "CONNECTED") {
      let query;
      if (profileId && mongoose.isValidObjectId(profileId)) {
        query = { _id: profileId };
      } else {
        query = { simulatorRole: simulator.role };
      }
      const profile = await OcpiConnectionProfile.findOne(query).sort({ updatedAt: -1 });
      if (profile) {
        state.activeProfileId = String(profile._id);
        simulator.role = profile.simulatorRole;
        state.status = profile.status || "DISCONNECTED";
        state.partnerRoles = profile.partnerRoles || [];
        state.remoteToken = profile.remoteToken;
        state.localToken = profile.localToken || CONFIG.localToken;
        state.bootstrapToken = profile.bootstrapToken || CONFIG.inboundBootstrapToken;
        state.remoteVersionsUrl = profile.remoteVersionsUrl;
        state.remoteCredentialsUrl = profile.remoteCredentialsUrl;
        state.partnerLocationsUrl = profile.partnerLocationsUrl;
        state.lastError = profile.lastError;

        const endpoints = await OcpiEndpoint.find({ profileId: profile._id });
        state.partnerEndpoints = endpoints.map((e) => ({
          identifier: e.identifier,
          role: e.role,
          url: e.url,
        }));
        console.log(`[State] Restored connection state for profile ${profile._id}: role=${simulator.role}, status=${state.status}, localToken=${Boolean(state.localToken)}, endpoints=${endpoints.length}`);
      }
    }
  } catch (err) {
    console.error("[State] Could not restore state from MongoDB:", err.stack || err.message);
  }
}

// Authentication middleware for OCPI endpoints
const validateOcpiAuth = (req, res, next) => {
  const authHeader = req.get("Authorization") || req.get("X-Ocpi-Token") || req.get("X-Token");
  if (!authHeader) {
    return res.status(200).json(ocpiResponse(null, 2001, "Authorization header required (Token <token>)"));
  }

  // If connected, active token is required
  if (state.status === "CONNECTED" && state.localToken) {
    if (isAuthorized(req, state.localToken) || (CONFIG.localToken && isAuthorized(req, CONFIG.localToken))) {
      return next();
    }
    return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized token: handshake is complete, please use the active token"));
  }

  // Fallback to bootstrap / local tokens
  const validBootstrap = state.bootstrapToken || CONFIG.inboundBootstrapToken;
  if (
    (validBootstrap && isAuthorized(req, validBootstrap)) ||
    (state.localToken && isAuthorized(req, state.localToken)) ||
    (CONFIG.localToken && isAuthorized(req, CONFIG.localToken))
  ) {
    return next();
  }

  return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized token"));
};

module.exports = {
  CONFIG,
  simulator,
  state,
  memorySessions,
  memoryCdrs,
  memoryTokens,
  memoryCommands,
  memoryChargingProfiles,
  memoryLocations,
  memoryTariffs,
  toCleanOcpiLocation,
  toCleanOcpiTariff,
  omitNulls,
  log,
  ocpiResponse,
  isAuthorized,
  localRoles,
  localCredentials,
  unwrapOcpiResponse,
  requestHeaders,
  buildLinkHeader,
  trackedRequest,
  persistHandshakeToDb,
  persistDirectLocationProfile,
  restoreStateFromDb,
  validateOcpiAuth,
  getActiveSimulatorToken,
  encodeTokenForHeader,
};
