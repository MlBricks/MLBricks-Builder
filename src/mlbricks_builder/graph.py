from __future__ import annotations

from datetime import datetime, timezone
import uuid


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def primitive_catalog():
    return [
        {
            "type": "text_input",
            "name": "Text Input",
            "icon": "TXT",
            "category": "Inputs",
            "description": "Enter text / prompt",
            "accent": "green",
            "api": [
                {"key": "prompt", "label": "Prompt", "type": "text", "value": "Once upon a time"},
            ],
        },
        {
            "type": "image_input",
            "name": "Image Input",
            "icon": "IMG",
            "category": "Inputs",
            "description": "Image / vision",
            "accent": "green",
            "api": [
                {"key": "channels", "label": "Channels", "type": "number", "value": 3},
                {"key": "image_size", "label": "Image Size", "type": "number", "value": 224},
            ],
        },
        {
            "type": "audio_input",
            "name": "Audio Input",
            "icon": "AUD",
            "category": "Inputs",
            "description": "Audio / speech",
            "accent": "green",
            "api": [
                {"key": "sample_rate", "label": "Sample Rate", "type": "number", "value": 16000},
            ],
        },
        {
            "type": "embedding",
            "name": "Embedding",
            "icon": "EMB",
            "category": "Core Blocks",
            "description": "Token embedding",
            "accent": "blue",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "vocab_size", "label": "Vocab Size", "type": "number", "value": 32000},
                {"key": "dtype", "label": "DType", "type": "select", "value": "float16",
                 "options": ["float32", "float16", "bfloat16"]},
                {"key": "device", "label": "Device", "type": "select", "value": "auto",
                 "options": ["auto", "cpu", "cuda"]},
            ],
        },
        {
            "type": "esa",
            "name": "ESA",
            "icon": "ESA",
            "category": "Core Blocks",
            "description": "Entangled State Attention",
            "accent": "purple",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "state_dim", "label": "State Dim", "type": "number", "value": 192},
                {"key": "heads", "label": "Heads", "type": "number", "value": 6},
                {"key": "chunk_size", "label": "Chunk Size", "type": "number", "value": 16},
                {"key": "kernel", "label": "Kernel", "type": "select", "value": "auto",
                 "options": ["auto", "native", "pytorch"]},
                {"key": "dtype", "label": "DType", "type": "select", "value": "float16",
                 "options": ["float32", "float16", "bfloat16"]},
                {"key": "device", "label": "Device", "type": "select", "value": "auto",
                 "options": ["auto", "cpu", "cuda"]},
            ],
        },
        {
            "type": "vesa",
            "name": "VESA",
            "icon": "VES",
            "category": "Core Blocks",
            "description": "Visual ESA",
            "accent": "lime",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "heads", "label": "Heads", "type": "number", "value": 6},
                {"key": "kernel", "label": "Kernel", "type": "select", "value": "auto",
                 "options": ["auto", "native", "pytorch"]},
            ],
        },
        {
            "type": "rmsnorm",
            "name": "RMSNorm",
            "icon": "RMS",
            "category": "Core Blocks",
            "description": "RMS normalization",
            "accent": "orange",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "eps", "label": "Epsilon", "type": "number", "value": 0.00001},
            ],
        },
        {
            "type": "ffn",
            "name": "FFN Brick",
            "icon": "FFN",
            "category": "Core Blocks",
            "description": "Feed Forward Network",
            "accent": "pink",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "ffn_dim", "label": "FFN Hidden Dim", "type": "number", "value": 1536},
                {"key": "activation", "label": "Activation", "type": "select", "value": "silu",
                 "options": ["silu", "gelu", "relu"]},
                {"key": "dropout", "label": "Dropout", "type": "number", "value": 0.1},
                {"key": "bias", "label": "Use Bias", "type": "select", "value": "true",
                 "options": ["true", "false"]},
            ],
        },
        {
            "type": "saffn",
            "name": "SAFFN",
            "icon": "SAF",
            "category": "Core Blocks",
            "description": "State-Aware FFN",
            "accent": "pink",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "ffn_dim", "label": "FFN Hidden Dim", "type": "number", "value": 1536},
                {"key": "activation", "label": "Activation", "type": "select", "value": "silu",
                 "options": ["silu", "gelu", "relu"]},
            ],
        },
        {
            "type": "residual",
            "name": "Residual Add",
            "icon": "ADD",
            "category": "Core Blocks",
            "description": "Add residual connection",
            "accent": "cyan",
            "inputs": ["main", "skip"],
            "api": [
                {"key": "enabled", "label": "Use Residual", "type": "select", "value": "true",
                 "options": ["true", "false"]},
                {"key": "scale", "label": "Scaling", "type": "number", "value": 1.0},
                {"key": "pre_norm", "label": "Pre-Norm", "type": "select", "value": "RMSNorm",
                 "options": ["None", "RMSNorm", "LayerNorm"]},
            ],
        },
        {
            "type": "dropout",
            "name": "Dropout",
            "icon": "DRP",
            "category": "Core Blocks",
            "description": "Dropout layer",
            "accent": "purple",
            "api": [
                {"key": "p", "label": "Probability", "type": "number", "value": 0.1},
            ],
        },
        {
            "type": "bolt",
            "name": "BOLT",
            "icon": "BLT",
            "category": "Core Blocks",
            "description": "BOLT block",
            "accent": "blue",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "kernel", "label": "Kernel", "type": "select", "value": "auto",
                 "options": ["auto", "native", "pytorch"]},
            ],
        },
        {
            "type": "visualbolt",
            "name": "VisualBOLT",
            "icon": "VBL",
            "category": "Core Blocks",
            "description": "Visual BOLT block",
            "accent": "cyan",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "kernel", "label": "Kernel", "type": "select", "value": "auto",
                 "options": ["auto", "native", "pytorch"]},
            ],
        },
        {"type":"layernorm","name":"LayerNorm","icon":"LN","category":"Core Blocks","description":"MLBricks LayerNorm","accent":"orange","api":[]},
        {"type":"rescontroller","name":"ResController","icon":"RSC","category":"Core Blocks","description":"Adaptive residual controller","accent":"cyan","api":[]},
        {"type":"micro_ffn","name":"MicroVirtualFFN","icon":"MVF","category":"Core Blocks","description":"Micro virtual FFN","accent":"pink","api":[]},
        {"type":"virtual_saffn","name":"VirtualStateAwareFFN","icon":"VSF","category":"Core Blocks","description":"Virtual state-aware FFN","accent":"pink","api":[]},
        {
            "type": "lm_head",
            "name": "LM Head",
            "icon": "LM",
            "category": "Heads",
            "description": "Language Modeling Head",
            "accent": "purple",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "vocab_size", "label": "Vocab Size", "type": "number", "value": 32000},
                {"key": "bias", "label": "Use Bias", "type": "select", "value": "false",
                 "options": ["true", "false"]},
            ],
        },
        {
            "type": "classifier",
            "name": "Classifier Head",
            "icon": "CLS",
            "category": "Heads",
            "description": "Classification head",
            "accent": "orange",
            "api": [
                {"key": "dim", "label": "Hidden Dim", "type": "number", "value": 384},
                {"key": "classes", "label": "Classes", "type": "number", "value": 10},
            ],
        },
        {
            "type": "text_output",
            "name": "Text Output",
            "icon": "OUT",
            "category": "Outputs",
            "description": "Generate / decode",
            "accent": "green",
            "api": [
                {"key": "max_new_tokens", "label": "Max New Tokens", "type": "number", "value": 64},
                {"key": "temperature", "label": "Temperature", "type": "number", "value": 0.8},
                {"key": "top_p", "label": "Top P", "type": "number", "value": 0.95},
            ],
        },
        {
            "type": "logits_output",
            "name": "Logits Output",
            "icon": "LOG",
            "category": "Outputs",
            "description": "Logits / scores",
            "accent": "blue",
            "api": [],
        },
    ]


