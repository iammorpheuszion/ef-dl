import path from "path";
import fs from "fs";
import chalk from "chalk";
import { PromptType } from "../types/enums";
import { JUSTICE_GOV_SEARCH_URL } from "../types/constants";
import { TaskQueue } from "./task-queue.js";
import { WorkerPool } from "./worker-pool.js";
import {
  closeBrowser,
  fetchPageContent,
} from "../browserless/browser-client.js";
import { prompt } from "../utils/prompt";
import { logger } from "../utils/logger";
import type {
  CoordinatorOptions,
  CoordinatorResult,
  PdfTask,
  JusticeGovJson,
  QueueProgress,
} from "./types.js";
import {
  initProgressBars,
  addJsonProgressTask,
  addPdfProgressTask,
  updateJsonProgress,
  updatePdfProgress,
  closeProgressBars,
} from "../utils/progress.js";

/**
 * Coordinator (Producer)
 *
 * Manages the parallel download process:
 * 1. Checks for existing queue (resume detection)
 * 2. Discovers total pages from initial JSON fetch
 * 3. Starts workers
 * 4. Fetches JSON metadata and populates queue (streaming)
 * 5. Waits for workers to complete
 * 6. Shows summary and cleanup prompt
 */
export class Coordinator {
  private searchTerm: string;
  private downloadDir: string;
  private options: CoordinatorOptions;
  private queue: TaskQueue;
  private startTime: number;
  private totalPages: number;
  private totalPdfs: number;
  private progressTimer: ReturnType<typeof setInterval> | null;
  private queueDeleted: boolean;

  constructor(
    searchTerm: string,
    downloadDir: string,
    options: CoordinatorOptions = {},
  ) {
    this.searchTerm = searchTerm;
    this.downloadDir = downloadDir;
    this.options = {
      startPage: 1,
      workers: 5,
      fresh: false,
      verbose: false,
      ...options,
    };
    this.queue = new TaskQueue(downloadDir, searchTerm);
    this.startTime = Date.now();
    this.totalPages = 0;
    this.totalPdfs = 0;
    this.progressTimer = null;
    this.queueDeleted = false;
  }

  /**
   * Main run method
   */
  async run(): Promise<CoordinatorResult> {
    try {
      // Phase 1: Check for resume
      const resumeAction = await this.checkResume();

      if (resumeAction === "abort") {
        return {
          totalPages: 0,
          totalPdfs: 0,
          completedPdfs: 0,
          failedPdfs: 0,
          duration: 0,
          workersUsed: 0,
        };
      }

      // Phase 2: Discover totals
      await this.discoverTotals();

      // Phase 3: Start workers
      const workerPool = new WorkerPool(
        this.queue,
        this.options.workers!,
        this.searchTerm,
        this.downloadDir,
        {
          verbose: this.options.verbose,
          onProgress: (progress) => {
            const total = this.totalPdfs || progress.total;
            const completed = progress.completed + progress.failed;
            updatePdfProgress("PDF Downloads", completed, total);
          },
        },
      );

      await workerPool.start();

      // Give workers time to initialize
      await sleep(1000);

      // Phase 4: Initialize progress bars
      this.initializeProgressBars();
      this.startPdfProgressPolling();

      // Phase 5: Producer loop (fetch JSONs)
      await this.producerLoop();

      // Phase 6: Signal completion and wait for workers
      this.queue.setMetadata("json_fetch_complete", "true");
      await workerPool.waitForCompletion();
      this.stopPdfProgressPolling();
      this.finalizePdfProgress();

      // Phase 7: Show summary
      const result = await this.showSummary();

      // Phase 8: Cleanup prompt
      await this.promptForCleanup(result);

      return result;
    } catch (error: any) {
      logger.error(chalk.red(`\nCoordinator error: ${error.message}`));
      throw error;
    } finally {
      this.stopPdfProgressPolling();
      this.finalizePdfProgress();
      if (!this.queueDeleted) {
        this.queue.close();
      }
      closeProgressBars();
    }
  }

