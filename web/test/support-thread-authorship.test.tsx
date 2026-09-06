// @vitest-environment jsdom

/**
 * Who wrote which bubble in a support thread.
 *
 * Position used to carry it on its own, and that worked for exactly as long
 * as support could only ever REPLY: the client's own words always came
 * first, so the left-hand column needed no name. An operator can now OPEN a
 * conversation, and then the first thing on screen is an unattributed bubble
 * about something the reader never asked about.
 *
 * The guest thread has labelled its bubbles from the start; this is the
 * account thread catching up.
 */

import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getTickets: vi.fn(),
  getTicket: vi.fn(),
  createTicket: vi.fn(),
  replyToTicket: vi.fn(),
  supportAttachmentUrl: vi.fn(() => "/attachment"),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-router", () => ({
  useSearchParams: () => [new URLSearchParams("ticket=t-1"), vi.fn()],
  useNavigate: () => vi.fn(),
}));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/api-client/ai-chat", () => ({
  getAiChatConfig: vi.fn(async () => ({ enabled: false })),
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ supportUsername: null }),
}));
vi.mock("@/features/media-viewer/use-media-viewer", () => ({
  useMediaViewer: () => ({ element: null, open: vi.fn() }),
}));
vi.mock("@/features/media-viewer/support-attachments", () => ({
  collectViewableAttachments: () => [],
  indexOfAttachment: () => -1,
}));
vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => <button type="button">back</button>,
}));

import SupportPage from "../src/features/support/support-page";

function ticket(messages: Array<{ id: string; authorType: string; content: string }>) {
  return {
    id: "t-1",
    subject: "Уточнение по оплате",
    status: "open",
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:00.000Z",
    messages: messages.map((m) => ({
      ...m,
      authorId: null,
      createdAt: "2026-09-06T10:00:00.000Z",
      attachments: [],
    })),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(defaultScheduler);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.getTickets.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SupportPage />
      </QueryClientProvider>,
    );
  });
  // React Query resolves on a microtask and the deep-link effect flips the
  // view on the next commit; a single flush lands mid-way through.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((container.textContent ?? "").length > 0 && api.getTicket.mock.calls.length > 0) break;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("a support thread names who is speaking", () => {
  it("labels an operator bubble", async () => {
    api.getTicket.mockResolvedValue(
      ticket([{ id: "m-1", authorType: "admin", content: "Здравствуйте, уточните пожалуйста" }]),
    );
    await render();
    expect(container.textContent).toContain("support.chatAuthorSupport");
  });

  it("labels a system bubble differently", async () => {
    // A document request arrives as SYSTEM. Reading it as words from a person
    // makes an automated ask look like an operator's own demand.
    api.getTicket.mockResolvedValue(
      ticket([{ id: "m-1", authorType: "system", content: "Приложите чек" }]),
    );
    await render();
    expect(container.textContent).toContain("support.chatAuthorSystem");
    expect(container.textContent).not.toContain("support.chatAuthorSupport");
  });

  it("puts no label on the reader's own bubble", async () => {
    // Naming both sides turns a two-person conversation into a transcript.
    api.getTicket.mockResolvedValue(
      ticket([{ id: "m-1", authorType: "user", content: "Не приходит оплата" }]),
    );
    await render();
    expect(container.textContent).toContain("Не приходит оплата");
    expect(container.textContent).not.toContain("support.chatAuthor");
  });

  it("labels only the operator's half of a two-sided thread", async () => {
    api.getTicket.mockResolvedValue(
      ticket([
        { id: "m-1", authorType: "user", content: "Не приходит оплата" },
        { id: "m-2", authorType: "admin", content: "Проверяем" },
      ]),
    );
    await render();
    const labels = container.textContent?.split("support.chatAuthorSupport").length ?? 0;
    expect(labels - 1).toBe(1);
  });
});
