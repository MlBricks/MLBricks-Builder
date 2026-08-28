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


## v0.5.4 — Dataset Registry + automatic Model Text Input binding

A successful Data Processing run now creates a reusable **Prepared Dataset**
entry in the project.

### Completion result

After the pipeline reaches `DONE`, Builder reports real split row counts, e.g.:

- Train: 9,000
- Validation: 500
- Test: 500

The Prepared Dataset Inspector shows these counts and whether the data is in
memory or also saved to disk.

### Multiple datasets

Prepared Dataset now has a **Dataset Name** setting.

Runs with different names are kept as separate datasets in the project-level
Dataset Registry. Re-running the same name refreshes that registry entry rather
than creating duplicate names.

### Model Builder integration

Text Input now supports:

- **Prompt**
- **Prepared Dataset**

When Prepared Dataset is selected it shows:

- **Available Dataset** — dropdown of every completed dataset
- **Use Split** — dropdown populated from that dataset's actual splits

After a Data Processing run completes, the newest dataset is automatically
selected by existing Text Input nodes in the Model Builder. A Text Input added
later also defaults to the newest prepared dataset.

The Text Input Inspector shows the selected dataset's Train / Validation / Test
counts.

### Python access

Actual Dataset/DatasetDict objects remain in the Builder's Python registry:

```python
builder.available_datasets()
dataset = builder.get_prepared_dataset("TinyStories Prepared")
train = builder.get_prepared_dataset("TinyStories Prepared", split="train")
```

Dataset metadata is saved in the project design. Actual data stays in memory
unless **Save To Disk** is enabled on Prepared Dataset. If a design is loaded
in a new Python session, re-run the pipeline or load the disk-backed dataset.


## v0.5.5 — Output Directory + unified Files view

The bottom project drawer now has three views:

- **Pipeline Details / Model Details**
- **Output Directory**
- **Files**

### Output Directory

The content follows the active workspace.

**Data Processing**
shows all completed prepared datasets with:

- Train / Validation / Test row counts
- total rows
- memory/disk status
- saved path
- **Use in Model**

**Model Builder**
shows:

- current editable model design
- layer/link/context/batch information
- selected prepared dataset
- registered trained/exported model artifacts as those runtimes are added

### Files

Files is workspace-independent and collects known project files in one place.

It includes:

- Builder JSON design (`.mlbricks.json`)
- Builder binary design (`.mlbricks.bin`)
- generated model config (`.model-config.json`)
- disk-backed prepared datasets
- in-memory prepared dataset entries
- registered model artifacts

Filters:

- **All**
- **Data**
- **Models**
- **Config**
- **Design**

Known paths such as `/kaggle/working/prepared_dataset` are displayed directly.
In-memory datasets are clearly marked as `Python memory`.

Files also provides direct actions:

- Save JSON
- Save BIN
- Download model config
- Use a prepared dataset in Model Builder

The schema now reserves `model_outputs` and `project_files` registries so future
training, checkpoints, weights, tokenizer files, exports and other artifacts can
appear in the same Files browser without redesigning the UI.


## v0.5.6 — compact Output Directory + full dataset Inspector

Prepared dataset cards in Output Directory are now compact, close to the Starter card footprint. Click a card to inspect source, split, cleaning, tokenizer, context and storage settings in the right Inspector.

Also fixes DatasetDict split counting: a three-split DatasetDict no longer appears as `Train = 3`. Re-run the data pipeline once after upgrading to refresh old registry metadata.


## v0.6.0 — Model Build lifecycle + data compatibility gate

Model Builder no longer presents the data-processing **Run** action.

### Model workflow

`Design → Build → Select Built Model → Check Data → Train → Generate`

In **Model Builder**, the top action is now **Build**.

Build:

- validates that the architecture has an input and output/head
- rejects disconnected components
- rejects Main-lane cycles
- visually walks through the model nodes
- snapshots the current architecture into **Model Outputs**
- preserves revisions when the same model is rebuilt

Data Processing still uses **Run Data**.

### Built Model Inspector

Click a built model in **Output Directory** to open the right-side model panel.

It shows:

