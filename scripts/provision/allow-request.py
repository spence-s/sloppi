#!/usr/bin/python3 -I
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

PERSISTENT_RULES_PATH = Path("{{.Home}}/.pi/agent/network-access.json")
ACTIVE_RULES_PATH = Path("/var/lib/sloppi-proxy/permanent-rules.json")


def fail(message):
    raise SystemExit(f"sloppi-allow-request: {message}")


def read_rules(path):
    if not path.exists():
        return []
    try:
        rules = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        fail(f"invalid {path}: {error}")
    if not isinstance(rules, list) or not all(isinstance(rule, dict) for rule in rules):
        fail(f"invalid {path}: expected a JSON array of rules")
    return rules


def write_json(path, value, mode):
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as temporary_file:
        json.dump(value, temporary_file, indent=2)
        temporary_file.write("\n")
        temporary_path = Path(temporary_file.name)
    os.chmod(temporary_path, mode)
    os.replace(temporary_path, path)


if sys.argv[1:] == ["restore"]:
    if os.geteuid() != 0:
        fail("restore must run as root")
    rules = read_rules(PERSISTENT_RULES_PATH)
    write_json(ACTIVE_RULES_PATH, rules, 0o644)
    print(f"Restored {len(rules)} permanent network rules")
    raise SystemExit(0)

if len(sys.argv) != 5:
    fail("usage: sloppi-allow-request <once|request|domain> <method> <domain> <path|*>")

if os.environ.get("SUDO_USER") != "{{.User}}":
    fail("must be run by the Lima user")

mode = sys.argv[1]
method = sys.argv[2].upper()
domain = sys.argv[3].lower().removesuffix(".")
path = sys.argv[4]
if mode not in {"once", "request", "domain"}:
    fail("invalid mode")
if not re.fullmatch(r"[A-Z]{1,16}", method):
    fail("invalid method")
if len(domain) > 253 or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain):
    fail("invalid domain")
if len(path) > 2048 or (path != "*" and not path.startswith("/")):
    fail("invalid path")

rule = {
    "domain": domain,
    "method": "*" if mode == "domain" else method,
    "path": "*" if mode == "domain" else path,
}
if mode == "once":
    rule["expires"] = time.time() + 60
    contents = json.dumps(rule, separators=(",", ":"))
    digest = hashlib.sha256(contents.encode()).hexdigest()
    grants_path = Path("/run/sloppi-proxy-grants")
    if not grants_path.is_dir():
        fail("proxy is not running")
    with tempfile.NamedTemporaryFile("w", dir=grants_path, delete=False) as temporary_file:
        temporary_file.write(contents)
        temporary_path = Path(temporary_file.name)
    os.chmod(temporary_path, 0o644)
    os.replace(temporary_path, grants_path / f"{digest}.json")
else:
    persistent_rules = read_rules(PERSISTENT_RULES_PATH)
    if rule not in persistent_rules:
        persistent_rules.append(rule)
    write_json(PERSISTENT_RULES_PATH, persistent_rules, 0o600)

    active_rules = read_rules(ACTIVE_RULES_PATH)
    if rule not in active_rules:
        active_rules.append(rule)
    write_json(ACTIVE_RULES_PATH, active_rules, 0o644)

scope = domain if path == "*" else f"{domain}{path}"
if mode == "once":
    print(f"Allowed the next {method} {scope} request within 60 seconds")
elif mode == "request":
    print(f"Always allowed {method} {scope}")
else:
    print(f"Always allowed all requests to {domain}")
