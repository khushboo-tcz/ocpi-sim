const express = require("express");
const router = express.Router();
const {
  CONFIG,
  state,
  simulator,
  log,
  ocpiResponse,
  isAuthorized,
  localCredentials,
} = require("../services/simulatorState");

const crypto = require("node:crypto");
const { getConnectionStatus } = require("../db/connection");
const OcpiConnectionProfile = require("../models/OcpiConnectionProfile");

/**
 * Returns role-specific endpoints catalog for OCPI 2.2.1:
 * - If role === 'CPO': Credentials + CPO endpoints (locations, tariffs, sessions, cdrs, tokens, commands, chargingprofiles)
 * - If role === 'EMSP': Credentials + eMSP endpoints (locations, tariffs, sessions, cdrs, tokens, commands, chargingprofiles)
 */
function getEndpointsForRole(role = simulator.role) {
  const credentialsEndpoints = [
    {
      identifier: "credentials",
      role: "RECEIVER",
      url: `${CONFIG.baseUrl}/ocpi/2.2.1/credentials`,
    },
    {
      identifier: "credentials",
      role: "SENDER",
      url: `${CONFIG.baseUrl}/ocpi/2.2.1/credentials`,
    },
  ];

  const cpoEndpoints = [
    {
      identifier: "locations",
      role: "SENDER",
      url: `${CONFIG.baseUrl}/ocpi/cpo/2.2.1/locations`,
    },
    {
      identifier: "tariffs",
      role: "SENDER",
      url: `${CONFIG.baseUrl}/ocpi/cpo/2.2.1/tariffs`,
    },
    {
      identifier: "sessions",
      role: "SENDER",
      url: `${CONFIG.baseUrl}/ocpi/cpo/2.2.1/sessions`,
    },
    {
      identifier: "cdrs",
      role: "SENDER",
      url: `${CONFIG.baseUrl}/ocpi/cpo/2.2.1/cdrs`,
    },
    {
      identifier: "tokens",
      role: "RECEIVER",
      url: `${CONFIG.baseUrl}/ocpi/cpo/2.2.1/tokens`,
    },
    {
      identifier: "commands",
      role: "RECEIVER",
      url: `${CONFIG.baseUrl}/ocpi/cpo/2.2.1/commands`,
    },
    {
      identifier: "chargingprofiles",
      role: "RECEIVER",
      url: `${CONFIG.baseUrl}/ocpi/cpo/2.2.1/chargingprofiles`,
    },
  ];

  const emspEndpoints = [
    {
      identifier: "locations",
      role: "RECEIVER",
      url: `${CONFIG.baseUrl}/ocpi/emsp/2.2.1/locations`,
    },
    {
      identifier: "tariffs",
      role: "RECEIVER",
      url: `${CONFIG.baseUrl}/ocpi/emsp/2.2.1/tariffs`,
    },
    {
      identifier: "sessions",
      role: "RECEIVER",
      url: `${CONFIG.baseUrl}/ocpi/emsp/2.2.1/sessions`,
    },
    {
      identifier: "cdrs",
      role: "RECEIVER",
      url: `${CONFIG.baseUrl}/ocpi/emsp/2.2.1/cdrs`,
    },
    {
      identifier: "tokens",
      role: "SENDER",
      url: `${CONFIG.baseUrl}/ocpi/emsp/2.2.1/tokens`,
    },
    {
      identifier: "commands",
      role: "SENDER",
      url: `${CONFIG.baseUrl}/ocpi/emsp/2.2.1/commands`,
    },
    {
      identifier: "chargingprofiles",
      role: "SENDER",
      url: `${CONFIG.baseUrl}/ocpi/emsp/2.2.1/chargingprofiles`,
    },
  ];

  const effectiveRole = String(role || simulator.role || "CPO").toUpperCase();
  if (effectiveRole === "CPO") {
    return [...credentialsEndpoints, ...cpoEndpoints];
  }
  if (effectiveRole === "EMSP") {
    return [...credentialsEndpoints, ...emspEndpoints];
  }
  return [...credentialsEndpoints, ...cpoEndpoints, ...emspEndpoints];
}

