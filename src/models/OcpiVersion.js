const crypto = require("node:crypto");
const mongoose = require("mongoose");

const ocpiVersionSchema = new mongoose.Schema(
  {
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OcpiConnectionProfile",
      default: null,
      index: true,
    },
    version: {
      type: String,
      required: true,
      trim: true,
      default: "2.2.1",
    },
    versionsUrl: {
      type: String,
      trim: true,
      default: null,
    },
    versionDetailsUrl: {
      type: String,
      trim: true,
      default: null,
    },
    discoveryStatus: {
      type: String,
      enum: ["PENDING", "DISCOVERED", "FAILED"],
      default: "PENDING",
    },
    source: {
      type: String,
      enum: ["MANUAL", "DISCOVERED"],
      default: "DISCOVERED",
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  {
    collection: "ocpiVersions",
    timestamps: true,
  }
);

ocpiVersionSchema.index({ profileId: 1, version: 1 });
ocpiVersionSchema.index({ source: 1, enabled: 1 });

module.exports = mongoose.model("OcpiVersion", ocpiVersionSchema);
