const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// Suppress GTK warnings on Linux for cleaner console output
if (process.platform === 'linux') {
  process.env.G_MESSAGES_DEBUG = '';
  process.env.GTK_A11Y = 'none';
}

let mainWindow;
let currentDownload = null; // Track ongoing download for cancellation

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f5f5f5',
    resizable: true
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
}

ipcMain.handle('resize-window', (event, { width, height }) => {
  if (mainWindow) {
    const currentSize = mainWindow.getSize();
    const newHeight = Math.max(height, 600);
    mainWindow.setSize(currentSize[0], newHeight, true);
  }
});

ipcMain.handle('quit-app', () => {
  console.log('Quit app requested - closing window');
  if (mainWindow) {
    mainWindow.close();
  }
  setTimeout(() => {
    app.quit();
  }, 100);
});

app.whenReady().then(() => {
  // Check if running on Linux
  if (process.platform !== 'linux') {
    dialog.showErrorBox(
      'Unsupported Platform',
      'Image Burner is designed for Linux only.\n\n' +
      'This application requires Linux-specific tools (parted, dd, mkfs, etc.) ' +
      'and cannot run on Windows or macOS.\n\n' +
      'Please run this application on a Linux system.'
    );
    app.quit();
    return;
  }
  
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handlers

ipcMain.handle('select-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Disk Images', extensions: ['iso', 'img', 'nrg', 'gz', 'ISO', 'IMG', 'NRG', 'GZ'] },
      { name: 'ISO Files', extensions: ['iso', 'ISO'] },
      { name: 'IMG Files', extensions: ['img', 'IMG'] },
      { name: 'Compressed Images', extensions: ['gz', 'GZ'] },
      { name: 'NRG Files (Nero)', extensions: ['nrg', 'NRG'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    const stats = await fs.stat(filePath);
    
    // Check file type
    const isNRG = filePath.toLowerCase().endsWith('.nrg');
    const isGZ = filePath.toLowerCase().endsWith('.gz');
    
    return {
      path: filePath,
      name: path.basename(filePath),
      size: stats.size,
      isNRG: isNRG,
      isGZ: isGZ
    };
  }
  return null;
});

ipcMain.handle('list-drives', async (event, showAll = false) => {
  const platform = os.platform();
  
  if (platform === 'linux') {
    return await listLinuxDrives(showAll);
  } else {
    // Should never reach here due to platform check at startup
    throw new Error('Unsupported platform. This application only works on Linux.');
  }
});

async function listLinuxDrives(showAll = false) {
  return new Promise((resolve, reject) => {
    execFile('lsblk', ['-J', '-o', 'NAME,SIZE,TYPE,MOUNTPOINT,MODEL,VENDOR,RM,HOTPLUG,TRAN'], (error, stdout) => {
      if (error) {
        console.error('lsblk error:', error);
        reject(error);
        return;
      }
      
      try {
        const data = JSON.parse(stdout);
        console.log('All block devices:', JSON.stringify(data, null, 2));
        
        const drives = data.blockdevices
          .filter(device => {
            if (device.type !== 'disk') return false;
            
            if (showAll) {
              console.log(`Advanced mode: Including ${device.name}`);
              return true;
            }
            
            const isUSB = device.tran === 'usb';
            const isRemovable = device.rm === '1';
            const isHotplug = device.hotplug === '1';
            
            console.log(`Safe mode: ${device.name} - USB: ${isUSB}, RM: ${isRemovable}, HOTPLUG: ${isHotplug}`);
            
            return isUSB || isRemovable || isHotplug;
          })
          .map(device => ({
            device: `/dev/${device.name}`,
            name: device.name,
            size: device.size,
            model: `${device.vendor || ''} ${device.model || ''}`.trim() || 'Unknown',
            isRemovable: device.rm === '1' || device.hotplug === '1' || device.tran === 'usb',
            isHotplug: device.hotplug === '1',
            mountpoint: device.mountpoint || null,
            transport: device.tran || 'unknown'
          }));
        
        console.log(`Returning ${drives.length} drives:`, drives);
        resolve(drives);
      } catch (e) {
        console.error('Parse error:', e);
        reject(e);
      }
    });
  });
}

ipcMain.handle('calculate-checksum', async (event, filePath) => {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    
    let totalBytes = 0;
    
    stream.on('data', (chunk) => {
      hash.update(chunk);
      totalBytes += chunk.length;
      event.sender.send('checksum-progress', totalBytes);
    });
    
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
    
    stream.on('error', reject);
  });
});

