const STORAGE_KEY = "closedTabsStats";
const MAX_BUCKET_AGE_DAYS = 400;
const RESTORE_SYNC_ALARM = "restore-sync";

const DEFAULT_STATE = {
  totalClosed: 0,
  totalRestored: 0,
  dailyClosedBuckets: {},
  dailyRestoredBuckets: {},
  recentlyClosedSessions: [],
  lastObservedAt: 0
};

let writeQueue = Promise.resolve();

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function normalizeBuckets(buckets) {
  if (!buckets || typeof buckets !== "object") {
    return {};
  }

  const normalized = {};

  for (const [dateKey, value] of Object.entries(buckets)) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) {
      normalized[dateKey] = count;
    }
  }

  return normalized;
}

function getSessionId(session) {
  return String(session?.sessionId || session?.tab?.sessionId || session?.window?.sessionId || "");
}

function getSessionTabCount(session) {
  if (Array.isArray(session?.window?.tabs)) {
    return session.window.tabs.length;
  }

  if (session?.tab) {
    return 1;
  }

  return 1;
}

async function captureRecentlyClosedSessions() {
  try {
    const recentSessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });

    return recentSessions
      .map((session) => ({
        sessionId: getSessionId(session),
        tabCount: getSessionTabCount(session)
      }))
      .filter((session) => session.sessionId);
  } catch {
    return null;
  }
}

function cloneState(state) {
  const migratedClosedBuckets = normalizeBuckets(state?.dailyClosedBuckets || state?.dailyBuckets);

  return {
    totalClosed: Number(state?.totalClosed) || 0,
    totalRestored: Number(state?.totalRestored) || 0,
    dailyClosedBuckets: migratedClosedBuckets,
    dailyRestoredBuckets: normalizeBuckets(state?.dailyRestoredBuckets),
    recentlyClosedSessions: Array.isArray(state?.recentlyClosedSessions)
      ? state.recentlyClosedSessions
          .map((entry) => ({
            sessionId: String(entry?.sessionId || ""),
            tabCount: Number(entry?.tabCount) || 1
          }))
          .filter((entry) => entry.sessionId)
      : [],
    lastObservedAt: Number(state?.lastObservedAt) || 0
  };
}

async function loadState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return cloneState(result[STORAGE_KEY]);
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

function pruneBuckets(state, now = new Date()) {
  const cutoff = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - MAX_BUCKET_AGE_DAYS + 1));

  for (const [dateKey, count] of Object.entries(state.dailyClosedBuckets)) {
    const entryDate = parseDateKey(dateKey);
    if (entryDate < cutoff || !Number.isFinite(count)) {
      delete state.dailyClosedBuckets[dateKey];
    }
  }

  for (const [dateKey, count] of Object.entries(state.dailyRestoredBuckets)) {
    const entryDate = parseDateKey(dateKey);
    if (entryDate < cutoff || !Number.isFinite(count)) {
      delete state.dailyRestoredBuckets[dateKey];
    }
  }
}

function sumBucketsBetweenDaysAgo(dailyBuckets, startDaysAgo, endDaysAgo, now = new Date()) {
  const startOfToday = startOfLocalDay(now).getTime();
  let total = 0;

  for (const [dateKey, count] of Object.entries(dailyBuckets)) {
    const entryDate = parseDateKey(dateKey).getTime();
    const dayDiff = Math.round((startOfToday - entryDate) / (24 * 60 * 60 * 1000));

    if (dayDiff >= startDaysAgo && dayDiff <= endDaysAgo && Number.isFinite(count)) {
      total += count;
    }
  }

  return total;
}

function buildSnapshot(state, now = new Date()) {
  const thisWeekClosed = sumBucketsBetweenDaysAgo(state.dailyClosedBuckets, 0, 6, now);
  const previousWeekClosed = sumBucketsBetweenDaysAgo(state.dailyClosedBuckets, 7, 13, now);
  const thisWeekRestored = sumBucketsBetweenDaysAgo(state.dailyRestoredBuckets, 0, 6, now);
  const previousWeekRestored = sumBucketsBetweenDaysAgo(state.dailyRestoredBuckets, 7, 13, now);

  return {
    totalClosed: Number(state.totalClosed) || 0,
    totalRestored: Number(state.totalRestored) || 0,
    thisWeekClosed,
    previous7DaysClosed: previousWeekClosed,
    last30DaysClosed: sumBucketsBetweenDaysAgo(state.dailyClosedBuckets, 0, 29, now),
    last365DaysClosed: sumBucketsBetweenDaysAgo(state.dailyClosedBuckets, 0, 364, now),
    thisWeekRestored,
    previous7DaysRestored: previousWeekRestored,
    trackedDays: Object.keys(state.dailyClosedBuckets).length,
    recentlyClosedSessions: state.recentlyClosedSessions
  };
}

async function recordTabClose() {
  return enqueueWrite(async () => {
    const state = await loadState();
    const key = localDateKey();
    const currentSessions = await captureRecentlyClosedSessions();

    state.totalClosed += 1;
    state.dailyClosedBuckets[key] = (Number(state.dailyClosedBuckets[key]) || 0) + 1;

    pruneBuckets(state);

    if (currentSessions) {
      state.recentlyClosedSessions = currentSessions;
    }

    state.lastObservedAt = Date.now();
    await saveState(state);

    return buildSnapshot(state);
  });
}

async function syncRestoredSessions() {
  return enqueueWrite(async () => {
    const state = await loadState();
    const currentSessions = await captureRecentlyClosedSessions();

    if (!currentSessions) {
      return buildSnapshot(state);
    }

    const currentSessionIds = new Set(currentSessions.map((session) => session.sessionId));
    let restoredCount = 0;

    for (const previousSession of state.recentlyClosedSessions) {
      if (!currentSessionIds.has(previousSession.sessionId)) {
        restoredCount += Number(previousSession.tabCount) || 1;
      }
    }

    if (restoredCount > 0) {
      const key = localDateKey();
      state.totalRestored += restoredCount;
      state.dailyRestoredBuckets[key] = (Number(state.dailyRestoredBuckets[key]) || 0) + restoredCount;
    }

    state.recentlyClosedSessions = currentSessions;
    state.lastObservedAt = Date.now();
    pruneBuckets(state);
    await saveState(state);
    return buildSnapshot(state);
  });
}

chrome.tabs.onRemoved.addListener(() => {
  void recordTabClose();
});

chrome.sessions.onChanged.addListener(() => {
  void syncRestoredSessions();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESTORE_SYNC_ALARM) {
    void syncRestoredSessions();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void enqueueWrite(async () => {
    const state = await loadState();
    const currentSessions = await captureRecentlyClosedSessions();

    if (currentSessions) {
      state.recentlyClosedSessions = currentSessions;
    }

    state.lastObservedAt = Date.now();
    await saveState(state);
    return state;
  });

  chrome.alarms.create(RESTORE_SYNC_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;

  if (type === "getStats") {
    syncRestoredSessions()
      .then(() => loadState())
      .then((state) => {
        sendResponse({ ok: true, snapshot: buildSnapshot(state) });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to load stats." });
      });

    return true;
  }

  if (type === "resetStats") {
    enqueueWrite(async () => {
      const state = cloneState(DEFAULT_STATE);
      await saveState(state);
      return state;
    })
      .then((state) => {
        sendResponse({ ok: true, snapshot: buildSnapshot(state) });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to reset stats." });
      });

    return true;
  }

  return false;
});