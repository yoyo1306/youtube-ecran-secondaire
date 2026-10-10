const SESSION_KEY = "managedWindows";

chrome.action.onClicked.addListener((tab) => {
  openVideoOnSecondaryDisplay(tab).catch(async (error) => {
    console.error(error);
    if (tab.id) {
      await showStatus(tab.id, "!", "#b00020", "Impossible de passer la vidéo en plein écran.");
    }
  });
});

chrome.windows.onBoundsChanged.addListener((win) => {
  onWindowBoundsChanged(win).catch((error) => console.error(error));
});

chrome.windows.onRemoved.addListener((windowId) => {
  forget(windowId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "return-to-primary" || !sender.tab?.windowId) return;
  leaveSecondaryFullscreen(sender.tab.windowId, true).catch((error) => console.error(error));
});

const leaving = new Set();

async function openVideoOnSecondaryDisplay(tab) {
  if (!tab.id || !tab.windowId || !isYouTubeVideo(tab.url)) {
    if (tab.id) {
      await showStatus(tab.id, "!", "#b00020", "Ouvre une vidéo YouTube, puis clique ici.");
    }
    return;
  }

  const displays = await chrome.system.display.getInfo();
  const target = displays.find((display) => !display.isPrimary);
  if (!target) {
    await showStatus(tab.id, "!", "#b00020", "Aucun écran secondaire détecté.");
    return;
  }

  const bounds = toBounds(target.bounds);
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  const home = await detachVideoTab(tab, bounds, siblings.length > 1);
  await moveWindowToBounds(home.videoWindowId, bounds);
  await delay(200);

  let fullscreenWindow = await chrome.windows.update(home.videoWindowId, {
    state: "fullscreen",
    focused: true,
  });

  if (!isOnDisplay(fullscreenWindow, bounds)) {
    await chrome.windows.update(home.videoWindowId, { state: "normal", focused: true });
    await moveWindowToBounds(home.videoWindowId, bounds);
    await delay(200);
    fullscreenWindow = await chrome.windows.update(home.videoWindowId, {
      state: "fullscreen",
      focused: true,
    });
  }

  if (!isOnDisplay(fullscreenWindow, bounds)) {
    await returnVideoTab({ ...home, tabId: tab.id });
    await showStatus(
      tab.id,
      "!",
      "#b00020",
      "Chrome a renvoyé le plein écran sur l'écran principal."
    );
    return;
  }

  await remember(home.videoWindowId, tab.id, home);
  await delay(200);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: setVideoCover,
    args: [true],
  });

  if (!result?.result?.ok) {
    await showStatus(tab.id, "!", "#b00020", "Plein écran déplacé, mais aucune vidéo trouvée.");
    return;
  }

  await showStatus(
    tab.id,
    "",
    "#188038",
    "Vidéo sur l'écran secondaire. Double-clic sur la vidéo pour revenir."
  );
}

