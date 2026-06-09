// ==UserScript==
// @name         nodeseek-sou
// @namespace    https://github.com/mskatoni/nodeseek-sou
// @version      0.2.2
// @description  低内存友好的 NodeSeek 多页帖子抓取、过滤和排序工具。
// @author       mskatoni
// @homepageURL  https://github.com/mskatoni/nodeseek-sou
// @supportURL   https://github.com/mskatoni/nodeseek-sou/issues
// @match        https://www.nodeseek.com/*
// @match        https://nodeseek.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @license      AGPL-3.0-only
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_PREFIX = "nsmps_";
  const MAX_EXTRA_PAGES = 100;
  const MAX_FILTER_DAYS = 3650;
  const MIN_USER_LEVEL = 0;
  const MAX_USER_LEVEL = 15;
  const USER_LEVEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_USER_LEVEL_CONCURRENCY = 2;
  const MIN_USER_LEVEL_CONCURRENCY = 1;
  const MAX_USER_LEVEL_CONCURRENCY = 5;
  const USER_LEVEL_CACHE_MAX = 1200;
  const USER_LEVEL_FAILED_TTL_MS = 20 * 60 * 1000;
  const USER_LEVEL_429_COOLDOWN_MS = 60 * 1000;
  const DB_NAME = "nodeseek-sou";
  const DB_VERSION = 1;
  const PAGE_CACHE_STORE = "page-cache";
  const PAGE_CACHE_TTL_MS = 30 * 60 * 1000;
  const FETCH_DELAY_MS = 5000;
  const DEFAULT_BLOCK_INTERVAL_MS = 2000;
  const MIN_BLOCK_INTERVAL_MS = 1000;
  const MAX_BLOCK_INTERVAL_MS = 10000;
  const MAX_BLOCK_THRESHOLD = 9999;
  const MAX_BLOCK_PREVIEW_TITLES = 3;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const POST_LIST_SELECTOR = "#nsk-body-left ul.post-list:not(.topic-carousel-panel), ul.post-list:not(.topic-carousel-panel)";
  const POST_ITEM_SELECTOR = "li.post-list-item";
  const TITLE_LINK_SELECTOR = ".post-title a[href], a.post-title[href]";
  const NEXT_PAGE_SELECTOR = ".nsk-pager a.pager-next[href]";

  const state = {
    busy: false,
    cancelled: false,
    originalListHtml: null,
    originalNextHref: null,
    userLevelCache: null,
    levelApiPausedUntil: 0,
    abortController: null,
    lastProcessedRecords: [],
    bulkBlockBusy: false,
    bulkBlockAbortController: null,
    dbPromise: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);

  function getValue(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(STORAGE_PREFIX + key, fallback);
    } catch (_) {
      // Fall back to localStorage below.
    }

    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function setValue(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(STORAGE_PREFIX + key, value);
        return;
      }
    } catch (_) {
      // Fall back to localStorage below.
    }

    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (_) {
      // Ignore storage failures.
    }
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function openCacheDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (state.dbPromise) return state.dbPromise;

    state.dbPromise = new Promise(resolve => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PAGE_CACHE_STORE)) {
          db.createObjectStore(PAGE_CACHE_STORE, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn("[nodeseek-sou] IndexedDB 打开失败", request.error);
        resolve(null);
      };
      request.onblocked = () => {
        console.warn("[nodeseek-sou] IndexedDB 打开被阻塞");
        resolve(null);
      };
    });

    return state.dbPromise;
  }

  function getListScopeKey() {
    return `${location.origin}${location.pathname}${location.search}`;
  }

  function getPageCacheKey(scopeKey, pageUrl) {
    return `${scopeKey}::${pageUrl}`;
  }

  async function getCachedPage(scopeKey, pageUrl) {
    try {
      const db = await openCacheDb();
      if (!db) return null;

      const tx = db.transaction(PAGE_CACHE_STORE, "readonly");
      const store = tx.objectStore(PAGE_CACHE_STORE);
      const cached = await idbRequest(store.get(getPageCacheKey(scopeKey, pageUrl)));

      if (!cached || Date.now() - Number(cached.fetchedAt || 0) > PAGE_CACHE_TTL_MS) {
        return null;
      }

      if (!Array.isArray(cached.records)) return null;
      return cached;
    } catch (error) {
      console.warn("[nodeseek-sou] 读取页缓存失败", error);
      return null;
    }
  }

  async function setCachedPage(scopeKey, pageUrl, nextHref, records) {
    try {
      const db = await openCacheDb();
      if (!db) return;

      const tx = db.transaction(PAGE_CACHE_STORE, "readwrite");
      const store = tx.objectStore(PAGE_CACHE_STORE);
      const cacheRecord = {
        key: getPageCacheKey(scopeKey, pageUrl),
        scopeKey,
        pageUrl,
        nextHref,
        records,
        fetchedAt: Date.now(),
      };

      await idbRequest(store.put(cacheRecord));
    } catch (error) {
      console.warn("[nodeseek-sou] 写入页缓存失败", error);
    }
  }

  function clampPages(value) {
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, MAX_EXTRA_PAGES);
  }

  function clampDays(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return 0;

    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, MAX_FILTER_DAYS);
  }

  function clampLevelThreshold(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    return Math.min(Math.max(n, MIN_USER_LEVEL), MAX_USER_LEVEL);
  }

  function clampLevelConcurrency(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return DEFAULT_USER_LEVEL_CONCURRENCY;

    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_USER_LEVEL_CONCURRENCY;
    return Math.min(Math.max(n, MIN_USER_LEVEL_CONCURRENCY), MAX_USER_LEVEL_CONCURRENCY);
  }

  function clampBlockThreshold(value) {
    const n = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, MAX_BLOCK_THRESHOLD);
  }

  function clampBlockInterval(value) {
    const n = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n)) return DEFAULT_BLOCK_INTERVAL_MS;
    return Math.min(Math.max(n, MIN_BLOCK_INTERVAL_MS), MAX_BLOCK_INTERVAL_MS);
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) {
      throw new DOMException("操作已中止", "AbortError");
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("操作已中止", "AbortError"));
        return;
      }

      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("操作已中止", "AbortError"));
      }, { once: true });
    });
  }

  function processRecordsMainThread(records, filters, mode) {
    const matched = records.filter(record => recordMatchesFilters(record, filters));
    return {
      records: sortRecords(matched, mode),
      matchedCount: matched.length,
      usedWorker: false,
    };
  }

  function getRecordWorkerSource() {
    return `
      function recordMatchesFilters(record, filters) {
        if (filters.days > 0 && (!record.createdAt || record.createdAt < filters.cutoff)) {
          return false;
        }

        if (filters.usernames.length > 0) {
          const aliases = record.authorAliasesNormalized || [];
          if (!aliases.some(alias => filters.usernames.includes(alias))) {
            return false;
          }
        }

        if (filters.maxBlockedLevel != null && record.authorLevel != null && record.authorLevel <= filters.maxBlockedLevel) {
          return false;
        }

        return true;
      }

      function sortRecords(records, mode) {
        const secondary = mode === "views" ? "comments" : "views";
        return records.slice().sort((a, b) =>
          (b[mode] - a[mode]) ||
          (b[secondary] - a[secondary]) ||
          (a.order - b.order)
        );
      }

      self.onmessage = event => {
        const { records, filters, mode } = event.data;
        const matched = records.filter(record => recordMatchesFilters(record, filters));
        self.postMessage({
          records: sortRecords(matched, mode),
          matchedCount: matched.length
        });
      };
    `;
  }

  function processRecords(records, filters, mode, signal) {
    if (typeof Worker !== "function" || typeof Blob !== "function" || typeof URL?.createObjectURL !== "function") {
      return Promise.resolve(processRecordsMainThread(records, filters, mode));
    }

    return new Promise(resolve => {
      let worker = null;
      let objectUrl = "";

      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        worker?.terminate();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };

      const fallback = () => {
        cleanup();
        resolve(processRecordsMainThread(records, filters, mode));
      };

      const onAbort = () => {
        cleanup();
        resolve(processRecordsMainThread([], filters, mode));
      };

      try {
        objectUrl = URL.createObjectURL(new Blob([getRecordWorkerSource()], { type: "text/javascript" }));
        worker = new Worker(objectUrl);
      } catch (error) {
        console.warn("[nodeseek-sou] Worker 创建失败，回退主线程", error);
        fallback();
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      worker.onmessage = event => {
        cleanup();
        resolve({
          records: event.data.records || [],
          matchedCount: Number(event.data.matchedCount || 0),
          usedWorker: true,
        });
      };
      worker.onerror = error => {
        console.warn("[nodeseek-sou] Worker 处理失败，回退主线程", error);
        fallback();
      };
      worker.postMessage({ records, filters, mode });
    });
  }

  function getPostList(root = document) {
    return $(POST_LIST_SELECTOR, root);
  }

  function getPostItemsFromList(list) {
    if (!list) return [];
    return Array.from(list.children).filter(item =>
      item.matches(POST_ITEM_SELECTOR) &&
      !item.classList.contains("topic-carousel-item") &&
      !item.closest(".topic-carousel-panel")
    );
  }

  function absoluteUrl(rawUrl, baseUrl) {
    if (!rawUrl || /^(javascript:|mailto:|#)/i.test(rawUrl)) return rawUrl || "";
    try {
      return new URL(rawUrl, baseUrl || location.href).href;
    } catch (_) {
      return rawUrl;
    }
  }

  function getNextHref(root = document, baseUrl = location.href) {
    const next = $(NEXT_PAGE_SELECTOR, root);
    const rawHref = next?.getAttribute("href") || next?.href || "";
    return rawHref ? absoluteUrl(rawHref, baseUrl) : "";
  }

  function getTitleLink(item) {
    return $(TITLE_LINK_SELECTOR, item);
  }

  function getPostHref(item, baseUrl) {
    const link = getTitleLink(item);
    const rawHref = link?.getAttribute("href") || link?.href || "";
    return rawHref ? absoluteUrl(rawHref, baseUrl) : "";
  }

  function getPostTitle(item) {
    const link = getTitleLink(item);
    return String(link?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function getPostKey(item, href) {
    const source = href || getPostHref(item, location.href);
    const idMatch = source.match(/\/post-(\d+)(?:-|\/|$)/);
    if (idMatch) return `post-${idMatch[1]}`;
    return source.split("#")[0].split("?")[0] || `unknown-${Math.random()}`;
  }

  function parseCount(rawText) {
    const text = String(rawText || "")
      .replace(/,/g, "")
      .replace(/\s+/g, "")
      .trim();

    if (!text) return 0;

    const match = text.match(/(\d+(?:\.\d+)?)(万|w|k|m|千)?/i);
    if (!match) return 0;

    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) return 0;

    const unit = (match[2] || "").toLowerCase();
    const factor =
      unit === "万" || unit === "w" ? 10000 :
      unit === "千" || unit === "k" ? 1000 :
      unit === "m" ? 1000000 :
      1;

    return Math.round(value * factor);
  }

  function readMetric(item, type) {
    const selector = type === "views"
      ? ".post-info .info-views span[title], .post-info .info-views span, .post-info .info-views"
      : ".post-info .info-comments-count span[title], .post-info .info-comments-count span, .post-info .info-comments-count";

    const el = $(selector, item);
    return parseCount(el?.getAttribute("title") || el?.textContent || "");
  }

  function readCategoryText(item) {
    const category = $(".post-category, .post-topic, .post-node, .post-tag", item);
    return String(category?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return "";

    try {
      const date = new Date(timestamp);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const hour = String(date.getHours()).padStart(2, "0");
      const minute = String(date.getMinutes()).padStart(2, "0");
      return `${year}-${month}-${day} ${hour}:${minute}`;
    } catch (_) {
      return "";
    }
  }

  function normalizeUsername(name) {
    return String(name || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
  }

  function readAuthorAliases(item) {
    const aliases = [];
    const authorLink = $(".post-info .info-author a, .info-author a", item);
    const authorImg = $("img.avatar-normal[alt], img.avatar[alt]", item);

    if (authorLink?.textContent) aliases.push(authorLink.textContent.trim());
    if (authorImg?.alt) aliases.push(authorImg.alt.trim());

    return Array.from(new Set(aliases.filter(Boolean)));
  }

  function extractAuthorIdFromUrl(rawUrl) {
    const match = String(rawUrl || "").match(/\/space\/(\d+)/);
    return match ? match[1] : "";
  }

  function readAuthorId(item) {
    const authorLink = $(
      ".post-info .info-author a[href*=\"/space/\"], .info-author a[href*=\"/space/\"], a[href*=\"/space/\"]",
      item
    );

    return extractAuthorIdFromUrl(authorLink?.getAttribute("href") || authorLink?.href || "");
  }

  function parseAuthorLevelText(rawText) {
    const text = String(rawText || "").trim();
    if (!text) return null;

    const classMatch = text.match(/(?:^|\s)user-lv(\d{1,2})(?:\s|$)/i);
    if (classMatch) return clampLevelThreshold(classMatch[1]);

    const levelMatch = text.match(/(?:等级|level|lv)\s*\.?\s*(\d{1,2})/i);
    if (levelMatch) return clampLevelThreshold(levelMatch[1]);

    return null;
  }

  function readAuthorLevel(item) {
    const candidates = Array.from(item.querySelectorAll([
      ".role-tag.user-level",
      ".user-level",
      "[class*=\"user-lv\"]",
      "[title*=\"等级\"]",
      "[aria-label*=\"等级\"]"
    ].join(", ")));

    for (const el of candidates) {
      const className = String(el.className?.baseVal || el.className || "");
      const fromClass = parseAuthorLevelText(className);
      if (fromClass != null) return fromClass;

      const fromTitle = parseAuthorLevelText(el.getAttribute("title") || el.getAttribute("aria-label") || "");
      if (fromTitle != null) return fromTitle;

      const title = String(el.getAttribute("title") || "");
      if (title.includes("等级")) {
        const directNumber = String(el.textContent || "").match(/(\d{1,2})/);
        const level = directNumber ? clampLevelThreshold(directNumber[1]) : null;
        if (level != null) return level;
      }

      const fromText = parseAuthorLevelText(el.textContent || "");
      if (fromText != null) return fromText;
    }

    const infoText = String($(".post-info", item)?.textContent || "");
    return parseAuthorLevelText(infoText);
  }

  function getUserLevelCache() {
    if (state.userLevelCache) return state.userLevelCache;

    const cache = getValue("user_level_cache_v1", {});
    state.userLevelCache = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
    return state.userLevelCache;
  }

  function pruneUserLevelCache(cache, now = Date.now()) {
    const entries = Object.entries(cache)
      .filter(([, entry]) => {
        if (!entry) return false;
        const timestamp = Number(entry.timestamp || 0);
        const ttl = entry.failed ? USER_LEVEL_FAILED_TTL_MS : USER_LEVEL_CACHE_TTL_MS;
        return now - timestamp < ttl;
      })
      .sort((a, b) => Number(b[1].timestamp || 0) - Number(a[1].timestamp || 0))
      .slice(0, USER_LEVEL_CACHE_MAX);

    return Object.fromEntries(entries);
  }

  function saveUserLevelCache() {
    const pruned = pruneUserLevelCache(getUserLevelCache());
    state.userLevelCache = pruned;
    setValue("user_level_cache_v1", pruned);
  }

  function getCachedAuthorLevelEntry(authorId) {
    if (!authorId) return null;

    const cache = getUserLevelCache();
    const entry = cache[authorId];
    if (!entry) return null;

    const ttl = entry.failed ? USER_LEVEL_FAILED_TTL_MS : USER_LEVEL_CACHE_TTL_MS;
    if (Date.now() - Number(entry.timestamp || 0) >= ttl) {
      delete cache[authorId];
      return null;
    }

    return entry;
  }

  function getCachedAuthorLevel(authorId) {
    const entry = getCachedAuthorLevelEntry(authorId);
    if (!entry || entry.failed) return null;
    return clampLevelThreshold(entry.level);
  }

  function hasRecentAuthorLevelFailure(authorId) {
    const entry = getCachedAuthorLevelEntry(authorId);
    return Boolean(entry?.failed);
  }

  function setCachedAuthorLevel(authorId, level) {
    if (!authorId || level == null) return;

    const cache = getUserLevelCache();
    cache[authorId] = {
      level: clampLevelThreshold(level),
      timestamp: Date.now(),
      failed: false,
    };
  }

  function setCachedAuthorLevelFailure(authorId, reason) {
    if (!authorId) return;

    const cache = getUserLevelCache();
    cache[authorId] = {
      timestamp: Date.now(),
      failedAt: Date.now(),
      failed: true,
      reason: String(reason || "unknown"),
    };
  }

  function readLevelFromApiPayload(data) {
    const detail = data?.detail || data?.data?.detail || data?.data || data?.user || data?.userInfo || data;
    const rawLevel = detail?.rank ?? detail?.level ?? detail?.userLevel;
    return clampLevelThreshold(rawLevel);
  }

  async function fetchAuthorLevel(authorId, signal) {
    if (!authorId) return null;
    throwIfAborted(signal);

    const apiUrl = `${location.origin}/api/account/getInfo/${encodeURIComponent(authorId)}`;
    const response = await fetch(apiUrl, {
      method: "GET",
      credentials: "include",
      signal,
      headers: {
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        state.levelApiPausedUntil = Date.now() + USER_LEVEL_429_COOLDOWN_MS;
        throw new Error("账号等级接口请求过快（HTTP 429）");
      }
      throw new Error(`账号等级接口 HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data && data.success === false) return null;

    return readLevelFromApiPayload(data);
  }

  async function resolveUnknownAuthorLevels(records, filters, setStatus, signal) {
    if (filters.maxBlockedLevel == null) return { checked: 0, fetched: 0, failed: 0 };
    throwIfAborted(signal);

    const now = Date.now();
    if (state.levelApiPausedUntil > now) {
      const seconds = Math.ceil((state.levelApiPausedUntil - now) / 1000);
      if (setStatus) setStatus(`作者等级接口冷却中，约 ${seconds} 秒后再试；本批未知等级将保留。`);
      return { checked: 0, fetched: 0, failed: 0, pausedBy429: true };
    }

    const unknownRecords = records.filter(record => record.authorLevel == null && record.authorId);
    if (unknownRecords.length === 0) return { checked: 0, fetched: 0, failed: 0 };

    let checked = 0;
    let fetched = 0;
    let failed = 0;
    let pausedBy429 = false;
    const pendingAuthorIds = [];
    const pendingSeen = new Set();

    for (const record of unknownRecords) {
      const cachedLevel = getCachedAuthorLevel(record.authorId);
      if (cachedLevel != null) {
        record.authorLevel = cachedLevel;
        checked += 1;
        continue;
      }

      if (hasRecentAuthorLevelFailure(record.authorId)) {
        failed += 1;
        continue;
      }

      if (!pendingSeen.has(record.authorId)) {
        pendingSeen.add(record.authorId);
        pendingAuthorIds.push(record.authorId);
      }
    }

    if (pendingAuthorIds.length === 0 || state.cancelled) {
      return { checked, fetched, failed, pausedBy429 };
    }

    const concurrency = Math.min(filters.levelConcurrency, pendingAuthorIds.length);
    let cursor = 0;

    async function worker(workerIndex) {
      while (!state.cancelled && !pausedBy429) {
        throwIfAborted(signal);

        const authorId = pendingAuthorIds[cursor];
        cursor += 1;

        if (!authorId) break;

        const current = Math.min(cursor, pendingAuthorIds.length);
        try {
          if (setStatus) {
            setStatus(`正在补全作者等级 ${current}/${pendingAuthorIds.length}，并发 ${concurrency}...`);
          }

          const level = await fetchAuthorLevel(authorId, signal);
          if (level != null) {
            setCachedAuthorLevel(authorId, level);
            records
              .filter(item => item.authorId === authorId && item.authorLevel == null)
              .forEach(item => {
                item.authorLevel = level;
              });
            fetched += 1;
          } else {
            setCachedAuthorLevelFailure(authorId, "empty-level");
            failed += 1;
          }
        } catch (error) {
          if (error?.name === "AbortError") throw error;

          console.warn("[nodeseek-sou] 获取作者等级失败", authorId, error);
          failed += 1;

          if (String(error?.message || "").includes("429")) {
            pausedBy429 = true;
            state.levelApiPausedUntil = Date.now() + USER_LEVEL_429_COOLDOWN_MS;
            if (setStatus) {
              setStatus(`作者等级接口返回 429，已暂停本轮等级补全。已完成 ${current}/${pendingAuthorIds.length}。`);
            }
            break;
          }

          setCachedAuthorLevelFailure(authorId, error?.message || "request-failed");
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
    saveUserLevelCache();

    return { checked, fetched, failed, pausedBy429 };
  }

  function parsePostTimestamp(rawText, now = Date.now()) {
    const text = String(rawText || "").trim();
    if (!text) return 0;

    if (/刚刚|just\s*now/i.test(text)) return now;

    const relativeMatch = text.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|分|小时|天|日|周|星期|个月|月|年|second|minute|hour|day|week|month|year)s?\s*(?:前|ago)?/i);
    if (relativeMatch && (text.includes("前") || /ago/i.test(text))) {
      const value = Number.parseFloat(relativeMatch[1]);
      const unit = relativeMatch[2].toLowerCase();
      const factor =
        unit === "秒" || unit === "second" ? 1000 :
        unit === "分钟" || unit === "分" || unit === "minute" ? 60 * 1000 :
        unit === "小时" || unit === "hour" ? 60 * 60 * 1000 :
        unit === "天" || unit === "日" || unit === "day" ? DAY_MS :
        unit === "周" || unit === "星期" || unit === "week" ? 7 * DAY_MS :
        unit === "个月" || unit === "月" || unit === "month" ? 30 * DAY_MS :
        unit === "年" || unit === "year" ? 365 * DAY_MS :
        0;

      return factor ? now - value * factor : 0;
    }

    if (text.includes("昨天")) return now - DAY_MS;
    if (text.includes("前天")) return now - 2 * DAY_MS;

    const cjkMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?\s*(?:(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (cjkMatch) {
      return new Date(
        Number(cjkMatch[1]),
        Number(cjkMatch[2]) - 1,
        Number(cjkMatch[3]),
        Number(cjkMatch[4] || 0),
        Number(cjkMatch[5] || 0),
        Number(cjkMatch[6] || 0)
      ).getTime();
    }

    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return parsed;

    const normalized = text.replace(/\./g, "-").replace(/\//g, "-");
    const fullMatch = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (fullMatch) {
      return new Date(
        Number(fullMatch[1]),
        Number(fullMatch[2]) - 1,
        Number(fullMatch[3]),
        Number(fullMatch[4] || 0),
        Number(fullMatch[5] || 0),
        Number(fullMatch[6] || 0)
      ).getTime();
    }

    const shortMatch = normalized.match(/(^|\D)(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (shortMatch) {
      const nowDate = new Date(now);
      let timestamp = new Date(
        nowDate.getFullYear(),
        Number(shortMatch[2]) - 1,
        Number(shortMatch[3]),
        Number(shortMatch[4] || 0),
        Number(shortMatch[5] || 0),
        Number(shortMatch[6] || 0)
      ).getTime();

      if (timestamp > now + DAY_MS) {
        timestamp = new Date(
          nowDate.getFullYear() - 1,
          Number(shortMatch[2]) - 1,
          Number(shortMatch[3]),
          Number(shortMatch[4] || 0),
          Number(shortMatch[5] || 0),
          Number(shortMatch[6] || 0)
        ).getTime();
      }

      return timestamp;
    }

    return 0;
  }

  function readPostTimestamp(item) {
    const timeEl = $(".post-info time[datetime], .post-info time[title], .post-info time, time[datetime], time[title], time", item);
    const rawTime = timeEl?.getAttribute("datetime") || timeEl?.getAttribute("title") || timeEl?.textContent || "";
    return parsePostTimestamp(rawTime);
  }

  function makeRecord(item, baseUrl, pageIndex, order) {
    const href = getPostHref(item, baseUrl);
    const title = getPostTitle(item);
    const authorAliases = readAuthorAliases(item);
    const authorId = readAuthorId(item);
    const authorLevel = readAuthorLevel(item);
    const createdAt = readPostTimestamp(item);
    const record = {
      href,
      title,
      category: readCategoryText(item),
      key: getPostKey(item, href),
      pageIndex,
      order,
      authorName: authorAliases[0] || "",
      authorId,
      authorAliases,
      authorAliasesNormalized: authorAliases.map(normalizeUsername).filter(Boolean),
      authorLevel,
      createdAt,
      views: readMetric(item, "views"),
      comments: readMetric(item, "comments"),
    };
    return record;
  }

  function snapshotOriginal() {
    if (state.originalListHtml != null) return;

    const list = getPostList();
    state.originalListHtml = list?.innerHTML || "";
    state.originalNextHref = getNextHref(document, location.href);
  }

  function collectFromOriginalSnapshot(orderStart = 0) {
    snapshotOriginal();
    const wrapper = document.createElement("ul");
    wrapper.innerHTML = state.originalListHtml || "";

    return getPostItemsFromList(wrapper).map((item, index) =>
      makeRecord(item, location.href, 0, orderStart + index)
    );
  }

  function collectFromDocument(doc, baseUrl, pageIndex, orderStart) {
    const list = getPostList(doc);
    if (!list) {
      throw new Error("未找到帖子列表，可能触发防护页或页面结构已变化");
    }

    return getPostItemsFromList(list).map((item, index) =>
      makeRecord(item, baseUrl, pageIndex, orderStart + index)
    );
  }

  function reindexCachedRecords(records, pageIndex, orderStart) {
    return records.map((record, index) => ({
      ...record,
      pageIndex,
      order: orderStart + index,
      authorAliasesNormalized: Array.isArray(record.authorAliasesNormalized)
        ? record.authorAliasesNormalized
        : (record.authorAliases || []).map(normalizeUsername).filter(Boolean),
    }));
  }

  function appendUniqueRecords(records, incomingRecords, seenKeys) {
    let fetched = 0;

    for (const record of incomingRecords) {
      if (seenKeys.has(record.key)) continue;

      seenKeys.add(record.key);
      fetched += 1;
      records.push(record);
    }

    return {
      fetched,
    };
  }

  async function fetchDocument(url, signal) {
    throwIfAborted(signal);

    const response = await fetch(url, {
      credentials: "include",
      signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function blockMember(authorName, signal) {
    const name = String(authorName || "").trim();
    if (!name) throw new Error("缺少用户名");
    throwIfAborted(signal);

    const response = await fetch(`${location.origin}/api/block-list/add`, {
      method: "POST",
      credentials: "include",
      signal,
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ block_member_name: name }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      const error = new Error(data?.message ? `HTTP ${response.status}: ${data.message}` : `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    if (data && data.success === false) {
      throw new Error(data.message || "屏蔽接口返回失败");
    }

    return data;
  }

  async function runBulkBlock(candidates, intervalMs, setStatus, signal) {
    let success = 0;
    let failed = 0;
    const errors = [];

    for (let index = 0; index < candidates.length; index += 1) {
      throwIfAborted(signal);

      if (index > 0) {
        await sleep(intervalMs, signal);
      }

      const candidate = candidates[index];
      setStatus(`正在屏蔽 ${index + 1}/${candidates.length}：${candidate.authorName}`);

      try {
        await blockMember(candidate.authorName, signal);
        success += 1;
      } catch (error) {
        if (error?.name === "AbortError") throw error;

        failed += 1;
        errors.push(`${candidate.authorName}: ${error?.message || error}`);

        if ([401, 403, 429, 503].includes(error?.status)) {
          return {
            success,
            failed,
            stoppedByStatus: error.status,
            errors,
          };
        }
      }
    }

    return {
      success,
      failed,
      stoppedByStatus: 0,
      errors,
    };
  }

  async function collectPages(extraPages, filters, mode, setStatus, signal) {
    let records = [];
    let order = 0;
    let fetchedCount = 0;
    let cacheHitCount = 0;
    const seenKeys = new Set();
    const scopeKey = getListScopeKey();
    let nextHref = state.originalNextHref || getNextHref(document, location.href);
    let loadedExtraPages = 0;

    async function resolveBatch(recordsBatch, nextPageToLoad, cacheInfo, shouldCooldown) {
      const levelPromise = resolveUnknownAuthorLevels(recordsBatch, filters, setStatus, signal);

      if (nextPageToLoad && shouldCooldown && !state.cancelled) {
        setStatus(`等待 5 秒后加载后续第 ${nextPageToLoad}/${extraPages} 页... 同时补全作者等级，已收集 ${fetchedCount} 帖`);
        await Promise.all([sleep(FETCH_DELAY_MS, signal), levelPromise]);
      } else {
        await levelPromise;
      }

      const appendResult = appendUniqueRecords(records, recordsBatch, seenKeys);
      fetchedCount += appendResult.fetched;

      if (cacheInfo) {
        await setCachedPage(scopeKey, cacheInfo.pageUrl, cacheInfo.nextHref, recordsBatch);
      }
    }

    throwIfAborted(signal);

    let pendingRecords = collectFromOriginalSnapshot(order);
    let pendingCacheInfo = null;
    order += pendingRecords.length;

    for (let page = 1; page <= extraPages && nextHref; page += 1) {
      if (state.cancelled) break;
      throwIfAborted(signal);

      const pageUrl = nextHref;
      const cachedPage = await getCachedPage(scopeKey, pageUrl);
      if (cachedPage) {
        await resolveBatch(pendingRecords, 0, pendingCacheInfo, false);

        const pageRecords = reindexCachedRecords(cachedPage.records, page, order);
        order += pageRecords.length;
        nextHref = cachedPage.nextHref || "";
        loadedExtraPages = page;
        cacheHitCount += 1;
        pendingRecords = pageRecords;
        pendingCacheInfo = null;
        setStatus(`命中缓存：后续第 ${page}/${extraPages} 页，已收集 ${fetchedCount} 帖`);
        continue;
      }

      await resolveBatch(pendingRecords, page, pendingCacheInfo, true);

      setStatus(`正在加载后续第 ${page}/${extraPages} 页...`);

      let doc = await fetchDocument(pageUrl, signal);
      const pageRecords = collectFromDocument(doc, pageUrl, page, order);
      order += pageRecords.length;
      nextHref = getNextHref(doc, pageUrl);
      doc = null;

      loadedExtraPages = page;
      pendingRecords = pageRecords;
      pendingCacheInfo = { pageUrl, nextHref };
    }

    await resolveBatch(pendingRecords, 0, pendingCacheInfo, false);

    return {
      records,
      loadedExtraPages,
      hasMore: Boolean(nextHref),
      cancelled: state.cancelled,
      fetchedCount,
      cacheHitCount,
    };
  }

  function sortRecords(records, mode) {
    const secondary = mode === "views" ? "comments" : "views";
    return records.slice().sort((a, b) =>
      (b[mode] - a[mode]) ||
      (b[secondary] - a[secondary]) ||
      (a.order - b.order)
    );
  }

  function parseUsernameFilter(rawText) {
    return Array.from(new Set(
      String(rawText || "")
        .split(/[\s,，;；]+/)
        .map(normalizeUsername)
        .filter(Boolean)
    ));
  }

  function parseKeywordFilter(rawText) {
    return Array.from(new Set(
      String(rawText || "")
        .split(/[\n,，;；|]+/)
        .map(item => item.trim().toLowerCase())
        .filter(Boolean)
    ));
  }

  function recordTitleMatchesKeywords(record, keywords) {
    const title = String(record?.title || "").toLowerCase();
    return Boolean(title) && keywords.some(keyword => title.includes(keyword));
  }

  function getBulkBlockCandidates(records, keywords, threshold) {
    if (!Array.isArray(records) || records.length === 0 || keywords.length === 0) return [];

    const grouped = new Map();
    for (const record of records) {
      if (!recordTitleMatchesKeywords(record, keywords)) continue;

      const authorName = String(record.authorName || "").trim();
      if (!authorName) continue;

      const entry = grouped.get(authorName) || {
        authorName,
        count: 0,
        titles: [],
      };
      entry.count += 1;

      if (entry.titles.length < MAX_BLOCK_PREVIEW_TITLES) {
        entry.titles.push(record.title || record.href || "(无标题)");
      }

      grouped.set(authorName, entry);
    }

    return Array.from(grouped.values())
      .filter(entry => entry.count > threshold)
      .sort((a, b) => (b.count - a.count) || a.authorName.localeCompare(b.authorName, "zh-Hans-CN"));
  }

  function makeFilters(days, usernameText, maxBlockedLevel, levelConcurrency) {
    const usernames = parseUsernameFilter(usernameText);
    const cutoff = days > 0 ? Date.now() - days * DAY_MS : 0;

    return {
      days,
      usernames,
      maxBlockedLevel,
      levelConcurrency,
      cutoff,
    };
  }

  function recordMatchesFilters(record, filters) {
    if (filters.days > 0 && (!record.createdAt || record.createdAt < filters.cutoff)) {
      return false;
    }

    if (filters.usernames.length > 0) {
      const aliases = record.authorAliasesNormalized || [];
      if (!aliases.some(alias => filters.usernames.includes(alias))) {
        return false;
      }
    }

    if (filters.maxBlockedLevel != null && record.authorLevel != null && record.authorLevel <= filters.maxBlockedLevel) {
      return false;
    }

    return true;
  }

  function describeFilters(filters) {
    const parts = [];

    if (filters.days > 0) parts.push(`最近 ${filters.days} 天`);
    if (filters.usernames.length > 0) parts.push(`用户 ${filters.usernames.join(", ")}`);
    if (filters.maxBlockedLevel != null) parts.push(`隐藏等级 <= ${filters.maxBlockedLevel}（未知保留）`);

    return parts.length ? `，过滤：${parts.join(" + ")}` : "";
  }

  function renderRecords(records) {
    const list = getPostList();
    if (!list) throw new Error("未找到帖子列表");

    const fragment = document.createDocumentFragment();

    for (const record of records) {
      const item = document.createElement("li");
      item.className = "post-list-item";
      item.dataset.nsmpsViews = String(record.views);
      item.dataset.nsmpsComments = String(record.comments);
      item.dataset.nsmpsSourcePage = String(record.pageIndex);
      item.dataset.nsmpsAuthor = record.authorName;
      item.dataset.nsmpsAuthorId = record.authorId;
      item.dataset.nsmpsAuthorLevel = record.authorLevel == null ? "" : String(record.authorLevel);
      item.dataset.nsmpsCreatedAt = String(record.createdAt || "");

      const titleWrap = document.createElement("div");
      titleWrap.className = "post-title";

      const titleLink = document.createElement("a");
      titleLink.href = record.href;
      titleLink.textContent = record.title || record.href || "(无标题)";
      titleWrap.appendChild(titleLink);

      const info = document.createElement("div");
      info.className = "post-info nsmps-lite-info";

      const metaParts = [];
      if (record.category) metaParts.push(record.category);
      if (record.authorName) metaParts.push(`作者 ${record.authorName}`);
      if (record.authorLevel != null) metaParts.push(`Lv${record.authorLevel}`);
      if (record.createdAt) metaParts.push(formatTimestamp(record.createdAt));
      metaParts.push(`浏览 ${record.views}`);
      metaParts.push(`评论 ${record.comments}`);
      metaParts.push(`来源第 ${record.pageIndex + 1} 页`);

      info.textContent = metaParts.join(" · ");
      item.append(titleWrap, info);
      fragment.appendChild(item);
    }

    list.replaceChildren(fragment);
  }

  function restoreOriginal(setStatus) {
    snapshotOriginal();

    const list = getPostList();
    if (!list || state.originalListHtml == null) return;

    list.innerHTML = state.originalListHtml;
    state.lastProcessedRecords = [];
    setStatus("已恢复为当前页原始列表。");
  }

  function formatMetricName(mode) {
    return mode === "views" ? "浏览量" : "评论数";
  }

  function setBusy(panel, busy) {
    state.busy = busy;
    panel.querySelectorAll("button, input").forEach(el => {
      if (el.dataset.role === "cancel") {
        el.disabled = !busy;
      } else {
        el.disabled = busy;
      }
    });
  }

  async function runSort(mode, panel, pageInput, dayInput, usernameInput, levelInput, concurrencyInput, setStatus) {
    if (state.busy) return;

    const extraPages = clampPages(pageInput.value);
    const filterDays = clampDays(dayInput.value);
    const usernameText = String(usernameInput.value || "").trim();
    const maxBlockedLevel = clampLevelThreshold(levelInput.value);
    const levelConcurrency = clampLevelConcurrency(concurrencyInput.value);
    const filters = makeFilters(filterDays, usernameText, maxBlockedLevel, levelConcurrency);

    pageInput.value = String(extraPages);
    dayInput.value = filterDays > 0 ? String(filterDays) : "";
    usernameInput.value = usernameText;
    levelInput.value = maxBlockedLevel == null ? "" : String(maxBlockedLevel);
    concurrencyInput.value = String(levelConcurrency);

    setValue("extra_pages", extraPages);
    setValue("filter_days", filterDays);
    setValue("filter_username", usernameText);
    setValue("max_blocked_level", maxBlockedLevel);
    setValue("level_concurrency", levelConcurrency);
    setValue("sort_mode", mode);

    state.cancelled = false;
    state.lastProcessedRecords = [];
    state.abortController = new AbortController();
    setBusy(panel, true);

    try {
      const { records: collectedRecords, loadedExtraPages, hasMore, cancelled, fetchedCount, cacheHitCount } =
        await collectPages(extraPages, filters, mode, setStatus, state.abortController.signal);
      setStatus(`正在过滤和排序 ${collectedRecords.length} 条记录...`);
      const processed = await processRecords(collectedRecords, filters, mode, state.abortController.signal);
      throwIfAborted(state.abortController.signal);
      renderRecords(processed.records);
      state.lastProcessedRecords = processed.records;

      const limitText = hasMore && loadedExtraPages === extraPages ? "，后面还有更多页未加载" : "";
      const cancelText = cancelled ? "（已中止）" : "";
      const filterText = describeFilters(filters);
      const workerText = processed.usedWorker ? "，Worker 已启用" : "，主线程回退";
      const cacheText = cacheHitCount > 0 ? `，缓存命中 ${cacheHitCount} 页` : "";
      setStatus(
        `${cancelText}完成：当前页 + 后续 ${loadedExtraPages} 页，收集 ${fetchedCount} 帖，匹配并显示 ${processed.matchedCount} 帖，按${formatMetricName(mode)}从高到低排序${filterText}${cacheText}${workerText}${limitText}。`
      );
    } catch (error) {
      console.error("[NodeSeek Multi-page Sorter]", error);
      if (error?.name === "AbortError") {
        setStatus("已中止。");
      } else {
        setStatus(`失败：${error?.message || error}`);
      }
    } finally {
      setBusy(panel, false);
      state.cancelled = false;
      state.abortController = null;
    }
  }

  function addStyle() {
    if ($("#nsmps-style")) return;

    const style = document.createElement("style");
    style.id = "nsmps-style";
    style.textContent = `
      #nsmps-panel {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin: 8px 0;
        padding: 8px 10px;
        border: 1px solid var(--border-color, rgba(127, 127, 127, .25));
        border-radius: 6px;
        background: var(--panel-background-color, var(--component-background-color, rgba(127, 127, 127, .08)));
        color: var(--text-primary-color, inherit);
        font-size: 13px;
      }

      #nsmps-panel input {
        width: 68px;
        min-height: 28px;
        box-sizing: border-box;
        border: 1px solid var(--border-color, rgba(127, 127, 127, .35));
        border-radius: 4px;
        padding: 2px 6px;
        color: inherit;
        background: var(--input-background-color, transparent);
      }

      #nsmps-panel input[data-role="days"] {
        width: 76px;
      }

      #nsmps-panel input[data-role="username"] {
        width: 128px;
      }

      #nsmps-panel input[data-role="level"] {
        width: 74px;
      }

      #nsmps-panel input[data-role="level-concurrency"] {
        width: 74px;
      }

      #nsmps-panel button {
        min-height: 28px;
        border: 1px solid var(--border-color, rgba(127, 127, 127, .35));
        border-radius: 4px;
        padding: 2px 9px;
        cursor: pointer;
        color: var(--text-primary-color, inherit);
        background: var(--button-background-color, rgba(127, 127, 127, .12));
      }

      #nsmps-panel button:hover:not(:disabled) {
        border-color: var(--link-color, #409eff);
        color: var(--link-color, #409eff);
      }

      #nsmps-panel button:disabled,
      #nsmps-panel input:disabled {
        cursor: not-allowed;
        opacity: .55;
      }

      #nsmps-status {
        flex: 1 1 260px;
        min-width: 180px;
        color: var(--text-secondary-color, #777);
        line-height: 1.45;
      }

      #nsmps-bulk-panel {
        margin: 0 0 8px;
        padding: 8px 10px;
        border: 1px solid var(--border-color, rgba(127, 127, 127, .25));
        border-radius: 6px;
        background: var(--panel-background-color, var(--component-background-color, rgba(127, 127, 127, .08)));
        color: var(--text-primary-color, inherit);
        font-size: 13px;
      }

      #nsmps-bulk-panel summary {
        cursor: pointer;
        font-weight: 600;
        line-height: 1.6;
        user-select: none;
      }

      #nsmps-bulk-panel[open] summary {
        margin-bottom: 8px;
      }

      #nsmps-bulk-panel .nsmps-bulk-grid {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }

      #nsmps-bulk-panel input {
        min-height: 28px;
        box-sizing: border-box;
        border: 1px solid var(--border-color, rgba(127, 127, 127, .35));
        border-radius: 4px;
        padding: 2px 6px;
        color: inherit;
        background: var(--input-background-color, transparent);
      }

      #nsmps-bulk-panel input[data-role="block-keywords"] {
        width: 280px;
        max-width: min(58vw, 100%);
      }

      #nsmps-bulk-panel input[data-role="block-threshold"] {
        width: 82px;
      }

      #nsmps-bulk-panel input[data-role="block-interval"] {
        width: 96px;
      }

      #nsmps-bulk-panel button {
        min-height: 28px;
        border: 1px solid var(--border-color, rgba(127, 127, 127, .35));
        border-radius: 4px;
        padding: 2px 9px;
        cursor: pointer;
        color: var(--text-primary-color, inherit);
        background: var(--button-background-color, rgba(127, 127, 127, .12));
      }

      #nsmps-bulk-panel button:hover:not(:disabled) {
        border-color: var(--link-color, #409eff);
        color: var(--link-color, #409eff);
      }

      #nsmps-bulk-panel button:disabled,
      #nsmps-bulk-panel input:disabled {
        cursor: not-allowed;
        opacity: .55;
      }

      #nsmps-bulk-status {
        margin-top: 8px;
        color: var(--text-secondary-color, #777);
        line-height: 1.45;
      }

      #nsmps-bulk-preview {
        margin-top: 6px;
        max-height: 180px;
        overflow: auto;
        color: var(--text-secondary-color, #777);
        line-height: 1.45;
      }

      .nsmps-bulk-candidate {
        padding: 4px 0;
        border-top: 1px solid var(--border-color, rgba(127, 127, 127, .18));
      }

      .nsmps-bulk-candidate:first-child {
        border-top: 0;
      }

      .nsmps-bulk-candidate strong {
        color: var(--text-primary-color, inherit);
      }

      .nsmps-bulk-candidate-title {
        margin-top: 2px;
        font-size: 12px;
      }

      .nsmps-lite-info {
        margin-top: 4px;
        color: var(--text-secondary-color, #777);
        font-size: 12px;
        line-height: 1.5;
      }
    `;
    document.head.appendChild(style);
  }

  function setBulkBlockBusy(panel, busy) {
    state.bulkBlockBusy = busy;
    panel.querySelectorAll("button, input").forEach(el => {
      if (el.dataset.role === "block-cancel") {
        el.disabled = !busy;
      } else {
        el.disabled = busy;
      }
    });
  }

  function renderBulkPreview(preview, candidates) {
    preview.replaceChildren();
    if (candidates.length === 0) return;

    const fragment = document.createDocumentFragment();
    for (const candidate of candidates) {
      const item = document.createElement("div");
      item.className = "nsmps-bulk-candidate";

      const summary = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = candidate.authorName;
      summary.append(name, document.createTextNode(`：${candidate.count} 条命中`));
      item.appendChild(summary);

      if (candidate.titles.length > 0) {
        const title = document.createElement("div");
        title.className = "nsmps-bulk-candidate-title";
        title.textContent = candidate.titles.join(" / ");
        item.appendChild(title);
      }

      fragment.appendChild(item);
    }

    preview.appendChild(fragment);
  }

  function createBulkBlockPanel() {
    if ($("#nsmps-bulk-panel")) return null;

    const panel = document.createElement("details");
    panel.id = "nsmps-bulk-panel";
    panel.innerHTML = `
      <summary>批量屏蔽</summary>
      <div class="nsmps-bulk-grid">
        <label>标题关键词
          <input data-role="block-keywords" type="text" placeholder="中转站,注册送,企业级">
        </label>
        <label>命中帖数&gt;
          <input data-role="block-threshold" type="number" min="0" max="${MAX_BLOCK_THRESHOLD}" step="1">
        </label>
        <label>间隔ms
          <input data-role="block-interval" type="number" min="${MIN_BLOCK_INTERVAL_MS}" max="${MAX_BLOCK_INTERVAL_MS}" step="500">
        </label>
        <button type="button" data-role="block-preview">预览账号</button>
        <button type="button" data-role="block-run">执行屏蔽</button>
        <button type="button" data-role="block-cancel" disabled>中止屏蔽</button>
      </div>
      <div id="nsmps-bulk-status">先运行上方筛选/排序，再按关键词预览候选账号。</div>
      <div id="nsmps-bulk-preview"></div>
    `;

    const keywordInput = panel.querySelector('[data-role="block-keywords"]');
    const thresholdInput = panel.querySelector('[data-role="block-threshold"]');
    const intervalInput = panel.querySelector('[data-role="block-interval"]');
    const status = panel.querySelector("#nsmps-bulk-status");
    const preview = panel.querySelector("#nsmps-bulk-preview");
    const setStatus = message => {
      status.textContent = message;
    };

    function readSettings() {
      const keywordText = String(keywordInput.value || "").trim();
      const threshold = clampBlockThreshold(thresholdInput.value);
      const intervalMs = clampBlockInterval(intervalInput.value);

      keywordInput.value = keywordText;
      thresholdInput.value = String(threshold);
      intervalInput.value = String(intervalMs);

      setValue("bulk_block_keywords", keywordText);
      setValue("bulk_block_threshold", threshold);
      setValue("bulk_block_interval_ms", intervalMs);

      return {
        keywordText,
        keywords: parseKeywordFilter(keywordText),
        threshold,
        intervalMs,
      };
    }

    function previewCandidates() {
      const settings = readSettings();
      renderBulkPreview(preview, []);

      if (state.busy) {
        setStatus("上方筛选/排序仍在运行，完成后再预览。");
        return [];
      }

      if (state.lastProcessedRecords.length === 0) {
        setStatus("请先运行上方筛选/排序；批量屏蔽只处理当前已筛选结果。");
        return [];
      }

      if (settings.keywords.length === 0) {
        setStatus("请填写至少一个标题关键词。");
        return [];
      }

      const candidates = getBulkBlockCandidates(state.lastProcessedRecords, settings.keywords, settings.threshold);
      renderBulkPreview(preview, candidates);
      setStatus(
        `预览：${state.lastProcessedRecords.length} 条当前结果中，${candidates.length} 个账号的关键词命中帖数 > ${settings.threshold}。`
      );
      return candidates;
    }

    keywordInput.value = String(getValue("bulk_block_keywords", "") || "");
    thresholdInput.value = String(clampBlockThreshold(getValue("bulk_block_threshold", 2)));
    intervalInput.value = String(clampBlockInterval(getValue("bulk_block_interval_ms", DEFAULT_BLOCK_INTERVAL_MS)));

    keywordInput.addEventListener("change", readSettings);
    thresholdInput.addEventListener("change", readSettings);
    intervalInput.addEventListener("change", readSettings);

    panel.querySelector('[data-role="block-preview"]').addEventListener("click", () => {
      previewCandidates();
    });

    panel.querySelector('[data-role="block-run"]').addEventListener("click", async () => {
      if (state.bulkBlockBusy) return;

      const settings = readSettings();
      const candidates = previewCandidates();
      if (candidates.length === 0) return;

      const names = candidates.slice(0, 20).map(candidate => candidate.authorName).join(", ");
      const moreText = candidates.length > 20 ? `\n...另 ${candidates.length - 20} 个账号` : "";
      const ok = window.confirm(`将按 ${settings.intervalMs}ms 间隔屏蔽 ${candidates.length} 个账号：\n${names}${moreText}`);
      if (!ok) return;

      state.bulkBlockAbortController = new AbortController();
      setBulkBlockBusy(panel, true);

      try {
        const result = await runBulkBlock(candidates, settings.intervalMs, setStatus, state.bulkBlockAbortController.signal);
        const errorText = result.errors.length > 0 ? `；失败：${result.errors.slice(0, 3).join("；")}` : "";
        if (result.stoppedByStatus) {
          setStatus(`屏蔽接口返回 ${result.stoppedByStatus}，已停止本轮。成功 ${result.success}，失败 ${result.failed}${errorText}`);
        } else {
          setStatus(`批量屏蔽完成：成功 ${result.success}，失败 ${result.failed}${errorText}`);
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          setStatus("已中止批量屏蔽。");
        } else {
          setStatus(`批量屏蔽失败：${error?.message || error}`);
        }
      } finally {
        setBulkBlockBusy(panel, false);
        state.bulkBlockAbortController = null;
      }
    });

    panel.querySelector('[data-role="block-cancel"]').addEventListener("click", () => {
      state.bulkBlockAbortController?.abort();
      setStatus("正在中止批量屏蔽...");
    });

    return panel;
  }

  function createPanel() {
    if ($("#nsmps-panel")) return;

    const list = getPostList();
    if (!list) return;

    snapshotOriginal();
    addStyle();

    const panel = document.createElement("div");
    panel.id = "nsmps-panel";
    panel.innerHTML = `
      <span>多页排序</span>
      <label>后续页数
        <input data-role="pages" type="number" min="0" max="${MAX_EXTRA_PAGES}" step="1">
      </label>
      <label>天内
        <input data-role="days" type="number" min="0" max="${MAX_FILTER_DAYS}" step="1" placeholder="不限">
      </label>
      <label>用户名
        <input data-role="username" type="text" placeholder="不限">
      </label>
      <label>隐藏等级<=
        <input data-role="level" type="number" min="${MIN_USER_LEVEL}" max="${MAX_USER_LEVEL}" step="1" placeholder="关闭">
      </label>
      <label>等级并发
        <input data-role="level-concurrency" type="number" min="${MIN_USER_LEVEL_CONCURRENCY}" max="${MAX_USER_LEVEL_CONCURRENCY}" step="1">
      </label>
      <button type="button" data-role="sort-views">浏览量排序</button>
      <button type="button" data-role="sort-comments">评论数排序</button>
      <button type="button" data-role="restore">恢复当前页</button>
      <button type="button" data-role="cancel" disabled>中止</button>
      <span id="nsmps-status">填 X 后点击排序；天数/用户名/等级留空表示不过滤。</span>
    `;

    const pageInput = panel.querySelector('[data-role="pages"]');
    const dayInput = panel.querySelector('[data-role="days"]');
    const usernameInput = panel.querySelector('[data-role="username"]');
    const levelInput = panel.querySelector('[data-role="level"]');
    const concurrencyInput = panel.querySelector('[data-role="level-concurrency"]');
    const status = panel.querySelector("#nsmps-status");
    const setStatus = message => {
      status.textContent = message;
    };

    pageInput.value = String(clampPages(getValue("extra_pages", 3)));
    dayInput.value = clampDays(getValue("filter_days", 0)) || "";
    usernameInput.value = String(getValue("filter_username", "") || "");
    levelInput.value = clampLevelThreshold(getValue("max_blocked_level", "")) ?? "";
    concurrencyInput.value = String(clampLevelConcurrency(getValue("level_concurrency", DEFAULT_USER_LEVEL_CONCURRENCY)));

    pageInput.addEventListener("change", () => {
      const pages = clampPages(pageInput.value);
      pageInput.value = String(pages);
      setValue("extra_pages", pages);
    });

    dayInput.addEventListener("change", () => {
      const days = clampDays(dayInput.value);
      dayInput.value = days > 0 ? String(days) : "";
      setValue("filter_days", days);
    });

    usernameInput.addEventListener("change", () => {
      const usernameText = String(usernameInput.value || "").trim();
      usernameInput.value = usernameText;
      setValue("filter_username", usernameText);
    });

    levelInput.addEventListener("change", () => {
      const maxBlockedLevel = clampLevelThreshold(levelInput.value);
      levelInput.value = maxBlockedLevel == null ? "" : String(maxBlockedLevel);
      setValue("max_blocked_level", maxBlockedLevel);
    });

    concurrencyInput.addEventListener("change", () => {
      const levelConcurrency = clampLevelConcurrency(concurrencyInput.value);
      concurrencyInput.value = String(levelConcurrency);
      setValue("level_concurrency", levelConcurrency);
    });

    panel.querySelector('[data-role="sort-views"]').addEventListener("click", () => {
      runSort("views", panel, pageInput, dayInput, usernameInput, levelInput, concurrencyInput, setStatus);
    });

    panel.querySelector('[data-role="sort-comments"]').addEventListener("click", () => {
      runSort("comments", panel, pageInput, dayInput, usernameInput, levelInput, concurrencyInput, setStatus);
    });

    panel.querySelector('[data-role="restore"]').addEventListener("click", () => {
      restoreOriginal(setStatus);
    });

    panel.querySelector('[data-role="cancel"]').addEventListener("click", () => {
      state.cancelled = true;
      state.abortController?.abort();
      setStatus("正在中止...");
    });

    const bulkPanel = createBulkBlockPanel();
    const anchor = $(".sorter") || $(".nsk-pager.pager-top") || list;
    if (anchor === list) {
      list.before(panel);
    } else {
      anchor.after(panel);
    }
    if (bulkPanel) panel.after(bulkPanel);

    const lastMode = getValue("sort_mode", "");
    if (lastMode === "views" || lastMode === "comments") {
      setStatus(`上次使用：按${formatMetricName(lastMode)}排序。`);
    }
  }

  function init() {
    if (!/^\/(?:categories\/|page|award|search|$)/.test(location.pathname)) return;

    if (getPostList()) {
      createPanel();
      return;
    }

    const observer = new MutationObserver(() => {
      if (getPostList()) {
        observer.disconnect();
        createPanel();
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 8000);
  }

  init();
})();
