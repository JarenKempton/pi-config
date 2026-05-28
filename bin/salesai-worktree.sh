#!/usr/bin/env bash
set -euo pipefail

mode="${1:-menu}"; shift || true
arg="${*:-}"

BASE_BRANCH="${PI_WORKTREE_BASE_BRANCH:-main}"
HOME_DIR="${HOME:-/Users/jaren}"
SALESAI_MAIN="$HOME_DIR/Documents/programming/salesai"
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
jira_summary() {
  jira_field_text "$1" | awk -F': ' '/^Summary:/{print substr($0, index($0,$2)); exit}'
}
jira_type() {
  jira_field_text "$1" | awk -F': ' '/^Type:/{print $2; exit}'
}
copy_path() { if have pbcopy; then printf '%s' "$1" | pbcopy; fi; }

STEPS=(
  "Read Jira ticket"
  "Resolve branch and target path"
  "Fetch origin/main"
  "Create git worktree"
  "Hydrate local files"
  "Install dependencies"
  "Generate API client"
  "Verify readiness"
  "Copy path"
)
current_step=0
current_line="Starting…"
status_file="$(mktemp -t salesai-worktree-status.XXXXXX)"
trap 'rm -f "$status_file"' EXIT

render() {
  printf '\033[2J\033[H'
  printf 'SalesAI worktree setup\n\n'
  printf '  %s\n\n' "$current_line"
  local i label mark
  for i in "${!STEPS[@]}"; do
    label="${STEPS[$i]}"
    if (( i < current_step )); then mark="✓"; elif (( i == current_step )); then mark="▶"; else mark="·"; fi
    printf '  %s [%d/%d] %s\n' "$mark" "$((i+1))" "${#STEPS[@]}" "$label"
  done
  printf '\n'
}

step() { current_step="$1"; current_line="$2"; render; }
run_live() {
  local label="$1"; shift
  : > "$status_file"
  current_line="$label: $*"; render
  ("$@" >"$status_file" 2>&1) &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    local last
    last="$(grep -v '^$' "$status_file" | tail -1 || true)"
    [[ -n "$last" ]] && current_line="$label: $last"
    render
    sleep 0.25
  done
  wait "$pid" || { current_line="$label failed. Last output: $(tail -20 "$status_file" | tr '\n' ' ' | cut -c1-220)"; render; echo; tail -80 "$status_file"; exit 1; }
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
  local input="${1:-}" key summary issue_type branch path main existing
  [[ -z "$input" ]] && { echo "Usage: $0 create <Jira URL/key>"; exit 2; }
  main="$(main_root)"
  key="$(extract_key "$input")"
  [[ -z "$key" ]] && { echo "No Jira key found in: $input"; exit 2; }

  step 0 "Reading $key from Jira…"
  summary="$(jira_summary "$key")"
  issue_type="$(jira_type "$key")"
  [[ -z "$summary" ]] && summary="worktree"

  step 1 "Resolved $key — $summary"
  branch="$(branch_type_for "$issue_type $summary")/$key-$(slugify "$summary")"
  path="$WORKTREES_DIR/$key"
  existing="$(git worktree list --porcelain | awk -v p="$path" 'BEGIN{found=0} /^worktree /{found=($0=="worktree " p)} found && /^branch /{print p; exit}')"
  if [[ -n "$existing" || -d "$path/.git" || -f "$path/.git" ]]; then
    current_step=8; current_line="Existing worktree found: $path"; render
    copy_path "$path"
    echo "cd $path"
    return 0
  fi

  mkdir -p "$WORKTREES_DIR"
  step 2 "Fetching origin/$BASE_BRANCH…"
  run_live "git fetch" git -C "$main" fetch origin "$BASE_BRANCH" --prune

  step 3 "Creating $branch at $path…"
  if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
    run_live "git worktree add" git -C "$main" worktree add "$path" "$branch"
  elif git -C "$main" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    run_live "git worktree add" git -C "$main" worktree add -b "$branch" "$path" "origin/$branch"
  else
    run_live "git worktree add" git -C "$main" worktree add -b "$branch" "$path" "origin/$BASE_BRANCH"
    git -C "$path" branch --unset-upstream 2>/dev/null || true
  fi

  step 4 "Copying local ignored config/env files…"
  copy_local_files "$main" "$path" >"$status_file" 2>&1 || true
  current_line="Hydrated: $(tr '\n' ', ' < "$status_file" | sed 's/, $//' || true)"
  [[ "$current_line" = "Hydrated: " ]] && current_line="No local files needed copying"
  render

  step 5 "Running npm install…"
  run_live "npm install" npm --prefix "$path" install
  if git -C "$path" status --short -- package-lock.json | grep -q .; then git -C "$path" restore package-lock.json || true; fi

  step 6 "Running npm run dev:api-client…"
  run_live "api client" bash -lc "cd '$path' && npm run dev:api-client"

  step 7 "Checking node_modules and Nx wrapper…"
  [[ -d "$path/node_modules" ]] || { echo "Missing node_modules"; exit 1; }
  [[ -f "$path/.nx/nxw.js" ]] || { echo "Missing .nx/nxw.js"; exit 1; }
  render

  step 8 "Copying path to clipboard…"
  copy_path "$path"
  current_line="Ready: $path"
  render
  printf 'cd %s\n' "$path"
}

case "$mode" in
  create) create_wt "$arg" ;;
  *) echo "Usage: $0 create <Jira URL/key>"; exit 2 ;;
esac
