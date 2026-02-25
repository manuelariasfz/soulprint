/**
 * mcp-registry.ts — Cliente para MCPRegistry.sol en Base Sepolia
 *
 * Expone:
 *  - isVerifiedOnChain(address)    → bool
 *  - getMCPEntry(address)          → MCPEntry
 *  - getVerifiedMCPs()             → lista pública
 *  - verifyMCP / revokeMCP         → solo desde la wallet admin (con ADMIN_PRIVATE_KEY)
 *  - registerMCP                   → cualquiera puede registrar
 */
import { ethers } from "ethers";

// ── Config ──────────────────────────────────────────────────────────────────
const RPC_URL            = process.env.BASE_RPC_URL || "https://sepolia.base.org";
const MCP_REGISTRY_ADDR  = process.env.MCP_REGISTRY_ADDR || "0x59EA3c8f60ecbAe22B4c323A8dDc2b0BCd9D3C2a";
const ADMIN_PRIVATE_KEY  = process.env.ADMIN_PRIVATE_KEY || "";   // solo admin lo tiene

const ABI = [
  // Lectura pública
  "function isVerified(address mcpAddress) view returns (bool)",
  "function totalMCPs() view returns (uint256)",
  "function superAdmin() view returns (address)",
  "function getAllMCPs() view returns (address[])",
  "function mcps(address) view returns (address owner, string name, string url, string did, string category, string description, uint64 registeredAt, uint64 verifiedAt, uint64 revokedAt, bool exists)",

  // Escritura (cualquiera puede registrar)
  "function registerMCP(address mcpAddress, string name, string url, string did, string category, string description)",

  // Escritura (solo admin)
  "function verify(address mcpAddress)",
  "function revoke(address mcpAddress, string reason)",
  "function updateMCP(address mcpAddress, string newUrl, string newDid, string newDescription)",

  // Eventos
  "event MCPRegistered(address indexed mcpAddress, string name, string url, string category)",
  "event MCPVerified(address indexed mcpAddress, string name, address verifiedBy)",
  "event MCPRevoked(address indexed mcpAddress, string name, string reason)",
];

export interface MCPEntry {
  address:      string;
  owner:        string;
  name:         string;
  url:          string;
  did:          string;
  category:     string;
  description:  string;
  registeredAt: number;
  verifiedAt:   number;
  revokedAt:    number;
  exists:       boolean;
  verified:     boolean;   // computed: verifiedAt > 0 && revokedAt == 0
}

function getProvider() {
  return new ethers.JsonRpcProvider(RPC_URL);
}

function getReadContract() {
  return new ethers.Contract(MCP_REGISTRY_ADDR, ABI, getProvider());
}

function getWriteContract() {
  if (!ADMIN_PRIVATE_KEY) throw new Error("ADMIN_PRIVATE_KEY no configurada");
  const provider = getProvider();
  const wallet   = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
  return new ethers.Contract(MCP_REGISTRY_ADDR, ABI, wallet);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatEntry(addr: string, raw: any): MCPEntry {
  return {
    address:      addr,
    owner:        raw.owner,
    name:         raw.name,
    url:          raw.url,
    did:          raw.did,
    category:     raw.category,
    description:  raw.description,
    registeredAt: Number(raw.registeredAt),
    verifiedAt:   Number(raw.verifiedAt),
    revokedAt:    Number(raw.revokedAt),
    exists:       raw.exists,
    verified:     raw.verifiedAt > 0n && raw.revokedAt === 0n,
  };
}

// ── Consultas públicas ───────────────────────────────────────────────────────

export async function isVerifiedOnChain(mcpAddress: string): Promise<boolean> {
  try {
    const c = getReadContract();
    return await c.isVerified(mcpAddress);
  } catch { return false; }
}

export async function getMCPEntry(mcpAddress: string): Promise<MCPEntry | null> {
  try {
    const c   = getReadContract();
    const raw = await c.mcps(mcpAddress);
    if (!raw.exists) return null;
    return formatEntry(mcpAddress, raw);
  } catch { return null; }
}

export async function getAllMCPEntries(): Promise<MCPEntry[]> {
  try {
    const c       = getReadContract();
    const addrs   = await c.getAllMCPs() as string[];
    const entries = await Promise.all(addrs.map(a => getMCPEntry(a)));
    return entries.filter(Boolean) as MCPEntry[];
  } catch { return []; }
}

export async function getVerifiedMCPEntries(): Promise<MCPEntry[]> {
  const all = await getAllMCPEntries();
  return all.filter(e => e.verified);
}

export async function getSuperAdmin(): Promise<string> {
  try {
    const c = getReadContract();
    return await c.superAdmin();
  } catch { return ""; }
}

// ── Escritura: registro (cualquiera) ─────────────────────────────────────────

export async function registerMCPOnChain(params: {
  ownerPrivateKey: string;
  mcpAddress:      string;
  name:            string;
  url:             string;
  did?:            string;
  category?:       string;
  description?:    string;
}): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const provider = getProvider();
    const wallet   = new ethers.Wallet(params.ownerPrivateKey, provider);
    const contract = new ethers.Contract(MCP_REGISTRY_ADDR, ABI, wallet);

    const tx = await contract.registerMCP(
      params.mcpAddress,
      params.name,
      params.url,
      params.did        ?? "",
      params.category   ?? "general",
      params.description ?? "",
    );
    const receipt = await tx.wait();
    return { success: true, txHash: receipt.hash };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Escritura: admin — verificar ─────────────────────────────────────────────

export async function verifyMCPOnChain(
  mcpAddress: string,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const c  = getWriteContract();
    const tx = await c.verify(mcpAddress);
    const r  = await tx.wait();
    return { success: true, txHash: r.hash };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Escritura: admin — revocar ───────────────────────────────────────────────

export async function revokeMCPOnChain(
  mcpAddress: string,
  reason: string,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const c  = getWriteContract();
    const tx = await c.revoke(mcpAddress, reason);
    const r  = await tx.wait();
    return { success: true, txHash: r.hash };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Info del registry ────────────────────────────────────────────────────────

export async function getRegistryInfo(): Promise<{
  contract:   string;
  network:    string;
  superAdmin: string;
  totalMCPs:  number;
  explorer:   string;
}> {
  try {
    const c     = getReadContract();
    const [admin, total] = await Promise.all([c.superAdmin(), c.totalMCPs()]);
    return {
      contract:   MCP_REGISTRY_ADDR,
      network:    "Base Sepolia (chainId: 84532)",
      superAdmin: admin,
      totalMCPs:  Number(total),
      explorer:   `https://sepolia.basescan.org/address/${MCP_REGISTRY_ADDR}`,
    };
  } catch {
    return { contract: MCP_REGISTRY_ADDR, network: "Base Sepolia", superAdmin: "", totalMCPs: 0, explorer: "" };
  }
}
