const mongoose = require("mongoose");

const ocpiEmspCdrSchema = new mongoose.Schema(
  {
    connectionProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OcpiConnectionProfile",
      required: true,
      index: true,
    },
    country_code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 2,
      maxlength: 2,
    },
    party_id: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },
    id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 36,
    },
    start_date_time: {
      type: String,
      required: true,
    },
    stop_date_time: {
      type: String,
      default: null,
    },
    end_date_time: {
      type: String,
      default: null,
    },
    session_id: {
      type: String,
      default: null,
    },
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
      default: "COMMAND",
    },
    authorization_reference: {
      type: String,
      default: null,
    },
    cdr_location: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    meter_id: {
      type: String,
      default: null,
    },
    currency: {
      type: String,
      default: "EUR",
      uppercase: true,
    },
    tariffs: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    charging_periods: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    total_cost: {
      excl_vat: { type: Number, default: 0 },
      incl_vat: { type: Number, default: 0 },
    },
    total_fixed_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    total_energy: {
      type: Number,
      default: 0,
    },
    total_energy_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    total_time: {
      type: Number,
      default: 0,
    },
    total_time_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    total_parking_time: {
      type: Number,
      default: null,
    },
    total_parking_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    remark: {
      type: String,
      default: null,
    },
    invoice_reference_id: {
      type: String,
      default: null,
    },
    credit: {
      type: Boolean,
      default: false,
    },
    credit_reference_id: {
      type: String,
      default: null,
    },
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    last_updated: {
      type: String,
      required: true,
      default: () => new Date().toISOString(),
    },
  },
  {
    collection: "ocpiEmspCdrs",
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual aliases for camelCase compatibility
ocpiEmspCdrSchema.virtual("cdrId")
  .get(function () { return this.id; })
  .set(function (v) { this.id = v; });

ocpiEmspCdrSchema.virtual("countryCode")
  .get(function () { return this.country_code; })
  .set(function (v) { this.country_code = v; });

ocpiEmspCdrSchema.virtual("partyId")
  .get(function () { return this.party_id; })
  .set(function (v) { this.party_id = v; });

// Compound unique index ensuring isolation per connectionProfileId
ocpiEmspCdrSchema.index(
  { connectionProfileId: 1, country_code: 1, party_id: 1, id: 1 },
  { unique: true }
);
ocpiEmspCdrSchema.index({ connectionProfileId: 1, last_updated: -1 });

module.exports = mongoose.model("OcpiEmspCdr", ocpiEmspCdrSchema);

