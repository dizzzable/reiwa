/**
 * The key of the shared platform policy query (`platform-policy-query.ts`),
 * in a module of its own.
 *
 * A page that only asks for the policy to be read again needs the key, not the
 * query's options — and the options bind `getPlatformPolicy` from the API
 * client the moment their module loads. Several suites mock
 * `@/lib/api-client` down to the calls the page under test makes (the add-on
 * wizard's among them), and loading the options there would fail on the call
 * they left out. Re-exported by `platform-policy-query.ts`, so there is still
 * one key.
 */
export const PLATFORM_POLICY_QUERY_KEY = ["platform-policy"] as const;
