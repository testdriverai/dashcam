import { logger } from './logger.js';
import { execa } from 'execa';
import os from 'os';

/**
 * Check if the application has screen recording permissions on macOS
 */
async function checkScreenRecordingPermission() {
  const platform = os.platform();
  
  if (platform !== 'darwin') {
    // Not macOS, permissions check not needed
    return { hasPermission: true, platform };
  }

  try {
    // Try to capture a single frame to test permissions
    // This is a quick test that will fail immediately if permissions are denied
    const { stderr } = await execa('screencapture', ['-x', '-t', 'png', '/tmp/dashcam_permission_test.png'], {
      timeout: 2000,
      reject: false
    });

    // Clean up test file
    try {
      const fs = await import('fs');
      if (fs.existsSync('/tmp/dashcam_permission_test.png')) {
        fs.unlinkSync('/tmp/dashcam_permission_test.png');
      }
    } catch (e) {
      // Ignore cleanup errors
    }

    const hasPermission = !stderr || !stderr.includes('not permitted');
    
    return { hasPermission, platform: 'darwin' };
  } catch (error) {
    logger.debug('Permission check failed', { error: error.message });
    return { hasPermission: false, platform: 'darwin', error: error.message };
  }
}

/**
 * Display instructions for granting screen recording permissions
 */
function showPermissionInstructions() {
  const platform = os.platform();
  
  if (platform !== 'darwin') {
    return;
  }

  console.log('\n⚠️  Screen Recording Permission Required\n');
  console.log('Dashcam needs screen recording permission to capture your screen.');
  console.log('\nTo grant permission:');
  console.log('1. Open System Settings (or System Preferences)');
  console.log('2. Go to Privacy & Security > Screen Recording');
  console.log('3. Click the lock icon and enter your password');
  console.log('4. Enable screen recording for Terminal (or your terminal app)');
  console.log('   - If using the standalone binary, you may need to add the binary itself');
  console.log('5. Restart your terminal and try again\n');
  console.log('Note: You may need to fully quit and restart your terminal application.\n');
}

/**
 * Check permissions and show instructions if needed
 */
async function ensurePermissions() {
  const result = await checkScreenRecordingPermission();
  
  if (!result.hasPermission) {
    logger.warn('Screen recording permission not granted');
    showPermissionInstructions();
    return false;
  }
  
  logger.debug('Screen recording permission check passed');
  return true;
}

export {
  checkScreenRecordingPermission,
  showPermissionInstructions,
  ensurePermissions
};
