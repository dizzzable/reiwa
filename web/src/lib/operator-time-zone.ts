/**
 * The operator's «Часовой пояс» for the signed-in cabinet's subscription dates.
 *
 * The bot's notices print a customer's dates on the operator's clock, and so do
 * the add-on lines (`features/addons/add-on-end.ts`). «Главная» printed the
 * end of a subscription on the phone's calendar: near midnight it named another
 * day than the notice about the same end, and its «N дней» — elapsed time
 * rounded up — could contradict the date printed beside it on either calendar.
 *
 * The panel names its zone in the add-on answers (`displayTimeZone`); the list
 * of the customer's add-ons carries it on every answer, even an empty one, so
 * the signed-in shell reads it from there (`operator-time-zone-provider.tsx`) —
 * the same query «Мои докупки» makes, answered once for both. Until it has
 * answered (or when it cannot: a panel older than the field, a failed read) the
 * value is `undefined` and the dates stay on the phone's calendar, as they
 * always were (`customerDateZone`).
 *
 * A context rather than a query in every component that prints a date: they
 * are drawn in places that hold no query client — a card rendered on its own,
 * a picker inside a wizard — and without a provider they simply keep the
 * phone's calendar.
 */
import { createContext, useContext } from "react";

export const OperatorTimeZoneContext = createContext<string | undefined>(undefined);

/**
 * The zone to print a customer's subscription dates on — `undefined` while the
 * panel has not said it, and the phone's calendar is used (`formatDate`).
 */
export function useOperatorTimeZone(): string | undefined {
  return useContext(OperatorTimeZoneContext);
}
