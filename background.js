const MESSAGE_NICO_ACTION = "NICO_REPO2_NICO_ACTION";
const MESSAGE_X_RESULT = "NICO_REPO2_X_POST_RESULT";
const MESSAGE_X_START = "NICO_REPO2_X_POST_START";
const MESSAGE_MYLIST_PUBLIC_STATE = "NICO_REPO2_MYLIST_PUBLIC_STATE";
const MESSAGE_DIAGNOSTIC = "NICO_REPO2_DIAGNOSTIC";
const DEBUG = false;
const MOBILE_SYNC_ALARM_NAME = "NICO_REPO2_MOBILE_SYNC";
const DAILY_LIMIT_RESUME_ALARM_NAME = "NICO_REPO2_DAILY_LIMIT_RESUME";

const ACTION_LABELS = {
  like: "いいね！",
  mylist: "マイリスト",
  nicoad: "広告"
};

const LEGACY_DEFAULT_TEMPLATES = {
  like: [
    "【いいね】\n{title}\n{url}\n#音MAD #{videoId} #ニコニコ動画",
    "【いいね！】{title}\n{url}\n#音mad #{videoId} #ニコニコ動画"
  ],
  mylist: [
    "【マイリスト】\n{title}\n{url}\n#音MAD #{videoId} #ニコニコ動画",
    "【マイリスト】{title}\n{url}\n#音mad #{videoId} #ニコニコ動画"
  ],
  nicoad: [
    "【広告】\n{title}\n{url}\n#音MAD #{videoId} #ニコニコ動画",
    "【広告】{title}\n{url}\n#音mad #{videoId} #ニコニコ動画"
  ]
};

const DEFAULT_TEMPLATES = {
  like: "【いいね！】{title}\n{url}\n#{videoId} #ニコニコ動画",
  mylist: "【マイリスト】{title}\n{url}\n#{videoId} #ニコニコ動画",
  nicoad: "【広告】{title}\n{url}\n#{videoId} #ニコニコ動画"
};

const DEFAULT_SETTINGS = {
  enabled: true,
  targetTags: ["音MAD"],
  filterByTags: false,
  actionEnabled: {
    like: true,
    mylist: true,
    nicoad: false
  },
  closeXWindowAfterPost: true,
  useMinimizedPopup: true,
  dailyPostLimit: 25,
  deviceRestrictionRewrite: {
    enabled: true,
    actions: {
      like: true,
      mylist: true,
      nicoad: false
    }
  },
  mobileSync: {
    enabled: true,
    intervalMinutes: 5,
    maxItemsPerRun: 2,
    sources: {
      like: [
        "https://nvapi.nicovideo.jp/v1/users/me/likes?limit=50",
        "https://nvapi.nicovideo.jp/v1/users/me/likes/items?limit=50"
      ],
      mylist: [
        "https://nvapi.nicovideo.jp/v1/users/me/mylists?limit=100"
      ]
    }
  },
  templates: DEFAULT_TEMPLATES
};

