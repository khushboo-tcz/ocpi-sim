require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb, disconnectDb } = require("../src/db/connection");
const OcpiConnectionProfile = require("../src/models/OcpiConnectionProfile");
const OcpiVersion = require("../src/models/OcpiVersion");
const OcpiEndpoint = require("../src/models/OcpiEndpoint");

// Pass the partner token via command line argument or environment variable:
// e.g. node scripts/seed-chargecloud.js "your-actual-chargecloud-token"
const partnerToken = process.argv[2] || process.env.CHARGECLOUD_TOKEN || "your-chargecloud-remote-token";
const localToken = process.env.OCPI_LOCAL_TOKEN || "sim-local-token-" + Date.now();

const chargecloudEndpoints = [
  { identifier: "credentials", role: "RECEIVER", url: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/credentials/" },
  { identifier: "credentials", role: "SENDER", url: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/credentials" },
  { identifier: "locations", role: "SENDER", url: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/locations/" },
  { identifier: "locations", role: "RECEIVER", url: "https://uat-api.chargecloud.net/ocpi/emsp/2.2/locations" },
  { identifier: "tokens", role: "RECEIVER", url: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/tokens/" },
  { identifier: "tokens", role: "SENDER", url: "https://uat-api.chargecloud.net/ocpi/emsp/2.2/tokens/" },
  { identifier: "sessions", role: "SENDER", url: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/sessions" },
  { identifier: "sessions", role: "RECEIVER", url: "https://uat-api.chargecloud.net/ocpi/emsp/2.2/sessions" },
  { identifier: "cdrs", role: "SENDER", url: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/cdrs" },
  { identifier: "cdrs", role: "RECEIVER", url: "https://uat-api.chargecloud.net/ocpi/emsp/2.2/cdrs" },
  { identifier: "tariffs", role: "SENDER", url: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/tariffs/" },
  { identifier: "tariffs", role: "RECEIVER", url: "https://uat-api.chargecloud.net/ocpi/emsp/2.2/tariffs" },
  { identifier: "commands", role: "RECEIVER", url: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/commands" }
];

async function seedRole(role) {
  console.log(`\n--- Seeding profile for Simulator Role: ${role} ---`);

  const partnerLocationsUrl =
    role === "EMSP"
      ? "https://uat-api.chargecloud.net/ocpi/cpo/2.2/locations/" // eMSP pulls locations from Chargecloud CPO
      : "https://uat-api.chargecloud.net/ocpi/emsp/2.2/locations"; // CPO pushes locations to Chargecloud eMSP

  const partnerRoles = [
    {
      role: role === "EMSP" ? "CPO" : "EMSP",
      party_id: "CCL",
      country_code: "DE",
      business_details: { name: "ChargeCloud UAT" }
    }
  ];

  // 1. Connection Profile
  const profile = await OcpiConnectionProfile.findOneAndUpdate(
    { simulatorRole: role },
    {
      name: `ChargeCloud UAT (${role})`,
      simulatorRole: role,
      connectionMode: "HANDSHAKE",
      status: "CONNECTED",
      remoteToken: partnerToken,
      localToken: localToken,
      remoteVersionsUrl: "https://uat-api.chargecloud.net/ocpi/versions/2.2",
      remoteCredentialsUrl: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/credentials/",
      partnerLocationsUrl,
      partnerRoles,
      lastError: null,
      lastHandshakeAt: new Date()
    },
    { upsert: true, returnDocument: 'after' }
  );
  console.log(`✔ Profile for [${role}] saved in 'ocpiConnectionProfiles' with ID:`, profile._id);

  // 2. Version Document
  const versionDoc = await OcpiVersion.findOneAndUpdate(
    { profileId: profile._id, version: "2.2.1" },
    {
      profileId: profile._id,
      version: "2.2.1",
      versionsUrl: "https://uat-api.chargecloud.net/ocpi/versions/2.2",
      versionDetailsUrl: "https://uat-api.chargecloud.net/ocpi/versions/2.2",
      discoveryStatus: "DISCOVERED",
      source: "DISCOVERED",
      enabled: true
    },
    { upsert: true, returnDocument: 'after' }
  );
  console.log(`✔ Version for [${role}] saved in 'ocpiVersions' with ID:`, versionDoc._id);

  // 3. Endpoints
  console.log(`Upserting ${chargecloudEndpoints.length} endpoints for [${role}]...`);
  for (const ep of chargecloudEndpoints) {
    await OcpiEndpoint.findOneAndUpdate(
      { profileId: profile._id, identifier: ep.identifier, role: ep.role },
      {
        profileId: profile._id,
        versionId: versionDoc._id,
        identifier: ep.identifier,
        role: ep.role,
        url: ep.url,
        source: "DISCOVERED",
        enabled: true
      },
      { upsert: true, returnDocument: 'after' }
    );
  }
  console.log(`✔ Endpoints for [${role}] saved in 'ocpiEndpoints'.`);
}

async function seed() {
  console.log("Connecting to MongoDB...");
  const conn = await connectDb();
  if (!conn) {
    console.error("Could not connect to MongoDB. Check MONGODB_URI in your .env");
    process.exit(1);
  }

  // Seed both EMSP and CPO roles
  await seedRole("EMSP");
  await seedRole("CPO");

  console.log("\n========================================================");
  console.log("✔ ChargeCloud handshake state configured for BOTH eMSP & CPO!");
  console.log(`Remote Token: ${partnerToken}`);
  console.log(`eMSP partner locations URL: https://uat-api.chargecloud.net/ocpi/cpo/2.2/locations/`);
  console.log(`CPO partner locations URL:  https://uat-api.chargecloud.net/ocpi/emsp/2.2/locations`);
  console.log("Whichever role the simulator is in (eMSP or CPO), it will be CONNECTED!");
  console.log("========================================================");

  await disconnectDb();
}

seed().catch((err) => {
  console.error("Error seeding handshake:", err);
  process.exit(1);
});
