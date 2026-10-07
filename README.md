# IWO LIFE V1.1 — Multiplayer Upgrade

Browser 3D life-sim inspired by Iwo, Osun State, Nigeria.  
**New in V1.1:** Firebase Auth + Realtime Database, in-game phone, chat, wallet (₦1,000,000 signup bonus), services board, apartment purchase/design, police reports, and WebRTC voice calls.

## Quick start

```bash
# From this folder (needs a local web server — modules + Firebase will not work via file://)
python3 -m http.server 8080
# Open http://localhost:8080
```

## Firebase setup (required for online features)

1. Go to [Firebase Console](https://console.firebase.google.com) → create a project.
2. **Authentication** → Sign-in method → enable **Email/Password**.
3. **Realtime Database** → Create database (start in test mode, then lock rules).
4. Project settings → Your apps → Web app → copy the config object.
5. Open `game.js` and replace `CONFIG.firebase` with your config:

```js
firebase: {
  apiKey: "...",
  authDomain: "...",
  databaseURL: "https://....firebaseio.com",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
}
```

6. Paste these **Realtime Database rules** (Rules tab):

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null",
        ".write": "auth != null && auth.uid === $uid"
      }
    },
    "presence": {
      ".read": "auth != null",
      "$uid": { ".write": "auth != null && auth.uid === $uid" }
    },
    "chats": {
      "$chatId": {
        ".read": "auth != null",
        "messages": {
          "$mid": {
            ".write": "auth != null && (!data.exists() || data.child('from').val() === auth.uid)"
          }
        }
      }
    },
    "services": {
      ".read": "auth != null",
      "$id": { ".write": "auth != null" }
    },
    "reports": {
      ".read": false,
      ".write": "auth != null"
    },
    "signaling": {
      "$room": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

Without a valid config the game still runs fully offline (Guest mode). Chat, cloud wallet and presence are disabled until Firebase is configured.

## Features

| Feature | How to use |
|--------|------------|
| **Sign up / Sign in** | Welcome screen → Create Account or Sign In |
| **₦1,000,000 bonus** | Credited automatically on first account creation |
| **Phone** | Press **P** (desktop) or 📱 button (mobile / HUD) |
| **Chat** | Phone → Chat → pick an online player → type messages |
| **Voice call** | Inside a chat → 📞 (WebRTC + mic permission) |
| **Wallet** | Phone → Wallet (balance syncs to Firebase when signed in) |
| **Services** | Phone → Services → Post a skill (Mechanic, Tailor…) or browse others and chat to hire |
| **Apartment** | Phone → Apartment → Buy for ₦350,000 → choose paint & furniture upgrades |
| **Police** | Phone → Police → select player + reason → submit report |
| **Online players** | Phone → Players (presence list) |

## Controls

**Desktop:** WASD move · SHIFT sprint · SPACE jump · E interact · F vehicle · **P phone** · R camera · ESC menu/close  
**Mobile:** Joystick · ACTION · JUMP · SPRINT · CAR · 📱

## Notes

- Local saves still work via `localStorage`; cloud profile (money, apartment, skills) is preferred when signed in.
- WebRTC uses a public STUN server (`stun.l.google.com`). For production behind strict NATs you may need a TURN server.
- Apartment design is stored on the profile; visual application in the 3D world can be extended later (the purchase + data layer is ready).
- Reports are write-only from clients; review them in the Firebase console under `/reports`.

## Files

- `index.html` — shell, phone UI, auth UI, Firebase SDK
- `style.css` — UI + phone styles
- `game.js` — full game + multiplayer module (`Net`, `Phone`, `AuthUI`)
