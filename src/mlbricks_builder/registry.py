from __future__ import annotations

from copy import deepcopy
import uuid


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def create_custom_component(
    project: dict,
    *,
    name: str,
    nodes: list[dict],
    description: str = "",
) -> str:
    definition_id = _id("custom")
    project["custom_components"][definition_id] = {
        "id": definition_id,
        "name": name,
        "description": description,
        "revision": 1,
        "nodes": deepcopy(nodes),
    }
    return definition_id


def revise_custom_component(project: dict, definition_id: str, nodes: list[dict]) -> int:
    definition = project["custom_components"][definition_id]
    definition["revision"] = int(definition.get("revision", 1)) + 1
    definition["nodes"] = deepcopy(nodes)
    return definition["revision"]


def copy_custom_component(project: dict, definition_id: str, new_name: str) -> str:
    source = deepcopy(project["custom_components"][definition_id])
    new_id = _id("custom")
    source["id"] = new_id
    source["name"] = new_name
    source["revision"] = 1
    project["custom_components"][new_id] = source
    return new_id
