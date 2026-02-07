import Database from "bun:sqlite";
import path from "path";
import fs from "fs";
import type {
  PdfTask,
  PdfTaskRecord,
  QueueProgress,
  TaskStatus,
  MetadataKey,
} from "./types.js";

/**
 * Task Queue Manager
 *
 * Manages a SQLite-backed queue for distributing download tasks across
 * multiple worker subagents. Provides atomic operations for task claiming
 * and status updates.
 *
 * Queue location: {downloadDir}/cache/{searchTerm}/{searchTerm}.db
 */
export class TaskQueue {
  private db: Database;
  private dbPath: string;
  private cacheDir: string;
  private searchTerm: string;
  private isClosed: boolean;

  constructor(downloadDir: string, searchTerm: string) {
    this.searchTerm = searchTerm;
    this.cacheDir = path.join(downloadDir, "cache", searchTerm);

    // Ensure cache directory exists
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    this.dbPath = path.join(this.cacheDir, `${searchTerm}.db`);
    this.db = new Database(this.dbPath);
    this.isClosed = false;

    // Enable WAL mode for better concurrency (multiple readers + 1 writer)
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 3000"); // Wait up to 5 seconds if database is locked

    this.initializeTables();
  }

  /**
   * Initialize database tables
   */
  private initializeTables(): void {
    // Main task table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pdf_tasks (
        id TEXT PRIMARY KEY,
        search_term TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        pdf_name TEXT NOT NULL,
        pdf_url TEXT NOT NULL,
        file_size INTEGER,
        status INTEGER DEFAULT 0,
        worker_id TEXT,
        retry_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        UNIQUE(search_term, pdf_name)
      )
    `);

    // Metadata table for coordinator signaling
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Indexes for performance
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_status ON pdf_tasks(status)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_page ON pdf_tasks(page_number)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_search ON pdf_tasks(search_term)
    `);
  }

  /**
   * Check if queue database exists
   */
  exists(): boolean {
    return fs.existsSync(this.dbPath);
  }

  /**
   * Initialize new queue (clear if exists)
   */
  initialize(): void {
    // Clear existing data
    this.db.run("DELETE FROM pdf_tasks");
    this.db.run("DELETE FROM metadata");
  }

  /**
   * Insert PDFs from a page into the queue
   */
  insertPdfs(pdfs: PdfTask[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO pdf_tasks 
      (id, search_term, page_number, pdf_name, pdf_url, file_size, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();

    for (const pdf of pdfs) {
      insert.run(
        pdf.id,
        pdf.searchTerm,
        pdf.pageNumber,
        pdf.pdfName,
        pdf.pdfUrl,
        pdf.fileSize,
        0, // status = pending
        now,
      );
    }
  }

  /**
   * Atomically claim next pending PDF
   * Returns null if no pending PDFs available
   */
  claimNextPdf(workerId: string): PdfTaskRecord | null {
    const now = Date.now();

    // Start transaction
    this.db.run("BEGIN TRANSACTION");

    try {
      // Find next pending PDF
      const row = this.db
        .query(
          `
        SELECT * FROM pdf_tasks 
        WHERE status = 0
        ORDER BY page_number, pdf_name
        LIMIT 1
      `,
        )
        .get() as any;

      if (!row) {
        this.db.run("COMMIT");
        return null;
      }

      // Update status to in_progress
      this.db.run(
        `
        UPDATE pdf_tasks 
        SET status = 1, worker_id = ?, started_at = ?
        WHERE id = ?
      `,
        [workerId, now, row.id],
      );

      this.db.run("COMMIT");

      return {
        id: row.id,
        searchTerm: row.search_term,
        pageNumber: row.page_number,
        pdfName: row.pdf_name,
        pdfUrl: row.pdf_url,
        fileSize: row.file_size,
        status: 1,
        workerId: workerId,
        retryCount: row.retry_count,
        createdAt: row.created_at,
        startedAt: now,
        completedAt: null,
        error: null,
      };
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  /**
   * Mark a PDF as completed
   */
  markComplete(taskId: string): void {
    this.db.run(
      `
      UPDATE pdf_tasks 
      SET status = 2, completed_at = ?, error = NULL
      WHERE id = ?
    `,
      [Date.now(), taskId],
    );
  }

  /**
   * Mark a PDF as failed
   */
  markFailed(taskId: string, error: string): void {
    this.db.run(
      `
      UPDATE pdf_tasks 
      SET status = 3, completed_at = ?, error = ?
      WHERE id = ?
    `,
      [Date.now(), error, taskId],
    );
  }

  /**
   * Get progress statistics
   */
  getProgress(): QueueProgress {
    const result = this.db
      .query(
        `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END) as failed
      FROM pdf_tasks
      WHERE search_term = ?
    `,
      )
      .get(this.searchTerm) as any;

    return {
      total: result.total || 0,
      pending: result.pending || 0,
      inProgress: result.in_progress || 0,
      completed: result.completed || 0,
      failed: result.failed || 0,
    };
  }

  /**
   * Check if all work is done
   */
  isComplete(): boolean {
    // Check if json_fetch_complete is set
    const fetchComplete = this.getMetadata("json_fetch_complete");

    if (fetchComplete !== "true") {
      return false;
    }

    // Check if any pending or in_progress tasks remain
    const result = this.db
      .query(
        `
      SELECT COUNT(*) as count 
      FROM pdf_tasks 
      WHERE search_term = ? AND status IN (0, 1)
    `,
      )
      .get(this.searchTerm) as any;

    return result.count === 0;
  }

  /**
   * Set metadata value
   */
  setMetadata(key: MetadataKey, value: string): void {
    this.db.run(
      `
      INSERT OR REPLACE INTO metadata (key, value)
      VALUES (?, ?)
    `,
      [key, value],
    );
  }

  /**
   * Get metadata value
   */
  getMetadata(key: MetadataKey): string | null {
    const result = this.db
      .query("SELECT value FROM metadata WHERE key = ?")
      .get(key) as any;
    return result ? result.value : null;
  }

  /**
   * Reset in-progress tasks back to pending (for resume)
   */
  resetInProgress(): void {
    this.db.run(
      `
      UPDATE pdf_tasks 
      SET status = 0, worker_id = NULL, started_at = NULL 
      WHERE status = 1 AND search_term = ?
    `,
      [this.searchTerm],
    );
  }

  /**
   * Check if a page already has tasks in the queue
   */
  hasPage(pageNumber: number): boolean {
    const result = this.db
      .query(
        `
      SELECT COUNT(*) as count 
      FROM pdf_tasks 
      WHERE search_term = ? AND page_number = ?
    `,
      )
      .get(this.searchTerm, pageNumber) as any;

    return result.count > 0;
  }

  /**
   * Get all failed tasks
   */
  getFailedTasks(): PdfTaskRecord[] {
    const rows = this.db
      .query(
        `
      SELECT * FROM pdf_tasks 
      WHERE search_term = ? AND status = 3
      ORDER BY page_number, pdf_name
    `,
      )
      .all(this.searchTerm) as any[];

    return rows.map((row) => this.rowToTaskRecord(row));
  }

  /**
   * Convert database row to PdfTaskRecord
   */
  private rowToTaskRecord(row: any): PdfTaskRecord {
    return {
      id: row.id,
      searchTerm: row.search_term,
      pageNumber: row.page_number,
      pdfName: row.pdf_name,
      pdfUrl: row.pdf_url,
      fileSize: row.file_size,
      status: row.status as TaskStatus,
      workerId: row.worker_id,
      retryCount: row.retry_count,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.db.close();
    this.isClosed = true;
  }

  /**
   * Delete queue file and cache directory
   */
  delete(): void {
    this.close();
    if (fs.existsSync(this.cacheDir)) {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
    }
  }
}
