import { expect }        from "chai";
import { ethers }        from "hardhat";
import { anyValue }      from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ContractFactory, Signer } from "ethers";

/**
 * Tests completos para los contratos Soulprint.
 * Corre con: npx hardhat test
 */
describe("Soulprint Blockchain Contracts", function () {

  // ── Fixtures ──────────────────────────────────────────────────────────────

  let deployer: Signer;
  let serviceA: Signer;
  let serviceB: Signer;
  let user1: Signer;

  let ProtocolConstants: any;
  let MockVerifier: any;
  let Registry: ContractFactory;
  let Ledger: ContractFactory;
  let ValidatorReg: ContractFactory;

  let constants: any;
  let mockVerifier: any;
  let registry: any;
  let ledger: any;
  let validatorReg: any;

  // DIDs de prueba
  const SERVICE_A_DID = "did:key:z6MkServiceAAA";
  const SERVICE_B_DID = "did:key:z6MkServiceBBB";
  const BOT_DID       = "did:key:z6MkBotXYZ123";
  const BOT_DID_2     = "did:key:z6MkBotABC456";
  const NODE_DID      = "did:key:z6MkNode111";

  // Nullifier de prueba (simula Poseidon hash)
  const NULLIFIER_1 = ethers.keccak256(ethers.toUtf8Bytes("user_cedula_1"));
  const NULLIFIER_2 = ethers.keccak256(ethers.toUtf8Bytes("user_cedula_2"));

  // Mock ZK proof (válido en MockVerifier si input[0] != 0)
  const MOCK_PROOF_A = [1n, 2n] as [bigint, bigint];
  const MOCK_PROOF_B = [[3n, 4n], [5n, 6n]] as [[bigint, bigint], [bigint, bigint]];
  const MOCK_PROOF_C = [7n, 8n] as [bigint, bigint];
  const MOCK_INPUTS  = [BigInt(NULLIFIER_1), 1n] as [bigint, bigint];

  const EXPECTED_HASH = "0xdfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";

  before(async function () {
    [deployer, serviceA, serviceB, user1] = await ethers.getSigners();

    ProtocolConstants = await ethers.getContractFactory("ProtocolConstants");
    MockVerifier      = await ethers.getContractFactory("MockGroth16Verifier");
    Registry          = await ethers.getContractFactory("SoulprintRegistry");
    Ledger            = await ethers.getContractFactory("AttestationLedger");
    ValidatorReg      = await ethers.getContractFactory("ValidatorRegistry");

    constants    = await ProtocolConstants.deploy();
    mockVerifier = await MockVerifier.deploy();
    registry     = await Registry.deploy(await mockVerifier.getAddress());
    ledger       = await Ledger.deploy(await registry.getAddress());
    validatorReg = await ValidatorReg.deploy();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ProtocolConstants
  // ══════════════════════════════════════════════════════════════════════════

  describe("ProtocolConstants", function () {

    it("PROTOCOL_HASH coincide con soulprint-core@0.1.7", async function () {
      const hash = await constants.PROTOCOL_HASH();
      expect(hash).to.equal(EXPECTED_HASH);
    });

    it("SCORE_FLOOR = 65", async function () {
      expect(await constants.SCORE_FLOOR()).to.equal(65);
    });

    it("FACE_SIM_DOC_SELFIE = 350 (0.35 × 1000)", async function () {
      expect(await constants.FACE_SIM_DOC_SELFIE()).to.equal(350);
    });

    it("FACE_SIM_SELFIE_SELFIE = 650 (0.65 × 1000)", async function () {
      expect(await constants.FACE_SIM_SELFIE_SELFIE()).to.equal(650);
    });

    it("isCompatible() retorna true para el hash correcto", async function () {
      expect(await constants.isCompatible(EXPECTED_HASH)).to.be.true;
    });

    it("isCompatible() retorna false para hash diferente", async function () {
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("modified_constants"));
      expect(await constants.isCompatible(wrongHash)).to.be.false;
    });

    it("verifyAndLog() emite evento ConstantsVerified", async function () {
      await expect(constants.verifyAndLog(EXPECTED_HASH))
        .to.emit(constants, "ConstantsVerified")
        .withArgs(deployer.address, EXPECTED_HASH, true);
    });

    it("IDENTITY_MAX = 80", async function () {
      expect(await constants.IDENTITY_MAX()).to.equal(80);
    });

    it("MIN_ATTESTER_SCORE = 65", async function () {
      expect(await constants.MIN_ATTESTER_SCORE()).to.equal(65);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SoulprintRegistry
  // ══════════════════════════════════════════════════════════════════════════

  describe("SoulprintRegistry", function () {

    it("registra identidad con ZK proof válido", async function () {
      await expect(
        registry.registerIdentity(
          NULLIFIER_1, BOT_DID,
          true, true,  // documentVerified, faceVerified
          MOCK_PROOF_A, MOCK_PROOF_B, MOCK_PROOF_C,
          MOCK_INPUTS
        )
      ).to.emit(registry, "IdentityRegistered")
       .withArgs(NULLIFIER_1, BOT_DID, 80, anyValue);
    });

    it("identity score correcto: doc+face = 30+25+25 = 80", async function () {
      const score = await registry.identityScore(BOT_DID);
      expect(score).to.equal(80);
    });

    it("isRegistered() retorna true después de registrar", async function () {
      expect(await registry.isRegistered(NULLIFIER_1)).to.be.true;
    });

    it("anti-sybil: rechaza segundo registro con mismo nullifier", async function () {
      await expect(
        registry.registerIdentity(
          NULLIFIER_1, "did:key:z6MkOtro",
          true, true,
          MOCK_PROOF_A, MOCK_PROOF_B, MOCK_PROOF_C, MOCK_INPUTS
        )
      ).to.be.revertedWithCustomError(registry, "NullifierAlreadyUsed");
    });

    it("rechaza ZK proof inválido (input[0] = 0 en mock)", async function () {
      const badInputs = [0n, 1n] as [bigint, bigint];
      await expect(
        registry.registerIdentity(
          NULLIFIER_2, BOT_DID_2,
          true, true,
          MOCK_PROOF_A, MOCK_PROOF_B, MOCK_PROOF_C, badInputs
        )
      ).to.be.revertedWithCustomError(registry, "InvalidZKProof");
    });

    it("registra segundo bot con nullifier diferente", async function () {
      const inputs2 = [BigInt(NULLIFIER_2), 1n] as [bigint, bigint];
      await expect(
        registry.registerIdentity(
          NULLIFIER_2, BOT_DID_2,
          true, false,  // solo document, sin face
          MOCK_PROOF_A, MOCK_PROOF_B, MOCK_PROOF_C, inputs2
        )
      ).to.emit(registry, "IdentityRegistered");

      // doc sin face: 30+25 = 55
      expect(await registry.identityScore(BOT_DID_2)).to.equal(55);
    });

    it("getIdentity() retorna datos correctos", async function () {
      const id = await registry.getIdentity(BOT_DID);
      expect(id.did).to.equal(BOT_DID);
      expect(id.documentVerified).to.be.true;
      expect(id.faceVerified).to.be.true;
      expect(id.active).to.be.true;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // AttestationLedger
  // ══════════════════════════════════════════════════════════════════════════

  describe("AttestationLedger", function () {

    const SIG = "0x1234"; // firma mock

    before(async function () {
      // Necesitamos que SERVICE_A_DID tenga score >= 65 para atestar
      // Registramos SERVICE_A con doc+face (score = 80)
      const nullifierSA  = ethers.keccak256(ethers.toUtf8Bytes("service_a_cedula"));
      const inputsSA     = [BigInt(nullifierSA), 1n] as [bigint, bigint];
      await registry.registerIdentity(
        nullifierSA, SERVICE_A_DID,
        true, true,
        MOCK_PROOF_A, MOCK_PROOF_B, MOCK_PROOF_C, inputsSA
      );
    });

    it("servicio con score >= 65 puede atestar +1", async function () {
      await expect(
        ledger.attest(SERVICE_A_DID, BOT_DID, 1, "normal-usage", SIG)
      ).to.emit(ledger, "AttestationRecorded")
       .withArgs(BOT_DID, SERVICE_A_DID, 1, "normal-usage", anyValue);
    });

    it("score total después de +1: identity(80) + reputation(10+1=11) = 91", async function () {
      const total = await ledger.getTotalScore(BOT_DID);
      expect(total).to.equal(91);
    });

    it("anti-farming: mismo issuer no puede atestar de nuevo dentro de 24h", async function () {
      await expect(
        ledger.attest(SERVICE_A_DID, BOT_DID, 1, "spam", SIG)
      ).to.be.revertedWithCustomError(ledger, "CooldownActive");
    });

    it("canAttest() retorna false durante cooldown", async function () {
      const [allowed] = await ledger.canAttest(SERVICE_A_DID, BOT_DID);
      expect(allowed).to.be.false;
    });

    it("rechaza value != 1 y != -1", async function () {
      await expect(
        ledger.attest(SERVICE_A_DID, BOT_DID, 2, "invalid", SIG)
      ).to.be.revertedWithCustomError(ledger, "InvalidValue");
    });

    it("servicio sin score suficiente no puede atestar", async function () {
      // BOT_DID_2 tiene score 55 < 65 = MIN_ATTESTER_SCORE
      await expect(
        ledger.attest(BOT_DID_2, BOT_DID, 1, "test", SIG)
      ).to.be.revertedWithCustomError(ledger, "IssuerNotAuthorized");
    });

    it("rechaza atestarse a uno mismo", async function () {
      await expect(
        ledger.attest(SERVICE_A_DID, SERVICE_A_DID, 1, "self", SIG)
      ).to.be.revertedWithCustomError(ledger, "SameIssuerTarget");
    });

    it("historial de attestations accesible on-chain", async function () {
      const history = await ledger.getAttestations(BOT_DID);
      expect(history.length).to.equal(1);
      expect(history[0].value).to.equal(1n);
      expect(history[0].context).to.equal("normal-usage");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ValidatorRegistry
  // ══════════════════════════════════════════════════════════════════════════

  describe("ValidatorRegistry", function () {

    const NODE_URL      = "https://node1.soulprint.digital:4888";
    const CORRECT_HASH  = EXPECTED_HASH;
    const WRONG_HASH    = ethers.keccak256(ethers.toUtf8Bytes("modified"));

    it("registra nodo con hash correcto como compatible", async function () {
      await expect(
        validatorReg.registerNode(NODE_URL, NODE_DID, CORRECT_HASH)
      ).to.emit(validatorReg, "NodeRegistered")
       .withArgs(NODE_DID, NODE_URL, CORRECT_HASH, true, anyValue);

      const node = await validatorReg.getNode(NODE_DID);
      expect(node.compatible).to.be.true;
    });

    it("registra nodo con hash incorrecto como incompatible + emite NodeIncompatible", async function () {
      const badNodeDid = "did:key:z6MkBadNode";
      await expect(
        validatorReg.registerNode("https://evil.node.com", badNodeDid, WRONG_HASH)
      ).to.emit(validatorReg, "NodeIncompatible")
       .withArgs(badNodeDid, WRONG_HASH, CORRECT_HASH);

      const node = await validatorReg.getNode(badNodeDid);
      expect(node.compatible).to.be.false;
    });

    it("rechaza registro duplicado", async function () {
      await expect(
        validatorReg.registerNode(NODE_URL, NODE_DID, CORRECT_HASH)
      ).to.be.revertedWithCustomError(validatorReg, "AlreadyRegistered");
    });

    it("heartbeat actualiza lastSeen", async function () {
      await expect(
        validatorReg.heartbeat(NODE_DID, 42)
      ).to.emit(validatorReg, "NodeHeartbeat")
       .withArgs(NODE_DID, anyValue, 42);
    });

    it("getActiveNodes() retorna solo nodos compatibles", async function () {
      const active = await validatorReg.getActiveNodes();
      // Solo NODE_DID debería estar (el malicioso tiene compatible=false)
      expect(active.length).to.be.gte(1);
      for (const node of active) {
        expect(node.compatible).to.be.true;
      }
    });

    it("totalNodes incluye ambos, compatibleNodes solo el oficial", async function () {
      expect(await validatorReg.totalNodes()).to.equal(2n);
      expect(await validatorReg.compatibleNodes()).to.equal(1n);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Integración: flujo completo
  // ══════════════════════════════════════════════════════════════════════════

  describe("Flujo completo — verify → attest → score", function () {

    it("score total de bot verificado con +1 es 91/100", async function () {
      const total = await ledger.getTotalScore(BOT_DID);
      expect(total).to.equal(91); // identity 80 + rep 11
    });

    it("score de bot sin attestations es identity + DEFAULT_REP = 80+10 = 90", async function () {
      // Registrar nuevo bot
      const newDid      = "did:key:z6MkNewBot999";
      const newNullifier = ethers.keccak256(ethers.toUtf8Bytes("new_bot_cedula_999"));
      const newInputs    = [BigInt(newNullifier), 1n] as [bigint, bigint];
      await registry.registerIdentity(
        newNullifier, newDid, true, true,
        MOCK_PROOF_A, MOCK_PROOF_B, MOCK_PROOF_C, newInputs
      );
      const score = await ledger.getTotalScore(newDid);
      expect(score).to.equal(90); // 80 identity + 10 default rep
    });

    it("PROTOCOL_HASH es el mismo en todos los contratos", async function () {
      const hashConstants  = await constants.PROTOCOL_HASH();
      const hashRegistry   = await registry.PROTOCOL_HASH();
      const hashLedger     = await ledger.PROTOCOL_HASH();
      const hashValidator  = await validatorReg.PROTOCOL_HASH();

      expect(hashConstants).to.equal(EXPECTED_HASH);
      expect(hashRegistry).to.equal(EXPECTED_HASH);
      expect(hashLedger).to.equal(EXPECTED_HASH);
      expect(hashValidator).to.equal(EXPECTED_HASH);
    });
  });
});
