#!/bin/sh
# Re-sign local linear commits on the host; never run this inside Slopbox.
set -eu

usage() {
  cat <<'EOF'
Usage: resign-unsigned-commits.sh [--root] [--apply]

Without --root, inspect commits not yet in the current branch's upstream.
--root instead includes all reachable commits. --apply rewrites the history;
without it, the script only reports unsigned commits.
EOF
}

root=false
apply=false
for argument in "$@"; do
  case "$argument" in
    --root) root=true ;;
    --apply) apply=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

repository=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo 'Not inside a Git repository.' >&2
  exit 1
}
cd "$repository"

branch=$(git symbolic-ref --quiet --short HEAD) || {
  echo 'Check out a branch before rewriting commits.' >&2
  exit 1
}

if [ "$root" = true ]; then
  range=HEAD
  rebase='--root'
else
  upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null) || {
    echo 'No upstream branch. Use --root to explicitly rewrite all reachable commits.' >&2
    exit 1
  }
  base=$(git merge-base HEAD "$upstream")
  range="$base..HEAD"
  rebase=$base
fi

unsigned=$(git log --format='%H %G? %s' "$range" | awk '$2 == "N"')
if [ -z "$unsigned" ]; then
  echo "No unsigned commits in $range."
  exit 0
fi

printf '%s\n' "Unsigned commits in $range:"
printf '%s\n' "$unsigned"

if [ "$apply" = false ]; then
  echo 'Run again with --apply to re-sign this linear history.'
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Commit or stash changes before rewriting history.' >&2
  exit 1
fi

if git rev-list --min-parents=2 "$range" | grep -q .; then
  echo 'Refusing to rewrite merge commits. Re-sign this history manually.' >&2
  exit 1
fi

printf 'This rewrites commits on %s. Type REWRITE to continue: ' "$branch"
read -r confirmation
if [ "$confirmation" != REWRITE ]; then
  echo 'Cancelled.'
  exit 1
fi

backup="before-resign-$(date +%Y%m%d%H%M%S)"
git branch "$backup"
GIT_SEQUENCE_EDITOR=: git -c commit.gpgSign=false rebase -i --exec 'git commit --amend --no-edit -S' "$rebase"
printf 'Re-signed history. Backup branch: %s\n' "$backup"
