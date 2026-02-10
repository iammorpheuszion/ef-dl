#!/usr/bin/env bun
/**
 * Epstein Files Downloader CLI
 *
 * An educational tool for downloading documents from the US DOJ Epstein Files portal.
 * This CLI automates the process of searching, downloading metadata (JSON), and
 * downloading PDF files with support for pagination, prefixes, and deduplication.
 *
 * @module index
 * @version 1.0.0
 * @license MIT
 */

// Runtime check - this package requires Bun
if (!process.versions.bun) {
  console.error(
    "\n❌ Error: This package requires Bun runtime and will not work with Node.js.\n" +
      "   The package uses Bun-specific APIs (bun:sqlite) for performance.\n\n" +
      "   Install Bun: https://bun.sh\n" +
      "   Then run: bunx ef-dl\n",
  );
  process.exit(1);
}

// ============================================================================
// SECTION 1: IMPORTS
// ============================================================================

import { Command } from "commander";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { PromptType, type PrefixMode } from "./src/types/enums";
import { downloadPdf, closeBrowser } from "./src/browserless/browser-client";
import {
  installConsoleBridge,
  logger,
  setVerboseMode,
} from "./src/utils/logger";
import { prompt } from "./src/utils/prompt";
import {
  initProgressBars,
  addJsonProgressTask,
  addPdfProgressTask,
  updateJsonProgress,
  updatePdfProgress,
  markTaskDone,
  closeProgressBars,
} from "./src/utils/progress.js";
import {
  cleanupAfterPromptExit,
  fetchSearchResults,
  findExistingPdfFile,
  promptForCleanup,
  showConfiguration,
  showDisclaimerAndVerifyAge,
  showDownloadSummary,
  showHeader,
  type SearchResult,
} from "./src/utils/helpers";
import { Coordinator } from "./src/workers/index.js";

// ============================================================================
// SECTION 2: CONSTANTS & CONFIGURATION
// ============================================================================

/** Application version from package.json */
const packageJsonPath = path.join(import.meta.dirname, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
const VERSION = packageJson.version;
const USE_DEFAULT_DIR = process.env.USE_DEFAULT_DIR === "true";
const DEFAULT_DOWNLOAD_DIR = "./downloads";
const PREFIX_MODES: PrefixMode[] = ["none", "page", "custom"];

function parseAgeCheck(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n"].includes(normalized)) {
      return false;
    }
  }

  console.error(chalk.red("Error: --age must be true or false"));
  process.exit(1);
}

function parseCacheFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n"].includes(normalized)) {
      return false;
    }
  }

  console.error(chalk.red("Error: --cache must be true or false"));
  process.exit(1);
}

function normalizePrefixMode(
  value: string | undefined,
  fallback: PrefixMode,
): PrefixMode {
  if (!value) {
    return fallback;
  }

  const normalized = value.toLowerCase() as PrefixMode;
  if (!PREFIX_MODES.includes(normalized)) {
    console.error(
      chalk.red("Error: --prefix-mode must be one of: none, page, custom"),
    );
    process.exit(1);
  }

  return normalized;
}

function getDefaultPrefixMode(
  prefixMode: string | undefined,
  customPrefix: string | undefined,
): PrefixMode {
  if (prefixMode) {
    return normalizePrefixMode(prefixMode, "none");
  }
  if (customPrefix) {
    return "custom";
  }
  return "none";
}

function getPrefixForPage(
  prefixMode: PrefixMode,
  customPrefix: string | undefined,
  page: number,
): string | undefined {
  if (prefixMode === "custom") {
    return customPrefix;
  }
  if (prefixMode === "page") {
    return String(page);
  }
  return undefined;
}

/** Commander.js program instance */
const program = new Command();

installConsoleBridge();

// ============================================================================
// SECTION 3: PDF DOWNLOAD LOGIC
// ============================================================================

