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
          setStatus('A custom brick named "'+name+'" already exists.');
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
          definition:{id:def?.id||uid("custom"),name,description:def?.description||"Reusable custom brick",revision:def?.revision||1,input_count:3,output_count:3,nodes:cp(c.nodes||[]),edges:cp(c.edges||[])}
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
      state.custom_components[id]=source;
      persistGallery();setStatus(name+" added to My Bricks.");draw();
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
      checkpoint("Remove Gallery item");
      state.gallery[kind]=(state.gallery[kind]||[]).filter(x=>x.id!==id);persistGallery();setStatus("Gallery item removed.");draw();
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
        html+="<div class='mlb-runtime-live-stats'>"+
          "<div><span>Step</span><strong>"+(next.step??"—")+(next.max_steps?" / "+next.max_steps:"")+"</strong></div>"+
          "<div><span>Loss</span><strong>"+(next.loss==null?"—":Number(next.loss).toFixed(4))+"</strong></div>"+
          "<div><span>Val</span><strong>"+(next.val_loss==null?"—":Number(next.val_loss).toFixed(4))+"</strong></div>"+
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
      return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MLBricks : AIBuilder</title><style>'+cssText+'</style><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1118}body{padding:0}.mlb-root{width:100vw!important;height:100vh!important;min-height:0!important;max-height:none!important;min-width:0!important;border-radius:0!important;border:0!important;box-shadow:none!important}</style></head><body><div id="'+targetId+'" class="mlb-root" data-mlbricks-builder-version="0.7.34"></div><script>'+jsText+closeScript+'<script>window.MLBricksBuilder.mount(document.getElementById('+JSON.stringify(targetId)+'),'+safePayload+');'+closeScript+'</body></html>';
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
        build:'<svg '+common+'><path d="M12 3 4.5 7.2 12 11.5l7.5-4.3L12 3Z"/><path d="m4.5 12 7.5 4.3 7.5-4.3"/><path d="m4.5 16.8 7.5 4.2 7.5-4.2"/></svg>',
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

    function deriveModelSettings(entry){
      state.project=state.project||{};
      const stored=state.project.model_settings||{};
      const nodes=allModelSettingNodes();
      const embedding=nodes.find(n=>n.type==="embedding");
      const esa=nodes.find(n=>n.type==="esa");
      const head=nodes.find(n=>n.type==="lm_head");

      const embeddingSize=numberOr(
        stored.embedding_size,
        numberOr(
          embedding?.params?.embedding_dim ?? embedding?.params?.hidden_size ?? embedding?.params?.dim,
          numberOr(esa?.params?.embd ?? esa?.params?.dim,384)
        )
      );
      const heads=numberOr(
        stored.heads,
        numberOr(esa?.params?.head ?? esa?.params?.heads ?? esa?.params?.num_heads,6)
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

      const pipeline=datasetMeta.pipeline||{};
      const tokenizer=pipeline.tokenizer;
      if(req.modality==="text" && req.requires_tokenizer){
        add("Tokenizer",!!tokenizer,tokenizer?.tokenizer_name||"Tokenizer missing");
        const dataContext=Number(tokenizer?.context_length||0);
        const modelContext=Number(req.context_length||0);
        if(dataContext && modelContext){
          add(
            "Context length",
            dataContext<=modelContext,
            "Data "+dataContext+" ≤ Model "+modelContext
          );
        }else{
          add("Context length",true,"No conflicting context length found");
        }

        const cols=datasetMeta?.splits?.train?.columns||[];
        if(cols.length){
          add(
            "Tokenized fields",
            cols.includes("input_ids"),
            cols.includes("input_ids")?"input_ids available":"input_ids not found"
          );
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
        learning_rate:0.0003,
        weight_decay:0.1,
        warmup_steps:100,
        validation_split:validationSplit,
        validate_every:100,
        validation_steps:20,
        generate_on_validation:true,
        validation_prompt:"Once upon a time",
        validation_generate_tokens:64,
        checkpoint_every:500,
        seed:42,
        device:"auto",
        backend:"auto",
        execution_mode:"eager",
        compile_mode:"reduce-overhead",
        precision:"auto",
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
        backend:"auto",
        execution_mode:"eager",
        compile_mode:"reduce-overhead",
        precision:"auto",
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
        generated_tokens:next.generated_tokens??null,loss:next.loss??null,val_loss:next.val_loss??null,
        best_val_loss:next.best_val_loss??null,elapsed_seconds:next.elapsed_seconds??null,
        message:next.message||"",checkpoint_path:next.checkpoint_path||null
      };
      if(!history.length||history[history.length-1].key!==key)history.push(event);
      if(history.length>250)history.splice(0,history.length-250);

      if(next.runtime_kind==="train"){
        entry.training_live={
          status:event.status,phase:event.phase,overall:Number(next.overall||0),step:event.step,max_steps:event.max_steps,
          tokens_seen:event.tokens_seen,loss:event.loss,val_loss:event.val_loss,best_val_loss:event.best_val_loss,
          elapsed_seconds:event.elapsed_seconds,message:event.message,
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
          loss:execution.loss??live.loss,val_loss:execution.val_loss??live.val_loss,best_val_loss:execution.best_val_loss??live.best_val_loss,
          elapsed_seconds:execution.elapsed_seconds??live.elapsed_seconds,message:execution.message||live.message,
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
        const extra=[];if(ev.loss!==null)extra.push("loss "+Number(ev.loss).toFixed(4));if(ev.val_loss!==null)extra.push("val "+Number(ev.val_loss).toFixed(4));
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
      metrics.append(statusMetric("Step",(live.step??entry.trained_steps??0)+(live.max_steps?" / "+live.max_steps:"")),
        statusMetric("Loss",live.loss==null?(entry.last_loss==null?"—":Number(entry.last_loss).toFixed(4)):Number(live.loss).toFixed(4)),
        statusMetric("Validation",live.val_loss==null?(entry.latest_validation_loss==null?"—":Number(entry.latest_validation_loss).toFixed(4)):Number(live.val_loss).toFixed(4)),
        statusMetric("Best Val",live.best_val_loss==null?(entry.best_val_loss==null?"—":Number(entry.best_val_loss).toFixed(4)):Number(live.best_val_loss).toFixed(4)),
        statusMetric("Tokens",Number(live.tokens_seen??entry.tokens_seen??0).toLocaleString()),statusMetric("Elapsed",formatDuration(live.elapsed_seconds)));
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
          entry.training_history=[];entry.training_live={status:"running",phase:"starting",overall:0,message:"Starting training in Python…"};
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
      note.textContent="Training now executes supported MLBricks language-model graphs in the Python kernel. Current compiler support: Embedding, ESA, RMSNorm/LayerNorm, FFN, Residual, Dropout, LM Head and nested custom bricks built from them.";side.appendChild(note);

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
        builder_version:"0.7.34",
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
      const saveLabel=current(state)?.kind==="custom_edit"?"+ Save Current Component":(state.active_workspace==="data"?"+ Save Current Data":"+ Save Current Model");
      const save=btn(saveLabel,"mlb-gallery-save");
      save.addEventListener("click",saveCurrentToGallery);head.append(title,save);container.appendChild(head);

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
        {name:"TinyStories 30M",meta:"6 layers · Context 512 · Batch 16 · ~30M parameters",action:"Load Model",load:loadTinyStories}
      ];
      const builtInSampleData=[
        {name:"TinyStories Text Pipeline",meta:"Hugging Face → Text Processing → Train 90% · Validation 5% · Test 5% → GPT-2 Tokenize → Prepared Dataset",action:"Load Pipeline",load:loadTextDataStarter}
      ];
      const sampleModels=makeSection("SAMPLE MODELS",builtInSampleModels.length+" built-in","sample");
      builtInSampleModels.forEach(item=>sampleModels.appendChild(makeSampleCard(item.name,item.meta,item.action,item.load)));
      const sampleData=makeSection("SAMPLE DATA",builtInSampleData.length+" built-in","sample");
      builtInSampleData.forEach(item=>sampleData.appendChild(makeSampleCard(item.name,item.meta,item.action,item.load)));

      const componentSection=makeSection("MY COMPONENTS",(state.gallery.components||[]).length+" saved");
      if(!(state.gallery.components||[]).length){const e=document.createElement("div");e.className="mlb-gallery-empty";e.textContent="Open a Custom Brick and save it here for reuse.";componentSection.appendChild(e);}
      (state.gallery.components||[]).forEach(entry=>{
        const card=document.createElement("div");card.className="mlb-gallery-card";
        const meta=document.createElement("div");meta.innerHTML="<strong>"+entry.name+"</strong><span>"+((entry.definition?.nodes||[]).length)+" blocks · "+(entry.saved_at?new Date(entry.saved_at).toLocaleDateString():"Saved")+"</span>";
        const acts=document.createElement("div");const add=btn("Add to My Bricks","mlb-gallery-action");add.addEventListener("click",()=>addGalleryComponent(entry));const remove=btn("Remove","mlb-gallery-action danger");remove.addEventListener("click",()=>removeGalleryEntry("components",entry.id));acts.append(add,remove);card.append(meta,acts);componentSection.appendChild(card);
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
      if(galleryWorkspace.tab==="components"&&current(state)?.kind==="custom_edit"){canSave=true;saveLabel="+ Save Current Component";}
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
        const samples=makeSection("PREBUILT MODELS","1 available","featured full-width");
        const load=btn("Open Model","mlb-gallery-action sample");load.addEventListener("click",openAndClose(loadTinyStories));
        const sampleGrid=document.createElement("div");sampleGrid.className="mlb-central-gallery-card-grid prebuilt-grid";
        sampleGrid.appendChild(card("TinyStories 30M","Parameters ~30M · Batch 16 · Block 512 · 6 layers","MODEL",[load]));
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
        const samples=makeSection("PREBUILT COMPONENTS","More coming","featured full-width");
        samples.appendChild(empty("Reusable MLBricks component templates will appear here as the Gallery grows."));
        body.appendChild(samples);

        const mine=makeSection("MY COMPONENTS",(state.gallery.components||[]).length+" saved","full-width saved-components");
        if(!(state.gallery.components||[]).length)mine.appendChild(empty("Custom bricks you save to Gallery will appear here."));
        else{
          const savedGrid=document.createElement("div");savedGrid.className="mlb-central-gallery-card-grid saved-component-grid";
          (state.gallery.components||[]).forEach(entry=>{
            const add=btn("Add to My Bricks","mlb-gallery-action");add.addEventListener("click",()=>addGalleryComponent(entry));
            const remove=btn("Remove","mlb-gallery-action danger");remove.addEventListener("click",()=>removeGalleryEntry("components",entry.id));
            savedGrid.appendChild(card(entry.name,((entry.definition?.nodes||[]).length)+" blocks · "+(entry.saved_at?new Date(entry.saved_at).toLocaleDateString():"Saved"),"COMP",[add,remove]));
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
      if(Object.keys(tok).length)detailSection(body,"TOKENIZER",[["Tokenizer",tok.tokenizer_name],["Text Column",tok.text_column],["Context Length",tok.context_length],["Truncation",prettyBool(tok.truncation)],["Padding",tok.padding],["Special Tokens",prettyBool(tok.add_special_tokens)]]);
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
        setStatus("Custom brick name cannot be empty.");
        return null;
      }
      if(customNameExists(proposed)){
        setStatus('A custom brick named "'+proposed+'" already exists.');
        alert('A custom brick named "'+proposed+'" already exists. Choose a unique name.');
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

    function constructorPreview(node){
      const api=apiInfo(node);
      if(node.type==="custom") return "# Nested custom MLBricks layer";
      if(api?.builder_utility) return api.builder_python_api ? builderDataPreview(node) : "";
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
      const pos=insertAfterSelection(n);
      setStatus(n.name+" inserted at layer "+(pos+1)+".");
      draw();
    }

    function createCustom(){
      const name=askUniqueCustomName("My Component","New custom brick name:");
      if(!name){draw();return;}

      checkpoint("Create custom brick");
      const id=uid("custom");

      // IMPORTANT: creating a custom brick creates an EMPTY reusable shell.
      // It never captures siblings or the current model canvas.
      state.custom_components[id]={
        id,
        name,
        description:"Reusable nested layer",
        revision:1,
        nodes:[],
        edges:[],
        input_count:3,
        output_count:3
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
      setStatus(name+" created as an empty custom brick.");
      draw();
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
        params:{},
        input_count:3,
        output_count:3,
        position:{x:0,y:0}
      };
      const pos=insertAfterSelection(n);
      setStatus(def.name+" inserted at layer "+(pos+1)+".");
      draw();
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
        const name=askUniqueCustomName(def.name+" Copy","Save as new custom brick:");
        if(!name){draw();return;}
        const id=uid("custom");
        state.custom_components[id]={
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
        builder_version:"0.7.34",
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
        builder_version:"0.7.34",
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
        "Version: 0.7.34",
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
        'MLBricks Builder v0.7.34',
        '',
        '• Add bricks or data steps from the left library.',
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
      const frontendVersion=root.dataset.mlbricksBuilderVersion||"0.7.34";

      const topLeft=document.createElement("div");topLeft.className="mlb-top-left";
      const logo=document.createElement("div");logo.className="mlb-logo";logo.innerHTML='<img class="mlb-logo-mark" src="data:image/png;base64,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" alt="" aria-hidden="true"><span class="mlb-logo-name">MLBricks Builder</span><span class="mlb-beta">v'+frontendVersion+'</span>';
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
      const head=document.createElement("div");head.className="mlb-sidehead";head.innerHTML="<span>"+(state.active_workspace==="data"?"DATA LIBRARY":"BRICK LIBRARY")+"</span><span>×</span>";side.appendChild(head);
      const sr=document.createElement("div");sr.className="mlb-search-row";
      const searchInput=document.createElement("input");searchInput.className="mlb-search";searchInput.placeholder="Search...";searchInput.setAttribute("aria-label",state.active_workspace==="data"?"Search data steps":"Search bricks");searchInput.value=search;searchInput.addEventListener("input",()=>{
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
        // backward compatibility, but do not show them in the Brick Library.
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
        mh.innerHTML="<span>MY BRICKS</span><span class='mlb-category-caret'>"+(myBricksCollapsed?"▸":"▾")+"</span>";
        mh.addEventListener("click",()=>{myBricksCollapsed=!myBricksCollapsed;draw();});
        side.appendChild(mh);

        if(!myBricksCollapsed){
          Object.values(state.custom_components||{}).forEach(def=>{
            const b=document.createElement("button");b.className="mlb-custom-card";b.type="button";
            const emptyLabel=(def.nodes||[]).length===0?" · Empty":" · "+(def.nodes||[]).length+" blocks";
          b.innerHTML='<span class="mlb-pal-icon">MY</span><span><strong>'+def.name+'</strong><span class="mlb-pal-sub">Custom · v'+def.revision+emptyLabel+"</span></span>";
            b.disabled=layoutIsLocked();b.title=layoutIsLocked()?"Layout locked — click Edit Layout first":"Add "+def.name;b.addEventListener("click",()=>addCustom(def));side.appendChild(b);
          });
          const create=btn("+ Create Custom Brick","mlb-create");create.addEventListener("click",createCustom);side.appendChild(create);
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
          e.innerHTML="<strong>Empty custom brick.</strong><br><br>Add internal bricks from the left. Nothing from the parent model is copied into this shell.";
        }else if(state.active_workspace==="data"){
          e.innerHTML="<strong>Build your data pipeline step by step.</strong><br><br>Start with Hugging Face, Kaggle, URL, Local or Manual Data.";
        }else{
          e.innerHTML="<strong>Build your model layer by layer.</strong><br><br>Add a brick from the left or open Gallery to load a sample model.";
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
          card.querySelector(".mlb-node-fields").innerHTML=n.type==="custom"
            ?('<div class="mlb-mini-field"><span>Architecture</span><strong>Open</strong></div>'+
              '<div class="mlb-mini-field"><span>Ports</span><strong>Skip / Main / Extra</strong></div>')
            :nodeMiniFields(n,info);
          card.querySelectorAll(".mlb-mini-field").forEach(row=>{
            const label=row.querySelector("span");
            const value=row.querySelector("strong");
            if(label)label.title=label.textContent||"";
            if(value)value.title=value.textContent||"";
          });
          const meta=card.querySelector(".node-meta");
          meta.textContent=n.type==="custom"?"Nested component · 3-lane interface":((apiInfo(n).public_name||n.type)+" · Skip / Main / Extra");
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
          :"Select a node before adding a brick to insert after it. Use Move Left / Move Right in Inspector to reorder. Main flow rewires automatically.");
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
        body.innerHTML='<div class="mlb-section-title">SELECT A NODE</div><div class="mlb-api-path">'+(state.active_workspace==="data"?"Choose a data step, or click a prepared dataset in Output Directory to inspect it.":"Choose a model component to edit its MLBricks API.")+'</div>';
      }else if(inspectorTab==="info"){
        const api=apiInfo(n);const item=n.type==="custom"?{category:"My Bricks",description:"Reusable custom brick."}:cat(catalog,n.type);
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
          const def=state.custom_components[n.definition_id];
          const s=document.createElement("div");s.className="mlb-summary";
          [["Internal Components",def?.nodes?.length||0],["Connections",def?.edges?.length||0],["Revision","v"+(def?.revision||1)]].forEach(([a,b])=>{const r=document.createElement("div");r.className="mlb-summary-row";r.innerHTML="<span>"+a+"</span><strong>"+b+"</strong>";s.appendChild(r);});
          body.appendChild(s);
          const st=document.createElement("div");st.className="mlb-section-title";st.textContent="CUSTOM LAYER PORTS";body.appendChild(st);
          const fixed=document.createElement("div");fixed.className="mlb-api-path";
          fixed.textContent="Fixed clean interface: Top Skip, Middle Main, Bottom Extra — on both left and right sides.";
          body.appendChild(fixed);
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
        if(n.definition_id){const open=btn("Open Architecture");open.addEventListener("click",()=>openInside(n));actions.appendChild(open);}
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

          const sv=document.createElement("div");sv.className="mlb-action-grid";const ov=btn("Override");ov.addEventListener("click",()=>saveCustom(false));const sn=btn("Save As New");sn.addEventListener("click",()=>saveCustom(true));sv.append(ov,sn);body.appendChild(sv);
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
