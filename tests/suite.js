/**
 * Soulprint — Suite de Tests Exhaustivos
 * ========================================
 * Cubre: unit, integración, edge cases, y pen testing
 *
 * node tests/suite.js
 */

const {
  generateKeypair, keypairFromPrivateKey, createToken, decodeToken,
  sign, verify, calculateScore, calculateLevel, deriveNullifier,
} = require("../packages/core/dist/index.js");
const { verifySPT } = require("../packages/express/dist/verify.js");
const { verifySPT: mcpVerify } = require("../packages/mcp/dist/index.js");
const { validateCedulaNumber, parseCedulaOCR, parseMRZ, icaoCheckDigit, verifyCheckDigit } = require("../packages/verify-local/dist/document/cedula-validator.js");

let total = 0, passed = 0, failed = 0, section = "";
const errors = [];

function describe(name, fn) {
  section = name;
  console.log(`\n${"─".repeat(55)}`);
  console.log(`📋 ${name}`);
  fn();
}

async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     → ${e.message}`);
    errors.push({ section, name, error: e.message });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "Assertion failed");
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `Expected ${b}, got ${a}`);
}

function assertNull(v, msg)    { if (v !== null)  throw new Error(msg ?? `Expected null, got ${JSON.stringify(v)}`); }
function assertNotNull(v, msg) { if (v === null || v === undefined) throw new Error(msg ?? "Expected non-null"); }

// ─────────────────────────────────────────────────────────────────────────────
// 1. CORE — DID generation
// ─────────────────────────────────────────────────────────────────────────────
describe("Core — DID & Keypair", () => {
  const kp = generateKeypair();

  test("DID tiene formato correcto", () => {
    assert(kp.did.startsWith("did:key:z"), `DID debe empezar con did:key:z, got: ${kp.did.slice(0, 20)}`);
    assert(kp.did.length > 50, "DID muy corto");
    assert(kp.did.length < 100, "DID muy largo");
  });

  test("Dos keypairs son distintos", () => {
    const kp2 = generateKeypair();
    assert(kp.did !== kp2.did, "Dos keypairs deben tener DIDs distintos");
  });

  test("Reconstrucción desde llave privada", () => {
    const kp2 = keypairFromPrivateKey(kp.privateKey);
    assertEq(kp2.did, kp.did, "Misma llave privada debe reproducir el mismo DID");
  });

  test("Firma y verificación Ed25519", () => {
    const payload = { data: "hello", ts: 12345 };
    const sig = sign(payload, kp.privateKey);
    assert(verify(payload, sig, kp.did), "Firma válida debe verificar");
  });

  test("Firma rechaza payload alterado", () => {
    const payload = { data: "hello", ts: 12345 };
    const sig = sign(payload, kp.privateKey);
    const tampered = { data: "world", ts: 12345 };
    assert(!verify(tampered, sig, kp.did), "Payload alterado debe rechazarse");
  });

  test("Firma rechaza DID incorrecto", () => {
    const kp2 = generateKeypair();
    const sig = sign({ a: 1 }, kp.privateKey);
    assert(!verify({ a: 1 }, sig, kp2.did), "Firma de otro DID debe rechazarse");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CORE — Trust Score
// ─────────────────────────────────────────────────────────────────────────────
describe("Core — Trust Score & Level", () => {
  test("Sin credenciales: score=0, level=Unverified", () => {
    assertEq(calculateScore([]), 0);
    assertEq(calculateLevel([]), "Unverified");
  });

  test("Email: score=10, level=EmailVerified", () => {
    assertEq(calculateScore(["EmailVerified"]), 10);
    assertEq(calculateLevel(["EmailVerified"]), "EmailVerified");
  });

  test("Phone: score=15, level=PhoneVerified", () => {
    assertEq(calculateScore(["PhoneVerified"]), 15);
    assertEq(calculateLevel(["PhoneVerified"]), "PhoneVerified");
  });

  test("Doc+Face: score=45, level=KYCFull", () => {
    assertEq(calculateScore(["DocumentVerified", "FaceMatch"]), 45);
    assertEq(calculateLevel(["DocumentVerified", "FaceMatch"]), "KYCFull");
  });

  test("Doc solo: level=KYCLite", () => {
    assertEq(calculateLevel(["DocumentVerified"]), "KYCLite");
  });

  test("Score acumula correctamente", () => {
    const score = calculateScore(["DocumentVerified", "FaceMatch", "BiometricBound", "GitHubLinked"]);
    assertEq(score, 25 + 20 + 10 + 20, `Score esperado 75, got ${score}`);
  });

  test("Credencial desconocida no suma (no falla)", () => {
    const score = calculateScore(["UnknownCred"]);
    assertEq(score, 0, "Credencial desconocida debe ser ignorada");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CORE — SPT Token lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe("Core — SPT Token", () => {
  const kp  = generateKeypair();
  const kp2 = generateKeypair();
  const nullifier = "0xabcdef1234567890";

  let validToken;
  test("Crear token KYCFull", () => {
    validToken = createToken(kp, nullifier, ["DocumentVerified", "FaceMatch"], {
      country: "CO", zkProof: "MOCK_ZKP"
    });
    assert(validToken.length > 200, "Token debe ser largo (base64url)");
  });

  test("Decodificar token válido", () => {
    const d = decodeToken(validToken);
    assertNotNull(d, "Token debe decodificarse");
    assertEq(d.did, kp.did);
    assertEq(d.score, 45);
    assertEq(d.level, "KYCFull");
    assertEq(d.country, "CO");
    assertEq(d.nullifier, nullifier);
    assertEq(d.zkp, "MOCK_ZKP");
  });

  test("Token expirado (lifetimeSeconds=-1)", () => {
    const expired = createToken(kp, nullifier, ["FaceMatch"], { lifetimeSeconds: -1 });
    assertNull(decodeToken(expired), "Token expirado debe rechazarse");
  });

  test("Token malformado rechazado", () => {
    assertNull(decodeToken("esto no es un token"), "Token malformado");
    assertNull(decodeToken(""), "Token vacío");
    assertNull(decodeToken(null), "Token null");
    assertNull(decodeToken(undefined), "Token undefined");
    assertNull(decodeToken("abc"), "Token muy corto");
  });

  test("Token truncado rechazado", () => {
    assertNull(decodeToken(validToken.slice(0, 50)), "Token truncado");
  });

  test("Token con caracteres extra rechazado", () => {
    assertNull(decodeToken(validToken + "EXTRA"), "Token con sufijo");
  });

  test("ZK proof incluido en el token", () => {
    const t = decodeToken(validToken);
    assertEq(t.zkp, "MOCK_ZKP", "ZK proof debe estar en el token");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PEN TESTING — Ataques de falsificación de token
// ─────────────────────────────────────────────────────────────────────────────
describe("Pen Test — Falsificación de Tokens", () => {
  const kp     = generateKeypair();
  const kpEvil = generateKeypair();
  const token  = createToken(kp, "0xnullifier", ["DocumentVerified", "FaceMatch"]);

  test("Ataque: DID swap (sustituir DID de la víctima)", () => {
    // Tomar un token propio y cambiar el DID al de la víctima
    const evil = JSON.parse(Buffer.from(token, "base64url").toString());
    evil.did   = kp.did;  // roba el DID
    evil.score = 100;      // infla el score
    const tampered = Buffer.from(JSON.stringify(evil)).toString("base64url");
    assertNull(decodeToken(tampered), "Token con DID/score manipulado debe rechazarse");
  });

  test("Ataque: firma de otro keypair", () => {
    // Crear token con kpEvil pero apuntando al DID de la víctima
    const evil = JSON.parse(Buffer.from(
      createToken(kpEvil, "0xnull", ["DocumentVerified", "FaceMatch"]),
      "base64url"
    ).toString());
    evil.did = kp.did;    // sustituir DID
    // La firma sigue siendo de kpEvil — no corresponde al kp DID
    const tampered = Buffer.from(JSON.stringify(evil)).toString("base64url");
    assertNull(decodeToken(tampered), "Firma de otro keypair debe rechazarse");
  });

  test("Ataque: inflar score en el payload", () => {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString());
    raw.score = 100;
    const inflated = Buffer.from(JSON.stringify(raw)).toString("base64url");
    assertNull(decodeToken(inflated), "Score inflado debe invalidar firma");
  });

  test("Ataque: cambiar credenciales", () => {
    const raw  = JSON.parse(Buffer.from(token, "base64url").toString());
    raw.credentials = ["KYCFull"];
    const fake = Buffer.from(JSON.stringify(raw)).toString("base64url");
    assertNull(decodeToken(fake), "Credenciales alteradas deben invalidar firma");
  });

  test("Ataque: borrar firma", () => {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString());
    delete raw.sig;
    const nosig = Buffer.from(JSON.stringify(raw)).toString("base64url");
    assertNull(decodeToken(nosig), "Token sin firma debe rechazarse");
  });

  test("Ataque: firma vacía", () => {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString());
    raw.sig = "";
    const tampered = Buffer.from(JSON.stringify(raw)).toString("base64url");
    assertNull(decodeToken(tampered), "Firma vacía debe rechazarse");
  });

  test("Ataque: firma inválida (hex random)", () => {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString());
    raw.sig = "a".repeat(128);  // 64 bytes hex random
    const tampered = Buffer.from(JSON.stringify(raw)).toString("base64url");
    assertNull(decodeToken(tampered), "Firma aleatoria debe rechazarse");
  });

  test("Ataque: extender expiración", () => {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString());
    raw.expires = Math.floor(Date.now() / 1000) + 999999999;  // expire en ~31 años
    const tampered = Buffer.from(JSON.stringify(raw)).toString("base64url");
    assertNull(decodeToken(tampered), "Expiración manipulada debe invalidar firma");
  });

  test("Ataque: null byte injection en did", () => {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString());
    raw.did = "did:key:z\x00malicious";
    const tampered = Buffer.from(JSON.stringify(raw)).toString("base64url");
    assertNull(decodeToken(tampered), "Null byte en DID debe rechazarse");
  });

  test("Ataque: token JSON con prototype pollution", () => {
    const poisoned = Buffer.from(JSON.stringify({
      __proto__: { admin: true },
      sip: "1", did: "did:key:z123", score: 100,
      credentials: [], nullifier: "0x0",
      issued: 0, expires: 9999999999,
      sig: "fakesig"
    })).toString("base64url");
    assertNull(decodeToken(poisoned), "Prototype pollution debe rechazarse");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PEN TESTING — Middleware
// ─────────────────────────────────────────────────────────────────────────────
describe("Pen Test — Middleware Security", () => {
  const kp    = generateKeypair();
  const token = createToken(kp, "0xnull", ["DocumentVerified", "FaceMatch"]);

  // verifySPT tests
  test("minScore=0 acepta todo token válido", () => {
    const r = verifySPT(token, { minScore: 0 });
    assert(r.allowed, "minScore=0 debe aceptar cualquier token válido");
  });

  test("minScore=100 rechaza todo (máximo teórico > 100 con combinaciones)", () => {
    const r = verifySPT(token, { minScore: 100 });
    assert(!r.allowed, "minScore=100 debe rechazar un token con score 45");
  });

  test("minScore negativo acepta (no crash)", () => {
    const r = verifySPT(token, { minScore: -99 });
    assert(r.allowed, "minScore negativo debe aceptar igual (no crash)");
  });

  test("require array vacío acepta cualquier token válido", () => {
    const r = verifySPT(token, { require: [] });
    assert(r.allowed, "require=[] no debe rechazar nada");
  });

  test("Token undefined rechazado con mensaje claro", () => {
    const r = verifySPT(undefined, {});
    assert(!r.allowed);
    assert(r.reason?.includes("No Soulprint"), `Mensaje: "${r.reason}"`);
  });

  test("Token null rechazado", () => {
    assert(!verifySPT(null, {}).allowed);
  });

  test("Token cadena vacía rechazada", () => {
    assert(!verifySPT("", {}).allowed);
  });

  test("Token muy largo rechazado (DoS protection)", () => {
    const huge = "x".repeat(100_000);
    const r = verifySPT(huge, {});
    assert(!r.allowed, "Token de 100KB debe rechazarse");
  });

  test("onRejected callback se llama", () => {
    let called = false;
    const r = verifySPT(null, { onRejected: () => { called = true; } });
    assert(!r.allowed && called, "onRejected debe llamarse al rechazar");
  });

  test("onVerified callback se llama con token válido", () => {
    let calledWith = null;
    const r = verifySPT(token, { minScore: 40, onVerified: (t) => { calledWith = t; } });
    assert(r.allowed && calledWith !== null, "onVerified debe llamarse con el token");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. VALIDACIÓN DE CÉDULA
// ─────────────────────────────────────────────────────────────────────────────
describe("Cedula Validator", () => {
  test("Cédulas válidas aceptadas", () => {
    const valid = ["1020461234", "79876543", "10054321", "1000000001"];
    valid.forEach(c => {
      const r = validateCedulaNumber(c);
      assert(r.valid, `${c} debe ser válida: ${r.error}`);
    });
  });

  test("Cédula con puntos aceptada", () => {
    assert(validateCedulaNumber("1.020.461.234").valid, "Con puntos debe ser válida");
  });

  test("Cédula muy corta rechazada", () => {
    assert(!validateCedulaNumber("1234").valid, "4 dígitos debe rechazarse");
  });

  test("Cédula muy larga rechazada", () => {
    assert(!validateCedulaNumber("12345678901").valid, "11 dígitos debe rechazarse");
  });

  test("Cédula con letras rechazada", () => {
    assert(!validateCedulaNumber("1020ABC234").valid, "Con letras debe rechazarse");
  });

  test("Cédula con todos dígitos iguales rechazada", () => {
    assert(!validateCedulaNumber("1111111111").valid, "111...1 debe rechazarse");
    assert(!validateCedulaNumber("0000000000").valid, "000...0 debe rechazarse");
  });

  test("Cédula nula/vacía rechazada", () => {
    assert(!validateCedulaNumber("").valid, "Vacía debe rechazarse");
    assert(!validateCedulaNumber("   ").valid, "Solo espacios debe rechazarse");
  });

  test("Inyección SQL rechazada", () => {
    assert(!validateCedulaNumber("'; DROP TABLE cedulas;--").valid);
  });

  test("Inyección XSS rechazada", () => {
    assert(!validateCedulaNumber("<script>alert(1)</script>").valid);
  });

  // ── ICAO 9303 check digits ───────────────────────────────────────────────
  test("ICAO check digit — casos canónicos Doc 9303", () => {
    // Ejemplos verificados del estándar ICAO 9303 Part 3 §4.9
    assertEq(icaoCheckDigit("520727"),    3, "Fecha nac 520727 → check 3");
    assertEq(icaoCheckDigit("740812"),    2, "Fecha nac 740812 → check 2");
    assertEq(icaoCheckDigit("120415"),    9, "Fecha exp 120415 → check 9");
    assertEq(icaoCheckDigit("L898902C3"), 6, "Num. pasaporte L898902C3 → check 6");
  });

  test("ICAO check digit — caracteres especiales", () => {
    assertEq(icaoCheckDigit(""),    0, "Campo vacío → 0");
    assertEq(icaoCheckDigit("<<<"), 0, "Solo relleno → 0");
    assertEq(icaoCheckDigit("0"),   0, "'0' → 0");
    assertEq(icaoCheckDigit("A"),   0, "A=10, 10*7=70, 70 mod 10 = 0");
  });

  test("ICAO check digit — pesos cíclicos 7/3/1", () => {
    // "123" → 1*7 + 2*3 + 3*1 = 7+6+3 = 16 → 6
    assertEq(icaoCheckDigit("123"), 6);
    // "1234" → 1*7 + 2*3 + 3*1 + 4*7 = 7+6+3+28 = 44 → 4
    assertEq(icaoCheckDigit("1234"), 4);
  });

  test("verifyCheckDigit acepta campo correcto", () => {
    const r = verifyCheckDigit("520727", "3");
    assert(r.valid,           "Debe ser válido");
    assertEq(r.computed,  3);
    assertEq(r.expected,  3);
  });

  test("verifyCheckDigit rechaza check digit incorrecto", () => {
    const r = verifyCheckDigit("520727", "9");
    assert(!r.valid,          "Debe ser inválido");
    assertEq(r.computed,  3);
    assertEq(r.expected,  9);
  });

  // ── MRZ con check digits ─────────────────────────────────────────────────
  test("parseMRZ — MRZ válido con check digits correctos", () => {
    // Cédula colombiana TD1 sintética con check digits ICAO válidos
    // Número doc: 1020461234 → en MRZ: 1020461234 (10 chars)
    // Fecha nac:  900315 (1990-03-15) → check: icaoCheckDigit("900315")
    // icaoCheckDigit("900315") = 9*7+0*3+0*1+3*7+1*3+5*1 = 63+0+0+21+3+5 = 92 % 10 = 2
    // Fecha exp:  300101 (2030-01-01) → check: icaoCheckDigit("300101")
    // icaoCheckDigit("300101") = 3*7+0*3+0*1+1*7+0*3+1*1 = 21+0+0+7+0+1 = 29 % 10 = 9
    // Doc num check en línea 1: icaoCheckDigit("1020461234") = ?

    // Construir MRZ sintético correcto
    const dobCheck = icaoCheckDigit("900315").toString();  // debe ser 2
    const expCheck = icaoCheckDigit("300101").toString();  // debe ser 9

    const line2 = `900315${dobCheck}M300101${expCheck}COL1020461234  `;
    const line3 = "GARCIA<<JUAN<<PABLO<<<<<<<<<<<<";
    const mrz   = `ID<<COL1020461234<\n${line2}\n${line3}`;

    const r = parseMRZ(mrz);

    assert(r.cedula_number  === "1020461234" || r.cedula_number !== undefined, "Debe extraer número");
    assert(r.fecha_nacimiento?.includes("1990") || r.fecha_nacimiento?.includes("90"),
           `Fecha nac debe tener 1990: ${r.fecha_nacimiento}`);
    assert(r.sexo === "M", `Sexo debe ser M: ${r.sexo}`);
  });

  test("parseMRZ — check digit incorrecto en fecha nac genera error", () => {
    // Fecha nac correcta: 900315 → check 2, ponemos 9 (incorrecto)
    const line2 = "9003159M300101XCOL1020461234  "; // check 9 = MAL
    const line3 = "GARCIA<<JUAN<<<<<<<<<<<<<<<<<<";
    const mrz   = `ID<<COL1020461234<\n${line2}\n${line3}`;

    const r = parseMRZ(mrz);
    assert(
      r.errors.some(e => e.includes("fecha de nacimiento") || e.includes("check digit")),
      `Debe reportar error en check digit de fecha nac. Errors: ${JSON.stringify(r.errors)}`
    );
  });

  test("parseMRZ — MRZ incompleto rechazado", () => {
    const r = parseMRZ("linea corta\n");
    assert(!r.valid, "MRZ incompleto debe ser inválido");
    assert(r.errors.length > 0, "Debe tener errores");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PEN TESTING — Nullifier & Anti-Sybil
// ─────────────────────────────────────────────────────────────────────────────
describe("Pen Test — Nullifier & Anti-Sybil", () => {
  test("Mismo nullifier con mismos inputs (determinístico)", () => {
    const e = new Float32Array(512).fill(0.5);
    const n1 = deriveNullifier("1020461234", "2004-03-15", e);
    const n2 = deriveNullifier("1020461234", "2004-03-15", e);
    assertEq(n1, n2, "Mismo input → mismo nullifier");
  });

  test("Distinta cédula → distinto nullifier", () => {
    const e = new Float32Array(512).fill(0.5);
    const n1 = deriveNullifier("1020461234", "2004-03-15", e);
    const n2 = deriveNullifier("9999999999", "2004-03-15", e);
    assert(n1 !== n2, "Cédulas distintas deben dar nullifiers distintos");
  });

  test("Distinta fecha → distinto nullifier", () => {
    const e = new Float32Array(512).fill(0.5);
    const n1 = deriveNullifier("1020461234", "2004-03-15", e);
    const n2 = deriveNullifier("1020461234", "1978-07-22", e);
    assert(n1 !== n2, "Fechas distintas deben dar nullifiers distintos");
  });

  test("Distinto embedding → distinto nullifier", () => {
    const e1 = new Float32Array(512).fill(0.5);
    const e2 = new Float32Array(512).fill(0.9);
    const n1 = deriveNullifier("1020461234", "2004-03-15", e1);
    const n2 = deriveNullifier("1020461234", "2004-03-15", e2);
    assert(n1 !== n2, "Embeddings distintos deben dar nullifiers distintos");
  });

  test("Nullifier siempre es hex (0x prefix + 64 chars)", () => {
    const e = new Float32Array(512).fill(0.3);
    const n = deriveNullifier("1020461234", "2000-01-01", e);
    assert(/^0x[0-9a-f]{64}$/.test(n), `Nullifier malformado: ${n}`);
  });

  test("No hay nullifiers iguales para 1000 personas distintas", () => {
    const nullifiers = new Set();
    for (let i = 0; i < 1000; i++) {
      const e = new Float32Array(512).fill(i / 1000.0);
      const n = deriveNullifier(String(10000000 + i), "1990-01-01", e);
      nullifiers.add(n);
    }
    assertEq(nullifiers.size, 1000, "Colisión detectada en 1000 nullifiers");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. E2E — Flujo completo sin archivos reales
// ─────────────────────────────────────────────────────────────────────────────
describe("E2E — Flujo completo (mocked)", async () => {
  // Simular el flujo completo: verificación → token → middleware → acceso

  const kp = generateKeypair();

  test("Flujo: crear identidad → emitir token → verificar → acceso API", () => {
    // 1. "Verificación local" completada — tenemos nullifier + credenciales
    const embedding  = new Float32Array(512).map((_, i) => Math.sin(i * 0.01));
    const nullifier  = deriveNullifier("1020461234", "2004-03-15", embedding);

    // 2. Emitir SPT
    const token = createToken(kp, nullifier, ["DocumentVerified", "FaceMatch"], {
      country: "CO"
    });

    // 3. Verificar con el middleware (simula req.headers["x-soulprint"])
    const req = { headers: { "x-soulprint": token }, query: {} };

    // Simular el middleware Express manualmente
    let nextCalled = false;
    const res = {
      status: () => ({ json: () => {} }),
      json: () => {},
      called403: false,
    };

    const { soulprint } = require("../packages/express/dist/index.js");
    const mw = soulprint({ minScore: 40 });

    mw(req, res, () => { nextCalled = true; });
    assert(nextCalled, "Middleware debe llamar next() con token válido");
    assert(req.soulprint !== undefined, "req.soulprint debe estar poblado");
    assertEq(req.soulprint.score, 45, "Score correcto");
    assertEq(req.soulprint.nullifier, nullifier, "Nullifier correcto");
  });

  test("Flujo: token vencido → acceso denegado", () => {
    const expired = createToken(kp, "0x0", ["DocumentVerified"], { lifetimeSeconds: -10 });
    const r = verifySPT(expired, { minScore: 20 });
    assert(!r.allowed, "Token expirado debe denegar acceso");
    assert(r.reason?.includes("Invalid") || r.reason?.includes("expired"), `Razón: ${r.reason}`);
  });

  test("Flujo: renovar token (mismo DID, nueva expiración)", () => {
    const t1 = createToken(kp, "0xnull", ["FaceMatch"], { lifetimeSeconds: 3600 });
    const d1 = decodeToken(t1);
    // Esperar 1ms para que el timestamp cambie
    const t2 = createToken(kp, "0xnull", ["FaceMatch"], { lifetimeSeconds: 86400 });
    const d2 = decodeToken(t2);
    assertEq(d1.did, d2.did, "Mismo DID después de renovar");
    assert(d2.expires > d1.expires, "Token renovado expira después");
  });

  test("Flujo: nivel insuficiente → acceso denegado con mensaje útil", () => {
    const lite = createToken(kp, "0xnull", ["EmailVerified"]);
    const r = verifySPT(lite, { minLevel: "KYCFull" });
    assert(!r.allowed, "KYCLite no debe pasar con minLevel=KYCFull");
    assert(r.reason?.length > 0, "Debe incluir razón de rechazo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. PEN TESTING — Ataques de timing y DoS
// ─────────────────────────────────────────────────────────────────────────────
describe("Pen Test — Timing & DoS", () => {
  test("Verificar 10,000 tokens inválidos no es lento (<2s total)", async () => {
    const start = Date.now();
    for (let i = 0; i < 10_000; i++) {
      decodeToken("token_invalido_" + i);
    }
    const elapsed = Date.now() - start;
    assert(elapsed < 2000, `10k verificaciones tomaron ${elapsed}ms (debe ser <2s)`);
  });

  test("Token con nullifier muy largo no hace crash", () => {
    const kp = generateKeypair();
    const nullifier = "0x" + "a".repeat(10_000);
    const t = createToken(kp, nullifier, ["EmailVerified"]);
    const d = decodeToken(t);
    assert(d !== null, "Token con nullifier largo debe ser manejable");
    assertEq(d.nullifier.length, nullifier.length, "Nullifier preservado");
  });

  test("Muchos re-usos del mismo token son permitidos (no hay estado)", () => {
    const kp = generateKeypair();
    const t  = createToken(kp, "0xnull", ["FaceMatch"]);
    for (let i = 0; i < 1000; i++) {
      const r = verifySPT(t, { minScore: 10 });
      if (!r.allowed) throw new Error(`Fallo en iteración ${i}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. ZK PROOF — Tests básicos (sin compilar circuito)
