import { Routes, Route } from "react-router-dom";
import { lazy, Suspense } from "react";
import StealthLayout from "@/components/layout/stealth-layout";
import { useAdAttribution } from "@/hooks/use-ad-attribution";

/**@/features/auth/tma-bootstrap-page
 * Reiwa SPA — root router.
 *
 * Two distinct entry points by design:
 *  - **`/`**         Web entry. Resolves the session cookie and either
 *                    pushes the browser user to `/dashboard` or `/sign-in`.
 *  - **`/tma`**      Telegram Mini App entry. Performs the
 *                    `bootstrapTelegram(initData)` handshake against the
 *                    reiwa BFF, sets the session cookie, lands on
 *                    `/dashboard`.
 *
 * `/bootstrap` stays as a thin context router so legacy deep-links
 * (older payment-return URLs, manual operator links) still work — it
 * just inspects `Telegram.WebApp.initData` and forwards to the right
 * entry above.
 */

const ContextRouter = lazy(() => import("@/features/auth/context-router"));
const WebHomePage = lazy(() => import("@/features/auth/web-home-page"));
const TmaBootstrapPage = lazy(() => import("@/features/auth/tma-bootstrap-page"));

const LandingPage = lazy(() => import("@/features/landing/landing-page"));

const RegisterPage = lazy(() => import("@/features/auth/register-page"));
const RecoverPage = lazy(() => import("@/features/auth/recover-page"));
const SignInPage = lazy(() => import("@/features/auth/sign-in-page"));
const ChangePasswordPage = lazy(() => import("@/features/auth/change-password-page"));
const DashboardPage = lazy(() => import("@/features/dashboard/dashboard-page"));
const SubscriptionPage = lazy(
  () => import("@/features/subscription/subscription-page"),
);
const DevicesPage = lazy(
  () => import("@/features/subscription/devices-page"),
);
const PartnerPage = lazy(
  () => import("@/features/partner/partner-page"),
);
const PlansPage = lazy(() => import("@/features/plans/plans-page"));
const PurchasePage = lazy(() => import("@/features/purchase/purchase-page"));
const RenewalPage = lazy(() => import("@/features/renewal/renewal-page"));
const UpgradePage = lazy(() => import("@/features/upgrade/upgrade-page"));
const AddOnsPage = lazy(() => import("@/features/addons/addons-page"));
const PaymentReturn = lazy(
  () => import("@/features/payment/payment-return-page"),
);
const ActivityPage = lazy(() => import("@/features/activity/activity-page"));
const PromoPage = lazy(() => import("@/features/promo/promo-page"));
const ReferralsPage = lazy(() => import("@/features/referrals/referrals-page"));
const SettingsPage = lazy(() => import("@/features/settings/settings-page"));
const PrivacyPage = lazy(() => import("@/features/settings/privacy-page"));
const NotificationsSettingsPage = lazy(() => import("@/features/settings/notifications-page"));
const NotificationsFeedPage = lazy(() => import("@/features/settings/notifications-feed-page"));
const NotificationsPrefsPage = lazy(() => import("@/features/settings/notifications-settings-page"));
const TransactionsPage = lazy(() => import("@/features/settings/transactions-page"));
const FaqPage = lazy(() => import("@/features/settings/faq-page"));
const PromocodesSettingsPage = lazy(() => import("@/features/settings/promocodes-page"));
const SupportPage = lazy(() => import("@/features/support/support-page"));
const PointsExchangePage = lazy(() => import("@/features/referrals/points-exchange-page"));
const OnboardingPage = lazy(() => import("@/features/onboarding/onboarding-page"));
const ClaimPage = lazy(() => import("@/features/auth/claim-page"));
const FinishSetupPage = lazy(() => import("@/features/auth/finish-setup-page"));
const GuestSupportPage = lazy(() => import("@/features/support/guest-support-page"));

function PageLoader() {
  return (
    <div className="flex h-dvh items-center justify-center bg-(--brand-bg-primary)">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
    </div>
  );
}

export default function App() {
  useAdAttribution();
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Entry points */}
        <Route path="/" element={<WebHomePage />} />
        <Route path="/tma" element={<TmaBootstrapPage />} />
        <Route path="/bootstrap" element={<ContextRouter />} />

        {/* Public auth pages */}
        <Route path="/welcome" element={<LandingPage />} />
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/recover" element={<RecoverPage />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route path="/claim" element={<ClaimPage />} />
        <Route path="/finish-setup" element={<FinishSetupPage />} />
        <Route path="/payment-return" element={<PaymentReturn />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        {/* Public anonymous support — no login required. */}
        <Route path="/support/guest" element={<GuestSupportPage />} />

        {/* Protected shell */}
        <Route element={<StealthLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/subscription" element={<SubscriptionPage />} />
          <Route path="/subscription/devices" element={<DevicesPage />} />
          <Route path="/partner" element={<PartnerPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/purchase" element={<PurchasePage />} />
          <Route path="/renew" element={<RenewalPage />} />
          <Route path="/upgrade" element={<UpgradePage />} />
          <Route path="/addons" element={<AddOnsPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/promo" element={<PromoPage />} />
          <Route path="/referrals" element={<ReferralsPage />} />
          <Route path="/referrals/exchange" element={<PointsExchangePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/privacy" element={<PrivacyPage />} />
          <Route path="/settings/notifications" element={<NotificationsSettingsPage />} />
          <Route path="/settings/notifications/feed" element={<NotificationsFeedPage />} />
          <Route path="/settings/notifications/settings" element={<NotificationsPrefsPage />} />
          <Route path="/settings/transactions" element={<TransactionsPage />} />
          <Route path="/settings/faq" element={<FaqPage />} />
          <Route path="/settings/promocodes" element={<PromocodesSettingsPage />} />
          <Route path="/support" element={<SupportPage />} />
        </Route>

        {/* Unknown paths fall through to the web home which routes the
            user to /sign-in or /dashboard depending on cookie state. */}
        <Route path="*" element={<WebHomePage />} />
      </Routes>
    </Suspense>
  );
}
