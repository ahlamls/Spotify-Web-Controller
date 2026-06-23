(function SpotifyWebControllerExtension() {
    // Wait for Spicetify APIs to be fully ready
    if (!window.Spicetify || !Spicetify.Player || !Spicetify.Queue || !Spicetify.Platform || !Spicetify.CosmosAsync) {
        setTimeout(SpotifyWebControllerExtension, 100);
        return;
    }

    console.log("Spotify Web Controller Extension: Loading...");

    let ws = null;
    let reconnectTimeout = null;
    let lastVolume = Spicetify.Player.getVolume();

    // ── Token Interceptor ────────────────────────────────────────────────────────
    // Silently capture client-token and authorization from Spotify's own fetch calls.
    // This is the cleanest way to get both tokens without hardcoding anything.
    let _capturedClientToken = null;
    let _capturedAccessToken = null;
    const _origFetch = window.fetch.bind(window);
    window.fetch = function(url, opts) {
        try {
            const urlStr = typeof url === 'string' ? url : (url?.url || '');
            if (urlStr.includes('api-partner.spotify.com')) {
                const h = opts?.headers || {};
                if (h['client-token']) _capturedClientToken = h['client-token'];
                if (h['authorization']) _capturedAccessToken = h['authorization'].replace('Bearer ', '');
            }
        } catch(_) {}
        return _origFetch(url, opts);
    };

    // Convert spotify image URIs to public HTTP URLs
    function getImageUrl(uri) {
        if (!uri) return '';
        if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
        if (uri.startsWith('spotify:image:')) {
            return 'https://i.scdn.co/image/' + uri.substring(14);
        }
        if (uri.startsWith('spotify:mosaic:')) {
            return 'https://mosaic.scdn.co/300/' + uri.substring(15);
        }
        if (/^[0-9a-fA-F]{40}$/.test(uri)) {
            return 'https://i.scdn.co/image/' + uri;
        }
        return uri;
    }

    // Helper to format track details
    function formatTrack(rawTrack) {
        if (!rawTrack) return null;
        
        // Handle newer Spicetify/Spotify wrapper where the track is inside contextTrack
        const track = rawTrack.contextTrack || rawTrack;
        
        if (track.uri === 'spotify:delimiter') return null;
        
        // Handle varying structures from Player vs Queue vs Cosmos API
        const title = track.name || track.title || (track.metadata && (track.metadata.title || track.metadata.name)) || 'Unknown Track';
        
        let artist = 'Unknown Artist';
        if (Array.isArray(track.artists)) {
            artist = track.artists.map(a => a.name || a.title).join(', ');
        } else if (track.artists) {
            artist = track.artists;
        } else if (track.artist) {
            artist = track.artist;
        } else if (track.metadata) {
            artist = track.metadata.artist_name || track.metadata.artist || 'Unknown Artist';
        }

        let album = '';
        if (track.album) {
            album = track.album.name || track.album.title || track.album || '';
        } else if (track.metadata) {
            album = track.metadata.album_title || track.metadata.album || '';
        }

        let albumArt = '';
        if (track.metadata) {
            albumArt = track.metadata.image_url || track.metadata.image_xlarge_url || track.metadata.image_large_url || '';
        }
        if (!albumArt && track.album && Array.isArray(track.album.images) && track.album.images.length > 0) {
            albumArt = track.album.images[0].url;
        }
        if (!albumArt && track.images && Array.isArray(track.images) && track.images.length > 0) {
            albumArt = track.images[0].url;
        }

        return {
            uri: track.uri || '',
            title: title,
            artist: artist,
            album: album,
            albumArt: getImageUrl(albumArt),
            uid: track.uid || rawTrack.uid || ''
        };
    }

    // Get current playback state
    function getPlaybackState() {
        try {
            const item = Spicetify.Player.data?.item;
            const progress = typeof Spicetify.Player.getProgress === 'function' ? Spicetify.Player.getProgress() : 0;
            const duration = typeof Spicetify.Player.getDuration === 'function' ? Spicetify.Player.getDuration() : 0;
            const isPlaying = typeof Spicetify.Player.isPlaying === 'function' ? Spicetify.Player.isPlaying() : false;
            const volume = typeof Spicetify.Player.getVolume === 'function' ? Spicetify.Player.getVolume() : 0.5;
            const shuffle = typeof Spicetify.Player.getShuffle === 'function' ? Spicetify.Player.getShuffle() : false;
            const repeat = typeof Spicetify.Player.getRepeat === 'function' ? Spicetify.Player.getRepeat() : 0;
            const heart = typeof Spicetify.Player.getHeart === 'function' ? Spicetify.Player.getHeart() : false;

            return {
                track: formatTrack(item),
                progress: progress,
                duration: duration,
                isPlaying: isPlaying,
                volume: volume,
                shuffle: shuffle,
                repeat: repeat,
                heart: heart
            };
        } catch (err) {
            console.error("Spotify Web Controller Extension: Error getting playback state:", err);
            return {
                track: null,
                progress: 0,
                duration: 0,
                isPlaying: false,
                volume: 0.5,
                shuffle: false,
                repeat: 0,
                heart: false
            };
        }
    }

    // Get current queue state
    function getQueueState() {
        try {
            if (!Spicetify.Queue) {
                return { current: null, next: [], nextInQueue: [], nextUp: [], prev: [] };
            }
            const nextTracks = Spicetify.Queue.nextTracks || [];
            const prevTracks = Spicetify.Queue.prevTracks || [];
            
            let nextInQueueRaw = [];
            let nextUpRaw = [];
            
            nextTracks.forEach(t => {
                if (!t) return;
                const track = t.contextTrack || t;
                if (track && track.uri === 'spotify:delimiter') {
                    return; // Skip delimiter
                }
                
                if (t.provider === 'queue') {
                    nextInQueueRaw.push(t);
                } else {
                    nextUpRaw.push(t);
                }
            });
            
            return {
                current: formatTrack(Spicetify.Queue.track),
                next: nextTracks.map(formatTrack).filter(Boolean).slice(0, 40),
                nextInQueue: nextInQueueRaw.map(formatTrack).filter(Boolean).slice(0, 40),
                nextUp: nextUpRaw.map(formatTrack).filter(Boolean).slice(0, 40),
                prev: prevTracks.slice(-10).map(formatTrack).filter(Boolean)
            };
        } catch (err) {
            console.error("Spotify Web Controller Extension: Error getting queue state:", err);
            return {
                current: null,
                next: [],
                nextInQueue: [],
                nextUp: [],
                prev: []
            };
        }
    }

    // Broadcast message helper
    function send(type, data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ type, data }));
            } catch (err) {
                console.error("Spotify Web Controller Extension: Failed to send WS message:", err);
                try {
                    ws.send(JSON.stringify({ type, error: err.message }));
                } catch(e) {}
            }
        }
    }

    // Send full update
    function broadcastFullState() {
        send('state', getPlaybackState());
        broadcastQueue();
    }

    // Send queue only
    function broadcastQueue() {
        send('queue', getQueueState());
    }

    // Connect to WebSocket Server
    function connect() {
        if (ws) {
            try { ws.close(); } catch(e) {}
        }

        console.log("Spotify Web Controller Extension: Connecting to server...");
        ws = new WebSocket("ws://localhost:8080/spotify");

        ws.onopen = () => {
            console.log("Spotify Web Controller Extension: Connected to server successfully!");
            // Send initial state
            broadcastFullState();
        };

        ws.onclose = () => {
            console.log("Spotify Web Controller Extension: Disconnected from server. Reconnecting in 3s...");
            scheduleReconnect();
        };

        ws.onerror = (err) => {
            console.error("Spotify Web Controller Extension: WebSocket error: ", err);
        };

        ws.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data);
                const { type, data } = message;

                console.log("Spotify Web Controller Extension: Received command", type, data);

                switch (type) {
                    case 'play':
                        Spicetify.Player.play();
                        break;
                    case 'play_track':
                        await Spicetify.Player.playUri(data);
                        break;
                    case 'pause':
                        Spicetify.Player.pause();
                        break;
                    case 'togglePlay':
                        Spicetify.Player.togglePlay();
                        break;
                    case 'next':
                        Spicetify.Player.next();
                        break;
                    case 'back':
                        Spicetify.Player.back();
                        break;
                    case 'seek':
                        // data is position in ms or percentage
                        Spicetify.Player.seek(data);
                        break;
                    case 'volume':
                        // data is volume float 0 to 1
                        Spicetify.Player.setVolume(data);
                        lastVolume = data;
                        broadcastFullState();
                        break;
                    case 'shuffle':
                        Spicetify.Player.setShuffle(data);
                        break;
                    case 'repeat':
                        Spicetify.Player.setRepeat(data);
                        break;
                    case 'toggleHeart':
                        Spicetify.Player.toggleHeart();
                        break;
                    case 'add_queue':
                        // data is track uri string or array
                        if (typeof data === 'string') {
                            await Spicetify.addToQueue([{ uri: data }]);
                        } else if (Array.isArray(data)) {
                            await Spicetify.addToQueue(data.map(uri => ({ uri })));
                        }
                        // Refresh queue
                        setTimeout(broadcastQueue, 300);
                        break;
                    case 'remove_queue':
                        // data is track object to remove { uri, uid }
                        if (data && data.uri) {
                            await Spicetify.removeFromQueue([data]);
                        }
                        // Refresh queue
                        setTimeout(broadcastQueue, 300);
                        break;
                    case 'reorder_queue':
                        // data is { track: { uri, uid }, insertBefore: { uri, uid } | null }
                        if (data && data.track) {
                            const trackToMove = { uri: data.track.uri || "", uid: data.track.uid };
                            let target = null;
                            if (data.insertBefore) {
                                target = { before: { uri: data.insertBefore.uri || "", uid: data.insertBefore.uid } };
                            }
                            try {
                                if (Spicetify.Platform?.PlayerAPI?.reorderQueue) {
                                    await Spicetify.Platform.PlayerAPI.reorderQueue([trackToMove], target);
                                } else {
                                    console.error("Spicetify Platform PlayerAPI reorderQueue is not available");
                                }
                            } catch (err) {
                                console.error("Error reordering queue:", err);
                            }
                        }
                        // Refresh queue
                        setTimeout(broadcastQueue, 300);
                        break;
                    case 'search':
                        // data is query string
                        searchSpotify(data);
                        break;
                    case 'request_state':
                        broadcastFullState();
                        break;
                }
            } catch (err) {
                console.error("Spotify Web Controller Extension: Failed to parse incoming WS message:", err);
            }
        };
    }

    function scheduleReconnect() {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connect, 3000);
    }

    // Simple cache to avoid redundant search requests
    const searchCache = new Map();
    const CACHE_TTL = 30000; // 30 seconds

    // Normalize a track from any Spotify response shape into a flat object
    function normalizeTrack(t) {
        if (!t) return null;
        const uri = t.uri || '';
        if (!uri || uri === 'spotify:delimiter') return null;

        const artists =
            (Array.isArray(t.artists) ? t.artists.map(a => a.profile?.name || a.name).filter(Boolean).join(', ') : '') ||
            t.artists?.items?.map(a => a.profile?.name || a.name).filter(Boolean).join(', ') ||
            t.artist || 'Unknown Artist';

        const albumArt =
            t.album?.images?.[0]?.url ||
            t.albumOfTrack?.coverArt?.sources?.[0]?.url || '';

        return {
            uri,
            title: t.name || 'Unknown Track',
            artist: artists,
            album: t.album?.name || t.albumOfTrack?.name || '',
            albumArt,
            duration: t.duration_ms || t.duration?.totalMilliseconds || 0
        };
    }

    // Parse any known Spotify GraphQL search response shape into a flat track list
    function parseTracksFromResponse(data) {
        if (!data) return [];

        // ── Primary path: searchSuggestions & searchModalResults ────────────────────
        // Response: data.searchV2.topResultsV2.itemsV2[{ __typename, item: { __typename, data } }]
        // Items are mixed (tracks, albums, podcasts, autocomplete) — filter tracks only.
        const topItems = data?.searchV2?.topResultsV2?.itemsV2 || [];
        if (topItems.length > 0) {
            const tracks = topItems
                .filter(h => h?.item?.__typename === 'TrackResponseWrapper')
                .map(h => normalizeTrack(h.item.data))
                .filter(Boolean);
            if (tracks.length > 0) return tracks;
        }

        // ── Fallback paths (other query shapes) ─────────────────────────────────────
        const rawItems =
            data?.searchV2?.tracksV2?.items ||
            data?.searchV2?.tracks?.items ||
            data?.searchSuggestions?.tracks?.items ||
            data?.search?.tracksV2?.items ||
            data?.search?.tracks?.items ||
            [];
        return rawItems.map(item => normalizeTrack(item?.item?.data || item?.data || item)).filter(Boolean);
    }

    // Build the exact POST request that Spotify Desktop sends to its partner API
    async function partnerAPISearch(operationName, hash, variables) {
        // Prefer the token captured by the interceptor (most fresh + has client-token)
        // Fall back to Spicetify.Platform.Session if nothing captured yet
        let token = _capturedAccessToken;
        if (!token) {
            let sess = Spicetify.Platform.Session.accessToken;
            if (typeof sess === 'function') sess = await sess();
            token = typeof sess === 'string' ? sess : (sess?.accessToken || sess?.token || '');
        }

        const headers = {
            'accept': 'application/json',
            'accept-language': 'en',
            'app-platform': 'OSX_ARM64',
            'authorization': `Bearer ${token}`,
            'content-type': 'application/json;charset=UTF-8',
        };
        // Include client-token if captured — required for full search results
        if (_capturedClientToken) headers['client-token'] = _capturedClientToken;

        const resp = await _origFetch('https://api-partner.spotify.com/pathfinder/v2/query', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                variables,
                operationName,
                extensions: { persistedQuery: { version: 1, sha256Hash: hash } }
            })
        });

        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
        }
        return await resp.json();
    }

    async function searchSpotify(query) {
        if (!query || query.trim() === '') {
            send('search_results', { query: '', tracks: [] });
            return;
        }

        const trimmed = query.trim();

        // Return cached result if still fresh (30s TTL)
        const cached = searchCache.get(trimmed);
        if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
            send('search_results', { query: trimmed, tracks: cached.tracks });
            return;
        }

        const cacheAndSend = (tracks) => {
            searchCache.set(trimmed, { tracks, ts: Date.now() });
            if (searchCache.size > 50) searchCache.delete(searchCache.keys().next().value);
            send('search_results', { query: trimmed, tracks });
        };

        // ── Primary: searchSuggestions (returns 200, confirmed working) ──────────────
        // Variables: query (not searchTerm!), includeAuthors required.
        // Hash: 556f5a15b2fdd3a7113ffd377ad9805e38a3a27b8bb1ca7d6d76bad54aa8ee12
        try {
            const json = await partnerAPISearch(
                'searchSuggestions',
                '556f5a15b2fdd3a7113ffd377ad9805e38a3a27b8bb1ca7d6d76bad54aa8ee12',
                { query: trimmed, limit: 15, numberOfTopResults: 15, offset: 0, includeAuthors: false, includeAlbumPreReleases: true, includeEpisodeContentRatingsV2: true }
            );
            if (json?.data) {
                const tracks = parseTracksFromResponse(json.data);
                send('debug', { msg: 'searchSuggestions', tracks: tracks.length, sample: JSON.stringify(json.data?.searchV2?.topResultsV2?.itemsV2?.slice(0,2)).slice(0,300) });
                if (tracks.length > 0) { cacheAndSend(tracks); return; }
            }
        } catch (e) {
            send('debug', { msg: 'searchSuggestions error', error: e.message });
        }

        // ── Fallback: searchModalResults (needs includeAuthors!) ─────────────────────
        // Hash: 5c10c8121738f9a0e7c685984d237cde29812448b2f87b8b94e85fb52f645fd0
        try {
            const json = await partnerAPISearch(
                'searchModalResults',
                '5c10c8121738f9a0e7c685984d237cde29812448b2f87b8b94e85fb52f645fd0',
                { searchTerm: trimmed, offset: 0, limit: 10, numberOfTopResults: 5, includeAudiobooks: false, includeAuthors: false }
            );
            if (json?.data) {
                const tracks = parseTracksFromResponse(json.data);
                send('debug', { msg: 'searchModalResults', tracks: tracks.length });
                if (tracks.length > 0) { cacheAndSend(tracks); return; }
            }
        } catch (e) {
            send('debug', { msg: 'searchModalResults error', error: e.message });
        }

        send('debug', { msg: 'all failed', hasToken: !!_capturedAccessToken, hasClientToken: !!_capturedClientToken });
        send('search_results', { query: trimmed, tracks: [] });
    }


    // Set up listeners for player state changes
    Spicetify.Player.addEventListener("songchange", () => {
        console.log("Spotify Web Controller Extension: songchange event");
        // Give Spotify a brief moment to update its internal Queue object
        setTimeout(broadcastFullState, 300);
    });

    Spicetify.Player.addEventListener("onplaypause", () => {
        console.log("Spotify Web Controller Extension: onplaypause event");
        broadcastFullState();
    });

    Spicetify.Player.addEventListener("onprogress", (event) => {
        // Send progress updates so slider is accurate, keep it small
        if (event && typeof event.data === 'number') {
            send('progress', { progress: event.data });
        } else {
            send('progress', { progress: Spicetify.Player.getProgress() });
        }
    });

    // Check volume and queue changes periodically
    let lastQueueRevision = '';
    let lastQueueUris = '';

    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            // 1. Check Volume changes
            const currentVolume = Spicetify.Player.getVolume();
            if (Math.abs(currentVolume - lastVolume) > 0.01) {
                lastVolume = currentVolume;
                send('volume_change', { volume: currentVolume });
            }

            // 2. Check Queue changes
            if (Spicetify.Queue) {
                const currentRevision = Spicetify.Queue.queueRevision || '';
                const nextTracks = Spicetify.Queue.nextTracks || [];
                const currentUris = nextTracks.slice(0, 30).map(t => t.uri).join(',');

                let hasChanged = false;
                if (currentRevision) {
                    if (currentRevision !== lastQueueRevision) {
                        lastQueueRevision = currentRevision;
                        hasChanged = true;
                    }
                } else {
                    if (currentUris !== lastQueueUris) {
                        lastQueueUris = currentUris;
                        hasChanged = true;
                    }
                }

                if (hasChanged) {
                    console.log("Spotify Web Controller Extension: Queue change detected");
                    broadcastQueue();
                }
            }
        }
    }, 1500);

    // Initial connection
    connect();
})();
