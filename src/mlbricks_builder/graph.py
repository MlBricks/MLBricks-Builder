from __future__ import annotations

from datetime import datetime, timezone
import uuid


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def primitive_catalog():
    return [
        {
            "type": "text_input",
            "builder_utility": True,
            "builder_python_api": False,
            "name": "Text Input",
            "icon": "TXT",
            "category": "Inputs",
            "description": "Prompt text or a prepared dataset entering the model",
            "accent": "green",
            "api": [
                {"key": "input_mode", "label": "Input Source", "type": "select", "value": "prompt",
                 "options": ["prompt", "prepared_dataset"]},
                {"key": "prompt", "label": "Prompt / Text", "type": "textarea", "value": "Once upon a time",
                 "show_when": {"input_mode": "prompt"}},
                {"key": "dataset_id", "label": "Available Dataset", "type": "dataset_select", "value": "",
                 "show_when": {"input_mode": "prepared_dataset"}},
                {"key": "dataset_split", "label": "Use Split", "type": "dataset_split_select", "value": "train",
                 "show_when": {"input_mode": "prepared_dataset"}}
            ],
        },
        {
            "type": "image_input",
            "builder_utility": True,
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
            "builder_utility": True,
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
            "type": "hf_dataset",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Hugging Face Dataset",
            "icon": "HF",
            "category": "Data Source",
            "description": "Load a dataset from Hugging Face Hub",
            "accent": "cyan",
            "api": [
                {"key": "dataset_id", "label": "Dataset ID", "type": "text", "value": "roneneldan/TinyStories"},
                {"key": "config", "label": "Config", "type": "text", "value": ""},
                {"key": "split", "label": "Hub Source Split", "type": "text", "value": "train", "help": "Which split is downloaded from Hugging Face. Use the Train / Validation / Test Split step for percentages."},
                {"key": "text_column", "label": "Text Column", "type": "text", "value": "text"},
                {"key": "streaming", "label": "Streaming", "type": "select", "value": "false", "options": ["false", "true"]},
                {"key": "max_rows", "label": "Max Rows (0 = All)", "type": "number", "value": 0}
            ],
        },
        {
            "type": "kaggle_dataset",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Kaggle Dataset",
            "icon": "KG",
            "category": "Data Source",
            "description": "Download a Kaggle dataset with kagglehub",
            "accent": "blue",
            "api": [
                {"key": "dataset_handle", "label": "Dataset Handle", "type": "text", "value": "owner/dataset-name"},
                {"key": "file_pattern", "label": "File Pattern", "type": "text", "value": "*.csv"},
                {"key": "format", "label": "Format", "type": "select", "value": "auto", "options": ["auto", "txt", "csv", "json", "jsonl", "parquet"]},
                {"key": "text_column", "label": "Text Column", "type": "text", "value": "text"},
                {"key": "max_rows", "label": "Max Rows (0 = All)", "type": "number", "value": 0}
            ],
        },
        {
            "type": "url_dataset",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "URL Dataset",
            "icon": "URL",
            "category": "Data Source",
            "description": "Load text data from any HTTP(S) file link",
            "accent": "green",
            "api": [
                {"key": "url", "label": "Dataset URL", "type": "text", "value": "https://example.com/data.txt"},
                {"key": "format", "label": "Format", "type": "select", "value": "auto", "options": ["auto", "txt", "csv", "json", "jsonl", "parquet"]},
                {"key": "text_column", "label": "Text Column", "type": "text", "value": "text"},
                {"key": "max_rows", "label": "Max Rows (0 = All)", "type": "number", "value": 0}
            ],
        },
        {
            "type": "local_dataset",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Local Dataset",
            "icon": "FILE",
            "category": "Data Source",
            "description": "Load a file already available in the notebook",
            "accent": "green",
            "api": [
                {"key": "path", "label": "Path", "type": "text", "value": "."},
                {"key": "format", "label": "Format", "type": "select", "value": "auto", "options": ["auto", "txt", "csv", "json", "jsonl", "parquet"]},
                {"key": "text_column", "label": "Text Column", "type": "text", "value": "text"},
                {"key": "max_rows", "label": "Max Rows (0 = All)", "type": "number", "value": 0}
            ],
        },
        {
            "type": "text_process",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Text Processing",
            "icon": "TXT+",
            "category": "Text",
            "description": "Clean and normalize dataset text",
            "accent": "orange",
            "api": [
                {"key": "text_column", "label": "Text Column", "type": "text", "value": "text"},
                {"key": "lowercase", "label": "Lowercase", "type": "select", "value": "false", "options": ["false", "true"]},
                {"key": "strip", "label": "Strip Spaces", "type": "select", "value": "true", "options": ["false", "true"]},
                {"key": "normalize_whitespace", "label": "Normalize Whitespace", "type": "select", "value": "true", "options": ["false", "true"]},
                {"key": "unicode_nfkc", "label": "Unicode NFKC", "type": "select", "value": "true", "options": ["false", "true"]},
                {"key": "remove_empty", "label": "Remove Empty", "type": "select", "value": "true", "options": ["false", "true"]},
                {"key": "min_chars", "label": "Min Characters", "type": "number", "value": 1},
                {"key": "max_chars", "label": "Max Characters (0 = All)", "type": "number", "value": 0}
            ],
        },
        {
            "type": "train_test_split",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Train / Validation / Test Split",
            "icon": "SPLT",
            "category": "Splitting",
            "description": "Choose exactly how much data is used for train, validation and test",
            "accent": "purple",
            "api": [
                {"key": "train_size", "label": "Training", "type": "percent", "value": 90, "min": 0, "max": 100, "step": 1,
                 "help": "Percentage used to train the model."},
                {"key": "validation_size", "label": "Validation", "type": "percent", "value": 5, "min": 0, "max": 100, "step": 1,
                 "help": "Percentage used to check the model during training."},
                {"key": "test_size", "label": "Testing", "type": "percent", "value": 5, "min": 0, "max": 100, "step": 1,
                 "help": "Percentage kept for final evaluation."},
                {"key": "seed", "label": "Random Seed", "type": "number", "value": 42,
                 "help": "Use the same seed to reproduce the same split."},
                {"key": "shuffle", "label": "Shuffle Before Split", "type": "select", "value": "true", "options": ["true", "false"],
                 "help": "Mix examples before dividing them."}
            ],
        },
        {
            "type": "tokenize_text",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Tokenize Text",
            "icon": "TOK",
            "category": "Text",
            "description": "Tokenize text before model training",
            "accent": "blue",
            "api": [
                {"key": "tokenizer_name", "label": "Tokenizer", "type": "text", "value": "gpt2"},
                {"key": "text_column", "label": "Text Column", "type": "text", "value": "text"},
                {"key": "context_length", "label": "Context Length", "type": "number", "value": 512},
                {"key": "truncation", "label": "Truncation", "type": "select", "value": "true", "options": ["false", "true"]},
                {"key": "padding", "label": "Padding", "type": "select", "value": "false", "options": ["false", "true", "max_length"]},
                {"key": "add_special_tokens", "label": "Add Special Tokens", "type": "select", "value": "true", "options": ["false", "true"]}
            ],
        },
        {
            "type": "manual_dataset",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Manual Text Data",
            "icon": "TXT",
            "category": "Data Source",
            "description": "Paste a small text dataset directly",
            "accent": "green",
            "api": [
                {"key": "text", "label": "Text Data", "type": "textarea", "value": "Once upon a time"},
                {"key": "text_column", "label": "Column Name", "type": "text", "value": "text"},
                {"key": "one_line_per_sample", "label": "One Line = One Sample", "type": "select", "value": "true", "options": ["true", "false"]}
            ],
        },
        {
            "type": "image_process",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Image Processing",
            "icon": "IMG+",
            "category": "Image",
            "description": "Resize, crop and prepare image examples",
            "accent": "orange",
            "api": [
                {"key": "image_column", "label": "Image Column", "type": "text", "value": "image"},
                {"key": "width", "label": "Width", "type": "number", "value": 224},
                {"key": "height", "label": "Height", "type": "number", "value": 224},
                {"key": "mode", "label": "Color Mode", "type": "select", "value": "RGB", "options": ["RGB", "L"]},
                {"key": "center_crop", "label": "Center Crop", "type": "select", "value": "false", "options": ["false", "true"]}
            ],
        },
        {
            "type": "audio_process",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Audio Processing",
            "icon": "AUD+",
            "category": "Audio",
            "description": "Resample, normalize and trim audio examples",
            "accent": "orange",
            "api": [
                {"key": "audio_column", "label": "Audio Column", "type": "text", "value": "audio"},
                {"key": "sample_rate", "label": "Sample Rate", "type": "number", "value": 16000},
                {"key": "normalize", "label": "Normalize", "type": "select", "value": "true", "options": ["true", "false"]},
                {"key": "trim_silence", "label": "Trim Silence", "type": "select", "value": "false", "options": ["false", "true"]},
                {"key": "silence_threshold", "label": "Silence Threshold", "type": "number", "value": 0.01}
            ],
        },
        {
            "type": "batch_data",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Batch / DataLoader",
            "icon": "BTC",
            "category": "Dataset",
            "description": "Create training batches from prepared data",
            "accent": "blue",
            "api": [
                {"key": "batch_size", "label": "Batch Size", "type": "number", "value": 16},
                {"key": "shuffle", "label": "Shuffle", "type": "select", "value": "true", "options": ["true", "false"]},
                {"key": "num_workers", "label": "Workers", "type": "number", "value": 2},
                {"key": "drop_last", "label": "Drop Last", "type": "select", "value": "false", "options": ["false", "true"]}
            ],
        },
        {
            "type": "prepared_dataset",
            "builder_utility": True,
            "builder_python_api": True,
            "name": "Prepared Dataset",
            "icon": "DATA",
            "category": "Output",
            "description": "Register final processed data for use by models",
            "accent": "green",
            "api": [
                {"key": "dataset_name", "label": "Dataset Name", "type": "text", "value": "Prepared Dataset",
                 "help": "Use different names to keep multiple prepared datasets."},
                {"key": "save_to_disk", "label": "Save To Disk", "type": "select", "value": "false", "options": ["false", "true"]},
                {"key": "path", "label": "Save Path", "type": "text", "value": "mlbricks/data/prepared_dataset"}
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
            "builder_utility": True,
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

        {"type":"elasticbit","name":"ElasticBit","icon":"EB","category":"Advanced","description":"MLBricks quantization interface","accent":"blue","api":[]},
        {"type":"elastic_linear","name":"ElasticLinear","icon":"EL","category":"Advanced","description":"Packed ElasticBit linear layer","accent":"blue","api":[]},
        {"type":"elastic_embedding","name":"ElasticEmbedding","icon":"EE","category":"Advanced","description":"Packed ElasticBit embedding","accent":"blue","api":[]},
        {"type":"rope","name":"RoPE","icon":"RP","category":"Position","description":"Rotary position transform","accent":"purple","api":[]},
        {"type":"learned_position","name":"Learned Position","icon":"LP","category":"Position","description":"Learned positional embedding","accent":"purple","api":[]},
        {"type":"sinusoidal_position","name":"Sinusoidal Position","icon":"SP","category":"Position","description":"Sinusoidal positional encoding","accent":"purple","api":[]},
        {"type":"brick","name":"Brick","icon":"BR","category":"Advanced","description":"Composable MLBricks layer container","accent":"cyan","api":[],"library_hidden":True},
        {"type":"bricks_model","name":"Bricks Model","icon":"BM","category":"Advanced","description":"Complete MLBricks model container","accent":"cyan","api":[],"library_hidden":True},
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
            "builder_utility": True,
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
            "builder_utility": True,
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
            "builder_utility": True,
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


def _default_data_processing_graph():
    """Beginner-ready, executable text pipeline shown in every new project."""
    source = _node("hf_dataset", "Hugging Face Dataset", {
        "dataset_id": "roneneldan/TinyStories",
        "config": "",
        "split": "train",
        "text_column": "text",
        "streaming": "false",
        "max_rows": 10000,
    })
    clean = _node("text_process", "Text Processing", {
        "text_column": "text",
        "lowercase": "false",
        "strip": "true",
        "normalize_whitespace": "true",
        "unicode_nfkc": "true",
        "remove_empty": "true",
        "min_chars": 1,
        "max_chars": 0,
    })
    split = _node("train_test_split", "Train / Validation / Test Split", {
        "train_size": 90,
        "validation_size": 5,
        "test_size": 5,
        "seed": 42,
        "shuffle": "true",
    })
    tokenize = _node("tokenize_text", "Tokenize Text", {
        "tokenizer_name": "gpt2",
        "text_column": "text",
        "context_length": 512,
        "truncation": "true",
        "padding": "false",
        "add_special_tokens": "true",
    })
    output = _node("prepared_dataset", "Prepared Dataset", {
        "dataset_name": "TinyStories Prepared",
        "save_to_disk": "false",
        "path": "mlbricks/data/prepared_dataset",
    })
    nodes = [source, clean, split, tokenize, output]
    edges = [
        _edge(left["id"], right["id"], "main_out", "main_in", "main")
        for left, right in zip(nodes[:-1], nodes[1:])
    ]
    return nodes, edges


def new_project(name: str = "Untitled Model"):
    root_id = _id("component")
    data_root_id = _id("component")
    data_nodes, data_edges = _default_data_processing_graph()
    now = datetime.now(timezone.utc).isoformat()
    return {
        "format": "mlbricks-builder",
        "format_version": "0.7.27",
        "project": {
            "name": name,
            "created_at": now,
            "updated_at": now,
            "context_length": 512,
            "batch_size": 16,
            "model_settings": {
                "embedding_size": 384,
                "heads": 6,
                "block": 512,
                "default_batch": 16,
                "vocab_size": 32000,
                "precision": "fp16",
            },
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
            },
            data_root_id: {
                "id": data_root_id,
                "name": "Data Processing",
                "kind": "data",
                "revision": 1,
                "nodes": data_nodes,
                "edges": data_edges,
            },
        },
        "workspaces": {
            "model": {
                "name": "Model Builder",
                "root_component_id": root_id,
                "view_component_id": root_id,
                "breadcrumbs": [{"id": root_id, "name": name}],
            },
            "data": {
                "name": "Data Processing",
                "root_component_id": data_root_id,
                "view_component_id": data_root_id,
                "breadcrumbs": [{"id": data_root_id, "name": "Data Processing"}],
            },
        },
        "active_workspace": "model",
        "prepared_datasets": [],
        "model_outputs": [],
        "project_files": [],
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
