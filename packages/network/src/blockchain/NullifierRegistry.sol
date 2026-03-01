// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title NullifierRegistry
 * @notice On-chain registry of verified ZK nullifiers.
 *         Requires a valid ECDSA signature from the authorizedValidator
 *         to register — the validator verifies the ZK proof off-chain
 *         before co-signing the registration.
 */
contract NullifierRegistry {

    struct NullifierEntry {
        bytes32 nullifier;
        string  did;
        uint256 score;
        uint256 timestamp;
    }

    // ── Access control ─────────────────────────────────────────────────────────
    address public superAdmin;
    address public authorizedValidator;

    modifier onlySuperAdmin() {
        require(msg.sender == superAdmin, "NullifierRegistry: not superAdmin");
        _;
    }

    // ── Storage ────────────────────────────────────────────────────────────────
    mapping(bytes32 => NullifierEntry) private _nullifiers;
    bytes32[] private _nullifierList;
    mapping(bytes32 => bool) private _exists;

    // ── Events ─────────────────────────────────────────────────────────────────
    event NullifierRegistered(
        bytes32 indexed nullifier,
        string  did,
        uint256 score,
        uint256 timestamp
    );
    event ValidatorUpdated(address indexed oldValidator, address indexed newValidator);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _superAdmin) {
        require(_superAdmin != address(0), "NullifierRegistry: zero address");
        superAdmin = _superAdmin;
        authorizedValidator = _superAdmin;
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    /**
     * @notice Update the authorized validator address.
     * @param newValidator New validator address
     */
    function setAuthorizedValidator(address newValidator) external onlySuperAdmin {
        require(newValidator != address(0), "NullifierRegistry: zero address");
        emit ValidatorUpdated(authorizedValidator, newValidator);
        authorizedValidator = newValidator;
    }

    // ── Write ──────────────────────────────────────────────────────────────────

    /**
     * @notice Register a verified identity nullifier.
     *         Requires ECDSA signature by authorizedValidator over
     *         keccak256(abi.encodePacked(nullifier, did, score)).
     *         Idempotent — re-registering the same nullifier is a no-op.
     *
     * @param nullifier  ZK nullifier (bytes32)
     * @param did        DID of the identity
     * @param score      Initial reputation score
     * @param sig        65-byte ECDSA signature by authorizedValidator
     */
    function registerNullifier(
        bytes32         nullifier,
        string calldata did,
        uint256         score,
        bytes calldata  sig
    ) external {
        // Verify signature
        bytes32 msgHash = keccak256(abi.encodePacked(nullifier, did, score));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        address signer  = _recover(ethHash, sig);
        require(signer == authorizedValidator, "NullifierRegistry: invalid validator signature");

        if (_exists[nullifier]) return; // idempotent

        _nullifiers[nullifier] = NullifierEntry({
            nullifier: nullifier,
            did:       did,
            score:     score,
            timestamp: block.timestamp
        });
        _nullifierList.push(nullifier);
        _exists[nullifier] = true;

        emit NullifierRegistered(nullifier, did, score, block.timestamp);
    }

    // ── Read ───────────────────────────────────────────────────────────────────

    function isRegistered(bytes32 nullifier) external view returns (bool) {
        return _exists[nullifier];
    }

    function getNullifier(bytes32 nullifier) external view returns (
        bytes32 nul,
        string memory did,
        uint256 score,
        uint256 timestamp
    ) {
        require(_exists[nullifier], "NullifierRegistry: not found");
        NullifierEntry memory e = _nullifiers[nullifier];
        return (e.nullifier, e.did, e.score, e.timestamp);
    }

    function getAllNullifiers() external view returns (NullifierEntry[] memory) {
        NullifierEntry[] memory result = new NullifierEntry[](_nullifierList.length);
        for (uint256 i = 0; i < _nullifierList.length; i++) {
            result[i] = _nullifiers[_nullifierList[i]];
        }
        return result;
    }

    function getNullifierCount() external view returns (uint256) {
        return _nullifierList.length;
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    function _recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "NullifierRegistry: bad sig length");
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "NullifierRegistry: bad sig v");
        return ecrecover(hash, v, r, s);
    }
}
