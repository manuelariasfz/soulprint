// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ProtocolConstants.sol";
import "./IGroth16Verifier.sol";

/**
 * @title SoulprintRegistry
 * @notice Registro global de identidades verificadas Soulprint.
 *
 * DISEÑO DE PRIVACIDAD:
 * ─────────────────────────────────────────────────────────────────────────
 * • El nullifier es un hash Poseidon(cédula, fecha_nac, face_key, salt)
 *   → No revela ningún dato biométrico ni PII
 *   → Una persona = un nullifier único (anti-sybil)
 * • El DID es una clave pública derivada (did:key:z6Mk...)
 *   → Pseudónimo, no vincula al nombre real
 * • El ZK proof se verifica on-chain (Groth16)
 *   → El contrato confirma "alguien con datos reales generó este proof"
 *   → Sin revelar qué datos
 *
 * FLUJO:
 *   1. Usuario corre `npx soulprint verify-me` → genera ZK proof local
 *   2. Llama a registerIdentity() con (nullifier, did, zkProof)
 *   3. Contrato verifica ZK proof on-chain (Groth16Verifier)
 *   4. Registra nullifier → anti-sybil global
 *   5. Mapea DID → identityScore (basado en credentials)
 */
contract SoulprintRegistry is ProtocolConstants {

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Identity {
        bytes32   nullifier;      // Poseidon hash — anti-sybil key
        string    did;            // did:key:z6Mk... público
        uint8     identityScore;  // 0–80 (solo identity, sin reputation)
        uint64    registeredAt;   // timestamp Unix
        bool      documentVerified;
        bool      faceVerified;
        bool      active;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    /// @notice nullifier → Identity
    mapping(bytes32 => Identity) public identities;

    /// @notice DID string → nullifier (para búsqueda inversa)
    mapping(string => bytes32) public didToNullifier;

    /// @notice nullifier → true si ya está registrado (anti-sybil)
    mapping(bytes32 => bool) public nullifierUsed;

    /// @notice Referencia al Groth16Verifier desplegado
    IGroth16Verifier public immutable verifier;

    /// @notice Total de identidades registradas
    uint256 public totalRegistered;

    // ── Events ────────────────────────────────────────────────────────────────

    event IdentityRegistered(
        bytes32 indexed nullifier,
        string  indexed did,
        uint8           identityScore,
        uint64          timestamp
    );

    event IdentityUpdated(
        bytes32 indexed nullifier,
        uint8           newScore,
        uint64          timestamp
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    error NullifierAlreadyUsed(bytes32 nullifier);
    error InvalidZKProof();
    error InvalidDID();
    error NotRegistered(bytes32 nullifier);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _verifier) {
        verifier = IGroth16Verifier(_verifier);
    }

    // ── Core functions ────────────────────────────────────────────────────────

    /**
     * @notice Registra una identidad verificada con ZK proof.
     * @param nullifier       Poseidon hash del usuario (anti-sybil)
     * @param did             DID público del bot/usuario
     * @param documentVerified  Si el documento fue verificado (OCR)
     * @param faceVerified      Si la cara coincidió con el documento
     * @param zkProofA        Componente A del proof Groth16
     * @param zkProofB        Componente B del proof Groth16
     * @param zkProofC        Componente C del proof Groth16
     * @param publicInputs    Inputs públicos del ZK circuit
     */
    function registerIdentity(
        bytes32   nullifier,
        string    calldata did,
        bool      documentVerified,
        bool      faceVerified,
        uint256[2]    calldata zkProofA,
        uint256[2][2] calldata zkProofB,
        uint256[2]    calldata zkProofC,
        uint256[2]    calldata publicInputs
    ) external {
        // Anti-sybil: un nullifier = una persona
        if (nullifierUsed[nullifier]) revert NullifierAlreadyUsed(nullifier);

        // Validar DID mínimo
        if (bytes(did).length < 10) revert InvalidDID();

        // Verificar ZK proof on-chain (Groth16)
        // El proof demuestra que el usuario tiene datos biométricos válidos
        // sin revelar cuáles son
        bool proofValid = verifier.verifyProof(
            zkProofA, zkProofB, zkProofC, publicInputs
        );
        if (!proofValid) revert InvalidZKProof();

        // Calcular identity score basado en credentials
        uint8 score = _computeIdentityScore(documentVerified, faceVerified);

        // Registrar
        identities[nullifier] = Identity({
            nullifier:        nullifier,
            did:              did,
            identityScore:    score,
            registeredAt:     uint64(block.timestamp),
            documentVerified: documentVerified,
            faceVerified:     faceVerified,
            active:           true
        });

        nullifierUsed[nullifier]   = true;
        didToNullifier[did]        = nullifier;
        totalRegistered++;

        emit IdentityRegistered(nullifier, did, score, uint64(block.timestamp));
    }

    /**
     * @notice Consulta la identidad de un DID.
     * @param did  DID a consultar
     */
    function getIdentity(string calldata did)
        external view
        returns (Identity memory)
    {
        bytes32 nullifier = didToNullifier[did];
        return identities[nullifier];
    }

    /**
     * @notice Verifica si un nullifier ya está registrado (anti-sybil check).
     */
    function isRegistered(bytes32 nullifier) external view returns (bool) {
        return nullifierUsed[nullifier];
    }

    /**
     * @notice Retorna el identity score de un DID (0 si no registrado).
     */
    function identityScore(string calldata did) external view returns (uint8) {
        bytes32 nullifier = didToNullifier[did];
        return identities[nullifier].identityScore;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /**
     * @notice Calcula el identity score basado en los credentials verificados.
     * Coincide con la lógica de soulprint-core:
     *   Base:              30 pts  (solo tener un DID)
     *   DocumentVerified: +25 pts
     *   FaceVerified:     +25 pts
     *   Total max:         80 pts  (IDENTITY_MAX)
     */
    function _computeIdentityScore(
        bool documentVerified,
        bool faceVerified
    ) internal pure returns (uint8) {
        uint8 score = 30; // base
        if (documentVerified) score += 25;
        if (faceVerified)     score += 25;
        return score > IDENTITY_MAX ? IDENTITY_MAX : score;
    }
    /**
     * @notice Retorna campos de una identidad por nullifier (para governance).
     */
    function getIdentityByNullifier(bytes32 nullifier)
        external view
        returns (
            bytes32 null_, string memory did_,
            uint8 score_, uint64 regAt_,
            bool docV_, bool faceV_, bool active_
        )
    {
        Identity memory id = identities[nullifier];
        return (id.nullifier, id.did, id.identityScore, id.registeredAt,
                id.documentVerified, id.faceVerified, id.active);
    }

}
