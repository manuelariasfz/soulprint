/**
 * deploy-mcp-registry.ts — Deploy MCPRegistry + auto-registro de mcp-colombia-hub.
 * Usa el deployer wallet como superAdmin inicial.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Dirección pública de mcp-colombia-hub (usamos el deployer como identificador)
const MCP_COLOMBIA_ADDRESS = "0x0755A3001F488da00088838c4a068dF7f883ad87"; // mismo que deployer

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const balance    = await ethers.provider.getBalance(deployer.address);

  console.log("\n🌐  MCPRegistry Deploy");
  console.log("═══════════════════════════════════════");
  console.log(`Network:    ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer:   ${deployer.address}`);
  console.log(`SuperAdmin: ${deployer.address}`);
  console.log(`Balance:    ${ethers.formatEther(balance)} ETH\n`);

  if (balance < ethers.parseEther("0.000005")) {
    console.error("❌ Saldo insuficiente. Necesitas al menos 0.000005 ETH.");
    process.exit(1);
  }

  // ── 1. Deploy MCPRegistry ─────────────────────────────────────────────────
  console.log("📋 Deploying MCPRegistry...");
  const Factory = await ethers.getContractFactory("MCPRegistry");
  const registry = await Factory.deploy(deployer.address);
  await registry.waitForDeployment();
  await new Promise(r => setTimeout(r, 2000));

  const regAddr = await registry.getAddress();
  console.log(`   ✅ MCPRegistry: ${regAddr}`);

  // Verificar superAdmin
  const admin = await registry.superAdmin();
  console.log(`   ✅ superAdmin: ${admin}`);
  console.log(`   ✅ Admin correcto: ${admin === deployer.address}`);

  // ── 2. Registrar mcp-colombia-hub ─────────────────────────────────────────
  console.log("\n🇨🇴 Registrando mcp-colombia-hub...");
  const tx1 = await registry.registerMCP(
    MCP_COLOMBIA_ADDRESS,
    "MCP Colombia Hub",
    "https://www.npmjs.com/package/mcp-colombia-hub",
    "",   // DID (vacío por ahora)
    "general",
    "Aggregates Colombian services: MercadoLibre, Booking.com hotels/flights, financial products, job applications with Soulprint identity."
  );
  await tx1.wait();
  console.log(`   ✅ mcp-colombia-hub registrado`);

  // ── 3. Verificar mcp-colombia-hub (auto-verify como primer MCP oficial) ───
  console.log("\n✅ Verificando mcp-colombia-hub...");
  const tx2 = await registry.verify(MCP_COLOMBIA_ADDRESS);
  await tx2.wait();
  console.log(`   ✅ mcp-colombia-hub verificado`);

  // Confirmar
  const isVerified = await registry.isVerified(MCP_COLOMBIA_ADDRESS);
  const total      = await registry.totalMCPs();
  console.log(`   ✅ isVerified(mcp-colombia): ${isVerified}`);
  console.log(`   ✅ totalMCPs: ${total}`);

  // ── 4. Actualizar deployments/base-sepolia.json ───────────────────────────
  const deployFile = join(__dirname, `../deployments/${network.name}.json`);
  let existing: any = {};
  try {
    existing = JSON.parse(readFileSync(deployFile, "utf8"));
  } catch { /* archivo nuevo */ }

  existing.contracts             = existing.contracts || {};
  existing.contracts.MCPRegistry = regAddr;
  existing.mcpRegistryAdmin      = deployer.address;
  existing.mcpRegistryVersion    = "1.0.0";

  writeFileSync(deployFile, JSON.stringify(existing, null, 2));
  console.log(`\n📁 Deployment guardado en ${deployFile}`);

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║         MCPRegistry DEPLOY COMPLETO ✅           ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  MCPRegistry:  ${regAddr}  ║`);
  console.log(`║  SuperAdmin:   ${deployer.address}  ║`);
  console.log(`║  mcp-colombia: VERIFICADO ✅                     ║`);
  console.log("╚══════════════════════════════════════════════════╝\n");
}

main().catch(e => { console.error(e); process.exit(1); });
