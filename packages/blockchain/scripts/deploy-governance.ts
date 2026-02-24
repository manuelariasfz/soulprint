/**
 * deploy-governance.ts — Deploy solo GovernanceModule usando contratos ya deployados.
 * Usa las addresses del archivo deployments/base-sepolia.json existente.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const balance    = await ethers.provider.getBalance(deployer.address);

  console.log("\n🏛️  Soulprint GovernanceModule Deploy");
  console.log("═══════════════════════════════════════");
  console.log(`Network:   ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH\n`);

  // Leer deployment existente
  const deployFile = join(__dirname, `../deployments/${network.name}.json`);
  let existing: any = {};
  try {
    existing = JSON.parse(readFileSync(deployFile, "utf8"));
  } catch {
    console.error(`❌ No se encontró ${deployFile}. Deploy los contratos base primero.`);
    process.exit(1);
  }

  const validatorAddr  = existing.contracts?.ValidatorRegistry;
  const registryAddr   = existing.contracts?.SoulprintRegistry;

  if (!validatorAddr || !registryAddr) {
    console.error("❌ Faltan ValidatorRegistry o SoulprintRegistry en el deployment.");
    process.exit(1);
  }

  console.log(`📋 Usando contratos existentes:`);
  console.log(`   ValidatorRegistry: ${validatorAddr}`);
  console.log(`   SoulprintRegistry: ${registryAddr}\n`);

  // Deploy GovernanceModule
  console.log("🏛️  Deploying GovernanceModule...");
  const GovernanceFactory = await ethers.getContractFactory("GovernanceModule");
  const governance = await GovernanceFactory.deploy(validatorAddr, registryAddr);
  await governance.waitForDeployment();
  await new Promise(r => setTimeout(r, 3000));

  const govAddr = await governance.getAddress();
  console.log(`   ✅ GovernanceModule: ${govAddr}`);

  // Verificar que currentApprovedHash == PROTOCOL_HASH
  const currentHash   = await governance.currentApprovedHash();
  const protocolHash  = await governance.PROTOCOL_HASH();
  const hashOk        = currentHash === protocolHash;
  console.log(`   ✅ currentApprovedHash = PROTOCOL_HASH: ${hashOk ? "✅" : "❌"}`);
  console.log(`   ✅ APPROVAL_THRESHOLD_BPS: ${await governance.APPROVAL_THRESHOLD_BPS()} (70%)`);
  console.log(`   ✅ TIMELOCK_DELAY: ${await governance.TIMELOCK_DELAY()}s (48h)`);
  console.log(`   ✅ VETO_THRESHOLD_BPS: ${await governance.VETO_THRESHOLD_BPS()} (25%)`);

  // Actualizar deployment file
  existing.contracts.GovernanceModule = govAddr;
  existing.deployedAt = new Date().toISOString();
  writeFileSync(deployFile, JSON.stringify(existing, null, 2));

  console.log("\n═══════════════════════════════════════");
  console.log("✅ GOVERNANCE DEPLOYED");
  console.log(`   GovernanceModule: ${govAddr}`);
  console.log(`\n   View on BaseScan:`);
  console.log(`   ${govAddr.slice(0,6)}...${govAddr.slice(-4)}: https://sepolia.basescan.org/address/${govAddr}`);
  console.log("═══════════════════════════════════════\n");
}

main().catch(console.error);
