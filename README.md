# ArcadeNexus Multiplayer & Remote Couch Co-Op Platform

A self-hosted gaming and remote play platform that allows you to play **local offline co-op & cracked PC games** (like *It Takes Two*, *A Way Out*, *Cuphead*, *Overcooked*, etc.) and **custom uploaded web games** from two different places.

### Core Highlights
- 💻 **Game Runs Exclusively on Your PC (Host)**: The game executable and files stay 100% on your system.
- 💾 **All Progress & Saves Kept on Your System**: Checkpoints, saves, and campaign data are saved in your local Windows profile (`%LOCALAPPDATA%\ItTakesTwo\` or `%APPDATA%`).
- 🚀 **Zero Downloads for Player 2 (Guest)**: Player 2 joins with just a **Room Code** in any browser (Chrome, Edge, Firefox, Safari) on their PC, laptop, or phone.
- 🎮 **Virtual Joystick Relay**: Player 2 plugs their joystick into their own computer. Our platform captures their sticks and buttons at 60Hz and injects them into Windows as **Player 2 Controller**!
- ⚡ **60 FPS Ultra-Low Latency Streaming**: WebRTC hardware-accelerated direct peer-to-peer video & audio streaming (<30ms).

---

## Quick Start Guide

### 1. Start the Platform Server
Double-click `start-server.bat` or run in terminal:
```bash
npm start
# or
node server.js
```
The server will output:
- **Local Dashboard:** `http://localhost:3000`
- **Wi-Fi / LAN Address:** `http://192.168.1.3:3000` (for devices on the same network)

---

## Playing "It Takes Two" Online from Two Different Systems

### Step 1: On Your PC (Host)
1. Open your browser and go to `http://localhost:3000`.
2. Click **"Play It Takes Two Online"** or go to the **Couch Co-Op Stream** tab.
3. You will see the banner: **"Installed Game Detected: It Takes Two"**.
4. Click **"🚀 Launch It Takes Two"** (or open the game normally from `storage\games\It Takes Two\Nuts\Binaries\Win64\ItTakesTwo.exe`).
5. Click **"1. Create Room Code"** &mdash; this generates your unique 5-character room code (e.g., `X7K9P`).
6. Click **"2. Select Game Window & Share Audio"** &mdash; select the *It Takes Two* window (ensure **"Share system audio"** is checked).

### Step 2: On Your Friend's Computer (Player 2)
1. Your friend opens their browser and navigates to your room link:
   - **Same Wi-Fi / LAN:** `http://192.168.1.3:3000/stream/X7K9P`
   - **Over the Internet:** Use the Cloudflare/ngrok public link (see below).
2. Your friend plugs in their joystick (Xbox controller, PS4/PS5 controller, Nintendo Switch Pro controller, or generic USB gamepad).
3. The on-screen controller diagram lights up to confirm their joystick is active.
4. Your friend clicks **"Connect to Host Stream"**.

### Step 3: Play Together!
- Your friend now sees *It Takes Two* at 60 FPS with full game sound.
- When your friend moves their analog stick or presses buttons, our native Windows hardware scan-code injector (`injector.exe`) injects the inputs into *It Takes Two* on your computer as **Player 2**!
- In the game menu, Player 2 presses **Enter / A** to join the lobby, select **Cody & May**, and start your adventure!

---

## Playing Across the Internet (Different Houses)

If your friend is at another house, you can make your server accessible across the internet in seconds using free tunnels:

### Option A: Cloudflare Tunnel (Free, no account needed)
```bash
npx cloudflared tunnel --url http://localhost:3000
```
It gives you a free HTTPS link (e.g. `https://xyz-random.trycloudflare.com`) that your friend can open from anywhere!

### Option B: Localtunnel (Instant)
```bash
npx localtunnel --port 3000
```

---

## Default Controls for It Takes Two (Player 2)

| Gamepad Button | Win32 Scan-Code | Keyboard Fallback | Action in It Takes Two |
|----------------|-----------------|-------------------|------------------------|
| Left Stick / D-Pad | Arrow Keys (37-40) | $\leftarrow \uparrow \downarrow \rightarrow$ | Movement |
| Button A (Cross) | Enter (13) | `Enter` | Jump / Confirm |
| Button B (Circle) | Key Q (81) | `Q` | Crouch / Cancel |
| Button X (Square) | Right Shift (16) | `Right Shift` | Dash / Action |
| Button Y (Triangle) | Key E (69) | `E` | Primary Interact |
| Shoulder LB / RB | Z / X (90 / 88) | `Z` / `X` | Special abilities |
| Start Button | Escape (27) | `Esc` | Pause / Menu |

*You can also customize these key assignments anytime in the Couch Co-Op Settings tab.*

---

## File Structure & Storage

```
c:\Users\slini\multi\
├── server.js              # Express + Socket.IO WebRTC signaling & storage engine
├── injector.exe           # Win32 hardware scan-code DirectInput injector
├── input_injector.js      # Node.js bridge to injector.exe
├── start-server.bat       # 1-Click launcher
├── public/                # Frontend application
│   ├── index.html         # Main app (CouchPlay, Library, Uploader, Storage Explorer)
│   ├── css/style.css      # Dark gamer aesthetic styling
│   └── js/
│       ├── couchplay.js   # 60 FPS WebRTC streaming & Gamepad polling engine
│       ├── app.js         # UI routing and room management
│       └── audio.js       # Sound FX synthesizer
└── storage/
    ├── games/
    │   └── It Takes Two/  # Your uploaded "It Takes Two" game
    └── data/
        └── database.json  # Platform database (games, saves, logs)
```

