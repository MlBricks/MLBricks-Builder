from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
import json
import ast
import math
import copy
import random
import re
import time
from typing import Any, Callable

import torch
import torch.nn as nn
import torch.nn.functional as F


class ModelCompileError(RuntimeError):
    pass


class TrainingStopped(RuntimeError):
    pass


def _bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


def _none(v: Any):
    if v is None: return None
    if isinstance(v, str) and v.strip().lower() in {"", "none", "null"}: return None
    return v


def _literal_or_text(value: Any):
    """Parse JSON/Python literals from Builder text fields without eval()."""
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text:
        return None
    for loader in (json.loads, ast.literal_eval):
        try:
            return loader(text)
        except Exception:
            pass
    return text


def _scalar_or_sequence(value: Any, *, cast: Callable[[Any], Any], label: str):
    parsed = _literal_or_text(value)
    if isinstance(parsed, str) and "," in parsed:
        parsed = [part.strip() for part in parsed.split(",") if part.strip()]
    if isinstance(parsed, (list, tuple)):
        try:
            return [cast(item) for item in parsed]
        except Exception as exc:
            raise ValueError(f"{label} contains an invalid value: {parsed!r}") from exc
    try:
        return cast(parsed)
    except Exception as exc:
        raise ValueError(f"{label} is invalid: {value!r}") from exc


def _config_value(value: Any, *, label: str):
    parsed = _literal_or_text(value)
    if parsed is None:
        return None
    if isinstance(parsed, dict):
        return parsed
    if isinstance(parsed, (list, tuple)) and all(isinstance(item, dict) for item in parsed):
        return list(parsed)
    raise ValueError(f"{label} must be a JSON object or a list of JSON objects.")


