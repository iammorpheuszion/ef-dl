import { logger } from "../utils/logger";

type DebugLog = (...args: any[]) => void;

const noopDebug: DebugLog = () => undefined;

const navigationErrors = [
  "Execution context was destroyed",
  "Cannot find context with specified id",
  "Inspected target navigated or closed",
];

function formatSecurityLabel(prefix: string | null, label: string): string {
  return prefix ? `${prefix} ${label}` : label;
}

async function waitForNavigationWithHandling(
  page: any,
  label: string,
  debugLog: DebugLog,
): Promise<void> {
  try {
    await page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: 10000,
    });
    debugLog(`[${label}] Navigation completed`);
  } catch (err: any) {
    const message = err?.message ?? "";
    if (!navigationErrors.some((pattern) => message.includes(pattern))) {
      debugLog(`[${label}] Navigation error:`, message);
    } else {
      debugLog(`[${label}] Navigation context destroyed (expected)`);
    }
  }
}

async function waitForPageStable(
  page: any,
  timeout: number,
  debugLog: DebugLog,
): Promise<void> {
  const startTime = Date.now();
  let lastUrl = page.url();
  let lastContentLength = (await page.content()).length;

  while (Date.now() - startTime < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const currentUrl = page.url();
    const currentContentLength = (await page.content()).length;

    // If URL and content haven't changed, page is stable
    if (currentUrl === lastUrl && currentContentLength === lastContentLength) {
      debugLog(`[Debug] Page is stable after ${Date.now() - startTime}ms`);
      return;
    }

    lastUrl = currentUrl;
    lastContentLength = currentContentLength;
  }

  debugLog(`[Debug] Timeout waiting for page stability`);
}

async function handleRobotButton(
  page: any,
  labelPrefix: string | null,
  debugLog: DebugLog,
): Promise<boolean> {
  const robotLabel = formatSecurityLabel(labelPrefix, "Robot");
  const robotButton = await page.$(
    'input.usa-button[type="button"][value="I am not a robot"]',
  );
  if (!robotButton) return false;

  debugLog(`[${robotLabel}] Found 'I am not a robot' button, clicking...`);
  await robotButton.click();
  debugLog(`[${robotLabel}] Button clicked, waiting for navigation...`);
  await waitForNavigationWithHandling(page, robotLabel, debugLog);

  // Additional wait for any redirects
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return true;
}

async function handleAgeCheckButton(
  page: any,
  labelPrefix: string | null,
  debugLog: DebugLog,
): Promise<boolean> {
  const ageLabel = formatSecurityLabel(labelPrefix, "Age Check");
  const ageYesButton = await page.$("#age-button-yes");
  if (!ageYesButton) return false;

  debugLog(`[${ageLabel}] Found age verification buttons, clicking 'Yes'...`);
  await ageYesButton.click();
  debugLog(`[${ageLabel}] Button clicked, waiting for navigation...`);
  await waitForNavigationWithHandling(page, ageLabel, debugLog);

  await new Promise((resolve) => setTimeout(resolve, 3000));
  return true;
}

