const crypto = require("node:crypto");
const mongoose = require("mongoose");
const OcpiConnectionProfile = require("../models/OcpiConnectionProfile");
const OcpiEndpoint = require("../models/OcpiEndpoint");
const OcpiVersion = require("../models/OcpiVersion");
const OcpiEmspTariff = require("../models/OcpiEmspTariff");
const OcpiEmspLocation = require("../models/OcpiEmspLocation");
const OcpiEmspSession = require("../models/OcpiEmspSession");
const OcpiEmspCdr = require("../models/OcpiEmspCdr");
const OcpiApiLog = require("../models/OcpiApiLog");
const { getConnectionStatus } = require("../db/connection");
const { getMemoryLogs } = require("./logger");
const {
  CONFIG,
  simulator,
  state,
  requestHeaders,
  trackedRequest,
  unwrapOcpiResponse,
  localRoles,
  encodeTokenForHeader,
  restoreStateFromDb,
  ocpiResponse,
  log,
} = require("./simulatorState");

// In-progress deletion tracking to prevent concurrent operations against a deleting connection
const deletionsInProgress = new Set();

function isDeletionInProgress(profileId) {
  if (!profileId) return false;
  return deletionsInProgress.has(String(profileId));
}

/**
 * Extract raw token string from HTTP Authorization header.
 * Handles: "Token <token>", "Bearer <token>", "Token <base64>", or raw string.
 */
