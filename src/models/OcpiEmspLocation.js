const mongoose = require("mongoose");

const ocpiEmspLocationSchema = new mongoose.Schema(
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
    name: {
      type: String,
      trim: true,
      default: null,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    postal_code: {
      type: String,
      trim: true,
      default: null,
    },
    state: {
      type: String,
      trim: true,
      default: null,
    },
    country: {
      type: String,
      required: true,
      trim: true,
    },
    coordinates: {
      latitude: { type: String, required: true },
      longitude: { type: String, required: true },
    },
    related_locations: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    parking_type: {
      type: String,
      default: null,
    },
    evses: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    directions: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    operator: {
      name: { type: String, trim: true, default: null },
      website: { type: String, trim: true, default: null },
    },
    suboperator: {
      name: { type: String, trim: true, default: null },
      website: { type: String, trim: true, default: null },
    },
    owner: {
      name: { type: String, trim: true, default: null },
      website: { type: String, trim: true, default: null },
    },
    facilities: {
      type: [String],
      default: [],
    },
    time_zone: {
      type: String,
      default: "UTC",
    },
    opening_times: {
      twentyfourseven: { type: Boolean, default: true },
      regular_hours: { type: Array, default: [] },
    },
    charging_when_closed: {
      type: Boolean,
      default: true,
    },
    images: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    energy_mix: {
      type: mongoose.Schema.Types.Mixed,
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
    collection: "ocpiEmspLocations",
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual aliases for camelCase compatibility
ocpiEmspLocationSchema.virtual("locationId")
  .get(function () { return this.id; })
  .set(function (v) { this.id = v; });

ocpiEmspLocationSchema.virtual("countryCode")
  .get(function () { return this.country_code; })
  .set(function (v) { this.country_code = v; });

ocpiEmspLocationSchema.virtual("partyId")
  .get(function () { return this.party_id; })
  .set(function (v) { this.party_id = v; });

// Compound unique index ensuring isolation per connectionProfileId
ocpiEmspLocationSchema.index(
  { connectionProfileId: 1, country_code: 1, party_id: 1, id: 1 },
  { unique: true }
);
ocpiEmspLocationSchema.index({ connectionProfileId: 1, last_updated: -1 });

module.exports = mongoose.model("OcpiEmspLocation", ocpiEmspLocationSchema);

