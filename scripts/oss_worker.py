"""Small local-only adapters; task files and converted content are data, never commands."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from importlib.metadata import version
from pathlib import Path
import sys
import tempfile


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_JOB_BYTES = 64 * 1024
TOOLS = {
    "document_markdown": "markitdown",
    "html_text": "trafilatura",
    "csv_profile": "duckdb",
}
DOCUMENT_EXTENSIONS = {".txt", ".md", ".pdf", ".docx", ".pptx", ".xlsx", ".csv", ".json"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_regular_file(path: Path, limit: int) -> bytes:
    if not path.is_file():
        raise ValueError("Expected a local regular file")
    if path.stat().st_size > limit:
        raise ValueError("Input exceeds the size limit")
    with path.open("rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Input exceeds the size limit")
    return data


def load_job(input_path: Path) -> tuple[dict, bytes, Path, bytes]:
    raw = read_regular_file(input_path, MAX_JOB_BYTES)
    job = json.loads(raw.decode("utf-8"))
    if not isinstance(job, dict) or set(job) != {
        "task_id", "input_version", "operation", "source_path"
    }:
        raise ValueError("Job must contain exactly task_id, input_version, operation, source_path")
    if not isinstance(job["task_id"], str) or not job["task_id"].strip():
        raise ValueError("task_id must be a nonempty string")
    if type(job["input_version"]) is not int or job["input_version"] < 1:
        raise ValueError("input_version must be a positive integer")
    if not isinstance(job["operation"], str) or job["operation"] not in TOOLS:
        raise ValueError("Unsupported operation")
    source_name = job["source_path"]
    if not isinstance(source_name, str) or not source_name.strip():
        raise ValueError("source_path must be a nonempty local path")
    if "://" in source_name or source_name.lower().startswith(("data:", "file:", "zip:")):
        raise ValueError("URL and URI inputs are not supported")
    source_path = Path(source_name)
    if not source_path.is_absolute():
        source_path = input_path.parent / source_path
    source_path = source_path.resolve()
    return job, raw, source_path, read_regular_file(source_path, MAX_SOURCE_BYTES)


def document_markdown(source: bytes, suffix: str) -> tuple[str, bytes, list[str]]:
    if suffix not in DOCUMENT_EXTENSIONS:
        raise ValueError("Unsupported document extension")
    from markitdown import MarkItDown, StreamInfo
    from markitdown.converters import (
        CsvConverter, DocxConverter, PdfConverter, PlainTextConverter,
        PptxConverter, XlsxConverter,
    )

    converter_types = {
        ".txt": PlainTextConverter, ".md": PlainTextConverter,
        ".json": PlainTextConverter, ".csv": CsvConverter,
        ".pdf": PdfConverter, ".docx": DocxConverter,
        ".pptx": PptxConverter, ".xlsx": XlsxConverter,
    }
    # Disable the built-in registry as well: content sniffing must not fall back
    # to archive, URL, audio, image, or cloud converters under another suffix.
    engine = MarkItDown(enable_builtins=False, enable_plugins=False)
    engine.register_converter(converter_types[suffix]())
    converted = engine.convert_stream(io.BytesIO(source), stream_info=StreamInfo(extension=suffix))
    text = converted.markdown
    if not text.strip():
        raise ValueError("Document conversion produced no text")
    return "output.md", text.encode("utf-8"), [
        "Local text conversion only; no cloud OCR, plugins, audio, or model calls.",
        "Scanned PDFs and complex layouts may require a separate reviewed workflow.",
    ]


def html_text(source: bytes, suffix: str) -> tuple[str, bytes, list[str]]:
    if suffix not in {".html", ".htm"}:
        raise ValueError("html_text requires a local .html or .htm file")
    import trafilatura

    text = trafilatura.extract(
        source, favor_precision=True, include_comments=False, include_tables=True
    )
    if not text or not text.strip():
        raise ValueError("No article text was extracted")
    return "output.md", text.encode("utf-8"), [
        "Extracts already downloaded HTML; does not fetch URLs or execute JavaScript.",
        "Extraction is heuristic; the caller must retain and verify the original source.",
    ]


def quote_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def csv_profile(source: bytes, suffix: str) -> tuple[str, bytes, list[str]]:
    if suffix != ".csv":
        raise ValueError("csv_profile requires a local .csv file")
    import duckdb

    with tempfile.TemporaryDirectory(prefix="ciaomind-csv-") as temporary, duckdb.connect(
        ":memory:",
        config={
            "autoload_known_extensions": "false",
            "autoinstall_known_extensions": "false",
        },
    ) as connection:
        # A private snapshot binds parsing to the same bytes as the receipt, without
        # adding a filesystem/remote-storage plugin to support file-like objects.
        snapshot = Path(temporary) / "source.csv"
        snapshot.write_bytes(source)
        connection.read_csv(str(snapshot), header=True, all_varchar=True).create("dataset")
        connection.execute("SET enable_external_access = false")
        columns = [column[0] for column in connection.execute("DESCRIBE dataset").fetchall()]
        row_count = connection.execute("SELECT count(*) FROM dataset").fetchone()[0]
        profiles = []
        for column in columns:
            identifier = quote_identifier(column)
            nulls, distinct = connection.execute(
                f"SELECT count(*) FILTER (WHERE {identifier} IS NULL), "
                f"count(DISTINCT {identifier}) FROM dataset"
            ).fetchone()
            profiles.append({"name": column, "null_count": nulls, "distinct_count": distinct})
    profile = {"row_count": row_count, "column_count": len(columns), "columns": profiles}
    return "profile.json", (json.dumps(profile, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), [
        "CSV values are treated as strings; this is a structural profile, not financial analysis.",
        "Null counts follow DuckDB CSV parsing; distinct counts exclude NULL.",
        "Only fixed profile queries run; user-supplied SQL and extensions are unsupported.",
    ]


ADAPTERS = {
    "document_markdown": document_markdown,
    "html_text": html_text,
    "csv_profile": csv_profile,
}


def run(input_path: Path, output_path: Path) -> dict:
    input_path = input_path.resolve()
    output_path = output_path.resolve()
    if output_path == REPOSITORY_ROOT or REPOSITORY_ROOT in output_path.parents:
        raise ValueError("Output must be outside the repository to keep private data out of Git")
    if output_path.exists():
        raise ValueError("Output directory already exists; refusing to overwrite")
    job, raw, source_path, source = load_job(input_path)
    operation = job["operation"]
    filename, artifact, limitations = ADAPTERS[operation](source, source_path.suffix.lower())
    tool = TOOLS[operation]
    result = {
        "task_id": job["task_id"],
        "input_version": job["input_version"],
        "input_sha256": sha256(raw),
        "operation": operation,
        "tool_name": tool,
        "tool_version": version(tool),
        "source_sha256": sha256(source),
        "data_role": "untrusted_source",
        "status": "completed",
        "completed": [f"Executed local {operation} and wrote the artifact"],
        "outputs": [{"path": filename, "sha256": sha256(artifact)}],
        "evidence": ["Source and job SHA256 bind this receipt to the captured input bytes"],
        "limitations": limitations + ["Worker completion is separate from independent review and acceptance."],
        "next_step": "Review the local artifact; return only a minimal receipt to the task tracker.",
    }
    # Exclusive creation is deliberate: repeated tasks must never destroy previous output.
    output_path.mkdir(parents=True, exist_ok=False)
    with (output_path / filename).open("xb") as artifact_file:
        artifact_file.write(artifact)
    with (output_path / "result.json").open("x", encoding="utf-8") as receipt_file:
        json.dump(result, receipt_file, ensure_ascii=False, indent=2)
        receipt_file.write("\n")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="List locally supported operations")
    execute = commands.add_parser("run", help="Execute one explicit local task")
    execute.add_argument("--input", required=True, type=Path)
    execute.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "list":
        print(json.dumps(TOOLS, indent=2))
        return 0
    try:
        result = run(args.input, args.output)
    except Exception as error:
        print(f"Task failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"task_id": result["task_id"], "status": result["status"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
