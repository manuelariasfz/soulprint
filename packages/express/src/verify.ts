import { decodeToken, SoulprintToken, TrustLevel, CredentialType } from "@soulprint/core";

export interface SoulprintOptions {
  minScore?:     number;
  minLevel?:     TrustLevel;
  require?:      CredentialType | CredentialType[];
  rejectMessage?: string;
  onVerified?:   (token: SoulprintToken) => void;
  onRejected?:   (reason: string) => void;
}

const LEVEL_SCORES: Record<TrustLevel, number> = {
  Unverified: 0, EmailVerified: 10, PhoneVerified: 25, KYCLite: 45, KYCFull: 80,
};

export function verifySPT(
  spt: string | undefined | null,
  opts: SoulprintOptions = {}
): { allowed: boolean; token?: SoulprintToken; reason?: string } {
  if (!spt) {
    const result = { allowed: false, reason: "No Soulprint token provided" };
    opts.onRejected?.(result.reason);
    return result;
  }

  const token = decodeToken(spt);
  if (!token) {
    const result = { allowed: false, reason: "Invalid or expired Soulprint token" };
    opts.onRejected?.(result.reason);
    return result;
  }

  const minScore = opts.minScore ?? 40;
  if (token.score < minScore) {
    const result = { allowed: false, reason: `Trust score too low: ${token.score} < ${minScore}` };
    opts.onRejected?.(result.reason);
    return result;
  }

  if (opts.minLevel) {
    const req = LEVEL_SCORES[opts.minLevel] ?? 0;
    const got = LEVEL_SCORES[token.level]   ?? 0;
    if (got < req) {
      const result = { allowed: false, reason: `Trust level too low: ${token.level} < ${opts.minLevel}` };
      opts.onRejected?.(result.reason);
      return result;
    }
  }

  if (opts.require) {
    const required = Array.isArray(opts.require) ? opts.require : [opts.require];
    const missing  = required.filter(c => !token.credentials.includes(c));
    if (missing.length > 0) {
      const result = { allowed: false, reason: `Missing credentials: ${missing.join(", ")}` };
      opts.onRejected?.(result.reason);
      return result;
    }
  }

  opts.onVerified?.(token);
  return { allowed: true, token };
}
