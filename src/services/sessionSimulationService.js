const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { getConnectionStatus } = require("../db/connection");
const { OcpiLocation } = require("../models/OcpiLocation");
const OcpiSession = require("../models/OcpiSession");
const OcpiCdr = require("../models/OcpiCdr");
const {
  CONFIG,
  state,
  simulator,
  memoryLocations,
  memorySessions,
  memoryCdrs,
  memoryCommands,
  requestHeaders,
  trackedRequest,
  omitNulls,
  log,
} = require("./simulatorState");

/* -------------------------------------------------------------------------- */
/* SIMULATION CONFIGURATION                                                   */
/* -------------------------------------------------------------------------- */

const simulationConfig = {
  sessionDurationSeconds: 1800, // 30 minutes
  updateIntervalSeconds: 10,    // 10s per PATCH
  chargingPowerKw: 60.0,        // 60 kW
  initialMeterKwh: 0.0,
  energyUnit: "kWh",
  currency: "INR",
  energyPrice: 12.0,            // 12 INR / kWh
  taxPercentage: 18.0,          // 18% GST
  autoStop: false,              // If true, auto-stop when sessionDuration is reached
  emspSessionsUrl: null,        // Optional manual override
  emspCdrsUrl: null,            // Optional manual override
  emspLocationsUrl: null,       // Optional manual override
};

function getSimulationConfig() {
  return { ...simulationConfig };
}

function updateSimulationConfig(updates = {}) {
  if (typeof updates.sessionDurationSeconds === "number" && updates.sessionDurationSeconds > 0) {
    simulationConfig.sessionDurationSeconds = Math.round(updates.sessionDurationSeconds);
  }
  if (typeof updates.updateIntervalSeconds === "number" && updates.updateIntervalSeconds >= 2) {
    simulationConfig.updateIntervalSeconds = Math.round(updates.updateIntervalSeconds);
  }
  if (typeof updates.chargingPowerKw === "number" && updates.chargingPowerKw > 0) {
    simulationConfig.chargingPowerKw = Number(updates.chargingPowerKw);
  }
  if (typeof updates.initialMeterKwh === "number" && updates.initialMeterKwh >= 0) {
    simulationConfig.initialMeterKwh = Number(updates.initialMeterKwh);
  }
  if (typeof updates.energyPrice === "number" && updates.energyPrice >= 0) {
    simulationConfig.energyPrice = Number(updates.energyPrice);
  }
  if (typeof updates.taxPercentage === "number" && updates.taxPercentage >= 0) {
    simulationConfig.taxPercentage = Number(updates.taxPercentage);
  }
  if (typeof updates.currency === "string" && updates.currency.trim()) {
    simulationConfig.currency = updates.currency.trim().toUpperCase();
  }
  if (typeof updates.autoStop === "boolean") {
    simulationConfig.autoStop = updates.autoStop;
  }
  if (updates.emspSessionsUrl !== undefined) {
    simulationConfig.emspSessionsUrl = updates.emspSessionsUrl ? String(updates.emspSessionsUrl).trim() : null;
  }
  if (updates.emspCdrsUrl !== undefined) {
    simulationConfig.emspCdrsUrl = updates.emspCdrsUrl ? String(updates.emspCdrsUrl).trim() : null;
  }
  if (updates.emspLocationsUrl !== undefined) {
    simulationConfig.emspLocationsUrl = updates.emspLocationsUrl ? String(updates.emspLocationsUrl).trim() : null;
  }
  return getSimulationConfig();
}

/* -------------------------------------------------------------------------- */
/* ACTIVE SIMULATION STATE & OPERATION LOGS                                   */
/* -------------------------------------------------------------------------- */

const activeSimulation = {
  status: "IDLE", // "IDLE" | "ACTIVE" | "COMPLETED" | "ERROR"
  sessionId: null,
  cdrId: null,
  locationId: null,
  locationName: null,
  evseUid: null,
  connectorId: null,
  startDateTime: null,
  endDateTime: null,
  elapsedSeconds: 0,
  consumedKwh: 0,
  currentMeterKwh: 0,
  exclVatCost: 0,
  taxAmount: 0,
  inclVatCost: 0,
  chargingPowerKw: 60.0,
  token: null,
  responseUrl: null,
  authorizationReference: null,
  lastError: null,
  timerId: null,
  sessionObj: null,
  cdrObj: null,
  operations: [], // Lifecycle history of requests/responses
};

function logSimulationOperation({
  type,
  method,
  url,
  requestBody,
  httpStatus = 200,
  responseBody = null,
  success = true,
  message = "",
}) {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    method,
    url: url || "INTERNAL",
    requestBody: requestBody ? omitNulls(requestBody) : null,
    httpStatus,
    responseBody: responseBody ? omitNulls(responseBody) : null,
    success,
    message,
  };

  activeSimulation.operations.unshift(entry);
  if (activeSimulation.operations.length > 200) {
    activeSimulation.operations.pop();
  }
  return entry;
}

