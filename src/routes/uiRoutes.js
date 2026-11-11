const express = require("express");
const router = express.Router();
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { getConnectionStatus } = require("../db/connection");
const OcpiConnectionProfile = require("../models/OcpiConnectionProfile");
const OcpiEndpoint = require("../models/OcpiEndpoint");
const OcpiApiLog = require("../models/OcpiApiLog");
const { OcpiLocation } = require("../models/OcpiLocation");
const OcpiTariff = require("../models/OcpiTariff");
const OcpiSession = require("../models/OcpiSession");
const OcpiCdr = require("../models/OcpiCdr");
const OcpiToken = require("../models/OcpiToken");
const {
  CONFIG,
  simulator,
  state,
  memoryLocations,
  memoryTariffs,
  memorySessions,
  memoryCdrs,
  memoryTokens,
  toCleanOcpiLocation,
  toCleanOcpiTariff,
  localRoles,
  localCredentials,
  unwrapOcpiResponse,
  requestHeaders,
  encodeTokenForHeader,
  trackedRequest,
  persistHandshakeToDb,
  persistDirectLocationProfile,
  restoreStateFromDb,
  getActiveSimulatorToken,
  log,
} = require("../services/simulatorState");
const {
  isValidIanaTimeZone,
  checkPowerConsistency,
  formatPriceSummary,
  validateLocationPayload,
} = require("../services/cpoLocationService");
const {
  getSimulationConfig,
  updateSimulationConfig,
  getActiveSimulationState,
  handleStartSessionCommand,
  handleStopSessionCommand,
  resetSimulation,
} = require("../services/sessionSimulationService");
const { getMemoryLogs, clearMemoryLogs } = require("../services/logger");

/* -------------------------------------------------------------------------- */
/* HANDSHAKE & CONNECTIONS                                                    */
/* -------------------------------------------------------------------------- */

