# Producer-Consumer Pipeline Technical Specification

## Overview

This document specifies the technical implementation of the parallel download system using a producer-consumer pipeline architecture for the EF-DL (Epstein Files Downloader) application.

## Architecture

### High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                    PRODUCER-CONSUMER PIPELINE                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐                                               │
│  │ Coordinator  │  (Main Process)                               │
│  │  (Producer)  │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│         │  1. Fetches JSON metadata                             │
│         │  2. Inserts PDF tasks into queue                      │
│         │  3. Signals completion                                │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────────────────┐                                    │
│  │    SQLite Task Queue    │                                    │
│  │  {search-term}.db       │                                    │
│  │                         │                                    │
│  │  ┌───────────────────┐  │                                    │
│  │  │ pdf_tasks table   │  │  Status: 0=pending                 │
│  │  │ - search_term     │  │          1=in_progress             │
│  │  │ - page_number     │  │          2=completed               │
│  │  │ - pdf_name        │  │          3=failed                  │
│  │  │ - pdf_url         │  │                                    │
│  │  │ - file_size       │  │                                    │
│  │  │ - status          │  │                                    │
│  │  └───────────────────┘  │                                    │
│  └──────────┬──────────────┘                                    │
│             │                                                   │
│     ┌───────┼───────┐                                           │
│     │       │       │                                           │
│     ▼       ▼       ▼                                           │
│  ┌────┐  ┌────┐  ┌────┐                                         │
│  │ W1 │  │ W2 │  │ W3 │  ... Workers (1-10, default 4)          │
│  └──┬─┘  └──┬─┘  └──┬─┘                                         │
│     │       │       │                                           │
│     │       │       │  Claim PDF tasks (atomic)                 │
│     │       │       │  Download PDFs                            │
│     │       │       │  Mark complete/failed                     │
│     │       │       │                                           │
│     └───────┴───────┘                                           │
│             │                                                   │
│             ▼                                                   │
│  ┌─────────────────────────┐                                    │
│  │ Downloaded PDFs         │                                    │
│  │ {downloadDir}/files/    │                                    │
│  └─────────────────────────┘                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Characteristics

- **Streaming**: Workers start immediately after first JSON is fetched
- **Parallelism**: Multiple workers download PDFs simultaneously
- **Granularity**: Each PDF is an individual task in the queue
- **Resumable**: SQLite queue persists across interruptions
- **Scalable**: 1-10 workers configurable
- **Filename Prefix Modes**: none, page, custom (custom requires --prefix)

## Components

### 1. Coordinator (Producer)

**Location:** `src/workers/coordinator.ts`

**Responsibilities:**

- Discover total pages from initial JSON fetch
- Fetch JSON metadata sequentially with rate limiting
- Parse JSON and insert PDF records into queue
- Signal workers when all JSON fetching is complete
- Manage progress bars (JSON progress)

**Flow:**

1. Check for existing queue (resume detection)
2. Fetch page 1 to discover `hits.total.value`
3. Calculate pages to fetch and estimate total PDFs for progress
4. Start worker pool (workers begin polling)
5. Initialize progress bars
6. Loop through pages:
   - Fetch JSON for page N
   - Save JSON to cache
   - Extract PDFs and insert into queue

- Store metadata: total_pages, total_pdfs (for resume)
- Update JSON progress bar
- Rate limit: 1 second delay between fetches

7. Signal `json_fetch_complete = true` in metadata
8. Wait for workers to finish
9. Display summary and cleanup prompt

**Interface:**

```typescript
export class Coordinator {
  constructor(
    searchTerm: string,
    downloadDir: string,
    options: CoordinatorOptions,
  );

  async run(): Promise<CoordinatorResult>;
}

interface CoordinatorOptions {
  startPage?: number;
  workers?: number;
  fresh?: boolean; // Force fresh start, ignore resume
  verbose?: boolean;
  prefixMode?: "none" | "page" | "custom";
  customPrefix?: string;
  cache?: boolean;
}

interface CoordinatorResult {
  totalPages: number;
  totalPdfs: number;
  completedPdfs: number;
  failedPdfs: number;
  duration: number;
}
```

