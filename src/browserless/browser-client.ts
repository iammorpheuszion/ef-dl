import createBrowserless from "browserless";
import fs from "fs";
import path from "path";
import { JUSTICE_GOV_COOKIE_DOMAIN } from "../types/constants";
import { handleSecurityChallenges, isInterstitialPage } from "./challenger";
import {
  extractSearchResultsJson,
  parseCookieHeader,
  saveJsonToFile,
} from "./helpers";
import { logger } from "../utils/logger";

const browserless = createBrowserless({
  adblock: false, // Disable adblocker to avoid interference with security challenges
});

/**
 * Logger function that only logs in verbose mode
 */
function debugLog(...args: any[]): void {
  logger.debug(...args);
}

type PageContentResult = {
  text: string;
  json: {
    title: string;
    bodyText: string;
    url: string;
  };
};

export async function fetchPageContent(
  url: string,
  options?: {
    cookieHeader?: string;
    saveJson?: boolean;
    jsonOutputDir?: string;
  },
): Promise<PageContentResult & { jsonData?: any; jsonFilePath?: string }> {
  const cookies = parseCookieHeader(options?.cookieHeader, url);
  const context = await browserless.createContext();
  let page;

  const saveJson = options?.saveJson ?? true;
  const jsonOutputDir = options?.jsonOutputDir ?? "./downloads/json";

  try {
    page = await context.page();

    // Set age verification cookie to skip age check
    const urlObj = new URL(url);
    await page.setCookie({
      name: "justiceGovAgeVerified",
      value: "true",
      domain: JUSTICE_GOV_COOKIE_DOMAIN,
      path: "/",
      url: `${urlObj.protocol}//${urlObj.hostname}`,
    });

    if (cookies.length) {
      await page.setCookie(...cookies);
    }

    // Use goto directly - disable adblock to avoid interference with security challenges
    const goto = context.goto;
    const { error } = await goto(page, {
      url,
      timeout: 30000,
      waitUntil: "networkidle2",
      adblock: false,
    } as any);
    if (error) throw error;

    await handleSecurityChallenges(page, context, url, null, debugLog);

    // Always extract after any navigation
    debugLog(`\n[Debug] Final URL: ${page.url()}`);

    // Check if we're still on interstitial
    const isStillInterstitial = await isInterstitialPage(page, debugLog);
    if (isStillInterstitial) {
      debugLog(
        "[Warning] Still on interstitial page after all challenge attempts",
      );
    }

    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    debugLog(`[Debug] Page title: "${title}"`);
    debugLog(`[Debug] Body text length: ${bodyText.length}`);

    // Check if page content is actually the search results
    const pageContent = await page.content();

    // Print first 300 chars of content to see what we're dealing with
    debugLog(`[Debug] Page content preview (first 300 chars):`);
    debugLog(pageContent.slice(0, 300));

    if (bodyText.length < 100) {
      debugLog(
        "[Warning] Page body text is very short, might be on a challenge page",
      );
    }

    // Extract JSON data from the page
    let jsonData: any = null;
    let jsonFilePath: string | undefined;

    try {
      jsonData = await extractSearchResultsJson(page, debugLog);

      if (saveJson && jsonData) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const urlObj = new URL(page.url());
        const searchParams = new URLSearchParams(urlObj.search);
        const searchTerm = searchParams.get("keys") || "unknown";
        const pageNum = searchParams.get("page") || "1";
        const filename = `search-${searchTerm}-page-${pageNum}-${timestamp}.json`;

        jsonFilePath = saveJsonToFile(jsonData, jsonOutputDir, filename);
        logger.info(`[Save] JSON data saved to: ${jsonFilePath}`);
      }
    } catch (extractError) {
      logger.error("[Extract] Failed to extract JSON data:", extractError);
    }

    return {
      text: bodyText,
      json: {
        title,
        bodyText,
        url: page.url(),
      },
      jsonData,
      jsonFilePath,
    };
  } finally {
    await context.destroyContext().catch(() => undefined);
  }
}

/**
 * Download a PDF file from justice.gov
 * Handles the security challenges (robot button, interstitial)
 */
