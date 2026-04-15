from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from typing import Dict, List, Optional
import uuid
import random
import string
import asyncio
import json
import time
import urllib.request
import urllib.parse
from functools import lru_cache

# Deezer logic moved here to be self-contained in rooms plugin
@lru_cache(maxsize=100)
def get_deezer_related(artist_name: str) -> List[str]:
    """Get related artists for a name via Deezer. Returns list of names."""
    try:
        search_url = ("https://api.deezer.com/search/artist?q="
                        + urllib.parse.quote(artist_name) + "&limit=1")
        req = urllib.request.Request(search_url)
        req.add_header("User-Agent", "Mozilla/5.0")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        
        items = data.get("data", [])
        if not items:
            return []
        artist_id = items[0]["id"]
        
        related_url = f"https://api.deezer.com/artist/{artist_id}/related?limit=20"
        req2 = urllib.request.Request(related_url)
        req2.add_header("User-Agent", "Mozilla/5.0")
        with urllib.request.urlopen(req2, timeout=10) as resp:
            data2 = json.loads(resp.read())
        
        return [a["name"] for a in data2.get("data", [])]
    except Exception as e:
        print(f"[Rooms] Deezer error for '{artist_name}': {e}")
        return []

# Room state
rooms = {}
meta_db = None

class Player:
    def __init__(self, id: str, name: str, ws: WebSocket, is_host: bool = False):
        self.id = id
        self.name = name
        self.ws = ws
        self.is_host = is_host
        self.arrangement = 0
        self.arrangement_name = "Lead"
        self.joined_at = time.time()
        self.last_seen = time.time()

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "is_host": self.is_host,
            "arrangement": self.arrangement,
            "arrangement_name": self.arrangement_name
        }

