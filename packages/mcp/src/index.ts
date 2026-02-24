import { decodeToken, SoulprintToken, TrustLevel, CredentialType } from "soulprint-core";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoulprintOptions {
  /** Trust score minimum (0-100). Default: 40 */
  minScore?: number;

  /** Required trust level. If set, overrides minScore for level check. */
  minLevel?: TrustLevel;

  /** Required credentials. All must be present. */
  require?: CredentialType | CredentialType[];

  /** Custom rejection message */
  rejectMessage?: string;

  /** Called when a valid token is found (for logging, analytics, etc.) */
  onVerified?: (token: SoulprintToken) => void;

  /** Called when a request is rejected */
  onRejected?: (reason: string) => void;
}

const LEVEL_SCORES: Record<TrustLevel, number> = {
  Unverified:     0,
  EmailVerified:  10,
  PhoneVerified:  25,
  KYCLite:        45,
  KYCFull:        80,
};

// ── Core verification logic ───────────────────────────────────────────────────

export function verifySPT(
  spt:   string | undefined | null,
  opts:  SoulprintOptions = {}
): { allowed: boolean; token?: SoulprintToken; reason?: string } {

  if (!spt) {
    const r = { allowed: false, reason: "No Soulprint token provided" };
    opts.onRejected?.(r.reason);
    return r;
  }

  const token = decodeToken(spt);
  if (!token) {
    const r = { allowed: false, reason: "Invalid or expired Soulprint token" };
    opts.onRejected?.(r.reason);
    return r;
  }

  const minScore = opts.minScore ?? 40;
  if (token.score < minScore) {
    const r = { allowed: false, reason: `Trust score too low: ${token.score} < ${minScore}` };
    opts.onRejected?.(r.reason);
    return r;
  }

  if (opts.minLevel) {
    const required = LEVEL_SCORES[opts.minLevel] ?? 0;
    const actual   = LEVEL_SCORES[token.level]   ?? 0;
    if (actual < required) {
      const r = { allowed: false, reason: `Trust level too low: ${token.level} < ${opts.minLevel}` };
      opts.onRejected?.(r.reason);
      return r;
    }
  }

  if (opts.require) {
    const required = Array.isArray(opts.require) ? opts.require : [opts.require];
    const missing  = required.filter(c => !token.credentials.includes(c));
    if (missing.length > 0) {
      const r = { allowed: false, reason: `Missing credentials: ${missing.join(", ")}` };
      opts.onRejected?.(r.reason);
      return r;
    }
  }

  opts.onVerified?.(token);
  return { allowed: true, token };
}

// ── MCP Middleware ────────────────────────────────────────────────────────────

/**
 * soulprint() — MCP middleware for identity verification.
 *
 * USAGE (MCP Server SDK):
 *
 * ```typescript
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { soulprint } from "soulprint-mcp";
 *
 * const server = new McpServer({ name: "my-server", version: "1.0" });
 * server.use(soulprint({ minScore: 60 }));
 * ```
 *
 * The token is read from the MCP client's capabilities:
 * ```json
 * { "capabilities": { "identity": { "soulprint": "<SPT>" } } }
 * ```
 *
 * Or from the HTTP header: X-Soulprint: <SPT>
 */
export function soulprint(opts: SoulprintOptions = {}) {
  return {
    // MCP SDK hook — called before each tool invocation
    async onCallTool(context: MCPContext, next: () => Promise<any>) {
      const spt = extractSPT(context);
      const result = verifySPT(spt, opts);

      if (!result.allowed) {
        opts.onRejected?.(result.reason!);
        throw new MCPError(
          opts.rejectMessage ?? `Soulprint identity required: ${result.reason}`,
          "FORBIDDEN",
          { minScore: opts.minScore ?? 40, require: opts.require }
        );
      }

      opts.onVerified?.(result.token!);

      // Attach token to context for downstream use
      (context as any)._soulprint = result.token;
      return next();
    },
  };
}

function extractSPT(context: MCPContext): string | undefined {
  // 1. From MCP capabilities
  const cap = (context as any)?.clientCapabilities?.identity?.soulprint;
  if (cap) return cap;

  // 2. From meta/headers
  const headers = (context as any)?.meta?.headers;
  if (headers?.["x-soulprint"]) return headers["x-soulprint"];
  if (headers?.["X-Soulprint"]) return headers["X-Soulprint"];

  return undefined;
}

// ── Standalone verifier ───────────────────────────────────────────────────────

/**
 * verifyRequest() — verify a Soulprint token from any MCP request object.
 * Use this if you prefer manual verification over middleware.
 *
 * ```typescript
 * const identity = verifyRequest(request, { minScore: 60 });
 * if (!identity) return { error: "Unverified bot" };
 * console.log(identity.score, identity.nullifier);
 * ```
 */
export function verifyRequest(
  request: { meta?: any; clientCapabilities?: any },
  opts:    SoulprintOptions = {}
): SoulprintToken | null {
  const spt = extractSPT(request as MCPContext);
  const result = verifySPT(spt, opts);
  return result.allowed ? result.token! : null;
}

// ── Helper: get token from current MCP context ────────────────────────────────

/**
 * getSoulprint() — get the verified token from context (after middleware ran).
 *
 * ```typescript
 * server.tool("my-tool", async (args, context) => {
 *   const identity = getSoulprint(context);
 *   console.log(identity.nullifier); // unique per human
 * });
 * ```
 */
export function getSoulprint(context: any): SoulprintToken | undefined {
  return context?._soulprint;
}

// ── Minimal type stubs (real types come from @modelcontextprotocol/sdk) ───────

interface MCPContext {
  clientCapabilities?: { identity?: { soulprint?: string } };
  meta?: { headers?: Record<string, string> };
}

class MCPError extends Error {
  code:    string;
  details: any;
  constructor(message: string, code: string, details?: any) {
    super(message);
    this.name    = "MCPError";
    this.code    = code;
    this.details = details;
  }
}

// ── Re-exports ────────────────────────────────────────────────────────────────
export { decodeToken, SoulprintToken, TrustLevel, CredentialType } from "soulprint-core";
