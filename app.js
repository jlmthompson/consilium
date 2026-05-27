// Computational Genomics Virtual Lab — main application logic.
// Plain ES2017+; no build step. Talks directly to the Anthropic API from
// the browser using the dangerous-direct-browser-access header. See README.

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 1500;

async function callAgent(agent, messages) {
  if (!state.apiKey) {
    throw new Error("No API key set. Enter your Anthropic API key in the header.");
  }
  if (!state.model) {
    throw new Error("No model ID set.");
  }
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": state.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: state.model,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(agent),
      messages,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error?.message || JSON.stringify(j);
    } catch (_) {
      detail = await res.text();
    }
    throw new Error(`Anthropic API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const block = (data.content || []).find((c) => c.type === "text");
  return block ? block.text : "";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  apiKey: sessionStorage.getItem("vlab.apiKey") || "",
  model: sessionStorage.getItem("vlab.model") || "claude-sonnet-4-6",
  agents: structuredClone(DEFAULT_AGENTS),
  meetings: [],        // completed meetings (chronological)
  viewMeetingId: null, // id of meeting currently shown in the transcript panel
  running: false,
  nextMeetingId: 1,
};

// ---------------------------------------------------------------------------
// Meeting prompts
// ---------------------------------------------------------------------------

function piOpeningPrompt(agenda, context) {
  const ctx = context ? `\n\nAdditional context from the human researcher:\n${context}` : "";
  return (
    `You are running a Virtual Lab team meeting.\n\n` +
    `Meeting agenda:\n${agenda}${ctx}\n\n` +
    `Begin the meeting by:\n` +
    `1. Briefly framing the agenda in your own words.\n` +
    `2. Posing 2-3 specific guiding questions for the team to address this round.\n` +
    `Keep your opening to 200-300 words.`
  );
}

function specialistPrompt(round, total, agentTitle) {
  return (
    `Round ${round} of ${total}. It is your turn to respond as the ${agentTitle}.\n\n` +
    `Address the PI's guiding questions from the perspective of your expertise. Be specific and concrete — avoid vague generalities. If your input depends on the other specialist's view, state that explicitly so the team can resolve it.\n\n` +
    `If a focused PubMed search would meaningfully inform your response, include a request on its own line in this exact JSON format:\n` +
    `{"tool": "pubmed_search", "query": "your search terms", "max_results": 5}\n\n` +
    `Keep your response to 300-400 words.`
  );
}

function criticPrompt(round, total) {
  return (
    `Round ${round} of ${total}. You are the Scientific Critic reviewing the specialist responses from this round.\n\n` +
    `Provide a rigorous critique. For each specialist:\n` +
    `- Identify the strongest point they made.\n` +
    `- Identify the weakest or most unsupported claim.\n` +
    `- Ask one specific follow-up question they must answer in the next round.\n\n` +
    `Do not simply validate. Push for precision, feasibility, and evidence. Keep your critique to 300-400 words.`
  );
}

function piSynthesisPrompt(round, total) {
  return (
    `Round ${round} of ${total} has concluded. Synthesise what was discussed.\n\n` +
    `In 200-300 words:\n` +
    `1. Identify the key points of agreement and disagreement.\n` +
    `2. Note what has been resolved and what remains open.\n` +
    `3. Pose 2 specific follow-up questions for the next round.`
  );
}

function piFinalPrompt(total) {
  return (
    `The meeting has concluded after ${total} round${total === 1 ? "" : "s"}. Produce a final meeting summary in this exact structure:\n\n` +
    `## Meeting Summary\n` +
    `**Agenda**: [restate]\n` +
    `**Key conclusions**: [3-5 bullet points]\n` +
    `**Unresolved questions**: [any remaining open issues]\n` +
    `**Recommended next steps**: [concrete, specific actions with suggested owners]\n` +
    `**Suggested agenda for next meeting**: [one sentence]`
  );
}

function individualOpeningPrompt(agentTitle, agenda, context) {
  const ctx = context ? `\n\nAdditional context from the human researcher:\n${context}` : "";
  return (
    `You are working through the following agenda alone as the ${agentTitle}.\n\n` +
    `Agenda:\n${agenda}${ctx}\n\n` +
    `Provide a thorough, specific response in 400-600 words. If a focused PubMed search would meaningfully inform your work, include a request on its own line:\n` +
    `{"tool": "pubmed_search", "query": "your search terms", "max_results": 5}\n\n` +
    `If you produce code, use fenced code blocks with the language tag (\`\`\`python or \`\`\`r).`
  );
}

