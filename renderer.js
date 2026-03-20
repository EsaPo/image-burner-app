let selectedImage = null;
let selectedDrive = null;
let imageType = null;
let advancedMode = false;

// Check if electronAPI is available
console.log('Checking electronAPI:', window.electronAPI);

// About Modal
document.getElementById('aboutBtn').addEventListener('click', () => {
  console.log('About button clicked');
  document.getElementById('aboutModal').classList.add('show');
});

document.getElementById('closeAbout').addEventListener('click', () => {
  console.log('Close about clicked');
  document.getElementById('aboutModal').classList.remove('show');
});

// Close modal when clicking outside
document.getElementById('aboutModal').addEventListener('click', (e) => {
  if (e.target.id === 'aboutModal') {
    document.getElementById('aboutModal').classList.remove('show');
  }
});

// Quit Button
document.getElementById('quitBtn').addEventListener('click', () => {
  console.log('Quit button clicked!');
  if (confirm('Are you sure you want to quit Image Burner?')) {
    console.log('User confirmed quit');
    window.electronAPI.quitApp();
  }
});

// Tab Switching
document.getElementById('localFileTab').addEventListener('click', () => {
  document.getElementById('localFileTab').classList.add('active');
  document.getElementById('urlTab').classList.remove('active');
  document.getElementById('localFileContent').classList.add('active');
  document.getElementById('urlContent').classList.remove('active');
});

document.getElementById('urlTab').addEventListener('click', () => {
  document.getElementById('urlTab').classList.add('active');
  document.getElementById('localFileTab').classList.remove('active');
  document.getElementById('urlContent').classList.add('active');
  document.getElementById('localFileContent').classList.remove('active');
});

// URL Validation on input
document.getElementById('imageUrl').addEventListener('input', async (e) => {
  const url = e.target.value.trim();
  const validationDiv = document.getElementById('urlValidation');
  
  if (!url) {
    validationDiv.textContent = '';
    validationDiv.style.color = '';
    return;
  }
  
  const validation = await window.electronAPI.validateUrl(url);
  
  if (!validation.valid) {
    validationDiv.textContent = '❌ ' + validation.error;
    validationDiv.style.color = '#dc3545';
  } else if (validation.warning) {
    validationDiv.textContent = '⚠️ ' + validation.warning;
    validationDiv.style.color = '#ff9800';
  } else {
    validationDiv.textContent = '✅ Valid URL';
    validationDiv.style.color = '#28a745';
  }
});

// Quick Links
document.querySelectorAll('.quick-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const url = link.getAttribute('data-url');
    document.getElementById('imageUrl').value = url;
    document.getElementById('imageUrl').dispatchEvent(new Event('input'));
  });
});

// Download Method Selection
document.querySelectorAll('input[name="downloadMethod"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const streamWarning = document.getElementById('streamWarning');
    const downloadBtn = document.getElementById('downloadUrlBtn');
    
    if (e.target.value === 'stream-to-usb') {
      streamWarning.style.display = 'block';
      downloadBtn.textContent = '⚡ Stream to USB';
      downloadBtn.style.background = '#ff9800';
    } else {
      streamWarning.style.display = 'none';
      downloadBtn.textContent = '⬇️ Download';
      downloadBtn.style.background = '';
    }
  });
});

// Download from URL
document.getElementById('downloadUrlBtn').addEventListener('click', async () => {
  const url = document.getElementById('imageUrl').value.trim();
  
  if (!url) {
    alert('Please enter a URL');
    return;
  }
  
  // Validate URL
  const validation = await window.electronAPI.validateUrl(url);
  if (!validation.valid) {
    alert('Invalid URL:\n\n' + validation.error);
    return;
  }
  
  if (validation.warning) {
    if (!confirm(validation.warning + '\n\nDo you want to continue?')) {
      return;
    }
  }
  
  // Check download method
  const downloadMethod = document.querySelector('input[name="downloadMethod"]:checked').value;
  
  if (downloadMethod === 'stream-to-usb') {
    // Stream mode - need to select drive first
    handleStreamToUSB(url);
  } else {
    // Normal download mode
    handleNormalDownload(url);
  }
});

