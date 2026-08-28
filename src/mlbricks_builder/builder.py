from __future__ import annotations
import html
import json
from pathlib import Path
import uuid
import threading
import time
from datetime import datetime, timezone
from collections.abc import Mapping

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
        # Actual Dataset/DatasetDict objects stay in Python memory. The serializable
        # metadata lives in state["prepared_datasets"] and is saved with the design.
        self.prepared_datasets = {}
        self.state.setdefault("prepared_datasets", [])

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

    def _prepared_output_node(self):
        workspaces = self.state.get("workspaces") or {}
        data_ws = workspaces.get("data") or {}
        component = (self.state.get("components") or {}).get(data_ws.get("root_component_id"), {})
        for node in component.get("nodes") or []:
            if node.get("type") == "prepared_dataset":
                return node
        return None

    @staticmethod
    def _split_summary(value):
        target = value
        # DataLoader-like objects expose their underlying dataset.
        if not hasattr(target, "column_names") and hasattr(target, "dataset"):
            target = target.dataset
        try:
            rows = len(target)
        except Exception:
            rows = None
        columns = list(getattr(target, "column_names", []) or [])
        return {"rows": rows, "columns": columns}

    def _summarize_prepared_result(self, result):
        # DatasetDict is mapping-like and also exposes column_names. Detecting
        # it as Mapping prevents the old "Train = 3" split-count bug.
        if isinstance(result, Mapping):
            splits = {
                str(name): self._split_summary(split)
                for name, split in result.items()
            }
        else:
            splits = {"train": self._split_summary(result)}

        total_rows = 0
        known_total = True
        for info in splits.values():
            rows = info.get("rows")
            if rows is None:
                known_total = False
            else:
                total_rows += int(rows)

        return {
            "splits": splits,
            "total_rows": total_rows if known_total else None,
            "default_split": "train" if "train" in splits else next(iter(splits), None),
        }

    def _data_pipeline_snapshot(self):
        """Snapshot source, processing, split and tokenizer settings."""
        workspaces = self.state.get("workspaces") or {}
        data_ws = workspaces.get("data") or {}
        component = (self.state.get("components") or {}).get(
            data_ws.get("root_component_id"), {}
        )
        snapshot = {
            "steps": [], "source": None, "text_processing": None,
            "split": None, "tokenizer": None, "image_processing": None,
            "audio_processing": None, "batch": None, "output": None,
        }
        source_types = {"manual_dataset", "hf_dataset", "kaggle_dataset", "url_dataset", "local_dataset"}
        for node in component.get("nodes") or []:
            params = json.loads(json.dumps(node.get("params") or {}))
            snapshot["steps"].append({"id":node.get("id"),"type":node.get("type"),"name":node.get("name"),"params":params})
            value = {"type":node.get("type"),"name":node.get("name"),**params}
            t=node.get("type")
            if t in source_types: snapshot["source"] = value
            elif t=="text_process": snapshot["text_processing"] = value
            elif t=="train_test_split": snapshot["split"] = value
            elif t=="tokenize_text": snapshot["tokenizer"] = value
            elif t=="image_process": snapshot["image_processing"] = value
            elif t=="audio_process": snapshot["audio_processing"] = value
            elif t=="batch_data": snapshot["batch"] = value
            elif t=="prepared_dataset": snapshot["output"] = value
        return snapshot

    def _register_prepared_dataset(self, result):
        node = self._prepared_output_node() or {}
        params = node.get("params") or {}
        requested_name = str(params.get("dataset_name") or "Prepared Dataset").strip() or "Prepared Dataset"

        existing_meta = None
        for item in self.state.setdefault("prepared_datasets", []):
            if str(item.get("name", "")).strip().lower() == requested_name.lower():
                existing_meta = item
                break

        dataset_id = (
            existing_meta.get("id")
            if existing_meta
            else f"dataset_{uuid.uuid4().hex[:12]}"
        )

        summary = self._summarize_prepared_result(result)
        save_to_disk = str(params.get("save_to_disk", "false")).lower() == "true"
        path = str(params.get("path") or "") if save_to_disk else None

        metadata = {
            "id": dataset_id,
            "name": requested_name,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "output_node_id": node.get("id"),
            "storage": "disk+memory" if save_to_disk else "memory",
            "path": path,
            "pipeline": self._data_pipeline_snapshot(),
            **summary,
        }

        registry = self.state.setdefault("prepared_datasets", [])
        if existing_meta:
            index = registry.index(existing_meta)
            registry[index] = metadata
        else:
            registry.append(metadata)

        self.prepared_datasets[dataset_id] = result
        self.state.setdefault("project", {})["dataset"] = requested_name
        return metadata

    def available_datasets(self):
        """Return serializable metadata for every prepared dataset in this project."""
        return json.loads(json.dumps(self.state.get("prepared_datasets") or []))

    def get_prepared_dataset(self, dataset_id_or_name, split=None):
        """Return a prepared Dataset/DatasetDict by registry id or display name."""
        wanted = str(dataset_id_or_name)
        metadata = None
        for item in self.state.get("prepared_datasets") or []:
            if item.get("id") == wanted or str(item.get("name", "")).lower() == wanted.lower():
                metadata = item
                break
        if metadata is None:
            raise KeyError(f"Prepared dataset not found: {dataset_id_or_name!r}")

        dataset_id = metadata["id"]
        result = self.prepared_datasets.get(dataset_id)

        if result is None and metadata.get("path"):
            try:
                from datasets import load_from_disk
                result = load_from_disk(metadata["path"])
                self.prepared_datasets[dataset_id] = result
            except Exception as exc:
                raise RuntimeError(
                    f'{metadata["name"]!r} is not in memory and could not be loaded '
                    f'from {metadata.get("path")!r}: {exc}'
                ) from exc

        if result is None:
            raise RuntimeError(
                f'{metadata["name"]!r} is listed in the design but its actual data is '
                "not in this Python session. Re-run its Data Processing pipeline, or "
                "enable Save To Disk before saving the design."
            )

        if split:
            try:
                return result[split]
            except Exception as exc:
                available = list((metadata.get("splits") or {}).keys())
                raise KeyError(
                    f"Split {split!r} is unavailable. Available splits: {available}"
                ) from exc
        return result

    def validate_data_pipeline(self):
        """Return (ordered_nodes, errors) for the current Data Processing graph."""
        return validate_data_pipeline(self.state)

    def run_data_pipeline(self, progress_callback=None):
        """Execute Data Processing, register the result, and publish split metadata."""
        self._stop_event.clear()
        self.last_run_error = None
        last_progress = {}

        def relay(payload):
            last_progress.clear()
            last_progress.update(payload or {})
            if progress_callback:
                progress_callback(payload)

        try:
            self.last_data_result = execute_data_pipeline(
                self.state,
                progress_callback=relay,
                stop_event=self._stop_event,
            )
            metadata = self._register_prepared_dataset(self.last_data_result)

            final_payload = dict(last_progress or {})
            final_payload.update({
                "status": "done",
                "overall": 100,
                "message": f'Data ready: {metadata["name"]}',
                "prepared_dataset": metadata,
                "available_datasets": self.available_datasets(),
            })
            if progress_callback:
                progress_callback(final_payload)

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
                self.last_data_result = self.run_data_pipeline(
                    progress_callback=self._publish_bridge_progress,
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
            "builder_version": "0.5.6",
            "frontend_version": "0.5.6",
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
<div id="{html.escape(self._instance_id)}" class="mlb-root" data-mlbricks-builder-version="0.5.6"></div>
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