function getActiveSimulationState() {
  const isRunning = Boolean(activeSimulation.timerId && activeSimulation.status === "ACTIVE");
  let currentElapsed = activeSimulation.elapsedSeconds;
  if (isRunning && activeSimulation.startDateTime) {
    currentElapsed = Math.round((Date.now() - new Date(activeSimulation.startDateTime).getTime()) / 1000);
  }

  return {
    status: activeSimulation.status,
    sessionId: activeSimulation.sessionId,
    cdrId: activeSimulation.cdrId,
    locationId: activeSimulation.locationId,
    locationName: activeSimulation.locationName,
    evseUid: activeSimulation.evseUid,
    connectorId: activeSimulation.connectorId,
    startDateTime: activeSimulation.startDateTime,
    endDateTime: activeSimulation.endDateTime,
    elapsedSeconds: currentElapsed,
    consumedKwh: activeSimulation.consumedKwh,
    currentMeterKwh: activeSimulation.currentMeterKwh,
    exclVatCost: activeSimulation.exclVatCost,
    taxAmount: activeSimulation.taxAmount,
    inclVatCost: activeSimulation.inclVatCost,
    chargingPowerKw: activeSimulation.chargingPowerKw,
    currency: simulationConfig.currency,
    lastError: activeSimulation.lastError,
    config: getSimulationConfig(),
    operationsCount: activeSimulation.operations.length,
    operations: activeSimulation.operations.slice(0, 50),
  };
}

/* -------------------------------------------------------------------------- */
/* DYNAMIC ENDPOINT DISCOVERY                                                 */
/* -------------------------------------------------------------------------- */

function getDiscoveredEmspSessionsUrl() {
  if (simulationConfig.emspSessionsUrl) return simulationConfig.emspSessionsUrl.replace(/\/+$/, "");
  const ep = (state.partnerEndpoints || []).find(
    (e) => e.identifier === "sessions" && (e.role === "RECEIVER" || !e.role)
  );
  return ep ? ep.url.replace(/\/+$/, "") : null;
}

function getDiscoveredEmspCdrsUrl() {
  if (simulationConfig.emspCdrsUrl) return simulationConfig.emspCdrsUrl.replace(/\/+$/, "");
  const ep = (state.partnerEndpoints || []).find(
    (e) => e.identifier === "cdrs" && (e.role === "RECEIVER" || !e.role)
  );
  return ep ? ep.url.replace(/\/+$/, "") : null;
}

function getDiscoveredEmspLocationsUrl() {
  if (simulationConfig.emspLocationsUrl) return simulationConfig.emspLocationsUrl.replace(/\/+$/, "");
  const ep = (state.partnerEndpoints || []).find(
    (e) => e.identifier === "locations" && (e.role === "RECEIVER" || !e.role)
  );
  if (ep && ep.url) return ep.url.replace(/\/+$/, "");
  if (state.partnerLocationsUrl) return state.partnerLocationsUrl.replace(/\/+$/, "");
  const fallback = (state.partnerEndpoints || []).find((e) => e.identifier === "locations");
  return fallback && fallback.url ? fallback.url.replace(/\/+$/, "") : null;
}

function getAuthHeaders() {
  const token = state.remoteToken || CONFIG.localToken;
  return requestHeaders(token, crypto.randomUUID());
}

/* -------------------------------------------------------------------------- */
/* OCPI EVSE STATUS UPDATE & CLEANING HELPERS                                 */
/* -------------------------------------------------------------------------- */

function toCleanOcpiEvse(evse, parentLocation) {
  if (!evse) return null;
  const raw = evse.toObject ? evse.toObject() : JSON.parse(JSON.stringify(evse));

  delete raw._id;
  delete raw.__v;
  delete raw.createdAt;
  delete raw.updatedAt;

  if (Array.isArray(raw.connectors)) {
    raw.connectors = raw.connectors.map((c) => {
      const conn = c && c.toObject ? c.toObject() : (c ? { ...c } : {});
      delete conn._id;
      delete conn.__v;
      return conn;
    });
  }

  // Handle coordinates: if missing or invalid on EVSE, inherit from parent location coordinates if present
  if (!raw.coordinates || !raw.coordinates.latitude || !raw.coordinates.longitude) {
    if (parentLocation && parentLocation.coordinates && parentLocation.coordinates.latitude && parentLocation.coordinates.longitude) {
      raw.coordinates = {
        latitude: String(parentLocation.coordinates.latitude),
        longitude: String(parentLocation.coordinates.longitude),
      };
    } else {
      delete raw.coordinates;
    }
  } else {
    raw.coordinates = {
      latitude: String(raw.coordinates.latitude),
      longitude: String(raw.coordinates.longitude),
    };
  }

  return omitNulls(raw);
}

