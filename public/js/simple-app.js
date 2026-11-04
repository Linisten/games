/**
 * ArcadeNexus - Simple Beginner-Friendly Controller
 */

let socket = null;
let currentRoomCode = null;

window.addEventListener('DOMContentLoaded', async () => {
  initSocket();
  scanHostGames(); // Scan immediately on DOM ready
  await checkNetworkInfo();
  checkUrlParams();
});

function initSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('[Socket] Connected');
  });

  // When friend connects to host stream
  socket.on('stream:guest_connected', ({ guestSocketId, guestName, isPlayer2, role, players }) => {
    const indicator = document.getElementById('host-status-indicator');
    const label = document.getElementById('host-status-text');
    const spectatorsCount = players ? players.filter(p => !p.isHost && p.role === 'spectator').length : 0;

    if (isPlayer2) {
      if (indicator) {
        indicator.className = 'status-pill online';
        label.innerText = spectatorsCount > 0 
          ? `🟢 2/2 Players (${guestName}) + ${spectatorsCount} Spectator(s)`
          : `🟢 2/2 Players Joined (${guestName} Connected)`;
      }

      const p2Badge = document.getElementById('p2-badge');
      const p2Name = document.getElementById('p2-name-display');
      const p2Ctrl = document.getElementById('p2-controller-display');
      if (p2Badge) {
        p2Badge.style.borderColor = '#10b981';
        p2Badge.style.color = '#34d399';
        p2Badge.style.background = 'rgba(16, 185, 129, 0.15)';
      }
      if (p2Name) {
        p2Name.innerText = `${guestName} (Playing - Controller 2)`;
        p2Name.style.color = '#f8fafc';
      }
      if (p2Ctrl) {
        p2Ctrl.innerHTML = `<span class="dot" style="background:#34d399;"></span> Controller 2 (Virtual Xbox 360) Ready!`;
        p2Ctrl.style.color = '#34d399';
      }

      showToast(`${guestName} joined as Player 2 with Controller!`, '🎉');
      if (window.CouchPlay) {
        window.CouchPlay.setupHostPeer(guestSocketId, true);
      }
    } else {
      // Spectator joined (Rest players can only watch!)
      if (label) {
        label.innerText = `🟢 2/2 Players + ${spectatorsCount} Watching`;
      }
      showToast(`${guestName} joined as Spectator (Watch only).`, '👀');
      if (window.CouchPlay) {
        window.CouchPlay.setupHostPeer(guestSocketId, false);
      }
    }
  });

  // When guest controller / input device updates
  socket.on('stream:guest_device_update', ({ deviceName, isGamepad, isPlayer2 }) => {
    if (!isPlayer2) return;
    const p2Ctrl = document.getElementById('p2-controller-display');
    if (p2Ctrl) {
      const cleanName = deviceName ? deviceName.substring(0, 24) : (isGamepad ? 'Gamepad' : 'Keyboard');
      p2Ctrl.innerHTML = `<span class="dot" style="background:#34d399;"></span> Controller 2: ${isGamepad ? '🎮 ' + cleanName : '⌨️ ' + cleanName}`;
      p2Ctrl.style.color = '#34d399';
    }
  });

  socket.on('stream:signal', ({ signal, from }) => {
    if (window.CouchPlay) {
      window.CouchPlay.handleSignal(signal, from);
    }
  });

  // Player promoted to Player 2
  socket.on('stream:role_changed', ({ role }) => {
    if (role === 'player2') {
      showToast('You are now Player 2! Controller is active.', '🎮');
      const label = document.getElementById('guest-joystick-hud');
      if (label) {
        label.innerText = '🎮 Player 2 Controller Active';
        label.style.color = '#34d399';
      }
      checkGuestJoystick();
    }
  });

  // When stream is stopped by host
  socket.on('stream:stopped', () => {
    console.log('[Stream] Stream was stopped');
    if (!isHostUser) {
      showToast('Host stopped the stream.', '🛑');
      const waitingScreen = document.getElementById('guest-waiting-host');
      const guestVideo = document.getElementById('guest-remote-video');
      if (waitingScreen) waitingScreen.style.display = 'flex';
      if (guestVideo) guestVideo.srcObject = null;
    } else {
      resetHostStreamingUI();
    }
  });
}

// Screen navigation: 'home', 'host', 'guest', 'extras'
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`screen-${screenId}`);
  if (target) {
    target.classList.add('active');
  }

  if (screenId === 'extras') {
    loadExtrasGames();
  }
}

