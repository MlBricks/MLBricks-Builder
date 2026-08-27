(function(){
  if(window.MLBricksBuilder) return;
  function copy(v){return JSON.parse(JSON.stringify(v));}
  function uid(p){return p+"_"+Math.random().toString(36).slice(2,10);}
  function current(s){return s.components[s.view_component_id];}
  function findCatalog(catalog,type){return catalog.find(x=>x.type===type)||{};}
  function nodeFrom(item){
    const params={};
    (item.api||[]).forEach(f=>params[f.key]=f.value);
    return {id:uid("node"),type:item.type,name:item.name,definition_id:null,repeat:1,params};
  }
  function mount(root,payload){
    if(!root||root.dataset.mounted==="1") return;
    root.dataset.mounted="1";
    const state=copy(payload.state), catalog=copy(payload.catalog);
    let selected=null, message="Ready", inspectorTab="settings", filter="All", search="";

    function btn(text,cls="mlb-btn"){const b=document.createElement("button");b.type="button";b.className=cls;b.textContent=text;return b;}
    function selNode(){return current(state).nodes.find(n=>n.id===selected)||null;}

    function makeCustom(){
      const comp=current(state);
      if(!comp.nodes.length){message="Add layers first.";draw();return;}
      const name=prompt("Component name:","My Component");
      if(!name)return;
      const id=uid("custom");
      state.custom_components[id]={id,name,revision:1,nodes:copy(comp.nodes)};
      message=name+" saved to My Bricks.";draw();
    }
    function addCustom(def){
      current(state).nodes.push({id:uid("node"),type:"custom",name:def.name,definition_id:def.id,repeat:1,params:{}});
      draw();
    }
    function openInside(node){
      const def=state.custom_components[node.definition_id]; if(!def)return;
      const vid="view_"+def.id;
      state.components[vid]={id:vid,name:def.name,kind:"custom_edit",definition_id:def.id,revision:def.revision,nodes:copy(def.nodes)};
      state.view_component_id=vid;state.breadcrumbs.push({id:vid,name:def.name});selected=null;draw();
    }
    function saveCustom(asNew){
      const comp=current(state), def=state.custom_components[comp.definition_id]; if(!def)return;
      if(asNew){
        const name=prompt("New component name:",def.name+" Copy"); if(!name)return;
        const id=uid("custom"); state.custom_components[id]={id,name,revision:1,nodes:copy(comp.nodes)}; message=name+" created.";
      } else {
        def.nodes=copy(comp.nodes);def.revision=(def.revision||1)+1;comp.revision=def.revision;message=def.name+" updated to v"+def.revision+".";
      }
      draw();
    }
    function exportDesign(){
      const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
      a.href=url;a.download=(state.project?.name||"model").replace(/\s+/g,"_")+".mlbricks";a.click();setTimeout(()=>URL.revokeObjectURL(url),500);
    }
    function renderField(container,node,field){
      const wrap=document.createElement("div");wrap.className="mlb-field";
      const label=document.createElement("label");label.textContent=field.label;
      let input;
      if(field.type==="select"){
        input=document.createElement("select");
        (field.options||[]).forEach(v=>{const o=document.createElement("option");o.value=v;o.textContent=v;if(String(node.params[field.key])===String(v))o.selected=true;input.appendChild(o);});
      } else {
        input=document.createElement("input");input.type=field.type==="number"?"number":"text";input.value=node.params[field.key] ?? field.value ?? "";
        if(field.type==="number") input.step="any";
      }
      input.addEventListener("change",()=>{node.params[field.key]=field.type==="number"?Number(input.value):input.value;message=node.name+" settings updated.";});
      wrap.append(label,input);container.appendChild(wrap);
    }

    function draw(){
      root.innerHTML="";
      const top=document.createElement("div");top.className="mlb-topbar";
      const logo=document.createElement("div");logo.className="mlb-logo";logo.innerHTML='◈ MLBRICKS BUILDER <span class="mlb-beta">BETA</span>';top.appendChild(logo);
      const proj=document.createElement("div");proj.className="mlb-project";proj.textContent=state.project?.name+" (Left → Right)";top.appendChild(proj);
      const nav=document.createElement("div");nav.className="mlb-topnav";["Builder","Train","Evaluate","Deploy"].forEach((x,i)=>{const b=btn(x);if(i===0)b.className="active";nav.appendChild(b);});top.appendChild(nav);
      const sp=document.createElement("div");sp.className="mlb-spacer";top.appendChild(sp);
      ["Save","Load","Share"].forEach(x=>top.appendChild(btn(x)));
      const run=btn("▶ Run","mlb-btn primary");run.addEventListener("click",()=>{message="Graph validated. Runtime bridge next.";draw();});top.appendChild(run);
      root.appendChild(top);

      const shell=document.createElement("div");shell.className="mlb-shell";
      const side=document.createElement("aside");side.className="mlb-sidebar";
      side.innerHTML='<div class="mlb-side-title">COMPONENTS</div>';
      const s=document.createElement("input");s.className="mlb-search";s.placeholder="Search components...";s.value=search;s.addEventListener("input",()=>{search=s.value;draw();});side.appendChild(s);
      const tabs=document.createElement("div");tabs.className="mlb-tabs";
      ["All","Core Blocks","ESA","VESA","Heads","Outputs"].forEach(t=>{const b=btn(t,"mlb-chip"+(filter===t?" active":""));b.addEventListener("click",()=>{filter=t;draw();});tabs.appendChild(b);});side.appendChild(tabs);

      const filtered=catalog.filter(item=>{
        const q=(item.name+" "+item.description+" "+item.category).toLowerCase();
        if(search && !q.includes(search.toLowerCase())) return false;
        if(filter==="All") return true;
        if(filter==="ESA") return item.type==="esa";
        if(filter==="VESA") return item.type==="vesa";
        return item.category===filter;
      });
      const cats=[...new Set(filtered.map(x=>x.category))];
      cats.forEach(cat=>{
        const h=document.createElement("div");h.className="mlb-cat";h.textContent=cat;side.appendChild(h);
        const pal=document.createElement("div");pal.className="mlb-palette";
        filtered.filter(x=>x.category===cat).forEach(item=>{
          const b=document.createElement("button");b.type="button";
          const ico=document.createElement("span");ico.className="mlb-icon";ico.textContent=item.icon;
          const tx=document.createElement("span");tx.innerHTML='<strong>'+item.name+'</strong><span class="sub">'+item.description+'</span>';
          b.append(ico,tx);b.addEventListener("click",()=>{current(state).nodes.push(nodeFrom(item));message=item.name+" added.";draw();});pal.appendChild(b);
        });side.appendChild(pal);
      });
      const myTitle=document.createElement("div");myTitle.className="mlb-cat";myTitle.textContent="My Bricks";side.appendChild(myTitle);
      Object.values(state.custom_components||{}).forEach(def=>{const b=document.createElement("button");b.className="mlb-custom-item";b.type="button";b.innerHTML='<span class="mlb-icon">MY</span><span><strong>'+def.name+'</strong><span class="sub">Custom · v'+def.revision+'</span></span>';b.addEventListener("click",()=>addCustom(def));side.appendChild(b);});
      const cc=btn("+ Create Custom Brick");cc.style.width="100%";cc.style.marginTop="8px";cc.addEventListener("click",makeCustom);side.appendChild(cc);

      const main=document.createElement("main");main.className="mlb-main";
      const toolbar=document.createElement("div");toolbar.className="mlb-toolbar";
      const add=btn("+ Add Layer");add.addEventListener("click",()=>{message="Choose a component from the left.";draw();});toolbar.appendChild(add);
      const dup=btn("Duplicate");dup.addEventListener("click",()=>{const n=selNode();if(n){const c=copy(n);c.id=uid("node");current(state).nodes.splice(current(state).nodes.findIndex(x=>x.id===n.id)+1,0,c);draw();}});toolbar.appendChild(dup);
      const del=btn("Delete");del.addEventListener("click",()=>{if(selected){current(state).nodes=current(state).nodes.filter(x=>x.id!==selected);selected=null;draw();}});toolbar.appendChild(del);
      const clear=btn("Clear All");clear.addEventListener("click",()=>{current(state).nodes=[];selected=null;draw();});toolbar.appendChild(clear);
      const spacer=document.createElement("div");spacer.style.flex="1";toolbar.appendChild(spacer);
      const auto=document.createElement("span");auto.style.fontSize="10px";auto.textContent="Auto Connect  ●";toolbar.appendChild(auto);
      main.appendChild(toolbar);

      const canvas=document.createElement("div");canvas.className="mlb-canvas";
      const crumbs=document.createElement("div");crumbs.className="mlb-breadcrumbs";
      state.breadcrumbs.forEach((c,i)=>{const b=btn(c.name,"mlb-crumb");b.addEventListener("click",()=>{state.view_component_id=c.id;state.breadcrumbs=state.breadcrumbs.slice(0,i+1);selected=null;draw();});crumbs.appendChild(b);if(i<state.breadcrumbs.length-1){const sep=document.createElement("span");sep.textContent="/";crumbs.appendChild(sep);}});
      canvas.appendChild(crumbs);
      const flow=document.createElement("div");flow.className="mlb-flow";
      const comp=current(state);
      if(!comp.nodes.length){const e=document.createElement("div");e.className="mlb-empty";e.textContent="Add layers from the left. The model stays compact and aligned left → right.";flow.appendChild(e);}
      else comp.nodes.forEach((n,i)=>{
        if(i){const a=document.createElement("div");a.className="mlb-arrow";a.textContent="→";flow.appendChild(a);}
        const cat=findCatalog(catalog,n.type);
        const el=document.createElement("div");el.className="mlb-node"+(selected===n.id?" selected":"");
        el.innerHTML='<span class="num">'+(i+1)+'</span><span class="mlb-port in"></span><div class="bigicon"></div><div class="name"></div><div class="desc"></div><div class="meta"></div><span class="mlb-port out"></span>';
        el.querySelector(".bigicon").textContent=cat.icon||"MY";
        el.querySelector(".name").textContent=n.name;
        el.querySelector(".desc").textContent=cat.description || (n.definition_id?"Custom Component":"Layer");
        const meta=el.querySelector(".meta");
        if(n.repeat>1) meta.textContent="Repeat ×"+n.repeat; else if(n.params?.dim) meta.textContent="Hidden "+n.params.dim; else meta.textContent="Layer";
        el.addEventListener("click",()=>{selected=n.id;draw();});flow.appendChild(el);
      });
      canvas.appendChild(flow);main.appendChild(canvas);

      const ins=document.createElement("aside");ins.className="mlb-inspector";
      const itabs=document.createElement("div");itabs.className="mlb-ins-tabs";
      [["settings","Layer Settings"],["info","Model Settings"]].forEach(([k,t])=>{const b=btn(t);b.className=inspectorTab===k?"active":"";b.addEventListener("click",()=>{inspectorTab=k;draw();});itabs.appendChild(b);});ins.appendChild(itabs);
      const ib=document.createElement("div");ib.className="mlb-ins-body";
      const n=selNode();
      if(!n){ib.innerHTML='<div class="mlb-note">Select a component to open its API interface and edit its parameters.</div>';}
      else{
        const cat=findCatalog(catalog,n.type);
        const pill=document.createElement("div");pill.className="mlb-selected-pill";pill.textContent=n.name;ib.appendChild(pill);
        const st=document.createElement("div");st.className="mlb-section-title";st.textContent=inspectorTab==="settings"?(n.type==="custom"?"Custom Component API":n.name+" API"):"Layer Info";ib.appendChild(st);
        if(inspectorTab==="settings"){
          const nameWrap=document.createElement("div");nameWrap.className="mlb-field";const lab=document.createElement("label");lab.textContent="Name";const inp=document.createElement("input");inp.value=n.name;inp.addEventListener("change",()=>{n.name=inp.value||n.name;draw();});nameWrap.append(lab,inp);ib.appendChild(nameWrap);
          (cat.api||[]).forEach(f=>renderField(ib,n,f));
          const rw=document.createElement("div");rw.className="mlb-field";const rl=document.createElement("label");rl.textContent="Repeat";const ri=document.createElement("input");ri.type="number";ri.min="1";ri.max="100000";ri.value=n.repeat||1;ri.addEventListener("change",()=>{n.repeat=Math.max(1,Number(ri.value)||1);draw();});rw.append(rl,ri);ib.appendChild(rw);
          const actions=document.createElement("div");actions.className="mlb-actions";
          if(n.definition_id){const open=btn("Open Inside");open.addEventListener("click",()=>openInside(n));actions.appendChild(open);}
          ib.appendChild(actions);
        } else {
          const sum=document.createElement("div");sum.className="mlb-summary";
          const rows=[["Type",n.type],["Repeat",n.repeat||1],["Definition",n.definition_id?"Custom":"Built-in"],["Status","Valid"]];
          rows.forEach(([a,b])=>{const r=document.createElement("div");r.className="row";r.innerHTML='<span>'+a+'</span><strong>'+b+'</strong>';sum.appendChild(r);});ib.appendChild(sum);
        }
        if(current(state).kind==="custom_edit"){
          const actions=document.createElement("div");actions.className="mlb-actions";
          const ov=btn("Override / New Revision");ov.addEventListener("click",()=>saveCustom(false));
          const sn=btn("Save As New");sn.addEventListener("click",()=>saveCustom(true));actions.append(ov,sn);ib.appendChild(actions);
        }
      }
      ins.appendChild(ib);
      shell.append(side,main,ins);root.appendChild(shell);

      const bottom=document.createElement("div");bottom.className="mlb-bottom";
      bottom.innerHTML='<span>Project: '+(state.project?.name||"Untitled")+'</span><span>Layers: '+current(state).nodes.length+'</span><span class="mlb-status-ok">● Valid</span><span style="margin-left:auto">Backend: MLBricks Runtime</span><span>'+message+'</span>';
      root.appendChild(bottom);
    }
    draw();
  }
  window.MLBricksBuilder={mount};
})();
