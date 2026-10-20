"""Fingerprint-indexed codecs for schema rotation and artifact discovery."""

from __future__ import annotations

from typing import Any, Iterable

from ._codec import Codec


class CodecRegistry:
    """Codecs keyed by fingerprint.

    Rotation is why this exists: retraining a profile produces a new fingerprint, so a
    deployment holding only one codec per route turns every rollout into a cutover in
    which in-flight clients fall back to JSON. Holding the outgoing codec alongside the
    incoming one makes that a transition instead.
    """

    def __init__(self, codecs: Iterable[Codec[Any]] = ()) -> None:
        """Initialize the registry from codecs, replacing duplicate fingerprints."""
        self._by_fingerprint: dict[str, Codec[Any]] = {}
        for codec in codecs:
            self.add(codec)

    def add(self, codec: Codec[Any]) -> "CodecRegistry":
        """Register or replace a codec by fingerprint and return this registry."""
        self._by_fingerprint[codec.fingerprint] = codec
        return self

    def remove(self, fingerprint: str) -> bool:
        """Remove a fingerprint; return whether it was registered."""
        return self._by_fingerprint.pop(fingerprint, None) is not None

    def get(self, fingerprint: str) -> Codec[Any] | None:
        """Return the codec for a fingerprint, or None when it is unknown."""
        return self._by_fingerprint.get(fingerprint)

    def __contains__(self, fingerprint: object) -> bool:
        """Return whether a fingerprint is registered."""
        return fingerprint in self._by_fingerprint

    def __len__(self) -> int:
        """Return the number of registered fingerprints."""
        return len(self._by_fingerprint)

    @property
    def fingerprints(self) -> list[str]:
        """Registered fingerprints in insertion order, as an independent list."""
        return list(self._by_fingerprint)

    def artifact(self, fingerprint: str) -> str | None:
        """Return canonical artifact JSON for a fingerprint, or None if unknown."""
        codec = self._by_fingerprint.get(fingerprint)
        return codec.artifact if codec else None

    def select(self, accepted: Iterable[str]) -> Codec[Any] | None:
        """Return the first registered codec in client preference order, or None."""
        for fingerprint in accepted:
            codec = self._by_fingerprint.get(fingerprint)
            if codec is not None:
                return codec
        return None


__all__ = ["CodecRegistry"]