const STORAGE_VERSION = "0.1.25";
const BROKEN_MOBILE_MYLIST_STORAGE_VERSION = "0.1.21";
const UNSAFE_MOBILE_LIKE_SOURCE_PATTERN = /^like:https:\/\/www\.nicovideo\.jp\/my\/(?:likes|history\/like)(?:[?#].*)?$/i;
const X_POPUP_WIDTH = 1;
const X_POPUP_HEIGHT = 1;
const X_POST_TIMEOUT_MS = 35000;
const QUEUED_ITEM_TTL_MS = 10 * 60 * 1000;
const ACTIVE_JOB_SOFT_STALE_MS = 10000;
const DEVICE_RESTRICTION_CHECK_TIMEOUT_MS = 1500;
const MYLIST_PUBLIC_STATE_FETCH_TIMEOUT_MS = 3000;
const MOBILE_SYNC_FAST_CONFIRM_DELAY_MS = 3000;
const MOBILE_SYNC_FAST_CONFIRM_REASON = "candidate-confirm";
const MOBILE_SYNC_RECENT_ITEMS_PER_MYLIST = 20;
const MOBILE_SYNC_MYLIST_FETCH_CONCURRENCY = 4;
const MOBILE_SYNC_TIMESTAMP_TOLERANCE_MS = 10 * 1000;
const LOG_LIMIT = 1000;
const DIAGNOSTIC_LOG_LIMIT = 200;

let isProcessingQueue = false;
let mobileSyncRunPromise = null;
const activeJobs = new Map();

chrome.runtime.onInstalled.addListener(() => {
  ensureStorageDefaults()
    .then(injectContentScriptsIntoOpenNicoTabs)
    .then(scheduleMobileSyncAlarm)
    .then(markStaleProcessingItemsAsFailed)
    .then(processQueue)
    .catch((error) => debugLog("install initialization failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  ensureStorageDefaults()
    .then(injectContentScriptsIntoOpenNicoTabs)
    .then(scheduleMobileSyncAlarm)
    .then(() => runMobileSync("startup"))
    .then(markStaleProcessingItemsAsFailed)
    .then(processQueue)
    .catch((error) => debugLog("startup initialization failed", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = String(changeInfo?.url || tab?.url || "");
  if (!changeInfo?.url || !isNicoPageUrl(url)) {
    return;
  }

  injectContentScriptsIntoNicoTab(tabId).catch((error) => {
    debugLog("content script reinjection after Nico URL change failed", tabId, error);
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  const tabId = activeInfo?.tabId;
  if (!Number.isInteger(tabId)) {
    return;
  }

  chromeTabsGet(tabId)
    .then((tab) => {
      if (isNicoPageUrl(tab?.url)) {
        return injectContentScriptsIntoNicoTab(tabId);
      }
      return undefined;
    })
    .catch((error) => {
      debugLog("content script reinjection after Nico tab activation failed", tabId, error);
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === MOBILE_SYNC_ALARM_NAME) {
    runMobileSync("alarm").catch((error) => debugLog("mobile sync failed", error));
  }

  if (alarm?.name === DAILY_LIMIT_RESUME_ALARM_NAME) {
    processQueue().catch((error) => debugLog("daily-limit queue resume failed", error));
  }
});

async function injectContentScriptsIntoOpenNicoTabs() {
  const tabs = await chromeTabsQuery({
    url: [
      "https://www.nicovideo.jp/*",
      "https://nicovideo.jp/*"
    ]
  });

  const results = await Promise.allSettled(
    tabs
      .filter((tab) => Number.isInteger(tab?.id) && isNicoPageUrl(tab.url))
      .map((tab) => injectContentScriptsIntoNicoTab(tab.id))
  );
  const failedCount = results.filter((result) => result.status === "rejected").length;
  if (failedCount > 0) {
    await recordDiagnostic("content-injection", "Failed to activate Nico monitoring in existing tabs", {
      title: `${failedCount} failed / ${results.length} checked`
    });
  }
}

async function injectContentScriptsIntoNicoTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  // Manifest content scripts do not run in tabs that were already open when
  // an unpacked extension was installed or reloaded. Inject the page bridge
  // first so network completion signals cannot be missed.
  await chromeScriptingExecuteScript({
    target: { tabId },
    files: ["page-nico-bridge.js"],
    world: "MAIN"
  });
  await chromeScriptingExecuteScript({
    target: { tabId },
    files: ["content-nico.js"]
  });
}

function isNicoPageUrl(value) {
  return /^https:\/\/(?:www\.)?nicovideo\.jp\//i.test(String(value || ""));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureStorageDefaults();

    if (!message || typeof message.type !== "string") {
      return { ok: false, error: "Unknown message" };
    }

    if (message.type === MESSAGE_NICO_ACTION) {
      return handleNicoAction(message.payload || {}, sender);
    }

    if (message.type === MESSAGE_X_RESULT) {
      return handleXPostResult(message.payload || {}, sender);
    }

    if (message.type === MESSAGE_MYLIST_PUBLIC_STATE) {
      return handleMylistPublicStateRequest(message.payload || {});
    }

    if (message.type === MESSAGE_DIAGNOSTIC) {
      return handleContentDiagnostic(message.payload || {});
    }

    return { ok: false, error: `Unsupported message type: ${message.type}` };
  })()
    .then((result) => sendResponse(result))
    .catch((error) => {
      debugLog("message handling failed", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.queue) {
    processQueue().catch((error) => debugLog("queue processing failed", error));
  }

  if (areaName === "local" && changes.settings) {
    scheduleMobileSyncAlarm()
      .then(() => runMobileSync("settings-change"))
      .catch((error) => debugLog("mobile sync reschedule failed", error));
    processQueue().catch((error) => debugLog("queue processing after settings change failed", error));
  }
});

async function handleNicoAction(payload, sender = {}) {
  await cleanupExpiredQueueItems();
  await cancelSoftStaleActiveJobs();

  const actionType = String(payload.actionType || "");
  if (!ACTION_LABELS[actionType]) {
    await recordDiagnostic("ignored", "Unknown action type", { actionType });
    return { ok: false, status: "ignored", reason: "Unknown action type" };
  }

  const settings = await getSettings();
  if (!settings.enabled) {
    await recordDiagnostic("ignored", "Extension disabled", { actionType });
    return { ok: true, status: "ignored", reason: "Extension disabled" };
  }

  if (!settings.actionEnabled[actionType]) {
    await recordDiagnostic("ignored", `Action disabled: ${actionType}`, { actionType });
    return { ok: true, status: "ignored", reason: `Action disabled: ${actionType}` };
  }

  const videoId = normalizeVideoId(payload.videoId);
  if (!videoId) {
    await recordDiagnostic("ignored", "Missing videoId", { actionType, url: payload.url || "" });
    return { ok: false, status: "ignored", reason: "Missing videoId" };
  }

  const tags = normalizeStringArray(payload.tags);
  const matchedVideoTag = findMatchedTargetTag(tags, settings.targetTags);
  if (settings.filterByTags && !matchedVideoTag) {
    await recordDiagnostic("ignored", "Target tag was not found", {
      actionType,
      videoId,
      title: payload.title || "",
      tags,
      targetTags: settings.targetTags
    });
    return { ok: true, status: "ignored", reason: "Target tag was not found" };
  }
  const matchedTargetTag = matchedVideoTag || getPrimaryTargetTag(settings);

  const duplicateKey = `${actionType}:${videoId}`;
  const alreadyPendingOrPosted = await hasDuplicateKey(duplicateKey);
  if (alreadyPendingOrPosted) {
    debugLog("duplicated action ignored", duplicateKey);
    await recordDiagnostic("ignored", "Duplicate key was already posted or queued", {
      actionType,
      videoId,
      duplicateKey
    });
    return { ok: true, status: "duplicated", duplicateKey };
  }

  const normalizedPayload = {
    actionType,
    videoId,
    title: sanitizeTitle(payload.title || videoId),
    url: normalizeNicoWatchUrl(videoId),
    tags,
    matchedTargetTag,
    authorName: sanitizeTitle(payload.authorName || "")
  };
  const text = buildPostText(normalizedPayload, settings);

  const queueItem = {
    id: createId(),
    duplicateKey,
    actionType,
    videoId,
    title: normalizedPayload.title,
    url: normalizedPayload.url,
    tags,
    matchedTargetTag,
    authorName: normalizedPayload.authorName,
    text,
    origin: inferActionOrigin(payload, sender),
    status: "queued",
    createdAt: new Date().toISOString()
  };

  await enqueue(queueItem);
  await recordDiagnostic("queued", "Action queued for X post", {
    actionType,
    videoId,
    title: queueItem.title,
    duplicateKey
  });
  processQueue().catch((error) => debugLog("queue processing failed", error));

  return { ok: true, status: "queued", duplicateKey, queueItemId: queueItem.id };
}

function inferActionOrigin(payload, sender) {
  const explicitOrigin = sanitizeTitle(payload.origin || "");
  if (explicitOrigin) {
    return explicitOrigin;
  }

  const senderUrl = String(sender?.tab?.url || "");
  if (/^https:\/\/(?:www\.)?nicovideo\.jp\//i.test(senderUrl)) {
    return "nico-content";
  }

  return "";
}

async function handleXPostResult(payload, sender) {
  const postId = String(payload.postId || payload.id || "");
  if (!postId) {
    return { ok: false, error: "Missing postId" };
  }

  const job = activeJobs.get(postId);
  if (!job) {
    debugLog("result for inactive job received", postId, payload);
    await finalizeInactiveResult(postId, payload, sender);
    return { ok: true, status: "inactive-result-recorded" };
  }

  clearTimeout(job.timeoutId);
  activeJobs.delete(postId);
  job.resolve({
    success: payload.success === true,
    reason: payload.reason || "",
    windowId: job.windowId,
    tabId: sender.tab?.id || job.tabId
  });

  return { ok: true };
}

async function processQueue() {
  if (isProcessingQueue) {
    return;
  }

  isProcessingQueue = true;
  try {
    while (true) {
      await cleanupExpiredQueueItems();
      await markStaleProcessingItemsAsFailed();

      const { settings, queue = [], postedLogs = [], xDailyPostUsage } = await getLocal([
        "settings",
        "queue",
        "postedLogs",
        "xDailyPostUsage"
      ]);
      const normalizedSettings = normalizeSettings(settings);
      const nextItem = queue.find((item) => item && item.status === "queued");

      if (!nextItem) {
        break;
      }

      const limitState = getDailyPostLimitState(
        normalizedSettings,
        postedLogs,
        xDailyPostUsage
      );
      if (limitState.reached) {
        await deferQueueForDailyLimit(queue, limitState);
        break;
      }

      await markQueueItem(nextItem.id, {
        status: "processing",
        processingStartedAt: new Date().toISOString(),
        notBefore: "",
        deferredReason: ""
      });

      const result = await postOneItem(nextItem, normalizedSettings);
      await finalizeQueueItem(result.finalItem || nextItem, result, normalizedSettings);
    }
  } finally {
    isProcessingQueue = false;
  }
}

async function postOneItem(item, settings) {
  const preparedItem = await prepareItemForPost(item, settings).catch((error) => {
    debugLog("device restriction preparation failed; normal URL will be used", error);
    return item;
  });
  if (preparedItem.text !== item.text || preparedItem.url !== item.url) {
    await markQueueItem(item.id, {
      text: preparedItem.text,
      url: preparedItem.url,
      originalUrl: preparedItem.originalUrl || item.url,
      deviceRestricted: preparedItem.deviceRestricted === true,
      deviceRestrictionReason: preparedItem.deviceRestrictionReason || ""
    });
  }

  let postWindow;
  try {
    postWindow = await createPostingWindow(preparedItem, settings);
  } catch (error) {
    debugLog("failed to create X popup window", error);
    return {
      success: false,
      reason: `X投稿用ウィンドウを作成できませんでした: ${error.message || String(error)}`,
      finalItem: preparedItem
    };
  }

  const tabId = postWindow.tabs && postWindow.tabs[0] ? postWindow.tabs[0].id : undefined;
  const resultPromise = waitForXPostResult(preparedItem, postWindow.id, tabId);

  if (typeof tabId === "number") {
    sendXStartMessage(tabId, preparedItem).catch((error) => {
      debugLog("failed to send X start message", error);
    });
  }

  return resultPromise.then((result) => ({ ...result, finalItem: preparedItem }));
}

async function createPostingWindow(item, settings) {
  const origins = ["https://x.com", "https://twitter.com"];
  const errors = [];
  const coverWindow = await getCoverWindow();

  for (const origin of origins) {
    const url = buildXIntentUrl(origin, item);
    const minimizedCreateData = buildSmallMinimizedPopupCreateData(url, coverWindow);
    const tinyCreateData = buildSmallPopupCreateData(url, coverWindow);
    const lastFallbackCreateData = {
      url,
      type: "popup",
      focused: false,
      width: X_POPUP_WIDTH,
      height: X_POPUP_HEIGHT
    };

    const attempts = settings.useMinimizedPopup
      ? [minimizedCreateData, tinyCreateData, lastFallbackCreateData]
      : [lastFallbackCreateData];

    for (const createData of attempts) {
      try {
        const createdWindow = await chromeWindowsCreate(createData);
        if (createData.state === "minimized") {
          await restoreMinimizedWindowSmall(createdWindow.id, coverWindow);
        } else {
          await refocusCoverWindow(coverWindow);
        }
        await refocusCoverWindow(coverWindow);
        return createdWindow;
      } catch (error) {
        errors.push(`${origin}: ${error.message || String(error)}`);
      }
    }
  }

  throw new Error(errors.join(" / "));
}

async function getCoverWindow() {
  try {
    const window = await chromeWindowsGetLastFocused();
    if (window && typeof window.id === "number") {
      return window;
    }
  } catch (error) {
    debugLog("could not get cover window", error);
  }
  return null;
}

function buildSmallMinimizedPopupCreateData(url, coverWindow) {
  return {
    ...buildSmallPopupCreateData(url, coverWindow),
    state: "minimized"
  };
}

function buildSmallPopupCreateData(url, coverWindow) {
  const width = X_POPUP_WIDTH;
  const height = X_POPUP_HEIGHT;

  if (coverWindow) {
    const coverLeft = typeof coverWindow.left === "number" ? coverWindow.left : 0;
    const coverTop = typeof coverWindow.top === "number" ? coverWindow.top : 0;
    const coverWidth = Math.max(width, coverWindow.width || width);
    const coverHeight = Math.max(height, coverWindow.height || height);

    return {
      url,
      type: "popup",
      focused: false,
      width,
      height,
      left: coverLeft + Math.max(0, coverWidth - width - 12),
      top: coverTop + Math.max(0, coverHeight - height - 12)
    };
  }

  return {
    url,
    type: "popup",
    focused: false,
    width,
    height
  };
}

async function restoreMinimizedWindowSmall(windowId, coverWindow) {
  if (typeof windowId !== "number") {
    return;
  }

  try {
    await refocusCoverWindow(coverWindow);
    await resizeWindowSmall(windowId, coverWindow);
    await chromeWindowsUpdate(windowId, { state: "normal" });
    await refocusCoverWindow(coverWindow);
    await resizeWindowSmall(windowId, coverWindow);
    await refocusCoverWindow(coverWindow);
  } catch (error) {
    debugLog("could not restore minimized X popup as small window", error);
  }
}

async function resizeWindowSmall(windowId, coverWindow) {
  if (typeof windowId !== "number" || !coverWindow) {
    return;
  }

  const width = X_POPUP_WIDTH;
  const height = X_POPUP_HEIGHT;
  const coverLeft = typeof coverWindow.left === "number" ? coverWindow.left : 0;
  const coverTop = typeof coverWindow.top === "number" ? coverWindow.top : 0;
  const coverWidth = Math.max(width, coverWindow.width || width);
  const coverHeight = Math.max(height, coverWindow.height || height);
  const updateInfo = {
    left: coverLeft + Math.max(0, coverWidth - width - 12),
    top: coverTop + Math.max(0, coverHeight - height - 12),
    width,
    height
  };

  try {
    await chromeWindowsUpdate(windowId, updateInfo);
  } catch (error) {
    debugLog("could not resize X popup as small window", error);
  }
}

async function refocusCoverWindow(coverWindow) {
  if (!coverWindow || typeof coverWindow.id !== "number") {
    return;
  }

  try {
    await chromeWindowsUpdate(coverWindow.id, { focused: true });
  } catch (error) {
    debugLog("could not refocus cover window", error);
  }
}

function waitForXPostResult(item, windowId, tabId) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      activeJobs.delete(item.id);
      resolve({
        success: false,
        reason: "X投稿処理がタイムアウトしました",
        windowId,
        tabId
      });
    }, X_POST_TIMEOUT_MS);

    activeJobs.set(item.id, {
      resolve,
      timeoutId,
      windowId,
      tabId,
      item,
      startedAt: Date.now()
    });
  });
}

async function cancelSoftStaleActiveJobs() {
  const now = Date.now();
  for (const [postId, job] of activeJobs.entries()) {
    if (!job.startedAt || now - job.startedAt < ACTIVE_JOB_SOFT_STALE_MS) {
      continue;
    }

    clearTimeout(job.timeoutId);
    activeJobs.delete(postId);
    job.resolve({
      success: false,
      reason: "新しい操作を優先するため、反応しないX投稿処理を停止しました",
      windowId: job.windowId,
      tabId: job.tabId
    });
  }
}

async function sendXStartMessage(tabId, item) {
  const deadline = Date.now() + 25000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await chromeTabsSendMessage(tabId, {
        type: MESSAGE_X_START,
        payload: {
          postId: item.id,
          text: item.text
        }
      });

      if (response?.ok) {
        return;
      }

      lastError = response?.error || "X content script returned a non-ok response";
    } catch (error) {
      lastError = error.message || String(error);
    }

    await delay(500);
  }

  throw new Error(lastError || "X content script did not respond");
}

