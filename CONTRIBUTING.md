# Contributing to Soulprint 🌍

Thank you for helping make Soulprint a global identity standard!

## Adding a New Country 🗺️

> "One PR, one country." — Anyone who knows their country's ID format can contribute.

### It takes ~30 minutes. Here's how:

---

### 1. Fork & clone

```bash
git clone https://github.com/manuelariasfz/soulprint
cd soulprint
pnpm install
```

---

### 2. Create your country file

```bash
cp packages/verify-local/src/document/countries/AR.ts \
   packages/verify-local/src/document/countries/XX.ts
```

Replace `XX` with your [ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) country code (uppercase).

Examples: `ES` (Spain), `US` (United States), `DE` (Germany), `IN` (India), `NG` (Nigeria)...

---

### 3. Fill in the 4 required fields

```typescript
const XX: CountryVerifier = {
  countryCode:   "XX",               // ← Your ISO code
  countryName:   "Your Country",     // ← In English
  documentTypes: ["national_id"],    // ← Slug labels for your docs

  parse(ocrText: string): DocumentResult {
    // Extract: doc_number, full_name, date_of_birth, sex, expiry_date
    // Return DocumentResult with country: "XX"
  },

  validate(docNumber: string): NumberValidation {
    // Validate format + check digits (if applicable)
    // Return { valid, normalized?, error? }
  },
};
```

---

### 4. Register it (one line)

In `packages/verify-local/src/document/registry.ts`:

```typescript
// Add your import
import XX from "./countries/XX.js";

// Add to the array
const VERIFIERS: CountryVerifier[] = [
  CO, MX, AR, VE, PE, BR, CL,
  XX,  // ← your country
];
```

---

### 5. Test it

```bash
pnpm --filter soulprint-verify build
node -e "
const { getVerifier } = require('./packages/verify-local/dist/document/registry.js');
const v = getVerifier('XX');
console.log(v.validate('your-sample-id-number'));
"
```

---

### 6. Open a PR

Title: `feat(countries): add XX (Your Country) document verifier`

Include:
- Sample (fake/test) document numbers that pass validation
- Sample OCR text from your document (redact any real personal data)
- Link to official format documentation

---

## Document Verifier Interface

```typescript
interface CountryVerifier {
  // Required
  countryCode:   string;        // "CO", "MX", "AR"...
  countryName:   string;        // "Colombia", "Mexico"...
  documentTypes: string[];      // ["cedula", "passport"]

  parse(ocrText: string): DocumentResult;       // OCR → structured data
  validate(docNumber: string): NumberValidation; // number format check

  // Optional (implement if your doc has MRZ)
  parseMRZ?(mrzText: string): DocumentResult;

  // Optional (image pre-check before OCR)
  quickValidate?(imagePath: string): Promise<ImageValidation>;
}
```

---

## DocumentResult fields

| Field | Type | Description |
|---|---|---|
| `valid` | `boolean` | All checks passed |
| `doc_number` | `string` | Normalized ID number (no dots/dashes) |
| `full_name` | `string` | "NOMBRES APELLIDOS" format |
| `date_of_birth` | `string` | ISO 8601: `YYYY-MM-DD` |
| `sex` | `"M" \| "F"` | As recorded on document |
| `expiry_date` | `string` | ISO 8601: `YYYY-MM-DD` |
| `document_type` | `string` | Slug: `"cedula"`, `"dni"`, `"passport"` |
| `country` | `string` | Your ISO code |
| `errors` | `string[]` | Fatal — document invalid if non-empty |
| `warnings` | `string[]` | Non-fatal notes |

---

## Tips & Common Patterns

### Detecting your document from OCR text
```typescript
// Look for country/authority keywords
const isYourCountry = /YOUR AUTHORITY|YOUR COUNTRY|OFFICIAL TEXT/i.test(text);
if (!isYourCountry) errors.push("Not a [Country] ID");
```

### ICAO 9303 check digits (for MRZ documents)
```typescript
import { icaoCheckDigit, verifyCheckDigit } from "../cedula-validator.js";

const dobCheck = verifyCheckDigit("900315", line2[6]);
if (!dobCheck.valid) errors.push(`Invalid DOB check digit`);
```

### Country-specific check digit algorithms

Some countries use their own mod algorithms:
- 🇧🇷 Brazil CPF: mod 11, decreasing weights — see `BR.ts`
- 🇨🇱 Chile RUN: mod 11, weights 2-7 — see `CL.ts`
- 🇲🇽 Mexico CURP: character checksum — see `MX.ts`
- MRZ (all ICAO documents): weights 7/3/1 — see `icaoCheckDigit()`

### Date normalization
Always output `YYYY-MM-DD`:
```typescript
// DD/MM/YYYY → YYYY-MM-DD
const [d, m, y] = "15/03/1990".split("/");
const iso = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
```

---

## Countries Status

| Code | Country | Status | Documents |
|---|---|---|---|
| 🇨🇴 CO | Colombia | ✅ Full | Cédula (CC, CE) |
| 🇲🇽 MX | Mexico | 🟡 Partial | INE/CURP (validation only) |
| 🇦🇷 AR | Argentina | 🟡 Partial | DNI |
| 🇻🇪 VE | Venezuela | 🟡 Partial | Cédula (V/E) |
| 🇵🇪 PE | Peru | 🟡 Partial | DNI |
| 🇧🇷 BR | Brazil | 🟡 Partial | CPF (full check digits) + RG |
| 🇨🇱 CL | Chile | 🟡 Partial | RUN (full check digits) |
| 🇪🇸 ES | Spain | 🔴 Needed | DNI, NIE |
| 🇺🇸 US | United States | 🔴 Needed | SSN (no biometric), DL |
| 🇩🇪 DE | Germany | 🔴 Needed | Personalausweis |
| 🇮🇳 IN | India | 🔴 Needed | Aadhaar, PAN |
| 🇳🇬 NG | Nigeria | 🔴 Needed | NIN |
| 🇿🇦 ZA | South Africa | 🔴 Needed | ID (13-digit) |
| 🇰🇪 KE | Kenya | 🔴 Needed | National ID |
| 🇵🇭 PH | Philippines | 🔴 Needed | PhilSys |

> **All contributions welcome.** Open an issue if you're working on a country to avoid duplicate work.

---

## Code of Conduct

- Privacy first: never include real personal data in tests
- Keep OCR samples anonymized/synthetic
- All validation logic must be documented with official sources
- MIT license — your contribution is MIT by default

---

## Questions?

Open an issue or start a [Discussion](https://github.com/manuelariasfz/soulprint/discussions).
