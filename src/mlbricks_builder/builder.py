from __future__ import annotations
import html
import json
from pathlib import Path
import uuid

from .graph import new_project, primitive_catalog, tinystories_30m_project
from .runtime import get_mlbricks_info
from .api_registry import discover_mlbricks_api

_STATIC = Path(__file__).parent / "static"

class Builder:
    """
    Kaggle/Jupyter-safe Builder.

    This class intentionally does not inherit from AnyWidget or ipywidgets.
    Notebook rendering uses the standard `_repr_html_` protocol.
    """

    def __init__(self, project=None, preset=None):
        if project is not None:
            self.state = project
        elif preset in {"tinystories", "tinystories-30m", "demo"}:
            self.state = tinystories_30m_project()
        else:
            self.state = new_project()
        self.catalog = primitive_catalog()
        self.mlbricks_api = discover_mlbricks_api()
        for item in self.catalog:
            real = self.mlbricks_api.get(item.get("type"))
            if real:
                item["real_api"] = real
                item["api"] = real.get("parameters", item.get("api", []))
                if real.get("description"):
                    item["description"] = real["description"]
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

    def component_api(self, component_type=None):
        if component_type is None:
            return self.mlbricks_api
        return self.mlbricks_api.get(component_type)

    def diagnostics(self):
        info = get_mlbricks_info()
        available = [k for k, v in self.mlbricks_api.items() if v.get("available")]
        unavailable = {k: v.get("error") for k, v in self.mlbricks_api.items() if not v.get("available")}
        return {
            "builder_version": "0.5.1",
            "frontend_version": "0.5.1",
            "mlbricks": info,
            "api_components_available": available,
            "api_components_unavailable": unavailable,
        }

    def mlbricks_info(self):
        return get_mlbricks_info()

    def _repr_html_(self):
        css = (_STATIC / "builder.css").read_text(encoding="utf-8")
        js = (_STATIC / "builder.js").read_text(encoding="utf-8")
        payload = json.dumps({
            "state": self.state,
            "catalog": self.catalog,
            "mlbricks_api": self.mlbricks_api,
        }).replace("</", "<\\/")
        return f"""
<style>{css}</style>
<div id="{html.escape(self._instance_id)}" class="mlb-root" data-mlbricks-builder-version="0.5.1"></div>
<script>
/* IMPORTANT: Kaggle/Jupyter keeps browser globals alive even after Python
   package upgrades or kernel restarts. Remove any old renderer before
   evaluating this output so a v0.1/v0.2 renderer can never hijack v0.3.1. */
try {{ delete window.MLBricksBuilder; }} catch (e) {{ window.MLBricksBuilder = undefined; }}
{js}
window.MLBricksBuilder.mount(
  document.getElementById({json.dumps(self._instance_id)}),
  {payload}
);
</script>
"""

BuilderWidget = Builder
