(() => {
  const ENDPOINT = "/api/scan/stream";
  const startBtn = document.getElementById("start-btn");
  const statusText = document.getElementById("status-text");
  const endpointText = document.getElementById("endpoint-text");
  const progressText = null;
  const streamContainer = document.getElementById("stream-container");
  const summaryContainer = document.getElementById("summary-container");
  const header = document.querySelector(".header");

  const cards = new Map(); // key: category -> elements
  const summaryCards = new Map(); // key: category -> elements
  let activeReader = null;
  let abortController = null;
  let isStreaming = false;
  let failureCount = 0;
  let durationTimer = null;
  const startTimes = new Map();
  const endTimes = new Map();
  const categoryTotals = new Map();
  const categoryCompleted = new Map();
  const labelDefault = "Start Stream";
  const labelRunning = "Running...";
  const labelDone = "Scan Again";

  const expectedCategories = {
    snapshots: [
      { command: "tmutil listlocalsnapshots /", note: "List local APFS snapshots created by Time Machine." },
      { command: "diskutil apfs listSnapshots / 2>/dev/null | grep -i size || true", note: "Estimate snapshot sizes reported by diskutil." },
    ],
    apfs: [{ command: "diskutil apfs list", note: "APFS container and volume breakdown (overhead, purgeable, snapshots)." }],
    virtual_memory: [
      { command: "test -d /private/var/vm && du -sh /private/var/vm || echo 'No files found.'", note: "Overall size of swap files." },
      { command: "ls -lh /private/var/vm 2>/dev/null || echo 'No files found.'", note: "Individual swap files and their sizes." },
    ],
    sleep: [{ command: "ls -lh /private/var/vm/sleepimage 2>/dev/null || echo 'No files found.'", note: "Presence and size of the sleepimage file." }],
    caches: [
      { command: "test -d ~/Library/Caches && du -sh ~/Library/Caches || echo 'No files found.'", note: "User-level caches (Safari, Chrome, apps)." },
      { command: "test -d /Library/Caches && du -sh /Library/Caches || echo 'No files found.'", note: "System-level caches." },
    ],
    developer_data: [
      { command: "test -d ~/Library/Developer && du -sh ~/Library/Developer || echo 'No files found.'", note: "Aggregate size of all developer data." },
      { command: "test -d ~/Library/Developer/Xcode/DerivedData && du -sh ~/Library/Developer/Xcode/DerivedData || echo 'No files found.'", note: "Xcode build artifacts (DerivedData)." },
      { command: "test -d ~/Library/Developer/CoreSimulator && du -sh ~/Library/Developer/CoreSimulator || echo 'No files found.'", note: "Simulator device images and data." },
      { command: "test -d ~/Library/Developer/Xcode/Archives && du -sh ~/Library/Developer/Xcode/Archives || echo 'No files found.'", note: "Archived Xcode builds." },
    ],
    homebrew: [
      { command: "command -v brew >/dev/null 2>&1 && brew cleanup -n || echo 'brew not installed.'", note: "Preview of files Homebrew can delete (no changes made)." },
      { command: "du -sh /opt/homebrew/Cellar /usr/local/Cellar 2>/dev/null || echo 'No files found.'", note: "Installed formulae (Cellar) footprint." },
      { command: "test -d ~/Library/Caches/Homebrew && du -sh ~/Library/Caches/Homebrew || echo 'No files found.'", note: "Homebrew download/cache storage." },
    ],
    package_artifacts: [
      { command: "test -d ~/.npm && du -sh ~/.npm || echo 'No files found.'", note: "npm cache footprint." },
      { command: "test -d ~/.cache/pip && du -sh ~/.cache/pip || echo 'No files found.'", note: "pip cache footprint." },
      { command: "du -sh ~/miniconda* ~/anaconda* 2>/dev/null || echo 'No files found.'", note: "Conda/Anaconda installations if present." },
      { command: "find ~ -maxdepth 4 -name node_modules -type d -prune 2>/dev/null", note: "Node.js module folders (sizes computed separately if desired)." },
    ],
    docker: [
      { command: "command -v docker >/dev/null 2>&1 && docker system df || echo 'docker not installed.'", note: "Docker image/container/volume usage summary." },
      { command: "du -sh ~/Library/Containers/com.docker.docker 2>/dev/null || echo 'No files found.'", note: "Docker for Mac data directory size." },
    ],
    backups: [
      { command: "test -d ~/Library/Application\\ Support/MobileSync && du -sh ~/Library/Application\\ Support/MobileSync || echo 'No files found.'", note: "Finder/iTunes device backups." },
    ],
    photos: [
      { command: "test -d ~/Pictures/Photos\\ Library.photoslibrary && du -sh ~/Pictures/Photos\\ Library.photoslibrary || echo 'No files found.'", note: "Photos library originals and cache size." },
    ],
    media_assets: [
      { command: "test -d /Library/Application\\ Support/GarageBand && du -sh /Library/Application\\ Support/GarageBand || echo 'No files found.'", note: "GarageBand loops and sounds." },
      { command: "test -d /Library/Application\\ Support/Logic && du -sh /Library/Application\\ Support/Logic || echo 'No files found.'", note: "Logic Pro content libraries." },
      { command: "test -d ~/Movies && du -sh ~/Movies || echo 'No files found.'", note: "User movie files (including iMovie/Final Cut assets)." },
    ],
    purgeable: [{ command: "diskutil info / 2>/dev/null | grep -i Purgeable || true", note: "Purgeable storage reported by APFS." }],
    universal: [
      { command: "du -h -d 1 ~ 2>/dev/null | sort -h || echo 'No files found.'", note: "Home directory breakdown (sorted ascending)." },
      { command: "du -h -d 1 / 2>/dev/null | sort -h || echo 'No files found.'", note: "Top-level disk breakdown; may need elevated privileges for accuracy." },
      { command: "find / -xdev -type f -size +1G -print 2>/dev/null || echo 'No files found.'", note: "Files over 1GB (root filesystem, errors suppressed)." },
    ],
  };

  const categoryOrder = [
    "snapshots",
    "apfs",
    "virtual_memory",
    "sleep",
    "caches",
    "developer_data",
    "homebrew",
    "package_artifacts",
    "docker",
    "backups",
    "photos",
    "media_assets",
    "purgeable",
    "universal",
  ];

  let activeCategoryIndex = 0;

  endpointText.textContent = ENDPOINT;

  function setStatus(text, tone = "default") {
    statusText.textContent = text;
    statusText.className = tone === "error" ? "error" : "";
    if (header) {
      header.classList.remove("ok", "error");
      if (tone === "error") header.classList.add("error");
      if (tone === "success") header.classList.add("ok");
    }
  }

  function resetStream() {
    cards.clear();
    summaryCards.clear();
    streamContainer.innerHTML = '<p class="placeholder">Waiting for data...</p>';
    if (summaryContainer) {
      summaryContainer.innerHTML = '<p class="placeholder">Waiting for data...</p>';
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    activeReader = null;
    isStreaming = false;
    failureCount = 0;
    activeCategoryIndex = 0;
    startTimes.clear();
    endTimes.clear();
    stopDurationTicker();
    categoryTotals.clear();
    categoryCompleted.clear();
    toggleButtons(false, false);
    seedCards();
    updateProgress();
  }

  function ensureCard(category) {
    const key = `${category}::category-card`;
    if (cards.has(key)) return cards.get(key);

    const card = document.createElement("article");
    card.className = "card";

    const headerEl = document.createElement("div");
    headerEl.className = "card-header";
    const titleBox = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = category;
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Pending...";
    titleBox.append(title, note);

    const status = document.createElement("span");
    status.className = "status pending";
    status.textContent = "Not started";

    headerEl.append(titleBox, status);

    const progress = document.createElement("div");
    progress.className = "progress";
    const progressFill = document.createElement("div");
    progressFill.className = "progress-fill";
    progressFill.style.width = "0%";
    progress.append(progressFill);

    const meta = document.createElement("div");
    meta.className = "meta";
    const commandsCount = document.createElement("span");
    commandsCount.innerHTML = `<strong>Commands:</strong> ${expectedCategories[category]?.length || 0}`;
    const scannedCount = document.createElement("span");
    scannedCount.innerHTML = `<strong>Scanned:</strong> 0`;
    scannedCount.className = "scan-count";
    const timer = document.createElement("span");
    timer.className = "timer";
    timer.textContent = "Elapsed: 0s";
    meta.append(commandsCount, scannedCount, timer);

    const output = document.createElement("pre");
    output.className = "output";
    output.textContent = "Waiting for output...";

    card.append(headerEl, progress, meta, output);
    streamContainer.querySelector(".placeholder")?.remove();
    streamContainer.append(card);

    const entry = { card, status, progressFill, output, note, header: headerEl, category, scannedCount, timer };
    cards.set(key, entry);
    return entry;
  }

  function ensureSummary(category) {
    if (!summaryContainer) return { row: null, counts: { textContent: "" }, badge: { className: "", textContent: "" } };
    if (summaryCards.has(category)) return summaryCards.get(category);
    const row = document.createElement("div");
    row.className = "summary-item";
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = category;
    const counts = document.createElement("div");
    counts.className = "counts";
    counts.textContent = `0 / ${expectedCategories[category]?.length || 0}`;
    const timer = document.createElement("div");
    timer.className = "timer";
    timer.textContent = "Elapsed: 0s";
    left.append(name, counts, timer);

    const badge = document.createElement("span");
    badge.className = "badge pending";
    badge.textContent = "Not started";

    row.append(left, badge);
    summaryContainer.querySelector(".placeholder")?.remove();
    summaryContainer.append(row);

    const entry = { row, counts, badge, category, timer };
    summaryCards.set(category, entry);
    return entry;
  }

  function activateCategory(category) {
    if (!category || startTimes.get(category)) return;
    
    // Ensure card exists
    ensureCard(category);
    ensureSummary(category);

    startTimes.set(category, Date.now());
    
    // Update UI to running state
    const entry = cards.get(`${category}::category-card`);
    const summary = summaryCards.get(category);
    
    if (entry) {
      entry.status.classList.remove("pending", "done", "error");
      entry.status.classList.add("working");
      entry.status.textContent = "Running";
    }
    if (summary) {
      summary.badge.classList.remove("pending", "done", "error");
      summary.badge.classList.add("working");
      summary.badge.textContent = "Running";
    }
    refreshDurations();
  }

  function finishCategory(category, isError = false) {
    if (!category) return;
    if (!endTimes.has(category)) endTimes.set(category, Date.now());
    
    const entry = cards.get(`${category}::category-card`);
    const summary = summaryCards.get(category);

    if (entry) {
        entry.status.classList.remove("pending", "working");
        entry.status.classList.add(isError ? "error" : "done");
        entry.status.textContent = isError ? "Error" : "Done";
    }
    if (summary) {
        summary.badge.classList.remove("pending", "working");
        summary.badge.classList.add(isError ? "error" : "done");
        summary.badge.textContent = isError ? "Error" : "Done";
    }
    refreshDurations();
  }

  function updateCard(result) {
    const category = result.category || "generic";
    if (!categoryTotals.has(category)) {
      categoryTotals.set(category, 1);
      categoryCompleted.set(category, 0);
    }

    // Check for category transition (if we received a result for a later category)
    const resultIndex = categoryOrder.indexOf(category);
    if (resultIndex > -1 && resultIndex > activeCategoryIndex) {
        // Fast-forward: finish any pending categories between active and this one
        for (let i = activeCategoryIndex; i < resultIndex; i++) {
            finishCategory(categoryOrder[i], false); 
        }
        activeCategoryIndex = resultIndex;
        activateCategory(category);
    } else if (resultIndex === -1 && !startTimes.get(category)) {
        // Fallback for unknown categories
        activateCategory(category);
    }

    const entry = ensureCard(category);
    const summary = ensureSummary(category);

    entry.note.textContent = result.note || entry.note.textContent;

    const combined = [result.command, result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const existing = entry.output.textContent.replace("Waiting for output...", "").trim();
    entry.output.textContent = `${existing ? existing + "\n\n" : ""}${combined || "(no output)"}`;
    entry.progressFill.classList.remove("indeterminate");

    const total = categoryTotals.get(category) || 1;
    const donePrev = categoryCompleted.get(category) || 0;
    const doneNext = donePrev + 1;
    entry.progressFill.style.width = `${Math.min(100, (doneNext / total) * 100)}%`;

    const isError = !(result.status === "ok" || result.returncode === 0);
    if (isError) failureCount += 1;

    categoryCompleted.set(category, doneNext);
    summary.counts.textContent = `${doneNext} / ${total}`;
    entry.scannedCount.innerHTML = `<strong>Scanned:</strong> ${doneNext}`;

    // Completion check
    if (doneNext >= total) {
        finishCategory(category, isError);
        // Automatically start the next one
        const nextIndex = categoryOrder.indexOf(category) + 1;
        if (nextIndex < categoryOrder.length) {
            activeCategoryIndex = nextIndex;
            activateCategory(categoryOrder[nextIndex]);
        }
    } else if (isError) {
        entry.status.classList.add("error");
        entry.status.textContent = "Error";
        summary.badge.classList.add("error");
    } else {
        // Still running
        entry.status.classList.add("working");
        entry.status.textContent = "Running";
    }
    
    updateProgress();
  }

  async function handleStream(stream) {
    const decoder = new TextDecoder();
    activeReader = stream.getReader();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await activeReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const payload = JSON.parse(trimmed);
            try {
              updateCard(payload);
            } catch (err) {
              console.error("Update error for payload", payload, err);
            }
          } catch (err) {
            console.warn("Could not parse line", trimmed, err);
          }
        }
      }
      if (buffer.trim()) {
        try {
          const payload = JSON.parse(buffer);
          try {
            updateCard(payload);
          } catch (err) {
            console.error("Update error for payload", payload, err);
          }
        } catch {
          console.warn("Trailing data could not be parsed:", buffer);
        }
      }
        finalizeStatus();
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error("Stream error (continuing)", err);
    } finally {
      finalizeStatus();
    }
  }

  async function startStreaming() {
    if (isStreaming) return;
    resetStream();
    startDurationTicker();
    // Activate the first category immediately
    if (categoryOrder.length > 0) {
        activeCategoryIndex = 0;
        activateCategory(categoryOrder[0]);
    }

    setStatus("Connecting...");
    abortController = new AbortController();
    isStreaming = true;
    toggleButtons(true, false);

    try {
      const response = await fetch(ENDPOINT, { signal: abortController.signal });
      if (!response || !response.body) throw new Error("No response body to stream.");
      setStatus("Streaming data...");
      await handleStream(response.body);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      setStatus("Failed to connect", "error");
    } finally {
      isStreaming = false;
      stopDurationTicker();
      toggleButtons(false, true);
    }
  }

  startBtn?.addEventListener("click", () => startStreaming());

  function toggleButtons(disabled, done) {
    if (startBtn) {
      startBtn.disabled = disabled;
      startBtn.textContent = disabled ? labelRunning : done ? labelDone : labelDefault;
    }
  }

  function seedCards() {
    streamContainer.innerHTML = "";
    if (summaryContainer) summaryContainer.innerHTML = "";
    Object.keys(expectedCategories).forEach((cat) => {
      categoryTotals.set(cat, expectedCategories[cat].length);
      categoryCompleted.set(cat, 0);
      ensureCard(cat);
      ensureSummary(cat);
    });
    startTimes.clear();
    endTimes.clear();
  }

  function startDurationTicker() {
    if (durationTimer) return;
    durationTimer = setInterval(refreshDurations, 500);
  }

  function stopDurationTicker() {
    if (durationTimer) {
      clearInterval(durationTimer);
      durationTimer = null;
    }
  }

  function refreshDurations() {
    const now = Date.now();
    cards.forEach((entry, catKey) => {
      const cat = entry.category;
      const start = startTimes.get(cat);
      if (!start) return;
      const end = endTimes.get(cat);
      const ms = (end || now) - start;
      const text = end ? `Finished in ${formatDuration(ms)}` : `Running: ${formatDuration(ms)}`;
      entry.timer.textContent = text;
      const summary = summaryCards.get(cat);
      if (summary && summary.timer) summary.timer.textContent = text;
    });
  }

  function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const mins = Math.floor(seconds / 60);
    const rem = (seconds % 60).toFixed(0);
    return `${mins}m ${rem}s`;
  }

  function finalizeStatus() {
    const hasFailures = failureCount > 0;
    if (hasFailures) setStatus(`Completed with ${failureCount} error(s)`, "error");
    else setStatus("All categories finished", "success");
    
    // Ensure the last active category is marked finished if stream ended
    const currentCat = categoryOrder[activeCategoryIndex];
    if (currentCat && !endTimes.has(currentCat)) {
        finishCategory(currentCat, false);
    }
  }

  function updateProgress() {}

  // Seed cards initially
  seedCards();
  updateProgress();
})(); 
