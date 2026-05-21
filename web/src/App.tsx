import { Routes, Route, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";
import StealthLayout from "@/components/layout/stealth-layout";

const BootstrapPage = lazy(() => import("@/features/auth/bootstrap-page"));
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
const PaymentReturn = lazy(
  () => import("@/features/payment/payment-return-page"),
);
const ActivityPage = lazy(() => import("@/features/activity/activity-page"));
const PromoPage = lazy(() => import("@/features/promo/promo-page"));
const ReferralsPage = lazy(() => import("@/features/referrals/referrals-page"));
const SettingsPage = lazy(() => import("@/features/settings/settings-page"));
const PrivacyPage = lazy(() => import("@/features/settings/privacy-page"));
const NotificationsSettingsPage = lazy(() => import("@/features/settings/notifications-page"));
const TransactionsPage = lazy(() => import("@/features/settings/transactions-page"));
const FaqPage = lazy(() => import("@/features/settings/faq-page"));
const PromocodesSettingsPage = lazy(() => import("@/features/settings/promocodes-page"));
const SupportPage = lazy(() => import("@/features/support/support-page"));
const PointsExchangePage = lazy(() => import("@/features/referrals/points-exchange-page"));
const OnboardingPage = lazy(() => import("@/features/onboarding/onboarding-page"));

function PageLoader() {
  return (
    <div className="flex h-screen items-center justify-center bg-[#020202]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Bootstrap — TMA entry point */}
        <Route path="/bootstrap" element={<BootstrapPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/recover" element={<RecoverPage />} />
        <Route path="/payment-return" element={<PaymentReturn />} />
        <Route path="/onboarding" element={<OnboardingPage />} />

        {/* Protected shell */}
        <Route element={<StealthLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/subscription" element={<SubscriptionPage />} />
          <Route path="/subscription/devices" element={<DevicesPage />} />
          <Route path="/partner" element={<PartnerPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/purchase" element={<PurchasePage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/promo" element={<PromoPage />} />
          <Route path="/referrals" element={<ReferralsPage />} />
          <Route path="/referrals/exchange" element={<PointsExchangePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/privacy" element={<PrivacyPage />} />
          <Route path="/settings/notifications" element={<NotificationsSettingsPage />} />
          <Route path="/settings/transactions" element={<TransactionsPage />} />
          <Route path="/settings/faq" element={<FaqPage />} />
          <Route path="/settings/promocodes" element={<PromocodesSettingsPage />} />
          <Route path="/support" element={<SupportPage />} />
        </Route>

        {/* Default */}
        <Route path="*" element={<Navigate to="/bootstrap" replace />} />
      </Routes>
    </Suspense>
  );
}
