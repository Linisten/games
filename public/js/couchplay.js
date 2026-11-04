/**
 * CouchPlay: PC Game Co-Op Remote Streaming & Virtual Joystick Relay
 * Handles 60 FPS WebRTC Video/Audio Streaming, ICE Queueing, Dynamic Renegotiation,
 * and Ultra-Low Latency Gamepad Input Relay.
 */

class CouchPlayManager {
  constructor() {
    this.peerConnection = null;
    this.dataChannel = null;
    this.localStream = null;
    this.isHost = false;
    this.roomCode = null;
    this.guestSocketId = null;
    this.gamepadPollTimer = null;
    this.activeGamepadIndex = null;
    this.iceCandidateQueue = [];
    this.isRemoteDescriptionSet = false;

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ]
    };

    // Default It Takes Two Controls (Player 2)
    this.customKeyMap = {
      up: 38,    // ArrowUp
      down: 40,  // ArrowDown
      left: 37,  // ArrowLeft
      right: 39, // ArrowRight
      btnA: 13,  // Enter (Jump / Confirm)
      btnB: 81,  // Q (Cancel / Crouch)
      btnX: 16,  // Right Shift (Dash / Action)
      btnY: 69,  // E (Interact)
      lb: 90,    // Z
      rb: 88,    // X
      start: 27  // Escape
    };

    this._setupGamepadEvents();
  }

  _setupGamepadEvents() {
    window.addEventListener('gamepadconnected', (e) => {
      console.log('🎮 [CouchPlay] Gamepad connected:', e.gamepad.id);
      this.activeGamepadIndex = e.gamepad.index;
      if (window.showToast) window.showToast(`Joystick Connected: ${e.gamepad.id.substring(0, 24)}`, '🎮');
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      console.log('🎮 [CouchPlay] Gamepad disconnected:', e.gamepad.id);
      if (this.activeGamepadIndex === e.gamepad.index) {
        this.activeGamepadIndex = null;
      }
    });
  }

  // ========================================================
  // HOST METHODS
  // ========================================================

  async createHostStream(gameName, hostName) {
    this.isHost = true;
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Socket not connected'));

      socket.emit('stream:create', { gameName, hostName }, async (res) => {
        if (res.error) return reject(new Error(res.error));
        this.roomCode = res.roomCode;
        resolve(res.roomCode);
      });
    });
  }

  async startScreenCapture() {
    try {
      this.localStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      const hostPreview = document.getElementById('host-stream-preview');
      if (hostPreview) {
        hostPreview.srcObject = this.localStream;
        hostPreview.play().catch(() => {});
      }

      // If peer connections already exist (guests joined earlier), attach tracks to all of them!
      if (!this.peers) this.peers = new Map();
      if (this.peerConnection) this.peers.set(this.guestSocketId || 'primary', this.peerConnection);

      for (const [guestId, pc] of this.peers.entries()) {
        this.localStream.getTracks().forEach(track => {
          const senders = pc.getSenders();
          const exists = senders.some(s => s.track && s.track.kind === track.kind);
          if (!exists) {
            pc.addTrack(track, this.localStream);
          }
        });
        await this.sendOfferToGuest(guestId, pc);
      }

      this.localStream.getVideoTracks()[0].onended = () => {
        console.log('[CouchPlay] Screen share stopped');
        if (typeof stopHostStream === 'function') {
          stopHostStream();
        } else {
          this.stopStream();
        }
      };

      return true;
    } catch (err) {
      console.error('[CouchPlay] Screen capture error:', err);
      throw err;
    }
  }

  setupHostPeer(guestSocketId, isPlayer2 = true) {
    if (!this.peers) this.peers = new Map();

    const existing = this.peers.get(guestSocketId);
    if (existing) {
      try { existing.close(); } catch(e) {}
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(guestSocketId, pc);
    this.peerConnection = pc; // for backwards compatibility
    this.guestSocketId = guestSocketId;

    // Attach stream tracks if already sharing
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        try {
          pc.addTrack(track, this.localStream);
        } catch(e) {}
      });
    }

    // High-speed DataChannel for joystick inputs (ONLY for Player 2, spectators cannot control)
    if (isPlayer2) {
      this.dataChannel = pc.createDataChannel('joystick', {
        ordered: false,
        maxRetransmits: 0
      });

      this.dataChannel.onopen = () => {
        console.log('✓ [CouchPlay] Player 2 Joystick DataChannel OPEN!');
      };

      this.dataChannel.onmessage = (event) => {
        try {
          const state = JSON.parse(event.data);
          this.onGuestJoystickInput(state);
        } catch (e) {}
      };
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('stream:signal', {
          roomCode: this.roomCode,
          targetSocketId: guestSocketId,
          signal: { candidate: event.candidate }
        });
      }
    };

    // Send initial offer
    this.sendOfferToGuest(guestSocketId, pc);
  }

  async sendOfferToGuest(targetSocketId, pcInstance) {
    const pc = pcInstance || (this.peers && this.peers.get(targetSocketId)) || this.peerConnection;
    if (!pc) return;
    try {
      const offer = await pc.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false
      });
      await pc.setLocalDescription(offer);

      socket.emit('stream:signal', {
        roomCode: this.roomCode,
        targetSocketId: targetSocketId,
        signal: { sdp: pc.localDescription }
      });
    } catch(err) {
      console.error('[CouchPlay] Error creating offer:', err);
    }
  }

  onGuestJoystickInput(state) {
    if (socket) {
      socket.emit('stream:gamepad_input', {
        roomCode: this.roomCode,
        gamepadState: state,
        customMapping: this.customKeyMap
      });
    }
  }

  // ========================================================
  // GUEST METHODS
  // ========================================================

  async joinGuestStream(roomCode, guestName) {
    this.isHost = false;
    this.roomCode = roomCode.trim().toUpperCase();

    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Socket not connected'));

      socket.emit('stream:join', { roomCode: this.roomCode, guestName }, (res) => {
        if (res.error) return reject(new Error(res.error));
        this.setupGuestPeer();
        this.startGamepadPoll();
        resolve(res);
      });
    });
  }

  setupGuestPeer() {
    this.isRemoteDescriptionSet = false;
    this.iceCandidateQueue = [];

    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch(e) {}
    }

    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    // Receive Host's 60 FPS video & audio track
    this.peerConnection.ontrack = (event) => {
      console.log('✓ [CouchPlay] Received media stream from Host!', event.track.kind);
      const guestVideo = document.getElementById('guest-remote-video');
      const waitingScreen = document.getElementById('guest-waiting-host');

      // Hide waiting screen as soon as host video arrives!
      if (waitingScreen) {
        waitingScreen.style.display = 'none';
      }

      if (guestVideo) {
        if (event.receiver && 'playoutDelayHint' in event.receiver) {
          event.receiver.playoutDelayHint = 0; // 0 buffer lag
        }
        guestVideo.srcObject = event.streams[0];
        guestVideo.muted = false;

        const playPromise = guestVideo.play();
        if (playPromise) {
          playPromise.catch(e => {
            console.warn('Autoplay with sound needs user interaction, falling back to muted play');
            guestVideo.muted = true;
            guestVideo.play().catch(() => {});

            // Show unmute prompt on screen
            const unmuteOverlay = document.getElementById('play-sound-overlay');
            if (unmuteOverlay) unmuteOverlay.style.display = 'flex';
          });
        }
      }
    };

    // Listen for Joystick DataChannel
    this.peerConnection.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.dataChannel.onopen = () => {
        console.log('✓ [CouchPlay] Guest Joystick DataChannel CONNECTED directly to Host!');
        const st = document.getElementById('guest-joystick-status');
        if (st) st.innerText = 'Connected: Joystick active as Player 2';
      };
    };

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('stream:signal', {
          roomCode: this.roomCode,
          signal: { candidate: event.candidate }
        });
      }
    };
  }

  async handleSignal(signal, fromSocketId) {
    const pc = (this.peers && fromSocketId && this.peers.get(fromSocketId)) || this.peerConnection;
    if (!pc) return;

    if (signal.sdp) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        this.isRemoteDescriptionSet = true;
        console.log('✓ [CouchPlay] Remote Description set successfully');

        // Flush queued ICE candidates
        while (this.iceCandidateQueue.length > 0) {
          const cand = this.iceCandidateQueue.shift();
          try {
            await pc.addIceCandidate(cand);
          } catch(e) {}
        }

        if (signal.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          socket.emit('stream:signal', {
            roomCode: this.roomCode,
            targetSocketId: fromSocketId,
            signal: { sdp: pc.localDescription }
          });
          console.log('✓ [CouchPlay] Sent SDP Answer to Host');
        }
      } catch(err) {
        console.error('[CouchPlay Signal Error]:', err);
      }
    } else if (signal.candidate) {
      const cand = new RTCIceCandidate(signal.candidate);
      if (this.isRemoteDescriptionSet) {
        try {
          await pc.addIceCandidate(cand);
        } catch(e) {}
      } else {
        this.iceCandidateQueue.push(cand);
      }
    }
  }

  // ========================================================
  // JOYSTICK / GAMEPAD ENGINE
  // ========================================================

  startGamepadPoll() {
    if (this.gamepadPollTimer) clearInterval(this.gamepadPollTimer);

    const DEADZONE = 0.18;

    this.gamepadPollTimer = setInterval(() => {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp = null;

      if (this.activeGamepadIndex !== null && gamepads[this.activeGamepadIndex]) {
        gp = gamepads[this.activeGamepadIndex];
      } else {
        for (let i = 0; i < gamepads.length; i++) {
          if (gamepads[i]) { gp = gamepads[i]; break; }
        }
      }

      if (!gp) return;

      const ax  = Math.abs(gp.axes[0]) > DEADZONE ? gp.axes[0] : 0;
      const ay  = Math.abs(gp.axes[1]) > DEADZONE ? gp.axes[1] : 0;
      const rx  = gp.axes.length > 2 ? (Math.abs(gp.axes[2]) > DEADZONE ? gp.axes[2] : 0) : 0;
      const ry  = gp.axes.length > 3 ? (Math.abs(gp.axes[3]) > DEADZONE ? gp.axes[3] : 0) : 0;
      const b = gp.buttons;

      const state = {
        axesX:    Number(ax.toFixed(3)),
        axesY:    Number(ay.toFixed(3)),
        axesRX:   Number(rx.toFixed(3)),
        axesRY:   Number(ry.toFixed(3)),
        // Triggers (analog 0-1)
        lt: b[6]  ? Number((b[6].value  || 0).toFixed(3)) : 0,
        rt: b[7]  ? Number((b[7].value  || 0).toFixed(3)) : 0,
        // D-pad
        dpadUp:    Boolean(b[12] && b[12].pressed),
        dpadDown:  Boolean(b[13] && b[13].pressed),
        dpadLeft:  Boolean(b[14] && b[14].pressed),
        dpadRight: Boolean(b[15] && b[15].pressed),
        // Face buttons
        btnA: Boolean(b[0]  && b[0].pressed),  // Cross / A
        btnB: Boolean(b[1]  && b[1].pressed),  // Circle / B
        btnX: Boolean(b[2]  && b[2].pressed),  // Square / X
        btnY: Boolean(b[3]  && b[3].pressed),  // Triangle / Y
        // Shoulders
        lb: Boolean(b[4] && b[4].pressed),
        rb: Boolean(b[5] && b[5].pressed),
        // Thumbsticks
        ls: Boolean(b[10] && b[10].pressed),
        rs: Boolean(b[11] && b[11].pressed),
        // Menu
        select: Boolean(b[8]  && b[8].pressed),
        start:  Boolean(b[9]  && b[9].pressed)
      };

      // Send via WebRTC DataChannel (sub-millisecond UDP), with fallback to WebSocket
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify(state));
      } else if (socket && socket.connected && this.roomCode) {
        socket.emit('stream:gamepad_input', {
          roomCode: this.roomCode,
          gamepadState: state,
          customMapping: this.customKeyMap
        });
      }
    }, 16); // 60 FPS input sampling
  }

  stopStream() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch(e) {}
      this.peerConnection = null;
    }
    if (this.gamepadPollTimer) {
      clearInterval(this.gamepadPollTimer);
      this.gamepadPollTimer = null;
    }
  }
}

window.CouchPlay = new CouchPlayManager();