def _node(type_, name, params=None, *, definition_id=None, x=0, y=0):
    return {
        "id": _id("node"),
        "type": type_,
        "name": name,
        "definition_id": definition_id,
        "repeat": 1,
        "params": params or {},
        "position": {"x": x, "y": y},
    }


def _edge(source, target, source_port="out", target_port="in", kind="main"):
    return {
        "id": _id("edge"),
        "source": source,
        "target": target,
        "source_port": source_port,
        "target_port": target_port,
        "kind": kind,
    }


def new_project(name: str = "Untitled Model"):
    root_id = _id("component")
    now = datetime.now(timezone.utc).isoformat()
    return {
        "format": "mlbricks-builder",
        "format_version": "0.2",
        "project": {
            "name": name,
            "created_at": now,
            "updated_at": now,
            "context_length": 512,
            "batch_size": 16,
            "dataset": None,
            "estimated_parameters": None,
        },
        "root_component_id": root_id,
        "components": {
            root_id: {
                "id": root_id,
                "name": name,
                "kind": "model",
                "revision": 1,
                "nodes": [],
                "edges": [],
            }
        },
        "custom_components": {},
        "view_component_id": root_id,
        "breadcrumbs": [{"id": root_id, "name": name}],
        "auto_connect": True,
    }


def tinystories_30m_project():
    """
    Starter design for teaching and UI testing.

    The ~30M figure is an architecture target / UI estimate. Exact trainable
    parameters depend on the current installed MLBricks implementations,
    vocabulary choice, tied embeddings and runtime configuration.
    """
    project = new_project("TinyStories 30M Starter")
    project["project"].update({
        "context_length": 512,
        "batch_size": 16,
        "dataset": "TinyStories",
        "estimated_parameters": "~30M",
        "description": "6-layer beginner language-model starter",
    })

    root_id = project["root_component_id"]

    # Shared nested layer definition.
    layer_def_id = _id("custom")
    # These keys are the real MLBricks 1.0.0 constructor arguments.
    esa = _node("esa", "ESA", {
        "embd": 384,
        "head": 6,
        "batch": 16,
        "block": 512,
        "backend": "auto",
        "precision": "fp16",
        "compass": "auto",
        "dropout": 0.1,
        "gate_min": 0.8,
        "gate_max": 0.995,
        "eps": 1e-5,
        "device": "auto",
        "auto_compile": False,
        "compile_mode": "default",
        "auto_move_input": True,
        "strict_checks": False,
    })
    norm = _node("rmsnorm", "RMSNorm", {
        "normalized_shape": 384,
        "eps": 1e-6,
        "elementwise_affine": True,
        "device": None,
        "dtype": None,
    })
    ffn = _node("ffn", "FFN Brick", {
        "hidden_size": 384,
        "intermediate_size": 1536,
        "activation": "gelu",
        "dropout": 0.1,
        "bias": True,
        "gated": False,
        "device": None,
        "dtype": None,
    })
    residual = _node("residual", "Residual Add", {
        "dropout": 0.0,
    })

    project["custom_components"][layer_def_id] = {
        "id": layer_def_id,
        "name": "TinyStories ESA Block",
        "description": "ESA → RMSNorm → FFN → Residual",
        "revision": 1,
        "nodes": [esa, norm, ffn, residual],
        "edges": [
            _edge(esa["id"], norm["id"]),
            _edge(norm["id"], ffn["id"]),
            _edge(ffn["id"], residual["id"]),
            _edge(esa["id"], residual["id"], kind="residual"),
        ],
        "exposed_api": [
            {"source_node": esa["id"], "key": "embd", "label": "Embedding Dim"},
            {"source_node": esa["id"], "key": "head", "label": "ESA Heads"},
            {"source_node": ffn["id"], "key": "intermediate_size", "label": "FFN Hidden Dim"},
        ],
    }

    nodes = []
    text = _node("text_input", "Text Input", {"prompt": "Once upon a time"})
    emb = _node("embedding", "Embedding", {
        "vocab_size": 32000,
        "embedding_dim": 384,
    })
    nodes.extend([text, emb])

    for i in range(1, 7):
        nodes.append(_node(
            "custom",
            f"Layer {i}",
            {"embd": 384, "head": 6, "intermediate_size": 1536},
            definition_id=layer_def_id,
        ))

    head = _node("lm_head", "LM Head", {
        "hidden_size": 384,
        "vocab_size": 32000,
        "bias": False,
        "tie_to": None,
        "device": None,
        "dtype": None,
    })
    out = _node("text_output", "Text Output", {
        "max_new_tokens": 64, "temperature": 0.8, "top_p": 0.95
    })
    nodes.extend([head, out])

    edges = []
    for left, right in zip(nodes[:-1], nodes[1:]):
        edges.append(_edge(left["id"], right["id"]))

    project["components"][root_id]["nodes"] = nodes
    project["components"][root_id]["edges"] = edges
    return project