async function finalizeInactiveResult(postId, payload, sender) {
  const { queue = [], settings } = await getLocal(["queue", "settings"]);
  const item = queue.find((entry) => entry && entry.id === postId);
  if (!item) {
    return;
  }

  await finalizeQueueItem(
    item,
    {
      success: payload.success === true,
      reason: payload.reason || "X側から遅延結果を受信しました",
      windowId: sender.tab?.windowId,
      tabId: sender.tab?.id
    },
    normalizeSettings(settings)
  );
}

async function finalizeQueueItem(item, result, settings) {
  const now = new Date().toISOString();
  const { postedKeys = [], postedLogs = [], failedLogs = [], queue = [], xDailyPostUsage } = await getLocal([
    "postedKeys",
    "postedLogs",
    "failedLogs",
    "queue",
    "xDailyPostUsage"
  ]);

  const nextQueue = queue.filter((entry) => entry && entry.id !== item.id);
  const nextData = { queue: nextQueue };

  if (result.success) {
    nextData.postedKeys = unique([...postedKeys, item.duplicateKey]);
    nextData.postedLogs = trimLog([
      ...postedLogs,
      {
        actionType: item.actionType,
        videoId: item.videoId,
        title: item.title,
        url: item.url,
        text: item.text,
        postedAt: now
      }
    ]);
    const usage = normalizeDailyPostUsage(xDailyPostUsage);
    const postedLogCount = countPostedLogsForLocalDay(postedLogs, usage.dayKey);
    nextData.xDailyPostUsage = {
      ...usage,
      count: Math.max(usage.count, postedLogCount) + 1
    };
    await recordDiagnostic("posted", "X post succeeded", {
      actionType: item.actionType,
      videoId: item.videoId,
      title: item.title
    });
  } else {
    nextData.failedLogs = trimLog([
      ...failedLogs,
      {
        actionType: item.actionType,
        videoId: item.videoId,
        title: item.title,
        url: item.url,
        text: item.text,
        failedAt: now,
        reason: result.reason || "Unknown failure"
      }
    ]);
    await recordDiagnostic("failed", result.reason || "X post failed", {
      actionType: item.actionType,
      videoId: item.videoId,
      title: item.title
    });
  }

  await setLocal(nextData);

  if (settings.closeXWindowAfterPost && typeof result.windowId === "number") {
    await safeRemoveWindow(result.windowId);
  }
}

async function markStaleProcessingItemsAsFailed() {
  const { queue = [], settings } = await getLocal(["queue", "settings"]);
  const staleItems = queue.filter((item) => {
    if (!item || item.status !== "processing") {
      return false;
    }
    const startedAt = Date.parse(item.processingStartedAt || item.createdAt || "");
    return Number.isNaN(startedAt) || Date.now() - startedAt > X_POST_TIMEOUT_MS;
  });

  for (const item of staleItems) {
    await finalizeQueueItem(
      item,
      {
        success: false,
        reason: "前回のX投稿処理が途中で停止またはタイムアウトしました"
      },
      normalizeSettings(settings)
    );
  }
}

async function cleanupExpiredQueueItems() {
  const { queue = [], settings, postedLogs = [], xDailyPostUsage } = await getLocal([
    "queue",
    "settings",
    "postedLogs",
    "xDailyPostUsage"
  ]);
  const normalizedSettings = normalizeSettings(settings);
  const limitState = getDailyPostLimitState(
    normalizedSettings,
    postedLogs,
    xDailyPostUsage
  );
  if (limitState.reached) {
    return;
  }

  const now = Date.now();
  const expiredItems = queue.filter((item) => {
    if (!item || item.status !== "queued") {
      return false;
    }
    if (item.deferredReason === "daily-limit") {
      return false;
    }
    const createdAt = Date.parse(item.createdAt || "");
    return Number.isNaN(createdAt) || now - createdAt > QUEUED_ITEM_TTL_MS;
  });

  for (const item of expiredItems) {
    await finalizeQueueItem(
      item,
      {
        success: false,
        reason: "古い未処理キューを自動破棄しました"
      },
      normalizedSettings
    );
  }
}

async function deferQueueForDailyLimit(queue, limitState) {
  const nextQueue = queue.map((item) => {
    if (!item || item.status !== "queued") {
      return item;
    }
    return {
      ...item,
      notBefore: limitState.nextResetAt,
      deferredReason: "daily-limit"
    };
  });

  const usage = normalizeDailyPostUsage(limitState.usage);
  const diagnosticKey = `${limitState.dayKey}:${limitState.limit}`;
  const nextData = {
    queue: nextQueue,
    xDailyPostUsage: {
      ...usage,
      count: limitState.count,
      lastLimitDiagnosticKey: diagnosticKey
    }
  };
  await setLocal(nextData);
  await scheduleDailyLimitResumeAlarm(limitState.nextResetAt);

  if (usage.lastLimitDiagnosticKey !== diagnosticKey) {
    await recordDiagnostic("daily-limit", "1日のX自動投稿上限に達したため、残りを翌日まで保留しました", {
      title: `${limitState.count} / ${limitState.limit}`,
      nextResetAt: limitState.nextResetAt
    });
  }
}

function getDailyPostLimitState(settings, postedLogs = [], usageValue = null, nowMs = Date.now()) {
  const usage = normalizeDailyPostUsage(usageValue, nowMs);
  const logCount = countPostedLogsForLocalDay(postedLogs, usage.dayKey);
  const count = Math.max(usage.count, logCount);
  const limit = normalizeDailyPostLimit(settings?.dailyPostLimit);
  const nextResetAt = getNextLocalDayStart(nowMs).toISOString();

  return {
    reached: count >= limit,
    count,
    limit,
    dayKey: usage.dayKey,
    nextResetAt,
    usage: {
      ...usage,
      count
    }
  };
}

function normalizeDailyPostUsage(value, nowMs = Date.now()) {
  const dayKey = getLocalDayKey(nowMs);
  const source = value && typeof value === "object" ? value : {};
  if (source.dayKey !== dayKey) {
    return {
      dayKey,
      count: 0,
      lastLimitDiagnosticKey: ""
    };
  }

  const count = Number(source.count);
  return {
    dayKey,
    count: Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0,
    lastLimitDiagnosticKey: String(source.lastLimitDiagnosticKey || "")
  };
}

function countPostedLogsForLocalDay(postedLogs, dayKey) {
  return (Array.isArray(postedLogs) ? postedLogs : []).filter((entry) => {
    const timestamp = Date.parse(entry?.postedAt || "");
    return Number.isFinite(timestamp) && getLocalDayKey(timestamp) === dayKey;
  }).length;
}

function getLocalDayKey(nowMs = Date.now()) {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getNextLocalDayStart(nowMs = Date.now()) {
  const date = new Date(nowMs);
  date.setHours(24, 0, 5, 0);
  return date;
}

async function scheduleDailyLimitResumeAlarm(nextResetAt) {
  const when = Date.parse(nextResetAt || "");
  if (!Number.isFinite(when)) {
    return;
  }
  await chromeAlarmsCreate(DAILY_LIMIT_RESUME_ALARM_NAME, {
    when: Math.max(Date.now() + 1000, when)
  });
}

async function enqueue(item) {
  const { queue = [] } = await getLocal(["queue"]);
  await setLocal({ queue: [...queue, item] });
}

async function markQueueItem(itemId, patch) {
  const { queue = [] } = await getLocal(["queue"]);
  const nextQueue = queue.map((item) => (item && item.id === itemId ? { ...item, ...patch } : item));
  await setLocal({ queue: nextQueue });
}

async function hasDuplicateKey(duplicateKey) {
  const { postedKeys = [], queue = [] } = await getLocal(["postedKeys", "queue"]);
  if (postedKeys.includes(duplicateKey)) {
    return true;
  }
  return queue.some((item) => item && item.duplicateKey === duplicateKey);
}

async function handleMylistPublicStateRequest(payload) {
  const mylistId = normalizeNumericId(payload.mylistId);
  if (!mylistId) {
    return { ok: false, publicState: "unknown", reason: "Missing mylistId" };
  }

  const publicState = await fetchOwnedMylistPublicState(mylistId);
  return { ok: true, publicState };
}

async function handleContentDiagnostic(payload) {
  const status = sanitizeTitle(payload.status || "content");
  const message = sanitizeTitle(payload.message || "Content script diagnostic");
  const details = payload.details && typeof payload.details === "object" ? payload.details : {};
  await recordDiagnostic(status, message, details);
  return { ok: true };
}

async function fetchOwnedMylistPublicState(mylistId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MYLIST_PUBLIC_STATE_FETCH_TIMEOUT_MS);

  try {
    const url = `https://nvapi.nicovideo.jp/v1/users/me/mylists/${mylistId}`;
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: buildNicoApiHeaders(url),
      signal: controller.signal
    });

    if (!response.ok) {
      await recordDiagnostic("mylist-public-state", `Mylist public state fetch failed: HTTP ${response.status}`, {
        title: `mylistId: ${mylistId}`
      });
    } else {
      const directState = getMylistPublicStateFromStructuredData(await response.json(), mylistId, true);
      if (directState !== "unknown") {
        return directState;
      }
    }
  } catch (error) {
    await recordDiagnostic("mylist-public-state", `Mylist public state fetch failed: ${error.message || String(error)}`, {
      title: `mylistId: ${mylistId}`
    });
  } finally {
    clearTimeout(timeoutId);
  }

  // Account and UI variants do not always expose the individual endpoint,
  // while the signed-in mylist index remains available.
  return fetchMylistPublicStateFromIndex(mylistId);
}

async function fetchMylistPublicStateFromIndex(mylistId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MYLIST_PUBLIC_STATE_FETCH_TIMEOUT_MS);

  try {
    const url = "https://nvapi.nicovideo.jp/v1/users/me/mylists?limit=100";
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: buildNicoApiHeaders(url),
      signal: controller.signal
    });

    if (!response.ok) {
      return "unknown";
    }

    return getMylistPublicStateFromStructuredData(await response.json(), mylistId, false);
  } catch (error) {
    debugLog("mylist public state index fallback failed", mylistId, error);
    return "unknown";
  } finally {
    clearTimeout(timeoutId);
  }
}

function runMobileSync(reason = "manual") {
  if (mobileSyncRunPromise) {
    return mobileSyncRunPromise;
  }

  mobileSyncRunPromise = runMobileSyncPass(reason).finally(() => {
    mobileSyncRunPromise = null;
  });
  return mobileSyncRunPromise;
}

