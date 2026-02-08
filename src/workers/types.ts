/**
 * Type definitions for the parallel download system
 * Producer-Consumer Pipeline Architecture
 */

import type { PrefixMode } from "../types/enums.js";

/**
 * Represents a single PDF task in the queue
 */
export interface PdfTask {
  id: string;
  searchTerm: string;
  pageNumber: number;
  pdfName: string;
  pdfUrl: string;
  fileSize: number;
}

/**
 * Task status codes
 * 0 = Pending (not started)
 * 1 = In Progress (worker claimed it)
 * 2 = Completed (successfully downloaded)
 * 3 = Failed (after retries)
 */
export type TaskStatus = 0 | 1 | 2 | 3;

/**
 * PDF task as stored in the database
 */
export interface PdfTaskRecord extends PdfTask {
  status: TaskStatus;
  workerId: string | null;
  retryCount: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
}

/**
 * Progress statistics for the queue
 */
export interface QueueProgress {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
}

/**
 * Options for the Coordinator
 */
export interface CoordinatorOptions {
  startPage?: number;
  endPage?: number; // For single page or range downloads
  workers?: number;
  fresh?: boolean;
  verbose?: boolean;
  prefixMode?: PrefixMode;
  customPrefix?: string;
  cache?: boolean;
}

/**
 * Result from the Coordinator run
 */
export interface CoordinatorResult {
  totalPages: number;
  totalPdfs: number;
  completedPdfs: number;
  failedPdfs: number;
  duration: number;
  workersUsed: number;
}

/**
 * Options for the WorkerPool
 */
export interface WorkerPoolOptions {
  verbose?: boolean;
  onProgress?: (progress: QueueProgress) => void;
  prefixMode?: PrefixMode;
  customPrefix?: string;
}

/**
 * Result from the WorkerPool
 */
export interface WorkerPoolResult {
  totalWorkers: number;
  completedWorkers: number;
  failedWorkers: number;
}

/**
 * Options for individual workers
 */
export interface WorkerOptions {
  downloadDir: string;
  verbose?: boolean;
  prefixMode?: PrefixMode;
  customPrefix?: string;
}

/**
 * Result from a worker run
 */
export interface WorkerResult {
  workerId: string;
  pdfsProcessed: number;
  pdfsSucceeded: number;
  pdfsFailed: number;
  errors: string[];
}

/**
 * Metadata keys for the queue
 */
export type MetadataKey =
  | "json_fetch_complete"
  | "total_pages"
  | "total_pdfs"
  | "start_time";

/**
 * JSON data structure from justice.gov API
 */
export interface JusticeGovJson {
  hits: {
    total: {
      value: number;
    };
    hits: Array<{
      _source: {
        ORIGIN_FILE_NAME: string;
        ORIGIN_FILE_URI: string;
        fileSize: number;
      };
    }>;
  };
}
