const formatter = new Intl.NumberFormat();

const elements = {
  openTabsLine: document.getElementById("openTabsLine"),
  closedEverLine: document.getElementById("closedEverLine"),
  closedWeekLine: document.getElementById("closedWeekLine"),
  restoredEverLine: document.getElementById("restoredEverLine"),
  restoredWeekLine: document.getElementById("restoredWeekLine"),
  storageLine: document.getElementById("storageLine")
};

function formatCount(value) {
  return formatter.format(Number(value) || 0);
}

function formatPercentChange(current, previous) {
  if (previous <= 0) {
    return null;
  }

  const change = ((current - previous) / previous) * 100;
  const rounded = `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;

  return {
    text: rounded,
    className: change >= 0 ? "trend trend--positive" : "trend trend--negative"
  };
}

async function getOpenTabsCount() {
  const tabs = await chrome.tabs.query({});
  return tabs.length;
}

function renderTrendLine(element, current, previous, label) {
  const trend = formatPercentChange(current, previous);

  if (!trend) {
    element.textContent = `${label}: ${formatCount(current)}`;
    return;
  }

  element.innerHTML = `${label}: ${formatCount(current)} (<span class="${trend.className}">${trend.text}</span> from the week before)`;
}

async function renderSnapshot(snapshot) {
  try {
    const openTabs = await getOpenTabsCount();
    elements.openTabsLine.textContent = `Currently tabs open: ${formatCount(openTabs)}`;
  } catch {
    elements.openTabsLine.textContent = "Currently tabs open: --";
  }

  elements.closedEverLine.textContent = `Tabs closed ever: ${formatCount(snapshot.totalClosed)}`;
  renderTrendLine(elements.closedWeekLine, snapshot.thisWeekClosed, snapshot.previous7DaysClosed, "This week");
  elements.restoredEverLine.textContent = `Tabs restored ever: ${formatCount(snapshot.totalRestored)}`;
  renderTrendLine(elements.restoredWeekLine, snapshot.thisWeekRestored, snapshot.previous7DaysRestored, "This week");
  elements.storageLine.textContent = `Tracking for ${formatCount(snapshot.trackedDays)} day${snapshot.trackedDays === 1 ? "" : "s"}.`;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

async function loadStats() {
  try {
    const response = await sendMessage({ type: "getStats" });

    if (!response?.ok) {
      throw new Error(response?.error || "Unable to load stats.");
    }

    await renderSnapshot(response.snapshot);
  } catch (error) {
    elements.storageLine.textContent = error instanceof Error ? error.message : "Unable to load stats.";
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.closedTabsStats) {
    loadStats();
  }
});

loadStats();