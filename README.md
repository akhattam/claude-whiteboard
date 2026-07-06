# Claude Whiteboard 🖊️

A local whiteboard that your Claude Code session can **see, discuss, and draw on**.

I brainstorm with Claude Code a lot, and whenever ideas got visual I'd end up photographing a physical whiteboard, AirDropping it to my laptop, and uploading it to Claude. So I built the whiteboard into the loop instead: say *"open the whiteboard"* in Claude Code, sketch in your browser, and Claude reads the board, chats with you about it right on the page, and drops sticky-note feedback next to your sketches — live.

<!-- demo -->
![demo](docs/demo.gif)

## What it does

- **"open the whiteboard"** in Claude Code → an [Excalidraw](https://excalidraw.com) canvas opens in your browser. Shapes, arrows, freehand, text — and your board persists across sessions.
- **✨ Ask Claude button** on the board snapshots your sketch and wakes your Claude Code session. The full response appears in a side panel on the board — no window switching.
- **Chat panel** — have a threaded conversation with Claude next to your canvas. Same session as your terminal, so context carries over.
- **Claude draws back** — sticky-note callouts and arrows land next to the relevant parts of your sketch (in orange, so you always know whose marks are whose). Undo them with Cmd+Z like anything else.
- **🗑 one-click clear** (confirm-guarded, undoable) alongside Excalidraw's regular eraser.

## Requirements

- macOS (uses `open` and `lsof`; Linux works with small tweaks to `bin/whiteboard`)
- [Claude Code](https://claude.com/claude-code)
- Node 18+

## Install

```bash
git clone https://github.com/akhattam/claude-whiteboard.git
cd claude-whiteboard
./install.sh
```

The installer builds the app and registers a `whiteboard` skill with Claude Code (`~/.claude/skills/whiteboard/`). Restart Claude Code, then say **"open the whiteboard"**.

## Usage

| Say / do | What happens |
|---|---|
| "open the whiteboard" (in Claude Code) | server starts, board opens, Claude starts listening |
| draw, then press **✨ Ask Claude** | Claude reads the board, replies in the side panel + stickies on canvas |
| type in the chat panel | threaded conversation about whatever's on the board |
| "look at the board" (in the terminal) | works from the CLI side too |
| "add a login flow to the board" | Claude sketches elements onto your canvas |
| **🗑** | clears the board (Cmd+Z undoes) |

Manual controls: `bin/whiteboard [start|stop|status]`.

## How it works

```
Browser (Excalidraw, React 19, Vite build)
   │  onChange → debounce 1.5s → exportToBlob PNG + serializeAsJSON
   ▼  POST /snapshot                        ▲  SSE /events (draws, chat)
Local server (server/server.mjs — zero-dep node:http, port 3737)
   │  atomic writes                         ▲  POST /draw, /respond
   ▼                                        │
~/.claude-whiteboard/                     Claude Code session
   board.png          ← Claude reads this (image)
   board.excalidraw   ← scene JSON (exact labels/positions; board persists)
   meta.json          ← { updatedAt, elementCount, empty }
   chat.json          ← conversation transcript
```

The interesting part is the wake mechanism: the skill has Claude run `bin/whiteboard await-ask` as a background task, which long-polls the server. Pressing ✨ Ask Claude (or sending a chat message) completes that task, which wakes the Claude Code session — it reads the fresh snapshot, posts its reply back to the panel, drops stickies via the draw endpoint, and re-arms the listener. Asks are delivered exactly once, messages sent while Claude is busy queue up, and presses with no session listening get an honest "no one's listening" notice instead of silence.

Everything is local: a zero-dependency Node server on `localhost:3737`, files in `~/.claude-whiteboard/`. Nothing leaves your machine.

## Uninstall

```bash
bin/whiteboard stop
rm -rf ~/.claude/skills/whiteboard ~/.claude-whiteboard
# then delete this repo folder
```

## Notes

- Built with Claude Code (Fable 5) over a weekend — v1 was "Claude can see my board", and it grew a chat panel, live drawing, and the wake-up button from there.
- Port 3737 by default; override with `WHITEBOARD_PORT` (set it for both the server and `bin/whiteboard`).
- Excalidraw loads its fonts from a CDN; see `index.html` if you need fully-offline.
- Keep the board open in one tab — tabs don't sync with each other.

MIT licensed. PRs and ideas welcome, but this is a for-fun project — expect casual maintenance.