### 2. Worker Pool Manager

**Location:** `src/workers/worker-pool.ts`

**Responsibilities:**

- Spawn N worker processes
- Monitor worker health
- Wait for all workers to complete
- Handle worker crashes

**Interface:**

```typescript
export class WorkerPool {
  constructor(
    queue: TaskQueue,
    workerCount: number,
    options: WorkerPoolOptions,
  );

  async start(): Promise<void>;
  async waitForCompletion(): Promise<WorkerPoolResult>;
  terminate(): Promise<void>;
}

interface WorkerPoolOptions {
  verbose?: boolean;
  prefixMode?: "none" | "page" | "custom";
  customPrefix?: string;
}

interface WorkerPoolResult {
  totalWorkers: number;
  completedWorkers: number;
  failedWorkers: number;
}
```

### 3. Worker (Consumer)

**Location:** `src/workers/worker.ts`

**Responsibilities:**

- Poll queue for pending PDF tasks
- Claim PDF atomically (sets status=1)
- Download PDF with retry logic (3 attempts)
- Handle security checks (bot, age, Akamai)
- Mark PDF as complete (status=2) or failed (status=3)
- PDF progress is reported by the coordinator polling the queue
- Exit when queue is empty and coordinator signals done

**Flow:**

1. Loop indefinitely:
   a. Claim next pending PDF from queue
   b. If no PDF available:
   - Check if `json_fetch_complete = true`
   - If yes: break loop and exit
   - If no: sleep 500ms and retry
     c. Download PDF (with 3 retry attempts)
     d. Mark as complete or failed
     e. Progress is updated by the coordinator polling the queue
     f. Log activity (if verbose)
2. Exit worker process

**Interface:**

```typescript
export async function runWorker(
  queue: TaskQueue,
  workerId: string,
  options: WorkerOptions,
): Promise<WorkerResult>;

interface WorkerOptions {
  downloadDir: string;
  verbose?: boolean;
  prefixMode?: "none" | "page" | "custom";
  customPrefix?: string;
}

interface WorkerResult {
  workerId: string;
  pdfsProcessed: number;
  pdfsSucceeded: number;
  pdfsFailed: number;
  errors: string[];
}
```

### 4. Task Queue (SQLite)

**Location:** `src/workers/task-queue.ts`

**Responsibilities:**

- Manage SQLite database connection
- Provide atomic operations for task claiming
- Track progress statistics
- Handle resume scenarios
- Clean up on completion

**Database Schema:**

```sql
-- Main task table
CREATE TABLE pdf_tasks (
  id TEXT PRIMARY KEY,
  search_term TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  pdf_name TEXT NOT NULL,
  pdf_url TEXT NOT NULL,
  file_size INTEGER,
  status INTEGER DEFAULT 0,        -- 0=pending, 1=in_progress, 2=completed, 3=failed
  worker_id TEXT,                  -- Which worker claimed this
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,     -- Unix timestamp (ms)
  started_at INTEGER,              -- When worker claimed it
  completed_at INTEGER,            -- When download finished
  error TEXT,                      -- Error message if failed

  UNIQUE(search_term, pdf_name)    -- Prevent duplicates
);

-- Metadata for coordinator signaling
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX idx_status ON pdf_tasks(status);
CREATE INDEX idx_page ON pdf_tasks(page_number);
CREATE INDEX idx_search ON pdf_tasks(search_term);
```

**Interface:**

