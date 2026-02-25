/**
 * deploy-protocol-thresholds.ts
 * Deploy ProtocolThresholds.sol → Base Sepolia
 * Thresholds del protocolo mutables solo por superAdmin.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const balance    = await ethers.provider.getBalance(deployer.address);

  console.log("\n🌐  ProtocolThresholds Deploy");
  console.log("═══════════════════════════════════════");
  console.log(`Network:    ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer:   ${deployer.address}`);
  console.log(`Balance:    ${ethers.formatEther(balance)} ETH`);

  // Deploy
  const Factory   = await ethers.getContractFactory("ProtocolThresholds");
  const contract  = await Factory.deploy(deployer.address);
  await contract.waitForDeployment();
  const address   = await contract.getAddress();

  console.log(`\n✅ ProtocolThresholds desplegado`);
  console.log(`   Address:    ${address}`);
  console.log(`   SuperAdmin: ${deployer.address}`);
  console.log(`   Explorer:   https://sepolia.basescan.org/address/${address}`);

  // Verificar thresholds iniciales (con retry para dar tiempo a la red)
  console.log("\n📋 Thresholds on-chain (valores iniciales):");
  await new Promise(r => setTimeout(r, 5000)); // esperar indexación
  try {
    const scoreFloor = await (contract as any).getThreshold("SCORE_FLOOR");
    const verFloor   = await (contract as any).getThreshold("VERIFIED_SCORE_FLOOR");
    const minAtt     = await (contract as any).getThreshold("MIN_ATTESTER_SCORE");
    const faceSim    = await (contract as any).getThreshold("FACE_SIM_DOC_SELFIE");
    const defRep     = await (contract as any).getThreshold("DEFAULT_REPUTATION");
    const idMax      = await (contract as any).getThreshold("IDENTITY_MAX");
    const repMax     = await (contract as any).getThreshold("REPUTATION_MAX");
    console.log(`   SCORE_FLOOR            = ${scoreFloor}`);
    console.log(`   VERIFIED_SCORE_FLOOR   = ${verFloor}`);
    console.log(`   MIN_ATTESTER_SCORE     = ${minAtt}`);
    console.log(`   FACE_SIM_DOC_SELFIE    = ${faceSim} (= ${Number(faceSim)/1000})`);
    console.log(`   DEFAULT_REPUTATION     = ${defRep}`);
    console.log(`   IDENTITY_MAX           = ${idMax}`);
    console.log(`   REPUTATION_MAX         = ${repMax}`);
  } catch(e: any) {
    console.warn(`   ⚠️  No se pudo leer aún (${e.shortMessage ?? e.message}) — usa el explorador`);
  }

  // Guardar en deployments
  const depFile = join(__dirname, "../deployments/base-sepolia.json");
  let deps: Record<string, string> = {};
  try { deps = JSON.parse(readFileSync(depFile, "utf8")); } catch {}
  deps["ProtocolThresholds"] = address;
  writeFileSync(depFile, JSON.stringify(deps, null, 2));
  console.log(`\n💾 Guardado en deployments/base-sepolia.json`);
}

main().catch(err => { console.error("❌", err); process.exit(1); });
