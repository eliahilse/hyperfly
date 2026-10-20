from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    """Exclude repository ignore files that Hatchling otherwise force-includes."""

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        """Remove ignore files from the source distribution's forced inclusions."""
        inclusions = build_data["force_include"]
        for path in tuple(inclusions):
            if Path(path).name == ".gitignore":
                del inclusions[path]
