from pathlib import Path
import ast
import tomllib

root = Path(__file__).resolve().parents[1]

pyproject = tomllib.loads((root / "pyproject.toml").read_text())
deps = pyproject["project"]["dependencies"]
assert any("github.com/MlBricks/MLBricks.git" in d for d in deps), deps

for path in (root / "src").rglob("*.py"):
    ast.parse(path.read_text(), filename=str(path))

required = [
    root / "src/mlbricks_builder/builder.py",
    root / "src/mlbricks_builder/static/builder.js",
    root / "src/mlbricks_builder/static/builder.css",
    root / "README.md",
]
for p in required:
    assert p.exists(), p

print("Repository structure verified.")
print("MLBricks GitHub dependency present.")
