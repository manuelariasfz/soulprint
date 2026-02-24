import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploy script — Soulprint Blockchain Contracts
 *
 * Orden de deploy:
 * 1. ProtocolConstants (sin dependencias)
 * 2. MockGroth16Verifier (solo en testnet/hardhat) o Groth16Verifier real
 * 3. SoulprintRegistry (necesita verifier)
 * 4. AttestationLedger (necesita registry)
 * 5. ValidatorRegistry (sin dependencias)
 *
 * Uso:
 *   npx hardhat run scripts/deploy.ts --network hardhat
 *   npx hardhat run scripts/deploy.ts --network base-sepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("\n🔐 Soulprint Blockchain Deployment");
  console.log("═══════════════════════════════════════");
  console.log(`Network:   ${network.name} (chainId: ${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH\n`);

  const isTestnet = network.name === "hardhat" ||
                    network.name === "base-sepolia" ||
                    network.name === "polygon-amoy";

  // ── 1. ProtocolConstants ──────────────────────────────────────────────────
  console.log("📋 Deploying ProtocolConstants...");
  const ProtocolConstants = await ethers.getContractFactory("ProtocolConstants");
  const constants = await ProtocolConstants.deploy();
  await constants.waitForDeployment();
  const constantsAddr = await constants.getAddress();
  console.log(`   ✅ ProtocolConstants: ${constantsAddr}`);

  // Verificar que el hash on-chain coincide con el de TypeScript
  const onChainHash = await constants.PROTOCOL_HASH();
  const expectedHash = "0xdfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";
  const hashMatch = onChainHash === expectedHash;
  console.log(`   ${hashMatch ? "✅" : "❌"} PROTOCOL_HASH: ${onChainHash.slice(0, 18)}...`);
  if (!hashMatch) throw new Error(`PROTOCOL_HASH mismatch! On-chain: ${onChainHash}, expected: ${expectedHash}`);

  // ── 2. Groth16Verifier ────────────────────────────────────────────────────
  let verifierAddr: string;
  if (isTestnet) {
    console.log("\n🧪 Deploying MockGroth16Verifier (testnet)...");
    const MockVerifier = await ethers.getContractFactory("MockGroth16Verifier");
    const mockVerifier = await MockVerifier.deploy();
    await mockVerifier.waitForDeployment();
    verifierAddr = await mockVerifier.getAddress();
    console.log(`   ✅ MockGroth16Verifier: ${verifierAddr}`);
  } else {
    console.log("\n🔒 Deploying Groth16Verifier (mainnet)...");
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();
    verifierAddr = await verifier.getAddress();
    console.log(`   ✅ Groth16Verifier: ${verifierAddr}`);
  }

  // ── 3. SoulprintRegistry ──────────────────────────────────────────────────
  console.log("\n👤 Deploying SoulprintRegistry...");
  const Registry = await ethers.getContractFactory("SoulprintRegistry");
  const registry = await Registry.deploy(verifierAddr);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`   ✅ SoulprintRegistry: ${registryAddr}`);

  // ── 4. AttestationLedger ──────────────────────────────────────────────────
  console.log("\n📊 Deploying AttestationLedger...");
  const Ledger = await ethers.getContractFactory("AttestationLedger");
  const ledger = await Ledger.deploy(registryAddr);
  await ledger.waitForDeployment();
  const ledgerAddr = await ledger.getAddress();
  console.log(`   ✅ AttestationLedger: ${ledgerAddr}`);

  // ── 5. ValidatorRegistry ──────────────────────────────────────────────────
  console.log("\n🌐 Deploying ValidatorRegistry...");
  const ValidatorReg = await ethers.getContractFactory("ValidatorRegistry");
  const validatorReg = await ValidatorReg.deploy();
  await validatorReg.waitForDeployment();
  const validatorRegAddr = await validatorReg.getAddress();
  console.log(`   ✅ ValidatorRegistry: ${validatorRegAddr}`);

  // ── Guardar direcciones ───────────────────────────────────────────────────
  const deployment = {
    network:         network.name,
    chainId:         Number(chainId),
    deployedAt:      new Date().toISOString(),
    deployer:        deployer.address,
    contracts: {
      ProtocolConstants:  constantsAddr,
      Groth16Verifier:    verifierAddr,
      SoulprintRegistry:  registryAddr,
      AttestationLedger:  ledgerAddr,
      ValidatorRegistry:  validatorRegAddr,
    },
    protocolHash: onChainHash,
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const outFile = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));

  console.log("\n═══════════════════════════════════════");
  console.log("✅ DEPLOYMENT COMPLETE");
  console.log(`   Saved to: deployments/${network.name}.json`);
  console.log("\n   Contract addresses:");
  Object.entries(deployment.contracts).forEach(([name, addr]) => {
    console.log(`   ${name.padEnd(20)}: ${addr}`);
  });

  if (network.name === "base-sepolia") {
    console.log("\n   View on BaseScan:");
    Object.entries(deployment.contracts).forEach(([name, addr]) => {
      console.log(`   ${name}: https://sepolia.basescan.org/address/${addr}`);
    });
  }

  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