// Convert NRG to ISO
ipcMain.handle('convert-nrg', async (event, nrgPath) => {
  return new Promise((resolve, reject) => {
    // Check if nrg2iso is installed
    execFile('which', ['nrg2iso'], (error) => {
      if (error) {
        reject(new Error(
          'nrg2iso is not installed.\n\n' +
          'To convert Nero (.nrg) files, please install nrg2iso:\n\n' +
          'Fedora: sudo dnf install nrg2iso\n' +
          'Ubuntu/Debian: sudo apt install nrg2iso\n' +
          'Arch: sudo pacman -S nrg2iso'
        ));
        return;
      }
      
      // Create output path (same directory, .iso extension)
      const isoPath = nrgPath.replace(/\.nrg$/i, '_converted.iso');
      
      console.log(`Converting NRG to ISO: ${nrgPath} -> ${isoPath}`);
      event.sender.send('nrg-convert-progress', { output: 'Converting NRG to ISO format...\n' });
      event.sender.send('nrg-convert-progress', { output: `Input: ${path.basename(nrgPath)}\n` });
      event.sender.send('nrg-convert-progress', { output: `Output: ${path.basename(isoPath)}\n\n` });
      
      const nrgProcess = spawn('nrg2iso', [nrgPath, isoPath]);
      
      nrgProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('nrg2iso stdout:', output);
        event.sender.send('nrg-convert-progress', { output });
      });
      
      nrgProcess.stderr.on('data', (data) => {
        const output = data.toString();
        console.log('nrg2iso stderr:', output);
        event.sender.send('nrg-convert-progress', { output });
      });
      
      nrgProcess.on('error', (error) => {
        console.error('nrg2iso error:', error);
        reject(new Error(`Failed to start nrg2iso: ${error.message}`));
      });
      
      nrgProcess.on('close', async (code) => {
        console.log(`nrg2iso exited with code ${code}`);
        
        if (code === 0) {
          // Check if output file was created
          try {
            const stats = await fs.stat(isoPath);
            event.sender.send('nrg-convert-progress', { output: '\n✓ Conversion complete!\n' });
            resolve({
              isoPath: isoPath,
              size: stats.size
            });
          } catch (err) {
            reject(new Error('Conversion failed: Output ISO file not found'));
          }
        } else {
          reject(new Error(`nrg2iso failed with exit code ${code}`));
        }
      });
    });
  });
});

// Download image from URL
ipcMain.handle('download-image', async (event, { url, saveToTemp = true }) => {
  return await downloadImageFromURL(event, url, saveToTemp);
});

// Cancel ongoing download
ipcMain.handle('cancel-download', async () => {
  if (currentDownload) {
    currentDownload.abort();
    currentDownload = null;
    return { success: true, message: 'Download cancelled' };
  }
  return { success: false, message: 'No download in progress' };
});

// Stream download directly to USB (on-the-fly burning)
ipcMain.handle('stream-to-usb', async (event, { url, targetDevice, imageType }) => {
  return await streamToUSB(event, url, targetDevice, imageType);
});

// Validate URL
ipcMain.handle('validate-url', async (event, url) => {
  return validateURL(url);
});

ipcMain.handle('write-image', async (event, { imagePath, targetDevice, imageType, advancedMode }) => {
  // CRITICAL SAFETY CHECK: Prevent writing to system drives (unless in advanced mode)
  if (!advancedMode) {
    // More precise dangerous device check - only block specific common system drives
    const dangerousDevices = [
      '/dev/nvme0n1', '/dev/nvme1n1',
      '/dev/hda', '/dev/vda', '/dev/xvda'
    ];
    
    // Check for exact match only (not startsWith)
    const isDangerous = dangerousDevices.includes(targetDevice);
    
    if (isDangerous) {
      throw new Error(
        `SECURITY BLOCK: Cannot write to ${targetDevice}.\n\n` +
        `This appears to be a system drive.\n` +
        `This operation is blocked to prevent accidental data loss.\n\n` +
        `If you need to write to this drive,\n` +
        `enable Advanced Mode and try again.`
      );
    }
    
    // Primary safety check: verify device is actually removable
    if (!await verifyRemovableDrive(targetDevice)) {
      throw new Error(
        `SECURITY BLOCK: Device ${targetDevice} is not detected as removable.\n\n` +
        `For safety, only USB drives and SD cards are allowed in Safe Mode.\n` +
        `System drives are blocked to prevent accidental data loss.\n\n` +
        `Enable Advanced Mode if you need to write to this device.`
      );
    }
  }
  
  if (imageType === 'windows') {
    return await writeWindowsImage(event, imagePath, targetDevice);
  } else {
    return await writeLinuxImage(event, imagePath, targetDevice);
  }
});

