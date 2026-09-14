/**
 * body-parser-refusal
 * ───────────────────
 * Recognises a request body the parser refused, and says what to answer.
 *
 * `express.json` runs before every route, so its refusals — JSON that does not
 * parse, a body over the limit, a charset or content encoding it cannot read —
 * reach the app's error handler and never a handler of the route. Each one is
 * the client's mistake, and body-parser already says so: an `http-errors` error
 * with a 4xx `status`, `expose: true`, and a `type` naming the refusal.
 *
 * What the error handler must not do is take one for a crash: answer 500,
 * report it to the panel, or log the error object. The unreadable-JSON refusal
 * carries the text it could not parse as `body`, pino writes every field of an
 * `err`, and Node's own JSON.parse message quotes the start of that text. So
 * nothing but the refusal's `type` and `status` leaves this module.
 */

/** body-parser's and raw-body's names for a body the client got wrong. */
const CLIENT_REFUSALS: ReadonlySet<string> = new Set([
  "entity.parse.failed",
  "entity.too.large",
  "charset.unsupported",
  "encoding.unsupported",
  "request.size.invalid",
  "parameters.too.many",
]);

export interface BodyRefusal {
  readonly status: number;
  /** The refusal's name. Safe to log: it holds nothing of the body. */
  readonly type: string;
  /** What the client is told — fixed text, so nothing of the request is echoed. */
  readonly message: string;
}

export function readBodyRefusal(err: unknown): BodyRefusal | null {
  if (typeof err !== "object" || err === null) return null;
  const { type, status, expose } = err as { type?: unknown; status?: unknown; expose?: unknown };
  if (typeof status !== "number" || status < 400 || status > 499) return null;
  if (typeof type === "string" && CLIENT_REFUSALS.has(type) && expose === true) {
    return { status, type, message: messageFor(status) };
  }
  // Any other 413 is the same refusal under another name, and the handler
  // answered it as one before this module existed.
  if (status === 413) return { status, type: "entity.too.large", message: messageFor(status) };
  return null;
}

function messageFor(status: number): string {
  if (status === 413) return "Payload too large";
  if (status === 415) return "Unsupported request body encoding";
  return "Malformed request body";
}
