// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ProtocolConstants.sol";
import "./ValidatorRegistry.sol";
import "./SoulprintRegistry.sol";

/**
 * @title GovernanceModule
 * @notice Governance on-chain para upgrades del protocolo Soulprint.
 *
 * MODELO DE SEGURIDAD
 * ─────────────────────────────────────────────────────────────────────────
 * El problema que resuelve: ¿Quién puede cambiar el PROTOCOL_HASH?
 *
 * SIN governance: El deployer del contrato podría pushear un nuevo hash
 * y forzar a todos los nodos a actualizarse (centralización).
 *
 * CON governance:
 * 1. Solo validadores con identidad verificada en SoulprintRegistry
 *    pueden proponer o votar (anti-sybil by design)
 * 2. Se necesita SUPERMAYORÍA (70%) de nodos activos para aprobar
 * 3. TIMELOCK de 48h: aunque el 70% apruebe, hay ventana para veto
 * 4. VETO DE EMERGENCIA: 25% puede rechazar durante el timelock
 * 5. Una entidad (DID) = un voto, sin importar cuántas wallets tenga
 * 6. Quórum mínimo de 3 votos (evita manipulación en redes pequeñas)
 *
 * ¿Qué pasa si una IA controla un nodo y vota?
 * → Necesita identidad biométrica verificada (ZK proof real)
 * → Necesita que otros nodos también lo aprueben (mayoría)
 * → El timelock da 48h para que humanos hagan veto
 *
 * FLUJO:
 *   1. Nodo validador llama proposeUpgrade(newHash, rationale)
 *   2. Otros validadores llaman voteOnProposal(id, approve)
 *   3. Si votes >= 70% de activeNodes → estado: APPROVED
 *   4. Esperar 48h (timelock)
 *   5. Cualquiera llama executeProposal(id) → currentHash actualizado
 *   6. Si >25% vota en contra DURANTE el timelock → VETOED
 *
 * El currentApprovedHash es la fuente de verdad que los SDKs deben consultar.
 * ProtocolConstants.PROTOCOL_HASH es el hash génesis hardcodeado.
 */
