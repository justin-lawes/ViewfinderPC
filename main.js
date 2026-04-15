const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Single-instance lock (Windows: ensures file-open from Explorer works reliably)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;

// --- Recent Files ---
const MAX_RECENT = 10;
let recentFiles = [];

function getRecentFilesPath() {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

function loadRecentFiles() {
  try {
    const data = fs.readFileSync(getRecentFilesPath(), 'utf-8');
    recentFiles = JSON.parse(data).filter(f => fs.existsSync(f));
  } catch {
    recentFiles = [];
  }
}

function saveRecentFiles() {
  fs.writeFileSync(getRecentFilesPath(), JSON.stringify(recentFiles));
}

function addRecentFile(filePath) {
  recentFiles = recentFiles.filter(f => f !== filePath);
  recentFiles.unshift(filePath);
  if (recentFiles.length > MAX_RECENT) recentFiles.length = MAX_RECENT;
  saveRecentFiles();
  buildMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#111',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // mainWindow.webContents.openDevTools();
  });

  // Log renderer errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Notify renderer when window maximize state changes
  mainWindow.on('maximize', () => {
    if (mainWindow) mainWindow.webContents.send('window-maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow) mainWindow.webContents.send('window-maximized', false);
  });

  loadRecentFiles();
  buildMenu();
}

