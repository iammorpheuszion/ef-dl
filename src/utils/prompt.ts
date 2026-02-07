import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { PromptType } from "../types/enums";
import { logger } from "./logger";

type CleanupFn = () => Promise<void> | void;

type PromptChoice<T> = {
  name: string;
  value: T;
  description?: string;
  disabled?: boolean | string;
};

type BasePromptOptions = {
  message: string;
  cleanup?: CleanupFn;
};

type InputPromptOptions = BasePromptOptions & {
  type: PromptType.Input;
  default?: string;
  validate?: (value: string) => boolean | string;
};

type ConfirmPromptOptions = BasePromptOptions & {
  type: PromptType.Confirm;
  default?: boolean;
};

type SelectPromptOptions<T> = BasePromptOptions & {
  type: PromptType.Select;
  choices: PromptChoice<T>[];
  default?: T;
  pageSize?: number;
};

export type PromptOptions<T> =
  | InputPromptOptions
  | ConfirmPromptOptions
  | SelectPromptOptions<T>;

function isExitPromptError(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}

async function handlePromptExit(cleanup?: CleanupFn): Promise<never> {
  logger.info(chalk.yellow("\n\n⚠ Prompt cancelled by user (Ctrl+C)"));
  logger.info(chalk.gray("Cleaning up resources..."));
  if (cleanup) {
    await cleanup();
  }
  logger.info(chalk.gray("Exiting..."));
  process.exit(130);
}

export async function prompt<T>(options: PromptOptions<T>): Promise<T> {
  try {
    switch (options.type) {
      case PromptType.Input:
        return (await input({
          message: options.message,
          default: options.default,
          validate: options.validate,
        })) as T;
      case PromptType.Confirm:
        return (await confirm({
          message: options.message,
          default: options.default,
        })) as T;
      case PromptType.Select:
        return (await select({
          message: options.message,
          choices: options.choices,
          default: options.default,
          pageSize: options.pageSize,
        })) as T;
      default:
        throw new Error("Unsupported prompt type");
    }
  } catch (error) {
    if (isExitPromptError(error)) {
      await handlePromptExit(options.cleanup);
    }
    throw error;
  }
}
