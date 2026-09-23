// ==UserScript==
// @name         伟大航路盐场自动化
// @namespace    local.test.legion-war-salt
// @version      3.0.0
// @description  基于 game.js 的伟大航路/灰岩岛盐场源码实现：进战场、布阵、复活、寻盐田、行军、攻击建筑和敌人。
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    tickMs: 1000,
    enterCooldownMs: 10000,
    refreshInfoCooldownMs: 8000,
    deployCooldownMs: 30000,
    resurrectCooldownMs: 5000,
    attackCooldownMs: 2500,
    marchCooldownMs: 3500,
    logEveryMs: 5000,
    speedUpCooldownMs: 2500,
    inviteCooldownMs: 6500,
    maxTeamSize: 5,

    autoEnter: true,
    autoDeploy: true,
    autoResurrect: false,
    useResurrectItem: false,
    autoAttackLockedEnemy: true,
    autoAttackBuilding: true,
    autoAttackEnemy: true,
    autoMarchSaltPan: true,
    autoSpeedUp: true,
    autoEnableGameAutoAttack: true,
    autoLockedInvite: true,
    autoFollowMember: true,
    waitLockedMembersBeforeAction: true,
    waitFollowTargetAction: true,

    // saltPanFirst：优先盐田；nearest：按距离；enemyFirst：优先敌方建筑。
    targetPriority: 'saltPanFirst',
    maxPathLen: 999,
    debug: true,
    verbose: false,
    showUI: true,
    uiRefreshMs: 1000,
    sandbox: false,
    nativeSandboxMap: false,
  };

  const state = {
    running: false,
    entering: false,
    lastBattlefieldId: '',
    lastEnter: 0,
    lastRefreshInfo: 0,
    lastDeploy: 0,
    lastResurrect: 0,
    lastAttack: 0,
    lastMarch: 0,
    lastSpeedUp: 0,
    lastInvite: 0,
    lastLog: 0,
    wasDead: false,
    deployedInBattlefield: new Set(),
    currentTarget: null,
    workflowStatus: '未启动',
    savedAt: 0,
    panelPos: null,
    draggingPanel: false,
    selectedBuildingId: null,
    followMemberId: null,
    selectedEnemyId: null,
    lockedEnemyId: null,
    uiCollapsed: false,
    lockedInviteIds: new Set(),
    rejectedInviteIds: new Set(),
    enemyFilters: new Set(),
    enemySortMode: 'power',
    nativeTroopsSortMode: 'power',
    enemyTargets: [],
    enemyFormationCache: new Map(),
    enemyFormationDebugLogged: new Set(),
    enemyRefreshing: false,
    lastEnemyRefresh: 0,
    nativeFormationPatched: false,
    nativeFormationPending: new Set(),
    nativeFormationLabels: new Map(),
    sandboxData: null,
    sandboxMapVisible: false,
    nativeSandboxMapActive: false,
    inviteHistory: new Map(),
    stats: {
      enter: 0,
      refreshInfo: 0,
      refreshMembers: 0,
      deploy: 0,
      resurrect: 0,
      waitRevive: 0,
      attackBuilding: 0,
      attackEnemy: 0,
      refreshEnemy: 0,
      attackLockedEnemy: 0,
      march: 0,
      speedUp: 0,
      speedUpDiamond: 0,
      invite: 0,
      kick: 0,
      leaveTeam: 0,
      changePos: 0,
      followMarch: 0,
      autoAttackSwitch: 0,
      rejectedInvite: 0,
      errors: 0,
    },
    lastError: '',
  };

  function req(name) {
    try {
      return window.__require ? window.__require(name) : null;
    } catch (e) {
      return null;
    }
  }

  function getGeneratedRespClass(name) {
    const mods = [
      req('data-index'),
      req('../../../../../extras/orange/generated/data-index'),
      req('../../../../extras/orange/generated/data-index'),
      req('../../../extras/orange/generated/data-index'),
      req('extras/orange/generated/data-index'),
    ].filter(Boolean);
    for (const mod of mods) {
      if (mod?.[name]) return mod[name];
    }
    return null;
  }

  function now() {
    const DateUtil = req('DateUtil');
    const t = DateUtil && (DateUtil.default?.serverTime ?? DateUtil.serverTime);
    return typeof t === 'number' ? t : Date.now();
  }

  function log(...args) {
    if (CFG.debug) console.log('[盐场自动]', ...args);
  }

  function logVerbose(...args) {
    if (CFG.debug && CFG.verbose) console.log('[盐场自动]', ...args);
  }

  function logError(...args) {
    state.stats.errors += 1;
    state.lastError = args.map((v) => (v && v.message) || String(v)).join(' ');
    console.error('[盐场自动 错误]', ...args);
  }

  function getModuleManager() {
    return req('ModuleManager');
  }

  function getConfigs() {
    return req('Configs') || {};
  }

  function getTypes() {
    return req('types-legion-war') || {};
  }

  function getTiledTypes() {
    return req('types-tiled') || {};
  }

  function getRoleData() {
    return req('ServerData')?.ROLE || window.ROLE || null;
  }

  function getRealLegionWarModule() {
    const ModuleManager = getModuleManager();
    const Configs = getConfigs();
    if (!ModuleManager || !Configs?.ModuleType) return null;
    return ModuleManager.GET_MODULE(Configs.ModuleType.LEGION_WAR);
  }

  function getRealLegionPayloadModule() {
    const ModuleManager = getModuleManager();
    const Configs = getConfigs();
    if (!ModuleManager || !Configs?.ModuleType) return null;
    return ModuleManager.GET_MODULE(Configs.ModuleType.LEGION_PAYLOAD);
  }

  function getLegionWarModule() {
    if (CFG.sandbox) return getSandboxLegionWarModule();
    return getRealLegionWarModule();
  }

  function getLegionModule() {
    const ModuleManager = getModuleManager();
    const Configs = getConfigs();
    if (!ModuleManager || !Configs?.ModuleType) return null;
    return ModuleManager.GET_MODULE(Configs.ModuleType.LEGION);
  }

  function getBattlefield(lw) {
    return lw?.battlefield || lw?._battlefield || null;
  }

  function getSelf(bf) {
    return bf?.self || null;
  }

  function posKey(pos) {
    return pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y)) ? `${Number(pos.x)}_${Number(pos.y)}` : '';
  }

  function clonePoint(pos) {
    return pos ? { x: Number(pos.x), y: Number(pos.y) } : null;
  }

  function distance(a, b) {
    if (!a || !b) return Infinity;
    return Math.abs(Number(a.x) - Number(b.x)) + Math.abs(Number(a.y) - Number(b.y));
  }

  function mapForEach(mapLike, fn) {
    if (!mapLike) return;
    if (typeof mapLike.forEach === 'function') {
      mapLike.forEach(fn);
      return;
    }
    Object.keys(mapLike).forEach((key) => fn(mapLike[key], key));
  }

  function createNoopSignal() {
    const listeners = [];
    return {
      add(fn, ctx) {
        if (typeof fn !== 'function') return;
        if (!listeners.some((item) => item.fn === fn && item.ctx === ctx)) listeners.push({ fn, ctx });
      },
      remove(fn, ctx) {
        for (let i = listeners.length - 1; i >= 0; i -= 1) {
          if (listeners[i].fn === fn && (ctx === undefined || listeners[i].ctx === ctx)) listeners.splice(i, 1);
        }
      },
      dispatch(...args) {
        listeners.slice().forEach((item) => {
          try {
            item.fn.apply(item.ctx, args);
          } catch (e) {
            logVerbose('sandbox signal listener failed', e?.message || e);
          }
        });
      },
      emit(...args) {
        this.dispatch(...args);
      },
      off(fn, ctx) {
        this.remove(fn, ctx);
      },
      on(fn, ctx) {
        this.add(fn, ctx);
      },
      clear() {
        listeners.length = 0;
      },
    };
  }

  function describeError(e) {
    if (!e) return e;
    const info = {
      name: e.name,
      message: e.message,
      stack: e.stack,
    };
    try {
      Object.getOwnPropertyNames(e).forEach((key) => {
        if (!(key in info)) info[key] = e[key];
      });
    } catch (err) {}
    return info;
  }

  function createSandboxRole(id, name, legionId, position, power, energy, heroes, extra) {
    return {
      id: String(id),
      roleId: String(id),
      codeIdV2: String(id),
      cId: String(id),
      name,
      legionId,
      state: 'idle',
      svrState: 'idle',
      position: clonePoint(position),
      svrPosition: clonePoint(position),
      power: Number(power || 0),
      strength: Number(energy || 0),
      strengthValue: Number(energy || 0),
      energy: Number(energy || 0),
      heroes: heroes || [],
      hasTeam: false,
      isLeader: false,
      isOnline: true,
      inviteTime: 0,
      cameraMoveTo() {
        try {
          req('LegionWarSignal')?.LegionWarSignal?.MoveToPlayer?.dispatch?.(this.position?.x || 0, this.position?.y || 0, true);
        } catch (e) {
          logVerbose('sandbox cameraMoveTo failed', e?.message || e);
        }
      },
      canSpeedUp() {
        return true;
      },
      canUseResurrectItem() {
        return !!CFG.useResurrectItem;
      },
      ...(extra || {}),
    };
  }

  function createSandboxBuilding(id, name, position, opt) {
    const tiledTypes = getTiledTypes();
    const saltType = tiledTypes?.BuildingType?.SaltPan ?? 'SaltPan';
    const homeType = tiledTypes?.BuildingType?.Home ?? 'Home';
    const building = {
      id: String(id),
      name,
      position: clonePoint(position),
      type: opt?.type || saltType,
      isOur: !!opt?.isOur,
      isHome: !!opt?.isHome,
      legionId: opt?.legionId || 0,
      belongsLegion: opt?.legionId ? { id: opt.legionId, name: opt.legionId === 1 ? '我方沙盒俱乐部' : '敌方沙盒俱乐部', homeId: opt.legionId === 1 ? '10_2' : '10_12' } : null,
      currentHp: opt?.currentHp || 100,
      maxHp: opt?.maxHp || 100,
      surplusHp: opt?.surplusHp || opt?.currentHp || 100,
      inBuilding: false,
      inMarchList: false,
      canAttackBuilding: !!opt?.canAttackBuilding,
      canExtraAttackBuilding: !!opt?.canAttackBuilding,
      allMembers: [],
      attackerList: [],
      defenderList: [],
      battleList: [],
      blessingRewards: [],
      firstTakeRewards: [],
      _sandboxMembers: [],
      navPath() {
        const self = state.sandboxData?.bf?.self;
        const len = self ? distance(self.position, building.position) : 1;
        return Array.from({ length: Math.max(1, Math.min(18, len || 1)) }, (_, i) => i);
      },
      canMoveHero() {
        const self = state.sandboxData?.bf?.self;
        if (!self || isMarching(self)) return false;
        return posKey(self.position) !== posKey(building.position);
      },
      isValid: true,
      blessPoint: 0,
      updateSignal: createNoopSignal(),
      legionChangeSignal: createNoopSignal(),
      hasBlessingRewards() {
        return false;
      },
      hasFirstTakeRewards() {
        return false;
      },
      getStaticTexture() {
        return '';
      },
      cameraMoveTo() {
        try {
          req('LegionWarSignal')?.LegionWarSignal?.MoveToPlayer?.dispatch?.(building.position?.x || 0, building.position?.y || 0, true);
        } catch (e) {
          logVerbose('sandbox building cameraMoveTo failed', e?.message || e);
        }
      },
    };
    if (building.isHome) building.type = opt?.type || homeType;
    return building;
  }

  function sandboxHero(heroId, level, star) {
    return { heroId: Number(heroId), name: HERO_NAMES?.[Number(heroId)] || String(heroId), level: level || 2800, star: star || 5 };
  }

  function resetSandboxData() {
    restoreRealLegionWarFromSandbox();
    restoreRealLegionPayloadFromSandbox();
    state.sandboxData = null;
    state.sandboxMapVisible = false;
    state.nativeSandboxMapActive = false;
    state.enemyTargets = [];
    state.enemyFormationCache.clear();
    state.selectedBuildingId = null;
    state.selectedEnemyId = null;
    state.lockedEnemyId = null;
    state.lastBattlefieldId = '';
    removeSandboxMap();
    log('沙盒盐场已重置');
  }

  function ensureSandboxData() {
    if (state.sandboxData) {
      updateSandboxDerived(state.sandboxData);
      return state.sandboxData;
    }

    const self = createSandboxRole('900001', '沙盒自己', 1, { x: 10, y: 2 }, 88888888, 100, [
      sandboxHero(107), sandboxHero(114), sandboxHero(110), sandboxHero(218), sandboxHero(222),
    ], { isMe: true, isLeader: true, hasTeam: true });

    const friends = [
      createSandboxRole('900101', '沙盒队友A', 1, { x: 10, y: 7 }, 76000000, 92, [sandboxHero(107), sandboxHero(114)], {}),
      createSandboxRole('900102', '沙盒队友B', 1, { x: 4, y: 9 }, 68000000, 88, [sandboxHero(101), sandboxHero(102)], {}),
      createSandboxRole('900103', '沙盒队友C', 1, { x: 16, y: 9 }, 59000000, 81, [sandboxHero(105), sandboxHero(106)], {}),
    ];

    const enemies = [
      createSandboxRole('910001', '模拟玩家39', 2, { x: 10, y: 7 }, 11250000, 80, [sandboxHero(107), sandboxHero(114), sandboxHero(110), sandboxHero(218), sandboxHero(222)]),
      createSandboxRole('910002', '毒爆测试号', 2, { x: 4, y: 9 }, 15600000, 96, [sandboxHero(114), sandboxHero(110), sandboxHero(218), sandboxHero(222), sandboxHero(103)]),
      createSandboxRole('910003', '吴国队测试', 2, { x: 16, y: 9 }, 9800000, 45, [sandboxHero(105), sandboxHero(106), sandboxHero(111), sandboxHero(115), sandboxHero(121)]),
      createSandboxRole('910004', '残阵测试', 2, { x: 10, y: 12 }, 6800000, 60, [sandboxHero(107), sandboxHero(101)]),
      createSandboxRole('910005', '三蜀测试', 2, { x: 10, y: 7 }, 13200000, 72, [sandboxHero(103), sandboxHero(104), sandboxHero(114), sandboxHero(118), sandboxHero(204)]),
    ];

    const buildings = [
      createSandboxBuilding('10_2', '我方营地', { x: 10, y: 2 }, { isOur: true, isHome: true, legionId: 1, type: 'Home' }),
      createSandboxBuilding('10_7', '中路盐田', { x: 10, y: 7 }, { legionId: 2, canAttackBuilding: true, currentHp: 85 }),
      createSandboxBuilding('4_9', '左侧盐田', { x: 4, y: 9 }, { legionId: 2, canAttackBuilding: true, currentHp: 66 }),
      createSandboxBuilding('16_9', '右侧盐田', { x: 16, y: 9 }, { legionId: 2, canAttackBuilding: true, currentHp: 42 }),
      createSandboxBuilding('10_12', '敌方哨塔', { x: 10, y: 12 }, { type: 'Tower', legionId: 2, canAttackBuilding: true, currentHp: 58 }),
    ];

    const bf = {
      id: 'sandbox-legion-war',
      self,
      state: 'started',
      openTime: Date.now() - 60000,
      endTime: Date.now() + 30 * 60 * 1000,
      maxAnonymousEntranceTime: Date.now() + 30 * 60 * 1000,
      inProtectionTime: false,
      leftBlessTime: 0,
      leftBlessTimeTxt: '',
      playerRankList: [],
      incomingMarches: [],
      constantConf: { shareBallId: 1, shareBallIdMax: 3 },
      buildings: new Map(),
      buildIntents: new Map(),
      legions: new Map(),
      buildingsConf: [],
      players: new Map(),
      marches: new Map(),
      teams: new Map(),
      teamIds: new Map(),
      getConstValue() {
        return 0;
      },
      isTeamMember() {
        return this.teamIds.has(String(this.self?.id || ''));
      },
      judgeBuildingInProtectionTime() {
        return false;
      },
      judgeBuildingIsEnd() {
        return false;
      },
      getBuildingEndTime() {
        return this.endTime;
      },
      initialize() {},
      initBuildingData() {},
      initViewData() {},
    };

    buildings.forEach((building) => {
      bf.buildings.set(posKey(building.position), building);
      bf.buildingsConf.push({ buildingId: building.type, closeTime: 0, name: building.name });
    });
    [self, ...friends, ...enemies].forEach((role) => bf.players.set(String(role.id), role));
    self.legion = { selfLegionIdleMembers: friends };
    bf.legions.set(1, { id: 1, name: 'sandbox-self-legion', color: 1, sharedReviveItem: 3, curRange: [], isOut: false });
    bf.legions.set(2, { id: 2, name: 'sandbox-enemy-legion', color: 2, sharedReviveItem: 0, curRange: [], isOut: false });
    const team = { id: 1, players: [self] };
    team.leaderId = String(self.id);
    self.team = team;
    self.isSignIn = true;
    self.reviveTimes = 0;
    self.teamingTime = 0;
    self.teamLimitTime = 0;
    self.svrTeamingTime = 0;
    bf.teams.set(1, team);
    bf.teamIds.set(String(self.id), 1);

    const lw = {
      battlefield: bf,
      _battlefield: bf,
      roleMap: new Map(),
      shareResurrectBallNum: 3,
      deployData: {
        isTeamEmpty: false,
        initData() {},
        async sendSetBattleTeam() {
          log('沙盒：发送布阵一次');
          return { body: {} };
        },
      },
      async enterAnonymousWar() {
        log('沙盒：进入伟大航路战场');
        return { body: {} };
      },
      async goto() {
        log('沙盒：进入盐场模块');
        return { body: {} };
      },
      async sendGetBattlefield() {
        updateSandboxDerived(state.sandboxData);
        return { body: { battlefield: bf } };
      },
      async sendGetBattlefieldInfo() {
        updateSandboxDerived(state.sandboxData);
        return { body: { battlefield: bf } };
      },
      async sendStartMarch(position) {
        const target = Array.from(bf.buildings.values()).find((building) => posKey(building.position) === posKey(position));
        if (!target) throw new Error('沙盒：目标建筑不存在');
        const marchId = `sandbox-march-${Date.now()}`;
        self.state = self.svrState = 'march';
        self.marchId = marchId;
        self.endMarchTime = Date.now() + 2500;
        self._sandboxTargetBuildingId = target.id;
        bf.marches.set(marchId, { id: marchId, toBuildingId: target.id, toPosition: clonePoint(target.position) });
        updateSandboxDerived(state.sandboxData);
        setTimeout(() => completeSandboxMarch(marchId), 2300);
        log('沙盒：开始行军', target.name, posKey(target.position));
        return { body: {} };
      },
      async sendSpeedUp(marchId) {
        completeSandboxMarch(marchId || self.marchId);
        log('沙盒：行军加速完成');
        return { body: {} };
      },
      async sendStartAttackBuilding(buildingId) {
        const building = Array.from(bf.buildings.values()).find((item) => String(item.id) === String(buildingId));
        if (building) {
          building.currentHp = Math.max(0, Number(building.currentHp || 0) - 10);
          building.surplusHp = building.currentHp;
        }
        log('沙盒：攻击建筑', building?.name || buildingId, `剩余血量${building?.currentHp ?? '-'}`);
        return { body: {} };
      },
      async sendStartBattle(enemyId) {
        const enemy = bf.players.get(String(enemyId));
        if (enemy) {
          enemy.energy = Math.max(0, Number(enemy.energy || 0) - 5);
          enemy.strengthValue = enemy.energy;
          enemy.state = enemy.svrState = 'combat';
          setTimeout(() => {
            enemy.state = enemy.svrState = 'idle';
            updateSandboxDerived(state.sandboxData);
          }, 1200);
        }
        log('沙盒：开战敌人', enemy?.name || enemyId, enemy?.formationLabels || classifyEnemyFormation(enemy?.heroes || []));
        return { body: { result: true } };
      },
      async sendInviteJoinTeam(playerId) {
        const id = String(playerId);
        const player = bf.players.get(id) || friends.find((item) => isSameMemberId(item, id));
        if (!player) throw new Error('沙盒：成员不存在');
        player.inviteTime = 1;
        setTimeout(() => {
          const currentTeam = bf.teams.get(1);
          if (currentTeam && !currentTeam.players.some((p) => isSameMemberId(p, id)) && currentTeam.players.length < CFG.maxTeamSize) {
            player.inviteTime = 0;
            player.hasTeam = true;
            player.isLeader = false;
            player.team = currentTeam;
            currentTeam.players.push(player);
            bf.teamIds.set(String(player.id), 1);
            updateSandboxDerived(state.sandboxData);
            log('沙盒：成员自动入队', player.name || id);
          }
        }, 1800);
        log('沙盒：邀请成员', player.name || id);
        return { body: {} };
      },
      async sendKickOutTeam(playerId) {
        const id = String(playerId);
        const team = bf.teams.get(1);
        if (team) team.players = team.players.filter((p) => !isSameMemberId(p, id));
        const player = bf.players.get(id);
        if (player) player.hasTeam = false;
        bf.teamIds.delete(id);
        updateSandboxDerived(state.sandboxData);
        return { body: {} };
      },
      async sendLeave() {
        self.hasTeam = false;
        self.isLeader = false;
        bf.teamIds.delete(String(self.id));
        updateSandboxDerived(state.sandboxData);
        log('沙盒：离队');
        return { body: {} };
      },
      async sendChangePos(ids) {
        const team = bf.teams.get(1);
        if (team) {
          const current = new Map(team.players.map((p) => [String(getPlayerId(p)), p]));
          team.players = ids.map((id) => current.get(String(id))).filter(Boolean);
        }
        updateSandboxDerived(state.sandboxData);
        log('沙盒：调整队伍站位', ids);
        return { body: {} };
      },
      async sendGetTeamInfo(roleCodeId) {
        const role = bf.players.get(String(roleCodeId));
        const teamInfo = {};
        (role?.heroes || []).forEach((hero, idx) => {
          teamInfo[idx] = { ...hero, pos: idx };
        });
        return { body: { teamInfo } };
      },
      async sendGetTeamImgInfo() {
        return { body: { teamImgInfo: {} } };
      },
      getTeamLivingPlayerCount() {
        return Math.max(1, bf.teams.get(1)?.players?.length || 1);
      },
    };

    [...friends, ...enemies].forEach((role) => lw.roleMap.set(String(role.id), { cId: String(role.id), rId: String(role.roleId), name: role.name, power: role.power }));

    state.sandboxData = { lw, bf, self, friends, enemies, buildings, marchSeq: 0 };
    updateSandboxDerived(state.sandboxData);
    log('沙盒盐场已创建：可在非盐场时间测试 UI、选敌、排序、组队、行军和开战');
    return state.sandboxData;
  }

  function completeSandboxMarch(marchId) {
    const data = state.sandboxData;
    if (!data) return;
    const { bf, self } = data;
    if (!marchId || String(self.marchId || '') !== String(marchId)) return;
    const march = bf.marches.get(marchId);
    const target = march ? Array.from(bf.buildings.values()).find((building) => String(building.id) === String(march.toBuildingId)) : null;
    if (target) {
      self.position = clonePoint(target.position);
      self.svrPosition = clonePoint(target.position);
    }
    self.state = self.svrState = 'idle';
    self.marchId = 0;
    self.endMarchTime = 0;
    self._sandboxTargetBuildingId = '';
    bf.marches.delete(marchId);
    updateSandboxDerived(data);
    if (target) log('沙盒：到达建筑', target.name, posKey(target.position));
  }

  function updateSandboxDerived(data) {
    if (!data?.bf) return;
    const { bf, self, friends, enemies, buildings } = data;
    self.curBuilding = null;
    buildings.forEach((building) => {
      building.inBuilding = false;
      building.inMarchList = false;
      building.allMembers = [];
      building.attackerList = [];
      building.defenderList = [];
      building.battleList = [];
      building._sandboxMembers = [];
    });
    const place = (role) => {
      const building = buildings.find((item) => posKey(item.position) === posKey(role.position));
      if (building) {
        building.allMembers.push(role);
        building._sandboxMembers.push(role);
        if (Number(role.legionId) === Number(self.legionId)) building.defenderList.push(role);
        else building.attackerList.push(role);
        if (role.isMe) {
          building.inBuilding = true;
          self.curBuilding = building;
        }
      }
    };
    [self, ...(friends || []), ...(enemies || [])].forEach(place);
    if (self._sandboxTargetBuildingId) {
      const target = buildings.find((building) => String(building.id) === String(self._sandboxTargetBuildingId));
      if (target) target.inMarchList = true;
    }
    (enemies || []).forEach((enemy) => {
      enemy.formationLabels = classifyEnemyFormation(enemy.heroes || []);
    });
  }

  function getSandboxLegionWarModule() {
    return ensureSandboxData().lw;
  }

  function getGreyIslandWarMapInfo() {
    const TypesCommon = req('types-common') || {};
    const tiledTypes = getTiledTypes();
    const tmBundle = TypesCommon.BundleName?.TM || 'ui_tiledMap';
    const mapId = tiledTypes.MapIDType?.Intro_02 ?? tiledTypes.MapIDType?.GreyWeek ?? 2;
    const originMapId = tiledTypes.MapIDType?.GreyWeek ?? mapId;
    const mapName = tiledTypes.MapNameMap?.get?.(mapId) || tiledTypes.MapNameType?.IntroMap_02 || tiledTypes.MapNameType?.Default || 'IntroMap_02';
    const mapNameExt = tiledTypes.MapNameExtMap?.get?.(originMapId) || tiledTypes.MapNameExtMap?.get?.(mapId) || tiledTypes.MapNameExtType?.Map01 || tiledTypes.MapNameExtType?.LegionWarMap || 'map01';
    return {
      mapId,
      originMapId,
      mapName,
      mapNameExt,
      resBundleName: `${tmBundle}_${mapId}`,
      resMediumBundleName: `${tmBundle}_${mapId}_medium`,
    };
  }

  function patchRealLegionWarForSandbox(realLw, sandboxLw, bf) {
    if (!realLw || !sandboxLw || !bf) return false;
    if (!realLw.__saltSandboxBackup) {
      realLw.__saltSandboxBackup = { ownProps: {} };
      ['battlefield', '_battlefield', '_battlefieldId', '_battlefieldType', '_mapType', 'mapCenter', 'groupCenters', 'sourceMap', '_tiledMap', 'mapId', 'originMapId', 'mapName', 'mapNameExt', 'resBundleName', 'resMediumBundleName', 'mapSceneType', 'warType', 'isGoldenLeaguePvE', 'isGoldenLeaguePvP', 'sendStartMarch', 'sendSpeedUp', 'sendStartBattle', 'sendStartAttackBuilding', 'sendInviteJoinTeam', 'sendKickOutTeam', 'sendLeave', 'sendChangePos', 'sendGetBattlefield', 'sendGetBattlefieldInfo', 'sendGetTeamInfo', 'sendGetTeamImgInfo'].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(realLw, key)) realLw.__saltSandboxBackup.ownProps[key] = Object.getOwnPropertyDescriptor(realLw, key);
      });
    }
    const mapInfo = getGreyIslandWarMapInfo();
    const MapScene = req('MapScene')?.MapScene;
    const define = (key, descriptor) => {
      try {
        Object.defineProperty(realLw, key, { configurable: true, ...descriptor });
      } catch (e) {
        logVerbose('沙盒覆盖灰岩岛战场属性失败', key, e?.message || e);
      }
    };
    const defineValue = (key, value) => define(key, { writable: true, value });
    defineValue('_battlefield', bf);
    defineValue('battlefield', bf);
    defineValue('_battlefieldId', bf.id);
    defineValue('_battlefieldType', 'greyWeek');
    defineValue('_mapType', 'GREY_WEEK_MAP');
    defineValue('mapCenter', '10_7');
    defineValue('groupCenters', new Map([
      ['10_7', '10_7'],
      ['4_9', '10_7'],
      ['16_9', '10_7'],
      ['10_12', '10_12'],
    ]));
    define('originMapId', { get: () => mapInfo.originMapId });
    define('mapId', { get: () => mapInfo.mapId });
    define('mapName', { get: () => mapInfo.mapName });
    define('mapNameExt', { get: () => mapInfo.mapNameExt });
    define('resBundleName', { get: () => mapInfo.resBundleName });
    define('resMediumBundleName', { get: () => mapInfo.resMediumBundleName });
    if (MapScene) define('mapSceneType', { get: () => MapScene });
    define('warType', { get: () => 'sandboxGreyIsland' });
    define('isGoldenLeaguePvE', { get: () => false });
    define('isGoldenLeaguePvP', { get: () => false });
    defineValue('sendStartMarch', (...args) => sandboxLw.sendStartMarch(...args));
    defineValue('sendSpeedUp', (...args) => sandboxLw.sendSpeedUp(...args));
    defineValue('sendStartBattle', (...args) => sandboxLw.sendStartBattle(...args));
    defineValue('sendStartAttackBuilding', (...args) => sandboxLw.sendStartAttackBuilding(...args));
    defineValue('sendInviteJoinTeam', (...args) => sandboxLw.sendInviteJoinTeam(...args));
    defineValue('sendKickOutTeam', (...args) => sandboxLw.sendKickOutTeam(...args));
    defineValue('sendLeave', (...args) => sandboxLw.sendLeave(...args));
    defineValue('sendChangePos', (...args) => sandboxLw.sendChangePos(...args));
    defineValue('sendGetBattlefield', (...args) => sandboxLw.sendGetBattlefield(...args));
    defineValue('sendGetBattlefieldInfo', (...args) => sandboxLw.sendGetBattlefieldInfo(...args));
    defineValue('sendGetTeamInfo', (...args) => sandboxLw.sendGetTeamInfo(...args));
    defineValue('sendGetTeamImgInfo', (...args) => sandboxLw.sendGetTeamImgInfo(...args));
    return true;
  }

  function restoreRealLegionWarFromSandbox() {
    const realLw = getRealLegionWarModule();
    const backup = realLw?.__saltSandboxBackup;
    if (!realLw || !backup) return;
    ['battlefield', '_battlefield', '_battlefieldId', '_battlefieldType', '_mapType', 'mapCenter', 'groupCenters', 'sourceMap', '_tiledMap', 'mapId', 'originMapId', 'mapName', 'mapNameExt', 'resBundleName', 'resMediumBundleName', 'mapSceneType', 'warType', 'isGoldenLeaguePvE', 'isGoldenLeaguePvP', 'sendStartMarch', 'sendSpeedUp', 'sendStartBattle', 'sendStartAttackBuilding', 'sendInviteJoinTeam', 'sendKickOutTeam', 'sendLeave', 'sendChangePos', 'sendGetBattlefield', 'sendGetBattlefieldInfo', 'sendGetTeamInfo', 'sendGetTeamImgInfo'].forEach((key) => {
      try {
        if (backup.ownProps[key]) Object.defineProperty(realLw, key, backup.ownProps[key]);
        else delete realLw[key];
      } catch (e) {}
    });
    delete realLw.__saltSandboxBackup;
  }

  function ensurePayloadBattlefieldShape(bf) {
    if (!bf) return bf;
    const toArray = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      if (value instanceof Map) return Array.from(value.values());
      if (typeof value === 'object') return Object.values(value);
      return [];
    };
    const buildings = toArray(bf.buildings);
    const players = toArray(bf.players);
    bf.roles = bf.roles || bf.players || new Map(players.map((role) => [String(getPlayerId(role)), role]));
    bf.roleMap = bf.roleMap || bf.roles;
    bf.cars = bf.cars || new Map();
    bf.carData = bf.carData || { list: [], cars: [], updateSignal: createNoopSignal() };
    bf.tileData = bf.tileData || { list: [], updateSignal: createNoopSignal() };
    bf.buildingData = bf.buildingData || { list: buildings, buildings, updateSignal: createNoopSignal() };
    bf.serverData = bf.serverData || { buildings, roles: players, cars: [], legions: toArray(bf.legions) };
    bf.notifyData = bf.notifyData || {};
    bf.notifyData.battlefield = bf;
    bf.pos2Roles = bf.pos2Roles || new Map();
    bf.activePathArr = bf.activePathArr || [];
    bf.currentMarchPathArr = bf.currentMarchPathArr || [];
    bf.currentMarchPathMap = bf.currentMarchPathMap || new Map();
    bf.previewMarchPathArr = bf.previewMarchPathArr || [];
    bf.previewMarchPathMap = bf.previewMarchPathMap || new Map();
    bf.updateSignal = bf.updateSignal || createNoopSignal();
    bf.refreshSignal = bf.refreshSignal || createNoopSignal();
    bf.carSignal = bf.carSignal || createNoopSignal();
    bf.roleSignal = bf.roleSignal || createNoopSignal();
    bf.buildingSignal = bf.buildingSignal || createNoopSignal();
    mapForEach(bf.legions, (legion) => {
      if (legion && !Array.isArray(legion.curRange)) legion.curRange = [];
      if (legion && typeof legion.isOut !== 'boolean') legion.isOut = false;
    });
    bf.getBuildingList = bf.getBuildingList || (() => buildings);
    bf.getRoleList = bf.getRoleList || (() => players);
    bf.getCarList = bf.getCarList || (() => []);
    bf.getBuildingByPos = bf.getBuildingByPos || ((pos) => buildings.find((building) => posKey(building.position) === posKey(pos)));
    bf.getBuildingById = bf.getBuildingById || ((id) => buildings.find((building) => String(building.id) === String(id)));
    bf.initialize = bf.initialize || (() => {});
    bf.initBuildingData = bf.initBuildingData || (() => {});
    bf.initViewData = bf.initViewData || (() => {});
    return bf;
  }

  function getPayloadWarData(lpModule) {
    return lpModule?.lPWarData || lpModule?.lpWarData || lpModule?.warData || lpModule;
  }

  function getPayloadMapResInfo() {
    const TypesCommon = req('types-common') || {};
    return {
      bundleName: TypesCommon.BundleName?.UI_LP_TMX_MAP || 'ui_lp_tmx_map',
      resBundleName: 'ui_lp_tiled_map',
      resUIBundleName: 'ui_lp_war',
      mapName: 'gvgCarMap',
      carBundleName: 'legion_payload',
    };
  }

  function patchRealLegionPayloadForSandbox(realLp, sandboxLw, bf) {
    const warData = getPayloadWarData(realLp);
    if (!realLp || !warData || !sandboxLw || !bf) return false;
    ensurePayloadBattlefieldShape(bf);
    if (!realLp.__saltPayloadSandboxBackup) {
      realLp.__saltPayloadSandboxBackup = { warData, ownProps: {}, warProps: {} };
      ['sendStartMarch', 'sendSpeedUp', 'sendStartBattle', 'sendStartAttackBuilding', 'sendInviteJoinTeam', 'sendKickOutTeam', 'sendLeave', 'sendChangePos', 'sendGetBattlefield', 'sendGetBattlefieldInfo', 'sendGetTeamInfo', 'sendGetTeamImgInfo'].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(realLp, key)) realLp.__saltPayloadSandboxBackup.ownProps[key] = Object.getOwnPropertyDescriptor(realLp, key);
      });
      ['battlefield', '_battlefield', 'notifyData', 'mapResInfo', '_sourceMap', 'sourceMap', '_tiledMap'].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(warData, key)) realLp.__saltPayloadSandboxBackup.warProps[key] = Object.getOwnPropertyDescriptor(warData, key);
      });
    }
    const mapResInfo = getPayloadMapResInfo();
    const define = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { configurable: true, writable: true, value });
      } catch (e) {
        logVerbose('沙盒覆盖伟大航路属性失败', key, e?.message || e);
      }
    };
    const notifyData = warData.notifyData && typeof warData.notifyData === 'object' ? warData.notifyData : {};
    notifyData.battlefield = bf;
    define(warData, 'notifyData', notifyData);
    define(warData, '_battlefield', bf);
    define(warData, 'battlefield', bf);
    define(warData, 'mapResInfo', mapResInfo);
    define(realLp, 'battlefield', bf);
    define(realLp, 'mapResInfo', mapResInfo);
    ['sendStartMarch', 'sendSpeedUp', 'sendStartBattle', 'sendStartAttackBuilding', 'sendInviteJoinTeam', 'sendKickOutTeam', 'sendLeave', 'sendChangePos', 'sendGetBattlefield', 'sendGetBattlefieldInfo', 'sendGetTeamInfo', 'sendGetTeamImgInfo'].forEach((key) => {
      if (typeof sandboxLw[key] === 'function') {
        define(realLp, key, (...args) => sandboxLw[key](...args));
        define(warData, key, (...args) => sandboxLw[key](...args));
      }
    });
    return true;
  }

  function restoreRealLegionPayloadFromSandbox() {
    const realLp = getRealLegionPayloadModule();
    const backup = realLp?.__saltPayloadSandboxBackup;
    if (!realLp || !backup) return;
    const warData = backup.warData || getPayloadWarData(realLp);
    Object.keys(backup.ownProps || {}).forEach((key) => {
      try {
        Object.defineProperty(realLp, key, backup.ownProps[key]);
      } catch (e) {}
    });
    ['sendStartMarch', 'sendSpeedUp', 'sendStartBattle', 'sendStartAttackBuilding', 'sendInviteJoinTeam', 'sendKickOutTeam', 'sendLeave', 'sendChangePos', 'sendGetBattlefield', 'sendGetBattlefieldInfo', 'sendGetTeamInfo', 'sendGetTeamImgInfo', 'battlefield', 'mapResInfo'].forEach((key) => {
      try {
        if (!backup.ownProps?.[key]) delete realLp[key];
      } catch (e) {}
    });
    if (warData) {
      ['battlefield', '_battlefield', 'notifyData', 'mapResInfo', '_sourceMap', 'sourceMap', '_tiledMap'].forEach((key) => {
        try {
          if (backup.warProps?.[key]) Object.defineProperty(warData, key, backup.warProps[key]);
          else delete warData[key];
        } catch (e) {}
      });
    }
    delete realLp.__saltPayloadSandboxBackup;
  }

  async function loadWarUIBundle(bundleName) {
    if (!bundleName) return;
    const ResourceManager = req('ResourceManager');
    if (typeof ResourceManager?.TRY_LOAD_UI === 'function') await ResourceManager.TRY_LOAD_UI(bundleName, 3);
    else if (typeof ResourceManager?.LOAD_UI === 'function') await ResourceManager.LOAD_UI(bundleName);
    try {
      req('GlobalSignal')?.GlobalSignal?.UIPackageRef?.dispatch?.('add', bundleName);
    } catch (e) {
      logVerbose('sandbox package ref add failed', bundleName, e?.message || e);
    }
  }

  async function enterNativeSandboxMap() {
    if (typeof window === 'undefined' || !window.__require || typeof cc === 'undefined') throw new Error('当前页面还没有游戏运行时，不能调用本地盐场地图');
    restoreRealLegionPayloadFromSandbox();
    const realLw = getRealLegionWarModule();
    const data = ensureSandboxData();
    if (!realLw) throw new Error('未找到真实 LEGION_WAR 灰岩岛战场模块');
    patchRealLegionWarForSandbox(realLw, data.lw, data.bf);
    const TMLoader = req('TMLoader')?.TMLoader;
    const UI = req('index-ui');
    const TypesCommon = req('types-common') || {};
    const LPMapPanel = req('LPMapPanel')?.LPMapPanel;
    const LegionWarScene = req('LegionWarScene')?.LegionWarScene;
    const LegionWarPanel = req('LegionWarPanel')?.LegionWarPanel;
    const UI_LegionWarScene = req('UI_LegionWarScene')?.default || req('UI_LegionWarScene');
    const mapInfo = {
      mapName: realLw.mapName,
      mapNameExt: realLw.mapNameExt,
      resBundleName: realLw.resBundleName,
      resMediumBundleName: realLw.resMediumBundleName,
    };
    if (!TMLoader?.loadMap || !UI?.SHOW_PROXY_OVER) throw new Error('本地地图加载模块未就绪');
    removeSandboxMap();
    const step = async (label, fn) => {
      log('沙盒原生地图步骤:', label);
      try {
        return await fn();
      } catch (e) {
        logError('沙盒原生地图步骤失败:', label, describeError(e));
        throw e;
      }
    };
    await step('加载战场地图基础包', () => loadWarUIBundle(TypesCommon.BundleName?.TM || 'ui_tiledMap'));
    if (LPMapPanel && typeof UI.HIDE_PROXY === 'function') await step('关闭错误的 LP 车图面板', () => UI.HIDE_PROXY(LPMapPanel));
    await step(`加载灰岩岛地图资源 ${mapInfo.resBundleName}`, () => loadWarUIBundle(mapInfo.resBundleName));
    await step(`加载灰岩岛中地图资源 ${mapInfo.resMediumBundleName}`, () => loadWarUIBundle(mapInfo.resMediumBundleName));
    await step(`加载战场 UI ${UI_LegionWarScene?.PackageURI || '-'}`, () => loadWarUIBundle(UI_LegionWarScene?.PackageURI));
    const tiled = await step(`加载灰岩岛地图 ${mapInfo.mapName} / ${mapInfo.mapNameExt}`, () => TMLoader.loadMap(mapInfo.mapName, mapInfo.mapNameExt));
    const sourceMap = await step('创建灰岩岛 SourceMap', async () => (typeof realLw.createSourceMap === 'function' ? realLw.createSourceMap(tiled) : null));
    Object.defineProperty(realLw, 'sourceMap', { configurable: true, writable: true, value: sourceMap });
    Object.defineProperty(realLw, '_tiledMap', { configurable: true, writable: true, value: tiled });
    if (!sourceMap?.initialize) throw new Error('灰岩岛 SourceMap 创建失败');
    await step('初始化灰岩岛 SourceMap', async () => sourceMap.initialize());
    if (realLw.mapSceneType) await step('显示灰岩岛地图场景', () => UI.SHOW_PROXY_OVER(realLw.mapSceneType));
    if (LegionWarPanel && typeof UI.SHOW_PROXY === 'function') await step('显示 LegionWarPanel', () => UI.SHOW_PROXY(LegionWarPanel));
    if (LegionWarScene && typeof UI.SHOW_PROXY === 'function') await step('显示 LegionWarScene', () => UI.SHOW_PROXY(LegionWarScene));
    state.sandboxMapVisible = true;
    state.nativeSandboxMapActive = true;
    state.workflowStatus = '伟大航路灰岩岛沙盒';
    log(`已进入游戏本地伟大航路灰岩岛地图沙盒：${mapInfo.mapName} / ${mapInfo.mapNameExt}`);
    return true;
  }

  function enterLocalSandboxMap() {
    CFG.sandbox = true;
    state.sandboxMapVisible = true;
    state.nativeSandboxMapActive = false;
    ensureSandboxData();
    renderSandboxMap();
    renderUI();
    log('已进入本地沙盒地图：不加载原生地图，避免页面卡死');
  }

  function sandboxMapScale(pos) {
    const x = Math.max(1, Math.min(14, Number(pos?.x || 1)));
    const y = Math.max(1, Math.min(10, Number(pos?.y || 1)));
    return {
      left: `${6 + ((x - 1) / 13) * 88}%`,
      top: `${10 + ((y - 1) / 9) * 78}%`,
    };
  }

  function ensureSandboxMapStyle() {
    if (typeof document === 'undefined' || document.getElementById('salt-field-sandbox-map-style')) return;
    const style = document.createElement('style');
    style.id = 'salt-field-sandbox-map-style';
    style.textContent = `
#salt-field-sandbox-map{position:fixed;inset:0;z-index:999990;color:#f8fafc;font:12px/1.35 Arial,'Microsoft YaHei',sans-serif;background:radial-gradient(circle at 50% 45%,rgba(250,204,21,.16),transparent 28%),linear-gradient(135deg,#172033,#253246 48%,#111827);overflow:hidden}
#salt-field-sandbox-map:before{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);background-size:58px 58px;opacity:.65}
.sfm-head{position:absolute;left:18px;top:14px;z-index:2;display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(15,23,42,.78);box-shadow:0 8px 22px rgba(0,0,0,.28)}
.sfm-title{font-weight:700;font-size:15px}.sfm-sub{color:#cbd5e1}.sfm-btn{height:26px;border:1px solid rgba(255,255,255,.2);background:#334155;color:#fff;border-radius:5px;padding:0 8px;cursor:pointer}.sfm-btn:hover{background:#475569}
.sfm-map{position:absolute;left:28px;right:28px;top:62px;bottom:28px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:linear-gradient(160deg,rgba(30,41,59,.28),rgba(8,13,24,.52));box-shadow:inset 0 0 80px rgba(0,0,0,.28)}
.sfm-road{position:absolute;left:8%;right:8%;top:50%;height:3px;background:rgba(250,204,21,.28);box-shadow:0 0 16px rgba(250,204,21,.22);transform:rotate(-8deg);transform-origin:center}
.sfm-node{position:absolute;transform:translate(-50%,-50%);min-width:92px;max-width:132px;padding:7px 8px;border-radius:9px;border:1px solid rgba(255,255,255,.24);background:rgba(15,23,42,.82);box-shadow:0 10px 26px rgba(0,0,0,.34);cursor:pointer;transition:.12s transform,.12s border-color,.12s background}
.sfm-node:hover{transform:translate(-50%,-50%) scale(1.04);border-color:#93c5fd;background:rgba(30,41,59,.92)}
.sfm-node.sel{border-color:#60a5fa;box-shadow:0 0 0 2px rgba(96,165,250,.25),0 10px 26px rgba(0,0,0,.34)}
.sfm-node.self{border-color:#22c55e}.sfm-node.home{border-color:#38bdf8}.sfm-node.enemy{border-color:#f97316}
.sfm-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sfm-meta{color:#cbd5e1;font-size:11px;margin-top:2px}.sfm-hp{height:5px;border-radius:999px;background:rgba(255,255,255,.16);overflow:hidden;margin-top:5px}.sfm-hp>i{display:block;height:100%;background:linear-gradient(90deg,#22c55e,#facc15,#ef4444)}
.sfm-role{display:inline-block;margin:4px 4px 0 0;padding:1px 5px;border-radius:999px;background:rgba(255,255,255,.14);color:#e2e8f0;font-size:11px}
.sfm-role.me{background:#2563eb}.sfm-role.friend{background:#16a34a}.sfm-role.enemy{background:#dc2626}
.sfm-legend{position:absolute;right:18px;bottom:14px;z-index:2;padding:7px 9px;border-radius:8px;background:rgba(15,23,42,.76);border:1px solid rgba(255,255,255,.16);color:#cbd5e1}
`;
    document.head.appendChild(style);
  }

  function removeSandboxMap() {
    if (typeof document === 'undefined') return;
    document.getElementById('salt-field-sandbox-map')?.remove();
  }

  function ensureSandboxMap() {
    if (typeof document === 'undefined') return null;
    ensureSandboxMapStyle();
    let root = document.getElementById('salt-field-sandbox-map');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'salt-field-sandbox-map';
    root.innerHTML = '<div class="sfm-head"></div><div class="sfm-map"></div><div class="sfm-legend">沙盒地图：点击建筑选中，面板执行行军、攻击或开战</div>';
    root.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-sfm-act]');
      const node = ev.target.closest('[data-building-id]');
      if (btn?.getAttribute('data-sfm-act') === 'closeMap') {
        state.sandboxMapVisible = false;
        removeSandboxMap();
        renderUI();
        return;
      }
      if (btn?.getAttribute('data-sfm-act') === 'resetMap') {
        resetSandboxData();
        CFG.sandbox = true;
        state.sandboxMapVisible = true;
        ensureSandboxData();
        renderUI();
        return;
      }
      if (node) {
        state.selectedBuildingId = node.getAttribute('data-building-id');
        renderUI();
        renderSandboxMap();
      }
    });
    document.body.appendChild(root);
    return root;
  }

  function renderSandboxMap() {
    if (state.nativeSandboxMapActive) {
      removeSandboxMap();
      return;
    }
    if (!CFG.sandbox || !state.sandboxMapVisible || typeof document === 'undefined') {
      if (!CFG.sandbox || !state.sandboxMapVisible) removeSandboxMap();
      return;
    }
    const data = ensureSandboxData();
    const root = ensureSandboxMap();
    if (!root || !data) return;
    updateSandboxDerived(data);
    const { bf, self, friends, enemies, buildings } = data;
    const head = root.querySelector('.sfm-head');
    const map = root.querySelector('.sfm-map');
    const current = findCurrentBuilding(bf, self);
    head.innerHTML = `
      <span class="sfm-title">沙盒盐场地图</span>
      <span class="sfm-sub">自己 ${posKey(self.position)} | 状态 ${escapeHtml(roleState(self))} | 当前 ${escapeHtml(current?.name || '-')}</span>
      <button class="sfm-btn" data-sfm-act="resetMap">重置地图</button>
      <button class="sfm-btn" data-sfm-act="closeMap">关闭地图</button>
    `;
    const rolePill = (role) => {
      const cls = role.isMe ? 'me' : Number(role.legionId) === Number(self.legionId) ? 'friend' : 'enemy';
      return `<span class="sfm-role ${cls}" title="${escapeHtml(role.name || role.id)}">${role.isMe ? '我' : escapeHtml(role.name || role.id)}</span>`;
    };
    const nodes = buildings.map((building) => {
      const p = sandboxMapScale(building.position);
      const selected = String(building.id) === String(state.selectedBuildingId);
      const isCurrent = current && String(current.id) === String(building.id);
      const members = (building.allMembers || []).map(rolePill).join('');
      const hp = Math.max(0, Math.min(100, Number(building.currentHp || 0)));
      const cls = [
        'sfm-node',
        selected ? 'sel' : '',
        isCurrent ? 'self' : '',
        building.isHome ? 'home' : '',
        !building.isOur && !building.isHome ? 'enemy' : '',
      ].filter(Boolean).join(' ');
      return `
        <div class="${cls}" data-building-id="${escapeHtml(building.id)}" style="left:${p.left};top:${p.top}">
          <div class="sfm-name">${escapeHtml(building.name || building.id)}</div>
          <div class="sfm-meta">坐标 ${posKey(building.position)} | ${building.isHome ? '营地' : isSaltPan(building) ? '盐田' : '建筑'}</div>
          <div class="sfm-hp"><i style="width:${hp}%"></i></div>
          <div>${members || '<span class="sfm-role">空</span>'}</div>
        </div>`;
    }).join('');
    const follow = state.followMemberId ? [...friends, ...enemies].find((p) => isSameMemberId(p, state.followMemberId)) : null;
    map.innerHTML = `<div class="sfm-road"></div>${nodes}<div class="sfm-meta" style="position:absolute;left:12px;bottom:10px">敌人 ${enemies.length} | 队友 ${friends.length} | 跟随 ${escapeHtml(follow?.name || '无')}</div>`;
  }

  function stateValue(name) {
    return getTypes().LWPlayerStateType?.[name];
  }

  function roleState(role) {
    return role?.state ?? role?.svrState ?? role?.serverData?.state ?? role?._serverData?.state;
  }

  function isState(role, name) {
    const value = stateValue(name);
    const s = roleState(role);
    if (value !== undefined && (role?.state === value || role?.svrState === value || role?.serverData?.state === value || role?._serverData?.state === value)) return true;
    return String(s).toLowerCase() === name.toLowerCase();
  }

  function isIdle(role) {
    return !!role && isState(role, 'idle');
  }

  function isMarching(role) {
    return !!role && isState(role, 'march');
  }

  function isFighting(role) {
    return !!role && (isState(role, 'combat') || Number(role?.battleId || 0) > 0);
  }

  function isDead(role) {
    return !!role && (isState(role, 'die') || isState(role, 'resurrect') || role?.isDead === true);
  }

  function canAct(role) {
    return !!role && isIdle(role) && !isDead(role) && !isMarching(role) && !isFighting(role);
  }

  function getSaltPanType() {
    return getTiledTypes().BuildingType?.SaltPan;
  }

  function isSaltPan(building) {
    const saltPan = getSaltPanType();
    if (saltPan !== undefined && building?.type === saltPan) return true;
    const name = String(building?.name || building?._name || '');
    return name.includes('盐') || name.includes('盐田') || name.includes('盐场') || name.includes('SaltPan');
  }

  function getPathLen(building) {
    try {
      const path = building?.navPath?.();
      return Array.isArray(path) ? path.length : 0;
    } catch (e) {
      return 0;
    }
  }

  function canMoveToBuilding(building) {
    try {
      if (!building || typeof building.canMoveHero !== 'function') return false;
      return !!building.canMoveHero();
    } catch (e) {
      return false;
    }
  }

  function canAttackBuilding(building) {
    return !!building && (building.canAttackBuilding === true || building.canExtraAttackBuilding === true);
  }

  function buildingInfo(building, self) {
    return {
      id: building?.id,
      name: building?.name || '',
      type: building?.type,
      isSaltPan: isSaltPan(building),
      isOur: !!building?.isOur,
      isHome: !!building?.isHome,
      legionId: building?.legionId || 0,
      position: clonePoint(building?.position),
      distance: self ? distance(self.position, building?.position) : null,
      pathLen: getPathLen(building),
      currentHp: building?.currentHp,
      maxHp: building?.maxHp,
      surplusHp: building?.surplusHp,
      inBuilding: !!building?.inBuilding,
      inMarchList: !!building?.inMarchList,
      canMove: canMoveToBuilding(building),
      canAttack: canAttackBuilding(building),
    };
  }

  function listBuildings(bf) {
    const out = [];
    mapForEach(bf?.buildings, (building) => {
      if (building?.id) out.push(building);
    });
    return out;
  }


  function getPlayerId(player) {
    return player?.id || player?.roleId || player?.codeIdV2 || player?.serverData?.codeIdV2 || player?._serverData?.codeIdV2 || 0;
  }

  function playerInfo(player) {
    return {
      id: getPlayerId(player),
      name: player?.name || '',
      legionId: player?.legionId || 0,
      isMe: !!player?.isMe,
      isLeader: !!player?.isLeader,
      isOnline: player?.isOnline !== false,
      hasTeam: !!player?.hasTeam,
      state: roleState(player),
      position: clonePoint(player?.position || player?.svrPosition),
      teamLimitTime: player?.teamLimitTime || 0,
      power: player?.power || 0,
      strength: player?.strength || 0,
      isDeadInTeam: !!player?.isDeadInTeam,
      inviteTime: player?.inviteTime || 0,
    };
  }

  function getSelfTeam(bf, self) {
    if (!bf || !self) return null;
    const selfId = getPlayerId(self);
    const teamId = bf.teamIds?.get?.(selfId) || 0;
    return teamId ? bf.teams?.get?.(teamId) || null : null;
  }

  function listTeamPlayers(bf, self) {
    const team = getSelfTeam(bf, self);
    if (team?.players?.length) return team.players;
    return self ? [self] : [];
  }

  function listInviteCandidates(bf, self) {
    const list = self?.legion?.selfLegionIdleMembers || [];
    return Array.isArray(list) ? list : [];
  }

  function addClubMember(out, raw, source) {
    if (!raw) return;
    const roleId = raw.roleId || raw.rId || raw.id1 || raw.serverData?.roleId || raw._serverData?.roleId || 0;
    const codeId = raw.codeIdV2 || raw.cId || raw.id || raw.serverData?.codeIdV2 || raw._serverData?.codeIdV2 || 0;
    const id = String(codeId || roleId || '');
    if (!id || out.has(id)) return;
    out.set(id, {
      id,
      roleId,
      codeId,
      name: raw.name || '',
      power: raw.power || 0,
      strength: raw.strength || 0,
      state: roleState(raw),
      position: clonePoint(raw.position || raw.svrPosition),
      inviteTime: raw.inviteTime || 0,
      isMe: !!raw.isMe,
      isLeader: !!raw.isLeader,
      hasTeam: !!raw.hasTeam,
      inTeam: false,
      source,
      raw,
    });
  }

  function listClubMembers(lw, bf, self) {
    const out = new Map();
    const legion = getLegionModule();
    const roleRefs = Array.from(lw?.roleMap?.values?.() || []);
    mapForEach(lw?.roleMap, (roleRef) => {
      const roleId = roleRef?.rId || roleRef?.roleId || 0;
      const member = legion?.getMemberById?.(roleId) || {};
      addClubMember(out, {
        ...member,
        roleId,
        rId: roleId,
        cId: roleRef?.cId,
        codeIdV2: roleRef?.cId,
        name: member.name || roleRef?.name || '',
        power: member.power || roleRef?.power || 0,
      }, roleRef?.cId ? 'club+war' : 'club');
    });
    const members = legion?.sortMembers || legion?.legion?.sortMembers || legion?.members || legion?.legion?.members || [];
    if (Array.isArray(members)) {
      members.forEach((member) => {
        const roleRef = roleRefs.find((r) => String(r?.rId) === String(member?.roleId));
        addClubMember(out, { ...member, cId: roleRef?.cId, codeIdV2: roleRef?.cId }, roleRef?.cId ? 'club+war' : 'club');
      });
    } else if (typeof members?.forEach === 'function') {
      members.forEach((member) => {
        const roleRef = roleRefs.find((r) => String(r?.rId) === String(member?.roleId));
        addClubMember(out, { ...member, cId: roleRef?.cId, codeIdV2: roleRef?.cId }, roleRef?.cId ? 'club+war' : 'club');
      });
    }
    listInviteCandidates(bf, self).forEach((p) => addClubMember(out, p, 'battlefield'));
    listTeamPlayers(bf, self).forEach((p) => {
      addClubMember(out, p, 'team');
      const id = String(getPlayerId(p));
      if (out.has(id)) out.get(id).inTeam = true;
    });
    const roleData = getRoleData();
    const selfIds = new Set([
      String(getPlayerId(self) || ''),
      String(self?.roleId || self?.rId || self?.serverData?.roleId || self?._serverData?.roleId || ''),
      String(roleData?.roleId || ''),
      String(roleData?.codeIdV2 || roleData?.codeId || ''),
    ].filter(Boolean));
    const selfName = String(self?.name || roleData?.name || '').trim();
    return Array.from(out.values()).filter((p) => {
      if (!p.id || p.isMe) return false;
      if (selfIds.has(String(p.id)) || selfIds.has(String(p.roleId || '')) || selfIds.has(String(p.codeId || ''))) return false;
      if (selfName && String(p.name || '').trim() === selfName) return false;
      return true;
    });
  }

  function findBuildingById(bf, id) {
    if (!bf || id === null || id === undefined || id === '') return null;
    let found = null;
    mapForEach(bf.buildings, (building) => {
      if (!found && String(building?.id) === String(id)) found = building;
    });
    return found;
  }

  function getSelectedBuilding(bf, self) {
    return findBuildingById(bf, state.selectedBuildingId) || findCurrentBuilding(bf, self) || null;
  }
  function findCurrentBuilding(bf, self) {
    if (!bf || !self) return null;
    return self.curBuilding || bf.buildings?.get?.(posKey(self.position)) || null;
  }


  function isSameMemberId(player, id) {
    const target = String(id || '');
    if (!player || !target) return false;
    return String(getPlayerId(player) || '') === target || String(player.roleId || player.rId || player.serverData?.roleId || player._serverData?.roleId || '') === target || String(player.codeId || player.codeIdV2 || player.cId || player.serverData?.codeIdV2 || player._serverData?.codeIdV2 || '') === target;
  }

  function resolveWarCodeId(lw, id) {
    const target = String(id || '');
    if (!target) return '';
    let found = '';
    mapForEach(lw?.roleMap, (roleRef) => {
      if (found) return;
      if (String(roleRef?.cId || '') === target || String(roleRef?.rId || roleRef?.roleId || '') === target) found = String(roleRef?.cId || '');
    });
    return found || target;
  }

  function findPlayerById(bf, playerId) {
    if (!bf || !playerId) return null;
    const id = String(playerId);
    const warCodeId = resolveWarCodeId(getLegionWarModule(), id);
    return bf.players?.get?.(playerId) || bf.players?.get?.(Number(playerId)) || bf.players?.get?.(warCodeId) || bf.players?.get?.(Number(warCodeId)) || listTeamPlayers(bf, bf.self).find((p) => isSameMemberId(p, id) || isSameMemberId(p, warCodeId)) || listInviteCandidates(bf, bf.self).find((p) => isSameMemberId(p, id) || isSameMemberId(p, warCodeId)) || null;
  }

  function setWorkflowStatus(status) {
    if (state.workflowStatus !== status) state.workflowStatus = status;
  }

  function getPlayerTargetBuilding(bf, player) {
    if (!bf || !player) return null;
    const current = findCurrentBuilding(bf, player);
    if (current) return current;
    const marchId = player.marchId || player.serverData?.marchId || player._serverData?.marchId || 0;
    const march = marchId ? bf.marches?.get?.(marchId) : null;
    if (march) {
      const toId = march.toBuildingId || march.targetBuildingId || march.buildingId || march.toId;
      const toPos = march.toPosition || march.target || march.position;
      if (toId) {
        const byId = findBuildingById(bf, toId);
        if (byId) return byId;
      }
      if (toPos) return bf.buildings?.get?.(posKey(toPos)) || null;
    }
    return bf.buildings?.get?.(posKey(player.position || player.svrPosition)) || null;
  }

  function getFollowTarget(bf) {
    return state.followMemberId ? findPlayerById(bf, state.followMemberId) : null;
  }

  function isFollowTargetActionReady(bf, self) {
    const targetPlayer = getFollowTarget(bf);
    if (!targetPlayer || targetPlayer.isMe) return false;
    if (isMarching(targetPlayer) || isFighting(targetPlayer)) return true;
    const building = getPlayerTargetBuilding(bf, targetPlayer);
    if (!building) return false;
    if (building.isHome) return false;
    const current = findCurrentBuilding(bf, self);
    if (current && current.isHome && String(current.id) === String(building.id)) return false;
    return true;
  }

  function isAtFollowTargetBuilding(bf, self) {
    if (!state.followMemberId || !bf || !self) return false;
    const targetPlayer = getFollowTarget(bf);
    if (!targetPlayer || targetPlayer.isMe || isMarching(targetPlayer)) return false;
    const targetBuilding = getPlayerTargetBuilding(bf, targetPlayer);
    const current = findCurrentBuilding(bf, self);
    if (!targetBuilding || !current) return false;
    return String(current.id) === String(targetBuilding.id);
  }

  async function followSelectedMember(lw, bf, self, t) {
    if (!CFG.autoFollowMember || !state.followMemberId || !lw || !bf || !self) return false;
    if (self.hasTeam && !self.isLeader) return false;
    if (!canAct(self)) return false;
    if (CFG.waitFollowTargetAction && !isFollowTargetActionReady(bf, self)) return false;
    if (t - state.lastMarch < CFG.marchCooldownMs) return false;

    const targetPlayer = findPlayerById(bf, state.followMemberId);
    if (!targetPlayer || targetPlayer.isMe) return false;
    const building = getPlayerTargetBuilding(bf, targetPlayer);
    if (!building) return false;
    const current = findCurrentBuilding(bf, self);
    if (current && String(current.id) === String(building.id)) return false;
    if (!canMoveToBuilding(building)) return false;

    state.lastMarch = t;
    try {
      await lw.sendStartMarch(building.position);
      state.selectedBuildingId = building.id;
      state.stats.followMarch += 1;
      state.stats.march += 1;
      state.currentTarget = { type: 'followMember', memberId: getPlayerId(targetPlayer), memberName: targetPlayer.name || '', building: buildingInfo(building, self) };
      log('跟随指定成员', targetPlayer.name || getPlayerId(targetPlayer), '目标建筑', building.name || building.id, posKey(building.position));
      return true;
    } catch (e) {
      logError('跟随成员行军失败', e);
      return false;
    }
  }
  function findBestTargetBuilding(bf, self) {
    const candidates = listBuildings(bf)
      .filter((b) => b && !b.isOur && !b.isHome && canMoveToBuilding(b))
      .map((b) => ({ b, dist: distance(self.position, b.position), pathLen: getPathLen(b), salt: isSaltPan(b) }))
      .filter((x) => x.pathLen > 0 && x.pathLen <= CFG.maxPathLen);

    if (!candidates.length) return null;

    const weight = (x) => {
      if (CFG.targetPriority === 'nearest') return 0;
      if (CFG.targetPriority === 'enemyFirst') return x.b.legionId && x.b.legionId !== self.legionId ? 0 : x.salt ? 1 : 2;
      return x.salt ? 0 : x.b.legionId && x.b.legionId !== self.legionId ? 1 : 2;
    };

    candidates.sort((a, b) => weight(a) - weight(b) || a.pathLen - b.pathLen || a.dist - b.dist || String(a.b.id).localeCompare(String(b.b.id)));
    return candidates[0];
  }

  function findEnemyInCurrentBuilding(bf, self, building) {
    if (!bf || !self || !building) return null;
    const lists = [building.attackerList, building.defenderList, building.battleList, building.allMembers, building._attackerList, building._defenderList, building._allMembers];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const role of list) {
        if (!role || role.id === self.id || role.roleId === self.roleId) continue;
        if (role.legionId === self.legionId) continue;
        if (isDead(role)) continue;
        return role;
      }
    }
    return null;
  }

  const HERO_NAMES = {
    101: '司马懿',
    102: '郭嘉',
    103: '关羽',
    104: '诸葛亮',
    105: '周瑜',
    106: '太史慈',
    107: '吕布',
    108: '华佗',
    109: '甄姬',
    110: '黄月英',
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
    121: '鲁肃',
    201: '徐晃',
    202: '董卓',
    203: '典韦',
    204: '张飞',
    205: '赵云',
    206: '庞统',
    207: '鲁肃',
    208: '陆逊',
    209: '甘宁',
    210: '貂蝉',
    211: '董卓',
    212: '张角',
    213: '张辽',
    214: '夏侯惇',
    215: '许褚',
    216: '夏侯渊',
    217: '魏延',
    218: '黄忠',
    219: '马超',
    220: '马岱',
    221: '吕蒙',
    222: '黄盖',
    223: '蔡文姬',
    224: '小乔',
    225: '袁绍',
    226: '华雄',
    227: '颜良',
    228: '文丑',
    301: '周泰',
    302: '许攸',
    303: '于禁',
    304: '张星彩',
    305: '关银屏',
    306: '关平',
    307: '程普',
    308: '张昭',
    309: '陆绩',
    310: '吕玲绮',
    311: '潘凤',
    312: '邢道荣',
    313: '祝融夫人',
    314: '孟获',
  };
  const ENEMY_FILTERS = ['吕布', '合力', '吴国', '姜维', '毒爆', '三蜀', '典韦', '司马', '残阵'];
  const WU_HERO_IDS = new Set([105, 106, 111, 115, 119, 121, 207, 208, 209, 221, 222, 224, 301, 307, 308, 309]);
  const SHU_HERO_IDS = new Set([103, 104, 110, 114, 118, 204, 205, 206, 217, 218, 219, 220, 304, 305, 306]);
  const HERO_ICON_URLS = {"101":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/5e/5e92c2c7-40b4-4ab3-b805-1e494b99b2b4.64aa9.png","102":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/c9/c9c53f6f-f095-48c4-a435-fe03357c9363.0e969.png","103":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/aa/aa8bcb1e-7c42-4633-a995-20a0b8cdd7d8.fe959.png","104":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/2a/2ae0945c-c1ff-4871-9cd9-ea17de120b68.9deac.png","105":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/64/64217282-76b9-4b59-89d0-606280d4e742.e580a.png","106":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/43/434c96a1-fd72-4f3e-9afd-b2005ade0471.aebab.png","107":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/f8/f89b811e-cf71-468e-8ca6-ec3ed328035f.566e3.png","108":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/ca/ca914afb-b293-4b84-b0fd-92f381e92f4c.605cd.png","109":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/fc/fc22aa06-12d9-4e7a-89c8-fe3aa2924b33.06692.png","110":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/8f/8fc54ead-be67-4c03-8a1f-61cb124ac70d.ea81e.png","111":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/fd/fdc5cb91-0af1-4a4b-8b04-4526b9d7afaf.c5060.png","112":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/d9/d941ab1b-eb7f-4292-8bc8-ce14db4dde3a.b8f87.png","113":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/64/642bba07-b7d5-4c54-a0a3-1235f54e8913.449a6.png","114":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/8b/8b5fee01-ce64-43b4-b472-05b4b3cb11c9.3ddf7.png","115":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/73/73cbfb60-4a99-41be-8bb5-b1e2dc41b2f8.ca3ea.png","116":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/30/30f85c74-e480-4c08-bd18-886a2abf0d94.19fd7.png","117":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/81/819c9dc6-2723-412d-96d9-9e1937aae445.6b8c3.png","118":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/fa/fa2fe95b-8cc4-4cd8-a557-13e9936eaf65.4d453.png","119":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/20/20d198f4-015a-45ad-a9a7-09a8b5b52bf1.7f28a.png","120":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/50/50308602-d0af-4d04-bf47-bb4d7cc7afcb.7673f.png","121":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/4a/4a7bdda4-eee4-4152-a7e2-7b00d65ac8bb.e464a.png","201":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/48/488a8f02-a23a-4a95-b601-24bf259766ca.5e5c7.png","202":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/19/19e39d6b-f275-444f-82d6-890b6e07f40b.241bd.png","203":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/19/19957294-7511-4817-87ae-10797122e6e8.1b2b9.png","204":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/8b/8bb7b096-dad6-411d-bd2d-1e9414d33344.1231c.png","205":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/4e/4e8398b7-21c3-4fee-8ac5-befa5c686141.efa21.png","206":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/e3/e31a7206-fc7a-43ab-90d4-c50393b41a28.7a6e1.png","207":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/85/85746f7d-170e-41f6-acb4-2838974d8f89.95c9e.png","208":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/24/24a3e4bf-493b-4e48-8578-a3be33ed42f8.c4835.png","209":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/df/df568844-cda6-4dd3-86fd-1cb6fe5e4046.d8910.png","210":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/0b/0b76b288-45a6-4e5b-9f4d-3bdd23597657.1f08f.png","211":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/53/53585c44-1573-4af2-9d27-4a09ac2a7693.f0896.png","212":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/cf/cf7e2b7e-9488-4ac3-9250-536161c9d3f9.e7eff.png","213":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/12/12d39a61-e041-42fe-bc08-8e702131af5c.42a28.png","214":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/bf/bf5d5c93-d79b-4b2a-9368-9927e9ebf591.6600d.png","215":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/d8/d8560b08-9619-4e3c-a4e2-020a24bcf9e0.44577.png","216":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/2e/2e02bbbe-61fe-407a-a45e-2bd5ce6a5b06.dc767.png","217":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/97/97d90a37-d94a-43eb-9c21-86a9c4c7513f.7048a.png","218":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/69/69d67832-b8b8-4c00-819d-aad3c9f717d5.b9dda.png","219":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/ba/ba9f6aaf-f19f-4adf-8bd2-1c57d62339cb.bd7d7.png","220":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/09/0931c7ca-eeae-40e7-971d-ee0878182654.7281a.png","221":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/c0/c0a40c54-28c0-4376-b133-2cf5066aa0c7.5fab2.png","222":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/b7/b780296c-f84e-4d9b-b86b-b9e8d807901f.53fa2.png","223":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/fc/fcb28a2c-a2f0-456f-bea7-46a53115d899.9b3c4.png","224":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/ee/eed37890-f498-42ad-9e6f-8f24a94143ff.91b75.png","225":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/c4/c43f495f-7da0-43ea-a65a-9fd0b80abc1d.4148a.png","226":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/82/82e75bff-0183-4caa-891b-959b5f0a0a7b.dbc2e.png","227":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/e4/e420ae11-b19c-4c70-aa0b-ba559ea0fb92.bb837.png","228":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/f1/f10465ba-23b7-4850-b473-ec87f4e58878.59939.png","301":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/60/602e7e3d-a146-44a2-bee4-ce063656a914.98be7.png","302":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/75/75ba68af-0e59-41a5-9b23-4cc977f96f87.a2a44.png","303":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/bf/bfb393d1-2c54-44f0-99a8-1d5582f42821.dd922.png","304":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/4b/4b68d6c3-1688-4b26-be24-6d2f6c599acb.459c3.png","305":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/1b/1b75d34f-bebe-437c-ae09-e9a8de237f0e.ba550.png","306":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/d7/d7a28dd0-2e4c-4dca-b898-db0b425bc85c.9e0dd.png","307":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/9a/9a26f18b-b284-49dd-bcb4-04bacb7ee95c.61afe.png","308":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/6b/6b5d5b3c-e425-4af2-af81-d0efe9124cf7.cd3fc.png","309":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/40/40f2f858-e42f-4556-94b1-e86d015ec474.b4120.png","310":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/b4/b4bbc50f-6fda-47cd-8b22-2fc9f6366019.364c1.png","311":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/a9/a9565712-3ba3-4022-bb42-6d6cb92dd890.5a542.png","312":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/5e/5e518054-b229-4721-a208-69fc814c37d8.780ae.png","313":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/e2/e2111e52-6842-4ae3-b72d-01a53a46bdb7.972ee.png","314":"https://xxz-xyzw-res.hortorgames.com/remote/icons/native/8b/8b3f5194-b197-4348-b3b9-167ae0aec731.efab8.png"};
  const SKIN_ICON_KEYS = [[114,"e7dd1336-ad9a-430f-893c-ef7727c256b9.720d1.png"],[106,"88f221b9-972c-403f-b97c-7ef879e59811.db1ea.png"],[103,"8fc7dac5-e2c0-48e2-9496-f99bca46e19b.39eea.png"],[113,"5a1bf3e0-ebc6-4b7d-8509-51ed6fba2bea.18cd8.png"],[116,"916a17ff-b7eb-4f4f-b1e2-8b85cf852445.ad801.png"],[115,"b827e13a-fc88-4565-b190-9b200bd11a33.b5cd7.png"],[109,"e3e6f1ae-af8a-4b0d-8292-6eacf92782f4.df33a.png"],[107,"261a9dea-02fd-47f7-906b-bd20f9a89217.7504a.png"],[101,"94aa2f9a-9d9f-4252-b4f9-c7e203141b3b.7139c.png"],[108,"8bccf956-9e4b-4d41-870a-6420d8815673.4dd2a.png"],[110,"162d2493-2d71-48dd-ab87-c0fcb73f80a2.5b537.png"],[102,"83aae735-e9c2-41fe-a4d0-7fb79b90afa0.da25c.png"],[105,"330b9935-eff3-4353-b18e-5f0472c3310e.5efef.png"],[104,"864fbc0f-ecc9-4e3a-9acc-77a747652439.fdea7.png"],[101,"cbb4268c-4917-473e-be04-d59ff95991c4.27f4e.png"],[109,"30cc9ab3-fc28-4f2e-9f6a-8f82e9f306e4.49108.png"],[113,"479a615a-83ba-4344-aeec-8134e5344f76.c7276.png"],[102,"fb97b966-f9db-487f-9087-45478967cf4f.03bd4.png"],[105,"e4725de5-fb5e-4cb0-abcd-7b5d9d7a2575.57aad.png"],[111,"8a1d06a3-3d53-4c2f-83de-bc42c00ae928.79103.png"],[115,"4c3a6527-4b2f-4827-b1fa-56586d7e64df.86ed3.png"],[108,"8f73a484-f805-47d7-8600-31f3a0192cf5.93221.png"],[116,"48372b68-58e3-493f-af91-506069b56616.35559.png"],[112,"ac0a6dd2-c184-4b08-9b8b-2f9b5fa09d41.ced5c.png"],[107,"958b0793-ca96-42b7-bc05-4956db23ca41.e1575.png"],[104,"76ebf140-de87-49d9-a92a-eaa7843eb6e4.02000.png"],[110,"36bceda5-1eb2-4734-b365-3aacb392d659.f8a0a.png"],[114,"f185c32b-3b5c-4dd0-a88a-46db7fcf1994.fe46f.png"],[103,"f7d4250f-8583-4765-99ba-ee33c6bb3065.ffbc0.png"],[119,"70cf07b2-b7ca-4b09-a943-88d13ba9b1fa.439f1.png"],[101,"c25bbff3-040b-47af-a0ad-cecbecf42b49.da721.png"],[101,"695e3e70-d073-47bb-92cd-4f21df8a84ee.d36cf.png"],[101,"ce3d4ea3-4da8-4af5-a64e-54fbb5c86345.cc6c3.png"],[101,"54d1618d-9e60-4a35-9ff9-239d24230be3.c4f63.png"],[101,"cbd805f3-0b03-4c8d-b062-09729fedda52.7ea1e.png"],[101,"36a56888-c247-4de8-a2c6-d427ef855459.666e3.png"],[102,"cbc81113-ceb6-41cc-965c-657d63e66ed4.ac268.png"],[102,"bc744d8e-9e3a-4e9f-812d-51091b1efbb5.d1fb1.png"],[102,"8d132362-0f5d-4bad-b9be-0a12ff86c104.a794f.png"],[102,"aadb4756-4a4e-48e2-a246-693779787771.05400.png"],[103,"25196400-de21-4614-8512-ab9abb44eaca.1c0f1.png"],[103,"303c66e6-f249-4946-a37f-d408374f9980.f82e2.png"],[103,"06a21eaf-e2cc-4d90-9179-e0b4c4110bff.a7fdf.png"],[103,"85df4ec0-06b2-42c6-bcf6-582e2144fc64.ff700.png"],[103,"976c8676-57aa-46a2-a809-61deb0045c1a.76875.png"],[103,"bc359d52-af89-48ee-ad5c-6808309d9488.d04d5.png"],[104,"0d9a9b66-2b3a-4fcf-bd81-065bee12ee0d.bfcdd.png"],[104,"e90f1f10-faf3-48e4-b40f-e5fe11c02626.cd5e0.png"],[104,"0e136a7f-43cf-40c6-b1d0-78a9067d324d.b9f0d.png"],[104,"a3fb8c73-ac8c-4eb4-9f10-bc1a29a4e494.5e5d8.png"],[104,"912ad7ab-85ef-41d7-88b1-89cca96e328c.a91d9.png"],[104,"38d41fa7-7d3a-45fe-87db-02ce67e8fea7.afb1f.png"],[105,"4a16521f-0eb9-4a80-b7fa-0b4776b48991.f6a43.png"],[105,"d9363c55-0ab3-44d2-aae7-d01d70b9f85f.893f3.png"],[105,"27e8ee81-05f3-4d12-970c-0168c2585ff3.a515d.png"],[105,"e74985f7-9fe8-4d32-9e0d-5d2f03fbf235.af408.png"],[105,"fce80976-7023-46e2-9fac-41f77c56e72e.4f208.png"],[105,"3316cfaa-daff-4cf8-8f1a-a1f55948b7bd.cf211.png"],[106,"d569a6e4-f72d-4fd9-90e7-8e89ca9741c7.d9120.png"],[106,"be716aff-fd62-48f5-844f-b0b6cf5a26f1.4ac83.png"],[106,"1a92fcf2-3b98-4d53-b71d-7cb61604abc2.c1715.png"],[106,"1aacb7f1-d9ed-4565-844f-b87e2b938c44.40a4e.png"],[106,"6f49dd57-9ba0-405a-8875-7fb40cb0f562.7e869.png"],[107,"001e8680-b13a-4585-b372-5e746232636b.1a2aa.png"],[107,"000a56d5-22e9-4c38-a807-052ed762307e.d9394.png"],[107,"bb2221b8-a299-4997-8dd6-3343a116ea08.f5fc1.png"],[107,"f994dbfe-f115-4c54-9235-6c11177dd66a.5bc10.png"],[107,"8db387b3-8be6-4f3a-9d86-4db742040fe3.9b1d1.png"],[107,"7ed06c06-ea4d-4a77-8c8b-96b374e00ba7.cbb1a.png"],[107,"a4bd8d87-23ea-4abb-9855-8d10bfb30164.9b520.png"],[107,"90ad16dd-8d77-4b8e-bbc4-d332c5d25a78.79509.png"],[107,"2bf1e2f6-0106-4ac5-b0c6-88422c298613.0e67e.png"],[107,"760a52b7-7487-4ca7-84ba-58bf32daf491.77a70.png"],[108,"839c924e-ab71-4908-92ff-267c82fd6771.7b8b4.png"],[108,"820ba646-7f1d-4dec-b7f3-379fb7d919c5.2683b.png"],[108,"fca26339-fcd6-4500-adce-488746240a0b.07fe4.png"],[108,"1cb1603d-4c1c-40f7-80f2-725e5a5be1a1.4664f.png"],[108,"474a3b48-0cb2-4036-b98c-b5847562fad4.f2914.png"],[109,"9952254c-cd3a-4bf8-a47f-ba6f7a097cd5.aad38.png"],[109,"476ed9bb-3bec-4f55-84f9-b5891ab32cce.2039b.png"],[109,"c44d05c2-404c-4a30-abd0-c787f0399042.d2186.png"],[109,"3b364aa0-37cd-43ae-9c68-532e01a682f8.d109b.png"],[109,"66c83ae9-0a08-4961-9047-774c190ac2f8.c9109.png"],[110,"4e7a5b03-eda2-4f83-99da-a8d5cacf2a9b.8bd3f.png"],[110,"657da930-a986-4b83-868f-ea11f9878d48.6d567.png"],[110,"46502058-bd53-4ace-b2f8-f807fe3a98b9.a53e6.png"],[110,"6f5236e0-0622-4503-9de2-373703cc60c8.98cb7.png"],[110,"d3caf2e1-01c0-45e2-9893-96d47eee7d4b.d08ed.png"],[111,"c4cbebf1-750a-44bf-9ccb-31f39f8c5ed6.732bf.png"],[111,"f13e8aa1-b932-4ea4-afc8-bf1b1342173d.93cdf.png"],[111,"40da6afb-dea1-42ee-86bd-8f04e5bf3a10.87f05.png"],[111,"c9ae0a2f-b97a-47bc-82ad-8959250b2f60.2f163.png"],[111,"36d3c0e8-1caf-4499-a913-90c4e9422478.2a184.png"],[111,"2a33c726-7a9e-47dc-8422-0a31046cbfcf.ffff4.png"],[112,"f48e6891-e074-4076-aedf-e3f058a332d1.3277e.png"],[112,"da630e59-8e1e-4134-a10a-44bf990112f4.df715.png"],[112,"21b2e0e4-5432-4eac-8448-7c932e51f812.867f2.png"],[112,"6425fbae-81d5-4612-80a2-b23c54437e3e.cf468.png"],[112,"58affd0e-2660-473d-a51c-f9e61aea06f9.71e0d.png"],[113,"dd846922-ff1a-49c7-92c7-7285ce4bfa61.387f3.png"],[113,"ddc30fdf-9ea6-4628-b0ea-979e15ee8de9.fdaa3.png"],[113,"f314c43c-c16f-48be-96c4-e6d17a941ae2.fb4ba.png"],[113,"9a72a6cb-255b-4217-a6df-f098d1d5d41b.06e6f.png"],[113,"3dabc049-6b0a-4c7e-967f-dcd5a687ad5d.90269.png"],[114,"54e0a44a-b6c6-4e4f-a598-b2ed03974d8c.0abe5.png"],[114,"83d9f751-e87c-40a9-90c9-5726747c3182.b47e4.png"],[114,"f103c86f-675b-495d-bf75-c4be346b9650.447c2.png"],[114,"06147838-403f-4bb0-b053-8da3d12ada7d.66888.png"],[114,"2d83ac10-1111-4e69-be4a-8d79bd86ccdd.ec639.png"],[114,"9f24b77a-3b3a-429d-a81e-ee1d3b5cd97c.1e95a.png"],[114,"beb5e3b0-1e85-447f-b145-99af035a6929.8d65f.png"],[115,"5102b5c8-ba34-4c01-bbd9-086aafc055ce.8a35b.png"],[115,"bcb9196a-26b2-4ae4-ac01-a72a7b306346.8af6e.png"],[115,"384f3c90-7219-4c3d-887e-fb4a252ba092.0dd1b.png"],[116,"8deae56b-7c07-4d01-a737-d10d8efa9c16.99ca0.png"],[116,"e4e1ba5d-8559-485e-bf6b-53c4dcc2bf24.9794b.png"],[116,"de6859f5-6b17-4bd7-bdab-0a5b28cd4af5.1f875.png"],[116,"cd1ecac1-69c6-4ce9-af53-d6f4f91734b5.f4245.png"],[116,"8321c9d0-1efc-4e72-8865-863bfa850755.46fe5.png"],[117,"08323958-7e05-4ca6-a5c4-ca0bbc1eda6c.e1717.png"],[117,"448eb723-5dc3-4728-aa3d-ad230d2cae5c.5d57b.png"],[117,"0b78b940-c517-4042-9a06-5a45560e8c78.b3a58.png"],[117,"a64a1913-b87f-4c19-9152-5960e3a73727.c3381.png"],[117,"1eaa647f-e08b-4cb8-b26e-bc28924cc054.4dc3d.png"],[118,"10d30522-2f87-461e-83fd-033e77130a6d.a9623.png"],[118,"1a2fc528-3cd1-4b4a-85d3-25e55e9d96de.97c4b.png"],[118,"38eada1e-e744-494b-9d35-85ddb90bc75f.55251.png"],[118,"3654ddcc-97c3-49a5-b768-add23fb5a7cd.62a52.png"],[118,"f5319b51-e761-40b7-bea0-36502d8cdd73.832d6.png"],[118,"9ca44d41-9c16-4a1b-88b5-242d1980a0cc.27e0a.png"],[118,"9fccb871-4358-4092-a7c3-a744a8aa664b.48e61.png"],[119,"3eb45a9b-abab-413f-bd3a-a26d8e45abac.c74f0.png"],[119,"2a752840-4c63-41f3-8d14-a6be3f7eabb7.b36b6.png"],[119,"9bc3e9b3-9d8c-4f7e-bdae-4a93490b3bb1.100e0.png"],[119,"5f5dc2b7-6960-4a11-a5f6-eec1b03ff509.d0797.png"],[119,"75913482-45fb-4b83-b98c-ae82a3cfa078.2356e.png"],[120,"03c874f2-a918-4990-bde0-c2fb1ba061d0.03970.png"],[120,"6fb5333d-082c-4aa0-b813-d84b750bd6ab.bdde3.png"],[120,"180c8c78-ee0d-4721-b8ce-0b6b8a611fca.ffab3.png"],[120,"b34dd0dc-bd27-404f-acb3-cb4aec2d6294.cf2be.png"],[120,"7bd00662-284d-4dab-94d2-5f19a690d7c0.9f562.png"],[121,"e5329399-0edd-4f40-b0d4-0f8421836e9f.9aad7.png"],[121,"4970d823-d6e2-4009-ac6e-9d892f247de6.26bcc.png"],[121,"108041f1-ec06-4164-9ae9-b63b96bdbc10.960e2.png"]];
  const SKIN_ID_TO_HERO_ID = {1001:114,1002:106,1003:103,1004:113,1005:116,1006:115,1007:109,1008:107,1009:101,1010:108,1011:110,1012:102,1013:105,1014:104,1015:101,1016:109,1017:113,1018:102,1019:105,1020:111,1021:115,1022:108,1023:116,1024:112,1025:107,1026:104,1027:110,1028:114,1029:103,1030:119,1031:101,1032:101,1033:101,1034:101,1035:101,1036:101,1037:102,1038:102,1039:102,1040:102,1041:103,1042:103,1043:103,1044:103,1045:103,1046:103,1047:104,1048:104,1049:104,1050:104,1051:104,1052:104,1053:105,1054:105,1055:105,1056:105,1057:105,1058:105,1059:106,1060:106,1061:106,1062:106,1063:106,1064:107,1065:107,1066:107,1067:107,1068:107,1069:107,1070:107,1071:107,1072:107,1073:107,1074:108,1075:108,1076:108,1077:108,1078:108,1079:109,1080:109,1081:109,1082:109,1083:109,1084:110,1085:110,1086:110,1087:110,1088:110,1089:111,1090:111,1091:111,1092:111,1093:111,1094:111,1095:112,1096:112,1097:112,1098:112,1099:112,1100:113,1101:113,1102:113,1103:113,1104:113,1105:114,1106:114,1107:114,1108:114,1109:114,1110:114,1111:114,1112:115,1113:115,1114:115,1115:116,1116:116,1117:116,1118:116,1119:116,1120:117,1121:117,1122:117,1123:117,1124:117,1125:118,1126:118,1127:118,1128:118,1129:118,1130:118,1131:118,1132:119,1133:119,1134:119,1135:119,1136:119,1137:120,1138:120,1139:120,1140:120,1141:120,1142:121,1143:121,1144:121};


  function getRoleCodeId(role) {
    return role?.id || role?.codeIdV2 || role?.cId || role?.serverData?.codeIdV2 || role?._serverData?.codeIdV2 || role?.roleId || 0;
  }

  function addArrayValues(out, value) {
    if (!value) return;
    if (value instanceof Map) {
      Array.from(value.entries()).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([key, item]) => {
        if (item && typeof item === 'object') {
          try {
            if (item.__slot === undefined) Object.defineProperty(item, '__slot', { value: Number(key), configurable: true });
          } catch (e) {}
          out.push(item);
        } else if (Number(item) > 0) {
          out.push({ heroId: Number(item), __slot: Number(key) });
        }
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => item && out.push(item));
      return;
    }
    if (typeof value === 'object') {
      Object.keys(value).sort((a, b) => Number(a) - Number(b)).forEach((key) => {
        const item = value[key];
        if (item && typeof item === 'object') {
          try {
            if (item.__slot === undefined) Object.defineProperty(item, '__slot', { value: Number(key), configurable: true });
          } catch (e) {}
          out.push(item);
        } else if (Number(item) > 0) {
          out.push({ heroId: Number(item), __slot: Number(key) });
        }
      });
    }
  }

  function mapGet(mapLike, key) {
    if (!mapLike) return undefined;
    if (mapLike instanceof Map) return mapLike.get(key) ?? mapLike.get(Number(key)) ?? mapLike.get(String(key));
    return mapLike[key] ?? mapLike[Number(key)] ?? mapLike[String(key)];
  }

  function readNumberField(obj, keys, depth = 3, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || depth < 0 || seen.has(obj)) return 0;
    seen.add(obj);
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== '') {
        const num = Number(value);
        if (Number.isFinite(num)) return num;
      }
    }
    for (const key of ['role', 'raw', 'player', 'serverData', '_serverData', 'data', 'roleInfo']) {
      const num = readNumberField(obj[key], keys, depth - 1, seen);
      if (num) return num;
    }
    return 0;
  }

  function readEnemyEnergy(enemy) {
    return readNumberField(enemy, [
      'strength',
      'energy',
      'strengthValue',
      'strengthCnt',
      'leftStrength',
      'curStrength',
      'stamina',
      'vit',
      'vitality',
      'actionPoint',
      'actionPoints',
      'fightCnt',
    ]);
  }

  function readEnemyPower(role, cached) {
    return readNumberField({ role, cached }, ['power', 'fightPower', 'combatPower', 'battlePower', 'totalPower', 'score']);
  }

  function normalizeImageKey(value) {
    return String(value || '').trim().toLowerCase();
  }

  function buildHeroIconMatchers() {
    const rows = [
      ...Object.keys(HERO_ICON_URLS).map((heroId) => [Number(heroId), HERO_ICON_URLS[heroId].split('/').pop() || '']),
      ...SKIN_ICON_KEYS,
    ];
    return rows.map(([heroId, fileName]) => {
      const file = normalizeImageKey(fileName);
      const stem = file.replace(/\.[^.]+$/, '');
      const parts = [file, stem].filter((v) => v && v.length >= 8);
      return { heroId: Number(heroId), keys: parts };
    });
  }

  const HERO_ICON_MATCHERS = buildHeroIconMatchers();

  function inferHeroIdFromImageName(value) {
    const key = normalizeImageKey(value);
    if (!key) return 0;
    const explicit = key.match(/(?:hero|card|general|avatar|head)[_-]?([1-3][0-9]{2})(?:[^0-9]|$)/i);
    if (explicit && HERO_NAMES[Number(explicit[1])]) return Number(explicit[1]);
    const skinId = key.match(/(?:skin|fashion|dress|avatar)[_-]?([1-9][0-9]{3,})(?:[^0-9]|$)/i);
    if (skinId && SKIN_ID_TO_HERO_ID[Number(skinId[1])]) return SKIN_ID_TO_HERO_ID[Number(skinId[1])];
    for (const item of HERO_ICON_MATCHERS) {
      if (item.keys.some((part) => key.includes(part))) return item.heroId;
    }
    return 0;
  }

  function normalizeHeroId(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return 0;
    if (HERO_NAMES[num]) return num;
    if (SKIN_ID_TO_HERO_ID[num]) return SKIN_ID_TO_HERO_ID[num];
    return 0;
  }

  function readHeroIdFromRaw(raw, depth = 0, seen = new Set()) {
    if (!raw || typeof raw !== 'object' || depth > 3 || seen.has(raw)) return 0;
    seen.add(raw);
    const heroFields = [
      'heroId', 'heroID', 'heroCfgId', 'heroConfId', 'heroConfigId', 'heroTplId', 'heroTemplateId',
      'cardId', 'cardID', 'cfgId', 'confId', 'configId', 'generalId', 'generalID',
      'monsterId', 'monsterID', 'monsterConfId', 'roleHeroId', 'baseHeroId', 'sourceHeroId', 'unitId',
    ];
    for (const key of heroFields) {
      const heroId = normalizeHeroId(raw[key]);
      if (heroId) return heroId;
    }
    const skinFields = ['skinId', 'skinID', 'skin', 'useSkin', 'useSkinId', 'wearSkin', 'wearSkinId', 'fashionId', 'dressId', 'avatarId'];
    for (const key of skinFields) {
      const heroId = SKIN_ID_TO_HERO_ID[Number(raw[key])] || 0;
      if (heroId) return heroId;
    }
    const nestedFields = ['hero', 'heroInfo', 'card', 'general', 'monster', 'roleHero', 'battleHero', 'serverData', '_serverData', 'data'];
    for (const key of nestedFields) {
      const heroId = readHeroIdFromRaw(raw[key], depth + 1, seen);
      if (heroId) return heroId;
    }
    return normalizeHeroId(raw.id || raw.ID);
  }

  function summarizeFormationRaw(value, depth = 0, seen = new Set()) {
    if (!value || depth > 2) return value;
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (value instanceof Map) {
      return Array.from(value.entries()).slice(0, 5).map(([key, item]) => [key, summarizeFormationRaw(item, depth + 1, seen)]);
    }
    if (Array.isArray(value)) return value.slice(0, 5).map((item) => summarizeFormationRaw(item, depth + 1, seen));
    const out = {};
    Object.keys(value).slice(0, 24).forEach((key) => {
      const item = value[key];
      if (item && typeof item === 'object') {
        if (['hero', 'heroInfo', 'card', 'general', 'monster', 'roleHero', 'battleHero', 'serverData', '_serverData', 'data'].includes(key)) {
          out[key] = summarizeFormationRaw(item, depth + 1, seen);
        } else if (Array.isArray(item) || item instanceof Map) {
          out[key] = summarizeFormationRaw(item, depth + 1, seen);
        } else {
          out[key] = '[Object]';
        }
      } else {
        out[key] = item;
      }
    });
    return out;
  }

  function extractTeamImageRefs(data) {
    const out = new Map();
    const source = data?.teamImgInfo || data?.teamImageInfo || data?.teamImgMap || data?.imgInfo || data?.imgNameMap;
    if (!source) return out;
    if (source instanceof Map) {
      source.forEach((value, key) => {
        if (value) out.set(Number(key), String(value));
      });
    } else if (Array.isArray(source)) {
      source.forEach((value, idx) => {
        if (value) out.set(idx, String(value));
      });
    } else if (typeof source === 'object') {
      Object.keys(source).forEach((key) => {
        const value = source[key];
        if (value) out.set(Number(key), String(value));
      });
    }
    return out;
  }

  function extractTeamImageBase64Map(data) {
    const out = new Map();
    const source = data?.teamInfo || data?.teamImgInfo || data?.teamImageInfo || data?.imgInfo || data;
    if (!source) return out;
    const add = (key, value) => {
      if (key === undefined || value === undefined || value === null || value === '') return;
      out.set(String(key), String(value));
    };
    if (source instanceof Map) {
      source.forEach((value, key) => add(key, value));
    } else if (Array.isArray(source)) {
      source.forEach((value, idx) => {
        if (value && typeof value === 'object') add(value.imgName || value.name || value.id || idx, value.base64 || value.data || value.img || value.value);
        else add(idx, value);
      });
    } else if (typeof source === 'object') {
      Object.keys(source).forEach((key) => {
        const value = source[key];
        if (value && typeof value === 'object') add(value.imgName || value.name || value.id || key, value.base64 || value.data || value.img || value.value);
        else add(key, value);
      });
    }
    return out;
  }

  function toImageSrc(value) {
    if (!value) return '';
    const text = String(value);
    if (/^data:image\//i.test(text) || /^https?:\/\//i.test(text)) return text;
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.length > 80) return 'data:image/png;base64,' + text.replace(/\s+/g, '');
    return '';
  }

  function getHeroIconSrc(hero) {
    return toImageSrc(hero?.imgBase64) || HERO_ICON_URLS[Number(hero?.heroId)] || '';
  }
  function extractPayload(resp) {
    if (!resp) return null;
    const candidates = [resp, resp.data].filter(Boolean);
    const respTypes = ['War_GetTeamInfoResp', 'War_GetTeamImgInfoResp', 'Payload_GetTeamInfoResp', 'Payload_GetTeamImgInfoResp'];
    for (const item of candidates) {
      if (typeof item?.getData === 'function') {
        try {
          const data = item.getData();
          if (data) return data;
        } catch (e) {}
        for (const typeName of respTypes) {
          const RespClass = getGeneratedRespClass(typeName);
          if (!RespClass) continue;
          try {
            const data = item.getData(new RespClass());
            if (data) return data;
          } catch (e) {}
        }
      }
    }
    return resp.body || resp.data || resp.result || resp.rawData || resp;
  }

  function extractHeroesFromAny(data) {
    const out = [];
    const seen = new Set();
    const imgRefs = extractTeamImageRefs(data);
    function pushHero(raw, slot) {
      if (!raw) return;
      const rawSlot = slot ?? raw.__slot ?? raw.pos ?? raw.position ?? raw.battleTeamSlot ?? out.length;
      let resolvedSlot = Number(rawSlot) || 0;
      try {
        const FormationConf = getConfigs()?.FormationConf;
        const conf = FormationConf?.getById?.(Number(rawSlot));
        if (conf && Number.isFinite(Number(conf.slot))) resolvedSlot = Number(conf.slot);
      } catch (e) {}
      const imgName = raw.imgName || raw.imageName || raw.headImgName || raw.iconName || raw.icon || raw.headIcon || raw.avatar || raw.imgId || raw.imageId || mapGet(imgRefs, rawSlot) || mapGet(imgRefs, resolvedSlot) || '';
      let heroId = readHeroIdFromRaw(raw);
      if (heroId <= 0) heroId = inferHeroIdFromImageName(imgName);
      if (heroId <= 0 && !imgName) return;
      const key = `${heroId || imgName}_${resolvedSlot}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        heroId,
        name: raw.name || raw.heroName || raw.hero?.name || HERO_NAMES[heroId] || (imgName ? `图片${resolvedSlot + 1}` : `英雄${heroId}`),
        level: Number(raw.level || raw.lv || raw.hero?.level || 0) || 0,
        star: Number(raw.star || raw.starLevel || raw.stars || raw.hero?.star || 0) || 0,
        slot: resolvedSlot,
        imgName: imgName ? String(imgName) : '',
        imgBase64: raw.imgBase64 || raw.base64 || raw.img || '',
      });
    }
    function visit(obj, depth) {
      if (!obj || depth > 4 || out.length >= 8) return;
      if (obj instanceof Map) {
        Array.from(obj.entries()).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([key, item]) => {
          if (item && typeof item === 'object') pushHero(item, key);
          else if (Number(item) > 0) pushHero({ heroId: Number(item) }, key);
        });
        return;
      }
      if (Array.isArray(obj)) {
        obj.forEach((item, idx) => {
          if (item && typeof item === 'object') pushHero(item, idx);
          else if (Number(item) > 0) pushHero({ heroId: Number(item) }, idx);
          visit(item, depth + 1);
        });
        return;
      }
      if (typeof obj !== 'object') return;
      const battleTeam = obj.battleTeam || obj.battleHeroIds || obj.battleHeros || obj.battleHeroes || obj.teamHeroIds || obj.heroIds || obj.teamInfo;
      if (battleTeam) {
        const rows = [];
        addArrayValues(rows, battleTeam);
        rows.forEach((row, idx) => pushHero(row, row.__slot ?? idx));
      }
      const heroes = obj.heroes || obj.heroList || obj.heroInfoList || obj.battleTeamList || obj.fightHeroList || obj.teamList || obj.list;
      if (heroes) {
        const rows = [];
        addArrayValues(rows, heroes);
        rows.forEach((row, idx) => pushHero(row, row.__slot ?? idx));
      }
      ['formation', 'teamInfo', 'battleInfo', 'roleInfo', 'serverData', '_serverData', 'data'].forEach((key) => visit(obj[key], depth + 1));
    }
    visit(data, 0);
    imgRefs.forEach((imgName, slot) => {
      if (!out.some((h) => Number(h.slot) === Number(slot))) pushHero({ imgName }, slot);
    });
    return out.sort((a, b) => a.slot - b.slot).slice(0, 5);
  }
  function classifyEnemyFormation(heroes) {
    const list = Array.isArray(heroes) ? heroes : [];
    const ids = new Set(list.map((h) => Number(h.heroId)));
    const labels = [];
    if (ids.has(107)) labels.push('吕布');
    if (ids.has(114)) labels.push('姜维');
    if (ids.has(117) || ids.has(203)) labels.push('典韦');
    if (ids.has(101)) labels.push('司马');
    const wuCount = list.filter((h) => WU_HERO_IDS.has(Number(h.heroId))).length;
    const shuCount = list.filter((h) => SHU_HERO_IDS.has(Number(h.heroId))).length;
    if (wuCount >= 3) labels.push('吴国');
    if (shuCount >= 3) labels.push('三蜀');
    if (ids.has(107) && list.length >= 4) labels.push('合力');
    if (ids.has(110) || ids.has(112) || ids.has(218) || ids.has(222)) labels.push('毒爆');
    if (list.length > 0 && list.length < 5) labels.push('残阵');
    if (!labels.length) labels.push(list.length ? '其他' : '未知');
    return labels;
  }

  function hasUsefulFormationLabels(labels) {
    return Array.isArray(labels) && labels.some((label) => label && label !== '未知' && label !== '其他');
  }

  function enemyMatchesFilters(enemy) {
    if (!state.enemyFilters.size) return true;
    const labels = new Set(enemy?.formationLabels || []);
    return Array.from(state.enemyFilters).some((name) => labels.has(name));
  }

  function enemyEnergy(enemy) {
    return readEnemyEnergy(enemy);
  }

  function sortEnemyTargets(list) {
    const arr = Array.isArray(list) ? list.slice() : [];
    if (state.enemySortMode === 'energy') {
      return arr.sort((a, b) => enemyEnergy(b) - enemyEnergy(a) || Number(b.power || 0) - Number(a.power || 0) || String(a.name).localeCompare(String(b.name)));
    }
    return arr.sort((a, b) => Number(b.power || 0) - Number(a.power || 0) || enemyEnergy(b) - enemyEnergy(a) || String(a.name).localeCompare(String(b.name)));
  }

  function collectEnemyCandidates(bf, self) {
    const out = new Map();
    const selfLegionId = self?.legionId;
    function add(role, building) {
      if (!role) return;
      const id = String(getRoleCodeId(role) || '');
      if (!id || String(id) === String(getPlayerId(self))) return;
      if (role.legionId && selfLegionId && Number(role.legionId) === Number(selfLegionId)) return;
      if (role.isMe || isDead(role)) return;
      const current = building || getPlayerTargetBuilding(bf, role) || findCurrentBuilding(bf, role);
      const cached = state.enemyFormationCache.get(id) || {};
      out.set(id, {
        id,
        role,
        name: role.name || cached.name || id,
        power: readEnemyPower(role, cached),
        energy: readEnemyEnergy(role) || Number(cached.energy || 0) || 0,
        state: roleState(role),
        buildingId: current?.id || '',
        buildingName: current?.name || '',
        buildingPos: clonePoint(current?.position),
        heroes: cached.heroes || extractHeroesFromAny(role),
        formationLabels: cached.formationLabels || classifyEnemyFormation(extractHeroesFromAny(role)),
        raw: role,
      });
    }
    function looksLikeRole(obj) {
      if (!obj || typeof obj !== 'object') return false;
      if (!getRoleCodeId(obj)) return false;
      if (obj.isMe) return true;
      return !!(obj.name || obj.roleName || obj.nickName) && (
        obj.legionId !== undefined ||
        obj.power !== undefined ||
        obj.strength !== undefined ||
        obj.state !== undefined ||
        obj.svrState !== undefined ||
        obj.position ||
        obj.svrPosition
      );
    }
    function scanRoles(obj, building, depth, seen) {
      if (!obj || depth > 4 || seen.has(obj)) return;
      if (typeof obj !== 'object') return;
      seen.add(obj);
      if (looksLikeRole(obj)) add(obj, building);
      if (Array.isArray(obj)) {
        obj.slice(0, 80).forEach((item) => scanRoles(item, building, depth + 1, seen));
        return;
      }
      ['attackerList', 'defenderList', 'battleList', 'allMembers', '_attackerList', '_defenderList', '_allMembers', 'roles', 'players', 'members', 'roleList', 'playerList', 'battleRoles'].forEach((key) => {
        scanRoles(obj[key], building, depth + 1, seen);
      });
    }
    mapForEach(bf?.players, (role) => add(role, getPlayerTargetBuilding(bf, role)));
    listBuildings(bf).forEach((building) => {
      [building.attackerList, building.defenderList, building.battleList, building.allMembers, building._attackerList, building._defenderList, building._allMembers].forEach((list) => {
        if (Array.isArray(list)) list.forEach((role) => add(role, building));
      });
      scanRoles(building, building, 0, new Set());
    });
    scanRoles(bf?.roleMap, null, 0, new Set());
    return Array.from(out.values()).sort((a, b) => {
      const cur = findCurrentBuilding(bf, self);
      const aCur = cur && String(a.buildingId) === String(cur.id) ? 0 : 1;
      const bCur = cur && String(b.buildingId) === String(cur.id) ? 0 : 1;
      return aCur - bCur || b.power - a.power || String(a.name).localeCompare(String(b.name));
    });
  }

  async function hydrateEnemyFormation(lw, enemy) {
    if (!enemy?.id) return enemy;
    const cacheKey = String(enemy.id);
    const applyCache = (heroes, formationLabels, extra) => {
      enemy.heroes = heroes || [];
      enemy.formationLabels = formationLabels || classifyEnemyFormation(enemy.heroes);
      state.enemyFormationCache.set(cacheKey, {
        heroes: enemy.heroes,
        formationLabels: enemy.formationLabels,
        name: enemy.name,
        power: enemy.power,
        energy: enemy.energy,
        ...(extra || {}),
      });
    };
    if (enemy.heroes?.length && enemy.heroes.some((h) => h.heroId > 0 || h.imgBase64 || h.imgName)) {
      enemy.formationLabels = classifyEnemyFormation(enemy.heroes);
      if (hasUsefulFormationLabels(enemy.formationLabels)) {
        state.enemyFormationCache.set(cacheKey, { heroes: enemy.heroes, formationLabels: enemy.formationLabels, name: enemy.name, power: enemy.power, energy: enemy.energy });
        return enemy;
      }
    }
    if (typeof lw?.sendGetTeamInfo !== 'function') return enemy;
    try {
      const resp = await lw.sendGetTeamInfo(enemy.id);
      const payload = extractPayload(resp);
      let heroes = extractHeroesFromAny(payload);
      if (!heroes.length) heroes = extractHeroesFromAny(resp);
      const imgRefs = extractTeamImageRefs(payload);
      if (imgRefs.size && typeof lw?.sendGetTeamImgInfo === 'function') {
        const imgNames = Array.from(new Set(Array.from(imgRefs.values()).filter(Boolean)));
        if (imgNames.length) {
          try {
            const imgResp = await lw.sendGetTeamImgInfo(imgNames);
            const imgPayload = extractPayload(imgResp);
            const base64Map = extractTeamImageBase64Map(imgPayload);
            heroes = heroes.map((hero) => {
              const imgName = hero.imgName || mapGet(imgRefs, hero.slot) || '';
              const imgBase64 = mapGet(base64Map, imgName) || mapGet(base64Map, hero.slot) || hero.imgBase64 || '';
              return { ...hero, imgName, imgBase64 };
            });
          } catch (imgErr) {
            logVerbose('读取敌方阵容图片失败', enemy.name || enemy.id, imgErr?.message || imgErr);
          }
        }
      }
      if (heroes.length) applyCache(heroes, classifyEnemyFormation(heroes), { energy: enemyEnergy(enemy), power: enemy.power });
    } catch (e) {
      logVerbose('读取敌方阵容失败', enemy.name || enemy.id, e?.message || e);
    }
    return enemy;
  }

  function nativeFormationText(player) {
    const id = String(getRoleCodeId(player) || '');
    const cached = id ? state.enemyFormationCache.get(id) : null;
    const heroes = cached?.heroes || extractHeroesFromAny(player);
    const labels = cached?.formationLabels || classifyEnemyFormation(heroes);
    const filtered = (labels || []).filter(Boolean);
    return (filtered.length ? filtered : ['未知']).slice(0, 3).join('/');
  }

  function updateNativeFormationLabels(id, text) {
    const labels = state.nativeFormationLabels.get(String(id));
    if (!labels) return;
    labels.forEach((label) => {
      if (!label || !label.parent) {
        labels.delete(label);
        return;
      }
      label.text = text;
    });
    if (!labels.size) state.nativeFormationLabels.delete(String(id));
  }

  function cacheNativeTeamInfo(player, teamInfo, imgInfo) {
    const id = String(getRoleCodeId(player) || '');
    if (!id || !teamInfo) return false;
    const heroes = extractHeroesFromAny({ teamInfo, teamImgInfo: imgInfo || new Map() });
    if (!heroes.length) return false;
    const labels = classifyEnemyFormation(heroes);
    const previous = state.enemyFormationCache.get(id);
    if (!hasUsefulFormationLabels(labels) && hasUsefulFormationLabels(previous?.formationLabels)) return true;
    state.enemyFormationCache.set(id, {
      heroes,
      formationLabels: labels,
      name: player?.name || id,
      power: readEnemyPower(player, {}),
      energy: readEnemyEnergy(player),
    });
    updateNativeFormationLabels(id, nativeFormationText({ id }));
    if (!hasUsefulFormationLabels(labels) && !state.enemyFormationDebugLogged.has(id)) {
      state.enemyFormationDebugLogged.add(id);
      console.log('[盐场阵容调试]', player?.name || id, {
        labels,
        heroes: heroes.map((h) => ({ heroId: h.heroId, name: h.name, slot: h.slot, imgName: h.imgName })),
        teamInfo: summarizeFormationRaw(teamInfo),
        imgInfo: summarizeFormationRaw(imgInfo),
      });
    }
    logVerbose('已缓存原生个人信息阵容', player?.name || id, labels.join('/'), heroes.map((h) => h.heroId || h.imgName).join(','));
    return true;
  }

  function ensureNativeFormationData(player, label) {
    const id = String(getRoleCodeId(player) || '');
    if (!id || state.nativeFormationPending.has(id)) return;
    const cached = state.enemyFormationCache.get(id);
    if (hasUsefulFormationLabels(cached?.formationLabels)) return;
    const lw = getLegionWarModule();
    if (!lw || typeof lw.sendGetTeamInfo !== 'function') return;
    state.nativeFormationPending.add(id);
    hydrateEnemyFormation(lw, {
      id,
      role: player,
      raw: player,
      name: player?.name || id,
      power: readEnemyPower(player, cached || {}),
      energy: readEnemyEnergy(player) || Number(cached?.energy || 0) || 0,
      heroes: cached?.heroes || extractHeroesFromAny(player),
      formationLabels: cached?.formationLabels || classifyEnemyFormation(extractHeroesFromAny(player)),
    }).then((enemy) => {
      if (label && label.parent && String(label.__sfaPlayerId || '') === id) label.text = nativeFormationText(enemy);
    }).catch((e) => {
      logVerbose('原生队列阵容识别失败', player?.name || id, e?.message || e);
    }).finally(() => {
      state.nativeFormationPending.delete(id);
    });
  }

  function putNativeFormationLabel(row, player) {
    if (!row || !player || typeof fgui === 'undefined') return;
    const id = String(getRoleCodeId(player) || '');
    let label = row.__sfaFormationLabel;
    if (!label || label.parent !== row) {
      label = new fgui.GTextField();
      label.name = 'sfaFormationTag';
      label.touchable = false;
      row.addChild(label);
      row.__sfaFormationLabel = label;
    }
    label.__sfaPlayerId = id;
    if (id) {
      let labels = state.nativeFormationLabels.get(id);
      if (!labels) {
        labels = new Set();
        state.nativeFormationLabels.set(id, labels);
      }
      labels.add(label);
    }
    label.text = nativeFormationText(player);
    label.fontSize = 18;
    label.bold = true;
    label.color = 0x8b4a2b;
    label.align = 'center';
    label.valign = 'middle';
    if (typeof label.setSize === 'function') label.setSize(92, 28);
    const btn = row.m_btnFight;
    const strength = row.m_strength || row.m_leftStrength || row.m_rightStrength;
    const power = row.m_power || row.m_leftPower || row.m_rightPower;
    const x = Math.max(250, Number(btn?.x ?? row.width - 118) - 96);
    const y = Number(strength?.y ?? power?.y ?? 66) - 2;
    if (typeof label.setXY === 'function') label.setXY(x, y);
    else {
      label.x = x;
      label.y = y;
    }
    label.visible = true;
    ensureNativeFormationData(player, label);
  }

  function nativeTroopsSortValue(row, mode) {
    const player = row?.player || row;
    if (mode === 'energy') return readEnemyEnergy(player);
    return Number(player?.power || player?.fightPower || player?.combatPower || 0) || 0;
  }

  function sortNativeTroopsList(page) {
    const list = page?._listData;
    if (!Array.isArray(list) || list.length <= 1) return;
    const mode = state.nativeTroopsSortMode === 'energy' ? 'energy' : 'power';
    list.sort((a, b) => {
      const main = nativeTroopsSortValue(b, mode) - nativeTroopsSortValue(a, mode);
      if (main) return main;
      const subMode = mode === 'energy' ? 'power' : 'energy';
      const sub = nativeTroopsSortValue(b, subMode) - nativeTroopsSortValue(a, subMode);
      if (sub) return sub;
      return String(a?.player?.name || '').localeCompare(String(b?.player?.name || ''));
    });
  }

  function refreshNativeTroopsList(page) {
    const ui = page?.ui;
    const list = ui?.m_list;
    if (!list) return;
    try {
      sortNativeTroopsList(page);
      if (typeof list.refreshVirtualList === 'function') list.refreshVirtualList();
      else list.numItems = Array.isArray(page?._listData) ? page._listData.length : list.numItems;
    } catch (e) {
      logVerbose('原生队列排序刷新失败', e?.message || e);
    }
  }

  function updateNativeSortButtons(page) {
    const bar = page?.__sfaSortBar;
    if (!bar) return;
    const mode = state.nativeTroopsSortMode === 'energy' ? 'energy' : 'power';
    setNativeSortButtonActive(bar.energy, mode === 'energy');
    setNativeSortButtonActive(bar.power, mode === 'power');
  }

  function drawNativeSortButtonBg(graph, active) {
    if (!graph) return;
    try {
      if (typeof graph.clearGraphics === 'function') graph.clearGraphics();
      const fill = active ? 0x60a83d : 0xd5bd66;
      const line = active ? 0x285c25 : 0x6b4a22;
      if (typeof graph.drawRoundRect === 'function') graph.drawRoundRect(3, line, fill, 8);
      else if (typeof graph.drawRect === 'function') graph.drawRect(3, line, fill);
    } catch (e) {}
  }

  function setNativeSortButtonActive(btn, active) {
    if (!btn) return;
    const label = btn.__sfaLabel || btn;
    label.color = active ? 0xffffff : 0x4b2a18;
    label.bold = true;
    drawNativeSortButtonBg(btn.__sfaBg, active);
  }

  function makeNativeSortButton(text, onClick) {
    if (typeof fgui.GComponent !== 'function' || typeof fgui.GGraph !== 'function') {
      const fallback = new fgui.GTextField();
      fallback.text = text;
      fallback.fontSize = 24;
      fallback.bold = true;
      fallback.align = 'center';
      fallback.valign = 'middle';
      fallback.color = 0x4b2a18;
      fallback.touchable = true;
      if (typeof fallback.setSize === 'function') fallback.setSize(120, 46);
      if (typeof fallback.onClick === 'function') fallback.onClick(onClick);
      return fallback;
    }
    const btn = new fgui.GComponent();
    btn.touchable = true;
    if (typeof btn.setSize === 'function') btn.setSize(120, 46);
    const bg = new fgui.GGraph();
    if (typeof bg.setSize === 'function') bg.setSize(120, 46);
    const label = new fgui.GTextField();
    label.text = text;
    label.fontSize = 24;
    label.bold = true;
    label.align = 'center';
    label.valign = 'middle';
    label.touchable = false;
    if (typeof label.setSize === 'function') label.setSize(120, 46);
    btn.addChild(bg);
    btn.addChild(label);
    btn.__sfaBg = bg;
    btn.__sfaLabel = label;
    drawNativeSortButtonBg(bg, false);
    if (typeof btn.onClick === 'function') btn.onClick(onClick);
    return btn;
  }

  function ensureNativeTroopsSortButtons(page) {
    const ui = page?.ui;
    if (!ui || typeof fgui === 'undefined') return;
    const list = ui.m_list;
    if (!page.__sfaSortBar) {
      const label = new fgui.GTextField();
      label.text = '排序';
      label.fontSize = 22;
      label.color = 0x9a4b31;
      label.align = 'right';
      label.valign = 'middle';
      label.touchable = false;
      if (typeof label.setSize === 'function') label.setSize(58, 42);

      const energy = makeNativeSortButton('精力降序', () => {
        state.nativeTroopsSortMode = 'energy';
        state.enemySortMode = 'energy';
        updateNativeSortButtons(page);
        refreshNativeTroopsList(page);
        saveSettings();
      });
      const power = makeNativeSortButton('战力降序', () => {
        state.nativeTroopsSortMode = 'power';
        state.enemySortMode = 'power';
        updateNativeSortButtons(page);
        refreshNativeTroopsList(page);
        saveSettings();
      });

      ui.addChild(label);
      ui.addChild(energy);
      ui.addChild(power);
      page.__sfaSortBar = { label, energy, power };
    }
    const y = Math.max(0, Number(list?.y || 270) - 58);
    const right = Number(ui.width || 720) - 40;
    const powerX = Math.max(420, right - 120);
    const energyX = powerX - 132;
    const labelX = energyX - 66;
    const bar = page.__sfaSortBar;
    if (typeof bar.label.setXY === 'function') bar.label.setXY(labelX, y + 2);
    else { bar.label.x = labelX; bar.label.y = y + 2; }
    if (typeof bar.energy.setXY === 'function') bar.energy.setXY(energyX, y);
    else { bar.energy.x = energyX; bar.energy.y = y; }
    if (typeof bar.power.setXY === 'function') bar.power.setXY(powerX, y);
    else { bar.power.x = powerX; bar.power.y = y; }
    updateNativeSortButtons(page);
  }

  function patchNativeTroopsFormationTags() {
    const pages = [
      req('AttackTroopsPage')?.AttackTroopsPage,
      req('DefenseTroopsPage')?.DefenseTroopsPage,
    ].filter(Boolean);
    if (!pages.length) return false;
    let patched = 0;
    pages.forEach((Page) => {
      const proto = Page?.prototype;
      const originalRefresh = proto?._refresh;
      if (typeof originalRefresh === 'function' && !originalRefresh.__sfaSortPatched) {
        proto._refresh = function (...args) {
          const ret = originalRefresh.apply(this, args);
          try {
            ensureNativeTroopsSortButtons(this);
            refreshNativeTroopsList(this);
          } catch (e) {
            logVerbose('原生队列排序渲染失败', e?.message || e);
          }
          return ret;
        };
        proto._refresh.__sfaSortPatched = true;
        patched += 1;
      }
      const originalShow = proto?.onShow;
      if (typeof originalShow === 'function' && !originalShow.__sfaSortPatched) {
        proto.onShow = function (...args) {
          const ret = originalShow.apply(this, args);
          try {
            ensureNativeTroopsSortButtons(this);
            refreshNativeTroopsList(this);
          } catch (e) {
            logVerbose('原生队列排序按钮挂载失败', e?.message || e);
          }
          return ret;
        };
        proto.onShow.__sfaSortPatched = true;
        patched += 1;
      }
      ['_refreshItem', '_refreshTeamItem'].forEach((method) => {
        const original = proto?.[method];
        if (typeof original !== 'function' || original.__sfaFormationPatched) return;
        proto[method] = function (...args) {
          const ret = original.apply(this, args);
          try {
            putNativeFormationLabel(args[1], args[2]);
          } catch (e) {
            logVerbose('原生队列阵容标签渲染失败', e?.message || e);
          }
          return ret;
        };
        proto[method].__sfaFormationPatched = true;
        patched += 1;
      });
    });
    [
      req('LegionWarTeamDetailsDialog')?.LegionWarTeamDetailsDialog,
      req('LegionWarMonsterDetailsDialog')?.LegionWarMonsterDetailsDialog,
      req('LegionWarSuicideDialog')?.LegionWarSuicideDialog,
    ].filter(Boolean).forEach((Dialog) => {
      const proto = Dialog?.prototype;
      const originalInfo = proto?._onGetTeamInfo;
      if (typeof originalInfo === 'function' && !originalInfo.__sfaFormationInfoPatched) {
        proto._onGetTeamInfo = function (...args) {
          try {
            const payload = extractPayload(args[0]);
            if (payload?.teamInfo) {
              cacheNativeTeamInfo(this?.model?.get?.('player') || getSelf(getBattlefield(getLegionWarModule())), payload.teamInfo, payload.teamImgInfo || payload.teamImageInfo || new Map());
            }
          } catch (e) {
            logVerbose('原生个人信息早期阵容缓存失败', e?.message || e);
          }
          return originalInfo.apply(this, args);
        };
        proto._onGetTeamInfo.__sfaFormationInfoPatched = true;
        patched += 1;
      }
      const original = proto?._loadBattleTeam;
      if (typeof original !== 'function' || original.__sfaFormationPatched) return;
      proto._loadBattleTeam = function (...args) {
        try {
          cacheNativeTeamInfo(this?.model?.get?.('player') || getSelf(getBattlefield(getLegionWarModule())), args[0], args[1]);
        } catch (e) {
          logVerbose('原生个人信息阵容缓存失败', e?.message || e);
        }
        return original.apply(this, args);
      };
      proto._loadBattleTeam.__sfaFormationPatched = true;
      patched += 1;
    });
    state.nativeFormationPatched = patched > 0;
    if (state.nativeFormationPatched) log('已挂载原生队列阵容标签');
    return state.nativeFormationPatched;
  }

  async function refreshEnemyTargets(force) {
    const lw = getLegionWarModule();
    let bf = getBattlefield(lw);
    let self = getSelf(bf);
    const t = now();
    if (!force && t - state.lastEnemyRefresh < 5000) return state.enemyTargets;
    if (!bf || !self || state.enemyRefreshing) return state.enemyTargets;
    state.enemyRefreshing = true;
    state.lastEnemyRefresh = t;
    try {
      if (force && typeof lw?.sendGetBattlefieldInfo === 'function') {
        await lw.sendGetBattlefieldInfo();
        bf = getBattlefield(lw) || bf;
        self = getSelf(bf) || self;
      }
      const list = collectEnemyCandidates(bf, self).slice(0, 60);
      for (const enemy of list) {
        await hydrateEnemyFormation(lw, enemy);
      }
      state.enemyTargets = sortEnemyTargets(list);
      state.stats.refreshEnemy += 1;
      log('已刷新盐场敌人列表', `敌人数${list.length}`);
      return list;
    } catch (e) {
      logError('刷新敌人列表失败', e);
      return state.enemyTargets;
    } finally {
      state.enemyRefreshing = false;
    }
  }

  async function attackEnemyById(lw, bf, self, enemyId, t, source) {
    if (!CFG.autoAttackEnemy || !canAct(self) || t - state.lastAttack < CFG.attackCooldownMs) return false;
    if (!enemyId || typeof lw?.sendStartBattle !== 'function') return false;
    const list = state.enemyTargets.length ? state.enemyTargets : collectEnemyCandidates(bf, self);
    const enemy = list.find((item) => String(item.id) === String(enemyId));
    if (!enemy || !enemyMatchesFilters(enemy)) return false;
    const current = findCurrentBuilding(bf, self);
    if (!CFG.sandbox && current && enemy.buildingId && String(enemy.buildingId) !== String(current.id)) return false;
    state.lastAttack = t;
    try {
      await lw.sendStartBattle(enemy.id);
      state.stats.attackEnemy += 1;
      if (source === 'locked') state.stats.attackLockedEnemy += 1;
      state.currentTarget = { type: source === 'locked' ? 'attackLockedEnemy' : 'attackSelectedEnemy', enemyId: enemy.id, enemyName: enemy.name, labels: enemy.formationLabels, building: current ? buildingInfo(current, self) : null };
      log(source === 'locked' ? '攻击锁定敌人' : '攻击选中敌人', enemy.name || enemy.id, (enemy.formationLabels || []).join('/'));
      return true;
    } catch (e) {
      logError('指定敌人开战失败', e);
      return false;
    }
  }

  async function attackLockedEnemy(lw, bf, self, t) {
    if (!CFG.autoAttackLockedEnemy || !state.lockedEnemyId) return false;
    return attackEnemyById(lw, bf, self, state.lockedEnemyId, t, 'locked');
  }

  async function enterBattlefield(lw, t) {
    if (!CFG.autoEnter || state.entering || t - state.lastEnter < CFG.enterCooldownMs) return false;
    state.entering = true;
    state.lastEnter = t;
    try {
      if (typeof lw?.enterAnonymousWar === 'function') {
        log('进入伟大航路灰岩岛战场');
        await lw.enterAnonymousWar();
      } else if (typeof lw?.goto === 'function') {
        log('进入伟大航路盐场战场');
        await lw.goto(0, true, true);
      } else if (typeof lw?.sendGetBattlefield === 'function') {
        await lw.sendGetBattlefield();
      } else {
        return false;
      }
      state.stats.enter += 1;
      return true;
    } catch (e) {
      logError('进入战场失败', e);
      return false;
    } finally {
      state.entering = false;
    }
  }

  async function refreshBattlefieldInfo(lw, t) {
    if (!lw || t - state.lastRefreshInfo < CFG.refreshInfoCooldownMs) return false;
    if (typeof lw.sendGetBattlefieldInfo !== 'function') return false;
    state.lastRefreshInfo = t;
    try {
      await lw.sendGetBattlefieldInfo();
      state.stats.refreshInfo += 1;
      return true;
    } catch (e) {
      logVerbose('刷新战场信息失败', e?.message || e);
      return false;
    }
  }

  async function deployOnce(lw, bf, reason, t, force) {
    if (!CFG.autoDeploy || !bf?.id) return false;
    if (!force && t - state.lastDeploy < CFG.deployCooldownMs) return false;
    if (state.deployedInBattlefield.has(bf.id) && reason !== '复活后') return false;
    const deployData = lw?.deployData;
    if (!deployData || typeof deployData.sendSetBattleTeam !== 'function') return false;

    state.lastDeploy = t;
    try {
      deployData.initData?.();
      if (deployData.isTeamEmpty) {
        log('盐场阵容为空，跳过布阵，主循环继续执行');
        return false;
      }
      await deployData.sendSetBattleTeam();
      state.deployedInBattlefield.add(bf.id);
      state.stats.deploy += 1;
      log(`已发送盐场布阵一次：${reason}`);
      return true;
    } catch (e) {
      logError('布阵失败，主循环继续执行', e);
      return false;
    }
  }

  function getReviveLeftSeconds(role) {
    if (!role) return 0;
    const direct = Number(role.reviveTime ?? role.serverData?.reviveTimeLeft ?? role._serverData?.reviveTimeLeft ?? 0);
    if (Number.isFinite(direct) && direct > 0 && direct < 86400) return Math.ceil(direct);
    const endMs = Number(role.endDieTime || 0);
    if (Number.isFinite(endMs) && endMs > now()) return Math.ceil((endMs - now()) / 1000);
    const reviveTime = Number(role.serverData?.reviveTime ?? role._serverData?.reviveTime ?? 0);
    if (Number.isFinite(reviveTime) && reviveTime > 0) {
      const end = reviveTime > 1e10 ? reviveTime : reviveTime * 1000;
      if (end > now()) return Math.ceil((end - now()) / 1000);
    }
    return 0;
  }

  function getReviveTimesLeft(lw, self) {
    if (!self) return 0;
    const direct = Number(self.reviveTimes ?? self.reviveTimesLeft ?? self.serverData?.reviveTimes ?? self._serverData?.reviveTimes);
    if (Number.isFinite(direct)) return Math.max(0, direct);
    let freeTimes = 0;
    try {
      const key = getTypes().LWConstKey?.legionWarFreeResurrectTimes;
      if (key !== undefined && typeof lw?.battlefield?.getConstValue === 'function') freeTimes = Number(lw.battlefield.getConstValue(key) || 0);
      else if (key !== undefined && typeof self?._battlefield?.getConstValue === 'function') freeTimes = Number(self._battlefield.getConstValue(key) || 0);
    } catch (e) {
      freeTimes = 0;
    }
    const used = Number(self.serverData?.revive ?? self._serverData?.revive ?? self.revive ?? 0) || 0;
    return Math.max(0, freeTimes - used);
  }

  function getResurrectItemCount(lw, self) {
    const shared = Number(lw?.shareResurrectBallNum ?? 0) || 0;
    const reviveItem = Number(self?.reviveItem ?? self?.serverData?.reviveItem ?? self?._serverData?.reviveItem ?? 0) || 0;
    if (shared > 0 || reviveItem > 0) return Math.max(shared, reviveItem);
    try {
      const key = getTypes().LWConstKey?.legionWarResurrectItem;
      const itemId = key !== undefined && typeof lw?.battlefield?.getConstValue === 'function' ? lw.battlefield.getConstValue(key) : 0;
      const role = getRoleData();
      if (itemId && typeof role?.getItemQuantity === 'function') return Number(role.getItemQuantity(itemId) || 0);
    } catch (e) {
      return 0;
    }
    return 0;
  }

  function canUseResurrectItem(lw, self) {
    if (typeof self?.canUseResurrectItem === 'function') {
      try {
        return !!self.canUseResurrectItem();
      } catch (e) {
        return false;
      }
    }
    return getResurrectItemCount(lw, self) > 0;
  }

  async function resurrect(lw, self, t) {
    if (!isDead(self)) return false;
    const left = getReviveLeftSeconds(self);
    const reviveTimesLeft = getReviveTimesLeft(lw, self);
    const itemCount = getResurrectItemCount(lw, self);
    state.currentTarget = { type: 'waitRevive', leftSeconds: left, reviveTimesLeft, resurrectItemCount: itemCount, reviveTime: self?.reviveTime || 0, endDieTime: self?.endDieTime || 0 };
    if (left > 0) {
      state.stats.waitRevive += 1;
      logVerbose('等待复活倒计时', `${left}s`);
      return false;
    }
    if (reviveTimesLeft > 0) return false;
    if (!CFG.useResurrectItem) return false;
    if (!canUseResurrectItem(lw, self)) return false;
    if (t - state.lastResurrect < CFG.resurrectCooldownMs) return false;
    if (typeof lw?.sendUseResurrect !== 'function') return false;
    state.lastResurrect = t;
    try {
      await lw.sendUseResurrect();
      state.stats.resurrect += 1;
      log('已使用复活丹/复活道具');
      return true;
    } catch (e) {
      logVerbose('复活暂不可用，等待倒计时或道具条件', e?.message || e);
      return false;
    }
  }

  async function attackCurrentBuilding(lw, bf, self, t) {
    if (!CFG.autoAttackBuilding || !canAct(self) || t - state.lastAttack < CFG.attackCooldownMs) return false;
    const building = findCurrentBuilding(bf, self);
    if (!building || !canAttackBuilding(building)) return false;

    state.lastAttack = t;
    try {
      await lw.sendStartAttackBuilding(building.id);
      state.stats.attackBuilding += 1;
      state.currentTarget = { type: 'attackBuilding', building: buildingInfo(building, self) };
      log('攻击当前盐场建筑', building.name || building.id, posKey(building.position));
      return true;
    } catch (e) {
      logError('攻击建筑失败', e);
      return false;
    }
  }

  async function attackEnemy(lw, bf, self, t) {
    if (!CFG.autoAttackEnemy || !canAct(self) || t - state.lastAttack < CFG.attackCooldownMs) return false;
    const building = findCurrentBuilding(bf, self);
    const enemy = findEnemyInCurrentBuilding(bf, self, building);
    if (!enemy || typeof lw?.sendStartBattle !== 'function') return false;

    state.lastAttack = t;
    try {
      await lw.sendStartBattle(enemy.id || enemy.roleId);
      state.stats.attackEnemy += 1;
      state.currentTarget = { type: 'attackEnemy', enemyId: enemy.id || enemy.roleId, enemyName: enemy.name || '', building: buildingInfo(building, self) };
      log('攻击当前建筑内敌人', enemy.name || enemy.id || enemy.roleId);
      return true;
    } catch (e) {
      logError('攻击敌人失败', e);
      return false;
    }
  }

  async function marchToSaltPan(lw, bf, self, t) {
    if (!CFG.autoMarchSaltPan || !canAct(self) || t - state.lastMarch < CFG.marchCooldownMs) return false;
    const target = findBestTargetBuilding(bf, self);
    if (!target?.b?.position || typeof lw?.sendStartMarch !== 'function') return false;

    state.lastMarch = t;
    try {
      await lw.sendStartMarch(target.b.position);
      state.stats.march += 1;
      state.currentTarget = { type: 'march', building: buildingInfo(target.b, self) };
      log(`行军到${target.salt ? '盐田' : '建筑'}`, target.b.name || target.b.id, `我方=${posKey(self.position)}`, `目标=${posKey(target.b.position)}`, `距离=${target.dist}`, `路径=${target.pathLen}`);
      return true;
    } catch (e) {
      logError('行军失败', e);
      return false;
    }
  }


  function getSpeedUpDiamondCost(lw, bf) {
    let base = 0;
    try {
      const LWConstKey = getTypes().LWConstKey || {};
      const key = LWConstKey.legionWarSpeedCost;
      if (key !== undefined && typeof bf?.getConstValue === 'function') base = Number(bf.getConstValue(key) || 0);
    } catch (e) {
      base = 0;
    }
    let living = 1;
    try {
      const count = Number(lw?.getTeamLivingPlayerCount?.() || 0);
      if (Number.isFinite(count) && count > 0) living = count;
    } catch (e) {
      living = 1;
    }
    const cost = base * living;
    return Number.isFinite(cost) && cost > 0 ? cost : 0;
  }

  async function speedUpSelfMarch(lw, bf, self, force) {
    if (!self || !isMarching(self)) {
      if (force) log('当前没有行军，不能加速');
      return false;
    }
    if (!self.marchId) {
      if (force) log('没有找到 marchId，不能加速');
      return false;
    }
    if (!force && !CFG.autoSpeedUp) return false;
    const t = now();
    if (!force && t - state.lastSpeedUp < CFG.speedUpCooldownMs) return false;
    state.lastSpeedUp = t;
    const diamondCost = getSpeedUpDiamondCost(lw, bf);
    try {
      if (typeof lw?.sendSpeedUp === 'function') {
        await lw.sendSpeedUp(self.marchId);
      } else if (typeof lw?.showAccelerateDialog === 'function') {
        await lw.showAccelerateDialog(self.marchId, self.endMarchTime);
      } else {
        return false;
      }
      state.stats.speedUp += 1;
      state.stats.speedUpDiamond += diamondCost;
      log('已自动发送行军加速', self.marchId, diamondCost ? ('金砖-' + diamondCost) : '金砖消耗未知');
      return true;
    } catch (e) {
      logError('加速失败', e);
      return false;
    }
  }
  async function invitePlayer(playerId, auto) {
    const lw = getLegionWarModule();
    const id = String(playerId || '');
    if (!id || state.rejectedInviteIds.has(id)) return false;
    if (!lw || typeof lw.sendInviteJoinTeam !== 'function') return false;
    const t = now();
    const last = state.inviteHistory.get(id) || 0;
    if (auto && t - last < CFG.inviteCooldownMs) return false;
    try {
      state.inviteHistory.set(id, t);
      await lw.sendInviteJoinTeam(playerId);
      state.stats.invite += 1;
      log(auto ? '已自动邀请锁定成员' : '已邀请组队', playerId);
      return true;
    } catch (e) {
      logError('邀请组队失败', e);
      return false;
    }
  }
  async function kickPlayer(playerId) {
    const lw = getLegionWarModule();
    if (!lw || typeof lw.sendKickOutTeam !== 'function') return false;
    try {
      await lw.sendKickOutTeam(playerId);
      state.stats.kick += 1;
      log('已踢出队伍', playerId);
      return true;
    } catch (e) {
      logError('踢出队伍失败', e);
      return false;
    }
  }

  async function leaveTeam() {
    const lw = getLegionWarModule();
    if (!lw || typeof lw.sendLeave !== 'function') return false;
    try {
      await lw.sendLeave();
      state.stats.leaveTeam += 1;
      log('已离开队伍');
      return true;
    } catch (e) {
      logError('离开队伍失败', e);
      return false;
    }
  }

  async function moveSelectedBuilding() {
    const lw = getLegionWarModule();
    const bf = getBattlefield(lw);
    const self = getSelf(bf);
    const building = findBuildingById(bf, state.selectedBuildingId);
    if (!building) return false;
    if (building.inMarchList) return speedUpSelfMarch(lw, bf, self);
    if (building.inBuilding && canAttackBuilding(building)) return attackCurrentBuilding(lw, bf, self, 0);
    if (!canMoveToBuilding(building)) {
      log('该建筑当前不可行军', building.name || building.id);
      return false;
    }
    try {
      await lw.sendStartMarch(building.position);
      state.stats.march += 1;
      state.currentTarget = { type: 'manualMarch', building: buildingInfo(building, self) };
      log('手动行军到建筑', building.name || building.id, posKey(building.position));
      return true;
    } catch (e) {
      logError('手动行军失败', e);
      return false;
    }
  }


  async function moveTeamPlayer(playerId, dir) {
    const lw = getLegionWarModule();
    const bf = getBattlefield(lw);
    const self = getSelf(bf);
    if (!lw || typeof lw.sendChangePos !== 'function' || !bf || !self) return false;
    const players = listTeamPlayers(bf, self);
    if (!players.length || !self.isLeader) {
      log('只有队长可以调整队伍站位');
      return false;
    }
    const ids = players.map(getPlayerId).filter(Boolean);
    const index = ids.findIndex((id) => String(id) === String(playerId));
    const next = index + dir;
    if (index < 0 || next < 0 || next >= ids.length) return false;
    const tmp = ids[index];
    ids[index] = ids[next];
    ids[next] = tmp;
    try {
      await lw.sendChangePos(ids);
      state.stats.changePos += 1;
      log('已调整队伍站位', ids);
      return true;
    } catch (e) {
      logError('调整站位失败', e);
      return false;
    }
  }

  function selfTeamSize(bf, self) {
    return listTeamPlayers(bf, self).filter(Boolean).length;
  }

  function isPlayerInSelfTeam(bf, self, playerId) {
    const id = String(playerId || '');
    return listTeamPlayers(bf, self).some((p) => isSameMemberId(p, id));
  }

  function detectRejectedInvites(bf, self) {
    const candidates = listInviteCandidates(bf, self);
    for (const p of candidates) {
      const id = String(getPlayerId(p));
      if (!id || !state.lockedInviteIds.has(id) || state.rejectedInviteIds.has(id)) continue;
      if ((p.inviteTime || 0) > 0 && state.inviteHistory.has(id)) {
        state.rejectedInviteIds.add(id);
        state.lockedInviteIds.delete(id);
        state.stats.rejectedInvite += 1;
        log('检测到成员拒绝邀请，已停止继续邀请', p.name || id, `冷却 ${p.inviteTime}s`);
      }
    }
  }

  function lockedInviteIds() {
    return Array.from(state.lockedInviteIds).filter((id) => id && !state.rejectedInviteIds.has(String(id)));
  }

  function hasLockedMember(player) {
    return lockedInviteIds().some((id) => isSameMemberId(player, id));
  }

  function areLockedMembersInTeam(bf, self) {
    const ids = lockedInviteIds();
    if (!CFG.waitLockedMembersBeforeAction || ids.length <= 0) return true;
    if (self?.hasTeam && !self?.isLeader) return true;
    return ids.every((id) => isPlayerInSelfTeam(bf, self, id));
  }

  async function autoInviteLockedMembers(lw, bf, self, t) {
    if (!CFG.autoLockedInvite || !lw || !bf || !self || state.lockedInviteIds.size <= 0) return false;
    detectRejectedInvites(bf, self);
    if (selfTeamSize(bf, self) >= CFG.maxTeamSize) return false;
    if (self.hasTeam && !self.isLeader) return false;
    if (t - state.lastInvite < CFG.inviteCooldownMs) return false;

    const candidates = listInviteCandidates(bf, self);
    for (const lockedId of Array.from(state.lockedInviteIds)) {
      if (state.rejectedInviteIds.has(lockedId)) continue;
      if (isPlayerInSelfTeam(bf, self, lockedId)) continue;
      const warCodeId = resolveWarCodeId(lw, lockedId);
      const player = candidates.find((p) => isSameMemberId(p, lockedId) || isSameMemberId(p, warCodeId));
      if (!player) continue;
      if ((player.inviteTime || 0) > 0) {
        if (state.inviteHistory.has(String(lockedId))) {
          state.rejectedInviteIds.add(String(lockedId));
          state.lockedInviteIds.delete(String(lockedId));
          state.stats.rejectedInvite += 1;
      log('锁定成员已拒绝邀请，不再邀请', player.name || lockedId);
        }
        continue;
      }
      state.lastInvite = t;
      return invitePlayer(getPlayerId(player) || warCodeId, true);
    }
    return false;
  }

  async function refreshClubMembers(lw) {
    const legion = getLegionModule();
    try {
      if (legion && typeof legion.sendGetInfo === 'function') await legion.sendGetInfo();
      if (lw && typeof lw.sendGetBattlefield === 'function') await lw.sendGetBattlefield();
      state.stats.refreshMembers += 1;
      const count = listClubMembers(lw, getBattlefield(lw), getSelf(getBattlefield(lw))).length;
      log('已刷新俱乐部成员/战场基础信息', `成员数${count}`);
      return true;
    } catch (e) {
      logError('刷新俱乐部成员失败', e);
      return false;
    }
  }

  const STORAGE_KEY = 'salt-field-auto-settings-v1';

  function saveSettings() {
    const data = {
      lockedInviteIds: Array.from(state.lockedInviteIds),
      followMemberId: state.followMemberId || '',
      selectedEnemyId: state.selectedEnemyId || '',
      lockedEnemyId: state.lockedEnemyId || '',
      enemyFilters: Array.from(state.enemyFilters),
      enemySortMode: state.enemySortMode || 'power',
      nativeTroopsSortMode: state.nativeTroopsSortMode || state.enemySortMode || 'power',
      useResurrectItem: !!CFG.useResurrectItem,
      autoMarchSaltPan: !!CFG.autoMarchSaltPan,
      panelPos: state.panelPos,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      state.savedAt = data.savedAt;
      log('盐场设置已保存', data);
      return true;
    } catch (e) {
      logError('保存盐场设置失败', e);
      return false;
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      state.lockedInviteIds = new Set((data.lockedInviteIds || []).map(String));
      state.followMemberId = data.followMemberId ? String(data.followMemberId) : null;
      state.selectedEnemyId = data.selectedEnemyId ? String(data.selectedEnemyId) : null;
      state.lockedEnemyId = data.lockedEnemyId ? String(data.lockedEnemyId) : null;
      state.enemyFilters = new Set((data.enemyFilters || []).map((name) => {
        const text = String(name);
        if (text === '\u9ec4\u7206' || text === '黄爆' || text === '\u59e3\u6394\u578e') return '毒爆';
        return text;
      }).filter((name) => ENEMY_FILTERS.includes(name)));
      if (data.enemySortMode === 'energy' || data.enemySortMode === 'power') state.enemySortMode = data.enemySortMode;
      if (data.nativeTroopsSortMode === 'energy' || data.nativeTroopsSortMode === 'power') state.nativeTroopsSortMode = data.nativeTroopsSortMode;
      else state.nativeTroopsSortMode = state.enemySortMode;
      if (typeof data.useResurrectItem === 'boolean') CFG.useResurrectItem = data.useResurrectItem;
      if (typeof data.autoMarchSaltPan === 'boolean') CFG.autoMarchSaltPan = data.autoMarchSaltPan;
      if (data.panelPos && Number.isFinite(Number(data.panelPos.x)) && Number.isFinite(Number(data.panelPos.y))) {
        state.panelPos = { x: Number(data.panelPos.x), y: Number(data.panelPos.y) };
      }
      state.savedAt = Number(data.savedAt || 0);
      log('盐场设置已读取', data);
      return true;
    } catch (e) {
      logError('读取盐场设置失败', e);
      return false;
    }
  }

  function ensureGameAutoAttack(lw) {
    if (!CFG.autoEnableGameAutoAttack || !lw) return false;
    if (lw.isAutoAttack === true) return false;
    lw.isAutoAttack = true;
    state.stats.autoAttackSwitch += 1;
    log('已打开游戏内军团战自动攻击');
    return true;
  }
  function formatSeconds(msOrTime) {
    const t = Number(msOrTime || 0);
    const left = t > Date.now() ? Math.max(0, t - now()) : Math.max(0, t);
    const sec = Math.ceil(left / 1000);
    if (sec <= 0) return '0s';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m${s}s` : `${s}s`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function ensureUI() {
    if (!CFG.showUI || typeof document === 'undefined') return null;
    let root = document.getElementById('salt-field-auto-panel');
    if (root) return root;

    const style = document.createElement('style');
    style.id = 'salt-field-auto-style';
    style.textContent = `
#salt-field-auto-panel{position:fixed;right:12px;top:72px;z-index:999999;width:380px;max-height:78vh;background:rgba(18,22,28,.94);color:#f5f7fb;border:1px solid rgba(255,255,255,.16);border-radius:8px;font:12px/1.35 Arial,'Microsoft YaHei',sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.35);overflow:hidden}
#salt-field-auto-panel.sfa-collapsed{width:58px;height:58px;max-height:58px;border-radius:50%;background:rgba(20,28,38,.92);border-color:rgba(96,165,250,.55);box-shadow:0 8px 22px rgba(0,0,0,.35);cursor:move}
#salt-field-auto-panel *{box-sizing:border-box}
.sfa-head{height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;background:#202833;border-bottom:1px solid rgba(255,255,255,.12);cursor:move}
.sfa-collapsed .sfa-head{height:58px;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center}
.sfa-collapsed .sfa-head>div:first-child{display:none}.sfa-collapsed .sfa-body{display:none!important}
.sfa-icon-btn{width:48px;height:48px;border-radius:50%;border:1px solid rgba(255,255,255,.28);background:radial-gradient(circle at 35% 25%,#e0f2fe 0 15%,#38bdf8 16% 34%,#2563eb 35% 68%,#1e293b 69%);position:relative;box-shadow:inset 0 0 0 2px rgba(255,255,255,.08);cursor:pointer;font-size:0}
.sfa-icon-btn:before{content:'';position:absolute;left:13px;top:17px;width:22px;height:16px;background:linear-gradient(135deg,#fff 0 35%,#bae6fd 36% 62%,#60a5fa 63%);clip-path:polygon(50% 0,100% 100%,0 100%);filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))}
.sfa-icon-btn:after{content:'盐';position:absolute;right:4px;bottom:3px;width:18px;height:18px;border-radius:50%;background:rgba(15,23,42,.82);color:#fff;font-size:12px;line-height:18px;text-align:center;font-weight:700}
.sfa-title{font-weight:700;font-size:13px}.sfa-sub{color:#aeb7c5;margin-left:6px;font-weight:400}.sfa-body{padding:10px;display:grid;gap:8px;max-height:calc(78vh - 34px);overflow:auto}.sfa-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.sfa-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sfa-box{border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:8px;background:rgba(255,255,255,.04);min-width:0}.sfa-box h4{margin:0 0 6px;font-size:12px;color:#dce6f3}.sfa-btn{border:1px solid rgba(255,255,255,.18);background:#2d3948;color:#fff;border-radius:5px;height:26px;padding:0 8px;cursor:pointer}.sfa-btn:hover{background:#3b4a5d}.sfa-btn.primary{background:#2563eb;border-color:#3b82f6}.sfa-btn.warn{background:#8a2f2f;border-color:#b84a4a}.sfa-btn:disabled{opacity:.45;cursor:not-allowed}.sfa-list{display:grid;gap:4px;max-height:180px;overflow:auto}.sfa-item{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;padding:5px 6px;border:1px solid rgba(255,255,255,.1);border-radius:5px;background:rgba(0,0,0,.14)}.sfa-item.sel{border-color:#60a5fa;background:rgba(37,99,235,.18)}.sfa-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sfa-meta{color:#aeb7c5;font-size:11px}.sfa-pill{display:inline-block;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:1px 6px;margin-right:4px;color:#cbd5e1}.sfa-enemy-actions{display:flex;gap:4px;align-items:center;justify-content:flex-end;flex-wrap:wrap;max-width:210px}.sfa-input{width:100%;height:26px;border:1px solid rgba(255,255,255,.16);background:#111827;color:#fff;border-radius:5px;padding:0 6px}.sfa-muted{color:#98a2b3}.sfa-hidden{display:none!important}`;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'salt-field-auto-panel';
    root.innerHTML = '<div class="sfa-head"><div><span class="sfa-title">盐场助手</span><span class="sfa-sub">LEGION_WAR</span></div><div><button class="sfa-btn" data-act="toggle">收起</button></div></div><div class="sfa-body"></div>';
    if (state.panelPos) {
      root.style.left = `${state.panelPos.x}px`;
      root.style.top = `${state.panelPos.y}px`;
      root.style.right = 'auto';
    }
    document.body.appendChild(root);

    root.addEventListener('mousedown', (ev) => {
      const head = ev.target.closest('.sfa-head');
      if (!head) return;
      if (ev.target.closest('button') && !root.classList.contains('sfa-collapsed')) return;
      const rect = root.getBoundingClientRect();
      const offsetX = ev.clientX - rect.left;
      const offsetY = ev.clientY - rect.top;
      state.draggingPanel = false;
      const onMove = (moveEv) => {
        state.draggingPanel = true;
        const width = root.offsetWidth || rect.width;
        const height = root.offsetHeight || rect.height;
        const x = Math.max(0, Math.min(window.innerWidth - width, moveEv.clientX - offsetX));
        const y = Math.max(0, Math.min(window.innerHeight - height, moveEv.clientY - offsetY));
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
        root.style.right = 'auto';
        state.panelPos = { x, y };
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (state.draggingPanel && state.panelPos) saveSettings();
        setTimeout(() => {
          state.draggingPanel = false;
        }, 0);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    root.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      if (state.draggingPanel) return;
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if (act === 'toggle') {
        state.uiCollapsed = !state.uiCollapsed;
        renderUI();
      } else if (act === 'start') {
        state.running = true;
      } else if (act === 'saveSettings') {
        saveSettings();
      } else if (act === 'toggleResurrectItem') {
        CFG.useResurrectItem = !CFG.useResurrectItem;
      } else if (act === 'toggleAutoMarch') {
        CFG.autoMarchSaltPan = !CFG.autoMarchSaltPan;
      } else if (act === 'toggleSandbox') {
        CFG.sandbox = !CFG.sandbox;
        if (!CFG.sandbox) resetSandboxData();
        else enterLocalSandboxMap();
      } else if (act === 'enterSandboxMap') {
        enterLocalSandboxMap();
      } else if (act === 'enterNativeSandboxMap') {
        CFG.sandbox = true;
        state.sandboxMapVisible = true;
        ensureSandboxData();
        log('准备进入原生灰岩岛实验地图：如果页面卡住，刷新页面后使用普通沙盒地图');
        enterNativeSandboxMap().catch((e) => {
          logError('进入原生伟大航路灰岩岛地图失败，已退回本地沙盒', e);
          enterLocalSandboxMap();
        });
      } else if (act === 'resetSandbox') {
        resetSandboxData();
        if (CFG.sandbox) enterLocalSandboxMap();
      } else if (act === 'toggleEnemyFilter') {
        if (state.enemyFilters.has(id)) state.enemyFilters.delete(id);
        else state.enemyFilters.add(id);
      } else if (act === 'selectEnemy') {
        state.selectedEnemyId = String(id || '');
      } else if (act === 'sortEnemiesEnergy') {
        state.enemySortMode = 'energy';
        state.nativeTroopsSortMode = 'energy';
        state.enemyTargets = sortEnemyTargets(state.enemyTargets);
      } else if (act === 'sortEnemiesPower') {
        state.enemySortMode = 'power';
        state.nativeTroopsSortMode = 'power';
        state.enemyTargets = sortEnemyTargets(state.enemyTargets);
      } else if (act === 'clearLockedEnemy') {
        state.lockedEnemyId = null;
      } else if (act === 'refreshEnemies') {
        await refreshEnemyTargets(true);
      } else if (act === 'attackSelectedEnemy') {
        const lw = getLegionWarModule();
        const bf = getBattlefield(lw);
        await attackEnemyById(lw, bf, getSelf(bf), state.selectedEnemyId, now(), 'selected');
      } else if (act === 'attackEnemyRow') {
        state.selectedEnemyId = String(id || '');
        const lw = getLegionWarModule();
        const bf = getBattlefield(lw);
        await attackEnemyById(lw, bf, getSelf(bf), state.selectedEnemyId, now(), 'selected');
      } else if (act === 'lockAttackEnemy') {
        if (state.selectedEnemyId) state.lockedEnemyId = String(state.selectedEnemyId);
        const lw = getLegionWarModule();
        const bf = getBattlefield(lw);
        await attackEnemyById(lw, bf, getSelf(bf), state.lockedEnemyId, now(), 'locked');
      } else if (act === 'refreshMembers') {
        await refreshClubMembers(getLegionWarModule());
      } else if (act === 'stop') {
        state.running = false;
      } else if (act === 'selectBuilding') {
        state.selectedBuildingId = id;
      } else if (act === 'goBuilding') {
        await moveSelectedBuilding();
      } else if (act === 'attackBuilding') {
        const lw = getLegionWarModule();
        const bf = getBattlefield(lw);
        await attackCurrentBuilding(lw, bf, getSelf(bf), 0);
      } else if (act === 'speedUp') {
        const lw = getLegionWarModule();
        const bf = getBattlefield(lw);
        await speedUpSelfMarch(lw, bf, getSelf(bf));
      } else if (act === 'invite') {
        await invitePlayer(id, false);
      } else if (act === 'lockInvite') {
        state.lockedInviteIds.add(String(id));
        state.rejectedInviteIds.delete(String(id));
      } else if (act === 'unlockInvite') {
        state.lockedInviteIds.delete(String(id));
      } else if (act === 'clearRejected') {
        state.rejectedInviteIds.clear();
      } else if (act === 'kick') {
        await kickPlayer(id);
      } else if (act === 'leaveTeam') {
        await leaveTeam();
      } else if (act === 'teamUp') {
        await moveTeamPlayer(id, -1);
      } else if (act === 'teamDown') {
        await moveTeamPlayer(id, 1);
      } else if (act === 'followMember') {
        state.followMemberId = String(id);
        CFG.autoMarchSaltPan = false;
        log('已选择跟随成员，自动寻盐田/自动行军已关闭');
      } else if (act === 'unfollowMember') {
        state.followMemberId = null;
      } else if (act === 'refresh') {
        const lw = getLegionWarModule();
        await refreshBattlefieldInfo(lw, 0);
      }
      renderUI();
    });

    return root;
  }

  function renderUI() {
    patchNativeTroopsFormationTags();
    const root = ensureUI();
    if (!root) return;
    const oldMemberList = root.querySelector('.sfa-member-list');
    const memberScrollTop = oldMemberList ? oldMemberList.scrollTop : 0;
    const oldEnemyList = root.querySelector('.sfa-enemy-list');
    const enemyScrollTop = oldEnemyList ? oldEnemyList.scrollTop : 0;
    const body = root.querySelector('.sfa-body');
    const toggle = root.querySelector('[data-act="toggle"]');
    if (state.uiCollapsed) {
      root.classList.add('sfa-collapsed');
      body.classList.add('sfa-hidden');
      toggle.className = 'sfa-icon-btn';
      toggle.textContent = '展开盐场助手';
      toggle.title = '展开盐场助手';
      return;
    }
    root.classList.remove('sfa-collapsed');
    body.classList.remove('sfa-hidden');
    toggle.className = 'sfa-btn';
    toggle.textContent = '收起';
    toggle.title = '收起';

    const lw = getLegionWarModule();
    const bf = getBattlefield(lw);
    const self = getSelf(bf);
    const selected = getSelectedBuilding(bf, self);
    if (selected && !state.selectedBuildingId) state.selectedBuildingId = selected.id;
    const buildings = listBuildings(bf)
      .filter((b) => b && (isSaltPan(b) || !b.isOur))
      .map((b) => buildingInfo(b, self))
      .sort((a, b) => Number(b.isSaltPan) - Number(a.isSaltPan) || (a.pathLen || 9999) - (b.pathLen || 9999) || (a.distance || 9999) - (b.distance || 9999))
      .slice(0, 18);
    const teamPlayers = listTeamPlayers(bf, self).map(playerInfo);
    const inviteList = listClubMembers(lw, bf, self).slice(0, 60);
    const enemyList = sortEnemyTargets((state.enemyTargets.length ? state.enemyTargets : collectEnemyCandidates(bf, self)).filter(enemyMatchesFilters)).slice(0, 60);
    const selfInfo = playerInfo(self);
    const canSpeed = !!self && isMarching(self) && !!self.marchId;
    const savedText = state.savedAt ? new Date(state.savedAt).toLocaleTimeString() : '未保存';
    const selectedInfo = selected ? buildingInfo(selected, self) : null;
    const reviveLeft = isDead(self) ? getReviveLeftSeconds(self) : 0;
    const reviveTimesLeft = getReviveTimesLeft(lw, self);
    const resurrectItemCount = getResurrectItemCount(lw, self);

    const buildingHtml = buildings.map((b) => `
      <div class="sfa-item ${String(b.id) === String(state.selectedBuildingId) ? 'sel' : ''}">
        <div><div class="sfa-name">${escapeHtml(b.name || b.id)} ${b.isSaltPan ? '<span class="sfa-pill">盐田</span>' : ''}</div><div class="sfa-meta">坐标 ${posKey(b.position)} | 距离 ${b.distance ?? '-'} | 路径 ${b.pathLen} | ${b.canMove ? '可行军' : b.inMarchList ? '行军中' : '不可行军'}</div></div>
        <button class="sfa-btn" data-act="selectBuilding" data-id="${escapeHtml(b.id)}">选择</button>
      </div>`).join('') || '<div class="sfa-muted">暂无建筑数据</div>';

    const teamHtml = teamPlayers.map((p, idx) => {
      const following = String(state.followMemberId || '') === String(p.id);
      const canOperateFollow = !selfInfo.hasTeam || selfInfo.isLeader;
      return `
      <div class="sfa-item ${following ? 'sel' : ''}">
        <div><div class="sfa-name">${escapeHtml(p.name || p.id)} ${p.isLeader ? '<span class="sfa-pill">队长</span>' : ''} ${p.isMe ? '<span class="sfa-pill">我</span>' : ''} ${following ? '<span class="sfa-pill">跟随</span>' : ''}</div><div class="sfa-meta">状态 ${escapeHtml(p.state)} | 坐标 ${posKey(p.position)}</div></div>
        <div class="sfa-row">
          ${selfInfo.isLeader ? `<button class="sfa-btn" data-act="teamUp" data-id="${escapeHtml(p.id)}" ${idx <= 0 ? 'disabled' : ''}>上移</button><button class="sfa-btn" data-act="teamDown" data-id="${escapeHtml(p.id)}" ${idx >= teamPlayers.length - 1 ? 'disabled' : ''}>下移</button>` : ''}
          ${!p.isMe ? `<button class="sfa-btn ${following ? 'warn' : ''}" data-act="${following ? 'unfollowMember' : 'followMember'}" data-id="${escapeHtml(p.id)}" ${canOperateFollow ? '' : 'disabled'}>${following ? '取消跟随' : '跟随'}</button>` : ''}${selfInfo.isLeader && !p.isMe ? `<button class="sfa-btn warn" data-act="kick" data-id="${escapeHtml(p.id)}">踢出</button>` : ''}
        </div>
      </div>`;
    }).join('') || '<div class="sfa-muted">暂无队伍数据</div>';

    const inviteHtml = inviteList.map((p) => {
      const id = String(getPlayerId(p));
      const locked = state.lockedInviteIds.has(id) || hasLockedMember(p);
      const rejected = state.rejectedInviteIds.has(id);
      const following = String(state.followMemberId || '') === id || isSameMemberId(p, state.followMemberId);
      const canOperateFollow = !selfInfo.hasTeam || selfInfo.isLeader;
      const canInviteNow = !!bf && !!self && id && !p.inTeam && !(p.inviteTime || rejected);
      return `
      <div class="sfa-item ${locked ? 'sel' : ''}">
        <div><div class="sfa-name">${escapeHtml(p.name || id)} ${locked ? '<span class="sfa-pill">锁定组队</span>' : ''} ${following ? '<span class="sfa-pill">跟随目标</span>' : ''} ${p.inTeam ? '<span class="sfa-pill">已入队</span>' : ''} ${rejected ? '<span class="sfa-pill">已拒绝</span>' : ''}</div><div class="sfa-meta">来源 ${escapeHtml(p.source || '-')} | 战力 ${escapeHtml(Number.abridge ? Number.abridge(p.power || 0) : p.power || 0)} ${p.inviteTime ? '| 拒绝冷却 ' + escapeHtml(p.inviteTime) + 's' : ''}</div></div>
        <div class="sfa-row">
          <button class="sfa-btn" data-act="invite" data-id="${escapeHtml(id)}" ${canInviteNow ? '' : 'disabled'}>邀请</button>
          <button class="sfa-btn ${locked ? 'warn' : ''}" data-act="${locked ? 'unlockInvite' : 'lockInvite'}" data-id="${escapeHtml(id)}">${locked ? '解锁' : '锁定'}</button>
          <button class="sfa-btn ${following ? 'warn' : ''}" data-act="${following ? 'unfollowMember' : 'followMember'}" data-id="${escapeHtml(id)}" ${canOperateFollow ? '' : 'disabled'}>${following ? '取消跟随' : '跟随'}</button>
        </div>
      </div>`;
    }).join('') || '<div class="sfa-muted">暂无可邀请成员</div>';

    const enemyFilterHtml = ENEMY_FILTERS.map((name) => {
      const checked = state.enemyFilters.has(name);
      return `<button class="sfa-btn ${checked ? 'primary' : ''}" data-act="toggleEnemyFilter" data-id="${escapeHtml(name)}">${checked ? '✓' : ''}${escapeHtml(name)}</button>`;
    }).join('');
    const enemyHtml = enemyList.map((enemy) => {
      const selectedEnemy = String(state.selectedEnemyId || '') === String(enemy.id);
      const lockedEnemy = String(state.lockedEnemyId || '') === String(enemy.id);
      const labelHtml = (enemy.formationLabels || ['未知']).map((label) => `<span class="sfa-pill">${escapeHtml(label)}</span>`).join('');
      return `
      <div class="sfa-item ${selectedEnemy || lockedEnemy ? 'sel' : ''}">
        <div><div class="sfa-name">${escapeHtml(enemy.name || enemy.id)} ${lockedEnemy ? '<span class="sfa-pill">锁定</span>' : ''}</div><div class="sfa-meta">战力 ${escapeHtml(Number.abridge ? Number.abridge(enemy.power || 0) : enemy.power || 0)} | 精力 ${escapeHtml(enemyEnergy(enemy) || '-')} | 建筑 ${escapeHtml(enemy.buildingName || enemy.buildingId || '-')}</div></div>
        <div class="sfa-enemy-actions">${labelHtml}<button class="sfa-btn ${selectedEnemy ? 'primary' : ''}" data-act="attackEnemyRow" data-id="${escapeHtml(enemy.id)}">开战</button></div>
      </div>`;
    }).join('') || '<div class="sfa-muted">暂无敌人数据，进战场后点刷新</div>';
    body.innerHTML = `
      <div class="sfa-row">
        <button class="sfa-btn ${state.running ? '' : 'primary'}" data-act="start">启动</button>
        <button class="sfa-btn ${state.running ? 'warn' : ''}" data-act="stop">暂停</button>
        <button class="sfa-btn" data-act="refresh">刷新战场</button>
        <button class="sfa-btn" data-act="refreshMembers">读取成员</button>
        <button class="sfa-btn primary" data-act="saveSettings">保存</button>
        <button class="sfa-btn ${CFG.sandbox && state.sandboxMapVisible ? 'primary' : ''}" data-act="enterSandboxMap">${CFG.sandbox && state.sandboxMapVisible ? '已进沙盒地图' : '进入沙盒地图'}</button>
        <button class="sfa-btn warn" data-act="enterNativeSandboxMap">原生灰岩岛(实验)</button>
        <button class="sfa-btn ${CFG.sandbox ? 'warn' : ''}" data-act="toggleSandbox">${CFG.sandbox ? '退出沙盒' : '只开沙盒数据'}</button>
        <button class="sfa-btn" data-act="resetSandbox" ${CFG.sandbox ? '' : 'disabled'}>重置沙盒</button>
        <span class="sfa-muted">${state.running ? '运行中' : '已暂停'} | ${escapeHtml(posKey(self?.position) || '未进战场')} | 状态 ${escapeHtml(roleState(self) ?? '-')} | 复活 ${reviveLeft > 0 ? reviveLeft + 's' : '-'} | 免费次数 ${reviveTimesLeft} | 复活丹 ${resurrectItemCount} | 流程 ${escapeHtml(state.workflowStatus || '-')} | 保存 ${savedText}</span>
      </div>
      ${CFG.sandbox ? '<div class="sfa-muted">当前为沙盒盐场：只模拟本地数据，不连接真实盐场服务器。</div>' : ''}
      <div class="sfa-row">
        <button class="sfa-btn ${CFG.useResurrectItem ? 'primary' : ''}" data-act="toggleResurrectItem">${CFG.useResurrectItem ? '已开' : '关闭'} 使用复活丹</button>
        <button class="sfa-btn ${CFG.autoMarchSaltPan ? 'primary' : ''}" data-act="toggleAutoMarch">${CFG.autoMarchSaltPan ? '已开' : '关闭'} 自动寻盐田/自动行军</button>
        <span class="sfa-muted">选择跟随后会自动关闭自动行军；关闭复活丹时死亡只等倒计时。</span>
      </div>
      <div class="sfa-box">
        <h4>选中建筑</h4>
        ${selectedInfo ? `<div class="sfa-meta">${escapeHtml(selectedInfo.name || selectedInfo.id)} | 坐标 ${posKey(selectedInfo.position)} | 距离 ${selectedInfo.distance} | 路径 ${selectedInfo.pathLen}</div><div class="sfa-meta">${selectedInfo.inMarchList ? '正在前往该建筑，可加速' : selectedInfo.inBuilding ? '已在建筑内' : selectedInfo.canMove ? '可行军' : '当前不可行军'} | ${selectedInfo.canAttack ? '可攻击建筑' : '不可攻击建筑'}</div>` : '<div class="sfa-muted">未选择建筑</div>'}
        <div class="sfa-row" style="margin-top:6px">
          <button class="sfa-btn primary" data-act="goBuilding" ${selectedInfo ? '' : 'disabled'}>${selectedInfo?.inMarchList ? '加速前往' : selectedInfo?.inBuilding ? '处理当前建筑' : '行军到这里'}</button>
          <button class="sfa-btn" data-act="attackBuilding" ${selectedInfo?.canAttack ? '' : 'disabled'}>攻击建筑</button>
          <button class="sfa-btn" data-act="speedUp" ${canSpeed ? '' : 'disabled'}>行军加速</button>
          <span class="sfa-muted">${canSpeed ? '剩余 ' + formatSeconds(self.endMarchTime) : '未行军'}</span>
        </div>
      </div>
      <div class="sfa-grid">
        <div class="sfa-box"><h4>建筑列表</h4><div class="sfa-list">${buildingHtml}</div></div>
        <div class="sfa-box"><h4>组队</h4><div class="sfa-row" style="margin-bottom:6px"><button class="sfa-btn warn" data-act="leaveTeam" ${selfInfo.hasTeam && !selfInfo.isLeader ? '' : 'disabled'}>离队</button><span class="sfa-muted">成员 ${teamPlayers.length}/5 | 跟随 ${state.followMemberId || '无'}</span></div><div class="sfa-list">${teamHtml}</div></div>
      </div>
      <div class="sfa-box"><h4>盐场选敌</h4>
        <div class="sfa-row" style="margin-bottom:6px">${enemyFilterHtml}</div>
        <div class="sfa-row" style="margin-bottom:6px"><button class="sfa-btn ${state.enemySortMode === 'energy' ? 'primary' : ''}" data-act="sortEnemiesEnergy">精力降序</button><button class="sfa-btn ${state.enemySortMode === 'power' ? 'primary' : ''}" data-act="sortEnemiesPower">战力降序</button><span class="sfa-muted">当前 ${state.enemySortMode === 'energy' ? '精力降序' : '战力降序'}</span></div>
        <div class="sfa-row" style="margin-bottom:6px">
          <button class="sfa-btn" data-act="refreshEnemies" ${state.enemyRefreshing ? 'disabled' : ''}>${state.enemyRefreshing ? '刷新中' : '刷新'}</button>
          <button class="sfa-btn primary" data-act="lockAttackEnemy" ${state.selectedEnemyId ? '' : 'disabled'}>锁定开战</button>
          <button class="sfa-btn" data-act="attackSelectedEnemy" ${state.selectedEnemyId ? '' : 'disabled'}>选中开战</button>
          <button class="sfa-btn warn" data-act="clearLockedEnemy" ${state.lockedEnemyId ? '' : 'disabled'}>取消锁定</button>
          <span class="sfa-muted">选中 ${state.selectedEnemyId || '无'} | 锁定 ${state.lockedEnemyId || '无'}</span>
        </div>
        <div class="sfa-list sfa-enemy-list">${enemyHtml}</div>
      </div>
      <div class="sfa-box"><h4>俱乐部成员</h4><div class="sfa-row" style="margin-bottom:6px"><span class="sfa-muted">锁定组队 ${state.lockedInviteIds.size} | 跟随 ${state.followMemberId || '无'} | 拒绝 ${state.rejectedInviteIds.size}</span><button class="sfa-btn" data-act="clearRejected" ${state.rejectedInviteIds.size ? '' : 'disabled'}>清空拒绝</button></div><div class="sfa-list sfa-member-list">${inviteHtml}</div></div>
      <div class="sfa-muted">统计：行军 ${state.stats.march} | 跟随 ${state.stats.followMarch} | 加速 ${state.stats.speedUp} | 金砖 ${state.stats.speedUpDiamond} | 邀请 ${state.stats.invite} | 敌人刷新 ${state.stats.refreshEnemy} | 锁定攻击 ${state.stats.attackLockedEnemy} | 等复活 ${state.stats.waitRevive} | 拒绝 ${state.stats.rejectedInvite} | 调位 ${state.stats.changePos} | 错误 ${state.stats.errors}</div>
    `;
    const newMemberList = root.querySelector('.sfa-member-list');
    if (newMemberList) newMemberList.scrollTop = memberScrollTop;
    const newEnemyList = root.querySelector('.sfa-enemy-list');
    if (newEnemyList) newEnemyList.scrollTop = enemyScrollTop;
    renderSandboxMap();
  }
  function printStatus(lw, bf, self, t) {
    if (!CFG.verbose && t - state.lastLog < CFG.logEveryMs) return;
    state.lastLog = t;
    const current = findCurrentBuilding(bf, self);
    const target = findBestTargetBuilding(bf, self);
    logVerbose('状态', {
      battlefieldId: bf?.id,
      selfPos: posKey(self?.position),
      selfState: roleState(self),
      currentBuilding: current ? buildingInfo(current, self) : null,
      nearestTarget: target ? buildingInfo(target.b, self) : null,
    });
  }

  async function tick() {
    if (!state.running) return;
    try {
      const lw = getLegionWarModule();
      if (!lw) return;

      const t = now();
      let bf = getBattlefield(lw);
      let self = getSelf(bf);

      if (!bf || !self) {
        setWorkflowStatus('等待进入战场');
        await enterBattlefield(lw, t);
        return;
      }

      if (state.lastBattlefieldId !== bf.id) {
        state.lastBattlefieldId = bf.id;
        state.wasDead = false;
        state.currentTarget = null;
        log('检测到盐场战场', bf.id);
      }

      await refreshBattlefieldInfo(lw, t);
      bf = getBattlefield(lw) || bf;
      self = getSelf(bf) || self;
      if (state.lockedEnemyId || state.enemyFilters.size) await refreshEnemyTargets(false);

      printStatus(lw, bf, self, t);
      renderUI();

      if (isDead(self)) {
        state.wasDead = true;
        setWorkflowStatus('死亡/复活中');
        await resurrect(lw, self, t);
        return;
      }

      if (isMarching(self)) {
        setWorkflowStatus('行军中，自动加速');
        await speedUpSelfMarch(lw, bf, self, false);
        return;
      }

      if (state.wasDead) {
        state.wasDead = false;
        await deployOnce(lw, bf, '复活后', t, true);
      }

      if (!state.deployedInBattlefield.has(bf.id)) {
        setWorkflowStatus('布阵中');
        await deployOnce(lw, bf, '进入战场后', t, true);
        return;
      }

      setWorkflowStatus('组队中');
      await autoInviteLockedMembers(lw, bf, self, t);
      if (!areLockedMembersInTeam(bf, self)) {
        state.currentTarget = { type: 'waitTeam', lockedInviteIds: lockedInviteIds(), teamPlayers: listTeamPlayers(bf, self).map(playerInfo) };
        setWorkflowStatus('等待锁定成员入队');
        return;
      }

      ensureGameAutoAttack(lw);

      if (state.followMemberId && CFG.waitFollowTargetAction && !isFollowTargetActionReady(bf, self)) {
        state.currentTarget = { type: 'waitFollowTarget', followMemberId: state.followMemberId };
        setWorkflowStatus('等待跟随目标行动');
        return;
      }

      setWorkflowStatus('执行战场动作');
      if (await followSelectedMember(lw, bf, self, t)) return;
      const stayingWithFollowTarget = isAtFollowTargetBuilding(bf, self);
      if (await attackLockedEnemy(lw, bf, self, t)) return;
      if (await attackCurrentBuilding(lw, bf, self, t)) return;
      if (await attackEnemy(lw, bf, self, t)) return;
      if (stayingWithFollowTarget) {
        state.currentTarget = { type: 'stayWithFollowTarget', followMemberId: state.followMemberId, building: buildingInfo(findCurrentBuilding(bf, self), self) };
        setWorkflowStatus('已跟随到目标，等待目标行动');
        return;
      }
      await marchToSaltPan(lw, bf, self, t);
    } catch (e) {
      logError('主循环异常', e?.stack || e?.message || e);
      if (state.stats.errors >= 30) {
        state.running = false;
        logError('错误次数过多，脚本已暂停');
      }
    }
  }

  loadSettings();

  const timer = setInterval(tick, CFG.tickMs);
  const uiTimer = setInterval(renderUI, CFG.uiRefreshMs);
  ensureUI();
  patchNativeTroopsFormationTags();
  renderUI();

  window.__SALT_FIELD_AUTO__ = {
    start() {
      state.running = true;
      state.stats.errors = 0;
      log('脚本已启动');
    },
    stop() {
      state.running = false;
      log('脚本已暂停');
    },
    stopTimer() {
      clearInterval(timer);
      clearInterval(uiTimer);
      state.running = false;
      log('定时器已停止');
    },
    setConfig(key, value) {
      if (Object.prototype.hasOwnProperty.call(CFG, key)) {
        CFG[key] = value;
        log('配置已更新', key, value);
      } else {
        logError('未知配置项', key);
      }
    },
    getStats() {
      const lw = getLegionWarModule();
      const bf = getBattlefield(lw);
      const self = getSelf(bf);
      const current = findCurrentBuilding(bf, self);
      const target = bf && self ? findBestTargetBuilding(bf, self) : null;
      return {
        running: state.running,
        battlefieldId: bf?.id || null,
        selfPos: posKey(self?.position),
        selfState: roleState(self),
        isDeadOrReviving: !!self && isDead(self),
        isMarching: !!self && isMarching(self),
        isFighting: !!self && isFighting(self),
        currentBuilding: current ? buildingInfo(current, self) : null,
        currentTarget: state.currentTarget,
        recommendedTarget: target ? buildingInfo(target.b, self) : null,
        stats: { ...state.stats },
        lastError: state.lastError,
      };
    },
    listBuildings() {
      const lw = getLegionWarModule();
      const bf = getBattlefield(lw);
      const self = getSelf(bf);
      return listBuildings(bf)
        .map((building) => buildingInfo(building, self))
        .sort((a, b) => Number(b.isSaltPan) - Number(a.isSaltPan) || (a.pathLen || 9999) - (b.pathLen || 9999) || (a.distance || 9999) - (b.distance || 9999));
    },
    debug: {
      getLegionWarModule,
      getBattlefield() {
        return getBattlefield(getLegionWarModule());
      },
      deployNow() {
        const lw = getLegionWarModule();
        return deployOnce(lw, getBattlefield(lw), '鎵嬪姩', 0);
      },
      attackNow() {
        const lw = getLegionWarModule();
        const bf = getBattlefield(lw);
        return attackCurrentBuilding(lw, bf, getSelf(bf), 0);
      },
      marchNow() {
        const lw = getLegionWarModule();
        const bf = getBattlefield(lw);
        return marchToSaltPan(lw, bf, getSelf(bf), 0);
      },
      speedUpNow() {
        const lw = getLegionWarModule();
        const bf = getBattlefield(lw);
        return speedUpSelfMarch(lw, bf, getSelf(bf), true);
      },
      invite(playerId) {
        return invitePlayer(playerId, false);
      },
      lockInvite(playerId) {
        state.lockedInviteIds.add(String(playerId));
        state.rejectedInviteIds.delete(String(playerId));
      },
      unlockInvite(playerId) {
        state.lockedInviteIds.delete(String(playerId));
      },
      followMember(playerId) {
        state.followMemberId = String(playerId);
      },
      unfollowMember() {
        state.followMemberId = null;
      },
      kick(playerId) {
        return kickPlayer(playerId);
      },
      leaveTeam,
      moveTeamPlayer,
      renderUI,
    },
    sandbox: {
      start() {
        enterLocalSandboxMap();
        log('沙盒盐场已开启');
      },
      stop() {
        CFG.sandbox = false;
        resetSandboxData();
        renderUI();
        log('沙盒盐场已关闭');
      },
      reset() {
        resetSandboxData();
        if (CFG.sandbox) enterLocalSandboxMap();
        renderUI();
      },
      enterMap() {
        enterLocalSandboxMap();
      },
      enterNativeMap() {
        CFG.sandbox = true;
        state.sandboxMapVisible = true;
        ensureSandboxData();
        return enterNativeSandboxMap().catch((e) => {
          logError('进入原生伟大航路灰岩岛地图失败，已退回本地沙盒', e);
          enterLocalSandboxMap();
          return false;
        });
      },
      closeMap() {
        state.sandboxMapVisible = false;
        removeSandboxMap();
        renderUI();
      },
      getData() {
        return ensureSandboxData();
      },
    },
  };

  log('伟大航路盐场自动化已加载');
  log('控制接口：window.__SALT_FIELD_AUTO__');
})();
