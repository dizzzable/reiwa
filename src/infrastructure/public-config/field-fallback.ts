/**
 * The per-field fallback for a public-config payload the guard rejects in
 * part — the owner's rule of 24.09.2026: «Неверное значение оформления: всё
 * новое применяется, кроме него, и панель пишет, что не принято».
 *
 * Until then one bad key discarded the WHOLE payload: the cabinet went on
 * serving the previous appearance for as long as the key survived — every
 * colour, logo and text — while the panel reported the save as successful
 * (W8 report D9). Now each part of the payload is judged alone
 * (`assessPublicConfigFields` in the guard), everything that passes is taken,
 * and a part that fails takes back:
 *
 *   1. the value the cabinet served last — `previous`, the snapshot held in
 *      memory, else the copy kept in Redis; a key `previous` did not carry is
 *      left out, because "absent" is what the cabinet served;
 *   2. with nothing served yet, the value the cabinet uses when the panel sends
 *      none: its built-in default for a field the guard requires
 *      (`PUBLIC_CONFIG_BUILT_IN_DEFAULTS`), and no key at all for an optional
 *      one — the SPA fills that in itself.
 *
 * A payload unusable as a whole (not an object, no `branding` object) is still
 * refused whole, and so is one whose parts cannot be put back together into a
 * payload that passes the guard whole — which, since `previous` always passed
 * it, does not happen.
 *
 * Two parts of the guard are PAIRS (`locales` with `defaultLocale`, the root
 * card text policy with the variants that must repeat it). A value taken back
 * can therefore disagree with a new value it has to match; the fallback then
 * widens to the other half, which is reported too. Every round widens by at
 * least one field, so it ends.
 *
 * Pure and synchronous: the route loads `previous` and does the reporting.
 */
import {
  assessPublicConfigFields,
  type PublicConfigFieldRejection,
  type PublicConfigRejection,
  type PublicConfigSnapshot,
} from "../../application/ports/public-config-persistence.port.js";

/**
 * The cabinet's built-in value of every field the guard REQUIRES — what it
 * paints when the panel has sent nothing at all. Optional fields are not here:
 * leaving them out IS their default, resolved by the SPA.
 *
 * A COPY of `DEFAULT_PUBLIC_CONFIG` / `DEFAULT_BRANDING` in
 * `web/src/types/branding.ts`, which the server build cannot import (its
 * `rootDir` is `src`). `test/web/public-config-built-in-defaults.test.ts`
 * holds the two equal, so a change there turns red here before a subscriber
 * can see two different "defaults".
 */
export const PUBLIC_CONFIG_BUILT_IN_DEFAULTS: {
  readonly root: Readonly<Record<string, unknown>>;
  readonly branding: Readonly<Record<string, unknown>>;
} = {
  root: {
    locales: ["ru", "en"],
    defaultLocale: "ru",
    defaultCurrency: "USD",
    customIcons: [],
  },
  branding: {
    brandName: "Reiwa",
    logoUrl: null,
    primary: "#22c55e",
    primaryFg: "#0a0a0a",
    bgPrimary: "#0a0a0a",
    bgSecondary: "#171717",
    cardGradient: "linear-gradient(135deg, #064e3b 0%, #22c55e 100%)",
    cardPattern: null,
    cardLogo: "DEFAULT",
    cardLogoUrl: null,
    cardEffect: "aurora",
    cardEffectProps: {},
    cardEffectOpacity: 1,
    cardEffectsByIndex: [],
    bgEffect: "NONE",
    iconColorMode: "default",
    iconColors: {},
    borderRadius: "rounded-2xl",
    fontFamily: "Geist Variable, system-ui, sans-serif",
  },
};

/** What the fallback made of a panel payload. */
export type PublicConfigFallback =
  | {
      /** Nothing in the payload can be used; `rejection` is why. */
      readonly usable: false;
      readonly rejection: PublicConfigRejection;
    }
  | {
      readonly usable: true;
      /** What to serve: the payload, with each rejected part taken back. */
      readonly snapshot: PublicConfigSnapshot;
      /** The parts NOT taken from the payload, in the guard's order; empty when all were. */
      readonly rejected: readonly PublicConfigFieldRejection[];
    };

const BRANDING_PREFIX = "branding.";

/**
 * Judge `incoming` field by field and build what the cabinet serves from it.
 * `previous` must be a snapshot the guard accepted whole — the one served last
 * — or `null` when the cabinet has served none.
 */
export function applyPublicConfigFieldFallback(
  incoming: unknown,
  previous: PublicConfigSnapshot | null,
): PublicConfigFallback {
  const assessed = assessPublicConfigFields(incoming);
  if (assessed.shape !== null) return { usable: false, rejection: assessed.shape };
  if (assessed.rejected.length === 0) {
    return { usable: true, snapshot: incoming as PublicConfigSnapshot, rejected: [] };
  }

  const rejected: PublicConfigFieldRejection[] = [...assessed.rejected];
  const takenBack = new Set<string>(rejected.flatMap((rejection) => rejection.fields));
  const source = incoming as Record<string, unknown>;
  for (;;) {
    const merged = withFieldsTakenBack(source, takenBack, previous);
    const again = assessPublicConfigFields(merged);
    if (again.shape !== null) return { usable: false, rejection: again.shape };
    if (again.rejected.length === 0) {
      return { usable: true, snapshot: merged as PublicConfigSnapshot, rejected };
    }
    // A value taken back that disagrees with a new one it must match: take
    // the other half back as well. Nothing new to take back means the values
    // taken back fail themselves — there is nothing left to serve from.
    const widening = again.rejected.filter((rejection) =>
      rejection.fields.some((field) => !takenBack.has(field)),
    );
    if (widening.length === 0) {
      return { usable: false, rejection: again.rejected[0] as PublicConfigRejection };
    }
    for (const rejection of widening) {
      rejected.push(rejection);
      for (const field of rejection.fields) takenBack.add(field);
    }
  }
}

function withFieldsTakenBack(
  incoming: Record<string, unknown>,
  fields: ReadonlySet<string>,
  previous: PublicConfigSnapshot | null,
): Record<string, unknown> {
  const root: Record<string, unknown> = { ...incoming };
  const branding: Record<string, unknown> = {
    ...(incoming["branding"] as Record<string, unknown>),
  };
  for (const field of fields) {
    if (field.startsWith(BRANDING_PREFIX)) {
      takeBack(
        branding,
        field.slice(BRANDING_PREFIX.length),
        previous === null ? null : previous.branding,
        PUBLIC_CONFIG_BUILT_IN_DEFAULTS.branding,
      );
    } else {
      takeBack(root, field, previous, PUBLIC_CONFIG_BUILT_IN_DEFAULTS.root);
    }
  }
  root["branding"] = branding;
  return root;
}

/**
 * Put back one key: the served value, else the built-in one, else no key.
 * `Object.hasOwn` rather than `in`: a key must never be "found" on a prototype.
 */
function takeBack(
  target: Record<string, unknown>,
  key: string,
  served: Readonly<Record<string, unknown>> | null,
  builtIn: Readonly<Record<string, unknown>>,
): void {
  if (served !== null) {
    if (Object.hasOwn(served, key)) target[key] = served[key];
    else delete target[key];
    return;
  }
  if (Object.hasOwn(builtIn, key)) target[key] = structuredClone(builtIn[key]);
  else delete target[key];
}
