from __future__ import annotations

import importlib
import importlib.metadata
from dataclasses import dataclass


@dataclass
class MLBricksInfo:
    installed: bool
    version: str | None
    module_path: str | None


def get_mlbricks_info() -> MLBricksInfo:
    try:
        module = importlib.import_module("mlbricks")
    except Exception:
        return MLBricksInfo(False, None, None)

    try:
        version = importlib.metadata.version("mlbricks")
    except Exception:
        version = getattr(module, "__version__", None)

    return MLBricksInfo(
        True,
        version,
        getattr(module, "__file__", None),
    )


class MLBricksRuntimeAdapter:
    """
    Runtime boundary between MLBricks Builder and the separately installed
    MLBricks package.

    The Builder never vendors MLBricks implementation code. Component
    compilers can be registered against this adapter as the MLBricks public
    Python API stabilizes/evolves.
    """

    def __init__(self) -> None:
        info = get_mlbricks_info()
        if not info.installed:
            raise RuntimeError(
                "MLBricks is not installed. Install the Builder with pip so "
                "the GitHub MLBricks dependency is installed automatically."
            )
        self.mlbricks = importlib.import_module("mlbricks")

    def compile(self, project: dict):
        raise NotImplementedError(
            "Graph-to-MLBricks compilation adapters are intentionally separate "
            "from the UI. Add adapters for the public APIs exposed by the current "
            "MLBricks package instead of copying MLBricks code into Builder."
        )
