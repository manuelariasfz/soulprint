"""FastAPI middleware / decorator for Soulprint human verification."""

from __future__ import annotations

import functools
from typing import Optional, Callable

from .client import SoulprintClient, DEFAULT_NODE_URL
from .exceptions import SoulprintError, UnauthorizedError

try:
    from fastapi import Request
    from fastapi.responses import JSONResponse
    import starlette
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "FastAPI integration requires 'fastapi' to be installed. "
        "Run: pip install fastapi"
    ) from exc


def require_human(
    min_score: int = 50,
    node_url: str = DEFAULT_NODE_URL,
    timeout: float = 10.0,
):
    """
    FastAPI route decorator that enforces Soulprint human verification.

    The decorator reads the DID token from:
    - ``X-Soulprint-Token`` header  (preferred)
    - ``Authorization: Bearer <token>`` header

    It then calls the Soulprint node to verify the DID and checks that the
    trust score meets ``min_score``.  On success the following attributes are
    injected into ``request.state``:

    - ``request.state.soulprint_did``   – the verified DID
    - ``request.state.soulprint_score`` – the trust score (int 0-100)

    Usage::

        from fastapi import FastAPI, Request
        from soulprint.fastapi import require_human

        app = FastAPI()

        @app.post("/api/sensitive")
        @require_human(min_score=80, node_url="https://soulprint-node-production.up.railway.app")
        async def sensitive_endpoint(request: Request):
            did   = request.state.soulprint_did
            score = request.state.soulprint_score
            return {"did": did, "score": score}
    """

    def decorator(func: Callable):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            # Extract the Request object from args/kwargs
            request: Optional[Request] = None
            for arg in args:
                if isinstance(arg, Request):
                    request = arg
                    break
            if request is None:
                request = kwargs.get("request")
            if request is None:
                raise RuntimeError("require_human: could not find a FastAPI Request object")

            # Extract DID token
            token = (
                request.headers.get("X-Soulprint-Token")
                or _bearer(request.headers.get("Authorization"))
            )
            if not token:
                return JSONResponse(
                    status_code=401,
                    content={"error": "Missing Soulprint token. Provide X-Soulprint-Token header."},
                )

            # Verify
            client = SoulprintClient(node_url=node_url, timeout=timeout)
            try:
                result = await client.verify(token)
            except UnauthorizedError:
                return JSONResponse(
                    status_code=401,
                    content={"error": "Invalid Soulprint token."},
                )
            except SoulprintError as exc:
                return JSONResponse(
                    status_code=503,
                    content={"error": f"Soulprint verification unavailable: {exc}"},
                )

            if not result.is_human:
                return JSONResponse(
                    status_code=403,
                    content={"error": "Not a verified human. Score too low or unverified DID."},
                )

            if result.score < min_score:
                return JSONResponse(
                    status_code=403,
                    content={
                        "error": f"Trust score {result.score} is below required minimum {min_score}.",
                        "score": result.score,
                        "required": min_score,
                    },
                )

            # Inject into request.state
            request.state.soulprint_did = result.node_did or token
            request.state.soulprint_score = result.score

            return await func(*args, **kwargs)

        return wrapper

    return decorator


def _bearer(auth_header: Optional[str]) -> Optional[str]:
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return None
