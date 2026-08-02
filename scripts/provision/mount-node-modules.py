#!/usr/bin/python3 -I
import hashlib
import os
from pathlib import Path
import pwd
import subprocess
import sys


def fail(message):
    raise SystemExit(f"sloppi-mount-node-modules: {message}")


if len(sys.argv) != 1:
    fail("arguments are not allowed")

user = os.environ.get("SUDO_USER")
if user != "{{.User}}":
    fail("must be run by the Lima user")

account = pwd.getpwnam(user)
project = Path.cwd().resolve(strict=True)
filesystem = subprocess.run(
    ["/usr/bin/findmnt", "-n", "-o", "FSTYPE", "--target", project],
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
if filesystem not in {"9p", "fuse.sshfs", "virtiofs"}:
    fail("the project is not on a Lima host mount")

digest = hashlib.sha256(os.fsencode(project)).hexdigest()
source = Path(account.pw_dir) / ".cache" / "pi-dev" / "node_modules" / digest
target = project / "node_modules"

for directory in (source, target):
    if directory.resolve(strict=True) != directory or directory.stat().st_uid != account.pw_uid:
        fail(f"unsafe directory: {directory}")

if subprocess.run(["/usr/bin/mountpoint", "-q", target]).returncode == 0:
    raise SystemExit(0)

flags = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW
source_fd = os.open(source, flags)
target_fd = os.open(target, flags)
try:
    subprocess.run(
        [
            "/usr/bin/mount",
            "--bind",
            "--no-canonicalize",
            f"/proc/self/fd/{source_fd}",
            f"/proc/self/fd/{target_fd}",
        ],
        check=True,
        pass_fds=(source_fd, target_fd),
    )
finally:
    os.close(source_fd)
    os.close(target_fd)
