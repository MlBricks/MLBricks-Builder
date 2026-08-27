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
      input_count:3,
      output_count:3,
      position:{x:0,y:0}
    };
  }


  function mount(root,payload){
    if(!root || root.dataset.mounted==="1") return;
    root.dataset.mounted="1";

    let state=cp(payload.state);
    const catalog=cp(payload.catalog);
    const mlapi=cp(payload.mlbricks_api||{});
    let selected=null,pendingPort=null,filter="All",search="",inspectorTab="settings",zoom=1,status="Ready";
    let canvasScrollLeft=0,canvasScrollTop=0;
    const undoStack=[],redoStack=[];
    const historyLimit=60;

    function snapshot(){ return cp(state); }
    function checkpoint(label){
      undoStack.push({state:snapshot(),label:label||"Edit"});
      if(undoStack.length>historyLimit) undoStack.shift();
      redoStack.length=0;
    }
    function undo(){
      if(!undoStack.length){setStatus("Nothing to undo.");draw();return;}
      redoStack.push({state:snapshot(),label:"Redo"});
      const item=undoStack.pop();
      state=cp(item.state);
      selected=null;pendingPort=null;
      setStatus("Undo: "+item.label);
      draw();
    }
    function redo(){
      if(!redoStack.length){setStatus("Nothing to redo.");draw();return;}
      undoStack.push({state:snapshot(),label:"Undo"});
      const item=redoStack.pop();
      state=cp(item.state);
      selected=null;pendingPort=null;
      setStatus("Redo");
      draw();
    }

    // Compact notebook defaults: keep the most-used sections open and the rest collapsed.
    const collapsedCategories=new Set(["Advanced","Position","Heads","Outputs"]);
    let myBricksCollapsed=false;
    let bottomExpanded=false;

    Object.values(state.components||{}).forEach(c=>{if(!c.edges)c.edges=[];});
    if(state.auto_connect===undefined) state.auto_connect=true;

    function btn(text,cls){const b=document.createElement("button");b.type="button";b.className=cls||"";b.textContent=text;return b;}
    function portLabel(side,index){
      const lane=["Skip","Main","Extra"][index] || ("Lane "+(index+1));
      return lane+" "+(side==="in"?"In":"Out");
    }

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

    function connect(a,b,kind="main",sourcePort="main_out",targetPort="main_in",record=true){
      if(a===b){setStatus("A layer cannot connect to itself.");return;}
      const c=current(state);
      if(c.edges.some(e=>e.source===a&&e.target===b&&e.kind===kind&&e.source_port===sourcePort&&e.target_port===targetPort)){
        setStatus("Connection already exists.");return;
      }
      if(record) checkpoint(kind==="residual"?"Create skip connection":(kind==="aux"?"Create extra connection":"Create main connection"));
      const e=edge(a,b,kind);
      e.source_port=sourcePort;
      e.target_port=targetPort;
      c.edges.push(e);
      setStatus(kind==="residual"?"Skip connection created.":(kind==="aux"?"Extra connection created.":"Main connection created."));
    }

    function autoConnectNew(node){
      const c=current(state);
      if(!state.auto_connect||c.nodes.length<2)return;
      connect(c.nodes[c.nodes.length-2].id,node.id,"main","main_out","main_in",false);
    }

    function addPrimitive(item){
      checkpoint("Add "+item.name);
      const n=makeNode(item);current(state).nodes.push(n);autoConnectNew(n);selected=n.id;draw();
    }

    function createCustom(){
      const c=current(state);
      if(!c.nodes.length){setStatus("Add layers first.");draw();return;}
      const name=prompt("Component name:","My Component");if(!name)return;
      checkpoint("Create custom brick");
      const id=uid("custom");
      state.custom_components[id]={
        id,name,
        description:"Reusable nested layer",
        revision:1,
        nodes:cp(c.nodes),
        edges:cp(c.edges||[]),
        input_count:3,
        output_count:3
      };
      setStatus(name+" saved to My Bricks.");draw();
    }

    function addCustom(def){
      checkpoint("Add "+def.name);
      const n={
        id:uid("node"),
        type:"custom",
        name:def.name,
        definition_id:def.id,
        repeat:1,
        params:{},
        input_count:3,
        output_count:3,
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
        input_count:3,
        output_count:3,
        nodes:cp(def.nodes),
        edges:cp(def.edges||[])
      };
      state.view_component_id=vid;state.breadcrumbs.push({id:vid,name:def.name});selected=null;pendingPort=null;draw();
    }

    function saveCustom(asNew){
      const c=current(state),def=state.custom_components[c.definition_id];if(!def)return;
      checkpoint(asNew?"Save custom as new":"Override custom component");
      if(asNew){
        const name=prompt("Save as new component:",def.name+" Copy");if(!name)return;
        const id=uid("custom");state.custom_components[id]={
          id,name,
          description:def.description||"",
          revision:1,
          nodes:cp(c.nodes),
          edges:cp(c.edges||[]),
          input_count:3,
          output_count:3
        };
        setStatus(name+" created.");
      }else{
        def.nodes=cp(c.nodes);
        def.edges=cp(c.edges||[]);
        def.input_count=3;
        def.output_count=3;
        def.revision=(def.revision||1)+1;c.revision=def.revision;
        setStatus(def.name+" updated to v"+def.revision+".");
      }
      draw();
    }

    function deleteNode(id){
      checkpoint("Delete node");
      const c=current(state);c.nodes=c.nodes.filter(n=>n.id!==id);c.edges=c.edges.filter(e=>e.source!==id&&e.target!==id);
      if(selected===id)selected=null;draw();
    }

    function duplicateSelected(){
      const n=selectedNode();if(!n)return;
      checkpoint("Duplicate "+n.name);
      const c=current(state),d=cp(n);d.id=uid("node");d.name=n.name+" Copy";
      const idx=c.nodes.findIndex(x=>x.id===n.id);c.nodes.splice(idx+1,0,d);selected=d.id;setStatus("Layer duplicated.");draw();
    }

    function portClick(nodeId,side,portIndex,ev){
      ev.stopPropagation();
      if(side==="out"){
        pendingPort={nodeId,side,portIndex};
        const lane=["Skip","Main","Extra"][portIndex]||"Lane";
        setStatus(lane+" output selected. Click the matching "+lane.toLowerCase()+" input.");
        draw();
        return;
      }

      if(side==="in" && pendingPort?.side==="out"){
        if(pendingPort.portIndex!==portIndex){
          const lane=["Skip","Main","Extra"][pendingPort.portIndex]||"Lane";
          setStatus("For a clean graph connect matching lanes: "+lane+" Out → "+lane+" In.");
          pendingPort=null;
          draw();
          return;
        }
        const lane=portIndex;
        const kind=lane===0?"residual":(lane===2?"aux":"main");
        const sourcePort=lane===0?"skip_out":(lane===2?"extra_out":"main_out");
        const targetPort=lane===0?"skip_in":(lane===2?"extra_in":"main_in");
        connect(pendingPort.nodeId,nodeId,kind,sourcePort,targetPort);
        pendingPort=null;
        draw();
        return;
      }

      pendingPort={nodeId,side,portIndex};
      setStatus("Input selected. Choose an output from the same lane.");
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
      input.addEventListener("change",()=>{
        checkpoint("Edit "+node.name+"."+f.key);
        node.params=node.params||{};
        node.params[f.key]=f.type==="number"?Number(input.value):input.value;
        setStatus(node.name+" API updated.");
        draw();
      });
      wrap.append(label,input);body.appendChild(wrap);
    }


    function portButtons(node, side){
      let html="";
      for(let i=0;i<3;i++){
        let style="";
        let posClass="";

        if(i===0){
          // Top lane: ports live ON the top edge, input on left half / output on right half.
          const left = side==="in" ? 28 : 72;
          style='left:'+left+'%;top:-6px;transform:translateX(-50%)';
          posClass="top-edge";
        }else if(i===1){
          // Main lane: conventional side-center input/output.
          style='top:50%;transform:translateY(-50%)';
          posClass="middle-side";
        }else{
          // Bottom lane: ports live ON the bottom edge, input on left half / output on right half.
          const left = side==="in" ? 28 : 72;
          style='left:'+left+'%;bottom:-6px;top:auto;transform:translateX(-50%)';
          posClass="bottom-edge";
        }

        html += '<button class="mlb-port '+side+' lane-'+i+' '+posClass+'" data-side="'+side+'" data-port-index="'+i+'" style="'+style+'" type="button" aria-label="'+portLabel(side,i)+'" title="'+portLabel(side,i)+'"></button>';
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
      const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("class","mlb-edge-layer");
      const scaledRect=wrap.getBoundingClientRect();
      svg.setAttribute("width",Math.max(wrap.clientWidth,scaledRect.width));
      svg.setAttribute("height",Math.max(wrap.clientHeight,scaledRect.height,650));
      wrap.appendChild(svg);
      const wr=wrap.getBoundingClientRect();
      let skipRoute=0, extraRoute=0;

      function portRect(nodeEl,side,index){
        const el=nodeEl.querySelector('.mlb-port[data-side="'+side+'"][data-port-index="'+index+'"]');
        return el ? el.getBoundingClientRect() : nodeEl.getBoundingClientRect();
      }

      function laneOf(e){
        if(e.kind==="residual") return 0;
        if(e.kind==="aux") return 2;
        const sp=String(e.source_port||"");
        if(sp.includes("skip")||sp.includes("res_")) return 0;
        if(sp.includes("extra")) return 2;
        return 1;
      }

      (current(state).edges||[]).forEach(e=>{
        const a=flow.querySelector('[data-node-id="'+e.source+'"]');
        const b=flow.querySelector('[data-node-id="'+e.target+'"]');
        if(!a||!b)return;
        const lane=laneOf(e);
        const ar=portRect(a,"out",lane), br=portRect(b,"in",lane);
        const x1=ar.left-wr.left+ar.width/2, y1=ar.top-wr.top+ar.height/2;
        const x2=br.left-wr.left+br.width/2, y2=br.top-wr.top+br.height/2;
        const p=document.createElementNS("http://www.w3.org/2000/svg","path");
        p.setAttribute("data-edge-id",e.id);

        if(lane===0){
          const ab=a.getBoundingClientRect(), bb=b.getBoundingClientRect();
          const route=skipRoute++;
          const topY=Math.min(ab.top-wr.top,bb.top-wr.top)-34-(route%4)*16;
          p.setAttribute("d",`M ${x1} ${y1} C ${x1+16} ${y1}, ${x1+16} ${topY}, ${x1+34} ${topY} L ${x2-34} ${topY} C ${x2-16} ${topY}, ${x2-16} ${y2}, ${x2} ${y2}`);
          p.setAttribute("class","mlb-edge-skip");
        }else if(lane===2){
          const ab=a.getBoundingClientRect(), bb=b.getBoundingClientRect();
          const route=extraRoute++;
          const bottomY=Math.max(ab.bottom-wr.top,bb.bottom-wr.top)+34+(route%4)*16;
          p.setAttribute("d",`M ${x1} ${y1} C ${x1+16} ${y1}, ${x1+16} ${bottomY}, ${x1+34} ${bottomY} L ${x2-34} ${bottomY} C ${x2-16} ${bottomY}, ${x2-16} ${y2}, ${x2} ${y2}`);
          p.setAttribute("class","mlb-edge-extra");
        }else{
          const mid=(x1+x2)/2;
          p.setAttribute("d",`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
          p.setAttribute("class","mlb-edge-main");
        }
        svg.appendChild(p);
      });
    }

    function loadTinyStories(){
      checkpoint("Load TinyStories 30M");
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
        input_count:3,
        output_count:3,
        nodes:[esa,norm,ffn,res],
        edges:[
          edge(esa.id,norm.id),
          edge(norm.id,ffn.id),
          Object.assign(edge(ffn.id,res.id),{source_port:"main_out",target_port:"main_in"}),
          Object.assign(edge(esa.id,res.id,"residual"),{source_port:"skip_out",target_port:"skip_in"})
        ]
      };
      const nodes=[];
      const input=makeNode(cat(catalog,"text_input"));nodes.push(input);
      const emb=makeNode(cat(catalog,"embedding"));nodes.push(emb);
      for(let i=1;i<=6;i++)nodes.push({id:uid("node"),type:"custom",name:"Layer "+i,definition_id:defId,repeat:1,params:{},input_count:3,output_count:3,position:{x:0,y:0}});
      const head=makeNode(cat(catalog,"lm_head")),out=makeNode(cat(catalog,"text_output"));nodes.push(head,out);
      const edges=[];for(let i=0;i<nodes.length-1;i++)edges.push(edge(nodes[i].id,nodes[i+1].id));
      state.components[rootId]={id:rootId,name:"TinyStories 30M",kind:"model",revision:1,nodes,edges};
      selected=null;pendingPort=null;setStatus("TinyStories starter loaded.");draw();
    }

    function draw(){
      const oldCanvas=root.querySelector(".mlb-canvas");
      if(oldCanvas){
        canvasScrollLeft=oldCanvas.scrollLeft;
        canvasScrollTop=oldCanvas.scrollTop;
      }
      root.innerHTML="";

      // Top bar
      const top=document.createElement("div");top.className="mlb-topbar";
      const logo=document.createElement("div");logo.className="mlb-logo";logo.innerHTML='<span class="mlb-logo-mark">◇</span>MLBricks Builder <span class="mlb-beta">v0.3.10</span>';top.appendChild(logo);
      const title=document.createElement("div");title.className="mlb-project-title";title.textContent=state.project?.name||"Untitled";top.appendChild(title);
      const saved=document.createElement("div");saved.className="mlb-save-state";saved.textContent="• Saved";top.appendChild(saved);
      const sp=document.createElement("div");sp.className="mlb-topspacer";top.appendChild(sp);
      const acts=document.createElement("div");acts.className="mlb-top-actions";
      const run=btn("▶ Run","mlb-run");run.addEventListener("click",()=>{setStatus("Graph ready for MLBricks runtime compilation.");draw();});
      const undoBtn=btn("↶ Undo","mlb-dark-btn mlb-history-btn");undoBtn.disabled=undoStack.length===0;undoBtn.title="Undo last model edit";undoBtn.addEventListener("click",undo);
      const redoBtn=btn("↷ Redo","mlb-dark-btn mlb-history-btn");redoBtn.disabled=redoStack.length===0;redoBtn.title="Redo last undone edit";redoBtn.addEventListener("click",redo);
      const clearBtn=btn("↻ Clear","mlb-dark-btn");clearBtn.addEventListener("click",()=>{
        const c=current(state);if(!c.nodes.length&&!c.edges.length)return;
        checkpoint("Clear graph");c.nodes=[];c.edges=[];selected=null;pendingPort=null;setStatus("Graph cleared.");draw();
      });
      acts.append(run,btn("□ Stop","mlb-stop"),undoBtn,redoBtn,clearBtn,btn("▣ Save","mlb-dark-btn"),btn("⇧ Load","mlb-dark-btn"),btn("⇩ Export","mlb-dark-btn"),btn("⌯ Share","mlb-dark-btn"),btn("?","mlb-dark-btn"),btn("⚙","mlb-dark-btn"));top.appendChild(acts);
      root.appendChild(top);

      const shell=document.createElement("div");shell.className="mlb-shell";

      // Sidebar
      const side=document.createElement("aside");side.className="mlb-sidebar";
      const head=document.createElement("div");head.className="mlb-sidehead";head.innerHTML="<span>BRICK LIBRARY</span><span>×</span>";side.appendChild(head);
      const sr=document.createElement("div");sr.className="mlb-search-row";
      const searchInput=document.createElement("input");searchInput.className="mlb-search";searchInput.placeholder="Search bricks...";searchInput.value=search;searchInput.addEventListener("input",()=>{search=searchInput.value;draw();});
      sr.append(searchInput,btn("☷","mlb-filter-btn"));side.appendChild(sr);
      const chips=document.createElement("div");chips.className="mlb-chips";
      ["All","Inputs","Core Blocks","Norm","Heads","Outputs"].forEach(x=>{const b=btn(x.replace(" Blocks",""),"mlb-chip"+(filter===x?" active":""));b.addEventListener("click",()=>{
          filter=x;
          if(x!=="All"&&x!=="Norm") collapsedCategories.delete(x);
          draw();
        });chips.appendChild(b);});side.appendChild(chips);

      const visible=catalog.filter(item=>{
        const q=(item.name+" "+item.description+" "+item.category).toLowerCase();
        if(search&&!q.includes(search.toLowerCase()))return false;
        if(filter==="All")return true;
        if(filter==="Norm")return ["rmsnorm","layernorm"].includes(item.type);
        return item.category===filter;
      });

      [...new Set(visible.map(x=>x.category))].forEach(category=>{
        // Search results always expand so a matching component can never be hidden.
        const collapsed=collapsedCategories.has(category) && !search;
        const h=document.createElement("button");
        h.type="button";
        h.className="mlb-category";
        h.setAttribute("aria-expanded",String(!collapsed));
        h.innerHTML="<span>"+category+"</span><span class='mlb-category-caret'>"+(collapsed?"▸":"▾")+"</span>";
        h.addEventListener("click",()=>{
          if(collapsedCategories.has(category)) collapsedCategories.delete(category);
          else collapsedCategories.add(category);
          draw();
        });
        side.appendChild(h);

        const pal=document.createElement("div");
        pal.className="mlb-palette"+(collapsed?" collapsed":"");
        if(!collapsed){
          visible.filter(x=>x.category===category).forEach(item=>{
            const b=document.createElement("button");b.type="button";
            const ico=document.createElement("span");ico.className="mlb-pal-icon";ico.textContent=item.icon||"ML";
            const text=document.createElement("span");text.innerHTML="<strong>"+item.name+'</strong><span class="mlb-pal-sub">'+(item.description||"MLBricks component")+"</span>";
            b.append(ico,text);b.addEventListener("click",()=>addPrimitive(item));pal.appendChild(b);
          });
        }
        side.appendChild(pal);
      });

      const mh=document.createElement("button");
      mh.type="button";
      mh.className="mlb-category";
      mh.setAttribute("aria-expanded",String(!myBricksCollapsed));
      mh.innerHTML="<span>MY BRICKS</span><span class='mlb-category-caret'>"+(myBricksCollapsed?"▸":"▾")+"</span>";
      mh.addEventListener("click",()=>{myBricksCollapsed=!myBricksCollapsed;draw();});
      side.appendChild(mh);

      if(!myBricksCollapsed){
        Object.values(state.custom_components||{}).forEach(def=>{
          const b=document.createElement("button");b.className="mlb-custom-card";b.type="button";
          b.innerHTML='<span class="mlb-pal-icon">MY</span><span><strong>'+def.name+'</strong><span class="mlb-pal-sub">Custom · v'+def.revision+"</span></span>";
          b.addEventListener("click",()=>addCustom(def));side.appendChild(b);
        });
        const create=btn("+ Create Custom Brick","mlb-create");create.addEventListener("click",createCustom);side.appendChild(create);
      }

      // Main
      const main=document.createElement("main");main.className="mlb-main";
      const toolbar=document.createElement("div");toolbar.className="mlb-toolbar";
      const auto=btn("◎ Auto Layout","mlb-tool");auto.addEventListener("click",()=>{setStatus("Layer-by-layer auto layout applied.");draw();});
      const add=btn("+ Add Layer","mlb-tool");add.addEventListener("click",()=>{setStatus("Choose a brick from the library.");draw();});
      const demo=btn("★ TinyStories 30M","mlb-tool");demo.addEventListener("click",loadTinyStories);
      toolbar.append(auto,add,demo);
      const tsp=document.createElement("div");tsp.className="mlb-toolspacer";toolbar.appendChild(tsp);
      const toggle=document.createElement("label");toggle.className="mlb-toggle";const cb=document.createElement("input");cb.type="checkbox";cb.checked=!!state.auto_connect;cb.addEventListener("change",()=>{checkpoint("Change Auto Connect");state.auto_connect=cb.checked;draw();});toggle.append(document.createTextNode("Auto Connect"),cb);toolbar.appendChild(toggle);
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

      const mini=document.createElement("div");mini.className="mlb-minimap";
      const miniTitle=document.createElement("div");miniTitle.className="mlb-minimap-title";miniTitle.textContent="BLUEPRINT";
      const mg=document.createElement("div");mg.className="mlb-minimap-grid";
      current(state).nodes.forEach(()=>{const m=document.createElement("div");m.className="mlb-mini-node";mg.appendChild(m);});
      mini.append(miniTitle,mg);
      canvas.appendChild(mini);

      const wrap=document.createElement("div");wrap.className="mlb-flow-wrap";
      const flow=document.createElement("div");flow.className="mlb-flow";
      flow.style.transformOrigin="left top";
      flow.style.transform="scale("+zoom+")";
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
              '<div class="mlb-mini-field"><span>Ports</span><strong>Skip / Main / Extra</strong></div>')
            :nodeMiniFields(n,info);
          const meta=card.querySelector(".node-meta");
          meta.textContent=n.type==="custom"?"Nested component · 3-lane interface":((apiInfo(n).public_name||n.type)+" · Skip / Main / Extra");
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
        ?"Choose the matching lane: Top ↔ Top, Main ↔ Main, Bottom ↔ Bottom."
        :"Each node has 3 inputs + 3 outputs: top-edge pair, middle side pair, bottom-edge pair. Auto-connect uses the middle Main lane.";
      canvas.appendChild(hint);
      main.appendChild(canvas);
      requestAnimationFrame(()=>{
        // transform:scale changes pixels but not layout. Give the wrapper the
        // scaled dimensions so zoom creates the correct scroll area instead
        // of clipping nodes, bottom ports, edges, or the instruction banner.
        const baseW=Math.max(flow.scrollWidth,flow.offsetWidth);
        const baseH=Math.max(flow.scrollHeight,flow.offsetHeight);
        wrap.style.width=Math.ceil(baseW*zoom)+"px";
        wrap.style.height=Math.ceil(baseH*zoom)+"px";
        drawEdges(wrap,flow);
        canvas.scrollLeft=canvasScrollLeft;
        canvas.scrollTop=canvasScrollTop;
      });

      // Bottom details are collapsed by default so Kaggle gives the graph maximum space.
      const details=document.createElement("div");details.className="mlb-details";
      const detailsBar=document.createElement("button");detailsBar.type="button";detailsBar.className="mlb-details-bar";
      detailsBar.innerHTML="<span>Model Details</span><span>"+(bottomExpanded?"▾ Hide":"▴ Show")+"</span>";
      detailsBar.addEventListener("click",()=>{bottomExpanded=!bottomExpanded;draw();});
      details.appendChild(detailsBar);

      const panels=document.createElement("div");panels.className="mlb-bottom-panels"+(bottomExpanded?" expanded":" collapsed");
      const p1=document.createElement("div");p1.className="mlb-bottom-card";p1.innerHTML='<div class="mlb-bottom-title">PRESETS</div><div class="mlb-preset-card"><strong>★ TinyStories 30M (6L)</strong>Context 512 · Batch 16<br>~30M parameters</div>';p1.querySelector(".mlb-preset-card").addEventListener("click",loadTinyStories);
      const p2=document.createElement("div");p2.className="mlb-bottom-card";p2.innerHTML='<div class="mlb-bottom-title">GRAPH INFO</div><div class="mlb-stat-row"><span>Layers</span><strong>'+current(state).nodes.length+'</strong></div><div class="mlb-stat-row"><span>Connections</span><strong>'+(current(state).edges||[]).length+'</strong></div><div class="mlb-stat-row"><span>Context</span><strong>'+(state.project?.context_length||"—")+'</strong></div><div class="mlb-stat-row"><span>Batch Size</span><strong>'+(state.project?.batch_size||"—")+'</strong></div><div class="mlb-stat-row"><span>Status</span><strong class="mlb-good">✓ Valid</strong></div>';
      const p3=document.createElement("div");p3.className="mlb-bottom-card";p3.innerHTML='<div class="mlb-bottom-title">COMPUTE ESTIMATE</div><div class="mlb-stat-row"><span>Target Params</span><strong>'+(state.project?.estimated_parameters||"—")+'</strong></div><div class="mlb-stat-row"><span>Dataset</span><strong>'+(state.project?.dataset||"—")+'</strong></div><div class="mlb-stat-row"><span>Precision</span><strong>float16</strong></div><div class="mlb-stat-row"><span>Backend</span><strong>MLBricks</strong></div>';
      const p4=document.createElement("div");p4.className="mlb-bottom-card";p4.innerHTML='<div class="mlb-bottom-title">CONNECTION LANES</div><div class="mlb-stat-row"><span>Skip</span><strong>Top Out → Top In</strong></div><div class="mlb-stat-row"><span>Main</span><strong>Middle Out → Middle In</strong></div><div class="mlb-stat-row"><span>Extra</span><strong>Bottom Out → Bottom In</strong></div><div class="mlb-stat-row"><span>Remove</span><strong>Inspector → Remove</strong></div>';
      panels.append(p1,p2,p3,p4);
      details.appendChild(panels);
      main.appendChild(details);

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
          const st=document.createElement("div");st.className="mlb-section-title";st.textContent="CUSTOM LAYER PORTS";body.appendChild(st);
          const fixed=document.createElement("div");fixed.className="mlb-api-path";
          fixed.textContent="Fixed clean interface: Top Skip, Middle Main, Bottom Extra — on both left and right sides.";
          body.appendChild(fixed);
        }else{
          const st=document.createElement("div");st.className="mlb-section-title";st.textContent="PARAMETERS";body.appendChild(st);
          (api.parameters||info.api||[]).forEach(f=>renderField(body,n,f));
          const ct=document.createElement("div");ct.className="mlb-section-title";ct.textContent="MLBRICKS PYTHON";body.appendChild(ct);
          const code=document.createElement("pre");code.className="mlb-code-preview";code.textContent=constructorPreview(n);body.appendChild(code);
        }
        const edgeSectionTitle=document.createElement("div");edgeSectionTitle.className="mlb-section-title";edgeSectionTitle.textContent="CONNECTIONS";body.appendChild(edgeSectionTitle);
        const relEdges=(current(state).edges||[]).filter(e=>e.source===n.id||e.target===n.id);
        if(relEdges.length===0){
          const emptyEdge=document.createElement("div");emptyEdge.className="mlb-api-path";emptyEdge.textContent="No connections for this node.";body.appendChild(emptyEdge);
        } else {
          relEdges.forEach(ed=>{
            const row=document.createElement("div");row.className="mlb-connection-row";
            const src=current(state).nodes.find(x=>x.id===ed.source), tgt=current(state).nodes.find(x=>x.id===ed.target);
            const laneName=ed.kind==="residual"?"Skip":(ed.kind==="aux"?"Extra":"Main");
            const left=(src?.name||"Node")+" → "+(tgt?.name||"Node")+" · "+laneName;
            const txt=document.createElement("div");txt.className="mlb-connection-text";txt.textContent=left;
            const delBtn=btn("Remove","mlb-conn-remove");
            delBtn.addEventListener("click",()=>{
              checkpoint("Remove connection");
              current(state).edges=current(state).edges.filter(x=>x.id!==ed.id);
              setStatus("Connection removed.");
              draw();
            });
            row.append(txt,delBtn);body.appendChild(row);
          });
        }
        const actions=document.createElement("div");actions.className="mlb-action-grid";
        if(n.definition_id){const open=btn("Open Architecture");open.addEventListener("click",()=>openInside(n));actions.appendChild(open);}
        const dup=btn("Duplicate");dup.addEventListener("click",duplicateSelected);actions.appendChild(dup);
        const disc=btn("Remove All Links");disc.addEventListener("click",()=>{
          checkpoint("Remove all links from "+n.name);
          current(state).edges=current(state).edges.filter(e=>e.source!==n.id&&e.target!==n.id);
          setStatus("All connections removed.");draw();
        });actions.appendChild(disc);
        const del=btn("Delete");del.addEventListener("click",()=>deleteNode(n.id));actions.appendChild(del);body.appendChild(actions);
        if(current(state).kind==="custom_edit"){
          const parentCfg=document.createElement("div");
          parentCfg.className="mlb-summary";
          parentCfg.innerHTML='<div class="mlb-summary-row"><span>Custom Layer Interface</span><strong>Skip / Main / Extra</strong></div>';
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
