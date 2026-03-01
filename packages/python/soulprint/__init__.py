"""
soulprint-py — Python SDK for the Soulprint decentralized identity protocol.

Quick start::

    import asyncio
    from soulprint import SoulprintClient

    async def main():
        client = SoulprintClient()
        info = await client.info()
        print(f"Connected to node {info.node_did} ({info.version})")

    asyncio.run(main())
"""

from .client import SoulprintClient, VerifyResult, CedulaResult, NetworkStats, NodeInfo
from .exceptions import SoulprintError, UnauthorizedError, NodeUnavailableError, VerificationError

__version__ = "0.1.0"
__all__ = [
    "SoulprintClient",
    "VerifyResult",
    "CedulaResult",
    "NetworkStats",
    "NodeInfo",
    "SoulprintError",
    "UnauthorizedError",
    "NodeUnavailableError",
    "VerificationError",
]
