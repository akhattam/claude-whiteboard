import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface ChatEntry {
  id: number;
  role: "user" | "claude";
  text: string;
  at: string;
  kind?: string;
}

export type PanelStatus = "idle" | "waiting" | { notice: string };

export function Panel({
  open,
  status,
  entries,
  onOpen,
  onClose,
  onSend,
}: {
  open: boolean;
  status: PanelStatus;
  entries: ChatEntry[];
  onOpen: () => void;
  onClose: () => void;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  const sorted = [...entries].sort((a, b) => a.id - b.id);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [sorted.length, status]);

  if (!open) {
    if (entries.length === 0 && status === "idle") return null;
    return (
      <button className="panel-reopen" onClick={onOpen}>
        🧠 Claude{entries.length > 0 ? ` (${entries.length})` : ""}
      </button>
    );
  }

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSend(text);
  };

  return (
    <aside className="claude-panel">
      <header>
        <span>🧠 Claude</span>
        <button onClick={onClose} aria-label="Collapse panel">
          ✕
        </button>
      </header>
      <div className="claude-panel-body" ref={bodyRef}>
        {sorted.length === 0 && status === "idle" && (
          <div className="panel-empty">
            Type a message below or press “✨ Ask Claude” — the conversation
            happens right here.
          </div>
        )}
        {sorted.map((entry) =>
          entry.kind === "board-look" ? (
            <div key={entry.id} className="chat-marker">
              {entry.text}
            </div>
          ) : entry.role === "user" ? (
            <div key={entry.id} className="chat-user">
              {entry.text}
            </div>
          ) : (
            <article key={entry.id} className="panel-response">
              <div className="panel-time">
                {new Date(entry.at).toLocaleString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  month: "short",
                  day: "numeric",
                })}
              </div>
              <div className="panel-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {entry.text}
                </ReactMarkdown>
              </div>
            </article>
          ),
        )}
        {status === "waiting" && (
          <div className="panel-status pulse">Claude is thinking…</div>
        )}
        {typeof status === "object" && (
          <div className="panel-status">{status.notice}</div>
        )}
      </div>
      <div className="chat-input-row">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message Claude… (Enter to send)"
          rows={2}
        />
        <button onClick={send} disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </aside>
  );
}
