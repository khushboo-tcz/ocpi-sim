const express = require("express");
const router = express.Router();
const crypto = require("node:crypto");
const { getConnectionStatus } = require("../db/connection");
const { OcpiLocation } = require("../models/OcpiLocation");
const OcpiTariff = require("../models/OcpiTariff");
const OcpiSession = require("../models/OcpiSession");
const OcpiCdr = require("../models/OcpiCdr");
const OcpiToken = require("../models/OcpiToken");
const {
  CONFIG,
  state,
  simulator,
  memoryLocations,
  memoryTariffs,
  memorySessions,
  memoryCdrs,
  memoryTokens,
  memoryCommands,
  memoryChargingProfiles,
  toCleanOcpiLocation,
  toCleanOcpiTariff,
  omitNulls,
  ocpiResponse,
  buildLinkHeader,
  validateOcpiAuth,
  requestHeaders,
  trackedRequest,
  log,
} = require("../services/simulatorState");

// Middleware: Ensure every JSON response coming out of CPO routes has null fields stripped
router.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (body && typeof body === "object") {
      if (body.data !== undefined) {
        body.data = body.data === null ? null : omitNulls(body.data);
      } else {
        body = omitNulls(body);
      }
    }
    return originalJson(body);
  };
  next();
});

/* -------------------------------------------------------------------------- */
/* LOCATIONS MODULE (CPO SENDER)                                              */
/* -------------------------------------------------------------------------- */

// GET /locations (with pagination and date filtering)
const cpoLocationsHandler = async (req, res) => {
  try {
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { date_from, date_to } = req.query;

    let filter = {};
    if (date_from || date_to) {
      filter.last_updated = {};
      if (date_from) filter.last_updated.$gte = date_from;
      if (date_to) filter.last_updated.$lte = date_to;
    }

    let total = 0;
    let locations = [];

    if (getConnectionStatus() === "CONNECTED") {
      total = await OcpiLocation.countDocuments(filter);
      const docs = await OcpiLocation.find(filter)
        .sort({ last_updated: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
      locations = docs.map(toCleanOcpiLocation);
    } else {
      let list = Array.from(memoryLocations.values());
      if (date_from) list = list.filter((l) => l.last_updated >= date_from);
      if (date_to) list = list.filter((l) => l.last_updated <= date_to);
      total = list.length;
      locations = list.slice(offset, offset + limit).map(toCleanOcpiLocation);
    }

    res.set("X-Total-Count", String(total));
    res.set("X-Limit", String(limit));
    const linkHeader = buildLinkHeader(`${CONFIG.baseUrl}${req.baseUrl}/locations`, offset, limit, total);
    if (linkHeader) res.set("Link", linkHeader);

    return res.json(ocpiResponse(locations));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, "Internal error: " + err.message));
  }
};
router.get("/locations", validateOcpiAuth, cpoLocationsHandler);

