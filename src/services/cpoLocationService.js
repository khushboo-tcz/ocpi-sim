const crypto = require("node:crypto");
const { OcpiLocation } = require("../models/OcpiLocation");
const OcpiTariff = require("../models/OcpiTariff");
const { getConnectionStatus } = require("../db/connection");

// In-memory fallback caches if database is offline
const memoryLocations = new Map();
const memoryTariffs = new Map();

// Standard IANA Timezone validation helper
function isValidIanaTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch (err) {
    return false;
  }
}

// Recursively omit null and undefined fields from objects (OCPI optional fields omission)
function omitNulls(val) {
  if (val === null || val === undefined) return undefined;
  if (typeof val !== "object") return val;
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val)) {
    return val
      .map(omitNulls)
      .filter((item) => item !== undefined && item !== null);
  }
  const raw = val.toObject ? val.toObject() : val;
  const result = {};
  for (const [key, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    const cleaned = omitNulls(v);
    if (cleaned !== undefined && cleaned !== null) {
      if (typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) {
        continue;
      }
      result[key] = cleaned;
    }
  }
  return result;
}

// Power calculation & inconsistency warning helper
function checkPowerConsistency({ max_voltage, max_amperage, power_type, max_electric_power }) {
  if (!max_voltage || !max_amperage || !max_electric_power) {
    return { isConsistent: true, expectedPower: null, message: null };
  }

  const v = Number(max_voltage);
  const a = Number(max_amperage);
  const p = Number(max_electric_power);

  let expected = 0;
  if (power_type === "AC_3_PHASE") {
    // 3-phase power = sqrt(3) * V_line * I = ~1.732 * V * I (or 3 * 230 * 32 = ~22080W)
    expected = Math.round(Math.sqrt(3) * v * a);
  } else if (power_type === "DC") {
    expected = Math.round(v * a);
  } else {
    // AC 1-Phase / 2-Phase
    expected = Math.round(v * a);
  }

  // Allow 20% margin of difference (e.g. power factor or rounding)
  const margin = expected * 0.25;
  const isConsistent = Math.abs(p - expected) <= margin;

  if (!isConsistent) {
    return {
      isConsistent: false,
      expectedPower: expected,
      message: `Expected ~${expected.toLocaleString()} W for ${v}V / ${a}A (${power_type}), but entered ${p.toLocaleString()} W.`,
    };
  }

  return { isConsistent: true, expectedPower: expected, message: null };
}

// Clean internal fields to return pure OCPI 2.2.1 payload
function toCleanOcpiLocation(loc) {
  if (!loc) return null;
  const raw = loc.toObject ? loc.toObject() : JSON.parse(JSON.stringify(loc));
  
  delete raw._id;
  delete raw.__v;
  delete raw.createdAt;
  delete raw.updatedAt;

  // Ensure Location-level coordinates are clean strings
  if (raw.coordinates) {
    if (raw.coordinates.latitude !== undefined && raw.coordinates.latitude !== null) {
      raw.coordinates.latitude = String(raw.coordinates.latitude);
    }
    if (raw.coordinates.longitude !== undefined && raw.coordinates.longitude !== null) {
      raw.coordinates.longitude = String(raw.coordinates.longitude);
    }
  }

  if (Array.isArray(raw.evses)) {
    raw.evses = raw.evses.map(evse => {
      delete evse._id;
      if (Array.isArray(evse.connectors)) {
        evse.connectors = evse.connectors.map(c => {
          delete c._id;
          return c;
        });
      }

      // If EVSE coordinates are missing or null, inherit from Location coordinates
      if (!evse.coordinates || !evse.coordinates.latitude || !evse.coordinates.longitude) {
        if (raw.coordinates && raw.coordinates.latitude && raw.coordinates.longitude) {
          evse.coordinates = {
            latitude: String(raw.coordinates.latitude),
            longitude: String(raw.coordinates.longitude)
          };
        } else {
          delete evse.coordinates;
        }
      } else {
        evse.coordinates = {
          latitude: String(evse.coordinates.latitude),
          longitude: String(evse.coordinates.longitude)
        };
      }

      return evse;
    });
  }

  return omitNulls(raw);
}

