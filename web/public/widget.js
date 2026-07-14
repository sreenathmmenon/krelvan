/*
 * Krelvan embeddable chat widget — dependency-free, runs on other people's sites.
 *
 *   <script src="https://your-host/widget.js" data-agent="support-bot" data-key="pk_…"></script>
 *
 * It renders a launcher bubble that opens a chat panel talking ONLY to the host's public
 * /api/public/* endpoints, authenticated by the site key. Styles are isolated in a shadow
 * root so they never touch (or get touched by) the host page. If the agent is disabled the
 * widget quietly does not appear.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var slug = script.getAttribute("data-agent");
  var key = script.getAttribute("data-key");
  if (!slug || !key) return;
  // The Krelvan host = the origin the script was served from. Public routes are reached through
  // the host's same-origin proxy (which CORS-allows `*` for /api/public/*), so the widget works
  // cross-origin from any embedding site. An explicit data-api overrides the base if needed.
  var host = script.getAttribute("data-api") || new URL(script.src, location.href).origin;
  var thread; // in-memory only

  function api2(path) { return host + "/proxy/api/public/agents/" + encodeURIComponent(slug) + path; }

  // Only mount once the agent confirms it's public + chat-enabled (graceful failure otherwise).
  fetch(api2(""), { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw 0;
    return r.json();
  }).then(function (profile) {
    if (!profile || profile.chatEnabled !== true) return; // agent private / chat off → no widget
    mount(profile.name || "Assistant");
  }).catch(function () { /* unreachable / disabled — render nothing */ });

  function mount(name) {
    var host = document.createElement("div");
    host.setAttribute("data-krelvan-widget", "");
    document.body.appendChild(host);
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

    var style = document.createElement("style");
    style.textContent = [
      ":host{all:initial}",
      "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
      ".bubble{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;background:#0C726B;color:#fff;border:0;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2);font-size:24px;z-index:2147483000}",
      ".panel{position:fixed;right:20px;bottom:88px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;border:1px solid #E7E3DC;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;z-index:2147483000}",
      ".panel.open{display:flex}",
      ".hd{background:#0C726B;color:#fff;padding:14px 16px;font-weight:600;font-size:15px;display:flex;justify-content:space-between;align-items:center}",
      ".hd button{background:0;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1}",
      ".log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}",
      ".msg{max-width:82%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}",
      ".you{align-self:flex-end;background:#0C726B;color:#fff}",
      ".bot{align-self:flex-start;background:#E6F4F2;color:#11201F}",
      ".sys{align-self:center;color:#5E6A66;font-style:italic;font-size:13px}",
      ".ft{display:flex;gap:8px;padding:12px;border-top:1px solid #E7E3DC}",
      ".ft input{flex:1;padding:8px 10px;border:1px solid #D6D0C6;border-radius:8px;font-size:14px;outline:none}",
      ".ft input:focus{border-color:#0C726B}",
      ".ft button{background:#0C726B;color:#fff;border:0;border-radius:8px;padding:0 14px;font-size:14px;cursor:pointer}",
      ".ft button:disabled{opacity:.5;cursor:default}"
    ].join("");
    root.appendChild(style);

    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<button class="bubble" aria-label="Chat">✦</button>' +
      '<div class="panel" role="dialog" aria-label="Chat with ' + esc(name) + '">' +
        '<div class="hd"><span>' + esc(name) + '</span><button class="x" aria-label="Close">×</button></div>' +
        '<div class="log"></div>' +
        '<form class="ft"><input type="text" placeholder="Type a message…" aria-label="Message"/><button type="submit">Send</button></form>' +
      '</div>';
    root.appendChild(wrap);

    var bubble = root.querySelector(".bubble");
    var panel = root.querySelector(".panel");
    var log = root.querySelector(".log");
    var form = root.querySelector(".ft");
    var input = form.querySelector("input");
    var sendBtn = form.querySelector("button");

    bubble.addEventListener("click", function () { panel.classList.toggle("open"); if (panel.classList.contains("open")) input.focus(); });
    root.querySelector(".x").addEventListener("click", function () { panel.classList.remove("open"); });

    function add(cls, text) {
      var d = document.createElement("div");
      d.className = "msg " + cls;
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }

    function ask(message) {
      return fetch(api2("/ask"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: message, siteKey: key, thread: thread })
      }).then(function (r) { return r.json().then(function (b) { return { s: r.status, b: b }; }); });
    }
    function poll(t) {
      return fetch(api2("/ask/" + encodeURIComponent(t)), { cache: "no-store" })
        .then(function (r) { return r.json().then(function (b) { return { s: r.status, b: b }; }); });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = input.value.trim();
      if (!msg) return;
      input.value = ""; add("you", msg);
      sendBtn.disabled = true;
      ask(msg).then(function (r) {
        if (r.s === 200) { thread = r.b.thread || thread; add("bot", r.b.reply || ""); }
        else if (r.s === 202 && r.b.status === "awaiting-approval") { add("sys", "This needs a person to approve before it can reply."); }
        else if (r.s === 202) { thread = r.b.thread || thread; pollLoop(thread, 0); return; }
        else if (r.s === 429) { add("sys", "You're sending messages too fast — please slow down."); }
        else if (r.s === 403) { add("sys", "This site isn't allowed to use this agent."); }
        else { add("sys", "Sorry — couldn't reach the agent."); }
      }).catch(function () { add("sys", "Sorry — couldn't reach the agent."); })
        .then(function () { sendBtn.disabled = false; });
    });

    function pollLoop(t, n) {
      if (n > 40) { add("sys", "Still working — try again in a moment."); sendBtn.disabled = false; return; }
      setTimeout(function () {
        poll(t).then(function (r) {
          if (r.s === 200) { add("bot", r.b.reply || ""); sendBtn.disabled = false; }
          else if (r.s === 202 && r.b.status === "awaiting-approval") { add("sys", "This needs a person to approve before it can reply."); sendBtn.disabled = false; }
          else if (r.s === 202) { pollLoop(t, n + 1); }
          else { add("sys", "Sorry — something went wrong."); sendBtn.disabled = false; }
        }).catch(function () { add("sys", "Sorry — something went wrong."); sendBtn.disabled = false; });
      }, 1500);
    }
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
})();
