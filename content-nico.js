(() => {
  if (window.__nicoRepo2NicoContentLoaded) {
    return;
  }
  window.__nicoRepo2NicoContentLoaded = true;

  const DEBUG = false;
  const MESSAGE_NICO_ACTION = "NICO_REPO2_NICO_ACTION";
  const MESSAGE_MYLIST_PUBLIC_STATE = "NICO_REPO2_MYLIST_PUBLIC_STATE";
  const MESSAGE_DIAGNOSTIC = "NICO_REPO2_DIAGNOSTIC";
  const PAGE_BRIDGE_SOURCE = "NICO_REPO2_PAGE_BRIDGE";
  const PAGE_BRIDGE_MYLIST_REGISTERED = "NICO_REPO2_MYLIST_REGISTERED";
  const PAGE_BRIDGE_LIKE_REGISTERED = "NICO_REPO2_LIKE_REGISTERED";
  const PAGE_BRIDGE_DIAGNOSTIC = "NICO_REPO2_PAGE_DIAGNOSTIC";

  const DEFAULT_SETTINGS = {
    enabled: true,
    targetTags: ["音MAD"],
    filterByTags: false,
    actionEnabled: {
      like: true,
      mylist: true,
      nicoad: false
    }
  };

  const TAG_SELECTORS = [
    'a[href*="/tag/"]',
    'a[href*="/search/"][href*="tag"]',
    '[data-tag] a',
    '[data-tag]',
    '[class*="Tag"] a',
    '[class*="tag"] a',
    '[class*="Tag"] button',
    '[class*="tag"] button'
  ];

  const TITLE_SELECTORS = [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'h1[data-title]',
    'h1[class*="Title"]',
    '[class*="VideoTitle"]',
    '[class*="videoTitle"]',
    "h1"
  ];

  const AUTHOR_SELECTORS = [
    'meta[name="author"]',
    '[class*="OwnerName"]',
    '[class*="ownerName"]',
    '[class*="UserName"]',
    'a[href*="/user/"]'
  ];

  const ACTION_PATTERNS = {
    like: [/いいね|イイネ|LikeButton|\blike\b/i],
    mylist: [/マイリスト|mylist|Mylist|playlist/i],
    nicoad: [/ニコニ広告|広告|nicoad|uad/i]
  };

  const ACTION_SELECTORS = {
    like: [
      'button[aria-label*="いいね"]',
      'button[title*="いいね"]',
      '[role="button"][aria-label*="いいね"]',
      '[role="button"][title*="いいね"]',
      'button[class*="Like"]',
      '[role="button"][class*="Like"]',
      'button[data-testid*="like" i]',
      '[role="button"][data-testid*="like" i]'
    ],
    mylist: [
      'button[aria-label*="マイリスト"]',
      'button[title*="マイリスト"]',
      '[role="button"][aria-label*="マイリスト"]',
      '[role="button"][title*="マイリスト"]',
      '[role="menuitem"][aria-label*="マイリスト"]',
      '[role="menuitem"][title*="マイリスト"]',
      'button[class*="Mylist"]',
      '[role="button"][class*="Mylist"]',
      'button[data-testid*="mylist" i]',
      '[role="button"][data-testid*="mylist" i]'
    ],
    nicoad: [
      'button[aria-label*="広告"]',
      'button[title*="広告"]',
      '[role="button"][aria-label*="広告"]',
      '[role="button"][title*="広告"]',
      'button[class*="Nicoad"]',
      '[role="button"][class*="Nicoad"]'
    ]
  };

  const ACTIONABLE_SELECTOR = [
    "button",
    "a",
    '[role="button"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[tabindex]',
    'input[type="button"]',
    'input[type="submit"]'
  ].join(",");

  const NEGATIVE_ACTION_PATTERN =
    /確認|管理|一覧|集計|統計|分析|レポート|解除|取り消|取消|削除|外す|済み|unlike|remove|delete|already|confirm|check|summary|stats|analytics|report/i;
  const ACTIVE_LIKE_PATTERN =
    /aria-(?:pressed|checked|selected)=true|data-(?:pressed|active|selected|liked|is-liked|is_liked|isliked)=true|data-state=(?:on|active|selected|checked)|いいね(?:済み|済)|unlike|解除|取り消|取消/i;
  const MYLIST_CONFIRM_PATTERN = /^(登録する|追加する|登録|追加|保存|Add|Save|Register)$/iu;
  const MYLIST_ERROR_PATTERN = /失敗|エラー|できません|選択してください|入力してください/u;
  const RAW_EVENT_DEBOUNCE_MS = 800;
  const CLICK_DEBOUNCE_MS = 3000;
  const LIKE_CANDIDATE_TTL_MS = 2500;
  const LIKE_SUCCESS_WAIT_MS = 15000;
  const LIKE_CONTROL_MAX_WIDTH = 220;
  const LIKE_CONTROL_MAX_HEIGHT = 120;
  const MYLIST_SUCCESS_WAIT_MS = 30000;
  const MYLIST_PUBLIC_CONFIRM_GRACE_MS = 5000;
  const MYLIST_CONFIRM_CLOSE_FALLBACK_MS = 1200;
  const MYLIST_SUPPRESS_OTHER_ACTIONS_MS = 5000;
  const TAG_RETRY_WAIT_MS = 300;
  const URL_CHECK_INTERVAL_MS = 1000;

  const MYLIST_SUCCESS_SELECTORS = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live="polite"]',
    '[aria-live="assertive"]',
    '[class*="Toast"]',
    '[class*="toast"]',
    '[class*="Snackbar"]',
    '[class*="snackbar"]',
    '[class*="Notification"]',
    '[class*="notification"]'
  ];

  const MYLIST_SUCCESS_PATTERN =
    /マイリスト.{0,20}(登録|追加).{0,20}(しました|完了|成功)|(?:登録|追加).{0,20}(しました|完了).{0,20}マイリスト/u;
  const LIST_CONTEXT_TTL_MS = 30000;

  let settings = { ...DEFAULT_SETTINGS };
  let currentVideo = null;
  let lastListVideoContext = null;
  let lastUrl = location.href;
  let refreshTimer = 0;
  let pendingMylist = null;
  let pendingLike = null;
  let pendingLikeCandidate = null;
  let lastMylistStartedAt = 0;
  let lastTrustedActivationAt = 0;
  let settingsReadyPromise = Promise.resolve(settings);
  const recentRawEvents = new Map();
  const recentClicks = new Map();

  init().catch((error) => debugLog("content-nico initialization failed", error));

  async function init() {
    injectPageBridge();
    window.addEventListener("message", handlePageBridgeMessage);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes.settings) {
        settings = normalizeSettings(changes.settings.newValue);
      }
    });

    settingsReadyPromise = loadSettings()
      .then((loadedSettings) => {
        settings = loadedSettings;
        return settings;
      })
      .catch((error) => {
        debugLog("settings load failed; default settings will be used", error);
        return settings;
      });

    refreshCurrentVideo("initial");
    watchSpaNavigation();
    watchDomChanges();
    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    document.addEventListener("pointerup", handleDocumentActivation, true);
    document.addEventListener("click", handleDocumentActivation, true);
    document.addEventListener("keyup", handleDocumentKeyup, true);
  }

  function injectPageBridge() {
    try {
      if (document.documentElement?.dataset?.nicoRepo2BridgeInjected === "true") {
        return;
      }

      if (document.documentElement?.dataset) {
        document.documentElement.dataset.nicoRepo2BridgeInjected = "true";
      }

      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page-nico-bridge.js");
      script.async = false;
      script.onload = () => script.remove();
      script.onerror = () => script.remove();
      (document.head || document.documentElement || document).appendChild(script);
    } catch (error) {
      debugLog("page bridge injection failed", error);
    }
  }

  function handlePageBridgeMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== PAGE_BRIDGE_SOURCE) {
      return;
    }

    if (event.data.type === PAGE_BRIDGE_MYLIST_REGISTERED) {
      handleBridgeMylistRegistered(event.data.payload || {}).catch((error) => {
        debugLog("bridge mylist event handling failed", error);
      });
    }

    if (event.data.type === PAGE_BRIDGE_LIKE_REGISTERED) {
      handleBridgeLikeRegistered(event.data.payload || {}).catch((error) => {
        debugLog("bridge like event handling failed", error);
      });
    }

    if (event.data.type === PAGE_BRIDGE_DIAGNOSTIC) {
      const payload = event.data.payload || {};
      sendDiagnostic(payload.status || "page-bridge", payload.message || "Page bridge diagnostic", payload.details || {});
    }
  }

  async function handleBridgeLikeRegistered(payload) {
    await settingsReadyPromise;
    const videoId = normalizeVideoId(payload.videoId || payload.url || "");
    if (!videoId || !settings.enabled || !settings.actionEnabled.like) {
      return;
    }

    if (!isMatchingPendingLike(videoId)) {
      debugLog("bridge like event ignored because no matching user action was pending", payload);
      return;
    }

    const info = findVideoInfoInPage(videoId) || pendingLike.info || {
      videoId,
      title: videoId,
      url: `https://www.nicovideo.jp/watch/${videoId}`,
      tags: [],
      authorName: ""
    };

    pendingLike.sent = true;
    pendingLike = null;
    await handleDetectedAction("like", info.url, { ...info, videoId, url: `https://www.nicovideo.jp/watch/${videoId}` });
  }

  async function handleBridgeMylistRegistered(payload) {
    await settingsReadyPromise;
    const videoId = normalizeVideoId(payload.videoId || payload.url || "");
    if (!videoId || !settings.enabled || !settings.actionEnabled.mylist) {
      sendDiagnostic("content-mylist", "Bridge mylist event ignored before validation", {
        videoId,
        enabled: settings.enabled,
        actionEnabled: settings.actionEnabled.mylist,
        requestUrl: payload.requestUrl || "",
        mylistId: payload.mylistId || "",
        publicState: payload.publicState || ""
      });
      return;
    }

    if (isStaleBridgeMylistPayload(payload)) {
      debugLog("stale bridge mylist event ignored", payload);
      sendDiagnostic("content-mylist", "Stale bridge mylist event was ignored", {
        videoId,
        requestUrl: payload.requestUrl || "",
        mylistId: payload.mylistId || "",
        publicState: payload.publicState || "",
        pendingVideoId: pendingMylist?.videoId || "",
        pendingMylistId: pendingMylist?.mylistId || ""
      });
      return;
    }

    const matchedPending = isMatchingPendingMylist(videoId);
    if (!matchedPending && !canAcceptRecentBridgeMylist(videoId)) {
      debugLog("bridge mylist event ignored because no matching user action was pending", payload);
      sendDiagnostic("content-mylist", "Bridge mylist event ignored because no matching user action was pending", {
        videoId,
        requestUrl: payload.requestUrl || "",
        mylistId: payload.mylistId || "",
        publicState: payload.publicState || "",
        pendingVideoId: pendingMylist?.videoId || "",
        hasPending: Boolean(pendingMylist)
      });
      return;
    }

    const publicState = await resolveBridgeMylistPublicState(payload, pendingMylist?.publicState);
    if (publicState !== "public") {
      debugLog("mylist registration ignored because target mylist was not confirmed public", {
        videoId,
        publicState: publicState || "unknown"
      });
      sendDiagnostic("content-mylist", "Mylist registration ignored because target mylist was not confirmed public", {
        videoId,
        requestUrl: payload.requestUrl || "",
        mylistId: payload.mylistId || "",
        publicState: publicState || "unknown",
        payloadPublicState: payload.publicState || "",
        selectedPublicState: pendingMylist?.publicState || "unknown"
      });
      if (publicState === "private" && pendingMylist) {
        pendingMylist.sent = true;
        pendingMylist = null;
      }
      return;
    }

    const info = findVideoInfoInPage(videoId) || pendingMylist?.info || {
      videoId,
      title: videoId,
      url: `https://www.nicovideo.jp/watch/${videoId}`,
      tags: [],
      authorName: ""
    };

    if (pendingMylist) {
      pendingMylist.sent = true;
      pendingMylist = null;
    }
    sendDiagnostic("content-mylist", "Public mylist registration confirmed; action will be queued", {
      videoId,
      requestUrl: payload.requestUrl || "",
      mylistId: payload.mylistId || "",
      publicState
    });
    await handleDetectedAction("mylist", info.url, { ...info, videoId, url: `https://www.nicovideo.jp/watch/${videoId}` });
  }

  function isMatchingPendingMylist(videoId) {
    if (!pendingMylist || pendingMylist.sent) {
      return false;
    }

    if (Date.now() - pendingMylist.startedAt > MYLIST_SUCCESS_WAIT_MS) {
      pendingMylist = null;
      return false;
    }

    if (pendingMylist.videoId?.toLowerCase() === videoId.toLowerCase()) {
      return true;
    }

    // リストページではクリック位置から推定した動画IDがズレることがある。
    // 登録成功通信の videoId はニコニコ側が実際に登録した対象なので、直近のユーザー操作に対応していればそちらを優先する。
    if (pendingMylist.requiresBridge && findVideoInfoInPage(videoId)) {
      debugLog("bridge mylist videoId differed from pending context; using bridge videoId", {
        pending: pendingMylist.videoId,
        bridge: videoId
      });
      return true;
    }

    return false;
  }

  function isStaleBridgeMylistPayload(payload) {
    if (!pendingMylist || pendingMylist.sent) {
      return false;
    }

    const payloadMylistId = normalizeNumericId(payload.mylistId);
    if (pendingMylist.mylistId && payloadMylistId && pendingMylist.mylistId !== payloadMylistId) {
      return true;
    }

    const requestStartedAt = Number(payload.requestStartedAt || 0);
    if (!Number.isFinite(requestStartedAt) || requestStartedAt <= 0) {
      return false;
    }

    return requestStartedAt + 250 < pendingMylist.startedAt;
  }

  function canAcceptRecentBridgeMylist(videoId) {
    if (Date.now() - lastTrustedActivationAt > MYLIST_SUCCESS_WAIT_MS) {
      return false;
    }

    if (isWatchPage(location.href) && extractVideoId(location.href).toLowerCase() === videoId.toLowerCase()) {
      return true;
    }

    return Boolean(findVideoInfoInPage(videoId));
  }

  function isMatchingPendingLike(videoId) {
    if (!pendingLike || pendingLike.sent) {
      return false;
    }

    if (Date.now() - pendingLike.startedAt > LIKE_SUCCESS_WAIT_MS) {
      pendingLike = null;
      return false;
    }

    return pendingLike.videoId?.toLowerCase() === videoId.toLowerCase();
  }

  function handleDocumentPointerDown(event) {
    if (!event.isTrusted) {
      return;
    }
    lastTrustedActivationAt = Date.now();
    rememberListVideoContext(event.target);
    pendingLikeCandidate = buildLikeCandidateFromPointerDown(event.target);
  }

  function handleDocumentKeyup(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    handleDocumentActivation(event);
  }

  async function handleDocumentActivation(event) {
    if (!event.isTrusted) {
      return;
    }

    lastTrustedActivationAt = Date.now();
    const clickedUrl = location.href;
    rememberListVideoContext(event.target);

    if (pendingMylist) {
      rememberPendingMylistPublicState(event.target);
    }

    if (pendingMylist && isLikelyMylistConfirmActivation(event.target)) {
      pendingMylist.confirmedAt = Date.now();
      pendingMylist.confirmDialog = findMylistDialogFromElement(event.target);
      rememberPendingMylistPublicState(event.target);
      debugLog("mylist confirm button detected", pendingMylist);
      return;
    }

    let actionType = detectActionType(event.target);
    let actionContext = null;
    if (!actionType) {
      actionContext = takePendingLikeCandidate(event.target, clickedUrl);
      if (!actionContext) {
        return;
      }
      actionType = "like";
    }

    if (actionType !== "mylist" && shouldSuppressActionDuringMylist(actionType)) {
      debugLog("non-mylist action ignored while mylist operation is pending", actionType);
      return;
    }

    if (!isWatchPage(clickedUrl) && actionType !== "mylist") {
      return;
    }

    actionContext = actionContext || resolveActionContext(actionType, event.target, clickedUrl);
    if (!actionContext || !actionContext.videoId) {
      debugLog("action context was not available", actionType, clickedUrl);
      if (actionType === "mylist") {
        sendDiagnostic("content-mylist", "Mylist click was detected but video context was not available", {
          clickedUrl,
          targetText: getElementText(event.target).slice(0, 120)
        });
      }
      return;
    }

    const rawDebounceKey = `${event.type}:${actionType}:${actionContext.videoId}`;
    if (isRawEventDebounced(rawDebounceKey)) {
      return;
    }

    await settingsReadyPromise;
    if (!settings.enabled || !settings.actionEnabled[actionType]) {
      if (actionType === "mylist") {
        sendDiagnostic("content-mylist", "Mylist action ignored because extension or action is disabled", {
          videoId: actionContext.videoId,
          enabled: settings.enabled,
          actionEnabled: settings.actionEnabled[actionType]
        });
      }
      return;
    }

    if (actionType === "like") {
      armPendingLike(actionContext);
      return;
    }

    if (actionType === "mylist") {
      armPendingMylist(actionContext);
      return;
    }

    handleDetectedAction(actionType, actionContext.clickedUrl, actionContext.info).catch((error) => {
      debugLog("action handling failed", error);
    });
  }

  async function handleDetectedAction(actionType, clickedUrl, preloadedInfo = null) {
    const info = preloadedInfo || (await getFreshVideoInfoForAction(clickedUrl));
    if (!info || !info.videoId) {
      debugLog("watch page information was not available", clickedUrl);
      return;
    }

    const matchedTargetTag = findMatchedTargetTag(info.tags, settings.targetTags) || getPrimaryTargetTag(settings);
    const debounceKey = `${actionType}:${info.videoId}`;
    if (isDebounced(debounceKey)) {
      debugLog("duplicate click was debounced", debounceKey);
      return;
    }

    await sendMessage({
      type: MESSAGE_NICO_ACTION,
      payload: {
        actionType,
        videoId: info.videoId,
        title: info.title,
        url: info.url,
        tags: info.tags,
        matchedTargetTag,
        authorName: info.authorName
      }
    });
  }

  async function getFreshVideoInfoForAction(clickedUrl) {
    let info = extractVideoInfo(clickedUrl);
    if (info && info.tags.length > 0) {
      return info;
    }

    await delay(TAG_RETRY_WAIT_MS);
    info = extractVideoInfo(clickedUrl);
    return info;
  }

  function refreshCurrentVideo(reason) {
    if (!isWatchPage(location.href)) {
      currentVideo = null;
      return;
    }

    currentVideo = extractVideoInfo(location.href);
    if (currentVideo?.videoId) {
      debugLog("video info refreshed", reason, currentVideo);
    }
  }

  function extractVideoInfo(pageUrl) {
    const videoId = extractVideoId(pageUrl);
    if (!videoId) {
      return null;
    }

    return {
      videoId,
      title: extractTitle() || videoId,
      url: `https://www.nicovideo.jp/watch/${videoId}`,
      tags: extractTags(),
      authorName: extractAuthorName()
    };
  }

  function extractVideoId(url) {
    try {
      const parsedUrl = new URL(url);
      const match = parsedUrl.pathname.match(/\/watch\/([a-z]{2}\d+)/i);
      return match ? match[1] : "";
    } catch (error) {
      debugLog("failed to parse URL", error);
      return "";
    }
  }

  function normalizeVideoId(value) {
    const text = String(value || "").trim();
    const directMatch = text.match(/^(?:sm|nm|so)\d+$/i);
    if (directMatch) {
      return directMatch[0];
    }

    const watchUrlMatch = text.match(/\/watch\/((?:sm|nm|so)\d+)/i);
    if (watchUrlMatch) {
      return watchUrlMatch[1];
    }

    return extractVideoId(text);
  }

  function normalizeNumericId(value) {
    const text = String(value || "").trim();
    return /^\d+$/.test(text) ? text : "";
  }

  function isWatchPage(url) {
    return /https:\/\/www\.nicovideo\.jp\/watch\/[a-z]{2}\d+/i.test(url);
  }

  function extractTitle() {
    for (const selector of TITLE_SELECTORS) {
      const element = document.querySelector(selector);
      const value = selector.startsWith("meta")
        ? element?.getAttribute("content")
        : element?.getAttribute("data-title") || element?.textContent;

      const cleaned = cleanTitle(value);
      if (cleaned) {
        return cleaned;
      }
    }

    return cleanTitle(document.title);
  }

  function cleanTitle(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s*[-‐ー–—]\s*ニコニコ動画\s*$/u, "")
      .trim();
  }

  function extractTags() {
    const tags = new Set();

    for (const selector of TAG_SELECTORS) {
      document.querySelectorAll(selector).forEach((element) => {
        const candidates = [
          element.getAttribute("data-tag"),
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.textContent
        ];

        for (const candidate of candidates) {
          const tag = cleanTag(candidate);
          if (tag) {
            tags.add(tag);
          }
        }
      });
    }

    extractMetaKeywords().forEach((tag) => tags.add(tag));
    extractJsonLdKeywords().forEach((tag) => tags.add(tag));

    return Array.from(tags);
  }

  function cleanTag(value) {
    const text = String(value || "")
      .replace(/^#/, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!text || text.length > 40) {
      return "";
    }

    if (/タグ|検索|動画|コメント|再生|件$/.test(text) && text !== "音MAD") {
      return "";
    }

    return text;
  }

  function extractMetaKeywords() {
    const content = document.querySelector('meta[name="keywords"]')?.getAttribute("content") || "";
    return content
      .split(",")
      .map(cleanTag)
      .filter(Boolean);
  }

  function extractJsonLdKeywords() {
    const tags = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const data = JSON.parse(script.textContent || "{}");
        const keywords = Array.isArray(data.keywords)
          ? data.keywords
          : String(data.keywords || "").split(",");
        keywords.map(cleanTag).filter(Boolean).forEach((tag) => tags.push(tag));
      } catch (error) {
        debugLog("JSON-LD keyword parse skipped", error);
      }
    });
    return tags;
  }

  function extractAuthorName() {
    for (const selector of AUTHOR_SELECTORS) {
      const element = document.querySelector(selector);
      const value = selector.startsWith("meta") ? element?.getAttribute("content") : element?.textContent;
      const cleaned = cleanTitle(value);
      if (cleaned && cleaned.length <= 80) {
        return cleaned;
      }
    }
    return "";
  }

  function resolveActionContext(actionType, startElement, clickedUrl) {
    if (isWatchPage(clickedUrl)) {
      return {
        clickedUrl,
        videoId: extractVideoId(clickedUrl),
        info: null
      };
    }

    if (actionType !== "mylist") {
      return null;
    }

    const info = extractVideoInfoNearElement(startElement) || extractVideoInfoByGeometry(startElement) || getRecentListVideoContext();
    if (!info?.videoId) {
      return null;
    }

    return {
      clickedUrl: info.url,
      videoId: info.videoId,
      info
    };
  }

  function rememberListVideoContext(startElement) {
    const info = extractVideoInfoNearElement(startElement) || extractVideoInfoByGeometry(startElement);
    if (!info?.videoId) {
      return;
    }

    lastListVideoContext = {
      ...info,
      capturedAt: Date.now()
    };
    debugLog("list video context captured", lastListVideoContext);
  }

  function getRecentListVideoContext() {
    if (!lastListVideoContext) {
      return null;
    }

    if (Date.now() - lastListVideoContext.capturedAt > LIST_CONTEXT_TTL_MS) {
      lastListVideoContext = null;
      return null;
    }

    const { capturedAt, ...info } = lastListVideoContext;
    return info;
  }

  function findVideoInfoInPage(videoId) {
    const normalizedVideoId = normalizeVideoId(videoId);
    if (!normalizedVideoId) {
      return null;
    }

    const recentInfo = getRecentListVideoContext();
    if (recentInfo?.videoId?.toLowerCase() === normalizedVideoId.toLowerCase()) {
      return recentInfo;
    }

    if (currentVideo?.videoId?.toLowerCase() === normalizedVideoId.toLowerCase()) {
      return currentVideo;
    }

    const links = Array.from(document.querySelectorAll('a[href*="/watch/"]')).filter((link) => {
      return extractVideoId(link.href).toLowerCase() === normalizedVideoId.toLowerCase();
    });

    const infos = links
      .map(buildListVideoInfoFromLink)
      .filter((info) => info?.videoId?.toLowerCase() === normalizedVideoId.toLowerCase());

    return infos.sort(scoreVideoInfoForBridge)[0] || null;
  }

  function scoreVideoInfoForBridge(a, b) {
    const scoreA = getVideoInfoQualityScore(a);
    const scoreB = getVideoInfoQualityScore(b);
    return scoreB - scoreA;
  }

  function getVideoInfoQualityScore(info) {
    if (!info) {
      return 0;
    }

    let score = 0;
    if (info.title && info.title !== info.videoId) {
      score += Math.min(info.title.length, 80);
    }
    if (Array.isArray(info.tags) && info.tags.length > 0) {
      score += 20;
    }
    if (info.authorName) {
      score += 10;
    }
    return score;
  }

  function extractVideoInfoNearElement(startElement) {
    if (!(startElement instanceof Element)) {
      return null;
    }

    let element = startElement;
    for (let depth = 0; element && element !== document.body && depth < 12; depth += 1) {
      const info = extractVideoInfoFromContainer(element);
      if (info?.videoId) {
        return info;
      }
      element = element.parentElement;
    }

    return null;
  }

  function extractVideoInfoByGeometry(startElement) {
    if (!(startElement instanceof Element)) {
      return null;
    }

    const referenceElement = startElement.closest(ACTIONABLE_SELECTOR) || startElement;
    const referenceRect = getVisibleRect(referenceElement);
    if (!referenceRect) {
      return null;
    }

    const referenceCenter = getRectCenter(referenceRect);
    const candidates = Array.from(document.querySelectorAll('a[href*="/watch/"]'))
      .map((link) => {
        const videoId = extractVideoId(link.href);
        const rect = getVisibleRect(link);
        if (!videoId || !rect) {
          return null;
        }

        const center = getRectCenter(rect);
        const verticalDistance = Math.abs(center.y - referenceCenter.y);
        if (verticalDistance > 260) {
          return null;
        }

        const horizontalDistance = Math.abs(center.x - referenceCenter.x);
        const rightSidePenalty = center.x > referenceCenter.x ? 600 : 0;
        const thumbnailPenalty = link.querySelector("img, picture, video") ? 40 : 0;
        const textBonus = getWatchLinkText(link) ? -30 : 0;

        return {
          link,
          score: verticalDistance * 4 + horizontalDistance + rightSidePenalty + thumbnailPenalty + textBonus
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);

    const bestLink = candidates[0]?.link;
    if (!bestLink) {
      return null;
    }

    return buildListVideoInfoFromLink(bestLink);
  }

  function buildListVideoInfoFromLink(link) {
    const videoId = extractVideoId(link.href);
    if (!videoId) {
      return null;
    }

    const container = findLikelyListVideoContainer(link) || link;
    const infoFromContainer = extractVideoInfoFromContainer(container);
    if (infoFromContainer?.videoId === videoId) {
      return infoFromContainer;
    }

    return {
      videoId,
      title: getWatchLinkText(link) || videoId,
      url: `https://www.nicovideo.jp/watch/${videoId}`,
      tags: [],
      authorName: ""
    };
  }

  function findLikelyListVideoContainer(element) {
    let current = element;
    let best = null;

    for (let depth = 0; current && current !== document.body && depth < 12; depth += 1) {
      const rect = getVisibleRect(current);
      const watchLinkCount = current.querySelectorAll?.('a[href*="/watch/"]').length || 0;

      if (rect && watchLinkCount > 0 && rect.width >= 120 && rect.height >= 40 && rect.height <= 320) {
        best = current;
      }

      if (current.matches?.('li, article, [role="listitem"], [data-video-id], [class*="VideoItem"], [class*="videoItem"]')) {
        return current;
      }

      current = current.parentElement;
    }

    return best;
  }

  function getVisibleRect(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return null;
    }

    return rect;
  }

  function getRectCenter(rect) {
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  function extractVideoInfoFromContainer(container) {
    const link = findBestWatchLink(container);
    if (!link) {
      return null;
    }

    const videoId = extractVideoId(link.href);
    if (!videoId) {
      return null;
    }

    return {
      videoId,
      title: extractListTitle(container, link, videoId),
      url: `https://www.nicovideo.jp/watch/${videoId}`,
      tags: extractTagsFromContainer(container),
      authorName: extractListAuthorName(container)
    };
  }

  function findBestWatchLink(container) {
    const links = Array.from(container.querySelectorAll('a[href*="/watch/"]')).filter((link) => extractVideoId(link.href));
    if (container.matches?.('a[href*="/watch/"]') && extractVideoId(container.href)) {
      links.unshift(container);
    }

    return links
      .map((link) => ({ link, score: scoreWatchLink(link) }))
      .sort((a, b) => b.score - a.score)[0]?.link || null;
  }

  function scoreWatchLink(link) {
    const text = getWatchLinkText(link);
    let score = text ? getTitleQualityScore(text) : -500;
    if (link.querySelector("img, picture, video")) {
      score -= text ? 10 : 80;
    }
    if (text && !/^\d+:\d+$/.test(text)) {
      score += 20;
    }
    return score;
  }

  function getWatchLinkText(link) {
    const candidates = [
      link.getAttribute("title"),
      link.getAttribute("aria-label"),
      link.querySelector("img[alt]")?.getAttribute("alt"),
      getElementDirectText(link)
    ];

    return pickBestTitleCandidate(candidates, extractVideoId(link.href));
  }

  function extractListTitle(container, link, videoId) {
    const titleSelectors = [
      'a[href*="/watch/"][title]',
      'a[href*="/watch/"][aria-label]',
      'a[href*="/watch/"] img[alt]',
      '[data-title]',
      '[itemprop="name"]',
      '[class*="VideoTitle"]',
      '[class*="videoTitle"]',
      '[class*="Title"]',
      '[class*="title"]',
      "h1",
      "h2",
      "h3",
      'a[href*="/watch/"]'
    ];
    const candidates = [getWatchLinkText(link)];

    for (const selector of titleSelectors) {
      container.querySelectorAll(selector).forEach((candidate) => {
        candidates.push(getTitleCandidateText(candidate));
      });
    }

    return pickBestTitleCandidate(candidates, videoId) || videoId;
  }

  function getTitleCandidateText(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    if (element.matches("img[alt]")) {
      return element.getAttribute("alt") || "";
    }

    if (element.matches('a[href*="/watch/"]')) {
      return (
        element.getAttribute("data-title") ||
        element.getAttribute("title") ||
        element.getAttribute("aria-label") ||
        element.querySelector("img[alt]")?.getAttribute("alt") ||
        getElementDirectText(element) ||
        ""
      );
    }

    return (
      element.getAttribute("data-title") ||
      element.getAttribute("title") ||
      element.getAttribute("aria-label") ||
      getElementDirectText(element) ||
      getShallowElementText(element) ||
      ""
    );
  }

  function getElementDirectText(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    return Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ");
  }

  function getShallowElementText(element) {
    if (!(element instanceof Element) || element.children.length > 4) {
      return "";
    }

    const text = cleanTitle(element.textContent);
    return text.length <= 120 ? text : "";
  }

  function pickBestTitleCandidate(candidates, videoId) {
    return candidates
      .map((value) => normalizeListTitleCandidate(value, videoId))
      .filter(Boolean)
      .sort((a, b) => getTitleQualityScore(b) - getTitleQualityScore(a))[0] || "";
  }

  function normalizeListTitleCandidate(value, videoId) {
    let title = cleanTitle(value);
    if (!title || title === videoId) {
      return "";
    }

    title = title
      .replace(/\s*-\s*ニコニコ動画\s*$/u, "")
      .replace(/\s*(?:20\d{2}\/\d{1,2}\/\d{1,2}|20\d{2}-\d{1,2}-\d{1,2}).*$/u, "")
      .replace(/\s+\d{1,2}:\d{2}.*$/u, "")
      .replace(/\s*(?:再生|コメント|マイリスト|いいね)[：:]?\s*\d[\d,]*.*$/u, "")
      .replace(/\s+\d[\d,]*(?:\s+\d[\d,]*){1,}\s*$/u, "")
      .trim();

    if (isLikelyMetadataTitle(title, videoId)) {
      return "";
    }

    return title;
  }

  function isLikelyMetadataTitle(title, videoId) {
    if (!title || title === videoId) {
      return true;
    }

    if (title.length > 100) {
      return true;
    }

    if (/\d{1,2}:\d{2}/.test(title) || /(?:再生|コメント|マイリスト|いいね|投稿日|視聴履歴)/u.test(title)) {
      return true;
    }

    if (/(?:20\d{2}\/\d{1,2}\/\d{1,2}|20\d{2}-\d{1,2}-\d{1,2})/u.test(title)) {
      return true;
    }

    if (/\d{1,2}:\d{2}.*\d[\d,]{2,}/u.test(title)) {
      return true;
    }

    return false;
  }

  function getTitleQualityScore(title) {
    if (!title) {
      return 0;
    }

    let score = Math.min(title.length, 80);
    if (/[ぁ-んァ-ン一-龠A-Za-z]/u.test(title)) {
      score += 30;
    }
    if (/[、。！？!?]/u.test(title)) {
      score += 5;
    }
    return score;
  }

  function extractTagsFromContainer(container) {
    const tags = new Set();
    for (const selector of TAG_SELECTORS) {
      container.querySelectorAll(selector).forEach((element) => {
        const tag = cleanTag(element.getAttribute("data-tag") || element.getAttribute("title") || element.textContent);
        if (tag) {
          tags.add(tag);
        }
      });
    }
    return Array.from(tags);
  }

  function extractListAuthorName(container) {
    for (const selector of AUTHOR_SELECTORS) {
      const element = container.querySelector(selector);
      const value = selector.startsWith("meta") ? element?.getAttribute("content") : element?.textContent;
      const cleaned = cleanTitle(value);
      if (cleaned && cleaned.length <= 80) {
        return cleaned;
      }
    }
    return "";
  }

  function detectActionType(startElement) {
    if (!(startElement instanceof Element)) {
      return "";
    }

    const actionElement = findActionElement(startElement) || findLooseActionElement(startElement);
    if (!actionElement || isLikelyNavigationLink(actionElement)) {
      return "";
    }

    const descriptor = getElementDescriptor(actionElement);
    if (isLikelyNegativeAction(descriptor)) {
      return "";
    }

    if (isStrictLikeAction(actionElement, descriptor)) {
      debugLog("action button detected", "like", descriptor);
      return "like";
    }

    for (const actionType of ["mylist", "like", "nicoad"]) {
      if (actionType === "like") {
        continue;
      }
      if (matchesActionSelector(actionElement, actionType) || matchesAction(descriptor, actionType)) {
        debugLog("action button detected", actionType, descriptor);
        return actionType;
      }
    }

    return "";
  }

  function isStrictLikeAction(actionElement, descriptor) {
    return isPermissiveLikeAction(actionElement, descriptor) && hasDirectLikeActionSignal(actionElement, descriptor);
  }

  function buildLikeCandidateFromPointerDown(startElement) {
    if (!(startElement instanceof Element) || !isWatchPage(location.href)) {
      return null;
    }

    if (shouldSuppressActionDuringMylist("like")) {
      return null;
    }

    const actionElement = findActionElement(startElement);
    if (!actionElement || isLikelyNavigationLink(actionElement)) {
      return null;
    }

    const descriptor = getElementDescriptorDeep(actionElement);
    if (!isStrictLikeAction(actionElement, descriptor)) {
      return null;
    }

    const videoId = extractVideoId(location.href);
    if (!videoId) {
      return null;
    }

    return {
      actionElement,
      startedAt: Date.now(),
      actionContext: {
        clickedUrl: location.href,
        videoId,
        info: null,
        actionElement
      }
    };
  }

  function takePendingLikeCandidate(startElement, clickedUrl) {
    if (!pendingLikeCandidate) {
      return null;
    }

    const candidate = pendingLikeCandidate;
    if (Date.now() - candidate.startedAt > LIKE_CANDIDATE_TTL_MS) {
      pendingLikeCandidate = null;
      return null;
    }

    if (!isWatchPage(clickedUrl) || candidate.actionContext.clickedUrl !== clickedUrl) {
      pendingLikeCandidate = null;
      return null;
    }

    if (!(startElement instanceof Element) || !candidate.actionElement.contains(startElement)) {
      return null;
    }

    pendingLikeCandidate = null;
    debugLog("like action restored from pointerdown candidate", candidate.actionContext.videoId);
    return candidate.actionContext;
  }

  function isPermissiveLikeAction(actionElement, descriptor) {
    if (!isButtonLikeElement(actionElement)) {
      return false;
    }

    if (isAlreadyActiveLikeAction(actionElement, descriptor)) {
      debugLog("active like button ignored", descriptor);
      return false;
    }

    if (isLikelyNegativeAction(descriptor)) {
      return false;
    }

    if (matchesAction(descriptor, "mylist") || matchesActionSelectorDeep(actionElement, "mylist")) {
      return false;
    }

    if (matchesAction(descriptor, "nicoad") || matchesActionSelectorDeep(actionElement, "nicoad")) {
      return false;
    }

    const dialog = actionElement.closest('[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"], [class*="Dialog"], [class*="dialog"]');
    if (dialog && /マイリスト/u.test(getElementText(dialog))) {
      return false;
    }

    return hasDirectLikeActionSignal(actionElement, descriptor);
  }

  function hasDirectLikeActionSignal(actionElement, descriptor) {
    if (matchesActionSelector(actionElement, "like") || matchesAction(getElementDescriptor(actionElement), "like")) {
      return true;
    }

    if (!isCompactActionControl(actionElement)) {
      return false;
    }

    return matchesActionSelectorDeep(actionElement, "like") || matchesAction(descriptor, "like");
  }

  function isCompactActionControl(element) {
    const rect = getVisibleRect(element);
    if (!rect) {
      return false;
    }

    return rect.width <= LIKE_CONTROL_MAX_WIDTH && rect.height <= LIKE_CONTROL_MAX_HEIGHT;
  }

  function isAlreadyActiveLikeAction(actionElement, descriptor) {
    if (ACTIVE_LIKE_PATTERN.test(descriptor)) {
      return true;
    }

    const stateElements = [actionElement, ...Array.from(actionElement.querySelectorAll("*")).slice(0, 20)];
    return stateElements.some((element) => {
      if (!(element instanceof Element)) {
        return false;
      }

      return (
        element.getAttribute("aria-pressed") === "true" ||
        element.getAttribute("aria-checked") === "true" ||
        element.getAttribute("aria-selected") === "true" ||
        element.getAttribute("data-active") === "true" ||
        element.getAttribute("data-selected") === "true" ||
        element.getAttribute("data-liked") === "true" ||
        element.getAttribute("data-is-liked") === "true" ||
        element.getAttribute("data-is_liked") === "true" ||
        /^(on|active|selected|checked)$/i.test(element.getAttribute("data-state") || "") ||
        hasActiveLikeClass(element)
      );
    });
  }

  function hasActiveLikeClass(element) {
    return Array.from(element.classList || []).some((className) => {
      const value = String(className || "").toLowerCase();
      if (!value || value.includes("unliked") || value.includes("notliked") || value.includes("not-liked")) {
        return false;
      }

      return /(?:^|[-_])(active|selected|checked|liked|isactive|isselected|ischecked|isliked|is-liked)(?:$|[-_])/.test(value);
    });
  }

  async function verifyLikeWasEnabledAfterClick(actionElement) {
    if (!(actionElement instanceof Element)) {
      return false;
    }

    await delay(450);
    const currentElement = document.contains(actionElement)
      ? actionElement
      : findActionElement(actionElement) || findCurrentLikeButton();
    const descriptor = currentElement ? getElementDescriptorDeep(currentElement) : "";

    if (currentElement && isAlreadyActiveLikeAction(currentElement, descriptor)) {
      return true;
    }

    const button = findCurrentLikeButton();
    if (button && button !== currentElement && isAlreadyActiveLikeAction(button, getElementDescriptorDeep(button))) {
      return true;
    }

    if (hasAnyExplicitInactiveLikeSignal(currentElement || button, descriptor)) {
      return false;
    }

    // 状態属性がまったく取れない場合は、解除誤爆を避けるため投稿しない。
    return false;
  }

  function findCurrentLikeButton() {
    const candidates = [];
    ACTION_SELECTORS.like.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((element) => candidates.push(element));
      } catch (error) {
        debugLog("like button selector skipped", selector, error);
      }
    });

    return candidates.find((element) => {
      return element instanceof Element && !matchesActionSelectorDeep(element, "mylist") && isButtonLikeElement(element);
    }) || null;
  }

  function hasAnyExplicitInactiveLikeSignal(element, descriptor) {
    const text = String(descriptor || "");
    if (/aria-(?:pressed|checked|selected)=false|data-(?:pressed|active|selected|liked|is-liked|is_liked|isliked)=false|data-state=(?:off|inactive|unchecked)|unliked|notliked|not-liked/i.test(text)) {
      return true;
    }

    if (!(element instanceof Element)) {
      return false;
    }

    const stateElements = [element, ...Array.from(element.querySelectorAll("*")).slice(0, 20)];
    return stateElements.some((candidate) => {
      return (
        candidate.getAttribute("aria-pressed") === "false" ||
        candidate.getAttribute("aria-checked") === "false" ||
        candidate.getAttribute("aria-selected") === "false" ||
        candidate.getAttribute("data-active") === "false" ||
        candidate.getAttribute("data-selected") === "false" ||
        candidate.getAttribute("data-liked") === "false" ||
        candidate.getAttribute("data-is-liked") === "false" ||
        candidate.getAttribute("data-is_liked") === "false" ||
        /^(off|inactive|unchecked)$/i.test(candidate.getAttribute("data-state") || "")
      );
    });
  }

  function isButtonLikeElement(element) {
    return Boolean(
      element?.matches?.('button,[role="button"],input[type="button"],input[type="submit"],[data-click-area],[data-testid]')
    );
  }

  function isLikelyMylistConfirmActivation(startElement) {
    if (!(startElement instanceof Element)) {
      return false;
    }

    const actionElement = findActionElement(startElement) || findLooseActionElement(startElement);
    if (!actionElement || isLikelyNavigationLink(actionElement)) {
      return false;
    }

    const text = getElementText(actionElement);
    if (!MYLIST_CONFIRM_PATTERN.test(text) || MYLIST_ERROR_PATTERN.test(text)) {
      return false;
    }

    const dialog = actionElement.closest('[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"], [class*="Dialog"], [class*="dialog"]');
    if (!dialog) {
      return true;
    }

    return /マイリスト/u.test(getElementText(dialog));
  }

  function findMylistDialogFromElement(startElement) {
    if (!(startElement instanceof Element)) {
      return null;
    }

    return (
      startElement.closest('[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"], [class*="Dialog"], [class*="dialog"]') ||
      null
    );
  }

  function chooseMylistPublicState(...states) {
    if (states.some((state) => state === "private")) {
      return "private";
    }

    if (states.some((state) => state === "public")) {
      return "public";
    }

    return "unknown";
  }

  async function resolveBridgeMylistPublicState(payload, pendingState) {
    const mylistId = normalizeNumericId(payload.mylistId);
    const payloadState = normalizeMylistPublicState(payload.publicState);
    const selectedState = normalizeMylistPublicState(pendingState);

    // ID単位の確認が取れるなら最優先。レスポンス全体の「非公開」文字列に引っ張られないため。
    if (mylistId) {
      const fetchedState = await fetchMylistPublicState(mylistId);
      if (pendingMylist && fetchedState !== "unknown") {
        pendingMylist.mylistId = mylistId;
        pendingMylist.publicState = fetchedState;
      }
      if (fetchedState !== "unknown") {
        return fetchedState;
      }
    }

    // ユーザーが選択したマイリスト項目の状態を、通信レスポンス全体の曖昧な文字列より優先する。
    if (selectedState !== "unknown") {
      return selectedState;
    }

    return payloadState;
  }

  function rememberPendingMylistPublicState(startElement) {
    if (!pendingMylist || pendingMylist.sent) {
      return;
    }

    const dialog = findMylistDialogFromElement(startElement) || pendingMylist.confirmDialog;
    const state = detectMylistPublicStateFromDialog(dialog, startElement);
    if (state !== "unknown") {
      pendingMylist.publicState = chooseMylistPublicState(state, pendingMylist.publicState);
    }

    const mylistId = findSelectedMylistId(dialog, startElement);
    if (mylistId) {
      pendingMylist.mylistId = mylistId;
    }
  }

  function detectMylistPublicStateFromDialog(dialog, activatedElement) {
    const candidates = [];

    if (dialog instanceof Element) {
      dialog
        .querySelectorAll('[aria-selected="true"], [aria-checked="true"], input:checked, option:checked, option[selected], [data-selected="true"], [data-active="true"]')
        .forEach((element) => {
          candidates.push(getMylistPrivacyCandidateElement(element));
        });
    }

    candidates.push(getMylistPrivacyCandidateElement(activatedElement));

    for (const candidate of candidates.filter(Boolean)) {
      const state = getMylistPublicStateFromCandidate(candidate);
      if (state !== "unknown") {
        return state;
      }
    }

    if (dialog instanceof Element) {
      const dialogText = getElementText(dialog);
      const state = getMylistPublicStateFromText(dialogText);
      if (state === "private" && !/公開/u.test(dialogText.replace(/非公開/g, ""))) {
        return "private";
      }
    }

    return "unknown";
  }

  function getMylistPublicStateFromCandidate(candidate) {
    if (!(candidate instanceof Element)) {
      return "unknown";
    }

    const descriptor = getElementDescriptorDeep(candidate);
    const explicitState = getMylistPublicStateFromText(descriptor);
    if (explicitState !== "unknown") {
      return explicitState;
    }

    if (!isLikelyMylistSelectionCandidate(candidate)) {
      return "unknown";
    }

    const text = getElementText(candidate);
    if (!text || MYLIST_CONFIRM_PATTERN.test(text) || MYLIST_ERROR_PATTERN.test(text)) {
      return "unknown";
    }

    // ニコニコのPC UIは公開マイリストを「公開」と明示せず、非公開だけ表示することがある。
    // 選択中の項目に非公開表示がなければ公開として扱う。
    return "public";
  }

  function isLikelyMylistSelectionCandidate(element) {
    return Boolean(
      element.matches?.('label, li, option, select, [role="option"], [role="radio"], [role="menuitemradio"], [aria-selected], [aria-checked]') ||
        element.querySelector?.('input[type="radio"], input[type="checkbox"], option:checked, option[selected], [aria-selected], [aria-checked]')
    );
  }

  function getMylistPrivacyCandidateElement(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    return (
      element.closest('label, li, option, select, [role="option"], [role="radio"], [role="menuitemradio"], [aria-selected], [aria-checked], [class*="Item"], [class*="item"]') ||
      element
    );
  }

  function findSelectedMylistId(dialog, activatedElement) {
    const candidates = [];

    if (dialog instanceof Element) {
      dialog
        .querySelectorAll('[aria-selected="true"], [aria-checked="true"], input:checked, option:checked, option[selected], [data-selected="true"], [data-active="true"]')
        .forEach((element) => {
          candidates.push(getMylistPrivacyCandidateElement(element));
        });
    }

    candidates.push(getMylistPrivacyCandidateElement(activatedElement));

    for (const candidate of candidates.filter(Boolean)) {
      const id = extractMylistIdFromElement(candidate);
      if (id) {
        return id;
      }
    }

    return "";
  }

  function extractMylistIdFromElement(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const descriptor = getElementDescriptorDeep(element);
    const match =
      descriptor.match(/(?:mylistId|mylist_id|listId|list_id|folderId|folder_id|groupId|group_id)[="'\s:]+(\d+)/i) ||
      descriptor.match(/(?:value|data-mylist-id|data-mylist_id|data-list-id|data-list_id|data-group-id|data-group_id)=["']?(\d+)/i) ||
      descriptor.match(/\/(?:mylist|mylists|my-list|playlist)s?\/(\d+)(?:[/?#\s]|$)/i);

    return match ? normalizeNumericId(match[1]) : "";
  }

  function getMylistPublicStateFromText(value) {
    const text = String(value || "");
    const textWithoutPrivateWord = text.replace(/非公開/g, "");

    if (/(?:isPublic|is_public|public|isOpen|is_open|isVisible|is_visible)=?(?:false|0)|(?:isPrivate|is_private|isClosed|is_closed|private|closed|hidden)=?(?:true|1)|(?:visibility|privacy|publicity|scope|status)=?(?:private|closed|hidden|非公開)|非公開|(?:^|[^a-z])private(?:[^a-z]|$)/i.test(text)) {
      return "private";
    }

    if (/(?:isPublic|is_public|isOpen|is_open|isVisible|is_visible)=?(?:true|1)|(?:isPrivate|is_private|isClosed|is_closed|private|closed|hidden)=?(?:false|0)|(?:visibility|privacy|publicity|scope|status)=?(?:public|open|visible|公開)|公開|public/i.test(textWithoutPrivateWord)) {
      return "public";
    }

    return "unknown";
  }

  function normalizeMylistPublicState(value) {
    return value === "public" || value === "private" ? value : "unknown";
  }

  async function fetchMylistPublicState(mylistId) {
    const id = normalizeNumericId(mylistId);
    if (!id) {
      return "unknown";
    }

    const response = await sendMessage({
      type: MESSAGE_MYLIST_PUBLIC_STATE,
      payload: { mylistId: id }
    });
    return normalizeMylistPublicState(response?.publicState);
  }

  function findActionElement(startElement) {
    const closestActionable = startElement.closest(ACTIONABLE_SELECTOR);
    if (!closestActionable || closestActionable === document.body) {
      return null;
    }

    if (!isElementWithinDepth(startElement, closestActionable, 8)) {
      return null;
    }

    return closestActionable;
  }

  function findLooseActionElement(startElement) {
    let element = startElement;
    for (let depth = 0; element && element !== document.body && depth <= 7; depth += 1) {
      const descriptor = getElementDescriptor(element);
      const text = getElementText(element);
      if (text.length <= 120 && ["mylist", "nicoad"].some((actionType) => matchesAction(descriptor, actionType))) {
        return element;
      }
      element = element.parentElement;
    }
    return null;
  }

  function isElementWithinDepth(startElement, ancestor, maxDepth) {
    let element = startElement;
    for (let depth = 0; element && depth <= maxDepth; depth += 1) {
      if (element === ancestor) {
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }

  function isLikelyNavigationLink(element) {
    const link = element.closest("a[href]");
    if (!link) {
      return false;
    }

    const href = link.getAttribute("href") || "";
    return /\/watch\/[a-z]{2}\d+/i.test(href);
  }

  function getElementDescriptor(element) {
    const attributes = [
      "aria-label",
      "title",
      "id",
      "name",
      "value",
      "data-testid",
      "data-action",
      "data-click-area",
      "data-name",
      "data-mylist-id",
      "data-mylist_id",
      "data-list-id",
      "data-list_id",
      "data-group-id",
      "data-group_id",
      "aria-pressed",
      "aria-checked",
      "aria-selected",
      "data-state",
      "data-active",
      "data-selected",
      "data-liked",
      "data-is-liked",
      "data-is_liked",
      "class",
      "href"
    ];

    const parts = attributes.map((name) => {
      const value = element.getAttribute(name);
      return value ? `${name}=${value}` : "";
    });

    const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length <= 120) {
      parts.push(text);
    }

    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  function getElementDescriptorDeep(element) {
    const parts = [getElementDescriptor(element)];
    const descendants = Array.from(
      element.querySelectorAll(
        "[aria-label], [title], [id], [name], [value], [data-testid], [data-action], [data-click-area], [data-name], [data-mylist-id], [data-mylist_id], [data-list-id], [data-list_id], [data-group-id], [data-group_id], [aria-pressed], [aria-checked], [aria-selected], [data-state], [data-active], [data-selected], [data-liked], [data-is-liked], [data-is_liked], [class]"
      )
    ).slice(0, 12);

    for (const descendant of descendants) {
      parts.push(getElementDescriptor(descendant));
    }

    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 1200);
  }

  function getElementText(element) {
    return String(element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isLikelyNegativeAction(descriptor) {
    return NEGATIVE_ACTION_PATTERN.test(descriptor);
  }

  function matchesAction(descriptor, actionType) {
    return ACTION_PATTERNS[actionType].some((pattern) => pattern.test(descriptor));
  }

  function matchesActionSelector(element, actionType) {
    return ACTION_SELECTORS[actionType].some((selector) => {
      try {
        return element.matches(selector);
      } catch (error) {
        debugLog("action selector skipped", selector, error);
        return false;
      }
    });
  }

  function matchesActionSelectorDeep(element, actionType) {
    if (matchesActionSelector(element, actionType)) {
      return true;
    }

    return ACTION_SELECTORS[actionType].some((selector) => {
      try {
        return Boolean(element.querySelector(selector));
      } catch (error) {
        debugLog("deep action selector skipped", selector, error);
        return false;
      }
    });
  }

  function isDebounced(key) {
    const now = Date.now();
    const previous = recentClicks.get(key) || 0;
    recentClicks.set(key, now);
    return now - previous < CLICK_DEBOUNCE_MS;
  }

  function armPendingMylist(actionContext) {
    if (!actionContext?.videoId) {
      return;
    }

    lastMylistStartedAt = Date.now();
    pendingMylist = {
      clickedUrl: actionContext.clickedUrl,
      videoId: actionContext.videoId,
      info: actionContext.info || null,
      requiresBridge: !isWatchPage(actionContext.clickedUrl),
      startedAt: Date.now(),
      confirmedAt: 0,
      confirmDialog: null,
      mylistId: "",
      publicState: "unknown",
      initialSignals: collectMylistSuccessSignals(),
      publicConfirmStartedAt: 0,
      publicConfirmDiagnosticSent: false,
      sent: false
    };

    sendDiagnostic("content-mylist", "Mylist action armed; waiting for Nico registration success", {
      videoId: pendingMylist.videoId,
      clickedUrl: pendingMylist.clickedUrl,
      requiresBridge: pendingMylist.requiresBridge
    });

    waitForMylistSuccess(pendingMylist).catch((error) => {
      debugLog("mylist success wait failed", error);
      sendDiagnostic("content-mylist", "Mylist success wait failed", {
        videoId: actionContext.videoId,
        reason: error.message || String(error)
      });
    });
  }

  function armPendingLike(actionContext) {
    if (!actionContext?.videoId || !isWatchPage(actionContext.clickedUrl)) {
      return;
    }

    pendingLike = {
      clickedUrl: actionContext.clickedUrl,
      videoId: actionContext.videoId,
      info:
        actionContext.info ||
        (currentVideo?.videoId?.toLowerCase() === actionContext.videoId.toLowerCase() ? currentVideo : null),
      startedAt: Date.now(),
      sent: false
    };

    const pending = pendingLike;
    verifyLikeWasEnabledAfterClick(actionContext.actionElement)
      .then(async (enabled) => {
        if (!enabled || pendingLike !== pending || pending.sent) {
          return;
        }

        pending.sent = true;
        pendingLike = null;
        const info = pending.info || (await getFreshVideoInfoForAction(pending.clickedUrl));
        if (info?.videoId) {
          await handleDetectedAction("like", pending.clickedUrl, info);
        }
      })
      .catch((error) => debugLog("like DOM success verification failed", error));

    window.setTimeout(() => {
      if (pendingLike && !pendingLike.sent && Date.now() - pendingLike.startedAt >= LIKE_SUCCESS_WAIT_MS) {
        pendingLike = null;
      }
    }, LIKE_SUCCESS_WAIT_MS + 250);
  }

  function shouldSuppressActionDuringMylist(actionType) {
    if (actionType === "mylist") {
      return false;
    }

    if (pendingMylist && !pendingMylist.sent && Date.now() - pendingMylist.startedAt < MYLIST_SUPPRESS_OTHER_ACTIONS_MS) {
      return true;
    }

    return Date.now() - lastMylistStartedAt < MYLIST_SUPPRESS_OTHER_ACTIONS_MS;
  }

  async function waitForMylistSuccess(pending) {
    while (pendingMylist === pending && Date.now() - pending.startedAt < MYLIST_SUCCESS_WAIT_MS) {
      if (detectMylistSuccessSignal(pending)) {
        await sendPendingMylist(pending);
        return;
      }
      await delay(250);
    }

    if (pendingMylist === pending) {
      pendingMylist = null;
    }
  }

  async function sendPendingMylist(pending) {
    if (!pending || pending.sent || pendingMylist !== pending) {
      return;
    }

    await refreshPendingMylistPublicState(pending);

    if (pending.publicState !== "public") {
      if (pending.publicState === "unknown") {
        pending.publicConfirmStartedAt = pending.publicConfirmStartedAt || Date.now();
        if (!pending.publicConfirmDiagnosticSent) {
          pending.publicConfirmDiagnosticSent = true;
          sendDiagnostic("content-mylist", "Mylist success signal received; waiting for public-state confirmation", {
            videoId: pending.videoId,
            publicState: pending.publicState,
            mylistId: pending.mylistId || "",
            clickedUrl: pending.clickedUrl
          });
        }

        if (Date.now() - pending.publicConfirmStartedAt < MYLIST_PUBLIC_CONFIRM_GRACE_MS) {
          return;
        }
      }

      debugLog("mylist success ignored because target mylist was not confirmed public", {
        videoId: pending.videoId,
        publicState: pending.publicState || "unknown"
      });
      sendDiagnostic("content-mylist", "Mylist success signal ignored because target mylist was not confirmed public", {
        videoId: pending.videoId,
        publicState: pending.publicState || "unknown",
        mylistId: pending.mylistId || "",
        clickedUrl: pending.clickedUrl
      });
      pending.sent = true;
      pendingMylist = null;
      return;
    }

    pending.sent = true;
    pendingMylist = null;
    await handleDetectedAction("mylist", pending.clickedUrl, pending.info);
  }

  async function refreshPendingMylistPublicState(pending) {
    if (!pending || pending.sent) {
      return;
    }

    const dialog = pending.confirmDialog || findLikelyVisibleMylistDialog();
    const state = detectMylistPublicStateFromDialog(dialog, dialog || document.body);
    if (state !== "unknown") {
      pending.publicState = chooseMylistPublicState(state, pending.publicState);
    }

    const mylistId = findSelectedMylistId(dialog, dialog || document.body);
    if (mylistId) {
      pending.mylistId = mylistId;
    }

    if (pending.mylistId && pending.publicState === "unknown") {
      const fetchedState = await fetchMylistPublicState(pending.mylistId);
      if (fetchedState !== "unknown") {
        pending.publicState = fetchedState;
      }
    }
  }

  function findLikelyVisibleMylistDialog() {
    const candidates = Array.from(
      document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"], [class*="Dialog"], [class*="dialog"], form')
    );
    return (
      candidates.find((element) => {
        return element instanceof Element && isVisibleElement(element) && /マイリスト|mylist|deflist/i.test(getElementText(element));
      }) || null
    );
  }

  function detectMylistSuccessSignal(pending) {
    if (pending?.requiresBridge) {
      return false;
    }

    const texts = collectMylistSuccessSignals();
    const initialSignals = pending?.initialSignals || [];
    if (texts.some((text) => MYLIST_SUCCESS_PATTERN.test(text) && !initialSignals.includes(text))) {
      return true;
    }

    if (isWatchMylistConfirmClosedWithoutError(pending, texts)) {
      debugLog("mylist success inferred from closed confirm dialog", pending.videoId);
      return true;
    }

    return false;
  }

  function isWatchMylistConfirmClosedWithoutError(pending, signalTexts) {
    if (!pending?.confirmedAt || pending.requiresBridge) {
      return false;
    }

    if (Date.now() - pending.confirmedAt < MYLIST_CONFIRM_CLOSE_FALLBACK_MS) {
      return false;
    }

    if (signalTexts.some((text) => MYLIST_ERROR_PATTERN.test(text))) {
      return false;
    }

    if (pending.confirmDialog && document.contains(pending.confirmDialog) && isVisibleElement(pending.confirmDialog)) {
      return false;
    }

    return isWatchPage(pending.clickedUrl);
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function collectMylistSuccessSignals() {
    const texts = [];
    for (const selector of MYLIST_SUCCESS_SELECTORS) {
      document.querySelectorAll(selector).forEach((element) => {
        const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
        if (text) {
          texts.push(text);
        }
      });
    }

    document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"], [class*="Dialog"], [class*="dialog"], body > div').forEach((element) => {
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 300 && (MYLIST_SUCCESS_PATTERN.test(text) || MYLIST_ERROR_PATTERN.test(text))) {
        texts.push(text);
      }
    });

    return Array.from(new Set(texts));
  }

  function isRawEventDebounced(key) {
    const now = Date.now();
    const previous = recentRawEvents.get(key) || 0;
    recentRawEvents.set(key, now);
    return now - previous < RAW_EVENT_DEBOUNCE_MS;
  }

  function findMatchedTargetTag(videoTags, targetTags) {
    const normalizedVideoTags = normalizeStringArray(videoTags);
    const lowered = new Map(normalizedVideoTags.map((tag) => [tag.toLowerCase(), tag]));

    for (const targetTag of normalizeStringArray(targetTags)) {
      const match = lowered.get(targetTag.toLowerCase());
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

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled,
      targetTags: parseTags(source.targetTags).length > 0 ? parseTags(source.targetTags) : [...DEFAULT_SETTINGS.targetTags],
      filterByTags: source.filterByTags === true,
      actionEnabled: {
        like: source.actionEnabled?.like !== false,
        mylist: source.actionEnabled?.mylist !== false,
        nicoad: false
      }
    };
  }

  function getPrimaryTargetTag(value) {
    return normalizeStringArray(value.targetTags)[0] || DEFAULT_SETTINGS.targetTags[0];
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

  function normalizeStringArray(values) {
    return Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    );
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["settings"], (items) => {
        const error = chrome.runtime.lastError;
        if (error) {
          debugLog("settings load failed; defaults will be used", error.message);
          resolve({ ...DEFAULT_SETTINGS });
          return;
        }
        resolve(normalizeSettings(items.settings));
      });
    });
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          debugLog("failed to send action message", error.message);
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve(response);
      });
    });
  }

  function sendDiagnostic(status, message, details = {}) {
    chrome.runtime.sendMessage(
      {
        type: MESSAGE_DIAGNOSTIC,
        payload: {
          status,
          message,
          details
        }
      },
      () => {
        // 診断ログは補助情報なので、失敗しても本処理を止めない。
        void chrome.runtime.lastError;
      }
    );
  }

  function watchSpaNavigation() {
    const notifyUrlChange = () => {
      window.setTimeout(() => {
        if (lastUrl !== location.href) {
          lastUrl = location.href;
          refreshCurrentVideo("url-change");
        }
      }, 0);
    };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function pushState(...args) {
      const result = originalPushState.apply(this, args);
      notifyUrlChange();
      return result;
    };

    history.replaceState = function replaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      notifyUrlChange();
      return result;
    };

    window.addEventListener("popstate", notifyUrlChange);
    window.setInterval(() => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        refreshCurrentVideo("url-interval");
      }
    }, URL_CHECK_INTERVAL_MS);
  }

  function watchDomChanges() {
    const observerTarget = document.documentElement || document.body;
    if (!observerTarget) {
      window.setTimeout(watchDomChanges, 50);
      return;
    }

    const observer = new MutationObserver(() => {
      if (isWatchPage(location.href)) {
        if (refreshTimer) {
          window.clearTimeout(refreshTimer);
        }
        refreshTimer = window.setTimeout(() => refreshCurrentVideo("mutation"), 500);
      }
      if (pendingMylist && detectMylistSuccessSignal(pendingMylist)) {
        sendPendingMylist(pendingMylist).catch((error) => {
          debugLog("pending mylist send failed", error);
        });
      }
    });

    observer.observe(observerTarget, {
      childList: true,
      subtree: true
    });
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function debugLog(...args) {
    if (DEBUG) {
      console.debug("[NicoRepo2]", ...args);
    }
  }
})();
