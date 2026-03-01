// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReputationRegistry
 * @notice On-chain reputation scores for DIDs.
 *         Only authorized validators may write scores.
 *         SuperAdmin manages the validator set.
 */
contract ReputationRegistry {

    struct ScoreEntry {
        string  did;
        uint256 score;
        string  context;
        uint256 updatedAt;
    }

    // ── Access control ─────────────────────────────────────────────────────────
    address public superAdmin;
    mapping(address => bool) public authorizedValidators;

    modifier onlySuperAdmin() {
        require(msg.sender == superAdmin, "ReputationRegistry: not superAdmin");
        _;
    }

    modifier onlyValidator() {
        require(authorizedValidators[msg.sender], "Unauthorized validator");
        _;
    }

    // ── Storage ────────────────────────────────────────────────────────────────
    mapping(string => ScoreEntry) private _scores;
    string[] private _didList;
    mapping(string => bool) private _exists;

    // ── Events ─────────────────────────────────────────────────────────────────
    event ScoreUpdated(
        string  indexed did,
        uint256 score,
        string  context,
        uint256 updatedAt
    );
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _superAdmin) {
        require(_superAdmin != address(0), "ReputationRegistry: zero address");
        superAdmin = _superAdmin;
        authorizedValidators[_superAdmin] = true;
        emit ValidatorAdded(_superAdmin);
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    function addValidator(address validator) external onlySuperAdmin {
        require(validator != address(0), "ReputationRegistry: zero address");
        authorizedValidators[validator] = true;
        emit ValidatorAdded(validator);
    }

    function removeValidator(address validator) external onlySuperAdmin {
        require(validator != superAdmin, "ReputationRegistry: cannot remove superAdmin");
        authorizedValidators[validator] = false;
        emit ValidatorRemoved(validator);
    }

    // ── Write ──────────────────────────────────────────────────────────────────

    /**
     * @notice Set or update the reputation score for a DID.
     *         Only authorized validators may call this.
     *
     * @param did      The DID to update
     * @param score    Reputation score
     * @param context  Context string (e.g. "soulprint:v1")
     */
    function setScore(
        string calldata did,
        uint256         score,
        string calldata context
    ) external onlyValidator {
        bool isNew = !_exists[did];

        _scores[did] = ScoreEntry({
            did:       did,
            score:     score,
            context:   context,
            updatedAt: block.timestamp
        });

        if (isNew) {
            _didList.push(did);
            _exists[did] = true;
        }

        emit ScoreUpdated(did, score, context, block.timestamp);
    }

    // ── Read ───────────────────────────────────────────────────────────────────

    function getScore(string calldata did) external view returns (
        string memory retDid,
        uint256 score,
        string memory context,
        uint256 updatedAt
    ) {
        if (!_exists[did]) return (did, 0, "", 0);
        ScoreEntry memory e = _scores[did];
        return (e.did, e.score, e.context, e.updatedAt);
    }

    function getAllScores() external view returns (ScoreEntry[] memory) {
        ScoreEntry[] memory result = new ScoreEntry[](_didList.length);
        for (uint256 i = 0; i < _didList.length; i++) {
            result[i] = _scores[_didList[i]];
        }
        return result;
    }

    function getScoreCount() external view returns (uint256) {
        return _didList.length;
    }
}