```typescript
export class TaskQueue {
  constructor(downloadDir: string, searchTerm: string);

  // Check if queue exists
  exists(): boolean;

  // Initialize new queue (clear if exists)
  initialize(): void;

  // Insert PDFs from a page
  insertPdfs(pdfs: PdfTask[]): void;

  // Atomically claim next pending PDF
  claimNextPdf(workerId: string): PdfTask | null;

  // Mark as completed
  markComplete(taskId: string): void;

  // Mark as failed
  markFailed(taskId: string, error: string): void;

  // Get progress statistics
  getProgress(): QueueProgress;

  // Check if all work is done
  isComplete(): boolean;

  // Metadata operations
  setMetadata(key: string, value: string): void;
  getMetadata(key: string): string | null;

  // Reset in-progress tasks (for resume)
  resetInProgress(): void;

  // Check if page already in queue
  hasPage(pageNumber: number): boolean;

  // Close database connection
  close(): void;

  // Delete queue file and cache directory
  delete(): void;
}

interface PdfTask {
  id: string;
  searchTerm: string;
  pageNumber: number;
  pdfName: string;
  pdfUrl: string;
  fileSize: number;
}

interface QueueProgress {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
}
```

## Data Flow

### Initialization Phase

```
User Command: bun index.ts -s "{search_term}" -d ./downloads
                    ↓
1. Check for existing queue
  - Path: ./downloads/cache/{search_term}/{search_term}.db
   - If exists: Show resume prompt
                    ↓
2. Fetch Page 1 JSON
  - Extract hits.total.value (e.g., 1765)
  - Calculate: totalPagesOverall = 177
  - Calculate pagesToFetch = endPage - startPage + 1
  - Estimate totalPdfs = min(pagesToFetch * 10, remaining)
                    ↓
3. Start Worker Pool
   - Spawn 5 worker processes
   - Workers begin polling queue
                    ↓
4. Initialize Progress Bars
   - JSON: 0/177 pages (blue)
   - PDFs: 0/1765 files (green)
```

### Producer Loop (Coordinator)

```
For each page from 1 to 177:
    ↓
1. Check if page already in queue (resume)
   - If yes: Skip fetch, continue
                    ↓
2. Fetch JSON for page N
   - GET https://www.justice.gov/multimedia-search?keys={search_term}&page=N
   - Handle security checks (bot, age, Akamai)
   - Save to: ./downloads/cache/{search_term}/json/page-N.json
                    ↓
3. Parse JSON & Extract PDFs
   - For each hit in json.hits.hits:
     - Extract: ORIGIN_FILE_NAME, ORIGIN_FILE_URI, fileSize
                    ↓
4. Insert PDFs into Queue
   - Generate unique ID: `{searchTerm}_{page}_{pdfName}_{timestamp}`
   - Insert: status=0 (pending)
   - Workers immediately see new tasks!
                    ↓
5. Update JSON Progress Bar
   - Message: "JSON Metadata: N/177 pages"
                    ↓
6. Rate Limiting
   - Sleep 1000ms (if not last page)
                    ↓
End Loop
    ↓
Signal: json_fetch_complete = true
```

### Consumer Loop (Workers)

```
Worker Process Starts
    ↓
Loop:
    ↓
1. Claim Next PDF (Atomic)
   - SQL: UPDATE pdf_tasks SET status=1, worker_id=?, started_at=?
     WHERE status=0 ORDER BY page_number, pdf_name LIMIT 1
     RETURNING *
   - If no rows: No pending work
                    ↓
2. Check Coordinator Status
   - If json_fetch_complete = true AND no pending work:
     → Break loop, exit worker
   - Else:
     → Sleep 500ms, continue loop
                    ↓
3. Download PDF (with retry)
   For attempt = 1 to 3:
       Try:
           - Navigate to pdf_url
           - Handle security checks
           - Download to: ./downloads/files/{search_term}/{page}-{pdfName}
           - Verify file size
           → Success: Break retry loop
       Catch error:
           - Log error (verbose)
           - If attempt < 3: Sleep 2000ms * attempt
           → Continue to next attempt
                    ↓
4. Update Queue Status
   - If success: markComplete(taskId) → status=2
   - If failed: markFailed(taskId, error) → status=3
                    ↓
5. Update Progress Bar
  - Progress is polled from the queue while JSON fetching continues
  - Message: "PDF Downloads: X/1765 files"
                    ↓
6. Log (Verbose Only)
   - "[Worker 3] Completed: EFTA001234.pdf from page 45"
                    ↓
End Loop
```

