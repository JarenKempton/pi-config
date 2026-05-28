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

STEPS=(
  "Read Jira ticket"
  "Resolve branch and target path"
  "Fetch origin/${BASE_BRANCH}"
  "Create git worktree"
  "Hydrate local files"
  "Install dependencies"
  "Generate API client"
  "Verify readiness"
  "Copy path"
)
STEP_STATUS=()
for _ in "${STEPS[@]}"; do STEP_STATUS+=("pending"); done
CURRENT_OUTPUT="starting"
RENDERED=0
# Header + current line + blank separator + one line per step.
# Keep this exact; if it is too high/low, old checklist rows remain on screen.
BLOCK_LINES=$(( ${#STEPS[@]} + 3 ))
status_file="$(mktemp -t salesai-worktree-status.XXXXXX)"
trap 'rm -f "$status_file"' EXIT

if [[ -t 1 ]]; then
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'; CLEAR_LINE=$'\033[2K'
else
  GREEN=""; YELLOW=""; RED=""; DIM=""; BOLD=""; RESET=""; CLEAR_LINE=""
fi

truncate_line() {
  local text="$1" width
  width="$(tput cols 2>/dev/null || echo 100)"
  # Pi's embedded terminal can wrap a little before tput's reported width.
  # Leave a large safety margin so the Current line is always one physical row.
  width=$(( width > 50 ? width - 20 : width - 4 ))
  text="$(echo "$text" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g')"
  if (( ${#text} > width )); then
    printf '%s…' "${text:0:$((width-1))}"
  else
    printf '%s' "$text"
  fi
}

render() {
  if [[ -t 1 && "$RENDERED" = "1" ]]; then
    printf '\033[%dA' "$BLOCK_LINES"
  fi

  printf '%s%sSalesAI worktree setup%s\n' "$CLEAR_LINE" "$BOLD" "$RESET"
  printf '%s%sCurrent:%s %s\n' "$CLEAR_LINE" "$DIM" "$RESET" "$(truncate_line "$CURRENT_OUTPUT")"
  printf '%s\n' "$CLEAR_LINE"

  local i status label bullet color
  for i in "${!STEPS[@]}"; do
    status="${STEP_STATUS[$i]}"
    label="${STEPS[$i]}"
    case "$status" in
      done) bullet="●"; color="$GREEN" ;;
      active) bullet="●"; color="$YELLOW" ;;
      failed) bullet="●"; color="$RED" ;;
      *) bullet="○"; color="$DIM" ;;
    esac
    printf '%s  %s%s %s%s\n' "$CLEAR_LINE" "$color" "$bullet" "$label" "$RESET"
  done
  RENDERED=1
}

activate_step() { STEP_STATUS[$1]="active"; CURRENT_OUTPUT="$2"; render; }
complete_step() { STEP_STATUS[$1]="done"; CURRENT_OUTPUT="$2"; render; }
fail_step() { STEP_STATUS[$1]="failed"; CURRENT_OUTPUT="$2"; render; }
last_output_line() { grep -v '^$' "$status_file" | tail -1 | cut -c1-220 || true; }

run_quiet() {
  local index="$1" label="$2"; shift 2
  activate_step "$index" "$label: $*"
  : > "$status_file"
  ("$@" >"$status_file" 2>&1) &
  local pid=$! previous="" last=""
  while kill -0 "$pid" 2>/dev/null; do
    last="$(last_output_line)"
    if [[ -n "$last" && "$last" != "$previous" ]]; then
      previous="$last"
      CURRENT_OUTPUT="$label: $last"
      render
    fi
    sleep 0.25
  done
  if wait "$pid"; then
    last="$(last_output_line)"
    complete_step "$index" "${last:-$label complete}"
  else
    last="$(last_output_line)"
    fail_step "$index" "${last:-$label failed}"
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

  CURRENT_OUTPUT="Preparing $key"
  render

  activate_step 0 "Reading $key from Jira"
  summary="$(jira_summary "$key")"
  issue_type="$(jira_type "$key")"
  [[ -z "$summary" ]] && summary="worktree"
  complete_step 0 "$key — $summary"

  activate_step 1 "Resolving branch and target path"
  branch="$(branch_type_for "$issue_type $summary")/$key-$(slugify "$summary")"
  path="$WORKTREES_DIR/$key"
  complete_step 1 "$branch → $path"

  existing="$(git worktree list --porcelain | awk -v p="$path" 'BEGIN{found=0} /^worktree /{found=($0=="worktree " p)} found && /^branch /{print p; exit}')"
  if [[ -n "$existing" || -d "$path/.git" || -f "$path/.git" ]]; then
    for i in 2 3 4 5 6 7; do STEP_STATUS[$i]="done"; done
    complete_step 8 "Existing worktree found: $path"
    copy_path "$path"
    printf '\ncd %s\n' "$path"
    return 0
  fi

  mkdir -p "$WORKTREES_DIR"
  run_quiet 2 "Fetching origin/${BASE_BRANCH}" git -C "$main" fetch origin "$BASE_BRANCH" --prune

  if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
    run_quiet 3 "Creating git worktree" git -C "$main" worktree add "$path" "$branch"
  elif git -C "$main" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    run_quiet 3 "Creating git worktree" git -C "$main" worktree add -b "$branch" "$path" "origin/$branch"
  else
    run_quiet 3 "Creating git worktree" git -C "$main" worktree add -b "$branch" "$path" "origin/${BASE_BRANCH}"
    git -C "$path" branch --unset-upstream 2>/dev/null || true
  fi

  activate_step 4 "Copying local ignored files"
  copy_local_files "$main" "$path" >"$status_file" 2>&1 || true
  copied_detail="$(tr '\n' ', ' < "$status_file" | sed 's/, $//' || true)"
  [[ -z "$copied_detail" ]] && copied_detail="No local files needed copying"
  complete_step 4 "$copied_detail"

  run_quiet 5 "Installing dependencies" npm --prefix "$path" install
  if git -C "$path" status --short -- package-lock.json | grep -q .; then git -C "$path" restore package-lock.json || true; fi

  run_quiet 6 "Generating API client" bash -lc "cd '$path' && npm run dev:api-client"

  activate_step 7 "Checking node_modules and Nx wrapper"
  [[ -d "$path/node_modules" ]] || { fail_step 7 "Missing node_modules"; exit 1; }
  [[ -f "$path/.nx/nxw.js" ]] || { fail_step 7 "Missing .nx/nxw.js"; exit 1; }
  complete_step 7 "node_modules and .nx/nxw.js present"

  activate_step 8 "Copying path to clipboard"
  copy_path "$path"
  complete_step 8 "Ready: $path"
  printf '\ncd %s\n' "$path"
}

case "$mode" in
  create) create_wt "$arg" ;;
  *) echo "Usage: $0 create <Jira URL/key>"; exit 2 ;;
esac
