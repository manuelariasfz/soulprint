# 🔐 Soulprint

**Decentralized KYC identity protocol for AI agents.**

Soulprint lets any AI bot prove there's a verified human behind it — without revealing who that human is. No companies, no servers, no paid APIs. Just cryptographic proof.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[[![npm soulprint](https://img.shields.io/npm/v/soulprint?label=soulprint&color=blue)](https://npmjs.com/package/soulprint)
[![npm soulprint-mcp](https://img.shields.io/npm/v/soulprint-mcp?label=soulprint-mcp&color=purple)](https://npmjs.com/package/soulprint-mcp)
![Phase](https://img.shields.io/badge/v0.1.3-phases%201--4%20complete-brightgreen)]()
[![Built with](https://img.shields.io/badge/built%20with-Circom%20%2B%20snarkjs%20%2B%20InsightFace-purple)]()

---

## The Problem

AI agents are acting on behalf of humans: booking flights, calling APIs, making decisions. But no service can know if a bot is legitimate or malicious. There's no accountability.

**Soulprint solves this** by linking every bot to a verified human identity — cryptographically, privately, and without any central authority.

---

## How It Works

```
1. User runs: npx soulprint verify-me --selfie me.jpg --document cedula.jpg
              ↓
2. LOCAL (on-device, nothing leaves your machine):
   • Tesseract OCR reads the cedula (Colombian ID)
   • InsightFace matches your face to the document photo
   • Poseidon hash derives a unique nullifier from (cedula + birthdate + face_key)
   • ZK proof generated: "I verified my identity" without revealing any data
   • Photos deleted from memory
              ↓
3. ZK proof + SPT broadcast to validator node (verifies in 25ms, offline)
              ↓
4. Soulprint Token (SPT) stored in ~/.soulprint/token.spt — valid 24h
              ↓
5. Any MCP server or API verifies in <50ms, offline, for free
```

**What the verifier knows:** ✅ Real human, verified Colombian ID, trust score  
**What the verifier doesn't know:** 🔒 Name, cedula number, face, birthdate

---

## Quick Start

### 1. Install Python deps (face recognition)

```bash
npx soulprint install-deps
```

### 2. Verify your identity

```bash
npx soulprint verify-me \
  --selfie path/to/selfie.jpg \
  --document path/to/cedula.jpg
```

Output:
```
🔐 Soulprint — Verificación de identidad
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Validación de imágenes
  ✅ OCR del documento
  ✅ Coincidencia facial
  ✅ Derivación de nullifier
  ✅ Generación de ZK proof
  ✅ Emisión del token SPT

  DID:          did:key:z6Mk...
  Trust Score:  45/100
  ZK Proof:     ✅ incluido
  Tiempo:       3.2s
```

### 3. Show your token

```bash
npx soulprint show
```

### 4. Renew (no re-verify needed)

```bash
npx soulprint renew
```

### 5. Run a validator node

```bash
npx soulprint node --port 4888
```

---

## Protect Any MCP Server (3 lines)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { soulprint } from "soulprint-mcp";

const server = new McpServer({ name: "my-server", version: "1.0" });
server.use(soulprint({ minScore: 60 }));  // require KYC-verified humans
```

The client must include the SPT in capabilities:
```json
{
  "capabilities": {
    "identity": { "soulprint": "<token>" }
  }
}
```

Or in the HTTP header: `X-Soulprint: <token>`

---

## Protect Any REST API

```typescript
import express from "express";
import { soulprint } from "soulprint-express";

const app = express();

// Protect entire API
app.use(soulprint({ minScore: 40 }));

// Or specific routes
app.post("/sensitive", soulprint({ require: ["DocumentVerified", "FaceMatch"] }), handler);

// Access the verified identity
app.get("/me", soulprint({ minScore: 20 }), (req, res) => {
  res.json({
    nullifier: req.soulprint!.nullifier,  // unique per human, no PII
    score:     req.soulprint!.score,
  });
});
```

### Fastify

```typescript
import { soulprintFastify } from "soulprint-express";

await fastify.register(soulprintFastify, { minScore: 60 });

fastify.get("/me", async (request) => ({
  nullifier: request.soulprint?.nullifier,
}));
```

---

## Run a Validator Node

Anyone can run a validator node. Nodes verify ZK proofs and maintain an anti-Sybil registry. No special hardware needed — any machine can be a node.

```bash
# Run locally
npx soulprint node --port 4888

# Or as a background service
SOULPRINT_PORT=4888 node dist/server.js &
```

Node API:
```
GET  /info              — node info (DID, version, stats)
POST /verify            — verify ZK proof + co-sign SPT
GET  /nullifier/:hash   — check if nullifier is registered (anti-Sybil)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4 — SDKs (soulprint-mcp, express)      ✅ Done  │
├─────────────────────────────────────────────────────────┤
│  Layer 3 — Validator Nodes (HTTP + anti-Sybil)  ✅ Done │
├─────────────────────────────────────────────────────────┤
│  Layer 2 — ZK Proofs (Circom + snarkjs)         ✅ Done │
├─────────────────────────────────────────────────────────┤
│  Layer 1 — Local Verification (Face + OCR)      ✅ Done │
└─────────────────────────────────────────────────────────┘
```

### On-Demand ML Models

AI models are **never running persistently**:

```
Idle state:       ~8MB RAM   (only the CLI)
During verify:    ~200MB RAM (InsightFace subprocess spawned)
After verify:     ~8MB RAM   (subprocess exits → memory freed)
```

---

## Packages

| Package | Description | Install |
|---|---|---|
| [`soulprint-core`](packages/core) | DID, SPT tokens, Poseidon nullifier | `npm i soulprint-core` |
| [`soulprint-verify`](packages/verify-local) | OCR + face match (on-demand) | `npm i soulprint-verify` |
| [`soulprint-zkp`](packages/zkp) | Circom circuit + snarkjs prover | `npm i soulprint-zkp` |
| [`soulprint-network`](packages/network) | Validator node HTTP server | `npm i soulprint-network` |
| [`soulprint-mcp`](packages/mcp) | MCP middleware (3 lines) | `npm i soulprint-mcp` |
| [`soulprint-express`](packages/express) | Express/Fastify middleware | `npm i soulprint-express` |
| [`soulprint`](packages/cli) | `npx soulprint` CLI | `npm i -g soulprint` |

---

## ZK Circuit

The heart of Soulprint is a [Circom](https://circom.io) circuit that proves:

> *"I know a cedula number + birthdate + face key such that*  
> *`Poseidon(cedula, birthdate, face_key) == nullifier`*  
> *AND the cedula is within valid Registraduría ranges"*

Without revealing any of the private inputs.

**Circuit stats:**
- 844 non-linear constraints
- 4 private inputs (cedula, birthdate, face_key, salt)  
- 2 public inputs (nullifier, context_tag)
- Proof generation: ~600ms on a laptop
- Proof verification: ~25ms offline

---

## Soulprint Token (SPT)

A base64url-encoded signed JWT. **Contains no PII.**

```json
{
  "sip":         "1",
  "did":         "did:key:z6MkhaXgBZ...",
  "score":       45,
  "level":       "KYCFull",
  "country":     "CO",
  "credentials": ["DocumentVerified", "FaceMatch"],
  "nullifier":   "0x7090787188...",
  "zkp":         "eyJwIjp7InBpX2EiOlsi...",
  "issued":      1740000000,
  "expires":     1740086400,
  "sig":         "ed25519_signature"
}
```

---

## Trust Scoring

```
Credential          | Score
--------------------|-------
EmailVerified       | +10
PhoneVerified       | +15
GitHubLinked        | +20
DocumentVerified    | +25
FaceMatch           | +20
BiometricBound      | +10
                    |
KYCFull (doc+face)  |  45/100
```

Services choose their own threshold:
```typescript
soulprint({ minScore: 20 })   // email verified is enough
soulprint({ minScore: 45 })   // require doc + face KYC
soulprint({ minScore: 80 })   // require full biometric + extra
```

---

## Anti-Sybil Protection

The nullifier is derived from **biometric + document data**:

```
nullifier = Poseidon(cedula_number, birthdate, face_key)
face_key  = Poseidon(quantized_face_embedding[0..31])
```

- Same person, different device → **same nullifier**
- Different person, same cedula → **different nullifier** (face doesn't match)
- Person registers twice → nullifier already exists → **rejected by validator**

---

## Supported Countries

| Country | Document | Status |
|---|---|---|
| 🇨🇴 Colombia | Cédula de Ciudadanía (MRZ + OCR) | ✅ Supported |
| 🌎 Others | Passport (ICAO TD3 MRZ) | 🚧 Planned |

---

## Development Setup

```bash
git clone https://github.com/manuelariasfz/soulprint
cd soulprint
pnpm install
pnpm build
```

### Run integration tests

```bash
# ZK proof tests (no circuit compilation needed)
cd packages/zkp && node dist/prover.test.js

# Full integration tests
node -e "require('./packages/core/dist/index.js')"
```

### Compile ZK circuit (first time only)

```bash
pnpm --filter soulprint-zkp build:circuits
```

### Python dependencies

```bash
pip3 install insightface opencv-python-headless onnxruntime
```

---

## Trust Score — 0 to 100

```
Total Score (0-100) = Identity (0-80) + Bot Reputation (0-20)
```

**Identity credentials (max 80 pts):**

| Credential | Points | How |
|---|---|---|
| EmailVerified | +8 | Email confirmation |
| PhoneVerified | +12 | SMS OTP |
| GitHubLinked | +16 | OAuth |
| DocumentVerified | +20 | OCR + MRZ (ICAO 9303) |
| FaceMatch | +16 | InsightFace biometric |
| BiometricBound | +8 | Device binding |

**Access levels:**

| Score | Level | Access |
|---|---|---|
| 0–17 | Anonymous | Basic tools |
| 18–59 | Partial KYC | Standard features |
| 60–94 | KYCFull | Advanced features |
| **95–100** | **KYCFull + reputation** | **Premium endpoints** |

---

## Bot Reputation (v0.1.3)

The reputation layer (0–20 pts) builds over time from behavioral **attestations** issued by verified services.

```
Reputation starts at: 10 (neutral)
Verified service issues +1  →  goes up  (max 20)
Verified service issues -1  →  goes down (min 0)
```

**Attestation format (Ed25519 signed):**

```typescript
interface BotAttestation {
  issuer_did: string;  // service DID (requires score >= 60 to issue)
  target_did: string;  // bot being rated
  value:      1 | -1;
  context:    string;  // "spam-detected", "normal-usage", "payment-completed"
  timestamp:  number;
  sig:        string;  // Ed25519 — bound to issuer_did
}
```

**Only services with score ≥ 60 can issue attestations.** This prevents low-quality services from gaming the network.

Attestations propagate **P2P across all validator nodes** via fire-and-forget gossip (anti-replay included).

---

## Live Ecosystem — mcp-colombia-hub

[mcp-colombia-hub](https://github.com/manuelariasfz/mcp-colombia) is the **first verified service** in the Soulprint ecosystem:

- **Service score:** 80 (DocumentVerified + FaceMatch + GitHubLinked + BiometricBound)
- **Auto-issues -1** when a bot spams (>5 req/60s)
- **Auto-issues +1** when a bot completes 3+ tools normally
- **Premium endpoint `trabajo_aplicar`** requires score ≥ 95

```bash
npx -y mcp-colombia-hub
```

---

## Security Model

| Threat | Defense |
|---|---|
| Someone learns your DID | DID is public — harmless without private key |
| Private key theft | Key lives in `~/.soulprint/` (mode 0600) |
| Fake cedula image | Face match required |
| Register twice | Nullifier uniqueness on validator network |
| Replay attack | Token expires in 24h + context_tag per service |
| Sybil attack | Biometric nullifier — same face = same nullifier |
| DID substitution attack | Ed25519 signature bound to DID keypair |

---

## Roadmap

```
✅ Phase 1 — Local verification (cedula OCR + face match + nullifier)
✅ Phase 2 — ZK proofs (Circom circuit + snarkjs prover/verifier)
✅ Phase 3 — Validator nodes (HTTP + ZK verify + anti-Sybil registry)
✅ Phase 4 — SDKs (soulprint-mcp, soulprint-express)
🚧 Phase 5 — P2P network (libp2p DHT, multi-node consensus)
🚧 Phase 6 — Multi-country support (passport, DNI, CURP, RUT...)
🔮 Phase 7 — On-chain nullifier registry (optional, EVM-compatible)
```

---

## Protocol Spec

See [specs/SIP-v0.1.md](specs/SIP-v0.1.md) for the Soulprint Identity Protocol specification.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All countries welcome — add your ID document format in `packages/verify-local/src/document/`.

---

## License

MIT — free for personal and commercial use.

---

*Built for the age of AI agents. Every bot has a soul behind it.*
