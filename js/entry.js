// Failsafe entry wiring (classic script, zero dependencies).
// Runs BEFORE the 3D module. If js/main.js boots OK it overwrites these
// handlers with the full versions. If the module dies (e.g. CDN blocked),
// these keep Enter + Test working and the error box explains why.
(function () {
  var KEY = "alliance_arena_settings_v2";
  var DEFAULTS = {
    tunnelUrl: "https://requests-reality-geometry-middle.trycloudflare.com",
    apiKey: "", model: "diplomacy-agent:latest",
    pollIntervalSec: 8, talkDurationSec: 30,
  };
  function $(id) { return document.getElementById(id); }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) {}
    return Object.assign({}, DEFAULTS);
  }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function fields() {
    return { tUrl: $("tunnelUrl"), model: $("modelName"), talkSecs: $("talkSecs") };
  }
  function prefill(s) {
    var f = fields();
    if (f.tUrl) f.tUrl.value = s.tunnelUrl || "";
    if (f.model) f.model.value = s.model || "";
    if (f.talkSecs) f.talkSecs.value = s.talkDurationSec != null ? s.talkDurationSec : 30;
  }
  function read(f) {
    return {
      tunnelUrl: (f.tUrl && f.tUrl.value || "").trim(),
      model: (f.model && f.model.value || "").trim() || "diplomacy-agent:latest",
      talkDurationSec: Math.max(10, Math.min(600, +(f.talkSecs && f.talkSecs.value) || 30)),
    };
  }

  prefill(load());

  var saveBtn = $("saveEntry"), skipBtn = $("skipEntry"),
      setBtn = $("settingsBtn"), testBtn = $("testConn"),
      overlay = $("entry"), st = $("connStatus");

  function enter() {
    var s = Object.assign(load(), read(fields()));
    save(s);
    prefill(s);
    if (overlay) overlay.style.display = "none";
    var c = document.getElementById("scene");
    if (c && c.requestPointerLock) { try { c.requestPointerLock(); } catch (e) {} }
  }
  if (saveBtn) saveBtn.onclick = enter;
  if (skipBtn) skipBtn.onclick = enter;
  if (setBtn) setBtn.onclick = function () {
    prefill(load());
    if (st) { st.textContent = ""; st.className = "conn"; }
    if (overlay) overlay.style.display = "flex";
  };
  if (testBtn) testBtn.onclick = function () {
    if (!st) return;
    st.className = "conn";
    st.textContent = "\u23F3 Contacting tunnel\u2026";
    var base = ((fields().tUrl && fields().tUrl.value) || "").trim().replace(/\/$/, "");
    var mdl = ((fields().model && fields().model.value) || "").trim();
    if (!base) { st.className = "conn err"; st.textContent = "\u274C Enter a tunnel URL first."; return; }
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 30000);
    fetch(base + "/v1/models", { signal: ctl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error("/v1/models -> " + r.status);
        return r.json();
      })
      .then(function (j) {
        var models = (j.data || []).map(function (x) { return x.id; });
        var useModel = mdl || models[0];
        if (!useModel) throw new Error("Tunnel reachable but reports zero models.");
        var snap = { npc_id: "nova", npc_label: "Nova", position: { x: -20, z: -20 },
          hp: 100, phase: "talk", time_left_sec: 20,
          landmarks: ["Fountain", "Ruins", "Tower", "Grove", "Docks"],
          current_directive: { type: "hold" },
          nearby: [{ id: "player", dist: 30, hp: 100 }],
          alliances: {}, recent_chat: [], player_message: "Connection test." };
        return fetch(base + "/v1/chat/completions", {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
          body: JSON.stringify({ model: useModel, temperature: 0.7,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "Return ONLY valid JSON: {\"directive\":{\"type\":\"goto|hold|follow|attack|ally\",\"target\":\"player|nova|rex|vera|none\",\"location\":\"Fountain|Ruins|Tower|Grove|Docks|none\"},\"dialogue\":\"one short line\",\"ally\":\"none|player|nova|rex|vera\"}. TALK phase: never attack." },
              { role: "user", content: JSON.stringify(snap) },
            ] }),
        }).then(function (r) {
          if (!r.ok) throw new Error("/v1/chat/completions -> " + r.status);
          return r.json();
        }).then(function (c) {
          var text = (c.choices && c.choices[0] && c.choices[0].message.content) || "{}";
          var d = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
          st.className = "conn ok";
          st.textContent = "\u2705 Models: " + models.join(", ") +
            "\n\u2705 Test decision (" + useModel + "): " + d.directive.type +
            "\n\u201C" + d.dialogue + "\u201D";
        });
      })
      .catch(function (e) {
        st.className = "conn err";
        st.textContent = "\u274C " + (e && e.message || e) + " \u2014 NPCs will use fallback brains until this works.";
      })
      .finally(function () { clearTimeout(to); });
  };
})();
