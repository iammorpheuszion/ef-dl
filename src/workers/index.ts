/**
 * Parallel Download Module
 *
 * Producer-Consumer Pipeline for parallel PDF downloading.
 *
 * Usage:
 *   import { Coordinator } from "./src/workers/index.js";
 *
 *   const coordinator = new Coordinator("search term", "./downloads", {
 *     workers: 5,
 *     fresh: false,
 *     verbose: false
 *   });
 *
 *   await coordinator.run();
 */

// Main classes
export { Coordinator } from "./coordinator.js";
export { WorkerPool } from "./worker-pool.js";
export { TaskQueue } from "./task-queue.js";

// Worker function
export { runWorker } from "./worker.js";

// Types
export type {
  PdfTask,
  PdfTaskRecord,
  TaskStatus,
  QueueProgress,
  CoordinatorOptions,
  CoordinatorResult,
  WorkerPoolOptions,
  WorkerPoolResult,
  WorkerOptions,
  WorkerResult,
  MetadataKey,
  JusticeGovJson,
} from "./types.js";
