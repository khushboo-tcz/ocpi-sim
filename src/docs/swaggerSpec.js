/**
 * OpenAPI 3.0.3 Specification for OCPI 2.2.1 Test Simulator
 * Fully modularized and documented for CPO, eMSP, Core Protocols & UI Management.
 */

function getSwaggerSpec(config = {}, simulator = {}, state = {}) {
  const baseUrl = (config.baseUrl || "http://localhost:3000").replace(/\/+$/, "");
  const localToken = state.localToken || config.localToken || "simulator-local-token";
  const bootstrapToken = state.bootstrapToken || config.inboundBootstrapToken || "replace-with-inbound-bootstrap-token";
  const activeToken = state.status === "CONNECTED" ? localToken : bootstrapToken;

  const authHeaderParam = {
    name: "Authorization",
    in: "header",
    required: false,
    description: `OCPI 2.2.1 Token Authorization (format: \`Token <token>\`). Pre-authorized automatically in Swagger UI with active token: \`Token ${activeToken}\`.`,
    schema: {
      type: "string",
      default: `Token ${activeToken}`,
    },
    example: `Token ${activeToken}`,
  };

  const spec = {
    openapi: "3.0.3",
    security: [{ OcpiTokenAuth: [] }, { OcpiBearerAuth: [] }],
    info: {
      title: "OCPI 2.2.1 Simulator API",
      version: "2.2.1",
      description: `### Official OCPI 2.2.1 Protocol & Simulator Documentation

This OpenAPI document provides complete interactive testing for:
1. **OCPI Core & Version Discovery** (\`/ocpi/versions\`, \`/ocpi/2.2.1/details\`, \`/ocpi/2.2.1/credentials\`)
2. **OCPI CPO Endpoints** (\`/ocpi/cpo/2.2.1/...\` - Locations, Tariffs, Sessions, CDRs, Tokens, Commands, Charging Profiles)
3. **OCPI eMSP Endpoints** (\`/ocpi/emsp/2.2.1/...\` - Locations, Tariffs, Sessions, CDRs, Tokens, Commands, Charging Profiles)
4. **Simulator UI & Management APIs** (\`/api/...\` - Handshake, Outbound triggers, Builder CRUD, Traffic Logs)

---
#### 🔑 Authentication in OCPI
To call OCPI protocol endpoints, authenticate with header:
\`Authorization: Token <your_token>\`

- **Pre-Handshake Token (Bootstrap):** \`Token ${bootstrapToken}\`
- **Post-Handshake Token (Active):** \`Token ${localToken}\`
- **Currently Active for Inbound Calls:** \`Token ${activeToken}\`

**Authentication in this Swagger UI:**
1. **Automatic Pre-Authorization:** The active token (\`Token ${activeToken}\`) is automatically pre-authorized on page load. All requests via "Try it out" will automatically pass this Authorization header.
2. **Authorize 🔒 Button:** Click the green/blue button at the top to view, update, or change the token at any time.
3. **Header Parameter:** Each OCPI endpoint also documents the \`Authorization\` header parameter for client reference and OpenAPI code generators.
`,
      contact: {
        name: "OCPI Simulator Engine",
      },
    },
    servers: [
      {
        url: baseUrl,
        description: "Current Simulator Host",
      },
      {
        url: "/",
        description: "Relative URL (Same Origin)",
      },
    ],
    tags: [
      {
        name: "OCPI - Discovery & Credentials",
        description: "Core version discovery and bidirectional credentials exchange",
      },
      {
        name: "OCPI - CPO Locations (Sender)",
        description: "CPO Locations module: Locations, EVSEs, and Connectors catalog",
      },
      {
        name: "OCPI - CPO Tariffs (Sender)",
        description: "CPO Tariffs module: Pricing, energy, and parking rates",
      },
      {
        name: "OCPI - CPO Sessions (Sender)",
        description: "CPO Sessions module: Active charging sessions & driver preferences",
      },
      {
        name: "OCPI - CPO CDRs (Sender)",
        description: "CPO Charge Detail Records module for completed charging transactions",
      },
      {
        name: "OCPI - CPO Tokens (Receiver)",
        description: "CPO Tokens module: Receive authorized RFID / App credentials from eMSP",
      },
      {
        name: "OCPI - CPO Commands (Receiver)",
        description: "CPO Commands module: START_SESSION, STOP_SESSION, RESERVE_NOW, UNLOCK_CONNECTOR",
      },
      {
        name: "OCPI - CPO Charging Profiles (Receiver)",
        description: "CPO Smart Charging & Profile limits",
      },
      {
        name: "OCPI - eMSP Locations (Receiver)",
        description: "eMSP Locations receiver: Receive pushed location updates from CPO",
      },
      {
        name: "OCPI - eMSP Tariffs (Receiver)",
        description: "eMSP Tariffs receiver: Receive pushed tariffs from CPO",
      },
      {
        name: "OCPI - eMSP Sessions (Receiver)",
        description: "eMSP Sessions receiver: Receive session updates from CPO",
      },
      {
        name: "OCPI - eMSP CDRs (Receiver)",
        description: "eMSP CDRs receiver: Receive finalized CDRs for billing from CPO",
      },
      {
        name: "OCPI - eMSP Tokens (Sender)",
        description: "eMSP Tokens sender: Real-time authorization check & token list download",
      },
      {
        name: "OCPI - eMSP Callbacks (Sender)",
        description: "eMSP Command & Charging Profile async result callbacks",
      },
      {
        name: "Simulator UI & Handshake",
        description: "Simulator runtime state, handshake orchestration & connection profiles",
      },
      {
        name: "Simulator eMSP Actions",
        description: "Trigger outbound queries to external CPOs (locations, direct bypass, commands)",
      },
      {
        name: "Simulator CPO Management",
        description: "Internal CRUD builder for locations, EVSEs, tariffs, sessions, and test tokens",
      },
      {
        name: "Simulator Traffic Logs",
        description: "Inspect captured HTTP request & response transactions in real time",
      },
    ],
    components: {
      securitySchemes: {
        OcpiTokenAuth: {
          type: "apiKey",
          name: "Authorization",
          in: "header",
          description: "Enter OCPI Token (format: `Token <your-token>`). Pre-filled automatically with active token.",
        },
        OcpiBearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Token",
          description: "Alternative HTTP Bearer scheme: enter just the raw token string.",
        },
      },
      schemas: {
        OcpiResponseEnvelope: {
          type: "object",
          properties: {
            data: { description: "The response payload data" },
            status_code: { type: "integer", example: 1000 },
            status_message: { type: "string", example: "Success" },
            timestamp: { type: "string", format: "date-time" },
          },
        },
        CredentialsPayload: {
          type: "object",
          required: ["token", "url", "roles"],
          properties: {
            token: { type: "string", example: "partner-token-b-or-c" },
            url: { type: "string", example: "https://partner.example.com/ocpi/versions" },
            roles: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["CPO", "EMSP", "HUB", "NAP", "NSP", "SCSP"] },
                  party_id: { type: "string", example: "CCL" },
                  country_code: { type: "string", example: "DE" },
                  business_details: {
                    type: "object",
                    properties: {
                      name: { type: "string", example: "Charge Partner" },
                    },
                  },
                },
              },
            },
          },
        },
        OcpiLocation: {
          type: "object",
          required: ["id", "type", "name", "address", "city", "postal_code", "country", "coordinates", "time_zone"],
          properties: {
            country_code: { type: "string", example: "IN" },
            party_id: { type: "string", example: "CZS" },
            id: { type: "string", example: "LOC-001" },
            publish: { type: "boolean", default: true },
            name: { type: "string", example: "Connaught Place Hub 1" },
            address: { type: "string", example: "Inner Circle, Connaught Place" },
            city: { type: "string", example: "New Delhi" },
            postal_code: { type: "string", example: "110001" },
            country: { type: "string", example: "IND" },
            coordinates: {
              type: "object",
              properties: {
                latitude: { type: "string", example: "28.6315" },
                longitude: { type: "string", example: "77.2167" },
              },
            },
            time_zone: { type: "string", example: "Asia/Kolkata" },
            evses: { type: "array", items: { $ref: "#/components/schemas/OcpiEvse" } },
            last_updated: { type: "string", format: "date-time" },
          },
        },
        OcpiEvse: {
          type: "object",
          required: ["uid", "status", "connectors"],
          properties: {
            uid: { type: "string", example: "EVSE-01" },
            evse_id: { type: "string", example: "IN*CZS*E001" },
            status: { type: "string", enum: ["AVAILABLE", "BLOCKED", "CHARGING", "INOPERATIVE", "OUTOFORDER", "PLANNED", "RESERVED", "UNKNOWN"], example: "AVAILABLE" },
            connectors: { type: "array", items: { $ref: "#/components/schemas/OcpiConnector" } },
            last_updated: { type: "string", format: "date-time" },
          },
        },
        OcpiConnector: {
          type: "object",
          required: ["id", "standard", "format", "power_type", "max_voltage", "max_amperage"],
          properties: {
            id: { type: "string", example: "CONN-1" },
            standard: { type: "string", example: "IEC_62196_T2" },
            format: { type: "string", example: "SOCKET" },
            power_type: { type: "string", example: "AC_3_PHASE" },
            max_voltage: { type: "integer", example: 400 },
            max_amperage: { type: "integer", example: 32 },
            max_electric_power: { type: "integer", example: 22000 },
            tariff_ids: { type: "array", items: { type: "string" } },
            last_updated: { type: "string", format: "date-time" },
          },
        },
        OcpiTariff: {
          type: "object",
          required: ["id", "currency", "elements"],
          properties: {
            country_code: { type: "string", example: "IN" },
            party_id: { type: "string", example: "CZS" },
            id: { type: "string", example: "TAR-FAST-01" },
            currency: { type: "string", example: "INR" },
            elements: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  price_components: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        type: { type: "string", enum: ["ENERGY", "FLAT", "TIME", "PARKING_TIME"] },
                        price: { type: "number", example: 18.0 },
                        step_size: { type: "integer", example: 1 },
                      },
                    },
                  },
                },
              },
            },
            last_updated: { type: "string", format: "date-time" },
          },
        },
        OcpiSession: {
          type: "object",
          required: ["id", "start_date_time", "location_id", "evse_uid", "connector_id", "status"],
          properties: {
            country_code: { type: "string", example: "IN" },
            party_id: { type: "string", example: "CZS" },
            id: { type: "string", example: "SES-1001" },
            start_date_time: { type: "string", format: "date-time" },
            end_date_time: { type: "string", format: "date-time", nullable: true },
            kwh: { type: "number", example: 14.85 },
            cdr_token: {
              type: "object",
              properties: {
                country_code: { type: "string", example: "IN" },
                party_id: { type: "string", example: "CZS" },
                uid: { type: "string", example: "TOK-998877" },
                type: { type: "string", example: "RFID" },
              },
            },
            auth_method: { type: "string", enum: ["AUTH_REQUEST", "COMMAND", "WHITELIST"], example: "WHITELIST" },
            location_id: { type: "string", example: "LOC-001" },
            evse_uid: { type: "string", example: "EVSE-01" },
            connector_id: { type: "string", example: "CONN-1" },
            status: { type: "string", enum: ["ACTIVE", "COMPLETED", "INVALID", "PENDING", "RESERVED"], example: "ACTIVE" },
            total_cost: {
              type: "object",
              properties: {
                excl_vat: { type: "number", example: 267.3 },
                incl_vat: { type: "number", example: 315.41 },
              },
            },
            last_updated: { type: "string", format: "date-time" },
          },
        },
        OcpiCdr: {
          type: "object",
          required: ["id", "start_date_time", "stop_date_time", "cdr_location", "currency", "total_cost", "total_energy"],
          properties: {
            country_code: { type: "string", example: "IN" },
            party_id: { type: "string", example: "CZS" },
            id: { type: "string", example: "CDR-8801" },
            start_date_time: { type: "string", format: "date-time" },
            stop_date_time: { type: "string", format: "date-time" },
            session_id: { type: "string", example: "SES-1001" },
            total_energy: { type: "number", example: 22.5 },
            currency: { type: "string", example: "INR" },
            total_cost: {
              type: "object",
              properties: {
                excl_vat: { type: "number", example: 405.0 },
                incl_vat: { type: "number", example: 477.9 },
              },
            },
            last_updated: { type: "string", format: "date-time" },
          },
        },
        OcpiToken: {
          type: "object",
          required: ["country_code", "party_id", "uid", "type", "contract_id", "issuer", "valid", "whitelist"],
          properties: {
            country_code: { type: "string", example: "IN" },
            party_id: { type: "string", example: "CZS" },
            uid: { type: "string", example: "TOK-998877" },
            type: { type: "string", enum: ["OTHER", "RFID", "APP_USER"], example: "RFID" },
            contract_id: { type: "string", example: "CZS-CONTRACT-001" },
            visual_number: { type: "string", example: "RFID-998877" },
            issuer: { type: "string", example: "ChargeZone Simulator" },
            valid: { type: "boolean", example: true },
            whitelist: { type: "string", enum: ["ALWAYS", "ALLOWED", "ALLOWED_OFFLINE", "NEVER"], example: "ALWAYS" },
            last_updated: { type: "string", format: "date-time" },
          },
        },
        CommandResponse: {
          type: "object",
          properties: {
            result: { type: "string", enum: ["ACCEPTED", "CANCELED_RESERVATION", "EVSE_OCCUPIED", "INOPERATIVE", "FAILED", "NOT_SUPPORTED", "REJECTED", "TIMEOUT", "UNKNOWN_RESERVATION"], example: "ACCEPTED" },
            timeout: { type: "integer", example: 30 },
            message: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  language: { type: "string", example: "en" },
                  text: { type: "string", example: "Command accepted" },
                },
              },
            },
          },
        },
      },
    },
    paths: {
      /* ====================================================================== */
      /* OCPI CORE & VERSION DISCOVERY                                          */
      /* ====================================================================== */
      "/ocpi/versions": {
        get: {
          tags: ["OCPI - Discovery & Credentials"],
          summary: "List Supported OCPI Versions",
          description: "Returns list of supported OCPI versions. Requires Authorization: Token <token> (Token A bootstrap token before handshake, or active localToken after handshake).",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [authHeaderParam],
          responses: {
            200: {
              description: "List of supported versions",
              content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } },
            },
          },
        },
      },
      "/ocpi/2.2.1/details": {
        get: {
          tags: ["OCPI - Discovery & Credentials"],
          summary: "OCPI 2.2.1 Endpoints Catalog",
          description: `Returns advertised OCPI 2.2.1 endpoints filtered by simulator role (CPO exposes Credentials + CPO endpoints; eMSP exposes Credentials + eMSP endpoints). Active simulator role: **${simulator.role || "CPO"}**. Requires Authorization: Token <token>.`,
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            authHeaderParam,
            {
              name: "role",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["CPO", "EMSP", "ALL"] },
              description: `Optional role filter (defaults to current simulator role: ${simulator.role || "CPO"})`,
            },
          ],
          responses: {
            200: {
              description: "Catalog of endpoints",
              content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } },
            },
          },
        },
      },
      "/ocpi/2.2.1/credentials": {
        post: {
          tags: ["OCPI - Discovery & Credentials"],
          summary: "Credentials Handshake Registration (Receiver)",
          description: "Sender registers their credentials token and endpoints using bootstrap Token A.",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [authHeaderParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CredentialsPayload" } } },
          },
          responses: {
            200: {
              description: "Receiver credentials returned in response",
              content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } },
            },
          },
        },
        get: {
          tags: ["OCPI - Discovery & Credentials"],
          summary: "Get Current Credentials",
          description: "Retrieve local credentials token and endpoints.",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [authHeaderParam],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        put: {
          tags: ["OCPI - Discovery & Credentials"],
          summary: "Update Credentials",
          description: "Update client token or endpoints.",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [authHeaderParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CredentialsPayload" } } },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        delete: {
          tags: ["OCPI - Discovery & Credentials"],
          summary: "Unregister Connection",
          description: "Terminate the OCPI connection and invalidate partner tokens.",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [authHeaderParam],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },

      /* ====================================================================== */
      /* OCPI CPO ENDPOINTS                                                     */
      /* ====================================================================== */
      "/ocpi/cpo/2.2.1/locations": {
        get: {
          tags: ["OCPI - CPO Locations (Sender)"],
          summary: "Get All Locations (CPO)",
          description: "Returns paginated list of locations with optional date range filters.",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "date_from", in: "query", schema: { type: "string", format: "date-time" }, description: "Only locations updated since this date" },
            { name: "date_to", in: "query", schema: { type: "string", format: "date-time" }, description: "Only locations updated until this date" },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 }, description: "Pagination offset" },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 }, description: "Number of objects to return (max 100)" },
          ],
          responses: {
            200: {
              description: "Array of locations with Link, X-Total-Count, and X-Limit headers",
              content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } },
            },
          },
        },
      },
      "/ocpi/cpo/2.2.1/locations/{location_id}": {
        get: {
          tags: ["OCPI - CPO Locations (Sender)"],
          summary: "Get Specific Location",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "location_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/locations/{location_id}/{evse_uid}": {
        get: {
          tags: ["OCPI - CPO Locations (Sender)"],
          summary: "Get Specific EVSE",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "location_id", in: "path", required: true, schema: { type: "string" } },
            { name: "evse_uid", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/locations/{location_id}/{evse_uid}/{connector_id}": {
        get: {
          tags: ["OCPI - CPO Locations (Sender)"],
          summary: "Get Specific Connector",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "location_id", in: "path", required: true, schema: { type: "string" } },
            { name: "evse_uid", in: "path", required: true, schema: { type: "string" } },
            { name: "connector_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/tariffs": {
        get: {
          tags: ["OCPI - CPO Tariffs (Sender)"],
          summary: "Get All Tariffs (CPO)",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "date_from", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "date_to", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/tariffs/{tariff_id}": {
        get: {
          tags: ["OCPI - CPO Tariffs (Sender)"],
          summary: "Get Specific Tariff",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "tariff_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        put: {
          tags: ["OCPI - CPO Tariffs (Sender)"],
          summary: "Create or Update Tariff",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "tariff_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiTariff" } } },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        delete: {
          tags: ["OCPI - CPO Tariffs (Sender)"],
          summary: "Delete Tariff",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "tariff_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/sessions": {
        get: {
          tags: ["OCPI - CPO Sessions (Sender)"],
          summary: "Get Active Charging Sessions",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "date_from", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "date_to", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/sessions/{session_id}": {
        get: {
          tags: ["OCPI - CPO Sessions (Sender)"],
          summary: "Get Specific Session",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "session_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/sessions/{session_id}/charging_preferences": {
        put: {
          tags: ["OCPI - CPO Sessions (Sender)"],
          summary: "Set Charging Preferences for Session",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "session_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    profile_type: { type: "string", enum: ["CHEAP", "FAST", "GREEN", "REGULAR"], example: "FAST" },
                    departure_time: { type: "string", format: "date-time" },
                    energy_need: { type: "number", example: 30.5 },
                  },
                },
              },
            },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/cdrs": {
        get: {
          tags: ["OCPI - CPO CDRs (Sender)"],
          summary: "Get Charge Detail Records (CDRs)",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "date_from", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "date_to", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/cdrs/{cdr_id}": {
        get: {
          tags: ["OCPI - CPO CDRs (Sender)"],
          summary: "Get Specific CDR",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "cdr_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/tokens/{country_code}/{party_id}/{token_uid}": {
        get: {
          tags: ["OCPI - CPO Tokens (Receiver)"],
          summary: "Get Token stored in CPO cache",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "token_uid", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        put: {
          tags: ["OCPI - CPO Tokens (Receiver)"],
          summary: "Store/Push Token into CPO cache",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "token_uid", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiToken" } } },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        patch: {
          tags: ["OCPI - CPO Tokens (Receiver)"],
          summary: "Partially update Token in CPO cache",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "token_uid", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/commands/START_SESSION": {
        post: {
          tags: ["OCPI - CPO Commands (Receiver)"],
          summary: "Command: START_SESSION",
          security: [{ OcpiTokenAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["response_url", "token", "location_id"],
                  properties: {
                    response_url: { type: "string", example: "https://emsp.example.com/ocpi/emsp/2.2.1/commands/START_SESSION/123" },
                    token: { $ref: "#/components/schemas/OcpiToken" },
                    location_id: { type: "string", example: "LOC-001" },
                    evse_uid: { type: "string", example: "EVSE-01" },
                    connector_id: { type: "string", example: "CONN-1" },
                  },
                },
              },
            },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/commands/STOP_SESSION": {
        post: {
          tags: ["OCPI - CPO Commands (Receiver)"],
          summary: "Command: STOP_SESSION",
          security: [{ OcpiTokenAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["response_url", "session_id"],
                  properties: {
                    response_url: { type: "string" },
                    session_id: { type: "string", example: "SES-1001" },
                  },
                },
              },
            },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/commands/UNLOCK_CONNECTOR": {
        post: {
          tags: ["OCPI - CPO Commands (Receiver)"],
          summary: "Command: UNLOCK_CONNECTOR",
          security: [{ OcpiTokenAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["response_url", "location_id", "evse_uid", "connector_id"],
                  properties: {
                    response_url: { type: "string" },
                    location_id: { type: "string" },
                    evse_uid: { type: "string" },
                    connector_id: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/cpo/2.2.1/chargingprofiles/{session_id}": {
        get: {
          tags: ["OCPI - CPO Charging Profiles (Receiver)"],
          summary: "Get Active Charging Profile",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "session_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        put: {
          tags: ["OCPI - CPO Charging Profiles (Receiver)"],
          summary: "Set Charging Profile",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "session_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        delete: {
          tags: ["OCPI - CPO Charging Profiles (Receiver)"],
          summary: "Clear Charging Profile",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "session_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },

      /* ====================================================================== */
      /* OCPI eMSP ENDPOINTS                                                    */
      /* ====================================================================== */
      "/ocpi/emsp/2.2.1/locations/{country_code}/{party_id}/{location_id}": {
        get: {
          tags: ["OCPI - eMSP Locations (Receiver)"],
          summary: "Get Location pushed to eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "location_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        put: {
          tags: ["OCPI - eMSP Locations (Receiver)"],
          summary: "CPO Pushes Location to eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "location_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiLocation" } } },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        patch: {
          tags: ["OCPI - eMSP Locations (Receiver)"],
          summary: "CPO Patches Location at eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "location_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/emsp/2.2.1/tariffs/{country_code}/{party_id}/{tariff_id}": {
        get: {
          tags: ["OCPI - eMSP Tariffs (Receiver)"],
          summary: "Get Tariff pushed to eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "tariff_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        put: {
          tags: ["OCPI - eMSP Tariffs (Receiver)"],
          summary: "CPO Pushes Tariff to eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "tariff_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiTariff" } } },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        delete: {
          tags: ["OCPI - eMSP Tariffs (Receiver)"],
          summary: "Delete Tariff at eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "tariff_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/emsp/2.2.1/sessions/{country_code}/{party_id}/{session_id}": {
        get: {
          tags: ["OCPI - eMSP Sessions (Receiver)"],
          summary: "Get Session at eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "session_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        put: {
          tags: ["OCPI - eMSP Sessions (Receiver)"],
          summary: "CPO Pushes Session update to eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "session_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiSession" } } },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
        patch: {
          tags: ["OCPI - eMSP Sessions (Receiver)"],
          summary: "CPO Patches Session at eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "country_code", in: "path", required: true, schema: { type: "string" } },
            { name: "party_id", in: "path", required: true, schema: { type: "string" } },
            { name: "session_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/emsp/2.2.1/cdrs": {
        post: {
          tags: ["OCPI - eMSP CDRs (Receiver)"],
          summary: "CPO Posts Finalized CDR to eMSP",
          security: [{ OcpiTokenAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiCdr" } } },
          },
          responses: {
            201: {
              description: "CDR received and created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } },
            },
          },
        },
      },
      "/ocpi/emsp/2.2.1/cdrs/{cdr_id}": {
        get: {
          tags: ["OCPI - eMSP CDRs (Receiver)"],
          summary: "Get Specific CDR at eMSP",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "cdr_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/emsp/2.2.1/tokens": {
        get: {
          tags: ["OCPI - eMSP Tokens (Sender)"],
          summary: "Download Tokens List (eMSP)",
          description: "CPO queries eMSP to retrieve tokens list for local whitelist caching.",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "date_from", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "date_to", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          ],
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },
      "/ocpi/emsp/2.2.1/tokens/{token_uid}/authorize": {
        post: {
          tags: ["OCPI - eMSP Tokens (Sender)"],
          summary: "Real-Time Token Authorization",
          description: "CPO queries eMSP in real-time to authorize an RFID or app token.",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [{ name: "token_uid", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    location_id: { type: "string", example: "LOC-001" },
                    evse_uids: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Authorization status (ALLOWED or NOT_ALLOWED)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } },
            },
          },
        },
      },
      "/ocpi/emsp/2.2.1/commands/{command}/{uid}": {
        post: {
          tags: ["OCPI - eMSP Callbacks (Sender)"],
          summary: "Async Command Result Callback",
          description: "CPO posts the async execution result of a command to eMSP response_url.",
          security: [{ OcpiTokenAuth: [] }],
          parameters: [
            { name: "command", in: "path", required: true, schema: { type: "string" } },
            { name: "uid", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CommandResponse" } } },
          },
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiResponseEnvelope" } } } },
          },
        },
      },

      /* ====================================================================== */
      /* SIMULATOR MANAGEMENT & UI APIS                                         */
      /* ====================================================================== */
      "/api/handshake": {
        post: {
          tags: ["Simulator UI & Handshake"],
          summary: "Initiate Outgoing Handshake",
          description: "Connect simulator to an external partner CPO or eMSP via credentials handshake.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["partnerVersionsUrl", "bootstrapToken"],
                  properties: {
                    partnerVersionsUrl: { type: "string", example: "https://uat-api.chargecloud.net/ocpi/versions/2.2" },
                    bootstrapToken: { type: "string", example: "partner-bootstrap-token" },
                    role: { type: "string", enum: ["CPO", "EMSP"], default: "EMSP" },
                    partyId: { type: "string", example: "CZS" },
                    countryCode: { type: "string", example: "IN" },
                    businessName: { type: "string", example: "OCPI Test Simulator" },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Handshake completed successfully" },
            502: { description: "Handshake failed" },
          },
        },
      },
      "/api/status": {
        get: {
          tags: ["Simulator UI & Handshake"],
          summary: "Get Simulator Status",
          description: "Returns connection status, current role, partner info, and database status.",
          parameters: [
            { name: "role", in: "query", schema: { type: "string", enum: ["CPO", "EMSP"] } },
            { name: "profileId", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Simulator status payload" },
          },
        },
      },
      "/api/connections": {
        get: {
          tags: ["Simulator UI & Handshake"],
          summary: "List Saved Connection Profiles",
          responses: {
            200: { description: "List of stored partner connection profiles" },
          },
        },
      },
      "/api/locations": {
        get: {
          tags: ["Simulator eMSP Actions"],
          summary: "Fetch Locations from Partner CPO",
          description: "eMSP pulls locations using handshake credentials.",
          responses: {
            200: { description: "Locations from partner CPO" },
          },
        },
      },
      "/api/locations/direct": {
        post: {
          tags: ["Simulator eMSP Actions"],
          summary: "Direct Bypass Locations Fetch",
          description: "Fetch locations directly from any endpoint without prior handshake.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["endpoint", "token"],
                  properties: {
                    endpoint: { type: "string", example: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/locations/" },
                    token: { type: "string", example: "direct-token" },
                    limit: { type: "integer", default: 100 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Fetched locations" },
          },
        },
      },
      "/api/commands/send": {
        post: {
          tags: ["Simulator eMSP Actions"],
          summary: "Send Outbound Command to Partner CPO",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["command", "endpoint", "token"],
                  properties: {
                    command: { type: "string", example: "START_SESSION" },
                    endpoint: { type: "string", example: "https://uat-api.chargecloud.net/ocpi/cpo/2.2/commands/START_SESSION" },
                    token: { type: "string" },
                    payload: { type: "object" },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Command result from CPO" },
          },
        },
      },
      "/api/cpo/config": {
        get: {
          tags: ["Simulator CPO Management"],
          summary: "Get CPO Configuration & Identity",
          responses: {
            200: { description: "CPO configuration" },
          },
        },
      },
      "/api/cpo/locations": {
        get: {
          tags: ["Simulator CPO Management"],
          summary: "List CPO Locations",
          responses: {
            200: { description: "List of CPO locations" },
          },
        },
        post: {
          tags: ["Simulator CPO Management"],
          summary: "Create CPO Location",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiLocation" } } },
          },
          responses: {
            201: { description: "Location created" },
          },
        },
      },
      "/api/cpo/locations/{id}": {
        get: {
          tags: ["Simulator CPO Management"],
          summary: "Get Single Location",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Location object" } },
        },
        put: {
          tags: ["Simulator CPO Management"],
          summary: "Update Location",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiLocation" } } } },
          responses: { 200: { description: "Location updated" } },
        },
        delete: {
          tags: ["Simulator CPO Management"],
          summary: "Delete Location",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Location deleted" } },
        },
      },
      "/api/cpo/tariffs": {
        get: {
          tags: ["Simulator CPO Management"],
          summary: "List Tariffs",
          responses: { 200: { description: "List of tariffs" } },
        },
        post: {
          tags: ["Simulator CPO Management"],
          summary: "Create or Update Tariff",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiTariff" } } },
          },
          responses: { 200: { description: "Tariff saved" } },
        },
      },
      "/api/cpo/sessions": {
        get: {
          tags: ["Simulator CPO Management"],
          summary: "List Sessions in Simulator",
          responses: { 200: { description: "Sessions array" } },
        },
        post: {
          tags: ["Simulator CPO Management"],
          summary: "Create Mock Session",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiSession" } } } },
          responses: { 200: { description: "Session created" } },
        },
      },
      "/api/cpo/cdrs": {
        get: {
          tags: ["Simulator CPO Management"],
          summary: "List CDRs in Simulator",
          responses: { 200: { description: "CDRs array" } },
        },
        post: {
          tags: ["Simulator CPO Management"],
          summary: "Create Mock CDR",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiCdr" } } } },
          responses: { 200: { description: "CDR created" } },
        },
      },
      "/api/cpo/tokens": {
        get: {
          tags: ["Simulator CPO Management"],
          summary: "List Test Tokens",
          responses: { 200: { description: "Tokens array" } },
        },
        post: {
          tags: ["Simulator CPO Management"],
          summary: "Create Test Token",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OcpiToken" } } } },
          responses: { 200: { description: "Token created" } },
        },
      },
      "/api/logs": {
        get: {
          tags: ["Simulator Traffic Logs"],
          summary: "Query Traffic & Transaction Logs",
          parameters: [
            { name: "filter", in: "query", schema: { type: "string", enum: ["ALL", "REQUEST", "RESPONSE", "SUCCESS", "ERROR", "HTTP_ERROR", "TRANSPORT_ERROR", "INBOUND", "OUTBOUND"] } },
            { name: "module", in: "query", schema: { type: "string" } },
            { name: "role", in: "query", schema: { type: "string", enum: ["CPO", "EMSP"] } },
            { name: "search", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
          ],
          responses: { 200: { description: "Filtered log transactions" } },
        },
        delete: {
          tags: ["Simulator Traffic Logs"],
          summary: "Clear All Logs",
          responses: { 200: { description: "Logs cleared" } },
        },
      },
      "/api/logs/{id}": {
        get: {
          tags: ["Simulator Traffic Logs"],
          summary: "Get Single Transaction Log Details",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Transaction details" } },
        },
      },
    },
  };

  // Guarantee every OCPI endpoint has authHeaderParam in parameters and securitySchemes
  for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
    if (pathKey.startsWith("/ocpi/")) {
      for (const [method, op] of Object.entries(pathItem)) {
        if (typeof op === "object" && op !== null) {
          op.security = [{ OcpiTokenAuth: [] }, { OcpiBearerAuth: [] }];
          op.parameters = op.parameters || [];
          const existingAuthIndex = op.parameters.findIndex(
            (p) => p.name && p.name.toLowerCase() === "authorization"
          );
          if (existingAuthIndex >= 0) {
            op.parameters[existingAuthIndex] = authHeaderParam;
          } else {
            op.parameters.unshift(authHeaderParam);
          }
        }
      }
    } else {
      // Internal / UI management endpoints (/api/...) do not require OCPI auth
      for (const [method, op] of Object.entries(pathItem)) {
        if (typeof op === "object" && op !== null && !op.security) {
          op.security = [];
        }
      }
    }
  }

  return spec;
}

module.exports = { getSwaggerSpec };
