import { useCallback, useEffect, useState } from "react";
import { Excalidraw, CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { markHadElements, scheduleSnapshot, snapshotNow } from "./snapshot";
import { connectLive } from "./live";
import { Panel, type ChatEntry, type PanelStatus } from "./Panel";

const WAITING_TIMEOUT_MS = 120000;

const NOT_LISTENING_NOTICE =
  'No Claude session is listening. In Claude Code, say "open the whiteboard" to reconnect — your message is saved and will be answered then.';

async function loadScene() {
  try {
    const res = await fetch("/scene");
    if (!res.ok || res.status === 204) return null;
    const data = await res.json();
    if (data.elements?.length) markHadElements();
    return {
      elements: data.elements ?? [],
      // collaborators must be a Map, and saved appState may carry a stale
      // plain-object version that crashes restore
      appState: { ...(data.appState ?? {}), collaborators: new Map() },
      files: data.files ?? undefined,
    };
  } catch {
    return null;
  }
}

export default function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initialData] = useState(() => loadScene());
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [focusToken, setFocusToken] = useState(0);

  const addEntry = useCallback((entry: ChatEntry) => {
    setEntries((prev) =>
      prev.some((e) => e.id === entry.id) ? prev : [...prev, entry],
    );
    // Only Claude's reply ends the wait — the SSE echo of the user's own
    // message must not clear "Claude is thinking…"
    if (entry.role === "claude") {
      setStatus("idle");
      setPanelOpen(true);
    }
  }, []);

  const clearEntries = useCallback(() => setEntries([]), []);

  useEffect(() => {
    if (!api) return;
    return connectLive(api, addEntry, clearEntries);
  }, [api, addEntry, clearEntries]);

  const clearChat = useCallback(async () => {
    if (!window.confirm("Clear the whole conversation? (The canvas stays.)"))
      return;
    try {
      const res = await fetch("/chat/clear", { method: "POST" });
      if (res.ok) {
        setEntries([]);
        setStatus("idle");
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetch("/chat")
      .then((res) => (res.ok ? res.json() : []))
      .then((list: ChatEntry[]) => {
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...list.filter((e) => !seen.has(e.id)), ...prev];
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (status !== "waiting") return;
    const timeout = window.setTimeout(() => {
      setStatus({
        notice:
          "Still waiting — Claude may be busy or no longer listening. Check your Claude Code session.",
      });
    }, WAITING_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [status]);

  // Opens the chat and focuses the input — Claude is only woken once the
  // user actually sends a question, not by the button press itself
  const askClaude = useCallback(() => {
    setPanelOpen(true);
    setFocusToken((t) => t + 1);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!api) return;
      setStatus("waiting");
      try {
        // Messages are usually about the board — make sure Claude sees it fresh
        await snapshotNow(api);
      } catch {}
      try {
        const res = await fetch("/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const data = await res.json();
        if (data.entry) addEntry(data.entry);
        if (data.listening === false) {
          setStatus({ notice: NOT_LISTENING_NOTICE });
        }
      } catch {
        setStatus({ notice: "Could not reach the whiteboard server." });
      }
    },
    [api, addEntry],
  );

  const clearBoard = useCallback(() => {
    if (!api) return;
    const elements = api.getSceneElements();
    if (elements.length === 0) return;
    if (!window.confirm("Clear the entire board? (Cmd+Z will undo)")) return;
    // Mirrors Excalidraw's own clear-canvas action: soft-delete keeps undo
    api.updateScene({
      elements: elements.map((el) => ({ ...el, isDeleted: true })),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    scheduleSnapshot(api);
  }, [api]);

  return (
    <div style={{ display: "flex", height: "100vh", width: "100%" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={initialData}
          onChange={() => {
            if (api) scheduleSnapshot(api);
          }}
          renderTopRightUI={() => (
            <>
              <button
                className="clear-board-btn"
                onClick={clearBoard}
                disabled={!api}
                title="Erase the entire board (undo with Cmd+Z)"
              >
                🗑
              </button>
              <button
                className="ask-claude-btn"
                onClick={askClaude}
                disabled={!api}
                title="Open the chat and ask Claude a question"
              >
                ✨ Ask Claude
              </button>
            </>
          )}
        />
      </div>
      <Panel
        open={panelOpen}
        status={status}
        focusToken={focusToken}
        entries={entries}
        onOpen={() => setPanelOpen(true)}
        onClose={() => setPanelOpen(false)}
        onSend={sendMessage}
        onClearChat={clearChat}
      />
    </div>
  );
}
