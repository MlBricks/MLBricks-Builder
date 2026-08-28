from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
import json
import math
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

    def _module_for(self,node):
        from mlbricks import Embedding, LMHead, FFN, RMSNorm, LayerNorm, Residual, ESA
        t=node.get("type"); p=deepcopy(node.get("params") or {})
        device=str(self.runtime.get("device") or "auto")
        backend=str(self.runtime.get("backend") or "auto")
        precision=str(self.runtime.get("precision") or "auto")
        if precision=="auto": precision="fp16" if resolve_device(device).type=="cuda" else "fp32"
        if t in {"text_input","text_output","logits_output"}: return _Identity()
        if t=="embedding":
            vocab=int(self.vocab_override or p.get("vocab_size") or p.get("num_embeddings") or 32000)
            dim=int(p.get("embedding_dim") or p.get("hidden_size") or 384)
            return Embedding(vocab,dim)
        if t=="lm_head":
            vocab=int(self.vocab_override or p.get("vocab_size") or 32000)
            hidden=int(p.get("hidden_size") or p.get("dim") or 384)
            return LMHead(hidden,vocab,bias=_bool(p.get("bias",False)))
        if t=="esa":
            return ESA(
                embd=int(p.get("embd",384)), head=int(p.get("head",4)),
                batch=_none(p.get("batch")), block=_none(p.get("block")),
                backend=backend, precision=precision, compass=p.get("compass","auto"),
                dropout=float(p.get("dropout",0.0)), gate_min=float(p.get("gate_min",0.8)),
                gate_max=float(p.get("gate_max",0.995)), eps=float(p.get("eps",1e-5)),
                device=device, auto_compile=False, auto_move_input=True,
                strict_checks=_bool(p.get("strict_checks",False)),
            )
        if t=="rmsnorm":
            shape=p.get("normalized_shape",p.get("hidden_size",384))
            return RMSNorm(shape,eps=float(p.get("eps",1e-6)),elementwise_affine=_bool(p.get("elementwise_affine",True)))
        if t=="layernorm":
            shape=p.get("normalized_shape",p.get("hidden_size",p.get("dim",384)))
            return LayerNorm(shape,eps=float(p.get("eps",1e-5)),elementwise_affine=_bool(p.get("elementwise_affine",True)),bias=_bool(p.get("bias",True)))
        if t=="ffn":
            return FFN(
                int(p.get("hidden_size",384)),
                int(p.get("intermediate_size",4*int(p.get("hidden_size",384)))),
                activation=p.get("activation","gelu"), dropout=float(p.get("dropout",0.0)),
                bias=_bool(p.get("bias",True)), gated=_bool(p.get("gated",False)),
            )
        if t=="residual": return Residual(dropout=float(p.get("dropout",0.0)))
        if t=="dropout": return nn.Dropout(float(p.get("p",p.get("dropout",0.1))))
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
            "Supported today: Text Input/Output, Embedding, ESA, RMSNorm, LayerNorm, FFN, Residual, Dropout, LM Head and nested custom bricks made from them."
        )

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
    model: nn.Module
    raw_model: nn.Module
    device: torch.device
    precision: str
    vocab_size: int
    parameter_count: int
    compile_used: bool
    compile_error: str | None


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


def compile_builder_model(state, model_entry, dataset_meta, runtime, *, progress=None):
    graph=_root_model(state)
    device=resolve_device(runtime.get("device","auto"))
    precision,dtype=resolve_precision(runtime.get("precision","auto"),device)
    tokenizer=_tokenizer_for(dataset_meta)
    graph_vocab=_graph_vocab(graph)
    tokenizer_vocab=len(tokenizer)
    effective_vocab=max(graph_vocab,tokenizer_vocab)
    if progress:
        msg=f"Compiling model on {device}"
        if effective_vocab!=graph_vocab: msg+=f" · vocab {graph_vocab:,} → {effective_vocab:,} to match tokenizer"
        progress({"status":"running","runtime_kind":"train","phase":"compile","overall":1,"message":msg})
    raw=TensorGraph(nodes=graph.get("nodes") or [],edges=graph.get("edges") or [],custom_components=state.get("custom_components") or {},runtime={**runtime,"device":str(device),"precision":precision},vocab_override=effective_vocab)
    raw.to(device)
    params=sum(p.numel() for p in raw.parameters())
    run_model=raw; compile_used=False; compile_error=None
    if str(runtime.get("execution_mode","eager"))=="compiled":
        if not hasattr(torch,"compile"):
            compile_error="torch.compile is unavailable; using eager."
        else:
            try:
                mode=str(runtime.get("compile_mode") or "default")
                run_model=torch.compile(raw,mode=mode,fullgraph=False)
                compile_used=True
            except Exception as exc:
                compile_error=str(exc); run_model=raw
    return CompiledModel(run_model,raw,device,precision,effective_vocab,params,compile_used,compile_error),tokenizer


