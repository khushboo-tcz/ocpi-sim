const crypto = require("node:crypto");
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.randomUUID) {
  globalThis.crypto = crypto;
}
if (typeof global.crypto === "undefined") {
  global.crypto = crypto;
}

const mongoose = require("mongoose");

let isConnecting = false;

async function connectDb(uri) {
  const mongoUri = uri || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/ocpi_simulator";

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (isConnecting) {
    return new Promise((resolve, reject) => {
      mongoose.connection.once("connected", () => resolve(mongoose.connection));
      mongoose.connection.once("error", reject);
    });
  }

  isConnecting = true;

  try {
    mongoose.connection.on("connected", () => {
      console.log(`[MongoDB] Connected successfully to: ${mongoUri.replace(/\/\/([^:]+):([^@]+)@/, "//***:***@")}`);
    });

    mongoose.connection.on("error", (err) => {
      console.error("[MongoDB] Connection error:", err.message);
    });

    mongoose.connection.on("disconnected", () => {
      console.log("[MongoDB] Disconnected.");
    });

    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      autoIndex: true,
    });

    isConnecting = false;
    return mongoose.connection;
  } catch (err) {
    isConnecting = false;
    console.error("[MongoDB] Failed to connect on initial startup:", err.message);
    // Do not crash the entire process, so simulator can still run or reconnect
    return null;
  }
}

async function disconnectDb() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log("[MongoDB] Cleanly disconnected.");
  }
}

function getConnectionStatus() {
  const states = {
    0: "DISCONNECTED",
    1: "CONNECTED",
    2: "CONNECTING",
    3: "DISCONNECTING",
  };
  return states[mongoose.connection.readyState] || "UNKNOWN";
}

// Clean shutdown listeners
process.on("SIGINT", async () => {
  await disconnectDb();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await disconnectDb();
  process.exit(0);
});

module.exports = {
  connectDb,
  disconnectDb,
  getConnectionStatus,
  mongoose,
};
