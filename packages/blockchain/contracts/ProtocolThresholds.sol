// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ProtocolThresholds
 * @notice Thresholds del protocolo Soulprint — ajustables sólo por el superAdmin.
 *
 * DISEÑO:
 *  - Cualquiera puede leer los thresholds (getThreshold / getAll)
 *  - Solo superAdmin puede modificarlos (setThreshold)
 *  - Cada cambio emite ThresholdUpdated — auditable on-chain para siempre
 *  - 2-step transfer del superAdmin (propuesta + aceptación)
 *  - Los nodos validadores leen estos valores al arrancar y los usan
 *    en lugar de los valores hardcodeados en TS
 *
 * VALORES INICIALES (idénticos a protocol-constants.ts):
 *   SCORE_FLOOR            = 65
 *   VERIFIED_SCORE_FLOOR   = 52
 *   MIN_ATTESTER_SCORE     = 65
 *   FACE_SIM_DOC_SELFIE    = 350  (= 0.35 × 1000)
 *   FACE_SIM_SELFIE_SELFIE = 650  (= 0.65 × 1000)
 *   DEFAULT_REPUTATION     = 10
 *   IDENTITY_MAX           = 80
 *   REPUTATION_MAX         = 20
 *   VERIFY_RETRY_MAX       = 3
 */
contract ProtocolThresholds {

    // ── Roles ─────────────────────────────────────────────────────────────────
    address public superAdmin;
    address public pendingSuperAdmin;

    // ── Storage ───────────────────────────────────────────────────────────────
    mapping(bytes32 => uint256) private _thresholds;

    // ── Events ────────────────────────────────────────────────────────────────
    event ThresholdUpdated(
        bytes32 indexed key,
        uint256 oldValue,
        uint256 newValue,
        address indexed by,
        uint256 timestamp
    );
    event SuperAdminProposed(address indexed proposed);
    event SuperAdminAccepted(address indexed newAdmin);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _superAdmin) {
        superAdmin = _superAdmin;

        _init("SCORE_FLOOR",            65);
        _init("VERIFIED_SCORE_FLOOR",   52);
        _init("MIN_ATTESTER_SCORE",     65);
        _init("FACE_SIM_DOC_SELFIE",   350);   // 0.35 × 1000
        _init("FACE_SIM_SELFIE_SELFIE",650);   // 0.65 × 1000
        _init("DEFAULT_REPUTATION",     10);
        _init("IDENTITY_MAX",           80);
        _init("REPUTATION_MAX",         20);
        _init("VERIFY_RETRY_MAX",        3);
    }

    // ── Read (public) ─────────────────────────────────────────────────────────

    /// @notice Lee un threshold por nombre (string)
    function getThreshold(string calldata name) external view returns (uint256) {
        return _thresholds[keccak256(bytes(name))];
    }

    /// @notice Lee un threshold por key bytes32
    function getThresholdByKey(bytes32 key) external view returns (uint256) {
        return _thresholds[key];
    }

    /// @notice Devuelve todos los thresholds (nombres + valores)
    function getAll() external view returns (
        string[] memory names,
        uint256[] memory values
    ) {
        names  = new string[](9);
        values = new uint256[](9);

        names[0] = "SCORE_FLOOR";            values[0] = _thresholds[keccak256(bytes("SCORE_FLOOR"))];
        names[1] = "VERIFIED_SCORE_FLOOR";   values[1] = _thresholds[keccak256(bytes("VERIFIED_SCORE_FLOOR"))];
        names[2] = "MIN_ATTESTER_SCORE";     values[2] = _thresholds[keccak256(bytes("MIN_ATTESTER_SCORE"))];
        names[3] = "FACE_SIM_DOC_SELFIE";   values[3] = _thresholds[keccak256(bytes("FACE_SIM_DOC_SELFIE"))];
        names[4] = "FACE_SIM_SELFIE_SELFIE"; values[4] = _thresholds[keccak256(bytes("FACE_SIM_SELFIE_SELFIE"))];
        names[5] = "DEFAULT_REPUTATION";     values[5] = _thresholds[keccak256(bytes("DEFAULT_REPUTATION"))];
        names[6] = "IDENTITY_MAX";           values[6] = _thresholds[keccak256(bytes("IDENTITY_MAX"))];
        names[7] = "REPUTATION_MAX";         values[7] = _thresholds[keccak256(bytes("REPUTATION_MAX"))];
        names[8] = "VERIFY_RETRY_MAX";       values[8] = _thresholds[keccak256(bytes("VERIFY_RETRY_MAX"))];
    }

    // ── Write (superAdmin only) ───────────────────────────────────────────────

    /// @notice Actualiza un threshold. Solo superAdmin.
    function setThreshold(string calldata name, uint256 value) external onlySuperAdmin {
        bytes32 key  = keccak256(bytes(name));
        uint256 old  = _thresholds[key];
        _thresholds[key] = value;
        emit ThresholdUpdated(key, old, value, msg.sender, block.timestamp);
    }

    // ── SuperAdmin transfer (2-step) ──────────────────────────────────────────

    function proposeSuperAdmin(address newAdmin) external onlySuperAdmin {
        pendingSuperAdmin = newAdmin;
        emit SuperAdminProposed(newAdmin);
    }

    function acceptSuperAdmin() external {
        require(msg.sender == pendingSuperAdmin, "Not proposed");
        superAdmin        = pendingSuperAdmin;
        pendingSuperAdmin = address(0);
        emit SuperAdminAccepted(msg.sender);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _init(string memory name, uint256 value) internal {
        _thresholds[keccak256(bytes(name))] = value;
    }

    modifier onlySuperAdmin() {
        require(msg.sender == superAdmin, "ProtocolThresholds: not superAdmin");
        _;
    }
}
