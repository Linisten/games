/**
 * ArcadeNexus Client Application
 * Handles UI Views, Real-time Multiplayer Rooms, Game Iframe SDK Bridge,
 * and Universal Remote Controller Key Mirroring.
 */

// Global State
let socket = null;
let currentRoom = null;
let myPlayer = null;
let isHost = false;
let pingInterval = null;
let gamesCatalog = [];

// DOM Elements
const views = {
  couchplay: document.getElementById('view-couchplay'),
  library: document.getElementById('view-library'),
  lobby: document.getElementById('view-lobby'),
  arena: document.getElementById('view-arena'),
  upload: document.getElementById('view-upload'),
  storage: document.getElementById('view-storage'),
  docs: document.getElementById('view-docs')
};

// Initialize Application
window.addEventListener('DOMContentLoaded', async () => {
  initSocket();
  await loadServerInfo();
  await loadGames();
  checkUrlForRoomCode();

  // Listen for messages from Game Iframes
  window.addEventListener('message', handleIframeMessage);

  // Setup Drag and Drop
  setupDropzone();
});

// Setup Socket.IO
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('[Socket] Connected with ID:', socket.id);
    document.getElementById('server-status-label').innerText = 'Online Server Active';
    startPingMonitor();
  });

  socket.on('disconnect', () => {
    console.warn('[Socket] Disconnected from server');
    document.getElementById('server-status-label').innerText = 'Server Disconnected';
  });

  // Room Updated (players joined, ready status changed)
  socket.on('room:updated', (roomData) => {
    currentRoom = roomData;
    renderLobby();
  });

  // Game Started by Host
  socket.on('room:game_started', ({ roomCode, room }) => {
    currentRoom = room;
    if (window.Sounds) window.Sounds.playStart();
    launchGameArena();
  });

  // Chat message received
  socket.on('room:chat_message', (msg) => {
    appendChatMessage(msg);
    if (!msg.isSystem && window.Sounds) {
      window.Sounds.playChat();
    }
  });

  // Peer-to-Peer Game Event Relay (SDK Mode)
  socket.on('game:event', (payload) => {
    const iframe = document.getElementById('game-iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({
        source: 'NEXUS_PLATFORM',
        type: 'GAME_EVENT',
        event: payload.event,
        data: payload.data,
        fromPlayer: payload.fromPlayer
      }, '*');
    }
  });

  // Universal Controller Input Event (Keys Mode)
  socket.on('game:input_event', ({ key, state, playerIndex }) => {
    const iframe = document.getElementById('game-iframe');
    if (!iframe || !iframe.contentWindow) return;

    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      const eventType = state === 'keydown' ? 'keydown' : 'keyup';
      const event = new KeyboardEvent(eventType, {
        key: key,
        code: key,
        bubbles: true,
        cancelable: true
      });
      doc.dispatchEvent(event);
      iframe.contentWindow.dispatchEvent(event);
    } catch (err) {
      console.warn('Could not dispatch synthetic key event to iframe:', err);
    }
  });

  // CouchPlay Co-Op Stream Events
  socket.on('stream:guest_connected', ({ guestSocketId, guestName }) => {
    console.log(`[CouchPlay] Guest '${guestName}' connected! Initiating WebRTC offer...`);
    showToast(`${guestName} connected! Starting joystick stream...`, '🎮');
    const badge = document.getElementById('host-guest-badge');
    if (badge) badge.innerText = `${guestName} Connected (Joystick Active)!`;
    window.CouchPlay.setupHostPeer(guestSocketId);
  });

  socket.on('stream:signal', ({ signal }) => {
    window.CouchPlay.handleSignal(signal);
  });
}

// Ping monitor
function startPingMonitor() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (!socket || !socket.connected) return;
    const start = Date.now();
    socket.emit('ping:check', start, (clientStart) => {
      const latency = Date.now() - clientStart;
      const el = document.getElementById('arena-ping');
      if (el) el.innerText = latency;
    });
  }, 3000);
}

// View Navigation
function navigate(viewName) {
  Object.keys(views).forEach(key => {
    if (views[key]) views[key].classList.remove('active');
  });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  if (views[viewName]) {
    views[viewName].classList.add('active');
  }

  if (viewName === 'storage') {
    loadStorageExplorer();
  } else if (viewName === 'library') {
    loadGames();
  }

  if (window.Sounds) window.Sounds.playClick();
}

