/** Runtime helpers shared by the subscription-card effect layer and tests. */

export function resolveCardEffectOverlayOpacity(opacity: number): number {
  return Math.min(Math.max(opacity, 0.05), 1);
}

/**
 * Observe canvases created by a lazy effect and report both explicit WebGL
 * failures and silent renderer initialisation failures. Several GPU libraries
 * only log when context creation fails, which otherwise leaves a blank layer.
 */
export function observeCardEffectCanvases(
  root: HTMLElement,
  onFailure: () => void,
  timeoutMs = 1_200,
): () => void {
  const listeners = new Map<HTMLCanvasElement, () => void>();
  let sawCanvas = false;
  let reportedFailure = false;

  const reportFailureOnce = () => {
    if (reportedFailure) return;
    reportedFailure = true;
    onFailure();
  };

  const observeCanvas = () => {
    root.querySelectorAll("canvas").forEach((canvas) => {
      sawCanvas = true;
      if (listeners.has(canvas)) return;
      canvas.addEventListener("webglcontextlost", reportFailureOnce);
      canvas.addEventListener("webglcontextcreationerror", reportFailureOnce);
      listeners.set(canvas, () => {
        canvas.removeEventListener("webglcontextlost", reportFailureOnce);
        canvas.removeEventListener(
          "webglcontextcreationerror",
          reportFailureOnce,
        );
      });
    });
  };

  const observer = new MutationObserver(observeCanvas);
  observer.observe(root, { childList: true, subtree: true });
  observeCanvas();
  const readinessTimer = window.setTimeout(() => {
    if (!sawCanvas) reportFailureOnce();
  }, timeoutMs);

  return () => {
    window.clearTimeout(readinessTimer);
    observer.disconnect();
    listeners.forEach((remove) => remove());
  };
}