// GET /locations/:location_id
const cpoSingleLocationHandler = async (req, res) => {
  const { location_id } = req.params;
  try {
    let loc = null;
    if (getConnectionStatus() === "CONNECTED") {
      const doc = await OcpiLocation.findOne({ id: location_id }).lean();
      if (doc) loc = toCleanOcpiLocation(doc);
    } else {
      const mem = memoryLocations.get(location_id);
      if (mem) loc = toCleanOcpiLocation(mem);
    }

    if (!loc) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Location: ${location_id}`));
    }
    return res.json(ocpiResponse(loc));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
};
router.get("/locations/:location_id", validateOcpiAuth, cpoSingleLocationHandler);

// GET /locations/:location_id/:evse_uid
const cpoEvseHandler = async (req, res) => {
  const { location_id, evse_uid } = req.params;
  try {
    let loc = null;
    if (getConnectionStatus() === "CONNECTED") {
      const doc = await OcpiLocation.findOne({ id: location_id }).lean();
      if (doc) loc = toCleanOcpiLocation(doc);
    } else {
      const mem = memoryLocations.get(location_id);
      if (mem) loc = toCleanOcpiLocation(mem);
    }

    if (!loc) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Location: ${location_id}`));
    }
    const evse = (loc.evses || []).find((e) => e.uid === evse_uid);
    if (!evse) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown EVSE: ${evse_uid}`));
    }
    return res.json(ocpiResponse(evse));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
};
router.get("/locations/:location_id/:evse_uid", validateOcpiAuth, cpoEvseHandler);

// GET /locations/:location_id/:evse_uid/:connector_id
const cpoConnectorHandler = async (req, res) => {
  const { location_id, evse_uid, connector_id } = req.params;
  try {
    let loc = null;
    if (getConnectionStatus() === "CONNECTED") {
      const doc = await OcpiLocation.findOne({ id: location_id }).lean();
      if (doc) loc = toCleanOcpiLocation(doc);
    } else {
      const mem = memoryLocations.get(location_id);
      if (mem) loc = toCleanOcpiLocation(mem);
    }

    if (!loc) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Location: ${location_id}`));
    }
    const evse = (loc.evses || []).find((e) => e.uid === evse_uid);
    if (!evse) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown EVSE: ${evse_uid}`));
    }
    const conn = (evse.connectors || []).find((c) => c.id === connector_id);
    if (!conn) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Connector: ${connector_id}`));
    }
    return res.json(ocpiResponse(conn));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
};
router.get("/locations/:location_id/:evse_uid/:connector_id", validateOcpiAuth, cpoConnectorHandler);

/* -------------------------------------------------------------------------- */
/* TARIFFS MODULE (CPO SENDER)                                                */
/* -------------------------------------------------------------------------- */

