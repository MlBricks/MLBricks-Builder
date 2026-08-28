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


## v0.3.7 — sketch-accurate 3-in / 3-out node terminals

The six terminals now match the hand-drawn design instead of putting all three
inputs on the left and all three outputs on the right.

Each node has:

- **Top edge**
  - input near the top-left
  - output near the top-right
- **Middle**
  - input on the left side
  - output on the right side
- **Bottom edge**
  - input near the bottom-left
  - output near the bottom-right

This keeps all signals left-to-right while allowing:

- top routes to travel above intervening nodes
- normal main routes through the center
- bottom routes below intervening nodes

The Builder notebook workspace is also about 20% taller than v0.3.6.


## v0.3.8 — persistent canvas HUD spacing

The canvas overlays no longer move when the graph is horizontally scrolled:

- **Blueprint** stays pinned above the node row
- the port-layout instruction banner stays pinned near the bottom
- extra vertical runway keeps a visible gap between Blueprint/top routes and nodes
- **Model Details** is now an overlay drawer
- expanding Model Details does **not** resize the canvas or move the node row/banner
- when Model Details opens, it covers the lower canvas/banner area as requested
  instead of pushing the banner upward


## v0.3.9 — horizontal-only HUD persistence

Blueprint and the node-layout instruction banner now remain horizontally
persistent during left/right graph scrolling, but they are **not vertically
pinned**.

The vertical layout behaves as one continuous stack:

`Blueprint → fixed gap → node row → fixed gap → instruction banner`

So when the user scrolls the canvas vertically, all three move together and
their relative vertical distances stay unchanged.

Model Details remains an overlay drawer and does not reflow the graph.


## v0.3.10 — zoom-safe graph + Undo / Redo

### Zoom fix
The graph wrapper now grows to the scaled visual dimensions. At 110–150% zoom,
right-side nodes, bottom ports, routed edges and the instruction banner remain
inside the real scrollable canvas instead of being clipped or overlapping due
to CSS transform layout mismatch.

### Undo / Redo
The toolbar now has **Undo** and **Redo** buttons backed by a 60-step model
history. History includes node add/delete/duplicate, connections, connection
removal, API parameter edits, custom bricks, TinyStories preset loading, Clear,
and Auto Connect changes. Zoom and sidebar UI state are intentionally not model
history operations.


## v0.3.11 — insertion at selection + layer reordering

- Brick Library labels/descriptions are consistently left-aligned and no longer overlap.
- Adding a built-in or custom brick inserts it **immediately after the selected node**.
- If no node is selected, the new brick is appended to the end.
- With Auto Connect enabled, the middle Main lane is rebuilt automatically after insertion,
  deletion, duplication, or movement while Skip and Extra connections are preserved.
- The Inspector now provides **Move Left** and **Move Right** controls for the selected layer.
- Move/add/delete/reorder operations are included in Undo/Redo history.


## v0.3.12 — empty custom-brick shells + unique names

Custom-brick creation is now isolated from the current model canvas.

- **Create Custom Brick** always creates an empty nested component:
  - `nodes = []`
  - `edges = []`
- Existing model nodes/siblings are never copied into a newly created custom brick.
- The new empty custom brick opens immediately for internal editing.
- Custom brick names must be unique after trimming spaces and ignoring case.
  For example, `SAM`, `sam`, and ` Sam ` are treated as the same name.
- The same unique-name rule applies to **Save As New**.
- Empty shells are visibly marked as `Empty` in **My Bricks**.


## v0.4.0 — Data + Text Processing pipeline

MLBricks Builder can now design the dataset path together with the model.

### Data sources

- **Hugging Face Dataset**
- **Kaggle Dataset**
- **URL Dataset**
- **Local Dataset**

### Text processing

- **Text Processing** — Unicode normalization, whitespace cleanup, lowercase,
  empty filtering, minimum/maximum text length
- **Train / Test Split** — configurable train/test ratio, seed and shuffle
- **Tokenize Text** — Hugging Face tokenizer, context length, truncation,
  padding and special-token controls

Example visual pipeline:

