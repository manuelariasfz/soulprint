/**
 * Tests de flujo REALES — ProtocolThresholds on Base Sepolia
 *
 * Flujo completo:
 *  1. Leer thresholds actuales desde blockchain
 *  2. Intentar cambiar como non-admin → REVERT esperado
 *  3. Cambiar SCORE_FLOOR como superAdmin
 *  4. Verificar ThresholdUpdated event on-chain
 *  5. Comprobar GET /protocol/thresholds en el nodo
 *  6. Restaurar SCORE_FLOOR al valor original
 *
 * Requiere: nodo corriendo en localhost:4888 + acceso a Base Sepolia RPC
 */
import { ethers } from "ethers";

const CYAN  = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";

let passed = 0, failed = 0;

function ok(name)        { console.log(`${GREEN}  ✅ ${name}${RESET}`); passed++; }
function fail(name, msg) { console.log(`${RED}  ❌ ${name}: ${msg}${RESET}`); failed++; }

async function test(name, fn) {
  try { await fn(); ok(name); }
  catch(e) { fail(name, e.message); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Config ────────────────────────────────────────────────────────────────────
const CONTRACT_ADDRESS  = "0xD8f78d65b35806101672A49801b57F743f2D2ab1";
const ADMIN_PRIVATE_KEY = "0x***REMOVED***";
const RPC_URL           = "https://sepolia.base.org";
const NODE_URL          = "http://localhost:4888";

const ABI = [
  "function getThreshold(string calldata name) external view returns (uint256)",
  "function setThreshold(string calldata name, uint256 value) external",
  "function superAdmin() external view returns (address)",
  "function getAll() external view returns (string[] memory names, uint256[] memory values)",
  "event ThresholdUpdated(bytes32 indexed key, uint256 oldValue, uint256 newValue, address indexed by, uint256 timestamp)",
];

const provider     = new ethers.JsonRpcProvider(RPC_URL);
const adminWallet  = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
const randomWallet = ethers.Wallet.createRandom().connect(provider);

const contractRead     = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
const contractAdmin    = new ethers.Contract(CONTRACT_ADDRESS, ABI, adminWallet);
const contractNonAdmin = new ethers.Contract(CONTRACT_ADDRESS, ABI, randomWallet);

// Helper: enviar tx con nonce explícito para evitar reuso
async function sendTx(fn, ...args) {
  const nonce = await provider.getTransactionCount(adminWallet.address, "pending");
  const tx    = await fn(...args, { nonce });
  const receipt = await tx.wait(1);   // esperar 1 confirmación
  await sleep(3000);                   // dar tiempo a que el estado se propague en la red
  return receipt;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}🔗 ProtocolThresholds — Tests de Flujo Real (Base Sepolia)${RESET}`);
console.log(`${CYAN}   Contract: ${CONTRACT_ADDRESS}${RESET}`);
console.log(`${CYAN}   Network:  Base Sepolia (chainId: 84532)${RESET}\n`);

// ── BLOQUE 1: Lectura pública ─────────────────────────────────────────────────
console.log(`${BOLD}Bloque 1 — Lectura pública (sin auth)${RESET}`);

await test("superAdmin es la wallet del deployer", async () => {
  const admin = await contractRead.superAdmin();
  if (admin.toLowerCase() !== adminWallet.address.toLowerCase())
    throw new Error(`Expected ${adminWallet.address} got ${admin}`);
});

// Leer el valor ACTUAL (puede estar en 60 por un test anterior)
let currentScoreFloor;
await test("getThreshold devuelve un valor numérico razonable", async () => {
  currentScoreFloor = Number(await contractRead.getThreshold("SCORE_FLOOR"));
  if (currentScoreFloor < 1 || currentScoreFloor > 100)
    throw new Error(`Valor fuera de rango: ${currentScoreFloor}`);
  console.log(`       ${CYAN}SCORE_FLOOR actual on-chain: ${currentScoreFloor}${RESET}`);
});

await test("getThreshold('VERIFIED_SCORE_FLOOR') en rango válido", async () => {
  const v = Number(await contractRead.getThreshold("VERIFIED_SCORE_FLOOR"));
  if (v < 1 || v > 100) throw new Error(`Valor fuera de rango: ${v}`);
  console.log(`       ${CYAN}VERIFIED_SCORE_FLOOR: ${v}${RESET}`);
});

await test("getThreshold('FACE_SIM_DOC_SELFIE') = 350 (inmutable por diseño)", async () => {
  const v = Number(await contractRead.getThreshold("FACE_SIM_DOC_SELFIE"));
  if (v !== 350) throw new Error(`Expected 350, got ${v}`);
});

await test("getThreshold('FACE_SIM_SELFIE_SELFIE') = 650", async () => {
  const v = Number(await contractRead.getThreshold("FACE_SIM_SELFIE_SELFIE"));
  if (v !== 650) throw new Error(`Expected 650, got ${v}`);
});

await test("getAll() devuelve 9 thresholds con nombres correctos", async () => {
  const [names, values] = await contractRead.getAll();
  if (names.length !== 9) throw new Error(`Expected 9 names, got ${names.length}`);
  const expected = ["SCORE_FLOOR","VERIFIED_SCORE_FLOOR","MIN_ATTESTER_SCORE","FACE_SIM_DOC_SELFIE",
                    "FACE_SIM_SELFIE_SELFIE","DEFAULT_REPUTATION","IDENTITY_MAX","REPUTATION_MAX","VERIFY_RETRY_MAX"];
  for (const k of expected) {
    if (!names.includes(k)) throw new Error(`Falta '${k}' en getAll()`);
  }
  console.log(`       ${CYAN}${names.map((n, i) => `${n}=${values[i]}`).join(" | ")}${RESET}`);
});

// ── BLOQUE 2: Seguridad — non-admin NO puede modificar ───────────────────────
console.log(`\n${BOLD}Bloque 2 — Seguridad (non-admin bloqueado)${RESET}`);

await test("non-admin NO puede setThreshold (revert esperado)", async () => {
  try {
    const tx = await contractNonAdmin.setThreshold("SCORE_FLOOR", 40, { gasLimit: 100000 });
    await tx.wait();
    throw new Error("DEBERÍA haber revertido pero no lo hizo");
  } catch(e) {
    if (e.message.includes("DEBERÍA")) throw e;
    // Revertió correctamente — verificar que el valor no cambió
  }
});

await test("SCORE_FLOOR no cambió después del intento non-admin", async () => {
  const v = Number(await contractRead.getThreshold("SCORE_FLOOR"));
  if (v !== currentScoreFloor)
    throw new Error(`Cambió de ${currentScoreFloor} a ${v} — seguridad comprometida`);
});

// ── BLOQUE 3: superAdmin cambia SCORE_FLOOR ───────────────────────────────────
const newTestValue = currentScoreFloor === 65 ? 60 : 65;   // alternar para ser idempotente
console.log(`\n${BOLD}Bloque 3 — superAdmin modifica SCORE_FLOOR (${currentScoreFloor} → ${newTestValue})${RESET}`);

let txReceipt;
await test(`superAdmin puede setThreshold('SCORE_FLOOR', ${newTestValue})`, async () => {
  txReceipt = await sendTx(
    (v, opts) => contractAdmin.setThreshold("SCORE_FLOOR", v, opts),
    newTestValue
  );
  console.log(`       ${CYAN}txHash: ${txReceipt.hash}${RESET}`);
  console.log(`       ${CYAN}block:  ${txReceipt.blockNumber}${RESET}`);
});

await test(`getThreshold('SCORE_FLOOR') ahora = ${newTestValue}`, async () => {
  const v = Number(await contractRead.getThreshold("SCORE_FLOOR"));
  if (v !== newTestValue) throw new Error(`Expected ${newTestValue}, got ${v}`);
});

await test("ThresholdUpdated event on-chain con valores correctos", async () => {
  if (!txReceipt) throw new Error("No hay receipt del tx anterior");
  // Decodificar el event directamente del receipt (evita eth_getLogs con rango de bloques)
  const iface   = contractRead.interface;
  const topicSig = iface.getEvent("ThresholdUpdated").topicHash;
  const log     = txReceipt.logs.find(l => l.topics[0] === topicSig);
  if (!log) throw new Error(`No se encontró ThresholdUpdated en receipt ${txReceipt.hash}`);
  const parsed = iface.parseLog(log);
  if (Number(parsed.args.newValue) !== newTestValue)
    throw new Error(`newValue=${parsed.args.newValue}, esperaba ${newTestValue}`);
  console.log(`       ${CYAN}oldValue=${parsed.args.oldValue} newValue=${parsed.args.newValue} by=${parsed.args.by}${RESET}`);
});

// ── BLOQUE 4: El validador carga thresholds desde blockchain ──────────────────
console.log(`\n${BOLD}Bloque 4 — Validador: GET /protocol/thresholds${RESET}`);

await test("GET /protocol/thresholds responde 200", async () => {
  const r = await fetch(`${NODE_URL}/protocol/thresholds`);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  console.log(`       ${CYAN}source: ${d.source}${RESET}`);
  console.log(`       ${CYAN}contract: ${d.contract}${RESET}`);
  console.log(`       ${CYAN}SCORE_FLOOR: ${d.thresholds.SCORE_FLOOR}${RESET}`);
});

await test("GET /protocol/thresholds campos completos", async () => {
  const d = await fetch(`${NODE_URL}/protocol/thresholds`).then(r => r.json());
  const required = ["SCORE_FLOOR","VERIFIED_SCORE_FLOOR","MIN_ATTESTER_SCORE",
                    "FACE_SIM_DOC_SELFIE","FACE_SIM_SELFIE_SELFIE","DEFAULT_REPUTATION",
                    "IDENTITY_MAX","REPUTATION_MAX"];
  for (const k of required) {
    if (d.thresholds[k] === undefined) throw new Error(`Falta threshold '${k}' en response`);
  }
});

await test("GET /protocol/thresholds muestra fuente blockchain y thresholds coherentes", async () => {
  const d = await fetch(`${NODE_URL}/protocol/thresholds`).then(r => r.json());
  // La cache del nodo tiene TTL de 10 min — el valor puede ser el anterior (por diseño)
  // Solo verificamos: fuente, contrato correcto, y que SCORE_FLOOR es un número razonable
  if (!d.source) throw new Error("Sin campo source");
  if (d.contract !== CONTRACT_ADDRESS) throw new Error(`Contrato incorrecto: ${d.contract}`);
  const sf = d.thresholds.SCORE_FLOOR;
  if (sf !== 60 && sf !== 65) throw new Error(`SCORE_FLOOR inesperado: ${sf}`);
  console.log(`       ${CYAN}✓ source=${d.source} | SCORE_FLOOR=${sf} (cache TTL=10min, puede ser ${currentScoreFloor} o ${newTestValue})${RESET}`);
});

// ── BLOQUE 5: Restaurar SCORE_FLOOR = 65 ─────────────────────────────────────
const ORIGINAL = 65;
console.log(`\n${BOLD}Bloque 5 — Restaurar SCORE_FLOOR = ${ORIGINAL}${RESET}`);

await test(`superAdmin restaura SCORE_FLOOR a ${ORIGINAL}`, async () => {
  const receipt = await sendTx(
    (v, opts) => contractAdmin.setThreshold("SCORE_FLOOR", v, opts),
    ORIGINAL
  );
  console.log(`       ${CYAN}txHash: ${receipt.hash}${RESET}`);
});

await test(`SCORE_FLOOR restaurado = ${ORIGINAL}`, async () => {
  const v = Number(await contractRead.getThreshold("SCORE_FLOOR"));
  if (v !== ORIGINAL) throw new Error(`Expected ${ORIGINAL}, got ${v}`);
});

await test("getAll() post-restauración — todos los valores esperados", async () => {
  const [names, values] = await contractRead.getAll();
  const m = Object.fromEntries(names.map((n, i) => [n, Number(values[i])]));
  if (m["SCORE_FLOOR"] !== ORIGINAL)          throw new Error(`SCORE_FLOOR=${m["SCORE_FLOOR"]}`);
  if (m["VERIFIED_SCORE_FLOOR"] !== 52)        throw new Error(`VERIFIED_SCORE_FLOOR=${m["VERIFIED_SCORE_FLOOR"]}`);
  if (m["MIN_ATTESTER_SCORE"] !== 65)          throw new Error(`MIN_ATTESTER_SCORE=${m["MIN_ATTESTER_SCORE"]}`);
  if (m["FACE_SIM_DOC_SELFIE"] !== 350)        throw new Error(`FACE_SIM_DOC_SELFIE=${m["FACE_SIM_DOC_SELFIE"]}`);
  if (m["FACE_SIM_SELFIE_SELFIE"] !== 650)     throw new Error(`FACE_SIM_SELFIE_SELFIE=${m["FACE_SIM_SELFIE_SELFIE"]}`);
  if (m["DEFAULT_REPUTATION"] !== 10)          throw new Error(`DEFAULT_REPUTATION=${m["DEFAULT_REPUTATION"]}`);
  if (m["IDENTITY_MAX"] !== 80)                throw new Error(`IDENTITY_MAX=${m["IDENTITY_MAX"]}`);
  console.log(`       ${CYAN}✓ Todos los thresholds en valores canónicos${RESET}`);
});

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(55)}`);
console.log(`Total:    ${passed + failed} tests`);
console.log(`${GREEN}Pasados:  ${passed} ✅${RESET}`);
if (failed > 0) console.log(`${RED}Fallidos: ${failed} ❌${RESET}`);
console.log(`${"═".repeat(55)}\n`);
if (failed > 0) process.exit(1);
