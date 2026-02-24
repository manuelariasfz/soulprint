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

## Security Considerations

1. **Privacy**: ZK proof reveals nothing about the human's identity
2. **Sybil resistance**: nullifier derived from biometrics prevents multiple registrations per person
3. **Key loss**: KYC allows re-issuance if private key is lost
4. **Revocation**: principal can revoke their agent DID at any time
5. **Validator compromise**: threshold (3/5) prevents single-validator attacks

## Implementations

- **Reference (TypeScript)**: https://github.com/manuelariasfz/soulprint
- **Circuit**: Groth16 over BN128, Circom 2.1.8
- **Hash function**: Poseidon (ZK-friendly, 3 inputs)

## Status

This is a **draft spec**. Breaking changes are expected before v1.0.

Feedback welcome: open an issue at https://github.com/manuelariasfz/soulprint/issues
