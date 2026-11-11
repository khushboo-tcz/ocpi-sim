const express = require("express");
const router = express.Router();
const { getConnectionStatus } = require("../db/connection");
const { OcpiLocation } = require("../models/OcpiLocation");
const OcpiTariff = require("../models/OcpiTariff");
const OcpiSession = require("../models/OcpiSession");
const OcpiCdr = require("../models/OcpiCdr");
const OcpiToken = require("../models/OcpiToken");
const {
  CONFIG,
  memoryLocations,
  memoryTariffs,
  memorySessions,
  memoryCdrs,
  memoryTokens,
  toCleanOcpiLocation,
  toCleanOcpiTariff,
  ocpiResponse,
  buildLinkHeader,
  validateOcpiAuth,
  log,
} = require("../services/simulatorState");

/* -------------------------------------------------------------------------- */
/* LOCATIONS MODULE (eMSP RECEIVER)                                           */
/* -------------------------------------------------------------------------- */

// GET /locations/:country_code/:party_id/:location_id
router.get("/locations/:country_code/:party_id/:location_id", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, location_id } = req.params;
  try {
    let loc = null;
    if (getConnectionStatus() === "CONNECTED") {
      loc = await OcpiLocation.findOne({
        country_code: country_code.toUpperCase(),
        party_id: party_id.toUpperCase(),
        id: location_id,
      }).lean();
    } else {
      loc = memoryLocations.get(location_id);
    }

    if (!loc) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Location: ${location_id}`));
    }
    return res.json(ocpiResponse(toCleanOcpiLocation(loc)));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// PUT /locations/:country_code/:party_id/:location_id (CPO pushes location to eMSP)
router.put("/locations/:country_code/:party_id/:location_id", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, location_id } = req.params;
  const payload = req.body || {};

  payload.id = location_id;
  payload.country_code = country_code.toUpperCase();
  payload.party_id = party_id.toUpperCase();
  payload.last_updated = payload.last_updated || new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiLocation.findOneAndUpdate(
      { country_code: payload.country_code, party_id: payload.party_id, id: location_id },
      payload,
      { upsert: true, new: true }
    );
  }
  memoryLocations.set(location_id, payload);

  log(`eMSP received Location PUT: ${location_id}`, { country_code, party_id });
  return res.json(ocpiResponse(null, 1000, "Location saved by eMSP"));
});

// PATCH /locations/:country_code/:party_id/:location_id
router.patch("/locations/:country_code/:party_id/:location_id", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, location_id } = req.params;
  const updates = req.body || {};
  updates.last_updated = new Date().toISOString();

  let existing = memoryLocations.get(location_id) || {};
  const updated = { ...existing, ...updates, id: location_id, country_code: country_code.toUpperCase(), party_id: party_id.toUpperCase() };

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiLocation.findOneAndUpdate(
      { country_code: country_code.toUpperCase(), party_id: party_id.toUpperCase(), id: location_id },
      { $set: updates },
      { upsert: true, new: true }
    );
  }
  memoryLocations.set(location_id, updated);

  log(`eMSP received Location PATCH: ${location_id}`);
  return res.json(ocpiResponse(null, 1000, "Location patched by eMSP"));
});

// EVSE receiver
router.put("/locations/:country_code/:party_id/:location_id/:evse_uid", validateOcpiAuth, async (req, res) => {
  const { location_id, evse_uid } = req.params;
  const evseData = req.body || {};
  evseData.uid = evse_uid;

  let loc = memoryLocations.get(location_id) || { id: location_id, evses: [] };
  if (!Array.isArray(loc.evses)) loc.evses = [];
  const idx = loc.evses.findIndex((e) => e.uid === evse_uid);
  if (idx >= 0) loc.evses[idx] = evseData;
  else loc.evses.push(evseData);

  memoryLocations.set(location_id, loc);
  return res.json(ocpiResponse(null, 1000, "EVSE saved by eMSP"));
});

/* -------------------------------------------------------------------------- */
/* TARIFFS MODULE (eMSP RECEIVER)                                             */
/* -------------------------------------------------------------------------- */

// GET /tariffs/:country_code/:party_id/:tariff_id
router.get("/tariffs/:country_code/:party_id/:tariff_id", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, tariff_id } = req.params;
  try {
    let tariff = null;
    if (getConnectionStatus() === "CONNECTED") {
      tariff = await OcpiTariff.findOne({
        country_code: country_code.toUpperCase(),
        party_id: party_id.toUpperCase(),
        id: tariff_id,
      }).lean();
    } else {
      tariff = memoryTariffs.get(tariff_id);
    }

    if (!tariff) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Tariff: ${tariff_id}`));
    }
    return res.json(ocpiResponse(toCleanOcpiTariff(tariff)));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// PUT /tariffs/:country_code/:party_id/:tariff_id (CPO pushes tariff to eMSP)
