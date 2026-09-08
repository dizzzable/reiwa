/**
 * Local QR code (no third-party pixel). Uses the `qrcode` package already in
 * reiwa/web dependencies.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function LocalQr({
  url,
  label,
  size = 96,
  captioned = true,
}: {
  url: string;
  label: string;
  size?: number;
  /**
   * The caption under the code. On by default because that is what the two
   * callers that came first need; off where the code already sits under a
   * heading that says the same thing, and repeating it there reads as a
   * mistake. `label` stays the alt text either way — a code with no accessible
   * name is a picture nobody can identify.
   */
  captioned?: boolean;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, {
      width: size,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((u) => {
        if (!cancelled) setDataUrl(u);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url, size]);

  if (!dataUrl) {
    return (
      <div className="flex flex-col items-center gap-1">
        <div
          className="rounded-md bg-white/10"
          style={{ width: size, height: size }}
          aria-hidden
        />
        {captioned && <span className="text-[9px] text-muted-foreground">{label}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <img src={dataUrl} alt={label} width={size} height={size} className="rounded-md bg-white p-1" />
      {captioned && <span className="text-[9px] text-muted-foreground">{label}</span>}
    </div>
  );
}