function extractTokenFromHeader(header) {
  if (!header || typeof header !== "string") return null;
  const trimmed = header.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 2 && (parts[0].toLowerCase() === "token" || parts[0].toLowerCase() === "bearer")) {
    return parts[1].trim();
  }
  return trimmed.replace(/^Token\s+/i, "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * Resolve OcpiConnectionProfile by matching the inbound token against
 * localToken, remoteToken, or bootstrapToken (both raw and Base64 decoded).
 */
async function resolveConnectionProfileByToken(tokenInHeader) {
  if (!tokenInHeader) return null;

  const candidates = [tokenInHeader];
  try {
    const decoded = Buffer.from(tokenInHeader, "base64").toString("utf8");
    if (decoded && decoded !== tokenInHeader && /^[\w\-.~]+$/.test(decoded)) {
      candidates.push(decoded);
    }
  } catch (_) {}

  // Look up matching EMSP profile in MongoDB
  if (getConnectionStatus() === "CONNECTED") {
    let profile = await OcpiConnectionProfile.findOne({
      simulatorRole: "EMSP",
      $or: [
        { localToken: { $in: candidates } },
        { remoteToken: { $in: candidates } },
        { bootstrapToken: { $in: candidates } },
      ],
    });

    if (profile) return profile;

    // Check fallback to any profile matching active state tokens
    const activeTokens = [
      state.localToken,
      state.bootstrapToken,
      CONFIG.localToken,
      CONFIG.inboundBootstrapToken,
    ].filter(Boolean);

    const matchesActive = candidates.some((c) => activeTokens.includes(c));
    if (matchesActive) {
      if (state.activeProfileId && mongoose.isValidObjectId(state.activeProfileId)) {
        profile = await OcpiConnectionProfile.findById(state.activeProfileId);
        if (profile) return profile;
      }
      profile = await OcpiConnectionProfile.findOne({ simulatorRole: "EMSP" }).sort({ updatedAt: -1 });
      if (profile) return profile;
    }
  }

  return null;
}

/**
 * Authentication middleware for inbound EMSP receiver endpoints
 * (Sessions PUT/PATCH, CDRs POST, Locations PUT, Tariffs PUT).
 * Resolves connectionProfileId from authenticated token context.
 */
async function validateEmspAuth(req, res, next) {
  const authHeader = req.get("Authorization") || req.get("X-Ocpi-Token") || req.get("X-Token");
  if (!authHeader) {
    return res.status(200).json(ocpiResponse(null, 2001, "Authorization header required (Token <token>)"));
  }

  const tokenInHeader = extractTokenFromHeader(authHeader);
  if (!tokenInHeader) {
    return res.status(200).json(ocpiResponse(null, 2001, "Invalid Authorization token format"));
  }

  try {
    const profile = await resolveConnectionProfileByToken(tokenInHeader);
    if (!profile) {
      // Check if fallback to global simulator token works
      const activeLocal = state.localToken || CONFIG.localToken;
      const activeBoot = state.bootstrapToken || CONFIG.inboundBootstrapToken;
      const valid = [activeLocal, activeBoot].filter(Boolean);
      let matched = valid.some((vt) => {
        if (tokenInHeader === vt) return true;
        try {
          return Buffer.from(tokenInHeader, "base64").toString("utf8") === vt;
        } catch (_) {
          return false;
        }
      });

      if (!matched) {
        return res.status(200).json(ocpiResponse(null, 2001, "Unauthorized token"));
      }

      // If matched global token, try to find or create a default EMSP profile
      let defaultProfile = await OcpiConnectionProfile.findOne({ simulatorRole: "EMSP" }).sort({ updatedAt: -1 });
      if (!defaultProfile) {
        defaultProfile = new OcpiConnectionProfile({
          name: "Default External CPO Connection",
          simulatorRole: "EMSP",
          status: "CONNECTED",
          localToken: CONFIG.localToken,
          partnerRoles: [{ role: "CPO", country_code: "IN", party_id: "CZS" }],
        });
        await defaultProfile.save();
      }
      req.connectionProfile = defaultProfile;
      req.connectionProfileId = defaultProfile._id;
      return next();
    }

    req.connectionProfile = profile;
    req.connectionProfileId = profile._id;
    return next();
  } catch (err) {
    console.error("[validateEmspAuth] Error verifying token:", err.message);
    return res.status(200).json(ocpiResponse(null, 3000, "Internal error authenticating token: " + err.message));
  }
}

/**
 * Perform OCPI 2.2.1 Handshake specifically for an external CPO connection profile.
 * Creates/updates OcpiConnectionProfile and stores endpoints in OcpiEndpoint mapped to profileId.
 */
async function performEmspHandshake({
  profileId,
  connectionName,
  partnerVersionsUrl,
  bootstrapToken,
  countryCode = "IN",
  partyId = "CZS",
  businessName = "ChargeZone eMSP",
}) {
  if (!partnerVersionsUrl || !bootstrapToken) {
    throw new Error("Partner Versions URL and bootstrap token are required.");
  }

  const cleanCountry = (countryCode || "IN").toUpperCase().trim();
  const cleanParty = (partyId || "CZS").toUpperCase().trim();

  if (!/^[A-Z]{2}$/.test(cleanCountry)) {
    throw new Error("Country code must be exactly 2 uppercase letters.");
  }
  if (!/^[A-Z]{3}$/.test(cleanParty)) {
    throw new Error("Party ID must be exactly 3 uppercase letters.");
  }

  const correlationId = crypto.randomUUID();
  log("EMSP handshake started with external CPO", { partnerVersionsUrl, role: "EMSP" });

  // 1. Retrieve CPO Versions endpoint
  const versionsResult = await trackedRequest("GET", partnerVersionsUrl.trim(), {
    headers: requestHeaders(bootstrapToken.trim(), correlationId),
    timeout: 15000,
  });
  const versions = unwrapOcpiResponse(versionsResult);
  if (!Array.isArray(versions)) {
    throw new Error("Partner returned an invalid versions list; expected array.");
  }

  // 2. Retrieve Version Details for OCPI 2.2.1
  const selectedVersion = versions.find((v) => v.version === "2.2.1" || v.version === "2.2");
  if (!selectedVersion?.url) {
    throw new Error("Partner does not advertise OCPI 2.2.1 or 2.2.");
  }

  const detailsResult = await trackedRequest("GET", selectedVersion.url, {
    headers: requestHeaders(bootstrapToken.trim(), correlationId),
    timeout: 15000,
  });
  const details = unwrapOcpiResponse(detailsResult);
  const endpoints = details.endpoints || [];

  // 3. Find credentials endpoint
  const credentialsEndpoint = endpoints.find(
    (item) => item.identifier === "credentials" && (item.role === "RECEIVER" || !item.role)
  ) || endpoints.find((item) => item.identifier === "credentials");

  if (!credentialsEndpoint?.url) {
    throw new Error("Partner credentials endpoint was not found in version details.");
  }

  // 4. Exchange credentials (EMSP registers with CPO)
  const registrationToken = CONFIG.localToken || `emsp-token-${crypto.randomBytes(8).toString("hex")}`;
  const registrationResult = await trackedRequest(
    "POST",
    credentialsEndpoint.url,
    {
      headers: requestHeaders(bootstrapToken.trim(), correlationId),
      timeout: 15000,
    },
    {
      token: registrationToken,
      url: `${CONFIG.baseUrl}/ocpi/versions`,
      roles: [
        {
          role: "EMSP",
          party_id: cleanParty,
          country_code: cleanCountry,
          business_details: { name: businessName || "eMSP Participant" },
        },
      ],
    }
  );

  const remoteCredentials = unwrapOcpiResponse(registrationResult);
  if (
    !remoteCredentials ||
    typeof remoteCredentials.token !== "string" ||
    !remoteCredentials.token ||
    typeof remoteCredentials.url !== "string"
  ) {
    throw new Error("Partner returned invalid credentials object.");
  }

  const partnerRoles = Array.isArray(remoteCredentials.roles) && remoteCredentials.roles.length > 0
    ? remoteCredentials.roles
    : [{ role: "CPO", country_code: cleanCountry, party_id: cleanParty }];

  // 5. Store / update OcpiConnectionProfile
  let profile = null;
  if (profileId && mongoose.isValidObjectId(profileId)) {
    profile = await OcpiConnectionProfile.findById(profileId);
  }

  const partnerName = partnerRoles[0]?.business_details?.name ||
    connectionName ||
    `CPO (${partnerRoles[0]?.country_code || cleanCountry}/${partnerRoles[0]?.party_id || cleanParty})`;

  if (!profile) {
    profile = new OcpiConnectionProfile({
      name: connectionName || partnerName,
      simulatorRole: "EMSP",
      connectionMode: "HANDSHAKE",
      bootstrapToken: bootstrapToken.trim(),
    });
  } else {
    if (connectionName) profile.name = connectionName;
  }

  const locationsEndpoint = endpoints.find(
    (item) => item.identifier === "locations" && (item.role === "SENDER" || !item.role)
  );

  profile.simulatorRole = "EMSP";
  profile.connectionMode = "HANDSHAKE";
  profile.status = "CONNECTED";
  profile.partnerRoles = partnerRoles;
  profile.remoteToken = remoteCredentials.token;
  profile.localToken = registrationToken;
  profile.remoteVersionsUrl = remoteCredentials.url || partnerVersionsUrl;
  profile.remoteCredentialsUrl = credentialsEndpoint.url;
  profile.partnerLocationsUrl = locationsEndpoint?.url || null;
  profile.lastError = null;
  profile.lastHandshakeAt = new Date();
  await profile.save();

  // 6. Store discovered version doc
  let versionDoc = await OcpiVersion.findOne({ profileId: profile._id, version: CONFIG.version });
  if (!versionDoc) {
    versionDoc = new OcpiVersion({
      profileId: profile._id,
      version: CONFIG.version,
      versionsUrl: remoteCredentials.url || partnerVersionsUrl,
      discoveryStatus: "DISCOVERED",
      source: "DISCOVERED",
      enabled: true,
    });
  } else {
    versionDoc.versionsUrl = remoteCredentials.url || partnerVersionsUrl;
    versionDoc.discoveryStatus = "DISCOVERED";
  }
  await versionDoc.save();

  // 7. Store discovered endpoints scoped strictly by profileId
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

  // If partner is dual-role (advertises both CPO and EMSP roles), also create/sync complementary CPO profile
  const hasCpoRole = partnerRoles.some((r) => String(r.role).toUpperCase() === "CPO");
  const hasEmspRole = partnerRoles.some((r) => String(r.role).toUpperCase() === "EMSP");
  if (hasCpoRole && hasEmspRole) {
    const cpoLocationsEndpoint = endpoints.find(
      (item) => item.identifier === "locations" && (item.role === "RECEIVER" || !item.role)
    );
    let cpoProfile = await OcpiConnectionProfile.findOne({
      remoteVersionsUrl: remoteCredentials.url || partnerVersionsUrl,
      simulatorRole: "CPO",
    });
    if (!cpoProfile) {
      cpoProfile = new OcpiConnectionProfile({
        name: `${partnerName} (as CPO ➔ Partner eMSP)`,
        simulatorRole: "CPO",
        connectionMode: "HANDSHAKE",
        bootstrapToken: bootstrapToken.trim(),
      });
    }
    cpoProfile.status = "CONNECTED";
    cpoProfile.partnerRoles = partnerRoles;
    cpoProfile.remoteToken = remoteCredentials.token;
    cpoProfile.localToken = registrationToken;
    cpoProfile.remoteVersionsUrl = remoteCredentials.url || partnerVersionsUrl;
    cpoProfile.remoteCredentialsUrl = credentialsEndpoint.url;
    cpoProfile.partnerLocationsUrl = cpoLocationsEndpoint?.url || null;
    cpoProfile.lastError = null;
    cpoProfile.lastHandshakeAt = new Date();
    await cpoProfile.save();

    let cpoVersionDoc = await OcpiVersion.findOne({ profileId: cpoProfile._id, version: CONFIG.version });
    if (!cpoVersionDoc) {
      cpoVersionDoc = new OcpiVersion({
        profileId: cpoProfile._id,
        version: CONFIG.version,
        versionsUrl: remoteCredentials.url || partnerVersionsUrl,
        discoveryStatus: "DISCOVERED",
        source: "DISCOVERED",
        enabled: true,
      });
    } else {
      cpoVersionDoc.versionsUrl = remoteCredentials.url || partnerVersionsUrl;
      cpoVersionDoc.discoveryStatus = "DISCOVERED";
    }
    await cpoVersionDoc.save();

    for (const ep of endpoints) {
      await OcpiEndpoint.findOneAndUpdate(
        { profileId: cpoProfile._id, identifier: ep.identifier, role: ep.role },
        {
          profileId: cpoProfile._id,
          versionId: cpoVersionDoc._id,
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

  // Update in-memory state
  state.activeProfileId = String(profile._id);
  state.status = "CONNECTED";
  state.remoteToken = remoteCredentials.token;
  state.localToken = registrationToken;
  state.partnerRoles = partnerRoles;
  state.partnerEndpoints = endpoints;
  state.partnerLocationsUrl = locationsEndpoint?.url || null;

  log("EMSP handshake completed successfully", {
    profileId: String(profile._id),
    partnerRoles,
    endpointsCount: endpoints.length,
  });

  return {
    status: "CONNECTED",
    profileId: String(profile._id),
    connectionName: profile.name,
    role: "EMSP",
    partnerRoles,
    endpointsCount: endpoints.length,
    remoteToken: remoteCredentials.token,
    localToken: registrationToken,
    partnerLocationsUrl: state.partnerLocationsUrl,
    message: "Handshake completed successfully.",
  };
}

/**
 * Pull Tariffs from discovered CPO Tariffs endpoint for given profileId.
 * Stores / updates tariffs in ocpiEmspTariffs scoped by connectionProfileId.
 */
async function pullTariffsFromCpo(profileId) {
  if (!profileId) throw new Error("profileId is required to pull tariffs.");
  if (isDeletionInProgress(profileId)) {
    throw new Error("Operation blocked: Connection profile deletion is in progress.");
  }

  const profile = await OcpiConnectionProfile.findById(profileId);
  if (!profile) throw new Error(`Connection profile not found: ${profileId}`);

  if (!profile.remoteToken) {
    throw new Error("No remote credentials token found on this connection profile.");
  }

  // Find Tariffs SENDER endpoint
  const ep = await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "tariffs",
    role: "SENDER",
  }) || await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "tariffs",
  });

  if (!ep?.url) {
    throw new Error("Partner does not advertise a Tariffs SENDER endpoint for this connection.");
  }

  const correlationId = crypto.randomUUID();
  const result = await trackedRequest("GET", ep.url, {
    headers: {
      ...requestHeaders(profile.remoteToken, correlationId),
      "X-Limit": "100",
    },
    timeout: 20000,
  });

  const data = unwrapOcpiResponse(result);
  const tariffs = Array.isArray(data) ? data : (data ? [data] : []);

  const partner = profile.partnerRoles?.[0] || {};
  const partnerCountry = partner.country_code || "IN";
  const partnerParty = partner.party_id || "CZS";

  const savedTariffs = [];
  for (const t of tariffs) {
    if (!t.id) continue;
    const country_code = (t.country_code || partnerCountry).toUpperCase().trim();
    const party_id = (t.party_id || partnerParty).toUpperCase().trim();
    const tariffId = String(t.id).trim();

    const updatedDoc = await OcpiEmspTariff.findOneAndUpdate(
      {
        connectionProfileId: profile._id,
        country_code,
        party_id,
        id: tariffId,
      },
      {
        $set: {
          connectionProfileId: profile._id,
          country_code,
          party_id,
          id: tariffId,
          currency: (t.currency || "EUR").toUpperCase(),
          type: t.type || "REGULAR",
          tariff_alt_text: t.tariff_alt_text || [],
          tariff_alt_url: t.tariff_alt_url || null,
          min_price: t.min_price || null,
          max_price: t.max_price || null,
          start_date_time: t.start_date_time || null,
          end_date_time: t.end_date_time || null,
          elements: t.elements || [],
          price_summary: t.price_summary || "",
          rawPayload: t,
          last_updated: t.last_updated || new Date().toISOString(),
        },
      },
      { upsert: true, new: true }
    );
    savedTariffs.push(updatedDoc);
  }

  log(`Pulled ${savedTariffs.length} tariffs from CPO`, {
    profileId: String(profile._id),
    endpoint: ep.url,
  });

  return {
    endpoint: ep.url,
    count: savedTariffs.length,
    tariffs: savedTariffs,
  };
}

/**
 * Pull Locations from discovered CPO Locations endpoint for given profileId.
 * Stores / updates locations with nested EVSEs & Connectors in ocpiEmspLocations.
 */
async function pullLocationsFromCpo(profileId) {
  if (!profileId) throw new Error("profileId is required to pull locations.");
  if (isDeletionInProgress(profileId)) {
    throw new Error("Operation blocked: Connection profile deletion is in progress.");
  }

  const profile = await OcpiConnectionProfile.findById(profileId);
  if (!profile) throw new Error(`Connection profile not found: ${profileId}`);

  if (!profile.remoteToken) {
    throw new Error("No remote credentials token found on this connection profile.");
  }

  // Find Locations SENDER endpoint
  const ep = await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "locations",
    role: "SENDER",
  }) || await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "locations",
  });

  if (!ep?.url) {
    throw new Error("Partner does not advertise a Locations SENDER endpoint for this connection.");
  }

  const correlationId = crypto.randomUUID();
  const result = await trackedRequest("GET", ep.url, {
    headers: {
      ...requestHeaders(profile.remoteToken, correlationId),
      "X-Limit": "100",
    },
    timeout: 20000,
  });

  const data = unwrapOcpiResponse(result);
  const locations = Array.isArray(data) ? data : (data ? [data] : []);

  const partner = profile.partnerRoles?.[0] || {};
  const partnerCountry = partner.country_code || "IN";
  const partnerParty = partner.party_id || "CZS";

  const savedLocations = [];
  for (const loc of locations) {
    if (!loc.id) continue;
    const country_code = (loc.country_code || partnerCountry).toUpperCase().trim();
    const party_id = (loc.party_id || partnerParty).toUpperCase().trim();
    const locationId = String(loc.id).trim();

    const coordinates = loc.coordinates || { latitude: "0.0", longitude: "0.0" };

    const updatedDoc = await OcpiEmspLocation.findOneAndUpdate(
      {
        connectionProfileId: profile._id,
        country_code,
        party_id,
        id: locationId,
      },
      {
        $set: {
          connectionProfileId: profile._id,
          country_code,
          party_id,
          id: locationId,
          name: loc.name || null,
          address: loc.address || "",
          city: loc.city || "",
          postal_code: loc.postal_code || null,
          state: loc.state || null,
          country: loc.country || country_code,
          coordinates,
          related_locations: loc.related_locations || [],
          parking_type: loc.parking_type || null,
          evses: Array.isArray(loc.evses) ? loc.evses : [],
          directions: loc.directions || [],
          operator: loc.operator || null,
          suboperator: loc.suboperator || null,
          owner: loc.owner || null,
          facilities: loc.facilities || [],
          time_zone: loc.time_zone || "UTC",
          opening_times: loc.opening_times || null,
          charging_when_closed: loc.charging_when_closed ?? true,
          images: loc.images || [],
          energy_mix: loc.energy_mix || null,
          rawPayload: loc,
          last_updated: loc.last_updated || new Date().toISOString(),
        },
      },
      { upsert: true, new: true }
    );
    savedLocations.push(updatedDoc);
  }

  log(`Pulled ${savedLocations.length} locations from CPO`, {
    profileId: String(profile._id),
    endpoint: ep.url,
  });

  return {
    endpoint: ep.url,
    count: savedLocations.length,
    locations: savedLocations,
    pagination: {
      link: result.headers?.link || null,
      xTotalCount: result.headers?.["x-total-count"] || null,
      xLimit: result.headers?.["x-limit"] || null,
    },
  };
}

