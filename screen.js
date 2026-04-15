// Rooms Plugin - Client Logic
function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

window.rooms = {
    ws: null,
    code: null,
    playerId: null,
    playerName: localStorage.getItem('rooms-player-name') || (function() {
        const adjs = ["Funky", "Groovy", "Sonic", "Heavy", "Electric", "Classic", "Wild", "Golden", "Neon", "Epic", "Misty", "Radiant", "Sharp", "Smooth", "Lunar", "Vocal", "Turbo", "Cosmic", "Hyper", "Metal"];
        const nouns = ["Riff", "Chord", "Beat", "Solo", "Bass", "Treble", "Groove", "Pulse", "Sound", "Vibe", "Strum", "Note", "Axe", "Fret", "Tone", "Laser", "Phantom", "Legend", "Wizard", "Titan"];
        return adjs[Math.floor(Math.random() * adjs.length)] + nouns[Math.floor(Math.random() * nouns.length)];
    })(),
    isHost: false,
    roster: [],
    settings: {},
    latency: 0,
    serverOffset: 0, // server_time - client_time
    offsetSamples: [], // rolling samples for median
    // iOS Safari has ~30-50ms audio pipeline delay vs ~5ms on desktop
    audioLatencyCompensation: /iPad|iPhone|iPod/.test(navigator.userAgent) ? 100 : 0,
    syncInterval: null,
    driftInterval: null,
    panels: [], // { playerId, hw, container, canvas, arrangement }
    panelSyncInterval: null,
    voteCountdown: null,
    currentVote: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    suggestions: [],
    suggestMode: false,
    lobbyRefreshInterval: null,

    init() {
        const nameInput = document.getElementById('rooms-player-name');
        if (nameInput) {
            nameInput.value = this.playerName;
            nameInput.onchange = (e) => {
                this.playerName = e.target.value;
                localStorage.setItem('rooms-player-name', this.playerName);
            };
        }

        // Hook into screen navigation to refresh room list and cleanup
        const _showScreen = window.showScreen;
        window.showScreen = (id) => {
            if (id === 'plugin-rooms' && !this.code) {
                this.refreshRoomList();
                this.startLobbyRefresh();
            } else {
                this.stopLobbyRefresh();
            }
            if (id === 'plugin-rooms' && this.code) {
                this.refreshStageUI();
            }
            if (id !== 'player' && this.code) {
                this.stopRoomPanels();
            }
            _showScreen(id);
        };

        // Intercept global transport functions
        this.interceptTransport();

        // Hook audio events
        this.hookAudio();

        // Add "Back to Room" indicator to nav if active
        this.updateNavIndicator();

        this.refreshRoomList();
    },

    updateNavIndicator() {
        let indicator = document.getElementById('rooms-nav-indicator');
        if (this.code) {
            if (!indicator) {
                const nav = document.querySelector('#nav-plugins');
                if (nav) {
                    indicator = document.createElement('a');
                    indicator.id = 'rooms-nav-indicator';
                    indicator.href = '#';
                    indicator.onclick = (e) => { e.preventDefault(); showScreen('plugin-rooms'); };
                    indicator.className = 'text-[10px] bg-accent/10 hover:bg-accent/20 text-accent px-2 py-1 rounded-md border border-accent/20 font-bold flex items-center gap-1 transition';
                    indicator.innerHTML = `<span class="w-1.5 h-1.5 bg-accent rounded-full shadow-[0_0_5px_#4080e0]"></span> Room ${this.code}`;
                    nav.appendChild(indicator);
                }
            }
        } else if (indicator) {
            indicator.remove();
        }
    },

    suggestSong() {
        this.suggestMode = true;
        showScreen('home');
        let backBtn = document.getElementById('rooms-float-back');
        if (!backBtn) {
            backBtn = document.createElement('button');
            backBtn.id = 'rooms-float-back';
            backBtn.className = 'fixed bottom-8 right-8 z-[100] bg-amber-600 hover:bg-amber-500 text-white px-6 py-3 rounded-2xl shadow-2xl font-bold flex items-center gap-2 transition transform hover:scale-105 active:scale-95';
            backBtn.innerHTML = `<span>Back to Room</span> <span class="bg-white/20 px-1.5 py-0.5 rounded text-[10px]">${this.code}</span>`;
            backBtn.onclick = () => {
                this.suggestMode = false;
                showScreen('plugin-rooms');
                backBtn.remove();
            };
            document.body.appendChild(backBtn);
        }
    },

    startQueueVote() {
        if (!this.ws || !this.isHost || this.suggestions.length === 0) return;
        this.ws.send(JSON.stringify({ type: 'queue.vote' }));
    },

    removeSuggestion(filename) {
        if (!this.ws) return;
        this.ws.send(JSON.stringify({ type: 'queue.remove', filename }));
    },

    renderQueue() {
        const list = document.getElementById('rooms-queue-list');
        const emptyMsg = document.getElementById('rooms-queue-empty');
        const startBtn = document.getElementById('rooms-btn-start-vote');
        if (!list) return;

        if (emptyMsg) emptyMsg.style.display = this.suggestions.length ? 'none' : '';

        if (startBtn) {
            if (this.isHost && this.suggestions.length >= 2) startBtn.classList.remove('hidden');
            else startBtn.classList.add('hidden');
        }

        list.innerHTML = this.suggestions.map(s => {
            const canRemove = this.isHost || s.suggested_by === this.playerId;
            return `
            <div class="flex items-center gap-3 bg-dark-800/80 border border-gray-700/50 rounded-xl p-3 group">
                <div class="w-10 h-10 bg-dark-700 rounded-lg overflow-hidden flex-shrink-0">
                    <img src="/api/song/${encodeURIComponent(s.filename)}/art" class="w-full h-full object-cover" onerror="this.parentElement.innerHTML='<div class=\\'flex items-center justify-center w-full h-full text-gray-600 text-lg\\'>&#9835;</div>'">
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-white truncate">${escapeHtml(s.title)}</p>
                    <p class="text-[10px] text-gray-500 truncate">${escapeHtml(s.artist)} &middot; suggested by ${escapeHtml(s.suggested_by_name)}</p>
                </div>
                ${canRemove ? `<button onclick="rooms.removeSuggestion('${s.filename.replace(/'/g, "\\'")}')" class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-900/30 text-red-500 rounded-lg transition flex-shrink-0" title="Remove">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>` : ''}
            </div>`;
        }).join('');
    },

    refreshStageUI() {
        const emptyStage = document.getElementById('rooms-empty-stage');
        const hasCurrentSong = typeof currentFilename !== 'undefined' && currentFilename;
        const rejoinBtn = document.getElementById('rooms-btn-rejoin');
        if (emptyStage) {
            if (hasCurrentSong) {
                emptyStage.classList.add('hidden');
                // Show rejoin button so player can get back into the song
                if (rejoinBtn) rejoinBtn.classList.remove('hidden');
            } else {
                emptyStage.classList.remove('hidden');
                if (rejoinBtn) rejoinBtn.classList.add('hidden');
                this.renderQueue();
            }
        }
        this.updateTransportUI();
    },

    rejoinSong() {
        if (typeof currentFilename !== 'undefined' && currentFilename) {
            showScreen('player');
        }
    },

    requestVote() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ type: 'vote.request' }));
    },

    pickSong() {
        showScreen('home');
        // Add a temporary floating button to go back to room
        let backBtn = document.getElementById('rooms-float-back');
        if (!backBtn) {
            backBtn = document.createElement('button');
            backBtn.id = 'rooms-float-back';
            backBtn.className = 'fixed bottom-8 right-8 z-[100] bg-accent hover:bg-accent-light text-white px-6 py-3 rounded-2xl shadow-2xl font-bold flex items-center gap-2 transition transform hover:scale-105 active:scale-95';
            backBtn.innerHTML = `<span>Back to Room</span> <span class="bg-white/20 px-1.5 py-0.5 rounded text-[10px]">${this.code}</span>`;
            backBtn.onclick = () => {
                showScreen('plugin-rooms');
                backBtn.remove();
            };
            document.body.appendChild(backBtn);
        }
    },

    interceptTransport() {
        const self = this;
        
        // Wrap playSong
        const _playSong = window.playSong;
        window._origPlaySong = _playSong;
        window.playSong = async function(filename, arrangement) {
            // Suggest mode: add to queue instead of playing
            if (self.code && self.suggestMode) {
                self.suggestMode = false;
                self._suggestLock = true; // prevent double-fire from event bubbling
                const decoded = decodeURIComponent(filename);
                if (!self.suggestions.some(s => s.filename === decoded || s.filename === filename)) {
                    self.ws.send(JSON.stringify({ type: 'queue.suggest', filename }));
                }
                showScreen('plugin-rooms');
                const backBtn = document.getElementById('rooms-float-back');
                if (backBtn) backBtn.remove();
                setTimeout(() => { self._suggestLock = false; }, 500);
                return;
            }
            // Block stale second call from event bubbling after suggest
            if (self._suggestLock) return;
            if (self.code) {
                if (self.isHost) {
                    // Just notify server — both host and guest load from song.play handler
                    self.ws.send(JSON.stringify({
                        type: 'song.play',
                        filename: filename,
                        arrangement: arrangement
                    }));
                    return;
                }
                return _playSong(filename, arrangement);
            }
            return _playSong(filename, arrangement);
        };

        // Block all transport in rooms — song plays uninterrupted once started
        const _togglePlay = window.togglePlay;
        window.togglePlay = function() {
            if (self.code) return;
            _togglePlay();
        };

        const _seekBy = window.seekBy;
        window.seekBy = function(s) {
            if (self.code) return;
            _seekBy(s);
        };

        const _setSpeed = window.setSpeed;
        window.setSpeed = function(v) {
            if (self.code) return;
            _setSpeed(v);
        };

        // Wrap changeArrangement
        const _changeArrangement = window.changeArrangement;
        window.changeArrangement = function(index) {
            _changeArrangement(index);
            if (self.code) {
                // Get arrangement name from the UI dropdown or highway
                const arrSelect = document.getElementById('arr-select');
                const name = arrSelect ? arrSelect.options[arrSelect.selectedIndex].text : "Arrangement";
                self.ws.send(JSON.stringify({
                    type: 'player.arrangement',
                    index: index,
                    name: name
                }));
            }
        };
    },

    hookAudio() {
        const audio = document.getElementById('audio');

        // Transport events handled by interceptTransport wrappers.
        // Only hook 'ended' here — it has no wrapper equivalent.
        audio.addEventListener('ended', () => {
            if (this.code) {
                console.log('[Rooms] Song ended, returning to room lobby');
                this.stopRoomPanels();
                showScreen('plugin-rooms');
                this.refreshStageUI();
                if (this.isHost) {
                    this.ws.send(JSON.stringify({ type: 'vote.request' }));
                }
            }
        });
    },

    startLobbyRefresh() {
        this.stopLobbyRefresh();
        this.lobbyRefreshInterval = setInterval(() => this.refreshRoomList(), 5000);
    },

    stopLobbyRefresh() {
        if (this.lobbyRefreshInterval) {
            clearInterval(this.lobbyRefreshInterval);
            this.lobbyRefreshInterval = null;
        }
    },

    async refreshRoomList() {
        try {
            const resp = await fetch('/api/plugins/rooms/list');
            const list = await resp.json();
            this.renderRoomList(list);
        } catch (e) {
            console.error('[Rooms] Failed to fetch room list:', e);
        }
    },

    renderRoomList(list) {
        const container = document.getElementById('rooms-list');
        if (!container) return;

        if (list.length === 0) {
            container.innerHTML = '<div class="col-span-full py-12 text-center text-gray-600 italic">No active rooms. Be the first!</div>';
            return;
        }

        container.innerHTML = list.map(room => `
            <div class="room-card group" onclick="rooms.joinRoom('${escapeHtml(room.code)}')">
                <div class="flex items-center justify-between mb-4">
                    <span class="text-xs font-bold text-accent uppercase tracking-widest">Room ${escapeHtml(room.code)}</span>
                    <span class="flex items-center gap-1 text-xs text-gray-500">
                        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"/></svg>
                        ${room.player_count} players
                    </span>
                </div>
                <h3 class="text-lg font-bold text-white group-hover:text-accent transition mb-1">${escapeHtml(room.host_name)}'s Session</h3>
                <p class="text-sm text-gray-400 truncate">${room.current_song ? escapeHtml(room.current_song) : 'Just chilling in lobby'}</p>
            </div>
        `).join('');
    },

    async createRoom() {
        try {
            const saved = localStorage.getItem('rooms-default-settings');
            const resp = await fetch('/api/plugins/rooms/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: saved ? JSON.parse(saved) : {} })
            });
            const data = await resp.json();
            this.isHost = true;
            this.connect(data.code);
        } catch (e) {
            alert('Failed to create room: ' + e);
        }
    },

    joinByCode() {
        const input = document.getElementById('rooms-join-code');
        if (!input) return;
        const code = input.value.trim().toUpperCase();
        if (code.length !== 4) return;
        input.value = '';
        this.joinRoom(code);
    },

    joinRoom(code) {
        this.isHost = false;
        this.connect(code);
    },

    connect(code) {
        this.stopLobbyRefresh();
        if (this.ws) this.ws.close();

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${location.host}/ws/plugins/rooms/${code}`);

        this.ws.onopen = () => {
            this.reconnectAttempts = 0;
            this.ws.send(JSON.stringify({
                type: 'auth',
                name: this.playerName,
                is_host: this.isHost
            }));
            
            // Burst pings for fast clock calibration
            this.offsetSamples = [];
            for (let i = 0; i < 5; i++) {
                setTimeout(() => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ type: 'sync.ping', client_time: Date.now() }));
                    }
                }, i * 100);
            }
            // Then regular pings to maintain calibration
            this.syncInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'sync.ping', client_time: Date.now() }));
                }
            }, 3000);

        };

        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            this.handleMessage(msg);
        };

        this.ws.onclose = () => {
            clearInterval(this.syncInterval);
            clearInterval(this.driftInterval);
            if (this.code && this.reconnectAttempts < 3) {
                const delay = Math.pow(2, this.reconnectAttempts) * 1000; // 1s, 2s, 4s
                console.log(`[Rooms] Disconnected. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/3)...`);
                this.reconnectAttempts++;
                this.reconnectTimer = setTimeout(() => {
                    if (this.code) this.connect(this.code);
                }, delay);
            } else if (this.code) {
                console.log('[Rooms] Disconnected. Max reconnect attempts reached.');
                this.leaveRoom(false);
            }
        };

        this.code = code;
        document.getElementById('rooms-display-code').textContent = code;
        document.getElementById('rooms-lobby').classList.add('hidden');
        document.getElementById('rooms-view').classList.remove('hidden');
        
        if (this.isHost) {
            document.getElementById('rooms-settings-box').classList.remove('hidden');
        } else {
            document.getElementById('rooms-settings-box').classList.add('hidden');
        }

        this.updateTransportUI();
    },

    handleMessage(msg) {
        const audio = document.getElementById('audio');
        
        switch (msg.type) {
            case 'room.welcome':
                this.playerId = msg.player_id;
                this.settings = msg.settings;
                this.suggestions = msg.suggestions || [];
                this.updateNavIndicator();
                this.renderQueue();
                console.log('[Rooms] Welcomed to room', this.code);
                
                // Clear and render chat history
                document.getElementById('rooms-chat-messages').innerHTML = '';
                if (msg.chat_history) {
                    msg.chat_history.forEach(m => this.renderChatMessage(m.name, m.text, m.player_id === this.playerId, m.is_system));
                }

                // Update UI song info
                if (msg.current_song) {
                    // We don't have artist/title yet, but we'll get it on song.play or we can fetch
                    document.getElementById('rooms-current-song-title').textContent = msg.current_song.split('/').pop();
                }

                // If joining mid-song
                if (msg.current_song && !currentFilename) {
                    window.playSong(msg.current_song);
                    // Sync to host's current position once audio loads
                    if (!this.isHost && msg.transport) {
                        const joinTime = Date.now();
                        const _joinSync = () => {
                            audio.removeEventListener('canplaythrough', _joinSync);
                            // Compensate for time elapsed during song load
                            const loadDelay = (Date.now() - joinTime) / 1000;
                            const targetTime = (msg.transport.time || 0) + (msg.transport.playing ? loadDelay : 0);
                            audio.currentTime = targetTime;
                            audio.playbackRate = msg.transport.speed || 1.0;
                            if (msg.transport.playing) {
                                audio.play().catch(() => {});
                            }
                        };
                        audio.addEventListener('canplaythrough', _joinSync);
                    }
                }
                this.updateTransportUI();
                break;
            case 'roster.update':
                this.roster = msg.players;
                this.renderRoster();
                if (this.isHost && currentFilename) {
                    this.updatePanels();
                }
                break;
            case 'settings.update':
                this.settings = msg.settings;
                this.updateTransportUI();
                break;
            case 'sync.pong':
                const rtt = Date.now() - msg.client_time;
                this.latency = rtt / 2;
                if (msg.server_time) {
                    const sample = msg.server_time - (msg.client_time + this.latency);
                    this.offsetSamples.push(sample);
                    if (this.offsetSamples.length > 7) this.offsetSamples.shift();
                    const sorted = [...this.offsetSamples].sort((a, b) => a - b);
                    this.serverOffset = sorted[Math.floor(sorted.length / 2)];
                    console.log(`[Rooms:Sync] RTT=${rtt}ms latency=${this.latency.toFixed(1)}ms offset=${this.serverOffset.toFixed(1)}ms samples=${this.offsetSamples.length}`);
                }
                break;
            case 'song.play':
                // Hide queue/empty stage, show Pick Song button instead
                const emptyStage = document.getElementById('rooms-empty-stage');
                if (emptyStage) emptyStage.classList.add('hidden');
                this.suggestions = [];
                // Get song info from highway or fetch
                setTimeout(() => {
                    const info = highway.getSongInfo();
                    if (info && info.title) {
                        document.getElementById('rooms-current-song-title').textContent = info.title;
                        document.getElementById('rooms-current-song-artist').textContent = info.artist;
                    }
                }, 1000);

                this.updateTransportUI();
                // Both host and guest: load song, signal ready, wait for song.start
                const _songPlayRecv = Date.now();
                console.log(`[Rooms:Sync] song.play received, loading... (${this.isHost ? 'HOST' : 'GUEST'})`);
                window._origPlaySong(msg.filename, msg.arrangement);
                const _onReady = () => {
                    audio.removeEventListener('canplaythrough', _onReady);
                    const loadTime = Date.now() - _songPlayRecv;
                    console.log(`[Rooms:Sync] canplaythrough fired after ${loadTime}ms, sending ready`);
                    audio.pause();
                    audio.currentTime = 0;
                    this.ws.send(JSON.stringify({ type: 'song.ready' }));
                };
                audio.addEventListener('canplaythrough', _onReady);

                if (this.isHost) {
                    setTimeout(() => this.updatePanels(), 1000);
                    const backBtn = document.getElementById('rooms-float-back');
                    if (backBtn) backBtn.remove();
                } else {
                    setTimeout(() => this.renderRoster(), 2000);
                }
                break;
            case 'song.start':
                // All players ready — play at scheduled server time
                audio.currentTime = 0;
                // Subtract audio pipeline compensation — iOS needs to fire play() earlier
                const localStartTime = msg.start_at - this.serverOffset - this.audioLatencyCompensation;
                const waitMs = localStartTime - Date.now();
                const role = this.isHost ? 'HOST' : 'GUEST';
                console.log(`[Rooms:Sync] song.start received. waitMs=${waitMs.toFixed(1)} serverOffset=${this.serverOffset.toFixed(1)} (${role})`);

                const _syncPlay = (how) => {
                    const overshoot = Date.now() - localStartTime;
                    console.log(`[Rooms:Sync] PLAYING — ${how} overshoot=${overshoot.toFixed(1)}ms (${role})`);
                    audio.play().catch(() => {});
                    this.showSyncDebug({
                        role, how, overshoot: overshoot.toFixed(1),
                        waitMs: waitMs.toFixed(1),
                        offset: this.serverOffset.toFixed(1),
                        latency: this.latency.toFixed(1),
                        samples: this.offsetSamples.length,
                        audioComp: this.audioLatencyCompensation
                    });
                };

                if (waitMs <= 0) {
                    _syncPlay('immediate');
                } else {
                    const spinStart = Math.max(0, waitMs - 30);
                    setTimeout(() => {
                        while (Date.now() < localStartTime) { /* spin */ }
                        _syncPlay('scheduled');
                    }, spinStart);
                }
                break;
            case 'song.resync':
                // Someone adjusted sync — pause, reset, signal ready for coordinated restart
                audio.pause();
                audio.currentTime = 0;
                this.ws.send(JSON.stringify({ type: 'song.ready' }));
                break;
            case 'transport.play':
            case 'transport.pause':
            case 'transport.seek':
            case 'transport.speed':
                // Transport blocked in rooms — songs play uninterrupted
                break;
            case 'sync.time':
                // No-op — sync removed, songs play freely after start
                break;
            case 'vote.start':
                this.stopRoomPanels();
                showScreen('plugin-rooms');
                this.startVote(msg.candidates, msg.timer);
                break;
            case 'vote.tally':
                this.updateTally(msg.tally);
                break;
            case 'vote.result':
                this.stopVote(msg.winner);
                break;
            case 'room.closed':
                this.reconnectAttempts = 3; // prevent reconnect
                alert(msg.reason || 'Room has been closed');
                this.leaveRoom(false);
                break;
            case 'room.kick':
                this.reconnectAttempts = 3; // prevent reconnect
                alert('You have been kicked from the room: ' + (msg.reason || 'No reason provided'));
                this.leaveRoom(false);
                break;
            case 'host.migrated':
                if (msg.new_host_id === this.playerId) {
                    this.isHost = true;
                    document.getElementById('rooms-settings-box').classList.remove('hidden');
                }
                this.updateTransportUI();
                this.renderRoster();
                break;
            case 'queue.update':
                this.suggestions = msg.suggestions || [];
                this.renderQueue();
                break;
            case 'chat.message':
                this.renderChatMessage(msg.name, msg.text, msg.player_id === this.playerId, msg.is_system);
                break;
        }
    },

    sendChat(e) {
        if (e) e.preventDefault();
        const input = document.getElementById('rooms-chat-input');
        if (!input || !this.ws || !input.value.trim()) return;

        this.ws.send(JSON.stringify({
            type: 'chat.message',
            text: input.value.trim()
        }));
        input.value = '';
    },

    renderChatMessage(name, text, isMe, isSystem) {
        const container = document.getElementById('rooms-chat-messages');
        if (!container) return;

        const div = document.createElement('div');
        if (isSystem) {
            div.className = 'chat-msg-system';
            div.textContent = text;
        } else {
            div.className = 'flex flex-col';
            div.innerHTML = `
                <div class="flex items-center gap-1.5 mb-0.5">
                    <span class="font-bold ${isMe ? 'text-accent' : 'text-gray-400'} text-[10px] uppercase tracking-wider">${escapeHtml(name)}</span>
                </div>
                <div class="bg-dark-700/50 rounded-lg px-3 py-2 text-gray-200 break-words border border-gray-700/30">
                    ${escapeHtml(text)}
                </div>
            `;
        }

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    },

    startVote(candidates, timer) {
        this.currentVote = { candidates, timer, selected: null };
        document.getElementById('rooms-vote-overlay').classList.remove('hidden');
        this.renderCandidates();
        
        let timeLeft = timer;
        const timerEl = document.getElementById('rooms-vote-timer');
        if (this.voteCountdown) clearInterval(this.voteCountdown);
        
        this.voteCountdown = setInterval(() => {
            timeLeft--;
            timerEl.textContent = `00:${timeLeft.toString().padStart(2, '0')}`;
            if (timeLeft <= 0) clearInterval(this.voteCountdown);
        }, 1000);
    },

    castVote(index) {
        if (!this.ws) return;
        this.currentVote.selected = index;
        this.ws.send(JSON.stringify({ type: 'vote.cast', index }));
        this.renderCandidates();
    },

    updateTally(tally) {
        if (!this.currentVote) return;
        this.currentVote.candidates.forEach((c, i) => {
            const countEl = document.getElementById(`vote-count-${i}`);
            if (countEl) countEl.textContent = `${tally[i] || 0} votes`;
        });
        const redrawEl = document.getElementById('vote-count-__redraw__');
        if (redrawEl) redrawEl.textContent = `${tally['__redraw__'] || 0} votes`;
    },

    renderCandidates() {
        const container = document.getElementById('rooms-vote-candidates');
        if (!container || !this.currentVote) return;

        const cards = this.currentVote.candidates.map((c, i) => {
            const isSelected = this.currentVote.selected === i;
            return `
            <div onclick="rooms.castVote(${i})" class="bg-dark-800 border-2 ${isSelected ? 'border-accent shadow-[0_0_20px_rgba(64,128,224,0.3)]' : 'border-gray-700 hover:border-gray-500'} rounded-2xl p-4 transition cursor-pointer flex flex-col items-center group">
                <div class="w-full aspect-square bg-dark-700 rounded-xl mb-3 flex items-center justify-center overflow-hidden relative">
                    <img src="/api/song/${encodeURIComponent(c.filename)}/art" class="w-full h-full object-cover ${isSelected ? 'scale-110' : 'group-hover:scale-105'} transition-transform" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
                    <span class="text-3xl hidden">&#127928;</span>
                    <div class="absolute top-1 right-1 bg-black/60 px-1.5 py-0.5 rounded text-[8px] text-gray-400 font-bold uppercase">${escapeHtml(c.tag)}</div>
                </div>
                <h3 class="text-sm font-bold text-white truncate w-full text-center">${escapeHtml(c.title)}</h3>
                <p class="text-[10px] text-gray-500 truncate w-full text-center mb-2">${escapeHtml(c.artist)}</p>
                <div id="vote-count-${i}" class="text-[10px] font-bold text-accent uppercase tracking-wider mt-auto">0 votes</div>
            </div>
            `;
        });

        // Redraw card
        const isRedraw = this.currentVote.selected === '__redraw__';
        cards.push(`
            <div onclick="rooms.castVote('__redraw__')" class="bg-dark-800 border-2 ${isRedraw ? 'border-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.3)]' : 'border-gray-700 hover:border-gray-500'} rounded-2xl p-4 transition cursor-pointer flex flex-col items-center justify-center group">
                <div class="w-full aspect-square bg-dark-700 rounded-xl mb-3 flex items-center justify-center">
                    <svg class="w-10 h-10 text-amber-500 ${isRedraw ? '' : 'opacity-50 group-hover:opacity-100'} transition" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                </div>
                <h3 class="text-sm font-bold text-amber-500 text-center">Redraw</h3>
                <p class="text-[10px] text-gray-500 text-center mb-2">New candidates</p>
                <div id="vote-count-__redraw__" class="text-[10px] font-bold text-accent uppercase tracking-wider mt-auto">0 votes</div>
            </div>
        `);

        container.innerHTML = cards.join('');
    },

    stopVote(winner) {
        if (this.voteCountdown) clearInterval(this.voteCountdown);
        this.voteCountdown = null;
        
        const overlay = document.getElementById('rooms-vote-overlay');
        // Show winner briefly
        const timerEl = document.getElementById('rooms-vote-timer');
        timerEl.textContent = "WINNER: " + winner.title;
        timerEl.classList.add('text-green-400');

        setTimeout(() => {
            overlay.classList.add('hidden');
            timerEl.classList.remove('text-green-400');
            this.currentVote = null;
            if (this.isHost) {
                window.playSong(winner.filename);
                // Auto-play once audio is loaded
                const audio = document.getElementById('audio');
                const onCanPlay = () => {
                    audio.removeEventListener('canplay', onCanPlay);
                    audio.play().then(() => {
                        document.getElementById('btn-play').textContent = '⏸ Pause';
                    }).catch(() => {});
                };
                audio.addEventListener('canplay', onCanPlay);
            }
        }, 3000);
    },

    updateTransportUI() {
        const canControl = !this.code;
        const controls = [
            'btn-play', 'btn-loop-a', 'btn-loop-b', 'btn-loop-clear', 'btn-loop-save',
            'speed-slider', 'quality-select'
        ];

        controls.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                if (canControl) {
                    el.removeAttribute('disabled');
                    el.style.opacity = '1';
                    el.style.pointerEvents = 'auto';
                    el.style.display = '';
                } else {
                    el.setAttribute('disabled', 'true');
                    el.style.display = 'none';
                }
            }
        });

        // Toggle "Pick Song" button — only show when a song is already playing
        const pickBtn = document.getElementById('rooms-btn-pick');
        if (pickBtn) {
            if ((this.isHost || this.settings.guest_transport) && typeof currentFilename !== 'undefined' && currentFilename) {
                pickBtn.classList.remove('hidden');
            } else {
                pickBtn.classList.add('hidden');
            }
        }
    },

    renderRoster() {
        const container = document.getElementById('rooms-roster');
        if (!container) return;

        const songInfo = window.highway ? highway.getSongInfo() : null;
        const arrangements = songInfo && songInfo.arrangements ? songInfo.arrangements : [];
        const defaultPaths = ['Lead', 'Rhythm', 'Bass', 'Combo'];

        container.innerHTML = this.roster.map(p => {
            const isMe = p.id === this.playerId;
            const canKick = this.isHost && !isMe && !p.is_host;

            let arrHtml;
            if (isMe) {
                // Use song arrangements if available, otherwise show default path preferences
                const options = arrangements.length > 1
                    ? arrangements.map(a => `<option value="${a.index}" data-name="${escapeHtml(a.name)}" ${a.name === (p.arrangement_name || 'Lead') ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')
                    : defaultPaths.map(name => `<option value="${name}" ${name === (p.arrangement_name || 'Lead') ? 'selected' : ''}>${name}</option>`).join('');
                arrHtml = `<select onchange="rooms.changeMyArrangement(this)" class="bg-dark-600 border border-gray-600 rounded px-1.5 py-0.5 text-[10px] text-gray-300 focus:outline-none focus:border-accent cursor-pointer">
                    ${options}
                </select>`;
            } else {
                arrHtml = `<span class="text-[10px] text-gray-500 truncate">${escapeHtml(p.arrangement_name || 'Lead')}</span>`;
            }

            return `
            <div class="player-row ${isMe ? 'border-accent/30 bg-accent/5' : ''} group">
                <div class="w-8 h-8 rounded-lg bg-dark-600 flex items-center justify-center text-xs font-bold text-gray-300">
                    ${escapeHtml(p.name.charAt(0).toUpperCase())}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between">
                        <p class="text-sm font-medium text-white truncate">${escapeHtml(p.name)} ${isMe ? '(You)' : ''}</p>
                        ${p.is_host ? '<span class="text-[9px] bg-accent/20 text-accent px-1.5 py-0.5 rounded uppercase font-bold">Host</span>' : ''}
                    </div>
                    ${arrHtml}
                </div>
                ${canKick ? `
                <button onclick="rooms.kickPlayer('${p.id}')" class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-900/30 text-red-500 rounded-lg transition" title="Kick Player">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7a4 4 0 11-8 0 4 4 0 018 0zM9 14a6 6 0 00-6 6v1h12v-1a6 6 0 00-6-6zM21 12h-6"/></svg>
                </button>
                ` : ''}
            </div>
            `;
        }).join('');
    },

    changeMyArrangement(selectEl) {
        const value = selectEl.value;
        const songInfo = window.highway ? highway.getSongInfo() : null;
        const arrangements = songInfo && songInfo.arrangements ? songInfo.arrangements : [];

        if (arrangements.length > 1 && !isNaN(parseInt(value))) {
            // Song loaded — switch arrangement by index
            const index = parseInt(value);
            const name = selectEl.options[selectEl.selectedIndex].dataset.name || selectEl.options[selectEl.selectedIndex].text;
            window.changeArrangement(index);
        } else {
            // No song or preference mode — broadcast preference name
            this.ws.send(JSON.stringify({
                type: 'player.arrangement',
                index: 0,
                name: value
            }));
        }
    },

    kickPlayer(id) {
        if (!this.isHost || !this.ws) return;
        if (confirm('Are you sure you want to kick this player?')) {
            this.ws.send(JSON.stringify({ type: 'player.kick', player_id: id }));
        }
    },

    leaveRoom(notify = true) {
        this.reconnectAttempts = 3; // prevent reconnect on intentional leave
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (notify && this.ws) this.ws.close();
        this.ws = null;
        this.code = null;
        this.isHost = false;
        this.reconnectAttempts = 0;
        this.stopRoomPanels();
        document.getElementById('rooms-lobby').classList.remove('hidden');
        document.getElementById('rooms-view').classList.add('hidden');
        this.updateNavIndicator();
        this.refreshRoomList();
    },

    updatePanels() {
        if (!this.isHost || !currentFilename) return;
        if (!this.settings.auto_layout) return;

        // Current remote players (excluding self)
        const remotePlayers = this.roster.filter(p => p.id !== this.playerId);

        // Group by arrangement — only one panel per unique arrangement
        const hostArrangement = this.roster.find(p => p.id === this.playerId);
        const hostArrName = hostArrangement ? hostArrangement.arrangement_name : 'Lead';
        const uniquePanels = [];
        const seen = new Set();
        // Skip players on same arrangement as host
        for (const p of remotePlayers) {
            const key = p.arrangement + ':' + p.arrangement_name;
            if (p.arrangement_name === hostArrName) continue; // same as host, no extra panel
            if (seen.has(key)) continue;
            seen.add(key);
            // Collect all player names on this arrangement
            const grouped = remotePlayers.filter(r => r.arrangement === p.arrangement && r.arrangement_name === p.arrangement_name);
            uniquePanels.push({ ...p, groupedNames: grouped.map(r => r.name) });
        }

        // Check if rebuild needed
        const needsRebuild = uniquePanels.length !== this.panels.length ||
            uniquePanels.some((p, i) => this.panels[i] && (p.arrangement !== this.panels[i].arrangement));

        if (needsRebuild) {
            this.rebuildPanels(uniquePanels);
        }
    },

    rebuildPanels(uniquePanels) {
        this.stopRoomPanels();
        if (uniquePanels.length === 0) return;

        console.log('[Rooms] Building panels for', uniquePanels.length, 'unique arrangements');

        // Create container wrapper — overlay only the highway canvas, not controls
        const mainHighway = document.getElementById('highway');
        const player = document.getElementById('player');
        const wrap = document.createElement('div');
        wrap.id = 'rooms-panels-wrap';
        // Position above highway but below controls (controls are at bottom with z-10 HUD on top)
        wrap.className = 'absolute left-0 right-0 top-0 z-[3] bg-dark-900 flex flex-wrap';
        // Height = player minus controls bar
        const controls = document.getElementById('player-controls');
        const controlsH = controls ? controls.offsetHeight : 48;
        wrap.style.bottom = controlsH + 'px';
        player.appendChild(wrap);

        // Hide main highway
        if (mainHighway) mainHighway.style.display = 'none';

        // Add host panel (panel 0)
        this.panels.push({
            playerId: this.playerId,
            hw: window.highway,
            container: null, // main highway is already there
            arrangement: 0 // managed by app.js
        });

        // Add unique arrangement panels (max 3 to fit quad)
        const panels = uniquePanels.slice(0, 3);
        panels.forEach((p, i) => {
            const panel = this.createPanel(p, wrap, panels.length + 1);
            this.panels.push(panel);
        });

        this.startTimeSync();
    },

    createPanel(player, wrap, totalPanels) {
        const container = document.createElement('div');
        container.className = 'relative border border-gray-800 overflow-hidden';
        
        // Layout sizing
        if (totalPanels === 2) {
            container.style.width = '100%';
            container.style.height = '50%';
        } else if (totalPanels === 3 || totalPanels === 4) {
            container.style.width = '50%';
            container.style.height = '50%';
        }

        const label = document.createElement('div');
        label.className = 'absolute top-2 left-2 z-10 bg-black/60 px-2 py-1 rounded text-[10px] text-gray-300 pointer-events-none';
        const names = player.groupedNames ? player.groupedNames.join(', ') : player.name;
        label.textContent = `${names} (${player.arrangement_name})`;
        container.appendChild(label);

        const canvas = document.createElement('canvas');
        canvas.className = 'w-full h-full';
        container.appendChild(canvas);
        wrap.appendChild(container);

        const hw = createHighway();
        
        // Override resize to stay within panel
        hw.resize = function() {
            const rect = container.getBoundingClientRect();
            canvas.width = rect.width * hw.getRenderScale();
            canvas.height = rect.height * hw.getRenderScale();
        };

        hw.init(canvas);
        const arrParam = player.arrangement !== undefined ? `?arrangement=${player.arrangement}` : '';
        const decoded = decodeURIComponent(currentFilename);
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        hw.connect(`${protocol}//${location.host}/ws/highway/${decoded}${arrParam}`);

        return {
            playerId: player.id,
            hw: hw,
            container: container,
            canvas: canvas,
            arrangement: player.arrangement
        };
    },

    startTimeSync() {
        if (this.panelSyncInterval) clearInterval(this.panelSyncInterval);
        const audio = document.getElementById('audio');
        this.panelSyncInterval = setInterval(() => {
            if (!audio) return;
            const t = audio.currentTime;
            this.panels.forEach(p => p.hw.setTime(t));
        }, 1000 / 60);
    },

    stopRoomPanels() {
        if (this.panelSyncInterval) {
            clearInterval(this.panelSyncInterval);
            this.panelSyncInterval = null;
        }

        // Keep index 0 (main highway) but stop others
        this.panels.forEach((p, i) => {
            if (i > 0) p.hw.stop();
        });
        this.panels = [];

        const wrap = document.getElementById('rooms-panels-wrap');
        if (wrap) wrap.remove();

        const mainHighway = document.getElementById('highway');
        if (mainHighway) mainHighway.style.display = '';
    },

    updateSettings() {
        if (!this.isHost || !this.ws) return;
        const settings = {
            voting: document.getElementById('rooms-setting-voting').checked,
            vote_timer: parseInt(document.getElementById('rooms-setting-timer').value),
            max_players: parseInt(document.getElementById('rooms-setting-max').value),
            guest_transport: document.getElementById('rooms-setting-guest-transport').checked,
            auto_advance: document.getElementById('rooms-setting-auto-advance').checked,
            auto_layout: document.getElementById('rooms-setting-auto-layout').checked,
            similarity_mode: document.getElementById('rooms-setting-similarity').value
        };
        this.ws.send(JSON.stringify({ type: 'settings.update', settings }));
        localStorage.setItem('rooms-default-settings', JSON.stringify(settings));
    },

    showSyncDebug(info) {
        let el = document.getElementById('rooms-sync-debug');
        if (!el) {
            el = document.createElement('div');
            el.id = 'rooms-sync-debug';
            el.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;background:rgba(0,0,0,0.85);color:#0f0;font-family:monospace;font-size:11px;padding:8px 12px;border-radius:6px;line-height:1.6;white-space:pre';
            document.body.appendChild(el);
        }
        el.innerHTML = `<span style="pointer-events:none">${[
            `${info.role} — ${info.how}`,
            `overshoot: ${info.overshoot}ms`,
            `wait: ${info.waitMs}ms`,
            `offset: ${info.offset}ms`,
            `latency: ${info.latency}ms`,
            `samples: ${info.samples}`
        ].join('\n')}</span>`;

        // Add/update slider for audioComp
        let row = document.getElementById('rooms-sync-slider-row');
        if (!row) {
            row = document.createElement('div');
            row.id = 'rooms-sync-slider-row';
            row.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:6px';
            const slider = document.createElement('input');
            slider.id = 'rooms-sync-slider';
            slider.type = 'range';
            slider.min = '0';
            slider.max = '150';
            slider.value = this.audioLatencyCompensation;
            slider.style.cssText = 'width:120px;accent-color:#0f0';
            const label = document.createElement('span');
            label.id = 'rooms-sync-slider-label';
            label.style.color = '#0f0';
            label.textContent = `comp: ${this.audioLatencyCompensation}ms`;
            slider.oninput = () => {
                this.audioLatencyCompensation = parseInt(slider.value);
                label.textContent = `comp: ${slider.value}ms`;
                // Resync — seek back to 0 and refire with new compensation
                const audio = document.getElementById('audio');
                audio.pause();
                audio.currentTime = 0;
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'song.resync' }));
                }
            };
            row.appendChild(slider);
            row.appendChild(label);
        }
        el.appendChild(row);

        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.remove(), 15000);
    }
};

// Initialize when script loads
rooms.init();
