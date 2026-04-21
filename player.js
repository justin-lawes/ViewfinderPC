// ===== Viewfinder — Pro Video Player =====

(function () {
  'use strict';

  // --- Electron detection ---
  const isElectron = !!(window.viewfinder && window.viewfinder.isElectron);
  const platform = isElectron ? window.viewfinder.platform : navigator.platform;

  if (isElectron && platform === 'darwin') {
    document.body.classList.add('electron-mac');
  }
  if (isElectron && platform === 'win32') {
    document.body.classList.add('electron-win');
  }

  // --- Windows titlebar controls ---
  if (isElectron && platform === 'win32') {
    const winMinimize = document.getElementById('win-minimize');
    const winMaximize = document.getElementById('win-maximize');
    const winClose = document.getElementById('win-close');
    const restoreIcon = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="2" y="0" width="8" height="8" fill="none" stroke="currentColor"/><rect x="0" y="2" width="8" height="8" fill="none" stroke="currentColor" style="fill:var(--bg-darker)"/></svg>';
    const maximizeIcon = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>';

    if (winMinimize) winMinimize.addEventListener('click', () => window.viewfinder.windowMinimize());
    if (winMaximize) winMaximize.addEventListener('click', () => window.viewfinder.windowMaximize());
    if (winClose) winClose.addEventListener('click', () => window.viewfinder.windowClose());

    // Sync maximize/restore icon
    function updateMaximizeIcon(isMax) {
      if (winMaximize) {
        winMaximize.innerHTML = isMax ? restoreIcon : maximizeIcon;
        winMaximize.title = isMax ? 'Restore' : 'Maximize';
      }
    }

    window.viewfinder.isMaximized().then(updateMaximizeIcon);
    window.viewfinder.onMaximizeChange(updateMaximizeIcon);
  }

  // --- Fetch OS username ---
  if (isElectron) {
    window.viewfinder.getUsername().then(u => { currentUser = u || 'User'; }).catch(() => {});
  }

  // --- DOM refs ---
  const $ = (s) => document.querySelector(s);
  const video = $('#video');
  const welcome = $('#welcome');
  const player = $('#player');
  const fileInput = $('#file-input');
  const openBtn = $('#open-file-btn');
  const dropOverlay = $('#drop-overlay');

  // Controls
  const playBtn = $('#play-btn');
  const playIcon = $('#play-icon');
  const pauseIcon = $('#pause-icon');
  const timecodeEl = $('#timecode');
  const volumeBtn = $('#volume-btn');
  const volOn = $('#vol-on');
  const volOff = $('#vol-off');
  const volumeSlider = $('#volume-slider');
  const fullscreenBtn = $('#fullscreen-btn');
  const speedBtn = $('#speed-btn');
  const loopBtn = $('#loop-btn');
  const infoBtn = $('#info-btn');
  const infoPanel = $('#info-panel');
  const infoClose = $('#info-close');
  const infoContent = $('#info-content');
  const zoomBtn = $('#zoom-btn');
  const aspectBtn = $('#aspect-btn');

  // Timeline
  const timelineContainer = $('#timeline-container');
  const barcodeCanvas = $('#barcode-timeline');
  const progressFill = $('#progress-fill');
  const playhead = $('#playhead');
  const timelineHover = $('#timeline-hover');
  const hoverTime = $('#hover-time');

  // Zoom
  const zoomOverlay = $('#zoom-overlay');
  const zoomCanvas = $('#zoom-canvas');
  const zoomLevelEl = $('#zoom-level');

  // --- State ---
  let currentFile = null;
  let currentUser = 'User';
  let fps = 24; // default assumption
  let shuttleSpeed = 0; // J/K/L shuttle: -2,-1,0,1,2
  let shuttleInterval = null;
  let controlsTimeout = null;
  let isZoomed = false;
  let speedMenuOpen = false;
  let currentAspect = 'native';
  let barcodeGenerated = false;

  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
  const aspects = [
    { label: 'Native', value: 'native' },
    { label: '16:9', value: 16 / 9 },
    { label: '1.85:1', value: 1.85 },
    { label: '2.35:1', value: 2.35 },
    { label: '2.39:1', value: 2.39 },
    { label: '4:3', value: 4 / 3 },
    { label: '1:1', value: 1 },
  ];

  // --- File Loading ---
  openBtn.addEventListener('click', () => {
    if (isElectron) {
      window.viewfinder.openFileDialog().catch(err => console.error('openFileDialog failed:', err));
    } else {
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });

  // Electron: receive file path from main process
  if (isElectron) {
    window.viewfinder.onOpenFile((filePath) => {
      loadFilePath(filePath);
    });
  }

  function loadFile(file) {
    // In Electron, dragged/picked files expose file.path — use it so sidecars work
    const filePath = (isElectron && file.path) ? file.path : null;
    currentFile = { name: file.name, size: file.size, type: file.type, path: filePath };
    const url = URL.createObjectURL(file);
    setVideoSource(url);
    const titleEl = document.querySelector('.win-titlebar-title');
    if (titleEl) titleEl.textContent = file.name + ' — Viewfinder';
    if (filePath) addToPlaylist(file.name, filePath, true);
  }

  function loadFilePath(filePath) {
    // Electron: load local file by path
    const fileName = filePath.split(/[\\/]/).pop();
    currentFile = { name: fileName, size: null, type: '', path: filePath };
    // Build a valid file URL on both Windows (C:\...) and Unix (/...)
    const normalized = filePath.replace(/\\/g, '/');
    const url = normalized.startsWith('/') ? 'file://' + normalized : 'file:///' + normalized;
    setVideoSource(url);
    document.title = fileName + ' — Viewfinder';
    const titleEl = document.querySelector('.win-titlebar-title');
    if (titleEl) titleEl.textContent = fileName + ' — Viewfinder';
    addToPlaylist(fileName, filePath, true);
    // Fetch file size from main process (not available on File objects for path-opened files)
    if (isElectron) {
      window.viewfinder.getFileStats(filePath).then(stats => {
        if (stats && stats.size != null) {
          currentFile.size = stats.size;
          if (infoPanel && !infoPanel.classList.contains('hidden')) updateInfoPanel();
        }
      }).catch(() => {});
    }
  }

  function setVideoSource(url) {
    video.src = url;
    video.load();
    commentUndoStack = []; // clear undo history — stale entries from a previous file must not bleed into the next
    setDisplayAspect('native'); // reset any forced aspect ratio override

    video.addEventListener('loadedmetadata', function onMeta() {
      video.removeEventListener('loadedmetadata', onMeta);
      welcome.classList.add('hidden');
      player.classList.remove('hidden');
      barcodeGenerated = false;
      // Re-apply user's chosen speed — video.load() resets playbackRate to 1.0 per HTML5 spec
      video.playbackRate = userSpeed;
      generateBarcode();
      updateInfoPanel();
      detectFPS();
      loadCommentsFromFile();
      if (isElectron && video.videoWidth && video.videoHeight) {
        // Defer one frame so the browser has done a layout pass (offsetHeight would be
        // 0 for elements that just became visible before layout runs).
        // Double-rAF: first frame applies styles, second frame has guaranteed layout.
        requestAnimationFrame(() => requestAnimationFrame(async () => {
          // Use known CSS heights for fixed elements; only timeline varies by mode.
          const WIN_TITLEBAR_H = 32;   // CSS: .win-titlebar { height: 32px }
          const CONTROL_BAR_H = 40;    // CSS: .control-bar { height: 40px }
          const tlH = timelineContainer
            ? (timelineContainer.offsetHeight || 50)  // fall back to CSS default if 0
            : 50;
          const chromeH = WIN_TITLEBAR_H + tlH + CONTROL_BAR_H;
          console.log('[resize] innerW:', window.innerWidth, 'innerH:', window.innerHeight,
            'tlH:', tlH, 'chromeH:', chromeH,
            'video:', video.videoWidth, 'x', video.videoHeight);

          const aspect = video.videoWidth / video.videoHeight;
          const maxW = Math.floor(window.screen.availWidth * 0.95);
          const maxH = Math.floor(window.screen.availHeight * 0.95);

          // Mac approach: keep current window width, adjust height to match aspect ratio.
          // Much more reliable than trying to hit native pixel dimensions.
          let targetW = Math.round(window.innerWidth);
          let targetVideoH = Math.round(targetW / aspect);

          // Scale down if derived height (or width) exceeds screen
          if (targetVideoH + chromeH > maxH || targetW > maxW) {
            const scale = Math.min(maxW / targetW, (maxH - chromeH) / targetVideoH);
            targetW = Math.round(targetW * scale);
            targetVideoH = Math.round(targetVideoH * scale);
          }

          if (targetW < 640) {
            targetW = 640;
            targetVideoH = Math.round(targetW / aspect);
          }

          // Resize to exact video dimensions. On Windows, setAspectRatio with extraSize
          // is broken (snaps against full height, ignoring chrome) so we skip it here;
          // the main process will-resize handler enforces ratio during live drag instead.
          await window.viewfinder.resizeWindow(targetW, targetVideoH + chromeH);
          window.viewfinder.setAspectRatio(aspect, chromeH); // no-op on Win, works on Mac
        }));
      }
    });
  }

  // --- Drag & Drop ---
  let dragCounter = 0;

  const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv|avi|webm|m4v|ogv|wmv|flv|mts|m2ts|ts|vob|3gp|f4v)$/i;

  function isInsidePlaylistPanel(el) {
    return playlistPanel && playlistPanel.contains(el);
  }

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (isInsidePlaylistPanel(e.target)) return;
    dragCounter++;
    if (dragCounter === 1) dropOverlay.classList.remove('hidden');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (isInsidePlaylistPanel(e.target)) return;
    dragCounter--;
    if (dragCounter === 0) dropOverlay.classList.add('hidden');
  });

  document.addEventListener('dragover', (e) => e.preventDefault());

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    // If dropped onto the playlist panel, let its own handler deal with it
    if (isInsidePlaylistPanel(e.target)) return;
    dragCounter = 0;
    dropOverlay.classList.add('hidden');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    // On Windows/Electron, file.type is often empty for local video files — check extension too
    if (file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name)) {
      loadFile(file);
    }
  });

  // --- Play / Pause ---
  playBtn.addEventListener('click', togglePlay);

  // Shared scrub state (used by both timeline and video drag scrubbing)
  let isScrubbing = false;
  let wasPlayingBeforeScrub = false;
  let scrubTarget = 0;
  let scrubDirty = false;       // a newer target arrived while seek was in-flight
  let scrubSeekPending = false; // a seek has been issued and not yet completed
  let scrubRect = null;         // cached timeline bounding rect

  // Use fastSeek() during scrubbing — snaps to nearest keyframe, much faster than
  // currentTime which decodes to the exact frame. Precise seek is applied on mouse up.
  const hasFastSeek = typeof video.fastSeek === 'function';
  function scrubSeek(t) {
    if (hasFastSeek) video.fastSeek(t);
    else video.currentTime = t;
  }

  // Seeked-event-gated scrub: fires when the video decoder confirms a seek completed.
  // If the mouse moved while the seek was in-flight (scrubDirty), issue one more seek.
  function onScrubSeeked() {
    if (!isScrubbing) return;
    scrubSeekPending = false;
    if (scrubDirty) {
      scrubDirty = false;
      scrubSeekPending = true;
      scrubSeek(scrubTarget);
    }
  }

  function startScrub() {
    if (isScrubbing) return;
    isScrubbing = true;
    scrubSeekPending = false;
    scrubDirty = false;
    wasPlayingBeforeScrub = !video.paused;
    video.pause();
    scrubRect = timelineContainer.getBoundingClientRect(); // cache once
    video.addEventListener('seeked', onScrubSeeked);
  }

  function endScrub() {
    isScrubbing = false;
    video.removeEventListener('seeked', onScrubSeeked);
    scrubSeekPending = false;
    scrubRect = null;
    // Final precise seek to exact frame at mouse release position
    video.currentTime = scrubTarget;
    if (wasPlayingBeforeScrub) video.play();
  }

  // Issue or queue a seek to the current scrubTarget.
  // Called by both timeline and video-drag scrub paths.
  function flushScrub() {
    if (!scrubSeekPending) {
      scrubSeekPending = true;
      scrubDirty = false;
      scrubSeek(scrubTarget);
    } else {
      scrubDirty = true;
    }
  }

  // Click to play/pause, drag horizontally to scrub, double-click for fullscreen
  let videoMouseDown = false;
  let videoMouseStartX = 0;
  let videoMouseStartTime = 0;
  let videoDidDrag = false;

  video.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || isZoomed || colorPickerActive) return;
    videoMouseDown = true;
    videoDidDrag = false;
    videoMouseStartX = e.clientX;
    videoMouseStartTime = video.currentTime;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!videoMouseDown) return;
    const dx = e.clientX - videoMouseStartX;
    if (Math.abs(dx) > 5) {
      if (!videoDidDrag) {
        videoDidDrag = true;
        startScrub();
      }
      // Map horizontal drag to time: full window width = full duration
      const pxPerSec = video.duration / video.parentElement.offsetWidth;
      const newTime  = videoMouseStartTime + dx * pxPerSec;
      scrubTarget    = Math.max(0, Math.min(video.duration, newTime));
      flushScrub();
      timecodeEl.textContent = formatTimecode(scrubTarget);
      updateFrameCount(scrubTarget);
      // Move playhead to cursor position (not video.currentTime which lags behind)
      const pct = scrubTarget / video.duration;
      playhead.style.transform = 'translateX(' + (pct * timelineContainer.offsetWidth) + 'px)';
      progressFill.style.width = (pct * 100) + '%';
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (!videoMouseDown) return;
    videoMouseDown = false;
    if (videoDidDrag) endScrub();
  });

  video.addEventListener('click', (e) => {
    if (!videoDidDrag) togglePlay();
  });

  video.addEventListener('dblclick', toggleFullscreen);

  function togglePlay() {
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
    resetShuttle();
  }

  video.addEventListener('play', () => {
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
    showControls(); // kick off the 3s auto-hide timer
  });

  video.addEventListener('pause', () => {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
    clearTimeout(controlsTimeout);
    if (!allControlsHidden) player.classList.remove('controls-hidden');
  });

  // --- Timecode ---
  function formatTimecode(seconds) {
    const duration = video.duration || 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * fps);
    if (duration >= 3600) {
      return (
        String(h).padStart(2, '0') + ':' +
        String(m).padStart(2, '0') + ':' +
        String(s).padStart(2, '0') + ':' +
        String(f).padStart(2, '0')
      );
    }
    return (
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + ':' +
      String(f).padStart(2, '0')
    );
  }

  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  const frameCountEl = $('#frame-count');

  // Use requestAnimationFrame for smooth, realtime playback display
  function playbackDisplayLoop() {
    if (!video.paused && !isScrubbing) {
      timecodeEl.textContent = formatTimecode(video.currentTime);
      updateFrameCount(video.currentTime);
      updatePlayhead();
    }
    // Keep panel input timecode live during playback
    if (commentsPanelOpen && panelInputTc && !panelCommentInput?.matches(':focus')) {
      panelInputTc.textContent = formatTimecode(video.currentTime);
    }
    requestAnimationFrame(playbackDisplayLoop);
  }
  requestAnimationFrame(playbackDisplayLoop);

  function updateFrameCount(time) {
    const totalFrame = Math.floor(time * fps);
    const totalFrames = Math.floor((video.duration || 0) * fps);
    const digits = Math.max(String(totalFrames).length, 5);
    frameCountEl.textContent = 'F' + String(totalFrame).padStart(digits, '0');
  }

  // --- Timecode click-to-copy ---
  timecodeEl.title = 'Click to copy timecode';
  timecodeEl.addEventListener('click', () => {
    if (!video.src) return;
    const tc = timecodeEl.textContent;
    navigator.clipboard.writeText(tc)
      .then(() => showToast('Timecode copied: ' + tc))
      .catch(() => {});
  });

  // --- FPS Detection ---
  let fpsDetectGeneration = 0; // incremented on each new file load to cancel stale polls
  function detectFPS() {
    const gen = ++fpsDetectGeneration;
    // Use a hidden offscreen video to detect FPS without affecting the visible player
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const detector = document.createElement('video');
      detector.src = video.src;
      detector.muted = true;
      detector.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(detector);

      let lastTime = null;
      let samples = [];

      function onFrame(now, metadata) {
        if (lastTime !== null) {
          const delta = metadata.mediaTime - lastTime;
          if (delta > 0 && delta < 0.2) {
            samples.push(1 / delta);
          }
        }
        lastTime = metadata.mediaTime;
        if (samples.length < 10) {
          detector.requestVideoFrameCallback(onFrame);
        } else {
          const avg = samples.reduce((a, b) => a + b) / samples.length;
          const standards = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
          fps = standards.reduce((prev, curr) =>
            Math.abs(curr - avg) < Math.abs(prev - avg) ? curr : prev
          );
          detector.pause();
          detector.src = '';
          detector.remove();
          // Refresh info panel now that accurate fps is known
          if (infoPanel && !infoPanel.classList.contains('hidden')) updateInfoPanel();
        }
      }

      detector.addEventListener('canplay', () => {
        detector.play().then(() => {
          detector.requestVideoFrameCallback(onFrame);
        }).catch(() => {
          detector.remove();
        });
      }, { once: true });

      detector.load();
    } else {
      // RAF-poll fallback for browsers without requestVideoFrameCallback
      // Sample currentTime changes during actual playback to infer frame rate
      let lastT = -1, deltas = [], rafId = null;
      function poll() {
        if (gen !== fpsDetectGeneration) { cancelAnimationFrame(rafId); return; } // stale
        const t = video.currentTime;
        if (!video.paused && t !== lastT && lastT >= 0) {
          const d = t - lastT;
          if (d > 0 && d < 0.1) deltas.push(d);
        }
        lastT = t;
        if (deltas.length >= 15) {
          cancelAnimationFrame(rafId);
          rafId = null;
          const avg = deltas.reduce((a, b) => a + b) / deltas.length;
          const standards = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
          fps = standards.reduce((prev, curr) =>
            Math.abs(curr - 1 / avg) < Math.abs(prev - 1 / avg) ? curr : prev
          );
          if (infoPanel && !infoPanel.classList.contains('hidden')) updateInfoPanel();
        } else {
          rafId = requestAnimationFrame(poll);
        }
      }
      function startPoll() {
        if (gen !== fpsDetectGeneration) return; // stale listener from a previous file load
        if (!rafId) { lastT = -1; deltas = []; rafId = requestAnimationFrame(poll); }
      }
      if (!video.paused) {
        startPoll();
      } else {
        video.addEventListener('play', startPoll, { once: true });
      }
    }
  }

  // --- Timeline / Barcode ---
  let barcodeGenerationId = 0; // Cancel stale generations

  function generateBarcode() {
    if (barcodeGenerated) return;
    const dpr = window.devicePixelRatio || 1;
    const containerWidth = timelineContainer.offsetWidth;
    const containerHeight = timelineContainer.offsetHeight;

    const duration = video.duration;
    if (!duration || duration === Infinity) return;

    // Render to offscreen canvas, then copy to visible canvas when done
    const offscreen = document.createElement('canvas');
    offscreen.width = containerWidth * dpr;
    offscreen.height = containerHeight * dpr;
    const ctx = offscreen.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, containerWidth, containerHeight);

    const videoAspect = video.videoWidth / video.videoHeight;
    const thumbWidth = containerHeight * videoAspect;
    // Show roughly half as many thumbnails as would tile edge-to-edge
    const numSamples = Math.max(Math.ceil(containerWidth / (thumbWidth * 2)), 10);
    const sampleWidth = containerWidth / numSamples;
    const stripAspect = sampleWidth / containerHeight;

    const sampler = document.createElement('video');
    sampler.preload = 'auto';
    sampler.src = video.src;
    sampler.muted = true;

    const genId = ++barcodeGenerationId;
    let idx = 0;

    function drawNextSample() {
      if (genId !== barcodeGenerationId) {
        // Cancelled by a newer generation
        sampler.src = '';
        sampler.remove();
        return;
      }
      if (idx >= numSamples) {
        // Done — copy offscreen to visible canvas all at once
        barcodeCanvas.width = offscreen.width;
        barcodeCanvas.height = offscreen.height;
        const visCtx = barcodeCanvas.getContext('2d');
        visCtx.drawImage(offscreen, 0, 0);
        barcodeGenerated = true;
        sampler.src = '';
        sampler.remove();
        return;
      }

      const time = (idx / numSamples) * duration;
      sampler.currentTime = time;
    }

    sampler.addEventListener('seeked', () => {
      if (genId !== barcodeGenerationId) { sampler.src = ''; sampler.remove(); return; }
      const vw = sampler.videoWidth;
      const vh = sampler.videoHeight;
      const x = idx * sampleWidth - 1;
      const w = sampleWidth + 2;

      let sx, sy, sw, sh;
      if (videoAspect > stripAspect) {
        sh = vh;
        sw = vh * stripAspect;
        sx = (vw - sw) / 2;
        sy = 0;
      } else {
        sw = vw;
        sh = vw / stripAspect;
        sx = 0;
        sy = (vh - sh) / 2;
      }
      ctx.drawImage(sampler, sx, sy, sw, sh, x, 0, w, containerHeight);

      idx++;
      drawNextSample();
    });

    sampler.addEventListener('loadeddata', () => {
      drawNextSample();
    });
  }

  // Timeline modes: 0 = scrub bar, 1 = thumbnails, 2 = minimal controls, 3 = clean (no controls)
  let timelineMode = 0;

  const timelineToggleBtn = $('#timeline-toggle-btn');

  const timelineModeLabels = ['Scrub bar', 'Thumbnails', 'Minimal', 'Hidden'];

  function applyTimelineMode() {
    const bar = document.querySelector('.control-bar');
    timelineContainer.classList.remove('minimal', 'minimal-controls', 'timeline-hidden');
    if (bar) bar.classList.remove('minimal-controls', 'controls-hidden-all');
    if (timelineMode === 0) {
      timelineContainer.classList.add('minimal');
    } else if (timelineMode === 2) {
      timelineContainer.classList.add('minimal', 'minimal-controls');
      if (bar) bar.classList.add('minimal-controls');
    } else if (timelineMode === 3) {
      timelineContainer.classList.add('timeline-hidden');
      if (bar) bar.classList.add('controls-hidden-all');
    }
    if (timelineToggleBtn) {
      timelineToggleBtn.classList.toggle('active', timelineMode !== 0);
      timelineToggleBtn.title = `Timeline: ${timelineModeLabels[timelineMode]} (T)`;
    }
    updatePlayhead();
  }

  function cycleTimelineMode() {
    timelineMode = (timelineMode + 1) % 4;
    applyTimelineMode();
  }

  // Apply default
  applyTimelineMode();

  if (timelineToggleBtn) timelineToggleBtn.addEventListener('click', cycleTimelineMode);

  function updatePlayhead() {
    if (!video.duration) return;
    const pct = video.currentTime / video.duration;
    const x = pct * timelineContainer.offsetWidth;
    playhead.style.transform = 'translateX(' + x + 'px)';
    progressFill.style.width = (pct * 100) + '%';

    // Show/hide annotations based on proximity to a comment
    if (!annotationMode && annotationCanvas) {
      if (!showSketchesDuringPlayback && !video.paused) {
        if (!annotationCanvas.classList.contains('hidden')) {
          annotationCanvas.classList.add('hidden');
        }
      } else {
        const threshold = 0.1; // seconds
        const match = comments.find(c =>
          c.annotations && c.annotations.length > 0 &&
          Math.abs(c.time - video.currentTime) < threshold
        );
        if (match) {
          renderAnnotationsOnCanvas(match.annotations);
        } else if (!annotationCanvas.classList.contains('hidden')) {
          annotationCanvas.classList.add('hidden');
        }
      }
    }
  }

  // Timeline seeking — waits for each seek to complete before issuing next
  timelineContainer.addEventListener('mousedown', (e) => {
    startScrub();
    updateScrubFromMouse(e);

    const onMove = (e) => {
      if (!isScrubbing) return;
      updateScrubFromMouse(e);
    };

    const onUp = () => {
      endScrub();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function updateScrubFromMouse(e) {
    const rect  = scrubRect || timelineContainer.getBoundingClientRect();
    const pct   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    scrubTarget = pct * video.duration;
    flushScrub();
    playhead.style.transform = 'translateX(' + (pct * rect.width) + 'px)';
    progressFill.style.width = (pct * 100) + '%';
    timecodeEl.textContent = formatTimecode(scrubTarget);
    updateFrameCount(scrubTarget);
  }

  // Timeline hover tooltip
  timelineContainer.addEventListener('mousemove', (e) => {
    const rect = timelineContainer.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const time = pct * video.duration;

    timelineHover.classList.remove('hidden');
    timelineHover.style.left = e.clientX - rect.left + 'px';
    hoverTime.textContent = formatTimecode(Math.max(0, time));
  });

  timelineContainer.addEventListener('mouseleave', () => {
    timelineHover.classList.add('hidden');
  });

  // --- Volume ---
  volumeBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    updateVolumeUI();
    try { localStorage.setItem('vf_muted', video.muted); } catch {}
  });

  volumeSlider.addEventListener('input', () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = false;
    updateVolumeUI();
    try { localStorage.setItem('vf_volume', video.volume); localStorage.setItem('vf_muted', 'false'); } catch {}
  });

  function updateVolumeUI() {
    if (video.muted || video.volume === 0) {
      volOn.classList.add('hidden');
      volOff.classList.remove('hidden');
    } else {
      volOn.classList.remove('hidden');
      volOff.classList.add('hidden');
    }
    volumeSlider.value = video.muted ? 0 : video.volume;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      player.requestFullscreen().catch(() => {});
    }
  }

  // --- Hide All Controls ---
  let allControlsHidden = false;
  function toggleHideAllControls() {
    allControlsHidden = !allControlsHidden;
    const controls = $('#controls');
    const titlebar = $('#titlebar');
    const winTitlebar = $('#win-titlebar');
    if (allControlsHidden) {
      if (controls) controls.style.display = 'none';
      if (titlebar) titlebar.style.display = 'none';
      if (winTitlebar) winTitlebar.style.display = 'none';
      player.style.cursor = 'none';
    } else {
      if (controls) controls.style.display = '';
      if (titlebar) titlebar.style.display = '';
      if (winTitlebar) winTitlebar.style.display = '';
      player.style.cursor = '';
    }
  }

  // --- Playback Speed ---
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = speedMenuOpen;
    closeMenus();
    if (!wasOpen) showSpeedMenu();
  });

  function showSpeedMenu() {
    closeMenus();
    speedMenuOpen = true;
    const menu = document.createElement('div');
    menu.className = 'speed-menu';
    menu.id = 'speed-menu';

    const rect = speedBtn.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    menu.style.right = (playerRect.right - rect.right) + 'px';

    speeds.forEach((s) => {
      const btn = document.createElement('button');
      btn.textContent = s + 'x';
      if (video.playbackRate === s) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        setUserSpeed(s);
        closeMenus();
      });
      menu.appendChild(btn);
    });

    player.appendChild(menu);
  }

  // --- Aspect Ratio Override ---
  function showAspectMenu() {
    const menu = document.createElement('div');
    menu.className = 'aspect-menu';
    menu.id = 'aspect-menu';
    const rect = aspectBtn.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    menu.style.right = (playerRect.right - rect.right) + 'px';
    aspects.forEach(a => {
      const btn = document.createElement('button');
      btn.textContent = a.label;
      if (currentAspect === a.value) btn.classList.add('selected');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setDisplayAspect(a.value);
        closeMenus();
      });
      menu.appendChild(btn);
    });
    player.appendChild(menu);
  }

  function setDisplayAspect(value) {
    currentAspect = value;
    if (value === 'native') {
      // Restore CSS-driven sizing
      video.style.width = '';
      video.style.height = '';
      video.style.maxWidth = '';
      video.style.maxHeight = '';
      video.style.aspectRatio = '';
    } else {
      // Override element sizing: auto + max-constraints + explicit AR forces letterboxing
      video.style.width = 'auto';
      video.style.height = 'auto';
      video.style.maxWidth = '100%';
      video.style.maxHeight = '100%';
      video.style.aspectRatio = String(value);
    }
    const a = aspects.find(a => a.value === value);
    if (aspectBtn) aspectBtn.textContent = a ? a.label : 'AR';
  }

  if (aspectBtn) {
    aspectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = !!document.getElementById('aspect-menu');
      closeMenus();
      if (!wasOpen) showAspectMenu();
    });
  }

  // --- Crop/Letterbox (buttons removed but keep state for menu commands) ---
  let cropMode = 'fit';

  // --- Zoom (scroll wheel zoom + drag to pan) ---
  let zoomScale = 1;
  let panX = 0, panY = 0;
  let isPanning = false;
  let panStartX = 0, panStartY = 0;
  let panStartPanX = 0, panStartPanY = 0;
  const videoContainer = $('#video-container');

  function applyZoom() {
    isZoomed = zoomScale > 1;
    const transform = `scale(${zoomScale}) translate(${panX}px, ${panY}px)`;
    video.style.transform = transform;
    video.style.transformOrigin = 'center center';
    // Keep annotation canvas in sync with video zoom
    if (annotationCanvas) {
      annotationCanvas.style.transform = transform;
      annotationCanvas.style.transformOrigin = 'center center';
    }
    if (zoomBtn) zoomBtn.classList.toggle('active', isZoomed);
  }

  function clampPan() {
    if (zoomScale <= 1) { panX = 0; panY = 0; return; }
    const maxPanX = (zoomScale - 1) / zoomScale * video.offsetWidth / 2;
    const maxPanY = (zoomScale - 1) / zoomScale * video.offsetHeight / 2;
    panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
    panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
  }

  videoContainer.addEventListener('wheel', (e) => {
    if (colorPickerActive) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.8 : 1.25;
    zoomScale = Math.max(1, Math.min(10, zoomScale * delta));
    if (zoomScale < 1.05) zoomScale = 1;
    clampPan();
    applyZoom();
  }, { passive: false });

  videoContainer.addEventListener('mousedown', (e) => {
    if (colorPickerActive || !isZoomed || e.button !== 0) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartPanX = panX;
    panStartPanY = panY;
    videoContainer.style.cursor = 'grabbing';
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    const dx = (e.clientX - panStartX) / zoomScale;
    const dy = (e.clientY - panStartY) / zoomScale;
    panX = panStartPanX + dx;
    panY = panStartPanY + dy;
    clampPan();
    applyZoom();
  });

  document.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      videoContainer.style.cursor = '';
    }
  });

  if (zoomBtn) {
    zoomBtn.addEventListener('click', () => {
      if (isZoomed) {
        zoomScale = 1;
        panX = 0;
        panY = 0;
      } else {
        zoomScale = 2;
      }
      applyZoom();
    });
  }

  // --- Loop ---
  function toggleLoop() {
    video.loop = !video.loop;
    loopBtn.classList.toggle('active', video.loop);
  }
  loopBtn.addEventListener('click', toggleLoop);

  // --- Screenshot ---
  const screenshotBtn = $('#screenshot-btn');

  function screenshotToClipboard() {
    if (!video.src) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (blob) {
        try {
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          showToast('Screenshot copied to clipboard');
        } catch (e) {}
      }
    }, 'image/png');
  }

  function screenshotToDesktop() {
    if (!video.src) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    // Also copy to clipboard
    canvas.toBlob(blob => {
      if (blob) {
        try { navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch (e) {}
      }
    }, 'image/png');
    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    const tc = formatTimecode(video.currentTime).replace(/:/g, '-');
    const baseName = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'frame';
    const filename = `${baseName}_${tc}.jpg`;
    if (isElectron) {
      window.viewfinder.saveScreenshot(dataUrl, filename).then(result => {
        if (result && result.success) showToast('Screenshot saved to Desktop & clipboard');
      });
    } else {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      a.click();
    }
  }

  if (screenshotBtn) {
    screenshotBtn.addEventListener('click', (e) => {
      if (e.altKey) screenshotToDesktop();
      else screenshotToClipboard();
    });
  }

  // --- Fullscreen button ---
  if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    if (fullscreenBtn) fullscreenBtn.classList.toggle('active', !!document.fullscreenElement);
  });

  function showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:8px 20px;border-radius:6px;font-size:13px;z-index:1000;opacity:0;transition:opacity 0.3s;pointer-events:none;';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
  }

  // --- Color Picker ---
  const colorOverlay = $('#color-picker-overlay');
  const colorCrosshair = $('#color-crosshair');
  const colorSwatch = $('#color-swatch');
  const colorValues = $('#color-values');
  const colorInfo = $('#color-picker-info');
  const colorMagnifier = $('#color-magnifier');
  let colorPickerActive = false;
  const colorCanvas = document.createElement('canvas');
  const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });

  // Set up magnifier canvas
  colorMagnifier.width = 120;
  colorMagnifier.height = 120;
  const magnCtx = colorMagnifier.getContext('2d', { willReadFrequently: true });

  function toggleColorPicker() {
    colorPickerActive = !colorPickerActive;
    colorOverlay.classList.toggle('hidden', !colorPickerActive);
  }

  colorOverlay.addEventListener('mousemove', (e) => {
    const rect = video.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Position crosshair
    colorCrosshair.style.left = e.offsetX + 'px';
    colorCrosshair.style.top = e.offsetY + 'px';

    // Sample pixel from video
    colorCanvas.width = video.videoWidth;
    colorCanvas.height = video.videoHeight;
    colorCtx.drawImage(video, 0, 0);

    // Map mouse position to video pixel coordinates
    const scaleX = video.videoWidth / rect.width;
    const scaleY = video.videoHeight / rect.height;
    const px = Math.floor(x * scaleX);
    const py = Math.floor(y * scaleY);

    if (px >= 0 && px < video.videoWidth && py >= 0 && py < video.videoHeight) {
      const pixel = colorCtx.getImageData(px, py, 1, 1).data;
      const r = pixel[0], g = pixel[1], b = pixel[2];
      const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

      colorSwatch.style.background = hex;
      colorValues.innerHTML = `${hex.toUpperCase()}<br>R:${r} G:${g} B:${b}`;

      // Draw magnifier: 30-video-pixel radius → 120px circle (4× zoom)
      const srcR = 30;
      magnCtx.clearRect(0, 0, 120, 120);
      magnCtx.save();
      magnCtx.beginPath();
      magnCtx.arc(60, 60, 60, 0, Math.PI * 2);
      magnCtx.clip();
      magnCtx.imageSmoothingEnabled = false;
      // Clamp source rect so it never overruns the canvas on any edge
      const srcX = Math.max(0, Math.min(colorCanvas.width  - srcR * 2, px - srcR));
      const srcY = Math.max(0, Math.min(colorCanvas.height - srcR * 2, py - srcR));
      magnCtx.drawImage(colorCanvas, srcX, srcY, srcR * 2, srcR * 2, 0, 0, 120, 120);
      // Crosshair at center
      magnCtx.strokeStyle = 'rgba(255,255,255,0.9)';
      magnCtx.lineWidth = 1;
      magnCtx.beginPath();
      magnCtx.moveTo(50, 60); magnCtx.lineTo(70, 60);
      magnCtx.moveTo(60, 50); magnCtx.lineTo(60, 70);
      magnCtx.stroke();
      magnCtx.restore();
    }

    // Position magnifier below cursor, flip above if near bottom; clamp to overlay bounds
    const overlayRect2 = colorOverlay.getBoundingClientRect();
    let magX = e.offsetX - 60;
    let magY = e.offsetY + 20;
    if (e.offsetY + 20 + 120 > overlayRect2.height) magY = e.offsetY - 20 - 120;
    magX = Math.max(0, Math.min(overlayRect2.width - 120, magX));
    magY = Math.max(0, magY);
    colorMagnifier.style.left = magX + 'px';
    colorMagnifier.style.top = magY + 'px';

    // Position info panel to the right of cursor, flip left if near right edge
    const overlayW = colorOverlay.getBoundingClientRect().width;
    const infoW = colorInfo.offsetWidth || 140;
    let infoX = e.offsetX + 25;
    if (infoX + infoW > overlayW) infoX = e.offsetX - 25 - infoW;
    colorInfo.style.left = infoX + 'px';
    colorInfo.style.top = (e.offsetY - 15) + 'px';
  });

  colorOverlay.addEventListener('click', (e) => {
    // Copy hex value to clipboard
    const text = colorValues.innerHTML;
    const hex = text.match(/#[0-9A-F]{6}/i);
    if (hex && navigator.clipboard) {
      navigator.clipboard.writeText(hex[0]);
      showToast('Copied ' + hex[0]);
    }
  });

  // --- Info Panel ---
  if (infoBtn) infoBtn.addEventListener('click', () => {
    infoPanel.classList.toggle('hidden');
    infoBtn.classList.toggle('active');
  });

  infoClose.addEventListener('click', () => {
    infoPanel.classList.add('hidden');
    if (infoBtn) infoBtn.classList.remove('active');
  });

  function detectCodec() {
    if (!currentFile) return null;
    const ext = currentFile.name.split('.').pop().toLowerCase();
    const map = {
      mp4: 'H.264 / MP4', m4v: 'H.264 / MP4', mov: 'MOV',
      mkv: 'MKV', webm: 'VP9 / WebM', avi: 'AVI',
      wmv: 'WMV', flv: 'FLV', ogv: 'Theora / OGV',
      mts: 'MPEG-2 TS', m2ts: 'MPEG-2 TS', ts: 'MPEG-2 TS',
    };
    return map[ext] || (ext ? ext.toUpperCase() : null);
  }

  function updateInfoPanel() {
    if (!currentFile) return;
    const codec = detectCodec();
    const rows = [
      ['Filename', currentFile.name],
      codec ? ['Codec', codec] : null,
      currentFile.size ? ['Size', formatBytes(currentFile.size)] : null,
      ['Duration', formatTime(video.duration)],
      ['Resolution', `${video.videoWidth} × ${video.videoHeight}`],
      ['Frame Rate', fps + ' fps'],
    ].filter(Boolean);

    infoContent.innerHTML = rows
      .map(([label, value]) =>
        `<div class="info-row"><span class="info-label">${label}</span><span class="info-value">${value}</span></div>`
      )
      .join('');
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  // --- Close menus ---
  function closeMenus() {
    speedMenuOpen = false;
    const existing = document.querySelectorAll('.aspect-menu, .speed-menu');
    existing.forEach((m) => m.remove());
  }

  document.addEventListener('click', () => closeMenus());

  // --- Auto-hide controls ---
  // Show controls immediately; if playing, start 3s timer to re-hide on inactivity.
  function showControls() {
    if (allControlsHidden) return;
    player.classList.remove('controls-hidden');
    clearTimeout(controlsTimeout);
    if (!video.paused) {
      controlsTimeout = setTimeout(() => {
        if (!video.paused && !annotationMode && !colorPickerActive) {
          player.classList.add('controls-hidden');
        }
      }, 3000);
    }
  }

  // Reset the auto-hide timer on mouse movement.
  player.addEventListener('mousemove', showControls);

  // --- Keyboard Shortcuts Manager ---
  const SHORTCUT_DEFAULTS = {
    'play-pause':      { key: ' ',          label: 'Play / Pause',              section: 'Playback' },
    'shuttle-back':    { key: 'j',          label: 'Shuttle Back (JKL)',         section: 'Playback' },
    'shuttle-stop':    { key: 'k',          label: 'Shuttle Stop (JKL)',         section: 'Playback' },
    'shuttle-fwd':     { key: 'l',          label: 'Shuttle Forward (JKL)',      section: 'Playback' },
    'skip-forward':    { key: 'ArrowRight', shift: true,  label: 'Skip Forward 10s',  section: 'Playback' },
    'skip-back':       { key: 'ArrowLeft',  shift: true,  label: 'Skip Back 10s',     section: 'Playback' },
    'frame-forward':   { key: 'ArrowRight', label: 'Frame Forward',              section: 'Playback' },
    'frame-back':      { key: 'ArrowLeft',  label: 'Frame Back',                 section: 'Playback' },
    'volume-up':       { key: 'ArrowUp',    label: 'Volume Up',                  section: 'Playback' },
    'volume-down':     { key: 'ArrowDown',  label: 'Volume Down',                section: 'Playback' },
    'mute':            { key: 'm',          label: 'Mute / Unmute',              section: 'Playback' },
    'speed-up':        { key: ']',          label: 'Increase Speed',             section: 'Playback' },
    'speed-down':      { key: '[',          label: 'Decrease Speed',             section: 'Playback' },
    'go-start':        { key: 'Home',       label: 'Go to Start',                section: 'Navigation' },
    'go-end':          { key: 'End',        label: 'Go to End',                  section: 'Navigation' },
    'fullscreen':      { key: 'f',          label: 'Toggle Fullscreen',          section: 'View' },
    'toggle-info':     { key: 'i',          label: 'Toggle Info Panel',          section: 'View' },
    'cycle-timeline':  { key: 't',          label: 'Cycle Timeline',             section: 'View' },
    'toggle-zoom':     { key: 'z',          label: 'Toggle Zoom',                section: 'View' },
    'hide-controls':   { key: 'h',          label: 'Hide Controls',              section: 'View' },
    'color-picker':    { key: 'c',          label: 'Color Picker',               section: 'View' },
    'new-comment':     { key: 'n',          label: 'New Comment',                section: 'Comments' },
    'toggle-comments': { key: ';',          label: 'Toggle Comments Panel',      section: 'Comments' },
    'toggle-playlist': { key: 'p',          label: 'Toggle Playlist Panel',      section: 'View' },
    'annotate':        { key: 'd',          label: 'Annotate',                   section: 'Comments' },
    'delete-comment':  { key: 'Delete',     label: 'Delete Comment',             section: 'Comments' },
    'export-comments': { key: 'e',          shift: true, label: 'Export Comments', section: 'Comments' },
    'screenshot-desk': { key: 's',          alt: true,   label: 'Screenshot to Desktop',   section: 'Screenshots' },
    'screenshot-clip': { key: 's',          label: 'Screenshot to Clipboard',    section: 'Screenshots' },
    'toggle-loop':     { key: 'o',          label: 'Toggle Loop',                section: 'Playback' },
    'open-recent':     { key: 'r',          label: 'Open Recent File',           section: 'File' },
  };

  const sm = (() => {
    let custom = {};
    try { const s = localStorage.getItem('vf_shortcuts'); if (s) custom = JSON.parse(s); } catch {}
    const persist = () => { try { localStorage.setItem('vf_shortcuts', JSON.stringify(custom)); } catch {} };
    const get = (id) => custom[id] || SHORTCUT_DEFAULTS[id];
    return {
      get,
      set(id, key, shift, alt, ctrl) {
        custom[id] = { ...SHORTCUT_DEFAULTS[id], key, shift: !!shift, alt: !!alt, ctrl: !!ctrl };
        persist();
      },
      reset(id) { delete custom[id]; persist(); },
      resetAll() { custom = {}; persist(); },
      isCustom(id) { return !!custom[id]; },
      matches(e, id) {
        const b = get(id);
        if (!b) return false;
        if (b.key.toLowerCase() !== e.key.toLowerCase()) return false;
        if (!!b.shift !== !!e.shiftKey) return false;
        if (!!b.alt !== !!e.altKey) return false;
        if (!!b.ctrl !== !!(e.ctrlKey || e.metaKey)) return false;
        return true;
      },
      label(id) {
        const b = get(id);
        if (!b) return '';
        const parts = [];
        if (b.ctrl) parts.push(platform === 'darwin' ? '⌘' : 'Ctrl');
        if (b.shift) parts.push('⇧');
        if (b.alt) parts.push(platform === 'darwin' ? '⌥' : 'Alt');
        const map = { ' ': 'Space', 'ArrowLeft': '←', 'ArrowRight': '→',
          'ArrowUp': '↑', 'ArrowDown': '↓', 'Home': 'Home', 'End': 'End',
          'Delete': 'Del', 'Backspace': 'Bksp', 'Escape': 'Esc' };
        parts.push(map[b.key] || b.key.toUpperCase());
        return parts.join('+');
      },
      sections() {
        const out = {};
        const order = ['Playback', 'Navigation', 'View', 'Comments', 'Screenshots', 'File'];
        order.forEach(s => { out[s] = []; });
        for (const id of Object.keys(SHORTCUT_DEFAULTS)) {
          const sec = SHORTCUT_DEFAULTS[id].section;
          if (out[sec]) out[sec].push(id);
        }
        return out;
      },
    };
  })();

  // --- Keyboard Shortcuts ---
  // Prevent space/enter from activating focused buttons — always route to player shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      e.target.blur();
    }
  }, true); // Use capture phase to intercept before button handles it

  document.addEventListener('keydown', (e) => {
    // Ignore when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Block all shortcuts while shortcuts editor is open (capture listener handles that context)
    if (document.getElementById('shortcuts-editor') &&
        !document.getElementById('shortcuts-editor').classList.contains('hidden')) return;

    // ? key opens shortcuts editor (always available)
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      openShortcutsEditor();
      return;
    }

    // R to open most recent file (works even with no video loaded)
    if (sm.matches(e, 'open-recent') && !e.metaKey && !e.ctrlKey && isElectron) {
      window.viewfinder.openRecentFile();
      return;
    }

    if (!video.src) return;

    // Annotation mode tool switching (1-5 keys)
    if (annotationMode && e.key >= '1' && e.key <= '5') {
      const tools = ['freehand', 'rect', 'circle', 'arrow', 'text'];
      annotationTool = tools[parseInt(e.key) - 1];
      const toolbar = $('#annotation-toolbar');
      if (toolbar) {
        toolbar.querySelectorAll('.ann-tool[data-tool]').forEach(b => b.classList.remove('active'));
        const active = toolbar.querySelector(`[data-tool="${annotationTool}"]`);
        if (active) active.classList.add('active');
      }
      return;
    }

    // Ctrl+Z: undo annotation stroke (always works in annotation mode, regardless of remapping)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && annotationMode) {
      e.preventDefault();
      currentAnnotations.pop();
      redrawAnnotations();
      return;
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !annotationMode) {
      if (commentUndoStack.length) {
        e.preventDefault();
        undoDeleteComment();
        return;
      }
    }

    // Escape: contextual dismiss (not remappable)
    if (e.key === 'Escape') {
      if (annotationMode) { exitAnnotationMode(false); return; }
      if (colorPickerActive) { toggleColorPicker(); return; }
      if (commentsPanelOpen) toggleCommentsPanel();
      if (playlistPanelOpen) togglePlaylistPanel();
      return;
    }

    // Block most shortcuts in annotation mode
    if (annotationMode && !sm.matches(e, 'annotate')) return;

    showControls();

    // --- ShortcutManager dispatch ---
    if (sm.matches(e, 'play-pause')) {
      e.preventDefault();
      togglePlay();
    } else if (sm.matches(e, 'skip-forward')) {
      e.preventDefault();
      video.currentTime = Math.min(video.duration, video.currentTime + 10);
      timecodeEl.textContent = formatTimecode(video.currentTime);
      updateFrameCount(video.currentTime);
      updatePlayhead();
    } else if (sm.matches(e, 'skip-back')) {
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 10);
      timecodeEl.textContent = formatTimecode(video.currentTime);
      updateFrameCount(video.currentTime);
      updatePlayhead();
    } else if (sm.matches(e, 'frame-forward')) {
      e.preventDefault();
      video.currentTime = Math.min(video.duration, video.currentTime + 1 / fps);
      timecodeEl.textContent = formatTimecode(video.currentTime);
      updateFrameCount(video.currentTime);
      updatePlayhead();
    } else if (sm.matches(e, 'frame-back')) {
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 1 / fps);
      timecodeEl.textContent = formatTimecode(video.currentTime);
      updateFrameCount(video.currentTime);
      updatePlayhead();
    } else if (sm.matches(e, 'volume-up')) {
      e.preventDefault();
      if (playlistPanelOpen && playlistItems.length > 0) {
        playlistPrev();
      } else {
        video.volume = Math.min(1, video.volume + 0.05);
        video.muted = false;
        volumeSlider.value = video.volume;
        updateVolumeUI();
      }
    } else if (sm.matches(e, 'volume-down')) {
      e.preventDefault();
      if (playlistPanelOpen && playlistItems.length > 0) {
        playlistNext();
      } else {
        video.volume = Math.max(0, video.volume - 0.05);
        volumeSlider.value = video.volume;
        updateVolumeUI();
      }
    } else if (sm.matches(e, 'shuttle-back')) {
      shuttleSpeed = Math.max(-2, shuttleSpeed - 1);
      applyShuttle();
    } else if (sm.matches(e, 'shuttle-stop')) {
      resetShuttle();
      video.pause();
    } else if (sm.matches(e, 'shuttle-fwd')) {
      shuttleSpeed = Math.min(2, shuttleSpeed + 1);
      applyShuttle();
    } else if (sm.matches(e, 'fullscreen')) {
      toggleFullscreen();
    } else if (sm.matches(e, 'mute')) {
      video.muted = !video.muted;
      updateVolumeUI();
    } else if (sm.matches(e, 'toggle-loop')) {
      toggleLoop();
    } else if (sm.matches(e, 'screenshot-desk')) {
      screenshotToDesktop();
    } else if (sm.matches(e, 'screenshot-clip')) {
      screenshotToClipboard();
    } else if (sm.matches(e, 'color-picker')) {
      toggleColorPicker();
    } else if (sm.matches(e, 'cycle-timeline')) {
      cycleTimelineMode();
    } else if (sm.matches(e, 'toggle-info')) {
      if (infoPanel) infoPanel.classList.toggle('hidden');
      if (infoBtn) infoBtn.classList.toggle('active');
    } else if (sm.matches(e, 'new-comment')) {
      if (!annotationMode) openCommentInput();
    } else if (sm.matches(e, 'annotate')) {
      if (annotationMode) { exitAnnotationMode(false); } else { enterAnnotationMode(); }
    } else if (sm.matches(e, 'toggle-comments')) {
      toggleCommentsPanel();
    } else if (sm.matches(e, 'toggle-playlist')) {
      togglePlaylistPanel();
    } else if (sm.matches(e, 'hide-controls')) {
      toggleHideAllControls();
    } else if (sm.matches(e, 'delete-comment')) {
      if (highlightedCommentId) { deleteComment(highlightedCommentId); highlightedCommentId = null; }
    } else if (sm.matches(e, 'toggle-zoom')) {
      if (zoomBtn) zoomBtn.click();
    } else if (sm.matches(e, 'export-comments')) {
      exportComments();
    } else if (sm.matches(e, 'go-start')) {
      video.currentTime = 0;
    } else if (sm.matches(e, 'go-end')) {
      video.currentTime = video.duration;
    } else if (sm.matches(e, 'speed-down')) {
      if (shuttleSpeed !== 0) return;
      const idx = speeds.indexOf(userSpeed);
      if (idx > 0) setUserSpeed(speeds[idx - 1]);
    } else if (sm.matches(e, 'speed-up')) {
      if (shuttleSpeed !== 0) return;
      const idx = speeds.indexOf(userSpeed);
      if (idx < speeds.length - 1) setUserSpeed(speeds[idx + 1]);
    }
  });

  // --- J/K/L Shuttle ---
  function applyShuttle() {
    clearInterval(shuttleInterval);
    if (shuttleSpeed === 0) {
      video.pause();
      return;
    }

    const rate = shuttleSpeed > 0
      ? [1, 2][shuttleSpeed - 1]
      : [-1, -2][-shuttleSpeed - 1];

    if (rate > 0) {
      video.playbackRate = rate;
      video.play();
    } else {
      // Reverse playback via interval
      video.pause();
      shuttleInterval = setInterval(() => {
        video.currentTime = Math.max(0, video.currentTime + rate / fps);
        if (video.currentTime <= 0) clearInterval(shuttleInterval);
      }, 1000 / fps);
    }
  }

  let userSpeed = 1; // Track user-chosen speed separately from shuttle

  // Central helper: sets speed, updates UI, persists to localStorage
  function setUserSpeed(s) {
    userSpeed = s;
    video.playbackRate = s;
    speedBtn.textContent = s + 'x';
    try { localStorage.setItem('vf_speed', s); } catch {}
  }

  // --- Restore persisted volume & speed ---
  try {
    const savedVol = parseFloat(localStorage.getItem('vf_volume'));
    if (!isNaN(savedVol) && savedVol >= 0 && savedVol <= 1) {
      video.volume = savedVol;
      volumeSlider.value = savedVol;
    }
    if (localStorage.getItem('vf_muted') === 'true') video.muted = true;
    updateVolumeUI();
    const savedSpeed = parseFloat(localStorage.getItem('vf_speed'));
    if (!isNaN(savedSpeed) && speeds.includes(savedSpeed)) {
      userSpeed = savedSpeed;
      speedBtn.textContent = savedSpeed + 'x';
      // video.playbackRate is applied on next play — setting it here too for consistency
      video.playbackRate = savedSpeed;
    }
  } catch {}

  function resetShuttle() {
    shuttleSpeed = 0;
    clearInterval(shuttleInterval);
    // Restore user's chosen speed, not force 1x
    video.playbackRate = userSpeed;
    speedBtn.textContent = userSpeed + 'x';
  }

  // --- Comments ---
  const commentInputOverlay = $('#comment-input-overlay');
  const commentInput = $('#comment-input');
  const commentInputTc = $('#comment-input-tc');
  const commentSaveBtn = $('#comment-save-btn');
  const commentCancelBtn = $('#comment-cancel-btn');
  const commentMarkers = $('#comment-markers');
  // Comment data model: {id, time, text, author, createdAt, annotations: [{type, color, lineWidth, points, text, fontSize}], thumbnailDataUrl}
  let comments = [];
  let commentUndoStack = []; // each entry: { deleted: commentObject, index: number }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function openCommentInput(editId) {
    // If panel is open and not editing an existing comment, focus the panel input bar instead
    if (commentsPanelOpen && !editId) {
      if (panelInputTc) panelInputTc.textContent = formatTimecode(video.currentTime);
      if (panelCommentInput) setTimeout(() => panelCommentInput.focus(), 50);
      return;
    }
    // If panel is closed and no editId, open the panel and focus the input
    if (!editId) {
      if (!commentsPanelOpen) toggleCommentsPanel();
      if (panelInputTc) panelInputTc.textContent = formatTimecode(video.currentTime);
      if (panelCommentInput) setTimeout(() => panelCommentInput.focus(), 50);
      return;
    }
    // Editing an existing comment: use floating modal
    const time = comments.find(c => c.id === editId)?.time;
    if (time == null) return;
    commentInputTc.textContent = formatTimecode(time);
    commentInput.value = comments.find(c => c.id === editId)?.text || '';
    commentInputOverlay.classList.remove('hidden');
    commentInput.dataset.time = time;
    commentInput.dataset.editId = editId;
    setTimeout(() => commentInput.focus(), 50);
  }

  function closeCommentInput() {
    commentInputOverlay.classList.add('hidden');
    commentInput.dataset.editId = '';
  }

  function saveComment() {
    const text = commentInput.value.trim();
    if (!text) { closeCommentInput(); return; }
    const time = parseFloat(commentInput.dataset.time);
    const editId = commentInput.dataset.editId;

    if (editId) {
      const existing = comments.find(c => c.id === editId);
      if (existing) {
        existing.text = text;
        existing.time = time;
      }
    } else {
      comments.push({
        id: generateId(),
        time,
        text,
        author: currentUser,
        createdAt: Date.now(),
        annotations: [],
        thumbnailDataUrl: null,
      });
    }
    comments.sort((a, b) => a.time - b.time);
    closeCommentInput();
    renderCommentMarkers();
    renderCommentsPanel();
    saveCommentsToFile();
  }

  function deleteComment(id) {
    const idx = comments.findIndex(c => c.id === id);
    if (idx === -1) return;
    commentUndoStack.push({ deleted: comments[idx], index: idx });
    if (commentUndoStack.length > 20) commentUndoStack.shift();
    comments = comments.filter(c => c.id !== id);
    renderCommentMarkers();
    renderCommentsPanel();
    saveCommentsToFile();
    showToast('Comment deleted  ·  Ctrl+Z to undo');
  }

  function undoDeleteComment() {
    if (!commentUndoStack.length) return;
    const { deleted, index } = commentUndoStack.pop();
    comments.splice(Math.min(index, comments.length), 0, deleted);
    comments.sort((a, b) => a.time - b.time);
    renderCommentMarkers();
    renderCommentsPanel();
    saveCommentsToFile();
    showToast('Comment restored');
  }

  function renderCommentMarkers() {
    commentMarkers.innerHTML = '';
    if (!video.duration) return;
    comments.forEach((c) => {
      const pct = (c.time / video.duration) * 100;
      const marker = document.createElement('div');
      marker.className = 'comment-marker';
      if (c.annotations && c.annotations.length > 0) marker.classList.add('has-annotation');
      marker.style.left = pct + '%';
      const tooltip = document.createElement('div');
      tooltip.className = 'comment-marker-tooltip';
      tooltip.textContent = formatTimecode(c.time) + ' — ' + c.text;
      marker.appendChild(tooltip);
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        video.currentTime = c.time;
        timecodeEl.textContent = formatTimecode(c.time);
        updateFrameCount(c.time);
        updatePlayhead();
        if (c.annotations && c.annotations.length > 0) {
          renderAnnotationsOnCanvas(c.annotations);
        }
        // Open comments panel if not open, highlight and scroll to this comment
        if (!commentsPanelOpen) {
          toggleCommentsPanel();
        }
        highlightCommentInPanel(c.id);
      });
      commentMarkers.appendChild(marker);
    });
  }

  // --- Playlist Panel ---
  const playlistPanel = $('#playlist-panel');
  const playlistList = $('#playlist-list');
  const playlistBtn = $('#playlist-btn');
  const playlistClose = $('#playlist-close');
  const playlistDropZone = $('#playlist-drop-zone');
  let playlistPanelOpen = false;
  let playlistItems = []; // [{name, path}]
  let playlistIndex = -1; // index of currently loaded item (-1 = not from playlist)

  function addToPlaylist(name, path, autoPlay) {
    if (!path) return;
    // Don't add duplicates
    const existing = playlistItems.findIndex(x => x.path === path);
    if (existing !== -1) {
      if (autoPlay) { playlistIndex = existing; renderPlaylist(); }
      return;
    }
    playlistItems.push({ name, path });
    if (autoPlay) playlistIndex = playlistItems.length - 1;
    renderPlaylist();
  }

  function renderPlaylist() {
    if (!playlistList) return;
    playlistList.innerHTML = '';
    playlistItems.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'playlist-item' + (i === playlistIndex ? ' active' : '');
      el.dataset.index = i;
      el.innerHTML = `
        <span class="playlist-item-index">${i + 1}</span>
        <span class="playlist-item-name" title="${item.name}">${item.name}</span>
        <button class="playlist-item-remove" data-index="${i}" title="Remove">&times;</button>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('playlist-item-remove')) {
          const idx = parseInt(e.target.dataset.index);
          playlistItems.splice(idx, 1);
          if (playlistIndex === idx) playlistIndex = -1;
          else if (playlistIndex > idx) playlistIndex--;
          renderPlaylist();
          return;
        }
        playlistIndex = i;
        loadFilePath(item.path);
        renderPlaylist();
      });
      playlistList.appendChild(el);
    });
    // Scroll active item into view
    const active = playlistList.querySelector('.playlist-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function playlistPrev() {
    if (playlistItems.length === 0) return;
    if (playlistIndex <= 0) playlistIndex = playlistItems.length - 1;
    else playlistIndex--;
    loadFilePath(playlistItems[playlistIndex].path);
    renderPlaylist();
  }

  function playlistNext() {
    if (playlistItems.length === 0) return;
    if (playlistIndex >= playlistItems.length - 1) playlistIndex = 0;
    else playlistIndex++;
    loadFilePath(playlistItems[playlistIndex].path);
    renderPlaylist();
  }

  function togglePlaylistPanel() {
    playlistPanelOpen = !playlistPanelOpen;
    if (playlistPanel) playlistPanel.classList.toggle('hidden', !playlistPanelOpen);
    if (playlistBtn) playlistBtn.classList.toggle('active', playlistPanelOpen);
    const panelWidth = playlistPanelOpen ? '240px' : '0';
    const vc = document.querySelector('.video-container');
    if (vc) vc.style.marginLeft = panelWidth;
    timelineContainer.style.marginLeft = panelWidth;
    const bar = document.querySelector('.control-bar');
    if (bar) bar.style.marginLeft = panelWidth;
    if (isElectron) window.viewfinder.clearAspectRatio();
    if (!playlistPanelOpen && isElectron && video.videoWidth && video.videoHeight) {
      const chromeH = (timelineContainer ? timelineContainer.offsetHeight : 0) +
                      (document.querySelector('.control-bar') ? document.querySelector('.control-bar').offsetHeight : 40);
      window.viewfinder.setAspectRatio(video.videoWidth / video.videoHeight, chromeH);
    }
  }

  if (playlistBtn) playlistBtn.addEventListener('click', togglePlaylistPanel);
  if (playlistClose) playlistClose.addEventListener('click', togglePlaylistPanel);

  // Drag-drop onto the playlist drop zone
  if (playlistDropZone) {
    playlistDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      playlistDropZone.classList.add('drag-over');
    });
    playlistDropZone.addEventListener('dragleave', () => {
      playlistDropZone.classList.remove('drag-over');
    });
    playlistDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      playlistDropZone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/') || /\.(mp4|mov|mkv|avi|webm|m4v|ogv|wmv|flv|mts|m2ts)$/i.test(f.name));
      if (files.length === 0) return;
      const wasEmpty = playlistItems.length === 0;
      files.forEach((f, i) => {
        const path = isElectron && f.path ? f.path : null;
        if (!path) return;
        addToPlaylist(f.name, path, wasEmpty && i === 0);
      });
      // Auto-load first dropped file if nothing was playing
      if (wasEmpty && playlistItems.length > 0 && playlistIndex === -1) {
        playlistIndex = 0;
        loadFilePath(playlistItems[0].path);
        renderPlaylist();
      }
    });
  }

  // --- Comments Panel ---
  const commentsPanel = $('#comments-panel');
  const commentsList = $('#comments-list');
  const commentsBtn = $('#comments-btn');
  const commentsClose = $('#comments-close');
  const panelInputTc = $('#panel-input-tc');
  const panelCommentInput = $('#panel-comment-input');
  const panelSendBtn = $('#panel-send-btn');
  const panelAnnotateBtn = $('#panel-annotate-btn');
  let commentsPanelOpen = false;
  let highlightedCommentId = null;

  function toggleCommentsPanel() {
    commentsPanelOpen = !commentsPanelOpen;
    commentsPanel.classList.toggle('hidden', !commentsPanelOpen);
    if (commentsBtn) commentsBtn.classList.toggle('active', commentsPanelOpen);
    if (commentsPanelOpen) {
      renderCommentsPanel();
      if (panelInputTc) panelInputTc.textContent = formatTimecode(video.currentTime);
    }
    // Shrink video + timeline/controls so nothing is covered
    const panelWidth = commentsPanelOpen ? '320px' : '0';
    const videoContainer = document.querySelector('.video-container');
    if (videoContainer) videoContainer.style.marginRight = panelWidth;
    timelineContainer.style.marginRight = panelWidth;
    const bar = document.querySelector('.control-bar');
    if (bar) bar.style.marginRight = panelWidth;
    if (isElectron) window.viewfinder.clearAspectRatio();
    if (!commentsPanelOpen && isElectron && video.videoWidth && video.videoHeight) {
      const chromeH = (timelineContainer ? timelineContainer.offsetHeight : 0) +
                      (document.querySelector('.control-bar') ? document.querySelector('.control-bar').offsetHeight : 40);
      window.viewfinder.setAspectRatio(video.videoWidth / video.videoHeight, chromeH);
    }
  }

  function renderCommentsPanel() {
    if (!commentsList) return;
    commentsList.innerHTML = '';
    if (comments.length === 0) {
      commentsList.innerHTML = '<div class="comments-empty">No comments yet.<br>Press <kbd>N</kbd> to add one.</div>';
      return;
    }
    comments.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'comment-item';
      item.dataset.id = c.id;

      const tc = document.createElement('div');
      tc.className = 'comment-item-tc';
      tc.textContent = formatTimecode(c.time);
      if (c.annotations && c.annotations.length > 0) {
        const badge = document.createElement('span');
        badge.className = 'annotation-badge';
        badge.textContent = ' \u270E'; // pencil
        tc.appendChild(badge);
      }
      item.appendChild(tc);

      if (c.text) {
        const text = document.createElement('div');
        text.className = 'comment-item-text';
        text.textContent = c.text;
        item.appendChild(text);
      }

      if (c.thumbnailDataUrl) {
        const img = document.createElement('img');
        img.className = 'comment-item-thumbnail';
        img.src = c.thumbnailDataUrl;
        item.appendChild(img);
      }

      const actions = document.createElement('div');
      actions.className = 'comment-item-actions';
      const editBtn = document.createElement('button');
      editBtn.title = 'Edit comment';
      editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); openCommentInput(c.id); });
      const drawBtn = document.createElement('button');
      drawBtn.title = 'Draw annotation';
      drawBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>';
      drawBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        video.currentTime = c.time;
        enterAnnotationMode(c.id);
      });
      const delBtn = document.createElement('button');
      delBtn.title = 'Delete comment';
      delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteComment(c.id); });
      actions.appendChild(editBtn);
      actions.appendChild(drawBtn);
      actions.appendChild(delBtn);
      item.appendChild(actions);

      item.addEventListener('click', () => {
        video.currentTime = c.time;
        timecodeEl.textContent = formatTimecode(c.time);
        updateFrameCount(c.time);
        updatePlayhead();
        if (c.annotations && c.annotations.length > 0) {
          renderAnnotationsOnCanvas(c.annotations);
        }
        highlightCommentInPanel(c.id);
      });
      item.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openCommentInput(c.id);
      });
      commentsList.appendChild(item);
    });
  }

  function highlightCommentInPanel(id) {
    highlightedCommentId = id;
    const items = commentsList.querySelectorAll('.comment-item');
    items.forEach(item => item.classList.remove('comment-highlighted'));
    const target = commentsList.querySelector(`.comment-item[data-id="${id}"]`);
    if (target) {
      target.classList.add('comment-highlighted');
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  if (commentsBtn) commentsBtn.addEventListener('click', toggleCommentsPanel);
  if (commentsClose) commentsClose.addEventListener('click', toggleCommentsPanel);

  // --- Panel input bar ---
  function savePanelComment() {
    const text = panelCommentInput ? panelCommentInput.value.trim() : '';
    if (!text) return;
    const time = video.currentTime;
    comments.push({
      id: generateId(),
      time,
      text,
      author: currentUser,
      createdAt: Date.now(),
      annotations: [],
      thumbnailDataUrl: null,
    });
    comments.sort((a, b) => a.time - b.time);
    if (panelCommentInput) panelCommentInput.value = '';
    renderCommentMarkers();
    renderCommentsPanel();
    saveCommentsToFile();
  }

  if (panelSendBtn) panelSendBtn.addEventListener('click', savePanelComment);

  if (panelAnnotateBtn) panelAnnotateBtn.addEventListener('click', () => {
    if (annotationMode) exitAnnotationMode(false);
    else enterAnnotationMode();
  });

  if (panelCommentInput) {
    panelCommentInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') savePanelComment();
      if (e.key === 'Escape') { panelCommentInput.value = ''; panelCommentInput.blur(); }
    });
    // Keep panel timecode live while focused
    panelCommentInput.addEventListener('focus', () => {
      if (panelInputTc) panelInputTc.textContent = formatTimecode(video.currentTime);
    });
  }

  const annotateBtn = $('#annotate-btn');
  if (annotateBtn) annotateBtn.addEventListener('click', () => {
    if (annotationMode) exitAnnotationMode(false);
    else enterAnnotationMode();
  });

  // --- Annotation Canvas ---
  const annotationCanvas = $('#annotation-canvas');
  const annCtx = annotationCanvas ? annotationCanvas.getContext('2d') : null;
  const annTextOverlay = $('#ann-text-overlay');
  const annTextInput = $('#ann-text-input');
  let annotationMode = false;
  let showSketchesDuringPlayback = false;
  let annotationTool = 'freehand';
  let annotationColor = '#FF3B30';
  let annotationLineWidth = 4;
  let currentAnnotations = [];
  let isDrawing = false;
  let drawStartPoint = null;
  let currentPath = [];
  let annotatingCommentId = null;

  function resizeAnnotationCanvas() {
    if (!annotationCanvas) return;
    const rect = video.getBoundingClientRect();
    const containerRect = videoContainer.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    annotationCanvas.style.left = (rect.left - containerRect.left) + 'px';
    annotationCanvas.style.top = (rect.top - containerRect.top) + 'px';
    annotationCanvas.style.width = rect.width + 'px';
    annotationCanvas.style.height = rect.height + 'px';
    annotationCanvas.width = rect.width * dpr;
    annotationCanvas.height = rect.height * dpr;
    annCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function canvasToNorm(x, y) {
    const rect = annotationCanvas.getBoundingClientRect();
    return { x: x / rect.width, y: y / rect.height };
  }

  function normToCanvas(nx, ny) {
    const rect = annotationCanvas.getBoundingClientRect();
    return { x: nx * rect.width, y: ny * rect.height };
  }

  function enterAnnotationMode(commentId) {
    if (!annotationCanvas) return;
    annotationMode = true;
    annotatingCommentId = commentId || null;
    const wasPlaying = !video.paused;
    if (wasPlaying) video.pause();

    // Load existing annotations if editing
    if (commentId) {
      const c = comments.find(c => c.id === commentId);
      currentAnnotations = c && c.annotations ? JSON.parse(JSON.stringify(c.annotations)) : [];
    } else {
      currentAnnotations = [];
    }

    annotationCanvas.classList.remove('hidden');
    annotationCanvas.style.pointerEvents = 'auto';
    const toolbar = $('#annotation-toolbar');
    if (toolbar) toolbar.classList.remove('hidden');
    if ($('#annotate-btn')) $('#annotate-btn').classList.add('active');

    resizeAnnotationCanvas();
    redrawAnnotations();
  }

  function exitAnnotationMode(save) {
    if (!annotationCanvas) return;
    annotationMode = false;

    if (save && currentAnnotations.length > 0) {
      if (annotatingCommentId) {
        const c = comments.find(c => c.id === annotatingCommentId);
        if (c) {
          c.annotations = currentAnnotations;
          c.thumbnailDataUrl = generateThumbnail(c);
        }
      } else {
        // Create a new comment with just annotations
        const newComment = {
          id: generateId(),
          time: video.currentTime,
          text: '',
          author: currentUser,
          createdAt: Date.now(),
          annotations: currentAnnotations,
          thumbnailDataUrl: null,
        };
        newComment.thumbnailDataUrl = generateThumbnail(newComment);
        comments.push(newComment);
        comments.sort((a, b) => a.time - b.time);
      }
      renderCommentMarkers();
      renderCommentsPanel();
      saveCommentsToFile();
    }

    annotationCanvas.classList.add('hidden');
    const toolbar = $('#annotation-toolbar');
    if (toolbar) toolbar.classList.add('hidden');
    if ($('#annotate-btn')) $('#annotate-btn').classList.remove('active');
    currentAnnotations = [];
    annotatingCommentId = null;
    annCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  }

  function generateThumbnail(comment) {
    try {
      const thumbW = 240;
      const thumbH = Math.round(thumbW * (video.videoHeight / video.videoWidth));
      const c = document.createElement('canvas');
      c.width = thumbW;
      c.height = thumbH;
      const ctx = c.getContext('2d');
      ctx.drawImage(video, 0, 0, thumbW, thumbH);
      // Draw annotations scaled
      renderAnnotationsToCtx(ctx, comment.annotations, thumbW, thumbH);
      return c.toDataURL('image/jpeg', 0.7);
    } catch { return null; }
  }

  function redrawAnnotations() {
    if (!annCtx) return;
    const rect = annotationCanvas.getBoundingClientRect();
    annCtx.clearRect(0, 0, rect.width, rect.height);
    renderAnnotationsToCtx(annCtx, currentAnnotations, rect.width, rect.height);
  }

  function renderAnnotationsToCtx(ctx, annotations, w, h) {
    if (!annotations) return;
    annotations.forEach(shape => {
      ctx.strokeStyle = shape.color || '#FF3B30';
      ctx.fillStyle = shape.color || '#FF3B30';
      ctx.lineWidth = shape.lineWidth || 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      switch (shape.type) {
        case 'freehand': {
          if (!shape.points || shape.points.length < 2) break;
          ctx.beginPath();
          ctx.moveTo(shape.points[0].x * w, shape.points[0].y * h);
          for (let i = 1; i < shape.points.length; i++) {
            ctx.lineTo(shape.points[i].x * w, shape.points[i].y * h);
          }
          ctx.stroke();
          break;
        }
        case 'rect': {
          if (!shape.points || shape.points.length < 2) break;
          const x1 = shape.points[0].x * w, y1 = shape.points[0].y * h;
          const x2 = shape.points[1].x * w, y2 = shape.points[1].y * h;
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          break;
        }
        case 'circle': {
          if (!shape.points || shape.points.length < 2) break;
          const cx = (shape.points[0].x + shape.points[1].x) / 2 * w;
          const cy = (shape.points[0].y + shape.points[1].y) / 2 * h;
          const rx = Math.abs(shape.points[1].x - shape.points[0].x) / 2 * w;
          const ry = Math.abs(shape.points[1].y - shape.points[0].y) / 2 * h;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'arrow': {
          if (!shape.points || shape.points.length < 2) break;
          const ax1 = shape.points[0].x * w, ay1 = shape.points[0].y * h;
          const ax2 = shape.points[1].x * w, ay2 = shape.points[1].y * h;
          ctx.beginPath();
          ctx.moveTo(ax1, ay1);
          ctx.lineTo(ax2, ay2);
          ctx.stroke();
          // Filled solid triangle arrowhead
          const angle = Math.atan2(ay2 - ay1, ax2 - ax1);
          const lw = shape.lineWidth || 2;
          const headLen = Math.max(14, lw * 4);
          const headAngle = 0.42;
          ctx.beginPath();
          ctx.moveTo(ax2, ay2);
          ctx.lineTo(ax2 - headLen * Math.cos(angle - headAngle), ay2 - headLen * Math.sin(angle - headAngle));
          ctx.lineTo(ax2 - headLen * Math.cos(angle + headAngle), ay2 - headLen * Math.sin(angle + headAngle));
          ctx.closePath();
          ctx.fillStyle = shape.color;
          ctx.fill();
          break;
        }
        case 'text': {
          if (!shape.points || shape.points.length < 1) break;
          const fontSize = (shape.fontSize || 0.03) * h;
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.fillText(shape.text || '', shape.points[0].x * w, shape.points[0].y * h);
          break;
        }
      }
    });
  }

  function renderAnnotationsOnCanvas(annotations) {
    if (!annotationCanvas || !annCtx) return;
    annotationCanvas.classList.remove('hidden');
    // When just previewing (not in annotation mode), disable pointer events so clicks pass through
    if (!annotationMode) {
      annotationCanvas.style.pointerEvents = 'none';
    }
    resizeAnnotationCanvas();
    const rect = annotationCanvas.getBoundingClientRect();
    annCtx.clearRect(0, 0, rect.width, rect.height);
    renderAnnotationsToCtx(annCtx, annotations, rect.width, rect.height);
    // Auto-hide after 5s if not in annotation mode
    if (!annotationMode) {
      clearTimeout(annotationCanvas._hideTimer);
      annotationCanvas._hideTimer = setTimeout(() => {
        if (!annotationMode) annotationCanvas.classList.add('hidden');
      }, 5000);
    }
  }

  function showAnnTextInput(x, y, norm) {
    if (!annTextOverlay || !annTextInput) return;
    annTextOverlay.style.left = x + 'px';
    annTextOverlay.style.top  = y + 'px';
    annTextInput.value = '';
    annTextInput.style.color = annotationColor;
    annTextOverlay.classList.remove('hidden');
    annTextInput.focus();

    const commit = () => {
      const text = annTextInput.value.trim();
      // Remove listeners BEFORE hiding — hiding a focused element fires blur
      // synchronously in Chromium, which would re-enter commit() before the
      // removeEventListener calls below could run, producing a duplicate annotation.
      annTextInput.removeEventListener('keydown', onKey);
      annTextInput.removeEventListener('blur', onBlur);
      annTextOverlay.classList.add('hidden');
      if (text) {
        currentAnnotations.push({
          type: 'text', color: annotationColor, lineWidth: annotationLineWidth,
          points: [norm], text, fontSize: 0.03
        });
        redrawAnnotations();
      }
    };

    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { annTextInput.value = ''; commit(); }
      e.stopPropagation(); // prevent shortcut keys firing
    };
    const onBlur = () => commit();

    annTextInput.addEventListener('keydown', onKey);
    annTextInput.addEventListener('blur', onBlur);
  }

  // --- Drawing Mouse Handlers ---
  if (annotationCanvas) {
    annotationCanvas.addEventListener('mousedown', (e) => {
      if (!annotationMode) return;
      e.preventDefault();
      const rect = annotationCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const norm = canvasToNorm(x, y);

      if (annotationTool === 'text') {
        showAnnTextInput(e.clientX - annotationCanvas.getBoundingClientRect().left,
                         e.clientY - annotationCanvas.getBoundingClientRect().top, norm);
        return;
      }

      isDrawing = true;
      drawStartPoint = norm;
      if (annotationTool === 'freehand') {
        currentPath = [norm];
      }
    });

    annotationCanvas.addEventListener('mousemove', (e) => {
      if (!annotationMode || !isDrawing) return;
      const rect = annotationCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const norm = canvasToNorm(x, y);

      if (annotationTool === 'freehand') {
        currentPath.push(norm);
      }

      // Redraw all + preview
      redrawAnnotations();
      const w = rect.width, h = rect.height;
      annCtx.strokeStyle = annotationColor;
      annCtx.lineWidth = annotationLineWidth;
      annCtx.lineCap = 'round';
      annCtx.lineJoin = 'round';

      if (annotationTool === 'freehand' && currentPath.length > 1) {
        annCtx.beginPath();
        annCtx.moveTo(currentPath[0].x * w, currentPath[0].y * h);
        for (let i = 1; i < currentPath.length; i++) {
          annCtx.lineTo(currentPath[i].x * w, currentPath[i].y * h);
        }
        annCtx.stroke();
      } else if (annotationTool === 'rect') {
        annCtx.strokeRect(drawStartPoint.x * w, drawStartPoint.y * h,
          (norm.x - drawStartPoint.x) * w, (norm.y - drawStartPoint.y) * h);
      } else if (annotationTool === 'circle') {
        const cx = (drawStartPoint.x + norm.x) / 2 * w;
        const cy = (drawStartPoint.y + norm.y) / 2 * h;
        const rx = Math.abs(norm.x - drawStartPoint.x) / 2 * w;
        const ry = Math.abs(norm.y - drawStartPoint.y) / 2 * h;
        annCtx.beginPath();
        annCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        annCtx.stroke();
      } else if (annotationTool === 'arrow') {
        const ax1 = drawStartPoint.x * w, ay1 = drawStartPoint.y * h;
        const ax2 = norm.x * w, ay2 = norm.y * h;
        annCtx.beginPath();
        annCtx.moveTo(ax1, ay1);
        annCtx.lineTo(ax2, ay2);
        annCtx.stroke();
        // Filled solid triangle arrowhead
        const angle = Math.atan2(ay2 - ay1, ax2 - ax1);
        const lw = annotationLineWidth;
        const headLen = Math.max(14, lw * 4);
        const headAngle = 0.42;
        annCtx.beginPath();
        annCtx.moveTo(ax2, ay2);
        annCtx.lineTo(ax2 - headLen * Math.cos(angle - headAngle), ay2 - headLen * Math.sin(angle - headAngle));
        annCtx.lineTo(ax2 - headLen * Math.cos(angle + headAngle), ay2 - headLen * Math.sin(angle + headAngle));
        annCtx.closePath();
        annCtx.fillStyle = annotationColor;
        annCtx.fill();
      }
    });

    annotationCanvas.addEventListener('mouseup', (e) => {
      if (!annotationMode || !isDrawing) return;
      isDrawing = false;
      const rect = annotationCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const norm = canvasToNorm(x, y);

      if (annotationTool === 'freehand' && currentPath.length > 1) {
        // Simplify path to reduce data
        const simplified = currentPath.length > 50 ?
          currentPath.filter((_, i) => i % Math.ceil(currentPath.length / 50) === 0 || i === currentPath.length - 1) :
          currentPath;
        currentAnnotations.push({
          type: 'freehand', color: annotationColor, lineWidth: annotationLineWidth,
          points: simplified
        });
      } else if (annotationTool === 'rect' || annotationTool === 'circle' || annotationTool === 'arrow') {
        currentAnnotations.push({
          type: annotationTool, color: annotationColor, lineWidth: annotationLineWidth,
          points: [drawStartPoint, norm]
        });
      }

      currentPath = [];
      drawStartPoint = null;
      redrawAnnotations();
    });
  }

  // --- Annotation Toolbar ---
  const annotationToolbar = $('#annotation-toolbar');
  if (annotationToolbar) {
    annotationToolbar.querySelectorAll('.ann-tool[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        annotationTool = btn.dataset.tool;
        annotationToolbar.querySelectorAll('.ann-tool[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
    const annColorInput = $('#ann-color');
    if (annColorInput) annColorInput.addEventListener('input', (e) => { annotationColor = e.target.value; });
    const annLineWidthSel = $('#ann-line-width');
    if (annLineWidthSel) annLineWidthSel.addEventListener('change', (e) => { annotationLineWidth = parseInt(e.target.value); });
    const annUndoBtn = $('#ann-undo');
    if (annUndoBtn) annUndoBtn.addEventListener('click', () => {
      currentAnnotations.pop();
      redrawAnnotations();
    });
    const annClearBtn = $('#ann-clear');
    if (annClearBtn) annClearBtn.addEventListener('click', () => {
      currentAnnotations = [];
      redrawAnnotations();
    });
    const annSaveBtn = $('#ann-save');
    if (annSaveBtn) annSaveBtn.addEventListener('click', () => exitAnnotationMode(true));
    const annCancelBtn = $('#ann-cancel');
    if (annCancelBtn) annCancelBtn.addEventListener('click', () => exitAnnotationMode(false));
  }

  // --- Comment Persistence ---
  let saveDebounceTimer = null;

  function getSidecarPath() {
    if (!currentFile || !currentFile.path) return null;
    return currentFile.path.replace(/\.[^.]+$/, '.comments.json');
  }

  function getLegacySidecarPath() {
    if (!currentFile || !currentFile.path) return null;
    return currentFile.path.replace(/\.[^.]+$/, '.viewfinder.json');
  }

  function saveCommentsToFile() {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
      const sidecarPath = getSidecarPath();
      if (isElectron && sidecarPath) {
        const data = JSON.stringify({
          version: 1,
          videoFile: currentFile.name,
          fps,
          comments: comments.map(c => ({
            id: c.id, time: c.time, text: c.text, author: c.author,
            createdAt: c.createdAt, annotations: c.annotations,
            thumbnailDataUrl: c.thumbnailDataUrl
          }))
        }, null, 2);
        window.viewfinder.writeFileDirect(sidecarPath, data);
      } else if (!isElectron && currentFile) {
        localStorage.setItem('vf_comments_' + currentFile.name, JSON.stringify(comments));
      }
    }, 500);
  }

  function loadCommentsFromFile() {
    comments = [];
    const sidecarPath = getSidecarPath();
    if (isElectron && sidecarPath) {
      window.viewfinder.readFileDirect(sidecarPath).then(result => {
        if (result && result.success) {
          try {
            const data = JSON.parse(result.data);
            // Support Mac format (raw array) and PC format ({version, comments, fps, ...})
            const loaded = Array.isArray(data) ? data : (data.comments || null);
            if (loaded) {
              comments = loaded;
              // Restore cached fps from PC-format sidecar
              if (!Array.isArray(data) && data.fps > 0) fps = data.fps;
              renderCommentMarkers();
              renderCommentsPanel();
              // Migrate Mac format to PC format on first load
              if (Array.isArray(data)) saveCommentsToFile();
            }
          } catch (e) { console.error('Failed to load comments:', e); }
        } else {
          // Fall back to legacy .viewfinder.json format
          const legacyPath = getLegacySidecarPath();
          if (legacyPath) {
            window.viewfinder.readFileDirect(legacyPath).then(legacyResult => {
              if (legacyResult && legacyResult.success) {
                try {
                  const data = JSON.parse(legacyResult.data);
                  if (data.comments) {
                    comments = data.comments;
                    renderCommentMarkers();
                    renderCommentsPanel();
                    // Migrate to new format
                    saveCommentsToFile();
                  }
                } catch (e) { console.error('Failed to load legacy comments:', e); }
              }
            });
          }
        }
      });
    } else if (!isElectron && currentFile) {
      try {
        const stored = localStorage.getItem('vf_comments_' + currentFile.name);
        if (stored) {
          comments = JSON.parse(stored);
          renderCommentMarkers();
          renderCommentsPanel();
        }
      } catch (e) {}
    }
  }

  function exportComments() {
    if (comments.length === 0) return;
    const filename = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'video';
    let text = 'Comments for: ' + (currentFile ? currentFile.name : 'Untitled') + '\n';
    text += '='.repeat(40) + '\n\n';
    comments.forEach(c => {
      text += formatTimecode(c.time) + '  ' + c.text;
      if (c.annotations && c.annotations.length > 0) text += ' [has annotations]';
      text += '\n';
    });
    if (isElectron && window.viewfinder.saveFile) {
      window.viewfinder.saveFile(filename + '_comments.txt', text);
    } else {
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename + '_comments.txt';
      a.click();
    }
  }

  commentSaveBtn.addEventListener('click', saveComment);
  commentCancelBtn.addEventListener('click', closeCommentInput);
  commentInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') saveComment();
    if (e.key === 'Escape') closeCommentInput();
  });

  // --- Resize handler ---
  let resizeTimer = null;
  let lastBarcodeWidth = 0;
  window.addEventListener('resize', () => {
    updatePlayhead();
    renderCommentMarkers();
    // Only regenerate barcode after resize ends and width changed significantly
    const newWidth = timelineContainer.offsetWidth;
    if (video.duration && video.duration !== Infinity && Math.abs(newWidth - lastBarcodeWidth) > 50) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        barcodeGenerated = false;
        generateBarcode();
        lastBarcodeWidth = newWidth;
      }, 500);
    }
  });

  // --- Ended ---
  video.addEventListener('ended', () => {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
    player.classList.remove('controls-hidden');
  });

  // --- Keyboard Shortcuts Editor ---
  const shortcutsEditor = $('#shortcuts-editor');
  const shortcutsBody = $('#shortcuts-body');
  const shortcutsClose = $('#shortcuts-close');
  const shortcutsResetAll = $('#shortcuts-reset-all');
  let capturingId = null;

  function openShortcutsEditor() {
    renderShortcutsEditor();
    if (shortcutsEditor) shortcutsEditor.classList.remove('hidden');
  }

  function closeShortcutsEditor() {
    capturingId = null;
    if (shortcutsEditor) shortcutsEditor.classList.add('hidden');
  }

  function renderShortcutsEditor() {
    if (!shortcutsBody) return;
    shortcutsBody.innerHTML = '';
    const sections = sm.sections();
    for (const [sectionName, ids] of Object.entries(sections)) {
      if (!ids.length) continue;
      const titleEl = document.createElement('div');
      titleEl.className = 'shortcuts-section-title';
      titleEl.textContent = sectionName;
      shortcutsBody.appendChild(titleEl);

      for (const id of ids) {
        const def = SHORTCUT_DEFAULTS[id];
        const row = document.createElement('div');
        row.className = 'shortcut-row';
        row.dataset.id = id;

        const labelEl = document.createElement('div');
        labelEl.className = 'shortcut-label';
        labelEl.textContent = def.label;

        const keyEl = document.createElement('div');
        keyEl.className = 'shortcut-key' + (capturingId === id ? ' capturing' : '');
        keyEl.textContent = capturingId === id ? 'Press key…' : sm.label(id);
        keyEl.title = 'Click to remap';
        keyEl.addEventListener('click', () => startCapture(id));

        const resetEl = document.createElement('button');
        resetEl.className = 'shortcut-reset' + (sm.isCustom(id) ? '' : ' invisible');
        resetEl.textContent = '↺';
        resetEl.title = 'Reset to default';
        resetEl.addEventListener('click', (e) => {
          e.stopPropagation();
          sm.reset(id);
          if (capturingId === id) capturingId = null;
          renderShortcutsEditor();
        });

        row.appendChild(labelEl);
        row.appendChild(keyEl);
        row.appendChild(resetEl);
        shortcutsBody.appendChild(row);
      }
    }
  }

  function startCapture(id) {
    capturingId = id;
    renderShortcutsEditor();
  }

  // Capture keydown for remapping
  document.addEventListener('keydown', (e) => {
    const editorOpen = shortcutsEditor && !shortcutsEditor.classList.contains('hidden');
    if (!capturingId && !editorOpen) return;
    // Escape: cancel capture if active, otherwise close editor
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (capturingId) { capturingId = null; renderShortcutsEditor(); }
      else { closeShortcutsEditor(); }
      return;
    }
    if (!capturingId) return; // editor open but not capturing — let clicks handle it
    if (e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    // Don't allow bare modifier keys
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    sm.set(capturingId, e.key, e.shiftKey, e.altKey, e.ctrlKey || e.metaKey);
    capturingId = null;
    renderShortcutsEditor();
  }, true);

  if (shortcutsClose) shortcutsClose.addEventListener('click', closeShortcutsEditor);
  if (shortcutsResetAll) shortcutsResetAll.addEventListener('click', () => {
    sm.resetAll();
    capturingId = null;
    renderShortcutsEditor();
  });
  // Close on backdrop click
  if (shortcutsEditor) shortcutsEditor.addEventListener('click', (e) => {
    if (e.target === shortcutsEditor) closeShortcutsEditor();
  });

  // --- Electron Menu Commands ---
  if (isElectron) {
    const vf = window.viewfinder;
    vf.onMenuCommand('toggle-play', togglePlay);
    vf.onMenuCommand('frame-forward', () => {
      video.currentTime = Math.min(video.duration, video.currentTime + 1 / fps);
    });
    vf.onMenuCommand('frame-back', () => {
      video.currentTime = Math.max(0, video.currentTime - 1 / fps);
    });
    vf.onMenuCommand('skip-forward', () => {
      video.currentTime = Math.min(video.duration, video.currentTime + 10);
    });
    vf.onMenuCommand('skip-back', () => {
      video.currentTime = Math.max(0, video.currentTime - 10);
    });
    vf.onMenuCommand('speed-up', () => {
      const idx = speeds.indexOf(userSpeed);
      if (idx < speeds.length - 1) setUserSpeed(speeds[idx + 1]);
    });
    vf.onMenuCommand('speed-down', () => {
      const idx = speeds.indexOf(userSpeed);
      if (idx > 0) setUserSpeed(speeds[idx - 1]);
    });
    vf.onMenuCommand('toggle-thumbnails', () => {
      cycleTimelineMode();
    });
    vf.onMenuCommand('toggle-info', () => {
      infoPanel.classList.toggle('hidden');
      if (infoBtn) infoBtn.classList.toggle('active');
    });
    vf.onMenuCommand('aspect-fit', () => {
      cropMode = 'fit';
      video.style.objectFit = 'contain';
    });
    vf.onMenuCommand('aspect-fill', () => {
      cropMode = 'fill';
      video.style.objectFit = 'cover';
    });
    vf.onMenuCommand('set-display-aspect', (value) => {
      setDisplayAspect(value);
    });
    vf.onMenuCommand('video-size', (scale) => {
      if (!video.videoWidth || !video.videoHeight) return;
      // Resize window to fit video at the given scale, plus UI chrome
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      // Account for timeline + control bar height
      const chromeH = timelineContainer.offsetHeight + ($('.control-bar') ? $('.control-bar').offsetHeight : 40);
      video.style.objectFit = 'contain';
      video.style.aspectRatio = '';
      cropMode = 'fit';
      // Use IPC to resize the window from main process
      window.viewfinder.resizeWindow(w, h + chromeH);
    });
    vf.onMenuCommand('video-scale', (factor) => {
      if (!video.videoWidth || !video.videoHeight) return;
      // Get current content size and scale relative to it
      const chromeH = timelineContainer.offsetHeight + ($('.control-bar') ? $('.control-bar').offsetHeight : 40);
      const currentW = window.innerWidth;
      const currentVideoH = window.innerHeight - chromeH;
      const newW = Math.round(currentW * factor);
      const newH = Math.round(currentVideoH * factor) + chromeH;
      window.viewfinder.resizeWindow(newW, newH);
    });
    vf.onMenuCommand('toggle-controls', () => {
      toggleHideAllControls();
    });
    vf.onMenuCommand('toggle-sketches-playback', (enabled) => {
      showSketchesDuringPlayback = enabled;
    });
    vf.onMenuCommand('toggle-minimal-controls', (enabled) => {
      const bar = document.querySelector('.control-bar');
      if (bar) bar.classList.toggle('minimal-controls', enabled);
      timelineContainer.classList.toggle('minimal-controls', enabled);
    });
    vf.onMenuCommand('open-shortcuts-editor', () => openShortcutsEditor());
    vf.onMenuCommand('undo-comment-delete', () => undoDeleteComment());
    vf.onMenuCommand('always-on-top', (enabled) => {
      showToast('Always on Top: ' + (enabled ? 'On' : 'Off'));
    });
  }

})();
