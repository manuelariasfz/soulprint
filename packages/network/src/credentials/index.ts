/**
 * Credential Router — integra todos los validators de credenciales
 * con el servidor HTTP del nodo validador.
 *
 * Endpoints añadidos:
 *
 * Email:
 *   POST /credentials/email/start    { did, email }
 *   POST /credentials/email/verify   { sessionId, otp }
 *
 * Phone (TOTP — sin SMS, sin API key):
 *   POST /credentials/phone/start    { did, phone }
 *   POST /credentials/phone/verify   { sessionId, code }
 *
 * GitHub OAuth:
 *   GET  /credentials/github/start   ?did=<did>
 *   GET  /credentials/github/callback?code=<code>&state=<state>
 *
 * Biometric (ya existe via /verify — solo se documenta aquí):
 *   POST /verify    { spt, zkp }  → emite BiometricBound credential implícita
 *
 * Una vez verificado, el validator emite una BotAttestation con:
 *   context: "credential:EmailVerified" | "credential:PhoneVerified" |
 *            "credential:GitHubLinked"
 * Esta attestation se gossipea al resto de la red P2P automáticamente.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import {
  startEmailVerification, verifyEmailOTP,
} from "./email.js";
import {
  startPhoneVerification, verifyPhoneTOTP,
} from "./phone.js";
import {
  startGitHubOAuth, handleGitHubCallback,
} from "./github.js";
import type { BotAttestation, SoulprintKeypair } from "soulprint-core";

// Importado desde el módulo padre para emitir la attestation de credencial
type AttestFn = (
  att: Omit<BotAttestation, "sig">,
  keypair: SoulprintKeypair
) => BotAttestation;

export type CredentialContext = {
  nodeKeypair: SoulprintKeypair;
  signAttestation: (att: Omit<BotAttestation, "sig">) => BotAttestation;
  gossip: (att: BotAttestation) => void;
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function jsonResp(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 32_768) { req.destroy(); reject(new Error("Body too large")); } });
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); } });
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function handleCredentialRoute(
  req:     IncomingMessage,
  res:     ServerResponse,
  url:     string,
  ctx:     CredentialContext
): Promise<boolean> {
  const method = req.method ?? "GET";
  const qs     = new URL(url, "http://localhost").searchParams;

  // ── Email ──────────────────────────────────────────────────────────────────
  if (url.startsWith("/credentials/email/start") && method === "POST") {
    let body: any;
    try { body = await readBody(req); } catch (e: any) { return jsonResp(res, 400, { error: e.message }), true; }
    try {
      const result = await startEmailVerification(body.did, body.email);
      jsonResp(res, 200, { ok: true, ...result, message: "OTP sent to your email. Check your inbox." });
    } catch (e: any) { jsonResp(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  if (url.startsWith("/credentials/email/verify") && method === "POST") {
    let body: any;
    try { body = await readBody(req); } catch (e: any) { return jsonResp(res, 400, { error: e.message }), true; }
    const result = verifyEmailOTP(body.sessionId, body.otp);
    if (!result.ok) return jsonResp(res, 403, { ok: false, reason: result.reason }), true;

    const att = ctx.signAttestation({
      issuer_did: ctx.nodeKeypair.did,
      target_did: result.did!,
      value:      1,
      context:    "credential:EmailVerified",
      timestamp:  Math.floor(Date.now() / 1000),
    });
    ctx.gossip(att);
    jsonResp(res, 200, { ok: true, credential: "EmailVerified", did: result.did, email: result.email, attestation: att });
    return true;
  }

  // ── Phone ──────────────────────────────────────────────────────────────────
  if (url.startsWith("/credentials/phone/start") && method === "POST") {
    let body: any;
    try { body = await readBody(req); } catch (e: any) { return jsonResp(res, 400, { error: e.message }), true; }
    try {
      const result = startPhoneVerification(body.did, body.phone);
      jsonResp(res, 200, { ok: true, ...result });
    } catch (e: any) { jsonResp(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  if (url.startsWith("/credentials/phone/verify") && method === "POST") {
    let body: any;
    try { body = await readBody(req); } catch (e: any) { return jsonResp(res, 400, { error: e.message }), true; }
    const result = verifyPhoneTOTP(body.sessionId, body.code);
    if (!result.ok) return jsonResp(res, 403, { ok: false, reason: result.reason }), true;

    const att = ctx.signAttestation({
      issuer_did: ctx.nodeKeypair.did,
      target_did: result.did!,
      value:      1,
      context:    "credential:PhoneVerified",
      timestamp:  Math.floor(Date.now() / 1000),
    });
    ctx.gossip(att);
    jsonResp(res, 200, { ok: true, credential: "PhoneVerified", did: result.did, phone: result.phone, attestation: att });
    return true;
  }

  // ── GitHub OAuth ───────────────────────────────────────────────────────────
  if (url.startsWith("/credentials/github/start") && method === "GET") {
    const did = qs.get("did");
    if (!did) return jsonResp(res, 400, { error: "Missing query param: did" }), true;
    const result = startGitHubOAuth(did);
    if (result.error) return jsonResp(res, 503, { ok: false, ...result }), true;
    // Redirect al usuario a GitHub
    res.writeHead(302, { Location: result.authUrl! });
    res.end();
    return true;
  }

  if (url.startsWith("/credentials/github/callback") && method === "GET") {
    const code  = qs.get("code");
    const state = qs.get("state");
    if (!code || !state) return jsonResp(res, 400, { error: "Missing code or state" }), true;

    const result = await handleGitHubCallback(code, state);
    if (!result.ok) return jsonResp(res, 403, { ok: false, reason: result.reason }), true;

    const att = ctx.signAttestation({
      issuer_did: ctx.nodeKeypair.did,
      target_did: result.did!,
      value:      1,
      context:    "credential:GitHubLinked",
      timestamp:  Math.floor(Date.now() / 1000),
    });
    ctx.gossip(att);
    jsonResp(res, 200, {
      ok:         true,
      credential: "GitHubLinked",
      did:        result.did,
      github:     { id: result.githubId, login: result.githubLogin },
      attestation: att,
    });
    return true;
  }

  return false; // no es una ruta de credenciales
}
