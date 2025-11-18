import { logger } from "../../logger.js";
import { execa } from "execa";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Find icon for a Linux application using various strategies
 */
const findLinuxIcon = async (appName) => {
  // Strategy 1: Look for .desktop file
  const desktopFile = await findDesktopFile(appName);
  if (desktopFile) {
    const iconName = await extractIconFromDesktop(desktopFile);
    if (iconName) {
      const iconPath = await findIconInTheme(iconName);
      if (iconPath) {
        logger.debug("Found icon via .desktop file", { appName, iconPath });
        return iconPath;
      }
    }
  }

  // Strategy 2: Try to find icon directly in icon themes
  const iconPath = await findIconInTheme(appName);
  if (iconPath) {
    logger.debug("Found icon in theme", { appName, iconPath });
    return iconPath;
  }

  // Strategy 3: Common application paths
  const commonPaths = [
    `/usr/share/pixmaps/${appName}.png`,
    `/usr/share/pixmaps/${appName}.svg`,
    `/usr/share/icons/hicolor/48x48/apps/${appName}.png`,
    `/usr/share/icons/hicolor/scalable/apps/${appName}.svg`,
  ];

  for (const iconPath of commonPaths) {
    if (fs.existsSync(iconPath)) {
      logger.debug("Found icon in common path", { appName, iconPath });
      return iconPath;
    }
  }

  logger.debug("No icon found for Linux app", { appName });
  return null;
};

/**
 * Find .desktop file for an application
 */
const findDesktopFile = async (appName) => {
  const desktopDirs = [
    "/usr/share/applications",
    "/usr/local/share/applications",
    path.join(os.homedir(), ".local/share/applications"),
  ];

  // Try exact match first
  for (const dir of desktopDirs) {
    const desktopFile = path.join(dir, `${appName}.desktop`);
    if (fs.existsSync(desktopFile)) {
      return desktopFile;
    }
  }

  // Try case-insensitive search
  for (const dir of desktopDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      
      const files = fs.readdirSync(dir);
      const match = files.find(
        (f) => f.toLowerCase() === `${appName.toLowerCase()}.desktop`
      );
      if (match) {
        return path.join(dir, match);
      }
    } catch (error) {
      logger.debug("Error reading desktop directory", { dir, error: error.message });
    }
  }

  return null;
};

/**
 * Extract icon name from .desktop file
 */
const extractIconFromDesktop = async (desktopFilePath) => {
  try {
    const content = fs.readFileSync(desktopFilePath, "utf8");
    const iconMatch = content.match(/^Icon=(.+)$/m);
    if (iconMatch) {
      return iconMatch[1].trim();
    }
  } catch (error) {
    logger.debug("Error reading desktop file", { 
      desktopFilePath, 
      error: error.message 
    });
  }
  return null;
};

/**
 * Find icon in XDG icon themes
 */
const findIconInTheme = async (iconName) => {
  // Common icon theme locations and sizes
  const iconThemes = ["hicolor", "gnome", "Adwaita", "breeze", "oxygen"];
  const iconSizes = ["48x48", "64x64", "scalable", "128x128", "256x256"];
  const iconFormats = ["png", "svg", "xpm"];

  const searchPaths = [
    "/usr/share/icons",
    "/usr/local/share/icons",
    path.join(os.homedir(), ".local/share/icons"),
    path.join(os.homedir(), ".icons"),
  ];

  for (const basePath of searchPaths) {
    if (!fs.existsSync(basePath)) continue;

    for (const theme of iconThemes) {
      const themePath = path.join(basePath, theme);
      if (!fs.existsSync(themePath)) continue;

      for (const size of iconSizes) {
        const sizePath = path.join(themePath, size, "apps");
        if (!fs.existsSync(sizePath)) continue;

        for (const format of iconFormats) {
          const iconPath = path.join(sizePath, `${iconName}.${format}`);
          if (fs.existsSync(iconPath)) {
            return iconPath;
          }
        }
      }
    }
  }

  return null;
};

/**
 * Convert image to PNG if needed
 */
const convertToPng = async (iconPath) => {
  const ext = path.extname(iconPath).toLowerCase();
  
  // If already PNG, read and return
  if (ext === ".png") {
    return fs.readFileSync(iconPath);
  }

  // For SVG, try to convert using ImageMagick or rsvg-convert
  if (ext === ".svg") {
    const tmpPngPath = path.join(os.tmpdir(), `icon-${Date.now()}.png`);
    
    try {
      // Try rsvg-convert first (commonly available on Linux)
      await execa("rsvg-convert", [
        "-w", "48",
        "-h", "48",
        "-o", tmpPngPath,
        iconPath
      ]);
      
      const buffer = fs.readFileSync(tmpPngPath);
      fs.unlinkSync(tmpPngPath);
      return buffer;
    } catch (error) {
      logger.debug("rsvg-convert failed, trying ImageMagick", { error: error.message });
      
      try {
        // Fallback to ImageMagick convert
        await execa("convert", [
          "-background", "none",
          "-resize", "48x48",
          iconPath,
          tmpPngPath
        ]);
        
        const buffer = fs.readFileSync(tmpPngPath);
        fs.unlinkSync(tmpPngPath);
        return buffer;
      } catch (convertError) {
        logger.debug("ImageMagick convert failed", { error: convertError.message });
        
        // Clean up temp file if it exists
        if (fs.existsSync(tmpPngPath)) {
          fs.unlinkSync(tmpPngPath);
        }
        
        return null;
      }
    }
  }

  // For XPM, try ImageMagick
  if (ext === ".xpm") {
    const tmpPngPath = path.join(os.tmpdir(), `icon-${Date.now()}.png`);
    
    try {
      await execa("convert", [
        "-background", "none",
        "-resize", "48x48",
        iconPath,
        tmpPngPath
      ]);
      
      const buffer = fs.readFileSync(tmpPngPath);
      fs.unlinkSync(tmpPngPath);
      return buffer;
    } catch (error) {
      logger.debug("Failed to convert XPM to PNG", { error: error.message });
      
      // Clean up temp file if it exists
      if (fs.existsSync(tmpPngPath)) {
        fs.unlinkSync(tmpPngPath);
      }
      
      return null;
    }
  }

  logger.debug("Unsupported icon format", { ext, iconPath });
  return null;
};

/**
 * Get icon as buffer for Linux application
 * @param {string} appPath - Path to the application or process name
 */
const getIconAsBuffer = async (appPath) => {
  try {
    // Extract app name from path
    let appName = path.basename(appPath);
    
    // Remove common extensions
    appName = appName.replace(/\.(exe|bin|sh|py|js)$/i, "");
    
    logger.debug("Extracting icon for Linux app", { appName, appPath });
    
    // Find the icon file
    const iconPath = await findLinuxIcon(appName);
    if (!iconPath) {
      logger.debug("No icon found for Linux app", { appName });
      return null;
    }
    
    // Convert to PNG if needed
    const buffer = await convertToPng(iconPath);
    if (!buffer) {
      logger.debug("Failed to convert icon to PNG", { iconPath });
      return null;
    }
    
    logger.debug("Successfully extracted Linux icon", {
      appName,
      iconPath,
      bufferSize: buffer.length,
    });
    
    return { extension: "png", buffer };
  } catch (error) {
    logger.warn("Failed to extract Linux icon", {
      appPath,
      error: error.message,
    });
    return null;
  }
};

export { getIconAsBuffer };
