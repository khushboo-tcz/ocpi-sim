const crypto = require("node:crypto");
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.randomUUID) {
  globalThis.crypto = crypto;
}
if (typeof global.crypto === "undefined") {
  global.crypto = crypto;
}

const OcpiApiLog = require("../models/OcpiApiLog");
const { getConnectionStatus, mongoose } = require("../db/connection");

const trafficLogsMemory = [];
const MAX_MEMORY_LOGS = 2000;

function redact(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => {
        // Never redact status messages, messages, errors, or descriptions
        if (/^(status_message|message|text|description|error|transportErrorMessage|reason|detail)$/i.test(key)) {
          return [key, val];
        }

        // Never redact OCPI Token objects or tokens arrays (e.g. RFID tokens with uid, contract_id)
        if (/^tokens?$/i.test(key) && typeof val === "object" && val !== null) {
          return [key, redact(val)];
        }

        // Only redact truly sensitive security credentials if present in a body
        if (/^(password|client_secret|private_key)$/i.test(key)) {
          return [key, "[REDACTED]"];
        }

        return [key, redact(val)];
      })
    );
  }
  // Normal string values (including status messages like "Token does not exist") should NOT be redacted
  return value;
}

function safeHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    // Only redact HTTP Authorization headers, proxy authorization, API keys, or session cookies
    result[key] = /^(authorization|proxy-authorization|x-api-key|cookie|set-cookie)$/i.test(key)
      ? "[REDACTED]"
      : value;
  }
  return result;
}

function detectModule(url = "") {
  const cleanUrl = url.toLowerCase().split("?")[0];
  const modules = [
    "credentials",
    "locations",
    "tariffs",
    "tokens",
    "sessions",
    "cdrs",
    "commands",
    "chargingprofiles",
    "hubclientinfo",
    "versions",
    "details",
  ];
  for (const mod of modules) {
    if (cleanUrl.includes(`/${mod}`) || cleanUrl.includes(`module=${mod}`)) {
      return mod === "details" ? "versions" : mod;
    }
  }
  if (cleanUrl.includes("/handshake")) return "credentials";
  return "ocpi";
}

function addMemoryLog(entry) {
  trafficLogsMemory.push(entry);
  if (trafficLogsMemory.length > MAX_MEMORY_LOGS) {
    trafficLogsMemory.splice(0, trafficLogsMemory.length - MAX_MEMORY_LOGS);
  }
}