// Normal download (download first, then burn)
async function handleNormalDownload(url) {
  const downloadBtn = document.getElementById('downloadUrlBtn');
  const cancelBtn = document.getElementById('cancelDownloadBtn');
  const progressDiv = document.getElementById('downloadProgress');
  const progressFill = document.getElementById('downloadProgressFill');
  const progressPercent = document.getElementById('downloadProgressPercent');
  const progressText = document.getElementById('downloadProgressText');
  const statsDiv = document.getElementById('downloadStats');
  
  downloadBtn.style.display = 'none';
  cancelBtn.style.display = 'inline-block';
  progressDiv.style.display = 'block';
  
  window.electronAPI.onDownloadProgress((data) => {
    if (data.status === 'connecting') {
      progressText.textContent = data.message;
      statsDiv.textContent = '';
    } else if (data.status === 'downloading') {
      const percent = data.percent || 0;
      progressFill.style.width = percent + '%';
      progressPercent.textContent = percent + '%';
      progressText.textContent = data.message || 'Downloading...';
      
      if (data.speed && data.eta) {
        const downloaded = formatBytes(data.downloaded || 0);
        const total = formatBytes(data.total || 0);
        statsDiv.textContent = `${downloaded} / ${total} • ${data.speed} • ETA: ${data.eta}`;
      }
    } else if (data.status === 'complete') {
      progressFill.style.width = '100%';
      progressPercent.textContent = '100%';
      progressText.textContent = data.message;
      statsDiv.textContent = '✅ Ready to burn!';
    }
  });
  
  try {
    const image = await window.electronAPI.downloadImage({ url, saveToTemp: true });
    
    selectedImage = image;
    document.getElementById('imageName').textContent = image.name;
    document.getElementById('imageSize').textContent = formatBytes(image.size);
    document.getElementById('imageSource').textContent = '🌐 Downloaded from URL';
    document.getElementById('imageSourceRow').style.display = 'flex';
    document.getElementById('imageInfo').style.display = 'block';
    
    // Check for compression or special formats
    if (image.isGZ) {
      const checksumResult = document.getElementById('checksumResult');
      checksumResult.style.display = 'block';
      checksumResult.innerHTML = '<span style="color: #007bff; font-weight: bold;">ℹ️ Compressed .gz file detected</span><br>' +
                                  'This file will be automatically decompressed while writing to the USB drive.';
    }
    
    // Auto-detect type
    if (image.name.toLowerCase().includes('win')) {
      selectImageType('windows', true);
    } else {
      selectImageType('linux', true);
    }
    
    document.getElementById('step2').classList.add('active');
    
    // Hide download progress after a delay
    setTimeout(() => {
      progressDiv.style.display = 'none';
    }, 3000);
    
  } catch (error) {
    alert('Download failed:\n\n' + error.message);
    progressDiv.style.display = 'none';
  } finally {
    downloadBtn.style.display = 'inline-block';
    cancelBtn.style.display = 'none';
    window.electronAPI.removeDownloadListener();
  }
}

// Cancel Download
document.getElementById('cancelDownloadBtn').addEventListener('click', async () => {
  if (confirm('Are you sure you want to cancel the download?')) {
    await window.electronAPI.cancelDownload();
    document.getElementById('downloadProgress').style.display = 'none';
    document.getElementById('downloadUrlBtn').style.display = 'inline-block';
    document.getElementById('cancelDownloadBtn').style.display = 'none';
    window.electronAPI.removeDownloadListener();
  }
});