function toCleanOcpiTariff(tariff) {
  if (!tariff) return null;
  const raw = tariff.toObject ? tariff.toObject() : JSON.parse(JSON.stringify(tariff));
  
  delete raw._id;
  delete raw.__v;
  delete raw.createdAt;
  delete raw.updatedAt;
  delete raw.price_summary;

  return omitNulls(raw);
}

// Format human-readable price summary for a tariff
function formatPriceSummary(tariff) {
  if (!tariff || !Array.isArray(tariff.elements) || !tariff.elements.length) {
    return "Custom Tariff";
  }

  const currencySymbol = tariff.currency === "INR" ? "₹" : (tariff.currency === "EUR" ? "€" : (tariff.currency === "USD" ? "$" : `${tariff.currency} `));
  const parts = [];

  for (const elem of tariff.elements) {
    for (const comp of (elem.price_components || [])) {
      if (comp.type === "ENERGY") {
        parts.push(`${currencySymbol}${comp.price}/kWh`);
      } else if (comp.type === "TIME") {
        if (comp.step_size <= 60) {
          parts.push(`${currencySymbol}${comp.price}/min`);
        } else {
          parts.push(`${currencySymbol}${comp.price}/hr`);
        }
      } else if (comp.type === "FLAT") {
        parts.push(`${currencySymbol}${comp.price} session fee`);
      } else if (comp.type === "PARKING_TIME") {
        parts.push(`${currencySymbol}${comp.price}/hr parking`);
      }
    }
  }

  return parts.join(" + ") || "Free Charging";
}

// Full OCPI 2.2.1 Location Validation
function validateLocationPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["Location payload must be a JSON object"] };
  }

  // Location Required Fields
  if (!payload.name || typeof payload.name !== "string" || !payload.name.trim()) {
    errors.push("Location Name is required.");
  }
  if (!payload.address || typeof payload.address !== "string" || !payload.address.trim()) {
    errors.push("Street Address is required.");
  }
  if (!payload.city || typeof payload.city !== "string" || !payload.city.trim()) {
    errors.push("City is required.");
  }
  if (!payload.country || typeof payload.country !== "string" || !/^[A-Z]{3}$/.test(payload.country.trim().toUpperCase())) {
    errors.push("Country must be a 3-letter ISO 3166-1 alpha-3 code (e.g. IND, DEU, USA).");
  }
  if (!payload.country_code || typeof payload.country_code !== "string" || !/^[A-Z]{2}$/.test(payload.country_code.trim().toUpperCase())) {
    errors.push("CPO Country Code must be a 2-letter ISO 3166-1 alpha-2 code (e.g. IN, DE).");
  }
  if (!payload.party_id || typeof payload.party_id !== "string" || !/^[A-Z0-9]{3}$/.test(payload.party_id.trim().toUpperCase())) {
    errors.push("CPO Party ID must be exactly 3 characters (e.g. CZK, CZS).");
  }
  if (!payload.time_zone || !isValidIanaTimeZone(payload.time_zone)) {
    errors.push(`Time Zone '${payload.time_zone}' is not a valid IANA time zone (e.g. Asia/Kolkata, Europe/Berlin).`);
  }

  // Coordinates
  const lat = Number(payload.coordinates?.latitude);
  const lon = Number(payload.coordinates?.longitude);
  if (isNaN(lat) || lat < -90 || lat > 90) {
    errors.push("Latitude must be a valid number between -90 and 90.");
  }
  if (isNaN(lon) || lon < -180 || lon > 180) {
    errors.push("Longitude must be a valid number between -180 and 180.");
  }

  // EVSEs
  if (!Array.isArray(payload.evses) || payload.evses.length === 0) {
    errors.push("At least one EVSE is required.");
  } else {
    const evseUids = new Set();
    payload.evses.forEach((evse, evseIdx) => {
      const evseLabel = `EVSE #${evseIdx + 1}`;
      if (!evse.uid || typeof evse.uid !== "string" || !evse.uid.trim()) {
        errors.push(`${evseLabel}: uid is required.`);
      } else if (evseUids.has(evse.uid.trim())) {
        errors.push(`${evseLabel}: duplicate uid '${evse.uid}'. Each EVSE UID must be unique.`);
      } else {
        evseUids.add(evse.uid.trim());
      }

      if (!evse.status) {
        errors.push(`${evseLabel}: status is required.`);
      }

      // Connectors
      if (!Array.isArray(evse.connectors) || evse.connectors.length === 0) {
        errors.push(`${evseLabel}: must contain at least one connector.`);
      } else {
        const connIds = new Set();
        evse.connectors.forEach((conn, connIdx) => {
          const connLabel = `${evseLabel} Connector #${connIdx + 1}`;
          if (!conn.id || typeof conn.id !== "string" || !conn.id.trim()) {
            errors.push(`${connLabel}: id is required.`);
          } else if (connIds.has(conn.id.trim())) {
            errors.push(`${connLabel}: duplicate id '${conn.id}' within EVSE.`);
          } else {
            connIds.add(conn.id.trim());
          }

          if (!conn.standard) errors.push(`${connLabel}: standard is required.`);
          if (!conn.format) errors.push(`${connLabel}: format is required.`);
          if (!conn.power_type) errors.push(`${connLabel}: power_type is required.`);

          const v = Number(conn.max_voltage);
          const a = Number(conn.max_amperage);
          if (isNaN(v) || v <= 0) errors.push(`${connLabel}: max_voltage must be a positive integer.`);
          if (isNaN(a) || a <= 0) errors.push(`${connLabel}: max_amperage must be a positive integer.`);
          if (conn.max_electric_power !== null && conn.max_electric_power !== undefined) {
            const p = Number(conn.max_electric_power);
            if (isNaN(p) || p < 0) errors.push(`${connLabel}: max_electric_power must be a non-negative integer.`);
          }
        });
      }
    });
  }

  return {
    valid: errors.length === 0,
    isValid: errors.length === 0,
    errors,
  };
}

