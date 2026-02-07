import chalk from "chalk";
import fs from "fs";
import path from "path";
import { PromptType } from "../types/enums";
import { JUSTICE_GOV_SEARCH_URL } from "../types/constants";
import { getAsciiArt } from "./ascii.js";
import { closeBrowser, fetchPageContent } from "../browserless/browser-client";
import { prompt } from "./prompt";
import { closeProgressBars } from "./progress.js";

export interface SearchResult {
  hits: {
    total: { value: number };
    hits: Array<{
      _source: {
        ORIGIN_FILE_NAME: string;
        ORIGIN_FILE_URI: string;
        fileSize: number;
      };
    }>;
  };
}

type ExistingFileResult = {
  filePath: string;
  needsRename: boolean;
  targetName: string;
};

export function findExistingPdfFile(
  fileName: string,
  directory: string,
  fileSize: number,
  prefix: string | undefined,
): ExistingFileResult | null {
  const exactPath = path.join(directory, fileName);

  // Check 1: Exact match (file exists with exact name and size)
  if (fs.existsSync(exactPath)) {
    const stats = fs.statSync(exactPath);
    if (stats.size === fileSize) {
      return {
        filePath: exactPath,
        needsRename: false,
        targetName: fileName,
      };
    }
  }

  // Check 2: Look for files ending with "-{fileName}" (any prefix)
  // This handles cases like: "7-EFTA00340369.pdf" or "EPSTEIN-EFTA00340369.pdf"
  const files = fs.readdirSync(directory);
  const pattern = new RegExp(`-${fileName}$`); // ends with "-EFTA00340369.pdf"

  for (const file of files) {
    if (pattern.test(file)) {
      const filePath = path.join(directory, file);
      const stats = fs.statSync(filePath);
      if (stats.size === fileSize) {
        // Found file with different prefix - calculate target name
        const targetName = prefix ? `${prefix}-${fileName}` : fileName;
        return {
          filePath,
          needsRename: file !== targetName,
          targetName,
        };
      }
    }
  }

  return null;
}

export async function fetchSearchResults(
  searchTerm: string,
  page: number,
  baseDirectory: string,
): Promise<{ jsonData: SearchResult; jsonFilePath: string }> {
  const url = `${JUSTICE_GOV_SEARCH_URL}?keys=${encodeURIComponent(
    searchTerm,
  )}&page=${page}`;

  // Create directory structure: {baseDirectory}/{searchTerm}/json/
  const jsonOutputDir = path.join(baseDirectory, searchTerm, "json");

  const { jsonData, jsonFilePath } = await fetchPageContent(url, {
    saveJson: true,
    jsonOutputDir,
  });

  if (!jsonData) {
    throw new Error("No JSON data extracted from page");
  }

  return { jsonData, jsonFilePath: jsonFilePath! };
}

export async function showDisclaimerAndVerifyAge(): Promise<void> {
  console.log(
    chalk.yellow(
      "\n╔════════════════════════════════════════════════════════════╗",
    ),
  );
  console.log(
    chalk.yellow(
      "║  DISCLAIMER: This application is for EDUCATIONAL PURPOSES  ║",
    ),
  );
  console.log(
    chalk.yellow(
      "╠════════════════════════════════════════════════════════════╣",
    ),
  );
  console.log(
    chalk.yellow(
      "║ By using this application, you certify that:               ║",
    ),
  );
  console.log(
    chalk.yellow(
      "║  • You are 18 years of age or older                        ║",
    ),
  );
  console.log(
    chalk.yellow(
      "║  • You will not use this tool outside of its original use  ║",
    ),
  );
  console.log(
    chalk.yellow(
      "║  • You understand this accesses public documents           ║",
    ),
  );
  console.log(
    chalk.yellow(
      "╚════════════════════════════════════════════════════════════╝\n",
    ),
  );

  const ageVerification = await prompt({
    type: PromptType.Select,
    message: "Are you 18 years of age or older?",
    choices: [
      { name: "Yes, I am 18 +", value: "yes" },
      { name: "No, I am under 18", value: "no" },
    ],
    cleanup: cleanupAfterPromptExit,
  });

  if (ageVerification === "no") {
    console.log(
      chalk.red("\n✖ You must be 18 years or older to use this application."),
    );
    console.log(chalk.red("Exiting...\n"));
    process.exit(1);
  }

  console.log(chalk.green("\n✓ Age verified. Proceeding...\n"));
}

