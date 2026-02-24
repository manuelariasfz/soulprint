# 🔐 Soulprint

**Decentralized KYC identity protocol for AI agents.**

Soulprint lets any AI bot prove there's a verified human behind it — without revealing who that human is. No companies, no servers, no paid APIs. Just cryptographic proof.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Phase](https://img.shields.io/badge/phase-1%2F4%20%E2%80%94%20local%20verification-blue)]()
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
3. ZK proof broadcast to P2P validator network (5/8 nodes sign)
              ↓
4. Soulprint Token (SPT) issued — a signed JWT with trust score, no PII
              ↓
5. Any MCP server or API verifies in <50ms, offline, for free
```

**What the verifier knows:** ✅ Real human, verified Colombian ID  
**What the verifier doesn't know:** 🔒 Name, cedula number, face, birthdate

---

## Quick Start

### Install & Verify Your Identity

```bash
# Install Python dependencies (face recognition — one time)
npx soulprint install-deps

# Verify your identity (photos stay on your device)
npx soulprint verify-me \
  --selfie path/to/selfie.jpg \
  --document path/to/cedula.jpg

# Show your current Soulprint Token
npx soulprint show
```

### Protect Any MCP Server (3 lines)

```typescript
import { soulprint } from "@soulprint/mcp"

// Only verified humans can call this MCP
server.use(soulprint({ minScore: 60 }))
```

### Protect Any REST API

```typescript
import { soulprint } from "@soulprint/express"

app.use(soulprint({ minScore: 40, require: "KYCFull" }))
```

### Verify a Token Manually

```typescript
import { decodeToken } from "@soulprint/core"

const token = decodeToken(req.headers["x-soulprint"])
if (!token || token.score < 60) return res.status(403).json({ error: "Unverified bot" })
console.log(token.level)  // "KYCFull"
console.log(token.score)  // 80
// token does NOT contain name, cedula, or any PII
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4 — SDK (@soulprint/mcp, express, js, python)    │
├─────────────────────────────────────────────────────────┤
│  Layer 3 — P2P Validator Network (libp2p + IPFS)        │
├─────────────────────────────────────────────────────────┤
│  Layer 2 — ZK Proof (snarkjs + Circom + Poseidon)       │
├─────────────────────────────────────────────────────────┤
│  Layer 1 — Local Verification (Face + OCR on-demand)    │
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

## Monorepo Packages

| Package | Description | Status |
|---|---|---|
| [`@soulprint/core`](packages/core) | DID generation, SPT tokens, Poseidon nullifier | ✅ Done |
| [`@soulprint/verify-local`](packages/verify-local) | OCR + face match (on-demand subprocess) | ✅ Done |
| [`@soulprint/zkp`](packages/zkp) | Circom circuit + snarkjs prover/verifier | ✅ Done |
| [`@soulprint/cli`](packages/cli) | `npx soulprint verify-me` | ✅ Done |
| `@soulprint/network` | P2P validator nodes (libp2p) | 🚧 Phase 3 |
| `@soulprint/mcp` | MCP server middleware | 🚧 Phase 4 |
| `@soulprint/express` | Express/Fastify middleware | 🚧 Phase 4 |

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

```
soulprint verify-me
  → generates ZK proof locally
  → proof size: ~723 bytes
  → verifier knows: trust score, country, credential types
  → verifier does NOT know: name, cedula number, face data
```

### Anti-Sybil Protection

The nullifier is derived from **biometric + document data**, not a random secret:

```
nullifier = Poseidon(cedula_number, birthdate, face_key)
face_key  = Poseidon(quantized_face_embedding[0..31])
```

This means:
- Same person, different device → **same nullifier** (no double registration)
- Different person, same cedula → **different nullifier** (face doesn't match)
- Person registers twice → nullifier already exists → **rejected**

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
KYCFull (doc+face)  |  80/100
```

Services choose their own threshold:
```typescript
soulprint({ minScore: 20 })   // email verified is enough
soulprint({ minScore: 60 })   // require KYC
soulprint({ minScore: 80 })   // require full biometric KYC
```

---

## Soulprint Token (SPT) Format

A base64url-encoded signed JWT. **Contains no PII.**

```json
{
  "sip":         "1",
  "did":         "did:key:z6MkhaXgBZ...",
  "score":       80,
  "level":       "KYCFull",
  "country":     "CO",
  "credentials": ["DocumentVerified", "FaceMatch"],
  "nullifier":   "0x7090787188862170...",
  "issued":      1740000000,
  "expires":     1740086400,
  "sig":         "ed25519_signature"
}
```

---

## Supported Countries

| Country | Document | Status |
|---|---|---|
| 🇨🇴 Colombia | Cédula de Ciudadanía (MRZ + OCR) | ✅ Supported |
| 🌎 Others | Passport (ICAO TD3 MRZ) | 🚧 Planned |

---

## Development Setup

```bash
# Clone
git clone https://github.com/manuelariasfz/soulprint
cd soulprint

# Install (Node 18+)
pnpm install

# Build all packages
pnpm build

# Run ZK tests (no circuit compilation needed)
cd packages/zkp && node dist/prover.test.js

# Compile ZK circuit (first time only, ~2 min)
pnpm --filter @soulprint/zkp build:circuits
```

### Python dependencies (for face verification)

```bash
# Python 3.8+ required
pip3 install insightface opencv-python-headless onnxruntime

# Or use the CLI helper
npx soulprint install-deps
```

---

## Roadmap

```
✅ Phase 1 — Local verification (cedula OCR + face match + nullifier)
✅ Phase 2 — ZK proofs (Circom circuit + snarkjs prover/verifier)
🚧 Phase 3 — P2P validator network (libp2p + IPFS attestations)
🚧 Phase 4 — SDKs (@soulprint/mcp, express, js, python)
🔮 Phase 5 — Multi-country support (passport, DNI, etc.)
🔮 Phase 6 — DAO governance for trust registry
```

---

## Why Decentralized?

Most KYC solutions require:
- A company that processes your documents
- A server that stores your identity
- A fee per verification

**Soulprint requires:**
- Your device (for local verification)
- Other bots running Soulprint (for P2P consensus)
- An internet connection (for broadcasting the proof)

The network is the bots. The more people use it, the more secure it becomes.

---

## Security Model

| Threat | Defense |
|---|---|
| Someone learns your DID | DID is public — harmless without private key |
| Private key theft | Key lives in `~/.soulprint/` — only owner can read |
| Fake cedula image | Face match required — DeepFake detection planned |
| Register twice | Nullifier uniqueness on P2P network |
| Replay attack | Token expires in 24h + context_tag per service |
| Sybil attack | Biometric nullifier (same face = same nullifier) |
| Compromised validator | Threshold: 3/5 validators must agree |

---

## Contributing

```bash
# Run all tests
pnpm test

# Add a new country
# → packages/verify-local/src/document/<country>-validator.ts
# → Update the Circom circuit if the document structure differs
```

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT — free for personal and commercial use.

---

*Built for the age of AI agents. Every bot has a soul behind it.*