async function verifyRemovableDrive(targetDevice) {
  return new Promise((resolve) => {
    const deviceName = targetDevice.replace('/dev/', '');
    
    execFile('lsblk', ['-J', '-o', 'NAME,RM,HOTPLUG,TRAN', '-n', `/dev/${deviceName}`], (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      
      try {
        const data = JSON.parse(stdout);
        if (data.blockdevices && data.blockdevices.length > 0) {
          const device = data.blockdevices[0];
          // Check if USB, removable, or hotplug
          const isUSB = device.tran === 'usb';
          const isRemovable = device.rm === '1';
          const isHotplug = device.hotplug === '1';
          resolve(isUSB || isRemovable || isHotplug);
        } else {
          resolve(false);
        }
      } catch (e) {
        resolve(false);
      }
    });
  });
}

// Validate URL format and security
function validateURL(urlString) {
  try {
    const parsedUrl = new URL(urlString);
    
    // Only allow HTTP and HTTPS
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        valid: false,
        error: 'Only HTTP and HTTPS URLs are allowed'
      };
    }
    
    // Warn about HTTP (not secure)
    if (parsedUrl.protocol === 'http:') {
      return {
        valid: true,
        warning: 'HTTP is not secure. HTTPS is recommended for downloads.'
      };
    }
    
    return { valid: true };
  } catch (e) {
    return {
      valid: false,
      error: 'Invalid URL format'
    };
  }
}

// Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Calculate ETA
function calculateETA(downloaded, total, speed) {
  if (speed === 0) return 'calculating...';
  const remaining = total - downloaded;
  const seconds = Math.round(remaining / speed);
  
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// Download image from URL
async function downloadImageFromURL(event, urlString, saveToTemp = true) {
  return new Promise((resolve, reject) => {
    // Validate URL first
    const validation = validateURL(urlString);
    if (!validation.valid) {
      reject(new Error(validation.error));
      return;
    }
    
    const parsedUrl = new URL(urlString);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const fileName = path.basename(parsedUrl.pathname) || `downloaded-image-${Date.now()}.iso`;
    const tempPath = path.join(os.tmpdir(), fileName);
    
    console.log(`Downloading from: ${urlString}`);
    console.log(`Saving to: ${tempPath}`);
    
    event.sender.send('download-progress', {
      status: 'connecting',
      message: `Connecting to ${parsedUrl.hostname}...`
    });
    
    // Check if partial download exists
    let startByte = 0;
    if (fsSync.existsSync(tempPath + '.partial')) {
      const stats = fsSync.statSync(tempPath + '.partial');
      startByte = stats.size;
      console.log(`Resuming download from byte ${startByte}`);
    }
    
    const fileStream = fsSync.createWriteStream(tempPath + '.partial', {
      flags: startByte > 0 ? 'a' : 'w'
    });
    
    const requestOptions = {
      headers: startByte > 0 ? { 'Range': `bytes=${startByte}-` } : {}
    };
    
    const request = protocol.get(urlString, requestOptions, (response) => {
      // Handle redirects (301, 302, 307, 308)
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        console.log(`Redirect to: ${response.headers.location}`);
        fileStream.close();
        fsSync.unlinkSync(tempPath + '.partial');
        return downloadImageFromURL(event, response.headers.location, saveToTemp)
          .then(resolve)
          .catch(reject);
      }
      
      // Check for partial content (resume)
      if (response.statusCode === 206) {
        console.log('Resuming download...');
      } else if (response.statusCode !== 200) {
        fileStream.close();
        fsSync.unlinkSync(tempPath + '.partial');
        reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
        return;
      }
      
      const totalSize = startByte + parseInt(response.headers['content-length'] || '0', 10);
      let downloadedSize = startByte;
      let lastUpdate = Date.now();
      let lastDownloaded = startByte;
      
      console.log(`Total size: ${formatBytes(totalSize)}`);
      
      event.sender.send('download-progress', {
        status: 'downloading',
        total: totalSize,
        downloaded: downloadedSize,
        percent: Math.round((downloadedSize / totalSize) * 100),
        message: `Downloading ${fileName}...`,
        speed: '0 MB/s',
        eta: 'calculating...'
      });
      
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const now = Date.now();
        const timeDiff = now - lastUpdate;
        
        // Update progress every 500ms
        if (timeDiff >= 500) {
          const bytesInPeriod = downloadedSize - lastDownloaded;
          const speed = bytesInPeriod / (timeDiff / 1000); // bytes per second
          const speedMB = (speed / 1024 / 1024).toFixed(2);
          const percent = Math.round((downloadedSize / totalSize) * 100);
          const eta = calculateETA(downloadedSize, totalSize, speed);
          
          event.sender.send('download-progress', {
            status: 'downloading',
            total: totalSize,
            downloaded: downloadedSize,
            percent: percent,
            message: `Downloading ${fileName}... ${percent}%`,
            speed: `${speedMB} MB/s`,
            eta: eta
          });
          
          lastUpdate = now;
          lastDownloaded = downloadedSize;
        }
      });
      
      response.pipe(fileStream);
      
      fileStream.on('finish', async () => {
        fileStream.close();
        
        // Rename from .partial to final name
        try {
          await fs.rename(tempPath + '.partial', tempPath);
          
          event.sender.send('download-progress', {
            status: 'complete',
            message: 'Download complete!',
            percent: 100
          });
          
          console.log(`Download complete: ${tempPath}`);
          
          // Get file stats
          const stats = await fs.stat(tempPath);
          
          // Check if it's a compressed file
          const isGZ = fileName.toLowerCase().endsWith('.gz');
          const isNRG = fileName.toLowerCase().endsWith('.nrg');
          
          resolve({
            path: tempPath,
            name: fileName,
            size: stats.size,
            isGZ: isGZ,
            isNRG: isNRG,
            isDownloaded: true
          });
        } catch (renameError) {
          console.error('Rename error:', renameError);
          reject(new Error(`Failed to finalize download: ${renameError.message}`));
        }
      });
      
      fileStream.on('error', (error) => {
        console.error('File stream error:', error);
        fileStream.close();
        fsSync.unlink(tempPath + '.partial', () => {});
        reject(new Error(`Download failed: ${error.message}`));
      });
    });
    
    request.on('error', (error) => {
      console.error('Request error:', error);
      fileStream.close();
      fsSync.unlink(tempPath + '.partial', () => {});
      reject(new Error(`Download failed: ${error.message}`));
    });
    
    // Store request for cancellation
    currentDownload = request;
    
    request.on('close', () => {
      currentDownload = null;
    });
  });
}