// Stream to USB (download and burn on-the-fly)
async function handleStreamToUSB(url) {
  // First, need to select USB drive and image type
  if (!confirm(
    '⚡ STREAM TO USB MODE\n\n' +
    'This will download and burn directly to USB without saving to disk.\n\n' +
    '⚠️ IMPORTANT WARNINGS:\n' +
    '• Cannot verify checksum before burning\n' +
    '• Cannot retry if it fails\n' +
    '• Network interruption = corrupted USB\n' +
    '• Only works for Linux images (not Windows)\n\n' +
    'You will select the USB drive next.\n\n' +
    'Continue?'
  )) {
    return;
  }
  
  // Auto-detect image type from URL
  const fileName = url.split('/').pop();
  let detectedType = 'linux';
  if (fileName.toLowerCase().includes('win')) {
    alert('Windows images cannot be streamed directly.\nPlease use "Download first" method for Windows images.');
    return;
  }
  
  // Open drive selection modal
  document.getElementById('flashModal').classList.add('show');
  
  // Wait a moment for modal to open
  setTimeout(async () => {
    // Refresh drives
    document.getElementById('refreshDrivesBtnModal').click();
    
    // Store the URL for later use
    window.streamURL = url;
    window.streamMode = true;
    window.streamImageType = detectedType;
    
    // Update modal title
    const modalHeader = document.querySelector('#flashModal .modal-header h2');
    if (modalHeader) {
      modalHeader.textContent = '⚡ Select Drive for Streaming';
    }
    
    // Show info message
    const driveList = document.getElementById('driveListModal');
    const infoDiv = document.createElement('div');
    infoDiv.id = 'streamInfo';
    infoDiv.style.cssText = 'background: #fff3cd; padding: 12px; border-radius: 4px; margin-bottom: 15px; border-left: 4px solid #ff9800;';
    infoDiv.innerHTML = '<strong>⚡ Stream Mode:</strong> Download will begin immediately after you click Flash!';
    driveList.insertBefore(infoDiv, driveList.firstChild);
    
  }, 100);
}

// Open Flash Modal
document.getElementById('openFlashModal').addEventListener('click', () => {
  if (!selectedImage || !imageType) {
    alert('Please select an image file first!');
    return;
  }
  document.getElementById('flashModal').classList.add('show');
  // Auto-refresh drives when modal opens
  setTimeout(() => {
    document.getElementById('refreshDrivesBtnModal').click();
  }, 100);
});

// Close Flash Modal
document.getElementById('closeFlash').addEventListener('click', () => {
  document.getElementById('flashModal').classList.remove('show');
});

document.getElementById('closeSuccessModal').addEventListener('click', () => {
  document.getElementById('flashModal').classList.remove('show');
  location.reload(); // Reload to reset the app
});

// Advanced Mode Toggle in Modal
document.getElementById('advancedModeToggleModal').addEventListener('change', (e) => {
  advancedMode = e.target.checked;
  const modeLabel = document.getElementById('modeLabelModal');
  const advancedWarning = document.getElementById('advancedWarningModal');
  const toggleContainer = document.getElementById('toggleSwitchContainerModal');
  
  if (advancedMode) {
    modeLabel.textContent = '⚠️ Advanced';
    modeLabel.classList.add('active');
    advancedWarning.style.display = 'block';
    toggleContainer.classList.add('active');
    
    if (!confirm(
      '⚠️ ADVANCED MODE WARNING ⚠️\n\n' +
      'You are about to enable Advanced Mode.\n\n' +
      'This will show ALL drives including:\n' +
      '• System drives (/dev/sda, /dev/nvme0n1)\n' +
      '• Internal hard drives and SSDs\n' +
      '• Boot drives and mounted partitions\n\n' +
      'Writing to the wrong drive will DESTROY your system!\n\n' +
      'Only enable this if you know exactly what you\'re doing\n' +
      '(e.g., flashing SD card on Raspberry Pi).\n\n' +
      'Continue to Advanced Mode?'
    )) {
      e.target.checked = false;
      advancedMode = false;
      modeLabel.textContent = '🛡️ Safe Mode';
      modeLabel.classList.remove('active');
      advancedWarning.style.display = 'none';
      toggleContainer.classList.remove('active');
      return;
    }
  } else {
    modeLabel.textContent = '🛡️ Safe Mode';
    modeLabel.classList.remove('active');
    advancedWarning.style.display = 'none';
    toggleContainer.classList.remove('active');
  }
  
  selectedDrive = null;
  document.getElementById('warningMessageModal').style.display = 'none';
  document.getElementById('writeBtnModal').disabled = true;
  document.getElementById('refreshDrivesBtnModal').click();
});