async function recordTransaction(tx) {
  const reqObj = tx.request || {};
  const resObj = tx.response || null;
  const errObj = tx.error || null;
  const timestamp = tx.timestamp ? new Date(tx.timestamp) : new Date();
  const requestId = tx.requestId || crypto.randomUUID();
  const correlationId = tx.correlationId || null;
  const direction = (tx.direction || "OUTBOUND").toUpperCase();
  const simulatorRole = tx.simulatorRole || "EMSP";
  const url = reqObj.url || tx.url || "";
  const moduleName = tx.module || detectModule(url);
  const method = (reqObj.method || tx.method || "GET").toUpperCase();
  const durationMs = tx.durationMs !== undefined ? tx.durationMs : null;

  // Sanitize and redact request
  const sanitizedReq = {
    method,
    url,
    headers: safeHeaders(reqObj.headers || {}),
    body: redact(reqObj.body !== undefined ? reqObj.body : null),
  };

  // Sanitize and redact response (if present)
  let sanitizedRes = null;
  let httpStatus = null;
  let ocpiStatusCode = null;
  let ocpiStatusMessage = null;

  if (resObj) {
    httpStatus = typeof resObj.httpStatus === "number"
      ? resObj.httpStatus
      : (typeof resObj.status === "number" ? resObj.status : null);

    ocpiStatusCode = (resObj.body && typeof resObj.body === "object" && typeof resObj.body.status_code === "number")
      ? resObj.body.status_code
      : (typeof resObj.ocpiStatusCode === "number" ? resObj.ocpiStatusCode : null);

    ocpiStatusMessage = (resObj.body && typeof resObj.body === "object" && typeof resObj.body.status_message === "string")
      ? resObj.body.status_message
      : (resObj.ocpiStatusMessage || null);

    sanitizedRes = {
      httpStatus,
      headers: safeHeaders(resObj.headers || {}),
      body: redact(resObj.body !== undefined ? resObj.body : (resObj.data !== undefined ? resObj.data : null)),
      ocpiStatusCode,
      ocpiStatusMessage,
    };
  }

  // Sanitize error (if present)
  let sanitizedErr = null;
  if (errObj) {
    sanitizedErr = {
      code: errObj.code || (typeof errObj === "string" ? errObj : "ERROR"),
      message: errObj.message || (typeof errObj === "string" ? errObj : "Error occurred"),
    };
  }

  const transactionEntry = {
    id: tx.id || crypto.randomUUID(),
    time: timestamp.toISOString(),
    timestamp,
    direction,
    simulatorRole,
    module: moduleName,
    requestId,
    correlationId,
    durationMs,
    request: sanitizedReq,
    response: sanitizedRes,
    error: sanitizedErr,
    // Flattened compatibility fields
    type: "TRANSACTION",
    method,
    url,
    httpStatus,
    ocpiStatusCode,
    ocpiStatusMessage,
    transportErrorCode: sanitizedErr?.code || null,
    transportErrorMessage: sanitizedErr?.message || null,
    requestHeaders: sanitizedReq.headers,
    requestBody: sanitizedReq.body,
    responseHeaders: sanitizedRes?.headers || {},
    responseBody: sanitizedRes?.body ?? null,
    profileId: tx.profileId || null,
  };

  addMemoryLog(transactionEntry);

  try {
    if (mongoose.connection.readyState === 2) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        mongoose.connection.once("connected", () => {
          clearTimeout(timer);
          resolve();
        });
        mongoose.connection.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    if (mongoose.connection.readyState === 1) {
      const doc = await OcpiApiLog.create(transactionEntry);
      transactionEntry.id = doc._id.toString();
      return transactionEntry;
    }
  } catch (err) {
    console.error("[Logger] Failed to write transaction to MongoDB:", err.stack || err.message);
    throw err;
  }

  return transactionEntry;
}

// Backward-compatible wrapper
async function recordLog(entry) {
  if (entry.request || entry.response) {
    return recordTransaction(entry);
  }

  const isResponse = entry.type === "RESPONSE";
  const isError = entry.type === "ERROR";

  return recordTransaction({
    direction: entry.direction || "OUTBOUND",
    simulatorRole: entry.simulatorRole || "EMSP",
    module: entry.module || detectModule(entry.url),
    requestId: entry.requestId,
    correlationId: entry.correlationId,
    durationMs: entry.durationMs,
    request: {
      method: entry.method || "GET",
      url: entry.url || "",
      headers: entry.requestHeaders || entry.headers || {},
      body: entry.requestBody !== undefined ? entry.requestBody : (isResponse ? null : entry.body),
    },
    response: (isResponse || entry.httpStatus != null) ? {
      httpStatus: entry.httpStatus,
      headers: entry.responseHeaders || {},
      body: entry.responseBody !== undefined ? entry.responseBody : (isResponse ? entry.body : null),
      ocpiStatusCode: entry.ocpiStatus || entry.ocpiStatusCode,
      ocpiStatusMessage: entry.ocpiStatusMessage,
    } : null,
    error: (isError || entry.error) ? {
      code: entry.transportErrorCode || "ERROR",
      message: entry.error || entry.transportErrorMessage,
    } : null,
    profileId: entry.profileId,
  });
}

module.exports = {
  redact,
  safeHeaders,
  detectModule,
  recordTransaction,
  recordLog,
  getMemoryLogs: () => trafficLogsMemory,
  clearMemoryLogs: () => {
    trafficLogsMemory.length = 0;
  },
};
