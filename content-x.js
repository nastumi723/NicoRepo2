(() => {
  if (window.__nicoRepo2XContentLoaded) {
    return;
  }
  window.__nicoRepo2XContentLoaded = true;

  const DEBUG = false;
  const MESSAGE_X_RESULT = "NICO_REPO2_X_POST_RESULT";
  const MESSAGE_X_START = "NICO_REPO2_X_POST_START";
  const POST_ID_PARAM = "nicorepo2PostId";

  const COMPOSER_SELECTORS = [
    '[data-testid="tweetTextarea_0"]',
    'div[role="textbox"][data-testid^="tweetTextarea"]',
    'div[role="textbox"][aria-label*="Post"]',
    'div[role="textbox"][aria-label*="Tweet"]',
    'div[role="textbox"][aria-label*="ポスト"]',
    'div[role="textbox"][aria-label*="ツイート"]',
    'div.public-DraftEditor-content[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[name="text"]'
  ];

  const POST_BUTTON_SELECTORS = [
    '[data-testid="tweetButton"]',
    '[data-testid="tweetButtonInline"]',
    '[role="button"][data-testid="tweetButton"]',
    '[role="button"][data-testid="tweetButtonInline"]',
    'button[aria-label*="Post"]',
    'button[aria-label*="Tweet"]',
    'button[aria-label*="ポスト"]',
    'button[aria-label*="ツイート"]',
    '[role="button"][aria-label*="Post"]',
    '[role="button"][aria-label*="Tweet"]',
    '[role="button"][aria-label*="ポスト"]',
    '[role="button"][aria-label*="ツイート"]'
  ];

  const BLOCKING_SCREEN_PATTERNS = [
    { pattern: /captcha|arkose|challenge/i, reason: "CAPTCHAまたは認証要求らしき画面を検知しました" },
    { pattern: /account locked|locked your account|アカウント.*ロック|ロックされています/i, reason: "アカウントロック画面を検知しました" },
    { pattern: /temporarily restricted|制限されています|機能を制限|rate limit/i, reason: "制限画面を検知しました" },
    { pattern: /unusual login|不審なログイン|本人確認|verify your identity/i, reason: "追加認証要求らしき画面を検知しました" }
  ];

  const TEXTBOX_WAIT_MS = 12000;
  const BUTTON_WAIT_MS = 8000;
  const SUBMIT_SIGNAL_WAIT_MS = 5000;
  const SUCCESS_WAIT_MS = 12000;

  const startedPostIds = new Set();
  const initialPostId = getQueryParam(POST_ID_PARAM);
  const initialText = getQueryParam("text");

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== MESSAGE_X_START) {
      return false;
    }

    const payload = message.payload || {};
    startPost({
      postId: String(payload.postId || ""),
      text: String(payload.text || "")
    });
    sendResponse({ ok: true });
    return false;
  });

  if (initialPostId && initialText) {
    window.setTimeout(() => {
      if (!startedPostIds.has(initialPostId)) {
        debugLog("falling back to initial intent text because start message did not arrive");
        startPost({ postId: initialPostId, text: initialText });
      }
    }, 6000);
  }

  function startPost(post) {
    if (!post.postId || !post.text) {
      debugLog("X start message was missing postId or text");
      return;
    }

    if (startedPostIds.has(post.postId)) {
      return;
    }

    startedPostIds.add(post.postId);
    run(post).catch((error) => {
      debugLog("X automation failed", error);
      notifyFailure(post.postId, error.message || String(error));
    });
  }

  async function run(post) {
    const blockingReason = detectBlockingScreen();
    if (blockingReason) {
      throw new Error(blockingReason);
    }

    const composer = await waitForComposer();
    await delay(700);
    await fillComposer(composer, post.text);

    const button = await waitForPostButton();
    const beforeClickUrl = location.href;
    const submitSignal = await clickPostButtonUntilSubmitted(button, beforeClickUrl, post.text);

    await waitForSuccess(beforeClickUrl, submitSignal);
    await notifySuccess(post.postId);
  }

  async function waitForComposer() {
    const composer = await waitFor(() => {
      const blockingReason = detectBlockingScreen();
      if (blockingReason) {
        throw new Error(blockingReason);
      }
      return findVisibleElement(COMPOSER_SELECTORS);
    }, TEXTBOX_WAIT_MS);

    if (!composer) {
      throw new Error("投稿欄が見つかりませんでした");
    }

    return composer;
  }

  async function fillComposer(composer, value) {
    composer.focus();
    composer.click();
    await delay(120);

    if (composerHasRequiredContentOnce(composer, value)) {
      return;
    }

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      setNativeValue(composer, "");
      dispatchInputEvents(composer, "");
      setNativeValue(composer, value);
      dispatchInputEvents(composer, value);
      assertComposerHasRequiredContent(composer, value);
      return;
    }

    clearComposer(composer);
    const inserted = insertTextWithSelection(composer, value);
    dispatchInputEvents(composer, value);

    if (!inserted || !composerHasRequiredContentOnce(composer, value)) {
      clearComposer(composer);
      composer.textContent = "";
      dispatchInputEvents(composer, "");
      insertTextWithSelection(composer, value);
      dispatchInputEvents(composer, value);
    }

    await waitFor(() => composerHasRequiredContentOnce(composer, value), 2500);
    assertComposerHasRequiredContent(composer, value);
  }

  function clearComposer(composer) {
    composer.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete", false);
    dispatchInputEvents(composer, "");
  }

  function insertTextWithSelection(composer, value) {
    composer.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand("insertText", false, value);
  }

  function assertComposerHasRequiredContent(composer, expectedText) {
    if (!composerHasRequiredContentOnce(composer, expectedText)) {
      throw new Error("投稿欄にURLまたは必要なタグを正しく入力できませんでした");
    }
  }

  function composerHasRequiredContentOnce(composer, expectedText) {
    const actual = normalizeComparableText(getElementText(composer));
    const actualCompact = compactText(actual);
    const fragments = getRequiredFragments(expectedText);

    if (!fragments.videoTag || !fragments.urlCore) {
      return actual.length > 0;
    }

    const hasUrl = actualCompact.includes(compactText(fragments.urlCore));
    const hasVideoTag = actualCompact.includes(compactText(fragments.videoTag));
    const hasNicoTag = actualCompact.includes(compactText("#ニコニコ動画"));

    return (
      hasUrl &&
      hasVideoTag &&
      hasNicoTag &&
      countOccurrences(actualCompact, compactText(fragments.videoTag)) === 1 &&
      countOccurrences(actualCompact, compactText("#ニコニコ動画")) === 1
    );
  }

  function getRequiredFragments(expectedText) {
    const value = normalizeComparableText(expectedText);
    const urlMatch = value.match(/https?:\/\/(?:www\.)?(nicovideo\.(?:jp|gay))\/watch\/([a-z]{2}\d+)/i);
    const host = urlMatch ? urlMatch[1].toLowerCase() : "";
    const videoId = urlMatch ? urlMatch[2] : "";
    return {
      urlCore: videoId && host ? `${host}/watch/${videoId}` : "",
      videoTag: videoId ? `#${videoId}` : ""
    };
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function dispatchInputEvents(element, value) {
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value
    };

    try {
      element.dispatchEvent(new InputEvent("beforeinput", eventOptions));
      element.dispatchEvent(new InputEvent("input", eventOptions));
    } catch (error) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }

    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitForPostButton() {
    let lastReason = "投稿ボタンが見つかりませんでした";
    const button = await waitFor(() => {
      const blockingReason = detectBlockingScreen();
      if (blockingReason) {
        throw new Error(blockingReason);
      }

      const candidate = findPostButton();
      if (!candidate) {
        lastReason = "投稿ボタンが見つかりませんでした";
        return null;
      }

      if (isDisabled(candidate)) {
        lastReason = "投稿ボタンがdisabledのままです";
        return null;
      }

      return candidate;
    }, BUTTON_WAIT_MS);

    if (!button) {
      throw new Error(lastReason);
    }

    return button;
  }

  async function clickPostButtonUntilSubmitted(initialButton, beforeClickUrl, expectedText) {
    const attempts = [
      { button: initialButton, strategy: "synthetic" },
      { button: null, strategy: "native" },
      { button: null, strategy: "keyboard" },
      { button: null, strategy: "synthetic" }
    ];
    let lastReason = "投稿ボタンを自動クリックできませんでした";

    for (const attempt of attempts) {
      const button = attempt.button || findPostButton();
      if (!button) {
        lastReason = "投稿ボタンが見つかりませんでした";
        continue;
      }

      if (isDisabled(button) && attempt.strategy !== "keyboard") {
        lastReason = "投稿ボタンがdisabledのままです";
        continue;
      }

      try {
        if (attempt.strategy === "keyboard") {
          await submitWithKeyboard(expectedText);
        } else {
          await clickElement(button, attempt.strategy);
        }
      } catch (error) {
        debugLog("click attempt failed", attempt.strategy, error);
        lastReason = `投稿ボタンのクリック試行に失敗しました: ${attempt.strategy}`;
        continue;
      }

      const submitted = await waitFor(() => {
        const failureReason = detectPostFailureSignal();
        if (failureReason) {
          throw new Error(failureReason);
        }

        if (hasImmediateSuccessSignal(beforeClickUrl)) {
          return "success-signal";
        }

        const currentButton = findPostButton();
        if (currentButton && isDisabled(currentButton)) {
          return "button-disabled-after-click";
        }

        const composer = findVisibleElement(COMPOSER_SELECTORS);
        if (!composer || !composerHasRequiredContentOnce(composer, expectedText)) {
          return "composer-cleared-after-click";
        }

        return null;
      }, SUBMIT_SIGNAL_WAIT_MS, 100);

      if (submitted) {
        return submitted;
      }

      lastReason = `投稿ボタン押下後に送信開始を確認できませんでした: ${attempt.strategy}`;
    }

    throw new Error(lastReason);
  }

  async function clickElement(element, strategy) {
    const target = getClickableElement(element);
    target.scrollIntoView({ block: "center", inline: "center" });
    target.focus();
    await delay(80);

    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    };

    for (const eventName of [
      "pointerover",
      "mouseover",
      "pointermove",
      "mousemove",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click"
    ]) {
      const event =
        eventName.startsWith("pointer") && typeof PointerEvent === "function"
          ? new PointerEvent(eventName, eventOptions)
          : new MouseEvent(eventName, eventOptions);
      target.dispatchEvent(event);
    }

    if (strategy === "native") {
      target.click();
    }
  }

  async function submitWithKeyboard(expectedText) {
    const composer = findVisibleElement(COMPOSER_SELECTORS);
    if (!composer || !composerHasRequiredContentOnce(composer, expectedText)) {
      throw new Error("キーボード送信用の投稿欄が見つかりませんでした");
    }

    composer.focus();
    await delay(80);
    for (const options of [
      { key: "Enter", code: "Enter", ctrlKey: true },
      { key: "Enter", code: "Enter", metaKey: true }
    ]) {
      composer.dispatchEvent(new KeyboardEvent("keydown", { ...options, bubbles: true, cancelable: true }));
      composer.dispatchEvent(new KeyboardEvent("keyup", { ...options, bubbles: true, cancelable: true }));
      await delay(250);
      if (hasImmediateSuccessSignal(location.href) || !composerHasRequiredContentOnce(composer, expectedText)) {
        return;
      }
    }
  }

  function getClickableElement(element) {
    return element.closest('button,[role="button"],[data-testid="tweetButton"],[data-testid="tweetButtonInline"]') || element;
  }

  function findPostButton() {
    const candidates = [];

    for (const selector of POST_BUTTON_SELECTORS) {
      document.querySelectorAll(selector).forEach((element) => candidates.push(element));
    }

    document.querySelectorAll("button").forEach((button) => {
      const descriptor = getButtonDescriptor(button);
      if (/^Post$|^Tweet$|ポストする|ポスト|投稿|ツイートする|ツイート/i.test(descriptor)) {
        candidates.push(button);
      }
    });

    document.querySelectorAll('[role="button"]').forEach((button) => {
      const descriptor = getButtonDescriptor(button);
      if (/^Post$|^Tweet$|ポストする|ポスト|投稿|ツイートする|ツイート/i.test(descriptor)) {
        candidates.push(button);
      }
    });

    const visibleCandidates = Array.from(new Set(candidates)).filter((element) => {
      return element instanceof HTMLElement && isVisible(element);
    });

    return visibleCandidates.find((element) => !isDisabled(element)) || visibleCandidates[0] || null;
  }

  async function waitForSuccess(beforeClickUrl, submitSignal) {
    const successSignal = await waitFor(() => {
      const blockingReason = detectBlockingScreen();
      if (blockingReason) {
        throw new Error(blockingReason);
      }

      const failureReason = detectPostFailureSignal();
      if (failureReason) {
        throw new Error(failureReason);
      }

      const definiteSignal = getDefiniteSuccessSignal(beforeClickUrl);
      if (definiteSignal) {
        return definiteSignal;
      }

      return null;
    }, SUCCESS_WAIT_MS);

    if (!successSignal) {
      throw new Error(`投稿ボタンは押されましたが、Xの明確な成功通知を確認できませんでした: ${submitSignal || "no-submit-signal"}`);
    }
  }

  function hasImmediateSuccessSignal(beforeClickUrl) {
    return Boolean(getDefiniteSuccessSignal(beforeClickUrl));
  }

  function getDefiniteSuccessSignal(beforeClickUrl) {
    if (/latest_status_id=|status_id=/.test(location.href)) {
      return "status-id-url";
    }

    const liveText = getLiveRegionText();
    if (/Your post was sent|Your Tweet was sent|ポストを送信しました|ツイートを送信しました|ポストしました|投稿しました/i.test(liveText)) {
      return "success-toast";
    }

    debugLog("success not confirmed yet", { beforeClickUrl, currentUrl: location.href });
    return "";
  }

  function detectPostFailureSignal() {
    const liveText = getLiveRegionText();
    const bodyText = `${liveText}\n${document.body?.innerText || ""}`.slice(0, 12000);

    if (/(?:daily|24.?hour|1日|一日|本日).{0,40}(?:limit|上限|制限)|(?:post|tweet|ポスト|投稿).{0,40}(?:limit|上限).{0,40}(?:reached|exceeded|達しました|超え)|(?:上限|制限).{0,40}(?:post|tweet|ポスト|投稿)/i.test(bodyText)) {
      return "Xの投稿上限に達したため投稿できませんでした";
    }

    if (/could.?n.?t send|failed to send|not sent|try again|something went wrong|送信できません|投稿できません|ポストできません|問題が発生|エラーが発生/i.test(bodyText)) {
      return "X側で投稿失敗またはエラー表示を検知しました";
    }

    return "";
  }

  function detectBlockingScreen() {
    if (/\/login|\/i\/flow\/login/i.test(location.pathname)) {
      return "Xのログイン画面が表示されています";
    }

    if (document.querySelector('input[name="password"], input[type="password"]')) {
      return "Xのログイン画面が表示されています";
    }

    const bodyText = (document.body?.innerText || "").slice(0, 8000);
    for (const entry of BLOCKING_SCREEN_PATTERNS) {
      if (entry.pattern.test(bodyText)) {
        return entry.reason;
      }
    }

    return "";
  }

  function findVisibleElement(selectors) {
    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find((candidate) => {
        return candidate instanceof HTMLElement && isVisible(candidate);
      });

      if (element) {
        return element;
      }
    }

    return null;
  }

  function getButtonDescriptor(button) {
    return [
      button.getAttribute("aria-label"),
      button.getAttribute("data-testid"),
      button.textContent
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isDisabled(element) {
    return Boolean(
      element.disabled ||
        element.getAttribute("aria-disabled") === "true" ||
        element.closest('[aria-disabled="true"]')
    );
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function getElementText(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value || "";
    }
    return element.textContent || "";
  }

  function normalizeComparableText(text) {
    return String(text || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function compactText(text) {
    return normalizeComparableText(text).replace(/\s+/g, "");
  }

  function countOccurrences(value, needle) {
    if (!needle) {
      return 0;
    }

    return value.split(needle).length - 1;
  }

  function getLiveRegionText() {
    const selectors = ['[data-testid="toast"]', '[role="status"]', '[aria-live="polite"]', '[aria-live="assertive"]'];
    return selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .map((element) => element.textContent || "")
      .join("\n");
  }

  function getQueryParam(name) {
    try {
      return new URL(location.href).searchParams.get(name) || "";
    } catch (error) {
      debugLog("failed to read query parameter", name, error);
      return "";
    }
  }

  async function notifySuccess(postId) {
    await sendMessage({
      type: MESSAGE_X_RESULT,
      payload: {
        postId,
        success: true
      }
    });
  }

  async function notifyFailure(postId, reason) {
    await sendMessage({
      type: MESSAGE_X_RESULT,
      payload: {
        postId,
        success: false,
        reason
      }
    });
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          debugLog("failed to send X result", error.message);
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve(response);
      });
    });
  }

  async function waitFor(callback, timeoutMs, intervalMs = 250) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const result = callback();
      if (result) {
        return result;
      }
      await delay(intervalMs);
    }

    return null;
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