function individualCriticPrompt(agentTitle) {
  return (
    `You are the Scientific Critic reviewing the work produced above by the ${agentTitle}.\n\n` +
    `In 200-300 words:\n` +
    `- Identify the strongest contribution.\n` +
    `- Identify the weakest or least supported claim.\n` +
    `- Suggest two specific improvements the agent should make.`
  );
}

// ---------------------------------------------------------------------------
// PubMed tool detection
// ---------------------------------------------------------------------------

function detectPubMedRequest(text) {
  // Match a JSON object that contains "tool":"pubmed_search". Allow whitespace.
  // Use a forgiving regex then JSON.parse for validation.
  const candidates = text.match(/\{[\s\S]*?"tool"\s*:\s*"pubmed_search"[\s\S]*?\}/g);
  if (!candidates) return null;
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && obj.tool === "pubmed_search" && typeof obj.query === "string" && obj.query.trim()) {
        return {
          query: obj.query.trim(),
          max_results: Number(obj.max_results) || 5,
          raw: c,
        };
      }
    } catch (_) {
      // try next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Meeting runner
// ---------------------------------------------------------------------------

function newMeeting({ type, agenda, context, rounds, individualAgentId, criticReview, carryForward }) {
  return {
    id: state.nextMeetingId++,
    type,                  // "team" | "individual"
    agenda,
    context,
    rounds,
    individualAgentId,     // for individual meetings
    criticReview,          // for individual meetings
    carryForward,          // optional summary text from prior meeting
    agentsSnapshot: structuredClone(state.agents),
    conversation: [],      // messages array passed to Anthropic API
    transcript: [],        // [{ agentId, agent, content, isTool? }]
    summary: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
}

async function runMeeting(meeting) {
  state.running = true;
  state.meetings.push(meeting);
  state.viewMeetingId = meeting.id;
  setRunControlsDisabled(true);
  setStatus("running", `Starting meeting #${meeting.id}…`);
  renderTranscript(meeting);
  renderMeetingChain();
  try {
    if (meeting.type === "team") {
      await runTeamMeeting(meeting);
    } else {
      await runIndividualMeeting(meeting);
    }
    meeting.completedAt = new Date().toISOString();
    setStatus("done", `Meeting #${meeting.id} complete.`);
  } catch (err) {
    meeting.error = err.message;
    console.error(err);
    setStatus("error", `Error: ${err.message}`);
  } finally {
    state.running = false;
    setRunControlsDisabled(false);
    renderTranscript(meeting);
    renderMeetingChain();
  }
}

async function runTeamMeeting(meeting) {
  const total = meeting.rounds;

  // Optional carry-forward from a prior meeting.
  let preamble = "";
  if (meeting.carryForward) {
    preamble = `Summary of the prior meeting:\n${meeting.carryForward}\n\n`;
  }

  pushUserTurn(meeting, preamble + piOpeningPrompt(meeting.agenda, meeting.context));
  await runAgentTurn(meeting, "pi");

  for (let r = 1; r <= total; r++) {
    pushUserTurn(meeting, specialistPrompt(r, total, state.agents.specialist1.title));
    await runAgentTurn(meeting, "specialist1");

    pushUserTurn(meeting, specialistPrompt(r, total, state.agents.specialist2.title));
    await runAgentTurn(meeting, "specialist2");

    pushUserTurn(meeting, criticPrompt(r, total));
    await runAgentTurn(meeting, "critic");

    if (r < total) {
      pushUserTurn(meeting, piSynthesisPrompt(r, total));
      await runAgentTurn(meeting, "pi");
    }
  }

  pushUserTurn(meeting, piFinalPrompt(total));
  await runAgentTurn(meeting, "pi");
  meeting.summary = lastTranscriptText(meeting);
}

async function runIndividualMeeting(meeting) {
  const agentId = meeting.individualAgentId;
  const agent = state.agents[agentId];
  let preamble = "";
  if (meeting.carryForward) {
    preamble = `Summary of the prior meeting:\n${meeting.carryForward}\n\n`;
  }
  pushUserTurn(meeting, preamble + individualOpeningPrompt(agent.title, meeting.agenda, meeting.context));
  await runAgentTurn(meeting, agentId);

  if (meeting.criticReview && agentId !== "critic") {
    pushUserTurn(meeting, individualCriticPrompt(agent.title));
    await runAgentTurn(meeting, "critic");
  }

  meeting.summary = lastTranscriptText(meeting);
}

function pushUserTurn(meeting, content) {
  meeting.conversation.push({ role: "user", content });
}

async function runAgentTurn(meeting, agentId) {
  const agent = state.agents[agentId];
  setStatus("running", `${agent.title} is thinking…`);
  let text = await callAgent(agent, meeting.conversation);
  meeting.conversation.push({ role: "assistant", content: `[${agent.title}]\n${text}` });
  meeting.transcript.push({ agentId, agent: { ...agent }, content: text });
  renderTranscript(meeting);

  // Tool handling: at most one PubMed search per turn to prevent loops.
  const toolReq = detectPubMedRequest(text);
  if (toolReq) {
    setStatus("running", `Running PubMed search: "${toolReq.query}"…`);
    let toolText;
    try {
      const result = await pubmedSearch(toolReq.query, toolReq.max_results);
      toolText = result.formatted;
    } catch (e) {
      toolText = `PubMed search for "${toolReq.query}" failed: ${e.message}`;
    }
    meeting.transcript.push({
      agentId: "tool",
      agent: { title: "PubMed", color: "tool" },
      content: toolText,
      isTool: true,
      query: toolReq.query,
    });
    meeting.conversation.push({
      role: "user",
      content: `[Tool result]\n${toolText}\n\nIncorporate any relevant findings into your response. Continue your turn within the original word limit.`,
    });
    renderTranscript(meeting);

    setStatus("running", `${agent.title} is reviewing search results…`);
    text = await callAgent(agent, meeting.conversation);
    meeting.conversation.push({ role: "assistant", content: `[${agent.title}]\n${text}` });
    meeting.transcript.push({ agentId, agent: { ...agent }, content: text });
    renderTranscript(meeting);
  }
}

function lastTranscriptText(meeting) {
  for (let i = meeting.transcript.length - 1; i >= 0; i--) {
    if (!meeting.transcript[i].isTool) return meeting.transcript[i].content;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let codeBlockCounter = 0;

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderContentToHtml(content) {
  // Split on fenced code blocks. Capturing groups → odd/even indices.
  const parts = content.split(/```([\w-]*)\n([\s\S]*?)```/g);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      const text = parts[i];
      if (text) html += `<div class="text-block">${escapeHtml(text)}</div>`;
    } else if (i % 3 === 1) {
      const lang = parts[i] || "code";
      const code = parts[i + 1] || "";
      const id = `code-${++codeBlockCounter}`;
      html +=
        `<div class="code-block">` +
        `<div class="code-header">` +
        `<span class="code-lang">${escapeHtml(lang)}</span>` +
        `<button class="copy-btn" data-code-id="${id}">Copy</button>` +
        `</div>` +
        `<pre><code id="${id}">${escapeHtml(code)}</code></pre>` +
        `</div>`;
    }
    // i % 3 === 2 handled by the preceding branch
  }
  return html;
}

function renderTranscript(meeting) {
  const el = document.getElementById("transcript");
  const titleEl = document.getElementById("transcript-title");
  document.getElementById("export-btn").disabled = !meeting || meeting.transcript.length === 0;

  if (!meeting) {
    el.innerHTML = `<div class="empty-state">Run a meeting to see the transcript here.</div>`;
    titleEl.textContent = "Transcript";
    return;
  }

  titleEl.textContent = `Meeting #${meeting.id} — ${meeting.type === "team" ? "Team" : "Individual"}`;

  const turns = meeting.transcript;
  if (turns.length === 0) {
    el.innerHTML = `<div class="empty-state">Waiting for the first turn…</div>`;
    return;
  }

  // Was the user already scrolled to (near) the bottom? Preserve auto-scroll.
  const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;

  el.innerHTML = turns
    .map((turn) => {
      if (turn.isTool) {
        return (
          `<div class="turn-card tool">` +
          `<div class="turn-header"><span class="turn-agent">PubMed search</span>` +
          `<span class="turn-meta">${escapeHtml(turn.query || "")}</span></div>` +
          `<details class="tool-collapsible" open><summary>Results</summary>` +
          `<div class="tool-results">${escapeHtml(turn.content)}</div>` +
          `</details></div>`
        );
      }
      return (
        `<div class="turn-card ${turn.agent.color}">` +
        `<div class="turn-header"><span class="turn-agent">${escapeHtml(turn.agent.title)}</span></div>` +
        `<div class="turn-body">${renderContentToHtml(turn.content)}</div>` +
        `</div>`
      );
    })
    .join("");

  if (wasNearBottom) el.scrollTop = el.scrollHeight;
}

function renderMeetingChain() {
  const pillsEl = document.getElementById("chain-pills");
  const newBtn = document.getElementById("new-meeting-btn");
  if (state.meetings.length === 0) {
    pillsEl.innerHTML = `<span class="chain-empty">No prior meetings yet.</span>`;
    newBtn.disabled = true;
    return;
  }
  pillsEl.innerHTML = state.meetings
    .map((m) => {
      const active = m.id === state.viewMeetingId ? "active" : "";
      const label = m.type === "team" ? "Team" : "Individual";
      return `<button class="chain-pill ${active}" data-meeting-id="${m.id}" title="View meeting #${m.id}">Meeting ${m.id} (${label})</button>`;
    })
    .join("");
  const lastDone = [...state.meetings].reverse().find((m) => m.summary);
  newBtn.disabled = !lastDone;
}

function renderAgentEditor() {
  const wrap = document.getElementById("agent-editor-content");
  const order = ["pi", "critic", "specialist1", "specialist2"];
  wrap.innerHTML = order
    .map((id) => {
      const a = state.agents[id];
      return (
        `<div class="agent-editor-card" data-agent-id="${id}">` +
        `<h3><span class="agent-color-dot" style="background: var(--${a.color});"></span>${escapeHtml(a.title)}</h3>` +
        `<label>Title</label><input type="text" data-field="title" value="${escapeHtml(a.title)}" />` +
        `<label>Expertise</label><textarea data-field="expertise" rows="3">${escapeHtml(a.expertise)}</textarea>` +
        `<label>Goal</label><textarea data-field="goal" rows="3">${escapeHtml(a.goal)}</textarea>` +
        `<label>Role</label><textarea data-field="role" rows="3">${escapeHtml(a.role)}</textarea>` +
        `</div>`
      );
    })
    .join("");

  // Sync the individual-agent dropdown labels to current titles.
  const sel = document.getElementById("individual-agent");
  for (const opt of sel.options) {
    if (state.agents[opt.value]) {
      opt.textContent = state.agents[opt.value].title;
    }
  }
}

function setStatus(kind, text) {
  const el = document.getElementById("status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

function setRunControlsDisabled(disabled) {
  document.getElementById("run-btn").disabled = disabled;
  document.getElementById("new-meeting-btn").disabled = disabled || !lastMeetingWithSummary();
}

function lastMeetingWithSummary() {
  for (let i = state.meetings.length - 1; i >= 0; i--) {
    if (state.meetings[i].summary) return state.meetings[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

function exportMeetingMarkdown(meeting) {
  const lines = [];
  lines.push(`# Virtual Lab Meeting #${meeting.id}`);
  lines.push("");
  lines.push(`- Type: ${meeting.type}`);
  if (meeting.type === "team") lines.push(`- Rounds: ${meeting.rounds}`);
  if (meeting.type === "individual") {
    const a = meeting.agentsSnapshot[meeting.individualAgentId];
    lines.push(`- Agent: ${a?.title || meeting.individualAgentId}`);
    if (meeting.criticReview) lines.push(`- Critic review: yes`);
  }
  lines.push(`- Started: ${meeting.startedAt}`);
  if (meeting.completedAt) lines.push(`- Completed: ${meeting.completedAt}`);
  lines.push(`- Model: ${state.model}`);
  lines.push("");
  lines.push(`## Agenda`);
  lines.push("");
  lines.push(meeting.agenda);
  lines.push("");
  if (meeting.context) {
    lines.push(`## Context`);
    lines.push("");
    lines.push(meeting.context);
    lines.push("");
  }
  if (meeting.carryForward) {
    lines.push(`## Carried-forward summary`);
    lines.push("");
    lines.push(meeting.carryForward);
    lines.push("");
  }
  lines.push(`---`);
  lines.push("");
  for (const turn of meeting.transcript) {
    if (turn.isTool) {
      lines.push(`### PubMed search`);
      lines.push("");
      lines.push("```");
      lines.push(turn.content);
      lines.push("```");
      lines.push("");
    } else {
      lines.push(`### ${turn.agent.title}`);
      lines.push("");
      lines.push(turn.content);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  // Hydrate header inputs.
  const modelInput = document.getElementById("model-input");
  const apiInput = document.getElementById("apikey-input");
  modelInput.value = state.model;
  apiInput.value = state.apiKey;

  modelInput.addEventListener("input", (e) => {
    state.model = e.target.value.trim();
    sessionStorage.setItem("vlab.model", state.model);
  });
  apiInput.addEventListener("input", (e) => {
    state.apiKey = e.target.value.trim();
    sessionStorage.setItem("vlab.apiKey", state.apiKey);
  });

  // Meeting type toggle.
  for (const radio of document.querySelectorAll('input[name="meeting-type"]')) {
    radio.addEventListener("change", updateMeetingTypeVisibility);
  }
  updateMeetingTypeVisibility();

  // Run button.
  document.getElementById("run-btn").addEventListener("click", onRunClick);

  // Export button.
  document.getElementById("export-btn").addEventListener("click", () => {
    const m = currentViewMeeting();
    if (!m) return;
    downloadText(`virtual-lab-meeting-${m.id}.md`, exportMeetingMarkdown(m));
  });

  // Reset agents.
  document.getElementById("reset-agents-btn").addEventListener("click", () => {
    if (state.running) return;
    state.agents = structuredClone(DEFAULT_AGENTS);
    renderAgentEditor();
  });

  // Agent editor live updates.
  document.getElementById("agent-editor-content").addEventListener("input", (e) => {
    const card = e.target.closest("[data-agent-id]");
    const field = e.target.dataset.field;
    if (!card || !field) return;
    const id = card.dataset.agentId;
    state.agents[id][field] = e.target.value;
    if (field === "title") {
      // Re-sync individual agent dropdown.
      const sel = document.getElementById("individual-agent");
      const opt = [...sel.options].find((o) => o.value === id);
      if (opt) opt.textContent = e.target.value;
    }
  });

  // Code copy buttons (delegated).
  document.getElementById("transcript").addEventListener("click", (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const codeId = btn.dataset.codeId;
    const codeEl = document.getElementById(codeId);
    if (!codeEl) return;
    navigator.clipboard.writeText(codeEl.textContent).then(() => {
      btn.classList.add("copied");
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.textContent = old;
      }, 1200);
    });
  });

  // Meeting chain pills.
  document.getElementById("chain-pills").addEventListener("click", (e) => {
    const pill = e.target.closest(".chain-pill");
    if (!pill) return;
    const id = Number(pill.dataset.meetingId);
    const m = state.meetings.find((x) => x.id === id);
    if (!m) return;
    state.viewMeetingId = m.id;
    renderTranscript(m);
    renderMeetingChain();
  });

  // New meeting (carry forward summary).
  document.getElementById("new-meeting-btn").addEventListener("click", () => {
    const prev = lastMeetingWithSummary();
    if (!prev) return;
    document.getElementById("context-input").value =
      (document.getElementById("context-input").value
        ? document.getElementById("context-input").value + "\n\n"
        : "") +
      `Carried forward from Meeting #${prev.id}:\n${prev.summary}`;
    document.getElementById("agenda-input").value = "";
    document.getElementById("agenda-input").focus();
  });

  renderAgentEditor();
  renderMeetingChain();
  setStatus("idle", "Idle");
}

function updateMeetingTypeVisibility() {
  const type = document.querySelector('input[name="meeting-type"]:checked').value;
  for (const el of document.querySelectorAll(".team-only")) {
    el.hidden = type !== "team";
  }
  for (const el of document.querySelectorAll(".individual-only")) {
    el.hidden = type !== "individual";
  }
}

function currentViewMeeting() {
  if (state.viewMeetingId == null) return null;
  return state.meetings.find((m) => m.id === state.viewMeetingId) || null;
}

function onRunClick() {
  if (state.running) return;
  const type = document.querySelector('input[name="meeting-type"]:checked').value;
  const agenda = document.getElementById("agenda-input").value.trim();
  const context = document.getElementById("context-input").value.trim();
  const rounds = Math.max(1, Math.min(5, Number(document.getElementById("rounds-input").value) || 3));
  const individualAgentId = document.getElementById("individual-agent").value;
  const criticReview = document.getElementById("critic-review").checked;

  if (!state.apiKey) {
    setStatus("error", "Enter your Anthropic API key in the header.");
    return;
  }
  if (!state.model) {
    setStatus("error", "Enter a model ID in the header.");
    return;
  }
  if (!agenda) {
    setStatus("error", "Enter an agenda.");
    return;
  }

  // carryForward is left null here; the New Meeting button injects the
  // prior summary directly into the context field, so the user can edit it.
  const meeting = newMeeting({
    type,
    agenda,
    context,
    rounds,
    individualAgentId,
    criticReview,
    carryForward: null,
  });

  // Render an empty transcript immediately so the user gets feedback.
  state.viewMeetingId = meeting.id;
  renderTranscript(meeting);
  renderMeetingChain();
  runMeeting(meeting);
}

document.addEventListener("DOMContentLoaded", init);
