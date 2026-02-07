import figlet from "figlet";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to custom fonts directory
const customFontsDir = path.join(__dirname, "..", "..", "fonts");

/**
 * Load a custom figlet font from file
 * @param fontName - Name of the font file (without .flf extension)
 * @returns true if font was loaded successfully, false otherwise
 */
const loadCustomFont = (fontName: string): boolean => {
  try {
    const fontPath = path.join(customFontsDir, `${fontName}.flf`);

    if (fs.existsSync(fontPath)) {
      const fontData = fs.readFileSync(fontPath, "utf8");
      // Parse and load the font into figlet
      figlet.parseFont(fontName, fontData);
      return true;
    }

    return false;
  } catch (error) {
    logger.warn(`Warning: Could not load font ${fontName}:`, error);
    return false;
  }
};

// Try to load the Sub-Zero font
const fontLoaded = loadCustomFont("Sub-Zero");

/**
 * Generate ASCII art text using the Sub-Zero font (or Standard as fallback)
 * @param msg - Message to convert to ASCII art
 * @returns ASCII art string
 */
export const getAsciiArt = (msg: string): string => {
  try {
    // Use Sub-Zero font if loaded, otherwise fallback to Standard
    return figlet.textSync(msg, {
      font: fontLoaded ? "Sub-Zero" : "Standard",
      horizontalLayout: "default",
      verticalLayout: "default",
      width: 80,
      whitespaceBreak: true,
    });
  } catch (error) {
    // If Sub-Zero fails, try Standard
    logger.warn("Warning: Font rendering failed, using Standard font");
    return figlet.textSync(msg, {
      font: "Standard",
      horizontalLayout: "default",
      verticalLayout: "default",
      width: 80,
      whitespaceBreak: true,
    });
  }
};
