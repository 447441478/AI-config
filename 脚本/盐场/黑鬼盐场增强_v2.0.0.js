/*
 * 黑鬼盐场增强_v2.0.0_清晰源码.js (HeiGuiSaltEnhancer)
 * 
 * 基于盐场伟大航路玩法，采用现代化分层架构彻底重构反混淆。
 * 代码结构清晰、职责边界分明、易读性高，兼具工业级健壮性。
 * 
 * 模块架构索引：
 * ============================================================================
 * 1. CONFIG & DICTS          基础配置、武将字典、阵型正则与离线特征库
 * 2. STATE                   统一运行时状态管理树
 * 3. GAME ADAPTER & UTILS    底层游戏反射、通用工具与日志
 * 4. PLAYER & BATTLEFIELD    玩家属性深度解析、行军/战场数据模型与状态判定
 * 5. AVATAR & FORMATION      离线图像特征识别算法、队伍解析与阵型判定
 * 6. UI & FAIRYGUI TOOLS     FairyGUI 节点创建、自绘矢量按钮、样式排版与倒计时 HUD
 * 7. TROOP SORTING           部队列表排序核心（战力/精力/到达时间/无损还原）
 * 8. AUTO DIG                自动刨地模块（自适应空间排版，彻底杜绝窄屏右侧裁剪）
 * 9. LOCK & COMBAT ENGINE    锁头核心攻击调度机（队列管理、折返跑防护、失败重试）
 * 10. PROTOTYPE HOOKS        游戏原型链注入（部队列表页与建筑面板拦截）
 * 11. RANKING ALLY INTEGRATION 俱乐部排行榜盟友配置交互体系
 * 12. LIFECYCLE & EXPORT     生命周期监控、原生自动攻击保护与全局对外 API 导出
 * ============================================================================
 */
