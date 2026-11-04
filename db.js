const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'storage', 'data', 'database.json');
const STORAGE_DIR = path.join(__dirname, 'storage');

// Initial schema
const defaultState = {
  games: [],
  saves: [],
  scores: [],
  sessions: [],
  settings: {
    platformName: "ArcadeNexus Multiplayer",
    allowPublicUploads: true,
    created: new Date().toISOString()
  }
};

class Database {
  constructor() {
    this.data = defaultState;
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DB_FILE)) {
        this.writeSync(defaultState);
      } else {
        const content = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(content);
        // Ensure all collections exist
        for (const key of Object.keys(defaultState)) {
          if (!this.data[key]) {
            this.data[key] = defaultState[key];
          }
        }
      }
    } catch (err) {
      console.error('Error initializing database, recreating default state:', err);
      this.data = defaultState;
      this.writeSync(this.data);
    }
  }

  writeSync(data) {
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
  }

  save() {
    this.writeSync(this.data);
  }

  // Games
  getGames() {
    return this.data.games;
  }

  getGame(id) {
    return this.data.games.find(g => g.id === id);
  }

  addGame(game) {
    this.data.games = this.data.games.filter(g => g.id !== game.id);
    this.data.games.push(game);
    this.save();
    return game;
  }

  updateGame(id, updates) {
    const game = this.getGame(id);
    if (!game) return null;
    Object.assign(game, updates);
    this.save();
    return game;
  }

  deleteGame(id) {
    const idx = this.data.games.findIndex(g => g.id === id);
    if (idx !== -1) {
      const removed = this.data.games.splice(idx, 1)[0];
      this.save();
      return removed;
    }
    return null;
  }

  // Game Save State (Saved directly on host's machine)
  saveGameState(gameId, player, key, stateData, roomCode = null) {
    const existingIdx = this.data.saves.findIndex(
      s => s.gameId === gameId && s.key === key && (s.player === player || !player)
    );

    const record = {
      id: `${gameId}_${key}_${Date.now()}`,
      gameId,
      player: player || 'anonymous',
      roomCode: roomCode || null,
      key,
      data: stateData,
      updatedAt: new Date().toISOString()
    };

    if (existingIdx !== -1) {
      this.data.saves[existingIdx] = record;
    } else {
      this.data.saves.push(record);
    }
    this.save();
    return record;
  }

  loadGameState(gameId, key, player = null) {
    const matches = this.data.saves.filter(s => s.gameId === gameId && s.key === key);
    if (player) {
      const playerMatch = matches.find(s => s.player === player);
      if (playerMatch) return playerMatch.data;
    }
    return matches.length > 0 ? matches[matches.length - 1].data : null;
  }

  listGameSaves(gameId = null) {
    if (!gameId) return this.data.saves;
    return this.data.saves.filter(s => s.gameId === gameId);
  }

  deleteSave(id) {
    const idx = this.data.saves.findIndex(s => s.id === id);
    if (idx !== -1) {
      this.data.saves.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
  }

  // High Scores & Leaderboards
  addScore(gameId, player, score, meta = {}) {
    const record = {
      id: `score_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      gameId,
      player: player || 'Guest Player',
      score: Number(score) || 0,
      meta,
      createdAt: new Date().toISOString()
    };
    this.data.scores.push(record);
    // Keep top 100 per game
    this.data.scores.sort((a, b) => b.score - a.score);
    this.save();
    return record;
  }

  getScores(gameId, limit = 20) {
    return this.data.scores
      .filter(s => s.gameId === gameId)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Session Logs
  logSession(session) {
    const record = {
      id: `sess_${Date.now()}`,
      ...session,
      loggedAt: new Date().toISOString()
    };
    this.data.sessions.unshift(record);
    if (this.data.sessions.length > 500) {
      this.data.sessions = this.data.sessions.slice(0, 500);
    }
    this.save();
    return record;
  }

  getSessions(limit = 50) {
    return this.data.sessions.slice(0, limit);
  }

  // Storage summary info
  getStorageStats() {
    let gamesDirSize = 0;
    try {
      const getDirSize = (dirPath) => {
        let size = 0;
        if (!fs.existsSync(dirPath)) return 0;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            size += getDirSize(fullPath);
          } else if (entry.isFile()) {
            size += fs.statSync(fullPath).size;
          }
        }
        return size;
      };
      gamesDirSize = getDirSize(path.join(STORAGE_DIR, 'games'));
    } catch (e) {
      console.error('Error calculating dir size:', e);
    }

    return {
      totalGames: this.data.games.length,
      totalSaves: this.data.saves.length,
      totalScores: this.data.scores.length,
      totalSessions: this.data.sessions.length,
      gamesDiskSizeBytes: gamesDirSize,
      gamesDiskSizeReadable: (gamesDirSize / (1024 * 1024)).toFixed(2) + ' MB',
      dbFilePath: DB_FILE
    };
  }

  wipeAll() {
    this.data.saves = [];
    this.data.scores = [];
    this.data.sessions = [];
    this.save();
  }
}

module.exports = new Database();

