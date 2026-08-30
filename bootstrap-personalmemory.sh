#!/bin/sh
set -eu

DEFAULT_REPOSITORY="https://github.com/liuzhenquan291/PersonalMemory.git"
DEFAULT_VERSION="personalmemory-v0.1.3"

repository=$DEFAULT_REPOSITORY
version=$DEFAULT_VERSION
install_directory=
agent_codex=false
agent_claude=false
agent_all=false
agent_none=false
upstream_port=17173
gateway_port=17175
web_port=17177

usage() {
  cat <<'EOF'
Usage: bootstrap-personalmemory.sh [options]

Download a fixed PersonalMemory Git tag and run its managed installer.

Options:
  --repo <url>           Git repository URL
  --version <tag>        Exact Git tag to install
  --install-dir <path>   Absolute source installation directory
  --agent <name>         Repeatable: codex, claude-code, all, or none
  --upstream-port <port> Upstream Gateway port (default: 17173)
  --gateway-port <port>  PersonalMemory Gateway port (default: 17175)
  --web-port <port>      Web management port (default: 17177)
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
    --upstream-port)
      require_value "$1" "${2-}"
      upstream_port=$2
      shift 2
      ;;
    --gateway-port)
      require_value "$1" "${2-}"
      gateway_port=$2
      shift 2
      ;;
    --web-port)
      require_value "$1" "${2-}"
      web_port=$2
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
  echo "--version must be a PersonalMemory release tag such as personalmemory-v0.1.3." >&2
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

for port_specification in \
  "--upstream-port:$upstream_port" \
  "--gateway-port:$gateway_port" \
  "--web-port:$web_port"
do
  port_option=${port_specification%%:*}
  port_value=${port_specification#*:}
  if ! printf '%s\n' "$port_value" | grep -Eq '^[0-9]+$' ||
    [ "$port_value" -lt 1 ] || [ "$port_value" -gt 65535 ]; then
    echo "$port_option must be an integer between 1 and 65535." >&2
    exit 2
  fi
done
if [ "$upstream_port" = "$gateway_port" ] ||
  [ "$upstream_port" = "$web_port" ] ||
  [ "$gateway_port" = "$web_port" ]; then
  echo "PersonalMemory service ports must be distinct." >&2
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

remote_refs=$(git ls-remote --tags "$repository" "refs/tags/$version" "refs/tags/$version^{}" 2>/dev/null) || {
  echo "Git tag $version was not found in $repository." >&2
  exit 1
}
tag_ref="refs/tags/$version"
peeled_ref="refs/tags/$version^{}"
remote_tag_object=$(printf '%s\n' "$remote_refs" | awk -v ref="$tag_ref" '$2 == ref { print $1 }')
remote_commit=$(printf '%s\n' "$remote_refs" | awk -v ref="$peeled_ref" '$2 == ref { print $1 }')
if [ -z "$remote_commit" ]; then remote_commit=$remote_tag_object; fi
if ! printf '%s\n' "$remote_commit" | grep -Eq '^[a-f0-9]{40,64}$'; then
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
  if [ "$current_commit" != "$expected_commit" ] || [ "$current_commit" != "$remote_commit" ]; then
    echo "Existing installation checkout does not match remote tag $version." >&2
    exit 1
  fi
else
  parent_directory=$(dirname "$install_directory")
  mkdir -p "$parent_directory"
  git clone --branch "$version" --depth 1 --single-branch -- \
    "$repository" "$install_directory"
fi

current_commit=$(git -C "$install_directory" rev-parse HEAD)
if [ "$current_commit" != "$remote_commit" ]; then
  echo "Cloned checkout does not match remote tag $version." >&2
  exit 1
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
set -- "$@" \
  --upstream-port "$upstream_port" \
  --gateway-port "$gateway_port" \
  --web-port "$web_port"

echo "Installing PersonalMemory $version from $repository"
echo "Source: $install_directory"
(
  cd "$install_directory"
  ./install-personalmemory.sh "$@"
)
