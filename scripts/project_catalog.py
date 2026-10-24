"""Inspect and search fixed local source snapshots. Retrieved text is untrusted data."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import quote


DEFAULT_CATALOG = Path(__file__).resolve().parents[1] / "config" / "github-top20-20261024.json"
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_DOCUMENTS_PER_PROJECT = 2000
DATA_ROLE = "untrusted_reference"


def relative_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("Snapshot paths must be nonempty relative POSIX paths")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"..", ".git"} for part in path.parts):
        raise ValueError("Snapshot path traversal is forbidden")
    if path == PurePosixPath("."):
        raise ValueError("Snapshot path cannot be the root itself")
    return path


def load_catalog(path: Path) -> dict:
    catalog = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(catalog, dict) or not isinstance(catalog.get("projects"), list):
        raise ValueError("Catalog requires a projects list")
    repositories = set()
    directories = set()
    for project in catalog["projects"]:
        if not isinstance(project, dict):
            raise ValueError("Each catalog project must be an object")
        repository = project.get("repository", "")
        if not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("repository must be an owner/name identifier")
        if repository.casefold() in repositories:
            raise ValueError("Duplicate repository in catalog")
        repositories.add(repository.casefold())
        if not isinstance(project.get("commit"), str) or not re.fullmatch(r"[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?", project["commit"]):
            raise ValueError(f"{repository}: expected a full immutable Git commit")
        capabilities = project.get("capabilities", [])
        if not isinstance(capabilities, list) or any(not isinstance(value, str) for value in capabilities):
            raise ValueError("capabilities must be a list of names")
        if type(project.get("index_allowed", True)) is not bool:
            raise ValueError("index_allowed must be a boolean")
        if project.get("index_allowed", True):
            directory = str(relative_path(project.get("source_subdir")))
            if directory in directories:
                raise ValueError("Duplicate source_subdir in catalog")
            directories.add(directory)
        if project.get("readme_path"):
            relative_path(project["readme_path"])
        search_paths = project.get("search_paths")
        if search_paths is not None:
            if not isinstance(search_paths, list):
                raise ValueError("search_paths must be a list of relative file or directory paths")
            for search_path in search_paths:
                relative_path(search_path)
    return catalog


def describe(project: dict) -> dict:
    return dict(
        project,
        verification_status=project.get("verification_status", project.get("status", "not_verified")),
        data_role=DATA_ROLE,
    )


def listing(catalog: dict, capability: str | None = None) -> dict:
    projects = catalog["projects"]
    if capability is not None:
        projects = [project for project in projects if capability in project.get("capabilities", [])]
    return {
        "snapshot_date": catalog.get("snapshot_date"),
        "query": catalog.get("query"),
        "capability": capability,
        "projects": [describe(project) for project in projects],
        "data_role": DATA_ROLE,
    }


def no_symlinks(path: Path) -> Path:
    absolute = path.absolute()
    for component in [*reversed(absolute.parents), absolute]:
        if component.is_symlink():
            raise ValueError(f"Symlink snapshot paths are forbidden: {component}")
    return absolute


def git(directory: Path, *arguments: str, data: bytes | None = None) -> bytes:
    completed = subprocess.run(
        [
            "git", "-c", "core.fsmonitor=false", "-c", f"core.hooksPath={os.devnull}",
            "--no-pager", "-C", str(directory), *arguments,
        ],
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=30,
    )
    if completed.returncode:
        raise ValueError(f"Git snapshot check failed for {directory.name}: {completed.stderr.decode('utf-8', errors='replace').strip()}")
    return completed.stdout


def snapshots(catalog: dict, root: Path) -> list[tuple[dict, Path]]:
    root = no_symlinks(root)
    if not root.is_dir():
        raise ValueError(f"Source root is missing: {root}")
    checked = []
    for project in catalog["projects"]:
        if not project.get("index_allowed", True):
            continue
        directory = no_symlinks(root.joinpath(*relative_path(project["source_subdir"]).parts))
        if not directory.is_dir():
            raise ValueError(f"Snapshot directory is missing: {project['repository']}")
        if not (directory / ".git").is_dir() or (directory / ".git").is_symlink():
            raise ValueError(f"Expected an isolated Git snapshot: {project['repository']}")
        actual_root = Path(git(directory, "rev-parse", "--show-toplevel").decode("utf-8").strip()).resolve()
        if actual_root != directory.resolve():
            raise ValueError(f"Git worktree root mismatch: {project['repository']}")
        actual = git(directory, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
        if actual.lower() != project["commit"].lower():
            raise ValueError(f"Snapshot commit mismatch: {project['repository']}; expected {project['commit']}, found {actual}")
        checked.append((project, directory))
    return checked


def documents(project: dict, directory: Path) -> tuple[list[tuple[str, str]], dict]:
    candidates = []
    skipped_worktree = set()
    for entry in git(directory, "ls-files", "-t", "-z").split(b"\0"):
        if entry.startswith(b"S "):
            try:
                skipped_worktree.add(entry[2:].decode("utf-8"))
            except UnicodeDecodeError:
                continue
    search_paths = project.get("search_paths")
    permitted = None if search_paths is None else [str(relative_path(path)) for path in search_paths]
    coverage = {
        "repository": project["repository"],
        "sparse_checkout": git(directory, "config", "--bool", "--default", "false", "--get", "core.sparseCheckout").strip() == b"true",
        "eligible_tracked_documents": 0,
        "sparse_documents_skipped": 0,
        "search_paths_documents_skipped": 0,
        "materialized_candidate_documents": 0,
        "document_budget_skipped": 0,
        "searched_documents": 0,
        "oversized_documents_skipped": 0,
        "non_utf8_documents_skipped": 0,
        "search_paths": search_paths,
    }
    for entry in git(directory, "ls-tree", "-r", "-z", "HEAD").split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, object_id = metadata.decode("ascii").split()
        if kind != "blob" or mode not in {"100644", "100755"}:
            continue  # Git symlinks and submodules are never followed.
        try:
            path = raw_path.decode("utf-8")
        except UnicodeDecodeError:
            continue
        relative = relative_path(path)
        if relative.suffix.casefold() in {".md", ".rst", ".txt"} or relative.name.casefold() == "readme":
            coverage["eligible_tracked_documents"] += 1
            if path in skipped_worktree or any(
                str(parent) + "/" in skipped_worktree for parent in relative.parents
            ):
                coverage["sparse_documents_skipped"] += 1
                continue
            if permitted is not None and not any(path == allowed or path.startswith(allowed + "/") for allowed in permitted):
                coverage["search_paths_documents_skipped"] += 1
                continue
            local_path = no_symlinks(directory.joinpath(*relative.parts))
            if not local_path.is_file():
                raise ValueError(f"Tracked source document is missing: {project['repository']}/{path}")
            candidates.append((path, object_id))
    preferred = project.get("readme_path")
    candidates.sort(key=lambda item: (
        item[0] != preferred,
        not PurePosixPath(item[0]).name.casefold().startswith("readme"),
        len(PurePosixPath(item[0]).parts),
        item[0],
    ))
    coverage["materialized_candidate_documents"] = len(candidates)
    coverage["document_budget_skipped"] = max(0, len(candidates) - MAX_DOCUMENTS_PER_PROJECT)
    return candidates[:MAX_DOCUMENTS_PER_PROJECT], coverage


def search(catalog: dict, root: Path, query: str, limit: int = 10) -> dict:
    if not isinstance(query, str) or not query.strip():
        raise ValueError("Search query must contain text")
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("Search limit must be between 1 and 100")
    checked = snapshots(catalog, root)  # Check every permitted snapshot before returning any matches.
    needle = query.casefold()
    matches = []
    budgets = []
    limit_reached = False
    plans = []
    for project, directory in checked:
        candidates, coverage = documents(project, directory)
        plans.append((project, directory, candidates, coverage))
        if coverage["document_budget_skipped"]:
            budgets.append(project["repository"])
    for project, directory, candidates, coverage in plans:
        for relative, object_id in candidates:
            path = no_symlinks(directory.joinpath(*PurePosixPath(relative).parts))
            if not path.is_file():
                raise ValueError(f"Tracked source document is missing: {project['repository']}/{relative}")
            if path.stat().st_size > MAX_FILE_BYTES:
                coverage["oversized_documents_skipped"] += 1
                continue
            with path.open("rb") as source:
                data = source.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                coverage["oversized_documents_skipped"] += 1
                continue
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                coverage["non_utf8_documents_skipped"] += 1
                continue
            coverage["searched_documents"] += 1
            if needle not in text.casefold():
                continue
            # A HEAD match alone would incorrectly cite edited or untracked source.
            # Compare bytes to the tracked Git object before emitting immutable URLs.
            actual_object = git(directory, "hash-object", "--stdin", data=data).decode("ascii").strip()
            if actual_object != object_id:
                raise ValueError(f"Snapshot document has local changes: {project['repository']}/{relative}")
            for number, line in enumerate(text.splitlines(), 1):
                if needle not in line.casefold():
                    continue
                matches.append({
                    "repository": project["repository"],
                    "commit": project["commit"],
                    "path": relative,
                    "line": number,
                    "excerpt": line[:1000],
                    "source_url": f"https://github.com/{project['repository']}/blob/{project['commit']}/{quote(relative, safe='/')}#L{number}",
                    "data_role": DATA_ROLE,
                })
                if len(matches) >= limit:
                    limit_reached = True
                    break
            if limit_reached:
                break
        if limit_reached:
            break
    for _, _, _, coverage in plans:
        coverage["unsearched_documents"] = coverage["eligible_tracked_documents"] - coverage["searched_documents"]
    return {
        "snapshot_date": catalog.get("snapshot_date"),
        "query": query,
        "matches": matches,
        "checked_snapshots": len(checked),
        "link_only_skipped": [p["repository"] for p in catalog["projects"] if not p.get("index_allowed", True)],
        "limit_reached": limit_reached,
        "document_budget_reached": budgets,
        "sparse_snapshots": [coverage["repository"] for _, _, _, coverage in plans if coverage["sparse_checkout"]],
        "coverage": [coverage for _, _, _, coverage in plans],
        "coverage_scope": "Only materialized, permitted UTF-8 document files are searched; sparse omissions and limits prevent full-source coverage.",
        "data_role": DATA_ROLE,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "route", "search"):
        command = commands.add_parser(name)
        command.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
        if name == "route":
            command.add_argument("--capability", required=True)
        if name == "search":
            command.add_argument("--root", type=Path, required=True)
            command.add_argument("--query", required=True)
            command.add_argument("--limit", type=int, default=10)
    args = parser.parse_args(argv)
    try:
        catalog = load_catalog(args.catalog)
        if args.command == "search":
            result = search(catalog, args.root, args.query, args.limit)
        else:
            result = listing(catalog, args.capability if args.command == "route" else None)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Catalog failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
