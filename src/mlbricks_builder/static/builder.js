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
    let searchFocusRestore=null;
    const inspectorScrollPositions={};
    let lastInspectorRenderKey=null;
    const bridge=payload.bridge||null;
    const isPopout=!!(bridge&&(bridge.mode==="broadcast"||bridge.mode==="popout"));
    const popoutChannelName=(bridge&&bridge.channel)||("mlbricks-builder-"+(payload.instance_id||root.id||"session"));
    let popoutChannel=null;
    let popoutHostConnected=!isPopout;
    let popoutPeerWindow=null;
    let popoutMessagePort=null;
    let popoutPeerConnected=false;
    let popoutHelloTimer=null;
    let pendingBroadcastState=null;
    let pendingBroadcastCommand=null;
    let popoutSyncTimer=null;
    const runtimeCaps=cp(payload.runtime_capabilities||{devices:[{id:"auto",label:"Auto"},{id:"cpu",label:"CPU"}]});
    const localEnvironment=cp(payload.local_environment||{kind:"python",name:"Python / Jupyter Environment",roots:["."],default_root:"."});
    const localDefaultRoot=localEnvironment.workspace_root||localEnvironment.default_root||(localEnvironment.roots||[])[0]||".";
    const localPaths=cp(localEnvironment.paths||{});
    let runtimePanel=null;
    let galleryWorkspace={open:false,tab:"models"};
    let galleryPreviousBottomExpanded=true;
    let cloudWorkspace={open:false};
    let cloudPreviousBottomExpanded=true;
    let execution={status:"idle",overall:0,message:"Ready",nodes:{}};
    let localFiles={roots:[],entries:[],truncated:false};
    let localImportReports={model:null,data:null};
    let localForm={model_path:localDefaultRoot,data_path:localDefaultRoot};
    let serveSecrets={};
    let cloudStatus={};
    let cloudSecrets={
      huggingface:{token:""},
      github:{token:""},
      aws:{access_key:"",secret_key:"",session_token:""},
      gcp:{service_account_json:""},
      azure:{connection_string:""}
    };
    let cloudForm={
      provider:"huggingface",
      push_type:state.active_workspace==="data"?"dataset":"model",
      push_artifact:"",
      load_type:state.active_workspace==="data"?"dataset":"model",
      repo:"",
      branch:"main",
      revision:"main",
      bucket:"",
      container:"",
      object_path:"",
      private:true,
      region:""
    };
    let lastProgressRaw="";
    let bridgePollTimer=null;
    let bridgeAwaitTimer=null;
    let bridgeLastReady=false;
    let runtimeStatusRedrawTimer=null;
    let modelBuildTimer=null;
    const workspaceScroll={model:{left:0,top:0},data:{left:0,top:0}};
    const sidebarScroll={model:{left:0,top:0},data:{left:0,top:0}};
    let switchingWorkspace=false;
    const undoStack=[],redoStack=[];
    const historyLimit=60;
    const componentImportQueue=[];
    let componentImportBusy=false;
    const customImportStatus={};

    // Single-click reliability guard. A focused editor can emit change/blur on
    // pointerdown when the user clicks another control. Those handlers may call
    // draw(), which replaces the DOM before the target control receives click.
    // Defer only that redraw until the click completes.
    let pointerInteractionActive=false;
    let deferredInteractionDraw=false;
    let interactionReleaseQueued=false;

    function isCommitEditor(el){
      return !!(el && el.matches && el.matches('input,textarea,select,[contenteditable="true"]'));
    }

    function releasePointerInteraction(){
      interactionReleaseQueued=false;
      if(!pointerInteractionActive && !deferredInteractionDraw)return;
      pointerInteractionActive=false;
      if(deferredInteractionDraw){
        deferredInteractionDraw=false;
        draw();
      }
    }

    root.addEventListener("pointerdown",ev=>{
      const active=root.ownerDocument?.activeElement;
      pointerInteractionActive=!!(active && root.contains(active) && isCommitEditor(active) && active!==ev.target && !active.contains?.(ev.target));
      interactionReleaseQueued=false;
    },true);
    root.addEventListener("click",()=>{
      if(!pointerInteractionActive||interactionReleaseQueued)return;
      interactionReleaseQueued=true;
      queueMicrotask(releasePointerInteraction);
    },true);
    root.addEventListener("pointerup",()=>{
      if(!pointerInteractionActive)return;
      // click normally follows pointerup; this is only a fallback for a
      // pointer interaction that does not produce click.
      setTimeout(()=>{if(pointerInteractionActive)releasePointerInteraction();},0);
    },true);
    root.addEventListener("pointercancel",releasePointerInteraction,true);

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
    const collapsedCategories=new Set(["Advanced","Position","Heads","Outputs","Image","Audio"]);
    const collapsedInspectorGroups=new Set();
    let myBricksCollapsed=false;
    let customActionMenuId=null;
    let bottomExpanded=true;
    let bottomView="details";
    let outputDirectorySelection=null;
    let filesFilter="all";

    Object.values(state.components||{}).forEach(c=>{if(!c.edges)c.edges=[];});
    if(state.auto_connect===undefined) state.auto_connect=true;

    function ensureWorkspaces(){
      if(!Array.isArray(state.prepared_datasets))state.prepared_datasets=[];
      if(!Array.isArray(state.model_outputs))state.model_outputs=[];
      if(!Array.isArray(state.project_files))state.project_files=[];
      if(!state.gallery||typeof state.gallery!=="object")state.gallery={components:[],models:[],data:[]};
      if(!Array.isArray(state.gallery.components))state.gallery.components=[];
      if(!Array.isArray(state.gallery.models))state.gallery.models=[];
      if(!Array.isArray(state.gallery.data))state.gallery.data=[];
      if(!state.layout_locks||typeof state.layout_locks!=="object")state.layout_locks={};
      if(!state.workspaces){
        const modelRoot=state.root_component_id;
        const dataRoot=uid("component");
        const starter=defaultDataNodes();
        state.components[dataRoot]={
          id:dataRoot,name:"Data Processing",kind:"data",revision:1,nodes:starter.nodes,edges:starter.edges
        };
        state.workspaces={
          model:{
            name:"Model Builder",
            root_component_id:modelRoot,
            view_component_id:state.view_component_id||modelRoot,
            breadcrumbs:cp(state.breadcrumbs||[{id:modelRoot,name:state.project?.name||"Model"}])
          },
          data:{
            name:"Data Processing",
            root_component_id:dataRoot,
            view_component_id:dataRoot,
            breadcrumbs:[{id:dataRoot,name:"Data Processing"}]
          }
        };
        state.active_workspace="model";
      }
      if(!state.active_workspace || !state.workspaces[state.active_workspace]){
        state.active_workspace="model";
      }
      const ws=state.workspaces[state.active_workspace];
      if(!ws.view_component_id || !state.components[ws.view_component_id]){
        ws.view_component_id=ws.root_component_id;
      }
      if(!Array.isArray(ws.breadcrumbs)||!ws.breadcrumbs.length){
        ws.breadcrumbs=[{id:ws.root_component_id,name:ws.name}];
      }
      state.view_component_id=ws.view_component_id;
      state.breadcrumbs=cp(ws.breadcrumbs);
    }

    function rememberWorkspaceView(){
      const ws=state.workspaces?.[state.active_workspace];
      if(!ws)return;
      ws.view_component_id=state.view_component_id;
      ws.breadcrumbs=cp(state.breadcrumbs||[]);
    }

    function workspaceName(){
      return state.active_workspace==="data" ? "Data Processing" : "Model Builder";
    }

    function inspectorRenderKey(){
      const target=outputDirectorySelection
        ?("output:"+outputDirectorySelection)
        :(selected?("node:"+selected):"empty");
      return (state.active_workspace||"model")+"|"+inspectorTab+"|"+target;
    }

    function renameProjectInline(rawName){
      const name=String(rawName||"").trim().replace(/\s+/g," ");
      const modelRootId=state.workspaces?.model?.root_component_id||state.root_component_id;
      const modelRoot=state.components?.[modelRootId];
      const oldName=String(state.project?.name||modelRoot?.name||"Untitled Model");
      if(!name){setStatus("Model name cannot be empty.");draw();return false;}
      if(name===oldName)return true;
      if(modelRoot && layoutNameExists(name,modelRoot.id)){
        setStatus('Another layout is already named "'+name+'".');draw();return false;
      }
      checkpoint("Rename model");
      state.project=state.project||{};
      state.project.name=name;
      if(modelRoot)modelRoot.name=name;
      const modelWs=state.workspaces?.model;
      if(modelWs?.breadcrumbs?.length)modelWs.breadcrumbs[0].name=name;
      if(state.active_workspace==="model" && state.breadcrumbs?.length && state.breadcrumbs[0]?.id===modelRootId){
        state.breadcrumbs[0].name=name;
      }
      setStatus('Model renamed to "'+name+'".');
      draw();
      return true;
    }

    function switchWorkspace(next){
      if(next===state.active_workspace)return;
      const oldKey=state.active_workspace||"model";
      const oldCanvas=root.querySelector(".mlb-canvas");
      if(oldCanvas){
        workspaceScroll[oldKey]={left:oldCanvas.scrollLeft,top:oldCanvas.scrollTop};
      }
      const oldSidebar=root.querySelector(".mlb-sidebar");
      if(oldSidebar){
        sidebarScroll[oldKey]={left:oldSidebar.scrollLeft,top:oldSidebar.scrollTop};
      }
      rememberWorkspaceView();
      runtimePanel=null;
      state.active_workspace=next;
      const ws=state.workspaces[next];
      state.view_component_id=ws.view_component_id||ws.root_component_id;
      state.breadcrumbs=cp(ws.breadcrumbs||[{id:ws.root_component_id,name:ws.name}]);
      selected=null;pendingPort=null;search="";
      switchingWorkspace=true;
      setStatus(workspaceName()+" opened.");
      draw();
    }

    const dataNodeTypes=new Set([
      "manual_dataset","hf_dataset","kaggle_dataset","url_dataset","local_dataset",
      "text_process","train_test_split","tokenize_text","image_process","audio_process",
      "batch_data","prepared_dataset"
    ]);
    function itemWorkspace(item){
      return dataNodeTypes.has(item.type) ? "data" : "model";
    }
    function defaultDataNodes(){
      const nodes=[
        makeNode(cat(catalog,"hf_dataset")),
        makeNode(cat(catalog,"text_process")),
        makeNode(cat(catalog,"train_test_split")),
        makeNode(cat(catalog,"tokenize_text")),
        makeNode(cat(catalog,"prepared_dataset"))
      ];
      nodes[0].params.dataset_id="roneneldan/TinyStories";
      nodes[0].params.split="train";
      nodes[0].params.max_rows=10000;
      nodes[2].params.train_size=90;
      nodes[2].params.validation_size=5;
      nodes[2].params.test_size=5;
      const edges=[];
      for(let i=0;i<nodes.length-1;i++){
        const e=edge(nodes[i].id,nodes[i+1].id,"main");
        e.source_port="main_out";e.target_port="main_in";edges.push(e);
      }
      return {nodes,edges};
    }


    ensureWorkspaces();
    loadGalleryStorage();

    function normalizedUserName(value){return String(value||"").trim().replace(/\s+/g," ").toLowerCase();}

    function layoutIsLocked(componentId=state.view_component_id){
      return !!state.layout_locks?.[componentId];
    }

    function requireEditableLayout(action="edit this layout"){
      if(!layoutIsLocked())return true;
      setStatus("Layout is locked. Click Edit Layout before you "+action+".");
      return false;
    }

    function toggleLayoutLock(){
      const id=state.view_component_id;
      if(!id)return;
      checkpoint(layoutIsLocked(id)?"Edit layout":"Lock layout");
      state.layout_locks[id]=!layoutIsLocked(id);
      pendingPort=null;
      setStatus(state.layout_locks[id]?"Layout locked. Structure is protected.":"Edit Layout enabled.");
      draw();
    }

    function nodeNameExists(name,component=current(state),exceptId=null){
      const wanted=normalizedUserName(name);
      return !!wanted && (component?.nodes||[]).some(n=>n.id!==exceptId&&normalizedUserName(n.name)===wanted);
    }

    function uniqueNodeName(base,component=current(state),exceptId=null){
      const clean=String(base||"Component").trim().replace(/\s+/g," ")||"Component";
      if(!nodeNameExists(clean,component,exceptId))return clean;
      let i=2;
      while(nodeNameExists(clean+" "+i,component,exceptId))i++;
      return clean+" "+i;
    }

    function nodeDisplayName(node){
      if(!node)return "Component";
      if(node.display_name)return String(node.display_name);
      let base="";
      if(node.definition_id&&state.custom_components?.[node.definition_id]){
        base=String(state.custom_components[node.definition_id].name||"").trim();
      }else{
        base=String(cat(catalog,node.type)?.name||"").trim();
      }
      const actual=String(node.name||base||"Component").trim();
      if(!base)return actual;
      if(actual===base)return base;
      if(actual.startsWith(base+" ")){
        const suffix=actual.slice(base.length+1);
        if(/^\d+$/.test(suffix) || /^Copy(?: \d+)?$/i.test(suffix))return base;
      }
      return actual;
    }

    function compactIconLabel(label){
      const raw=String(label||"ML").trim().toUpperCase();
      if(!raw) return "ML";
      if(raw==="SPLIT") return "SPLT";
      return raw.length>4 ? raw.slice(0,4) : raw;
    }

    function layoutNameExists(name,exceptId=null){
      const wanted=normalizedUserName(name);
      if(!wanted)return false;
      return Object.values(state.components||{}).some(c=>c.id!==exceptId&&normalizedUserName(c.name)===wanted);
    }

    function uniqueCustomDefinitionName(base){
      const clean=String(base||"My Component").trim().replace(/\s+/g," ")||"My Component";
      if(!customNameExists(clean))return clean;
      let i=2;
      while(customNameExists(clean+" "+i))i++;
      return clean+" "+i;
    }

    function renameCurrentLayout(){
      const c=current(state);if(!c)return;
      const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
      const proposed=win&&typeof win.prompt==="function"?win.prompt("Rename layout:",c.name||state.project?.name||"Layout"):null;
      if(proposed===null)return;
      const name=String(proposed||"").trim().replace(/\s+/g," ");
      if(!name){setStatus("Layout name cannot be empty.");return;}
      if(layoutNameExists(name,c.id)){setStatus('Another layout is already named "'+name+'".');return;}
      checkpoint("Rename layout");
      const oldName=c.name;
      c.name=name;
      const crumbs=state.breadcrumbs||[];
      if(crumbs.length)crumbs[crumbs.length-1].name=name;
      const ws=state.workspaces?.[state.active_workspace];
      if(ws?.breadcrumbs?.length)ws.breadcrumbs[ws.breadcrumbs.length-1].name=name;
      if(c.id===state.workspaces?.model?.root_component_id){
        state.project=state.project||{};state.project.name=name;
        if(state.workspaces.model?.breadcrumbs?.length)state.workspaces.model.breadcrumbs[0].name=name;
        if(state.breadcrumbs?.length===1)state.breadcrumbs[0].name=name;
      }
      if(c.kind==="custom_edit"&&c.definition_id&&state.custom_components?.[c.definition_id]){
        if(customNameExists(name,c.definition_id)){
          c.name=oldName;
          setStatus('A custom component named "'+name+'" already exists.');
          return;
        }
        const def=state.custom_components[c.definition_id];
        def.name=name;
        Object.values(state.components||{}).forEach(comp=>(comp.nodes||[]).forEach(n=>{if(n.definition_id===def.id){n.name=uniqueNodeName(name,comp,n.id);n.display_name=name;}}));
      }
      setStatus('Layout renamed to "'+name+'".');draw();
    }

    function renameSelectedComponent(){
      const n=selectedNode();if(!n)return;
      const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
      const proposed=win&&typeof win.prompt==="function"?win.prompt("Rename component:",n.name||"Component"):null;
      if(proposed===null)return;
      const name=String(proposed||"").trim().replace(/\s+/g," ");
      if(!name){setStatus("Component name cannot be empty.");return;}
      if(nodeNameExists(name,current(state),n.id)){setStatus('Another component in this layout is already named "'+name+'".');return;}
      checkpoint("Rename component");n.name=name;n.display_name=name;setStatus('Component renamed to "'+name+'".');draw();
    }

    const galleryStorageKey="mlbricks-builder-gallery-v1";
    function loadGalleryStorage(){
      try{
        const store=(root.ownerDocument?.defaultView||window).localStorage;
        const parsed=JSON.parse(store.getItem(galleryStorageKey)||"null");
        if(!parsed)return;
        ["components","models","data"].forEach(kind=>{
          const existing=new Set((state.gallery[kind]||[]).map(x=>x.id));
          (parsed[kind]||[]).forEach(item=>{if(item?.id&&!existing.has(item.id))state.gallery[kind].push(cp(item));});
        });
      }catch(_){/* browser storage is optional in notebook iframes */}
    }

    function persistGallery(){
      try{(root.ownerDocument?.defaultView||window).localStorage.setItem(galleryStorageKey,JSON.stringify(state.gallery));}catch(_){ }
    }

    function galleryNameExists(kind,name,exceptId=null){
      const wanted=normalizedUserName(name);
      return (state.gallery?.[kind]||[]).some(x=>x.id!==exceptId&&normalizedUserName(x.name)===wanted);
    }

    function askGalleryName(kind,defaultName,label){
      const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
      const proposed=win&&typeof win.prompt==="function"?win.prompt(label,defaultName||""):null;
      if(proposed===null)return null;
      const name=String(proposed||"").trim().replace(/\s+/g," ");
      if(!name){setStatus("Gallery name cannot be empty.");return null;}
      if(galleryNameExists(kind,name)){setStatus('Gallery already contains "'+name+'".');return null;}
      return name;
    }

    function saveCurrentToGallery(){
      const c=current(state);if(!c)return;
      if(c.kind==="custom_edit"){
        const def=state.custom_components?.[c.definition_id];
        const name=askGalleryName("components",def?.name||c.name,"Save component to Gallery as:");
        if(!name)return;
        state.gallery.components.push({
          id:uid("gallery_component"),name,kind:"component",saved_at:new Date().toISOString(),
          definition:{id:def?.id||uid("custom"),name,description:def?.description||"Reusable custom component",revision:def?.revision||1,implementation:def?.implementation||"graph",api_binding:cp(def?.api_binding||null),input_count:3,output_count:3,nodes:cp(c.nodes||[]),edges:cp(c.edges||[])}
        });
        persistGallery();setStatus(name+" saved to Component Gallery.");draw();return;
      }
      if(state.active_workspace==="data"){
        const pipeline=current(state);if(!pipeline)return;
        const name=askGalleryName("data",pipeline.name||"Data Pipeline","Save data pipeline to Gallery as:");
        if(!name)return;
        state.gallery.data.push({
          id:uid("gallery_data"),name,kind:"data",saved_at:new Date().toISOString(),
          architecture:cp(pipeline)
        });
        persistGallery();setStatus(name+" saved to Data Gallery.");draw();return;
      }
      if(state.active_workspace!=="model"){
        setStatus("Open Model Builder or Data Processing to save the current design to Gallery.");return;
      }
      const model=modelRootComponent();if(!model)return;
      const name=askGalleryName("models",state.project?.name||model.name||"My Model","Save model to Gallery as:");
      if(!name)return;
      state.gallery.models.push({
        id:uid("gallery_model"),name,kind:"model",saved_at:new Date().toISOString(),
        project:cp(state.project||{}),architecture:cp(model),custom_components:cp(state.custom_components||{})
      });
      persistGallery();setStatus(name+" saved to Model Gallery.");draw();
    }

    function addGalleryComponent(entry){
      if(!entry?.definition)return;
      const source=cp(entry.definition);const id=uid("custom");const name=uniqueCustomDefinitionName(entry.name||source.name);
      source.id=id;source.name=name;source.revision=1;
      source.palette_hidden=false;source.palette_installed=true;source.gallery_entry_id=entry.id;
      state.custom_components[id]=source;
      persistGallery();setStatus(name+" added to My Components.");draw();
    }

    function loadGalleryModel(entry){
      if(!entry?.architecture)return;
      checkpoint("Load model from Gallery");
      rememberWorkspaceView();
      state.active_workspace="model";
      const rootId=state.workspaces.model.root_component_id;
      const architecture=cp(entry.architecture);
      const remap={};
      Object.entries(entry.custom_components||{}).forEach(([oldId,def])=>{
        const existing=Object.values(state.custom_components||{}).find(x=>normalizedUserName(x.name)===normalizedUserName(def.name));
        if(existing){remap[oldId]=existing.id;return;}
        const newId=uid("custom");const copyDef=cp(def);copyDef.id=newId;copyDef.name=uniqueCustomDefinitionName(copyDef.name);state.custom_components[newId]=copyDef;remap[oldId]=newId;
      });
      (architecture.nodes||[]).forEach(n=>{if(n.definition_id&&remap[n.definition_id])n.definition_id=remap[n.definition_id];n.name=uniqueNodeName(n.name,{nodes:(architecture.nodes||[]).filter(x=>x.id!==n.id)},n.id);});
      architecture.id=rootId;architecture.name=entry.name;
      state.components[rootId]=architecture;
      state.root_component_id=rootId;state.view_component_id=rootId;
      state.project={...(entry.project||{}),name:entry.name};
      state.breadcrumbs=[{id:rootId,name:entry.name}];
      state.workspaces.model.view_component_id=rootId;state.workspaces.model.breadcrumbs=cp(state.breadcrumbs);
      selected=null;pendingPort=null;setStatus(entry.name+" loaded from Gallery.");draw();
    }

    function loadGalleryData(entry){
      if(!entry?.architecture)return;
      checkpoint("Load data pipeline from Gallery");
      rememberWorkspaceView();
      state.active_workspace="data";
      const ws=state.workspaces.data;
      const rootId=ws.root_component_id;
      const architecture=cp(entry.architecture);
      architecture.id=rootId;architecture.name=entry.name;architecture.kind="data";
      state.components[rootId]=architecture;
      state.view_component_id=rootId;
      state.breadcrumbs=[{id:rootId,name:entry.name}];
      ws.view_component_id=rootId;ws.breadcrumbs=cp(state.breadcrumbs);
      selected=null;pendingPort=null;
      execution={status:"idle",overall:0,message:"Ready",nodes:{}};
      switchingWorkspace=true;
      setStatus(entry.name+" loaded from Gallery.");draw();
    }

    function removeGalleryEntry(kind,id){
      const entry=(state.gallery?.[kind]||[]).find(x=>x.id===id);
      const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
      const label=entry?.name||"this Gallery item";
      if(win&&typeof win.confirm==="function"&&!win.confirm('Remove "'+label+'" from Gallery?'))return;
      checkpoint("Remove Gallery item");
      state.gallery[kind]=(state.gallery[kind]||[]).filter(x=>x.id!==id);
      persistGallery();setStatus(label+" removed from Gallery.");draw();
    }

    function openGallery(tab){
      runtimePanel=null;
      if(!galleryWorkspace.open&&!cloudWorkspace.open)galleryPreviousBottomExpanded=bottomExpanded;
      else if(cloudWorkspace.open)galleryPreviousBottomExpanded=cloudPreviousBottomExpanded;
      cloudWorkspace.open=false;
      bottomExpanded=false;
      galleryWorkspace={open:true,tab:["models","components","data"].includes(tab)?tab:"models"};
      outputDirectorySelection=null;
      selected=null;
      setStatus("Gallery opened.");
      draw();
    }

    function closeGallery(){
      galleryWorkspace.open=false;
      bottomExpanded=galleryPreviousBottomExpanded;
      setStatus("Gallery closed.");
      draw();
    }

    function openCloudWorkspace(){
      runtimePanel=null;
      if(!cloudWorkspace.open&&!galleryWorkspace.open)cloudPreviousBottomExpanded=bottomExpanded;
      else if(galleryWorkspace.open)cloudPreviousBottomExpanded=galleryPreviousBottomExpanded;
      galleryWorkspace.open=false;
      cloudWorkspace.open=true;
      bottomExpanded=false;
      outputDirectorySelection=null;
      selected=null;
      setStatus("Cloud & Repositories opened.");
      draw();
    }

    function closeCloudWorkspace(){
      cloudWorkspace.open=false;
      bottomExpanded=cloudPreviousBottomExpanded;
      setStatus("Cloud & Repositories closed.");
      draw();
    }

    function bridgeDocuments(){
      const docs=[];
      const add=doc=>{if(doc && !docs.includes(doc))docs.push(doc);};
      add(document);
      try{add(window.parent && window.parent.document);}catch(_){}
      try{add(window.top && window.top.document);}catch(_){}

      // Kaggle/Jupyter may render output and standard widgets in neighboring
      // same-origin frames. Search accessible frame documents as a fallback.
      const parents=[...docs];
      parents.forEach(doc=>{
        try{
          doc.querySelectorAll("iframe").forEach(frame=>{
            try{add(frame.contentDocument);}catch(_){}
          });
        }catch(_){}
      });
      return docs;
    }

    function deepQuery(rootNode,selector){
      if(!rootNode)return null;
      try{
        const direct=rootNode.querySelector(selector);
        if(direct)return direct;
        const all=rootNode.querySelectorAll("*");
        for(const el of all){
          if(el.shadowRoot){
            const found=deepQuery(el.shadowRoot,selector);
            if(found)return found;
          }
        }
      }catch(_){}
      return null;
    }

    function bridgeRoot(cls){
      if(!cls)return null;
      const selector="."+cls;
      for(const doc of bridgeDocuments()){
        const found=deepQuery(doc,selector);
        if(found)return found;
      }
      return null;
    }

    function bridgeControl(cls,selector){
      if(isPopout){
        if(selector==="button")return {__mlbBroadcastKind:cls===bridge?.stop?"stop":"run",click(){return true;}};
        if(selector==="textarea")return {value:lastProgressRaw||""};
      }
      const host=bridgeRoot(cls);
      if(!host)return null;
      if(host.matches && host.matches(selector))return host;
      return deepQuery(host,selector);
    }

    function setNativeValue(input,value){
      if(!input)return false;
      try{
        const view=input.ownerDocument?.defaultView||window;
        const proto=view.HTMLTextAreaElement && input instanceof view.HTMLTextAreaElement
          ? view.HTMLTextAreaElement.prototype
          : view.HTMLInputElement?.prototype;
        const descriptor=proto ? Object.getOwnPropertyDescriptor(proto,"value") : null;
        if(descriptor?.set)descriptor.set.call(input,value);
        else input.value=value;

        input.dispatchEvent(new view.Event("input",{bubbles:true,composed:true}));
        input.dispatchEvent(new view.Event("change",{bubbles:true,composed:true}));
        return true;
      }catch(_){
        try{
          input.value=value;
          input.dispatchEvent(new Event("input",{bubbles:true}));
          input.dispatchEvent(new Event("change",{bubbles:true}));
          return true;
        }catch(__){return false;}
      }
    }

    function popoutPacket(message){
      return Object.assign({__mlbricks_builder_popout__:true,channel:popoutChannelName},message||{});
    }

    function attachPopoutMessagePort(port){
      if(!port)return false;
      try{
        if(popoutMessagePort && popoutMessagePort!==port){
          try{popoutMessagePort.close();}catch(_){}
        }
        popoutMessagePort=port;
        popoutMessagePort.onmessage=event=>{
          try{handlePopoutMessage(event.data||{},null);}catch(_){}
        };
        try{popoutMessagePort.start();}catch(_){}
        return true;
      }catch(_){return false;}
    }

    function sendPopoutMessage(message){
      const packet=popoutPacket(message);
      let sent=false;
      // Prefer the dedicated transferred MessagePort, but also send through the
      // browser-window fallbacks. Duplicates are harmless and this prevents a
      // stale port from hiding a working opener/BroadcastChannel route.
      try{if(popoutMessagePort){popoutMessagePort.postMessage(packet);sent=true;}}catch(_){popoutMessagePort=null;}

      if(isPopout){
        try{
          if(window.opener && !window.opener.closed){
            window.opener.postMessage(packet,"*");
            sent=true;
          }
        }catch(_){}
        try{if(popoutChannel){popoutChannel.postMessage(packet);sent=true;}}catch(_){}
        return sent;
      }

      try{
        if(popoutPeerWindow && !popoutPeerWindow.closed){
          popoutPeerWindow.postMessage(packet,"*");
          sent=true;
        }
      }catch(_){}
      try{if(popoutChannel){popoutChannel.postMessage(packet);sent=true;}}catch(_){}
      return sent;
    }

    function sendHostReply(targetWindow,message){
      const packet=popoutPacket(Object.assign({source:"host"},message||{}));
      let sent=false;
      try{if(popoutMessagePort){popoutMessagePort.postMessage(packet);sent=true;}}catch(_){popoutMessagePort=null;}
      try{
        if(targetWindow && !targetWindow.closed){
          targetWindow.postMessage(packet,"*");
          sent=true;
        }
      }catch(_){}
      try{
        if(popoutPeerWindow && popoutPeerWindow!==targetWindow && !popoutPeerWindow.closed){
          popoutPeerWindow.postMessage(packet,"*");
          sent=true;
        }
      }catch(_){}
      try{if(popoutChannel){popoutChannel.postMessage(packet);sent=true;}}catch(_){}
      return sent;
    }

    function clickBridgeButton(button){
      if(!button)return false;
      if(isPopout&&button.__mlbBroadcastKind){
        if(!popoutHostConnected)return false;
        if(button.__mlbBroadcastKind==="stop") return sendPopoutMessage({type:"stop",source:"popout",ts:Date.now()});
        const ok=sendPopoutMessage({type:"command",source:"popout",ts:Date.now(),state:pendingBroadcastState||bridgeStatePayload(),command:pendingBroadcastCommand||{action:"data",ts:Date.now()}});
        pendingBroadcastCommand=null;
        return ok;
      }
      try{
        button.click();
        return true;
      }catch(_){
        try{
          const view=button.ownerDocument?.defaultView||window;
          button.dispatchEvent(new view.MouseEvent("click",{
            bubbles:true,cancelable:true,view
          }));
          return true;
        }catch(__){return false;}
      }
    }

    function bridgeReady(){
      if(!bridge)return false;
      if(isPopout)return !!popoutHostConnected;
      return !!(
        bridgeControl(bridge.state,"textarea") &&
        (!bridge.command||bridgeControl(bridge.command,"textarea")) &&
        bridgeControl(bridge.run,"button") &&
        bridgeControl(bridge.stop,"button") &&
        bridgeControl(bridge.progress,"textarea")
      );
    }

    function updateKernelBadge(){
      const badge=root.querySelector(".mlb-kernel-badge");
      if(!badge)return;
      const ready=bridgeReady();
      bridgeLastReady=ready;
      badge.className="mlb-kernel-badge "+(ready?"connected":"offline");
      badge.innerHTML=ready
        ?"<i></i><span>Kernel Connected</span>"
        :"<i></i><span>Kernel Offline</span>";
      badge.title=ready
        ?"Run can execute this data pipeline in the Python kernel."
        :"Builder cannot currently reach the Python widget bridge.";
      if(ready) pumpComponentImportQueue();
    }

    function bridgeStatePayload(){
      const clean=cp(state);
      delete clean._runtime_command;
      delete clean._session_secrets;
      // API/ngrok secrets are browser-session values, never project state.
      (clean.model_outputs||[]).forEach(entry=>{
        if(entry.serve_live&&typeof entry.serve_live==="object"){
          delete entry.serve_live.api_key;
        }
      });
      return clean;
    }

    function setBridgeState(){
      if(!bridge)return false;
      if(isPopout){pendingBroadcastState=bridgeStatePayload();return true;}
      const input=bridgeControl(bridge.state,"textarea");
      if(!input)return false;
      return setNativeValue(input,JSON.stringify(bridgeStatePayload()));
    }

    function setBridgeCommand(command){
      if(!bridge)return false;
      if(isPopout){pendingBroadcastCommand=cp(command||{});return true;}
      if(!bridge.command){
        // Backward compatibility with an older Python bridge.
        state._runtime_command=cp(command||{});
        const ok=setBridgeState();
        delete state._runtime_command;
        return ok;
      }
      const input=bridgeControl(bridge.command,"textarea");
      if(!input)return false;
      return setNativeValue(input,JSON.stringify(command||{}));
    }

    function markExecutionLocally(kind,message){
      const nodes={};
      (current(state).nodes||[]).forEach(n=>{
        nodes[n.id]={status:kind,message:message||kind};
      });
      execution={status:kind,overall:0,message:message||kind,nodes};
      applyExecutionProgress(execution);
    }

    function clientDataValidation(){
      if(state.active_workspace!=="data")return [];
      const comp=current(state);
      const nodes=comp.nodes||[];
      const edges=(comp.edges||[]).filter(e=>(e.kind||"main")==="main");
      const sources=new Set(["manual_dataset","hf_dataset","kaggle_dataset","url_dataset","local_dataset"]);
      const sourceNodes=nodes.filter(n=>sources.has(n.type));
      const outputs=nodes.filter(n=>n.type==="prepared_dataset");
      const outgoing={};nodes.forEach(n=>outgoing[n.id]=[]);
      edges.forEach(e=>{if(outgoing[e.source])outgoing[e.source].push(e.target);});
      const errors=[];

      if(sourceNodes.length!==1){
        errors.push({
          node_ids:sourceNodes.map(n=>n.id),
          message:"Use exactly one Data Source. Found "+sourceNodes.length+"."
        });
      }
      if(outputs.length!==1){
        errors.push({
          node_ids:outputs.map(n=>n.id),
          message:"Use exactly one Prepared Dataset output. Found "+outputs.length+"."
        });
      }else if((outgoing[outputs[0].id]||[]).length){
        errors.push({
          node_ids:[outputs[0].id],
          message:"Prepared Dataset must be the final step."
        });
      }
      nodes.filter(n=>n.type==="train_test_split").forEach(n=>{
        const total=splitTotal(n);
        if(!splitIsValid(n)){
          errors.push({
            node_ids:[n.id],
            message:"Train + Validation + Test must equal 100%. Current total: "+total+"%."
          });
        }
      });
      return errors;
    }

    function showClientErrors(errors){
      const nodeStates={};
      (current(state).nodes||[]).forEach(n=>nodeStates[n.id]={status:"queued",message:"Waiting"});
      errors.forEach(err=>(err.node_ids||[]).forEach(id=>{
        nodeStates[id]={status:"error",message:err.message};
      }));
      execution={
        status:"error",
        overall:0,
        message:errors[0]?.message||"Pipeline needs attention.",
        nodes:nodeStates
      };
      applyExecutionProgress(execution);
      setStatus(execution.message);
    }

    function requestServeCommand(action,entry){
      if(!entry)return;
      updateKernelBadge();
      if(!bridgeReady()){
        execution={status:"error",runtime_kind:"serve",overall:0,message:"Kernel bridge is offline. Re-run the Builder cell, then try again.",nodes:{}};
        applyExecutionProgress(execution);setStatus(execution.message);return;
      }
      const secret=serveSecrets[entry.id]||{api_key:"",ngrok_token:""};
      const command={action,model_id:entry.id,serve:{
        config:cp(entry.serve_config||{}),
        credentials:{api_key:secret.api_key||"",ngrok_token:secret.ngrok_token||""}
      },ts:Date.now()};
      if(!setBridgeState()||!setBridgeCommand(command)){setStatus("Could not send API server configuration to Python.");return;}
      const button=bridgeControl(bridge.run,"button");
      if(!button){setStatus("Python API server control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:"serve",phase:action,overall:0,message:
        action==="serve_start"?"Starting model API server…":action==="serve_stop"?"Stopping model API server…":"Checking model API server…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{clickBridgeButton(button);},250);
    }

    function queueComponentImport(componentType){
      const type=String(componentType||"").trim();
      const api=mlapi[type];
      if(!type||!api||api.builder_utility||!api.import_path||api.loaded)return;
      if(componentImportQueue.includes(type))return;
      componentImportQueue.push(type);
      pumpComponentImportQueue();
    }

    function pumpComponentImportQueue(){
      if(componentImportBusy||!componentImportQueue.length||!bridgeReady())return;
      const type=componentImportQueue.shift();
      const api=mlapi[type];
      if(!api||api.loaded){pumpComponentImportQueue();return;}
      const command={action:"ensure_component_import",component_type:type,ts:Date.now()};
      if(!setBridgeState()||!setBridgeCommand(command)){
        componentImportQueue.unshift(type);
        return;
      }
      const button=bridgeControl(bridge.run,"button");
      if(!button){componentImportQueue.unshift(type);return;}
      componentImportBusy=true;
      setTimeout(()=>{
        const ok=clickBridgeButton(button);
        if(!ok){
          componentImportBusy=false;
          componentImportQueue.unshift(type);
        }
      },40);
    }

    function requestRuntimeCommand(action,entry){
      if(!entry)return;
      updateKernelBadge();
      if(!bridgeReady()){
        execution={status:"error",runtime_kind:action,overall:0,message:"Kernel bridge is offline. Re-run the Builder cell, then try again.",nodes:{}};
        applyExecutionProgress(execution);setStatus(execution.message);return;
      }
      const command={action,model_id:entry.id,ts:Date.now()};
      if(!setBridgeState()||!setBridgeCommand(command)){
        setStatus("Could not send runtime configuration to Python.");return;
      }
      const button=bridgeControl(bridge.run,"button");
      if(!button){setStatus("Python runtime control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");
      lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:action,phase:"starting",overall:0,message:action==="train"?"Starting training in Python…":"Starting generation in Python…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{clickBridgeButton(button);},350);
    }

    function requestLocalCommand(action,config={}){
      updateKernelBadge();
      if(!bridgeReady()){
        execution={status:"error",runtime_kind:"local",overall:0,message:"Kernel bridge is offline. Re-run the Builder cell, then try again.",nodes:{}};
        applyExecutionProgress(execution);setStatus(execution.message);return;
      }
      const command={action,local:cp(config),ts:Date.now()};
      if(!setBridgeState()||!setBridgeCommand(command)){setStatus("Could not send local filesystem command to Python.");return;}
      const button=bridgeControl(bridge.run,"button");
      if(!button){setStatus("Python local filesystem control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");
      lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:"local",phase:action,overall:0,message:
        action==="local_import_models"?"Scanning and importing models…":
        action==="local_import_data"?"Scanning and importing datasets…":
        action==="local_scan"?"Scanning local environment…":"Loading local content…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{clickBridgeButton(button);},250);
    }

    function requestCloudCommand(action,config={}){
      updateKernelBadge();
      if(!bridgeReady()){
        execution={status:"error",runtime_kind:"cloud",overall:0,message:"Kernel bridge is offline. Re-run the Builder cell, then try again.",nodes:{}};
        applyExecutionProgress(execution);setStatus(execution.message);return;
      }
      const command={action,cloud:cp(config),ts:Date.now()};
      if(!setBridgeState()||!setBridgeCommand(command)){
        setStatus("Could not send cloud command to Python.");return;
      }
      const button=bridgeControl(bridge.run,"button");
      if(!button){setStatus("Python cloud control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");
      lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:"cloud",phase:action,overall:0,message:"Connecting to cloud provider…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{clickBridgeButton(button);},250);
    }

    function requestHubCommand(action,config={}){
      updateKernelBadge();
      if(!bridgeReady()){
        execution={status:"error",runtime_kind:"hub",overall:0,message:"Kernel bridge is offline. Re-run the Builder cell, then try again.",nodes:{}};
        applyExecutionProgress(execution);setStatus(execution.message);return;
      }
      const command={action,hub:cp(config),ts:Date.now()};
      if(!setBridgeState()||!setBridgeCommand(command)){
        setStatus("Could not send Hugging Face command to Python.");return;
      }
      const button=bridgeControl(bridge.run,"button");
      if(!button){setStatus("Python Hub control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");
      lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:"hub",phase:action,overall:0,message:"Connecting to Hugging Face Hub…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{clickBridgeButton(button);},300);
    }

    function requestRun(){
      if(state.active_workspace!=="data"){
        setStatus("Model execution is not compiled yet. Run is currently available for Data Processing.");
        draw();
        return;
      }

      const errors=clientDataValidation();
      if(errors.length){
        showClientErrors(errors);
        return;
      }

      updateKernelBadge();
      if(!bridgeReady()){
        execution={
          status:"error",
          overall:0,
          message:"Kernel bridge is offline. Re-run the Builder cell, then click Run.",
          nodes:{}
        };
        applyExecutionProgress(execution);
        setStatus(execution.message);
        return;
      }

      if(!setBridgeState()){
        execution={
          status:"error",overall:0,
          message:"Could not send the current design to Python.",
          nodes:{}
        };
        applyExecutionProgress(execution);
        setStatus(execution.message);
        return;
      }

      const runButton=bridgeControl(bridge.run,"button");
      if(!runButton){
        setStatus("Python Run control was not found. Re-run the Builder cell.");
        return;
      }

      // Ignore the bridge's old idle payload. The next changed payload must
      // come from Python after this click.
      const progressInput=bridgeControl(bridge.progress,"textarea");
      lastProgressRaw=progressInput?.value||lastProgressRaw;

      const queued={};
      (current(state).nodes||[]).forEach(n=>{
        queued[n.id]={status:"queued",message:"Waiting"};
      });
      execution={
        status:"running",
        runtime_kind:"data",
        overall:0,
        message:"Fetching data with Python pipeline…",
        nodes:queued
      };
      applyExecutionProgress(execution);
      setStatus(execution.message);

      if(bridgeAwaitTimer)clearTimeout(bridgeAwaitTimer);

      // Let the standard textarea comm flush first, then activate the standard
      // ipywidgets button in whichever notebook document contains it.
      setTimeout(()=>{
        const ok=clickBridgeButton(runButton);
        if(!ok){
          execution={
            status:"error",runtime_kind:"data",overall:0,
            message:"Could not activate the Python data control.",
            nodes:queued
          };
          applyExecutionProgress(execution);
          return;
        }

        bridgeAwaitTimer=setTimeout(()=>{
          if(
            execution.status==="running" &&
            (execution.message==="Starting Python pipeline…" ||
             execution.message==="Sending pipeline to Python…")
          ){
            execution={
              status:"error",
              overall:0,
              message:"Python kernel did not acknowledge Run. Re-run the Builder cell and confirm Kernel Connected.",
              nodes:queued
            };
            applyExecutionProgress(execution);
            setStatus(execution.message);
            updateKernelBadge();
          }
        },3000);
      },350);
    }

    function requestStop(){
      if(execution.status!=="running"){
        setStatus("Nothing is running.");
        return;
      }
      if(isPopout){
        if(popoutHostConnected&&sendPopoutMessage({type:"stop",source:"popout",ts:Date.now()}))setStatus("Stop requested in notebook kernel.");
        else setStatus("Notebook bridge is disconnected.");
        return;
      }
      if(!bridge){
        setStatus("Stop bridge unavailable.");
        return;
      }
      const stopButton=bridgeControl(bridge.stop,"button");
      if(stopButton && clickBridgeButton(stopButton)){
        setStatus("Stop requested. The active step will finish, then the pipeline will stop.");
      }else{
        setStatus("Python Stop control is unavailable.");
      }
    }

    function runLabel(s){
      return s==="running"?"RUNNING":s==="done"?"DONE":s==="error"?"ERROR":
             s==="stopped"?"STOPPED":s==="queued"?"QUEUED":"";
    }

    function applyExecutionProgress(next){
      if(!next||typeof next!=="object")return;
      if(next.runtime_kind==="import"){
        if(!isPopout)sendPopoutMessage({type:"progress",source:"host",payload:cp(next),ts:Date.now()});
        const type=String(next.component_type||next.component_import?.component_type||"");
        if(type&&next.component_api){
          mlapi[type]=cp(next.component_api);
          const item=catalog.find(entry=>entry.type===type);
          if(item){
            item.real_api=cp(next.component_api);
            item.api=cp(next.component_api.parameters||item.api||[]);
            if(next.component_api.description)item.description=next.component_api.description;
          }
        }
        componentImportBusy=false;
        if(next.status==="error"&&next.message)setStatus(next.message);
        else if(next.status==="done"&&type)setStatus((catalog.find(x=>x.type===type)?.name||type)+" API ready.");
        setTimeout(pumpComponentImportQueue,80);
        if(next.status==="done")setTimeout(draw,20);
        return;
      }
      if(next.runtime_kind==="external_import"){
        const did=String(next.definition_id||"");
        if(did)customImportStatus[did]={status:next.status,message:next.message||"Custom API import checked."};
        setStatus(next.message||"Custom API import checked.");
        setTimeout(draw,20);return;
      }
      execution=next;
      if(!isPopout)sendPopoutMessage({type:"progress",source:"host",payload:cp(next),state:next.state_replace?cp(state):null,ts:Date.now()});

      if(next.model_id && next.model_update){
        const entry=builtModelById(next.model_id);
        if(entry)Object.assign(entry,next.model_update);
      }
      if(next.runtime_kind==="train"||next.runtime_kind==="generate"){
        recordRuntimeEvent(next);
        updateRuntimeLive(next);
        if(runtimePanel?.tab==="status"&&runtimePanel?.mode===next.runtime_kind)scheduleRuntimeStatusDraw();
        if(next.status==="done"||next.status==="error"||next.status==="stopped"){
          if(next.message)setStatus(next.message);
          setTimeout(draw,80);
        }
      }

      if(next.runtime_kind==="hub"){
        if(next.state_replace){
          state=cp(next.state_replace);
          delete state._runtime_command;
          ensureWorkspaces();
          selected=null;pendingPort=null;outputDirectorySelection=null;
        }
        if(next.message)setStatus(next.message);
        if(next.status==="done"||next.status==="error")setTimeout(draw,80);
      }

      if(next.runtime_kind==="cloud"){
        if(next.cloud_status){cloudStatus[next.cloud_status.provider]=cp(next.cloud_status);}
        if(next.state_replace){
          state=cp(next.state_replace);delete state._runtime_command;delete state._session_secrets;ensureWorkspaces();
          selected=null;pendingPort=null;outputDirectorySelection=null;
        }
        if(next.message)setStatus(next.message);
        if(next.status==="done"||next.status==="error")setTimeout(draw,80);
      }

      if(next.runtime_kind==="local"){
        if(next.local_scan)localFiles=cp(next.local_scan);
        if(next.local_import){
          const type=next.local_import_type||"model";
          localImportReports[type]=cp(next.local_import);
        }
        if(next.state_replace){
          state=cp(next.state_replace);delete state._runtime_command;ensureWorkspaces();
          selected=null;pendingPort=null;
          if(next.local_import){
            const type=next.local_import_type||"model";
            state.active_workspace=type==="data"?"data":"model";
            bottomView="outputs";
            bottomExpanded=true;
            const imported=next.local_import.imported||[];
            outputDirectorySelection=imported.length?imported[imported.length-1].id:null;
          }else{
            outputDirectorySelection=null;
          }
        }
        if(next.message)setStatus(next.message);
        if(next.status==="done"||next.status==="error")setTimeout(draw,80);
      }

      if(next.runtime_kind==="serve"){
        const entry=builtModelById(next.model_id||runtimePanel?.modelId);
        if(entry&&next.serve_info){
          const liveInfo=cp(next.serve_info);
          const returnedApiKey=liveInfo.api_key||"";
          delete liveInfo.api_key;
          entry.serve_live=liveInfo;
          entry.serve_tunnel_error=liveInfo.public_tunnel_error||null;
          if(returnedApiKey){
            serveSecrets[entry.id]=serveSecrets[entry.id]||{};
            serveSecrets[entry.id].api_key=returnedApiKey;
          }
        }
        if(entry&&next.status==="error"){
          entry.serve_status="error";
          entry.serve_live={
            ...(entry.serve_live||{}),
            running:false,
            error:next.message||"API server failed to start."
          };
        }
        if(next.message)setStatus(next.message);
        if(runtimePanel?.mode==="serve")setTimeout(draw,80);
      }

      if(next.prepared_dataset){
        const changed=upsertPreparedDataset(next.prepared_dataset);
        if(changed){
          if(next.prepared_dataset.output_node_id)selected=next.prepared_dataset.output_node_id;
          setStatus("Data ready: "+next.prepared_dataset.name+" · "+compactDatasetSummary(next.prepared_dataset));
          draw();
          return;
        }
      }

      root.querySelectorAll(".mlb-node").forEach(card=>{
        const nodeState=execution.nodes?.[card.dataset.nodeId];
        card.classList.remove("run-queued","run-running","run-done","run-error","run-stopped");
        const old=card.querySelector(".mlb-run-badge");if(old)old.remove();
        const oldTrack=card.querySelector(".mlb-run-track");if(oldTrack)oldTrack.remove();
        if(!nodeState)return;

        card.classList.add("run-"+nodeState.status);
        const badge=document.createElement("div");badge.className="mlb-run-badge";
        badge.textContent=runLabel(nodeState.status);
        badge.title=nodeState.message||"";
        card.appendChild(badge);

        if(nodeState.status==="running"){
          const track=document.createElement("div");track.className="mlb-run-track";
          track.innerHTML="<i></i>";card.appendChild(track);
        }
      });

      const live=root.querySelector(".mlb-run-live");
      if(live){
        live.className="mlb-run-live "+(execution.status||"idle");
        live.innerHTML="<strong>"+Math.max(0,Math.min(100,Number(execution.overall||0)))+"%</strong><span>"+(execution.message||"Ready")+"</span>";
      }

      const selectedLive=root.querySelector(".mlb-ins-run-live");
      const selectedState=selected ? execution.nodes?.[selected] : null;
      if(selectedLive){
        if(selectedState){
          selectedLive.style.display="block";
          selectedLive.className="mlb-ins-run-live "+selectedState.status;
          selectedLive.innerHTML="<strong>"+runLabel(selectedState.status)+"</strong><span>"+(selectedState.message||"")+"</span>";
        }else{
          selectedLive.style.display="none";
        }
      }

      const stat=root.querySelector(".mlb-statusbar .right");
      if(stat)stat.textContent="● "+(execution.message||status);

      const run=root.querySelector(".mlb-run");
      if(run){
        const runtimeBusy=state.active_workspace==="model" && execution.status==="running" &&
          (execution.runtime_kind==="train"||execution.runtime_kind==="generate");
        run.classList.toggle("runtime-busy",runtimeBusy);
        run.classList.toggle("train",runtimeBusy&&execution.runtime_kind==="train");
        run.classList.toggle("generate",runtimeBusy&&execution.runtime_kind==="generate");
        run.disabled=execution.status==="running";
        if(state.active_workspace==="model"){
          const label=runtimeBusy
            ?(execution.runtime_kind==="train"?"Training":"Generating")
            :(execution.status==="running"?"Building":"Build");
          setActionButtonContent(run,runtimeBusy?"activity":"build",label);
        }else{
          const dataBusy=execution.status==="running"&&execution.runtime_kind==="data";
          setActionButtonContent(run,dataBusy?"activity":"fetch",dataBusy?"Fetching":"Fetch Data");
          run.disabled=dataBusy;
        }
      }
      const centerStop=root.querySelector(".mlb-center-stop");
      if(centerStop){
        const dataBusy=state.active_workspace==="data"&&execution.status==="running"&&execution.runtime_kind==="data";
        const modelBusy=state.active_workspace==="model"&&execution.status==="running"&&
          (execution.runtime_kind==="train"||execution.runtime_kind==="generate");
        centerStop.style.display=(dataBusy||modelBusy)?"inline-flex":"none";
      }
    }

    function updateRuntimeLive(next){
      const box=root.querySelector(".mlb-runtime-live");
      if(!box)return;
      box.className="mlb-runtime-live "+(next.status||"idle");
      const pct=Math.max(0,Math.min(100,Number(next.overall||0)));
      let html="<div class='mlb-runtime-live-head'><strong>"+(next.runtime_kind==="train"?"LIVE TRAINING":"LIVE GENERATION")+"</strong><span>"+pct+"%</span></div>";
      html+="<div class='mlb-runtime-live-message'>"+(next.message||"Working…")+"</div>";
      if(next.runtime_kind==="train"){
        const memNow=next.memory_allocated_gb==null?"—":Number(next.memory_allocated_gb).toFixed(2)+" GB";
        html+="<div class='mlb-runtime-live-stats'>"+
          "<div><span>Step</span><strong>"+(next.step??"—")+(next.max_steps?" / "+next.max_steps:"")+"</strong></div>"+
          "<div><span>GPU Tok/s</span><strong>"+(next.tokens_per_sec==null?"—":Math.round(Number(next.tokens_per_sec)).toLocaleString())+"</strong></div>"+
          "<div><span>E2E Tok/s</span><strong>"+(next.end_to_end_tokens_per_sec==null?"—":Math.round(Number(next.end_to_end_tokens_per_sec)).toLocaleString())+"</strong></div>"+
          "<div><span>Loss</span><strong>"+(next.loss==null?"—":Number(next.loss).toFixed(4))+"</strong></div>"+
          "<div><span>PPL</span><strong>"+(next.ppl==null?"—":Number(next.ppl).toFixed(2))+"</strong></div>"+
          "<div><span>Val Loss</span><strong>"+(next.val_loss==null?"—":Number(next.val_loss).toFixed(4))+"</strong></div>"+
          "<div><span>Val PPL</span><strong>"+(next.val_ppl==null?"—":Number(next.val_ppl).toFixed(2))+"</strong></div>"+
          "<div><span>Memory</span><strong>"+memNow+"</strong></div>"+
          "<div><span>Tokens</span><strong>"+Number(next.tokens_seen||0).toLocaleString()+"</strong></div>"+
          "</div>";
        if(next.sample_text)html+="<div class='mlb-runtime-sample'><span>Validation sample</span><pre>"+String(next.sample_text).replace(/&/g,"&amp;").replace(/</g,"&lt;")+"</pre></div>";
      }else if(next.generated_text){
        html+="<div class='mlb-runtime-sample'><span>Generated text</span><pre>"+String(next.generated_text).replace(/&/g,"&amp;").replace(/</g,"&lt;")+"</pre></div>";
      }
      html+="<div class='mlb-runtime-progress'><i style='width:"+pct+"%'></i></div>";
      box.innerHTML=html;
      const start=root.querySelector(".mlb-runtime-start");if(start)start.disabled=next.status==="running";
      const stop=root.querySelector(".mlb-runtime-stop");if(stop)stop.disabled=next.status!=="running";
    }

    function pollBridgeProgress(){
      updateKernelBadge();
      if(!bridge)return;
      const input=bridgeControl(bridge.progress,"textarea");
      if(!input)return;
      const raw=input.value||"";
      if(!raw || raw===lastProgressRaw)return;
      lastProgressRaw=raw;
      if(bridgeAwaitTimer){clearTimeout(bridgeAwaitTimer);bridgeAwaitTimer=null;}
      try{
        const parsed=JSON.parse(raw);
        applyExecutionProgress(parsed);
        if(parsed.message)setStatus(parsed.message);
      }catch(_){}
    }

    function startBridgePolling(){
      updateKernelBadge();
      if(bridgePollTimer)return;
      bridgePollTimer=setInterval(()=>{
        pollBridgeProgress();
        updateKernelBadge();
      },250);
    }

    function handlePopoutMessage(raw,sourceWindow=null){
      const msg=raw||{};
      if(msg.__mlbricks_builder_popout__!==true || msg.channel!==popoutChannelName)return;

      if(isPopout){
        if(msg.source!=="host")return;
        try{
          if(sourceWindow && window.opener && sourceWindow!==window.opener)return;
        }catch(_){}
        if(msg.type==="hello_ack"){
          popoutHostConnected=true;
          if(popoutHelloTimer){clearInterval(popoutHelloTimer);popoutHelloTimer=null;}
          if(msg.state?.components){state=cp(msg.state);ensureWorkspaces();selected=null;pendingPort=null;draw();}
          updateKernelBadge();
          setStatus("Full Window connected to notebook kernel.");
          return;
        }
        if(msg.type==="progress"){
          if(msg.state?.components){state=cp(msg.state);ensureWorkspaces();}
          applyExecutionProgress(cp(msg.payload||{}));
          if(msg.payload?.message)setStatus(msg.payload.message);
          draw();
        }
        return;
      }

      if(msg.source!=="popout")return;
      if(sourceWindow)popoutPeerWindow=sourceWindow;
      if(msg.type==="hello"){
        popoutPeerConnected=true;
        sendHostReply(sourceWindow,{type:"hello_ack",state:cp(state),ts:Date.now()});
        return;
      }
      if(msg.type==="state_sync"&&msg.state?.components){
        state=cp(msg.state);ensureWorkspaces();selected=null;pendingPort=null;draw();return;
      }
      if(msg.type==="stop"){
        const stopButton=bridgeControl(bridge?.stop,"button");
        if(stopButton)clickBridgeButton(stopButton);
        return;
      }
      if(msg.type==="command"){
        if(msg.state?.components){state=cp(msg.state);ensureWorkspaces();}
        if(!bridgeReady()){
          sendHostReply(sourceWindow,{type:"progress",payload:{status:"error",overall:0,message:"Notebook Python bridge is offline."},ts:Date.now()});
          return;
        }
        const okState=setBridgeState();
        const okCommand=setBridgeCommand(msg.command||{action:"data"});
        const runButton=bridgeControl(bridge.run,"button");
        if(okState&&okCommand&&runButton)clickBridgeButton(runButton);
        else sendHostReply(sourceWindow,{type:"progress",payload:{status:"error",overall:0,message:"Could not forward Full Window command to Python."},ts:Date.now()});
      }
    }

    function setupPopoutBridge(){
      window.addEventListener("message",event=>{
        try{
          const msg=event.data||{};
          if(
            isPopout &&
            msg.__mlbricks_builder_popout__===true &&
            msg.channel===popoutChannelName &&
            msg.type==="port_offer" &&
            event.ports && event.ports[0]
          ){
            attachPopoutMessagePort(event.ports[0]);
            if(msg.state?.components){state=cp(msg.state);ensureWorkspaces();selected=null;pendingPort=null;}
            popoutHostConnected=true;
            if(popoutHelloTimer){clearInterval(popoutHelloTimer);popoutHelloTimer=null;}
            sendPopoutMessage({type:"hello",source:"popout",ts:Date.now()});
            updateKernelBadge();
            setStatus("Full Window connected to notebook kernel.");
            draw();
            return;
          }
          handlePopoutMessage(msg,event.source||null);
        }catch(_){}
      });

      if(typeof BroadcastChannel!=="undefined"){
        try{
          popoutChannel=new BroadcastChannel(popoutChannelName);
          popoutChannel.onmessage=event=>{
            try{handlePopoutMessage(event.data||{},null);}catch(_){}
          };
        }catch(_){popoutChannel=null;}
      }

      if(isPopout){
        const hello=()=>{
          if(popoutHostConnected)return;
          sendPopoutMessage({type:"hello",source:"popout",ts:Date.now()});
          updateKernelBadge();
        };
        hello();
        let attempts=0;
        popoutHelloTimer=setInterval(()=>{
          attempts+=1;
          hello();
          if(popoutHostConnected||attempts>=12){clearInterval(popoutHelloTimer);popoutHelloTimer=null;}
        },500);
      }
    }

    function schedulePopoutStateSync(){
      if(!isPopout)return;
      if(popoutSyncTimer)clearTimeout(popoutSyncTimer);
      popoutSyncTimer=setTimeout(()=>{
        sendPopoutMessage({type:"state_sync",source:"popout",state:bridgeStatePayload(),ts:Date.now()});
      },180);
    }

    function fullWindowPage(){
      const assets=payload.popout_assets||{};
      if(!assets.css||!assets.js)return null;
      const popPayload=cp(payload);
      delete popPayload.popout_assets;
      popPayload.state=bridgeStatePayload();
      // Use distinct placeholder bridge ids in the popout so Run and Stop remain
      // distinguishable while commands are proxied back to the notebook host.
      popPayload.bridge={
        mode:"popout",
        channel:popoutChannelName,
        state:"__popout_state__",
        command:"__popout_command__",
        run:"__popout_run__",
        stop:"__popout_stop__",
        progress:"__popout_progress__"
      };
      popPayload.instance_id=(payload.instance_id||root.id||"mlbricks")+"-full";
      const targetId="mlbricks-full-"+Date.now();
      const safePayload=JSON.stringify(popPayload).replace(/</g,"\\u003c");
      const cssText=String(assets.css).split("</style").join("<\\/style");
      const jsText=String(assets.js).split("</script").join("<\\/script");
      // Build the closing script tag by concatenation so builder.js itself never
      // contains a raw script end tag while generated HTML receives a real one.
      const closeScript="</"+"script>";
      return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MLBricks : AIBuilder</title><style>'+cssText+'</style><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1118}body{padding:0}.mlb-root{width:100vw!important;height:100vh!important;min-height:0!important;max-height:none!important;min-width:0!important;border-radius:0!important;border:0!important;box-shadow:none!important}</style></head><body><div id="'+targetId+'" class="mlb-root" data-mlbricks-builder-version="0.7.44"></div><script>'+jsText+closeScript+'<script>window.MLBricksBuilder.mount(document.getElementById('+JSON.stringify(targetId)+'),'+safePayload+');'+closeScript+'</body></html>';
    }

    function openFullWindow(){
      const page=fullWindowPage();
      if(!page){
        setStatus("Full Window assets are unavailable. Re-run the Builder cell.");
        return false;
      }

      const targetName="mlbricks_builder_full_"+String(popoutChannelName).replace(/[^a-zA-Z0-9_-]/g,"_");
      const launcherUrl="https://builder.mlbricks.io/";
      let popup=null;
      let bootstrapSent=false;
      let launcherProbe=null;
      let launcherUpgraded=false;

      // Open the known-working Builder immediately. Do not briefly navigate to
      // builder.mlbricks.io and then bounce back to about:blank when the hosted
      // launcher has not been deployed yet.
      try{popup=window.open("about:blank",targetName);}catch(_){popup=null;}
      if(!popup){
        setStatus("Could not open the Builder tab. Allow pop-ups for this notebook, then try again.");
        return false;
      }
      try{
        popup.document.open();popup.document.write(page);popup.document.close();
        popup.document.title="MLBricks : AIBuilder";
        bootstrapSent=true;
      }catch(_){ }

      popoutPeerWindow=popup;
      popoutPeerConnected=false;

      const offerPort=()=>{
        if(popoutPeerConnected || !bootstrapSent || !popup || popup.closed || typeof MessageChannel==="undefined")return;
        try{
          const channel=new MessageChannel();
          attachPopoutMessagePort(channel.port1);
          popup.postMessage(
            popoutPacket({type:"port_offer",source:"host",state:cp(state),ts:Date.now()}),
            "*",
            [channel.port2]
          );
        }catch(_){ }
      };

      // Probe the real launcher in a hidden frame. Only if that exact page
      // announces itself do we upgrade the already-working popout to the real
      // builder.mlbricks.io URL. This removes the visible URL -> about:blank bounce.
      const doc=root.ownerDocument||document;
      const probeToken="mlb_probe_"+Date.now()+"_"+Math.random().toString(36).slice(2);
      const cleanupProbe=()=>{
        try{window.removeEventListener("message",onProbeMessage);}catch(_){ }
        try{launcherProbe?.remove();}catch(_){ }
        launcherProbe=null;
      };
      const onProbeMessage=event=>{
        const msg=event.data||{};
        if(msg.__mlbricks_builder_launcher__!==true||msg.type!=="ready"||msg.probe_token!==probeToken)return;
        if(event.origin!=="https://builder.mlbricks.io")return;
        cleanupProbe();
        if(!popup||popup.closed)return;
        launcherUpgraded=true;
        bootstrapSent=false;
        const onReady=readyEvent=>{
          const readyMsg=readyEvent.data||{};
          if(readyEvent.source!==popup||readyMsg.__mlbricks_builder_launcher__!==true||readyMsg.type!=="ready")return;
          if(readyEvent.origin!=="https://builder.mlbricks.io")return;
          window.removeEventListener("message",onReady);
          try{
            popup.postMessage({__mlbricks_builder_launcher__:true,type:"bootstrap",html:page,title:"MLBricks : AIBuilder"},"https://builder.mlbricks.io");
            bootstrapSent=true;
            setStatus("MLBricks AIBuilder opened at builder.mlbricks.io. Keep this notebook tab open for Python execution.");
            [150,450,900,1600].forEach(ms=>setTimeout(offerPort,ms));
          }catch(_){ }
        };
        window.addEventListener("message",onReady);
        try{popup.location.href=launcherUrl;}catch(_){window.removeEventListener("message",onReady);launcherUpgraded=false;bootstrapSent=true;}
      };
      window.addEventListener("message",onProbeMessage);
      try{
        launcherProbe=doc.createElement("iframe");
        launcherProbe.setAttribute("aria-hidden","true");
        launcherProbe.style.cssText="position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;border:0;opacity:0;pointer-events:none";
        launcherProbe.src=launcherUrl+"?mlb_probe="+encodeURIComponent(probeToken);
        (doc.body||doc.documentElement).appendChild(launcherProbe);
        setTimeout(cleanupProbe,2200);
      }catch(_){cleanupProbe();}

      [120,350,700,1200,2200,3400].forEach(ms=>setTimeout(()=>{if(!launcherUpgraded)offerPort();},ms));
      setTimeout(()=>sendHostReply(popup,{type:"hello_ack",state:cp(state),ts:Date.now()}),500);
      setStatus("MLBricks AIBuilder opened. Keep this notebook tab open for Python execution.");
      return true;
    }

    function activateFullWindowLink(event){
      event.preventDefault();
      openFullWindow();
    }

    function btn(text,cls){const b=document.createElement("button");b.type="button";b.className=cls||"";b.textContent=text;return b;}

    function uiIcon(name){
      const common='viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
      const paths={
        build:'<svg '+common+'><rect x="3.5" y="5" width="7.5" height="5" rx="1"/><rect x="13" y="5" width="7.5" height="5" rx="1"/><rect x="6.5" y="14" width="7.5" height="5" rx="1"/><path d="M16 14h4.5v5H16"/></svg>',
        gallery:'<svg '+common+'><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
        fetch:'<svg '+common+'><ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.65 3.36 3 7.5 3 1.15 0 2.24-.1 3.2-.3"/><path d="M4.5 11.5v6c0 1.65 3.36 3 7.5 3 1.18 0 2.3-.11 3.28-.32"/><path d="M18 13v7"/><path d="m15.2 17.3 2.8 2.8 2.8-2.8"/></svg>',
        stop:'<svg '+common+'><rect x="6.5" y="6.5" width="11" height="11" rx="1.8"/></svg>',
        cloud:'<svg '+common+'><path d="M7.3 18.5h10.6a4.1 4.1 0 0 0 .4-8.18A6.4 6.4 0 0 0 6.1 8.9a4.8 4.8 0 0 0 1.2 9.6Z"/><path d="M12 10.5v5"/><path d="m9.7 13.2 2.3 2.3 2.3-2.3"/></svg>',
        activity:'<svg '+common+'><path d="M3.5 12h4l2-5 4 10 2-5h5"/></svg>'
      };
      return paths[name]||paths.build;
    }

    function setActionButtonContent(button,icon,label){
      if(!button)return;
      button.innerHTML='<span class="mlb-action-icon">'+uiIcon(icon)+'</span><span class="mlb-action-label"></span>';
      const text=button.querySelector('.mlb-action-label');if(text)text.textContent=label;
      button.setAttribute('aria-label',label);
    }

    function actionBtn(label,cls,icon){
      const b=btn('',cls);setActionButtonContent(b,icon,label);return b;
    }
    function portLabel(side,index){
      const lane=["Skip","Main","Extra"][index] || ("Lane "+(index+1));
      return lane+" "+(side==="in"?"In":"Out");
    }

    function selectedNode(){return current(state).nodes.find(n=>n.id===selected)||null;}
    function setStatus(s){status=s;}

    function apiInfo(node){
      if(node.type==="custom") return {public_name:"Custom Layer",parameters:[],available:true};
      const item=cat(catalog,node.type);
      if(item.builder_utility){
        return {
          available:true,
          runtime_available:null,
          builder_utility:true,
          builder_python_api:!!item.builder_python_api,
          public_name:item.name,
          parameters:item.api||[],
          description:item.description||"",
          source:"MLBricks Builder"
        };
      }
      return mlapi[node.type] || item.real_api || {};
    }

    function availablePreparedDatasets(){
      return Array.isArray(state.prepared_datasets) ? state.prepared_datasets : [];
    }

    function preparedDatasetById(id){
      return availablePreparedDatasets().find(d=>d.id===id)||null;
    }

    function latestPreparedDataset(){
      const all=availablePreparedDatasets();
      return all.length ? all[all.length-1] : null;
    }

    function splitRows(meta,name){
      const rows=meta?.splits?.[name]?.rows;
      return rows===null||rows===undefined ? "?" : Number(rows).toLocaleString();
    }

    function datasetSplitLabel(name,meta){
      const pretty=name==="validation"?"Validation":name.charAt(0).toUpperCase()+name.slice(1);
      return pretty+" — "+splitRows(meta,name)+" rows";
    }

    function compactDatasetSummary(meta){
      if(!meta)return "No prepared data";
      const parts=[];
      ["train","validation","test"].forEach(name=>{
        if(meta.splits?.[name]){
          const label=name==="validation"?"Val":name.charAt(0).toUpperCase()+name.slice(1);
          parts.push(label+" "+splitRows(meta,name));
        }
      });
      return parts.join(" · ") || ((meta.total_rows??"?")+" rows");
    }

    function configureTextInputForDataset(node,meta){
      if(!node||node.type!=="text_input"||!meta)return;
      node.params=node.params||{};
      node.params.input_mode="prepared_dataset";
      node.params.dataset_id=meta.id;
      node.params.dataset_split=meta.default_split || (meta.splits?.train?"train":Object.keys(meta.splits||{})[0]||"train");
    }

    function configureTextInputForLatest(node){
      const latest=latestPreparedDataset();
      if(latest)configureTextInputForDataset(node,latest);
      return node;
    }

    function autoBindDatasetToModel(meta){
      const modelRoot=state.workspaces?.model?.root_component_id;
      const model=state.components?.[modelRoot];
      if(!model)return;
      (model.nodes||[]).filter(n=>n.type==="text_input").forEach(n=>configureTextInputForDataset(n,meta));
      state.project=state.project||{};
      state.project.dataset=meta.name;
    }

    function upsertPreparedDataset(meta){
      if(!meta||!meta.id)return false;
      state.prepared_datasets=availablePreparedDatasets();
      const idx=state.prepared_datasets.findIndex(d=>d.id===meta.id);
      const raw=JSON.stringify(meta);
      if(idx>=0){
        if(JSON.stringify(state.prepared_datasets[idx])===raw)return false;
        state.prepared_datasets[idx]=cp(meta);
      }else{
        state.prepared_datasets.push(cp(meta));
      }
      autoBindDatasetToModel(meta);
      return true;
    }

    function datasetSummaryCard(meta,titleText){
      const card=document.createElement("div");card.className="mlb-dataset-result";
      const title=document.createElement("div");title.className="mlb-dataset-result-title";
      title.innerHTML="<strong>"+(titleText||"DATA READY")+"</strong><span>"+meta.name+"</span>";
      card.appendChild(title);
      const grid=document.createElement("div");grid.className="mlb-dataset-splits";
      const names=["train","validation","test"].filter(name=>meta.splits?.[name]);
      (names.length?names:Object.keys(meta.splits||{})).forEach(name=>{
        const item=document.createElement("div");
        item.innerHTML="<span>"+(name==="validation"?"Validation":name.charAt(0).toUpperCase()+name.slice(1))+"</span><strong>"+splitRows(meta,name)+"</strong>";
        grid.appendChild(item);
      });
      card.appendChild(grid);
      const foot=document.createElement("div");foot.className="mlb-dataset-result-foot";
      foot.textContent=meta.storage==="disk+memory"
        ?("Saved + in memory · "+(meta.path||""))
        :"Available in Python memory";
      card.appendChild(foot);
      return card;
    }

    function modelRootComponent(){
      const id=state.workspaces?.model?.root_component_id || state.root_component_id;
      return state.components?.[id] || null;
    }

    function selectedModelDataset(){
      const model=modelRootComponent();
      if(!model)return null;
      const textInput=(model.nodes||[]).find(n=>
        n.type==="text_input" &&
        String(n.params?.input_mode||"prompt")==="prepared_dataset"
      );
      return textInput ? preparedDatasetById(textInput.params?.dataset_id) : null;
    }

    function currentModelDirectoryEntry(){
      const model=modelRootComponent();
      if(!model)return null;
      const dataset=selectedModelDataset();
      return {
        id:"current_model_design",
        name:state.project?.name || model.name || "Current Model",
        kind:"design",
        status:"design",
        nodes:(model.nodes||[]).length,
        connections:(model.edges||[]).length,
        dataset:dataset?.name || state.project?.dataset || null,
        context_length:state.project?.context_length ?? null,
        batch_size:state.project?.batch_size ?? null,
      };
    }

    function modelDirectoryEntries(){
      return (state.model_outputs||[]).filter(item=>item.kind==="built_model"||item.kind==="trained_model"||item.kind==="model_artifact");
    }

    function numberOr(value,fallback){
      const n=Number(value);
      return Number.isFinite(n)&&n>0?n:fallback;
    }

    function precisionToDtype(value){
      const p=String(value||"fp16").toLowerCase();
      return p==="fp32"?"float32":p==="bf16"?"bfloat16":"float16";
    }

    function firstModelNode(type){
      const model=modelRootComponent();
      return (model?.nodes||[]).find(n=>n.type===type)||null;
    }

    function referencedCustomDefinitions(){
      const found=[];
      const seen=new Set();
      const visitNodes=(nodes)=>{
        (nodes||[]).forEach(node=>{
          if(node.type!=="custom"||!node.definition_id||seen.has(node.definition_id))return;
          seen.add(node.definition_id);
          const def=state.custom_components?.[node.definition_id];
          if(def){
            found.push(def);
            visitNodes(def.nodes||[]);
          }
        });
      };
      visitNodes(modelRootComponent()?.nodes||[]);
      return found;
    }

    function allModelSettingNodes(){
      const model=modelRootComponent();
      const nodes=[...(model?.nodes||[])];
      referencedCustomDefinitions().forEach(def=>nodes.push(...(def.nodes||[])));
      return nodes;
    }

    function parseJsonish(value,fallback){
      if(value&&typeof value==="object")return cp(value);
      const text=String(value??"").trim();
      if(!text)return cp(fallback);
      try{return JSON.parse(text);}catch(_){return cp(fallback);}
    }

    function soupHeadCount(node){
      if(!node)return null;
      const cfg=parseJsonish(node.params?.mixer_config,{});
      const first=Array.isArray(cfg)?(cfg[0]||{}):cfg;
      return numberOr(first?.head ?? first?.num_heads,null);
    }

    function soupMixerConfigWithHeads(value,heads,depth){
      const parsed=parseJsonish(value,{});
      const apply=obj=>{
        const next=(obj&&typeof obj==="object"&&!Array.isArray(obj))?{...obj}:{};
        next.head=heads;next.num_heads=heads;
        return next;
      };
      if(Array.isArray(parsed)){
        const count=Math.max(1,Number(depth)||parsed.length||1);
        const out=[];
        for(let i=0;i<count;i++)out.push(apply(parsed[i]||parsed[parsed.length-1]||{}));
        return JSON.stringify(out);
      }
      return JSON.stringify(apply(parsed));
    }

    function deriveModelSettings(entry){
      state.project=state.project||{};
      const stored=state.project.model_settings||{};
      const nodes=allModelSettingNodes();
      const embedding=nodes.find(n=>n.type==="embedding");
      const esa=nodes.find(n=>n.type==="esa");
      const soup=nodes.find(n=>n.type==="soup");
      const head=nodes.find(n=>n.type==="lm_head");

      const embeddingSize=numberOr(
        stored.embedding_size,
        numberOr(
          embedding?.params?.embedding_dim ?? embedding?.params?.hidden_size ?? embedding?.params?.dim,
          numberOr(esa?.params?.embd ?? esa?.params?.dim,numberOr(soup?.params?.dim,384))
        )
      );
      const heads=numberOr(
        stored.heads,
        numberOr(esa?.params?.head ?? esa?.params?.heads ?? esa?.params?.num_heads,numberOr(soupHeadCount(soup),6))
      );
      const block=numberOr(
        stored.block,
        numberOr(esa?.params?.block,numberOr(entry?.context_length ?? state.project.context_length,512))
      );
      const defaultBatch=numberOr(
        stored.default_batch,
        numberOr(esa?.params?.batch,numberOr(entry?.batch_size ?? state.project.batch_size,16))
      );
      const vocab=numberOr(
        stored.vocab_size,
        numberOr(embedding?.params?.vocab_size,numberOr(head?.params?.vocab_size,32000))
      );
      const precision=String(
        stored.precision ||
        esa?.params?.precision ||
        soup?.params?.precision ||
        (embedding?.params?.dtype==="float32"?"fp32":embedding?.params?.dtype==="bfloat16"?"bf16":"fp16")
      ).toLowerCase();

      const settings={
        embedding_size:embeddingSize,
        heads,
        block,
        default_batch:defaultBatch,
        vocab_size:vocab,
        precision:["fp32","fp16","bf16"].includes(precision)?precision:"fp16"
      };
      state.project.model_settings={...settings};
      return settings;
    }

    function syncModelSettingsToGraph(settings,oldSettings){
      state.project=state.project||{};
      state.project.context_length=settings.block;
      state.project.batch_size=settings.default_batch;
      state.project.model_settings={...settings};

      const dtype=precisionToDtype(settings.precision);
      allModelSettingNodes().forEach(node=>{
        node.params=node.params||{};
        const p=node.params;
        const t=node.type;

        if(t==="embedding"){
          p.embedding_dim=settings.embedding_size;
          p.hidden_size=settings.embedding_size;
          p.dim=settings.embedding_size;
          p.vocab_size=settings.vocab_size;
          p.dtype=dtype;
        }else if(t==="esa"){
          p.embd=settings.embedding_size;
          p.dim=settings.embedding_size;
          p.head=settings.heads;
          p.heads=settings.heads;
          p.batch=settings.default_batch;
          p.block=settings.block;
          p.precision=settings.precision;
          p.dtype=dtype;
        }else if(t==="soup"){
          p.dim=settings.embedding_size;
          p.precision=settings.precision;
          p.mixer_config=soupMixerConfigWithHeads(p.mixer_config,settings.heads,p.depth);
        }else if(t==="stateaware_esa_stack"){
          p.dim=settings.embedding_size;
          p.heads=settings.heads;
          p.batch=settings.default_batch;
          p.block=settings.block;
        }else if(t==="rmsnorm"||t==="layernorm"){
          p.normalized_shape=settings.embedding_size;
          p.hidden_size=settings.embedding_size;
          p.dim=settings.embedding_size;
        }else if(t==="ffn"||t==="saffn"){
          const priorDim=numberOr(oldSettings?.embedding_size,384);
          const priorIntermediate=numberOr(p.intermediate_size ?? p.ffn_dim,priorDim*4);
          const ratio=Math.max(1,priorIntermediate/priorDim);
          p.hidden_size=settings.embedding_size;
          p.dim=settings.embedding_size;
          p.intermediate_size=Math.round(settings.embedding_size*ratio);
          p.ffn_dim=Math.round(settings.embedding_size*ratio);
        }else if(t==="lm_head"){
          p.hidden_size=settings.embedding_size;
          p.dim=settings.embedding_size;
          p.vocab_size=settings.vocab_size;
        }else if(t==="classifier"){
          p.hidden_size=settings.embedding_size;
          p.dim=settings.embedding_size;
        }else if(["vesa","bolt","visualbolt"].includes(t)){
          p.dim=settings.embedding_size;
          if("d_model" in p)p.d_model=settings.embedding_size;
          if("heads" in p)p.heads=settings.heads;
          if("num_heads" in p)p.num_heads=settings.heads;
        }
      });
    }

    function updateBuiltModelSetting(entry,key,value){
      if(!entry)return;
      const oldSettings=deriveModelSettings(entry);
      const next={...oldSettings};
      if(key==="precision"){
        next[key]=String(value||"fp16");
      }else{
        const n=Number(value);
        if(!Number.isFinite(n)||n<=0){
          setStatus(key.replaceAll("_"," ")+" must be greater than 0.");
          draw();
          return;
        }
        next[key]=Math.round(n);
      }

      if(key==="embedding_size" && next.embedding_size%next.heads!==0){
        setStatus("Embedding Size must be divisible by Heads.");
        draw();
        return;
      }
      if(key==="heads" && next.embedding_size%next.heads!==0){
        setStatus("Heads must divide Embedding Size exactly.");
        draw();
        return;
      }

      checkpoint("Update Model Settings");
      syncModelSettingsToGraph(next,oldSettings);

      // Architecture-affecting model settings invalidate the previous build.
      entry.context_length=next.block;
      entry.batch_size=next.default_batch;
      entry.status="needs_rebuild";
      entry.weights_ready=false;
      entry.training_status="untrained";
      entry.requirements=inferModelRequirements(modelRootComponent());
      entry.requirements.context_length=next.block;
      entry.model_settings={...next};
      entry.architecture=cp(modelRootComponent());
      entry.fingerprint=modelFingerprint(modelRootComponent());

      // Keep training defaults aligned with the model-wide default batch.
      ensureRuntimeConfigs(entry);
      entry.training_config.batch_size=next.default_batch;
      if(entry.training_config.precision==="auto" || !entry.training_config.precision){
        entry.training_config.precision=next.precision;
      }
      if(entry.generation_config && (entry.generation_config.precision==="auto" || !entry.generation_config.precision)){
        entry.generation_config.precision=next.precision;
      }

      setStatus("Model setting updated. Rebuild required before training.");
      draw();
    }

    function modelSettingField(label,key,value,entry,options=null,help=""){
      const field=document.createElement("div");field.className="mlb-model-setting-field";
      const top=document.createElement("div");top.className="mlb-model-setting-label";
      const lab=document.createElement("label");lab.textContent=label;top.appendChild(lab);
      if(help){const hint=document.createElement("span");hint.textContent=help;top.appendChild(hint);}
      field.appendChild(top);

      let input;
      if(options){
        input=document.createElement("select");
        options.forEach(opt=>{
          const value=typeof opt==="object"?opt.value:opt;
          const text=typeof opt==="object"?opt.label:opt;
          const o=document.createElement("option");o.value=value;o.textContent=text;
          input.appendChild(o);
        });
        input.value=String(value);
      }else{
        input=document.createElement("input");input.type="number";input.min="1";input.step="1";input.value=String(value);
      }
      input.addEventListener("change",()=>updateBuiltModelSetting(entry,key,input.value));
      field.appendChild(input);
      return field;
    }

    function renderModelSettings(body,entry){
      const settings=deriveModelSettings(entry);
      const title=document.createElement("div");title.className="mlb-section-title";title.textContent="MODEL SETTINGS";
      body.appendChild(title);

      const box=document.createElement("div");box.className="mlb-model-settings";
      box.append(
        modelSettingField("Embedding Size","embedding_size",settings.embedding_size,entry,null,"hidden width"),
        modelSettingField("Heads","heads",settings.heads,entry,null,"attention / ESA"),
        modelSettingField("Block / Context","block",settings.block,entry,null,"sequence length"),
        modelSettingField("Default Batch","default_batch",settings.default_batch,entry,null,"training default"),
        modelSettingField("Vocabulary","vocab_size",settings.vocab_size,entry,null,"token count"),
        modelSettingField("Precision","precision",settings.precision,entry,[
          {value:"fp16",label:"FP16"},
          {value:"bf16",label:"BF16"},
          {value:"fp32",label:"FP32"}
        ],"model default")
      );
      body.appendChild(box);

      const note=document.createElement("div");note.className="mlb-model-settings-note";
      note.textContent="Block / Context, width, heads, vocabulary and precision change the architecture/runtime contract. Changing them marks this build as Rebuild Required. Default Batch can still be overridden per training run.";
      body.appendChild(note);
    }

    function builtModelById(id){
      return (state.model_outputs||[]).find(item=>item.id===id)||null;
    }

    function selectedOutputModel(){
      if(state.active_workspace!=="model" || bottomView!=="outputs" || !outputDirectorySelection)return null;
      return builtModelById(outputDirectorySelection);
    }

    function modelFingerprint(model){
      return JSON.stringify({
        nodes:(model?.nodes||[]).map(n=>({
          id:n.id,type:n.type,name:n.name,definition_id:n.definition_id||null,
          repeat:n.repeat||1,params:n.params||{}
        })),
        edges:(model?.edges||[]).map(e=>({
          source:e.source,target:e.target,kind:e.kind||"main",
          source_port:e.source_port||null,target_port:e.target_port||null
        }))
      });
    }

    function inferModelRequirements(model){
      const nodes=model?.nodes||[];
      const types=new Set(nodes.map(n=>n.type));
      let modality="unknown";
      if(types.has("text_input"))modality="text";
      else if(types.has("image_input"))modality="image";
      else if(types.has("audio_input"))modality="audio";

      const terminal=[...nodes].reverse().find(n=>
        ["text_output","logits_output","classifier","lm_head"].includes(n.type)
      );

      return {
        modality,
        output_type:terminal?.type||"unknown",
        requires_tokenizer:modality==="text" && (types.has("embedding")||types.has("lm_head")),
        context_length:Number(state.project?.context_length||0)||null,
        batch_size:Number(state.project?.batch_size||0)||null,
      };
    }

    function validateModelBuild(){
      const model=modelRootComponent();
      const errors=[];
      if(!model || !(model.nodes||[]).length){
        return [{node_ids:[],message:"Model canvas is empty. Add model components before Build."}];
      }

      const nodes=model.nodes||[];
      const byId=new Map(nodes.map(n=>[n.id,n]));
      const mainEdges=(model.edges||[]).filter(e=>(e.kind||"main")==="main");
      const inputTypes=new Set(["text_input","image_input","audio_input"]);
      const outputTypes=new Set(["text_output","logits_output","classifier","lm_head"]);

      const inputs=nodes.filter(n=>inputTypes.has(n.type));
      const outputs=nodes.filter(n=>outputTypes.has(n.type));
      if(!inputs.length)errors.push({node_ids:[],message:"Add at least one model Input before Build."});
      if(!outputs.length)errors.push({node_ids:[],message:"Add a model output/head before Build."});

      const degree=new Map(nodes.map(n=>[n.id,0]));
      mainEdges.forEach(e=>{
        if(byId.has(e.source)&&byId.has(e.target)){
          degree.set(e.source,(degree.get(e.source)||0)+1);
          degree.set(e.target,(degree.get(e.target)||0)+1);
        }
      });
      const disconnected=nodes.filter(n=>nodes.length>1 && (degree.get(n.id)||0)===0);
      if(disconnected.length){
        errors.push({
          node_ids:disconnected.map(n=>n.id),
          message:"Disconnected model components: "+disconnected.map(n=>n.name).join(", ")
        });
      }

      // Detect cycles on the Main lane, while allowing branches/parallel graphs.
      const incoming=new Map(nodes.map(n=>[n.id,0]));
      const outgoing=new Map(nodes.map(n=>[n.id,[]]));
      mainEdges.forEach(e=>{
        if(byId.has(e.source)&&byId.has(e.target)){
          incoming.set(e.target,(incoming.get(e.target)||0)+1);
          outgoing.get(e.source).push(e.target);
        }
      });
      const queue=nodes.filter(n=>(incoming.get(n.id)||0)===0).map(n=>n.id);
      let visited=0;
      while(queue.length){
        const id=queue.shift();visited++;
        (outgoing.get(id)||[]).forEach(next=>{
          incoming.set(next,incoming.get(next)-1);
          if(incoming.get(next)===0)queue.push(next);
        });
      }
      if(visited!==nodes.length){
        errors.push({node_ids:[],message:"Main model flow contains a cycle. Remove the cycle before Build."});
      }

      return errors;
    }

    function registerBuiltModel(){
      const model=modelRootComponent();
      const requirements=inferModelRequirements(model);
      const name=state.project?.name||model?.name||"Built Model";
      const fingerprint=modelFingerprint(model);
      let entry=(state.model_outputs||[]).find(item=>item.kind==="built_model" && item.name===name);

      const latestData=selectedModelDataset()||latestPreparedDataset();
      const snapshot={
        name,
        kind:"built_model",
        status:"built",
        built_at:new Date().toISOString(),
        revision:(entry?.revision||0)+1,
        nodes:(model?.nodes||[]).length,
        connections:(model?.edges||[]).length,
        context_length:state.project?.context_length??null,
        batch_size:state.project?.batch_size??null,
        estimated_parameters:state.project?.estimated_parameters??null,
        model_settings:{...deriveModelSettings(entry)},
        architecture:cp(model),
        custom_components_snapshot:cp(state.custom_components||{}),
        requirements,
        fingerprint,
        selected_dataset_id:entry?.selected_dataset_id || latestData?.id || null,
        training_status:"untrained",
        weights_ready:false,
      };

      if(entry){
        Object.assign(entry,snapshot);
      }else{
        entry={id:uid("model"),...snapshot};
        state.model_outputs=state.model_outputs||[];
        state.model_outputs.push(entry);
      }
      return entry;
    }

    function showModelBuildErrors(errors){
      const states={};
      (modelRootComponent()?.nodes||[]).forEach(n=>states[n.id]={status:"queued",message:"Waiting"});
      errors.forEach(err=>(err.node_ids||[]).forEach(id=>{
        states[id]={status:"error",message:err.message};
      }));
      execution={status:"error",overall:0,message:errors[0]?.message||"Model Build failed.",nodes:states};
      setStatus(execution.message);
      draw();
    }

    function requestModelBuild(){
      if(state.active_workspace!=="model")return;
      const errors=validateModelBuild();
      if(errors.length){showModelBuildErrors(errors);return;}

      if(modelBuildTimer){clearInterval(modelBuildTimer);modelBuildTimer=null;}
      const model=modelRootComponent();
      const nodes=model.nodes||[];
      const states={};
      nodes.forEach(n=>states[n.id]={status:"queued",message:"Waiting to build"});
      execution={status:"running",overall:0,message:"Building model design…",nodes:states};
      setStatus(execution.message);
      draw();

      let index=0;
      const finish=()=>{
        const entry=registerBuiltModel();
        execution={
          status:"done",overall:100,message:"Model built: "+entry.name,
          nodes:Object.fromEntries(nodes.map(n=>[n.id,{status:"done",message:"Built"}]))
        };
        bottomView="outputs";
        bottomExpanded=true;
        outputDirectorySelection=entry.id;
        selected=null;
        setStatus("Build complete. Select training data and check compatibility.");
        draw();
      };

      modelBuildTimer=setInterval(()=>{
        if(index>0){
          const prev=nodes[index-1];
          states[prev.id]={status:"done",message:"Built"};
        }
        if(index>=nodes.length){
          clearInterval(modelBuildTimer);modelBuildTimer=null;finish();return;
        }
        const node=nodes[index];
        states[node.id]={status:"running",message:"Building "+node.name+"…"};
        execution={
          status:"running",
          overall:Math.round(index/Math.max(nodes.length,1)*100),
          message:"Building "+node.name+"…",
          nodes:cp(states)
        };
        applyExecutionProgress(execution);
        index++;
      },110);
    }

    function datasetModality(meta){
      const p=meta?.pipeline||{};
      if(p.image_processing)return "image";
      if(p.audio_processing)return "audio";
      return "text";
    }

    function datasetTrainingCapabilities(datasetMeta){
      const pipeline=datasetMeta?.pipeline||{};
      const tokenizer=pipeline.tokenizer||null;
      const cols=datasetMeta?.splits?.train?.columns||[];
      const hasInputIds=cols.includes("input_ids");
      const declaredRepack=datasetMeta?.capabilities?.runtime_context_repack===true;
      return {
        tokenizer,
        columns:cols,
        hasInputIds,
        repackableTokenStream:declaredRepack||hasInputIds,
        preparedContext:Number(tokenizer?.context_length||0)||null,
      };
    }

    function modelDatasetCompatibility(modelEntry,datasetMeta){
      const checks=[];
      const add=(label,ok,detail)=>checks.push({label,ok,detail});
      if(!datasetMeta){
        add("Prepared dataset",false,"Select a prepared dataset.");
        return {ok:false,checks};
      }

      const req=modelEntry?.requirements||{};
      add(
        "Build",
        modelEntry?.status==="built" || modelEntry?.status==="trained",
        modelEntry?.status==="needs_rebuild"?"Model settings changed · Build again":"Current build"
      );
      const modality=datasetModality(datasetMeta);
      add(
        "Modality",
        req.modality==="unknown" || req.modality===modality,
        "Model: "+(req.modality||"unknown")+" · Data: "+modality
      );

      const trainRows=datasetMeta?.splits?.train?.rows;
      add("Train split",Number(trainRows)>0,"Train rows: "+(trainRows??0));

      const caps=datasetTrainingCapabilities(datasetMeta);
      if(req.modality==="text" && req.requires_tokenizer){
        add("Tokenizer",!!caps.tokenizer,caps.tokenizer?.tokenizer_name||"Tokenizer missing");

        // Context is a model/runtime packing choice, not a property of token IDs.
        // Any prepared text dataset that exposes input_ids is a repackable token
        // stream, so one compatibility rule works for every current/future LM.
        add(
          "Tokenized fields",
          caps.hasInputIds,
          caps.hasInputIds?"input_ids available":"input_ids not found"
        );

        const modelContext=Number(req.context_length||0)||null;
        if(caps.repackableTokenStream && modelContext){
          const prepared=caps.preparedContext;
          const detail=prepared
            ? (prepared===modelContext
                ? "Prepared max "+prepared+" · Training "+modelContext+" · Exact packing"
                : "Prepared max "+prepared+" · Training "+modelContext+" · Auto repack token stream")
            : "Training "+modelContext+" · Packed from input_ids at runtime";
          add("Context packing",true,detail);
        }else if(caps.repackableTokenStream){
          add("Context packing",true,"Packed from input_ids at runtime");
        }
      }

      return {ok:checks.every(c=>c.ok),checks};
    }

    function setBuiltModelDataset(entry,datasetId){
      if(!entry)return;
      entry.selected_dataset_id=datasetId||null;
      const meta=preparedDatasetById(datasetId);
      if(meta){
        // Keep the editable model Text Input aligned with the training selection.
        const model=modelRootComponent();
        (model?.nodes||[]).filter(n=>n.type==="text_input").forEach(n=>configureTextInputForDataset(n,meta));
        state.project=state.project||{};
        state.project.dataset=meta.name;
      }
      setStatus(meta?meta.name+" selected for compatibility check.":"Training dataset cleared.");
      draw();
    }

    function defaultTrainingConfig(entry,dataset){
      const validationSplit=dataset?.splits?.validation ? "validation" : (dataset?.splits?.test ? "test" : "train");
      return {
        budget_type:"steps",
        max_steps:1000,
        max_tokens:1000000,
        epochs:1,
        batch_size:Number(entry?.batch_size||state.project?.batch_size||16),
        gradient_accumulation:1,
        optimizer:"adamw",
        learning_rate:0.0005,
        weight_decay:0.1,
        beta1:0.9,
        beta2:0.95,
        warmup_steps:0,
        validation_split:validationSplit,
        validate_every:100,
        validation_steps:20,
        generate_on_validation:true,
        validation_prompt:"Once upon a time",
        validation_generate_tokens:64,
        checkpoint_every:500,
        seed:42,
        device:"auto",
        backend:"pytorch",
        execution_mode:"eager",
        compile_mode:"reduce-overhead",
        precision:"fp16",
        output_dir:localPaths.models||((localDefaultRoot.replace(/[\\/]+$/,"")||".")+"/mlbricks/models"),
      };
    }

    function defaultGenerationConfig(entry){
      return {
        prompt:"Once upon a time",
        max_new_tokens:128,
        temperature:0.8,
        top_k:50,
        top_p:0.95,
        seed:42,
        device:"auto",
        backend:"pytorch",
        execution_mode:"eager",
        compile_mode:"reduce-overhead",
        precision:"fp16",
      };
    }

    function mergeRuntimeDefaults(defaults,saved){
      const out={...defaults};
      Object.entries(saved||{}).forEach(([key,value])=>{
        if(value!==null && value!==undefined && !(typeof value==="string" && value.trim()==="")){
          out[key]=value;
        }
      });
      return out;
    }

    function defaultServeConfig(entry){
      const gen=defaultGenerationConfig(entry);
      return {
        host:"0.0.0.0",port:8000,cors_origin:"*",require_api_key:true,public_tunnel:"off",
        device:entry?.generation_config?.device||gen.device,
        backend:entry?.generation_config?.backend||gen.backend,
        execution_mode:entry?.generation_config?.execution_mode||gen.execution_mode,
        compile_mode:entry?.generation_config?.compile_mode||gen.compile_mode,
        precision:entry?.generation_config?.precision||gen.precision
      };
    }

    function ensureRuntimeConfigs(entry){
      const dataset=preparedDatasetById(entry?.selected_dataset_id)||null;
      entry.training_config=mergeRuntimeDefaults(defaultTrainingConfig(entry,dataset),entry.training_config);
      entry.generation_config=mergeRuntimeDefaults(defaultGenerationConfig(entry),entry.generation_config);
      entry.serve_config=mergeRuntimeDefaults(defaultServeConfig(entry),entry.serve_config);
      serveSecrets[entry.id]=serveSecrets[entry.id]||{api_key:"",ngrok_token:""};
    }

    function openRuntimePanel(mode,entry){
      if(!entry)return;
      ensureRuntimeConfigs(entry);
      runtimePanel={mode,modelId:entry.id,tab:"setup"};
      // Keep MODEL WORKSPACE open normally and while serving. Only training
      // and generation collapse it automatically to maximize runtime space.
      if(mode==="train"||mode==="generate")bottomExpanded=false;
      selected=null;
      outputDirectorySelection=entry.id;
      setStatus(mode==="train"?"Training setup opened.":mode==="generate"?"Generation setup opened.":"Model API server setup opened.");
      draw();
    }

    function requestBuiltModelTraining(entry,compat){
      if(!entry||!compat?.ok)return;
      entry.training_status="configured";
      openRuntimePanel("train",entry);
    }

    function requestTokenGeneration(entry){
      if(!entry)return;
      openRuntimePanel("generate",entry);
    }

    function requestModelServing(entry){
      if(!entry||!entry.weights_ready)return;
      openRuntimePanel("serve",entry);
    }

    function runtimeDeviceOptions(){
      const devices=runtimeCaps.devices||[];
      return devices.length?devices:[{id:"auto",label:"Auto"},{id:"cpu",label:"CPU"}];
    }

    function selectedRuntimeDevice(config){
      return runtimeDeviceOptions().find(d=>d.id===config.device)||runtimeDeviceOptions()[0];
    }

    function runtimeField(label,type,value,onChange,options){
      const wrap=document.createElement("div");wrap.className="mlb-runtime-field";
      const l=document.createElement("label");l.textContent=label;wrap.appendChild(l);
      let input;
      if(type==="select"){
        input=document.createElement("select");
        (options||[]).forEach(opt=>{
          const item=typeof opt==="string"?{value:opt,label:opt}:opt;
          const o=document.createElement("option");o.value=item.value;o.textContent=item.label;
          if(String(item.value)===String(value))o.selected=true;input.appendChild(o);
        });
      }else if(type==="textarea"){
        input=document.createElement("textarea");input.rows=4;input.value=value??"";
      }else if(type==="checkbox"){
        input=document.createElement("input");input.type="checkbox";input.checked=!!value;
      }else{
        input=document.createElement("input");input.type=type||"text";input.value=value??"";
        if(type==="number")input.step="any";
      }
      const commit=()=>{
        const value=type==="checkbox"
          ?input.checked
          :(type==="number"?(input.value.trim()===""?null:Number(input.value)):input.value);
        onChange(value);
      };
      input.addEventListener("change",commit);
      wrap.appendChild(input);return wrap;
    }

    function runtimeSection(title){
      const s=document.createElement("section");s.className="mlb-runtime-section";
      const h=document.createElement("h3");h.textContent=title;s.appendChild(h);return s;
    }

    function deviceCards(config){
      const box=document.createElement("div");box.className="mlb-device-grid";
      runtimeDeviceOptions().forEach(device=>{
        const card=document.createElement("button");card.type="button";
        card.className="mlb-device-card"+(config.device===device.id?" selected":"");
        const icon=device.kind==="cpu"?"CPU":device.kind==="cuda"?"GPU":device.kind==="xpu"?"XPU":device.kind==="mps"?"GPU":"AUTO";
        card.innerHTML="<strong>"+icon+"</strong><span>"+device.label+"</span>"+
          (device.compute_capability?"<small>Compute "+device.compute_capability+"</small>":"");
        card.addEventListener("click",()=>{config.device=device.id;draw();});box.appendChild(card);
      });
      return box;
    }

    function runtimeCompatibilitySummary(entry){
      const dataset=preparedDatasetById(entry.selected_dataset_id)||null;
      return modelDatasetCompatibility(entry,dataset);
    }

    function trainingConfigValid(entry,config){
      const compat=runtimeCompatibilitySummary(entry);
      const errors=[];
      if(!compat.ok)errors.push("Training data is not compatible.");
      const positive=(value)=>value!==null&&value!==undefined&&value!==""&&Number.isFinite(Number(value))&&Number(value)>0;
      if(config.budget_type==="steps"&&!positive(config.max_steps))errors.push("Training steps must be a number greater than 0.");
      if(config.budget_type==="tokens"&&!positive(config.max_tokens))errors.push("Token budget must be a number greater than 0.");
      if(config.budget_type==="epochs"&&!positive(config.epochs))errors.push("Epochs must be a number greater than 0.");
      if(!positive(config.batch_size))errors.push("Batch size must be a number greater than 0.");
      if(!positive(config.learning_rate))errors.push("Learning rate must be a number greater than 0.");
      const betaValid=(value)=>value!==null&&value!==undefined&&Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<1;
      if(["adamw","adam"].includes(String(config.optimizer||"").toLowerCase())){
        if(!betaValid(config.beta1))errors.push("Adam Beta 1 must be between 0 and 1.");
        if(!betaValid(config.beta2))errors.push("Adam Beta 2 must be between 0 and 1.");
      }
      return {ok:errors.length===0,errors,compat};
    }

    function runtimeHistory(entry,mode){
      const key=mode==="train"?"training_history":"generation_history";
      if(!Array.isArray(entry[key]))entry[key]=[];
      return entry[key];
    }

    function recordRuntimeEvent(next){
      if(!next || !["train","generate"].includes(next.runtime_kind))return;
      const modelId=next.model_id||runtimePanel?.modelId;
      const entry=builtModelById(modelId);
      if(!entry)return;
      const history=runtimeHistory(entry,next.runtime_kind);
      const key=[next.ts||"",next.phase||"",next.step??"",next.generated_tokens??"",next.message||"",next.checkpoint_path||""].join("|");
      const event={
        key,ts:next.ts||Date.now()/1000,status:next.status||"running",phase:next.phase||"runtime",
        step:next.step??null,max_steps:next.max_steps??null,tokens_seen:next.tokens_seen??null,
        generated_tokens:next.generated_tokens??null,loss:next.loss??null,ppl:next.ppl??null,val_loss:next.val_loss??null,val_ppl:next.val_ppl??null,
        best_val_loss:next.best_val_loss??null,tokens_per_sec:next.tokens_per_sec??null,avg_tokens_per_sec:next.avg_tokens_per_sec??null,
        end_to_end_tokens_per_sec:next.end_to_end_tokens_per_sec??null,avg_end_to_end_tokens_per_sec:next.avg_end_to_end_tokens_per_sec??null,
        memory_allocated_gb:next.memory_allocated_gb??null,memory_reserved_gb:next.memory_reserved_gb??null,memory_peak_gb:next.memory_peak_gb??null,memory_total_gb:next.memory_total_gb??null,
        lr:next.lr??null,elapsed_seconds:next.elapsed_seconds??null,compile_seconds:next.compile_seconds??null,
        message:next.message||"",checkpoint_path:next.checkpoint_path||null
      };
      if(!history.length||history[history.length-1].key!==key)history.push(event);
      if(history.length>250)history.splice(0,history.length-250);

      if(next.runtime_kind==="train"){
        entry.training_live={
          status:event.status,phase:event.phase,overall:Number(next.overall||0),step:event.step,max_steps:event.max_steps,
          tokens_seen:event.tokens_seen??entry.training_live?.tokens_seen,
          loss:event.loss??entry.training_live?.loss,ppl:event.ppl??entry.training_live?.ppl,
          val_loss:event.val_loss??entry.training_live?.val_loss,val_ppl:event.val_ppl??entry.training_live?.val_ppl,
          best_val_loss:event.best_val_loss??entry.training_live?.best_val_loss,
          tokens_per_sec:event.tokens_per_sec??entry.training_live?.tokens_per_sec,avg_tokens_per_sec:event.avg_tokens_per_sec??entry.training_live?.avg_tokens_per_sec,
          end_to_end_tokens_per_sec:event.end_to_end_tokens_per_sec??entry.training_live?.end_to_end_tokens_per_sec,avg_end_to_end_tokens_per_sec:event.avg_end_to_end_tokens_per_sec??entry.training_live?.avg_end_to_end_tokens_per_sec,
          memory_allocated_gb:event.memory_allocated_gb??entry.training_live?.memory_allocated_gb,memory_reserved_gb:event.memory_reserved_gb??entry.training_live?.memory_reserved_gb,
          memory_peak_gb:event.memory_peak_gb??entry.training_live?.memory_peak_gb,memory_total_gb:event.memory_total_gb??entry.training_live?.memory_total_gb,
          lr:event.lr??entry.training_live?.lr,elapsed_seconds:event.elapsed_seconds??entry.training_live?.elapsed_seconds,
          compile_seconds:event.compile_seconds??entry.training_live?.compile_seconds,message:event.message,
          checkpoint_path:event.checkpoint_path||entry.training_live?.checkpoint_path||entry.checkpoint_path||null
        };
        if(next.sample_text){entry.latest_validation_sample=next.sample_text;entry.latest_validation_sample_step=event.step;}
        if(event.val_loss!==null){entry.latest_validation_loss=event.val_loss;entry.latest_validation_step=event.step;}
        if(event.checkpoint_path)entry.latest_checkpoint_path=event.checkpoint_path;
      }else{
        entry.generation_live={
          status:event.status,phase:event.phase,overall:Number(next.overall||0),generated_tokens:event.generated_tokens,
          message:event.message,generated_text:next.generated_text||entry.generation_live?.generated_text||entry.last_generation||""
        };
        if(next.generated_text)entry.last_generation=next.generated_text;
      }
    }

    function scheduleRuntimeStatusDraw(){
      if(!runtimePanel||runtimePanel.tab!=="status"||runtimeStatusRedrawTimer)return;
      runtimeStatusRedrawTimer=setTimeout(()=>{runtimeStatusRedrawTimer=null;draw();},120);
    }

    function runtimeTabButton(label,tab,entry,mode){
      const current=(runtimePanel?.tab||"setup")===tab;
      const button=btn(label,"mlb-runtime-tab"+(current?" active":""));
      button.addEventListener("click",()=>{runtimePanel={mode,modelId:entry.id,tab};draw();});
      return button;
    }

    function escapeRuntimeText(value){
      return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    function formatDuration(seconds){
      const n=Number(seconds||0);if(!n)return "—";if(n<60)return n.toFixed(1)+"s";
      return Math.floor(n/60)+"m "+Math.floor(n%60)+"s";
    }

    function statusMetric(label,value,sub){
      const box=document.createElement("div");box.className="mlb-status-metric";
      const a=document.createElement("span");a.textContent=label;
      const b=document.createElement("strong");b.textContent=value??"—";box.append(a,b);
      if(sub){const c=document.createElement("small");c.textContent=sub;box.appendChild(c);}return box;
    }

    function trainingLive(entry){
      const live=entry.training_live||{};
      if(execution.runtime_kind==="train"&&runtimePanel?.modelId===entry.id){
        return {...live,status:execution.status||live.status,phase:execution.phase||live.phase,overall:Number(execution.overall??live.overall??0),
          step:execution.step??live.step,max_steps:execution.max_steps??live.max_steps,tokens_seen:execution.tokens_seen??live.tokens_seen,
          loss:execution.loss??live.loss,ppl:execution.ppl??live.ppl,val_loss:execution.val_loss??live.val_loss,val_ppl:execution.val_ppl??live.val_ppl,
          best_val_loss:execution.best_val_loss??live.best_val_loss,tokens_per_sec:execution.tokens_per_sec??live.tokens_per_sec,avg_tokens_per_sec:execution.avg_tokens_per_sec??live.avg_tokens_per_sec,
          end_to_end_tokens_per_sec:execution.end_to_end_tokens_per_sec??live.end_to_end_tokens_per_sec,avg_end_to_end_tokens_per_sec:execution.avg_end_to_end_tokens_per_sec??live.avg_end_to_end_tokens_per_sec,
          memory_allocated_gb:execution.memory_allocated_gb??live.memory_allocated_gb,memory_reserved_gb:execution.memory_reserved_gb??live.memory_reserved_gb,
          memory_peak_gb:execution.memory_peak_gb??live.memory_peak_gb,memory_total_gb:execution.memory_total_gb??live.memory_total_gb,lr:execution.lr??live.lr,
          elapsed_seconds:execution.elapsed_seconds??live.elapsed_seconds,compile_seconds:execution.compile_seconds??live.compile_seconds,message:execution.message||live.message,
          checkpoint_path:execution.checkpoint_path||live.checkpoint_path};
      }return live;
    }

    function generationLive(entry){
      const live=entry.generation_live||{};
      if(execution.runtime_kind==="generate"&&runtimePanel?.modelId===entry.id){
        return {...live,status:execution.status||live.status,phase:execution.phase||live.phase,overall:Number(execution.overall??live.overall??0),
          generated_tokens:execution.generated_tokens??live.generated_tokens,message:execution.message||live.message,
          generated_text:execution.generated_text||live.generated_text};
      }return live;
    }

    function renderEventLog(section,history,emptyText){
      const log=document.createElement("div");log.className="mlb-training-log";
      const events=(history||[]).slice(-100);
      if(!events.length){log.innerHTML="<div class='mlb-log-empty'>"+emptyText+"</div>";}
      else events.forEach(ev=>{
        const row=document.createElement("div");row.className="mlb-log-row "+(ev.status||"");
        const meta=[];if(ev.step!==null)meta.push("step "+ev.step);if(ev.generated_tokens!==null)meta.push(ev.generated_tokens+" tokens");if(ev.phase)meta.push(ev.phase);
        const extra=[];
        if(ev.tokens_per_sec!==null)extra.push("GPU "+Math.round(Number(ev.tokens_per_sec)).toLocaleString()+" tok/s");
        if(ev.end_to_end_tokens_per_sec!==null)extra.push("E2E "+Math.round(Number(ev.end_to_end_tokens_per_sec)).toLocaleString()+" tok/s");
        if(ev.memory_allocated_gb!==null)extra.push("mem "+Number(ev.memory_allocated_gb).toFixed(2)+" GB");
        if(ev.loss!==null)extra.push("loss "+Number(ev.loss).toFixed(4));
        if(ev.ppl!==null)extra.push("ppl "+Number(ev.ppl).toFixed(2));
        if(ev.val_loss!==null)extra.push("val "+Number(ev.val_loss).toFixed(4));
        if(ev.val_ppl!==null)extra.push("val ppl "+Number(ev.val_ppl).toFixed(2));
        row.innerHTML="<span>"+escapeRuntimeText(meta.join(" · "))+"</span><strong>"+escapeRuntimeText(ev.message||"Runtime event")+(extra.length?" · "+extra.join(" · "):"")+"</strong>";
        log.appendChild(row);
      });
      section.appendChild(log);
    }

    function renderTrainingStatus(main,side,entry){
      const config=entry.training_config||{},live=trainingLive(entry),history=runtimeHistory(entry,"train");
      const dataset=preparedDatasetById(entry.selected_dataset_id)||null;
      const hero=runtimeSection("Training Status");hero.classList.add("mlb-training-status-hero");
      const top=document.createElement("div");top.className="mlb-training-status-top";
      const stateBox=document.createElement("div");stateBox.className="mlb-training-state "+(live.status||entry.training_status||"idle");
      const stateLabel=live.status==="running"?"TRAINING":live.status==="done"?"COMPLETE":live.status==="error"?"ERROR":live.status==="stopped"?"STOPPED":entry.weights_ready?"TRAINED":"NOT STARTED";
      stateBox.innerHTML="<strong>"+stateLabel+"</strong><span>"+escapeRuntimeText(live.message||"Configure training, then press Start Training.")+"</span>";
      const pct=document.createElement("div");pct.className="mlb-training-percent";pct.innerHTML="<strong>"+Math.round(Number(live.overall||0))+"%</strong><span>"+(live.phase||"idle")+"</span>";
      top.append(stateBox,pct);hero.appendChild(top);
      const bar=document.createElement("div");bar.className="mlb-status-progress";bar.innerHTML="<i style='width:"+Math.max(0,Math.min(100,Number(live.overall||0)))+"%'></i>";hero.appendChild(bar);
      const metrics=document.createElement("div");metrics.className="mlb-status-metrics";
      // While a new/current attempt exists, use only that attempt's telemetry.
      // Stored metrics from the previous completed run are shown only when no
      // active/error attempt is being displayed. This prevents an immediate
      // setup error from appearing beside stale values such as Step 1000.
      const currentAttempt=["running","error","stopped"].includes(live.status);
      const pick=(current,stored)=>current!=null?current:(currentAttempt?null:stored);
      const memoryNow=pick(live.memory_allocated_gb,null),peakMemory=pick(live.memory_peak_gb,entry.memory_peak_gb);
      const stepNow=pick(live.step,entry.trained_steps);
      const tokNow=pick(live.tokens_per_sec,entry.avg_tokens_per_sec);
      const e2eTokNow=pick(live.end_to_end_tokens_per_sec,entry.avg_end_to_end_tokens_per_sec);
      const lossNow=pick(live.loss,entry.last_loss);
      const pplNow=pick(live.ppl,entry.last_ppl);
      const valLossStored=entry.latest_validation_loss??entry.last_val_loss;
      const valLossNow=pick(live.val_loss,valLossStored);
      const valPplNow=pick(live.val_ppl,entry.last_val_ppl);
      const tokensNow=pick(live.tokens_seen,entry.tokens_seen);
      metrics.append(statusMetric("Step",(stepNow??0)+(live.max_steps?" / "+live.max_steps:"")),
        statusMetric("GPU Tok/s",tokNow==null?"—":Math.round(Number(tokNow)).toLocaleString()),
        statusMetric("E2E Tok/s",e2eTokNow==null?"—":Math.round(Number(e2eTokNow)).toLocaleString()),
        statusMetric("Loss",lossNow==null?"—":Number(lossNow).toFixed(4)),
        statusMetric("PPL",pplNow==null?"—":Number(pplNow).toFixed(2)),
        statusMetric("Val Loss",valLossNow==null?"—":Number(valLossNow).toFixed(4)),
        statusMetric("Val PPL",valPplNow==null?"—":Number(valPplNow).toFixed(2)),
        statusMetric("GPU Memory",memoryNow==null?"—":Number(memoryNow).toFixed(2)+" GB",live.memory_total_gb==null?null:"of "+Number(live.memory_total_gb).toFixed(1)+" GB"),
        statusMetric("Peak Memory",peakMemory==null?"—":Number(peakMemory).toFixed(2)+" GB"),
        statusMetric("Compile",config.execution_mode==="compiled"?(live.compile_seconds==null?(currentAttempt?"Pending":(entry.compile_seconds==null?"Pending":Number(entry.compile_seconds).toFixed(1)+"s")):Number(live.compile_seconds).toFixed(1)+"s"):"Not used"),
        statusMetric("Tokens",Number(tokensNow??0).toLocaleString()),statusMetric("Elapsed",formatDuration(live.elapsed_seconds)));
      hero.appendChild(metrics);main.appendChild(hero);

      const validation=runtimeSection("Validation + Generated Sample");
      const vg=document.createElement("div");vg.className="mlb-validation-status-grid";
      vg.append(statusMetric("Dataset",dataset?.name||"—"),statusMetric("Validation Split",config.validation_split||"—"),
        statusMetric("Validate Every",(config.validate_every||0)+" steps"),statusMetric("Validation Steps",config.validation_steps??"—"),
        statusMetric("Latest Val",entry.latest_validation_loss==null?"—":Number(entry.latest_validation_loss).toFixed(4),entry.latest_validation_step?"step "+entry.latest_validation_step:null),
        statusMetric("Sample Tokens",config.generate_on_validation?config.validation_generate_tokens:"Off"));
      validation.appendChild(vg);
      const sample=document.createElement("div");sample.className="mlb-status-sample";
      sample.innerHTML="<div><strong>VALIDATION GENERATION</strong><span>"+(config.generate_on_validation?("Prompt: "+escapeRuntimeText(config.validation_prompt||"")):"Disabled in Training Setup")+"</span></div><pre>"+escapeRuntimeText(entry.latest_validation_sample||"No validation sample generated yet.")+"</pre>";
      validation.appendChild(sample);main.appendChild(validation);

      const logs=runtimeSection("Training Log");renderEventLog(logs,history,"Training has not started yet.");main.appendChild(logs);
      const cp=runtimeSection("Checkpoints + Output");const cg=document.createElement("div");cg.className="mlb-validation-status-grid";
      cg.append(statusMetric("Checkpoint Every",(config.checkpoint_every||0)+" steps"),statusMetric("Output Dir",config.output_dir||"—"),
        statusMetric("Latest Checkpoint",entry.latest_checkpoint_path||entry.checkpoint_path||live.checkpoint_path||"—"),statusMetric("Weights",entry.weights_ready?"Available":"Not yet"),
        statusMetric("Training Status",entry.training_status||"untrained"),statusMetric("Trained At",entry.trained_at||"—"));cp.appendChild(cg);main.appendChild(cp);

      const summary=document.createElement("div");summary.className="mlb-runtime-summary";const dev=selectedRuntimeDevice(config);
      summary.innerHTML="<h3>Training Control</h3><div><span>Status</span><strong>"+stateLabel+"</strong></div><div><span>Device</span><strong>"+dev.label+"</strong></div><div><span>Backend</span><strong>"+config.backend+"</strong></div><div><span>Execution</span><strong>"+config.execution_mode+"</strong></div><div><span>Precision</span><strong>"+config.precision+"</strong></div>";side.appendChild(summary);
      const stop=btn("Stop Training","mlb-runtime-stop");stop.disabled=!(execution.status==="running"&&execution.runtime_kind==="train");stop.addEventListener("click",requestStop);side.appendChild(stop);
      if(entry.weights_ready){const gen=btn("Open Generation","mlb-generate-btn");gen.addEventListener("click",()=>openRuntimePanel("generate",entry));side.appendChild(gen);}
    }

    function renderGenerationStatus(main,side,entry){
      const config=entry.generation_config||{},live=generationLive(entry),history=runtimeHistory(entry,"generate");
      const hero=runtimeSection("Generation Status");hero.classList.add("mlb-training-status-hero");
      const top=document.createElement("div");top.className="mlb-training-status-top";
      const stateBox=document.createElement("div");stateBox.className="mlb-training-state "+(live.status||"idle");
      const stateLabel=live.status==="running"?"GENERATING":live.status==="done"?"COMPLETE":live.status==="error"?"ERROR":live.status==="stopped"?"STOPPED":"READY";
      stateBox.innerHTML="<strong>"+stateLabel+"</strong><span>"+escapeRuntimeText(live.message||"Configure generation, then press Generate Tokens.")+"</span>";
      const pct=document.createElement("div");pct.className="mlb-training-percent";pct.innerHTML="<strong>"+Math.round(Number(live.overall||0))+"%</strong><span>"+(live.phase||"idle")+"</span>";
      top.append(stateBox,pct);hero.appendChild(top);
      const bar=document.createElement("div");bar.className="mlb-status-progress";bar.innerHTML="<i style='width:"+Math.max(0,Math.min(100,Number(live.overall||0)))+"%'></i>";hero.appendChild(bar);
      const metrics=document.createElement("div");metrics.className="mlb-status-metrics";
      metrics.append(statusMetric("Generated",Number(live.generated_tokens||0).toLocaleString()),statusMetric("Target",Number(config.max_new_tokens||0).toLocaleString()),
        statusMetric("Temperature",config.temperature),statusMetric("Top K",config.top_k),statusMetric("Top P",config.top_p),statusMetric("Seed",config.seed));hero.appendChild(metrics);main.appendChild(hero);

      const output=runtimeSection("Generated Text");const prompt=document.createElement("div");prompt.className="mlb-status-prompt";prompt.innerHTML="<strong>PROMPT</strong><pre>"+escapeRuntimeText(config.prompt||"")+"</pre>";output.appendChild(prompt);
      const text=document.createElement("div");text.className="mlb-status-sample generation";text.innerHTML="<div><strong>OUTPUT</strong><span>"+Number(live.generated_tokens||0)+" / "+Number(config.max_new_tokens||0)+" tokens</span></div><pre>"+escapeRuntimeText(live.generated_text||entry.last_generation||"No generated text yet.")+"</pre>";output.appendChild(text);main.appendChild(output);

      const logs=runtimeSection("Generation Log");renderEventLog(logs,history,"Generation has not started yet.");main.appendChild(logs);
      const runtime=runtimeSection("Runtime Used");const rg=document.createElement("div");rg.className="mlb-validation-status-grid";const dev=selectedRuntimeDevice(config);
      rg.append(statusMetric("Device",dev.label),statusMetric("Backend",config.backend),statusMetric("Execution",config.execution_mode),statusMetric("Compile",config.execution_mode==="compiled"?config.compile_mode:"Not used"),statusMetric("Precision",config.precision),statusMetric("Generated At",entry.generated_at||"—"));runtime.appendChild(rg);main.appendChild(runtime);

      const summary=document.createElement("div");summary.className="mlb-runtime-summary";summary.innerHTML="<h3>Generation Control</h3><div><span>Status</span><strong>"+stateLabel+"</strong></div><div><span>Device</span><strong>"+dev.label+"</strong></div><div><span>Generated</span><strong>"+Number(live.generated_tokens||0)+" / "+Number(config.max_new_tokens||0)+"</strong></div><div><span>Weights</span><strong>"+(entry.weights_ready?"Available":"Missing")+"</strong></div>";side.appendChild(summary);
      const stop=btn("Stop Generation","mlb-runtime-stop");stop.disabled=!(execution.status==="running"&&execution.runtime_kind==="generate");stop.addEventListener("click",requestStop);side.appendChild(stop);
    }

    async function copyTextRobust(text,label="Text"){
      const value=String(text||"");
      if(!value){setStatus(label+" is empty.");return false;}

      try{
        if(navigator.clipboard&&navigator.clipboard.writeText){
          await navigator.clipboard.writeText(value);
          setStatus(label+" copied.");
          return true;
        }
      }catch(_){/* Kaggle iframe may block clipboard permission. */}

      try{
        const doc=root.ownerDocument||document;
        const area=doc.createElement("textarea");
        area.value=value;
        area.setAttribute("readonly","");
        area.style.position="fixed";
        area.style.left="-9999px";
        area.style.top="0";
        doc.body.appendChild(area);
        area.focus();area.select();area.setSelectionRange(0,value.length);
        const ok=doc.execCommand&&doc.execCommand("copy");
        area.remove();
        if(ok){setStatus(label+" copied.");return true;}
      }catch(_){/* fall through */}

      // Last-resort Kaggle-safe behavior: select/show the secret so Ctrl+C works.
      try{
        const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
        if(win&&typeof win.prompt==="function"){
          win.prompt("Copy "+label+" (Ctrl+C, Enter):",value);
          setStatus("Copy "+label+" from the opened box.");
          return false;
        }
      }catch(_){ }
      setStatus("Clipboard blocked. Select the "+label+" value and press Ctrl+C.");
      return false;
    }

    function serveUrlCard(label,url,kind,emptyLabel="Unavailable"){
      const card=document.createElement("div");card.className="mlb-serve-url "+kind;
      const top=document.createElement("div");top.innerHTML="<strong>"+label+"</strong><span>"+(url||emptyLabel)+"</span>";card.appendChild(top);
      if(url){const actions=document.createElement("div");
        const open=btn("Open","mlb-serve-mini");open.addEventListener("click",()=>window.open(url,"_blank","noopener"));
        const copyBtn=btn("Copy","mlb-serve-mini");copyBtn.addEventListener("click",()=>copyTextRobust(url,label));
        actions.append(open,copyBtn);card.appendChild(actions);}
      return card;
    }

    function serveCodeExample(entry,info){
      const base=info?.public_url||info?.lan_url||info?.local_url||"http://127.0.0.1:8000";
      const secret=serveSecrets[entry.id]?.api_key||"YOUR_API_KEY";
      const lines=[
        'fetch("'+base+'/v1/generate", {',
        '  method: "POST",',
        '  headers: {',
        '    "Content-Type": "application/json",'
      ];
      if(entry.serve_config?.require_api_key!==false){
        lines.push('    "Authorization": "Bearer '+secret+'",');
      }
      lines.push(
        '  },',
        '  body: JSON.stringify({',
        '    prompt: "Once upon a time",',
        '    max_new_tokens: 128',
        '  })',
        '})',
        '.then(r => r.json())',
        '.then(console.log);'
      );
      return lines.join("\n");
    }


    function renderServingWorkspace(canvas,entry){
      ensureRuntimeConfigs(entry);
      const config=entry.serve_config,secret=serveSecrets[entry.id]||(serveSecrets[entry.id]={api_key:"",ngrok_token:""});
      const tab=runtimePanel?.tab||"setup",info=entry.serve_live||{};
      const outer=document.createElement("div");outer.className="mlb-runtime-workspace";
      const top=document.createElement("div");top.className="mlb-runtime-head";
      const title=document.createElement("div");title.innerHTML="<strong>SERVE MODEL / API</strong><span>"+entry.name+"</span>";
      const tabs=document.createElement("div");tabs.className="mlb-runtime-tabs";
      tabs.append(runtimeTabButton("API Server Setup","setup",entry,"serve"),runtimeTabButton("API Server Status","status",entry,"serve"));
      top.append(title,tabs);outer.appendChild(top);
      const layout=document.createElement("div");layout.className="mlb-runtime-layout";
      const main=document.createElement("div");main.className="mlb-runtime-main",side=document.createElement("aside");side.className="mlb-runtime-side";
      layout.append(main,side);outer.appendChild(layout);
      const update=(key,value)=>{config[key]=value;setStatus("Server setting updated: "+key);draw();};

      if(tab==="status"){
        const running=entry.serve_status==="running"||!!info.local_url;
        const failed=entry.serve_status==="error"||!!info.error;
        const tunnelError=info.public_tunnel_error||entry.serve_tunnel_error||null;
        const hero=runtimeSection("API Server Status"),status=document.createElement("div");
        status.className="mlb-serve-status "+(running?"running":failed?"error":"stopped");
        status.innerHTML="<strong>"+(running?(tunnelError?"● RUNNING · LOCAL":"● RUNNING"):failed?"✕ ERROR":"○ STOPPED")+"</strong><span>"+
          (running
            ?(tunnelError?"HTTP server is running, but Public HTTPS failed. Check the ngrok error below.":"Model is accepting HTTP inference requests.")
            :failed?(info.error||"API server failed to start."):"Start the server from API Server Setup.")+
          "</span>";
        hero.appendChild(status);
        if(running&&info.used_port_fallback){
          const portNotice=document.createElement("div");portNotice.className="mlb-serve-port-notice";
          portNotice.innerHTML="<strong>Port "+(info.requested_port||config.port)+" was busy.</strong><span>Builder automatically selected port "+info.port+". All links and examples below use the actual port.</span>";
          hero.appendChild(portNotice);
        }
        if(running&&tunnelError){
          const tunnelNotice=document.createElement("div");tunnelNotice.className="mlb-serve-tunnel-error";
          tunnelNotice.innerHTML="<strong>Public HTTPS tunnel failed</strong><span>"+tunnelError+"</span><small>The local HTTP server and API key are still valid. Fix the ngrok token/setup, then Restart API Server.</small>";
          hero.appendChild(tunnelNotice);
        }
        main.appendChild(hero);
        const links=runtimeSection("Access Links"),linkGrid=document.createElement("div");linkGrid.className="mlb-serve-links";
        linkGrid.append(serveUrlCard("Localhost",info.local_url||entry.serve_urls?.local_url,"local"),
          serveUrlCard("LAN / Same Wi‑Fi",info.lan_url||entry.serve_urls?.lan_url,"lan"),
          serveUrlCard(
            "Public HTTPS",
            info.public_url||entry.serve_urls?.public_url,
            "public",
            tunnelError?"Tunnel failed":"Unavailable"
          ));links.appendChild(linkGrid);main.appendChild(links);
        if(info.remote_notebook&&!info.public_url){const warn=document.createElement("div");warn.className="mlb-serve-warning";
          warn.innerHTML="<strong>"+(info.environment||"Remote notebook")+" detected</strong><span>localhost and LAN belong to the remote kernel. Enable ngrok Public HTTPS in Setup for your phone or local web app.</span>";main.appendChild(warn);}
        const endpoints=runtimeSection("API Endpoints"),ep=document.createElement("div");ep.className="mlb-serve-endpoints";
        [["Playground","GET /"],["Health","GET /health"],["Generate","POST /v1/generate"],["OpenAI-style","POST /v1/completions"],["Models","GET /v1/models"]].forEach(([a,b])=>{const row=document.createElement("div");row.innerHTML="<span>"+a+"</span><strong>"+b+"</strong>";ep.appendChild(row);});endpoints.appendChild(ep);main.appendChild(endpoints);
        const code=runtimeSection("Web App Example"),pre=document.createElement("pre");pre.className="mlb-serve-code";pre.textContent=serveCodeExample(entry,info);code.appendChild(pre);main.appendChild(code);
        const summary=document.createElement("div");summary.className="mlb-runtime-summary";summary.innerHTML="<h3>Server</h3><div><span>Status</span><strong>"+(running?"Running":"Stopped")+"</strong></div><div><span>Port</span><strong>"+(info.port||config.port)+"</strong></div><div><span>API Key</span><strong>"+(config.require_api_key?"Required":"Off")+"</strong></div><div><span>Public Tunnel</span><strong>"+(config.public_tunnel||"off")+"</strong></div>";side.appendChild(summary);
        if(config.require_api_key){const keyBox=document.createElement("div");keyBox.className="mlb-serve-secret";keyBox.innerHTML="<strong>API KEY</strong><code title='Click to select'>"+(secret.api_key||"Restart server to generate key")+"</code>";
          const keyCode=keyBox.querySelector("code");
          keyCode?.addEventListener("click",()=>{
            try{const range=(root.ownerDocument||document).createRange();range.selectNodeContents(keyCode);const sel=(root.ownerDocument.defaultView||window).getSelection();sel.removeAllRanges();sel.addRange(range);setStatus("API key selected — press Ctrl+C.");}catch(_){}
          });const copyKey=btn("Copy API Key","mlb-dark-btn");copyKey.addEventListener("click",()=>copyTextRobust(secret.api_key||"","API key"));keyBox.appendChild(copyKey);side.appendChild(keyBox);}
        const check=btn("Refresh Status","mlb-dark-btn");check.addEventListener("click",()=>requestServeCommand("serve_status",entry));side.appendChild(check);
        const stop=btn("Stop API Server","mlb-runtime-stop");stop.disabled=!running;stop.addEventListener("click",()=>requestServeCommand("serve_stop",entry));side.appendChild(stop);
        canvas.appendChild(outer);return;
      }

      const access=runtimeSection("Server Access"),accessGrid=document.createElement("div");accessGrid.className="mlb-runtime-grid";
      accessGrid.append(runtimeField("Host","text",config.host,v=>update("host",v)),runtimeField("Port","number",config.port,v=>update("port",v)),
        runtimeField("CORS Origin","text",config.cors_origin,v=>update("cors_origin",v)),runtimeField("Require API Key","checkbox",config.require_api_key,v=>update("require_api_key",v)),
        runtimeField("Public Link","select",config.public_tunnel,v=>update("public_tunnel",v),[{value:"off",label:"Off — Local / LAN only"},{value:"ngrok",label:"ngrok — Public HTTPS"}]));
      access.appendChild(accessGrid);main.appendChild(access);

      const secretsSection=runtimeSection("Session Credentials"),secGrid=document.createElement("div");secGrid.className="mlb-runtime-grid";
      secGrid.appendChild(runtimeField("API Key (blank = generate one)","password",secret.api_key,v=>secret.api_key=v));
      if(config.public_tunnel==="ngrok")secGrid.appendChild(runtimeField("ngrok Authtoken","password",secret.ngrok_token,v=>secret.ngrok_token=v));
      secretsSection.appendChild(secGrid);const sn=document.createElement("div");sn.className="mlb-serve-secret-note";sn.textContent="API keys and ngrok tokens are session-only and are not saved in Builder files.";secretsSection.appendChild(sn);main.appendChild(secretsSection);

      const dev=runtimeSection("Available Devices");dev.appendChild(deviceCards(config));main.appendChild(dev);
      const runtime=runtimeSection("Inference Runtime"),grid=document.createElement("div");grid.className="mlb-runtime-grid";
      const deviceOpts=runtimeDeviceOptions().map(d=>({value:d.id,label:d.label}));
      grid.append(runtimeField("Device","select",config.device,v=>update("device",v),deviceOpts),
        runtimeField("Backend","select",config.backend,v=>update("backend",v),runtimeCaps.backends||["auto","native","pytorch"]),
        runtimeField("Execution","select",config.execution_mode,v=>update("execution_mode",v),runtimeCaps.execution_modes||["eager","compiled"]),
        runtimeField("Compile Mode","select",config.compile_mode,v=>update("compile_mode",v),runtimeCaps.compile_modes||["default","reduce-overhead","max-autotune"]),
        runtimeField("Precision","select",config.precision,v=>update("precision",v),runtimeCaps.precisions||["auto","fp32","fp16","bf16"]));runtime.appendChild(grid);main.appendChild(runtime);

      const device=selectedRuntimeDevice(config),summary=document.createElement("div");summary.className="mlb-runtime-summary";
      summary.innerHTML="<h3>Serve Summary</h3><div><span>Device</span><strong>"+device.label+"</strong></div><div><span>Host</span><strong>"+config.host+":"+config.port+"</strong></div><div><span>Auth</span><strong>"+(config.require_api_key?"API key":"None")+"</strong></div><div><span>Public</span><strong>"+(config.public_tunnel==="ngrok"?"ngrok HTTPS":"Off")+"</strong></div><div><span>Execution</span><strong>"+config.execution_mode+"</strong></div>";side.appendChild(summary);
      const weights=document.createElement("div");weights.className="mlb-weight-status "+(entry.weights_ready?"ready":"missing");weights.textContent=entry.weights_ready?"✓ Trained / loaded weights available":"✕ No weights available";side.appendChild(weights);
      const start=btn(entry.serve_status==="running"?"Restart API Server":"Start API Server","mlb-runtime-start");start.disabled=!entry.weights_ready||execution.status==="running";
      start.addEventListener("click",()=>{
        runtimePanel={mode:"serve",modelId:entry.id,tab:"status"};
        entry.serve_status="starting";
        entry.serve_live={running:false,error:null,message:"Starting API server…"};
        draw();
        setTimeout(()=>requestServeCommand("serve_start",entry),80);
      });side.appendChild(start);
      if(config.public_tunnel==="ngrok"){const note=document.createElement("div");note.className="mlb-serve-warning compact";note.innerHTML="<strong>Remote access</strong><span>ngrok creates the HTTPS URL needed to reach a Kaggle/Colab model from your phone or local web app.</span>";side.appendChild(note);}
      canvas.appendChild(outer);
    }

    function renderRuntimeWorkspace(canvas,entry,mode){
      if(mode==="serve"){renderServingWorkspace(canvas,entry);return;}
      const outer=document.createElement("div");outer.className="mlb-runtime-workspace";
      const top=document.createElement("div");top.className="mlb-runtime-head";
      const title=document.createElement("div");title.innerHTML="<strong>"+(mode==="train"?"TRAIN MODEL":"GENERATE TOKENS")+"</strong><span>"+entry.name+"</span>";
      const tabs=document.createElement("div");tabs.className="mlb-runtime-tabs";
      tabs.append(
        runtimeTabButton(mode==="train"?"Training Setup":"Generation Setup","setup",entry,mode),
        runtimeTabButton(mode==="train"?"Training Status":"Generation Status","status",entry,mode)
      );
      top.append(title,tabs);outer.appendChild(top);

      const layout=document.createElement("div");layout.className="mlb-runtime-layout";
      const main=document.createElement("div");main.className="mlb-runtime-main";
      const side=document.createElement("aside");side.className="mlb-runtime-side";
      layout.append(main,side);outer.appendChild(layout);

      const config=mode==="train"?entry.training_config:entry.generation_config;
      const update=(key,value)=>{config[key]=value;setStatus((mode==="train"?"Training":"Generation")+" setting updated: "+key);draw();};
      const tab=runtimePanel?.tab||"setup";
      if(tab==="status"){
        if(mode==="train")renderTrainingStatus(main,side,entry);
        else renderGenerationStatus(main,side,entry);
        canvas.appendChild(outer);
        return;
      }

      const dev=runtimeSection("Available Devices");dev.appendChild(deviceCards(config));main.appendChild(dev);

      if(mode==="train"){
        const dataset=preparedDatasetById(entry.selected_dataset_id)||null;
        const budget=runtimeSection("Training Budget");
        const budgetGrid=document.createElement("div");budgetGrid.className="mlb-runtime-grid";
        budgetGrid.append(
          runtimeField("Budget By","select",config.budget_type,v=>update("budget_type",v),["steps","tokens","epochs"]),
          runtimeField("Training Steps","number",config.max_steps,v=>update("max_steps",v)),
          runtimeField("Token Budget","number",config.max_tokens,v=>update("max_tokens",v)),
          runtimeField("Epochs","number",config.epochs,v=>update("epochs",v)),
          runtimeField("Batch Size","number",config.batch_size,v=>update("batch_size",v)),
          runtimeField("Gradient Accumulation","number",config.gradient_accumulation,v=>update("gradient_accumulation",v))
        );budget.appendChild(budgetGrid);main.appendChild(budget);

        const opt=runtimeSection("Optimizer");const optGrid=document.createElement("div");optGrid.className="mlb-runtime-grid";
        optGrid.append(
          runtimeField("Optimizer","select",config.optimizer,v=>update("optimizer",v),["adamw","adam","sgd"]),
          runtimeField("Learning Rate","number",config.learning_rate,v=>update("learning_rate",v)),
          runtimeField("Weight Decay","number",config.weight_decay,v=>update("weight_decay",v)),
          runtimeField("Adam Beta 1","number",config.beta1,v=>update("beta1",v)),
          runtimeField("Adam Beta 2","number",config.beta2,v=>update("beta2",v)),
          runtimeField("Warmup Steps","number",config.warmup_steps,v=>update("warmup_steps",v)),
          runtimeField("Seed","number",config.seed,v=>update("seed",v))
        );opt.appendChild(optGrid);main.appendChild(opt);

        const val=runtimeSection("Validation + Sample Generation");const valGrid=document.createElement("div");valGrid.className="mlb-runtime-grid";
        const splitOpts=dataset?Object.keys(dataset.splits||{}).map(x=>({value:x,label:datasetSplitLabel(x,dataset)})):[{value:"validation",label:"Validation"}];
        valGrid.append(
          runtimeField("Validation Split","select",config.validation_split,v=>update("validation_split",v),splitOpts),
          runtimeField("Validate Every N Steps","number",config.validate_every,v=>update("validate_every",v)),
          runtimeField("Validation Steps","number",config.validation_steps,v=>update("validation_steps",v)),
          runtimeField("Generate Sample at Validation","checkbox",config.generate_on_validation,v=>update("generate_on_validation",v)),
          runtimeField("Validation Sample Tokens","number",config.validation_generate_tokens,v=>update("validation_generate_tokens",v)),
          runtimeField("Checkpoint Every N Steps","number",config.checkpoint_every,v=>update("checkpoint_every",v))
        );val.appendChild(valGrid);
        if(config.generate_on_validation)val.appendChild(runtimeField("Validation Prompt","textarea",config.validation_prompt,v=>update("validation_prompt",v)));
        main.appendChild(val);
      }else{
        const gen=runtimeSection("Prompt + Sampling");
        gen.appendChild(runtimeField("Prompt","textarea",config.prompt,v=>update("prompt",v)));
        const genGrid=document.createElement("div");genGrid.className="mlb-runtime-grid";
        genGrid.append(
          runtimeField("New Token Count","number",config.max_new_tokens,v=>update("max_new_tokens",v)),
          runtimeField("Temperature","number",config.temperature,v=>update("temperature",v)),
          runtimeField("Top K","number",config.top_k,v=>update("top_k",v)),
          runtimeField("Top P","number",config.top_p,v=>update("top_p",v)),
          runtimeField("Seed","number",config.seed,v=>update("seed",v))
        );gen.appendChild(genGrid);main.appendChild(gen);
      }

      const runtime=runtimeSection("Runtime");const runtimeGrid=document.createElement("div");runtimeGrid.className="mlb-runtime-grid";
      const deviceOpts=runtimeDeviceOptions().map(d=>({value:d.id,label:d.label}));
      runtimeGrid.append(
        runtimeField("Device","select",config.device,v=>update("device",v),deviceOpts),
        runtimeField("Backend","select",config.backend,v=>update("backend",v),runtimeCaps.backends||["auto","native","pytorch"]),
        runtimeField("Execution","select",config.execution_mode,v=>update("execution_mode",v),runtimeCaps.execution_modes||["eager","compiled"]),
        runtimeField("Compile Mode","select",config.compile_mode,v=>update("compile_mode",v),runtimeCaps.compile_modes||["default","reduce-overhead","max-autotune"]),
        runtimeField("Precision","select",config.precision,v=>update("precision",v),runtimeCaps.precisions||["auto","fp32","fp16","bf16"])
      );runtime.appendChild(runtimeGrid);main.appendChild(runtime);

      if(mode==="train"){
        const out=runtimeSection("Output");const grid=document.createElement("div");grid.className="mlb-runtime-grid";
        grid.append(runtimeField("Output Directory","text",config.output_dir,v=>update("output_dir",v)));out.appendChild(grid);main.appendChild(out);
      }

      const device=selectedRuntimeDevice(config);
      const summary=document.createElement("div");summary.className="mlb-runtime-summary";
      summary.innerHTML="<h3>Runtime Summary</h3>"+
        "<div><span>Device</span><strong>"+device.label+"</strong></div>"+
        "<div><span>Backend</span><strong>"+config.backend+"</strong></div>"+
        "<div><span>Execution</span><strong>"+config.execution_mode+"</strong></div>"+
        "<div><span>Compile</span><strong>"+(config.execution_mode==="compiled"?config.compile_mode:"Not used")+"</strong></div>"+
        "<div><span>Precision</span><strong>"+config.precision+"</strong></div>";
      side.appendChild(summary);

      if(mode==="train"){
        const valid=trainingConfigValid(entry,config);
        side.appendChild(compatibilityCard(valid.compat));
        if(!valid.ok){const errors=document.createElement("div");errors.className="mlb-runtime-errors";errors.innerHTML=valid.errors.map(x=>"<div>✕ "+x+"</div>").join("");side.appendChild(errors);}
        const start=btn("Start Training","mlb-runtime-start");start.disabled=!valid.ok||execution.status==="running";
        start.addEventListener("click",()=>{
          entry.training_status="starting";
          entry.training_history=[];
          // A new attempt must not display metrics left over from an older run.
          entry.training_live={
            status:"running",phase:"starting",overall:0,step:0,max_steps:entry.training_config?.max_steps??null,
            tokens_seen:0,tokens_per_sec:null,avg_tokens_per_sec:null,end_to_end_tokens_per_sec:null,avg_end_to_end_tokens_per_sec:null,loss:null,ppl:null,val_loss:null,val_ppl:null,
            memory_allocated_gb:null,memory_reserved_gb:null,memory_peak_gb:null,memory_total_gb:null,
            elapsed_seconds:null,compile_seconds:null,message:"Starting training in Python…"
          };
          runtimePanel={mode:"train",modelId:entry.id,tab:"status"};
          draw();
          setTimeout(()=>requestRuntimeCommand("train",entry),80);
        });side.appendChild(start);
        const stop=btn("Stop Training","mlb-runtime-stop");stop.disabled=execution.status!=="running";
        stop.addEventListener("click",requestStop);side.appendChild(stop);
      }else{
        const weights=document.createElement("div");weights.className="mlb-weight-status "+(entry.weights_ready?"ready":"missing");
        weights.textContent=entry.weights_ready?"✓ Model weights available":"✕ No trained/loaded weights yet";side.appendChild(weights);
        const start=btn("Generate Tokens","mlb-runtime-start");start.disabled=!entry.weights_ready||execution.status==="running";
        start.addEventListener("click",()=>{
          if(!entry.weights_ready)return;
          entry.generation_history=[];entry.generation_live={status:"running",phase:"starting",overall:0,generated_tokens:0,message:"Starting generation in Python…",generated_text:""};
          runtimePanel={mode:"generate",modelId:entry.id,tab:"status"};
          draw();
          setTimeout(()=>requestRuntimeCommand("generate",entry),80);
        });side.appendChild(start);
        const stop=btn("Stop Generation","mlb-runtime-stop");stop.disabled=execution.status!=="running";
        stop.addEventListener("click",requestStop);side.appendChild(stop);
      }

      const reset=btn("Reset Runtime Defaults","mlb-dark-btn");
      reset.addEventListener("click",()=>{
        const dataset=preparedDatasetById(entry?.selected_dataset_id)||null;
        if(mode==="train")entry.training_config=defaultTrainingConfig(entry,dataset);
        else entry.generation_config=defaultGenerationConfig(entry);
        setStatus((mode==="train"?"Training":"Generation")+" runtime settings reset to safe defaults.");
        draw();
      });
      side.appendChild(reset);

      const live=document.createElement("div");live.className="mlb-runtime-live "+(execution.status||"idle");
      live.innerHTML="<div class='mlb-runtime-live-head'><strong>RUNTIME</strong><span>"+Math.round(Number(execution.overall||0))+"%</span></div><div class='mlb-runtime-live-message'>"+(execution.runtime_kind===mode?(execution.message||"Ready"):"Ready")+"</div><div class='mlb-runtime-progress'><i style='width:"+(execution.runtime_kind===mode?Number(execution.overall||0):0)+"%'></i></div>";
      side.appendChild(live);
      const note=document.createElement("div");note.className="mlb-runtime-executor-note";
      note.textContent="Training uses packed fixed-shape causal-LM batches for both eager and compiled execution. Compiled mode captures one full model + LM-head + loss graph with fullgraph=True and dynamic=False. Supported training components include Embedding, Learned/Sinusoidal Position, ESA, StateAware ESA Stack, SOUP, RMSNorm/LayerNorm, Linear, FFN, Residual, Dropout, LM Head and custom components built from them.";side.appendChild(note);

      canvas.appendChild(outer);
    }


    function compatibilityCard(compat){
      const box=document.createElement("div");
      box.className="mlb-compat-card "+(compat.ok?"compatible":"incompatible");
      const head=document.createElement("div");head.className="mlb-compat-head";
      head.innerHTML="<strong>"+(compat.ok?"✓ Compatible":"✕ Not Compatible")+"</strong><span>"+(compat.ok?"Ready for training":"Fix the items below")+"</span>";
      box.appendChild(head);
      (compat.checks||[]).forEach(check=>{
        const row=document.createElement("div");row.className="mlb-compat-row "+(check.ok?"pass":"fail");
        row.innerHTML="<span>"+(check.ok?"✓":"✕")+" "+check.label+"</span><strong>"+check.detail+"</strong>";
        box.appendChild(row);
      });
      return box;
    }

    function renderBuiltModelInspector(body,entry){
      const dataset=preparedDatasetById(entry.selected_dataset_id)||null;
      const compat=modelDatasetCompatibility(entry,dataset);
      const req=entry.requirements||{};

      const head=document.createElement("div");head.className="mlb-selected";
      head.innerHTML="<strong>"+entry.name+"</strong><span class='mlb-pill'>Built Model</span>";
      body.appendChild(head);

      const built=document.createElement("div");built.className="mlb-api-status ok";
      built.textContent="✓ Build complete · revision "+(entry.revision||1);
      body.appendChild(built);

      detailSection(body,"MODEL DETAILS",[
        ["Status",entry.status||"built"],
        ["Layers",entry.nodes??"—"],
        ["Connections",entry.connections??"—"],
        ["Input",req.modality||"unknown"],
        ["Output",req.output_type||"unknown"],
        ["Parameters",entry.estimated_parameters??"—"],
        ["Built",entry.built_at||"—"],
      ]);

      renderModelSettings(body,entry);

      const dataTitle=document.createElement("div");dataTitle.className="mlb-section-title";dataTitle.textContent="TRAINING DATA";
      body.appendChild(dataTitle);

      const field=document.createElement("div");field.className="mlb-field";
      const label=document.createElement("label");label.textContent="Prepared Dataset";
      const select=document.createElement("select");
      select.className="mlb-training-data-select";
      const datasets=availablePreparedDatasets();
      if(!datasets.length){
        const o=document.createElement("option");o.value="";o.textContent="No prepared datasets available";
        select.appendChild(o);select.disabled=true;
      }else{
        const blank=document.createElement("option");blank.value="";blank.textContent="Select prepared dataset…";select.appendChild(blank);
        datasets.forEach(meta=>{
          const o=document.createElement("option");o.value=meta.id;
          o.textContent=meta.name;
          o.title=meta.name+" — "+compactDatasetSummary(meta);
          if(entry.selected_dataset_id===meta.id)o.selected=true;
          select.appendChild(o);
        });
        select.addEventListener("change",()=>setBuiltModelDataset(entry,select.value));
      }
      field.append(label,select);body.appendChild(field);

      const compTitle=document.createElement("div");compTitle.className="mlb-section-title";compTitle.textContent="COMPATIBILITY";
      body.appendChild(compTitle);
      body.appendChild(compatibilityCard(compat));

      if(dataset){
        body.appendChild(datasetSummaryCard(dataset,"SELECTED TRAINING DATA"));
      }

      const actionTitle=document.createElement("div");actionTitle.className="mlb-section-title";actionTitle.textContent="ACTIONS";
      body.appendChild(actionTitle);
      const actions=document.createElement("div");actions.className="mlb-model-actions";

      if(compat.ok && entry.status!=="needs_rebuild"){
        const train=btn("Train","mlb-train-btn");
        train.addEventListener("click",()=>requestBuiltModelTraining(entry,compat));
        actions.appendChild(train);
      }else{
        const blocked=document.createElement("div");blocked.className="mlb-train-blocked";
        blocked.textContent=entry.status==="needs_rebuild"
          ?"Model settings changed. Click Build before training."
          :"Train appears when the selected data is compatible.";
        actions.appendChild(blocked);
      }

      if(req.modality==="text"){
        const generate=btn(entry.weights_ready?"Generate Tokens":"Configure Generation","mlb-generate-btn");
        generate.title=entry.weights_ready
          ?"Open generation settings"
          :"Configure generation now; actual token generation needs trained/loaded weights";
        generate.addEventListener("click",()=>requestTokenGeneration(entry));
        actions.appendChild(generate);

        const serve=btn("Serve Model / API","mlb-serve-btn");
        serve.disabled=!entry.weights_ready;
        serve.title=entry.weights_ready
          ?"Create localhost, LAN, or public API links"
          :"Train or load model weights before serving";
        serve.addEventListener("click",()=>requestModelServing(entry));
        actions.appendChild(serve);
      }
      body.appendChild(actions);

      const note=document.createElement("div");note.className="mlb-runtime-note";
      note.textContent=entry.weights_ready
        ?"Weights are available. Train/Generation open the runtime workspace in the center."
        :"Train opens full runtime settings. Generation can be configured now, but token generation needs trained/loaded weights.";
      body.appendChild(note);
    }

    function dataStorageLabel(meta){
      if(meta.storage==="disk+memory")return "Memory + Disk";
      if(meta.storage==="disk")return "Disk";
      return "Memory";
    }

    function makeDirectoryEmpty(message,help){
      const empty=document.createElement("div");empty.className="mlb-output-empty";
      empty.innerHTML="<strong>"+message+"</strong><span>"+help+"</span>";
      return empty;
    }

    function useDatasetInModel(meta){
      if(!meta)return;
      checkpoint("Use "+meta.name+" in Model");
      autoBindDatasetToModel(meta);
      setStatus(meta.name+" selected for Model Builder Text Input.");
      draw();
    }

    function renderDataOutputDirectory(container){
      const entries=availablePreparedDatasets();
      const head=document.createElement("div");head.className="mlb-output-head";head.innerHTML="<div><strong>DATA REPOSITORY</strong><span>"+entries.length+" dataset"+(entries.length===1?"":"s")+" · processed, loaded and imported data</span></div>";container.appendChild(head);
      if(!entries.length){container.appendChild(makeDirectoryEmpty("No prepared datasets yet.","Run a Data Processing pipeline. Completed datasets will appear here automatically."));return;}
      const list=document.createElement("div");list.className="mlb-output-list compact";
      entries.forEach(meta=>{const card=document.createElement("div");card.className="mlb-output-entry compact"+(outputDirectorySelection===meta.id?" selected":"");const top=document.createElement("div");top.className="mlb-output-entry-top";const sourceLabel=meta.local_source?"Local Environment Data":dataStorageLabel(meta);top.innerHTML="<div class='mlb-output-name'><strong>"+meta.name+"</strong><span>"+sourceLabel+"</span></div><span class='mlb-output-type data'>DATA</span>";card.appendChild(top);const stats=document.createElement("div");stats.className="mlb-output-stats compact";[["train","Train"],["validation","Val"],["test","Test"]].forEach(([key,label])=>{if(meta.splits?.[key]){const item=document.createElement("div");item.innerHTML="<span>"+label+"</span><strong>"+splitRows(meta,key)+"</strong>";stats.appendChild(item);}});card.appendChild(stats);const foot=document.createElement("div");foot.className="mlb-output-compact-foot";foot.innerHTML="<span>"+(meta.total_rows??"?")+" rows</span><span>Details →</span>";card.appendChild(foot);card.addEventListener("click",()=>{outputDirectorySelection=meta.id;selected=null;inspectorTab="settings";setStatus(meta.name+" details opened.");draw();});list.appendChild(card);});container.appendChild(list);
    }

    function renderModelOutputDirectory(container){
      const entries=modelDirectoryEntries();
      const head=document.createElement("div");head.className="mlb-output-head";
      head.innerHTML="<div><strong>MODEL REPOSITORY</strong><span>"+entries.length+" model"+(entries.length===1?"":"s")+" · built, trained, loaded and imported models</span></div>";
      container.appendChild(head);

      if(!entries.length){
        container.appendChild(makeDirectoryEmpty(
          "No built model yet.",
          "Finish the architecture in Model Builder, then click Build."
        ));
        return;
      }

      const list=document.createElement("div");list.className="mlb-output-list compact";
      entries.forEach(entry=>{
        const card=document.createElement("div");
        card.className="mlb-output-entry compact"+(outputDirectorySelection===entry.id?" selected":"");

        const top=document.createElement("div");top.className="mlb-output-entry-top";
        const sourceLabel=entry.legacy_recovered
          ?"Recovered Legacy Checkpoint"
          :(entry.local_source?"Local Environment Model":"Built Model · r"+(entry.revision||1));
        top.innerHTML="<div class='mlb-output-name'><strong>"+entry.name+"</strong><span>"+sourceLabel+"</span></div>"+
          "<span class='mlb-output-type model'>"+(entry.legacy_recovered?"RECOVERED":"MODEL")+"</span>";
        card.appendChild(top);

        const stats=document.createElement("div");stats.className="mlb-output-stats compact model-three";
        [["Layers",entry.nodes??"—"],["Context",entry.context_length??"—"],["Batch",entry.batch_size??"—"]].forEach(([label,value])=>{
          const item=document.createElement("div");item.innerHTML="<span>"+label+"</span><strong>"+value+"</strong>";stats.appendChild(item);
        });
        card.appendChild(stats);

        const foot=document.createElement("div");foot.className="mlb-output-compact-foot";
        const ds=preparedDatasetById(entry.selected_dataset_id);
        foot.innerHTML="<span>"+(ds?ds.name:"No training data")+"</span><span>"+(entry.weights_ready?"Train / Generate / Serve →":"Train →")+"</span>";
        card.appendChild(foot);

        card.addEventListener("click",()=>{
          runtimePanel=null;
          outputDirectorySelection=entry.id;
          selected=null;inspectorTab="settings";
          setStatus(entry.name+" model details opened.");
          draw();
        });
        list.appendChild(card);
      });
      container.appendChild(list);
    }

    function renderOutputDirectory(container){
      container.className="mlb-output-directory";
      if(state.active_workspace==="data")renderDataOutputDirectory(container);
      else renderModelOutputDirectory(container);
    }

    function safeProjectStem(){
      return safeFilename(state.project?.name||"mlbricks-project");
    }

    function projectFileEntries(){
      const stem=safeProjectStem();
      const files=[
        {
          id:"design_json",
          name:stem+".mlbricks.json",
          category:"design",
          type:"Builder Design",
          location:"Browser download",
          description:"Complete MLBricks project: model graph, data graph, registries and settings."
        },
        {
          id:"design_bin",
          name:stem+".mlbricks.bin",
          category:"design",
          type:"Binary Design",
          location:"Browser download",
          description:"Binary Builder project file for Save BIN / Load."
        },
        {
          id:"model_config",
          name:stem+".model-config.json",
          category:"config",
          type:"Model Config",
          location:"Generated from Model Builder",
          description:"Current model architecture/configuration represented by the Model Builder graph."
        }
      ];

      availablePreparedDatasets().forEach(meta=>{
        files.push({
          id:"data_"+meta.id,
          name:meta.name,
          category:"data",
          type:"Prepared Dataset",
          location:meta.hub_repo_id ? ("HF: "+meta.hub_repo_id) : (meta.path || "Python memory"),
          path:meta.path || null,
          description:compactDatasetSummary(meta)+" · "+dataStorageLabel(meta),
          dataset_id:meta.id
        });
      });

      (state.model_outputs||[]).forEach((item,index)=>{
        files.push({
          id:"model_"+(item.id||index),
          name:item.name||("Model Artifact "+(index+1)),
          category:"model",
          type:item.format||item.kind||"Model Artifact",
          location:item.hub_repo_id ? ("HF: "+item.hub_repo_id) : (item.path||"Registered artifact"),
          path:item.path||null,
          description:item.dataset?("Dataset: "+item.dataset):"Trained/exported model artifact"
        });
      });

      (state.project_files||[]).forEach(item=>{
        if(!files.some(x=>x.id===item.id))files.push(cp(item));
      });
      return files;
    }

    function fileCategoryLabel(category){
      return category==="data"?"DATA":category==="model"?"MODEL":category==="config"?"CONFIG":"DESIGN";
    }

    function downloadModelConfig(){
      const model=modelRootComponent();
      if(!model)return;
      const config={
        format:"mlbricks-model-config",
        builder_version:"0.7.44",
        project:cp(state.project||{}),
        model:cp(model),
        selected_dataset:selectedModelDataset(),
      };
      const blob=new Blob([JSON.stringify(config,null,2)],{type:"application/json"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;a.download=safeProjectStem()+".model-config.json";
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      setStatus("Model config downloaded.");
    }

    function renderGalleryView(container){
      container.className="mlb-gallery-view";
      const head=document.createElement("div");head.className="mlb-gallery-head";
      const title=document.createElement("div");title.innerHTML="<strong>GALLERY</strong><span>Sample models and data, plus reusable designs saved by you.</span>";
      const saveLabel=state.active_workspace==="data"?"+ Save Current Data":"+ Save Current Model";
      head.appendChild(title);
      if(current(state)?.kind!=="custom_edit"){const save=btn(saveLabel,"mlb-gallery-save");save.addEventListener("click",saveCurrentToGallery);head.appendChild(save);}
      container.appendChild(head);

      const grid=document.createElement("div");grid.className="mlb-gallery-grid";
      const makeSection=(heading,countText,extraClass="")=>{
        const section=document.createElement("section");section.className="mlb-gallery-section"+(extraClass?" "+extraClass:"");
        const st=document.createElement("div");st.className="mlb-gallery-section-title";st.innerHTML="<strong>"+heading+"</strong><span>"+countText+"</span>";section.appendChild(st);return section;
      };
      const makeSampleCard=(name,meta,actionLabel,onLoad)=>{
        const card=document.createElement("div");card.className="mlb-gallery-card mlb-gallery-sample-card";
        const info=document.createElement("div");info.innerHTML="<strong>"+name+"</strong><span>"+meta+"</span>";
        const acts=document.createElement("div");const load=btn(actionLabel,"mlb-gallery-action sample");load.addEventListener("click",onLoad);acts.append(load);card.append(info,acts);return card;
      };

      // Built-in examples live only in Gallery so the canvas toolbar stays clean.
      // Add future examples to these registries rather than adding toolbar buttons.
      const builtInSampleModels=[
        {name:"TinyStories 30M",meta:"6 layers · Context 512 · Batch 16 · ~30M parameters",action:"Load Model",load:loadTinyStories},
        {name:"SOUP 30M 1L",meta:"1 SOUP layer · Context 512 · Batch 16 · 30,003,528 parameters",action:"Load Model",load:loadSOUP30M1L},
        {name:"StateAware ESA 200M",meta:"8 layers · Context 256 · Batch 16 · 199,982,344 parameters",action:"Load Model",load:loadStateAwareESA200M},
        {name:"SOUP 200M",meta:"3 SOUP layers · Context 256 · Batch 16 · 199,916,160 parameters",action:"Load Model",load:loadSOUP200M}
      ];
      const builtInSampleData=[
        {name:"TinyStories Text Pipeline",meta:"Hugging Face → Text Processing → Train 90% · Validation 5% · Test 5% → GPT-2 Tokenize → Prepared Dataset",action:"Load Pipeline",load:loadTextDataStarter}
      ];
      const sampleModels=makeSection("SAMPLE MODELS",builtInSampleModels.length+" built-in","sample");
      builtInSampleModels.forEach(item=>sampleModels.appendChild(makeSampleCard(item.name,item.meta,item.action,item.load)));
      const sampleData=makeSection("SAMPLE DATA",builtInSampleData.length+" built-in","sample");
      builtInSampleData.forEach(item=>sampleData.appendChild(makeSampleCard(item.name,item.meta,item.action,item.load)));

      const componentSection=makeSection("CUSTOM COMPONENTS",(state.gallery.components||[]).length+" saved");
      if(!(state.gallery.components||[]).length){const e=document.createElement("div");e.className="mlb-gallery-empty";e.textContent="Open a custom component and save it here for reuse.";componentSection.appendChild(e);}
      (state.gallery.components||[]).forEach(entry=>{
        const card=document.createElement("div");card.className="mlb-gallery-card";
        const meta=document.createElement("div");meta.innerHTML="<strong>"+entry.name+"</strong><span>"+((entry.definition?.nodes||[]).length)+" blocks · "+(entry.saved_at?new Date(entry.saved_at).toLocaleDateString():"Saved")+"</span>";
        const acts=document.createElement("div");const add=btn("Add to My Components","mlb-gallery-action");add.addEventListener("click",()=>addGalleryComponent(entry));const remove=btn("Remove","mlb-gallery-action danger");remove.addEventListener("click",()=>removeGalleryEntry("components",entry.id));acts.append(add,remove);card.append(meta,acts);componentSection.appendChild(card);
      });

      const modelSection=makeSection("MY MODELS",(state.gallery.models||[]).length+" saved");
      if(!(state.gallery.models||[]).length){const e=document.createElement("div");e.className="mlb-gallery-empty";e.textContent="Save your current Model Builder layout to keep it for later.";modelSection.appendChild(e);}
      (state.gallery.models||[]).forEach(entry=>{
        const card=document.createElement("div");card.className="mlb-gallery-card";
        const meta=document.createElement("div");meta.innerHTML="<strong>"+entry.name+"</strong><span>"+((entry.architecture?.nodes||[]).length)+" components · "+(entry.saved_at?new Date(entry.saved_at).toLocaleDateString():"Saved")+"</span>";
        const acts=document.createElement("div");const load=btn("Load to Canvas","mlb-gallery-action");load.addEventListener("click",()=>loadGalleryModel(entry));const remove=btn("Remove","mlb-gallery-action danger");remove.addEventListener("click",()=>removeGalleryEntry("models",entry.id));acts.append(load,remove);card.append(meta,acts);modelSection.appendChild(card);
      });

      const dataSection=makeSection("MY DATA PIPELINES",(state.gallery.data||[]).length+" saved");
      if(!(state.gallery.data||[]).length){const e=document.createElement("div");e.className="mlb-gallery-empty";e.textContent="Save a Data Processing pipeline here for reuse.";dataSection.appendChild(e);}
      (state.gallery.data||[]).forEach(entry=>{
        const card=document.createElement("div");card.className="mlb-gallery-card";
        const meta=document.createElement("div");meta.innerHTML="<strong>"+entry.name+"</strong><span>"+((entry.architecture?.nodes||[]).length)+" steps · "+(entry.saved_at?new Date(entry.saved_at).toLocaleDateString():"Saved")+"</span>";
        const acts=document.createElement("div");const load=btn("Load Pipeline","mlb-gallery-action");load.addEventListener("click",()=>loadGalleryData(entry));const remove=btn("Remove","mlb-gallery-action danger");remove.addEventListener("click",()=>removeGalleryEntry("data",entry.id));acts.append(load,remove);card.append(meta,acts);dataSection.appendChild(card);
      });

      grid.append(sampleModels,sampleData,componentSection,modelSection,dataSection);container.appendChild(grid);
      const note=document.createElement("div");note.className="mlb-gallery-note";note.textContent="Built-in samples stay available in Gallery. Your saved items are stored in the Builder project and mirrored to browser storage when available.";container.appendChild(note);
    }


    function renderCentralGallery(canvas){
      canvas.classList.add("gallery-active");
      const outer=document.createElement("div");outer.className="mlb-central-gallery";

      const head=document.createElement("div");head.className="mlb-gallery-page-head";
      const copy=document.createElement("div");copy.className="mlb-gallery-page-copy";
      copy.innerHTML="<strong>GALLERY</strong><span>Prebuilt MLBricks models, reusable components, data pipelines, and your saved designs.</span>";
      const close=btn("×","mlb-gallery-page-close");close.title="Close Gallery";close.addEventListener("click",closeGallery);
      head.append(copy,close);outer.appendChild(head);

      const tabsRow=document.createElement("div");tabsRow.className="mlb-gallery-tabs-row";
      const tabs=document.createElement("div");tabs.className="mlb-central-gallery-tabs";
      [["models","Models"],["components","Components"],["data","Data"]].forEach(([key,label])=>{
        const b=btn(label,"mlb-central-gallery-tab"+(galleryWorkspace.tab===key?" active":""));
        b.addEventListener("click",()=>{galleryWorkspace.tab=key;draw();});tabs.appendChild(b);
      });
      tabsRow.appendChild(tabs);

      const galleryActions=document.createElement("div");galleryActions.className="mlb-gallery-page-actions";
      const galleryLoad=btn("⇧ Load","mlb-gallery-action mlb-gallery-file-action");
      galleryLoad.title="Load .mlbricks.json or .mlbricks.bin";galleryLoad.addEventListener("click",loadDesign);galleryActions.appendChild(galleryLoad);
      const galleryExport=btn("⇩ Export","mlb-gallery-action mlb-gallery-file-action");
      galleryExport.title="Export model config or workspace data";galleryExport.addEventListener("click",exportWorkspace);galleryActions.appendChild(galleryExport);

      let canSave=false,saveLabel="";
      if(galleryWorkspace.tab==="models"&&state.active_workspace==="model"&&current(state)?.kind!=="custom_edit"){canSave=true;saveLabel="+ Save Current Model";}
      if(galleryWorkspace.tab==="data"&&state.active_workspace==="data"){canSave=true;saveLabel="+ Save Current Data";}
      if(canSave){const save=btn(saveLabel,"mlb-gallery-save mlb-gallery-page-save");save.addEventListener("click",saveCurrentToGallery);galleryActions.appendChild(save);}
      tabsRow.appendChild(galleryActions);
      outer.appendChild(tabsRow);

      // Only this content region scrolls. The banner and tabs never shrink.
      const body=document.createElement("div");body.className="mlb-central-gallery-body";
      const makeSection=(heading,countText,kind="")=>{
        const s=document.createElement("section");s.className="mlb-central-gallery-section"+(kind?" "+kind:"");
        const sh=document.createElement("div");sh.className="mlb-central-gallery-section-head";
        sh.innerHTML="<strong>"+heading+"</strong><span>"+countText+"</span>";s.appendChild(sh);return s;
      };
      const empty=(text)=>{const e=document.createElement("div");e.className="mlb-central-gallery-empty";e.textContent=text;return e;};
      const card=(name,meta,tag,actions)=>{
        const c=document.createElement("div");c.className="mlb-central-gallery-card";
        const icon=document.createElement("div");icon.className="mlb-central-gallery-icon";icon.textContent=tag;
        const info=document.createElement("div");info.className="mlb-central-gallery-card-info";
        const title=document.createElement("strong");title.textContent=name;
        const detail=document.createElement("span");detail.textContent=meta||"";
        info.append(title,detail);
        const acts=document.createElement("div");acts.className="mlb-central-gallery-card-actions";(actions||[]).forEach(a=>acts.appendChild(a));
        c.append(icon,info,acts);return c;
      };
      const modelMeta=(entry)=>{
        const p=entry?.project||{};
        const parts=[];
        const params=p.estimated_parameters||entry?.estimated_parameters;
        const batch=p.batch_size||entry?.batch_size;
        const block=p.context_length||entry?.context_length;
        if(params)parts.push("Parameters "+params);
        if(batch)parts.push("Batch "+batch);
        if(block)parts.push("Block "+block);
        const count=(entry?.architecture?.nodes||[]).length;
        if(count)parts.push(count+" components");
        if(!parts.length)parts.push(entry?.saved_at?"Saved "+new Date(entry.saved_at).toLocaleDateString():"Saved model");
        return parts.join(" · ");
      };
      const openAndClose=(fn)=>()=>{galleryWorkspace.open=false;bottomExpanded=galleryPreviousBottomExpanded;fn();};

      if(galleryWorkspace.tab==="models"){
        body.classList.add("models-tab");
        const samples=makeSection("PREBUILT MODELS","4 available","featured full-width");
        const sampleGrid=document.createElement("div");sampleGrid.className="mlb-central-gallery-card-grid prebuilt-grid";
        const loadTiny=btn("Open Model","mlb-gallery-action sample");loadTiny.addEventListener("click",openAndClose(loadTinyStories));
        sampleGrid.appendChild(card("TinyStories 30M","Parameters ~30M · Batch 16 · Block 512 · 6 layers","MODEL",[loadTiny]));
        const loadSoup30=btn("Open Model","mlb-gallery-action sample");loadSoup30.addEventListener("click",openAndClose(loadSOUP30M1L));
        sampleGrid.appendChild(card("SOUP 30M 1L","Parameters 30,003,528 · Batch 16 · Block 512 · 1 SOUP layer","MODEL",[loadSoup30]));
        const loadEsa200=btn("Open Model","mlb-gallery-action sample");loadEsa200.addEventListener("click",openAndClose(loadStateAwareESA200M));
        sampleGrid.appendChild(card("StateAware ESA 200M","Parameters 199,982,344 · Batch 16 · Block 256 · 8 layers","MODEL",[loadEsa200]));
        const loadSoup200=btn("Open Model","mlb-gallery-action sample");loadSoup200.addEventListener("click",openAndClose(loadSOUP200M));
        sampleGrid.appendChild(card("SOUP 200M","Parameters 199,916,160 · Batch 16 · Block 256 · 3 SOUP layers","MODEL",[loadSoup200]));
        samples.appendChild(sampleGrid);
        body.appendChild(samples);

        const mine=makeSection("MY MODELS",(state.gallery.models||[]).length+" saved","full-width saved-models");
        if(!(state.gallery.models||[]).length){mine.appendChild(empty("Models you save to Gallery will appear here."));}
        else{
          const savedGrid=document.createElement("div");savedGrid.className="mlb-central-gallery-card-grid saved-model-grid";
          (state.gallery.models||[]).forEach(entry=>{
            const load=btn("Open","mlb-gallery-action");load.addEventListener("click",openAndClose(()=>loadGalleryModel(entry)));
            const remove=btn("Remove","mlb-gallery-action danger");remove.addEventListener("click",()=>removeGalleryEntry("models",entry.id));
            savedGrid.appendChild(card(entry.name,modelMeta(entry),"MODEL",[load,remove]));
          });
          mine.appendChild(savedGrid);
        }
        body.appendChild(mine);
      }else if(galleryWorkspace.tab==="components"){
        body.classList.add("components-tab");
        const samples=makeSection("CREATE COMPONENT","Choose a component type","featured full-width compact-create");
        const createActions=document.createElement("div");createActions.className="mlb-gallery-component-create-actions";
        const createApi=btn("API Component","mlb-gallery-action sample mlb-gallery-create-small");createApi.title="Bind Mamba, Flash Attention, torch.nn modules, or another Python/PyTorch API";createApi.addEventListener("click",createAPICustom);
        const createVisual=btn("Component","mlb-gallery-action mlb-gallery-create-small");createVisual.title="Compose a reusable component from the Component Library";createVisual.addEventListener("click",()=>{galleryWorkspace.open=false;bottomExpanded=galleryPreviousBottomExpanded;createCustom();});
        createActions.append(createApi,createVisual);
        samples.appendChild(createActions);body.appendChild(samples);

        const mine=makeSection("CUSTOM COMPONENTS",(state.gallery.components||[]).length+" saved","full-width saved-components");
        if(!(state.gallery.components||[]).length)mine.appendChild(empty("Custom components you save to Gallery will appear here."));
        else{
          const savedGrid=document.createElement("div");savedGrid.className="mlb-central-gallery-card-grid saved-component-grid";
          (state.gallery.components||[]).forEach(entry=>{
            const add=btn("Add to My Components","mlb-gallery-action");add.addEventListener("click",()=>addGalleryComponent(entry));
            const remove=btn("Remove","mlb-gallery-action danger");remove.addEventListener("click",()=>removeGalleryEntry("components",entry.id));
            const apiDef=String(entry.definition?.implementation||"graph")==="api";
            const detail=apiDef?(String(entry.definition?.api_binding?.import_path||"API not bound")):(((entry.definition?.nodes||[]).length)+" components");
            savedGrid.appendChild(card(entry.name,detail+" · "+(entry.saved_at?new Date(entry.saved_at).toLocaleDateString():"Saved"),apiDef?"API":"COMP",[add,remove]));
          });
          mine.appendChild(savedGrid);
        }
        body.appendChild(mine);
      }else{
        body.classList.add("data-tab");
        const samples=makeSection("PREBUILT DATA","1 available","featured full-width");
        const load=btn("Open Pipeline","mlb-gallery-action sample");load.addEventListener("click",openAndClose(loadTextDataStarter));
        const sampleGrid=document.createElement("div");sampleGrid.className="mlb-central-gallery-card-grid prebuilt-grid";
        sampleGrid.appendChild(card("TinyStories Text Pipeline","Hugging Face → Text Processing → Train 90% · Validation 5% · Test 5% → GPT-2 Tokenize → Prepared Dataset","DATA",[load]));
        samples.appendChild(sampleGrid);
        body.appendChild(samples);

        const mine=makeSection("MY DATA",(state.gallery.data||[]).length+" saved","full-width saved-data");
        if(!(state.gallery.data||[]).length)mine.appendChild(empty("Data pipelines you save to Gallery will appear here."));
        else{
          const savedGrid=document.createElement("div");savedGrid.className="mlb-central-gallery-card-grid saved-data-grid";
          (state.gallery.data||[]).forEach(entry=>{
            const load=btn("Open","mlb-gallery-action");load.addEventListener("click",openAndClose(()=>loadGalleryData(entry)));
            const remove=btn("Remove","mlb-gallery-action danger");remove.addEventListener("click",()=>removeGalleryEntry("data",entry.id));
            savedGrid.appendChild(card(entry.name,((entry.architecture?.nodes||[]).length)+" steps · "+(entry.saved_at?new Date(entry.saved_at).toLocaleDateString():"Saved"),"DATA",[load,remove]));
          });
          mine.appendChild(savedGrid);
        }
        body.appendChild(mine);
      }

      outer.appendChild(body);canvas.appendChild(outer);
    }

    function renderCentralCloud(canvas){
      canvas.classList.add("gallery-active","cloud-active");
      const outer=document.createElement("div");outer.className="mlb-central-cloud";
      const head=document.createElement("div");head.className="mlb-cloud-page-head";
      const copy=document.createElement("div");copy.className="mlb-cloud-page-copy";
      copy.innerHTML="<strong>CLOUD & REPOSITORIES</strong><span>Connect providers, push or load models, datasets, reusable components, and projects.</span>";
      const close=btn("×","mlb-gallery-page-close");close.title="Close Cloud & Repositories";close.addEventListener("click",closeCloudWorkspace);
      head.append(copy,close);outer.appendChild(head);
      const body=document.createElement("div");body.className="mlb-central-cloud-body";
      renderCloudView(body,false);
      outer.appendChild(body);canvas.appendChild(outer);
    }

    function renderLocalView(container){
      container.className="mlb-local-view";
      const importingData=state.active_workspace==="data";
      const kind=importingData?"data":"model";
      const report=localImportReports[kind];
      const pathKey=importingData?"data_path":"model_path";
      const action=importingData?"local_import_data":"local_import_models";

      const head=document.createElement("div");head.className="mlb-local-head";
      const copyHead=document.createElement("div");
      copyHead.innerHTML=importingData
        ?"<strong>LOCAL ENVIRONMENT DATA IMPORT</strong><span>Detected "+localEnvironment.name+". Base Path starts at the current workspace root. Builder can also scan other available environment roots.</span>"
        :"<strong>LOCAL ENVIRONMENT MODEL IMPORT</strong><span>Detected "+localEnvironment.name+". Base Path starts at the current workspace root. Builder can also scan other available environment roots.</span>";
      const badge=document.createElement("span");badge.className="mlb-local-badge";badge.textContent=String(localEnvironment.name||"AUTO").toUpperCase();
      head.append(copyHead,badge);container.appendChild(head);

      const box=document.createElement("div");box.className="mlb-local-auto-box";
      const field=document.createElement("div");field.className="mlb-local-field";
      const label=document.createElement("label");label.textContent="Base Path";field.appendChild(label);
      const input=document.createElement("input");
      input.value=localForm[pathKey]||localDefaultRoot;
      input.placeholder=localDefaultRoot;
      input.addEventListener("input",()=>localForm[pathKey]=input.value);
      field.appendChild(input);

      const button=btn(importingData?"Scan Current Data":"Scan Current Models","mlb-local-load");
      button.addEventListener("click",()=>{
        const path=String(localForm[pathKey]||localDefaultRoot).trim()||localDefaultRoot;
        requestLocalCommand(action,{path,max_depth:12,max_entries:1000});
      });
      const pathButton=btn("Scan This Path","mlb-local-load secondary");
      pathButton.addEventListener("click",()=>{
        const path=String(localForm[pathKey]||"").trim();
        if(!path){setStatus("Enter a local environment directory path.");return;}
        requestLocalCommand(action,{path,max_depth:12,max_entries:1000});
      });
      const buttons=document.createElement("div");buttons.className="mlb-local-scan-actions";buttons.append(button,pathButton);
      box.append(field,buttons);container.appendChild(box);

      const examples=document.createElement("div");examples.className="mlb-local-path-examples";
      const quickPaths=[localDefaultRoot,...(localEnvironment.roots||[])].filter((value,index,array)=>value&&array.indexOf(value)===index);
      quickPaths.forEach(value=>{
        const chip=document.createElement("button");chip.textContent=value;
        chip.addEventListener("click",()=>{localForm[pathKey]=value;draw();});
        examples.appendChild(chip);
      });
      container.appendChild(examples);

      const flow=document.createElement("div");flow.className="mlb-local-flow";
      flow.innerHTML=importingData
        ?"<span>1</span><strong>Path</strong><i>→</i><span>2</span><strong>Recursive Scan</strong><i>→</i><span>3</span><strong>Detect Data</strong><i>→</i><span>4</span><strong>Data Repository</strong>"
        :"<span>1</span><strong>Path</strong><i>→</i><span>2</span><strong>Recursive Scan</strong><i>→</i><span>3</span><strong>Detect Models</strong><i>→</i><span>4</span><strong>Model Repository</strong>";
      container.appendChild(flow);

      if(report){
        const panel=document.createElement("div");panel.className="mlb-local-report";
        const rh=document.createElement("div");rh.className="mlb-local-report-head";
        rh.innerHTML="<strong>LAST IMPORT</strong><span>"+(report.root||"")+"</span>";
        panel.appendChild(rh);

        const stats=document.createElement("div");stats.className="mlb-local-report-stats";
        [["Found",report.found||0],["Imported",report.imported_count||0],["Skipped",report.skipped_count||0],["Errors",report.error_count||0]].forEach(([name,value])=>{
          const item=document.createElement("div");item.innerHTML="<span>"+name+"</span><strong>"+value+"</strong>";stats.appendChild(item);
        });
        panel.appendChild(stats);

        const imported=report.imported||[];
        if(imported.length){
          const list=document.createElement("div");list.className="mlb-local-imported-list";
          imported.forEach(item=>{
            const row=document.createElement("div");
            const title=item.name||(importingData?"Imported Dataset":"Imported Model");
            const path=item.local_path||item.checkpoint_path||item.path||"";
            const badgeText=(!importingData&&item.legacy_recovered)?"RECOVERED":"IMPORTED";
            row.innerHTML="<div><strong>"+title+"</strong><span>"+path+"</span></div><b>"+badgeText+"</b>";
            list.appendChild(row);
          });
          panel.appendChild(list);
        }

        if((report.errors||[]).length){
          const details=document.createElement("details");details.className="mlb-local-errors";
          const summary=document.createElement("summary");
          summary.textContent=report.errors.length+" incompatible "+(importingData?"data item":"checkpoint")+(report.errors.length===1?"":"s");
          details.appendChild(summary);
          report.errors.forEach(item=>{
            const row=document.createElement("div");
            row.innerHTML="<strong>"+item.path+"</strong><span>"+item.error+"</span>";
            details.appendChild(row);
          });
          panel.appendChild(details);
        }
        container.appendChild(panel);
      }

      const note=document.createElement("div");note.className="mlb-local-note";
      note.innerHTML=importingData
        ?"<strong>Environment-aware.</strong> Builder recursively detects Hugging Face <code>save_to_disk()</code> folders, <code>.txt</code>, <code>.csv</code>, <code>.json</code>, <code>.jsonl</code>, <code>.parquet</code>, <code>.arrow</code> and MLBricks dataset bundles. Duplicate paths are ignored. Imported datasets are added automatically to <strong>Data Repository</strong>."
        :"<strong>Environment-aware.</strong> Builder recursively detects <code>last.pt</code>, <code>.pt</code>, <code>.pth</code>, <code>.ckpt</code> and MLBricks model bundles. Duplicate paths are ignored. Imported models are added automatically to <strong>Model Repository</strong>.";
      container.appendChild(note);
    }


    function cloudArtifactOptions(type){
      if(type==="dataset"){
        return availablePreparedDatasets().map(x=>({id:x.id,name:x.name,detail:compactDatasetSummary(x)}));
      }
      if(type==="model"){
        return modelDirectoryEntries().map(x=>({
          id:x.id,name:x.name,detail:x.weights_ready?"Trained weights ready":"Architecture / build"
        }));
      }
      return [{id:"project",name:state.project?.name||"Current Project",detail:"Complete Builder project"}];
    }

    function cloudField(label,type,value,placeholder,onChange,secret=false){
      const field=document.createElement("div");field.className="mlb-cloud-field";
      const l=document.createElement("label");l.textContent=label;field.appendChild(l);
      let input;
      if(type==="textarea"){
        input=document.createElement("textarea");
        input.rows=3;
      }else{
        input=document.createElement("input");
        input.type=secret?"password":(type||"text");
      }
      input.value=value||"";
      input.placeholder=placeholder||"";
      input.autocomplete="off";
      input.addEventListener("input",()=>onChange(input.value));
      field.appendChild(input);
      return field;
    }

    function cloudSelect(label,value,options,onChange){
      const field=document.createElement("div");field.className="mlb-cloud-field";
      const l=document.createElement("label");l.textContent=label;field.appendChild(l);
      const select=document.createElement("select");
      options.forEach(item=>{
        const v=typeof item==="object"?item.value:item;
        const text=typeof item==="object"?item.label:item;
        const o=document.createElement("option");o.value=v;o.textContent=text;
        if(String(v)===String(value))o.selected=true;
        select.appendChild(o);
      });
      select.addEventListener("change",()=>onChange(select.value));
      field.appendChild(select);return field;
    }

    function providerLabel(provider){
      return {
        huggingface:"Hugging Face",
        github:"GitHub",
        aws:"AWS S3",
        gcp:"Google Cloud Storage",
        azure:"Azure Blob Storage"
      }[provider]||provider;
    }

    function renderProviderCredentials(card){
      const p=cloudForm.provider;
      const title=document.createElement("div");title.className="mlb-cloud-subtitle";
      title.textContent="🔑  SESSION CREDENTIALS";card.appendChild(title);

      if(p==="huggingface"){
        card.appendChild(cloudField(
          "API Token / Access Token","text",cloudSecrets.huggingface.token,
          "hf_...  (optional if already logged in)",
          v=>cloudSecrets.huggingface.token=v,true
        ));
      }else if(p==="github"){
        card.appendChild(cloudField(
          "GitHub Personal Access Token","text",cloudSecrets.github.token,
          "github_pat_... / ghp_...",
          v=>cloudSecrets.github.token=v,true
        ));
      }else if(p==="aws"){
        const grid=document.createElement("div");grid.className="mlb-cloud-mini-grid";
        grid.append(
          cloudField("Access Key ID","text",cloudSecrets.aws.access_key,"AKIA...",v=>cloudSecrets.aws.access_key=v,true),
          cloudField("Secret Access Key","text",cloudSecrets.aws.secret_key,"••••••",v=>cloudSecrets.aws.secret_key=v,true)
        );
        card.appendChild(grid);
        card.appendChild(cloudField(
          "Session Token (optional)","text",cloudSecrets.aws.session_token,"Temporary session token",
          v=>cloudSecrets.aws.session_token=v,true
        ));
      }else if(p==="gcp"){
        card.appendChild(cloudField(
          "Service Account JSON","textarea",cloudSecrets.gcp.service_account_json,
          '{"type":"service_account", ...}  (blank = Application Default Credentials)',
          v=>cloudSecrets.gcp.service_account_json=v,true
        ));
      }else if(p==="azure"){
        card.appendChild(cloudField(
          "Connection String","textarea",cloudSecrets.azure.connection_string,
          "DefaultEndpointsProtocol=...;AccountName=...;AccountKey=...",
          v=>cloudSecrets.azure.connection_string=v,true
        ));
      }

      const note=document.createElement("div");note.className="mlb-cloud-secret-note";
      note.textContent="Session only · masked · never included in Save JSON, BIN, model, dataset, or project metadata.";
      card.appendChild(note);
    }

    function currentCloudCredentials(){
      const p=cloudForm.provider;
      if(p==="huggingface")return {token:cloudSecrets.huggingface.token};
      if(p==="github")return {token:cloudSecrets.github.token};
      if(p==="aws")return {
        access_key:cloudSecrets.aws.access_key,
        secret_key:cloudSecrets.aws.secret_key,
        session_token:cloudSecrets.aws.session_token,
        region:cloudForm.region
      };
      if(p==="gcp")return {service_account_json:cloudSecrets.gcp.service_account_json};
      if(p==="azure")return {connection_string:cloudSecrets.azure.connection_string};
      return {};
    }

    function providerTargetFields(card){
      const p=cloudForm.provider;
      if(p==="huggingface"){
        card.appendChild(cloudField("Repository ID","text",cloudForm.repo,"username-or-org/repo-name",v=>cloudForm.repo=v));
        card.appendChild(cloudField("Revision","text",cloudForm.revision,"main",v=>cloudForm.revision=v));
      }else if(p==="github"){
        card.appendChild(cloudField("Repository","text",cloudForm.repo,"owner/repository",v=>cloudForm.repo=v));
        const grid=document.createElement("div");grid.className="mlb-cloud-mini-grid";
        grid.append(
          cloudField("Branch","text",cloudForm.branch,"main",v=>cloudForm.branch=v),
          cloudField("File Path","text",cloudForm.object_path,"mlbricks/project.mlbricks.zip",v=>cloudForm.object_path=v)
        );
        card.appendChild(grid);
      }else if(p==="aws"||p==="gcp"){
        const grid=document.createElement("div");grid.className="mlb-cloud-mini-grid";
        grid.append(
          cloudField("Bucket","text",cloudForm.bucket,"my-mlbricks-bucket",v=>cloudForm.bucket=v),
          cloudField(p==="aws"?"Object Key":"Object Name","text",cloudForm.object_path,"models/model.mlbricks.zip",v=>cloudForm.object_path=v)
        );
        card.appendChild(grid);
        if(p==="aws"){
          card.appendChild(cloudField("Region","text",cloudForm.region,"us-east-1",v=>cloudForm.region=v));
        }
      }else if(p==="azure"){
        const grid=document.createElement("div");grid.className="mlb-cloud-mini-grid";
        grid.append(
          cloudField("Container","text",cloudForm.container,"mlbricks",v=>cloudForm.container=v),
          cloudField("Blob Name","text",cloudForm.object_path,"models/model.mlbricks.zip",v=>cloudForm.object_path=v)
        );
        card.appendChild(grid);
      }
    }

    function cloudCommandConfig(contentType,artifactId){
      return {
        provider:cloudForm.provider,
        content_type:contentType,
        artifact_id:artifactId,
        repo:cloudForm.repo,
        branch:cloudForm.branch||"main",
        revision:cloudForm.revision||"main",
        bucket:cloudForm.bucket,
        container:cloudForm.container,
        object_path:cloudForm.object_path,
        region:cloudForm.region,
        private:!!cloudForm.private,
        credentials:currentCloudCredentials()
      };
    }

    function renderCloudView(container,showHead=true){
      container.classList.add("mlb-cloud-view");
      if(showHead){
        const head=document.createElement("div");head.className="mlb-cloud-head";
        head.innerHTML="<div><strong>CLOUD & REPOSITORIES</strong><span>Push and load Builder data, models and projects</span></div><span class='mlb-cloud-badge'>CLOUD</span>";
        container.appendChild(head);
      }

      const providerCard=document.createElement("section");providerCard.className="mlb-cloud-card mlb-cloud-provider-card";
      const providerTitle=document.createElement("div");providerTitle.className="mlb-cloud-section-title";providerTitle.innerHTML="<span>☁</span><strong>PROVIDER & CONNECTION</strong>";providerCard.appendChild(providerTitle);
      const providerBar=document.createElement("div");providerBar.className="mlb-cloud-provider-bar";
      const providerField=cloudSelect("Provider",cloudForm.provider,[
        {value:"huggingface",label:"Hugging Face"},{value:"github",label:"GitHub"},{value:"aws",label:"AWS S3"},{value:"gcp",label:"Google Cloud Storage"},{value:"azure",label:"Azure Blob Storage"}
      ],v=>{cloudForm.provider=v;cloudStatus[v]=cloudStatus[v]||{};draw();});
      const status=cloudStatus[cloudForm.provider]||{};
      const connectionField=document.createElement("div");connectionField.className="mlb-cloud-field mlb-cloud-connection-field";
      const connectionLabel=document.createElement("label");connectionLabel.textContent="Connection";
      const indicator=document.createElement("div");indicator.className="mlb-cloud-status "+(status.ok||status.authenticated?"ok":status.message?"warn":"idle");
      const connectionText=document.createElement("span");connectionText.textContent=status.message||providerLabel(cloudForm.provider)+" · not checked";
      indicator.appendChild(connectionText);connectionField.append(connectionLabel,indicator);
      const check=btn("Check Connection","mlb-cloud-check");check.addEventListener("click",()=>requestCloudCommand("cloud_status",{provider:cloudForm.provider,credentials:currentCloudCredentials(),region:cloudForm.region}));
      providerBar.append(providerField,connectionField,check);providerCard.appendChild(providerBar);container.appendChild(providerCard);

      const credentials=document.createElement("section");credentials.className="mlb-cloud-card credentials";
      renderProviderCredentials(credentials);container.appendChild(credentials);

      const grid=document.createElement("div");grid.className="mlb-cloud-grid";
      const push=document.createElement("section");push.className="mlb-cloud-card";
      const pt=document.createElement("div");pt.className="mlb-cloud-card-title";pt.innerHTML="<strong>↑ PUSH</strong><span>Send local Builder content to "+providerLabel(cloudForm.provider)+"</span>";push.appendChild(pt);
      push.appendChild(cloudSelect("Content Type",cloudForm.push_type,[{value:"dataset",label:"Prepared Dataset"},{value:"model",label:"Built / Trained Model"},{value:"project",label:"Builder Project"}],v=>{cloudForm.push_type=v;cloudForm.push_artifact="";draw();}));
      const artifacts=cloudArtifactOptions(cloudForm.push_type);if(!cloudForm.push_artifact&&artifacts.length)cloudForm.push_artifact=artifacts[0].id;
      push.appendChild(cloudSelect("Local Content",cloudForm.push_artifact,artifacts.length?artifacts.map(x=>({value:x.id,label:x.name+" — "+x.detail})):[{value:"",label:"Nothing available yet"}],v=>cloudForm.push_artifact=v));
      providerTargetFields(push);
      if(cloudForm.provider==="huggingface"){
        const privacy=document.createElement("label");privacy.className="mlb-cloud-private";const box=document.createElement("input");box.type="checkbox";box.checked=!!cloudForm.private;box.addEventListener("change",()=>cloudForm.private=box.checked);
        const text=document.createElement("span");text.innerHTML="<strong>Private repository</strong><small>Uncheck to publish publicly</small>";privacy.append(box,text);push.appendChild(privacy);
      }
      const pushBtn=btn("↑ Push","mlb-cloud-primary");pushBtn.disabled=!artifacts.length;pushBtn.addEventListener("click",()=>requestCloudCommand("cloud_push",cloudCommandConfig(cloudForm.push_type,cloudForm.push_artifact)));push.appendChild(pushBtn);grid.appendChild(push);

      const load=document.createElement("section");load.className="mlb-cloud-card";
      const lt=document.createElement("div");lt.className="mlb-cloud-card-title";lt.innerHTML="<strong>↓ LOAD</strong><span>Restore content from "+providerLabel(cloudForm.provider)+"</span>";load.appendChild(lt);
      load.appendChild(cloudSelect("Content Type",cloudForm.load_type,[{value:"dataset",label:"Prepared Dataset"},{value:"model",label:"MLBricks Builder Model"},{value:"project",label:"Builder Project"}],v=>cloudForm.load_type=v));
      providerTargetFields(load);const loadBtn=btn("↓ Load","mlb-cloud-primary secondary");loadBtn.addEventListener("click",()=>requestCloudCommand("cloud_load",cloudCommandConfig(cloudForm.load_type,null)));load.appendChild(loadBtn);grid.appendChild(load);
      container.appendChild(grid);
    }


    function renderFilesView(container){
      container.className="mlb-files-view";

      const head=document.createElement("div");head.className="mlb-files-head";
      const title=document.createElement("div");
      title.innerHTML="<strong>PROJECT FILES</strong><span>Data, model, config and design files in one place</span>";
      const filters=document.createElement("div");filters.className="mlb-files-filters";
      [["all","All"],["data","Data"],["model","Models"],["config","Config"],["design","Design"]].forEach(([value,label])=>{
        const button=btn(label,"mlb-file-filter"+(filesFilter===value?" active":""));
        button.addEventListener("click",()=>{filesFilter=value;draw();});
        filters.appendChild(button);
      });
      head.append(title,filters);container.appendChild(head);

      const entries=projectFileEntries().filter(item=>filesFilter==="all"||item.category===filesFilter);
      if(!entries.length){
        container.appendChild(makeDirectoryEmpty(
          "No files in this category yet.",
          "Run data processing or create/export a model artifact and it will appear here."
        ));
        return;
      }

      const table=document.createElement("div");table.className="mlb-files-table";
      const header=document.createElement("div");header.className="mlb-files-row header";
      header.innerHTML="<span>Name</span><span>Type</span><span>Location</span><span>Actions</span>";
      table.appendChild(header);

      entries.forEach(item=>{
        const row=document.createElement("div");row.className="mlb-files-row";
        const name=document.createElement("div");name.className="mlb-file-name";
        name.innerHTML="<strong>"+item.name+"</strong><span>"+(item.description||"")+"</span>";
        const type=document.createElement("div");
        type.innerHTML="<span class='mlb-file-type "+item.category+"'>"+fileCategoryLabel(item.category)+"</span><small>"+(item.type||"File")+"</small>";
        const location=document.createElement("div");location.className="mlb-file-location";
        location.textContent=item.location||item.path||"—";
        location.title=item.location||item.path||"";

        const actions=document.createElement("div");actions.className="mlb-file-actions";
        if(item.id==="design_json"){
          const a=btn("Save JSON","mlb-file-action");a.addEventListener("click",saveDesign);actions.appendChild(a);
        }else if(item.id==="design_bin"){
          const a=btn("Save BIN","mlb-file-action");a.addEventListener("click",saveDesignBin);actions.appendChild(a);
        }else if(item.id==="model_config"){
          const a=btn("Download","mlb-file-action");a.addEventListener("click",downloadModelConfig);actions.appendChild(a);
        }else if(item.category==="data" && item.dataset_id){
          const meta=preparedDatasetById(item.dataset_id);
          const a=btn("Use in Model","mlb-file-action");
          a.addEventListener("click",()=>useDatasetInModel(meta));actions.appendChild(a);
        }

        row.append(name,type,location,actions);
        table.appendChild(row);
      });
      container.appendChild(table);
    }

    function currentDataPipelineSnapshot(){
      const ws=state.workspaces?.data;
      const comp=state.components?.[ws?.root_component_id];
      const snap={source:null,text_processing:null,split:null,tokenizer:null,image_processing:null,audio_processing:null,batch:null,output:null,steps:[]};
      if(!comp)return snap;
      const sourceTypes=new Set(["manual_dataset","hf_dataset","kaggle_dataset","url_dataset","local_dataset"]);
      (comp.nodes||[]).forEach(node=>{
        const value={type:node.type,name:node.name,...cp(node.params||{})};
        snap.steps.push({id:node.id,type:node.type,name:node.name,params:cp(node.params||{})});
        if(sourceTypes.has(node.type))snap.source=value;
        else if(node.type==="text_process")snap.text_processing=value;
        else if(node.type==="train_test_split")snap.split=value;
        else if(node.type==="tokenize_text")snap.tokenizer=value;
        else if(node.type==="image_process")snap.image_processing=value;
        else if(node.type==="audio_process")snap.audio_processing=value;
        else if(node.type==="batch_data")snap.batch=value;
        else if(node.type==="prepared_dataset")snap.output=value;
      });
      return snap;
    }
    function datasetPipeline(meta){return meta?.pipeline||currentDataPipelineSnapshot();}
    function prettyBool(value){if(value===undefined||value===null||value==="")return "—";const v=String(value).toLowerCase();return v==="true"?"Yes":v==="false"?"No":String(value);}
    function sourceDisplay(source){if(!source)return "—";if(source.type==="hf_dataset")return source.dataset_id||"Hugging Face";if(source.type==="kaggle_dataset")return source.dataset_handle||"Kaggle";if(source.type==="url_dataset")return source.url||"URL";if(source.type==="local_dataset")return source.path||"Local File";if(source.type==="manual_dataset")return "Manual Text Data";return source.name||source.type||"—";}
    function detailSection(body,title,rows){const st=document.createElement("div");st.className="mlb-section-title";st.textContent=title;body.appendChild(st);const box=document.createElement("div");box.className="mlb-dataset-detail-box";rows.filter(row=>row&&row[1]!==undefined&&row[1]!==null&&row[1]!=="").forEach(([label,value])=>{const r=document.createElement("div");r.className="mlb-dataset-detail-row";const a=document.createElement("span");a.textContent=label;const v=document.createElement("strong");v.textContent=String(value);v.title=String(value);r.append(a,v);box.appendChild(r);});body.appendChild(box);}
    function renderPreparedDatasetInspector(body,meta){
      const p=datasetPipeline(meta),source=p.source||{},process=p.text_processing||{},split=p.split||{},tok=p.tokenizer||{},output=p.output||{};
      const head=document.createElement("div");head.className="mlb-selected";head.innerHTML="<strong>"+meta.name+"</strong><span class='mlb-pill'>Prepared Data</span>";body.appendChild(head);
      const ready=document.createElement("div");ready.className="mlb-api-status ok";ready.textContent="✓ Dataset ready for Model Builder";body.appendChild(ready);
      const st=document.createElement("div");st.className="mlb-section-title";st.textContent="SPLITS";body.appendChild(st);body.appendChild(datasetSummaryCard(meta,"DATASET OUTPUT"));
      detailSection(body,"SOURCE",[["Source Type",source.name||source.type||"—"],["Source",sourceDisplay(source)],["Hub Source Split",source.split],["Text Column",source.text_column],["Max Rows",Number(source.max_rows)===0?"All":source.max_rows]]);
      detailSection(body,"TRAIN / VALIDATION / TEST",[["Train %",split.train_size!==undefined?split.train_size+"%":"—"],["Validation %",split.validation_size!==undefined?split.validation_size+"%":"—"],["Test %",split.test_size!==undefined?split.test_size+"%":"—"],["Seed",split.seed],["Shuffle",prettyBool(split.shuffle)]]);
      if(Object.keys(process).length)detailSection(body,"TEXT PROCESSING",[["Text Column",process.text_column],["Lowercase",prettyBool(process.lowercase)],["Trim Spaces",prettyBool(process.strip)],["Normalize Whitespace",prettyBool(process.normalize_whitespace)],["Normalize Unicode",prettyBool(process.unicode_nfkc)],["Remove Empty",prettyBool(process.remove_empty)],["Min Characters",process.min_chars],["Max Characters",!process.max_chars||Number(process.max_chars)===0?"All":process.max_chars]]);
      if(Object.keys(tok).length)detailSection(body,"TOKENIZER",[["Tokenizer",tok.tokenizer_name],["Text Column",tok.text_column],["Tokenizer Max Length",tok.context_length],["Truncation",prettyBool(tok.truncation)],["Padding",tok.padding],["Special Tokens",prettyBool(tok.add_special_tokens)]]);
      detailSection(body,"STORAGE",[["Storage",dataStorageLabel(meta)],["Total Rows",meta.total_rows??"—"],["Save To Disk",output.save_to_disk!==undefined?prettyBool(output.save_to_disk):(meta.path?"Yes":"No")],["Path",meta.path||"Python memory"],["Created",meta.created_at||"—"]]);
      const actions=document.createElement("div");actions.className="mlb-action-grid";const use=btn("Use in Model","mlb-dark-btn");use.addEventListener("click",()=>useDatasetInModel(meta));actions.appendChild(use);body.appendChild(actions);
    }
    function selectedOutputDataset(){if(state.active_workspace!=="data"||bottomView!=="outputs"||!outputDirectorySelection)return null;return preparedDatasetById(outputDirectorySelection);}

    function normalizedBrickName(name){
      return String(name||"").trim().replace(/\s+/g," ").toLowerCase();
    }

    function customNameExists(name, exceptId=null){
      const wanted=normalizedBrickName(name);
      if(!wanted) return false;
      return Object.values(state.custom_components||{}).some(def=>{
        if(exceptId && def.id===exceptId) return false;
        return normalizedBrickName(def.name)===wanted;
      });
    }

    function askUniqueCustomName(defaultName, titleText){
      let proposed=prompt(titleText||"Component name:",defaultName||"");
      if(proposed===null) return null;
      proposed=String(proposed).trim().replace(/\s+/g," ");
      if(!proposed){
        setStatus("Custom component name cannot be empty.");
        return null;
      }
      if(customNameExists(proposed)){
        setStatus('A custom component named "'+proposed+'" already exists.');
        alert('A custom component named "'+proposed+'" already exists. Choose a unique name.');
        return null;
      }
      return proposed;
    }

    function pythonValue(v){
      if(v===null||v===undefined||v==="") return "None";
      if(typeof v==="boolean") return v?"True":"False";
      if(typeof v==="number") return String(v);
      if(v==="true") return "True";
      if(v==="false") return "False";
      if(v==="None"||v==="none") return "None";
      if(typeof v==="string" && v.startsWith("torch.")) return v;
      return JSON.stringify(v);
    }

    function builderDataPreview(node){
      const p=node.params||{};
      const arg=(k,def)=>{
        let v=p[k];
        if(v===undefined||v===null||v==="")v=def;
        return pythonValue(v);
      };
      const varname=(node.name||"data").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"data";

      if(node.type==="manual_dataset"){
        return "from mlbricks_builder.data import load_manual_text_dataset\n\n"+
          varname+" = load_manual_text_dataset(\n"+
          "    "+arg("text","Once upon a time")+", text_column="+arg("text_column","text")+",\n"+
          "    one_line_per_sample="+arg("one_line_per_sample","true")+",\n)";
      }
      if(node.type==="hf_dataset"){
        return "from mlbricks_builder.data import load_huggingface_dataset\n\n"+
          varname+" = load_huggingface_dataset(\n"+
          "    "+arg("dataset_id","roneneldan/TinyStories")+",\n"+
          "    config="+arg("config","")+", split="+arg("split","train")+",\n"+
          "    text_column="+arg("text_column","text")+", streaming="+arg("streaming","false")+",\n"+
          "    max_rows="+(Number(p.max_rows||0)>0?pythonValue(Number(p.max_rows)):"None")+",\n)";
      }
      if(node.type==="kaggle_dataset"){
        return "from mlbricks_builder.data import load_kaggle_dataset\n\n"+
          varname+" = load_kaggle_dataset(\n"+
          "    "+arg("dataset_handle","owner/dataset-name")+",\n"+
          "    file_pattern="+arg("file_pattern","*.csv")+", format="+arg("format","auto")+",\n"+
          "    text_column="+arg("text_column","text")+",\n"+
          "    max_rows="+(Number(p.max_rows||0)>0?pythonValue(Number(p.max_rows)):"None")+",\n)";
      }
      if(node.type==="url_dataset"){
        return "from mlbricks_builder.data import load_url_dataset\n\n"+
          varname+" = load_url_dataset(\n"+
          "    "+arg("url","https://example.com/data.txt")+",\n"+
          "    format="+arg("format","auto")+", text_column="+arg("text_column","text")+",\n"+
          "    max_rows="+(Number(p.max_rows||0)>0?pythonValue(Number(p.max_rows)):"None")+",\n)";
      }
      if(node.type==="local_dataset"){
        return "from mlbricks_builder.data import load_local_dataset\n\n"+
          varname+" = load_local_dataset(\n"+
          "    "+arg("path",localDefaultRoot)+",\n"+
          "    format="+arg("format","auto")+", text_column="+arg("text_column","text")+",\n"+
          "    max_rows="+(Number(p.max_rows||0)>0?pythonValue(Number(p.max_rows)):"None")+",\n)";
      }
      if(node.type==="text_process"){
        return "from mlbricks_builder.data import process_text_dataset\n\n"+
          "processed = process_text_dataset(\n"+
          "    dataset,\n"+
          "    text_column="+arg("text_column","text")+", lowercase="+arg("lowercase","false")+",\n"+
          "    strip="+arg("strip","true")+", normalize_whitespace="+arg("normalize_whitespace","true")+",\n"+
          "    unicode_nfkc="+arg("unicode_nfkc","true")+", remove_empty="+arg("remove_empty","true")+",\n"+
          "    min_chars="+arg("min_chars",1)+", max_chars="+(Number(p.max_chars||0)>0?pythonValue(Number(p.max_chars)):"None")+",\n)";
      }
      if(node.type==="train_test_split"){
        const tr=Math.max(0,Number(p.train_size??90))/100;
        const va=Math.max(0,Number(p.validation_size??5))/100;
        const te=Math.max(0,Number(p.test_size??5))/100;
        return "from mlbricks_builder.data import train_validation_test_split\n\n"+
          "splits = train_validation_test_split(\n"+
          "    dataset, train_size="+pythonValue(tr)+", validation_size="+pythonValue(va)+", test_size="+pythonValue(te)+",\n"+
          "    seed="+arg("seed",42)+", shuffle="+arg("shuffle","true")+",\n)";
      }
      if(node.type==="tokenize_text"){
        return "from mlbricks_builder.data import tokenize_text_dataset\n\n"+
          "tokenized = tokenize_text_dataset(\n"+
          "    dataset, tokenizer_name="+arg("tokenizer_name","gpt2")+",\n"+
          "    text_column="+arg("text_column","text")+", context_length="+arg("context_length",512)+",\n"+
          "    truncation="+arg("truncation","true")+", padding="+arg("padding","false")+",\n"+
          "    add_special_tokens="+arg("add_special_tokens","true")+",\n)";
      }
      if(node.type==="image_process"){
        return "from mlbricks_builder.data import process_image_dataset\n\n"+
          "processed = process_image_dataset(\n"+
          "    dataset, image_column="+arg("image_column","image")+", width="+arg("width",224)+", height="+arg("height",224)+",\n"+
          "    mode="+arg("mode","RGB")+", center_crop="+arg("center_crop","false")+",\n)";
      }
      if(node.type==="audio_process"){
        return "from mlbricks_builder.data import process_audio_dataset\n\n"+
          "processed = process_audio_dataset(\n"+
          "    dataset, audio_column="+arg("audio_column","audio")+", sample_rate="+arg("sample_rate",16000)+",\n"+
          "    normalize="+arg("normalize","true")+", trim_silence="+arg("trim_silence","false")+",\n"+
          "    silence_threshold="+arg("silence_threshold",0.01)+",\n)";
      }
      if(node.type==="batch_data"){
        return "from mlbricks_builder.data import make_torch_dataloader\n\n"+
          "loader = make_torch_dataloader(\n"+
          "    dataset, batch_size="+arg("batch_size",16)+", shuffle="+arg("shuffle","true")+",\n"+
          "    num_workers="+arg("num_workers",2)+", drop_last="+arg("drop_last","false")+",\n)";
      }
      if(node.type==="prepared_dataset"){
        return "# Registered in Builder as: "+String(p.dataset_name||"Prepared Dataset")+"\n"+
          "from mlbricks_builder.data import prepared_dataset_output\n\n"+
          "prepared = prepared_dataset_output(\n"+
          "    dataset, save_to_disk="+arg("save_to_disk","false")+", path="+arg("path",(localPaths.data||"mlbricks/data")+"/prepared_dataset")+",\n)";
      }
      return "";
    }

    function pythonDeepValue(value){
      if(Array.isArray(value))return "["+value.map(pythonDeepValue).join(", ")+"]";
      if(value&&typeof value==="object"){
        return "{"+Object.entries(value).map(([k,v])=>pythonValue(k)+": "+pythonDeepValue(v)).join(", ")+"}";
      }
      return pythonValue(value);
    }

    function pythonJsonish(value,fallback){
      return pythonDeepValue(parseJsonish(value,fallback));
    }

    function pythonScalarOrList(value,{numeric=false}={}){
      if(Array.isArray(value))return pythonDeepValue(value);
      const text=String(value??"").trim();
      if(!text)return "None";
      if(text.startsWith("[")){
        try{return pythonDeepValue(JSON.parse(text));}catch(_){}
      }
      if(text.includes(",")){
        const parts=text.split(",").map(x=>x.trim()).filter(Boolean);
        return pythonDeepValue(numeric?parts.map(Number):parts);
      }
      if(numeric){const n=Number(text);return Number.isFinite(n)?String(n):pythonValue(text);}
      return pythonValue(text);
    }

    function constructorPreview(node){
      const api=apiInfo(node);
      if(node.type==="custom"){
        const def=state.custom_components?.[node.definition_id];
        if(String(def?.implementation||"graph")==="api"){
          const binding=def.api_binding||{};const path=String(binding.import_path||"module.Symbol");const parts=path.split(".");const symbol=parts.pop()||"Symbol";const mod=parts.join(".")||"module";
          const specs=binding.parameters||[];const renderSpec=spec=>{const source=String(spec.source||"user");if(source==="input"||source==="main")return "x";if(source==="skip")return "skip";if(source==="extra")return "extra";if(source!=="user")return "<"+source+">";return pythonValue(node.params?.[spec.name]??spec.default);};
          const args=stage=>specs.filter(x=>String(x.stage||"init")===stage).map(spec=>(spec.positional?"":String(spec.name||"arg")+"=")+renderSpec(spec)).join(", ");
          return "from "+mod+" import "+symbol+"\n\n"+(binding.target_kind==="function"?("y = "+symbol+"("+(args("call")||"x")+")"):("layer = "+symbol+"("+args("init")+")\ny = layer("+(args("call")||"x")+")"));
        }
        return "# Nested custom component";
      }
      if(api?.builder_utility) return api.builder_python_api ? builderDataPreview(node) : "";
      if(node.type==="stateaware_esa_stack"){
        const p=node.params||{};
        return "from mlbricks.esa import ESA\nfrom mlbricks.components import RMSNorm\nfrom mlbricks.ffnbrick import StateAwareFFN\nfrom mlbricks.residualbrick import ResController\n\n"+
          "# Builder compound stack matching the StateAware ESA notebook\n"+
          "# dim="+String(p.dim??384)+", state_dim="+String(p.state_dim??2749)+", layers="+String(p.layers??8)+", heads="+String(p.heads??6)+"\n"+
          "# Each layer: RMSNorm → ESA + StateAwareFFN → gated ResController\n";
      }
      if(!api?.available) return "# MLBricks API unavailable";
      if(node.type==="soup"){
        const p=node.params||{};
        const varname=(node.name||"soup").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"soup";
        return "from mlbricks.soup import SOUP\n\n"+varname+" = SOUP(\n"+
          "    dim="+pythonValue(Number(p.dim??512))+",\n"+
          "    width="+pythonScalarOrList(p.width??1116,{numeric:true})+",\n"+
          "    depth="+pythonValue(Number(p.depth??2))+",\n"+
          "    mixer="+pythonScalarOrList(p.mixer??"esa")+",\n"+
          "    ffn="+pythonScalarOrList(p.ffn??"saffn")+",\n"+
          "    mixer_config="+pythonJsonish(p.mixer_config,{head:8,num_heads:8})+",\n"+
          "    ffn_config="+pythonJsonish(p.ffn_config,{})+",\n"+
          "    backend="+pythonValue(p.backend??"auto")+", precision="+pythonValue(p.precision??"fp16")+",\n"+
          "    memory_dim="+pythonValue(Number(p.memory_dim??128))+", fusion_hidden="+pythonValue(Number(p.fusion_hidden??768))+",\n)";
      }
      if(node.type==="elasticbit_runtime"){
        const p=node.params||{};
        const threshold=Number(p.threshold??0.01),minBits=Number(p.min_bits??4),maxBits=Number(p.max_bits??32);
        const mode=String(p.runtime_mode||"compact");
        const varname=(node.name||"elasticbit_matrix").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"elasticbit_matrix";
        return "from mlbricks.elasticbit import ElasticBit\n\n"+
          "analysis = ElasticBit.bitsAnaliser(\n"+
          "    weights, calibration, threshold="+pythonValue(threshold)+", min_bits="+pythonValue(minBits)+", max_bits="+pythonValue(maxBits)+",\n)\n\n"+
          varname+" = ElasticBit.RuntimeMatrix.from_auto(\n"+
          "    weights, calibration, threshold="+pythonValue(threshold)+", runtime_mode="+pythonValue(mode)+",\n"+
          "    min_bits="+pythonValue(minBits)+", max_bits="+pythonValue(maxBits)+",\n)";
      }
      const args=[];
      (api.parameters||[]).forEach(f=>{
        let v=node.params?.[f.key];
        if(v===undefined || v===null || v==="") v=f.value;
        if((v===undefined || v===null) && f.required) return;
        if(v===undefined || v===null) return;
        args.push(f.key+"="+pythonValue(v));
      });
      const varname=(node.name||"layer").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"layer";
      const importModule=api.import_module||(api.import_path?api.import_path.split(".").slice(0,-1).join("."):"mlbricks");
      if(api.config_api){
        const cfgName=api.config_api.public_name;
        const cfgModule=api.config_api.import_module||(api.config_api.import_path?api.config_api.import_path.split(".").slice(0,-1).join("."):importModule);
        const imports=cfgModule===importModule
          ?"from "+importModule+" import "+api.public_name+", "+cfgName
          :"from "+importModule+" import "+api.public_name+"\nfrom "+cfgModule+" import "+cfgName;
        return imports+"\n\n"+
          "config = "+cfgName+"("+args.join(", ")+")\n"+
          varname+" = "+api.public_name+"(config)";
      }
      return "from "+importModule+" import "+api.public_name+"\n\n"+varname+" = "+api.public_name+"("+args.join(", ")+")";
    }

    function connect(a,b,kind="main",sourcePort="main_out",targetPort="main_in",record=true){
      if(record&&!requireEditableLayout("change connections"))return;
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

    function isMainLaneEdge(e){
      return e.kind==="main" && (e.source_port||"main_out")==="main_out" && (e.target_port||"main_in")==="main_in";
    }

    function rebuildMainFlow(){
      const c=current(state);
      if(!state.auto_connect)return;
      // In Auto Connect mode the middle lane represents the ordered model flow.
      // Rebuild only that lane; Skip and Extra connections remain untouched.
      c.edges=(c.edges||[]).filter(e=>!isMainLaneEdge(e));
      for(let i=0;i<c.nodes.length-1;i++){
        connect(c.nodes[i].id,c.nodes[i+1].id,"main","main_out","main_in",false);
      }
    }

    function insertAfterSelection(node){
      const c=current(state);
      let insertAt=c.nodes.length;
      if(selected){
        const idx=c.nodes.findIndex(x=>x.id===selected);
        if(idx>=0) insertAt=idx+1;
      }
      c.nodes.splice(insertAt,0,node);
      rebuildMainFlow();
      selected=node.id;
      return insertAt;
    }

    function addPrimitive(item){
      if(!requireEditableLayout("add components"))return;
      checkpoint("Add "+item.name);
      const n=makeNode(item);n.name=uniqueNodeName(item.name);n.display_name=item.name;
      if(n.type==="text_input")configureTextInputForLatest(n);
      if(n.type==="soup"){
        const settings=deriveModelSettings(null);
        n.params=n.params||{};
        n.params.dim=settings.embedding_size;
        n.params.precision=settings.precision;
        n.params.mixer_config=soupMixerConfigWithHeads(n.params.mixer_config,settings.heads,n.params.depth);
      }
      const pos=insertAfterSelection(n);
      setStatus(n.name+" inserted at layer "+(pos+1)+".");
      draw();
      queueComponentImport(n.type);
    }

    function customArgDefault(index=0){
      return {
        id:uid("arg"),name:"arg_"+(index+1),label:"Argument "+(index+1),stage:"init",
        type:"int",source:"user",default:0,required:false,positional:false,options:[]
      };
    }

    function defaultAPIBinding(){
      return {
        import_path:"",
        target_kind:"module",
        call_method:"",
        output_selector:"auto",
        parameters:[]
      };
    }

    function customFieldType(spec){
      const t=String(spec?.type||"str").toLowerCase();
      if(t==="int"||t==="integer"||t==="float"||t==="number")return "number";
      if(t==="bool"||t==="boolean")return "select";
      if(t==="select")return "select";
      if(t==="json"||t==="dict"||t==="list"||t==="tuple")return "textarea";
      return "text";
    }

    function customExposedFields(def){
      if(!def||String(def.implementation||"graph")!=="api")return [];
      return (def.api_binding?.parameters||[]).filter(spec=>String(spec.source||"user")==="user").map(spec=>{
        const field={
          key:spec.name,label:spec.label||spec.name,type:customFieldType(spec),value:spec.default,
          required:!!spec.required,help:"Custom API · "+(spec.stage||"init")+" argument"
        };
        if(field.type==="select"){
          if(String(spec.type||"").toLowerCase()==="bool"||String(spec.type||"").toLowerCase()==="boolean")field.options=["true","false"];
          else field.options=Array.isArray(spec.options)?spec.options:[];
        }
        return field;
      });
    }

    function boundContextValue(source,spec){
      const settings=deriveModelSettings(null);
      if(source==="model_dim")return settings.embedding_size;
      if(source==="heads")return settings.heads;
      if(source==="context")return numberOr(state.project?.context_length,512);
      if(source==="batch")return numberOr(state.project?.batch_size,16);
      if(source==="device")return "auto";
      if(source==="dtype")return precisionToDtype(settings.precision);
      return spec?.default;
    }

    function customNodeParams(def){
      const params={};
      if(!def||String(def.implementation||"graph")!=="api")return params;
      (def.api_binding?.parameters||[]).forEach(spec=>{
        const name=String(spec.name||"").trim();if(!name)return;
        const source=String(spec.source||"user");
        if(["input","main","skip","extra"].includes(source))return;
        params[name]=source==="user"?spec.default:boundContextValue(source,spec);
      });
      return params;
    }

    function createAPICustom(){
      const name=askUniqueCustomName("API Component","New API component name:");
      if(!name){draw();return;}
      checkpoint("Create API custom component");
      rememberWorkspaceView();state.active_workspace="model";
      const modelWs=state.workspaces?.model;if(modelWs){state.view_component_id=modelWs.view_component_id||modelWs.root_component_id;state.breadcrumbs=cp(modelWs.breadcrumbs||[{id:modelWs.root_component_id,name:modelWs.name||"Model Builder"}]);}
      const id=uid("custom");
      state.custom_components[id]={
        id,name,description:"User-bound Python/PyTorch API component",revision:1,
        implementation:"api",api_binding:defaultAPIBinding(),nodes:[],edges:[],input_count:3,output_count:3,
        palette_hidden:true,palette_installed:false,gallery_entry_id:null
      };
      const vid="view_"+id+"_"+uid("n");
      state.components[vid]={
        id:vid,name,kind:"custom_edit",definition_id:id,revision:1,
        input_count:3,output_count:3,nodes:[],edges:[]
      };
      galleryWorkspace.open=false;bottomExpanded=galleryPreviousBottomExpanded;
      state.view_component_id=vid;state.breadcrumbs.push({id:vid,name});selected=null;pendingPort=null;
      setStatus(name+" created. Bind its Python API in Inspector.");draw();
    }

    function requestCustomAPIImport(def){
      const binding=def?.api_binding||{};
      const importPath=String(binding.import_path||"").trim();
      if(!importPath){setStatus("Enter an API import path first.");return;}
      if(!bridgeReady()){setStatus("Kernel bridge is offline. Re-run the Builder cell, then test the API again.");return;}
      const command={action:"ensure_external_import",import_path:importPath,label:def.name,definition_id:def.id,ts:Date.now()};
      if(!setBridgeState()||!setBridgeCommand(command)){setStatus("Could not send custom API import check to Python.");return;}
      const button=bridgeControl(bridge.run,"button");if(!button){setStatus("Python Run control was not found.");return;}
      customImportStatus[def.id]={status:"running",message:"Checking "+importPath+"…"};
      setStatus("Checking "+importPath+"…");clickBridgeButton(button);draw();
    }

    function editorRow(labelText,value,onInput,opts={}){
      const row=document.createElement("div");row.className="mlb-custom-binding-field";
      const label=document.createElement("label");label.textContent=labelText;row.appendChild(label);
      let input;
      if(opts.select){input=document.createElement("select");(opts.options||[]).forEach(opt=>{const o=document.createElement("option");o.value=String(opt);o.textContent=String(opt);if(String(value)===String(opt))o.selected=true;input.appendChild(o);});}
      else if(opts.textarea){input=document.createElement("textarea");input.rows=opts.rows||2;input.value=value??"";}
      else {input=document.createElement("input");input.type=opts.type||"text";input.value=value??"";}
      input.addEventListener(opts.select?"change":"input",()=>onInput(input.value));row.appendChild(input);return row;
    }

    function renderCustomBindingEditor(body,def){
      def.api_binding=def.api_binding||defaultAPIBinding();const binding=def.api_binding;
      const intro=document.createElement("div");intro.className="mlb-api-path";
      intro.textContent="Bind this reusable component to any importable Python/PyTorch class or function. The import is lazy and cached when the component is used.";body.appendChild(intro);

      const title=document.createElement("div");title.className="mlb-section-title";title.textContent="API BINDING";body.appendChild(title);
      body.appendChild(editorRow("Import Path",binding.import_path||"",v=>{binding.import_path=v;customImportStatus[def.id]=null;},{type:"text"}));
      body.appendChild(editorRow("Target",binding.target_kind||"module",v=>binding.target_kind=v,{select:true,options:["module","function"]}));
      body.appendChild(editorRow("Call Method",binding.call_method||"",v=>binding.call_method=v,{type:"text"}));
      body.appendChild(editorRow("Output Selector",binding.output_selector||"auto",v=>binding.output_selector=v,{type:"text"}));

      const apiActions=document.createElement("div");apiActions.className="mlb-action-grid";
      const test=btn("Bind / Test API","mlb-custom-api-test");test.addEventListener("click",()=>requestCustomAPIImport(def));apiActions.appendChild(test);body.appendChild(apiActions);
      const st=customImportStatus[def.id];if(st){const msg=document.createElement("div");msg.className="mlb-api-status "+(st.status==="done"?"available":st.status==="error"?"unavailable":"utility");msg.textContent=st.message||st.status;body.appendChild(msg);}

      const argTitle=document.createElement("div");argTitle.className="mlb-section-title";argTitle.textContent="ARGUMENTS";body.appendChild(argTitle);
      const note=document.createElement("div");note.className="mlb-api-path";note.textContent="Init arguments construct a class/module. Call arguments are passed during forward. Source = Main / Skip / Extra binds one of the three graph tensor lanes; Model Dim / Heads / Context / Batch bind Builder settings.";body.appendChild(note);

      const args=Array.isArray(binding.parameters)?binding.parameters:(binding.parameters=[]);
      args.forEach((spec,index)=>{
        const box=document.createElement("div");box.className="mlb-custom-arg-card";
        const head=document.createElement("div");head.className="mlb-custom-arg-head";
        const name=document.createElement("strong");name.textContent=(spec.label||spec.name||("Argument "+(index+1)));
        const remove=btn("×","mlb-custom-arg-remove");remove.title="Remove argument";remove.addEventListener("click",()=>{checkpoint("Remove API argument");args.splice(index,1);draw();});
        head.append(name,remove);box.appendChild(head);
        box.appendChild(editorRow("Argument Name",spec.name||"",v=>{spec.name=v;spec.label=spec.label||v;}));
        box.appendChild(editorRow("UI Label",spec.label||spec.name||"",v=>spec.label=v));
        box.appendChild(editorRow("Stage",spec.stage||"init",v=>spec.stage=v,{select:true,options:["init","call"]}));
        box.appendChild(editorRow("Type",spec.type||"str",v=>{spec.type=v;setTimeout(draw,0);},{select:true,options:["int","float","str","bool","select","json","dict","list","tuple"]}));
        box.appendChild(editorRow("Source",spec.source||"user",v=>{spec.source=v;setTimeout(draw,0);},{select:true,options:["user","main","skip","extra","model_dim","heads","context","batch","device","dtype"]}));
        if(String(spec.source||"user")==="user"){
          box.appendChild(editorRow("Default",spec.default??"",v=>spec.default=v,{textarea:["json","dict","list","tuple"].includes(String(spec.type)),rows:2}));
          if(String(spec.type)==="select")box.appendChild(editorRow("Options (comma separated)",(spec.options||[]).join(", "),v=>spec.options=v.split(",").map(x=>x.trim()).filter(Boolean)));
        }
        box.appendChild(editorRow("Pass As",spec.positional?"positional":"keyword",v=>spec.positional=(v==="positional"),{select:true,options:["keyword","positional"]}));
        box.appendChild(editorRow("Required",spec.required?"true":"false",v=>spec.required=(v==="true"),{select:true,options:["false","true"]}));
        body.appendChild(box);
      });
      const add=btn("+ Add Parameter","mlb-create mlb-custom-add-arg");add.addEventListener("click",()=>{checkpoint("Add API argument");args.push(customArgDefault(args.length));draw();});body.appendChild(add);

      const previewTitle=document.createElement("div");previewTitle.className="mlb-section-title";previewTitle.textContent="BINDING PREVIEW";body.appendChild(previewTitle);
      const pre=document.createElement("pre");pre.className="mlb-code-preview";
      const path=String(binding.import_path||"module.Symbol");const parts=path.split(".");const symbol=parts.pop()||"Symbol";const mod=parts.join(".")||"module";
      const initArgs=args.filter(a=>String(a.stage||"init")==="init").map(a=>(a.positional?"":String(a.name||"arg")+"=")+String(a.source||"user")).join(", ");
      const callArgs=args.filter(a=>String(a.stage||"init")==="call").map(a=>(a.positional?"":String(a.name||"arg")+"=")+String(a.source||"user")).join(", ")||"x";
      pre.textContent="from "+mod+" import "+symbol+"\n\n"+(binding.target_kind==="function"?("y = "+symbol+"("+callArgs+")"):("layer = "+symbol+"("+initArgs+")\ny = layer("+callArgs+")"));body.appendChild(pre);
    }

    function createCustom(){
      const name=askUniqueCustomName("My Component","New component name:");
      if(!name){draw();return;}

      checkpoint("Create custom component");
      const id=uid("custom");

      // IMPORTANT: creating a custom component creates an EMPTY reusable shell.
      // It never captures siblings or the current model canvas.
      state.custom_components[id]={
        id,
        name,
        description:"Reusable nested layer",
        revision:1,
        implementation:"graph",
        nodes:[],
        edges:[],
        input_count:3,
        output_count:3,
        palette_hidden:true,
        palette_installed:false,
        gallery_entry_id:null
      };

      // Open the new empty shell immediately so the user can build its
      // internal architecture without accidentally copying model siblings.
      const vid="view_"+id+"_"+uid("n");
      state.components[vid]={
        id:vid,
        name,
        kind:"custom_edit",
        definition_id:id,
        revision:1,
        input_count:3,
        output_count:3,
        nodes:[],
        edges:[]
      };
      state.view_component_id=vid;
      state.breadcrumbs.push({id:vid,name});
      selected=null;
      pendingPort=null;
      setStatus(name+" created as an empty component.");
      draw();
    }

    function customGallerySnapshot(def,c){
      return {
        id:def.id,name:def.name,description:def.description||"Reusable custom component",
        revision:def.revision||1,implementation:def.implementation||"graph",
        api_binding:cp(def.api_binding||null),input_count:3,output_count:3,
        nodes:cp(c?.nodes||def.nodes||[]),edges:cp(c?.edges||def.edges||[])
      };
    }

    function uniqueGalleryComponentName(base,exceptId=null){
      const clean=String(base||"Custom Component").trim().replace(/\s+/g," ")||"Custom Component";
      if(!galleryNameExists("components",clean,exceptId))return clean;
      let i=2;while(galleryNameExists("components",clean+" "+i,exceptId))i++;
      return clean+" "+i;
    }

    function upsertCustomInGallery(def,c){
      let entry=(state.gallery.components||[]).find(x=>x.id===def.gallery_entry_id);
      if(!entry)entry=(state.gallery.components||[]).find(x=>x.source_definition_id===def.id);
      if(entry){
        entry.name=uniqueGalleryComponentName(def.name,entry.id);
        entry.saved_at=new Date().toISOString();
        entry.definition=customGallerySnapshot(def,c);
        entry.source_definition_id=def.id;
      }else{
        entry={
          id:uid("gallery_component"),
          name:uniqueGalleryComponentName(def.name),
          kind:"component",saved_at:new Date().toISOString(),
          source_definition_id:def.id,definition:customGallerySnapshot(def,c)
        };
        state.gallery.components.push(entry);
      }
      def.gallery_entry_id=entry.id;
      persistGallery();
      return entry;
    }

    function editCustomDefinition(def){
      if(!def)return;
      customActionMenuId=null;
      const vid="view_"+def.id+"_"+uid("n");
      state.components[vid]={
        id:vid,name:def.name,kind:"custom_edit",definition_id:def.id,revision:def.revision||1,
        input_count:3,output_count:3,nodes:cp(def.nodes||[]),edges:cp(def.edges||[])
      };
      const modelWs=state.workspaces?.model;
      if(modelWs){
        state.active_workspace="model";
        state.view_component_id=modelWs.view_component_id||modelWs.root_component_id;
        state.breadcrumbs=cp(modelWs.breadcrumbs||[{id:modelWs.root_component_id,name:modelWs.name||"Model Builder"}]);
      }
      state.view_component_id=vid;state.breadcrumbs.push({id:vid,name:def.name});
      selected=null;pendingPort=null;galleryWorkspace.open=false;
      setStatus("Editing "+def.name+".");draw();
    }

    function renameCustomDefinition(def){
      if(!def)return;
      const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
      const proposed=win&&typeof win.prompt==="function"?win.prompt("Rename custom component:",def.name||"Component"):null;
      if(proposed===null)return;
      const name=String(proposed||"").trim().replace(/\s+/g," ");
      if(!name){setStatus("Component name cannot be empty.");return;}
      if(customNameExists(name,def.id)){setStatus('A custom component named "'+name+'" already exists.');return;}
      checkpoint("Rename custom component");
      const oldName=def.name;def.name=name;
      Object.values(state.components||{}).forEach(comp=>{
        if(comp.kind==="custom_edit"&&comp.definition_id===def.id)comp.name=name;
        (comp.nodes||[]).forEach(n=>{if(n.definition_id===def.id){n.display_name=name;if(normalizedUserName(n.name)===normalizedUserName(oldName))n.name=uniqueNodeName(name,comp,n.id);}});
      });
      customActionMenuId=null;setStatus('Custom component renamed to "'+name+'".');draw();
    }

    function removeCustomFromPalette(def){
      if(!def)return;
      const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
      if(win&&typeof win.confirm==="function"&&!win.confirm('Remove "'+def.name+'" from My Components? Existing model instances will remain unchanged.'))return;
      checkpoint("Remove custom component from My Components");
      def.palette_hidden=true;def.palette_installed=false;customActionMenuId=null;
      setStatus(def.name+" removed from My Components. It remains available in Gallery if it was saved there.");draw();
    }

    function addCustom(def){
      if(!requireEditableLayout("add components"))return;
      checkpoint("Add "+def.name);
      const n={
        id:uid("node"),
        type:"custom",
        name:uniqueNodeName(def.name),
        display_name:def.name,
        definition_id:def.id,
        repeat:1,
        params:customNodeParams(def),
        input_count:3,
        output_count:3,
        position:{x:0,y:0}
      };
      const pos=insertAfterSelection(n);
      setStatus(def.name+" inserted at layer "+(pos+1)+".");
      draw();
      if(String(def.implementation||"graph")==="api" && String(def.api_binding?.import_path||"").trim())
        setTimeout(()=>requestCustomAPIImport(def),60);
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

    function appendCustomSaveActions(container){
      const actions=document.createElement("div");actions.className="mlb-action-grid mlb-custom-save-actions";
      const save=btn("Save");
      save.title="Save changes to Gallery → Custom Components";
      save.addEventListener("click",()=>saveCustom(false));
      const saveAsNew=btn("Save As New");
      saveAsNew.title="Save a copy as a new Gallery custom component";
      saveAsNew.addEventListener("click",()=>saveCustom(true));
      actions.append(save,saveAsNew);container.appendChild(actions);
    }

    function saveCustom(asNew){
      const c=current(state),def=state.custom_components[c.definition_id];if(!def)return;
      checkpoint(asNew?"Save custom as new":"Save custom component");
      let savedDef=def,savedView=c;
      if(asNew){
        const name=askUniqueCustomName(def.name+" Copy","Save as new custom component:");
        if(!name){draw();return;}
        const id=uid("custom");
        savedDef={
          id,name,description:def.description||"",revision:1,implementation:def.implementation||"graph",
          api_binding:cp(def.api_binding||null),nodes:cp(c.nodes),edges:cp(c.edges||[]),input_count:3,output_count:3,
          palette_hidden:true,palette_installed:false,gallery_entry_id:null
        };
        state.custom_components[id]=savedDef;
        savedView={nodes:cp(c.nodes),edges:cp(c.edges||[])};
      }else{
        def.nodes=cp(c.nodes);def.edges=cp(c.edges||[]);def.input_count=3;def.output_count=3;
        def.revision=(def.revision||1)+1;c.revision=def.revision;
      }
      const entry=upsertCustomInGallery(savedDef,savedView);
      // A component created from Gallery is a saved template first. It only appears
      // in the left My Components palette after the user explicitly installs it.
      if(savedDef.palette_installed!==true)savedDef.palette_hidden=true;
      setStatus(savedDef.name+" saved to Gallery → Custom Components"+(savedDef.palette_installed===true?" and updated in My Components.":"."));
      draw();
    }

    function deleteNode(id){
      if(!requireEditableLayout("delete components"))return;
      checkpoint("Delete node");
      const c=current(state);
      c.nodes=c.nodes.filter(n=>n.id!==id);
      c.edges=c.edges.filter(e=>e.source!==id&&e.target!==id);
      rebuildMainFlow();
      if(selected===id)selected=null;
      setStatus("Layer deleted.");
      draw();
    }

    function duplicateSelected(){
      const n=selectedNode();if(!n)return;
      if(!requireEditableLayout("duplicate components"))return;
      checkpoint("Duplicate "+n.name);
      const c=current(state),d=cp(n);d.id=uid("node");d.name=uniqueNodeName(n.name+" Copy",c);d.display_name=nodeDisplayName(n);
      const idx=c.nodes.findIndex(x=>x.id===n.id);
      c.nodes.splice(idx+1,0,d);
      rebuildMainFlow();
      selected=d.id;
      setStatus("Layer duplicated after "+n.name+".");
      draw();
    }

    function moveSelected(delta){
      const n=selectedNode();if(!n)return;
      if(!requireEditableLayout("move components"))return;
      const c=current(state);
      const from=c.nodes.findIndex(x=>x.id===n.id);
      if(from<0)return;
      const to=Math.max(0,Math.min(c.nodes.length-1,from+delta));
      if(to===from){
        setStatus(delta<0?"Layer is already first.":"Layer is already last.");
        draw();
        return;
      }
      checkpoint("Move "+n.name+(delta<0?" left":" right"));
      c.nodes.splice(from,1);
      c.nodes.splice(to,0,n);
      rebuildMainFlow();
      selected=n.id;
      setStatus(n.name+" moved to layer "+(to+1)+".");
      draw();
    }

    function portClick(nodeId,side,portIndex,ev){
      ev.stopPropagation();
      if(!requireEditableLayout("edit connections"))return;
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


    function splitPercentages(node){
      return {
        train:Math.max(0,Math.min(100,Number(fieldCurrentValue(node,"train_size")??90))),
        validation:Math.max(0,Math.min(100,Number(fieldCurrentValue(node,"validation_size")??5))),
        test:Math.max(0,Math.min(100,Number(fieldCurrentValue(node,"test_size")??5)))
      };
    }

    function splitTotal(node){
      const s=splitPercentages(node);
      return s.train+s.validation+s.test;
    }

    function splitIsValid(node){
      const s=splitPercentages(node);
      return s.train>0 && Math.abs((s.train+s.validation+s.test)-100)<0.0001;
    }

    function setSplitPreset(node,train,validation,test,label){
      checkpoint("Split preset "+label);
      node.params=node.params||{};
      node.params.train_size=train;
      node.params.validation_size=validation;
      node.params.test_size=test;
      setStatus("Split set to "+train+"% train / "+validation+"% validation / "+test+"% test.");
      draw();
    }

    function renderField(body,node,f){
      const wrap=document.createElement("div");wrap.className="mlb-field"+(f.type==="percent"?" mlb-percent-field":"");
      const label=document.createElement("label");label.textContent=f.label+(f.required?" *":"");
      let input;

      const commit=(value)=>{
        checkpoint("Edit "+node.name+"."+f.key);
        node.params=node.params||{};
        node.params[f.key]=f.type==="number"||f.type==="percent"?Number(value):value;
        if(node.type==="text_input" && f.key==="dataset_id"){
          const meta=preparedDatasetById(value);
          if(meta){
            const available=Object.keys(meta.splits||{});
            if(!available.includes(node.params.dataset_split)){
              node.params.dataset_split=meta.default_split||available[0]||"train";
            }
          }
        }
        if(node.type==="train_test_split"){
          const total=splitTotal(node);
          setStatus(splitIsValid(node)
            ?"Split valid: total 100%."
            :"Split needs attention: Train + Validation + Test = "+total+"%. It must equal 100%.");
        }else{
          setStatus(node.name+" settings updated.");
        }
        draw();
      };

      if(f.type==="dataset_select"){
        input=document.createElement("select");
        const datasets=availablePreparedDatasets();
        if(!datasets.length){
          const o=document.createElement("option");o.value="";o.textContent="No prepared datasets yet";
          input.appendChild(o);input.disabled=true;
        }else{
          datasets.forEach(meta=>{
            const o=document.createElement("option");o.value=meta.id;
            o.textContent=meta.name+" — "+compactDatasetSummary(meta);
            if(String(node.params?.[f.key]||"")===String(meta.id))o.selected=true;
            input.appendChild(o);
          });
          if(!node.params?.[f.key]){
            const latest=latestPreparedDataset();
            if(latest){node.params=node.params||{};node.params[f.key]=latest.id;input.value=latest.id;}
          }
          input.addEventListener("change",()=>{
            commit(input.value);
          });
        }
      }else if(f.type==="dataset_split_select"){
        input=document.createElement("select");
        const meta=preparedDatasetById(node.params?.dataset_id)||latestPreparedDataset();
        const splits=meta?Object.keys(meta.splits||{}):[];
        if(!splits.length){
          const o=document.createElement("option");o.value="";o.textContent="No splits available";
          input.appendChild(o);input.disabled=true;
        }else{
          splits.forEach(name=>{
            const o=document.createElement("option");o.value=name;o.textContent=datasetSplitLabel(name,meta);
            if(String(node.params?.[f.key]||meta.default_split||"train")===name)o.selected=true;
            input.appendChild(o);
          });
          input.addEventListener("change",()=>commit(input.value));
        }
      }else if(f.type==="percent"){
        const row=document.createElement("div");row.className="mlb-percent-row";
        const range=document.createElement("input");range.type="range";range.min=f.min??0;range.max=f.max??100;range.step=f.step??1;
        const number=document.createElement("input");number.type="number";number.min=f.min??0;number.max=f.max??100;number.step=f.step??1;
        const value=Number(node.params?.[f.key]??f.value??0);
        range.value=value;number.value=value;
        const suffix=document.createElement("span");suffix.className="mlb-percent-sign";suffix.textContent="%";
        range.addEventListener("input",()=>{number.value=range.value;});
        number.addEventListener("input",()=>{range.value=Math.max(Number(range.min),Math.min(Number(range.max),Number(number.value||0)));});
        range.addEventListener("change",()=>commit(range.value));
        number.addEventListener("change",()=>commit(Math.max(Number(number.min),Math.min(Number(number.max),Number(number.value||0)))));
        row.append(range,number,suffix);
        input=row;
      }else if(f.type==="select"){
        input=document.createElement("select");
        (f.options||[]).forEach(v=>{
          const o=document.createElement("option");o.value=v;o.textContent=v;
          if(String(node.params?.[f.key]??f.value)===String(v))o.selected=true;
          input.appendChild(o);
        });
        input.addEventListener("change",()=>commit(input.value));
      }else if(f.type==="textarea"){
        input=document.createElement("textarea");input.rows=4;input.value=node.params?.[f.key]??f.value??"";
        input.addEventListener("change",()=>commit(input.value));
      }else if(f.type==="bool"){
        input=document.createElement("select");
        ["true","false"].forEach(v=>{const o=document.createElement("option");o.value=v;o.textContent=v;if(String(node.params?.[f.key]??f.value)===v)o.selected=true;input.appendChild(o);});
        input.addEventListener("change",()=>commit(input.value));
      }else{
        input=document.createElement("input");input.type=f.type==="number"?"number":"text";input.step=f.step??"any";
        if(f.min!==undefined)input.min=f.min;if(f.max!==undefined)input.max=f.max;
        input.value=node.params?.[f.key]??f.value??"";
        input.addEventListener("change",()=>commit(input.value));
      }

      wrap.append(label,input);
      if(f.help){
        const help=document.createElement("div");help.className="mlb-field-help";help.textContent=f.help;wrap.appendChild(help);
      }
      body.appendChild(wrap);
    }

    function fieldCurrentValue(node,key){
      if(node.params && node.params[key]!==undefined)return node.params[key];
      const field=(cat(catalog,node.type).api||[]).find(x=>x.key===key);
      return field ? field.value : "";
    }

    function fieldVisible(node,f){
      if(f.show_when){
        return Object.entries(f.show_when).every(([k,v])=>String(fieldCurrentValue(node,k))===String(v));
      }
      if(f.show_when_any){
        return Object.entries(f.show_when_any).every(([k,values])=>{
          const current=String(fieldCurrentValue(node,k));
          return (values||[]).map(String).includes(current);
        });
      }
      return true;
    }

    function renderGroupedFields(body,node,fields){
      const groupOrder=[];
      (fields||[]).forEach(f=>{
        const group=f.group||"Settings";
        if(!groupOrder.includes(group))groupOrder.push(group);
      });

      groupOrder.forEach(group=>{
        const visible=(fields||[]).filter(f=>(f.group||"Settings")===group && fieldVisible(node,f));
        if(!visible.length)return;

        const collapsed=collapsedInspectorGroups.has(group);
        const header=document.createElement("button");
        header.type="button";
        header.className="mlb-ins-group";
        header.innerHTML="<span>"+group+"</span><span>"+(collapsed?"▸":"▾")+"</span>";
        header.addEventListener("click",()=>{
          if(collapsedInspectorGroups.has(group))collapsedInspectorGroups.delete(group);
          else collapsedInspectorGroups.add(group);
          draw();
        });
        body.appendChild(header);

        if(!collapsed){
          const section=document.createElement("div");
          section.className="mlb-ins-group-body";
          visible.forEach(f=>renderField(section,node,f));
          body.appendChild(section);
        }
      });
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
      if(node.type==="text_input"){
        const mode=String(fieldCurrentValue(node,"input_mode")||"prompt");
        if(mode==="prepared_dataset"){
          const meta=preparedDatasetById(node.params?.dataset_id)||latestPreparedDataset();
          const split=node.params?.dataset_split||meta?.default_split||"train";
          return '<div class="mlb-mini-field"><span>Dataset</span><strong>'+(meta?.name||"No data")+'</strong></div>'+
                 '<div class="mlb-mini-field"><span>Split</span><strong>'+split+'</strong></div>';
        }
        return '<div class="mlb-mini-field"><span>Prompt</span><strong>'+String(node.params?.prompt||"Once upon a time")+'</strong></div>';
      }
      if(node.type==="train_test_split"){
        const s=splitPercentages(node),total=s.train+s.validation+s.test;
        return '<div class="mlb-mini-field"><span>Train</span><strong>'+s.train+'%</strong></div>'+ 
               '<div class="mlb-mini-field"><span>Validation</span><strong>'+s.validation+'%</strong></div>'+ 
               '<div class="mlb-mini-field"><span>Test</span><strong>'+s.test+'%</strong></div>'+ 
               '<div class="mlb-mini-field"><span>Total</span><strong>'+(total===100?'✓ 100%':'! '+total+'%')+'</strong></div>';
      }
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

    function loadTextDataStarter(){
      checkpoint("Load Default Data Pipeline");
      rememberWorkspaceView();
      state.active_workspace="data";
      const ws=state.workspaces.data;
      state.view_component_id=ws.root_component_id;
      state.breadcrumbs=[{id:ws.root_component_id,name:"Data Processing"}];
      ws.view_component_id=ws.root_component_id;
      ws.breadcrumbs=cp(state.breadcrumbs);

      const starter=defaultDataNodes();
      state.components[ws.root_component_id]={
        id:ws.root_component_id,
        name:"Data Processing",
        kind:"data",
        revision:1,
        nodes:starter.nodes,
        edges:starter.edges
      };
      selected=null;pendingPort=null;
      execution={status:"idle",overall:0,message:"Ready",nodes:{}};
      setStatus("Default pipeline restored: Hugging Face → Clean → Train/Val/Test → Tokenize → Prepared Dataset.");
      switchingWorkspace=true;
      draw();
    }

    function loadTinyStories(){
      checkpoint("Load TinyStories 30M");
      rememberWorkspaceView();
      state.active_workspace="model";
      const rootId=state.workspaces.model.root_component_id;
      state.root_component_id=rootId;
      state.view_component_id=rootId;
      state.project={
        ...(state.project||{}),
        name:"TinyStories 30M",
        context_length:512,
        batch_size:16,
        model_settings:{
          embedding_size:384,
          heads:6,
          block:512,
          default_batch:16,
          vocab_size:32000,
          precision:"fp16"
        },
        dataset:"TinyStories",
        estimated_parameters:"~30M"
      };
      state.breadcrumbs=[{id:rootId,name:"TinyStories 30M"}];
      state.workspaces.model.view_component_id=rootId;
      state.workspaces.model.breadcrumbs=cp(state.breadcrumbs);
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
      const input=makeNode(cat(catalog,"text_input"));configureTextInputForLatest(input);nodes.push(input);
      const emb=makeNode(cat(catalog,"embedding"));nodes.push(emb);
      for(let i=1;i<=6;i++)nodes.push({id:uid("node"),type:"custom",name:"Layer "+i,definition_id:defId,repeat:1,params:{},input_count:3,output_count:3,position:{x:0,y:0}});
      const head=makeNode(cat(catalog,"lm_head")),out=makeNode(cat(catalog,"text_output"));nodes.push(head,out);
      const edges=[];for(let i=0;i<nodes.length-1;i++)edges.push(edge(nodes[i].id,nodes[i+1].id));
      state.components[rootId]={id:rootId,name:"TinyStories 30M",kind:"model",revision:1,nodes,edges};
      syncModelSettingsToGraph(state.project.model_settings,state.project.model_settings);
      selected=null;pendingPort=null;setStatus("TinyStories starter loaded.");draw();
    }

    function loadSequentialPrebuiltModel(spec){
      checkpoint("Load "+spec.name);rememberWorkspaceView();state.active_workspace="model";
      const rootId=state.workspaces.model.root_component_id;state.root_component_id=rootId;state.view_component_id=rootId;
      state.project={...(state.project||{}),name:spec.name,context_length:spec.block,batch_size:spec.batch,
        model_settings:{embedding_size:spec.dim,heads:spec.heads,block:spec.block,default_batch:spec.batch,vocab_size:spec.vocab,precision:spec.precision||"fp16"},
        dataset:spec.dataset??null,estimated_parameters:spec.parameters,description:spec.description||""};
      state.breadcrumbs=[{id:rootId,name:spec.name}];state.workspaces.model.view_component_id=rootId;state.workspaces.model.breadcrumbs=cp(state.breadcrumbs);
      const input=makeNode(cat(catalog,"text_input"));configureTextInputForLatest(input);
      const emb=makeNode(cat(catalog,"embedding"));emb.name="Token Embedding";emb.params={...(emb.params||{}),vocab_size:spec.vocab,embedding_dim:spec.dim,hidden_size:spec.dim,dim:spec.dim,dtype:precisionToDtype(spec.precision||"fp16")};
      const core=makeNode(cat(catalog,spec.coreType));core.name=spec.coreName;core.params={...(core.params||{}),...cp(spec.coreParams||{})};
      const norm=makeNode(cat(catalog,"rmsnorm"));norm.name="Final RMSNorm";norm.params={...(norm.params||{}),normalized_shape:spec.dim,hidden_size:spec.dim,dim:spec.dim,eps:1e-6,elementwise_affine:true};
      const head=makeNode(cat(catalog,"lm_head"));head.name="LM Head";head.params={...(head.params||{}),hidden_size:spec.dim,dim:spec.dim,vocab_size:spec.vocab,bias:false,tie_embeddings:true};
      const out=makeNode(cat(catalog,"text_output"));const nodes=[input,emb,core,norm,head,out];const edges=[];for(let i=0;i<nodes.length-1;i++)edges.push(edge(nodes[i].id,nodes[i+1].id));
      state.components[rootId]={id:rootId,name:spec.name,kind:"model",revision:1,nodes,edges};syncModelSettingsToGraph(state.project.model_settings,state.project.model_settings);
      selected=null;pendingPort=null;setStatus(spec.name+" loaded.");draw();
    }

    function loadStateAwareESA200M(){loadSequentialPrebuiltModel({name:"StateAware ESA 200M",parameters:"199,982,344",description:"Notebook-matched 8-layer StateAware ESA model",dataset:null,
      dim:384,heads:6,block:256,batch:16,vocab:50257,precision:"fp16",coreType:"stateaware_esa_stack",coreName:"StateAware ESA ×8",
      coreParams:{dim:384,state_dim:2749,layers:8,heads:6,block:256,batch:16,depth_dim:64,compass:16,update_ratio_start:0.20,update_ratio_end:0.14,stream_ratio:1.08}});}

    function loadSOUP200M(){loadSequentialPrebuiltModel({name:"SOUP 200M",parameters:"199,916,160",description:"Notebook-matched SOUP 200M with three physical layers",dataset:null,
      dim:1152,heads:18,block:256,batch:16,vocab:50257,precision:"fp16",coreType:"soup",coreName:"SOUP ×3",
      coreParams:{dim:1152,width:2864,depth:3,mixer:"esa",ffn:"saffn",mixer_config:{head:18,batch:16,block:256,compass:16,auto_compile:false},ffn_config:{depth_dim:128},memory_dim:256,fusion_hidden:1728}});}

    function loadSOUP30M1L(){loadSequentialPrebuiltModel({name:"SOUP 30M 1L",parameters:"30,003,528",description:"One-layer SOUP causal LM at ~30M parameters",dataset:"TinyStories",
      dim:384,heads:6,block:512,batch:16,vocab:50257,precision:"fp16",coreType:"soup",coreName:"SOUP ×1",
      coreParams:{dim:384,width:1408,depth:1,mixer:"esa",ffn:"saffn",mixer_config:{head:6,batch:16,block:512,compass:16,auto_compile:false},ffn_config:{depth_dim:64},memory_dim:128,fusion_hidden:928}});}

    function safeFilename(name){
      const base=String(name||"mlbricks-design").trim().replace(/[^a-zA-Z0-9._-]+/g,"-").replace(/^-+|-+$/g,"");
      return base||"mlbricks-design";
    }

    function sanitizedProjectState(){
      const clean=cp(state);
      delete clean._runtime_command;
      delete clean._session_secrets;
      return clean;
    }

    function designPayload(){
      rememberWorkspaceView();
      return {
        format:"mlbricks-builder-design",
        format_version:"0.7.5",
        builder_version:"0.7.44",
        saved_at:new Date().toISOString(),
        state:sanitizedProjectState()
      };
    }

    function downloadDesignBlob(blob,filename){
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }

    function saveDesignBin(){
      const json=JSON.stringify(designPayload());
      const magic=new TextEncoder().encode("MLBRICKS-BIN-1\n");
      const payloadBytes=new TextEncoder().encode(json);
      const bytes=new Uint8Array(magic.length+payloadBytes.length);
      bytes.set(magic,0);bytes.set(payloadBytes,magic.length);
      downloadDesignBlob(new Blob([bytes],{type:"application/octet-stream"}),safeFilename(state.project?.name)+".mlbricks.bin");
      setStatus("Binary design saved.");draw();
    }

    function saveDesign(){
      const blob=new Blob([JSON.stringify(designPayload(),null,2)],{type:"application/json"});
      downloadDesignBlob(blob,safeFilename(state.project?.name)+".mlbricks.json");
      setStatus("JSON design saved.");draw();
    }

    function saveDesignChoice(){
      const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
      const choice=(win&&typeof win.prompt==="function")
        ? String(win.prompt('Save project as "bin" or "json":','bin')||"").trim().toLowerCase()
        : "bin";
      if(!choice){setStatus("Save cancelled.");return;}
      if(choice==="bin"||choice==="binary"||choice==="b")return saveDesignBin();
      if(choice==="json"||choice==="j")return saveDesign();
      setStatus('Unknown save type: '+choice+' — use "bin" or "json".');
    }

    function exportWorkspace(){
      if(state.active_workspace==="model"){
        const model=modelRootComponent();
        if(model){downloadModelConfig();return;}
      }
      const payload={
        format:"mlbricks-export",
        builder_version:"0.7.44",
        workspace:state.active_workspace,
        project:cp(state.project||{}),
        prepared_datasets:cp(state.prepared_datasets||[]),
        model_outputs:cp(state.model_outputs||[]),
        project_files:cp(state.project_files||[]),
        current_component:cp(current(state))
      };
      const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
      downloadDesignBlob(blob,safeFilename(state.project?.name||workspaceName())+"."+state.active_workspace+".export.json");
      setStatus((state.active_workspace==="model"?"Model":"Data")+" export downloaded.");
      draw();
    }

    async function shareWorkspace(){
      const lines=[
        "MLBricks Builder — "+(state.project?.name||workspaceName()),
        "Version: 0.7.44",
        "Workspace: "+workspaceName(),
        "Nodes: "+(current(state).nodes||[]).length,
        "Connections: "+(current(state).edges||[]).length
      ];
      const activeModel=selectedOutputModel()||builtModelById(outputDirectorySelection)||((state.model_outputs||[]).slice(-1)[0]||null);
      const serve=activeModel?.serve_runtime||{};
      const url=serve.public_url||serve.local_url||activeModel?.serve_urls?.public_url||activeModel?.serve_urls?.local_url||"";
      if(url)lines.push("Access URL: "+url);
      lines.push("Tip: use Save to send the full .mlbricks project file.");
      await copyTextRobust(lines.join("\n"),"share summary");
    }

    function showQuickHelp(){
      const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
      const help=[
        'MLBricks Builder v0.7.44',
        '',
        '• Add components or data steps from the left library.',
        '• Export downloads a model config or workspace export file.',
        '• Load opens .mlbricks.json or .mlbricks.bin files.',
        '• Select a node to edit config and read what it does in Inspector.',
      ].join('\n');
      if(win&&typeof win.alert==="function")win.alert(help);
      setStatus("Help opened.");
    }

    function openBuilderSettings(){
      const win=(root.ownerDocument&&root.ownerDocument.defaultView)||window;
      const currentName=state.project?.name||"Untitled Model";
      const nextName=win&&typeof win.prompt==="function"
        ? win.prompt("Project name:",currentName)
        : currentName;
      if(nextName===null){setStatus("Settings unchanged.");return;}
      const cleaned=String(nextName||"").trim();
      if(!cleaned){setStatus("Project name cannot be empty.");return;}
      checkpoint("Update project settings");
      state.project=state.project||{};
      state.project.name=cleaned;
      const modelId=state.workspaces?.model?.root_component_id||state.root_component_id;
      if(modelId&&state.components?.[modelId]&&!state.components[modelId].name)state.components[modelId].name=cleaned;
      if(Array.isArray(state.breadcrumbs)&&state.breadcrumbs.length)state.breadcrumbs[0].name=cleaned;
      if(state.workspaces?.model?.breadcrumbs?.length)state.workspaces.model.breadcrumbs[0].name=cleaned;
      setStatus("Project settings updated.");
      draw();
    }

    function loadDesign(){
      const input=document.createElement("input");
      input.type="file";
      input.accept=".json,.mlbricks,.bin,.mlbricks.bin,application/json,application/octet-stream";
      input.style.display="none";
      input.addEventListener("change",()=>{
        const file=input.files?.[0];
        if(!file){input.remove();return;}
        const reader=new FileReader();
        reader.onload=()=>{
          try{
            const bytes=new Uint8Array(reader.result);
            const magic="MLBRICKS-BIN-1\n";
            const magicBytes=new TextEncoder().encode(magic);
            let isBin=bytes.length>=magicBytes.length;
            for(let i=0;i<magicBytes.length&&isBin;i++) if(bytes[i]!==magicBytes[i])isBin=false;
            const text=new TextDecoder().decode(isBin?bytes.slice(magicBytes.length):bytes);
            const parsed=JSON.parse(text);
            const incoming=parsed.state||parsed;
            if(!incoming||!incoming.components||!incoming.root_component_id) throw new Error("This file is not an MLBricks Builder design.");
            checkpoint("Load design");
            state=cp(incoming);
            Object.values(state.components||{}).forEach(c=>{if(!c.edges)c.edges=[];});
            ensureWorkspaces();
            if(!state.view_component_id||!state.components[state.view_component_id])state.view_component_id=state.root_component_id;
            if(!Array.isArray(state.breadcrumbs)||!state.breadcrumbs.length)state.breadcrumbs=[{id:state.root_component_id,name:state.project?.name||"Model"}];
            selected=null;pendingPort=null;switchingWorkspace=true;
            setStatus((isBin?"Binary":"JSON")+" design loaded: "+file.name);
            draw();
          }catch(err){
            alert("Could not load design: "+err.message);setStatus("Design load failed.");draw();
          }finally{input.remove();}
        };
        reader.readAsArrayBuffer(file);
      });
      document.body.appendChild(input);input.click();
    }

    function draw(){
      if(pointerInteractionActive){
        deferredInteractionDraw=true;
        return;
      }
      if(bottomView==="hub")bottomView="cloud";
      const wsKey=state.active_workspace||"model";
      const oldCanvas=root.querySelector(".mlb-canvas");
      if(oldCanvas && !switchingWorkspace){
        workspaceScroll[wsKey]={left:oldCanvas.scrollLeft,top:oldCanvas.scrollTop};
      }
      const oldSidebar=root.querySelector(".mlb-sidebar");
      if(oldSidebar){
        sidebarScroll[wsKey]={left:oldSidebar.scrollLeft,top:oldSidebar.scrollTop};
      }
      const oldInspectorBody=root.querySelector(".mlb-ins-body");
      if(oldInspectorBody && lastInspectorRenderKey){
        inspectorScrollPositions[lastInspectorRenderKey]={left:oldInspectorBody.scrollLeft,top:oldInspectorBody.scrollTop};
      }
      switchingWorkspace=false;
      rememberWorkspaceView();
      root.innerHTML="";

      // Top bar
      const top=document.createElement("div");top.className="mlb-topbar";
      const frontendVersion=root.dataset.mlbricksBuilderVersion||"0.7.44";

      const topLeft=document.createElement("div");topLeft.className="mlb-top-left";
      const logo=document.createElement("div");logo.className="mlb-logo";logo.innerHTML='<img class="mlb-logo-brand" src="data:image/png;base64,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" alt="MLBricks AI Builder"><span class="mlb-beta">v'+frontendVersion+'</span>';
      const title=document.createElement("div");
      title.className="mlb-project-title mlb-project-title-editable";
      title.textContent=state.project?.name||"Untitled Model";
      title.contentEditable="true";
      title.spellcheck=false;
      title.title="Click to rename model";
      title.setAttribute("role","textbox");
      title.setAttribute("aria-label","Model name");
      title.addEventListener("focus",()=>{title.dataset.originalName=title.textContent||"";});
      title.addEventListener("keydown",ev=>{
        if(ev.key==="Enter"){ev.preventDefault();title.blur();}
        else if(ev.key==="Escape"){
          ev.preventDefault();title.textContent=title.dataset.originalName||state.project?.name||"Untitled Model";title.blur();
        }
      });
      title.addEventListener("blur",()=>renameProjectInline(title.textContent));
      const saved=document.createElement("div");saved.className="mlb-save-state";saved.textContent="• Saved";
      topLeft.append(logo,title,saved);
      top.appendChild(topLeft);

      // Primary controls: Build and Gallery. Cloud & Repositories lives in the former Share slot on the right.
      const primary=document.createElement("div");primary.className="mlb-top-primary";
      const modelRuntimeBusy=state.active_workspace==="model" && execution.status==="running" &&
        (execution.runtime_kind==="train"||execution.runtime_kind==="generate");
      const run=state.active_workspace==="model"
        ?actionBtn(
            modelRuntimeBusy
              ?(execution.runtime_kind==="train"?"Training":"Generating")
              :"Build",
            "mlb-run mlb-build mlb-top-build-tab"+(modelRuntimeBusy?" runtime-busy "+execution.runtime_kind:""),
            modelRuntimeBusy?"activity":"build"
          )
        :actionBtn("Fetch Data","mlb-run mlb-build mlb-top-build-tab","fetch");
      run.disabled=modelRuntimeBusy;
      run.addEventListener("click",()=>{
        if(galleryWorkspace.open){closeGallery();return;}
        if(cloudWorkspace.open){closeCloudWorkspace();return;}
        (state.active_workspace==="model"?requestModelBuild:requestRun)();
      });
      primary.appendChild(run);

      const dataFetchBusy=state.active_workspace==="data"&&execution.status==="running"&&execution.runtime_kind==="data";
      const stopBtn=actionBtn("Stop","mlb-stop mlb-center-stop","stop");
      stopBtn.addEventListener("click",requestStop);
      stopBtn.style.display=(dataFetchBusy||modelRuntimeBusy)?"inline-flex":"none";
      // Keep the hidden control mounted for Data so it appears instantly beside Fetch when work starts.
      if(state.active_workspace==="data" || modelRuntimeBusy)primary.appendChild(stopBtn);

      // Header polish patch: keep action icons visible for Build/Gallery.
      const galleryBtn=actionBtn("Gallery","mlb-dark-btn mlb-top-gallery-btn"+(galleryWorkspace.open?" active":""),"gallery");
      galleryBtn.title="Open prebuilt Models, Components and Data";
      galleryBtn.addEventListener("click",()=>galleryWorkspace.open?closeGallery():openGallery(galleryWorkspace.tab));
      primary.appendChild(galleryBtn);
      top.appendChild(primary);

      const acts=document.createElement("div");acts.className="mlb-top-actions";
      const undoBtn=btn("↶ Undo","mlb-dark-btn mlb-history-btn");undoBtn.disabled=undoStack.length===0;undoBtn.title="Undo last model edit";undoBtn.addEventListener("click",undo);
      const redoBtn=btn("↷ Redo","mlb-dark-btn mlb-history-btn");redoBtn.disabled=redoStack.length===0;redoBtn.title="Redo last undone edit";redoBtn.addEventListener("click",redo);
      const clearBtn=btn("↻ Clear","mlb-dark-btn");clearBtn.disabled=layoutIsLocked();clearBtn.addEventListener("click",()=>{
        if(!requireEditableLayout("clear components"))return;
        const c=current(state);if(!c.nodes.length&&!c.edges.length)return;
        checkpoint("Clear graph");c.nodes=[];c.edges=[];selected=null;pendingPort=null;setStatus("Graph cleared.");draw();
      });
      const cloudBtn=actionBtn("Cloud & Repositories","mlb-dark-btn mlb-top-cloud-btn mlb-top-cloud-action"+(cloudWorkspace.open?" active":""),"cloud");
      cloudBtn.title="Open Cloud & Repositories";
      cloudBtn.addEventListener("click",()=>cloudWorkspace.open?closeCloudWorkspace():openCloudWorkspace());
      const fullBtn=!isPopout?document.createElement("a"):null;
      if(fullBtn){
        fullBtn.className="mlb-dark-btn mlb-full-window-btn";
        fullBtn.textContent="↗ Full Window";
        fullBtn.href="#";
        fullBtn.title="Open MLBricks Builder in a separate full-window browser tab";
        fullBtn.addEventListener("click",activateFullWindowLink);
      }
      acts.append(undoBtn,redoBtn,clearBtn,cloudBtn);
      if(fullBtn)acts.appendChild(fullBtn);
      top.appendChild(acts);
      root.appendChild(top);

      const shell=document.createElement("div");shell.className="mlb-shell";

      // Sidebar
      const side=document.createElement("aside");side.className="mlb-sidebar";
      const head=document.createElement("div");head.className="mlb-sidehead";head.innerHTML="<span>"+(state.active_workspace==="data"?"DATA LIBRARY":"COMPONENT LIBRARY")+"</span><span>×</span>";side.appendChild(head);
      const sr=document.createElement("div");sr.className="mlb-search-row";
      const searchInput=document.createElement("input");searchInput.className="mlb-search";searchInput.placeholder="Search...";searchInput.setAttribute("aria-label",state.active_workspace==="data"?"Search data steps":"Search components");searchInput.value=search;searchInput.addEventListener("input",()=>{
        search=searchInput.value;
        searchFocusRestore={start:searchInput.selectionStart??search.length,end:searchInput.selectionEnd??search.length};
        draw();
      });
      sr.append(searchInput,btn("☷","mlb-filter-btn"));side.appendChild(sr);
      const workspaceBox=document.createElement("div");workspaceBox.className="mlb-workspace-box";
      const workspaceLabel=document.createElement("label");workspaceLabel.textContent="BUILD WORKSPACE";
      const workspaceSelect=document.createElement("select");workspaceSelect.className="mlb-workspace-select";
      [["model","Model Builder"],["data","Data Processing"]].forEach(([value,label])=>{
        const o=document.createElement("option");o.value=value;o.textContent=label;
        if(state.active_workspace===value)o.selected=true;
        workspaceSelect.appendChild(o);
      });
      workspaceSelect.addEventListener("change",()=>switchWorkspace(workspaceSelect.value));
      workspaceBox.append(workspaceLabel,workspaceSelect);
      side.insertBefore(workspaceBox,sr);

      const visible=catalog.filter(item=>{
        // Some MLBricks APIs are code-level composition containers rather than
        // visual Builder components. Keep them in the catalog/API registry for
        // backward compatibility, but do not show them in the component library.
        if(item.library_hidden===true)return false;
        if(itemWorkspace(item)!==state.active_workspace)return false;
        const q=(item.name+" "+item.description+" "+item.category).toLowerCase();
        return !search || q.includes(search.toLowerCase());
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
            const b=document.createElement("button");b.type="button";b.dataset.type=item.type||"";
            const ico=document.createElement("span");ico.className="mlb-pal-icon";ico.textContent=compactIconLabel(item.icon||"ML");
            const text=document.createElement("span");text.innerHTML="<strong>"+item.name+'</strong><span class="mlb-pal-sub">'+(item.description||"MLBricks component")+"</span>";
            b.append(ico,text);b.disabled=layoutIsLocked();b.title=layoutIsLocked()?"Layout locked — click Edit Layout first":"Add "+item.name;b.addEventListener("click",()=>addPrimitive(item));pal.appendChild(b);
          });
        }
        side.appendChild(pal);
      });

      if(state.active_workspace==="model"){
        const mh=document.createElement("button");
        mh.type="button";
        mh.className="mlb-category";
        mh.setAttribute("aria-expanded",String(!myBricksCollapsed));
        mh.innerHTML="<span>MY COMPONENTS</span><span class='mlb-category-caret'>"+(myBricksCollapsed?"▸":"▾")+"</span>";
        mh.addEventListener("click",()=>{myBricksCollapsed=!myBricksCollapsed;draw();});
        side.appendChild(mh);

        if(!myBricksCollapsed){
          Object.values(state.custom_components||{}).filter(def=>def.palette_hidden!==true).forEach(def=>{
            const wrap=document.createElement("div");wrap.className="mlb-custom-card-wrap";
            const row=document.createElement("div");row.className="mlb-custom-card-row";
            const b=document.createElement("button");b.className="mlb-custom-card";b.type="button";
            const isApi=String(def.implementation||"graph")==="api";
            const emptyLabel=isApi?(" · "+(def.api_binding?.import_path||"API not bound")):((def.nodes||[]).length===0?" · Empty":" · "+(def.nodes||[]).length+" components");
            b.innerHTML='<span class="mlb-pal-icon">'+(isApi?"API":"MY")+'</span><span><strong>'+def.name+'</strong><span class="mlb-pal-sub">'+(isApi?"API Custom":"Custom")+' · v'+def.revision+emptyLabel+"</span></span>";
            b.disabled=layoutIsLocked();b.title=layoutIsLocked()?"Layout locked — click Edit Layout first":"Add "+def.name;b.addEventListener("click",()=>addCustom(def));
            const edit=document.createElement("button");edit.type="button";edit.className="mlb-custom-edit-icon";edit.textContent="✎";edit.title="Edit custom component";edit.setAttribute("aria-label","Edit "+def.name);
            edit.addEventListener("click",ev=>{ev.stopPropagation();customActionMenuId=customActionMenuId===def.id?null:def.id;draw();});
            row.append(b,edit);wrap.appendChild(row);
            if(customActionMenuId===def.id){
              const menu=document.createElement("div");menu.className="mlb-custom-card-menu";
              const editAction=btn("Edit","mlb-custom-menu-action");editAction.addEventListener("click",()=>editCustomDefinition(def));
              const renameAction=btn("Rename","mlb-custom-menu-action");renameAction.addEventListener("click",()=>renameCustomDefinition(def));
              const removeAction=btn("Remove","mlb-custom-menu-action danger");removeAction.addEventListener("click",()=>removeCustomFromPalette(def));
              menu.append(editAction,renameAction,removeAction);wrap.appendChild(menu);
            }
            side.appendChild(wrap);
          });
        }
      }

      const sidePos=sidebarScroll[state.active_workspace]||{left:0,top:0};
      requestAnimationFrame(()=>{
        side.scrollLeft=sidePos.left||0;
        side.scrollTop=sidePos.top||0;
      });

      // Main
      const main=document.createElement("main");main.className="mlb-main";
      const toolbar=document.createElement("div");toolbar.className="mlb-toolbar";
      const workspaceBadge=document.createElement("div");workspaceBadge.className="mlb-workspace-badge";
      workspaceBadge.textContent=galleryWorkspace.open
        ?"GALLERY"
        :cloudWorkspace.open
        ?"CLOUD & REPOSITORIES"
        :runtimePanel
        ?(runtimePanel.mode==="train"
          ?((runtimePanel.tab||"setup")==="status"?"TRAINING STATUS":"TRAINING SETUP")
          :runtimePanel.mode==="generate"
            ?((runtimePanel.tab||"setup")==="status"?"GENERATION STATUS":"GENERATION SETUP")
            :((runtimePanel.tab||"setup")==="status"?"API SERVER STATUS":"API SERVER SETUP"))
        :workspaceName();
      toolbar.appendChild(workspaceBadge);

      if(galleryWorkspace.open){
        const gname=document.createElement("div");gname.className="mlb-runtime-toolbar-name";gname.textContent=galleryWorkspace.tab==="models"?"Models":galleryWorkspace.tab==="components"?"Components":"Data";toolbar.appendChild(gname);
        const tsp=document.createElement("div");tsp.className="mlb-toolspacer";toolbar.appendChild(tsp);
        const close=btn("× Close","mlb-tool mlb-gallery-toolbar-close");close.addEventListener("click",closeGallery);toolbar.appendChild(close);
      }else if(cloudWorkspace.open){
        const cname=document.createElement("div");cname.className="mlb-runtime-toolbar-name";cname.textContent=providerLabel(cloudForm.provider);toolbar.appendChild(cname);
        const tsp=document.createElement("div");tsp.className="mlb-toolspacer";toolbar.appendChild(tsp);
        const close=btn("× Close","mlb-tool mlb-gallery-toolbar-close");close.addEventListener("click",closeCloudWorkspace);toolbar.appendChild(close);
      }else if(runtimePanel && state.active_workspace==="model"){
        const entry=builtModelById(runtimePanel.modelId);
        if(entry){const name=document.createElement("div");name.className="mlb-runtime-toolbar-name";name.textContent=entry.name;toolbar.appendChild(name);}
        const tsp=document.createElement("div");tsp.className="mlb-toolspacer";toolbar.appendChild(tsp);
        const device=entry?selectedRuntimeDevice(runtimePanel.mode==="train"?entry.training_config:runtimePanel.mode==="generate"?entry.generation_config:entry.serve_config):null;
        if(device){const d=document.createElement("div");d.className="mlb-toolbar-device";d.textContent=device.label;toolbar.appendChild(d);}
      }else{
        const lockToggle=btn(layoutIsLocked()?"✎ Edit Layout":"🔒 Lock Layout","mlb-tool mlb-layout-toggle"+(layoutIsLocked()?" locked":" editing"));
        lockToggle.title=layoutIsLocked()?"Unlock structural editing":"Protect component positions, order and connections";
        lockToggle.addEventListener("click",toggleLayoutLock);
        toolbar.append(lockToggle);

        if(state.active_workspace==="data"){
          const kernel=document.createElement("div");kernel.className="mlb-kernel-badge";
          toolbar.appendChild(kernel);
          const live=document.createElement("div");live.className="mlb-run-live "+(execution.status||"idle");
          live.innerHTML="<strong>"+Math.max(0,Math.min(100,Number(execution.overall||0)))+"%</strong><span>"+(execution.message||"Ready")+"</span>";
          toolbar.appendChild(live);
          const latest=latestPreparedDataset();
          if(latest){
            const ready=document.createElement("div");ready.className="mlb-data-ready-chip";
            ready.textContent=compactDatasetSummary(latest);
            ready.title=latest.name+" — latest prepared dataset available to Model Builder Text Input";
            toolbar.appendChild(ready);
          }
          requestAnimationFrame(updateKernelBadge);
        }
        const tsp=document.createElement("div");tsp.className="mlb-toolspacer";toolbar.appendChild(tsp);
        const toggle=document.createElement("label");toggle.className="mlb-toggle";
        const cb=document.createElement("input");cb.type="checkbox";cb.checked=!!state.auto_connect;cb.disabled=layoutIsLocked();
        cb.addEventListener("change",()=>{if(!requireEditableLayout("change Auto Connect"))return;checkpoint("Change Auto Connect");state.auto_connect=cb.checked;draw();});
        toggle.append(document.createTextNode("Auto Connect"),cb);toolbar.appendChild(toggle);

        const z=document.createElement("div");z.className="mlb-zoom";
        const zm=btn("−");zm.addEventListener("click",()=>{zoom=Math.max(.65,zoom-.1);draw();});
        const zs=document.createElement("span");zs.textContent=Math.round(zoom*100)+"%";
        const zp=btn("+");zp.addEventListener("click",()=>{zoom=Math.min(1.5,zoom+.1);draw();});
        z.append(zm,zs,zp);toolbar.appendChild(z);
      }
      if(!galleryWorkspace.open&&!cloudWorkspace.open)main.appendChild(toolbar);

      const canvas=document.createElement("div");canvas.className="mlb-canvas"+((runtimePanel||galleryWorkspace.open||cloudWorkspace.open)?" runtime-active":"");
      if(galleryWorkspace.open){
        renderCentralGallery(canvas);
      }else if(cloudWorkspace.open){
        renderCentralCloud(canvas);
      }
      if(runtimePanel && state.active_workspace==="model"){
        const entry=builtModelById(runtimePanel.modelId);
        if(entry){renderRuntimeWorkspace(canvas,entry,runtimePanel.mode);}
        else{runtimePanel=null;}
      }
      const ctop=document.createElement("div");ctop.className="mlb-canvas-top";
      const crumbs=document.createElement("div");crumbs.className="mlb-breadcrumbs";
      state.breadcrumbs.forEach((c,i)=>{const b=btn(c.name,"mlb-crumb");b.addEventListener("click",()=>{state.view_component_id=c.id;state.breadcrumbs=state.breadcrumbs.slice(0,i+1);selected=null;draw();});crumbs.appendChild(b);if(i<state.breadcrumbs.length-1){const s=document.createElement("span");s.textContent="/";crumbs.appendChild(s);}});
      ctop.appendChild(crumbs);canvas.appendChild(ctop);

      const mini=document.createElement("div");mini.className="mlb-minimap";
      const miniTitle=document.createElement("div");miniTitle.className="mlb-minimap-title";miniTitle.textContent=state.active_workspace==="data"?"DATA BLUEPRINT":"MODEL BLUEPRINT";
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
        const e=document.createElement("div");e.className="mlb-empty";
        if(comp.kind==="custom_edit"){
          const def=state.custom_components?.[comp.definition_id];
          e.innerHTML=String(def?.implementation||"graph")==="api"
            ?"<strong>API-bound custom component.</strong><br><br>Configure the Python API, target type and typed arguments in Inspector on the right."
            :"<strong>Empty custom component.</strong><br><br>Add internal components from the left. Nothing from the parent model is copied into this shell.";
        }else if(state.active_workspace==="data"){
          e.innerHTML="<strong>Build your data pipeline step by step.</strong><br><br>Start with Hugging Face, Kaggle, URL, Local or Manual Data.";
        }else{
          e.innerHTML="<strong>Build your model layer by layer.</strong><br><br>Add a component from the left or open Gallery to load a sample model.";
        }
        flow.appendChild(e);
      }else{
        comp.nodes.forEach((n,i)=>{
          if(i){const a=document.createElement("div");a.className="mlb-arrow";a.textContent="→";flow.appendChild(a);}
          const info=n.type==="custom"?{accent:"purple",description:"Nested reusable layer",icon:"LAY",api:[]}:cat(catalog,n.type);
          const runState=execution.nodes?.[n.id];
          const card=document.createElement("div");
          card.className="mlb-node"+(selected===n.id?" selected":"")+(runState?" run-"+runState.status:"");card.dataset.type=n.type||"";
          card.dataset.nodeId=n.id;card.dataset.accent=info.accent||"purple";
          card.innerHTML='<span class="index">'+(i+1)+'</span>'+portButtons(n,"in")+'<div class="node-head"><div class="node-name"></div><div class="node-icon"></div></div><div class="node-desc"></div><div class="mlb-node-fields"></div><div class="node-meta"></div>'+portButtons(n,"out");
          if(runState){
            const rb=document.createElement("div");rb.className="mlb-run-badge";rb.textContent=runLabel(runState.status);rb.title=runState.message||"";card.appendChild(rb);
            if(runState.status==="running"){const rt=document.createElement("div");rt.className="mlb-run-track";rt.innerHTML="<i></i>";card.appendChild(rt);}
          }
          card.querySelector(".node-name").textContent=nodeDisplayName(n);card.querySelector(".node-icon").textContent=compactIconLabel(info.icon||"ML");card.querySelector(".node-desc").textContent=info.description||"MLBricks layer";
          if(n.type==="custom"){
            const def=state.custom_components?.[n.definition_id];const isApi=String(def?.implementation||"graph")==="api";
            card.querySelector(".mlb-node-fields").innerHTML=isApi
              ?('<div class="mlb-mini-field"><span>API</span><strong>'+(def?.api_binding?.import_path||"Not bound")+'</strong></div>'+ '<div class="mlb-mini-field"><span>Args</span><strong>'+((def?.api_binding?.parameters||[]).length)+'</strong></div>')
              :('<div class="mlb-mini-field"><span>Architecture</span><strong>Open</strong></div>'+ '<div class="mlb-mini-field"><span>Ports</span><strong>Skip / Main / Extra</strong></div>');
          }else card.querySelector(".mlb-node-fields").innerHTML=nodeMiniFields(n,info);
          card.querySelectorAll(".mlb-mini-field").forEach(row=>{
            const label=row.querySelector("span");
            const value=row.querySelector("strong");
            if(label)label.title=label.textContent||"";
            if(value)value.title=value.textContent||"";
          });
          const meta=card.querySelector(".node-meta");
          if(n.type==="custom"){
            const def=state.custom_components?.[n.definition_id];meta.textContent=String(def?.implementation||"graph")==="api"?"API-bound component · lazy import":"Nested component · 3-lane interface";
          }else meta.textContent=(apiInfo(n).public_name||n.type)+" · Skip / Main / Extra";
          card.querySelectorAll('.mlb-port').forEach(portEl=>{
            const side=portEl.dataset.side, idx=Number(portEl.dataset.portIndex||0);
            if(pendingPort?.nodeId===n.id&&pendingPort.side===side&&pendingPort.portIndex===idx) portEl.classList.add("armed");
            portEl.addEventListener("click",ev=>portClick(n.id,side,idx,ev));
          });
          card.addEventListener("click",()=>{outputDirectorySelection=null;selected=n.id;draw();});card.addEventListener("dblclick",()=>{if(n.definition_id)openInside(n);});
          flow.appendChild(card);
        });
      }
      wrap.appendChild(flow);canvas.appendChild(wrap);
      const hint=document.createElement("div");hint.className="mlb-hint";
      hint.textContent=pendingPort
        ?"Choose the matching lane: Top ↔ Top, Main ↔ Main, Bottom ↔ Bottom."
        :(state.active_workspace==="data"
          ?"Build left to right: one Data Source → Processing → Train/Val/Test → Tokenize → Prepared Dataset. Open Gallery to load a sample pipeline."
          :"Select a node before adding a component to insert after it. Use Move Left / Move Right in Inspector to reorder. Main flow rewires automatically.");
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
        const pos=workspaceScroll[state.active_workspace]||{left:0,top:0};
        canvas.scrollLeft=pos.left||0;
        canvas.scrollTop=pos.top||0;
      });

      // Bottom project drawer is open by default. Train/Generate collapse it on
      // entry; normal design, local import and Serve Model/API keep it open.
      const details=document.createElement("div");details.className="mlb-details";

      const detailsBar=document.createElement("div");detailsBar.className="mlb-details-bar";
      const detailsLeft=document.createElement("div");detailsLeft.className="mlb-details-left";
      const detailsTitle=document.createElement("span");detailsTitle.className="mlb-details-title";
      detailsTitle.textContent=state.active_workspace==="data"?"DATA WORKSPACE":"MODEL WORKSPACE";

      const detailsSelect=document.createElement("select");detailsSelect.className="mlb-details-select";
      const options=state.active_workspace==="data"
        ?[["details","Pipeline Details"],["outputs","Output Directory"],["files","Files"],["local","Local Environment"]]
        :[["details","Model Details"],["outputs","Output Directory"],["files","Files"],["local","Local Environment"]];
      options.forEach(([value,label])=>{
        const o=document.createElement("option");o.value=value;o.textContent=label;
        if(bottomView===value)o.selected=true;
        detailsSelect.appendChild(o);
      });
      detailsSelect.addEventListener("change",ev=>{
        ev.stopPropagation();
        bottomView=detailsSelect.value;
        bottomExpanded=true;
        outputDirectorySelection=null;
        draw();
      });
      detailsLeft.append(detailsTitle,detailsSelect);

      const detailsToggle=btn(bottomExpanded?"▾ Hide":"▴ Show","mlb-details-toggle");
      detailsToggle.addEventListener("click",()=>{bottomExpanded=!bottomExpanded;draw();});
      detailsBar.append(detailsLeft,detailsToggle);
      details.appendChild(detailsBar);

      if(bottomView==="outputs"){
        const outputPanel=document.createElement("div");
        outputPanel.className="mlb-output-directory"+(bottomExpanded?" expanded":" collapsed");
        if(bottomExpanded)renderOutputDirectory(outputPanel);
        details.appendChild(outputPanel);
      }else if(bottomView==="files"){
        const filesPanel=document.createElement("div");
        filesPanel.className="mlb-files-view"+(bottomExpanded?" expanded":" collapsed");
        if(bottomExpanded)renderFilesView(filesPanel);
        details.appendChild(filesPanel);
      }else if(bottomView==="local"){
        const localPanelEl=document.createElement("div");
        localPanelEl.className="mlb-local-view"+(bottomExpanded?" expanded":" collapsed");
        if(bottomExpanded)renderLocalView(localPanelEl);
        details.appendChild(localPanelEl);
      }else if(bottomView==="cloud"){
        const cloudPanelEl=document.createElement("div");
        cloudPanelEl.className="mlb-cloud-view"+(bottomExpanded?" expanded":" collapsed");
        if(bottomExpanded)renderCloudView(cloudPanelEl);
        details.appendChild(cloudPanelEl);
      }else{
        const panels=document.createElement("div");panels.className="mlb-bottom-panels"+(bottomExpanded?" expanded":" collapsed");
        const p1=document.createElement("div");p1.className="mlb-bottom-card";
        const p2=document.createElement("div");p2.className="mlb-bottom-card";
        const p3=document.createElement("div");p3.className="mlb-bottom-card";
        const p4=document.createElement("div");p4.className="mlb-bottom-card";

        if(state.active_workspace==="data"){
          p1.innerHTML='<div class="mlb-bottom-title">GALLERY</div><div class="mlb-preset-card"><strong>▦ Sample & Saved Data</strong>Open sample data pipelines or reuse pipelines saved by you.</div>';
          p1.querySelector(".mlb-preset-card").addEventListener("click",openGallery);
          p2.innerHTML='<div class="mlb-bottom-title">PIPELINE INFO</div><div class="mlb-stat-row"><span>Steps</span><strong>'+current(state).nodes.length+'</strong></div><div class="mlb-stat-row"><span>Connections</span><strong>'+(current(state).edges||[]).length+'</strong></div><div class="mlb-stat-row"><span>Workspace</span><strong>Data</strong></div><div class="mlb-stat-row"><span>Status</span><strong class="mlb-good">✓ Designed</strong></div>';
          const latestData=latestPreparedDataset();
          p3.innerHTML=latestData
            ?('<div class="mlb-bottom-title">LATEST DATA</div>'+
              '<div class="mlb-stat-row"><span>Name</span><strong>'+latestData.name+'</strong></div>'+
              '<div class="mlb-stat-row"><span>Train</span><strong>'+splitRows(latestData,"train")+'</strong></div>'+
              '<div class="mlb-stat-row"><span>Validation</span><strong>'+splitRows(latestData,"validation")+'</strong></div>'+
              '<div class="mlb-stat-row"><span>Test</span><strong>'+splitRows(latestData,"test")+'</strong></div>')
            :'<div class="mlb-bottom-title">PROCESSING</div><div class="mlb-stat-row"><span>Text</span><strong>Clean / Tokenize</strong></div><div class="mlb-stat-row"><span>Image</span><strong>Resize / Crop</strong></div><div class="mlb-stat-row"><span>Audio</span><strong>Resample / Normalize</strong></div><div class="mlb-stat-row"><span>Split</span><strong>Train / Val / Test</strong></div>';
          p4.innerHTML='<div class="mlb-bottom-title">FLOW</div><div class="mlb-stat-row"><span>Main</span><strong>Processing order</strong></div><div class="mlb-stat-row"><span>Skip</span><strong>Optional branch</strong></div><div class="mlb-stat-row"><span>Extra</span><strong>Aux data</strong></div>';
        }else{
          p1.innerHTML='<div class="mlb-bottom-title">GALLERY</div><div class="mlb-preset-card"><strong>▦ Sample & Saved Models</strong>Open sample architectures or reuse models saved by you.</div>';
          p1.querySelector(".mlb-preset-card").addEventListener("click",openGallery);
          p2.innerHTML='<div class="mlb-bottom-title">GRAPH INFO</div><div class="mlb-stat-row"><span>Layers</span><strong>'+current(state).nodes.length+'</strong></div><div class="mlb-stat-row"><span>Connections</span><strong>'+(current(state).edges||[]).length+'</strong></div><div class="mlb-stat-row"><span>Context</span><strong>'+(state.project?.context_length||"—")+'</strong></div><div class="mlb-stat-row"><span>Batch Size</span><strong>'+(state.project?.batch_size||"—")+'</strong></div><div class="mlb-stat-row"><span>Status</span><strong class="mlb-good">Design Ready</strong></div>';
          p3.innerHTML='<div class="mlb-bottom-title">COMPUTE ESTIMATE</div><div class="mlb-stat-row"><span>Target Params</span><strong>'+(state.project?.estimated_parameters||"—")+'</strong></div><div class="mlb-stat-row"><span>Dataset</span><strong>'+(state.project?.dataset||"—")+'</strong></div><div class="mlb-stat-row"><span>Precision</span><strong>float16</strong></div><div class="mlb-stat-row"><span>Backend</span><strong>MLBricks</strong></div>';
          p4.innerHTML='<div class="mlb-bottom-title">CONNECTION LANES</div><div class="mlb-stat-row"><span>Skip</span><strong>Top Out → Top In</strong></div><div class="mlb-stat-row"><span>Main</span><strong>Middle Out → Middle In</strong></div><div class="mlb-stat-row"><span>Extra</span><strong>Bottom Out → Bottom In</strong></div><div class="mlb-stat-row"><span>Remove</span><strong>Inspector → Remove</strong></div>';
        }
        panels.append(p1,p2,p3,p4);
        details.appendChild(panels);
      }

      if(!galleryWorkspace.open&&!cloudWorkspace.open)main.appendChild(details);

      // Inspector
      const ins=document.createElement("aside");ins.className="mlb-inspector";
      const tabs=document.createElement("div");tabs.className="mlb-ins-tabs";
      [["settings","Inspector"],["info","Info"]].forEach(([k,t])=>{const b=btn(t);if(inspectorTab===k)b.className="active";b.addEventListener("click",()=>{inspectorTab=k;draw();});tabs.appendChild(b);});ins.appendChild(tabs);
      const body=document.createElement("div");body.className="mlb-ins-body";
      const outputDataset=selectedOutputDataset();
      const outputModel=selectedOutputModel();
      const n=selectedNode();

      if(outputDataset){
        renderPreparedDatasetInspector(body,outputDataset);
      }else if(outputModel){
        renderBuiltModelInspector(body,outputModel);
      }else if(!n){
        const compNow=current(state);const defNow=compNow?.kind==="custom_edit"?state.custom_components?.[compNow.definition_id]:null;
        if(defNow){
          const isApiCustom=String(defNow.implementation||"graph")==="api";
          const h=document.createElement("div");h.className="mlb-section-title";h.textContent=isApiCustom?"CUSTOM API COMPONENT":"CUSTOM COMPONENT";body.appendChild(h);
          if(isApiCustom){
            renderCustomBindingEditor(body,defNow);
          }else{
            const help=document.createElement("div");help.className="mlb-api-path";help.textContent="Compose this reusable component from the Component Library. Select an internal component to edit its settings.";body.appendChild(help);
          }
          appendCustomSaveActions(body);
        }else{
          body.innerHTML='<div class="mlb-section-title">SELECT A NODE</div><div class="mlb-api-path">'+(state.active_workspace==="data"?"Choose a data step, or click a prepared dataset in Output Directory to inspect it.":"Choose a model component to edit its API.")+'</div>';
        }
      }else if(inspectorTab==="info"){
        const api=apiInfo(n);const item=n.type==="custom"?{category:"My Components",description:"Reusable custom component."}:cat(catalog,n.type);
        body.innerHTML='<div class="mlb-selected"><strong>'+nodeDisplayName(n)+'</strong><span class="mlb-pill">'+(api.public_name||"Custom")+'</span></div>';
        const s=document.createElement("div");s.className="mlb-summary";[["Type",n.type],["Definition",n.definition_id?"Custom":"Built-in"],["Category",item.category||"General"],["Repeat",n.repeat||1],["API",api.import_path||"custom"],["Status","Valid"]].forEach(([a,b])=>{const r=document.createElement("div");r.className="mlb-summary-row";r.innerHTML="<span>"+a+"</span><strong>"+b+"</strong>";s.appendChild(r);});body.appendChild(s);
      }else{
        const api=apiInfo(n);const info=n.type==="custom"?{api:[]}:cat(catalog,n.type);
        const sw=document.createElement("div");sw.className="mlb-selected";
        const displayName=nodeDisplayName(n);const apiName=api.public_name||"Custom Layer";
        const pill=document.createElement("span");pill.className="mlb-pill";pill.textContent=apiName;
        if(normalizedUserName(displayName)===normalizedUserName(apiName)){
          sw.classList.add("single-pill");sw.appendChild(pill);
        }else{
          const titleText=document.createElement("strong");titleText.textContent=displayName;sw.append(titleText,pill);
        }
        body.appendChild(sw);
        const renameComponentBtn=btn("✎ Rename Component","mlb-ins-rename");renameComponentBtn.addEventListener("click",renameSelectedComponent);body.appendChild(renameComponentBtn);
        const runLive=document.createElement("div");runLive.className="mlb-ins-run-live";
        const rs=execution.nodes?.[n.id];
        if(rs){
          runLive.className+=" "+rs.status;
          runLive.innerHTML="<strong>"+runLabel(rs.status)+"</strong><span>"+(rs.message||"")+"</span>";
        }else{
          runLive.style.display="none";
        }
        body.appendChild(runLive);

        const path=document.createElement("div");path.className="mlb-api-path";
        path.textContent=n.type==="custom"
          ?"custom://"+n.definition_id
          :(api.builder_utility
              ?(api.builder_python_api?"Builder data/text operation":"Builder workflow settings")
              :(api.signature||api.import_path||"MLBricks API"));
        body.appendChild(path);
        if(n.type!=="custom"){
          const apiStatus=document.createElement("div");
          apiStatus.className="mlb-api-status "+(api.available?"ok":"bad");
          if(api.builder_utility && api.builder_python_api){
            apiStatus.className="mlb-api-status utility";
            apiStatus.textContent="Builder data operation — executable with mlbricks_builder.data";
          }else if(api.builder_utility){
            apiStatus.className="mlb-api-status utility";
            apiStatus.textContent="Builder workflow node — no mlbricks Python API";
          }else if(api.available && api.runtime_available===true){
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
          const def=state.custom_components[n.definition_id];const isApi=String(def?.implementation||"graph")==="api";
          const s=document.createElement("div");s.className="mlb-summary";
          (isApi?[["Implementation","API Binding"],["Import",def?.api_binding?.import_path||"Not bound"],["Arguments",def?.api_binding?.parameters?.length||0],["Revision","v"+(def?.revision||1)]]:[["Internal Components",def?.nodes?.length||0],["Connections",def?.edges?.length||0],["Revision","v"+(def?.revision||1)]]).forEach(([a,b])=>{const r=document.createElement("div");r.className="mlb-summary-row";r.innerHTML="<span>"+a+"</span><strong>"+b+"</strong>";s.appendChild(r);});
          body.appendChild(s);
          if(isApi){
            const fields=customExposedFields(def);if(fields.length){const st=document.createElement("div");st.className="mlb-section-title";st.textContent="CUSTOM ARGUMENTS";body.appendChild(st);fields.forEach(f=>renderField(body,n,f));}
            const bound=(def?.api_binding?.parameters||[]).filter(x=>String(x.source||"user")!=="user");if(bound.length){const st=document.createElement("div");st.className="mlb-section-title";st.textContent="BOUND ARGUMENTS";body.appendChild(st);const fixed=document.createElement("div");fixed.className="mlb-api-path";fixed.textContent=bound.map(x=>(x.label||x.name)+" ← "+x.source).join(" · ");body.appendChild(fixed);}
          }else{
            const st=document.createElement("div");st.className="mlb-section-title";st.textContent="CUSTOM LAYER PORTS";body.appendChild(st);
            const fixed=document.createElement("div");fixed.className="mlb-api-path";fixed.textContent="Fixed clean interface: Top Skip, Middle Main, Bottom Extra — on both left and right sides.";body.appendChild(fixed);
          }
        }else{
          if(n.type==="train_test_split"){
            const s=splitPercentages(n),total=s.train+s.validation+s.test,valid=splitIsValid(n);
            const title=document.createElement("div");title.className="mlb-section-title";title.textContent="SPLIT PREVIEW";body.appendChild(title);
            const preview=document.createElement("div");preview.className="mlb-split-preview"+(valid?" valid":" invalid");
            preview.innerHTML='<div class="mlb-split-values"><span><b>'+s.train+'%</b> Train</span><span><b>'+s.validation+'%</b> Validation</span><span><b>'+s.test+'%</b> Test</span></div>'+
              '<div class="mlb-split-bar"><i style="width:'+s.train+'%"></i><i style="width:'+s.validation+'%"></i><i style="width:'+s.test+'%"></i></div>'+
              '<div class="mlb-split-total">'+(valid?'✓':'!')+' Total: <b>'+total+'%</b> '+(valid?'Ready':'— must equal 100%')+'</div>';
            body.appendChild(preview);
            const presets=document.createElement("div");presets.className="mlb-split-presets";
            [
              [90,5,5,"Train 90%","Validation 5% · Test 5%"],
              [80,10,10,"Train 80%","Validation 10% · Test 10%"],
              [90,10,0,"Train 90%","Validation 10% · No test split"]
            ].forEach(([tr,va,te,mainLabel,subLabel])=>{
              const b=btn("","mlb-split-preset");
              b.innerHTML="<strong>"+mainLabel+"</strong><span>"+subLabel+"</span>";
              if(s.train===tr&&s.validation===va&&s.test===te)b.classList.add("active");
              b.addEventListener("click",()=>setSplitPreset(n,tr,va,te,mainLabel+" / "+subLabel));
              presets.appendChild(b);
            });
            body.appendChild(presets);
          }

          const st=document.createElement("div");st.className="mlb-section-title";st.textContent="CONFIG";body.appendChild(st);
          const fields=(api.parameters||info.api||[]);
          if(fields.some(f=>f.group)) renderGroupedFields(body,n,fields);
          else fields.forEach(f=>renderField(body,n,f));

          if(n.type==="prepared_dataset"){
            const meta=availablePreparedDatasets().find(d=>d.output_node_id===n.id) || latestPreparedDataset();
            if(meta){
              const dt=document.createElement("div");dt.className="mlb-section-title";dt.textContent="DATA READY";body.appendChild(dt);
              body.appendChild(datasetSummaryCard(meta,"COMPLETED DATA"));
            }
          }else if(n.type==="text_input" && String(n.params?.input_mode||"prompt")==="prepared_dataset"){
            const meta=preparedDatasetById(n.params?.dataset_id)||latestPreparedDataset();
            if(meta){
              const dt=document.createElement("div");dt.className="mlb-section-title";dt.textContent="SELECTED DATA";body.appendChild(dt);
              body.appendChild(datasetSummaryCard(meta,"MODEL INPUT"));
            }
          }

          const preview=constructorPreview(n);
          if(preview){
            const ct=document.createElement("div");ct.className="mlb-section-title";
            ct.textContent=api.builder_python_api?"DATA PYTHON":"MLBRICKS PYTHON";
            body.appendChild(ct);
            const code=document.createElement("pre");code.className="mlb-code-preview";code.textContent=preview;body.appendChild(code);
          }
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
            const left=(src?nodeDisplayName(src):"Node")+" → "+(tgt?nodeDisplayName(tgt):"Node")+" · "+laneName;
            const txt=document.createElement("div");txt.className="mlb-connection-text";txt.textContent=left;
            const delBtn=btn("Remove","mlb-conn-remove");
            delBtn.disabled=layoutIsLocked();delBtn.addEventListener("click",()=>{
              if(!requireEditableLayout("remove connections"))return;
              checkpoint("Remove connection");
              current(state).edges=current(state).edges.filter(x=>x.id!==ed.id);
              setStatus("Connection removed.");
              draw();
            });
            row.append(txt,delBtn);body.appendChild(row);
          });
        }
        const moveTitle=document.createElement("div");moveTitle.className="mlb-section-title";moveTitle.textContent=state.active_workspace==="data"?"STEP POSITION":"LAYER POSITION";body.appendChild(moveTitle);
        const moveGrid=document.createElement("div");moveGrid.className="mlb-action-grid mlb-move-grid";
        const moveLeft=btn(state.active_workspace==="data"?"← Move Earlier":"← Move Left");
        const moveRight=btn(state.active_workspace==="data"?"Move Later →":"Move Right →");
        const nodeIndex=current(state).nodes.findIndex(x=>x.id===n.id);
        moveLeft.disabled=layoutIsLocked()||nodeIndex<=0;
        moveRight.disabled=layoutIsLocked()||nodeIndex<0||nodeIndex>=current(state).nodes.length-1;
        moveLeft.addEventListener("click",()=>moveSelected(-1));
        moveRight.addEventListener("click",()=>moveSelected(1));
        moveGrid.append(moveLeft,moveRight);body.appendChild(moveGrid);

        const actions=document.createElement("div");actions.className="mlb-action-grid";
        if(n.definition_id){const def=state.custom_components?.[n.definition_id];const open=btn(String(def?.implementation||"graph")==="api"?"Edit API Binding":"Open Architecture");open.addEventListener("click",()=>openInside(n));actions.appendChild(open);}
        const dup=btn("Duplicate");dup.disabled=layoutIsLocked();dup.addEventListener("click",duplicateSelected);actions.appendChild(dup);
        const disc=btn("Remove All Links");disc.disabled=layoutIsLocked();disc.addEventListener("click",()=>{
          if(!requireEditableLayout("remove connections"))return;
          checkpoint("Remove all links from "+n.name);
          current(state).edges=current(state).edges.filter(e=>e.source!==n.id&&e.target!==n.id);
          setStatus("All connections removed.");draw();
        });actions.appendChild(disc);
        const del=btn("Delete");del.disabled=layoutIsLocked();del.addEventListener("click",()=>deleteNode(n.id));actions.appendChild(del);body.appendChild(actions);
        if(current(state).kind==="custom_edit"){
          const parentCfg=document.createElement("div");
          parentCfg.className="mlb-summary";
          parentCfg.innerHTML='<div class="mlb-summary-row"><span>Custom Layer Interface</span><strong>Skip / Main / Extra</strong></div>';
          body.appendChild(parentCfg);

          appendCustomSaveActions(body);
        }
      }
      ins.appendChild(body);

      shell.append(side,main,ins);root.appendChild(shell);

      const stat=document.createElement("div");stat.className="mlb-statusbar";
      let statusDevice="Auto";
      if(runtimePanel){
        const e=builtModelById(runtimePanel.modelId);
        if(e){const cfg=runtimePanel.mode==="train"?e.training_config:e.generation_config;statusDevice=selectedRuntimeDevice(cfg).label;}
      }
      stat.innerHTML='<span>Workspace: '+workspaceName()+'</span><span>Backend: '+(state.active_workspace==="data"?"Builder Data API":"MLBricks Runtime")+'</span><span>Device: '+statusDevice+'</span><span class="right mlb-ready">● '+status+"</span>";
      root.appendChild(stat);

      const nextInspectorKey=inspectorRenderKey();
      const inspectorPos=inspectorScrollPositions[nextInspectorKey]||{left:0,top:0};
      lastInspectorRenderKey=nextInspectorKey;
      requestAnimationFrame(()=>{
        const liveBody=root.querySelector(".mlb-ins-body");
        if(liveBody){liveBody.scrollLeft=inspectorPos.left||0;liveBody.scrollTop=inspectorPos.top||0;}
        if(searchFocusRestore){
          const restore=searchFocusRestore;searchFocusRestore=null;
          const liveSearch=root.querySelector(".mlb-search");
          if(liveSearch){
            try{liveSearch.focus({preventScroll:true});}catch(_){liveSearch.focus();}
            try{liveSearch.setSelectionRange(restore.start,restore.end);}catch(_){}
          }
        }
      });
      if(isPopout)schedulePopoutStateSync();
    }

    setupPopoutBridge();
    draw();
    startBridgePolling();
  }

  window.MLBricksBuilder={mount};
})();
