/**
 * ArcadeNexus Input Injector
 * Primary: Python vgamepad (ViGEmBus XInput virtual Xbox 360 controller)
 * Fallback: Win32 keyboard scan-code injector (injector.exe)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class WindowsInputInjector {
  constructor() {
    // Virtual gamepad (Python vgamepad via ViGEmBus)
    this.vgProcess = null;
    this.vgReady = false;

    // Win32 key injector fallback
    this.kbProcess = null;
    this.kbReady = false;

    this.exePath = path.join(__dirname, 'injector.exe');
    this.pyPath  = path.join(__dirname, 'virtual_gamepad.py');

    this._startVirtualGamepad();
    this._startKeyboardInjector();
  }

  // ----------------------------------------------------------------
  // Virtual Xbox 360 controller via ViGEmBus (vgamepad Python lib)
  // ----------------------------------------------------------------
  _startVirtualGamepad() {
    if (!fs.existsSync(this.pyPath)) {
      console.warn('[VirtualGamepad] virtual_gamepad.py not found, skipping.');
      return;
    }

    try {
      this.vgProcess = spawn('python', [this.pyPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.vgProcess.stdout.on('data', (data) => {
        const text = data.toString().trim();
        if (text.includes('READY')) {
          this.vgReady = true;
          console.log('✓ [VirtualGamepad] Virtual Xbox 360 Controller is READY via ViGEmBus!');
        }
        if (text.includes('ERROR')) {
          console.warn('[VirtualGamepad]', text);
        }
      });

      this.vgProcess.stderr.on('data', (data) => {
        const txt = data.toString().trim();
        if (txt) console.warn('[VirtualGamepad stderr]', txt);
      });

      this.vgProcess.on('close', (code) => {
        console.log('[VirtualGamepad] Process exited with code', code);
        this.vgReady = false;
      });

    } catch (err) {
      console.error('[VirtualGamepad] Failed to start virtual_gamepad.py:', err.message);
    }
  }

  // ----------------------------------------------------------------
  // Win32 keyboard scan-code injector (fallback)
  // ----------------------------------------------------------------
  _startKeyboardInjector() {
    if (!fs.existsSync(this.exePath)) {
      console.warn('[InputInjector] injector.exe not found, keyboard fallback disabled.');
      return;
    }

    try {
      this.kbProcess = spawn(this.exePath, [], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.kbProcess.stdout.on('data', (data) => {
        const text = data.toString().trim();
        if (text.includes('COUCHPLAY_INJECTOR_READY')) {
          this.kbReady = true;
          console.log('✓ [InputInjector] Windows Native Hardware Scan-code Injector is READY');
        }
      });

      this.kbProcess.stderr.on('data', (data) => {
        console.error('[InputInjector Error]:', data.toString());
      });

      this.kbProcess.on('close', (code) => {
        this.kbReady = false;
      });

      this.kbProcess.stdin.write('PING\n');
    } catch (err) {
      console.error('[InputInjector] Failed to start injector.exe:', err.message);
    }
  }

  // ----------------------------------------------------------------
  // Public API: inject gamepad state
  // ----------------------------------------------------------------

  /**
   * Injects the guest's gamepad state.
   * Uses virtual XInput controller if ViGEmBus is available,
   * otherwise falls back to keyboard scan-codes.
   */
  injectGamepadState(gamepadState, mapping = null) {
    if (!gamepadState) return;

    if (this.vgReady && this.vgProcess && this.vgProcess.stdin.writable) {
      // Send raw state JSON to Python virtual gamepad (XInput)
      try {
        this.vgProcess.stdin.write(JSON.stringify(gamepadState) + '\n');
      } catch (e) {
        console.error('[VirtualGamepad] Write error:', e.message);
      }
    } else {
      // Fallback: keyboard scan-codes
      this._injectKeyboardFallback(gamepadState, mapping);
    }
  }

  /**
   * Keyboard fallback mapping (used when ViGEmBus not available)
   */
  _injectKeyboardFallback(gamepadState, mapping = null) {
    const defaultMapping = {
      up: 38,    // ArrowUp
      down: 40,  // ArrowDown
      left: 37,  // ArrowLeft
      right: 39, // ArrowRight
      btnA: 13,  // Enter
      btnB: 16,  // Shift
      btnX: 90,  // Z
      btnY: 88,  // X
      lb: 81,    // Q
      rb: 69,    // E
      start: 27  // Escape
    };

    const map = mapping || defaultMapping;

    const isUp    = (gamepadState.dpadUp    || gamepadState.axesY < -0.45);
    const isDown  = (gamepadState.dpadDown  || gamepadState.axesY >  0.45);
    const isLeft  = (gamepadState.dpadLeft  || gamepadState.axesX < -0.45);
    const isRight = (gamepadState.dpadRight || gamepadState.axesX >  0.45);

    this.sendKey(map.up, isUp);
    this.sendKey(map.down, isDown);
    this.sendKey(map.left, isLeft);
    this.sendKey(map.right, isRight);

    if (map.btnA)  this.sendKey(map.btnA,  Boolean(gamepadState.btnA));
    if (map.btnB)  this.sendKey(map.btnB,  Boolean(gamepadState.btnB));
    if (map.btnX)  this.sendKey(map.btnX,  Boolean(gamepadState.btnX));
    if (map.btnY)  this.sendKey(map.btnY,  Boolean(gamepadState.btnY));
    if (map.lb)    this.sendKey(map.lb,    Boolean(gamepadState.lb));
    if (map.rb)    this.sendKey(map.rb,    Boolean(gamepadState.rb));
    if (map.start) this.sendKey(map.start, Boolean(gamepadState.start));
  }

  /** Send virtual key code via Win32 injector */
  sendKey(vkCode, isDown) {
    if (!this.kbProcess || !this.kbProcess.stdin.writable) return;
    const cmd = `KEY ${vkCode} ${isDown ? 'DOWN' : 'UP'}\n`;
    try {
      this.kbProcess.stdin.write(cmd);
    } catch (e) {
      console.error('[InputInjector] Write error:', e.message);
    }
  }

  get isReady() {
    return this.vgReady || this.kbReady;
  }

  stop() {
    if (this.vgProcess) {
      try { this.vgProcess.stdin.end(); this.vgProcess.kill(); } catch (e) {}
    }
    if (this.kbProcess) {
      try { this.kbProcess.stdin.write('EXIT\n'); this.kbProcess.kill(); } catch (e) {}
    }
  }
}

module.exports = new WindowsInputInjector();
