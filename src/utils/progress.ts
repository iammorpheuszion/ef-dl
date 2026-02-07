import { MultiProgressBars } from "multi-progress-bars";
import chalk from "chalk";

// Progress bar manager singleton
let mpb: MultiProgressBars | null = null;

/**
 * Initialize the progress bar manager
 */
export function initProgressBars(): MultiProgressBars {
  if (!mpb) {
    mpb = new MultiProgressBars({
      anchor: "bottom",
      persist: true,
      border: true,
      initMessage: " Download Progress ",
    });
  }
  return mpb;
}

/**
 * Get the progress bar manager instance
 */
export function getProgressBars(): MultiProgressBars | null {
  return mpb;
}

/**
 * Close and cleanup progress bars
 */
export function closeProgressBars(): void {
  if (mpb) {
    mpb.close();
    mpb = null;
  }
}

/**
 * Add a JSON download progress task (Blue)
 */
export function addJsonProgressTask(
  taskName: string,
  totalPages: number,
): void {
  const bars = initProgressBars();
  bars.addTask(taskName, {
    type: "percentage",
    barTransformFn: chalk.blue,
    nameTransformFn: chalk.blue.bold,
    message: `0/${totalPages} pages`,
  });
}

/**
 * Add a PDF download progress task (Green)
 */
export function addPdfProgressTask(taskName: string, totalPdfs: number): void {
  const bars = initProgressBars();
  bars.addTask(taskName, {
    type: "percentage",
    barTransformFn: chalk.green,
    nameTransformFn: chalk.green.bold,
    message: `0/${totalPdfs} PDFs`,
  });
}

/**
 * Update JSON progress
 */
export function updateJsonProgress(
  taskName: string,
  currentPage: number,
  totalPages: number,
): void {
  if (!mpb) return;
  const percentage = currentPage / totalPages;
  mpb.updateTask(taskName, {
    percentage,
    message: `${currentPage}/${totalPages} pages`,
  });
}

/**
 * Update PDF progress
 */
export function updatePdfProgress(
  taskName: string,
  currentPdf: number,
  totalPdfs: number,
): void {
  if (!mpb) return;
  const percentage = currentPdf / totalPdfs;
  mpb.updateTask(taskName, {
    percentage,
    message: `${currentPdf}/${totalPdfs} PDFs`,
  });
}

/**
 * Mark a task as done
 */
export function markTaskDone(
  taskName: string,
  message?: string,
  colorFn?: (text: string) => string,
): void {
  if (!mpb) return;
  mpb.done(taskName, {
    message: message || "Complete",
    barTransformFn: colorFn || chalk.gray,
  });
}

/**
 * Remove a task from the progress bars
 */
export function removeProgressTask(taskName: string): void {
  if (!mpb) return;
  mpb.removeTask(taskName);
}

/**
 * Wait for all progress bars to complete
 */
export async function waitForProgressBars(): Promise<void> {
  if (mpb) {
    await mpb.promise;
  }
}
