// @vitest-environment jsdom

/**
 * The guest support page sends its own language with the message that opens a
 * conversation and with each reply: the panel writes the guest's reply letters
 * in it. A guest has no account, so this is the only place the panel can learn
 * which language they read — and without it every letter was Russian.
 *
 * Read when the message is sent, not when the page opened: a guest who
 * switched the page to English before writing gets an English letter.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const page = vi.hoisted(() => ({ language: "en" }));

const api = vi.hoisted(() => ({
  createGuestTicket: vi.fn(),
  getGuestConversation: vi.fn(),
  resumeGuestConversation: vi.fn(),
  replyGuestConversation: vi.fn(),
  closeGuestConversation: vi.fn(),
  getGuestSupportConfig: vi.fn(async () => ({ enabled: true, turnstileSiteKey: null })),
  supportGuestAttachmentUrl: vi.fn(() => ""),
}));

vi.mock("@/lib/api-client", async () => {
  // The page's own reading of its language — the real one, not a stand-in.
  const { guestPageLocale } = await vi.importActual<typeof import("@/lib/api-client/support")>(
    "@/lib/api-client/support",
  );
  return { ...api, guestPageLocale };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      get language() {
        return page.language;
      },
    },
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/features/media-viewer/use-media-viewer", () => ({
  useMediaViewer: () => ({ open: vi.fn(), openAt: vi.fn(), element: null }),
}));

import GuestSupportPage from "@/features/support/guest-support-page";
import { guestPageLocale } from "@/lib/api-client/support";

const THREAD = {
  id: "t-1",
  subject: "Payment",
  status: "open",
  channel: "GUEST",
  createdAt: "2026-09-24T10:00:00.000Z",
  updatedAt: "2026-09-24T10:00:00.000Z",
  messages: [],
};

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
  api.getGuestConversation.mockImplementation(async () => {
    throw { response: { status: 404 } };
  });
  api.createGuestTicket.mockReset();
  api.createGuestTicket.mockImplementation(async () => ({ resumeCode: "code", ticket: THREAD }));
  api.replyGuestConversation.mockReset();
  api.replyGuestConversation.mockImplementation(async () => THREAD);
  page.language = "en";
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <GuestSupportPage />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function type(placeholder: string, value: string): Promise<HTMLElement> {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${placeholder}"]`);
  expect(field, `no field «${placeholder}»`).not.toBeNull();
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  await act(async () => {
    setValue.call(field, value);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return field!;
}

async function click(button: HTMLButtonElement | null | undefined): Promise<void> {
  expect(button, "no such button").toBeTruthy();
  await act(async () => {
    button!.click();
  });
  await settle();
}

/** Opens a conversation through the form, the page in `language`. */
async function startConversation(language: string): Promise<void> {
  page.language = language;
  await open();
  await type("guestSupport.form.subjectPlaceholder", "Payment");
  await type("guestSupport.form.messagePlaceholder", "It did not go through");
  await click([...container.querySelectorAll("button")].find((b) => b.textContent === "guestSupport.form.submit"));
}

describe("the guest support page tells the panel its language", () => {
  it("with the message that opens the conversation", async () => {
    await startConversation("en");

    expect(api.createGuestTicket).toHaveBeenCalledTimes(1);
    expect(api.createGuestTicket.mock.calls[0]?.[0]).toMatchObject({
      subject: "Payment",
      message: "It did not go through",
      locale: "en",
    });
  });

  it("with each reply, in the language the page is in when the reply is sent", async () => {
    await startConversation("ru");
    expect(api.createGuestTicket.mock.calls[0]?.[0]).toMatchObject({ locale: "ru" });

    // The guest switches the page to English, then answers.
    page.language = "en";
    const reply = await type("guestSupport.chat.replyPlaceholder", "Any news?");
    await click(reply.parentElement?.querySelector("button"));

    expect(api.replyGuestConversation).toHaveBeenCalledWith("Any news?", undefined, "en");
  });

  it("sends none for a language the letters are not written in", async () => {
    await startConversation("de");

    expect(api.createGuestTicket).toHaveBeenCalledTimes(1);
    expect(api.createGuestTicket.mock.calls[0]?.[0]).toMatchObject({ locale: undefined });
  });
});

describe("guestPageLocale", () => {
  it("reads i18next's language as ru or en, a region or a script aside", () => {
    expect(guestPageLocale("en")).toBe("en");
    expect(guestPageLocale("en-GB")).toBe("en");
    expect(guestPageLocale("RU")).toBe("ru");
    expect(guestPageLocale("ru_RU")).toBe("ru");
    for (const other of ["de", "", undefined, "cimode"]) expect(guestPageLocale(other)).toBeUndefined();
  });
});
