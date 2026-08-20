from __future__ import annotations

from typing import Iterable

from ._codec import Codec


class CodecRegistry:
    """Codecs keyed by fingerprint.

    Rotation is why this exists: retraining a profile produces a new fingerprint, so a
    deployment holding only one codec per route turns every rollout into a cutover in
    which in-flight clients fall back to JSON. Holding the outgoing codec alongside the
    incoming one makes that a transition instead.
    """

    def __init__(self, codecs: Iterable[Codec] = ()) -> None:
        self._by_fingerprint: dict[str, Codec] = {}
        for codec in codecs:
            self.add(codec)

    def add(self, codec: Codec) -> "CodecRegistry":
        self._by_fingerprint[codec.fingerprint] = codec
        return self

    def remove(self, fingerprint: str) -> bool:
        return self._by_fingerprint.pop(fingerprint, None) is not None

    def get(self, fingerprint: str) -> Codec | None:
        return self._by_fingerprint.get(fingerprint)

    def __contains__(self, fingerprint: object) -> bool:
        return fingerprint in self._by_fingerprint

    def __len__(self) -> int:
        return len(self._by_fingerprint)

    @property
    def fingerprints(self) -> list[str]:
        return list(self._by_fingerprint)

    def artifact(self, fingerprint: str) -> str | None:
        codec = self._by_fingerprint.get(fingerprint)
        return codec.artifact if codec else None

    def select(self, accepted: Iterable[str]) -> Codec | None:
        """The client's preference wins, which is what lets it migrate itself."""
        for fingerprint in accepted:
            codec = self._by_fingerprint.get(fingerprint)
            if codec is not None:
                return codec
        return None