// Seed default tariff if none exist
async function ensureDefaultTariff(countryCode = "IN", partyId = "CZK") {
  try {
    if (getConnectionStatus() === "CONNECTED") {
      const existing = await OcpiTariff.findOne({ id: "TAR-STANDARD-IN" });
      if (!existing) {
        const defaultTariff = new OcpiTariff({
          country_code: countryCode,
          party_id: partyId,
          id: "TAR-STANDARD-IN",
          currency: "INR",
          type: "REGULAR",
          tariff_alt_text: [{ language: "en", text: "Standard Fast Charging Tariff" }],
          elements: [
            {
              price_components: [
                { type: "ENERGY", price: 12.0, step_size: 1000 },
                { type: "TIME", price: 2.0, step_size: 60 },
                { type: "FLAT", price: 10.0, step_size: 1 },
              ],
            },
          ],
          price_summary: "₹12/kWh + ₹2/min + ₹10 session fee",
          last_updated: new Date().toISOString(),
        });
        await defaultTariff.save();
        console.log("[Tariff] Seeded default tariff: TAR-STANDARD-IN");
      }
    } else {
      if (!memoryTariffs.has("TAR-STANDARD-IN")) {
        memoryTariffs.set("TAR-STANDARD-IN", {
          country_code: countryCode,
          party_id: partyId,
          id: "TAR-STANDARD-IN",
          currency: "INR",
          type: "REGULAR",
          tariff_alt_text: [{ language: "en", text: "Standard Fast Charging Tariff" }],
          elements: [
            {
              price_components: [
                { type: "ENERGY", price: 12.0, step_size: 1000 },
                { type: "TIME", price: 2.0, step_size: 60 },
                { type: "FLAT", price: 10.0, step_size: 1 },
              ],
            },
          ],
          price_summary: "₹12/kWh + ₹2/min + ₹10 session fee",
          last_updated: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error("[Tariff] Error ensuring default tariff:", err.message);
  }
}

module.exports = {
  isValidIanaTimeZone,
  checkPowerConsistency,
  omitNulls,
  toCleanOcpiLocation,
  toCleanOcpiTariff,
  formatPriceSummary,
  validateLocationPayload,
  ensureDefaultTariff,
  memoryLocations,
  memoryTariffs,
};
