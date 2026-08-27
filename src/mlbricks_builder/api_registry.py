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
}

CHOICES = {
    "backend": ["auto", "native", "pytorch"],
    "precision": ["fp32", "fp16", "bf16"],
    "device": ["auto", "cpu", "cuda"],
    "activation": ["gelu", "gelu_tanh", "relu", "silu", "swish", "tanh"],
    "position": ["none", "rope", "learned", "sinusoidal"],
    "norm": ["rmsnorm", "layernorm"],
}

def _safe_default(v: Any):
    if v is inspect._empty: return None
    if v is None or isinstance(v,(str,int,float,bool)): return v
    return str(v)

def _field_type(name, annotation, default):
    if name in CHOICES: return "select"
    if isinstance(default,bool): return "bool"
    if isinstance(default,(int,float)): return "number"
    text="" if annotation is inspect._empty else str(annotation).lower()
    if "bool" in text: return "bool"
    if "int" in text or "float" in text: return "number"
    return "text"

def discover_mlbricks_api():
    out={}
    for component_type,(module_name,public_name) in PUBLIC_COMPONENTS.items():
        try:
            module=importlib.import_module(module_name)
            obj=getattr(module,public_name)
            sig=inspect.signature(obj)
            params=[]
            for name,p in sig.parameters.items():
                if name in {"self","args","kwargs"}: continue
                default=_safe_default(p.default)
                f={
                    "key":name,
                    "label":name.replace("_"," ").title(),
                    "type":_field_type(name,p.annotation,default),
                    "required":p.default is inspect._empty,
                    "value":default,
                }
                if name in CHOICES: f["options"]=CHOICES[name]
                params.append(f)
            doc=inspect.getdoc(obj) or ""
            out[component_type]={
                "available":True,
                "public_name":public_name,
                "import_path":f"{module_name}.{public_name}",
                "signature":f"{public_name}{sig}",
                "description":doc.splitlines()[0] if doc else "",
                "parameters":params,
            }
        except Exception as exc:
            out[component_type]={"available":False,"public_name":public_name,"import_path":f"{module_name}.{public_name}","parameters":[],"error":str(exc)}
    return out
