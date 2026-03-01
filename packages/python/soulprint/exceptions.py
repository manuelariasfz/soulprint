"""Soulprint exceptions."""


class SoulprintError(Exception):
    """Base exception for all Soulprint errors."""

    def __init__(self, message: str, status_code: int = None):
        super().__init__(message)
        self.status_code = status_code


class UnauthorizedError(SoulprintError):
    """Raised when a request is not authorized (invalid/missing token)."""

    def __init__(self, message: str = "Unauthorized: invalid or missing Soulprint token"):
        super().__init__(message, status_code=401)


class NodeUnavailableError(SoulprintError):
    """Raised when the Soulprint validator node is unreachable."""

    def __init__(self, node_url: str):
        super().__init__(
            f"Soulprint validator node is unreachable: {node_url}. "
            "Check your network connection or try another node."
        )
        self.node_url = node_url


class VerificationError(SoulprintError):
    """Raised when verification fails for a specific reason."""
    pass
