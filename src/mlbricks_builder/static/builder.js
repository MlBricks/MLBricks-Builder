(function(){
  // Always overwrite any renderer left by an older notebook output.
  // Kaggle keeps browser globals even when Python modules are reinstalled.

  function cp(v){return JSON.parse(JSON.stringify(v));}
  function uid(p){return p+"_"+Math.random().toString(36).slice(2,10);}
  function current(state){return state.components[state.view_component_id];}
  function cat(catalog,type){return catalog.find(x=>x.type===type)||{};}
  function edge(a,b,kind="main"){return{id:uid("edge"),source:a,target:b,source_port:"out",target_port:"in",kind};}

  function makeNode(item){
    const params={};
    (item.api||[]).forEach(f=>{
      if(f.value!==undefined) params[f.key]=f.value;
    });
    return {
      id:uid("node"),
      type:item.type,
      name:item.name,
      definition_id:null,
      repeat:1,
      params,
      input_count:item.type==="residual"?2:1,
      output_count:1,
      position:{x:0,y:0}
    };
  }

  function mount(root,payload){
    if(!root || root.dataset.mounted==="1") return;
    root.dataset.mounted="1";

    const state=cp(payload.state);
    const catalog=cp(payload.catalog);
    const mlapi=cp(payload.mlbricks_api||{});
    let selected=null,pendingPort=null,filter="All",search="",inspectorTab="settings",zoom=1,status="Ready";

    Object.values(state.components||{}).forEach(c=>{if(!c.edges)c.edges=[];});
    if(state.auto_connect===undefined) state.auto_connect=true;

    function btn(text,cls){const b=document.createElement("button");b.type="button";b.className=cls||"";b.textContent=text;return b;}
    function selectedNode(){return current(state).nodes.find(n=>n.id===selected)||null;}
    function setStatus(s){status=s;}

    function apiInfo(node){
      if(node.type==="custom") return {public_name:"Custom Layer",parameters:[],available:true};
      return mlapi[node.type] || cat(catalog,node.type).real_api || {};
    }

    function pythonValue(v){
      if(v===null||v===undefined||v==="") return "None";
      if(typeof v==="boolean") return v?"True":"False";
      if(typeof v==="number") return String(v);
      if(v==="true") return "True";
      if(v==="false") return "False";
      return JSON.stringify(v);
    }

    function constructorPreview(node){
      const api=apiInfo(node);
      if(node.type==="custom") return "# Nested custom MLBricks layer";
      if(!api?.available) return "# MLBricks API unavailable";
      const args=[];
      (api.parameters||[]).forEach(f=>{
        let v=node.params?.[f.key];
        if(v===undefined || v===null || v==="") v=f.value;
        if((v===undefined || v===null) && f.required) return;
        if(v===undefined || v===null) return;
        args.push(f.key+"="+pythonValue(v));
      });
      const varname=(node.name||"layer").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"layer";
      if(api.config_api){
        const cfgName=api.config_api.public_name;
        return "from mlbricks import "+api.public_name+", "+cfgName+"\n\n"+
          "config = "+cfgName+"("+args.join(", ")+")\n"+
          varname+" = "+api.public_name+"(config)";
      }
      return "from mlbricks import "+api.public_name+"\n\n"+varname+" = "+api.public_name+"("+args.join(", ")+")";
    }

    function connect(a,b,kind="main",sourcePort="out0",targetPort="in0"){
      if(a===b){setStatus("A layer cannot connect to itself.");return;}
      const c=current(state);
      if(c.edges.some(e=>e.source===a&&e.target===b&&e.kind===kind&&e.source_port===sourcePort&&e.target_port===targetPort)){setStatus("Connection already exists.");return;}
      const e=edge(a,b,kind);e.source_port=sourcePort;e.target_port=targetPort;c.edges.push(e);
      setStatus(kind==="residual"?"Residual pipeline created.":"Connection created.");
    }

    function autoConnectNew(node){
      const c=current(state);if(!state.auto_connect||c.nodes.length<2)return;
      const targetPort=node.type==="residual"&&node.input_count>0?"in0":"in0";
      connect(c.nodes[c.nodes.length-2].id,node.id,"main","out0",targetPort);
    }

    function addPrimitive(item){
      const n=makeNode(item);current(state).nodes.push(n);autoConnectNew(n);selected=n.id;draw();
    }

    function createCustom(){
      const c=current(state);
      if(!c.nodes.length){setStatus("Add layers first.");draw();return;}
      const name=prompt("Component name:","My Component");if(!name)return;
      const id=uid("custom");
      state.custom_components[id]={
        id,name,
        description:"Reusable nested layer",
        revision:1,
        nodes:cp(c.nodes),
        edges:cp(c.edges||[]),
        input_count:1,
        output_count:1
      };
      setStatus(name+" saved to My Bricks.");draw();
    }

    function addCustom(def){
      const n={
        id:uid("node"),
        type:"custom",
        name:def.name,
        definition_id:def.id,
        repeat:1,
        params:{},
        input_count:def.input_count||1,
        output_count:def.output_count||1,
        position:{x:0,y:0}
      };
      current(state).nodes.push(n);autoConnectNew(n);selected=n.id;draw();
    }

    function openInside(node){
      if(!node.definition_id)return;
      const def=state.custom_components[node.definition_id];if(!def)return;
      const vid="view_"+def.id+"_"+uid("n");
      state.components[vid]={
        id:vid,
        name:def.name,
        kind:"custom_edit",
        definition_id:def.id,
        revision:def.revision,
        input_count:def.input_count||1,
        output_count:def.output_count||1,
        nodes:cp(def.nodes),
        edges:cp(def.edges||[])
      };
      state.view_component_id=vid;state.breadcrumbs.push({id:vid,name:def.name});selected=null;pendingPort=null;draw();
    }

    function saveCustom(asNew){
      const c=current(state),def=state.custom_components[c.definition_id];if(!def)return;
      if(asNew){
        const name=prompt("Save as new component:",def.name+" Copy");if(!name)return;
        const id=uid("custom");state.custom_components[id]={
          id,name,
          description:def.description||"",
          revision:1,
          nodes:cp(c.nodes),
          edges:cp(c.edges||[]),
          input_count:c.input_count||def.input_count||1,
          output_count:c.output_count||def.output_count||1
        };
        setStatus(name+" created.");
      }else{
        def.nodes=cp(c.nodes);
        def.edges=cp(c.edges||[]);
        def.input_count=c.input_count||def.input_count||1;
        def.output_count=c.output_count||def.output_count||1;
        def.revision=(def.revision||1)+1;c.revision=def.revision;
        setStatus(def.name+" updated to v"+def.revision+".");
      }
      draw();
    }

    function deleteNode(id){
      const c=current(state);c.nodes=c.nodes.filter(n=>n.id!==id);c.edges=c.edges.filter(e=>e.source!==id&&e.target!==id);
      if(selected===id)selected=null;draw();
    }

    function duplicateSelected(){
      const n=selectedNode();if(!n)return;
      const c=current(state),d=cp(n);d.id=uid("node");d.name=n.name+" Copy";
      const idx=c.nodes.findIndex(x=>x.id===n.id);c.nodes.splice(idx+1,0,d);selected=d.id;setStatus("Layer duplicated.");draw();
    }

    function portClick(nodeId,side,portIndex,ev){
      ev.stopPropagation();
      if(side==="out"){
        pendingPort={nodeId,side,portIndex};
        setStatus("Output selected. Click an input port.");
        draw();
        return;
      }
      if(side==="in"&&pendingPort?.side==="out"){
        const kind=ev.shiftKey?"residual":"main";
        connect(pendingPort.nodeId,nodeId,kind,"out"+pendingPort.portIndex,"in"+portIndex);
        pendingPort=null;
        draw();
        return;
      }
      pendingPort={nodeId,side,portIndex};
      setStatus("Input selected. Choose an output port.");
      draw();
    }

    function renderField(body,node,f){
      const wrap=document.createElement("div");wrap.className="mlb-field";
      const label=document.createElement("label");label.textContent=f.label+(f.required?" *":"");
      let input;
      if(f.type==="select"){
        input=document.createElement("select");
        (f.options||[]).forEach(v=>{const o=document.createElement("option");o.value=v;o.textContent=v;if(String(node.params?.[f.key]??f.value)===String(v))o.selected=true;input.appendChild(o);});
      }else if(f.type==="bool"){
        input=document.createElement("select");["true","false"].forEach(v=>{const o=document.createElement("option");o.value=v;o.textContent=v;if(String(node.params?.[f.key]??f.value)===v)o.selected=true;input.appendChild(o);});
      }else{
        input=document.createElement("input");input.type=f.type==="number"?"number":"text";input.step="any";input.value=node.params?.[f.key]??f.value??"";
      }
      input.addEventListener("change",()=>{node.params=node.params||{};node.params[f.key]=f.type==="number"?Number(input.value):input.value;setStatus(node.name+" API updated.");});
      wrap.append(label,input);body.appendChild(wrap);
    }


    function portButtons(node, side){
      const count=Math.max(1, Number(side==="in" ? (node.input_count||1) : (node.output_count||1)));
      let html="";
      for(let i=0;i<count;i++){
        const top = count===1 ? 50 : (20 + (60*i/Math.max(1,count-1)));
        html += '<button class="mlb-port '+side+'" data-side="'+side+'" data-port-index="'+i+'" style="top:'+top+'%" type="button" aria-label="'+side+' port '+(i+1)+'"></button>';
      }
      return html;
    }
    function nodeMiniFields(node,info){
      const api=apiInfo(node);const source=(api.parameters||info.api||[]).slice(0,4);
      return source.map(f=>{
        let v=node.params?.[f.key];if(v===undefined||v===null||v==="")v=f.value;
        if(v===undefined||v===null||v==="")return "";
        return '<div class="mlb-mini-field"><span>'+f.label+'</span><strong>'+String(v)+'</strong></div>';
      }).join("");
    }

    function drawEdges(wrap,flow){
      const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("class","mlb-edge-layer");
      svg.setAttribute("width",Math.max(flow.scrollWidth,flow.getBoundingClientRect().width));svg.setAttribute("height",Math.max(flow.scrollHeight,520));wrap.appendChild(svg);
      const wr=wrap.getBoundingClientRect();

      function portRect(nodeEl, side, index){
        const el=nodeEl.querySelector('.mlb-port[data-side="'+side+'"][data-port-index="'+index+'"]');
        return el ? el.getBoundingClientRect() : nodeEl.getBoundingClientRect();
      }

      (current(state).edges||[]).forEach(e=>{
        const a=flow.querySelector('[data-node-id="'+e.source+'"]'),b=flow.querySelector('[data-node-id="'+e.target+'"]');if(!a||!b)return;
        const sourceIndex = Number(String(e.source_port||"out0").replace("out","")) || 0;
        const targetIndex = Number(String(e.target_port||"in0").replace("in","")) || 0;
        const ar=portRect(a,"out",sourceIndex), br=portRect(b,"in",targetIndex);
        const x1=ar.left-wr.left + ar.width/2, y1=ar.top-wr.top + ar.height/2;
        const x2=br.left-wr.left + br.width/2, y2=br.top-wr.top + br.height/2;
        const p=document.createElementNS("http://www.w3.org/2000/svg","path");
        if(e.kind==="residual"){
          const startNode = a.getBoundingClientRect();
          const endNode = b.getBoundingClientRect();
          const topY = Math.min(startNode.top-wr.top, endNode.top-wr.top) - 42;
          p.setAttribute("d",`M ${x1} ${y1} C ${x1+12} ${y1}, ${x1+6} ${topY}, ${x1} ${topY}
                               L ${x2} ${topY}
                               C ${x2-6} ${topY}, ${x2-12} ${y2}, ${x2} ${y2}`);
          p.setAttribute("class","mlb-edge-residual-pipeline");
          const tap1=document.createElementNS("http://www.w3.org/2000/svg","circle");
          tap1.setAttribute("cx", x1); tap1.setAttribute("cy", topY); tap1.setAttribute("r", 4.5); tap1.setAttribute("class","mlb-edge-residual-tap");
          const tap2=document.createElementNS("http://www.w3.org/2000/svg","circle");
          tap2.setAttribute("cx", x2); tap2.setAttribute("cy", topY); tap2.setAttribute("r", 4.5); tap2.setAttribute("class","mlb-edge-residual-tap");
          svg.appendChild(p); svg.appendChild(tap1); svg.appendChild(tap2);
        } else {
          const mid=(x1+x2)/2;
          p.setAttribute("d",`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
          p.setAttribute("class","mlb-edge-main");
          svg.appendChild(p);
        }
      });
    }

    function loadTinyStories(){
      const rootId=state.root_component_id;
      state.view_component_id=rootId;
      state.project={...(state.project||{}),name:"TinyStories 30M",context_length:512,batch_size:16,dataset:"TinyStories",estimated_parameters:"~30M"};
      state.breadcrumbs=[{id:rootId,name:"TinyStories 30M"}];
      const defId=uid("custom");
      const esa=makeNode(cat(catalog,"esa")),norm=makeNode(cat(catalog,"rmsnorm")),ffn=makeNode(cat(catalog,"ffn")),res=makeNode(cat(catalog,"residual"));
      state.custom_components[defId]={
        id:defId,
        name:"TinyStories ESA Block",
        revision:1,
        description:"ESA → RMSNorm → FFN → Residual",
        input_count:1,
        output_count:1,
        nodes:[esa,norm,ffn,res],
        edges:[
          edge(esa.id,norm.id),
          edge(norm.id,ffn.id),
          Object.assign(edge(ffn.id,res.id),{source_port:"out0",target_port:"in0"}),
          Object.assign(edge(esa.id,res.id,"residual"),{source_port:"out0",target_port:"in1"})
        ]
      };
      const nodes=[];
      const input=makeNode(cat(catalog,"text_input"));nodes.push(input);
      const emb=makeNode(cat(catalog,"embedding"));nodes.push(emb);
      for(let i=1;i<=6;i++)nodes.push({id:uid("node"),type:"custom",name:"Layer "+i,definition_id:defId,repeat:1,params:{},position:{x:0,y:0}});
      const head=makeNode(cat(catalog,"lm_head")),out=makeNode(cat(catalog,"text_output"));nodes.push(head,out);
      const edges=[];for(let i=0;i<nodes.length-1;i++)edges.push(edge(nodes[i].id,nodes[i+1].id));
      state.components[rootId]={id:rootId,name:"TinyStories 30M",kind:"model",revision:1,nodes,edges};
      selected=null;pendingPort=null;setStatus("TinyStories starter loaded.");draw();
    }

    function draw(){
      root.innerHTML="";

      // Top bar
      const top=document.createElement("div");top.className="mlb-topbar";
      const logo=document.createElement("div");logo.className="mlb-logo";logo.innerHTML='<span class="mlb-logo-mark">◇</span>MLBricks Builder <span class="mlb-beta">v0.3.3</span>';top.appendChild(logo);
      const title=document.createElement("div");title.className="mlb-project-title";title.textContent=state.project?.name||"Untitled";top.appendChild(title);
      const saved=document.createElement("div");saved.className="mlb-save-state";saved.textContent="• Saved";top.appendChild(saved);
      const sp=document.createElement("div");sp.className="mlb-topspacer";top.appendChild(sp);
      const acts=document.createElement("div");acts.className="mlb-top-actions";
      const run=btn("▶ Run","mlb-run");run.addEventListener("click",()=>{setStatus("Graph ready for MLBricks runtime compilation.");draw();});
      acts.append(run,btn("□ Stop","mlb-stop"),btn("↻ Clear","mlb-dark-btn"),btn("▣ Save","mlb-dark-btn"),btn("⇧ Load","mlb-dark-btn"),btn("⇩ Export","mlb-dark-btn"),btn("⌯ Share","mlb-dark-btn"),btn("?","mlb-dark-btn"),btn("⚙","mlb-dark-btn"));top.appendChild(acts);
      root.appendChild(top);

      const shell=document.createElement("div");shell.className="mlb-shell";

      // Sidebar
      const side=document.createElement("aside");side.className="mlb-sidebar";
      const head=document.createElement("div");head.className="mlb-sidehead";head.innerHTML="<span>BRICK LIBRARY</span><span>×</span>";side.appendChild(head);
      const sr=document.createElement("div");sr.className="mlb-search-row";
      const searchInput=document.createElement("input");searchInput.className="mlb-search";searchInput.placeholder="Search bricks...";searchInput.value=search;searchInput.addEventListener("input",()=>{search=searchInput.value;draw();});
      sr.append(searchInput,btn("☷","mlb-filter-btn"));side.appendChild(sr);
      const chips=document.createElement("div");chips.className="mlb-chips";
      ["All","Inputs","Core Blocks","Norm","Heads","Outputs"].forEach(x=>{const b=btn(x.replace(" Blocks",""),"mlb-chip"+(filter===x?" active":""));b.addEventListener("click",()=>{filter=x;draw();});chips.appendChild(b);});side.appendChild(chips);

      const visible=catalog.filter(item=>{
        const q=(item.name+" "+item.description+" "+item.category).toLowerCase();
        if(search&&!q.includes(search.toLowerCase()))return false;
        if(filter==="All")return true;
        if(filter==="Norm")return ["rmsnorm","layernorm"].includes(item.type);
        return item.category===filter;
      });

      [...new Set(visible.map(x=>x.category))].forEach(category=>{
        const h=document.createElement("div");h.className="mlb-category";h.innerHTML="<span>"+category+"</span><span>⌃</span>";side.appendChild(h);
        const pal=document.createElement("div");pal.className="mlb-palette";
        visible.filter(x=>x.category===category).forEach(item=>{
          const b=document.createElement("button");b.type="button";
          const ico=document.createElement("span");ico.className="mlb-pal-icon";ico.textContent=item.icon||"ML";
          const text=document.createElement("span");text.innerHTML="<strong>"+item.name+'</strong><span class="mlb-pal-sub">'+(item.description||"MLBricks component")+"</span>";
          b.append(ico,text);b.addEventListener("click",()=>addPrimitive(item));pal.appendChild(b);
        });side.appendChild(pal);
      });
      const mh=document.createElement("div");mh.className="mlb-category";mh.innerHTML="<span>MY BRICKS</span><span>⌃</span>";side.appendChild(mh);
      Object.values(state.custom_components||{}).forEach(def=>{
        const b=document.createElement("button");b.className="mlb-custom-card";b.type="button";
        b.innerHTML='<span class="mlb-pal-icon">MY</span><span><strong>'+def.name+'</strong><span class="mlb-pal-sub">Custom · v'+def.revision+"</span></span>";
        b.addEventListener("click",()=>addCustom(def));side.appendChild(b);
      });
      const create=btn("+ Create Custom Brick","mlb-create");create.addEventListener("click",createCustom);side.appendChild(create);

      // Main
      const main=document.createElement("main");main.className="mlb-main";
      const toolbar=document.createElement("div");toolbar.className="mlb-toolbar";
      const auto=btn("◎ Auto Layout","mlb-tool");auto.addEventListener("click",()=>{setStatus("Layer-by-layer auto layout applied.");draw();});
      const add=btn("+ Add Layer","mlb-tool");add.addEventListener("click",()=>{setStatus("Choose a brick from the library.");draw();});
      const demo=btn("★ TinyStories 30M","mlb-tool");demo.addEventListener("click",loadTinyStories);
      toolbar.append(auto,add,demo);
      const tsp=document.createElement("div");tsp.className="mlb-toolspacer";toolbar.appendChild(tsp);
      const toggle=document.createElement("label");toggle.className="mlb-toggle";const cb=document.createElement("input");cb.type="checkbox";cb.checked=!!state.auto_connect;cb.addEventListener("change",()=>{state.auto_connect=cb.checked;draw();});toggle.append(document.createTextNode("Auto Connect"),cb);toolbar.appendChild(toggle);
      const z=document.createElement("div");z.className="mlb-zoom";
      const zm=btn("−");zm.addEventListener("click",()=>{zoom=Math.max(.65,zoom-.1);draw();});
      const zs=document.createElement("span");zs.textContent=Math.round(zoom*100)+"%";
      const zp=btn("+");zp.addEventListener("click",()=>{zoom=Math.min(1.5,zoom+.1);draw();});z.append(zm,zs,zp);toolbar.appendChild(z);
      main.appendChild(toolbar);

      const canvas=document.createElement("div");canvas.className="mlb-canvas";
      const ctop=document.createElement("div");ctop.className="mlb-canvas-top";
      const crumbs=document.createElement("div");crumbs.className="mlb-breadcrumbs";
      state.breadcrumbs.forEach((c,i)=>{const b=btn(c.name,"mlb-crumb");b.addEventListener("click",()=>{state.view_component_id=c.id;state.breadcrumbs=state.breadcrumbs.slice(0,i+1);selected=null;draw();});crumbs.appendChild(b);if(i<state.breadcrumbs.length-1){const s=document.createElement("span");s.textContent="/";crumbs.appendChild(s);}});
      ctop.appendChild(crumbs);canvas.appendChild(ctop);

      const mini=document.createElement("div");mini.className="mlb-minimap";const mg=document.createElement("div");mg.className="mlb-minimap-grid";current(state).nodes.forEach(()=>{const m=document.createElement("div");m.className="mlb-mini-node";mg.appendChild(m);});mini.appendChild(mg);canvas.appendChild(mini);

      const wrap=document.createElement("div");wrap.className="mlb-flow-wrap";
      const flow=document.createElement("div");flow.className="mlb-flow";flow.style.transformOrigin="left center";flow.style.transform="scale("+zoom+")";
      const comp=current(state);

      if(!comp.nodes.length){
        const e=document.createElement("div");e.className="mlb-empty";e.innerHTML="<strong>Build your model layer by layer.</strong><br><br>Add a brick from the left or load TinyStories 30M.";flow.appendChild(e);
      }else{
        comp.nodes.forEach((n,i)=>{
          if(i){const a=document.createElement("div");a.className="mlb-arrow";a.textContent="→";flow.appendChild(a);}
          const info=n.type==="custom"?{accent:"purple",description:"Nested reusable layer",icon:"LAY",api:[]}:cat(catalog,n.type);
          const card=document.createElement("div");card.className="mlb-node"+(selected===n.id?" selected":"");card.dataset.nodeId=n.id;card.dataset.accent=info.accent||"purple";
          card.innerHTML='<span class="index">'+(i+1)+'</span>'+portButtons(n,"in")+'<div class="node-head"><div class="node-name"></div><div class="node-icon"></div></div><div class="node-desc"></div><div class="mlb-node-fields"></div><div class="node-meta"></div>'+portButtons(n,"out");
          card.querySelector(".node-name").textContent=n.name;card.querySelector(".node-icon").textContent=info.icon||"ML";card.querySelector(".node-desc").textContent=info.description||"MLBricks layer";
          card.querySelector(".mlb-node-fields").innerHTML=n.type==="custom"
            ?('<div class="mlb-mini-field"><span>Architecture</span><strong>Open</strong></div>'+
              '<div class="mlb-mini-field"><span>Inputs</span><strong>'+(n.input_count||1)+'</strong></div>'+
              '<div class="mlb-mini-field"><span>Outputs</span><strong>'+(n.output_count||1)+'</strong></div>')
            :nodeMiniFields(n,info);
          const meta=card.querySelector(".node-meta");
          meta.textContent=n.type==="custom"?"Nested component · double-click to edit":((apiInfo(n).public_name||n.type)+" · "+(n.input_count||1)+" in / "+(n.output_count||1)+" out");
          card.querySelectorAll('.mlb-port').forEach(portEl=>{
            const side=portEl.dataset.side, idx=Number(portEl.dataset.portIndex||0);
            if(pendingPort?.nodeId===n.id&&pendingPort.side===side&&pendingPort.portIndex===idx) portEl.classList.add("armed");
            portEl.addEventListener("click",ev=>portClick(n.id,side,idx,ev));
          });
          card.addEventListener("click",()=>{selected=n.id;draw();});card.addEventListener("dblclick",()=>{if(n.definition_id)openInside(n);});
          flow.appendChild(card);
        });
      }
      wrap.appendChild(flow);canvas.appendChild(wrap);
      const hint=document.createElement("div");hint.className="mlb-hint";
      hint.textContent=pendingPort
        ?"Choose destination input port • Hold Shift to create residual pipeline"
        :"Auto-connect builds the layer flow. For custom wiring click an output port, then an input port. Double-click nested layers to edit.";
      canvas.appendChild(hint);
      main.appendChild(canvas);
      requestAnimationFrame(()=>drawEdges(wrap,flow));

      // Bottom dashboard
      const panels=document.createElement("div");panels.className="mlb-bottom-panels";
      const p1=document.createElement("div");p1.className="mlb-bottom-card";p1.innerHTML='<div class="mlb-bottom-title">PRESETS</div><div class="mlb-preset-card"><strong>★ TinyStories 30M (6L)</strong>Context 512 · Batch 16<br>~30M parameters</div>';p1.querySelector(".mlb-preset-card").addEventListener("click",loadTinyStories);
      const p2=document.createElement("div");p2.className="mlb-bottom-card";p2.innerHTML='<div class="mlb-bottom-title">GRAPH INFO</div><div class="mlb-stat-row"><span>Layers</span><strong>'+current(state).nodes.length+'</strong></div><div class="mlb-stat-row"><span>Connections</span><strong>'+(current(state).edges||[]).length+'</strong></div><div class="mlb-stat-row"><span>Context</span><strong>'+(state.project?.context_length||"—")+'</strong></div><div class="mlb-stat-row"><span>Batch Size</span><strong>'+(state.project?.batch_size||"—")+'</strong></div><div class="mlb-stat-row"><span>Status</span><strong class="mlb-good">✓ Valid</strong></div>';
      const p3=document.createElement("div");p3.className="mlb-bottom-card";p3.innerHTML='<div class="mlb-bottom-title">COMPUTE ESTIMATE</div><div class="mlb-stat-row"><span>Target Params</span><strong>'+(state.project?.estimated_parameters||"—")+'</strong></div><div class="mlb-stat-row"><span>Dataset</span><strong>'+(state.project?.dataset||"—")+'</strong></div><div class="mlb-stat-row"><span>Precision</span><strong>float16</strong></div><div class="mlb-stat-row"><span>Backend</span><strong>MLBricks</strong></div>';
      const p4=document.createElement("div");p4.className="mlb-bottom-card";p4.innerHTML='<div class="mlb-bottom-title">SHORTCUTS</div><div class="mlb-stat-row"><span>Connect</span><strong>Out port → In port</strong></div><div class="mlb-stat-row"><span>Residual</span><strong>Shift + click input</strong></div><div class="mlb-stat-row"><span>Custom Ports</span><strong>Editable in inspector</strong></div><div class="mlb-stat-row"><span>Open Layer</span><strong>Double Click</strong></div>';
      panels.append(p1,p2,p3,p4);main.appendChild(panels);

      // Inspector
      const ins=document.createElement("aside");ins.className="mlb-inspector";
      const tabs=document.createElement("div");tabs.className="mlb-ins-tabs";
      [["settings","Inspector"],["info","Node Info"]].forEach(([k,t])=>{const b=btn(t);if(inspectorTab===k)b.className="active";b.addEventListener("click",()=>{inspectorTab=k;draw();});tabs.appendChild(b);});ins.appendChild(tabs);
      const body=document.createElement("div");body.className="mlb-ins-body";
      const n=selectedNode();

      if(!n){
        body.innerHTML='<div class="mlb-section-title">SELECT A NODE</div><div class="mlb-api-path">Click any component to open its real installed MLBricks API here.</div>';
      }else if(inspectorTab==="info"){
        const api=apiInfo(n);body.innerHTML='<div class="mlb-selected"><strong>'+n.name+'</strong><span class="mlb-pill">'+(api.public_name||"Custom")+'</span></div>';
        const s=document.createElement("div");s.className="mlb-summary";[["Type",n.type],["Definition",n.definition_id?"Custom":"Built-in"],["Repeat",n.repeat||1],["API",api.import_path||"custom"],["Status","Valid"]].forEach(([a,b])=>{const r=document.createElement("div");r.className="mlb-summary-row";r.innerHTML="<span>"+a+"</span><strong>"+b+"</strong>";s.appendChild(r);});body.appendChild(s);
      }else{
        const api=apiInfo(n);const info=n.type==="custom"?{api:[]}:cat(catalog,n.type);
        const sw=document.createElement("div");sw.className="mlb-selected";sw.innerHTML="<strong>"+n.name+"</strong><span class='mlb-pill'>"+(api.public_name||"Custom Layer")+"</span>";body.appendChild(sw);
        const path=document.createElement("div");path.className="mlb-api-path";
        path.textContent=n.type==="custom"?"custom://"+n.definition_id:(api.signature||api.import_path||"MLBricks API");
        body.appendChild(path);
        if(n.type!=="custom"){
          const apiStatus=document.createElement("div");
          apiStatus.className="mlb-api-status "+(api.available?"ok":"bad");
          if(api.available && api.runtime_available===true){
            apiStatus.textContent="✓ Real MLBricks API: "+(api.import_path||api.public_name);
          }else if(api.available){
            apiStatus.textContent="✓ API loaded from MLBricks source: "+(api.public_name||n.type);
            apiStatus.title=api.runtime_error||"Runtime import was not required for the inspector.";
          }else{
            apiStatus.textContent="✕ API unavailable";
          }
          body.appendChild(apiStatus);
        }
        if(n.type==="custom"){
          const def=state.custom_components[n.definition_id];
          const s=document.createElement("div");s.className="mlb-summary";
          [["Internal Components",def?.nodes?.length||0],["Connections",def?.edges?.length||0],["Revision","v"+(def?.revision||1)]].forEach(([a,b])=>{const r=document.createElement("div");r.className="mlb-summary-row";r.innerHTML="<span>"+a+"</span><strong>"+b+"</strong>";s.appendChild(r);});
          body.appendChild(s);
          const st=document.createElement("div");st.className="mlb-section-title";st.textContent="CUSTOM PORTS";body.appendChild(st);
          [{key:"input_count",label:"Input Connections"},{key:"output_count",label:"Output Connections"}].forEach(f=>{
            const wrap=document.createElement("div");wrap.className="mlb-field";
            const label=document.createElement("label");label.textContent=f.label;
            const input=document.createElement("input");input.type="number";input.min="1";input.max="8";input.value=n[f.key]||1;
            input.addEventListener("change",()=>{
              n[f.key]=Math.max(1,Math.min(8,Number(input.value)||1));
              if(def){def[f.key]=n[f.key];}
              setStatus("Custom layer ports updated.");
              draw();
            });
            wrap.append(label,input);body.appendChild(wrap);
          });
        }else{
          const st=document.createElement("div");st.className="mlb-section-title";st.textContent="PARAMETERS";body.appendChild(st);
          (api.parameters||info.api||[]).forEach(f=>renderField(body,n,f));
          const ct=document.createElement("div");ct.className="mlb-section-title";ct.textContent="MLBRICKS PYTHON";body.appendChild(ct);
          const code=document.createElement("pre");code.className="mlb-code-preview";code.textContent=constructorPreview(n);body.appendChild(code);
        }
        const actions=document.createElement("div");actions.className="mlb-action-grid";
        if(n.definition_id){const open=btn("Open Architecture");open.addEventListener("click",()=>openInside(n));actions.appendChild(open);}
        const dup=btn("Duplicate");dup.addEventListener("click",duplicateSelected);actions.appendChild(dup);
        const disc=btn("Disconnect");disc.addEventListener("click",()=>{current(state).edges=current(state).edges.filter(e=>e.source!==n.id&&e.target!==n.id);draw();});actions.appendChild(disc);
        const del=btn("Delete");del.addEventListener("click",()=>deleteNode(n.id));actions.appendChild(del);body.appendChild(actions);
        if(current(state).kind==="custom_edit"){
          const parentCfg=document.createElement("div");
          parentCfg.className="mlb-summary";
          parentCfg.innerHTML='<div class="mlb-summary-row"><span>Custom Layer Interface</span><strong>'+(current(state).input_count||1)+' in / '+(current(state).output_count||1)+' out</strong></div>';
          body.appendChild(parentCfg);

          const sv=document.createElement("div");sv.className="mlb-action-grid";const ov=btn("Override");ov.addEventListener("click",()=>saveCustom(false));const sn=btn("Save As New");sn.addEventListener("click",()=>saveCustom(true));sv.append(ov,sn);body.appendChild(sv);
        }
      }
      ins.appendChild(body);

      shell.append(side,main,ins);root.appendChild(shell);

      const stat=document.createElement("div");stat.className="mlb-statusbar";stat.innerHTML='<span>Mode: Builder⌄</span><span>Backend: MLBricks Runtime</span><span>GPU: Auto</span><span class="right mlb-ready">● '+status+"</span>";root.appendChild(stat);
    }

    draw();
  }

  window.MLBricksBuilder={mount};
})();
