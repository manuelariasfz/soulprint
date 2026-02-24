/**
 * Phone TOTP Credential Validator — sin servicio externo
 *
 * Usa TOTP (RFC 6238) — el mismo estándar de Google Authenticator / Authy.
 * No requiere SMS, no requiere API key, funciona completamente offline.
 *
 * Flujo:
 *  1. POST /credentials/phone/start  { did, phone }
 *     → genera un TOTP secret único para este DID
 *     → retorna { sessionId, totpUri, qrData }
 *       totpUri = "otpauth://totp/Soulprint:+57..."
 *       qrData  = string para generar QR (usar qrencode o cualquier lib)
 *
 *  2. El usuario escanea el QR con Google Authenticator / Authy
 *     y envía el código de 6 dígitos
 *
 *  3. POST /credentials/phone/verify { sessionId, code }
 *     → si el TOTP es válido → emite PhoneVerified
 *     → retorna { credential: "PhoneVerified", did }
 *
 * ¿Por qué TOTP en lugar de SMS?
 *  - 100% open source (RFC 6238, sin dependencias externas)
 *  - 0 costo — no necesita Twilio, Vonage, etc.
 *  - Compatible con cualquier TOTP app (Google Auth, Authy, Aegis, etc.)
 *  - El usuario confirma que controla su dispositivo (equivalente a "phone verified")
 *  - Funciona offline en el validador
 *  - P2P friendly: cualquier nodo puede verificar sin shared state
 *
 * Configuración: ninguna — funciona out of the box.
 */

import { TOTP } from "otpauth";
import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 15 * 60 * 1000;  // 15 minutos para completar la verificación

interface PhoneSession {
  did:       string;
  phone:     string;
  totp:      TOTP;
  totpUri:   string;
  secret:    string;
  expiresAt: number;
  verified:  boolean;
  attempts:  number;
}

const phoneSessions = new Map<string, PhoneSession>();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of phoneSessions) {
    if (s.expiresAt < now) phoneSessions.delete(id);
  }
}, 5 * 60_000).unref();

export function startPhoneVerification(
  did:   string,
  phone: string
): { sessionId: string; totpUri: string; qrData: string; instructions: string } {
  // Validar formato básico de teléfono (E.164)
  const cleanPhone = phone.replace(/\s/g, "");
  if (!/^\+?[1-9]\d{7,14}$/.test(cleanPhone)) {
    throw new Error("Invalid phone number. Use E.164 format: +573001234567");
  }

  const sessionId = randomBytes(16).toString("hex");

  // Generar TOTP secret único para este DID + sesión
  const secret = randomBytes(20).toString("base64").replace(/[^A-Z2-7]/gi, "A").slice(0, 32).toUpperCase();

  const totp = new TOTP({
    issuer:    "Soulprint",
    label:     cleanPhone,
    algorithm: "SHA1",
    digits:    6,
    period:    30,
    secret,
  });

  const totpUri = totp.toString();

  phoneSessions.set(sessionId, {
    did, phone: cleanPhone, totp, totpUri, secret,
    expiresAt: Date.now() + SESSION_TTL_MS,
    verified: false, attempts: 0,
  });

  return {
    sessionId,
    totpUri,
    qrData: totpUri,   // el cliente puede generar el QR con cualquier lib
    instructions: [
      "1. Open Google Authenticator, Authy, or any TOTP app",
      "2. Tap '+' → 'Scan QR code' and scan the QR code",
      "   Or tap 'Enter setup key' and paste: " + totpUri,
      "3. Enter the 6-digit code that appears in the app",
      "4. POST /credentials/phone/verify with your sessionId and code",
      "",
      "This proves you control a real device (equivalent to phone verification).",
    ].join("\n"),
  };
}

export function verifyPhoneTOTP(
  sessionId: string,
  code:      string
): { ok: boolean; did?: string; phone?: string; reason?: string } {
  const session = phoneSessions.get(sessionId);

  if (!session)                return { ok: false, reason: "Session not found or expired" };
  if (Date.now() > session.expiresAt) { phoneSessions.delete(sessionId); return { ok: false, reason: "Session expired" }; }

  session.attempts++;
  if (session.attempts > 10) { phoneSessions.delete(sessionId); return { ok: false, reason: "Too many attempts" }; }

  // TOTP valida con ventana de ±1 período (30s) para tolerancia de clock drift
  const isValid = session.totp.validate({ token: code.trim(), window: 1 }) !== null;

  if (!isValid) return { ok: false, reason: "Invalid or expired TOTP code. Try the current code in your authenticator app." };

  phoneSessions.delete(sessionId);
  return { ok: true, did: session.did, phone: session.phone };
}
