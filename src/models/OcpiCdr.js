const mongoose = require("mongoose");

const ocpiCdrSchema = new mongoose.Schema(
  {
    country_code: { type: String, required: true, uppercase: true, trim: true },
    party_id: { type: String, required: true, uppercase: true, trim: true },
    id: { type: String, required: true, trim: true, index: true },
    start_date_time: { type: String, required: true },
    stop_date_time: { type: String, default: null },
    end_date_time: { type: String, default: null },
    session_id: { type: String, default: null },
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
    cdr_location: { type: mongoose.Schema.Types.Mixed, default: {} },
    meter_id: { type: String, default: null },
    currency: { type: String, default: "EUR", uppercase: true },
    tariffs: { type: [mongoose.Schema.Types.Mixed], default: [] },
    charging_periods: { type: [mongoose.Schema.Types.Mixed], default: [] },
    total_cost: {
      excl_vat: { type: Number, default: 0 },
      incl_vat: { type: Number, default: 0 },
    },
    total_fixed_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    total_energy: { type: Number, default: 0 },
    total_energy_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    total_time: { type: Number, default: 0 },
    total_time_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    total_parking_time: { type: Number, default: null },
    total_parking_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    remark: { type: String, default: null },
    invoice_reference_id: { type: String, default: null },
    credit: { type: Boolean, default: false },
    credit_reference_id: { type: String, default: null },
    last_updated: { type: String, required: true },
  },
  {
    collection: "ocpiCdrs",
    timestamps: true,
  }
);

ocpiCdrSchema.index({ country_code: 1, party_id: 1, id: 1 }, { unique: true });
ocpiCdrSchema.index({ last_updated: -1 });

module.exports = mongoose.model("OcpiCdr", ocpiCdrSchema);
