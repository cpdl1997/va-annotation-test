// Deploy-time settings. make_deploy.sh ships a production copy (ALLOW_DEV=false, BACKEND="worker").
window.STUDY = {
  BACKEND: "worker",                 // "worker" (production) | "local" (no server; dev/testing only, needs ALLOW_DEV)
  WORKER_URL: "https://pairwise-study.soumyasarkar.workers.dev",                   // e.g. https://pairwise-study.<account>.workers.dev
  PLAYLIST_SET: "main",             // "main" | "test" (the Worker keeps the sets apart and never issues the real code for "test")
  VIDEO_BASE_URL: "https://pub-7315fa539539426aaf26d4e6616725a7.r2.dev/videos/",
  PLAYLIST_BASE: "playlists/playlist_",   // playlists/playlist_<n>.json beside index.html
  ALLOW_DEV: false,                  // ?dev=1 tools (skip button, ?local, ?videos=, ?plbase=). MUST be false in production
  MIN_WIDTH: 1000,
  PRELOAD_AHEAD: 2,                 // trials whose clips are fetched in advance
  MIN_LOOPS: 2,                     // full loops each clip must play before the first answer unlocks
  HEARTBEAT_MS: 30000
};
