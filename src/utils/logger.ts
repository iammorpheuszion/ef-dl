const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let isVerbose = false;

export function setVerboseMode(verbose: boolean): void {
  isVerbose = verbose;
}

function logWith(
  method: "log" | "warn" | "error",
  args: unknown[]
): void {
  originalConsole[method](...args);
}

export const logger = {
  debug(...args: unknown[]): void {
    if (!isVerbose) {
      return;
    }
    logWith("log", args);
  },
  info(...args: unknown[]): void {
    logWith("log", args);
  },
  warn(...args: unknown[]): void {
    logWith("warn", args);
  },
  error(...args: unknown[]): void {
    logWith("error", args);
  },
};

export function installConsoleBridge(): void {
  console.log = (...args: unknown[]) => logger.info(...args);
  console.warn = (...args: unknown[]) => logger.warn(...args);
  console.error = (...args: unknown[]) => logger.error(...args);
}
