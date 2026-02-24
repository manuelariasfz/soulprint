# Soulprint — Promotion Materials

All promotional content ready to copy-paste.

---

## 1. Hacker News — Show HN

**Title:** Show HN: Soulprint – ZK proof that a real human is behind your AI bot

**Post:**
```
AI agents are acting autonomously everywhere: booking flights, calling APIs, making decisions.
But there's no way to know if a bot is legitimate or just noise.

I built Soulprint — an open protocol that lets any AI bot cryptographically prove there's a
verified human behind it, without revealing who that human is.

How it works:
1. You run: npx soulprint verify-me --selfie me.jpg --document cedula.jpg
2. Locally, on your device: OCR reads the cedula, InsightFace matches your face
3. A Groth16 ZK proof is generated (Circom circuit, 844 constraints, 564ms)
4. A signed token is issued — no name, no cedula number, no biometric data
5. Any MCP server or REST API verifies in 25ms, offline, with 3 lines of code

The verifier knows: ✅ real human, ✅ valid Colombian ID, ✅ trust score
The verifier does NOT know: 🔒 name, 🔒 cedula number, 🔒 face, 🔒 birthdate

Anti-Sybil: the nullifier is derived from biometrics + document.
Same person = same nullifier on any device. Can't register twice.

Integrating into any MCP server:
  server.use(soulprint({ minScore: 60 }))

That's it.

GitHub: https://github.com/manuelariasfz/soulprint
npm: https://www.npmjs.com/package/soulprint
Spec: https://github.com/manuelariasfz/soulprint/blob/main/specs/SIP-v0.1.md

Currently supports Colombian cedula (TD1 MRZ). Passport support coming soon.
103/103 tests passing. MIT license.

Happy to discuss the ZK circuit design, the anti-Sybil approach, or the decentralized validator
network architecture.
```

---

## 2. Reddit — r/MachineLearning, r/artificial, r/ChatGPT

**Title:** I built an open KYC protocol for AI agents — ZK proof that a real human owns the bot

**Post:**
```
As AI agents become more autonomous, there's a growing problem: no service can tell if a bot
is legitimate or malicious. There's no accountability.

I spent the last week building Soulprint — an open protocol that solves this without any central
authority, paid APIs, or stored personal data.

**The idea:**
Any AI bot can prove it's backed by a real, verified human — using Zero-Knowledge Proofs.
The service knows you're human. It doesn't know WHO you are.

**How it works (3 phases):**
1. Local verification: OCR + face match on your device (insightface + tesseract, subprocess killed after)
2. ZK proof: Circom circuit proves "I verified my identity" without revealing the data
3. SPT token: signed JWT with trust score + ZK proof, valid 24h, no PII

**Anti-Sybil:**
`nullifier = Poseidon(cedula_number, birthdate, face_key)`
Same person → same nullifier on any device. You can't register twice.

**Integration:**
```typescript
// MCP server
server.use(soulprint({ minScore: 60 }))

// Express API
app.use(soulprint({ minScore: 40 }))
```

GitHub: https://github.com/manuelariasfz/soulprint
Live: https://manuelariasfz.github.io/soulprint/

Currently supports Colombian cedulas. Passport support and more countries coming.
```

---

## 3. Twitter/X Thread

**Tweet 1:**
```
I just shipped Soulprint — an open protocol for AI agent identity verification.

Your bot can prove there's a real human behind it.
Without revealing who that human is.

Zero servers. Zero paid APIs. Zero PII stored.

🧵 Thread:
```

**Tweet 2:**
```
The problem:

AI agents are autonomous everywhere.
But nobody knows if they're legitimate.

A bot books your flights. Calls your APIs.
Makes decisions on your behalf.

Is it backed by a real human? A script farm? A state actor?

There's no accountability. Until now.
```

**Tweet 3:**
```
How Soulprint works:

1. Run locally: `npx soulprint verify-me --selfie me.jpg --document cedula.jpg`
2. Tesseract OCR reads your ID. InsightFace matches your face.
3. ZK proof generated: "I verified my identity" — without revealing the data
4. Signed token issued. Valid 24h. ~723 bytes.

Your photos never leave your machine.
```

**Tweet 4:**
```
The ZK circuit (Circom):

Private inputs (nobody sees): cedula, birthdate, face_key, salt
Public inputs (verifier sees): nullifier, context_tag

Proof: Poseidon(cedula, birthdate, face_key) == nullifier

844 constraints. Groth16. 564ms to prove. 25ms to verify offline.
```

**Tweet 5:**
```
Anti-Sybil protection:

nullifier = Poseidon(cedula_number, birthdate, face_key)
face_key = Poseidon(quantized_face_embedding[0..31])

Same person + different device = same nullifier
Different person + same cedula = different nullifier (face doesn't match)

You can't register twice. Period.
```

