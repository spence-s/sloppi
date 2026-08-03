#!/usr/bin/python3
import json
from pathlib import Path
import re
import sys
import time

RULES_PATH = Path("/etc/sloppi/egress-domains")
GRANTS_PATH = Path("/run/sloppi-proxy-grants")
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


def request_is_allowed(method, host, path, upgrade, rules, grants, now):
    if upgrade:
        return False
    if method in SAFE_METHODS:
        return True
    if any(
        domain_matches(host, domain)
        and rule_method in {"*", method}
        and rule_path in {"*", path}
        for domain, rule_method, rule_path in rules
    ):
        return True
    return any(
        grant.get("expires", 0) > now
        and grant.get("method") == method
        and grant.get("domain") == host
        and grant.get("path", "*") in {"*", path}
        for grant in grants
    )


def self_test():
    rules = parse_rules(["example.com POST /safe", "trusted.test"])
    assert request_is_allowed("GET", "other.test", "/", "", rules, [], 0)
    assert request_is_allowed("POST", "api.example.com", "/safe", "", rules, [], 0)
    assert not request_is_allowed("POST", "api.example.com", "/unsafe", "", rules, [], 0)
    assert not request_is_allowed("GET", "example.com", "/socket", "websocket", rules, [], 0)
    grant = {"domain": "other.test", "method": "POST", "path": "/once", "expires": 60}
    assert request_is_allowed("POST", "other.test", "/once", "", rules, [grant], 0)
    assert not request_is_allowed("POST", "other.test", "/once", "", rules, [grant], 60)


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
        grants = []
        for grant_path in GRANTS_PATH.glob("*.json"):
            try:
                grants.append(json.loads(grant_path.read_text()))
            except (OSError, ValueError):
                continue

        if request_is_allowed(
            method,
            host,
            path,
            request.headers.get("upgrade", "").lower(),
            self.rules,
            grants,
            time.time(),
        ):
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
