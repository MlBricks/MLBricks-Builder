from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import uuid


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def primitive_catalog() -> list[dict]:
    return [
        {"type": "input", "name": "Input", "icon": "IN"},
        {"type": "embedding", "name": "Embedding", "icon": "EM"},
        {"type": "esa", "name": "ESA", "icon": "ES"},
        {"type": "vesa", "name": "VESA", "icon": "VE"},
        {"type": "saffn", "name": "SAFFN", "icon": "SF"},
        {"type": "ffn", "name": "FFN", "icon": "FF"},
        {"type": "rmsnorm", "name": "RMSNorm", "icon": "RN"},
        {"type": "residual", "name": "Residual", "icon": "RS"},
        {"type": "bolt", "name": "BOLT", "icon": "BO"},
        {"type": "visualbolt", "name": "VisualBOLT", "icon": "VB"},
        {"type": "lm_head", "name": "LM Head", "icon": "LM"},
        {"type": "output", "name": "Output", "icon": "OUT"},
    ]


def new_node(type_: str, name: str, *, definition_id: str | None = None) -> dict:
    return {
        "id": _id("node"),
        "type": type_,
        "name": name,
        "definition_id": definition_id,
        "repeat": 1,
        "params": {},
        "children": [],
        "connections": [],
    }


def new_project(name: str = "Untitled Model") -> dict:
    root_id = _id("component")
    now = datetime.now(timezone.utc).isoformat()
    return {
        "format": "mlbricks-builder",
        "format_version": "0.1",
        "project": {
            "name": name,
            "created_at": now,
            "updated_at": now,
        },
        "root_component_id": root_id,
        "components": {
            root_id: {
                "id": root_id,
                "name": name,
                "kind": "model",
                "revision": 1,
                "nodes": [],
            }
        },
        "custom_components": {},
        "view_component_id": root_id,
        "breadcrumbs": [{"id": root_id, "name": name}],
        "selection": [],
    }


def clone_project(project: dict) -> dict:
    return deepcopy(project)