async function pushEvseStatusUpdate({ location, evse, newStatus, trigger }) {
  if (!location || !evse) return null;

  const now = new Date().toISOString();
  evse.status = newStatus;
  evse.last_updated = now;

  // 1. Update in MongoDB if connected
  if (getConnectionStatus() === "CONNECTED" && location.id && evse.uid) {
    try {
      await OcpiLocation.updateOne(
        { id: location.id, "evses.uid": evse.uid },
        { $set: { "evses.$.status": newStatus, "evses.$.last_updated": now, last_updated: now } }
      );
    } catch (dbErr) {
      console.warn(`[EVSE Status Update] DB update failed for ${evse.uid}:`, dbErr.message);
    }
  }

  // 2. Update memory cache
  if (memoryLocations.has(location.id)) {
    const memLoc = memoryLocations.get(location.id);
    if (Array.isArray(memLoc.evses)) {
      const memEvse = memLoc.evses.find((e) => e.uid === evse.uid);
      if (memEvse) {
        memEvse.status = newStatus;
        memEvse.last_updated = now;
      }
    }
    memLoc.last_updated = now;
  }

  // 3. Prepare complete, clean EVSE object per OCPI 2.2.1
  const cleanEvse = toCleanOcpiEvse(evse, location);

  // 4. Resolve EMSP Locations endpoint: PUT /locations/{country_code}/{party_id}/{location_id}/{evse_uid}
  const emspLocationsBase = getDiscoveredEmspLocationsUrl();
  const countryCode = location.country_code || simulator.countryCode || "IN";
  const partyId = location.party_id || simulator.partyId || "CZK";
  const locationId = location.id;
  const evseUid = evse.uid;

  if (emspLocationsBase) {
    const putUrl = `${emspLocationsBase}/${encodeURIComponent(countryCode)}/${encodeURIComponent(partyId)}/${encodeURIComponent(locationId)}/${encodeURIComponent(evseUid)}`;
    try {
      const res = await trackedRequest("PUT", putUrl, { headers: getAuthHeaders(), timeout: 6000 }, cleanEvse);
      logSimulationOperation({
        type: "EVSE_PUT",
        method: "PUT",
        url: putUrl,
        requestBody: cleanEvse,
        httpStatus: res.status,
        responseBody: res.data,
        success: res.status >= 200 && res.status < 300,
        message: `[${trigger}] EVSE '${evseUid}' status updated to ${newStatus} on EMSP (${res.status})`,
      });
      return { success: res.status >= 200 && res.status < 300, evse: cleanEvse };
    } catch (putErr) {
      logSimulationOperation({
        type: "EVSE_PUT",
        method: "PUT",
        url: putUrl,
        requestBody: cleanEvse,
        httpStatus: putErr.response?.status || 500,
        responseBody: putErr.response?.data || putErr.message,
        success: false,
        message: `[${trigger}] EVSE '${evseUid}' status update to ${newStatus} failed: ${putErr.message}`,
      });
      return { success: false, error: putErr.message, evse: cleanEvse };
    }
  } else {
    logSimulationOperation({
      type: "EVSE_PUT",
      method: "PUT",
      url: "DISCOVERED_LOCATIONS_ENDPOINT_UNSET",
      requestBody: cleanEvse,
      httpStatus: 200,
      success: true,
      message: `[${trigger}] EVSE '${evseUid}' status updated to ${newStatus} locally (No EMSP locations endpoint registered in handshake).`,
    });
    return { success: true, evse: cleanEvse };
  }
}

/* -------------------------------------------------------------------------- */
/* DB / MEMORY ENTITY LOOKUP HELPERS                                          */
/* -------------------------------------------------------------------------- */

async function findLocationById(locationId) {
  if (!locationId) return null;
  const cleanId = String(locationId).trim();
  if (getConnectionStatus() === "CONNECTED") {
    try {
      const doc = await OcpiLocation.findOne({ id: cleanId }).lean();
      if (doc) return doc;
    } catch (_) {}
  }
  if (memoryLocations.has(cleanId)) return memoryLocations.get(cleanId);
  return (
    Array.from(memoryLocations.values()).find(
      (l) => l.id && l.id.toUpperCase() === cleanId.toUpperCase()
    ) || null
  );
}

async function findSessionById(sessionId) {
  if (!sessionId) return null;
  const cleanId = String(sessionId).trim();
  if (getConnectionStatus() === "CONNECTED") {
    try {
      const doc = await OcpiSession.findOne({ id: cleanId }).lean();
      if (doc) return doc;
    } catch (_) {}
  }
  if (memorySessions.has(cleanId)) return memorySessions.get(cleanId);
  return (
    Array.from(memorySessions.values()).find(
      (s) => s.id && s.id.toUpperCase() === cleanId.toUpperCase()
    ) || null
  );
}

/* -------------------------------------------------------------------------- */
/* START_SESSION LIFECYCLE HANDLER                                            */
/* -------------------------------------------------------------------------- */