`Hugging Face Dataset → Text Processing → Train/Test Split → Tokenize Text → Embedding → Model`

The Inspector shows runnable **DATA PYTHON** for data/text nodes using
`mlbricks_builder.data`. These are Builder APIs, not fake `mlbricks` imports.

### Save / Load Design

The top **Save** button now downloads the complete design as
`<project>.mlbricks.json`, including:

- data pipeline
- preprocessing settings
- train/test split configuration
- model nodes and connections
- custom bricks
- project settings

The **Load** button restores the same design from JSON.

### Optional data dependencies

Keep the normal Builder installation light. Install data features with:

```bash
pip install "mlbricks-builder[data]"
```

or, when installing Builder from GitHub in Kaggle, install:

```bash
pip install datasets kagglehub transformers pandas pyarrow
```

Authentication tokens/credentials are deliberately **not** stored in design
files. Hugging Face and Kaggle use their normal notebook/environment login.


## v0.4.1 — Text Input as the kid-friendly text workspace

For beginners, all common text preparation now lives inside **Text Input**.

Click Text Input to get four simple collapsible sections:

1. **Text Source** — Manual, Hugging Face, Kaggle, URL, or Local File
2. **Clean Text** — cleanup/normalization/filtering
3. **Train / Test** — split percentages, seed, shuffle
4. **Tokenization** — tokenizer, context, truncation, padding

The UI is conditional: selecting Hugging Face shows Hugging Face fields;
selecting Kaggle shows Kaggle fields; turning a processing step off hides its
advanced controls.

Standalone Data/Text Processing bricks remain available for advanced workflows,
but those categories start collapsed. The beginner path is one Text Input node.

The Text Input configuration is saved in the normal `.mlbricks.json` design.
Its runnable code uses the real Builder helper
`mlbricks_builder.data.prepare_text_input(...)`; it never generates a fake
`from mlbricks import Text Input`.


## v0.5.0 — separate Model Builder and Data Processing workspaces

The category-chip row has been replaced by a simple **Build Workspace** selector:

- **Model Builder**
- **Data Processing**

Each workspace has its own independent graph and both graphs are saved in the
same `.mlbricks.json` project.

### Model Builder

Shows model-building components only:

- Inputs
- Core Blocks
- normalization
- advanced blocks
- position
- heads
- outputs
- My Bricks / custom components

`Text Input` is simple again: it represents prompt/text entering the model.
Dataset downloading, train/test splitting and tokenization are no longer hidden
inside Text Input.

### Data Processing

Shows data operations only:

- **Data Source**
  - Manual Text Data
  - Hugging Face Dataset
  - Kaggle Dataset
  - URL Dataset
  - Local Dataset
- **Splitting**
  - Train / Validation / Test Split
- **Text**
  - Text Processing
  - Tokenize Text
- **Image**
  - Image Processing
- **Audio**
  - Audio Processing
- **Dataset**
  - Batch / DataLoader
- **Output**
  - Prepared Dataset

The right Inspector shows **Builder Data API** code for these processing nodes.
The helper functions are implemented in `mlbricks_builder.data`; they are not
fake `mlbricks` imports.

### Saved project structure

Conceptually:

```text
MLBricks Project
├── Model Builder graph
├── Data Processing graph
├── Custom Bricks
└── Project Settings
```

Switching workspaces preserves each canvas, nested model view, and scroll
position. Legacy pre-v0.5 designs are migrated in the browser by creating a new
empty Data Processing workspace while preserving the existing model graph.

### Beginner data starter

In Data Processing mode, **Text Data Starter** builds:

`Hugging Face → Clean Text → Train/Val/Test → Tokenize → Prepared Dataset`


## v0.5.1 — proper train/validation/test UI + beginner data pipeline

### Split interface

The Hugging Face source field previously labelled `Split` is now labelled
**Hub Source Split**. It only chooses which existing Hub split to download.
It is deliberately separated from dataset percentages.

The real **Train / Validation / Test Split** processing step now has:

- Training percentage slider + number input
- Validation percentage slider + number input
- Testing percentage slider + number input
- live split preview
- live total validation (`100%` required)
- beginner presets: `90/5/5`, `80/10/10`, `90/10/0`
- random seed and shuffle controls

