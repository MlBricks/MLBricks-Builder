from __future__ import annotations

import importlib
import inspect
from typing import Any


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
    "brick": ("mlbricks", "Brick"),
    "bricks_model": ("mlbricks", "Bricks"),
    "visionbolt": ("mlbricks", "VisionBolt"),
    "elasticbit": ("mlbricks", "ElasticBit"),
    "elastic_linear": ("mlbricks", "ElasticLinear"),
    "elastic_embedding": ("mlbricks", "ElasticEmbedding"),
    "rope": ("mlbricks", "RoPE"),
    "learned_position": ("mlbricks", "LearnedPosition"),
    "sinusoidal_position": ("mlbricks", "SinusoidalPosition"),
}

# Vesa and VisionBolt expose config=None, **kwargs. Their real tunable API
# is defined by these exported config classes, so inspect those as well.
CONFIG_BACKED = {
    "vesa": ("mlbricks", "VesaConfig"),
    "visionbolt": ("mlbricks", "VisionBoltConfig"),
}

CHOICES = {
    "backend": ["auto", "native", "pytorch"],
    "precision": ["fp32", "fp16", "bf16"],
    "device": ["auto", "cpu", "cuda"],
    "activation": ["gelu", "gelu_tanh", "relu", "silu", "swish", "tanh"],
    "position": ["none", "auto", "rope", "learned", "sinusoidal"],
    "norm": ["rmsnorm", "layernorm"],
    "ffn": ["standard", "state_aware", "virtual_state_aware", "micro_virtual"],
    "residual": ["standard", "controller"],
    "engine": ["Serpentine", "ViT", "CNN"],
    "scan": ["cross", "raster", "serpentine"],
}


def _safe_default(value: Any):
    if value is inspect._empty:
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _field_type(name: str, annotation: Any, default: Any) -> str:
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


def _signature_fields(obj) -> tuple[inspect.Signature, list[dict]]:
    sig = inspect.signature(obj)
    fields = []
    for name, param in sig.parameters.items():
        if name in {"self", "args", "kwargs"}:
            continue
        default = _safe_default(param.default)
        field = {
            "key": name,
            "label": name.replace("_", " ").title(),
            "type": _field_type(name, param.annotation, default),
            "required": param.default is inspect._empty,
            "value": default,
            "annotation": "" if param.annotation is inspect._empty else str(param.annotation),
        }
        if name in CHOICES:
            field["options"] = CHOICES[name]
        fields.append(field)
    return sig, fields


def discover_mlbricks_api() -> dict[str, dict]:
    """Discover the API from the installed MLBricks package at runtime."""
    result: dict[str, dict] = {}

    for component_type, (module_name, public_name) in PUBLIC_COMPONENTS.items():
        try:
            module = importlib.import_module(module_name)
            obj = getattr(module, public_name)
            sig, fields = _signature_fields(obj)

            config_info = None
            if component_type in CONFIG_BACKED:
                cfg_module_name, cfg_name = CONFIG_BACKED[component_type]
                cfg_module = importlib.import_module(cfg_module_name)
                cfg_obj = getattr(cfg_module, cfg_name)
                cfg_sig, cfg_fields = _signature_fields(cfg_obj)
                config_info = {
                    "public_name": cfg_name,
                    "signature": f"{cfg_name}{cfg_sig}",
                    "parameters": cfg_fields,
                }
                # For config-backed wrappers, use the real config fields as the UI API.
                fields = cfg_fields

            doc = inspect.getdoc(obj) or ""
            result[component_type] = {
                "available": True,
                "public_name": public_name,
                "import_path": f"{module_name}.{public_name}",
                "signature": f"{public_name}{sig}",
                "description": doc.splitlines()[0] if doc else "",
                "parameters": fields,
                "config_api": config_info,
            }
        except Exception as exc:
            result[component_type] = {
                "available": False,
                "public_name": public_name,
                "import_path": f"{module_name}.{public_name}",
                "parameters": [],
                "error": f"{type(exc).__name__}: {exc}",
            }

    return result
