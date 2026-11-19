const mongoose = require("mongoose");

const ocpiEmspTariffSchema = new mongoose.Schema(
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
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },
    party_id: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    },
    id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 36,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      default: "EUR",
      minlength: 3,
      maxlength: 3,
    },
    type: {
      type: String,
      enum: ["REGULAR", "PROFILE_CHEAP", "PROFILE_FAST", "PROFILE_GREEN"],
      default: "REGULAR",
    },
    tariff_alt_text: [
      {
        language: { type: String, default: "en" },
        text: { type: String, required: true },
        _id: false,
      },
    ],
    tariff_alt_url: {
      type: String,
      default: null,
    },
    min_price: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    max_price: {
      excl_vat: { type: Number, default: null },
      incl_vat: { type: Number, default: null },
    },
    start_date_time: {
      type: String,
      default: null,
    },
    end_date_time: {
      type: String,
      default: null,
    },
    elements: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    price_summary: {
      type: String,
      default: "",
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
    collection: "ocpiEmspTariffs",
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual aliases for camelCase compatibility
ocpiEmspTariffSchema.virtual("tariffId")
  .get(function () { return this.id; })
  .set(function (v) { this.id = v; });

ocpiEmspTariffSchema.virtual("countryCode")
  .get(function () { return this.country_code; })
  .set(function (v) { this.country_code = v; });

ocpiEmspTariffSchema.virtual("partyId")
  .get(function () { return this.party_id; })
  .set(function (v) { this.party_id = v; });

// Compound unique index ensuring isolation per connectionProfileId
ocpiEmspTariffSchema.index(
  { connectionProfileId: 1, country_code: 1, party_id: 1, id: 1 },
  { unique: true }
);
ocpiEmspTariffSchema.index({ connectionProfileId: 1, last_updated: -1 });

module.exports = mongoose.model("OcpiEmspTariff", ocpiEmspTariffSchema);

