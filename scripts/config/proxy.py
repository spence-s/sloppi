#!/usr/bin/python3
import json
from pathlib import Path
import re
import sys
import time

RULES_PATH = Path("/etc/sloppi/egress-domains")
GRANTS_PATH = Path("/run/sloppi-proxy-grants")
PERMANENT_RULES_PATH = Path("/var/lib/sloppi-proxy/permanent-rules.json")
SAFE_METHODS = {"GET", "HEAD"}


def parse_rules(lines):
    rules = []
    for line_number, line in enumerate(lines, 1):
        line = line.partition("#")[0].strip()
        if not line:
            continue

        parts = line.split(maxsplit=2)
        domain = parts[0].lower().removesuffix(".")
        method = parts[1].upper() if len(parts) > 1 else "*"
        path = parts[2] if len(parts) > 2 else "*"
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain):
            raise ValueError(f"invalid domain on line {line_number}")
        if method != "*" and not re.fullmatch(r"[A-Z]+", method):
            raise ValueError(f"invalid method on line {line_number}")
        if path != "*" and not path.startswith("/"):
            raise ValueError(f"invalid path on line {line_number}")
        rules.append((domain, method, path))
    return rules


def domain_matches(host, domain):
    return host == domain or host.endswith(f".{domain}")


def request_is_allowed(method, host, path, upgrade, rules):
    if upgrade:
        return False
    if method in SAFE_METHODS:
        return True
    return any(
        domain_matches(host, domain)
        and rule_method in {"*", method}
        and rule_path in {"*", path}
        for domain, rule_method, rule_path in rules
    )


def scope_matches(method, host, path, rule):
    return (
        rule.get("method") in {"*", method}
        and rule.get("domain") == host
        and rule.get("path", "*") in {"*", path}
    )


def grant_matches(method, host, path, grant, now):
    return grant.get("expires", 0) > now and scope_matches(method, host, path, grant)


def self_test():
    rules = parse_rules(["example.com POST /safe", "trusted.test"])
    assert request_is_allowed("GET", "other.test", "/", "", rules)
    assert request_is_allowed("POST", "api.example.com", "/safe", "", rules)
    assert not request_is_allowed("POST", "api.example.com", "/unsafe", "", rules)
    assert not request_is_allowed("GET", "example.com", "/socket", "websocket", rules)
    grant = {"domain": "other.test", "method": "POST", "path": "/once", "expires": 60}
    assert grant_matches("POST", "other.test", "/once", grant, 0)
    assert not grant_matches("POST", "other.test", "/once", grant, 60)
    domain_rule = {"domain": "other.test", "method": "*", "path": "*"}
    assert scope_matches("DELETE", "other.test", "/anything", domain_rule)
    assert not scope_matches("DELETE", "sub.other.test", "/anything", domain_rule)


if "--self-test" in sys.argv:
    self_test()
    raise SystemExit(0)

from mitmproxy import http


class EgressPolicy:
    def __init__(self):
        self.rules = parse_rules(RULES_PATH.read_text().splitlines())

    def requestheaders(self, flow):
        request = flow.request
        method = request.method.upper()
        host = request.host.lower().removesuffix(".")
        path = request.path.partition("?")[0]
        upgrade = request.headers.get("upgrade", "").lower()
        if request_is_allowed(method, host, path, upgrade, self.rules):
            return

        if not upgrade:
            try:
                permanent_rules = json.loads(PERMANENT_RULES_PATH.read_text())
            except (OSError, ValueError):
                permanent_rules = []
            if isinstance(permanent_rules, list) and any(
                isinstance(rule, dict) and scope_matches(method, host, path, rule)
                for rule in permanent_rules
            ):
                return

            now = time.time()
            for grant_path in GRANTS_PATH.glob("*.json"):
                try:
                    grant = json.loads(grant_path.read_text())
                except (OSError, ValueError):
                    continue
                if grant.get("expires", 0) <= now:
                    grant_path.unlink(missing_ok=True)
                    continue
                if not grant_matches(method, host, path, grant, now):
                    continue
                try:
                    grant_path.unlink()
                except FileNotFoundError:
                    continue
                return

        body = json.dumps({
            "error": "network request denied",
            "method": method,
            "domain": host,
            "path": path,
        })
        flow.response = http.Response.make(
            403,
            body,
            {
                "Content-Type": "application/json",
                "X-Sloppi-Network-Policy": "denied",
            },
        )


addons = [EgressPolicy()]
