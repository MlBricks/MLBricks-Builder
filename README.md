# MLBricks Builder

Hierarchical left-to-right visual model builder for MLBricks.

## Install on Kaggle

```python
%pip install -U "git+https://github.com/MlBricks/MLBricks-Builder.git"
```

Then:

```python
from mlbricks_builder import Builder

builder = Builder()
builder
```

Version 0.1.2 deliberately removes `anywidget`. The Builder uses Jupyter's standard HTML representation protocol instead, so Kaggle does not need to register a custom frontend widget module.

MLBricks itself remains a separate dependency and is installed from:

`https://github.com/MlBricks/MLBricks.git`

## v0.1.3 UI

Compact narrow layer cards, full left component palette, right-side API inspector, layer/model tabs, and a layout matching the MLBricks Builder mockup more closely.


## v0.2.0 — Layer-by-layer workflow

The Builder now includes:

- Compact left-to-right layer cards matching the MLBricks Builder design direction.
- Clickable input/output ports for manual ComfyUI-style connections.
- Shift + input-port connection for a residual/skip edge.
- Beginner-friendly Auto Connect toggle.
- Component-specific MLBricks API inspector on the right.
- Nested reusable layer architecture with double-click / Open Architecture.
- Override and Save As New workflow for custom components.
- TinyStories 30M starter preset:
  - 6 nested model layers
  - target ~30M parameters
  - 512 context
  - batch size 16
  - TinyStories dataset
  - each model layer contains ESA → RMSNorm → FFN → Residual
- `Builder(preset="tinystories")` to open the starter directly.

Example:

```python
from mlbricks_builder import Builder

Builder(preset="tinystories")
```

The preset's ~30M value is an architecture target/estimate. Exact trainable parameters should be calculated by the installed MLBricks runtime because implementation details, vocabulary size and weight tying can change between MLBricks versions.


## v0.2.1 — Real MLBricks API inspector

The right inspector is built from the currently installed MLBricks package with `inspect.signature`. No MLBricks algorithms are copied into Builder. Updating/reinstalling MLBricks updates the available constructor parameters shown by Builder.

Examples found in MLBricks 1.0.0 include `ESA(embd, head=4, ..., backend="auto", precision="fp16", compass="auto", ..., device="auto")`, `FFN(hidden_size, intermediate_size=None, activation="gelu", ...)`, `StateAwareFFN(d_model, state_dim=256, ...)`, and `Bolt(d_model, num_heads, latent_dim=32, ...)`.

Use `builder.component_api("esa")` to inspect the metadata in Python.


## v0.3.0

Full dark ComfyUI-style MLBricks Builder frontend with layer-by-layer layout, curved manual connections, residual edges, minimap, dark inspector, real installed MLBricks API forms, nested custom components, and TinyStories 30M preset.


## v0.3.1 — Kaggle stale-renderer + real API fix

This release fixes a notebook-specific bug in v0.3.0. Kaggle keeps JavaScript
globals alive in the browser page. Older Builder outputs had registered
`window.MLBricksBuilder`, and v0.3.0 incorrectly returned early when it found
that global. The result was new CSS applied to an old renderer.

v0.3.1 always replaces the old renderer before mounting, and shows `v0.3.1`
visibly in the Builder header.

It also aligns the TinyStories starter with the real MLBricks 1.0.0 constructor
arguments from the uploaded library:

- `ESA(embd=384, head=6, batch=16, block=512, ...)`
- `Embedding(vocab_size=32000, embedding_dim=384)`
- `RMSNorm(normalized_shape=384, ...)`
- `FFN(hidden_size=384, intermediate_size=1536, ...)`
- `Residual(dropout=0.0)`
- `LMHead(hidden_size=384, vocab_size=32000, ...)`

Run:

```python
builder = Builder(preset="tinystories")
builder.diagnostics()
```

to verify which real MLBricks APIs were discovered.


## v0.3.2 — Source-backed API schema

The API inspector no longer depends on importing every MLBricks component
successfully at notebook startup.

This release's API schema was generated directly from the supplied
`MLBricks-main (2)(2).zip` source (MLBricks 1.0.0). Runtime introspection is
still attempted; when it works, it takes precedence. If it does not work,
the exact source-derived constructor/config schema remains available.

Examples:

- ESA: `embd`, `head`, `batch`, `block`, `backend`, `precision`, `compass`,
  `dropout`, `gate_min`, `gate_max`, `eps`, `device`, `auto_compile`,
  `compile_mode`, `auto_move_input`, `strict_checks`
- Bolt: `d_model`, `num_heads`, `latent_dim`, `bias`, `dropout`, `causal`,
  `backend`, `autotune_kernels`, `eps`, `use_sdpa`, `position`,
  `native_full_sequence`
- FFN: `hidden_size`, `intermediate_size`, `activation`, `dropout`, `bias`,
  `gated`, `device`, `dtype`
- StateAwareFFN, MicroVirtualFFN, VirtualStateAwareFFN
- RMSNorm, LayerNorm, Residual, ResController
- Vesa/VesaConfig and VisionBolt/VisionBoltConfig
- ElasticBit, ElasticLinear, ElasticEmbedding
- RoPE, LearnedPosition, SinusoidalPosition
- Brick and Bricks

Builder-owned input/output nodes also have their own valid interface and never
display “API unavailable”.


## v0.3.3 — residual pipeline + custom ports

This release adds the workflow behavior requested for kids and custom builders:

- residual connections are drawn like a top pipeline / bus
- auto-connect still builds the normal left-to-right layer flow
- users can also create manual custom connections between layers
- custom layers can expose a chosen number of input and output ports
- `Residual Add` defaults to 2 inputs and 1 output
- nested custom layers save and reload their chosen public interface
- hold **Shift** while connecting to create a residual pipeline


## v0.3.4 — per-node residual ports and removable connections

This release removes the residual top bus and replaces it with clearer
per-node residual ports:

- every node has a **top residual input port**
- every node has a **bottom residual output port**
- side ports remain for the normal left-to-right data flow
- residual connections are created using **bottom residual port → top residual port**
- users can create multiple residual/skip connections
- the inspector now lists all connections for the selected node and gives a
  **Remove** button for each connection
- a **Remove All Links** action is also provided


## v0.3.5 — fixed 3-lane left-to-right ports

Every node now has exactly three inputs on the left and three outputs on the right:

- top: **Skip In / Skip Out** — residual and skip connections, routed above intervening nodes
- middle: **Main In / Main Out** — normal model flow; Auto Connect uses this lane
- bottom: **Extra In / Extra Out** — auxiliary/custom signals, routed below intervening nodes

Multiple skip connections are supported. Skip routes receive separate vertical offsets so multiple residual paths stay readable. Existing per-connection **Remove** buttons and **Remove All Links** remain available in the Inspector. Custom/nested layers use the same fixed three-lane public interface.


## v0.3.6 — compact Kaggle workspace

The Builder is now constrained to an app-like notebook height instead of
growing with the Brick Library or Inspector.

- left Brick Library scrolls independently
- right API Inspector scrolls independently
- Input/Core/Advanced/Position/Heads/Outputs sections are clickable
  collapse/expand controls
- Advanced, Position, Heads, and Outputs start collapsed to save space
- search temporarily expands matching categories
- all categories can be expanded and the library remains scrollable
- the center graph canvas keeps the remaining vertical space
- large blank space above/below the node row was reduced
- Presets/Graph Info/Compute/Shortcuts moved into a compact **Model Details**
  drawer that is collapsed by default