class Room:
    def __init__(self, code: str):
        self.code = code
        self.players: Dict[str, Player] = {}
        self.settings = {
            "voting": True,
            "vote_timer": 15,
            "max_players": 8,
            "guest_transport": False,
            "auto_advance": True,
            "auto_layout": True,
            "similarity_mode": "deezer"
        }
        self.current_song = None
        self.transport_state = {"playing": False, "time": 0, "speed": 1.0}
        self.cleanup_task = None
        
        # Voting state
        self.candidates = []
        self.votes = {} # { player_id: candidate_index }
        self.vote_task = None
        self.vote_started_at = 0
        self.play_history = []
        self.suggestions = []  # [ {filename, title, artist, suggested_by, suggested_by_name} ]
        self.chat_history = [] # List of { name, text, player_id, is_system, time }
        self.ready_players = set()  # Players who have loaded current song

    def get_host(self) -> Optional[Player]:
        for p in self.players.values():
            if p.is_host: return p
        return None

    def to_summary(self):
        host = self.get_host()
        return {
            "code": self.code,
            "host_name": host.name if host else "Unknown",
            "player_count": len(self.players),
            "current_song": self.current_song
        }

    def get_candidates(self) -> List[dict]:
        if not meta_db: return []
        curr_artist = ""
        curr_tuning = ""
        if self.current_song:
            row = meta_db.conn.execute("SELECT artist, tuning FROM songs WHERE filename = ?", (self.current_song,)).fetchone()
            if row: curr_artist, curr_tuning = row
        
        use_deezer = self.settings.get("similarity_mode", "deezer") != "local"
        related = get_deezer_related(curr_artist) if curr_artist and use_deezer else []
        pool = []
        
        def add_songs(query, params, tag, limit=2):
            rows = meta_db.conn.execute(query, params).fetchall()
            added = 0
            for r in rows:
                fname, title, artist, tuning = r
                if fname == self.current_song: continue
                if fname in [p["filename"] for p in pool]: continue
                if fname in self.play_history[-5:]: continue
                pool.append({"filename": fname, "title": title, "artist": artist, "tuning": tuning, "tag": tag})
                added += 1
                if added >= limit: break

        if related:
            rel_placeholders = ",".join(["?"] * len(related))
            add_songs(f"SELECT filename, title, artist, tuning FROM songs WHERE artist IN ({rel_placeholders}) AND tuning = ? AND title != '' ORDER BY RANDOM() LIMIT 10", (*related, curr_tuning), "Same Vibe", 2)
            add_songs(f"SELECT filename, title, artist, tuning FROM songs WHERE artist IN ({rel_placeholders}) AND title != '' ORDER BY RANDOM() LIMIT 10", tuple(related), "Similar Artist", 2)

        if curr_artist:
            add_songs("SELECT filename, title, artist, tuning FROM songs WHERE artist = ? AND title != '' ORDER BY RANDOM() LIMIT 10", (curr_artist,), "Same Artist", 2)
        if curr_tuning:
            add_songs("SELECT filename, title, artist, tuning FROM songs WHERE tuning = ? AND artist != ? AND title != '' ORDER BY RANDOM() LIMIT 10", (curr_tuning, curr_artist), "Same Tuning", 2)

        favs = list(meta_db.favorite_set())
        # Deep Cut: same artist, least-played in session
        if curr_artist:
            deep_rows = meta_db.conn.execute("SELECT filename, title, artist, tuning FROM songs WHERE artist = ? AND title != '' ORDER BY RANDOM() LIMIT 20", (curr_artist,)).fetchall()
            added = 0
            for r in sorted(deep_rows, key=lambda r: self.play_history.count(r[0])):
                fname, title, artist, tuning = r
                if fname == self.current_song or fname in [p["filename"] for p in pool] or fname in self.play_history[-5:]: continue
                pool.append({"filename": fname, "title": title, "artist": artist, "tuning": tuning, "tag": "Deep Cut"})
                added += 1
                if added >= 2: break

        if favs:
            placeholders = ",".join(["?"] * len(favs))
            add_songs(f"SELECT filename, title, artist, tuning FROM songs WHERE filename IN ({placeholders}) AND title != '' ORDER BY RANDOM() LIMIT 10", tuple(favs), "Crowd Favorite", 2)

        # Throwback: played earlier in session, at least 5 songs ago
        if len(self.play_history) > 5:
            throwback_candidates = self.play_history[:-5]
            added = 0
            for fname in reversed(throwback_candidates):
                if fname in [p["filename"] for p in pool] or fname == self.current_song: continue
                row = meta_db.conn.execute("SELECT filename, title, artist, tuning FROM songs WHERE filename = ?", (fname,)).fetchone()
                if row:
                    pool.append({"filename": row[0], "title": row[1], "artist": row[2], "tuning": row[3], "tag": "Throwback"})
                    added += 1
                    if added >= 2: break

        add_songs("SELECT filename, title, artist, tuning FROM songs WHERE title != '' ORDER BY RANDOM() LIMIT 10", (), "Wild Card", 5)

        final = pool[:5]
        return final

async def resolve_vote(room: Room, code: str):
    """Resolve current vote: tally votes, pick winner, broadcast result."""
    tally = {}
    for v in room.votes.values():
        tally[v] = tally.get(v, 0) + 1
    winner_idx = max(tally, key=tally.get) if tally else random.randint(0, len(room.candidates) - 1)
    winner = room.candidates[winner_idx]
    # Clear suggestions if this was a queue vote
    if room.suggestions:
        room.suggestions = []
        await broadcast(room, {"type": "queue.update", "suggestions": []})
    await broadcast(room, {"type": "vote.result", "winner": winner})
    room.vote_task = None

async def broadcast(room: Room, message: dict):
    disconnected = []
    for p_id, p in room.players.items():
        try:
            await p.ws.send_json(message)
        except:
            disconnected.append(p_id)
    return disconnected