// --- App Menu ---
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open File...',
          accelerator: 'CmdOrCtrl+O',
          click: () => openFileDialog(),
        },
        {
          label: 'Open Recent',
          submenu: recentFiles.length > 0
            ? [
                ...recentFiles.map((filePath, i) => ({
                  label: `${i + 1}. ${path.basename(filePath)}`,
                  click: () => {
                    addRecentFile(filePath);
                    sendToRenderer('open-file', filePath);
                  },
                })),
                { type: 'separator' },
                {
                  label: 'Clear Recent',
                  click: () => {
                    recentFiles = [];
                    saveRecentFiles();
                    buildMenu();
                  },
                },
              ]
            : [{ label: 'No Recent Files', enabled: false }],
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo Delete Comment',
          // No accelerator here — Ctrl+Z is handled in the renderer to avoid
          // double-firing (menu accelerator + keydown both triggering at once,
          // and conflicting with annotation-mode Ctrl+Z undo).
          click: () => sendToRenderer('undo-comment-delete'),
        },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        {
          label: 'Play/Pause',
          accelerator: 'Space',
          click: () => sendToRenderer('toggle-play'),
        },
        { type: 'separator' },
        {
          label: 'Frame Forward',
          accelerator: 'Right',
          click: () => sendToRenderer('frame-forward'),
        },
        {
          label: 'Frame Back',
          accelerator: 'Left',
          click: () => sendToRenderer('frame-back'),
        },
        { type: 'separator' },
        {
          label: 'Skip Forward 10s',
          accelerator: 'Shift+Right',
          click: () => sendToRenderer('skip-forward'),
        },
        {
          label: 'Skip Back 10s',
          accelerator: 'Shift+Left',
          click: () => sendToRenderer('skip-back'),
        },
        { type: 'separator' },
        {
          label: 'Increase Speed',
          accelerator: ']',
          click: () => sendToRenderer('speed-up'),
        },
        {
          label: 'Decrease Speed',
          accelerator: '[',
          click: () => sendToRenderer('speed-down'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Fullscreen',
          accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
          click: () => {
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
          },
        },
        {
          label: 'Toggle Info Panel',
          accelerator: 'I',
          click: () => sendToRenderer('toggle-info'),
        },
        {
          label: 'Toggle Timeline Thumbnails',
          click: () => sendToRenderer('toggle-thumbnails'),
        },
        { type: 'separator' },
        {
          label: 'Video Size',
          submenu: [
            { label: '25%', click: () => sendToRenderer('video-size', 0.25) },
            { label: '50%', click: () => sendToRenderer('video-size', 0.50) },
            { label: '100%', accelerator: 'CmdOrCtrl+1', click: () => sendToRenderer('video-size', 1.0) },
            { label: '200%', click: () => sendToRenderer('video-size', 2.0) },
            { type: 'separator' },
            { label: 'Fit to Window', click: () => sendToRenderer('aspect-fit') },
            { label: 'Fill Window', click: () => sendToRenderer('aspect-fill') },
            { type: 'separator' },
            { label: 'Scale Up', accelerator: 'CmdOrCtrl+Plus', click: () => sendToRenderer('video-scale', 1.25) },
            { label: 'Scale Down', accelerator: 'CmdOrCtrl+-', click: () => sendToRenderer('video-scale', 0.8) },
          ],
        },
        { type: 'separator' },
        {
          label: 'Toggle Controls',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => sendToRenderer('toggle-controls'),
        },
        {
          label: 'Minimal Controls',
          accelerator: 'CmdOrCtrl+Shift+M',
          type: 'checkbox',
          checked: false,
          click: (menuItem) => sendToRenderer('toggle-minimal-controls', menuItem.checked),
        },
        {
          label: 'Show Sketches During Playback',
          accelerator: 'CmdOrCtrl+Shift+S',
          type: 'checkbox',
          checked: false,
          click: (menuItem) => sendToRenderer('toggle-sketches-playback', menuItem.checked),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front' }]
          : [{ role: 'close' }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts…',
          accelerator: 'Shift+?',
          click: () => sendToRenderer('open-shortcuts-editor'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// --- Open File Dialog ---
async function openFileDialog() {
  try {
    const win = mainWindow || BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Video',
      filters: [
        {
          name: 'Video Files',
          extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ogv', 'wmv', 'flv'],
        },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });

    if (!result.canceled && result.filePaths.length > 0) {
      sendToRenderer('open-file', result.filePaths[0]);
      // Update recent files after sending to renderer (avoid menu rebuild blocking dialog)
      addRecentFile(result.filePaths[0]);
    }
  } catch (err) {
    console.error('openFileDialog error:', err);
  }
}

// --- Window Controls (for custom Windows titlebar) ---
ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window-close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);

// --- IPC Handlers ---
ipcMain.handle('open-file-dialog', async () => {
  if (mainWindow) mainWindow.focus();
  await openFileDialog();
});

ipcMain.handle('get-file-path', (event, filePath) => {
  return filePath;
});

ipcMain.handle('open-recent-file', () => {
  if (recentFiles.length > 0) {
    const filePath = recentFiles[0];
    if (require('fs').existsSync(filePath)) {
      sendToRenderer('open-file', filePath);
      addRecentFile(filePath);
    }
  }
});

ipcMain.handle('set-aspect-ratio', (event, ratio, extraHeight) => {
  if (mainWindow) mainWindow.setAspectRatio(ratio, { width: 0, height: Math.round(extraHeight || 0) });
});
ipcMain.handle('clear-aspect-ratio', () => {
  if (mainWindow) mainWindow.setAspectRatio(0);
});

ipcMain.handle('resize-window', (event, w, h) => {
  if (mainWindow) {
    mainWindow.setContentSize(Math.round(w), Math.round(h));
    mainWindow.center();
  }
});

ipcMain.handle('save-file', async (event, filename, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename,
    filters: [{ name: 'Text Files', extensions: ['txt'] }],
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return result.filePath;
  }
  return null;
});

ipcMain.handle('save-screenshot', async (event, dataUrl, filename) => {
  try {
    const desktopPath = app.getPath('desktop');
    const filePath = path.join(desktopPath, filename);
    const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('write-file-direct', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-file-stats', (event, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size };
  } catch {
    return { size: null };
  }
});

ipcMain.handle('get-username', () => {
  try { return os.userInfo().username; } catch { return 'User'; }
});

ipcMain.handle('read-file-direct', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return { success: true, data };
    }
    return { success: false, error: 'File not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- File open via OS (double-click a video file) ---
// macOS: open-file event
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  addRecentFile(filePath);
  if (mainWindow) {
    sendToRenderer('open-file', filePath);
  } else {
    app.once('ready', () => {
      setTimeout(() => sendToRenderer('open-file', filePath), 500);
    });
  }
});

// Windows: file passed as command-line argument
function getFileFromArgv(argv) {
  // argv[0] = electron/app, argv[1] = app path (packaged) or '--' (dev), rest = args
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args.find(a => !a.startsWith('-') && fs.existsSync(a));
}

// Windows: second instance (app already running, user opened another file)
app.on('second-instance', (event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const filePath = getFileFromArgv(argv);
    if (filePath) {
      addRecentFile(filePath);
      sendToRenderer('open-file', filePath);
    }
  }
});

// --- App lifecycle ---
app.whenReady().then(() => {
  createWindow();
  // Windows: open file passed at launch
  const filePath = getFileFromArgv(process.argv);
  if (filePath) {
    app.once('browser-window-focus', () => {
      setTimeout(() => {
        addRecentFile(filePath);
        sendToRenderer('open-file', filePath);
      }, 300);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