export async function downloadPdf(
  pdfUrl: string,
  outputDir: string,
  fileName: string,
  prefix?: string,
): Promise<string> {
  debugLog(`[PDF Download] Starting download from: ${pdfUrl}`);

  const context = await browserless.createContext();
  let page;

  try {
    page = await context.page();

    // Set age verification cookie to skip age check
    const pdfUrlObj = new URL(pdfUrl);
    await page.setCookie({
      name: "justiceGovAgeVerified",
      value: "true",
      domain: JUSTICE_GOV_COOKIE_DOMAIN,
      path: "/",
      url: `${pdfUrlObj.protocol}//${pdfUrlObj.hostname}`,
    });

    // Navigate to PDF URL - disable adblock to avoid interference with security challenges
    const goto = context.goto;
    const { error } = await goto(page, {
      url: pdfUrl,
      timeout: 60000, // Longer timeout for PDF downloads
      waitUntil: "networkidle2",
      adblock: false,
    } as any);

    if (error) throw error;

    await handleSecurityChallenges(page, context, pdfUrl, "PDF", debugLog);

    // Check if we're on the PDF or if it triggered a download
    const currentUrl = page.url();
    debugLog(`[PDF Download] Final URL: ${currentUrl}`);

    // Try to get the PDF buffer
    let pdfBuffer: Buffer | null = null;

    // Check if the current page is displaying a PDF
    const contentType = await page.evaluate(() => {
      return document.contentType || "";
    });

    if (contentType.includes("pdf") || currentUrl.endsWith(".pdf")) {
      debugLog("[PDF Download] Page is displaying PDF, capturing...");

      // Use CDP to capture the PDF
      const client = await page.target().createCDPSession();
      const { data } = await client.send("Page.captureSnapshot", {
        format: "mhtml",
      });

      // For PDFs, we need to fetch the content directly
      pdfBuffer = await page.evaluate(async () => {
        const response = await fetch(window.location.href);
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        return Array.from(new Uint8Array(arrayBuffer));
      });

      // Convert array back to Buffer
      pdfBuffer = Buffer.from(pdfBuffer as any);
    } else {
      // Try to download via fetch in page context
      debugLog("[PDF Download] Attempting to download via fetch...");
      const pdfData = await page.evaluate(async (url: string) => {
        try {
          const response = await fetch(url, {
            credentials: "include",
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          return {
            success: true,
            data: Array.from(new Uint8Array(arrayBuffer)),
            contentType: response.headers.get("content-type"),
          };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      }, pdfUrl);

      if (!pdfData.success) {
        throw new Error(`Failed to download PDF: ${pdfData.error}`);
      }

      pdfBuffer = Buffer.from(pdfData.data);
    }

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Downloaded PDF is empty");
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Apply prefix to filename if provided
    const finalFileName = prefix ? `${prefix}-${fileName}` : fileName;

    // Save PDF file
    const filePath = path.join(outputDir, finalFileName);
    fs.writeFileSync(filePath, pdfBuffer);

    debugLog(
      `[PDF Download] Successfully saved ${pdfBuffer.length} bytes to ${filePath}`,
    );

    return filePath;
  } finally {
    await context.destroyContext().catch(() => undefined);
  }
}

/**
 * Close the browserless instance and clean up all browser resources.
 * Should be called when the application exits or is interrupted.
 */
export async function closeBrowser(): Promise<void> {
  try {
    await browserless.close();
    debugLog("[Browser] Browser instance closed successfully");
  } catch (error) {
    // Browser might already be closed or never started
    debugLog("[Browser] Error closing browser (may already be closed):", error);
  }
}

if (import.meta.main) {
  const url = process.argv[2] ?? "https://example.com";
  fetchPageContent(url, {})
    .then(({ text, json, jsonData, jsonFilePath }) => {
      logger.info("\n=== Page Text Preview ===\n");
      logger.info(text.slice(0, 2000));
      logger.info("\n=== JSON Preview ===\n");
      logger.info(JSON.stringify(json, null, 2).slice(0, 2000));

      if (jsonData) {
        logger.info("\n=== Extracted JSON Data Preview ===\n");
        logger.info(JSON.stringify(jsonData, null, 2).slice(0, 2000));
      }

      if (jsonFilePath) {
        logger.info(`\n[Saved] JSON data saved to: ${jsonFilePath}`);
      }
    })
    .catch((err) => {
      logger.error("Fetch failed:", err);
      process.exit(1);
    });
}
