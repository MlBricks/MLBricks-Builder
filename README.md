# MLBricks Builder

A hierarchical, left-to-right visual model builder for **MLBricks** that runs inside Jupyter-compatible notebooks such as Kaggle and Colab.

The Builder is intentionally kept separate from the core MLBricks library. Installing the Builder installs the latest MLBricks library directly from:

`https://github.com/MlBricks/MLBricks.git`

This means the Builder does not copy or vendor MLBricks source code.

## Install directly from GitHub

```bash
pip install "git+https://github.com/MlBricks/MLBricks-Builder.git"
```

Because `mlbricks` is declared as a Git dependency, pip will also install/update MLBricks from:

```bash
https://github.com/MlBricks/MLBricks.git
```

For a clean Kaggle session:

```python
!pip install -U "git+https://github.com/MlBricks/MLBricks-Builder.git"
```

Then:

```python
from mlbricks_builder import Builder

builder = Builder()
builder
```

## Design principles

- Left-to-right layer flow
- Fixed visual size for logical layers regardless of internal complexity
- Nested components: Model → Layer → Component → Primitive
- Reusable custom components
- Repeat groups such as `SAM × 96`
- Parallel branches represented only where needed
- Custom components can be edited and saved as a new revision or as a new component
- MLBricks remains an external dependency

## Python API

```python
from mlbricks_builder import Builder

builder = Builder()

# show in notebook
builder

# save design
builder.save("story_model.mlbricks")

# load later
builder.load("story_model.mlbricks")

# inspect current graph
graph = builder.to_dict()

# verify external MLBricks installation
builder.mlbricks_info()
```

## Current MVP

The initial repository contains the working notebook UI foundation and graph/project model. The visual UI supports:

- Primitive brick palette
- Left-to-right pipeline
- Node selection
- Repeat count
- Node rename
- Nested component editing
- Custom component creation
- Custom component revisions
- Save-as-new component
- Breadcrumb navigation
- JSON project state synchronized with Python

The runtime/compiler adapter is deliberately separate from the visual graph and dynamically imports the installed `mlbricks` package.

## Repository structure

```text
src/mlbricks_builder/
├── __init__.py
├── builder.py
├── graph.py
├── registry.py
├── runtime.py
└── static/
    ├── builder.js
    └── builder.css
```

## Important dependency rule

Do **not** copy MLBricks algorithms into this repository.

`mlbricks-builder` describes architecture and user interaction.

`mlbricks` supplies the actual model components and runtime implementation.

## License

Copyright © 2026 Zameer Hussain and Akhtar Hussain.

Licensed under the PolyForm Noncommercial License 1.0.0. Noncommercial use is permitted under its terms. Commercial use requires a separate written commercial license from the copyright holders.