contract GovernanceModule is ProtocolConstants {

    // ── Structs ───────────────────────────────────────────────────────────────

    enum ProposalState {
        ACTIVE,     // en votación
        APPROVED,   // supermayoría alcanzada, en timelock
        EXECUTED,   // upgrade ejecutado — nuevo hash vigente
        REJECTED,   // rechazado por mayoría o veto
        EXPIRED     // no alcanzó quórum en 7 días
    }

    struct Proposal {
        uint256     id;
        bytes32     newHash;           // nuevo PROTOCOL_HASH propuesto
        string      rationale;         // razón del upgrade (requerida)
        string      proposerDid;       // DID del proponente
        address     proposerAddr;
        uint64      createdAt;
        uint64      approvedAt;        // cuándo alcanzó supermayoría
        uint64      executedAt;
        uint32      votesFor;
        uint32      votesAgainst;
        ProposalState state;
    }

    struct Vote {
        bool  voted;
        bool  approve;
        uint64 timestamp;
    }

    // ── Constants ─────────────────────────────────────────────────────────────

    /// @notice 70% de nodos activos debe aprobar
    uint256 public constant APPROVAL_THRESHOLD_BPS = 7000; // 70.00%

    /// @notice 25% puede hacer veto durante timelock
    uint256 public constant VETO_THRESHOLD_BPS     = 2500; // 25.00%

    /// @notice Timelock: 48 horas tras supermayoría antes de ejecutar
    uint64  public constant TIMELOCK_DELAY         = 48 hours;

    /// @notice Propuesta expira si no alcanza quórum en 7 días
    uint64  public constant PROPOSAL_EXPIRY        = 7 days;

    /// @notice Mínimo de votos para que la propuesta sea válida
    uint32  public constant MINIMUM_QUORUM         = 3;

    // ── Storage ───────────────────────────────────────────────────────────────

    /// @notice Hash actualmente aprobado por governance.
    /// Empieza siendo el PROTOCOL_HASH hardcodeado del genesis.
    bytes32 public currentApprovedHash;

    /// @notice Historial de todos los hashes aprobados
    bytes32[] public hashHistory;

    /// @notice Propuestas por ID
    mapping(uint256 => Proposal) public proposals;

    /// @notice votos por propuesta → DID → Vote
    mapping(uint256 => mapping(string => Vote)) public votes;

    /// @notice DIDs que ya tienen una propuesta activa (máx 1 simultánea)
    mapping(string => bool) public hasActiveProposal;

    /// @notice total propuestas creadas (también es el próximo ID)
    uint256 public totalProposals;

    /// @notice referencias a contratos del ecosistema
    ValidatorRegistry public immutable validatorRegistry;
    SoulprintRegistry public immutable soulprintRegistry;

    // ── Events ────────────────────────────────────────────────────────────────

    event ProposalCreated(
        uint256 indexed id,
        bytes32         newHash,
        string          proposerDid,
        string          rationale,
        uint64          expiresAt
    );

    event VoteCast(
        uint256 indexed proposalId,
        string          voterDid,
        bool            approve,
        uint32          totalFor,
        uint32          totalAgainst
    );

    event ProposalApproved(
        uint256 indexed id,
        bytes32         newHash,
        uint64          executeAfter
    );

    event ProposalExecuted(
        uint256 indexed id,
        bytes32         oldHash,
        bytes32         newHash,
        uint64          timestamp
    );

    event ProposalRejected(
        uint256 indexed id,
        string          reason
    );

    event EmergencyVeto(
        uint256 indexed id,
        uint32          vetoes,
        uint32          totalVoters
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    error NotAVerifiedValidator(string did);
    error AlreadyVoted(string did, uint256 proposalId);
    error ProposalNotActive(uint256 id);
    error ProposalNotApproved(uint256 id);
    error TimelockNotExpired(uint64 executeAfter, uint64 now_);
    error SameHash(bytes32 hash);
    error RationaleRequired();
    error HasActiveProposal(string did);
    error ProposalExpired(uint256 id);
    error InsufficientQuorum(uint32 votes, uint32 required);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _validatorRegistry, address _soulprintRegistry) {
        validatorRegistry  = ValidatorRegistry(_validatorRegistry);
        soulprintRegistry  = SoulprintRegistry(_soulprintRegistry);
        currentApprovedHash = PROTOCOL_HASH;
        hashHistory.push(PROTOCOL_HASH);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    /**
     * @notice Verifica que el llamador tiene un DID con identidad verificada
     * Y está registrado como nodo validador compatible.
     */
    modifier onlyVerifiedValidator(string calldata did) {
        _checkVerifiedValidator(did);
        _;
    }

    function _checkVerifiedValidator(string calldata did) internal view {
        // 1. Tiene identidad verificada en SoulprintRegistry
        bytes32 nullifier = soulprintRegistry.didToNullifier(did);
        require(nullifier != bytes32(0), "No identity found for DID");
        (, , , , bool docVerified, bool faceVerified, bool active)
            = soulprintRegistry.getIdentityByNullifier(nullifier);
        if (!docVerified || !faceVerified || !active) {
            revert NotAVerifiedValidator(did);
        }

        // 2. Tiene nodo registrado como compatible
        (, , , , , , bool nodeActive, bool compatible)
            = validatorRegistry.getNodeFields(did);
        if (!nodeActive || !compatible) {
            revert NotAVerifiedValidator(did);
        }
    }

    // ── Core — Proponer ───────────────────────────────────────────────────────

    /**
     * @notice Propone un upgrade del PROTOCOL_HASH.
     *
     * Solo validadores con identidad verificada biométricamente pueden proponer.
     * Máx 1 propuesta activa por DID.
     *
     * @param did        DID del proponente (debe tener identidad on-chain)
     * @param newHash    Nuevo PROTOCOL_HASH propuesto
     * @param rationale  Explicación del cambio (requerida, >10 chars)
     */
    function proposeUpgrade(
        string calldata did,
        bytes32         newHash,
        string calldata rationale
    ) external onlyVerifiedValidator(did) returns (uint256 proposalId) {
        if (newHash == currentApprovedHash) revert SameHash(newHash);
        if (bytes(rationale).length < 10)   revert RationaleRequired();
        if (hasActiveProposal[did])          revert HasActiveProposal(did);

        proposalId = totalProposals++;
        hasActiveProposal[did] = true;

        proposals[proposalId] = Proposal({
            id:           proposalId,
            newHash:      newHash,
            rationale:    rationale,
            proposerDid:  did,
            proposerAddr: msg.sender,
            createdAt:    uint64(block.timestamp),
            approvedAt:   0,
            executedAt:   0,
            votesFor:     0,
            votesAgainst: 0,
            state:        ProposalState.ACTIVE
        });

        emit ProposalCreated(
            proposalId, newHash, did, rationale,
            uint64(block.timestamp) + PROPOSAL_EXPIRY
        );
    }

    // ── Core — Votar ─────────────────────────────────────────────────────────

    /**
     * @notice Vota en una propuesta activa o en timelock.
     *
     * Durante ACTIVE:   voto normal (for/against)
     * Durante APPROVED: voto en contra cuenta como veto de emergencia
     *
     * @param proposalId  ID de la propuesta
     * @param did         DID del votante
     * @param approve     true = a favor, false = en contra / veto
     */
    function voteOnProposal(
        uint256         proposalId,
        string calldata did,
        bool            approve
    ) external onlyVerifiedValidator(did) {
        Proposal storage p = proposals[proposalId];

        // Verificar estado
        if (p.state != ProposalState.ACTIVE && p.state != ProposalState.APPROVED) {
            revert ProposalNotActive(proposalId);
        }

        // Verificar expiración
        if (p.state == ProposalState.ACTIVE &&
            block.timestamp > p.createdAt + PROPOSAL_EXPIRY) {
            p.state = ProposalState.EXPIRED;
            emit ProposalRejected(proposalId, "expired");
            revert ProposalExpired(proposalId);
        }

        // Anti-replay: un DID = un voto
        if (votes[proposalId][did].voted) revert AlreadyVoted(did, proposalId);

        votes[proposalId][did] = Vote({
            voted:     true,
            approve:   approve,
            timestamp: uint64(block.timestamp)
        });

        if (approve) {
            p.votesFor++;
        } else {
            p.votesAgainst++;
        }

        emit VoteCast(proposalId, did, approve, p.votesFor, p.votesAgainst);

        // Evaluar si se alcanzó supermayoría
        _evaluateProposal(proposalId);
    }

    // ── Core — Ejecutar ──────────────────────────────────────────────────────

    /**
     * @notice Ejecuta una propuesta que pasó timelock.
     * Cualquiera puede llamar esto una vez que el timelock expiró.
     *
     * @param proposalId  ID de la propuesta a ejecutar
     */
    function executeProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];

        if (p.state != ProposalState.APPROVED) {
            revert ProposalNotApproved(proposalId);
        }

        uint64 executeAfter = p.approvedAt + TIMELOCK_DELAY;
        if (block.timestamp < executeAfter) {
            revert TimelockNotExpired(executeAfter, uint64(block.timestamp));
        }

        // Check quórum mínimo final
        if (p.votesFor < MINIMUM_QUORUM) {
            p.state = ProposalState.REJECTED;
            emit ProposalRejected(proposalId, "insufficient_quorum");
            revert InsufficientQuorum(p.votesFor, MINIMUM_QUORUM);
        }

        bytes32 oldHash = currentApprovedHash;
        bytes32 newHash = p.newHash;

        p.state       = ProposalState.EXECUTED;
        p.executedAt  = uint64(block.timestamp);
        hasActiveProposal[p.proposerDid] = false;

        currentApprovedHash = newHash;
        hashHistory.push(newHash);

        emit ProposalExecuted(proposalId, oldHash, newHash, uint64(block.timestamp));
    }

    // ── Internal — Evaluar ────────────────────────────────────────────────────

    function _evaluateProposal(uint256 proposalId) internal {
        Proposal storage p = proposals[proposalId];
        uint32 activeNodes = uint32(validatorRegistry.compatibleNodes());

        // Quórum mínimo de validadores activos para calcular porcentajes
        uint32 quorum = activeNodes > 0 ? activeNodes : 1;

        // ── Chequear veto de emergencia (durante timelock) ─────────────────
        if (p.state == ProposalState.APPROVED) {
            uint256 vetoRatio = (uint256(p.votesAgainst) * 10000) / quorum;
            if (vetoRatio >= VETO_THRESHOLD_BPS) {
                p.state = ProposalState.REJECTED;
                hasActiveProposal[p.proposerDid] = false;
                emit EmergencyVeto(proposalId, p.votesAgainst, quorum);
                emit ProposalRejected(proposalId, "emergency_veto");
            }
            return;
        }

        // ── Chequear supermayoría (durante ACTIVE) ────────────────────────
        uint256 approvalRatio = (uint256(p.votesFor) * 10000) / quorum;
        if (approvalRatio >= APPROVAL_THRESHOLD_BPS && p.votesFor >= MINIMUM_QUORUM) {
            p.state     = ProposalState.APPROVED;
            p.approvedAt = uint64(block.timestamp);
            emit ProposalApproved(proposalId, p.newHash, p.approvedAt + TIMELOCK_DELAY);
        }

        // ── Chequear rechazo claro (más del 50% en contra) ────────────────
        uint256 rejectRatio = (uint256(p.votesAgainst) * 10000) / quorum;
        if (rejectRatio > 5000) {
            p.state = ProposalState.REJECTED;
            hasActiveProposal[p.proposerDid] = false;
            emit ProposalRejected(proposalId, "majority_against");
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /**
     * @notice Retorna el estado completo de una propuesta.
     */
    function getProposal(uint256 proposalId)
        external view
        returns (Proposal memory)
    {
        return proposals[proposalId];
    }

    /**
     * @notice Retorna todas las propuestas activas.
     */
    function getActiveProposals() external view returns (Proposal[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < totalProposals; i++) {
            if (proposals[i].state == ProposalState.ACTIVE ||
                proposals[i].state == ProposalState.APPROVED) {
                count++;
            }
        }
        Proposal[] memory result = new Proposal[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < totalProposals; i++) {
            if (proposals[i].state == ProposalState.ACTIVE ||
                proposals[i].state == ProposalState.APPROVED) {
                result[idx++] = proposals[i];
            }
        }
        return result;
    }

    /**
     * @notice Historial de hashes aprobados (auditoría completa).
     */
    function getHashHistory() external view returns (bytes32[] memory) {
        return hashHistory;
    }

    /**
     * @notice Verifica si el hash actual de la red es el aprobado por governance.
     * Los nodos deben llamar esto al conectarse.
     */
    function isCurrentHashValid(bytes32 hash) external view returns (bool) {
        return hash == currentApprovedHash;
    }

    /**
     * @notice Calcula porcentaje de aprobación de una propuesta (BPS × 100).
     */
    function getApprovalPercentage(uint256 proposalId)
        external view
        returns (uint256 forPct, uint256 againstPct, uint32 activeNodes)
    {
        Proposal memory p = proposals[proposalId];
        activeNodes = uint32(validatorRegistry.compatibleNodes());
        uint32 quorum = activeNodes > 0 ? activeNodes : 1;
        forPct     = (uint256(p.votesFor)     * 10000) / quorum;
        againstPct = (uint256(p.votesAgainst) * 10000) / quorum;
    }

    /**
     * @notice Tiempo restante del timelock de una propuesta aprobada.
     * Retorna 0 si el timelock ya expiró.
     */
    function timelockRemaining(uint256 proposalId)
        external view
        returns (uint64 secondsLeft)
    {
        Proposal memory p = proposals[proposalId];
        if (p.state != ProposalState.APPROVED) return 0;
        uint64 executeAfter = p.approvedAt + TIMELOCK_DELAY;
        if (block.timestamp >= executeAfter) return 0;
        return executeAfter - uint64(block.timestamp);
    }
}
