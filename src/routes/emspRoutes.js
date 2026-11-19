const express = require("express");
const router = express.Router();
const { getConnectionStatus } = require("../db/connection");
const OcpiEmspLocation = require("../models/OcpiEmspLocation");
const OcpiEmspTariff = require("../models/OcpiEmspTariff");
const OcpiEmspSession = require("../models/OcpiEmspSession");
const OcpiEmspCdr = require("../models/OcpiEmspCdr");
const OcpiToken = require("../models/OcpiToken");
const { validateEmspAuth } = require("../services/emspService");
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
  log,
} = require("../services/simulatorState");

/* -------------------------------------------------------------------------- */
/* LOCATIONS MODULE (eMSP RECEIVER)                                           */
/* -------------------------------------------------------------------------- */

// GET /locations/:country_code/:party_id/:location_id
router.get("/locations/:country_code/:party_id/:location_id", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, location_id } = req.params;
  try {
    let loc = null;
    if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
      loc = await OcpiEmspLocation.findOne({
        connectionProfileId: req.connectionProfileId,
        country_code: country_code.toUpperCase(),
        party_id: party_id.toUpperCase(),
        id: location_id,
      }).lean();
    }
    if (!loc) {
      loc = memoryLocations.get(location_id);
    }

    if (!loc) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Location: ${location_id}`));
    }
    return res.json(ocpiResponse(loc.rawPayload || toCleanOcpiLocation(loc)));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// PUT /locations/:country_code/:party_id/:location_id (CPO pushes location to eMSP)
router.put("/locations/:country_code/:party_id/:location_id", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, location_id } = req.params;
  const payload = req.body || {};

  payload.id = location_id;
  payload.country_code = country_code.toUpperCase();
  payload.party_id = party_id.toUpperCase();
  payload.last_updated = payload.last_updated || new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
    await OcpiEmspLocation.findOneAndUpdate(
      {
        connectionProfileId: req.connectionProfileId,
        country_code: payload.country_code,
        party_id: payload.party_id,
        id: location_id,
      },
      {
        $set: {
          connectionProfileId: req.connectionProfileId,
          country_code: payload.country_code,
          party_id: payload.party_id,
          id: location_id,
          name: payload.name || null,
          address: payload.address || "",
          city: payload.city || "",
          postal_code: payload.postal_code || null,
          state: payload.state || null,
          country: payload.country || payload.country_code,
          coordinates: payload.coordinates || { latitude: "0", longitude: "0" },
          related_locations: payload.related_locations || [],
          parking_type: payload.parking_type || null,
          evses: Array.isArray(payload.evses) ? payload.evses : [],
          directions: payload.directions || [],
          operator: payload.operator || null,
          suboperator: payload.suboperator || null,
          owner: payload.owner || null,
          facilities: payload.facilities || [],
          time_zone: payload.time_zone || "UTC",
          opening_times: payload.opening_times || null,
          charging_when_closed: payload.charging_when_closed ?? true,
          images: payload.images || [],
          energy_mix: payload.energy_mix || null,
          rawPayload: payload,
          last_updated: payload.last_updated,
        },
      },
      { upsert: true, new: true }
    );
  }
  memoryLocations.set(location_id, payload);

  log(`eMSP received Location PUT: ${location_id}`, { country_code, party_id });
  return res.json(ocpiResponse(null, 1000, "Location saved by eMSP"));
});

// PATCH /locations/:country_code/:party_id/:location_id
router.patch("/locations/:country_code/:party_id/:location_id", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, location_id } = req.params;
  const updates = req.body || {};
  updates.last_updated = new Date().toISOString();

  let existing = memoryLocations.get(location_id) || {};
  const updated = {
    ...existing,
    ...updates,
    id: location_id,
    country_code: country_code.toUpperCase(),
    party_id: party_id.toUpperCase(),
  };

  if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
    await OcpiEmspLocation.findOneAndUpdate(
      {
        connectionProfileId: req.connectionProfileId,
        country_code: country_code.toUpperCase(),
        party_id: party_id.toUpperCase(),
        id: location_id,
      },
      { $set: { ...updates, last_updated: updates.last_updated } },
      { upsert: true, new: true }
    );
  }
  memoryLocations.set(location_id, updated);

  log(`eMSP received Location PATCH: ${location_id}`);
  return res.json(ocpiResponse(null, 1000, "Location patched by eMSP"));
});

// PUT /locations/:country_code/:party_id/:location_id/:evse_uid
router.put("/locations/:country_code/:party_id/:location_id/:evse_uid", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, location_id, evse_uid } = req.params;
  const evseData = req.body || {};
  evseData.uid = evse_uid;

  if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
    const loc = await OcpiEmspLocation.findOne({
      connectionProfileId: req.connectionProfileId,
      country_code: country_code.toUpperCase(),
      party_id: party_id.toUpperCase(),
      id: location_id,
    });
    if (loc) {
      if (!Array.isArray(loc.evses)) loc.evses = [];
      const idx = loc.evses.findIndex((e) => e.uid === evse_uid);
      if (idx >= 0) loc.evses[idx] = evseData;
      else loc.evses.push(evseData);
      loc.last_updated = new Date().toISOString();
      await loc.save();
    }
  }

  let memLoc = memoryLocations.get(location_id) || { id: location_id, evses: [] };
  if (!Array.isArray(memLoc.evses)) memLoc.evses = [];
  const idx = memLoc.evses.findIndex((e) => e.uid === evse_uid);
  if (idx >= 0) memLoc.evses[idx] = evseData;
  else memLoc.evses.push(evseData);
  memoryLocations.set(location_id, memLoc);

  return res.json(ocpiResponse(null, 1000, "EVSE saved by eMSP"));
});

/* -------------------------------------------------------------------------- */
/* TARIFFS MODULE (eMSP RECEIVER)                                             */
/* -------------------------------------------------------------------------- */

// GET /tariffs/:country_code/:party_id/:tariff_id
router.get("/tariffs/:country_code/:party_id/:tariff_id", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, tariff_id } = req.params;
  try {
    let tariff = null;
    if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
      tariff = await OcpiEmspTariff.findOne({
        connectionProfileId: req.connectionProfileId,
        country_code: country_code.toUpperCase(),
        party_id: party_id.toUpperCase(),
        id: tariff_id,
      }).lean();
    }
    if (!tariff) {
      tariff = memoryTariffs.get(tariff_id);
    }

    if (!tariff) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Tariff: ${tariff_id}`));
    }
    return res.json(ocpiResponse(tariff.rawPayload || toCleanOcpiTariff(tariff)));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// PUT /tariffs/:country_code/:party_id/:tariff_id (CPO pushes tariff to eMSP)
