//==============================================================================
// CheatMenu.js
// Cheat menu for RPG Maker MV / MZ
//
// How to use:
// 1. Put this file in the js/plugins folder
// 2. Turn it on in Plugin Manager (or just run install CheatMenu.bat)
// 3. In game press F9 to open the menu
//==============================================================================
/*:
 * @target MV MZ
 * @plugindesc Universal cheat menu for any RPG Maker MV/MZ game (v1.0)
 *
 * @param ToggleKey
 * @text Toggle Key
 * @desc Key to open/close the menu (KeyboardEvent.code, like F9)
 * @default F9
 *
 * @param TranslateLang
 * @text Translate Language
 * @desc Language the translation option translates into (code like en, id, es, fr, de, ja, zh-CN)
 * @default en
 *
 * @help
 * Press F9 (or whatever you set in Toggle Key) to open the cheat menu.
 * It reads $data* and $game* directly, so it works on any game.
 *
 * If the game is in another language, click the "A/文" button in the menu header
 * (or press Ctrl+K and search "translat") to show names and descriptions translated.
 * Needs an internet connection, results are cached.
 */
(function () {
  "use strict";

  // Must match the file name & the entry in plugins.js
  var PLUGIN_NAME = "CheatMenu";
  // Get the parameters from plugin manager
  var params = (function () {
    try {
      if (window.PluginManager && PluginManager.parameters) {
        return PluginManager.parameters(PLUGIN_NAME) || {};
      }
    } catch (e) {}
    return {};
  })();
  // Key to open/close the menu
  var TOGGLE_KEY = params.ToggleKey || "F9";
  var DEFAULT_LANG = params.TranslateLang || "en";
  var VERSION = "1.0";
  var VER_SHORT = VERSION.split(".").slice(0, 2).join(".");

  // Cheat state, kept separate from the save data
  var UCM = {
    godmode: false,
    noEncounters: false,
    noClip: false,
    speed: 1,
    _origMoveSpeed: null,
    // Locks keep HP / MP / TP at a chosen number
    // all = whole party, own = per character (actor id -> value), own(self) has more priority than the party one
    locks: {
      hp: { all: false, value: 1000, own: {} },
      mp: { all: false, value: 50, own: {} },
      tp: { all: false, value: 100, own: {} }
    }
  };

  // So it can be used from the console too
  window.$ucm = UCM;

  // Hook only once, so it doesn't double up if the file gets reloaded
  function installOnce(target, key, wrapper) {
    if (target[key] && target[key].__ucmWrapped) return;
    var original = target[key];
    var wrapped = wrapper(original);
    wrapped.__ucmWrapped = true;
    target[key] = wrapped;
  }

  // ===== Locks (HP / MP / TP) =====
  var LOCK_KINDS = ["hp", "mp", "tp"];
  // Keep a lock number inside what this actor can actually have (HP minimum is 1)
  function clampLock(actor, kind, v) {
    var min = kind === "hp" ? 1 : 0;
    var max = kind === "hp" ? actor.mhp : kind === "mp" ? actor.mmp : (typeof actor.maxTp === "function" ? actor.maxTp() : 100);
    return Math.max(min, Math.min(Math.round(Number(v) || 0), Math.max(min, max)));
  }
  // Locked value for this actor, null if not locked
  function lockFor(actor, kind) {
    if (!actor || !actor.isActor || !actor.isActor()) return null;
    var L = UCM.locks[kind];
    var own = L.own[actor.actorId()];
    if (own !== undefined) return clampLock(actor, kind, own);
    return L.all ? clampLock(actor, kind, L.value) : null;
  }
  function anyLock() {
    return LOCK_KINDS.some(function (k) { return UCM.locks[k].all || Object.keys(UCM.locks[k].own).length > 0; });
  }

  // Godmode: HP & MP go back to full whenever they change (a lock beats godmode)
  installOnce(Game_BattlerBase.prototype, "setHp", function (orig) {
    return function (value) {
      var lock = lockFor(this, "hp");
      if (lock !== null) orig.call(this, lock);
      else if (UCM.godmode && this.isActor && this.isActor()) orig.call(this, this.mhp);
      else orig.call(this, value);
    };
  });
  installOnce(Game_BattlerBase.prototype, "setMp", function (orig) {
    return function (value) {
      var lock = lockFor(this, "mp");
      if (lock !== null) orig.call(this, lock);
      else if (UCM.godmode && this.isActor && this.isActor()) orig.call(this, this.mmp);
      else orig.call(this, value);
    };
  });
  installOnce(Game_BattlerBase.prototype, "setTp", function (orig) {
    return function (tp) {
      var lock = lockFor(this, "tp");
      orig.call(this, lock !== null ? lock : tp);
    };
  });
  // _mp and _tp are changed directly when paying skill cost, so it needs a hook too
  installOnce(Game_BattlerBase.prototype, "paySkillCost", function (orig) {
    return function (skill) {
      orig.call(this, skill);
      var mp = lockFor(this, "mp");
      if (mp !== null) this._mp = mp;
      var tp = lockFor(this, "tp");
      if (tp !== null) this._tp = tp;
    };
  });
  // Some things set _hp / _mp directly (recover all etc), so push the locks back every frame
  function enforceLocks() {
    partyMembers().forEach(function (a) {
      var hp = lockFor(a, "hp"), mp = lockFor(a, "mp"), tp = lockFor(a, "tp");
      if (hp !== null && a.hp !== hp) a.setHp(hp);
      if (mp !== null && a.mp !== mp) a.setMp(mp);
      if (tp !== null && a.tp !== tp) a.setTp(tp);
    });
  }

  // No encounters
  installOnce(Game_Player.prototype, "canEncounter", function (orig) {
    return function () {
      if (UCM.noEncounters) return false;
      return orig.call(this);
    };
  });

  // No clip, walk through walls
  installOnce(Game_CharacterBase.prototype, "isMapPassable", function (orig) {
    return function (x, y, d) {
      if (UCM.noClip && this === $gamePlayer) return true;
      return orig.call(this, x, y, d);
    };
  });

  // Speed hack, run the game update multiple times per frame
  installOnce(SceneManager, "updateMain", function (orig) {
    var carry = 0;
    return function () {
      if (anyLock()) {
        try { enforceLocks(); } catch (e) {}
      }
      var mult = UCM.speed || 1;
      if (mult === 1) {
        carry = 0;
        return orig.call(this);
      }
      carry += mult;
      var ticks = Math.floor(carry);
      carry -= ticks;
      for (var i = 0; i < ticks; i++) orig.call(this);
    };
  });

  // ===== Helpers =====
  function inBattle() {
    return !!($gameParty && $gameParty.inBattle());
  }

  // Only the $data tables that actually exist in this game
  function dataTables() {
    var all = {
      Actors: window.$dataActors,
      Classes: window.$dataClasses,
      Skills: window.$dataSkills,
      Items: window.$dataItems,
      Weapons: window.$dataWeapons,
      Armors: window.$dataArmors,
      Enemies: window.$dataEnemies,
      States: window.$dataStates,
      Troops: window.$dataTroops
    };
    var out = {};
    for (var k in all) {
      if (Array.isArray(all[k])) out[k] = all[k];
    }
    return out;
  }

  // Count & name of switches / variables
  function switchCount() {
    return $dataSystem && $dataSystem.switches ? $dataSystem.switches.length - 1 : 0;
  }
  function variableCount() {
    return $dataSystem && $dataSystem.variables ? $dataSystem.variables.length - 1 : 0;
  }
  function switchName(id) {
    return ($dataSystem.switches[id] || "").trim() || ("Switch #" + id);
  }
  function variableName(id) {
    return ($dataSystem.variables[id] || "").trim() || ("Variable #" + id);
  }

  // Also exposed as $ucm.api
  UCM.api = {
    inBattle: inBattle,
    dataTables: dataTables,
    switchCount: switchCount,
    variableCount: variableCount,
    switchName: switchName,
    variableName: variableName
  };

  // Status bar text & localStorage key
  var DEFAULT_HINT = TOGGLE_KEY + " toggle  \u00b7  Esc close  \u00b7  Ctrl+K commands";
  var NO_GAME = "No game loaded yet \u2014 start or load a save to use this panel.";
  var STORE_KEY = "ucm:ui3";

  // ===== Look (CSS) =====
  var CSS = [
    ':host{all:initial;display:block}',
    '.ucm-root{font:14px/1.45 "Plus Jakarta Sans","Segoe UI",-apple-system,ui-sans-serif,system-ui,sans-serif;color:#f4f6ff;color-scheme:dark;',
    '  --bd:#222c4a;--bar:#0e1530;--bg:#0a0f1f;--side:#0a0f1e;--card:#111a35;--field:#0b1021;--panel:#111a35;--hover:rgba(120,150,255,.07);',
    '  --line:#222c4a;--line2:#1a2340;--chip:#141c38;--chipbd:#2b3558;',
    '  --muted:#8e9abd;--muted2:#6f7ba0;--accent:#3b78ff;--accent2:#5b8cff;--ink:#f4f6ff;--ro:#7dd3fc;--lock:#f5b13d;--ok:#34d399;',
    '  --ready:#60a5fa;--err:#ff7a90;--star:#facc15}',
    '.ucm-root *,.ucm-root *:before,.ucm-root *:after{box-sizing:border-box}',
    '.ucm-root button,.ucm-root input,.ucm-root select,.ucm-root textarea{font:inherit;color:inherit;margin:0}',
    '.ucm-root ::placeholder{color:var(--muted2);opacity:1}',
    '.ucm-root *{scrollbar-width:thin;scrollbar-color:#2b3558 transparent}',
    '.ucm-root *::-webkit-scrollbar{width:8px;height:8px}',
    '.ucm-root *::-webkit-scrollbar-track{background:transparent}',
    '.ucm-root *::-webkit-scrollbar-thumb{background-color:#2b3558;border-radius:9999px}',
    '.ucm-root *::-webkit-scrollbar-thumb:hover{background-color:#3a4778}',

    // Toggle switch (every checkbox in the menu)
    '.ucm-root input[type=checkbox]{-webkit-appearance:none;appearance:none;position:relative;flex:none;width:36px;height:20px;border-radius:999px;',
    '  background:#2a3358;border:0;cursor:pointer;outline:none;transition:background .15s,box-shadow .15s}',
    '.ucm-root input[type=checkbox]::before{content:"";position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}',
    '.ucm-root input[type=checkbox]:checked{background:var(--accent);box-shadow:0 0 12px rgba(59,120,255,.55)}',
    '.ucm-root input[type=checkbox]:checked::before{transform:translateX(16px)}',
    '.ucm-root input[type=checkbox]:focus-visible{box-shadow:0 0 0 2px var(--accent2)}',


    // Window: sidebar + main
    '.ucm-win{position:fixed;z-index:2147483000;display:flex;flex-direction:row;overflow:hidden;border:1px solid var(--line);',
    '  border-radius:18px;color:#f4f6ff;outline:none;',
    '  background:radial-gradient(900px 420px at 88% -8%,rgba(40,70,160,.55) 0%,transparent 65%),linear-gradient(160deg,#0d1430 0%,#090e1d 65%);',
    '  box-shadow:0 30px 60px -10px rgba(0,0,0,.65),0 10px 20px -8px rgba(0,0,0,.5)}',
    '.ucm-side{display:flex;flex:0 0 21%;min-width:150px;max-width:210px;flex-direction:column;padding:20px 14px 16px;',
    '  background:var(--side);border-right:1px solid #1a2240}',
    '.ucm-brand{padding:2px 8px 18px;cursor:move;user-select:none;touch-action:none}',
    '.ucm-brand b{display:block;font-size:19px;font-weight:800;letter-spacing:-.01em;line-height:1.2}',
    '.ucm-brand i{display:block;font-style:normal;font-size:12px;color:var(--muted)}',
    '.ucm-rail{display:flex;flex:1;min-height:0;flex-direction:column;gap:8px;overflow:auto}',
    '.ucm-tab{flex:none;cursor:pointer;user-select:none;white-space:nowrap;border-radius:14px;padding:11px 18px;font-size:15px;',
    '  background:#1b2030;border:1px solid transparent;color:#e9edff;transition:background .15s,border-color .15s}',
    '.ucm-tab:hover{background:#232a40}',
    '.ucm-tab.on{background:#2a3563;border-color:#4a5aa8;font-weight:700;color:#fff;box-shadow:0 0 22px rgba(80,110,255,.28)}',
    '.ucm-ver{flex:none;padding-top:12px;text-align:center;font-size:12px;font-weight:700;color:var(--accent2)}',
    '.ucm-main{display:flex;flex:1;min-width:0;flex-direction:column;padding:16px 18px 6px 20px}',
    '.ucm-head{position:relative;z-index:5;display:flex;flex:none;align-items:center;gap:12px;padding-bottom:14px;cursor:move;user-select:none;touch-action:none}',
    '.ucm-ptitle{flex:1;min-width:0;margin:0;font-size:25px;font-weight:800;letter-spacing:-.01em;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ucm-x{flex:none;width:32px;height:32px;display:grid;place-items:center;border:1px solid var(--chipbd);border-radius:50%;padding:0;line-height:1;',
    '  background:var(--chip);color:#e9edff;font-size:16px;cursor:pointer}',
    '.ucm-x:hover{border-color:var(--err);color:var(--err)}',
    '.ucm-rsearch{position:relative;flex:0 1 270px;min-width:0}',
    '.ucm-rsearch input{width:100%;border:1px solid var(--line);background:var(--field);border-radius:12px;padding:9px 14px;font-size:13.5px;outline:none;color:var(--ink)}',
    '.ucm-rsearch input:focus{border-color:var(--accent2)}',
    '.ucm-results{position:absolute;right:0;top:100%;z-index:10;margin:6px 0 0;max-height:15rem;width:100%;min-width:12rem;overflow-y:auto;',
    '  list-style:none;padding:6px;border:1px solid var(--chipbd);border-radius:14px;background:#0e1530;box-shadow:0 14px 30px rgba(0,0,0,.5)}',
    '.ucm-results li{cursor:pointer;border-radius:10px;padding:8px 10px;font-size:13px}',
    '.ucm-results li:hover,.ucm-results li.first{background:#1c2650}',
    '.ucm-results li.none{cursor:default;color:var(--muted2)}',
    '.ucm-body{display:flex;flex:1;flex-direction:column;min-height:0;font-size:13px;color:var(--ink)}',
    '.ucm-foot{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:10px;padding:8px 4px 4px;font-size:11.5px;color:var(--muted)}',
    '.ucm-st{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}',
    '.ucm-st.ok{color:var(--ok)}.ucm-st.warn{color:var(--lock)}.ucm-st.err{color:var(--err)}',
    '.ucm-edge{position:absolute;touch-action:none;z-index:4}',
    '.ucm-edge.r{top:0;right:0;bottom:22px;width:6px;cursor:ew-resize}',
    '.ucm-edge.b{left:0;right:22px;bottom:0;height:6px;cursor:ns-resize}',
    '.ucm-grip{z-index:5;position:absolute;right:0;bottom:0;width:22px;height:22px;cursor:nwse-resize;touch-action:none;',
    '  background:linear-gradient(135deg,transparent 52%,#6b7bb8 52%,#6b7bb8 60%,transparent 60%,transparent 72%,#6b7bb8 72%,#6b7bb8 80%,transparent 80%)}',

    // Panel content
    '.ucm-pane{display:flex;flex:1;flex-direction:column;min-height:0;overflow-y:auto}',
    '.ucm-fixed{flex:none;padding:0 0 14px}',
    '.ucm-btnrow.ucm-exprow{flex-wrap:wrap;gap:6px}',
    '.ucm-exprow .ucm-f-nm{flex:0 0 100%}',
    '.ucm-exprow .ucm-btn{padding:0 11px}',
    '.ucm-duo .ucm-btn{height:30px;padding:0 11px;font-size:13px}',
    '.ucm-duo .ucm-btnrow{gap:6px}',
    '.ucm-duo .ucm-fields{grid-template-columns:1fr;gap:8px}',
    '.ucm-duo .ucm-grp{padding:12px 14px 12px}',
    '.ucm-duo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}',
    '.ucm-duo .ucm-grp{margin-bottom:0}',
    
    '.ucm-scroll{flex:1;min-height:0;overflow:auto;padding:0 6px 6px 0}',
    '.ucm-empty{color:var(--muted);padding:24px 8px;text-align:center;font-size:13px}',
    '.ucm-emptycard{display:flex;min-height:260px;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;',
    '  border:1px solid var(--line);border-radius:18px;background:linear-gradient(160deg,rgba(25,36,74,.5),rgba(15,22,48,.7));color:var(--muted);font-size:13.5px}',
    '.ucm-emptycard b{color:#fff;font-size:17px;font-weight:800}',
    '.ucm-orb{width:78px;height:78px;margin-bottom:10px;border-radius:50%;background:linear-gradient(135deg,#3b78ff,#7a4de0);box-shadow:0 0 30px rgba(90,110,255,.35)}',

    // Cards (sections)
    '.ucm-grp{margin-bottom:14px;padding:14px 18px 16px;border:1px solid var(--line);border-radius:18px;',
    '  background:linear-gradient(160deg,rgba(25,36,74,.55),rgba(15,22,48,.78));box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}',
    '.ucm-gh{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;row-gap:2px;padding:0 0 10px;cursor:pointer;user-select:none}',
    '.ucm-chev{display:none}',
    '.ucm-gname{font-size:15.5px;font-weight:700;color:#fff}',
    '.ucm-gcount,.ucm-gmeta{order:5;font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}',
    '.ucm-gmeta.ok{color:var(--ok)}',
    '.ucm-gsub{font-size:12px;color:var(--muted2);font-family:ui-monospace,Consolas,monospace}',
    '.ucm-sp{flex:1}',
    '.ucm-gb{padding:0}',
    '.ucm-grp.collapsed .ucm-gb{display:none}',
    '.ucm-grp.collapsed .ucm-gh{padding-bottom:0}',

    // i love ave mujica music fr fr

    // Input fields
    '.ucm-fields{display:grid;gap:10px 14px;padding:2px 0;grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))}',
    '.ucm-fields.c2{grid-template-columns:repeat(2,minmax(0,1fr))}',
    '.ucm-fields.c3{grid-template-columns:repeat(3,minmax(0,1fr))}',
    '.ucm-fields.c4{grid-template-columns:repeat(4,minmax(0,1fr))}',
    '.ucm-f{display:flex;flex-direction:column;gap:5px;min-width:0}',
    '.ucm-f.full{grid-column:1/-1}',
    '.ucm-f-top{display:flex;align-items:baseline;gap:6px;min-width:0}',
    '.ucm-f-nm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#a3aed0}',
    '.ucm-f-now{flex:0 0 auto;font-size:11.5px;color:var(--ro);font-variant-numeric:tabular-nums;opacity:.9}',
    '.ucm-f-in{display:flex;align-items:center;gap:8px}',
    '.ucm-f input[type=text],.ucm-f textarea,.ucm-qty{min-width:0;max-width:100%;border:1px solid var(--line);background:var(--field);border-radius:12px;',
    '  padding:8px 13px;font-size:14px;color:#f4f6ff;outline:none;font-variant-numeric:tabular-nums}',
    '.ucm-root .ucm-qty{padding:6px 11px;font-size:13.5px;color:#f4f6ff}',
    '.ucm-f input[type=text]{width:100%;height:38px}',
    '.ucm-f textarea{width:100%;resize:vertical;min-height:50px;font-family:inherit}',
    '.ucm-f input:focus,.ucm-f textarea:focus,.ucm-qty:focus{border-color:var(--accent2)}',
    '.ucm-f.dirty input,.ucm-f.dirty textarea,.ucm-qty.dirty{border-color:var(--lock);box-shadow:inset 3px 0 0 var(--lock)}',
    '.ucm-f.applied input,.ucm-f.applied textarea{border-color:var(--ok);box-shadow:inset 3px 0 0 var(--ok)}',
    '.ucm-f.ro input{border-style:dashed;color:#8d98b8;cursor:default}',
    '.ucm-f-suf{flex:0 0 auto;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ucm-chk{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#e9edff;cursor:pointer;min-height:30px;padding:0 10px 0 6px;',
    '  border:1px solid var(--chipbd);border-radius:999px;background:var(--chip);white-space:nowrap}',

    // Buttons, segments, switch tiles
    '.ucm-btn,.ucm-select{height:36px;border:1px solid var(--chipbd);background:var(--chip);color:#e9edff;border-radius:999px;font-size:13.5px;',
    '  padding:0 17px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:border-color .15s,background .15s}',
    '.ucm-select{padding:0 12px;max-width:14rem;border-radius:12px;background:var(--field);border-color:var(--line)}',
    '.ucm-select option{background:#0b1021;color:#f4f6ff}',
    '.ucm-btn:hover:not(:disabled){border-color:var(--accent2);background:#1a2448}',
    '.ucm-btn.sel,.ucm-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;box-shadow:0 0 16px rgba(59,120,255,.45)}',
    '.ucm-btn.danger{border-color:#8b3a4e;color:var(--err)}',
    '.ucm-btn.danger:hover:not(:disabled){border-color:var(--err);background:rgba(255,90,120,.12);color:#ffb0bf}',
    '.ucm-btn:disabled{opacity:.4;cursor:not-allowed}',
    '.ucm-btnrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.ucm-seg{display:flex;flex:0 0 auto;flex-wrap:wrap;align-self:flex-start;gap:8px}',
    '.ucm-seg button{height:36px;padding:0 18px;border:1px solid var(--chipbd);border-radius:999px;background:var(--chip);color:#e9edff;',
    '  font-size:13.5px;cursor:pointer;white-space:nowrap;transition:border-color .15s,background .15s}',
    '.ucm-seg button:hover{border-color:var(--accent2)}',
    '.ucm-seg button.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;box-shadow:0 0 16px rgba(59,120,255,.45)}',
    '.ucm-seg b{font-weight:500;opacity:.7;margin-left:7px;font-size:12px}',
    '.ucm-gate{display:flex;align-items:center;gap:12px;border:1px solid var(--chipbd);background:var(--chip);color:#f4f6ff;',
    '  border-radius:14px;padding:10px 14px;font-size:14px;cursor:pointer;white-space:nowrap;user-select:none;transition:border-color .15s}',
    '.ucm-gate:hover{border-color:var(--accent2)}',
    '.ucm-gate input{pointer-events:none}',
    '.ucm-gate:focus-visible{outline:2px solid var(--accent2)}',
    '.ucm-tile{display:flex;align-items:center;gap:12px;min-width:0;padding:8px 14px;border:1px solid var(--chipbd);border-radius:14px;background:var(--chip);font-size:14px}',
    '.ucm-tile .ucm-gate{flex:none;padding:0;border:0;background:none;border-radius:0}',
    '.ucm-tile .ucm-qty{width:84px}',
    '.ucm-tile.wide{margin-top:10px;flex-wrap:wrap}',
    '.ucm-tl{color:#cdd5f0}',

    // Catalog (list + search + pages)
    '.ucm-cb-top{display:flex;flex:0 0 auto;flex-direction:column;gap:10px;padding:0 0 8px}',
    '.ucm-cb-hdr,.ucm-cb-row{display:flex;align-items:center;gap:10px;min-width:0}',
    '.ucm-cb-row{flex-wrap:wrap}',
    '.ucm-cb-hdr{min-height:22px}',
    '.ucm-lbl{font-size:15.5px;font-weight:700;color:#fff}',
    '.ucm-bar{width:90px;height:5px;flex:0 0 auto;overflow:hidden;border-radius:3px;background:var(--line2)}',
    '.ucm-bar i{display:block;height:100%;background:var(--ok)}',
    '.ucm-sum{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ucm-search{position:relative;flex:1;min-width:120px}',
    '.ucm-search input{width:100%;height:38px;border:1px solid var(--line);background:var(--field);border-radius:12px;color:var(--ink);',
    '  padding:0 28px 0 14px;outline:none;font-size:13.5px}',
    '.ucm-search input:focus{border-color:var(--accent2)}',
    '.ucm-clear{position:absolute;right:9px;top:9px;border:0;background:none;color:var(--muted2);cursor:pointer;line-height:1;font-size:15px}',
    '.ucm-clear:hover{color:#fff}',
    '.ucm-g.granted{color:var(--accent2)}',
    '.ucm-search.id{flex:0 0 84px;min-width:0}',
    '.ucm-search.amt{flex:0 0 116px;min-width:0}',
    '.ucm-cb{display:flex;flex:1;flex-direction:column;min-height:300px;padding:14px 18px 12px;border:1px solid var(--line);border-radius:18px;',
    '  background:linear-gradient(160deg,rgba(25,36,74,.55),rgba(15,22,48,.78));box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}',
    '.ucm-cb-hdr .ucm-sum{order:5}',
    '.ucm-cb-scroll{flex:1;min-height:0;overflow:auto;border-top:1px solid var(--line2)}',
    '.ucm-r{display:grid;gap:0 12px;align-items:center;padding:8px 6px;border-bottom:1px solid var(--line2);min-height:46px}',
    '.ucm-r:hover{background:var(--hover)}',
    '.ucm-r.click{cursor:pointer}',
    '.ucm-r.inv{grid-template-columns:14px 28px minmax(0,1fr) auto auto}',
    '.ucm-r.sw{grid-template-columns:48px minmax(0,1fr) auto 40px}',
    '.ucm-r.vr{grid-template-columns:48px minmax(0,1fr) auto}',
    '.ucm-r.db{grid-template-columns:48px minmax(0,1fr) 14px}',
    '.ucm-r.bt{display:flex;flex-wrap:wrap;gap:6px 14px}',
    '.ucm-bn{flex:1 1 130px;min-width:0}',
    '.ucm-bc{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}',
    '.ucm-bc b{font-weight:600;color:#a3aed0;min-width:20px}',
    '.ucm-bc .ucm-chk{font-size:12.5px}',
    '.ucm-r.flash-ok{animation:ucm-ok .9s ease-out}',
    '@keyframes ucm-ok{0%{background:rgba(52,211,153,.25)}100%{background:transparent}}',
    '.ucm-g{text-align:center;line-height:1}.ucm-g.owned{color:var(--ok)}.ucm-g.missing{color:var(--muted2)}',
    '.ucm-ic{width:28px;height:28px;display:grid;place-items:center}',
    '.ucm-ic.ph{background:linear-gradient(135deg,#4a7bff,#8a5cf0);border-radius:9px}',
    '.ucm-nb{min-width:0}',
    '.ucm-nm{display:flex;align-items:baseline;gap:8px;min-width:0}',
    '.ucm-t{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff}',
    '.ucm-id,.ucm-rid{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;flex:0 0 auto}',
    '.ucm-ds{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ucm-cat{font-size:11px;color:#cdd5f0;background:#1c2650;border-radius:999px;padding:0 8px;line-height:18px;white-space:nowrap;',
    '  max-width:110px;overflow:hidden;text-overflow:ellipsis}',
    '.ucm-ctl{display:flex;align-items:center;gap:8px;justify-content:flex-end}',
    '.ucm-r .ucm-btn{height:30px;padding:0 14px;font-size:13px}',
    '.ucm-sw-st{font-size:12px;font-weight:600;letter-spacing:.04em;text-align:right;color:var(--muted)}',
    '.ucm-sw-st.on{color:var(--muted)}.ucm-sw-st.off{color:var(--muted)}',
    '.ucm-ro{color:var(--ro);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ucm-skill{display:flex;align-items:center;gap:8px;margin-top:6px;padding-top:6px;border-top:1px dashed var(--line2)}',
    '.ucm-skill > span:first-child{font-size:12px;color:#a3aed0;flex:0 0 auto}',
    '.ucm-pager{display:flex;flex:0 0 auto;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 0 2px;border-top:1px solid var(--line2);color:var(--muted);',
    '  font-size:12.5px;font-variant-numeric:tabular-nums}',
    '.ucm-pg{min-width:28px;height:28px;border:1px solid transparent;background:none;color:var(--muted);border-radius:9px;font-size:12.5px;',
    '  cursor:pointer;padding:0 8px}',
    '.ucm-pg:hover:not(:disabled){color:#fff;border-color:var(--chipbd)}',
    '.ucm-pg.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}',
    '.ucm-pg:disabled{opacity:.35;cursor:not-allowed}',

    '.ucm-chars{padding-bottom:12px}',
    '.ucm-chars-lbl{display:none}',
    '.ucm-select.wide{display:flex;width:100%;max-width:none;height:46px;font-size:14px;padding:0 16px;justify-content:flex-start}',
    '.ucm-note{font-size:13px;color:var(--ink);margin:2px 0 10px}',
    '.ucm-stats{display:grid;gap:10px 14px;padding:2px 0;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}',
    '.ucm-f.inline{position:relative;flex-direction:column;align-items:stretch;gap:5px}',
    '.ucm-f.inline .ucm-f-nm{flex:none;overflow:visible;text-align:left;font-size:13px;font-weight:400;color:#a3aed0}',
    '.ucm-f.inline input[type=text]{width:100%;height:40px;padding:2px 34px 2px 13px}',
    '.ucm-root .ucm-apply{position:absolute;right:8px;bottom:5px;width:22px;height:30px;padding:0;border:0;background:none;color:var(--muted2);',
    '  font-size:16px;line-height:1;cursor:pointer;opacity:.7}',
    '.ucm-root .ucm-apply:hover{color:#fff;opacity:1}',
    '.ucm-f.dirty .ucm-apply{color:var(--lock);opacity:1}',
    '.ucm-f.applied .ucm-apply{color:var(--ok);opacity:1}',
    '.ucm-final{margin-top:8px;white-space:normal;color:var(--muted);font-size:12.5px}',

    // Popups (command palette, detail)
    '.ucm-layer{position:fixed;inset:0;z-index:2147483001;background:rgba(3,6,16,.45)}',
    '.ucm-card{position:fixed;left:50%;top:80px;transform:translateX(-50%);border:1px solid var(--chipbd);border-radius:18px;',
    '  background:linear-gradient(160deg,#141d3e,#0c1330);color:#f4f6ff;padding:12px;box-shadow:0 30px 60px rgba(0,0,0,.6);max-width:calc(100vw - 16px)}',
    '.ucm-card.pal{width:460px}',
    '.ucm-card.detail{width:520px;max-height:70vh;overflow:auto;padding:16px;outline:none}',
    '.ucm-pal-in{width:100%;border:1px solid var(--line);background:var(--field);border-radius:12px;padding:10px 14px;outline:none;font-size:14px}',
    '.ucm-pal-in:focus{border-color:var(--accent2)}',
    '.ucm-pal-list{max-height:20rem;overflow-y:auto;list-style:none;margin:10px 0 0;padding:0}',
    '.ucm-pal-list li{display:flex;justify-content:space-between;gap:10px;cursor:pointer;border-radius:10px;padding:8px 12px}',
    '.ucm-pal-list li:hover,.ucm-pal-list li.first{background:#1c2650}',
    '.ucm-pal-list li.none{cursor:default;color:var(--muted2);font-size:13px}',
    '.ucm-pal-grp{font-size:11px;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em}',
    '.ucm-dhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}',
    '.ucm-dhead span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;color:#fff}',
    '.ucm-card pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}',
    '.ucm-root .ucm-tr{flex:none;height:32px;padding:0 12px;font-size:12.5px}'
  ].join("\n");

  // ===== DOM helpers =====
  // Make an element quickly: h(tag, attributes, children)
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "cls") e.className = v;
        else if (k === "style") e.style.cssText = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") e.addEventListener(k.slice(2), v);
        else if (k === "value" || k === "checked" || k === "disabled") e[k] = v;
        else e.setAttribute(k, v === true ? "" : v);
      }
    }
    if (kids) {
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c == null || c === false) continue;
        e.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
      }
    }
    return e;
  }
  // Empty out an element
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // Remove RPG Maker color/escape codes (\C[2], \{ etc) from text
  function plain(s) {
    return String(s == null ? "" : s)
      .replace(/\\[A-Za-z]+\[\d+\]/g, "")
      .replace(/\\[{}$.|!<>^]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Is the game running yet (new game / load done)
  function gameReady() {
    return !!(window.$gameParty && window.$gameSwitches && window.$gameVariables && window.$dataSystem);
  }

  // ===== Search =====
  // Read the Name box: normal words, #12, 10-20, on:, off:
  function parseQuery(str) {
    var q = {}, words = [];
    String(str || "").trim().split(/\s+/).forEach(function (tok) {
      if (!tok) return;
      var low = tok.toLowerCase(), m;
      if (low === "on:" || low === "off:") { q.value = low === "on:"; return; }
      if ((m = /^#(\d+)$/.exec(tok))) { q.id = Number(m[1]); return; }
      if ((m = /^(\d+)-(\d+)$/.exec(tok))) {
        var a = Number(m[1]), b = Number(m[2]);
        q.from = Math.min(a, b); q.to = Math.max(a, b);
        return;
      }
      words.push(low);
    });
    if (words.length) q.text = words.join(" ");
    return q;
  }
  // Check one row against the parsed query
  function matchQuery(q, id, name) {
    if (q.id !== undefined && id !== q.id) return false;
    if (q.from !== undefined && (id < q.from || id > q.to)) return false;
    if (q.text !== undefined) {
      var hitName = String(name).toLowerCase().indexOf(q.text) !== -1;
      // also match the translated name when translation is on
      if (!hitName && typeof Tr !== "undefined" && Tr && Tr.cached) hitName = Tr.cached(String(name)).toLowerCase().indexOf(q.text) !== -1;
      var hitId = String(id).indexOf(q.text) !== -1;
      if (!hitName && !hitId) return false;
    }
    return true;
  }

  // Filters for the ID & Amount/State boxes
  var AMOUNT_TIP = "Amount:  5   10-20   >5   >=5   <5   <=5";
  var STATE_TIP = "State:  on   off   (or 1 / 0)";

  // ID: 5, 5-20, or 1,4,9
  function parseIdFilter(str) {
    var s = String(str || "").trim().replace(/\s*-\s*/g, "-");
    if (!s) return null;
    var ranges = [], bad = false;
    s.split(/[\s,]+/).forEach(function (tok) {
      if (!tok) return;
      var m;
      tok = tok.replace(/^#/, "");
      if ((m = /^(\d+)$/.exec(tok))) {
        ranges.push([Number(m[1]), Number(m[1])]);
      } else if ((m = /^(\d+)-(\d+)$/.exec(tok))) {
        var a = Number(m[1]), b = Number(m[2]);
        ranges.push([Math.min(a, b), Math.max(a, b)]);
      } else {
        bad = true;
      }
    });
    return { ranges: ranges, bad: bad && !ranges.length };
  }
  function matchId(f, id) {
    var d = f && f.id;
    if (!d) return true;
    if (d.bad) return false;
    for (var i = 0; i < d.ranges.length; i++) if (id >= d.ranges[i][0] && id <= d.ranges[i][1]) return true;
    return false;
  }

  // Amount: 5, 10-20, >5, <=3 (kind "state" for switches/skills: on/off)
  function parseAmountFilter(str, kind) {
    var raw = String(str || "").trim();
    if (!raw) return null;
    var low = raw.toLowerCase(), m;
    if (kind === "state") {
      if (low === "o") return null;
      if (low === "1" || low === "true" || (low.length >= 2 && "on".indexOf(low) === 0)) return { kind: "state", want: true };
      if (low === "0" || low === "false" || (low.length >= 2 && "off".indexOf(low) === 0)) return { kind: "state", want: false };
      return { kind: "state", bad: true };
    }
    if (/^(>=|<=|>|<|=)$/.test(raw)) return null;
    var num = raw.replace(/,/g, "");
    if ((m = /^(>=|<=|>|<|=)?\s*(-?\d+(?:\.\d+)?)$/.exec(num))) return { kind: "num", op: m[1] || "=", a: Number(m[2]) };
    if ((m = /^(-?\d+(?:\.\d+)?)\s*(?:-|\.\.)\s*(-?\d+(?:\.\d+)?)$/.exec(num))) {
      var a = Number(m[1]), b = Number(m[2]);
      return { kind: "num", op: "range", a: Math.min(a, b), b: Math.max(a, b) };
    }
    return { kind: "text", text: low };
  }
  // Check a value (item count, variable value, on/off state)
  function matchAmount(f, value) {
    var a = f && f.amount;
    if (!a) return true;
    if (a.kind === "state") return !a.bad && (!!value) === a.want;
    if (a.kind === "text") {
      if (value !== null && typeof value === "object") return false;
      return String(value == null ? "" : value).toLowerCase().indexOf(a.text) !== -1;
    }
    var n = NaN;
    if (typeof value === "number") n = value;
    else if (typeof value === "string" && value.trim() !== "" && isFinite(Number(value))) n = Number(value);
    if (isNaN(n)) return false;
    switch (a.op) {
      case ">": return n > a.a;
      case ">=": return n >= a.a;
      case "<": return n < a.a;
      case "<=": return n <= a.a;
      case "range": return n >= a.a && n <= a.b;
      default: return n === a.a;
    }
  }

  // ===== Remember window position =====
  // Read from localStorage, empty if it fails
  function loadStore() {
    try { return JSON.parse(window.localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  var saved = loadStore();
  // Window position, last tab, collapsed groups
  var state = {
    geo: saved.geo || null,
    tab: saved.tab || "cheats",
    collapsed: saved.collapsed || {},
    tr: { on: !!(saved.tr && saved.tr.on), lang: (saved.tr && saved.tr.lang) || DEFAULT_LANG }
  };
  // Save it back
  function persist() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        geo: state.geo, tab: state.tab, collapsed: state.collapsed, tr: state.tr
      }));
    } catch (e) {}
  }

  // Window size & position
  function viewport() { return { width: window.innerWidth, height: window.innerHeight }; }
  // Keep the window from going off screen
  function clampGeo(g, vp) {
    var w = Math.min(g.width, vp.width), hh = Math.min(g.height, vp.height);
    return {
      x: Math.max(0, Math.min(g.x, vp.width - w)),
      y: Math.max(0, Math.min(g.y, vp.height - hh)),
      width: w, height: hh
    };
  }
  // Stick to the screen edge when it is close
  function snapGeo(g, vp, d) {
    d = d || 16;
    var x = g.x, y = g.y;
    if (x <= d) x = 0;
    if (y <= d) y = 0;
    if (vp.width - (x + g.width) <= d) x = vp.width - g.width;
    if (vp.height - (y + g.height) <= d) y = vp.height - g.height;
    return { x: x, y: y, width: g.width, height: g.height };
  }
  // Starting position: centered
  function defaultGeo(vp) {
    var w = Math.min(820, vp.width - 24), hh = Math.min(540, vp.height - 24);
    return clampGeo({ x: Math.round((vp.width - w) / 2), y: Math.round((vp.height - hh) / 2), width: w, height: hh }, vp);
  }

  // UI variables
  var built = false, panelOpen = false;
  var host, root, win, titleBar, rail, body, statusEl, layer, railInput, railResults, pageTitle;
  // Functions refreshed every 0.4 sec while the menu is open
  var liveFns = [];
  var toastTimer = null;
  // Remember the last choice for each tab
  var invKind = "items";
  var dbState = { table: null, id: null };
  var actorSel = { id: null, view: "stats" };
  var cheatSel = { view: "cheats" };

  // Register a refresh function
  function addLive(fn) { liveFns.push(fn); return fn; }
  // Run all the refresh functions
  function tickLive() {
    for (var i = 0; i < liveFns.length; i++) {
      try { liveFns[i](); } catch (e) {}
    }
  }
  // Is the user typing in this box or not
  function focused(node) {
    var ae = (root && root.activeElement) || document.activeElement;
    return ae === node;
  }
  // Write a message in the status bar, back to normal text after 3.5 sec
  function toast(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = "ucm-st" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      statusEl.textContent = DEFAULT_HINT;
      statusEl.className = "ucm-st";
    }, 3500);
  }
  // Green blink when it works
  function flash(node) {
    node.classList.remove("flash-ok");
    void node.offsetWidth;
    node.classList.add("flash-ok");
    setTimeout(function () { node.classList.remove("flash-ok"); }, 950);
  }

  // Dragging (move / resize), pointer events if available, otherwise plain mouse
  function bindDrag(target, cb) {
    var active = false, lx = 0, ly = 0, sx = 0, sy = 0;
    function move(e) {
      if (!active) return;
      var dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      cb.move(dx, dy);
    }
    function up(e) {
      if (!active) return;
      active = false;
      if (window.PointerEvent) {
        try { target.releasePointerCapture(e.pointerId); } catch (err) {}
      } else {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mouseup", up, true);
      }
      cb.end(e.clientX - sx, e.clientY - sy);
    }
    function down(e) {
      if (e.button !== 0) return;
      if (cb.ignore && cb.ignore(e)) return;
      e.preventDefault();
      active = true;
      lx = sx = e.clientX; ly = sy = e.clientY;
      if (window.PointerEvent) {
        try { target.setPointerCapture(e.pointerId); } catch (err) {}
      } else {
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
      }
    }
    if (window.PointerEvent) {
      target.addEventListener("pointerdown", down);
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    } else {
      target.addEventListener("mousedown", down);
    }
  }

  // ===== UI parts =====
  // Normal button
  function btn(label, onClick, cls, title) {
    var b = h("button", { type: "button", cls: "ucm-btn" + (cls ? " " + cls : ""), title: title }, [label]);
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!b.disabled) onClick(e);
    });
    return b;
  }

  // On/off button, pill style
  function pill(label, get, set, title) {
    var cb = h("input", { type: "checkbox", tabindex: "-1" });
    var lab = h("label", { cls: "ucm-gate", role: "checkbox", tabindex: "0", title: title }, [cb, label]);
    function paint() {
      var on = !!get();
      lab.setAttribute("data-on", String(on));
      lab.setAttribute("aria-checked", String(on));
      cb.checked = on;
    }
    function flip(e) {
      e.preventDefault();
      e.stopPropagation();
      set(!get());
      paint();
      toast(label + ": " + (get() ? "on" : "off"), "ok");
    }
    lab.addEventListener("click", flip);
    lab.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") flip(e);
    });
    paint();
    addLive(paint);
    return lab;
  }

  // Checkbox + label
  function check(label, get, set) {
    var cb = h("input", { type: "checkbox" });
    cb.checked = !!get();
    cb.addEventListener("change", function () {
      set(cb.checked);
      toast(label + " \u2192 " + (cb.checked ? "true" : "false"), "ok");
    });
    addLive(function () { if (!focused(cb)) cb.checked = !!get(); });
    return h("label", { cls: "ucm-chk" }, [cb, label]);
  }

  // Segment picker (All / On / Off etc)
  function seg(items, active, onPick) {
    var node = h("div", { cls: "ucm-seg" });
    function draw() {
      clear(node);
      items().forEach(function (it) {
        var b = h("button", { type: "button", cls: it.key === active() ? "on" : "" },
          [it.label, it.count != null ? h("b", null, [String(it.count)]) : null]);
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          onPick(it.key);
          draw();
        });
        node.appendChild(b);
      });
    }
    draw();
    node.__draw = draw;
    return node;
  }

  // Number/text input + marks for not applied yet (yellow) and applied (green)
  function field(o) {
    var type = o.type || "number";
    var inp = o.multiline
      ? h("textarea", { spellcheck: "false", rows: "2" })
      : h("input", { type: "text", spellcheck: "false", autocomplete: "off", inputmode: type === "number" ? "decimal" : "text" });
    var now = h("span", { cls: "ucm-f-now" });
    var suf = o.suffix ? h("span", { cls: "ucm-f-suf" }) : null;
    var nameEl = h("span", { cls: "ucm-f-nm", title: o.title || o.label }, [o.label]);
    var apply = null, wrap;
    if (o.inline) {
      apply = h("button", { type: "button", cls: "ucm-apply", tabindex: "-1", title: "Apply (Enter)", "aria-label": "Apply " + o.label }, ["\u21aa"]);
      wrap = h("div", { cls: "ucm-f inline" + (o.readOnly ? " ro" : "") }, [nameEl, inp, apply]);
    } else {
      wrap = h("div", { cls: "ucm-f" + (o.full ? " full" : "") + (o.readOnly ? " ro" : "") }, [
        h("div", { cls: "ucm-f-top" }, [nameEl, now]),
        h("div", { cls: "ucm-f-in" }, [inp, suf])
      ]);
    }
    if (o.width) inp.style.width = o.width + "px";
    if (o.readOnly) inp.readOnly = true;
    var shown = "";

    function fmt(v) {
      if (type === "json") return JSON.stringify(v);
      return v == null ? "" : String(v);
    }
    function isDirty() { return inp.value !== shown; }
    function updSuffix() {
      if (suf) suf.textContent = typeof o.suffix === "function" ? o.suffix() : o.suffix;
    }
    function load() {
      shown = fmt(o.get());
      inp.value = shown;
      wrap.classList.remove("dirty");
      now.textContent = "";
      updSuffix();
    }
    // Apply the typed value (Enter, click the arrow, or lose focus)
    function commit() {
      if (o.readOnly || !isDirty()) return;
      var val;
      if (type === "number") {
        var n = Number(String(inp.value).replace(/,/g, "").trim());
        if (inp.value.trim() === "" || !isFinite(n)) { toast("\u201c" + o.label + "\u201d: not a number", "warn"); load(); return; }
        val = n;
      } else if (type === "json") {
        try { val = JSON.parse(inp.value); } catch (err) { toast("\u201c" + o.label + "\u201d: invalid JSON", "err"); return; }
      } else {
        val = inp.value;
      }
      try { o.set(val); } catch (err2) { toast("\u201c" + o.label + "\u201d: " + err2.message, "err"); load(); return; }
      shown = fmt(o.get());
      inp.value = shown;
      wrap.classList.remove("dirty");
      now.textContent = "";
      wrap.classList.add("applied");
      setTimeout(function () { wrap.classList.remove("applied"); }, 1400);
      toast(o.label + " \u2192 " + (shown.length > 40 ? shown.slice(0, 40) + "\u2026" : shown), "ok");
    }

    inp.addEventListener("input", function () {
      var d = isDirty();
      wrap.classList.toggle("dirty", d);
      wrap.classList.remove("applied");
      now.textContent = d ? "now " + fmt(o.get()) : "";
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !(o.multiline && !e.ctrlKey)) { e.preventDefault(); commit(); }
      else if (e.key === "Escape" && isDirty()) { e.stopPropagation(); load(); }
    });
    inp.addEventListener("blur", commit);
    if (apply) apply.addEventListener("click", function (e) { e.stopPropagation(); commit(); });

    load();
    addLive(function () {
      if (focused(inp) || isDirty()) return;
      var v = fmt(o.get());
      if (v !== shown) { shown = v; inp.value = v; }
      updSuffix();
    });
    return wrap;
  }

  // Small input for inside list rows
  function bareInput(get, set, width, parse, onApplied) {
    var inp = h("input", { type: "text", cls: "ucm-qty", spellcheck: "false", autocomplete: "off", inputmode: "numeric" });
    inp.style.width = (width || 56) + "px";
    var shown = "";
    parse = parse || function (t) {
      var n = Number(String(t).replace(/,/g, "").trim());
      return (String(t).trim() === "" || !isFinite(n)) ? { ok: false } : { ok: true, value: n };
    };
    function fmt(v) { return v == null ? "" : String(v); }
    function load() {
      shown = fmt(get());
      inp.value = shown;
      inp.classList.remove("dirty");
    }
    function commit() {
      if (inp.value === shown) return;
      var r = parse(inp.value, get());
      if (!r.ok) { toast("Not a valid value", "warn"); load(); return; }
      set(r.value);
      load();
      if (onApplied) onApplied();
    }
    inp.addEventListener("input", function () { inp.classList.toggle("dirty", inp.value !== shown); });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape" && inp.value !== shown) { e.stopPropagation(); load(); }
    });
    inp.addEventListener("blur", commit);
    load();
    return {
      el: inp,
      load: load,
      refresh: function () {
        if (focused(inp) || inp.value !== shown) return;
        var v = fmt(get());
        if (v !== shown) { shown = v; inp.value = v; }
      }
    };
  }

  // Collapsible section
  function group(o) {
    var collapsed = !!state.collapsed[o.id];
    var chev = h("span", { cls: "ucm-chev" }, [collapsed ? "\u25b8" : "\u25be"]);
    var kids = [chev, h("span", { cls: "ucm-gname" }, [o.title])];
    if (o.count != null) {
      var cEl = h("span", { cls: "ucm-gcount" });
      var setCount = function () { cEl.textContent = typeof o.count === "function" ? o.count() : o.count; };
      setCount();
      if (typeof o.count === "function") addLive(setCount);
      kids.push(cEl);
    }
    if (o.sub) kids.push(h("span", { cls: "ucm-gsub" }, [o.sub]));
    if (o.meta) {
      var mEl = h("span", { cls: "ucm-gmeta" });
      var setMeta = function () {
        var m = o.meta();
        mEl.textContent = m.text;
        mEl.className = "ucm-gmeta" + (m.ok ? " ok" : "");
      };
      setMeta();
      addLive(setMeta);
      kids.push(mEl);
    }
    kids.push(h("span", { cls: "ucm-sp" }));
    (o.actions || []).forEach(function (a) { kids.push(a); });

    var head = h("div", { cls: "ucm-gh", role: "button", tabindex: "0", "aria-expanded": String(!collapsed) }, kids);
    var node = h("div", { cls: "ucm-grp" + (collapsed ? " collapsed" : ""), "data-accent": o.accent || "core" }, [
      head, h("div", { cls: "ucm-gb" }, [o.body])
    ]);
    function toggle() {
      var c = node.classList.toggle("collapsed");
      state.collapsed[o.id] = c;
      chev.textContent = c ? "\u25b8" : "\u25be";
      head.setAttribute("aria-expanded", String(!c));
      persist();
    }
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", function (e) {
      if (e.target === head && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); }
    });
    return node;
  }

  // Empty panel + message
  function emptyPane(msg) {
    return h("div", { cls: "ucm-pane" }, [h("div", { cls: "ucm-empty" }, [msg])]);
  }

  // Page numbers to show (first, last, around the current page)
  function pageList(page, pages) {
    var set = {};
    set[0] = 1; set[pages - 1] = 1; // she do be shredding it like there's no tomorrow
    for (var d = -1; d <= 1; d++) { var p = page + d; if (p >= 0 && p < pages) set[p] = 1; }
    var arr = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    var out = [], prev = -1;
    arr.forEach(function (p) {
      if (p - prev > 1) out.push("gap");
      out.push(p);
      prev = p;
    });
    return out;
  }

  // Searchable list with pages, used by Party, Skills, Switches, Variables, Database
  function catalog(o) {
    var page = 0;
    var fields = o.fields || null;
    // Search box + x button
    function mkBox(ph, cls, tip) {
      var inp = h("input", { type: "text", placeholder: ph, spellcheck: "false", autocomplete: "off" });
      if (tip) inp.title = tip;
      var x = h("button", { type: "button", cls: "ucm-clear", title: "Clear" }, ["\u00d7"]);
      x.style.display = "none";
      return { wrap: h("div", { cls: "ucm-search" + (cls ? " " + cls : "") }, [inp, x]), input: inp, clear: x };
    }
    // Name box is always there, ID & Amount only when fields is used
    var nameBox = mkBox(o.placeholder || "Search\u2026", "", fields ? "Name  (also understands #12, 10-20, on:, off:)" : "");
    var input = nameBox.input;
    var idBox = fields ? mkBox("ID", "id", "ID:  5   5-20   1,4,9") : null;
    var amtBox = fields ? mkBox(fields.amount || "Amount", "amt", fields.tip || "") : null;
    var sum = h("span", { cls: "ucm-sum" });
    var bar = o.bar ? h("span", { cls: "ucm-bar" }, [h("i")]) : null;
    var hdrKids = [h("span", { cls: "ucm-lbl" }, [o.label]), bar, sum, h("span", { cls: "ucm-sp" })];
    (o.headerExtras || []).forEach(function (x) { hdrKids.push(x); });
    var row1Kids = fields ? [] : [nameBox.wrap];
    (o.controls || []).forEach(function (x) { row1Kids.push(x); });
    var topKids = [h("div", { cls: "ucm-cb-hdr" }, hdrKids)];
    if (row1Kids.length) topKids.push(h("div", { cls: "ucm-cb-row" }, row1Kids));
    if (fields) topKids.push(h("div", { cls: "ucm-cb-row" }, [idBox.wrap, nameBox.wrap, amtBox.wrap]));
    var top = h("div", { cls: "ucm-cb-top" }, topKids);
    var scroll = h("div", { cls: "ucm-cb-scroll" });
    var pager = h("div", { cls: "ucm-pager" });
    var node = h("div", { cls: "ucm-cb" }, [top, scroll, pager]);
    var rowLive = [];
    var current = [];
    addLive(function () { for (var i = 0; i < rowLive.length; i++) rowLive[i](); });

    // Draw the page numbers at the bottom
    function drawPager(pages, n, start, count) {
      clear(pager);
      pager.appendChild(h("span", null, [n ? (start + 1) + "\u2013" + (start + count) + " of " + n : "0 results"]));
      pager.appendChild(h("span", { cls: "ucm-sp" }));
      if (pages < 2) return;
      function pg(label, target, disabled, on) {
        var b = h("button", { type: "button", cls: "ucm-pg" + (on ? " on" : ""), disabled: disabled }, [label]);
        b.addEventListener("click", function () { page = target; render(); });
        return b;
      }
      pager.appendChild(pg("\u2039", page - 1, page === 0));
      pageList(page, pages).forEach(function (p) {
        if (p === "gap") pager.appendChild(h("span", null, ["\u2026"]));
        else pager.appendChild(pg(String(p + 1), p, false, p === page));
      });
      pager.appendChild(pg("\u203a", page + 1, page >= pages - 1));
    }

    // Filter again then draw the rows
    function render(keepScroll) {
      var f = fields ? {
        id: parseIdFilter(idBox.input.value),
        amount: parseAmountFilter(amtBox.input.value, fields.kind)
      } : {};
      var res = o.rows(parseQuery(input.value), input.value, f);
      var size = o.pageSize || 40;
      var pages = Math.max(1, Math.ceil(res.list.length / size));
      if (page >= pages) page = pages - 1;
      if (page < 0) page = 0;
      var start = page * size;
      var slice = res.list.slice(start, start + size);
      current = res.list;
      clear(scroll);
      rowLive.length = 0;
      if (!slice.length) scroll.appendChild(h("div", { cls: "ucm-empty" }, [o.empty || "No matches."]));
      slice.forEach(function (item) { scroll.appendChild(o.row(item, rowLive)); });
      sum.textContent = res.summary != null ? res.summary : res.list.length + " / " + res.total;
      if (bar) bar.firstChild.style.width = Math.max(0, Math.min(100, res.pct || 0)) + "%";
      drawPager(pages, res.list.length, start, slice.length);
      if (!keepScroll) scroll.scrollTop = 0;
      if (o.afterRender) o.afterRender();
    }

    // Hook up the events: typing, x button, Esc, Enter
    function wire(box) {
      box.input.addEventListener("input", function () {
        box.clear.style.display = box.input.value ? "block" : "none";
        page = 0;
        render();
      });
      box.clear.addEventListener("click", function () {
        box.input.value = "";
        box.clear.style.display = "none";
        page = 0;
        render();
        box.input.focus();
      });
      box.input.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && box.input.value) {
          e.stopPropagation();
          box.clear.click();
        } else if (e.key === "Enter" && o.onEnter && current.length) {
          o.onEnter(current[0]);
        }
      });
    }
    wire(nameBox);
    if (fields) { wire(idBox); wire(amtBox); }

    render();
    return {
      node: node,
      input: input,
      refresh: function () { render(true); },
      reset: function () { page = 0; render(); }
    };
  }

  // Icon from the game's IconSet, empty box if there isn't one
  function iconEl(index) {
    var holder = h("span", { cls: "ucm-ic ph" });
    if (!index) return holder;
    try {
      var bmp = window.ImageManager && ImageManager.loadSystem("IconSet");
      if (!bmp) return holder;
      var draw = function () {
        try {
          var src = bmp.canvas || bmp._canvas || bmp._image || bmp.image;
          if (!src) return;
          var iw = ImageManager.iconWidth || 32, ih = ImageManager.iconHeight || 32;
          var cv = document.createElement("canvas");
          cv.width = 16; cv.height = 16;
          cv.getContext("2d").drawImage(src, (index % 16) * iw, Math.floor(index / 16) * ih, iw, ih, 0, 0, 16, 16);
          clear(holder);
          holder.className = "ucm-ic";
          holder.appendChild(cv);
        } catch (e) {}
      };
      if (bmp.addLoadListener) bmp.addLoadListener(draw); else draw();
    } catch (e) {}
    return holder;
  }

  // ===== Party actions =====
  // All party members (reserve too)
  function partyMembers() {
    if (!window.$gameParty) return [];
    return (typeof $gameParty.allMembers === "function" ? $gameParty.allMembers() : $gameParty.members()) || [];
  }
  // Fill HP or MP of the whole party, one time only, not godmode (kind is "hp" or "mp")
  function recoverParty(kind) {
    if (!gameReady()) return toast(NO_GAME, "warn");
    var list = partyMembers();
    if (!list.length) return toast("The party is empty", "warn");
    var locked = 0;
    list.forEach(function (a) {
      if (lockFor(a, kind) !== null) locked++;
      if (kind === "hp") a.setHp(a.mhp); else a.setMp(a.mmp);
    });
    toast((kind === "hp" ? "Max HP" : "Max MP") + " \u2192 " + list.length + " member" + (list.length === 1 ? "" : "s") + (locked ? ", " + locked + " locked" : ""), "ok");
    tickLive();
  }
  // Max HP / Max MP buttons
  function recoverButtons() {
    return [
      btn("Max HP", function () { recoverParty("hp"); }, "", "Fill HP for the whole party (also gets KO'd members back up)"),
      btn("Max MP", function () { recoverParty("mp"); }, "", "Fill MP for the whole party")
    ];
  }
  // Add exactly n EXP to every member
  function addExpAll(n) {
    if (!gameReady()) return toast(NO_GAME, "warn");
    var list = partyMembers().filter(function (a) { return typeof a.changeExp === "function"; });
    if (!list.length) return toast("The party is empty", "warn");
    list.forEach(function (a) { a.changeExp(a.currentExp() + n, false); });
    toast("+" + n.toLocaleString() + " EXP \u2192 " + list.length + " member" + (list.length === 1 ? "" : "s"), "ok");
    tickLive();
  }
  // Set HP / MP / TP on a battler (a lock still wins, the hooks take care of it)
  function setStat(b, kind, v) {
    if (kind === "hp") b.setHp(v); else if (kind === "mp") b.setMp(v); else b.setTp(v);
  }
  function statNow(b, kind) {
    return kind === "hp" ? b.hp : kind === "mp" ? b.mp : b.tp;
  }
  // Typing a new value on a character: moves their lock, and the party-wide lock blocks it
  function typeStat(actor, kind, v) {
    var L = UCM.locks[kind], id = actor.actorId(), n = Math.max(0, Math.round(v));
    if (L.own[id] !== undefined) L.own[id] = clampLock(actor, kind, n);
    else if (L.all) throw new Error("the party-wide " + kind.toUpperCase() + " lock is on (Cheats tab)");
    setStat(actor, kind, n);
  }
  // Apply the locked value to party members right away
  function applyLocks(kind) {
    partyMembers().forEach(function (a) {
      var v = lockFor(a, kind);
      if (v !== null) setStat(a, kind, v);
    });
  }
  // Lock one character at whatever the value is right now (or unlock)
  function setOwnLock(actor, kind, on) {
    var own = UCM.locks[kind].own, id = actor.actorId();
    if (on) own[id] = clampLock(actor, kind, statNow(actor, kind));
    else delete own[id];
  }
  function hasOwnLock(actor, kind) {
    return UCM.locks[kind].own[actor.actorId()] !== undefined;
  }
  // On/off pill for the lock of one character
  function ownLockPill(actor, kind) {
    var name = kind.toUpperCase();
    return pill(name + " lock",
      function () { return hasOwnLock(actor, kind); },
      function (on) { setOwnLock(actor, kind, on); },
      "Keep this character's " + name + " at its current number, even in battle. Type a new " + name + " to change the locked number.");
  }
  // Small lock checkbox inside a battler row
  function miniLock(actor, kind) {
    var name = kind.toUpperCase();
    var cb = h("input", { type: "checkbox" });
    cb.checked = hasOwnLock(actor, kind);
    cb.addEventListener("change", function () {
      setOwnLock(actor, kind, cb.checked);
      toast(name + " lock: " + plain(actor.name()) + " \u2192 " + (cb.checked ? "on" : "off"), "ok");
    });
    addLive(function () { if (!focused(cb)) cb.checked = hasOwnLock(actor, kind); });
    return h("label", { cls: "ucm-chk", title: "Keep " + name + " at this number" }, [cb, "lock"]);
  }

  // ===== Battle actions =====
  var battle = {
    victory: function () {
      if (!inBattle()) return toast("Not in battle", "warn");
      $gameTroop.members().forEach(function (e) { e.addNewState(e.deathStateId()); });
      BattleManager.processVictory();
      toast("Forced victory", "ok");
    },
    defeat: function () {
      if (!inBattle()) return toast("Not in battle", "warn");
      $gameParty.members().forEach(function (a) { a.addNewState(a.deathStateId()); });
      BattleManager.processDefeat();
      toast("Forced defeat", "ok");
    },
    escape: function () {
      if (!inBattle()) return toast("Not in battle", "warn");
      $gameParty.performEscape();
      BattleManager._escaped = true;
      BattleManager.processAbort();
      toast("Forced escape", "ok");
    },
    healEnemies: function () {
      if (!inBattle()) return toast("Not in battle", "warn");
      $gameTroop.members().forEach(function (e) { e.setHp(e.mhp); e.setMp(e.mmp); });
      toast("Healed all enemies", "ok");
    },
    killEnemies: function () {
      if (!inBattle()) return toast("Not in battle", "warn");
      $gameTroop.members().forEach(function (e) { e.setHp(0); });
      toast("Killed all enemies", "ok");
    }
  };

  // ===== Cheats tab =====
  // Switch between the normal cheats and the battle view
  function buildCheatsTab() {
    var viewSeg = seg(
      function () { return [{ key: "cheats", label: "Cheats" }, { key: "battle", label: "Battle" }]; },
      function () { return cheatSel.view; },
      function (k) { cheatSel.view = k; renderView(); }
    );
    var head = h("div", { cls: "ucm-fixed" }, [viewSeg]);
    var holder = h("div", { cls: "ucm-pane" });
    function renderView() {
      liveFns.length = 0;
      clear(holder);
      holder.appendChild(cheatSel.view === "battle" ? buildBattleView() : buildCheatsView());
      tickLive();
    }
    renderView();
    return h("div", { cls: "ucm-pane" }, [head, holder]);
  }

  function buildCheatsView() {
    var scroll = h("div", { cls: "ucm-scroll" });

    // Toggles
    var tgBody = h("div", null);
    tgBody.appendChild(h("div", { cls: "ucm-fields c3" }, [
      pill("Godmode", function () { return UCM.godmode; }, function (v) { UCM.godmode = v; }, "Party HP/MP are clamped to max whenever they change"),
      pill("No Encounters", function () { return UCM.noEncounters; }, function (v) { UCM.noEncounters = v; }, "Disable random encounters on the map"),
      pill("No Clip", function () { return UCM.noClip; }, function (v) { UCM.noClip = v; }, "Walk through walls and obstacles")
    ]));
    // Game speed
    var speedSeg = seg(
      function () { return [1, 2, 4, 8].map(function (s) { return { key: String(s), label: "\u00d7" + s }; }); },
      function () { return String(UCM.speed); },
      function (k) { UCM.speed = Number(k); toast("Game speed \u2192 \u00d7" + k, "ok"); }
    );
    addLive(function () { speedSeg.__draw(); });
    var speedIn = bareInput(
      function () { return UCM.speed; },
      function (v) { UCM.speed = Math.max(0.1, Math.min(10, v || 1)); },
      84, null,
      function () { toast("Game speed \u2192 \u00d7" + UCM.speed, "ok"); }
    );
    addLive(speedIn.refresh);
    tgBody.appendChild(h("div", { cls: "ucm-tile wide" }, [
      h("span", { cls: "ucm-tl" }, ["Game Speed"]),
      speedIn.el,
      h("span", { cls: "ucm-f-suf" }, ["\u00d7 (0.1 \u2013 10)"]),
      h("span", { cls: "ucm-sp" }),
      speedSeg
    ]));
    scroll.appendChild(group({
      id: "cheats.toggles", title: "Toggles", accent: "core", body: tgBody,
      count: function () {
        var n = (UCM.godmode ? 1 : 0) + (UCM.noEncounters ? 1 : 0) + (UCM.noClip ? 1 : 0);
        return n + "/3 on";
      }
    }));

    // Recovery (fill once, not godmode)
    scroll.appendChild(group({
      id: "cheats.recovery", title: "Party Recovery", accent: "core",
      body: h("div", { cls: "ucm-btnrow", style: "padding:2px 0" }, recoverButtons()),
      meta: function () { return gameReady() ? { text: partyMembers().length + " members" } : { text: "No game" }; }
    }));

    // Locks for the whole party: one tile each for HP / MP / TP
    var lockTiles = LOCK_KINDS.map(function (kind) {
      var L = UCM.locks[kind], name = kind.toUpperCase();
      var lockIn = bareInput(
        function () { return L.value; },
        function (v) { L.value = Math.max(kind === "hp" ? 1 : 0, Math.round(v)); if (L.all && gameReady()) applyLocks(kind); },
        84
      );
      lockIn.el.title = "Locked " + name + " (" + (kind === "hp" ? "1" : "0") + " to each member's max)";
      addLive(lockIn.refresh);
      return h("div", { cls: "ucm-tile" }, [
        pill(name + " lock", function () { return L.all; }, function (v) { L.all = v; if (v && gameReady()) applyLocks(kind); },
          "Keep every member's " + name + " at the locked number, even in battle"),
        h("span", { cls: "ucm-sp" }),
        lockIn.el
      ]);
    });
    scroll.appendChild(group({
      id: "cheats.locks", title: "Locks", accent: "core",
      count: function () {
        var on = LOCK_KINDS.filter(function (k) { return UCM.locks[k].all; }).map(function (k) { return k.toUpperCase(); });
        return on.length ? on.join(" + ") + " on" : "off";
      },
      body: h("div", { cls: "ucm-fields c3" }, lockTiles)
    }));
    return scroll;
  }

  // One ally / enemy row: name, HP and MP boxes (allies also get lock boxes)
  function battlerRow(b, ally) {
    var name = plain(b.name());
    var tag = h("span", { cls: "ucm-cat" });
    function cell(kind) {
      var max = h("span", { cls: "ucm-id" });
      var inp = bareInput(
        function () { return statNow(b, kind); },
        function (v) {
          try {
            if (b.isActor && b.isActor()) typeStat(b, kind, v); else setStat(b, kind, Math.max(0, Math.round(v)));
          } catch (e) { toast(e.message, "warn"); }
          tickLive();
        }, 74);
      function paint() {
        inp.refresh();
        max.textContent = "/ " + (kind === "hp" ? b.mhp : b.mmp);
      }
      paint();
      addLive(paint);
      var kids = [h("b", null, [kind.toUpperCase()]), inp.el, max];
      if (ally) kids.push(miniLock(b, kind));
      return h("div", { cls: "ucm-bc" }, kids);
    }
    function paintTag() {
      var t = b.isDead() ? "KO" : (!ally && b.isHidden && b.isHidden()) ? "Hidden" : "";
      tag.textContent = t;
      tag.style.display = t ? "" : "none";
    }
    paintTag();
    addLive(paintTag); // putting the ass in bassist
    return h("div", { cls: "ucm-r bt" }, [
      h("div", { cls: "ucm-bn ucm-nm" }, [h("span", { cls: "ucm-t", title: name }, [name]), tag]),
      cell("hp"),
      cell("mp")
    ]);
  }

  // Dedicated battle view: battle buttons + HP/MP of every ally and enemy
  function buildBattleView() {
    var scroll = h("div", { cls: "ucm-scroll" });
    var lastSig = null, pending = false;

    function battlers() {
      return {
        allies: typeof $gameParty.battleMembers === "function" ? $gameParty.battleMembers() : $gameParty.members(),
        enemies: $gameTroop ? $gameTroop.members() : []
      };
    }
    // pretty sure it's canon, but the subtext is just pr things
    // Changes when a fight starts / ends or the battlers change, then the rows get rebuilt
    function sig() {
      if (!inBattle()) return "no";
      var b = battlers();
      return b.allies.map(function (m) { return m.actorId(); }).join(",") + "|" + b.enemies.map(function (m, i) { return i + ":" + m.enemyId(); }).join(",");
    }
    function watch() {
      if (pending || sig() === lastSig) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        if (scroll.isConnected === false) return;
        fill();
        tickLive();
      }, 0);
    }

    function fill() {
      liveFns.length = 0;
      addLive(watch);
      clear(scroll);
      lastSig = sig();

      // Battle buttons
      var buttons = [
        btn("Force Victory", battle.victory, "", "Kill every enemy and end the fight as a win"),
        btn("Force Defeat", battle.defeat, "danger", "Kill the whole party"),
        btn("Force Escape", battle.escape, "", "Run away from this battle"),
        btn("Heal All Enemies", battle.healEnemies, "", "Restore enemy HP/MP"),
        btn("Kill All Enemies", battle.killEnemies, "danger", "Set every enemy's HP to 0")
      ];
      addLive(function () {
        var inB = inBattle();
        buttons.forEach(function (x) { x.disabled = !inB; });
      });
      scroll.appendChild(group({
        id: "battle.actions", title: "Battle", accent: "riot",
        body: h("div", { cls: "ucm-btnrow", style: "padding:2px 0" }, buttons),
        meta: function () { return inBattle() ? { text: "In battle", ok: true } : { text: "Not in battle" }; }
      }));

      if (!inBattle()) {
        scroll.appendChild(h("div", { cls: "ucm-emptycard" }, [h("b", null, ["Not in battle."]), h("span", null, ["Allies and enemies show up here when a fight starts."])]));
        return;
      }

      var list = battlers();
      scroll.appendChild(group({
        id: "battle.allies", title: "Allies", accent: "core",
        count: function () { return list.allies.length + " in battle"; },
        body: h("div", null, [h("div", { cls: "ucm-btnrow", style: "padding:2px 0 6px" }, recoverButtons())]
          .concat(list.allies.map(function (m) { return battlerRow(m, true); })))
      }));
      scroll.appendChild(group({
        id: "battle.enemies", title: "Enemies", accent: "riot",
        count: function () {
          var alive = list.enemies.filter(function (e) { return e.isAlive(); }).length;
          return alive + "/" + list.enemies.length + " alive";
        },
        body: h("div", null, list.enemies.map(function (m) { return battlerRow(m, false); }))
      }));
    }

    fill();
    return scroll;
  }

  // Small note on an item row (weapon/armor type, key item)
  function itemTag(kind, obj) {
    if (kind === "items") return obj.itypeId === 2 ? "Key item" : "";
    if (kind === "weapons") return plain(($dataSystem.weaponTypes || [])[obj.wtypeId] || "");
    return plain(($dataSystem.armorTypes || [])[obj.atypeId] || "");
  }

  // ===== Party tab =====
  function buildPartyTab() {
    if (!gameReady()) return emptyPane(NO_GAME);

    // Gold
    var maxGold = function () { return typeof $gameParty.maxGold === "function" ? $gameParty.maxGold() : 99999999; };
    var goldBtns = h("div", { cls: "ucm-btnrow" }, [1000, 10000, 100000].map(function (n) {
      return btn("+" + (n >= 1000 ? (n / 1000) + "k" : n), function () {
        $gameParty.gainGold(n);
        toast("Gold +" + n, "ok");
        tickLive();
      });
    }).concat([btn("Max", function () {
      $gameParty.gainGold(maxGold() - $gameParty.gold());
      toast("Gold set to max", "ok");
      tickLive();
    })]));
    var goldBody = h("div", { cls: "ucm-fields", style: "align-items:start" }, [
      field({
        label: "Current gold", width: 130, suffix: function () { return "max " + maxGold(); },
        get: function () { return $gameParty.gold(); },
        set: function (v) { $gameParty.gainGold(Math.max(0, Math.floor(v)) - $gameParty.gold()); }
      }),
      h("div", { cls: "ucm-f" }, [h("div", { cls: "ucm-f-top" }, [h("span", { cls: "ucm-f-nm" }, ["Quick add"])]), goldBtns])
    ]);
    // Recovery & EXP
    var expBtns = [100, 1000, 10000, 100000].map(function (n) {
      return btn("+" + (n >= 1000 ? (n / 1000) + "k" : n), function () { addExpAll(n); }, "", "Give " + n.toLocaleString() + " EXP to every party member (no EXP rate bonuses)");
    });
    var partyBody = h("div", null, [
      h("div", { cls: "ucm-btnrow", style: "padding:2px 0" }, recoverButtons()),
      h("div", { cls: "ucm-exprow", style: "padding:2px 0" }, [h("div", { cls: "ucm-f-nm", style: "margin-bottom:5px" }, ["EXP to all"]), h("div", { cls: "ucm-btnrow", style: "flex-wrap:nowrap" }, expBtns)])
    ]);
    var fixed = h("div", { cls: "ucm-fixed ucm-duo" }, [
      group({ id: "party.gold", title: "Gold", accent: "gold", body: goldBody }),
      group({ id: "party.recovery", title: "Recovery & EXP", accent: "core", body: partyBody })
    ]);

    // Items / weapons / armors list
    var kinds = [
      { key: "items", label: "Items", arr: window.$dataItems },
      { key: "weapons", label: "Weapons", arr: window.$dataWeapons },
      { key: "armors", label: "Armors", arr: window.$dataArmors }
    ].filter(function (k) { return Array.isArray(k.arr); });
    if (!kinds.length) return emptyPane("No item databases found.");
    if (!kinds.some(function (k) { return k.key === invKind; })) invKind = kinds[0].key;

    function named(k) {
      var n = 0;
      for (var i = 1; i < k.arr.length; i++) if (k.arr[i] && plain(k.arr[i].name)) n++;
      return n;
    }
    var counts = {};
    kinds.forEach(function (k) { counts[k.key] = named(k); });
    var ownedOnly = false;
    var cat;

    var kindSeg = seg(
      function () { return kinds.map(function (k) { return { key: k.key, label: k.label, count: counts[k.key] }; }); },
      function () { return invKind; },
      function (key) { invKind = key; cat.input.placeholder = "Name\u2026"; cat.reset(); }
    );
    var ownedBtn = btn("Owned", function () {
      ownedOnly = !ownedOnly;
      ownedBtn.classList.toggle("sel", ownedOnly);
      cat.reset();
    }, "", "Show only entries you own");

    cat = catalog({
      label: "Inventory",
      bar: true,
      pageSize: 40,
      placeholder: "Name\u2026",
      fields: { amount: "Amount", kind: "number", tip: AMOUNT_TIP },
      controls: [kindSeg, ownedBtn],
      empty: "Nothing matches.",
      rows: function (q, text, f) {
        var k = kinds.filter(function (x) { return x.key === invKind; })[0];
        var list = [], owned = 0, total = 0;
        for (var id = 1; id < k.arr.length; id++) {
          var obj = k.arr[id];
          if (!obj) continue;
          var name = plain(obj.name);
          if (!name) continue;
          total++;
          var have = $gameParty.numItems(obj);
          if (have > 0) owned++;
          if (!matchQuery(q, id, name)) continue;
          if (!matchId(f, id) || !matchAmount(f, have)) continue;
          var wantOwned = q.value !== undefined ? q.value : (ownedOnly ? true : undefined);
          if (wantOwned !== undefined && (have > 0) !== wantOwned) continue;
          list.push({ id: id, obj: obj, name: name, kind: k.key });
        }
        return {
          list: list, total: total, pct: total ? (owned / total) * 100 : 0,
          summary: owned + " owned  \u00b7  " + list.length + " of " + total
        };
      },
      afterRender: function () { kindSeg.__draw(); },
      row: function (item, live) {
        var obj = item.obj; // somehow the most normal out of the rest
        var glyph = h("span", { cls: "ucm-g" });
        var r;
        function paint() {
          var n = $gameParty.numItems(obj);
          glyph.textContent = n > 0 ? "\u25cf" : "\u25cb";
          glyph.className = "ucm-g " + (n > 0 ? "owned" : "missing");
        }
        var qty = bareInput(
          function () { return $gameParty.numItems(obj); },
          function (v) { $gameParty.gainItem(obj, Math.max(0, Math.floor(v)) - $gameParty.numItems(obj)); },
          56, null,
          function () { paint(); flash(r); }
        );
        // One item row: owned glyph, icon, name, description, amount
        var desc = plain(String(obj.description || "").split("\n")[0]);
        var tag = itemTag(item.kind, obj);
        r = h("div", { cls: "ucm-r inv" }, [
          glyph,
          iconEl(obj.iconIndex),
          h("div", { cls: "ucm-nb" }, [
            h("div", { cls: "ucm-nm" }, [h("span", { cls: "ucm-t", title: item.name }, [item.name]), h("span", { cls: "ucm-id" }, ["#" + item.id])]),
            desc ? h("div", { cls: "ucm-ds", title: desc }, [desc]) : null
          ]),
          tag ? h("span", { cls: "ucm-cat", title: tag }, [tag]) : h("span"),
          h("div", { cls: "ucm-ctl" }, [
            qty.el,
            btn("+1", function () { $gameParty.gainItem(obj, 1); qty.load(); paint(); flash(r); }),
            btn("Clear", function () { $gameParty.gainItem(obj, -$gameParty.numItems(obj)); qty.load(); paint(); flash(r); })
          ])
        ]);
        paint();
        live.push(function () { qty.refresh(); paint(); });
        return r;
      }
    });

    return h("div", { cls: "ucm-pane" }, [fixed, cat.node]);
  }

  // ===== Actors tab =====
  // Standard parameters 0-7
  var PARAM_ABBR = ["MHP", "MMP", "ATK", "DEF", "MAT", "MDF", "AGI", "LUK"];
  var PARAM_FALLBACK = ["Max HP", "Max MP", "Attack", "Defense", "M.Attack", "M.Defense", "Agility", "Luck"];

  // Long parameter name comes from the game's terms
  function paramTerm(i) {
    var t = window.$dataSystem && $dataSystem.terms && $dataSystem.terms.params;
    return (t && t[i]) ? plain(t[i]) : PARAM_FALLBACK[i];
  }

  // Stat modifier = the engine _paramPlus, added on top of the database stat (not the final stat)
  function paramMod(actor, i) {
    var v = actor._paramPlus && actor._paramPlus[i];
    return typeof v === "number" ? v : 0;
  }
  function setParamMod(actor, i, v) {
    if (typeof actor.addParam === "function") {
      actor.addParam(i, v - paramMod(actor, i));
    } else if (actor._paramPlus) {
      actor._paramPlus[i] = v;
      if (actor.refresh) actor.refresh();
    } else {
      throw new Error("this actor has no stat modifiers");
    }
  }

  // Character list: party members first, then the rest from the database
  function actorEntries() {
    var party = [], others = [], inParty = {};
    ($gameParty.members() || []).forEach(function (a) {
      var id = a.actorId();
      inParty[id] = true;
      party.push({ id: id, name: plain(a.name()) || "(unnamed)", party: true });
    });
    var db = window.$dataActors;
    if (Array.isArray(db)) {
      for (var id = 1; id < db.length; id++) {
        var d = db[id];
        if (!d || inParty[id]) continue;
        var live = window.$gameActors && $gameActors._data && $gameActors._data[id];
        var nm = plain(live && live.name ? live.name() : d.name);
        if (!nm) continue;
        others.push({ id: id, name: nm, party: false });
      }
    }
    return party.concat(others);
  }

  // Really learned skills (not from equipment / states)
  function isLearned(actor, id) {
    return typeof actor.isLearnedSkill === "function" ? !!actor.isLearnedSkill(id) : false;
  }
  // One character's skill list: icon + name, Learn / Forget button
  function buildSkillList(actor) {
    var skills = window.$dataSkills;
    if (!Array.isArray(skills)) return h("div", { cls: "ucm-empty" }, ["No skill database found."]);
    var learnedOnly = false, cat;
    var learnedBtn = btn("Learned", function () {
      learnedOnly = !learnedOnly;
      learnedBtn.classList.toggle("sel", learnedOnly);
      cat.reset();
    }, "", "Show only skills this character has learned");

    cat = catalog({
      label: "Skills",
      bar: true,
      pageSize: 40,
      placeholder: "Name\u2026",
      fields: { amount: "State", kind: "state", tip: "State:  on = learned   off = not learned" },
      controls: [learnedBtn],
      empty: "No skills match.",
      // Filter + count the learned ones
      rows: function (q, text, f) {
        var list = [], learned = 0, total = 0;
        for (var id = 1; id < skills.length; id++) {
          var sk = skills[id];
          if (!sk) continue;
          var name = plain(sk.name);
          if (!name) continue;
          total++;
          var known = isLearned(actor, id);
          if (known) learned++;
          if (!matchQuery(q, id, name)) continue;
          if (!matchId(f, id) || !matchAmount(f, known)) continue;
          var want = q.value !== undefined ? q.value : (learnedOnly ? true : undefined);
          if (want !== undefined && known !== want) continue;
          list.push({ id: id, obj: sk, name: name });
        }
        return {
          list: list, total: total, pct: total ? (learned / total) * 100 : 0,
          summary: learned + " learned  \u00b7  " + list.length + " of " + total
        };
      },
      // One skill row
      row: function (item, live) {
        var sk = item.obj, id = item.id, r;
        var glyph = h("span", { cls: "ucm-g" });
        var action = btn("Learn", function () {
          if (isLearned(actor, id)) {
            if (typeof actor.forgetSkill !== "function") return toast("This actor can't forget skills", "warn");
            actor.forgetSkill(id);
            toast(plain(actor.name()) + " forgot " + item.name, "ok");
          } else {
            if (typeof actor.learnSkill !== "function") return toast("This actor can't learn skills", "warn");
            actor.learnSkill(id);
            toast(plain(actor.name()) + " learned " + item.name, "ok");
          }
          paint();
          flash(r);
        });
        action.style.minWidth = "54px";
        function paint() {
          var known = isLearned(actor, id);
          // Skill from equipment / state / class (not from learning)
          var granted = !known && typeof actor.hasSkill === "function" && actor.hasSkill(id);
          glyph.textContent = (known || granted) ? "\u25cf" : "\u25cb";
          glyph.className = "ucm-g " + (known ? "owned" : granted ? "granted" : "missing");
          glyph.title = known ? "Learned" : granted ? "Available through equipment, a state or the class" : "Not learned";
          action.textContent = known ? "Forget" : "Learn";
          action.classList.toggle("danger", known);
          action.title = granted ? "Already usable through equipment/states; Learn makes it permanent" : "";
        }
        var desc = plain(String(sk.description || "").split("\n")[0]);
        var tag = plain((($dataSystem.skillTypes || [])[sk.stypeId]) || "");
        var cost = [];
        if (sk.mpCost) cost.push("MP " + sk.mpCost);
        if (sk.tpCost) cost.push("TP " + sk.tpCost);
        r = h("div", { cls: "ucm-r inv" }, [
          glyph,
          iconEl(sk.iconIndex),
          h("div", { cls: "ucm-nb" }, [
            h("div", { cls: "ucm-nm" }, [
              h("span", { cls: "ucm-t", title: item.name }, [item.name]),
              h("span", { cls: "ucm-id" }, ["#" + id]),
              cost.length ? h("span", { cls: "ucm-id" }, [cost.join(" \u00b7 ")]) : null
            ]),
            desc ? h("div", { cls: "ucm-ds", title: desc }, [desc]) : null
          ]),
          tag ? h("span", { cls: "ucm-cat", title: tag }, [tag]) : h("span"),
          h("div", { cls: "ucm-ctl" }, [action])
        ]);
        paint();
        live.push(paint);
        return r;
      }
    });
    return cat.node;
  }

  // Stat grid: MyHP MyMP MHP MMP / ATK DEF MAT MDF / AGI LUK
  function actorStatsBody(actor) {
    var fields = [
      field({
        label: "MyHP", title: "Current HP", inline: true,
        get: function () { return actor.hp; },
        set: function (v) { typeStat(actor, "hp", v); tickLive(); }
      }),
      field({
        label: "MyMP", title: "Current MP", inline: true,
        get: function () { return actor.mp; },
        set: function (v) { typeStat(actor, "mp", v); tickLive(); }
      })
    ];
    for (var i = 0; i < PARAM_ABBR.length; i++) {
      (function (i) {
        fields.push(field({
          label: PARAM_ABBR[i], title: paramTerm(i) + " modifier", inline: true,
          get: function () { return paramMod(actor, i); },
          set: function (v) { setParamMod(actor, i, Math.round(v)); tickLive(); }
        }));
      })(i);
    }

    // Modifiers aren't the final result, so show the final stats too
    var fin = h("div", { cls: "ucm-ro ucm-final" });
    function paintFinal() {
      var parts = [];
      for (var i = 0; i < PARAM_ABBR.length; i++) parts.push(PARAM_ABBR[i] + " " + actor.param(i));
      fin.textContent = "Final: " + parts.join("  \u00b7  ");
    }
    paintFinal();
    addLive(paintFinal);

    return h("div", null, [
      h("div", { cls: "ucm-note" }, ["Stat modifiers are added to database stats; they are not the final values."]),
      h("div", { cls: "ucm-stats" }, fields),
      fin
    ]);
  }

  // Pick a character first, then Stats or Skills
  function buildActorsTab() {
    if (!gameReady() || !window.$gameActors) return emptyPane(NO_GAME);
    var first = actorEntries();
    if (!first.length) return emptyPane("No actors found in the database.");
    if (!first.some(function (e) { return e.id === actorSel.id; })) actorSel.id = first[0].id;

    var sel = h("select", { cls: "ucm-select wide", title: "Character" });
    var lastSig = null;
    function refreshOptions() {
      var entries = actorEntries();
      var sig = entries.map(function (e) { return e.id + ":" + (e.party ? 1 : 0) + ":" + e.name; }).join("|");
      if (sig === lastSig) return;
      lastSig = sig;
      var party = entries.filter(function (e) { return e.party; });
      var others = entries.filter(function (e) { return !e.party; });
      function opt(e) { return h("option", { value: String(e.id) }, ["Character #" + e.id + " \u2014 " + e.name]); }
      clear(sel);
      if (party.length && others.length) {
        sel.appendChild(h("optgroup", { label: "In party" }, party.map(opt)));
        sel.appendChild(h("optgroup", { label: "Not in party" }, others.map(opt)));
      } else {
        entries.forEach(function (e) { sel.appendChild(opt(e)); });
      }
      sel.value = String(actorSel.id);
    }
    // Switch between Stats / Skills
    var viewSeg = seg(
      function () { return [{ key: "stats", label: "Stats" }, { key: "skills", label: "Skills" }]; },
      function () { return actorSel.view; },
      function (k) { actorSel.view = k; renderEditor(); }
    );
    var head = h("div", { cls: "ucm-fixed ucm-chars" }, [
      h("div", { cls: "ucm-chars-lbl" }, ["Characters:"]), sel,
      h("div", { style: "margin-top:6px" }, [viewSeg])
    ]);

    // Panel content: stats (scroll) or the skill list
    var holder = h("div", { cls: "ucm-pane" });
    var scroll = h("div", { cls: "ucm-scroll" });
    function renderEditor() {
      liveFns.length = 0;
      addLive(refreshOptions);
      clear(holder);
      var actor = $gameActors.actor(actorSel.id);
      if (!actor) {
        holder.appendChild(h("div", { cls: "ucm-empty" }, ["Actor #" + actorSel.id + " isn't available."]));
        return;
      }
      if (actorSel.view === "skills") {
        holder.appendChild(buildSkillList(actor));
        return;
      }
      clear(scroll);
      holder.appendChild(scroll);

      scroll.appendChild(group({
        id: "actor.stats", title: "Stats", accent: "core",
        count: function () { return "HP " + actor.hp + "/" + actor.mhp + "  \u00b7  MP " + actor.mp + "/" + actor.mmp; },
        body: actorStatsBody(actor)
      }));

      var prog = [
        field({
          label: "Level", get: function () { return actor.level; },
          suffix: function () { return actor.maxLevel ? "/ " + actor.maxLevel() : ""; },
          set: function (v) { if (v > 0 && actor.changeLevel) actor.changeLevel(Math.floor(v), false); }
        })
      ];
      // EXP
      var hasExp = typeof actor.changeExp === "function" && typeof actor.currentExp === "function";
      if (hasExp) {
        prog.push(field({
          label: "EXP", title: "Total experience in the current class",
          get: function () { return actor.currentExp(); },
          suffix: function () {
            if (actor.isMaxLevel && actor.isMaxLevel()) return "max level";
            return actor.nextRequiredExp ? "next Lv in " + actor.nextRequiredExp() : "";
          },
          set: function (v) { actor.changeExp(Math.max(0, Math.floor(v)), false); }
        }));
      }
      // TP
      var hasTp = typeof actor.tp === "number";
      if (hasTp) {
        prog.push(field({
          label: "TP", get: function () { return actor.tp; },
          suffix: function () {
            return (actor.maxTp ? "/ " + actor.maxTp() : "") + (hasOwnLock(actor, "tp") ? "  \u00b7  locked" : "");
          },
          set: function (v) { typeStat(actor, "tp", v); }
        }));
      }
      scroll.appendChild(group({
        id: "actor.progress", title: hasTp ? "Level, EXP & TP" : "Level & EXP", accent: "core",
        count: function () { return "Lv " + actor.level; },
        body: h("div", { cls: "ucm-fields" }, prog)
      }));

      // Locks for this character (type a new value in the field to change the locked number)
      var lockKinds = hasTp ? LOCK_KINDS : ["hp", "mp"];
      scroll.appendChild(group({
        id: "actor.locks", title: "Locks", accent: "core",
        count: function () {
          var on = lockKinds.filter(function (k) { return hasOwnLock(actor, k); }).map(function (k) { return k.toUpperCase(); });
          return on.length ? on.join(" + ") : "off";
        },
        body: h("div", { cls: "ucm-fields c3" }, lockKinds.map(function (k) { return ownLockPill(actor, k); }))
      }));
    }

    sel.addEventListener("change", function () {
      actorSel.id = Number(sel.value);
      renderEditor();
    });

    refreshOptions();
    renderEditor();
    return h("div", { cls: "ucm-pane" }, [head, holder]);
  }

  // ===== Switches tab =====
  function buildSwitchesTab() {
    if (!gameReady()) return emptyPane(NO_GAME);
    var n = switchCount(), mode = "all", counts = { all: n, on: 0, off: 0 }, cat;
    var filter = seg(
      function () { return [{ key: "all", label: "All", count: counts.all }, { key: "on", label: "On", count: counts.on }, { key: "off", label: "Off", count: counts.off }]; },
      function () { return mode; },
      function (k) { mode = k; cat.reset(); }
    );
    cat = catalog({
      label: "Switches", pageSize: 40, placeholder: "Name\u2026",
      fields: { amount: "State", kind: "state", tip: STATE_TIP },
      controls: [filter],
      afterRender: function () { filter.__draw(); },
      // All / On / Off filter + count the ones that are on
      rows: function (q, text, f) {
        var list = [], on = 0;
        for (var i = 1; i <= n; i++) {
          var v = !!$gameSwitches.value(i);
          if (v) on++;
          var nm = switchName(i);
          if (!matchQuery(q, i, nm)) continue;
          if (!matchId(f, i) || !matchAmount(f, v)) continue;
          var want = q.value !== undefined ? q.value : (mode === "on" ? true : mode === "off" ? false : undefined);
          if (want !== undefined && v !== want) continue;
          list.push({ id: i, name: nm });
        }
        counts.on = on; counts.off = n - on;
        return { list: list, total: n, summary: on + " on  \u00b7  " + list.length + " of " + n };
      },
      row: function (item, live) {
        var id = item.id;
        // One row: id, name, state, checkbox
        var cb = h("input", { type: "checkbox" });
        var st = h("span", { cls: "ucm-sw-st" });
        function paint() {
          var v = !!$gameSwitches.value(id);
          cb.checked = v;
          st.textContent = v ? "ON" : "OFF";
          st.className = "ucm-sw-st " + (v ? "on" : "off");
        }
        function setv(v) { $gameSwitches.setValue(id, v); paint(); }
        cb.addEventListener("change", function () { setv(cb.checked); });
        var r = h("div", { cls: "ucm-r sw click" }, [
          h("span", { cls: "ucm-rid" }, ["#" + id]),
          h("span", { cls: "ucm-t", title: item.name }, [item.name]),
          st, cb
        ]);
        r.addEventListener("click", function (e) { if (e.target !== cb) setv(!$gameSwitches.value(id)); });
        paint();
        live.push(paint);
        return r;
      }
    });
    return h("div", { cls: "ucm-pane" }, [cat.node]);
  }

  // ===== Variables tab =====
  function buildVariablesTab() {
    if (!gameReady()) return emptyPane(NO_GAME);
    var n = variableCount(), mode = "all", counts = { all: n, nz: 0 }, cat;
    // Empty / zero count as the same
    function isZero(v) { return v === 0 || v === "" || v == null; }
    var filter = seg(
      function () { return [{ key: "all", label: "All", count: counts.all }, { key: "nz", label: "Non-zero", count: counts.nz }]; },
      function () { return mode; },
      function (k) { mode = k; cat.reset(); }
    );
    cat = catalog({
      label: "Variables", pageSize: 40, placeholder: "Name\u2026",
      fields: { amount: "Amount", kind: "number", tip: AMOUNT_TIP },
      controls: [filter],
      afterRender: function () { filter.__draw(); },
      rows: function (q, text, f) {
        var list = [], nz = 0;
        for (var i = 1; i <= n; i++) {
          var v = $gameVariables.value(i);
          if (!isZero(v)) nz++;
          var nm = variableName(i);
          if (!matchQuery(q, i, nm)) continue;
          if (!matchId(f, i) || !matchAmount(f, v)) continue;
          if (mode === "nz" && isZero(v)) continue;
          list.push({ id: i, name: nm });
        }
        counts.nz = nz;
        return { list: list, total: n, summary: nz + " non-zero  \u00b7  " + list.length + " of " + n };
      },
      row: function (item, live) {
        var id = item.id;
        var ed = bareInput(
          function () { return $gameVariables.value(id); },
          function (v) { $gameVariables.setValue(id, v); },
          100,
          function (t, cur) {
            if (typeof cur === "string") return { ok: true, value: t };
            var num = Number(String(t).replace(/,/g, "").trim());
            return (String(t).trim() === "" || !isFinite(num)) ? { ok: false } : { ok: true, value: num };
          },
          function () { flash(r); }
        );
        var cur = $gameVariables.value(id);
        if (cur !== null && typeof cur === "object") { ed.el.readOnly = true; ed.el.title = "Object value (read-only)"; }
        var r = h("div", { cls: "ucm-r vr" }, [
          h("span", { cls: "ucm-rid" }, ["#" + id]),
          h("span", { cls: "ucm-t", title: item.name }, [item.name]),
          ed.el
        ]);
        live.push(function () { ed.refresh(); });
        return r;
      }
    });
    return h("div", { cls: "ucm-pane" }, [cat.node]);
  }

  // ===== Database tab =====
  // Flatten the object into a field list (2 levels max)
  function flattenFields(obj, prefix, depth, out) {
    if (depth > 2) return out;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var val = obj[k];
      var path = prefix ? prefix + "." + k : k;
      var t = typeof val;
      if (val === null) {
        out.push({ path: path, type: "null", value: null });
      } else if (t === "number" || t === "string" || t === "boolean") {
        out.push({ path: path, type: t, value: val });
      } else if (Array.isArray(val)) {
        var allPrim = val.every(function (x) { return x === null || typeof x !== "object"; });
        out.push({ path: path, type: allPrim ? "json" : "detail", value: val });
      } else if (t === "object") {
        flattenFields(val, path, depth + 1, out);
      }
    }
    return out;
  }
  // Read & write a field using a path (a.b.c)
  function getByPath(obj, path) {
    var parts = path.split("."), cur = obj;
    for (var i = 0; i < parts.length; i++) cur = cur[parts[i]];
    return cur;
  }
  function setByPath(obj, path, value) {
    var parts = path.split("."), cur = obj;
    for (var i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
  }

  // Popup layer (JSON detail, command palette)
  function closeLayer() {
    clear(layer);
    layer.style.display = "none";
    if (win && panelOpen) win.focus();
  }
  function openLayer(card, onBackdrop) {
    clear(layer);
    var back = h("div", { cls: "ucm-layer" });
    back.addEventListener("click", function () { (onBackdrop || closeLayer)(); });
    card.addEventListener("click", function (e) { e.stopPropagation(); });
    back.appendChild(card);
    layer.appendChild(back);
    layer.style.display = "block";
  }
  // Popup with the full JSON
  function showDetail(label, value) {
    var card = h("div", { cls: "ucm-card detail", tabindex: "-1" }, [
      h("div", { cls: "ucm-dhead" }, [h("span", { title: label }, [label]), btn("Close", closeLayer)]),
      h("pre", null, [JSON.stringify(value, null, 2)])
    ]);
    card.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); closeLayer(); } });
    openLayer(card);
    card.focus();
  }

  // Edit $data* table fields directly (Actors, Skills, Items, etc)
  function buildDatabaseTab() {
    var tables = dataTables();
    var names = Object.keys(tables);
    if (!names.length) return emptyPane("No $data* tables found.");
    if (!dbState.table || !tables[dbState.table]) dbState.table = names[0];

    var pane = h("div", { cls: "ucm-pane" });
    var sel = h("select", { cls: "ucm-select", title: "Table" }, names.map(function (nm) { return h("option", { value: nm }, [nm]); }));
    sel.value = dbState.table;

    function showList() {
      liveFns.length = 0;
      dbState.id = null;
      clear(pane);
      var cat;
      cat = catalog({
        label: "Database", pageSize: 40, placeholder: "Search " + dbState.table.toLowerCase() + "\u2026  (name, #id, 10-20)",
        controls: [sel],
        rows: function (q) {
          var arr = tables[dbState.table], list = [], total = 0;
          for (var id = 1; id < arr.length; id++) {
            var obj = arr[id];
            if (!obj) continue;
            total++;
            var nm = plain(obj.name || "");
            if (!matchQuery(q, id, nm)) continue;
            list.push({ id: id, name: nm });
          }
          return { list: list, total: total, summary: list.length + " of " + total + " entries" };
        },
        onEnter: function (item) { showDetail2(item.id); },
        row: function (item) {
          var r = h("div", { cls: "ucm-r db click" }, [
            h("span", { cls: "ucm-rid" }, ["#" + item.id]),
            h("span", { cls: "ucm-t", title: item.name }, [item.name || "(unnamed)"]),
            h("span", { cls: "ucm-id" }, ["\u203a"])
          ]);
          r.addEventListener("click", function () { showDetail2(item.id); });
          return r;
        }
      });
      sel.onchange = function () {
        dbState.table = sel.value;
        cat.input.placeholder = "Search " + dbState.table.toLowerCase() + "\u2026  (name, #id, 10-20)";
        cat.reset();
      };
      pane.appendChild(cat.node);
    }

    function neighbour(arr, id, dir) {
      for (var i = id + dir; i > 0 && i < arr.length; i += dir) if (arr[i]) return i;
      return null;
    }

    function showDetail2(id) {
      var arr = tables[dbState.table], obj = arr[id];
      if (!obj) return toast("No entry #" + id + " in " + dbState.table, "warn");
      liveFns.length = 0;
      dbState.id = id;
      clear(pane);
      var prev = neighbour(arr, id, -1), next = neighbour(arr, id, 1);
      var nm = plain(obj.name || "");
      var prevBtn = btn("\u2039", function () { showDetail2(prev); }, "", "Previous entry");
      var nextBtn = btn("\u203a", function () { showDetail2(next); }, "", "Next entry");
      prevBtn.disabled = prev == null;
      nextBtn.disabled = next == null;
      var top = h("div", { cls: "ucm-cb-top" }, [h("div", { cls: "ucm-cb-hdr" }, [
        btn("\u2039 Back", showList),
        h("span", { cls: "ucm-lbl" }, [dbState.table]),
        h("span", { cls: "ucm-id" }, ["#" + id]),
        h("span", { cls: "ucm-t", style: "font-weight:500" }, [nm]),
        h("span", { cls: "ucm-sp" }), prevBtn, nextBtn
      ])]);

      var fields = flattenFields(obj, "", 0, []);
      var scalars = [], lists = [];
      fields.forEach(function (f) {
        var label = f.path;
        if (f.type === "number") {
          scalars.push(field({ label: label, get: function () { return getByPath(obj, f.path); }, set: function (v) { setByPath(obj, f.path, v); } }));
        } else if (f.type === "boolean") {
          scalars.push(h("div", { cls: "ucm-f" }, [check(label, function () { return getByPath(obj, f.path); }, function (v) { setByPath(obj, f.path, v); })]));
        } else if (f.type === "string") {
          var long = f.value.length > 30 || f.value.indexOf("\n") !== -1;
          scalars.push(field({
            label: label, type: "text", full: long, multiline: f.value.indexOf("\n") !== -1,
            get: function () { return getByPath(obj, f.path); }, set: function (v) { setByPath(obj, f.path, v); }
          }));
        } else if (f.type === "null") {
          scalars.push(field({ label: label, type: "text", readOnly: true, get: function () { return "null"; }, set: function () {} }));
        } else if (f.type === "json") {
          lists.push(field({
            label: label, type: "json", full: true,
            get: function () { return getByPath(obj, f.path); }, set: function (v) { setByPath(obj, f.path, v); }
          }));
        } else {
          lists.push(h("div", { cls: "ucm-f" }, [
            h("div", { cls: "ucm-f-top" }, [h("span", { cls: "ucm-f-nm", title: label }, [label])]),
            btn("Detail (" + f.value.length + ")", function () { showDetail(dbState.table + "[" + id + "]." + f.path, getByPath(obj, f.path)); })
          ]));
        }
      });

      var scroll = h("div", { cls: "ucm-scroll" });
      if (scalars.length) scroll.appendChild(group({ id: "db.fields", title: "Fields", accent: "extras", count: String(scalars.length), body: h("div", { cls: "ucm-fields c3" }, scalars) }));
      if (lists.length) scroll.appendChild(group({ id: "db.lists", title: "Lists", accent: "core", count: String(lists.length), body: h("div", { cls: "ucm-fields c3" }, lists) }));
      if (!scalars.length && !lists.length) scroll.appendChild(h("div", { cls: "ucm-empty" }, ["This entry has no editable fields."]));
      pane.appendChild(top);
      pane.appendChild(scroll);
      scroll.insertBefore(h("div", { cls: "ucm-empty", style: "padding:2px 0 6px;text-align:left" }, ["Edits apply live to the in-memory database for this session; they are not written to the project files."]), scroll.firstChild);
    }

    if (dbState.id && tables[dbState.table][dbState.id]) showDetail2(dbState.id); else showList();
    return pane;
  }

  // ===== Tab list =====
  // "words" is used for the panel search
  var TABS = [
    { key: "cheats", label: "Cheats", build: buildCheatsTab, words: "godmode god encounters clip noclip speed battle victory defeat escape toggles lock hp mp tp enemies allies recover heal" },
    { key: "party", label: "Party", build: buildPartyTab, words: "gold money items weapons armors inventory equipment" },
    { key: "actors", label: "Actors", build: buildActorsTab, words: "level hp mp tp skills learn forget characters stats modifiers params mhp mmp atk def mat mdf agi luk" },
    { key: "switches", label: "Switches", build: buildSwitchesTab, words: "flags story progress" },
    { key: "variables", label: "Variables", build: buildVariablesTab, words: "numbers counters values" },
    { key: "database", label: "Database", build: buildDatabaseTab, words: "data actors classes skills enemies states troops edit" }
  ];

  // Switch tab, content gets rebuilt
  function selectTab(key) {
    var def = TABS.filter(function (t) { return t.key === key; })[0] || TABS[0];
    state.tab = def.key;
    persist();
    liveFns = [];
    clear(body);
    if (pageTitle) pageTitle.textContent = def.label;
    Array.prototype.forEach.call(rail.querySelectorAll(".ucm-tab"), function (t) {
      t.classList.toggle("on", t.getAttribute("data-key") === def.key);
    });
    var pane;
    try {
      pane = def.build();
    } catch (e) {
      console.error("[CheatMenu] failed to build " + def.key, e);
      pane = emptyPane("Couldn't build this panel: " + e.message);
    }
    body.appendChild(pane);
  }

  // ===== Translation =====
  // Shows game text (names, descriptions, categories) in another language so you can read it.
  // Uses Google's free translate endpoint, so it needs internet. Results are cached in localStorage.
  // Only text that comes from the game is touched, the menu's own labels stay as they are.
  var TR_CACHE_KEY = "ucm:trcache1";
  var TR_LANGS = [
    ["en", "English"], ["id", "Indonesian"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
    ["pt", "Portuguese"], ["it", "Italian"], ["ru", "Russian"], ["tr", "Turkish"], ["ar", "Arabic"],
    ["ja", "Japanese"], ["ko", "Korean"], ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"]
  ];
  // Elements whose text comes from the game
  var TR_SEL = '.ucm-t,.ucm-ds,.ucm-cat,select[title="Character"] option';
  var Tr = (function () {
    var cfg = state.tr;
    var cache = {};
    try { cache = JSON.parse(window.localStorage.getItem(TR_CACHE_KEY)) || {}; } catch (e) { cache = {}; }
    var meta = new WeakMap();           // text node -> { orig, shown, lang }
    var waiting = {}, queue = [], active = 0;
    var blockedUntil = 0, warned = false, retryTimer = null, saveTimer = null;
    var root0 = null, observer = null, listeners = [];
    // "Character #3 — Name": only the name part gets translated
    var PREFIX = /^(Character #\d+ \u2014 )([\s\S]+)$/;

    function bucket(lang) { return cache[lang] || (cache[lang] = {}); }
    function saveSoon() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        try {
          var n = 0;
          for (var l in cache) for (var k in cache[l]) n++;
          if (n > 6000) cache = {};   // keep it from growing forever
          window.localStorage.setItem(TR_CACHE_KEY, JSON.stringify(cache));
        } catch (e) {}
      }, 1200);
    }

    // Is this text worth translating (skip numbers, symbols, and plain English when translating to English)
    function needs(body) {
      if (!/\S/.test(body) || body.length > 1200) return false;
      if (/^[\s\d.,:;!?#%+\-\u2013\u2014\/\\()\[\]{}<>*_=~'"]*$/.test(body)) return false;
      if (cfg.lang === "en" && /^[\x00-\x7F]*$/.test(body)) return false;
      return true;
    }

    // One request to the translate endpoint
    function fetchOne(text, lang, cb) {
      var x = new XMLHttpRequest();
      x.open("GET", "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=" +
        encodeURIComponent(lang) + "&q=" + encodeURIComponent(text));
      x.timeout = 8000;
      x.onload = function () {
        if (x.status !== 200) return cb(new Error("HTTP " + x.status));
        try {
          var d = JSON.parse(x.responseText);
          var out = (d[0] || []).map(function (s) { return (s && s[0]) || ""; }).join("");
          cb(null, out || text);
        } catch (e) { cb(e); }
      };
      x.onerror = x.ontimeout = function () { cb(new Error("network")); };
      x.send();
    }

    function fail() {
      blockedUntil = Date.now() + 20000;
      queue.forEach(function (k) { delete waiting[k]; });
      queue.length = 0;
      if (!warned) {
        warned = true;
        toast("Translation failed \u2014 check your internet connection (retrying shortly)", "warn");
      }
      clearTimeout(retryTimer);
      retryTimer = setTimeout(function () { warned = false; if (cfg.on) refreshAll(); }, 20500);
    }

    // Up to 3 requests at the same time
    function pump() {
      while (active < 3 && queue.length) {
        (function (key) {
          var job = waiting[key];
          if (!job) return;
          active++;
          fetchOne(job.body, job.lang, function (err, out) {
            active--;
            delete waiting[key];
            if (err) {
              fail();
            } else {
              bucket(job.lang)[job.body] = out;
              saveSoon();
              job.cbs.forEach(function (f) { try { f(); } catch (e) {} });
            }
            pump();
          });
        })(queue.shift());
      }
    }
    function request(body, cb) {
      var key = cfg.lang + "\u0001" + body;
      if (waiting[key]) { waiting[key].cbs.push(cb); return; }
      if (Date.now() < blockedUntil) return;
      waiting[key] = { body: body, lang: cfg.lang, cbs: [cb] };
      queue.push(key);
      pump();
    }

    function untitle(el) {
      if (el.__ucmT) { el.removeAttribute("title"); el.__ucmT = false; }
    }
    function show(node, el, orig, shown) {
      if (shown === orig) { untitle(el); return; }
      meta.set(node, { orig: orig, shown: shown, lang: cfg.lang });
      node.data = shown;
      // The original text stays available on hover
      if (!el.getAttribute("title")) { el.setAttribute("title", orig); el.__ucmT = true; }
    }

    // Translate (or restore) one text node
    function handle(node) {
      var el = node.parentNode;
      if (!el || el.nodeType !== 1 || !el.matches(TR_SEL)) return;
      var m = meta.get(node), orig = node.data;
      if (m) {
        if (node.data === m.shown) {
          if (cfg.on && m.lang === cfg.lang) return;   // already showing the right thing
          orig = m.orig;
        }
        meta.delete(node);
      }
      var pm = PREFIX.exec(orig);
      var pre = pm ? pm[1] : "", body = pm ? pm[2] : orig;
      if (!cfg.on || !needs(body)) {
        if (node.data !== orig) node.data = orig;
        untitle(el);
        return;
      }
      var hit = bucket(cfg.lang)[body];
      if (hit !== undefined) {
        show(node, el, orig, pre + hit);
      } else {
        if (node.data !== orig) node.data = orig;
        request(body, function () { if (node.parentNode && cfg.on) handle(node); });
      }
    }
    function scanEls(list) {
      for (var i = 0; i < list.length; i++) {
        for (var c = list[i].firstChild; c; c = c.nextSibling) if (c.nodeType === 3) handle(c);
      }
    }
    function scan(node) {
      if (node.nodeType === 3) return handle(node);
      if (node.nodeType !== 1) return;
      var list = [];
      if (node.matches(TR_SEL)) list.push(node);
      Array.prototype.push.apply(list, node.querySelectorAll(TR_SEL));
      scanEls(list);
    }
    function refreshAll() {
      if (root0) scanEls(root0.querySelectorAll(TR_SEL));
    }

    // Watch the menu so new rows get translated as they are drawn
    function attach(r) {
      root0 = r;
      if (typeof MutationObserver !== "function") return;
      observer = new MutationObserver(function (recs) {
        if (!cfg.on) return;
        for (var i = 0; i < recs.length; i++) {
          try {
            if (recs[i].type === "characterData") handle(recs[i].target);
            else for (var j = 0; j < recs[i].addedNodes.length; j++) scan(recs[i].addedNodes[j]);
          } catch (e) {}
        }
      });
      observer.observe(r, { childList: true, subtree: true, characterData: true });
      if (cfg.on) refreshAll();
    }

    function changed() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }
    function setOn(v) { cfg.on = !!v; persist(); refreshAll(); changed(); }
    function setLang(l) { cfg.lang = l; persist(); refreshAll(); changed(); }
    function clearCache() {
      cache = {};
      try { window.localStorage.removeItem(TR_CACHE_KEY); } catch (e) {}
      if (cfg.on) refreshAll();
    }
    // Translated text if we already have it (used by search)
    function cached(name) {
      if (!cfg.on) return "";
      var b = cache[cfg.lang];
      return (b && b[name]) || "";
    }

    UCM.translate = {
      on: function () { setOn(true); },
      off: function () { setOn(false); },
      lang: setLang
    };
    return {
      cfg: cfg, attach: attach, setOn: setOn, setLang: setLang, clearCache: clearCache, cached: cached,
      onChange: function (f) { listeners.push(f); }
    };
  })();

  // Small popup with the translation settings
  function openTranslateDialog() {
    var on = h("input", { type: "checkbox" });
    on.checked = !!state.tr.on;
    on.addEventListener("change", function () {
      Tr.setOn(on.checked);
      toast("Translation \u2192 " + (on.checked ? "on" : "off"), "ok");
    });
    var sel = h("select", { cls: "ucm-select", title: "Translate into" }, TR_LANGS.map(function (l) {
      return h("option", { value: l[0] }, [l[1]]);
    }));
    sel.value = state.tr.lang;
    sel.addEventListener("change", function () { Tr.setLang(sel.value); });
    var card = h("div", { cls: "ucm-card detail", tabindex: "-1" }, [
      h("div", { cls: "ucm-dhead" }, [h("span", null, ["Translation"]), btn("Close", closeLayer)]),
      h("label", { cls: "ucm-chk" }, [on, "Translate game text"]),
      h("div", { style: "margin:12px 0 4px" }, [h("div", { cls: "ucm-f-nm", style: "margin-bottom:5px" }, ["Translate into"]), sel]),
      h("div", { cls: "ucm-note", style: "margin-top:12px" }, [
        "Translates names and descriptions that come from the game (items, skills, actors, enemies\u2026) with Google Translate, so it needs an internet connection. " +
        "Hover over a translated line to see the original. Searching also matches translated names. " +
        "When translating into English, text that is already plain English is skipped."
      ]),
      btn("Clear saved translations", function () { Tr.clearCache(); toast("Saved translations cleared", "ok"); })
    ]);
    card.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); closeLayer(); } });
    openLayer(card);
    card.focus();
  }

  // ===== Command palette (Ctrl+K) =====
  function getCommands() {
    var c = [];
    function tg(label, key) {
      c.push({ group: "Toggle", label: label, run: function () { UCM[key] = !UCM[key]; toast(label + ": " + (UCM[key] ? "on" : "off"), "ok"); tickLive(); } });
    }
    tg("Godmode", "godmode"); tg("No Encounters", "noEncounters"); tg("No Clip", "noClip");
    [1, 2, 4, 8].forEach(function (s) {
      c.push({ group: "Speed", label: "Game speed \u00d7" + s, run: function () { UCM.speed = s; toast("Game speed \u2192 \u00d7" + s, "ok"); tickLive(); } });
    });
    LOCK_KINDS.forEach(function (k) {
      var name = k.toUpperCase();
      c.push({ group: "Toggle", label: name + " lock (whole party)", run: function () {
        UCM.locks[k].all = !UCM.locks[k].all;
        if (UCM.locks[k].all && gameReady()) applyLocks(k);
        toast(name + " lock: " + (UCM.locks[k].all ? "on" : "off"), "ok");
        tickLive();
      } });
    });
    c.push({ group: "Party", label: "Max HP (whole party)", run: function () { recoverParty("hp"); } });
    c.push({ group: "Party", label: "Max MP (whole party)", run: function () { recoverParty("mp"); } });
    c.push({ group: "Battle", label: "Force Victory", run: battle.victory });
    c.push({ group: "Battle", label: "Force Defeat", run: battle.defeat });
    c.push({ group: "Battle", label: "Force Escape", run: battle.escape });
    c.push({ group: "Battle", label: "Heal All Enemies", run: battle.healEnemies });
    c.push({ group: "Battle", label: "Kill All Enemies", run: battle.killEnemies });
    c.push({ group: "Translate", label: "Toggle translation", run: function () { Tr.setOn(!state.tr.on); toast("Translation \u2192 " + (state.tr.on ? "on (" + state.tr.lang + ")" : "off"), "ok"); } });
    c.push({ group: "Translate", label: "Translation settings\u2026", run: openTranslateDialog });
    TABS.forEach(function (t) { c.push({ group: "Go to", label: "Open " + t.label, run: function () { selectTab(t.key); } }); });
    return c;
  }

  function openPalette() {
    if (!built || !panelOpen) return;
    var cmds = getCommands(), matches = [];
    var input = h("input", { type: "text", cls: "ucm-pal-in", placeholder: "Search commands\u2026", spellcheck: "false" });
    var list = h("ul", { cls: "ucm-pal-list" });
    function run(cmd) { closeLayer(); cmd.run(); }
    function draw() {
      clear(list);
      var q = input.value.toLowerCase().trim();
      matches = cmds.filter(function (x) { return (x.label + " " + x.group).toLowerCase().indexOf(q) !== -1; });
      if (!matches.length) list.appendChild(h("li", { cls: "none" }, [q ? "No matching commands" : "No commands available"]));
      matches.forEach(function (cmd, i) {
        var li = h("li", { cls: i === 0 ? "first" : "" }, [h("span", null, [cmd.label]), h("span", { cls: "ucm-pal-grp" }, [cmd.group])]);
        li.addEventListener("click", function () { run(cmd); });
        list.appendChild(li);
      });
    }
    input.addEventListener("input", draw);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.stopPropagation(); closeLayer(); }
      else if (e.key === "Enter" && matches[0]) { e.preventDefault(); run(matches[0]); }
    });
    var card = h("div", { cls: "ucm-card pal" }, [input, list]);
    openLayer(card);
    draw();
    input.focus();
  }

  // Panel search in the tab bar
  function setupRailSearch() {
    railInput = h("input", { type: "text", placeholder: "Search panels\u2026", title: "Search panels\u2026", spellcheck: "false" });
    railResults = h("ul", { cls: "ucm-results" });
    railResults.style.display = "none";
    var box = h("div", { cls: "ucm-rsearch" }, [railInput, railResults]);
    var hits = [];
    function hide() { railResults.style.display = "none"; }
    function pick(t) { railInput.value = ""; hide(); selectTab(t.key); }
    function draw() {
      var q = railInput.value.toLowerCase().trim();
      if (!q) return hide();
      hits = TABS.filter(function (t) { return (t.label + " " + t.words).toLowerCase().indexOf(q) !== -1; });
      clear(railResults);
      if (!hits.length) railResults.appendChild(h("li", { cls: "none" }, ["No matching panels"]));
      hits.forEach(function (t, i) {
        var li = h("li", { cls: i === 0 ? "first" : "" }, [t.label]);
        li.addEventListener("mousedown", function (e) { e.preventDefault(); pick(t); });
        railResults.appendChild(li);
      });
      railResults.style.display = "block";
    }
    railInput.addEventListener("input", draw);
    railInput.addEventListener("blur", hide);
    railInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.stopPropagation(); railInput.value = ""; hide(); }
      else if (e.key === "Enter" && hits[0]) { e.preventDefault(); pick(hits[0]); }
    });
    return box;
  }

  // ===== Main window =====
  function applyGeo() {
    win.style.left = state.geo.x + "px";
    win.style.top = state.geo.y + "px";
    win.style.width = state.geo.width + "px";
    win.style.height = state.geo.height + "px";
  }

  // Window is built once when it first opens (Shadow DOM so the game's CSS doesn't clash)
  function buildShell() {
    host = h("div", { id: "ucm-host" });
    root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var wrap = h("div", { cls: "ucm-root" });
    root.appendChild(h("style", null, [CSS]));
    root.appendChild(wrap);

    // Window position
    var vp = viewport();
    state.geo = clampGeo(state.geo || defaultGeo(vp), vp); // i couldn't get enough of `the whole blue world`, prolly the best one other than `a song of romance` and `god's blood`

    // Drag handlers shared by the brand and the header
    var dragCb = {
      ignore: function (e) { return !!(e.target.closest && e.target.closest("button,input,ul")); },
      move: function (dx, dy) {
        state.geo = clampGeo({ x: state.geo.x + dx, y: state.geo.y + dy, width: state.geo.width, height: state.geo.height }, viewport());
        applyGeo();
      },
      end: function () { state.geo = snapGeo(state.geo, viewport()); applyGeo(); persist(); }
    };

    // Sidebar: brand + tabs + version
    var brand = h("div", { cls: "ucm-brand" }, [h("b", null, ["CheatMenu"]), h("i", null, [VER_SHORT + " \u00b7 by Alfa"])]);
    bindDrag(brand, dragCb);
    rail = h("div", { cls: "ucm-rail" });
    TABS.forEach(function (t) {
      var tab = h("div", { cls: "ucm-tab", "data-key": t.key }, [t.label]);
      tab.addEventListener("click", function () { selectTab(t.key); });
      rail.appendChild(tab);
    });
    var side = h("div", { cls: "ucm-side" }, [brand, rail, h("div", { cls: "ucm-ver" }, ["CM " + VER_SHORT])]);

    // Header: page title, panel search, close button (drag to move the window)
    pageTitle = h("h1", { cls: "ucm-ptitle" }, [""]);
    var closeBtn = btn("\u00d7", function () { togglePanel(false); }, "ucm-x", "Close (Esc)");
    closeBtn.className = "ucm-x";
    var trBtn = btn("A\u6587", openTranslateDialog, "ucm-tr", "Translate game text");
    var syncTr = function () { trBtn.classList.toggle("sel", !!state.tr.on); trBtn.title = "Translate game text (" + (state.tr.on ? "on, " + state.tr.lang : "off") + ")"; };
    Tr.onChange(syncTr);
    syncTr();
    titleBar = h("div", { cls: "ucm-head" }, [pageTitle, setupRailSearch(), trBtn, closeBtn]);
    bindDrag(titleBar, dragCb);

    body = h("div", { cls: "ucm-body" });
    statusEl = h("span", { cls: "ucm-st" }, [DEFAULT_HINT]);
    var foot = h("div", { cls: "ucm-foot" }, [statusEl]);
    var main = h("div", { cls: "ucm-main" }, [titleBar, body, foot]);

    // Resize handles: right edge, bottom edge and bottom right corner
    function resizer(cls, ax, ay) {
      var el = h("div", { cls: cls, title: "Drag to resize" });
      bindDrag(el, {
        move: function (dx, dy) {
          var v = viewport();
          state.geo = {
            x: state.geo.x, y: state.geo.y,
            width: ax ? Math.max(560, Math.min(state.geo.width + dx, v.width - state.geo.x)) : state.geo.width,
            height: ay ? Math.max(340, Math.min(state.geo.height + dy, v.height - state.geo.y)) : state.geo.height
          };
          applyGeo();
        },
        end: function () { persist(); }
      });
      return el;
    }

    // Put everything together
    win = h("div", { cls: "ucm-win", tabindex: "-1", "data-testid": "float-panel" }, [side, main, resizer("ucm-edge r", true, false), resizer("ucm-edge b", false, true), resizer("ucm-grip", true, true)]);
    win.style.display = "none";
    applyGeo();
    win.addEventListener("keydown", function (e) { if (e.key === "Escape") togglePanel(false); });

    layer = h("div", null);
    layer.style.display = "none";

    wrap.appendChild(win);
    wrap.appendChild(layer);

    // Events inside the menu shouldn't leak into the game
    ["keydown", "keyup", "keypress", "mousedown", "mouseup", "click", "dblclick", "wheel", "touchstart", "touchend", "touchmove", "contextmenu"]
      .forEach(function (ev) { host.addEventListener(ev, function (e) { e.stopPropagation(); }); });

    document.body.appendChild(host);
    built = true;
    Tr.attach(root);

    // Window follows when the screen size changes
    window.addEventListener("resize", function () {
      var v = viewport();
      state.geo = clampGeo(state.geo, v);
      applyGeo();
    });
    // Refresh every 0.4 sec
    setInterval(function () { if (panelOpen) tickLive(); }, 400);
  }

  // Open / close the menu
  function togglePanel(force) {
    if (!built) buildShell();
    panelOpen = typeof force === "boolean" ? force : !panelOpen;
    win.style.display = panelOpen ? "flex" : "none";
    if (panelOpen) {
      selectTab(state.tab);
      win.focus();
    } else {
      closeLayer();
    }
  }

  // Control from outside ($ucm.ui)
  UCM.ui = {
    open: function () { togglePanel(true); },
    close: function () { togglePanel(false); },
    toggle: function () { togglePanel(); },
    select: function (key) { if (!panelOpen) togglePanel(true); selectTab(key); },
    resetLayout: function () {
      state.geo = defaultGeo(viewport());
      if (built) { applyGeo(); }
      persist();
    }
  };

  // Hotkey: F9 opens/closes, Ctrl+K opens the command palette
  window.addEventListener("keydown", function (e) {
    if (e.code === TOGGLE_KEY) {
      if (!e.repeat) togglePanel();
    } else if (panelOpen && (e.ctrlKey || e.metaKey) && e.code === "KeyK") {
      e.preventDefault();
      e.stopPropagation();
      openPalette();
    }
  }, true);

  
  console.log("[CheatMenu] loaded. Press " + TOGGLE_KEY + " to open.");
})();