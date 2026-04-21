const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Force sRGB color profile — prevents Chromium from shifting video colors on window resize
app.commandLine.appendSwitch('force-color-profile', 'srgb');

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

  // Manual aspect-ratio enforcement for Windows (setAspectRatio+extraSize is broken there).
  // Intercept live resize and snap height (or width) to match the locked ratio.
  if (process.platform === 'win32') {
    mainWindow.on('will-resize', (event, newBounds, details) => {
      if (!aspectLock || constraining) return;
      const { ratio, chromeH } = aspectLock;
      const edge = details ? details.edge : null;
      const w = newBounds.width;
      const h = newBounds.height;

      let targetW = w;
      let targetH = h;

      // Snap the non-dragged axis to maintain ratio
      if (edge === 'left' || edge === 'right') {
        targetH = Math.round(w / ratio) + chromeH;
      } else if (edge === 'top' || edge === 'bottom') {
        targetW = Math.round((h - chromeH) * ratio);
      } else {
        // Corner drag: constrain by whichever axis changed more
        const oldBounds = mainWindow.getBounds();
        const dw = Math.abs(w - oldBounds.width);
        const dh = Math.abs(h - oldBounds.height);
        if (dw >= dh) {
          targetH = Math.round(w / ratio) + chromeH;
        } else {
          targetW = Math.round((h - chromeH) * ratio);
        }
      }

      targetW = Math.max(targetW, 400);
      targetH = Math.max(targetH, 300);

      if (targetW === w && targetH === h) return;
      event.preventDefault();
      constraining = true;
      mainWindow.setBounds({ x: newBounds.x, y: newBounds.y, width: Math.round(targetW), height: Math.round(targetH) });
      constraining = false;
    });
  }

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
          label: 'Always on Top',
          accelerator: 'CmdOrCtrl+Shift+A',
          type: 'checkbox',
          checked: false,
          click: (menuItem) => {
            mainWindow.setAlwaysOnTop(menuItem.checked);
            sendToRenderer('always-on-top', menuItem.checked);
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
        {
          label: 'Display Aspect Ratio',
          submenu: [
            { label: 'Native',  click: () => sendToRenderer('set-display-aspect', 'native') },
            { type: 'separator' },
            { label: '16:9',   click: () => sendToRenderer('set-display-aspect', 16 / 9) },
            { label: '1.85:1', click: () => sendToRenderer('set-display-aspect', 1.85) },
            { label: '2.35:1', click: () => sendToRenderer('set-display-aspect', 2.35) },
            { label: '2.39:1', click: () => sendToRenderer('set-display-aspect', 2.39) },
            { label: '4:3',    click: () => sendToRenderer('set-display-aspect', 4 / 3) },
            { label: '1:1',    click: () => sendToRenderer('set-display-aspect', 1) },
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

// Manual aspect-ratio lock state (replaces Electron's setAspectRatio which mishandles
// extraSize on Windows — it snaps against full window height, ignoring chrome height).
let aspectLock = null; // { ratio, chromeH } or null
let constraining = false;

ipcMain.handle('set-aspect-ratio', (event, ratio, extraHeight) => {
  if (!mainWindow) return;
  if (process.platform === 'darwin') {
    // macOS: native setAspectRatio works correctly
    mainWindow.setAspectRatio(ratio, { width: 0, height: Math.round(extraHeight || 0) });
  } else {
    // Windows: store lock state; will-resize handler enforces it manually
    aspectLock = ratio > 0 ? { ratio, chromeH: Math.round(extraHeight || 0) } : null;
  }
});
ipcMain.handle('clear-aspect-ratio', () => {
  if (!mainWindow) return;
  if (process.platform === 'darwin') {
    mainWindow.setAspectRatio(0);
  } else {
    aspectLock = null;
  }
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

// --- Windows file association registration ---
// Registers Viewfinder under HKCU\Software\Classes\Applications\Viewfinder.exe
// (the path Windows actually reads for the "Open with" context menu) and adds
// it to OpenWithProgids for each extension. Safe to run on every launch.
function registerOpenWithProgids() {
  if (process.platform !== 'win32') return;
  const { execFileSync } = require('child_process');
  const exePath = process.execPath;
  const exts = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ogv', 'wmv', 'flv', 'mts', 'm2ts'];
  const run = (...args) => { try { execFileSync('reg', args, { stdio: 'ignore' }); } catch {} };

  // Applications\Viewfinder.exe — Windows "Open with" discovery path
  const appKey = 'HKCU\\Software\\Classes\\Applications\\Viewfinder.exe';
  run('add', appKey, '/ve', '/d', 'Viewfinder', '/f');
  run('add', appKey, '/v', 'FriendlyAppName', '/d', 'Viewfinder', '/f');
  run('add', `${appKey}\\shell\\open\\command`, '/ve', '/d', `"${exePath}" "%1"`, '/f');
  for (const ext of exts) {
    run('add', `${appKey}\\SupportedTypes`, '/v', `.${ext}`, '/t', 'REG_NONE', '/d', '', '/f');
  }

  // OpenWithProgids — links extensions to the ViewfinderVideo ProgID
  for (const ext of exts) {
    run('add', `HKCU\\Software\\Classes\\.${ext}\\OpenWithProgids`, '/v', 'ViewfinderVideo', '/t', 'REG_NONE', '/d', '', '/f');
  }
}

// --- App lifecycle ---
app.whenReady().then(() => {
  registerOpenWithProgids();
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