// Refresh Drives in Modal
document.getElementById('refreshDrivesBtnModal').addEventListener('click', async () => {
  const btn = document.getElementById('refreshDrivesBtnModal');
  btn.disabled = true;
  btn.textContent = 'Loading...';
  
  try {
    const drives = await window.electronAPI.listDrives(advancedMode);
    displayDrivesModal(drives);
  } catch (error) {
    alert('Error listing drives: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh Drives';
  }
});

function displayDrivesModal(drives) {
  const driveList = document.getElementById('driveListModal');
  driveList.innerHTML = '';
  
  if (drives.length === 0) {
    driveList.innerHTML = `<p style="text-align: center; padding: 20px; color: #666;">
      No ${advancedMode ? '' : 'removable '}drives detected. 
      ${advancedMode ? '' : 'Please connect a USB drive.'}
    </p>`;
    return;
  }
  
  drives.forEach(drive => {
    const isNonRemovable = !drive.isRemovable;
    const hasMountpoint = drive.mountpoint;
    
    const driveItem = document.createElement('div');
    driveItem.className = 'drive-item';
    
    let safetyBadge = '';
    let warningText = '';
    
    if (advancedMode) {
      if (isNonRemovable) {
        safetyBadge = '<span class="safety-badge blocked">⚠️ INTERNAL DRIVE - CAUTION!</span>';
        warningText = '<div style="margin-top: 10px; color: #721c24; font-size: 0.9em; font-weight: 600;">⚠️ WARNING: This is likely a system drive. Triple-check before writing!</div>';
      } else {
        safetyBadge = '<span class="safety-badge safe">✓ Removable</span>';
      }
    } else {
      safetyBadge = '<span class="safety-badge safe">✓ Safe (Removable)</span>';
    }
    
    if (hasMountpoint) {
      warningText += `<div style="margin-top: 5px; color: #856404; font-size: 0.9em;">📌 Mounted at: ${drive.mountpoint}</div>`;
    }
    
    driveItem.innerHTML = `
      <div class="info-row">
        <span class="info-label">Device:</span>
        <span class="info-value">${drive.device} ${safetyBadge}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Model:</span>
        <span class="info-value">${drive.model}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Size:</span>
        <span class="info-value">${drive.size}</span>
      </div>
      ${warningText}
    `;
    
    driveItem.addEventListener('click', () => {
      if (advancedMode && isNonRemovable) {
        if (!confirm(
          `⚠️ EXTREME CAUTION REQUIRED ⚠️\n\n` +
          `You selected: ${drive.device}\n` +
          `Model: ${drive.model}\n\n` +
          `This appears to be an INTERNAL/SYSTEM DRIVE!\n\n` +
          `Are you ABSOLUTELY CERTAIN this is the correct drive?\n` +
          `Writing to the wrong drive will DESTROY YOUR SYSTEM!\n\n` +
          `Only proceed if you are 100% sure (e.g., Raspberry Pi SD card).`
        )) {
          return;
        }
      }
      
      document.querySelectorAll('#driveListModal .drive-item').forEach(item => {
        item.classList.remove('selected');
      });
      driveItem.classList.add('selected');
      selectedDrive = drive;
      document.getElementById('warningMessageModal').style.display = 'block';
      document.getElementById('writeBtnModal').disabled = false;
    });
    
    driveList.appendChild(driveItem);
  });
}

// Write Button in Modal
document.getElementById('writeBtnModal').addEventListener('click', async () => {
  console.log('=== WRITE BUTTON CLICKED (MODAL) ===');
  
  // Check if in stream mode
  if (window.streamMode) {
    await handleStreamBurn();
    return;
  }
  
  const device = selectedDrive.device;
  const deviceName = selectedDrive.name;
  
  if (!confirm(
    `⚠️ FINAL WARNING ⚠️\n\n` +
    `You are about to PERMANENTLY ERASE all data on:\n\n` +
    `Device: ${device}\n` +
    `Model: ${selectedDrive.model}\n` +
    `Size: ${selectedDrive.size}\n\n` +
    `This action CANNOT be undone!\n\n` +
    `ARE YOU ABSOLUTELY SURE?\n\n` +
    `Click OK ONLY if you are 100% certain this is the correct drive.`
  )) {
    return;
  }
  
  if (!confirm(
    `⚠️ THIS IS YOUR LAST CHANCE ⚠️\n\n` +
    `Clicking OK will IMMEDIATELY start destroying all data on:\n${device}\n\n` +
    `There is NO UNDO!\n\n` +
    `Proceed?`
  )) {
    return;
  }
  
  const writeBtn = document.getElementById('writeBtnModal');
  const progressSection = document.getElementById('progressSectionModal');
  const logOutput = document.getElementById('logOutputModal');
  
  writeBtn.disabled = true;
  progressSection.style.display = 'block';
  logOutput.innerHTML = 'Initializing write process...<br>';
  
  let progress = 0;
  const progressInterval = setInterval(() => {
    if (progress < 95) {
      progress += 1;
      updateProgressModal(progress, 'Writing image...');
    }
  }, 1000);
  
  window.electronAPI.onWriteProgress((data) => {
    if (data.output) {
      logOutput.innerHTML += data.output.replace(/\n/g, '<br>') + '<br>';
      logOutput.scrollTop = logOutput.scrollHeight;
    }
    if (data.bytes) {
      const percent = Math.round((data.bytes / selectedImage.size) * 100);
      updateProgressModal(Math.min(percent, 95), 'Writing image...');
    }
  });
  
  try {
    const result = await window.electronAPI.writeImage({
      imagePath: selectedImage.path,
      targetDevice: selectedDrive.device,
      imageType: imageType,
      advancedMode: advancedMode
    });
    
    clearInterval(progressInterval);
    updateProgressModal(100, 'Complete!');
    
    setTimeout(() => {
      progressSection.style.display = 'none';
      document.getElementById('successMessageModal').style.display = 'block';
    }, 1000);
    
  } catch (error) {
    console.error('Write error:', error);
    clearInterval(progressInterval);
    
    const errorMsg = error.message || 'Unknown error occurred';
    alert(`❌ ERROR\n\n${errorMsg}\n\nPlease check the log output for details.`);
    
    logOutput.innerHTML += `<br><span style="color: #ff5555;">ERROR: ${errorMsg}</span><br>`;
    logOutput.scrollTop = logOutput.scrollHeight;
    
    writeBtn.disabled = false;
  } finally {
    window.electronAPI.removeWriteListener();
  }
});

// Handle stream burn (download and burn simultaneously)
async function handleStreamBurn() {
  const device = selectedDrive.device;
  
  if (!confirm(
    `⚡ STREAM TO USB - FINAL WARNING ⚡\n\n` +
    `Streaming ${window.streamURL.split('/').pop()}\n` +
    `to ${device} (${selectedDrive.model})\n\n` +
    `This will:\n` +
    `• Download and burn simultaneously\n` +
    `• Erase all data on the USB drive\n` +
    `• Cannot be stopped safely once started\n` +
    `• Cannot retry on failure\n\n` +
    `Proceed?`
  )) {
    return;
  }
  
  const writeBtn = document.getElementById('writeBtnModal');
  const progressSection = document.getElementById('progressSectionModal');
  const logOutput = document.getElementById('logOutputModal');
  
  writeBtn.disabled = true;
  progressSection.style.display = 'block';
  logOutput.innerHTML = '⚡ Initializing stream to USB...<br>';
  
  window.electronAPI.onStreamProgress((data) => {
    if (data.output) {
      logOutput.innerHTML += data.output.replace(/\n/g, '<br>') + '<br>';
      logOutput.scrollTop = logOutput.scrollHeight;
    }
    
    if (data.status === 'connecting') {
      updateProgressModal(0, data.message);
    } else if (data.status === 'starting') {
      updateProgressModal(5, data.message);
    } else if (data.status === 'streaming') {
      const percent = data.percent || 0;
      updateProgressModal(percent, data.message);
      
      if (data.speed && data.eta) {
        const downloaded = formatBytes(data.downloaded || 0);
        const total = formatBytes(data.total || 0);
        logOutput.innerHTML += `<span style="color: #007bff;">${downloaded} / ${total} • ${data.speed} • ETA: ${data.eta}</span><br>`;
        logOutput.scrollTop = logOutput.scrollHeight;
      }
    } else if (data.status === 'complete') {
      updateProgressModal(100, data.message);
    }
  });
  
  try {
    const result = await window.electronAPI.streamToUSB({
      url: window.streamURL,
      targetDevice: device,
      imageType: window.streamImageType
    });
    
    setTimeout(() => {
      progressSection.style.display = 'none';
      document.getElementById('successMessageModal').style.display = 'block';
      
      // Clean up stream mode
      window.streamMode = false;
      window.streamURL = null;
      window.streamImageType = null;
      
      // Remove stream info div
      const streamInfo = document.getElementById('streamInfo');
      if (streamInfo) streamInfo.remove();
    }, 1000);
    
  } catch (error) {
    console.error('Stream error:', error);
    
    const errorMsg = error.message || 'Unknown error occurred';
    alert(`❌ STREAM FAILED\n\n${errorMsg}\n\nPlease try "Download first" method instead.`);
    
    logOutput.innerHTML += `<br><span style="color: #ff5555;">ERROR: ${errorMsg}</span><br>`;
    logOutput.scrollTop = logOutput.scrollHeight;
    
    writeBtn.disabled = false;
    
    // Clean up stream mode
    window.streamMode = false;
    window.streamURL = null;
    window.streamImageType = null;
  } finally {
    window.electronAPI.removeStreamListener();
  }
}

function updateProgressModal(percent, text) {
  document.getElementById('progressFillModal').style.width = percent + '%';
  document.getElementById('progressPercentModal').textContent = percent + '%';
  document.getElementById('progressTextModal').textContent = text;
}

// Image selection and type functions
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

document.getElementById('selectImageBtn').addEventListener('click', async () => {
  const image = await window.electronAPI.selectImage();
  if (image) {
    // Check if it's a NRG file and convert if necessary
    if (image.isNRG) {
      const convertBtn = document.getElementById('selectImageBtn');
      convertBtn.disabled = true;
      convertBtn.textContent = 'Converting NRG to ISO...';
      
      const checksumResult = document.getElementById('checksumResult');
      checksumResult.style.display = 'block';
      checksumResult.innerHTML = 'Converting Nero (.nrg) file to ISO format...<br><br>';
      
      window.electronAPI.onNRGConvertProgress((data) => {
        if (data.output) {
          checksumResult.innerHTML += data.output.replace(/\n/g, '<br>');
        }
      });
      
      try {
        const result = await window.electronAPI.convertNRG(image.path);
        
        // Update selectedImage to use the converted ISO
        selectedImage = {
          path: result.isoPath,
          name: image.name.replace(/\.nrg$/i, '_converted.iso'),
          size: result.size
        };
        
        document.getElementById('imageName').textContent = selectedImage.name;
        document.getElementById('imageSize').textContent = formatBytes(selectedImage.size);
        document.getElementById('imageInfo').style.display = 'block';
        
        checksumResult.innerHTML += '<br><span style="color: #28a745; font-weight: bold;">✓ Conversion successful! Using converted ISO file.</span>';
        
        // Auto-detect type
	if (selectedImage.name.toLowerCase().includes('win')) {
	  selectImageType('windows', true);
	} else {
	  selectImageType('linux', true);
	}
        
        document.getElementById('step2').classList.add('active');
        
      } catch (error) {
        alert('NRG Conversion Error:\n\n' + error.message);
        checksumResult.innerHTML = '';
        checksumResult.style.display = 'none';
      } finally {
        convertBtn.disabled = false;
        convertBtn.textContent = 'Choose ISO/IMG/NRG/GZ File';
        window.electronAPI.removeNRGConvertListener();
      }
    } else if (image.isGZ) {
      // .gz file - will be decompressed during writing
      selectedImage = image;
      document.getElementById('imageName').textContent = image.name;
      document.getElementById('imageSize').textContent = formatBytes(image.size) + ' (compressed)';
      document.getElementById('imageInfo').style.display = 'block';
      
      const checksumResult = document.getElementById('checksumResult');
      checksumResult.style.display = 'block';
      checksumResult.innerHTML = '<span style="color: #007bff; font-weight: bold;">ℹ️ Compressed .gz file detected</span><br>' +
                                  'This file will be automatically decompressed while writing to the USB drive.<br>' +
                                  'No manual extraction needed!';
      
      // .gz files are typically Linux images
      selectImageType('linux', true);
      
      // Enable step 2
      document.getElementById('step2').classList.add('active');
    } else {
      // Regular ISO/IMG file
      selectedImage = image;
      document.getElementById('imageName').textContent = image.name;
      document.getElementById('imageSize').textContent = formatBytes(image.size);
      document.getElementById('imageInfo').style.display = 'block';
      
	if (image.name.toLowerCase().includes('win')) {
	  selectImageType('windows', true);
	} else {
	  selectImageType('linux', true);
	}
      
      // Enable step 2
      document.getElementById('step2').classList.add('active');
    }
  }
});

document.querySelectorAll('.type-option').forEach(option => {
  option.addEventListener('click', () => {
    const type = option.getAttribute('data-type');
    selectImageType(type);
  });
});

function selectImageType(type, lockSelection = false) {
  imageType = type;
  document.querySelectorAll('.type-option').forEach(opt => {
    opt.classList.remove('selected');
    // Disable or enable based on lock status
    if (lockSelection) {
      opt.style.opacity = '0.5';
      opt.style.cursor = 'not-allowed';
      opt.style.pointerEvents = 'none';
    } else {
      opt.style.opacity = '1';
      opt.style.cursor = 'pointer';
      opt.style.pointerEvents = 'auto';
    }
  });
  document.querySelector(`[data-type="${type}"]`).classList.add('selected');
  
  // Re-enable the selected option for visual clarity
  if (lockSelection) {
    document.querySelector(`[data-type="${type}"]`).style.opacity = '1';
  }
  
  // Enable step 2
  if (selectedImage) {
    document.getElementById('step2').classList.add('active');
  }
}

document.getElementById('calculateChecksumBtn').addEventListener('click', async () => {
  const btn = document.getElementById('calculateChecksumBtn');
  const resultDiv = document.getElementById('checksumResult');
  
  btn.disabled = true;
  btn.textContent = 'Calculating...';
  resultDiv.style.display = 'none';
  
  window.electronAPI.onChecksumProgress((bytes) => {
    const percent = Math.round((bytes / selectedImage.size) * 100);
    btn.textContent = `Calculating... ${percent}%`;
  });
  
  try {
    const checksum = await window.electronAPI.calculateChecksum(selectedImage.path);
    resultDiv.textContent = `SHA256: ${checksum}`;
    resultDiv.style.display = 'block';
    btn.textContent = 'Recalculate Checksum';
  } catch (error) {
    alert('Error calculating checksum: ' + error.message);
    btn.textContent = 'Calculate Checksum (SHA256)';
  } finally {
    btn.disabled = false;
    window.electronAPI.removeChecksumListener();
  }
});
