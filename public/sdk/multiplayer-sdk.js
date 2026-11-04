/**
 * ArcadeNexus Multiplayer SDK
 * Easily add real-time multiplayer & host-local data storage to any web game.
 */
(function(window) {
  'use strict';

  class MultiplayerBridge {
    constructor() {
      this.isIframe = window.parent && window.parent !== window;
      this.player = {
        id: 'p_' + Math.random().toString(36).substring(2, 8),
        name: 'Player',
        index: 0,
        isHost: true
      };
      this.players = [this.player];
      this.roomCode = 'LOCAL';
      this.gameId = 'unknown';
      this.handlers = new Map();
      this.inputHandlers = [];
      this.pendingRequests = new Map();
      this.requestIdCounter = 1;
      this.ready = false;

      this._setupListeners();
      this._requestHandshake();
    }

    _setupListeners() {
      window.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || typeof msg !== 'object' || msg.source !== 'NEXUS_PLATFORM') return;

        switch (msg.type) {
          case 'HANDSHAKE':
            this.player = msg.player || this.player;
            this.players = msg.players || [this.player];
            this.roomCode = msg.roomCode || this.roomCode;
            this.gameId = msg.gameId || this.gameId;
            this.ready = true;
            this._trigger('connect', {
              player: this.player,
              players: this.players,
              roomCode: this.roomCode
            });
            break;

          case 'PLAYERS_UPDATE':
            this.players = msg.players;
            const updatedMe = this.players.find(p => p.id === this.player.id);
            if (updatedMe) {
              this.player = updatedMe;
            }
            this._trigger('players', this.players);
            break;

          case 'GAME_EVENT':
            this._trigger(msg.event, msg.data, msg.fromPlayer);
            break;

          case 'PLAYER_INPUT':
            for (const handler of this.inputHandlers) {
              handler(msg.playerIndex, msg.input, msg.fromPlayer);
            }
            break;

          case 'RESPONSE':
            if (msg.requestId && this.pendingRequests.has(msg.requestId)) {
              const { resolve, reject } = this.pendingRequests.get(msg.requestId);
              this.pendingRequests.delete(msg.requestId);
              if (msg.error) reject(new Error(msg.error));
              else resolve(msg.data);
            }
            break;

          case 'CHAT':
            this._trigger('chat', msg.data);
            break;
        }
      });
    }

    _requestHandshake() {
      if (this.isIframe) {
        window.parent.postMessage({
          source: 'NEXUS_GAME',
          type: 'READY_QUERY'
        }, '*');
      }
    }

    _sendToPlatform(type, payload = {}) {
      if (!this.isIframe) {
        console.warn('[Multiplayer SDK] Not running inside platform iframe. Running in offline/solo mode.');
        return Promise.resolve(null);
      }
      const requestId = 'req_' + (this.requestIdCounter++);
      return new Promise((resolve, reject) => {
        this.pendingRequests.set(requestId, { resolve, reject });
        window.parent.postMessage({
          source: 'NEXUS_GAME',
          type,
          requestId,
          ...payload
        }, '*');

        // Timeout fallback after 8 seconds
        setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            resolve(null);
          }
        }, 8000);
      });
    }

    _trigger(event, data, sender) {
      if (this.handlers.has(event)) {
        for (const fn of this.handlers.get(event)) {
          try {
            fn(data, sender);
          } catch (err) {
            console.error(`[Multiplayer SDK] Error in handler for '${event}':`, err);
          }
        }
      }
    }

    /**
     * Subscribe to game events or platform lifecycle events
     * Events: 'connect', 'players', 'chat', or any custom event name
     */
    on(event, callback) {
      if (!this.handlers.has(event)) {
        this.handlers.set(event, []);
      }
      this.handlers.get(event).push(callback);
      return this;
    }

    off(event, callback) {
      if (!this.handlers.has(event)) return this;
      if (!callback) {
        this.handlers.delete(event);
      } else {
        const list = this.handlers.get(event).filter(fn => fn !== callback);
        this.handlers.set(event, list);
      }
      return this;
    }

    /**
     * Broadcast an event to other players in the room
     * @param {string} event - Event name
     * @param {any} data - Serializable payload
     * @param {number|null} targetPlayerIndex - Optional target player index (null = all others)
     */
    send(event, data, targetPlayerIndex = null) {
      this._sendToPlatform('SEND_EVENT', {
        event,
        data,
        targetPlayerIndex
      });
    }

    /**
     * Send input state (keys, joystick, actions) to synchronize player controls
     * @param {object} inputState - E.g. { up: true, fire: false, angle: 1.45 }
     */
    syncInput(inputState) {
      this._sendToPlatform('SYNC_INPUT', {
        input: inputState
      });
    }

    /**
     * Register a callback for incoming player inputs
     */
    onInput(callback) {
      this.inputHandlers.push(callback);
      return this;
    }

    /**
     * Save data persistently to the HOST's computer storage
     * @param {string} key - Unique key for this game's state (e.g. 'checkpoint_1', 'campaign')
     * @param {any} value - Object or serializable data
     */
    async saveData(key, value) {
      return this._sendToPlatform('SAVE_DATA', {
        key,
        value
      });
    }

    /**
     * Load data persistently from the HOST's computer storage
     * @param {string} key - Unique key to retrieve
     */
    async loadData(key) {
      return this._sendToPlatform('LOAD_DATA', {
        key
      });
    }

    /**
     * Submit score to the HOST's system leaderboard
     * @param {number} score - High score or points
     * @param {object} metadata - Details like kills, level, playtime
     */
    async submitScore(score, metadata = {}) {
      return this._sendToPlatform('SUBMIT_SCORE', {
        score,
        metadata
      });
    }

    /**
     * Signal that the game is over and record results to system history
     * @param {number|string} winnerIndex - Index of winning player, or 'draw'
     * @param {object} stats - Optional match stats
     */
    gameOver(winnerIndex, stats = {}) {
      this._sendToPlatform('GAME_OVER', {
        winnerIndex,
        stats
      });
    }

    /**
     * Send text chat into the room overlay
     */
    chat(message) {
      this._sendToPlatform('SEND_CHAT', {
        message
      });
    }

    /**
     * Get current local player information
     */
    getPlayer() {
      return this.player;
    }

    /**
     * Get list of all players in current room
     */
    getPlayers() {
      return this.players;
    }

    /**
     * Check if this player is the room host (Player 1)
     */
    isHost() {
      return Boolean(this.player.isHost);
    }
  }

  // Attach global instance
  window.Multiplayer = new MultiplayerBridge();
  window.MultiplayerBridge = MultiplayerBridge;

})(window);

