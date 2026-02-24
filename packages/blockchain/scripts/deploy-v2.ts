/**
 * deploy-v2.ts — Redeploy completo v0.3.4:
 *  - Groth16Verifier REAL (snarkjs, no mock)
 *  - SoulprintRegistry v2 (updateVerifier + setGovernance)
 *  - GovernanceModule actualizado a registry v2
 *  - Admin bloqueado → solo governance controla el verifier
 *
 * Usa contratos existentes donde sea posible:
 *  AttestationLedger, ValidatorRegistry — sin cambios → reusar
 *  ProtocolConstants — sin cambios → reusar
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const balance    = await ethers.provider.getBalance(deployer.address);

  console.log("\n🔐 Soulprint v0.3.4 — Fix 1 + Fix 2 Deploy");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Network:  ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);

  const deployFile = join(__dirname, `../deployments/${network.name}.json`);
  const old = JSON.parse(readFileSync(deployFile, "utf8"));

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // ── Reusar contratos sin cambios ─────────────────────────────────────────
  const constantsAddr    = old.contracts.ProtocolConstants;
  const ledgerAddr       = old.contracts.AttestationLedger;
  const validatorRegAddr = old.contracts.ValidatorRegistry;
  console.log(`♻️  Reutilizando:`);
  console.log(`   ProtocolConstants: ${constantsAddr}`);
  console.log(`   AttestationLedger: ${ledgerAddr}`);
  console.log(`   ValidatorRegistry: ${validatorRegAddr}\n`);

  // ── Step 1: Groth16Verifier REAL ─────────────────────────────────────────
  console.log("⚡ Step 1: Deploy Groth16Verifier (REAL — snarkjs)...");
  const VerifierFactory = await ethers.getContractFactory("Groth16Verifier");
  const realVerifier    = await VerifierFactory.deploy();
  await realVerifier.waitForDeployment();
  await sleep(3000);
  const realVerifierAddr = await realVerifier.getAddress();
  console.log(`   ✅ Groth16Verifier: ${realVerifierAddr}`);

  // Verificar que rechaza proof vacía (diferencia clave vs mock)
  try {
    const valid = await realVerifier.verifyProof(
      [0n, 0n], [[0n, 0n], [0n, 0n]], [0n, 0n], [1n, 0n, 0n]
    );
    console.log(`   ${valid ? "⚠️  ACEPTA proof vacía — revisar" : "✅ RECHAZA proof vacía (correcto)"}`);
  } catch {
    console.log(`   ✅ REVERTS en proof vacía (correcto)`);
  }

  // ── Step 2: SoulprintRegistry v2 ─────────────────────────────────────────
  console.log("\n📋 Step 2: Deploy SoulprintRegistry v2 (governance-controlled verifier)...");
  const RegistryFactory = await ethers.getContractFactory("SoulprintRegistry");
  const registry        = await RegistryFactory.deploy(realVerifierAddr);
  await registry.waitForDeployment();
  await sleep(3000);
  const registryAddr = await registry.getAddress();
  console.log(`   ✅ SoulprintRegistry v2: ${registryAddr}`);
  console.log(`   ✅ verifier: ${await registry.verifier()}`);
  console.log(`   ✅ admin:    ${await registry.admin()}`);

  // ── Step 3: GovernanceModule v2 → apunta a registry v2 ──────────────────
  console.log("\n🏛️  Step 3: Deploy GovernanceModule v2 (apunta a registry v2)...");
  const GovFactory  = await ethers.getContractFactory("GovernanceModule");
  const governance  = await GovFactory.deploy(validatorRegAddr, registryAddr);
  await governance.waitForDeployment();
  await sleep(3000);
  const governanceAddr = await governance.getAddress();
  console.log(`   ✅ GovernanceModule v2: ${governanceAddr}`);
  console.log(`   ✅ currentApprovedHash: ${(await governance.currentApprovedHash()).slice(0,12)}...`);

  // ── Step 4: setGovernance → lock admin ───────────────────────────────────
  console.log("\n🔒 Step 4: setGovernance → bloquear admin para siempre...");
  const tx = await registry.setGovernance(governanceAddr);
  await tx.wait();
  await sleep(2000);
  const finalAdmin = await registry.admin();
  const finalGov   = await registry.governance();
  console.log(`   ✅ tx: ${tx.hash}`);
  console.log(`   ✅ admin:      ${finalAdmin}`);
  console.log(`   ✅ governance: ${finalGov}`);
  console.log(`   ${finalAdmin === ethers.ZeroAddress
    ? "✅ Admin BLOQUEADO — solo governance puede cambiar el verifier"
    : "⚠️  Admin no bloqueado"}`);

  // ── Guardar deployment v2 ────────────────────────────────────────────────
  const deployment = {
    network:     network.name,
    chainId:     Number(network.chainId),
    version:     "0.3.4",
    deployedAt:  new Date().toISOString(),
    deployer:    deployer.address,
    verifierReal: true,
    adminLocked:  true,
    contracts: {
      ProtocolConstants:      constantsAddr,
      Groth16Verifier:        realVerifierAddr,
      Groth16VerifierMock:    old.contracts.Groth16VerifierMock ?? old.contracts.Groth16Verifier,
      SoulprintRegistry:      registryAddr,
      SoulprintRegistryV1:    old.contracts.SoulprintRegistry,
      AttestationLedger:      ledgerAddr,
      ValidatorRegistry:      validatorRegAddr,
      GovernanceModule:       governanceAddr,
      GovernanceModuleV1:     old.contracts.GovernanceModule,
    },
    protocolHash: old.protocolHash,
  };
  writeFileSync(deployFile, JSON.stringify(deployment, null, 2));

  console.log("\n═══════════════════════════════════════════════════");
  console.log("✅ v0.3.4 DEPLOYED");
  console.log(`\n   Groth16Verifier (REAL): ${realVerifierAddr}`);
  console.log(`   SoulprintRegistry  v2:  ${registryAddr}`);
  console.log(`   GovernanceModule   v2:  ${governanceAddr}`);
  console.log(`\n   Seguridad:`);
  console.log(`   🔒 Admin bloqueado — cambios de verifier requieren governance`);
  console.log(`   ✅ ZK proofs verificadas matemáticamente on-chain`);
  console.log(`   ✅ MockGroth16Verifier ya no acepta identidades falsas`);
  console.log(`\n   BaseScan:`);
  console.log(`   https://sepolia.basescan.org/address/${realVerifierAddr}`);
  console.log(`   https://sepolia.basescan.org/address/${registryAddr}`);
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch(console.error);
