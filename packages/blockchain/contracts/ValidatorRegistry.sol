// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ProtocolConstants.sol";

/**
 * @title ValidatorRegistry
 * @notice Registro de nodos validadores Soulprint autorizados.
 *
 * DISEÑO:
 * ─────────────────────────────────────────────────────────────────────────
 * • Cualquiera puede registrar su nodo (permissionless)
 * • El nodo DEBE reportar su PROTOCOL_HASH al registrarse
 * • Nodos con hash diferente son marcados como incompatibles
 * • Los SDKs consultan este contrato para encontrar nodos confiables
 * • Los nodos con más attestations positivas tienen mayor peso
 *
 * DESCENTRALIZACIÓN:
 * • No hay "owner" privilegiado que pueda banear nodos arbitrariamente
 * • Un nodo solo se "desactiva" si su PROTOCOL_HASH no coincide
 * • Cualquier nodo compatible puede registrarse
 */
contract ValidatorRegistry is ProtocolConstants {

    // ── Structs ───────────────────────────────────────────────────────────────

    struct ValidatorNode {
        string   url;               // https://node.example.com
        string   did;               // DID del nodo (llave Ed25519)
        bytes32  protocolHash;      // debe coincidir con PROTOCOL_HASH
        uint64   registeredAt;
        uint64   lastSeen;          // último heartbeat on-chain
        uint32   totalVerified;     // identidades verificadas (incrementado off-chain)
        bool     active;
        bool     compatible;        // true si protocolHash == PROTOCOL_HASH
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    /// @notice DID del nodo → ValidatorNode
    mapping(string => ValidatorNode) public nodes;

    /// @notice Lista de DIDs de nodos registrados
    string[] public nodeDids;

    /// @notice Total de nodos registrados
    uint256 public totalNodes;

    /// @notice Total de nodos compatibles activos
    uint256 public compatibleNodes;

    // ── Events ────────────────────────────────────────────────────────────────

    event NodeRegistered(
        string  indexed did,
        string          url,
        bytes32         protocolHash,
        bool            compatible,
        uint64          timestamp
    );

    event NodeHeartbeat(
        string  indexed did,
        uint64          timestamp,
        uint32          totalVerified
    );

    event NodeIncompatible(
        string  indexed did,
        bytes32         theirHash,
        bytes32         expectedHash
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    error InvalidURL();
    error InvalidDID();
    error AlreadyRegistered(string did);

    // ── Core functions ────────────────────────────────────────────────────────

    /**
     * @notice Registra un nuevo nodo validador.
     * @param url           URL HTTP del nodo
     * @param did           DID del nodo
     * @param protocolHash  PROTOCOL_HASH que usa el nodo
     */
    function registerNode(
        string  calldata url,
        string  calldata did,
        bytes32          protocolHash
    ) external {
        if (bytes(url).length < 8)   revert InvalidURL();
        if (bytes(did).length < 10)  revert InvalidDID();
        if (nodes[did].registeredAt > 0) revert AlreadyRegistered(did);

        bool compatible = (protocolHash == PROTOCOL_HASH);

        nodes[did] = ValidatorNode({
            url:           url,
            did:           did,
            protocolHash:  protocolHash,
            registeredAt:  uint64(block.timestamp),
            lastSeen:      uint64(block.timestamp),
            totalVerified: 0,
            active:        true,
            compatible:    compatible
        });

        nodeDids.push(did);
        totalNodes++;
        if (compatible) compatibleNodes++;

        emit NodeRegistered(did, url, protocolHash, compatible, uint64(block.timestamp));

        if (!compatible) {
            emit NodeIncompatible(did, protocolHash, PROTOCOL_HASH);
        }
    }

    /**
     * @notice Heartbeat del nodo — señal de que sigue activo.
     * @param did             DID del nodo
     * @param totalVerified   Total de identidades verificadas hasta ahora
     */
    function heartbeat(string calldata did, uint32 totalVerified) external {
        ValidatorNode storage node = nodes[did];
        require(node.registeredAt > 0, "Node not registered");

        node.lastSeen      = uint64(block.timestamp);
        node.totalVerified = totalVerified;

        emit NodeHeartbeat(did, uint64(block.timestamp), totalVerified);
    }

    /**
     * @notice Retorna lista de nodos compatibles activos.
     * Filtra por protocolHash == PROTOCOL_HASH y activos en últimas 24h.
     */
    function getActiveNodes() external view returns (ValidatorNode[] memory) {
        uint256 count = 0;
        uint64  cutoff = uint64(block.timestamp) > 1 days
            ? uint64(block.timestamp) - 1 days
            : 0;

        // Contar primero
        for (uint256 i = 0; i < nodeDids.length; i++) {
            ValidatorNode memory node = nodes[nodeDids[i]];
            if (node.compatible && node.lastSeen >= cutoff) {
                count++;
            }
        }

        // Construir array
        ValidatorNode[] memory result = new ValidatorNode[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < nodeDids.length; i++) {
            ValidatorNode memory node = nodes[nodeDids[i]];
            if (node.compatible && node.lastSeen >= cutoff) {
                result[idx++] = node;
            }
        }
        return result;
    }

    /**
     * @notice Retorna un nodo por su DID.
     */
    function getNode(string calldata did) external view returns (ValidatorNode memory) {
        return nodes[did];
    }
}
