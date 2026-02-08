import { spawn } from "child_process";
import path from "path";
import chalk from "chalk";
import { TaskQueue } from "./task-queue.js";
import type { WorkerPoolOptions, WorkerPoolResult } from "./types.js";
import { logger } from "../utils/logger";
import type { PrefixMode } from "../types/enums.js";

/**
 * Worker Pool Manager
 *
 * Manages a pool of worker processes for parallel PDF downloading.
 * Spawns workers, monitors their health, and coordinates shutdown.
 */
export class WorkerPool {
  private queue: TaskQueue;
  private workerCount: number;
  private options: WorkerPoolOptions;
  private workers: Map<string, ReturnType<typeof spawn>>;
  private results: Map<string, { code: number; signal: string | null }>;
  private searchTerm: string;
  private downloadDir: string;
  private prefixMode: PrefixMode;
  private customPrefix?: string;

  constructor(
    queue: TaskQueue,
    workerCount: number,
    searchTerm: string,
    downloadDir: string,
    options: WorkerPoolOptions = {},
  ) {
    this.queue = queue;
    this.workerCount = Math.max(1, Math.min(10, workerCount)); // Clamp 1-10
    this.options = options;
    this.workers = new Map();
    this.results = new Map();
    this.searchTerm = searchTerm;
    this.downloadDir = downloadDir;
    this.prefixMode = options.prefixMode || "page";
    this.customPrefix = options.customPrefix;
  }

  /**
   * Start all workers
   */
  async start(): Promise<void> {
    if (this.options.verbose) {
      logger.debug(
        chalk.blue(`Starting ${this.workerCount} worker processes...`),
      );
    }

    for (let i = 0; i < this.workerCount; i++) {
      const workerId = `worker-${i + 1}`;
      this.spawnWorker(workerId);
    }

    if (this.options.verbose) {
      logger.debug(chalk.green(`✓ All ${this.workerCount} workers started`));
    }
  }

  /**
   * Spawn a single worker process
   */
  private spawnWorker(workerId: string): void {
    const args = [
      "src/workers/worker.ts",
      "--search",
      this.searchTerm,
      "--directory",
      this.downloadDir,
      "--worker-id",
      workerId,
    ];

    if (this.prefixMode) {
      args.push("--prefix-mode", this.prefixMode);
    }

    if (this.customPrefix) {
      args.push("--prefix", this.customPrefix);
    }

    if (this.options.verbose) {
      args.push("--verbose");
    }

    const worker = spawn("bun", args, {
      stdio: this.options.verbose ? "inherit" : "pipe",
    });

    this.workers.set(workerId, worker);

    // Capture stdout/stderr for debugging
    if (!this.options.verbose) {
      let output = "";
      worker.stdout?.on("data", (data) => {
        output += data.toString();
      });
      worker.stderr?.on("data", (data) => {
        output += data.toString();
        logger.error(chalk.red(`[${workerId}] ${data.toString().trim()}`));
      });

      // Log output on exit if there was an error
      worker.on("close", (code) => {
        if (code !== 0 && output) {
          logger.error(chalk.red(`[${workerId}] Output:\n${output}`));
        }
      });
    }

    // Handle worker exit
    worker.on("close", (code, signal) => {
      this.results.set(workerId, { code: code || 0, signal });
      this.workers.delete(workerId);

      if (this.options.verbose) {
        const status =
          code === 0 ? chalk.green("completed") : chalk.red("failed");
        logger.debug(chalk.gray(`[${workerId}] ${status} (code: ${code})`));
      }
    });

    // Handle worker errors
    worker.on("error", (error) => {
      logger.error(chalk.red(`[${workerId}] Error: ${error.message}`));
      this.results.set(workerId, { code: 1, signal: null });
      this.workers.delete(workerId);
    });

    logger.info(chalk.gray(`[${workerId}] Started`));
  }

  /**
   * Wait for all workers to complete
   */
  async waitForCompletion(): Promise<WorkerPoolResult> {
    if (this.options.verbose) {
      logger.debug(chalk.blue("Waiting for workers to complete..."));
    }

    // Poll until all workers are done
    while (this.workers.size > 0) {
      await sleep(1000);

      // Show progress
      const progress = this.queue.getProgress();
      const activeWorkers = this.workers.size;

      if (this.options.onProgress) {
        this.options.onProgress(progress);
      }

      if (this.options.verbose && activeWorkers > 0) {
        logger.debug(
          chalk.gray(
            `Progress: ${progress.completed}/${progress.total} PDFs (${activeWorkers} workers active)`,
          ),
        );
      }
    }

    if (this.options.onProgress) {
      this.options.onProgress(this.queue.getProgress());
    }

    // Compile results
    const result: WorkerPoolResult = {
      totalWorkers: this.workerCount,
      completedWorkers: 0,
      failedWorkers: 0,
    };

    for (const [workerId, workerResult] of this.results) {
      if (workerResult.code === 0) {
        result.completedWorkers++;
      } else {
        result.failedWorkers++;
      }
    }

    if (this.options.verbose) {
      logger.debug(
        chalk.green(
          `✓ All workers completed: ${result.completedWorkers} succeeded, ${result.failedWorkers} failed`,
        ),
      );
    }

    return result;
  }

  /**
   * Terminate all workers (for graceful shutdown)
   */
  async terminate(): Promise<void> {
    if (this.options.verbose) {
      logger.debug(chalk.yellow("Terminating all workers..."));
    }

    for (const [workerId, worker] of this.workers) {
      worker.kill("SIGTERM");
    }

    // Wait for workers to exit
    const timeout = 10000; // 10 seconds
    const startTime = Date.now();

    while (this.workers.size > 0 && Date.now() - startTime < timeout) {
      await sleep(100);
    }

    // Force kill any remaining workers
    for (const [workerId, worker] of this.workers) {
      if (!worker.killed) {
        worker.kill("SIGKILL");
      }
    }

    if (this.options.verbose) {
      logger.debug(chalk.gray("All workers terminated"));
    }
  }

  /**
   * Get number of active workers
   */
  getActiveWorkerCount(): number {
    return this.workers.size;
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
