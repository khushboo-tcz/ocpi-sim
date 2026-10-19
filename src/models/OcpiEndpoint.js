const crypto = require("node:crypto");
const mongoose = require("mongoose");

const ocpiEndpointSchema = new mongoose.Schema(
  {
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OcpiConnectionProfile",
      default: null,
      index: true,
    },
    versionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OcpiVersion",
      default: null,
      index: true,
    },
    identifier: {
      type: String,
      required: true,
      trim: true,
      // e.g. credentials, locations, tariffs, tokens, sessions, cdrs, commands, chargingprofiles, hubclientinfo
    },
    role: {
      type: String,
      enum: ["SENDER", "RECEIVER"],
      required: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    supportedMethods: [
      {
        type: String,
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
    ],
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
    collection: "ocpiEndpoints",
    timestamps: true,
  }
);

ocpiEndpointSchema.index({ profileId: 1, identifier: 1, role: 1 });
ocpiEndpointSchema.index({ versionId: 1 });

module.exports = mongoose.model("OcpiEndpoint", ocpiEndpointSchema);
