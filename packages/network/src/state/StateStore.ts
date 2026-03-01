/**
 * StateStore — persistent state for P2P sync
 * Saves/loads full node state to disk with debounced writes.
 */
import { createHash }  from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir }       from "node:os";

export interface StoredAttestation {
  issuer_did: string;
  target_did: string;
  value:      number;
  context:    string;
  timestamp:  number;
  sig:        string;
}

export interface NodeState {
  nullifiers:   string[];                      // verified nullifier hashes
  reputation:   Record<string, number>;        // did → score
  attestations: StoredAttestation[];           // full attestation objects
  peers:        string[];                      // known HTTP peer URLs
  lastSync:     number;                        // timestamp (ms)
  stateHash:    string;                        // sha256 of sorted nullifiers
}

const STATE_PATH = process.env.SOULPRINT_STATE_PATH
  ?? join(homedir(), ".soulprint", "node", "state.json");

const DEFAULT_STATE: NodeState = {
  nullifiers:   [],
  reputation:   {},
  attestations: [],
  peers:        [],
  lastSync:     0,
  stateHash:    "",
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** sha256(JSON.stringify(nullifiers.sort())) */
export function computeHash(nullifiers: string[]): string {
  const sorted = [...nullifiers].sort();
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/** Load state from disk. Returns default if file missing or corrupt. */
export function loadState(): NodeState {
  if (!existsSync(STATE_PATH)) {
    return { ...DEFAULT_STATE, stateHash: computeHash([]) };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<NodeState>;
    const nullifiers = raw.nullifiers ?? [];
    return {
      nullifiers,
      reputation:   raw.reputation   ?? {},
      attestations: raw.attestations ?? [],
      peers:        raw.peers        ?? [],
      lastSync:     raw.lastSync     ?? 0,
      stateHash:    raw.stateHash    ?? computeHash(nullifiers),
    };
  } catch {
    return { ...DEFAULT_STATE, stateHash: computeHash([]) };
  }
}

/** Write state to disk — debounced 2 s by default. */
export function saveState(state: NodeState, debounceMs = 2000): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const dir = dirname(STATE_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("[state] Failed to save state:", e);
    }
  }, debounceMs);
}
