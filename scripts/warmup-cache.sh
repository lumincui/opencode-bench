#!/bin/bash
# Cache warm-up for Phase 1 tasks (3 repos, 120s timeout each)

CACHE_DIR="/Users/lumin/opencode-optimize-workspace/opencode-bench/.cache/repos"
mkdir -p "$CACHE_DIR"

echo "Cloning Phase 1 repos..."

clone_or_skip() {
  repo="$1"
  sha="$2"
  cached="$CACHE_DIR/$repo/$sha"

  if [[ -d "$cached" ]]; then
    echo "CACHED $repo@${sha:0:7}"
    return 0
  fi

  echo "CLONE $repo@${sha:0:7}..."
  repo_dir="$CACHE_DIR/$repo"
  mkdir -p "$repo_dir"

  if timeout 120 git -C "$repo_dir" init -q 2>/dev/null; then
    git -C "$repo_dir" remote add origin "https://github.com/$repo.git" 2>/dev/null || true
    if timeout 120 git -C "$repo_dir" fetch --depth 1 origin "$sha" -q 2>&1 | tail -2; then
      git -C "$repo_dir" checkout FETCH_HEAD -q 2>/dev/null
      git -C "$repo_dir" reset --hard FETCH_HEAD -q 2>/dev/null
      echo "  cached -> $cached"
    else
      echo "  FAIL (fetch timeout or not found)"
    fi
  else
    echo "  FAIL (git init)"
  fi
}

# Phase 1 task repos/commits
clone_or_skip "sst/opencode" "090d27df11a718cff3453a38da22d8a5eb405631"
clone_or_skip "sst/opencode" "5f7e1e099b2b5786dd94a172c33d6997d54c215f"
clone_or_skip "HelixDB/helix-db" "ac6d036abe9d921aeecb5f8a84a6766903b2beef"

echo ""
echo "=== CACHE DONE ==="
count=$(find "$CACHE_DIR" -maxdepth 2 -mindepth 2 -type d 2>/dev/null | wc -l | tr -d ' ')
echo "$count repos cached"
du -sh "$CACHE_DIR" 2>/dev/null | awk '{print $1}'