// Stream download directly to USB drive (no temp file)
async function streamToUSB(event, urlString, targetDevice, imageType) {
  return new Promise((resolve, reject) => {
    // Validate URL first
    const validation = validateURL(urlString);
    if (!validation.valid) {
      reject(new Error(validation.error));
      return;
    }
    
    const parsedUrl = new URL(urlString);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const fileName = path.basename(parsedUrl.pathname);
    const isCompressed = fileName.toLowerCase().endsWith('.gz');
    
    console.log(`Streaming from: ${urlString}`);
    console.log(`Target device: ${targetDevice}`);
    console.log(`Compressed: ${isCompressed}`);
    
    event.sender.send('stream-progress', {
      status: 'connecting',
      message: `Connecting to ${parsedUrl.hostname}...`
    });
    
    // For Windows images, we can't stream directly (need complex partitioning)
    if (imageType === 'windows') {
      reject(new Error('Windows images cannot be streamed directly. Please use "Download first" method.'));
      return;
    }
    
    protocol.get(urlString, (response) => {
      // Handle redirects
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        console.log(`Redirect to: ${response.headers.location}`);
        return streamToUSB(event, response.headers.location, targetDevice, imageType)
          .then(resolve)
          .catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
        return;
      }
      
      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedSize = 0;
      let lastUpdate = Date.now();
      let lastDownloaded = 0;
      
      console.log(`Total size: ${formatBytes(totalSize)}`);
      
      event.sender.send('stream-progress', {
        status: 'starting',
        total: totalSize,
        message: 'Starting stream to USB...'
      });
      
      // Create the script for streaming
      const tempScriptPath = path.join(os.tmpdir(), `stream_to_usb_${Date.now()}.sh`);
      
      let scriptContent;
      if (isCompressed) {
        // For .gz files: decompress on-the-fly
        scriptContent = `#!/bin/bash
set -euo pipefail

TARGET_DEVICE="$1"

echo "Streaming compressed image to $TARGET_DEVICE"
echo "Decompressing on-the-fly..."

# Unmount all partitions
for partition in \${TARGET_DEVICE}*; do
  if [ "$partition" != "$TARGET_DEVICE" ] && [ -b "$partition" ]; then
    umount "$partition" 2>/dev/null || true
  fi
done

# Kill processes using device
fuser -km "$TARGET_DEVICE" 2>/dev/null || true
sleep 1

# Stream stdin through gunzip to device
gunzip -c | dd of="$TARGET_DEVICE" bs=4M status=progress conv=fsync oflag=direct

# Sync and refresh
sync
sleep 2
partprobe "$TARGET_DEVICE" 2>/dev/null || true
udevadm settle --timeout=10 2>/dev/null || true
sync

echo "Stream complete!"
`;
      } else {
        // For uncompressed files: direct stream
        scriptContent = `#!/bin/bash
set -euo pipefail

TARGET_DEVICE="$1"

echo "Streaming image to $TARGET_DEVICE"

# Unmount all partitions
for partition in \${TARGET_DEVICE}*; do
  if [ "$partition" != "$TARGET_DEVICE" ] && [ -b "$partition" ]; then
    umount "$partition" 2>/dev/null || true
  fi
done

# Kill processes using device
fuser -km "$TARGET_DEVICE" 2>/dev/null || true
sleep 1

# Stream stdin directly to device
dd of="$TARGET_DEVICE" bs=4M status=progress conv=fsync oflag=direct

# Sync and refresh
sync
sleep 2
partprobe "$TARGET_DEVICE" 2>/dev/null || true
udevadm settle --timeout=10 2>/dev/null || true
sync

echo "Stream complete!"
`;
      }
      
      // Write and make executable
      fsSync.writeFileSync(tempScriptPath, scriptContent, { mode: 0o755 });
      console.log(`Script created at: ${tempScriptPath}`);
      
      // Start the burn process with pkexec
      const burnProcess = spawn('pkexec', ['bash', tempScriptPath, targetDevice]);
      
      let errorOutput = '';
      
      // Pipe the download stream directly to the burn process stdin
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const now = Date.now();
        const timeDiff = now - lastUpdate;
        
        // Update progress every 500ms
        if (timeDiff >= 500) {
          const bytesInPeriod = downloadedSize - lastDownloaded;
          const speed = bytesInPeriod / (timeDiff / 1000);
          const speedMB = (speed / 1024 / 1024).toFixed(2);
          const percent = Math.round((downloadedSize / totalSize) * 100);
          const eta = calculateETA(downloadedSize, totalSize, speed);
          
          event.sender.send('stream-progress', {
            status: 'streaming',
            total: totalSize,
            downloaded: downloadedSize,
            percent: percent,
            message: `Streaming to USB... ${percent}%`,
            speed: `${speedMB} MB/s`,
            eta: eta
          });
          
          lastUpdate = now;
          lastDownloaded = downloadedSize;
        }
      });
      
      // Pipe download to burn process
      response.pipe(burnProcess.stdin);
      
      burnProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('STDOUT:', output);
        event.sender.send('stream-progress', { output });
      });
      
      burnProcess.stderr.on('data', (data) => {
        const output = data.toString();
        console.log('STDERR:', output);
        errorOutput += output;
        event.sender.send('stream-progress', { output });
      });
      
      burnProcess.on('error', (error) => {
        console.error('Burn process error:', error);
        // Clean up
        fsSync.unlink(tempScriptPath, () => {});
        reject(new Error(`Failed to start burn process: ${error.message}`));
      });
      
      burnProcess.on('close', (code) => {
        console.log(`Burn process exited with code: ${code}`);
        
        // Clean up script
        fsSync.unlink(tempScriptPath, (err) => {
          if (err) console.error('Failed to delete temp script:', err);
        });
        
        if (code === 0) {
          event.sender.send('stream-progress', {
            status: 'complete',
            message: 'Stream complete! USB drive ready.',
            percent: 100
          });
          resolve({ success: true });
        } else if (code === 126 || code === 127) {
          reject(new Error(`Authentication failed or pkexec not found (exit code ${code})`));
        } else {
          const errorMsg = errorOutput || `Burn failed with exit code ${code}`;
          reject(new Error(errorMsg));
        }
      });
      
    }).on('error', (error) => {
      console.error('Download error:', error);
      reject(new Error(`Download failed: ${error.message}`));
    });
  });
}

