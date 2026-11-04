const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const AdmZip = require('adm-zip');
const cors = require('cors');
const db = require('./db');
const inputInjector = require('./input_injector');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const GAMES_DIR = path.join(__dirname, 'storage', 'games');
const UPLOADS_DIR = path.join(__dirname, 'storage', 'uploads');

// Ensure directories
[GAMES_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(cors());
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded and built-in games statically with correct MIME types
app.use('/games', express.static(GAMES_DIR));

// Multer upload config
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`);
  }
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// Get local network IPs for LAN multiplayer
function getNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

// ==========================================
// REST API
// ==========================================

// Server & Network info
app.get('/api/info', (req, res) => {
  const localIps = getNetworkAddresses();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
  const isLocalHost = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';

  res.json({
    platform: "ArcadeNexus Multiplayer Platform",
    port: PORT,
    localIps,
    lanUrls: localIps.map(ip => `http://${ip}:${PORT}`),
    localUrl: `http://localhost:${PORT}`,
    isHost: isLocalHost || req.query.host === 'true',
    storageStats: db.getStorageStats()
  });
});

// Games listing
app.get('/api/games', (req, res) => {
  res.json({ games: db.getGames() });
});

app.get('/api/games/:id', (req, res) => {
  const game = db.getGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json({ game });
});

// Upload Game (Zip or single HTML file)
app.post('/api/upload', upload.single('gameFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No game file was provided.' });
    }

    const title = req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname));
    const gameId = (req.body.id || title.toLowerCase().replace(/[^a-z0-9]/g, '-')).replace(/-+/g, '-').replace(/^-|-$/g, '') || `game-${Date.now()}`;
    const targetFolder = path.join(GAMES_DIR, gameId);

    if (fs.existsSync(targetFolder)) {
      fs.rmSync(targetFolder, { recursive: true, force: true });
    }
    fs.mkdirSync(targetFolder, { recursive: true });

    let mainFile = 'index.html';
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (ext === '.zip') {
      const zip = new AdmZip(req.file.path);
      zip.extractAllTo(targetFolder, true);

      // Verify or locate main HTML file
      if (!fs.existsSync(path.join(targetFolder, 'index.html'))) {
        const files = fs.readdirSync(targetFolder, { recursive: true });
        const htmlFile = files.find(f => typeof f === 'string' && f.toLowerCase().endsWith('.html'));
        if (htmlFile) {
          mainFile = htmlFile.replace(/\\/g, '/');
        } else {
          return res.status(400).json({ error: 'Uploaded zip contains no .html entrypoint file.' });
        }
      }
    } else if (ext === '.html' || ext === '.htm') {
      fs.copyFileSync(req.file.path, path.join(targetFolder, 'index.html'));
      mainFile = 'index.html';
    } else {
      return res.status(400).json({ error: 'Unsupported format. Please upload a .zip archive or .html file.' });
    }

    // Cleanup temp uploaded file
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    const newGame = {
      id: gameId,
      title: title,
      description: req.body.description || 'Custom uploaded game.',
      author: req.body.author || 'User Upload',
      version: req.body.version || '1.0.0',
      minPlayers: parseInt(req.body.minPlayers) || 2,
      maxPlayers: parseInt(req.body.maxPlayers) || 2,
      syncMode: req.body.syncMode || 'sdk', // 'sdk' or 'keys'
      type: req.body.type || 'arcade',
      folder: gameId,
      mainFile: mainFile,
      badge: 'Custom',
      accentColor: req.body.accentColor || '#38bdf8',
      controls: req.body.controls || (req.body.syncMode === 'keys' ? 'Host: WASD/Space, Guest: Arrows/Enter' : 'Custom Game SDK Controls'),
      createdAt: new Date().toISOString()
    };

    db.addGame(newGame);

    res.json({
      success: true,
      game: newGame,
      message: `Game '${title}' uploaded and registered successfully in your local system!`
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to process game upload: ' + err.message });
  }
});

