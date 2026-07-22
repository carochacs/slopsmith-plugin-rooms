# Known UI Issues — Rooms (Multiplayer)

Findings from a frontend UI-bug audit of `screen.js`/`screen.html`/`routes.py` (2026-07-22; no `CLAUDE.md` in this repo). Ranked by severity/confidence. No code changes have been made — this is a catalog for follow-up work.

## 1. Unescaped filename injected into an `onclick` attribute — stored XSS (High)

`screen.js:149`:
```js
${canRemove ? `<button onclick="rooms.removeSuggestion('${s.filename.replace(/'/g, "\\'")}')" ...
```
`s.filename` is only quote-escaped (`'` → `\'`), never run through `escapeHtml`, and sits inside a single-quoted JS string inside a double-quoted HTML attribute. `routes.py:365-384` (`queue.suggest`) does no server-side sanitization of `filename` before broadcasting it via `queue.update`. A filename containing `"` breaks out of the `onclick="..."` attribute, letting arbitrary HTML/attributes be injected into every room member's queue panel — a real stored-XSS path (requires a maliciously-named library file), not just theoretical. Every other interpolation in the file (`title`, `artist`, `suggested_by_name`, chat, roster names) correctly uses `escapeHtml`; this one was missed.

## 2. Unguarded `document.getElementById('audio')` at unconditional init (High)

`screen.js:276-281`:
```js
hookAudio() {
    const audio = document.getElementById('audio');
    audio.addEventListener('ended', () => { ... });
}
```
`rooms.init()` runs immediately at script load (`screen.js:1107`, no `DOMContentLoaded` guard) and calls `hookAudio()` unconditionally with no null check.

**Failure scenario:** If the plugin script executes before core's `#audio` element is mounted, this throws a `TypeError` synchronously inside `init()`, aborting execution before `updateNavIndicator()`/`refreshRoomList()` run (both called after `hookAudio()`). The entire Rooms plugin silently fails to initialize — room list never loads, nav indicator never restores — with only a console error, no user-facing signal.

## 3. Host reconnect mid-song forces a full-room playback restart (High)

`screen.js:462-464`:
```js
if (msg.current_song && !currentFilename) {
    window.playSong(msg.current_song);   // room.welcome handler
```
For a host, the wrapped `playSong` sends `{type:'song.play', ...}` to the server instead of loading audio locally. Server-side, `song.play` (`routes.py:312-318`) unconditionally resets `ready_players`, `transport_state`, and re-broadcasts to every player.

**Failure scenario:** Host's connection blips for a couple seconds mid-song; the reconnect logic (`screen.js:408-422`) reconnects them; `currentFilename` is falsy on the fresh path, so this branch fires — every other player's audio gets yanked back to 0:00 and re-synced, just because the host's socket briefly dropped.

## 4. No `readyState` check before `ws.send()`, no visible disconnect indicator (Medium-High)

`sendChat` (`screen.js:634`), `castVote` (684), `kickPlayer` (866), `startQueueVote` (116), `removeSuggestion` (121), `updateSettings` (1037) guard only on `if (!this.ws)` — none check `this.ws.readyState === WebSocket.OPEN` (only `requestVote`, line 181, does this correctly). During a reconnect gap, `this.ws` still points at the old `CLOSED` socket. `WebSocket.send()` on a closed socket is a silent no-op per spec, and there's no connection-status indicator anywhere in `screen.js`/`screen.html`.

**Failure scenario:** `sendChat` clears the input (`screen.js:640`) regardless of whether the send worked, so a user's chat message, vote, or kick action silently vanishes while their client is mid-reconnect, with no sign anything went wrong.

## 5. Rapid double-join/create can leave a stale reconnect scheduled (Medium)

`connect(code)` (`screen.js:370-422`) does `if (this.ws) this.ws.close()` then immediately assigns a new socket; the old socket's `onclose` closure reads `this` (not scoped per-attempt). Neither `joinByCode()` nor `createRoom()` disables the button or debounces re-entrant calls.

**Failure scenario:** Double-clicking "Join"/"Create Room" (or pressing Enter twice) invokes `connect()` twice before the first socket finishes opening/closing. The first socket's eventual `onclose` fires after `this.code`/`this.reconnectAttempts` have been reset for the second, now-current connection, reads the current (healthy) `this.code`, and schedules an unwanted extra reconnect against an already-connected room.

## 6. Floating "Back to Room" button and `suggestMode` never cleaned up on kick/close (Medium)

`suggestSong()`/`pickSong()` (`screen.js:97-113`, `185-200`) append a fixed `#rooms-float-back` button to `document.body`, removed only by its own click handler or inside the host-only `song.play` handler (`screen.js:538-539`). `leaveRoom()` (`screen.js:872-885`) — invoked by `room.kick`/`room.closed` — never removes it or resets `this.suggestMode`.

**Failure scenario:** A player browsing the library to suggest a song (floating button visible) gets kicked by the host. `leaveRoom(false)` hides the room view but leaves the floating "Back to Room {stale code}" button stuck on screen across every subsequent screen the user navigates to.

## 7. Deferred 3-second vote-winner playback doesn't validate the vote is still current (Medium)

`screen.js:736-763`:
```js
setTimeout(() => {
    ...
    if (this.isHost) window.playSong(winner.filename);
}, 3000);
```
`winner`/`isHost` are captured and read 3 seconds later with no check that `this.currentVote` (already nulled by then) still corresponds to this vote, or that the room/vote context hasn't changed.

**Failure scenario:** If a new vote cycle completes within that 3-second window (or the host leaves and hosts a different room), the stale timeout fires `playSong(winner.filename)` for the *old* winner against whatever context is current, sending a spurious `song.play` and clobbering playback that's already moved on.

## 8. Room-scoped client state not reset on `leaveRoom()` (Low-Medium)

`this.suggestions` and `this.roster` are never cleared in `leaveRoom()` (`screen.js:872-885`) — only `stopRoomPanels()` runs.

**Failure scenario:** A user leaves Room A (populated queue) and joins Room B; `connect()` shows `#rooms-view` immediately, but `renderQueue()`/`renderRoster()` aren't re-invoked until Room B's `room.welcome` arrives — briefly showing Room A's stale suggestion list/roster inside Room B's view.

## 9. Arbitrary-value Tailwind classes used with no `styles` manifest entry (Low)

`screen.js`/`screen.html` use many bracket-notation classes (`text-[10px]`, `shadow-[0_0_5px_#4080e0]`, `z-[100]`, `max-h-[200px]`, etc. — `screen.js:87,88,104,105,147,192,193,655,707,711,714,715,723,728,816,820,831,931,973`; `screen.html:80`). No `styles` key in `plugin.json`, no compiled `assets/plugin.css`. Per the plugin-contract convention, these risk being dropped by core's Tailwind scan-and-build — shadows, tiny text sizes, and z-index layering (including the vote-overlay glow and panel/highway stacking) could silently not render in production.

## 10. Raw unescaped interpolation of `this.code` into `innerHTML` (Low, defense-in-depth)

`screen.js:88, 105, 193` interpolate `this.code` directly (`` `...Room ${this.code}` ``) without `escapeHtml`, unlike the room-list rendering which correctly escapes `room.code`. Currently low-risk since `routes.py:217` generates codes from `ascii_uppercase + digits` only, but it's an inconsistency that would become exploitable if code generation ever changes.