async function writeLinuxImage(event, imagePath, targetDevice) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`Writing Linux image: ${imagePath} to ${targetDevice}`);
      
      // Check if file is compressed (.gz)
      const isCompressed = imagePath.toLowerCase().endsWith('.gz');
      
      // Extract script from asar to temp directory
      const tempScriptPath = path.join(os.tmpdir(), `burn_linux_${Date.now()}.sh`);
      
      // Create a comprehensive script for Linux image burning
      const scriptContent = `#!/bin/bash
set -euo pipefail

IMAGE_PATH="$1"
TARGET_DEVICE="$2"
IS_COMPRESSED="$3"

echo "=== Linux Image Burner ==="
echo "Image: $IMAGE_PATH"
echo "Target: $TARGET_DEVICE"
echo "Compressed: $IS_COMPRESSED"
echo ""

# Step 1: Unmount all partitions on the target device
echo "📦 Unmounting all partitions on $TARGET_DEVICE..."
for partition in \${TARGET_DEVICE}*; do
  if [ "$partition" != "$TARGET_DEVICE" ] && [ -b "$partition" ]; then
    echo "  Unmounting: $partition"
    umount "$partition" 2>/dev/null || true
  fi
done

# Also try direct umount
umount \${TARGET_DEVICE}* 2>/dev/null || true
umount \${TARGET_DEVICE} 2>/dev/null || true

# Kill any processes using the device
fuser -km "$TARGET_DEVICE" 2>/dev/null || true
sleep 1

echo "✓ All partitions unmounted"
echo ""

# Step 2: Write the image
echo "💾 Writing image to $TARGET_DEVICE..."
echo "This may take several minutes..."
echo ""

if [ "$IS_COMPRESSED" = "true" ]; then
  echo "Decompressing and writing .gz file..."
  gunzip -c "$IMAGE_PATH" | dd of="$TARGET_DEVICE" bs=4M status=progress conv=fsync oflag=direct
else
  echo "Writing image file..."
  dd if="$IMAGE_PATH" of="$TARGET_DEVICE" bs=4M status=progress conv=fsync oflag=direct
fi

DD_EXIT_CODE=\$?

if [ \$DD_EXIT_CODE -ne 0 ]; then
  echo "❌ Error: dd failed with exit code \$DD_EXIT_CODE"
  exit \$DD_EXIT_CODE
fi

echo ""
echo "✓ Image written successfully"
echo ""

# Step 3: Sync - ensure all data is written to disk
echo "🔄 Syncing filesystem (ensuring all data is written)..."
sync
echo "  First sync complete..."
sleep 1
sync
echo "  Second sync complete..."
sleep 1

# Step 4: Refresh partition table
echo "🔄 Refreshing partition table..."
partprobe "$TARGET_DEVICE" 2>/dev/null || true
blockdev --rereadpt "$TARGET_DEVICE" 2>/dev/null || true
sleep 2

# Step 5: Trigger udev to update
echo "🔄 Triggering udev update..."
udevadm settle --timeout=10 2>/dev/null || true
udevadm trigger --subsystem-match=block 2>/dev/null || true
sleep 2

# Final sync
echo "🔄 Final sync..."
sync
sleep 1

echo ""
echo "✅ Done! Your bootable USB drive is ready."
echo "You can now safely remove the USB drive."
echo ""
`;

      // Write script to temp location
      await fs.writeFile(tempScriptPath, scriptContent, { mode: 0o755 });
      console.log(`Script created at: ${tempScriptPath}`);
      
      event.sender.send('write-progress', { output: `Starting Linux image write...\n\n` });
      
      const process = spawn('pkexec', ['bash', tempScriptPath, imagePath, targetDevice, isCompressed.toString()]);
      
      let totalWritten = 0;
      let errorOutput = '';
      
      process.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('STDOUT:', output);
        event.sender.send('write-progress', { output });
        
        // Parse dd progress
        const match = output.match(/(\d+)\s+bytes/);
        if (match) {
          totalWritten = parseInt(match[1]);
          event.sender.send('write-progress', { bytes: totalWritten });
        }
      });
      
      process.stderr.on('data', (data) => {
        const output = data.toString();
        console.log('STDERR:', output);
        event.sender.send('write-progress', { output });
        
        // Parse dd progress from stderr too
        const match = output.match(/(\d+)\s+bytes/);
        if (match) {
          totalWritten = parseInt(match[1]);
          event.sender.send('write-progress', { bytes: totalWritten });
        }
        
        if (output.toLowerCase().includes('error') && !output.includes('fuser')) {
          errorOutput += output;
        }
      });
      
      process.on('error', async (error) => {
        console.error('Process error:', error);
        
        // Clean up temp script
        try {
          await fs.unlink(tempScriptPath);
        } catch (unlinkError) {
          console.error('Failed to delete temp script:', unlinkError);
        }
        
        reject(new Error(`Failed to start script: ${error.message}`));
      });
      
      process.on('close', async (code) => {
        console.log(`Script exited with code: ${code}`);
        
        // Clean up temp script
        try {
          await fs.unlink(tempScriptPath);
          console.log('Temp script cleaned up');
        } catch (unlinkError) {
          console.error('Failed to delete temp script:', unlinkError);
        }
        
        if (code === 0) {
          event.sender.send('write-progress', { output: '\n✅ Success!\n' });
          resolve({ success: true });
        } else if (code === 126 || code === 127) {
          reject(new Error(`Authentication failed or pkexec not found (exit code ${code}). Make sure PolicyKit is installed.`));
        } else {
          const errorMsg = errorOutput || `Script failed with exit code ${code}`;
          reject(new Error(errorMsg));
        }
      });
      
    } catch (error) {
      console.error('writeLinuxImage error:', error);
      reject(error);
    }
  });
}