// GET /tariffs
router.get("/tariffs", validateOcpiAuth, async (req, res) => {
  try {
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { date_from, date_to } = req.query;

    let filter = {};
    if (date_from || date_to) {
      filter.last_updated = {};
      if (date_from) filter.last_updated.$gte = date_from;
      if (date_to) filter.last_updated.$lte = date_to;
    }

    let total = 0;
    let tariffs = [];

    if (getConnectionStatus() === "CONNECTED") {
      total = await OcpiTariff.countDocuments(filter);
      const docs = await OcpiTariff.find(filter)
        .sort({ last_updated: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
      tariffs = docs.map(toCleanOcpiTariff);
    } else {
      let list = Array.from(memoryTariffs.values());
      if (date_from) list = list.filter((t) => t.last_updated >= date_from);
      if (date_to) list = list.filter((t) => t.last_updated <= date_to);
      total = list.length;
      tariffs = list.slice(offset, offset + limit).map(toCleanOcpiTariff);
    }

    res.set("X-Total-Count", String(total));
    res.set("X-Limit", String(limit));
    const linkHeader = buildLinkHeader(`${CONFIG.baseUrl}${req.baseUrl}/tariffs`, offset, limit, total);
    if (linkHeader) res.set("Link", linkHeader);

    return res.json(ocpiResponse(tariffs));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// GET /tariffs/:tariff_id
router.get("/tariffs/:tariff_id", validateOcpiAuth, async (req, res) => {
  const { tariff_id } = req.params;
  try {
    let tariff = null;
    if (getConnectionStatus() === "CONNECTED") {
      const doc = await OcpiTariff.findOne({ id: tariff_id }).lean();
      if (doc) tariff = toCleanOcpiTariff(doc);
    } else {
      const mem = memoryTariffs.get(tariff_id);
      if (mem) tariff = toCleanOcpiTariff(mem);
    }

    if (!tariff) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Tariff: ${tariff_id}`));
    }
    return res.json(ocpiResponse(tariff));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// PUT /tariffs/:tariff_id
router.put("/tariffs/:tariff_id", validateOcpiAuth, async (req, res) => {
  const { tariff_id } = req.params;
  const payload = req.body;
  if (!payload) return res.status(200).json(ocpiResponse(null, 2001, "Invalid payload"));

  payload.id = tariff_id;
  payload.last_updated = new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiTariff.findOneAndUpdate({ id: tariff_id }, payload, { upsert: true, new: true });
  }
  memoryTariffs.set(tariff_id, payload);

  return res.json(ocpiResponse(payload, 1000, "Tariff created or updated"));
});

// DELETE /tariffs/:tariff_id
router.delete("/tariffs/:tariff_id", validateOcpiAuth, async (req, res) => {
  const { tariff_id } = req.params;
  if (getConnectionStatus() === "CONNECTED") {
    await OcpiTariff.deleteOne({ id: tariff_id });
  }
  memoryTariffs.delete(tariff_id);

  return res.json(ocpiResponse(null, 1000, `Tariff ${tariff_id} deleted`));
});

/* -------------------------------------------------------------------------- */
/* SESSIONS MODULE (CPO SENDER)                                               */
/* -------------------------------------------------------------------------- */

// GET /sessions
router.get("/sessions", validateOcpiAuth, async (req, res) => {
  try {
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { date_from, date_to } = req.query;

    let filter = {};
    if (date_from || date_to) {
      filter.last_updated = {};
      if (date_from) filter.last_updated.$gte = date_from;
      if (date_to) filter.last_updated.$lte = date_to;
    }

    let total = 0;
    let sessions = [];

    if (getConnectionStatus() === "CONNECTED") {
      total = await OcpiSession.countDocuments(filter);
      sessions = await OcpiSession.find(filter)
        .sort({ last_updated: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
    } else {
      let list = Array.from(memorySessions.values());
      if (date_from) list = list.filter((s) => s.last_updated >= date_from);
      if (date_to) list = list.filter((s) => s.last_updated <= date_to);
      total = list.length;
      sessions = list.slice(offset, offset + limit);
    }

    res.set("X-Total-Count", String(total));
    res.set("X-Limit", String(limit));
    const linkHeader = buildLinkHeader(`${CONFIG.baseUrl}${req.baseUrl}/sessions`, offset, limit, total);
    if (linkHeader) res.set("Link", linkHeader);

    return res.json(ocpiResponse(sessions));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// GET /sessions/:session_id
router.get("/sessions/:session_id", validateOcpiAuth, async (req, res) => {
  const { session_id } = req.params;
  try {
    let session = null;
    if (getConnectionStatus() === "CONNECTED") {
      session = await OcpiSession.findOne({ id: session_id }).lean();
    } else {
      session = memorySessions.get(session_id);
    }

    if (!session) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Session: ${session_id}`));
    }
    return res.json(ocpiResponse(session));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// PUT /sessions/:session_id/charging_preferences
router.put("/sessions/:session_id/charging_preferences", validateOcpiAuth, async (req, res) => {
  const { session_id } = req.params;
  const prefs = req.body;

  let session = memorySessions.get(session_id);
  if (getConnectionStatus() === "CONNECTED") {
    session = await OcpiSession.findOne({ id: session_id });
  }

  if (!session) {
    return res.status(200).json(ocpiResponse(null, 2003, `Unknown Session: ${session_id}`));
  }

  // OCPI 2.2.1 Section 7.4.2 returns ChargingPreferencesResponse: ACCEPTED, DEPARTURE_REQUIRED, NOT_POSSIBLE, PROFILE_TYPE_NOT_SUPPORTED
  return res.json(ocpiResponse("ACCEPTED", 1000, "Preferences accepted"));
});

/* -------------------------------------------------------------------------- */
/* CDRS MODULE (CPO SENDER)                                                   */
/* -------------------------------------------------------------------------- */

// GET /cdrs
router.get("/cdrs", validateOcpiAuth, async (req, res) => {
  try {
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { date_from, date_to } = req.query;

    let filter = {};
    if (date_from || date_to) {
      filter.last_updated = {};
      if (date_from) filter.last_updated.$gte = date_from;
      if (date_to) filter.last_updated.$lte = date_to;
    }

    let total = 0;
    let cdrs = [];

    if (getConnectionStatus() === "CONNECTED") {
      total = await OcpiCdr.countDocuments(filter);
      cdrs = await OcpiCdr.find(filter)
        .sort({ last_updated: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
    } else {
      let list = Array.from(memoryCdrs.values());
      if (date_from) list = list.filter((c) => c.last_updated >= date_from);
      if (date_to) list = list.filter((c) => c.last_updated <= date_to);
      total = list.length;
      cdrs = list.slice(offset, offset + limit);
    }

    res.set("X-Total-Count", String(total));
    res.set("X-Limit", String(limit));
    const linkHeader = buildLinkHeader(`${CONFIG.baseUrl}${req.baseUrl}/cdrs`, offset, limit, total);
    if (linkHeader) res.set("Link", linkHeader);

    return res.json(ocpiResponse(cdrs));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// GET /cdrs/:cdr_id
router.get("/cdrs/:cdr_id", validateOcpiAuth, async (req, res) => {
  const { cdr_id } = req.params;
  try {
    let cdr = null;
    if (getConnectionStatus() === "CONNECTED") {
      cdr = await OcpiCdr.findOne({ id: cdr_id }).lean();
    } else {
      cdr = memoryCdrs.get(cdr_id);
    }

    if (!cdr) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown CDR: ${cdr_id}`));
    }
    return res.json(ocpiResponse(cdr));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

/* -------------------------------------------------------------------------- */
/* TOKENS MODULE (CPO RECEIVER)                                               */
/* -------------------------------------------------------------------------- */

// GET /tokens/:country_code/:party_id/:token_uid
router.get("/tokens/:country_code/:party_id/:token_uid", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, token_uid } = req.params;
  try {
    let token = null;
    if (getConnectionStatus() === "CONNECTED") {
      token = await OcpiToken.findOne({
        country_code: country_code.toUpperCase(),
        party_id: party_id.toUpperCase(),
        uid: token_uid,
      }).lean();
    } else {
      token = memoryTokens.get(token_uid);
    }

    if (!token) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Token: ${token_uid}`));
    }
    return res.json(ocpiResponse(token));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// PUT /tokens/:country_code/:party_id/:token_uid
router.put("/tokens/:country_code/:party_id/:token_uid", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, token_uid } = req.params;
  const payload = req.body || {};

  payload.country_code = country_code.toUpperCase();
  payload.party_id = party_id.toUpperCase();
  payload.uid = token_uid;
  payload.last_updated = new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiToken.findOneAndUpdate(
      { country_code: payload.country_code, party_id: payload.party_id, uid: token_uid },
      payload,
      { upsert: true, new: true }
    );
  }
  memoryTokens.set(token_uid, payload);

  return res.json(ocpiResponse(payload, 1000, "Token stored in CPO cache"));
});

// PATCH /tokens/:country_code/:party_id/:token_uid
router.patch("/tokens/:country_code/:party_id/:token_uid", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, token_uid } = req.params;
  const updates = req.body || {};
  updates.last_updated = new Date().toISOString();

  let existing = memoryTokens.get(token_uid) || {};
  const updated = { ...existing, ...updates, country_code: country_code.toUpperCase(), party_id: party_id.toUpperCase(), uid: token_uid };

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiToken.findOneAndUpdate(
      { country_code: country_code.toUpperCase(), party_id: party_id.toUpperCase(), uid: token_uid },
      { $set: updates },
      { upsert: true, new: true }
    );
  }
  memoryTokens.set(token_uid, updated);

  return res.json(ocpiResponse(updated, 1000, "Token patched in CPO cache"));
});

/* -------------------------------------------------------------------------- */
/* COMMANDS MODULE (CPO RECEIVER)                                             */
/* -------------------------------------------------------------------------- */

const {
  handleStartSessionCommand,
  handleStopSessionCommand,
  findLocationById,
  findSessionById,
} = require("../services/sessionSimulationService");

// Standard CPO Command Receiver handler with full entity validation
async function handleCpoCommand(commandName, req, res) {
  const payload = req.body || {};
  const responseUrl = payload.response_url;
  const commandUid = crypto.randomUUID();

  // 1. Common required field: response_url
  if (!responseUrl || typeof responseUrl !== "string" || !responseUrl.trim()) {
    return res.json(
      ocpiResponse({
        result: "REJECTED",
        timeout: 0,
        message: [
          {
            language: "en",
            text: "Missing or invalid required field: response_url",
          },
        ],
      })
    );
  }

  // 2. Delegate START_SESSION and STOP_SESSION to Session Simulation Lifecycle Service
  if (commandName === "START_SESSION") {
    const outcome = await handleStartSessionCommand(payload);
    return res.json(ocpiResponse(outcome.response));
  }

  if (commandName === "STOP_SESSION") {
    const outcome = await handleStopSessionCommand(payload);
    return res.json(ocpiResponse(outcome.response));
  }

  // 3. Other command validations
  let targetLocation = null;
  let targetEvse = null;
  let targetConnector = null;

  if (commandName === "UNLOCK_CONNECTOR") {
    if (!payload.location_id || !payload.evse_uid || !payload.connector_id) {
      return res.json(
        ocpiResponse({
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: "location_id, evse_uid, and connector_id are required." }],
        })
      );
    }
    targetLocation = await findLocationById(payload.location_id);
    if (!targetLocation) {
      return res.json(
        ocpiResponse({
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: `Location '${payload.location_id}' not found.` }],
        })
      );
    }
    const evses = Array.isArray(targetLocation.evses) ? targetLocation.evses : [];
    targetEvse = evses.find((e) => e.uid === payload.evse_uid || e.evse_id === payload.evse_uid);
    if (!targetEvse) {
      return res.json(
        ocpiResponse({
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: `EVSE '${payload.evse_uid}' not found.` }],
        })
      );
    }
    const connectors = Array.isArray(targetEvse.connectors) ? targetEvse.connectors : [];
    targetConnector = connectors.find((c) => String(c.id) === String(payload.connector_id));
    if (!targetConnector) {
      return res.json(
        ocpiResponse({
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: `Connector '${payload.connector_id}' not found.` }],
        })
      );
    }
  } else if (commandName === "RESERVE_NOW") {
    if (!payload.location_id || !payload.reservation_id || !payload.expiry_date || !payload.token) {
      return res.json(
        ocpiResponse({
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: "location_id, reservation_id, expiry_date, and token are required." }],
        })
      );
    }
    targetLocation = await findLocationById(payload.location_id);
    if (!targetLocation) {
      return res.json(
        ocpiResponse({
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: `Location '${payload.location_id}' not found.` }],
        })
      );
    }
    if (payload.evse_uid) {
      const evses = Array.isArray(targetLocation.evses) ? targetLocation.evses : [];
      targetEvse = evses.find((e) => e.uid === payload.evse_uid || e.evse_id === payload.evse_uid);
      if (!targetEvse) {
        return res.json(
          ocpiResponse({
            result: "REJECTED",
            timeout: 0,
            message: [{ language: "en", text: `EVSE '${payload.evse_uid}' not found.` }],
          })
        );
      }
      if (["CHARGING", "INOPERATIVE", "OUTOFORDER", "REMOVED"].includes(targetEvse.status)) {
        return res.json(
          ocpiResponse({
            result: "REJECTED",
            timeout: 0,
            message: [{ language: "en", text: `EVSE '${payload.evse_uid}' cannot be reserved (status: ${targetEvse.status}).` }],
          })
        );
      }
    }
  }

  // Record command in memory
  memoryCommands.set(commandUid, {
    command: commandName,
    payload,
    status: "ACCEPTED",
    sessionId: createdSession ? createdSession.id : null,
    receivedAt: new Date().toISOString(),
  });

  const successMessage = createdSession
    ? `Command ${commandName} accepted. Session ${createdSession.id} started on EVSE ${targetEvse.uid}, connector ${targetConnector.id}.`
    : `Command ${commandName} accepted by CPO simulator.`;

  log(`CPO received Command ${commandName} -> ACCEPTED`, { commandUid, responseUrl, sessionId: createdSession?.id });

  // Optional: Async callback to response_url per OCPI 2.2.1 Section 6.1.1
  if (responseUrl && typeof responseUrl === "string" && responseUrl.startsWith("http")) {
    setTimeout(async () => {
      try {
        const callbackResult = {
          result: "ACCEPTED",
          message: [
            {
              language: "en",
              text: successMessage,
            },
          ],
        };
        const token = state.remoteToken || CONFIG.localToken;
        const headers = requestHeaders(token, crypto.randomUUID());
        await trackedRequest("POST", responseUrl, { headers, timeout: 10000 }, callbackResult);
        log(`[Command Callback] Dispatched async result to ${responseUrl}`, { commandUid, result: "ACCEPTED" });
      } catch (cbErr) {
        log(`[Command Callback] Could not deliver to ${responseUrl}: ${cbErr.message}`, { commandUid });
      }
    }, 1000);
  }

  // Synchronous CommandResponse
  return res.json(
    ocpiResponse({
      result: "ACCEPTED",
      timeout: 30,
      message: [
        {
          language: "en",
          text: successMessage,
        },
      ],
    })
  );
}