router.put("/tariffs/:country_code/:party_id/:tariff_id", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, tariff_id } = req.params;
  const payload = req.body || {};

  payload.id = tariff_id;
  payload.country_code = country_code.toUpperCase();
  payload.party_id = party_id.toUpperCase();
  payload.last_updated = payload.last_updated || new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiTariff.findOneAndUpdate(
      { country_code: payload.country_code, party_id: payload.party_id, id: tariff_id },
      payload,
      { upsert: true, new: true }
    );
  }
  memoryTariffs.set(tariff_id, payload);

  log(`eMSP received Tariff PUT: ${tariff_id}`);
  return res.json(ocpiResponse(null, 1000, "Tariff saved by eMSP"));
});

// DELETE /tariffs/:country_code/:party_id/:tariff_id
router.delete("/tariffs/:country_code/:party_id/:tariff_id", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, tariff_id } = req.params;
  if (getConnectionStatus() === "CONNECTED") {
    await OcpiTariff.deleteOne({
      country_code: country_code.toUpperCase(),
      party_id: party_id.toUpperCase(),
      id: tariff_id,
    });
  }
  memoryTariffs.delete(tariff_id);

  return res.json(ocpiResponse(null, 1000, `Tariff ${tariff_id} deleted`));
});

/* -------------------------------------------------------------------------- */
/* SESSIONS MODULE (eMSP RECEIVER)                                            */
/* -------------------------------------------------------------------------- */

// GET /sessions/:country_code/:party_id/:session_id
router.get("/sessions/:country_code/:party_id/:session_id", validateOcpiAuth, async (req, res) => {
  const { session_id } = req.params;
  try {
    let session = memorySessions.get(session_id);
    if (!session && getConnectionStatus() === "CONNECTED") {
      session = await OcpiSession.findOne({ id: session_id }).lean();
    }

    if (!session) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Session: ${session_id}`));
    }
    return res.json(ocpiResponse(session));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// PUT /sessions/:country_code/:party_id/:session_id (CPO pushes session to eMSP)
router.put("/sessions/:country_code/:party_id/:session_id", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, session_id } = req.params;
  const payload = req.body || {};

  payload.id = session_id;
  payload.country_code = country_code.toUpperCase();
  payload.party_id = party_id.toUpperCase();
  payload.last_updated = payload.last_updated || new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiSession.findOneAndUpdate(
      { country_code: payload.country_code, party_id: payload.party_id, id: session_id },
      payload,
      { upsert: true, new: true }
    );
  }
  memorySessions.set(session_id, payload);

  log(`eMSP received Session PUT: ${session_id}`, { status: payload.status, kwh: payload.kwh });
  return res.json(ocpiResponse(null, 1000, "Session updated in eMSP"));
});

// PATCH /sessions/:country_code/:party_id/:session_id
router.patch("/sessions/:country_code/:party_id/:session_id", validateOcpiAuth, async (req, res) => {
  const { country_code, party_id, session_id } = req.params;
  const updates = req.body || {};
  updates.last_updated = new Date().toISOString();

  let existing = memorySessions.get(session_id) || {};
  const updated = { ...existing, ...updates, id: session_id, country_code: country_code.toUpperCase(), party_id: party_id.toUpperCase() };

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiSession.findOneAndUpdate(
      { country_code: country_code.toUpperCase(), party_id: party_id.toUpperCase(), id: session_id },
      { $set: updates },
      { upsert: true, new: true }
    );
  }
  memorySessions.set(session_id, updated);

  log(`eMSP received Session PATCH: ${session_id}`);
  return res.json(ocpiResponse(null, 1000, "Session patched in eMSP"));
});

/* -------------------------------------------------------------------------- */
/* CDRS MODULE (eMSP RECEIVER)                                                */
/* -------------------------------------------------------------------------- */

// GET /cdrs/:cdr_id
router.get("/cdrs/:cdr_id", validateOcpiAuth, async (req, res) => {
  const { cdr_id } = req.params;
  try {
    let cdr = memoryCdrs.get(cdr_id);
    if (!cdr && getConnectionStatus() === "CONNECTED") {
      cdr = await OcpiCdr.findOne({ id: cdr_id }).lean();
    }

    if (!cdr) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown CDR: ${cdr_id}`));
    }
    return res.json(ocpiResponse(cdr));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// POST /cdrs (CPO posts finalized CDR to eMSP per OCPI 2.2.1 Section 8.3)
