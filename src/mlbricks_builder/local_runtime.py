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


def _root_candidates() -> list[Path]:
    candidates = [Path('/kaggle/working'), Path('/kaggle/input'), Path('/content'), Path.cwd()]
    result, seen = [], set()
    for p in candidates:
        if not p.exists():
            continue
        try:
            resolved = str(p.resolve())
        except Exception:
            resolved = str(p)
        if resolved not in seen:
            seen.add(resolved)
            result.append(p)
    return result


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
    entries.sort(key=lambda x: (0 if x['root'] == '/kaggle/working' else 1, priority.get(x['kind'], 99), x['path'].lower()))
    return {'roots': [str(x.resolve()) for x in root_paths], 'entries': entries, 'truncated': len(entries) >= max_entries}
