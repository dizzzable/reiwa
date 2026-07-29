import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FaqMediaElement } from "../src/features/settings/faq-media-element";

describe("FaqMediaElement markup", () => {
  it("renders an asynchronously decoded lazy image with its source and alt text", () => {
    const markup = renderToStaticMarkup(
      <FaqMediaElement
        kind="image"
        url="/api/v1/faq/media/setup.webp"
        label="Illustration for setup"
        onError={() => undefined}
      />,
    );

    expect(markup).toContain("<img");
    expect(markup).toContain('src="/api/v1/faq/media/setup.webp"');
    expect(markup).toContain('alt="Illustration for setup"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('decoding="async"');
  });

  it("renders an inline controlled video that only preloads metadata", () => {
    const markup = renderToStaticMarkup(
      <FaqMediaElement
        kind="video"
        url="/api/v1/faq/media/setup.mp4"
        label="Video for setup"
        onError={() => undefined}
      />,
    );

    expect(markup).toContain("<video");
    expect(markup).toContain('src="/api/v1/faq/media/setup.mp4"');
    expect(markup).toContain('aria-label="Video for setup"');
    expect(markup).toContain('controls=""');
    expect(markup).toContain('playsInline=""');
    expect(markup).toContain('preload="metadata"');
  });
});