- model status / build revision
- layers and connections
- input modality
- output type
- context length
- batch size
- parameter estimate
- build time
- prepared-dataset selector

### Compatibility gate

A user can choose any prepared dataset from the project. Builder checks:

- input/data modality
- Train split existence
- tokenizer availability for text language models
- data context length versus model context length
- `input_ids` availability when split-column metadata is available

When compatible, the **Train** action appears.

When incompatible, Train is hidden and the Inspector shows the exact failed
checks.

The model's dataset selection also updates its editable Text Input binding.

### Generation

**Generate Tokens** is shown for text models but remains disabled until the model
has trained or loaded weights.

Build is currently an architecture validation/snapshot step. This version does
not pretend to execute model training or token generation without a model
runtime/compiler. Train records readiness after compatibility passes; the
training executor is the next runtime layer to connect.


## v0.6.1 — Training / Generation setup workspace + available devices

Clicking **Train** or **Generate / Configure Generation** on a built model now
replaces the center graph area with a guided runtime configuration workspace.
The model graph is preserved and **Back to Model Graph** returns to it.

### Training setup

- budget by **steps**, **tokens**, or **epochs**
- training steps / token budget / epochs
- batch size and gradient accumulation
- optimizer, learning rate, weight decay, warmup
- validation split
- validate every N steps
- validation steps
- **generate a sample during validation**
- validation prompt + generated-token count
- checkpoint cadence
- seed
- output directory
- device / backend / execution / compile mode / precision

### Generation setup

- prompt
- new-token count
- temperature
- top-k / top-p
- seed
- device / backend / execution / compile mode / precision

### Available devices

Builder now detects the devices visible to the Python kernel and shows them as
selectable cards and in the Device dropdown. CPU is always shown. CUDA GPUs are
listed individually with GPU name, VRAM and compute capability when available;
MPS/XPU are also detected when PyTorch exposes them.

Runtime choices include:

- Device: Auto / CPU / each available GPU
- Backend: Auto / Native / PyTorch
- Execution: Eager / Compiled
- Compile mode: Default / Reduce Overhead / Max Autotune
- Precision: Auto / FP32 / FP16 / BF16

The runtime configuration is saved on the built-model entry. This version makes
the Train/Generate buttons functional as configuration workflows, but does **not**
fake actual model training or generation: the MLBricks graph compiler/model
executor still needs to be connected before Start Training or Generate can run
real model computation.


## v0.6.2 — real training + generation executor

`Start Training` is now connected to the Python kernel. It no longer stops at
"Training configuration saved".

For supported text language-model graphs, Builder now:

- compiles the visual graph into a real `torch.nn.Module` using MLBricks layers
- consumes the selected prepared `train` / validation splits
- runs AdamW / Adam / SGD optimization
- supports step, token and epoch budgets
- gradient accumulation
- warmup
- selected CPU / CUDA device
- Auto / Native / PyTorch ESA backend policy
- eager or `torch.compile` execution
- fp32 / fp16 / bf16 autocast
- validation cadence and validation-step limits
- validation sample generation
- checkpointing and final checkpoint output
- live step/loss/validation/token progress in the runtime panel
- Stop Training

After training, the built model is marked `weights_ready`, the final checkpoint
is registered on the model output, and **Generate Tokens** becomes executable.
Generation uses the configured prompt, token count, sampling settings, device,
execution mode and precision and streams generated text back into the runtime
panel.

### Current executable graph coverage

The first real compiler deliberately supports the components needed by the
TinyStories ESA starter and similar language models:

- Text Input / Text Output
- Embedding
- ESA
- RMSNorm / LayerNorm
- FFN
- Residual
- Dropout
- LM Head
- nested custom bricks composed from those parts

Unsupported advanced model bricks fail with a clear compiler error instead of
pretending to train.

The executor automatically expands the runtime vocabulary when the prepared
Hugging Face tokenizer is larger than the visual Embedding/LM Head vocabulary,
so token IDs cannot index outside the model embedding table.


## v0.6.3 — Training Status + Generation Status tabs

The runtime workspace no longer uses a `← Model Graph` button. Training and
generation are organized as two-tab workflows:

- **Training Setup** / **Training Status**
- **Generation Setup** / **Generation Status**

Clicking **Start Training** automatically switches to Training Status. Clicking
**Generate Tokens** automatically switches to Generation Status.

### Training Status

Shows live Python-kernel events:

- progress percentage
- step / max steps
- train loss
- latest validation loss
- best validation loss
- tokens seen
- elapsed time
- validation schedule
- validation generated sample
- chronological training log
- checkpoint events and latest checkpoint path
- output directory
- weights/training status
- Stop Training

Validation completion and checkpoint saves are now explicit runtime events, so
they appear in the status/log view rather than being hidden inside a generic
step message.

### Generation Status

Uses the same pattern and shows:

- generated tokens / requested tokens
- live percentage
- prompt
- live/final generated text
- temperature / top-k / top-p / seed
- runtime/device/backend/execution/compile/precision
- generation event log
- Stop Generation

Runtime progress events now carry the built model id so status/history is kept
on the correct model even when multiple built models exist.


## v0.6.4 — training/generation null-safety

Fixes the step-0 runtime failure:

`TypeError: int() argument must be a string, a bytes-like object or a real number, not 'NoneType'`

Older saved runtime configurations could contain explicit JSON `null` values.
Those values previously overwrote safe defaults and later reached Python
`int(...)`/`float(...)` conversions.

v0.6.4:

- ignores null/blank legacy values while merging runtime defaults
- safely normalizes all numeric training fields
- safely normalizes generation numeric fields
- makes supported model-component numeric parameters null-safe
- reports field-specific errors such as `Batch Size must be a number`
- adds **Reset Runtime Defaults** to both Training Setup and Generation Setup
- keeps blank required fields blocked before Start Training

Opening Training Setup after upgrading automatically repairs old null settings.


## v0.6.5 — Model Settings + focused runtime mode

### Model Settings

A built model now exposes editable **MODEL SETTINGS** in the right Inspector:

- Embedding Size
- Heads
- Block / Context
- Default Batch
- Vocabulary
- Precision

Changes synchronize compatible model-wide fields across the editable graph and
nested blocks (Embedding, ESA, norms, FFN, LM Head and supported related
components).

`Block / Context` updates the project context and ESA block size.
`Default Batch` updates the model default and seeds Training Setup's batch size.
Training Setup can still override that batch for an individual run.

Architecture-affecting changes mark the built model **Rebuild Required**.
Compatibility then blocks Train until **Build** is clicked again, preventing a
stale build from being trained accidentally.

### Focused training/generation workspace

When Train or Generate opens a runtime workspace, the bottom **MODEL WORKSPACE**
drawer is hidden completely. The center is reserved for Training
Setup/Status or Generation Setup/Status.

### Stable animated Build button

The top Build button has a fixed 82 px width, so its label no longer expands and
shrinks the toolbar.

During training it becomes a fixed-width animated `◆ Training` indicator.
During generation it becomes `◆ Generating`. A subtle pulse and moving highlight
show activity without changing the button's dimensions. When runtime activity
finishes, it returns to `◆ Build`.


## v0.6.6 — Hugging Face Hub push/load

The bottom project drawer now includes **Hugging Face**.

### Authentication

Builder uses the notebook's existing Hugging Face credentials:

```bash
hf auth login
```

or the `HF_TOKEN` environment variable.

The token is **never stored** in Builder state, JSON, BIN, dataset metadata,
model metadata, or project files.

### Push

The Hub panel can push:

- **Prepared Dataset**
  - uploads Dataset / DatasetDict splits using `datasets.push_to_hub`
  - writes `mlbricks_dataset.json` so Builder-specific processing and tokenizer
    metadata can be restored later
- **Built / Trained Model**
  - uploads the Builder model graph and model metadata
  - includes `weights/last.pt` when trained weights exist
  - includes a locally available tokenizer when possible
- **Builder Project**
  - uploads the complete Builder project state as `mlbricks_project.json`

Repositories can be private or public.

### Load

The same panel can load:

- a Hub dataset into the Prepared Dataset registry
- an MLBricks Builder model into Model Builder / Model Outputs
- a complete MLBricks Builder project

Public repositories can load without authentication. Private repositories use
the locally authenticated Hugging Face token.

Loaded trained model packages restore their checkpoint path from the Hugging
Face cache and can be opened for token generation. A newly selected local
Prepared Dataset can be used for compatibility checking and further training.


## v0.6.7 — collapsed runtime drawer + Cloud & Repositories

### MODEL WORKSPACE behavior

Entering Training or Generation now **collapses** MODEL WORKSPACE instead of
removing it.

The bar remains visible at the bottom and can be manually expanded while the
runtime screen is open. Returning to the graph is not required.

### Cloud & Repositories

The previous Hugging Face-only view is now **Cloud & Repositories**.

Providers:

- Hugging Face
- GitHub
- AWS S3
- Google Cloud Storage
- Azure Blob Storage

Content:

- Prepared Dataset
- Built / Trained Model
- Complete Builder Project

Hugging Face continues to use native Hub dataset/model repositories.

GitHub, S3, GCS and Azure store portable `.mlbricks.zip` bundles containing the
selected dataset/model/project so the same content can be restored into Builder.

### Session-only credentials

The Cloud panel includes masked credential fields:

- Hugging Face API/access token
- GitHub personal access token
- AWS access key / secret key / optional session token
- Google Cloud service-account JSON
- Azure Storage connection string

Credentials are session-only. They are extracted from the browser runtime
command before Builder state is persisted and are explicitly excluded from
JSON/BIN exports and cloud bundles.

Environment/default credentials still work when supported, so users do not
have to type a key into the UI if their notebook is already authenticated.

### Optional cloud packages

```bash
pip install "mlbricks-builder[cloud]"
```

or install individual provider packages:

```bash
pip install boto3
pip install google-cloud-storage google-auth
pip install azure-storage-blob
```

GitHub support uses Python's standard HTTP library and needs no extra package.

## v0.6.8 — Local / Kaggle filesystem loading

Adds **Local / Kaggle** to the bottom workspace selector. Builder can now scan and directly load content from `/kaggle/working`, `/kaggle/input`, Colab `/content`, the current working directory, or any absolute path.

Supported local data: Hugging Face `Dataset.save_to_disk()` / `DatasetDict.save_to_disk()` folders and raw TXT/CSV/JSON/JSONL/Parquet files. Loaded data is registered as Prepared Dataset and becomes available to Model Builder.

Supported local models: MLBricks `last.pt`, periodic `.pt` checkpoints, `.pth` / `.ckpt`, plus `.mlbricks.zip` bundles. v0.6.8 training checkpoints now embed the Builder model graph, nested custom-brick definitions, project settings and dataset metadata so a new checkpoint can restore after a kernel restart.

Older checkpoints can still load when the matching Builder project/custom definitions are already open. If they lack embedded nested definitions, Builder now explains that the matching project must be loaded first.

Local projects: `.mlbricks.json`, `.mlbricks.bin`, and `.mlbricks.zip` project bundles.


## v0.7.0 — Serve trained models through generated links

A trained or locally loaded model now exposes **Serve Model / API**.

### Links

Starting the server generates:

- `http://127.0.0.1:<port>` for apps on the same machine
- a LAN URL for phones/devices on the same network
- optional **ngrok Public HTTPS** for Kaggle, Colab, or remote access

Kaggle/Colab localhost belongs to the remote kernel. To reach that model from
your phone or a web app on your own computer, enable the public HTTPS tunnel.

### HTTP API

- `GET /` responsive browser playground
- `GET /health`
- `GET /v1/model`
- `GET /v1/models`
- `POST /v1/generate`
- `POST /v1/completions` OpenAI-style text-completion response

The trained model is loaded once when the server starts and remains resident.

### Security

Bearer API-key protection is enabled by default. If the API-key field is empty,
Builder generates a random key. API keys and ngrok tokens are session-only and
are not written into Builder project files.

For public tunnels install:

```bash
pip install pyngrok
```

or:

```bash
pip install "mlbricks-builder[serve]"
```