**Tweet 6:**
```
The verifier knows:
✅ Real human
✅ Valid Colombian ID
✅ Trust score (0-100)
✅ Verification timestamp

The verifier does NOT know:
🔒 Name
🔒 Cedula number
🔒 Face data
🔒 Birthdate

This is the only thing privacy-preserving KYC should look like.
```

**Tweet 7:**
```
3 lines to protect any MCP server:

import { soulprint } from "soulprint-mcp"
server.use(soulprint({ minScore: 60 }))

That's it.

The bot includes the token in its capabilities.
You verify offline. No internet needed.
```

**Tweet 8:**
```
Open source, MIT.
7 packages on npm.
103/103 tests passing (including pen testing).

→ GitHub: github.com/manuelariasfz/soulprint
→ npm: npmjs.com/package/soulprint
→ Spec: SIP-v0.1 (Soulprint Identity Protocol)

"Every bot has a soul behind it."

What would you use this for?
```

---

## 4. Dev.to / Medium Article Title

"How I built a Zero-Knowledge KYC system for AI agents in a week (and published it on npm)"

**Subheading:** "Every AI bot should be able to prove there's a real human behind it — without revealing who."

---

## 5. LinkedIn Post

```
AI agents are acting autonomously everywhere.
But no service can tell if a bot is legitimate.

I built Soulprint — an open protocol that lets any AI agent prove 
there's a verified human behind it, using Zero-Knowledge Proofs.

The verifier knows: ✅ real human, ✅ verified ID, ✅ trust score
The verifier does NOT know: 🔒 name, 🔒 ID number, 🔒 face data

No servers. No paid APIs. No stored personal data.

→ npm install soulprint-mcp
→ server.use(soulprint({ minScore: 60 }))

That's it. Your MCP server now requires verified humans only.

GitHub: https://github.com/manuelariasfz/soulprint
Protocol Spec: SIP-v0.1

#AI #Privacy #ZeroKnowledge #KYC #Blockchain #OpenSource
```

---

## 6. Discord / Community Messages

**For MCP Discord:**
```
Hey! I just released Soulprint — a middleware for MCP servers that verifies the human identity
behind AI agents using ZK proofs.

3 lines to add it to any MCP server:
  import { soulprint } from "soulprint-mcp"
  server.use(soulprint({ minScore: 60 }))

The agent includes a ZK-verified token in its capabilities. You verify offline in 25ms.
No central server, no API keys.

npm: https://www.npmjs.com/package/soulprint-mcp
GitHub: https://github.com/manuelariasfz/soulprint
```

**For web3/ZK communities:**
```
I shipped an open KYC protocol for AI agents using Circom + snarkjs.

ZK circuit: proves Poseidon(cedula, birthdate, face_key) = nullifier
Without revealing cedula, birthdate, or face data.

844 constraints, Groth16, 564ms prove time, 25ms verify offline.
Anti-Sybil via biometric nullifier uniqueness.

Protocol spec (SIP-v0.1): https://github.com/manuelariasfz/soulprint/blob/main/specs/SIP-v0.1.md
npm: https://www.npmjs.com/package/soulprint-zkp
```

---

## 7. Product Hunt

**Name:** Soulprint
**Tagline:** ZK proof that a real human is behind your AI bot
**Description:**
```
AI agents are acting autonomously everywhere, but there's no accountability.
Soulprint is an open protocol that lets any AI bot prove there's a verified
human behind it — using Zero-Knowledge Proofs, with zero PII stored anywhere.

✅ Local verification (OCR + face match — never leaves your device)
✅ Groth16 ZK proof (Circom, 564ms generation, 25ms verification)
✅ Anti-Sybil (biometric nullifier — same person can't register twice)
✅ 3-line integration for MCP servers and REST APIs
✅ Open source (MIT), no servers, no paid APIs

npx soulprint verify-me --selfie me.jpg --document cedula.jpg
```

---

## 8. Awesome-MCP-Servers PR (punkpeye/awesome-mcp-servers)

Add to the `Identity & Security` section:
```markdown
- [Soulprint](https://github.com/manuelariasfz/soulprint) - 🔐 Decentralized KYC middleware for MCP servers. ZK proof that a real human is behind any AI agent. `npm i soulprint-mcp`
```

---

## Submission URLs

- HN: https://news.ycombinator.com/submit
- Reddit MachineLearning: https://www.reddit.com/r/MachineLearning/submit
- Reddit artificial: https://www.reddit.com/r/artificial/submit
- Product Hunt: https://www.producthunt.com/posts/new
- Dev.to: https://dev.to/new
- Smithery: https://smithery.ai (submit via glama.json / smithery.yaml)
- Glama: https://glama.ai/mcp/servers/submit
- MCP.so: https://mcp.so/submit
- awesome-mcp-servers PR: https://github.com/punkpeye/awesome-mcp-servers/pulls
