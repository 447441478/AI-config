(function () {
  "use strict";
  var ROOT = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  var GLOBAL_KEY = "__DragonNestGuessAuto";
  if (ROOT[GLOBAL_KEY] && ROOT[GLOBAL_KEY].initialized) return;
  var CONFIG = {
    intervalMs: 12000,
    requestGapMs: 350,
    maxPageRequests: 50,
    submit: true,
    claimRewards: true,
    scheduleIds: []
  };
  var state = {
    initialized: true,
    running: false,
    busy: false,
    timer: null,
    lastRunAt: 0,
    lastMessage: "等待执行",
    lastSummary: null,
    button: null,
    status: null
  };
  ROOT[GLOBAL_KEY] = state;

  function log(message, level) {
    var prefix = "[DragonNestGuessAuto] ";
    if (level === "error") console.error(prefix + message);
    else if (level === "warn") console.warn(prefix + message);
    else console.log(prefix + message);
    state.lastMessage = message;
    updateUi();
  }

  function requireModule(name) {
    try {
      return typeof ROOT.__require === "function" ? ROOT.__require(name) : null;
    } catch (error) {
      return null;
    }
  }

  function getApexModule() {
    var manager = requireModule("ModuleManager");
    var configs = requireModule("Configs");
    if (!manager || !configs || !configs.ModuleType) return null;
    try {
      return manager.GET_MODULE(configs.ModuleType.APEX);
    } catch (error) {
      return null;
    }
  }

  function getMapValue(mapLike, key) {
    if (!mapLike) return undefined;
    try {
      if (typeof mapLike.get === "function") return mapLike.get(key);
    } catch (error) {}
    if (Object.prototype.hasOwnProperty.call(mapLike, key)) return mapLike[key];
    var textKey = String(key);
    if (Object.prototype.hasOwnProperty.call(mapLike, textKey)) return mapLike[textKey];
    return undefined;
  }

  function hasTeamInGuessMap(guessMap, scheduleId, teamId) {
    var guessed = getMapValue(guessMap, scheduleId);
    if (!guessed) return false;
    if (Array.isArray(guessed)) return guessed.map(String).indexOf(String(teamId)) >= 0;
    if (typeof guessed.has === "function") return guessed.has(teamId) || guessed.has(String(teamId));
    return false;
  }

  function getStatusEnum() {
    var types = requireModule("types-apex");
    return types && types.EApexScheduleStatus ? types.EApexScheduleStatus : {};
  }

  function getKnockoutStageValues(configs) {
    var stages = configs && configs.ApexStage;
    if (!stages) return [];
    return ["TAOTAI_64", "TAOTAI_32", "TAOTAI_16", "TAOTAI_8", "TAOTAI_4", "TAOTAI_3", "TAOTAI_2"]
      .map(function (name) { return stages[name]; })
      .filter(function (value) { return value !== undefined && value !== null; });
  }

  function getCurrentScheduleConfigs(apex) {
    var scheduleData = apex && apex.apexScheduleData;
    var configs = requireModule("Configs");
    if (!scheduleData || !Array.isArray(scheduleData.currentRoundConf)) return [];
    var stageValues = getKnockoutStageValues(configs);
    var statusEnum = getStatusEnum();
    var none = statusEnum.None;
    return scheduleData.currentRoundConf.filter(function (item) {
      if (!item || item.id === undefined) return false;
      if (stageValues.length && stageValues.indexOf(item.ApexStage) < 0) return false;
      if (CONFIG.scheduleIds.length && CONFIG.scheduleIds.indexOf(Number(item.id)) < 0) return false;
      var status;
      try { status = scheduleData.getScheduleStatus(item.id); } catch (error) { status = undefined; }
      if (status === undefined || status === null) return false;
      return status !== none;
    });
  }

  async function sendGameCommand(cmd, params) {
    if (!ROOT.ws || typeof ROOT.ws.sendAsync !== "function") {
      throw new Error("游戏 WebSocket 尚未就绪");
    }
    var response = await ROOT.ws.sendAsync({
      ack: 0,
      cmd: cmd,
      params: params || {},
      seq: Date.now(),
      time: Date.now()
    });
    var raw = response && (response._rawData || response.rawData || response.data || response);
    var code = raw && raw.code;
    if (code !== undefined && code !== null && code !== 0 && code !== "0") {
      throw new Error(cmd + " 返回错误码 " + code);
    }
    return response;
  }

  async function loadGuessList(apex, scheduleId) {
    var guessData = apex && apex.guessData;
    if (guessData && typeof guessData.resetGuessList === "function" && typeof guessData.sendGetGuessList === "function") {
      guessData.resetGuessList(scheduleId);
      var data;
      var previousLength = -1;
      for (var page = 0; page < CONFIG.maxPageRequests; page++) {
        data = guessData.getGuessList(scheduleId);
        if (data && data.last) break;
        var ok = await guessData.sendGetGuessList(scheduleId);
        if (!ok) throw new Error("读取竞猜列表失败，scheduleId=" + scheduleId);
        data = guessData.getGuessList(scheduleId);
        var currentLength = data && Array.isArray(data.apexGuessList) ? data.apexGuessList.length : 0;
        if (currentLength === previousLength) break;
        previousLength = currentLength;
        if (data && data.last) break;
      }
      data = guessData.getGuessList(scheduleId);
      return data && Array.isArray(data.apexGuessList) ? data.apexGuessList : [];
    }
    throw new Error("ApexGuessData 不可用，请先打开一次龙巢之怒竞猜界面");
  }

  async function refreshRoleInfo(apex) {
    if (apex && typeof apex.sendGetRoleInfo === "function") {
      var refreshed = await apex.sendGetRoleInfo();
      if (refreshed === false) throw new Error("读取角色竞猜记录失败");
    }
    var serverData = requireModule("ServerData");
    return serverData && serverData.SERVER_DATA && serverData.SERVER_DATA.apexRoleInfo
      ? serverData.SERVER_DATA.apexRoleInfo
      : null;
  }

  async function submitGuess(apex, teamId) {
    if (apex && apex.guessData && typeof apex.guessData.sendGuess === "function") {
      var ok = await apex.guessData.sendGuess(teamId);
      if (!ok) throw new Error("竞猜提交失败，teamId=" + teamId);
      return;
    }
    await sendGameCommand("apex_guess", { teamId: teamId });
  }

  function getTeamCount(team) {
    if (!team) return NaN;
    var value = Number(team.cheerCnt);
    return Number.isFinite(value) ? value : NaN;
  }

  function isWinningTeam(team) {
    return !!team && (team.isWin === true || team.isWin === 1 || team.isWin === "1");
  }

  function hasWinFlag(team) {
    return !!team && (
      team.isWin === true || team.isWin === false ||
      team.isWin === 1 || team.isWin === 0 ||
      team.isWin === "1" || team.isWin === "0"
    );
  }

  function isBattleResolved(pair) {
    if (!Array.isArray(pair) || pair.length < 2) return false;
    if (!hasWinFlag(pair[0]) || !hasWinFlag(pair[1])) return false;
    var leftWin = isWinningTeam(pair[0]);
    var rightWin = isWinningTeam(pair[1]);
    return leftWin !== rightWin;
  }

  async function claimRewardIfAvailable(apex, scheduleId, pair, guessMap, guessClaimMap, summary) {
    if (!CONFIG.claimRewards || !Array.isArray(pair) || pair.length < 2) return;
    if (!isBattleResolved(pair)) return;
    var guessedTeam = null;
    if (hasTeamInGuessMap(guessMap, scheduleId, pair[0].teamId)) guessedTeam = pair[0];
    else if (hasTeamInGuessMap(guessMap, scheduleId, pair[1].teamId)) guessedTeam = pair[1];
    if (!guessedTeam || !isWinningTeam(guessedTeam)) return;
    var claimByTeam = getMapValue(guessClaimMap, scheduleId);
    var claimed = getMapValue(claimByTeam, guessedTeam.teamId);
    if (claimed === true || claimed === 1 || claimed === "1") return;
    if (!apex.guessData || typeof apex.guessData.sendGuessClaim !== "function") {
      summary.errors.push("竞猜奖励接口不可用");
      return;
    }
    var ok = await apex.guessData.sendGuessClaim(scheduleId, guessedTeam.teamId);
    if (ok) {
      summary.claimed++;
      log("已领取竞猜奖励：" + (guessedTeam.name || guessedTeam.teamId));
    }
  }

  async function runOnce(options) {
    if (state.busy) return state.lastSummary;
    options = options || {};
    var submitEnabled = options.claimOnly ? false : CONFIG.submit;
    state.busy = true;
    state.lastRunAt = Date.now();
    updateUi();
    var summary = { schedules: 0, matches: 0, submitted: 0, claimed: 0, skipped: 0, errors: [] };
    try {
      var apex = getApexModule();
      if (!apex) throw new Error("Apex 模块未加载，请先进入龙巢之怒页面");
      var roleInfo = await refreshRoleInfo(apex);
      var guessMap = roleInfo && roleInfo.guessMap;
      var guessClaimMap = roleInfo && roleInfo.guessClaimMap;
      var schedules = getCurrentScheduleConfigs(apex);
      if (!schedules.length) throw new Error("当前没有可处理的淘汰赛轮次");
      for (var s = 0; s < schedules.length; s++) {
        var scheduleId = Number(schedules[s].id);
        summary.schedules++;
        var pairs = await loadGuessList(apex, scheduleId);
        var statusEnum = getStatusEnum();
        var status = apex.apexScheduleData.getScheduleStatus(schedules[s].id);
        var canGuess = status !== statusEnum.Fighting && status !== statusEnum.Completed;
        for (var i = 0; i < pairs.length; i++) {
          var pair = pairs[i];
          if (!Array.isArray(pair) || pair.length < 2) { summary.skipped++; continue; }
          var left = pair[0];
          var right = pair[1];
          if (!left || !right || !left.teamId || !right.teamId) { summary.skipped++; continue; }
          summary.matches++;
          await claimRewardIfAvailable(apex, scheduleId, pair, guessMap, guessClaimMap, summary);
          if (!canGuess) { summary.skipped++; continue; }
          if (hasTeamInGuessMap(guessMap, scheduleId, left.teamId) || hasTeamInGuessMap(guessMap, scheduleId, right.teamId)) {
            summary.skipped++;
            continue;
          }
          var leftCount = getTeamCount(left);
          var rightCount = getTeamCount(right);
          if (!Number.isFinite(leftCount) || !Number.isFinite(rightCount) || leftCount === rightCount) {
            summary.skipped++;
            continue;
          }
          var selected = leftCount > rightCount ? left : right;
          log("schedule " + scheduleId + " 选择 " + selected.name + " (" + selected.cheerCnt + "票)");
          if (submitEnabled) {
            await submitGuess(apex, selected.teamId);
            summary.submitted++;
            if (guessMap) {
              var current = getMapValue(guessMap, scheduleId);
              if (Array.isArray(current)) current.push(selected.teamId);
            }
            await new Promise(function (resolve) { setTimeout(resolve, CONFIG.requestGapMs); });
          }
        }
      }
      state.lastSummary = summary;
      log("完成：轮次 " + summary.schedules + "，对局 " + summary.matches + "，提交 " + summary.submitted + "，领取 " + summary.claimed + "，跳过 " + summary.skipped);
      return summary;
    } catch (error) {
      summary.errors.push(String(error && error.message || error));
      state.lastSummary = summary;
      log(summary.errors[0], "error");
      return summary;
    } finally {
      state.busy = false;
      updateUi();
    }
  }

  function claimRewardsOnce() {
    return runOnce({ claimOnly: true });
  }

  function start() {
    if (state.running) return;
    state.running = true;
    log("已启动自动轮询");
    runOnce();
    state.timer = setInterval(function () { runOnce(); }, CONFIG.intervalMs);
    updateUi();
  }

  function stop() {
    state.running = false;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    log("已停止自动轮询");
    updateUi();
  }

  function updateUi() {
    if (!state.button) return;
    state.button.textContent = state.running ? (state.busy ? "竞猜处理中" : "停止自动竞猜") : "启动自动竞猜";
    if (state.status) state.status.textContent = state.lastMessage || "";
  }

  function installUi() {
    if (typeof document === "undefined" || document.getElementById("dragon-nest-guess-auto")) return;
    var box = document.createElement("div");
    box.id = "dragon-nest-guess-auto";
    box.style.cssText = "position:fixed;z-index:2147483647;right:14px;bottom:86px;width:190px;padding:8px;background:rgba(20,20,20,.88);color:#fff;font:12px Arial,sans-serif;border:1px solid #666;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none;";

    // 最小化按钮
    var minimizeBtn = document.createElement("button");
    minimizeBtn.type = "button";
    minimizeBtn.textContent = "−";
    minimizeBtn.style.cssText = "position:absolute;top:2px;right:4px;width:20px;height:20px;padding:0;color:#fff;background:#555;border:none;border-radius:3px;cursor:pointer;font-size:14px;line-height:20px;text-align:center;";
    box.appendChild(minimizeBtn);

    // 迷你状态显示标签
    var miniLabel = document.createElement("div");
    miniLabel.textContent = "竞猜";
    miniLabel.style.cssText = "display:none;width:100%;height:40px;line-height:40px;text-align:center;color:#fff;font-size:12px;cursor:pointer;";
    box.appendChild(miniLabel);

    var button = document.createElement("button");
    button.type = "button";
    button.style.cssText = "width:100%;height:28px;color:#fff;background:#3c7d3c;border:1px solid #8fbd8f;border-radius:3px;cursor:pointer";
    button.onclick = function () { state.running ? stop() : start(); };
    var once = document.createElement("button");
    once.type = "button";
    once.textContent = "只执行一次";
    once.style.cssText = "width:100%;height:24px;margin-top:5px;color:#ddd;background:#444;border:1px solid #777;border-radius:3px;cursor:pointer";
    once.onclick = function () { runOnce(); };
    var claim = document.createElement("button");
    claim.type = "button";
    claim.textContent = "领取竞猜奖励";
    claim.style.cssText = "width:100%;height:24px;margin-top:5px;color:#ffe6a3;background:#5a4824;border:1px solid #a88b4b;border-radius:3px;cursor:pointer";
    claim.onclick = function () { claimRewardsOnce(); };
    var status = document.createElement("div");
    status.style.cssText = "margin-top:5px;line-height:16px;word-break:break-all;color:#ccc";
    box.appendChild(button);
    box.appendChild(once);
    box.appendChild(claim);
    box.appendChild(status);
    document.body.appendChild(box);
    state.button = button;
    state.status = status;

    // ========== 拖动功能 ==========
    var isDragging = false;
    var offsetX = 0;
    var offsetY = 0;

    box.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON") return;
      isDragging = true;
      var rect = box.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      box.style.left = rect.left + "px";
      box.style.top = rect.top + "px";
      box.style.right = "auto";
      box.style.bottom = "auto";
      e.preventDefault();
    });

    document.addEventListener("mousemove", function (e) {
      if (!isDragging) return;
      var left = e.clientX - offsetX;
      var top = e.clientY - offsetY;
      var boxWidth = box.offsetWidth;
      var boxHeight = box.offsetHeight;
      left = Math.max(0, Math.min(window.innerWidth - boxWidth, left));
      top = Math.max(0, Math.min(window.innerHeight - boxHeight, top));
      box.style.left = left + "px";
      box.style.top = top + "px";
    });

    document.addEventListener("mouseup", function () {
      isDragging = false;
    });

    window.addEventListener("resize", function () {
      var rect = box.getBoundingClientRect();
      var left = rect.left;
      var top = rect.top;
      var boxWidth = box.offsetWidth;
      var boxHeight = box.offsetHeight;
      left = Math.max(0, Math.min(window.innerWidth - boxWidth, left));
      top = Math.max(0, Math.min(window.innerHeight - boxHeight, top));
      box.style.left = left + "px";
      box.style.top = top + "px";
    });

    // ========== 最小化功能 ==========
    var isMinimized = false;
    var mainElements = [button, once, claim, status];

    function toggleMinimize() {
      isMinimized = !isMinimized;
      if (isMinimized) {
        mainElements.forEach(function (el) { el.style.display = "none"; });
        miniLabel.style.display = "block";
        minimizeBtn.textContent = "□";
        box.style.width = "40px";
        box.style.padding = "4px";
      } else {
        mainElements.forEach(function (el) { el.style.display = ""; });
        miniLabel.style.display = "none";
        minimizeBtn.textContent = "−";
        box.style.width = "190px";
        box.style.padding = "8px";
      }
    }

    minimizeBtn.onclick = function (e) {
      e.stopPropagation();
      toggleMinimize();
    };

    miniLabel.onclick = function () {
      toggleMinimize();
    };

    updateUi();
  }

  ROOT[GLOBAL_KEY].runOnce = runOnce;
  ROOT[GLOBAL_KEY].claimRewardsOnce = claimRewardsOnce;
  ROOT[GLOBAL_KEY].start = start;
  ROOT[GLOBAL_KEY].stop = stop;
  ROOT[GLOBAL_KEY].config = CONFIG;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installUi);
    else installUi();
  }
})();