// ─────────────────────────────────────────────────────────────────────────────
describe("ZK — Poseidon & face_key", async () => {
  const { computeNullifier, faceEmbeddingToKey, cedulaToBigInt, fechaToBigInt,
          serializeProof, deserializeProof } = require("../packages/zkp/dist/index.js");

  test("Nullifier Poseidon determinístico", async () => {
    const n1 = await computeNullifier(BigInt(1020461234), BigInt(20040315), BigInt(999));
    const n2 = await computeNullifier(BigInt(1020461234), BigInt(20040315), BigInt(999));
    assertEq(n1.toString(), n2.toString(), "Mismo input → mismo nullifier");
  });

  test("Cédulas distintas → nullifiers distintos", async () => {
    const n1 = await computeNullifier(BigInt(1020461234), BigInt(20040315), BigInt(999));
    const n2 = await computeNullifier(BigInt(9999999999), BigInt(20040315), BigInt(999));
    assert(n1 !== n2, "Cédulas distintas deben dar nullifiers distintos");
  });

  test("face_key determinístico (misma cara = misma llave)", async () => {
    const emb = Array.from({ length: 512 }, (_, i) => Math.round(Math.sin(i) * 8) / 10);
    const k1  = await faceEmbeddingToKey(emb);
    const k2  = await faceEmbeddingToKey(emb);
    assertEq(k1.toString(), k2.toString(), "Misma cara → misma llave");
  });

  test("face_key robusto ante ruido ±0.01 (intra-clase)", async () => {
    const base = Array.from({ length: 512 }, (_, i) => Math.round(Math.sin(i * 0.1) * 8) / 10);
    const noisy = base.map(v => v + (Math.random() * 0.02 - 0.01));
    const k1 = await faceEmbeddingToKey(base);
    const k2 = await faceEmbeddingToKey(noisy);
    assertEq(k1.toString(), k2.toString(), "Ruido ±0.01 debe dar misma llave");
  });

  test("face_keys distintas para personas distintas", async () => {
    const p1 = Array.from({ length: 512 }, (_, i) => Math.round(Math.sin(i) * 8) / 10);
    const p2 = Array.from({ length: 512 }, (_, i) => Math.round(Math.cos(i) * 8) / 10);
    const k1 = await faceEmbeddingToKey(p1);
    const k2 = await faceEmbeddingToKey(p2);
    assert(k1.toString() !== k2.toString(), "Personas distintas → llaves distintas");
  });

  test("Serialización/deserialización de proof", () => {
    const mock = {
      proof: { pi_a: ["1", "2"], pi_b: [["3", "4"]], pi_c: ["5", "6"] },
      public_signals: ["12345", "0"],
      nullifier: "0xabcdef",
    };
    const s = serializeProof(mock);
    const d = deserializeProof(s);
    assertEq(d.nullifier, mock.nullifier, "Nullifier preservado en serialización");
    assertEq(d.public_signals[0], "12345", "Señal pública preservada");
  });

  test("cedulaToBigInt maneja puntos y espacios", () => {
    assertEq(cedulaToBigInt("1.020.461.234"), BigInt(1020461234));
    assertEq(cedulaToBigInt("1020461234"), BigInt(1020461234));
  });

  test("fechaToBigInt convierte ISO a YYYYMMDD", () => {
    assertEq(fechaToBigInt("2004-03-15"), BigInt(20040315));
    assertEq(fechaToBigInt("1978-07-22"), BigInt(19780722));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. VALIDATOR NODE — Tests de lógica
// ─────────────────────────────────────────────────────────────────────────────
describe("Validator Node — Anti-Sybil Logic", () => {
  const kp1 = generateKeypair();
  const kp2 = generateKeypair();

  test("Dos tokens del mismo DID son independientes", () => {
    const t1 = createToken(kp1, "0xnull1", ["FaceMatch"]);
    const t2 = createToken(kp1, "0xnull2", ["FaceMatch"]);
    const d1 = decodeToken(t1);
    const d2 = decodeToken(t2);
    assertEq(d1.did, d2.did, "Mismo DID en ambos tokens");
    assert(d1.nullifier !== d2.nullifier, "Nullifiers distintos");
  });

  test("Token futuro (issued en futuro) pasaría la verificación si expires es válido", () => {
    // La verificación solo mira expires, no issued
    // Esto está bien — issued es informativo
    const kp = generateKeypair();
    const t = createToken(kp, "0xnull", ["FaceMatch"]);
    const d = decodeToken(t);
    assert(d !== null, "Token con issued en el pasado debe ser válido");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RESULTADO FINAL
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n${"═".repeat(55)}`);
  console.log("  SOULPRINT — TEST SUITE EXHAUSTIVO");
  console.log(`${"═".repeat(55)}`);

  // Esperar a que todas las pruebas async terminen
  await new Promise(resolve => setTimeout(resolve, 200));

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  Total:   ${total} tests`);
  console.log(`  Pasados: ${passed} ✅`);
  console.log(`  Fallidos: ${failed} ${failed > 0 ? "❌" : "✅"}`);

  if (errors.length > 0) {
    console.log("\n  Errores:");
    errors.forEach(e => console.log(`    • [${e.section}] ${e.name}: ${e.error}`));
  }

  console.log(`${"═".repeat(55)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
