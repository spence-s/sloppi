#!/usr/bin/python3 -I
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time


def fail(message):
    raise SystemExit(f"sloppi-allow-request: {message}")


if len(sys.argv) != 4:
    fail("usage: sloppi-allow-request <method> <domain> <path|*>")

if os.environ.get("SUDO_USER") != "{{.User}}":
    fail("must be run by the Lima user")

method = sys.argv[1].upper()
domain = sys.argv[2].lower().removesuffix(".")
path = sys.argv[3]
if not re.fullmatch(r"[A-Z]{1,16}", method):
    fail("invalid method")
if len(domain) > 253 or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain):
    fail("invalid domain")
if len(path) > 2048 or (path != "*" and not path.startswith("/")):
    fail("invalid path")

grant = {
    "domain": domain,
    "method": method,
    "path": path,
    "expires": time.time() + 60,
}
contents = json.dumps(grant, separators=(",", ":"))
digest = hashlib.sha256(contents.encode()).hexdigest()
grants_path = Path("/run/sloppi-proxy-grants")
if not grants_path.is_dir():
    fail("proxy is not running")

with tempfile.NamedTemporaryFile("w", dir=grants_path, delete=False) as temporary_file:
    temporary_file.write(contents)
    temporary_path = Path(temporary_file.name)
os.chmod(temporary_path, 0o644)
os.replace(temporary_path, grants_path / f"{digest}.json")

scope = domain if path == "*" else f"{domain}{path}"
print(f"Allowed {method} {scope} for 60 seconds")
