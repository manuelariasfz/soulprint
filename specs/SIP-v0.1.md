# Soulprint Identity Protocol — SIP v0.1 (Draft)

## Abstract

SIP (Soulprint Identity Protocol) defines a standard for verifying the human identity behind any AI agent, bot, or automated process. It enables cryptographic proof of human identity without revealing personal data, using Zero-Knowledge Proofs and decentralized validator networks.

## Motivation

As AI agents become autonomous actors on the internet, services need to distinguish legitimate human-backed bots from anonymous or malicious ones. Existing KYC solutions require centralized infrastructure, paid APIs, and store sensitive personal data. SIP provides the same guarantees without any of these requirements.

## Terminology

- **Principal**: the human who owns and controls a bot/agent
- **Agent DID**: a Decentralized Identifier for the bot (`did:key:...`)
- **Nullifier**: a cryptographic commitment to the principal's identity, unique per person, non-reversible
- **SPT**: Soulprint Token — a signed credential containing trust score and nullifier, no PII
- **Validator**: a node in the Soulprint network that verifies ZK proofs

## Protocol Flow

```
1. VERIFY (local, on principal's device)
   a. OCR document → extract cedula_number, birthdate
   b. Face match selfie vs document → derive face_key
   c. Compute nullifier = Poseidon(cedula, birthdate, face_key)
   d. Generate ZK proof: "I know inputs such that Poseidon(inputs) = nullifier"
   e. Delete all raw biometric data

2. BROADCAST (P2P network)
   a. Principal broadcasts (nullifier, zkp_proof, did) to validator network
   b. 5 random validators verify the ZK proof (math only, no biometrics)
   c. 3/5 validators sign threshold attestation
   d. Attestation stored on IPFS

3. ISSUE (agent DID)
   a. Principal signs: "did:key:<agent> acts on behalf of <principal>"
   b. SPT issued: JWT with score, level, nullifier, no PII
   c. SPT lifetime: 24 hours (renewable automatically)

4. VERIFY (service side, offline)
   a. Service receives HTTP header: X-Soulprint: <SPT>
   b. Service resolves principal DID, checks threshold signature
   c. Service verifies SPT signature locally (<50ms, no internet)
   d. Service applies trust threshold: minScore, require level
```

## Token Format (SPT)

```typescript
interface SoulprintToken {
  sip:         "1";                  // protocol version
  did:         string;               // agent DID (did:key:...)
  score:       number;               // 0-100 trust score
  level:       TrustLevel;           // Unverified | EmailVerified | KYCLite | KYCFull
  country?:    string;               // ISO 3166-1 alpha-2
  credentials: CredentialType[];     // what was verified
  nullifier:   string;               // 0x + 64 hex chars, unique per human
  issued:      number;               // Unix timestamp
  expires:     number;               // Unix timestamp
  network_sig?: string;              // threshold signature from validators
}
```

## HTTP Binding

```
Request header: X-Soulprint: <base64url(SPT)>
```

## MCP Binding

```json
{
  "capabilities": {
    "identity": {
      "soulprint": "<base64url(SPT)>"
    }
  }
}
```

## Trust Registry

The trust registry is a JSON file maintained by the community:

```json
{
  "version": "1",
  "issuers": [
    {
      "id": "soulprint.network",
      "type": "ValidatorNetwork",
      "minValidators": 3,
      "publicKey": "0x..."
    }
  ]
}
```

## Bot Reputation Extension (v0.1.3)

### Overview

The reputation layer extends the trust score with a behavioral dimension:

```
Total Score (0–100) = Identity Score (0–80) + Bot Reputation (0–20)
```

### BotAttestation

A signed statement from a verified service (score ≥ 60) about a bot's behavior:

```typescript
{
  issuer_did:  string;   // service DID (must have score >= 60)
  target_did:  string;   // bot DID being rated
  value:       1 | -1;   // reward (+1) or penalty (-1)
  context:     string;   // e.g. "spam-detected", "normal-usage"
  timestamp:   number;   // unix seconds
  sig:         string;   // Ed25519(payload, issuer_privateKey)
}
```

### Reputation computation

```
score = clamp(base + sum(valid_attestations.value), 0, 20)
```

Where `valid_attestation` means: Ed25519 signature verified AND not a duplicate.

### Validator endpoint

```
POST /reputation/attest
body: { attestation: BotAttestation, service_spt: string }

Guards:
  service_spt.score >= 60
  service_spt.did == attestation.issuer_did
  verifyAttestation(attestation) === true
  attestation age < 3600 seconds
  not a duplicate (issuer_did, timestamp, context)

Side effects:
  store attestation locally
  gossip dual-channel:
    1. libp2p GossipSub (soulprint:attestations:v1) — primary
    2. HTTP fire-and-forget to HTTP peers — fallback for legacy nodes
```

