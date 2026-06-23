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

const DEBUG = false;
const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  bindElements();
  bindEvents();
  loadAndRender().catch((error) => {
    debugLog("options load failed", error);
    showStatus(`読み込みに失敗しました: ${error.message || String(error)}`, true);
  });
});

function bindElements() {
  [
    "saveButton",
    "enabled",
    "targetTags",
    "filterByTags",
    "actionLike",
    "actionMylist",
    "closeXWindowAfterPost",
    "useMinimizedPopup",
    "dailyPostLimit",
    "deviceRestrictionRewriteEnabled",
    "mobileSyncEnabled",
    "mobileSyncInterval",
    "mobileSyncMaxItems",
    "mobileSyncReset",
    "mobileSyncSummary",
    "templateLike",
    "templateMylist",
    "clearLogs",
    "clearQueue",
    "clearPostedKeys",
    "postedKeysSummary",
    "queueSummary",
    "postedLogs",
    "failedLogs",
    "diagnosticLogs",
    "status"
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function bindEvents() {
  elements.saveButton.addEventListener("click", () => {
    saveSettings().catch((error) => {
      debugLog("settings save failed", error);
      showStatus(`保存に失敗しました: ${error.message || String(error)}`, true);
    });
  });

  elements.clearLogs.addEventListener("click", async () => {
    await setLocal({ postedLogs: [], failedLogs: [], diagnosticLogs: [] });
    await loadAndRender();
    showStatus("ログを削除しました");
  });

  elements.clearPostedKeys.addEventListener("click", async () => {
    await setLocal({ postedKeys: [] });
    await loadAndRender();
    showStatus("投稿済みキーを削除しました");
  });

  elements.clearQueue.addEventListener("click", async () => {
    await setLocal({ queue: [] });
    await loadAndRender();
    showStatus("未処理キューを削除しました");
  });

  elements.mobileSyncReset.addEventListener("click", async () => {
    await setLocal({
      mobileSyncSeenKeys: [],
      mobileSyncCandidateKeys: [],
      mobileSyncCandidateMeta: {},
      mobileSyncInitializedSources: [],
      mobileSyncKnownPublicMylistIds: [],
      mobileSyncSnapshotEpoch: new Date().toISOString(),
      mobileSyncMylistCheckpoints: {},
      mobileSyncLastSummary: null
    });
    await loadAndRender();
    showStatus("スマホ連携の記録をリセットしました。次回確認で現在の一覧を基準化します。");
  });
}

async function loadAndRender() {
  await ensureDefaults();
  const data = await getLocal([
    "settings",
    "postedKeys",
    "postedLogs",
    "failedLogs",
    "diagnosticLogs",
    "queue",
    "mobileSyncSeenKeys",
    "mobileSyncCandidateKeys",
    "mobileSyncCandidateMeta",
    "mobileSyncInitializedSources",
    "mobileSyncKnownPublicMylistIds",
    "mobileSyncLastSummary"
  ]);
  const settings = normalizeSettings(data.settings);
  renderSettings(settings);
  renderPostedKeys(data.postedKeys || []);
  renderQueue(data.queue || []);
  renderLogs(data.postedLogs || [], data.failedLogs || [], data.diagnosticLogs || []);
  renderMobileSyncSummary(
    data.mobileSyncSeenKeys || [],
    data.mobileSyncCandidateKeys || [],
    data.mobileSyncInitializedSources || [],
    data.mobileSyncLastSummary
  );
}

async function saveSettings() {
  const settings = {
    enabled: elements.enabled.checked,
    targetTags: parseTags(elements.targetTags.value),
    filterByTags: elements.filterByTags.checked,
    actionEnabled: {
      like: elements.actionLike.checked,
      mylist: elements.actionMylist.checked,
      nicoad: false
    },
    closeXWindowAfterPost: elements.closeXWindowAfterPost.checked,
    useMinimizedPopup: elements.useMinimizedPopup.checked,
    dailyPostLimit: Number(elements.dailyPostLimit.value),
    deviceRestrictionRewrite: {
      enabled: elements.deviceRestrictionRewriteEnabled.checked,
      actions: {
        like: true,
        mylist: true,
        nicoad: false
      }
    },
    mobileSync: {
      enabled: elements.mobileSyncEnabled.checked,
      intervalMinutes: Number(elements.mobileSyncInterval.value),
      maxItemsPerRun: Number(elements.mobileSyncMaxItems.value),
      sources: structuredClone(DEFAULT_SETTINGS.mobileSync.sources)
    },
    templates: {
      like: elements.templateLike.value,
      mylist: elements.templateMylist.value,
      nicoad: DEFAULT_TEMPLATES.nicoad
    }
  };

  await setLocal({ settings: normalizeSettings(settings) });
  showStatus("保存しました");
}

function renderSettings(settings) {
  elements.enabled.checked = settings.enabled;
  elements.targetTags.value = settings.targetTags.join("\n");
  elements.filterByTags.checked = settings.filterByTags;
  elements.actionLike.checked = settings.actionEnabled.like;
  elements.actionMylist.checked = settings.actionEnabled.mylist;
  elements.closeXWindowAfterPost.checked = settings.closeXWindowAfterPost;
  elements.useMinimizedPopup.checked = settings.useMinimizedPopup;
  elements.dailyPostLimit.value = settings.dailyPostLimit;
  elements.deviceRestrictionRewriteEnabled.checked = settings.deviceRestrictionRewrite.enabled;
  elements.mobileSyncEnabled.checked = settings.mobileSync.enabled;
  elements.mobileSyncInterval.value = settings.mobileSync.intervalMinutes;
  elements.mobileSyncMaxItems.value = settings.mobileSync.maxItemsPerRun;
  elements.templateLike.value = settings.templates.like;
  elements.templateMylist.value = settings.templates.mylist;
}

function renderPostedKeys(postedKeys) {
  elements.postedKeysSummary.textContent =
    postedKeys.length > 0 ? `${postedKeys.length}件: ${postedKeys.slice(-20).join(", ")}` : "投稿済みキーはありません。";
}

function renderQueue(queue) {
  elements.queueSummary.textContent =
    queue.length > 0 ? `未処理キュー: ${queue.length}件` : "未処理キューはありません。";
}

function renderMobileSyncSummary(seenKeys, candidateKeys, initializedSources, lastSummary) {
  const parts = [];

  if (lastSummary?.checkedAt) {
    parts.push(`最終確認: ${formatDate(lastSummary.checkedAt)}`);
    parts.push(`取得: ${lastSummary.fetched || 0}件`);
    parts.push(`投稿追加: ${lastSummary.queued || 0}件`);
    if (lastSummary.baselined) {
      parts.push(`初回基準化: ${lastSummary.baselined}件`);
    }
    if (candidateKeys.length > 0) {
      parts.push(`確認待ち: ${candidateKeys.length}件`);
    }
    if (Array.isArray(lastSummary.diagnostics) && lastSummary.diagnostics.length > 0) {
      parts.push(`診断: ${lastSummary.diagnostics.length}件`);
    }
  } else {
    parts.push("まだ確認していません");
  }

  if (initializedSources.length > 0) {
    parts.push(`有効な取得元: ${initializedSources.length}件`);
  }

  if (seenKeys.length > 0) {
    parts.push(`記録済み: ${seenKeys.length}件`);
  }

  elements.mobileSyncSummary.textContent = parts.join(" / ");
}

function renderLogs(postedLogs, failedLogs, diagnosticLogs) {
  elements.postedLogs.innerHTML = "";
  elements.failedLogs.innerHTML = "";
  elements.diagnosticLogs.innerHTML = "";

  renderLogList(elements.postedLogs, postedLogs, "postedAt");
  renderLogList(elements.failedLogs, failedLogs, "failedAt");
  renderDiagnosticList(elements.diagnosticLogs, diagnosticLogs);
}

function renderLogList(container, logs, dateKey) {
  const recentLogs = [...logs].reverse().slice(0, 50);
  if (recentLogs.length === 0) {
    container.append(createEmptyLog());
    return;
  }

  for (const log of recentLogs) {
    const item = document.createElement("article");
    item.className = "log-item";

    const title = document.createElement("strong");
    title.textContent = `${formatAction(log.actionType)} / ${log.videoId || ""}`;

    const time = document.createElement("time");
    time.textContent = formatDate(log[dateKey]);

    const body = document.createElement("p");
    body.textContent = log.title || log.url || "";

    item.append(title, time, body);

    if (log.reason) {
      const reason = document.createElement("p");
      reason.className = "reason";
      reason.textContent = log.reason;
      item.append(reason);
    }

    container.append(item);
  }
}

function renderDiagnosticList(container, logs) {
  const recentLogs = [...logs].reverse().slice(0, 50);
  if (recentLogs.length === 0) {
    container.append(createEmptyLog());
    return;
  }

  for (const log of recentLogs) {
    const item = document.createElement("article");
    item.className = "log-item";

    const title = document.createElement("strong");
    title.textContent = `${log.status || ""}: ${log.message || ""}`;

    const time = document.createElement("time");
    time.textContent = formatDate(log.createdAt);

    const body = document.createElement("p");
    body.textContent = formatDiagnosticDetails(log.details || {});

    item.append(title, time, body);
    container.append(item);
  }
}

function formatDiagnosticDetails(details) {
  const parts = [];
  for (const key of ["actionType", "videoId", "title", "duplicateKey"]) {
    if (details[key]) {
      parts.push(`${key}: ${details[key]}`);
    }
  }
  if (Array.isArray(details.tags)) {
    parts.push(`tags: ${details.tags.join(", ")}`);
  }
  if (Array.isArray(details.targetTags)) {
    parts.push(`targetTags: ${details.targetTags.join(", ")}`);
  }
  return parts.join(" / ");
}

function createEmptyLog() {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "ログはありません。";
  return empty;
}

async function ensureDefaults() {
  const current = await getLocal(null);
  const next = {
    settings: normalizeSettings(current.settings),
    postedKeys: Array.isArray(current.postedKeys) ? current.postedKeys : [],
    postedLogs: Array.isArray(current.postedLogs) ? current.postedLogs : [],
    failedLogs: Array.isArray(current.failedLogs) ? current.failedLogs : [],
    diagnosticLogs: Array.isArray(current.diagnosticLogs) ? current.diagnosticLogs : [],
    xDailyPostUsage:
      current.xDailyPostUsage && typeof current.xDailyPostUsage === "object"
        ? current.xDailyPostUsage
        : {},
    queue: Array.isArray(current.queue) ? current.queue : [],
    mobileSyncSeenKeys: Array.isArray(current.mobileSyncSeenKeys) ? current.mobileSyncSeenKeys : [],
    mobileSyncCandidateKeys: Array.isArray(current.mobileSyncCandidateKeys) ? current.mobileSyncCandidateKeys : [],
    mobileSyncCandidateMeta:
      current.mobileSyncCandidateMeta && typeof current.mobileSyncCandidateMeta === "object"
        ? current.mobileSyncCandidateMeta
        : {},
    mobileSyncInitializedSources: Array.isArray(current.mobileSyncInitializedSources)
      ? current.mobileSyncInitializedSources
      : [],
    mobileSyncKnownPublicMylistIds: Array.isArray(current.mobileSyncKnownPublicMylistIds)
      ? current.mobileSyncKnownPublicMylistIds
      : [],
    mobileSyncSnapshotEpoch:
      typeof current.mobileSyncSnapshotEpoch === "string" && current.mobileSyncSnapshotEpoch
        ? current.mobileSyncSnapshotEpoch
        : new Date().toISOString(),
    mobileSyncMylistCheckpoints:
      current.mobileSyncMylistCheckpoints &&
      typeof current.mobileSyncMylistCheckpoints === "object" &&
      !Array.isArray(current.mobileSyncMylistCheckpoints)
        ? current.mobileSyncMylistCheckpoints
        : {},
    mobileSyncLastSummary:
      current.mobileSyncLastSummary && typeof current.mobileSyncLastSummary === "object"
        ? current.mobileSyncLastSummary
        : null
  };
  const changedData = pickChangedStorageValues(current, next);
  if (Object.keys(changedData).length > 0) {
    await setLocal(changedData);
  }
}

function normalizeSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const targetTags = parseTags(source.targetTags);

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled,
    targetTags: targetTags.length > 0 ? targetTags : [...DEFAULT_SETTINGS.targetTags],
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
  const values = Array.isArray(input) ? input : String(input || "").split(/[\n,，]/);
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function parseSourceUrls(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[\n,，]/);
  return Array.from(
    new Set(
      values
        .map(normalizeSourceUrl)
        .filter(Boolean)
    )
  );
}

function normalizeSourceUrl(url) {
  try {
    const parsedUrl = new URL(String(url || "").trim());
    if (parsedUrl.protocol !== "https:") {
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

function formatAction(actionType) {
  return {
    like: "いいね！",
    mylist: "マイリスト",
    nicoad: "広告"
  }[actionType] || actionType || "";
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function showStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => {
    elements.status.textContent = "";
    elements.status.classList.remove("error");
  }, 3000);
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

function debugLog(...args) {
  if (DEBUG) {
    console.debug("[NicoRepo2]", ...args);
  }
}
