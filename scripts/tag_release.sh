#!/bin/bash

# Tags this repo and pushes the tag. The tag push runs
# .github/workflows/deploy-companion.yaml on tinyeeliu/ai-companion.
#
# Usage: ./scripts/tag_release.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

if [[ -n $(git status -s) ]]; then
  echo "tree is dirty, please commit changes before running this"
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"

if [ "$branch" = "HEAD" ]; then
  echo "ERROR: on detached HEAD (e.g. mid git pull --rebase). Check out a branch first." >&2
  exit 1
fi

if ! git cat-file -e "HEAD:.github/workflows/deploy-companion.yaml" 2>/dev/null; then
  echo "ERROR: .github/workflows/deploy-companion.yaml is not in HEAD. Commit it before tagging." >&2
  exit 1
fi

safe_branch="${branch//\//-}"
date="$(date +'%Y%m%d-%H%M')"
tag="$safe_branch-$date-companion"

echo "tagging $tag"
echo "commit: $(git rev-parse HEAD)"

git tag "$tag"

echo "git push tag"
git push origin "$tag"
echo "done push tag"

remote="$(git remote get-url origin)"
remote="${remote%.git}"
case "$remote" in
  *://*)
    repo="${remote#*://}"
    repo="${repo#*/}"
    ;;
  *:*)
    repo="${remote#*:}"
    ;;
  *)
    repo="$remote"
    ;;
esac

echo "commit_tag: $tag"
echo "Deploy workflow triggered. See: https://github.com/${repo}/actions"

exit 0
