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
}: {
  url: string;
  label: string;
  size?: number;
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
        <span className="text-[9px] text-muted-foreground">{label}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <img src={dataUrl} alt={label} width={size} height={size} className="rounded-md bg-white p-1" />
      <span className="text-[9px] text-muted-foreground">{label}</span>
    </div>
  );
}
