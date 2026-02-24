// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ProtocolConstants
 * @notice Constantes del protocolo Soulprint — INMUTABLES en blockchain.
 *
 * En Solidity, las variables `immutable` se fijan en el constructor y
 * NUNCA pueden cambiar. No hay Object.freeze(), no hay AI que las modifique.
 * El bytecode del contrato desplegado ES la fuente de verdad.
 *
 * PROTOCOL_HASH: SHA-256 canónico de todos los valores.
 * Cualquier nodo que use valores diferentes genera un hash diferente
 * y la red lo rechaza. Los contratos validan este hash on-chain.
 */
contract ProtocolConstants {

    // ── Versión ───────────────────────────────────────────────────────────────
    string  public constant PROTOCOL_VERSION          = "sip/0.1";

    // ── Score limits ──────────────────────────────────────────────────────────
    uint8   public constant MAX_SCORE                 = 100;
    uint8   public constant IDENTITY_MAX              = 80;
    uint8   public constant REPUTATION_MAX            = 20;
    uint8   public constant DEFAULT_REPUTATION        = 10;

    // ── Score floors (INAMOVIBLES) ────────────────────────────────────────────
    uint8   public constant SCORE_FLOOR               = 65;
    uint8   public constant VERIFIED_SCORE_FLOOR      = 52;
    uint8   public constant MIN_ATTESTER_SCORE        = 65;

    // ── Biometric thresholds × 1000 (Solidity no tiene decimales) ────────────
    // FACE_SIM_DOC_SELFIE    = 0.35  → 350
    // FACE_SIM_SELFIE_SELFIE = 0.65  → 650
    uint16  public constant FACE_SIM_DOC_SELFIE       = 350;   // /1000
    uint16  public constant FACE_SIM_SELFIE_SELFIE    = 650;   // /1000
    uint8   public constant FACE_KEY_DIMS             = 32;
    uint8   public constant FACE_KEY_PRECISION        = 1;

    // ── Network ───────────────────────────────────────────────────────────────
    uint16  public constant DEFAULT_HTTP_PORT         = 4888;
    uint16  public constant DEFAULT_P2P_PORT          = 6888;
    uint16  public constant GOSSIP_TIMEOUT_MS         = 3000;
    uint8   public constant VERIFY_RETRY_MAX          = 3;
    uint16  public constant VERIFY_RETRY_BASE_MS      = 500;

    // ── Protocol Hash ─────────────────────────────────────────────────────────
    /**
     * @notice Hash SHA-256 canónico de todos los valores del protocolo.
     * Coincide con PROTOCOL_HASH de soulprint-core v0.1.7.
     * Almacenado como bytes32 para comparación eficiente on-chain.
     */
    bytes32 public constant PROTOCOL_HASH =
        0xdfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca;

    // ── Events ────────────────────────────────────────────────────────────────
    event ConstantsVerified(address indexed verifier, bytes32 hash, bool compatible);

    /**
     * @notice Verifica que un hash de protocolo externo coincide con el oficial.
     * Los nodos llaman a esto al conectarse para confirmar compatibilidad.
     * @param remoteHash  Hash reportado por el nodo remoto
     */
    function isCompatible(bytes32 remoteHash) external pure returns (bool) {
        return remoteHash == PROTOCOL_HASH;
    }

    /**
     * @notice Verifica y emite un evento (para auditoría on-chain).
     */
    function verifyAndLog(bytes32 remoteHash) external {
        bool compatible = remoteHash == PROTOCOL_HASH;
        emit ConstantsVerified(msg.sender, remoteHash, compatible);
    }
}