(function () {
  'use strict';

  /* ============================================================================
   * 1. CONFIG & DICTS (基础配置、武将字典、阵型正则与离线特征库)
   * ============================================================================ */
  var GLOBAL_KEY = 'HeiGuiSaltEnhancer';
  var VERSION = '20260924-v2.0.0';

  // 图像特征比对算法参数
  var AVATAR_SIGNATURE_WIDTH = 8;
  var AVATAR_SIGNATURE_HEIGHT = 5;
  var AVATAR_DISTANCE_THRESHOLD = 1.5;
  var AVATAR_MARGIN_THRESHOLD = 0.5;
  var TEAM_CACHE_TTL_MS = 0; // 0 表示战斗期间缓存持久有效
  var CACHE_LIMIT = 1200;

  // 清理已有实例，防止重复挂载
  if (window['SaltQueueEnhancer'] && typeof window['SaltQueueEnhancer'].destroy === 'function') {
    window['SaltQueueEnhancer'].destroy();
  }
  if (window[GLOBAL_KEY] && typeof window[GLOBAL_KEY].destroy === 'function') {
    window[GLOBAL_KEY].destroy();
  }

  var HERO_NAME_BY_ID = {
    101: '司马懿',
    102: '郭嘉',
    103: '关羽',
    104: '诸葛亮',
    105: '周瑜',
    106: '太史慈',
    107: '吕布',
    108: '华佗',
    109: '甄姬',
    110: "黄月英",
    111: '孙策',
    112: '贾诩',
    113: '曹仁',
    114: '姜维',
    115: '孙坚',
    116: '公孙瓒',
    117: '典韦',
    118: '赵云',
    119: '大乔',
    120: '张角',
    201: '徐晃',
    202: '荀彧',
    203: '小典韦',
    204: '张飞',
    205: '小赵云',
    206: '庞统',
    207: '鲁肃',
    208: '陆逊',
    209: '甘宁',
    210: '貂蝉',
    211: '董卓',
    212: '小张角',
    213: '张辽',
    214: "夏侯惇",
    215: '许褚',
    216: '夏侯渊',
    217: '魏延',
    218: '黄忠',
    219: '马超',
    220: '马岱',
    221: '吕蒙',
    222: '黄盖',
    223: "蔡文姬",
    224: '小乔',
    225: '袁绍',
    226: '华雄',
    227: '颜良',
    228: '文丑',
    301: '周泰',
    302: '许攸',
    303: '于禁',
    304: "张星彩",
    305: "关银屏",
    306: '关平',
    307: '程普',
    308: '张昭',
    309: '陆绩',
    310: '吕玲绮',
    311: '潘凤',
    312: "邢道荣",
    313: '祝融夫人',
    314: '孟获',
    300: '刘备'
  },
    FORMATION_PATTERNS = [{
      'label': '三蜀',
      'heroes': ['诸葛亮',
        '黄月英',
        '赵云']
    },
    {
      'label': '合力',
      'heroes': ['吕布',
        '赵云']
    },
    {
      'label': '吴国',
      'heroes': ['周瑜',
        '孙策']
    },
    {
      'label': '毒爆',
      'heroes': ['张角',
        '华佗']
    },
    {
      'label': '关羽',
      'heroes': ['关羽']
    },
    {
      'label': '姜维',
      'heroes': ['姜维']
    },
    {
      'label': '典韦',
      'heroes': ['典韦']
    },
    {
      'label': '司马',
      'heroes': ['司马懿']
    },
    {
      'label': '吕布',
      'heroes': ['吕布']
    }
    ],
    EMBEDDED_AVATAR_SIGNATURES = [];
  var avatarSignatureTemplates = [];

  /* ============================================================================
   * 2. STATE (统一运行时状态管理树)
   * ============================================================================ */
  var state = {
    // 注入记录与列表 DOM 缓存
    patched: [],
    items: [],
    sortBars: [],

    // 队伍与阵型识别缓存
    teamCache: new Map(),
    formationCache: new Map(),
    pending: new Map(),
    requestCooldown: new Map(),
    imagePending: new Map(),
    activeRequests: new Set(),
    requestChain: Promise.resolve(),
    formationCacheHits: 0,
    formationRecognitionRuns: 0,

    // 定时器句柄
    retryTimer: 0,
    lockTimer: 0,
    marchTickTimer: 0,

    // 锁头核心队列
    lockedTarget: null,
    lockQueue: [],
    lastLockActionAt: 0,

    // 行军加速
    autoSpeedUp: false,
    speedUpMarchId: 0,
    speedUpRequestedAt: 0,

    // 自动刨地
    autoDig: false,
    autoDigControls: [],
    lastBuildingAttackAt: 0,
    lastBuildingAttackId: '',

    // 原生自动攻击状态备份（锁头退出时精准还原）
    userAutoAttack: null,

    // HUD 倒计时
    countdownText: null,
    countdownLastSecond: -1,

    // 列表排序状态
    sortMode: 'power',
    sortOrder: 'desc',
    isSorting: false,
    btnResourceURL: '',

    // 残将自定义猎杀阈值 (默认 <= 4人未满编)
    weakHeroLimit: 4,
    lastActiveBuilding: null,
    dashboardVisible: false,

    // 盟友俱乐部管理与白名单存储
    alliedLegions: {
      ids: [],
      names: []
    },

    destroyed: false
  };

  /* ============================================================================
   * 2.0 AUTO SPEED UP STORAGE & CONTROLLER (金砖自动加速配置与控制器)
   * ============================================================================ */
  var AUTO_SPEED_UP_STORAGE_KEY = 'SALT_AUTO_SPEED_UP';
  var WEAK_HERO_LIMIT_STORAGE_KEY = 'SALT_WEAK_HERO_LIMIT';
  var FLOAT_POS_STORAGE_KEY = 'SALT_FLOAT_BALL_POS';

  function loadWeakHeroLimit() {
    try {
      var val = Number(localStorage.getItem(WEAK_HERO_LIMIT_STORAGE_KEY));
      if (val >= 1 && val <= 4) return val;
    } catch (e) {}
    return 4; // 默认 <= 4 人 (未满编)
  }

  function setWeakHeroLimit(limit) {
    limit = Math.max(1, Math.min(4, Number(limit) || 4));
    state.weakHeroLimit = limit;
    try {
      localStorage.setItem(WEAK_HERO_LIMIT_STORAGE_KEY, String(limit));
    } catch (e) {}
    updateControlPanelUI();
    refreshLockControls();
    logInfo('残将判定阈值设为: ≤ ' + limit + ' 人');
    showCountdownMessage('残将判定阈值已设为: ≤ ' + limit + '人', -1);
    return limit;
  }

  function getPlayerHeroCount(player) {
    if (!player) return 5;
    var cached = getCachedTeamSummary(player);
    if (cached) {
      if (typeof cached.alive === 'number' && cached.alive > 0) {
        return Math.min(cached.alive, (cached.heroNames && cached.heroNames.length) || cached.alive);
      }
      if (Array.isArray(cached.heroNames) && cached.heroNames.length > 0) {
        return cached.heroNames.length;
      }
    }
    var heroes = extractPlayerHeroes(player);
    if (Array.isArray(heroes) && heroes.length > 0) {
      return heroes.length;
    }
    return 5;
  }

  function isWeakTroop(player) {
    if (!player || isSelfPlayer(player) || isAlliedPlayer(player)) return false;
    var count = getPlayerHeroCount(player);
    var limit = Number(state.weakHeroLimit) || 4;
    return count > 0 && count <= limit;
  }

  function loadAutoSpeedUpConfig() {
    try {
      var raw = localStorage.getItem(AUTO_SPEED_UP_STORAGE_KEY);
      if (raw !== null) return raw === 'true' || raw === '1';
    } catch (e) {}
    return false; // 默认安全关闭，杜绝自动扣金砖
  }

  function setAutoSpeedUp(enable) {
    state.autoSpeedUp = !!enable;
    try {
      localStorage.setItem(AUTO_SPEED_UP_STORAGE_KEY, String(state.autoSpeedUp));
    } catch (e) {}
    updateAllSortBars();
    updateControlPanelUI();
    logInfo('自动行军金砖加速:', state.autoSpeedUp ? '【开启】' : '【关闭】');
    showCountdownMessage('行军金砖加速: ' + (state.autoSpeedUp ? '【开启】' : '【关闭】'), -1);
    return state.autoSpeedUp;
  }

  function toggleAutoSpeedUp() {
    return setAutoSpeedUp(!state.autoSpeedUp);
  }

  function updateAllSortBars() {
    if (Array.isArray(state.sortBars)) {
      state.sortBars.forEach(function (bar) {
        if (!bar || !bar.root || bar.root.isDisposed || bar.root._disposed) return;
        if (bar.speedUp) {
          setNativeSortButtonActive(bar.speedUp, !!state.autoSpeedUp);
          if (bar.speedUp.__sfaLabel) {
            bar.speedUp.__sfaLabel.text = state.autoSpeedUp ? '⚡加速' : '⚡常规';
            bar.speedUp.__sfaLabel.color = state.autoSpeedUp ? '#79ff4d' : '#fff4df';
          }
          var colorCtrl = bar.speedUp.m_color || (typeof bar.speedUp.getController === 'function' && bar.speedUp.getController('color'));
          if (colorCtrl) {
            try { colorCtrl.selectedPage = state.autoSpeedUp ? 'green' : 'yellow'; } catch (e) {}
          }
        }
      });
    }
  }

/* ============================================================================
   * 2.1 ALLIED LEGION STORAGE & ENGINE (盟友与阵营管理子系统)
   * ============================================================================ */
  var ALLIED_LEGIONS_STORAGE_KEY = 'SALT_ALLIED_LEGIONS_CONFIG';

  function getTodayDateKey() {
    var now = new Date();
    try {
      var Global = window.Global || (window.cc && window.cc.Global);
      if (Global && Global.serverTime) {
        var st = Number(Global.serverTime);
        if (st > 0) now = new Date(st > 1e11 ? st : st * 1000);
      }
    } catch (e) {}
    var y = now.getFullYear();
    var m = ('0' + (now.getMonth() + 1)).slice(-2);
    var d = ('0' + now.getDate()).slice(-2);
    return y + '-' + m + '-' + d;
  }

  function loadAlliedLegions() {
    var today = getTodayDateKey();
    try {
      var raw = localStorage.getItem(ALLIED_LEGIONS_STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        // 每日自动轮换失效：若存储的日期不是今天，则视作昨日战局自动过期并重置清空，杜绝跨天误判
        if (parsed && parsed.date && parsed.date !== today) {
          logInfo('检测到盟友配置跨天 (原日期:' + parsed.date + '，今日:' + today + ')，自动重置清空昨日盟友。');
          state.alliedLegions = { date: today, ids: [], names: [] };
          saveAlliedLegions();
          return;
        }
        state.alliedLegions = {
          date: today,
          ids: Array.isArray(parsed.ids) ? parsed.ids : [],
          names: Array.isArray(parsed.names) ? parsed.names : []
        };
        logInfo('已加载今日盟友俱乐部配置 [' + today + ']:', state.alliedLegions.names.join(',') || '暂无');
        return;
      }
    } catch (e) {}
    state.alliedLegions = { date: today, ids: [], names: [] };
  }

  function saveAlliedLegions() {
    try {
      var today = getTodayDateKey();
      if (!state.alliedLegions) state.alliedLegions = { ids: [], names: [] };
      state.alliedLegions.date = today;
      localStorage.setItem(ALLIED_LEGIONS_STORAGE_KEY, JSON.stringify(state.alliedLegions));
    } catch (e) {}
  }

  function clearAlliedLegions() {
    var today = getTodayDateKey();
    state.alliedLegions = { date: today, ids: [], names: [] };
    saveAlliedLegions();
    refreshAllTroopsOverlay();
    logInfo('已清空今日全部盟友俱乐部配置。');
    showCountdownMessage('已清空全部盟友', -1);
  }

  function checkAlliedLegionsDayChange() {
    var today = getTodayDateKey();
    if (state.alliedLegions && state.alliedLegions.date && state.alliedLegions.date !== today) {
      logInfo('心跳检测到跨天 (' + state.alliedLegions.date + ' -> ' + today + ')，自动轮换重置盟友配置。');
      loadAlliedLegions();
    state.autoSpeedUp = loadAutoSpeedUpConfig();
      refreshAllTroopsOverlay();
    }
  }

  function cleanLegionName(name) {
    if (!name) return '';
    return String(name).replace(/^\[\d+\]/, '').replace(/^【(?:盟|敌|本部|自家)】/, '').trim();
  }

  function isAlliedLegion(legionId, legionName) {
    if (!state.alliedLegions) return false;
    var numId = Number(legionId) || 0;
    if (numId && state.alliedLegions.ids.indexOf(numId) >= 0) return true;
    var name = cleanLegionName(legionName);
    if (name) {
      for (var i = 0; i < state.alliedLegions.names.length; i++) {
        var n = cleanLegionName(state.alliedLegions.names[i]);
        if (n && (name.indexOf(n) >= 0 || n.indexOf(name) >= 0)) return true;
      }
    }
    return false;
  }

  function toggleAlliedLegion(legionId, legionName) {
    checkAlliedLegionsDayChange();
    var numId = Number(legionId) || 0;
    var name = cleanLegionName(legionName);
    var isAlly = isAlliedLegion(numId, name);

    if (isAlly) {
      if (numId) {
        state.alliedLegions.ids = state.alliedLegions.ids.filter(function (x) { return Number(x) !== numId; });
      }
      if (name) {
        state.alliedLegions.names = state.alliedLegions.names.filter(function (x) { return cleanLegionName(x) !== name; });
      }
      logInfo('解除盟友俱乐部:', name || numId);
      showCountdownMessage('已解除盟友【' + (name || numId) + '】', -1);
    } else {
      if (numId && state.alliedLegions.ids.indexOf(numId) < 0) {
        state.alliedLegions.ids.push(numId);
      }
      if (name && state.alliedLegions.names.indexOf(name) < 0) {
        state.alliedLegions.names.push(name);
      }
      logInfo('标记盟友俱乐部:', name || numId);
      showCountdownMessage('已结盟俱乐部【' + (name || numId) + '】', -1);
    }
    saveAlliedLegions();
    refreshAllTroopsOverlay();
  }

  function isAlliedPlayer(player) {
    if (!player) return false;
    if (isSameLegionTarget(player)) return true;
    var legionId = player.legionId;
    var bf = getBattlefield();
    var legion = bf && bf._legions && (bf._legions.get(legionId) || bf._legions.get(Number(legionId)) || bf._legions.get(String(legionId)));
    var legionName = (legion && (legion.name || legion.codeName || legion.intro)) || player.legionName || '';
    return isAlliedLegion(legionId, legionName);
  }

  function refreshAllTroopsOverlay() {
    if (Array.isArray(state.items)) {
      state.items.forEach(function (it) {
        if (!it || it.isDisposed || it._disposed || !it.parent) return;
        if (it.__saltQueuePlayer) {
          refreshItem(it, it.__saltQueuePlayer);
        }
      });
    }
    if (Array.isArray(state.sortBars)) {
      state.sortBars.forEach(function (bar) {
        if (bar && bar.__sfaPage) requestSortTroopsList(bar.__sfaPage);
      });
    }
  }

  loadAlliedLegions();
  state.autoSpeedUp = loadAutoSpeedUpConfig();
  state.weakHeroLimit = loadWeakHeroLimit();

  /* ============================================================================
   * 3. GAME ADAPTER & UTILS (底层游戏反射、通用工具与日志)
   * ============================================================================ */

  function hasGameRequire() {
    return typeof window.__require === 'function';
  }

  function gameRequire(moduleName) {
    return window.__require(moduleName);
  }

  function getFgui() {
    if (typeof fgui !== 'undefined') return fgui;
    return window.fgui || null;
  }

  function getLegionWarModule() {
    if (!hasGameRequire()) return null;
    try {
      var Configs = gameRequire('Configs');
      var ModuleManager = gameRequire('ModuleManager');
      if (!Configs || !ModuleManager || typeof ModuleManager.GET_MODULE !== 'function') return null;
      return ModuleManager.GET_MODULE(Configs.ModuleType.LEGION_WAR);
    } catch (e) {
      return null;
    }
  }

  function getBattlefield() {
    var mod = getLegionWarModule();
    if (!mod) return null;
    return mod.battlefield || mod._battlefield || (mod.data && mod.data.battlefield) || null;
  }

  function getBattlefieldId() {
    var mod = getLegionWarModule();
    var bf = getBattlefield();
    if (!mod) return 'unknown';
    return String(mod.battlefieldId || mod._battlefieldId || (bf && bf.id) || (mod.data && mod.data.battlefieldId) || 'unknown');
  }

  function getServerTimeNow() {
    try {
      var DateUtil = gameRequire('DateUtil');
      var utilModule = DateUtil && (DateUtil.default || DateUtil);
      var serverTime = utilModule && Number(utilModule.serverTime);
      if (isFinite(serverTime) && serverTime > 0) return serverTime;
    } catch (e) {}
    return Date.now();
  }

  // 时间戳毫秒归一化（自动兼容 10 位秒级与 13 位毫秒级时间戳）
  function normalizeTimestamp(ts) {
    var num = Number(ts) || 0;
    if (num > 0 && num < 100000000000) return num * 1000;
    return num;
  }

  function normalizeBattleTimestamp(ts) {
    var num = Number(ts) || 0;
    return num > 0 && num < 100000000000 ? num * 1000 : num;
  }

  function normalizePngDataUrl(url) {
    if (!url) return '';
    return String(url).replace(/^data:image\/png;base64,/, '');
  }

  function safeGetProperty(target, key) {
    if (!target) return null;
    if (typeof target.get === 'function') {
      if (!target.has || target.has(key)) return target.get(key);
      if (target.has(String(key))) return target.get(String(key));
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
    if (Object.prototype.hasOwnProperty.call(target, String(key))) return target[String(key)];
    return null;
  }

  function iterateCollection(col, callback) {
    if (!col || typeof callback !== 'function') return;
    if (typeof col.forEach === 'function') {
      col.forEach(callback);
      return;
    }
    if (typeof col === 'object') {
      Object.keys(col).forEach(function (k) {
        callback(col[k], k);
      });
    }
  }

  function shallowCopy(obj) {
    var copy = {};
    if (!obj || typeof obj !== 'object') return copy;
    Object.keys(obj).forEach(function (k) {
      copy[k] = obj[k];
    });
    return copy;
  }

  function firstPositiveNumber(numArray) {
    for (var i = 0; i < numArray.length; i++) {
      var n = Number(numArray[i]);
      if (isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  function copyPosition(pos) {
    return pos && isFinite(Number(pos.x)) && isFinite(Number(pos.y)) ? {
      x: Number(pos.x),
      y: Number(pos.y)
    } : null;
  }

  function samePosition(posA, posB) {
    return !!(posA && posB && Number(posA.x) === Number(posB.x) && Number(posA.y) === Number(posB.y));
  }

  function logInfo() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[黑鬼盐场增强]');
    console.log.apply(console, args);
  }

  function logWarn() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[SaltQueueLocker]');
    console.warn.apply(console, args);
  }

  function clearRecognitionCaches() {
    state.teamCache.clear();
    state.formationCache.clear();
    state.imagePending.clear();
    state.requestCooldown.clear();
  }

  /* ============================================================================
   * 4. PLAYER & BATTLEFIELD (玩家属性深度解析、行军/战场数据模型与状态判定)
   * ============================================================================ */

  function getServerData(player) {
    if (!player) return null;
    try {
      return player._serverData || player.serverData || null;
    } catch (e) {
      return null;
    }
  }

  function getRoleCodeId(player) {
    if (!player) return 0;
    var serverData = getServerData(player);
    return firstPositiveNumber([
      player.id,
      player.roleId,
      player.roleCodeId,
      serverData && serverData.codeIdV2,
      player.key,
      player.team && player.team.leaderId,
      player.team && player.team.leaderRoleId,
      player.codeIdV2,
      player.codeId,
      player.cId,
      player.team && player.team.leaderCodeIdV2,
      player.team && player.team.leaderCodeId,
      player.hasTeam && player.team && player.team.leaderId
    ]);
  }

  function getPlayerName(player) {
    return (player && (player.name || player.nickName || player.roleName || player.nickname)) || '';
  }

  function isSelfPlayer(player) {
    var targetCodeId = getRoleCodeId(player);
    var mod = getLegionWarModule();
    var bf = getBattlefield();
    var selfRole = bf && (bf.self || bf.selfRole || bf.role);
    var selfCodeId = firstPositiveNumber([
      selfRole && selfRole.id,
      selfRole && selfRole.roleId,
      selfRole && selfRole.roleCodeId,
      mod && mod.selfCodeId,
      mod && mod._selfCodeId,
      mod && mod.roleId
    ]);
    if (!targetCodeId || !mod) return false;
    return targetCodeId === selfCodeId;
  }

  function isPlayerLike(obj) {
    return !!(obj && typeof obj === 'object' && (obj.id || obj.roleId || obj.roleCodeId || obj.key || obj.codeId || obj.codeIdV2 || obj.cId || obj.name || obj.nickName || obj.roleName));
  }

  function getPlayerCacheKey(player) {
    var codeId = getRoleCodeId(player);
    return codeId ? (getBattlefieldId() + ':' + codeId) : '';
  }

  function getPlayerStateKey(player) {
    if (!player) return '';
    return [
      player.state,
      player.isDead ? 1 : 0,
      Number(player.dieTime) || 0,
      player.teamState,
      player.hasTeam ? 1 : 0,
      Number(player.strength) || 0,
      Number(player.dC) || 0,
      Number(player.point) || 0,
      Number(player.reviveTime) || 0
    ].join('|');
  }

  function getPlayerStateType(typeName) {
    try {
      var types = gameRequire('types-legion-war');
      var stateTypes = types && types.LWPlayerStateType;
      return stateTypes && stateTypes[typeName];
    } catch (e) {
      return undefined;
    }
  }

  function isMarchState(player) {
    var st = player && player.state;
    var marchType = getPlayerStateType('march');
    return st === 'march' || (marchType !== undefined && st === marchType);
  }

  function isIdleState(player) {
    var st = player && player.state;
    var idleType = getPlayerStateType('idle');
    return st === 'idle' || st === 0 || (idleType !== undefined && st === idleType);
  }

  function isCombatState(player) {
    var st = player && player.state;
    var combatType = getPlayerStateType('combat');
    return st === 'combat' || (combatType !== undefined && st === combatType);
  }

  function isDeadState(player) {
    var st = player && player.state;
    var dieType = getPlayerStateType('die');
    var resurrectType = getPlayerStateType('resurrect');
    var overType = getPlayerStateType('over');
    return st === 'die' || st === 'resurrect' || st === 'over' ||
      (dieType !== undefined && st === dieType) ||
      (resurrectType !== undefined && st === resurrectType) ||
      (overType !== undefined && st === overType);
  }

  // 递归读取深层数值属性
  function readNumberField(obj, keys, depth, seen) {
    if (depth === undefined) depth = 3;
    if (!seen) seen = new Set();
    if (!obj || typeof obj !== 'object' || depth < 0 || seen.has(obj)) return 0;
    seen.add(obj);

    for (var i = 0; i < keys.length; i++) {
      var val = obj[keys[i]];
      if (val !== undefined && val !== null && val !== '') {
        var num = Number(val);
        if (Number.isFinite(num)) return num;
      }
    }

    var subKeys = ['role', 'raw', 'player', 'serverData', '_serverData', 'data', 'roleInfo'];
    for (var j = 0; j < subKeys.length; j++) {
      var subNum = readNumberField(obj[subKeys[j]], keys, depth - 1, seen);
      if (subNum) return subNum;
    }
    return 0;
  }

  function readEnemyEnergy(enemy) {
    return readNumberField(enemy, [
      'strength', 'energy', 'strengthValue', 'strengthCnt', 'leftStrength',
      'curStrength', 'stamina', 'vit', 'vitality', 'actionPoint', 'actionPoints', 'fightCnt'
    ]);
  }

  function readEnemyPower(role, cached) {
    var basePower = readNumberField({ role: role, cached: cached }, [
      'power', 'fightPower', 'combatPower', 'battlePower', 'totalPower', 'score', 'dC', 'fightCapacity'
    ]);
    if (basePower > 0) return basePower;

    try {
      var cacheKey = getPlayerCacheKey(role);
      var team = cacheKey && state.teamCache && state.teamCache.get(cacheKey);
      if (team) {
        if (team.totalPower) return Number(team.totalPower) || 0;
        if (Array.isArray(team.heroIds) && team.heroIds.length) {
          var sum = 0;
          team.heroIds.forEach(function (h) {
            sum += Number(h && h.power) || 0;
          });
          if (sum > 0) return sum;
        }
      }
    } catch (e) {}
    return 0;
  }

  function getAttackTargetId(targetPlayer) {
    if (!targetPlayer) return 0;
    try {
      if (targetPlayer.hasTeam && targetPlayer.team && targetPlayer.team.leaderId) {
        return Number(targetPlayer.team.leaderId) || 0;
      }
    } catch (e) {}
    return getRoleCodeId(targetPlayer);
  }

  function sameTargetId(idA, idB) {
    return Number(idA) > 0 && Number(idA) === Number(idB);
  }

  function playerContainsTarget(player, targetId) {
    if (!player || !targetId) return false;
    if (sameTargetId(getAttackTargetId(player), targetId) || sameTargetId(getRoleCodeId(player), targetId)) return true;
    var team = player.team;
    var members = team && (team.livePlayers || team.players);
    return !!(Array.isArray(members) && members.some(function (tp) {
      return sameTargetId(getRoleCodeId(tp), targetId);
    }));
  }

  function isSameLegionTarget(player) {
    var bf = getBattlefield();
    var selfRole = bf && bf.self;
    var targetLegionId = player && player.legionId;
    var selfLegionId = selfRole && selfRole.legionId;
    return targetLegionId !== undefined && targetLegionId !== null && targetLegionId !== '' &&
      Number(targetLegionId) !== 0 && selfLegionId !== undefined && selfLegionId !== null &&
      selfLegionId !== '' && String(targetLegionId) === String(selfLegionId);
  }

  function getPlayerById(roleId) {
    var bf = getBattlefield();
    var players = bf && bf.players;
    if (!players || !roleId) return null;
    try {
      return players.get(roleId) || players.get(String(roleId)) || null;
    } catch (e) {
      return null;
    }
  }

  function getTargetMarch(targetPlayer) {
    var bf = getBattlefield();
    var marches = bf && bf.marches;
    var targetId = getAttackTargetId(targetPlayer);
    var roleCodeId = getRoleCodeId(targetPlayer);
    var marchId = targetPlayer && targetPlayer.marchId;
    var matchedMarch = null;
    var memberIds = [];

    if (!marches) return null;
    try {
      if (marchId && typeof marches.get === 'function') {
        matchedMarch = marches.get(marchId) || marches.get(String(marchId));
      }
    } catch (e) {}
    if (matchedMarch) return matchedMarch;

    try {
      var team = targetPlayer && targetPlayer.team;
      var teamPlayers = team && (team.players || team.livePlayers);
      if (Array.isArray(teamPlayers)) {
        teamPlayers.forEach(function (tp) {
          var cid = getRoleCodeId(tp);
          if (cid) memberIds.push(Number(cid));
        });
      }
    } catch (e) {}

    try {
      marches.forEach(function (m) {
        if (matchedMarch || !m) return;
        var mCode = Number(m.roleId !== undefined ? m.roleId : (m.codeId !== undefined ? m.codeId : (m._serverData && m._serverData.roleId)));
        if (mCode === Number(targetId) || mCode === Number(roleCodeId) || memberIds.indexOf(mCode) >= 0) {
          matchedMarch = m;
        }
      });
    } catch (e) {}
    return matchedMarch;
  }

  function getMarchDestination(targetPlayer) {
    var march = getTargetMarch(targetPlayer);
    var toBuilding = march && (march.toBuilding || null);
    var toPos = copyPosition(march && march.to) || copyPosition(toBuilding && toBuilding.position);
    var bId = march && march.toBuildingId || (toBuilding && toBuilding.id) || (toPos && (toPos.x + '_' + toPos.y));
    return march ? {
      march: march,
      buildingId: bId || '',
      position: toPos
    } : null;
  }

  function getPlayerMarchRemainSeconds(player) {
    if (!player) return 0;
    var endTime = 0;
    var marchDest = getMarchDestination(player);
    if (marchDest && marchDest.march && marchDest.march.endTime) {
      endTime = Number(marchDest.march.endTime) || 0;
    }
    if (!endTime && player.endMarchTime) {
      endTime = Number(player.endMarchTime) || 0;
    }
    if (!endTime) {
      var bf = getBattlefield();
      var marches = bf && bf.marches;
      var roleCodeId = getRoleCodeId(player);
      if (marches && roleCodeId) {
        try {
          marches.forEach(function (m) {
            if (endTime || !m) return;
            var mCode = Number(m.roleId !== undefined ? m.roleId : (m.codeId !== undefined ? m.codeId : (m._serverData && m._serverData.roleId)));
            if (mCode === Number(roleCodeId) && m.endTime) {
              endTime = Number(m.endTime) || 0;
            }
          });
        } catch (e) {}
      }
    }
    if (!endTime) return 0;
    endTime = normalizeTimestamp(endTime);
    var remainMs = Math.max(0, endTime - getServerTimeNow());
    return Math.ceil(remainMs / 1000);
  }

  function getPlayerMarchTargetName(player) {
    if (!player) return '';
    var marchDest = getMarchDestination(player);
    if (marchDest && marchDest.march) {
      var toB = marchDest.march.toBuilding;
      if (toB && toB.name) return toB.name;
      if (marchDest.buildingId) {
        var bf = getBattlefield();
        var b = bf && bf.buildings && (bf.buildings.get ? (bf.buildings.get(marchDest.buildingId) || bf.buildings.get(Number(marchDest.buildingId))) : bf.buildings[marchDest.buildingId]);
        if (b && b.name) return b.name;
        return '建筑' + marchDest.buildingId;
      }
    }
    return '';
  }

  function findTargetInBuildingQueues(building, targetId) {
    var queueGroups = [
      ['attack', building && building.attackerList],
      ['defense', building && building.defenderList]
    ];
    for (var g = 0; g < queueGroups.length; g++) {
      var qList = queueGroups[g][1];
      if (!Array.isArray(qList)) continue;
      for (var i = 0; i < qList.length; i++) {
        if (playerContainsTarget(qList[i], targetId)) {
          return {
            queue: queueGroups[g][0],
            player: qList[i]
          };
        }
      }
    }
    return null;
  }

  function readBattleTargetId(battle, side) {
    var keyList = side === 'left' ? ['leftId', 'leftCodeId'] : ['rightId', 'rightCodeId'];
    for (var i = 0; i < keyList.length; i++) {
      var id = Number(battle && battle[keyList[i]]) || 0;
      if (id > 0) return id;
    }
    var playerObj = battle && battle[side];
    return getAttackTargetId(playerObj) || getRoleCodeId(playerObj) || 0;
  }

  function makeBattleInfo(battle, targetId) {
    var leftId = readBattleTargetId(battle, 'left');
    var rightId = readBattleTargetId(battle, 'right');
    if (!sameTargetId(leftId, targetId) && !sameTargetId(rightId, targetId)) return null;
    return {
      leftId: leftId,
      rightId: rightId,
      opponentId: sameTargetId(leftId, targetId) ? rightId : leftId,
      targetSide: sameTargetId(leftId, targetId) ? 'left' : 'right',
      startTime: normalizeBattleTimestamp(battle && battle.startTime),
      endTime: normalizeBattleTimestamp(battle && battle.endTime)
    };
  }

  function findTargetBattle(building, targetId) {
    var battleList = building && building.battleList;
    var bf = getBattlefield();
    var bfBattles = bf && bf.battles;
    var match = null;

    if (Array.isArray(battleList)) {
      for (var i = 0; i < battleList.length; i++) {
        match = makeBattleInfo(battleList[i], targetId);
        if (match) return match;
      }
    }
    try {
      if (bfBattles) {
        bfBattles.forEach(function (b) {
          if (!match) match = makeBattleInfo(b, targetId);
        });
      }
    } catch (e) {}
    return match || null;
  }

  function getLockedBattleEndTime(selfPlayer, targetId) {
    var endTs = normalizeBattleTimestamp(selfPlayer && selfPlayer.endBattleTime);
    if (endTs > 0) return endTs;
    var battle = findTargetBattle(selfPlayer && selfPlayer.curBuilding, targetId);
    return Number(battle && battle.endTime) || 0;
  }

  /* ============================================================================
   * 5. AVATAR & FORMATION (离线图像特征识别算法、队伍解析与阵型判定)
   * ============================================================================ */

  function normalizeSlotIndex(val) {
    if (val === null || val === undefined || val === '') return -1;
    var num = Number(val);
    return isFinite(num) && num >= 0 && num < 5 && Math.floor(num) === num ? num : -1;
  }

  function findHeroSlotIndex(hero, slotKey, fallbackIndex) {
    var candidates = [
      hero && hero.battleTeamSlot,
      hero && hero.slot,
      hero && hero.index,
      slotKey,
      fallbackIndex
    ];
    for (var i = 0; i < candidates.length; i++) {
      var slot = normalizeSlotIndex(candidates[i]);
      if (slot >= 0) return slot;
    }
    return -1;
  }

  function normalizeTeamSlotList(teamInfo) {
    var slots = [null, null, null, null, null];
    var overflowList = [];
    var count = 0;
    if (!teamInfo) return [];

    iterateCollection(teamInfo, function (item, key) {
      if (!item || typeof item !== 'object' || count >= 5) return;
      var hero = shallowCopy(item);
      var slotIdx = findHeroSlotIndex(hero, key, -1);
      hero.__saltTeamKey = key;
      hero.__saltTeamSlot = slotIdx;
      if (slotIdx >= 0 && !slots[slotIdx]) {
        slots[slotIdx] = hero;
      } else {
        overflowList.push(hero);
      }
      count++;
    });

    overflowList.forEach(function (hero) {
      for (var s = 0; s < 5; s++) {
        if (!slots[s]) {
          hero.__saltTeamSlot = s;
          slots[s] = hero;
          break;
        }
      }
    });

    return slots.filter(function (it) {
      return !!it;
    });
  }

  function mergeTeamImageInfo(teamList, teamImgMap) {
    var merged = [];
    var slotSeen = {};
    (teamList || []).slice(0, 5).forEach(function (item, idx) {
      var hero = shallowCopy(item);
      var teamKey = item && item.__saltTeamKey;
      var slot = findHeroSlotIndex(hero, teamKey, idx);
      var imgBase64 = normalizePngDataUrl(safeGetProperty(teamImgMap, teamKey) || safeGetProperty(teamImgMap, slot));
      if (slot >= 0 && slotSeen[slot]) return;
      if (slot >= 0) slotSeen[slot] = true;
      hero.__saltTeamKey = teamKey;
      hero.__saltTeamSlot = slot;
      if (imgBase64) hero.imgName = imgBase64;
      if (imgBase64 && !hero.heroName) hero.heroName = '未知头像';
      if (hero.curHp === undefined && hero.hp === undefined) hero.curHp = 1;
      merged.push(hero);
    });
    return merged;
  }

  function extractPlayerHeroes(player) {
    var rawList = null;
    if (!player) return null;
    if (Array.isArray(player.formation)) rawList = player.formation;
    else if (Array.isArray(player.fighters)) rawList = player.fighters;
    else if (Array.isArray(player.heroes)) rawList = player.heroes;
    else if (player.teamInfo) rawList = mergeTeamImageInfo(normalizeTeamSlotList(player.teamInfo), player.teamImgInfo);
    else if (player.battleTeam) rawList = normalizeTeamSlotList(player.battleTeam);

    if (!rawList || !rawList.length) return null;
    return rawList.slice(0, 5).map(function (item, idx) {
      var imgName = normalizePngDataUrl(item && (item.imgName || item.teamImg || item.imgHash || item.imageHash));
      var heroId = Number(item && (item.heroId || item.confId || item.heroConfId || item.id)) || 0;
      return {
        heroId: heroId,
        heroName: (item && (item.heroName || item.name)) || HERO_NAME_BY_ID[heroId] || (imgName ? '未知头像' : ''),
        imgName: imgName,
        battleTeamSlot: findHeroSlotIndex(item, null, idx),
        curHp: item && item.curHp !== undefined ? item.curHp : (item && item.hp !== undefined ? item.hp : 1),
        useSkin: item && item.useSkin
      };
    }).filter(function (it) {
      return it.heroId > 0 || !!it.imgName || !!it.heroName;
    });
  }

  function resolveHeroName(hero, player) {
    if (!hero) return '';
    if (hero.heroName) return String(hero.heroName);
    if (!hero.heroId) return '';
    if (HERO_NAME_BY_ID[hero.heroId]) return HERO_NAME_BY_ID[hero.heroId];
    try {
      var HeroDataView = gameRequire('HeroDataView').HeroDataView;
      if (HeroDataView && HeroDataView.getRealName) {
        var realName = HeroDataView.getRealName(hero, hero.useSkin, !!(player && isSelfPlayer(player)));
        if (realName) return String(realName);
      }
    } catch (e) {}
    try {
      var Configs = gameRequire('Configs');
      var LanguageExt = gameRequire('LanguageExt');
      var conf = Configs.HeroConf && Configs.HeroConf.getById(hero.heroId);
      var nick = conf && (conf.nickName || conf.name);
      if (nick && LanguageExt && LanguageExt.GET_CONTENT) return String(LanguageExt.GET_CONTENT(nick));
      return nick ? String(nick) : String(hero.heroId);
    } catch (e) {
      return String(hero.heroId);
    }
  }

  function containsText(list, text) {
    return list.some(function (item) {
      return String(item || '').indexOf(text) >= 0;
    });
  }

  function classifyFormation(heroNameList, aliveCount, totalCount, formationType) {
    for (var i = 0; i < FORMATION_PATTERNS.length; i++) {
      var pattern = FORMATION_PATTERNS[i];
      var matches = pattern.heroes.every(function (hName) {
        return containsText(heroNameList, hName);
      });
      if (matches) return pattern.label;
    }
    if (totalCount > 0 && aliveCount <= 0) return '空阵';
    if (totalCount > 0) return '其他';
    return '未知';
  }

  function buildRosterFingerprint(heroList) {
    var slotMap = {};
    (heroList || []).forEach(function (hero, idx) {
      if (!hero) return;
      var slot = findHeroSlotIndex(hero, hero.__saltTeamKey, idx);
      if (slot < 0 || slotMap[slot]) return;
      slotMap[slot] = [
        slot,
        Number(hero.heroId) || 0,
        Number(hero.level) || 0,
        Number(hero.order) || 0,
        Number(hero.star) || 0,
        Number(hero.color) || 0,
        Number(hero.power) || 0,
        Number(hero.maxHp || hero.hp) || 0,
        Number(hero.useSkin) || 0,
        normalizePngDataUrl(hero.imgName).toLowerCase()
      ].join(':');
    });
    if (Object.keys(slotMap).length !== 5) return '';
    return [0, 1, 2, 3, 4].map(function (s) {
      return slotMap[s];
    }).join('|');
  }

  function buildTeamSummary(player, heroList, cachedSummary) {
    var heroNames = [];
    var heroIds = [];
    var aliveCount = 0;
    var slotSeen = {};
    heroList = heroList || [];

    heroList.forEach(function (hero, idx) {
      if (!hero) return;
      var slot = findHeroSlotIndex(hero, hero.__saltTeamKey, idx);
      if (slot >= 0 && slotSeen[slot]) return;
      if (slot >= 0) slotSeen[slot] = true;
      var name = resolveHeroName(hero, player);
      if (hero.heroId) heroIds.push(hero.heroId);
      if (name) heroNames.push(name);
      var curHp = hero.curHp;
      var hp = hero.hp;
      var isDead = false;
      if (curHp !== undefined && curHp !== null && curHp !== '') {
        isDead = isFinite(Number(curHp)) && Number(curHp) === 0;
      } else if (hp !== undefined && hp !== null && hp !== '') {
        isDead = isFinite(Number(hp)) && Number(hp) === 0;
      }
      if (!isDead) aliveCount++;
    });

    var totalCount = 5;
    var label = (cachedSummary && cachedSummary.label) || classifyFormation(heroNames, aliveCount, totalCount, player && player.formationType);
    if (!heroNames.length && cachedSummary && cachedSummary.heroNames) heroNames = cachedSummary.heroNames.slice();
    if (!heroIds.length && cachedSummary && cachedSummary.heroIds) heroIds = cachedSummary.heroIds.slice();

    return {
      label: label,
      alive: aliveCount,
      total: totalCount,
      heroIds: heroIds,
      heroNames: heroNames,
      rosterFingerprint: buildRosterFingerprint(heroList),
      remainingText: aliveCount + '/' + totalCount,
      text: label + aliveCount + '/' + totalCount
    };
  }

  function unwrapTeamInfoResponse(rawResp) {
    if (!rawResp) return null;
    if (rawResp.code) return null;
    if (rawResp.data && rawResp.data.code) return null;
    if (typeof rawResp.getData === 'function') {
      try {
        var dataIdx = gameRequire('data-index');
        var Cls = (dataIdx && dataIdx.War_GetTeamInfoResp) || (dataIdx && dataIdx.Watch_GetTeamInfoResp);
        if (Cls) return rawResp.getData(new Cls());
        return rawResp.getData();
      } catch (e) {
        try {
          var dataIdxAlt = gameRequire('data-index');
          if (dataIdxAlt && dataIdxAlt.Watch_GetTeamInfoResp) return rawResp.getData(new dataIdxAlt.Watch_GetTeamInfoResp());
          return rawResp.getData();
        } catch (err) { return null; }
      }
    }
    if (rawResp.data && typeof rawResp.data.getData === 'function') {
      try {
        var dataIdx2 = gameRequire('data-index');
        var Cls2 = (dataIdx2 && dataIdx2.War_GetTeamInfoResp) || (dataIdx2 && dataIdx2.Watch_GetTeamInfoResp);
        if (Cls2) return rawResp.data.getData(new Cls2());
        return rawResp.data.getData();
      } catch (e) {
        try {
          var dataIdxAlt2 = gameRequire('data-index');
          if (dataIdxAlt2 && dataIdxAlt2.Watch_GetTeamInfoResp) return rawResp.data.getData(new dataIdxAlt2.Watch_GetTeamInfoResp());
          return rawResp.data.getData();
        } catch (err) { return null; }
      }
    }
    if (rawResp.body && (rawResp.body.teamInfo || rawResp.body.teamImgInfo)) return rawResp.body;
    return rawResp.data || rawResp;
  }

  function parseTeamResponse(resp) {
    var unwrapped = unwrapTeamInfoResponse(resp);
    if (!unwrapped || !unwrapped.teamInfo) return null;
    return mergeTeamImageInfo(normalizeTeamSlotList(unwrapped.teamInfo), unwrapped.teamImgInfo);
  }

  function unwrapTeamImgInfoResponse(rawResp) {
    if (!rawResp) return null;
    if (rawResp.code || (rawResp.data && rawResp.data.code)) return null;
    if (typeof rawResp.getData === 'function') {
      try {
        var dataIdx = gameRequire('data-index');
        if (dataIdx && typeof dataIdx.War_GetTeamImgInfoResp === 'function') {
          return rawResp.getData(new dataIdx.War_GetTeamImgInfoResp());
        }
        return rawResp.getData();
      } catch (e) {
        try { return rawResp.getData(); } catch (err) { return null; }
      }
    }
    if (rawResp.data && typeof rawResp.data.getData === 'function') {
      try {
        var dataIdx2 = gameRequire('data-index');
        if (dataIdx2 && typeof dataIdx2.War_GetTeamImgInfoResp === 'function') {
          return rawResp.data.getData(new dataIdx2.War_GetTeamImgInfoResp());
        }
        return rawResp.data.getData();
      } catch (e) {
        try { return rawResp.data.getData(); } catch (err) { return null; }
      }
    }
    if (rawResp.body && rawResp.body.teamInfo) return rawResp.body;
    return rawResp.data || rawResp;
  }

  function extractTeamImgInfo(resp) {
    var unwrapped = unwrapTeamImgInfoResponse(resp);
    return (unwrapped && unwrapped.teamInfo) || null;
  }

  function fetchTeamSummaryFromServer(player, roleCodeId) {
    var mod = getLegionWarModule();
    if (!mod || typeof mod.sendGetTeamInfo !== 'function') return Promise.resolve(null);

    return new Promise(function (resolve) {
      var completed = false;
      var timer = 0;
      var warRespKey = null;
      var watchRespKey = null;
      var listeningWar = false;
      var listeningWatch = false;
      var netMgr = null;

      function detachListener() {
        if (listeningWar && warRespKey && mod.network && typeof mod.network.off === 'function') {
          mod.network.off(warRespKey, onResponse, state);
        }
        if (listeningWatch && watchRespKey && netMgr && typeof netMgr.off === 'function') {
          netMgr.off(watchRespKey, onResponse, state);
        }
        listeningWar = false;
        listeningWatch = false;
      }

      function cleanup() {
        if (timer) window.clearTimeout(timer);
        timer = 0;
        detachListener();
        state.activeRequests.delete(cancel);
      }

      function finish(data) {
        if (completed) return;
        completed = true;
        cleanup();
        if (!Array.isArray(data)) {
          resolve(null);
          return;
        }
        recognizeFormationFromTeam(player, data).then(resolve);
      }

      function cancel() {
        finish(null);
      }

      function onResponse(msg) {
        var teamList = parseTeamResponse(msg);
        if (Array.isArray(teamList)) finish(teamList);
      }

      try {
        var dataIdx = gameRequire('data-index');
        warRespKey = dataIdx.RESPS && dataIdx.RESPS.War_GetTeamInfoResp;
        watchRespKey = dataIdx.RESPS && dataIdx.RESPS.Watch_GetTeamInfoResp;
        try {
          var nmMod = gameRequire('NetworkManager');
          netMgr = nmMod && (nmMod.NetworkManager || nmMod.default || nmMod);
        } catch (e) {}

        if (warRespKey && mod.network && typeof mod.network.on === 'function') {
          mod.network.on(warRespKey, onResponse, state);
          listeningWar = true;
        }
        if (watchRespKey && netMgr && typeof netMgr.on === 'function') {
          netMgr.on(watchRespKey, onResponse, state);
          listeningWatch = true;
        }
      } catch (e) {}

      state.activeRequests.add(cancel);
      timer = window.setTimeout(function () {
        finish(null);
      }, 3500);

      try {
        var promise = mod.sendGetTeamInfo(roleCodeId);
        if (promise && typeof promise.then === 'function') {
          detachListener();
          promise.then(function (res) {
            var teamList = parseTeamResponse(res);
            finish(Array.isArray(teamList) ? teamList : null);
          }).catch(function (err) {
            logWarn('阵容读取失败:', getPlayerName(player) || roleCodeId, err && err.message || err);
            finish(null);
          });
        } else if (promise) {
          var teamList = parseTeamResponse(promise);
          finish(Array.isArray(teamList) ? teamList : null);
        }
      } catch (err) {
        logWarn('阵容请求异常:', getPlayerName(player) || roleCodeId, err && err.message || err);
        finish(null);
      }
    });
  }

  function storeTeamSummary(player, summary) {
    var cacheKey = getPlayerCacheKey(player);
    if (!state.destroyed && cacheKey && summary) {
      summary.cachedAt = Date.now();
      summary.playerStateKey = getPlayerStateKey(player);
      state.teamCache.delete(cacheKey);
      state.teamCache.set(cacheKey, summary);
      while (state.teamCache.size > CACHE_LIMIT) {
        state.teamCache.delete(state.teamCache.keys().next().value);
      }
    }
  }

  function getCachedTeamSummary(player) {
    var cacheKey = getPlayerCacheKey(player);
    var cached = cacheKey ? state.teamCache.get(cacheKey) || null : null;
    if (!cached) return null;
    if (TEAM_CACHE_TTL_MS > 0 && Date.now() - Number(cached.cachedAt || 0) > TEAM_CACHE_TTL_MS) {
      state.teamCache.delete(cacheKey);
      return null;
    }
    return cached;
  }

  function storeFormationCache(player, summary) {
    var cacheKey = getPlayerCacheKey(player);
    if (state.destroyed || !cacheKey || !summary || !summary.label || summary.label === '未知' || summary.label === '空阵') return;
    state.formationCache.delete(cacheKey);
    state.formationCache.set(cacheKey, {
      label: summary.label,
      heroIds: (summary.heroIds || []).slice(),
      heroNames: (summary.heroNames || []).slice(),
      rosterFingerprint: summary.rosterFingerprint || '',
      identifiedAt: Date.now()
    });
    while (state.formationCache.size > CACHE_LIMIT) {
      state.formationCache.delete(state.formationCache.keys().next().value);
    }
  }

  function getCachedFormation(player) {
    var cacheKey = getPlayerCacheKey(player);
    return cacheKey ? (state.formationCache.get(cacheKey) || null) : null;
  }

  function recognizeFormationFromTeam(player, teamHeroes) {
    var cached = getCachedFormation(player);
    var fingerprint = buildRosterFingerprint(teamHeroes);
    var isHit = !!(cached && (!fingerprint || (cached.rosterFingerprint && cached.rosterFingerprint === fingerprint)));

    if (isHit) {
      state.formationCacheHits += 1;
      return Promise.resolve(buildTeamSummary(player, teamHeroes, cached));
    }
    if (!teamHeroes.length) {
      return Promise.resolve(buildTeamSummary(player, teamHeroes, cached));
    }

    state.formationRecognitionRuns += 1;
    var summary = buildTeamSummary(player, teamHeroes);
    summary.rosterFingerprint = fingerprint;
    storeFormationCache(player, summary);
    return Promise.resolve(summary);
  }

  function requestTeamSummary(player, callback) {
    var cacheKey = getPlayerCacheKey(player);
    var roleCodeId = getRoleCodeId(player);
    var cached = getCachedTeamSummary(player);
    var localHeroes = extractPlayerHeroes(player);
    var now = Date.now();

    if (cached) {
      if (callback) callback(cached);
      return Promise.resolve(cached);
    }
    if (!cacheKey || !roleCodeId) return Promise.resolve(null);
    if (state.requestCooldown.has(cacheKey) && now - state.requestCooldown.get(cacheKey) < 60000) {
      return Promise.resolve(null);
    }
    if (state.pending.has(cacheKey)) {
      return state.pending.get(cacheKey).then(function (res) {
        if (!state.destroyed && callback && res) callback(res);
        return res;
      });
    }

    if (localHeroes && localHeroes.length) {
      var localPromise = recognizeFormationFromTeam(player, localHeroes).then(function (res) {
        state.pending.delete(cacheKey);
        if (state.destroyed) return null;
        if (res) storeTeamSummary(player, res);
        if (callback && res) callback(res);
        return res;
      }, function (err) {
        state.pending.delete(cacheKey);
        throw err;
      });
      state.pending.set(cacheKey, localPromise);
      return localPromise;
    }

    state.requestCooldown.set(cacheKey, now);
    var netPromise = state.requestChain.catch(function () {
      return null;
    }).then(function () {
      if (state.destroyed) return null;
      return fetchTeamSummaryFromServer(player, roleCodeId);
    }).then(function (res) {
      state.pending.delete(cacheKey);
      if (state.destroyed) return null;
      if (res) storeTeamSummary(player, res);
      if (res) state.requestCooldown.delete(cacheKey);
      if (callback && res) callback(res);
      return res;
    }, function (err) {
      state.pending.delete(cacheKey);
      throw err;
    });

    state.pending.set(cacheKey, netPromise);
    state.requestChain = netPromise.catch(function () {
      return null;
    });
    return netPromise;
  }

  function listParticipantIdentities() {
    var bf = getBattlefield();
    var playerMap = bf && (bf.players || bf.roles);
    var resultList = [];
    var seenMap = {};

    function addParticipant(p, key) {
      var codeId = getRoleCodeId(p) || firstPositiveNumber([key]);
      if (!codeId || seenMap[codeId]) return;
      seenMap[codeId] = true;
      var cached = state.teamCache.get(getBattlefieldId() + ':' + codeId) || null;
      resultList.push({
        roleCodeId: codeId,
        name: getPlayerName(p),
        strength: p && p.strength,
        state: p && p.state,
        formation: cached && cached.text || ''
      });
    }

    if (playerMap && typeof playerMap.forEach === 'function') {
      playerMap.forEach(addParticipant);
    } else if (playerMap && typeof playerMap === 'object') {
      Object.keys(playerMap).forEach(function (k) {
        addParticipant(playerMap[k], k);
      });
    }
    return resultList.sort(function (a, b) {
      return a.roleCodeId - b.roleCodeId;
    });
  }

  /* ============================================================================
   * 6. UI & FAIRYGUI TOOLS (FairyGUI 节点创建、自绘矢量按钮、样式排版与倒计时 HUD)
   * ============================================================================ */

  function setNodeSize(node, w, h) {
    if (!node) return;
    if (typeof node.setSize === 'function') node.setSize(w, h);
    else { node.width = w; node.height = h; }
  }

  function setNodePos(node, x, y) {
    if (!node) return;
    if (typeof node.setPosition === 'function') node.setPosition(x, y);
    else if (typeof node.setXY === 'function') node.setXY(x, y);
    else { node.x = x; node.y = y; }
  }

  function copyTextStyle(sourceNode, targetNode) {
    if (!targetNode) return;
    if (sourceNode) {
      var styleKeys = ['font', 'fontSize', 'color', 'bold', 'italic', 'underline', 'stroke', 'strokeColor', 'shadowColor', 'align', 'verticalAlign', 'leading', 'letterSpacing'];
      styleKeys.forEach(function (k) {
        if (sourceNode[k] !== undefined) {
          try { targetNode[k] = sourceNode[k]; } catch (e) {}
        }
      });
    }
    if (!targetNode.fontSize) targetNode.fontSize = 15;
    if (!targetNode.color) targetNode.color = '#d87532';
  }

  function estimateTextWidth(textNode) {
    var str = String(textNode && textNode.text || '');
    var fs = Number(textNode && textNode.fontSize || 15);
    return Math.max(8, Math.ceil(str.length * fs * 0.82));
  }

  function isSaltQueueOverlay(node) {
    return !!(node && (
      node.name === 'saltQueueSummary' ||
      node.name === 'saltQueueRoleId' ||
      node.name === 'saltQueueRemaining' ||
      node.name === 'saltQueueLockBox' ||
      node.name === 'saltQueueLockCheck' ||
      node.name === 'saltQueueLockText'
    ));
  }

  function getChildren(node) {
    var list = [];
    if (!node) return list;
    if (typeof node.numChildren === 'number' && typeof node.getChildAt === 'function') {
      for (var i = 0; i < node.numChildren; i++) {
        try { list.push(node.getChildAt(i)); } catch (e) {}
      }
    }
    if (Array.isArray(node._children)) {
      list = list.concat(node._children);
    } else if (node._children && Array.isArray(node._children._items)) {
      list = list.concat(node._children._items);
    }
    return list.filter(function (item, idx) {
      return item && list.indexOf(item) === idx;
    });
  }

  function someDescendant(node, predicate, depth, visited) {
    if (!node || depth > 5) return false;
    visited = visited || [];
    if (visited.indexOf(node) >= 0) return false;
    visited.push(node);
    return getChildren(node).some(function (child) {
      if (predicate(child)) return true;
      return someDescendant(child, predicate, depth + 1, visited);
    });
  }

  function isTextNode(node) {
    return !!(node && !isSaltQueueOverlay(node) && typeof node.text === 'string');
  }

  function findTextNodeByProps(node, propList) {
    for (var i = 0; i < propList.length; i++) {
      var candidate = node && node[propList[i]];
      if (isTextNode(candidate)) return candidate;
    }
    return null;
  }

  function findStatusTextNode(node) {
    var match = findTextNodeByProps(node, ['m_txtStatus', 'm_txtState', 'm_state', 'm_status', 'm_txtAction', 'm_txtDesc']);
    if (match) return match;

    someDescendant(node, function (child) {
      if (!isTextNode(child)) return false;
      var str = String(child.text || '');
      if (str.indexOf('驻守') >= 0 || str.indexOf('驻扎') >= 0 || str.indexOf('驻防') >= 0 ||
        str.indexOf('防守') >= 0 || str.indexOf('交战') >= 0 || str.indexOf('行军') >= 0 || str.indexOf('返回') >= 0) {
        match = child;
        return true;
      }
      return false;
    }, 0);
    return match;
  }

  function findStrengthTextNode(node) {
    var match = findTextNodeByProps(node, ['m_strength', 'm_txtStrength', 'm_txtEnergy', 'm_energy', 'm_txtSpirit', 'm_spirit']);
    if (match) return match;

    someDescendant(node, function (child) {
      if (!isTextNode(child)) return false;
      if (String(child.text || '').indexOf('精力') >= 0) {
        match = child;
        return true;
      }
      return false;
    }, 0);
    return match;
  }

  function findRoleIdTextNode(node) {
    var match = null;
    someDescendant(node, function (child) {
      if (!isTextNode(child)) return false;
      if (/^ID[:：]\s*\d+$/i.test(String(child.text || '').trim())) {
        match = child;
        return true;
      }
      return false;
    }, 0);
    return match;
  }

  function findPlayerNameTextNode(item, player) {
    var pName = getPlayerName(player);
    var node = findTextNodeByProps(item, ['m_txtName', 'm_name', 'm_txtPlayerName', 'm_playerName', 'm_txtRoleName', 'm_roleName']);
    if (node) return node;
    if (!pName) return null;

    someDescendant(item, function (child) {
      if (!isTextNode(child)) return false;
      var t = String(child.text || '');
      if (t && (t === pName || t.indexOf(pName) >= 0 || pName.indexOf(t.replace(/\.\.\.$/, '')) >= 0)) {
        node = child;
        return true;
      }
      return false;
    }, 0);
    return node;
  }

  function ensureTextField(parent, cacheProp, name, touchable) {
    var fg = getFgui();
    if (!parent || !fg || !fg.GTextField) return null;
    if (parent[cacheProp]) {
      if (state.items.indexOf(parent) < 0) state.items.push(parent);
      parent[cacheProp].touchable = !!touchable;
      parent[cacheProp].singleLine = true;
      return parent[cacheProp];
    }
    var tf = new fg.GTextField();
    tf.name = name;
    tf.touchable = !!touchable;
    tf.autoSize = fg.AutoSizeType ? fg.AutoSizeType.None : 0;
    tf.fontSize = 15;
    tf.color = '#d87532';
    tf.bold = false;
    tf.stroke = 0;
    tf.singleLine = true;
    tf.text = '';
    setNodeSize(tf, 120, 22);
    parent.addChild(tf);
    parent[cacheProp] = tf;
    if (state.items.indexOf(parent) < 0) state.items.push(parent);
    return tf;
  }

  function getCountdownRoot() {
    var fg = getFgui();
    var GRoot = fg && fg.GRoot;
    return (GRoot && (GRoot.inst || (GRoot.getInst && GRoot.getInst()))) || null;
  }

  function hideMarchCountdown() {
    if (state.countdownText) state.countdownText.visible = false;
    state.countdownLastSecond = -1;
  }

  function showCountdownMessage(msg, sec) {
    var rootNode = getCountdownRoot();
    if (sec === state.countdownLastSecond && state.countdownText && state.countdownText.text === msg) return;
    state.countdownLastSecond = sec;

    if (!state.countdownText && rootNode && getFgui().GTextField) {
      try {
        state.countdownText = new (getFgui().GTextField)();
        state.countdownText.name = 'saltQueueMarchCountdown';
        state.countdownText.touchable = false;
        state.countdownText.fontSize = 16;
        state.countdownText.color = '#ffe3a1';
        state.countdownText.stroke = 2;
        state.countdownText.strokeColor = '#3b1e12';
        state.countdownText.singleLine = true;
        setNodeSize(state.countdownText, 460, 28);
        setNodePos(state.countdownText, 32, 60);
        rootNode.addChild(state.countdownText);
      } catch (e) {}
    }
    var tf = state.countdownText;
    if (tf) {
      tf.text = msg;
      tf.visible = true;
    }
    logInfo(msg);
  }

  function updateMarchCountdown(player, isReturning) {
    if (!player || !isMarchState(player) || !Number(player.endMarchTime)) return hideMarchCountdown();
    var endTime = normalizeTimestamp(player.endMarchTime);
    var remainMs = Math.max(0, endTime - getServerTimeNow());
    var remainSec = Math.ceil(remainMs / 1000);
    var prefix = isReturning ? '返回原建筑' : '前往锁定建筑';
    showCountdownMessage(prefix + '：' + remainSec + '秒', remainSec);
  }

  function updateTargetArrivalCountdown(lockRecord, targetPlayer) {
    if (!lockRecord || !lockRecord.waitingForTarget) return false;
    var marchDest = getMarchDestination(targetPlayer);
    if (marchDest) {
      lockRecord.targetEndMarchTime = Number(marchDest.march && marchDest.march.endTime) || lockRecord.targetEndMarchTime || 0;
      if (!lockRecord.destinationKnown) {
        lockRecord.buildingId = marchDest.buildingId || '';
        lockRecord.position = marchDest.position;
        lockRecord.destinationKnown = !!(lockRecord.buildingId || lockRecord.position);
      }
    }
    var endTs = normalizeTimestamp(Number(lockRecord.targetEndMarchTime) || Number(targetPlayer && targetPlayer.endMarchTime) || 0);
    if (!endTs) {
      hideMarchCountdown();
      return false;
    }
    var remainMs = Math.max(0, endTs - getServerTimeNow());
    var remainSec = Math.ceil(remainMs / 1000);
    var targetName = getPlayerName(targetPlayer) || ('ID:' + getRoleCodeId(targetPlayer));
    var destName = getPlayerMarchTargetName(targetPlayer);
    var msg = '锁定【' + targetName + '】' + (destName ? ('前往[' + destName + ']') : '') + ' 剩余 ' + remainSec + ' 秒到达';
    showCountdownMessage(msg, remainSec);
    return true;
  }

  function updateLockedBattleCountdown(selfPlayer, targetId) {
    var endTs = getLockedBattleEndTime(selfPlayer, targetId);
    if (!endTs) return showCountdownMessage('正在与锁定目标战斗', -2);
    var remainMs = Math.max(0, endTs - getServerTimeNow());
    var remainSec = Math.ceil(remainMs / 1000);
    showCountdownMessage('与锁定目标战斗还有 ' + remainSec + ' 秒', remainSec);
  }

  function updateThirdPartyBattleCountdown(battle, lockRecord) {
    if (!battle) return false;
    var endTs = Number(battle.endTime) || 0;
    var remainSec = endTs > 0 ? Math.ceil(Math.max(0, endTs - getServerTimeNow()) / 1000) : -1;
    var battleKey = battle.leftId + '>' + battle.rightId + '@' + endTs;
    if (lockRecord && lockRecord.waitingBattleKey !== battleKey) {
      lockRecord.waitingBattleKey = battleKey;
      logInfo('识别第三方战斗:', battle.leftId, '攻击', battle.rightId, '结束时间:', endTs);
    }
    showCountdownMessage(remainSec >= 0 ? ('锁定目标战斗中，剩余 ' + remainSec + ' 秒') : '锁定目标正在第三方战斗，等待回到队列', remainSec >= 0 ? remainSec : -3);
    return true;
  }

  function layoutTeamSummaryText(item, summaryTextNode, player) {
    if (!item || !summaryTextNode) return;
    var strengthNode = findStrengthTextNode(item);
    var statusNode = findStatusTextNode(item);
    var nameNode = findPlayerNameTextNode(item, player);
    var anchorNode = strengthNode || statusNode || nameNode;
    var startX = anchorNode && typeof anchorNode.x === 'number' ? anchorNode.x : 118;
    var startY = anchorNode && typeof anchorNode.y === 'number' ? anchorNode.y : 28;
    var targetY = startY;

    var lockBtn = item.__saltQueueLockButton;
    var fightBtn = item.m_btnFight;
    var rightBoundary = (lockBtn && lockBtn.visible) ? (Number(lockBtn.x) || 320) : (fightBtn ? (Number(fightBtn.x) || 400) : (item.width || 520) - 8);

    copyTextStyle(anchorNode, summaryTextNode);
    summaryTextNode.fontSize = Math.max(12, Math.min(14, Number(summaryTextNode.fontSize) || 14));
    summaryTextNode.color = '#79ff4d';
    summaryTextNode.bold = true;
    summaryTextNode.align = 'left';
    summaryTextNode.verticalAlign = 'middle';
    summaryTextNode.sortingOrder = 9998;

    var itemH = Number(item.height) || 84;
    var baseNode = strengthNode || statusNode;
    if (baseNode && itemH >= 76) {
      startX = typeof baseNode.x === 'number' ? baseNode.x : 118;
      targetY = (Number(baseNode.y) || 36) + (Number(baseNode.height) || 20) + 2;
    } else if (strengthNode) {
      startX = strengthNode.x + estimateTextWidth(strengthNode) + 10;
      targetY = strengthNode.y;
    } else if (statusNode) {
      startX = statusNode.x + estimateTextWidth(statusNode) + 10;
      targetY = statusNode.y;
    } else if (nameNode) {
      startX = nameNode.x;
      targetY = (Number(nameNode.y) || 18) + (Number(nameNode.height) || 22) + 4;
    }

    var maxRight = rightBoundary - 8;
    startX = Math.min(startX, Math.max(118, maxRight - 100));
    var textW = estimateTextWidth(summaryTextNode) + 8;
    var finalW = Math.max(80, Math.min(textW, maxRight - startX));

    setNodeSize(summaryTextNode, finalW, 22);
    setNodePos(summaryTextNode, startX, targetY);
  }

  function layoutRemainingText(item, remainingTextNode) {
    if (remainingTextNode) remainingTextNode.visible = false;
    return false;
  }

  function layoutRoleIdText(item, roleIdTextNode, player) {
    if (!item || !roleIdTextNode) return;
    var nameNode = findPlayerNameTextNode(item, player);
    var strengthNode = findStrengthTextNode(item);
    var styleSource = strengthNode || nameNode;

    copyTextStyle(styleSource, roleIdTextNode);
    var baseFontSize = Number((styleSource && styleSource.fontSize) || roleIdTextNode.fontSize || 15);
    roleIdTextNode.fontSize = Math.max(10, Math.min(12, baseFontSize - 3));
    roleIdTextNode.bold = false;
    roleIdTextNode.color = '#c9a17e';

    var fightBtnX = item.m_btnFight && typeof item.m_btnFight.x === 'number' ? item.m_btnFight.x : (item.width || 520) - 8;
    var lockBtn = item.__saltQueueLockButton;
    var rightLimit = (lockBtn && lockBtn.visible) ? (Number(lockBtn.x) || 320) : fightBtnX;

    if (nameNode) {
      var nameW = estimateTextWidth(nameNode);
      var idW = estimateTextWidth(roleIdTextNode) + 6;
      var candidateX = nameNode.x + nameW + 8;
      if (candidateX + idW <= rightLimit - 10) {
        setNodeSize(roleIdTextNode, idW, roleIdTextNode.fontSize + 4);
        setNodePos(roleIdTextNode, candidateX, nameNode.y + Math.max(0, ((nameNode.height || 20) - roleIdTextNode.fontSize) / 2));
        return;
      }
    }

    var fallbackX = nameNode && typeof nameNode.x === 'number' ? nameNode.x : 118;
    var fallbackY = nameNode ? (nameNode.y + (nameNode.height || 20) + 2) : 22;
    setNodeSize(roleIdTextNode, 80, roleIdTextNode.fontSize + 4);
    setNodePos(roleIdTextNode, fallbackX, fallbackY);
  }

  function renderTeamSummary(item, player, summary) {
    var tf = ensureTextField(item, '__saltQueueSummaryText', 'saltQueueSummary', false);
    if (!tf) return;
    var count = getPlayerHeroCount(player);
    var isWeak = isWeakTroop(player);
    var weakPrefix = isWeak ? ('[残将 ' + count + '人] ') : '';
    tf.text = weakPrefix + '阵容:' + (summary && summary.label || '识别中') + ' ' + (summary && summary.total ? (summary.alive + '/' + summary.total) : '--/5');
    try {
      tf.color = isWeak ? '#ffa726' : '#fff4df';
    } catch (e) {}
    tf.visible = true;
    tf.touchable = false;
    layoutTeamSummaryText(item, tf, player);
  }

  function renderTeamRemaining(item, summary) {
    var tf = item && item.__saltQueueRemainingText;
    if (tf) tf.visible = false;
  }

  function renderPlayerRoleId(item, player) {
    var codeId = getRoleCodeId(player);
    var existingNode = findRoleIdTextNode(item);
    if (existingNode && existingNode !== item.__saltQueueRoleIdText) {
      if (item.__saltQueueRoleIdText) item.__saltQueueRoleIdText.visible = false;
      return;
    }
    var tf = ensureTextField(item, '__saltQueueRoleIdText', 'saltQueueRoleId', false);
    if (!tf || !codeId) {
      if (tf) tf.visible = false;
      return;
    }
    tf.text = 'ID:' + codeId;
    tf.visible = true;
    tf.touchable = false;
    layoutRoleIdText(item, tf, player);
  }

  function hideLockOverlay(item) {
    if (!item) return;
    if (item.__saltQueueLockBoxText) {
      item.__saltQueueLockBoxText.visible = false;
      item.__saltQueueLockBoxText.touchable = false;
    }
    if (item.__saltQueueLockCheckText) {
      item.__saltQueueLockCheckText.visible = false;
      item.__saltQueueLockCheckText.touchable = false;
    }
    if (item.__saltQueueLockText) {
      item.__saltQueueLockText.visible = false;
      item.__saltQueueLockText.touchable = false;
      item.__saltQueueLockText.text = '';
    }
  }

  function hideSaltQueueOverlay(item) {
    if (!item) return;
    if (item.__saltQueueSummaryText) item.__saltQueueSummaryText.visible = false;
    if (item.__saltQueueRoleIdText) item.__saltQueueRoleIdText.visible = false;
    if (item.__saltQueueRemainingText) item.__saltQueueRemainingText.visible = false;
    if (item.__saltQueueMarchRemainText) item.__saltQueueMarchRemainText.visible = false;
    hideLockOverlay(item);
    if (item.__saltQueueLockButton) {
      item.__saltQueueLockButton.visible = false;
      item.__saltQueueLockButton.touchable = false;
    }
  }

  /* ============================================================================
   * 6.5 FLOAT DASHBOARD & WEAK TROOP COMBAT (全局悬浮球、控制面板与智能扫残)
   * ============================================================================ */

  function lockWeakTroopsInCurrentBuilding() {
    var bf = getBattlefield();
    var selfPlayer = bf && bf.self;
    var curBuilding = (selfPlayer && selfPlayer.curBuilding) || state.lastActiveBuilding;

    if (!curBuilding) {
      showCountdownMessage('未在据点内，请先进入或选中据点', -1);
      return 0;
    }

    var candidates = [];
    var seenIds = {};
    var lists = [
      curBuilding.defenseList || curBuilding.defenderList || [],
      curBuilding.attackList || curBuilding.attackerList || []
    ];

    lists.forEach(function (list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (p) {
        if (!p || isSelfPlayer(p) || isAlliedPlayer(p)) return;
        var tid = getAttackTargetId(p);
        if (!tid || seenIds[tid]) return;
        seenIds[tid] = true;
        if (isWeakTroop(p)) {
          candidates.push(p);
        }
      });
    });

    if (candidates.length === 0) {
      showCountdownMessage('据点内未发现 ≤' + (state.weakHeroLimit || 4) + ' 人的残将目标', -1);
      return 0;
    }

    var added = 0;
    candidates.forEach(function (p) {
      if (!getLockedTargetRecord(getAttackTargetId(p))) {
        toggleLockedTarget(p);
        added++;
      }
    });

    showCountdownMessage('已锁定 ' + added + ' 个残将 (≤' + (state.weakHeroLimit || 4) + '人)', -1);
    updateControlPanelUI();
    return added;
  }

  function ensureFloatStyles() {
    if (typeof document === 'undefined' || document.getElementById('__salt_enhancer_styles')) return;
    var style = document.createElement('style');
    style.id = '__salt_enhancer_styles';
    style.textContent = `
      #__salt_float_ball {
        position: fixed;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: linear-gradient(135deg, rgba(35, 42, 58, 0.95), rgba(18, 22, 33, 0.98));
        border: 2px solid rgba(255, 215, 0, 0.55);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.2);
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        color: #fff;
        touch-action: none;
        -webkit-tap-highlight-color: transparent;
        transition: transform 0.12s ease, border-color 0.25s ease, box-shadow 0.25s ease;
      }
      #__salt_float_ball:active { cursor: grabbing; transform: scale(0.92); }
      #__salt_float_ball.glow-green {
        border-color: #52c41a;
        box-shadow: 0 0 16px rgba(82, 196, 26, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.3);
        animation: saltGlowPulseGreen 2.2s infinite;
      }
      #__salt_float_ball.glow-blue {
        border-color: #1890ff;
        box-shadow: 0 0 16px rgba(24, 144, 255, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.3);
        animation: saltGlowPulseBlue 2.2s infinite;
      }
      @keyframes saltGlowPulseGreen {
        0%, 100% { box-shadow: 0 0 6px rgba(82, 196, 26, 0.4); }
        50% { box-shadow: 0 0 18px rgba(82, 196, 26, 0.9); }
      }
      @keyframes saltGlowPulseBlue {
        0%, 100% { box-shadow: 0 0 6px rgba(24, 144, 255, 0.4); }
        50% { box-shadow: 0 0 18px rgba(24, 144, 255, 0.9); }
      }
      #__salt_float_badge {
        position: absolute;
        top: -4px;
        right: -4px;
        background: #ff4d4f;
        color: #fff;
        font-size: 11px;
        font-weight: bold;
        padding: 1px 5px;
        min-width: 16px;
        height: 16px;
        line-height: 16px;
        text-align: center;
        border-radius: 9px;
        border: 1.5px solid #fff;
        display: none;
        box-sizing: border-box;
      }
      #__salt_control_panel {
        position: fixed;
        width: 292px;
        max-width: calc(100vw - 20px);
        background: #161b28;
        background: rgba(22, 27, 40, 0.96);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border: 1px solid rgba(255, 215, 0, 0.4);
        border-radius: 12px;
        box-shadow: 0 10px 36px rgba(0, 0, 0, 0.7);
        color: #e6edf3;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        z-index: 2147483646;
        display: none;
        flex-direction: column;
        overflow: hidden;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
        box-sizing: border-box;
      }
      #__salt_control_panel.show {
        display: flex;
        animation: saltFadeIn 0.18s ease-out;
      }
      @keyframes saltFadeIn {
        from { opacity: 0; transform: translateY(-6px) scale(0.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .salt-p-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: rgba(30, 37, 54, 0.9);
        border-bottom: 1px solid rgba(255, 215, 0, 0.25);
        touch-action: none;
      }
      .salt-p-title {
        font-size: 14px;
        font-weight: bold;
        color: #ffd700;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .salt-p-title small {
        font-size: 11px;
        color: #8b949e;
        font-weight: normal;
      }
      .salt-p-close {
        cursor: pointer;
        color: #8b949e;
        font-size: 18px;
        padding: 4px 8px;
        border-radius: 4px;
        line-height: 1;
        transition: color 0.15s, background 0.15s;
        -webkit-tap-highlight-color: transparent;
      }
      .salt-p-close:hover, .salt-p-close:active {
        color: #fff;
        background: rgba(255, 255, 255, 0.18);
      }
      .salt-p-body {
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-height: calc(100vh - 90px);
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }
      .salt-grid-switches {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .salt-switch-card {
        display: flex;
        align-items: center;
        padding: 8px 10px;
        background: rgba(35, 42, 60, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.18s;
        -webkit-tap-highlight-color: transparent;
      }
      .salt-switch-card:hover, .salt-switch-card:active {
        background: rgba(45, 54, 76, 0.85);
        border-color: rgba(255, 215, 0, 0.4);
      }
      .salt-switch-card.on {
        background: rgba(18, 54, 30, 0.75);
        border-color: #52c41a;
        box-shadow: 0 0 10px rgba(82, 196, 26, 0.25);
      }
      .salt-sw-icon {
        font-size: 20px;
        margin-right: 8px;
      }
      .salt-sw-text {
        display: flex;
        flex-direction: column;
      }
      .salt-sw-name {
        font-size: 12px;
        font-weight: bold;
        color: #e6edf3;
      }
      .salt-sw-status {
        font-size: 11px;
        color: #8b949e;
      }
      .salt-switch-card.on .salt-sw-status {
        color: #52c41a;
        font-weight: bold;
      }
      .salt-p-box {
        background: rgba(30, 36, 50, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .salt-box-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .salt-box-title {
        font-weight: bold;
        color: #ffd700;
        font-size: 12px;
      }
      .salt-box-badge {
        font-size: 11px;
        color: #58a6ff;
        background: rgba(88, 166, 255, 0.12);
        padding: 1px 6px;
        border-radius: 10px;
      }
      .salt-target-info {
        font-size: 12px;
        color: #ff7b72;
        font-weight: bold;
        word-break: break-all;
      }
      .salt-target-sub {
        font-size: 11px;
        color: #8b949e;
      }
      .salt-seg-group {
        display: flex;
        background: rgba(18, 22, 33, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 2px;
        gap: 2px;
      }
      .salt-seg-btn {
        flex: 1;
        background: transparent;
        border: none;
        color: #8b949e;
        padding: 6px 0;
        font-size: 11px;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.15s;
        -webkit-tap-highlight-color: transparent;
      }
      .salt-seg-btn:active {
        background: rgba(255, 255, 255, 0.1);
      }
      .salt-seg-btn.active {
        background: #1f6feb;
        color: #fff;
        font-weight: bold;
      }
      .salt-action-row {
        display: flex;
        gap: 8px;
      }
      .salt-act-btn {
        flex: 1;
        padding: 7px 0;
        border-radius: 6px;
        border: 1px solid transparent;
        font-size: 12px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.15s;
        -webkit-tap-highlight-color: transparent;
      }
      .salt-act-btn:active {
        transform: scale(0.97);
      }
      .salt-btn-warn {
        background: linear-gradient(135deg, #d48806, #ad6800);
        color: #fff;
        border-color: #ffd591;
      }
      .salt-btn-warn:active {
        background: #ad6800;
      }
      .salt-btn-danger {
        background: rgba(218, 54, 51, 0.2);
        color: #ff7b72;
        border-color: rgba(248, 81, 73, 0.4);
      }
      .salt-btn-danger:active {
        background: rgba(218, 54, 51, 0.4);
      }
      .salt-ally-box {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 10px;
        background: rgba(30, 36, 50, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        font-size: 12px;
      }
      .salt-mini-btn {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #8b949e;
        border-radius: 4px;
        font-size: 11px;
        padding: 2px 8px;
        cursor: pointer;
        transition: all 0.15s;
        -webkit-tap-highlight-color: transparent;
      }
      .salt-mini-btn:hover, .salt-mini-btn:active {
        color: #ff4d4f;
        border-color: #ff4d4f;
      }
    `;
    if (document.head) {
      document.head.appendChild(style);
    } else {
      (document.body || document.documentElement).appendChild(style);
    }
  }

  function initFloatDashboard() {
    if (typeof document === 'undefined' || state.destroyed || document.getElementById('__salt_float_ball')) return;
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initFloatDashboard, { once: true });
      } else {
        window.setTimeout(initFloatDashboard, 150);
      }
      return;
    }
    ensureFloatStyles();

    // 1. 创建悬浮球
    var ball = document.createElement('div');
    ball.id = '__salt_float_ball';
    ball.innerHTML = '⚔️<span id="__salt_float_badge"></span>';
    document.body.appendChild(ball);

    // 2. 创建主面板
    var panel = document.createElement('div');
    panel.id = '__salt_control_panel';
    panel.innerHTML = `
      <div class="salt-p-header">
        <div class="salt-p-title">⚔️ 盐场指挥官 <small>v2.0</small></div>
        <div class="salt-p-close" id="salt_btn_panel_close">✕</div>
      </div>
      <div class="salt-p-body">
        <div class="salt-grid-switches">
          <div class="salt-switch-card" id="salt_card_speedup">
            <span class="salt-sw-icon">⚡</span>
            <div class="salt-sw-text">
              <span class="salt-sw-name">行军加速</span>
              <span class="salt-sw-status" id="salt_lbl_speedup">已关闭</span>
            </div>
          </div>
          <div class="salt-switch-card" id="salt_card_autodig">
            <span class="salt-sw-icon">⛏️</span>
            <div class="salt-sw-text">
              <span class="salt-sw-name">自动刨地</span>
              <span class="salt-sw-status" id="salt_lbl_autodig">已关闭</span>
            </div>
          </div>
        </div>

        <div class="salt-p-box">
          <div class="salt-box-header">
            <span class="salt-box-title">🎯 锁头与作战状态</span>
            <span class="salt-box-badge" id="salt_lbl_lock_queue">排队: 0人</span>
          </div>
          <div class="salt-target-info" id="salt_lbl_target_info">待机中 (无锁定目标)</div>
          <div class="salt-target-sub" id="salt_lbl_target_sub">点击部队列表【锁定】即可指派</div>
        </div>

        <div class="salt-p-box">
          <div class="salt-box-header">
            <span class="salt-box-title">🎯 残将猎杀阈值</span>
            <span class="salt-box-badge" id="salt_lbl_weak_rule">≤4人未满编</span>
          </div>
          <div class="salt-seg-group">
            <button class="salt-seg-btn" data-limit="1">≤ 1人</button>
            <button class="salt-seg-btn" data-limit="2">≤ 2人</button>
            <button class="salt-seg-btn" data-limit="3">≤ 3人</button>
            <button class="salt-seg-btn active" data-limit="4">≤ 4人</button>
          </div>
          <div class="salt-action-row">
            <button class="salt-act-btn salt-btn-warn" id="salt_btn_scan_weak">🎯 锁全场残将</button>
            <button class="salt-act-btn salt-btn-danger" id="salt_btn_clear_all">❌ 清空全部锁定</button>
          </div>
        </div>

        <div class="salt-ally-box">
          <span>🤝 今日盟友: <b id="salt_lbl_ally_num" style="color:#52c41a">0</b> 家俱乐部</span>
          <button class="salt-mini-btn" id="salt_btn_reset_ally">清空</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // 3. 读取悬浮球记忆位置
    var defaultRight = 16;
    var defaultTop = 150;
    try {
      var savedPos = JSON.parse(localStorage.getItem(FLOAT_POS_STORAGE_KEY));
      if (savedPos && isFinite(savedPos.x) && isFinite(savedPos.y)) {
        ball.style.left = savedPos.x + 'px';
        ball.style.top = savedPos.y + 'px';
      } else {
        ball.style.right = defaultRight + 'px';
        ball.style.top = defaultTop + 'px';
      }
    } catch (e) {
      ball.style.right = defaultRight + 'px';
      ball.style.top = defaultTop + 'px';
    }

    // 4. 移动端触屏与 PC 鼠标手势处理（手势分离与防抖判定）
    var isDragging = false;
    var dragMoved = false;
    var maxMoveDist = 0;
    var pointerDownTime = 0;
    var startX = 0, startY = 0;
    var initLeft = 0, initTop = 0;

    function getVp() {
      var w = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 375;
      var h = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 667;
      return { w: w, h: h };
    }

    function onPointerDown(clientX, clientY) {
      isDragging = true;
      dragMoved = false;
      maxMoveDist = 0;
      pointerDownTime = Date.now();
      startX = clientX;
      startY = clientY;
      var rect = ball.getBoundingClientRect();
      initLeft = rect.left;
      initTop = rect.top;
      ball.style.right = 'auto';
      ball.style.left = initLeft + 'px';
      ball.style.top = initTop + 'px';
    }

    function onPointerMove(clientX, clientY) {
      if (!isDragging) return;
      var dx = clientX - startX;
      var dy = clientY - startY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > maxMoveDist) maxMoveDist = dist;

      // 移动端防抖阈值：位移超过 10px 才算开始移动，防止手指点按时的天然微颤
      if (dist > 10) {
        dragMoved = true;
        var vp = getVp();
        var newLeft = Math.max(6, Math.min(vp.w - 50, initLeft + dx));
        var newTop = Math.max(6, Math.min(vp.h - 50, initTop + dy));
        ball.style.left = newLeft + 'px';
        ball.style.top = newTop + 'px';
      }
    }

    function onPointerUp() {
      if (!isDragging) return;
      isDragging = false;
      var duration = Date.now() - pointerDownTime;

      // 判定为纯点击：位移在 14px 以内，或按住时间短于 280ms 且位移小于 22px
      if (!dragMoved || maxMoveDist < 14 || (duration < 280 && maxMoveDist < 22)) {
        ball.style.left = initLeft + 'px';
        ball.style.top = initTop + 'px';
        toggleControlPanel();
        return;
      }

      // 真正拖拽后的边缘智能吸附
      var rect = ball.getBoundingClientRect();
      var vp = getVp();
      var snapLeft = (rect.left + 22 < vp.w / 2) ? 10 : (vp.w - 54);
      var snapTop = Math.max(10, Math.min(vp.h - 54, rect.top));
      ball.style.transition = 'left 0.2s cubic-bezier(0.25, 1, 0.5, 1), top 0.2s ease';
      ball.style.left = snapLeft + 'px';
      ball.style.top = snapTop + 'px';
      window.setTimeout(function () {
        ball.style.transition = 'transform 0.12s ease, border-color 0.25s ease, box-shadow 0.25s ease';
      }, 220);

      try {
        localStorage.setItem(FLOAT_POS_STORAGE_KEY, JSON.stringify({ x: snapLeft, y: snapTop }));
      } catch (e) {}

      if (state.dashboardVisible) positionControlPanel();
    }

    // 绑定移动端触摸事件（严防穿透到底层游戏 Canvas）
    ball.addEventListener('touchstart', function (e) {
      if (!e.touches || e.touches.length === 0) return;
      var t = e.touches[0];
      onPointerDown(t.clientX, t.clientY);
      e.stopPropagation();
    }, { passive: false });

    ball.addEventListener('touchmove', function (e) {
      if (!e.touches || e.touches.length === 0) return;
      var t = e.touches[0];
      onPointerMove(t.clientX, t.clientY);
      if (dragMoved && e.cancelable) {
        e.preventDefault(); // 拖动悬浮球时禁止整页滚动
      }
      e.stopPropagation();
    }, { passive: false });

    ball.addEventListener('touchend', function (e) {
      onPointerUp();
      e.stopPropagation();
    }, { passive: false });

    ball.addEventListener('touchcancel', function (e) {
      if (isDragging) {
        isDragging = false;
        dragMoved = false;
        ball.style.left = initLeft + 'px';
        ball.style.top = initTop + 'px';
      }
      e.stopPropagation();
    }, { passive: false });

    // 绑定 PC 鼠标事件
    ball.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      onPointerDown(e.clientX, e.clientY);
      function onMouseMove(ev) { onPointerMove(ev.clientX, ev.clientY); }
      function onMouseUp() {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        onPointerUp();
      }
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      e.stopPropagation();
    });

    // 隔离面板本身的触摸事件，杜绝操作面板穿透到底层游戏
    panel.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });
    panel.addEventListener('touchmove', function (e) { e.stopPropagation(); }, { passive: true });
    panel.addEventListener('touchend', function (e) { e.stopPropagation(); }, { passive: true });
    panel.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    // 5. 跨端防抖点击绑定辅助工具
    function bindFastClick(element, handler) {
      if (!element) return;
      var lastTime = 0;
      function onAction(e) {
        var now = Date.now();
        if (now - lastTime < 320) return;
        lastTime = now;
        handler(e);
        if (e && e.stopPropagation) e.stopPropagation();
      }
      element.addEventListener('click', onAction);
      element.addEventListener('touchend', onAction);
    }

    // 6. 控制面板交互事件绑定
    bindFastClick(document.getElementById('salt_btn_panel_close'), function () {
      closeControlPanel();
    });

    bindFastClick(document.getElementById('salt_card_speedup'), function () {
      toggleAutoSpeedUp();
    });

    bindFastClick(document.getElementById('salt_card_autodig'), function () {
      toggleAutoDig();
    });

    var segButtons = panel.querySelectorAll('.salt-seg-btn');
    segButtons.forEach(function (btn) {
      bindFastClick(btn, function () {
        var limit = Number(btn.getAttribute('data-limit')) || 4;
        setWeakHeroLimit(limit);
      });
    });

    bindFastClick(document.getElementById('salt_btn_scan_weak'), function () {
      lockWeakTroopsInCurrentBuilding();
    });

    bindFastClick(document.getElementById('salt_btn_clear_all'), function () {
      clearAllLockedTargets();
      updateControlPanelUI();
    });

    bindFastClick(document.getElementById('salt_btn_reset_ally'), function () {
      clearAllLockedTargets();
      state.alliedLegions = { date: getTodayDateKey(), ids: [], names: [] };
      saveAlliedLegions();
      showCountdownMessage('已重置清空今日盟友白名单', -1);
      updateControlPanelUI();
    });

    updateControlPanelUI();
  }

  function positionControlPanel() {
    var ball = document.getElementById('__salt_float_ball');
    var panel = document.getElementById('__salt_control_panel');
    if (!ball || !panel) return;
    var rect = ball.getBoundingClientRect();
    var vpWidth = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 375;
    var vpHeight = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 667;

    var panelWidth = Math.min(292, Math.max(260, vpWidth - 20));
    panel.style.width = panelWidth + 'px';
    var panelHeight = panel.offsetHeight || 380;

    var panelLeft;
    if (vpWidth <= 340) {
      panelLeft = Math.max(10, Math.round((vpWidth - panelWidth) / 2));
    } else if (rect.left + 22 > vpWidth / 2) {
      panelLeft = Math.max(10, rect.left - panelWidth - 10);
    } else {
      panelLeft = Math.min(vpWidth - panelWidth - 10, rect.right + 10);
    }

    var panelTop = Math.max(10, Math.min(vpHeight - panelHeight - 10, rect.top - 20));
    panel.style.left = panelLeft + 'px';
    panel.style.top = panelTop + 'px';
  }

  function openControlPanel() {
    var panel = document.getElementById('__salt_control_panel');
    if (!panel) return;
    state.dashboardVisible = true;
    panel.classList.add('show');
    positionControlPanel();
    updateControlPanelUI();
  }

  function closeControlPanel() {
    var panel = document.getElementById('__salt_control_panel');
    if (!panel) return;
    state.dashboardVisible = false;
    panel.classList.remove('show');
  }

  function toggleControlPanel() {
    if (state.dashboardVisible) closeControlPanel();
    else openControlPanel();
  }

  function updateControlPanelUI() {
    if (typeof document === 'undefined' || state.destroyed) return;
    var ball = document.getElementById('__salt_float_ball');
    var badge = document.getElementById('__salt_float_badge');
    var panel = document.getElementById('__salt_control_panel');

    var curLockCount = (state.lockedTarget ? 1 : 0) + (state.lockQueue ? state.lockQueue.length : 0);

    // 1. 悬浮球角标与呼吸灯更新
    if (ball) {
      if (badge) {
        if (curLockCount > 0) {
          badge.textContent = curLockCount > 99 ? '99+' : curLockCount;
          badge.style.display = 'block';
        } else {
          badge.style.display = 'none';
        }
      }
      ball.classList.remove('glow-green', 'glow-blue');
      if (state.autoSpeedUp || state.autoDig) {
        ball.classList.add('glow-green');
      } else if (curLockCount > 0) {
        ball.classList.add('glow-blue');
      }
    }

    if (!panel) return;

    // 2. 开关卡片状态同步
    var cardSpeed = document.getElementById('salt_card_speedup');
    var lblSpeed = document.getElementById('salt_lbl_speedup');
    if (cardSpeed && lblSpeed) {
      if (state.autoSpeedUp) {
        cardSpeed.classList.add('on');
        lblSpeed.textContent = '开启中';
      } else {
        cardSpeed.classList.remove('on');
        lblSpeed.textContent = '已关闭';
      }
    }

    var cardDig = document.getElementById('salt_card_autodig');
    var lblDig = document.getElementById('salt_lbl_autodig');
    if (cardDig && lblDig) {
      if (state.autoDig) {
        cardDig.classList.add('on');
        lblDig.textContent = '开启中';
      } else {
        cardDig.classList.remove('on');
        lblDig.textContent = '已关闭';
      }
    }

    // 3. 锁头监控文字与排队人数
    var lblQueue = document.getElementById('salt_lbl_lock_queue');
    var lblTarget = document.getElementById('salt_lbl_target_info');
    var lblSub = document.getElementById('salt_lbl_target_sub');

    if (lblQueue) lblQueue.textContent = '排队: ' + curLockCount + '人';

    if (lblTarget && lblSub) {
      if (state.lockedTarget) {
        var t = state.lockedTarget;
        var pName = (t.target && getPlayerName(t.target)) || (t.target && t.target.name) || t.targetId;
        var statusStr = t.engaged ? '【交战中】' : (t.returning ? '【返航中】' : '【行军/出击中】');
        lblTarget.textContent = statusStr + ' ' + pName;
        lblTarget.style.color = '#52c41a';
        lblSub.textContent = '目的据点: ' + (t.buildingId || '未知') + ' (剩余排队:' + (state.lockQueue.length) + ')';
      } else {
        lblTarget.textContent = '待机中 (无锁定目标)';
        lblTarget.style.color = '#58a6ff';
        lblSub.textContent = '可在部队列表点【锁定】或点下方一键扫残';
      }
    }

    // 4. 残将分段按钮激活高亮
    var limit = Number(state.weakHeroLimit) || 4;
    var segButtons = panel.querySelectorAll('.salt-seg-btn');
    segButtons.forEach(function (btn) {
      var bLimit = Number(btn.getAttribute('data-limit'));
      if (bLimit === limit) btn.classList.add('active');
      else btn.classList.remove('active');
    });

    var lblWeakRule = document.getElementById('salt_lbl_weak_rule');
    if (lblWeakRule) {
      lblWeakRule.textContent = limit === 4 ? '≤4人未满编' : ('≤' + limit + '人极度残编');
    }

    var btnScan = document.getElementById('salt_btn_scan_weak');
    if (btnScan) {
      btnScan.textContent = '🎯 锁残将 (≤' + limit + '人)';
    }

    // 5. 今日盟友俱乐部数量
    var lblAlly = document.getElementById('salt_lbl_ally_num');
    if (lblAlly) {
      var allyCount = (state.alliedLegions && state.alliedLegions.ids) ? state.alliedLegions.ids.length : 0;
      lblAlly.textContent = allyCount;
    }
  }

  function removeFloatDashboard() {
    if (typeof document === 'undefined') return;
    var ball = document.getElementById('__salt_float_ball');
    if (ball && ball.parentNode) ball.parentNode.removeChild(ball);
    var panel = document.getElementById('__salt_control_panel');
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    var styles = document.getElementById('__salt_enhancer_styles');
    if (styles && styles.parentNode) styles.parentNode.removeChild(styles);
  }

  /* ============================================================================
   * 7. TROOP SORTING (部队列表排序核心：游戏原生木纹UI质感 + Schwartzian预计算高性能引擎)
   * ============================================================================ */

  // 降级模式下的自绘高保真木纹圆角按钮背景
  function drawNativeSortButtonBg(graph, active) {
    if (!graph) return;
    try {
      if (typeof graph.clearGraphics === 'function') graph.clearGraphics();
      var hasCc = typeof cc !== 'undefined' && cc && cc.Color;
      var fillColor = hasCc ?
        (active ? new cc.Color(96, 168, 61, 255) : new cc.Color(199, 169, 86, 255)) :
        { r: 199, g: 169, b: 86, a: 255 };
      var lineColor = hasCc ?
        (active ? new cc.Color(36, 85, 32, 255) : new cc.Color(102, 68, 29, 255)) :
        { r: 102, g: 68, b: 29, a: 255 };
      if (typeof graph.drawRect === 'function') {
        graph.drawRect(2, lineColor, fillColor);
      }
    } catch (e) {}
  }

  // 切换排序按钮的高亮与非高亮外观（原生按钮调色 + 自绘降级调色）
  function setNativeSortButtonActive(btn, active) {
    if (!btn) return;
    var label = btn.__sfaLabel || btn;
    if (btn.__sfaIsNative) {
      var colorCtrl = btn.m_color || (typeof btn.getController === 'function' && btn.getController('color'));
      if (colorCtrl) {
        try {
          colorCtrl.selectedPage = active ? 'green' : 'yellow';
        } catch (e) {
          try { colorCtrl.selectedIndex = active ? 1 : 0; } catch (err) {}
        }
      }
      if (label) {
        label.color = active ? '#79ff4d' : '#fff4df';
        if (typeof cc !== 'undefined' && cc.Color) {
          label.shadowColor = active ? new cc.Color(18, 55, 12, 240) : new cc.Color(122, 69, 48, 220);
        }
      }
    } else {
      label.color = active ? '#ffffff' : '#4b2a18';
      drawNativeSortButtonBg(btn.__sfaBg, active);
    }
  }

  // 创建原生 UI 按钮（优先复用 ui_common.BtnSmall 原生木质组件，带颜色控制器与按压缩放反馈）
  function makeNativeSortButton(fg, text, onClick, width, height) {
    if (!fg) fg = getFgui();
    var w = width || 62;
    var h = height || 30;
    var btn = null;

    // 1. 尝试从游戏原生包创建 BtnSmall（真实存在的木质按钮）
    try {
      if (fg && fg.UIPackage && typeof fg.UIPackage.createObject === 'function') {
        btn = fg.UIPackage.createObject('ui_common', 'BtnSmall');
      }
    } catch (e) {
      btn = null;
    }

    if (btn) {
      btn.title = '';
      btn.icon = '';
      // 隐藏内部多余图标/红点节点
      if (btn.numChildren > 0) {
        for (var i = 0; i < btn.numChildren; i++) {
          var ch = btn.getChildAt(i);
          if (ch && (ch.name === 'redPoint' || ch.name === 'n0' || ch.name === 'icon')) {
            ch.visible = false;
          }
        }
      }
      setNodeSize(btn, w, h);

      var nativeLabel = new fg.GTextField();
      nativeLabel.name = 'customLabel';
      nativeLabel.text = text;
      nativeLabel.fontSize = 15;
      nativeLabel.bold = true;
      nativeLabel.color = '#fff4df';
      nativeLabel.align = 'center';
      nativeLabel.verticalAlign = 'middle';
      nativeLabel.singleLine = true;
      nativeLabel.touchable = false;
      setNodeSize(nativeLabel, w, h);
      setNodePos(nativeLabel, 0, 0);

      if (typeof cc !== 'undefined' && cc.Vec2 && cc.Color) {
        nativeLabel.shadowOffset = new cc.Vec2(0, 2);
        nativeLabel.shadowColor = new cc.Color(122, 69, 48, 220);
      }

      btn.addChild(nativeLabel);
      btn.__sfaLabel = nativeLabel;
      btn.__sfaIsNative = true;
      var colorCtrl = btn.m_color || (typeof btn.getController === 'function' && btn.getController('color'));
      if (colorCtrl) {
        try { colorCtrl.selectedPage = 'yellow'; } catch (e) {}
      }
      if (typeof btn.onClick === 'function') btn.onClick(onClick);
      return btn;
    }

    // 2. 降级方案：高保真自绘原生质感按键（带手势按压缩放反馈）
    var comp = new (fg && fg.GComponent ? fg.GComponent : function () {})();
    comp.touchable = true;
    setNodeSize(comp, w, h);

    var bg = new (fg && fg.GGraph ? fg.GGraph : function () {})();
    setNodeSize(bg, w, h);

    var fallbackLabel = new (fg && fg.GTextField ? fg.GTextField : function () {})();
    fallbackLabel.text = text;
    fallbackLabel.fontSize = 15;
    fallbackLabel.bold = true;
    fallbackLabel.align = 'center';
    fallbackLabel.verticalAlign = 'middle';
    fallbackLabel.color = '#4b2a18';
    fallbackLabel.singleLine = true;
    fallbackLabel.touchable = false;
    setNodeSize(fallbackLabel, w, h);
    setNodePos(fallbackLabel, 0, 0);

    if (typeof cc !== 'undefined' && cc.Vec2 && cc.Color) {
      fallbackLabel.shadowOffset = new cc.Vec2(0, 2);
      fallbackLabel.shadowColor = new cc.Color(100, 55, 30, 220);
    }

    comp.addChild(bg);
    comp.addChild(fallbackLabel);
    comp.__sfaBg = bg;
    comp.__sfaLabel = fallbackLabel;
    comp.__sfaIsNative = false;

    // 手势缩放回弹微动效
    if (typeof comp.onTouchBegin === 'function') {
      comp.onTouchBegin(function () {
        if (typeof comp.setScale === 'function') comp.setScale(0.95, 0.95);
      }, comp);
    }
    if (typeof comp.onTouchEnd === 'function') {
      comp.onTouchEnd(function () {
        if (typeof comp.setScale === 'function') comp.setScale(1.0, 1.0);
      }, comp);
    }

    drawNativeSortButtonBg(bg, false);
    if (typeof comp.onClick === 'function') comp.onClick(onClick);
    return comp;
  }

  function updateNativeSortButtons(page) {
    var bar = page && page.__sfaSortBar;
    if (!bar) return;
    var mode = state.sortMode || 'power';
    var isAsc = state.sortOrder === 'asc';

    if (bar.speedUp) {
      setNativeSortButtonActive(bar.speedUp, !!state.autoSpeedUp);
      if (bar.speedUp.__sfaLabel) {
        bar.speedUp.__sfaLabel.text = state.autoSpeedUp ? '⚡加速' : '⚡常规';
        bar.speedUp.__sfaLabel.color = state.autoSpeedUp ? '#79ff4d' : '#fff4df';
      }
      var colorCtrl = bar.speedUp.m_color || (typeof bar.speedUp.getController === 'function' && bar.speedUp.getController('color'));
      if (colorCtrl) {
        try { colorCtrl.selectedPage = state.autoSpeedUp ? 'green' : 'yellow'; } catch (e) {}
      }
    }
    setNativeSortButtonActive(bar.energy, mode === 'energy');
    if (bar.energy && bar.energy.__sfaLabel) {
      bar.energy.__sfaLabel.text = mode === 'energy' ? (isAsc ? '精力 ↑' : '精力 ↓') : '精力';
    }
    setNativeSortButtonActive(bar.power, mode === 'power');
    if (bar.power && bar.power.__sfaLabel) {
      bar.power.__sfaLabel.text = mode === 'power' ? (isAsc ? '战力 ↑' : '战力 ↓') : '战力';
    }
    setNativeSortButtonActive(bar.marchTime, mode === 'marchTime');
    setNativeSortButtonActive(bar.restore, mode === 'default');
  }

  function ensureNativeTroopsSortButtons(page) {
    var ui = page && (page.ui || page.contentPane || page);
    var fg = getFgui();
    if (!ui || !fg || state.destroyed) return;
    var list = ui.m_list || (typeof ui.getChild === 'function' && (ui.getChild('m_list') || ui.getChild('list')));

    if (!page.__sfaSortBar) {
      var root = new fg.GComponent();
      root.name = 'saltQueueSortBarRoot';
      root.touchable = true;
      setNodeSize(root, 342, 30);

      var speedUp = makeNativeSortButton(fg, state.autoSpeedUp ? '⚡加速' : '⚡常规', function () {
        toggleAutoSpeedUp();
      }, 56, 30);
      setNodePos(speedUp, 0, 0);

      var label = new fg.GTextField();
      label.text = '排序:';
      label.fontSize = 15;
      label.bold = true;
      label.color = '#8f4024';
      label.align = 'right';
      label.verticalAlign = 'middle';
      label.singleLine = true;
      label.touchable = false;
      setNodeSize(label, 36, 30);
      setNodePos(label, 58, 0);

      var energy = makeNativeSortButton(fg, '精力', function () {
        if (state.sortMode === 'energy') {
          state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortMode = 'energy';
          state.sortOrder = 'desc';
        }
        updateNativeSortButtons(page);
        requestSortTroopsList(page);
      }, 62, 30);
      setNodePos(energy, 96, 0);

      var power = makeNativeSortButton(fg, '战力', function () {
        if (state.sortMode === 'power') {
          state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortMode = 'power';
          state.sortOrder = 'desc';
        }
        updateNativeSortButtons(page);
        requestSortTroopsList(page);
      }, 62, 30);
      setNodePos(power, 158, 0);

      var marchTime = makeNativeSortButton(fg, '到达', function () {
        state.sortMode = 'marchTime';
        state.sortOrder = 'asc';
        updateNativeSortButtons(page);
        requestSortTroopsList(page);
      }, 62, 30);
      setNodePos(marchTime, 220, 0);

      var restore = makeNativeSortButton(fg, '还原', function () {
        state.sortMode = 'default';
        state.sortOrder = 'desc';
        updateNativeSortButtons(page);
        requestSortTroopsList(page);
      }, 50, 30);
      setNodePos(restore, 282, 0);

      root.addChild(speedUp);
      root.addChild(label);
      root.addChild(energy);
      root.addChild(power);
      root.addChild(marchTime);
      root.addChild(restore);

      ui.addChild(root);
      page.__sfaSortBar = { root: root, speedUp: speedUp, label: label, energy: energy, power: power, marchTime: marchTime, restore: restore };
      if (Array.isArray(state.sortBars)) {
        state.sortBars.push(page.__sfaSortBar);
      }
    }

    // 锚定排版：以列表右侧为基准紧贴右对齐，彻底避让左侧驻扎部队数量文本与分屏裁剪
    var listRight = (list && list.width > 200) ? (Number(list.x || 0) + Number(list.width)) : (Number(ui.width || 720) - 16);
    var rootX = Math.max(10, listRight - 342 - 4);
    var rootY = Math.max(0, Number(list ? list.y : 270) - 36);

    var bar = page.__sfaSortBar;
    if (bar && bar.root) {
      setNodePos(bar.root, rootX, rootY);
      try {
        if (typeof ui.setChildIndex === 'function') {
          ui.setChildIndex(bar.root, Math.max(0, Number(ui.numChildren || 1) - 1));
        }
      } catch (e) {}
    }
    updateNativeSortButtons(page);
  }

  // 帧级防抖合并：将同一渲染帧内连续触发的刷新合并为单次高性能重排
  function requestSortTroopsList(page) {
    if (!page || state.destroyed) return;
    if (page.__sfaSortPending) return;
    page.__sfaSortPending = true;
    window.setTimeout(function () {
      page.__sfaSortPending = false;
      if (state.destroyed) return;
      sortTroopsList(page);
    }, 16);
  }

  // 【高性能核心引擎】：采用 Schwartzian 变换（预提取轻量元组）实现 O(N) 属性映射与 O(N log N) 纯数值排序
  function sortTroopsList(page) {
    if (!page || state.isSorting || state.destroyed) return;
    state.isSorting = true;
    try {
      var ui = page.ui || page.contentPane || page;
      var list = ui && (ui.m_list || (typeof ui.getChild === 'function' && (ui.getChild('m_list') || ui.getChild('list'))));
      var listData = page._listData || (ui && ui._listData) || page._dataList;
      if (!Array.isArray(listData) || listData.length <= 1) return;

      // 备份首次加载的原生排队数据，支持随时无损瞬时还原（如长度发生变动则同步校准）
      if (!page.__sfaOriginalListData || page.__sfaOriginalListData.length !== listData.length) {
        page.__sfaOriginalListData = listData.slice();
      }

      // 1. 还原模式：直接使用原数组拷贝快速复原，零排序运算
      if (state.sortMode === 'default') {
        if (page.__sfaOriginalListData) {
          listData.length = 0;
          for (var k = 0; k < page.__sfaOriginalListData.length; k++) {
            listData.push(page.__sfaOriginalListData[k]);
          }
        }
        if (list) {
          if (typeof list.refreshVirtualList === 'function') list.refreshVirtualList();
          else if (typeof list.numItems === 'number') list.numItems = listData.length;
        }
        return;
      }

      var mode = state.sortMode || 'power';
      var isAsc = state.sortOrder === 'asc';
      var subMode = mode === 'energy' ? 'power' : 'energy';
      var len = listData.length;

      // 2. 【Schwartzian 一次性提取】：遍历 O(N) 完成全部战力、精力、行军残秒的缓存
      // 彻底消除原来在 O(N log N) 次比较中反复发生的深层对象遍历、Set 频繁申请与全图行军 marches.forEach！
      var mapped = new Array(len);
      for (var i = 0; i < len; i++) {
        var it = listData[i];
        var player = (it && it.player) || it;
        var pEnergy = readEnemyEnergy(player);
        var pPower = readEnemyPower(player);
        var pMarch = 999999999;
        if (isMarchState(player)) {
          var remain = getPlayerMarchRemainSeconds(player);
          pMarch = remain > 0 ? remain : 0;
        }
        var pName = String((player && player.name) || (it && it.name) || '');
        var pIsAlly = isAlliedPlayer(player);

        mapped[i] = {
          raw: it,
          idx: i,
          energy: pEnergy,
          power: pPower,
          marchTime: pMarch,
          name: pName,
          isAlly: pIsAlly
        };
      }

      // 3. 【极速纯数值比较】：纯整数字段相减，JIT 内联优化，零 GC 压力
      mapped.sort(function (a, b) {
        // 盟友过滤沉底策略：非默认模式下，盟友自动沉底排在队列末尾，敌对目标优先置顶展示
        if (state.sortMode !== 'default') {
          if (a.isAlly !== b.isAlly) {
            return a.isAlly ? 1 : -1;
          }
        }

        var valA = a[mode];
        var valB = b[mode];
        var diff = isAsc ? (valA - valB) : (valB - valA);
        if (diff !== 0) return diff;

        // 次级优先级决胜
        if (mode === 'marchTime') {
          var powerDiff = b.power - a.power; // 相同到达时间，大战力排前
          if (powerDiff !== 0) return powerDiff;
        } else {
          var subA = a[subMode];
          var subB = b[subMode];
          var subDiff = isAsc ? (subA - subB) : (subB - subA);
          if (subDiff !== 0) return subDiff;
        }

        // 保持稳定排序：数值完全相同时按初始队列索引，杜绝 UI 乱跳
        return a.idx - b.idx;
      });

      // 4. 原地同步回原始引用容器
      for (var j = 0; j < len; j++) {
        listData[j] = mapped[j].raw;
      }

      // 5. 虚拟列表增量刷新（仅重绘视口内条目）
      if (list) {
        if (typeof list.refreshVirtualList === 'function') list.refreshVirtualList();
        else if (typeof list.numItems === 'number') list.numItems = listData.length;
      }
    } catch (e) {
      logWarn('部队排序计算异常:', e && e.message || e);
    } finally {
      state.isSorting = false;
    }
  }

  function updateItemMarchCountdown(item, player) {
    if (!item) return;
    var countdownNode = item.__saltQueueMarchRemainText;
    if (!isMarchState(player)) {
      if (countdownNode) countdownNode.visible = false;
      return;
    }
    var remainSec = getPlayerMarchRemainSeconds(player);
    if (!countdownNode) {
      countdownNode = ensureTextField(item, '__saltQueueMarchRemainText', 'saltQueueMarchRemain', false);
    }
    if (!countdownNode) return;
    countdownNode.text = remainSec > 0 ? (remainSec + 's到达') : '即将到达';
    countdownNode.fontSize = 13;
    countdownNode.bold = true;
    countdownNode.color = '#ff9800';
    countdownNode.singleLine = true;
    countdownNode.touchable = false;
    countdownNode.visible = true;
    countdownNode.sortingOrder = 9996;

    var statusNode = findStatusTextNode(item);
    var countdownW = estimateTextWidth(countdownNode) + 6;
    var lockBtn = item.__saltQueueLockButton;
    var fightBtn = item.m_btnFight;
    var rightLimit = (lockBtn && lockBtn.visible) ? (Number(lockBtn.x) || 320) : (fightBtn ? (Number(fightBtn.x) || 400) : (item.width || 520) - 8);

    var targetX, targetY;
    if (statusNode) {
      var statusRight = (Number(statusNode.x) || 120) + estimateTextWidth(statusNode) + 6;
      if (statusRight + countdownW <= rightLimit - 4) {
        targetX = statusRight;
        targetY = Number(statusNode.y) || 28;
      } else {
        // 横向空间不足时避让至下方，杜绝文字重叠
        targetX = Number(statusNode.x) || 120;
        targetY = (Number(statusNode.y) || 28) + (Number(statusNode.height) || 18) + 2;
      }
    } else {
      targetX = Math.min(180, rightLimit - countdownW - 4);
      targetY = 28;
    }

    targetX = Math.max(118, Math.min(targetX, rightLimit - countdownW - 2));
    countdownNode.align = 'left';
    setNodeSize(countdownNode, countdownW, 20);
    setNodePos(countdownNode, targetX, targetY);
  }

  function updateAllVisibleMarchCountdowns() {
    if (state.destroyed || !state.items || !state.items.length) return;
    for (var i = state.items.length - 1; i >= 0; i--) {
      var it = state.items[i];
      if (!it || it.isDisposed || it._disposed || !it.parent) {
        state.items.splice(i, 1);
        continue;
      }
      if (it.__saltQueuePlayer) {
        updateItemMarchCountdown(it, it.__saltQueuePlayer);
      }
    }
  }

  function startMarchTickTimer() {
    if (state.marchTickTimer) return;
    state.marchTickTimer = window.setInterval(function () {
      if (state.destroyed) return;
      checkAlliedLegionsDayChange();
      updateAllVisibleMarchCountdowns();
      updateControlPanelUI();
    }, 1000);
  }

  function renderPlayerCamp(item, player) {
    if (!item || !player) return;
    var isSelf = isSelfPlayer(player) || isSameLegionTarget(player);
    var isAlly = !isSelf && isAlliedPlayer(player);

    var legionNode = item.m_legion || findTextNodeByProps(item, ['m_legion', 'm_txtLegion', 'm_legionName']);
    if (legionNode && typeof legionNode.text === 'string') {
      var rawName = String(legionNode.text).replace(/^【(?:盟|敌|自家)】/, '');
      if (isSelf) {
        legionNode.color = '#ffe3a1';
        legionNode.text = '【自家】' + rawName;
      } else if (isAlly) {
        legionNode.color = '#79ff4d';
        legionNode.text = '【盟】' + rawName;
      } else {
        legionNode.color = '#ff9c9c';
        legionNode.text = '【敌】' + rawName;
      }
    }
  }

  function refreshItem(item, player) {
    if (state.destroyed || !item) return;
    if (!isPlayerLike(player)) {
      hideSaltQueueOverlay(item);
      item.__saltQueuePlayer = null;
      return;
    }

    item.__saltQueuePlayer = player;
    ensureLockControl(item);
    updateItemMarchCountdown(item, player);
    renderPlayerRoleId(item, player);
    renderPlayerCamp(item, player);

    var cached = getCachedTeamSummary(player);
    if (cached) {
      renderTeamSummary(item, player, cached);
      renderTeamRemaining(item, cached);
    } else {
      renderTeamSummary(item, player, null);
      renderTeamRemaining(item, null);
    }
    updateLockControl(item);

    if (!cached) {
      window.setTimeout(function () {
        if (state.destroyed || item.__saltQueuePlayer !== player) return;
        requestTeamSummary(player, function (summary) {
          if (state.destroyed || item.__saltQueuePlayer !== player) return;
          if (summary) {
            renderTeamSummary(item, player, summary);
            renderTeamRemaining(item, summary);
          }
        });
      }, 120);
    }
  }

  /* ============================================================================
   * 8. AUTO DIG (自动刨地模块)
   * ============================================================================ */

  function updateAutoDigControl(ctrlItem) {
    var btnDig = ctrlItem && ctrlItem.button;
    var lblDig = ctrlItem && ctrlItem.label;
    var buildingPanel = ctrlItem && ctrlItem.panel;
    var buildingData = buildingPanel && buildingPanel._building;
    var isInBuilding = !!(buildingData && buildingData.inBuilding);
    if (!btnDig) return;

    btnDig.visible = isInBuilding;
    btnDig.touchable = isInBuilding;
    btnDig.enabled = true;
    if (lblDig) lblDig.visible = isInBuilding;

    var ctrlIsOpen = btnDig.m_isOpen || (typeof btnDig.getController === 'function' && btnDig.getController('isOpen'));
    var ctrlIsSlide = btnDig.m_isSlide || (typeof btnDig.getController === 'function' && btnDig.getController('isSlide'));

    if (ctrlIsOpen) ctrlIsOpen.selectedPage = String(!!state.autoDig);
    if (ctrlIsSlide) ctrlIsSlide.selectedPage = 'false';

    var targetSlideNode = state.autoDig ? btnDig.m_onSlide : btnDig.m_offSlide;
    if (btnDig.m_slide && targetSlideNode && isFinite(Number(targetSlideNode.x))) {
      btnDig.m_slide.x = Number(targetSlideNode.x);
    }
  }

  function refreshAutoDigControls() {
    state.autoDigControls.forEach(function (ctrl) {
      updateAutoDigControl(ctrl);
    });
  }

  function ensureAutoDigControl(panel) {
    var fg = getFgui();
    var ui = panel && panel.ui;
    var contentPane = (ui && ui.m_content) || ui;
    var origBtn = (contentPane && contentPane.m_btnAutoAttack) || (ui && ui.m_btnAutoAttack);
    var origLabel = (contentPane && contentPane.m_autoAttack) || (ui && ui.m_autoAttack);
    var digBtn = contentPane && contentPane.__saltAutoDigButton;
    var digLabel = contentPane && contentPane.__saltAutoDigLabel;

    if (!contentPane || !origBtn || !fg) return null;

    if (!digBtn && fg.UIPackage) {
      try {
        var resUrl = origBtn.resourceURL;
        digBtn = resUrl && fg.UIPackage.createObjectFromURL(resUrl);
      } catch (e) {
        digBtn = null;
      }
      if (digBtn) {
        digBtn.name = 'saltAutoDigButton';
        contentPane.addChild(digBtn);
        contentPane.__saltAutoDigButton = digBtn;
      }
    }
    if (!digBtn) return null;

    if (!digLabel && fg.GTextField) {
      try {
        digLabel = new fg.GTextField();
      } catch (e) {
        digLabel = null;
      }
      if (digLabel) {
        digLabel.name = 'saltAutoDigLabel';
        digLabel.text = '自动刨地';
        digLabel.touchable = false;
        digLabel.singleLine = true;
        digLabel.autoSize = fg.AutoSizeType ? fg.AutoSizeType.None : 0;

        var sourceTf = origLabel;
        if (sourceTf && !sourceTf.fontSize) {
          sourceTf = (sourceTf.title && sourceTf.title.fontSize ? sourceTf.title : null) ||
            (sourceTf.getChild && (sourceTf.getChild('title') || sourceTf.getChild('text') || sourceTf.getChild('label') || sourceTf.getChild('m_title'))) ||
            sourceTf._titleObject || sourceTf.m_title || origLabel;
        }

        ['font', 'fontSize', 'color', 'bold', 'stroke', 'strokeColor', 'align', 'verticalAlign'].forEach(function (prop) {
          if (sourceTf && sourceTf[prop] !== undefined) digLabel[prop] = sourceTf[prop];
        });
        digLabel.fontSize = 18;
        if (!digLabel.color || digLabel.color === '#ffffff' || digLabel.color === 0xffffff) {
          digLabel.color = (sourceTf && sourceTf.color && sourceTf.color !== '#ffffff' && sourceTf.color !== 0xffffff) ? sourceTf.color : '#682a10';
        }
        digLabel.bold = true;
        digLabel.align = 'left';
        digLabel.verticalAlign = 'middle';
        contentPane.addChild(digLabel);
        contentPane.__saltAutoDigLabel = digLabel;
      }
    }

    var btnW = Number(origBtn.width) || 60;
    var btnH = Number(origBtn.height) || 32;
    var btnY = Number(origBtn.y) || 0;
    var lblW = 88;
    var lblH = Math.max(28, Number(origLabel && origLabel.height) || 32);
    var lblY = isFinite(Number(origLabel && origLabel.y)) ? Number(origLabel.y) : btnY;
    var containerW = Number(contentPane.width) || 720;
    var gap = 6;
    var groupW = btnW + gap + lblW;

    var origLeft = Math.min(Number(origBtn.x) || 0, isFinite(Number(origLabel && origLabel.x)) ? Number(origLabel.x) : Number(origBtn.x) || 0);
    var origRight = Math.max((Number(origBtn.x) || 0) + btnW, isFinite(Number(origLabel && origLabel.x)) ? Number(origLabel.x) + (Number(origLabel.width) || 80) : (Number(origBtn.x) || 0) + btnW);

    var digBtnX, digBtnY, digLblX, digLblY;

    if (origRight + 10 + groupW <= containerW - 6) {
      // 空间充足：排在原生控件右侧
      digBtnX = origRight + 10;
      digBtnY = btnY;
      digLblX = digBtnX + btnW + gap;
      digLblY = lblY;
    } else if (origLeft - 10 - groupW >= 10) {
      // 右侧不足：并排在原生控件左侧空白区
      digBtnX = origLeft - 10 - groupW;
      digBtnY = btnY;
      digLblX = digBtnX + btnW + gap;
      digLblY = lblY;
    } else {
      // 均不足：安全折行，绝不贴死窗口顶部黑边
      digBtnX = Math.max(10, Math.min(origLeft, containerW - groupW - 10));
      if (btnY - btnH - 6 >= 8) {
        digBtnY = btnY - btnH - 6;
      } else {
        digBtnY = btnY + btnH + 6;
      }
      digLblX = digBtnX + btnW + gap;
      digLblY = digBtnY;
    }

    setNodeSize(digBtn, btnW, btnH);
    setNodePos(digBtn, digBtnX, digBtnY);
    digBtn.sortingOrder = 9997;

    if (digLabel) {
      setNodeSize(digLabel, lblW, lblH);
      setNodePos(digLabel, digLblX, digLblY);
      digLabel.sortingOrder = 9997;
    }

    var record = state.autoDigControls.filter(function (it) {
      return it && it.button === digBtn;
    })[0];

    if (!record) {
      record = {
        panel: panel,
        root: contentPane,
        button: digBtn,
        label: digLabel
      };
      state.autoDigControls.push(record);
    } else {
      record.panel = panel;
      record.label = digLabel;
    }

    if (digBtn.clearClick) digBtn.clearClick();
    if (digBtn.onClick) {
      digBtn.onClick(function () {
        toggleAutoDig();
      });
    }

    updateAutoDigControl(record);
    return record;
  }

  function setAutoDig(enable) {
    state.autoDig = !!enable;
    state.lastBuildingAttackAt = 0;
    state.lastBuildingAttackId = '';
    refreshAutoDigControls();
    updateControlPanelUI();
    logInfo('自动刨地:', state.autoDig ? '开启' : '关闭');
    showCountdownMessage('自动刨地: ' + (state.autoDig ? '【开启】' : '【关闭】'), -1);
    return state.autoDig;
  }

  function toggleAutoDig() {
    return setAutoDig(!state.autoDig);
  }

  function removeAutoDigControls() {
    state.autoDigControls.forEach(function (ctrl) {
      ['button', 'label'].forEach(function (prop) {
        var node = ctrl && ctrl[prop];
        if (!node) return;
        try {
          if (node.clearClick) node.clearClick();
          if (node.parent && typeof node.parent.removeChild === 'function') node.parent.removeChild(node);
          if (node.dispose) node.dispose();
        } catch (e) {}
      });
      if (ctrl && ctrl.root) {
        ctrl.root.__saltAutoDigButton = null;
        ctrl.root.__saltAutoDigLabel = null;
      }
    });
    state.autoDigControls = [];
  }

  function runAutoBuildingAttack(mod, selfPlayer) {
    if (!state.autoDig || state.lockedTarget || state.lockQueue.length || !mod || !selfPlayer) return;
    if (mod.isAutoAttack !== undefined) mod.isAutoAttack = true;

    var curB = selfPlayer.curBuilding;
    if (!curB || !curB.inBuilding || !curB.canAttackBuilding || !isIdleState(selfPlayer) || typeof mod.sendStartAttackBuilding !== 'function') return;

    // 避让盟友俱乐部占领的建筑
    var bLegionId = curB.legionId;
    if (bLegionId && isAlliedLegion(bLegionId)) return;

    var bId = curB.id;
    var now = Date.now();
    if (!bId || (state.lastBuildingAttackId === bId && now - Number(state.lastBuildingAttackAt || 0) < 2000)) return;

    state.lastBuildingAttackId = bId;
    state.lastBuildingAttackAt = now;
    try {
      var promise = mod.sendStartAttackBuilding(bId);
      if (promise && typeof promise.catch === 'function') promise.catch(function () {});
      if (promise) logInfo('已自动攻打建筑:', bId);
    } catch (e) {
      logWarn('自动攻打建筑调用失败:', e && e.message || e);
    }
  }

  /* ============================================================================
   * 9. LOCK & COMBAT ENGINE (锁头核心攻击调度机)
   * ============================================================================ */

  function getLockedTargetRecord(targetId) {
    var cur = state.lockedTarget;
    if (cur && Number(cur.targetId) === Number(targetId)) return cur;
    for (var i = 0; i < state.lockQueue.length; i++) {
      if (Number(state.lockQueue[i].targetId) === Number(targetId)) return state.lockQueue[i];
    }
    return null;
  }

  function updateLockControl(listItem) {
    var lockBtn = listItem && listItem.__saltQueueLockButton;
    var player = listItem && listItem.__saltQueuePlayer;
    var isLocked = player && !!getLockedTargetRecord(getAttackTargetId(player));
    var fightBtn = listItem && listItem.m_btnFight;
    var btnHeight = Number(fightBtn && fightBtn.height) || 46;
    var btnWidth = Math.min(88, Number(fightBtn && fightBtn.width) || 88);
    var fightBtnX = Number(fightBtn && fightBtn.x);

    if (!lockBtn) return;
    if (!isFinite(fightBtnX)) fightBtnX = (Number(listItem && listItem.width) || 520) - btnWidth - 8;
    var lockBtnX = Math.max(0, fightBtnX - btnWidth - 8);
    var canLock = !!player && !isSelfPlayer(player) && !isAlliedPlayer(player);

    setNodeSize(lockBtn, btnWidth, btnHeight);
    setNodePos(lockBtn, lockBtnX, Number(fightBtn && fightBtn.y) || 20);
    lockBtn.visible = canLock;
    lockBtn.touchable = canLock;
    lockBtn.enabled = true;
    lockBtn.grayed = false;
    lockBtn.alpha = 1;
    lockBtn.sortingOrder = 9999;
    lockBtn.title = isLocked ? '锁定中' : '锁定';

    var colorCtrl = lockBtn.m_color || (typeof lockBtn.getController === 'function' && lockBtn.getController('color'));
    if (colorCtrl) {
      try {
        colorCtrl.selectedPage = isLocked ? 'green' : 'yellow';
      } catch (e) {
        try { colorCtrl.selectedIndex = isLocked ? 1 : 0; } catch (err) {}
      }
    }

    try {
      if (typeof listItem.setChildIndex === 'function') {
        listItem.setChildIndex(lockBtn, Math.max(0, Number(listItem.numChildren || 1) - 1));
      }
    } catch (e) {}
  }

  function ensureLockControl(listItem) {
    var fg = getFgui();
    var lockBtn = listItem && listItem.__saltQueueLockButton;
    var fightBtn = listItem && listItem.m_btnFight;
    if (!listItem) return null;

    if (lockBtn && fg && fg.GButton && !(lockBtn instanceof fg.GButton)) {
      try {
        if (lockBtn.clearClick) lockBtn.clearClick();
        if (lockBtn.parent && typeof lockBtn.parent.removeChild === 'function') lockBtn.parent.removeChild(lockBtn);
        if (lockBtn.dispose) lockBtn.dispose();
      } catch (e) {}
      listItem.__saltQueueLockButton = null;
      lockBtn = null;
    }

    if (!lockBtn && fg && fg.UIPackage && fightBtn) {
      try {
        var resUrl = fightBtn.resourceURL;
        lockBtn = resUrl && fg.UIPackage.createObjectFromURL(resUrl);
      } catch (e) {
        lockBtn = null;
      }
      if (lockBtn) {
        lockBtn.name = 'saltQueueLockButton';
        listItem.addChild(lockBtn);
        listItem.__saltQueueLockButton = lockBtn;
        if (state.items.indexOf(listItem) < 0) state.items.push(listItem);
      }
    }
    if (!lockBtn) return null;

    lockBtn.touchable = true;
    lockBtn.enabled = true;
    lockBtn.grayed = false;
    lockBtn.title = '锁定';
    if (lockBtn.clearClick) lockBtn.clearClick();
    if (lockBtn.onClick) {
      lockBtn.onClick(function () {
        toggleLockedTarget(listItem.__saltQueuePlayer, listItem);
      });
    }

    updateLockControl(listItem);
    return lockBtn;
  }

  function refreshLockControls() {
    state.items.forEach(function (item) {
      updateLockControl(item);
    });
  }

  function toggleLockedTarget(targetPlayer, listItem) {
    if (!targetPlayer || isSelfPlayer(targetPlayer)) return false;
    if (isAlliedPlayer(targetPlayer)) {
      showCountdownMessage('【目标属于盟友俱乐部，禁止锁定】', -1);
      return false;
    }
    var targetId = getAttackTargetId(targetPlayer);
    if (!targetId) return false;

    var existing = getLockedTargetRecord(targetId);
    if (existing) {
      var pName = getPlayerName(targetPlayer) || targetPlayer.name || targetId;
      if (existing === state.lockedTarget) {
        clearLockedTarget();
      } else {
        state.lockQueue = state.lockQueue.filter(function (it) {
          return it !== existing;
        });
        refreshLockControls();
      }
      logInfo('已解除锁定目标:', pName, '剩余锁定队列数:', state.lockQueue.length + (state.lockedTarget ? 1 : 0));
      showCountdownMessage('已取消锁定【' + pName + '】', -1);
      return true;
    }

    var isMarch = isMarchState(targetPlayer);
    var marchDest = isMarch && getMarchDestination(targetPlayer);
    var destBuilding = marchDest && marchDest.march && marchDest.march.toBuilding || targetPlayer.curBuilding;
    var destPos = (marchDest && marchDest.position) || (isMarch ? null : copyPosition(targetPlayer.position));
    var destBuildingId = (destBuilding && destBuilding.id) || (destPos && (destPos.x + '_' + destPos.y));
    if (marchDest && marchDest.buildingId) destBuildingId = marchDest.buildingId;
    if (!isMarch && !destPos && !destBuildingId) return false;

    var newRecord = {
      targetId: targetId,
      target: targetPlayer,
      buildingId: destBuildingId || '',
      position: destPos,
      waitingForTarget: isMarch,
      destinationKnown: !!(destPos || destBuildingId),
      targetEndMarchTime: Number(marchDest && marchDest.march && marchDest.march.endTime) || Number(targetPlayer.endMarchTime) || 0,
      originPosition: copyPosition(getBattlefield() && getBattlefield().self && getBattlefield().self.position),
      originBuildingId: (getBattlefield() && getBattlefield().self && getBattlefield().self.curBuilding && getBattlefield().self.curBuilding.id) || '',
      targetLeft: false,
      targetLeftNotified: false,
      returning: false,
      returnSent: false,
      engaged: false,
      engagedAt: 0,
      combatSeen: false,
      failedAttempts: 0,
      lastActionAt: 0
    };

    if (state.lockedTarget) {
      state.lockQueue.push(newRecord);
    } else {
      state.lockedTarget = newRecord;
    }

    state.lastLockActionAt = 0;
    refreshLockControls();
    var curQueueLen = state.lockQueue.length + (state.lockedTarget ? 1 : 0);
    var targetName = getPlayerName(targetPlayer) || targetPlayer.name || targetId;
    logInfo('锁定盐场目标:', targetId, destBuildingId, '当前队列总数:', curQueueLen);
    showCountdownMessage('已锁定【' + targetName + '】(排队:' + curQueueLen + ')', -1);
    updateControlPanelUI();
    if (state.lockedTarget === newRecord) {
      runLockedAttack();
    }
    return true;
  }

  function clearLockedTarget() {
    state.lockedTarget = null;
    state.lastLockActionAt = 0;
    hideMarchCountdown();
    while (!state.lockedTarget && state.lockQueue.length) {
      state.lockedTarget = state.lockQueue.shift();
    }
    refreshLockControls();
    updateControlPanelUI();
  }

  function clearAllLockedTargets() {
    state.lockQueue = [];
    state.lockedTarget = null;
    state.lastLockActionAt = 0;
    hideMarchCountdown();
    refreshLockControls();
    logInfo('已清空全部锁定目标');
    showCountdownMessage('已清空全部锁定目标', -1);
  }

  function hideAllLockOverlays() {
    clearAllLockedTargets();
  }

  function lockPlayer(player, listItem) {
    if (player) toggleLockedTarget(player, listItem);
    else clearAllLockedTargets();
    return !!state.lockedTarget;
  }

  function requestAutoSpeedUp(mod, selfPlayer) {
    if (!state.autoSpeedUp || !mod || !selfPlayer) return;
    if (!isMarchState(selfPlayer)) {
      state.speedUpMarchId = 0;
      state.speedUpRequestedAt = 0;
      return;
    }

    // 1. 检查金砖是否充足，避免金砖不足时游戏频繁弹窗报错
    if (typeof selfPlayer.canSpeedUp === 'function') {
      try {
        if (!selfPlayer.canSpeedUp()) return;
      } catch (e) {}
    }

    // 2. 检查剩余行军时间是否低于下限（若低于下限游戏会提示 30041）
    var bf = mod.battlefield;
    if (bf) {
      try {
        var lowerLimit = (typeof bf.getConstValue === 'function' ? bf.getConstValue('legionWarMoveTimeLowerLimit') : 0) || 0;
        var scale = Number(mod.moveTimeScale || 1);
        var remainSec = getPlayerMarchRemainSeconds(selfPlayer);
        if (remainSec > 0 && remainSec <= (lowerLimit * scale + 1)) return;
      } catch (e) {}
    }

    var marchId = selfPlayer.marchId;
    var now = Date.now();
    // 配合官方 2000ms 冷却节流限制，请求间隔设为 2100ms
    if (!marchId || now - Number(state.speedUpRequestedAt || 0) < 2100) return;
    state.speedUpRequestedAt = now;
    state.speedUpMarchId = marchId;

    try {
      var promise = mod.sendSpeedUp && mod.sendSpeedUp(marchId);
      if (!promise) return;
      if (typeof promise.catch === 'function') promise.catch(function () {});
      logInfo('已使用金砖加速行军:', marchId);
    } catch (e) {
      logWarn('金砖加速调用失败:', e && e.message || e);
    }
  }

  function getQueuedTargetAtCurrentBuilding(selfPlayer, excludeWait) {
    if (!selfPlayer) return null;
    var curBId = selfPlayer.curBuilding && selfPlayer.curBuilding.id;
    var candidateIndex = -1;
    var candidateTarget = null;

    for (var i = 0; i < state.lockQueue.length; i++) {
      var record = state.lockQueue[i];
      var target = getPlayerById(record.targetId) || record.target;
      if (!target || isDeadState(target) || isMarchState(target) || isSameLegionTarget(target) || isAlliedPlayer(target)) continue;

      var inQueue = findTargetInBuildingQueues(selfPlayer.curBuilding, record.targetId);
      if (inQueue) {
        return {
          index: i,
          record: record,
          target: inQueue.player || target
        };
      }

      var targetBId = target.curBuilding && target.curBuilding.id;
      if (!(curBId && targetBId && String(curBId) === String(targetBId)) && !samePosition(target.position, selfPlayer.position)) continue;

      if (isIdleState(target)) {
        return {
          index: i,
          record: record,
          target: target
        };
      }
      if (!excludeWait && candidateIndex < 0) {
        candidateIndex = i;
        candidateTarget = target;
      }
    }

    return candidateIndex < 0 ? null : {
      index: candidateIndex,
      record: state.lockQueue[candidateIndex],
      target: candidateTarget
    };
  }

  function promoteQueuedTargetAtCurrentBuilding(selfPlayer, excludeWait, requeueOld) {
    var match = getQueuedTargetAtCurrentBuilding(selfPlayer, excludeWait);
    if (!match) return false;

    var oldLock = state.lockedTarget;
    var promoted = state.lockQueue.splice(match.index, 1)[0];
    promoted.target = match.target;
    var curB = match.target.curBuilding;
    promoted.buildingId = (curB && curB.id) || promoted.buildingId;
    promoted.position = copyPosition(match.target.position) || copyPosition(curB && curB.position) || promoted.position;
    promoted.waitingForTarget = false;
    promoted.destinationKnown = true;
    promoted.targetLeft = false;
    promoted.targetLeftNotified = false;
    promoted.returning = false;
    promoted.returnSent = false;
    promoted.lastActionAt = 0;

    if (requeueOld && oldLock) {
      state.lockQueue.push(oldLock);
    }
    state.lockedTarget = promoted;
    state.lastLockActionAt = 0;
    hideMarchCountdown();
    refreshLockControls();
    return true;
  }

  function runLockedAttack() {
    var lockTarget = state.lockedTarget;
    if (state.destroyed || !lockTarget) return;

    var mod = getLegionWarModule();
    var bf = getBattlefield();
    var selfPlayer = bf && bf.self;
    var targetPlayer = getPlayerById(lockTarget.targetId) || lockTarget.target;
    if (!mod || !bf || !selfPlayer) return;

    if (mod.isAutoAttack !== undefined) mod.isAutoAttack = false;
    var now = Date.now();

    if (isDeadState(selfPlayer)) {
      logInfo('自身已死亡，停止全部锁定目标。');
      clearAllLockedTargets();
      return;
    }

    // 1. 处于开战状态监控
    if (lockTarget.engaged) {
      if (isCombatState(selfPlayer)) {
        lockTarget.combatSeen = true;
        lockTarget.failedAttempts = 0;
        return updateLockedBattleCountdown(selfPlayer, lockTarget.targetId);
      }
      if (lockTarget.combatSeen) {
        if (isIdleState(selfPlayer)) {
          logInfo('当前锁定目标战斗结束，切换下一个。');
          clearLockedTarget();
          if (state.lockedTarget) runLockedAttack();
        }
        return;
      }
      if (!isIdleState(selfPlayer) || now - Number(lockTarget.engagedAt || 0) < 2500) return;

      lockTarget.engaged = false;
      lockTarget.lastActionAt = 0;
      lockTarget.failedAttempts = (Number(lockTarget.failedAttempts) || 0) + 1;
      logInfo('开战状态未同步，重新尝试当前锁定目标，失败重试次数:', lockTarget.failedAttempts);

      if (lockTarget.failedAttempts >= 3) {
        logInfo('目标连续3次开战失败（可能受限或无法攻击），放弃该目标切换下一个。');
        clearLockedTarget();
        if (state.lockedTarget) runLockedAttack();
        return;
      }
    }

    // 2. 目标存活检测
    if (!targetPlayer || isDeadState(targetPlayer)) {
      logInfo('锁定目标已离场，切换下一个。');
      clearLockedTarget();
      if (state.lockedTarget) runLockedAttack();
      return;
    }

    // 3. 等待目标行军到达
    if (lockTarget.waitingForTarget && targetPlayer) {
      if (isMarchState(targetPlayer)) {
        updateTargetArrivalCountdown(lockTarget, targetPlayer);
        var marchDest = getMarchDestination(targetPlayer);
        if (!lockTarget.destinationKnown && marchDest) {
          lockTarget.buildingId = marchDest.buildingId || '';
          lockTarget.position = marchDest.position;
          lockTarget.destinationKnown = !!(lockTarget.buildingId || lockTarget.position);
        }
      } else {
        var tBuilding = targetPlayer.curBuilding;
        lockTarget.position = copyPosition(targetPlayer.position) || copyPosition(tBuilding && tBuilding.position) || lockTarget.position;
        lockTarget.buildingId = (tBuilding && tBuilding.id) || (lockTarget.position && (lockTarget.position.x + '_' + lockTarget.position.y)) || lockTarget.buildingId;
        lockTarget.destinationKnown = !!(lockTarget.buildingId || lockTarget.position);
        lockTarget.waitingForTarget = false;
        hideMarchCountdown();
        logInfo('锁定目标已到达目的建筑，准备立即开战:', lockTarget.buildingId);
      }
    }

    // 4. 自身行军监控
    if (isMarchState(selfPlayer)) {
      if (lockTarget.waitingForTarget) {
        updateTargetArrivalCountdown(lockTarget, targetPlayer);
      } else {
        updateMarchCountdown(selfPlayer, lockTarget.returning);
      }
      requestAutoSpeedUp(mod, selfPlayer);

      if (!lockTarget.waitingForTarget && !lockTarget.returning && targetPlayer &&
        (!targetPlayer.curBuilding || String(targetPlayer.curBuilding.id) !== String(lockTarget.buildingId)) &&
        !samePosition(targetPlayer.position, lockTarget.position) && !lockTarget.targetLeft) {
        lockTarget.targetLeft = true;
        if (lockTarget.targetLeftNotified !== true) {
          lockTarget.targetLeftNotified = true;
          logInfo('锁定目标已离开原建筑，到达后返回原建筑:', lockTarget.buildingId);
        }
      }
      return;
    }

    hideMarchCountdown();
    if (!targetPlayer || !isIdleState(selfPlayer)) return;

    var curB = selfPlayer.curBuilding;
    var inDestBuilding = !!((curB && String(curB.id) === String(lockTarget.buildingId)) || samePosition(selfPlayer.position, lockTarget.position));
    var inOriginBuilding = !!((curB && String(curB.id) === String(lockTarget.originBuildingId)) || samePosition(selfPlayer.position, lockTarget.originPosition));
    var targetInDestBuilding = !!((targetPlayer.curBuilding && String(targetPlayer.curBuilding.id) === String(lockTarget.buildingId)) || samePosition(targetPlayer.position, lockTarget.position));

    // 5. 目标行军中，拦截前往目的建筑
    if (lockTarget.waitingForTarget) {
      if (!lockTarget.destinationKnown || inDestBuilding) return;
      if (now - (lockTarget.lastActionAt || 0) < 1200 || !lockTarget.position || typeof mod.sendStartMarch !== 'function') return;
      var marchPromise = mod.sendStartMarch(lockTarget.position);
      if (marchPromise) {
        if (typeof marchPromise.catch === 'function') marchPromise.catch(function () {});
        lockTarget.lastActionAt = now;
        logInfo('前往目标行军目的建筑并等待:', lockTarget.buildingId);
      }
      return;
    }

    // 6. 目标离开建筑判定（包含二次进队扫描防护，彻底杜绝到站折返跑）
    if (lockTarget.targetLeft) {
      if (inDestBuilding && curB) {
        var queueMatch = findTargetInBuildingQueues(curB, lockTarget.targetId);
        if (queueMatch) {
          logInfo('锁定目标仍在当前建筑队列中，纠正离开状态，恢复开战。');
          lockTarget.targetLeft = false;
          lockTarget.targetLeftNotified = false;
          lockTarget.returning = false;
        }
      }
      if (lockTarget.targetLeft) {
        if (inDestBuilding && promoteQueuedTargetAtCurrentBuilding(selfPlayer, false, false)) {
          logInfo('离开的锁定目标已跳过，继续处理当前建筑内的其他锁定目标。');
          return runLockedAttack();
        }
        if (inDestBuilding && !lockTarget.returning) {
          if (lockTarget.originPosition && typeof mod.sendStartMarch === 'function' && now - (lockTarget.lastActionAt || 0) >= 1200) {
            var returnMarch = mod.sendStartMarch(lockTarget.originPosition);
            if (returnMarch) {
              if (typeof returnMarch.catch === 'function') returnMarch.catch(function () {});
              lockTarget.returning = true;
              lockTarget.lastActionAt = now;
              logInfo('已到达空建筑，立即返回原建筑:', lockTarget.originBuildingId);
            }
          }
          return;
        }
        if (lockTarget.returning && inOriginBuilding) {
          logInfo('已返回原建筑，解除锁定。');
          return clearLockedTarget();
        }
        if (lockTarget.returning) return;
      }
    }

    if (now - (lockTarget.lastActionAt || 0) < 1200) return;

    // 7. 已到达目标所在建筑，发起开战
    if (inDestBuilding) {
      var queueTarget = findTargetInBuildingQueues(curB, lockTarget.targetId);
      var currentBattle = queueTarget ? null : findTargetBattle(curB, lockTarget.targetId);

      // 若当前目标被抢先攻击，提升处理下一个未开战的目标
      if (!queueTarget && (currentBattle || isCombatState(targetPlayer)) && promoteQueuedTargetAtCurrentBuilding(selfPlayer, true, true)) {
        logInfo('当前锁定目标已被其他玩家攻击，优先处理下一个未开战目标。');
        return runLockedAttack();
      }

      if (!queueTarget && currentBattle) {
        return updateThirdPartyBattleCountdown(currentBattle, lockTarget);
      }

      if (queueTarget) {
        targetPlayer = queueTarget.player || targetPlayer;
        lockTarget.waitingBattleKey = '';
      }

      if ((!queueTarget && !isIdleState(targetPlayer)) || Number(targetPlayer.legionId) === Number(selfPlayer.legionId) || isAlliedPlayer(targetPlayer)) return;

      var battlePromise = mod.sendStartBattle(lockTarget.targetId);
      if (battlePromise) {
        if (typeof battlePromise.catch === 'function') battlePromise.catch(function () {});
        lockTarget.engaged = true;
        lockTarget.engagedAt = now;
        lockTarget.combatSeen = false;
        lockTarget.lastActionAt = now;
        logInfo('已到达锁定建筑，开始攻击:', lockTarget.targetId);
      }
      return;
    }

    // 8. 尚未到达目的建筑，发起行军
    if (targetPlayer && !targetInDestBuilding) {
      lockTarget.targetLeft = true;
    }
    if (!lockTarget.position || typeof mod.sendStartMarch !== 'function') return;
    var marchPromise = mod.sendStartMarch(lockTarget.position);
    if (marchPromise) {
      if (typeof marchPromise.catch === 'function') marchPromise.catch(function () {});
      lockTarget.lastActionAt = now;
      logInfo('前往锁定建筑:', lockTarget.buildingId);
    }
  }

  /* ============================================================================
   * 10. PROTOTYPE HOOKS (游戏原型链注入与拦截)
   * ============================================================================ */

  function restoreOriginalMethod(targetProto, methodName) {
    var backupNames = [
      '__saltQueueOriginal' + methodName,
      '__saltQueueOriginal_' + methodName,
      '__saltOriginal' + methodName,
      '__saltOriginal_' + methodName,
      '__saltRankingHookOriginal_' + methodName
    ];
    var restored = false;
    backupNames.forEach(function (name) {
      if (typeof targetProto[name] === 'function') {
        targetProto[methodName] = targetProto[name];
        try { delete targetProto[name]; } catch (e) { targetProto[name] = null; }
        restored = true;
      }
    });
    try { delete targetProto.__saltTagsPatchVersion; } catch (e) {}
    try { delete targetProto.__saltTagsPatched; } catch (e) {}
    return restored;
  }

  function patchBuildingPanel() {
    try {
      var panelModule = gameRequire('LegionWarBuildingPanel');
      var PanelClass = panelModule && panelModule.LegionWarBuildingPanel;
      var proto = PanelClass && PanelClass.prototype;
      var backupKey = '__saltQueueOriginal_refresh';
      if (!proto || proto.__saltAutoDigVersion === VERSION) return false;

      restoreOriginalMethod(proto, '_refresh');
      var origRefresh = proto._refresh;
      if (typeof origRefresh !== 'function') return false;

      proto[backupKey] = origRefresh;
      proto._refresh = function () {
        var self = this;
        var ret = origRefresh.apply(this, arguments);
        window.setTimeout(function () {
          if (!state.destroyed) ensureAutoDigControl(self);
        }, 0);
        return ret;
      };
      proto.__saltAutoDigVersion = VERSION;
      return true;
    } catch (e) {
      logWarn('挂载自动刨地开关失败:', e && e.message || e);
      return false;
    }
  }

  function isBuildingPanelPatched() {
    try {
      var panelModule = gameRequire('LegionWarBuildingPanel');
      var PanelClass = panelModule && panelModule.LegionWarBuildingPanel;
      return !!(PanelClass && PanelClass.prototype && PanelClass.prototype.__saltAutoDigVersion === VERSION);
    } catch (e) {
      return false;
    }
  }

  function unpatchBuildingPanel() {
    try {
      var panelModule = gameRequire('LegionWarBuildingPanel');
      var PanelClass = panelModule && panelModule.LegionWarBuildingPanel;
      var proto = PanelClass && PanelClass.prototype;
      if (!proto) return;
      restoreOriginalMethod(proto, '_refresh');
      try { delete proto.__saltAutoDigVersion; } catch (e) {}
    } catch (e) {}
  }

  function patchTroopsPage(moduleName, exportName) {
    try {
      var pageMod = gameRequire(moduleName);
      var PageClass = pageMod && pageMod[exportName];
      var proto = PageClass && PageClass.prototype;
      if (!proto || proto.__saltQueueLockVersion === VERSION) return false;

      ['_refreshItem', '_refreshTeamItem'].forEach(function (methodName) {
        restoreOriginalMethod(proto, methodName);
        var origMethod = proto[methodName];
        if (typeof origMethod !== 'function') return;
        proto['__saltQueueOriginal' + methodName] = origMethod;
        proto[methodName] = function (argA, item, player) {
          var ret = origMethod.apply(this, arguments);
          try {
            if (!state.destroyed && item && player) {
              refreshItem(item, player);
            }
          } catch (e) {
            logWarn('条目名片刷新失败:', e && e.message || e);
          }
          return ret;
        };
      });

      restoreOriginalMethod(proto, '_refresh');
      var origRefresh = proto._refresh;
      if (typeof origRefresh === 'function') {
        proto.__saltQueueOriginal_refresh = origRefresh;
        proto._refresh = function () {
          var ret = origRefresh.apply(this, arguments);
          try {
            var listData = this._listData;
            if (Array.isArray(listData)) {
              this.__sfaOriginalListData = listData.slice();
            }
            if (this._building) state.lastActiveBuilding = this._building;
            ensureNativeTroopsSortButtons(this);
            requestSortTroopsList(this);
            updateControlPanelUI();
          } catch (e) {}
          return ret;
        };
      }

      restoreOriginalMethod(proto, 'onShow');
      var origShow = proto.onShow;
      if (typeof origShow === 'function') {
        proto.__saltQueueOriginal_onShow = origShow;
        proto.onShow = function () {
          var ret = origShow.apply(this, arguments);
          try {
            var listData = this._listData;
            if (Array.isArray(listData)) {
              this.__sfaOriginalListData = listData.slice();
            }
            ensureNativeTroopsSortButtons(this);
            requestSortTroopsList(this);
          } catch (e) {}
          return ret;
        };
      }

      proto.__saltQueueLockVersion = VERSION;
      state.patched.push({ moduleName: moduleName, exportName: exportName });
      logInfo('已挂载队列名片与排序控制:', moduleName);
      return true;
    } catch (e) {
      logWarn('挂载队列名片与排序失败:', moduleName, e && e.message || e);
      return false;
    }
  }

  function isTroopsPagePatched(moduleName, exportName) {
    try {
      var pageMod = gameRequire(moduleName);
      var PageClass = pageMod && pageMod[exportName];
      return !!(PageClass && PageClass.prototype && PageClass.prototype.__saltQueueLockVersion === VERSION);
    } catch (e) {
      return false;
    }
  }

  function unpatchTroopsPage(moduleName, exportName) {
    try {
      var pageMod = gameRequire(moduleName);
      var PageClass = pageMod && pageMod[exportName];
      var proto = PageClass && PageClass.prototype;
      if (!proto) return;
      restoreOriginalMethod(proto, '_refreshItem');
      restoreOriginalMethod(proto, '_refreshTeamItem');
      restoreOriginalMethod(proto, '_refresh');
      restoreOriginalMethod(proto, 'onShow');
      try { delete proto.__saltQueueLockVersion; } catch (e) {}
    } catch (e) {}
  }

  /* ============================================================================
   * 11. RANKING ALLY INTEGRATION (俱乐部排行榜盟友配置交互体系)
   * ============================================================================ */

  function refreshRankItemAllyButton(item, legion) {
    if (!item || !legion) return;
    item.__saltRankLegion = legion;
    var fg = getFgui();
    if (!fg) return;

    var isSelf = !!legion.isMine;
    var lgName = legion.name || legion.codeName || legion.intro || '';
    var isAlly = !isSelf && isAlliedLegion(legion.id, lgName);

    // 1. 标题俱乐部文字染色与标签
    var legionNameNode = item.m_textLegionName || (item.getChild && (item.getChild('textLegionName') || item.getChild('m_textLegionName')));
    if (legionNameNode && typeof legionNameNode.text === 'string') {
      var rawName = String(legionNameNode.text).replace(/^【(?:盟|敌|本部)】/, '');
      if (isSelf) {
        legionNameNode.text = '【本部】' + rawName;
        legionNameNode.color = '#ffc069';
      } else if (isAlly) {
        legionNameNode.text = '【盟】' + rawName;
        legionNameNode.color = '#79ff4d';
      } else {
        legionNameNode.text = '【敌】' + rawName;
        legionNameNode.color = '#ffffff';
      }
    }

    // 2. 自家俱乐部显示金色【本部】标签，不显示结盟按钮
    if (isSelf) {
      if (item.__saltRankAllyBtn) item.__saltRankAllyBtn.visible = false;
      return;
    }

    // 3. 非自家俱乐部：创建或更新【设为盟友 / 已结盟】原生质感按钮
    var btn = item.__saltRankAllyBtn;
    if (!btn) {
      btn = makeNativeSortButton(fg, isAlly ? '✔ 盟友' : '+ 结盟', function () {
        var curLg = item.__saltRankLegion;
        if (!curLg || curLg.isMine) return;
        var curId = curLg.id;
        var curName = curLg.name || curLg.codeName || curLg.intro || '';
        toggleAlliedLegion(curId, curName);
        refreshRankItemAllyButton(item, curLg);
      }, 76, 30);
      if (btn) {
        btn.name = 'saltRankAllyBtn';
        item.addChild(btn);
        item.__saltRankAllyBtn = btn;
      }
    }

    if (btn) {
      btn.visible = true;
      btn.touchable = true;
      var label = btn.__sfaLabel;
      if (label) {
        label.text = isAlly ? '✔ 盟友' : '+ 结盟';
        label.color = isAlly ? '#79ff4d' : '#fff4df';
      }
      var colorCtrl = btn.m_color || (typeof btn.getController === 'function' && btn.getController('color'));
      if (colorCtrl) {
        try { colorCtrl.selectedPage = isAlly ? 'green' : 'yellow'; } catch (e) {}
      }

      // 排版定位：放置在 item 右侧，与帮助按钮安全避让
      var itemW = Number(item.width) || 600;
      var itemH = Number(item.height) || 80;
      var btnW = 76;
      var btnH = 30;
      var btnHelp = item.m_btnHelp;
      var posX = (btnHelp && typeof btnHelp.x === 'number' && btnHelp.x > 320)
        ? (btnHelp.x - btnW - 8)
        : (itemW - btnW - 14);
      var posY = Math.max(0, (itemH - btnH) / 2);
      setNodeSize(btn, btnW, btnH);
      setNodePos(btn, posX, posY);
      btn.sortingOrder = 9999;
    }
  }

  function patchRankingPage() {
    try {
      var rankMod = null;
      try { rankMod = gameRequire('WarLegionRankingPage'); } catch (e) {}
      if (!rankMod) {
        try { rankMod = gameRequire('92d7dtrt4RK054WZILWFKnz'); } catch (e) {}
      }
      var PageClass = rankMod && (rankMod.WarLegionRankingPage || rankMod.default);
      var proto = PageClass && PageClass.prototype;
      if (!proto || proto.__saltRankingHookVersion === VERSION) return false;

      restoreOriginalMethod(proto, '_refreshLegionItem');
      var origMethod = proto._refreshLegionItem;
      if (typeof origMethod !== 'function') return false;

      proto.__saltQueueOriginal_refreshLegionItem = origMethod;
      proto._refreshLegionItem = function (index, legion, item) {
        var ret = origMethod.apply(this, arguments);
        try {
          if (!state.destroyed && item && legion) {
            refreshRankItemAllyButton(item, legion);
          }
        } catch (e) {
          logWarn('排行榜刷新盟友控件失败:', e && e.message || e);
        }
        return ret;
      };

      // 挂钩 _refreshPlayerItem，防止虚拟列表复用条目时将结盟按钮残留显示在个人榜条目上
      restoreOriginalMethod(proto, '_refreshPlayerItem');
      var origPlayerMethod = proto._refreshPlayerItem;
      if (typeof origPlayerMethod === 'function') {
        proto.__saltQueueOriginal_refreshPlayerItem = origPlayerMethod;
        proto._refreshPlayerItem = function (index, player, item) {
          var ret = origPlayerMethod.apply(this, arguments);
          try {
            if (item && item.__saltRankAllyBtn) {
              item.__saltRankAllyBtn.visible = false;
            }
          } catch (e) {}
          return ret;
        };
      }

      proto.__saltRankingHookVersion = VERSION;
      state.patched.push({ moduleName: 'WarLegionRankingPage', exportName: 'WarLegionRankingPage' });
      logInfo('已挂载俱乐部排行榜盟友交互增强');
      return true;
    } catch (e) {
      logWarn('挂载俱乐部排行榜失败:', e && e.message || e);
      return false;
    }
  }

  function isRankingPagePatched() {
    try {
      var rankMod = null;
      try { rankMod = gameRequire('WarLegionRankingPage'); } catch (e) {}
      if (!rankMod) {
        try { rankMod = gameRequire('92d7dtrt4RK054WZILWFKnz'); } catch (e) {}
      }
      var PageClass = rankMod && (rankMod.WarLegionRankingPage || rankMod.default);
      return !!(PageClass && PageClass.prototype && PageClass.prototype.__saltRankingHookVersion === VERSION);
    } catch (e) {
      return false;
    }
  }

  function unpatchRankingPage() {
    try {
      var rankMod = null;
      try { rankMod = gameRequire('WarLegionRankingPage'); } catch (e) {}
      if (!rankMod) {
        try { rankMod = gameRequire('92d7dtrt4RK054WZILWFKnz'); } catch (e) {}
      }
      var PageClass = rankMod && (rankMod.WarLegionRankingPage || rankMod.default);
      var proto = PageClass && PageClass.prototype;
      if (!proto) return;
      restoreOriginalMethod(proto, '_refreshLegionItem');
      restoreOriginalMethod(proto, '_refreshPlayerItem');
      try { delete proto.__saltRankingHookVersion; } catch (e) {}
    } catch (e) {}
  }

  function patchAll() {
    if (!hasGameRequire()) return false;
    patchRankingPage();
    return patchTroopsPage('AttackTroopsPage', 'AttackTroopsPage') &&
      patchTroopsPage('DefenseTroopsPage', 'DefenseTroopsPage') &&
      patchBuildingPanel() &&
      isTroopsPagePatched('AttackTroopsPage', 'AttackTroopsPage') &&
      isTroopsPagePatched('DefenseTroopsPage', 'DefenseTroopsPage') &&
      isBuildingPanelPatched();
  }

  function removeLegacySaltTagsUi() {
    try {
      if (window.SaltFieldTargetTags && typeof window.SaltFieldTargetTags.destroy === 'function') {
        window.SaltFieldTargetTags.destroy();
      }
    } catch (e) {}
    ['salt-tags-ui', 'salt-tags-mini', 'salt-tags-style'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  /* ============================================================================
   * 12. LIFECYCLE & EXPORT (生命周期监控、原生自动攻击保护与全局 API 导出)
   * ============================================================================ */

  function start() {
    var retryCount = 0;
    removeLegacySaltTagsUi();
    startMarchTickTimer();
    try { initFloatDashboard(); } catch (e) { logWarn("悬浮控制面板初始化异常:", e); }
    if (patchAll()) return startLockMonitor();

    state.retryTimer = window.setInterval(function () {
      if (state.destroyed) {
        window.clearInterval(state.retryTimer);
        state.retryTimer = 0;
        return;
      }
      retryCount++;
      if (retryCount > 60 && (retryCount % 4 !== 0)) return;
      if (typeof document !== 'undefined' && !document.getElementById('__salt_float_ball')) {
        try { initFloatDashboard(); } catch (e) {}
      }
      if (patchAll()) {
        window.clearInterval(state.retryTimer);
        state.retryTimer = 0;
        logInfo("所有盐场模块注入成功，启动锁头调度机。");
        startLockMonitor();
      }
    }, 500);
  }

  function startLockMonitor() {
    if (state.lockTimer) return;
    state.lockTimer = window.setInterval(function () {
      if (typeof document !== 'undefined' && !document.getElementById('__salt_float_ball')) {
        try { initFloatDashboard(); } catch (e) {}
      }
      var mod = getLegionWarModule();
      var bf = getBattlefield();
      var selfPlayer = bf && bf.self;
      var hasLock = !!(state.lockedTarget || (state.lockQueue && state.lockQueue.length));

      // 原生 isAutoAttack 安全保护：仅在锁头期间临时关闭；退出锁头时精准无损还原用户原本设置
      if (mod && mod.isAutoAttack !== undefined) {
        if (hasLock) {
          if (state.userAutoAttack === null) {
            state.userAutoAttack = !!mod.isAutoAttack;
          }
          if (mod.isAutoAttack) {
            mod.isAutoAttack = false;
          }
        } else {
          if (state.userAutoAttack !== null) {
            mod.isAutoAttack = state.userAutoAttack;
            state.userAutoAttack = null;
          }
        }
      }

      if (mod && selfPlayer) requestAutoSpeedUp(mod, selfPlayer);
      if (mod && selfPlayer) runAutoBuildingAttack(mod, selfPlayer);
      runLockedAttack();
    }, 500);
  }

  function destroy() {
    state.destroyed = true;
    if (state.retryTimer) {
      window.clearInterval(state.retryTimer);
      state.retryTimer = 0;
    }
    if (state.lockTimer) {
      window.clearInterval(state.lockTimer);
      state.lockTimer = 0;
    }
    if (state.marchTickTimer) {
      window.clearInterval(state.marchTickTimer);
      state.marchTickTimer = 0;
    }

    if (state.sortBars) {
      state.sortBars.forEach(function (bar) {
        if (!bar) return;
        ['label', 'energy', 'power', 'marchTime', 'restore', 'root'].forEach(function (k) {
          var node = bar[k];
          if (node && node.parent) {
            try {
              node.parent.removeChild(node);
              if (typeof node.dispose === 'function') node.dispose();
            } catch (e) {}
          }
        });
      });
      state.sortBars = [];
    }

    Array.from(state.activeRequests).forEach(function (cancel) {
      try { cancel(); } catch (e) {}
    });
    state.activeRequests.clear();

    unpatchTroopsPage('AttackTroopsPage', 'AttackTroopsPage');
    unpatchTroopsPage('DefenseTroopsPage', 'DefenseTroopsPage');
    unpatchBuildingPanel();
    unpatchRankingPage();
    removeAutoDigControls();
    removeFloatDashboard();

    state.items.forEach(function (item) {
      hideSaltQueueOverlay(item);
      if (item) item.__saltQueuePlayer = null;
    });
    state.items = [];

    state.teamCache.clear();
    state.formationCache.clear();
    state.pending.clear();
    state.imagePending.clear();
    state.requestCooldown.clear();
    state.lockedTarget = null;
    state.lockQueue = [];

    if (state.countdownText && state.countdownText.parent && typeof state.countdownText.parent.removeChild === 'function') {
      state.countdownText.parent.removeChild(state.countdownText);
    }
    state.countdownText = null;

    if (state.userAutoAttack !== null) {
      try {
        var mod = getLegionWarModule();
        if (mod && mod.isAutoAttack !== undefined) {
          mod.isAutoAttack = state.userAutoAttack;
        }
      } catch (e) {}
      state.userAutoAttack = null;
    }

    delete window[GLOBAL_KEY];
  }

  var api = {
    version: VERSION,
    lock: lockPlayer,
    attackLocked: function () {
      runLockedAttack();
      return !!(state.lockedTarget && state.lockedTarget.engaged);
    },
    clearLock: function () {
      hideAllLockOverlays();
      updateControlPanelUI();
      return api;
    },
    setWeakHeroLimit: setWeakHeroLimit,
    getWeakHeroLimit: function () { return state.weakHeroLimit; },
    lockWeakTroops: lockWeakTroopsInCurrentBuilding,
    openPanel: openControlPanel,
    closePanel: closeControlPanel,
    togglePanel: toggleControlPanel,
    getState: function () {
      return {
        version: VERSION,
        cacheSize: state.teamCache.size,
        formationCacheSize: state.formationCache.size,
        formationCacheHits: state.formationCacheHits,
        formationRecognitionRuns: state.formationRecognitionRuns,
        pendingRequests: state.pending.size,
        activeRequests: state.activeRequests.size,
        identityMode: 'png-template-only',
        builtInHashes: 0,
        learnedHashes: 0,
        learnedHashBypass: false,
        templateCount: 0,
        recognizableTemplateCount: 0,
        teamCacheTtlMs: TEAM_CACHE_TTL_MS,
        lockedTargetId: (state.lockedTarget && state.lockedTarget.targetId) || 0,
        lockedBuildingId: (state.lockedTarget && state.lockedTarget.buildingId) || '',
        lockEngaged: !!(state.lockedTarget && state.lockedTarget.engaged),
        lockedQueueLength: state.lockQueue.length + (state.lockedTarget ? 1 : 0),
        lockedTargetIds: (state.lockedTarget ? [state.lockedTarget.targetId] : []).concat(state.lockQueue.map(function (it) {
          return it.targetId;
        })),
        autoSpeedUp: state.autoSpeedUp,
        autoAttack: true,
        speedUpMarchId: state.speedUpMarchId || 0,
        alliedLegionDate: (state.alliedLegions && state.alliedLegions.date) || '',
        alliedLegions: (state.alliedLegions && state.alliedLegions.names) || [],
        maxTeamCacheEntries: CACHE_LIMIT,
        maxLearnedImageEntries: 0,
        imageMatchMaxDistance: AVATAR_DISTANCE_THRESHOLD,
        imageMatchMinMargin: AVATAR_MARGIN_THRESHOLD,
        patched: state.patched.slice()
      };
    },
    testResponse: function (resp) {
      var team = parseTeamResponse(resp);
      if (!Array.isArray(team)) return null;
      return buildTeamSummary({}, team);
    },
    setAutoSpeedUp: setAutoSpeedUp,
    toggleAutoSpeedUp: toggleAutoSpeedUp,
    getAutoSpeedUp: function () { return !!state.autoSpeedUp; },
    setAutoDig: setAutoDig,
    toggleAutoDig: toggleAutoDig,
    getAutoDig: function () { return !!state.autoDig; },
    getImageMap: function () { return {}; },
    getLearnedImageMap: function () { return {}; },
    clearLearnedImages: function () {
      clearRecognitionCaches();
      return api;
    },
    matchImage: function (url) {
      return Promise.resolve(null);
    },
    learnImage: function (urlA, urlB) {
      urlA = normalizePngDataUrl(urlA).toLowerCase();
      if (!urlA) return Promise.resolve({ cached: false, match: null });
      return Promise.resolve({ cached: false, match: null });
    },
    identifyPlayer: function (player) {
      return {
        roleCodeId: getRoleCodeId(player),
        battlefieldId: getBattlefieldId(),
        cacheKey: getPlayerCacheKey(player),
        name: getPlayerName(player)
      };
    },
    identifyFormation: function (player) {
      return requestTeamSummary(player);
    },
    listParticipants: function () {
      return listParticipantIdentities();
    },
    clearAlliedLegions: clearAlliedLegions,
    getAlliedLegions: function () {
      return (state.alliedLegions && state.alliedLegions.names) || [];
    },
    destroy: destroy
  };

  window[GLOBAL_KEY] = api;
  start();
  window.SaltQueueEnhancer = window[GLOBAL_KEY];
  logInfo('已加载：黑鬼盐场增强 v2.0.0（支持战力/精力/到达时间排序、行军倒计时、精准锁头、自动开战、自动刨地、盟友/敌对标记与排行榜交互）。');
})();