/**
 * Send START_SESSION command to CPO Commands RECEIVER endpoint.
 */
async function sendStartSessionCommand({
  profileId,
  locationId,
  evseUid,
  connectorId,
  token,
}) {
  if (!profileId) throw new Error("profileId is required.");
  if (isDeletionInProgress(profileId)) {
    throw new Error("Operation blocked: Connection profile deletion is in progress.");
  }
  if (!locationId || !evseUid) throw new Error("locationId and evseUid are required.");

  const profile = await OcpiConnectionProfile.findById(profileId);
  if (!profile) throw new Error(`Connection profile not found: ${profileId}`);

  if (!profile.remoteToken) {
    throw new Error("No remote credentials token found on this connection profile.");
  }

  // Find Commands RECEIVER endpoint
  const ep = await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "commands",
    role: "RECEIVER",
  }) || await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "commands",
  });

  if (!ep?.url) {
    throw new Error("Partner does not advertise a Commands endpoint for this connection.");
  }

  const baseCommandsUrl = ep.url.replace(/\/+$/, "");
  const targetUrl = baseCommandsUrl.endsWith("/START_SESSION")
    ? baseCommandsUrl
    : `${baseCommandsUrl}/START_SESSION`;

  const commandUid = crypto.randomUUID();
  const responseUrl = `${CONFIG.baseUrl}/ocpi/emsp/2.2.1/commands/START_SESSION/${commandUid}`;

  const partner = profile.partnerRoles?.[0] || {};
  const partnerCountry = partner.country_code || "IN";
  const partnerParty = partner.party_id || "CZS";

  const sessionToken = token || {
    country_code: partnerCountry,
    party_id: partnerParty,
    uid: "TOK-998877",
    type: "RFID",
    contract_id: `${partnerParty}-CONTRACT-001`,
  };

  const payload = {
    response_url: responseUrl,
    token: sessionToken,
    location_id: locationId,
    evse_uid: evseUid,
    ...(connectorId ? { connector_id: connectorId } : {}),
    authorization_reference: `AUTH-${Date.now()}`,
  };

  const correlationId = crypto.randomUUID();
  log("EMSP sending START_SESSION command to CPO", { targetUrl, payload });

  const result = await trackedRequest(
    "POST",
    targetUrl,
    {
      headers: requestHeaders(profile.remoteToken, correlationId),
      timeout: 15000,
    },
    payload
  );

  const commandResponse = unwrapOcpiResponse(result);

  return {
    success: true,
    targetUrl,
    command: "START_SESSION",
    commandResponse,
  };
}

