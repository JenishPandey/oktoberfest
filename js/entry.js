// Failsafe entry wiring (classic script, zero dependencies).
// Runs BEFORE the 3D module. If js/main.js boots OK it overwrites these
// handlers with the full versions. If the module dies (e.g. CDN blocked),
// these keep Enter + Test working and the error box explains why.
// No inputs: model + key are built into the server proxy.
(function () {
  function $(id) { return document.getElementById(id); }

  var saveBtn = $("saveEntry"), setBtn = $("settingsBtn"),
      testBtn = $("testConn"), overlay = $("entry"), st = $("connStatus"),
      skipBtn = $("skipTalk"), skipEntryBtn = $("skipTalkEntry");

  function enter() {
    if (overlay) overlay.style.display = "none";
    var c = document.getElementById("scene");
    if (c && c.requestPointerLock) { try { c.requestPointerLock(); } catch (e) {} }
  }
  if (saveBtn) saveBtn.onclick = enter;
  if (skipEntryBtn) skipEntryBtn.onclick = enter; // battle starts via main.js skipTalk once booted
  if (skipBtn) skipBtn.onclick = function () { /* wired by main.js after boot */ };
  if (setBtn) setBtn.onclick = function () {
    if (st) { st.textContent = ""; st.className = "conn"; }
    if (overlay) overlay.style.display = "flex";
  };
  if (testBtn) testBtn.onclick = function () {
    if (!st) return;
    st.className = "conn";
    st.textContent = "\u23F3 Testing built-in API key\u2026";
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 45000);
    fetch("/api/gemini", {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.5-flash-lite",
        system: "You are Nova, a bold shock commander in a 3D arena game.",
        history: [],
        prompt: "Connection test. Reply with exactly two lines:\nLINE1: <your spoken reply>\nLINE2: DIRECTIVE: {\"type\":\"hold\",\"target\":\"none\",\"location\":\"none\"}",
        temperature: 0.7, maxTokens: 200,
      }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("/api/gemini -> " + r.status);
        return r.json();
      })
      .then(function (j) {
        if (j.error) throw new Error(j.error);
        st.className = "conn ok";
        st.textContent = "\u2705 API key works (gemini-3.5-flash-lite)\n\u201C" +
          String(j.text || "").split("\n")[0].slice(0, 180) + "\u201D";
      })
      .catch(function (e) {
        st.className = "conn err";
        st.textContent = "\u274C " + (e && e.message || e) + " \u2014 NPCs will use fallback brains until this works.";
      })
      .finally(function () { clearTimeout(to); });
  };
})();