## Progress Tracking

### JSON Progress (Coordinator)

- **Color:** Blue
- **Updates:** After each JSON fetch
- **Message:** `JSON Metadata: 45/177 pages`

### PDF Progress (Coordinator)

- **Color:** Green
- **Updates:** Polled from queue while workers are running
- **Message:** `PDF Downloads: 450/1765 files`

### Implementation

```typescript
// Initialize progress bars
const mpb = new MultiProgressBars({
  anchor: "bottom",
  persist: true,
  border: true,
  initMessage: " Download Progress ",
});

// Add tasks
mpb.addTask("json", {
  type: "percentage",
  barTransformFn: chalk.blue,
  message: "0/177 pages",
});

mpb.addTask("pdfs", {
  type: "percentage",
  barTransformFn: chalk.green,
  message: "0/1765 files",
});

// Update functions
function updateJsonProgress(current: number, total: number) {
  mpb.updateTask("json", {
    percentage: current / total,
    message: `${current}/${total} pages`,
  });
}

function updatePdfProgress(current: number, total: number) {
  mpb.updateTask("pdfs", {
    percentage: current / total,
    message: `${current}/${total} files`,
  });
}
```

## Resume Logic

### Detection

```typescript
const queuePath = path.join(
  downloadDir,
  "cache",
  searchTerm,
  `${searchTerm}.db`,
);

if (fs.existsSync(queuePath)) {
  const queue = new TaskQueue(downloadDir, searchTerm);
  const progress = queue.getProgress();

  if (progress.completed > 0 || progress.inProgress > 0) {
    // Show resume prompt
    const shouldResume = await askResumePrompt(progress);

    if (shouldResume) {
      // Reset any in-progress tasks back to pending
      queue.resetInProgress();
      return "resume";
    } else {
      // Fresh start
      queue.delete();
      return "fresh";
    }
  }
}

return "fresh";
```

### Resume Prompt

```
🔍 Found previous download of "{search_term}":

   Progress Summary
   ─────────────────
   ✓ Completed: 450 PDFs
   ⏳ In Progress: 0 PDFs
   ⏸ Pending: 1,315 PDFs
   ✗ Failed: 0 PDFs
   ─────────────────
   Total: 1,765 PDFs across 177 pages

Resume where you left off? (Y/n):
```

### Reset In-Progress Tasks

If workers crashed while processing, tasks may be stuck at `status=1`:

```sql
-- Reset all in-progress back to pending
UPDATE pdf_tasks
SET status = 0, worker_id = NULL, started_at = NULL
WHERE status = 1;
```

## Error Handling

### PDF Download Errors

**Retry Strategy:**

- 3 attempts per PDF
- Exponential backoff: 2s, 4s, 6s delays
- After 3 failures: Mark as failed (status=3), continue

**Consecutive Failure Protection:**

- Track consecutive failures per worker
- If 5+ consecutive failures: Worker exits (others continue)
- Prevents zombie workers stuck on bad data

### Worker Crashes

**Detection:**

- Worker process exits unexpectedly
- PDF task remains at `status=1` (in_progress)

**Recovery:**

- On resume: Reset all `status=1` to `status=0`
- Other workers continue processing
- Crashed PDFs get retried

### Coordinator Errors

**JSON Fetch Failure:**

- Log error
- Continue to next page
- PDFs from failed page won't be queued (natural skip)

**Queue Database Errors:**

- Fatal: Exit with error message
- User can retry with `--force` flag

## File Structure

```
{downloadDir}/
├── cache/                                    # All cache data
│   └── {search-term}/                        # Per-search cache folder
│       ├── json/                             # JSON metadata files
│       │   ├── page-1.json
│       │   ├── page-2.json
│       │   └── ...
│       └── {search-term}.db                  # SQLite queue for this search
└── files/                                    # Downloaded PDFs
    └── {search-term}/
        ├── 1-EFTA001.pdf
        ├── 1-EFTA002.pdf
        ├── 2-EFTA011.pdf
        └── ...
```