router.post("/cdrs", validateOcpiAuth, async (req, res) => {
  const payload = req.body || {};
  if (!payload.id) {
    return res.status(200).json(ocpiResponse(null, 2001, "Missing CDR id"));
  }

  payload.last_updated = payload.last_updated || new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED") {
    await OcpiCdr.findOneAndUpdate(
      { country_code: payload.country_code, party_id: payload.party_id, id: payload.id },
      payload,
      { upsert: true, new: true }
    );
  }
  memoryCdrs.set(payload.id, payload);

  log(`eMSP received new CDR: ${payload.id}`, {
    total_energy: payload.total_energy,
    total_cost: payload.total_cost,
  });

  // Per OCPI 2.2.1 Section 8.3, return HTTP 201 Created with Location header or OCPI 1000
  res.set("Location", `${CONFIG.baseUrl}${req.baseUrl}/cdrs/${payload.id}`);
  return res.status(201).json(ocpiResponse(null, 1000, "CDR created"));
});

/* -------------------------------------------------------------------------- */
/* TOKENS MODULE (eMSP SENDER)                                                */
/* -------------------------------------------------------------------------- */

// GET /tokens (CPO requests token list with pagination & date filters)
router.get("/tokens", validateOcpiAuth, async (req, res) => {
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
    let tokens = [];

    if (getConnectionStatus() === "CONNECTED") {
      total = await OcpiToken.countDocuments(filter);
      tokens = await OcpiToken.find(filter)
        .sort({ last_updated: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
    } else {
      let list = Array.from(memoryTokens.values());
      if (date_from) list = list.filter((t) => t.last_updated >= date_from);
      if (date_to) list = list.filter((t) => t.last_updated <= date_to);
      total = list.length;
      tokens = list.slice(offset, offset + limit);
    }

    res.set("X-Total-Count", String(total));
    res.set("X-Limit", String(limit));
    const linkHeader = buildLinkHeader(`${CONFIG.baseUrl}${req.baseUrl}/tokens`, offset, limit, total);
    if (linkHeader) res.set("Link", linkHeader);

    return res.json(ocpiResponse(tokens));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// POST /tokens/:token_uid/authorize (Real-time authorization check per OCPI 2.2.1 Section 10.3)
router.post("/tokens/:token_uid/authorize", validateOcpiAuth, async (req, res) => {
  const { token_uid } = req.params;
  const locationRef = req.body || {};

  let token = memoryTokens.get(token_uid);
  if (!token && getConnectionStatus() === "CONNECTED") {
    token = await OcpiToken.findOne({ uid: token_uid }).lean();
  }

  log(`eMSP real-time Authorization check for Token ${token_uid}`, { locationRef, found: Boolean(token) });

  if (token && token.valid) {
    // Standard OCPI 2.2.1 AuthorizationInfo
    return res.json(
      ocpiResponse({
        allowed: "ALLOWED",
        token: {
          country_code: token.country_code,
          party_id: token.party_id,
          uid: token.uid,
          type: token.type,
          contract_id: token.contract_id,
        },
        location: locationRef.location_id ? locationRef : null,
        info: {
          language: "en",
          text: "Authorized by eMSP Simulator",
        },
      })
    );
  }

  return res.json(
    ocpiResponse({
      allowed: "NOT_ALLOWED",
      token: {
        country_code: "IN",
        party_id: "CZS",
        uid: token_uid,
        type: "RFID",
        contract_id: "UNKNOWN",
      },
      info: {
        language: "en",
        text: "Token not found or invalid",
      },
    })
  );
});

/* -------------------------------------------------------------------------- */
/* COMMANDS CALLBACK RECEIVER (eMSP SENDER)                                   */
/* -------------------------------------------------------------------------- */

// POST /commands/:command/:uid (CPO sends async command result to eMSP)
router.post("/commands/:command/:uid", validateOcpiAuth, (req, res) => {
  const { command, uid } = req.params;
  const result = req.body;

  log(`eMSP received async command callback for ${command} (UID: ${uid})`, { result });
  return res.json(ocpiResponse(null, 1000, "Command callback received"));
});

/* -------------------------------------------------------------------------- */
/* CHARGING PROFILES CALLBACK (eMSP SENDER)                                   */
/* -------------------------------------------------------------------------- */

// POST /chargingprofiles/callback/:session_id
router.post("/chargingprofiles/callback/:session_id", validateOcpiAuth, (req, res) => {
  const { session_id } = req.params;
  const result = req.body;

  log(`eMSP received Charging Profile callback for session: ${session_id}`, { result });
  return res.json(ocpiResponse(null, 1000, "Charging profile callback acknowledged"));
});

module.exports = router;