def _sample_batch(dataset,batch_size,context,pad_id,device,rng):
    if len(dataset)<=0: raise RuntimeError("Selected split has no rows.")
    xs=[]; ys=[]; attempts=0
    while len(xs)<batch_size and attempts<batch_size*20:
        attempts+=1; row=dataset[rng.randrange(len(dataset))]
        ids=row.get("input_ids") if isinstance(row,dict) else None
        if ids is None: raise RuntimeError("Prepared data has no input_ids. Add Tokenize Text to the Data Processing pipeline.")
        ids=list(ids)
        if len(ids)<2: continue
        max_seq=max(2,int(context)+1)
        if len(ids)>max_seq:
            start=rng.randrange(0,len(ids)-max_seq+1); ids=ids[start:start+max_seq]
        x=ids[:-1]; y=ids[1:]
        if not x: continue
        xs.append(x);ys.append(y)
    if not xs: raise RuntimeError("Could not form a causal-LM batch. Tokenized rows are too short.")
    T=min(int(context),max(len(x) for x in xs))
    bx=torch.full((len(xs),T),int(pad_id),dtype=torch.long)
    by=torch.full((len(xs),T),-100,dtype=torch.long)
    tokens=0
    for i,(x,y) in enumerate(zip(xs,ys)):
        n=min(T,len(x)); bx[i,:n]=torch.tensor(x[:n],dtype=torch.long); by[i,:n]=torch.tensor(y[:n],dtype=torch.long);tokens+=n
    return bx.to(device,non_blocking=True),by.to(device,non_blocking=True),tokens


def _autocast_context(device,precision):
    if device.type=="cuda" and precision in {"fp16","bf16"}:
        return torch.autocast(device_type="cuda",dtype=torch.float16 if precision=="fp16" else torch.bfloat16)
    if device.type=="cpu" and precision=="bf16": return torch.autocast(device_type="cpu",dtype=torch.bfloat16)
    from contextlib import nullcontext
    return nullcontext()


def _optimizer(model,config):
    name=str(config.get("optimizer","adamw")).lower(); lr=float(config.get("learning_rate",3e-4));wd=float(config.get("weight_decay",0.1))
    if name=="adamw": return torch.optim.AdamW(model.parameters(),lr=lr,weight_decay=wd)
    if name=="adam": return torch.optim.Adam(model.parameters(),lr=lr,weight_decay=wd)
    if name=="sgd": return torch.optim.SGD(model.parameters(),lr=lr,weight_decay=wd,momentum=0.9)
    raise ValueError(f"Unsupported optimizer: {name}")


def _evaluate(model,dataset,*,steps,batch_size,context,pad_id,device,precision,rng):
    if dataset is None:return None
    model.eval(); losses=[]
    with torch.no_grad():
        for _ in range(max(1,int(steps))):
            x,y,_=_sample_batch(dataset,batch_size,context,pad_id,device,rng)
            with _autocast_context(device,precision):
                logits=model(x); loss=F.cross_entropy(logits.reshape(-1,logits.size(-1)),y.reshape(-1),ignore_index=-100)
            losses.append(float(loss.detach().float().cpu()))
    model.train();return sum(losses)/len(losses)


def _sample_next(logits,temperature,top_k,top_p,generator=None):
    temperature=max(float(temperature),1e-5); logits=logits/temperature
    if top_k and int(top_k)>0:
        k=min(int(top_k),logits.size(-1));v,_=torch.topk(logits,k);cut=v[...,[-1]];logits=torch.where(logits<cut,torch.full_like(logits,float('-inf')),logits)
    if top_p is not None and 0<float(top_p)<1:
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
        gen=torch.Generator(device=generator_device);gen.manual_seed(int(seed))
        for i in range(int(max_new_tokens)):
            if stop_event is not None and stop_event.is_set(): raise TrainingStopped("Generation stopped.")
            x=torch.tensor([generated[-int(context):]],dtype=torch.long,device=device)
            with torch.no_grad(),_autocast_context(device,precision): logits=model(x)
            next_id=int(_sample_next(logits[:,-1,:].float(),temperature,top_k,top_p,generator=gen).item());generated.append(next_id)
            if progress and (i==0 or (i+1)%10==0 or i+1==int(max_new_tokens)):
                progress({"status":"running","runtime_kind":"generate","phase":"generate","overall":round((i+1)/max(1,int(max_new_tokens))*100),"generated_tokens":i+1,"message":f"Generated {i+1}/{max_new_tokens} tokens…","generated_text":tokenizer.decode(generated,skip_special_tokens=True)})
            if tokenizer.eos_token_id is not None and next_id==tokenizer.eos_token_id:break
        return tokenizer.decode(generated,skip_special_tokens=True),len(generated)-len(ids)
    finally:
        if was_training: model.train()


