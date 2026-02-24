# Soulprint — Plan Completo

## Visión
Protocolo abierto y descentralizado para verificar que hay un humano real detrás de cualquier bot/agente IA. Sin empresas centrales, sin costos de infraestructura, sin guardar datos personales.

---

## Principios de diseño
1. **On-demand** — modelos ML cargan solo cuando se necesitan, luego se destruyen
2. **Zero-data** — ningún dato personal sale del dispositivo del usuario
3. **Zero-cost** — sin blockchain con gas, sin APIs de pago
4. **3-line integration** — cualquier MCP/API se protege en 3 líneas
5. **Open standard** — spec pública, cualquiera puede implementar

---

## Arquitectura de capas

```
┌─────────────────────────────────────────────────────────┐
│  CAPA 4 — SDK (@soulprint/mcp, express, js, python)     │
├─────────────────────────────────────────────────────────┤
│  CAPA 3 — Red P2P de validadores (libp2p + IPFS)        │
├─────────────────────────────────────────────────────────┤
│  CAPA 2 — ZK Proof (snarkjs + Circom/Semaphore)         │
├─────────────────────────────────────────────────────────┤
│  CAPA 1 — Verificación local (Face + OCR on-demand)     │
└─────────────────────────────────────────────────────────┘
```

---

## Estructura del monorepo

```
soulprint/
├── packages/
│   ├── core/              # DID + crypto + tipos base
│   ├── verify-local/      # Face + doc verification (ON-DEMAND subprocess)
│   │   ├── src/document/  # OCR + validación cédula colombiana
│   │   ├── src/face/      # Face match lazy (Python subprocess)
│   │   └── src/zkp/       # ZK proof generator
│   ├── network/           # Nodo P2P validador (libp2p)
│   ├── sdk-mcp/           # @soulprint/mcp (3 líneas)
│   ├── sdk-express/       # @soulprint/express
│   └── cli/               # npx soulprint verify-me
├── specs/
│   └── SIP-v0.1.md        # Soulprint Identity Protocol spec
└── apps/web/              # UI simple de verificación
```

---

## Solución Web3 sin costos

### El problema
Blockchain = gas = costos. IPFS solo = no hay consenso sobre nullifiers.

### La solución: Red de validadores como consenso
```
NO usamos blockchain para guardar nullifiers.
Los mismos nodos validadores SON el consenso.

Mecanismo:
  1. Usuario envía ZK proof a la red
  2. 5 nodos aleatorios verifican independientemente
  3. Cada nodo firma: hash(nullifier + timestamp + node_did)
  4. Threshold signature (3/5) = la "blockchain"
  5. Attestation guardada en IPFS (content-addressed = inmutable)
  6. CID del IPFS se replica entre todos los nodos = no hay punto central
```

### ¿Por qué es confiable?
- IPFS = contenido inmutable (si cambias 1 byte, el CID cambia)
- Threshold signatures = necesitas comprometer 3+ nodos a la vez
- Cada nodo guarda copia del estado → sin punto único de falla
- Nodo malicioso = expulsado por el resto (slashing por reputación)

### Escalabilidad
- IPFS escala horizontalmente (más nodos = más capacidad)
- Verificación = solo crypto local (~5ms)
- Sin bottleneck central
- 1M verificaciones/día = completamente manejable

---

## Módulo on-demand (crítico para rendimiento)

```
Estado normal (0 verificaciones activas):
  CLI/SDK daemon:     ~8MB RAM
  Modelos ML:         NO CARGADOS

Cuando alguien se verifica:
  spawn Python subprocess  ← carga InsightFace (~500MB, ~4s)
  ejecutar face match
  ejecutar OCR
  retornar resultado por stdout
  proceso termina → memoria liberada completamente

Tiempo total usuario: ~10 segundos
RAM permanente en sistema: ~8MB
```

---

## Roadmap por fases

### FASE 1 — Verificación Local (Semanas 1-2) ← EMPEZAMOS AQUÍ
- [ ] `packages/core` — DID key generation, crypto helpers
- [ ] `packages/verify-local/src/document` — OCR + validador cédula CO
- [ ] `packages/verify-local/src/face` — face match subprocess on-demand
- [ ] `packages/cli` — `soulprint verify-me` básico

### FASE 2 — ZK Proof (Semanas 3-4)
- [ ] Circuito Circom para nullifier (cedula + face embedding)
- [ ] Fuzzy extractor para face key derivation
- [ ] `snarkjs` proof generation + verification
- [ ] Nullifier único entre dispositivos

### FASE 3 — Red P2P (Semanas 5-6)
- [ ] Nodo validador con `libp2p`
- [ ] Protocolo de validación (threshold signatures con `@noble/curves`)
- [ ] Storage IPFS con `helia`
- [ ] Trust registry (lista de nodos conocidos)

### FASE 4 — SDK (Semanas 7-8)
- [ ] `@soulprint/core` — verify SPT token
- [ ] `@soulprint/mcp` — middleware MCP
- [ ] `@soulprint/express` — middleware REST
- [ ] Soulprint Token (SPT) format

### FASE 5 — Spec + Adopción (Semanas 9-10)
- [ ] SIP v0.1 spec document
- [ ] App web para usuarios finales
- [ ] Submit a W3C DID WG
- [ ] Integración de referencia con mcp-colombia-hub

---

## Stack técnico

| Capa | Tecnología | Por qué |
|---|---|---|
| Lenguaje base | TypeScript | Universal, npm ecosystem |
| ML (on-demand) | Python + InsightFace | Mejor face recognition open source |
| OCR | Tesseract.js (JS) o pytesseract | Sin subprocess para docs |
| ZK Proofs | snarkjs + Circom | Standard de facto JS |
| Identidad anónima | Semaphore v4 | ZK groups ya construido |
| P2P | libp2p | Usado por IPFS, probado en producción |
| Storage | Helia (IPFS en JS) | Sin daemon externo |
| Crypto | @noble/curves + @noble/hashes | Sin dependencias nativas |
| Threshold sig | @noble/curves (Shamir's) | Pure JS |
| Monorepo | pnpm workspaces | Sin overhead |

---

## Token SPT (Soulprint Token) — formato final

```json
{
  "sip": "1",
  "did": "did:key:z6Mk...",
  "score": 74,
  "level": "KYCFull",
  "country": "CO",
  "credentials": ["DocumentVerified", "FaceMatch", "PhoneVerified"],
  "nullifier": "0xabc...def",
  "issued": 1740000000,
  "expires": 1740086400,
  "network_sig": "threshold_sig_validators"
}
```

---

## Métricas de éxito

| Métrica | Target |
|---|---|
| Tiempo verificación usuario | < 30 segundos |
| RAM en reposo | < 10 MB |
| RAM durante verificación | < 600 MB (libera después) |
| Tiempo verificación servicio | < 50 ms (offline) |
| Costo por verificación | $0.00 |
| Líneas para integrar un MCP | 3 |