  /**
   * Check for existing queue and handle resume
   */
  private async checkResume(): Promise<"resume" | "fresh" | "abort"> {
    if (this.options.fresh || !this.queue.exists()) {
      // Fresh start
      this.queue.initialize();
      return "fresh";
    }

    // Check progress
    const progress = this.queue.getProgress();

    if (progress.completed === 0 && progress.inProgress === 0) {
      // Empty queue, treat as fresh
      this.queue.initialize();
      return "fresh";
    }

    // Show resume prompt
    logger.info(chalk.cyan("\n🔍 Found previous download:"));
    logger.info(chalk.white(`   Search: ${this.searchTerm}`));
    logger.info(chalk.gray("   ─────────────────────────────"));
    logger.info(chalk.green(`   ✓ Completed: ${progress.completed} PDFs`));
    logger.info(
      progress.inProgress > 0
        ? chalk.yellow(`   ⏳ In Progress: ${progress.inProgress} PDFs`)
        : chalk.gray(`   ⏳ In Progress: ${progress.inProgress} PDFs`),
    );
    logger.info(chalk.gray(`   ⏸ Pending: ${progress.pending} PDFs`));
    if (progress.failed > 0) {
      logger.info(chalk.red(`   ✗ Failed: ${progress.failed} PDFs`));
    }
    logger.info(chalk.gray("   ─────────────────────────────"));
    logger.info(chalk.white(`   Total: ${progress.total} PDFs`));
    logger.info("");

    const shouldResume = await prompt({
      type: PromptType.Confirm,
      message: "Resume where you left off?",
      default: true,
      cleanup: () => this.cleanupAfterPromptExit(),
    });

    if (shouldResume) {
      // Reset in-progress tasks back to pending
      this.queue.resetInProgress();
      logger.info(chalk.green("✓ Resuming previous download\n"));
      return "resume";
    } else {
      // Fresh start
      const confirmFresh = await prompt({
        type: PromptType.Confirm,
        message: "Start fresh? This will delete previous progress.",
        default: false,
        cleanup: () => this.cleanupAfterPromptExit(),
      });

      if (!confirmFresh) {
        logger.info(chalk.gray("Aborted."));
        return "abort";
      }

      this.queue.initialize();
      logger.info(chalk.green("✓ Starting fresh\n"));
      return "fresh";
    }
  }

  /**
   * Discover total pages and PDFs from page 1
   */
  private async discoverTotals(): Promise<void> {
    const startPage = this.options.startPage || 1;
    const endPage = this.options.endPage;

    // Check if this is a single page or range download
    const isSinglePage = endPage !== undefined && startPage === endPage;
    const isRange = endPage !== undefined && startPage !== endPage;

    if (isSinglePage) {
      logger.info(chalk.blue(`Fetching page ${startPage}...`));
    } else {
      logger.info(chalk.blue("Discovering total pages..."));
    }

    // Check if we already have the start page in queue (resume scenario)
    if (this.queue.hasPage(startPage)) {
      if (isSinglePage) {
        // For single page, just count the PDFs in that page
        const progress = this.queue.getProgress();
        this.totalPdfs = progress.total;
        this.totalPages = 1;
      } else {
        // Get totals from metadata or calculate from queue
        const totalPagesStr = this.queue.getMetadata("total_pages");
        const totalPdfsStr = this.queue.getMetadata("total_pdfs");
        if (totalPagesStr) {
          this.totalPages = parseInt(totalPagesStr, 10);
        } else {
          const progress = this.queue.getProgress();
          this.totalPages = Math.ceil(progress.total / 10);
        }
        if (totalPdfsStr) {
          const totalPdfsOverall = parseInt(totalPdfsStr, 10);
          const remaining = Math.max(
            0,
            totalPdfsOverall - (startPage - 1) * 10,
          );
          this.totalPdfs = Math.min(this.totalPages * 10, remaining);
        } else {
          this.totalPdfs = this.totalPages * 10;
        }
      }

      logger.info(
        chalk.green(`  ✓ Found ${this.totalPdfs} PDFs (from queue)\n`),
      );
      return;
    }

    // Fetch the start page
    const jsonDir = path.join(
      this.downloadDir,
      "cache",
      this.searchTerm,
      "json",
    );

    const { jsonData } = await fetchPageContent(
      `${JUSTICE_GOV_SEARCH_URL}?keys=${encodeURIComponent(
        this.searchTerm,
      )}&page=${startPage}`,
      {
        saveJson: true,
        jsonOutputDir: jsonDir,
      },
    );

    if (!jsonData) {
      throw new Error(`Failed to fetch page ${startPage}`);
    }

    const data = jsonData as JusticeGovJson;

    if (isSinglePage) {
      // Single page: only count PDFs on this page
      const pdfs = this.extractPdfsFromJson(data, startPage);
      this.totalPdfs = pdfs.length;
      this.totalPages = 1;

      // Insert PDFs from this page only
      this.queue.insertPdfs(pdfs);

      // Verify insertion
      const progress = this.queue.getProgress();
      logger.info(
        chalk.green(
          `  ✓ Found ${this.totalPdfs} PDFs on page ${startPage} (queue: ${progress.total} total)\n`,
        ),
      );
    } else {
      // Full or range download: discover total pages, then calculate pages to fetch
      const totalPdfsOverall = data.hits?.total?.value || 0;
      const totalPagesOverall = Math.ceil(totalPdfsOverall / 10);
      const effectiveEndPage = endPage
        ? Math.min(endPage, totalPagesOverall)
        : totalPagesOverall;
      this.totalPages = Math.max(0, effectiveEndPage - startPage + 1);
      const remaining = Math.max(0, totalPdfsOverall - (startPage - 1) * 10);
      this.totalPdfs = Math.min(this.totalPages * 10, remaining);

      // Store in metadata
      this.queue.setMetadata("total_pages", String(this.totalPages));
      this.queue.setMetadata("total_pdfs", String(totalPdfsOverall));
      this.queue.setMetadata("start_time", String(Date.now()));

      // Insert PDFs from page 1 into queue
      const pdfs = this.extractPdfsFromJson(data, startPage);
      this.queue.insertPdfs(pdfs);

      logger.info(
        chalk.green(
          `  ✓ Found ${this.totalPdfs} PDFs across ${this.totalPages} pages\n`,
        ),
      );
    }
  }