/**
 * Downloads PDFs from JSON search results with deduplication support.
 *
 * Features:
 * - Checks for existing files by filename AND size to prevent duplicates
 * - Renames existing files if prefix doesn't match current preference
 * - Applies prefix based on selected prefix mode
 * - Tracks download progress via callback
 * - Respects rate limits with delays between downloads
 *
 * @param jsonData - Search results containing PDF metadata
 * @param searchTerm - The search query (for directory structure)
 * @param baseDirectory - Base download directory
 * @param pageNumber - Current page number (used for default prefix)
 * @param prefix - Resolved prefix for this page (if any)
 * @param onProgress - Optional callback for progress updates
 * @returns Success and failure counts
 */
async function downloadPdfsFromJson(
  jsonData: SearchResult,
  searchTerm: string,
  baseDirectory: string,
  pageNumber: number,
  prefix: string | undefined,
  onProgress?: (current: number, total: number) => void,
): Promise<{ successCount: number; failCount: number }> {
  const pdfs = jsonData.hits?.hits || [];
  const totalPdfs = pdfs.length;

  if (totalPdfs === 0) {
    return { successCount: 0, failCount: 0 };
  }

  // Create PDF directory: {baseDirectory}/{searchTerm}/pdfs/
  const pdfOutputDir = path.join(baseDirectory, searchTerm, "pdfs");
  if (!fs.existsSync(pdfOutputDir)) {
    fs.mkdirSync(pdfOutputDir, { recursive: true });
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < totalPdfs; i++) {
    const pdf = pdfs[i];
    if (!pdf || !pdf._source) {
      failCount++;
      if (onProgress) onProgress(i + 1, totalPdfs);
      continue;
    }

    const fileName = pdf._source.ORIGIN_FILE_NAME;
    const fileUrl = pdf._source.ORIGIN_FILE_URI;
    const fileSize = pdf._source.fileSize;

    if (!fileName || !fileUrl) {
      failCount++;
      if (onProgress) onProgress(i + 1, totalPdfs);
      continue;
    }

    try {
      // Determine target filename with prefix
      const targetFileName = prefix ? `${prefix}-${fileName}` : fileName;
      const targetFilePath = path.join(pdfOutputDir, targetFileName);

      // Check if file already exists (by name and size)
      const existingFile = findExistingPdfFile(
        fileName,
        pdfOutputDir,
        fileSize,
        prefix,
      );

      if (existingFile) {
        // File exists with correct size
        if (existingFile.needsRename) {
          // Rename to match current prefix preference
          fs.renameSync(existingFile.filePath, targetFilePath);
          console.log(
            chalk.gray(
              `  Renamed: ${path.basename(existingFile.filePath)} → ${targetFileName}`,
            ),
          );
        } else {
          console.log(
            chalk.gray(`  Skipping (already exists): ${targetFileName}`),
          );
        }
        successCount++;
        if (onProgress) onProgress(i + 1, totalPdfs);
        continue;
      }

      // File doesn't exist or size mismatch, download it
      await downloadPdf(fileUrl, pdfOutputDir, fileName, prefix);
      successCount++;
    } catch (error: any) {
      failCount++;
    }

    // Update progress after each PDF
    if (onProgress) onProgress(i + 1, totalPdfs);

    // Small delay between downloads to be respectful to the server
    if (i < totalPdfs - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return { successCount, failCount };
}

// ============================================================================
// SECTION 4: TERMINAL USER INTERFACE
// ============================================================================

// ============================================================================
// SECTION 8: DOWNLOAD WORKFLOWS
// ============================================================================

/**
 * Handles downloading all pages starting from a specific page.
 * First collects all JSON metadata, then downloads PDFs with progress tracking.
 */
async function downloadAllPagesWorkflow(
  searchTerm: string,
  baseDirectory: string,
  startPage: number,
  options: {
    prefixMode: PrefixMode;
    customPrefix?: string;
    verbose: boolean;
  },
): Promise<void> {
  // Fetch first page to get total results count
  const { jsonData: firstPageData } = await fetchSearchResults(
    searchTerm,
    startPage,
    baseDirectory,
  );

  const totalResults = firstPageData.hits?.total?.value || 0;
  const resultsPerPage = 10;
  const totalPages = Math.ceil(totalResults / resultsPerPage);
  const endPage = totalPages;

  console.log(chalk.cyan(`\nDownload Mode: All Pages`));
  console.log(chalk.cyan(`  Total Results: ${totalResults}`));
  console.log(chalk.cyan(`  Total pages: ${totalPages}`));
  console.log(chalk.cyan(`  Starting from page: ${startPage}`));
  console.log(chalk.gray(`\nFetching all JSON data first to count PDFs...\n`));

  // First pass: collect all JSON data and count PDFs
  const allJsonData: SearchResult[] = [];
  let totalPdfCount = 0;

  for (let page = startPage; page <= endPage; page++) {
    try {
      const { jsonData } = await fetchSearchResults(
        searchTerm,
        page,
        baseDirectory,
      );
      allJsonData.push(jsonData);
      const pagePdfCount = jsonData.hits?.hits?.length || 0;
      totalPdfCount += pagePdfCount;
      console.log(chalk.gray(`  Page ${page}: ${pagePdfCount} PDFs`));

      // Small delay between JSON fetches
      if (page < endPage) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error: any) {
      console.error(
        chalk.red(`  Failed to fetch page ${page}: ${error.message}`),
      );
      // Add empty data for failed pages
      allJsonData.push({ hits: { total: { value: 0 }, hits: [] } });
    }
  }

  console.log(chalk.cyan(`\n  Total PDFs to download: ${totalPdfCount}\n`));

  // Initialize progress tracking
  initProgressBars();
  addJsonProgressTask("JSON Pages", allJsonData.length);
  addPdfProgressTask("PDF Downloads", totalPdfCount);
  updateJsonProgress("JSON Pages", allJsonData.length, allJsonData.length);

  // Download PDFs
  let totalSuccessCount = 0;
  let totalFailCount = 0;
  let currentPdfCount = 0;

  for (let i = 0; i < allJsonData.length; i++) {
    const jsonData = allJsonData[i];
    const page = startPage + i;

    if (!jsonData) {
      console.error(chalk.red(`\nSkipping page ${page}: No data available`));
      continue;
    }

    try {
      // Calculate prefix for this specific page
      const pagePrefix = getPrefixForPage(
        options.prefixMode,
        options.customPrefix,
        page,
      );

      const { successCount, failCount } = await downloadPdfsFromJson(
        jsonData,
        searchTerm,
        baseDirectory,
        page,
        pagePrefix,
        (_current: number, _total: number) => {
          currentPdfCount++;
          updatePdfProgress("PDF Downloads", currentPdfCount, totalPdfCount);
        },
      );

      totalSuccessCount += successCount;
      totalFailCount += failCount;

      // Delay between pages
      if (i < allJsonData.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error: any) {
      console.error(
        chalk.red(`\nFailed to process page ${page}: ${error.message}`),
      );
      const pagePdfCount = jsonData.hits?.hits?.length || 0;
      totalFailCount += pagePdfCount;
      currentPdfCount += pagePdfCount;
      updatePdfProgress("PDF Downloads", currentPdfCount, totalPdfCount);
    }
  }

  // Mark tasks as done
  markTaskDone("JSON Pages", "Complete ✓", chalk.blue);
  markTaskDone(
    "PDF Downloads",
    `${totalSuccessCount} downloaded ✓`,
    chalk.green,
  );

  // Cleanup and show summary
  await new Promise((resolve) => setTimeout(resolve, 500));
  closeProgressBars();
  showDownloadSummary(totalSuccessCount, totalFailCount);
}

/**
 * Handles downloading a single page.
 */
async function downloadSinglePageWorkflow(
  searchTerm: string,
  baseDirectory: string,
  pageNumber: number,
  prefixMode: PrefixMode,
  customPrefix?: string,
): Promise<void> {
  console.log(chalk.cyan(`\nDownload Mode: Single Page (${pageNumber})`));
  console.log(chalk.gray(`\nFetching JSON data to count PDFs...\n`));

  // Fetch JSON first to get actual PDF count
  const { jsonData } = await fetchSearchResults(
    searchTerm,
    pageNumber,
    baseDirectory,
  );

  const actualPdfCount = jsonData.hits?.hits?.length || 0;
  console.log(chalk.gray(`  Found ${actualPdfCount} PDFs on this page\n`));

  // Initialize progress tracking
  initProgressBars();
  addJsonProgressTask("JSON Pages", 1);
  addPdfProgressTask("PDF Downloads", actualPdfCount);
  updateJsonProgress("JSON Pages", 1, 1);

  let totalSuccessCount = 0;
  let totalFailCount = 0;
  let currentPdfCount = 0;

  // Download PDFs for this page
  const { successCount, failCount } = await downloadPdfsFromJson(
    jsonData,
    searchTerm,
    baseDirectory,
    pageNumber,
    getPrefixForPage(prefixMode, customPrefix, pageNumber),
    (_current: number, _total: number) => {
      currentPdfCount++;
      updatePdfProgress("PDF Downloads", currentPdfCount, actualPdfCount);
    },
  );

  totalSuccessCount += successCount;
  totalFailCount += failCount;

  // Mark tasks as done
  markTaskDone("JSON Pages", "Complete ✓", chalk.blue);
  markTaskDone(
    "PDF Downloads",
    `${totalSuccessCount} downloaded ✓`,
    chalk.green,
  );

  // Cleanup and show summary
  await new Promise((resolve) => setTimeout(resolve, 500));
  closeProgressBars();
  showDownloadSummary(totalSuccessCount, totalFailCount);
}

/**
 * Displays the download summary to the user.
 */
/**
 * Interactive mode: prompts user for all configuration options.
 * Pre-fills values from command line flags if provided.
 *
 * @param initialOptions - Options pre-filled from command line flags
 * @returns Complete configuration from user input
 */
async function runInteractiveMode(initialOptions: {
  search?: string;
  directory?: string;
  page?: string;
  all?: boolean;
  prefix?: string;
  prefixMode?: string;
  verbose?: boolean;
  workers?: string;
}): Promise<{
  searchTerm: string;
  baseDirectory: string;
  pageNum: number;
  isPageExplicitlySet: boolean;
  allFlag: boolean;
  prefixMode: PrefixMode;
  customPrefix?: string;
  isVerbose: boolean;
  workers: number;
  endPage?: number;
}> {
  console.log(chalk.cyan("\nInteractive Mode\n"));
  console.log(
    chalk.gray("Press Enter to accept default values shown in brackets.\n"),
  );

  // Search term prompt
  const searchTerm: string = await prompt({
    type: PromptType.Input,
    message: "Search term:",
    default: initialOptions.search || "",
    validate: (value) => {
      if (!value || value.trim() === "") {
        return "Search term is required";
      }
      return true;
    },
    cleanup: cleanupAfterPromptExit,
  });

  // Directory prompt
  const baseDirectory: string = USE_DEFAULT_DIR
    ? initialOptions.directory || DEFAULT_DOWNLOAD_DIR
    : await prompt({
        type: PromptType.Input,
        message: "Download directory:",
        default: initialOptions.directory || DEFAULT_DOWNLOAD_DIR,
        validate: (value) => {
          if (!value || value.trim() === "") {
            return "Download directory is required";
          }
          return true;
        },
        cleanup: cleanupAfterPromptExit,
      });

  // Page number prompt
  const pageInput: string = await prompt({
    type: PromptType.Input,
    message: "Page number (leave empty to download all pages):",
    default: initialOptions.page || "",
    cleanup: cleanupAfterPromptExit,
  });
  const isPageExplicitlySet = pageInput.trim() !== "";
  const pageNum = isPageExplicitlySet ? parseInt(pageInput, 10) || 1 : 1;

  // Download mode selection
  let allFlag = initialOptions.all || false;
  if (isPageExplicitlySet) {
    const modeChoice = await prompt({
      type: PromptType.Select,
      message: "Download mode:",
      choices: [
        { name: "Download only this page", value: "single" },
        { name: "Download from this page to the end", value: "all" },
      ],
      default: initialOptions.all ? "all" : "single",
      cleanup: cleanupAfterPromptExit,
    });
    allFlag = modeChoice === "all";
  }

  // Custom prefix prompt
  const defaultPrefixMode = getDefaultPrefixMode(
    initialOptions.prefixMode,
    initialOptions.prefix,
  );

  const prefixMode: PrefixMode = await prompt({
    type: PromptType.Select,
    message: "Filename prefix:",
    choices: [
      { name: "None", value: "none" },
      { name: "Page Number", value: "page" },
      { name: "Custom", value: "custom" },
    ],
    default: defaultPrefixMode,
    cleanup: cleanupAfterPromptExit,
  });

  let customPrefix: string | undefined;
  if (prefixMode === "custom") {
    customPrefix = await prompt({
      type: PromptType.Input,
      message: "Custom prefix text:",
      default: initialOptions.prefix || "",
      validate: (value) => {
        if (!value || value.trim() === "") {
          return "Custom prefix cannot be empty";
        }
        return true;
      },
      cleanup: cleanupAfterPromptExit,
    });
  }

  // Parallel workers
  const workersInput: string = await prompt({
    type: PromptType.Input,
    message: "Number of parallel workers (slowest 1-10 fastest):",
    default: initialOptions.workers || "4",
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 1 || num > 10) {
        return "Please enter a number between 1 and 10";
      }
      return true;
    },
    cleanup: cleanupAfterPromptExit,
  });
  const workers = parseInt(workersInput, 10) || 4;

  // Verbose mode
  const isVerbose: boolean = await prompt({
    type: PromptType.Confirm,
    message: "Enable verbose output?",
    default: initialOptions.verbose || false,
    cleanup: cleanupAfterPromptExit,
  });

  // Calculate endPage for single page downloads
  const endPage = isPageExplicitlySet && !allFlag ? pageNum : undefined;

  return {
    searchTerm,
    baseDirectory,
    pageNum,
    isPageExplicitlySet,
    allFlag,
    prefixMode,
    customPrefix,
    isVerbose,
    workers,
    endPage,
  };
}

// ============================================================================
// SECTION 9: MAIN APPLICATION
// ============================================================================

/**
 * Main application entry point.
 * Handles CLI setup, user interactions, and download workflows.
 */
async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // CLI Setup
  // -------------------------------------------------------------------------
  program
    .name("ef-dl")
    .description("CLI to download Epstein files from justice.gov")
    .version(VERSION)
    .option("--age <boolean>", "Confirm you are 18+ (true/false)")
    .option("-s, --search <term>", "Search term (required)")
    .option("-d, --directory <path>", "Download directory (Required)")
    .option(
      "-p, --page <number>",
      "Page number to download (if not specified, downloads all pages starting from page 1)",
    )
    .option(
      "-a, --all",
      "Download all pages from the specified page number (requires -p). If -p is not set, this is automatically enabled.",
      false,
    )
    .option(
      "--prefix-mode <mode>",
      "Prefix mode: none, page, custom (default: none)",
    )
    .option(
      "--prefix <string>",
      "Custom prefix for PDF filenames (requires --prefix-mode custom)",
    )
    .option("-w, --workers <number>", "Number of parallel workers (1-10)", "4")
    .option("-c, --cache <boolean>", "Keep cache for this search (true/false)")
    .option("-v, --verbose", "Show verbose debug output", false)
    .option(
      "-i, --interactive",
      "Interactive mode: prompt for all options (flags provided will be pre-filled)",
      false,
    )
    .option("-f, --force", "Force fresh start, ignore resume", false)
    .option("--sequential", "Use sequential download (no parallel)", false)
    .configureHelp({
      sortSubcommands: true,
      helpWidth: 80,
    })
    .addHelpText(
      "after",
      `
    Examples (each flag added step-by-step):
    - Interactive mode: bun start
    - Interactive mode (explicit): bun start -i
    - Prefill age check: bun start --age true
    - Prefill search: bun start --age true -s "your search term"
    - Prefill directory: bun start --age true -s "your search term" -d ./downloads
    - Prefill cache: bun start --age true -s "your search term" -d ./downloads -c false
    - Prefill page (single page): bun start --age true -s "your search term" -d ./downloads -p 1
    - Prefill range (from page): bun start --age true -s "your search term" -d ./downloads -p 1 -a
    - Prefill prefix mode (page): bun start --age true -s "your search term" -d ./downloads --prefix-mode page
    - Prefill prefix mode (custom): bun start --age true -s "your search term" -d ./downloads --prefix-mode custom --prefix EPSTEIN
    - Prefill workers: bun start --age true -s "your search term" -d ./downloads -w 10
    - Prefill verbose: bun start --age true -s "your search term" -d ./downloads -v
    - Prefill force: bun start --age true -s "your search term" -d ./downloads -f
    - Sequential mode: bun start --age true -s "your search term" -d ./downloads --sequential
    - Cache: JSON metadata in {downloads_directory}/cache/{search-term}/json/
    - Queue DB: {downloads_directory}/cache/{search-term}/{search-term}.db
    - Files: {downloads_directory}/files/{search-term}/
      `,
    )
    .parse();

  // -------------------------------------------------------------------------
  // Parse Options Early
  // -------------------------------------------------------------------------
  const options = program.opts();
  const ageCheck = parseAgeCheck(options.age);
  const cacheOverride = parseCacheFlag(options.cache);

  // -------------------------------------------------------------------------
  // Setup Signal Handlers for Graceful Interruption
  // -------------------------------------------------------------------------
  let isShuttingDown = false;

  const isExitPromptError = (error: unknown): boolean => {
    return error instanceof Error && error.name === "ExitPromptError";
  };

  const handlePromptExit = (error: unknown): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(chalk.yellow("\n\n⚠ Prompt cancelled by user (Ctrl+C)"));
    logger.info(chalk.gray("Cleaning up resources..."));
    cleanupAfterPromptExit();
    logger.info(chalk.gray("Exiting..."));
    process.exit(130);
  };

  process.on("uncaughtException", (error) => {
    if (isExitPromptError(error)) {
      handlePromptExit(error);
      return;
    }
    logger.error(error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    if (isExitPromptError(reason)) {
      handlePromptExit(reason);
      return;
    }
    logger.error(reason);
    process.exit(1);
  });

  process.on("SIGINT", async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(chalk.yellow("\n\n⚠ Interrupted by user (Ctrl+C)"));
    logger.info(chalk.gray("Cleaning up resources..."));

    // Close progress bars
    logger.info(chalk.gray("- Closing progress bars"));
    closeProgressBars();

    // Close browser instance
    logger.info(chalk.gray("- Closing browser sessions"));
    await closeBrowser().catch(() => {});

    logger.info(chalk.gray("Exiting..."));
    process.exit(130); // 130 = Ctrl+C exit code
  });

  process.on("SIGTERM", async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(chalk.gray("\n\n⚠ Received SIGTERM"));
    logger.info(chalk.gray("Cleaning up resources..."));
    logger.info(chalk.gray("- Closing browser sessions"));
    await closeBrowser().catch(() => {});
    process.exit(143); // 143 = SIGTERM exit code
  });

  // -------------------------------------------------------------------------
  // Check for Interactive Mode or No Arguments
  // -------------------------------------------------------------------------
  // If no arguments provided, default to interactive mode
  const missingRequiredSearch = !options.search;
  const missingRequiredDirectory = !options.directory && !USE_DEFAULT_DIR;
  const shouldFallbackToInteractive =
    missingRequiredSearch || missingRequiredDirectory;
  const isInteractiveMode =
    options.interactive ||
    process.argv.length <= 2 ||
    shouldFallbackToInteractive;

  let searchTerm: string;
  let baseDirectory: string;
  let pageNum: number;
  let startPage: number;
  let endPage: number | undefined;
  let isPageExplicitlySet: boolean;
  let allFlag: boolean;
  let prefixMode: PrefixMode;
  let customPrefix: string | undefined;
  let isVerbose: boolean;
  let downloadAllPages: boolean;
  let workers: number;

  if (isInteractiveMode) {
    // Interactive mode: show header, then age verification
    showHeader(VERSION);

    // Show disclaimer and verify age before proceeding
    await showDisclaimerAndVerifyAge(ageCheck);

    const config = await runInteractiveMode({
      search: options.search,
      directory: options.directory,
      page: options.page,
      all: options.all,
      prefix: options.prefix,
      prefixMode: options.prefixMode,
      verbose: options.verbose,
      workers: options.workers,
    });

    searchTerm = config.searchTerm;
    baseDirectory = config.baseDirectory;
    pageNum = config.pageNum;
    startPage = pageNum;
    endPage = config.endPage;
    isPageExplicitlySet = config.isPageExplicitlySet;
    allFlag = config.allFlag;
    prefixMode = config.prefixMode;
    customPrefix = config.customPrefix;
    isVerbose = config.isVerbose;
    workers = config.workers;
    downloadAllPages = !isPageExplicitlySet || allFlag;
  } else {
    // -------------------------------------------------------------------------
    // Validate required options
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // EF-DL Header
    // -------------------------------------------------------------------------
    showHeader(VERSION);

    // Show disclaimer and verify age before proceeding
    await showDisclaimerAndVerifyAge(ageCheck);

    searchTerm = options.search;
    baseDirectory = options.directory || DEFAULT_DOWNLOAD_DIR;
    isPageExplicitlySet =
      process.argv.includes("-p") || process.argv.includes("--page");
    allFlag = options.all;
    prefixMode = normalizePrefixMode(
      options.prefixMode,
      options.prefix ? "custom" : "none",
    );
    customPrefix = options.prefix;
    isVerbose = options.verbose;

    // Parse page number
    const pageOption = options.page;
    if (isPageExplicitlySet && pageOption) {
      pageNum = parseInt(pageOption, 10);
      if (isNaN(pageNum) || pageNum < 1) {
        console.error(chalk.red("Error: Page must be a positive integer"));
        process.exit(1);
      }
    } else {
      pageNum = 1;
    }

    if (prefixMode === "custom" && !customPrefix) {
      console.error(
        chalk.red("Error: --prefix is required when --prefix-mode is custom"),
      );
      process.exit(1);
    }
    startPage = pageNum;
    downloadAllPages = !isPageExplicitlySet || allFlag;
    endPage = isPageExplicitlySet && !allFlag ? pageNum : undefined;
    workers = parseInt(options.workers, 10);
  }

  // -------------------------------------------------------------------------
  // Apply Settings
  // -------------------------------------------------------------------------
  setVerboseMode(isVerbose);

  // -------------------------------------------------------------------------
  // Display Configuration
  // -------------------------------------------------------------------------
  const useParallel = !options.sequential;

  showConfiguration(
    searchTerm,
    baseDirectory,
    pageNum,
    isPageExplicitlySet,
    allFlag,
    prefixMode,
    customPrefix,
    isVerbose,
    useParallel,
    workers,
  );

  console.log(chalk.green("\nStarting download process...\n"));

  // Ensure base directory exists
  if (!fs.existsSync(baseDirectory)) {
    fs.mkdirSync(baseDirectory, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Execute Download Workflow
  // -------------------------------------------------------------------------
  if (useParallel) {
    // Use parallel download coordinator
    console.log(chalk.blue(`Using parallel mode with ${workers} workers\n`));

    const coordinator = new Coordinator(searchTerm, baseDirectory, {
      startPage,
      endPage,
      workers,
      fresh: options.force,
      verbose: options.verbose,
      prefixMode,
      customPrefix,
      cache: cacheOverride,
    });

    await coordinator.run();
  } else {
    // Use sequential download (legacy mode)
    console.log(chalk.blue("Using sequential mode\n"));

    if (downloadAllPages) {
      await downloadAllPagesWorkflow(searchTerm, baseDirectory, startPage, {
        prefixMode,
        customPrefix,
        verbose: options.verbose,
      });
    } else {
      await downloadSinglePageWorkflow(
        searchTerm,
        baseDirectory,
        startPage,
        prefixMode,
        customPrefix,
      );
    }

    // Legacy cleanup prompt (coordinator has its own)
    await promptForCleanup(baseDirectory, searchTerm, cacheOverride);
  }

  console.log(chalk.green.bold("\nProcess completed successfully!"));
}

// ============================================================================
// SECTION 10: ERROR HANDLING
// ============================================================================

main()
  .catch(async (err) => {
    closeProgressBars();
    console.error(chalk.red(err));
    await closeBrowser().catch(() => {});
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