async function solveInterstitialChallenge(
  page: any,
  context: any,
  baseUrl: string,
  debugLog: DebugLog,
): Promise<void> {
  debugLog("[Interstitial] Detected Akamai challenge page, solving...");

  // Get current URL and extract bm-verify from URL if present
  const currentUrl = page.url();
  const urlObj = new URL(currentUrl);
  const urlBmVerify = urlObj.searchParams.get("bm-verify");

  // Extract the challenge data from the page
  const challengeData = await page.evaluate(() => {
    // Get bm-verify from meta refresh or script
    let bmVerify: string | null = null;

    // Try meta refresh first
    const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
    if (metaRefresh) {
      const content = metaRefresh.getAttribute("content") || "";
      const match = content.match(/bm-verify=([^&'"]+)/);
      if (match && match[1]) {
        bmVerify = match[1];
      }
    }

    // Try to find i value in scripts
    let iValue: number | null = null;
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const script of scripts) {
      const text = script.textContent || "";
      const iMatch = text.match(/var\s+i\s*=\s*(\d+);/);
      if (iMatch?.[1]) {
        iValue = parseInt(iMatch[1], 10);
      }

      // Also try to find bm-verify in script if not found in meta
      if (!bmVerify) {
        const bmMatch = text.match(/bm-verify["']?\s*:\s*["']([^"']+)["']/);
        if (bmMatch?.[1]) {
          bmVerify = bmMatch[1];
        }
      }
    }

    return { bmVerify, iValue };
  });

  // Use URL bm-verify as fallback
  const finalBmVerify = challengeData.bmVerify || urlBmVerify;

  if (!finalBmVerify) {
    throw new Error("[Interstitial] Could not extract bm-verify token");
  }

  debugLog(
    `[Interstitial] Using bm-verify token: ${finalBmVerify.slice(0, 30)}...`,
  );
  debugLog(`[Interstitial] Extracted i value: ${challengeData.iValue}`);

  // Compute proof of work
  // The pattern is: j = i + Number("4408" + "02619") = i + 440802619
  const pow = challengeData.iValue
    ? challengeData.iValue + 440802619
    : 440802619;
  debugLog(`[Interstitial] Computed pow: ${pow}`);

  // Make the verification request using browser context goto
  const verifyUrl = new URL(
    "/_sec/verify?provider=interstitial",
    baseUrl,
  ).toString();
  debugLog(`[Interstitial] Sending verification request to: ${verifyUrl}`);

  try {
    // Execute the challenge resolution via page evaluate
    const result = await page.evaluate(
      async (bmVerify: string, powValue: number) => {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.withCredentials = true;
          xhr.addEventListener("loadend", function () {
            try {
              const data = JSON.parse(xhr.responseText);
              resolve(data);
            } catch (e) {
              reject(
                new Error(`Failed to parse response: ${xhr.responseText}`),
              );
            }
          });
          xhr.addEventListener("error", () => {
            reject(new Error("XHR request failed"));
          });
          xhr.open("POST", "/_sec/verify?provider=interstitial", true);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.send(
            JSON.stringify({
              "bm-verify": bmVerify,
              pow: powValue,
            }),
          );
        });
      },
      finalBmVerify,
      pow,
    );

    debugLog("[Interstitial] Verification response:", result);

    const verifyResponse = result as any;

    // Handle the response
    if (verifyResponse.reload === true) {
      debugLog("[Interstitial] Server requested page reload");
      // Reload without the bm-verify parameter
      const cleanUrl = currentUrl
        .replace(/[?&]bm-verify=[^&]*/, "")
        .replace(/\?$/, "");
      await page.goto(cleanUrl, { waitUntil: "networkidle2" });
    } else if (verifyResponse.location) {
      debugLog(
        `[Interstitial] Server redirecting to: ${verifyResponse.location}`,
      );
      await page.goto(verifyResponse.location, { waitUntil: "networkidle2" });
    } else {
      // Default: reload current page
      debugLog("[Interstitial] Reloading page");
      await page.reload({ waitUntil: "networkidle2" });
    }

    // Wait a moment for any redirects to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error: any) {
    logger.error("[Interstitial] Challenge resolution failed:", error.message);
    throw error;
  }
}

export async function isInterstitialPage(
  page: any,
  debugLog: DebugLog = noopDebug,
): Promise<boolean> {
  const pageContent = await page.content();
  const hasAkamaiLogo = pageContent.includes('id="akam-logo"');
  const hasMetaRefresh = pageContent.includes('http-equiv="refresh"');
  const hasBmVerify = pageContent.includes("bm-verify");
  const hasInterstitialScript = pageContent.includes(
    "triggerInterstitialChallenge",
  );

  debugLog(
    `[Debug] Interstitial detection: akam-logo=${hasAkamaiLogo}, meta-refresh=${hasMetaRefresh}, bm-verify=${hasBmVerify}, challenge-script=${hasInterstitialScript}`,
  );

  return !!(
    hasAkamaiLogo ||
    (hasMetaRefresh && hasBmVerify) ||
    hasInterstitialScript
  );
}

async function handleInterstitialChallenge(
  page: any,
  context: any,
  targetUrl: string,
  labelPrefix: string | null,
  debugLog: DebugLog,
): Promise<boolean> {
  if (!(await isInterstitialPage(page, debugLog))) return false;

  const interstitialLabel = formatSecurityLabel(labelPrefix, "Interstitial");
  try {
    await solveInterstitialChallenge(page, context, targetUrl, debugLog);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return true;
  } catch (err: any) {
    logger.error(
      `[${interstitialLabel}] Failed to solve challenge:`,
      err.message,
    );
    throw err;
  }
}

export async function handleSecurityChallenges(
  page: any,
  context: any,
  targetUrl: string,
  labelPrefix: string | null,
  debugLog: DebugLog = noopDebug,
): Promise<void> {
  const securityLabel = formatSecurityLabel(labelPrefix, "Security");
  let maxIterations = 5;
  let iteration = 0;
  let challengeDetected = true;

  while (challengeDetected && iteration < maxIterations) {
    iteration++;
    debugLog(
      `\n[${securityLabel}] Challenge detection iteration ${iteration}/${maxIterations}`,
    );
    debugLog(`[Debug] Current URL: ${page.url()}`);

    // Wait for page to stabilize
    await waitForPageStable(page, 5000, debugLog);

    // 1. Check if we have the robot button (1st priority)
    if (await handleRobotButton(page, labelPrefix, debugLog)) {
      continue;
    }

    // 2. Check if we have the age verification button (2nd priority - fallback)
    if (await handleAgeCheckButton(page, labelPrefix, debugLog)) {
      continue;
    }

    // 3. Check for and solve interstitial challenge (3rd priority)
    try {
      if (
        await handleInterstitialChallenge(
          page,
          context,
          targetUrl,
          labelPrefix,
          debugLog,
        )
      ) {
        continue;
      }
    } catch {
      challengeDetected = false;
      break;
    }

    // If we get here, no challenges detected
    debugLog(`[${securityLabel}] No challenges detected on current page`);
    challengeDetected = false;
  }

  if (iteration >= maxIterations) {
    debugLog(
      `[${securityLabel}] Max challenge iterations reached, proceeding with current page`,
    );
  }
}
