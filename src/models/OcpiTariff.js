const mongoose = require("mongoose");

const priceComponentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["ENERGY", "FLAT", "PARKING_TIME", "TIME"],
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    vat: {
      type: Number,
      min: 0,
      max: 100,
      default: null,
    },
    step_size: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { _id: false }
);

const tariffElementSchema = new mongoose.Schema(
  {
    price_components: {
      type: [priceComponentSchema],
      required: true,
      validate: [val => Array.isArray(val) && val.length > 0, "At least one price component is required"],
    },
    restrictions: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { _id: false }
);

const ocpiTariffSchema = new mongoose.Schema(
  {
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
      unique: true,
      maxlength: 36,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      default: "INR",
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
    elements: {
      type: [tariffElementSchema],
      required: true,
      validate: [val => Array.isArray(val) && val.length > 0, "At least one tariff element is required"],
    },
    price_summary: {
      type: String,
      default: "",
    },
    last_updated: {
      type: String,
      required: true,
      default: () => new Date().toISOString(),
    },
  },
  {
    collection: "ocpiTariffs",
    timestamps: true,
  }
);

ocpiTariffSchema.index({ country_code: 1, party_id: 1, id: 1 }, { unique: true });

module.exports = mongoose.model("OcpiTariff", ocpiTariffSchema);
