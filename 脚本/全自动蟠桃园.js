// ==UserScript==
// @name         全自动蟠桃园助手 (LEGION_PAYLOAD)
// @namespace    local.test.lp.smart
// @version      3.2.0
// @description  咸鱼之王全自动蟠桃园(运镖/截镖)挂机助手，支持自动进场、复活布阵、上船护船、终点自动下船(无人驾驶)、索敌攻击与道具拾取，兼容单庞统与主阵容。
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        *://*.hortor.net/*
// @match        *://*.hortorgames.com/*
// @match        *://minigame.weixin.qq.com/*
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';



  const CFG = {
    tickMs: 800,
    enterCooldownMs: 10000,
    battleCooldownMs: 2200,
    moveCooldownMs: 3200,
    pickCooldownMs: 2600,
    useItemCooldownMs: 5000,
    deployCooldownMs: 5000,
    deployEnterDelayMs: 1200,
    reviveReadyGraceMs: 90000,
    attackRange: 1,
    maxRetries: 3,
    debug: true,
    verboseLog: false,
    strategy: {
      autoEnter: true,
      autoGetOnCar: true,
      autoDismountNearEnd: true, // 船只快到终点时自动下船
      dismountSteps: 2, // 距离终点剩余步数阈值（<=2步触发下船）
      autoAttack: true,
      autoPickItem: true,
      autoUseCarItem: true,
      protectCar: true,
      autoOpenDeploy: true,
      carDistance: 3,
      priorityTarget: 'nearCar', // 'nearCar': 优先护船, 'onCar': 优先船上敌人, 'nearest': 优先最近敌人
    },
  };

  const state = {
    running: false,
    lastEnter: 0,
    lastBattle: 0,
    lastMove: 0,
    lastPick: 0,
    lastUseItem: 0,
    lastDeployOpen: 0,
    lastDismountAt: 0,
    dismountedCarId: 0,
    dismountCount: 0,
    currentCar: null,
    battleCount: 0,
    moveCount: 0,
    pickCount: 0,
    useItemCount: 0,
    deployCount: 0,
    deployPending: false,
    deployReady: false,
    deployBattlefieldId: '',
    lastSeenBattlefieldId: '',
    lastDeploySignature: '',
    deathCount: 0,
    wasDead: false,
    lastReviveSeconds: 0,
    lastDeathAt: 0,
    reviveDeadlineAt: 0,
    reviveReadyAt: 0,
    deployAfterRevivePending: false,
    lastForcedDeployAt: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    lastError: '',
    enterPending: false,
    enterRetryCount: 0,
    lastSnapshot: null,
    taskLog: [],
  };

  const ui = {
    root: null,
    status: null,
    log: null,
    minimized: false,
    drag: null,
    moved: false,
    suppressClick: false,
  };

  const REQ_CANDIDATES = {
    ModuleManager: ['ModuleManager', '../modules/ModuleManager', './ModuleManager'],
    Configs: ['Configs', '../../../launcher/config/Configs', '../../../../launcher/config/Configs'],
    Types: ['types-legion-payload', './types-legion-payload', '../../modules/legionPayload/types-legion-payload'],
    LPSignal: ['LPSignal', './LPSignal', '../../modules/legionPayload/LPSignal'],
    DateUtil: ['DateUtil', '../core/utils/DateUtil', '../../core/utils/DateUtil'],
    ServerData: ['ServerData', '../orange/data/ServerData', '../../orange/data/ServerData'],
  };

  function reqOne(names) {
    const reqFn = window.__require || window.require || (typeof require === 'function' ? require : null);
    if (!reqFn) return null;
    for (const name of names) {
      try {
        const mod = reqFn(name);
        if (mod) return mod;
      } catch (_) {
        // Try next candidate.
      }
    }
    return null;
  }

  function req(name) {
    return reqOne(REQ_CANDIDATES[name] || [name]);
  }

  function getServerTime() {
    const DateUtil = req('DateUtil');
    const value = DateUtil?.default?.serverTime ?? DateUtil?.serverTime;
    return typeof value === 'number' ? value : Date.now();
  }

  function getModules() {
    const ModuleManager = req('ModuleManager');
    const Configs = req('Configs');
    const Types = req('Types');
    if (!ModuleManager || !Configs) return null;
    return { ModuleManager, Configs, Types: Types || {} };
  }

  function getLP() {
    const mods = getModules();
    if (!mods?.Configs?.ModuleType) return null;
    try {
      const modType = mods.Configs.ModuleType.LEGION_PAYLOAD || 'LEGION_PAYLOAD';
      return mods.ModuleManager.GET_MODULE(modType);
    } catch (_) {
      return null;
    }
  }

  function log(...args) {
    if (CFG.debug) console.log('[蟠桃园助手]', ...args);
  }

  function logVerbose(...args) {
    if (CFG.debug && CFG.verboseLog) console.log('[蟠桃园助手]', ...args);
  }

  function logError(...args) {
    state.errorCount++;
    state.lastError = args.map((x) => String(x?.message || x)).join(' ');
    console.error('[蟠桃园助手错误]', ...args);
    addTask('error', state.lastError);
  }

  function addTask(type, message, data) {
    state.taskLog.unshift({
      at: new Date().toLocaleTimeString(),
      type,
      message,
      data,
    });
    if (state.taskLog.length > 100) state.taskLog.length = 100;
    renderUI();
  }

  function shouldRun(last, cooldown, now) {
    return now - last >= cooldown;
  }

  function forEachMapLike(value, fn) {
    if (!value) return;
    if (typeof value.forEach === 'function') {
      value.forEach(fn);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => fn(v, i));
      return;
    }
    if (typeof value === 'object') {
      Object.keys(value).forEach((key) => fn(value[key], key));
    }
  }

  function pointOf(obj) {
    const p = obj?.position ?? obj?.pos ?? obj?.serverData?.position ?? obj;
    if (!p) return null;
    const x = Number(p.x);
    const y = Number(p.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function getId(obj, ...keys) {
    for (const key of keys) {
      const value = obj?.[key] ?? obj?.serverData?.[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function distance(a, b) {
    const pa = pointOf(a);
    const pb = pointOf(b);
    if (!pa || !pb) return Infinity;
    return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
  }

  function samePoint(a, b) {
    const pa = pointOf(a);
    const pb = pointOf(b);
    return !!pa && !!pb && pa.x === pb.x && pa.y === pb.y;
  }

  function getReviveSeconds(role, now = getServerTime()) {
    const rawSeconds = role?.reviveTime ?? role?.reviveSeconds ?? role?.remainReviveTime ?? role?.serverData?.reviveTime;
    const seconds = Number(rawSeconds);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);

    const rawAt = role?.reviveAt ?? role?.reviveTimeAt ?? role?.serverData?.reviveAt;
    const reviveAt = Number(rawAt);
    if (!Number.isFinite(reviveAt) || reviveAt <= 0) return 0;
    const nowSeconds = now > 1e12 ? now / 1000 : now;
    const reviveSeconds = reviveAt > 1e12 ? reviveAt / 1000 : reviveAt;
    return Math.max(0, Math.ceil(reviveSeconds - nowSeconds));
  }

  function getTrackedReviveSeconds(now = getServerTime()) {
    if (!state.reviveDeadlineAt) return state.lastReviveSeconds || 0;
    return Math.max(0, Math.ceil((state.reviveDeadlineAt - now) / 1000));
  }

  function markReviveReady(now = getServerTime()) {
    state.wasDead = false;
    state.lastReviveSeconds = 0;
    state.reviveDeadlineAt = 0;
    state.reviveReadyAt = now;
  }

  function isReviveReadyGrace(now = getServerTime()) {
    return !!state.reviveReadyAt && now - state.reviveReadyAt <= CFG.reviveReadyGraceMs;
  }

  function clearReviveReady() {
    state.reviveReadyAt = 0;
  }
  function getBattlefield(lp = getLP()) {
    return lp?.lPWarData?.battlefield || null;
  }

  function getSelf(bf = getBattlefield()) {
    return bf?.self || null;
  }

  function isEnemy(self, role) {
    if (!self || !role) return false;
    const selfId = getId(self, 'roleId', 'id');
    const roleId = getId(role, 'roleId', 'id');
    if (selfId && roleId && selfId === roleId) return false;
    if (role.isDead || role.dead) return false;
    if (role.legionId !== undefined && self.legionId !== undefined && role.legionId === self.legionId) return false;
    if (role.campId !== undefined && self.campId !== undefined && role.campId === self.campId) return false;
    return !!pointOf(role);
  }

  function isRoleOnCar(role, car) {
    const roleId = getId(role, 'roleId', 'id');
    if (!roleId || !car) return false;
    if (role.isOnCar) return true;
    if (car.memberMap?.has?.(roleId)) return true;
    const queues = [car.friendQueue, car.enemyQueue, car.battleQueue, car.members, car.memberList];
    return queues.some((list) => Array.isArray(list) && list.some((item) => getId(item, 'roleId', 'id') === roleId));
  }

  function getCars(bf) {
    const cars = [];
    forEachMapLike(bf?.carData, (car) => {
      if (car && !car.isEndMarch) cars.push(car);
    });
    return cars;
  }

  function getRoles(bf) {
    const roles = [];
    forEachMapLike(bf?.roles || bf?.roleData || bf?.playerData, (role) => {
      if (role) roles.push(role);
    });
    return roles;
  }

  function getItems(bf) {
    const items = [];
    forEachMapLike(bf?.itemData || bf?.items || bf?.dropItemData, (item) => {
      if (item && pointOf(item)) items.push(item);
    });
    return items;
  }

  function pickBestCar(bf, self, lp) {
    const cars = getCars(bf);
    if (!cars.length || !pointOf(self)) return null;

    const onCar = cars.find((car) => isRoleOnCar(self, car));
    if (onCar) return onCar;

    const _lp = lp || getLP();
    let validCars = cars;
    if (CFG.strategy.autoDismountNearEnd) {
      validCars = cars.filter((car) => {
        const cid = getId(car, 'carId', 'id');
        if (state.dismountedCarId && String(state.dismountedCarId) === String(cid)) return false;
        const remain = getCarRemainSteps(car, _lp, bf);
        if (remain !== null && remain <= (Number(CFG.strategy.dismountSteps) || 2)) return false;
        return true;
      });
      if (!validCars.length) validCars = cars;
    }

    return validCars
      .map((car) => ({ car, dist: distance(self, car) }))
      .filter((x) => Number.isFinite(x.dist))
      .sort((a, b) => a.dist - b.dist)[0]?.car || null;
  }

  function getCarEndPos(car, lp, bf) {
    if (!car) return null;
    const directEnd = pointOf(car.endPos || car.destination || car.targetPos || car.endPoint);
    if (directEnd) return directEnd;
    if (car.endX !== undefined && car.endY !== undefined) {
      return makePoint(car.endX, car.endY);
    }
    const pathArr = car.marchPath || car.path || car.route || car.points || car.nodeList || car.marchArr;
    if (Array.isArray(pathArr) && pathArr.length > 0) {
      const lastPoint = pointOf(pathArr[pathArr.length - 1]);
      if (lastPoint) return lastPoint;
    }
    const sourceMap = lp?.lPWarData?.sourceMap || lp?.sourceMap || bf?.sourceMap;
    return pointOf(bf?.endPos || lp?.lPWarData?.endPos || sourceMap?.endPos);
  }

  function getCarRemainSteps(car, lp, bf) {
    if (!car) return null;
    if (car.isEndMarch) return 0;

    // 1. 原生显式数值字段探测
    const directNum = Number(car.remainSteps ?? car.remainStep ?? car.leftSteps ?? car.remainingSteps ?? car.remainDist);
    if (Number.isFinite(directNum) && directNum >= 0) {
      return Math.floor(directNum);
    }

    const carPos = pointOf(car);
    if (!carPos) return null;

    // 2. 基于行军路径数组的步数推算
    const pathArr = car.marchPath || car.path || car.route || car.points || car.nodeList || car.marchArr;
    if (Array.isArray(pathArr) && pathArr.length > 0) {
      const curIdx = Number(car.pathIndex ?? car.marchIndex ?? car.stepIndex ?? car.curIndex ?? car.curStep);
      if (Number.isFinite(curIdx) && curIdx >= 0) {
        return Math.max(0, pathArr.length - 1 - curIdx);
      }
      let matchIdx = -1;
      for (let i = 0; i < pathArr.length; i++) {
        const p = pointOf(pathArr[i]);
        if (p && p.x === carPos.x && p.y === carPos.y) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx !== -1) {
        return Math.max(0, pathArr.length - 1 - matchIdx);
      }
      let minD = Infinity;
      let closestIdx = -1;
      for (let i = 0; i < pathArr.length; i++) {
        const p = pointOf(pathArr[i]);
        if (p) {
          const d = distance(carPos, p);
          if (d < minD) {
            minD = d;
            closestIdx = i;
          }
        }
      }
      if (closestIdx !== -1) {
        return Math.max(0, pathArr.length - 1 - closestIdx);
      }
    }

    // 3. 终点坐标距离推算
    const endPos = getCarEndPos(car, lp, bf);
    if (endPos) {
      if (samePoint(carPos, endPos)) return 0;
      try {
        const path = buildPath(lp, endPos);
        if (Array.isArray(path)) return path.length;
      } catch (_) {}
      return Math.max(Math.abs(carPos.x - endPos.x), Math.abs(carPos.y - endPos.y));
    }

    return null;
  }

  function isPointBlocked(sourceMap, x, y) {
    if (!sourceMap) return false;
    try {
      if (typeof sourceMap.isBlock === 'function') return !!sourceMap.isBlock(x, y);
      if (typeof sourceMap.checkCanMove === 'function') return !sourceMap.checkCanMove(x, y);
      if (typeof sourceMap.canMove === 'function') return !sourceMap.canMove(x, y);
      if (sourceMap.map && typeof sourceMap.map.isBlock === 'function') return !!sourceMap.map.isBlock(x, y);
    } catch (_) {}
    return false;
  }

  function getDismountPos(car, self, lp, bf) {
    const carPos = pointOf(car) || pointOf(self);
    if (!carPos) return null;

    const sourceMap = lp?.lPWarData?.sourceMap || lp?.sourceMap || bf?.sourceMap;
    const endPos = getCarEndPos(car, lp, bf);

    const dirs = [
      { dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
      { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }, { dx: 1, dy: 1 },
    ];

    const candidates = [];
    for (const { dx, dy } of dirs) {
      const nx = carPos.x + dx;
      const ny = carPos.y + dy;
      if (nx < 0 || ny < 0) continue;
      if (isPointBlocked(sourceMap, nx, ny)) continue;

      const p = makePoint(nx, ny);
      try {
        const testPath = buildPath(lp, p);
        if (Array.isArray(testPath) && testPath.length > 0 && testPath.length <= 3) {
          const endDist = endPos ? distance(p, endPos) : 0;
          candidates.push({ pos: p, endDist });
        }
      } catch (_) {}
    }

    if (!candidates.length) {
      for (const { dx, dy } of dirs) {
        const nx = carPos.x + dx;
        const ny = carPos.y + dy;
        if (nx >= 0 && ny >= 0 && !isPointBlocked(sourceMap, nx, ny)) {
          return makePoint(nx, ny);
        }
      }
      return null;
    }

    // 优先选择远离终点的安全方向下船
    candidates.sort((a, b) => b.endDist - a.endDist);
    return candidates[0].pos;
  }

  function tryDismountCar(lp, car, self, bf, remainSteps) {
    if (!lp || !car) return false;
    const dismountPos = getDismountPos(car, self, lp, bf);
    if (!dismountPos) {
      logVerbose('未找到安全下船落脚点');
      return false;
    }

    const path = buildPath(lp, dismountPos) || [dismountPos];
    if (!path.length) return false;

    if (typeof lp.sendMarch === 'function') {
      lp.sendMarch(path);
      state.moveCount++;
      log(`【终点下船】向安全坐标 (${dismountPos.x}, ${dismountPos.y}) 下船成功 (剩余${remainSteps}步)`);
      return true;
    }
    return false;
  }

  function pickBestEnemy(bf, self, car) {
    const enemies = getRoles(bf)
      .filter((role) => isEnemy(self, role))
      .map((role) => {
        const selfOnCar = car ? isRoleOnCar(self, car) : false;
        const roleOnCar = car ? isRoleOnCar(role, car) : !!role.isOnCar;
        // 双方都在同一艘船上时直接视为面对面距离 0
        const dist = (selfOnCar && roleOnCar) ? 0 : distance(self, role);
        return {
          role,
          dist,
          carDist: car ? distance(role, car) : Infinity,
          onCar: roleOnCar,
        };
      })
      .filter((x) => x.dist <= CFG.attackRange);

    if (!enemies.length) return null;

    if (CFG.strategy.priorityTarget === 'onCar') {
      const hit = enemies.find((x) => x.onCar);
      if (hit) return hit.role;
    }

    if (CFG.strategy.priorityTarget === 'nearCar' && car) {
      const hit = enemies
        .filter((x) => x.carDist <= (Number(CFG.strategy.carDistance) || 3))
        .sort((a, b) => a.carDist - b.carDist || a.dist - b.dist)[0];
      if (hit) return hit.role;
    }

    return enemies.sort((a, b) => a.dist - b.dist)[0].role;
  }

  function pickBestItem(bf, self) {
    return getItems(bf)
      .map((item) => ({ item, dist: distance(self, item) }))
      .filter((x) => Number.isFinite(x.dist))
      .sort((a, b) => a.dist - b.dist)[0]?.item || null;
  }

  function makePoint(x, y) {
    return { x: Number(x), y: Number(y) };
  }

  function buildPath(lp, target) {
    const bf = getBattlefield(lp);
    const self = getSelf(bf);
    const selfPos = pointOf(self);
    const targetPos = pointOf(target);
    if (!selfPos || !targetPos) return null;

    if (samePoint(selfPos, targetPos)) return [];

    const sourceMap = lp?.lPWarData?.sourceMap || lp?.sourceMap || bf?.sourceMap;
    try {
      if (sourceMap?.map?.refreshMarchData) {
        sourceMap.map.refreshMarchData(selfPos.x, selfPos.y);
      }
      if (typeof sourceMap?.marchArr === 'function') {
        const arr = sourceMap.marchArr(targetPos.x, targetPos.y) || [];
        const path = arr
          .slice()
          .reverse()
          .map(pointOf)
          .filter(Boolean);
        if (path.length) {
          const last = path[path.length - 1];
          if (last.x !== targetPos.x || last.y !== targetPos.y) path.push(targetPos);
          return path.map((p) => makePoint(p.x, p.y));
        }
      }
    } catch (error) {
      logVerbose('寻路失败', error);
    }

    return [makePoint(targetPos.x, targetPos.y)];
  }

  function sendMoveTo(lp, target, carId = 0) {
    const path = buildPath(lp, target);
    if (!path) return false;
    if (!path.length) return true;

    if (carId && typeof lp.sendGetCar === 'function') {
      lp.sendGetCar(carId, path);
    } else if (typeof lp.sendMarch === 'function') {
      lp.sendMarch(path);
    } else {
      return false;
    }

    state.moveCount++;
    addTask('ok', `移动到 ${pointText(target)}，路径 ${path.length} 步`);
    return true;
  }

  function safeCall(name, fn) {
    try {
      const result = fn();
      addTask('ok', `${name} 已发送`);
      return result;
    } catch (error) {
      logError(`${name} 失败`, error);
      return null;
    }
  }

  function getRoleData() {
    const ServerData = req('ServerData');
    return ServerData?.ROLE || ServerData?.default?.ROLE || window.ServerData?.ROLE || null;
  }

  const HERO_NAMES = {
    101: '司马懿', 102: '郭嘉', 103: '关羽', 104: '诸葛亮', 105: '周瑜',
    106: '太史慈', 107: '吕布', 108: '华佗', 109: '甄姬', 110: '黄月英',
    111: '孙策', 112: '贾诩', 113: '曹仁', 114: '姜维', 115: '孙坚',
    116: '公孙瓒', 117: '典韦', 118: '赵云', 119: '大乔', 120: '张角',
    121: '鲁肃', 201: '徐晃', 202: '荀彧', 203: '典韦', 204: '张飞',
    205: '赵云', 206: '庞统', 207: '鲁肃', 208: '陆逊', 209: '甘宁',
    210: '貂蝉', 211: '董卓', 212: '张角', 213: '张辽', 214: '夏侯惇',
    215: '许褚', 216: '夏侯渊', 217: '魏延', 218: '黄忠', 219: '马超',
    220: '马岱', 221: '吕蒙', 222: '黄盖', 223: '蔡文姬', 224: '小乔',
    225: '袁绍', 226: '华雄', 227: '颜良', 228: '文丑', 301: '周泰',
    302: '许攸', 303: '于禁', 304: '张星彩', 305: '关银屏', 306: '关平',
    307: '程普', 308: '张昭', 309: '陆绩', 310: '吕玲绮', 311: '潘凤',
    312: '邢道荣', 313: '祝融夫人', 314: '孟获',
  };

  function getHeroName(id) {
    return HERO_NAMES[id] || `武将${id}`;
  }

  function getHeroIdFromTeamEntry(entry) {
    const heroId = Number(entry?.heroId ?? entry?.id ?? entry);
    return Number.isFinite(heroId) && heroId > 0 ? heroId : 0;
  }

  function getCurrentActiveLineup() {
    const role = getRoleData();
    const team = new Map();

    forEachMapLike(role?.battleTeam, (entry, slot) => {
      const heroId = getHeroIdFromTeamEntry(entry);
      const slotId = Number(slot);
      if (heroId && Number.isFinite(slotId)) team.set(slotId, heroId);
    });

    if (!team.size && role?.heroes) {
      forEachMapLike(role.heroes, (h) => {
        const slot = Number(h?.battleTeamSlot);
        const heroId = Number(h?.heroId);
        if (slot > 0 && heroId > 0) team.set(slot, heroId);
      });
    }

    const heroNames = [];
    team.forEach((heroId) => {
      if (heroId) heroNames.push(getHeroName(heroId));
    });

    return {
      heroNames,
      heroesText: heroNames.length ? heroNames.join('/') : '暂未同步到英雄',
      team,
      lordWeaponId: Number(role?.lordWeaponId ?? 0) || 0,
      petUId: role?.petData?.petUId || role?.petUId || '',
    };
  }

  function detectAllLineups() {
    return getCurrentActiveLineup();
  }

  function getAvailableLineups() {
    return [getCurrentActiveLineup()];
  }

  function buildMainTeamDeployPayload() {
    const cur = getCurrentActiveLineup();
    if (cur && cur.team && cur.team.size > 0) {
      return {
        battleTeam: cur.team,
        lordWeaponId: cur.lordWeaponId,
        petUId: cur.petUId,
      };
    }

    const role = getRoleData();
    const battleTeam = new Map();
    forEachMapLike(role?.battleTeam, (entry, slot) => {
      const heroId = getHeroIdFromTeamEntry(entry);
      const slotId = Number(slot);
      if (heroId && Number.isFinite(slotId)) battleTeam.set(slotId, heroId);
    });
    return {
      battleTeam,
      lordWeaponId: Number(role?.lordWeaponId ?? 0) || 0,
      petUId: role?.petData?.petUId || role?.petUId || '',
    };
  }

  function deploySignature(payload) {
    if (!payload?.battleTeam?.size) return '';
    const team = [];
    payload.battleTeam.forEach((heroId, slot) => team.push(`${slot}:${heroId}`));
    team.sort();
    return `${team.join('|')}|w:${payload.lordWeaponId || 0}|p:${payload.petUId || ''}`;
  }

  function deployMainTeam(lp = getLP(), force = false) {
    if (!lp) {
      addTask('error', '未找到 LEGION_PAYLOAD 模块');
      return false;
    }
    if (!lp?.sendSetBattleTeam && !lp?.deployData?.sendSetBattleTeam) {
      addTask('error', '未找到蟠桃园保存布阵接口');
      return false;
    }

    const payload = buildMainTeamDeployPayload();
    if (!payload.battleTeam.size) {
      addTask('error', 'main team is empty, cannot deploy');
      return false;
    }

    const bf = getBattlefield(lp);
    const battlefieldId = bf?.id || '';
    const signature = deploySignature(payload);
    if (!force && state.deployReady && state.deployBattlefieldId === battlefieldId && state.lastDeploySignature === signature) return true;
    if (state.deployPending) return true;

    state.deployPending = true;
    state.deployReady = false;
    state.deployBattlefieldId = battlefieldId;
    state.lastDeploySignature = signature;

    const send = () => {
      if (lp.deployData?.dealDeploy) {
        return Promise.resolve(lp.deployData.dealDeploy(payload.battleTeam, payload.lordWeaponId, payload.petUId))
          .then(() => (lp.sendSetBattleTeam ? lp.sendSetBattleTeam(payload.battleTeam, payload.lordWeaponId, payload.petUId) : lp.deployData.sendSetBattleTeam()));
      }
      return lp.sendSetBattleTeam(payload.battleTeam, payload.lordWeaponId, payload.petUId);
    };

    try {
      const result = send();
      Promise.resolve(result)
        .then(() => {
          state.deployCount++;
          state.deployReady = true;
          state.deployBattlefieldId = battlefieldId;
          addTask('ok', `布阵已提交：${payload.battleTeam.size} 个武将`);
          updateSnapshot();
        })
        .catch((error) => {
          state.deployReady = false;
          state.lastDeploySignature = '';
          logError('布阵失败', error);
        })
        .finally(() => {
          state.deployPending = false;
        });
      return true;
    } catch (error) {
      state.deployPending = false;
      state.deployReady = false;
      state.lastDeploySignature = '';
          logError('布阵失败', error);
      return false;
    }
  }

  function resetDeployState() {
    state.deployReady = false;
    state.deployBattlefieldId = '';
    state.lastDeploySignature = '';
  }

  function forceDeployOnce(lp = getLP(), reason = '自动布阵一次', now = getServerTime(), enterAfter = false, ignoreCooldown = false) {
    if (state.deployPending) return true;
    if (!ignoreCooldown && !shouldRun(state.lastForcedDeployAt, CFG.deployCooldownMs, now)) return false;

    resetDeployState();
    state.lastDeployOpen = now;
    state.lastForcedDeployAt = now;
    addTask('info', reason);
    let ok = true;
    if (CFG.strategy.autoOpenDeploy) {
      ok = deployMainTeam(lp, true);
    }

    if (enterAfter) {
      setTimeout(() => {
        const nextLp = getLP();
        if (state.running && nextLp) tryEnterBattle(nextLp, true);
      }, CFG.deployEnterDelayMs);
    }
    return ok;
  }

  function tryEnterBattle(lp, force = false) {
    const now = getServerTime();
    if (!force && !CFG.strategy.autoEnter) return false;
    if (!force && !shouldRun(state.lastEnter, CFG.enterCooldownMs, now)) return false;
    if (!lp?.startBattle) return false;

    state.lastEnter = now;
    state.enterPending = true;

    safeCall('进入战场', () => lp.startBattle(force));
    return true;
  }

  function ensureDeployReady(lp, self, now) {
    if (!self || self.isDead) return false;
    if (!CFG.strategy.autoOpenDeploy) return true;
    const bf = getBattlefield(lp);
    const battlefieldId = bf?.id || '';
    if (state.deployReady && state.deployBattlefieldId === battlefieldId) return true;
    if (state.deployPending) return false;
    if (!shouldRun(state.lastDeployOpen, CFG.deployCooldownMs, now)) return false;

    state.lastDeployOpen = now;
    if (deployMainTeam(lp, false)) return false;
    if (lp?.sendStart) safeCall('open deploy', () => lp.sendStart());
    return false;
  }

  function tick() {
    if (!state.running) return;

    try {
      const lp = getLP();
      if (!lp) return;

      const bf = getBattlefield(lp);
      const now = getServerTime();

      if (!bf?.self) {
        if (state.deployAfterRevivePending || state.wasDead) {
          const reviveLeft = getTrackedReviveSeconds(now);
          if (reviveLeft <= 0) {
            markReviveReady(now);
            if (forceDeployOnce(lp, '复活倒计时结束，自动布阵并进场', now, true, true)) {
              state.deployAfterRevivePending = false;
            }
          }
        }
        tryEnterBattle(lp, false);
        updateSnapshot();
        return;
      }

      if (state.enterPending) {
        state.enterPending = false;
        state.enterRetryCount = 0;
        resetDeployState();
        addTask('ok', '已进入战场');
      }

      const self = bf.self;
      const currentBattlefieldId = bf?.id || 'unknown';
      if (state.lastSeenBattlefieldId !== currentBattlefieldId) {
        state.lastSeenBattlefieldId = currentBattlefieldId;
        forceDeployOnce(lp, '进入战场，自动布阵一次', now, false, true);
      }

      if (state.deployBattlefieldId && state.deployBattlefieldId !== bf.id) {
        resetDeployState();
      }

      if ((self.isDead || self.dead) && isReviveReadyGrace(now)) {
        state.lastReviveSeconds = 0;
        state.reviveDeadlineAt = 0;
        if (forceDeployOnce(lp, '复活已就绪，自动布阵并进场', now, true, false)) {
          state.deployAfterRevivePending = false;
        }
        updateSnapshot();
        return;
      }

      if (self.isDead || self.dead) {
        const reviveSeconds = getReviveSeconds(self, now);
        if (!state.wasDead) {
          state.deathCount++;
          state.lastDeathAt = now;
          state.wasDead = true;
          state.lastReviveSeconds = reviveSeconds;
          state.reviveDeadlineAt = now + Math.max(1, reviveSeconds || 0) * 1000;
          state.deployAfterRevivePending = true;
          addTask('info', `战斗失败，等待复活：${state.lastReviveSeconds || '-'}秒`);
        } else {
          state.lastReviveSeconds = getTrackedReviveSeconds(now);
        }
        if (state.deployAfterRevivePending && getTrackedReviveSeconds(now) <= 0) {
          markReviveReady(now);
          if (forceDeployOnce(lp, '复活倒计时结束，自动布阵并进场', now, true, true)) {
            state.deployAfterRevivePending = false;
          }
        }
        updateSnapshot();
        return;
      }
      clearReviveReady();
      if (state.wasDead) {
        state.wasDead = false;
        state.lastReviveSeconds = 0;
        state.reviveDeadlineAt = 0;
        clearReviveReady();
        addTask('ok', '已复活，继续执行');
        if (state.deployAfterRevivePending) {
          state.deployAfterRevivePending = false;
          forceDeployOnce(lp, '复活完成，自动布阵并进场', now, true, true);
        } else {
          state.deployAfterRevivePending = false;
        }
      }

      ensureDeployReady(lp, self, now);

      // 检查并重置已下船的船只记录（若该船已到站/离开战场）
      if (state.dismountedCarId) {
        const dismountedCar = getCars(bf).find((c) => String(getId(c, 'carId', 'id')) === String(state.dismountedCarId));
        if (!dismountedCar || dismountedCar.isEndMarch) {
          state.dismountedCarId = 0;
        }
      }

      state.currentCar = pickBestCar(bf, self, lp);
      const isSelfOnCar = !!(state.currentCar && isRoleOnCar(self, state.currentCar));

      // 【终点下船】如果人在船上，且开启了终点下船，检测船只距离终点的剩余步数
      if (CFG.strategy.autoDismountNearEnd && isSelfOnCar && shouldRun(state.lastDismountAt, 1500, now)) {
        const car = state.currentCar;
        const carId = getId(car, 'carId', 'id');
        const remainSteps = getCarRemainSteps(car, lp, bf);

        if (remainSteps !== null && remainSteps <= (Number(CFG.strategy.dismountSteps) || 2)) {
          const success = tryDismountCar(lp, car, self, bf, remainSteps);
          if (success) {
            state.lastDismountAt = now;
            state.dismountedCarId = carId;
            state.dismountCount = (state.dismountCount || 0) + 1;
            addTask('ok', `【终点下船】船只 #${carId} 距终点仅余 ${remainSteps} 步，已主动下船！`);
            updateSnapshot();
            return;
          }
        }
      }

      if (CFG.strategy.autoPickItem && shouldRun(state.lastPick, CFG.pickCooldownMs, now)) {
        const item = pickBestItem(bf, self);
        if (item && distance(self, item) <= 1 && lp.sendPickItem) {
          state.lastPick = now;
          state.pickCount++;
          safeCall('拾取道具', () => lp.sendPickItem());
        }
      }

      if (CFG.strategy.autoUseCarItem && state.currentCar && shouldRun(state.lastUseItem, CFG.useItemCooldownMs, now)) {
        const carId = getId(state.currentCar, 'carId', 'id');
        if (carId && lp.sendUse) {
          state.lastUseItem = now;
          state.useItemCount++;
          safeCall(`使用船只道具 ${carId}`, () => lp.sendUse(carId));
        }
      }

      if (CFG.strategy.autoGetOnCar && state.currentCar && !isRoleOnCar(self, state.currentCar)) {
        const carId = getId(state.currentCar, 'carId', 'id');
        const remain = getCarRemainSteps(state.currentCar, lp, bf);
        const nearEnd = remain !== null && remain <= (Number(CFG.strategy.dismountSteps) || 2);
        const justDismounted = state.dismountedCarId && String(state.dismountedCarId) === String(carId);

        // 如果开启了终点下船策略，且该船即将到站或刚刚主动下船，禁止自动重新上船
        if (CFG.strategy.autoDismountNearEnd && (nearEnd || justDismounted)) {
          // 避让不重新上船
        } else if (carId && shouldRun(state.lastMove, CFG.moveCooldownMs, now)) {
          state.lastMove = now;
          sendMoveTo(lp, state.currentCar, carId);
        }
      }

      if (CFG.strategy.autoAttack && shouldRun(state.lastBattle, CFG.battleCooldownMs, now)) {
        const enemy = pickBestEnemy(bf, self, state.currentCar);
        const enemyId = getId(enemy, 'roleId', 'id');
        if (enemyId && lp.sendBattle) {
          state.lastBattle = now;
          state.battleCount++;
          safeCall(`攻击 ${enemyId}`, () => lp.sendBattle(enemyId));
        }
      }

      state.consecutiveErrors = 0;
      updateSnapshot();
    } catch (error) {
      state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
      logError('主循环异常', error);
      if (state.consecutiveErrors > 15) {
        state.running = false;
        addTask('error', '连续异常过多，已自动暂停');
      }
    }
  }

  function updateSnapshot() {
    state.lastSnapshot = getDetailedStatus();
    renderUI();
  }

  function pointText(value) {
    const p = pointOf(value);
    return p ? `${p.x},${p.y}` : '-';
  }

  function getDetailedStatus() {
    const lp = getLP();
    const bf = getBattlefield(lp);
    const mods = getModules();
    if (!lp) return { ready: false, status: '未找到 LEGION_PAYLOAD 模块' };
    if (!bf?.self) {
      return {
        ready: true,
        status: '未进入战场',
        stage: lp.lpMatchDay?.stage,
        isBattleDay: !!lp.isBattleDay,
        isSignUp: !!lp.lpMatchDay?.isSignUp,
        hasRed: !!lp.hasRed?.(),
      };
    }

    const self = bf.self;
    const reviveSeconds = isReviveReadyGrace() ? 0 : (state.wasDead ? getTrackedReviveSeconds() : getReviveSeconds(self));
    const car = state.currentCar || pickBestCar(bf, self, lp);
    const carRemainSteps = car ? getCarRemainSteps(car, lp, bf) : null;
    const roles = getRoles(bf);
    const enemies = roles.filter((role) => isEnemy(self, role));
    const nearbyEnemies = enemies.filter((role) => distance(self, role) <= CFG.attackRange);
    const cars = getCars(bf);
    const items = getItems(bf);

    return {
      ready: true,
      status: '战场中',
      bfId: bf.id,
      selfId: getId(self, 'roleId', 'id'),
      selfState: self.state,
      selfPos: pointOf(self),
      isDead: !!(self.isDead || self.dead),
      reviveSeconds,
      isOnCar: !!(car && isRoleOnCar(self, car)),
      stage: lp.lpMatchDay?.stage,
      stageName: stageName(lp.lpMatchDay?.stage, mods?.Types),
      carCount: cars.length,
      currentCarId: getId(car, 'carId', 'id'),
      currentCarPos: pointOf(car),
      carRemainSteps,
      dismountCount: state.dismountCount || 0,
      enemyCount: enemies.length,
      nearbyEnemyCount: nearbyEnemies.length,
      itemCount: items.length,
      nearestItemPos: pointOf(pickBestItem(bf, self)),
    };
  }

  function stageName(value, Types) {
    const LPStage = Types?.LPStage;
    if (!LPStage || value === undefined || value === null) return value ?? '-';
    return LPStage[value] || String(value);
  }

  function cssText() {
    return `
      #lp-smart-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: min(390px, calc(100vw - 20px));
        max-height: min(720px, calc(100vh - 24px));
        display: flex;
        flex-direction: column;
        color: #edf2f7;
        background: rgba(18, 22, 28, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        box-shadow: 0 16px 44px rgba(0, 0, 0, 0.36);
        font: 12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
        overflow: hidden;
        touch-action: none;
      }
      #lp-smart-panel.lp-min {
        width: 58px;
        height: 58px;
        max-height: 58px;
        border-radius: 50%;
        background: rgba(28, 22, 30, 0.92);
        border-color: rgba(255, 174, 201, 0.72);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36);
      }
      #lp-smart-panel * { box-sizing: border-box; }
      #lp-smart-panel .lp-head {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.05);
        cursor: pointer;
        user-select: none;
      }
      #lp-smart-panel.lp-min .lp-head {
        width: 58px;
        height: 58px;
        padding: 0;
        border: 0;
        background: transparent;
        justify-content: center;
      }
      #lp-smart-panel.lp-min .lp-title,
      #lp-smart-panel.lp-min [data-action="toggleRun"] { display: none; }
      #lp-smart-panel.lp-min [data-action="min"] {
        width: 48px;
        height: 48px;
        padding: 0;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.34);
        background:
          radial-gradient(circle at 34% 28%, #fff7ed 0 12%, #fecaca 13% 25%, transparent 26%),
          radial-gradient(circle at 58% 42%, #fb7185 0 34%, #e11d48 35% 62%, #831843 63%);
        box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.08);
        font-size: 0;
        position: relative;
        cursor: move;
      }
      #lp-smart-panel.lp-min [data-action="min"]::before {
        content: '';
        position: absolute;
        left: 23px;
        top: 7px;
        width: 17px;
        height: 12px;
        border-radius: 100% 0 100% 0;
        background: linear-gradient(135deg, #86efac, #15803d);
        transform: rotate(-18deg);
      }
      #lp-smart-panel.lp-min [data-action="min"]::after {
        content: '桃';
        position: absolute;
        left: 14px;
        bottom: 5px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: rgba(76, 5, 25, 0.72);
        color: #fff;
        font-size: 13px;
        line-height: 20px;
        text-align: center;
        font-weight: 700;
      }
      #lp-smart-panel .lp-title { font-weight: 700; font-size: 13px; }
      #lp-smart-panel .lp-body {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        display: grid;
        gap: 8px;
        padding: 8px 10px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
      }
      #lp-smart-panel .lp-body::-webkit-scrollbar {
        width: 5px;
      }
      #lp-smart-panel .lp-body::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.22);
        border-radius: 4px;
      }
      #lp-smart-panel.lp-min .lp-body { display: none; }
      #lp-smart-panel .lp-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      #lp-smart-panel button,
      #lp-smart-panel select {
        height: 26px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 6px;
        color: #eef3f8;
        background: rgba(255, 255, 255, 0.08);
        padding: 0 7px;
        font-size: 11.5px;
        line-height: 24px;
      }
      #lp-smart-panel button:hover,
      #lp-smart-panel select:hover { background: rgba(255, 255, 255, 0.14); }
      #lp-smart-panel select {
        color-scheme: dark;
        cursor: pointer;
      }
      #lp-smart-panel select option {
        background-color: #1a2028;
        color: #eef3f8;
        padding: 4px 6px;
      }
      #lp-smart-panel button[data-active="true"] {
        color: #101418;
        background: #7ed6a5;
        border-color: #7ed6a5;
      }
      #lp-smart-panel .lp-card {
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        padding: 7px 8px;
        background: rgba(255, 255, 255, 0.045);
      }
      #lp-smart-panel .lp-stats {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 5px;
      }
      #lp-smart-panel .lp-stat { min-width: 0; color: #aeb8c5; font-size: 11px; }
      #lp-smart-panel .lp-stat b {
        display: block;
        color: #ffffff;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }
      #lp-smart-panel .lp-log {
        max-height: 150px;
        overflow-y: auto;
        display: grid;
        gap: 4px;
        font-size: 11px;
      }
      #lp-smart-panel .lp-log-item {
        display: grid;
        grid-template-columns: 58px 1fr;
        gap: 5px;
        color: #d7dee8;
      }
      #lp-smart-panel .lp-log-time { color: #7f8b99; }
      #lp-smart-panel .lp-log-item[data-type="error"] { color: #ffaaa3; }
      #lp-smart-panel .lp-log-item[data-type="ok"] { color: #9fe6ba; }
      #lp-smart-panel .lp-hero-tag {
        display: inline-flex;
        align-items: center;
        height: 26px;
        padding: 0 8px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: #e2e8f0;
        font-size: 11.5px;
        max-width: 175px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      @media (max-width: 520px) {
        #lp-smart-panel {
          width: min(390px, calc(100vw - 12px));
          max-height: min(650px, calc(100vh - 16px));
        }
        #lp-smart-panel.lp-min {
          width: 58px;
          height: 58px;
          max-height: 58px;
        }
        #lp-smart-panel .lp-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        #lp-smart-panel .lp-log { max-height: 120px; }
      }
    `;
  }

  const UI_POS_KEY = 'lp-smart-panel-pos-v1';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function loadPanelPos() {
    try {
      const raw = localStorage.getItem(UI_POS_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const x = Number(data.x);
      const y = Number(data.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    } catch (_) {
      return null;
    }
  }

  function savePanelPos(pos) {
    try {
      localStorage.setItem(UI_POS_KEY, JSON.stringify(pos));
    } catch (_) {
      // ignore storage failure
    }
  }

  function applyPanelPos(root, pos) {
    if (!root || !pos) return;
    const width = root.offsetWidth || 58;
    const height = root.offsetHeight || 58;
    const x = clamp(Number(pos.x) || 0, 0, Math.max(0, window.innerWidth - width));
    const y = clamp(Number(pos.y) || 0, 0, Math.max(0, window.innerHeight - height));
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  function initPanelDrag(root) {
    root.addEventListener('pointerdown', (event) => {
      const head = event.target.closest('.lp-head');
      if (!head) return;
      if (!root.classList.contains('lp-min') && event.target.closest('button,select')) return;

      const rect = root.getBoundingClientRect();
      ui.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startedMinimized: root.classList.contains('lp-min'),
      };
      ui.moved = false;
      root.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    root.addEventListener('pointermove', (event) => {
      if (!ui.drag || event.pointerId !== ui.drag.pointerId) return;
      const dx = Math.abs(event.clientX - ui.drag.startX);
      const dy = Math.abs(event.clientY - ui.drag.startY);
      if (dx + dy > 4) ui.moved = true;
      if (!ui.moved) return;

      const width = root.offsetWidth || 58;
      const height = root.offsetHeight || 58;
      const x = clamp(event.clientX - ui.drag.offsetX, 0, Math.max(0, window.innerWidth - width));
      const y = clamp(event.clientY - ui.drag.offsetY, 0, Math.max(0, window.innerHeight - height));
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      event.preventDefault();
    });

    const finish = (event) => {
      if (!ui.drag || event.pointerId !== ui.drag.pointerId) return;
      root.releasePointerCapture?.(event.pointerId);
      if (ui.moved) {
        const rect = root.getBoundingClientRect();
        savePanelPos({ x: rect.left, y: rect.top });
      } else if (ui.drag.startedMinimized) {
        ui.suppressClick = true;
        toggleMinimized(root.querySelector('[data-action="min"]'));
      }
      ui.drag = null;
      setTimeout(() => {
        ui.moved = false;
        ui.suppressClick = false;
      }, 0);
    };
    root.addEventListener('pointerup', finish);
    root.addEventListener('pointercancel', finish);
  }

  function initUI() {
    if (ui.root || !document.body) return;

    const style = document.createElement('style');
    style.textContent = cssText();
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'lp-smart-panel';
    root.innerHTML = `
      <div class="lp-head">
        <div class="lp-title">蟠桃园测试助手</div>
        <div class="lp-row">
          <button type="button" data-action="toggleRun"></button>
          <button type="button" data-action="min" title="收起为圆形图标">-</button>
        </div>
      </div>
      <div class="lp-body">
        <div class="lp-card lp-stats" data-role="status"></div>
        <div class="lp-card">
          <div class="lp-row">
            <button type="button" data-action="autoEnter">自动进场</button>
            <button type="button" data-action="autoCar">自动上船</button>
            <button type="button" data-action="autoDismount" title="船只快到终点时自动下船，实现无人驾驶进站">终点下船</button>
            <button type="button" data-action="autoAttack">自动攻击</button>
            <button type="button" data-action="autoPick">自动拾取</button>
            <button type="button" data-action="autoUse">使用船只道具</button>
            <button type="button" data-action="autoDeploy">自动布阵</button>
          </div>
          <div class="lp-row" style="margin-top:8px">
            <select data-action="priority" title="攻击目标优先级">
              <option value="nearCar">优先护船</option>
              <option value="onCar">优先船上敌人</option>
              <option value="nearest">优先最近敌人</option>
            </select>
            <span class="lp-hero-tag" data-role="heroListText" title="当前布阵英雄">同步中...</span>
            <button type="button" data-action="enterNow">手动进场</button>
            <button type="button" data-action="deployNow">布阵一次</button>
            <button type="button" data-action="moveCar">去最近船</button>
            <button type="button" data-action="attackNow">攻击一次</button>
            <button type="button" data-action="pickNow">拾取一次</button>
          </div>
        </div>
        <div class="lp-card">
          <div class="lp-row" style="justify-content:space-between;margin-bottom:6px">
            <b>日志</b>
            <span class="lp-row">
              <button type="button" data-action="diagnose">诊断</button>
              <button type="button" data-action="reset">重置统计</button>
              <button type="button" data-action="clearLog">清空</button>
            </span>
          </div>
          <div class="lp-log" data-role="log"></div>
        </div>
      </div>
    `;

    root.addEventListener('click', onPanelClick);
    root.addEventListener('change', onPanelChange);
    document.body.appendChild(root);
    initPanelDrag(root);
    applyPanelPos(root, loadPanelPos());

    ui.root = root;
    ui.status = root.querySelector('[data-role="status"]');
    ui.log = root.querySelector('[data-role="log"]');
    renderUI();
  }

  function onPanelClick(event) {
    if (ui.suppressClick) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (ui.moved) return;
    const button = event.target.closest('button');
    if (!button) return;
    const action = button.dataset.action;
    const api = window.__LP_SMART__;

    if (action === 'toggleRun') state.running ? api.stop() : api.start();
    if (action === 'min') {
      toggleMinimized(button);
      return;
    }
    if (action === 'autoEnter') api.setStrategy('autoEnter', !CFG.strategy.autoEnter);
    if (action === 'autoCar') api.setStrategy('autoGetOnCar', !CFG.strategy.autoGetOnCar);
    if (action === 'autoDismount') api.setStrategy('autoDismountNearEnd', !CFG.strategy.autoDismountNearEnd);
    if (action === 'autoAttack') api.setStrategy('autoAttack', !CFG.strategy.autoAttack);
    if (action === 'autoPick') api.setStrategy('autoPickItem', !CFG.strategy.autoPickItem);
    if (action === 'autoUse') api.setStrategy('autoUseCarItem', !CFG.strategy.autoUseCarItem);
    if (action === 'autoDeploy') api.setStrategy('autoOpenDeploy', !CFG.strategy.autoOpenDeploy);
    if (action === 'enterNow') api.enterNow();
    if (action === 'deployNow') api.deployNow();
    if (action === 'moveCar') api.moveToCar();
    if (action === 'attackNow') api.attackNearest();
    if (action === 'pickNow') api.pickItem();
    if (action === 'diagnose') api.diagnose();
    if (action === 'reset') api.resetStats();
    if (action === 'clearLog') {
      state.taskLog.length = 0;
      renderUI();
    }
  }

  function toggleMinimized(button) {
    if (!ui.root) return;
    ui.minimized = !ui.minimized;
    ui.root.classList.toggle('lp-min', ui.minimized);
    const rect = ui.root.getBoundingClientRect();
    applyPanelPos(ui.root, { x: rect.left, y: rect.top });
    const nextRect = ui.root.getBoundingClientRect();
    savePanelPos({ x: nextRect.left, y: nextRect.top });
    button.title = ui.minimized ? '展开助手' : '收起助手';
  }

  function onPanelChange(event) {
    const priSelect = event.target.closest('select[data-action="priority"]');
    if (priSelect) window.__LP_SMART__.setStrategy('priorityTarget', priSelect.value);
  }

  function renderUI() {
    if (!ui.root) return;

    const detail = state.lastSnapshot || getDetailedStatus();
    const curTeam = getCurrentActiveLineup();

    const heroListEl = ui.root.querySelector('[data-role="heroListText"]');
    if (heroListEl) {
      heroListEl.textContent = curTeam.heroNames.length ? curTeam.heroNames.join('/') : '未同步英雄';
      heroListEl.title = `当前布阵英雄: ${curTeam.heroNames.join(' / ')}`;
    }

    setButton('toggleRun', state.running, state.running ? '暂停' : '启动');
    setButton('autoEnter', CFG.strategy.autoEnter);
    setButton('autoCar', CFG.strategy.autoGetOnCar);
    setButton('autoDismount', CFG.strategy.autoDismountNearEnd);
    setButton('autoAttack', CFG.strategy.autoAttack);
    setButton('autoPick', CFG.strategy.autoPickItem);
    setButton('autoUse', CFG.strategy.autoUseCarItem);
    setButton('autoDeploy', CFG.strategy.autoOpenDeploy);

    const priority = ui.root.querySelector('[data-action="priority"]');
    if (priority) priority.value = CFG.strategy.priorityTarget;

    let carText = '-';
    if (detail.currentCarId) {
      carText = `#${detail.currentCarId}`;
      if (detail.carRemainSteps !== null && detail.carRemainSteps !== undefined) {
        carText += ` (余${detail.carRemainSteps}步)`;
      }
      if (detail.isOnCar) {
        carText += ' [在船上]';
      }
    }

    const fields = [
      ['运行', state.running ? '运行中' : '已暂停'],
      ['状态', detail.status || '-'],
      ['战场', detail.bfId || '-'],
      ['阶段', detail.stageName || detail.stage || '-'],
      ['自身', detail.selfPos ? pointText(detail.selfPos) : '-'],
      ['复活', detail.isDead ? `${detail.reviveSeconds || state.lastReviveSeconds || '-'}秒` : '-'],
      ['船只', carText],
      ['敌人', detail.nearbyEnemyCount ?? '-'],
      ['道具', detail.itemCount ?? '-'],
      ['当前布阵', curTeam.heroNames.join('/') || '-'],
      ['移动', state.moveCount],
      ['攻击', state.battleCount],
      ['拾取', state.pickCount],
      ['布阵状态', state.deployPending ? '提交中' : (state.deployReady ? '已完成' : `${state.deployCount}次`)],
      ['错误', state.errorCount],
    ];

    ui.status.replaceChildren(...fields.map(([label, value]) => {
      const item = document.createElement('div');
      item.className = 'lp-stat';
      const b = document.createElement('b');
      b.textContent = String(value);
      item.append(label, b);
      return item;
    }));

    ui.log.replaceChildren(...state.taskLog.slice(0, 50).map((entry) => {
      const row = document.createElement('div');
      row.className = 'lp-log-item';
      row.dataset.type = entry.type;
      const time = document.createElement('span');
      time.className = 'lp-log-time';
      time.textContent = entry.at;
      const msg = document.createElement('span');
      msg.textContent = entry.message;
      row.append(time, msg);
      return row;
    }));
  }

  function setButton(action, active, text) {
    const btn = ui.root?.querySelector(`[data-action="${action}"]`);
    if (!btn) return;
    btn.dataset.active = String(active);
    if (text) btn.textContent = text;
  }

  function setStrategy(key, value) {
    if (!Object.prototype.hasOwnProperty.call(CFG.strategy, key)) return false;
    CFG.strategy[key] = value;
    addTask('info', `${strategyName(key)} = ${valueText(value)}`);
    renderUI();
    return true;
  }

  function strategyName(key) {
    return {
      autoEnter: '自动进场',
      autoGetOnCar: '自动上船',
      autoDismountNearEnd: '终点下船',
      dismountSteps: '下船步数阈值',
      autoAttack: '自动攻击',
      autoPickItem: '自动拾取',
      autoUseCarItem: '使用船只道具',
      protectCar: '护船',
      autoOpenDeploy: '自动布阵',
      carDistance: '船只距离',
      priorityTarget: '目标优先级',
    }[key] || key;
  }

  function valueText(value) {
    if (value === true) return '开启';
    if (value === false) return '关闭';
    if (value === 'nearCar') return '优先护船';
    if (value === 'onCar') return '优先船上敌人';
    if (value === 'nearest') return '优先最近敌人';
    return String(value);
  }

  const timer = setInterval(tick, CFG.tickMs);
  const uiTimer = setInterval(updateSnapshot, 1000);

  window.__LP_SMART__ = {
    start() {
      state.running = true;
      state.errorCount = 0;
      addTask('info', '已启动');
      log('已启动');
      renderUI();
    },
    stop() {
      state.running = false;
      addTask('info', '已暂停');
      log('已停止');
      renderUI();
    },
    stopTimer() {
      clearInterval(timer);
      clearInterval(uiTimer);
      state.running = false;
      addTask('info', '定时器已停止');
      renderUI();
    },
    setStrategy,
    setConfig(key, value) {
      if (!Object.prototype.hasOwnProperty.call(CFG, key) || key === 'strategy') return false;
      CFG[key] = value;
      addTask('info', `配置 ${strategyName(key)} = ${valueText(value)}`);
      renderUI();
      return true;
    },
    enterNow() {
      const lp = getLP();
      if (!lp) return addTask('error', '未找到 LEGION_PAYLOAD 模块');
      return tryEnterBattle(lp, true);
    },
    deployNow() {
      const lp = getLP();
      return deployMainTeam(lp, true);
    },
    moveToCar() {
      const lp = getLP();
      const bf = getBattlefield(lp);
      const self = getSelf(bf);
      const car = pickBestCar(bf, self, lp);
      const carId = getId(car, 'carId', 'id');
      if (!lp || !bf || !self || !carId) return addTask('error', '没有可用船只或未进入战场');
      state.currentCar = car;
      return sendMoveTo(lp, car, carId);
    },
    dismountNow() {
      const lp = getLP();
      const bf = getBattlefield(lp);
      const self = getSelf(bf);
      const car = state.currentCar || pickBestCar(bf, self, lp);
      if (!lp || !bf || !self || !car) return addTask('error', '未在战场或未找到船只');
      const remain = getCarRemainSteps(car, lp, bf) ?? 0;
      const success = tryDismountCar(lp, car, self, bf, remain);
      if (success) {
        state.lastDismountAt = getServerTime();
        state.dismountedCarId = getId(car, 'carId', 'id');
        state.dismountCount = (state.dismountCount || 0) + 1;
        addTask('ok', `手动下船成功，已脱离船只 #${state.dismountedCarId}`);
        updateSnapshot();
      } else {
        addTask('error', '下船失败，可能无可用落脚点');
      }
      return success;
    },
    attackNearest() {
      const lp = getLP();
      const bf = getBattlefield(lp);
      const self = getSelf(bf);
      const car = state.currentCar || pickBestCar(bf, self, lp);
      const enemy = pickBestEnemy(bf, self, car);
      const enemyId = getId(enemy, 'roleId', 'id');
      if (!lp?.sendBattle || !enemyId) return addTask('error', 'no enemy in attack range');
      state.battleCount++;
      return safeCall(`攻击 ${enemyId}`, () => lp.sendBattle(enemyId));
    },
    pickItem() {
      const lp = getLP();
      if (!lp?.sendPickItem) return addTask('error', '未找到 sendPickItem');
      state.pickCount++;
      return safeCall('拾取道具', () => lp.sendPickItem());
    },
    useCarItem(carId) {
      const lp = getLP();
      const bf = getBattlefield(lp);
      const self = getSelf(bf);
      const car = carId ? getCars(bf).find((x) => String(getId(x, 'carId', 'id')) === String(carId)) : state.currentCar || pickBestCar(bf, self, lp);
      const id = getId(car, 'carId', 'id');
      if (!lp?.sendUse || !id) return addTask('error', '没有可用船只道具目标');
      state.useItemCount++;
      return safeCall(`使用船只道具 ${id}`, () => lp.sendUse(id));
    },
    diagnose() {
      const lp = getLP();
      const detail = getDetailedStatus();
      const cur = getCurrentActiveLineup();

      console.log('=============== [蟠桃园助手 诊断] ===============');
      console.log(`当前布阵: [${cur.heroesText}]`);
      if (detail.currentCarId) {
        console.log(`船只详情: #${detail.currentCarId}, 坐标: ${pointText(detail.currentCarPos)}, 剩余步数: ${detail.carRemainSteps ?? '未检测到'}, 角色在船上: ${detail.isOnCar ? '是' : '否'}`);
      }
      console.table(detail);
      console.log('[蟠桃园助手] LP module:', lp);
      console.log('================================================');

      addTask('info', `诊断完成: 当前布阵 [${cur.heroesText}] | 状态: ${detail.status || '-'}`);
      renderUI();
      return { detail, currentLineup: cur };
    },
    detectLineups() {
      return detectAllLineups();
    },
    getAvailableLineups,
    getStats() {
      return {
        running: state.running,
        battleCount: state.battleCount,
        moveCount: state.moveCount,
        pickCount: state.pickCount,
        useItemCount: state.useItemCount,
        dismountCount: state.dismountCount || 0,
        dismountedCarId: state.dismountedCarId || 0,
        deployCount: state.deployCount,
        deployPending: state.deployPending,
        deployReady: state.deployReady,
        deployBattlefieldId: state.deployBattlefieldId,
        lastSeenBattlefieldId: state.lastSeenBattlefieldId,
        deathCount: state.deathCount,
        wasDead: state.wasDead,
        lastReviveSeconds: state.lastReviveSeconds,
        lastDeathAt: state.lastDeathAt,
        deployAfterRevivePending: state.deployAfterRevivePending,
        lastForcedDeployAt: state.lastForcedDeployAt,
        errorCount: state.errorCount,
        lastError: state.lastError,
        enterRetryCount: state.enterRetryCount,
        enterPending: state.enterPending,
        currentCarId: getId(state.currentCar, 'carId', 'id'),
        strategy: { ...CFG.strategy },
      };
    },
    getDetailedStatus,
    getStatus() {
      return { ...state };
    },
    getConfig() {
      return { ...CFG, strategy: { ...CFG.strategy } };
    },
    resetStats() {
      state.battleCount = 0;
      state.moveCount = 0;
      state.pickCount = 0;
      state.useItemCount = 0;
      state.dismountCount = 0;
      state.lastDismountAt = 0;
      state.dismountedCarId = 0;
      state.deathCount = 0;
      state.wasDead = false;
      state.lastReviveSeconds = 0;
      state.lastDeathAt = 0;
      state.reviveDeadlineAt = 0;
      state.reviveReadyAt = 0;
      state.deployAfterRevivePending = false;
      state.lastSeenBattlefieldId = '';
      state.lastForcedDeployAt = 0;
      state.errorCount = 0;
      state.lastError = '';
      state.enterRetryCount = 0;
      state.enterPending = false;
      addTask('info', 'stats reset');
      renderUI();
    },
  };

  function tryMountUI() {
    if (ui.root) return true;
    if (!document.body) return false;
    initUI();
    return true;
  }

  if (!tryMountUI()) {
    const mountTimer = setInterval(() => {
      if (tryMountUI()) clearInterval(mountTimer);
    }, 500);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryMountUI, { once: true });
    }
  }

  addTask('info', '助手已加载，接口：window.__LP_SMART__');
  log('已加载，接口：window.__LP_SMART__');
})();
