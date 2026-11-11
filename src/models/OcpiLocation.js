const mongoose = require("mongoose");

const connectorTypeEnum = [
  "CHADEMO",
  "CHAOJI",
  "DOMESTIC_A",
  "DOMESTIC_B",
  "DOMESTIC_C",
  "DOMESTIC_D",
  "DOMESTIC_E",
  "DOMESTIC_F",
  "DOMESTIC_G",
  "DOMESTIC_H",
  "DOMESTIC_I",
  "DOMESTIC_J",
  "DOMESTIC_K",
  "DOMESTIC_L",
  "DOMESTIC_M",
  "DOMESTIC_N",
  "DOMESTIC_O",
  "GBT_AC",
  "GBT_DC",
  "IEC_60309_2_single_16",
  "IEC_60309_2_three_16",
  "IEC_60309_2_three_32",
  "IEC_60309_2_three_64",
  "IEC_62196_T1",
  "IEC_62196_T1_COMBO",
  "IEC_62196_T2",
  "IEC_62196_T2_COMBO",
  "IEC_62196_T3A",
  "IEC_62196_T3C",
  "PANTOGRAPH_HIGH_VIEW",
  "PANTOGRAPH_BOTTOM_UP",
  "TESLA_R",
  "TESLA_S",
];

const connectorFormatEnum = ["SOCKET", "CABLE"];
const powerTypeEnum = ["AC_1_PHASE", "AC_2_PHASE", "AC_2_PHASE_SPLIT", "AC_3_PHASE", "DC"];

const evseStatusEnum = [
  "AVAILABLE",
  "BLOCKED",
  "CHARGING",
  "INOPERATIVE",
  "OUTOFORDER",
  "PLANNED",
  "REMOVED",
  "RESERVED",
  "UNKNOWN",
];

const parkingTypeEnum = [
  "ALONG_MOTORWAY",
  "PARKING_GARAGE",
  "PARKING_LOT",
  "ON_DRIVEWAY",
  "ON_STREET",
  "UNDERGROUND_GARAGE",
];

const evseCapabilityEnum = [
  "CHARGING_PROFILE_CAPABLE",
  "CHARGING_PREFERENCES_CAPABLE",
  "CHIP_CARD_SUPPORT",
  "CONTACTLESS_CARD_SUPPORT",
  "CREDIT_CARD_PAYABLE",
  "DEBIT_CARD_PAYABLE",
  "PED_TERMINAL",
  "REMOTE_START_STOP_CAPABLE",
  "RESERVABLE",
  "RFID_READER",
  "START_SESSION_CONNECTOR_REQUIRED",
  "TOKEN_GROUP_CAPABLE",
  "UNLOCK_CAPABLE",
];

const parkingRestrictionEnum = [
  "EV_ONLY",
  "PLUGGED",
  "DISABLED",
  "CUSTOMERS",
  "MOTORCYCLES",
];

// Connector Schema
const connectorSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 36,
    },
    standard: {
      type: String,
      enum: connectorTypeEnum,
      required: true,
      default: "IEC_62196_T2",
    },
    format: {
      type: String,
      enum: connectorFormatEnum,
      required: true,
      default: "SOCKET",
    },
    power_type: {
      type: String,
      enum: powerTypeEnum,
      required: true,
      default: "AC_3_PHASE",
    },
    max_voltage: {
      type: Number,
      required: true,
      min: 1,
    },
    max_amperage: {
      type: Number,
      required: true,
      min: 1,
    },
    max_electric_power: {
      type: Number,
      min: 0,
      default: null,
    },
    tariff_ids: [
      {
        type: String,
        trim: true,
      },
    ],
    terms_and_conditions: {
      type: String,
      default: null,
    },
    last_updated: {
      type: String,
      required: true,
      default: () => new Date().toISOString(),
    },
  },
  { _id: false }
);

// EVSE Schema
const evseSchema = new mongoose.Schema(
  {
    uid: {
      type: String,
      required: true,
      trim: true,
      maxlength: 36,
    },
    evse_id: {
      type: String,
      trim: true,
      maxlength: 48,
      default: null,
    },
    status: {
      type: String,
      enum: evseStatusEnum,
      required: true,
      default: "AVAILABLE",
    },
    capabilities: [
      {
        type: String,
        enum: evseCapabilityEnum,
      },
    ],
    connectors: {
      type: [connectorSchema],
      required: true,
      validate: [val => Array.isArray(val) && val.length > 0, "Each EVSE must have at least one connector"],
    },
    floor_level: {
      type: String,
      maxlength: 4,
      default: null,
    },
    physical_reference: {
      type: String,
      maxlength: 16,
      default: null,
    },
    parking_restrictions: [
      {
        type: String,
        enum: parkingRestrictionEnum,
      },
    ],
    coordinates: {
      type: {
        latitude: { type: String, trim: true },
        longitude: { type: String, trim: true },
      },
      _id: false,
      required: false,
    },
    last_updated: {
      type: String,
      required: true,
      default: () => new Date().toISOString(),
    },
  },
  { _id: false }
);

// Location Schema
const ocpiLocationSchema = new mongoose.Schema(
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
    publish: {
      type: Boolean,
      required: true,
      default: true,
    },
    publish_allowed_to: {
      type: Array,
      default: [],
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    address: {
      type: String,
      required: true,
      trim: true,
      maxlength: 45,
    },
    city: {
      type: String,
      required: true,
      trim: true,
      maxlength: 45,
    },
    postal_code: {
      type: String,
      trim: true,
      maxlength: 10,
      default: null,
    },
    state: {
      type: String,
      trim: true,
      maxlength: 20,
      default: null,
    },
    country: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3, // ISO 3166-1 alpha-3 e.g. IND, DEU, NLD, USA
    },
    coordinates: {
      latitude: {
        type: String,
        required: true,
        trim: true,
      },
      longitude: {
        type: String,
        required: true,
        trim: true,
      },
    },
    parking_type: {
      type: String,
      enum: [...parkingTypeEnum, null],
      default: null,
    },
    evses: {
      type: [evseSchema],
      required: true,
      validate: [val => Array.isArray(val) && val.length > 0, "Location must contain at least one EVSE"],
    },
    operator: {
      name: { type: String, trim: true, default: null },
      website: { type: String, trim: true, default: null },
    },
    time_zone: {
      type: String,
      required: true,
      trim: true,
      default: "Asia/Kolkata",
    },
    opening_times: {
      twentyfourseven: { type: Boolean, default: true },
      regular_hours: { type: Array, default: [] },
    },
    last_updated: {
      type: String,
      required: true,
      default: () => new Date().toISOString(),
    },
  },
  {
    collection: "ocpiLocations",
    timestamps: true,
  }
);

ocpiLocationSchema.index({ country_code: 1, party_id: 1, id: 1 }, { unique: true });
ocpiLocationSchema.index({ last_updated: -1 });

module.exports = {
  OcpiLocation: mongoose.model("OcpiLocation", ocpiLocationSchema),
  connectorTypeEnum,
  connectorFormatEnum,
  powerTypeEnum,
  evseStatusEnum,
  parkingTypeEnum,
  evseCapabilityEnum,
  parkingRestrictionEnum,
};
