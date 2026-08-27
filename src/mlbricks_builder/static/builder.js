(function(){
  if(window.MLBricksBuilder) return;

  function cp(v){return JSON.parse(JSON.stringify(v));}
  function uid(p){return p+"_"+Math.random().toString(36).slice(2,10);}
  function current(state){return state.components[state.view_component_id];}
  function cat(catalog,type){return catalog.find(x=>x.type===type)||{};}
  function makeNode(item){
    const params={};
    (item.api||[]).forEach(f=>params[f.key]=f.value);
    return {id:uid("node"),type:item.type,name:item.name,definition_id:null,repeat:1,params,position:{x:0,y:0}};
  }
  function makeEdge(a,b,kind="main"){return{id:uid("edge"),source:a,target:b,source_port:"out",target_port:"in",kind};}

  function mount(root,payload){
    if(!root||root.dataset.mounted==="1") return;
    root.dataset.mounted="1";

    const state=cp(payload.state);
    const catalog=cp(payload.catalog);
    let selected=null;
    let pendingPort=null;
    let search="";
    let filter="All";
    let inspectorTab="settings";
    let zoom=1;
    let status="Ready";

    // Migration for older saved projects.
    Object.values(state.components||{}).forEach(c=>{if(!c.edges)c.edges=[];});
    if(state.auto_connect===undefined) state.auto_connect=true;

    function selectedNode(){return current(state).nodes.find(n=>n.id===selected)||null;}
    function btn(text,cls){const b=document.createElement("button");b.type="button";b.className=cls||"";b.textContent=text;return b;}
    function setStatus(s){status=s;}

    function connect(sourceId,targetId,kind="main"){
      if(sourceId===targetId){setStatus("A layer cannot connect to itself.");return;}
      const c=current(state);
      const exists=c.edges.some(e=>e.source===sourceId&&e.target===targetId&&e.kind===kind);
      if(exists){setStatus("Those layers are already connected.");return;}
      c.edges.push(makeEdge(sourceId,targetId,kind));
      setStatus("Connection created.");
    }

    function autoConnectNew(node){
      const c=current(state);
      if(!state.auto_connect||c.nodes.length<2) return;
      const prev=c.nodes[c.nodes.length-2];
      connect(prev.id,node.id);
    }

    function addPrimitive(item){
      const n=makeNode(item);
      current(state).nodes.push(n);
      autoConnectNew(n);
      selected=n.id;
      draw();
    }

    function createCustomFromSelected(){
      const c=current(state);
      if(!c.nodes.length){setStatus("Add layers first.");draw();return;}
      const name=prompt("Component name:","My Component");
      if(!name)return;
      const id=uid("custom");
      state.custom_components[id]={
        id,name,description:"Reusable MLBricks component",revision:1,
        nodes:cp(c.nodes),edges:cp(c.edges||[]),exposed_api:[]
      };
      setStatus(name+" saved to My Bricks.");
      draw();
    }

    function addCustom(def){
      const n={id:uid("node"),type:"custom",name:def.name,definition_id:def.id,repeat:1,params:{},position:{x:0,y:0}};
      current(state).nodes.push(n);autoConnectNew(n);selected=n.id;draw();
    }

    function openInside(n){
      if(!n.definition_id)return;
      const def=state.custom_components[n.definition_id];if(!def)return;
      const vid="view_"+def.id+"_"+uid("v");
      state.components[vid]={
        id:vid,name:def.name,kind:"custom_edit",definition_id:def.id,revision:def.revision,
        nodes:cp(def.nodes),edges:cp(def.edges||[])
      };
      state.view_component_id=vid;
      state.breadcrumbs.push({id:vid,name:def.name});
      selected=null;pendingPort=null;draw();
    }

    function saveCustom(asNew){
      const c=current(state);if(c.kind!=="custom_edit")return;
      const def=state.custom_components[c.definition_id];if(!def)return;
      if(asNew){
        const name=prompt("Save as new component: ",def.name+" Copy");if(!name)return;
        const id=uid("custom");
        state.custom_components[id]={id,name,description:def.description||"",revision:1,nodes:cp(c.nodes),edges:cp(c.edges||[]),exposed_api:cp(def.exposed_api||[])};
        setStatus(name+" created.");
      }else{
        def.nodes=cp(c.nodes);def.edges=cp(c.edges||[]);def.revision=(def.revision||1)+1;c.revision=def.revision;
        setStatus(def.name+" overridden as v"+def.revision+".");
      }
      draw();
    }

    function deleteNode(id){
      const c=current(state);
      c.nodes=c.nodes.filter(n=>n.id!==id);
      c.edges=(c.edges||[]).filter(e=>e.source!==id&&e.target!==id);
      if(selected===id)selected=null;
      draw();
    }

    function duplicateSelected(){
      const n=selectedNode();if(!n)return;
      const c=current(state),copy=cp(n);copy.id=uid("node");copy.name=n.name+" Copy";
      const idx=c.nodes.findIndex(x=>x.id===n.id);c.nodes.splice(idx+1,0,copy);
      selected=copy.id;setStatus("Layer duplicated.");draw();
    }

    function renderApiField(container,node,field){
      const wrap=document.createElement("div");wrap.className="mlb-field";
      const label=document.createElement("label");label.textContent=field.label;
      let input;
      if(field.type==="select"){
        input=document.createElement("select");
        (field.options||[]).forEach(v=>{
          const o=document.createElement("option");o.value=v;o.textContent=v;
          if(String(node.params?.[field.key]??field.value)===String(v))o.selected=true;
          input.appendChild(o);
        });
      }else{
        input=document.createElement("input");input.type=field.type==="number"?"number":"text";
        input.value=node.params?.[field.key]??field.value??"";if(field.type==="number")input.step="any";
      }
      input.addEventListener("change",()=>{
        node.params=node.params||{};
        node.params[field.key]=field.type==="number"?Number(input.value):input.value;
        setStatus(node.name+" API updated.");
      });
      wrap.append(label,input);container.appendChild(wrap);
    }

    function connectionPortClick(nodeId,side,event){
      event.stopPropagation();
      if(side==="out"){
        pendingPort={nodeId,side};
        setStatus("Output selected. Click an input port to connect.");
        draw();
        return;
      }
      if(side==="in"&&pendingPort&&pendingPort.side==="out"){
        connect(pendingPort.nodeId,nodeId,event.shiftKey?"residual":"main");
        pendingPort=null;draw();return;
      }
      pendingPort={nodeId,side};
      setStatus("Input selected. Choose an output port first.");
      draw();
    }

    function drawEdges(flowWrap,flow){
      const c=current(state);
      const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("class","mlb-edge-layer");
      svg.setAttribute("width",Math.max(flow.scrollWidth,flow.getBoundingClientRect().width));
      svg.setAttribute("height",Math.max(flow.scrollHeight,450));
      flowWrap.appendChild(svg);

      const wrapRect=flowWrap.getBoundingClientRect();
      (c.edges||[]).forEach(edge=>{
        const a=flow.querySelector('[data-node-id="'+edge.source+'"]');
        const b=flow.querySelector('[data-node-id="'+edge.target+'"]');
        if(!a||!b)return;
        const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
        const x1=ar.right-wrapRect.left, y1=ar.top-wrapRect.top+ar.height/2;
        const x2=br.left-wrapRect.left, y2=br.top-wrapRect.top+br.height/2;

        const path=document.createElementNS("http://www.w3.org/2000/svg","path");
        if(edge.kind==="residual"){
          const drop=65;
          path.setAttribute("d",`M ${x1} ${y1} C ${x1+22} ${y1+drop}, ${x2-22} ${y2+drop}, ${x2} ${y2}`);
          path.setAttribute("class","mlb-edge-residual");
        }else{
          const mid=(x1+x2)/2;
          path.setAttribute("d",`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
          path.setAttribute("class","mlb-edge-main");
        }
        svg.appendChild(path);
      });
    }

    function loadTinyStoriesDemo(){
      // Build a browser-side demo matching the Python preset without a kernel round trip.
      const currentId=state.root_component_id;
      state.view_component_id=currentId;
      state.breadcrumbs=[{id:currentId,name:"TinyStories 30M Starter"}];
      state.project={
        ...(state.project||{}),name:"TinyStories 30M Starter",context_length:512,batch_size:16,
        dataset:"TinyStories",estimated_parameters:"~30M",description:"6-layer beginner language-model starter"
      };
      const defId=uid("custom");
      const esa=makeNode(cat(catalog,"esa"));esa.params={dim:384,state_dim:192,heads:6,chunk_size:16,kernel:"auto",dtype:"float16",device:"auto"};
      const norm=makeNode(cat(catalog,"rmsnorm"));norm.params={dim:384,eps:0.00001};
      const ffn=makeNode(cat(catalog,"ffn"));ffn.params={dim:384,ffn_dim:1536,activation:"silu",dropout:0.1,bias:"true"};
      const residual=makeNode(cat(catalog,"residual"));residual.params={enabled:"true",scale:1.0,pre_norm:"RMSNorm"};
      state.custom_components[defId]={
        id:defId,name:"TinyStories ESA Block",description:"ESA → RMSNorm → FFN → Residual",revision:1,
        nodes:[esa,norm,ffn,residual],
        edges:[makeEdge(esa.id,norm.id),makeEdge(norm.id,ffn.id),makeEdge(ffn.id,residual.id),makeEdge(esa.id,residual.id,"residual")]
      };
      const nodes=[];
      const input=makeNode(cat(catalog,"text_input"));input.params={prompt:"Once upon a time"};nodes.push(input);
      const emb=makeNode(cat(catalog,"embedding"));emb.params={dim:384,vocab_size:32000,dtype:"float16",device:"auto"};nodes.push(emb);
      for(let i=1;i<=6;i++)nodes.push({id:uid("node"),type:"custom",name:"Layer "+i,definition_id:defId,repeat:1,params:{dim:384,heads:6,ffn_dim:1536},position:{x:0,y:0}});
      const head=makeNode(cat(catalog,"lm_head"));head.params={dim:384,vocab_size:32000,bias:"false"};nodes.push(head);
      const out=makeNode(cat(catalog,"text_output"));out.params={max_new_tokens:64,temperature:0.8,top_p:0.95};nodes.push(out);
      const edges=[];for(let i=0;i<nodes.length-1;i++)edges.push(makeEdge(nodes[i].id,nodes[i+1].id));
      state.components[currentId]={id:currentId,name:"TinyStories 30M Starter",kind:"model",revision:1,nodes,edges};
      selected=null;pendingPort=null;setStatus("TinyStories starter loaded.");draw();
    }

    function draw(){
      root.innerHTML="";

      // Header
      const top=document.createElement("div");top.className="mlb-topbar";
      const logo=document.createElement("div");logo.className="mlb-logo";logo.innerHTML='◈ MLBRICKS BUILDER <span class="mlb-beta">BETA</span>';top.appendChild(logo);
      const title=document.createElement("div");title.className="mlb-project-title";title.textContent=(state.project?.name||"Untitled")+" (Left → Right) ✎";top.appendChild(title);
      const nav=document.createElement("div");nav.className="mlb-topnav";
      ["▣ Builder","▣ Train","▤ Evaluate","▱ Deploy"].forEach((x,i)=>{const b=btn(x);if(i===0)b.className="active";nav.appendChild(b);});top.appendChild(nav);
      const actions=document.createElement("div");actions.className="mlb-top-actions";
      ["▣ Save","⇧ Load","⌯ Share"].forEach(x=>actions.appendChild(btn(x,"mlb-dark-btn")));
      const run=btn("▶ Run","mlb-run");run.addEventListener("click",()=>{setStatus("Model graph ready for MLBricks runtime compilation.");draw();});actions.appendChild(run);top.appendChild(actions);
      root.appendChild(top);

      const shell=document.createElement("div");shell.className="mlb-shell";

      // Left component library
      const side=document.createElement("aside");side.className="mlb-sidebar";
      const sh=document.createElement("div");sh.className="mlb-sidehead";sh.innerHTML="<span>COMPONENTS</span><span>×</span>";side.appendChild(sh);
      const srch=document.createElement("input");srch.className="mlb-search";srch.placeholder="⌕  Search components...";srch.value=search;
      srch.addEventListener("input",()=>{search=srch.value;draw();});side.appendChild(srch);

      const chips=document.createElement("div");chips.className="mlb-chips";
      ["All","Core Blocks","ESA","VESA","Heads","Outputs"].forEach(x=>{const b=btn(x,"mlb-chip"+(filter===x?" active":""));b.addEventListener("click",()=>{filter=x;draw();});chips.appendChild(b);});side.appendChild(chips);

      const visible=catalog.filter(item=>{
        const q=(item.name+" "+item.description+" "+item.category).toLowerCase();
        if(search&&!q.includes(search.toLowerCase()))return false;
        if(filter==="All")return true;
        if(filter==="ESA")return item.type==="esa";
        if(filter==="VESA")return item.type==="vesa";
        return item.category===filter;
      });
      [...new Set(visible.map(x=>x.category))].forEach(category=>{
        const h=document.createElement("div");h.className="mlb-category";h.textContent=category;side.appendChild(h);
        const pal=document.createElement("div");pal.className="mlb-palette";
        visible.filter(x=>x.category===category).forEach(item=>{
          const b=document.createElement("button");b.type="button";
          const ico=document.createElement("span");ico.className="mlb-pal-icon";ico.textContent=item.icon;
          const tx=document.createElement("span");tx.innerHTML="<strong>"+item.name+'</strong><span class="mlb-pal-sub">'+item.description+"</span>";
          b.append(ico,tx);b.addEventListener("click",()=>addPrimitive(item));pal.appendChild(b);
        });side.appendChild(pal);
      });

      const myh=document.createElement("div");myh.className="mlb-category";myh.textContent="My Bricks";side.appendChild(myh);
      Object.values(state.custom_components||{}).forEach(def=>{
        const b=document.createElement("button");b.type="button";b.className="mlb-custom-card";
        b.innerHTML='<span class="mlb-pal-icon">MY</span><span><strong>'+def.name+'</strong><span class="mlb-pal-sub">Custom · v'+def.revision+"</span></span>";
        b.addEventListener("click",()=>addCustom(def));side.appendChild(b);
      });
      const create=btn("+ Create Custom Brick","mlb-create");create.addEventListener("click",createCustomFromSelected);side.appendChild(create);

      // Center
      const main=document.createElement("main");main.className="mlb-main";
      const toolbar=document.createElement("div");toolbar.className="mlb-toolbar";
      const add=btn("+ Add Layer","mlb-tool");add.addEventListener("click",()=>{setStatus("Pick any brick from the left component library.");draw();});
      const dup=btn("▣ Duplicate","mlb-tool");dup.addEventListener("click",duplicateSelected);
      const del=btn("⌫ Delete","mlb-tool");del.addEventListener("click",()=>{if(selected)deleteNode(selected);});
      const clear=btn("⌘ Clear All","mlb-tool");clear.addEventListener("click",()=>{current(state).nodes=[];current(state).edges=[];selected=null;draw();});
      const demo=btn("★ TinyStories 30M Demo","mlb-tool");demo.addEventListener("click",loadTinyStoriesDemo);
      toolbar.append(add,dup,del,clear,demo);
      const tsp=document.createElement("div");tsp.className="mlb-toolspacer";toolbar.appendChild(tsp);
      const tog=document.createElement("label");tog.className="mlb-toggle";
      const chk=document.createElement("input");chk.type="checkbox";chk.checked=!!state.auto_connect;chk.addEventListener("change",()=>{state.auto_connect=chk.checked;setStatus(chk.checked?"Auto Connect enabled.":"Manual connection mode.");draw();});
      tog.append(document.createTextNode("Auto Connect"),chk);toolbar.appendChild(tog);
      main.appendChild(toolbar);

      const canvas=document.createElement("div");canvas.className="mlb-canvas";
      const ctop=document.createElement("div");ctop.className="mlb-canvas-top";
      const crumbs=document.createElement("div");crumbs.className="mlb-breadcrumbs";
      state.breadcrumbs.forEach((c,i)=>{const b=btn(c.name,"mlb-crumb");b.addEventListener("click",()=>{state.view_component_id=c.id;state.breadcrumbs=state.breadcrumbs.slice(0,i+1);selected=null;pendingPort=null;draw();});crumbs.appendChild(b);if(i<state.breadcrumbs.length-1){const s=document.createElement("span");s.textContent="/";crumbs.appendChild(s);}});
      const z=document.createElement("div");z.className="mlb-zoom";
      const zm=btn("−");zm.addEventListener("click",()=>{zoom=Math.max(.65,zoom-.1);draw();});
      const zs=document.createElement("span");zs.textContent=Math.round(zoom*100)+"%";
      const zp=btn("+");zp.addEventListener("click",()=>{zoom=Math.min(1.5,zoom+.1);draw();});
      z.append(zm,zs,zp);ctop.append(crumbs,z);canvas.appendChild(ctop);

      const flowWrap=document.createElement("div");flowWrap.className="mlb-flow-wrap";
      const flow=document.createElement("div");flow.className="mlb-flow";flow.style.transformOrigin="left center";flow.style.transform="scale("+zoom+")";
      const comp=current(state);
      if(!comp.nodes.length){
        const e=document.createElement("div");e.className="mlb-empty";e.innerHTML="<strong>Build your AI layer by layer.</strong><br><br>Add a component from the left or load the TinyStories starter.";
        flow.appendChild(e);
      }else{
        comp.nodes.forEach((n,i)=>{
          if(i){const arrow=document.createElement("div");arrow.className="mlb-arrow";arrow.textContent="→";flow.appendChild(arrow);}
          const info=n.type==="custom"?{icon:"LAY",description:"Nested reusable layer",accent:"purple",api:[]}:cat(catalog,n.type);
          const card=document.createElement("div");card.className="mlb-node"+(selected===n.id?" selected":"");card.dataset.nodeId=n.id;card.dataset.accent=info.accent||"purple";
          card.innerHTML='<span class="index">'+(i+1)+'</span><button type="button" class="mlb-port in" aria-label="Input port"></button><div class="node-icon"></div><div class="node-name"></div><div class="node-desc"></div><div class="node-meta"></div><button type="button" class="mlb-port out" aria-label="Output port"></button>';
          card.querySelector(".node-icon").textContent=info.icon||"LAY";
          card.querySelector(".node-name").textContent=n.name;
          card.querySelector(".node-desc").textContent=info.description||"Layer";
          const meta=card.querySelector(".node-meta");
          if(n.type==="custom")meta.innerHTML="Nested Layer<br>"+(n.params?.dim?"Hidden "+n.params.dim:"Click to edit");
          else if(n.params?.dim)meta.innerHTML="Hidden "+n.params.dim+(n.params?.heads?"<br>Heads "+n.params.heads:"");
          else meta.textContent=n.repeat>1?"Repeat ×"+n.repeat:"Layer";
          const inPort=card.querySelector(".in"),outPort=card.querySelector(".out");
          if(pendingPort?.nodeId===n.id&&pendingPort.side==="in")inPort.classList.add("armed");
          if(pendingPort?.nodeId===n.id&&pendingPort.side==="out")outPort.classList.add("armed");
          inPort.addEventListener("click",ev=>connectionPortClick(n.id,"in",ev));
          outPort.addEventListener("click",ev=>connectionPortClick(n.id,"out",ev));
          card.addEventListener("click",()=>{selected=n.id;draw();});
          card.addEventListener("dblclick",()=>{if(n.definition_id)openInside(n);});
          flow.appendChild(card);
        });
      }
      flowWrap.appendChild(flow);canvas.appendChild(flowWrap);

      const hint=document.createElement("div");hint.className="mlb-connection-hint";
      hint.textContent=pendingPort?"Now click the matching port • Shift + click input = residual connection":"Manual connect: click output ● then input ● • Double-click a custom layer to open inside";
      canvas.appendChild(hint);
      main.appendChild(canvas);

      // Draw edges after nodes are inserted/laid out.
      requestAnimationFrame(()=>drawEdges(flowWrap,flow));

      // Patterns / starter
      const patterns=document.createElement("div");patterns.className="mlb-patterns";
      const ph=document.createElement("div");ph.className="mlb-pattern-title";ph.textContent="COMMON PATTERNS (CLICK TO ADD / LOAD)";patterns.appendChild(ph);
      const prow=document.createElement("div");prow.className="mlb-pattern-row";
      const patternData=[
        ["★ TinyStories 30M","6 layers · context 512 · batch 16"],
        ["ESA Block","ESA → Norm → FFN → Add"],
        ["Transformer Block","Norm → MHA → Add → FFN → Add"],
        ["Parallel Attention","ESA + VESA (Parallel)"],
        ["Encoder Block","Stacked Encoder Layers"],
      ];
      patternData.forEach((p,idx)=>{const b=document.createElement("button");b.type="button";b.className="mlb-pattern";b.innerHTML="<strong>"+p[0]+"</strong><span>"+p[1]+"</span>";if(idx===0)b.addEventListener("click",loadTinyStoriesDemo);prow.appendChild(b);});
      patterns.appendChild(prow);main.appendChild(patterns);

      // Inspector
      const ins=document.createElement("aside");ins.className="mlb-inspector";
      const tabs=document.createElement("div");tabs.className="mlb-ins-tabs";
      [["settings","Layer Settings"],["model","Model Settings"]].forEach(([k,t])=>{const b=btn(t);if(inspectorTab===k)b.className="active";b.addEventListener("click",()=>{inspectorTab=k;draw();});tabs.appendChild(b);});ins.appendChild(tabs);
      const body=document.createElement("div");body.className="mlb-ins-body";

      if(inspectorTab==="model"){
        const p=state.project||{};
        body.innerHTML='<div class="mlb-section-title">MODEL SUMMARY</div>';
        const box=document.createElement("div");box.className="mlb-summary";
        [["Project",p.name||"Untitled"],["Dataset",p.dataset||"Not set"],["Context",p.context_length||"—"],["Batch Size",p.batch_size||"—"],["Target Params",p.estimated_parameters||"—"],["Visible Layers",current(state).nodes.length],["Status","Valid"]].forEach(([a,b])=>{const r=document.createElement("div");r.className="mlb-summary-row";r.innerHTML="<span>"+a+"</span><strong"+(a==="Status"?' class="mlb-good"':"")+">"+b+"</strong>";box.appendChild(r);});body.appendChild(box);
      }else{
        const n=selectedNode();
        if(!n){
          body.innerHTML='<div class="mlb-section-title">SELECTED LAYER</div><div style="font-size:10px;color:#667085">Click any layer to open its MLBricks API interface here.</div>';
        }else{
          const info=n.type==="custom"?{name:"Custom Layer",api:[]}:cat(catalog,n.type);
          const selectedWrap=document.createElement("div");selectedWrap.className="mlb-selected";selectedWrap.innerHTML="<strong>Selected Layer</strong><span class='mlb-pill'>"+n.name+"</span>";body.appendChild(selectedWrap);
          const h=document.createElement("div");h.className="mlb-section-title";h.textContent=n.type==="custom"?"CUSTOM LAYER API":n.name+" API";body.appendChild(h);
          const apiPath=document.createElement("div");apiPath.className="mlb-api-path";apiPath.textContent=n.type==="custom"?"custom://"+n.definition_id:"mlbricks."+n.type+"(...)";body.appendChild(apiPath);

          const nameF=document.createElement("div");nameF.className="mlb-field";const nl=document.createElement("label");nl.textContent="Layer Name";const ni=document.createElement("input");ni.value=n.name;ni.addEventListener("change",()=>{n.name=ni.value||n.name;draw();});nameF.append(nl,ni);body.appendChild(nameF);

          if(n.type==="custom"){
            const def=state.custom_components[n.definition_id];
            const summ=document.createElement("div");summ.className="mlb-summary";
            [["Internal Components",def?.nodes?.length||0],["Internal Connections",def?.edges?.length||0],["Revision","v"+(def?.revision||1)]].forEach(([a,b])=>{const r=document.createElement("div");r.className="mlb-summary-row";r.innerHTML="<span>"+a+"</span><strong>"+b+"</strong>";summ.appendChild(r);});body.appendChild(summ);
          }else{
            (info.api||[]).forEach(f=>renderApiField(body,n,f));
          }

          const repeat=document.createElement("div");repeat.className="mlb-field";const rl=document.createElement("label");rl.textContent="Repeat Layer";const ri=document.createElement("input");ri.type="number";ri.min="1";ri.max="5000";ri.value=n.repeat||1;ri.addEventListener("change",()=>{n.repeat=Math.max(1,Number(ri.value)||1);});repeat.append(rl,ri);body.appendChild(repeat);

          const grid=document.createElement("div");grid.className="mlb-action-grid";
          if(n.definition_id){const open=btn("Open Architecture");open.addEventListener("click",()=>openInside(n));grid.appendChild(open);}
          const dupb=btn("Duplicate");dupb.addEventListener("click",duplicateSelected);grid.appendChild(dupb);
          const disconnect=btn("Disconnect");disconnect.addEventListener("click",()=>{const c=current(state);c.edges=(c.edges||[]).filter(e=>e.source!==n.id&&e.target!==n.id);setStatus("Layer disconnected.");draw();});grid.appendChild(disconnect);
          const dele=btn("Delete");dele.addEventListener("click",()=>deleteNode(n.id));grid.appendChild(dele);
          body.appendChild(grid);

          if(current(state).kind==="custom_edit"){
            const ch=document.createElement("div");ch.className="mlb-section-title";ch.textContent="SAVE CUSTOM COMPONENT";body.appendChild(ch);
            const cg=document.createElement("div");cg.className="mlb-action-grid";
            const over=btn("Override");over.addEventListener("click",()=>saveCustom(false));const sn=btn("Save As New");sn.addEventListener("click",()=>saveCustom(true));cg.append(over,sn);body.appendChild(cg);
          }
        }
      }
      ins.appendChild(body);

      shell.append(side,main,ins);root.appendChild(shell);

      const foot=document.createElement("div");foot.className="mlb-bottom";
      foot.innerHTML="<span>Project: "+(state.project?.name||"Untitled")+"</span><span>Layers: "+current(state).nodes.length+"</span><span>Connections: "+(current(state).edges||[]).length+"</span><span class='mlb-good'>● Valid</span><span class='right'>Backend: MLBricks Runtime &nbsp; | &nbsp; "+status+"</span>";
      root.appendChild(foot);
    }

    draw();
  }

  window.MLBricksBuilder={mount};
})();
