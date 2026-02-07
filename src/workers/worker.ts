#!/usr/bin/env bun
/**
 * Worker Script
 *
 * Individual worker process that:
 * 1. Claims PDF tasks from the queue
 * 2. Downloads PDFs with retry logic
 * 3. Updates task status
 * 4. Exits when all work is done
 *
 * Usage:
 *   bun src/workers/worker.ts --search "term" --directory ./downloads --worker-id "worker-1"
 */

import { parseArgs } from "util";
import path from "path";
import { TaskQueue } from "./task-queue.js";
import { downloadPdf } from "../browserless/browser-client.js";
import type { WorkerOptions, WorkerResult } from "./types.js";
import chalk from "chalk";
import { logger, setVerboseMode } from "../utils/logger";

function isDatabaseLocked(error: unknown): boolean {
  return error instanceof Error && /database is locked/i.test(error.message);
}

async function withDbLockRetry<T>(
  workerId: string,
  action: () => T,
  actionLabel: string,
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return action();
    } catch (error) {
      if (!isDatabaseLocked(error)) {
        throw error;
      }

      attempt += 1;
      logger.warn(
        chalk.yellow(
          `[${workerId}] Queue busy (${actionLabel}). Waiting to retry...`,
        ),
      );

      if (attempt >= 5) {
        throw error;
      }

      await sleep(300 * attempt);
    }
  }
}

/**
 * Main worker function
 */
async function runWorker(
  searchTerm: string,
  downloadDir: string,
  workerId: string,
  verbose: boolean,
): Promise<WorkerResult> {
  setVerboseMode(verbose);
  logger.debug(chalk.gray(`[${workerId}] Initializing...`));

  let queue: TaskQueue;
  try {
    queue = new TaskQueue(downloadDir, searchTerm);
  } catch (error: any) {
    logger.error(
      chalk.red(`[${workerId}] Failed to create queue: ${error.message}`),
    );
    return {
      workerId,
      pdfsProcessed: 0,
      pdfsSucceeded: 0,
      pdfsFailed: 0,
      errors: [`Queue creation failed: ${error.message}`],
    };
  }

  const result: WorkerResult = {
    workerId,
    pdfsProcessed: 0,
    pdfsSucceeded: 0,
    pdfsFailed: 0,
    errors: [],
  };

  let consecutiveErrors = 0;

  try {
    logger.debug(chalk.gray(`[${workerId}] Started`));

    while (true) {
      // 1. Claim next PDF from queue
      const pdf = await withDbLockRetry(
        workerId,
        () => queue.claimNextPdf(workerId),
        "claim",
      );

      if (!pdf) {
        // No PDF available, check if coordinator is done
        const isComplete = queue.getMetadata("json_fetch_complete");
        const progress = queue.getProgress();

        if (isComplete === "true") {
          // All work is done
          logger.info(
            chalk.gray(
              `[${workerId}] No more work (completed: ${progress.completed}/${progress.total}), exiting`,
            ),
          );
          break;
        }

        // Coordinator still fetching JSON, wait and retry
        await sleep(500);
        continue;
      }

      result.pdfsProcessed++;

      logger.info(
        chalk.gray(
          `[${workerId}] Processing: ${pdf.pdfName} from page ${pdf.pageNumber}`,
        ),
      );

      // 2. Download PDF with retry logic
      let success = false;
      let lastError = "";

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // Download PDF
          const pdfOutputDir = path.join(downloadDir, "files", searchTerm);

          await downloadPdf(
            pdf.pdfUrl,
            pdfOutputDir,
            pdf.pdfName,
            String(pdf.pageNumber),
          );

          success = true;
          consecutiveErrors = 0;
          break;
        } catch (error: any) {
          lastError = error.message || "Unknown error";

          logger.debug(
            chalk.yellow(
              `[${workerId}] Attempt ${attempt}/3 failed for ${pdf.pdfName}: ${lastError}`,
            ),
          );

          if (attempt < 3) {
            // Exponential backoff: 2s, 4s, 6s
            await sleep(2000 * attempt);
          }
        }
      }

      // 3. Update queue status
      if (success) {
        await withDbLockRetry(
          workerId,
          () => queue.markComplete(pdf.id),
          "mark complete",
        );
        result.pdfsSucceeded++;

        logger.debug(chalk.green(`[${workerId}] Completed: ${pdf.pdfName}`));
      } else {
        await withDbLockRetry(
          workerId,
          () => queue.markFailed(pdf.id, lastError),
          "mark failed",
        );
        result.pdfsFailed++;
        result.errors.push(`${pdf.pdfName}: ${lastError}`);
        consecutiveErrors++;

        logger.error(
          chalk.red(`[${workerId}] Failed: ${pdf.pdfName} - ${lastError}`),
        );

        // Safety valve: if too many consecutive errors, worker exits
        if (consecutiveErrors >= 5) {
          logger.error(
            chalk.red(`[${workerId}] Too many consecutive failures, exiting`),
          );
          break;
        }
      }
    }
  } catch (error: any) {
    if (isDatabaseLocked(error)) {
      logger.warn(
        chalk.yellow(
          `[${workerId}] Queue busy (database locked). Waiting to retry...`,
        ),
      );
      result.errors.push(`Queue busy: ${error.message}`);
    } else {
      logger.error(chalk.red(`[${workerId}] Fatal error: ${error.message}`));
      result.errors.push(`Fatal: ${error.message}`);
    }
  } finally {
    queue.close();
  }

  logger.debug(
    chalk.gray(
      `[${workerId}] Finished: ${result.pdfsSucceeded} succeeded, ${result.pdfsFailed} failed`,
    ),
  );

  return result;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run worker if executed directly
if (import.meta.main) {
  // Parse command line arguments only when run directly
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      search: { type: "string", short: "s" },
      directory: { type: "string", short: "d" },
      "worker-id": { type: "string", default: "worker-1" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    logger.info(`
${chalk.cyan("EF-DL Worker")} - Parallel download worker

Usage:
  bun src/workers/worker.ts [options]

Options:
  -s, --search <term>      Search term (required)
  -d, --directory <path>   Download directory (required)
  --worker-id <id>         Worker identifier for logging
  -v, --verbose           Enable verbose output
  -h, --help              Show this help message
`);
    process.exit(0);
  }

  if (!values.search || !values.directory) {
    logger.error(chalk.red("Error: --search and --directory are required"));
    process.exit(1);
  }

  const searchTerm = values.search;
  const downloadDir = values.directory;
  const workerId = values["worker-id"] || "worker-1";
  const verbose = values.verbose || false;
  setVerboseMode(verbose);

  runWorker(searchTerm, downloadDir, workerId, verbose)
    .then((result) => {
      // Exit with error code if any PDFs failed
      process.exit(result.pdfsFailed > 0 ? 1 : 0);
    })
    .catch((error) => {
      logger.error(chalk.red(`Worker error: ${error.message}`));
      process.exit(1);
    });
}

export { runWorker };
