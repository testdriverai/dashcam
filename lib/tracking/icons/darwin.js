import { logger } from "../../logger.js";

const getIconAsBuffer = async (bundleId) => {
  try {
    // Try to import the file-icon package for macOS icon extraction
    // This may fail in pkg builds where native modules don't work
    const { fileIconToBuffer } = await import("file-icon");

    logger.debug("Extracting icon for macOS app", { bundleId });
    
    const buffer = await fileIconToBuffer(bundleId);
    if (!buffer) {
      logger.debug("No icon buffer returned for bundle", { bundleId });
      return null;
    }
    
    logger.debug("Successfully extracted macOS icon", { 
      bundleId, 
      bufferSize: buffer.length 
    });
    
    return { extension: "png", buffer };
  } catch (error) {
    // Don't log warnings for module loading errors in pkg builds
    if (error.code === 'MODULE_NOT_FOUND' || error.message.includes('Dynamic require')) {
      logger.debug("Icon extraction unavailable (native module not loaded)", {
        isPkg: typeof process.pkg !== 'undefined'
      });
    } else {
      logger.warn("Failed to extract macOS icon", { 
        bundleId, 
        error: error.message 
      });
    }
    return null;
  }
};

export { getIconAsBuffer };