// Quick Save Simple HTML Game (from in-browser editor)
app.post('/api/create-simple-game', (req, res) => {
  try {
    const { title, htmlContent, syncMode, controls, description } = req.body;
    if (!title || !htmlContent) {
      return res.status(400).json({ error: 'Title and HTML content are required.' });
    }

    const gameId = (title.toLowerCase().replace(/[^a-z0-9]/g, '-')).replace(/-+/g, '-').replace(/^-|-$/g, '') || `game-${Date.now()}`;
    const targetFolder = path.join(GAMES_DIR, gameId);

    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }

    fs.writeFileSync(path.join(targetFolder, 'index.html'), htmlContent, 'utf8');

    const newGame = {
      id: gameId,
      title: title,
      description: description || 'Created via built-in Game Studio.',
      author: 'User',
      version: '1.0.0',
      minPlayers: 2,
      maxPlayers: 2,
      syncMode: syncMode || 'keys',
      type: 'custom',
      folder: gameId,
      mainFile: 'index.html',
      badge: 'Studio',
      accentColor: '#10b981',
      controls: controls || 'P1: WASD, P2: Arrows',
      createdAt: new Date().toISOString()
    };

    db.addGame(newGame);

    res.json({ success: true, game: newGame });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a game
app.delete('/api/games/:id', (req, res) => {
  const game = db.getGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  // Delete folder
  const targetFolder = path.join(GAMES_DIR, game.folder || game.id);
  if (fs.existsSync(targetFolder)) {
    try {
      fs.rmSync(targetFolder, { recursive: true, force: true });
    } catch (e) {
      console.warn('Could not remove folder:', e.message);
    }
  }

  db.deleteGame(req.params.id);
  res.json({ success: true, message: 'Game removed from system.' });
});

// System Storage Explorer API
app.get('/api/storage/overview', (req, res) => {
  res.json(db.getStorageStats());
});

app.get('/api/storage/saves', (req, res) => {
  const gameId = req.query.gameId;
  res.json({ saves: db.listGameSaves(gameId) });
});

app.delete('/api/storage/saves/:id', (req, res) => {
  const success = db.deleteSave(req.params.id);
  res.json({ success });
});

app.get('/api/storage/scores', (req, res) => {
  const gameId = req.query.gameId;
  res.json({ scores: db.getScores(gameId) });
});

app.get('/api/storage/sessions', (req, res) => {
  res.json({ sessions: db.getSessions() });
});

app.get('/api/storage/export', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=arcadenexus_system_backup.json');
  res.send(JSON.stringify(db.data, null, 2));
});

app.post('/api/storage/wipe', (req, res) => {
  db.wipeAll();
  res.json({ success: true, message: 'All match data, scores, and saves reset.' });
});

// Direct room link routing: /room/:code -> serves index.html
app.get(['/room/:code', '/stream', '/stream/:code'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// REAL-TIME ROOMS & MULTIPLAYER (Socket.IO)
// ==========================================

const activeRooms = new Map();

// Generate readable 5-char code without ambiguous characters
function generateRoomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (activeRooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentPlayerId = null;

  // Latency check
  socket.on('ping:check', (startTime, cb) => {
    if (typeof cb === 'function') cb(startTime);
  });

  // Create Room
  socket.on('room:create', ({ gameId, hostName }, callback) => {
    const game = db.getGame(gameId);
    if (!game) {
      return callback({ error: 'Game not found on host system.' });
    }

    const roomCode = generateRoomCode();
    currentPlayerId = 'p_' + Math.random().toString(36).substring(2, 9);
    currentRoomCode = roomCode;

    const hostPlayer = {
      id: currentPlayerId,
      socketId: socket.id,
      name: (hostName || 'Host Player').trim().substring(0, 20),
      index: 0,
      isHost: true,
      isReady: true,
      connectedAt: Date.now()
    };

    const room = {
      code: roomCode,
      gameId: game.id,
      gameTitle: game.title,
      syncMode: game.syncMode || 'sdk',
      folder: game.folder,
      mainFile: game.mainFile || 'index.html',
      maxPlayers: game.maxPlayers || 2,
      hostSocketId: socket.id,
      hostPlayerId: currentPlayerId,
      createdAt: Date.now(),
      status: 'lobby', // 'lobby' or 'playing'
      players: [hostPlayer]
    };

    activeRooms.set(roomCode, room);
    socket.join(roomCode);

    callback({
      success: true,
      roomCode,
      player: hostPlayer,
      room: sanitizeRoom(room)
    });

    console.log(`[Room Created] ${roomCode} for game '${game.title}' by ${hostPlayer.name}`);
  });

  // Join Room with Room Code
  socket.on('room:join', ({ roomCode, playerName }, callback) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = activeRooms.get(code);

    if (!room) {
      return callback({ error: `Room '${code}' was not found. Please verify the room code.` });
    }

    if (room.players.length >= room.maxPlayers) {
      return callback({ error: `Room '${code}' is currently full (max ${room.maxPlayers} players).` });
    }

    currentRoomCode = code;
    currentPlayerId = 'p_' + Math.random().toString(36).substring(2, 9);

    const newPlayer = {
      id: currentPlayerId,
      socketId: socket.id,
      name: (playerName || `Player ${room.players.length + 1}`).trim().substring(0, 20),
      index: room.players.length,
      isHost: false,
      isReady: false,
      connectedAt: Date.now()
    };

    room.players.push(newPlayer);
    socket.join(code);

    callback({
      success: true,
      roomCode: code,
      player: newPlayer,
      room: sanitizeRoom(room)
    });

    // Notify others in room
    io.to(code).emit('room:updated', sanitizeRoom(room));
    io.to(code).emit('room:chat_message', {
      sender: 'System',
      text: `${newPlayer.name} joined the room!`,
      isSystem: true,
      timestamp: Date.now()
    });

    console.log(`[Player Joined] ${newPlayer.name} joined room ${code} (${room.players.length}/${room.maxPlayers})`);
  });

  // Ready Check
  socket.on('room:ready', ({ isReady }) => {
    if (!currentRoomCode) return;
    const room = activeRooms.get(currentRoomCode);
    if (!room) return;

    const p = room.players.find(x => x.socketId === socket.id);
    if (p) {
      p.isReady = Boolean(isReady);
      io.to(currentRoomCode).emit('room:updated', sanitizeRoom(room));
    }
  });

  // Host Starts Game
  socket.on('room:start', (data, callback) => {
    if (!currentRoomCode) return;
    const room = activeRooms.get(currentRoomCode);
    if (!room) return;

    if (room.hostSocketId !== socket.id) {
      if (typeof callback === 'function') callback({ error: 'Only the room host can start the game.' });
      return;
    }

    room.status = 'playing';
    io.to(currentRoomCode).emit('room:game_started', {
      roomCode: currentRoomCode,
      room: sanitizeRoom(room)
    });

    // Log session to local system database
    db.logSession({
      roomCode: currentRoomCode,
      gameId: room.gameId,
      gameTitle: room.gameTitle,
      players: room.players.map(p => ({ name: p.name, isHost: p.isHost })),
      startTime: new Date().toISOString()
    });

    if (typeof callback === 'function') callback({ success: true });
    console.log(`[Game Started] Room ${currentRoomCode} launched '${room.gameTitle}'`);
  });

  // Custom Game Event Relay (SDK Mode)
  socket.on('game:relay', ({ roomCode, event, data, targetPlayerIndex }) => {
    const code = roomCode || currentRoomCode;
    if (!code) return;

    const room = activeRooms.get(code);
    if (!room) return;

    const sender = room.players.find(p => p.socketId === socket.id);
    const payload = {
      event,
      data,
      fromPlayer: sender ? { id: sender.id, name: sender.name, index: sender.index } : null
    };

    if (typeof targetPlayerIndex === 'number') {
      const target = room.players.find(p => p.index === targetPlayerIndex);
      if (target) {
        io.to(target.socketId).emit('game:event', payload);
      }
    } else {
      // Broadcast to everyone else in room
      socket.to(code).emit('game:event', payload);
    }
  });

  // Universal Controller Input Bridge (Keys Mode)
  socket.on('game:input', ({ roomCode, key, state, playerIndex }) => {
    const code = roomCode || currentRoomCode;
    if (!code) return;
    socket.to(code).emit('game:input_event', {
      key,
      state, // 'keydown' or 'keyup'
      playerIndex
    });
  });

  // ==========================================
  // COUCHPLAY: PC GAME STREAMING & VIRTUAL JOYSTICK
  // ==========================================
  socket.on('stream:create', ({ gameName, hostName }, callback) => {
    const roomCode = generateRoomCode();
    currentRoomCode = roomCode;
    currentPlayerId = 'host_' + Math.random().toString(36).substring(2, 8);

    const room = {
      code: roomCode,
      type: 'pc-stream',
      gameTitle: gameName || 'PC Local Co-Op Game',
      hostSocketId: socket.id,
      hostName: hostName || 'Host Player',
      createdAt: Date.now(),
      players: [{ id: currentPlayerId, name: hostName || 'Host Player', isHost: true }]
    };

    activeRooms.set(roomCode, room);
    socket.join(roomCode);

    callback({ success: true, roomCode });
    console.log(`[CouchPlay Stream Created] Room ${roomCode} for PC game '${room.gameTitle}'`);
  });

  socket.on('stream:join', ({ roomCode, guestName }, callback) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = activeRooms.get(code);

    if (!room || room.type !== 'pc-stream') {
      return callback({ error: `Streaming room '${code}' was not found. Please verify the code.` });
    }

    currentRoomCode = code;
    currentPlayerId = 'guest_' + Math.random().toString(36).substring(2, 8);

    // First guest who connects becomes Player 2 (gets controller).
    // All rest players who join can ONLY WATCH (Spectators).
    const isPlayer2 = !room.player2SocketId;
    if (isPlayer2) {
      room.player2SocketId = socket.id;
      room.player2Name = guestName || 'Player 2';
    }

    const role = isPlayer2 ? 'player2' : 'spectator';
    const guest = {
      id: currentPlayerId,
      socketId: socket.id,
      name: (guestName || (isPlayer2 ? 'Player 2' : `Spectator ${room.players.length}`)).trim(),
      isHost: false,
      role: role
    };

    room.players.push(guest);
    socket.join(code);

    callback({
      success: true,
      roomCode: code,
      gameTitle: room.gameTitle,
      role: role,
      isPlayer2: isPlayer2,
      guestName: guest.name
    });

    // Inform Host that Guest is ready for WebRTC offer
    io.to(room.hostSocketId).emit('stream:guest_connected', {
      guestSocketId: socket.id,
      guestName: guest.name,
      role: role,
      isPlayer2: isPlayer2,
      players: room.players
    });

    console.log(`[CouchPlay] ${guest.name} joined room ${code} as ${role.toUpperCase()} (Total players: ${room.players.length})`);
  });

  // Relay guest controller status to host (Only for Player 2)
  socket.on('stream:device_status', ({ roomCode, deviceName, isGamepad }) => {
    const code = roomCode || currentRoomCode;
    const room = code ? activeRooms.get(code) : null;
    if (room && room.hostSocketId) {
      const isPlayer2 = socket.id === room.player2SocketId;
      io.to(room.hostSocketId).emit('stream:guest_device_update', {
        guestSocketId: socket.id,
        deviceName,
        isGamepad,
        isPlayer2
      });
    }
  });

  // WebRTC Signaling Relay (SDP Offer / Answer / ICE Candidates)
  socket.on('stream:signal', ({ roomCode, targetSocketId, signal }) => {
    const code = roomCode || currentRoomCode;
    if (!code) return;

    if (targetSocketId) {
      io.to(targetSocketId).emit('stream:signal', { signal, from: socket.id });
    } else {
      socket.to(code).emit('stream:signal', { signal, from: socket.id });
    }
  });

  // Stream Stop notification (Host stops stream)
  socket.on('stream:stop', (data) => {
    const code = (data && data.roomCode) || currentRoomCode;
    console.log(`[Stream] Stop signal received for room: ${code}`);
    if (code) {
      io.to(code).emit('stream:stopped');
    }
  });

  // Windows Hardware Scan-Code Gamepad Injection (ONLY Player 2 controls, REST PLAYERS CAN ONLY WATCH)
  socket.on('stream:gamepad_input', ({ roomCode, gamepadState, customMapping }) => {
    const code = roomCode || currentRoomCode;
    const room = code ? activeRooms.get(code) : null;
    if (room && room.player2SocketId && socket.id !== room.player2SocketId) {
      return; // Block input from spectators!
    }
    inputInjector.injectGamepadState(gamepadState, customMapping);
  });

  // Direct Win32 Single Key Input (ONLY Player 2 controls)
  socket.on('stream:key_input', ({ vkCode, isDown }) => {
    const room = currentRoomCode ? activeRooms.get(currentRoomCode) : null;
    if (room && room.player2SocketId && socket.id !== room.player2SocketId) {
      return; // Block input from spectators!
    }
    inputInjector.sendKey(vkCode, isDown);
  });

  // In-Game Persistent Storage: Save Game to Host System
  socket.on('game:save_data', ({ gameId, key, value }, callback) => {
    try {
      const room = currentRoomCode ? activeRooms.get(currentRoomCode) : null;
      const actualGameId = gameId || (room ? room.gameId : 'unknown');
      const sender = room ? room.players.find(p => p.socketId === socket.id) : null;
      const playerName = sender ? sender.name : 'anonymous';

      const saved = db.saveGameState(actualGameId, playerName, key, value, currentRoomCode);
      if (typeof callback === 'function') callback({ success: true, saved });
      console.log(`[System Storage] Saved state for game '${actualGameId}', key: '${key}' to host disk!`);
    } catch (err) {
      if (typeof callback === 'function') callback({ error: err.message });
    }
  });

  // In-Game Persistent Storage: Load Game from Host System
  socket.on('game:load_data', ({ gameId, key }, callback) => {
    try {
      const room = currentRoomCode ? activeRooms.get(currentRoomCode) : null;
      const actualGameId = gameId || (room ? room.gameId : 'unknown');
      const sender = room ? room.players.find(p => p.socketId === socket.id) : null;
      const playerName = sender ? sender.name : null;

      const data = db.loadGameState(actualGameId, key, playerName);
      if (typeof callback === 'function') callback({ success: true, data });
    } catch (err) {
      if (typeof callback === 'function') callback({ error: err.message });
    }
  });

  // High Score submission
  socket.on('game:submit_score', ({ gameId, score, metadata }, callback) => {
    try {
      const room = currentRoomCode ? activeRooms.get(currentRoomCode) : null;
      const actualGameId = gameId || (room ? room.gameId : 'unknown');
      const sender = room ? room.players.find(p => p.socketId === socket.id) : null;
      const playerName = sender ? sender.name : 'Guest';

      const rec = db.addScore(actualGameId, playerName, score, metadata);
      if (typeof callback === 'function') callback({ success: true, record: rec });
    } catch (err) {
      if (typeof callback === 'function') callback({ error: err.message });
    }
  });

  // Match Finished
  socket.on('game:over', ({ winnerIndex, stats }) => {
    if (!currentRoomCode) return;
    const room = activeRooms.get(currentRoomCode);
    if (!room) return;

    let winnerName = 'Draw';
    if (typeof winnerIndex === 'number' && room.players[winnerIndex]) {
      winnerName = room.players[winnerIndex].name;
    }

    db.logSession({
      roomCode: currentRoomCode,
      gameId: room.gameId,
      gameTitle: room.gameTitle,
      players: room.players.map(p => ({ name: p.name, isHost: p.isHost })),
      winner: winnerName,
      stats: stats || {},
      endTime: new Date().toISOString()
    });

    io.to(currentRoomCode).emit('room:chat_message', {
      sender: 'System',
      text: `🏆 Match concluded! Winner: ${winnerName}. Results saved to local system storage.`,
      isSystem: true,
      timestamp: Date.now()
    });
  });

  // Chat message
  socket.on('room:chat', ({ text }) => {
    if (!currentRoomCode || !text) return;
    const room = activeRooms.get(currentRoomCode);
    if (!room) return;

    const sender = room.players.find(p => p.socketId === socket.id);
    const msg = {
      sender: sender ? sender.name : 'Player',
      playerIndex: sender ? sender.index : 0,
      text: text.trim().substring(0, 200),
      isSystem: false,
      timestamp: Date.now()
    };

    io.to(currentRoomCode).emit('room:chat_message', msg);
  });

  // Leave room
  socket.on('room:leave', () => {
    handleLeave();
  });

  // Disconnect
  socket.on('disconnect', () => {
    handleLeave();
  });

  function handleLeave() {
    if (!currentRoomCode) return;
    const room = activeRooms.get(currentRoomCode);
    if (!room) return;

    const leavingPlayer = room.players.find(p => p.socketId === socket.id);
    room.players = room.players.filter(p => p.socketId !== socket.id);

    // If Player 2 left in a streaming room, promote next spectator to Player 2
    if (room.type === 'pc-stream') {
      if (socket.id === room.player2SocketId) {
        room.player2SocketId = null;
        const nextP2 = room.players.find(p => !p.isHost);
        if (nextP2) {
          nextP2.role = 'player2';
          room.player2SocketId = nextP2.socketId;
          io.to(nextP2.socketId).emit('stream:role_changed', { role: 'player2' });
        }
      }
      if (room.hostSocketId) {
        io.to(room.hostSocketId).emit('stream:players_updated', { players: room.players });
      }
    }

    // Re-index remaining players
    room.players.forEach((p, idx) => {
      p.index = idx;
    });

    if (room.players.length === 0) {
      activeRooms.delete(currentRoomCode);
      console.log(`[Room Closed] ${currentRoomCode} has no players remaining.`);
    } else {
      // If host left, elect new host
      if (leavingPlayer && leavingPlayer.isHost && room.players.length > 0) {
        room.players[0].isHost = true;
        room.hostSocketId = room.players[0].socketId;
        room.hostPlayerId = room.players[0].id;
      }

      io.to(currentRoomCode).emit('room:updated', sanitizeRoom(room));
      io.to(currentRoomCode).emit('room:chat_message', {
        sender: 'System',
        text: `${leavingPlayer ? leavingPlayer.name : 'A player'} has left the room.`,
        isSystem: true,
        timestamp: Date.now()
      });
    }

    socket.leave(currentRoomCode);
    currentRoomCode = null;
    currentPlayerId = null;
  }
});

