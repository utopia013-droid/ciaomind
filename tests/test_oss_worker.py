"""Acceptance tests use synthetic local sources and real third-party converters."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "oss_worker.py"
SPEC = importlib.util.spec_from_file_location("oss_worker", SCRIPT)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class WorkerAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def task(self, operation, filename, data):
        source = self.root / filename
        source.write_bytes(data)
        job = {
            "task_id": "CIAO-OSS-SYNTHETIC-001",
            "input_version": 1,
            "operation": operation,
            "source_path": filename,
        }
        input_path = self.root / "input.json"
        input_path.write_text(json.dumps(job, ensure_ascii=False) + "\n", encoding="utf-8")
        return input_path

    def verify_receipt(self, input_path, output, result):
        raw = input_path.read_bytes()
        source = self.root / json.loads(raw)["source_path"]
        self.assertEqual(result["input_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["source_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual(result["data_role"], "untrusted_source")
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["tool_version"])
        self.assertEqual(json.loads((output / "result.json").read_text()), result)
        for artifact in result["outputs"]:
            self.assertEqual(artifact["sha256"], hashlib.sha256((output / artifact["path"]).read_bytes()).hexdigest())

    def test_real_docx_conversion_with_receipt(self):
        source = self.root / "report.docx"
        with zipfile.ZipFile(source, "w") as document:
            document.writestr("[Content_Types].xml", '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
                <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
                <Default Extension="xml" ContentType="application/xml"/>
                <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
                </Types>''')
            document.writestr("_rels/.rels", '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
                </Relationships>''')
            document.writestr("word/document.xml", '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                <w:body><w:p><w:r><w:t>Local document conversion acceptance marker: CIAO-OSS-001.</w:t></w:r></w:p></w:body>
                </w:document>''')
        input_path = self.task("document_markdown", source.name, source.read_bytes())
        output = self.root / "result"
        result = worker.run(input_path, output)
        self.verify_receipt(input_path, output, result)
        self.assertIn("CIAO-OSS-001", (output / "output.md").read_text())
        self.assertEqual(result["tool_name"], "markitdown")

    def test_real_html_extraction(self):
        html = b"""<!doctype html><html><head><title>Synthetic article</title></head>
        <body><nav>Unrelated navigation marker</nav><main><article>
        <h1>Local economy research</h1>
        <p>This synthetic research article documents the CIAO-OSS-002 acceptance marker.
        It contains sufficient prose to distinguish the main article from navigation.</p>
        <p>A second paragraph explains that the local adapter extracts already downloaded HTML.
        Researchers retain the original article and independently verify the extraction.</p>
        </article></main></body></html>"""
        input_path = self.task("html_text", "article.html", html)
        output = self.root / "result"
        result = worker.run(input_path, output)
        self.verify_receipt(input_path, output, result)
        self.assertIn("CIAO-OSS-002", (output / "output.md").read_text())
        self.assertNotIn("Unrelated navigation marker", (output / "output.md").read_text())

    def test_real_csv_profile_and_quoted_identifier(self):
        data = b'"name""; DROP TABLE dataset; --",region\nalpha,EU\nbeta,EU\nalpha,\n'
        input_path = self.task("csv_profile", "table.csv", data)
        output = self.root / "result"
        result = worker.run(input_path, output)
        self.verify_receipt(input_path, output, result)
        profile = json.loads((output / "profile.json").read_text())
        self.assertEqual(profile["row_count"], 3)
        self.assertEqual(profile["column_count"], 2)
        self.assertEqual(profile["columns"][0]["distinct_count"], 2)
        self.assertEqual(profile["columns"][1]["null_count"], 1)

    def test_existing_output_is_preserved(self):
        input_path = self.task("csv_profile", "table.csv", b"name\nalpha\n")
        output = self.root / "result"
        worker.run(input_path, output)
        original = (output / "result.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "already exists"):
            worker.run(input_path, output)
        self.assertEqual(original, (output / "result.json").read_bytes())

    def test_repository_output_rejected(self):
        input_path = self.task("csv_profile", "table.csv", b"name\nalpha\n")
        with self.assertRaisesRegex(ValueError, "outside the repository"):
            worker.run(input_path, worker.REPOSITORY_ROOT / ".private-results")

    def test_url_and_unrecognized_parameters_rejected(self):
        input_path = self.task("csv_profile", "table.csv", b"name\nalpha\n")
        job = json.loads(input_path.read_text())
        for extra in ({"source_path": "https://example.com/a.csv"}, {"sql": "DROP TABLE dataset"}, {"input_version": True}):
            with self.subTest(extra=extra):
                changed = dict(job, **extra)
                input_path.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    worker.run(input_path, self.root / "result")
                self.assertFalse((self.root / "result" / "result.json").exists())

    def test_unsupported_document_and_size_limit_rejected(self):
        input_path = self.task("document_markdown", "archive.zip", b"not a zip")
        with self.assertRaisesRegex(ValueError, "Unsupported document extension"):
            worker.run(input_path, self.root / "result")
        source = self.root / "large.txt"
        with source.open("wb") as file:
            file.truncate(worker.MAX_SOURCE_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "size limit"):
            worker.read_regular_file(source, worker.MAX_SOURCE_BYTES)

    def test_renamed_zip_does_not_fall_back_to_archive_converter(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as file:
            file.writestr("secret.txt", "CIAO-ZIP-UNSUPPORTED")
        input_path = self.task("document_markdown", "renamed.pdf", archive.getvalue())
        with self.assertRaises(Exception):
            worker.run(input_path, self.root / "result")
        self.assertFalse((self.root / "result").exists())


if __name__ == "__main__":
    unittest.main()