async function runMobileSyncPass(reason = "manual") {
  const settings = await getSettings();
  if (!settings.enabled || !settings.mobileSync.enabled) {
    return { ok: true, status: "disabled" };
  }

  const sources = getMobileSyncSources();
  if (sources.length === 0) {
    await recordDiagnostic("mobile-sync", "No mobile sync sources configured", { reason });
    return { ok: true, status: "no-sources" };
  }

  const data = await getLocal([
    "mobileSyncSeenKeys",
    "mobileSyncCandidateKeys",
    "mobileSyncCandidateMeta",
    "mobileSyncInitializedSources",
    "mobileSyncKnownPublicMylistIds",
    "mobileSyncSnapshotEpoch",
    "mobileSyncMylistCheckpoints"
  ]);
  const seenKeys = new Set(normalizeStringArray(data.mobileSyncSeenKeys));
  const candidateKeys = new Set(normalizeStringArray(data.mobileSyncCandidateKeys));
  const candidateMeta = normalizeMobileSyncCandidateMeta(data.mobileSyncCandidateMeta, candidateKeys);
  const initializedSources = new Set(normalizeStringArray(data.mobileSyncInitializedSources));
  const knownPublicMylistIds = new Set(
    normalizeStringArray(data.mobileSyncKnownPublicMylistIds).map(normalizeNumericId).filter(Boolean)
  );
  const mylistCheckpoints = normalizeMobileSyncMylistCheckpoints(data.mobileSyncMylistCheckpoints);
  const snapshotEpochMs = getMobileSyncSnapshotEpochMs(data.mobileSyncSnapshotEpoch);
  const snapshotEpoch = new Date(snapshotEpochMs).toISOString();
  knownPublicMylistIds.forEach((mylistId) => {
    mylistCheckpoints[mylistId] = mylistCheckpoints[mylistId] || snapshotEpoch;
  });
  const nextSeenKeys = new Set(seenKeys);
  const nextCandidateKeys = new Set(candidateKeys);
  const nextCandidateMeta = { ...candidateMeta };
  const nextInitializedSources = new Set(initializedSources);
  const nextKnownPublicMylistIds = new Set(knownPublicMylistIds);
  const nextMylistCheckpoints = { ...mylistCheckpoints };
  const queuedResults = [];
  const diagnostics = [];
  let fetched = 0;
  let baselined = 0;
  let candidates = 0;

  for (const source of sources) {
    const sourceKey = `${source.actionType}:${source.url}`;
    let items = [];

    try {
      items = await fetchMobileSyncSourceItems(source);
    } catch (error) {
      const message = `Mobile sync source fetch failed: ${error.message || String(error)}`;
      diagnostics.push(message);
      await recordDiagnostic("mobile-sync", message, {
        actionType: source.actionType,
        url: source.url
      });
      continue;
    }

    fetched += items.length;
    const sourcePublicMylistIds = normalizeStringArray(items.publicMylistIds)
      .map(normalizeNumericId)
      .filter(Boolean);
    const successfulMylistCheckIds = normalizeStringArray(items.successfulMylistCheckIds)
      .map(normalizeNumericId)
      .filter(Boolean);
    const sourceCheckpointAt = new Date().toISOString();
    successfulMylistCheckIds.forEach((mylistId) => {
      nextMylistCheckpoints[mylistId] = sourceCheckpointAt;
    });
    const sourceKeys = items.map((item) => `${source.actionType}:${item.videoId}`);

    let newItems;
    const sourceWasInitialized = nextInitializedSources.has(sourceKey);
    if (!sourceWasInitialized) {
      if (sourceKeys.length === 0) {
        sourcePublicMylistIds.forEach((mylistId) => nextKnownPublicMylistIds.add(mylistId));
        await recordDiagnostic("mobile-sync", "Mobile sync source returned no videos; baseline was not created", {
          actionType: source.actionType,
          url: source.url
        });
        continue;
      }

      // An uninitialized source is always a baseline. API variants can omit
      // or alter registration timestamps, so posting during this pass can
      // incorrectly release historical entries.
      sourceKeys.forEach((key) => nextSeenKeys.add(key));
      sourcePublicMylistIds.forEach((mylistId) => nextKnownPublicMylistIds.add(mylistId));
      baselined += sourceKeys.length;
      nextInitializedSources.add(sourceKey);
      await recordDiagnostic("mobile-sync", "Mobile sync source baselined without posting", {
        actionType: source.actionType,
        title: `${sourceKeys.length} current items`,
        url: source.url
      });
      continue;
    } else {
      newItems = items.filter((item) => !nextSeenKeys.has(`${source.actionType}:${item.videoId}`));
    }

    // Each mylist owns its own successful-check checkpoint. A failure on one
    // list cannot advance or erase the pending difference for another list.
    if (source.actionType === "mylist") {
      const historicalNewListItems = newItems.filter(
        (item) =>
          !candidateKeys.has(`${source.actionType}:${item.videoId}`) &&
          !isUnseenMylistItemNew(
            item,
            mylistCheckpoints,
            snapshotEpochMs,
            sourceWasInitialized
          )
      );

      if (historicalNewListItems.length > 0) {
        historicalNewListItems.forEach((item) => {
          const key = `${source.actionType}:${item.videoId}`;
          nextSeenKeys.add(key);
          nextCandidateKeys.delete(key);
          delete nextCandidateMeta[key];
        });
        baselined += historicalNewListItems.length;
        newItems = newItems.filter((item) => !historicalNewListItems.includes(item));
        await recordDiagnostic("mobile-sync", "Historical items from newly discovered mylists were ignored", {
          actionType: source.actionType,
          title: `${historicalNewListItems.length} old / ${newItems.length} recent`,
          url: source.url
        });
      }
    }
    sourcePublicMylistIds.forEach((mylistId) => nextKnownPublicMylistIds.add(mylistId));

    const stableItems = newItems
      .filter((item) => candidateKeys.has(`${source.actionType}:${item.videoId}`))
      .slice(0, settings.mobileSync.maxItemsPerRun)
      .reverse();

    for (const item of stableItems) {
      const duplicateKey = `${source.actionType}:${item.videoId}`;
      nextSeenKeys.add(duplicateKey);
      nextCandidateKeys.delete(duplicateKey);
      delete nextCandidateMeta[duplicateKey];

      const title = cleanImportedTitle(item.title) || (await fetchNicoVideoTitle(item.videoId)) || item.videoId;
      const result = await handleNicoAction({
        actionType: source.actionType,
        videoId: item.videoId,
        title,
        url: normalizeNicoWatchUrl(item.videoId),
        tags: [],
        authorName: "",
        origin: "mobile-sync"
      });

      queuedResults.push({
        ...result,
        actionType: source.actionType,
        videoId: item.videoId,
        title
      });
    }

    for (const item of newItems) {
      const key = `${source.actionType}:${item.videoId}`;
      if (!nextSeenKeys.has(key)) {
        nextCandidateKeys.add(key);
        nextCandidateMeta[key] = nextCandidateMeta[key] || new Date().toISOString();
        candidates += 1;
      }
    }
  }

  const mobileSyncSeenKeys = Array.from(nextSeenKeys).slice(-2000);
  const mobileSyncCandidateKeys = Array.from(nextCandidateKeys).slice(-500);
  const mobileSyncInitializedSources = Array.from(nextInitializedSources).slice(-100);
  const mobileSyncKnownPublicMylistIds = Array.from(nextKnownPublicMylistIds).slice(-1000);
  const mobileSyncCandidateMeta = Object.fromEntries(
    mobileSyncCandidateKeys.map((key) => [key, nextCandidateMeta[key] || new Date().toISOString()])
  );
  const summary = {
    reason,
    checkedAt: new Date().toISOString(),
    queued: queuedResults.filter((result) => result?.status === "queued").length,
    duplicated: queuedResults.filter((result) => result?.status === "duplicated").length,
    sources: sources.length,
    fetched,
    baselined,
    candidates,
    diagnostics
  };

  await setLocal({
    mobileSyncSeenKeys,
    mobileSyncCandidateKeys,
    mobileSyncCandidateMeta,
    mobileSyncInitializedSources,
    mobileSyncKnownPublicMylistIds,
    mobileSyncMylistCheckpoints: nextMylistCheckpoints,
    mobileSyncLastSummary: summary
  });

  const shouldFastConfirmCandidates =
    reason !== MOBILE_SYNC_FAST_CONFIRM_REASON &&
    summary.queued === 0 &&
    mobileSyncCandidateKeys.length > 0;

  if (summary.queued > 0 || diagnostics.length > 0) {
    await recordDiagnostic("mobile-sync", "Mobile sync finished", {
      title: `${summary.queued} queued / ${summary.duplicated} duplicated / ${diagnostics.length} diagnostics`
    });
  }

  if (shouldFastConfirmCandidates) {
    await recordDiagnostic("mobile-sync", "Mobile sync candidates will be confirmed immediately", {
      title: `${mobileSyncCandidateKeys.length} candidates`
    });
    await delay(MOBILE_SYNC_FAST_CONFIRM_DELAY_MS);
    return runMobileSyncPass(MOBILE_SYNC_FAST_CONFIRM_REASON);
  }

  if (mobileSyncCandidateKeys.length > 0) {
    await scheduleMobileSyncAlarm(1);
  }

  return { ok: true, ...summary };
}

function getMobileSyncSources() {
  const sources = [];

  for (const actionType of ["like", "mylist"]) {
    const urls = unique(normalizeStringArray(DEFAULT_SETTINGS.mobileSync.sources[actionType]));
    for (const url of expandMobileSyncSourceUrls(actionType, urls)) {
      const normalizedUrl = normalizeMobileSyncSourceUrl(url);
      if (normalizedUrl) {
        sources.push({ actionType, url: normalizedUrl });
      }
    }
  }

  return sources;
}

function expandMobileSyncSourceUrls(actionType, urls) {
  const expandedUrls = [];

  for (const url of urls) {
    expandedUrls.push(url);
  }

  return unique(expandedUrls);
}

function normalizeMobileSyncSourceUrl(url) {
  try {
    const parsedUrl = new URL(String(url || "").trim());
    if (!/^https:$/.test(parsedUrl.protocol)) {
      return "";
    }

    if (!/(^|\.)nicovideo\.jp$/i.test(parsedUrl.hostname)) {
      return "";
    }

    parsedUrl.hash = "";
    return parsedUrl.href;
  } catch (error) {
    return "";
  }
}

