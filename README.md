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
