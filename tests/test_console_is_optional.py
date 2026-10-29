"""The admin console is optional: the engine, jobs, API and core infrastructure must work without it."""

import re
import subprocess
from pathlib import Path

from tests.ddl_schema import CONSOLE_FILES, TABLE_FILES, parse_tables

ROOT = Path(__file__).resolve().parent.parent
PLATFORM = ROOT / "infra" / "terraform" / "modules" / "platform"
CONSOLE_TABLES = set(parse_tables(CONSOLE_FILES))
RUNTIME_DIRS = ["packages", "apps/api", "apps/workers"]


def _tracked(*patterns: str) -> list[Path]:
    out = subprocess.run(["git", "ls-files", *patterns], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    return [ROOT / p for p in out]


def test_console_tables_are_only_the_expected_ones():
    assert CONSOLE_TABLES == {"app_users", "audit_log", "review_decisions"}
    assert not CONSOLE_TABLES & set(parse_tables(TABLE_FILES))


def test_no_runtime_code_references_the_console_or_its_tables():
    files = [f for d in RUNTIME_DIRS for f in _tracked(f"{d}/**/*.py", f"{d}/*.py")]
    assert files, "expected runtime sources"
    needle = re.compile("|".join([*CONSOLE_TABLES, "admin_console", "admin-console"]))
    offenders = [str(f.relative_to(ROOT)) for f in files if needle.search(f.read_text())]
    assert offenders == [], f"engine/runtime code must not depend on the console: {offenders}"


def test_core_sql_does_not_mention_console_tables():
    for name in TABLE_FILES:
        text = (ROOT / "sql" / name).read_text()
        assert not any(t in text for t in CONSOLE_TABLES), name
    for sql in sorted((PLATFORM / "views").glob("*.sql")):
        assert not any(t in sql.read_text() for t in CONSOLE_TABLES), sql.name


def test_console_infrastructure_is_off_by_default():
    for path in [PLATFORM / "variables.tf", ROOT / "infra/terraform/environments/dev/variables.tf", ROOT / "infra/terraform/environments/prod/variables.tf"]:
        block = re.search(r'variable "enable_admin_console" \{(.*?)\n\}', path.read_text(), re.S)
        assert block and re.search(r"default\s*=\s*false", block.group(1)), path
    locals_tf = (PLATFORM / "locals.tf").read_text()
    # Core tables never include the console ones; they are only added behind the flag.
    assert re.search(r"core_config_tables\s*=\s*\[[^\]]*\]", locals_tf)
    core = re.search(r"core_config_tables\s*=\s*\[([^\]]*)\]", locals_tf).group(1)
    assert not any(t in core for t in CONSOLE_TABLES)
    assert "var.enable_admin_console ?" in locals_tf


def test_every_console_grant_and_role_is_gated_by_the_flag():
    iam = (PLATFORM / "iam.tf").read_text()
    section = iam[iam.index("OPTIONAL admin console"):]
    resources = re.findall(r'resource "google_[a-z_]+" "console_[a-z_]+" \{(.*?)\n\}', section, re.S)
    assert len(resources) >= 4
    for body in resources:
        assert "local.console_members" in body or "var.enable_admin_console" in body
