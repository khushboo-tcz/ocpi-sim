const crypto = require("node:crypto");
const mongoose = require("mongoose");

const ocpiApiLogSchema = new mongoose.Schema(
  {
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OcpiConnectionProfile",
      default: null,
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
      required: true,
    },
    simulatorRole: {
      type: String,
      enum: ["CPO", "EMSP"],
      default: "EMSP",
      index: true,
    },
    direction: {
      type: String,
      enum: ["INBOUND", "OUTBOUND"],
      required: true,
      index: true,
    },
    module: {
      type: String,
      trim: true,
      default: "unknown",
      index: true,
    },
    durationMs: {
      type: Number,
      default: null,
    },
    requestId: {
      type: String,
      required: true,
      default: () => crypto.randomUUID(),
      index: true,
      trim: true,
    },
    correlationId: {
      type: String,
      default: null,
      index: true,
      trim: true,
    },

    // Clean, distinct request object
    request: {
      method: { type: String, uppercase: true, trim: true, default: "GET" },
      url: { type: String, trim: true, default: "" },
      headers: { type: mongoose.Schema.Types.Mixed, default: {} },
      body: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    // Clean, distinct response object (null if network failure)
    response: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Clean, distinct error object (null if no error)
    error: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Backward-compatible flat fields for existing queries/indexes and legacy documents
    type: {
      type: String,
      enum: ["TRANSACTION", "REQUEST", "RESPONSE", "ERROR"],
      default: "TRANSACTION",
    },
    method: {
      type: String,
      trim: true,
      uppercase: true,
    },
    url: {
      type: String,
      trim: true,
    },
    httpStatus: {
      type: Number,
      default: null,
      index: true,
    },
    ocpiStatusCode: {
      type: Number,
      default: null,
      index: true,
    },
    ocpiStatusMessage: {
      type: String,
      default: null,
    },
    transportErrorCode: {
      type: String,
      default: null,
    },
    transportErrorMessage: {
      type: String,
      default: null,
    },
    requestHeaders: {
      type: mongoose.Schema.Types.Mixed,
    },
    requestBody: {
      type: mongoose.Schema.Types.Mixed,
    },
    responseHeaders: {
      type: mongoose.Schema.Types.Mixed,
    },
    responseBody: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    collection: "ocpiApiLogs",
    timestamps: true,
  }
);

// Composite indexes for common query filters
ocpiApiLogSchema.index({ timestamp: -1, module: 1, direction: 1 });
ocpiApiLogSchema.index({ timestamp: -1, httpStatus: 1 });
ocpiApiLogSchema.index({ requestId: 1 });

module.exports = mongoose.model("OcpiApiLog", ocpiApiLogSchema);