async function fetchMobileSyncSourceItems(source) {
  if (source.actionType === "like" && !isTrustedMobileLikeSourceUrl(source.url)) {
    await recordDiagnostic("mobile-sync", "Unsafe HTML like source was skipped", {
      actionType: source.actionType,
      url: source.url
    });
    return [];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(source.url, {
      credentials: source.credentials === "omit" ? "omit" : "include",
      cache: "no-store",
      redirect: "follow",
      headers: buildNicoApiHeaders(source.url),
      signal: controller.signal
    });
    const html = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText || "fetch failed"}`);
    }

    if (/\/login|login_status["']?\s*:\s*["']?not_login/i.test(response.url) || /ログインしてください/u.test(html.slice(0, 5000))) {
      throw new Error("ニコニコにログインしていない可能性があります");
    }

    if (source.actionType === "like") {
      // いいね履歴のHTMLページにはおすすめ・関連動画リンクが混ざるため、
      // スマホ連携のいいねはログイン済みAPIの構造化データだけを信用する。
      return uniqueVideoItems([
        ...collectVideoItemsFromJsonText(html),
        ...collectVideoItemsFromServerResponse(html)
      ]).slice(0, 100);
    }

    if (source.actionType === "mylist" && isMylistIndexSource(source.url)) {
      const confirmedPublicMylistIds = collectPublicMylistIdsFromText(html);
      const mylistIds = unique([
        ...confirmedPublicMylistIds,
        ...collectOwnedMylistIdsFromText(html)
      ]);
      const confirmedPublicMylistIdSet = new Set(confirmedPublicMylistIds);
      const nestedItems = [];
      const resolvedPublicMylistIds = [];
      const successfulMylistCheckIds = [];
      const fetchResults = await mapWithConcurrency(
        mylistIds.slice(0, 100),
        MOBILE_SYNC_MYLIST_FETCH_CONCURRENCY,
        async (mylistId) => {
          try {
            const fetchResult = await fetchOwnedMylistItemsWithFallback(
              mylistId,
              confirmedPublicMylistIdSet.has(mylistId)
            );
            return { mylistId, ...fetchResult };
          } catch (error) {
            debugLog("mobile sync mylist item source skipped", mylistId, error);
            return {
              mylistId,
              confirmedPublic: false,
              items: [],
              error: error.message || String(error)
            };
          }
        }
      );

      for (const fetchResult of fetchResults) {
        if (!fetchResult?.confirmedPublic) {
          continue;
        }

        const mylistId = fetchResult.mylistId;
        resolvedPublicMylistIds.push(mylistId);
        if (fetchResult.fetched) {
          successfulMylistCheckIds.push(mylistId);
        }
        nestedItems.push(
          ...fetchResult.items.slice(0, MOBILE_SYNC_RECENT_ITEMS_PER_MYLIST).map((item) => ({
            ...item,
            mylistIds: unique([...normalizeStringArray(item.mylistIds), mylistId]),
            mylistEntries: mergeMylistEntries(item.mylistEntries, [{
              mylistId,
              addedAt: item.addedAt || ""
            }])
          }))
        );
      }

      const result = uniqueVideoItems(nestedItems);
      result.publicMylistIds = unique(resolvedPublicMylistIds);
      result.successfulMylistCheckIds = unique(successfulMylistCheckIds);
      await recordDiagnostic("mobile-sync", "Public mylist sources checked", {
        title: `${mylistIds.length} found / ${result.publicMylistIds.length} public / ${result.length} videos`
      });
      if (mylistIds.length === 0) {
        await recordDiagnostic("mobile-sync", "Mylist index contained no confirmed public mylists", {
          actionType: source.actionType,
          url: source.url
        });
      }
      return result;
    }

    let confirmedPublicMylist =
      source.confirmedPublicMylist === true || source.publicAccessConfirms === true;

    if (
      source.actionType === "mylist" &&
      isMylistItemSource(source.url) &&
      !confirmedPublicMylist
    ) {
      const mylistId = getMylistIdFromItemSourceUrl(source.url);
      const publicState = getMylistPublicStateFromText(html, mylistId);
      if (publicState !== "public") {
        await recordDiagnostic("mobile-sync", "Private or unverified mylist source was skipped", {
          actionType: source.actionType,
          mylistId,
          publicState,
          url: source.url
        });
        return [];
      }
      confirmedPublicMylist = true;
    } else if (
      source.actionType === "mylist" &&
      !isMylistIndexSource(source.url) &&
      !confirmedPublicMylist
    ) {
      await recordDiagnostic("mobile-sync", "Private or unverified mylist source was skipped", {
        actionType: source.actionType,
        url: source.url
      });
      return [];
    }

    const items = [
      ...collectVideoItemsFromJsonText(html),
      ...collectVideoItemsFromServerResponse(html),
      ...collectVideoItemsFromWatchLinks(html),
      ...collectVideoItemsFromPlainWatchUrls(html)
    ];

    const result = uniqueVideoItems(items).slice(0, 100);
    if (source.actionType === "mylist" && isMylistItemSource(source.url)) {
      result.confirmedPublicMylist = confirmedPublicMylist;
    }
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isTrustedMobileLikeSourceUrl(url) {
  try {
    const parsedUrl = new URL(String(url || ""));
    return (
      parsedUrl.hostname === "nvapi.nicovideo.jp" &&
      /\/v\d+\/users\/me\/likes(?:\/items)?\/?$/i.test(parsedUrl.pathname)
    );
  } catch (error) {
    return false;
  }
}

function isMylistIndexSource(url) {
  try {
    const parsedUrl = new URL(String(url || ""));
    return (
      parsedUrl.hostname === "nvapi.nicovideo.jp" &&
      /\/v\d+\/users\/me\/mylists\/?$/i.test(parsedUrl.pathname)
    );
  } catch (error) {
    return false;
  }
}

function isMylistItemSource(url) {
  try {
    const parsedUrl = new URL(String(url || ""));
    return (
      parsedUrl.hostname === "nvapi.nicovideo.jp" &&
      (
        /\/v\d+\/users\/me\/mylists\/\d+\/?$/i.test(parsedUrl.pathname) ||
        /\/v\d+\/mylists\/\d+\/?$/i.test(parsedUrl.pathname)
      )
    );
  } catch (error) {
    return false;
  }
}

function buildOwnedMylistItemsUrl(mylistId) {
  const normalizedId = normalizeNumericId(mylistId);
  if (!normalizedId) {
    return "";
  }
  const url = new URL(`https://nvapi.nicovideo.jp/v1/users/me/mylists/${normalizedId}`);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("page", "1");
  url.searchParams.set("sortKey", "addedAt");
  url.searchParams.set("sortOrder", "desc");
  return url.href;
}

function buildPublicMylistItemsUrl(mylistId) {
  const normalizedId = normalizeNumericId(mylistId);
  if (!normalizedId) {
    return "";
  }
  const url = new URL(`https://nvapi.nicovideo.jp/v2/mylists/${normalizedId}`);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("page", "1");
  url.searchParams.set("sortKey", "addedAt");
  url.searchParams.set("sortOrder", "desc");
  return url.href;
}

function getMylistIdFromItemSourceUrl(url) {
  try {
    const parsedUrl = new URL(String(url || ""));
    return normalizeNumericId(parsedUrl.pathname.match(/\/mylists\/(\d+)\/?$/i)?.[1]);
  } catch (error) {
    return "";
  }
}

async function fetchOwnedMylistItemsWithFallback(mylistId, indexConfirmedPublic) {
  const ownedSource = {
    actionType: "mylist",
    url: buildOwnedMylistItemsUrl(mylistId),
    confirmedPublicMylist: indexConfirmedPublic
  };
  const publicSource = {
    actionType: "mylist",
    url: buildPublicMylistItemsUrl(mylistId),
    credentials: "omit",
    publicAccessConfirms: true
  };
  const sources = indexConfirmedPublic
    ? [ownedSource, publicSource]
    : [publicSource, ownedSource];
  const errors = [];
  let publicConfirmed = indexConfirmedPublic === true;
  let fetched = false;

  for (const source of sources) {
    try {
      const items = await fetchMobileSyncSourceItems({
        ...source,
        confirmedPublicMylist: source.confirmedPublicMylist === true || publicConfirmed
      });
      fetched = true;
      if (items.confirmedPublicMylist === true) {
        publicConfirmed = true;
        if (items.length > 0) {
          return { confirmedPublic: true, fetched: true, items };
        }
      }
    } catch (error) {
      errors.push(`${source.url}: ${error.message || String(error)}`);
    }
  }

  if (errors.length > 0) {
    debugLog("all mobile sync mylist endpoints failed", mylistId, errors);
  }
  return { confirmedPublic: publicConfirmed, fetched, items: [], errors };
}

async function mapWithConcurrency(values, concurrency, worker) {
  const items = Array.isArray(values) ? values : [];
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(Number(concurrency) || 1))
  );
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function buildNicoApiHeaders(url) {
  const headers = {};
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === "nvapi.nicovideo.jp") {
      headers["X-Frontend-Id"] = "6";
      headers["X-Frontend-Version"] = "0";
      headers["X-Request-With"] = "https://www.nicovideo.jp";
    }
  } catch (error) {
    debugLog("failed to build nico api headers", error);
  }
  return headers;
}

