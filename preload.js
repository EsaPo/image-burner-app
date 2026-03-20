const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectImage: () => ipcRenderer.invoke('select-image'),
  listDrives: (showAll) => ipcRenderer.invoke('list-drives', showAll),
  calculateChecksum: (filePath) => ipcRenderer.invoke('calculate-checksum', filePath),
  convertNRG: (nrgPath) => ipcRenderer.invoke('convert-nrg', nrgPath),
  writeImage: (options) => ipcRenderer.invoke('write-image', options),
  resizeWindow: (size) => ipcRenderer.invoke('resize-window', size),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  
  // New download functions
  downloadImage: (options) => ipcRenderer.invoke('download-image', options),
  cancelDownload: () => ipcRenderer.invoke('cancel-download'),
  validateUrl: (url) => ipcRenderer.invoke('validate-url', url),
  streamToUSB: (options) => ipcRenderer.invoke('stream-to-usb', options),
  
  onChecksumProgress: (callback) => {
    ipcRenderer.on('checksum-progress', (event, bytes) => callback(bytes));
  },
  
  onNRGConvertProgress: (callback) => {
    ipcRenderer.on('nrg-convert-progress', (event, data) => callback(data));
  },
  
  onWriteProgress: (callback) => {
    ipcRenderer.on('write-progress', (event, data) => callback(data));
  },
  
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (event, data) => callback(data));
  },
  
  onStreamProgress: (callback) => {
    ipcRenderer.on('stream-progress', (event, data) => callback(data));
  },
  
  removeChecksumListener: () => {
    ipcRenderer.removeAllListeners('checksum-progress');
  },
  
  removeNRGConvertListener: () => {
    ipcRenderer.removeAllListeners('nrg-convert-progress');
  },
  
  removeWriteListener: () => {
    ipcRenderer.removeAllListeners('write-progress');
  },
  
  removeDownloadListener: () => {
    ipcRenderer.removeAllListeners('download-progress');
  },
  
  removeStreamListener: () => {
    ipcRenderer.removeAllListeners('stream-progress');
  }
});
