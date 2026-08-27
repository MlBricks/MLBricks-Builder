from __future__ import annotations

import json
from pathlib import Path

import anywidget
import traitlets

from .graph import new_project, primitive_catalog
from .runtime import get_mlbricks_info


_STATIC = Path(__file__).parent / "static"


class BuilderWidget(anywidget.AnyWidget):
    _esm = _STATIC / "builder.js"
    _css = _STATIC / "builder.css"

    state = traitlets.Dict().tag(sync=True)
    catalog = traitlets.List().tag(sync=True)

    def __init__(self, project: dict | None = None, **kwargs):
        super().__init__(**kwargs)
        self.state = project or new_project()
        self.catalog = primitive_catalog()

    def to_dict(self) -> dict:
        return json.loads(json.dumps(self.state))

    def save(self, path: str | Path) -> Path:
        path = Path(path)
        if path.suffix != ".mlbricks":
            path = path.with_suffix(".mlbricks")
        path.write_text(json.dumps(self.state, indent=2), encoding="utf-8")
        return path

    def load(self, path: str | Path):
        path = Path(path)
        self.state = json.loads(path.read_text(encoding="utf-8"))
        return self

    def mlbricks_info(self) -> dict:
        info = get_mlbricks_info()
        return {
            "installed": info.installed,
            "version": info.version,
            "module_path": info.module_path,
        }


Builder = BuilderWidget
