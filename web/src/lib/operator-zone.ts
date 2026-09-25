/**
 * A moment on the OPERATOR's clock, with the zone named.
 *
 * The panel's «Часовой пояс» (Settings → «Платформа») is the clock a
 * customer's dates are read on: the bot's notices print them in it, and the
 * partner hold is shown in it already (`partner-balance-hold.ts`). A reset
 * add-on that ended «01.10 в 03:20» here on the phone's clock and «01.10 в
 * 00:20» in the bot's notice the day before would be two different promises,
 * so the cabinet reads the moment in the operator's zone and says which zone
 * that is (the owner, 24.09.2026: a reset time is never printed without it).
 *
 * The zone is named the way the panel's notices name it (`buildAddOnFacts`,
 * `rezeis-admin/src/modules/notifications/utils/subscription-facts.util.ts`):
 * «по Москве» for the zones this product's operators set, «по UTC», any other
 * zone by its offset («UTC+5»); in English the zone's own name ("Moscow
 * Time") or its offset. A customer reads both, so the two lists must agree —
 * no test can see the other repository, so a change here is a change there.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Russian unless the interface is in another language — the rule `getActiveLocale` applies. */
function isRussian(language: string | undefined): boolean {
  return language?.startsWith("ru") !== false;
}

/**
 * The zone the operator's moments are read in: their «Часовой пояс» when this
 * browser knows it, UTC otherwise — which is also what the panel means by
 * none (`displayTimeZone: null`). The zone is named either way, so an hour
 * is never read in a zone it is not.
 */
export function operatorZone(displayTimeZone: string | null | undefined): string {
  const candidate = typeof displayTimeZone === "string" ? displayTimeZone.trim() : "";
  if (candidate === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    // A zone this browser does not know: UTC, named as such.
    return "UTC";
  }
}

/**
 * «по Москве» — a zone the way a Russian sentence names it. A city takes the
 * dative, which `Intl` does not give (its `shortGeneric` is «Москва»), so
 * these are written out; any other zone goes by its offset, which needs no
 * grammar. The same list as the panel's notices.
 */
const ZONE_PHRASE_RU: Readonly<Record<string, string>> = {
  "Europe/Kaliningrad": "по Калининграду",
  "Europe/Moscow": "по Москве",
  "Europe/Samara": "по Самаре",
  "Europe/Volgograd": "по Волгограду",
  "Asia/Yekaterinburg": "по Екатеринбургу",
  "Asia/Omsk": "по Омску",
  "Asia/Novosibirsk": "по Новосибирску",
  "Asia/Krasnoyarsk": "по Красноярску",
  "Asia/Irkutsk": "по Иркутску",
  "Asia/Yakutsk": "по Якутску",
  "Asia/Vladivostok": "по Владивостоку",
  "Asia/Magadan": "по Магадану",
  "Asia/Kamchatka": "по Камчатке",
  "Europe/Minsk": "по Минску",
  "Europe/Kyiv": "по Киеву",
  "Europe/Kiev": "по Киеву",
  "Asia/Almaty": "по Алматы",
  "Asia/Tashkent": "по Ташкенту",
};

/**
 * The zone's wall clock at `at`, to the minute, as if it were UTC — `year`,
 * `month`, `day`, `hour` and `minute` from `formatToParts`, which every browser
 * the cabinet runs in has. NOT `timeZoneName: "longOffset"`: the panel's
 * notices use it on the server, but here it runs in customers' WebViews, and a
 * Safari older than 15.4 throws a `RangeError` on it — in the middle of a
 * render.
 */
function zoneWallClock(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((piece) => piece.type === type)?.value);
  // Some engines count midnight as 24 even when asked for h23.
  const hour = part("hour") % 24;
  return Date.UTC(part("year"), part("month") - 1, part("day"), hour, part("minute"));
}

