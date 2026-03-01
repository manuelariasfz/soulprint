"""SoulprintClient — async HTTP client for the Soulprint validator network."""

from __future__ import annotations

import httpx
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from .exceptions import NodeUnavailableError, SoulprintError, VerificationError

DEFAULT_NODE_URL = "https://soulprint-node-production.up.railway.app"
DEFAULT_TIMEOUT = 10.0


@dataclass
class VerifyResult:
    """Result from client.verify()."""
    is_human: bool
    score: int
    node_did: str
    verified_at: Optional[datetime] = None
    raw: dict = None


@dataclass
class CedulaResult:
    """Result from client.verify_cedula()."""
    vigente: bool
    status: str
    numero: str
    raw: dict = None


@dataclass
class NetworkStats:
    """Result from client.network_stats()."""
    active_nodes: int
    verified_identities: int
    raw: dict = None


@dataclass
class NodeInfo:
    """Result from client.info()."""
    node_did: str
    version: str
    network: str
    known_peers: int
    capabilities: list
    raw: dict = None


class SoulprintClient:
    """
    Async HTTP client for interacting with the Soulprint validator network.

    Usage::

        import asyncio
        from soulprint import SoulprintClient

        client = SoulprintClient(node_url="https://soulprint-node-production.up.railway.app")

        async def main():
            result = await client.verify("did:soulprint:0xabc...")
            print(result.is_human, result.score)

            cedula = await client.verify_cedula("1234567890", "1990-01-15")
            print(cedula.vigente)

        asyncio.run(main())
    """

    def __init__(
        self,
        node_url: str = DEFAULT_NODE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        api_key: Optional[str] = None,
    ):
        self.node_url = node_url.rstrip("/")
        self.timeout = timeout
        self._headers = {}
        if api_key:
            self._headers["X-Soulprint-Token"] = api_key

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.node_url,
            headers=self._headers,
            timeout=self.timeout,
        )

    async def _get(self, path: str, params: dict = None) -> dict:
        try:
            async with self._client() as client:
                resp = await client.get(path, params=params)
                if resp.status_code == 401:
                    from .exceptions import UnauthorizedError
                    raise UnauthorizedError()
                if resp.status_code >= 400:
                    raise VerificationError(
                        f"Node returned {resp.status_code}: {resp.text}",
                        status_code=resp.status_code,
                    )
                return resp.json()
        except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as exc:
            raise NodeUnavailableError(self.node_url) from exc
        except (SoulprintError,):
            raise
        except Exception as exc:
            raise SoulprintError(f"Unexpected error calling Soulprint node: {exc}") from exc

    async def verify(self, did: str) -> VerifyResult:
        """
        Check if a DID is a verified human.

        :param did: A Soulprint DID (e.g. ``did:soulprint:0xabc...``)
        :returns: :class:`VerifyResult`
        :raises NodeUnavailableError: if the node is unreachable
        :raises VerificationError: if verification fails
        """
        data = await self._get(f"/verify/{did}")
        verified_at = None
        if data.get("verified_at"):
            try:
                verified_at = datetime.fromisoformat(data["verified_at"].replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                pass
        return VerifyResult(
            is_human=bool(data.get("is_human", False)),
            score=int(data.get("score", 0)),
            node_did=data.get("node_did", ""),
            verified_at=verified_at,
            raw=data,
        )

    async def verify_cedula(self, numero: str, fecha_nac: str) -> CedulaResult:
        """
        Verify a Colombian cédula against the Registraduría Nacional.

        :param numero: Cédula number (digits only)
        :param fecha_nac: Date of birth in YYYY-MM-DD format
        :returns: :class:`CedulaResult`
        :raises NodeUnavailableError: if the node is unreachable
        :raises VerificationError: if the lookup fails
        """
        data = await self._get("/verify/cedula", params={"numero": numero, "fechaNac": fecha_nac})
        return CedulaResult(
            vigente=bool(data.get("vigente", False)),
            status=str(data.get("status", "UNKNOWN")),
            numero=str(data.get("numero", numero)),
            raw=data,
        )

    async def network_stats(self) -> NetworkStats:
        """
        Retrieve live stats from the Soulprint network.

        :returns: :class:`NetworkStats`
        """
        data = await self._get("/stats")
        return NetworkStats(
            active_nodes=int(data.get("active_nodes", 0)),
            verified_identities=int(data.get("verified_identities", data.get("total_verified", 0))),
            raw=data,
        )

    async def info(self) -> NodeInfo:
        """
        Get metadata about the connected validator node.

        :returns: :class:`NodeInfo`
        """
        data = await self._get("/info")
        return NodeInfo(
            node_did=data.get("node_did", ""),
            version=data.get("version", ""),
            network=data.get("network", ""),
            known_peers=int(data.get("known_peers", 0)),
            capabilities=list(data.get("capabilities", [])),
            raw=data,
        )
