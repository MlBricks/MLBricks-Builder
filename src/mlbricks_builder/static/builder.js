(function(){
  if(window.MLBricksBuilder) return;

  function copy(v){return JSON.parse(JSON.stringify(v));}
  function uid(p){return p+"_"+Math.random().toString(36).slice(2,10);}
  function current(s){return s.components[s.view_component_id];}
  function nodeFrom(item){return {id:uid("node"),type:item.type,name:item.name,definition_id:null,repeat:1,params:{}};}

  function mount(root,payload){
    if(!root || root.dataset.mounted==="1") return;
    root.dataset.mounted="1";

    const state=copy(payload.state);
    const catalog=copy(payload.catalog);
    let selected=null;
    let message="Ready";

    function btn(text,cls="mlb-btn"){const b=document.createElement("button");b.type="button";b.className=cls;b.textContent=text;return b;}
    function selectedNode(){return current(state).nodes.find(n=>n.id===selected)||null;}

    function exportDesign(){
      const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;
      a.download=(state.project?.name||"model").replace(/\s+/g,"_")+".mlbricks";
      a.click();
      setTimeout(()=>URL.revokeObjectURL(url),500);
    }

    function makeCustom(){
      const comp=current(state);
      if(!comp.nodes.length){message="Add layers first.";draw();return;}
      const name=prompt("Component name:","My Component");
      if(!name)return;
      const id=uid("custom");
      state.custom_components[id]={id,name,revision:1,nodes:copy(comp.nodes)};
      message=name+" saved to My Bricks.";
      draw();
    }

    function addCustom(def){
      current(state).nodes.push({id:uid("node"),type:"custom",name:def.name,definition_id:def.id,repeat:1,params:{}});
      draw();
    }

    function openInside(node){
      const def=state.custom_components[node.definition_id];
      if(!def)return;
      const vid="view_"+def.id;
      state.components[vid]={id:vid,name:def.name,kind:"custom_edit",definition_id:def.id,revision:def.revision,nodes:copy(def.nodes)};
      state.view_component_id=vid;
      state.breadcrumbs.push({id:vid,name:def.name});
      selected=null;
      draw();
    }

    function saveCustom(asNew){
      const comp=current(state);
      const def=state.custom_components[comp.definition_id];
      if(!def)return;
      if(asNew){
        const name=prompt("New component name:",def.name+" Copy");
        if(!name)return;
        const id=uid("custom");
        state.custom_components[id]={id,name,revision:1,nodes:copy(comp.nodes)};
        message=name+" created.";
      }else{
        def.nodes=copy(comp.nodes);
        def.revision=(def.revision||1)+1;
        comp.revision=def.revision;
        message=def.name+" updated to v"+def.revision+".";
      }
      draw();
    }

    function draw(){
      root.innerHTML="";

      const toolbar=document.createElement("div");toolbar.className="mlb-toolbar";
      const brand=document.createElement("div");brand.className="mlb-brand";brand.textContent="MLBRICKS BUILDER";toolbar.appendChild(brand);
      const create=btn("Create Component");create.addEventListener("click",makeCustom);toolbar.appendChild(create);
      const ex=btn("Export Design");ex.addEventListener("click",exportDesign);toolbar.appendChild(ex);
      const run=btn("Run","mlb-btn primary");run.addEventListener("click",()=>{message="Visual graph ready. Runtime bridge comes next.";draw();});toolbar.appendChild(run);
      root.appendChild(toolbar);

      const layout=document.createElement("div");layout.className="mlb-layout";
      const side=document.createElement("aside");side.className="mlb-sidebar";side.innerHTML='<div class="mlb-title">Components</div>';
      const pal=document.createElement("div");pal.className="mlb-palette";
      catalog.forEach(item=>{const b=document.createElement("button");b.type="button";b.textContent=(item.icon||"")+"  "+item.name;b.addEventListener("click",()=>{current(state).nodes.push(nodeFrom(item));draw();});pal.appendChild(b);});
      side.appendChild(pal);

      const my=document.createElement("div");my.className="mlb-section";my.innerHTML='<div class="mlb-title">My Bricks</div>';
      const defs=Object.values(state.custom_components||{});
      if(!defs.length){const n=document.createElement("div");n.className="mlb-note";n.textContent="Create reusable nested components from your layers.";my.appendChild(n);}
      else defs.forEach(def=>{const b=document.createElement("button");b.type="button";b.className="mlb-custom-item";b.textContent=def.name+" · v"+def.revision;b.addEventListener("click",()=>addCustom(def));my.appendChild(b);});
      side.appendChild(my);

      const canvas=document.createElement("main");canvas.className="mlb-canvas";
      const crumbs=document.createElement("div");crumbs.className="mlb-breadcrumbs";
      state.breadcrumbs.forEach((c,i)=>{const b=btn(c.name,"mlb-crumb");b.addEventListener("click",()=>{state.view_component_id=c.id;state.breadcrumbs=state.breadcrumbs.slice(0,i+1);selected=null;draw();});crumbs.appendChild(b);if(i<state.breadcrumbs.length-1){const s=document.createElement("span");s.textContent="/";crumbs.appendChild(s);}});
      canvas.appendChild(crumbs);

      const flow=document.createElement("div");flow.className="mlb-flow";
      const comp=current(state);
      if(!comp.nodes.length){const e=document.createElement("div");e.className="mlb-empty";e.textContent="Add layers from the left. The model stays aligned left → right.";flow.appendChild(e);}
      else comp.nodes.forEach((n,i)=>{
        if(i){const a=document.createElement("div");a.className="mlb-arrow";a.textContent="→";flow.appendChild(a);}
        const el=document.createElement("div");el.className="mlb-node"+(n.id===selected?" selected":"");
        el.innerHTML='<span class="mlb-port in"></span><div class="name"></div><div class="meta"></div><div class="meta"></div><span class="mlb-port out"></span>';
        el.querySelector(".name").textContent=n.name;
        const meta=el.querySelectorAll(".meta");
        meta[0].textContent=n.type==="custom"?"Custom Component":String(n.type).toUpperCase();
        meta[1].textContent=(n.repeat||1)>1?"Repeat ×"+n.repeat:"Layer";
        el.addEventListener("click",()=>{selected=n.id;draw();});
        flow.appendChild(el);
      });
      canvas.appendChild(flow);

      const ins=document.createElement("aside");ins.className="mlb-inspector";ins.innerHTML='<div class="mlb-title">Layer Inspector</div>';
      const n=selectedNode();
      if(!n){const note=document.createElement("div");note.className="mlb-note";note.textContent="Select a layer to edit it.";ins.appendChild(note);}
      else{
        const nf=document.createElement("div");nf.className="mlb-field";const nl=document.createElement("label");nl.textContent="Name";const ni=document.createElement("input");ni.value=n.name;ni.addEventListener("change",()=>{n.name=ni.value.trim()||n.name;draw();});nf.append(nl,ni);ins.appendChild(nf);
        const rf=document.createElement("div");rf.className="mlb-field";const rl=document.createElement("label");rl.textContent="Repeat";const ri=document.createElement("input");ri.type="number";ri.min="1";ri.max="100000";ri.value=n.repeat||1;ri.addEventListener("change",()=>{n.repeat=Math.max(1,Math.min(100000,Number(ri.value)||1));draw();});rf.append(rl,ri);ins.appendChild(rf);
        const acts=document.createElement("div");acts.className="mlb-actions";
        if(n.definition_id){const o=btn("Open Inside");o.addEventListener("click",()=>openInside(n));acts.appendChild(o);}
        const d=btn("Delete Layer");d.addEventListener("click",()=>{current(state).nodes=current(state).nodes.filter(x=>x.id!==n.id);selected=null;draw();});acts.appendChild(d);ins.appendChild(acts);
      }

      if(current(state).kind==="custom_edit"){
        const sec=document.createElement("div");sec.className="mlb-section";sec.innerHTML='<div class="mlb-title">Custom Component</div>';
        const ov=btn("Override / New Revision");ov.addEventListener("click",()=>saveCustom(false));sec.appendChild(ov);
        const sn=btn("Save As New");sn.style.marginTop="6px";sn.addEventListener("click",()=>saveCustom(true));sec.appendChild(sn);
        ins.appendChild(sec);
      }

      layout.append(side,canvas,ins);root.appendChild(layout);
      const foot=document.createElement("div");foot.className="mlb-status";foot.textContent=message;root.appendChild(foot);
    }
    draw();
  }

  window.MLBricksBuilder={mount};
})();