router.put("/tariffs/:country_code/:party_id/:tariff_id", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, tariff_id } = req.params;
  const payload = req.body || {};

  payload.id = tariff_id;
  payload.country_code = country_code.toUpperCase();
  payload.party_id = party_id.toUpperCase();
  payload.last_updated = payload.last_updated || new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
    await OcpiEmspTariff.findOneAndUpdate(
      {
        connectionProfileId: req.connectionProfileId,
        country_code: payload.country_code,
        party_id: payload.party_id,
        id: tariff_id,
      },
      {
        $set: {
          connectionProfileId: req.connectionProfileId,
          country_code: payload.country_code,
          party_id: payload.party_id,
          id: tariff_id,
          currency: payload.currency || "EUR",
          type: payload.type || "REGULAR",
          tariff_alt_text: payload.tariff_alt_text || [],
          tariff_alt_url: payload.tariff_alt_url || null,
          min_price: payload.min_price || null,
          max_price: payload.max_price || null,
          start_date_time: payload.start_date_time || null,
          end_date_time: payload.end_date_time || null,
          elements: payload.elements || [],
          price_summary: payload.price_summary || "",
          rawPayload: payload,
          last_updated: payload.last_updated,
        },
      },
      { upsert: true, new: true }
    );
  }
  memoryTariffs.set(tariff_id, payload);

  log(`eMSP received Tariff PUT: ${tariff_id}`);
  return res.json(ocpiResponse(null, 1000, "Tariff saved by eMSP"));
});