// Version discovery auth validation: requires token authentication
const validateVersionAuth = (req, res, next) => {
  const auth = req.get("Authorization") || req.get("X-Ocpi-Token") || req.get("X-Token");
  if (!auth) {
    return res.status(200).json(ocpiResponse(null, 2001, "Authorization header required (Token <token>)"));
  }

  // If connected, handshake has completed and partner MUST use the new active token
  if (state.status === "CONNECTED" && state.localToken) {
    if (isAuthorized(req, state.localToken) || (CONFIG.localToken && isAuthorized(req, CONFIG.localToken))) {
      return next();
    }
    return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized token: handshake is complete, please use the new active token"));
  }

  // Before handshake is complete, access with the initial simulator bootstrap token (Token A)
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

/**
 * GET /ocpi/versions
 * OCPI 2.2.1 Section 4.1: Available OCPI versions
 */
router.get("/versions", validateVersionAuth, (req, res) => {
  return res.json(
    ocpiResponse([
      {
        version: CONFIG.version,
        url: `${CONFIG.baseUrl}/ocpi/2.2.1/details`,
      },
    ])
  );
});

/**
 * GET /ocpi/2.2.1/details
 * OCPI 2.2.1 Section 4.2: Endpoints catalog for OCPI 2.2.1
 * Returns only the endpoints relevant to the active simulator role:
 * - CPO: credentials + CPO sender/receiver modules
 * - eMSP: credentials + eMSP sender/receiver modules
 */
router.get("/2.2.1/details", validateVersionAuth, (req, res) => {
  const role = req.query.role || simulator.role;
  const endpoints = getEndpointsForRole(role);

  return res.json(
    ocpiResponse({
      version: CONFIG.version,
      endpoints,
    })
  );
});

/**
 * POST /ocpi/2.2.1/credentials
 * Partner sends Token B and their endpoints using bootstrap Token A
 */
router.post("/2.2.1/credentials", async (req, res) => {
  const validBootstrap = state.bootstrapToken || CONFIG.inboundBootstrapToken;
  if (
    (!validBootstrap || !isAuthorized(req, validBootstrap)) &&
    (!state.localToken || !isAuthorized(req, state.localToken)) &&
    (!CONFIG.localToken || !isAuthorized(req, CONFIG.localToken))
  ) {
    return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized token: valid bootstrap token required"));
  }

  const credentials = req.body;
  if (
    !credentials ||
    typeof credentials.token !== "string" ||
    !credentials.token ||
    typeof credentials.url !== "string" ||
    !credentials.url ||
    !Array.isArray(credentials.roles) ||
    credentials.roles.length === 0
  ) {
    return res.status(200).json(ocpiResponse(null, 2001, "Invalid credentials payload"));
  }

  // Handshake is done -> Change/rotate token to a NEW active token (Token C)!
  const newLocalToken = "SIM-" + crypto.randomUUID().replace(/-/g, "").toUpperCase();
  state.localToken = newLocalToken;
  state.bootstrapToken = null; // Retire old bootstrap token
  state.remoteToken = credentials.token;
  state.remoteVersionsUrl = credentials.url;
  state.partnerRoles = credentials.roles;
  state.status = "CONNECTED";
  state.lastError = null;

  // Persist updated credentials to MongoDB if connected
  if (getConnectionStatus() === "CONNECTED") {
    try {
      const query = state.activeProfileId ? { _id: state.activeProfileId } : { simulatorRole: "CPO" };
      let profile = await OcpiConnectionProfile.findOne(query);
      if (!profile) {
        profile = new OcpiConnectionProfile({ simulatorRole: "CPO" });
      }
      profile.status = "CONNECTED";
      profile.connectionMode = "HANDSHAKE";
      profile.partnerRoles = credentials.roles;
      profile.remoteToken = credentials.token;
      profile.localToken = newLocalToken;
      profile.remoteVersionsUrl = credentials.url;
      profile.lastError = null;
      profile.lastHandshakeAt = new Date();
      await profile.save();
      state.activeProfileId = String(profile._id);
    } catch (dbErr) {
      console.error("[Credentials] Failed to persist new token to DB:", dbErr.message);
    }
  }

  log("Incoming credentials registration completed, new token generated and active", {
    newActiveToken: newLocalToken.slice(0, 8) + "••••••••",
    partnerRoles: credentials.roles.map(({ role, party_id, country_code }) => ({
      role,
      party_id,
      country_code,
    })),
  });

  return res.json(ocpiResponse(localCredentials()));
});

/**
 * GET /ocpi/2.2.1/credentials
 * Fetch receiver credentials with Token C (active token)
 */
router.get("/2.2.1/credentials", (req, res) => {
  const activeToken = state.localToken || CONFIG.localToken;
  if (!isAuthorized(req, activeToken)) {
    return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized"));
  }
  return res.json(ocpiResponse(localCredentials()));
});

/**
 * PUT /ocpi/2.2.1/credentials
 * Update existing credentials token and endpoints
 */
router.put("/2.2.1/credentials", async (req, res) => {
  const activeToken = state.localToken || CONFIG.localToken;
  if (!isAuthorized(req, activeToken)) {
    return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized"));
  }

  const credentials = req.body;
  if (credentials?.token) state.remoteToken = credentials.token;
  if (credentials?.url) state.remoteVersionsUrl = credentials.url;
  if (Array.isArray(credentials?.roles)) state.partnerRoles = credentials.roles;

  if (getConnectionStatus() === "CONNECTED" && state.activeProfileId) {
    try {
      await OcpiConnectionProfile.findByIdAndUpdate(state.activeProfileId, {
        remoteToken: state.remoteToken,
        remoteVersionsUrl: state.remoteVersionsUrl,
        partnerRoles: state.partnerRoles,
      });
    } catch (err) {
      console.error("[PUT credentials] DB error:", err.message);
    }
  }

  log("Credentials updated via PUT", { remoteVersionsUrl: state.remoteVersionsUrl });
  return res.json(ocpiResponse(localCredentials()));
});

/**
 * DELETE /ocpi/2.2.1/credentials
 * Unregister connection
 */
router.delete("/2.2.1/credentials", async (req, res) => {
  const activeToken = state.localToken || CONFIG.localToken;
  if (!isAuthorized(req, activeToken)) {
    return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized"));
  }

  state.status = "DISCONNECTED";
  state.remoteToken = null;
  state.partnerRoles = [];
  state.partnerEndpoints = [];
  state.partnerLocationsUrl = null;

  if (getConnectionStatus() === "CONNECTED" && state.activeProfileId) {
    try {
      await OcpiConnectionProfile.findByIdAndUpdate(state.activeProfileId, {
        status: "DISCONNECTED",
        remoteToken: null,
        partnerRoles: [],
        partnerEndpoints: [],
        partnerLocationsUrl: null,
      });
    } catch (err) {
      console.error("[DELETE credentials] DB error:", err.message);
    }
  }

  log("Connection unregistered via DELETE /ocpi/2.2.1/credentials");
  return res.json(ocpiResponse(null, 1000, "Unregistered successfully"));
});

module.exports = router;