def setup(app: FastAPI, context: dict):
    global meta_db
    meta_db = context.get("meta_db")

    @app.get("/api/plugins/rooms/list")
    async def list_rooms():
        return [r.to_summary() for r in rooms.values()]

    @app.post("/api/plugins/rooms/create")
    async def create_room():
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))
        while code in rooms:
            code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))
        rooms[code] = Room(code)
        return {"code": code}

    @app.websocket("/ws/plugins/rooms/{code}")
    async def websocket_endpoint(websocket: WebSocket, code: str):
        await websocket.accept()
        if code not in rooms:
            await websocket.close(code=1000, reason="Room not found")
            return

        room = rooms[code]
        player_id = str(uuid.uuid4())
        player = None

        try:
            auth_data = await websocket.receive_json()
            if auth_data.get("type") != "auth":
                await websocket.close(code=1000, reason="Auth required")
                return

            name = auth_data.get("name", "Unknown Player")
            is_host = auth_data.get("is_host", False)
            if not room.players: is_host = True

            # Remove stale entry if same name reconnects (e.g. page nav triggered reconnect)
            stale = [pid for pid, p in room.players.items() if p.name == name]
            for pid in stale:
                try: await room.players[pid].ws.close()
                except: pass
                del room.players[pid]

            max_p = room.settings.get("max_players", 0)
            if max_p > 0 and len(room.players) >= max_p and not is_host:
                await websocket.close(code=1000, reason="Room is full")
                return
            
            player = Player(player_id, name, websocket, is_host)
            room.players[player_id] = player
            if room.cleanup_task:
                room.cleanup_task.cancel()
                room.cleanup_task = None

            # Send welcome first so client has playerId before roster arrives
            await websocket.send_json({
                "type": "room.welcome",
                "player_id": player_id,
                "settings": room.settings,
                "current_song": room.current_song,
                "transport": room.transport_state,
                "suggestions": room.suggestions,
                "chat_history": room.chat_history[-20:] # Last 20 messages
            })

            await broadcast(room, {"type": "roster.update", "players": [p.to_dict() for p in room.players.values()]})

            # Send system join message
            join_msg = {"type": "chat.message", "text": f"{name} joined the room", "is_system": True, "time": time.time()}
            room.chat_history.append(join_msg)
            await broadcast(room, join_msg)

            while True:
                data = await websocket.receive_json()
                msg_type = data.get("type")

                if msg_type == "chat.message":
                    chat_msg = {
                        "type": "chat.message",
                        "player_id": player_id,
                        "name": player.name,
                        "text": data.get("text", ""),
                        "time": time.time()
                    }
                    room.chat_history.append(chat_msg)
                    if len(room.chat_history) > 100: room.chat_history.pop(0)
                    await broadcast(room, chat_msg)

                elif msg_type == "settings.update" and player.is_host:
                    room.settings.update(data.get("settings", {}))
                    await broadcast(room, {"type": "settings.update", "settings": room.settings})
                
                elif msg_type == "sync.ping":
                    await websocket.send_json({"type": "sync.pong", "client_time": data.get("client_time"), "server_time": time.time() * 1000})

                elif msg_type == "song.play" and player.is_host:
                    room.current_song = data.get("filename")
                    room.play_history.append(room.current_song)
                    room.transport_state["playing"] = False
                    room.transport_state["time"] = 0
                    room.ready_players = set()
                    await broadcast(room, data)

                elif msg_type == "song.resync":
                    # Player adjusted sync — restart ready check for everyone
                    room.ready_players = set()
                    print(f"[Rooms:Sync] {player.name} requested resync")
                    await broadcast(room, {"type": "song.resync"})

                elif msg_type == "song.ready":
                    room.ready_players.add(player_id)
                    print(f"[Rooms:Sync] {player.name} ready ({len(room.ready_players)}/{len(room.players)})")
                    if len(room.ready_players) >= len(room.players):
                        room.transport_state["playing"] = True
                        start_at = time.time() * 1000 + 150
                        print(f"[Rooms:Sync] All ready — broadcasting song.start at {start_at:.1f} (server now={time.time()*1000:.1f})")
                        await broadcast(room, {"type": "song.start", "start_at": start_at})

                elif msg_type.startswith("transport.") and (player.is_host or room.settings.get("guest_transport")):
                    if msg_type == "transport.play":
                        room.transport_state["playing"] = True
                        room.transport_state["time"] = data.get("song_time", 0)
                    elif msg_type == "transport.pause":
                        room.transport_state["playing"] = False
                        room.transport_state["time"] = data.get("song_time", 0)
                    elif msg_type == "transport.seek":
                        room.transport_state["time"] = data.get("song_time", 0)
                    elif msg_type == "transport.speed":
                        room.transport_state["speed"] = data.get("rate", 1.0)
                    
                    for p_id, p in room.players.items():
                        if p_id != player_id:
                            try: await p.ws.send_json(data)
                            except: pass

                elif msg_type == "sync.time" and player.is_host:
                    room.transport_state["time"] = data.get("time", 0)
                    room.transport_state["playing"] = data.get("playing", False)
                    for p_id, p in room.players.items():
                        if not p.is_host:
                            try: await p.ws.send_json(data)
                            except: pass
                
                elif msg_type == "player.arrangement":
                    player.arrangement = data.get("index", 0)
                    player.arrangement_name = data.get("name", "Lead")
                    await broadcast(room, {"type": "roster.update", "players": [p.to_dict() for p in room.players.values()]})

                elif msg_type == "queue.suggest":
                    fname = urllib.parse.unquote(data.get("filename", ""))
                    existing = {s["filename"] for s in room.suggestions}
                    if fname and fname not in existing:
                        row = meta_db.conn.execute("SELECT title, artist FROM songs WHERE filename = ?", (fname,)).fetchone() if meta_db else None
                        title = row[0] if row else fname
                        artist = row[1] if row else ""
                        # Skip if same title+artist already suggested (different file, same song)
                        if not any(s["title"] == title and s["artist"] == artist for s in room.suggestions):
                            room.suggestions.append({
                                "filename": fname,
                                "title": title,
                                "artist": artist,
                                "suggested_by": player_id,
                                "suggested_by_name": player.name
                            })
                            await broadcast(room, {"type": "queue.update", "suggestions": room.suggestions})
                            sys_msg = {"type": "chat.message", "text": f"{player.name} suggested: {title}", "is_system": True, "time": time.time()}
                            room.chat_history.append(sys_msg)
                            await broadcast(room, sys_msg)

                elif msg_type == "queue.remove":
                    fname = urllib.parse.unquote(data.get("filename", ""))
                    entry = next((s for s in room.suggestions if s["filename"] == fname), None)
                    if entry and (player.is_host or entry["suggested_by"] == player_id):
                        room.suggestions.remove(entry)
                        await broadcast(room, {"type": "queue.update", "suggestions": room.suggestions})

                elif msg_type == "queue.vote" and player.is_host and room.suggestions:
                    # Start vote using player suggestions as candidates
                    if room.vote_task: room.vote_task.cancel()
                    suggested = [{"filename": s["filename"], "title": s["title"], "artist": s["artist"], "tag": f"Pick by {s['suggested_by_name']}"} for s in room.suggestions[:5]]
                    # Fill remaining slots using same candidate logic as post-song voting
                    fillers = room.get_candidates()
                    existing = {c["filename"] for c in suggested}
                    for f in fillers:
                        if len(suggested) >= 5: break
                        if f["filename"] not in existing:
                            suggested.append(f)
                            existing.add(f["filename"])
                    room.candidates = suggested
                    room.votes = {}
                    room.vote_started_at = time.time()
                    await broadcast(room, {"type": "vote.start", "candidates": room.candidates, "timer": room.settings["vote_timer"]})

                    async def _vote_timeout(rid, delay):
                        await asyncio.sleep(delay)
                        if rid in rooms: await resolve_vote(rooms[rid], rid)
                    room.vote_task = asyncio.create_task(_vote_timeout(code, room.settings["vote_timer"]))

                elif msg_type == "vote.request" and player.is_host:
                    # Auto-advance: solo host + auto_advance + song already played → skip vote
                    if room.current_song and len(room.players) <= 1 and room.settings.get("auto_advance"):
                        candidates = room.get_candidates()
                        if candidates:
                            pick = candidates[0]
                            await broadcast(room, {"type": "vote.result", "winner": pick})
                        continue

                    if room.vote_task: room.vote_task.cancel()
                    room.candidates = room.get_candidates()
                    room.votes = {}
                    room.vote_started_at = time.time()
                    await broadcast(room, {"type": "vote.start", "candidates": room.candidates, "timer": room.settings["vote_timer"]})
                    
                    async def _vote_timeout2(rid, delay):
                        await asyncio.sleep(delay)
                        if rid in rooms: await resolve_vote(rooms[rid], rid)
                    room.vote_task = asyncio.create_task(_vote_timeout2(code, room.settings["vote_timer"]))

                elif msg_type == "vote.cast":
                    room.votes[player_id] = data.get("index")
                    tally = {}
                    for v in room.votes.values(): tally[v] = tally.get(v, 0) + 1
                    await broadcast(room, {"type": "vote.tally", "tally": tally})

                    # Check if all players voted
                    if len(room.votes) == len(room.players):
                        # Unanimous redraw
                        if all(v == "__redraw__" for v in room.votes.values()):
                            if room.vote_task: room.vote_task.cancel()
                            # Keep user-suggested picks, only redraw filler slots
                            kept = [c for c in room.candidates if c["tag"].startswith("Pick by ")]
                            shown = set(c["filename"] for c in room.candidates)
                            fillers = [c for c in room.get_candidates() if c["filename"] not in shown]
                            if not fillers:
                                fillers = room.get_candidates()
                            for f in fillers:
                                if len(kept) >= 5: break
                                if f["filename"] not in shown:
                                    kept.append(f)
                                    shown.add(f["filename"])
                            room.candidates = kept[:5]
                            room.votes = {}
                            room.vote_started_at = time.time()
                            await broadcast(room, {"type": "vote.start", "candidates": room.candidates, "timer": room.settings["vote_timer"]})

                            async def _vote_timeout3(rid, delay):
                                await asyncio.sleep(delay)
                                if rid in rooms: await resolve_vote(rooms[rid], rid)
                            room.vote_task = asyncio.create_task(_vote_timeout3(code, room.settings["vote_timer"]))

                elif msg_type == "player.kick" and player.is_host:
                    target_id = data.get("player_id")
                    if target_id in room.players and target_id != player_id:
                        target = room.players[target_id]
                        try:
                            await target.ws.send_json({"type": "room.kick", "reason": "Kicked by host"})
                            await target.ws.close()
                        except: pass
                        del room.players[target_id]
                        await broadcast(room, {"type": "roster.update", "players": [p.to_dict() for p in room.players.values()]})

        except WebSocketDisconnect: pass
        except Exception as e: print(f"[Rooms] WS Error: {e}")
        finally:
            if player and player_id in room.players:
                if player.is_host:
                    # Host disconnect → close room immediately
                    await broadcast(room, {"type": "room.closed", "reason": "Host left the room"})
                    # Close all player websockets
                    for p_id, p in list(room.players.items()):
                        if p_id != player_id:
                            try: await p.ws.close()
                            except: pass
                    if code in rooms: del rooms[code]
                else:
                    async def delayed_cleanup(rid, pid):
                        await asyncio.sleep(10)
                        if rid in rooms:
                            r = rooms[rid]
                            if pid in r.players:
                                p = r.players[pid]
                                leave_msg = {"type": "chat.message", "text": f"{p.name} left the room", "is_system": True, "time": time.time()}
                                r.chat_history.append(leave_msg)
                                del r.players[pid]
                                if not r.players: del rooms[rid]
                                else:
                                    await broadcast(r, leave_msg)
                                    await broadcast(r, {"type": "roster.update", "players": [pp.to_dict() for pp in r.players.values()]})
                    room.cleanup_task = asyncio.create_task(delayed_cleanup(code, player_id))
