const mongoose = require("mongoose");

const ocpiSessionSchema = new mongoose.Schema(
  {
    country_code: { type: String, required: true, uppercase: true, trim: true },
    party_id: { type: String, required: true, uppercase: true, trim: true },
    id: { type: String, required: true, trim: true, index: true },
    start_date_time: { type: String, required: true },
    end_date_time: { type: String, default: null },
    kwh: { type: Number, default: 0 },
    cdr_token: {
      country_code: { type: String, uppercase: true },
      party_id: { type: String, uppercase: true },
      uid: { type: String },
      type: { type: String, default: "RFID" },
      contract_id: { type: String },
    },
    auth_method: {
      type: String,
      enum: ["AUTH_REQUEST", "COMMAND", "WHITELIST"],
      default: "AUTH_REQUEST",
    },
    authorization_reference: { type: String, default: null },
    location_id: { type: String, required: true },
    evse_uid: { type: String, required: true },
    connector_id: { type: String, required: true },
    meter_id: { type: String, default: null },
    currency: { type: String, default: "EUR", uppercase: true },
    charging_periods: { type: [mongoose.Schema.Types.Mixed], default: [] },
    total_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    status: {
      type: String,
      enum: ["ACTIVE", "COMPLETED", "INVALID", "PENDING", "RESERVED"],
      default: "ACTIVE",
    },
    last_updated: { type: String, required: true },
  },
  {
    collection: "ocpiSessions",
    timestamps: true,
  }
);

ocpiSessionSchema.index({ country_code: 1, party_id: 1, id: 1 }, { unique: true });
ocpiSessionSchema.index({ status: 1 });
ocpiSessionSchema.index({ last_updated: -1 });

module.exports = mongoose.model("OcpiSession", ocpiSessionSchema);
