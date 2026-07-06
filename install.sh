#!/bin/bash
# Claude Whiteboard installer: builds the app and registers the Claude Code skill.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${CLAUDE_SKILL_DIR:-$HOME/.claude/skills/whiteboard}"

echo "Claude Whiteboard installer"
echo "Project: $ROOT"
echo

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Error: node and npm are required (Node 18+). Install from https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node 18+ required (found $(node --version))." >&2
  exit 1
fi
if [ "$(uname)" != "Darwin" ]; then
  echo "Warning: built for macOS ('open' and 'lsof' are used). On Linux you'll need to open http://localhost:3737 manually and adjust bin/whiteboard." >&2
fi

echo "==> Installing dependencies and building..."
(cd "$ROOT" && npm install && npm run build)

chmod +x "$ROOT/bin/whiteboard" "$ROOT/install.sh"

echo "==> Registering the Claude Code skill at $SKILL_DIR"
mkdir -p "$SKILL_DIR"
sed "s|{{PROJECT_ROOT}}|$ROOT|g" "$ROOT/skill/SKILL.md.template" > "$SKILL_DIR/SKILL.md"

echo
echo "Done! Next steps:"
echo "  1. Restart Claude Code (so it picks up the new skill)."
echo "  2. Say: \"open the whiteboard\""
echo "  3. Draw something, then press ✨ Ask Claude on the board — or just chat in the side panel."
echo
echo "Manual controls: $ROOT/bin/whiteboard [start|stop|status]"
