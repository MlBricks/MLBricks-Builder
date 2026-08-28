from __future__ import annotations
import html
import json
from pathlib import Path
import uuid
import threading
import time

from .graph import new_project, primitive_catalog, tinystories_30m_project
from .runtime import get_mlbricks_info
from .api_registry import discover_mlbricks_api
from .runner import execute_data_pipeline, validate_data_pipeline, PipelineValidationError, PipelineStopped

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
        self._run_thread = None
        self._stop_event = threading.Event()
        self._bridge_widgets = None
        self.last_data_result = None
        self.last_run_error = None

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

    def validate_data_pipeline(self):
        """Return (ordered_nodes, errors) for the current Data Processing graph."""
        return validate_data_pipeline(self.state)

    def run_data_pipeline(self, progress_callback=None):
        """Execute the current Data Processing graph in Python."""
        self._stop_event.clear()
        self.last_run_error = None
        try:
            self.last_data_result = execute_data_pipeline(
                self.state,
                progress_callback=progress_callback,
                stop_event=self._stop_event,
            )
            return self.last_data_result
        except Exception as exc:
            self.last_run_error = exc
            raise

    def stop(self):
        """Request that the current pipeline stop after the active step."""
        self._stop_event.set()

    def _publish_bridge_progress(self, payload):
        widgets = self._bridge_widgets or {}
        progress = widgets.get("progress")
        if progress is None:
            return
        enriched = dict(payload)
        enriched["ts"] = time.time()
        try:
            progress.value = json.dumps(enriched)
        except Exception:
            pass

    def _start_bridge_run(self):
        if self._run_thread is not None and self._run_thread.is_alive():
            self._publish_bridge_progress({
                "status": "running",
                "message": "A pipeline run is already active.",
                "overall": 0,
                "nodes": {},
            })
            return

        widgets = self._bridge_widgets or {}
        state_widget = widgets.get("state")
        if state_widget is not None:
            try:
                incoming = json.loads(state_widget.value)
                if isinstance(incoming, dict) and incoming.get("components"):
                    self.state = incoming
            except Exception as exc:
                self._publish_bridge_progress({
                    "status": "error",
                    "message": f"Could not read Builder state: {exc}",
                    "overall": 0,
                    "nodes": {},
                })
                return

        self._stop_event.clear()
        self.last_run_error = None

        def worker():
            try:
                self.last_data_result = execute_data_pipeline(
                    self.state,
                    progress_callback=self._publish_bridge_progress,
                    stop_event=self._stop_event,
                )
            except PipelineStopped:
                pass
            except Exception as exc:
                self.last_run_error = exc

        self._run_thread = threading.Thread(
            target=worker,
            name=f"mlbricks-builder-run-{self._instance_id}",
            daemon=True,
        )
        self._run_thread.start()

    def _setup_widget_bridge(self):
        """Create a bridge using only standard ipywidgets (no custom frontend module)."""
        try:
            import ipywidgets as widgets
        except Exception:
            return None

        suffix = self._instance_id.replace("-", "_")
        hidden = widgets.Layout(
            width="3px",
            height="3px",
            min_width="3px",
            min_height="3px",
            visibility="hidden",
            overflow="hidden",
        )
        state_widget = widgets.Textarea(value=json.dumps(self.state), layout=hidden)
        run_widget = widgets.Button(description="", layout=hidden)
        stop_widget = widgets.Button(description="", layout=hidden)
        progress_widget = widgets.Textarea(
            value=json.dumps({"status": "idle", "message": "Ready", "overall": 0, "nodes": {}}),
            layout=hidden,
        )

        classes = {
            "state": f"mlb-state-bridge-{suffix}",
            "run": f"mlb-run-bridge-{suffix}",
            "stop": f"mlb-stop-bridge-{suffix}",
            "progress": f"mlb-progress-bridge-{suffix}",
        }
        state_widget.add_class(classes["state"])
        run_widget.add_class(classes["run"])
        stop_widget.add_class(classes["stop"])
        progress_widget.add_class(classes["progress"])

        run_widget.on_click(lambda _: self._start_bridge_run())
        stop_widget.on_click(lambda _: self.stop())

        self._bridge_widgets = {
            "state": state_widget,
            "run": run_widget,
            "stop": stop_widget,
            "progress": progress_widget,
            "classes": classes,
        }
        return self._bridge_widgets

    def diagnostics(self):
        info = get_mlbricks_info()
        available = [k for k, v in self.mlbricks_api.items() if v.get("available")]
        unavailable = {k: v.get("error") for k, v in self.mlbricks_api.items() if not v.get("available")}
        return {
            "builder_version": "0.5.3",
            "frontend_version": "0.5.3",
            "mlbricks": info,
            "api_components_available": available,
            "api_components_unavailable": unavailable,
        }

    def mlbricks_info(self):
        return get_mlbricks_info()

    def _html(self, bridge=None):
        css = (_STATIC / "builder.css").read_text(encoding="utf-8")
        js = (_STATIC / "builder.js").read_text(encoding="utf-8")
        payload = json.dumps({
            "state": self.state,
            "catalog": self.catalog,
            "mlbricks_api": self.mlbricks_api,
            "bridge": bridge,
        }).replace("</", "<\\/")
        return f"""
<style>{css}</style>
<div id="{html.escape(self._instance_id)}" class="mlb-root" data-mlbricks-builder-version="0.5.3"></div>
<script>
try {{ delete window.MLBricksBuilder; }} catch (e) {{ window.MLBricksBuilder = undefined; }}
{js}
window.MLBricksBuilder.mount(
  document.getElementById({json.dumps(self._instance_id)}),
  {payload}
);
</script>
"""

    def _repr_html_(self):
        # Plain-HTML fallback. Editing works; Python execution uses
        # run_data_pipeline() when a standard-widget bridge is unavailable.
        return self._html(bridge=None)

    def _ipython_display_(self):
        """Display the Builder plus a standard-ipywidgets Python execution bridge."""
        from IPython.display import HTML, display

        bridge_widgets = self._setup_widget_bridge()
        bridge_payload = None

        if bridge_widgets:
            # The widgets are intentionally visually hidden. They provide standard
            # Jupyter comms so the custom HTML Run/Stop controls can talk to Python
            # without requiring AnyWidget or a custom JavaScript extension.
            box = None
            try:
                import ipywidgets as widgets
                box = widgets.HBox([
                    bridge_widgets["state"],
                    bridge_widgets["run"],
                    bridge_widgets["stop"],
                    bridge_widgets["progress"],
                ], layout=widgets.Layout(
                    width="3px",
                    height="3px",
                    min_height="3px",
                    max_height="3px",
                    overflow="hidden",
                    visibility="hidden",
                    margin="0",
                    padding="0",
                ))
                display(box)
                bridge_payload = dict(bridge_widgets["classes"])
            except Exception:
                bridge_payload = None

        display(HTML(self._html(bridge=bridge_payload)))


BuilderWidget = Builder