function collectVideoItemsFromJsonText(text) {
  const value = String(text || "").trim();
  if (!value || !/^[\[{]/.test(value)) {
    return [];
  }

  try {
    return collectVideoItemsFromStructuredData(JSON.parse(value));
  } catch (error) {
    debugLog("mobile sync JSON parse skipped", error);
    return [];
  }
}

function collectVideoItemsFromServerResponse(html) {
  const serverResponse = parseServerResponseMeta(html);
  if (!serverResponse) {
    return [];
  }

  return collectVideoItemsFromStructuredData(serverResponse);
}

function collectPublicMylistIdsFromText(text) {
  const ids = [];
  const value = String(text || "").trim();

  if (/^[\[{]/.test(value)) {
    try {
      ids.push(...collectPublicMylistIdsFromStructuredData(JSON.parse(value)));
    } catch (error) {
      debugLog("mobile sync mylist JSON parse skipped", error);
    }
  }

  return unique(ids.map(normalizeNumericId));
}

function collectOwnedMylistIdsFromText(text) {
  const value = String(text || "").trim();
  if (!/^[\[{]/.test(value)) {
    return [];
  }

  try {
    return collectOwnedMylistIdsFromStructuredData(JSON.parse(value));
  } catch (error) {
    debugLog("mobile sync owned mylist JSON parse skipped", error);
    return [];
  }
}

function collectOwnedMylistIdsFromStructuredData(data) {
  const ids = [];
  const seenObjects = new WeakSet();

  const collectArray = (value) => {
    if (!Array.isArray(value)) {
      return;
    }
    value.forEach((item) => {
      const id = getMylistObjectId(item);
      if (id) {
        ids.push(id);
      }
    });
  };

  const visit = (value) => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) {
      return;
    }

    seenObjects.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (/^(?:mylists|my_lists|mylistGroups|mylist_groups)$/i.test(key)) {
        collectArray(child);
      }
      visit(child);
    }
  };

  visit(data);
  return unique(ids.map(normalizeNumericId));
}

function collectPublicMylistIdsFromStructuredData(data) {
  const ids = [];
  const seenObjects = new WeakSet();

  const visit = (value) => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) {
      return;
    }

    seenObjects.add(value);
    if (isExplicitPublicMylistObject(value)) {
      const id = getMylistObjectId(value);
      if (id) {
        ids.push(id);
      }
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    Object.keys(value).forEach((key) => visit(value[key]));
  };

  visit(data);
  return unique(ids);
}

function getMylistPublicStateFromText(text, targetMylistId = "") {
  const value = String(text || "").trim();
  if (!/^[\[{]/.test(value)) {
    return "unknown";
  }

  try {
    return getMylistPublicStateFromStructuredData(JSON.parse(value), targetMylistId, true);
  } catch (error) {
    debugLog("mobile sync mylist public state JSON parse skipped", error);
    return "unknown";
  }
}

function getMylistObjectId(value) {
  return normalizeNumericId(
    value.id ||
      value.mylistId ||
      value.mylist_id ||
      value.listId ||
      value.list_id ||
      value.groupId ||
      value.group_id
  );
}

function isExplicitPublicMylistObject(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (!getMylistObjectId(value)) {
    return false;
  }

  const publicCandidates = [
    value.isPublic,
    value.is_public,
    value.public,
    value.isOpen,
    value.is_open,
    value.isVisible,
    value.is_visible,
    value.isPublished,
    value.is_published,
    value.isPublicMylist,
    value.is_public_mylist
  ];

  if (publicCandidates.some((candidate) => candidate === true || candidate === 1 || candidate === "true" || candidate === "1")) {
    return true;
  }

  const privateCandidates = [
    value.isPrivate,
    value.is_private,
    value.isClosed,
    value.is_closed,
    value.private,
    value.closed,
    value.hidden
  ];

  if (privateCandidates.some((candidate) => candidate === false || candidate === 0 || candidate === "false" || candidate === "0")) {
    return true;
  }

  const visibility = String(
    value.visibility ||
      value.publicity ||
      value.status ||
      value.privacy ||
      value.scope ||
      value.mylistPublicity ||
      value.mylist_publicity ||
      ""
  ).toLowerCase();

  return /^(public|open|visible|published|1|true)$/.test(visibility);
}

function getMylistPublicStateFromStructuredData(data, targetMylistId = "", allowRootFallback = true) {
  const seenObjects = new WeakSet();
  const targetId = normalizeNumericId(targetMylistId);
  const exactStates = [];
  const rootStates = [];
  const allStates = [];

  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) {
      return;
    }

    seenObjects.add(value);
    const state = getMylistPublicStateFromObject(value);
    if (state !== "unknown") {
      allStates.push(state);
      if (depth <= 2) {
        rootStates.push(state);
      }
      if (targetId && getMylistObjectId(value) === targetId) {
        exactStates.push(state);
      }
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }

    Object.keys(value).forEach((key) => visit(value[key], depth + 1));
  };

  visit(data);

  const exactState = resolveMylistPublicStates(exactStates);
  if (exactState !== "unknown") {
    return exactState;
  }

  if (targetId && !allowRootFallback) {
    return "unknown";
  }

  const rootState = resolveMylistPublicStates(rootStates);
  return rootState !== "unknown" ? rootState : resolveMylistPublicStates(allStates);
}

function resolveMylistPublicStates(states) {
  const sawPrivate = states.includes("private");
  const sawPublic = states.includes("public");
  if (sawPrivate === sawPublic) {
    return "unknown";
  }
  return sawPrivate ? "private" : "public";
}

function getMylistPublicStateFromObject(value) {
  const publicCandidates = [
    value.isPublic,
    value.is_public,
    value.public,
    value.isOpen,
    value.is_open,
    value.isVisible,
    value.is_visible,
    value.isPublished,
    value.is_published,
    value.isPublicMylist,
    value.is_public_mylist
  ];

  if (publicCandidates.some((candidate) => candidate === false || candidate === 0 || candidate === "false" || candidate === "0")) {
    return "private";
  }

  if (publicCandidates.some((candidate) => candidate === true || candidate === 1 || candidate === "true" || candidate === "1")) {
    return "public";
  }

  const privateCandidates = [
    value.isPrivate,
    value.is_private,
    value.isClosed,
    value.is_closed,
    value.private,
    value.closed,
    value.hidden
  ];

  if (privateCandidates.some((candidate) => candidate === true || candidate === 1 || candidate === "true" || candidate === "1")) {
    return "private";
  }

  if (privateCandidates.some((candidate) => candidate === false || candidate === 0 || candidate === "false" || candidate === "0")) {
    return "public";
  }

  const visibility = String(
    value.visibility ||
      value.publicity ||
      value.status ||
      value.privacy ||
      value.scope ||
      value.mylistPublicity ||
      value.mylist_publicity ||
      ""
  ).toLowerCase();

  if (/^(private|closed|hidden|0|false)$/.test(visibility)) {
    return "private";
  }
  if (/^(public|open|visible|published|1|true)$/.test(visibility)) {
    return "public";
  }

  return "unknown";
}

function collectVideoItemsFromStructuredData(data) {
  const items = [];
  const seenObjects = new WeakSet();

  const visit = (value) => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) {
      return;
    }

    seenObjects.add(value);
    const videoId = normalizeVideoId(
      value.id ||
        value.videoId ||
        value.watchId ||
        value.contentId ||
        value.video?.id ||
        value.video?.videoId ||
        value.video?.watchId ||
        value.content?.id ||
        value.content?.videoId ||
        value.content?.watchId ||
        value.item?.id ||
        value.item?.videoId ||
        value.item?.watchId
    );
    const title = cleanImportedTitle(
      value.title ||
        value.name ||
        value.video?.title ||
        value.video?.name ||
        value.content?.title ||
        value.content?.name ||
        value.item?.title ||
        value.item?.name ||
        ""
    );
    const addedAt = normalizeMobileSyncTimestamp(
      value.addedAt ||
        value.added_at ||
        value.registeredAt ||
        value.registered_at ||
        value.mylistAddedAt ||
        value.mylist_added_at ||
        value.registrationDate ||
        value.registration_date ||
        ""
    );

    if (videoId) {
      items.push({
        videoId,
        title,
        url: normalizeNicoWatchUrl(videoId),
        ...(addedAt ? { addedAt } : {})
      });
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    Object.keys(value).forEach((key) => visit(value[key]));
  };

  visit(data);
  return items;
}

function collectVideoItemsFromWatchLinks(html) {
  const items = [];
  const pattern = /<a\b([^>]*?)href\s*=\s*["']([^"']*\/watch\/((?:sm|nm|so)\d+)[^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(String(html || "")))) {
    const videoId = normalizeVideoId(match[3]);
    if (!videoId) {
      continue;
    }

    const attributes = `${match[1] || ""} ${match[4] || ""}`;
    const titleFromAttr =
      getHtmlAttribute(`<a ${attributes}>`, "title") ||
      getHtmlAttribute(`<a ${attributes}>`, "aria-label") ||
      getHtmlAttribute(`<a ${attributes}>`, "data-title");
    const titleFromText = stripHtml(match[5] || "");

    items.push({
      videoId,
      title: cleanImportedTitle(titleFromAttr || titleFromText),
      url: normalizeNicoWatchUrl(videoId)
    });
  }

  return items;
}

function collectVideoItemsFromPlainWatchUrls(text) {
  const items = [];
  const pattern = /(?:https?:\/\/www\.nicovideo\.jp)?\/watch\/((?:sm|nm|so)\d+)/gi;
  let match;

  while ((match = pattern.exec(String(text || "")))) {
    const videoId = normalizeVideoId(match[1]);
    if (!videoId) {
      continue;
    }

    items.push({
      videoId,
      title: "",
      url: normalizeNicoWatchUrl(videoId)
    });
  }

  return items;
}

function uniqueVideoItems(items) {
  const itemIndexes = new Map();
  const uniqueItems = [];

  for (const item of items) {
    const videoId = normalizeVideoId(item?.videoId);
    if (!videoId) {
      continue;
    }

    const mylistIds = normalizeStringArray(item.mylistIds).map(normalizeNumericId).filter(Boolean);
    const mylistEntries = mergeMylistEntries(
      item.mylistEntries,
      mylistIds.map((mylistId) => ({
        mylistId,
        addedAt: item.addedAt || ""
      }))
    );
    if (itemIndexes.has(videoId)) {
      const existing = uniqueItems[itemIndexes.get(videoId)];
      existing.mylistIds = unique([...normalizeStringArray(existing.mylistIds), ...mylistIds]);
      existing.mylistEntries = mergeMylistEntries(existing.mylistEntries, mylistEntries);
      existing.addedAt = getLatestMobileSyncTimestamp([
        existing.addedAt,
        item.addedAt,
        ...existing.mylistEntries.map((entry) => entry.addedAt)
      ]);
      if (!existing.title && item.title) {
        existing.title = cleanImportedTitle(item.title);
      }
      continue;
    }

    itemIndexes.set(videoId, uniqueItems.length);
    uniqueItems.push({
      videoId,
      title: cleanImportedTitle(item.title),
      url: normalizeNicoWatchUrl(videoId),
      ...(mylistIds.length > 0 ? { mylistIds } : {}),
      ...(mylistEntries.length > 0 ? { mylistEntries } : {}),
      ...(normalizeMobileSyncTimestamp(item.addedAt)
        ? { addedAt: normalizeMobileSyncTimestamp(item.addedAt) }
        : {})
    });
  }

  return uniqueItems;
}

function mergeMylistEntries(...entryLists) {
  const entriesById = new Map();
  for (const entry of entryLists.flat()) {
    const mylistId = normalizeNumericId(entry?.mylistId);
    if (!mylistId) {
      continue;
    }
    const addedAt = normalizeMobileSyncTimestamp(entry?.addedAt);
    const current = entriesById.get(mylistId);
    entriesById.set(mylistId, {
      mylistId,
      addedAt: getLatestMobileSyncTimestamp([current?.addedAt, addedAt])
    });
  }
  return Array.from(entriesById.values());
}

function normalizeMobileSyncTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 100000000000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function getLatestMobileSyncTimestamp(values) {
  let latest = 0;
  for (const value of values) {
    const timestamp = Date.parse(normalizeMobileSyncTimestamp(value));
    if (Number.isFinite(timestamp) && timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : "";
}

function normalizeMobileSyncMylistCheckpoints(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([mylistId, checkedAt]) => [
        normalizeNumericId(mylistId),
        normalizeMobileSyncTimestamp(checkedAt)
      ])
      .filter(([mylistId, checkedAt]) => mylistId && checkedAt)
  );
}

function getMobileSyncSnapshotEpochMs(value) {
  const timestamp = Date.parse(normalizeMobileSyncTimestamp(value));
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function isUnseenMylistItemNew(item, checkpoints, snapshotEpochMs, sourceWasInitialized = false) {
  const entries = mergeMylistEntries(
    item?.mylistEntries,
    normalizeStringArray(item?.mylistIds).map((mylistId) => ({
      mylistId,
      addedAt: item?.addedAt || ""
    }))
  );
  if (entries.length === 0) {
    return false;
  }

  return entries.some((entry) => {
    const addedAtMs = Date.parse(String(entry.addedAt || item?.addedAt || ""));
    if (!Number.isFinite(addedAtMs)) {
      return false;
    }

    const checkpointMs = Date.parse(String(checkpoints[entry.mylistId] || ""));
    const cutoffMs = Number.isFinite(checkpointMs) ? checkpointMs : snapshotEpochMs;
    return addedAtMs >= cutoffMs - MOBILE_SYNC_TIMESTAMP_TOLERANCE_MS;
  });
}

function normalizeMylistEntries(entries) {
  return Array.isArray(entries) ? mergeMylistEntries(entries) : [];
}

async function prepareItemForPost(item, settings) {
  if (!shouldRewriteDeviceRestrictedUrl(item, settings)) {
    return item;
  }

  const detection = await detectDeviceRestrictionForXCard(item.videoId);
  if (!detection.restricted) {
    if (detection.reason) {
      await recordDiagnostic("device-check", detection.reason, {
        actionType: item.actionType,
        videoId: item.videoId,
        title: item.title
      });
    }
    return item;
  }

  const rewrittenUrl = normalizeNicoGayWatchUrl(item.videoId);
  const rewrittenPayload = {
    ...item,
    url: rewrittenUrl
  };
  const rewrittenText = buildPostText(rewrittenPayload, settings);

  await recordDiagnostic("rewritten", "Device-restricted URL was rewritten for X card", {
    actionType: item.actionType,
    videoId: item.videoId,
    title: item.title
  });

  return {
    ...item,
    url: rewrittenUrl,
    text: rewrittenText,
    originalUrl: item.url,
    deviceRestricted: true,
    deviceRestrictionReason: detection.reasonCode || "HARMFUL_VIDEO"
  };
}

function shouldRewriteDeviceRestrictedUrl(item, settings) {
  const rewriteSettings = settings.deviceRestrictionRewrite || DEFAULT_SETTINGS.deviceRestrictionRewrite;
  return (
    rewriteSettings.enabled === true &&
    rewriteSettings.actions?.[item.actionType] === true &&
    Boolean(normalizeVideoId(item.videoId))
  );
}

async function detectDeviceRestrictionForXCard(videoId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEVICE_RESTRICTION_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(normalizeNicoWatchUrl(videoId), {
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal
    });
    const html = await response.text();
    const serverResponse = parseServerResponseMeta(html);
    const responseBody = serverResponse?.response || serverResponse?.data?.response || {};
    const meta = serverResponse?.meta || {};
    const statusCode = Number(responseBody.statusCode || meta.status || response.status || 0);
    const errorCode = String(responseBody.errorCode || meta.code || "");
    const reasonCode = String(responseBody.reasonCode || "");
    const hasCardImage = hasXCardImageMeta(html);

    return {
      restricted:
        statusCode === 400 &&
        errorCode === "FORBIDDEN" &&
        reasonCode === "HARMFUL_VIDEO",
      statusCode,
      errorCode,
      reasonCode,
      hasCardImage,
      reason:
        reasonCode && reasonCode !== "HARMFUL_VIDEO"
          ? `Device restriction check skipped: ${reasonCode}`
          : ""
    };
  } catch (error) {
    const isAbort = error && error.name === "AbortError";
    return {
      restricted: false,
      reason: isAbort
        ? "Device restriction check timed out; normal URL was used"
        : `Device restriction check failed; normal URL was used: ${error.message || String(error)}`
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchNicoVideoTitle(videoId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(normalizeNicoWatchUrl(videoId), {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal
    });
    const html = await response.text();
    const serverResponse = parseServerResponseMeta(html);
    const candidates = [
      serverResponse?.response?.video?.title,
      serverResponse?.data?.response?.video?.title,
      serverResponse?.data?.metadata?.title,
      extractMetaContent(html, "og:title"),
      extractMetaContent(html, "twitter:title"),
      extractHtmlTitle(html)
    ];

    return candidates.map(cleanImportedTitle).find(Boolean) || "";
  } catch (error) {
    debugLog("import title fetch failed", videoId, error);
    return "";
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseServerResponseMeta(html) {
  const content = extractMetaContent(html, "server-response");
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    debugLog("server-response JSON parse failed", error);
    return null;
  }
}

function extractMetaContent(html, metaName) {
  const metaTags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const name = getHtmlAttribute(tag, "name") || getHtmlAttribute(tag, "property");
    if (String(name || "").toLowerCase() !== metaName.toLowerCase()) {
      continue;
    }

    return decodeHtmlAttribute(getHtmlAttribute(tag, "content"));
  }
  return "";
}

function extractHtmlTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlAttribute(match[1]) : "";
}

function stripHtml(html) {
  return decodeHtmlAttribute(
    String(html || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function getHtmlAttribute(tag, attributeName) {
  const pattern = new RegExp(
    `\\s${escapeRegExp(attributeName)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i"
  );
  const match = String(tag || "").match(pattern);
  if (!match) {
    return "";
  }
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function hasXCardImageMeta(html) {
  return /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image|thumbnail)["'][^>]*>/i.test(
    String(html || "")
  );
}

function buildPostText(payload, settings) {
  const template = settings.templates[payload.actionType] || DEFAULT_TEMPLATES[payload.actionType];
  const replacements = {
    actionLabel: ACTION_LABELS[payload.actionType] || payload.actionType,
    title: payload.title,
    url: payload.url,
    videoId: payload.videoId,
    targetTag: payload.matchedTargetTag || "",
    targetTagHash: payload.matchedTargetTag ? `#${payload.matchedTargetTag}` : "",
    authorName: payload.authorName || ""
  };

  const renderedText = String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match;
  });

  const fallbackText = buildDefaultPostText(payload);
  return isSanePostText(renderedText, payload) ? normalizePostText(renderedText) : fallbackText;
}

function buildDefaultPostText(payload) {
  const actionLabel = ACTION_LABELS[payload.actionType] || payload.actionType;
  return normalizePostText(`【${actionLabel}】${payload.title}
${payload.url}
#${payload.videoId} #ニコニコ動画`);
}

function isSanePostText(text, payload) {
  const value = normalizePostText(text);
  const videoTag = `#${payload.videoId}`;

  if (!value.includes(payload.title) || !value.includes(payload.url) || !value.includes(videoTag)) {
    return false;
  }

  if (!value.includes("#ニコニコ動画")) {
    return false;
  }

  return countOccurrences(value, videoTag) === 1 && countOccurrences(value, "#ニコニコ動画") === 1;
}

function normalizePostText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countOccurrences(value, needle) {
  if (!needle) {
    return 0;
  }

  return value.split(needle).length - 1;
}

function buildXIntentUrl(origin, item) {
  const url = new URL("/intent/tweet", origin);
  url.searchParams.set("text", item.text);
  url.searchParams.set("nicorepo2PostId", item.id);
  return url.href;
}

async function ensureStorageDefaults() {
  const current = await getLocal(null);
  const next = {};
  const isBrokenMobileMylistMigration =
    current.storageVersion === BROKEN_MOBILE_MYLIST_STORAGE_VERSION;
  const isUnsafeMobileLikeMigration = shouldMigrateUnsafeMobileLikeState(current);

  next.settings = normalizeSettings(current.settings || DEFAULT_SETTINGS);
  next.postedKeys = Array.isArray(current.postedKeys) ? current.postedKeys : [];
  next.postedLogs = Array.isArray(current.postedLogs) ? current.postedLogs : [];
  next.failedLogs = Array.isArray(current.failedLogs) ? current.failedLogs : [];
  next.diagnosticLogs = Array.isArray(current.diagnosticLogs) ? current.diagnosticLogs : [];
  next.xDailyPostUsage = normalizeDailyPostUsage(current.xDailyPostUsage);
  const currentQueue = Array.isArray(current.queue) ? current.queue.filter(Boolean) : [];
  next.queue = currentQueue.filter((item) => {
    if (isBrokenMobileMylistMigration && item?.origin === "mobile-sync" && item?.actionType === "mylist") {
      return false;
    }
    if (isUnsafeMobileLikeMigration && item?.origin === "mobile-sync" && item?.actionType === "like") {
      return false;
    }
    return true;
  });
  const currentSeenKeys = Array.isArray(current.mobileSyncSeenKeys)
    ? current.mobileSyncSeenKeys
    : [];
  next.mobileSyncSeenKeys = currentSeenKeys;
  const currentCandidateKeys = Array.isArray(current.mobileSyncCandidateKeys)
    ? current.mobileSyncCandidateKeys
    : [];
  next.mobileSyncCandidateKeys = currentCandidateKeys.filter((key) => {
    const value = String(key);
    if (isBrokenMobileMylistMigration && value.startsWith("mylist:")) {
      return false;
    }
    if (isUnsafeMobileLikeMigration && value.startsWith("like:")) {
      return false;
    }
    return true;
  });
  const currentCandidateMeta =
    current.mobileSyncCandidateMeta && typeof current.mobileSyncCandidateMeta === "object"
      ? current.mobileSyncCandidateMeta
      : {};
  next.mobileSyncCandidateMeta = Object.fromEntries(
    Object.entries(currentCandidateMeta).filter(([key]) => {
      const value = String(key);
      if (isBrokenMobileMylistMigration && value.startsWith("mylist:")) {
        return false;
      }
      if (isUnsafeMobileLikeMigration && value.startsWith("like:")) {
        return false;
      }
      return true;
    })
  );
  const currentInitializedSources = Array.isArray(current.mobileSyncInitializedSources)
    ? current.mobileSyncInitializedSources
    : [];
  next.mobileSyncInitializedSources = currentInitializedSources.filter((key) => {
    const value = String(key);
    if (isBrokenMobileMylistMigration && value.startsWith("mylist:")) {
      return false;
    }
    if (isUnsafeMobileLikeMigration && (value.startsWith("like:") || UNSAFE_MOBILE_LIKE_SOURCE_PATTERN.test(value))) {
      return false;
    }
    return true;
  });
  next.mobileSyncKnownPublicMylistIds = Array.isArray(current.mobileSyncKnownPublicMylistIds)
    ? current.mobileSyncKnownPublicMylistIds
    : [];
  next.mobileSyncSnapshotEpoch = isBrokenMobileMylistMigration
    ? new Date().toISOString()
    : normalizeMobileSyncTimestamp(current.mobileSyncSnapshotEpoch) || new Date().toISOString();
  next.mobileSyncMylistCheckpoints = isBrokenMobileMylistMigration
    ? {}
    : normalizeMobileSyncMylistCheckpoints(current.mobileSyncMylistCheckpoints);
  next.mobileSyncLastSummary =
    current.mobileSyncLastSummary && typeof current.mobileSyncLastSummary === "object"
      ? current.mobileSyncLastSummary
      : null;
  next.storageVersion = STORAGE_VERSION;

  const changedData = pickChangedStorageValues(current, next);
  if (Object.keys(changedData).length > 0) {
    await setLocal(changedData);
  }
}

function shouldMigrateUnsafeMobileLikeState(current) {
  if (!current || typeof current !== "object") {
    return false;
  }

  const initializedSources = Array.isArray(current.mobileSyncInitializedSources)
    ? current.mobileSyncInitializedSources
    : [];
  if (initializedSources.some((key) => UNSAFE_MOBILE_LIKE_SOURCE_PATTERN.test(String(key || "")))) {
    return true;
  }

  return Boolean(current.storageVersion && current.storageVersion !== STORAGE_VERSION);
}

async function getSettings() {
  const { settings } = await getLocal(["settings"]);
  return normalizeSettings(settings);
}

async function scheduleMobileSyncAlarm(delayInMinutes = 1) {
  const settings = await getSettings();
  await chromeAlarmsClear(MOBILE_SYNC_ALARM_NAME);

  if (!settings.enabled || !settings.mobileSync.enabled) {
    return;
  }

  await chromeAlarmsCreate(MOBILE_SYNC_ALARM_NAME, {
    delayInMinutes,
    periodInMinutes: settings.mobileSync.intervalMinutes
  });
}

function normalizeSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled,
    targetTags: parseTags(source.targetTags).length > 0 ? parseTags(source.targetTags) : [...DEFAULT_SETTINGS.targetTags],
    filterByTags: source.filterByTags === true,
    actionEnabled: {
      like: source.actionEnabled?.like !== false,
      mylist: source.actionEnabled?.mylist !== false,
      nicoad: false
    },
    closeXWindowAfterPost:
      typeof source.closeXWindowAfterPost === "boolean"
        ? source.closeXWindowAfterPost
        : DEFAULT_SETTINGS.closeXWindowAfterPost,
    useMinimizedPopup:
      typeof source.useMinimizedPopup === "boolean"
        ? source.useMinimizedPopup
        : DEFAULT_SETTINGS.useMinimizedPopup,
    dailyPostLimit: normalizeDailyPostLimit(source.dailyPostLimit),
    deviceRestrictionRewrite: normalizeDeviceRestrictionRewriteSettings(source.deviceRestrictionRewrite),
    mobileSync: normalizeMobileSyncSettings(source.mobileSync),
    templates: {
      like: normalizeTemplate(source.templates?.like, "like"),
      mylist: normalizeTemplate(source.templates?.mylist, "mylist"),
      nicoad: normalizeTemplate(source.templates?.nicoad, "nicoad")
    }
  };
}

function normalizeDailyPostLimit(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(1000, Math.max(1, Math.round(number)))
    : DEFAULT_SETTINGS.dailyPostLimit;
}

function normalizeMobileSyncSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const intervalMinutes = Number(source.intervalMinutes);
  const maxItemsPerRun = Number(source.maxItemsPerRun);

  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled
        : DEFAULT_SETTINGS.mobileSync.enabled,
    intervalMinutes: Number.isFinite(intervalMinutes)
      ? Math.min(60, Math.max(1, Math.round(intervalMinutes)))
      : DEFAULT_SETTINGS.mobileSync.intervalMinutes,
    maxItemsPerRun: Number.isFinite(maxItemsPerRun)
      ? Math.min(10, Math.max(1, Math.round(maxItemsPerRun)))
      : DEFAULT_SETTINGS.mobileSync.maxItemsPerRun,
    sources: {
      like: [...DEFAULT_SETTINGS.mobileSync.sources.like],
      mylist: [...DEFAULT_SETTINGS.mobileSync.sources.mylist]
    }
  };
}

