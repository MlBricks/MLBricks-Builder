from __future__ import annotations
import html
import json
from pathlib import Path
import uuid

from .graph import new_project, primitive_catalog
from .runtime import get_mlbricks_info

_STATIC = Path(__file__).parent / "static"

class Builder:
    """
    Kaggle/Jupyter-safe Builder.

    This class intentionally does not inherit from AnyWidget or ipywidgets.
    Notebook rendering uses the standard `_repr_html_` protocol.
    """

    def __init__(self, project=None):
        self.state = project or new_project()
        self.catalog = primitive_catalog()
        self._instance_id = f"mlb_{uuid.uuid4().hex}"

    def to_dict(self):
        return json.loads(json.dumps(self.state))

    def save(self, path):
        path = Path(path)
        if path.suffix != ".mlbricks":
            path = path.with_suffix(".mlbricks")
        path.write_text(json.dumps(self.state, indent=2), encoding="utf-8")
        return path

    def load(self, path):
        self.state = json.loads(Path(path).read_text(encoding="utf-8"))
        return self

    def mlbricks_info(self):
        return get_mlbricks_info()

    def _repr_html_(self):
        css = (_STATIC / "builder.css").read_text(encoding="utf-8")
        js = (_STATIC / "builder.js").read_text(encoding="utf-8")
        payload = json.dumps({
            "state": self.state,
            "catalog": self.catalog,
        }).replace("</", "<\\/")
        return f"""
<style>{css}</style>
<div id="{html.escape(self._instance_id)}" class="mlb-root"></div>
<script>
{js}
window.MLBricksBuilder.mount(
  document.getElementById({json.dumps(self._instance_id)}),
  {payload}
);
</script>
"""

BuilderWidget = Builder