  /**
   * Initialize progress bars
   */
  private initializeProgressBars(): void {
    initProgressBars();
    addJsonProgressTask("JSON Metadata", this.totalPages);
    addPdfProgressTask("PDF Downloads", this.totalPdfs);
  }

  private async cleanupAfterPromptExit(): Promise<void> {
    this.stopPdfProgressPolling();
    closeProgressBars();
    await closeBrowser().catch(() => {});
  }

  private startPdfProgressPolling(): void {
    if (this.progressTimer) {
      return;
    }

    const update = () => {
      const progress = this.queue.getProgress();
      const total = this.totalPdfs || progress.total;
      const completed = progress.completed + progress.failed;
      updatePdfProgress("PDF Downloads", completed, total);
    };

    update();
    this.progressTimer = setInterval(update, 1000);
  }

  private stopPdfProgressPolling(): void {
    if (!this.progressTimer) {
      return;
    }

    clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  private finalizePdfProgress(): void {
    if (this.queueDeleted) {
      return;
    }
    const progress = this.queue.getProgress();
    const total = progress.completed + progress.failed;
    if (total === 0) {
      return;
    }

    this.totalPdfs = total;
    updatePdfProgress("PDF Downloads", total, total);
  }

  /**
   * Producer loop: fetch JSONs and populate queue
   */
  private async producerLoop(): Promise<void> {
    logger.info(chalk.blue("Fetching JSON metadata...\n"));

    const startPage = this.options.startPage || 1;
    const endPage = this.options.endPage
      ? this.options.endPage
      : startPage + this.totalPages - 1;
    const jsonDir = path.join(
      this.downloadDir,
      "cache",
      this.searchTerm,
      "json",
    );
    let processedPages = 0;

    for (let page = startPage; page <= endPage; page++) {
      // Skip if page already in queue (resume)
      if (this.queue.hasPage(page)) {
        if (this.options.verbose) {
          logger.info(chalk.gray(`  Page ${page}: Already in queue`));
        }
        processedPages++;
        updateJsonProgress("JSON Metadata", processedPages, this.totalPages);
        continue;
      }

      try {
        // Fetch JSON
        const { jsonData } = await fetchPageContent(
          `${JUSTICE_GOV_SEARCH_URL}?keys=${encodeURIComponent(
            this.searchTerm,
          )}&page=${page}`,
          {
            saveJson: true,
            jsonOutputDir: jsonDir,
          },
        );

        if (!jsonData) {
          logger.error(chalk.red(`  Page ${page}: Failed to fetch JSON`));
          continue;
        }

        // Extract and insert PDFs
        const data = jsonData as JusticeGovJson;
        const pdfs = this.extractPdfsFromJson(data, page);
        this.queue.insertPdfs(pdfs);

        if (this.options.verbose) {
          logger.info(
            chalk.gray(`  Page ${page}: ${pdfs.length} PDFs added to queue`),
          );
        }

        // Update progress
        processedPages++;
        updateJsonProgress("JSON Metadata", processedPages, this.totalPages);

        // Rate limiting
        if (page < endPage) {
          await sleep(1000);
        }
      } catch (error: any) {
        logger.error(chalk.red(`  Page ${page}: Error - ${error.message}`));
      }
    }

    logger.info(chalk.green("\n✓ All JSON metadata fetched\n"));
  }

  /**
   * Extract PDFs from JSON data
   */
  private extractPdfsFromJson(
    data: JusticeGovJson,
    pageNumber: number,
  ): PdfTask[] {
    const pdfs: PdfTask[] = [];
    const hits = data.hits?.hits || [];
    const timestamp = Date.now();

    for (const hit of hits) {
      const source = hit._source;
      if (source?.ORIGIN_FILE_NAME && source?.ORIGIN_FILE_URI) {
        pdfs.push({
          id: `${this.searchTerm}_${pageNumber}_${source.ORIGIN_FILE_NAME}_${timestamp}`,
          searchTerm: this.searchTerm,
          pageNumber,
          pdfName: source.ORIGIN_FILE_NAME,
          pdfUrl: source.ORIGIN_FILE_URI,
          fileSize: source.fileSize || 0,
        });
      }
    }

    return pdfs;
  }

  /**
   * Show final summary
   */
  private async showSummary(): Promise<CoordinatorResult> {
    const duration = Date.now() - this.startTime;
    const progress = this.queue.getProgress();

    logger.info(
      chalk.white("\n╔══════════════════════════════════════════════════╗"),
    );
    logger.info(
      chalk.white("║                     SUMMARY                      ║"),
    );
    logger.info(
      chalk.white("╠══════════════════════════════════════════════════╣"),
    );
    logger.info(
      chalk.white("║ JSON Metadata                                    ║"),
    );
    logger.info(
      chalk.white(
        `║   Total Pages: ${this.totalPages.toString().padEnd(33)} ║`,
      ),
    );
    logger.info(
      chalk.white(
        `║   ✓ Downloaded: ${this.totalPages.toString().padEnd(32)} ║`,
      ),
    );
    logger.info(chalk.white(`║   ✗ Failed: ${(0).toString().padEnd(36)} ║`));
    logger.info(
      chalk.white("║                                                  ║"),
    );
    logger.info(
      chalk.white("║ PDF Downloads                                    ║"),
    );
    logger.info(
      chalk.white(`║   Total PDFs: ${this.totalPdfs.toString().padEnd(34)} ║`),
    );
    logger.info(
      chalk.white(
        `║   ✓ Downloaded: ${progress.completed.toString().padEnd(32)} ║`,
      ),
    );
    logger.info(
      progress.failed > 0
        ? chalk.red(`║   ✗ Failed: ${progress.failed.toString().padEnd(36)} ║`)
        : chalk.white(`║   ✗ Failed: ${(0).toString().padEnd(36)} ║`),
    );
    logger.info(
      chalk.white(
        `║   Workers Used: ${this.options.workers!.toString().padEnd(32)} ║`,
      ),
    );
    logger.info(
      chalk.white("║                                                  ║"),
    );
    logger.info(
      chalk.white("║ Performance                                      ║"),
    );
    logger.info(
      chalk.white(
        `║   Duration: ${this.formatDuration(duration).padEnd(35)}  ║`,
      ),
    );
    logger.info(
      chalk.white(
        `║   Average: ${this.formatSpeed(duration, progress.completed).padEnd(36)}  ║`,
      ),
    );
    logger.info(
      chalk.white("╚══════════════════════════════════════════════════╝"),
    );
    logger.info("");

    return {
      totalPages: this.totalPages,
      totalPdfs: this.totalPdfs,
      completedPdfs: progress.completed,
      failedPdfs: progress.failed,
      duration,
      workersUsed: this.options.workers!,
    };
  }

  /**
   * Prompt for cleanup
   */
  private async promptForCleanup(result: CoordinatorResult): Promise<void> {
    const cacheDir = path.join(this.downloadDir, "cache", this.searchTerm);
    const allSuccessful = result.failedPdfs === 0;

    const shouldCleanup = await prompt({
      type: PromptType.Confirm,
      message: "Clean up cache folder? (removes JSON files and queue database)",
      default: allSuccessful, // Yes if all successful, No if incomplete
      cleanup: () => this.cleanupAfterPromptExit(),
    });

    if (shouldCleanup) {
      this.stopPdfProgressPolling();
      this.queue.delete();
      this.queueDeleted = true;
      logger.info(chalk.green("✓ Cache cleaned up"));
    } else {
      logger.info(chalk.gray("Cache preserved for potential resume"));
    }
  }

  /**
   * Format duration for display
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Format speed for display
   */
  private formatSpeed(duration: number, completed: number): string {
    const seconds = duration / 1000;
    const rate = completed / seconds;
    return `${rate.toFixed(1)} PDFs/second`;
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
