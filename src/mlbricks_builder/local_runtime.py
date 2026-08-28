from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

DATA_FILE_EXTENSIONS = {'.txt', '.csv', '.json', '.jsonl', '.parquet', '.arrow'}
MODEL_EXTENSIONS = {'.pt', '.pth', '.ckpt'}


def human_size(size: int | None) -> str:
    if size is None:
        return '—'
    value = float(size)
    units = ['B', 'KB', 'MB', 'GB', 'TB']
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f'{value:.1f} {unit}' if unit != 'B' else f'{int(value)} B'
        value /= 1024
    return f'{size} B'


def _directory_size(path: Path, *, max_files: int = 2500) -> int | None:
    total = 0
    count = 0
    try:
        for child in path.rglob('*'):
            if child.is_file():
                count += 1
                if count > max_files:
                    return None
                try:
                    total += child.stat().st_size
                except OSError:
                    pass
    except OSError:
        return None
    return total


def detect_local_kind(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        return {'kind': 'missing', 'label': 'Missing'}
    if p.is_dir():
        if (p / 'dataset_dict.json').exists():
            return {'kind': 'dataset_dir', 'label': 'Prepared Dataset'}
        if (p / 'dataset_info.json').exists() and (p / 'state.json').exists():
            return {'kind': 'dataset_dir', 'label': 'Prepared Dataset'}
        if (p / 'manifest.json').exists():
            try:
                payload = json.loads((p / 'manifest.json').read_text(encoding='utf-8'))
                if payload.get('format') == 'mlbricks-cloud-bundle-v1':
                    return {'kind': 'bundle_dir', 'label': f"MLBricks {str(payload.get('content_type') or 'Bundle').title()}"}
            except Exception:
                pass
        return {'kind': 'folder', 'label': 'Folder'}
    name = p.name.lower()
    suffix = p.suffix.lower()
    if name.endswith('.mlbricks.zip'):
        return {'kind': 'bundle', 'label': 'MLBricks Bundle'}
    if name.endswith('.mlbricks.json'):
        return {'kind': 'project_json', 'label': 'Builder Project'}
    if name.endswith('.mlbricks.bin'):
        return {'kind': 'project_bin', 'label': 'Builder Project BIN'}
    if suffix in MODEL_EXTENSIONS:
        return {'kind': 'model_checkpoint', 'label': 'Model Checkpoint'}
    if suffix in DATA_FILE_EXTENSIONS:
        return {'kind': 'data_file', 'label': 'Dataset File'}
    return {'kind': 'file', 'label': 'File'}


def _existing_unique_paths(candidates: list[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for p in candidates:
        try:
            p = p.expanduser()
        except Exception:
            pass
        if not p.exists():
            continue
        try:
            resolved = str(p.resolve())
        except Exception:
            resolved = str(p)
        if resolved in seen:
            continue
        seen.add(resolved)
        result.append(p)
    return result


def detect_local_environment() -> dict[str, Any]:
    """Describe the notebook/Python filesystem that Builder can actually scan."""
    cwd = Path.cwd()

    if os.environ.get("KAGGLE_KERNEL_RUN_TYPE") or Path("/kaggle").exists():
        kind, name = "kaggle", "Kaggle"
        candidates = [Path("/kaggle/working"), Path("/kaggle/input")]
    elif os.environ.get("COLAB_RELEASE_TAG") or os.environ.get("COLAB_GPU") or "google.colab" in os.sys.modules:
        kind, name = "colab", "Google Colab"
        candidates = [Path("/content"), Path("/content/drive/MyDrive")]
    elif os.environ.get("LIGHTNING_CLOUD_URL") or Path("/teamspace").exists():
        kind, name = "lightning", "Lightning AI"
        candidates = [cwd, Path("/teamspace/studios/this_studio"), Path("/teamspace")]
    elif os.environ.get("CODESPACES"):
        kind, name = "codespaces", "GitHub Codespaces"
        candidates = [cwd, Path("/workspaces")]
    elif os.environ.get("SAGEMAKER_REGION") or Path("/home/ec2-user/SageMaker").exists():
        kind, name = "sagemaker", "Amazon SageMaker"
        candidates = [cwd, Path("/home/ec2-user/SageMaker")]
    elif Path("/workspace").exists() and cwd != Path("/"):
        kind, name = "cloud_workspace", "Cloud Workspace"
        candidates = [cwd, Path("/workspace")]
    else:
        kind, name = "python", "Python / Jupyter Environment"
        # The current working directory is the safest generic root. Include the
        # user's home only when cwd is not already the home directory.
        home = Path.home()
        # Some notebook kernels start with cwd="/". Scanning the whole root
        # filesystem would be noisy and expensive, so use the user home instead.
        candidates = [home] if str(cwd) == "/" else [cwd]
        try:
            if cwd.resolve() != home.resolve() and str(cwd) != "/":
                candidates.append(home)
        except Exception:
            if str(cwd) != "/":
                candidates.append(home)

    roots = _existing_unique_paths(candidates)
    if not roots:
        roots = [cwd]
    resolved_roots = []
    for p in roots:
        try:
            resolved_roots.append(str(p.resolve()))
        except Exception:
            resolved_roots.append(str(p))

    return {
        "kind": kind,
        "name": name,
        "roots": resolved_roots,
        "default_root": resolved_roots[0] if resolved_roots else str(cwd),
        "cwd": str(cwd),
    }


def _root_candidates() -> list[Path]:
    return [Path(x) for x in detect_local_environment().get("roots") or [str(Path.cwd())]]


def scan_local_files(roots: list[str] | None = None, *, max_entries: int = 300, max_depth: int = 5) -> dict[str, Any]:
    root_paths = [Path(x) for x in roots] if roots else _root_candidates()
    entries: list[dict[str, Any]] = []

    def add(path: Path, root: Path):
        if len(entries) >= max_entries:
            return
        info = detect_local_kind(path)
        if info['kind'] in {'folder', 'file', 'missing'}:
            return
        try:
            rel = str(path.relative_to(root))
        except Exception:
            rel = path.name
        size = _directory_size(path) if path.is_dir() else (path.stat().st_size if path.exists() else None)
        entries.append({
            'path': str(path), 'name': path.name or str(path), 'relative': rel,
            'root': str(root), 'kind': info['kind'], 'label': info['label'],
            'size': size, 'size_label': human_size(size), 'is_dir': path.is_dir(),
        })

    for root in root_paths:
        if len(entries) >= max_entries:
            break
        root = root.resolve()
        for current, dirs, files in os.walk(root):
            current_path = Path(current)
            try:
                depth = len(current_path.relative_to(root).parts)
            except Exception:
                depth = 0
            if depth > max_depth:
                dirs[:] = []
                continue
            current_kind = detect_local_kind(current_path)['kind']
            if current_kind in {'dataset_dir', 'bundle_dir'}:
                add(current_path, root)
                dirs[:] = []
                continue
            for filename in files:
                if len(entries) >= max_entries:
                    break
                add(current_path / filename, root)

    priority = {'model_checkpoint': 0, 'dataset_dir': 1, 'bundle': 2, 'project_json': 3, 'project_bin': 4, 'data_file': 5}
    entries.sort(key=lambda x: (priority.get(x['kind'], 99), x['root'].lower(), x['path'].lower()))
    return {'roots': [str(x.resolve()) for x in root_paths], 'entries': entries, 'truncated': len(entries) >= max_entries}


def scan_model_candidates(
    base_path: str | Path,
    *,
    max_entries: int = 1000,
    max_depth: int = 12,
) -> dict[str, Any]:
    """Recursively find model checkpoints/bundles beneath one base path."""
    base = Path(base_path).expanduser()
    if not base.exists():
        raise FileNotFoundError(f"Local environment path was not found: {base}")
    base = base.resolve()

    if base.is_file():
        info = detect_local_kind(base)
        entries = []
        if info["kind"] in {"model_checkpoint", "bundle"}:
            size = base.stat().st_size
            entries.append({
                "path": str(base),
                "name": base.name,
                "relative": base.name,
                "root": str(base.parent),
                "kind": info["kind"],
                "label": info["label"],
                "size": size,
                "size_label": human_size(size),
                "is_dir": False,
            })
        return {"root": str(base.parent), "entries": entries, "truncated": False}

    scan = scan_local_files([str(base)], max_entries=max_entries, max_depth=max_depth)
    return {
        "root": str(base),
        "entries": [
            item for item in (scan.get("entries") or [])
            if item.get("kind") in {"model_checkpoint", "bundle"}
        ],
        "truncated": bool(scan.get("truncated")),
    }


def scan_data_candidates(
    base_path: str | Path,
    *,
    max_entries: int = 1000,
    max_depth: int = 12,
) -> dict[str, Any]:
    """Recursively find prepared/raw datasets and MLBricks bundles."""
    base = Path(base_path).expanduser()
    if not base.exists():
        raise FileNotFoundError(f"Local environment path was not found: {base}")
    base = base.resolve()

    if base.is_file():
        info = detect_local_kind(base)
        entries = []
        if info["kind"] in {"data_file", "bundle"}:
            size = base.stat().st_size
            entries.append({
                "path": str(base),
                "name": base.name,
                "relative": base.name,
                "root": str(base.parent),
                "kind": info["kind"],
                "label": info["label"],
                "size": size,
                "size_label": human_size(size),
                "is_dir": False,
            })
        return {"root": str(base.parent), "entries": entries, "truncated": False}

    scan = scan_local_files(
        [str(base)],
        max_entries=max_entries,
        max_depth=max_depth,
    )
    entries = [
        item for item in (scan.get("entries") or [])
        if item.get("kind") in {"dataset_dir", "data_file", "bundle"}
    ]
    return {
        "root": str(base),
        "entries": entries,
        "truncated": bool(scan.get("truncated")),
    }
