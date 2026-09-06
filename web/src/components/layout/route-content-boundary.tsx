import { Suspense, type PropsWithChildren } from "react";
import i18n from "i18next"

function RouteContentFallback() {
  return (
    <div
      role="status"
      aria-label={i18n.t("common.loadingPage")}
      data-route-content-loading
      className="flex min-h-32 items-center justify-center"
    >
      <div className="size-6 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
    </div>
  );
}

/** Keeps the authenticated shell and navigation mounted during a cold chunk load. */
export function RouteContentBoundary({ children }: PropsWithChildren) {
  return <Suspense fallback={<RouteContentFallback />}>{children}</Suspense>;
}