export function showHeader(version: string): void {
  console.log(chalk.red.bold("\n"));
  console.log(chalk.red(getAsciiArt("EF-DL")));
  console.log(
    chalk.red.bold(`\nThe Epstein Files Downloader CLI (Version ${version})`),
  );
}

export async function cleanupAfterPromptExit(): Promise<void> {
  closeProgressBars();
  await closeBrowser().catch(() => {});
}

export function showConfiguration(
  searchTerm: string,
  baseDirectory: string,
  startPage: number,
  isPageExplicitlySet: boolean,
  allFlag: boolean,
  effectivePrefix: string,
  hasCustomPrefix: boolean,
  isVerbose: boolean,
  useParallel: boolean,
  workers: number,
): void {
  console.log(chalk.cyan("\nCollected inputs:"));
  console.log(chalk.white(`  Search term: ${searchTerm}`));

  if (!isPageExplicitlySet) {
    console.log(chalk.white(`  Mode: Download all pages (default)`));
    console.log(chalk.white(`  Starting from page: 1`));
  } else if (allFlag) {
    console.log(
      chalk.white(`  Mode: Download all pages from page ${startPage} to end`),
    );
  } else {
    console.log(chalk.white(`  Mode: Download single page ${startPage}`));
  }

  console.log(chalk.white(`  Directory: ${baseDirectory}`));
  if (hasCustomPrefix) {
    console.log(chalk.white(`  Prefix: ${effectivePrefix} (custom)`));
  } else {
    console.log(chalk.white(`  Prefix: ${effectivePrefix} (page number)`));
  }

  if (useParallel) {
    console.log(chalk.white(`  Download mode: Parallel (${workers} workers)`));
  } else {
    console.log(chalk.white(`  Download mode: Sequential`));
  }

  console.log(chalk.white(`  Verbose: ${isVerbose ? "Yes" : "No"}`));
}

export async function promptForCleanup(
  baseDirectory: string,
  searchTerm: string,
): Promise<void> {
  console.log("");
  const cleanupChoice = await prompt({
    type: PromptType.Select,
    message: "Would you like to clean up JSON files?",
    choices: [
      { name: "Yes", value: "yes" },
      { name: "No", value: "no" },
    ],
    default: "yes",
    cleanup: cleanupAfterPromptExit,
  });

  if (cleanupChoice === "yes") {
    const jsonDir = path.join(baseDirectory, searchTerm, "json");
    if (fs.existsSync(jsonDir)) {
      try {
        fs.rmSync(jsonDir, { recursive: true, force: true });
        console.log(chalk.green(`✓ Cleaned up JSON directory: ${jsonDir}`));
      } catch (error: any) {
        console.error(
          chalk.red(`Failed to clean up JSON directory: ${error.message}`),
        );
      }
    } else {
      console.log(chalk.yellow(`JSON directory not found: ${jsonDir}`));
    }
  }
}

export function showDownloadSummary(
  successCount: number,
  failCount: number,
): void {
  console.log(chalk.cyan(`\n========================================`));
  console.log(chalk.cyan(`Download Summary:`));
  console.log(chalk.green(`  Total PDFs Downloaded: ${successCount}`));
  if (failCount > 0) {
    console.log(chalk.red(`  Total PDFs Failed: ${failCount}`));
  }
  console.log(chalk.cyan(`========================================`));
}
