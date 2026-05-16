import { chromium, Page } from "playwright";

export interface ScrapeOptions {
  url: string;
  selectors?: Record<string, string>; // e.g. { title: "h1", price: ".price" }
  waitFor?: string;                   // CSS selector to wait for before extracting
}

export interface ScrapeResult {
  url: string;
  scrapedAt: string;
  page: {
    title: string;
    description: string;
    html: string;
  };
  text: {
    headings: string[];
    paragraphs: string[];
    links: { text: string; href: string }[];
    images: { alt: string; src: string }[];
  };
  custom: Record<string, string | string[]>; // results from user-provided selectors
}

export async function scrape(options: ScrapeOptions): Promise<ScrapeResult> {
  const { url, selectors = {}, waitFor } = options;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
  });
  const page: Page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // If the caller wants to wait for a specific element (e.g. a React component)
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 10000 });
    }

    // ── Core page metadata ────────────────────────────────────────────────────
    const title = await page.title();
    const description = await page
      .$eval('meta[name="description"]', (el) => el.getAttribute("content") ?? "")
      .catch(() => "");
    const html = await page.content();

    // ── Structured text extraction ────────────────────────────────────────────
    const headings = await page.$$eval("h1,h2,h3,h4,h5,h6", (els) =>
      els.map((el) => el.textContent?.trim() ?? "").filter(Boolean)
    );

    const paragraphs = await page.$$eval("p", (els) =>
      els.map((el) => el.textContent?.trim() ?? "").filter(Boolean)
    );

    const links = await page.$$eval("a[href]", (els) =>
      els.map((el) => ({
        text: el.textContent?.trim() ?? "",
        href: (el as HTMLAnchorElement).href,
      }))
    );

    const images = await page.$$eval("img", (els) =>
      els.map((el) => ({
        alt: (el as HTMLImageElement).alt ?? "",
        src: (el as HTMLImageElement).src ?? "",
      }))
    );

    // ── Custom selectors provided by the caller ───────────────────────────────
    const custom: Record<string, string | string[]> = {};
    for (const [key, selector] of Object.entries(selectors)) {
      const elements = await page.$$(selector);
      if (elements.length === 1) {
        custom[key] = (await elements[0].textContent())?.trim() ?? "";
      } else {
        custom[key] = await Promise.all(
          elements.map(async (el) => (await el.textContent())?.trim() ?? "")
        );
      }
    }

    return {
      url,
      scrapedAt: new Date().toISOString(),
      page: { title, description, html },
      text: { headings, paragraphs, links, images },
      custom,
    };
  } finally {
    await browser.close();
  }
}
