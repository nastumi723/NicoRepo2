(() => {
  if (window.__nicoRepo2PageBridgeLoaded) {
    return;
  }
  window.__nicoRepo2PageBridgeLoaded = true;

  const SOURCE = "NICO_REPO2_PAGE_BRIDGE";
  const TYPE_MYLIST_REGISTERED = "NICO_REPO2_MYLIST_REGISTERED";
  const TYPE_LIKE_REGISTERED = "NICO_REPO2_LIKE_REGISTERED";
  const TYPE_DIAGNOSTIC = "NICO_REPO2_PAGE_DIAGNOSTIC";
  const VIDEO_ID_PATTERN = /(?:sm|nm|so)\d+/i;

  const ADDITIVE_METHODS = new Set(["POST", "PUT", "PATCH"]);
  const MYLIST_WORD_PATTERN = /mylist|mylists|my-list|playlist|deflist|defaultlist|default-list|マイリスト|とりあえずマイリスト/i;
  const MYLIST_REGISTRATION_URL_PATTERN =
    /(?:mylist|mylists|my-list|playlist|deflist|defaultlist|default-list)s?(?:\/[^/?#]+)*\/(?:items?|videos?|contents?)\b|(?:add|append|register|create|save|store)[^/?#]*(?:mylist|mylists|my-list|playlist|deflist|defaultlist|default-list)|(?:mylist|mylists|my-list|playlist|deflist|defaultlist|default-list)[^/?#]*(?:add|append|register|create|save|store)/i;
  const MYLIST_REGISTRATION_BODY_PATTERN = /(?:itemId|item_id|videoId|video_id|watchId|watch_id|contentId|content_id)["'=:\s]+(?:sm|nm|so)\d+/i;
  const MYLIST_ID_BODY_PATTERN = /(?:mylistId|mylist_id|listId|list_id|folderId|folder_id|groupId|group_id)["'=:\s]+\d+/i;
  const LIKE_WORD_PATTERN = /like|likes|favorite|favorites|reaction|reactions|いいね/i;
  const LIKE_REGISTRATION_URL_PATTERN =
    /(?:^|\/)(?:likes?|favorites?|reactions?)(?:\/|$|\?)|(?:add|append|register|create|save|store)[^/?#]*(?:likes?|favorites?|reactions?)|(?:likes?|favorites?|reactions?)[^/?#]*(?:add|append|register|create|save|store)/i;
  const LIKE_REGISTRATION_BODY_PATTERN = /(?:itemId|item_id|videoId|video_id|watchId|watch_id|contentId|content_id)["'=:\s]+(?:sm|nm|so)\d+/i;
  const LIKE_NEGATIVE_STATE_PATTERN =
    /(?:like|liked|isLiked|is_liked|is-liked|favorite|favorited)["'=:\s]+(?:false|0)|(?:action|mode|state)["'=:\s]+(?:unlike|remove|delete|off|inactive|false|0)/i;
  const REMOVE_WORD_PATTERN = /delete|remove|destroy|unregister|unfavorite|解除|削除|外す/i;
  const INSPECTION_WORD_PATTERN =
    /confirm|check|count|stats|summary|analytics|report|detail|details|metadata|preview|registered|exists|確認|管理|一覧|履歴|集計|統計|分析|レポート/i;
  const REPATCH_INTERVAL_MS = 1500;
  const REPATCH_MAX_ATTEMPTS = 60;

  let patchedFetch = null;

  patchFetch();
  patchXhr();
  keepBridgePatchedForSpaBoot();

  function keepBridgePatchedForSpaBoot() {
    let attempts = 0;
    const timerId = window.setInterval(() => {
      attempts += 1;
      patchFetch();
      patchXhr();
      if (
        attempts >= REPATCH_MAX_ATTEMPTS ||
        !document.documentElement ||
        document.documentElement.dataset.nicoRepo2BridgeInjected !== "true"
      ) {
        window.clearInterval(timerId);
      }
    }, REPATCH_INTERVAL_MS);
  }

  function patchFetch() {
    if (typeof window.fetch !== "function" || window.fetch === patchedFetch) {
      return;
    }

    if (window.fetch.__nicoRepo2Patched) {
      patchedFetch = window.fetch;
      return;
    }

    const originalFetch = window.fetch;

    window.fetch = function nicoRepo2Fetch(input, init) {
      const request = describeFetchRequest(input, init);
      const responsePromise = originalFetch.apply(this, arguments);

      responsePromise
        .then(async (response) => {
          await inspectCompletedRequest(request, response?.status, () => safeReadResponseText(response));
        })
        .catch(() => {});

      return responsePromise;
    };

    window.fetch.__nicoRepo2Patched = true;
    window.fetch.__nicoRepo2Original = originalFetch;
    patchedFetch = window.fetch;
  }

  function describeFetchRequest(input, init = {}) {
    const request = {
      url: "",
      method: "GET",
      startedAt: Date.now(),
      bodyTextPromise: Promise.resolve("")
    };

    try {
      if (typeof input === "string" || input instanceof URL) {
        request.url = String(input);
      } else if (input instanceof Request) {
        request.url = input.url;
        request.method = input.method || request.method;
        request.bodyTextPromise = input
          .clone()
          .text()
          .catch(() => "");
      }

      if (init && typeof init === "object") {
        request.method = String(init.method || request.method || "GET").toUpperCase();
        if (Object.prototype.hasOwnProperty.call(init, "body")) {
          request.bodyTextPromise = serializeBody(init.body);
        }
      }
    } catch (error) {
      request.bodyTextPromise = Promise.resolve("");
    }

    request.method = String(request.method || "GET").toUpperCase();
    return request;
  }

  function patchXhr() {
    if (!window.XMLHttpRequest || window.XMLHttpRequest.prototype.__nicoRepo2Patched) {
      return;
    }

    const prototype = window.XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;

    prototype.open = function nicoRepo2Open(method, url) {
      this.__nicoRepo2Request = {
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
        startedAt: 0,
        bodyTextPromise: Promise.resolve("")
      };
      return originalOpen.apply(this, arguments);
    };

    prototype.send = function nicoRepo2Send(body) {
      const request = this.__nicoRepo2Request || {
        method: "GET",
        url: "",
        startedAt: 0,
        bodyTextPromise: Promise.resolve("")
      };
      request.startedAt = Date.now();
      request.bodyTextPromise = serializeBody(body);

      this.addEventListener("loadend", () => {
        inspectCompletedRequest(request, this.status, () => Promise.resolve(safeXhrResponseText(this))).catch(() => {});
      });

      return originalSend.apply(this, arguments);
    };

    prototype.__nicoRepo2Patched = true;
  }

  async function inspectCompletedRequest(request, status, responseTextFactory) {
    if (!request || !isSuccessStatus(status) || !ADDITIVE_METHODS.has(request.method)) {
      return;
    }

    const bodyText = await request.bodyTextPromise.catch(() => "");
    const requestText = safeDecodeURIComponent(`${request.url}\n${bodyText}`);
    const responseText = await responseTextFactory().catch(() => "");
    const combinedText = `${request.url}\n${bodyText}\n${responseText}`;

    const isMylistRegistration = looksLikeMylistRegistrationRequest(requestText, combinedText);
    const isLikeRegistration = looksLikeLikeRegistrationRequest(requestText, combinedText);

    if (!isMylistRegistration && !isLikeRegistration) {
      if (looksLikeInterestingMylistRequest(requestText, combinedText)) {
        postDiagnostic("page-bridge-mylist", "Mylist-like request was observed but not classified as registration", {
          method: request.method,
          requestUrl: String(request.url || "").slice(0, 500),
          videoId: extractVideoId(requestText) || extractVideoId(responseText),
          mylistId: extractMylistId(requestText) || extractMylistId(responseText),
          status,
          requestText: requestText.slice(0, 500)
        });
      }
      return;
    }

    const videoId = extractVideoId(requestText) || extractVideoId(responseText);
    if (!videoId) {
      postDiagnostic("page-bridge-mylist", "Request was classified as Nico action but videoId was not found", {
        method: request.method,
        requestUrl: String(request.url || "").slice(0, 500),
        isMylistRegistration,
        isLikeRegistration,
        mylistId: extractMylistId(requestText) || extractMylistId(responseText),
        requestText: requestText.slice(0, 500)
      });
      return;
    }

    if (isMylistRegistration) {
      postRegisteredAction(
        TYPE_MYLIST_REGISTERED,
        videoId,
        request,
        getRegisteredMylistPublicState(requestText, combinedText),
        extractMylistId(requestText) || extractMylistId(responseText)
      );
      return;
    }

    if (isLikeRegistration) {
      postRegisteredAction(TYPE_LIKE_REGISTERED, videoId, request);
    }
  }

  function postRegisteredAction(type, videoId, request, publicState = "", mylistId = "") {
    window.postMessage(
      {
        source: SOURCE,
        type,
        payload: {
          videoId,
          url: normalizeWatchUrl(videoId),
          method: request.method,
          requestUrl: String(request.url || "").slice(0, 500),
          requestStartedAt: request.startedAt || 0,
          requestCompletedAt: Date.now(),
          publicState,
          mylistId
        }
      },
      window.location.origin
    );
  }

  function postDiagnostic(status, message, details = {}) {
    window.postMessage(
      {
        source: SOURCE,
        type: TYPE_DIAGNOSTIC,
        payload: {
          status,
          message,
          details
        }
      },
      window.location.origin
    );
  }

  function getMylistPublicState(text) {
    const value = safeDecodeURIComponent(String(text || ""));
    const valueWithoutPrivateWord = value.replace(/非公開/g, "");
    const hasPrivate =
      /(?:isPublic|is_public|public|isOpen|is_open|isVisible|is_visible)["'=:\s]+(?:false|0)|(?:isPrivate|is_private|isClosed|is_closed|private|closed|hidden)["'=:\s]+(?:true|1)|(?:visibility|privacy|publicity|scope|status)["'=:\s]+(?:private|closed|hidden|非公開)|非公開|(?:^|[^a-z])private(?:[^a-z]|$)/i.test(
        value
      );
    const hasPublic =
      /(?:isPublic|is_public|isOpen|is_open|isVisible|is_visible)["'=:\s]+(?:true|1)|(?:isPrivate|is_private|isClosed|is_closed|private|closed|hidden)["'=:\s]+(?:false|0)|(?:visibility|privacy|publicity|scope|status)["'=:\s]+(?:public|open|visible|公開)|公開|(?:^|[^a-z])public(?:[^a-z]|$)/i.test(
        valueWithoutPrivateWord
      );

    if (hasPrivate && hasPublic) {
      return "";
    }

    if (hasPrivate) {
      return "private";
    }

    if (hasPublic) {
      return "public";
    }

    return "";
  }

  function getRegisteredMylistPublicState(requestText, combinedText) {
    const explicitState = getMylistPublicState(combinedText);
    if (explicitState) {
      return explicitState;
    }

    // 旧UI/一般会員で使われる「とりあえずマイリスト」追加API。
    // group_id が無く公開確認APIへ進めないため、非公開マーカーがない場合は公開登録として扱う。
    if (looksLikeDefaultMylistRegistrationRequest(requestText)) {
      return "public";
    }

    return "";
  }

  function looksLikeDefaultMylistRegistrationRequest(requestText) {
    return /(?:^|\/)(?:api\/)?deflist\/add(?:[\s?#/&]|$)/i.test(
      String(requestText || "")
    );
  }

  function looksLikeMylistRegistrationRequest(requestText, combinedText) {
    if (!MYLIST_WORD_PATTERN.test(combinedText) && !MYLIST_WORD_PATTERN.test(requestText)) {
      return false;
    }

    if (REMOVE_WORD_PATTERN.test(requestText) || INSPECTION_WORD_PATTERN.test(requestText)) {
      return false;
    }

    return (
      MYLIST_REGISTRATION_URL_PATTERN.test(requestText) ||
      MYLIST_REGISTRATION_BODY_PATTERN.test(requestText) ||
      (MYLIST_ID_BODY_PATTERN.test(requestText) && VIDEO_ID_PATTERN.test(requestText))
    );
  }

  function looksLikeInterestingMylistRequest(requestText, combinedText) {
    if (REMOVE_WORD_PATTERN.test(requestText) || INSPECTION_WORD_PATTERN.test(requestText)) {
      return false;
    }

    return Boolean(
      (MYLIST_WORD_PATTERN.test(combinedText) || MYLIST_WORD_PATTERN.test(requestText) || MYLIST_ID_BODY_PATTERN.test(requestText)) &&
        (VIDEO_ID_PATTERN.test(requestText) || VIDEO_ID_PATTERN.test(combinedText))
    );
  }

  function looksLikeLikeRegistrationRequest(requestText, combinedText) {
    if (!LIKE_WORD_PATTERN.test(combinedText)) {
      return false;
    }

    if (
      MYLIST_WORD_PATTERN.test(requestText) ||
      REMOVE_WORD_PATTERN.test(requestText) ||
      INSPECTION_WORD_PATTERN.test(requestText) ||
      LIKE_NEGATIVE_STATE_PATTERN.test(requestText)
    ) {
      return false;
    }

    return (
      LIKE_REGISTRATION_URL_PATTERN.test(requestText) ||
      (LIKE_REGISTRATION_BODY_PATTERN.test(requestText) && LIKE_WORD_PATTERN.test(requestText))
    );
  }

  function isSuccessStatus(status) {
    const value = Number(status);
    return value >= 200 && value < 300;
  }

  async function serializeBody(body) {
    try {
      if (!body) {
        return "";
      }

      if (typeof body === "string") {
        return body;
      }

      if (body instanceof URLSearchParams) {
        return body.toString();
      }

      if (body instanceof FormData) {
        return Array.from(body.entries())
          .map(([key, value]) => `${key}=${value instanceof File ? value.name : String(value)}`)
          .join("&");
      }

      if (body instanceof Blob) {
        return await body.text();
      }

      if (body instanceof ArrayBuffer) {
        return new TextDecoder().decode(body);
      }

      if (ArrayBuffer.isView(body)) {
        return new TextDecoder().decode(body);
      }

      return String(body);
    } catch (error) {
      return "";
    }
  }

  async function safeReadResponseText(response) {
    try {
      if (!response || typeof response.clone !== "function") {
        return "";
      }

      const contentType = response.headers?.get?.("content-type") || "";
      if (contentType && !/json|text|html|javascript|xml|form/i.test(contentType)) {
        return "";
      }

      return (await response.clone().text()).slice(0, 5000);
    } catch (error) {
      return "";
    }
  }

  function safeXhrResponseText(xhr) {
    try {
      if (xhr.responseType && xhr.responseType !== "text" && xhr.responseType !== "") {
        return "";
      }
      return String(xhr.responseText || "").slice(0, 5000);
    } catch (error) {
      return "";
    }
  }

  function extractVideoId(value) {
    const text = String(value || "");
    const decoded = safeDecodeURIComponent(text);
    const match =
      decoded.match(/(?:videoId|video_id|watchId|watch_id|itemId|item_id|contentId|content_id)["'=:\s]+((?:sm|nm|so)\d+)/i) ||
      decoded.match(/\/watch\/((?:sm|nm|so)\d+)/i) ||
      decoded.match(VIDEO_ID_PATTERN);

    return match ? match[1] || match[0] : "";
  }

  function extractMylistId(value) {
    const text = safeDecodeURIComponent(String(value || ""));
    const match =
      text.match(/(?:mylistId|mylist_id|listId|list_id|folderId|folder_id|groupId|group_id)["'=:\s]+["']?(\d+)/i) ||
      text.match(/\/(?:mylist|mylists|my-list|playlist)s?\/(\d+)(?:[/?#]|$)/i);

    return match ? match[1] : "";
  }

  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }

  function normalizeWatchUrl(videoId) {
    return `https://www.nicovideo.jp/watch/${videoId}`;
  }
})();
