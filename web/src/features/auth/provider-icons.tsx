/**
 * Minimalist brand marks for the external-auth providers. Kept as small inline
 * SVGs (no extra dependency) so the sign-in / register buttons carry each
 * provider's recognizable icon.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function GoogleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden {...props}>
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.86-.08-1.5-.24-2.16H12v3.92h6.6c-.13 1.02-.85 2.56-2.44 3.6l3.74 2.9c2.24-2.07 3.62-5.12 3.62-8.26z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.78-2.93c-1.02.7-2.4 1.2-4.16 1.2-3.18 0-5.88-2.15-6.84-5.05l-3.9 3.01C3.24 21.3 7.3 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.16 14.32A7.2 7.2 0 0 1 4.77 12c0-.8.14-1.58.38-2.32L1.25 6.67A11.98 11.98 0 0 0 0 12c0 1.93.46 3.76 1.25 5.33z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3 .77 3.68 1.4l2.7-2.62C16.96 1.99 14.24.9 12 .9 7.3.9 3.24 3.6 1.25 7.67l3.9 3.01C6.12 7.9 8.82 4.75 12 4.75z"
      />
    </svg>
  );
}

export function YandexIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden {...props}>
      <circle cx="12" cy="12" r="12" fill="#FC3F1D" />
      <path
        fill="#fff"
        d="M13.3 6.4h-1.2c-1.5 0-2.9 1.1-2.9 3.2 0 1.3.6 2.2 1.7 2.9l-2 3.9h1.6l1.8-3.6h.9v3.6h1.4V6.4zm-.6 5.1h-.5c-.9 0-1.5-.5-1.5-1.7 0-1.3.7-1.8 1.5-1.8h.5z"
      />
    </svg>
  );
}

export function MailruIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden {...props}>
      <circle cx="12" cy="12" r="12" fill="#005FF9" />
      <path
        fill="#fff"
        d="M12 5.6a6.4 6.4 0 1 0 3.5 11.76.9.9 0 1 0-.98-1.5A4.6 4.6 0 1 1 16.6 12v.5a.86.86 0 0 1-1.72 0V12a2.88 2.88 0 1 0-.84 2.03 2.58 2.58 0 0 0 4.36-1.53c.02-.16.04-.33.04-.5A6.4 6.4 0 0 0 12 5.6zm0 8.32A1.92 1.92 0 1 1 12 10.1a1.92 1.92 0 0 1 0 3.84z"
      />
    </svg>
  );
}

export function TelegramIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden {...props}>
      <circle cx="12" cy="12" r="12" fill="#2AABEE" />
      <path
        fill="#fff"
        d="M5.5 11.8 16.4 7.6c.5-.18.94.12.78.88l-1.86 8.76c-.13.6-.5.75-1 .47l-2.77-2.04-1.34 1.29c-.15.15-.27.27-.55.27l.2-2.83 5.15-4.65c.22-.2-.05-.31-.35-.11l-6.36 4-2.74-.86c-.6-.19-.6-.6.13-.9z"
      />
    </svg>
  );
}

/** Maps a provider code to its brand icon. */
export function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  switch (provider) {
    case "GOOGLE":
      return <GoogleIcon className={className} />;
    case "YANDEX":
      return <YandexIcon className={className} />;
    case "MAILRU":
      return <MailruIcon className={className} />;
    case "TELEGRAM":
      return <TelegramIcon className={className} />;
    default:
      return null;
  }
}