let isHostUser = false;

// Check network info & determine whether user is Host or Guest
async function checkNetworkInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    isHostUser = Boolean(data.isHost);

    if (data.lanUrls && data.lanUrls.length > 0) {
      document.getElementById('host-ip-label').innerText = `LAN: ${data.lanUrls[0]}`;
      document.getElementById('host-network-pill').title = `Friend on same Wi-Fi can open: ${data.lanUrls[0]}`;
    }

    // Role-based Auto Routing:
    if (isHostUser) {
      // YOU ARE THE HOST: Open your Host Control Center directly
      startHostFlow();
    } else {
      // OTHER PLAYER: Show ONLY the Room Code prompt -> Direct Game!
      const extrasBtn = document.getElementById('btn-extras-menu');
      const backBtnWrap = document.getElementById('guest-back-btn-wrap');
      if (extrasBtn) extrasBtn.style.display = 'none';
      if (backBtnWrap) backBtnWrap.style.display = 'none';

      showScreen('guest');
    }
  } catch(e) {
    showScreen('guest');
  }
}

// Auto-check URL query for room code e.g. /stream/ABCDE or ?code=ABCDE
function checkUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const pathMatch = window.location.pathname.match(/\/stream\/([A-Za-z0-9]+)/);
  const code = urlParams.get('code') || urlParams.get('room') || urlParams.get('stream') || (pathMatch ? pathMatch[1] : null);

  if (code) {
    showScreen('guest');
    const input = document.getElementById('guest-room-code-input');
    if (input) input.value = code.toUpperCase();
  }

  // Allow pressing Enter key to join
  const codeInput = document.getElementById('guest-room-code-input');
  if (codeInput) {
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        connectGuestToStream();
      }
    });
  }
}

// ==========================================
// HOST ACTIONS (Games from C:\Games & Streaming)
// ==========================================
let detectedGamesList = [];

async function scanHostGames() {
  const folderInput = document.getElementById('host-games-folder');
  const folder = folderInput ? folderInput.value.trim() : 'C:\\Games';
  const select = document.getElementById('host-game-select');
  const pathDisplay = document.getElementById('selected-game-path');
  const tag = document.getElementById('folder-display-tag');
  const scanBtn = document.getElementById('btn-scan-folder');

  if (tag) tag.innerText = folder;
  if (pathDisplay) pathDisplay.innerText = `Scanning "${folder}" for games...`;
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.innerText = '⏳ Scanning...';
  }

  try {
    console.log('[Host Scanner] Scanning folder:', folder);
    const res = await fetch(`/api/detected-games?folder=${encodeURIComponent(folder)}`);
    const data = await res.json();
    detectedGamesList = data.games || [];
    console.log('[Host Scanner] Found games:', detectedGamesList);

    if (select) {
      select.innerHTML = '';
      if (detectedGamesList.length === 0) {
        select.innerHTML = '<option value="">No games found in this folder</option>';
        if (pathDisplay) pathDisplay.innerText = `No games found in ${folder}. Place game folders in ${folder} or choose another path.`;
        showToast(`No games found in ${folder}`, '⚠️');
        return;
      }

      detectedGamesList.forEach((game) => {
        const opt = document.createElement('option');
        opt.value = game.exePath;
        opt.textContent = `🎮 ${game.title}`;
        select.appendChild(opt);
      });

      onGameSelected();
      showToast(`Found ${detectedGamesList.length} game(s) in ${folder}!`, '🎉');
    }
  } catch (err) {
    console.error('[Host Scanner Error]:', err);
    if (pathDisplay) pathDisplay.innerText = `Failed to scan folder: ${err.message}`;
    showToast(`Scan error: ${err.message}`, '❌');
  } finally {
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.innerText = '🔄 Scan Folder';
    }
  }
}

// Make globally accessible
window.scanHostGames = scanHostGames;
window.onGameSelected = onGameSelected;

function onGameSelected() {
  const select = document.getElementById('host-game-select');
  const pathDisplay = document.getElementById('selected-game-path');
  const launchBtn = document.getElementById('btn-launch-game');

  if (!select) return;
  const chosenExe = select.value;
  const chosenGame = detectedGamesList.find(g => g.exePath === chosenExe);

  if (pathDisplay) {
    pathDisplay.innerHTML = chosenExe 
      ? `<strong>Executable:</strong> ${chosenExe}`
      : 'No executable selected';
  }

  if (launchBtn) {
    const title = chosenGame ? chosenGame.title : 'Selected Game';
    launchBtn.innerText = `🚀 1-Click Launch "${title}" & Stream`;
    launchBtn.disabled = !chosenExe;
  }
}

