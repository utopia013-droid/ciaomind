"""Fetch pinned public source snapshots for review; never install or execute them."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from project_catalog import DEFAULT_CATALOG, load_catalog, no_symlinks, relative_path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def mirror(catalog: dict, root: Path) -> list[dict]:
    root = no_symlinks(root).resolve()
    if root == REPOSITORY_ROOT or REPOSITORY_ROOT in root.parents:
        raise ValueError("Source snapshots must stay outside the control-plane repository")
    root.mkdir(parents=True, exist_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix="ciao-empty-hooks-") as hooks:
        def git(directory: Path, *args: str) -> str:
            run = subprocess.run(
                ["git", "-c", f"core.hooksPath={hooks}", "-c", "core.fsmonitor=false", "-C", str(directory), *args],
                capture_output=True, text=True, timeout=180,
            )
            if run.returncode:
                raise ValueError(f"Snapshot command failed for {directory.name}: {run.stderr[-1000:]}")
            return run.stdout.strip()

        for project in catalog["projects"]:
            destination = no_symlinks(root.joinpath(*relative_path(project["source_subdir"]).parts))
            if destination.exists():
                if not (destination / ".git").is_dir() or (destination / ".git").is_symlink():
                    raise ValueError(f"Expected a standalone Git snapshot: {destination.name}")
                if Path(git(destination, "rev-parse", "--show-toplevel")).resolve() != destination.resolve():
                    raise ValueError(f"Git worktree points outside the snapshot: {destination.name}")
                if git(destination, "rev-parse", "--verify", "HEAD") != project["commit"]:
                    raise ValueError(f"Existing snapshot differs; refusing to change {destination.name}")
                action = "existing_commit_verified"
            else:
                destination.mkdir(parents=True, exist_ok=False)
                git(destination, "init", "--template=")
                git(destination, "remote", "add", "origin", "https://github.com/" + project["repository"] + ".git")
                git(destination, "config", "remote.origin.promisor", "true")
                git(destination, "config", "remote.origin.partialclonefilter", "blob:none")
                git(destination, "fetch", "--filter=blob:none", "--depth=1", "origin", project["commit"])
                git(destination, "sparse-checkout", "init", "--cone")
                directories = project.get("snapshot_paths", [])
                if not isinstance(directories, list):
                    raise ValueError("snapshot_paths must be a list")
                directories = [str(relative_path(item)) for item in directories]
                git(destination, "sparse-checkout", "set", *directories)
                git(destination, "checkout", "--detach", "FETCH_HEAD")
                if git(destination, "rev-parse", "HEAD") != project["commit"]:
                    raise ValueError("Fetched commit did not match the catalog")
                action = "source_snapshot_created"
            results.append({"repository": project["repository"], "commit": project["commit"], "action": action})
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    try:
        results = mirror(load_catalog(args.catalog), args.root)
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"Mirror failed: {error}\n")
    print(json.dumps({"sources": results, "runtime_installed": False}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