// Initiate outgoing credentials handshake
router.post("/handshake", async (req, res) => {
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
      headers: requestHeaders(bootstrapToken, correlationId),
      timeout: 15000,
    });
    const versions = unwrapOcpiResponse(versionsResult);
    if (!Array.isArray(versions)) throw new Error("Partner returned an invalid versions list.");

    const selectedVersion = versions.find((item) => item.version === CONFIG.version);
    if (!selectedVersion?.url) throw new Error("Partner does not advertise OCPI 2.2.1.");

    const detailsResult = await trackedRequest("GET", selectedVersion.url, {
      headers: requestHeaders(bootstrapToken, correlationId),
      timeout: 15000,
    });
    const details = unwrapOcpiResponse(detailsResult);
    const endpoints = details.endpoints || [];
    const credentialsEndpoint = endpoints.find((item) => item.identifier === "credentials");
    if (!credentialsEndpoint?.url) throw new Error("Partner credentials endpoint was not found.");

    const registrationResult = await trackedRequest(
      "POST",
      credentialsEndpoint.url,
      {
        headers: requestHeaders(bootstrapToken, correlationId),
        timeout: 15000,
      },
      {
        token: CONFIG.localToken,
        url: `${CONFIG.baseUrl}/ocpi/versions`,
        roles: localRoles(),
      }
    );

    const remoteCredentials = unwrapOcpiResponse(registrationResult);
    if (
      !remoteCredentials ||
      typeof remoteCredentials.token !== "string" ||
      !remoteCredentials.token ||
      typeof remoteCredentials.url !== "string" ||
      !remoteCredentials.url ||
      !Array.isArray(remoteCredentials.roles) ||
      remoteCredentials.roles.length === 0
    ) {
      throw new Error("Partner returned invalid credentials.");
    }

    state.remoteToken = remoteCredentials.token;
    state.remoteVersionsUrl = remoteCredentials.url;
    state.remoteCredentialsUrl = credentialsEndpoint.url;
    state.partnerRoles = remoteCredentials.roles;
    state.partnerEndpoints = endpoints;
    const locationsEndpoint = endpoints.find(
      (item) => item.identifier === "locations" && item.role === "SENDER"
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
      partnerRoles: remoteCredentials.roles.map(({ role, party_id, country_code }) => ({
        role,
        party_id,
        country_code,
      })),
      partnerLocationsUrl: state.partnerLocationsUrl,
    });

    return res.json({
      status: "CONNECTED",
      role: simulator.role,
      redirectUrl: simulator.role === "EMSP" ? "/emsp" : "/cpo",
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

// GET /api/status
router.get("/status", async (req, res) => {
  if (req.query.profileId) {
    await restoreStateFromDb(req.query.profileId);
  } else {
    if (req.query.role && ["EMSP", "CPO"].includes(String(req.query.role).toUpperCase())) {
      simulator.role = String(req.query.role).toUpperCase();
    }
    await restoreStateFromDb();
  }
  return res.json({
    status: state.status,
    role: simulator.role,
    version: CONFIG.version,
    countryCode: simulator.countryCode,
    partyId: simulator.partyId,
    businessName: simulator.businessName,
    partnerRoles: state.partnerRoles,
    locationsEndpointAvailable: Boolean(state.partnerLocationsUrl),
    partnerLocationsUrl: state.partnerLocationsUrl,
    remoteToken: state.remoteToken,
    remoteTokenBase64: state.remoteToken ? encodeTokenForHeader(state.remoteToken) : null,
    remoteTokenHeader: state.remoteToken ? `Token ${encodeTokenForHeader(state.remoteToken)}` : null,
    localToken: state.localToken || CONFIG.localToken,
    bootstrapToken: state.bootstrapToken || CONFIG.inboundBootstrapToken,
    activeSimulatorToken: getActiveSimulatorToken(),
    activeSimulatorTokenBase64: encodeTokenForHeader(getActiveSimulatorToken()),
    activeSimulatorHeader: `Token ${encodeTokenForHeader(getActiveSimulatorToken())}`,
    tokenPhase: state.status === "CONNECTED" ? "POST_HANDSHAKE" : "PRE_HANDSHAKE",
    remoteVersionsUrl: state.remoteVersionsUrl,
    remoteCredentialsUrl: state.remoteCredentialsUrl,
    partnerEndpoints: state.partnerEndpoints.map(({ identifier, role, url }) => ({
      identifier,
      role,
      url,
    })),
    lastError: state.lastError,
    database: {
      status: getConnectionStatus(),
      provider: "MongoDB",
    },
  });
});

// GET /api/connections
router.get("/connections", async (req, res) => {
  try {
    if (getConnectionStatus() !== "CONNECTED") {
      return res.json({
        total: 0,
        connections: [],
        databaseStatus: getConnectionStatus(),
      });
    }

    const profiles = await OcpiConnectionProfile.find({}).sort({ updatedAt: -1 }).lean();
    const connections = [];

    for (const p of profiles) {
      const endpointsCount = await OcpiEndpoint.countDocuments({ profileId: p._id });
      const partner = p.partnerRoles?.[0] || {};
      const role = p.simulatorRole || "EMSP";
      const redirectUrl = role === "EMSP" ? `/emsp?profileId=${p._id}` : `/cpo?profileId=${p._id}`;

      connections.push({
        id: String(p._id),
        name: p.name || `Partner (${role})`,
        simulatorRole: role,
        connectionMode: p.connectionMode || "HANDSHAKE",
        status: p.status || "DISCONNECTED",
        partnerParty:
          (partner.country_code || "") +
          (partner.country_code && partner.party_id ? " / " : "") +
          (partner.party_id || ""),
        partnerName: partner.business_details?.name || "Partner",
        partnerRoles: p.partnerRoles || [],
        remoteVersionsUrl: p.remoteVersionsUrl || null,
        remoteCredentialsUrl: p.remoteCredentialsUrl || null,
        partnerLocationsUrl: p.partnerLocationsUrl || null,
        hasToken: Boolean(p.remoteToken),
        endpointsCount,
        lastHandshakeAt: p.lastHandshakeAt || p.updatedAt,
        updatedAt: p.updatedAt,
        redirectUrl,
      });
    }

    return res.json({
      total: connections.length,
      connections,
      databaseStatus: getConnectionStatus(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to list connections: " + err.message });
  }
});

/* -------------------------------------------------------------------------- */
/* eMSP CLIENT ACTIONS                                                        */
/* -------------------------------------------------------------------------- */

// GET /api/locations (fetch locations from connected CPO)
router.get("/locations", async (req, res) => {
  const profileId = req.query.profileId;
  if (profileId) {
    await restoreStateFromDb(profileId);
  } else {
    if (simulator.role !== "EMSP") simulator.role = "EMSP";
    if (state.status !== "CONNECTED" || !state.remoteToken || !state.partnerLocationsUrl) {
      await restoreStateFromDb();
    }
  }

  if (state.status !== "CONNECTED" || !state.remoteToken) {
    return res.status(409).json({
      error: "No handshake token is available. Please complete the handshake or seed the profile first.",
    });
  }
  if (!state.partnerLocationsUrl) {
    return res.status(404).json({ error: "Partner did not advertise a Locations SENDER endpoint." });
  }

  try {
    const result = await trackedRequest("GET", state.partnerLocationsUrl, {
      headers: { ...requestHeaders(state.remoteToken, crypto.randomUUID()), "X-Limit": "100" },
      timeout: 20000,
    });
    const locations = unwrapOcpiResponse(result);
    if (!Array.isArray(locations)) {
      throw new Error("Partner returned an unexpected Locations response; expected an array.");
    }
    return res.json({
      endpoint: state.partnerLocationsUrl,
      count: locations.length,
      locations,
      pagination: {
        link: result.headers.link || null,
        xTotalCount: result.headers["x-total-count"] || null,
        xLimit: result.headers["x-limit"] || null,
      },
    });
  } catch (error) {
    const message = error.response?.data?.status_message || error.message || "Locations request failed";
    state.lastError = message;
    return res.status(502).json({
      error: message,
      httpStatus: error.response?.status ?? null,
      ocpiStatus: error.response?.data?.status_code ?? null,
    });
  }
});

// POST /api/locations/direct (direct bypass fetch)
router.post("/locations/direct", async (req, res) => {
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
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Only HTTP/HTTPS URLs are supported.");
    }
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
    const message =
      error.response?.data?.status_message ||
      error.response?.data?.message ||
      error.message ||
      "Locations request failed";
    state.lastError = message;
    return res.status(error.response?.status || 502).json({
      error: message,
      httpStatus: error.response?.status ?? null,
      ocpiStatus: error.response?.data?.status_code ?? null,
    });
  }
});

// POST /api/commands/send (trigger outbound command to partner CPO)
router.post("/commands/send", async (req, res) => {
  const { command, endpoint, token, payload } = req.body || {};
  if (!command || !endpoint || !token) {
    return res.status(400).json({ error: "command, endpoint, and token are required." });
  }

  try {
    const correlationId = crypto.randomUUID();
    const result = await trackedRequest("POST", endpoint, {
      headers: requestHeaders(token, correlationId),
      timeout: 15000,
    }, payload || {});

    return res.json({
      success: true,
      command,
      response: result.data,
    });
  } catch (error) {
    return res.status(502).json({
      error: error.response?.data?.status_message || error.message,
      httpStatus: error.response?.status ?? null,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* CPO DATA MANAGEMENT & BUILDER                                              */
/* -------------------------------------------------------------------------- */

// GET /api/cpo/config
router.get("/cpo/config", (req, res) => {
  return res.json({
    role: "CPO",
    countryCode: simulator.countryCode,
    partyId: simulator.partyId,
    businessName: simulator.businessName,
    version: CONFIG.version,
    baseUrl: CONFIG.baseUrl,
    localToken: state.localToken || CONFIG.localToken,
    bootstrapToken: state.bootstrapToken || CONFIG.inboundBootstrapToken,
    activeSimulatorToken: getActiveSimulatorToken(),
    tokenPhase: state.status === "CONNECTED" ? "POST_HANDSHAKE" : "PRE_HANDSHAKE",
    databaseStatus: getConnectionStatus(),
  });
});

// GET /api/cpo/locations
router.get("/cpo/locations", async (req, res) => {
  try {
    let locations = [];
    if (getConnectionStatus() === "CONNECTED") {
      const docs = await OcpiLocation.find({}).sort({ updatedAt: -1 }).lean();
      locations = docs.map((doc) => ({
        ...toCleanOcpiLocation(doc),
        mongoId: doc._id.toString(),
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      }));
    } else {
      locations = Array.from(memoryLocations.values()).map((loc) => ({
        ...toCleanOcpiLocation(loc),
        mongoId: null,
      }));
    }
    return res.json({ success: true, count: locations.length, locations });
  } catch (err) {
    return res.status(500).json({ error: "Failed to list locations: " + err.message });
  }
});

// GET /api/cpo/locations/:id
router.get("/cpo/locations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let location = null;
    if (getConnectionStatus() === "CONNECTED") {
      const doc = await OcpiLocation.findOne({ id }).lean();
      if (doc) location = { ...toCleanOcpiLocation(doc), mongoId: doc._id.toString() };
    } else {
      const mem = memoryLocations.get(id);
      if (mem) location = { ...toCleanOcpiLocation(mem), mongoId: null };
    }

    if (!location) return res.status(404).json({ error: `Location '${id}' not found.` });
    return res.json({ success: true, location });
  } catch (err) {
    return res.status(500).json({ error: "Failed to get location: " + err.message });
  }
});

// POST /api/cpo/locations (create location)
router.post(["/cpo/locations", "/api/cpo/locations"], async (req, res) => {
  try {
    const payload = req.body || {};

    // Normalize defaults before validation
    payload.country_code = (payload.country_code || simulator.countryCode || "IN").toUpperCase().trim();
    payload.party_id = (payload.party_id || simulator.partyId || "CZK").toUpperCase().trim();
    if (payload.country) payload.country = payload.country.toUpperCase().trim();
    if (!payload.time_zone) payload.time_zone = "Asia/Kolkata";

    if (payload.coordinates) {
      if (payload.coordinates.latitude !== undefined && payload.coordinates.latitude !== null) {
        payload.coordinates.latitude = String(payload.coordinates.latitude).trim();
      }
      if (payload.coordinates.longitude !== undefined && payload.coordinates.longitude !== null) {
        payload.coordinates.longitude = String(payload.coordinates.longitude).trim();
      }
    }

    const validation = validateLocationPayload(payload);
    if (!validation.valid && !validation.isValid) {
      return res.status(400).json({ error: "Validation failed", errors: validation.errors });
    }

    if (!payload.id || !payload.id.trim()) {
      payload.id = `LOC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    } else {
      payload.id = payload.id.trim();
    }

    payload.publish = payload.publish !== false;
    payload.last_updated = new Date().toISOString();

    if (Array.isArray(payload.evses)) {
      payload.evses.forEach((evse, idx) => {
        if (!evse.uid) evse.uid = `EVSE-${idx + 1}`;
        if (!evse.coordinates || !evse.coordinates.latitude || !evse.coordinates.longitude) {
          if (payload.coordinates && payload.coordinates.latitude && payload.coordinates.longitude) {
            evse.coordinates = {
              latitude: String(payload.coordinates.latitude),
              longitude: String(payload.coordinates.longitude)
            };
          }
        }
        if (Array.isArray(evse.connectors)) {
          evse.connectors.forEach((conn, cIdx) => {
            if (!conn.id) conn.id = `CONN-${cIdx + 1}`;
            conn.last_updated = new Date().toISOString();
          });
        }
        evse.last_updated = new Date().toISOString();
      });
    }

    // Save inline tariff if provided alongside the location
    if (payload.inlineTariff && payload.inlineTariff.id) {
      try {
        const t = payload.inlineTariff;
        t.country_code = payload.country_code;
        t.party_id = payload.party_id;
        t.last_updated = new Date().toISOString();
        t.price_summary = formatPriceSummary(t);
        if (getConnectionStatus() === "CONNECTED") {
          await OcpiTariff.findOneAndUpdate({ id: t.id }, t, { upsert: true, new: true });
        }
        memoryTariffs.set(t.id, t);
      } catch (tariffErr) {
        console.warn("[Location] Failed to save inline tariff:", tariffErr.message);
      }
      delete payload.inlineTariff;
    }

    if (getConnectionStatus() === "CONNECTED") {
      const existing = await OcpiLocation.findOne({ id: payload.id });
      if (existing) {
        return res.status(409).json({ error: `Location with ID '${payload.id}' already exists.` });
      }
      const doc = new OcpiLocation(payload);
      await doc.save();
    }
    memoryLocations.set(payload.id, JSON.parse(JSON.stringify(payload)));

    return res.status(201).json({
      success: true,
      message: `Location '${payload.id}' created successfully.`,
      locationId: payload.id,
      location: toCleanOcpiLocation(payload),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to create location: " + err.message });
  }
});

// PUT /api/cpo/locations/:id (update location)
router.put(["/cpo/locations/:id", "/api/cpo/locations/:id"], async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    payload.id = id;
    payload.last_updated = new Date().toISOString();

    if (Array.isArray(payload.evses)) {
      payload.evses.forEach((evse, idx) => {
        if (!evse.uid) evse.uid = `EVSE-${idx + 1}`;
        if (!evse.coordinates || !evse.coordinates.latitude || !evse.coordinates.longitude) {
          if (payload.coordinates && payload.coordinates.latitude && payload.coordinates.longitude) {
            evse.coordinates = {
              latitude: String(payload.coordinates.latitude),
              longitude: String(payload.coordinates.longitude)
            };
          }
        }
        if (Array.isArray(evse.connectors)) {
          evse.connectors.forEach((conn, cIdx) => {
            if (!conn.id) conn.id = `CONN-${cIdx + 1}`;
            conn.last_updated = new Date().toISOString();
          });
        }
        evse.last_updated = new Date().toISOString();
      });
    }

    if (getConnectionStatus() === "CONNECTED") {
      await OcpiLocation.findOneAndUpdate({ id }, payload, { upsert: true, new: true, runValidators: true });
    }
    memoryLocations.set(id, JSON.parse(JSON.stringify(payload)));

    return res.json({
      success: true,
      message: `Location '${id}' updated successfully.`,
      location: toCleanOcpiLocation(payload),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update location: " + err.message });
  }
});

// DELETE /api/cpo/locations/:id
router.delete(["/cpo/locations/:id", "/api/cpo/locations/:id", "/cpo/locations", "/api/cpo/locations"], async (req, res) => {
  try {
    const id = req.params.id || req.query.id || req.body?.id;
    if (!id) {
      return res.status(400).json({ error: "Location ID is required." });
    }
    if (getConnectionStatus() === "CONNECTED") {
      await OcpiLocation.deleteOne({ id });
      if (/^[0-9a-fA-F]{24}$/.test(id)) {
        await OcpiLocation.deleteOne({ _id: id });
      }
    }
    memoryLocations.delete(id);

    return res.json({ success: true, message: `Location '${id}' deleted successfully.` });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete location: " + err.message });
  }
});

// GET /api/cpo/tariffs
router.get("/cpo/tariffs", async (req, res) => {
  try {
    let tariffs = [];
    if (getConnectionStatus() === "CONNECTED") {
      const docs = await OcpiTariff.find({}).sort({ last_updated: -1 }).lean();
      tariffs = docs.map((t) => ({
        ...toCleanOcpiTariff(t),
        price_summary: t.price_summary || formatPriceSummary(t),
      }));
    } else {
      tariffs = Array.from(memoryTariffs.values()).map((t) => ({
        ...toCleanOcpiTariff(t),
        price_summary: t.price_summary || formatPriceSummary(t),
      }));
    }
    return res.json({ success: true, count: tariffs.length, tariffs });
  } catch (err) {
    return res.status(500).json({ error: "Failed to list tariffs: " + err.message });
  }
});

// POST /api/cpo/tariffs
router.post("/cpo/tariffs", async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.id || !payload.id.trim()) {
      payload.id = `TAR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    } else {
      payload.id = payload.id.trim();
    }

    payload.country_code = (payload.country_code || simulator.countryCode).toUpperCase();
    payload.party_id = (payload.party_id || simulator.partyId).toUpperCase();
    payload.currency = (payload.currency || "INR").toUpperCase();
    payload.last_updated = new Date().toISOString();
    payload.price_summary = formatPriceSummary(payload);

    if (getConnectionStatus() === "CONNECTED") {
      await OcpiTariff.findOneAndUpdate({ id: payload.id }, payload, {
        upsert: true,
        new: true,
        runValidators: true,
      });
    }
    memoryTariffs.set(payload.id, JSON.parse(JSON.stringify(payload)));

    return res.json({
      success: true,
      message: `Tariff '${payload.id}' saved successfully.`,
      tariff: toCleanOcpiTariff(payload),
      price_summary: payload.price_summary,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save tariff: " + err.message });
  }
});

// GET /api/cpo/sessions
router.get("/cpo/sessions", async (req, res) => {
  let sessions = [];
  if (getConnectionStatus() === "CONNECTED") {
    sessions = await OcpiSession.find({}).sort({ last_updated: -1 }).lean();
  } else {
    sessions = Array.from(memorySessions.values());
  }
  return res.json({ success: true, count: sessions.length, sessions });
});

// POST /api/cpo/sessions (create/simulate session)
router.post("/cpo/sessions", async (req, res) => {
  const payload = req.body || {};
  payload.id = payload.id || `SES-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  payload.country_code = (payload.country_code || simulator.countryCode).toUpperCase();
  payload.party_id = (payload.party_id || simulator.partyId).toUpperCase();
  payload.start_date_time = payload.start_date_time || new Date().toISOString();
  payload.last_updated = new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiSession.findOneAndUpdate({ id: payload.id }, payload, { upsert: true, new: true });
  }
  memorySessions.set(payload.id, payload);

  return res.json({ success: true, session: payload });
});

// GET /api/cpo/cdrs
router.get("/cpo/cdrs", async (req, res) => {
  let cdrs = [];
  if (getConnectionStatus() === "CONNECTED") {
    cdrs = await OcpiCdr.find({}).sort({ last_updated: -1 }).lean();
  } else {
    cdrs = Array.from(memoryCdrs.values());
  }
  return res.json({ success: true, count: cdrs.length, cdrs });
});

// POST /api/cpo/cdrs (create CDR)
router.post("/cpo/cdrs", async (req, res) => {
  const payload = req.body || {};
  payload.id = payload.id || `CDR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  payload.country_code = (payload.country_code || simulator.countryCode).toUpperCase();
  payload.party_id = (payload.party_id || simulator.partyId).toUpperCase();
  payload.start_date_time = payload.start_date_time || new Date(Date.now() - 3600000).toISOString();
  payload.stop_date_time = payload.stop_date_time || new Date().toISOString();
  payload.last_updated = new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiCdr.findOneAndUpdate({ id: payload.id }, payload, { upsert: true, new: true });
  }
  memoryCdrs.set(payload.id, payload);

  return res.json({ success: true, cdr: payload });
});

// GET /api/cpo/tokens
router.get("/cpo/tokens", async (req, res) => {
  let tokens = [];
  if (getConnectionStatus() === "CONNECTED") {
    tokens = await OcpiToken.find({}).sort({ last_updated: -1 }).lean();
  } else {
    tokens = Array.from(memoryTokens.values());
  }
  return res.json({ success: true, count: tokens.length, tokens });
});

// POST /api/cpo/tokens
router.post("/cpo/tokens", async (req, res) => {
  const payload = req.body || {};
  payload.uid = payload.uid || `TOK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  payload.country_code = (payload.country_code || simulator.countryCode).toUpperCase();
  payload.party_id = (payload.party_id || simulator.partyId).toUpperCase();
  payload.last_updated = new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiToken.findOneAndUpdate({ uid: payload.uid }, payload, { upsert: true, new: true });
  }
  memoryTokens.set(payload.uid, payload);

  return res.json({ success: true, token: payload });
});

/* -------------------------------------------------------------------------- */
/* LOGS & MONITORING                                                          */
/* -------------------------------------------------------------------------- */

// GET /api/logs
router.get("/logs", async (req, res) => {
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
        const resObj =
          doc.response !== undefined
            ? doc.response
            : doc.httpStatus != null || doc.responseBody != null
            ? {
                httpStatus: doc.httpStatus,
                headers: doc.responseHeaders || {},
                body: doc.responseBody ?? null,
                ocpiStatusCode: doc.ocpiStatusCode,
                ocpiStatusMessage: doc.ocpiStatusMessage,
              }
            : null;
        const errObj =
          doc.error ||
          (doc.transportErrorMessage || doc.transportErrorCode
            ? {
                code: doc.transportErrorCode,
                message: doc.transportErrorMessage,
              }
            : null);

        return {
          id: doc._id ? doc._id.toString() : doc.id,
          time: doc.timestamp
            ? doc.timestamp.toISOString
              ? doc.timestamp.toISOString()
              : doc.timestamp
            : new Date().toISOString(),
          type: doc.type || "TRANSACTION",
          direction: doc.direction,
          method: reqObj.method || doc.method,
          url: reqObj.url || doc.url,
          httpStatus: resObj ? resObj.httpStatus : doc.httpStatus ?? null,
          ocpiStatus: resObj ? resObj.ocpiStatusCode ?? resObj.ocpiStatus : doc.ocpiStatusCode ?? null,
          ocpiStatusMessage: resObj ? resObj.ocpiStatusMessage ?? null : doc.ocpiStatusMessage ?? null,
          durationMs: doc.durationMs,
          requestId: doc.requestId,
          correlationId: doc.correlationId,
          module: doc.module,
          request: reqObj,
          response: resObj,
          error: errObj,
          headers: reqObj.headers || doc.requestHeaders || {},
          body: reqObj.body !== undefined ? reqObj.body : doc.requestBody ?? null,
          responseHeaders: resObj ? resObj.headers || {} : doc.responseHeaders || {},
          responseBody: resObj ? resObj.body ?? null : doc.responseBody ?? null,
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

    // In-memory fallback
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
      totalErrors: memoryLogs.filter(
        (e) =>
          e.type === "ERROR" ||
          (e.error && e.error.message) ||
          (e.response && e.response.httpStatus >= 400) ||
          e.httpStatus >= 400
      ).length,
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

// GET /api/logs/:id
router.get("/logs/:id", async (req, res) => {
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
        const resObj =
          doc.response !== undefined
            ? doc.response
            : doc.httpStatus != null || doc.responseBody != null
            ? {
                httpStatus: doc.httpStatus,
                headers: doc.responseHeaders || {},
                body: doc.responseBody ?? null,
                ocpiStatusCode: doc.ocpiStatusCode,
                ocpiStatusMessage: doc.ocpiStatusMessage,
              }
            : null;
        const errObj =
          doc.error ||
          (doc.transportErrorMessage || doc.transportErrorCode
            ? {
                code: doc.transportErrorCode,
                message: doc.transportErrorMessage,
              }
            : null);

        return res.json({
          id: doc._id.toString(),
          time: doc.timestamp ? doc.timestamp.toISOString() : new Date().toISOString(),
          type: doc.type || "TRANSACTION",
          direction: doc.direction,
          method: reqObj.method || doc.method,
          url: reqObj.url || doc.url,
          httpStatus: resObj ? resObj.httpStatus : doc.httpStatus ?? null,
          ocpiStatus: resObj ? resObj.ocpiStatusCode ?? resObj.ocpiStatus : doc.ocpiStatusCode ?? null,
          ocpiStatusMessage: resObj ? resObj.ocpiStatusMessage ?? null : doc.ocpiStatusMessage ?? null,
          durationMs: doc.durationMs,
          requestId: doc.requestId,
          correlationId: doc.correlationId,
          module: doc.module,
          request: reqObj,
          response: resObj,
          error: errObj,
          headers: reqObj.headers || doc.requestHeaders || {},
          body: reqObj.body !== undefined ? reqObj.body : doc.requestBody ?? null,
          responseHeaders: resObj ? resObj.headers || {} : doc.responseHeaders || {},
          responseBody: resObj ? resObj.body ?? null : doc.responseBody ?? null,
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

// DELETE /api/logs
router.delete("/logs", async (req, res) => {
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

/* -------------------------------------------------------------------------- */
/* SESSION SIMULATION CONTROLLER (UI API)                                     */
/* -------------------------------------------------------------------------- */

// GET /api/simulation/session
router.get("/simulation/session", (req, res) => {
  return res.json({
    success: true,
    simulation: getActiveSimulationState(),
  });
});

// POST /api/simulation/config
router.post("/simulation/config", (req, res) => {
  const updated = updateSimulationConfig(req.body || {});
  return res.json({
    success: true,
    config: updated,
    simulation: getActiveSimulationState(),
  });
});

// POST /api/simulation/start (UI trigger)
router.post("/simulation/start", async (req, res) => {
  try {
    const { location_id, evse_uid, connector_id, token, response_url } = req.body || {};

    // Default token if not provided
    const sessionToken = token || {
      country_code: simulator.countryCode,
      party_id: simulator.partyId,
      uid: "TOK-SIM-001",
      type: "RFID",
      contract_id: "CZK-CONTRACT-001",
      valid: true,
      issuer: simulator.businessName,
    };

    // If location_id is not specified, grab first available location
    let targetLocationId = location_id;
    if (!targetLocationId) {
      if (getConnectionStatus() === "CONNECTED") {
        const first = await OcpiLocation.findOne({}).lean();
        if (first) targetLocationId = first.id;
      } else {
        const first = Array.from(memoryLocations.values())[0];
        if (first) targetLocationId = first.id;
      }
    }

    if (!targetLocationId) {
      return res.status(400).json({
        success: false,
        error: "No charging locations available in CPO simulator. Please create a location first.",
      });
    }

    const payload = {
      response_url: response_url || `${CONFIG.baseUrl}/api/simulation/callback`,
      token: sessionToken,
      location_id: targetLocationId,
      evse_uid: evse_uid || null,
      connector_id: connector_id || null,
      authorization_reference: `AUTH-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    };

    const outcome = await handleStartSessionCommand(payload);
    if (!outcome.isValid || outcome.response.result === "REJECTED") {
      return res.status(400).json({
        success: false,
        error: outcome.response.message?.[0]?.text || "Failed to start session",
        response: outcome.response,
      });
    }

    return res.json({
      success: true,
      message: outcome.response.message?.[0]?.text || "Session started successfully",
      session: outcome.session,
      simulation: getActiveSimulationState(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/simulation/stop (UI trigger)
router.post("/simulation/stop", async (req, res) => {
  try {
    const stateData = getActiveSimulationState();
    const sessionId = req.body?.session_id || stateData.sessionId;

    if (!sessionId) {
      return res.status(400).json({ success: false, error: "No active session ID provided or found running." });
    }

    const outcome = await handleStopSessionCommand({
      session_id: sessionId,
      response_url: req.body?.response_url || `${CONFIG.baseUrl}/api/simulation/callback`,
    });

    if (!outcome.isValid || outcome.response.result === "REJECTED") {
      return res.status(400).json({
        success: false,
        error: outcome.response.message?.[0]?.text || "Failed to stop session",
        response: outcome.response,
      });
    }

    return res.json({
      success: true,
      message: outcome.response.message?.[0]?.text || "Session stopped successfully",
      session: outcome.session,
      cdr: outcome.cdr,
      simulation: getActiveSimulationState(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/simulation/reset
router.post("/simulation/reset", (req, res) => {
  const resetState = resetSimulation();
  return res.json({
    success: true,
    message: "Simulation reset to IDLE",
    simulation: resetState,
  });
});

module.exports = router;
