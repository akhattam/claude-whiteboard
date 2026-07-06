import {
  convertToExcalidrawElements,
  CaptureUpdateAction,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { scheduleSnapshot } from "./snapshot";
import type { ChatEntry } from "./Panel";

// Listens for server pushes: draws (Claude posting to /draw) are appended to
// the scene; chat entries (user messages echoed + Claude's /respond replies)
// go to the side panel. EventSource auto-reconnects on server restart.
export function connectLive(
  api: ExcalidrawImperativeAPI,
  onChat: (entry: ChatEntry) => void,
): () => void {
  const source = new EventSource("/events");
  source.addEventListener("draw", (event) => {
    try {
      const { elements } = JSON.parse((event as MessageEvent).data);
      const converted = convertToExcalidrawElements(elements);
      api.updateScene({
        elements: [...api.getSceneElements(), ...converted],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      api.scrollToContent(api.getSceneElements(), {
        fitToContent: true,
        animate: true,
      });
      scheduleSnapshot(api);
    } catch (err) {
      console.error("failed to apply draw from server", err);
    }
  });
  source.addEventListener("chat", (event) => {
    try {
      onChat(JSON.parse((event as MessageEvent).data));
    } catch (err) {
      console.error("failed to parse chat entry from server", err);
    }
  });
  return () => source.close();
}
