// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PeerRegistry
 * @notice On-chain peer discovery registry for Soulprint validator nodes.
 *
 * DESIGN:
 *  - Any node can register or update its own entry (peerDid as key)
 *  - Only the registrant's address can remove its own entry
 *  - getAllPeers() returns all active peers for bootstrap
 *  - lastSeen is updated automatically on register/update
 */
contract PeerRegistry {

    struct Peer {
        string  peerDid;
        string  peerId;
        string  multiaddr;
        uint256 score;
        uint256 lastSeen;
        address registrant;
    }

    // ── Storage ────────────────────────────────────────────────────────────────
    mapping(string => Peer) private _peers;
    string[] private _peerDids;
    mapping(string => bool) private _exists;
    mapping(string => address) private _registrants;

    // ── Events ─────────────────────────────────────────────────────────────────
    event PeerRegistered(
        string indexed peerDid,
        string peerId,
        string multiaddr,
        uint256 score,
        address indexed registrant,
        uint256 timestamp
    );
    event PeerUpdated(
        string indexed peerDid,
        string peerId,
        string multiaddr,
        uint256 score,
        address indexed registrant,
        uint256 timestamp
    );
    event PeerRemoved(
        string indexed peerDid,
        address indexed removedBy,
        uint256 timestamp
    );

    // ── Write ──────────────────────────────────────────────────────────────────

    /**
     * @notice Register or update a peer entry.
     * @param peerDid  DID of the node (e.g. "did:key:z...")
     * @param peerId   libp2p PeerID string
     * @param multiaddr The node's public multiaddr
     * @param score    Reputation score (0 on initial register)
     */
    function registerPeer(
        string calldata peerDid,
        string calldata peerId,
        string calldata multiaddr,
        uint256 score
    ) external {
        bool isNew = !_exists[peerDid];

        if (!isNew) {
            // Only the original registrant can update
            require(
                _registrants[peerDid] == msg.sender,
                "PeerRegistry: only original registrant can update"
            );
        }

        _peers[peerDid] = Peer({
            peerDid:    peerDid,
            peerId:     peerId,
            multiaddr:  multiaddr,
            score:      score,
            lastSeen:   block.timestamp,
            registrant: msg.sender
        });

        if (isNew) {
            _peerDids.push(peerDid);
            _exists[peerDid] = true;
            _registrants[peerDid] = msg.sender;
            emit PeerRegistered(peerDid, peerId, multiaddr, score, msg.sender, block.timestamp);
        } else {
            emit PeerUpdated(peerDid, peerId, multiaddr, score, msg.sender, block.timestamp);
        }
    }

    /**
     * @notice Remove a peer entry. Only the registrant can remove.
     * @param peerDid DID of the peer to remove
     */
    function removePeer(string calldata peerDid) external {
        require(_exists[peerDid], "PeerRegistry: peer not found");
        require(_registrants[peerDid] == msg.sender, "PeerRegistry: only registrant can remove");

        delete _peers[peerDid];
        delete _registrants[peerDid];
        _exists[peerDid] = false;

        // Remove from array (swap with last)
        for (uint256 i = 0; i < _peerDids.length; i++) {
            if (keccak256(bytes(_peerDids[i])) == keccak256(bytes(peerDid))) {
                _peerDids[i] = _peerDids[_peerDids.length - 1];
                _peerDids.pop();
                break;
            }
        }

        emit PeerRemoved(peerDid, msg.sender, block.timestamp);
    }

    // ── Read ───────────────────────────────────────────────────────────────────

    /**
     * @notice Get a single peer by DID.
     */
    function getPeer(string calldata peerDid) external view returns (
        string memory did,
        string memory peerId,
        string memory multiaddr,
        uint256 score,
        uint256 lastSeen
    ) {
        require(_exists[peerDid], "PeerRegistry: peer not found");
        Peer memory p = _peers[peerDid];
        return (p.peerDid, p.peerId, p.multiaddr, p.score, p.lastSeen);
    }

    /**
     * @notice Get all registered peers.
     */
    function getAllPeers() external view returns (Peer[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < _peerDids.length; i++) {
            if (_exists[_peerDids[i]]) count++;
        }
        Peer[] memory result = new Peer[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < _peerDids.length; i++) {
            if (_exists[_peerDids[i]]) {
                result[idx++] = _peers[_peerDids[i]];
            }
        }
        return result;
    }

    /**
     * @notice Returns total number of registered peers.
     */
    function peerCount() external view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < _peerDids.length; i++) {
            if (_exists[_peerDids[i]]) count++;
        }
        return count;
    }
}