router.post("/commands/START_SESSION", validateOcpiAuth, (req, res) => handleCpoCommand("START_SESSION", req, res));
router.post("/commands/STOP_SESSION", validateOcpiAuth, (req, res) => handleCpoCommand("STOP_SESSION", req, res));
router.post("/commands/RESERVE_NOW", validateOcpiAuth, (req, res) => handleCpoCommand("RESERVE_NOW", req, res));
router.post("/commands/CANCEL_RESERVATION", validateOcpiAuth, (req, res) => handleCpoCommand("CANCEL_RESERVATION", req, res));
router.post("/commands/UNLOCK_CONNECTOR", validateOcpiAuth, (req, res) => handleCpoCommand("UNLOCK_CONNECTOR", req, res));

/* -------------------------------------------------------------------------- */
/* CHARGING PROFILES MODULE (CPO RECEIVER)                                    */
/* -------------------------------------------------------------------------- */

// GET /chargingprofiles/:session_id
router.get("/chargingprofiles/:session_id", validateOcpiAuth, (req, res) => {
  const { session_id } = req.params;
  const profile = memoryChargingProfiles.get(session_id);
  if (!profile) {
    return res.status(200).json(ocpiResponse(null, 2003, `No active Charging Profile for Session: ${session_id}`));
  }
  return res.json(ocpiResponse(profile));
});

// PUT /chargingprofiles/:session_id
router.put("/chargingprofiles/:session_id", validateOcpiAuth, (req, res) => {
  const { session_id } = req.params;
  const profile = req.body;
  memoryChargingProfiles.set(session_id, profile);
  return res.json(
    ocpiResponse({
      result: "ACCEPTED",
      timeout: 30,
    }, 1000, "Charging Profile set")
  );
});

// DELETE /chargingprofiles/:session_id
router.delete("/chargingprofiles/:session_id", validateOcpiAuth, (req, res) => {
  const { session_id } = req.params;
  memoryChargingProfiles.delete(session_id);
  return res.json(
    ocpiResponse({
      result: "ACCEPTED",
      timeout: 30,
    }, 1000, "Charging Profile cleared")
  );
});

module.exports = router;
