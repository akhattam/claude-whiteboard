import { exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const DEBOUNCE_MS = 1500;
// Cap the longest PNG edge so huge boards don't exceed browser canvas limits
const MAX_EDGE_PX = 4000;

let timer: number | undefined;
let lastSent = "";
let inFlight: Promise<void> | null = null;

// Empty-board snapshots (clear button, select-all-delete) are only allowed
// once this tab has actually seen content — a tab whose /scene fetch failed
// mounts empty and must never overwrite the saved board with emptiness.
let hadElements = false;

export function markHadElements() {
  hadElements = true;
}

export function scheduleSnapshot(api: ExcalidrawImperativeAPI) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void runSnapshot(api), DEBOUNCE_MS);
}

// For the Ask Claude button: guarantees a fresh export has completed (not
// just joined an already-running send that predates the latest strokes)
export async function snapshotNow(api: ExcalidrawImperativeAPI): Promise<void> {
  window.clearTimeout(timer);
  if (inFlight) await inFlight.catch(() => {});
  return runSnapshot(api);
}

function runSnapshot(api: ExcalidrawImperativeAPI): Promise<void> {
  if (!inFlight) {
    inFlight = snapshot(api).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function snapshot(api: ExcalidrawImperativeAPI) {
  const elements = api.getSceneElements();
  const isEmpty = !elements || elements.length === 0;
  if (isEmpty && !hadElements) return;
  if (!isEmpty) hadElements = true;

  const appState = api.getAppState();
  const files = api.getFiles();
  const scene = serializeAsJSON(elements, appState, files, "local");
  if (scene === lastSent) return;

  try {
    // exportToBlob fails on empty scenes — a cleared board saves a blank white
    // PNG so Claude never describes content that no longer exists
    const blob = isEmpty
      ? await blankPngBlob()
      : await exportToBlob({
          elements,
          files,
          mimeType: "image/png",
          appState: {
            ...appState,
            exportBackground: true,
            viewBackgroundColor: "#ffffff",
            exportWithDarkMode: false,
          },
          exportPadding: 20,
          getDimensions: (width: number, height: number) => {
            const scale = Math.min(2, MAX_EDGE_PX / Math.max(width, height, 1));
            return { width: width * scale, height: height * scale, scale };
          },
        });
    const png = await blobToBase64(blob);
    const res = await fetch("/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        png,
        scene,
        elementCount: elements.length,
        empty: isEmpty,
      }),
    });
    if (res.ok) lastSent = scene;
  } catch (err) {
    // Fine to drop: the next edit reschedules a snapshot
    console.error("whiteboard snapshot failed", err);
  }
}

function blankPngBlob(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 500;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("no 2d context"));
      return;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
