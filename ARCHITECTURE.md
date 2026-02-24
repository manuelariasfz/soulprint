# Soulprint — Architecture (v0.1.3)

> Complete technical reference for the Soulprint Identity Protocol.  
> For the formal protocol spec, see [specs/SIP-v0.1.md](specs/SIP-v0.1.md).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Trust Score Model](#2-trust-score-model)
3. [Component Map](#3-component-map)
4. [Identity Layer — ZK Verification](#4-identity-layer--zk-verification)
5. [Token Format — SPT](#5-token-format--spt)
6. [Bot Reputation Layer](#6-bot-reputation-layer)
7. [Validator Network](#7-validator-network)
8. [P2P Gossip Protocol](#8-p2p-gossip-protocol)
9. [Multi-Country Registry](#9-multi-country-registry)
10. [SDK Layer](#10-sdk-layer)
11. [Security Model](#11-security-model)
12. [Data Flow — Full Journey](#12-data-flow--full-journey)
13. [Package Dependency Graph](#13-package-dependency-graph)

---

## 1. Overview

Soulprint is a **decentralized KYC identity protocol** for AI agents. It answers one question:

> **Is there a verified human behind this bot — and has it behaved well?**

Without revealing who the human is.

### Core principles

| Principle | Implementation |
|---|---|
| **No PII stored** | Raw biometrics deleted after ZK proof generation |
| **No central authority** | P2P validator network; anyone can run a node |
| **No paid APIs** | All verification runs locally (Tesseract, InsightFace) |
| **Sybil resistant** | Poseidon nullifier — one person = one nullifier, always |
| **Composable** | 7 npm packages; use only what you need |

---

## 2. Trust Score Model

```
┌─────────────────────────────────────────────────────────┐
│                  TRUST SCORE  (0–100)                   │
│                                                          │
│   Identity Score (0–80)     +   Bot Reputation (0–20)   │
│   ─────────────────────         ──────────────────────  │
│   ZK-verified credentials       Behavioral attestations │
│   from real-world documents      from verified services  │
└─────────────────────────────────────────────────────────┘
```

### Identity credentials

| Credential | Points | Verification method |
|---|---|---|
| `EmailVerified` | 8 | Email confirmation link |
| `PhoneVerified` | 12 | SMS OTP |
| `GitHubLinked` | 16 | GitHub OAuth callback |
| `DocumentVerified` | 20 | Tesseract OCR + ICAO 9303 MRZ check digits |
| `FaceMatch` | 16 | InsightFace cosine similarity ≥ 0.6 |
| `BiometricBound` | 8 | Ed25519 keypair bound to device |
| **Maximum** | **80** | |

### Bot reputation tiers

| Score | Tier | Meaning |
|---|---|---|
| 0–9 | Penalized | Abuse history across services |
| 10 | Neutral | New bot, no behavioral history |
| 11–15 | Established | Verified activity on multiple services |
| 16–20 | Trusted | Excellent track record |

### Access levels by total score

| Total | Level | Typical access |
|---|---|---|
| 0–17 | Anonymous | Read-only, basic search |
| 18–35 | Partial | Standard API calls |
| 36–59 | Partial KYC | Document-gated features |
| 60–94 | KYCFull | Advanced integrations |
| **95–100** | **Premium** | **High-trust gated endpoints** |

---

## 3. Component Map

```
                        ┌──────────────────────────────────────────────────┐
                        │              soulprint (CLI)                     │
                        │  verify-me · show · renew · node · install-deps  │
                        └────────────────┬─────────────────────────────────┘
                                         │ uses
              ┌──────────────────────────┼───────────────────────────┐
              ▼                          ▼                           ▼
   ┌─────────────────┐       ┌─────────────────┐        ┌─────────────────┐
   │ soulprint-verify│       │  soulprint-zkp  │        │  soulprint-core │
   │                 │       │                 │        │                 │
   │ Tesseract OCR   │──────▶│ Circom circuit  │──────▶ │ DID keypair     │
   │ InsightFace     │       │ snarkjs Groth16 │        │ Ed25519 signing │
   │ EXIF/CLAHE      │       │ 844 constraints │        │ SPT token       │
   │ ICAO MRZ check  │       │ 564ms prove     │        │ Attestations    │
   │ Country registry│       │ 25ms verify     │        │ Score compute   │
   └─────────────────┘       └─────────────────┘        └────────┬────────┘
                                                                  │
              ┌───────────────────────────────────────────────────┤
              ▼                                                   ▼
   ┌─────────────────┐                               ┌─────────────────────┐
   │soulprint-network│◀──── P2P gossip ─────────────▶│soulprint-network    │
   │                 │                               │  (another node)     │
   │ REST API        │                               │                     │
   │ /verify         │                               │ Shared reputation   │
   │ /reputation/:did│                               │ Shared nullifiers   │
   │ /peers          │                               └─────────────────────┘
   │ /attest         │
   │ Persistence     │
   │ ~/.soulprint/   │
   └─────────────────┘
              ▲                    ▲
              │                   │
   ┌──────────┴────────┐  ┌───────┴──────────┐
   │  soulprint-mcp    │  │ soulprint-express │
   │                   │  │                  │
   │ MCP middleware    │  │ Express/Fastify   │
   │ server.use(...)   │  │ app.use(...)      │
   │ capabilities      │  │ req.soulprint     │
   └───────────────────┘  └──────────────────┘
```

---

## 4. Identity Layer — ZK Verification

### Step-by-step local verification

```
┌─────────────────────────────────────────────────────────────────────┐
│                    LOCAL DEVICE (never leaves)                      │
│                                                                     │
│  1. IMAGE PREPROCESSING                                             │
│     selfie.jpg ──▶ fix_exif_rotation()                              │
│                 ──▶ apply_clahe() (LAB channel L, clipLimit=2.0)    │
│                 ──▶ resize if > 1920px                              │
│                                                                     │
│  2. DOCUMENT OCR  (Tesseract)                                       │
│     cedula.jpg ──▶ extract MRZ lines 1 & 2                         │
│                ──▶ icaoCheckDigit() validates:                      │
│                       line1: document number (weight 7-3-1 mod 10)  │
│                       line2: DOB, expiry                            │
│                ──▶ parseMRZ() → { cedula_num, fecha_nac, ... }      │
│                                                                     │
│  3. FACE MATCH  (InsightFace, spawned on-demand, killed after)      │
│     selfie ──▶ embedding[512] ──▶ first 32 dims                    │
│     doc    ──▶ embedding[512] ──▶ first 32 dims                    │
│     cosine_similarity(emb1, emb2) ≥ 0.6  ──▶ pass                  │
│                                                                     │
│  4. FACE KEY DERIVATION  (deterministic across devices)             │
│     face_key = Poseidon_iterative(emb[0..31], step=0.1)            │
│     Same face ±noise → same face_key → same nullifier              │
│                                                                     │
│  5. ZK PROOF GENERATION  (Circom 2.1.8 + snarkjs Groth16)          │
│     Private inputs: cedula_num, fecha_nac, face_key, salt          │
│     Public  inputs: nullifier, context_tag                         │
│     Circuit: Poseidon(cedula, fecha_nac, face_key) == nullifier     │
│     Output:  { proof: {...}, publicSignals: [nullifier, tag] }      │
│     Time: ~564ms on a laptop                                        │
│                                                                     │
│  6. TOKEN ISSUANCE                                                  │
│     DID keypair = Ed25519 (generated once, stored at               │
│                   ~/.soulprint/keypair.json, mode 0600)            │
│     SPT = sign({ did, nullifier, credentials, score,               │
│                  bot_rep, expires: now+24h }, privateKey)           │
│     Store at ~/.soulprint/token.spt                                │
│                                                                     │
│  7. BIOMETRIC PURGE                                                 │
│     InsightFace process killed                                      │
│     Raw embeddings freed from memory                               │
│     Only token.spt remains                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### ZK Circuit — soulprint_identity.circom

```
Inputs (private):
  cedula_num   [64-bit]  — ID number from MRZ
  fecha_nac    [32-bit]  — birthdate YYMMDD from MRZ
  face_key     [252-bit] — Poseidon hash of face embedding
  salt         [252-bit] — random per verification

Inputs (public):
  nullifier    [252-bit] — Poseidon(cedula, fecha_nac, face_key)
  context_tag  [252-bit] — service-specific binding (anti-replay)

Constraints: 844
Proving key:  soulprint_identity_final.zkey
Verify key:   verification_key.json
Algorithm:    Groth16 (BN128 curve)
Proof time:   ~564ms
Verify time:  ~25ms (offline)
```

---

## 5. Token Format — SPT

The **Soulprint Token (SPT)** is a base64url-encoded JSON payload signed with Ed25519.

```typescript
interface SoulprintToken {
  // Identity
  did:            string;       // "did:key:z6Mk..." — Ed25519 public key
  nullifier:      string;       // "0x..." — Poseidon hash, unique per human
  credentials:    string[];     // ["DocumentVerified","FaceMatch",...]

  // Scores
  identity_score: number;       // 0–80 (sum of credential weights)
  score:          number;       // 0–100 (identity_score + bot_rep.score)
  level:          string;       // "Anonymous"|"EmailOnly"|"KYCPartial"|"KYCFull"

  // Reputation
  bot_rep: {
    score:        number;       // 0–20 (behavioral attestations, default=10)
    attestations: number;       // total received
    last_updated: number;       // unix timestamp
  };

  // ZK Proof
  zkp: {
    proof:         object;      // Groth16 proof
    publicSignals: string[];    // [nullifier, context_tag]
  };

  // Metadata
  country:        string;       // "CO"|"MX"|"AR"|...
  issued_at:      number;       // unix timestamp
  expires:        number;       // issued_at + 86400 (24h)

  // Signature
  sig:            string;       // Ed25519(payload, privateKey) — hex
}
```

**Token lifecycle:**

```
Issue ──▶ [valid 24h] ──▶ renew (no re-verify needed)
                    └──▶ expire ──▶ re-verify required
```

**Token size:** ~700 bytes (uncompressed JSON)

---

## 6. Bot Reputation Layer

### Attestation format

```typescript
interface BotAttestation {
  issuer_did:  string;   // DID of issuing service
  target_did:  string;   // DID of bot being rated
  value:       1 | -1;   // reward or punishment
  context:     string;   // "spam-detected"|"normal-usage"|"payment-completed"
  timestamp:   number;   // unix seconds
  sig:         string;   // Ed25519(payload, service.privateKey)
}
```

### Reputation computation

```
computeReputation(attestations[], base=10):
  1. Filter: only attestations where verifyAttestation(att) === true
  2. Filter: deduplicate by (issuer_did, timestamp, context) — anti-replay
  3. score = base + sum(valid_att.value)
  4. clamp(score, 0, 20)
  5. return { score, attestations: valid_count, last_updated: now }
```

### Issuance security

```
POST /reputation/attest

Guards (all must pass):
  ✓ service_spt present in request body
  ✓ verifySoulprint(service_spt) === true
  ✓ service_spt.score >= 60
  ✓ service_spt.did === attestation.issuer_did
  ✓ verifyAttestation(attestation) === true
  ✓ attestation age < 3600 seconds
  ✓ not a duplicate (issuer_did, timestamp, context) tuple
```

### How reputation builds over time

```
Day 0   Bot created                                    score = 10 (neutral)
Day 1   mcp-colombia: 3 completions, no spam     ──▶  score = 11
Day 3   service-B: payment completed             ──▶  score = 12
Day 5   Bot spams service-C (>5 req/60s)         ──▶  score = 11
Day 7   mcp-colombia: another normal usage       ──▶  score = 12
Day 30  Consistent good behavior, 5+ services    ──▶  score = 17
                                         Identity (80) + rep (17) = 97
                                         ──▶ PREMIUM ACCESS UNLOCKED
```

---

## 7. Validator Network

### Node architecture

```
soulprint-network (HTTP node)
│
├── GET  /health                    — liveness probe
├── POST /verify                    — verify SPT token
│     body: { token }
│     returns: { ok, ctx: { did, score, level, country } }
│
├── GET  /reputation/:did           — query reputation
│     returns: { did, score, attestations, last_updated }
│
├── POST /reputation/attest         — submit attestation
│     body: { attestation, service_spt }
│     guards: score>=60, sig valid, age<1h, no dup
│     side-effect: gossip to all peers
│
├── POST /peers/register            — join network
│     body: { url }
│     stores peer, returns known peers list
│
└── GET  /peers                     — list known peers
```

### Persistence

```
~/.soulprint/node/
├── reputation.json    — Map<did, ReputeEntry>
│     ReputeEntry = { score, attestations[], last_updated }
├── peers.json         — string[] (known peer URLs)
└── nullifiers.json    — Map<nullifier, did> (Sybil registry)
```

### Rate limiting

```
POST /reputation/attest — 10 requests / minute / IP
POST /verify            — 30 requests / minute / IP
GET  /reputation/*      — 60 requests / minute / IP
```

---

## 8. P2P Gossip Protocol

```
Node A receives valid attestation
    │
    ▼
Node A stores attestation locally
    │
    ▼
Node A fetches peers[] from peers.json
    │
    ▼
For each peer ≠ origin:
    │
    ├──▶ POST peer/reputation/attest
    │         headers: { "X-Gossip": "1" }
    │         body: { attestation }   // no service_spt needed for gossip
    │         timeout: 3000ms
    │         catch: ignore (fire-and-forget)
    │
    └──▶ (repeat for all peers in parallel)

Anti-loop: if X-Gossip: "1" header present, node stores but does NOT re-gossip
Anti-replay: duplicate (issuer_did, timestamp, context) tuples ignored
```

**Eventual consistency:** all nodes converge within seconds for small networks.

**Phase 5 roadmap:** replace HTTP gossip with libp2p DHT (Kademlia) for proper decentralization.

---

## 9. Multi-Country Registry

```
packages/verify-local/src/document/
├── verifier.interface.ts     — CountryVerifier interface
├── registry.ts               — getVerifier(), listCountries(), detectVerifier()
└── countries/
    ├── CO.ts   ── Full: OCR + MRZ + face match + ICAO check digits
    ├── MX.ts   ── Partial: INE card number + CURP format validation
    ├── AR.ts   ── Partial: DNI 8-digit format
    ├── VE.ts   ── Partial: Cédula V/E prefix + numeric validation
    ├── PE.ts   ── Partial: DNI 8-digit format
    ├── BR.ts   ── Partial: CPF mod-11 double check digit
    └── CL.ts   ── Partial: RUN mod-11 check digit (special K handling)
```

### CountryVerifier interface

```typescript
interface CountryVerifier {
  countryCode:   string;               // ISO 3166-1 alpha-2
  countryName:   string;
  documentTypes: string[];             // ["cedula","passport",...]

  parse(ocrText: string): ParsedDocument | null;
  validate(docNumber: string): boolean;
  parseMRZ?(mrz: string): ParsedMRZ | null;       // optional
  quickValidate?(docNumber: string): boolean;      // optional, faster
}
```

### Adding a country (one PR)

```
1. Create packages/verify-local/src/document/countries/XX.ts
2. Add one import line in registry.ts
3. That's it — no other changes needed
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full guide with check digit examples.

---

## 10. SDK Layer

### soulprint-mcp — MCP middleware

```typescript
// Usage
server.use(soulprint({ minScore: 60 }));

// Internally:
// 1. Extract token from capabilities.identity.soulprint OR X-Soulprint header
// 2. Call verifySoulprint(token, minScore)
// 3. If ok: attach ctx to request context as _soulprint
// 4. If fail: return MCP error { isError: true, content: [{type:"text", text:"..."}] }

// ctx fields:
{
  did:      string,   // "did:key:z6Mk..."
  score:    number,   // 0-100
  level:    string,   // "KYCFull" etc.
  country:  string,   // "CO"
  identity: number,   // 0-80
  botRep:   number,   // 0-20
  nullifier: string,
}
```

### soulprint-express — REST middleware

```typescript
// Usage
app.use(soulprint({ minScore: 40 }));

// req.soulprint fields (same as ctx above)
// On failure: res.status(401).json({ error: "...", required_score: 40 })
```

### soulprint-core — primitives

```typescript
// Key functions
generateKeypair()                           → { did, publicKey, privateKey }
createToken(kp, nullifier, creds, opts)     → base64url SPT string
decodeToken(token)                          → SoulprintToken | null
verifySig(token)                            → boolean
createAttestation(kp, targetDid, val, ctx)  → BotAttestation
verifyAttestation(att)                      → boolean
computeReputation(atts[], base)             → BotReputation
calculateTotalScore(credentials, botRep)    → number (0-100)
defaultReputation()                         → { score:10, attestations:0, ... }
```

---

## 11. Security Model

### Threat matrix

| Threat | Attack vector | Defense |
|---|---|---|
| **Fake identity** | Submit forged document image | Face match required + ICAO check digits |
| **Register twice** | Two accounts, same person | Nullifier uniqueness: Poseidon(biometrics) = same nullifier |
| **Score inflation** | Modify token payload | Ed25519 signature verification — sig bound to full payload |
| **DID substitution** | Replace DID in token with attacker's DID | Sig bound to DID — mismatch = invalid |
| **Attestation forgery** | Create +1 attestation for own DID | Sig must come from registered service DID |
| **Low-rep service attesting** | Newly created service spams +1 | Node requires service_spt.score ≥ 60 |
| **Attestation flood** | 1000 +1 attestations from one service | score clamped to 20; rate limit 10/min/IP |
| **Replay attack** | Submit same attestation twice | Anti-replay: (issuer, timestamp, context) dedup |
| **Stale attestation** | Submit old attestation after behavior change | Max age: 1 hour |
| **Token replay** | Use someone else's valid token | Token expires 24h; context_tag per service |
| **Sybil via nullifier** | Multiple DIDs, same nullifier | Node registry: nullifier → exactly one DID |
| **Key theft** | Steal ~/.soulprint/keypair.json | Private key never transmitted; mode 0600 |

### What Soulprint does NOT protect against

- A bad actor who obtains a legitimate human's ID and selfie (forged documents)
- Collusion between multiple verified humans to share accounts
- Validator node compromise (mitigated by P2P — no single point of failure)

---

## 12. Data Flow — Full Journey

```
Principal (human)                    Bot (AI agent)             Service
      │                                   │                         │
      │ 1. npx soulprint verify-me        │                         │
      │    --selfie me.jpg                │                         │
      │    --document cedula.jpg          │                         │
      │                                   │                         │
      │ [LOCAL: OCR + face + ZK proof]    │                         │
      │ → token.spt (~700 bytes)          │                         │
      │                                   │                         │
      │ 2. export SOULPRINT_TOKEN=...     │                         │
      │                                   │                         │
      │ 3. Launch bot with token ─────────▶                         │
      │                                   │                         │
      │                                   │ 4. Call tool            │
      │                                   │  capabilities:{         │
      │                                   │    identity:{           │
      │                                   │     soulprint: <token>  │
      │                                   │    }                    │
      │                                   │  }                      │──▶ extractToken()
      │                                   │                         │    verifySoulprint()
      │                                   │                         │    → { ok, ctx }
      │                                   │                         │
      │                                   │                         │ 5. trackRequest(did, tool)
      │                                   │                         │    → { allowed: true }
      │                                   │                         │
      │                                   │◀── tool result ─────────│
      │                                   │                         │
      │                                   │                         │ 6. trackCompletion(did, tool)
      │                                   │                         │    if (3+ tools, no spam):
      │                                   │                         │      issueAttestation(did, +1)
      │                                   │                         │      POST /reputation/attest
      │                                   │                         │      → gossip to all nodes
      │                                   │                         │
      │                                   │                         │ [score: 10 → 11]
      │                                   │                         │
      │ 7. npx soulprint renew            │                         │
      │    → new token with score=91      │                         │
      │      (80 identity + 11 rep)       │                         │
```

---

## 13. Package Dependency Graph

```
soulprint (CLI)
    ├── soulprint-verify    (OCR + face match)
    │       └── soulprint-core
    ├── soulprint-zkp       (Circom + snarkjs)
    │       └── soulprint-core
    └── soulprint-network   (validator node)
            └── soulprint-core

soulprint-mcp
    └── soulprint-core

soulprint-express
    └── soulprint-core

soulprint-core              (no Soulprint dependencies)
    ├── @noble/ed25519
    ├── bs58
    └── poseidon-lite (Poseidon hash)
```

---

## Appendix — File Structure

```
soulprint/
├── packages/
│   ├── cli/                    soulprint — CLI
│   │   └── src/
│   │       ├── commands/       verify-me, show, renew, node, install-deps
│   │       └── index.ts
│   ├── core/                   soulprint-core
│   │   └── src/
│   │       ├── did.ts          DID generation (Ed25519)
│   │       ├── token.ts        SPT create/decode/verify
│   │       ├── attestation.ts  create/verify BotAttestations
│   │       ├── reputation.ts   computeReputation, defaultReputation
│   │       ├── score.ts        calculateTotalScore, credential weights
│   │       └── index.ts
│   ├── verify-local/           soulprint-verify
│   │   └── src/
│   │       ├── face/           face_match.py (InsightFace on-demand)
│   │       ├── document/
│   │       │   ├── verifier.interface.ts
│   │       │   ├── registry.ts
│   │       │   ├── cedula-validator.ts    (CO — full, ICAO check digits)
│   │       │   └── countries/             CO, MX, AR, VE, PE, BR, CL
│   │       └── index.ts
│   ├── zkp/                    soulprint-zkp
│   │   ├── circuits/
│   │   │   └── soulprint_identity.circom  (844 constraints)
│   │   ├── keys/
│   │   │   ├── soulprint_identity_final.zkey
│   │   │   └── verification_key.json
│   │   └── src/
│   │       ├── prove.ts        generateProof()
│   │       └── verify.ts       verifyProof()
│   ├── network/                soulprint-network
│   │   └── src/
│   │       ├── node.ts         HTTP server (Express)
│   │       ├── reputation.ts   store/load/query
│   │       ├── gossip.ts       P2P fire-and-forget
│   │       └── sybil.ts        nullifier registry
│   ├── mcp/                    soulprint-mcp
│   │   └── src/
│   │       └── middleware.ts   soulprint() MCP plugin
│   └── express/                soulprint-express
│       └── src/
│           └── middleware.ts   soulprint() Express plugin
├── tests/
│   ├── suite.js                104 unit + integration tests
│   ├── pentest-node.js         15 HTTP pen tests
│   └── zk-tests.js             16 ZK proof tests
├── specs/
│   └── SIP-v0.1.md             Formal protocol specification
├── website/
│   └── index.html              Landing page (GitHub Pages)
├── ARCHITECTURE.md             ← this file
├── CONTRIBUTING.md             Adding new countries
└── README.md
```

---

*Last updated: v0.1.3 — February 2026*  
*Protocol spec: [SIP-v0.1.md](specs/SIP-v0.1.md)*  
*GitHub: https://github.com/manuelariasfz/soulprint*