function isYouTubeVideo(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.length > 1;
    if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return false;
    return /^\/(watch|shorts|live|embed)(\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function toBounds(bounds) {
  return {
    left: Math.round(bounds.left),
    top: Math.round(bounds.top),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

function isOnDisplay(win, bounds) {
  if (!win || typeof win.left !== "number" || typeof win.top !== "number") return true;
  const centerX = win.left + (win.width || bounds.width) / 2;
  const centerY = win.top + (win.height || bounds.height) / 2;
  return (
    centerX >= bounds.left &&
    centerX < bounds.left + bounds.width &&
    centerY >= bounds.top &&
    centerY < bounds.top + bounds.height
  );
}

async function moveWindowToBounds(windowId, bounds) {
  await chrome.windows.update(windowId, { state: "normal", focused: true });
  await chrome.windows.update(windowId, { focused: true, ...bounds });

  const placed = await chrome.windows.get(windowId);
  if (isOnDisplay(placed, bounds)) return;

  const width = Math.max(placed.width || bounds.width, bounds.width);
  const height = Math.max(placed.height || bounds.height, bounds.height);
  await chrome.windows.update(windowId, {
    focused: true,
    width,
    height,
    left: Math.round(bounds.left + bounds.width / 2 - width / 2),
    top: Math.round(bounds.top + bounds.height / 2 - height / 2),
  });
}

async function restoreWindow(windowId, original) {
  if (!original) return;
  const normal = {
    state: "normal",
    focused: true,
    left: original.left,
    top: original.top,
    width: original.width,
    height: original.height,
  };
  await chrome.windows.update(windowId, normal);
  if (original.state === "maximized") {
    await chrome.windows.update(windowId, { state: "maximized", focused: true });
  }
}

async function onWindowBoundsChanged(win) {
  const record = await lookup(win.id);
  if (!record) return;

  let state = win.state;
  if (!state) {
    try {
      state = (await chrome.windows.get(win.id)).state;
    } catch {
      await forget(win.id);
      return;
    }
  }

  if (state === "fullscreen") {
    if (!record.seenFullscreen) {
      record.seenFullscreen = true;
      await saveRecord(win.id, record);
    }
    return;
  }

  if (!record.seenFullscreen || Date.now() < record.readyAt) return;
  await leaveSecondaryFullscreen(win.id);
}

async function leaveSecondaryFullscreen(windowId, force = false) {
  if (leaving.has(windowId)) return;
  const record = await lookup(windowId);
  if (!record?.seenFullscreen) return;
  if (!force && Date.now() < record.readyAt) return;

  let current;
  try {
    current = await chrome.windows.get(windowId);
  } catch {
    await forget(windowId);
    return;
  }
  if (!force && current.state === "fullscreen") return;

  leaving.add(windowId);
  try {
    const paused = await readPaused(record.tabId);
    if (current.state === "fullscreen") {
      await chrome.windows.update(windowId, { state: "normal" });
    }
    await chrome.scripting
      .executeScript({
        target: { tabId: record.tabId },
        func: setVideoCover,
        args: [false],
      })
      .catch(() => {});
    await forget(windowId);
    await returnVideoTab(record.home, paused);
  } finally {
    leaving.delete(windowId);
  }
}

async function detachVideoTab(tab, bounds, hasOtherTabs) {
  if (!hasOtherTabs) {
    const original = await chrome.windows.get(tab.windowId);
    return {
      videoWindowId: tab.windowId,
      kind: "window",
      left: original.left,
      top: original.top,
      width: original.width,
      height: original.height,
      state: original.state,
    };
  }

  const created = await chrome.windows.create({
    tabId: tab.id,
    type: "normal",
    state: "normal",
    focused: true,
    ...bounds,
  });
  return {
    videoWindowId: created.id,
    kind: "tab",
    windowId: tab.windowId,
    index: tab.index,
  };
}

async function readPaused(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const player = document.querySelector("#movie_player");
        if (typeof player?.getPlayerState === "function") {
          const state = player.getPlayerState();
          return state !== 1 && state !== 3;
        }
        const video = document.querySelector("video.html5-main-video, #movie_player video, video");
        return !video || video.paused;
      },
    });
    return Boolean(result?.result);
  } catch {
    return false;
  }
}

async function returnVideoTab(home, paused) {
  if (!home?.tabId) return;
  if (home.kind === "tab") {
    try {
      await chrome.windows.get(home.windowId);
      await chrome.tabs.move(home.tabId, {
        windowId: home.windowId,
        index: home.index,
      });
      await focusVideoTab(home.tabId, home.windowId, paused);
    } catch {
      // La fenêtre d'origine est fermée : l'onglet reste seul sur l'écran secondaire.
    }
    return;
  }
  await restoreWindow(home.videoWindowId, home);
  await focusVideoTab(home.tabId, home.videoWindowId, paused);
}

async function focusVideoTab(tabId, windowId, paused) {
  await chrome.windows.update(windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: applyPlayback,
      args: [Boolean(paused)],
    })
    .catch(() => {});
}

function applyPlayback(paused) {
  const apply = () => {
    const player = document.querySelector("#movie_player");
    const video = document.querySelector("video.html5-main-video, #movie_player video, video");
    if (paused) {
      if (typeof player?.pauseVideo === "function") {
        try {
          player.pauseVideo();
        } catch {
          // Le lecteur peut déjà être en pause.
        }
      }
      video?.pause();
      return;
    }
    if (typeof player?.playVideo === "function") {
      try {
        player.playVideo();
      } catch {
        // Le lecteur YouTube peut refuser playVideo juste après le déplacement.
      }
    }
    if (video?.paused) video.play().catch(() => {});
  };
  apply();
  setTimeout(apply, 250);
}