{downloadDir}/
├── cache/ # All cache data
│ └── {search-term}/ # Per-search cache folder
│ ├── json/ # JSON metadata files
│ │ ├── page-1.json
│ │ ├── page-2.json
│ │ └── ...
│ └── {search-term}.db # SQLite queue for this search
└── files/ # Downloaded PDFs
└── {search-term}/
├── 1-EFTA001.pdf
├── 1-EFTA002.pdf
├── 2-EFTA011.pdf
└── ...

````

## CLI Integration

### New Flags

```typescript
program
  .option('--age <boolean>', 'Confirm you are 18+ (true/false)')
  .option('-w, --workers <number>', 'Number of parallel workers (1-10, default 4)', '4')
  .option('-c, --cache <boolean>', 'Keep cache for this search (true/false)')
  .option('--prefix-mode <mode>', 'Prefix mode: none, page, custom (default: none)')
  .option('--prefix <string>', 'Custom prefix for PDF filenames (requires --prefix-mode custom)')
  .option('-f, --force', 'Force fresh start, ignore resume', false)
  .option('--sequential', 'Use sequential download (no parallel)', false);
````

### Usage Examples

```bash
# Default: 4 workers, auto-detect resume
bun index.ts --age true -s "{search_term}" -d ./downloads

# Custom worker count
bun index.ts --age true -s "{search_term}" -d ./downloads --workers 10
bun index.ts --age true -s "{search_term}" -d ./downloads --workers 3

# Page-number prefix
bun index.ts --age true -s "{search_term}" -d ./downloads --prefix-mode page

# Custom prefix
bun index.ts --age true -s "{search_term}" -d ./downloads --prefix-mode custom --prefix EPSTEIN

# Single page (still uses parallel for PDFs within page)
bun index.ts --age true -s "{search_term}" -p 5 -d ./downloads

# Force fresh start (ignore resume)
bun index.ts --age true -s "{search_term}" -d ./downloads --force

# Fallback to sequential
bun index.ts --age true -s "{search_term}" -d ./downloads --sequential

# Verbose mode (see worker activity)
bun index.ts --age true -s "{search_term}" -d ./downloads -v
```

## Implementation Phases

### Phase 1: Core Infrastructure

1. Create `src/workers/` directory structure
2. Implement `TaskQueue` class with SQLite operations
3. Write unit tests for TaskQueue

### Phase 2: Coordinator

1. Implement `Coordinator` class
2. Add resume detection logic
3. Integrate with existing `fetchPageContent`
4. Add JSON caching

### Phase 3: Workers

1. Implement `WorkerPool` class
2. Create `worker.ts` script
3. Add worker spawn/management logic
4. Integrate with existing `downloadPdf`

### Phase 4: Integration

1. Add CLI flags (`--workers`, `--force`)
2. Create wrapper in `index.ts` to choose parallel vs sequential
3. Update progress bars to show queue-based PDF progress
4. Add cleanup prompt

### Phase 5: Testing

1. Test with small downloads (1-2 pages)
2. Test resume functionality
3. Test error handling and retry logic
4. Test with large downloads (100+ pages)
5. Test edge cases (empty results, all failures, etc.)

## Performance Considerations

### Rate Limiting

- JSON fetches: 1 second delay between pages
- PDF downloads: Existing delays in `downloadPdf` (500ms-2s)
- Worker polling: 500ms sleep when queue empty

### Concurrency

- Recommended: 3-5 workers
- Maximum: 10 workers (configurable)
- Each worker is a separate process (isolation)

### Memory Usage

- Coordinator: Minimal (only tracks progress)
- Workers: ~100-200MB each (browser context)
- Queue: Disk-based SQLite (minimal RAM)
- Total: ~500MB-2GB depending on worker count

### Bottlenecks

- Network I/O (justice.gov response times)
- Security check delays (bot/age/akamai)
- Disk I/O (writing PDFs)

## Security Considerations

### Rate Limiting Compliance

- Built-in delays between requests
- Workers share queue (not coordinated) so natural throttling
- Respect server resources

### Error Recovery

- Workers are isolated processes
- Crash of one worker doesn't affect others
- Queue persists for resume

### Data Integrity

- Atomic task claiming prevents double-download
- File size verification ensures complete downloads
- Unique constraints prevent duplicate queue entries

## Cache Cleanup

### Cleanup Logic

At the end of the download process, the user is prompted to clean up the cache folder:

**Default Behavior:**

- ✅ **All downloads successful** → Default: **YES** (delete cache)
- ⚠️ **Some downloads incomplete/failed** → Default: **NO** (keep cache for resume)

**What Gets Deleted:**

- Entire `{downloadDir}/cache/{search-term}/` directory
- Includes: JSON files + SQLite queue database
- PDFs in `{downloadDir}/files/{search-term}/` are **preserved**

**Example:**

```
SUMMARY
✓ 1765/1765 PDFs downloaded successfully