def train_builder_model(*,state,model_entry,dataset,dataset_meta,config,progress,stop_event):
    seed=int(config.get("seed",42));random.seed(seed);torch.manual_seed(seed)
    if torch.cuda.is_available():torch.cuda.manual_seed_all(seed)
    compiled,tokenizer=compile_builder_model(state,model_entry,dataset_meta,config,progress=progress)
    device=compiled.device; model=compiled.model;raw=compiled.raw_model;precision=compiled.precision
    train=dataset["train"] if isinstance(dataset,dict) or hasattr(dataset,"keys") else dataset
    val_name=str(config.get("validation_split") or "validation"); val=dataset.get(val_name) if hasattr(dataset,"get") else None
    context=int(model_entry.get("context_length") or state.get("project",{}).get("context_length") or 512)
    batch=max(1,int(config.get("batch_size",16)));accum=max(1,int(config.get("gradient_accumulation",1)));pad=int(tokenizer.pad_token_id or 0)
    opt=_optimizer(raw,config);warm=max(0,int(config.get("warmup_steps",0)))
    scaler=torch.amp.GradScaler("cuda",enabled=(device.type=="cuda" and precision=="fp16")) if hasattr(torch,"amp") else None
    budget=str(config.get("budget_type","steps"));max_steps=max(1,int(config.get("max_steps",1000)));max_tokens=max(1,int(config.get("max_tokens",1000000)));epochs=max(1,float(config.get("epochs",1)))
    if budget=="epochs":max_steps=max(1,math.ceil(len(train)/batch*epochs))
    validate_every=max(0,int(config.get("validate_every",100)));val_steps=max(1,int(config.get("validation_steps",20)));checkpoint_every=max(0,int(config.get("checkpoint_every",500)))
    output=Path(str(config.get("output_dir") or "/kaggle/working/mlbricks_training"))/_safe_name(model_entry.get("name","model"));output.mkdir(parents=True,exist_ok=True);(output/'checkpoints').mkdir(exist_ok=True)
    rng=random.Random(seed);tokens_seen=0;best_val=float('inf');last_val=None;start=time.perf_counter();model.train()
    progress({"status":"running","runtime_kind":"train","phase":"train","overall":2,"step":0,"max_steps":max_steps,"tokens_seen":0,"loss":None,"val_loss":None,"message":f"Training started on {device} · {compiled.parameter_count:,} parameters"+(" · compiled" if compiled.compile_used else " · eager"),"compile_warning":compiled.compile_error})
    step=0
    while True:
        if stop_event.is_set(): raise TrainingStopped("Training stopped.")
        if budget=="steps" and step>=max_steps:break
        if budget=="tokens" and tokens_seen>=max_tokens:break
        if budget=="epochs" and step>=max_steps:break
        step+=1;opt.zero_grad(set_to_none=True);loss_value=0.0;step_tokens=0
        for _ in range(accum):
            x,y,toks=_sample_batch(train,batch,context,pad,device,rng);step_tokens+=toks
            with _autocast_context(device,precision):
                logits=model(x);loss=F.cross_entropy(logits.reshape(-1,logits.size(-1)),y.reshape(-1),ignore_index=-100)/accum
            if scaler is not None and scaler.is_enabled():scaler.scale(loss).backward()
            else:loss.backward()
            loss_value+=float(loss.detach().float().cpu())
        if scaler is not None and scaler.is_enabled():scaler.unscale_(opt);torch.nn.utils.clip_grad_norm_(raw.parameters(),1.0);scaler.step(opt);scaler.update()
        else:torch.nn.utils.clip_grad_norm_(raw.parameters(),1.0);opt.step()
        if warm>0 and step<=warm:
            factor=step/warm
            for group in opt.param_groups:group['lr']=float(config.get('learning_rate',3e-4))*factor
        tokens_seen+=step_tokens
        do_val=validate_every>0 and (step%validate_every==0 or (budget=="steps" and step==max_steps))
        sample=None
        if do_val and val is not None:
            progress({"status":"running","runtime_kind":"train","phase":"validation","overall":min(99,round(step/max_steps*100)) if budget!="tokens" else min(99,round(tokens_seen/max_tokens*100)),"step":step,"max_steps":max_steps,"tokens_seen":tokens_seen,"loss":loss_value,"val_loss":last_val,"message":f"Validating at step {step}…"})
            last_val=_evaluate(model,val,steps=val_steps,batch_size=batch,context=context,pad_id=pad,device=device,precision=precision,rng=rng);best_val=min(best_val,last_val)
            if _bool(config.get("generate_on_validation",True)):
                try:
                    sample,_=generate_text(model,tokenizer,config.get("validation_prompt","Once upon a time"),max_new_tokens=int(config.get("validation_generate_tokens",64)),context=context,device=device,precision=precision,temperature=.8,top_k=50,top_p=.95,seed=seed+step,stop_event=stop_event)
                except Exception as exc: sample=f"[sample generation skipped: {exc}]"
            progress({"status":"running","runtime_kind":"train","phase":"validation_done","overall":min(99,round(step/max_steps*100)) if budget!="tokens" else min(99,round(tokens_seen/max_tokens*100)),"step":step,"max_steps":max_steps,"tokens_seen":tokens_seen,"loss":loss_value,"val_loss":last_val,"best_val_loss":None if best_val==float('inf') else best_val,"sample_text":sample,"elapsed_seconds":time.perf_counter()-start,"message":f"Validation complete at step {step} · val {last_val:.4f}"})
        if checkpoint_every>0 and step%checkpoint_every==0:
            checkpoint_path=output/'checkpoints'/f'step_{step:06d}.pt'
            torch.save({"model_state":raw.state_dict(),"model_entry":model_entry,"training_config":config,"vocab_size":compiled.vocab_size,"step":step,"tokens_seen":tokens_seen},checkpoint_path)
            progress({"status":"running","runtime_kind":"train","phase":"checkpoint","overall":min(99,round(step/max_steps*100)) if budget!="tokens" else min(99,round(tokens_seen/max_tokens*100)),"step":step,"max_steps":max_steps,"tokens_seen":tokens_seen,"loss":loss_value,"val_loss":last_val,"best_val_loss":None if best_val==float('inf') else best_val,"sample_text":sample,"checkpoint_path":str(checkpoint_path),"elapsed_seconds":time.perf_counter()-start,"message":f"Checkpoint saved · step {step}"})
        if budget=="tokens":overall=min(99,round(tokens_seen/max_tokens*100))
        else:overall=min(99,round(step/max_steps*100))
        progress({"status":"running","runtime_kind":"train","phase":"train","overall":overall,"step":step,"max_steps":max_steps,"tokens_seen":tokens_seen,"loss":loss_value,"val_loss":last_val,"best_val_loss":None if best_val==float('inf') else best_val,"sample_text":sample,"elapsed_seconds":time.perf_counter()-start,"message":f"Step {step} · loss {loss_value:.4f}"+(f" · val {last_val:.4f}" if last_val is not None else "")})
    final=output/'last.pt';torch.save({"model_state":raw.state_dict(),"model_entry":model_entry,"training_config":config,"vocab_size":compiled.vocab_size,"step":step,"tokens_seen":tokens_seen,"best_val_loss":best_val},final)
    update={"training_status":"trained","weights_ready":True,"path":str(final),"checkpoint_path":str(final),"trained_steps":step,"tokens_seen":tokens_seen,"last_loss":loss_value,"best_val_loss":None if best_val==float('inf') else best_val,"parameter_count":compiled.parameter_count,"effective_vocab_size":compiled.vocab_size,"trained_at":time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),"format":"PyTorch checkpoint"}
    return {"compiled":compiled,"tokenizer":tokenizer,"model_update":update,"last_sample":sample}


def load_trained_for_generation(*,state,model_entry,dataset_meta,config,checkpoint_path=None,progress=None):
    # Compile using the selected generation runtime, then load checkpoint weights.
    compiled,tokenizer=compile_builder_model(state,model_entry,dataset_meta,config,progress=progress)
    path=Path(str(checkpoint_path or model_entry.get("checkpoint_path") or model_entry.get("path") or ""))
    if not path.exists(): raise RuntimeError("Trained checkpoint was not found. Train the model in this session or select a valid checkpoint.")
    payload=torch.load(path,map_location="cpu",weights_only=False);compiled.raw_model.load_state_dict(payload["model_state"],strict=True);compiled.raw_model.to(compiled.device)
    if compiled.compile_used and compiled.model is not compiled.raw_model: pass
    return compiled,tokenizer
