// @vitest-environment jsdom

/**
 * `/support/guest?resume=<token>` — where a support reply letter's
 * «Открыть переписку» lands.
 *
 * The token is a way in, not the device's key: letters rotate their tokens
 * with every operator reply, so the page never keeps it. It hands it once to
 * `POST /support/guest/resume`, which answers with what the device should
 * hold, and every poll after that rides on the cookie alone.
 *
 * What the visitor must never get is a silent surprise: an out-of-date link
 * says so (and the device's own conversation carries on), and a link to a
 * different request than the one open on this device asks first.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createGuestTicket: vi.fn(),
  getGuestConversation: vi.fn(),
  resumeGuestConversation: vi.fn(),
  replyGuestConversation: vi.fn(),
  closeGuestConversation: vi.fn(),
  getGuestSupportConfig: vi.fn(async () => ({ enabled: true, turnstileSiteKey: null })),
  supportGuestAttachmentUrl: vi.fn(() => ""),
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/features/media-viewer/use-media-viewer", () => ({
  useMediaViewer: () => ({ open: vi.fn(), openAt: vi.fn() }),
}));

import GuestSupportPage from "@/features/support/guest-support-page";
import { en } from "@/i18n/en";
import { ru } from "@/i18n/ru";

function thread(id: string, subject: string) {
  return {
    id,
    subject,
    status: "open",
    channel: "GUEST",
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
    messages: [],
  };
}

const LETTER_THREAD = thread("t-B", "Оплата");
const DEVICE_THREAD = thread("t-A", "Другое");

/**
 * The device as the server sees it: the conversation its cookie holds. An
 * `opened` answer is where the server writes the new cookie, so the model
 * switches there, and every poll after it reads the cookie's conversation.
 */
let cookieHolds: ReturnType<typeof thread> | null = null;
function answers(...results: unknown[]) {
  const queue = [...results];
  api.resumeGuestConversation.mockImplementation(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    const result = next as { status: string; ticket?: ReturnType<typeof thread> };
    if (result.status === "opened" && result.ticket) cookieHolds = result.ticket;
    return result;
  });
  api.getGuestConversation.mockImplementation(async () => {
    if (cookieHolds === null) throw { response: { status: 404 } };
    return cookieHolds;
  });
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const fn of Object.values(api)) fn.mockClear();
  api.getGuestConversation.mockReset();
  api.resumeGuestConversation.mockReset();
  cookieHolds = null;
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

/** Lets the mutation, the query and React's batched notifications (a zero timeout) all land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(path: string): Promise<void> {
  window.history.replaceState({}, "", path);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <GuestSupportPage />
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Types `code` into «Есть код возврата?» under the open conversation. */
async function typeCode(code: string): Promise<void> {
  const field = container.querySelector<HTMLInputElement>(
    'details input[aria-label="guestSupport.resume.restoreLabel"]',
  );
  expect(field, "no code field under the open conversation").not.toBeNull();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(field, code);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button, `no button «${label}»`).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await settle();
}

describe("the guest support page opened from a reply letter", () => {
  it("hands the link to the server once, then rides on the cookie", async () => {
    answers({ status: "opened", ticket: LETTER_THREAD });
    await open("/support/guest?resume=mail-tok");

    expect(api.resumeGuestConversation.mock.calls).toEqual([["mail-tok", false]]);
    expect(window.location.search).toBe("");
    expect(container.textContent).toContain("Оплата");
    await act(async () => {
      await client.refetchQueries({ queryKey: ["guest-support"] });
    });
    for (const call of api.getGuestConversation.mock.calls) expect(call).toEqual([]);
  });

  it("says an out-of-date link is out of date, and carries on the device's conversation", async () => {
    cookieHolds = DEVICE_THREAD;
    answers({ status: "stale", ticket: DEVICE_THREAD });
    await open("/support/guest?resume=old-tok");

    expect(container.textContent).toContain("guestSupport.link.staleContinue");
    expect(container.textContent).toContain("Другое");
  });

  it("does not drop the visitor into a new request without a word", async () => {
    answers({ status: "stale", ticket: null });
    await open("/support/guest?resume=old-tok");

    expect(container.textContent).toContain("guestSupport.link.staleNone");
  });

  it("asks before switching to another request, and switches only on the visitor's word", async () => {
    cookieHolds = DEVICE_THREAD;
    answers(
      { status: "confirm", opening: { subject: "Оплата" }, current: { subject: "Другое" } },
      { status: "opened", ticket: LETTER_THREAD },
    );
    await open("/support/guest?resume=mail-tok");

    expect(container.textContent).toContain("guestSupport.link.confirmTitle");
    // Nothing to type into until the visitor has chosen.
    expect(container.querySelector("textarea")).toBeNull();

    await press("guestSupport.link.confirmOpen");
    expect(api.resumeGuestConversation.mock.calls).toEqual([
      ["mail-tok", false],
      ["mail-tok", true],
    ]);
    expect(container.textContent).toContain("Оплата");
  });

  it("stays in the device's own request when the visitor says so", async () => {
    cookieHolds = DEVICE_THREAD;
    answers({ status: "confirm", opening: { subject: "Оплата" }, current: { subject: "Другое" } });
    await open("/support/guest?resume=mail-tok");

    await press("guestSupport.link.confirmStay");
    expect(api.resumeGuestConversation).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Другое");
    expect(container.textContent).not.toContain("guestSupport.link.confirmTitle");
  });

  it("names only ways back that exist when it asks", async () => {
    cookieHolds = DEVICE_THREAD;
    answers({ status: "confirm", opening: { subject: "Оплата" }, current: { subject: "Другое" } });
    await open("/support/guest?resume=mail-tok");

    expect(container.textContent).toContain("guestSupport.link.confirmWayBack");
  });

  it("keeps the link for a retry when the first attempt fails", async () => {
    answers(new Error("Network Error"), { status: "opened", ticket: LETTER_THREAD });
    await open("/support/guest?resume=mail-tok");

    expect(container.textContent).toContain("guestSupport.link.failed");
    await press("guestSupport.link.retry");
    expect(api.resumeGuestConversation.mock.calls).toEqual([
      ["mail-tok", false],
      ["mail-tok", false],
    ]);
    expect(container.textContent).toContain("Оплата");
  });
});

