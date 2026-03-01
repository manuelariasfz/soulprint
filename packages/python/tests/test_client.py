"""Tests for SoulprintClient."""

import pytest
import httpx
from unittest.mock import AsyncMock, patch, MagicMock

from soulprint import SoulprintClient
from soulprint.exceptions import NodeUnavailableError, VerificationError


NODE_URL = "https://soulprint-node-production.up.railway.app"


@pytest.fixture
def client():
    return SoulprintClient(node_url=NODE_URL)


# ── helpers ──────────────────────────────────────────────────────────────────

def mock_response(data: dict, status_code: int = 200):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json.return_value = data
    resp.text = str(data)
    return resp


# ── info ─────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_info(client):
    payload = {
        "node_did": "did:key:z6Mk...",
        "version": "0.6.1",
        "network": "base-sepolia",
        "known_peers": 3,
        "capabilities": ["zk-verify"],
    }
    with patch.object(client, "_get", new=AsyncMock(return_value=payload)):
        info = await client.info()
    assert info.version == "0.6.1"
    assert info.known_peers == 3
    assert "zk-verify" in info.capabilities


# ── verify ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_verify_human(client):
    payload = {
        "is_human": True,
        "score": 92,
        "node_did": "did:key:z6Mk...",
        "verified_at": "2026-01-01T00:00:00Z",
    }
    with patch.object(client, "_get", new=AsyncMock(return_value=payload)):
        result = await client.verify("did:soulprint:0xabc")
    assert result.is_human is True
    assert result.score == 92


@pytest.mark.asyncio
async def test_verify_not_human(client):
    payload = {"is_human": False, "score": 20, "node_did": "did:key:z6Mk..."}
    with patch.object(client, "_get", new=AsyncMock(return_value=payload)):
        result = await client.verify("did:soulprint:0xabc")
    assert result.is_human is False


# ── verify_cedula ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_verify_cedula_vigente(client):
    payload = {"vigente": True, "status": "VIGENTE", "numero": "1234567890"}
    with patch.object(client, "_get", new=AsyncMock(return_value=payload)):
        result = await client.verify_cedula("1234567890", "1990-01-15")
    assert result.vigente is True
    assert result.status == "VIGENTE"


@pytest.mark.asyncio
async def test_verify_cedula_not_vigente(client):
    payload = {"vigente": False, "status": "NO_VIGENTE", "numero": "9999999999"}
    with patch.object(client, "_get", new=AsyncMock(return_value=payload)):
        result = await client.verify_cedula("9999999999", "1980-05-20")
    assert result.vigente is False


# ── network_stats ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_network_stats(client):
    payload = {"active_nodes": 4, "verified_identities": 123}
    with patch.object(client, "_get", new=AsyncMock(return_value=payload)):
        stats = await client.network_stats()
    assert stats.active_nodes == 4
    assert stats.verified_identities == 123


# ── error handling ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_node_unreachable(client):
    async def raise_connect(*args, **kwargs):
        raise httpx.ConnectError("refused")

    with patch("httpx.AsyncClient.get", new=AsyncMock(side_effect=httpx.ConnectError("refused"))):
        with pytest.raises(NodeUnavailableError):
            await client.info()


@pytest.mark.asyncio
async def test_server_error_raises(client):
    with patch.object(
        client,
        "_get",
        new=AsyncMock(side_effect=VerificationError("500 error", status_code=500)),
    ):
        with pytest.raises(VerificationError):
            await client.info()
