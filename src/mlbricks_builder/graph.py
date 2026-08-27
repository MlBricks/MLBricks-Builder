from __future__ import annotations
from datetime import datetime, timezone
import uuid

def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"

def primitive_catalog():
    return [
        {"type":"input","name":"Input","icon":"IN"},
        {"type":"embedding","name":"Embedding","icon":"EM"},
        {"type":"esa","name":"ESA","icon":"ES"},
        {"type":"vesa","name":"VESA","icon":"VE"},
        {"type":"saffn","name":"SAFFN","icon":"SF"},
        {"type":"ffn","name":"FFN","icon":"FF"},
        {"type":"rmsnorm","name":"RMSNorm","icon":"RN"},
        {"type":"residual","name":"Residual","icon":"RS"},
        {"type":"bolt","name":"BOLT","icon":"BO"},
        {"type":"visualbolt","name":"VisualBOLT","icon":"VB"},
        {"type":"lm_head","name":"LM Head","icon":"LM"},
        {"type":"output","name":"Output","icon":"OUT"},
    ]

def new_project(name: str = "Untitled Model"):
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
