#!/usr/bin/env bash
set -euo pipefail

mode="${1:-menu}"; shift || true
arg="${*:-}"

BASE_BRANCH="${PI_WORKTREE_BASE_BRANCH:-main}"
HOME_DIR="${HOME:-/Users/jaren}"
WORKTREES_DIR="$HOME_DIR/Documents/programming/salesai-worktrees"

have() { command -v "$1" >/dev/null 2>&1; }
repo_root() { git rev-parse --show-toplevel; }
main_root() {
  local common root
  root="$(repo_root)"
  common="$(git rev-parse --git-common-dir)"
  [[ "$common" != /* ]] && common="$root/$common"
  [[ "$(basename "$common")" = ".git" ]] && dirname "$common" || echo "$root"
}
extract_key() { echo "$1" | grep -Eo '[A-Z][A-Z0-9]+-[0-9]+' | head -1 | tr '[:lower:]' '[:upper:]' || true; }
slugify() { echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's#[^a-z0-9]+#-#g; s#^-+|-+$##g' | cut -c1-72; }
branch_type_for() {
  local text; text="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$text" =~ bug|fix|error|fail|broken|regression|incorrect ]] && echo fix || echo feat
}
jira_field_text() {
  local key="$1"
  acli jira workitem view "$key" 2>/dev/null || acli jira issue view "$key" 2>/dev/null || true
}
jira_summary() { jira_field_text "$1" | awk -F': ' '/^Summary:/{print substr($0, index($0,$2)); exit}'; }
jira_type() { jira_field_text "$1" | awk -F': ' '/^Type:/{print $2; exit}'; }
copy_path() { have pbcopy && printf '%s' "$1" | pbcopy || true; }

status_file="$(mktemp -t salesai-worktree-status.XXXXXX)"
trap 'rm -f "$status_file"' EXIT

say_header() {
  if have gum; then
    gum style --border rounded --border-foreground 63 --padding "0 2" --margin "0 0 1 0" \
      "SalesAI worktree setup" \
      "Deterministic local setup — no agent handoff"
  else
    printf 'SalesAI worktree setup\n\n'
  fi
}

step_start() {
  local label="$1"
  if have gum; then
    gum style --foreground 245 "○ $label"
  else
    printf '○ %s\n' "$label"
  fi
}

step_done() {
  local label="$1" detail="${2:-}"
  if have gum; then
    gum style --foreground 42 "● $label"
    [[ -n "$detail" ]] && gum style --foreground 245 "  $detail"
  else
    printf '● %s\n' "$label"
    [[ -n "$detail" ]] && printf '  %s\n' "$detail"
  fi
}

step_fail() {
  local label="$1" detail="${2:-}"
  if have gum; then
    gum style --foreground 196 --bold "✕ $label"
    [[ -n "$detail" ]] && gum style --foreground 196 "  $detail"
  else
    printf '✕ %s\n' "$label"
    [[ -n "$detail" ]] && printf '  %s\n' "$detail"
  fi
}

last_output_line() { grep -v '^$' "$status_file" | tail -1 | cut -c1-180 || true; }

run_quiet() {
  local label="$1"; shift
  step_start "$label"
  : > "$status_file"
  if "$@" >"$status_file" 2>&1; then
    local last; last="$(last_output_line)"
    step_done "$label" "$last"
  else
    local last; last="$(last_output_line)"
    step_fail "$label" "${last:-Command failed: $*}"
    printf '\nLast command output:\n'
    tail -80 "$status_file"
    exit 1
  fi
}

copy_local_files() {
  local src="$1" dst="$2" f
  for f in .pi frontend/.pi frontend/.env.local frontend/.env.harness.local frontend/.env.dev; do
    if [[ -e "$src/$f" && ! -e "$dst/$f" ]]; then
      mkdir -p "$(dirname "$dst/$f")"
      cp -R "$src/$f" "$dst/$f"
      echo "copied $f"
    fi
  done
}

create_wt() {
  local input="${1:-}" key summary issue_type branch path main existing copied_detail
  [[ -z "$input" ]] && { echo "Usage: $0 create <Jira URL/key>"; exit 2; }
  main="$(main_root)"
  key="$(extract_key "$input")"
  [[ -z "$key" ]] && { echo "No Jira key found in: $input"; exit 2; }

  say_header

  step_start "Read Jira ticket"
  summary="$(jira_summary "$key")"
  issue_type="$(jira_type "$key")"
  [[ -z "$summary" ]] && summary="worktree"
  step_done "Read Jira ticket" "$key — $summary"

  step_start "Resolve branch and target path"
  branch="$(branch_type_for "$issue_type $summary")/$key-$(slugify "$summary")"
  path="$WORKTREES_DIR/$key"
  step_done "Resolve branch and target path" "$branch → $path"

  existing="$(git worktree list --porcelain | awk -v p="$path" 'BEGIN{found=0} /^worktree /{found=($0=="worktree " p)} found && /^branch /{print p; exit}')"
  if [[ -n "$existing" || -d "$path/.git" || -f "$path/.git" ]]; then
    step_done "Use existing worktree" "$path"
    copy_path "$path"
    printf '\ncd %s\n' "$path"
    return 0
  fi

  mkdir -p "$WORKTREES_DIR"
  run_quiet "Fetch origin/${BASE_BRANCH}" git -C "$main" fetch origin "$BASE_BRANCH" --prune

  if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
    run_quiet "Create git worktree" git -C "$main" worktree add "$path" "$branch"
  elif git -C "$main" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    run_quiet "Create git worktree" git -C "$main" worktree add -b "$branch" "$path" "origin/$branch"
  else
    run_quiet "Create git worktree" git -C "$main" worktree add -b "$branch" "$path" "origin/${BASE_BRANCH}"
    git -C "$path" branch --unset-upstream 2>/dev/null || true
  fi

  step_start "Hydrate local files"
  copy_local_files "$main" "$path" >"$status_file" 2>&1 || true
  copied_detail="$(tr '\n' ', ' < "$status_file" | sed 's/, $//' || true)"
  [[ -z "$copied_detail" ]] && copied_detail="No local files needed copying"
  step_done "Hydrate local files" "$copied_detail"

  run_quiet "Install dependencies" npm --prefix "$path" install
  if git -C "$path" status --short -- package-lock.json | grep -q .; then git -C "$path" restore package-lock.json || true; fi

  run_quiet "Generate API client" bash -lc "cd '$path' && npm run dev:api-client"

  step_start "Verify readiness"
  [[ -d "$path/node_modules" ]] || { step_fail "Verify readiness" "Missing node_modules"; exit 1; }
  [[ -f "$path/.nx/nxw.js" ]] || { step_fail "Verify readiness" "Missing .nx/nxw.js"; exit 1; }
  step_done "Verify readiness" "node_modules and .nx/nxw.js present"

  step_start "Copy path"
  copy_path "$path"
  step_done "Copy path" "$path"
  printf '\ncd %s\n' "$path"
}

case "$mode" in
  create) create_wt "$arg" ;;
  *) echo "Usage: $0 create <Jira URL/key>"; exit 2 ;;
esac
