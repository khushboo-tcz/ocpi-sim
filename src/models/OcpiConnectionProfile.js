const crypto = require("node:crypto");
const mongoose = require("mongoose");

const ocpiRoleSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["CPO", "EMSP", "HUB", "NAP", "NSP", "OTHER", "SCSP"], required: true },
    party_id: { type: String, required: true },
    country_code: { type: String, required: true },
    business_details: {
      name: { type: String },
      website: { type: String },
      logo: {
        url: { type: String },
        thumbnail: { type: String },
        category: { type: String },
        type: { type: String },
        width: { type: Number },
        height: { type: Number },
      },
    },
  },
  { _id: false }
);

const ocpiConnectionProfileSchema = new mongoose.Schema(
  {
    name: { type: String, default: "Default Partner" },
    simulatorRole: { type: String, enum: ["CPO", "EMSP"], default: "EMSP", required: true },
    connectionMode: {
      type: String,
      enum: ["HANDSHAKE", "DIRECT_BYPASS"],
      default: "HANDSHAKE",
      required: true,
    },
    remoteToken: { type: String, default: null }, // Stored credentials token (decrypted/redacted in views)
    localToken: { type: String, default: null },
    remoteVersionsUrl: { type: String, default: null },
    remoteCredentialsUrl: { type: String, default: null },
    partnerLocationsUrl: { type: String, default: null },
    partnerRoles: [ocpiRoleSchema],
    status: {
      type: String,
      enum: ["DISCONNECTED", "CONNECTING", "CONNECTED", "ERROR"],
      default: "DISCONNECTED",
      required: true,
    },
    lastError: { type: String, default: null },
    lastHandshakeAt: { type: Date, default: null },
  },
  {
    collection: "ocpiConnectionProfiles",
    timestamps: true,
  }
);

ocpiConnectionProfileSchema.index({ simulatorRole: 1, status: 1 });
ocpiConnectionProfileSchema.index({ remoteVersionsUrl: 1 });

module.exports = mongoose.model("OcpiConnectionProfile", ocpiConnectionProfileSchema);
