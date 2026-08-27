from __future__ import annotations
from datetime import datetime, timezone
import uuid

def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"

def primitive_catalog():
    return [
        {
            "type":"input","name":"Text Input","icon":"IN","category":"Inputs",
            "description":"Enter text or prompt",
            "api":[
                {"key":"input_type","label":"Input Type","type":"select","value":"text","options":["text"]},
            ]
        },
        {
            "type":"image_input","name":"Image Input","icon":"IM","category":"Inputs",
            "description":"Image / vision input",
            "api":[
                {"key":"channels","label":"Channels","type":"number","value":3},
                {"key":"size","label":"Image Size","type":"number","value":224},
            ]
        },
        {
            "type":"embedding","name":"Embedding","icon":"EM","category":"Core Blocks",
            "description":"Token embedding",
            "api":[
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
                {"key":"vocab_size","label":"Vocab Size","type":"number","value":50257},
                {"key":"device","label":"Device","type":"select","value":"auto","options":["auto","cpu","cuda"]},
                {"key":"dtype","label":"DType","type":"select","value":"float16","options":["float32","float16","bfloat16"]},
            ]
        },
        {
            "type":"esa","name":"ESA","icon":"ES","category":"Core Blocks",
            "description":"Entangled State Attention",
            "api":[
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
                {"key":"state_dim","label":"State Dim","type":"number","value":256},
                {"key":"heads","label":"Heads","type":"number","value":8},
                {"key":"chunk_size","label":"Chunk Size","type":"number","value":16},
                {"key":"kernel","label":"Kernel","type":"select","value":"auto","options":["auto","native","pytorch"]},
                {"key":"dtype","label":"DType","type":"select","value":"float16","options":["float32","float16","bfloat16"]},
                {"key":"device","label":"Device","type":"select","value":"auto","options":["auto","cpu","cuda"]},
            ]
        },
        {
            "type":"vesa","name":"VESA","icon":"VE","category":"Core Blocks",
            "description":"Visual ESA",
            "api":[
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
                {"key":"heads","label":"Heads","type":"number","value":8},
                {"key":"kernel","label":"Kernel","type":"select","value":"auto","options":["auto","native","pytorch"]},
            ]
        },
        {
            "type":"saffn","name":"SAFFN","icon":"SF","category":"Core Blocks",
            "description":"State-aware feed forward",
            "api":[
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
                {"key":"ffn_dim","label":"FFN Hidden Dim","type":"number","value":2048},
                {"key":"activation","label":"Activation","type":"select","value":"silu","options":["silu","gelu","relu"]},
                {"key":"dropout","label":"Dropout","type":"number","value":0.0},
            ]
        },
        {
            "type":"ffn","name":"FFN Brick","icon":"FF","category":"Core Blocks",
            "description":"Feed Forward Network",
            "api":[
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
                {"key":"ffn_dim","label":"FFN Hidden Dim","type":"number","value":2048},
                {"key":"activation","label":"Activation","type":"select","value":"silu","options":["silu","gelu","relu"]},
                {"key":"dropout","label":"Dropout","type":"number","value":0.1},
                {"key":"bias","label":"Use Bias","type":"select","value":"true","options":["true","false"]},
            ]
        },
        {
            "type":"rmsnorm","name":"RMSNorm","icon":"RN","category":"Core Blocks",
            "description":"RMS normalization",
            "api":[
                {"key":"eps","label":"Epsilon","type":"number","value":0.00001},
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
            ]
        },
        {
            "type":"residual","name":"Residual Add","icon":"RS","category":"Core Blocks",
            "description":"Residual / skip connection",
            "api":[
                {"key":"pre_norm","label":"Pre-Norm","type":"select","value":"RMSNorm","options":["None","RMSNorm","LayerNorm"]},
                {"key":"scale","label":"Scaling","type":"number","value":1.0},
                {"key":"enabled","label":"Use Residual","type":"select","value":"true","options":["true","false"]},
            ]
        },
        {
            "type":"bolt","name":"BOLT","icon":"BO","category":"Core Blocks",
            "description":"BOLT block",
            "api":[
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
                {"key":"kernel","label":"Kernel","type":"select","value":"auto","options":["auto","native","pytorch"]},
            ]
        },
        {
            "type":"visualbolt","name":"VisualBOLT","icon":"VB","category":"Core Blocks",
            "description":"Visual BOLT block",
            "api":[
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
                {"key":"kernel","label":"Kernel","type":"select","value":"auto","options":["auto","native","pytorch"]},
            ]
        },
        {
            "type":"lm_head","name":"LM Head","icon":"LM","category":"Heads",
            "description":"Language modeling head",
            "api":[
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
                {"key":"vocab_size","label":"Vocab Size","type":"number","value":50257},
                {"key":"bias","label":"Use Bias","type":"select","value":"false","options":["true","false"]},
            ]
        },
        {
            "type":"classifier","name":"Classifier Head","icon":"CL","category":"Heads",
            "description":"Classification head",
            "api":[
                {"key":"dim","label":"Hidden Dim","type":"number","value":512},
                {"key":"classes","label":"Classes","type":"number","value":10},
            ]
        },
        {
            "type":"output","name":"Text Output","icon":"OUT","category":"Outputs",
            "description":"Generate / decode text",
            "api":[
                {"key":"max_tokens","label":"Max New Tokens","type":"number","value":64},
                {"key":"temperature","label":"Temperature","type":"number","value":0.8},
                {"key":"top_p","label":"Top P","type":"number","value":0.95},
            ]
        },
    ]

def new_project(name: str = "Story Model"):
    root_id = _id("component")
    now = datetime.now(timezone.utc).isoformat()
    return {
        "format":"mlbricks-builder",
        "format_version":"0.1",
        "project":{"name":name,"created_at":now,"updated_at":now},
        "root_component_id":root_id,
        "components":{
            root_id:{
                "id":root_id,
                "name":name,
                "kind":"model",
                "revision":1,
                "nodes":[]
            }
        },
        "custom_components":{},
        "view_component_id":root_id,
        "breadcrumbs":[{"id":root_id,"name":name}],
    }
