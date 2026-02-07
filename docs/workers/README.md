# Documentation Index

## Technical Specifications

### Producer-Consumer Pipeline

**File:** `PRODUCER_CONSUMER_SPEC.md`

Complete technical specification for the parallel download system using a producer-consumer pipeline architecture.

**Contents:**

- Architecture overview with diagrams
- Component specifications (Coordinator, Worker Pool, Workers, Task Queue)
- Database schema and SQL definitions
- Data flow diagrams
- Progress tracking implementation
- Resume logic and error handling
- CLI integration guide
- Testing checklist

**Status:** ✅ Implemented

## Quick Reference

### Key Design Decisions

1. **Architecture**: Producer-Consumer Pipeline with Streaming
   - Coordinator fetches JSON sequentially
   - Workers download PDFs in parallel
   - Workers start immediately (don't wait for all JSON)

2. **Queue Type**: SQLite per search term
   - Location: `{downloadDir}/cache/{search-term}/{search-term}.db`
   - JSON Cache: `{downloadDir}/cache/{search-term}/json/`
   - PDF Downloads: `{downloadDir}/files/{search-term}/`
   - Granularity: PDF-level tasks

3. **Workers**: 5 default, range 1-10
   - Each worker stays alive and processes multiple PDFs
   - Spawns as separate processes

4. **Status Codes**:
   - 0 = Pending
   - 1 = In Progress
   - 2 = Completed
   - 3 = Failed

5. **Resume**: Prompt user when existing queue detected
   - Shows completed/pending/failed counts
   - Option to resume or start fresh

6. **Cleanup**: Cache deletion prompt at end
   - Default: Yes if all downloads successful
   - Default: No if incomplete (for resume)
   - Deletes: `{downloadDir}/cache/{search-term}/` (after closing the queue DB)
   - Preserves: `{downloadDir}/files/{search-term}/`

### Workflow Summary

```
1. User runs command
2. Check for existing queue (resume detection)
3. Fetch page 1 to discover totals and estimate PDFs for the selected page range
4. Start workers (they begin polling)
5. Initialize progress bars
6. Coordinator loop:
   - Fetch JSON for page N
   - Insert PDFs into queue
   - Update JSON progress
7. Workers loop:
   - Claim PDF from queue
   - Download with retry logic
   - Mark complete/failed
   - PDF progress is polled from the queue while JSON fetch continues
8. Signal completion
9. Wait for workers
10. Show summary and cleanup prompt
```

### CLI Flags

```bash
--workers <1-10>    # Number of workers (default: 5)
--fresh             # Force fresh start, ignore resume
--sequential        # Use sequential download (no parallel)
-v, --verbose       # Show worker activity and debug logs
```

### File Structure

```
src/workers/
├── index.ts           # Main exports
├── coordinator.ts     # Producer logic
├── worker-pool.ts     # Worker management
├── task-queue.ts      # SQLite operations
├── types.ts           # TypeScript interfaces
└── worker.ts          # Worker script
```

## Implementation Status

- [x] Architecture designed
- [x] Database schema defined
- [x] Component specifications written
- [x] Data flow documented
- [x] Error handling strategy defined
- [x] Testing checklist created
- [x] Code implementation
- [ ] Unit tests
- [ ] Integration tests

## Next Steps

1. Review this specification
2. Approve or request changes
3. Begin implementation phase
4. Follow testing checklist
5. Update documentation with any changes

---

For detailed implementation guides, see `PRODUCER_CONSUMER_SPEC.md`
