#!/usr/bin/env node

// CommonJS wrapper for pkg compatibility
// This file imports the ES module version
import('./dashcam.js').catch((err) => {
  console.error('Failed to load dashcam:', err);
  process.exit(1);
});