async function startHostFlow() {
  showScreen('host');
  await scanHostGames();

  if (!currentRoomCode && window.CouchPlay) {
    try {
      const select = document.getElementById('host-game-select');
      const gameTitle = select && select.selectedOptions[0] ? select.selectedOptions[0].text.replace('🎮 ', '') : 'PC Co-Op Game';
      currentRoomCode = await window.CouchPlay.createHostStream(gameTitle, 'Host');
      document.getElementById('display-room-code').innerText = currentRoomCode;
    } catch(err) {
      showToast(err.message, '⚠️');
    }
  }
}

async function launchSelectedGame() {
  const select = document.getElementById('host-game-select');
  const chosenExe = select ? select.value : '';
  const chosenGame = detectedGamesList.find(g => g.exePath === chosenExe);
  const gameName = chosenGame ? chosenGame.title : 'Game';

  const btn = document.getElementById('btn-launch-game');
  btn.disabled = true;
  btn.innerText = `🚀 Starting "${gameName}"...`;

  try {
    // Step 1: Tell server to launch the selected game executable
    const res = await fetch('/api/launcher/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exePath: chosenExe })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    showToast(`"${gameName}" launched! Select its window to stream.`, '🚀');
    btn.innerText = `✓ "${gameName}" is Running`;
    btn.style.background = '#059669';

    // Step 2: Automatically trigger screen capture in the SAME user-gesture chain
    await startHostScreenShare();
  } catch(err) {
    showToast(err.message, '⚠️');
    btn.innerText = `🚀 1-Click Launch "${gameName}" & Stream`;
    btn.disabled = false;
  }
}

async function startHostScreenShare() {
  const btn = document.getElementById('btn-share-screen');
  const stopBtn = document.getElementById('btn-stop-stream');
  const liveBanner = document.getElementById('host-live-banner');
  if (btn) btn.innerText = 'Selecting Game Window...';

  try {
    await window.CouchPlay.startScreenCapture();
    if (btn) {
      btn.innerText = '✓ Streaming Live to Guest!';
      btn.style.background = '#059669';
    }
    if (stopBtn) stopBtn.style.display = 'inline-flex';
    if (liveBanner) liveBanner.style.display = 'flex';
    showToast('Screen streaming live! Ready for your friend.', '📺');
  } catch(err) {
    if (btn) {
      btn.innerText = '📺 Select Game Window & Stream';
      btn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
    }
    showToast('Screen share was cancelled or closed.', 'ℹ️');
  }
}

async function stopHostStream() {
  const stopBtn = document.getElementById('btn-stop-stream');
  if (stopBtn) {
    stopBtn.innerText = 'Stopping...';
    stopBtn.disabled = true;
  }

  // 1. Tell CouchPlay to stop all tracks & peer connection
  if (window.CouchPlay) {
    try {
      window.CouchPlay.stopStream();
    } catch(e) {}
  }

  // 2. Clear local video preview
  const preview = document.getElementById('host-stream-preview');
  if (preview) {
    preview.srcObject = null;
  }

  // 3. Notify server to broadcast stream:stopped
  if (socket) {
    socket.emit('stream:stop', { roomCode: currentRoomCode });
  }

  resetHostStreamingUI();
  showToast('Streaming stopped.', '🛑');
}

function resetHostStreamingUI() {
  const stopBtn = document.getElementById('btn-stop-stream');
  const shareBtn = document.getElementById('btn-share-screen');
  const liveBanner = document.getElementById('host-live-banner');
  const launchBtn = document.getElementById('btn-launch-game');

  if (stopBtn) {
    stopBtn.style.display = 'none';
    stopBtn.disabled = false;
    stopBtn.innerText = '⏹ Stop Streaming';
  }
  if (liveBanner) {
    liveBanner.style.display = 'none';
  }
  if (shareBtn) {
    shareBtn.innerText = '📺 Select Game Window & Stream';
    shareBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
  }
  if (launchBtn) {
    const select = document.getElementById('host-game-select');
    const chosenExe = select ? select.value : '';
    const chosenGame = detectedGamesList.find(g => g.exePath === chosenExe);
    const title = chosenGame ? chosenGame.title : 'Selected Game';
    launchBtn.innerText = `🚀 1-Click Launch "${title}" & Stream`;
    launchBtn.style.background = '';
    launchBtn.disabled = false;
  }
}

function copyRoomLink() {
  if (!currentRoomCode) return;
  const link = `${window.location.origin}/stream/${currentRoomCode}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast(`Copied invite link: ${link}`, '📋');
  }).catch(() => {
    navigator.clipboard.writeText(currentRoomCode);
    showToast(`Copied Room Code: ${currentRoomCode}`, '📋');
  });
}

// ==========================================
// GUEST ACTIONS
// ==========================================
async function connectGuestToStream() {
  const code = document.getElementById('guest-room-code-input').value.trim();
  const btn = document.getElementById('btn-guest-connect');

  if (!code) {
    showToast('Please type the 5-character Room Code.', '⚠️');
    return;
  }

  // 1. Enter Fullscreen IMMEDIATELY on the click gesture!
  const streamView = document.getElementById('guest-stream-view');
  document.getElementById('guest-join-box').style.display = 'none';
  streamView.style.display = 'block';

  try {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (document.documentElement.webkitRequestFullscreen) {
      document.documentElement.webkitRequestFullscreen();
    }
  } catch(e) {}

  // 2. Connect to the room
  try {
    const res = await window.CouchPlay.joinGuestStream(code, 'Guest');
    const isP2 = res && res.isPlayer2;
    if (isP2) {
      showToast('You are Player 2! Your controller is connected to the game.', '🎮');
      checkGuestJoystick();
    } else {
      showToast('You joined as Spectator! You can watch the live stream.', '👀');
      const label = document.getElementById('guest-joystick-hud');
      if (label) {
        label.innerText = '👀 Spectator Mode (Live Stream Only)';
        label.style.color = '#38bdf8';
      }
    }
  } catch (err) {
    showToast(err.message, '❌');
    document.getElementById('guest-join-box').style.display = 'block';
    streamView.style.display = 'none';
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }
}

function exitFullscreenGuest() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  document.getElementById('guest-stream-view').style.display = 'none';
  document.getElementById('guest-join-box').style.display = 'block';
}

// Auto-hide Top HUD in Fullscreen after mouse inactivity
let guestHudTimer = null;
window.addEventListener('mousemove', () => {
  const hud = document.getElementById('guest-fullscreen-hud');
  if (hud && document.getElementById('guest-stream-view').style.display !== 'none') {
    hud.style.opacity = '1';
    clearTimeout(guestHudTimer);
    guestHudTimer = setTimeout(() => {
      hud.style.opacity = '0';
    }, 2500);
  }
});

let lastReportedDevice = '';

function checkGuestJoystick() {
  const label = document.getElementById('guest-joystick-hud');
  setInterval(() => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    let found = false;
    let deviceName = 'Keyboard (Arrow Keys)';
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) {
        deviceName = gamepads[i].id || 'Game Controller';
        if (label) {
          label.innerText = `Controller Active: ${deviceName.substring(0, 18)}`;
          label.style.color = '#34d399';
        }
        found = true;
        break;
      }
    }
    if (!found && label) {
      label.innerText = `Keyboard Active (Arrow Keys + Enter)`;
      label.style.color = '#94a3b8';
    }

    if (deviceName !== lastReportedDevice && socket) {
      lastReportedDevice = deviceName;
      socket.emit('stream:device_status', {
        roomCode: currentRoomCode,
        deviceName: deviceName,
        isGamepad: found
      });
    }
  }, 1000);
}

function toggleFullscreen() {
  const container = document.querySelector('.player-view-container');
  if (!document.fullscreenElement) {
    container.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function unmuteGuestVideo() {
  const video = document.getElementById('guest-remote-video');
  const overlay = document.getElementById('play-sound-overlay');
  if (video) {
    video.muted = false;
    video.play().catch(() => {});
  }
  if (overlay) {
    overlay.style.display = 'none';
  }
}

// Toast helper
function showToast(message, icon = 'ℹ️') {
  const toast = document.getElementById('toast');
  document.getElementById('toast-icon').innerText = icon;
  document.getElementById('toast-text').innerText = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 4000);
}

// Extras list (hidden)
async function loadExtrasGames() {
}
