from __future__ import annotations

import importlib
import inspect
import json
from copy import deepcopy
from pathlib import Path
from typing import Any

_SCHEMA_PATH = Path(__file__).with_name("mlbricks_api_schema.json")

PUBLIC_COMPONENTS = {
    "embedding": ("mlbricks", "Embedding"),
    "esa": ("mlbricks", "ESA"),
    "bolt": ("mlbricks", "Bolt"),
    "vesa": ("mlbricks", "Vesa"),
    "ffn": ("mlbricks", "FFN"),
    "saffn": ("mlbricks", "StateAwareFFN"),
    "micro_ffn": ("mlbricks", "MicroVirtualFFN"),
    "virtual_saffn": ("mlbricks", "VirtualStateAwareFFN"),
    "rmsnorm": ("mlbricks", "RMSNorm"),
    "layernorm": ("mlbricks", "LayerNorm"),
    "residual": ("mlbricks", "Residual"),
    "rescontroller": ("mlbricks", "ResController"),
    "lm_head": ("mlbricks", "LMHead"),
    "visualbolt": ("mlbricks", "VisionBolt"),
    "elasticbit": ("mlbricks", "ElasticBit"),
    "elastic_linear": ("mlbricks", "ElasticLinear"),
    "elastic_embedding": ("mlbricks", "ElasticEmbedding"),
    "rope": ("mlbricks", "RoPE"),
    "learned_position": ("mlbricks", "LearnedPosition"),
    "sinusoidal_position": ("mlbricks", "SinusoidalPosition"),
    "brick": ("mlbricks", "Brick"),
    "bricks_model": ("mlbricks", "Bricks"),
}

CONFIG_BACKED = {
    "vesa": ("mlbricks", "VesaConfig"),
    "visualbolt": ("mlbricks", "VisionBoltConfig"),
}

CHOICES = {
    "backend": ["auto", "native", "pytorch"],
    "precision": ["fp32", "fp16", "bf16"],
    "activation": ["gelu", "gelu_tanh", "relu", "silu", "swish", "tanh"],
    "device": ["auto", "cpu", "cuda", "None"],
    "position": ["none", "auto", "learned", "sinusoidal", "rope"],
    "engine": ["Serpentine", "ViT", "CNN", "Diffusion", "AR"],
    "scan": ["cross", "raster", "serpentine"],
    "ffn": ["standard", "ffnbrick", "virtual_ffnbrick", "micro_ffnbrick"],
    "residual": ["standard", "rescontroller"],
    "norm": ["rmsnorm", "layernorm"],
}

def _fallback_schema():
    payload = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    return deepcopy(payload["components"])

def _safe_default(value: Any):
    if value is inspect._empty:
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)

def _field_type(name, annotation, default):
    if name in CHOICES:
        return "select"
    if isinstance(default, bool):
        return "bool"
    if isinstance(default, (int, float)):
        return "number"
    text = "" if annotation is inspect._empty else str(annotation).lower()
    if "bool" in text:
        return "bool"
    if "int" in text or "float" in text:
        return "number"
    return "text"

def _fields(obj):
    sig = inspect.signature(obj)
    out = []
    for name, p in sig.parameters.items():
        if name in {"self", "args", "kwargs"}:
            continue
        default = _safe_default(p.default)
        item = {
            "key": name,
            "label": name.replace("_", " ").title(),
            "type": _field_type(name, p.annotation, default),
            "required": p.default is inspect._empty,
            "value": default,
            "annotation": "" if p.annotation is inspect._empty else str(p.annotation),
        }
        if name in CHOICES:
            item["options"] = CHOICES[name]
        out.append(item)
    return sig, out

def discover_mlbricks_api():
    # Start from the schema generated directly from the supplied MLBricks source.
    # This means the UI works even if importing mlbricks fails because of a
    # native/runtime dependency in the notebook environment.
    result = _fallback_schema()

    for component_type, (module_name, public_name) in PUBLIC_COMPONENTS.items():
        fallback = result.get(component_type, {})
        try:
            module = importlib.import_module(module_name)
            obj = getattr(module, public_name)
            sig, fields = _fields(obj)

            config_info = fallback.get("config_api")
            if component_type in CONFIG_BACKED:
                cfg_mod, cfg_name = CONFIG_BACKED[component_type]
                cfg_obj = getattr(importlib.import_module(cfg_mod), cfg_name)
                cfg_sig, cfg_fields = _fields(cfg_obj)
                # If runtime inspection exposes the real dataclass fields use it.
                # If it only exposes config/**kwargs, preserve the source schema.
                if len(cfg_fields) > 1:
                    fields = cfg_fields
                    config_info = {
                        "public_name": cfg_name,
                        "signature": f"{cfg_name}{cfg_sig}",
                        "parameters": cfg_fields,
                    }

            doc = inspect.getdoc(obj) or ""
            result[component_type] = {
                **fallback,
                "available": True,
                "runtime_available": True,
                "source": "runtime inspection",
                "public_name": public_name,
                "import_path": f"{module_name}.{public_name}",
                "signature": f"{public_name}{sig}",
                "description": doc.splitlines()[0] if doc else fallback.get("description", ""),
                "parameters": fields if fields else fallback.get("parameters", []),
                "config_api": config_info,
                "runtime_error": None,
            }
        except Exception as exc:
            # API schema remains available from the exact supplied source.
            result[component_type] = {
                **fallback,
                "available": True,
                "runtime_available": False,
                "source": "MLBricks 1.0.0 source schema",
                "runtime_error": f"{type(exc).__name__}: {exc}",
            }

    return result
