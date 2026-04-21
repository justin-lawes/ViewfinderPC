const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 256, height: 256,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  win.loadFile(path.join(__dirname, 'create-icon.html'));

  ipcMain.on('icon-ready', (event, pngData) => {
    const sizes      = [16, 32, 48, 64, 128, 256];
    const pngBuffers = sizes.map(s => Buffer.from(pngData[s], 'base64'));

    // Write 256px PNG (useful as mac / linux icon source)
    fs.writeFileSync(path.join(__dirname, 'icon.png'), pngBuffers[pngBuffers.length - 1]);

    // Build multi-size ICO
    fs.writeFileSync(path.join(__dirname, 'icon.ico'), buildIco(pngBuffers, sizes));

    console.log('icon.ico created (' + sizes.join(', ') + ' px)');
    console.log('icon.png created (256 px)');
    app.quit();
  });
});

// ---------------------------------------------------------------------------
// ICO builder — embeds PNG images directly (Windows Vista+ compatible)
// ---------------------------------------------------------------------------
function buildIco(pngBuffers, sizes) {
  const count    = pngBuffers.length;
  const dirBytes = 6 + 16 * count;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = ICO
  header.writeUInt16LE(count, 4);

  let offset = dirBytes;
  const entries = pngBuffers.map((buf, i) => {
    const s   = sizes[i];
    const ent = Buffer.alloc(16);
    ent.writeUInt8(s >= 256 ? 0 : s, 0); // width  (0 means 256)
    ent.writeUInt8(s >= 256 ? 0 : s, 1); // height
    ent.writeUInt8(0,  2);               // palette colors
    ent.writeUInt8(0,  3);               // reserved
    ent.writeUInt16LE(1,  4);            // color planes
    ent.writeUInt16LE(32, 6);            // bits per pixel
    ent.writeUInt32LE(buf.length,  8);   // data size
    ent.writeUInt32LE(offset,     12);   // data offset
    offset += buf.length;
    return ent;
  });

  return Buffer.concat([header, ...entries, ...pngBuffers]);
}
