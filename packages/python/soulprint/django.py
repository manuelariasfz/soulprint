"""Django middleware for Soulprint human verification."""

from __future__ import annotations

from typing import Callable, Optional

from .client import SoulprintClient, DEFAULT_NODE_URL
from .exceptions import SoulprintError, UnauthorizedError

try:
    from django.http import HttpRequest, JsonResponse
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "Django integration requires 'django' to be installed. "
        "Run: pip install django"
    ) from exc


class SoulprintMiddleware:
    """
    Django middleware that verifies Soulprint tokens on every request.

    Attach the middleware in ``settings.py``::

        MIDDLEWARE = [
            ...
            "soulprint.django.SoulprintMiddleware",
        ]

    Configure via Django settings::

        SOULPRINT_NODE_URL = "https://soulprint-node-production.up.railway.app"
        SOULPRINT_MIN_SCORE = 50          # default 50
        SOULPRINT_EXEMPT_PATHS = ["/health", "/"]  # paths to skip

    On successful verification the following attributes are set on the request:

    - ``request.soulprint_did``   – verified DID string
    - ``request.soulprint_score`` – trust score (int 0-100)

    Unauthenticated / low-score requests receive a 401/403 JSON response.
    """

    def __init__(self, get_response: Callable):
        from django.conf import settings

        self.get_response = get_response
        self.node_url = getattr(settings, "SOULPRINT_NODE_URL", DEFAULT_NODE_URL)
        self.min_score = getattr(settings, "SOULPRINT_MIN_SCORE", 50)
        self.exempt_paths: list = getattr(settings, "SOULPRINT_EXEMPT_PATHS", [])

    def __call__(self, request: HttpRequest):
        if any(request.path.startswith(p) for p in self.exempt_paths):
            return self.get_response(request)

        token = (
            request.headers.get("X-Soulprint-Token")
            or _bearer(request.headers.get("Authorization"))
        )
        if not token:
            return JsonResponse(
                {"error": "Missing Soulprint token. Provide X-Soulprint-Token header."},
                status=401,
            )

        import asyncio

        client = SoulprintClient(node_url=self.node_url)
        try:
            result = asyncio.run(client.verify(token))
        except UnauthorizedError:
            return JsonResponse({"error": "Invalid Soulprint token."}, status=401)
        except SoulprintError as exc:
            return JsonResponse(
                {"error": f"Soulprint verification unavailable: {exc}"}, status=503
            )

        if not result.is_human or result.score < self.min_score:
            return JsonResponse(
                {
                    "error": "Soulprint verification failed.",
                    "score": result.score,
                    "required": self.min_score,
                },
                status=403,
            )

        request.soulprint_did = result.node_did or token
        request.soulprint_score = result.score
        return self.get_response(request)


def _bearer(auth_header: Optional[str]) -> Optional[str]:
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return None
