const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { getConnectionStatus } = require("../db/connection");
const OcpiConnectionProfile = require("../models/OcpiConnectionProfile");
const OcpiEndpoint = require("../models/OcpiEndpoint");
const { OcpiLocation } = require("../models/OcpiLocation");
const OcpiTariff = require("../models/OcpiTariff");
const {
  toCleanOcpiLocation,
  toCleanOcpiTariff,
  memoryLocations,
  memoryTariffs,
} = require("./cpoLocationService");
const {
  CONFIG,
  state,
  simulator,
  trackedRequest,
  requestHeaders,
  log,
} = require("./simulatorState");

/**
 * Push CPO Location(s) directly to a connected partner eMSP Receiver endpoint.
 * OCPI 2.2.1: PUT {locations_receiver_url}/{country_code}/{party_id}/{location_id}
 */
async function pushLocationsToEmsp({ profileId = null, locationId = null } = {}) {
  // 1. Resolve CPO connection profile
  let profile = null;
  if (profileId && mongoose.isValidObjectId(profileId)) {
    profile = await OcpiConnectionProfile.findById(profileId);
  }
  if (!profile) {
    if (state.activeProfileId && mongoose.isValidObjectId(state.activeProfileId)) {
      const active = await OcpiConnectionProfile.findById(state.activeProfileId);
      if (active && active.simulatorRole === "CPO") {
        profile = active;
      }
    }
  }
  if (!profile) {
    profile = await OcpiConnectionProfile.findOne({ simulatorRole: "CPO", status: "CONNECTED" }).sort({ updatedAt: -1 });
  }
  if (!profile) {
    profile = await OcpiConnectionProfile.findOne({ simulatorRole: "CPO" }).sort({ updatedAt: -1 });
  }

  if (!profile) {
    throw new Error("No CPO connection profile found. Please create or connect a CPO handshake first.");
  }
  if (!profile.remoteToken) {
    throw new Error(`Connection profile '${profile.name}' has no remote credentials token.`);
  }

  // 2. Discover partner's eMSP Locations RECEIVER endpoint
  let ep = await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "locations",
    role: "RECEIVER",
  });
  if (!ep?.url) {
    ep = await OcpiEndpoint.findOne({
      profileId: profile._id,
      identifier: "locations",
    });
  }
  let locationsReceiverUrl = ep?.url || profile.partnerLocationsUrl;
  if (!locationsReceiverUrl) {
    throw new Error(`Partner '${profile.name}' does not advertise an eMSP Locations RECEIVER endpoint.`);
  }
  locationsReceiverUrl = locationsReceiverUrl.replace(/\/+$/, "");

  // Optional: Discover Tariffs RECEIVER endpoint to push associated tariffs
  let tariffsReceiverUrl = null;
  const tariffEp = await OcpiEndpoint.findOne({
    profileId: profile._id,
    identifier: "tariffs",
    role: "RECEIVER",
  });
  if (tariffEp?.url) {
    tariffsReceiverUrl = tariffEp.url.replace(/\/+$/, "");
  }

  // 3. Find locations to push from Location Builder inventory
  let locations = [];
  if (getConnectionStatus() === "CONNECTED") {
    const filter = {};
    if (locationId) {
      if (mongoose.isValidObjectId(locationId)) {
        filter.$or = [{ id: locationId }, { _id: locationId }];
      } else {
        filter.id = locationId;
      }
    }
    locations = await OcpiLocation.find(filter).lean();
  } else {
    if (locationId) {
      const loc = memoryLocations.get(locationId);
      if (loc) locations = [loc];
    } else {
      locations = Array.from(memoryLocations.values());
    }
  }

  if (!locations.length) {
    throw new Error(locationId ? `Location '${locationId}' not found.` : "No locations found in the Location Builder to push.");
  }

  // 4. Push each location
  const results = [];
  const pushedTariffs = new Set();

  for (const loc of locations) {
    const cleanLoc = toCleanOcpiLocation(loc);
    delete cleanLoc.connectionProfileId;

    const countryCode = cleanLoc.country_code || simulator.countryCode || "IN";
    const partyId = cleanLoc.party_id || simulator.partyId || "CZS";
    const locId = cleanLoc.id;

    // Push associated tariffs first if partner supports Tariffs RECEIVER
    if (tariffsReceiverUrl) {
      for (const evse of cleanLoc.evses || []) {
        for (const conn of evse.connectors || []) {
          for (const tId of conn.tariff_ids || []) {
            if (!pushedTariffs.has(tId)) {
              try {
                let tariffDoc = null;
                if (getConnectionStatus() === "CONNECTED") {
                  tariffDoc = await OcpiTariff.findOne({ id: tId }).lean();
                } else {
                  tariffDoc = memoryTariffs.get(tId);
                }
                if (tariffDoc) {
                  const cleanTariff = toCleanOcpiTariff(tariffDoc);
                  const tCountry = cleanTariff.country_code || countryCode;
                  const tParty = cleanTariff.party_id || partyId;
                  const tariffPutUrl = `${tariffsReceiverUrl}/${encodeURIComponent(tCountry)}/${encodeURIComponent(tParty)}/${encodeURIComponent(cleanTariff.id)}`;
                  const corrId = crypto.randomUUID();
                  await trackedRequest(
                    "PUT",
                    tariffPutUrl,
                    {
                      headers: requestHeaders(profile.remoteToken, corrId),
                      timeout: 15000,
                      profileId: profile._id,
                    },
                    cleanTariff
                  );
                  pushedTariffs.add(tId);
                }
              } catch (tErr) {
                console.warn(`[CPO Push] Push tariff '${tId}' warning:`, tErr.message);
              }
            }
          }
        }
      }
    }

    // Push location via PUT /locations/{country_code}/{party_id}/{location_id}
    const putUrl = `${locationsReceiverUrl}/${encodeURIComponent(countryCode)}/${encodeURIComponent(partyId)}/${encodeURIComponent(locId)}`;
    const correlationId = crypto.randomUUID();

    try {
      const res = await trackedRequest(
        "PUT",
        putUrl,
        {
          headers: requestHeaders(profile.remoteToken, correlationId),
          timeout: 15000,
          profileId: profile._id,
        },
        cleanLoc
      );

      results.push({
        locationId: locId,
        name: cleanLoc.name,
        countryCode,
        partyId,
        url: putUrl,
        httpStatus: res.status,
        status: res.status >= 200 && res.status < 300 ? "SUCCESS" : "ERROR",
        message: `Successfully pushed '${cleanLoc.name}' (${locId}) to eMSP (HTTP ${res.status})`,
      });
    } catch (pushErr) {
      const httpStatus = pushErr.response?.status || 500;
      const statusMessage = pushErr.response?.data?.status_message || pushErr.message;
      results.push({
        locationId: locId,
        name: cleanLoc.name,
        countryCode,
        partyId,
        url: putUrl,
        httpStatus,
        status: "ERROR",
        error: statusMessage,
        message: `Failed to push '${cleanLoc.name}' (${locId}): ${statusMessage}`,
      });
    }
  }

  const successCount = results.filter((r) => r.status === "SUCCESS").length;
  const failCount = results.filter((r) => r.status === "ERROR").length;

  log("CPO Push locations completed", {
    profileId: String(profile._id),
    connectionName: profile.name,
    total: locations.length,
    pushedCount: successCount,
    failedCount: failCount,
  });

  return {
    success: failCount === 0,
    total: locations.length,
    pushedCount: successCount,
    failedCount: failCount,
    profileId: String(profile._id),
    connectionName: profile.name,
    partnerName: profile.partnerRoles?.[0]?.business_details?.name || "Partner",
    locationsReceiverUrl,
    results,
  };
}

module.exports = {
  pushLocationsToEmsp,
};