### Anti-Sybil for reputation

A low-reputation bot cannot recover by creating a new DID — the new DID starts at 10 (neutral), not at the old score. Services choosing to trust only bots with score ≥ X ensure new/unknown bots are excluded from sensitive operations.

---

## Security Considerations

1. **Privacy**: ZK proof reveals nothing about the human's identity
2. **Sybil resistance**: nullifier derived from biometrics prevents multiple registrations per person
3. **Key loss**: KYC allows re-issuance if private key is lost
4. **Revocation**: principal can revoke their agent DID at any time
5. **Validator compromise**: threshold (3/5) prevents single-validator attacks
6. **Reputation gaming**: only services with score ≥ 60 can issue attestations; max score clamped at 20
7. **Attestation forgery**: Ed25519 sig bound to issuer_did; tampered attestations always fail verification

## P2P Network Extension (v0.2.0 — Fase 5)

### Overview

Each validator node now runs a dual-stack: HTTP (port 4888) + libp2p (port 6888).

```
Gossip channel priority:
  1. libp2p GossipSub  — primary, internet-wide
  2. HTTP fire-and-forget — fallback for legacy nodes
```

### libp2p Stack

| Component | Package | Role |
|---|---|---|
| Transport | `@libp2p/tcp` | TCP connections |
| Encryption | `@chainsafe/libp2p-noise` | Noise protocol (E2E) |
| Muxing | `@chainsafe/libp2p-yamux` | Stream multiplexing |
| DHT | `@libp2p/kad-dht` | Kademlia peer routing |
| PubSub | `@chainsafe/libp2p-gossipsub` | Attestation broadcast |
| Discovery | `@libp2p/mdns` | LAN auto-discovery |
| Bootstrap | `@libp2p/bootstrap` | Internet entry points |

### PubSub Topics

```
soulprint:attestations:v1  — BotAttestation JSON messages
soulprint:nullifiers:v1    — reserved (future anti-Sybil)
```

### Peer Discovery

```
1. mDNS (zero config) — discovers nodes on same LAN automatically
2. Bootstrap (SOULPRINT_BOOTSTRAP env var) — internet entry points
3. Kademlia DHT — routing table maintained continuously
```

### Node Identity

Each node generates a persistent Ed25519 keypair at startup:
- Stored at `~/.soulprint/node/node-identity.json`
- Peer ID derived from public key (multihash format: `12D3KooW...`)
- Multiaddr: `/ip4/<ip>/tcp/<p2p-port>/p2p/<peer-id>`

### Anti-loop (GossipSub native)

GossipSub maintains a `seen-messages` cache per `message-id`. Unlike the HTTP
gossip which uses `X-Gossip: 1` headers, GossipSub never re-forwards a message
it has already seen — this is guaranteed by the protocol.

---

## Anti-Farming Extension (v0.3.0)

All validator nodes enforce `FARMING_RULES` (immutable via `Object.freeze()`). Farming attempts are **penalized (-1)**, not just rejected.

Key rules: max +1/day, max +2/week, min 30s session, min 4 distinct tools, robotic call patterns (interval stddev/mean < 10%) → penalty.

DIDs under 7 days old are in **probation**: they cannot earn points until they have 2+ existing attestations.

---

## Credential Validators Extension (v0.3.0)

Validator nodes ship 3 open-source credential verifiers under `/credentials/`:

| Endpoint | Method | Technology |
|---|---|---|
| `/credentials/email/start` + `/verify` | POST | nodemailer + crypto.randomInt |
| `/credentials/phone/start` + `/verify` | POST | otpauth RFC 6238 (no SMS) |
| `/credentials/github/start` + `/callback` | GET | GitHub OAuth + native fetch |

Each verified credential issues a `BotAttestation` with context `credential:<Type>`, signed by the node keypair, gossiped to all peers.

---

## Biometric Protocol Constants Extension (v0.3.0)

Biometric thresholds are now part of `PROTOCOL` (`Object.freeze()`), mandatory for all implementations:

| Constant | Value | Rationale |
|---|---|---|
| `FACE_SIM_DOC_SELFIE` | `0.35` | Validated: real cédula CO + selfie → 0.365 ✅ |
| `FACE_SIM_SELFIE_SELFIE` | `0.65` | Stricter: live photos, same quality |
| `FACE_KEY_DIMS` | `32` | First 32 dims balance uniqueness vs speed |
| `FACE_KEY_PRECISION` | `1` | 1 decimal = 0.1 steps, absorbs ±0.01 InsightFace noise |

