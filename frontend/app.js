(() => {
  const ENDPOINT = "/api/scan/stream";
  const startBtn = document.getElementById("start-btn");
  const statusText = document.getElementById("status-text");
  const endpointText = document.getElementById("endpoint-text");
  const streamContainer = document.getElementById("stream-container");

  const cards = new Map(); // key: unique id -> elements
  let activeReader = null;
  let abortController = null;
  let isStreaming = false;
  const labelDefault = "Start Stream";
  const labelRunning = "Running...";
  const labelDone = "Scan Again";

  endpointText.textContent = ENDPOINT;

  function setStatus(text, tone = "default") {
    statusText.textContent = text;
    statusText.className = tone === "error" ? "error" : "";
  }

  function resetStream() {
    cards.clear();
    streamContainer.innerHTML = '<p class="placeholder">Waiting for data...</p>';
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    activeReader = null;
    isStreaming = false;
    toggleButtons(false, false);
  }

  function ensureCard(key, result) {
    if (cards.has(key)) {
      return cards.get(key);
    }
    const card = document.createElement("article");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "card-header";
    const titleBox = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = result.category || "Command";
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = result.note || "Running...";
    titleBox.append(title, note);

    const status = document.createElement("span");
    status.className = "status";
    status.textContent = "Running";

    header.append(titleBox, status);

    const progress = document.createElement("div");
    progress.className = "progress";
    const progressFill = document.createElement("div");
    progressFill.className = "progress-fill indeterminate";
    progress.append(progressFill);

    const meta = document.createElement("div");
    meta.className = "meta";
    const cmd = document.createElement("span");
    cmd.innerHTML = `<strong>Command:</strong> <code>${result.command || "..."}</code>`;
    const path = document.createElement("span");
    path.innerHTML = `<strong>Path:</strong> <code>${result.path || "n/a"}</code>`;
    meta.append(cmd, path);

    const output = document.createElement("pre");
    output.className = "output";
    output.textContent = "Waiting for output...";

    card.append(header, progress, meta, output);
    streamContainer.querySelector(".placeholder")?.remove();
    streamContainer.append(card);

    const entry = { card, status, progressFill, output, note };
    cards.set(key, entry);
    return entry;
  }

  function updateCard(result) {
    const key = `${result.category || "generic"}::${result.command || Math.random()}`;
    const entry = ensureCard(key, result);

    entry.note.textContent = result.note || entry.note.textContent;
    entry.output.textContent = result.stdout || result.stderr || "(no output)";
    entry.progressFill.classList.remove("indeterminate");
    entry.progressFill.style.width = "100%";

    if (result.returncode === 0) {
      entry.status.textContent = "Done";
      entry.status.classList.add("done");
    } else {
      entry.status.textContent = "Error";
      entry.status.classList.add("error");
      if (result.stderr) {
        entry.output.textContent = `${result.stdout || ""}\n${result.stderr}`.trim();
      }
    }
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
            updateCard(payload);
          } catch (err) {
            console.warn("Could not parse line", trimmed, err);
          }
        }
      }
      if (buffer.trim()) {
        try {
          updateCard(JSON.parse(buffer));
        } catch {
          console.warn("Trailing data could not be parsed:", buffer);
        }
      }
      setStatus("Stream ended");
      isStreaming = false;
      toggleButtons(false, true);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      setStatus("Stream error", "error");
      isStreaming = false;
      toggleButtons(false, false);
    }
  }

  async function startStreaming() {
    if (isStreaming) return;
    resetStream();
    setStatus("Connecting...");
    abortController = new AbortController();
    isStreaming = true;
    toggleButtons(true, false);

    try {
      const response = await fetch(ENDPOINT, { signal: abortController.signal });

      if (!response || !response.body) {
        throw new Error("No response body to stream.");
      }
      setStatus("Streaming data...");
      handleStream(response.body);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      setStatus("Failed to connect", "error");
      isStreaming = false;
      toggleButtons(false, false);
    }
  }

  startBtn?.addEventListener("click", () => startStreaming());

  function toggleButtons(disabled, done) {
    if (startBtn) {
      startBtn.disabled = disabled;
      if (disabled) {
        startBtn.textContent = labelRunning;
      } else {
        startBtn.textContent = done ? labelDone : labelDefault;
      }
    }
  }
})(); 
