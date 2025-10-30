import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "../../logger.js";

// For CLI, we'll use a simple platform detection
const PLATFORM = process.platform;

// Import platform-specific icon extractors lazily
let getIconAsBuffer;
let iconModuleLoaded = false;

async function ensureIconModule() {
  if (iconModuleLoaded) return;
  
  if (PLATFORM === "darwin") {
    const darwinModule = await import("./darwin.js");
    getIconAsBuffer = darwinModule.getIconAsBuffer;
  } else if (PLATFORM === "win32") {
    const windowsModule = await import("./windows.js");
    getIconAsBuffer = windowsModule.getIconAsBuffer;
  } else {
    // Linux fallback
    getIconAsBuffer = () => null;
  }
  
  iconModuleLoaded = true;
}

class IconCache {
  constructor(folderPath) {
    this.folderPath = folderPath;

    // Ensure the icons directory exists
    if (!fs.existsSync(this.folderPath)) {
      fs.mkdirSync(this.folderPath, { recursive: true });
    }

    this.icons = {};
    
    try {
      const files = fs.readdirSync(this.folderPath);
      files.forEach((file) => {
        let extension;
        if (file.endsWith(".png")) extension = "png";
        else if (file.endsWith(".ico")) extension = "ico";
        else return;

        // We use replace instead of split because for mac we use bundle ids which have dots in them
        const id = file.replace(".png", "").replace(".ico", "");

        this.icons[id] = { extension };
      });
      
      logger.debug("IconCache initialized", { 
        folderPath: this.folderPath,
        cachedIcons: Object.keys(this.icons).length 
      });
    } catch (error) {
      logger.warn("Failed to initialize IconCache", { 
        folderPath: this.folderPath,
        error: error.message 
      });
    }
  }

  has(id) {
    return this.icons[id];
  }

  set(name, { extension, buffer }) {
    const id = idFromName(name);
    try {
      const filePath = path.join(this.folderPath, `${id}.${extension}`);
      fs.writeFileSync(filePath, buffer);
      this.icons[id] = { extension };
      
      logger.debug("Icon cached", { name, id, extension, filePath });
    } catch (e) {
      logger.error(`IconCache: error writing icon for ${id}`, { error: e.message });
    }
  }

  get(name) {
    const id = idFromName(name);

    if (!this.icons[id]) {
      logger.debug(`IconCache: no icon for ${id}`);
      return null;
    }

    const { extension } = this.icons[id];
    const filePath = path.join(this.folderPath, `${id}.${extension}`);

    try {
      return {
        normalizedName: name,
        extension,
        file: filePath,
        buffer: fs.readFileSync(filePath),
      };
    } catch (error) {
      logger.error(`IconCache: error reading icon for ${id}`, { error: error.message });
      return null;
    }
  }
}

// Create icons directory in CLI temp folder
const iconsDir = path.join(os.tmpdir(), 'dashcam-cli-icons');
const iconCache = new IconCache(iconsDir);

const idFromName = (name) => name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();

const extractIcon = async ({ name, id }) => {
  if (!name) {
    logger.debug("extractIcon: no name provided");
    return;
  }

  const normalizedId = idFromName(name);
  
  if (!iconCache.has(normalizedId)) {
    if (!id) {
      logger.debug(`extractIcon: no id for ${name}`);
      return;
    }
    
    try {
      // Ensure the icon module is loaded before using it
      await ensureIconModule();
      
      const result = await getIconAsBuffer(id);
      if (!result) {
        logger.debug(`extractIcon: no icon buffer returned for ${name} (${id})`);
        return;
      }

      iconCache.set(name, {
        extension: result.extension,
        buffer: result.buffer,
      });
      
      logger.debug("Icon extracted and cached", { name, id, extension: result.extension });
    } catch (error) {
      logger.warn("Failed to extract icon", { name, id, error: error.message });
    }
  } else {
    logger.silly("Icon already cached", { name });
  }
};

const getIconData = (name, withBase64 = false) => {
  const iconData = iconCache.get(name);
  if (!iconData) return null;

  return {
    extension: iconData.extension,
    file: iconData.file,
    base64:
      iconData.buffer && withBase64
        ? "data:image/" + iconData.extension + ";base64," + iconData.buffer.toString("base64")
        : null,
  };
};

export { extractIcon, getIconData, iconCache };
