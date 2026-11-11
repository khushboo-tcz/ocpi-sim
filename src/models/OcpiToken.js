const mongoose = require("mongoose");

const ocpiTokenSchema = new mongoose.Schema(
  {
    country_code: { type: String, required: true, uppercase: true, trim: true },
    party_id: { type: String, required: true, uppercase: true, trim: true },
    uid: { type: String, required: true, trim: true, index: true },
    type: {
      type: String,
      enum: ["OTHER", "RFID", "APP_USER"],
      default: "RFID",
    },
    contract_id: { type: String, required: true, trim: true },
    visual_number: { type: String, default: null },
    issuer: { type: String, required: true },
    group_id: { type: String, default: null },
    valid: { type: Boolean, default: true },
    whitelist: {
      type: String,
      enum: ["ALWAYS", "ALLOWED", "ALLOWED_OFFLINE", "NEVER"],
      default: "ALWAYS",
    },
    language: { type: String, default: "en" },
    default_profile_type: {
      type: String,
      enum: ["CHEAP", "FAST", "GREEN", "REGULAR"],
      default: "REGULAR",
    },
    energy_contract: { type: mongoose.Schema.Types.Mixed, default: null },
    last_updated: { type: String, required: true },
  },
  {
    collection: "ocpiTokens",
    timestamps: true,
  }
);

ocpiTokenSchema.index({ country_code: 1, party_id: 1, uid: 1 }, { unique: true });
ocpiTokenSchema.index({ uid: 1, valid: 1 });

module.exports = mongoose.model("OcpiToken", ocpiTokenSchema);
