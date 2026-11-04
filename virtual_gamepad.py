"""
Virtual Xbox 360 Controller Bridge for ArcadeNexus CouchPlay
Reads gamepad JSON state from stdin, injects via ViGEmBus (vgamepad)
Run: python virtual_gamepad.py
Requires: pip install vgamepad  (and ViGEmBus driver installed)
"""

import sys
import json
import time

try:
    import vgamepad as vg
except ImportError:
    print("ERROR: vgamepad not installed. Run: pip install vgamepad", flush=True)
    sys.exit(1)

try:
    gamepad = vg.VX360Gamepad()
    print("READY: Virtual Xbox 360 Controller active!", flush=True)
except Exception as e:
    print(f"ERROR: Could not create virtual gamepad: {e}", flush=True)
    print("Make sure ViGEmBus driver is installed.", flush=True)
    sys.exit(1)

DEADZONE = 0.12

def clamp(val, lo=-1.0, hi=1.0):
    return max(lo, min(hi, val))

def apply_state(state):
    try:
        gamepad.reset()

        # --- Left Stick Axes ---
        ax = clamp(float(state.get("axesX", 0)))
        ay = clamp(float(state.get("axesY", 0)))
        if abs(ax) > DEADZONE or abs(ay) > DEADZONE:
            gamepad.left_joystick_float(x_value_float=ax, y_value_float=-ay)  # Y axis is inverted

        # --- Right Stick Axes ---
        rx = clamp(float(state.get("axesRX", 0)))
        ry = clamp(float(state.get("axesRY", 0)))
        if abs(rx) > DEADZONE or abs(ry) > DEADZONE:
            gamepad.right_joystick_float(x_value_float=rx, y_value_float=-ry)

        # --- D-Pad ---
        if state.get("dpadUp"):    gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP)
        if state.get("dpadDown"):  gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN)
        if state.get("dpadLeft"):  gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT)
        if state.get("dpadRight"): gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT)

        # --- Face Buttons ---
        if state.get("btnA"): gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_A)
        if state.get("btnB"): gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_B)
        if state.get("btnX"): gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_X)
        if state.get("btnY"): gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_Y)

        # --- Shoulder Buttons ---
        if state.get("lb"):    gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER)
        if state.get("rb"):    gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER)

        # --- Triggers (analog) ---
        lt = clamp(float(state.get("lt", 0)), 0.0, 1.0)
        rt = clamp(float(state.get("rt", 0)), 0.0, 1.0)
        if lt > 0.05: gamepad.left_trigger_float(value_float=lt)
        if rt > 0.05: gamepad.right_trigger_float(value_float=rt)

        # --- Menu / Start / Select ---
        if state.get("start"):  gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_START)
        if state.get("select"): gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK)

        # --- Thumbstick Clicks ---
        if state.get("ls"): gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB)
        if state.get("rs"): gamepad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB)

        gamepad.update()
    except Exception as e:
        print(f"WARNING: apply_state error: {e}", flush=True)

print("LISTENING: Reading gamepad state from stdin (one JSON per line)...", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        state = json.loads(line)
        apply_state(state)
    except json.JSONDecodeError:
        pass
    except KeyboardInterrupt:
        break

# Release all inputs cleanly on exit
try:
    gamepad.reset()
    gamepad.update()
except:
    pass
print("STOPPED: Virtual gamepad released.", flush=True)

