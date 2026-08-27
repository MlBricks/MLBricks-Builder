function deepCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function primitiveNode(item) {
  return {
    id: uid("node"),
    type: item.type,
    name: item.name,
    definition_id: null,
    repeat: 1,
    params: {},
    children: [],
    connections: []
  };
}

function currentComponent(state) {
  return state.components[state.view_component_id];
}

function sync(model, state) {
  state.project.updated_at = new Date().toISOString();
  model.set("state", deepCopy(state));
  model.save_changes();
}

function makeButton(text, cls="mlb-btn") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  return b;
}

export function render({ model, el }) {
  const root = document.createElement("div");
  root.className = "mlb-root";
  el.appendChild(root);

  let state = deepCopy(model.get("state"));
  let catalog = deepCopy(model.get("catalog"));
  let selectedId = null;
  let statusText = "Ready";

  function status(message) {
    statusText = message;
    draw();
  }

  function selectedNode() {
    const comp = currentComponent(state);
    return comp.nodes.find(n => n.id === selectedId) || null;
  }

  function openDefinition(node) {
    if (!node.definition_id) return;
    const def = state.custom_components[node.definition_id];
    if (!def) return;

    const componentId = `view_${node.definition_id}`;
    state.components[componentId] = {
      id: componentId,
      name: def.name,
      kind: "custom_edit",
      definition_id: node.definition_id,
      revision: def.revision,
      nodes: deepCopy(def.nodes)
    };
    state.view_component_id = componentId;
    state.breadcrumbs.push({id: componentId, name: def.name});
    selectedId = null;
    sync(model, state);
    draw();
  }

  function saveCurrentCustom(mode) {
    const comp = currentComponent(state);
    if (comp.kind !== "custom_edit") return;
    const def = state.custom_components[comp.definition_id];
    if (!def) return;

    if (mode === "override") {
      def.nodes = deepCopy(comp.nodes);
      def.revision = (def.revision || 1) + 1;
      comp.revision = def.revision;
      sync(model, state);
      status(`Saved ${def.name} revision ${def.revision}`);
      return;
    }

    const newName = window.prompt("Save as new component name:", `${def.name} Copy`);
    if (!newName) return;
    const newId = uid("custom");
    state.custom_components[newId] = {
      id: newId,
      name: newName,
      description: "",
      revision: 1,
      nodes: deepCopy(comp.nodes)
    };
    sync(model, state);
    status(`Created ${newName}`);
  }

  function createComponentFromCurrent() {
    const comp = currentComponent(state);
    if (!comp.nodes.length) {
      status("Add nodes before creating a component.");
      return;
    }
    const name = window.prompt("Component name:", "My Component");
    if (!name) return;
    const newId = uid("custom");
    state.custom_components[newId] = {
      id: newId,
      name,
      description: "",
      revision: 1,
      nodes: deepCopy(comp.nodes)
    };
    sync(model, state);
    status(`${name} saved to My Bricks`);
  }

  function addCustom(def) {
    const comp = currentComponent(state);
    comp.nodes.push({
      id: uid("node"),
      type: "custom",
      name: def.name,
      definition_id: def.id,
      repeat: 1,
      params: {},
      children: [],
      connections: []
    });
    sync(model, state);
    draw();
  }

  function draw() {
    root.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "mlb-toolbar";
    const brand = document.createElement("div");
    brand.className = "mlb-brand";
    brand.textContent = "MLBRICKS BUILDER";
    toolbar.appendChild(brand);

    const createBtn = makeButton("Create Component");
    createBtn.addEventListener("click", createComponentFromCurrent);
    toolbar.appendChild(createBtn);

    const runBtn = makeButton("Run", "mlb-btn primary");
    runBtn.addEventListener("click", () => status("Graph is ready for MLBricks runtime adapter."));
    toolbar.appendChild(runBtn);
    root.appendChild(toolbar);

    const layout = document.createElement("div");
    layout.className = "mlb-layout";

    const sidebar = document.createElement("aside");
    sidebar.className = "mlb-sidebar";
    const st = document.createElement("div");
    st.className = "mlb-title";
    st.textContent = "Components";
    sidebar.appendChild(st);

    const palette = document.createElement("div");
    palette.className = "mlb-palette";
    catalog.forEach(item => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${item.icon}  ${item.name}`;
      b.addEventListener("click", () => {
        currentComponent(state).nodes.push(primitiveNode(item));
        sync(model, state);
        draw();
      });
      palette.appendChild(b);
    });
    sidebar.appendChild(palette);

    const customSection = document.createElement("div");
    customSection.className = "mlb-section";
    const ct = document.createElement("div");
    ct.className = "mlb-title";
    ct.textContent = "My Bricks";
    customSection.appendChild(ct);

    const defs = Object.values(state.custom_components || {});
    if (!defs.length) {
      const note = document.createElement("div");
      note.className = "mlb-note";
      note.textContent = "Create a reusable component from the current layer.";
      customSection.appendChild(note);
    } else {
      defs.forEach(def => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "mlb-custom-item";
        b.textContent = `${def.name}  ·  v${def.revision}`;
        b.addEventListener("click", () => addCustom(def));
        customSection.appendChild(b);
      });
    }
    sidebar.appendChild(customSection);

    const canvas = document.createElement("main");
    canvas.className = "mlb-canvas";

    const crumbs = document.createElement("div");
    crumbs.className = "mlb-breadcrumbs";
    state.breadcrumbs.forEach((crumb, i) => {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "mlb-crumb";
      c.textContent = crumb.name;
      c.addEventListener("click", () => {
        state.view_component_id = crumb.id;
        state.breadcrumbs = state.breadcrumbs.slice(0, i + 1);
        selectedId = null;
        sync(model, state);
        draw();
      });
      crumbs.appendChild(c);
      if (i < state.breadcrumbs.length - 1) {
        const sep = document.createElement("span");
        sep.textContent = "/";
        crumbs.appendChild(sep);
      }
    });
    canvas.appendChild(crumbs);

    const flow = document.createElement("div");
    flow.className = "mlb-flow";
    const comp = currentComponent(state);

    if (!comp.nodes.length) {
      const empty = document.createElement("div");
      empty.className = "mlb-empty";
      empty.textContent = "Add bricks from the left. Layers stay aligned left → right.";
      flow.appendChild(empty);
    } else {
      comp.nodes.forEach((node, index) => {
        if (index) {
          const arrow = document.createElement("div");
          arrow.className = "mlb-arrow";
          arrow.textContent = "→";
          flow.appendChild(arrow);
        }

        const n = document.createElement("div");
        n.className = `mlb-node${node.id === selectedId ? " selected" : ""}`;
        n.innerHTML = `
          <span class="mlb-port in"></span>
          <div class="name">${node.name}</div>
          <div class="meta">${node.type === "custom" ? "Custom Component" : node.type.toUpperCase()}</div>
          <div class="meta">${node.repeat > 1 ? `Repeat ×${node.repeat}` : "Layer"}</div>
          <span class="mlb-port out"></span>
        `;
        n.addEventListener("click", () => {
          selectedId = node.id;
          draw();
        });
        flow.appendChild(n);
      });
    }
    canvas.appendChild(flow);

    const inspector = document.createElement("aside");
    inspector.className = "mlb-inspector";
    const it = document.createElement("div");
    it.className = "mlb-title";
    it.textContent = "Layer Inspector";
    inspector.appendChild(it);

    const node = selectedNode();
    if (!node) {
      const note = document.createElement("div");
      note.className = "mlb-note";
      note.textContent = "Select a layer to rename it, set repeats, or open a nested custom component.";
      inspector.appendChild(note);
    } else {
      const nameField = document.createElement("div");
      nameField.className = "mlb-field";
      nameField.innerHTML = `<label>Name</label><input value="${node.name.replaceAll('"', '&quot;')}">`;
      const nameInput = nameField.querySelector("input");
      nameInput.addEventListener("change", () => {
        node.name = nameInput.value.trim() || node.name;
        sync(model, state);
        draw();
      });
      inspector.appendChild(nameField);

      const repeatField = document.createElement("div");
      repeatField.className = "mlb-field";
      repeatField.innerHTML = `<label>Repeat</label><input type="number" min="1" max="100000" value="${node.repeat || 1}">`;
      const repeatInput = repeatField.querySelector("input");
      repeatInput.addEventListener("change", () => {
        node.repeat = Math.max(1, Math.min(100000, Number(repeatInput.value) || 1));
        sync(model, state);
        draw();
      });
      inspector.appendChild(repeatField);

      const actions = document.createElement("div");
      actions.className = "mlb-actions";

      if (node.definition_id) {
        const edit = makeButton("Open Inside");
        edit.addEventListener("click", () => openDefinition(node));
        actions.appendChild(edit);
      }

      const del = makeButton("Delete Layer");
      del.addEventListener("click", () => {
        const c = currentComponent(state);
        c.nodes = c.nodes.filter(x => x.id !== node.id);
        selectedId = null;
        sync(model, state);
        draw();
      });
      actions.appendChild(del);
      inspector.appendChild(actions);
    }

    const active = currentComponent(state);
    if (active.kind === "custom_edit") {
      const sec = document.createElement("div");
      sec.className = "mlb-section";
      const label = document.createElement("div");
      label.className = "mlb-title";
      label.textContent = "Custom Component";
      sec.appendChild(label);
      const override = makeButton("Override / New Revision");
      override.addEventListener("click", () => saveCurrentCustom("override"));
      sec.appendChild(override);
      const saveNew = makeButton("Save As New");
      saveNew.style.marginTop = "6px";
      saveNew.addEventListener("click", () => saveCurrentCustom("new"));
      sec.appendChild(saveNew);
      inspector.appendChild(sec);
    }

    layout.appendChild(sidebar);
    layout.appendChild(canvas);
    layout.appendChild(inspector);
    root.appendChild(layout);

    const footer = document.createElement("div");
    footer.className = "mlb-status";
    footer.textContent = statusText;
    root.appendChild(footer);
  }

  model.on("change:state", () => {
    state = deepCopy(model.get("state"));
    draw();
  });
  model.on("change:catalog", () => {
    catalog = deepCopy(model.get("catalog"));
    draw();
  });

  draw();
}
