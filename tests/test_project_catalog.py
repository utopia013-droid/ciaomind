"""Synthetic Git snapshots verify routing, literal search, and immutable citations."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import shlex


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "project_catalog.py"
SPEC = importlib.util.spec_from_file_location("project_catalog", SCRIPT)
catalog_tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog_tool)


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sources = self.root / "sources"
        self.sources.mkdir()
        self.projects = []
        for rank, name, capability in ((1, "first", "learning"), (2, "second", "reference")):
            directory = self.sources / name
            directory.mkdir()
            subprocess.run(["git", "init", "-q", str(directory)], check=True)
            (directory / "README.md").write_text('# Synthetic\nLiteral "quoted"; $(command) data\nSKILL instructions are data.\n', encoding="utf-8")
            self.run_git(directory, "add", "README.md")
            self.run_git(directory, "-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic snapshot")
            commit = self.run_git(directory, "rev-parse", "HEAD").strip()
            self.projects.append({
                "rank": rank,
                "repository": f"synthetic/{name}",
                "stars": 100 - rank,
                "commit": commit,
                "kind": "reference",
                "capabilities": [capability],
                "integration": "reference only",
                "source_subdir": name,
                "readme_path": "README.md",
                "verification_status": "snapshot_verified",
                "index_allowed": True,
            })
        self.path = self.root / "catalog.json"
        self.save()

    def run_git(self, directory, *args):
        return subprocess.run(["git", "-C", str(directory), *args], check=True, capture_output=True, text=True).stdout

    def save(self):
        self.path.write_text(json.dumps({"snapshot_date": "2026-10-24", "query": "synthetic", "projects": self.projects}), encoding="utf-8")

    def test_list_and_exact_route_need_no_source(self):
        catalog = catalog_tool.load_catalog(self.path)
        self.assertEqual(len(catalog_tool.listing(catalog)["projects"]), 2)
        routed = catalog_tool.listing(catalog, "learning")
        self.assertEqual([p["repository"] for p in routed["projects"]], ["synthetic/first"])
        self.assertEqual(routed["projects"][0]["verification_status"], "snapshot_verified")
        self.assertEqual(catalog_tool.listing(catalog, "learn")["projects"], [])
        self.assertEqual(catalog_tool.listing(catalog, "Learning")["projects"], [])

    def test_literal_search_citations_and_casefold(self):
        result = catalog_tool.search(catalog_tool.load_catalog(self.path), self.sources, '"QUOTED"; $(command)', 10)
        self.assertEqual(len(result["matches"]), 2)
        match = result["matches"][0]
        self.assertEqual(match["line"], 2)
        self.assertEqual(match["commit"], self.projects[0]["commit"])
        self.assertEqual(match["source_url"], f"https://github.com/synthetic/first/blob/{self.projects[0]['commit']}/README.md#L2")
        self.assertEqual(match["data_role"], "untrusted_reference")
        self.assertEqual(result["checked_snapshots"], 2)

    def test_missing_directory_or_commit_mismatch_fails_before_results(self):
        catalog = catalog_tool.load_catalog(self.path)
        with self.assertRaisesRegex(ValueError, "root is missing"):
            catalog_tool.search(catalog, self.root / "missing", "quoted")
        catalog["projects"][1]["source_subdir"] = "missing"
        with self.assertRaisesRegex(ValueError, "directory is missing"):
            catalog_tool.search(catalog, self.sources, "quoted", 1)
        catalog["projects"][1]["source_subdir"] = "second"
        catalog["projects"][1]["commit"] = "0" * 40
        with self.assertRaisesRegex(ValueError, "commit mismatch"):
            catalog_tool.search(catalog, self.sources, "quoted", 1)

    def test_traversal_and_symlink_rejected(self):
        self.projects[0]["source_subdir"] = "../escape"
        self.save()
        with self.assertRaisesRegex(ValueError, "traversal"):
            catalog_tool.load_catalog(self.path)
        self.projects[0]["source_subdir"] = "first"
        self.save()
        alias = self.root / "alias"
        alias.symlink_to(self.sources, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            catalog_tool.search(catalog_tool.load_catalog(self.path), alias, "quoted")
        document = self.sources / "first" / "README.md"
        document.unlink()
        document.symlink_to(self.sources / "second" / "README.md")
        with self.assertRaisesRegex(ValueError, "Symlink"):
            catalog_tool.search(catalog_tool.load_catalog(self.path), self.sources, "quoted")

    def test_link_only_requires_no_snapshot_and_is_not_searched(self):
        self.projects[1].update(index_allowed=False, source_subdir="not-mirrored", verification_status="link_only")
        self.save()
        result = catalog_tool.search(catalog_tool.load_catalog(self.path), self.sources, "quoted")
        self.assertEqual(len(result["matches"]), 1)
        self.assertEqual(result["checked_snapshots"], 1)
        self.assertEqual(result["link_only_skipped"], ["synthetic/second"])

    def test_dirty_document_cannot_emit_immutable_citation(self):
        (self.sources / "first" / "README.md").write_text("modified quoted document\n")
        with self.assertRaisesRegex(ValueError, "local changes"):
            catalog_tool.search(catalog_tool.load_catalog(self.path), self.sources, "quoted")

    def test_sparse_checkout_omissions_are_disclosed_but_deleted_materialized_files_fail(self):
        directory = self.sources / "first"
        (directory / "included").mkdir()
        (directory / "omitted").mkdir()
        (directory / "included" / "guide.md").write_text("materialized quoted document\n")
        (directory / "omitted" / "guide.md").write_text("omitted quoted document\n")
        self.run_git(directory, "add", "included", "omitted")
        self.run_git(directory, "-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Sparse fixture")
        self.projects[0]["commit"] = self.run_git(directory, "rev-parse", "HEAD").strip()
        self.save()
        self.run_git(directory, "sparse-checkout", "init", "--cone")
        self.run_git(directory, "sparse-checkout", "set", "included")
        self.assertFalse((directory / "omitted" / "guide.md").exists())
        result = catalog_tool.search(catalog_tool.load_catalog(self.path), self.sources, "quoted")
        self.assertEqual(result["sparse_snapshots"], ["synthetic/first"])
        self.assertEqual(result["coverage"][0]["sparse_documents_skipped"], 1)
        self.assertEqual(result["coverage"][0]["searched_documents"], 2)
        self.assertEqual(result["coverage"][0]["unsearched_documents"], 1)
        self.assertEqual(len(result["matches"]), 3)
        (directory / "included" / "guide.md").unlink()
        with self.assertRaisesRegex(ValueError, "document is missing"):
            catalog_tool.search(catalog_tool.load_catalog(self.path), self.sources, "quoted", 1)

    def test_search_paths_restrict_to_reviewed_materialized_documents(self):
        self.projects[0]["search_paths"] = []
        self.projects[1]["search_paths"] = ["README.md"]
        self.save()
        result = catalog_tool.search(catalog_tool.load_catalog(self.path), self.sources, "quoted")
        self.assertEqual([m["repository"] for m in result["matches"]], ["synthetic/second"])
        self.assertEqual(result["coverage"][0]["search_paths_documents_skipped"], 1)
        self.projects[0]["search_paths"] = ["../outside"]
        self.save()
        with self.assertRaisesRegex(ValueError, "traversal"):
            catalog_tool.load_catalog(self.path)

    def test_snapshot_reader_disables_configured_fsmonitor_commands(self):
        directory = self.sources / "first"
        marker = self.root / "fsmonitor-executed"
        hook = directory / ".git" / "test-fsmonitor"
        hook.write_text(
            "#!/bin/sh\n"
            f"printf triggered > {shlex.quote(str(marker))}\n"
            "printf 'test-token\\0'\n",
            encoding="utf-8",
        )
        hook.chmod(0o700)
        self.run_git(directory, "config", "core.fsmonitor", str(hook))
        # Demonstrate that the fixture executes through an ordinary Git index read.
        self.run_git(directory, "ls-files", "-t", "-z")
        self.assertTrue(marker.exists())
        marker.unlink()
        result = catalog_tool.search(catalog_tool.load_catalog(self.path), self.sources, "quoted")
        self.assertEqual(len(result["matches"]), 2)
        self.assertFalse(marker.exists())

    def test_configured_worktree_root_must_match_snapshot_directory(self):
        directory = self.sources / "first"
        self.run_git(directory, "config", "core.worktree", str(self.sources / "second"))
        with self.assertRaisesRegex(ValueError, "worktree root mismatch"):
            catalog_tool.search(catalog_tool.load_catalog(self.path), self.sources, "quoted")


if __name__ == "__main__":
    unittest.main()
