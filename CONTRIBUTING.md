# Contributing to Soulprint

## Setup

```bash
git clone https://github.com/manuelariasfz/soulprint
cd soulprint
pnpm install
pnpm build
```

## Running Tests

```bash
# All packages
pnpm test

# Specific package
cd packages/zkp && node dist/prover.test.js
cd packages/verify-local && node -e "/* see README */"
```

## Adding a New Country

1. Create `packages/verify-local/src/document/<country>-validator.ts`
2. Implement `parseDocumentOCR(text): DocumentValidationResult`
3. Implement `parseMRZ(text): DocumentValidationResult` (if applicable)
4. Add tests with sample (fake) document images
5. Update the README country support table

## ZK Circuit Changes

If you modify `packages/zkp/circuits/soulprint_identity.circom`:
1. Re-run `pnpm --filter @soulprint/zkp build:circuits`
2. **Important**: the trusted setup must be redone — notify the community
3. Ideally run a multi-party ceremony (see snarkjs docs)

## Pull Request Guidelines

- One feature per PR
- Tests required for new functionality
- No PII in test fixtures — use fake/generated data only
- Document new packages with a README.md

## Code Style

- TypeScript strict mode
- No `any` unless unavoidable (add `// @ts-ignore` with comment)
- Functions < 50 lines when possible
- Comments explain WHY, not WHAT