async function handleStartSessionCommand(payload = {}) {
  const responseUrl = payload.response_url;

  // Log incoming start command
  logSimulationOperation({
    type: "START_COMMAND",
    method: "POST",
    url: "/ocpi/cpo/2.2.1/commands/START_SESSION",
    requestBody: payload,
    httpStatus: 200,
    success: true,
    message: `Received START_SESSION for location ${payload.location_id || "N/A"}`,
  });

  // 1. Validate response_url
  if (!responseUrl || typeof responseUrl !== "string" || !responseUrl.trim()) {
    return {
      isValid: false,
      response: {
        result: "REJECTED",
        timeout: 0,
        message: [{ language: "en", text: "Missing or invalid required field: response_url" }],
      },
    };
  }

  // 2. Validate token
  if (!payload.token || typeof payload.token !== "object" || !payload.token.uid) {
    return {
      isValid: false,
      response: {
        result: "REJECTED",
        timeout: 0,
        message: [{ language: "en", text: "Missing or invalid required field: token" }],
      },
    };
  }
  if (payload.token.valid === false) {
    return {
      isValid: false,
      response: {
        result: "REJECTED",
        timeout: 0,
        message: [{ language: "en", text: `Token '${payload.token.uid}' is marked as invalid (valid: false).` }],
      },
    };
  }

  // 3. Validate location_id
  if (!payload.location_id || typeof payload.location_id !== "string" || !payload.location_id.trim()) {
    return {
      isValid: false,
      response: {
        result: "REJECTED",
        timeout: 0,
        message: [{ language: "en", text: "Missing required field: location_id" }],
      },
    };
  }

  const targetLocation = await findLocationById(payload.location_id);
  if (!targetLocation) {
    return {
      isValid: false,
      response: {
        result: "REJECTED",
        timeout: 0,
        message: [{ language: "en", text: `Location '${payload.location_id}' not found.` }],
      },
    };
  }

  // 4. Validate EVSE
  const evses = Array.isArray(targetLocation.evses) ? targetLocation.evses : [];
  let targetEvse = null;
  if (payload.evse_uid) {
    targetEvse = evses.find((e) => e.uid === payload.evse_uid || e.evse_id === payload.evse_uid);
    if (!targetEvse) {
      return {
        isValid: false,
        response: {
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: `EVSE '${payload.evse_uid}' not found at location '${payload.location_id}'.` }],
        },
      };
    }
    if (["INOPERATIVE", "OUTOFORDER", "REMOVED"].includes(targetEvse.status)) {
      return {
        isValid: false,
        response: {
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: `EVSE '${payload.evse_uid}' is currently ${targetEvse.status}.` }],
        },
      };
    }
  } else {
    targetEvse = evses.find((e) => e.status === "AVAILABLE") || evses[0];
    if (!targetEvse) {
      return {
        isValid: false,
        response: {
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: `Location '${payload.location_id}' has no configured EVSEs.` }],
        },
      };
    }
  }

  // 5. Ensure EVSE is not already in an active session
  if (activeSimulation.status === "ACTIVE" && activeSimulation.evseUid === targetEvse.uid) {
    return {
      isValid: false,
      response: {
        result: "REJECTED",
        timeout: 0,
        message: [{ language: "en", text: `EVSE '${targetEvse.uid}' already has an active session (${activeSimulation.sessionId}).` }],
      },
    };
  }

  // 6. Validate Connector
  const connectors = Array.isArray(targetEvse.connectors) ? targetEvse.connectors : [];
  let targetConnector = null;
  if (payload.connector_id) {
    targetConnector = connectors.find((c) => String(c.id) === String(payload.connector_id));
    if (!targetConnector) {
      return {
        isValid: false,
        response: {
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: `Connector '${payload.connector_id}' not found on EVSE '${targetEvse.uid}'.` }],
        },
      };
    }
  } else {
    targetConnector = connectors[0];
    if (!targetConnector) {
      return {
        isValid: false,
        response: {
          result: "REJECTED",
          timeout: 0,
          message: [{ language: "en", text: `EVSE '${targetEvse.uid}' has no configured connectors.` }],
        },
      };
    }
  }

  // ALL VALIDATIONS PASSED -> Accept Command & Launch Lifecycle
  const sessionId = `SES-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const startDateTime = new Date().toISOString();

  // Create standard OCPI 2.2.1 Session object
  const sessionObj = {
    country_code: targetLocation.country_code || simulator.countryCode,
    party_id: targetLocation.party_id || simulator.partyId,
    id: sessionId,
    start_date_time: startDateTime,
    end_date_time: null,
    kwh: 0,
    cdr_token: {
      country_code: payload.token.country_code || simulator.countryCode,
      party_id: payload.token.party_id || simulator.partyId,
      uid: payload.token.uid,
      type: payload.token.type || "RFID",
      contract_id: payload.token.contract_id || null,
    },
    auth_method: "COMMAND",
    authorization_reference: payload.authorization_reference || null,
    location_id: targetLocation.id,
    evse_uid: targetEvse.uid,
    connector_id: String(targetConnector.id),
    meter_id: "MTR-" + targetEvse.uid,
    currency: simulationConfig.currency,
    charging_periods: [
      {
        start_date_time: startDateTime,
        dimensions: [{ type: "ENERGY", volume: 0 }],
      },
    ],
    total_cost: {
      excl_vat: 0,
      incl_vat: 0,
    },
    status: "ACTIVE",
    last_updated: startDateTime,
  };

  // Save session in DB & memory
  if (getConnectionStatus() === "CONNECTED") {
    try {
      const doc = new OcpiSession(sessionObj);
      await doc.save();
      await OcpiLocation.updateOne(
        { id: targetLocation.id, "evses.uid": targetEvse.uid },
        { $set: { "evses.$.status": "CHARGING", last_updated: startDateTime } }
      );
    } catch (dbErr) {
      console.warn("[START_SESSION] Mongo save warning:", dbErr.message);
    }
  }
  memorySessions.set(sessionId, sessionObj);
  targetEvse.status = "CHARGING";

  // Stop any previous running simulation timer
  if (activeSimulation.timerId) {
    clearInterval(activeSimulation.timerId);
    activeSimulation.timerId = null;
  }

  // Update active simulation state
  activeSimulation.status = "ACTIVE";
  activeSimulation.sessionId = sessionId;
  activeSimulation.cdrId = null;
  activeSimulation.locationId = targetLocation.id;
  activeSimulation.locationName = targetLocation.name;
  activeSimulation.evseUid = targetEvse.uid;
  activeSimulation.connectorId = String(targetConnector.id);
  activeSimulation.startDateTime = startDateTime;
  activeSimulation.endDateTime = null;
  activeSimulation.elapsedSeconds = 0;
  activeSimulation.consumedKwh = 0;
  activeSimulation.currentMeterKwh = simulationConfig.initialMeterKwh;
  activeSimulation.exclVatCost = 0;
  activeSimulation.taxAmount = 0;
  activeSimulation.inclVatCost = 0;
  activeSimulation.chargingPowerKw = simulationConfig.chargingPowerKw;
  activeSimulation.token = payload.token;
  activeSimulation.responseUrl = responseUrl;
  activeSimulation.authorizationReference = payload.authorization_reference || null;
  activeSimulation.lastError = null;
  activeSimulation.sessionObj = sessionObj;
  activeSimulation.targetLocation = targetLocation;
  activeSimulation.targetEvse = targetEvse;
  activeSimulation.targetConnector = targetConnector;

  const successMessage = `Command START_SESSION accepted. Session ${sessionId} started on EVSE ${targetEvse.uid}, connector ${targetConnector.id}.`;

  // 1. Send Session PUT to EMSP
  const emspSessionsBase = getDiscoveredEmspSessionsUrl();
  if (emspSessionsBase) {
    const putUrl = `${emspSessionsBase}/${sessionObj.country_code}/${sessionObj.party_id}/${sessionObj.id}`;
    try {
      const res = await trackedRequest("PUT", putUrl, { headers: getAuthHeaders(), timeout: 6000 }, sessionObj);
      logSimulationOperation({
        type: "SESSION_PUT",
        method: "PUT",
        url: putUrl,
        requestBody: sessionObj,
        httpStatus: res.status,
        responseBody: res.data,
        success: res.status >= 200 && res.status < 300,
        message: `Initial Session PUT sent to EMSP (${res.status})`,
      });
    } catch (putErr) {
      logSimulationOperation({
        type: "SESSION_PUT",
        method: "PUT",
        url: putUrl,
        requestBody: sessionObj,
        httpStatus: putErr.response?.status || 500,
        responseBody: putErr.response?.data || putErr.message,
        success: false,
        message: `Initial Session PUT failed: ${putErr.message}`,
      });
    }
  } else {
    logSimulationOperation({
      type: "SESSION_PUT",
      method: "PUT",
      url: "DISCOVERED_SESSIONS_ENDPOINT_UNSET",
      requestBody: sessionObj,
      httpStatus: 200,
      success: true,
      message: "Session created locally (No EMSP sessions endpoint registered in handshake).",
    });
  }

  // 1b. Send EVSE status update (CHARGING) to EMSP per OCPI Locations module
  await pushEvseStatusUpdate({
    location: targetLocation,
    evse: targetEvse,
    newStatus: "CHARGING",
    trigger: "START_SESSION",
  });

  // 2. Send Async Command Callback to response_url per OCPI 2.2.1 Section 6.1.1
  if (responseUrl && responseUrl.startsWith("http")) {
    setTimeout(async () => {
      try {
        const callbackResult = {
          result: "ACCEPTED",
          message: [{ language: "en", text: successMessage }],
        };
        await trackedRequest("POST", responseUrl, { headers: getAuthHeaders(), timeout: 10000 }, callbackResult);
        log(`[START_SESSION Callback] Dispatched callback to ${responseUrl}`, { sessionId });
      } catch (cbErr) {
        console.warn(`[START_SESSION Callback] Failed to deliver callback:`, cbErr.message);
      }
    }, 1000);
  }

  // 3. Start periodic energy accumulation & Session PATCH updates
  startPeriodicSimulationTimer(sessionObj);

  return {
    isValid: true,
    response: {
      result: "ACCEPTED",
      timeout: 30,
      message: [{ language: "en", text: successMessage }],
    },
    session: sessionObj,
  };
}

/* -------------------------------------------------------------------------- */
/* PERIODIC ENERGY ACCUMULATION & SESSION PATCH TIMER                         */
/* -------------------------------------------------------------------------- */

function startPeriodicSimulationTimer(sessionObj) {
  const intervalMs = simulationConfig.updateIntervalSeconds * 1000;

  activeSimulation.timerId = setInterval(async () => {
    try {
      if (activeSimulation.status !== "ACTIVE" || !activeSimulation.sessionId) {
        clearInterval(activeSimulation.timerId);
        activeSimulation.timerId = null;
        return;
      }

      // Calculate actual elapsed duration
      const now = Date.now();
      const startMs = new Date(activeSimulation.startDateTime).getTime();
      const elapsedMs = Math.max(0, now - startMs);
      const elapsedSeconds = Math.round(elapsedMs / 1000);
      const elapsedHours = elapsedMs / (1000 * 3600);

      // Energy Consumed (kWh) = Charging Power (kW) × Duration (Hours)
      const consumedKwh = Number((simulationConfig.chargingPowerKw * elapsedHours).toFixed(4));
      const currentMeter = Number((simulationConfig.initialMeterKwh + consumedKwh).toFixed(4));
      const exclVat = Number((consumedKwh * simulationConfig.energyPrice).toFixed(2));
      const taxAmount = Number(((exclVat * simulationConfig.taxPercentage) / 100).toFixed(2));
      const inclVat = Number((exclVat + taxAmount).toFixed(2));

      // Update state
      activeSimulation.elapsedSeconds = elapsedSeconds;
      activeSimulation.consumedKwh = consumedKwh;
      activeSimulation.currentMeterKwh = currentMeter;
      activeSimulation.exclVatCost = exclVat;
      activeSimulation.taxAmount = taxAmount;
      activeSimulation.inclVatCost = inclVat;

      const lastUpdated = new Date().toISOString();

      // Update session in memory & DB
      const chargingPeriods = [
        {
          start_date_time: activeSimulation.startDateTime,
          dimensions: [
            { type: "ENERGY", volume: consumedKwh },
            { type: "TIME", volume: elapsedSeconds },
          ],
        },
      ];

      const patchPayload = {
        kwh: consumedKwh,
        total_cost: {
          excl_vat: exclVat,
          incl_vat: inclVat,
        },
        charging_periods: chargingPeriods,
        last_updated: lastUpdated,
      };

      sessionObj.kwh = consumedKwh;
      sessionObj.total_cost = patchPayload.total_cost;
      sessionObj.charging_periods = chargingPeriods;
      sessionObj.last_updated = lastUpdated;

      memorySessions.set(sessionObj.id, sessionObj);
      if (getConnectionStatus() === "CONNECTED") {
        try {
          await OcpiSession.updateOne(
            { id: sessionObj.id },
            { $set: patchPayload }
          );
        } catch (_) {}
      }

      // Dispatch Session PATCH to EMSP
      const emspSessionsBase = getDiscoveredEmspSessionsUrl();
      if (emspSessionsBase) {
        const patchUrl = `${emspSessionsBase}/${sessionObj.country_code}/${sessionObj.party_id}/${sessionObj.id}`;
        try {
          const res = await trackedRequest("PATCH", patchUrl, { headers: getAuthHeaders(), timeout: 8000 }, patchPayload);
          logSimulationOperation({
            type: "SESSION_PATCH",
            method: "PATCH",
            url: patchUrl,
            requestBody: patchPayload,
            httpStatus: res.status,
            responseBody: res.data,
            success: res.status >= 200 && res.status < 300,
            message: `Periodic PATCH sent: ${consumedKwh} kWh, ₹${inclVat} (${res.status})`,
          });
        } catch (patchErr) {
          logSimulationOperation({
            type: "SESSION_PATCH",
            method: "PATCH",
            url: patchUrl,
            requestBody: patchPayload,
            httpStatus: patchErr.response?.status || 500,
            responseBody: patchErr.response?.data || patchErr.message,
            success: false,
            message: `Periodic PATCH failed: ${patchErr.message}`,
          });
        }
      }

      // Check autoStop condition
      if (simulationConfig.autoStop && elapsedSeconds >= simulationConfig.sessionDurationSeconds) {
        console.log(`[Simulation] Reached configured duration of ${simulationConfig.sessionDurationSeconds}s. Stopping...`);
        await handleStopSessionCommand({ session_id: sessionObj.id, response_url: activeSimulation.responseUrl });
      }
    } catch (tickErr) {
      console.error("[Simulation Timer Error]:", tickErr.message);
    }
  }, intervalMs);
}

/* -------------------------------------------------------------------------- */
/* STOP_SESSION LIFECYCLE & CDR GENERATION                                    */
/* -------------------------------------------------------------------------- */

async function handleStopSessionCommand(payload = {}) {
  const sessionId = payload.session_id;
  const responseUrl = payload.response_url || activeSimulation.responseUrl;

  logSimulationOperation({
    type: "STOP_COMMAND",
    method: "POST",
    url: "/ocpi/cpo/2.2.1/commands/STOP_SESSION",
    requestBody: payload,
    httpStatus: 200,
    success: true,
    message: `Received STOP_SESSION for ${sessionId || "N/A"}`,
  });

  if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
    return {
      isValid: false,
      response: {
        result: "REJECTED",
        timeout: 0,
        message: [{ language: "en", text: "Missing required field: session_id" }],
      },
    };
  }

  const session = await findSessionById(sessionId);
  if (!session) {
    return {
      isValid: false,
      response: {
        result: "UNKNOWN_SESSION",
        timeout: 0,
        message: [{ language: "en", text: `Session '${sessionId}' not found.` }],
      },
    };
  }

  if (session.status === "COMPLETED") {
    return {
      isValid: false,
      response: {
        result: "REJECTED",
        timeout: 0,
        message: [{ language: "en", text: `Session '${sessionId}' is already completed.` }],
      },
    };
  }

  // 1. Immediately stop simulation timer
  if (activeSimulation.timerId) {
    clearInterval(activeSimulation.timerId);
    activeSimulation.timerId = null;
  }

  // 2. Final energy & cost calculations based on actual elapsed time
  const stopDateTime = new Date().toISOString();
  const startMs = new Date(session.start_date_time).getTime();
  const elapsedMs = Math.max(1000, Date.now() - startMs);
  const elapsedSeconds = Math.round(elapsedMs / 1000);
  const elapsedHours = elapsedMs / (1000 * 3600);

  const finalKwh = Number((simulationConfig.chargingPowerKw * elapsedHours).toFixed(4));
  const exclVat = Number((finalKwh * simulationConfig.energyPrice).toFixed(2));
  const taxAmount = Number(((exclVat * simulationConfig.taxPercentage) / 100).toFixed(2));
  const inclVat = Number((exclVat + taxAmount).toFixed(2));

  // 3. Update session object to COMPLETED
  const finalChargingPeriods = [
    {
      start_date_time: session.start_date_time,
      dimensions: [
        { type: "ENERGY", volume: finalKwh },
        { type: "TIME", volume: elapsedSeconds },
      ],
    },
  ];

  const finalPatch = {
    status: "COMPLETED",
    end_date_time: stopDateTime,
    kwh: finalKwh,
    total_cost: {
      excl_vat: exclVat,
      incl_vat: inclVat,
    },
    charging_periods: finalChargingPeriods,
    last_updated: stopDateTime,
  };

  const updatedSession = { ...session, ...finalPatch };
  memorySessions.set(sessionId, updatedSession);

  if (getConnectionStatus() === "CONNECTED") {
    try {
      await OcpiSession.updateOne({ id: sessionId }, { $set: finalPatch });
      if (session.location_id && session.evse_uid) {
        await OcpiLocation.updateOne(
          { id: session.location_id, "evses.uid": session.evse_uid },
          { $set: { "evses.$.status": "AVAILABLE", last_updated: stopDateTime } }
        );
      }
    } catch (dbErr) {
      console.warn("[STOP_SESSION] DB update warning:", dbErr.message);
    }
  }

  // Reset EVSE in memory
  if (activeSimulation.targetEvse) {
    activeSimulation.targetEvse.status = "AVAILABLE";
  }

  // Update active simulation status
  activeSimulation.status = "COMPLETED";
  activeSimulation.endDateTime = stopDateTime;
  activeSimulation.elapsedSeconds = elapsedSeconds;
  activeSimulation.consumedKwh = finalKwh;
  activeSimulation.currentMeterKwh = Number((simulationConfig.initialMeterKwh + finalKwh).toFixed(4));
  activeSimulation.exclVatCost = exclVat;
  activeSimulation.taxAmount = taxAmount;
  activeSimulation.inclVatCost = inclVat;
  activeSimulation.sessionObj = updatedSession;

  // 4. Send final Session PATCH to EMSP
  const emspSessionsBase = getDiscoveredEmspSessionsUrl();
  if (emspSessionsBase) {
    const finalPatchUrl = `${emspSessionsBase}/${updatedSession.country_code}/${updatedSession.party_id}/${updatedSession.id}`;
    try {
      const res = await trackedRequest("PATCH", finalPatchUrl, { headers: getAuthHeaders(), timeout: 6000 }, finalPatch);
      logSimulationOperation({
        type: "FINAL_PATCH",
        method: "PATCH",
        url: finalPatchUrl,
        requestBody: finalPatch,
        httpStatus: res.status,
        responseBody: res.data,
        success: res.status >= 200 && res.status < 300,
        message: `Final Session PATCH sent: COMPLETED, ${finalKwh} kWh, ₹${inclVat}`,
      });
    } catch (patchErr) {
      logSimulationOperation({
        type: "FINAL_PATCH",
        method: "PATCH",
        url: finalPatchUrl,
        requestBody: finalPatch,
        httpStatus: patchErr.response?.status || 500,
        responseBody: patchErr.response?.data || patchErr.message,
        success: false,
        message: `Final Session PATCH failed: ${patchErr.message}`,
      });
    }
  }

  // 4b. Send EVSE status update (AVAILABLE) to EMSP per OCPI Locations module
  const targetLoc = activeSimulation.targetLocation || (await findLocationById(session.location_id));
  const targetEvse = (targetLoc?.evses || []).find((e) => e.uid === session.evse_uid) || activeSimulation.targetEvse;
  if (targetLoc && targetEvse) {
    await pushEvseStatusUpdate({
      location: targetLoc,
      evse: targetEvse,
      newStatus: "AVAILABLE",
      trigger: "STOP_SESSION",
    });
  }

  // 5. Generate standard OCPI 2.2.1 CDR
  const cdrId = `CDR-${sessionId.replace(/^SES-/, "")}`;
  activeSimulation.cdrId = cdrId;

  const loc = activeSimulation.targetLocation || (await findLocationById(session.location_id)) || {};
  const evse = (loc.evses || []).find((e) => e.uid === session.evse_uid) || {};
  const connector = (evse.connectors || []).find((c) => String(c.id) === String(session.connector_id)) || {};

  const cdrObj = {
    country_code: session.country_code || simulator.countryCode,
    party_id: session.party_id || simulator.partyId,
    id: cdrId,
    start_date_time: session.start_date_time,
    end_date_time: stopDateTime,
    stop_date_time: stopDateTime, // Backwards compatible alias
    session_id: session.id,
    cdr_token: session.cdr_token,
    auth_method: session.auth_method || "COMMAND",
    authorization_reference: session.authorization_reference || null,
    cdr_location: {
      id: loc.id || session.location_id,
      name: loc.name || "Charging Station",
      address: loc.address || "",
      city: loc.city || "",
      postal_code: loc.postal_code || null,
      state: loc.state || null,
      country: loc.country || "IND",
      coordinates: loc.coordinates || { latitude: "0.0", longitude: "0.0" },
      evse_uid: session.evse_uid,
      evse_id: evse.evse_id || null,
      connector_id: session.connector_id,
      connector_standard: connector.standard || "IEC_62196_T2",
      connector_format: connector.format || "SOCKET",
      connector_power_type: connector.power_type || "AC_3_PHASE",
    },
    meter_id: session.meter_id || null,
    currency: session.currency || simulationConfig.currency,
    tariffs: [],
    charging_periods: finalChargingPeriods,
    total_cost: {
      excl_vat: exclVat,
      incl_vat: inclVat,
    },
    total_fixed_cost: { excl_vat: 0, incl_vat: 0 },
    total_energy: finalKwh,
    total_energy_cost: { excl_vat: exclVat, incl_vat: inclVat },
    total_time: Number((elapsedSeconds / 3600).toFixed(4)),
    total_time_cost: { excl_vat: 0, incl_vat: 0 },
    total_parking_time: 0,
    credit: false,
    last_updated: stopDateTime,
  };

  activeSimulation.cdrObj = cdrObj;
  memoryCdrs.set(cdrId, cdrObj);

  if (getConnectionStatus() === "CONNECTED") {
    try {
      const cdrDoc = new OcpiCdr(cdrObj);
      await cdrDoc.save();
    } catch (cdrErr) {
      console.warn("[STOP_SESSION] CDR save warning:", cdrErr.message);
    }
  }

  // 6. Submit CDR via POST /cdrs to EMSP
  const emspCdrsBase = getDiscoveredEmspCdrsUrl();
  if (emspCdrsBase) {
    try {
      const res = await trackedRequest("POST", emspCdrsBase, { headers: getAuthHeaders(), timeout: 6000 }, cdrObj);
      logSimulationOperation({
        type: "CDR_POST",
        method: "POST",
        url: emspCdrsBase,
        requestBody: cdrObj,
        httpStatus: res.status,
        responseBody: res.data,
        success: res.status >= 200 && res.status < 300,
        message: `CDR '${cdrId}' submitted to EMSP (${res.status})`,
      });
    } catch (cdrPostErr) {
      logSimulationOperation({
        type: "CDR_POST",
        method: "POST",
        url: emspCdrsBase,
        requestBody: cdrObj,
        httpStatus: cdrPostErr.response?.status || 500,
        responseBody: cdrPostErr.response?.data || cdrPostErr.message,
        success: false,
        message: `CDR submission failed: ${cdrPostErr.message}`,
      });
    }
  } else {
    logSimulationOperation({
      type: "CDR_POST",
      method: "POST",
      url: "DISCOVERED_CDRS_ENDPOINT_UNSET",
      requestBody: cdrObj,
      httpStatus: 200,
      success: true,
      message: `CDR '${cdrId}' stored locally (No EMSP CDRs endpoint registered in handshake).`,
    });
  }

  // 7. Dispatch Async Command Callback to response_url
  if (responseUrl && responseUrl.startsWith("http")) {
    setTimeout(async () => {
      try {
        const callbackResult = {
          result: "ACCEPTED",
          message: [{ language: "en", text: `Session ${sessionId} stopped successfully. CDR ${cdrId} generated.` }],
        };
        await trackedRequest("POST", responseUrl, { headers: getAuthHeaders(), timeout: 10000 }, callbackResult);
        log(`[STOP_SESSION Callback] Dispatched callback to ${responseUrl}`, { sessionId, cdrId });
      } catch (cbErr) {
        console.warn(`[STOP_SESSION Callback] Failed to deliver callback:`, cbErr.message);
      }
    }, 1000);
  }

  return {
    isValid: true,
    response: {
      result: "ACCEPTED",
      timeout: 30,
      message: [
        {
          language: "en",
          text: `Session ${sessionId} stopped. Final energy: ${finalKwh} kWh, Cost: ₹${inclVat}. CDR ${cdrId} generated.`,
        },
      ],
    },
    session: updatedSession,
    cdr: cdrObj,
  };
}

/* -------------------------------------------------------------------------- */
/* RESET SIMULATION                                                           */
/* -------------------------------------------------------------------------- */

function resetSimulation() {
  if (activeSimulation.timerId) {
    clearInterval(activeSimulation.timerId);
    activeSimulation.timerId = null;
  }
  if (activeSimulation.targetEvse && activeSimulation.targetEvse.status === "CHARGING") {
    activeSimulation.targetEvse.status = "AVAILABLE";
    if (activeSimulation.targetLocation) {
      pushEvseStatusUpdate({
        location: activeSimulation.targetLocation,
        evse: activeSimulation.targetEvse,
        newStatus: "AVAILABLE",
        trigger: "RESET_SIMULATION",
      }).catch(() => {});
    }
  }
  activeSimulation.status = "IDLE";
  activeSimulation.sessionId = null;
  activeSimulation.cdrId = null;
  activeSimulation.locationId = null;
  activeSimulation.locationName = null;
  activeSimulation.evseUid = null;
  activeSimulation.connectorId = null;
  activeSimulation.startDateTime = null;
  activeSimulation.endDateTime = null;
  activeSimulation.elapsedSeconds = 0;
  activeSimulation.consumedKwh = 0;
  activeSimulation.currentMeterKwh = 0;
  activeSimulation.exclVatCost = 0;
  activeSimulation.taxAmount = 0;
  activeSimulation.inclVatCost = 0;
  activeSimulation.sessionObj = null;
  activeSimulation.cdrObj = null;
  activeSimulation.lastError = null;

  return getActiveSimulationState();
}

module.exports = {
  getSimulationConfig,
  updateSimulationConfig,
  getActiveSimulationState,
  handleStartSessionCommand,
  handleStopSessionCommand,
  resetSimulation,
  logSimulationOperation,
  findLocationById,
  findSessionById,
  getDiscoveredEmspLocationsUrl,
  toCleanOcpiEvse,
  pushEvseStatusUpdate,
};
