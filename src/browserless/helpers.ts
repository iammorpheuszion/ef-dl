import fs from "fs";
import path from "path";

type DebugLog = (...args: any[]) => void;

export type BrowserlessCookie = {
  name: string;
  value: string;
  url: string;
};

export function parseCookieHeader(
  cookieHeader: string | undefined,
  url: string,
): BrowserlessCookie[] {
  if (!cookieHeader) return [];
  const origin = new URL(url).origin;
  return cookieHeader
    .split(";")
    .map((pair) => {
      const [name, ...rest] = pair.split("=");
      if (!name) return null;
      const value = rest.join("=");
      return {
        name: name.trim(),
        value: (value || "").trim(),
        url: origin,
      };
    })
    .filter((cookie): cookie is BrowserlessCookie => cookie !== null)
    .filter((cookie) => cookie.name.length > 0);
}

export async function extractSearchResultsJson(
  page: any,
  debugLog: DebugLog,
): Promise<any> {
  debugLog("[Extract] Attempting to extract JSON data from page...");

  // Try to find JSON data in the page
  return await page.evaluate(() => {
    // First, check for JSON in <pre> tags (justice.gov API response format)
    const preElements = Array.from(document.querySelectorAll("pre"));
    for (const pre of preElements) {
      const text = pre.textContent || "";
      // Check if it looks like JSON
      if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
        try {
          const data = JSON.parse(text);
          return data;
        } catch (e) {
          // Not valid JSON, continue
        }
      }
    }

    // Look for JSON in script tags
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const script of scripts) {
      const text = script.textContent || "";

      // Try to find JSON data - look for common patterns
      const jsonMatch =
        text.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/) ||
        text.match(/window\.__DATA__\s*=\s*({.+?});/) ||
        text.match(/const\s+data\s*=\s*({.+?});/);

      if (jsonMatch && jsonMatch[1]) {
        try {
          return JSON.parse(jsonMatch[1]);
        } catch (e) {
          // Continue searching
        }
      }
    }

    // Look for JSON-LD structured data
    const jsonLdScripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    );
    const jsonLdData = [];
    for (const script of jsonLdScripts) {
      try {
        const data = JSON.parse(script.textContent || "");
        jsonLdData.push(data);
      } catch (e) {
        // Skip invalid JSON
      }
    }

    if (jsonLdData.length > 0) {
      return { jsonLd: jsonLdData };
    }

    // Try to extract search results from the page structure
    const results: any = {
      url: window.location.href,
      title: document.title,
      extractedAt: new Date().toISOString(),
    };

    // Look for common search result containers
    const searchResults = Array.from(
      document.querySelectorAll(
        ".search-result, .views-row, article, .view-content .views-row",
      ),
    );
    if (searchResults.length > 0) {
      results.items = searchResults.map((el, index) => ({
        index,
        title: el.querySelector("h2, h3, .title, a")?.textContent?.trim() || "",
        link: el.querySelector("a")?.getAttribute("href") || "",
        description:
          el
            .querySelector(".description, .summary, p, .field-content")
            ?.textContent?.trim() || "",
        html: (el as HTMLElement).outerHTML.slice(0, 500), // Limit HTML size
      }));
    }

    // Get all links
    const links = Array.from(document.querySelectorAll("a[href]"));
    results.links = links
      .map((a) => ({
        text: a.textContent?.trim() || "",
        href: a.getAttribute("href") || "",
      }))
      .filter(
        (link) =>
          link.href &&
          !link.href.startsWith("#") &&
          !link.href.startsWith("javascript:") &&
          !link.href.startsWith("/"), // Filter out relative links
      )
      .slice(0, 50); // Limit to 50 links

    // Get page metadata
    const metaDescription = document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content");
    const metaKeywords = document
      .querySelector('meta[name="keywords"]')
      ?.getAttribute("content");

    if (metaDescription) results.metaDescription = metaDescription;
    if (metaKeywords) results.metaKeywords = metaKeywords;

    // Check if this looks like a search results page
    results.isSearchResultsPage =
      searchResults.length > 0 ||
      document.querySelector(".search-results, .view-multimedia-search") !==
        null;

    return results;
  });
}

export function saveJsonToFile(
  data: any,
  directory: string,
  filename: string,
): string {
  // Ensure directory exists
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}