function normalizeMobileSyncCandidateMeta(value, candidateKeys) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const now = new Date().toISOString();
  const result = {};

  for (const key of candidateKeys) {
    const timestamp = String(source[key] || "");
    result[key] = Number.isFinite(Date.parse(timestamp)) ? timestamp : now;
  }

  return result;
}

function normalizeDeviceRestrictionRewriteSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const sourceActions = source.actions && typeof source.actions === "object" ? source.actions : {};

  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled
        : DEFAULT_SETTINGS.deviceRestrictionRewrite.enabled,
    actions: {
      like:
        typeof sourceActions.like === "boolean"
          ? sourceActions.like
          : DEFAULT_SETTINGS.deviceRestrictionRewrite.actions.like,
      mylist: true,
      nicoad: false
    }
  };
}

function pickChangedStorageValues(current, next) {
  const changedData = {};
  Object.keys(next).forEach((key) => {
    if (!storageValueEquals(current?.[key], next[key])) {
      changedData[key] = next[key];
    }
  });
  return changedData;
}

function storageValueEquals(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch (error) {
    return false;
  }
}

function getPrimaryTargetTag(settings) {
  return normalizeStringArray(settings.targetTags)[0] || DEFAULT_SETTINGS.targetTags[0];
}

function normalizeTemplate(value, actionType) {
  const text = typeof value === "string" ? value : "";
  const legacyTemplates = Array.isArray(LEGACY_DEFAULT_TEMPLATES[actionType])
    ? LEGACY_DEFAULT_TEMPLATES[actionType]
    : [LEGACY_DEFAULT_TEMPLATES[actionType]];
  if (!text || legacyTemplates.includes(text)) {
    return DEFAULT_TEMPLATES[actionType];
  }
  return text;
}

