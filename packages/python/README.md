# soulprint-py

Python SDK for the [Soulprint](https://soulprint.digital) decentralized identity protocol.

## Installation

```bash
pip install soulprint-py
```

With FastAPI extras:

```bash
pip install "soulprint-py[fastapi]"
```

## Quick Start

```python
import asyncio
from soulprint import SoulprintClient

client = SoulprintClient(
    node_url="https://soulprint-node-production.up.railway.app"
)

async def main():
    # Get node info
    info = await client.info()
    print(f"Node: {info.node_did}  Version: {info.version}")

    # Verify a DID
    result = await client.verify("did:soulprint:0xabc...")
    print(f"Human: {result.is_human}  Score: {result.score}/100")

    # Verify a Colombian cédula
    cedula = await client.verify_cedula("1234567890", "1990-01-15")
    print(f"Cédula vigente: {cedula.vigente}")

    # Network stats
    stats = await client.network_stats()
    print(f"Active nodes: {stats.active_nodes}")

asyncio.run(main())
```

## FastAPI Middleware

```python
from fastapi import FastAPI, Request
from soulprint.fastapi import require_human

app = FastAPI()

@app.post("/api/sensitive")
@require_human(min_score=80, node_url="https://soulprint-node-production.up.railway.app")
async def sensitive_endpoint(request: Request):
    did   = request.state.soulprint_did
    score = request.state.soulprint_score
    return {"did": did, "score": score}
```

The decorator reads the DID from:
- `X-Soulprint-Token` header (preferred)
- `Authorization: Bearer <token>` header

## Django Middleware

Add to `settings.py`:

```python
MIDDLEWARE = [
    ...
    "soulprint.django.SoulprintMiddleware",
]

SOULPRINT_NODE_URL  = "https://soulprint-node-production.up.railway.app"
SOULPRINT_MIN_SCORE = 50
SOULPRINT_EXEMPT_PATHS = ["/health", "/"]
```

Verified attributes on request:
- `request.soulprint_did`
- `request.soulprint_score`

## Error Handling

```python
from soulprint.exceptions import (
    SoulprintError,
    NodeUnavailableError,
    UnauthorizedError,
    VerificationError,
)

try:
    result = await client.verify("did:soulprint:0x...")
except NodeUnavailableError as e:
    print(f"Node down: {e.node_url}")
except SoulprintError as e:
    print(f"Error: {e}")
```

## Publishing to PyPI

When ready, publish with:

```bash
# Install build tools
pip install build twine

# Build distribution
cd packages/python
python -m build

# Upload (requires PyPI token)
twine upload dist/* --username __token__ --password <PYPI_TOKEN>
```

## License

MIT — See [LICENSE](../../LICENSE) in the repo root.