Its executable Builder Data API calls
`train_validation_test_split(dataset, train_size=..., validation_size=..., test_size=...)`.
The backend validates that the three proportions sum to exactly 1.0.

### Default Data Processing pipeline

Every brand-new project now already contains:

`Hugging Face → Text Processing → Train/Validation/Test → Tokenize → Batch/DataLoader → Prepared Dataset`

The **Text Data Starter** button rebuilds the same beginner-ready pipeline.
Legacy projects that do not yet contain a Data Processing workspace are migrated
with this starter pipeline instead of a blank canvas.

### Binary project files

The top toolbar now includes **BIN** next to Save.

- **Save** → `<project>.mlbricks.json`
- **BIN** → `<project>.mlbricks.bin`
- **Load** automatically accepts either format

The binary file uses an `MLBRICKS-BIN-1` header followed by the project payload.
Python helpers are also available in `mlbricks_builder.design_io`.


## v0.5.2 — executable Data Run + live node progress

### Correct default beginner pipeline

Every new Data Processing workspace now starts with:

`Hugging Face → Text Processing → Train/Validation/Test → Tokenize → Prepared Dataset`

The default Hugging Face source is capped at 10,000 rows so a beginner does not
accidentally start by processing an entire large dataset. Set Max Rows to 0 to
use all rows.

**Batch / DataLoader** remains available as an optional advanced step.

### Run now executes the Python data pipeline

Builder uses a bridge made only from **standard ipywidgets** (no AnyWidget or
custom frontend extension). In Jupyter/Kaggle, the visual Run button sends the
current graph to Python and executes `mlbricks_builder.runner`.

The active node is visibly highlighted:

- `QUEUED`
- `RUNNING`
- `DONE`
- `ERROR`
- `STOPPED`

The toolbar shows overall step progress and the Inspector shows the selected
node's live execution state. Long operations use an indeterminate activity bar
rather than inventing a fake percentage.

**Stop** requests cancellation after the currently active processing step.

If a notebook frontend does not expose standard ipywidgets comms, the Builder
continues to render normally and the same real runner is available through:

```python
builder.run_data_pipeline()
```

### Beginner validation

Run refuses obviously invalid data pipelines before downloading or processing
anything. It checks for:

- exactly one Data Source
- exactly one Prepared Dataset output
- Prepared Dataset being the final step
- Train + Validation + Test totaling 100%
- disconnected Main-lane steps
- cycles / unsupported branching in the beginner runner

Invalid nodes are highlighted in red with a readable explanation.

Use **Default Data Pipeline** to instantly restore the known-good beginner
pipeline.

JSON and `.mlbricks.bin` project Save/Load support remains available.


## v0.5.3 — Kaggle Run bridge hardening + contained node text

### Node-card overflow fix

Long dataset IDs, URLs and filesystem paths can no longer escape the node card.
Mini fields use bounded two-column layouts with ellipsis. Hovering a clipped
label/value shows the full text via a tooltip.

This fixes examples such as:

- `roneneldan/TinyStories`
- `/kaggle/working/prepared_dataset`
- long URL dataset links

### Run bridge fix for Kaggle/Jupyter

The Run bridge no longer searches only the HTML output document. It now searches:

- the Builder output document
- the parent notebook document
- the top notebook document
- accessible sibling/child frame documents
- open shadow roots

This matters in notebook frontends such as Kaggle where raw HTML output and
standard ipywidgets may be mounted in different document contexts.

Writing the current graph into the hidden standard Textarea now uses the native
DOM value setter plus `input`/`change` events from the target document. Run and
Stop activate standard ipywidgets buttons in the document where they are
actually mounted.

The Data toolbar now shows:

- **Kernel Connected** — visual Run can execute Python
- **Kernel Offline** — re-run the Builder cell before trying Run

After Run is clicked, Builder waits for a Python acknowledgement. If the kernel
does not respond within three seconds, it displays a clear error instead of
silently appearing to do nothing.

The direct Python fallback remains:

```python
builder.run_data_pipeline()
```
