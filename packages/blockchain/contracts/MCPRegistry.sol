// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MCPRegistry
 * @notice Registro público de servidores MCP verificados.
 *
 * DISEÑO:
 * ─────────────────────────────────────────────────────────────────────────
 * • Cualquier MCP puede auto-registrarse (permissionless)
 * • Solo el superAdmin puede verificar o revocar
 * • superAdmin puede transferirse a otra wallet (o a un contrato de governance)
 * • Consulta pública: isVerified(address) → bool
 * • Eventos indexables para frontends y SDKs
 *
 * FLUJO:
 *   1. Desarrollador llama registerMCP(url, name, did, category)
 *   2. SuperAdmin revisa y llama verify(mcpAddress)
 *   3. Clientes consultan isVerified(mcpAddress) o getVerifiedMCPs()
 *   4. Si el MCP se comporta mal: superAdmin llama revoke(mcpAddress)
 */
contract MCPRegistry {

    // ── Structs ───────────────────────────────────────────────────────────────

    struct MCPEntry {
        address  owner;         // wallet del registrante
        string   name;          // "MCP Colombia Hub"
        string   url;           // "https://..."
        string   did;           // DID Ed25519 del servidor (opcional)
        string   category;      // "finance" | "travel" | "jobs" | "ecommerce" | "general"
        string   description;   // descripción corta
        uint64   registeredAt;
        uint64   verifiedAt;    // 0 si no verificado
        uint64   revokedAt;     // 0 si no revocado
        bool     exists;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    address public superAdmin;
    address public pendingAdmin;    // para transferencia en 2 pasos

    address[] private _allMCPs;
    mapping(address => MCPEntry) public mcps;

    // ── Eventos ───────────────────────────────────────────────────────────────

    event MCPRegistered(address indexed mcpAddress, string name, string url, string category);
    event MCPVerified(address indexed mcpAddress, string name, address verifiedBy);
    event MCPRevoked(address indexed mcpAddress, string name, string reason);
    event MCPUpdated(address indexed mcpAddress, string name, string url);
    event AdminTransferProposed(address indexed from, address indexed to);
    event AdminTransferAccepted(address indexed newAdmin);

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == superAdmin, "MCPRegistry: not superAdmin");
        _;
    }

    modifier onlyOwnerOrAdmin(address mcpAddress) {
        require(
            msg.sender == superAdmin || msg.sender == mcps[mcpAddress].owner,
            "MCPRegistry: not owner or admin"
        );
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _superAdmin) {
        superAdmin = _superAdmin;
    }

    // ── Registro (permissionless) ─────────────────────────────────────────────

    /**
     * @notice Registra un nuevo servidor MCP.
     * @param mcpAddress  Dirección identificadora del MCP (puede ser EOA o contract)
     * @param name        Nombre del MCP (ej: "MCP Colombia Hub")
     * @param url         URL base del servidor
     * @param did         DID del servidor (puede estar vacío)
     * @param category    Categoría: finance | travel | jobs | ecommerce | general
     * @param description Descripción corta (max ~200 chars recomendado)
     */
    function registerMCP(
        address mcpAddress,
        string calldata name,
        string calldata url,
        string calldata did,
        string calldata category,
        string calldata description
    ) external {
        require(!mcps[mcpAddress].exists, "MCPRegistry: already registered");
        require(bytes(name).length > 0, "MCPRegistry: name required");
        require(bytes(url).length > 0, "MCPRegistry: url required");

        mcps[mcpAddress] = MCPEntry({
            owner:        msg.sender,
            name:         name,
            url:          url,
            did:          did,
            category:     category,
            description:  description,
            registeredAt: uint64(block.timestamp),
            verifiedAt:   0,
            revokedAt:    0,
            exists:       true
        });

        _allMCPs.push(mcpAddress);

        emit MCPRegistered(mcpAddress, name, url, category);
    }

    // ── Verificación (solo superAdmin) ────────────────────────────────────────

    /**
     * @notice Marca un MCP como verificado.
     */
    function verify(address mcpAddress) external onlyAdmin {
        require(mcps[mcpAddress].exists, "MCPRegistry: not registered");
        require(mcps[mcpAddress].verifiedAt == 0, "MCPRegistry: already verified");

        mcps[mcpAddress].verifiedAt = uint64(block.timestamp);
        mcps[mcpAddress].revokedAt  = 0;  // limpiar revocación previa si la hubiera

        emit MCPVerified(mcpAddress, mcps[mcpAddress].name, msg.sender);
    }

    /**
     * @notice Revoca la verificación de un MCP.
     */
    function revoke(address mcpAddress, string calldata reason) external onlyAdmin {
        require(mcps[mcpAddress].exists, "MCPRegistry: not registered");
        require(mcps[mcpAddress].verifiedAt > 0, "MCPRegistry: not verified");

        mcps[mcpAddress].revokedAt  = uint64(block.timestamp);
        mcps[mcpAddress].verifiedAt = 0;

        emit MCPRevoked(mcpAddress, mcps[mcpAddress].name, reason);
    }

    /**
     * @notice El owner del MCP (o el admin) puede actualizar url y did.
     */
    function updateMCP(
        address mcpAddress,
        string calldata newUrl,
        string calldata newDid,
        string calldata newDescription
    ) external onlyOwnerOrAdmin(mcpAddress) {
        require(mcps[mcpAddress].exists, "MCPRegistry: not registered");

        if (bytes(newUrl).length > 0)         mcps[mcpAddress].url         = newUrl;
        if (bytes(newDid).length > 0)         mcps[mcpAddress].did         = newDid;
        if (bytes(newDescription).length > 0) mcps[mcpAddress].description = newDescription;

        emit MCPUpdated(mcpAddress, mcps[mcpAddress].name, mcps[mcpAddress].url);
    }

    // ── Consultas públicas ────────────────────────────────────────────────────

    /**
     * @notice ¿Está verificado este MCP?
     */
    function isVerified(address mcpAddress) external view returns (bool) {
        MCPEntry storage m = mcps[mcpAddress];
        return m.exists && m.verifiedAt > 0 && m.revokedAt == 0;
    }

    /**
     * @notice Devuelve todos los MCPs registrados (para indexing off-chain).
     */
    function getAllMCPs() external view returns (address[] memory) {
        return _allMCPs;
    }

    /**
     * @notice Devuelve solo los MCPs actualmente verificados.
     */
    function getVerifiedMCPs() external view returns (address[] memory, MCPEntry[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < _allMCPs.length; i++) {
            MCPEntry storage m = mcps[_allMCPs[i]];
            if (m.verifiedAt > 0 && m.revokedAt == 0) count++;
        }

        address[]  memory addrs   = new address[](count);
        MCPEntry[] memory entries = new MCPEntry[](count);
        uint256 idx = 0;

        for (uint256 i = 0; i < _allMCPs.length; i++) {
            MCPEntry storage m = mcps[_allMCPs[i]];
            if (m.verifiedAt > 0 && m.revokedAt == 0) {
                addrs[idx]   = _allMCPs[i];
                entries[idx] = m;
                idx++;
            }
        }

        return (addrs, entries);
    }

    /**
     * @notice Total de MCPs registrados.
     */
    function totalMCPs() external view returns (uint256) {
        return _allMCPs.length;
    }

    // ── Transferencia de admin (2 pasos) ──────────────────────────────────────

    /**
     * @notice Paso 1: proponer nuevo superAdmin.
     */
    function proposeSuperAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "MCPRegistry: zero address");
        pendingAdmin = newAdmin;
        emit AdminTransferProposed(superAdmin, newAdmin);
    }

    /**
     * @notice Paso 2: el nuevo admin acepta.
     */
    function acceptSuperAdmin() external {
        require(msg.sender == pendingAdmin, "MCPRegistry: not pending admin");
        superAdmin   = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferAccepted(superAdmin);
    }
}
