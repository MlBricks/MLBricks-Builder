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
    const bridge=payload.bridge||null;
    const runtimeCaps=cp(payload.runtime_capabilities||{devices:[{id:"auto",label:"Auto"},{id:"cpu",label:"CPU"}]});
    let runtimePanel=null;
    let execution={status:"idle",overall:0,message:"Ready",nodes:{}};
    let localFiles={roots:[],entries:[],truncated:false};
    let localImportReport=null;
    let localForm={path:"/kaggle/working"};
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
    let bottomExpanded=false;
    let bottomView="details";
    let outputDirectorySelection=null;
    let filesFilter="all";

    Object.values(state.components||{}).forEach(c=>{if(!c.edges)c.edges=[];});
    if(state.auto_connect===undefined) state.auto_connect=true;

    function ensureWorkspaces(){
      if(!Array.isArray(state.prepared_datasets))state.prepared_datasets=[];
      if(!Array.isArray(state.model_outputs))state.model_outputs=[];
      if(!Array.isArray(state.project_files))state.project_files=[];
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

    function switchWorkspace(next){
      if(next===state.active_workspace)return;
      const oldKey=state.active_workspace||"model";
      const oldCanvas=root.querySelector(".mlb-canvas");
      if(oldCanvas){
        workspaceScroll[oldKey]={left:oldCanvas.scrollLeft,top:oldCanvas.scrollTop};
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

    function clickBridgeButton(button){
      if(!button)return false;
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
      return !!(
        bridgeControl(bridge.state,"textarea") &&
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

    function setBridgeState(){
      if(!bridge)return false;
      const input=bridgeControl(bridge.state,"textarea");
      if(!input)return false;
      return setNativeValue(input,JSON.stringify(state));
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
      state._runtime_command={action,model_id:entry.id,serve:{
        config:cp(entry.serve_config||{}),
        credentials:{api_key:secret.api_key||"",ngrok_token:secret.ngrok_token||""}
      },ts:Date.now()};
      if(!setBridgeState()){delete state._runtime_command;setStatus("Could not send API server configuration to Python.");return;}
      const button=bridgeControl(bridge.run,"button");
      if(!button){delete state._runtime_command;setStatus("Python API server control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:"serve",phase:action,overall:0,message:
        action==="serve_start"?"Starting model API server…":action==="serve_stop"?"Stopping model API server…":"Checking model API server…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{clickBridgeButton(button);setTimeout(()=>{delete state._runtime_command;},350);},250);
    }

    function requestRuntimeCommand(action,entry){
      if(!entry)return;
      updateKernelBadge();
      if(!bridgeReady()){
        execution={status:"error",runtime_kind:action,overall:0,message:"Kernel bridge is offline. Re-run the Builder cell, then try again.",nodes:{}};
        applyExecutionProgress(execution);setStatus(execution.message);return;
      }
      state._runtime_command={action,model_id:entry.id,ts:Date.now()};
      if(!setBridgeState()){
        delete state._runtime_command;
        setStatus("Could not send runtime configuration to Python.");return;
      }
      const button=bridgeControl(bridge.run,"button");
      if(!button){delete state._runtime_command;setStatus("Python runtime control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");
      lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:action,phase:"starting",overall:0,message:action==="train"?"Starting training in Python…":"Starting generation in Python…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{clickBridgeButton(button);setTimeout(()=>{delete state._runtime_command;},500);},350);
    }

    function requestLocalCommand(action,config={}){
      updateKernelBadge();
      if(!bridgeReady()){
        execution={status:"error",runtime_kind:"local",overall:0,message:"Kernel bridge is offline. Re-run the Builder cell, then try again.",nodes:{}};
        applyExecutionProgress(execution);setStatus(execution.message);return;
      }
      state._runtime_command={action,local:cp(config),ts:Date.now()};
      if(!setBridgeState()){delete state._runtime_command;setStatus("Could not send local filesystem command to Python.");return;}
      const button=bridgeControl(bridge.run,"button");
      if(!button){delete state._runtime_command;setStatus("Python local filesystem control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");
      lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:"local",phase:action,overall:0,message:action==="local_scan"?"Scanning Kaggle files…":"Loading local content…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{clickBridgeButton(button);setTimeout(()=>{delete state._runtime_command;},350);},250);
    }

    function requestCloudCommand(action,config={}){
      updateKernelBadge();
      if(!bridgeReady()){
        execution={status:"error",runtime_kind:"cloud",overall:0,message:"Kernel bridge is offline. Re-run the Builder cell, then try again.",nodes:{}};
        applyExecutionProgress(execution);setStatus(execution.message);return;
      }
      state._runtime_command={action,cloud:cp(config),ts:Date.now()};
      if(!setBridgeState()){
        delete state._runtime_command;
        setStatus("Could not send cloud command to Python.");return;
      }
      const button=bridgeControl(bridge.run,"button");
      if(!button){delete state._runtime_command;setStatus("Python cloud control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");
      lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:"cloud",phase:action,overall:0,message:"Connecting to cloud provider…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{
        clickBridgeButton(button);
        // Credentials are transient. Remove them from browser project state as soon
        // as the bridge has copied the command into the standard widget.
        setTimeout(()=>{delete state._runtime_command;},350);
      },250);
    }

    function requestHubCommand(action,config={}){
      updateKernelBadge();
      if(!bridgeReady()){
        execution={status:"error",runtime_kind:"hub",overall:0,message:"Kernel bridge is offline. Re-run the Builder cell, then try again.",nodes:{}};
        applyExecutionProgress(execution);setStatus(execution.message);return;
      }
      state._runtime_command={action,hub:cp(config),ts:Date.now()};
      if(!setBridgeState()){
        delete state._runtime_command;
        setStatus("Could not send Hugging Face command to Python.");return;
      }
      const button=bridgeControl(bridge.run,"button");
      if(!button){delete state._runtime_command;setStatus("Python Hub control was not found.");return;}
      const progressInput=bridgeControl(bridge.progress,"textarea");
      lastProgressRaw=progressInput?.value||lastProgressRaw;
      execution={status:"running",runtime_kind:"hub",phase:action,overall:0,message:"Connecting to Hugging Face Hub…",nodes:{}};
      applyExecutionProgress(execution);setStatus(execution.message);
      setTimeout(()=>{clickBridgeButton(button);setTimeout(()=>{delete state._runtime_command;},500);},300);
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
        overall:0,
        message:"Starting Python pipeline…",
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
            status:"error",overall:0,
            message:"Could not activate the Python Run control.",
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
        if(next.local_import)localImportReport=cp(next.local_import);
        if(next.state_replace){
          state=cp(next.state_replace);delete state._runtime_command;ensureWorkspaces();
          selected=null;pendingPort=null;
          if(next.local_import){
            state.active_workspace="model";
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
          entry.serve_live=cp(next.serve_info);
          if(next.serve_info.api_key){
            serveSecrets[entry.id]=serveSecrets[entry.id]||{};
            serveSecrets[entry.id].api_key=next.serve_info.api_key;
          }
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
          run.textContent=runtimeBusy
            ?(execution.runtime_kind==="train"?"◆ Training":"◆ Generating")
            :(execution.status==="running"?"◆ Building":"◆ Build");
        }else{
          run.textContent=execution.status==="running"?"▶ Running":"▶ Run Data";
        }
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

    function btn(text,cls){const b=document.createElement("button");b.type="button";b.className=cls||"";b.textContent=text;return b;}
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
        output_dir:"/kaggle/working/mlbricks_training",
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
      bottomExpanded=false;
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

    function serveUrlCard(label,url,kind){
      const card=document.createElement("div");card.className="mlb-serve-url "+kind;
      const top=document.createElement("div");top.innerHTML="<strong>"+label+"</strong><span>"+(url||"Unavailable")+"</span>";card.appendChild(top);
      if(url){const actions=document.createElement("div");
        const open=btn("Open","mlb-serve-mini");open.addEventListener("click",()=>window.open(url,"_blank","noopener"));
        const copyBtn=btn("Copy","mlb-serve-mini");copyBtn.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(url);setStatus(label+" copied.");}catch(_){setStatus(url);}});
        actions.append(open,copyBtn);card.appendChild(actions);}
      return card;
    }

    function serveCodeExample(entry,info){
      const base=info?.public_url||info?.lan_url||info?.local_url||"http://127.0.0.1:8000";
      const secret=serveSecrets[entry.id]?.api_key||"YOUR_API_KEY";
      const auth=entry.serve_config?.require_api_key!==false?'\\n    "Authorization": "Bearer '+secret+'",':"";
      return 'fetch("'+base+'/v1/generate", {\\n  method: "POST",\\n  headers: {\\n    "Content-Type": "application/json",'+auth+'\\n  },\\n  body: JSON.stringify({\\n    prompt: "Once upon a time",\\n    max_new_tokens: 128\\n  })\\n}).then(r => r.json()).then(console.log);';
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
        const hero=runtimeSection("API Server Status"),status=document.createElement("div");status.className="mlb-serve-status "+(running?"running":"stopped");
        status.innerHTML="<strong>"+(running?"● RUNNING":"○ STOPPED")+"</strong><span>"+(running?"Model is accepting HTTP inference requests.":"Start the server from API Server Setup.")+"</span>";hero.appendChild(status);main.appendChild(hero);
        const links=runtimeSection("Access Links"),linkGrid=document.createElement("div");linkGrid.className="mlb-serve-links";
        linkGrid.append(serveUrlCard("Localhost",info.local_url||entry.serve_urls?.local_url,"local"),
          serveUrlCard("LAN / Same Wi‑Fi",info.lan_url||entry.serve_urls?.lan_url,"lan"),
          serveUrlCard("Public HTTPS",info.public_url||entry.serve_urls?.public_url,"public"));links.appendChild(linkGrid);main.appendChild(links);
        if(info.remote_notebook&&!info.public_url){const warn=document.createElement("div");warn.className="mlb-serve-warning";
          warn.innerHTML="<strong>"+(info.environment||"Remote notebook")+" detected</strong><span>localhost and LAN belong to the remote kernel. Enable ngrok Public HTTPS in Setup for your phone or local web app.</span>";main.appendChild(warn);}
        const endpoints=runtimeSection("API Endpoints"),ep=document.createElement("div");ep.className="mlb-serve-endpoints";
        [["Playground","GET /"],["Health","GET /health"],["Generate","POST /v1/generate"],["OpenAI-style","POST /v1/completions"],["Models","GET /v1/models"]].forEach(([a,b])=>{const row=document.createElement("div");row.innerHTML="<span>"+a+"</span><strong>"+b+"</strong>";ep.appendChild(row);});endpoints.appendChild(ep);main.appendChild(endpoints);
        const code=runtimeSection("Web App Example"),pre=document.createElement("pre");pre.className="mlb-serve-code";pre.textContent=serveCodeExample(entry,info);code.appendChild(pre);main.appendChild(code);
        const summary=document.createElement("div");summary.className="mlb-runtime-summary";summary.innerHTML="<h3>Server</h3><div><span>Status</span><strong>"+(running?"Running":"Stopped")+"</strong></div><div><span>Port</span><strong>"+(info.port||config.port)+"</strong></div><div><span>API Key</span><strong>"+(config.require_api_key?"Required":"Off")+"</strong></div><div><span>Public Tunnel</span><strong>"+(config.public_tunnel||"off")+"</strong></div>";side.appendChild(summary);
        if(config.require_api_key){const keyBox=document.createElement("div");keyBox.className="mlb-serve-secret";keyBox.innerHTML="<strong>API KEY</strong><code>"+(secret.api_key||"Restart server to generate key")+"</code>";const copyKey=btn("Copy API Key","mlb-dark-btn");copyKey.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(secret.api_key||"");setStatus("API key copied.");}catch(_){}});keyBox.appendChild(copyKey);side.appendChild(keyBox);}
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
      start.addEventListener("click",()=>{runtimePanel={mode:"serve",modelId:entry.id,tab:"status"};entry.serve_live={running:false,message:"Starting API server…"};draw();setTimeout(()=>requestServeCommand("serve_start",entry),80);});side.appendChild(start);
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
      const datasets=availablePreparedDatasets();
      if(!datasets.length){
        const o=document.createElement("option");o.value="";o.textContent="No prepared datasets available";
        select.appendChild(o);select.disabled=true;
      }else{
        const blank=document.createElement("option");blank.value="";blank.textContent="Select data…";select.appendChild(blank);
        datasets.forEach(meta=>{
          const o=document.createElement("option");o.value=meta.id;
          o.textContent=meta.name+" — "+compactDatasetSummary(meta);
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
      const head=document.createElement("div");head.className="mlb-output-head";head.innerHTML="<div><strong>DATA OUTPUTS</strong><span>"+entries.length+" prepared dataset"+(entries.length===1?"":"s")+" · click one for details</span></div>";container.appendChild(head);
      if(!entries.length){container.appendChild(makeDirectoryEmpty("No prepared datasets yet.","Run a Data Processing pipeline. Completed datasets will appear here automatically."));return;}
      const list=document.createElement("div");list.className="mlb-output-list compact";
      entries.forEach(meta=>{const card=document.createElement("div");card.className="mlb-output-entry compact"+(outputDirectorySelection===meta.id?" selected":"");const top=document.createElement("div");top.className="mlb-output-entry-top";top.innerHTML="<div class='mlb-output-name'><strong>"+meta.name+"</strong><span>"+dataStorageLabel(meta)+"</span></div><span class='mlb-output-type data'>DATA</span>";card.appendChild(top);const stats=document.createElement("div");stats.className="mlb-output-stats compact";[["train","Train"],["validation","Val"],["test","Test"]].forEach(([key,label])=>{if(meta.splits?.[key]){const item=document.createElement("div");item.innerHTML="<span>"+label+"</span><strong>"+splitRows(meta,key)+"</strong>";stats.appendChild(item);}});card.appendChild(stats);const foot=document.createElement("div");foot.className="mlb-output-compact-foot";foot.innerHTML="<span>"+(meta.total_rows??"?")+" rows</span><span>Details →</span>";card.appendChild(foot);card.addEventListener("click",()=>{outputDirectorySelection=meta.id;selected=null;inspectorTab="settings";setStatus(meta.name+" details opened.");draw();});list.appendChild(card);});container.appendChild(list);
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
        top.innerHTML="<div class='mlb-output-name'><strong>"+entry.name+"</strong><span>Built Model · r"+(entry.revision||1)+"</span></div>"+
          "<span class='mlb-output-type model'>MODEL</span>";
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
        builder_version:"0.7.1",
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

    function renderLocalView(container){
      container.className="mlb-local-view";
      const head=document.createElement("div");head.className="mlb-local-head";
      const copyHead=document.createElement("div");
      copyHead.innerHTML="<strong>LOCAL / KAGGLE MODEL IMPORT</strong><span>Enter one directory. Builder scans all subdirectories and imports compatible models automatically.</span>";
      const badge=document.createElement("span");badge.className="mlb-local-badge";badge.textContent="AUTO";
      head.append(copyHead,badge);container.appendChild(head);

      const box=document.createElement("div");box.className="mlb-local-auto-box";
      const field=document.createElement("div");field.className="mlb-local-field";
      const label=document.createElement("label");label.textContent="Base Path";field.appendChild(label);
      const input=document.createElement("input");input.value=localForm.path||"/kaggle/working";input.placeholder="/kaggle/working";
      input.addEventListener("input",()=>localForm.path=input.value);field.appendChild(input);
      const button=btn("Scan & Import Models","mlb-local-load");
      button.addEventListener("click",()=>{
        const path=String(localForm.path||"").trim();
        if(!path){setStatus("Enter a Kaggle/local directory path.");return;}
        requestLocalCommand("local_import_models",{path,max_depth:12,max_entries:1000});
      });
      box.append(field,button);container.appendChild(box);

      const examples=document.createElement("div");examples.className="mlb-local-path-examples";
      ["/kaggle/working","/kaggle/input","/content/models"].forEach(value=>{
        const chip=document.createElement("button");chip.textContent=value;
        chip.addEventListener("click",()=>{localForm.path=value;draw();});
        examples.appendChild(chip);
      });
      container.appendChild(examples);

      const flow=document.createElement("div");flow.className="mlb-local-flow";
      flow.innerHTML="<span>1</span><strong>Path</strong><i>→</i><span>2</span><strong>Recursive Scan</strong><i>→</i><span>3</span><strong>Detect Models</strong><i>→</i><span>4</span><strong>Model Repository</strong>";
      container.appendChild(flow);

      if(localImportReport){
        const report=document.createElement("div");report.className="mlb-local-report";
        const rh=document.createElement("div");rh.className="mlb-local-report-head";
        rh.innerHTML="<strong>LAST IMPORT</strong><span>"+(localImportReport.root||"")+"</span>";
        report.appendChild(rh);

        const stats=document.createElement("div");stats.className="mlb-local-report-stats";
        [["Found",localImportReport.found||0],["Imported",localImportReport.imported_count||0],["Skipped",localImportReport.skipped_count||0],["Errors",localImportReport.error_count||0]].forEach(([name,value])=>{
          const item=document.createElement("div");item.innerHTML="<span>"+name+"</span><strong>"+value+"</strong>";stats.appendChild(item);
        });
        report.appendChild(stats);

        const imported=localImportReport.imported||[];
        if(imported.length){
          const list=document.createElement("div");list.className="mlb-local-imported-list";
          imported.forEach(model=>{
            const row=document.createElement("div");
            row.innerHTML="<div><strong>"+(model.name||"Imported Model")+"</strong><span>"+(model.local_path||model.checkpoint_path||"")+"</span></div><b>IMPORTED</b>";
            list.appendChild(row);
          });
          report.appendChild(list);
        }

        if((localImportReport.errors||[]).length){
          const details=document.createElement("details");details.className="mlb-local-errors";
          const summary=document.createElement("summary");summary.textContent=localImportReport.errors.length+" incompatible / older checkpoint"+(localImportReport.errors.length===1?"":"s");
          details.appendChild(summary);
          localImportReport.errors.forEach(item=>{
            const row=document.createElement("div");row.innerHTML="<strong>"+item.path+"</strong><span>"+item.error+"</span>";details.appendChild(row);
          });
          report.appendChild(details);
        }
        container.appendChild(report);
      }

      const note=document.createElement("div");note.className="mlb-local-note";
      note.innerHTML="<strong>Path only.</strong> Builder recursively detects <code>last.pt</code>, <code>.pt</code>, <code>.pth</code>, <code>.ckpt</code> and MLBricks model bundles. Duplicate paths are ignored. Imported models are added automatically to <strong>Model Repository</strong>.";
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
      title.textContent="SESSION CREDENTIALS";card.appendChild(title);

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

    function renderCloudView(container){
      container.className="mlb-cloud-view";
      const head=document.createElement("div");head.className="mlb-cloud-head";
      head.innerHTML="<div><strong>CLOUD & REPOSITORIES</strong><span>Push and load Builder data, models and projects</span></div>"+
        "<span class='mlb-cloud-badge'>CLOUD</span>";
      container.appendChild(head);

      const providerBar=document.createElement("div");providerBar.className="mlb-cloud-provider-bar";
      providerBar.appendChild(cloudSelect("Provider",cloudForm.provider,[
        {value:"huggingface",label:"Hugging Face"},
        {value:"github",label:"GitHub"},
        {value:"aws",label:"AWS S3"},
        {value:"gcp",label:"Google Cloud Storage"},
        {value:"azure",label:"Azure Blob Storage"}
      ],v=>{cloudForm.provider=v;cloudStatus[v]=cloudStatus[v]||{};draw();}));
      const status=cloudStatus[cloudForm.provider]||{};
      const indicator=document.createElement("div");
      indicator.className="mlb-cloud-status "+(status.ok||status.authenticated?"ok":status.message?"warn":"idle");
      indicator.innerHTML="<strong>"+providerLabel(cloudForm.provider)+"</strong><span>"+(status.message||"Connection not checked")+"</span>";
      const check=btn("Check Connection","mlb-cloud-check");
      check.addEventListener("click",()=>requestCloudCommand("cloud_status",{
        provider:cloudForm.provider,
        credentials:currentCloudCredentials(),
        region:cloudForm.region
      }));
      providerBar.append(indicator,check);container.appendChild(providerBar);

      const credentials=document.createElement("div");credentials.className="mlb-cloud-card credentials";
      renderProviderCredentials(credentials);
      container.appendChild(credentials);

      const grid=document.createElement("div");grid.className="mlb-cloud-grid";

      const push=document.createElement("div");push.className="mlb-cloud-card";
      const pt=document.createElement("div");pt.className="mlb-cloud-card-title";
      pt.innerHTML="<strong>↑ PUSH</strong><span>Send local Builder content to "+providerLabel(cloudForm.provider)+"</span>";
      push.appendChild(pt);
      push.appendChild(cloudSelect("Content Type",cloudForm.push_type,[
        {value:"dataset",label:"Prepared Dataset"},
        {value:"model",label:"Built / Trained Model"},
        {value:"project",label:"Builder Project"}
      ],v=>{cloudForm.push_type=v;cloudForm.push_artifact="";draw();}));
      const artifacts=cloudArtifactOptions(cloudForm.push_type);
      if(!cloudForm.push_artifact&&artifacts.length)cloudForm.push_artifact=artifacts[0].id;
      push.appendChild(cloudSelect("Local Content",cloudForm.push_artifact,
        artifacts.length?artifacts.map(x=>({value:x.id,label:x.name+" — "+x.detail})):[{value:"",label:"Nothing available yet"}],
        v=>cloudForm.push_artifact=v
      ));
      providerTargetFields(push);
      if(cloudForm.provider==="huggingface"){
        const privacy=document.createElement("label");privacy.className="mlb-cloud-private";
        const box=document.createElement("input");box.type="checkbox";box.checked=!!cloudForm.private;
        box.addEventListener("change",()=>cloudForm.private=box.checked);
        const text=document.createElement("span");text.innerHTML="<strong>Private repository</strong><small>Uncheck to publish publicly</small>";
        privacy.append(box,text);push.appendChild(privacy);
      }
      const pushBtn=btn("↑ Push","mlb-cloud-primary");
      pushBtn.disabled=!artifacts.length;
      pushBtn.addEventListener("click",()=>{
        requestCloudCommand("cloud_push",cloudCommandConfig(cloudForm.push_type,cloudForm.push_artifact));
      });
      push.appendChild(pushBtn);grid.appendChild(push);

      const load=document.createElement("div");load.className="mlb-cloud-card";
      const lt=document.createElement("div");lt.className="mlb-cloud-card-title";
      lt.innerHTML="<strong>↓ LOAD</strong><span>Restore content from "+providerLabel(cloudForm.provider)+"</span>";
      load.appendChild(lt);
      load.appendChild(cloudSelect("Content Type",cloudForm.load_type,[
        {value:"dataset",label:"Prepared Dataset"},
        {value:"model",label:"MLBricks Builder Model"},
        {value:"project",label:"Builder Project"}
      ],v=>cloudForm.load_type=v));
      providerTargetFields(load);
      const loadBtn=btn("↓ Load","mlb-cloud-primary secondary");
      loadBtn.addEventListener("click",()=>{
        requestCloudCommand("cloud_load",cloudCommandConfig(cloudForm.load_type,null));
      });
      load.appendChild(loadBtn);grid.appendChild(load);

      container.appendChild(grid);

      const note=document.createElement("div");note.className="mlb-cloud-note";
      note.innerHTML="<strong>Cloud behavior:</strong> Hugging Face uses native dataset/model repositories. GitHub, S3, GCS and Azure store an MLBricks bundle containing the selected project, dataset or model. Large model checkpoints are better suited to object storage/Hugging Face than GitHub.";
      container.appendChild(note);
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
          "    "+arg("path","/kaggle/input/...")+",\n"+
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
          "    dataset, save_to_disk="+arg("save_to_disk","false")+", path="+arg("path","/kaggle/working/prepared_dataset")+",\n)";
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
      checkpoint("Add "+item.name);
      const n=makeNode(item);
      if(n.type==="text_input")configureTextInputForLatest(n);
      const pos=insertAfterSelection(n);
      setStatus(item.name+" inserted at layer "+(pos+1)+".");
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
      checkpoint("Duplicate "+n.name);
      const c=current(state),d=cp(n);d.id=uid("node");d.name=n.name+" Copy";
      const idx=c.nodes.findIndex(x=>x.id===n.id);
      c.nodes.splice(idx+1,0,d);
      rebuildMainFlow();
      selected=d.id;
      setStatus("Layer duplicated after "+n.name+".");
      draw();
    }

    function moveSelected(delta){
      const n=selectedNode();if(!n)return;
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
        format_version:"0.7.1",
        builder_version:"0.7.1",
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
      switchingWorkspace=false;
      rememberWorkspaceView();
      root.innerHTML="";

      // Top bar
      const top=document.createElement("div");top.className="mlb-topbar";
      const logo=document.createElement("div");logo.className="mlb-logo";logo.innerHTML='<span class="mlb-logo-mark">◇</span>MLBricks Builder <span class="mlb-beta">v0.6.7</span>';top.appendChild(logo);
      const title=document.createElement("div");title.className="mlb-project-title";title.textContent=state.project?.name||"Untitled";top.appendChild(title);
      const saved=document.createElement("div");saved.className="mlb-save-state";saved.textContent="• Saved";top.appendChild(saved);
      const sp=document.createElement("div");sp.className="mlb-topspacer";top.appendChild(sp);
      const acts=document.createElement("div");acts.className="mlb-top-actions";
      const modelRuntimeBusy=state.active_workspace==="model" && execution.status==="running" &&
        (execution.runtime_kind==="train"||execution.runtime_kind==="generate");
      const run=state.active_workspace==="model"
        ?btn(
            modelRuntimeBusy
              ?(execution.runtime_kind==="train"?"◆ Training":"◆ Generating")
              :"◆ Build",
            "mlb-run mlb-build"+(modelRuntimeBusy?" runtime-busy "+execution.runtime_kind:"")
          )
        :btn("▶ Run Data","mlb-run");
      run.disabled=modelRuntimeBusy;
      run.addEventListener("click",state.active_workspace==="model"?requestModelBuild:requestRun);
      const undoBtn=btn("↶ Undo","mlb-dark-btn mlb-history-btn");undoBtn.disabled=undoStack.length===0;undoBtn.title="Undo last model edit";undoBtn.addEventListener("click",undo);
      const redoBtn=btn("↷ Redo","mlb-dark-btn mlb-history-btn");redoBtn.disabled=redoStack.length===0;redoBtn.title="Redo last undone edit";redoBtn.addEventListener("click",redo);
      const clearBtn=btn("↻ Clear","mlb-dark-btn");clearBtn.addEventListener("click",()=>{
        const c=current(state);if(!c.nodes.length&&!c.edges.length)return;
        checkpoint("Clear graph");c.nodes=[];c.edges=[];selected=null;pendingPort=null;setStatus("Graph cleared.");draw();
      });
      const saveBtn=btn("▣ Save","mlb-dark-btn");saveBtn.title="Save full project as readable .mlbricks.json";saveBtn.addEventListener("click",saveDesign);
      const saveBinBtn=btn("BIN","mlb-dark-btn");saveBinBtn.title="Save full project as .mlbricks.bin";saveBinBtn.addEventListener("click",saveDesignBin);
      const loadBtn=btn("⇧ Load","mlb-dark-btn");loadBtn.title="Load .mlbricks.json or .mlbricks.bin";loadBtn.addEventListener("click",loadDesign);
      const stopBtn=btn("□ Stop","mlb-stop");stopBtn.addEventListener("click",requestStop);
      acts.appendChild(run);
      if(state.active_workspace==="data")acts.appendChild(stopBtn);
      acts.append(undoBtn,redoBtn,clearBtn,saveBtn,saveBinBtn,loadBtn,btn("⇩ Export","mlb-dark-btn"),btn("⌯ Share","mlb-dark-btn"),btn("?","mlb-dark-btn"),btn("⚙","mlb-dark-btn"));top.appendChild(acts);
      root.appendChild(top);

      const shell=document.createElement("div");shell.className="mlb-shell";

      // Sidebar
      const side=document.createElement("aside");side.className="mlb-sidebar";
      const head=document.createElement("div");head.className="mlb-sidehead";head.innerHTML="<span>"+(state.active_workspace==="data"?"DATA LIBRARY":"BRICK LIBRARY")+"</span><span>×</span>";side.appendChild(head);
      const sr=document.createElement("div");sr.className="mlb-search-row";
      const searchInput=document.createElement("input");searchInput.className="mlb-search";searchInput.placeholder=state.active_workspace==="data"?"Search data steps...":"Search bricks...";searchInput.value=search;searchInput.addEventListener("input",()=>{search=searchInput.value;draw();});
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
            const b=document.createElement("button");b.type="button";
            const ico=document.createElement("span");ico.className="mlb-pal-icon";ico.textContent=item.icon||"ML";
            const text=document.createElement("span");text.innerHTML="<strong>"+item.name+'</strong><span class="mlb-pal-sub">'+(item.description||"MLBricks component")+"</span>";
            b.append(ico,text);b.addEventListener("click",()=>addPrimitive(item));pal.appendChild(b);
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
            b.addEventListener("click",()=>addCustom(def));side.appendChild(b);
          });
          const create=btn("+ Create Custom Brick","mlb-create");create.addEventListener("click",createCustom);side.appendChild(create);
        }
      }

      // Main
      const main=document.createElement("main");main.className="mlb-main";
      const toolbar=document.createElement("div");toolbar.className="mlb-toolbar";
      const workspaceBadge=document.createElement("div");workspaceBadge.className="mlb-workspace-badge";
      workspaceBadge.textContent=runtimePanel
        ?(runtimePanel.mode==="train"
          ?((runtimePanel.tab||"setup")==="status"?"TRAINING STATUS":"TRAINING SETUP")
          :runtimePanel.mode==="generate"
            ?((runtimePanel.tab||"setup")==="status"?"GENERATION STATUS":"GENERATION SETUP")
            :((runtimePanel.tab||"setup")==="status"?"API SERVER STATUS":"API SERVER SETUP"))
        :workspaceName();
      toolbar.appendChild(workspaceBadge);

      if(runtimePanel && state.active_workspace==="model"){
        const entry=builtModelById(runtimePanel.modelId);
        if(entry){const name=document.createElement("div");name.className="mlb-runtime-toolbar-name";name.textContent=entry.name;toolbar.appendChild(name);}
        const tsp=document.createElement("div");tsp.className="mlb-toolspacer";toolbar.appendChild(tsp);
        const device=entry?selectedRuntimeDevice(runtimePanel.mode==="train"?entry.training_config:runtimePanel.mode==="generate"?entry.generation_config:entry.serve_config):null;
        if(device){const d=document.createElement("div");d.className="mlb-toolbar-device";d.textContent=device.label;toolbar.appendChild(d);}
      }else{
        const auto=btn("◎ Auto Layout","mlb-tool");
        auto.addEventListener("click",()=>{setStatus(workspaceName()+" auto layout applied.");draw();});
        const add=btn(state.active_workspace==="data"?"+ Add Step":"+ Add Layer","mlb-tool");
        add.addEventListener("click",()=>{
          setStatus(selected
            ?("Choose a "+(state.active_workspace==="data"?"data step":"brick")+" — it will be inserted after the selected "+(state.active_workspace==="data"?"step.":"layer."))
            :("Choose a "+(state.active_workspace==="data"?"data step":"brick")+" from the library."));
          draw();
        });
        toolbar.append(auto,add);

        if(state.active_workspace==="model"){
          const demo=btn("★ TinyStories 30M","mlb-tool");demo.addEventListener("click",loadTinyStories);toolbar.appendChild(demo);
        }else{
          const demo=btn("★ Default Data Pipeline","mlb-tool");demo.addEventListener("click",loadTextDataStarter);toolbar.appendChild(demo);
        }

        if(state.active_workspace==="data"){
          const kernel=document.createElement("div");kernel.className="mlb-kernel-badge";
          toolbar.appendChild(kernel);
          const live=document.createElement("div");live.className="mlb-run-live "+(execution.status||"idle");
          live.innerHTML="<strong>"+Math.max(0,Math.min(100,Number(execution.overall||0)))+"%</strong><span>"+(execution.message||"Ready")+"</span>";
          toolbar.appendChild(live);
          const latest=latestPreparedDataset();
          if(latest){
            const ready=document.createElement("div");ready.className="mlb-data-ready-chip";
            ready.innerHTML="<strong>"+latest.name+"</strong><span>"+compactDatasetSummary(latest)+"</span>";
            ready.title="Latest prepared dataset available to Model Builder Text Input";
            toolbar.appendChild(ready);
          }
          requestAnimationFrame(updateKernelBadge);
        }
        const tsp=document.createElement("div");tsp.className="mlb-toolspacer";toolbar.appendChild(tsp);
        const toggle=document.createElement("label");toggle.className="mlb-toggle";
        const cb=document.createElement("input");cb.type="checkbox";cb.checked=!!state.auto_connect;
        cb.addEventListener("change",()=>{checkpoint("Change Auto Connect");state.auto_connect=cb.checked;draw();});
        toggle.append(document.createTextNode("Auto Connect"),cb);toolbar.appendChild(toggle);

        const z=document.createElement("div");z.className="mlb-zoom";
        const zm=btn("−");zm.addEventListener("click",()=>{zoom=Math.max(.65,zoom-.1);draw();});
        const zs=document.createElement("span");zs.textContent=Math.round(zoom*100)+"%";
        const zp=btn("+");zp.addEventListener("click",()=>{zoom=Math.min(1.5,zoom+.1);draw();});
        z.append(zm,zs,zp);toolbar.appendChild(z);
      }
      main.appendChild(toolbar);

      const canvas=document.createElement("div");canvas.className="mlb-canvas"+(runtimePanel?" runtime-active":"");
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
          e.innerHTML="<strong>Build your model layer by layer.</strong><br><br>Add a brick from the left or load TinyStories 30M.";
        }
        flow.appendChild(e);
      }else{
        comp.nodes.forEach((n,i)=>{
          if(i){const a=document.createElement("div");a.className="mlb-arrow";a.textContent="→";flow.appendChild(a);}
          const info=n.type==="custom"?{accent:"purple",description:"Nested reusable layer",icon:"LAY",api:[]}:cat(catalog,n.type);
          const runState=execution.nodes?.[n.id];
          const card=document.createElement("div");
          card.className="mlb-node"+(selected===n.id?" selected":"")+(runState?" run-"+runState.status:"");
          card.dataset.nodeId=n.id;card.dataset.accent=info.accent||"purple";
          card.innerHTML='<span class="index">'+(i+1)+'</span>'+portButtons(n,"in")+'<div class="node-head"><div class="node-name"></div><div class="node-icon"></div></div><div class="node-desc"></div><div class="mlb-node-fields"></div><div class="node-meta"></div>'+portButtons(n,"out");
          if(runState){
            const rb=document.createElement("div");rb.className="mlb-run-badge";rb.textContent=runLabel(runState.status);rb.title=runState.message||"";card.appendChild(rb);
            if(runState.status==="running"){const rt=document.createElement("div");rt.className="mlb-run-track";rt.innerHTML="<i></i>";card.appendChild(rt);}
          }
          card.querySelector(".node-name").textContent=n.name;card.querySelector(".node-icon").textContent=info.icon||"ML";card.querySelector(".node-desc").textContent=info.description||"MLBricks layer";
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
          ?"Build left to right: one Data Source → Processing → Train/Val/Test → Tokenize → Prepared Dataset. Use Default Data Pipeline to reset."
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

      // Bottom project drawer always remains visible. Runtime mode collapses it
      // on entry, but the user can expand it manually without leaving training/generation.
      const details=document.createElement("div");details.className="mlb-details";

      const detailsBar=document.createElement("div");detailsBar.className="mlb-details-bar";
      const detailsLeft=document.createElement("div");detailsLeft.className="mlb-details-left";
      const detailsTitle=document.createElement("span");detailsTitle.className="mlb-details-title";
      detailsTitle.textContent=state.active_workspace==="data"?"DATA WORKSPACE":"MODEL WORKSPACE";

      const detailsSelect=document.createElement("select");detailsSelect.className="mlb-details-select";
      const options=state.active_workspace==="data"
        ?[["details","Pipeline Details"],["outputs","Output Directory"],["files","Files"],["local","Local / Kaggle Models"],["cloud","Cloud & Repositories"]]
        :[["details","Model Details"],["outputs","Output Directory"],["files","Files"],["local","Local / Kaggle Models"],["cloud","Cloud & Repositories"]];
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
          p1.innerHTML='<div class="mlb-bottom-title">STARTER</div><div class="mlb-preset-card"><strong>★ Default Data Pipeline</strong>Hugging Face → Clean → Train/Val/Test → Tokenize → Output</div>';
          p1.querySelector(".mlb-preset-card").addEventListener("click",loadTextDataStarter);
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
          p1.innerHTML='<div class="mlb-bottom-title">PRESETS</div><div class="mlb-preset-card"><strong>★ TinyStories 30M (6L)</strong>Context 512 · Batch 16<br>~30M parameters</div>';
          p1.querySelector(".mlb-preset-card").addEventListener("click",loadTinyStories);
          p2.innerHTML='<div class="mlb-bottom-title">GRAPH INFO</div><div class="mlb-stat-row"><span>Layers</span><strong>'+current(state).nodes.length+'</strong></div><div class="mlb-stat-row"><span>Connections</span><strong>'+(current(state).edges||[]).length+'</strong></div><div class="mlb-stat-row"><span>Context</span><strong>'+(state.project?.context_length||"—")+'</strong></div><div class="mlb-stat-row"><span>Batch Size</span><strong>'+(state.project?.batch_size||"—")+'</strong></div><div class="mlb-stat-row"><span>Status</span><strong class="mlb-good">Design Ready</strong></div>';
          p3.innerHTML='<div class="mlb-bottom-title">COMPUTE ESTIMATE</div><div class="mlb-stat-row"><span>Target Params</span><strong>'+(state.project?.estimated_parameters||"—")+'</strong></div><div class="mlb-stat-row"><span>Dataset</span><strong>'+(state.project?.dataset||"—")+'</strong></div><div class="mlb-stat-row"><span>Precision</span><strong>float16</strong></div><div class="mlb-stat-row"><span>Backend</span><strong>MLBricks</strong></div>';
          p4.innerHTML='<div class="mlb-bottom-title">CONNECTION LANES</div><div class="mlb-stat-row"><span>Skip</span><strong>Top Out → Top In</strong></div><div class="mlb-stat-row"><span>Main</span><strong>Middle Out → Middle In</strong></div><div class="mlb-stat-row"><span>Extra</span><strong>Bottom Out → Bottom In</strong></div><div class="mlb-stat-row"><span>Remove</span><strong>Inspector → Remove</strong></div>';
        }
        panels.append(p1,p2,p3,p4);
        details.appendChild(panels);
      }

      main.appendChild(details);

      // Inspector
      const ins=document.createElement("aside");ins.className="mlb-inspector";
      const tabs=document.createElement("div");tabs.className="mlb-ins-tabs";
      [["settings","Inspector"],["info","Node Info"]].forEach(([k,t])=>{const b=btn(t);if(inspectorTab===k)b.className="active";b.addEventListener("click",()=>{inspectorTab=k;draw();});tabs.appendChild(b);});ins.appendChild(tabs);
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
        const api=apiInfo(n);body.innerHTML='<div class="mlb-selected"><strong>'+n.name+'</strong><span class="mlb-pill">'+(api.public_name||"Custom")+'</span></div>';
        const s=document.createElement("div");s.className="mlb-summary";[["Type",n.type],["Definition",n.definition_id?"Custom":"Built-in"],["Repeat",n.repeat||1],["API",api.import_path||"custom"],["Status","Valid"]].forEach(([a,b])=>{const r=document.createElement("div");r.className="mlb-summary-row";r.innerHTML="<span>"+a+"</span><strong>"+b+"</strong>";s.appendChild(r);});body.appendChild(s);
      }else{
        const api=apiInfo(n);const info=n.type==="custom"?{api:[]}:cat(catalog,n.type);
        const sw=document.createElement("div");sw.className="mlb-selected";sw.innerHTML="<strong>"+n.name+"</strong><span class='mlb-pill'>"+(api.public_name||"Custom Layer")+"</span>";body.appendChild(sw);
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
            [[90,5,5,"90 / 5 / 5"],[80,10,10,"80 / 10 / 10"],[90,10,0,"90 / 10 / 0"]].forEach(([tr,va,te,label])=>{
              const b=btn(label);b.addEventListener("click",()=>setSplitPreset(n,tr,va,te,label));presets.appendChild(b);
            });
            body.appendChild(presets);
          }

          const st=document.createElement("div");st.className="mlb-section-title";st.textContent=state.active_workspace==="data"?"DATA SETTINGS":"PARAMETERS";body.appendChild(st);
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
        const moveTitle=document.createElement("div");moveTitle.className="mlb-section-title";moveTitle.textContent=state.active_workspace==="data"?"STEP POSITION":"LAYER POSITION";body.appendChild(moveTitle);
        const moveGrid=document.createElement("div");moveGrid.className="mlb-action-grid mlb-move-grid";
        const moveLeft=btn(state.active_workspace==="data"?"← Move Earlier":"← Move Left");
        const moveRight=btn(state.active_workspace==="data"?"Move Later →":"Move Right →");
        const nodeIndex=current(state).nodes.findIndex(x=>x.id===n.id);
        moveLeft.disabled=nodeIndex<=0;
        moveRight.disabled=nodeIndex<0||nodeIndex>=current(state).nodes.length-1;
        moveLeft.addEventListener("click",()=>moveSelected(-1));
        moveRight.addEventListener("click",()=>moveSelected(1));
        moveGrid.append(moveLeft,moveRight);body.appendChild(moveGrid);

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

      const stat=document.createElement("div");stat.className="mlb-statusbar";
      let statusDevice="Auto";
      if(runtimePanel){
        const e=builtModelById(runtimePanel.modelId);
        if(e){const cfg=runtimePanel.mode==="train"?e.training_config:e.generation_config;statusDevice=selectedRuntimeDevice(cfg).label;}
      }
      stat.innerHTML='<span>Workspace: '+workspaceName()+'</span><span>Backend: '+(state.active_workspace==="data"?"Builder Data API":"MLBricks Runtime")+'</span><span>Device: '+statusDevice+'</span><span class="right mlb-ready">● '+status+"</span>";
      root.appendChild(stat);
    }

    draw();
    startBridgePolling();
  }

  window.MLBricksBuilder={mount};
})();
