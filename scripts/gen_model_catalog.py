"""Writes the console's copy of the model catalog from the Python catalog (the single source of truth). A test fails when the two drift."""
import json
from pathlib import Path

from sci_openai.catalog import as_json

OUT = Path(__file__).parent.parent / "apps" / "admin-console" / "src" / "server" / "model-catalog.json"

if __name__ == "__main__":
    OUT.write_text(json.dumps(as_json(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")