async function writeWindowsImage(event, imagePath, targetDevice) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`Writing Windows image: ${imagePath} to ${targetDevice}`);
      
      // Extract script from asar to temp directory
      const tempScriptPath = path.join(os.tmpdir(), `create_win_usb_${Date.now()}.sh`);
      const sourceScriptPath = path.join(__dirname, 'create_win_usb.sh');
      
      // Copy script to temp location and make it executable
      try {
        await fs.copyFile(sourceScriptPath, tempScriptPath);
        await fs.chmod(tempScriptPath, 0o755);
        console.log(`Script extracted to: ${tempScriptPath}`);
      } catch (copyError) {
        console.error('Failed to extract script:', copyError);
        reject(new Error(`Failed to extract script: ${copyError.message}`));
        return;
      }
      
      event.sender.send('write-progress', { output: `Starting Windows USB creation...\n\n` });

      const process = spawn('pkexec', ['bash', tempScriptPath, imagePath, targetDevice]);
      
      let errorOutput = '';
      
      process.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('STDOUT:', output);
        event.sender.send('write-progress', { output });
      });

      process.stderr.on('data', (data) => {
        const output = data.toString();
        console.log('STDERR:', output);
        errorOutput += output;
        event.sender.send('write-progress', { output });
      });

      process.on('close', async (code) => {
        console.log(`Script exited with code: ${code}`);
        console.log(`Error output: ${errorOutput}`);
        
        // Clean up temp script
        try {
          await fs.unlink(tempScriptPath);
          console.log('Temp script cleaned up');
        } catch (unlinkError) {
          console.error('Failed to delete temp script:', unlinkError);
        }
        
        if (code === 0) {
          event.sender.send('write-progress', { output: '\n✅ Success!\n' });
          resolve({ success: true });
        } else {
          const errorMsg = errorOutput || `Script failed with exit code ${code}`;
          reject(new Error(errorMsg));
        }
      });

      process.on('error', async (error) => {
        console.error('Process error:', error);
        
        // Clean up temp script on error
        try {
          await fs.unlink(tempScriptPath);
        } catch (unlinkError) {
          console.error('Failed to delete temp script:', unlinkError);
        }
        
        reject(new Error(`Failed to start script: ${error.message}`));
      });

    } catch (error) {
      console.error('writeWindowsImage error:', error);
      reject(error);
    }
  });
}