def _missing_number(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def runtime_int(
    value: Any,
    default: int | None,
    label: str,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    """Convert runtime/UI values without leaking int(None) to the user."""
    if _missing_number(value):
        if default is None:
            raise ValueError(f"{label} is required.")
        value = default
    try:
        number = int(float(value))
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be a number; received {value!r}.") from exc
    if minimum is not None and number < minimum:
        raise ValueError(f"{label} must be at least {minimum}; received {number}.")
    if maximum is not None and number > maximum:
        raise ValueError(f"{label} must be at most {maximum}; received {number}.")
    return number


def runtime_float(
    value: Any,
    default: float | None,
    label: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    """Float counterpart to runtime_int with field-specific errors."""
    if _missing_number(value):
        if default is None:
            raise ValueError(f"{label} is required.")
        value = default
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be a number; received {value!r}.") from exc
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite; received {value!r}.")
    if minimum is not None and number < minimum:
        raise ValueError(f"{label} must be at least {minimum}; received {number}.")
    if maximum is not None and number > maximum:
        raise ValueError(f"{label} must be at most {maximum}; received {number}.")
    return number


def _safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "model")).strip("-.")
    return value or "model"


def resolve_device(requested: str | None) -> torch.device:
    value = str(requested or "auto").strip().lower()
    if value == "auto":
        if torch.cuda.is_available(): return torch.device("cuda:0")
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available(): return torch.device("mps")
        xpu = getattr(torch, "xpu", None)
        if xpu is not None and xpu.is_available(): return torch.device("xpu:0")
        return torch.device("cpu")
    device = torch.device(value)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError(f"{value} was selected but CUDA is unavailable.")
    return device


def resolve_precision(name: str | None, device: torch.device) -> tuple[str, torch.dtype | None]:
    value = str(name or "auto").strip().lower()
    if value == "auto":
        value = "fp16" if device.type == "cuda" else "fp32"
    mapping = {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16}
    if value not in mapping:
        raise ValueError(f"Unsupported precision: {name!r}")
    return value, mapping[value]


def _topological(nodes: list[dict], edges: list[dict]) -> list[dict]:
    by_id={n["id"]:n for n in nodes}
    incoming={n["id"]:0 for n in nodes}
    outgoing={n["id"]:[] for n in nodes}
    for e in edges:
        a,b=e.get("source"),e.get("target")
        if a in by_id and b in by_id:
            outgoing[a].append(b); incoming[b]+=1
    q=[n["id"] for n in nodes if incoming[n["id"]]==0]
    order=[]
    while q:
        nid=q.pop(0); order.append(by_id[nid])
        for nxt in outgoing[nid]:
            incoming[nxt]-=1
            if incoming[nxt]==0:q.append(nxt)
    if len(order)!=len(nodes): raise ModelCompileError("Graph contains a cycle.")
    return order


class _Identity(nn.Module):
    def forward(self,x): return x


class TensorGraph(nn.Module):
    """Small tensor DAG compiler for the model components Builder can execute today."""
    def __init__(self, *, nodes, edges, custom_components, runtime, vocab_override=None):
        super().__init__()
        self.nodes=deepcopy(nodes)
        self.edges=deepcopy(edges)
        self.custom_components=custom_components
        self.runtime=runtime
        self.vocab_override=vocab_override
        self.order=_topological(self.nodes,self.edges)
        self.by_id={n["id"]:n for n in self.nodes}
        self.in_main={n["id"]:[] for n in self.nodes}
        self.in_skip={n["id"]:[] for n in self.nodes}
        self.outgoing={n["id"]:[] for n in self.nodes}
        for e in self.edges:
            a,b=e.get("source"),e.get("target")
            if a not in self.by_id or b not in self.by_id: continue
            kind=str(e.get("kind") or "main").lower()
            if kind in {"residual","skip"}: self.in_skip[b].append(a)
            elif kind in {"main",""}: self.in_main[b].append(a)
            elif kind in {"aux","extra"}:
                raise ModelCompileError("Extra/Aux tensor lanes are not executable in the training compiler yet.")
            else: self.in_main[b].append(a)
            self.outgoing[a].append(b)
        self.mods=nn.ModuleDict()
        for node in self.nodes:
            mod=self._module_for(node)
            if mod is not None:self.mods[node["id"]]=mod
        self._apply_weight_tying()

    def _module_for(self,node):
        from mlbricks import (
            Embedding, LMHead, Linear, FFN, RMSNorm, LayerNorm, Residual, ESA, SOUP,
            LearnedPosition, SinusoidalPosition,
        )
        t=node.get("type"); p=deepcopy(node.get("params") or {})
        device=str(self.runtime.get("device") or "auto")
        backend=str(self.runtime.get("backend") or "pytorch")
        precision=str(self.runtime.get("precision") or "fp16")
        if precision=="auto": precision="fp16" if resolve_device(device).type=="cuda" else "fp32"
        if t in {"text_input","text_output","logits_output"}: return _Identity()
        if t=="embedding":
            vocab=int(self.vocab_override or p.get("vocab_size") or p.get("num_embeddings") or 32000)
            dim=int(p.get("embedding_dim") or p.get("hidden_size") or 384)
            return Embedding(vocab,dim)
        if t=="lm_head":
            vocab=int(self.vocab_override or p.get("vocab_size") or 32000)
            hidden=int(p.get("hidden_size") or p.get("dim") or 384)
            # ``tie_to`` is a module reference in the MLBricks Python API. Builder
            # resolves that reference after the graph modules have been created.
            return LMHead(hidden,vocab,bias=_bool(p.get("bias",False)))
        if t=="learned_position":
            return LearnedPosition(
                runtime_int(p.get("dim"),384,f"{node.get('name','Learned Position')} dim",minimum=1),
                runtime_int(p.get("max_seq_len"),65536,f"{node.get('name','Learned Position')} max sequence length",minimum=1),
            )
        if t=="sinusoidal_position":
            return SinusoidalPosition(
                runtime_int(p.get("dim"),384,f"{node.get('name','Sinusoidal Position')} dim",minimum=1),
                runtime_int(p.get("max_seq_len"),65536,f"{node.get('name','Sinusoidal Position')} max sequence length",minimum=1),
                base=runtime_float(p.get("base"),10000.0,f"{node.get('name','Sinusoidal Position')} base",minimum=1e-9),
            )
        if t=="esa":
            return ESA(
                embd=runtime_int(p.get("embd"),384,f"{node.get('name','ESA')} embedding size",minimum=1),
                head=runtime_int(p.get("head"),4,f"{node.get('name','ESA')} head count",minimum=1),
                batch=_none(p.get("batch")), block=_none(p.get("block")),
                backend=backend, precision=precision, compass=p.get("compass","auto"),
                dropout=runtime_float(p.get("dropout"),0.0,f"{node.get('name','ESA')} dropout",minimum=0.0),
                gate_min=runtime_float(p.get("gate_min"),0.8,f"{node.get('name','ESA')} gate min"),
                gate_max=runtime_float(p.get("gate_max"),0.995,f"{node.get('name','ESA')} gate max"),
                eps=runtime_float(p.get("eps"),1e-5,f"{node.get('name','ESA')} epsilon",minimum=0.0),
                device=device, auto_compile=False, auto_move_input=True,
                strict_checks=_bool(p.get("strict_checks",False)),
            )
        if t=="soup":
            depth = runtime_int(p.get("depth"), 2, f"{node.get('name','SOUP')} depth", minimum=1)
            width = _scalar_or_sequence(
                p.get("width", 1116), cast=int, label=f"{node.get('name','SOUP')} state width"
            )
            mixer = _scalar_or_sequence(
                p.get("mixer", "esa"), cast=lambda v: str(v).strip().lower(),
                label=f"{node.get('name','SOUP')} mixer",
            )
            ffn = _scalar_or_sequence(
                p.get("ffn", "saffn"), cast=lambda v: str(v).strip().lower(),
                label=f"{node.get('name','SOUP')} FFN",
            )
            return SOUP(
                dim=runtime_int(p.get("dim"), 512, f"{node.get('name','SOUP')} model dim", minimum=1),
                width=width,
                depth=depth,
                mixer=mixer,
                ffn=ffn,
                mixer_config=_config_value(p.get("mixer_config"), label=f"{node.get('name','SOUP')} mixer config"),
                ffn_config=_config_value(p.get("ffn_config"), label=f"{node.get('name','SOUP')} FFN config"),
                backend=backend,
                precision=precision,
                memory_dim=runtime_int(p.get("memory_dim"), 128, f"{node.get('name','SOUP')} memory dim", minimum=1),
                fusion_hidden=runtime_int(p.get("fusion_hidden"), 768, f"{node.get('name','SOUP')} fusion hidden", minimum=1),
            )
        if t=="rmsnorm":
            shape=p.get("normalized_shape",p.get("hidden_size",384))
            shape=runtime_int(shape,384,f"{node.get('name','RMSNorm')} normalized shape",minimum=1)
            return RMSNorm(shape,eps=runtime_float(p.get("eps"),1e-6,f"{node.get('name','RMSNorm')} epsilon",minimum=0.0),elementwise_affine=_bool(p.get("elementwise_affine",True)))
        if t=="layernorm":
            shape=p.get("normalized_shape",p.get("hidden_size",p.get("dim",384)))
            shape=runtime_int(shape,384,f"{node.get('name','LayerNorm')} normalized shape",minimum=1)
            return LayerNorm(shape,eps=runtime_float(p.get("eps"),1e-5,f"{node.get('name','LayerNorm')} epsilon",minimum=0.0),elementwise_affine=_bool(p.get("elementwise_affine",True)),bias=_bool(p.get("bias",True)))
        if t=="linear":
            return Linear(
                runtime_int(p.get("in_features"),384,f"{node.get('name','Linear')} input features",minimum=1),
                runtime_int(p.get("out_features"),384,f"{node.get('name','Linear')} output features",minimum=1),
                bias=_bool(p.get("bias",True)),
            )
        if t=="ffn":
            return FFN(
                runtime_int(p.get("hidden_size"),384,f"{node.get('name','FFN')} hidden size",minimum=1),
                runtime_int(
                    p.get("intermediate_size"),
                    4*runtime_int(p.get("hidden_size"),384,f"{node.get('name','FFN')} hidden size",minimum=1),
                    f"{node.get('name','FFN')} intermediate size",minimum=1,
                ),
                activation=p.get("activation") or "gelu",
                dropout=runtime_float(p.get("dropout"),0.0,f"{node.get('name','FFN')} dropout",minimum=0.0),
                bias=_bool(p.get("bias",True)), gated=_bool(p.get("gated",False)),
            )
        if t=="residual": return Residual(dropout=runtime_float(p.get("dropout"),0.0,f"{node.get('name','Residual')} dropout",minimum=0.0))
        if t=="dropout":
            probability=p.get("p") if p.get("p") is not None else p.get("dropout")
            return nn.Dropout(runtime_float(probability,0.1,f"{node.get('name','Dropout')} probability",minimum=0.0,maximum=1.0))
        if t=="custom":
            did=node.get("definition_id"); definition=deepcopy(self.custom_components.get(did) or {})
            if not definition: raise ModelCompileError(f"Custom component definition not found for {node.get('name')}.")
            by_id={n["id"]:n for n in definition.get("nodes") or []}
            for exposed in definition.get("exposed_api") or []:
                key=exposed.get("key"); sid=exposed.get("source_node")
                if key in p and sid in by_id: by_id[sid].setdefault("params",{})[key]=p[key]
            return TensorGraph(nodes=list(by_id.values()),edges=definition.get("edges") or [],custom_components=self.custom_components,runtime=self.runtime,vocab_override=self.vocab_override)
        # Not silently faking execution for unsupported advanced blocks.
        raise ModelCompileError(
            f"Training compiler does not yet support component {node.get('name')!r} ({t}). "
            "Supported today: Text Input/Output, Embedding, Learned/Sinusoidal Position, ESA, SOUP, "
            "RMSNorm, LayerNorm, Linear, FFN, Residual, Dropout, LM Head and nested custom components made from them. "
            "ElasticBit 4–32 is a post-training/inference runtime component, not a differentiable training layer."
        )

    def _nearest_upstream_embedding(self, node_id, expected_shape):
        queue=list(self.in_main.get(node_id,[]))+list(self.in_skip.get(node_id,[]))
        seen=set()
        while queue:
            current=queue.pop(0)
            if current in seen:
                continue
            seen.add(current)
            node=self.by_id.get(current) or {}
            if node.get("type")=="embedding" and current in self.mods:
                weight=getattr(self.mods[current],"weight",None)
                if weight is not None and tuple(weight.shape)==tuple(expected_shape):
                    return self.mods[current]
            queue.extend(self.in_main.get(current,[]))
            queue.extend(self.in_skip.get(current,[]))
        return None

    def _apply_weight_tying(self):
        """Resolve Builder LM-head tying to the nearest compatible embedding.

        MLBricks exposes ``LMHead(..., tie_to=<Embedding>)``. A visual graph
        cannot serialize a live module reference, so Builder stores the
        equivalent ``tie_embeddings`` flag and resolves the module here.
        """
        for node in self.nodes:
            if node.get("type")!="lm_head" or node.get("id") not in self.mods:
                continue
            p=node.get("params") or {}
            explicit=p.get("tie_embeddings")
            if explicit is None:
                tie_to=p.get("tie_to")
                enabled=tie_to not in {None,"","none","None","null"}
            else:
                enabled=_bool(explicit)
            if not enabled:
                continue
            head=self.mods[node["id"]]
            expected=(getattr(head,"vocab_size",head.out_features),getattr(head,"hidden_size",head.in_features))
            embedding=self._nearest_upstream_embedding(node["id"],expected)
            if embedding is None:
                raise ModelCompileError(
                    f"{node.get('name','LM Head')} has weight tying enabled but no compatible upstream Embedding "
                    f"with weight shape {expected} was found."
                )
            head.tie_weights(embedding)

    def forward(self, graph_input):
        values={}
        for node in self.order:
            nid=node["id"]; t=node.get("type"); mod=self.mods[nid]
            main_sources=self.in_main[nid]; skip_sources=self.in_skip[nid]
            if main_sources:
                if len(main_sources)!=1: raise ModelCompileError(f"{node.get('name')} has {len(main_sources)} Main inputs; merge execution is not implemented.")
                x=values[main_sources[0]]
            else: x=graph_input
            if t=="residual":
                if len(skip_sources)!=1: raise ModelCompileError(f"Residual {node.get('name')} needs exactly one Skip input.")
                y=mod(values[skip_sources[0]],x)
            else:
                if skip_sources: raise ModelCompileError(f"{node.get('name')} has a Skip input but is not a Residual component.")
                y=mod(x)
                repeat=max(1,int(node.get("repeat") or 1))
                for _ in range(1,repeat): y=mod(y)
            values[nid]=y
        sinks=[n for n in self.order if not self.outgoing[n["id"]]]
        if not sinks: raise ModelCompileError("Graph has no output node.")
        if len(sinks)>1: raise ModelCompileError("Training compiler currently requires one tensor output.")
        return values[sinks[0]["id"]]


@dataclass
class CompiledModel:
    # ``model`` is the inference/evaluation model. ``training_model`` is a
    # loss-wrapped whole-model graph used only for training when requested.
    model: nn.Module
    raw_model: nn.Module
    training_model: nn.Module | None
    device: torch.device
    precision: str
    vocab_size: int
    parameter_count: int
    compile_used: bool
    compile_error: str | None


class _CausalLMTrainingGraph(nn.Module):
    """Whole language-model training graph including cross entropy.

    Keeping the loss inside this wrapper lets ``torch.compile`` capture the
    model + LM head + loss as one graph, matching the benchmark notebook rather
    than compiling only the logits-producing portion.
    """
    def __init__(self, model: nn.Module):
        super().__init__()
        self.model = model

    def forward(self, input_ids: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        logits = self.model(input_ids)
        return F.cross_entropy(
            logits.reshape(-1, logits.size(-1)),
            targets.reshape(-1),
            ignore_index=-100,
        )


def _root_model(state):
    ws=(state.get("workspaces") or {}).get("model") or {}
    root_id=ws.get("root_component_id") or state.get("root_component_id")
    comp=(state.get("components") or {}).get(root_id)
    if not comp: raise ModelCompileError("Model Builder graph was not found.")
    return comp


def _graph_vocab(model_graph):
    sizes=[]
    for n in model_graph.get("nodes") or []:
        p=n.get("params") or {}
        if n.get("type") in {"embedding","lm_head"} and p.get("vocab_size"):
            sizes.append(int(p["vocab_size"]))
    return max(sizes) if sizes else 0


def _tokenizer_for(meta, *, local_only_first=True):
    tok_cfg=((meta or {}).get("pipeline") or {}).get("tokenizer") or {}
    name=tok_cfg.get("tokenizer_name") or "gpt2"
    try:
        from transformers import AutoTokenizer
    except ImportError as exc:
        raise RuntimeError("Training/generation needs transformers. Install transformers in the notebook.") from exc
    errors=[]
    if local_only_first:
        try: tok=AutoTokenizer.from_pretrained(name,local_files_only=True)
        except Exception as exc: errors.append(exc); tok=None
    else: tok=None
    if tok is None:
        try: tok=AutoTokenizer.from_pretrained(name)
        except Exception as exc:
            detail=str(errors[-1]) if errors else ""
            raise RuntimeError(f"Tokenizer {name!r} is unavailable. {detail} {exc}") from exc
    if tok.pad_token_id is None:
        if tok.eos_token_id is not None: tok.pad_token=tok.eos_token
        elif tok.unk_token_id is not None: tok.pad_token=tok.unk_token
        else: tok.add_special_tokens({"pad_token":"<|pad|>"})
    return tok


def compile_builder_model(state, model_entry, dataset_meta, runtime, *, progress=None, for_training=False):
    """Build a Builder model against the current public MLBricks runtime.

    Training compilation wraps the *entire* causal-LM forward including loss
    and uses one ``torch.compile`` call with ``fullgraph=True`` and
    ``dynamic=False`` so the requested benchmark flags reach Dynamo unchanged. Inference/generation compilation remains shape-friendly
    and compiles only the model forward.
    """
    graph=copy.deepcopy((model_entry or {}).get("architecture") or _root_model(state))
    custom_components=copy.deepcopy(state.get("custom_components") or {})
    custom_components.update(
        copy.deepcopy((model_entry or {}).get("custom_components_snapshot") or {})
    )
    device=resolve_device(runtime.get("device","auto"))
    precision,dtype=resolve_precision(runtime.get("precision","fp16"),device)
    tokenizer=_tokenizer_for(dataset_meta)
    graph_vocab=_graph_vocab(graph)
    tokenizer_vocab=len(tokenizer)
    effective_vocab=max(graph_vocab,tokenizer_vocab)
    if progress:
        msg=f"Building model on {device}"
        if effective_vocab!=graph_vocab: msg+=f" · vocab {graph_vocab:,} → {effective_vocab:,} to match tokenizer"
        progress({"status":"running","runtime_kind":"train" if for_training else "generate","phase":"compile","overall":1,"message":msg})
    try:
        raw=TensorGraph(
            nodes=graph.get("nodes") or [],
            edges=graph.get("edges") or [],
            custom_components=custom_components,
            runtime={**runtime,"device":str(device),"precision":precision},
            vocab_override=effective_vocab,
        )
    except RuntimeError as exc:
        if str(runtime.get("backend") or "pytorch").lower()=="native" and "native extension is unavailable" in str(exc).lower():
            raise RuntimeError(
                "Backend 'native' is selected, but the optional MLBricks native extension is unavailable. "
                "Open Training Setup and set Backend to 'pytorch', or install/build the native MLBricks extension."
            ) from exc
        raise
    raw.to(device)
    params=sum(p.numel() for p in raw.parameters())
    inference_model=raw
    training_model=_CausalLMTrainingGraph(raw) if for_training else None
    compile_used=False
    compile_error=None

    if str(runtime.get("execution_mode","eager"))=="compiled":
        if not hasattr(torch,"compile"):
            raise RuntimeError("Compiled execution was selected, but torch.compile is unavailable in this PyTorch build.")
        mode=str(runtime.get("compile_mode") or "default")
        # TensorGraph and the training wrapper are ordinary nn.Modules. Use one
        # explicit torch.compile wrapper here so the requested mode/fullgraph/
        # dynamic flags are guaranteed to reach Dynamo exactly as configured.
        # (MLBricks' package-level compile API remains useful for models with
        # their own compile hook; Builder's visual TensorGraph has no such hook.)
        # No eager fallback: a compile failure is surfaced to the user.
        if for_training:
            training_model=torch.compile(
                training_model, mode=mode, dynamic=False, fullgraph=True
            )
        else:
            inference_model=torch.compile(
                raw, mode=mode, dynamic=None, fullgraph=False
            )
        compile_used=True

    return CompiledModel(
        inference_model,raw,training_model,device,precision,effective_vocab,
        params,compile_used,compile_error,
    ),tokenizer


class _PackedLMBatcher:
    """Produce exact ``[batch, context]`` causal-LM batches without padding.

    Tokenized examples are concatenated into a stream with an EOS separator and
    sliced into ``context+1`` blocks. Eager and compiled execution therefore see
    identical fixed shapes and every reported token corresponds to real compute.
    """
    def __init__(self, dataset, *, context, separator_id, rng):
        if len(dataset)<=0:
            raise RuntimeError("Selected split has no rows.")
        self.dataset=dataset
        self.context=int(context)
        self.separator_id=int(separator_id)
        self.rng=rng
        self.buffer=[]
        self.offset=0

    def _append_row(self):
        attempts=0
        while attempts<100:
            attempts+=1
            row=self.dataset[self.rng.randrange(len(self.dataset))]
            ids=row.get("input_ids") if isinstance(row,dict) else None
            if ids is None:
                raise RuntimeError("Prepared data has no input_ids. Add Tokenize Text to the Data Processing pipeline.")
            ids=[int(v) for v in list(ids)]
            if not ids:
                continue
            self.buffer.extend(ids)
            if ids[-1]!=self.separator_id:
                self.buffer.append(self.separator_id)
            return
        raise RuntimeError("Could not read a non-empty tokenized row from the selected split.")

    def batch(self,batch_size,device):
        batch_size=int(batch_size)
        block=self.context+1
        needed=batch_size*block
        while len(self.buffer)-self.offset<needed:
            self._append_row()
        flat=self.buffer[self.offset:self.offset+needed]
        self.offset+=needed
        if self.offset>262144:
            self.buffer=self.buffer[self.offset:]
            self.offset=0
        packed=torch.tensor(flat,dtype=torch.long).view(batch_size,block)
        x=packed[:,:-1].contiguous()
        y=packed[:,1:].contiguous()
        if device.type=="cuda":
            try:
                x=x.pin_memory(); y=y.pin_memory()
            except RuntimeError:
                pass
        return x.to(device,non_blocking=True),y.to(device,non_blocking=True),batch_size*self.context


def _sample_batch(dataset,batch_size,context,pad_id,device,rng,*,fixed_length=True):
    # Backward-compatible helper used by callers outside the training loop.
    # New LM training always uses packed fixed-shape data for both eager and
    # compiled modes; ``pad_id`` is used as the stream separator when EOS is not
    # otherwise available.
    del fixed_length
    return _PackedLMBatcher(
        dataset,context=context,separator_id=pad_id,rng=rng
    ).batch(batch_size,device)


def _autocast_context(device,precision):
    if device.type=="cuda" and precision in {"fp16","bf16"}:
        return torch.autocast(device_type="cuda",dtype=torch.float16 if precision=="fp16" else torch.bfloat16)
    if device.type=="cpu" and precision=="bf16": return torch.autocast(device_type="cpu",dtype=torch.bfloat16)
    from contextlib import nullcontext
    return nullcontext()


def _perplexity(loss_value):
    if loss_value is None:
        return None
    try:
        value=float(loss_value)
    except (TypeError,ValueError,OverflowError):
        return None
    if not math.isfinite(value):
        return None
    # exp(20) is already ~4.85e8; cap only to keep telemetry finite.
    return math.exp(min(value,20.0))


def _sync_device(device):
    if device.type=="cuda":
        try: torch.cuda.synchronize(device)
        except Exception: pass


def _memory_snapshot(device):
    empty={
        "memory_allocated_gb":None,"memory_reserved_gb":None,
        "memory_peak_gb":None,"memory_total_gb":None,
    }
    if device.type!="cuda":
        return empty
    try:
        scale=float(1024**3)
        props=torch.cuda.get_device_properties(device)
        return {
            "memory_allocated_gb":torch.cuda.memory_allocated(device)/scale,
            "memory_reserved_gb":torch.cuda.memory_reserved(device)/scale,
            "memory_peak_gb":torch.cuda.max_memory_allocated(device)/scale,
            "memory_total_gb":float(props.total_memory)/scale,
        }
    except Exception:
        return empty


def _optimizer(model,config):
    name=str(config.get("optimizer") or "adamw").lower()
    lr=runtime_float(config.get("learning_rate"),5e-4,"Learning Rate",minimum=0.0)
    wd=runtime_float(config.get("weight_decay"),0.1,"Weight Decay",minimum=0.0)
    beta1=runtime_float(config.get("beta1"),0.9,"Adam Beta 1",minimum=0.0,maximum=1.0)
    beta2=runtime_float(config.get("beta2"),0.95,"Adam Beta 2",minimum=0.0,maximum=1.0)
    if name in {"adamw","adam"}:
        try:
            from mlbricks import AdamW, Adam
        except ImportError as exc:
            raise RuntimeError("Current MLBricks installation does not expose Adam/AdamW.") from exc
        cls=AdamW if name=="adamw" else Adam
        return cls(model.parameters(),lr=lr,betas=(beta1,beta2),weight_decay=wd)
    if name=="sgd":
        return torch.optim.SGD(model.parameters(),lr=lr,weight_decay=wd,momentum=0.9)
    raise ValueError(f"Unsupported optimizer: {name}")


def _evaluate(loss_model,raw_model,batcher,*,steps,batch_size,device,precision):
    if batcher is None:return None
    raw_model.eval();loss_model.eval();losses=[]
    try:
        with torch.no_grad():
            for _ in range(max(1,int(steps))):
                x,y,_=batcher.batch(batch_size,device)
                _sync_device(device)
                with _autocast_context(device,precision):
                    loss=loss_model(x,y)
                losses.append(float(loss.detach().float().cpu()))
    finally:
        raw_model.train();loss_model.train()
    return sum(losses)/len(losses)


def _sample_next(logits,temperature,top_k,top_p,generator=None):
    temperature=max(runtime_float(temperature,0.8,"Temperature",minimum=1e-5),1e-5); logits=logits/temperature
    top_k=runtime_int(top_k,50,"Top K",minimum=0)
    if top_k>0:
        k=min(top_k,logits.size(-1));v,_=torch.topk(logits,k);cut=v[...,[-1]];logits=torch.where(logits<cut,torch.full_like(logits,float('-inf')),logits)
    top_p=runtime_float(top_p,0.95,"Top P",minimum=0.0,maximum=1.0)
    if 0<top_p<1:
        sorted_logits,idx=torch.sort(logits,descending=True);probs=torch.softmax(sorted_logits,dim=-1);cum=torch.cumsum(probs,dim=-1);mask=cum>float(top_p);mask[...,1:]=mask[...,:-1].clone();mask[...,0]=False;sorted_logits=sorted_logits.masked_fill(mask,float('-inf'));logits=torch.full_like(logits,float('-inf')).scatter(-1,idx,sorted_logits)
    probs=torch.softmax(logits,dim=-1);return torch.multinomial(probs,1,generator=generator)


def generate_text(model,tokenizer,prompt,*,max_new_tokens,context,device,precision,temperature=.8,top_k=50,top_p=.95,seed=42,progress=None,stop_event=None):
    ids=tokenizer.encode(str(prompt),add_special_tokens=True)
    if not ids: ids=[tokenizer.eos_token_id or tokenizer.pad_token_id or 0]
    generated=list(ids)
    was_training=bool(model.training)
    model.eval()
    try:
        generator_device=device if device.type in {"cpu","cuda"} else torch.device("cpu")
        seed=runtime_int(seed,42,"Seed")
        max_new_tokens=runtime_int(max_new_tokens,128,"New Token Count",minimum=1)
        context=runtime_int(context,512,"Model Context",minimum=2)
        gen=torch.Generator(device=generator_device);gen.manual_seed(seed)
        for i in range(max_new_tokens):
            if stop_event is not None and stop_event.is_set(): raise TrainingStopped("Generation stopped.")
            x=torch.tensor([generated[-context:]],dtype=torch.long,device=device)
            with torch.no_grad(),_autocast_context(device,precision): logits=model(x)
            if isinstance(logits,(tuple,list)):
                logits=logits[0]
            next_id=int(_sample_next(logits[:,-1,:].float(),temperature,top_k,top_p,generator=gen).item());generated.append(next_id)
            if progress and (i==0 or (i+1)%10==0 or i+1==max_new_tokens):
                progress({"status":"running","runtime_kind":"generate","phase":"generate","overall":round((i+1)/max_new_tokens*100),"generated_tokens":i+1,"message":f"Generated {i+1}/{max_new_tokens} tokens…","generated_text":tokenizer.decode(generated,skip_special_tokens=True)})
            if tokenizer.eos_token_id is not None and next_id==tokenizer.eos_token_id:break
        return tokenizer.decode(generated,skip_special_tokens=True),len(generated)-len(ids)
    finally:
        if was_training: model.train()


def train_builder_model(*,state,model_entry,dataset,dataset_meta,config,progress,stop_event):
    """Train a Builder causal LM with notebook-equivalent throughput semantics.

    Eager and compiled runs use the same packed fixed-shape token batches. When
    compiled execution is selected, one whole training graph (model + LM head +
    cross entropy) is compiled with ``fullgraph=True`` and ``dynamic=False``.
    """
    seed=runtime_int(config.get("seed"),42,"Seed")
    random.seed(seed);torch.manual_seed(seed)
    if torch.cuda.is_available():torch.cuda.manual_seed_all(seed)

    compiled,tokenizer=compile_builder_model(
        state,model_entry,dataset_meta,config,progress=progress,for_training=True
    )
    device=compiled.device
    model=compiled.model
    raw=compiled.raw_model
    loss_model=(compiled.training_model if compiled.training_model is not None else _CausalLMTrainingGraph(raw))
    precision=compiled.precision

    train=dataset["train"] if isinstance(dataset,dict) or hasattr(dataset,"keys") else dataset
    val_name=str(config.get("validation_split") or "validation")
    val=dataset.get(val_name) if hasattr(dataset,"get") else None

    context=runtime_int(
        model_entry.get("context_length") or state.get("project",{}).get("context_length"),
        512,"Model Context",minimum=2,
    )
    batch=runtime_int(config.get("batch_size"),16,"Batch Size",minimum=1)
    accum=runtime_int(config.get("gradient_accumulation"),1,"Gradient Accumulation",minimum=1)
    pad=runtime_int(tokenizer.pad_token_id,0,"Tokenizer Pad Token ID",minimum=0)
    separator=int(tokenizer.eos_token_id if tokenizer.eos_token_id is not None else pad)
    opt=_optimizer(raw,config)
    warm=runtime_int(config.get("warmup_steps"),0,"Warmup Steps",minimum=0)
    scaler=torch.amp.GradScaler("cuda",enabled=(device.type=="cuda" and precision=="fp16")) if hasattr(torch,"amp") else None

    budget=str(config.get("budget_type") or "steps").lower()
    max_steps=runtime_int(config.get("max_steps"),1000,"Training Steps",minimum=1)
    max_tokens=runtime_int(config.get("max_tokens"),1000000,"Token Budget",minimum=1)
    epochs=runtime_float(config.get("epochs"),1.0,"Epochs",minimum=0.000001)
    if budget not in {"steps","tokens","epochs"}:
        raise ValueError(f"Budget By must be steps, tokens, or epochs; received {budget!r}.")
    if budget=="epochs":
        max_steps=max(1,math.ceil(len(train)/batch*epochs))

    validate_every=runtime_int(config.get("validate_every"),100,"Validate Every N Steps",minimum=0)
    val_steps=runtime_int(config.get("validation_steps"),20,"Validation Steps",minimum=1)
    checkpoint_every=runtime_int(config.get("checkpoint_every"),500,"Checkpoint Every N Steps",minimum=0)
    output=Path(str(config.get("output_dir") or "mlbricks/models"))/_safe_name(model_entry.get("name","model"))
    output.mkdir(parents=True,exist_ok=True)
    (output/'checkpoints').mkdir(exist_ok=True)

    architecture=copy.deepcopy(model_entry.get("architecture") or _root_model(state))
    custom_components=copy.deepcopy(state.get("custom_components") or {})
    custom_components.update(copy.deepcopy(model_entry.get("custom_components_snapshot") or {}))
    builder_package={
        "format":"mlbricks-builder-model-v2",
        "builder_version":"0.7.37",
        "project":copy.deepcopy(state.get("project") or {}),
        "model_component":architecture,
        "custom_components":custom_components,
        "model_entry":copy.deepcopy(model_entry),
        "dataset_meta":copy.deepcopy(dataset_meta or {}),
    }

    train_batcher=_PackedLMBatcher(
        train,context=context,separator_id=separator,rng=random.Random(seed ^ 0x54524149)
    )
    val_batcher=(
        _PackedLMBatcher(val,context=context,separator_id=separator,rng=random.Random(seed ^ 0x56414C49))
        if val is not None else None
    )
    # Validation uses the same raw weights but does not need another compiled
    # training graph variant under no_grad().
    eval_loss_model=_CausalLMTrainingGraph(raw)

    tokens_seen=0;best_val=float('inf');last_val=None;last_val_ppl=None
    model.train();raw.train();loss_model.train()

    # torch.compile is lazy. Prepare two exact-shape batches first, then force
    # two forward+backward passes so compilation and first-use autotuning are
    # excluded from the throughput timer. No optimizer step is taken.
    compile_seconds=0.0
    if compiled.compile_used:
        progress({
            "status":"running","runtime_kind":"train","phase":"compile_warmup","overall":1,
            "step":0,"max_steps":max_steps,"tokens_seen":0,"tokens_per_sec":None,
            "avg_tokens_per_sec":None,"end_to_end_tokens_per_sec":None,
            "avg_end_to_end_tokens_per_sec":None,"loss":None,"ppl":None,
            "val_loss":None,"val_ppl":None,**_memory_snapshot(device),
            "message":f"Compiling one whole training graph on {device} · fixed shape [{batch}, {context}] · 2 warm-up passes…",
        })
        warmup_batcher=_PackedLMBatcher(
            train,context=context,separator_id=separator,rng=random.Random(seed ^ 0x4D4C4252)
        )
        warm_batches=[warmup_batcher.batch(batch,device) for _ in range(2)]
        _sync_device(device)
        if device.type=="cuda":
            try: torch.cuda.reset_peak_memory_stats(device)
            except Exception: pass
        compile_started=time.perf_counter()
        for xw,yw,_ in warm_batches:
            opt.zero_grad(set_to_none=True)
            with _autocast_context(device,precision):
                warm_loss=loss_model(xw,yw)/accum
            if scaler is not None and scaler.is_enabled(): scaler.scale(warm_loss).backward()
            else: warm_loss.backward()
        _sync_device(device)
        compile_seconds=max(time.perf_counter()-compile_started,0.0)
        opt.zero_grad(set_to_none=True)
        progress({
            "status":"running","runtime_kind":"train","phase":"compile_done","overall":2,
            "step":0,"max_steps":max_steps,"tokens_seen":0,"tokens_per_sec":None,
            "avg_tokens_per_sec":None,"end_to_end_tokens_per_sec":None,
            "avg_end_to_end_tokens_per_sec":None,"loss":None,"ppl":None,
            "val_loss":None,"val_ppl":None,**_memory_snapshot(device),
            "compile_seconds":compile_seconds,
            "message":f"Whole-model compilation complete · {compile_seconds:.1f}s · throughput timer starts now",
        })

    if device.type=="cuda":
        try: torch.cuda.reset_peak_memory_stats(device)
        except Exception: pass
    wall_start=time.perf_counter()
    gpu_train_seconds=0.0
    e2e_train_seconds=0.0
    progress({
        "status":"running","runtime_kind":"train","phase":"train","overall":2,
        "step":0,"max_steps":max_steps,"tokens_seen":0,"tokens_per_sec":None,
        "avg_tokens_per_sec":None,"end_to_end_tokens_per_sec":None,
        "avg_end_to_end_tokens_per_sec":None,"loss":None,"ppl":None,
        "val_loss":None,"val_ppl":None,**_memory_snapshot(device),
        "compile_seconds":compile_seconds,
        "message":f"Training started on {device} · {compiled.parameter_count:,} parameters · packed [{batch}, {context}]"+
                  (f" · whole-model compiled ({compile_seconds:.1f}s warm-up)" if compiled.compile_used else " · eager"),
        "compile_warning":compiled.compile_error,
    })

    step=0;loss_value=None;sample=None
    while True:
        if stop_event.is_set(): raise TrainingStopped("Training stopped.")
        if budget=="steps" and step>=max_steps:break
        if budget=="tokens" and tokens_seen>=max_tokens:break
        if budget=="epochs" and step>=max_steps:break
        step+=1

        # Prepare packed CPU batches and finish H2D transfer before GPU timing.
        # This makes Tok/s a model-training metric, while E2E Tok/s separately
        # reports data preparation + transfer + model training.
        e2e_started=time.perf_counter()
        microbatches=[train_batcher.batch(batch,device) for _ in range(accum)]
        _sync_device(device)
        step_started=time.perf_counter()

        opt.zero_grad(set_to_none=True)
        step_tokens=0
        detached_losses=[]
        for x,y,toks in microbatches:
            step_tokens+=toks
            with _autocast_context(device,precision):
                loss=loss_model(x,y)/accum
            if scaler is not None and scaler.is_enabled():scaler.scale(loss).backward()
            else:loss.backward()
            detached_losses.append(loss.detach())

        if scaler is not None and scaler.is_enabled():
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(raw.parameters(),1.0)
            scaler.step(opt);scaler.update()
        else:
            torch.nn.utils.clip_grad_norm_(raw.parameters(),1.0)
            opt.step()

        if warm>0 and step<=warm:
            factor=step/warm
            base_lr=runtime_float(config.get('learning_rate'),5e-4,'Learning Rate',minimum=0.0)
            for group in opt.param_groups:group['lr']=base_lr*factor

        _sync_device(device)
        gpu_elapsed=max(time.perf_counter()-step_started,1e-9)
        e2e_elapsed=max(time.perf_counter()-e2e_started,1e-9)
        gpu_train_seconds+=gpu_elapsed
        e2e_train_seconds+=e2e_elapsed
        tokens_seen+=step_tokens
        loss_value=sum(float(v.float().cpu()) for v in detached_losses)
        tokens_per_sec=float(step_tokens)/gpu_elapsed
        avg_tokens_per_sec=float(tokens_seen)/max(gpu_train_seconds,1e-9)
        end_to_end_tokens_per_sec=float(step_tokens)/e2e_elapsed
        avg_end_to_end_tokens_per_sec=float(tokens_seen)/max(e2e_train_seconds,1e-9)
        ppl=_perplexity(loss_value)
        mem=_memory_snapshot(device)
        lr=float(opt.param_groups[0].get('lr',0.0)) if opt.param_groups else None
        do_val=validate_every>0 and (step%validate_every==0 or (budget=="steps" and step==max_steps))
        sample=None

        base_event={
            "step":step,"max_steps":max_steps,"tokens_seen":tokens_seen,
            "tokens_per_sec":tokens_per_sec,"avg_tokens_per_sec":avg_tokens_per_sec,
            "end_to_end_tokens_per_sec":end_to_end_tokens_per_sec,
            "avg_end_to_end_tokens_per_sec":avg_end_to_end_tokens_per_sec,
            "loss":loss_value,"ppl":ppl,"val_loss":last_val,"val_ppl":last_val_ppl,
            "lr":lr,"compile_seconds":compile_seconds,
        }

        if do_val and val_batcher is not None:
            progress({
                "status":"running","runtime_kind":"train","phase":"validation",
                "overall":min(99,round(step/max_steps*100)) if budget!="tokens" else min(99,round(tokens_seen/max_tokens*100)),
                **base_event,**mem,"message":f"Validating at step {step}…",
            })
            last_val=_evaluate(
                eval_loss_model,raw,val_batcher,steps=val_steps,batch_size=batch,
                device=device,precision=precision,
            )
            best_val=min(best_val,last_val)
            last_val_ppl=_perplexity(last_val)
            if _bool(config.get("generate_on_validation",True)):
                try:
                    sample,_=generate_text(
                        model,tokenizer,config.get("validation_prompt","Once upon a time"),
                        max_new_tokens=runtime_int(config.get("validation_generate_tokens"),64,"Validation Sample Tokens",minimum=1),
                        context=context,device=device,precision=precision,temperature=.8,top_k=50,top_p=.95,
                        seed=seed+step,stop_event=stop_event,
                    )
                except Exception as exc: sample=f"[sample generation skipped: {exc}]"
            mem=_memory_snapshot(device)
            base_event.update({"val_loss":last_val,"val_ppl":last_val_ppl})
            progress({
                "status":"running","runtime_kind":"train","phase":"validation_done",
                "overall":min(99,round(step/max_steps*100)) if budget!="tokens" else min(99,round(tokens_seen/max_tokens*100)),
                **base_event,
                "best_val_loss":None if best_val==float('inf') else best_val,
                "sample_text":sample,"elapsed_seconds":time.perf_counter()-wall_start,**mem,
                "message":f"Validation complete · val loss {last_val:.4f} · val ppl {last_val_ppl:.2f}",
            })

        if checkpoint_every>0 and step%checkpoint_every==0:
            checkpoint_path=output/'checkpoints'/f'step_{step:06d}'
            metadata={
                "kind":"training_checkpoint","step":step,"tokens_seen":tokens_seen,
                "vocab_size":compiled.vocab_size,"training_config":copy.deepcopy(config),
                "builder_package":builder_package,
            }
            from mlbricks import save as mlbricks_save
            mlbricks_save(raw,checkpoint_path,metadata=metadata)
            # Optimizer/scaler state is supplemental training state; the model
            # itself is always stored through the public MLBricks lifecycle API.
            torch.save({
                "optimizer":opt.state_dict(),"scaler":scaler.state_dict() if scaler is not None else None,
                "step":step,"tokens_seen":tokens_seen,
            },checkpoint_path/'training_state.pt')
            progress({
                "status":"running","runtime_kind":"train","phase":"checkpoint",
                "overall":min(99,round(step/max_steps*100)) if budget!="tokens" else min(99,round(tokens_seen/max_tokens*100)),
                **base_event,"best_val_loss":None if best_val==float('inf') else best_val,
                "sample_text":sample,"checkpoint_path":str(checkpoint_path),
                "elapsed_seconds":time.perf_counter()-wall_start,**_memory_snapshot(device),
                "message":f"MLBricks checkpoint saved · step {step}",
            })

        if budget=="tokens":overall=min(99,round(tokens_seen/max_tokens*100))
        else:overall=min(99,round(step/max_steps*100))
        mem=_memory_snapshot(device)
        mem_text=(f" · mem {mem['memory_allocated_gb']:.2f} GB" if mem.get('memory_allocated_gb') is not None else "")
        val_text=(f" · val {last_val:.4f} · val ppl {last_val_ppl:.2f}" if last_val is not None else "")
        progress({
            "status":"running","runtime_kind":"train","phase":"train","overall":overall,
            **base_event,"best_val_loss":None if best_val==float('inf') else best_val,
            "sample_text":sample,"elapsed_seconds":time.perf_counter()-wall_start,**mem,
            "message":f"Step {step} · {tokens_per_sec:,.0f} GPU tok/s · {end_to_end_tokens_per_sec:,.0f} E2E tok/s · loss {loss_value:.4f} · ppl {ppl:.2f}"+val_text+mem_text,
        })

    final=output/'last'
    from mlbricks import save as mlbricks_save
    tok_cfg=((dataset_meta or {}).get("pipeline") or {}).get("tokenizer") or {}
    final_metadata={
        "kind":"trained_model","step":step,"tokens_seen":tokens_seen,
        "best_val_loss":None if best_val==float('inf') else best_val,
        "training_config":copy.deepcopy(config),"builder_package":builder_package,
        "tokenizer_name":tok_cfg.get("tokenizer_name") or "gpt2",
        "execution":"whole-model compiled" if compiled.compile_used else "eager",
        "compile_mode":str(config.get("compile_mode") or "default") if compiled.compile_used else None,
        "compile_fullgraph":True if compiled.compile_used else None,
        "compile_dynamic":False if compiled.compile_used else None,
    }
    mlbricks_save(raw,final,metadata=final_metadata)
    tokenizer_dir=final/'tokenizer'
    try:
        tokenizer.save_pretrained(str(tokenizer_dir))
    except Exception:
        tokenizer_dir=None

    final_mem=_memory_snapshot(device)
    update={
        "training_status":"trained","weights_ready":True,"path":str(final),"checkpoint_path":str(final),
        "trained_steps":step,"tokens_seen":tokens_seen,"last_loss":loss_value,"last_ppl":_perplexity(loss_value),
        "best_val_loss":None if best_val==float('inf') else best_val,"last_val_loss":last_val,"last_val_ppl":last_val_ppl,
        "avg_tokens_per_sec":float(tokens_seen)/max(gpu_train_seconds,1e-9),
        "avg_end_to_end_tokens_per_sec":float(tokens_seen)/max(e2e_train_seconds,1e-9),
        "memory_peak_gb":final_mem.get("memory_peak_gb"),"parameter_count":compiled.parameter_count,
        "effective_vocab_size":compiled.vocab_size,"execution_mode_used":"compiled" if compiled.compile_used else "eager",
        "compile_warning":compiled.compile_error,"compile_seconds":compile_seconds,
        "trained_at":time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
        "format":"MLBricks model artifact","artifact_format":"mlbricks.model",
        "tokenizer_path":str(tokenizer_dir) if tokenizer_dir is not None else None,
    }
    return {"compiled":compiled,"tokenizer":tokenizer,"model_update":update,"last_sample":sample}


def load_trained_for_generation(*,state,model_entry,dataset_meta,config,checkpoint_path=None,progress=None):
    # Rebuild using the selected generation runtime, then restore weights through
    # the current public MLBricks lifecycle API. Legacy Builder .pt checkpoints
    # remain loadable for backward compatibility.
    compiled,tokenizer=compile_builder_model(
        state,model_entry,dataset_meta,config,progress=progress,for_training=False
    )
    path=Path(str(checkpoint_path or model_entry.get("checkpoint_path") or model_entry.get("path") or ""))
    if not path.exists():
        raise RuntimeError("Trained model artifact was not found. Train the model in this session or select a valid MLBricks model artifact.")

    if path.is_dir() and (path/"model.pt").exists():
        try:
            from mlbricks import load as mlbricks_load
        except ImportError as exc:
            raise RuntimeError("Current MLBricks installation does not expose mlbricks.load().") from exc
        loaded=mlbricks_load(path,device=compiled.device,strict=True)
        compiled.raw_model.load_state_dict(loaded.state_dict(),strict=True)
        del loaded
    else:
        # Legacy MLBricks Builder checkpoint format.
        payload=torch.load(path,map_location="cpu",weights_only=False)
        if not isinstance(payload,dict) or "model_state" not in payload:
            raise RuntimeError("Selected file is neither an MLBricks model artifact nor a legacy Builder checkpoint.")
        compiled.raw_model.load_state_dict(payload["model_state"],strict=True)

    compiled.raw_model.to(compiled.device)
    return compiled,tokenizer