function sanitizeRoom(room) {
  return {
    code: room.code,
    gameId: room.gameId,
    gameTitle: room.gameTitle,
    syncMode: room.syncMode,
    folder: room.folder,
    mainFile: room.mainFile,
    maxPlayers: room.maxPlayers,
    status: room.status,
    createdAt: room.createdAt,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      index: p.index,
      isHost: p.isHost,
      isReady: p.isReady
    }))
  };
}

// ==========================================
// NATIVE PC GAME LAUNCHER (C:\Games & Co-Op Games)
// ==========================================
const HOST_GAMES_ROOT = process.env.HOST_GAMES_ROOT || 'C:\\Games';

function cleanFolderPath(p) {
  if (!p) return HOST_GAMES_ROOT;
  let s = String(p).trim();
  s = s.replace(/^["']|["']$/g, '').trim();
  return path.normalize(s);
}

function scoreGameExe(filePath, gameFolderName = '') {
  const low = filePath.toLowerCase();
  const baseName = path.parse(filePath).name.toLowerCase();
  let score = 0;
  if (low.includes('win64')) score += 10;
  if (low.includes('binaries')) score += 5;
  if (gameFolderName && baseName.includes(gameFolderName.toLowerCase().replace(/[^a-z0-9]/g, ''))) score += 15;
  // Penalize or reject cracks/patches/fixes if original exists
  if (low.includes('nodvd') || low.includes('steamfix') || low.includes('crack')) score -= 50;
  return score;
}

function scanGamesInFolder(rawFolder = HOST_GAMES_ROOT) {
  const rootFolder = cleanFolderPath(rawFolder);
  const detected = [];
  if (!fs.existsSync(rootFolder)) {
    console.warn(`[Game Scanner] Folder does not exist: "${rootFolder}"`);
    return detected;
  }

  function findExesInDir(dir, depth = 0) {
    if (depth > 5) return [];
    let exes = [];
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        const lowerName = item.name.toLowerCase();
        if (item.isDirectory()) {
          if (!['redist', '_redist', 'directx', 'support', 'crashreport', 'dotnet', 'nodvd', 'steamfix', 'crack', 'backup'].some(skip => lowerName.includes(skip))) {
            exes = exes.concat(findExesInDir(fullPath, depth + 1));
          }
        } else if (item.isFile() && lowerName.endsWith('.exe')) {
          if (!lowerName.includes('unins') &&
              !lowerName.includes('setup') &&
              !lowerName.includes('quicksfv') &&
              !lowerName.includes('crash') &&
              !lowerName.includes('dxwebsetup') &&
              !lowerName.includes('vcredist') &&
              !lowerName.includes('unitycrashhandler')) {
            exes.push(fullPath);
          }
        }
      }
    } catch (e) {}
    return exes;
  }

  try {
    const entries = fs.readdirSync(rootFolder, { withFileTypes: true });

    // Check if the rootFolder itself is a game folder (has .exe files directly or in subdirs)
    const subDirs = entries.filter(e => e.isDirectory());
    let subDirsWithGames = 0;

    for (const entry of subDirs) {
      const gameDir = path.join(rootFolder, entry.name);
      const exes = findExesInDir(gameDir);
      if (exes.length > 0) {
        subDirsWithGames++;
        exes.sort((a, b) => scoreGameExe(b) - scoreGameExe(a));
        detected.push({
          id: entry.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          title: entry.name,
          folder: entry.name,
          exePath: exes[0],
          allExes: exes,
          installed: true
        });
      }
    }

    // If no subdirectories had games, but this folder itself has executables:
    if (subDirsWithGames === 0) {
      const directExes = findExesInDir(rootFolder);
      if (directExes.length > 0) {
        directExes.sort((a, b) => scoreGameExe(b) - scoreGameExe(a));
        const title = path.basename(rootFolder) || 'Selected Game';
        detected.push({
          id: title.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          title: title,
          folder: title,
          exePath: directExes[0],
          allExes: directExes,
          installed: true
        });
      }
    }
  } catch (err) {
    console.error('Error scanning games folder:', err);
  }
  return detected;
}

