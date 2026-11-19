const mongoose = require("mongoose");

const ocpiEmspSessionSchema = new mongoose.Schema(
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
    end_date_time: {
      type: String,
      default: null,
    },
    kwh: {
      type: Number,
      default: 0,
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
    location_id: {
      type: String,
      default: null,
    },
    evse_uid: {
      type: String,
      default: null,
    },
    connector_id: {
      type: String,
      default: null,
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
    charging_periods: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    total_cost: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    status: {
      type: String,
      enum: ["ACTIVE", "COMPLETED", "INVALID", "PENDING", "RESERVED"],
      default: "ACTIVE",
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
    collection: "ocpiEmspSessions",
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual aliases for camelCase compatibility
ocpiEmspSessionSchema.virtual("sessionId")
  .get(function () { return this.id; })
  .set(function (v) { this.id = v; });

ocpiEmspSessionSchema.virtual("countryCode")
  .get(function () { return this.country_code; })
  .set(function (v) { this.country_code = v; });

ocpiEmspSessionSchema.virtual("partyId")
  .get(function () { return this.party_id; })
  .set(function (v) { this.party_id = v; });

// Compound unique index ensuring isolation per connectionProfileId
ocpiEmspSessionSchema.index(
  { connectionProfileId: 1, country_code: 1, party_id: 1, id: 1 },
  { unique: true }
);
ocpiEmspSessionSchema.index({ connectionProfileId: 1, status: 1 });
ocpiEmspSessionSchema.index({ connectionProfileId: 1, last_updated: -1 });

module.exports = mongoose.model("OcpiEmspSession", ocpiEmspSessionSchema);