// DELETE /tariffs/:country_code/:party_id/:tariff_id
router.delete("/tariffs/:country_code/:party_id/:tariff_id", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, tariff_id } = req.params;
  if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
    await OcpiEmspTariff.deleteOne({
      connectionProfileId: req.connectionProfileId,
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
router.get("/sessions/:country_code/:party_id/:session_id", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, session_id } = req.params;
  try {
    let session = null;
    if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
      session = await OcpiEmspSession.findOne({
        connectionProfileId: req.connectionProfileId,
        country_code: country_code.toUpperCase(),
        party_id: party_id.toUpperCase(),
        id: session_id,
      }).lean();
    }
    if (!session) {
      session = memorySessions.get(session_id);
    }

    if (!session) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown Session: ${session_id}`));
    }
    return res.json(ocpiResponse(session.rawPayload || session));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// PUT /sessions/:country_code/:party_id/:session_id (CPO pushes session to eMSP)
router.put("/sessions/:country_code/:party_id/:session_id", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, session_id } = req.params;
  const payload = req.body || {};

  payload.id = session_id;
  payload.country_code = country_code.toUpperCase();
  payload.party_id = party_id.toUpperCase();
  payload.last_updated = payload.last_updated || new Date().toISOString();

  if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
    await OcpiEmspSession.findOneAndUpdate(
      {
        connectionProfileId: req.connectionProfileId,
        country_code: payload.country_code,
        party_id: payload.party_id,
        id: session_id,
      },
      {
        $set: {
          connectionProfileId: req.connectionProfileId,
          country_code: payload.country_code,
          party_id: payload.party_id,
          id: session_id,
          start_date_time: payload.start_date_time || new Date().toISOString(),
          end_date_time: payload.end_date_time || null,
          kwh: payload.kwh ?? 0,
          cdr_token: payload.cdr_token || null,
          auth_method: payload.auth_method || "COMMAND",
          authorization_reference: payload.authorization_reference || null,
          location_id: payload.location_id || null,
          evse_uid: payload.evse_uid || null,
          connector_id: payload.connector_id || null,
          meter_id: payload.meter_id || null,
          currency: payload.currency || "EUR",
          charging_periods: payload.charging_periods || [],
          total_cost: payload.total_cost || null,
          status: payload.status || "ACTIVE",
          rawPayload: payload,
          last_updated: payload.last_updated,
        },
      },
      { upsert: true, new: true }
    );
  }
  memorySessions.set(session_id, payload);

  log(`eMSP received Session PUT: ${session_id}`, { status: payload.status, kwh: payload.kwh });
  return res.json(ocpiResponse(null, 1000, "Session updated in eMSP"));
});

// PATCH /sessions/:country_code/:party_id/:session_id
router.patch("/sessions/:country_code/:party_id/:session_id", validateEmspAuth, async (req, res) => {
  const { country_code, party_id, session_id } = req.params;
  const updates = req.body || {};
  updates.last_updated = new Date().toISOString();

  let existing = memorySessions.get(session_id) || {};
  const updated = {
    ...existing,
    ...updates,
    id: session_id,
    country_code: country_code.toUpperCase(),
    party_id: party_id.toUpperCase(),
  };

  if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
    await OcpiEmspSession.findOneAndUpdate(
      {
        connectionProfileId: req.connectionProfileId,
        country_code: country_code.toUpperCase(),
        party_id: party_id.toUpperCase(),
        id: session_id,
      },
      { $set: { ...updates, last_updated: updates.last_updated } },
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
router.get("/cdrs/:cdr_id", validateEmspAuth, async (req, res) => {
  const { cdr_id } = req.params;
  try {
    let cdr = null;
    if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
      cdr = await OcpiEmspCdr.findOne({
        connectionProfileId: req.connectionProfileId,
        id: cdr_id,
      }).lean();
    }
    if (!cdr) {
      cdr = memoryCdrs.get(cdr_id);
    }

    if (!cdr) {
      return res.status(200).json(ocpiResponse(null, 2003, `Unknown CDR: ${cdr_id}`));
    }
    return res.json(ocpiResponse(cdr.rawPayload || cdr));
  } catch (err) {
    return res.status(500).json(ocpiResponse(null, 3000, err.message));
  }
});

// POST /cdrs (CPO posts finalized CDR to eMSP per OCPI 2.2.1 Section 8.3)
router.post("/cdrs", validateEmspAuth, async (req, res) => {
  const payload = req.body || {};
  if (!payload.id) {
    return res.status(200).json(ocpiResponse(null, 2001, "Missing CDR id"));
  }

  payload.last_updated = payload.last_updated || new Date().toISOString();
  const partnerRoles = req.connectionProfile?.partnerRoles || [];
  const defaultCountry = partnerRoles[0]?.country_code || "IN";
  const defaultParty = partnerRoles[0]?.party_id || "CZS";

  const country_code = (payload.country_code || defaultCountry).toUpperCase().trim();
  const party_id = (payload.party_id || defaultParty).toUpperCase().trim();

  if (getConnectionStatus() === "CONNECTED" && req.connectionProfileId) {
    await OcpiEmspCdr.findOneAndUpdate(
      {
        connectionProfileId: req.connectionProfileId,
        country_code,
        party_id,
        id: payload.id,
      },
      {
        $set: {
          connectionProfileId: req.connectionProfileId,
          country_code,
          party_id,
          id: payload.id,
          start_date_time: payload.start_date_time || new Date().toISOString(),
          stop_date_time: payload.stop_date_time || payload.end_date_time || null,
          end_date_time: payload.end_date_time || payload.stop_date_time || null,
          session_id: payload.session_id || null,
          cdr_token: payload.cdr_token || null,
          auth_method: payload.auth_method || "COMMAND",
          authorization_reference: payload.authorization_reference || null,
          cdr_location: payload.cdr_location || {},
          meter_id: payload.meter_id || null,
          currency: payload.currency || "EUR",
          tariffs: payload.tariffs || [],
          charging_periods: payload.charging_periods || [],
          total_cost: payload.total_cost || { excl_vat: 0, incl_vat: 0 },
          total_fixed_cost: payload.total_fixed_cost || null,
          total_energy: payload.total_energy || 0,
          total_energy_cost: payload.total_energy_cost || null,
          total_time: payload.total_time || 0,
          total_time_cost: payload.total_time_cost || null,
          total_parking_time: payload.total_parking_time || null,
          total_parking_cost: payload.total_parking_cost || null,
          remark: payload.remark || null,
          invoice_reference_id: payload.invoice_reference_id || null,
          credit: payload.credit || false,
          credit_reference_id: payload.credit_reference_id || null,
          rawPayload: payload,
          last_updated: payload.last_updated,
        },
      },
      { upsert: true, new: true }
    );
  }
  memoryCdrs.set(payload.id, payload);

  log(`eMSP received new CDR: ${payload.id}`, {
    total_energy: payload.total_energy,
    total_cost: payload.total_cost,
  });

  // Per OCPI 2.2.1 Section 8.3, return HTTP 201 Created with Location header
  res.set("Location", `${CONFIG.baseUrl}${req.baseUrl}/cdrs/${payload.id}`);
  return res.status(201).json(ocpiResponse(null, 1000, "CDR created"));
});

/* -------------------------------------------------------------------------- */
/* TOKENS MODULE (eMSP SENDER)                                                */
/* -------------------------------------------------------------------------- */

// GET /tokens (CPO requests token list with pagination & date filters)
router.get("/tokens", validateEmspAuth, async (req, res) => {
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
router.post("/tokens/:token_uid/authorize", validateEmspAuth, async (req, res) => {
  const { token_uid } = req.params;
  const locationRef = req.body || {};

  let token = memoryTokens.get(token_uid);
  if (!token && getConnectionStatus() === "CONNECTED") {
    token = await OcpiToken.findOne({ uid: token_uid }).lean();
  }

  log(`eMSP real-time Authorization check for Token ${token_uid}`, { locationRef, found: Boolean(token) });

  if (token && token.valid) {
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
router.post("/commands/:command/:uid", validateEmspAuth, (req, res) => {
  const { command, uid } = req.params;
  const result = req.body;

  log(`eMSP received async command callback for ${command} (UID: ${uid})`, { result });
  return res.json(ocpiResponse(null, 1000, "Command callback received"));
});

/* -------------------------------------------------------------------------- */
/* CHARGING PROFILES CALLBACK (eMSP SENDER)                                   */
/* -------------------------------------------------------------------------- */

// POST /chargingprofiles/callback/:session_id
router.post("/chargingprofiles/callback/:session_id", validateEmspAuth, (req, res) => {
  const { session_id } = req.params;
  const result = req.body;

  log(`eMSP received Charging Profile callback for session: ${session_id}`, { result });
  return res.json(ocpiResponse(null, 1000, "Charging profile callback acknowledged"));
});

module.exports = router;
