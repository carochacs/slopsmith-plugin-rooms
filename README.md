# Slopsmith Plugin: Rooms

A plugin for [Slopsmith](https://github.com/byrongamatos/slopsmith) that turns practice into a multiplayer session. Create a room, share the code with friends, and play songs together in sync — with voting, chat, and smart song suggestions.

## Features

- **Shared rooms** — create a room and share its 4-character code; up to 8 players join from any browser on the same Slopsmith instance
- **Synchronized playback** — host controls play/pause/seek/speed and all players follow in real time; a ready-check countdown waits until every player has loaded the song before starting
- **Song voting** — at the end of each song the host triggers a vote; everyone picks from up to 5 smart candidates and the winner plays next
- **Smart song suggestions** — candidates are drawn from several pools:
  - *Same Artist* / *Deep Cut* — other songs by the current artist
  - *Similar Artist* — artists Deezer considers related (requires outbound network access; falls back to local-only if unavailable)
  - *Same Vibe* — related artist in the same tuning
  - *Same Tuning* — different artist, same tuning
  - *Crowd Favorite* — songs in the host's favorites list
  - *Throwback* — a song played earlier in the session
  - *Wild Card* — random pick from the full library
- **Song queue** — players can suggest specific songs; the host can start a vote using the queue as the candidate pool
- **Unanimous redraw** — if everyone votes to redraw, filler slots are reshuffled while player suggestions stay in place
- **Chat** — real-time text chat with system messages for join/leave/song events
- **Per-player arrangement** — each player selects their own arrangement (Lead / Rhythm / Bass) independently
- **Auto-advance** — when playing solo, the host can enable auto-advance to skip the vote and pick the top suggestion automatically
- **Host migration** — if the host disconnects, the longest-connected guest is promoted automatically
- **Player kick** — the host can remove a player from the room
- **Room settings** (configurable by host):
  - Voting on/off
  - Vote timer (seconds)
  - Max players (0 = unlimited)
  - Guest transport control (allow guests to play/pause/seek)
  - Auto-advance
  - Auto-layout (splitscreen)
  - Similarity mode (`deezer` or `local`)

## Requirements

- Slopsmith with a populated library (song voting pulls candidates from the metadata database)
- Outbound HTTPS access to `api.deezer.com` for *Similar Artist* / *Same Vibe* suggestions (optional — falls back gracefully if unavailable)

## Installation

**Docker (web version)**
```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/byrongamatos/slopsmith-plugin-rooms.git rooms
docker compose restart
```

**Desktop app** — clone into the platform plugins directory and restart the app:

| Platform | Plugins directory |
|----------|-------------------|
| Windows  | `%APPDATA%\slopsmith-desktop\plugins\` |
| macOS    | `~/Library/Application Support/slopsmith-desktop/plugins/` |
| Linux    | `~/.config/slopsmith-desktop/plugins/` |

A **Rooms** link will appear in the navigation bar.

## How It Works

1. Open Rooms and click **Create Room** — a 4-character code appears.
2. Share the code. Other players open Rooms, enter the code, and join.
3. The host picks a song from the library and clicks **Play**. All players load it simultaneously; playback starts once everyone is ready.
4. At the end of the song, click **Vote for next song** to present candidates. Players vote; the winner loads automatically.
5. Players can suggest songs via the queue at any time. The host starts a vote from the queue when ready.

## Plugin metadata

| Field | Value |
|-------|-------|
| id | `rooms` |
| name | Rooms |
| nav label | Rooms |