function parseTags(input) {
  if (Array.isArray(input)) {
    return normalizeStringArray(input);
  }

  return String(input || "")
    .split(/[\n,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseSourceUrls(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[\n,，]/);
  return Array.from(
    new Set(
      values
        .map(normalizeMobileSyncSourceUrl)
        .filter(Boolean)
    )
  );
}

function normalizeStringArray(input) {
  return Array.from(
    new Set(
      (Array.isArray(input) ? input : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function findMatchedTargetTag(videoTags, targetTags) {
  const normalizedVideoTags = normalizeStringArray(videoTags);
  const normalizedTargetTags = normalizeStringArray(targetTags);
  const loweredVideoTags = new Map(normalizedVideoTags.map((tag) => [tag.toLowerCase(), tag]));

  for (const targetTag of normalizedTargetTags) {
    const match = loweredVideoTags.get(targetTag.toLowerCase());
    if (match) {
      return match;
    }

    const fuzzyMatch = normalizedVideoTags.find((videoTag) => isCompatibleTargetTag(videoTag, targetTag));
    if (fuzzyMatch) {
      return targetTag;
    }
  }

  return "";
}

function isCompatibleTargetTag(videoTag, targetTag) {
  const normalizedVideoTag = String(videoTag || "").trim().toLowerCase();
  const normalizedTargetTag = String(targetTag || "").trim().toLowerCase();

  if (!normalizedVideoTag || !normalizedTargetTag) {
    return false;
  }

  if (normalizedTargetTag === "音mad") {
    return normalizedVideoTag.includes("mad");
  }

  return normalizedVideoTag.includes(normalizedTargetTag);
}

function normalizeVideoId(videoId) {
  const value = String(videoId || "").trim();
  return /^[a-z]{2}\d+$/i.test(value) ? value : "";
}

function normalizeNumericId(value) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? text : "";
}

function normalizeNicoWatchUrl(videoId) {
  return `https://www.nicovideo.jp/watch/${videoId}`;
}

function normalizeNicoGayWatchUrl(videoId) {
  return `https://nicovideo.gay/watch/${videoId}`;
}

function sanitizeTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanImportedTitle(title) {
  const text = sanitizeTitle(title)
    .replace(/\s*[-‐ー–—]\s*ニコニコ動画\s*$/u, "")
    .replace(/\s*\|\s*ニコニコ動画\s*$/u, "")
    .trim();

  if (!text || text === "ニコニコ動画" || text.length > 180) {
    return "";
  }

  return text;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimLog(logs) {
  return logs.slice(Math.max(0, logs.length - LOG_LIMIT));
}

async function recordDiagnostic(status, message, details = {}) {
  const { diagnosticLogs = [] } = await getLocal(["diagnosticLogs"]);
  const nextLogs = [
    ...diagnosticLogs,
    {
      status,
      message,
      details,
      createdAt: new Date().toISOString()
    }
  ].slice(Math.max(0, diagnosticLogs.length + 1 - DIAGNOSTIC_LOG_LIMIT));

  await setLocal({ diagnosticLogs: nextLogs });
}

function createId() {
  if (self.crypto && typeof self.crypto.randomUUID === "function") {
    return self.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items || {});
    });
  });
}

function setLocal(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function chromeWindowsCreate(createData) {
  return new Promise((resolve, reject) => {
    chrome.windows.create(createData, (createdWindow) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(createdWindow);
    });
  });
}

function chromeWindowsGetLastFocused() {
  return new Promise((resolve, reject) => {
    chrome.windows.getLastFocused((window) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(window);
    });
  });
}

function chromeWindowsUpdate(windowId, updateInfo) {
  return new Promise((resolve, reject) => {
    chrome.windows.update(windowId, updateInfo, (updatedWindow) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(updatedWindow);
    });
  });
}

function chromeTabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function chromeTabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

function chromeTabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab || null);
    });
  });
}

function chromeScriptingExecuteScript(injection) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(injection, (results) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(results || []);
    });
  });
}

function chromeAlarmsCreate(name, alarmInfo) {
  try {
    chrome.alarms.create(name, alarmInfo);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

function chromeAlarmsClear(name) {
  return new Promise((resolve, reject) => {
    chrome.alarms.clear(name, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function safeRemoveWindow(windowId) {
  return new Promise((resolve) => {
    chrome.windows.remove(windowId, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        debugLog("could not close X popup window", error.message);
      }
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(...args) {
  if (DEBUG) {
    console.debug("[NicoRepo2]", ...args);
  }
}