/**
 * Send STOP_SESSION command to CPO Commands RECEIVER endpoint.
 */
async function sendStopSessionCommand({ profileId, sessionId }) {
  if (!profileId) throw new Error("profileId is required.");
  if (isDeletionInProgress(profileId)) {
    throw new Error("Operation blocked: Connection profile deletion is in progress.");
  }
  if (!sessionId) throw new Error("sessionId is required.");

  const profile = await OcpiConnectionProfile.findById(profileId);
  if (!profile) throw new Error(`Connection profile not found: ${profileId}`);

  if (!profile.remoteToken) {
    throw new Error("No remote credentials token found on this connection profile.");
  }

  const ep = await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "commands",
    role: "RECEIVER",
  }) || await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "commands",
  });

  if (!ep?.url) {
    throw new Error("Partner does not advertise a Commands endpoint for this connection.");
  }

  const baseCommandsUrl = ep.url.replace(/\/+$/, "");
  const targetUrl = baseCommandsUrl.endsWith("/STOP_SESSION")
    ? baseCommandsUrl
    : `${baseCommandsUrl}/STOP_SESSION`;

  const commandUid = crypto.randomUUID();
  const responseUrl = `${CONFIG.baseUrl}/ocpi/emsp/2.2.1/commands/STOP_SESSION/${commandUid}`;

  const payload = {
    response_url: responseUrl,
    session_id: sessionId,
  };

  const correlationId = crypto.randomUUID();
  log("EMSP sending STOP_SESSION command to CPO", { targetUrl, payload });

  const result = await trackedRequest(
    "POST",
    targetUrl,
    {
      headers: requestHeaders(profile.remoteToken, correlationId),
      timeout: 15000,
    },
    payload
  );

  const commandResponse = unwrapOcpiResponse(result);

  return {
    success: true,
    targetUrl,
    command: "STOP_SESSION",
    commandResponse,
  };
}

