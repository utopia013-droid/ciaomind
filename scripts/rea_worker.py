"""Run a pinned local REA image against a bounded, inert source snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import uuid


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_SOURCE_FILES = 2000
SOURCE_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"}
DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]
DRIVER = """import {readFileSync,writeFileSync} from 'node:fs';
const root='/opt/rea/node_modules/rea-agents';
const p=JSON.parse(readFileSync(root+'/package.json','utf8'));
if(p.name!=='rea-agents') throw new Error('Expected the REA release package');
writeFileSync('/output/tool.json',JSON.stringify({name:p.name,version:p.version,node:process.version})+'\\n',{flag:'wx'});
process.argv=[process.execPath,root+'/scripts/rea.mjs','analyze-javascript-application','/input','--json','--full-output'];
await import(root+'/scripts/rea.mjs');
"""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def reject_symlink_components(path: Path) -> None:
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError("Symlink inputs and output parents are unsupported")


def load_job(input_path: Path) -> tuple[dict, bytes, Path]:
    reject_symlink_components(input_path.absolute())
    descriptor = os.open(input_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Task input must be a regular file")
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError("Task input exceeds 64 KiB")
    job = json.loads(raw)
    if not isinstance(job, dict) or set(job) != {"task_id", "input_version", "operation", "source_path"}:
        raise ValueError("Expected exactly task_id, input_version, operation, source_path")
    if not isinstance(job["task_id"], str) or not job["task_id"].strip():
        raise ValueError("task_id must be a nonempty string")
    if type(job["input_version"]) is not int or job["input_version"] < 1:
        raise ValueError("input_version must be a positive integer")
    if job["operation"] != "javascript_static":
        raise ValueError("Only javascript_static is supported")
    name = job["source_path"]
    if not isinstance(name, str) or not name.strip() or "://" in name or name.lower().startswith(("file:", "data:")):
        raise ValueError("source_path must be a local directory")
    source = Path(name)
    if not source.is_absolute():
        source = input_path.absolute().parent / source
    reject_symlink_components(source.absolute())
    if not source.is_dir():
        raise ValueError("source_path must name an existing directory")
    return job, raw, source.resolve()


def snapshot_tree(source: Path, destination: Path) -> tuple[list[dict], str]:
    """Read through no-follow directory descriptors, then hash the consumed bytes."""
    records = []
    total = 0
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK

    def visit(directory_fd: int, relative: Path):
        nonlocal total
        with os.scandir(directory_fd) as iterator:
            entries = sorted(iterator, key=lambda entry: entry.name)
        for entry in entries:
            if entry.is_symlink():
                raise ValueError("Symlinks in the source tree are unsupported")
            if entry.name in {".git", "node_modules"}:
                continue
            mode = entry.stat(follow_symlinks=False).st_mode
            target = relative / entry.name
            if stat.S_ISDIR(mode):
                child = os.open(entry.name, flags | os.O_DIRECTORY, dir_fd=directory_fd)
                try:
                    visit(child, target)
                finally:
                    os.close(child)
                continue
            if entry.name != "package.json" and Path(entry.name).suffix.lower() not in SOURCE_SUFFIXES:
                continue
            if not stat.S_ISREG(mode):
                raise ValueError("Selected source entries must be regular files")
            if len(records) >= MAX_SOURCE_FILES:
                raise ValueError("Source snapshot exceeds 2000 selected files")
            descriptor = os.open(entry.name, flags, dir_fd=directory_fd)
            with os.fdopen(descriptor, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError("Selected source changed to a non-regular file")
                data = stream.read(MAX_SOURCE_BYTES - total + 1)
            total += len(data)
            if total > MAX_SOURCE_BYTES:
                raise ValueError("Selected source snapshot exceeds 25 MiB")
            copied = destination / target
            copied.parent.mkdir(parents=True, exist_ok=True)
            copied.write_bytes(data)
            records.append({"path": target.as_posix(), "bytes": len(data), "sha256": sha256(data)})

    root_fd = os.open(source, flags | os.O_DIRECTORY)
    try:
        visit(root_fd, Path())
    finally:
        os.close(root_fd)
    records.sort(key=lambda item: item["path"])
    if not any(Path(item["path"]).suffix.lower() in SOURCE_SUFFIXES for item in records):
        raise ValueError("Source snapshot contains no JavaScript/TypeScript files")
    canonical = json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return records, sha256(canonical)


def run(input_path: Path, output_path: Path, image: str) -> dict:
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("--image must be an explicit local sha256 image ID")
    reject_symlink_components(output_path.absolute())
    output_path = output_path.resolve()
    if "," in str(output_path):
        raise ValueError("Output paths containing commas cannot be represented as Docker bind mounts")
    if output_path == REPOSITORY_ROOT or REPOSITORY_ROOT in output_path.parents:
        raise ValueError("Output must be outside the repository")
    if output_path.exists():
        raise ValueError("Output directory already exists; refusing to overwrite")
    job, raw, source = load_job(input_path)
    # Keep the snapshot outside the checkout. Only this bounded copy is mounted.
    with tempfile.TemporaryDirectory(prefix="ciaomind-rea-input-") as temporary:
        snapshot = Path(temporary)
        records, source_hash = snapshot_tree(source, snapshot)
        output_path.mkdir(parents=True, exist_ok=False)
        (output_path / "source-manifest.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
        container = "ciaomind-rea-" + uuid.uuid4().hex
        command = DOCKER + [
            "run", "--rm", "--pull", "never", "--name", container,
            "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
            "--pids-limit", "128", "--memory", "1g", "--cpus", "2",
            "--user", f"{os.getuid()}:{os.getgid()}",
            "-e", "HTTP_PROXY=", "-e", "HTTPS_PROXY=", "-e", "ALL_PROXY=",
            "-e", "http_proxy=", "-e", "https_proxy=", "-e", "all_proxy=",
            "-e", "XDG_CACHE_HOME=/tmp/cache", "-e", "XDG_STATE_HOME=/tmp/state",
            "--mount", f"type=bind,src={snapshot},dst=/input,readonly",
            "--mount", f"type=bind,src={output_path},dst=/output",
            "--entrypoint", "node", image, "--input-type=module", "-e", DRIVER,
        ]
        environment = {key: value for key, value in os.environ.items() if key not in {
            "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"
        }}
        with (output_path / "analysis.json").open("xb") as stdout, (output_path / "stderr.txt").open("xb") as stderr:
            try:
                completed = subprocess.run(command, stdout=stdout, stderr=stderr, env=environment, timeout=120)
            except subprocess.TimeoutExpired:
                subprocess.run(DOCKER + ["rm", "--force", container], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, env=environment, timeout=20)
                (output_path / "exit-code.txt").write_text("124\n")
                raise ValueError("REA exceeded 120 seconds; diagnostics retained")
        (output_path / "exit-code.txt").write_text(str(completed.returncode) + "\n")
        if completed.returncode != 0:
            raise ValueError(f"REA failed with exit {completed.returncode}; diagnostics retained")

    analysis_file = output_path / "analysis.json"
    if analysis_file.stat().st_size > 64 * 1024 * 1024:
        raise ValueError("REA report exceeds the 64 MiB verification limit; raw output retained")
    report = json.loads(analysis_file.read_bytes())
    if not isinstance(report, dict) or report.get("ok") is not True:
        raise ValueError("REA did not return a successful typed envelope")
    evidence = report.get("data")
    if not isinstance(evidence, dict):
        raise ValueError("REA Evidence is missing")
    normalized = evidence.get("normalized_result", {})
    statistics = normalized.get("statistics", {})
    coverage = normalized.get("graph", {}).get("coverage")
    count_keys = ("parse_failures", "invalid_utf8_files", "skipped_javascript_files", "parsed_javascript_files")
    if not isinstance(coverage, dict) or any(type(statistics.get(key)) is not int or statistics[key] < 0 for key in count_keys):
        raise ValueError("REA report lacks inspectable parsing and coverage facts")
    limitations = list(dict.fromkeys(evidence.get("limitations", []) + normalized.get("limitations", [])))
    complete = (
        coverage.get("status") == "complete" and coverage.get("truncated") is False
        and coverage.get("omitted_count") == 0 and statistics["parse_failures"] == 0
        and statistics["invalid_utf8_files"] == 0
        and statistics["skipped_javascript_files"] == 0
        and statistics["parsed_javascript_files"] > 0
    )
    metadata = json.loads((output_path / "tool.json").read_bytes())
    if metadata.get("name") != "rea-agents" or not isinstance(metadata.get("version"), str):
        raise ValueError("REA package identity is missing")
    status = "completed" if complete else "partial"
    limitations += [
        "Only selected JS/TS sources and package.json were snapshotted; .git, node_modules, other assets and external dependencies are excluded.",
        "Complete static graph coverage does not prove runtime behavior or complete feature reconstruction.",
        "This execution does not register MCP clients, install agent skills or enable background processing.",
    ]
    if not complete:
        limitations.append("Analysis retained partial parsing or coverage; review the original Evidence before reuse.")
    artifacts = ["analysis.json", "stderr.txt", "exit-code.txt", "source-manifest.json", "tool.json"]
    result = {
        "task_id": job["task_id"], "input_version": job["input_version"],
        "input_sha256": sha256(raw), "operation": job["operation"],
        "source_tree_sha256": source_hash, "source_file_count": len(records),
        "source_bytes": sum(item["bytes"] for item in records), "image_id": image,
        "tool_name": metadata["name"], "tool_version": metadata["version"],
        "node_version": metadata.get("node"), "data_role": "untrusted_source", "status": status,
        "exit_code": completed.returncode, "evidence_id": evidence.get("evidence_id"),
        "coverage": coverage, "statistics": statistics, "limitations": limitations,
        "completed": ["Snapshotted selected local sources and ran REA static analysis in an offline container"],
        "outputs": [{"path": name, "sha256": sha256((output_path / name).read_bytes())} for name in artifacts],
        "next_step": "Independently review retained Evidence and selected-source coverage before implementing any inferred feature.",
    }
    with (output_path / "result.json").open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    execute = commands.add_parser("run")
    execute.add_argument("--input", required=True, type=Path)
    execute.add_argument("--output", required=True, type=Path)
    execute.add_argument("--image", required=True)
    args = parser.parse_args(argv)
    try:
        result = run(args.input, args.output, args.image)
    except Exception as error:
        print(f"Task failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"task_id": result["task_id"], "status": result["status"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