// Check URL query for room code e.g. /?room=ABCDE, /room/ABCDE, /stream/ABCDE, /?stream=ABCDE
function checkUrlForRoomCode() {
  const urlParams = new URLSearchParams(window.location.search);
  const streamParam = urlParams.get('stream');
  const streamPathMatch = window.location.pathname.match(/\/stream\/([A-Za-z0-9]+)/);
  const streamCode = streamParam || (streamPathMatch ? streamPathMatch[1] : null);

  if (streamCode || window.location.pathname.startsWith('/stream')) {
    navigate('couchplay');
    switchCouchTab('guest');
    if (streamCode) {
      document.getElementById('guest-input-code').value = streamCode.toUpperCase();
    }
    return;
  }

  const codeParam = urlParams.get('room');
  const pathMatch = window.location.pathname.match(/\/room\/([A-Za-z0-9]+)/);
  const code = codeParam || (pathMatch ? pathMatch[1] : null);

  if (code) {
    document.getElementById('modal-room-code').value = code.toUpperCase();
    openJoinModal();
  }
}

// ==========================================
// COUCHPLAY UI HANDLERS (PC GAME STREAMING)
// ==========================================
function switchCouchTab(tab) {
  const hostPanel = document.getElementById('couch-panel-host');
  const guestPanel = document.getElementById('couch-panel-guest');
  const btnHost = document.getElementById('btn-tab-couch-host');
  const btnGuest = document.getElementById('btn-tab-couch-guest');

  if (tab === 'host') {
    hostPanel.classList.add('active');
    guestPanel.classList.remove('active');
    btnHost.classList.add('active');
    btnGuest.classList.remove('active');
  } else {
    hostPanel.classList.remove('active');
    guestPanel.classList.add('active');
    btnHost.classList.remove('active');
    btnGuest.classList.add('active');
    if (window.CouchPlay) window.CouchPlay.startGamepadPoll();
  }
}