/**
 * Permanently delete an EMSP handshake and clean up all scoped data:
 * - ocpiConnectionProfiles
 * - ocpiEndpoints
 * - ocpiVersions
 * - ocpiEmspTariffs
 * - ocpiEmspLocations (nested EVSEs & Connectors)
 * - ocpiEmspSessions
 * - ocpiEmspCdrs
 * - ocpiApiLogs
 * - In-memory tokens, cached endpoints, active state, and memory logs
 */
async function deleteEmspHandshake(connectionProfileId) {
  if (!connectionProfileId || !mongoose.isValidObjectId(connectionProfileId)) {
    throw new Error("Invalid connectionProfileId.");
  }

  const profileIdStr = String(connectionProfileId);
  if (deletionsInProgress.has(profileIdStr)) {
    throw new Error("Deletion is already in progress for this connection profile.");
  }

  deletionsInProgress.add(profileIdStr);

  try {
    const profile = await OcpiConnectionProfile.findById(connectionProfileId);
    if (!profile) {
      throw new Error(`Connection profile not found: ${connectionProfileId}`);
    }

    const connectionName = profile.name || "CPO Connection";

    // Attempt MongoDB multi-document transaction where supported (e.g. replica sets)
    let session = null;
    let useTransaction = false;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
      useTransaction = true;
    } catch (_) {
      if (session) {
        try { session.endSession(); } catch (_) {}
        session = null;
      }
      useTransaction = false;
    }

    try {
      const opts = useTransaction ? { session } : {};

      // 1. Delete connection profile from ocpiConnectionProfiles
      await OcpiConnectionProfile.deleteOne({ _id: connectionProfileId }, opts);

      // 2. Delete all endpoints from ocpiEndpoints
      await OcpiEndpoint.deleteMany({ profileId: connectionProfileId }, opts);

      // 3. Delete version details from ocpiVersions
      await OcpiVersion.deleteMany({ profileId: connectionProfileId }, opts);

      // 4. Delete tariffs from ocpiEmspTariffs
      await OcpiEmspTariff.deleteMany({ connectionProfileId: connectionProfileId }, opts);

      // 5. Delete locations & nested EVSEs/connectors from ocpiEmspLocations
      await OcpiEmspLocation.deleteMany({ connectionProfileId: connectionProfileId }, opts);

      // 6. Delete sessions from ocpiEmspSessions
      await OcpiEmspSession.deleteMany({ connectionProfileId: connectionProfileId }, opts);

      // 7. Delete CDRs from ocpiEmspCdrs
      await OcpiEmspCdr.deleteMany({ connectionProfileId: connectionProfileId }, opts);

      // 8. Delete API logs associated with this profile from ocpiApiLogs
      await OcpiApiLog.deleteMany({ profileId: connectionProfileId }, opts);

      if (useTransaction && session) {
        await session.commitTransaction();
      }
    } catch (execErr) {
      if (useTransaction && session) {
        try { await session.abortTransaction(); } catch (_) {}
      }
      throw execErr;
    } finally {
      if (session) {
        try { session.endSession(); } catch (_) {}
      }
    }

    // 9. Clean up in-memory references and state
    if (state.activeProfileId === profileIdStr) {
      state.activeProfileId = null;
      state.status = "DISCONNECTED";
      state.remoteToken = null;
      state.partnerRoles = [];
      state.partnerEndpoints = [];
      state.partnerLocationsUrl = null;
      state.remoteVersionsUrl = null;
      state.remoteCredentialsUrl = null;
      state.lastError = null;

      // Restore next available EMSP profile if one exists
      const nextProfile = await OcpiConnectionProfile.findOne({ simulatorRole: "EMSP" }).sort({ updatedAt: -1 });
      if (nextProfile) {
        await restoreStateFromDb(nextProfile._id);
      }
    }

    // 10. Clean up in-memory logs
    const memLogs = getMemoryLogs();
    for (let i = memLogs.length - 1; i >= 0; i--) {
      if (String(memLogs[i].profileId) === profileIdStr) {
        memLogs.splice(i, 1);
      }
    }
    try {
      const { clearSimulationOperations } = require("./sessionSimulationService");
      if (typeof clearSimulationOperations === "function") {
        clearSimulationOperations();
      }
    } catch (_) {}

    log(`Permanently deleted EMSP handshake and all associated data for profile: ${profileIdStr} (${connectionName})`);

    return {
      success: true,
      deletedProfileId: profileIdStr,
      connectionName,
      message: `Handshake '${connectionName}' and all associated endpoints, tariffs, locations, sessions, CDRs, and logs have been permanently deleted.`,
      nextActiveProfileId: state.activeProfileId || null,
    };
  } finally {
    deletionsInProgress.delete(profileIdStr);
  }
}

module.exports = {
  extractTokenFromHeader,
  resolveConnectionProfileByToken,
  validateEmspAuth,
  performEmspHandshake,
  pullTariffsFromCpo,
  pullLocationsFromCpo,
  sendStartSessionCommand,
  sendStopSessionCommand,
  deleteEmspHandshake,
  isDeletionInProgress,
};