app.get('/api/detected-games', (req, res) => {
  const customFolder = cleanFolderPath(req.query.folder || HOST_GAMES_ROOT);
  console.log(`[API /api/detected-games] Scanning folder: "${customFolder}"`);
  const games = scanGamesInFolder(customFolder);
  console.log(`[API /api/detected-games] Found ${games.length} games:`, games.map(g => g.title));
  res.json({ folder: customFolder, games });
});

app.post('/api/launcher/launch', (req, res) => {
  try {
    const { exePath } = req.body;
    let targetExe = exePath;

    if (!targetExe) {
      const scanned = scanGamesInFolder(HOST_GAMES_ROOT);
      if (scanned.length > 0) {
        targetExe = scanned[0].exePath;
      }
    }

    if (!targetExe || !fs.existsSync(targetExe)) {
      return res.status(404).json({ error: `Executable not found: ${targetExe || 'None specified'}` });
    }

    const gameDir = path.dirname(targetExe);
    console.log(`[Launcher] Launching game executable: ${targetExe}`);

    // Launch with Windows shell detached so interactive GUI opens on active desktop
    const { spawn } = require('child_process');
    const child = spawn('cmd.exe', ['/c', 'start', '', targetExe], {
      cwd: gameDir,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    res.json({
      success: true,
      message: `Launched "${path.basename(targetExe)}" on your PC! Check your taskbar or Alt+Tab to view it.`,
      exePath: targetExe
    });
  } catch (err) {
    console.error('Launch error:', err);
    res.status(500).json({ error: 'Failed to launch game: ' + err.message });
  }
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  const localIps = getNetworkAddresses();
  console.log(`\n======================================================`);
  console.log(`🎮 ArcadeNexus Multiplayer Platform is RUNNING!`);
  console.log(`======================================================`);
  console.log(`➜ Local Machine:    http://localhost:${PORT}`);
  localIps.forEach(ip => {
    console.log(`➜ Same Wi-Fi / LAN: http://${ip}:${PORT}`);
  });
  console.log(`➜ System Storage:   ${path.join(__dirname, 'storage')}`);
  console.log(`➜ Games Directory:  ${GAMES_DIR}`);
  console.log(`======================================================\n`);
});
