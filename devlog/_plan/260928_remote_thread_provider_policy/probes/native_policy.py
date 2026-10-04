"""Executable specification for a PROPOSED native Codex policy, not an integration.

No socket, authentication, config, history, or rollout access. The real Rust
implementation must obtain origin from its authenticated server-side connection,
not from JSON, clientInfo.name, or an HTTP header. This enum only models that input.
None as the result means no provider predicate, not no results.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from uuid import UUID
import re

# Rust's Uuid::parse_str accepts exactly four textual shapes - hyphenated, simple,
# braced-hyphenated and the urn:uuid prefix. Python's UUID() is looser: it tolerates
# arbitrary hyphen placement inside a 32-hex payload, so wrapper/hyphen variants
# must be rejected by shape before parsing instead of leaning on the constructor.
_UUID_ACCEPTED_SHAPES = re.compile(
    r"(?:"
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    r"|[0-9a-fA-F]{32}"
    r"|\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}"
    r"|urn:uuid:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    r")\Z"
)


class ConnectionOrigin(Enum):
    STDIO = "stdio"
    WEBSOCKET = "websocket"
    IN_PROCESS = "in_process"
    REMOTE_CONTROL = "remote_control"


def _validate_ids(value: tuple[str, ...], label: str) -> None:
    if not isinstance(value, tuple):
        raise ValueError(f"{label} must be a tuple")
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise ValueError(f"{label} must contain non-empty strings")
    if len(set(value)) != len(value):
        raise ValueError(f"{label} must not contain duplicate identifiers")


def _validate_thread_id(value: str, label: str) -> None:
    """Upstream parses ThreadId as a UUID; a non-UUID string must not widen the list."""
    if not isinstance(value, str) or not _UUID_ACCEPTED_SHAPES.match(value):
        raise ValueError(f"{label} must be a UUID thread id")
    try:
        UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise ValueError(f"{label} must be a UUID thread id")


@dataclass(frozen=True)
class RemoteListPolicy:
    # None: opt-out; (): explicitly all; non-empty: exactly these provider ids.
    providers: tuple[str, ...] | None = None

    def __post_init__(self) -> None:
        if self.providers is not None:
            _validate_ids(self.providers, "providers")


def resolve_provider_filter(
    *,
    origin: ConnectionOrigin,
    default_provider: str,
    requested: tuple[str, ...] | None = None,
    parent_thread_id: str | None = None,
    ancestor_thread_id: str | None = None,
    policy: RemoteListPolicy = RemoteListPolicy(),
) -> tuple[str, ...] | None:
    """Model precedence after typed request decoding and existing authorization.

    Rust Option<Vec<String>> decodes both omission and JSON null as None. They
    intentionally have the same semantics in this native-policy proposal. The
    separate raw-frame relay probe instead preserves every present JSON key.
    Empty requested tuple is an explicit client request for all providers.
    The policy applies only to thread/list; callers must not reuse it for resume.
    """
    if not isinstance(origin, ConnectionOrigin):
        raise ValueError("origin must be supplied by the trusted connection context")
    _validate_ids((default_provider,), "default_provider")
    for label, tid in (
        ("parent_thread_id", parent_thread_id),
        ("ancestor_thread_id", ancestor_thread_id),
    ):
        if tid is not None:
            _validate_thread_id(tid, label)
    if parent_thread_id is not None and ancestor_thread_id is not None:
        raise ValueError("parent_thread_id and ancestor_thread_id are mutually exclusive")
    if requested is not None:
        # Preserve every typed client array, including duplicate/empty ids.
        # Native Vec<String> accepts them; this proposal must not add rejection.
        if not isinstance(requested, tuple) or any(not isinstance(item, str) for item in requested):
            raise ValueError("requested must model a typed string array")
        return requested or None
    if parent_thread_id is not None or ancestor_thread_id is not None:
        return None
    if origin is ConnectionOrigin.REMOTE_CONTROL and policy.providers is not None:
        return policy.providers or None
    return (default_provider,)
