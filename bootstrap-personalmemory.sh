#!/bin/sh
set -eu

DEFAULT_REPOSITORY="https://github.com/liuzhenquan291/PersonalMemory.git"
DEFAULT_VERSION="personalmemory-v0.1.1"

repository=$DEFAULT_REPOSITORY
version=$DEFAULT_VERSION
install_directory=
agent_codex=false
agent_claude=false
agent_all=false
agent_none=false

usage() {
  cat <<'EOF'
Usage: bootstrap-personalmemory.sh [options]

Download a fixed PersonalMemory Git tag and run its managed installer.

Options:
  --repo <url>           Git repository URL
  --version <tag>        Exact Git tag to install
  --install-dir <path>   Absolute source installation directory
  --agent <name>         Repeatable: codex, claude-code, all, or none
  -h, --help             Show this help

When --agent is omitted, the product installer auto-detects supported Agents.
EOF
}

require_value() {
  option=$1
  value=${2-}
  if [ -z "$value" ]; then
    echo "$option requires a value." >&2
    exit 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      require_value "$1" "${2-}"
      repository=$2
      shift 2
      ;;
    --version)
      require_value "$1" "${2-}"
      version=$2
      shift 2
      ;;
    --install-dir)
      require_value "$1" "${2-}"
      install_directory=$2
      shift 2
      ;;
    --agent)
      require_value "$1" "${2-}"
      case "$2" in
        codex) agent_codex=true ;;
        claude-code) agent_claude=true ;;
        all) agent_all=true ;;
        none) agent_none=true ;;
        *)
          echo "Unsupported Agent: $2" >&2
          exit 2
          ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$repository" in
  ""|-*)
    echo "--repo must be a non-empty Git URL or path." >&2
    exit 2
    ;;
esac

if ! printf '%s\n' "$version" | grep -Eq '^personalmemory-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "--version must be a PersonalMemory release tag such as personalmemory-v0.1.1." >&2
  exit 2
fi

if $agent_all && { $agent_none || $agent_codex || $agent_claude; }; then
  echo "--agent all cannot be combined with another Agent." >&2
  exit 2
fi
if $agent_none && { $agent_all || $agent_codex || $agent_claude; }; then
  echo "--agent none cannot be combined with another Agent." >&2
  exit 2
fi

for command_name in git node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "PersonalMemory bootstrap requires $command_name." >&2
    exit 1
  fi
done

if [ -z "$install_directory" ]; then
  if [ -z "${HOME-}" ]; then
    echo "HOME is required unless --install-dir is provided." >&2
    exit 1
  fi
  install_directory="${HOME}/.local/share/personalmemory-installations/${version}"
fi
case "$install_directory" in
  /*) ;;
  *)
    echo "--install-dir must be an absolute path." >&2
    exit 2
    ;;
esac

if ! git ls-remote --exit-code --refs "$repository" "refs/tags/$version" >/dev/null 2>&1; then
  echo "Git tag $version was not found in $repository." >&2
  exit 1
fi

umask 077
if [ -e "$install_directory" ] || [ -L "$install_directory" ]; then
  if [ -L "$install_directory" ] || [ ! -d "$install_directory/.git" ]; then
    echo "Install directory exists but is not a regular Git checkout: $install_directory" >&2
    exit 1
  fi
  if [ -n "$(git -C "$install_directory" status --porcelain)" ]; then
    echo "Existing installation checkout has local changes: $install_directory" >&2
    exit 1
  fi
  existing_repository=$(git -C "$install_directory" remote get-url origin)
  if [ "$existing_repository" != "$repository" ]; then
    echo "Existing installation checkout uses a different repository." >&2
    exit 1
  fi
  if ! git -C "$install_directory" show-ref --verify --quiet "refs/tags/$version"; then
    echo "Existing installation checkout does not contain tag $version." >&2
    exit 1
  fi
  expected_commit=$(git -C "$install_directory" rev-parse "refs/tags/$version^{}")
  current_commit=$(git -C "$install_directory" rev-parse HEAD)
  if [ "$current_commit" != "$expected_commit" ]; then
    echo "Existing installation checkout is not at tag $version." >&2
    exit 1
  fi
else
  parent_directory=$(dirname "$install_directory")
  mkdir -p "$parent_directory"
  git clone --branch "$version" --depth 1 --single-branch -- \
    "$repository" "$install_directory"
fi

installer="$install_directory/install-personalmemory.sh"
if [ -L "$installer" ] || [ ! -f "$installer" ] || [ ! -x "$installer" ]; then
  echo "The selected release does not contain an executable product installer." >&2
  exit 1
fi

set --
if $agent_all; then
  set -- --agent all
elif $agent_none; then
  set -- --agent none
else
  if $agent_codex; then set -- "$@" --agent codex; fi
  if $agent_claude; then set -- "$@" --agent claude-code; fi
fi

echo "Installing PersonalMemory $version from $repository"
echo "Source: $install_directory"
(
  cd "$install_directory"
  ./install-personalmemory.sh "$@"
)
