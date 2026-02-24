// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ProtocolConstants.sol";
import "./SoulprintRegistry.sol";

/**
 * @title AttestationLedger
 * @notice Ledger permanente de attestations de reputación de bots.
 *
 * DISEÑO:
 * ─────────────────────────────────────────────────────────────────────────
 * • DIDs son PÚBLICOS — no revelan identidad real (son pseudónimos)
 * • Attestations son permanentes e inmutables on-chain
 * • Solo servicios con identity score ≥ MIN_ATTESTER_SCORE pueden atestar
 * • Anti-farming: límites de frecuencia on-chain (1 attest/día por par)
 * • Score total = identityScore (on-chain registry) + reputationScore (este contrato)
 *
 * ANTI-FARMING ON-CHAIN:
 * • Un issuer solo puede atestar a un target 1 vez por día
 * • El contrato registra el timestamp de la última attestation
 * • No hay forma de bypasear esto — el bloque tiene timestamp
 */
contract AttestationLedger is ProtocolConstants {

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Attestation {
        string   issuerDid;      // DID del servicio que atestigua
        string   targetDid;      // DID del bot que recibe la attestation
        int8     value;          // +1 o -1
        string   context;        // "normal-usage", "spam-detected", etc.
        uint64   timestamp;      // block.timestamp
        bytes    signature;      // Ed25519 signature del issuer (off-chain key)
    }

    struct Reputation {
        int16    score;          // suma de todas las attestations (-20 a +20)
        uint16   totalPositive;  // total de +1
        uint16   totalNegative;  // total de -1
        uint64   lastUpdated;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    /// @notice Referencia al registry de identidades
    SoulprintRegistry public immutable registry;

    /// @notice targetDid → Reputation
    mapping(string => Reputation) public reputations;

    /// @notice targetDid → lista de attestations
    mapping(string => Attestation[]) public attestationHistory;

    /// @notice hash(issuerDid + targetDid) → último timestamp de attestation
    /// Para anti-farming: solo 1 attestation por par por día
    mapping(bytes32 => uint64) public lastAttestationTime;

    /// @notice Total de attestations registradas
    uint256 public totalAttestations;

    // ── Events ────────────────────────────────────────────────────────────────

    event AttestationRecorded(
        string  indexed targetDid,
        string          issuerDid,
        int8            value,
        string          context,
        uint64          timestamp
    );

    event FarmingPenalty(
        string  indexed targetDid,
        string          issuerDid,
        string          reason,
        uint64          timestamp
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    error InvalidValue();
    error IssuerNotAuthorized(string issuerDid, uint8 score, uint8 required);
    error CooldownActive(string issuerDid, string targetDid, uint64 nextAllowed);
    error InvalidDID();
    error SameIssuerTarget();

    // ── Constants ─────────────────────────────────────────────────────────────

    /// @notice Cooldown entre attestations del mismo par (24 horas)
    uint64 public constant ATTESTATION_COOLDOWN = 1 days;

    /// @notice Default reputation para bots nuevos (coincide con PROTOCOL)
    int16  public constant DEFAULT_REP = 10;

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _registry) {
        registry = SoulprintRegistry(_registry);
    }

    // ── Core functions ────────────────────────────────────────────────────────

    /**
     * @notice Registra una attestation de reputación on-chain.
     * @param issuerDid  DID del servicio que emite la attestation
     * @param targetDid  DID del bot que recibe la attestation
     * @param value      +1 (positivo) o -1 (negativo)
     * @param context    Razón de la attestation
     * @param signature  Firma Ed25519 del issuer sobre (target+value+context+ts)
     */
    function attest(
        string  calldata issuerDid,
        string  calldata targetDid,
        int8             value,
        string  calldata context,
        bytes   calldata signature
    ) external {
        // Validaciones básicas
        if (value != 1 && value != -1)        revert InvalidValue();
        if (bytes(issuerDid).length < 10)     revert InvalidDID();
        if (bytes(targetDid).length < 10)     revert InvalidDID();
        if (keccak256(bytes(issuerDid)) ==
            keccak256(bytes(targetDid)))       revert SameIssuerTarget();

        // Verificar que el issuer tiene score suficiente para atestar
        uint8 issuerScore = registry.identityScore(issuerDid);
        if (issuerScore < MIN_ATTESTER_SCORE) {
            revert IssuerNotAuthorized(issuerDid, issuerScore, MIN_ATTESTER_SCORE);
        }

        // Anti-farming on-chain: cooldown entre attestations del mismo par
        bytes32 pairKey = keccak256(abi.encodePacked(issuerDid, targetDid));
        uint64  lastTs  = lastAttestationTime[pairKey];
        if (lastTs > 0 && block.timestamp - lastTs < ATTESTATION_COOLDOWN) {
            revert CooldownActive(
                issuerDid,
                targetDid,
                lastTs + ATTESTATION_COOLDOWN
            );
        }

        // Registrar attestation
        Attestation memory att = Attestation({
            issuerDid: issuerDid,
            targetDid: targetDid,
            value:     value,
            context:   context,
            timestamp: uint64(block.timestamp),
            signature: signature
        });

        attestationHistory[targetDid].push(att);
        lastAttestationTime[pairKey] = uint64(block.timestamp);
        totalAttestations++;

        // Actualizar reputación
        Reputation storage rep = reputations[targetDid];
        if (rep.lastUpdated == 0) {
            // Primera attestation: inicializar con DEFAULT_REP
            rep.score = DEFAULT_REP;
        }

        rep.score       += value;
        rep.lastUpdated  = uint64(block.timestamp);
        if (value > 0) rep.totalPositive++;
        else           rep.totalNegative++;

        // Clamp: reputación entre 0 y REPUTATION_MAX
        if (rep.score < 0)                                    rep.score = 0;
        if (rep.score > int16(uint16(uint8(REPUTATION_MAX)))) rep.score = int16(uint16(uint8(REPUTATION_MAX)));

        emit AttestationRecorded(targetDid, issuerDid, value, context, uint64(block.timestamp));
    }

    /**
     * @notice Retorna el score total de un DID (identity + reputation).
     * @param did  DID a consultar
     */
    function getTotalScore(string calldata did) external view returns (uint16) {
        uint8  idScore  = registry.identityScore(did);
        int16  repScore = reputations[did].lastUpdated == 0
            ? DEFAULT_REP
            : reputations[did].score;

        // repScore siempre >= 0 después del clamp en attest()
        uint16 rep16 = repScore >= 0 ? uint16(int16(repScore)) : 0;
        uint16 total = uint16(idScore) + rep16;
        uint16 cap   = uint16(MAX_SCORE);
        return total > cap ? cap : total;
    }

    /**
     * @notice Retorna la reputación de un DID.
     */
    function getReputation(string calldata did)
        external view
        returns (Reputation memory)
    {
        Reputation memory rep = reputations[did];
        if (rep.lastUpdated == 0) {
            rep.score = DEFAULT_REP; // default para bots nuevos
        }
        return rep;
    }

    /**
     * @notice Retorna el historial completo de attestations de un DID.
     */
    function getAttestations(string calldata did)
        external view
        returns (Attestation[] memory)
    {
        return attestationHistory[did];
    }

    /**
     * @notice Verifica si un par issuer→target puede atestar ahora.
     * @return allowed  true si puede atestar
     * @return nextTs   timestamp cuando podrá atestar (0 si puede ahora)
     */
    function canAttest(
        string calldata issuerDid,
        string calldata targetDid
    ) external view returns (bool allowed, uint64 nextTs) {
        bytes32 pairKey = keccak256(abi.encodePacked(issuerDid, targetDid));
        uint64  lastTs  = lastAttestationTime[pairKey];

        if (lastTs == 0 || block.timestamp - lastTs >= ATTESTATION_COOLDOWN) {
            return (true, 0);
        }
        return (false, lastTs + ATTESTATION_COOLDOWN);
    }
}