async function handleHostCreateRoom() {
  const gameName = document.getElementById('host-game-name').value.trim() || 'PC Local Co-Op Game';
  try {
    const roomCode = await window.CouchPlay.createHostStream(gameName, 'Host Player');
    document.getElementById('couch-host-code').innerText = roomCode;
    document.getElementById('btn-create-couch-room').style.display = 'none';
    document.getElementById('btn-start-screen-share').style.display = 'inline-flex';
    showToast(`Couch Room created! Code: ${roomCode}`, '📺');
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

async function handleHostStartShare() {
  try {
    await window.CouchPlay.startScreenCapture();
    document.getElementById('btn-start-screen-share').innerText = '✓ Streaming Game & Audio';
    document.getElementById('btn-start-screen-share').style.background = '#059669';
    showToast('Game streaming live! Waiting for Player 2...', '🎮');
  } catch (err) {
    showToast('Screen share was cancelled or failed.', '⚠️');
  }
}

function copyCouchRoomCode() {
  const code = document.getElementById('couch-host-code').innerText;
  if (!code || code === '------') return;
  const inviteUrl = `${window.location.origin}/stream/${code}`;
  navigator.clipboard.writeText(inviteUrl).then(() => {
    showToast(`Copied CouchPlay invite link: ${inviteUrl}`, '📋');
  }).catch(() => {
    navigator.clipboard.writeText(code);
    showToast(`Copied code: ${code}`, '📋');
  });
}

function changeMappingPreset(preset) {
  const mappings = {
    arrows: { up: 38, down: 40, left: 37, right: 39, btnA: 13, btnB: 16, btnX: 90, btnY: 88, lb: 81, rb: 69, start: 27 },
    wasd:   { up: 87, down: 83, left: 65, right: 68, btnA: 32, btnB: 70, btnX: 67, btnY: 86, lb: 81, rb: 69, start: 27 },
    numpad: { up: 104, down: 98, left: 100, right: 102, btnA: 96, btnB: 13, btnX: 97, btnY: 99, lb: 103, rb: 105, start: 27 },
    ijkl:   { up: 73, down: 75, left: 74, right: 76, btnA: 85, btnB: 79, btnX: 89, btnY: 72, lb: 85, rb: 79, start: 27 }
  };

  if (mappings[preset]) {
    window.CouchPlay.customKeyMap = mappings[preset];
    showToast(`Player 2 mapping preset updated: ${preset.toUpperCase()}`, '⚙️');
  }
}

async function handleGuestConnectStream() {
  const code = document.getElementById('guest-input-code').value.trim();
  const name = document.getElementById('guest-player-name').value.trim() || 'Player 2 (Guest)';

  if (!code) {
    showToast('Please enter the 5-character Couch Room Code.', '⚠️');
    return;
  }

  try {
    document.getElementById('guest-conn-status').innerText = 'Connecting to Host PC...';
    await window.CouchPlay.joinGuestStream(code, name);
    showToast(`Connected to Host! Your joystick is active as Player 2.`, '🎉');
  } catch (err) {
    document.getElementById('guest-conn-status').innerText = 'Connection Failed';
    showToast(err.message, '❌');
  }
}

function toggleStreamFullscreen() {
  const video = document.getElementById('guest-remote-video');
  if (!video) return;
  if (!document.fullscreenElement) {
    video.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

// Load Server & Local Network Info
async function loadServerInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    if (data.lanUrls && data.lanUrls.length > 0) {
      document.getElementById('host-connection-info').title = 
        `Network URL for friends on same Wi-Fi: ${data.lanUrls[0]}`;
    }
  } catch (e) {}
}

// Load Games Catalog
async function loadGames() {
  try {
    const res = await fetch('/api/games');
    const data = await res.json();
    gamesCatalog = data.games || [];
    renderGamesGrid(gamesCatalog);
  } catch (err) {
    console.error('Error loading games:', err);
  }
}

// Render Games Grid
function renderGamesGrid(games) {
  const container = document.getElementById('games-container');
  const countLabel = document.getElementById('game-count-label');
  countLabel.innerText = `${games.length} games ready to play`;

  container.innerHTML = games.map(game => {
    const badgeClass = (game.badge || 'custom').toLowerCase();
    const isCustom = !game.author.includes('Built-in');

    return `
      <div class="game-card">
        <div>
          <div class="card-top">
            <span class="game-badge ${badgeClass}">${game.badge || 'Arcade'}</span>
            ${isCustom ? `<button class="btn-danger" style="padding: 0.2rem 0.6rem; font-size: 0.75rem;" onclick="deleteGame('${game.id}', event)">Delete</button>` : ''}
          </div>
          <h3 class="game-title">${escapeHtml(game.title)}</h3>
          <p class="game-desc">${escapeHtml(game.description || 'No description provided.')}</p>
        </div>

        <div>
          <div class="game-meta">
            <span>👥 ${game.minPlayers}-${game.maxPlayers || 2} Players</span>
            <span>⚡ ${game.syncMode === 'keys' ? 'Key Mirroring' : 'SDK Real-Time'}</span>
          </div>

          <div class="card-actions">
            <button class="btn-primary" onclick="createRoom('${game.id}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              Create Room
            </button>
            <button class="btn-secondary" onclick="playSolo('${game.id}')">
              Solo / Test
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Create a Room
function createRoom(gameId) {
  const hostName = prompt('Enter your host player name:', 'Player 1') || 'Player 1';

  socket.emit('room:create', { gameId, hostName }, (res) => {
    if (res.error) {
      showToast(res.error, '⚠️');
      return;
    }

    currentRoom = res.room;
    myPlayer = res.player;
    isHost = true;

    if (window.Sounds) window.Sounds.playJoin();
    navigate('lobby');
    renderLobby();
    showToast(`Room created! Code: ${res.roomCode}`, '🎮');
  });
}

// Join Room handler
function handleJoinRoom(roomCode, playerName) {
  if (!roomCode) {
    showToast('Please enter a room code.', '⚠️');
    return;
  }

  socket.emit('room:join', { roomCode, playerName }, (res) => {
    if (res.error) {
      showToast(res.error, '❌');
      return;
    }

    currentRoom = res.room;
    myPlayer = res.player;
    isHost = false;

    closeJoinModal();
    if (window.Sounds) window.Sounds.playJoin();
    navigate('lobby');
    renderLobby();
    showToast(`Joined room ${res.roomCode}!`, '🎉');
  });
}

function handleQuickJoin() {
  const code = document.getElementById('quick-room-code').value.trim();
  const name = document.getElementById('quick-player-name').value.trim() || 'Player 2';
  handleJoinRoom(code, name);
}

function handleModalJoin() {
  const code = document.getElementById('modal-room-code').value.trim();
  const name = document.getElementById('modal-player-name').value.trim() || 'Player 2';
  handleJoinRoom(code, name);
}

// Render Lobby View
function renderLobby() {
  if (!currentRoom) return;

  document.getElementById('lobby-room-code').innerText = currentRoom.code;
  document.getElementById('lobby-game-title').innerText = currentRoom.gameTitle;
  document.getElementById('player-count').innerText = currentRoom.players.length;

  const game = gamesCatalog.find(g => g.id === currentRoom.gameId);
  document.getElementById('lobby-game-controls').innerText = game ? (game.controls || 'Standard controls') : 'Standard Controls';

  const syncTag = document.getElementById('lobby-sync-tag');
  if (currentRoom.syncMode === 'keys') {
    syncTag.innerHTML = `<span class="game-badge retrofit">Universal Remote Controller Sync</span>`;
  } else {
    syncTag.innerHTML = `<span class="game-badge action">SDK Real-Time Network Sync</span>`;
  }

  // Render players list
  const listEl = document.getElementById('lobby-players-list');
  listEl.innerHTML = currentRoom.players.map((p, idx) => {
    const isMe = myPlayer && p.id === myPlayer.id;
    return `
      <div class="player-row ${idx === 1 ? 'p2' : ''}">
        <div class="player-info">
          <div class="player-avatar">${p.name.charAt(0).toUpperCase()}</div>
          <div>
            <div style="font-weight: 700;">
              ${escapeHtml(p.name)} ${isMe ? '<span style="color:var(--accent-cyan); font-size:0.8rem;">(You)</span>' : ''}
            </div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">
              ${p.isHost ? '👑 Room Host (Player 1)' : `Player ${idx + 1}`}
            </div>
          </div>
        </div>
        <div>
          <span class="ready-tag ${p.isReady ? 'ready' : 'waiting'}">
            ${p.isReady ? '✓ Ready' : '⏳ Waiting'}
          </span>
        </div>
      </div>
    `;
  }).join('');

  // Start game button state
  const btnStart = document.getElementById('btn-start-game');
  if (myPlayer && myPlayer.isHost) {
    btnStart.style.display = 'inline-flex';
    btnStart.disabled = false;
  } else {
    btnStart.style.display = 'none';
  }
}

// Host starts game
function hostStartGame() {
  if (!currentRoom || !myPlayer || !myPlayer.isHost) return;
  socket.emit('room:start', {}, (res) => {
    if (res && res.error) showToast(res.error, '⚠️');
  });
}

// Toggle Ready
function toggleReady() {
  if (!myPlayer) return;
  myPlayer.isReady = !myPlayer.isReady;
  socket.emit('room:ready', { isReady: myPlayer.isReady });
  document.getElementById('btn-toggle-ready').innerText = myPlayer.isReady ? 'Unmark Ready' : 'Mark Ready';
}

// Launch Game Arena (Playing)
function launchGameArena() {
  if (!currentRoom) return;
  navigate('arena');

  document.getElementById('arena-title').innerText = currentRoom.gameTitle;
  document.getElementById('arena-code').innerText = currentRoom.code;
  document.getElementById('arena-role').innerText = myPlayer.isHost ? 'Player 1 (Host)' : `Player ${myPlayer.index + 1}`;

  const iframe = document.getElementById('game-iframe');
  const gamePath = `/games/${currentRoom.folder}/${currentRoom.mainFile || 'index.html'}`;
  iframe.src = gamePath;

  // If in Keys mode, setup remote key event listeners
  if (currentRoom.syncMode === 'keys') {
    setupKeyMirroringListeners();
  }
}

// Solo / Preview Mode (Testing game without room)
function playSolo(gameId) {
  const game = gamesCatalog.find(g => g.id === gameId);
  if (!game) return;

  currentRoom = {
    code: 'SOLO',
    gameId: game.id,
    gameTitle: game.title,
    syncMode: game.syncMode,
    folder: game.folder,
    mainFile: game.mainFile,
    players: [{ id: 'p_solo', name: 'Solo Player', index: 0, isHost: true }]
  };
  myPlayer = currentRoom.players[0];
  isHost = true;

  navigate('arena');
  document.getElementById('arena-title').innerText = `${game.title} (Solo Test)`;
  document.getElementById('arena-code').innerText = 'SOLO';
  document.getElementById('arena-role').innerText = 'Player 1 (Solo)';

  const iframe = document.getElementById('game-iframe');
  iframe.src = `/games/${game.folder}/${game.mainFile || 'index.html'}`;
}

// Universal Remote Controller Key Mirroring
function setupKeyMirroringListeners() {
  const handleKey = (e) => {
    // Only capture if arena is active
    if (!views.arena.classList.contains('active')) return;
    if (!socket || !currentRoom) return;

    // Send input packet to room peers
    socket.emit('game:input', {
      roomCode: currentRoom.code,
      key: e.key,
      state: e.type, // 'keydown' or 'keyup'
      playerIndex: myPlayer ? myPlayer.index : 0
    });
  };

  window.removeEventListener('keydown', handleKey);
  window.removeEventListener('keyup', handleKey);
  window.addEventListener('keydown', handleKey);
  window.addEventListener('keyup', handleKey);
}

// Handle Messages from Game Iframes (Multiplayer SDK Bridge)
function handleIframeMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || msg.source !== 'NEXUS_GAME') return;
  const iframe = document.getElementById('game-iframe');

  switch (msg.type) {
    case 'READY_QUERY':
      // Handshake response to game
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({
          source: 'NEXUS_PLATFORM',
          type: 'HANDSHAKE',
          player: myPlayer || { id: 'p_local', name: 'Player', index: 0, isHost: true },
          players: currentRoom ? currentRoom.players : [myPlayer],
          roomCode: currentRoom ? currentRoom.code : 'LOCAL',
          gameId: currentRoom ? currentRoom.gameId : 'unknown'
        }, '*');
      }
      break;

    case 'SEND_EVENT':
      // Relay custom game event over WebSocket
      if (socket && currentRoom) {
        socket.emit('game:relay', {
          roomCode: currentRoom.code,
          event: msg.event,
          data: msg.data,
          targetPlayerIndex: msg.targetPlayerIndex
        });
      }
      break;

    case 'SYNC_INPUT':
      // Relay input state
      if (socket && currentRoom) {
        socket.emit('game:relay', {
          roomCode: currentRoom.code,
          event: 'PLAYER_INPUT',
          data: {
            playerIndex: myPlayer ? myPlayer.index : 0,
            input: msg.input
          }
        });
      }
      break;

    case 'SAVE_DATA':
      // Save game data directly into host system's disk!
      if (socket) {
        socket.emit('game:save_data', {
          gameId: currentRoom ? currentRoom.gameId : null,
          key: msg.key,
          value: msg.value
        }, (res) => {
          if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({
              source: 'NEXUS_PLATFORM',
              type: 'RESPONSE',
              requestId: msg.requestId,
              data: res.saved,
              error: res.error
            }, '*');
          }
          showToast(`Game state '${msg.key}' saved to your system!`, '💾');
        });
      }
      break;

    case 'LOAD_DATA':
      // Load game data from host system's disk!
      if (socket) {
        socket.emit('game:load_data', {
          gameId: currentRoom ? currentRoom.gameId : null,
          key: msg.key
        }, (res) => {
          if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({
              source: 'NEXUS_PLATFORM',
              type: 'RESPONSE',
              requestId: msg.requestId,
              data: res.data,
              error: res.error
            }, '*');
          }
        });
      }
      break;

    case 'SUBMIT_SCORE':
      if (socket) {
        socket.emit('game:submit_score', {
          gameId: currentRoom ? currentRoom.gameId : null,
          score: msg.score,
          metadata: msg.metadata
        }, (res) => {
          if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({
              source: 'NEXUS_PLATFORM',
              type: 'RESPONSE',
              requestId: msg.requestId,
              data: res.record
            }, '*');
          }
        });
      }
      break;

    case 'GAME_OVER':
      if (socket) {
        socket.emit('game:over', {
          winnerIndex: msg.winnerIndex,
          stats: msg.stats
        });
      }
      break;

    case 'SEND_CHAT':
      if (socket && currentRoom) {
        socket.emit('room:chat', { text: msg.message });
      }
      break;
  }
}

// In-Lobby & In-Game Chat
function sendChat(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('chat-input-text');
  const text = input.value.trim();
  if (!text || !socket || !currentRoom) return;

  socket.emit('room:chat', { text });
  input.value = '';
}

function appendChatMessage(msg) {
  const container = document.getElementById('lobby-chat-messages');
  if (!container) return;

  const div = document.createElement('div');
  if (msg.isSystem) {
    div.className = 'chat-bubble system';
    div.innerText = msg.text;
  } else {
    div.className = 'chat-bubble';
    div.innerHTML = `
      <div class="chat-sender">${escapeHtml(msg.sender)}</div>
      <div>${escapeHtml(msg.text)}</div>
    `;
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// Leave room
function leaveRoom() {
  if (socket && currentRoom) {
    socket.emit('room:leave');
  }
  currentRoom = null;
  myPlayer = null;
  isHost = false;

  const iframe = document.getElementById('game-iframe');
  if (iframe) iframe.src = 'about:blank';

  navigate('library');
  showToast('Left the room.', 'ℹ️');
}

// Copy Room Code & Invite Link
function copyRoomCode() {
  if (!currentRoom) return;
  const inviteUrl = `${window.location.origin}/room/${currentRoom.code}`;
  navigator.clipboard.writeText(inviteUrl).then(() => {
    showToast(`Copied room invite link! Code: ${currentRoom.code}`, '📋');
  }).catch(() => {
    navigator.clipboard.writeText(currentRoom.code);
    showToast(`Copied room code: ${currentRoom.code}`, '📋');
  });
}

// Fullscreen Toggle
function toggleFullscreen() {
  const container = document.querySelector('.iframe-container');
  if (!document.fullscreenElement) {
    container.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

// Modal Helpers
function openJoinModal() {
  document.getElementById('join-modal').classList.add('active');
  document.getElementById('modal-room-code').focus();
}

function closeJoinModal() {
  document.getElementById('join-modal').classList.remove('active');
}

// Dropzone & File Upload Logic
function setupDropzone() {
  const dropArea = document.getElementById('drop-area');
  if (!dropArea) return;

  ['dragenter', 'dragover'].forEach(name => {
    dropArea.addEventListener(name, (e) => {
      e.preventDefault();
      dropArea.style.borderColor = 'var(--accent-cyan)';
      dropArea.style.background = 'rgba(6, 182, 212, 0.1)';
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropArea.addEventListener(name, (e) => {
      e.preventDefault();
      dropArea.style.borderColor = '';
      dropArea.style.background = '';
    });
  });

  dropArea.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      document.getElementById('file-input').files = files;
      onFileSelected(document.getElementById('file-input'));
    }
  });
}

function onFileSelected(input) {
  if (input.files && input.files[0]) {
    const file = input.files[0];
    document.getElementById('dropzone-label').innerText = `Selected: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
    const titleField = document.getElementById('form-title');
    if (!titleField.value) {
      titleField.value = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
    }
  }
}

function switchUploadTab(tab) {
  const panelFile = document.getElementById('upload-panel-file');
  const panelCode = document.getElementById('upload-panel-code');
  const btnZip = document.getElementById('tab-btn-zip');
  const btnCode = document.getElementById('tab-btn-code');

  if (tab === 'file') {
    panelFile.style.display = 'block';
    panelCode.style.display = 'none';
    btnZip.className = 'btn-primary';
    btnCode.className = 'btn-secondary';
  } else {
    panelFile.style.display = 'none';
    panelCode.style.display = 'block';
    btnZip.className = 'btn-secondary';
    btnCode.className = 'btn-primary';
  }
}

// Handle Game Upload Form Submission
async function handleGameUpload(e) {
  e.preventDefault();
  const form = document.getElementById('upload-game-form');
  const fileInput = document.getElementById('file-input');

  if (!fileInput.files || !fileInput.files[0]) {
    showToast('Please select a .ZIP or .HTML game file to upload.', '⚠️');
    return;
  }

  const formData = new FormData(form);
  const btn = document.getElementById('btn-submit-upload');
  btn.disabled = true;
  btn.innerText = 'Uploading and Unpacking to System...';

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const result = await res.json();

    if (!res.ok || result.error) {
      throw new Error(result.error || 'Upload failed');
    }

    showToast(`Game '${result.game.title}' saved to your computer!`, '✅');
    form.reset();
    document.getElementById('dropzone-label').innerText = 'Click to select or drag & drop .ZIP / .HTML game';
    await loadGames();
    navigate('library');
  } catch (err) {
    showToast(err.message, '❌');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Upload & Save Game to System';
  }
}

// Handle Studio HTML Save
async function handleStudioSave(e) {
  e.preventDefault();
  const title = document.getElementById('studio-title').value.trim();
  const syncMode = document.getElementById('studio-sync').value;
  const htmlContent = document.getElementById('studio-code').value.trim();

  try {
    const res = await fetch('/api/create-simple-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, syncMode, htmlContent })
    });
    const result = await res.json();

    if (!res.ok || result.error) throw new Error(result.error || 'Save failed');

    showToast(`Saved '${title}' to system storage!`, '✅');
    await loadGames();
    navigate('library');
  } catch (err) {
    showToast(err.message, '❌');
  }
}

// Delete Game
async function deleteGame(id, e) {
  e.stopPropagation();
  if (!confirm('Are you sure you want to delete this game from your system?')) return;

  try {
    const res = await fetch(`/api/games/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Game removed from system storage.', '🗑️');
      await loadGames();
    }
  } catch (err) {
    showToast('Failed to delete game', '❌');
  }
}

// Storage Explorer View
async function loadStorageExplorer() {
  try {
    const [overviewRes, savesRes, sessionsRes] = await Promise.all([
      fetch('/api/storage/overview').then(r => r.json()),
      fetch('/api/storage/saves').then(r => r.json()),
      fetch('/api/storage/sessions').then(r => r.json())
    ]);

    document.getElementById('stat-games').innerText = overviewRes.totalGames;
    document.getElementById('stat-saves').innerText = overviewRes.totalSaves;
    document.getElementById('stat-scores').innerText = overviewRes.totalScores;
    document.getElementById('stat-disk').innerText = overviewRes.gamesDiskSizeReadable;

    // Render Saves Table
    const savesTbody = document.getElementById('saves-table-body');
    if (savesRes.saves && savesRes.saves.length > 0) {
      savesTbody.innerHTML = savesRes.saves.map(s => `
        <tr>
          <td><b style="color:var(--accent-cyan);">${escapeHtml(s.gameId)}</b></td>
          <td><code>${escapeHtml(s.key)}</code></td>
          <td>${escapeHtml(s.player || 'anonymous')}</td>
          <td><pre style="max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.75rem; color:#94a3b8;">${escapeHtml(JSON.stringify(s.data))}</pre></td>
          <td>${new Date(s.updatedAt).toLocaleString()}</td>
          <td>
            <button class="btn-danger" style="padding:0.25rem 0.6rem; font-size:0.75rem;" onclick="deleteSaveRecord('${s.id}')">Delete</button>
          </td>
        </tr>
      `).join('');
    } else {
      savesTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim);">No saved states yet. Play games to auto-save progress!</td></tr>`;
    }

    // Render Sessions Table
    const sessionsTbody = document.getElementById('sessions-table-body');
    if (sessionsRes.sessions && sessionsRes.sessions.length > 0) {
      sessionsTbody.innerHTML = sessionsRes.sessions.map(sess => `
        <tr>
          <td><b style="font-family:var(--font-mono); color:var(--accent-cyan);">${escapeHtml(sess.roomCode)}</b></td>
          <td>${escapeHtml(sess.gameTitle)}</td>
          <td>${sess.players ? sess.players.map(p => escapeHtml(p.name)).join(', ') : '-'}</td>
          <td><span style="color:#10b981; font-weight:700;">${escapeHtml(sess.winner || 'Active / In-progress')}</span></td>
          <td>${new Date(sess.loggedAt || sess.startTime).toLocaleString()}</td>
        </tr>
      `).join('');
    } else {
      sessionsTbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim);">No match history recorded yet.</td></tr>`;
    }
  } catch (err) {
    console.error('Error loading storage explorer:', err);
  }
}

async function deleteSaveRecord(id) {
  if (!confirm('Delete this saved game record from your computer?')) return;
  try {
    await fetch(`/api/storage/saves/${id}`, { method: 'DELETE' });
    showToast('Saved state deleted', '🗑️');
    loadStorageExplorer();
  } catch (e) {}
}

// Toast helper
function showToast(message, icon = 'ℹ️') {
  const toast = document.getElementById('toast');
  document.getElementById('toast-icon').innerText = icon;
  document.getElementById('toast-text').innerText = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 4000);
}

// Safe HTML Escaper
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