Clean up cache folder? (removes JSON files and queue database)
Default: Yes if all downloads completed, No if incomplete (y/N): Y
[Deletes ./downloads/cache/{search_term}/]
[Keeps ./downloads/files/{search_term}/]
```

### Implementation

```typescript
async function promptForCleanup(
  downloadDir: string,
  searchTerm: string,
  allSuccessful: boolean,
): Promise<void> {
  const cacheDir = path.join(downloadDir, "cache", searchTerm);

  const defaultValue = allSuccessful; // true = Yes, false = No

  const shouldCleanup = await confirm({
    message: `Clean up cache folder? (removes JSON files and queue database)`,
    default: defaultValue,
  });

  if (shouldCleanup) {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log(chalk.green("✓ Cache cleaned up"));
    }
  } else {
    console.log(chalk.gray("Cache preserved for potential resume"));
  }
}
```

## Summary Report Format

```
╔══════════════════════════════════════════════════╗
║                     SUMMARY                      ║
╠══════════════════════════════════════════════════╣
║ JSON Metadata                                    ║
║   Total Pages: 177                               ║
║   ✓ Downloaded: 177                              ║
║   ✗ Failed: 0                                    ║
║                                                  ║
║ PDF Downloads                                    ║
║   Total PDFs: 1,765                              ║
║   ✓ Downloaded: 1,765                            ║
║   ✗ Failed: 0                                    ║
║   Workers Used: 5                                ║
║                                                  ║
║ Performance                                      ║
║   Duration: 15m 32s                              ║
║   Average: 1.9 PDFs/second                       ║
║   Parallel Speedup: 4.8x                         ║
╚══════════════════════════════════════════════════╝

Clean up cache folder? (removes JSON files and queue database)
Default: Yes if all downloads completed, No if incomplete (y/N):
```

## Testing Checklist

- [ ] Single page download with 5 workers
- [ ] Multi-page download (10+ pages) with 5 workers
- [ ] Resume from partial download
- [ ] Fresh start with `--force` flag
- [ ] Worker crash recovery
- [ ] Network error retry logic
- [ ] Progress bar accuracy
- [ ] Cleanup functionality
- [ ] Verbose logging output
- [ ] Custom worker counts (1, 3, 5, 10)
- [ ] Sequential fallback (`--sequential`)
- [ ] Error summary display
- [ ] Docker container compatibility
- [ ] Ctrl+C interruption handling

## Future Enhancements (Out of Scope)

- Priority queue (download specific pages first)
- Bandwidth throttling
- Proxy rotation for workers
- Web dashboard for progress monitoring
- Distributed workers across multiple machines
- Automatic retry of failed PDFs on resume
- Compression of downloaded files

---

**Document Version:** 1.0  
**Last Updated:** 2024  
**Status:** Ready for Implementation
