# 🔐 Soulprint

**Decentralized KYC identity protocol for AI agents.**

Soulprint lets any AI bot prove there's a verified human behind it — without revealing who that human is. No companies, no servers, no paid APIs. Just cryptographic proof.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[[![npm soulprint](https://img.shields.io/npm/v/soulprint?label=soulprint&color=blue)](https://npmjs.com/package/soulprint)
[![npm soulprint-mcp](https://img.shields.io/npm/v/soulprint-mcp?label=soulprint-mcp&color=purple)](https://npmjs.com/package/soulprint-mcp)
![Phase](https://img.shields.io/badge/v0.3.9-phases%201--5%20%2B%20hardened-brightgreen-brightgreen)()
[![npm soulprint-network](https://img.shields.io/npm/v/soulprint-network?label=soulprint-network&color=7c6cf5)](https://npmjs.com/package/soulprint-network)[![Built with](https://img.shields.io/badge/built%20with-Circom%20%2B%20snarkjs%20%2B%20InsightFace-purple)]()

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

### With DPoP — prevent token theft (v0.3.8)

```typescript
// ── Server side — strict mode ─────────────────────────────────────
server.use(soulprint({ minScore: 60, requireDPoP: true }));
// → 401 { error: "dpop_required" } if no proof header

// ── Client side — sign every request ─────────────────────────────
import { signDPoP, serializeDPoP } from "soulprint-core";

// Load your keypair (never transmit the private key)
const { privateKey, did } = loadKeypair();
const myToken = "<your-SPT>";

// Before each tool call:
const proof = signDPoP(privateKey, did, "POST", toolUrl, myToken);
headers["X-Soulprint"]       = myToken;
headers["X-Soulprint-Proof"] = serializeDPoP(proof);
```

A stolen SPT is **useless** without the private key. The proof is:
- Unique per request (random nonce)
- URL + method bound (no MITM)
- Expires in 5 minutes
- Hash-bound to the specific token

---

## Protect Any REST API

```typescript
import express from "express";
import { soulprint } from "soulprint-express";

const app = express();

// Protect entire API
app.use(soulprint({ minScore: 40 }));

// Strict: require DPoP proof (prevent token theft)
app.use(soulprint({ minScore: 65, requireDPoP: true }));

// Or specific routes
app.post("/sensitive", soulprint({ require: ["DocumentVerified", "FaceMatch"] }), handler);

// Access the verified identity + check if token was auto-renewed
app.get("/me", soulprint({ minScore: 20 }), (req, res) => {
  const renewedToken = res.getHeader("X-Soulprint-Token-Renewed");
  res.json({
    nullifier: req.soulprint!.nullifier,  // unique per human, no PII
    score:     req.soulprint!.score,
    ...(renewedToken ? { token_renewed: renewedToken } : {}),
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

## Run a Validator Node

Anyone can run a validator node. Each node runs **two stacks simultaneously**: HTTP (port 4888) + libp2p P2P (port 6888).

```bash
# Arranque simple — mDNS descubre nodos en la misma LAN automáticamente
npx soulprint node

# Con bootstrap nodes para conectar a la red global
SOULPRINT_BOOTSTRAP=/ip4/x.x.x.x/tcp/6888/p2p/12D3KooW... \
npx soulprint node
```

Output esperado:
```
🌐 Soulprint Validator Node v0.2.2
   Node DID:     did:key:z6Mk...
   Listening:    http://0.0.0.0:4888

🔗 P2P activo
   Peer ID:    12D3KooW...
   Multiaddrs: /ip4/x.x.x.x/tcp/6888/p2p/12D3KooW...
   Gossip:     HTTP fallback + GossipSub P2P
   Discovery:  mDNS (+ DHT si hay bootstraps)
```

Node API:
```
GET  /info              — node info + p2p stats (peer_id, peers, multiaddrs)
POST /verify            — verify ZK proof + co-sign SPT
POST /reputation/attest — issue +1/-1 attestation (propagado via GossipSub)
GET  /reputation/:did   — get bot reputation
GET  /nullifier/:hash   — check anti-Sybil registry
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

| Package | Version | Description | Install |
|---|---|---|---|
| [`soulprint-core`](packages/core) | `0.1.6` | DID, SPT tokens, Poseidon nullifier, PROTOCOL constants, anti-farming | `npm i soulprint-core` |
| [`soulprint-verify`](packages/verify-local) | `0.1.4` | OCR + face match (on-demand), biometric thresholds from PROTOCOL | `npm i soulprint-verify` |
| [`soulprint-zkp`](packages/zkp) | `0.1.5` | Circom circuit + snarkjs prover, face_key via PROTOCOL.FACE_KEY_DIMS | `npm i soulprint-zkp` |
| [`soulprint-network`](packages/network) | `0.2.2` | Validator node: HTTP + P2P + credential validators + anti-farming | `npm i soulprint-network` |
| [`soulprint-mcp`](packages/mcp) | `0.1.5` | MCP middleware (3 lines) | `npm i soulprint-mcp` |
| [`soulprint-express`](packages/express) | `0.1.3` | Express/Fastify middleware | `npm i soulprint-express` |
| [`soulprint`](packages/cli) | `0.1.3` | `npx soulprint` CLI | `npm i -g soulprint` |

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

Attestations propagate **P2P across all validator nodes** via libp2p GossipSub (with HTTP fallback for legacy nodes).

---

## Anti-Farming Protection (v0.3.5)

The reputation system is protected against point farming. **Detected farming → automatic -1 penalty** (not just rejection).

Rules enforced by all validator nodes (`FARMING_RULES` — `Object.freeze`):

| Rule | Limit |
|---|---|
| Daily gain cap | Max **+1 point/day** per DID |
| Weekly gain cap | Max **+2 points/week** per DID |
| New DID probation | DIDs < 7 days need **2+ existing attestations** before earning |
| Same-issuer cooldown | Max 1 reward/day from the same service |
| Session duration | Min **30 seconds** |
| Tool entropy | Min **4 distinct tools** used |
| Robotic pattern | Call interval stddev < 10% of mean → detected as bot |

```typescript
// Example: attacker trying to farm +1 every 60s
// Result: +1 → converted to -1 (automatic penalty)
POST /reputation/attest
{ did, value: 1, context: "normal-usage", session: { duration: 8000, tools: ["search","search","search"] } }
// → { value: -1, farming_detected: true, reason: "robotic-pattern" }
```

---

## Credential Validators (v0.3.5)

Every validator node ships with **3 open-source credential verifiers** — no API keys required:

### 📧 Email OTP (nodemailer)
```bash
POST /credentials/email/start   { did, email }
# → OTP sent to email (dev: Ethereal preview, prod: any SMTP)
POST /credentials/email/verify  { sessionId, otp }
# → issues credential:EmailVerified attestation, gossiped P2P
```

### 📱 Phone TOTP (RFC 6238 — no SMS, no API key)
```bash
POST /credentials/phone/start   { did, phone }
# → returns totpUri — scan with Google Authenticator / Authy / Aegis
POST /credentials/phone/verify  { sessionId, code }
# → issues credential:PhoneVerified attestation
```

### 🐙 GitHub OAuth (native fetch)
```bash
GET /credentials/github/start?did=...
# → redirects to github.com OAuth
GET /credentials/github/callback
# → issues credential:GitHubLinked attestation with github.login
```
Config: `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` + `SOULPRINT_BASE_URL`

---

## Protocol Constants (v0.3.5)

All critical values are **immutable at runtime** via `Object.freeze()` in `soulprint-core`. Changing them requires a new SIP (Soulprint Improvement Proposal) and a protocol version bump.

```typescript
import { PROTOCOL } from 'soulprint-core';

PROTOCOL.FACE_SIM_DOC_SELFIE    // 0.35 — min similarity document vs selfie
PROTOCOL.FACE_SIM_SELFIE_SELFIE // 0.65 — min similarity selfie vs selfie (liveness)
PROTOCOL.FACE_KEY_DIMS          // 32   — embedding dimensions for face_key
PROTOCOL.FACE_KEY_PRECISION     // 1    — decimal precision (absorbs ±0.01 noise)
PROTOCOL.SCORE_FLOOR            // 65   — minimum score any service can require
PROTOCOL.VERIFIED_SCORE_FLOOR   // 52   — floor for DocumentVerified identities
PROTOCOL.MIN_ATTESTER_SCORE     // 65   — minimum score to issue attestations
PROTOCOL.VERIFY_RETRY_MAX       // 3    — max retries for remote verification
```

> These constants are **write-protected** — `PROTOCOL.FACE_SIM_DOC_SELFIE = 0.1` throws at runtime.

---

## Live Ecosystem — mcp-colombia-hub

[mcp-colombia-hub](https://github.com/manuelariasfz/mcp-colombia) is the **first verified service** in the Soulprint ecosystem:

- **Service score:** 80 (DocumentVerified + FaceMatch + GitHubLinked + BiometricBound)
- **Auto-issues -1** when a bot spams (>5 req/60s)
- **Auto-issues +1** when a bot completes 3+ tools normally
- **Premium endpoint `trabajo_aplicar`** requires score ≥ 40

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
✅ Phase 5 — P2P network (libp2p v2 · Kademlia DHT + GossipSub + mDNS · soulprint-network@0.2.2)
✅ v0.3.7 — Challenge-Response peer integrity · snarkjs critical fix · SPT auto-renewal
✅ v0.3.5 — Anti-farming engine · Credential validators (email/phone/GitHub) · Biometric PROTOCOL constants
🚧 Phase 6 — Multi-country support (passport, DNI, CURP, RUT...)
🔮 Phase 7 — On-chain nullifier registry (optional, EVM-compatible)
```

---


### Phase 5f — Auto-Renewal of SPT (v0.3.6) ✅

SPTs (Soulprint Protocol Tokens) now renew automatically — no more downtime when a 24-hour token expires.

#### How it works

```
[Bot SDK] ──detects near-expiry──► POST /token/renew ──► [Validator Node]
                                        ↑ current SPT           ↓ fresh SPT (24h)
[Middleware] ◄─── X-Soulprint-Token-Renewed: <new_spt> ─────────┘
```

**Renewal windows:**
| Scenario | Window | Action |
|---|---|---|
| Token valid, < 1h remaining | Pre-emptive | Auto-renew |
| Token expired < 7 days ago | Grace period | Auto-renew |
| Token expired > 7 days ago | Stale | Full re-verification required |

#### Validator endpoint

```bash
POST /token/renew
Body: { "spt": "<current_token>" }

Response 200: {
  "spt": "<new_token>",
  "expires_in": 86400,
  "renewed": true,
  "method": "preemptive" | "grace_window"
}
```

#### Express middleware (automatic)

```typescript
import { soulprint } from "soulprint-express";

app.use(soulprint({
  minScore: 40,
  nodeUrl: "https://validator.soulprint.digital",  // enables auto-renew
}));

// New token arrives in response header if renewed:
// X-Soulprint-Token-Renewed: <new_spt>
// X-Soulprint-Expires-In: 86400
```

#### MCP middleware (automatic)

```typescript
import { requireSoulprint } from "soulprint-mcp";

server.use(requireSoulprint({
  minScore: 65,
  nodeUrl: "https://validator.soulprint.digital",
}));
// Renewed token propagated in context.meta["x-soulprint-token-renewed"]
```

#### Manual (any SDK)

```typescript
import { autoRenew, needsRenewal } from "soulprint-core";

const check = needsRenewal(currentSpt);
if (check.needsRenew) {
  const { spt, renewed } = await autoRenew(currentSpt, { nodeUrl });
  if (renewed) saveSpt(spt);  // persist the new token
}
```


### Phase 5g — Challenge-Response Peer Integrity + snarkjs Fix (v0.3.7) ✅

#### Critical bug fix — `soulprint-zkp@0.1.5`

`verifyProof()` was silently broken since v0.1.0. The snarkjs CJS module has `__esModule: true` but no `.default` property — TypeScript's `__importDefault` returned the module as-is, then code accessed `.default.groth16` which was `undefined`. All ZK proof verifications crashed at runtime.

```typescript
// ❌ Before (broken):
import snarkjs from "snarkjs";          // compiles to snarkjs_1.default.groth16 → undefined

// ✅ After (fixed):
import * as snarkjs from "snarkjs";     // compiles to snarkjs.groth16 ✅
```

#### Challenge-Response Protocol (`soulprint-network@0.3.7`)

Peers now cryptographically verify that remote nodes are running **unmodified ZK verification code** before accepting them into the network.

```
Challenger                          Peer
    │                                 │
    │── POST /challenge ─────────────►│
    │   {challenge_id, nonce,         │
    │    valid_proof,                 │  verifyProof(valid_proof)   → true
    │    invalid_proof}               │  verifyProof(invalid_proof) → false
    │                                 │  sign(results, node_key)
    │◄── {result_valid: true, ────────│
    │     result_invalid: false,      │
    │     signature: Ed25519(...)}    │
    │                                 │
    │  verify signature ✅            │
    │  result_valid == true ✅        │
    │  result_invalid == false ✅     │
    │                                 │
    │  → PEER ACCEPTED                │
```

**Attacks blocked:**

| Attack | Detection |
|--------|-----------|
| ZK always returns `true` (bypass) | `invalid_proof` must return `false` |
| ZK always returns `false` (broken) | `valid_proof` must return `true` |
| Pre-computed / cached response | Fresh random `nonce` makes `invalid_proof` unique per challenge |
| Node impersonation | Ed25519 signature tied to `node_did` |
| Replay attack | 30-second TTL on challenges |

**Invalid proof generation** — the challenger mutates the valid proof with a random nonce:
```
invalid_proof.pi_a[0] = (valid_proof.pi_a[0] + nonce) mod p
```
This produces a cryptographically invalid proof that snarkjs will always reject — but it's unpredictable without the nonce.

**Automatic peer verification** — `POST /peers/register` now runs `verifyPeerBehavior()` before accepting any peer. A peer with modified ZK code is rejected with HTTP 403.

### Phase 5h — DPoP: Demonstrating Proof of Possession (v0.3.8) ✅

SPT tokens are bearer tokens — stolen tokens could be used until expiry (24h). **DPoP** closes this window by requiring a fresh cryptographic proof with every request.

```
Without DPoP:  stolen SPT → attacker calls API → SUCCESS ✗
With DPoP:     stolen SPT → attacker has no private key → 401 ✓
```

**How it works:**

Every request carries `X-Soulprint-Proof` — a payload signed with the user's Ed25519 private key:

```typescript
{
  typ:      "soulprint-dpop",
  method:   "POST",           // HTTP method — bound
  url:      "https://...",    // exact URL — bound
  nonce:    "a3f1b2...",      // 16 random bytes — unique per request
  iat:      1740000000,       // expires in 5 minutes
  spt_hash: sha256(spt),      // bound to THIS specific token
}
// Signed: Ed25519(sha256(JSON.stringify(payload)), privateKey)
```

**Attacks blocked (8):** token theft, replay, URL MITM, method MITM, DID mismatch, expired proof, malformed proof, foreign token reuse.

**API:**
```typescript
import { signDPoP, verifyDPoP, serializeDPoP, NonceStore } from "soulprint-core";

const proof  = signDPoP(privateKey, did, "POST", url, spt);
const header = serializeDPoP(proof);  // base64url string → X-Soulprint-Proof

const result = verifyDPoP(header, spt, "POST", url, nonceStore, sptDid);
// result.valid → bool | result.reason → string
```

---

### Phase 5i — MCPRegistry: Verified MCP Ecosystem (v0.3.9) ✅

A public on-chain registry of verified MCP servers. Agents can check whether a server is legitimate before trusting it.

**Contract:** `MCPRegistry.sol` on Base Sepolia  
**Address:** `0x59EA3c8f60ecbAe22B4c323A8dDc2b0BCd9D3C2a`  
**Admin:** Soulprint Protocol (not any individual MCP)

```
Unverified MCP:  agent connects → no guarantee → risk ✗
Verified MCP:    isVerified(0x...) → true on-chain → trusted ✓
```

**Registration flow:**
```bash
# 1. Any dev registers their MCP (permissionless)
curl -X POST http://soulprint-node/admin/mcp/register \
  -d '{ "ownerKey": "0x...", "address": "0x...",
        "name": "My Finance MCP", "url": "https://...", "category": "finance" }'

# 2. Soulprint admin reviews and verifies
curl -X POST http://soulprint-node/admin/mcp/verify \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -d '{ "address": "0x..." }'
# → on-chain tx → MCPVerified event → permanent record

# 3. Anyone checks
curl http://soulprint-node/mcps/verified
# → [{ name: "My Finance MCP", badge: "✅ VERIFIED", verified_at: "..." }]
```

**Check from code:**
```typescript
import { isVerifiedOnChain, getMCPEntry } from "soulprint-network";

const trusted = await isVerifiedOnChain("0x...");  // → true/false, on-chain

const entry = await getMCPEntry("0x...");
// → { name, url, category, verified, verified_at, badge: "✅ VERIFIED by Soulprint" }
```

**Architectural separation:**
```
Soulprint validator = protocol authority → admin endpoints (verify/revoke)
Individual MCPs     = participants → read-only (check status, list verified)
MCPRegistry.sol     = source of truth → on-chain, immutable, auditable
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
