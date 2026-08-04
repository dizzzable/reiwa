/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// `ImportMetaEnv` / `ImportMeta` — DELIBERATELY NOT DECLARED HERE.
//
// They used to be, and they did nothing: `export {}` at the bottom makes this
// file a module, so top-level interfaces are module-scoped and never merged
// with the globals they appeared to extend. Nothing errored because vite's own
// `ImportMetaEnv` (node_modules/vite/types/importMeta.d.ts) carries an `any`
// index signature, so `import.meta.env.ANYTHING` type-checks regardless.
//
// Re-adding them buys nothing while that fallback exists, and there are no
// `import.meta.env` consumers in this app at all. If one ever appears and you
// want typo-safety, declare it somewhere the augmentation actually lands —
// same lesson as the Telegram note below.

// Style imports
declare module '*.css';
declare module '*.svg' {
  const src: string;
  export default src;
}

// Telegram WebApp global — DELIBERATELY NOT DECLARED HERE.
//
// `window.Telegram` and `window.__reiwaTelegramSdkState` are declared exactly
// once, in `src/types/telegram.ts`. A second declaration of `Telegram?` used
// to live in this file next to the richer one in
// `src/hooks/use-telegram-webapp.ts`. Two `declare global` blocks describing
// the same property with different object types is TS2717, but `skipLibCheck:
// true` in `tsconfig.app.json` suppresses it the moment one copy sits in a
// `.d.ts` — i.e. right here. So the compiler stayed silent, the other copy
// silently won member resolution, and adding `openInvoice` to this one alone
// still failed at `lib/utils.ts` with TS2339.
//
// There is no compiler error to catch a re-do; this comment is the guard.
// Add Telegram members to `src/types/telegram.ts`.

export {};