async function remember(windowId, tabId, home) {
  await saveRecord(windowId, {
    tabId,
    home: { ...home, tabId },
    readyAt: Date.now() + 1200,
    seenFullscreen: true,
  });
}

async function saveRecord(windowId, record) {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const managed = stored[SESSION_KEY] || {};
  managed[String(windowId)] = record;
  await chrome.storage.session.set({ [SESSION_KEY]: managed });
}

async function lookup(windowId) {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return (stored[SESSION_KEY] || {})[String(windowId)] || null;
}

async function forget(windowId) {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const managed = stored[SESSION_KEY] || {};
  if (!managed[String(windowId)]) return;
  delete managed[String(windowId)];
  await chrome.storage.session.set({ [SESSION_KEY]: managed });
}

async function showStatus(tabId, text, color, title) {
  try {
    await chrome.action.setBadgeText({ text, tabId });
    await chrome.action.setBadgeBackgroundColor({ color, tabId });
    await chrome.action.setTitle({ title, tabId });
  } catch {
    // L'onglet a pu se fermer.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setVideoCover(enabled) {
  const STYLE_ID = "ecran-secondaire-style";
  const CSS = `
    html.ecran-secondaire,
    html.ecran-secondaire body {
      overflow: hidden !important;
      background: #000 !important;
    }
    html.ecran-secondaire ytd-masthead,
    html.ecran-secondaire #masthead-container,
    html.ecran-secondaire #masthead,
    html.ecran-secondaire tp-yt-app-drawer,
    html.ecran-secondaire ytd-mini-guide-renderer,
    html.ecran-secondaire #guide,
    html.ecran-secondaire #secondary,
    html.ecran-secondaire #related,
    html.ecran-secondaire ytd-watch-metadata,
    html.ecran-secondaire #below,
    html.ecran-secondaire #comments,
    html.ecran-secondaire #info,
    html.ecran-secondaire #meta {
      display: none !important;
    }
    html.ecran-secondaire #movie_player,
    html.ecran-secondaire #player-container,
    html.ecran-secondaire ytd-player,
    html.ecran-secondaire #player {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      z-index: 2147483646 !important;
      background: #000 !important;
    }
    html.ecran-secondaire .html5-video-container {
      width: 100% !important;
      height: 100% !important;
      max-height: none !important;
    }
    html.ecran-secondaire video {
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
      opacity: 0.9999 !important;
      transform: translateZ(0) !important;
    }
    html.ecran-secondaire .ytp-chrome-bottom,
    html.ecran-secondaire .ytp-chrome-top,
    html.ecran-secondaire .ytp-chrome-controls,
    html.ecran-secondaire .ytp-progress-bar-container,
    html.ecran-secondaire .ytp-time-display,
    html.ecran-secondaire .html5-video-player.ytp-autohide .ytp-chrome-bottom,
    html.ecran-secondaire .html5-video-player.ytp-autohide .ytp-chrome-top {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
  `;

  const video = document.querySelector("video.html5-main-video, #movie_player video, video");
  if (!enabled) {
    window.__ecranSecondaireDisabled = true;
    document.getElementById(STYLE_ID)?.remove();
    document.documentElement.classList.remove("ecran-secondaire");
    return { ok: true, mode: "removed" };
  }
  if (!video) return { ok: false, reason: "no-video" };

  window.__ecranSecondaireDisabled = false;
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = CSS;
  document.documentElement.classList.add("ecran-secondaire");

  if (!window.__ecranSecondaireListening) {
    window.__ecranSecondaireListening = true;
    window.addEventListener("resize", () => {
      if (window.__ecranSecondaireDisabled) return;
      document.documentElement.classList.add("ecran-secondaire");
    });
    document.addEventListener(
      "dblclick",
      (event) => {
        if (window.__ecranSecondaireDisabled) return;
        if (event.target.closest(".ytp-chrome-bottom, .ytp-chrome-top, .ytp-progress-bar-container, .ytp-popup")) {
          return;
        }
        const player = document.querySelector("#movie_player");
        if (player && !player.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        chrome.runtime.sendMessage({ type: "return-to-primary" });
      },
      true
    );
  }

  return { ok: true, mode: "css" };
}