/**
 * «Открыть другое обращение?» is what stands between a crafted link and the
 * visitor's own thread, so what it promises has to exist. It promised a way
 * back «по ссылке из письма о нём» — but a conversation opened without an
 * email gets no letters, and the code field lived only on the start form,
 * which a device holding an open conversation never shows.
 */
describe("the way back the question names", () => {
  it("exists: a code typed under the open conversation reopens the other one, after asking", async () => {
    // The device switched to «Оплата»; the visitor wants «Другое» back by its code.
    cookieHolds = LETTER_THREAD;
    answers(
      { status: "confirm", opening: { subject: "Другое" }, current: { subject: "Оплата" } },
      { status: "opened", ticket: DEVICE_THREAD },
    );
    await open("/support/guest");
    expect(container.textContent).toContain("Оплата");

    await typeCode("code-A");
    await press("guestSupport.resume.restoreButton");

    expect(container.textContent).toContain("guestSupport.link.confirmTitle");
    await press("guestSupport.link.confirmOpen");
    expect(api.resumeGuestConversation.mock.calls).toEqual([
      ["code-A", false],
      ["code-A", true],
    ]);
    expect(container.textContent).toContain("Другое");
  });

  it("still asks for a code typed after «Остаться в текущем»", async () => {
    // "Stay" answered ONE question. The code field under the conversation is
    // the way back the question names, and a code typed there later got the
    // server's «confirm» and then nothing on the page — no question, no error.
    cookieHolds = DEVICE_THREAD;
    answers(
      { status: "confirm", opening: { subject: "Оплата" }, current: { subject: "Другое" } },
      { status: "confirm", opening: { subject: "Оплата" }, current: { subject: "Другое" } },
      { status: "opened", ticket: LETTER_THREAD },
    );
    await open("/support/guest?resume=mail-tok");
    await press("guestSupport.link.confirmStay");
    expect(container.textContent).not.toContain("guestSupport.link.confirmTitle");

    await typeCode("code-B");
    await press("guestSupport.resume.restoreButton");

    expect(container.textContent).toContain("guestSupport.link.confirmTitle");
    await press("guestSupport.link.confirmOpen");
    expect(api.resumeGuestConversation.mock.calls).toEqual([
      ["mail-tok", false],
      ["code-B", false],
      ["code-B", true],
    ]);
    expect(container.textContent).toContain("Оплата");
  });

  it("says a code failed as a code, not as a link", async () => {
    cookieHolds = DEVICE_THREAD;
    answers(new Error("Network Error"));
    await open("/support/guest");

    await typeCode("code-B");
    await press("guestSupport.resume.restoreButton");

    // «Не удалось открыть переписку по ссылке» for a code nobody took from a link.
    expect(container.querySelector('[role="alert"] span')?.textContent).toBe("guestSupport.link.failedCode");
  });

  it("is named by the field's real label and the letter's real button, in both languages", () => {
    for (const dict of [ru, en]) {
      const link = dict.guestSupport.link;
      expect(link.confirmWayBack).toContain(dict.guestSupport.resume.restoreLabel);
      // The letter is Russian-only, so its button is named as it reads there.
      expect(link.confirmWayBack).toContain("Открыть переписку");
      // And the letter is a way back only for whoever receives such letters.
      expect(link.confirmBody).not.toMatch(/письм|email/i);
    }
  });

  it("does not tell a guest whose access ended to retry a dead link as if it were only out of date", () => {
    // The panel answers an expired guest exactly as an out-of-date link, by
    // design (no oracle), so the notice names both causes and a last resort.
    expect(ru.guestSupport.link.staleNone).toContain("доступ к обращению закончился");
    expect(ru.guestSupport.link.staleNone).toContain("напишите нам заново");
    expect(en.guestSupport.link.staleNone).toContain("access to the request has ended");
    expect(en.guestSupport.link.staleNone).toContain("write to us again");
  });
});