Threshold rationale: a completely different person scores < 0.15 with buffalo_sc. A same-person doc-vs-selfie with an older photo scores ~0.35–0.42.

---

## Implementations

- **Reference (TypeScript)**: https://github.com/manuelariasfz/soulprint
- **First verified service**: https://github.com/manuelariasfz/mcp-colombia
- **Circuit**: Groth16 over BN128, Circom 2.1.8
- **Hash function**: Poseidon (ZK-friendly, 3 inputs)
- **Architecture**: [ARCHITECTURE.md](../ARCHITECTURE.md)

## Status


## BFT P2P Consensus Extension (v0.3.5)

Decentralized nullifier registration and attestation propagation without a blockchain.

### NullifierConsensus Protocol

Three-phase protocol over encrypted GossipSub:

```
Phase 1 — PROPOSE:
  { type, nullifier, did, proofHash, proposerDid, ts, protocolHash, sig }

Phase 2 — VOTE (from each receiving node):
  { type, nullifier, vote: "accept"|"reject", voterDid, ts, protocolHash, sig }

Phase 3 — COMMIT (when N/2+1 accepts received):
  { type, nullifier, did, votes[], commitDid, ts, protocolHash, sig }
```

**Quorum:** `floor(connectedPeers / 2) + 1`  
**Single mode:** triggered when `connectedPeers === 0` — immediate local commit  
**Timeout:** 10 seconds per round; client retries on timeout

### AttestationConsensus Protocol

No multi-round needed — Ed25519 signature provides non-repudiation:

```
ATTEST { type, issuerDid, targetDid, value: +1|-1, context, ts, protocolHash, sig }
```

Anti-farming enforced per-node:
- Cooldown: 24h per `issuerDid:targetDid` pair
- Cap: ≥7 attestations/week from same issuer → converts +1 to −1
- Anti-replay: `Set<msgHash>` — each message applied exactly once

### State Sync Protocol

New nodes sync state on startup:

```
GET /consensus/state-info  → { nullifierCount, attestationCount, protocolHash }
GET /consensus/state?page=N&since=TS  → { nullifiers[], attestations{}, reps{}, totalPages }
POST /consensus/message    → receive PROPOSE | VOTE | COMMIT | ATTEST (encrypted)
```

Protocol hash verified in handshake — incompatible nodes rejected immediately.

### Security Properties

| Property | Mechanism |
|---|---|
| Fault tolerance | Tolerates up to N/2 malicious nodes |
| Non-repudiation | Ed25519 signature on every consensus message |
| Network isolation | PROTOCOL_HASH checked on every message |
| Anti-replay | `seen: Set<msgHash>` — exactly-once semantics |
| ZK grounding | Each voter verifies the ZK proof locally (deterministic) |


## Blockchain Backup Extension (v0.3.5)

Async anchoring of P2P-committed data to EVM blockchain (Base Sepolia/mainnet).

### Architecture

```
P2P BFT COMMIT (primary, ~2s, $0)
    └──▶ BlockchainAnchor.anchorNullifier() [async, non-blocking]
         ├── retry x3: 0s → 2s → 8s backoff
         ├── success: tx hash logged
         └── 3 fails → blockchain-queue.json (flushed every 60s)
```

### Deployed Contracts — Base Sepolia (chainId: 84532)

| Contract | Address |
|---|---|
| ProtocolConstants | `0x20EEeFe3e59e6c76065A3037375053e7A9c94529` |
| SoulprintRegistry | `0xE6F804c3c90143721A938a20478a779F142254Fd` |
| AttestationLedger | `0xD91595bbb8f649e4E3a14cF525cC83D098FEfE57` |
| ValidatorRegistry | `0xE9418dBF769082363e784de006008b1597F5EeE9` |
| Groth16Verifier   | `0x21D65c437eC2C024339eA97e7739387Fbe854381` (mock) |

### Configuration

```bash
SOULPRINT_RPC_URL=https://sepolia.base.org
SOULPRINT_PRIVATE_KEY=0x<deployer_key>
SOULPRINT_NETWORK=base-sepolia
```

### Fault tolerance

- P2P-only mode if no blockchain config (no downtime)
- Queue persists to disk on failure (blockchain-queue.json)
- Flush retry every 60s on reconnection
- `NullifierAlreadyUsed` on-chain → idempotent (not an error)


---

**Draft — v0.3.5**. Phases 1–5 complete + anti-farming + credential validators + biometric PROTOCOL constants + BFT P2P consensus (sin blockchain).  
Phase 6 (multi-country expansion) in progress.

Feedback welcome: open an issue at https://github.com/manuelariasfz/soulprint/issues
