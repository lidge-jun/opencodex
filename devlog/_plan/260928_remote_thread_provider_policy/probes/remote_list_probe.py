"""Offline research probe; NOT an installed OpenCodex feature or production proxy.

Based on openai/codex commit 1cc7e2361237ce7244430ee1d581c77f95c57ac8.
Only changes omitted thread/list.modelProviders in explicit opt-in mode.
No network, authentication, filesystem, database, or rollout writes occur here.
Complete multi-segment messages need a separate bounded streaming reassembler;
this probe deliberately passes those messages through unchanged.
"""
from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Policy:
    enabled: bool = False
    # An empty tuple explicitly requests all providers, matching modelProviders: [].
    providers: tuple[str, ...] = ("openai", "opencodex")
    max_wire_bytes: int = 150 * 1024

    def __post_init__(self) -> None:
        if not isinstance(self.providers, tuple) or any(
            not isinstance(p, str) or not p.strip() for p in self.providers
        ):
            raise ValueError("providers must be a tuple of non-empty strings")
        if len(set(self.providers)) != len(self.providers):
            raise ValueError("duplicate provider identifiers")
        if self.max_wire_bytes < 64:
            raise ValueError("max_wire_bytes must be at least 64")


@dataclass(frozen=True)
class Outcome:
    text: str
    changed: bool
    reason: str


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON member")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError("non-standard JSON constant")


def decode(text: str | bytes) -> Any:
    return json.loads(text, object_pairs_hook=_unique_object,
                      parse_constant=_reject_constant)


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False)


def _patch_message(message: Any, policy: Policy) -> tuple[bool, str]:
    if not isinstance(message, dict) or message.get("method") != "thread/list":
        return False, "not_thread_list"
    request_id = message.get("id")
    if isinstance(request_id, bool) or not isinstance(request_id, (int, str)):
        return False, "not_request"
    if "result" in message or "error" in message:
        return False, "ambiguous_request"
    params = message.get("params", {})
    if not isinstance(params, dict):
        return False, "non_object_params"
    # Preserve explicit client choices, including an explicit null.
    if "modelProviders" in params:
        return False, "explicit_filter_preserved"
    # Native related-thread queries deliberately bypass the omitted-provider default.
    if params.get("parentThreadId") is not None or params.get("ancestorThreadId") is not None:
        return False, "relation_query_preserved"
    params["modelProviders"] = list(policy.providers)
    message["params"] = params
    return True, "omitted_filter_patched"


def rewrite_backend_frame(text: str, policy: Policy) -> Outcome:
    """Process ONE backend-to-host text frame. No authentication decision is made.

    The caller must already enforce the authorized connection and user opt-in.
    Unmodified and unsupported messages are returned byte-for-byte unchanged.
    """
    if not isinstance(text, str):
        raise TypeError("text frame must be str")
    if not policy.enabled:
        return Outcome(text, False, "disabled")
    try:
        if len(text.encode("utf-8")) > policy.max_wire_bytes:
            return Outcome(text, False, "input_size_limit")
        envelope = decode(text)
        if not isinstance(envelope, dict):
            return Outcome(text, False, "not_envelope")
        if not isinstance(envelope.get("client_id"), str) or not envelope["client_id"]:
            return Outcome(text, False, "missing_client_id")
        kind = envelope.get("type")
        if kind == "client_message":
            changed, reason = _patch_message(envelope.get("message"), policy)
        elif kind == "client_message_chunk":
            if type(envelope.get("segment_count")) is not int or type(envelope.get("segment_id")) is not int:
                return Outcome(text, False, "invalid_segment_index")
            if envelope["segment_count"] != 1 or envelope["segment_id"] != 0:
                return Outcome(text, False, "multi_segment_not_implemented")
            size = envelope.get("message_size_bytes")
            if type(size) is not int or size < 0 or size > policy.max_wire_bytes:
                return Outcome(text, False, "invalid_segment_size")
            payload_b64 = envelope.get("message_chunk_base64")
            if not isinstance(payload_b64, str):
                return Outcome(text, False, "invalid_segment_payload")
            payload = base64.b64decode(payload_b64, validate=True)
            if len(payload) != size:
                return Outcome(text, False, "segment_length_mismatch")
            message = decode(payload)
            changed, reason = _patch_message(message, policy)
            if changed:
                encoded_payload = encode(message).encode("utf-8")
                envelope["message_size_bytes"] = len(encoded_payload)
                envelope["message_chunk_base64"] = base64.b64encode(encoded_payload).decode("ascii")
        else:
            return Outcome(text, False, "unrelated_envelope")
        if not changed:
            return Outcome(text, False, reason)
        output = encode(envelope)
        if len(output.encode("utf-8")) > policy.max_wire_bytes:
            return Outcome(text, False, "output_size_limit")
        return Outcome(output, True, reason)
    except (ValueError, TypeError, UnicodeError, binascii.Error, RecursionError):
        return Outcome(text, False, "invalid_frame_preserved")


def make_envelope(message: dict[str, Any], *, chunk: bool = False) -> dict[str, Any]:
    """Synthetic fixture builder; all identifiers below are test-only."""
    envelope: dict[str, Any] = {
        "client_id": "mock-client", "stream_id": "mock-stream",
        "seq_id": 7, "cursor": "mock-backend-cursor",
    }
    if chunk:
        payload = encode(message).encode("utf-8")
        envelope.update(type="client_message_chunk", segment_id=0, segment_count=1,
                        message_size_bytes=len(payload),
                        message_chunk_base64=base64.b64encode(payload).decode("ascii"))
    else:
        envelope.update(type="client_message", message=message)
    return envelope


def extract_message(envelope: dict[str, Any]) -> dict[str, Any]:
    if envelope["type"] == "client_message":
        return envelope["message"]
    return decode(base64.b64decode(envelope["message_chunk_base64"], validate=True))