/** `UTC`, `UTC+3`, `UTC+5:30`, `UTC-4` — the zone's offset at `at`. */
function zoneOffset(zone: string, at: Date): string {
  const minutes = Math.round((zoneWallClock(at, zone) - Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
  // A zero offset is UTC's clock, whatever the zone is called.
  if (minutes === 0) return "UTC";
  const size = Math.abs(minutes);
  const rest = size % 60;
  return `UTC${minutes > 0 ? "+" : "-"}${Math.floor(size / 60)}${rest === 0 ? "" : `:${String(rest).padStart(2, "0")}`}`;
}

/**
 * The zone's English name, "Moscow Time" — or `null` when the browser has
 * none: `shortGeneric` is as new as `longOffset`, and throws where that does.
 */
function englishZoneName(zone: string, at: Date): string | null {
  try {
    const name = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "shortGeneric" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    return name === undefined || name.startsWith("GMT") ? null : name;
  } catch {
    return null;
  }
}

/** The zone named for a sentence: «по Москве» / "Moscow Time"; «по UTC» / "UTC"; otherwise «UTC+5». */
export function zonePhrase(zone: string, at: Date, language: string | undefined): string {
  const offset = zoneOffset(zone, at);
  const russian = isRussian(language);
  if (offset === "UTC") return russian ? "по UTC" : "UTC";
  if (russian) return ZONE_PHRASE_RU[zone] ?? offset;
  // English names a zone by itself: "Moscow Time", "Yekaterinburg Time".
  return englishZoneName(zone, at) ?? offset;
}

/** The calendar day of `at` in `zone`, as a count of days — for counting days on that calendar. */
function zoneDay(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((piece) => piece.type === type)?.value);
  return Math.round(Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS);
}

function zoneYear(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(at);
}

/**
 * «01.10» / "Oct 1" — the day of `instant` on the zone's calendar. With the
 * year too («20.09.27» / "Sep 20, 2027") when it is not this year there: the
 * end of a yearly subscription must never read as this year's date.
 */
export function formatZoneDate(instant: Date, zone: string, language: string | undefined, now: Date): string {
  const withYear = zoneYear(instant, zone) !== zoneYear(now, zone);
  if (isRussian(language)) {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: zone,
      day: "2-digit",
      month: "2-digit",
      ...(withYear ? { year: "2-digit" } : {}),
    }).format(instant);
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(instant);
}

/** «03:20» — a 24-hour clock in both languages, as the notices print it: it states a deadline. */
export function formatZoneTime(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

export interface Countdown {
  readonly unit: "day" | "hour" | "minute";
  readonly count: number;
}

/**
 * How far `target` is from `now` — «через 7 дн.», «через 5 ч», «через 40 мин»
 * — or `null` once it is not ahead any more.
 *
 * From a day away, days are counted on the zone's calendar, the one the date
 * beside them is printed on: «01.10 … — через 7 дн.» on 24.09 at any hour, as
 * a person counts, never a «через 6 дн.» that contradicts the date next to
 * it. Under a day, whole hours; under an hour, whole minutes — both rounded
 * down, so no more time is promised than is left.
 */
export function countdown(target: Date, now: Date, zone: string): Countdown | null {
  const left = target.getTime() - now.getTime();
  if (left <= 0) return null;
  if (left < HOUR_MS) return { unit: "minute", count: Math.max(1, Math.floor(left / MINUTE_MS)) };
  if (left < DAY_MS) return { unit: "hour", count: Math.floor(left / HOUR_MS) };
  return { unit: "day", count: Math.max(1, zoneDay(target, zone) - zoneDay(now, zone)) };
}

/** How many days `target` is from `now` on the zone's calendar: 0 the same day there, negative once it is past. */
export function calendarDaysUntil(target: Date, now: Date, zone: string): number {
  return zoneDay(target, zone) - zoneDay(now, zone);
}

/**
 * The zone a customer's subscription dates are printed on — «Главная», the
 * subscription picker, the connect screen, the devices — from `displayTimeZone`
 * as the panel's add-on answers carry it: the operator's «Часовой пояс» once
 * the panel has said it (`null`: none set, which is UTC); `undefined` while it
 * has not — an answer still out, one that failed, a panel older than the field.
 * The phone's own calendar prints them then, as it always did: a date is never
 * read on a clock the cabinet only guessed.
 */
export function customerDateZone(displayTimeZone: string | null | undefined): string | undefined {
  return displayTimeZone === undefined ? undefined : operatorZone(displayTimeZone);
}

/** The phone's own zone: what a `Date` prints in, and the calendar days are counted on while no zone is known. */
export function phoneZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
