declare module "browserless" {
  type BrowserlessInstance = {
    createContext: () => Promise<BrowserlessContext>;
    respawn: () => Promise<unknown>;
    browser: () => Promise<unknown>;
    close: (opts?: { force?: boolean }) => Promise<unknown>;
    isClosed: () => boolean;
  };

  type BrowserlessContext = {
    page: () => Promise<any>;
    goto: (
      page: any,
      options: { url: string; timeout?: number; waitUntil?: string },
    ) => Promise<{ response?: unknown; error?: unknown }>;
    withPage: <T>(
      fn: (
        page: any,
        goto: (
          page: any,
          options: { url: string; timeout?: number; waitUntil?: string },
        ) => Promise<{ response?: unknown; error?: unknown }>,
      ) => (url: string) => Promise<T>,
    ) => (url: string) => Promise<T>;
    destroyContext: (opts?: { force?: boolean }) => Promise<void>;
  };

  export default function createBrowserless(
    options?: Record<string, unknown>,
  ): BrowserlessInstance;
}
