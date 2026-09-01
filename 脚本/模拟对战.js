// ==UserScript==
// @name         战斗模拟
// @namespace    clf-local
// @version      0.1.1
// @description  咸将塔、怪异塔、灯神、深海灯神、十殿试炼、星级挑战等非PVP玩法的模拟、回放与多种子胜率比较
// @match        *://*/*
// @match        file:///*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.__NON_PVP_SIMULATOR__) {
        return;
    }

    const SCRIPT_NAME = '战斗模拟';
    const SCRIPT_VERSION = '0.1.1';

    const CAPABILITY = {
        PREVIEW: '预模拟',
        HYBRID: '即时模拟',
        REPLAY: '仅回放',
        NONE: '不可用',
    };

    const MODE_LABELS = {
        tower: '咸将塔',
        genie: '灯神',
        evoTower: '怪异塔',
        legionBoss: '俱乐部Boss',
        nightmare: '十殿试炼',
        nightmareStar: '星级挑战',
        capture: '最近战斗',
    };

    const STORAGE_KEYS = {
        candidates: '__non_pvp_sim_candidates__',
        panelState: '__non_pvp_sim_panel_state__',
        reusableSkeleton: '__non_pvp_sim_reusable_skeleton__',
    };

    const DEFAULT_SAMPLE_COUNT = 1000;
    const MAX_SAMPLE_COUNT = 99999;
    const SEED_RECORD_PAGE_SIZE = 15;
    const MAIN_PUSH_LOG_LIMIT = 60;
    const MAIN_PUSH_RESET_DELAY_MS = 300;

    const DIAGNOSTIC_SAMPLE_LIMIT = 24;
    const QUICK_TARGET_SELECT_LIMIT = 120;
    const STARTUP_RUNTIME_DELAY_MS = 12000;
    const STARTUP_LEVEL_CAPTURE_INTERVAL_MS = 2000;
    const STARTUP_LEVEL_CAPTURE_MAX_TRIES = 15;

    const DEFAULT_PANEL_PREFS = {
        collapsed: true,
        debugExpanded: false,
        panelX: null,
        panelY: null,
        modeChoice: 'auto',
        targetValue: '',
        targetMajor: '',
        targetMinor: '',
        sampleCount: `${DEFAULT_SAMPLE_COUNT}`,
        seedSort: 'default',
    };

    const PVP_MODE_NAMES = new Set([
        'pvp',
        'arena',
        'areaArena',
        'challengeMatch',
        'skyHorsePvp',
        'tournament',
        'crossArena',
        'leagueWar',
        'legionWar',
        'legionPayload',
        'quiz',
    ]);

    const state = {
        inited: false,
        runtimePatched: false,
        latestCapture: null,
        stopRequested: false,
        activeJob: null,
        lastReport: null,
        lastReports: [],
        lastSingleRun: null,
        lastDebugError: null,
        panel: null,
        manualTargetOptions: {},
        modeCaches: {
            tower: null,
            genie: null,
            evoTower: null,
            legionBoss: null,
            nightmare: null,
            nightmareStar: null,
        },
        candidates: [],
        diagnosticSamples: [],
        dataSourceLines: [],
        panelPrefs: Object.assign({}, DEFAULT_PANEL_PREFS),
        lastKnownSignature: '-',
        reusableSkeleton: null,
        reusableSkeletonMeta: null,
        runtimeReady: false,
        runtimeActivating: false,
        runtimeDelayedUntil: 0,
        startupCaptureTimer: null,
        playbackBattleVisibleDepth: 0,
        playbackRestoreTimer: null,
        playbackHiddenProxyStates: [],
        playbackHiddenLayerStates: [],
        playbackBackdropState: null,
        nightmareReplayScene: null,
        debugSeedCursorMap: Object.create(null),
        seedBatchCursorMap: Object.create(null),
        languageTextCache: Object.create(null),
        monsterConfigCache: Object.create(null),
        monsterNameCache: Object.create(null),
        panelDragState: null,
        suppressCollapseClick: false,
        replayBusy: false,
        gameButton: null,
        seedRecordView: {
            sourceId: '',
            page: 0,
            selectedIndex: 0,
            sortBy: 'default',
        },
        mainPush: {
            isRunning: false,
            isResetting: false,
            resetCount: 0,
            lastLevelId: null,
            lastBossName: '',
            lastRoundId: null,
            logLines: [],
            keepReport: false,
            handler: null,
            signal: null,
            compLordProto: null,
            originalCanAutoAttack: null,
            resetTimer: null,
            lastStatusType: 'info',
            lastStatusText: '未启动',
        },
    };

    window.__NON_PVP_SIMULATOR__ = {
        state,
        version: SCRIPT_VERSION,
    };

    const Utils = {
        log(...args) {
            console.log(`[${SCRIPT_NAME}]`, ...args);
        },
        warn(...args) {
            console.warn(`[${SCRIPT_NAME}]`, ...args);
        },
        error(...args) {
            console.error(`[${SCRIPT_NAME}]`, ...args);
        },
        sleep(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        },
        now() {
            return Date.now();
        },
        formatPercent(value, digits = 2) {
            if (!Number.isFinite(value)) {
                return '0.00%';
            }
            return `${(value * 100).toFixed(digits)}%`;
        },
        formatNumber(value, digits = 2) {
            if (!Number.isFinite(value)) {
                return '0';
            }
            return digits <= 0 ? `${Math.round(value)}` : value.toFixed(digits);
        },
        formatTime(ts) {
            if (!ts) {
                return '-';
            }
            const date = new Date(ts);
            const pad = (num) => `${num}`.padStart(2, '0');
            return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        },
        hashString(input) {
            const text = String(input == null ? '' : input);
            let hash = 2166136261;
            for (let i = 0; i < text.length; i += 1) {
                hash ^= text.charCodeAt(i);
                hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
            }
            return (hash >>> 0);
        },
        pushDataSource(line) {
            const item = `[${this.formatTime(this.now())}] ${line}`;
            state.dataSourceLines.unshift(item);
            state.dataSourceLines = state.dataSourceLines.slice(0, 30);
        },
        downloadTextFile(fileName, text) {
            const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        toast(message, type = 'info') {
            this.log(type, message);
            if (!document.body) {
                return;
            }
            const toast = document.createElement('div');
            toast.className = `non-pvp-sim-toast non-pvp-sim-toast-${type}`;
            toast.textContent = message;
            document.body.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add('show'));
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 240);
            }, 2600);
        },
        safeCall(fn, fallback = null) {
            try {
                return fn();
            } catch (error) {
                return fallback;
            }
        },
        deepClone(value, cache = new WeakMap()) {
            if (value === null || typeof value !== 'object') {
                return value;
            }
            if (cache.has(value)) {
                return cache.get(value);
            }
            if (value instanceof Date) {
                return new Date(value.getTime());
            }
            if (value instanceof RegExp) {
                return new RegExp(value.source, value.flags);
            }
            if (value instanceof Map) {
                const cloneMap = new Map();
                cache.set(value, cloneMap);
                value.forEach((mapValue, mapKey) => {
                    cloneMap.set(this.deepClone(mapKey, cache), this.deepClone(mapValue, cache));
                });
                return cloneMap;
            }
            if (value instanceof Set) {
                const cloneSet = new Set();
                cache.set(value, cloneSet);
                value.forEach((setValue) => {
                    cloneSet.add(this.deepClone(setValue, cache));
                });
                return cloneSet;
            }
            if (Array.isArray(value)) {
                const cloneArray = new Array(value.length);
                cache.set(value, cloneArray);
                for (let i = 0; i < value.length; i += 1) {
                    cloneArray[i] = this.deepClone(value[i], cache);
                }
                return cloneArray;
            }
            const proto = Object.getPrototypeOf(value);
            const cloneObject = Object.create(proto);
            cache.set(value, cloneObject);
            Reflect.ownKeys(value).forEach((key) => {
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (!descriptor) {
                    return;
                }
                if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                    descriptor.value = this.deepClone(descriptor.value, cache);
                }
                Object.defineProperty(cloneObject, key, descriptor);
            });
            return cloneObject;
        },
        toSerializable(value, cache = new WeakMap()) {
            if (value === null || typeof value !== 'object') {
                return value;
            }
            if (cache.has(value)) {
                return cache.get(value);
            }
            if (value instanceof Date) {
                return { __type: 'Date', value: value.toISOString() };
            }
            if (value instanceof Map) {
                const payload = {
                    __type: 'Map',
                    value: Array.from(value.entries()).map(([mapKey, mapValue]) => [
                        this.toSerializable(mapKey, cache),
                        this.toSerializable(mapValue, cache),
                    ]),
                };
                cache.set(value, payload);
                return payload;
            }
            if (value instanceof Set) {
                const payload = {
                    __type: 'Set',
                    value: Array.from(value.values()).map((item) => this.toSerializable(item, cache)),
                };
                cache.set(value, payload);
                return payload;
            }
            if (Array.isArray(value)) {
                const payload = value.map((item) => this.toSerializable(item, cache));
                cache.set(value, payload);
                return payload;
            }
            const payload = {};
            cache.set(value, payload);
            Reflect.ownKeys(value).forEach((key) => {
                payload[key] = this.toSerializable(value[key], cache);
            });
            return payload;
        },
        fromSerializable(value) {
            if (value === null || typeof value !== 'object') {
                return value;
            }
            if (Array.isArray(value)) {
                return value.map((item) => this.fromSerializable(item));
            }
            if (value.__type === 'Date') {
                return new Date(value.value);
            }
            if (value.__type === 'Map') {
                return new Map((value.value || []).map(([mapKey, mapValue]) => [
                    this.fromSerializable(mapKey),
                    this.fromSerializable(mapValue),
                ]));
            }
            if (value.__type === 'Set') {
                return new Set((value.value || []).map((item) => this.fromSerializable(item)));
            }
            const restored = {};
            Object.keys(value).forEach((key) => {
                restored[key] = this.fromSerializable(value[key]);
            });
            return restored;
        },
        stringifySeedScope(scope) {
            try {
                return JSON.stringify(scope);
            } catch (error) {
                return String(scope);
            }
        },
    };

    function loadPanelState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.panelState);
            if (!raw) {
                state.panelPrefs = Object.assign({}, DEFAULT_PANEL_PREFS);
                state.seedRecordView.sortBy = 'default';
                return;
            }
            const parsed = JSON.parse(raw);
            state.panelPrefs = Object.assign({}, DEFAULT_PANEL_PREFS, parsed || {});
            state.seedRecordView.sortBy = state.panelPrefs.seedSort || 'default';
        } catch (error) {
            state.panelPrefs = Object.assign({}, DEFAULT_PANEL_PREFS);
            state.seedRecordView.sortBy = 'default';
        }
    }

    function savePanelState() {
        try {
            localStorage.setItem(STORAGE_KEYS.panelState, JSON.stringify(state.panelPrefs));
        } catch (error) {
            Utils.warn('保存面板状态失败', error);
        }
    }

    function parseManualTarget(value) {
        const text = String(value == null ? '' : value).trim();
        if (!text) {
            return [];
        }
        return text
            .split(/[^\d]+/)
            .filter(Boolean)
            .map((item) => Number(item))
            .filter((item) => Number.isFinite(item));
    }

    function isSplitTargetMode(choice) {
        return choice === 'tower' || choice === 'evoTower';
    }

    function formatTowerLikeStageText(rawStageId) {
        const stageId = Number(rawStageId || 0);
        if (!Number.isFinite(stageId) || stageId <= 0) {
            return '';
        }
        const chapter = Math.floor((stageId - 1) / 10) + 1;
        const layer = ((stageId - 1) % 10) + 1;
        return `${chapter}-${layer}`;
    }

    function buildTowerLikeStageName(rawStageId, fallbackPrefix = '第') {
        const stageText = formatTowerLikeStageText(rawStageId);
        return stageText ? `${fallbackPrefix}${stageText}层` : '';
    }

    function parseTowerLikeStageId(value) {
        const numbers = parseManualTarget(value);
        if (numbers.length >= 2) {
            const chapter = Number(numbers[0] || 0);
            const layer = Number(numbers[1] || 0);
            if (Number.isFinite(chapter) && chapter > 0 && Number.isFinite(layer) && layer > 0 && layer <= 10) {
                return (chapter - 1) * 10 + layer;
            }
        }
        return 0;
    }

    function deriveSplitTargetParts(choice, targetValue) {
        if (!isSplitTargetMode(choice)) {
            return {
                major: '',
                minor: '',
            };
        }
        const displayText = getQuickTargetInputValue(choice, targetValue);
        let numbers = parseManualTarget(displayText);
        if (numbers.length < 2) {
            numbers = parseManualTarget(formatTowerLikeStageText(targetValue));
        }
        return {
            major: numbers[0] != null ? String(numbers[0]) : '',
            minor: numbers[1] != null ? String(numbers[1]) : '',
        };
    }

    function buildSplitTargetValue(choice, majorValue, minorValue) {
        if (!isSplitTargetMode(choice)) {
            return '';
        }
        const majorText = String(majorValue == null ? '' : majorValue).trim();
        const minorText = String(minorValue == null ? '' : minorValue).trim();
        if (!majorText || !minorText) {
            return '';
        }
        const stageText = `${majorText}-${minorText}`;
        return parseTowerLikeStageId(stageText) > 0 ? stageText : '';
    }

    function getManualModeChoice() {
        return state.panelPrefs.modeChoice || 'auto';
    }

    function getManualAdapterKey() {
        const choice = getManualModeChoice();
        if (choice === 'auto') {
            return '';
        }
        if (choice === 'genieShenhai') {
            return 'genie';
        }
        return choice;
    }

    function legacy_getTargetHintText(choice) {
        switch (choice) {
            case 'tower':
                return '可直接输入咸将塔层数；如果当前目标数量不多，也会给出下拉选择。脚本会自动换算内部关卡 ID';
            case 'evoTower':
                return '可直接输入怪异塔层数；脚本会自动换算成真实 towerId，当前目标数量不多时也会给出下拉选择';
            case 'genie':
                return '可直接输入普通灯神层数；脚本会自动换算成对应的 genieLevelId，目标数量较少时也会给出下拉选择';
            case 'genieShenhai':
                return '深海灯神可直接输入第 1-10 层，也可以直接下拉选择；脚本会自动补成真实 levelId';
            case 'nightmare':
                return '可直接输入十殿试炼第几殿；脚本会自动换算成当前客户端里的真实 bossId，目标数量较少时也会给出下拉选择';
            case 'nightmareStar':
                return '可直接输入星级挑战第几关；脚本会自动换算成真实 bossId，目标数量较少时也会给出下拉选择';
            case 'capture':
                return '使用最近捕获战斗，不需要填写目标';
            default:
                return '自动识别模式时可留空；也可以先点“识别当前玩法”回填';
        }
    }

    function getTargetHintText(choice) {
        switch (choice) {
            case 'tower':
                return '咸将塔直接输入游戏里显示的层数即可，例如 385-8；脚本会自动换算成内部关卡 id';
            case 'evoTower':
                return '怪异塔直接输入游戏里显示的层数即可，例如 35-10；脚本会自动换算成真实 towerId';
            case 'genie':
                return '可直接输入普通灯神层数；脚本会自动换算成对应的 genieLevelId，目标数量较少时也会给出下拉选择';
            case 'genieShenhai':
                return '深海灯神可直接输入第 1-10 层，也可以直接下拉选择；脚本会自动补成真实 levelId';
            case 'nightmare':
                return '可直接输入十殿试炼第几殿；脚本会自动换算成当前客户端里的真实 bossId，目标数量较少时也会给出下拉选择';
            case 'nightmareStar':
                return '可直接输入星级挑战第几关；脚本会自动换算成真实 bossId，目标数量较少时也会给出下拉选择';
            case 'capture':
                return '使用最近捕获战斗，不需要填写目标';
            default:
                return '自动识别模式时可留空；也可以先点“识别当前玩法”回填';
        }
    }

    function getTargetInputPlaceholder(choice) {
        switch (choice) {
            case 'tower':
                return '例如：385-8';
            case 'evoTower':
                return '例如：35-10';
            case 'genie':
                return '例如：12';
            case 'genieShenhai':
                return '例如：7';
            case 'nightmare':
                return '例如：9';
            case 'nightmareStar':
                return '例如：3';
            default:
                return '目标层数 / 关卡序号';
        }
    }

    function getNumericFieldValue(source, fieldNames, fallback = null) {
        if (!source || typeof source !== 'object') {
            return fallback;
        }
        for (let i = 0; i < fieldNames.length; i += 1) {
            const key = fieldNames[i];
            if (source[key] == null) {
                continue;
            }
            const value = Number(source[key]);
            if (Number.isFinite(value)) {
                return value;
            }
        }
        return fallback;
    }

    function getTextFieldValue(source, fieldNames, fallback = '') {
        if (!source || typeof source !== 'object') {
            return fallback;
        }
        for (let i = 0; i < fieldNames.length; i += 1) {
            const key = fieldNames[i];
            const value = source[key];
            if (value == null || value === '') {
                continue;
            }
            return String(value);
        }
        return fallback;
    }

    function getDirectTableValue(table, key) {
        if (!table || key == null) {
            return null;
        }
        if (typeof table.getByKey === 'function') {
            const value = Utils.safeCall(() => table.getByKey(key), null);
            if (value != null) {
                return value;
            }
        }
        if (typeof table.getById === 'function') {
            const value = Utils.safeCall(() => table.getById(key), null);
            if (value != null) {
                return value;
            }
        }
        if (table[key] != null) {
            return table[key];
        }
        const textKey = String(key);
        if (table[textKey] != null) {
            return table[textKey];
        }
        return null;
    }

    function findEntryInTable(table, matcher) {
        if (!table || typeof matcher !== 'function') {
            return null;
        }
        if (Array.isArray(table)) {
            for (let i = 0; i < table.length; i += 1) {
                if (matcher(table[i])) {
                    return table[i];
                }
            }
            return null;
        }
        if (Array.isArray(table.list)) {
            for (let i = 0; i < table.list.length; i += 1) {
                if (matcher(table.list[i])) {
                    return table.list[i];
                }
            }
        }
        if (typeof table.forEach === 'function') {
            let matched = null;
            Utils.safeCall(() => table.forEach((item) => {
                if (!matched && matcher(item)) {
                    matched = item;
                }
            }), null);
            if (matched) {
                return matched;
            }
        }
        return null;
    }

    function getNestedTableValue(table, key, matcher = null) {
        const direct = getDirectTableValue(table, key);
        if (direct != null) {
            return direct;
        }
        if (matcher) {
            const matched = findEntryInTable(table, matcher);
            if (matched) {
                return matched;
            }
        }
        const childKeys = Object.keys(table || {});
        for (let i = 0; i < childKeys.length; i += 1) {
            const child = table[childKeys[i]];
            if (!child || typeof child !== 'object') {
                continue;
            }
            const childDirect = getDirectTableValue(child, key);
            if (childDirect != null) {
                return childDirect;
            }
            if (matcher) {
                const childMatched = findEntryInTable(child, matcher);
                if (childMatched) {
                    return childMatched;
                }
            }
        }
        return null;
    }

    function getLanguageEntry(sourceKey) {
        const key = String(sourceKey == null ? '' : sourceKey).trim();
        if (!key) {
            return null;
        }
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        const languageTable = Configs && Configs.LanguageConf ? Configs.LanguageConf : null;
        if (!languageTable) {
            return null;
        }
        return getNestedTableValue(languageTable, key, (item) => {
            if (!item || typeof item !== 'object') {
                return false;
            }
            return getTextFieldValue(item, ['key', 'id', 'ID'], '') === key;
        });
    }

    function getResolvedLanguageText(sourceKey) {
        const key = String(sourceKey == null ? '' : sourceKey).trim();
        if (!key) {
            return '';
        }
        if (state.languageTextCache[key]) {
            return state.languageTextCache[key];
        }
        const languageEntry = getLanguageEntry(key);
        const text = typeof languageEntry === 'string'
            ? getFirstLineText(languageEntry)
            : getFirstLineText(getTextFieldValue(languageEntry, ['chinese', 'text', 'title', 'name', 'value'], ''));
        if (text) {
            state.languageTextCache[key] = text;
            return text;
        }
        return '';
    }

    function getLanguageText(sourceKey, fallback = '') {
        const key = String(sourceKey == null ? '' : sourceKey).trim();
        if (!key) {
            return fallback;
        }
        const text = getResolvedLanguageText(key);
        if (text) {
            return text;
        }
        return fallback || key;
    }

    function getFirstLineText(value) {
        const text = String(value == null ? '' : value).trim();
        if (!text) {
            return '';
        }
        return text.split(/\r?\n/).map((item) => item.trim()).find(Boolean) || text;
    }

    function getClubDisplayName(clubId) {
        const normalizedClubId = Number(clubId || 0);
        if (!Number.isFinite(normalizedClubId) || normalizedClubId <= 0) {
            return '';
        }
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        const clubConfig = Configs && Configs.Club ? Configs.Club : null;
        const mappings = [
            { keys: ['WEI', 'Wei', 'wei'], label: '魏' },
            { keys: ['SHU', 'Shu', 'shu'], label: '蜀' },
            { keys: ['WU', 'Wu', 'wu'], label: '吴' },
            { keys: ['QUN', 'Qun', 'qun'], label: '群' },
            { keys: ['SHENHAI', 'ShenHai', 'shenhai'], label: '深海' },
        ];
        if (clubConfig && typeof clubConfig === 'object') {
            for (let i = 0; i < mappings.length; i += 1) {
                const item = mappings[i];
                for (let j = 0; j < item.keys.length; j += 1) {
                    if (Number(clubConfig[item.keys[j]]) === normalizedClubId) {
                        return item.label;
                    }
                }
            }
        }
        const fallbackMap = {
            1: '魏',
            2: '蜀',
            3: '吴',
            4: '群',
            5: '深海',
        };
        return fallbackMap[normalizedClubId] || '';
    }

    function buildGenieModeTitle(clubId) {
        const clubName = getClubDisplayName(clubId);
        if (!clubName) {
            return '灯神';
        }
        return clubName === '深海' ? '深海灯神' : `${clubName}灯神`;
    }

    function buildManualTargetOption(value, label, extra = {}) {
        if (value == null || label == null || label === '') {
            return null;
        }
        return Object.assign({
            value: String(value),
            label: String(label),
        }, extra || {});
    }

    function dedupeManualTargetOptions(options) {
        const map = new Map();
        (options || []).forEach((item) => {
            if (!item || item.value == null || !item.label) {
                return;
            }
            const key = String(item.value);
            if (!map.has(key)) {
                map.set(key, Object.assign({}, item, { value: key }));
            }
        });
        return Array.from(map.values()).sort((left, right) => {
            const leftSort = Number.isFinite(Number(left.sortValue))
                ? Number(left.sortValue)
                : Number.isFinite(Number(left.displayNumber))
                    ? Number(left.displayNumber)
                    : Number(left.value);
            const rightSort = Number.isFinite(Number(right.sortValue))
                ? Number(right.sortValue)
                : Number.isFinite(Number(right.displayNumber))
                    ? Number(right.displayNumber)
                    : Number(right.value);
            return leftSort - rightSort;
        });
    }

    function getQuickTargetPlaceholder(choice) {
        switch (choice) {
            case 'tower':
                return '选择咸将塔关卡';
            case 'evoTower':
                return '选择怪异塔层数';
            case 'genie':
                return '选择普通灯神目标';
            case 'genieShenhai':
                return '选择深海灯神层数';
            case 'legionBoss':
                return '选择俱乐部Boss';
            case 'nightmare':
                return '选择十殿试炼目标';
            case 'nightmareStar':
                return '选择星级挑战目标';
            default:
                return '选择目标';
        }
    }

    function getManualTargetOptions(choice) {
        if (!choice || choice === 'auto' || choice === 'capture') {
            return [];
        }
        const shouldForceRefresh = choice === 'legionBoss';
        const cached = state.manualTargetOptions[choice];
        if (!shouldForceRefresh && cached && cached.length) {
            return cached;
        }
        let options = [];
        if (choice === 'tower') {
            options = getTowerManualTargetOptions();
        } else if (choice === 'evoTower') {
            options = getEvoTowerManualTargetOptions();
        } else if (choice === 'genie') {
            options = getGenieManualTargetOptions(false);
        } else if (choice === 'genieShenhai') {
            options = getGenieManualTargetOptions(true);
        } else if (choice === 'legionBoss') {
            options = getLegionBossManualTargetOptions();
        } else if (choice === 'nightmare') {
            options = getNightmareManualTargetOptions();
        } else if (choice === 'nightmareStar') {
            options = getNightmareStarManualTargetOptions();
        }
        options = dedupeManualTargetOptions(options);
        if (options.length) {
            state.manualTargetOptions[choice] = options;
        }
        return options;
    }

    function isQuickTargetMode(choice) {
        return getManualTargetOptions(choice).length > 0;
    }

    function legacy_resolveQuickTargetValue(choice, targetValue) {
        const options = getManualTargetOptions(choice);
        if (!options.length) {
            return '';
        }
        const text = String(targetValue == null ? '' : targetValue).trim();
        if (!text) {
            return '';
        }
        const directMatch = options.find((item) => String(item.value) === text);
        if (directMatch) {
            return String(directMatch.value);
        }
        const numbers = parseManualTarget(targetValue);
        if (!numbers.length) {
            return '';
        }
        const raw = Number(numbers[0] || 0);
        if (!Number.isFinite(raw) || raw <= 0) {
            return '';
        }
        const numericMatch = options.find((item) => Number(item.value) === raw);
        if (numericMatch) {
            return String(numericMatch.value);
        }
        const displayMatch = options.find((item) => Number(item.displayNumber) === raw);
        if (displayMatch) {
            return String(displayMatch.value);
        }
        const rankMatch = options.find((item) => Number(item.rank) === raw);
        if (rankMatch) {
            return String(rankMatch.value);
        }
        if (choice === 'genieShenhai') {
            const layer = raw >= 1000 ? raw % 1000 : raw;
            const layerMatch = options.find((item) => Number(item.displayNumber) === layer);
            if (layerMatch) {
                return String(layerMatch.value);
            }
        }
        return '';
    }

    function findQuickTargetOption(choice, targetValue) {
        const options = getManualTargetOptions(choice);
        if (!options.length) {
            return null;
        }
        const resolvedValue = resolveQuickTargetValue(choice, targetValue);
        if (!resolvedValue) {
            return null;
        }
        return options.find((item) => String(item.value) === String(resolvedValue)) || null;
    }

    function legacy_getQuickTargetInputValue(choice, targetValue) {
        const rawText = String(targetValue == null ? '' : targetValue).trim();
        const option = findQuickTargetOption(choice, targetValue);
        if (!option) {
            return rawText;
        }
        if (option.displayNumber != null && option.displayNumber !== '') {
            return String(option.displayNumber);
        }
        if (option.rank != null && option.rank !== '') {
            return String(option.rank);
        }
        return String(option.value);
    }

    function shouldShowQuickTargetSelect(choice, options) {
        if (!Array.isArray(options) || !options.length) {
            return false;
        }
        if (choice === 'tower' || choice === 'evoTower') {
            return false;
        }
        return options.length <= QUICK_TARGET_SELECT_LIMIT
            || choice === 'genie'
            || choice === 'genieShenhai'
            || choice === 'legionBoss'
            || choice === 'nightmare'
            || choice === 'nightmareStar';
    }

    function legacy_applyManualContextOverrides(adapterKey, context) {
        const choice = getManualModeChoice();
        if (choice === 'auto') {
            return context;
        }
        const numbers = parseManualTarget(state.panelPrefs.targetValue);
        const next = Object.assign({}, context || {});
        if (adapterKey === 'tower' && choice === 'tower' && numbers[0]) {
            next.stageId = numbers[0];
            next.stageName = `关卡 ${numbers[0]}`;
            next.manualTarget = true;
        } else if (adapterKey === 'evoTower' && choice === 'evoTower' && numbers[0]) {
            next.towerId = numbers[0];
            next.stageName = `怪异塔 ${numbers[0]}`;
            next.manualTarget = true;
        } else if (adapterKey === 'nightmareStar' && choice === 'nightmareStar' && numbers[0]) {
            const bossMeta = getNightmareStarMetaByMonsterCfgId(numbers[0]) || getNightmareStarMetaByBossId(numbers[0]);
            next.bossId = bossMeta ? bossMeta.bossId : numbers[0];
            if (bossMeta) {
                next.stageNumber = bossMeta.stageNumber;
                next.bossName = bossMeta.displayName;
                next.monster = bossMeta.monsters.map((item) => [item.monsterId, item.index, item.level]);
            }
            next.manualTarget = true;
        } else if (adapterKey === 'nightmare' && choice === 'nightmare' && numbers[0]) {
            const bossMeta = getNightmareBossMetaByMonsterCfgId(numbers[0]) || getNightmareBossMetaByBossId(numbers[0]);
            next.bossId = bossMeta ? bossMeta.bossId : numbers[0];
            if (bossMeta) {
                next.hallNumber = bossMeta.hallNumber;
                next.bossName = bossMeta.displayName;
            }
            next.manualTarget = true;
        } else if (adapterKey === 'genie' && (choice === 'genie' || choice === 'genieShenhai')) {
            const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
            const shenhaiClubId = Configs && Configs.Club ? Configs.Club.SHENHAI : null;
            if (choice === 'genieShenhai') {
                next.title = '深海灯神';
                if (shenhaiClubId != null) {
                    next.clubId = shenhaiClubId;
                }
            }
            if (numbers[0]) {
                if (numbers[0] >= 1000) {
                    next.genieLevelId = numbers[0];
                    next.genieId = numbers[0];
                } else if (numbers[0] < 1000 && next.clubId != null) {
                    next.genieId = next.clubId * 1000 + numbers[0];
                    next.genieLevelId = next.genieId;
                } else {
                    next.genieId = numbers[0];
                }
                next.manualTarget = true;
            }
        }
        return next;
    }

    function getResolvedManualTargetNumber(choice) {
        const quickValue = resolveQuickTargetValue(choice, state.panelPrefs.targetValue);
        const quickNumber = Number(quickValue || 0);
        if (Number.isFinite(quickNumber) && quickNumber > 0) {
            return quickNumber;
        }
        const numbers = parseManualTarget(state.panelPrefs.targetValue);
        const raw = Number(numbers[0] || 0);
        return Number.isFinite(raw) && raw > 0 ? raw : 0;
    }

    function resolveQuickTargetValue(choice, targetValue) {
        const options = getManualTargetOptions(choice);
        if (!options.length) {
            return '';
        }
        const text = String(targetValue == null ? '' : targetValue).trim();
        if (!text) {
            return '';
        }
        const directMatch = options.find((item) => String(item.value) === text);
        if (directMatch) {
            return String(directMatch.value);
        }
        const normalizedDisplayText = parseManualTarget(text).slice(0, 2).join('-');
        const displayTextMatch = options.find((item) => String(item.displayText || '') === text
            || (normalizedDisplayText && String(item.displayText || '') === normalizedDisplayText));
        if (displayTextMatch) {
            return String(displayTextMatch.value);
        }
        if (choice === 'tower' || choice === 'evoTower') {
            const stageId = parseTowerLikeStageId(text);
            if (stageId > 0) {
                const stageMatch = options.find((item) => Number(item.value) === stageId);
                if (stageMatch) {
                    return String(stageMatch.value);
                }
            }
        }
        const numbers = parseManualTarget(targetValue);
        if (!numbers.length) {
            return '';
        }
        const raw = Number(numbers[0] || 0);
        if (!Number.isFinite(raw) || raw <= 0) {
            return '';
        }
        const numericMatch = options.find((item) => Number(item.value) === raw);
        if (numericMatch) {
            return String(numericMatch.value);
        }
        const displayMatch = options.find((item) => Number(item.displayNumber) === raw);
        if (displayMatch) {
            return String(displayMatch.value);
        }
        const rankMatch = options.find((item) => Number(item.rank) === raw);
        if (rankMatch) {
            return String(rankMatch.value);
        }
        if (choice === 'genieShenhai') {
            const layer = raw >= 1000 ? raw % 1000 : raw;
            const layerMatch = options.find((item) => Number(item.displayNumber) === layer);
            if (layerMatch) {
                return String(layerMatch.value);
            }
        }
        return '';
    }

    function getQuickTargetInputValue(choice, targetValue) {
        const rawText = String(targetValue == null ? '' : targetValue).trim();
        const option = findQuickTargetOption(choice, targetValue);
        if (!option) {
            return rawText;
        }
        if (option.displayText != null && option.displayText !== '') {
            return String(option.displayText);
        }
        if (option.displayNumber != null && option.displayNumber !== '') {
            return String(option.displayNumber);
        }
        if (option.rank != null && option.rank !== '') {
            return String(option.rank);
        }
        return String(option.value);
    }

    function applyManualContextOverrides(adapterKey, context) {
        const choice = getManualModeChoice();
        if (choice === 'auto') {
            return context;
        }
        const resolvedTarget = getResolvedManualTargetNumber(choice);
        const numbers = parseManualTarget(state.panelPrefs.targetValue);
        const next = Object.assign({}, context || {});
        if (adapterKey === 'tower' && choice === 'tower' && resolvedTarget) {
            next.stageId = resolvedTarget;
            next.stageName = buildTowerLikeStageName(resolvedTarget);
            next.manualTarget = true;
        } else if (adapterKey === 'evoTower' && choice === 'evoTower' && resolvedTarget) {
            next.towerId = resolvedTarget;
            next.stageName = buildTowerLikeStageName(resolvedTarget);
            next.manualTarget = true;
        } else if (adapterKey === 'nightmareStar' && choice === 'nightmareStar' && resolvedTarget) {
            const bossMeta = getNightmareStarMetaByMonsterCfgId(resolvedTarget) || getNightmareStarMetaByBossId(resolvedTarget);
            next.bossId = bossMeta ? bossMeta.bossId : resolvedTarget;
            if (bossMeta) {
                next.stageNumber = bossMeta.stageNumber;
                next.bossName = bossMeta.displayName;
                next.monster = bossMeta.monsters.map((item) => [item.monsterId, item.index, item.level]);
            }
            next.manualTarget = true;
        } else if (adapterKey === 'nightmare' && choice === 'nightmare' && resolvedTarget) {
            const bossMeta = getNightmareBossMetaByMonsterCfgId(resolvedTarget) || getNightmareBossMetaByBossId(resolvedTarget);
            next.bossId = bossMeta ? bossMeta.bossId : resolvedTarget;
            if (bossMeta) {
                next.hallNumber = bossMeta.hallNumber;
                next.bossName = bossMeta.displayName;
            }
            next.manualTarget = true;
        } else if (adapterKey === 'legionBoss' && choice === 'legionBoss' && resolvedTarget) {
            const previewInfo = getLegionBossPreviewInfo({
                legionBossId: resolvedTarget,
            });
            next.legionBossId = resolvedTarget;
            next.legionBossShow = previewInfo.legionBossShow != null ? previewInfo.legionBossShow : next.legionBossShow;
            next.bossName = previewInfo.name || next.bossName || '';
            next.monster = previewInfo.monsters.length
                ? previewInfo.monsters.map((item) => [item.monsterId, item.index, item.level])
                : next.monster;
            next.manualTarget = true;
        } else if (adapterKey === 'genie' && (choice === 'genie' || choice === 'genieShenhai')) {
            const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
            const shenhaiClubId = Configs && Configs.Club ? Configs.Club.SHENHAI : null;
            if (choice === 'genieShenhai') {
                next.title = '深海灯神';
                if (shenhaiClubId != null) {
                    next.clubId = shenhaiClubId;
                }
            }
            const genieTarget = resolvedTarget || Number(numbers[0] || 0);
            if (genieTarget) {
                if (genieTarget >= 1000) {
                    next.genieLevelId = genieTarget;
                    next.genieId = genieTarget;
                } else if (genieTarget < 1000 && next.clubId != null) {
                    next.genieId = next.clubId * 1000 + genieTarget;
                    next.genieLevelId = next.genieId;
                } else if (choice !== 'genie') {
                    next.genieId = genieTarget;
                }
                if (next.genieId != null || next.genieLevelId != null) {
                    next.manualTarget = true;
                }
            }
            if (next.clubId == null) {
                const derivedClubId = next.genieLevelId != null
                    ? Math.floor(Number(next.genieLevelId) / 1000)
                    : next.genieId != null ? Math.floor(Number(next.genieId) / 1000) : null;
                if (Number.isFinite(derivedClubId) && derivedClubId > 0) {
                    next.clubId = derivedClubId;
                }
            }
            if (!next.title || next.title === '灯神' || choice === 'genieShenhai') {
                next.title = buildGenieModeTitle(next.clubId);
            }
        }
        return next;
    }

    function extractResponseData(resp) {
        if (!resp) {
            return null;
        }
        if (resp._rawData) {
            return resp._rawData;
        }
        if (resp.rawData) {
            return resp.rawData;
        }
        if (typeof resp.getData === 'function') {
            return Utils.safeCall(() => resp.getData(), null);
        }
        return resp;
    }

    function extractBattleDataFromResponse(resp) {
        const data = extractResponseData(resp);
        if (data && data.battleData) {
            return data.battleData;
        }
        return null;
    }

    function normalizeModeKey(value) {
        if (!value) {
            return '';
        }
        const text = String(value);
        if (text === 'nMStarBoss') {
            return 'nightmareStar';
        }
        if (text === 'LegionBoss') {
            return 'legionBoss';
        }
        return text;
    }

    const Runtime = {
        _requireCache: new Map(),
        _battleTypeInfo: null,
        require(moduleName) {
            if (this._requireCache.has(moduleName)) {
                return this._requireCache.get(moduleName);
            }
            const req = window.__require || window.require;
            if (typeof req !== 'function') {
                throw new Error('window.__require 尚未就绪');
            }
            let mod = null;
            try {
                mod = req(moduleName);
            } catch (error) {
                const shortName = moduleName.includes('/') ? moduleName.split('/').pop() : moduleName;
                mod = req(shortName);
            }
            this._requireCache.set(moduleName, mod);
            return mod;
        },
        isReady() {
            return typeof window.__require === 'function' && !!document.body;
        },
        getConfigs() {
            return this.require('Configs');
        },
        getDataIndex() {
            return this.require('data-index');
        },
        getServerData() {
            return this.require('ServerData');
        },
        getRole() {
            return this.getServerData().ROLE;
        },
        getGlobalSignal() {
            return this.require('GlobalSignal').GlobalSignal;
        },
        getModuleManager() {
            return this.require('ModuleManager');
        },
        getGET_MODULE() {
            return this.getModuleManager().GET_MODULE;
        },
        getBattleUIManager() {
            return this.require('BattleUIManager');
        },
        getIndexUI() {
            const mod = this.require('index-ui');
            if (mod && mod.default && (
                typeof mod.default.GET_PROXY === 'function'
                || typeof mod.default.SHOW_PROXY === 'function'
                || typeof mod.default.SHOW_PROXY_OVER === 'function'
                || mod.default.UIManager
            )) {
                return mod.default;
            }
            return mod;
        },
        getManagerFactory() {
            return this.require('manager-factory');
        },
        getBattleDataOption() {
            return this.require('battle-data').BattleDataOption || {};
        },
        getBattleTypeInfo() {
            if (this._battleTypeInfo) {
                return this._battleTypeInfo;
            }
            const sources = [];
            ['data-index', 'battle-data', 'types-orange', 'consts'].forEach((name) => {
                const mod = Utils.safeCall(() => this.require(name), null);
                if (!mod) {
                    return;
                }
                if (mod.BattleType) {
                    sources.push(mod.BattleType);
                }
                if (mod.default && mod.default.BattleType) {
                    sources.push(mod.default.BattleType);
                }
            });
            const forward = {};
            const reverse = {};
            sources.forEach((item) => {
                Object.keys(item || {}).forEach((key) => {
                    const value = item[key];
                    if (typeof value === 'number' || typeof value === 'string') {
                        forward[key] = value;
                        reverse[value] = key;
                    }
                });
            });
            this._battleTypeInfo = { forward, reverse };
            return this._battleTypeInfo;
        },
        getBattleModeName(mode) {
            const info = this.getBattleTypeInfo();
            if (info.reverse[mode]) {
                return info.reverse[mode];
            }
            const fallback = {
                2: 'tower',
                9: 'genie',
                35: 'evoTower',
            };
            return fallback[mode] || '';
        },
        getBattleModeValue(modeName) {
            const info = this.getBattleTypeInfo();
            if (info.forward[modeName] != null) {
                return info.forward[modeName];
            }
            const normalizedName = String(modeName == null ? '' : modeName).toLowerCase();
            if (normalizedName) {
                const matchedKey = Object.keys(info.forward).find((key) => String(key).toLowerCase() === normalizedName);
                if (matchedKey && info.forward[matchedKey] != null) {
                    return info.forward[matchedKey];
                }
            }
            const fallback = {
                tower: 2,
                genie: 9,
                evoTower: 35,
                nightmare: 13,
                nightmareStar: 37,
            };
            return fallback[modeName];
        },
        getLevelBattle() {
            const managerFactory = Utils.safeCall(() => this.getManagerFactory(), null);
            if (!managerFactory || typeof managerFactory.GET_LEVEL_BATTLE !== 'function') {
                return null;
            }
            return Utils.safeCall(() => managerFactory.GET_LEVEL_BATTLE(), null);
        },
        getModuleType(moduleKey) {
            const Configs = this.getConfigs();
            return Configs.ModuleType ? Configs.ModuleType[moduleKey] : undefined;
        },
        getModuleByTypeKey(moduleKey) {
            const moduleType = this.getModuleType(moduleKey);
            if (moduleType == null) {
                return null;
            }
            return Utils.safeCall(() => this.getGET_MODULE()(moduleType), null);
        },
        async sendCommand(cmd, params = {}) {
            if (!window.ws || typeof window.ws.sendAsync !== 'function') {
                throw new Error('WebSocket sendAsync 不可用');
            }
            return window.ws.sendAsync({
                ack: 0,
                cmd,
                params,
                seq: Date.now(),
                time: Date.now(),
            });
        },
        getReusableBattleSkeleton(shouldClone = true) {
            let battleData = state.reusableSkeleton;
            if (!battleData && state.latestCapture && state.latestCapture.input && !isPvpBattleInput(state.latestCapture.input)) {
                battleData = state.latestCapture.input.battleData;
            }
            if (!battleData) {
                const keys = ['tower', 'genie', 'evoTower', 'legionBoss', 'nightmareStar', 'nightmare'];
                for (let i = 0; i < keys.length; i += 1) {
                    const cache = state.modeCaches[keys[i]];
                    if (cache && cache.battleData) {
                        battleData = cache.battleData;
                        break;
                    }
                    if (cache && cache.inputData && cache.inputData.battleData) {
                        battleData = cache.inputData.battleData;
                        break;
                    }
                }
            }
            if (!battleData || !isReusableBattleSkeleton(battleData)) {
                return null;
            }
            if (!state.reusableSkeleton) {
                updateReusableBattleSkeleton(battleData, {
                    source: 'getReusableBattleSkeletonFallback',
                    modeKey: normalizeModeKey(this.getBattleModeName(battleData.mode)),
                });
                battleData = state.reusableSkeleton || battleData;
            }
            return shouldClone ? Utils.deepClone(battleData) : battleData;
        },
        getDefaultSimConfig(battleData) {
            const BattleDataOption = this.getBattleDataOption();
            const DecimalNumber = Utils.safeCall(() => this.require('decimal-number').DecimalNumber, null);
            const Configs = this.getConfigs();
            const GET_MODULE = this.getGET_MODULE();
            const dataIndex = this.getDataIndex();
            const lordModule = Utils.safeCall(() => GET_MODULE(Configs.ModuleType.LORD), null);
            let autoSpeed = 100;
            try {
                autoSpeed = battleData && battleData.options && typeof battleData.options.getExt === 'function'
                    ? battleData.options.getExt(BattleDataOption.AutoSpeed, 100)
                    : 100;
            } catch (error) {
                autoSpeed = 100;
            }
            const timeScale = 100;
            const extend = Object.assign(
                { noRender: true },
                lordModule ? {
                    autoAttackInterval: lordModule.autoAttackInterval,
                    autoAttack: lordModule.autoAttack,
                } : {},
                dataIndex && dataIndex.GDRole ? { role: new dataIndex.GDRole() } : {},
            );
            return { extend, timeScale };
        },
        _cachedBattleFactory: null,
        findBattleFactory() {
            if (this._cachedBattleFactory) return this._cachedBattleFactory;
            try {
                var scene = cc.director.getScene();
                var found = null;
                function walk(n) {
                    var comps = n._components || [];
                    for (var i = 0; i < comps.length; i++) {
                        if (comps[i] && comps[i]._serverBattleFactory) { found = comps[i]._serverBattleFactory; return; }
                    }
                    var ch = n.children || [];
                    for (var j = 0; j < ch.length; j++) { walk(ch[j]); if (found) return; }
                }
                walk(scene);
                if (found) this._cachedBattleFactory = found;
                return found;
            } catch (_) { return null; }
        },
        simulateBattle(battleData, extendConfig, timeScale) {
            var factory = this.findBattleFactory();
            var opts = {
                battleData,
                timeScale: timeScale || 1,
                extend: Object.assign({ noRender: true }, extendConfig || {}),
            };
            var battle;
            if (factory) {
                battle = factory.createBattleById(opts);
            } else {
                const ServerBattleLauncher = this.require('launcher-server').ServerBattleLauncher;
                const battleLauncher = new ServerBattleLauncher();
                battleLauncher.initialize();
                battle = battleLauncher.createBattleById(opts);
            }
            if (!battle) throw new Error('createBattleById returned null');
            var done = false;
            var battleResult = null;
            var sim = Date.now();
            var deadline = Date.now() + 40000;
            battle.BattleResult.add(function (result) {
                if (done) return;
                done = true;
                battleResult = result;
                try { battle.endBattle(); } catch (_) {}
            });
            battle.startBattle();
            return new Promise(function (resolve, reject) {
                function tick() {
                    if (done) return resolve(battleResult);
                    if (Date.now() > deadline) { done = true; return reject(new Error('本地模拟超时')); }
                    try {
                        if (battle.isQuitted) {
                            if (!done) { done = true; resolve(battleResult || battle.result || { isWin: false }); }
                        } else {
                            battle.update(sim);
                            sim += 20;
                            setTimeout(tick, 0);
                        }
                    } catch (e) { done = true; reject(e); }
                }
                tick();
            });
        },
        patchPromiseMethod(target, methodName, onResolved) {
            if (!target || typeof target[methodName] !== 'function') {
                return;
            }
            const original = target[methodName];
            if (original.__nonPvpSimPatched) {
                return;
            }
            const self = this;
            const wrapped = function patchedMethod(...args) {
                const result = original.apply(this, args);
                if (!result || typeof result.then !== 'function') {
                    return result;
                }
                return result.then((resp) => {
                    try {
                        onResolved.call(this, resp, args, self);
                    } catch (error) {
                        Utils.warn(`patchPromiseMethod ${methodName} 处理失败`, error);
                    }
                    return resp;
                });
            };
            wrapped.__nonPvpSimPatched = true;
            wrapped.__original = original;
            target[methodName] = wrapped;
        },
        patchSignalDispatch(signal, onDispatch) {
            if (!signal || typeof signal.dispatch !== 'function' || signal.dispatch.__nonPvpSimPatched) {
                return;
            }
            const original = signal.dispatch;
            signal.dispatch = function patchedDispatch(...args) {
                try {
                    onDispatch.apply(this, args);
                } catch (error) {
                    Utils.warn('signal dispatch patch 处理失败', error);
                }
                return original.apply(this, args);
            };
            signal.dispatch.__nonPvpSimPatched = true;
            signal.dispatch.__original = original;
        },
    };

    function getOptionValue(options, key, fallback = null) {
        if (!options) {
            return fallback;
        }
        if (typeof options.getExt === 'function') {
            return Utils.safeCall(() => options.getExt(key, fallback), fallback);
        }
        if (typeof options.get === 'function') {
            const value = Utils.safeCall(() => options.get(key), undefined);
            return value === undefined ? fallback : value;
        }
        if (Object.prototype.hasOwnProperty.call(options, key)) {
            return options[key];
        }
        return fallback;
    }

    function setOptionValue(options, key, value) {
        if (!options) {
            return;
        }
        if (typeof options.setExt === 'function') {
            Utils.safeCall(() => options.setExt(key, value), null);
            return;
        }
        if (typeof options.set === 'function') {
            Utils.safeCall(() => options.set(key, value), null);
            return;
        }
        options[key] = value;
    }

    function ensureOptionsContainer(target) {
        if (target.options) {
            return target.options;
        }
        target.options = new Map();
        return target.options;
    }

    function setBattleOptionByName(options, optionName, value) {
        if (!options || !optionName) {
            return;
        }
        setOptionValue(options, optionName, value);
        const BattleDataOption = Utils.safeCall(() => Runtime.getBattleDataOption(), null);
        if (BattleDataOption && Object.prototype.hasOwnProperty.call(BattleDataOption, optionName)) {
            setOptionValue(options, BattleDataOption[optionName], value);
        }
        if (typeof options === 'object') {
            options[optionName] = value;
        }
    }

    function resolveModeKeyFromBattleData(battleData, inputData) {
        const modeName = normalizeModeKey(Runtime.getBattleModeName(battleData && battleData.mode));
        if (MODE_LABELS[modeName]) {
            return modeName;
        }
        if (modeName === 'nMStarBoss') {
            return 'nightmareStar';
        }
        const playbackModeKey = normalizeModeKey(
            Utils.safeCall(() => inputData.__nonPvpPlaybackMeta.modeKey, '')
            || Utils.safeCall(() => inputData.modeKey, ''),
        );
        if (MODE_LABELS[playbackModeKey]) {
            return playbackModeKey;
        }
        if (modeName === 'pKRoom' && isNightmareRoomReplayInput(inputData)) {
            return 'nightmare';
        }
        const options = inputData && inputData.options;
        if (options && typeof options.forEach === 'function') {
            let matched = '';
            options.forEach((value) => {
                if (value && typeof value === 'object' && value.bossId && value.remainStarFightCount != null) {
                    matched = 'nightmareStar';
                }
            });
            if (matched) {
                return matched;
            }
        }
        return 'capture';
    }

    function isPvpBattleInput(inputData) {
        const battleData = inputData && inputData.battleData;
        const modeName = Runtime.getBattleModeName(battleData && battleData.mode);
        if (PVP_MODE_NAMES.has(modeName)) {
            return true;
        }
        const rightRoleId = battleData && battleData.rightTeam ? battleData.rightTeam.roleId : 0;
        const leftRoleId = battleData && battleData.leftTeam ? battleData.leftTeam.roleId : 0;
        if (rightRoleId && leftRoleId && rightRoleId !== leftRoleId) {
            const nonPvpNames = new Set(['tower', 'genie', 'evoTower', 'legionBoss', 'nMStarBoss']);
            if (!nonPvpNames.has(modeName)) {
                return true;
            }
        }
        return false;
    }

    function isReusableBattleSkeleton(battleData) {
        return !!(battleData && battleData.leftTeam && battleData.leftTeam.team);
    }

    function updateReusableBattleSkeleton(battleData, meta = {}) {
        if (!isReusableBattleSkeleton(battleData)) {
            return false;
        }
        state.reusableSkeleton = finalizeBattleDataForSimulation(Utils.deepClone(battleData));
        state.reusableSkeletonMeta = Object.assign({
            source: 'unknown',
            mode: battleData.mode,
            modeKey: normalizeModeKey(Runtime.getBattleModeName(battleData.mode)),
            capturedAt: Utils.now(),
        }, meta, {
            mode: battleData.mode,
            capturedAt: Utils.now(),
        });
        const signature = getCurrentTeamSignatureFromBattleData(state.reusableSkeleton);
        if (signature) {
            state.lastKnownSignature = signature;
        }
        saveReusableSkeleton();
        return true;
    }

    function tryCaptureAutoLevelBattleSkeleton(source = 'autoLevelBattle') {
        const levelBattle = Utils.safeCall(() => Runtime.getLevelBattle(), null);
        const battleData = Utils.safeCall(() => levelBattle && levelBattle.options ? levelBattle.options.battleData : null, null);
        if (!isReusableBattleSkeleton(battleData)) {
            return false;
        }
        updateReusableBattleSkeleton(battleData, {
            source,
            modeKey: 'level',
        });
        Utils.pushDataSource(`捕获主线自动战斗骨架 ${source}`);
        return true;
    }

    function captureAuthorityBattle(modeKey, battleData, extra = {}) {
        if (!battleData) {
            return;
        }
        const cache = Object.assign({}, state.modeCaches[modeKey] || {}, extra, {
            modeKey,
            battleData: Utils.deepClone(battleData),
            capturedAt: Utils.now(),
        });
        state.modeCaches[modeKey] = cache;
        updateReusableBattleSkeleton(battleData, {
            source: extra.source || 'captureAuthorityBattle',
            modeKey,
        });
        Utils.pushDataSource(`捕获 ${MODE_LABELS[modeKey] || modeKey} 权威 battleData`);
        recordDiagnosticSample('authorityBattle', {
            modeKey,
            source: extra.source || 'captureAuthorityBattle',
            context: extra.context || null,
            battleData,
            extra,
        });
    }

    function shouldSkipBattleInputCapture(inputData) {
        return !!(inputData
            && typeof inputData === 'object'
            && inputData.__nonPvpPlaybackMeta
            && inputData.__nonPvpPlaybackMeta.skipCapture);
    }

    function markPlaybackInputInternal(inputData, source = 'replayLatest', extraMeta = null) {
        if (!inputData || typeof inputData !== 'object') {
            return inputData;
        }
        const meta = Object.assign(
            {},
            inputData.__nonPvpPlaybackMeta && typeof inputData.__nonPvpPlaybackMeta === 'object'
                ? inputData.__nonPvpPlaybackMeta
                : {},
            {
                skipCapture: true,
                source,
                markedAt: Utils.now(),
            },
            extraMeta && typeof extraMeta === 'object' ? extraMeta : {},
        );
        Object.defineProperty(inputData, '__nonPvpPlaybackMeta', {
            value: meta,
            configurable: true,
            enumerable: false,
            writable: true,
        });
        return inputData;
    }

    function clearPlaybackRestoreTimer() {
        if (state.playbackRestoreTimer) {
            clearTimeout(state.playbackRestoreTimer);
            state.playbackRestoreTimer = null;
        }
    }

    function emitBattleVisible(visible) {
        const GlobalSignal = Utils.safeCall(() => Runtime.getGlobalSignal(), null);
        const event = GlobalSignal && GlobalSignal.EventBattleVisible;
        if (!event) {
            return false;
        }
        if (typeof event.emit === 'function') {
            event.emit(visible);
            return true;
        }
        if (typeof event.dispatch === 'function') {
            event.dispatch(visible);
            return true;
        }
        return false;
    }

    function hidePlaybackBattleVisible(source = 'playback') {
        state.playbackBattleVisibleDepth += 1;
        if (state.playbackBattleVisibleDepth !== 1) {
            return;
        }
        clearPlaybackRestoreTimer();
        if (emitBattleVisible(false)) {
            Utils.pushDataSource(`hide main battle visuals (${source})`);
        }
    }

    function restorePlaybackBattleVisible(source = 'playback') {
        if (state.playbackBattleVisibleDepth > 0) {
            state.playbackBattleVisibleDepth -= 1;
        }
        if (state.playbackBattleVisibleDepth !== 0) {
            return;
        }
        clearPlaybackRestoreTimer();
        if (emitBattleVisible(true)) {
            Utils.pushDataSource(`restore main battle visuals (${source})`);
        }
        restorePlaybackHiddenLayers(`${source}:restore`);
        restorePlaybackHiddenProxies(`${source}:restore`);
        clearPlaybackBackdrop(`${source}:restore`);
        cleanupNightmareReplayScene(`${source}:restore`)
            .catch((error) => {
                Utils.pushDataSource(`清理十殿背景 Scene 失败 (${source}): ${getShortErrorMessage(error)}`);
                Utils.warn('cleanup nightmare replay scene failed', error);
            });
    }

    function armPlaybackRestoreTimer(source = 'playback') {
        clearPlaybackRestoreTimer();
        state.playbackRestoreTimer = setTimeout(() => {
            restorePlaybackBattleVisible(`${source}:timeout`);
        }, 45000);
    }

    function dispatchSignalEvent(event, ...args) {
        if (!event) {
            return false;
        }
        if (typeof event.dispatch === 'function') {
            event.dispatch(...args);
            return true;
        }
        if (typeof event.emit === 'function') {
            event.emit(...args);
            return true;
        }
        return false;
    }

    function getNightmareBattleSceneClass() {
        const moduleNames = [
            'NightmareBattleScene',
            '../ui/nightmare/NightmareBattleScene',
            'ui/nightmare/NightmareBattleScene',
        ];
        for (let i = 0; i < moduleNames.length; i += 1) {
            const sceneModule = Utils.safeCall(() => Runtime.require(moduleNames[i]), null);
            if (!sceneModule) {
                continue;
            }
            return sceneModule.NightmareBattleScene || sceneModule.default || sceneModule;
        }
        return null;
    }

    function getReplayMetaContext(inputData = null) {
        return Utils.safeCall(() => inputData.__nonPvpPlaybackMeta.context, null) || null;
    }

    function mergeReplayContexts(candidates = []) {
        const merged = {};
        let hasValue = false;
        candidates.forEach((candidate) => {
            if (!candidate || typeof candidate !== 'object') {
                return;
            }
            Object.keys(candidate).forEach((key) => {
                const currentValue = merged[key];
                const nextValue = candidate[key];
                const currentEmpty = currentValue == null
                    || currentValue === ''
                    || (Array.isArray(currentValue) && !currentValue.length);
                const nextEmpty = nextValue == null
                    || nextValue === ''
                    || (Array.isArray(nextValue) && !nextValue.length);
                if (!currentEmpty || nextEmpty) {
                    return;
                }
                merged[key] = Utils.deepClone(nextValue);
                hasValue = true;
            });
        });
        return hasValue ? merged : null;
    }

    function resolveReplayLaunchContext(modeKey = '', inputData = null) {
        const contexts = [
            getReplayMetaContext(inputData),
            state.lastSingleRun
                && (state.lastSingleRun.replayInput === inputData
                    || state.lastSingleRun.mode === modeKey
                    || state.lastSingleRun.adapterKey === modeKey)
                ? state.lastSingleRun.context
                : null,
            state.lastReport
                && (state.lastReport.replayInput === inputData
                    || state.lastReport.mode === modeKey
                    || state.lastReport.adapterKey === modeKey)
                ? state.lastReport.context
                : null,
            Utils.safeCall(() => state.modeCaches[modeKey].context, null),
        ];
        if (modeKey !== 'nightmare') {
            contexts.push(Utils.safeCall(() => state.modeCaches.nightmare && state.modeCaches.nightmare.context, null));
        }
        return mergeReplayContexts(contexts) || {};
    }

    function resolveNightmareReplayBossId(replayInput = null, context = null) {
        const mergedContext = mergeReplayContexts([context, getReplayMetaContext(replayInput)]) || {};
        const contextBossId = getNumericFieldValue(mergedContext, ['bossId'], null);
        const notify = Utils.safeCall(() => replayInput.fightNotify, null) || {};
        const roomInfo = Utils.safeCall(() => notify.roomInfo, null) || {};
        const inputBossId = getNumericFieldValue(replayInput || {}, ['bossCfgId', 'bossId'], null);
        const notifyBossId = getNumericFieldValue(notify || {}, ['bossCfgId', 'bossId'], null);
        const monsterCfgId = getNumericFieldValue(
            roomInfo,
            ['curMonsterCfgId', 'lastMonsterCfgId', 'lastMonsterId'],
            getNumericFieldValue(
                replayInput || {},
                ['curMonsterCfgId', 'lastMonsterCfgId', 'lastMonsterId'],
                getNumericFieldValue(mergedContext, ['monsterCfgId'], null),
            ),
        );
        const meta = getNightmareBossMetaByBossId(contextBossId)
            || getNightmareBossMetaByBossId(inputBossId)
            || getNightmareBossMetaByBossId(notifyBossId)
            || getNightmareBossMetaByMonsterCfgId(monsterCfgId);
        const resolvedBossId = meta
            ? Number(meta.bossId)
            : Number(contextBossId || inputBossId || notifyBossId || 0);
        if (!Number.isFinite(resolvedBossId) || resolvedBossId <= 0) {
            return null;
        }
        return resolvedBossId;
    }

    function getShortErrorMessage(error) {
        if (!error) {
            return 'unknown';
        }
        if (typeof error === 'string') {
            return error;
        }
        if (typeof error.message === 'string' && error.message) {
            return error.message;
        }
        return String(error);
    }

    function getPlaybackProxyName(proxy) {
        if (!proxy) {
            return 'UnknownProxy';
        }
        const ctorName = Utils.safeCall(() => proxy.constructor && proxy.constructor.name, '');
        if (ctorName) {
            return ctorName;
        }
        const uiName = Utils.safeCall(() => proxy.ui && proxy.ui.name, '');
        if (uiName) {
            return uiName;
        }
        return 'AnonymousProxy';
    }

    function getLayersProxyClass() {
        const moduleNames = [
            'Layers',
            '../common/Layers',
            'common/Layers',
        ];
        for (let i = 0; i < moduleNames.length; i += 1) {
            const layersModule = Utils.safeCall(() => Runtime.require(moduleNames[i]), null);
            if (!layersModule) {
                continue;
            }
            const LayersClass = layersModule.Layers || layersModule.default || layersModule;
            if (LayersClass) {
                return LayersClass;
            }
        }
        return null;
    }

    function getLayersProxyInstance() {
        const indexUI = Utils.safeCall(() => Runtime.getIndexUI(), null);
        const LayersClass = getLayersProxyClass();
        if (!indexUI || !LayersClass || typeof indexUI.GET_PROXY !== 'function') {
            return null;
        }
        return Utils.safeCall(() => indexUI.GET_PROXY(LayersClass), null);
    }

    function getPlaybackLayerKeepNames() {
        return new Set(['Mask', 'Guide', 'BottomTip', 'Tip', 'Console', 'Loading']);
    }

    function getBattleConstModule() {
        const moduleNames = [
            'battle-const',
            '../../../extras/battle/basis/data/battle-const',
            '../../../../extras/battle/basis/data/battle-const',
            'extras/battle/basis/data/battle-const',
        ];
        for (let i = 0; i < moduleNames.length; i += 1) {
            const battleConstModule = Utils.safeCall(() => Runtime.require(moduleNames[i]), null);
            if (!battleConstModule) {
                continue;
            }
            const battleConst = battleConstModule.BattleConst || battleConstModule.default || battleConstModule;
            if (battleConst && typeof battleConst.getMapUrl === 'function') {
                return battleConst;
            }
        }
        return null;
    }

    function getBattleAssetManagerInstance() {
        const moduleNames = [
            'manager-asset',
            '../../battle/manager/manager-asset',
            '../battle/manager/manager-asset',
            'battle/manager/manager-asset',
        ];
        for (let i = 0; i < moduleNames.length; i += 1) {
            const assetModule = Utils.safeCall(() => Runtime.require(moduleNames[i]), null);
            const manager = assetModule && assetModule.BattleAssetManager
                ? assetModule.BattleAssetManager.instance
                : null;
            if (manager && typeof manager.loadMap === 'function') {
                return manager;
            }
        }
        return null;
    }

    function resolveNightmareBattleMapIdByBossId(bossId) {
        const numericBossId = Number(bossId || 0);
        if (!Number.isFinite(numericBossId) || numericBossId <= 0) {
            return 0;
        }
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        const conf = Configs && Configs.NightMareMonster && typeof Configs.NightMareMonster.getByBossId === 'function'
            ? Utils.safeCall(() => Configs.NightMareMonster.getByBossId(numericBossId), null)
            : null;
        const bossType = Number(getNumericFieldValue(conf, ['bossType', 'type'], 0));
        return bossType > 0 ? 100000 + bossType : 0;
    }

    function resolvePlaybackBackdropLayerNode(source = 'playback') {
        const layersProxy = getLayersProxyInstance();
        const children = Utils.safeCall(() => layersProxy.ui && layersProxy.ui._children, null);
        if (!layersProxy || !Array.isArray(children)) {
            Utils.pushDataSource(`回放背景层失败: Layers proxy 不可用 (${source})`);
            return null;
        }
        const preferredNames = ['Normal', 'Fixed'];
        for (let i = 0; i < preferredNames.length; i += 1) {
            const layerNode = children.find((item) => item && item.name === preferredNames[i]);
            if (layerNode) {
                return {
                    layerName: preferredNames[i],
                    layerNode,
                };
            }
        }
        const keepNames = getPlaybackLayerKeepNames();
        const fallbackNode = children.find((item) => item && item.name && !keepNames.has(item.name));
        if (fallbackNode) {
            return {
                layerName: fallbackNode.name || 'Unknown',
                layerNode: fallbackNode,
            };
        }
        return null;
    }

    function resolvePlaybackBackdropMapIds(replayInput, modeKey = '', context = null) {
        const mapIds = [];
        const pushMapId = (value) => {
            const numericValue = Number(value || 0);
            if (!Number.isFinite(numericValue) || numericValue <= 0 || mapIds.includes(numericValue)) {
                return;
            }
            mapIds.push(numericValue);
        };
        const battleData = replayInput && replayInput.battleData ? replayInput.battleData : null;
        pushMapId(replayInput && replayInput.mapId);
        pushMapId(replayInput && replayInput.mapID);
        pushMapId(getOptionValue(replayInput && replayInput.options, 'mapId', 0));
        pushMapId(getOptionValue(replayInput && replayInput.options, 'mapID', 0));
        pushMapId(battleData && battleData.mapId);
        pushMapId(battleData && battleData.mapID);
        if (modeKey === 'genie') {
            pushMapId(resolveGenieBattleMapId(context));
        } else if (modeKey === 'nightmare') {
            pushMapId(resolveNightmareBattleMapIdByBossId(
                getNumericFieldValue(context || {}, ['bossId', 'lastMonsterId', 'curMonsterCfgId'], 0),
            ));
            pushMapId(resolveNightmareBattleMapIdByBossId(
                getNumericFieldValue(replayInput || {}, ['bossId', 'lastMonsterId', 'curMonsterCfgId'], 0),
            ));
        } else if (modeKey === 'nightmareStar') {
        }
        pushMapId(100001);
        return mapIds;
    }

    function clearPlaybackBackdrop(source = 'playback') {
        const backdropState = state.playbackBackdropState;
        if (!backdropState) {
            return false;
        }
        state.playbackBackdropState = null;
        const display = backdropState.display;
        try {
            if (display && typeof display.removeFromParent === 'function') {
                display.removeFromParent();
            } else if (backdropState.layerNode && typeof backdropState.layerNode.removeChild === 'function' && display) {
                backdropState.layerNode.removeChild(display);
            }
        } catch (error) {
            Utils.pushDataSource(`移除回放背景失败 (${source}): ${getShortErrorMessage(error)}`);
        }
        const battleAssetManager = getBattleAssetManagerInstance();
        if (battleAssetManager && typeof battleAssetManager.releaseMap === 'function' && backdropState.mapUrl) {
            try {
                battleAssetManager.releaseMap(backdropState.mapUrl);
            } catch (error) {
                Utils.pushDataSource(`释放回放背景资源失败 ${backdropState.mapUrl}: ${getShortErrorMessage(error)}`);
            }
        }
        Utils.pushDataSource(`清理回放背景 ${backdropState.mapUrl || '-'} (${source})`);
        return true;
    }

    async function ensurePlaybackBackdrop(replayInput, modeKey = '', context = null, source = 'playback') {
        clearPlaybackBackdrop(`${source}:stale`);
        const battleConst = getBattleConstModule();
        if (!battleConst || typeof battleConst.getMapUrl !== 'function') {
            Utils.pushDataSource(`回放背景跳过: BattleConst 不可用 (${source})`);
            return false;
        }
        const battleAssetManager = getBattleAssetManagerInstance();
        if (!battleAssetManager || typeof battleAssetManager.loadMap !== 'function') {
            Utils.pushDataSource(`回放背景跳过: BattleAssetManager 不可用 (${source})`);
            return false;
        }
        const layerInfo = resolvePlaybackBackdropLayerNode(source);
        if (!layerInfo || !layerInfo.layerNode) {
            Utils.pushDataSource(`回放背景跳过: 找不到背景层 (${source})`);
            return false;
        }
        const mapIds = resolvePlaybackBackdropMapIds(replayInput, modeKey, context);
        for (let i = 0; i < mapIds.length; i += 1) {
            const mapId = mapIds[i];
            const mapUrl = Utils.safeCall(() => battleConst.getMapUrl(mapId), null);
            if (!mapUrl) {
                continue;
            }
            try {
                await Promise.race([
                    Promise.resolve(battleAssetManager.loadMap(mapUrl)),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('地图加载超时')), 3000)),
                ]);
                const display = Utils.safeCall(() => fgui.UIPackage.createObject(mapUrl, 'Map'), null);
                if (!display) {
                    Utils.pushDataSource(`回放背景创建失败 mapId=${mapId} (${source})`);
                    continue;
                }
                try {
                    layerInfo.layerNode.addChild(display);
                } catch (addError) {
                    Utils.pushDataSource(`回放背景挂载失败 mapId=${mapId}: ${getShortErrorMessage(addError)} (${source})`);
                    continue;
                }
                state.playbackBackdropState = {
                    mapId,
                    mapUrl,
                    layerName: layerInfo.layerName,
                    display,
                    layerNode: layerInfo.layerNode,
                };
                Utils.pushDataSource(`回放背景加载成功 mapId=${mapId} (${source})`);
                return true;
            } catch (error) {
                Utils.pushDataSource(`回放背景加载失败 mapId=${mapId}: ${getShortErrorMessage(error)} (${source})`);
            }
        }
        Utils.pushDataSource(`回放背景全部失败，继续无背景播放 (${source})`);
        return false;
    }

    function collectPlaybackVisibleLayerNames(source = 'playback') {
        const keepNames = getPlaybackLayerKeepNames();
        const layersProxy = getLayersProxyInstance();
        const children = Utils.safeCall(() => layersProxy.ui && layersProxy.ui._children, null);
        if (!layersProxy || !Array.isArray(children)) {
            Utils.pushDataSource(`收集页面 layer 失败: Layers proxy 不可用 (${source})`);
            return [];
        }
        const visibleNames = children
            .filter((child) => child && child.name && child.visible && !keepNames.has(child.name))
            .map((child) => child.name);
        Utils.pushDataSource(`当前可隐藏页面 layer: ${visibleNames.length ? visibleNames.join(',') : '-'}`);
        return visibleNames;
    }

    function collectLayerExistingChildren(layerNode) {
        if (!layerNode) {
            return [];
        }
        const children = Utils.safeCall(() => layerNode._children, null);
        if (Array.isArray(children)) {
            return children.filter(Boolean);
        }
        const count = Utils.safeCall(() => layerNode.numChildren, 0);
        if (typeof count === 'number' && count > 0 && typeof layerNode.getChildAt === 'function') {
            const result = [];
            for (let index = 0; index < count; index += 1) {
                const child = Utils.safeCall(() => layerNode.getChildAt(index), null);
                if (child) {
                    result.push(child);
                }
            }
            return result;
        }
        return [];
    }

    function getPlaybackLayerNodeName(node, index = 0) {
        if (!node) {
            return `anonymous-${index}`;
        }
        return node.name
            || Utils.safeCall(() => node.constructor && node.constructor.name, null)
            || `anonymous-${index}`;
    }

    function isExcludedPlaybackProxy(proxy, excludedConstructors = []) {
        if (!proxy || !excludedConstructors || !excludedConstructors.length) {
            return false;
        }
        for (let i = 0; i < excludedConstructors.length; i += 1) {
            const ctor = excludedConstructors[i];
            if (typeof ctor !== 'function') {
                continue;
            }
            if (proxy.constructor === ctor) {
                return true;
            }
            try {
                if (proxy instanceof ctor) {
                    return true;
                }
            } catch (error) {
                // ignore instanceof edge cases
            }
        }
        return false;
    }

    function hidePlaybackVisibleProxiesExcept(excludedConstructors = [], source = 'playback') {
        if (Array.isArray(state.playbackHiddenProxyStates) && state.playbackHiddenProxyStates.length) {
            restorePlaybackHiddenProxies(`${source}:stale`);
        }
        if (Array.isArray(state.playbackHiddenLayerStates) && state.playbackHiddenLayerStates.length) {
            restorePlaybackHiddenLayers(`${source}:stale`);
        }
        const indexUI = Utils.safeCall(() => Runtime.getIndexUI(), null);
        const uiManager = Utils.safeCall(() => indexUI.UIManager.instance, null);
        const UILayer = Utils.safeCall(() => indexUI.UILayer, null);
        if (!indexUI) {
            Utils.pushDataSource(`隐藏页面 proxy 失败: index-ui 不可用 (${source})`);
            return 0;
        }
        if (!uiManager || typeof uiManager.getProxyAt !== 'function') {
            Utils.pushDataSource(`隐藏页面 proxy 失败: UIManager.instance.getProxyAt 不可用 (${source})`);
            return 0;
        }
        if (!UILayer || typeof UILayer !== 'object') {
            Utils.pushDataSource(`隐藏页面 proxy 失败: UILayer 不可用 (${source})`);
            return 0;
        }
        const hiddenStates = [];
        const visitedLayerValues = new Set();
        Object.keys(UILayer).forEach((layerName) => {
            const layerValue = UILayer[layerName];
            if (typeof layerValue !== 'number' && typeof layerValue !== 'string') {
                return;
            }
            if (visitedLayerValues.has(layerValue)) {
                return;
            }
            visitedLayerValues.add(layerValue);
            const proxy = Utils.safeCall(() => uiManager.getProxyAt(layerValue), null);
            const ui = Utils.safeCall(() => proxy.ui, null);
            if (!proxy || !proxy.isShow || !ui || !ui.visible) {
                return;
            }
            if (isExcludedPlaybackProxy(proxy, excludedConstructors)) {
                return;
            }
            const proxyName = getPlaybackProxyName(proxy);
            const record = {
                proxy,
                layerValue,
                layerName,
                proxyName,
                visible: !!ui.visible,
                touchable: typeof ui.touchable === 'boolean' ? ui.touchable : undefined,
            };
            try {
                ui.visible = false;
                if (record.touchable !== undefined) {
                    ui.touchable = false;
                }
                hiddenStates.push(record);
                Utils.pushDataSource(`隐藏页面 proxy ${proxyName} @${layerName}`);
            } catch (error) {
                Utils.pushDataSource(`隐藏页面 proxy 失败 ${proxyName} @${layerName}: ${getShortErrorMessage(error)}`);
            }
        });
        state.playbackHiddenProxyStates = hiddenStates;
        if (!hiddenStates.length) {
            Utils.pushDataSource(`十殿回放未发现需隐藏的页面 proxy (${source})`);
        }
        return hiddenStates.length;
    }

    function hidePlaybackHiddenLayersByNames(layerNames = [], source = 'playback') {
        const uniqueNames = Array.from(new Set((layerNames || []).filter(Boolean)));
        if (!uniqueNames.length) {
            return 0;
        }
        const layersProxy = getLayersProxyInstance();
        const children = Utils.safeCall(() => layersProxy.ui && layersProxy.ui._children, null);
        if (!layersProxy || !Array.isArray(children)) {
            Utils.pushDataSource(`隐藏页面 layer 失败: Layers proxy 不可用 (${source})`);
            return 0;
        }
        const hiddenLayerStates = [];
        uniqueNames.forEach((layerName) => {
            const layerNode = children.find((item) => item && item.name === layerName);
            if (!layerNode || !layerNode.visible) {
                return;
            }
            try {
                const existingChildren = collectLayerExistingChildren(layerNode);
                let hiddenNodeCount = 0;
                existingChildren.forEach((child, index) => {
                    if (!child || !child.visible) {
                        return;
                    }
                    hiddenLayerStates.push({
                        layerName,
                        layerNode,
                        child,
                        childName: getPlaybackLayerNodeName(child, index),
                        visible: !!child.visible,
                        touchable: typeof child.touchable === 'boolean' ? child.touchable : undefined,
                    });
                    child.visible = false;
                    if (typeof child.touchable === 'boolean') {
                        child.touchable = false;
                    }
                    hiddenNodeCount += 1;
                });
                if (hiddenNodeCount > 0) {
                    Utils.pushDataSource(`hide playback layer ${layerName} existing nodes=${hiddenNodeCount}`);
                }
            } catch (error) {
                Utils.pushDataSource(`hide playback layer failed ${layerName}: ${getShortErrorMessage(error)}`);
            }
        });
        state.playbackHiddenLayerStates = hiddenLayerStates;
        return hiddenLayerStates.length;
    }

    function restorePlaybackHiddenLayers(source = 'playback') {
        const records = Array.isArray(state.playbackHiddenLayerStates)
            ? state.playbackHiddenLayerStates
            : [];
        if (!records.length) {
            return false;
        }
        state.playbackHiddenLayerStates = [];
        records.forEach((record) => {
            if (!record || !record.child) {
                return;
            }
            try {
                record.child.visible = record.visible !== false;
                if (record.touchable !== undefined) {
                    record.child.touchable = record.touchable;
                }
                Utils.pushDataSource(`restore playback layer node ${record.layerName}/${record.childName || 'anonymous'} (${source})`);
            } catch (error) {
                Utils.pushDataSource(`restore playback layer failed ${record.layerName}/${record.childName || 'anonymous'}: ${getShortErrorMessage(error)}`);
            }
        });
        return true;
    }

    function restorePlaybackHiddenProxies(source = 'playback') {
        const records = Array.isArray(state.playbackHiddenProxyStates)
            ? state.playbackHiddenProxyStates
            : [];
        if (!records.length) {
            return false;
        }
        state.playbackHiddenProxyStates = [];
        records.forEach((record) => {
            const ui = Utils.safeCall(() => record.proxy && record.proxy.ui, null);
            if (!ui) {
                return;
            }
            try {
                ui.visible = record.visible !== false;
                if (record.touchable !== undefined) {
                    ui.touchable = record.touchable;
                }
                Utils.pushDataSource(`恢复页面 proxy ${record.proxyName || 'UnknownProxy'} @${record.layerName || record.layerValue} (${source})`);
            } catch (error) {
                Utils.pushDataSource(`恢复页面 proxy 失败 ${record.proxyName || 'UnknownProxy'} @${record.layerName || record.layerValue}: ${getShortErrorMessage(error)}`);
            }
        });
        return true;
    }

    async function ensureNightmareReplayScene(context = null, replayInput = null) {
        const bossId = resolveNightmareReplayBossId(replayInput, context);
        if (!bossId) {
            Utils.pushDataSource('十殿背景 Scene 失败: 未解析到 bossId');
            return false;
        }
        Utils.pushDataSource(`十殿背景 Scene 准备 boss=${bossId}`);
        const indexUI = Utils.safeCall(() => Runtime.getIndexUI(), null);
        const sceneClass = getNightmareBattleSceneClass();
        if (!indexUI) {
            Utils.pushDataSource('十殿背景 Scene 失败: index-ui 不可用');
            return false;
        }
        if (!sceneClass) {
            Utils.pushDataSource('十殿背景 Scene 失败: NightmareBattleScene 模块不可用');
            return false;
        }
        const existingProxy = typeof indexUI.GET_PROXY === 'function'
            ? Utils.safeCall(() => indexUI.GET_PROXY(sceneClass), null)
            : null;
        const alreadyVisible = !!(existingProxy && existingProxy.isShow);
        Utils.pushDataSource(`十殿背景 Scene 状态 boss=${bossId} visible=${alreadyVisible ? '1' : '0'} class=${sceneClass.name || 'NightmareBattleScene'}`);
        state.nightmareReplayScene = {
            active: true,
            bossId,
            openedByScript: !alreadyVisible,
        };
        try {
            Utils.safeCall(() => {
                sceneClass.bossId = bossId;
            }, null);
            if (!alreadyVisible) {
                if (typeof indexUI.SHOW_PROXY_OVER === 'function') {
                    try {
                        await Promise.resolve(indexUI.SHOW_PROXY_OVER(sceneClass));
                        Utils.pushDataSource(`十殿背景 Scene SHOW_PROXY_OVER boss=${bossId}`);
                    } catch (error) {
                        Utils.pushDataSource(`十殿背景 Scene SHOW_PROXY_OVER 失败: ${getShortErrorMessage(error)}`);
                        throw error;
                    }
                } else if (typeof indexUI.SHOW_PROXY === 'function') {
                    try {
                        await Promise.resolve(indexUI.SHOW_PROXY(sceneClass));
                        Utils.pushDataSource(`十殿背景 Scene SHOW_PROXY boss=${bossId}`);
                    } catch (error) {
                        Utils.pushDataSource(`十殿背景 Scene SHOW_PROXY 失败: ${getShortErrorMessage(error)}`);
                        throw error;
                    }
                } else {
                    Utils.pushDataSource('十殿背景 Scene 失败: index-ui 缺少 SHOW_PROXY_OVER/SHOW_PROXY');
                    state.nightmareReplayScene = null;
                    return false;
                }
            } else {
                Utils.pushDataSource(`十殿背景 Scene 复用已有 proxy boss=${bossId}`);
            }
            const liveProxy = typeof indexUI.GET_PROXY === 'function'
                ? Utils.safeCall(() => indexUI.GET_PROXY(sceneClass), null)
                : null;
            if (liveProxy && typeof liveProxy._onMapUpdate === 'function') {
                await Promise.resolve(liveProxy._onMapUpdate(bossId));
                Utils.pushDataSource(`十殿背景 Scene 直连刷新 boss=${bossId}`);
                const mapChildCount = Utils.safeCall(() => liveProxy.ui.m_container.numChildren, 0);
                if (!mapChildCount) {
                    await Promise.resolve(liveProxy._onMapUpdate(bossId));
                    Utils.pushDataSource(`十殿背景 Scene 二次刷新 boss=${bossId}`);
                }
            }
            const GlobalSignal = Utils.safeCall(() => Runtime.getGlobalSignal(), null);
            dispatchSignalEvent(GlobalSignal && GlobalSignal.EventNightmareMapUpdate, bossId);
            Utils.pushDataSource(`挂载十殿背景 Scene boss=${bossId}`);
            return true;
        } catch (error) {
            state.nightmareReplayScene = null;
            Utils.warn('ensure nightmare replay scene failed', error);
            return false;
        }
    }

    async function cleanupNightmareReplayScene(source = 'playback') {
        const sceneState = state.nightmareReplayScene;
        if (!sceneState || !sceneState.active) {
            return false;
        }
        state.nightmareReplayScene = null;
        if (!sceneState.openedByScript) {
            return false;
        }
        const indexUI = Utils.safeCall(() => Runtime.getIndexUI(), null);
        const sceneClass = getNightmareBattleSceneClass();
        if (!indexUI || !sceneClass) {
            return false;
        }
        const existingProxy = typeof indexUI.GET_PROXY === 'function'
            ? Utils.safeCall(() => indexUI.GET_PROXY(sceneClass), null)
            : null;
        if (!(existingProxy && existingProxy.isShow)) {
            return false;
        }
        const sceneUI = Utils.safeCall(() => existingProxy.ui, null);
        if (sceneUI) {
            try {
                sceneUI.visible = false;
                if (typeof sceneUI.touchable === 'boolean') {
                    sceneUI.touchable = false;
                }
                Utils.pushDataSource(`预隐藏十殿背景 Scene UI (${source})`);
            } catch (error) {
                Utils.pushDataSource(`预隐藏十殿背景 Scene UI 失败 (${source}): ${getShortErrorMessage(error)}`);
            }
        }
        if (typeof indexUI.HIDE_PROXY === 'function') {
            let timedOut = false;
            await Promise.race([
                Promise.resolve(indexUI.HIDE_PROXY(sceneClass)),
                new Promise((resolve) => {
                    setTimeout(() => {
                        timedOut = true;
                        resolve();
                    }, 1500);
                }),
            ]);
            if (timedOut) {
                Utils.pushDataSource(`清理十殿背景 Scene 超时，已保底隐藏 UI (${source})`);
            }
        } else if (typeof indexUI.CLOSE_PROXY === 'function') {
            let timedOut = false;
            await Promise.race([
                Promise.resolve(indexUI.CLOSE_PROXY(sceneClass)),
                new Promise((resolve) => {
                    setTimeout(() => {
                        timedOut = true;
                        resolve();
                    }, 1500);
                }),
            ]);
            if (timedOut) {
                Utils.pushDataSource(`关闭十殿背景 Scene 超时，已保底隐藏 UI (${source})`);
            }
        }
        Utils.pushDataSource(`清理十殿背景 Scene (${source})`);
        return true;
    }

    ensureNightmareReplayScene = async function patchedEnsureNightmareReplayScene(context = null, replayInput = null) {
        const bossId = resolveNightmareReplayBossId(replayInput, context);
        if (!bossId) {
            Utils.pushDataSource('nightmare replay scene failed: missing bossId');
            return false;
        }
        Utils.pushDataSource(`nightmare replay scene start boss=${bossId}`);
        const indexUI = Utils.safeCall(() => Runtime.getIndexUI(), null);
        if (!indexUI) {
            Utils.pushDataSource('nightmare replay scene failed: index-ui unavailable');
            return false;
        }
        const sceneClass = getNightmareBattleSceneClass();
        if (!sceneClass) {
            Utils.pushDataSource('nightmare replay scene failed: NightmareBattleScene unavailable');
            return false;
        }
        const existingProxy = typeof indexUI.GET_PROXY === 'function'
            ? Utils.safeCall(() => indexUI.GET_PROXY(sceneClass), null)
            : null;
        const alreadyVisible = !!(existingProxy && existingProxy.isShow);
        Utils.pushDataSource(`nightmare replay scene state boss=${bossId} visible=${alreadyVisible ? '1' : '0'} class=${sceneClass.name || 'NightmareBattleScene'}`);
        state.nightmareReplayScene = {
            active: true,
            bossId,
            openedByScript: !alreadyVisible,
        };
        try {
            Utils.safeCall(() => {
                sceneClass.bossId = bossId;
            }, null);
            if (!alreadyVisible) {
                if (typeof indexUI.SHOW_PROXY_OVER === 'function') {
                    await Promise.resolve(indexUI.SHOW_PROXY_OVER(sceneClass));
                    Utils.pushDataSource(`nightmare replay scene SHOW_PROXY_OVER boss=${bossId}`);
                } else if (typeof indexUI.SHOW_PROXY === 'function') {
                    await Promise.resolve(indexUI.SHOW_PROXY(sceneClass));
                    Utils.pushDataSource(`nightmare replay scene SHOW_PROXY boss=${bossId}`);
                } else {
                    Utils.pushDataSource('nightmare replay scene failed: missing SHOW_PROXY_OVER/SHOW_PROXY');
                    state.nightmareReplayScene = null;
                    return false;
                }
            } else {
                Utils.pushDataSource(`nightmare replay scene reuse existing proxy boss=${bossId}`);
            }
            const liveProxy = typeof indexUI.GET_PROXY === 'function'
                ? Utils.safeCall(() => indexUI.GET_PROXY(sceneClass), null)
                : null;
            const liveProxyUI = Utils.safeCall(() => liveProxy && liveProxy.ui, null);
            if (liveProxyUI) {
                try {
                    liveProxyUI.visible = true;
                    if (typeof liveProxyUI.touchable === 'boolean') {
                        liveProxyUI.touchable = true;
                    }
                } catch (error) {
                    Utils.pushDataSource(`nightmare replay scene ui restore failed boss=${bossId}: ${getShortErrorMessage(error)}`);
                }
            }
            if (liveProxy && typeof liveProxy._onMapUpdate === 'function') {
                try {
                    await Promise.resolve(liveProxy._onMapUpdate(bossId));
                    Utils.pushDataSource(`nightmare replay scene map refresh boss=${bossId}`);
                    const mapChildCount = Utils.safeCall(() => liveProxy.ui.m_container.numChildren, 0);
                    if (!mapChildCount) {
                        await Promise.resolve(liveProxy._onMapUpdate(bossId));
                        Utils.pushDataSource(`nightmare replay scene map refresh retry boss=${bossId}`);
                    }
                } catch (error) {
                    Utils.pushDataSource(`nightmare replay scene map refresh failed: ${getShortErrorMessage(error)}`);
                }
            } else if (!liveProxy) {
                Utils.pushDataSource(`nightmare replay scene warning: liveProxy missing boss=${bossId}`);
            } else {
                Utils.pushDataSource(`nightmare replay scene warning: _onMapUpdate unavailable boss=${bossId}`);
            }
            const GlobalSignal = Utils.safeCall(() => Runtime.getGlobalSignal(), null);
            const dispatched = dispatchSignalEvent(GlobalSignal && GlobalSignal.EventNightmareMapUpdate, bossId);
            Utils.pushDataSource(`nightmare replay scene dispatch boss=${bossId} dispatched=${dispatched ? '1' : '0'}`);
            const hiddenCount = hidePlaybackVisibleProxiesExcept([sceneClass], `nightmare:boss=${bossId}`);
            const visibleLayerNames = collectPlaybackVisibleLayerNames(`nightmare:boss=${bossId}`);
            const hiddenLayerCount = hidePlaybackHiddenLayersByNames(
                visibleLayerNames,
                `nightmare:boss=${bossId}`,
            );
            Utils.pushDataSource(`nightmare replay page hide count=${hiddenCount}`);
            Utils.pushDataSource(`nightmare replay layer hide count=${hiddenLayerCount}`);
            Utils.pushDataSource(`nightmare replay scene mounted boss=${bossId}`);
            return true;
        } catch (error) {
            state.nightmareReplayScene = null;
            Utils.pushDataSource(`nightmare replay scene failed boss=${bossId}: ${getShortErrorMessage(error)}`);
            Utils.warn('patched ensure nightmare replay scene failed', error);
            return false;
        }
    };

    function captureBattleInput(inputData, source) {
        if (!inputData || !inputData.battleData || isPvpBattleInput(inputData) || shouldSkipBattleInputCapture(inputData)) {
            return;
        }
        const modeKey = resolveModeKeyFromBattleData(inputData.battleData, inputData);
        state.latestCapture = {
            input: Utils.deepClone(inputData),
            source,
            modeKey,
            capturedAt: Utils.now(),
        };
        updateReusableBattleSkeleton(inputData.battleData, {
            source,
            modeKey,
        });
        if (modeKey && state.modeCaches[modeKey]) {
            state.modeCaches[modeKey] = Object.assign({}, state.modeCaches[modeKey], {
                inputData: Utils.deepClone(inputData),
                capturedAt: Utils.now(),
            });
        } else if (modeKey && modeKey !== 'capture') {
            state.modeCaches[modeKey] = {
                modeKey,
                inputData: Utils.deepClone(inputData),
                battleData: Utils.deepClone(inputData.battleData),
                capturedAt: Utils.now(),
            };
        }
        Utils.pushDataSource(`捕获战斗输入 ${source} -> ${MODE_LABELS[modeKey] || modeKey}`);
        recordDiagnosticSample('battleInput', {
            modeKey,
            source,
            inputData,
            battleResult: extractBattleResultFromInput(inputData),
        });
    }

    Runtime.patchBattleCapture = function patchBattleCapture() {
        if (state.runtimePatched) {
            return;
        }
        const battleUIManager = Utils.safeCall(() => this.getBattleUIManager(), null);
        if (battleUIManager) {
            ['SHOW_BATTLE_UI', 'SHOW_BATTLE_REPLAY_UI'].forEach((methodName) => {
                if (!battleUIManager[methodName] || battleUIManager[methodName].__nonPvpSimPatched) {
                    return;
                }
                const original = battleUIManager[methodName];
                battleUIManager[methodName] = function patchedBattleUI(inputData, ...rest) {
                    try {
                        captureBattleInput(inputData, methodName);
                    } catch (error) {
                        Utils.warn(`${methodName} 捕获失败`, error);
                    }
                    return original.call(this, inputData, ...rest);
                };
                battleUIManager[methodName].__nonPvpSimPatched = true;
                battleUIManager[methodName].__original = original;
            });
        }

        const dataIndex = Utils.safeCall(() => this.getDataIndex(), null);
        if (dataIndex) {
            this.patchPromiseMethod(dataIndex.FightService, 'startTower', (resp) => {
                const battleData = extractBattleDataFromResponse(resp);
                if (!battleData) {
                    return;
                }
                const towerModule = this.getModuleByTypeKey('TOWER');
                const context = {
                    stageId: Utils.safeCall(() => towerModule.curStageInfo.id, null),
                    towerEnerge: Utils.safeCall(() => towerModule.towerEnerge, null),
                    monster: Utils.safeCall(() => towerModule.curStageInfo.monster, null),
                };
                captureAuthorityBattle('tower', battleData, {
                    context,
                    source: 'FightService.startTower',
                });
            });
            this.patchPromiseMethod(dataIndex.FightService, 'startGenie', (resp, args) => {
                const battleData = extractBattleDataFromResponse(resp);
                if (!battleData) {
                    return;
                }
                const genieId = args && args[0] ? args[0].genieId : null;
                captureAuthorityBattle('genie', battleData, {
                    context: {
                        genieId,
                        genieLevelId: getOptionValue(Utils.safeCall(() => battleData.options, null), 'genieLevelId', null),
                        battleTeam: args && args[0] ? Utils.deepClone(args[0].battleTeam) : null,
                        lordWeaponId: args && args[0] ? args[0].lordWeaponId : null,
                    },
                    source: 'FightService.startGenie',
                });
            });
            this.patchPromiseMethod(dataIndex.FightService, 'startLegionBoss', (resp) => {
                const battleData = extractBattleDataFromResponse(resp);
                if (!battleData) {
                    return;
                }
                const legionModule = this.getModuleByTypeKey('LEGION');
                const currentBossInfo = Utils.safeCall(() => legionModule.currentBossInfo, null)
                    || Utils.safeCall(() => legionModule.legion.currentBossInfo, null)
                    || Utils.safeCall(() => legionModule.legion.currentBoss, null);
                const currentHp = Utils.safeCall(() => legionModule.legion.currentBoss.currentHP, null)
                    || Utils.safeCall(() => legionModule.currentBoss.currentHP, null)
                    || Utils.safeCall(() => currentBossInfo.currentHP, null);
                const context = {
                    legionBossId: getNumericFieldValue(currentBossInfo || {}, ['legionBossId', 'id', 'ID'], null),
                    legionBossShow: getNumericFieldValue(currentBossInfo || {}, ['legionBossShow'], null),
                    legionBossZhanLi: getNumericFieldValue(currentBossInfo || {}, ['legionBossZhanLi', 'power'], null),
                    monster: Utils.safeCall(() => currentBossInfo.monsters, null),
                    currentHp: currentHp != null ? Number(currentHp) : null,
                };
                captureAuthorityBattle('legionBoss', battleData, {
                    context,
                    source: 'FightService.startLegionBoss',
                });
            });
            this.patchPromiseMethod(dataIndex.EvoTowerService, 'readyFight', (resp) => {
                const battleData = extractBattleDataFromResponse(resp);
                const evoModule = this.getModuleByTypeKey('EVOTOWER');
                const fallbackBattleData = Utils.safeCall(() => evoModule.readyFightResp.battleData, null);
                const authorityBattleData = battleData || fallbackBattleData;
                if (!authorityBattleData) {
                    return;
                }
                captureAuthorityBattle('evoTower', authorityBattleData, {
                    context: {
                        towerId: Utils.safeCall(() => evoModule.curStageInfo.id, null),
                        rawTowerId: Utils.safeCall(() => evoModule.curTowerId, null),
                        energy: Utils.safeCall(() => evoModule.evoTower.energy, null),
                        monster: Utils.safeCall(() => evoModule.curStageInfo.monster, null),
                    },
                    source: 'EvoTowerService.readyFight',
                });
            });
            this.patchPromiseMethod(dataIndex.NMExtService, 'startBoss', (resp, args) => {
                const battleData = extractBattleDataFromResponse(resp);
                const data = extractResponseData(resp);
                if (!battleData) {
                    return;
                }
                captureAuthorityBattle('nightmareStar', battleData, {
                    context: {
                        bossId: args && args[0] ? args[0].bossId : null,
                        battleTeam: args && args[0] ? Utils.deepClone(args[0].battleTeam) : null,
                        lordWeaponId: args && args[0] ? args[0].lordWeaponId : null,
                        nowStarIdxList: data && data.nowStarIdxList ? Utils.deepClone(data.nowStarIdxList) : [],
                    },
                    source: 'NMExtService.startBoss',
                });
            });
        }

        const GlobalSignal = Utils.safeCall(() => this.getGlobalSignal(), null);
        if (GlobalSignal && GlobalSignal.EventNightmareBattleStart) {
            this.patchSignalDispatch(GlobalSignal.EventNightmareBattleStart, (payload) => {
                const battleData = payload && payload.battleData ? payload.battleData : null;
                if (!battleData) {
                    return;
                }
                captureAuthorityBattle('nightmare', battleData, {
                    context: {
                        bossId: payload.bossCfgId || null,
                        roleId: payload.roleId || null,
                    },
                    source: 'EventNightmareBattleStart',
                });
            });
        }

        state.runtimePatched = true;
        Utils.pushDataSource('运行时捕获补丁已安装');
    };

    function normalizeTeamEntries(team) {
        if (!team) {
            return [];
        }
        const result = [];
        if (team instanceof Map) {
            team.forEach((entry, pos) => {
                result.push({ pos: Number(pos), entry });
            });
        } else if (Array.isArray(team)) {
            team.forEach((entry, index) => {
                const pos = entry && entry.pos != null ? entry.pos : index + 1;
                result.push({ pos: Number(pos), entry });
            });
        } else if (typeof team === 'object') {
            Object.keys(team).forEach((key) => {
                result.push({ pos: Number(key), entry: team[key] });
            });
        }
        result.sort((left, right) => left.pos - right.pos);
        return result;
    }

    function rebuildTeamLike(template, entries) {
        if (template instanceof Map) {
            const map = new Map();
            entries.forEach(({ pos, entry }) => map.set(pos, entry));
            return map;
        }
        if (Array.isArray(template)) {
            return entries.map(({ entry }) => entry);
        }
        const object = {};
        entries.forEach(({ pos, entry }) => {
            object[pos] = entry;
        });
        return object;
    }

    function extractHeroId(entry) {
        if (!entry || typeof entry !== 'object') {
            return 0;
        }
        return Number(
            entry.id != null ? entry.id
                : entry.heroId != null ? entry.heroId
                    : entry.cfgId != null ? entry.cfgId
                        : entry.monsterId != null ? entry.monsterId
                            : entry.heroID != null ? entry.heroID
                                : 0,
        );
    }

    function getCurrentTeamSignatureFromBattleData(battleData) {
        if (!battleData || !battleData.leftTeam || !battleData.leftTeam.team) {
            return '';
        }
        const teamPart = normalizeTeamEntries(battleData.leftTeam.team)
            .map(({ pos, entry }) => `${pos}:${extractHeroId(entry)}`)
            .join('|');
        const weaponId = battleData.leftTeam.weaponId || 0;
        const raw = `${teamPart}|weapon:${weaponId}`;
        return `${Utils.hashString(raw).toString(16)}:${raw}`;
    }

    function createTeamParamMap(candidate) {
        const map = new Map();
        (candidate && candidate.battleTeam ? candidate.battleTeam : []).forEach((item) => {
            map.set(Number(item.pos), Number(item.heroId));
        });
        return map;
    }

    function getRoleDisplayMeta() {
        const role = Utils.safeCall(() => Runtime.getRole(), null);
        if (!role) {
            return {
                name: '',
                headImg: '',
                roleId: 0,
            };
        }
        return {
            name: role.nickName || role.name || '',
            headImg: role.headImg || role.headPic || role.avatar || '',
            roleId: Number(role.roleId || role.id || 0),
        };
    }

    function listCollectionValues(collection) {
        if (!collection) {
            return [];
        }
        if (collection instanceof Map) {
            return Array.from(collection.values());
        }
        if (Array.isArray(collection)) {
            return collection.slice();
        }
        if (typeof collection.forEach === 'function') {
            const result = [];
            Utils.safeCall(() => collection.forEach((value) => {
                result.push(value);
            }), null);
            if (result.length) {
                return result;
            }
        }
        if (typeof collection === 'object') {
            return Object.keys(collection).map((key) => collection[key]);
        }
        return [];
    }

    function extractRoleHeroId(hero) {
        if (!hero || typeof hero !== 'object') {
            return 0;
        }
        return Number(
            hero.heroId != null ? hero.heroId
                : hero.id != null ? hero.id
                    : hero.heroID != null ? hero.heroID
                        : 0,
        );
    }

    function normalizeBattleTeamState(value) {
        if (value == null) {
            return null;
        }
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                return null;
            }
            if (value <= 0) {
                return false;
            }
            if (value < 20) {
                return true;
            }
            return null;
        }
        if (typeof value === 'string') {
            const text = value.trim().toLowerCase();
            if (!text) {
                return null;
            }
            if (['true', 'yes', 'y', 'on', 'battle', 'inbattle', 'in_team', 'inteam'].includes(text)) {
                return true;
            }
            if (['false', 'no', 'n', 'off', 'none', 'out', 'idle'].includes(text)) {
                return false;
            }
            const numeric = Number(text);
            if (Number.isFinite(numeric)) {
                return normalizeBattleTeamState(numeric);
            }
        }
        return null;
    }

    function isHeroCurrentlyInBattleTeam(hero) {
        if (!hero || typeof hero !== 'object') {
            return false;
        }
        const methodChecks = [
            Utils.safeCall(() => typeof hero.isInBattleTeam === 'function' ? hero.isInBattleTeam() : null, null),
            Utils.safeCall(() => typeof hero.getIsInBattleTeam === 'function' ? hero.getIsInBattleTeam() : null, null),
        ];
        for (let i = 0; i < methodChecks.length; i += 1) {
            const normalized = normalizeBattleTeamState(methodChecks[i]);
            if (normalized != null) {
                return normalized;
            }
        }
        const flagChecks = [
            hero.isInBattleTeam,
            hero.isInBattle,
            hero.inBattle,
            hero.inBattleTeam,
            hero.isBattle,
            hero.isFighting,
            hero.battleTeamFlag,
            hero.teamState,
            hero.battleState,
            hero.embattleState,
        ];
        for (let i = 0; i < flagChecks.length; i += 1) {
            const normalized = normalizeBattleTeamState(flagChecks[i]);
            if (normalized != null) {
                return normalized;
            }
        }
        const posChecks = [
            hero.slot,
            hero.pos,
            hero.battlePos,
            hero.teamPos,
            hero.position,
            hero.lineupPos,
            hero.teamIndex,
            hero.teamSlot,
        ];
        for (let i = 0; i < posChecks.length; i += 1) {
            const value = Number(posChecks[i]);
            if (Number.isFinite(value) && value >= 0 && value < 20) {
                return true;
            }
        }
        return false;
    }

    function findNextFriendlyPos(usedPositions, zeroBased) {
        const start = zeroBased ? 0 : 1;
        const end = start + 5;
        for (let pos = start; pos < end; pos += 1) {
            if (!usedPositions.has(pos)) {
                return pos;
            }
        }
        let fallback = start;
        while (usedPositions.has(fallback)) {
            fallback += 1;
        }
        return fallback;
    }

    function normalizeFriendlyPosHint(rawPos, zeroBased) {
        const pos = Number(rawPos);
        if (!Number.isFinite(pos) || pos < 0 || pos >= 20) {
            return null;
        }
        if (zeroBased && pos >= 1 && pos <= 5) {
            return pos - 1;
        }
        return pos;
    }

    function resolveHeroBattlePos(hero, zeroBased, fallbackPos = null) {
        const candidates = [
            Utils.safeCall(() => typeof hero.getBattlePos === 'function' ? hero.getBattlePos() : null, null),
            Utils.safeCall(() => typeof hero.getTeamPos === 'function' ? hero.getTeamPos() : null, null),
            Utils.safeCall(() => typeof hero.getPos === 'function' ? hero.getPos() : null, null),
            Utils.safeCall(() => typeof hero.getSlot === 'function' ? hero.getSlot() : null, null),
            hero.slot,
            hero.pos,
            hero.battlePos,
            hero.teamPos,
            hero.position,
            hero.lineupPos,
            hero.teamIndex,
            hero.teamSlot,
            hero.index,
        ];
        for (let i = 0; i < candidates.length; i += 1) {
            const normalized = normalizeFriendlyPosHint(candidates[i], zeroBased);
            if (normalized != null) {
                return normalized;
            }
        }
        return fallbackPos;
    }

    function findKnownTeamEntryByHeroId(heroId, preferredBattleData = null) {
        const searchBattleData = (battleData) => {
            const entries = normalizeTeamEntries(Utils.safeCall(() => battleData.leftTeam.team, null));
            for (let i = 0; i < entries.length; i += 1) {
                if (extractHeroId(entries[i].entry) === heroId) {
                    return Utils.deepClone(entries[i].entry);
                }
            }
            return null;
        };
        const searchCandidate = (candidate) => {
            const entries = Utils.fromSerializable(candidate && candidate.teamEntries ? candidate.teamEntries : []);
            if (!Array.isArray(entries)) {
                return null;
            }
            for (let i = 0; i < entries.length; i += 1) {
                if (extractHeroId(entries[i] && entries[i].entry) === heroId) {
                    return Utils.deepClone(entries[i].entry);
                }
            }
            return null;
        };
        const battleDataSources = [
            preferredBattleData,
            state.reusableSkeleton,
            Utils.safeCall(() => state.latestCapture.input.battleData, null),
        ];
        Object.keys(state.modeCaches || {}).forEach((key) => {
            battleDataSources.push(Utils.safeCall(() => state.modeCaches[key].battleData, null));
        });
        for (let i = 0; i < battleDataSources.length; i += 1) {
            const matched = searchBattleData(battleDataSources[i]);
            if (matched) {
                return matched;
            }
        }
        for (let i = 0; i < state.candidates.length; i += 1) {
            const matched = searchCandidate(state.candidates[i]);
            if (matched) {
                return matched;
            }
        }
        return null;
    }

    function buildBattleEntryFromRoleHero(hero, heroId, pos) {
        if (!hero || typeof hero !== 'object' || !heroId) {
            return null;
        }
        return {
            id: heroId,
            heroId,
            type: Number(hero.type != null ? hero.type : 0),
            index: Number(pos),
            level: Number(hero.level != null ? hero.level : hero.lv != null ? hero.lv : hero.heroLv != null ? hero.heroLv : 1),
            attack: Number(hero.attack != null ? hero.attack : hero.atk != null ? hero.atk : 0),
            defense: Number(hero.defense != null ? hero.defense : hero.def != null ? hero.def : 0),
            curHp: Number(hero.curHp != null ? hero.curHp : hero.hp != null ? hero.hp : hero.maxHp != null ? hero.maxHp : 0),
            hp: Number(hero.hp != null ? hero.hp : hero.maxHp != null ? hero.maxHp : hero.curHp != null ? hero.curHp : 0),
            curEnergy: Number(hero.curEnergy != null ? hero.curEnergy : -1),
            speed: Number(hero.speed != null ? hero.speed : hero.spd != null ? hero.spd : 0),
            color: Number(hero.color != null ? hero.color : 0),
            star: Number(hero.star != null ? hero.star : 0),
            order: Number(hero.order != null ? hero.order : hero.awakenOrder != null ? hero.awakenOrder : 0),
            skin: Number(hero.skin != null ? hero.skin : hero.skinId != null ? hero.skinId : 0),
            skinName: hero.skinName || '',
            activeSkill: Number(hero.activeSkill != null ? hero.activeSkill : hero.activeSkillId != null ? hero.activeSkillId : 0),
            attribute: hero.attribute || new Map(),
            skill: Array.isArray(hero.skill) ? hero.skill.slice() : [],
            recordFlag: !!hero.recordFlag,
        };
    }

    function getTeamSignatureFromEntries(entries, weaponId = 0) {
        const teamPart = (entries || [])
            .map(({ pos, entry }) => `${pos}:${extractHeroId(entry)}`)
            .join('|');
        const raw = `${teamPart}|weapon:${Number(weaponId || 0)}`;
        return `${Utils.hashString(raw).toString(16)}:${raw}`;
    }

    function extractBattleTeamFromRole(role) {
        var bt = role && role.battleTeam;
        if (!bt) return null;
        var result = new Map();
        try {
            if (typeof bt.forEach === 'function') {
                bt.forEach(function (heroData, slot) {
                    if (heroData && heroData.heroId) {
                        result.set(Number(heroData.heroId), Number(slot));
                    }
                });
            } else if (typeof bt.entries === 'function') {
                for (var pair of bt.entries()) {
                    if (pair[1] && pair[1].heroId) {
                        result.set(Number(pair[1].heroId), Number(pair[0]));
                    }
                }
            } else if (typeof bt === 'object') {
                Object.keys(bt).forEach(function (slot) {
                    var heroData = bt[slot];
                    if (heroData && heroData.heroId) {
                        result.set(Number(heroData.heroId), Number(slot));
                    }
                });
            }
        } catch (e) {}
        return result.size > 0 ? result : null;
    }

    function buildRealtimeTeamEntries(reusable) {
        const role = Utils.safeCall(() => Runtime.getRole(), null);
        const heroes = listCollectionValues(role && role.heroes);
        if (!heroes.length) {
            return null;
        }
        const reusableEntries = normalizeTeamEntries(Utils.safeCall(() => reusable.leftTeam.team, null));
        const zeroBased = reusableEntries.some((item) => Number(item.pos) === 0);
        const reusablePosByHeroId = new Map();
        reusableEntries.forEach(({ pos, entry }) => {
            const heroId = extractHeroId(entry);
            if (heroId > 0 && !reusablePosByHeroId.has(heroId)) {
                reusablePosByHeroId.set(heroId, Number(pos));
            }
        });
        const liveBattleTeam = Utils.safeCall(() => extractBattleTeamFromRole(role), null);
        var activeHeroes;
        if (liveBattleTeam && liveBattleTeam.size > 0) {
            activeHeroes = heroes
                .map((hero) => ({
                    hero,
                    heroId: extractRoleHeroId(hero),
                }))
                .filter((item) => item.heroId > 0 && liveBattleTeam.has(item.heroId));
        } else {
            activeHeroes = heroes
                .map((hero) => ({
                    hero,
                    heroId: extractRoleHeroId(hero),
                }))
                .filter((item) => item.heroId > 0 && isHeroCurrentlyInBattleTeam(item.hero));
        }
        if (!activeHeroes.length) {
            return null;
        }
        activeHeroes.sort((left, right) => {
            const leftLive = liveBattleTeam ? liveBattleTeam.get(left.heroId) : undefined;
            const rightLive = liveBattleTeam ? liveBattleTeam.get(right.heroId) : undefined;
            const leftPos = leftLive != null ? leftLive : resolveHeroBattlePos(left.hero, zeroBased, reusablePosByHeroId.get(left.heroId));
            const rightPos = rightLive != null ? rightLive : resolveHeroBattlePos(right.hero, zeroBased, reusablePosByHeroId.get(right.heroId));
            if (leftPos != null && rightPos != null && leftPos !== rightPos) {
                return leftPos - rightPos;
            }
            if (leftPos != null && rightPos == null) {
                return -1;
            }
            if (leftPos == null && rightPos != null) {
                return 1;
            }
            return left.heroId - right.heroId;
        });
        const usedPositions = new Set();
        const entries = [];
        activeHeroes.forEach((item) => {
            var livePos = liveBattleTeam ? liveBattleTeam.get(item.heroId) : undefined;
            let pos = livePos != null ? livePos : resolveHeroBattlePos(item.hero, zeroBased, null);
            if (pos == null) {
                pos = reusablePosByHeroId.get(item.heroId);
            }
            if (pos == null || usedPositions.has(pos)) {
                pos = findNextFriendlyPos(usedPositions, zeroBased);
            }
            usedPositions.add(pos);
            let entry = findKnownTeamEntryByHeroId(item.heroId, reusable);
            if (!entry) {
                entry = buildBattleEntryFromRoleHero(item.hero, item.heroId, pos);
            }
            if (!entry) {
                return;
            }
            entry = Utils.deepClone(entry);
            entry.id = item.heroId;
            entry.heroId = item.heroId;
            entry.type = Number(entry.type != null ? entry.type : 0);
            entry.index = Number(pos);
            entries.push({ pos, entry });
        });
        if (!entries.length) {
            return null;
        }
        entries.sort((left, right) => left.pos - right.pos);
        return {
            entries,
            battleTeam: entries.map(({ pos, entry }) => ({
                pos,
                heroId: extractHeroId(entry),
            })),
        };
    }

    function captureCurrentTeamSnapshot(limitations = null) {
        let reusable = Runtime.getReusableBattleSkeleton(false);
        if ((!reusable || !reusable.leftTeam || !reusable.leftTeam.team) && restoreReusableSkeletonFromCandidates()) {
            reusable = Runtime.getReusableBattleSkeleton(false);
        }
        if (!reusable || !reusable.leftTeam || !reusable.leftTeam.team) {
            throw new Error('未找到当前阵容骨架，请先进入主线或产生一场可捕获的非PVP战斗');
        }
        const roleMeta = getRoleDisplayMeta();
        const realtime = buildRealtimeTeamEntries(reusable);
        const entries = realtime && realtime.entries && realtime.entries.length
            ? realtime.entries
            : normalizeTeamEntries(reusable.leftTeam.team);
        const battleTeam = realtime && realtime.battleTeam && realtime.battleTeam.length
            ? realtime.battleTeam
            : entries.map(({ pos, entry }) => ({
                pos,
                heroId: extractHeroId(entry),
            }));
        const signature = realtime && realtime.entries && realtime.entries.length
            ? getTeamSignatureFromEntries(entries, reusable.leftTeam.weaponId || 0)
            : getCurrentTeamSignatureFromBattleData(reusable);
        if (signature) {
            state.lastKnownSignature = signature;
        }
        if (realtime && realtime.entries && realtime.entries.length) {
            Utils.pushDataSource(`获取当前阵容使用实时上阵队伍 ${signature}`);
        } else {
            Utils.pushDataSource(`获取当前阵容回退到骨架阵容 ${signature}`);
        }
        const liveWeaponId = Utils.safeCall(() => {
            var r = Runtime.getRole();
            return r && r.lordWeaponId != null ? Number(r.lordWeaponId) : 0;
        }, 0) || reusable.leftTeam.weaponId || 0;
        const candidate = {
            id: `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            capturedAt: Utils.now(),
            sourceMode: Runtime.getBattleModeName(reusable.mode) || 'unknown',
            signature,
            lordWeaponId: liveWeaponId,
            battleTeam,
            limitations,
            leftTeamMeta: Utils.toSerializable({
                headImg: reusable.leftTeam.headImg || roleMeta.headImg,
                name: reusable.leftTeam.name || roleMeta.name,
                legionName: reusable.leftTeam.legionName,
                roleId: reusable.leftTeam.roleId || roleMeta.roleId,
                power: reusable.leftTeam.power,
                legacyColor: reusable.leftTeam.legacyColor,
                tapAttack: reusable.leftTeam.tapAttack,
                lordSkill: reusable.leftTeam.lordSkill,
                lordAttackTime: reusable.leftTeam.lordAttackTime,
                lordSkinId: reusable.leftTeam.lordSkinId,
                weaponId: liveWeaponId,
                weaponActiveLevelId: reusable.leftTeam.weaponActiveLevelId,
                lordAutoAttackTime: reusable.leftTeam.lordAutoAttackTime,
                avatarFrame: reusable.leftTeam.avatarFrame,
                attributeBonus: reusable.leftTeam.attributeBonus,
                customCard: reusable.leftTeam.customCard,
                levelWeaponSkillId: reusable.leftTeam.levelWeaponSkillId,
                teamInfo: reusable.leftTeam.teamInfo,
                options: reusable.leftTeam.options,
            }),
            teamEntries: Utils.toSerializable(entries.map(({ pos, entry }) => ({
                pos,
                entry: Utils.deepClone(entry),
            }))),
        };
        if (syncReusableSkeletonFromCandidate(candidate, reusable, 'captureCurrentTeamSnapshot')) {
            Utils.pushDataSource(`当前阵容已同步到可复用骨架 ${signature}`);
        }
        return candidate;
    }

    function applyCandidateToBattleData(battleData, candidate) {
        if (!battleData || !battleData.leftTeam || !candidate) {
            return battleData;
        }
        const restoredEntries = Utils.fromSerializable(candidate.teamEntries || []);
        if (restoredEntries && restoredEntries.length) {
            battleData.leftTeam.team = rebuildTeamLike(
                battleData.leftTeam.team,
                restoredEntries.map(({ pos, entry }) => ({
                    pos: Number(pos),
                    entry: Utils.deepClone(entry),
                })),
            );
        }
        const leftTeamMeta = Utils.fromSerializable(candidate.leftTeamMeta || {});
        const copyKeys = [
            'headImg',
            'name',
            'legionName',
            'roleId',
            'power',
            'legacyColor',
            'tapAttack',
            'lordSkill',
            'lordAttackTime',
            'lordSkinId',
            'weaponId',
            'weaponActiveLevelId',
            'lordAutoAttackTime',
            'avatarFrame',
            'attributeBonus',
            'customCard',
            'levelWeaponSkillId',
            'teamInfo',
            'options',
        ];
        copyKeys.forEach((key) => {
            if (leftTeamMeta[key] !== undefined) {
                battleData.leftTeam[key] = Utils.deepClone(leftTeamMeta[key]);
            }
        });
        return battleData;
    }

    function ensureArrayValue(value) {
        return Array.isArray(value) ? value : [];
    }

    function ensureMapValue(value) {
        if (value instanceof Map) {
            return value;
        }
        if (Array.isArray(value)) {
            return new Map(value);
        }
        if (value && value.__type === 'Map' && Array.isArray(value.value)) {
            return new Map(value.value);
        }
        if (value && typeof value === 'object') {
            return new Map(Object.keys(value).map((key) => [key, value[key]]));
        }
        return new Map();
    }

    function ensureStringValue(value) {
        return value == null ? '' : String(value);
    }

    function normalizeBattleSideMeta(side, isEnemy = false) {
        if (!side || typeof side !== 'object') {
            return;
        }
        const roleMeta = !isEnemy ? getRoleDisplayMeta() : null;
        side.name = ensureStringValue(side.name);
        side.headImg = ensureStringValue(side.headImg);
        side.legionName = ensureStringValue(side.legionName);
        if (!isEnemy) {
            if (!side.name && roleMeta && roleMeta.name) {
                side.name = roleMeta.name;
            }
            if (!side.headImg && roleMeta && roleMeta.headImg) {
                side.headImg = roleMeta.headImg;
            }
            if (!side.roleId && roleMeta && roleMeta.roleId) {
                side.roleId = roleMeta.roleId;
            }
        }
        side.lordSkill = ensureArrayValue(side.lordSkill);
        side.lordAttackTime = ensureArrayValue(side.lordAttackTime);
        side.lordAutoAttackTime = ensureArrayValue(side.lordAutoAttackTime);
        side.levelWeaponSkillId = ensureArrayValue(side.levelWeaponSkillId);
        side.options = ensureMapValue(side.options);
        side.teamInfo = ensureMapValue(side.teamInfo);
        side.attributeBonus = ensureMapValue(side.attributeBonus);
        if (!side.team) {
            side.team = new Map();
        }
        normalizeTeamEntries(side.team).forEach(({ entry }) => {
            if (!entry || typeof entry !== 'object') {
                return;
            }
            entry.skinName = ensureStringValue(entry.skinName);
            entry.skill = ensureArrayValue(entry.skill);
            entry.attribute = ensureMapValue(entry.attribute);
            entry.enchantMap = ensureMapValue(entry.enchantMap);
            if (isEnemy) {
                delete entry.monsterId;
                delete entry.template;
                delete entry.monsterLv;
                delete entry.cfgId;
                delete entry.heroId;
                delete entry.pos;
            }
        });
    }

    function collectBattleDataWarnings(battleData) {
        const warnings = [];
        const pushWarning = (field, value) => {
            warnings.push({
                field,
                valueType: value === null ? 'null' : typeof value,
            });
        };
        const inspectSide = (side, sideName, inspectRuntimeArrays = false) => {
            if (!side || typeof side !== 'object') {
                pushWarning(sideName, side);
                return;
            }
            ['name', 'headImg', 'legionName'].forEach((key) => {
                const value = side[key];
                if (value == null) {
                    pushWarning(`${sideName}.${key}`, value);
                }
            });
            if (inspectRuntimeArrays) {
                ['lordSkill', 'lordAttackTime', 'lordAutoAttackTime'].forEach((key) => {
                    const value = side[key];
                    if (value == null) {
                        pushWarning(`${sideName}.${key}`, value);
                    }
                });
            }
            normalizeTeamEntries(side.team).forEach(({ pos, entry }) => {
                if (!entry || typeof entry !== 'object') {
                    pushWarning(`${sideName}.team.${pos}`, entry);
                    return;
                }
                if (entry.skinName == null) {
                    pushWarning(`${sideName}.team.${pos}.skinName`, entry.skinName);
                }
                if (entry.attribute == null) {
                    pushWarning(`${sideName}.team.${pos}.attribute`, entry.attribute);
                }
                if (entry.enchantMap == null) {
                    pushWarning(`${sideName}.team.${pos}.enchantMap`, entry.enchantMap);
                }
                if (entry.skill == null) {
                    pushWarning(`${sideName}.team.${pos}.skill`, entry.skill);
                }
            });
        };
        inspectSide(battleData && battleData.leftTeam, 'leftTeam', true);
        inspectSide(battleData && battleData.rightTeam, 'rightTeam', false);
        return warnings;
    }

    function buildBattleResultTeamInfoShell(team, isEnemy = false) {
        return normalizeTeamEntries(Utils.safeCall(() => team && team.team, null)).map(({ pos, entry }) => ({
            heroId: extractHeroId(entry),
            color: Number(entry && entry.color != null ? entry.color : 0),
            level: Number(entry && entry.level != null ? entry.level : 0),
            order: Number(entry && entry.order != null ? entry.order : 0),
            index: Number(entry && entry.index != null ? entry.index : pos),
            rage: 0,
            club: Number(entry && entry.club != null ? entry.club : 0),
            slot: Number(pos),
            star: Number(entry && entry.star != null ? entry.star : 0),
            damage: 0,
            takeDamage: 0,
            treatment: 0,
            hp: Number(entry && entry.curHp != null ? entry.curHp : entry && entry.hp != null ? entry.hp : 0),
            energy: 0,
            skin: Number(entry && entry.skin != null ? entry.skin : 0),
            skinName: ensureStringValue(entry && entry.skinName),
            type: Number(entry && entry.type != null ? entry.type : isEnemy ? 1 : 0),
            maxAttr: new Map(),
            statistic: new Map(),
            skillDamage: new Map(),
            skillTreatment: new Map(),
        }));
    }

    function buildBattleResultSideShell(team, isEnemy = false) {
        const teamInfo = buildBattleResultTeamInfoShell(team, isEnemy);
        const currentHp = sumTeamHp(teamInfo);
        return {
            roleId: Number(team && team.roleId != null ? team.roleId : 0),
            name: ensureStringValue(team && team.name),
            headImg: ensureStringValue(team && team.headImg),
            avatarFrame: Utils.deepClone(team && team.avatarFrame ? team.avatarFrame : { id: 0, expire: 0 }),
            power: Number(team && team.power != null ? team.power : 0),
            teamInfo,
            ext: new Map([['curHP', currentHp]]),
        };
    }

    function buildFreshBattleRuntimeResult(battleData, previousResult = null) {
        const baseResult = previousResult && typeof previousResult === 'object' && !Array.isArray(previousResult)
            ? Utils.deepClone(previousResult)
            : {};
        const sponsor = buildBattleResultSideShell(Utils.safeCall(() => battleData.leftTeam, null), false);
        const accept = buildBattleResultSideShell(Utils.safeCall(() => battleData.rightTeam, null), true);
        return Object.assign(baseResult, {
            id: Number(battleData && battleData.id ? battleData.id : 0),
            seed: Number(battleData && battleData.randomSeed ? battleData.randomSeed : 0),
            version: Number(battleData && battleData.version != null ? battleData.version : 0),
            type: Number(battleData && battleData.mode != null ? battleData.mode : 0),
            sponsor,
            accept,
            round: 0,
            isTimeout: 0,
            statistic: new Map(),
            sponsors: [],
            accepts: [],
            gameResults: [],
            memos: [],
            log: '',
            inputCode: '',
            outputCode: '',
        });
    }

    function resetBattleRuntimeState(battleData) {
        if (!battleData || typeof battleData !== 'object') {
            return battleData;
        }
        battleData.leftTeams = [];
        battleData.rightTeams = [];
        battleData.fightTime = 0;
        battleData.outputCode = {};
        battleData.result = buildFreshBattleRuntimeResult(battleData, battleData.result);
        battleData.statistic = [];
        return battleData;
    }

    function finalizeBattleDataForSimulation(battleData) {
        if (!battleData || typeof battleData !== 'object') {
            return battleData;
        }
        battleData.leftTeams = ensureArrayValue(battleData.leftTeams);
        battleData.rightTeams = ensureArrayValue(battleData.rightTeams);
        if (!battleData.outputCode || typeof battleData.outputCode !== 'object' || Array.isArray(battleData.outputCode)) {
            battleData.outputCode = {};
        }
        if (!battleData.result || typeof battleData.result !== 'object' || Array.isArray(battleData.result)) {
            battleData.result = {};
        }
        if (!battleData.statistic || (typeof battleData.statistic !== 'object' && !Array.isArray(battleData.statistic))) {
            battleData.statistic = [];
        }
        normalizeBattleSideMeta(battleData.leftTeam, false);
        normalizeBattleSideMeta(battleData.rightTeam, true);
        return battleData;
    }

    function buildReusableSkeletonFromCandidate(candidate) {
        if (!candidate) {
            return null;
        }
        const restoredEntries = Utils.fromSerializable(candidate.teamEntries || []);
        if (!Array.isArray(restoredEntries) || !restoredEntries.length) {
            return null;
        }
        const leftTeamMeta = Utils.fromSerializable(candidate.leftTeamMeta || {});
        const roleMeta = (
            leftTeamMeta && (leftTeamMeta.name || leftTeamMeta.headImg || leftTeamMeta.roleId)
        ) ? {
            name: leftTeamMeta.name || '',
            headImg: leftTeamMeta.headImg || '',
            roleId: Number(leftTeamMeta.roleId || 0),
        } : getRoleDisplayMeta();
        const leftTeam = Object.assign({
            headImg: roleMeta.headImg,
            name: roleMeta.name,
            legionName: '',
            roleId: roleMeta.roleId,
            power: 0,
            legacyColor: 0,
            tapAttack: 0,
            lordSkill: [],
            lordAttackTime: [],
            lordSkinId: 0,
            weaponId: candidate.lordWeaponId || 0,
            weaponActiveLevelId: 0,
            lordAutoAttackTime: [],
            avatarFrame: '',
            attributeBonus: new Map(),
            customCard: null,
            levelWeaponSkillId: [],
            teamInfo: new Map(),
            options: new Map(),
        }, Utils.deepClone(leftTeamMeta || {}));
        leftTeam.team = rebuildTeamLike(
            new Map(),
            restoredEntries.map(({ pos, entry }) => ({
                pos: Number(pos),
                entry: Utils.deepClone(entry),
            })),
        );
        return finalizeBattleDataForSimulation({
            id: 0,
            mode: 0,
            version: 0,
            randomSeed: 1,
            leftTeams: [],
            rightTeams: [],
            outputCode: {},
            result: {},
            statistic: {},
            options: new Map(),
            leftTeam,
            rightTeam: {
                roleId: 0,
                name: '',
                headImg: '',
                legionName: '',
                lordSkill: [],
                lordAttackTime: [],
                lordAutoAttackTime: [],
                levelWeaponSkillId: [],
                options: new Map(),
                teamInfo: new Map(),
                attributeBonus: new Map(),
                team: new Map(),
            },
        });
    }

    function syncReusableSkeletonFromCandidate(candidate, baseBattleData = null, source = 'candidateCapture') {
        if (!candidate) {
            return false;
        }
        let mergedBattleData = null;
        const battleDataSources = [
            baseBattleData,
            state.reusableSkeleton,
            Utils.safeCall(() => state.latestCapture.input.battleData, null),
        ];
        Object.keys(state.modeCaches || {}).forEach((key) => {
            const cache = state.modeCaches[key];
            if (cache && cache.battleData) {
                battleDataSources.push(cache.battleData);
            }
        });
        for (let i = 0; i < battleDataSources.length; i += 1) {
            const current = battleDataSources[i];
            if (!isReusableBattleSkeleton(current)) {
                continue;
            }
            mergedBattleData = Utils.deepClone(current);
            applyCandidateToBattleData(mergedBattleData, candidate);
            break;
        }
        if (!mergedBattleData) {
            mergedBattleData = Utils.safeCall(() => buildReusableSkeletonFromCandidate(candidate), null);
        }
        if (!mergedBattleData) {
            return false;
        }
        updateReusableBattleSkeleton(mergedBattleData, {
            source,
            modeKey: normalizeModeKey(Runtime.getBattleModeName(mergedBattleData.mode)),
            signature: candidate.signature || getCurrentTeamSignatureFromBattleData(mergedBattleData),
            candidateId: candidate.id || '',
        });
        if (candidate.signature) {
            state.lastKnownSignature = candidate.signature;
        }
        return true;
    }

    function saveReusableSkeleton() {
        try {
            if (!state.reusableSkeleton) {
                localStorage.removeItem(STORAGE_KEYS.reusableSkeleton);
                return;
            }
            localStorage.setItem(
                STORAGE_KEYS.reusableSkeleton,
                JSON.stringify(Utils.toSerializable({
                    battleData: state.reusableSkeleton,
                    meta: state.reusableSkeletonMeta || null,
                })),
            );
        } catch (error) {
            Utils.warn('保存可复用骨架失败', error);
        }
    }

    function restoreReusableSkeletonFromCandidates() {
        const sortedCandidates = (state.candidates || [])
            .slice()
            .sort((left, right) => Number(right.capturedAt || 0) - Number(left.capturedAt || 0));
        for (let i = 0; i < sortedCandidates.length; i += 1) {
            const candidate = sortedCandidates[i];
            const reusable = Utils.safeCall(() => buildReusableSkeletonFromCandidate(candidate), null);
            if (!reusable) {
                continue;
            }
            state.reusableSkeleton = reusable;
            state.reusableSkeletonMeta = {
                source: 'savedCandidate',
                mode: reusable.mode,
                modeKey: candidate.sourceMode || 'candidate',
                capturedAt: Utils.now(),
                signature: candidate.signature || '',
                candidateId: candidate.id || '',
            };
            if (candidate.signature) {
                state.lastKnownSignature = candidate.signature;
            } else {
                const signature = getCurrentTeamSignatureFromBattleData(reusable);
                if (signature) {
                    state.lastKnownSignature = signature;
                }
            }
            Utils.pushDataSource(`已从保存的候选阵容恢复可复用骨架 ${candidate.signature || candidate.id || ''}`);
            saveReusableSkeleton();
            return true;
        }
        return false;
    }

    function loadReusableSkeleton(allowCandidateFallback = true) {
        state.reusableSkeleton = null;
        state.reusableSkeletonMeta = null;
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.reusableSkeleton);
            if (raw) {
                const parsed = Utils.fromSerializable(JSON.parse(raw));
                const battleData = parsed && parsed.battleData ? parsed.battleData : null;
                if (battleData && isReusableBattleSkeleton(battleData)) {
                    state.reusableSkeleton = finalizeBattleDataForSimulation(battleData);
                    state.reusableSkeletonMeta = parsed && parsed.meta ? parsed.meta : null;
                    const signature = getCurrentTeamSignatureFromBattleData(state.reusableSkeleton);
                    if (signature) {
                        state.lastKnownSignature = signature;
                    }
                    Utils.pushDataSource('已加载本地保存的可复用骨架');
                    return;
                }
            }
        } catch (error) {
            Utils.warn('加载可复用骨架失败', error);
        }
        if (allowCandidateFallback) {
            restoreReusableSkeletonFromCandidates();
        }
    }

    function loadCandidates() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.candidates);
            if (!raw) {
                state.candidates = [];
                return;
            }
            const parsed = JSON.parse(raw);
            state.candidates = Utils.fromSerializable(parsed) || [];
        } catch (error) {
            Utils.warn('加载候选阵容失败', error);
            state.candidates = [];
        }
    }

    function saveCandidates() {
        try {
            localStorage.setItem(
                STORAGE_KEYS.candidates,
                JSON.stringify(Utils.toSerializable(state.candidates)),
            );
        } catch (error) {
            Utils.warn('保存候选阵容失败', error);
        }
    }

    function upsertCandidate(candidate) {
        const existingIndex = state.candidates.findIndex((item) => item.signature === candidate.signature);
        if (existingIndex >= 0) {
            state.candidates[existingIndex] = candidate;
        } else {
            state.candidates.push(candidate);
        }
        saveCandidates();
    }

    function removeCandidate(candidateId) {
        state.candidates = state.candidates.filter((item) => item.id !== candidateId);
        saveCandidates();
    }

    function buildSeedList(draft, count, scopeText) {
        const scope = {
            mode: draft.mode,
            context: draft.context,
            scope: scopeText,
        };
        const scopeKey = Utils.stringifySeedScope(scope);
        const base = Utils.hashString(scopeKey) % 2147483000;
        const offset = Number(state.seedBatchCursorMap[scopeKey] || 0);
        state.seedBatchCursorMap[scopeKey] = (offset + count) % 2147480000;
        const seeds = [];
        for (let i = 1; i <= count; i += 1) {
            const seed = (base + offset + i) % 2147483647 || 1;
            seeds.push(seed);
        }
        return seeds;
    }

    function resetSeedCursor(scopeKey = null) {
        if (scopeKey) {
            delete state.seedBatchCursorMap[scopeKey];
            delete state.debugSeedCursorMap[scopeKey];
        } else {
            state.seedBatchCursorMap = Object.create(null);
            state.debugSeedCursorMap = Object.create(null);
        }
    }

    function buildDebugSeed(draft, candidate) {
        const scope = {
            mode: draft.mode,
            context: draft.context,
            scope: `${candidate && candidate.signature ? candidate.signature : '-'}:debug`,
        };
        const scopeKey = Utils.stringifySeedScope(scope);
        const base = Utils.hashString(scopeKey) % 2147483000;
        const nextIndex = Number(state.debugSeedCursorMap[scopeKey] || 0) + 1;
        state.debugSeedCursorMap[scopeKey] = nextIndex;
        return (base + nextIndex) % 2147483647 || 1;
    }

    function resetSeedRecordView(report = null) {
        state.seedRecordView.sourceId = report && report.reportId ? String(report.reportId) : '';
        state.seedRecordView.page = 0;
        state.seedRecordView.selectedIndex = 0;
        state.seedRecordView.sortBy = state.panelPrefs.seedSort || 'default';
    }

    function normalizeSampleCount(rawValue, fallback = DEFAULT_SAMPLE_COUNT) {
        const numeric = Number(String(rawValue == null ? '' : rawValue).replace(/[^\d]+/g, ''));
        if (!Number.isFinite(numeric) || numeric <= 0) {
            return Number(fallback || DEFAULT_SAMPLE_COUNT);
        }
        return Math.min(MAX_SAMPLE_COUNT, Math.max(1, Math.floor(numeric)));
    }

    function getPanelSampleCount(inputValue = null) {
        const rawValue = inputValue != null
            ? inputValue
            : state.panel && state.panel.refs && state.panel.refs.sampleCountInput
                ? state.panel.refs.sampleCountInput.value
                : state.panelPrefs.sampleCount;
        const sampleCount = normalizeSampleCount(rawValue, state.panelPrefs.sampleCount || DEFAULT_SAMPLE_COUNT);
        state.panelPrefs.sampleCount = `${sampleCount}`;
        savePanelState();
        if (state.panel && state.panel.refs && state.panel.refs.sampleCountInput) {
            state.panel.refs.sampleCountInput.value = `${sampleCount}`;
        }
        return sampleCount;
    }

    function sumTeamHp(teamInfo) {
        return (teamInfo || []).reduce((total, item) => total + Number(item && item.hp ? item.hp : 0), 0);
    }

    function sumTeamMaxHp(teamInfo) {
        return (teamInfo || []).reduce((total, item) => {
            const hpMax = item && item.maxHp != null ? item.maxHp : item && item.hp != null ? item.hp : 0;
            return total + Number(hpMax || 0);
        }, 0);
    }

    function countAlive(teamInfo) {
        return (teamInfo || []).reduce((total, item) => total + (Number(item && item.hp ? item.hp : 0) > 0 ? 1 : 0), 0);
    }

    function extractRoundCount(result) {
        if (!result) {
            return 0;
        }
        if (Number.isFinite(result.round)) {
            return Number(result.round);
        }
        if (Number.isFinite(result.totalRound)) {
            return Number(result.totalRound);
        }
        if (Number.isFinite(result.turn)) {
            return Number(result.turn);
        }
        if (Number.isFinite(result.totalFrame)) {
            return Math.max(1, Math.ceil(Number(result.totalFrame) / 50));
        }
        return 0;
    }

    function extractSponsorTeamInfo(result) {
        if (!result) {
            return [];
        }
        if (result.sponsor && Array.isArray(result.sponsor.teamInfo)) {
            return result.sponsor.teamInfo;
        }
        if (Array.isArray(result.leftTeamInfo)) {
            return result.leftTeamInfo;
        }
        return [];
    }

    function extractAcceptTeamInfo(result) {
        if (!result) {
            return [];
        }
        if (result.accept && Array.isArray(result.accept.teamInfo)) {
            return result.accept.teamInfo;
        }
        if (Array.isArray(result.rightTeamInfo)) {
            return result.rightTeamInfo;
        }
        return [];
    }

    function getOwnDataKeys(value, limit = 20) {
        if (!value || typeof value !== 'object') {
            return [];
        }
        return Utils.safeCall(() => Reflect.ownKeys(value)
            .filter((key) => typeof key === 'string')
            .filter((key) => typeof value[key] !== 'function')
            .slice(0, limit), []);
    }

    function extractBattleResultFromInput(inputData) {
        if (!inputData || typeof inputData !== 'object') {
            return null;
        }
        const candidates = [
            inputData.battleResult,
            inputData.result,
            inputData.replayResult,
            inputData.fightResult,
            inputData.rawResult,
            inputData.data && inputData.data.battleResult,
            inputData.data && inputData.data.result,
        ];
        for (let i = 0; i < candidates.length; i += 1) {
            if (candidates[i]) {
                return candidates[i];
            }
        }
        return null;
    }

    function getBattleDataOptionName(optionKey) {
        const rawKey = Number(optionKey);
        const BattleDataOption = Utils.safeCall(() => Runtime.getBattleDataOption(), null);
        if (!BattleDataOption || !Number.isFinite(rawKey)) {
            return String(optionKey);
        }
        const matched = Object.keys(BattleDataOption).find((name) => BattleDataOption[name] === rawKey);
        return matched ? `${matched}(${rawKey})` : String(optionKey);
    }

    function summarizeOptionValue(value, depth = 0, seen = new WeakSet()) {
        if (value == null || typeof value !== 'object') {
            return value;
        }
        if (seen.has(value)) {
            return '[Circular]';
        }
        if (depth >= 2) {
            return Array.isArray(value)
                ? { type: 'Array', length: value.length }
                : { type: value.constructor && value.constructor.name ? value.constructor.name : 'Object', keys: getOwnDataKeys(value, 8) };
        }
        seen.add(value);
        if (value instanceof Map) {
            const items = [];
            value.forEach((entryValue, entryKey) => {
                if (items.length < 6) {
                    items.push([String(entryKey), summarizeOptionValue(entryValue, depth + 1, seen)]);
                }
            });
            return { type: 'Map', size: value.size, items };
        }
        if (value instanceof Set) {
            const items = [];
            value.forEach((entryValue) => {
                if (items.length < 6) {
                    items.push(summarizeOptionValue(entryValue, depth + 1, seen));
                }
            });
            return { type: 'Set', size: value.size, items };
        }
        if (Array.isArray(value)) {
            return value.slice(0, 6).map((item) => summarizeOptionValue(item, depth + 1, seen));
        }
        const summary = {};
        getOwnDataKeys(value, 8).forEach((key) => {
            summary[key] = summarizeOptionValue(value[key], depth + 1, seen);
        });
        return summary;
    }

    function summarizeBattleOptions(options) {
        const entries = [];
        const seenKeys = new Set();
        const pushEntry = (key, value) => {
            const normalizedKey = String(key);
            if (seenKeys.has(normalizedKey) || entries.length >= 18) {
                return;
            }
            seenKeys.add(normalizedKey);
            entries.push({
                key: normalizedKey,
                value: summarizeOptionValue(value),
            });
        };
        if (!options) {
            return {
                kind: 'empty',
                entries,
            };
        }
        if (typeof options.forEach === 'function') {
            Utils.safeCall(() => {
                options.forEach((value, key) => {
                    pushEntry(getBattleDataOptionName(key), value);
                });
            }, null);
        }
        if (typeof options.getExt === 'function') {
            const BattleDataOption = Utils.safeCall(() => Runtime.getBattleDataOption(), null);
            if (BattleDataOption) {
                Object.keys(BattleDataOption).forEach((key) => {
                    const optionId = BattleDataOption[key];
                    const value = Utils.safeCall(() => options.getExt(optionId, undefined), undefined);
                    if (value !== undefined && value !== null) {
                        pushEntry(`ext.${key}`, value);
                    }
                });
            }
        }
        if (Array.isArray(options)) {
            options.slice(0, 12).forEach((value, index) => pushEntry(index, value));
        } else {
            getOwnDataKeys(options, 12).forEach((key) => pushEntry(key, options[key]));
        }
        return {
            kind: options.constructor && options.constructor.name ? options.constructor.name : typeof options,
            entries,
        };
    }

    function summarizeTeamEntry(pos, entry) {
        const numericValue = (field) => {
            const value = entry && entry[field] != null ? Number(entry[field]) : 0;
            return Number.isFinite(value) ? value : 0;
        };
        const coreStatKeys = ['attack', 'defense', 'hp', 'maxHp', 'curHp', 'speed', 'curEnergy', 'energy'];
        const nonZeroCoreStats = coreStatKeys.filter((key) => numericValue(key) !== 0);
        const keys = getOwnDataKeys(entry, 30);
        return {
            pos,
            id: extractHeroId(entry),
            type: numericValue('type'),
            index: entry && entry.index != null ? Number(entry.index) : pos,
            level: numericValue('level'),
            star: numericValue('star'),
            color: numericValue('color'),
            order: numericValue('order'),
            hp: numericValue('hp'),
            curHp: numericValue('curHp'),
            attack: numericValue('attack'),
            defense: numericValue('defense'),
            speed: numericValue('speed'),
            keyCount: keys.length,
            keys,
            nonZeroCoreStats,
            hollow: extractHeroId(entry) > 0 && nonZeroCoreStats.length === 0,
        };
    }

    function summarizeTeamSide(team) {
        const entries = normalizeTeamEntries(team).map(({ pos, entry }) => summarizeTeamEntry(pos, entry));
        return {
            count: entries.length,
            hollowCount: entries.filter((item) => item.hollow).length,
            brief: entries.map((item) => `${item.pos}:${item.id}@${item.level}`).join(' | '),
            entries,
        };
    }

    function buildBattleResultSummary(result) {
        if (!result) {
            return null;
        }
        const sponsorTeam = extractSponsorTeamInfo(result);
        const acceptTeam = extractAcceptTeamInfo(result);
        const sponsorHp = sumTeamHp(sponsorTeam);
        const sponsorMaxHp = sumTeamMaxHp(sponsorTeam);
        const acceptHp = sumTeamHp(acceptTeam);
        const acceptMaxHp = sumTeamMaxHp(acceptTeam);
        return {
            isWin: !!result.isWin,
            roundCount: extractRoundCount(result),
            leftAlive: countAlive(sponsorTeam),
            rightAlive: countAlive(acceptTeam),
            leftRemainHp: sponsorHp,
            leftRemainHpRate: sponsorMaxHp > 0 ? sponsorHp / sponsorMaxHp : 0,
            rightRemainHp: acceptHp,
            rightRemainHpRate: acceptMaxHp > 0 ? acceptHp / acceptMaxHp : 0,
            totalFrame: Number.isFinite(result.totalFrame) ? Number(result.totalFrame) : 0,
        };
    }

    function buildDiagnosticSample(kind, payload = {}) {
        const inputData = payload.inputData || null;
        const battleData = payload.battleData || (inputData && inputData.battleData) || null;
        const battleResult = payload.battleResult || extractBattleResultFromInput(inputData);
        const modeKey = normalizeModeKey(payload.modeKey || resolveModeKeyFromBattleData(battleData, inputData) || 'capture');
        const context = payload.context != null
            ? Utils.deepClone(payload.context)
            : Utils.deepClone(Utils.safeCall(() => state.modeCaches[modeKey] && state.modeCaches[modeKey].context, null));
        const battleModeName = Runtime.getBattleModeName(battleData && battleData.mode);
        const summary = {
            modeName: battleModeName,
            contextText: buildContextText(modeKey, context),
            battleId: battleData && battleData.id != null ? battleData.id : null,
            version: battleData && battleData.version != null ? battleData.version : null,
            randomSeed: battleData && battleData.randomSeed != null ? battleData.randomSeed : null,
            teamSignature: getCurrentTeamSignatureFromBattleData(battleData),
            leftRoleId: battleData && battleData.leftTeam ? Number(battleData.leftTeam.roleId || 0) : 0,
            rightRoleId: battleData && battleData.rightTeam ? Number(battleData.rightTeam.roleId || 0) : 0,
            leftTeam: summarizeTeamSide(battleData && battleData.leftTeam ? battleData.leftTeam.team : null),
            rightTeam: summarizeTeamSide(battleData && battleData.rightTeam ? battleData.rightTeam.team : null),
            options: summarizeBattleOptions(battleData && battleData.options),
            battleKeys: getOwnDataKeys(battleData, 24),
            inputKeys: getOwnDataKeys(inputData, 16),
            result: buildBattleResultSummary(battleResult),
        };
        summary.hypothesis = {
            rightTeamLooksConfigDriven: summary.rightTeam.count > 0 && summary.rightTeam.hollowCount === summary.rightTeam.count,
            endsAtRound15: !!(summary.result && summary.result.roundCount === 15),
        };
        return {
            id: `${Utils.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind,
            timestamp: Utils.now(),
            source: payload.source || '-',
            modeKey,
            modeLabel: MODE_LABELS[modeKey] || battleModeName || modeKey,
            context,
            summary,
            raw: {
                inputData: inputData ? Utils.toSerializable(inputData) : null,
                battleData: battleData ? Utils.toSerializable(battleData) : null,
                battleResult: battleResult ? Utils.toSerializable(battleResult) : null,
                extra: payload.extra != null ? Utils.toSerializable(payload.extra) : null,
            },
        };
    }

    function recordDiagnosticSample(kind, payload = {}) {
        const sample = buildDiagnosticSample(kind, payload);
        state.diagnosticSamples.unshift(sample);
        state.diagnosticSamples = state.diagnosticSamples.slice(0, DIAGNOSTIC_SAMPLE_LIMIT);
        Utils.pushDataSource(`诊断采样 ${sample.modeLabel} / ${kind} / ${sample.source}`);
        Utils.log('诊断采样', sample.summary);
        return sample;
    }

    function stringifyShort(value, limit = 72) {
        let text = '';
        if (typeof value === 'string') {
            text = value;
        } else {
            text = Utils.safeCall(() => JSON.stringify(value), String(value));
        }
        if (text.length > limit) {
            return `${text.slice(0, limit)}...`;
        }
        return text;
    }

    function buildDiagnosticHeadline(sample) {
        const result = sample.summary.result;
        const resultText = result
            ? `${result.isWin ? '胜' : '负'} / ${result.roundCount || 0} 回合`
            : '无结算';
        return `${Utils.formatTime(sample.timestamp)} | ${sample.modeLabel} | ${sample.source} | 右侧空心 ${sample.summary.rightTeam.hollowCount}/${sample.summary.rightTeam.count} | ${resultText}`;
    }

    function buildDiagnosticText(sample) {
        const lines = [];
        lines.push(buildDiagnosticHeadline(sample));
        lines.push(`目标: ${sample.summary.contextText || '-'}`);
        lines.push(`battleId: ${sample.summary.battleId || '-'} | seed: ${sample.summary.randomSeed || '-'} | version: ${sample.summary.version || '-'}`);
        lines.push(`左侧签名: ${sample.summary.teamSignature || '-'}`);
        lines.push(`右侧敌方: ${sample.summary.rightTeam.brief || '-'}`);
        lines.push(`是否疑似纯代号驱动: ${sample.summary.hypothesis.rightTeamLooksConfigDriven ? '是' : '否'}`);
        if (sample.summary.result) {
            lines.push(`真实结果: ${sample.summary.result.isWin ? '胜利' : '失败'} | 回合 ${sample.summary.result.roundCount} | 左存活 ${sample.summary.result.leftAlive} | 右存活 ${sample.summary.result.rightAlive}`);
            lines.push(`是否 15 回合: ${sample.summary.hypothesis.endsAtRound15 ? '是' : '否'}`);
        }
        if (sample.summary.options && sample.summary.options.entries.length) {
            lines.push('玩法参数:');
            sample.summary.options.entries.slice(0, 8).forEach((item) => {
                lines.push(`- ${item.key} = ${stringifyShort(item.value)}`);
            });
        }
        return lines.join('\n');
    }

    function showDiagnosticLogs() {
        if (!state.diagnosticSamples.length) {
            alert('暂无诊断样本。请先真实打一场，再点一次“查看诊断日志”。');
            return;
        }
        const lines = [];
        lines.push(`脚本: ${SCRIPT_NAME} v${SCRIPT_VERSION}`);
        lines.push(`诊断样本: ${state.diagnosticSamples.length}`);
        lines.push('');
        state.diagnosticSamples.slice(0, 8).forEach((sample, index) => {
            lines.push(`${index + 1}. ${buildDiagnosticText(sample)}`);
            lines.push('');
        });
        alert(lines.join('\n'));
    }

    function exportDiagnosticLogs() {
        if (!state.diagnosticSamples.length) {
            throw new Error('当前还没有诊断样本可导出');
        }
        const now = new Date();
        const pad = (value) => `${value}`.padStart(2, '0');
        const fileName = `battle-sim-replay-assistant-diagnostics-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
        const payload = {
            scriptName: SCRIPT_NAME,
            version: SCRIPT_VERSION,
            exportedAt: now.toISOString(),
            sampleCount: state.diagnosticSamples.length,
            samples: state.diagnosticSamples,
            dataSources: state.dataSourceLines,
            playbackHiddenProxyCount: Array.isArray(state.playbackHiddenProxyStates) ? state.playbackHiddenProxyStates.length : 0,
            playbackHiddenProxyStates: (state.playbackHiddenProxyStates || []).map((item) => ({
                layerValue: item.layerValue,
                layerName: item.layerName,
                proxyName: item.proxyName,
                visible: item.visible,
            })),
            playbackHiddenLayerCount: Array.isArray(state.playbackHiddenLayerStates) ? state.playbackHiddenLayerStates.length : 0,
            playbackHiddenLayerStates: (state.playbackHiddenLayerStates || []).map((item) => ({
                layerName: item.layerName,
                childName: item.childName,
                visible: item.visible,
            })),
            playbackBackdropState: state.playbackBackdropState
                ? {
                    mapId: state.playbackBackdropState.mapId,
                    mapUrl: state.playbackBackdropState.mapUrl,
                    layerName: state.playbackBackdropState.layerName,
                }
                : null,
            nightmareReplayScene: state.nightmareReplayScene,
        };
        const text = JSON.stringify(payload, null, 2);
        Utils.downloadTextFile(fileName, text);
        return fileName;
    }

    function clearDiagnosticLogs() {
        state.diagnosticSamples = [];
        Utils.pushDataSource('诊断样本已清空');
    }

    function getNightmareStarFallbackConditions(bossId) {
        const id = Number(bossId || 0);
        if (id === 5) {
            return {
                nightMareStarConditionType: [1, 1, 2],
                nightMareStarConditionValue: [[15], [6], [4, 5]],
            };
        }
        if (id === 4) {
            return {
                nightMareStarConditionType: [1, 1, 2],
                nightMareStarConditionValue: [[15], [6], [4, 5]],
            };
        }
        if (id === 3) {
            return {
                nightMareStarConditionType: [1, 1, 2],
                nightMareStarConditionValue: [[15], [8], [4, 4]],
            };
        }
        if (id === 2) {
            return {
                nightMareStarConditionType: [1, 1, 2],
                nightMareStarConditionValue: [[15], [8], [4, 4]],
            };
        }
        if (id === 1) {
            return {
                nightMareStarConditionType: [1, 1, 2],
                nightMareStarConditionValue: [[15], [10], [5, 3]],
            };
        }
        return {
            nightMareStarConditionType: [1, 1, 2],
            nightMareStarConditionValue: [[15], [6], [4, 5]],
        };
    }

    function evaluateNightmareStarResult(bossId, result) {
        if (!result || !result.isWin) {
            return {
                stars: 0,
                oneStar: false,
                twoStar: false,
                threeStar: false,
            };
        }
        const normalizedBossId = Number(bossId || 0);
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        let conf = getNightmareStarConfigByBossId(normalizedBossId);
        if (!conf && Configs && Configs.NightMareStarConf && typeof Configs.NightMareStarConf.getByBossId === 'function') {
            conf = Utils.safeCall(() => Configs.NightMareStarConf.getByBossId(normalizedBossId), null);
        }
        if (!conf || !Array.isArray(conf.nightMareStarConditionType) || !conf.nightMareStarConditionType.length) {
            conf = getNightmareStarFallbackConditions(normalizedBossId);
        }
        const conditionType = Configs && Configs.NightMareStarConditionType ? Configs.NightMareStarConditionType : {};
        const roundCount = extractRoundCount(result);
        const aliveCount = countAlive(extractSponsorTeamInfo(result));

        // 星级挑战各关卡第 3 星（满星）要求的最小存活人数：
        // 第 1 关: 3 人；第 2、3 关: 4 人；第 4 关及以上（包括第 5 关）: 必须 5 人全部存活
        const requiredFullStarAlive = normalizedBossId >= 4 ? 5 : (normalizedBossId >= 2 ? 4 : (normalizedBossId === 1 ? 3 : 5));

        let stars = 0;
        const types = conf.nightMareStarConditionType || [];
        const values = conf.nightMareStarConditionValue || [];
        for (let i = 0; i < types.length; i += 1) {
            const type = types[i];
            const value = values[i] || [];
            let passed = false;

            if (i === 2) {
                // 第 3 个条件（满星条件）：
                // 回合数必须 <= maxRound（通常为 4 回合，第 1 关为 5 回合），且存活人数必须达到关卡满星要求（第 5 关必须全部 5 人存活）
                const maxRound = Number(value[0] || (normalizedBossId === 1 ? 5 : 4));
                const confAlive = Number(value[1] || 0);
                const minAlive = Math.max(confAlive, requiredFullStarAlive);
                passed = roundCount > 0 && roundCount <= maxRound && aliveCount >= minAlive;
            } else if (type === conditionType.STAR_CONDITION_ROUND_HEROALIVE || type === 2 || String(type) === '2') {
                const maxRound = Number(value[0] || 0);
                const minAlive = Number(value[1] || 1);
                passed = roundCount > 0 && roundCount <= maxRound && aliveCount >= minAlive;
            } else if (type === conditionType.STAR_CONDITION_ROUND || type === 1 || String(type) === '1') {
                passed = roundCount > 0 && roundCount <= Number(value[0] || 0);
            } else {
                passed = roundCount > 0 && roundCount <= Number(value[0] || 0);
            }

            if (passed) {
                stars += 1;
            }
        }

        // 严格安全守护：如果是第 4 关及以上（包括第 5 关），如果存活人数 < 5，绝不能判为 3 星！
        if (normalizedBossId >= 4 && aliveCount < 5 && stars >= 3) {
            stars = 2;
        } else if (normalizedBossId >= 2 && aliveCount < 4 && stars >= 3) {
            stars = 2;
        }

        return {
            stars,
            oneStar: stars >= 1,
            twoStar: stars >= 2,
            threeStar: stars >= 3,
        };
    }

    function extractResultStats(draft, battleData, result) {
        const sponsorTeam = extractSponsorTeamInfo(result);
        const acceptTeam = extractAcceptTeamInfo(result);
        const sponsorHp = sumTeamHp(sponsorTeam);
        const sponsorMaxHp = sumTeamMaxHp(sponsorTeam);
        const enemyHp = sumTeamHp(acceptTeam);
        const star = draft.mode === 'nightmareStar'
            ? evaluateNightmareStarResult(draft.context && draft.context.bossId, result)
            : null;
        return {
            isWin: !!(result && result.isWin),
            roundCount: extractRoundCount(result),
            aliveCount: countAlive(sponsorTeam),
            remainHp: sponsorHp,
            remainHpRate: sponsorMaxHp > 0 ? sponsorHp / sponsorMaxHp : 0,
            enemyRemainHp: enemyHp,
            stars: star,
            rawResult: result,
            battleData,
        };
    }

    function initEmptyAggregate(sampleCount) {
        return {
            sampleCount,
            finishedCount: 0,
            winCount: 0,
            roundSum: 0,
            aliveSum: 0,
            remainHpRateSum: 0,
            firstWinSeed: null,
            replayInput: null,
            star1Count: 0,
            star2Count: 0,
            star3Count: 0,
            seedRecords: [],
        };
    }

    function isBareReplayInput(input) {
        if (!input || typeof input !== 'object') {
            return true;
        }
        const keys = Reflect.ownKeys(input).filter((key) => typeof key === 'string');
        if (!keys.length) {
            return true;
        }
        return keys.every((key) => key === 'battleData' || key === 'battleResult');
    }

    function getReplayTemplateInput(modeKey, preferredInput = null) {
        if (preferredInput && preferredInput.battleData && !isPvpBattleInput(preferredInput) && !isBareReplayInput(preferredInput)) {
            return preferredInput;
        }
        if (modeKey && state.modeCaches[modeKey] && state.modeCaches[modeKey].inputData && !isPvpBattleInput(state.modeCaches[modeKey].inputData)) {
            return state.modeCaches[modeKey].inputData;
        }
        if (state.latestCapture && state.latestCapture.input && !isPvpBattleInput(state.latestCapture.input)) {
            return state.latestCapture.input;
        }
        const modeKeys = Object.keys(state.modeCaches || {});
        for (let i = 0; i < modeKeys.length; i += 1) {
            const cache = state.modeCaches[modeKeys[i]];
            if (cache && cache.inputData && !isPvpBattleInput(cache.inputData)) {
                return cache.inputData;
            }
        }
        return null;
    }

    function buildReplayInputFromBase(baseInput, battleData, result) {
        if (!baseInput) {
            return null;
        }
        const input = Utils.deepClone(baseInput);
        input.battleData = Utils.deepClone(battleData);
        input.battleResult = Utils.deepClone(result);
        if (input.rawData && typeof input.rawData === 'object') {
            if (Object.prototype.hasOwnProperty.call(input.rawData, 'battleData')) {
                input.rawData.battleData = Utils.deepClone(battleData);
            }
            if (Object.prototype.hasOwnProperty.call(input.rawData, 'battleResult')) {
                input.rawData.battleResult = Utils.deepClone(result);
            }
            if (Object.prototype.hasOwnProperty.call(input.rawData, 'result')) {
                input.rawData.result = Utils.deepClone(result);
            }
        }
        if (input.battleData && typeof input.battleData === 'object' && Object.prototype.hasOwnProperty.call(input.battleData, 'result')) {
            input.battleData.result = Utils.deepClone(result);
        }
        return input;
    }

    function getNightmareRoomRule(inputData) {
        return Utils.safeCall(() => inputData.fightNotify.roomInfo.rule, null)
            || Utils.safeCall(() => inputData.roomInfo.rule, null)
            || null;
    }

    function getNightmareRoomMarkerValue(inputData, fallback = null) {
        const rule = getNightmareRoomRule(inputData);
        if (inputData && typeof inputData === 'object' && Object.prototype.hasOwnProperty.call(inputData, 'nM')) {
            const value = Number(inputData.nM);
            if (Number.isFinite(value)) {
                return value;
            }
        }
        if (rule && typeof rule === 'object' && Object.prototype.hasOwnProperty.call(rule, 'nM')) {
            const value = Number(rule.nM);
            if (Number.isFinite(value)) {
                return value;
            }
        }
        return fallback;
    }

    function resolveNightmareRoomClientRoleNum(inputData) {
        const rule = getNightmareRoomRule(inputData);
        const directValue = getNumericFieldValue(inputData || {}, ['clientRoleNum'], null);
        if (directValue != null) {
            return directValue;
        }
        const ruleValue = getNumericFieldValue(rule || {}, ['clientRoleNum'], null);
        if (ruleValue != null) {
            return ruleValue;
        }
        return 201;
    }

    function isNightmareRoomReplayInput(inputData) {
        if (!inputData || !inputData.battleData) {
            return false;
        }
        const modeName = normalizeModeKey(Runtime.getBattleModeName(inputData.battleData.mode));
        if (modeName !== 'pKRoom') {
            return false;
        }
        if (getNightmareRoomMarkerValue(inputData, null) != null) {
            return true;
        }
        return resolveNightmareRoomClientRoleNum(inputData) === 201;
    }

    function findNightmareRoomTemplateInput(preferredInput = null) {
        const candidates = [
            preferredInput,
            Utils.safeCall(() => state.modeCaches.nightmare.inputData, null),
            Utils.safeCall(() => state.latestCapture.input, null),
            Utils.safeCall(() => state.lastSingleRun.replayInput, null),
            Utils.safeCall(() => state.lastReport.replayInput, null),
        ];
        for (let i = 0; i < candidates.length; i += 1) {
            if (isNightmareRoomReplayInput(candidates[i])) {
                return candidates[i];
            }
        }
        const modeKeys = Object.keys(state.modeCaches || {});
        for (let i = 0; i < modeKeys.length; i += 1) {
            const cacheInput = Utils.safeCall(() => state.modeCaches[modeKeys[i]].inputData, null);
            if (isNightmareRoomReplayInput(cacheInput)) {
                return cacheInput;
            }
        }
        return null;
    }

    function buildNightmareRoomBattleData(battleData, result) {
        const roomBattleData = Utils.deepClone(battleData || {});
        const roomModeValue = Utils.safeCall(() => Runtime.getBattleModeValue('pKRoom'), null);
        if (roomModeValue != null) {
            roomBattleData.mode = roomModeValue;
        }
        roomBattleData.result = Utils.deepClone(result);
        return roomBattleData;
    }

    function resolveNightmareRoomMarker(context, templateInput = null) {
        const hallNumber = getNumericFieldValue(context || {}, ['hallNumber'], null)
            || Utils.safeCall(() => getNightmareBossMetaByBossId(context && context.bossId).hallNumber, null);
        if (hallNumber != null) {
            return Math.max(0, Number(hallNumber) - 1);
        }
        const templateMarker = getNightmareRoomMarkerValue(templateInput, null);
        if (templateMarker != null) {
            return templateMarker;
        }
        return 0;
    }

    function buildNightmareRoomFightNotify(context, battleData, result, templateInput = null) {
        const templateNotify = Utils.safeCall(() => templateInput.fightNotify, null);
        const templateRoomInfo = Utils.safeCall(() => templateNotify.roomInfo, null);
        const notify = Utils.deepClone(templateNotify || {});
        const roomInfo = Utils.deepClone(templateRoomInfo || {});
        const bossMeta = getNightmareBossMetaByBossId(getNumericFieldValue(context || {}, ['bossId'], null))
            || getNightmareBossMetaByMonsterCfgId(getNumericFieldValue(context || {}, ['monsterCfgId'], null))
            || getNightmareBossMetaByMonsterCfgId(getNumericFieldValue(roomInfo, ['curMonsterCfgId', 'lastMonsterId'], null));
        const bossId = bossMeta
            ? Number(bossMeta.bossId)
            : getNumericFieldValue(
                context || {},
                ['bossId'],
                getNumericFieldValue(notify, ['bossCfgId', 'bossId'], null),
            );
        const monsterCfgId = bossMeta
            ? Number(bossMeta.legionBossShow || bossMeta.monsterIds && bossMeta.monsterIds[0] || 0)
            : getNumericFieldValue(
                context || {},
                ['monsterCfgId'],
                getNumericFieldValue(roomInfo, ['curMonsterCfgId', 'lastMonsterCfgId', 'lastMonsterId'], null),
            );
        const leftRoleId = getNumericFieldValue(
            roomInfo,
            ['leftRoleId'],
            Number(Utils.safeCall(() => battleData.leftTeam.roleId, 0)) || 0,
        );
        const rightRoleId = getNumericFieldValue(
            roomInfo,
            ['rightRoleId'],
            Number(Utils.safeCall(() => battleData.rightTeam.roleId, 0)) || 1,
        );
        roomInfo.roomId = roomInfo.roomId != null ? roomInfo.roomId : '';
        roomInfo.roomName = roomInfo.roomName != null ? roomInfo.roomName : '';
        roomInfo.roomType = getNumericFieldValue(roomInfo, ['roomType'], 0);
        roomInfo.state = getNumericFieldValue(roomInfo, ['state'], 1);
        roomInfo.leaderId = getNumericFieldValue(roomInfo, ['leaderId'], 0);
        roomInfo.createAt = getNumericFieldValue(roomInfo, ['createAt'], 0);
        roomInfo.lastFightAt = Math.floor(Date.now() / 1000);
        roomInfo.nextOperateAt = getNumericFieldValue(roomInfo, ['nextOperateAt'], 0);
        roomInfo.leftRoleId = leftRoleId;
        roomInfo.rightRoleId = rightRoleId;
        roomInfo.round = getNumericFieldValue(roomInfo, ['round'], 0);
        roomInfo.matchRound = getNumericFieldValue(roomInfo, ['matchRound'], 0);
        roomInfo.matchIndex = getNumericFieldValue(roomInfo, ['matchIndex'], 0);
        roomInfo.innings = getNumericFieldValue(roomInfo, ['innings'], 1);
        roomInfo.curMonsterCfgId = getNumericFieldValue(roomInfo, ['curMonsterCfgId'], monsterCfgId);
        roomInfo.lastMonsterCfgId = getNumericFieldValue(roomInfo, ['lastMonsterCfgId'], monsterCfgId);
        roomInfo.lastMonsterId = getNumericFieldValue(roomInfo, ['lastMonsterId'], bossId);
        roomInfo.bossCfgId = getNumericFieldValue(roomInfo, ['bossCfgId'], bossId);
        if (!roomInfo.rule || typeof roomInfo.rule !== 'object') {
            roomInfo.rule = {};
        }
        roomInfo.rule.groupType = getNumericFieldValue(roomInfo.rule, ['groupType'], 0);
        roomInfo.rule.clientRoleNum = getNumericFieldValue(
            roomInfo.rule,
            ['clientRoleNum'],
            resolveNightmareRoomClientRoleNum(templateInput),
        );
        roomInfo.rule.bagStrength = getNumericFieldValue(roomInfo.rule, ['bagStrength'], 0);
        roomInfo.rule.nM = resolveNightmareRoomMarker(context, templateInput);
        notify.roomInfo = roomInfo;
        notify.attackRoleId = leftRoleId;
        notify.defendRoleId = rightRoleId;
        notify.roleId = getNumericFieldValue(notify, ['roleId'], leftRoleId);
        notify.bossCfgId = getNumericFieldValue(notify, ['bossCfgId'], bossId);
        notify.bossId = getNumericFieldValue(notify, ['bossId'], bossId);
        notify.monsterCfgId = getNumericFieldValue(notify, ['monsterCfgId'], monsterCfgId);
        notify.nextAttackRoleId = 0;
        notify.nextDefendRoleId = 0;
        notify.attackScore = result && result.isWin ? 1 : 0;
        notify.defendScore = result && result.isWin ? 0 : 1;
        notify.winRid = result && result.isWin ? leftRoleId : rightRoleId;
        notify.innings = getNumericFieldValue(notify, ['innings'], roomInfo.innings || 1);
        notify.isInningsEnd = true;
        notify.isMatchEnd = true;
        notify.isRoundEnd = true;
        notify.battleData = Utils.deepClone(battleData);
        if (notify.battleData && typeof notify.battleData === 'object') {
            notify.battleData.result = Utils.deepClone(result);
        }
        return notify;
    }

    function syncNightmareRoomReplayInput(input, context, battleData, result, templateInput = null) {
        const replayInput = input || {};
        const roomTemplate = templateInput || replayInput;
        const fightNotify = buildNightmareRoomFightNotify(context, battleData, result, roomTemplate);
        replayInput.roomType = getNumericFieldValue(
            replayInput,
            ['roomType'],
            getNumericFieldValue(fightNotify.roomInfo || {}, ['roomType'], 0),
        );
        replayInput.groupType = getNumericFieldValue(
            replayInput,
            ['groupType'],
            getNumericFieldValue(fightNotify.roomInfo && fightNotify.roomInfo.rule ? fightNotify.roomInfo.rule : {}, ['groupType'], 0),
        );
        replayInput.clientRoleNum = getNumericFieldValue(
            replayInput,
            ['clientRoleNum'],
            resolveNightmareRoomClientRoleNum(roomTemplate),
        );
        replayInput.bagStrength = getNumericFieldValue(
            replayInput,
            ['bagStrength'],
            getNumericFieldValue(fightNotify.roomInfo && fightNotify.roomInfo.rule ? fightNotify.roomInfo.rule : {}, ['bagStrength'], 0),
        );
        replayInput.roleId = getNumericFieldValue(replayInput, ['roleId'], getNumericFieldValue(fightNotify, ['roleId'], 0));
        replayInput.bossCfgId = getNumericFieldValue(replayInput, ['bossCfgId'], getNumericFieldValue(fightNotify, ['bossCfgId'], null));
        replayInput.bossId = getNumericFieldValue(replayInput, ['bossId'], getNumericFieldValue(fightNotify, ['bossId'], null));
        replayInput.curMonsterCfgId = getNumericFieldValue(
            replayInput,
            ['curMonsterCfgId'],
            getNumericFieldValue(fightNotify.roomInfo || {}, ['curMonsterCfgId'], null),
        );
        replayInput.lastMonsterId = getNumericFieldValue(
            replayInput,
            ['lastMonsterId'],
            getNumericFieldValue(fightNotify.roomInfo || {}, ['lastMonsterId'], null),
        );
        replayInput.nM = resolveNightmareRoomMarker(context, roomTemplate);
        replayInput.valid = replayInput.valid !== false;
        replayInput.ignoreResult = false;
        replayInput.isReplay = false;
        replayInput.robotReplay = false;
        if (replayInput.mapId == null) {
            replayInput.mapId = 0;
        }
        replayInput.showRightPower = Number(Utils.safeCall(() => battleData.rightTeam.power, replayInput.showRightPower || 0)) || 0;
        replayInput.showRightLevel = getMaxTeamLevel(Utils.safeCall(() => battleData.rightTeam.team, null))
            || Number(replayInput.showRightLevel || 0);
        if (replayInput.robotMaxDamage == null) {
            replayInput.robotMaxDamage = 0;
        }
        if (replayInput.robotMaxDamageTime == null) {
            replayInput.robotMaxDamageTime = Date.now();
        }
        if (!Array.isArray(replayInput.replayPlayerInfo)) {
            replayInput.replayPlayerInfo = [];
        }
        replayInput.battleData = Utils.deepClone(battleData);
        replayInput.battleResult = Utils.deepClone(result);
        replayInput.fightNotify = fightNotify;
        if (replayInput.rawData && typeof replayInput.rawData === 'object') {
            if (Object.prototype.hasOwnProperty.call(replayInput.rawData, 'battleData')) {
                replayInput.rawData.battleData = Utils.deepClone(battleData);
            }
            if (Object.prototype.hasOwnProperty.call(replayInput.rawData, 'battleResult')) {
                replayInput.rawData.battleResult = Utils.deepClone(result);
            }
            if (Object.prototype.hasOwnProperty.call(replayInput.rawData, 'result')) {
                replayInput.rawData.result = Utils.deepClone(result);
            }
        }
        return replayInput;
    }

    function withTemporaryInstanceValue(target, propertyName, value, callback) {
        if (!target || typeof target !== 'object' || typeof callback !== 'function') {
            return typeof callback === 'function' ? callback(false) : null;
        }
        const hadOwnProperty = Object.prototype.hasOwnProperty.call(target, propertyName);
        const originalDescriptor = hadOwnProperty
            ? Object.getOwnPropertyDescriptor(target, propertyName)
            : null;
        let overridden = false;
        try {
            Object.defineProperty(target, propertyName, {
                configurable: true,
                enumerable: originalDescriptor ? !!originalDescriptor.enumerable : true,
                writable: true,
                value,
            });
            overridden = true;
        } catch (error) {
            overridden = false;
        }
        try {
            return callback(overridden);
        } finally {
            if (overridden) {
                if (hadOwnProperty && originalDescriptor) {
                    Object.defineProperty(target, propertyName, originalDescriptor);
                } else {
                    delete target[propertyName];
                }
            }
        }
    }

    function buildNightmareRoomCacheData(cacheData, notify, replayInput = null) {
        const nextCacheData = Utils.deepClone(
            cacheData && typeof cacheData === 'object' ? cacheData : {},
        ) || {};
        if (!nextCacheData.cachedPKRoom || typeof nextCacheData.cachedPKRoom !== 'object') {
            nextCacheData.cachedPKRoom = {};
        }
        const cachedPKRoom = nextCacheData.cachedPKRoom;
        const roomInfo = Utils.deepClone(Utils.safeCall(() => notify.roomInfo, null) || {});
        const roomRule = roomInfo && typeof roomInfo.rule === 'object'
            ? roomInfo.rule
            : {};
        cachedPKRoom.roomInfo = roomInfo;
        cachedPKRoom.matchIndex = getNumericFieldValue(
            cachedPKRoom,
            ['matchIndex'],
            getNumericFieldValue(roomInfo, ['matchIndex'], 0),
        );
        cachedPKRoom.roomType = getNumericFieldValue(
            cachedPKRoom,
            ['roomType'],
            getNumericFieldValue(roomInfo, ['roomType'], getNumericFieldValue(replayInput || {}, ['roomType'], 0)),
        );
        cachedPKRoom.groupType = getNumericFieldValue(
            cachedPKRoom,
            ['groupType'],
            getNumericFieldValue(roomRule, ['groupType'], getNumericFieldValue(replayInput || {}, ['groupType'], 0)),
        );
        cachedPKRoom.clientRoleNum = getNumericFieldValue(
            cachedPKRoom,
            ['clientRoleNum'],
            getNumericFieldValue(roomRule, ['clientRoleNum'], resolveNightmareRoomClientRoleNum(replayInput)),
        );
        cachedPKRoom.bagStrength = getNumericFieldValue(
            cachedPKRoom,
            ['bagStrength'],
            getNumericFieldValue(roomRule, ['bagStrength'], getNumericFieldValue(replayInput || {}, ['bagStrength'], 0)),
        );
        cachedPKRoom.nM = getNumericFieldValue(
            cachedPKRoom,
            ['nM'],
            getNumericFieldValue(roomRule, ['nM'], getNightmareRoomMarkerValue(replayInput, 0)),
        );
        return nextCacheData;
    }

    function withTemporaryBattleRoomCacheData(target, patchedCacheData, callback) {
        return withTemporaryInstanceValue(target, 'cacheData', patchedCacheData, (overridden) => {
            if (overridden) {
                return typeof callback === 'function' ? callback(true) : null;
            }
            const liveCacheData = Utils.safeCall(() => target.cacheData, null);
            if (!liveCacheData || typeof liveCacheData !== 'object') {
                return typeof callback === 'function' ? callback(false) : null;
            }
            const hadCachedPKRoom = Object.prototype.hasOwnProperty.call(liveCacheData, 'cachedPKRoom');
            const originalCachedPKRoom = Utils.deepClone(liveCacheData.cachedPKRoom);
            liveCacheData.cachedPKRoom = Utils.deepClone(
                patchedCacheData && typeof patchedCacheData === 'object'
                    ? patchedCacheData.cachedPKRoom
                    : null,
            );
            try {
                return typeof callback === 'function' ? callback(true) : null;
            } finally {
                if (hadCachedPKRoom) {
                    liveCacheData.cachedPKRoom = originalCachedPKRoom;
                } else {
                    delete liveCacheData.cachedPKRoom;
                }
            }
        });
    }

    function buildNightmareReplayInput(context, battleData, result, preferredInput = null) {
        const roomTemplate = findNightmareRoomTemplateInput(preferredInput);
        const roomBattleData = buildNightmareRoomBattleData(battleData, result);
        if (roomTemplate) {
            const input = buildReplayInputFromBase(roomTemplate, roomBattleData, result) || {
                battleData: Utils.deepClone(roomBattleData),
                battleResult: Utils.deepClone(result),
            };
            return syncNightmareRoomReplayInput(input, context, roomBattleData, result, roomTemplate);
        }
        const battleRoomModule = Utils.safeCall(() => Runtime.getModuleByTypeKey('BATTLE_ROOM'), null);
        if (battleRoomModule && typeof battleRoomModule.createBattleInputData === 'function') {
            const originalCacheData = Utils.safeCall(() => battleRoomModule.cacheData, null);
            const notify = buildNightmareRoomFightNotify(context, roomBattleData, result, roomTemplate);
            const patchedRoomInfo = Utils.deepClone(notify.roomInfo);
            const patchedCacheData = buildNightmareRoomCacheData(
                originalCacheData,
                notify,
                roomTemplate,
            );
            const input = withTemporaryInstanceValue(
                battleRoomModule,
                'roomInfo',
                patchedRoomInfo,
                () => withTemporaryBattleRoomCacheData(
                    battleRoomModule,
                    patchedCacheData,
                    () => Utils.safeCall(() => battleRoomModule.createBattleInputData(notify, true), null),
                ),
            );
            if (input) {
                return syncNightmareRoomReplayInput(input, context, roomBattleData, result, roomTemplate);
            }
        }
        return buildLooseReplayInput(
            battleData,
            result,
            'nightmare',
            preferredInput,
        );
    }

    function extractReplayRewards(inputData) {
        const directRewards = [
            inputData && inputData.reward,
            inputData && inputData.rewards,
            inputData && inputData.rawData && inputData.rawData.reward,
            inputData && inputData.rawData && inputData.rawData.rewards,
            inputData && inputData.data && inputData.data.reward,
            inputData && inputData.data && inputData.data.rewards,
            inputData && inputData.__nonPvpPlaybackMeta && inputData.__nonPvpPlaybackMeta.rewards,
        ];
        for (let i = 0; i < directRewards.length; i += 1) {
            if (Array.isArray(directRewards[i])) {
                return Utils.deepClone(directRewards[i]);
            }
        }
        const rewards = getOptionValue(inputData && inputData.options, 'rewards', []);
        return Array.isArray(rewards) ? Utils.deepClone(rewards) : [];
    }

    function createGenericBattleEndHandler(modeKey = '') {
        return async function genericBattleEnd(inputData, battleResult, uiProxy, isReplay = false) {
            const finalResult = inputData && inputData.battleResult && Number(inputData.battleResult.totalFrame || 0) > 0
                ? inputData.battleResult
                : battleResult;
            if (inputData) {
                inputData.battleResult = Utils.deepClone(finalResult);
                if (inputData.battleData && typeof inputData.battleData === 'object') {
                    inputData.battleData.result = Utils.deepClone(finalResult);
                }
                setOptionValue(ensureOptionsContainer(inputData), 'isReplay', !!isReplay);
            }
            const rewards = extractReplayRewards(inputData);
            const battleUIManager = Utils.safeCall(() => Runtime.getBattleUIManager(), null);
            const managerFactory = Utils.safeCall(() => Runtime.getManagerFactory(), null);
            Utils.pushDataSource(`浣跨敤閫氱敤 battleEnd 鏀跺熬 ${MODE_LABELS[modeKey] || modeKey || 'capture'} / replay=${isReplay ? '1' : '0'}`);
            try {
                if (battleUIManager && typeof battleUIManager.SHOW_BATTLE_RESULT === 'function' && inputData && finalResult) {
                    await Promise.resolve(battleUIManager.SHOW_BATTLE_RESULT({
                        battleInputData: inputData,
                        battleResultData: finalResult,
                        reward: rewards,
                    }));
                }
            } catch (error) {
                Utils.warn('generic battleEnd show result failed', error);
            } finally {
                if (managerFactory && typeof managerFactory.QUIT_BATTLE === 'function' && inputData) {
                    Utils.safeCall(() => managerFactory.QUIT_BATTLE(inputData), null);
                }
                if (uiProxy && typeof uiProxy.close === 'function') {
                    Utils.safeCall(() => uiProxy.close(), null);
                }
            }
        };
    }

    function createManagedReplayBattleEndHandler(modeKey = '') {
        return async function managedReplayBattleEnd(inputData, battleResult, uiProxy, isReplay = false) {
            const finalResult = inputData && inputData.battleResult && Number(inputData.battleResult.totalFrame || 0) > 0
                ? inputData.battleResult
                : battleResult;
            if (inputData) {
                inputData.battleResult = Utils.deepClone(finalResult);
                if (inputData.battleData && typeof inputData.battleData === 'object') {
                    inputData.battleData.result = Utils.deepClone(finalResult);
                }
                setOptionValue(ensureOptionsContainer(inputData), 'isReplay', !!isReplay);
            }
            const rewards = extractReplayRewards(inputData);
            const battleUIManager = Utils.safeCall(() => Runtime.getBattleUIManager(), null);
            const managerFactory = Utils.safeCall(() => Runtime.getManagerFactory(), null);
            let finalized = false;
            let finalizeFallbackTimer = null;
            const clearFinalizeFallbackTimer = () => {
                if (finalizeFallbackTimer) {
                    clearTimeout(finalizeFallbackTimer);
                    finalizeFallbackTimer = null;
                }
            };
            const armFinalizeFallback = (reason, delayMs = 1500) => {
                clearFinalizeFallbackTimer();
                finalizeFallbackTimer = setTimeout(() => {
                    Utils.pushDataSource(`managed battleEnd fallback finalize ${MODE_LABELS[modeKey] || modeKey || 'capture'} / reason=${reason}`);
                    finalize();
                }, delayMs);
            };
            const finalize = () => {
                if (finalized) {
                    return;
                }
                finalized = true;
                clearFinalizeFallbackTimer();
                if (managerFactory && typeof managerFactory.QUIT_BATTLE === 'function' && inputData) {
                    Utils.safeCall(() => managerFactory.QUIT_BATTLE(inputData), null);
                }
                if (uiProxy && typeof uiProxy.close === 'function') {
                    Utils.safeCall(() => uiProxy.close(), null);
                }
                restorePlaybackBattleVisible(`battleEnd:${modeKey || 'capture'}`);
            };
            Utils.pushDataSource(`managed battleEnd ${MODE_LABELS[modeKey] || modeKey || 'capture'} / replay=${isReplay ? '1' : '0'}`);
            try {
                if (battleUIManager && typeof battleUIManager.SHOW_BATTLE_RESULT === 'function' && inputData && finalResult) {
                    armFinalizeFallback('showResultStart', 8000);
                    await Promise.resolve(battleUIManager.SHOW_BATTLE_RESULT({
                        battleInputData: inputData,
                        battleResultData: finalResult,
                        reward: rewards,
                        hookOnHide: finalize,
                    }));
                    if (!finalized) {
                        armFinalizeFallback('showResultResolvedNoHide', 1200);
                    }
                    return;
                }
            } catch (error) {
                Utils.warn('managed replay battleEnd failed', error);
            }
            finalize();
        };
    }

    function ensureReplayInputRuntimeFields(replayInput, battleData, result, modeKey = '') {
        const input = replayInput || {};
        if (!input.battleData && battleData) {
            input.battleData = Utils.deepClone(battleData);
        }
        if (!input.battleResult && result) {
            input.battleResult = Utils.deepClone(result);
        }
        setOptionValue(ensureOptionsContainer(input), 'isReplay', true);
        input.battleEnd = createManagedReplayBattleEndHandler(modeKey);
        return markPlaybackInputInternal(input, `ensureReplayInputRuntimeFields:${modeKey || 'capture'}`, {
            modeKey: modeKey || '',
        });
    }

    function sanitizeReplayInputForMode(replayInput, modeKey = '') {
        const input = replayInput || {};
        if (modeKey === 'tower' || modeKey === 'evoTower') {
            if (input.endTime != null) {
                input.endTime = undefined;
            }
            if (modeKey === 'evoTower') {
                setOptionValue(ensureOptionsContainer(input), 'evoTowerAutoBattle', 0);
            }
        }
        if (modeKey === 'nightmareStar' || modeKey === 'nightmare') {
            input.mapId = 100001;
        }
        return input;
    }

    function createAuthorityDraft(mode, context, capability, cache, replayBuilder) {
        if (!cache || !cache.battleData) {
            throw new Error('当前玩法还没有可用的权威 battleData');
        }
        return {
            mode,
            label: MODE_LABELS[mode] || mode,
            context: Utils.deepClone(context || {}),
            capability,
            notes: [],
            cache,
            buildBattleData(candidate, seed) {
                const battleData = Utils.deepClone(cache.battleData);
                battleData.id = Date.now() + seed;
                battleData.randomSeed = seed;
                applyCandidateToBattleData(battleData, candidate);
                resetBattleRuntimeState(battleData);
                return battleData;
            },
            buildReplayInput(result, battleData, candidate) {
                if (typeof replayBuilder === 'function') {
                    return replayBuilder(cache, battleData, result, candidate);
                }
                return buildLooseReplayInput(
                    battleData,
                    result,
                    mode,
                    cache.inputData || state.latestCapture && state.latestCapture.input,
                );
            },
        };
    }

    function buildLooseReplayInput(battleData, result, modeKey = '', preferredInput = null) {
        const templateInput = getReplayTemplateInput(modeKey, preferredInput);
        const replayInput = buildReplayInputFromBase(templateInput, battleData, result);
        if (replayInput) {
            return sanitizeReplayInputForMode(
                ensureReplayInputRuntimeFields(replayInput, battleData, result, modeKey),
                modeKey,
            );
        }
        return sanitizeReplayInputForMode(
            ensureReplayInputRuntimeFields({
                battleData: Utils.deepClone(battleData),
                battleResult: Utils.deepClone(result),
            }, battleData, result, modeKey),
            modeKey,
        );
    }

    function shouldPreferReplayUI(modeKey = '', replayInput = null) {
        return modeKey === 'nightmare';
    }

    function prepareReplayInputForLaunch(replayInput, modeKey = '', useReplayUI = false) {
        const input = sanitizeReplayInputForMode(replayInput || {}, modeKey);
        setOptionValue(ensureOptionsContainer(input), 'isReplay', !!useReplayUI);
        return markPlaybackInputInternal(input, `replayLaunch:${modeKey || 'capture'}`, {
            preferReplayUI: !!useReplayUI,
        });
    }

    function createPreviewDraft(mode, context, capability, buildBattleData, replayBuilder) {
        return {
            mode,
            label: MODE_LABELS[mode] || mode,
            context: Utils.deepClone(context || {}),
            capability,
            notes: ['preview'],
            buildBattleData(candidate, seed) {
                return buildBattleData(candidate, seed);
            },
            buildReplayInput(result, battleData, candidate) {
                if (typeof replayBuilder === 'function') {
                    return replayBuilder(result, battleData, candidate);
                }
                return buildLooseReplayInput(battleData, result, mode);
            },
        };
    }

    function getConfigById(conf, id) {
        if (!conf || id == null) {
            return null;
        }
        if (typeof conf.getById === 'function') {
            const value = Utils.safeCall(() => conf.getById(id), null);
            if (value) {
                return value;
            }
        }
        if (conf[id] != null) {
            return conf[id];
        }
        if (conf[String(id)] != null) {
            return conf[String(id)];
        }
        if (Array.isArray(conf.list)) {
            return conf.list.find((item) => Number(item && (item.id != null ? item.id : item.ID)) === Number(id)) || null;
        }
        return null;
    }

    function getFirstConfigTable(...names) {
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        if (!Configs) {
            return null;
        }
        for (let i = 0; i < names.length; i += 1) {
            const table = Configs[names[i]];
            if (table) {
                return table;
            }
        }
        return null;
    }

    function listConfigEntries(conf) {
        if (!conf) {
            return [];
        }
        if (Array.isArray(conf.list)) {
            return conf.list.filter((item) => item && typeof item === 'object');
        }
        if (typeof conf.forEach === 'function') {
            const result = [];
            Utils.safeCall(() => conf.forEach((item) => {
                if (item && typeof item === 'object') {
                    result.push(item);
                }
            }), null);
            if (result.length) {
                return result;
            }
        }
        return Object.keys(conf)
            .map((key) => conf[key])
            .filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    }

    function findConfigTablesByName(predicate) {
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        if (!Configs) {
            return [];
        }
        return Object.keys(Configs)
            .filter((name) => predicate(name, Configs[name]))
            .map((name) => ({
                name,
                table: Configs[name],
            }));
    }

    function getFallbackConfigTable(namePattern) {
        const matched = findConfigTablesByName((name, table) => {
            if (!name || !table || !name.includes(namePattern)) {
                return false;
            }
            return listConfigEntries(table).length > 0;
        });
        return matched.length ? matched[0].table : null;
    }

    function getNightmareMonsterTable() {
        return getFirstConfigTable('NightMareMonster')
            || getFallbackConfigTable('NightMareMonster');
    }

    function getNightmarePhaseIndex(hallNumber, bossId, hidden, fallbackPhase = 0) {
        const normalizedHall = Number(hallNumber || 0);
        if (normalizedHall !== 9) {
            const numericFallback = Number(fallbackPhase || 0);
            return Number.isFinite(numericFallback) && numericFallback > 0 ? numericFallback : 0;
        }
        const normalizedBossId = Number(bossId || 0);
        if (normalizedBossId === 11) {
            return 1;
        }
        if (normalizedBossId === 12) {
            return 2;
        }
        const normalizedHidden = Number(hidden || 0);
        if (normalizedHidden === 1) {
            return 1;
        }
        if (normalizedHidden === 0) {
            return 2;
        }
        const numericFallback = Number(fallbackPhase || 0);
        return Number.isFinite(numericFallback) && numericFallback > 0 ? numericFallback : 0;
    }

    function buildNightmareHallText(hallNumber, phaseIndex) {
        const normalizedHall = Number(hallNumber || 0);
        if (!Number.isFinite(normalizedHall) || normalizedHall <= 0) {
            return '十殿试炼';
        }
        if (normalizedHall === 9 && Number(phaseIndex || 0) > 0) {
            if (Number(phaseIndex) === 1) {
                return '第9殿 一形态';
            }
            if (Number(phaseIndex) === 2) {
                return '第9殿 二形态';
            }
            return `第9殿 形态${phaseIndex}`;
        }
        return `第${normalizedHall}殿`;
    }

    function buildNightmareManualTargetOption(meta, fallbackPhase = 0) {
        if (!meta) {
            return null;
        }
        const bossId = Number(meta.bossId || 0);
        const hallNumber = Number(meta.hallNumber || 0);
        if (!Number.isFinite(bossId) || bossId <= 0 || !Number.isFinite(hallNumber) || hallNumber <= 0) {
            return null;
        }
        const phaseIndex = getNightmarePhaseIndex(hallNumber, bossId, meta.hidden, fallbackPhase);
        const labelName = meta.displayName || meta.description || '';
        const hallText = buildNightmareHallText(hallNumber, phaseIndex);
        const label = labelName ? `十殿试炼${hallText} - ${labelName}` : `十殿试炼${hallText}`;
        const displayText = phaseIndex > 0 ? `${hallNumber}-${phaseIndex}` : `${hallNumber}`;
        const sortValue = phaseIndex > 0 ? hallNumber * 10 + phaseIndex : hallNumber;
        return buildManualTargetOption(bossId, label, {
            rank: hallNumber,
            displayNumber: hallNumber,
            displayText,
            sortValue,
            hidden: meta.hidden,
            phaseIndex,
        });
    }

    function getNightmareMonsterMetas() {
        const table = getNightmareMonsterTable();
        return listConfigEntries(table).map((item, index) => {
            const bossId = getNumericFieldValue(item, ['bossId', 'id', 'ID'], null);
            const hallNumber = getNumericFieldValue(item, ['bossType', 'roomId', 'room', 'idx', 'index', 'order'], index + 1);
            if (bossId == null || hallNumber == null) {
                return null;
            }
            const hidden = getNumericFieldValue(item, ['hidden'], 0);
            const legionBossShow = getNumericFieldValue(item, ['legionBossShow'], null);
            const monsters = normalizeMonsterTriples(
                item.monsters || item.monster || item.enemyMonsters || item.fightTeam || [],
            );
            const monsterIds = Array.isArray(item.monsters)
                ? item.monsters
                    .map((monster) => Array.isArray(monster) ? Number(monster[0] || 0) : 0)
                    .filter((monsterId) => Number.isFinite(monsterId) && monsterId > 0)
                : [];
            const maskName = getTextFieldValue(item, ['maskName', 'name', 'title'], '');
            const description = getFirstLineText(getLanguageText(getTextFieldValue(item, ['bossDescription', 'description'], ''), ''));
            const phaseIndex = getNightmarePhaseIndex(hallNumber, bossId, hidden, 0);
            return {
                bossId,
                hallNumber,
                hidden,
                phaseIndex,
                legionBossShow,
                monsters,
                monsterIds,
                displayName: maskName || description || '',
                description,
                raw: item,
            };
        }).filter(Boolean);
    }

    function getNightmareBossMetaByBossId(bossId) {
        const targetBossId = Number(bossId || 0);
        if (!Number.isFinite(targetBossId) || targetBossId <= 0) {
            return null;
        }
        return getNightmareMonsterMetas().find((item) => Number(item.bossId) === targetBossId) || null;
    }

    function getNightmareBossMetaByMonsterCfgId(monsterCfgId) {
        const targetMonsterId = Number(monsterCfgId || 0);
        if (!Number.isFinite(targetMonsterId) || targetMonsterId <= 0) {
            return null;
        }
        return getNightmareMonsterMetas().find((item) => {
            if (Number(item.legionBossShow) === targetMonsterId) {
                return true;
            }
            return item.monsterIds.some((monsterId) => Number(monsterId) === targetMonsterId);
        }) || null;
    }

    function getNightmarePreviewInfo(context, fallbackMonsters = null) {
        const bossMeta = getNightmareBossMetaByBossId(Utils.safeCall(() => context.bossId, null))
            || getNightmareBossMetaByMonsterCfgId(Utils.safeCall(() => context.monsterCfgId, null));
        const monsters = bossMeta && Array.isArray(bossMeta.monsters) && bossMeta.monsters.length
            ? bossMeta.monsters
            : fallbackMonsters;
        return {
            bossMeta,
            monsters: normalizeMonsterTriples(monsters),
        };
    }

    function getNightmareStarTable() {
        return getFirstConfigTable('NightMareStarConf', 'NightmareStarConf')
            || getFallbackConfigTable('NightMareStar');
    }

    function getNightmareStarMetas() {
        const table = getNightmareStarTable();
        const nightmareMetaMap = new Map(
            getNightmareMonsterMetas().map((item) => [Number(item.bossId), item]),
        );
        return listConfigEntries(table).map((item, index) => {
            const bossId = getNumericFieldValue(item, ['bossId', 'id', 'ID'], null);
            if (bossId == null) {
                return null;
            }
            const monsters = normalizeMonsterTriples(
                item.monsters || item.monster || item.enemyMonsters || item.fightTeam || [],
            );
            const monsterIds = monsters
                .map((monster) => Number(monster.monsterId || 0))
                .filter((monsterId) => Number.isFinite(monsterId) && monsterId > 0);
            const nightmareMeta = nightmareMetaMap.get(Number(bossId)) || null;
            const translatedDesc = getFirstLineText(
                getLanguageText(getTextFieldValue(item, ['bossDescription', 'description'], ''), ''),
            );
            const displayName = getTextFieldValue(item, ['name', 'title'], '')
                || translatedDesc
                || (nightmareMeta && nightmareMeta.displayName ? nightmareMeta.displayName : '');
            return {
                bossId,
                stageNumber: index + 1,
                unlockStar: getNumericFieldValue(item, ['unlockStar'], 0),
                challengeTime: getNumericFieldValue(item, ['challengeTime'], 0),
                legionBossShow: getNumericFieldValue(item, ['legionBossShow'], null),
                monsters,
                monsterIds,
                displayName,
                description: translatedDesc,
                nightmareMeta,
                raw: item,
            };
        }).filter(Boolean);
    }

    function getNightmareStarConfigByBossId(bossId) {
        const normalizedBossId = Number(bossId || 0);
        if (!Number.isFinite(normalizedBossId) || normalizedBossId <= 0) {
            return null;
        }
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        const directConf = Configs && Configs.NightMareStarConf && typeof Configs.NightMareStarConf.getByBossId === 'function'
            ? Utils.safeCall(() => Configs.NightMareStarConf.getByBossId(normalizedBossId), null)
            : null;
        if (directConf) {
            return directConf;
        }
        const table = getNightmareStarTable();
        return listConfigEntries(table).find((item) => Number(getNumericFieldValue(item, ['bossId', 'id', 'ID'], 0)) === normalizedBossId) || null;
    }

    function getNightmareStarMetaByBossId(bossId) {
        const targetBossId = Number(bossId || 0);
        if (!Number.isFinite(targetBossId) || targetBossId <= 0) {
            return null;
        }
        return getNightmareStarMetas().find((item) => Number(item.bossId) === targetBossId) || null;
    }

    function getNightmareStarMetaByMonsterCfgId(monsterCfgId) {
        const targetMonsterId = Number(monsterCfgId || 0);
        if (!Number.isFinite(targetMonsterId) || targetMonsterId <= 0) {
            return null;
        }
        return getNightmareStarMetas().find((item) => {
            if (Number(item.legionBossShow) === targetMonsterId) {
                return true;
            }
            return item.monsterIds.some((monsterId) => Number(monsterId) === targetMonsterId);
        }) || null;
    }

    function getNightmareStarPreviewInfo(context, fallbackMonsters = null) {
        const bossMeta = getNightmareStarMetaByBossId(Utils.safeCall(() => context.bossId, null))
            || getNightmareStarMetaByMonsterCfgId(Utils.safeCall(() => context.monsterCfgId, null));
        const conf = getNightmareStarConfigByBossId(Utils.safeCall(() => context.bossId, null))
            || Utils.safeCall(() => bossMeta.raw, null);
        const monsters = bossMeta && Array.isArray(bossMeta.monsters) && bossMeta.monsters.length
            ? bossMeta.monsters
            : conf && Array.isArray(conf.monsters) && conf.monsters.length
                ? conf.monsters
                : fallbackMonsters;
        return {
            bossMeta,
            conf,
            monsters: normalizeMonsterTriples(monsters),
        };
    }

    function getNightmareStarStageMeta(bossId) {
        const normalizedBossId = Number(bossId || 0);
        if (!Number.isFinite(normalizedBossId) || normalizedBossId <= 0) {
            return null;
        }
        const starMeta = getNightmareStarMetaByBossId(normalizedBossId);
        const conf = getNightmareStarConfigByBossId(normalizedBossId) || Utils.safeCall(() => starMeta.raw, null);
        const nightmareMeta = Utils.safeCall(() => starMeta.nightmareMeta, null)
            || getNightmareBossMetaByBossId(normalizedBossId);
        const translatedDesc = getFirstLineText(
            getLanguageText(getTextFieldValue(conf || {}, ['bossDescription', 'description'], ''), ''),
        );
        const displayName = getTextFieldValue(conf || {}, ['name', 'title'], '')
            || translatedDesc
            || (starMeta && starMeta.displayName ? starMeta.displayName : '')
            || (nightmareMeta && nightmareMeta.displayName ? nightmareMeta.displayName : '');
        return {
            bossId: normalizedBossId,
            stageNumber: Number(starMeta && starMeta.stageNumber ? starMeta.stageNumber : 0),
            conf,
            starMeta,
            nightmareMeta,
            displayName: displayName || '',
        };
    }

    function buildNightmareStarConditionDescriptions(conf, bossId = null) {
        if (!conf || typeof conf !== 'object') {
            return [];
        }
        const normalizedBossId = Number(bossId || getNumericFieldValue(conf, ['bossId', 'id', 'ID'], 0));
        const requiredFullStarAlive = normalizedBossId >= 4 ? 5 : (normalizedBossId >= 2 ? 4 : (normalizedBossId === 1 ? 3 : 5));
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        const conditionType = Configs && Configs.NightMareStarConditionType ? Configs.NightMareStarConditionType : {};
        const types = Array.isArray(conf.nightMareStarConditionType) ? conf.nightMareStarConditionType : [];
        const values = Array.isArray(conf.nightMareStarConditionValue) ? conf.nightMareStarConditionValue : [];
        return types.map((type, index) => {
            const rawValue = Array.isArray(values[index]) ? values[index] : [];
            if (index === 2) {
                const maxRound = Number(rawValue[0] || (normalizedBossId === 1 ? 5 : 4));
                const minAlive = Math.max(Number(rawValue[1] || 0), requiredFullStarAlive);
                const aliveText = minAlive >= 5 ? '且所有咸将存活' : `且至少${minAlive}名咸将存活`;
                return `${maxRound}回合内完成关卡${aliveText}`;
            }
            if (type === conditionType.STAR_CONDITION_ROUND_HEROALIVE || type === 2 || String(type) === '2') {
                const maxRound = Number(rawValue[0] || 0);
                const minAlive = Number(rawValue[1] || 0);
                const aliveText = minAlive >= 5
                    ? '且所有咸将存活'
                    : minAlive > 0 ? `且至少${minAlive}名咸将存活` : '';
                return maxRound > 0 ? `${maxRound}回合内完成关卡${aliveText}` : aliveText;
            }
            if (type === conditionType.STAR_CONDITION_ROUND || type === 1 || String(type) === '1') {
                const maxRound = Number(rawValue[0] || 0);
                return maxRound > 0 ? `${maxRound}回合内完成关卡` : '';
            }
            return '';
        }).filter(Boolean);
    }

    function getMaxTeamLevel(team) {
        return normalizeTeamEntries(team).reduce((maxLevel, { entry }) => {
            const level = Number(entry && entry.level != null ? entry.level : 0);
            return level > maxLevel ? level : maxLevel;
        }, 0);
    }

    function buildNightmareStarReplayInput(context, battleData, result, candidate = null, preferredInput = null) {
        const templateInput = preferredInput && preferredInput.battleData
            ? preferredInput
            : state.modeCaches.nightmareStar && state.modeCaches.nightmareStar.inputData
                ? state.modeCaches.nightmareStar.inputData
                : null;
        const input = buildReplayInputFromBase(templateInput, battleData, result) || {
            battleData: Utils.deepClone(battleData),
            battleResult: Utils.deepClone(result),
        };
        const stageMeta = getNightmareStarStageMeta(context && context.bossId != null ? context.bossId : null);
        const stageNumber = Number(stageMeta && stageMeta.stageNumber ? stageMeta.stageNumber : 0);
        const stageTitle = stageNumber > 0 ? `星级挑战${stageNumber}` : '星级挑战';
        if (input.mapId == null) {
            input.mapId = 100001;
        }
        if (!input.stageNameStr) {
            input.stageNameStr = stageTitle;
        }
        if (!input.startTipTopName) {
            input.startTipTopName = stageTitle;
        }
        if (!input.startTipStage) {
            input.startTipStage = '战斗开始';
        }
        if (!input.topName) {
            input.topName = stageTitle;
        }
        if (input.showRightLevel == null) {
            input.showRightLevel = getMaxTeamLevel(Utils.safeCall(() => battleData.rightTeam.team, null));
        }
        if (input.showRightPower == null) {
            input.showRightPower = Number(Utils.safeCall(() => battleData.rightTeam.power, 0)) || 0;
        }
        const currentStarIdxList = Array.isArray(context && context.nowStarIdxList)
            ? context.nowStarIdxList.slice()
            : [];
        const maxStarCount = Number(
            context && context.maxStarCount != null
                ? context.maxStarCount
                : stageMeta && stageMeta.conf && Array.isArray(stageMeta.conf.nightMareStarConditionType)
                    ? stageMeta.conf.nightMareStarConditionType.length
                    : 3,
        );
        const starBattleOptions = {
            bossId: Number(context && context.bossId != null ? context.bossId : 0),
            maxStarCount,
            nowStarCount: currentStarIdxList.length,
            nowStarIdxList: currentStarIdxList,
            nowStarTaskDescList: buildNightmareStarConditionDescriptions(stageMeta && stageMeta.conf),
            remainStarFightCount: Number(context && context.remainStarFightCount != null ? context.remainStarFightCount : 0),
            battleTeam: createTeamParamMap(candidate),
            lordWeaponId: Number(
                context && context.lordWeaponId != null
                    ? context.lordWeaponId
                    : candidate && candidate.lordWeaponId != null ? candidate.lordWeaponId : 0,
            ),
        };
        setOptionValue(ensureOptionsContainer(input), 'NMStarBattleInputParasKey', starBattleOptions);
        return ensureReplayInputRuntimeFields(input, battleData, result, 'nightmareStar');
    }

    function legacy_getTowerManualTargetOptions() {
        const towerTable = getFirstConfigTable('TowerConf');
        const towerModule = Runtime.getModuleByTypeKey('TOWER');
        return listConfigEntries(towerTable).map((item, index) => {
            const stageId = getNumericFieldValue(item, ['id', 'ID', 'stageId'], null);
            if (stageId == null) {
                return null;
            }
            const detailName = Utils.safeCall(
                () => towerModule && towerModule.constructor && typeof towerModule.constructor.getTowerDetailName === 'function'
                    ? towerModule.constructor.getTowerDetailName(stageId)
                    : '',
                '',
            );
            const label = detailName || `咸将塔关卡 ${index + 1}`;
            return buildManualTargetOption(stageId, label, {
                rank: index + 1,
                displayNumber: index + 1,
                sortValue: stageId,
            });
        }).filter(Boolean);
    }

    function legacy_getEvoTowerManualTargetOptions() {
        const evoTable = getFirstConfigTable('EvoTowerConf', 'CardTowerConf', 'ActCardTowerConf');
        return listConfigEntries(evoTable).map((item, index) => {
            const towerId = getNumericFieldValue(item, ['id', 'ID', 'towerId'], null);
            if (towerId == null) {
                return null;
            }
            const level = getNumericFieldValue(item, ['towerLevel', 'level', 'floor'], index + 1);
            const extraName = getTextFieldValue(item, ['name', 'title'], '');
            const label = extraName
                ? `怪异塔第 ${level} 层 - ${extraName}`
                : `怪异塔第 ${level} 层`;
            return buildManualTargetOption(towerId, label, {
                rank: index + 1,
                displayNumber: level,
                sortValue: level,
            });
        }).filter(Boolean);
    }

    function getTowerManualTargetOptions() {
        const towerTable = getFirstConfigTable('TowerConf');
        const towerModule = Runtime.getModuleByTypeKey('TOWER');
        return listConfigEntries(towerTable).map((item, index) => {
            const stageId = getNumericFieldValue(item, ['id', 'ID', 'stageId'], null);
            if (stageId == null) {
                return null;
            }
            const stageText = formatTowerLikeStageText(stageId);
            const detailName = Utils.safeCall(
                () => towerModule && towerModule.constructor && typeof towerModule.constructor.getTowerDetailName === 'function'
                    ? towerModule.constructor.getTowerDetailName(stageId)
                    : '',
                '',
            );
            const label = detailName || `咸将塔 ${buildTowerLikeStageName(stageId)}`;
            return buildManualTargetOption(stageId, label, {
                rank: index + 1,
                displayNumber: index + 1,
                displayText: stageText,
                sortValue: stageId,
            });
        }).filter(Boolean);
    }

    function getEvoTowerManualTargetOptions() {
        const evoTable = getFirstConfigTable('EvoTowerConf', 'CardTowerConf', 'ActCardTowerConf');
        return listConfigEntries(evoTable).map((item, index) => {
            const towerId = getNumericFieldValue(item, ['id', 'ID', 'towerId'], null);
            if (towerId == null) {
                return null;
            }
            const stageText = formatTowerLikeStageText(towerId);
            const extraName = getTextFieldValue(item, ['name', 'title'], '');
            const label = extraName
                ? `怪异咸将塔 ${buildTowerLikeStageName(towerId)} - ${extraName}`
                : `怪异咸将塔 ${buildTowerLikeStageName(towerId)}`;
            return buildManualTargetOption(towerId, label, {
                rank: index + 1,
                displayNumber: index + 1,
                displayText: stageText,
                sortValue: towerId,
            });
        }).filter(Boolean);
    }

    function getGenieManualTargetOptions(onlyShenhai = false) {
        const genieTable = getFirstConfigTable('GenieLevelConf');
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        const shenhaiClubId = Configs && Configs.Club ? Configs.Club.SHENHAI : null;
        const options = listConfigEntries(genieTable).map((item, index) => {
            const genieLevelId = getNumericFieldValue(item, ['id', 'ID', 'genieLevelId'], null);
            if (genieLevelId == null) {
                return null;
            }
            const clubId = genieLevelId >= 1000 ? Math.floor(genieLevelId / 1000) : null;
            const isShenhai = shenhaiClubId != null && clubId === shenhaiClubId;
            if (onlyShenhai && !isShenhai) {
                return null;
            }
            if (!onlyShenhai && isShenhai) {
                return null;
            }
            const level = genieLevelId >= 1000 ? genieLevelId % 1000 || genieLevelId : genieLevelId;
            const extraName = getTextFieldValue(item, ['name', 'title'], '');
            const clubName = getClubDisplayName(clubId);
            const title = onlyShenhai ? '深海灯神' : buildGenieModeTitle(clubId);
            const label = extraName
                ? `${title}第 ${level} 层 - ${extraName}`
                : `${title}第 ${level} 层`;
            return buildManualTargetOption(genieLevelId, label, {
                rank: index + 1,
                displayNumber: level,
                displayText: onlyShenhai ? `${level}` : clubName ? `${clubName}-${level}` : `${level}`,
                sortValue: genieLevelId,
                clubId,
            });
        }).filter(Boolean);
        if (onlyShenhai && !options.length) {
            return new Array(10).fill(0).map((_, index) => {
                const layer = index + 1;
                const genieLevelId = 5000 + layer;
                return buildManualTargetOption(genieLevelId, `深海灯神第 ${layer} 层`, {
                    rank: layer,
                    displayNumber: layer,
                    sortValue: genieLevelId,
                });
            });
        }
        return options;
    }

    function getMonsterConfigById(monsterId) {
        const normalizedMonsterId = Number(monsterId || 0);
        if (!Number.isFinite(normalizedMonsterId) || normalizedMonsterId <= 0) {
            return null;
        }
        if (state.monsterConfigCache[normalizedMonsterId]) {
            return state.monsterConfigCache[normalizedMonsterId];
        }
        const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
        const monsterTable = Configs && Configs.MonsterConf
            ? Configs.MonsterConf
            : getFirstConfigTable('MonsterConf')
            || getFallbackConfigTable('MonsterConf')
            || getFallbackConfigTable('Monster');
        if (!monsterTable) {
            return null;
        }
        const monsterConf = getNestedTableValue(monsterTable, normalizedMonsterId, (item) => {
            if (!item || typeof item !== 'object') {
                return false;
            }
            const candidateId = getNumericFieldValue(
                item,
                ['id', 'ID', 'monsterId', 'monsterCfgId', 'monsterCfgID', 'cfgId', 'showId'],
                null,
            );
            return Number(candidateId) === normalizedMonsterId;
        });
        if (monsterConf) {
            state.monsterConfigCache[normalizedMonsterId] = monsterConf;
        }
        return monsterConf || null;
    }

    function looksLikeConfigToken(text) {
        if (!text) {
            return false;
        }
        if (/^\d+$/.test(text)) {
            return true;
        }
        if (/Conf_|_name_|_desc_|^ACT_|^skin_|^emojiConf_|^MULTI_/i.test(text)) {
            return true;
        }
        return /^[A-Za-z0-9_.-]+$/.test(text);
    }

    function resolveDisplayTextCandidate(value) {
        const text = getFirstLineText(value == null ? '' : String(value).trim());
        if (!text) {
            return '';
        }
        const translated = getResolvedLanguageText(text);
        if (translated) {
            return translated;
        }
        if (looksLikeConfigToken(text)) {
            return '';
        }
        return text;
    }

    function getMonsterDisplayName(monsterId, fallback = '') {
        const normalizedMonsterId = Number(monsterId || 0);
        if (!Number.isFinite(normalizedMonsterId) || normalizedMonsterId <= 0) {
            return fallback || '';
        }
        if (state.monsterNameCache[normalizedMonsterId]) {
            return state.monsterNameCache[normalizedMonsterId];
        }
        const monsterConf = getMonsterConfigById(normalizedMonsterId);
        const candidateFields = ['monsterName', 'displayName', 'showName', 'bossName', 'name', 'title', 'chinese', 'text'];
        for (let i = 0; i < candidateFields.length; i += 1) {
            const resolved = resolveDisplayTextCandidate(monsterConf ? monsterConf[candidateFields[i]] : '');
            if (resolved) {
                state.monsterNameCache[normalizedMonsterId] = resolved;
                return resolved;
            }
        }
        return fallback || `Boss ${normalizedMonsterId}`;
    }

    function getLegionBossTable() {
        return getFirstConfigTable('LegionBossConf')
            || getFallbackConfigTable('LegionBossConf')
            || getFallbackConfigTable('LegionBoss');
    }

    function getLegionBossConfigById(legionBossId) {
        return getConfigById(getLegionBossTable(), legionBossId);
    }

    function getLegionBossPreviewInfo(context, fallbackMonsters = null) {
        const legionBossId = Number(context && context.legionBossId != null ? context.legionBossId : 0);
        const conf = legionBossId > 0 ? getLegionBossConfigById(legionBossId) : null;
        const legionBossShow = getNumericFieldValue(conf, ['legionBossShow'], getNumericFieldValue(context || {}, ['legionBossShow'], null));
        const monsters = conf && (conf.monsters || conf.monster || conf.enemyMonsters || conf.fightTeam)
            ? (conf.monsters || conf.monster || conf.enemyMonsters || conf.fightTeam)
            : fallbackMonsters;
        const currentHp = Number(context && context.currentHp != null ? context.currentHp : 0);
        return {
            legionBossId,
            conf,
            legionBossShow,
            currentHp: Number.isFinite(currentHp) && currentHp > 0 ? currentHp : 0,
            monsters: normalizeMonsterTriples(monsters),
            name: getMonsterDisplayName(legionBossShow, legionBossId > 0 ? `俱乐部Boss ${legionBossId}` : '俱乐部Boss'),
        };
    }

    function getLegionBossManualTargetOptions() {
        const entries = listConfigEntries(getLegionBossTable());
        const options = entries.map((item, index) => {
            const legionBossId = getNumericFieldValue(item, ['legionBossId', 'id', 'ID'], null);
            if (legionBossId == null) {
                return null;
            }
            const legionBossShow = getNumericFieldValue(item, ['legionBossShow'], null);
            const confDisplayName = resolveDisplayTextCandidate(getTextFieldValue(item, ['name', 'title', 'bossName'], ''));
            const bossName = getMonsterDisplayName(legionBossShow, confDisplayName || `Boss ${legionBossId}`);
            const label = bossName
                ? `俱乐部Boss 第 ${legionBossId} 只 - ${bossName}`
                : `俱乐部Boss 第 ${legionBossId} 只`;
            return buildManualTargetOption(legionBossId, label, {
                rank: index + 1,
                displayNumber: legionBossId,
                sortValue: legionBossId,
                legionBossShow,
            });
        }).filter(Boolean);
        if (options.length) {
            return options;
        }
        return new Array(150).fill(0).map((_, index) => {
            const legionBossId = index + 1;
            return buildManualTargetOption(legionBossId, `俱乐部Boss 第 ${legionBossId} 只`, {
                rank: legionBossId,
                displayNumber: legionBossId,
                sortValue: legionBossId,
            });
        });
    }

    function applyEnemyCurrentHpOverride(battleData, currentHp) {
        const normalizedCurrentHp = Number(currentHp || 0);
        if (!battleData || !Number.isFinite(normalizedCurrentHp) || normalizedCurrentHp <= 0) {
            return;
        }
        const enemyEntries = normalizeTeamEntries(Utils.safeCall(() => battleData.rightTeam && battleData.rightTeam.team, null));
        if (!enemyEntries.length || !enemyEntries[0].entry || typeof enemyEntries[0].entry !== 'object') {
            return;
        }
        const entry = enemyEntries[0].entry;
        entry.curHp = normalizedCurrentHp;
        if (!Number.isFinite(Number(entry.hp)) || Number(entry.hp) < normalizedCurrentHp) {
            entry.hp = normalizedCurrentHp;
        }
        if (!Number.isFinite(Number(entry.maxHp)) || Number(entry.maxHp) < normalizedCurrentHp) {
            entry.maxHp = normalizedCurrentHp;
        }
    }

    function getNightmareStarManualTargetOptions() {
        return getNightmareStarMetas().map((item, index) => {
            const bossId = Number(item.bossId || 0);
            const stageNumber = Number(item.stageNumber || index + 1);
            const extraName = item.displayName || item.description || '';
            const label = extraName
                ? `星级挑战第 ${stageNumber} 关 - ${extraName}`
                : `星级挑战第 ${index + 1} 关`;
            return buildManualTargetOption(bossId, label, {
                rank: stageNumber,
                displayNumber: stageNumber,
                sortValue: stageNumber,
            });
        }).filter(Boolean);
    }

    function getNightmareManualTargetOptions() {
        const nightmareMetas = getNightmareMonsterMetas();
        if (nightmareMetas.length) {
            const hallMap = new Map();
            nightmareMetas
                .slice()
                .sort((left, right) => Number(left.hallNumber || 0) - Number(right.hallNumber || 0)
                    || Number(left.hidden || 0) - Number(right.hidden || 0)
                    || Number(left.bossId || 0) - Number(right.bossId || 0))
                .forEach((item) => {
                    const labelName = item.displayName || item.description || '';
                    const label = labelName
                        ? `十殿第 ${item.hallNumber} 殿 - ${labelName}`
                        : `十殿第 ${item.hallNumber} 殿`;
                    const candidate = buildManualTargetOption(item.bossId, label, {
                        rank: item.hallNumber,
                        displayNumber: item.hallNumber,
                        sortValue: item.hallNumber,
                        hidden: item.hidden,
                    });
                    if (!candidate) {
                        return;
                    }
                    const current = hallMap.get(item.hallNumber);
                    if (!current || (Number(current.hidden || 0) !== 0 && Number(item.hidden || 0) === 0)) {
                        hallMap.set(item.hallNumber, candidate);
                    }
                });
            const options = Array.from(hallMap.values()).sort((left, right) => Number(left.sortValue || 0) - Number(right.sortValue || 0));
            if (options.length) {
                return options;
            }
        }
        const directTables = [
            getFirstConfigTable('NightMareBossConf', 'NightMareConf', 'NightmareConf', 'NightMareRoomConf'),
        ].filter(Boolean);
        const scannedTables = findConfigTablesByName((name, table) => {
            if (!name || !table) {
                return false;
            }
            if (!name.includes('NightMare') || name.includes('Star')) {
                return false;
            }
            return !!listConfigEntries(table).length;
        }).map((item) => item.table);
        const tables = [...directTables, ...scannedTables];
        let best = [];
        tables.forEach((table) => {
            const options = dedupeManualTargetOptions(listConfigEntries(table).map((item, index) => {
                const bossId = getNumericFieldValue(item, ['bossId', 'monsterCfgId', 'monsterId', 'id', 'ID'], null);
                if (bossId == null) {
                    return null;
                }
                const hallNumber = getNumericFieldValue(item, ['roomId', 'room', 'idx', 'index', 'order'], index + 1);
                const extraName = getTextFieldValue(item, ['name', 'title'], '');
                const label = extraName
                    ? `十殿第 ${hallNumber} 殿 - ${extraName}`
                    : `十殿第 ${hallNumber} 殿`;
                return buildManualTargetOption(bossId, label, {
                    rank: index + 1,
                    displayNumber: hallNumber,
                    sortValue: hallNumber,
                });
            }).filter(Boolean));
            if (options.length >= 8 && options.length <= 12) {
                best = options;
            } else if (!best.length && options.length) {
                best = options;
            }
        });
        return best;
    }

    function buildEmptyEnemyEntry(monsterId, index, level) {
        return {
            id: Number(monsterId || 0),
            type: 1,
            index: Number(index || 0),
            level: Number(level || 0),
            attack: 0,
            defense: 0,
            curHp: 0,
            hp: 0,
            curEnergy: 0,
            speed: 0,
            color: 0,
            star: 0,
            order: 0,
            skin: 0,
            skinName: '',
            activeSkill: 0,
            attribute: new Map(),
            enchantMap: new Map(),
            skill: [],
            recordFlag: false,
        };
    }

    function normalizeMonsterTriples(monsters) {
        if (!Array.isArray(monsters)) {
            return [];
        }
        return monsters.map((item, index) => {
            if (Array.isArray(item)) {
                return {
                    monsterId: Number(item[0] || 0),
                    index: Number(item[1] != null ? item[1] : 10 + index),
                    level: Number(item[2] || 0),
                    template: null,
                };
            }
            if (item && typeof item === 'object') {
                return {
                    monsterId: Number(item.monsterId != null ? item.monsterId : item.id != null ? item.id : item.cfgId || 0),
                    index: Number(item.index != null ? item.index : item.pos != null ? item.pos : 10 + index),
                    level: Number(item.level != null ? item.level : item.monsterLv != null ? item.monsterLv : 0),
                    template: item,
                };
            }
            return null;
        }).filter((item) => item && item.monsterId > 0);
    }

    function buildEnemyTeamFromMonsters(templateTeam, monsters) {
        const templateEntries = normalizeTeamEntries(templateTeam);
        const templateEntryByPos = new Map();
        let fallbackTemplateEntry = null;
        templateEntries.forEach(({ pos, entry }) => {
            if (!entry || typeof entry !== 'object') {
                return;
            }
            if (!fallbackTemplateEntry) {
                fallbackTemplateEntry = entry;
            }
            templateEntryByPos.set(Number(pos), entry);
        });
        const entries = normalizeMonsterTriples(monsters).map((item) => ({
            pos: Number(item.index),
            entry: (() => {
                const matchedTemplateEntry = templateEntryByPos.get(Number(item.index)) || fallbackTemplateEntry;
                const emptyEntry = buildEmptyEnemyEntry(item.monsterId, item.index, item.level);
                const entry = Object.assign(
                    matchedTemplateEntry && typeof matchedTemplateEntry === 'object' ? Utils.deepClone(matchedTemplateEntry) : {},
                    item.template && typeof item.template === 'object' ? Utils.deepClone(item.template) : {},
                    emptyEntry,
                    {
                        id: Number(item.monsterId || 0),
                        type: 1,
                        index: Number(item.index || 0),
                        level: Number(item.level || 0),
                    },
                );
                entry.skinName = ensureStringValue(entry.skinName);
                entry.attribute = ensureMapValue(entry.attribute);
                entry.enchantMap = ensureMapValue(entry.enchantMap);
                entry.skill = ensureArrayValue(entry.skill);
                delete entry.monsterId;
                delete entry.template;
                delete entry.monsterLv;
                delete entry.cfgId;
                delete entry.heroId;
                delete entry.pos;
                return entry;
            })(),
        }));
        return rebuildTeamLike(templateTeam, entries);
    }

    function createBattleDataFromPreview(baseSkeleton, modeKey, context, candidate, seed, enemyMonsters, extra = {}) {
        if (!baseSkeleton || !baseSkeleton.leftTeam) {
            throw new Error('当前没有可复用的战斗骨架，请先进入主线页面再试');
        }
        const battleModeValue = Runtime.getBattleModeValue(modeKey);
        if (battleModeValue == null) {
            throw new Error(`未找到玩法 ${modeKey} 的 battle mode`);
        }
        const battleData = Utils.deepClone(baseSkeleton);
        battleData.mode = battleModeValue;
        battleData.id = Date.now() + seed;
        battleData.randomSeed = seed;
        resetBattleRuntimeState(battleData);
        battleData.leftTeams = [];
        battleData.rightTeams = [];
        battleData.rightTeam = battleData.rightTeam || {};
        battleData.rightTeam.roleId = 0;
        battleData.rightTeam.team = buildEnemyTeamFromMonsters(
            battleData.rightTeam.team || new Map(),
            enemyMonsters,
        );
        battleData.options = Utils.deepClone(battleData.options || {});
        Object.keys(extra.options || {}).forEach((key) => {
            setBattleOptionByName(battleData.options, key, extra.options[key]);
        });
        applyCandidateToBattleData(battleData, candidate);
        finalizeBattleDataForSimulation(battleData);
        Utils.pushDataSource(`预构造 ${MODE_LABELS[modeKey] || modeKey} battleData`);
        return battleData;
    }

    function getTowerPreviewMonsters(stageId, fallbackMonsters = null) {
        const conf = getConfigById(getFirstConfigTable('TowerConf'), stageId);
        const monsters = conf && conf.monsters ? conf.monsters : fallbackMonsters;
        return normalizeMonsterTriples(monsters);
    }

    function getEvoTowerPreviewMonsters(towerId, fallbackMonsters = null) {
        const conf = getConfigById(getFirstConfigTable('EvoTowerConf', 'CardTowerConf', 'ActCardTowerConf'), towerId);
        const monsters = conf && (conf.monsters || conf.monster || conf.enemyMonsters)
            ? (conf.monsters || conf.monster || conf.enemyMonsters)
            : fallbackMonsters;
        return normalizeMonsterTriples(monsters);
    }

    function getGeniePreviewInfo(context, fallbackMonsters = null) {
        const genieLevelId = Number(
            context && (context.genieLevelId != null ? context.genieLevelId : context.genieId != null ? context.genieId : 0),
        );
        const conf = getConfigById(getFirstConfigTable('GenieLevelConf'), genieLevelId);
        const monsters = conf && (conf.monsters || conf.monster || conf.enemyMonsters || conf.fightTeam)
            ? (conf.monsters || conf.monster || conf.enemyMonsters || conf.fightTeam)
            : fallbackMonsters;
        return {
            genieLevelId,
            conf,
            monsters: normalizeMonsterTriples(monsters),
        };
    }

    function resolveGenieBattleMapId(context) {
        const genieModule = Runtime.getModuleByTypeKey('GENIE');
        if (!genieModule || typeof genieModule.getMapId !== 'function') {
            return null;
        }
        const clubCandidates = [
            context && context.clubId != null ? Number(context.clubId) : null,
            context && context.genieLevelId != null ? Math.floor(Number(context.genieLevelId) / 1000) : null,
            context && context.genieId != null ? Math.floor(Number(context.genieId) / 1000) : null,
        ].filter((value) => Number.isFinite(value) && value >= 0);
        for (let i = 0; i < clubCandidates.length; i += 1) {
            const mapId = Utils.safeCall(() => genieModule.getMapId(clubCandidates[i]), null);
            if (mapId != null) {
                return mapId;
            }
        }
        return Utils.safeCall(() => genieModule.getMapId(1), null);
    }

    function canUsePreviewSkeleton() {
        const skeleton = Utils.safeCall(() => Runtime.getReusableBattleSkeleton(false), null);
        return !!(skeleton && skeleton.leftTeam && skeleton.leftTeam.team);
    }

    function cloneSeedRecordStars(stars) {
        if (!stars) {
            return null;
        }
        return {
            oneStar: !!stars.oneStar,
            twoStar: !!stars.twoStar,
            threeStar: !!stars.threeStar,
        };
    }

    function buildSeedRecordEntry(seed, stats, index) {
        return {
            index: Number(index || 0),
            seed: Number(seed || 0),
            isWin: !!(stats && stats.isWin),
            roundCount: Number(stats && stats.roundCount ? stats.roundCount : 0),
            aliveCount: Number(stats && stats.aliveCount ? stats.aliveCount : 0),
            remainHpRate: Number(stats && stats.remainHpRate ? stats.remainHpRate : 0),
            enemyRemainHp: Number(stats && stats.enemyRemainHp ? stats.enemyRemainHp : 0),
            stars: cloneSeedRecordStars(stats && stats.stars),
        };
    }

    function resolvePreviewEnemyMonstersForMode(modeKey, context) {
        switch (modeKey) {
            case 'tower':
                return getTowerPreviewMonsters(context && context.stageId, context && context.monster);
            case 'genie':
                return getGeniePreviewInfo(context || {}, context && context.monster).monsters;
            case 'evoTower':
                return getEvoTowerPreviewMonsters(context && context.towerId, context && context.monster);
            case 'legionBoss':
                return getLegionBossPreviewInfo(context || {}, context && context.monster).monsters;
            case 'nightmareStar':
                return getNightmareStarPreviewInfo(context || {}, context && context.monster).monsters;
            case 'nightmare':
                return getNightmarePreviewInfo(context || {}, context && context.monster).monsters;
            default:
                return [];
        }
    }

    function buildPreviewExtraForMode(modeKey, context) {
        const options = {};
        if (modeKey === 'tower' && context && context.stageId != null) {
            options.towerId = Number(context.stageId);
        } else if (modeKey === 'genie') {
            const previewInfo = getGeniePreviewInfo(context || {}, context && context.monster);
            const genieLevelId = Number(previewInfo.genieLevelId || context && (context.genieLevelId || context.genieId) || 0);
            if (genieLevelId > 0) {
                options.genieLevelId = genieLevelId;
            }
        } else if (modeKey === 'evoTower' && context && context.towerId != null) {
            options.towerId = Number(context.towerId);
        } else if (modeKey === 'legionBoss') {
            const previewInfo = getLegionBossPreviewInfo(context || {}, context && context.monster);
            const legionBossId = Number(previewInfo.legionBossId || context && context.legionBossId || 0);
            const legionBossShow = Number(previewInfo.legionBossShow || context && context.legionBossShow || 0);
            if (legionBossId > 0) {
                options.legionBossId = legionBossId;
            }
            if (legionBossShow > 0) {
                options.legionBossShow = legionBossShow;
            }
        }
        return Object.keys(options).length ? { options } : {};
    }

    function buildReplayInputFromReplayBundle(bundle, battleData, result, candidate) {
        if (!bundle) {
            return buildLooseReplayInput(battleData, result, '', null);
        }
        const modeKey = bundle.mode || '';
        const context = bundle.context || {};
        const preferredInput = bundle.preferredInput || null;
        switch (modeKey) {
            case 'tower': {
                const towerModule = Runtime.getModuleByTypeKey('TOWER');
                if (towerModule && typeof towerModule.createBattleInputData === 'function') {
                    return Utils.safeCall(
                        () => towerModule.createBattleInputData(battleData, result, context.towerEnerge || 0),
                        buildLooseReplayInput(battleData, result, modeKey, preferredInput),
                    );
                }
                return buildLooseReplayInput(battleData, result, modeKey, preferredInput);
            }
            case 'genie': {
                const genieModule = Runtime.getModuleByTypeKey('GENIE');
                if (genieModule && typeof genieModule.createBattleInputData === 'function') {
                    const mapId = resolveGenieBattleMapId(context);
                    if (mapId != null) {
                        genieModule.mapId = mapId;
                    }
                    return Utils.safeCall(
                        () => genieModule.createBattleInputData(battleData, result),
                        buildLooseReplayInput(battleData, result, modeKey, preferredInput),
                    );
                }
                return buildLooseReplayInput(battleData, result, modeKey, preferredInput);
            }
            case 'evoTower': {
                const evoModule = Runtime.getModuleByTypeKey('EVOTOWER');
                if (evoModule && typeof evoModule.createBattleInputData === 'function') {
                    return Utils.safeCall(
                        () => evoModule.createBattleInputData(battleData, result, context.energy || 0),
                        buildLooseReplayInput(battleData, result, modeKey, preferredInput),
                    );
                }
                return buildLooseReplayInput(battleData, result, modeKey, preferredInput);
            }
            case 'legionBoss': {
                const legionModule = Runtime.getModuleByTypeKey('LEGION');
                if (legionModule && typeof legionModule.createBattleInputData === 'function') {
                    return Utils.safeCall(
                        () => legionModule.createBattleInputData(battleData, result),
                        buildLooseReplayInput(battleData, result, modeKey, preferredInput),
                    );
                }
                return buildLooseReplayInput(battleData, result, modeKey, preferredInput);
            }
            case 'nightmareStar':
                return buildNightmareStarReplayInput(context, battleData, result, candidate, preferredInput);
            case 'nightmare':
                return buildNightmareReplayInput(context, battleData, result, preferredInput);
            default:
                return buildLooseReplayInput(battleData, result, modeKey, preferredInput);
        }
    }

    function captureReplayBundleFromDraft(draft, candidate) {
        if (!draft || !candidate) {
            return null;
        }
        const modeKey = draft.mode || '';
        const context = Utils.deepClone(draft.context || {});
        const preferredInput = Utils.deepClone(
            getReplayTemplateInput(
                modeKey,
                draft.cache && draft.cache.inputData ? draft.cache.inputData : null,
            ),
        );
        const isPreviewDraft = Array.isArray(draft.notes) && draft.notes.includes('preview');
        if (isPreviewDraft) {
            const skeletonBattleData = Utils.safeCall(() => Runtime.getReusableBattleSkeleton(true), null);
            const enemyMonsters = resolvePreviewEnemyMonstersForMode(modeKey, context);
            if (!skeletonBattleData || !enemyMonsters.length) {
                return null;
            }
            return {
                source: 'preview',
                mode: modeKey,
                capability: draft.capability,
                context,
                candidate: Utils.deepClone(candidate),
                preferredInput,
                skeletonBattleData,
                enemyMonsters: Utils.deepClone(enemyMonsters),
                previewExtra: Utils.deepClone(buildPreviewExtraForMode(modeKey, context)),
            };
        }
        const authorityBattleData = Utils.deepClone(draft.cache && draft.cache.battleData ? draft.cache.battleData : null);
        if (!authorityBattleData) {
            return null;
        }
        return {
            source: 'authority',
            mode: modeKey,
            capability: draft.capability,
            context,
            candidate: Utils.deepClone(candidate),
            preferredInput,
            authorityBattleData,
        };
    }

    function buildRecordedReplayDraft(report) {
        const replayBundle = report && report.replayBundle ? report.replayBundle : null;
        const candidate = replayBundle && replayBundle.candidate
            ? Utils.deepClone(replayBundle.candidate)
            : Utils.deepClone(report && report.candidate ? report.candidate : null);
        if (!replayBundle || !candidate) {
            throw new Error('当前批量模拟没有可回放的种子记录');
        }
        return {
            mode: replayBundle.mode,
            label: MODE_LABELS[replayBundle.mode] || replayBundle.mode || '记录回放',
            context: Utils.deepClone(replayBundle.context || {}),
            capability: replayBundle.capability || report.capability || CAPABILITY.NONE,
            notes: ['recordedReplay'],
            buildBattleData(innerCandidate, seed) {
                const finalCandidate = innerCandidate || candidate;
                if (replayBundle.source === 'preview') {
                    const battleData = createBattleDataFromPreview(
                        replayBundle.skeletonBattleData,
                        replayBundle.mode,
                        replayBundle.context || {},
                        finalCandidate,
                        seed,
                        replayBundle.enemyMonsters || [],
                        replayBundle.previewExtra || {},
                    );
                    if (replayBundle.mode === 'legionBoss') {
                        applyEnemyCurrentHpOverride(battleData, Utils.safeCall(() => replayBundle.context.currentHp, 0));
                    }
                    return battleData;
                }
                const battleData = Utils.deepClone(replayBundle.authorityBattleData || {});
                battleData.id = Date.now() + seed;
                battleData.randomSeed = seed;
                applyCandidateToBattleData(battleData, finalCandidate);
                resetBattleRuntimeState(battleData);
                return battleData;
            },
            buildReplayInput(result, battleData, innerCandidate) {
                return buildReplayInputFromReplayBundle(
                    replayBundle,
                    battleData,
                    result,
                    innerCandidate || candidate,
                );
            },
        };
    }

    async function replayRecordedSeed(report, seedRecord) {
        if (!report || !seedRecord) {
            throw new Error('没有可回放的种子记录');
        }
        return withJob(`回放 seed ${seedRecord.seed}`, async () => {
            const draft = buildRecordedReplayDraft(report);
            const candidate = draft && report && report.candidate ? report.candidate : null;
            const singleRun = await runSingleSeed(draft, candidate, seedRecord.seed, {
                includeReplay: true,
                replaySource: 'recordedSeedReplay',
            });
            const prevSingleRun = state.lastSingleRun;
            const prevDebugError = state.lastDebugError;
            state.lastSingleRun = Object.assign({}, singleRun, {
                mode: draft.mode,
                label: `${draft.label} 种子回放`,
                adapterKey: report.adapterKey,
                capability: draft.capability,
                context: Utils.deepClone(report.context || draft.context || {}),
                candidate: Utils.deepClone(candidate),
                seed: seedRecord.seed,
                capturedAt: Utils.now(),
            });
            state.lastDebugError = null;
            await replayLatest();
            state.lastSingleRun = prevSingleRun;
            state.lastDebugError = prevDebugError;
            return singleRun;
        });
    }

    function safeBuildReplayInput(draft, result, battleData, candidate, meta = {}) {
        try {
            const replayInput = sanitizeReplayInputForMode(
                draft.buildReplayInput(result, battleData, candidate),
                draft && draft.mode ? draft.mode : meta.modeKey || '',
            );
            return markPlaybackInputInternal(
                replayInput,
                `safeBuildReplayInput:${meta.modeKey || draft.mode || 'capture'}`,
                {
                    modeKey: meta.modeKey || draft.mode || '',
                    context: Utils.deepClone(meta.context || draft.context || {}),
                },
            );
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            recordDiagnosticSample('replayBuildError', {
                modeKey: meta.modeKey || draft.mode,
                source: meta.source || 'safeBuildReplayInput',
                context: draft.context,
                battleData,
                battleResult: result,
                extra: {
                    seed: meta.seed,
                    candidateSignature: candidate && candidate.signature ? candidate.signature : '',
                    errorMessage: message,
                    errorStack: error && error.stack ? String(error.stack) : '',
                },
            });
            return buildLooseReplayInput(battleData, result, draft.mode);
        }
    }

    async function runSingleSeed(draft, candidate, seed, options = {}) {
        const battleData = draft.buildBattleData(candidate, seed);
        resetBattleRuntimeState(battleData);
        finalizeBattleDataForSimulation(battleData);
        const warnings = collectBattleDataWarnings(battleData);
        try {
            const simConfig = Runtime.getDefaultSimConfig(battleData);
            const result = await Runtime.simulateBattle(battleData, simConfig.extend, simConfig.timeScale);
            const stats = extractResultStats(draft, battleData, result);
            const replayInput = options.includeReplay
                ? safeBuildReplayInput(draft, result, battleData, candidate, {
                    modeKey: draft.mode,
                    source: options.replaySource || 'runSingleSeed',
                    seed,
                })
                : null;
            return { battleData, result, replayInput, stats, warnings };
        } catch (error) {
            recordDiagnosticSample('simulationError', {
                modeKey: draft.mode,
                source: options.replaySource || 'runSingleSeed',
                context: draft.context,
                battleData,
                extra: {
                    seed,
                    candidateSignature: candidate && candidate.signature ? candidate.signature : '',
                    errorMessage: error && error.message ? error.message : String(error),
                    errorStack: error && error.stack ? String(error.stack) : '',
                    warnings,
                },
            });
            throw error;
        }
    }

    async function evaluateCandidate(adapter, draft, candidate, seeds, progressLabel) {
        const aggregate = initEmptyAggregate(seeds.length);
        const replayBundle = captureReplayBundleFromDraft(draft, candidate);
        for (let i = 0; i < seeds.length; i += 1) {
            if (state.stopRequested) {
                break;
            }
            const seed = seeds[i];
            const single = await runSingleSeed(draft, candidate, seed, {
                includeReplay: !aggregate.replayInput,
                replaySource: 'evaluateCandidate',
            });
            aggregate.finishedCount += 1;
            aggregate.roundSum += single.stats.roundCount;
            aggregate.aliveSum += single.stats.aliveCount;
            aggregate.remainHpRateSum += single.stats.remainHpRate;
            aggregate.seedRecords.push(buildSeedRecordEntry(seed, single.stats, i));
            if (!aggregate.replayInput && single.replayInput) {
                aggregate.replayInput = single.replayInput;
            }
            if (single.stats.isWin) {
                aggregate.winCount += 1;
                if (aggregate.firstWinSeed == null) {
                    aggregate.firstWinSeed = seed;
                }
            }
            if (single.stats.stars) {
                aggregate.star1Count += single.stats.stars.oneStar ? 1 : 0;
                aggregate.star2Count += single.stats.stars.twoStar ? 1 : 0;
                aggregate.star3Count += single.stats.stars.threeStar ? 1 : 0;
            }
            if (state.panel && (i === 0 || (i + 1) % 5 === 0 || i === seeds.length - 1)) {
                renderLastReport({
                    title: `${progressLabel} ${formatSignatureShort(candidate.signature)}`,
                    text: `进度 ${i + 1}/${seeds.length}，当前胜率 ${Utils.formatPercent(aggregate.winCount / aggregate.finishedCount)}`,
                });
                await Utils.sleep(8);
            }
        }
        const finished = Math.max(aggregate.finishedCount, 1);
        return {
            reportId: `${adapter.key}:${candidate.id || candidate.signature || 'candidate'}:${Utils.now()}`,
            candidateId: candidate.id,
            signature: candidate.signature,
            candidate,
            totalCount: aggregate.finishedCount,
            winCount: aggregate.winCount,
            winRate: aggregate.winCount / finished,
            firstWinSeed: aggregate.firstWinSeed,
            avgRounds: aggregate.roundSum / finished,
            avgRemainingUnits: aggregate.aliveSum / finished,
            avgRemainingHpRate: aggregate.remainHpRateSum / finished,
            replayInput: aggregate.replayInput,
            starRates: {
                one: aggregate.star1Count / finished,
                two: aggregate.star2Count / finished,
                three: aggregate.star3Count / finished,
            },
            adapterKey: adapter.key,
            capability: draft.capability,
            context: draft.context,
            replayBundle,
            seedRecords: aggregate.seedRecords,
        };
    }

    function buildSingleRunSummary(singleRun) {
        if (!singleRun) {
            return '暂无单次调试结果';
        }
        const lines = [];
        lines.push(`seed ${singleRun.seed}`);
        lines.push(`结果 ${singleRun.stats && singleRun.stats.isWin ? '胜利' : '失败'}`);
        lines.push(`回合 ${singleRun.stats ? singleRun.stats.roundCount : 0}`);
        lines.push(`能力 ${singleRun.capability || '-'}`);
        lines.push(`可回放 ${singleRun.replayInput ? '是' : '否'}`);
        if (singleRun.warnings && singleRun.warnings.length) {
            lines.push(`预检 ${singleRun.warnings.length} 项`);
        }
        if (singleRun.errorMessage) {
            lines.push(`异常 ${singleRun.errorMessage}`);
        }
        return lines.join('\n');
    }

    function buildSingleRunSummarySafe(singleRun) {
        if (!singleRun) {
            return '暂无单次调试结果';
        }
        const lines = [];
        lines.push(`seed ${singleRun.seed}`);
        lines.push(`结果 ${singleRun.stats && singleRun.stats.isWin ? '胜利' : '失败'}`);
        lines.push(`回合 ${singleRun.stats ? singleRun.stats.roundCount : 0}`);
        lines.push(`能力 ${singleRun.capability || '-'}`);
        lines.push(`可回放 ${singleRun.replayInput ? '是' : '否'}`);
        if (singleRun.warnings && singleRun.warnings.length) {
            lines.push(`预检 ${singleRun.warnings.length} 项`);
        }
        if (singleRun.errorMessage) {
            lines.push(`异常 ${singleRun.errorMessage}`);
        }
        return lines.join('\n');
    }

    async function debugCurrentTeamOnce() {
        return withJob('单次调试模拟', async () => {
            const adapter = getActiveAdapter();
            if (!adapter) {
                throw new Error('未识别到当前可模拟的非PVP玩法');
            }
            const context = Utils.safeCall(() => adapter.getContext(), null);
            const candidate = state.activeSwitchedCandidate || captureCurrentTeamSnapshot(context);
            await adapter.ensureAuthorityData();
            const draft = adapter.buildDraft(candidate);
            const seed = buildDebugSeed(draft, candidate);
            let battleData = null;
            try {
                battleData = draft.buildBattleData(candidate, seed);
                resetBattleRuntimeState(battleData);
                finalizeBattleDataForSimulation(battleData);
                const warnings = collectBattleDataWarnings(battleData);
                recordDiagnosticSample('previewBattleData', {
                    modeKey: adapter.key,
                    source: 'debugOnce.buildBattleData',
                    context: draft.context,
                    battleData,
                    extra: {
                        seed,
                        capability: draft.capability,
                        candidateSignature: candidate.signature,
                        warnings,
                    },
                });
                const simConfig = Runtime.getDefaultSimConfig(battleData);
                const result = await Runtime.simulateBattle(battleData, simConfig.extend, simConfig.timeScale);
                const replayInput = safeBuildReplayInput(draft, result, battleData, candidate, {
                    modeKey: adapter.key,
                    source: 'debugOnce',
                    seed,
                });
                const stats = extractResultStats(draft, battleData, result);
                const singleRun = {
                    mode: draft.mode,
                    label: draft.label,
                    adapterKey: adapter.key,
                    capability: draft.capability,
                    context: draft.context,
                    candidate,
                    seed,
                    battleData,
                    result,
                    replayInput,
                    stats,
                    warnings,
                    capturedAt: Utils.now(),
                };
                state.lastSingleRun = singleRun;
                state.lastDebugError = null;
                recordDiagnosticSample('singleSimulation', {
                    modeKey: adapter.key,
                    source: 'debugOnce',
                    context: draft.context,
                    battleData,
                    battleResult: result,
                    extra: {
                        seed,
                        capability: draft.capability,
                        candidateSignature: candidate.signature,
                        warnings,
                    },
                });
                renderLastReport({
                    title: `${draft.label} 单次调试`,
                    text: buildSingleRunSummarySafe(singleRun),
                });
                renderPanel();
                return singleRun;
            } catch (error) {
                const message = error && error.message ? error.message : String(error);
                state.lastSingleRun = null;
                state.lastDebugError = {
                    mode: draft.mode,
                    label: draft.label,
                    adapterKey: adapter.key,
                    context: draft.context,
                    seed,
                    candidateSignature: candidate.signature,
                    errorMessage: message,
                    errorStack: error && error.stack ? String(error.stack) : '',
                    capturedAt: Utils.now(),
                };
                if (battleData) {
                    recordDiagnosticSample('simulationError', {
                        modeKey: adapter.key,
                        source: 'debugOnce.error',
                        context: draft.context,
                        battleData,
                        extra: {
                            seed,
                            capability: draft.capability,
                            candidateSignature: candidate.signature,
                            errorMessage: message,
                            errorStack: error && error.stack ? String(error.stack) : '',
                            warnings: collectBattleDataWarnings(battleData),
                        },
                    });
                }
                renderLastReport({
                    title: `${draft.label} 单次调试失败`,
                    text: `seed ${seed}\n${message}`,
                });
                renderPanel();
                throw error;
            }
        });
    }

    function compareReports(left, right) {
        if (right.winRate !== left.winRate) {
            return right.winRate - left.winRate;
        }
        if (right.starRates.three !== left.starRates.three) {
            return right.starRates.three - left.starRates.three;
        }
        if (right.starRates.two !== left.starRates.two) {
            return right.starRates.two - left.starRates.two;
        }
        if (right.starRates.one !== left.starRates.one) {
            return right.starRates.one - left.starRates.one;
        }
        if (right.avgRemainingUnits !== left.avgRemainingUnits) {
            return right.avgRemainingUnits - left.avgRemainingUnits;
        }
        if (left.avgRounds !== right.avgRounds) {
            return left.avgRounds - right.avgRounds;
        }
        if (right.avgRemainingHpRate !== left.avgRemainingHpRate) {
            return right.avgRemainingHpRate - left.avgRemainingHpRate;
        }
        return 0;
    }

    var TOY_IMAGE_MAP = {
        "1": "https://xxz-xyzw-res.hortorgames.com/remote/icons/native/5c/5c4652b9-7e51-4733-879a-1ad89a60a19e.6a8ea.png",
        "2": "https://xxz-xyzw-res.hortorgames.com/remote/icons/native/0f/0f0f103c-bce6-4951-8293-789d07b91ea1.925a2.png",
        "3": "https://xxz-xyzw-res.hortorgames.com/remote/icons/native/1f/1fdc6fac-cac3-4934-93f2-8c3e6b3b958e.0539f.png",
        "4": "https://xxz-xyzw-res.hortorgames.com/remote/icons/native/9d/9d0875ac-41b2-4de1-9cb7-e207a3a977b7.458d0.png",
        "5": "https://xxz-xyzw-res.hortorgames.com/remote/icons/native/01/01e407e7-8a48-45e3-a58a-914bbb58af99.28cea.png",
        "6": "https://xxz-xyzw-res.hortorgames.com/remote/icons/native/c6/c64f985d-936f-4995-a2b8-29f379bbca77.d2c73.png",
        "7": "https://xxz-xyzw-res.hortorgames.com/remote/icons/native/59/59966b57-2cd4-4e6d-bb50-3eedcb52e4ea.44cd2.png",
        "8": "https://xxz-xyzw-res.hortorgames.com/remote/icons/native/88/88679199-6ae6-425b-8c30-5698461d2b10.478b8.png",
        "9": "https://xxz-xyzw-res.hortorgames.com/remote/icons/native/a5/a59734bc-12d2-4959-a2ce-12c3a3c1be88.469fc.png"
    };

    function formatCandidateSummary(candidate, toyId) {
        const items = candidate.battleTeam || [];
        if (!items.length) return '<span style="color:#a0aec0;font-size:10px;">暂无阵容信息</span>';
        const skinMap = new Map();
        try {
            const entries = Utils.fromSerializable(candidate.teamEntries || []);
            if (entries && entries.length) {
                entries.forEach(({ pos, entry }) => {
                    const skin = entry && entry.skin;
                    if (skin && skin > 0) {
                        skinMap.set(Number(pos), skin);
                    }
                });
            }
        } catch (e) {}
        const wid = toyId != null ? toyId : (candidate.lordWeaponId || 0);
        const toyUrl = wid ? TOY_IMAGE_MAP[String(wid)] : null;
        const toyHtml = toyUrl ? `<img class="sim-toy-icon-img" src="${toyUrl}" onerror="this.style.display='none'">` : '';
        const heroHtml = items.map((item) => {
            const displayId = skinMap.get(Number(item.pos)) || item.heroId;
            return `<img class="sim-hero-icon-img" data-hero-id="${displayId}" src="" onerror="if(this.src.endsWith('.png'))this.src=this.src.replace('.png','.pvr');else if(this.src.endsWith('.pvr'))this.src=this.src.replace('.pvr','.png');">`;
        }).join('');
        return toyHtml + heroHtml;
    }

    function loadHeroIconUrl(heroId) {
        if (!heroId) return Promise.resolve('');
        try {
            const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
            if (!Configs || !Configs.AvatarConf) return Promise.resolve('');
            const avatarConf = Utils.safeCall(() => Configs.AvatarConf.getById(heroId), null);
            const iconPath = avatarConf && avatarConf.smallHeadIcon;
            if (!iconPath) return Promise.resolve('');
            const iconsBundle = window.cc && window.cc.assetManager && window.cc.assetManager.bundles.get('icons');
            if (!iconsBundle) return Promise.resolve('');
            return new Promise((resolve) => {
                iconsBundle.load(iconPath, window.cc.Texture2D, (err, texture) => {
                    if (err || !texture) { resolve(''); return; }
                    let url = texture.nativeUrl || texture.url || texture._nativeUrl || '';
                    if (url.startsWith('assets/')) {
                        url = 'https://xxz-xyzw-res.hortorgames.com/remote/' + url.substring(7);
                    }
                    resolve(url);
                });
            });
        } catch (e) { return Promise.resolve(''); }
    }

    function formatSignatureShort(signature) {
        if (!signature) return '未知阵容';
        const colonIdx = signature.indexOf(':');
        return colonIdx > 0 ? '#' + signature.substring(0, colonIdx) : '#' + signature.substring(0, 8);
    }

    function buildReportSummary(report) {
        const base = `${formatSignatureShort(report.signature)} 胜率 ${Utils.formatPercent(report.winRate)} 次数 ${report.totalCount}`;
        const seedText = report.firstWinSeed != null ? `\n首胜Seed ${report.firstWinSeed}` : '';
        if (report.starRates && report.starRates.one > 0) {
            return `${base}\n1星 ${Utils.formatPercent(report.starRates.one)} 2星 ${Utils.formatPercent(report.starRates.two)} 3星 ${Utils.formatPercent(report.starRates.three)}${seedText}`;
        }
        return `${base}\n平均回合 ${Utils.formatNumber(report.avgRounds)} 平均剩余 ${Utils.formatNumber(report.avgRemainingUnits)}${seedText}`;
    }

    function getSeedRecordSourceReport() {
        if (state.lastReport && Array.isArray(state.lastReport.seedRecords) && state.lastReport.seedRecords.length) {
            return state.lastReport;
        }
        return null;
    }

    function getFilteredSeedRecords(report) {
        if (!report || !Array.isArray(report.seedRecords)) {
            return [];
        }
        const sortBy = (state.seedRecordView && state.seedRecordView.sortBy) || 'default';
        const list = report.seedRecords;
        let items = [];
        for (let i = 0; i < list.length; i += 1) {
            const record = list[i];
            if (!record) continue;
            items.push({ record, rawIndex: i });
        }
        if (sortBy === 'roundAsc') {
            items.sort((a, b) => {
                const rA = Number(a.record.roundCount || 0);
                const rB = Number(b.record.roundCount || 0);
                if (rA !== rB) return rA - rB;
                return a.rawIndex - b.rawIndex;
            });
        } else if (sortBy === 'roundDesc') {
            items.sort((a, b) => {
                const rA = Number(a.record.roundCount || 0);
                const rB = Number(b.record.roundCount || 0);
                if (rA !== rB) return rB - rA;
                return a.rawIndex - b.rawIndex;
            });
        } else if (sortBy === 'winDesc') {
            items.sort((a, b) => {
                const winA = a.record.isWin ? 1 : 0;
                const winB = b.record.isWin ? 1 : 0;
                if (winA !== winB) return winB - winA;
                const starA = a.record.stars ? Number(a.record.stars.stars || 0) : 0;
                const starB = b.record.stars ? Number(b.record.stars.stars || 0) : 0;
                if (starA !== starB) return starB - starA;
                const rA = Number(a.record.roundCount || 0);
                const rB = Number(b.record.roundCount || 0);
                if (rA !== rB) return rA - rB;
                return a.rawIndex - b.rawIndex;
            });
        } else if (sortBy === 'winAsc') {
            items.sort((a, b) => {
                const winA = a.record.isWin ? 1 : 0;
                const winB = b.record.isWin ? 1 : 0;
                if (winA !== winB) return winA - winB;
                const rA = Number(a.record.roundCount || 0);
                const rB = Number(b.record.roundCount || 0);
                if (rA !== rB) return rA - rB;
                return a.rawIndex - b.rawIndex;
            });
        }
        return items;
    }

    function ensureSeedRecordViewState(report) {
        const sourceId = report && report.reportId ? String(report.reportId) : '';
        if (state.seedRecordView.sourceId !== sourceId) {
            resetSeedRecordView(report);
        }
        const filteredRecords = getFilteredSeedRecords(report);
        if (!filteredRecords.length) {
            state.seedRecordView.page = 0;
            state.seedRecordView.selectedIndex = 0;
            return;
        }
        const maxIndex = filteredRecords.length - 1;
        if (!Number.isFinite(Number(state.seedRecordView.selectedIndex)) || state.seedRecordView.selectedIndex < 0) {
            state.seedRecordView.selectedIndex = 0;
        } else if (state.seedRecordView.selectedIndex > maxIndex) {
            state.seedRecordView.selectedIndex = maxIndex;
        }
        const maxPage = Math.max(0, Math.ceil(filteredRecords.length / SEED_RECORD_PAGE_SIZE) - 1);
        if (!Number.isFinite(Number(state.seedRecordView.page)) || state.seedRecordView.page < 0) {
            state.seedRecordView.page = 0;
        } else if (state.seedRecordView.page > maxPage) {
            state.seedRecordView.page = maxPage;
        }
        const targetPage = Math.floor(state.seedRecordView.selectedIndex / SEED_RECORD_PAGE_SIZE);
        if (targetPage !== state.seedRecordView.page) {
            state.seedRecordView.page = targetPage;
        }
    }

    function buildSeedRecordSummary(record) {
        if (!record) {
            return '';
        }
        const parts = [
            `回合 ${record.roundCount || 0}`,
            `存活 ${record.aliveCount || 0}`,
            `残血 ${Utils.formatPercent(Number(record.remainHpRate || 0))}`,
        ];
        if (record.stars) {
            const starCount = Number(record.stars.stars != null ? record.stars.stars : [record.stars.oneStar, record.stars.twoStar, record.stars.threeStar].filter(Boolean).length);
            const starIcons = '★'.repeat(Math.min(3, Math.max(0, starCount))) + '☆'.repeat(Math.max(0, 3 - starCount));
            parts.push(`${starIcons} (${starCount}星)`);
        }
        return parts.join(' | ');
    }

    function renderSeedRecords() {
        if (!state.panel) {
            return;
        }
        const refs = state.panel.refs;
        if (!refs.seedSection || !refs.seedList || !refs.seedSummary || !refs.seedPager) {
            return;
        }
        const report = getSeedRecordSourceReport();
        if (!report) {
            refs.seedSection.style.display = 'none';
            refs.seedSummary.textContent = '暂无批量种子记录';
            refs.seedPager.textContent = '0 / 0';
            refs.seedList.innerHTML = '';
            return;
        }
        if (refs.seedSortSelect) {
            refs.seedSortSelect.value = state.seedRecordView.sortBy || 'default';
        }
        ensureSeedRecordViewState(report);
        const allRecords = report.seedRecords || [];
        const filteredRecords = getFilteredSeedRecords(report);
        const winCount = Number(report.winCount || 0);
        const loseCount = Math.max(0, allRecords.length - winCount);
        const page = Number(state.seedRecordView.page || 0);
        const start = page * SEED_RECORD_PAGE_SIZE;
        const pageRecords = filteredRecords.slice(start, start + SEED_RECORD_PAGE_SIZE);
        const totalPage = Math.max(1, Math.ceil(filteredRecords.length / SEED_RECORD_PAGE_SIZE));
        refs.seedSection.style.display = 'block';
        refs.seedSummary.textContent = `共 ${allRecords.length} 场 | 胜 ${winCount} | 负 ${loseCount}`;
        refs.seedPager.textContent = filteredRecords.length ? `${page + 1} / ${totalPage}` : '0 / 0';
        if (!pageRecords.length) {
            refs.seedList.innerHTML = `<div class="sim-seed-empty" style="text-align:center; padding:12px 0; color:var(--xc-text-muted); font-size:11px;">暂无种子记录</div>`;
            return;
        }
        refs.seedList.innerHTML = pageRecords.map((item, offset) => {
            const { record, rawIndex } = item;
            const absoluteIndex = rawIndex;
            const resultClass = record.isWin ? ' is-win' : ' is-lose';
            const resultText = record.isWin ? '胜' : '败';
            return `<div class="xc-seed-item${resultClass}" data-seed-record-index="${absoluteIndex}"><div class="xc-seed-body"><div class="xc-seed-head"><span><span class="xc-seed-num">#${absoluteIndex + 1}</span> <span class="xc-seed-id">seed ${record.seed}</span></span><span class="xc-seed-tag${resultClass}">${resultText}</span></div><div class="xc-seed-detail">${buildSeedRecordSummary(record)}</div></div><button type="button" class="xc-seed-replay" data-replay-seed-index="${absoluteIndex}">回放</button></div>`;
        }).join('');
    }

    function buildReportBodyHTML(title, reports) {
        const items = reports.map((report, index) => {
            const prefix = reports.length > 1 ? `<span style="font-weight:600;color:#718096;">${index + 1}.</span> ` : '';
            const heroImgs = report.candidate ? formatCandidateSummary(report.candidate) : '';
            const stats = `胜率 ${Utils.formatPercent(report.winRate)} 次数 ${report.totalCount}`;
            let extra = '';
            if (report.starRates && report.starRates.one > 0) {
                extra = `1星 ${Utils.formatPercent(report.starRates.one)} 2星 ${Utils.formatPercent(report.starRates.two)} 3星 ${Utils.formatPercent(report.starRates.three)}`;
            } else {
                extra = `平均回合 ${Utils.formatNumber(report.avgRounds)} 平均剩余 ${Utils.formatNumber(report.avgRemainingUnits)}`;
            }
            const seedText = report.firstWinSeed != null ? ` | 首胜Seed ${report.firstWinSeed}` : '';
            return `<div class="xc-report-item${reports.length > 1 ? ' xc-report-multi' : ''}">${prefix}<div class="sim-candidate-team" style="margin:2px 0 4px;">${heroImgs}</div><div class="xc-report-stats">${stats}</div><div class="xc-report-extra">${extra}${seedText}</div></div>`;
        }).join('');
        return `<div class="xc-report-title">${title}</div>${items}`;
    }

    var _lastReportSignature = '';
    function renderLastReport(reportView, reports) {
        if (!state.panel || !state.panel.refs.reportBody) {
            return;
        }
        const body = state.panel.refs.reportBody;
        if (!reportView) {
            if (_lastReportSignature !== '__empty__') {
                body.className = 'xc-report';
                body.textContent = '暂无结果';
                _lastReportSignature = '__empty__';
            }
            return;
        }
        if (reports && reports.length) {
            const sig = 'html:' + reports.map(r => r.reportId || r.signature || '').join('|');
            if (sig === _lastReportSignature) return;
            _lastReportSignature = sig;
            body.className = 'xc-report xc-report-html';
            body.innerHTML = buildReportBodyHTML(reportView.title, reports);
            body.querySelectorAll('.sim-hero-icon-img').forEach(async (img) => {
                const heroId = img.dataset.heroId;
                if (heroId) {
                    const url = await loadHeroIconUrl(parseInt(heroId));
                    if (url) img.src = url;
                }
            });
        } else {
            const sig = 'text:' + reportView.title + ':' + reportView.text;
            if (sig === _lastReportSignature) return;
            _lastReportSignature = sig;
            body.className = 'xc-report';
            body.textContent = `${reportView.title}\n${reportView.text}`;
        }
    }

    function pushMainPushLog(message, type = 'info') {
        const prefixMap = {
            info: '[信息]',
            success: '[成功]',
            warning: '[警告]',
            error: '[错误]',
        };
        state.mainPush.lastStatusType = type;
        state.mainPush.lastStatusText = message;
        const line = `[${Utils.formatTime(Utils.now())}]${prefixMap[type] || prefixMap.info} ${message}`;
        state.mainPush.logLines.unshift(line);
        state.mainPush.logLines = state.mainPush.logLines.slice(0, MAIN_PUSH_LOG_LIMIT);
        renderPanel();
    }

    function getMainPushDisplayState() {
        if (state.mainPush.isRunning) {
            if (state.mainPush.isResetting) {
                return {
                    tone: 'warning',
                    label: '重置中',
                };
            }
            if (state.mainPush.lastStatusType === 'error') {
                return {
                    tone: 'error',
                    label: '异常',
                };
            }
            if (state.mainPush.lastStatusType === 'warning') {
                return {
                    tone: 'warning',
                    label: '待重置',
                };
            }
            return {
                tone: 'running',
                label: '推关中',
            };
        }
        if (state.mainPush.lastStatusType === 'error') {
            return {
                tone: 'error',
                label: '已停止',
            };
        }
        return {
            tone: 'idle',
            label: '已停止',
        };
    }

    function shouldShowMainPushCard() {
        return !!(
            state.mainPush.isRunning
            || state.mainPush.logLines.length
            || state.mainPush.lastLevelId != null
            || state.mainPush.lastBossName
        );
    }

    function buildMainPushReportView() {
        const lines = [
            `状态 ${state.mainPush.isRunning ? '运行中' : '已停止'}`,
            `当前关卡 ${state.mainPush.lastLevelId != null ? state.mainPush.lastLevelId : '-'}`,
            `当前Boss ${state.mainPush.lastBossName || '-'}`,
            `当前轮次 ${state.mainPush.lastRoundId != null ? state.mainPush.lastRoundId : '-'}`,
            `重置计数 ${state.mainPush.resetCount || 0}`,
            '',
        ];
        if (state.mainPush.logLines.length) {
            lines.push(...state.mainPush.logLines);
        } else {
            lines.push('暂无日志');
        }
        return {
            title: '主线模拟推关',
            text: lines.join('\n'),
        };
    }

    function renderMainPushReport() {
        renderLastReport(buildMainPushReportView());
        renderMainPushLogStream();
    }

    function renderMainPushLogStream() {
        if (!state.panel || !state.panel.refs.mainPushLogCard || !state.panel.refs.mainPushLogBody) {
            return;
        }
        const isRunning = state.mainPush && state.mainPush.isRunning;
        const logLines = state.mainPush && state.mainPush.logLines ? state.mainPush.logLines : [];
        state.panel.refs.mainPushLogCard.style.display = (isRunning || logLines.length) ? '' : 'none';
        if (logLines.length) {
            state.panel.refs.mainPushLogBody.textContent = logLines.slice(-40).join('\n');
            state.panel.refs.mainPushLogBody.scrollTop = state.panel.refs.mainPushLogBody.scrollHeight;
        } else {
            state.panel.refs.mainPushLogBody.textContent = '暂无日志';
        }
    }

    function trySignalOn(signal, handler, target = null) {
        if (!signal) {
            return false;
        }
        if (typeof signal.on === 'function') {
            try {
                signal.on(handler, target);
                return true;
            } catch (error) {
                try {
                    signal.on(handler);
                    return true;
                } catch (innerError) {
                    return false;
                }
            }
        }
        if (typeof signal.add === 'function') {
            try {
                signal.add(handler, target);
                return true;
            } catch (error) {
                try {
                    signal.add(handler);
                    return true;
                } catch (innerError) {
                    return false;
                }
            }
        }
        return false;
    }

    function trySignalOff(signal, handler, target = null) {
        if (!signal) {
            return false;
        }
        if (typeof signal.off === 'function') {
            try {
                signal.off(handler, target);
                return true;
            } catch (error) {
                try {
                    signal.off(handler);
                    return true;
                } catch (innerError) {
                    return false;
                }
            }
        }
        if (typeof signal.remove === 'function') {
            try {
                signal.remove(handler, target);
                return true;
            } catch (error) {
                try {
                    signal.remove(handler);
                    return true;
                } catch (innerError) {
                    return false;
                }
            }
        }
        return false;
    }

    function trySignalEmit(signal, ...args) {
        if (!signal) {
            return false;
        }
        if (typeof signal.emit === 'function') {
            signal.emit(...args);
            return true;
        }
        if (typeof signal.dispatch === 'function') {
            signal.dispatch(...args);
            return true;
        }
        return false;
    }

    function getLevelBossName(levelId) {
        try {
            const Configs = Runtime.getConfigs();
            const levelConfig = Configs && Configs.LevelConf && typeof Configs.LevelConf.getById === 'function'
                ? Configs.LevelConf.getById(levelId)
                : null;
            if (!levelConfig || !Array.isArray(levelConfig.monsters)) {
                return '未知';
            }
            for (let i = 0; i < levelConfig.monsters.length; i += 1) {
                const roundMonsters = levelConfig.monsters[i];
                if (!Array.isArray(roundMonsters)) {
                    continue;
                }
                for (let j = 0; j < roundMonsters.length; j += 1) {
                    const monsterInfo = roundMonsters[j];
                    const monsterId = Array.isArray(monsterInfo)
                        ? Number(monsterInfo[0] || 0)
                        : Number(monsterInfo && monsterInfo.monsterId ? monsterInfo.monsterId : 0);
                    const monsterType = Array.isArray(monsterInfo)
                        ? Number(monsterInfo[1] || 0)
                        : Number(monsterInfo && monsterInfo.monsterType ? monsterInfo.monsterType : 0);
                    if (monsterType < 26 || monsterType > 28) {
                        continue;
                    }
                    return getMonsterDisplayName(monsterId, `Boss ${monsterId}`);
                }
            }
        } catch (error) {
            Utils.warn('读取主线 Boss 名称失败', error);
        }
        return '未知';
    }

    function resolveMainPushRoundId(args) {
        if (Array.isArray(args) && args.length >= 2 && Number.isFinite(Number(args[1]))) {
            return Number(args[1]);
        }
        const payload = Array.isArray(args) && args.length ? args[0] : null;
        if (payload && typeof payload === 'object') {
            const candidates = [payload.roundId, payload.round, payload.roundIndex, payload.curRound];
            for (let i = 0; i < candidates.length; i += 1) {
                const value = Number(candidates[i]);
                if (Number.isFinite(value) && value > 0) {
                    return value;
                }
            }
        }
        return 1;
    }

    function buildMainPushBattleDataSnapshot() {
        const levelBattle = Runtime.getLevelBattle();
        const rawBattleData = Utils.safeCall(() => levelBattle && levelBattle.options ? levelBattle.options.battleData : null, null);
        if (!rawBattleData) {
            throw new Error('当前未找到主线自动战斗 battleData');
        }
        const battleData = Utils.deepClone(rawBattleData);
        battleData.id = Utils.now();
        resetBattleRuntimeState(battleData);
        finalizeBattleDataForSimulation(battleData);
        const levelId = Number(
            getOptionValue(
                battleData && battleData.options ? battleData.options : null,
                'levelId',
                Utils.safeCall(() => Runtime.getRole().levelId, 0),
            ) || 0,
        );
        return {
            battleData,
            levelId,
        };
    }

    async function simulateMainPushBattle() {
        const snapshot = buildMainPushBattleDataSnapshot();
        const simConfig = Runtime.getDefaultSimConfig(snapshot.battleData);
        const result = await Runtime.simulateBattle(snapshot.battleData, simConfig.extend, simConfig.timeScale);
        return {
            battleData: snapshot.battleData,
            levelId: snapshot.levelId,
            result,
            bossName: getLevelBossName(snapshot.levelId),
        };
    }

    function requestMainPushReset() {
        if (state.mainPush.isResetting) {
            return;
        }
        state.mainPush.isResetting = true;
        if (state.mainPush.resetTimer) {
            clearTimeout(state.mainPush.resetTimer);
            state.mainPush.resetTimer = null;
        }
        state.mainPush.resetTimer = setTimeout(() => {
            state.mainPush.resetTimer = null;
            state.mainPush.isResetting = false;
            const GlobalSignal = Utils.safeCall(() => Runtime.getGlobalSignal(), null);
            const signal = GlobalSignal && GlobalSignal.LevelBattleReset ? GlobalSignal.LevelBattleReset : null;
            if (!trySignalEmit(signal)) {
                pushMainPushLog('触发主线重置失败：LevelBattleReset 不可用', 'error');
            }
        }, MAIN_PUSH_RESET_DELAY_MS);
    }

    function restoreMainPushAutoAttack() {
        if (state.mainPush.compLordProto && state.mainPush.originalCanAutoAttack) {
            state.mainPush.compLordProto.canAutoAttack = state.mainPush.originalCanAutoAttack;
        }
        state.mainPush.compLordProto = null;
        state.mainPush.originalCanAutoAttack = null;
    }

    function stopMainPush(reason = 'manual') {
        if (!state.mainPush.isRunning && !state.mainPush.handler) {
            return false;
        }
        const GlobalSignal = Utils.safeCall(() => Runtime.getGlobalSignal(), null);
        const signal = state.mainPush.signal || (GlobalSignal && GlobalSignal.LevelBattleStart ? GlobalSignal.LevelBattleStart : null);
        if (signal && state.mainPush.handler) {
            trySignalOff(signal, state.mainPush.handler);
        }
        restoreMainPushAutoAttack();
        if (state.mainPush.resetTimer) {
            clearTimeout(state.mainPush.resetTimer);
            state.mainPush.resetTimer = null;
        }
        state.mainPush.isRunning = false;
        state.mainPush.isResetting = false;
        state.mainPush.handler = null;
        state.mainPush.signal = null;
        if (state.activeJob && state.activeJob.kind === 'mainPush') {
            state.activeJob = null;
        }
        pushMainPushLog(reason === 'button' || reason === 'manual' ? '已停止模拟推关' : `模拟推关已停止：${reason}`, 'warning');
        renderPanel();
        return true;
    }

    async function handleMainPushBattleStart(...args) {
        if (!state.mainPush.isRunning || state.mainPush.isResetting) {
            return;
        }
        const roundId = resolveMainPushRoundId(args);
        state.mainPush.lastRoundId = roundId;
        if (roundId !== 1) {
            return;
        }
        try {
            const simulation = await simulateMainPushBattle();
            const levelId = simulation.levelId;
            if (state.mainPush.lastLevelId != null && state.mainPush.lastLevelId !== levelId) {
                state.mainPush.resetCount = 0;
            }
            state.mainPush.lastLevelId = levelId;
            state.mainPush.lastBossName = simulation.bossName;
            state.mainPush.resetCount += 1;
            tryCaptureAutoLevelBattleSkeleton('mainPush.tick');
            if (simulation.result && simulation.result.isWin) {
                pushMainPushLog(`关卡 ${levelId} [第 ${state.mainPush.resetCount} 次] 胜利`, 'success');
            } else {
                pushMainPushLog(`关卡 ${levelId} [第 ${state.mainPush.resetCount} 次] 失败，准备重置`, 'warning');
                requestMainPushReset();
            }
        } catch (error) {
            pushMainPushLog(`模拟推关异常：${error && error.message ? error.message : String(error)}`, 'error');
        }
    }

    async function startMainPush() {
        if (state.mainPush.isRunning) {
            throw new Error('模拟推关已经在运行中');
        }
        if (state.activeJob) {
            throw new Error(`已有任务执行中：${state.activeJob.title}`);
        }
        const GlobalSignal = Utils.safeCall(() => Runtime.getGlobalSignal(), null);
        const levelStartSignal = GlobalSignal && GlobalSignal.LevelBattleStart ? GlobalSignal.LevelBattleStart : null;
        if (!levelStartSignal) {
            throw new Error('LevelBattleStart 信号不可用');
        }
        buildMainPushBattleDataSnapshot();
        const CompLord = Utils.safeCall(() => Runtime.require('comp-lord').CompLord, null);
        if (!CompLord || !CompLord.prototype || typeof CompLord.prototype.canAutoAttack !== 'function') {
            throw new Error('CompLord.canAutoAttack 不可用');
        }

        state.lastSingleRun = null;
        state.lastDebugError = null;
        state.lastReport = null;
        state.lastReports = [];
        resetSeedRecordView(null);
        state.mainPush.isRunning = true;
        state.mainPush.isResetting = false;
        state.mainPush.resetCount = 0;
        state.mainPush.lastLevelId = null;
        state.mainPush.lastBossName = '';
        state.mainPush.lastRoundId = null;
        state.mainPush.logLines = [];
        state.mainPush.keepReport = true;
        state.mainPush.handler = handleMainPushBattleStart;
        state.mainPush.signal = levelStartSignal;
        state.mainPush.compLordProto = CompLord.prototype;
        state.mainPush.originalCanAutoAttack = CompLord.prototype.canAutoAttack;
        if (state.mainPush.resetTimer) {
            clearTimeout(state.mainPush.resetTimer);
            state.mainPush.resetTimer = null;
        }
        CompLord.prototype.canAutoAttack = function nonPvpMainPushNoAutoAttack() {
            return false;
        };

        if (!trySignalOn(levelStartSignal, state.mainPush.handler)) {
            restoreMainPushAutoAttack();
            state.mainPush.isRunning = false;
            state.mainPush.handler = null;
            state.mainPush.signal = null;
            throw new Error('LevelBattleStart 监听注册失败');
        }

        state.activeJob = {
            title: '模拟推关',
            kind: 'mainPush',
            startedAt: Utils.now(),
        };
        tryCaptureAutoLevelBattleSkeleton('mainPush.start');
        pushMainPushLog('主线模拟推关已启动', 'success');
        renderMainPushReport();
        const resetSignal = GlobalSignal && GlobalSignal.LevelBattleReset ? GlobalSignal.LevelBattleReset : null;
        if (!trySignalEmit(resetSignal)) {
            pushMainPushLog('首次触发主线重置失败：LevelBattleReset 不可用', 'error');
        }
    }

    function legacy_buildContextText(modeKey, context) {
        if (!context) {
            return '-';
        }
        if (modeKey === 'tower') {
            return context.stageName || (context.stageId != null ? `关卡 ${context.stageId}` : '-');
        }
        if (modeKey === 'evoTower') {
            return context.stageName || (context.towerId != null ? `层数 ${context.towerId}` : '-');
        }
        if (modeKey === 'genie') {
            const genieChoice = (context.title || '').includes('深海') ? 'genieShenhai' : 'genie';
            const genieOption = findQuickTargetOption(genieChoice, context.genieLevelId != null ? context.genieLevelId : context.genieId);
            if (genieOption) {
                return genieOption.label;
            }
            if (context.genieLevelId != null) {
                if ((context.title || '').includes('深海')) {
                    const layer = Number(context.genieLevelId) % 1000 || Number(context.genieLevelId);
                    return `${context.title || '灯神'} 第 ${layer} 层`;
                }
                return `${context.title || '灯神'} Level ${context.genieLevelId}`;
            }
            return context.genieId != null ? `${context.title || '灯神'} #${context.genieId}` : '灯神';
        }
        if (modeKey === 'legionBoss') {
            const option = findQuickTargetOption('legionBoss', context.legionBossId);
            const baseText = option
                ? option.label
                : context.legionBossId != null
                    ? `俱乐部Boss 第 ${context.legionBossId} 只${context.bossName ? ` - ${context.bossName}` : ''}`
                    : '俱乐部Boss';
            if (context.currentHp != null && Number(context.currentHp) > 0) {
                return `${baseText}，剩余HP ${Utils.formatNumber(Number(context.currentHp), 0)}`;
            }
            return baseText;
        }
        if (modeKey === 'nightmareStar') {
            const option = findQuickTargetOption('nightmareStar', context.bossId);
            const baseText = option ? option.label : (context.bossId != null ? `Boss ${context.bossId}` : '星级挑战');
            return `${baseText}，剩余次数 ${context.remainStarFightCount != null ? context.remainStarFightCount : '-'}`;
        }
        if (modeKey === 'nightmare') {
            const option = findQuickTargetOption('nightmare', context.bossId);
            if (option) {
                return option.label;
            }
            if (context.hallNumber != null || context.bossName) {
                const hallText = context.hallNumber != null ? `第 ${context.hallNumber} 殿` : '十殿试炼';
                const nameText = context.bossName ? ` - ${context.bossName}` : '';
                return `${hallText}${nameText}`;
            }
            return `Boss ${context.bossId != null ? context.bossId : '-'}，房间 ${context.roomId != null ? context.roomId : '-'}`;
        }
        if (modeKey === 'capture') {
            return context.source || '最近捕获';
        }
        return '-';
    }

    function buildContextText(modeKey, context) {
        if (!context) {
            return '-';
        }
        if (modeKey === 'tower') {
            return context.stageName || (context.stageId != null ? buildTowerLikeStageName(context.stageId) : '-');
        }
        if (modeKey === 'evoTower') {
            return context.stageName || (context.towerId != null ? buildTowerLikeStageName(context.towerId) : '-');
        }
        if (modeKey === 'genie') {
            const genieChoice = (context.title || '').includes('深海') ? 'genieShenhai' : 'genie';
            const genieOption = findQuickTargetOption(genieChoice, context.genieLevelId != null ? context.genieLevelId : context.genieId);
            if (genieOption) {
                return genieOption.label;
            }
            if (context.genieLevelId != null) {
                if ((context.title || '').includes('深海')) {
                    const layer = Number(context.genieLevelId) % 1000 || Number(context.genieLevelId);
                    return `${context.title || '灯神'} 第${layer}层`;
                }
                return `${context.title || '灯神'} Level ${context.genieLevelId}`;
            }
            return context.genieId != null ? `${context.title || '灯神'} #${context.genieId}` : '灯神';
        }
        if (modeKey === 'nightmareStar') {
            const option = findQuickTargetOption('nightmareStar', context.bossId);
            const baseText = option ? option.label : (context.bossId != null ? `Boss ${context.bossId}` : '星级挑战');
            return `${baseText}，剩余次数 ${context.remainStarFightCount != null ? context.remainStarFightCount : '-'}`;
        }
        if (modeKey === 'nightmare') {
            const option = findQuickTargetOption('nightmare', context.bossId);
            if (option) {
                return option.label;
            }
            if (context.hallNumber != null || context.bossName) {
                const hallText = context.hallNumber != null ? `第${context.hallNumber}殿` : '十殿试炼';
                const nameText = context.bossName ? ` - ${context.bossName}` : '';
                return `${hallText}${nameText}`;
            }
            return `Boss ${context.bossId != null ? context.bossId : '-'}，房间 ${context.roomId != null ? context.roomId : '-'}`;
        }
        if (modeKey === 'capture') {
            return context.source || '最近捕获';
        }
        return '-';
    }

    function isContextCompatible(currentContext, cacheContext, keys) {
        if (!currentContext || !cacheContext) {
            return true;
        }
        return keys.every((key) => {
            if (currentContext[key] == null || cacheContext[key] == null) {
                return true;
            }
            return currentContext[key] === cacheContext[key];
        });
    }

    function getTargetHintText(choice) {
        switch (choice) {
            case 'tower':
                return '咸将塔改成双框填写了，左框填前段，右框填后段，例如 385 和 8；脚本会自动换算成内部 stageId。';
            case 'evoTower':
                return '怪异塔也改成双框填写，左框填前段，右框填后段，例如 35 和 10；脚本会自动换算成真实 towerId。';
            case 'genie':
                return '普通灯神现在会标出魏、蜀、吴、群；建议直接用下拉选择，或输入“魏-12”这种格式，脚本会自动换算成对应的 genieLevelId。';
            case 'genieShenhai':
                return '深海灯神支持直接选第 1 到第 10 层，也支持下拉选择；脚本会自动补成真实 levelId。';
            case 'legionBoss':
                return '俱乐部Boss支持直接输入第几只，也支持下拉选择 1-150；脚本会从 LegionBossConf 读取怪物配置并优先走预模拟。';
            case 'nightmare':
                return '十殿试炼支持直接选殿数；第 9 殿已拆成 9-1 和 9-2 两个形态，默认输入 9 会优先第一形态。';
            case 'nightmareStar':
                return '星级挑战可以直接输入关卡序号，也可以用下拉选择；脚本会自动换算成对应 bossId。';
            case 'capture':
                return '使用最近一次抓到的战斗数据，不需要填写目标。';
            default:
                return '自动识别模式时可以留空；也可以先点“识别当前玩法”自动回填。';
        }
    }

    function getTargetInputPlaceholder(choice) {
        switch (choice) {
            case 'tower':
                return '例如 385-8';
            case 'evoTower':
                return '例如 35-10';
            case 'genie':
                return '例如 魏-12';
            case 'genieShenhai':
                return '例如 7';
            case 'legionBoss':
                return '例如 75';
            case 'nightmare':
                return '例如 9-1';
            case 'nightmareStar':
                return '例如 3';
            default:
                return '目标层数 / 关卡序号';
        }
    }

    function getNightmareManualTargetOptions() {
        const nightmareMetas = getNightmareMonsterMetas();
        if (nightmareMetas.length) {
            const hallMap = new Map();
            nightmareMetas
                .slice()
                .sort((left, right) => Number(left.hallNumber || 0) - Number(right.hallNumber || 0)
                    || Number(left.phaseIndex || 0) - Number(right.phaseIndex || 0)
                    || Number(left.hidden || 0) - Number(right.hidden || 0)
                    || Number(left.bossId || 0) - Number(right.bossId || 0))
                .forEach((item) => {
                    const hallNumber = Number(item.hallNumber || 0);
                    if (!hallMap.has(hallNumber)) {
                        hallMap.set(hallNumber, []);
                    }
                    hallMap.get(hallNumber).push(item);
                });
            const options = [];
            Array.from(hallMap.keys()).sort((left, right) => left - right).forEach((hallNumber) => {
                const bucket = hallMap.get(hallNumber) || [];
                if (!bucket.length) {
                    return;
                }
                if (Number(hallNumber) === 9 && bucket.length > 1) {
                    bucket
                        .slice()
                        .sort((left, right) => Number(left.phaseIndex || 0) - Number(right.phaseIndex || 0)
                            || Number(right.hidden || 0) - Number(left.hidden || 0)
                            || Number(left.bossId || 0) - Number(right.bossId || 0))
                        .forEach((item, index) => {
                            const candidate = buildNightmareManualTargetOption(item, index + 1);
                            if (candidate) {
                                options.push(candidate);
                            }
                        });
                    return;
                }
                const preferred = bucket.find((item) => Number(item.hidden || 0) === 0) || bucket[0];
                const candidate = buildNightmareManualTargetOption(preferred, Number(preferred.phaseIndex || 0));
                if (candidate) {
                    options.push(candidate);
                }
            });
            if (options.length) {
                return dedupeManualTargetOptions(options);
            }
        }
        const directTables = [
            getFirstConfigTable('NightMareBossConf', 'NightMareConf', 'NightmareConf', 'NightMareRoomConf'),
        ].filter(Boolean);
        const scannedTables = findConfigTablesByName((name, table) => {
            if (!name || !table) {
                return false;
            }
            if (!name.includes('NightMare') || name.includes('Star')) {
                return false;
            }
            return !!listConfigEntries(table).length;
        }).map((item) => item.table);
        const tables = [...directTables, ...scannedTables];
        let best = [];
        tables.forEach((table) => {
            const hallMap = new Map();
            listConfigEntries(table).forEach((item, index) => {
                const bossId = getNumericFieldValue(item, ['bossId', 'monsterCfgId', 'monsterId', 'id', 'ID'], null);
                if (bossId == null) {
                    return;
                }
                const hallNumber = getNumericFieldValue(item, ['roomId', 'room', 'idx', 'index', 'order'], index + 1);
                if (!hallMap.has(hallNumber)) {
                    hallMap.set(hallNumber, []);
                }
                hallMap.get(hallNumber).push({
                    bossId,
                    hallNumber,
                    hidden: getNumericFieldValue(item, ['hidden'], 0),
                    displayName: getTextFieldValue(item, ['name', 'title'], ''),
                    description: '',
                });
            });
            const options = [];
            Array.from(hallMap.keys()).sort((left, right) => left - right).forEach((hallNumber) => {
                const bucket = hallMap.get(hallNumber) || [];
                if (!bucket.length) {
                    return;
                }
                if (Number(hallNumber) === 9 && bucket.length > 1) {
                    bucket
                        .slice()
                        .sort((left, right) => Number(right.hidden || 0) - Number(left.hidden || 0)
                            || Number(left.bossId || 0) - Number(right.bossId || 0))
                        .forEach((entry, index) => {
                            const candidate = buildNightmareManualTargetOption(entry, index + 1);
                            if (candidate) {
                                options.push(candidate);
                            }
                        });
                    return;
                }
                const candidate = buildNightmareManualTargetOption(bucket[0], 0);
                if (candidate) {
                    options.push(candidate);
                }
            });
            const dedupedOptions = dedupeManualTargetOptions(options);
            if (dedupedOptions.length >= 8 && dedupedOptions.length <= 12) {
                best = dedupedOptions;
            } else if (!best.length && dedupedOptions.length) {
                best = dedupedOptions;
            }
        });
        return best;
    }

    const Adapters = {
        tower: {
            key: 'tower',
            label: MODE_LABELS.tower,
            getContext() {
                const towerModule = Runtime.getModuleByTypeKey('TOWER');
                const cache = state.modeCaches.tower;
                const stageId = Utils.safeCall(() => towerModule.curStageInfo.id, Utils.safeCall(() => cache.context.stageId, null));
                const fallbackMonsters = Utils.safeCall(() => towerModule.curStageInfo.monster, Utils.safeCall(() => cache.context.monster, null));
                const previewMonsters = getTowerPreviewMonsters(stageId, fallbackMonsters);
                return applyManualContextOverrides('tower', {
                    stageId,
                    stageName: Utils.safeCall(() => towerModule.constructor.getTowerDetailName(stageId), null) || (stageId != null ? `关卡 ${stageId}` : '-'),
                    towerEnerge: Utils.safeCall(() => towerModule.towerEnerge, Utils.safeCall(() => cache.context.towerEnerge, 0)),
                    monster: previewMonsters.length ? previewMonsters.map((item) => [item.monsterId, item.index, item.level]) : fallbackMonsters,
                });
            },
            getScore() {
                const context = this.getContext();
                let score = 0;
                if (context.stageId != null) {
                    score += 20;
                }
                if (state.modeCaches.tower && state.modeCaches.tower.capturedAt) {
                    score += 100;
                }
                if (state.modeCaches.tower && state.modeCaches.tower.inputData) {
                    score += 40;
                }
                return score;
            },
            capabilities() {
                const context = this.getContext();
                const cache = state.modeCaches.tower;
                if (context.stageId != null && canUsePreviewSkeleton() && getTowerPreviewMonsters(context.stageId, context.monster).length) {
                    return CAPABILITY.PREVIEW;
                }
                if (cache && cache.inputData) {
                    return CAPABILITY.REPLAY;
                }
                return CAPABILITY.NONE;
            },
            async ensureAuthorityData() {
                const context = this.getContext();
                if (context.stageId != null && canUsePreviewSkeleton() && getTowerPreviewMonsters(context.stageId, context.monster).length) {
                    return;
                }
                if (state.modeCaches.tower && state.modeCaches.tower.battleData) {
                    return;
                }
                throw new Error('咸将塔当前既没有可预构造的骨架，也没有权威 battleData。请先进入主线页面或打一场后再试。');
            },
            buildDraft() {
                const cache = state.modeCaches.tower;
                const context = this.getContext();
                const previewMonsters = getTowerPreviewMonsters(context.stageId, context.monster);
                if (context.stageId != null && previewMonsters.length && canUsePreviewSkeleton()) {
                    const baseSkeleton = Runtime.getReusableBattleSkeleton(true);
                    return createPreviewDraft('tower', context, CAPABILITY.PREVIEW, (candidate, seed) => createBattleDataFromPreview(
                        baseSkeleton,
                        'tower',
                        context,
                        candidate,
                        seed,
                        previewMonsters,
                        {
                            options: {
                                towerId: Number(context.stageId),
                            },
                        },
                    ), (result, battleData) => {
                        const towerModule = Runtime.getModuleByTypeKey('TOWER');
                        if (towerModule && typeof towerModule.createBattleInputData === 'function') {
                            return Utils.safeCall(
                                () => towerModule.createBattleInputData(battleData, result, context.towerEnerge || 0),
                                buildLooseReplayInput(battleData, result, 'tower'),
                            );
                        }
                        return buildLooseReplayInput(battleData, result, 'tower');
                    });
                }
                if (!cache || !cache.battleData) {
                    throw new Error('咸将塔当前没有可用 battleData');
                }
                return createAuthorityDraft('tower', context, this.capabilities(), cache, (innerCache, battleData, result) => {
                    const towerModule = Runtime.getModuleByTypeKey('TOWER');
                    if (towerModule && typeof towerModule.createBattleInputData === 'function') {
                        return towerModule.createBattleInputData(battleData, result, context.towerEnerge || 0);
                    }
                    return buildReplayInputFromBase(innerCache.inputData || state.latestCapture && state.latestCapture.input, battleData, result);
                });
            },
        },
        genie: {
            key: 'genie',
            label: MODE_LABELS.genie,
            getContext() {
                const cache = state.modeCaches.genie;
                const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
                let genieId = Utils.safeCall(() => cache.context.genieId, null);
                let genieLevelId = Utils.safeCall(() => cache.context.genieLevelId, null);
                if (genieLevelId == null) {
                    genieLevelId = getOptionValue(Utils.safeCall(() => cache.battleData.options, null), 'genieLevelId', null);
                }
                if (genieLevelId == null) {
                    genieLevelId = getOptionValue(Utils.safeCall(() => cache.inputData.battleData.options, null), 'genieLevelId', null);
                }
                if (genieId == null && genieLevelId != null) {
                    genieId = genieLevelId;
                }
                const clubId = genieLevelId != null
                    ? Math.floor(Number(genieLevelId) / 1000)
                    : genieId != null ? Math.floor(Number(genieId) / 1000) : null;
                const shenhaiClub = Configs && Configs.Club ? Configs.Club.SHENHAI : null;
                return applyManualContextOverrides('genie', {
                    genieId,
                    genieLevelId,
                    clubId,
                    title: clubId != null && shenhaiClub != null && clubId === shenhaiClub
                        ? '深海灯神'
                        : buildGenieModeTitle(clubId),
                    lordWeaponId: Utils.safeCall(() => cache.context.lordWeaponId, null),
                });
            },
            getScore() {
                let score = 0;
                if (state.modeCaches.genie && state.modeCaches.genie.capturedAt) {
                    score += 100;
                }
                if (state.modeCaches.genie && state.modeCaches.genie.inputData) {
                    score += 40;
                }
                if (Utils.safeCall(() => state.modeCaches.genie.context.genieId, null) != null) {
                    score += 20;
                }
                return score;
            },
            capabilities() {
                const context = this.getContext();
                const cache = state.modeCaches.genie;
                if (context.genieLevelId != null && canUsePreviewSkeleton() && getGeniePreviewInfo(context).monsters.length) {
                    return CAPABILITY.PREVIEW;
                }
                if (cache && cache.inputData) {
                    return CAPABILITY.REPLAY;
                }
                return CAPABILITY.NONE;
            },
            async ensureAuthorityData() {
                const context = this.getContext();
                if (context.genieLevelId != null && canUsePreviewSkeleton() && getGeniePreviewInfo(context).monsters.length) {
                    return;
                }
                if (state.modeCaches.genie && state.modeCaches.genie.battleData) {
                    return;
                }
                throw new Error('灯神当前缺少 genieLevelId 或可复用骨架。深海灯神建议直接填写 5007 这种 levelId，或先真实打一场。');
            },
            buildDraft() {
                const cache = state.modeCaches.genie;
                const context = this.getContext();
                const previewInfo = getGeniePreviewInfo(context, Utils.safeCall(() => cache.context.monster, null));
                if (previewInfo.genieLevelId && previewInfo.monsters.length && canUsePreviewSkeleton()) {
                    const baseSkeleton = Runtime.getReusableBattleSkeleton(true);
                    return createPreviewDraft('genie', Object.assign({}, context, {
                        genieLevelId: previewInfo.genieLevelId,
                    }), CAPABILITY.PREVIEW, (candidate, seed) => createBattleDataFromPreview(
                        baseSkeleton,
                        'genie',
                        context,
                        candidate,
                        seed,
                        previewInfo.monsters,
                        {
                            options: {
                                genieLevelId: Number(previewInfo.genieLevelId),
                            },
                        },
                    ), (result, battleData) => {
                        const genieModule = Runtime.getModuleByTypeKey('GENIE');
                        if (genieModule && typeof genieModule.createBattleInputData === 'function') {
                            const mapId = resolveGenieBattleMapId(context);
                            if (mapId != null) {
                                genieModule.mapId = mapId;
                            }
                            return Utils.safeCall(() => genieModule.createBattleInputData(battleData, result), buildLooseReplayInput(battleData, result, 'genie'));
                        }
                        return buildLooseReplayInput(battleData, result, 'genie');
                    });
                }
                if (!cache || !cache.battleData) {
                    throw new Error('灯神当前没有可用 battleData');
                }
                return createAuthorityDraft('genie', context, this.capabilities(), cache, (innerCache, battleData, result) => {
                    const genieModule = Runtime.getModuleByTypeKey('GENIE');
                    if (genieModule && typeof genieModule.createBattleInputData === 'function') {
                        const mapId = resolveGenieBattleMapId(context);
                        if (mapId != null) {
                            genieModule.mapId = mapId;
                        }
                        return genieModule.createBattleInputData(battleData, result);
                    }
                    return buildReplayInputFromBase(innerCache.inputData || state.latestCapture && state.latestCapture.input, battleData, result);
                });
            },
        },
        evoTower: {
            key: 'evoTower',
            label: MODE_LABELS.evoTower,
            getContext() {
                const evoModule = Runtime.getModuleByTypeKey('EVOTOWER');
                const cache = state.modeCaches.evoTower;
                const towerId = Utils.safeCall(() => evoModule.curStageInfo.id, Utils.safeCall(() => cache.context.towerId, null));
                const fallbackMonsters = Utils.safeCall(() => evoModule.curStageInfo.monster, Utils.safeCall(() => cache.context.monster, null));
                const previewMonsters = getEvoTowerPreviewMonsters(towerId, fallbackMonsters);
                return applyManualContextOverrides('evoTower', {
                    towerId,
                    stageName: towerId != null ? `怪异塔 ${towerId}` : '怪异塔',
                    energy: Utils.safeCall(() => evoModule.evoTower.energy, Utils.safeCall(() => cache.context.energy, null)),
                    monster: previewMonsters.length ? previewMonsters.map((item) => [item.monsterId, item.index, item.level]) : fallbackMonsters,
                });
            },
            getScore() {
                const context = this.getContext();
                let score = 0;
                if (context.towerId != null) {
                    score += 25;
                }
                if (state.modeCaches.evoTower && state.modeCaches.evoTower.capturedAt) {
                    score += 100;
                }
                return score;
            },
            capabilities() {
                const context = this.getContext();
                const cache = state.modeCaches.evoTower;
                if (context.towerId != null && canUsePreviewSkeleton() && getEvoTowerPreviewMonsters(context.towerId, context.monster).length) {
                    return CAPABILITY.PREVIEW;
                }
                if (cache && cache.inputData) {
                    return CAPABILITY.REPLAY;
                }
                return CAPABILITY.NONE;
            },
            async ensureAuthorityData() {
                const context = this.getContext();
                if (context.towerId != null && canUsePreviewSkeleton() && getEvoTowerPreviewMonsters(context.towerId, context.monster).length) {
                    return;
                }
                if (state.modeCaches.evoTower && state.modeCaches.evoTower.battleData) {
                    return;
                }
                const evoModule = Runtime.getModuleByTypeKey('EVOTOWER');
                if (!evoModule || typeof evoModule.sendReadyFight !== 'function') {
                    throw new Error('未找到怪异塔 readyFight 接口');
                }
                const ok = await evoModule.sendReadyFight();
                if (!ok) {
                    throw new Error('怪异塔 readyFight 失败');
                }
                await Utils.sleep(60);
                const battleData = Utils.safeCall(() => evoModule.readyFightResp.battleData, null);
                if (battleData) {
                    captureAuthorityBattle('evoTower', battleData, {
                        context: this.getContext(),
                        source: 'EVOTOWER.sendReadyFight',
                    });
                }
                if (!state.modeCaches.evoTower || !state.modeCaches.evoTower.battleData) {
                    throw new Error('怪异塔在 readyFight 后仍未拿到 battleData，请确认当前页面就是你选中的那一层。');
                }
            },
            buildDraft() {
                const cache = state.modeCaches.evoTower;
                const context = this.getContext();
                const previewMonsters = getEvoTowerPreviewMonsters(context.towerId, context.monster);
                if (context.towerId != null && previewMonsters.length && canUsePreviewSkeleton()) {
                    const baseSkeleton = Runtime.getReusableBattleSkeleton(true);
                    return createPreviewDraft('evoTower', context, CAPABILITY.PREVIEW, (candidate, seed) => createBattleDataFromPreview(
                        baseSkeleton,
                        'evoTower',
                        context,
                        candidate,
                        seed,
                        previewMonsters,
                        {
                            options: {
                                towerId: Number(context.towerId),
                            },
                        },
                    ), (result, battleData) => {
                        const evoModule = Runtime.getModuleByTypeKey('EVOTOWER');
                        if (evoModule && typeof evoModule.createBattleInputData === 'function') {
                            return Utils.safeCall(
                                () => evoModule.createBattleInputData(battleData, result, context.energy || 0),
                                buildLooseReplayInput(battleData, result, 'evoTower'),
                            );
                        }
                        return buildLooseReplayInput(battleData, result, 'evoTower');
                    });
                }
                if (!cache || !cache.battleData) {
                    throw new Error('怪异塔当前没有可用 battleData');
                }
                return createAuthorityDraft('evoTower', context, this.capabilities(), cache, (innerCache, battleData, result) => {
                    const evoModule = Runtime.getModuleByTypeKey('EVOTOWER');
                    if (evoModule && typeof evoModule.createBattleInputData === 'function') {
                        return evoModule.createBattleInputData(battleData, result, context.energy || 0);
                    }
                    return buildReplayInputFromBase(innerCache.inputData || state.latestCapture && state.latestCapture.input, battleData, result);
                });
            },
        },
        legionBoss: {
            key: 'legionBoss',
            label: MODE_LABELS.legionBoss,
            getContext() {
                const legionModule = Runtime.getModuleByTypeKey('LEGION');
                const cache = state.modeCaches.legionBoss;
                const currentBossInfo = Utils.safeCall(() => legionModule.currentBossInfo, null)
                    || Utils.safeCall(() => legionModule.legion.currentBossInfo, null)
                    || Utils.safeCall(() => legionModule.legion.currentBoss, null)
                    || Utils.safeCall(() => cache.context.currentBossInfo, null);
                const legionBossId = getNumericFieldValue(currentBossInfo || {}, ['legionBossId', 'id', 'ID'], Utils.safeCall(() => cache.context.legionBossId, null));
                const legionBossShow = getNumericFieldValue(currentBossInfo || {}, ['legionBossShow'], Utils.safeCall(() => cache.context.legionBossShow, null));
                const currentHp = Utils.safeCall(() => legionModule.legion.currentBoss.currentHP, null)
                    || Utils.safeCall(() => legionModule.currentBoss.currentHP, null)
                    || getNumericFieldValue(currentBossInfo || {}, ['currentHP', 'currentHp', 'hp'], Utils.safeCall(() => cache.context.currentHp, null));
                const fallbackMonsters = Utils.safeCall(() => currentBossInfo.monsters, Utils.safeCall(() => cache.context.monster, null));
                const previewInfo = getLegionBossPreviewInfo({
                    legionBossId,
                    legionBossShow,
                    currentHp,
                }, fallbackMonsters);
                return applyManualContextOverrides('legionBoss', {
                    legionBossId,
                    legionBossShow: previewInfo.legionBossShow != null ? previewInfo.legionBossShow : legionBossShow,
                    bossName: previewInfo.name || '',
                    currentHp: previewInfo.currentHp || currentHp || 0,
                    bossPower: getNumericFieldValue(currentBossInfo || {}, ['legionBossZhanLi', 'power'], Utils.safeCall(() => cache.context.bossPower, null)),
                    monster: previewInfo.monsters.length
                        ? previewInfo.monsters.map((item) => [item.monsterId, item.index, item.level])
                        : fallbackMonsters,
                });
            },
            getScore() {
                const context = this.getContext();
                let score = 0;
                if (context.legionBossId != null) {
                    score += 25;
                }
                if (state.modeCaches.legionBoss && state.modeCaches.legionBoss.capturedAt) {
                    score += 100;
                }
                if (state.modeCaches.legionBoss && state.modeCaches.legionBoss.inputData) {
                    score += 40;
                }
                return score;
            },
            capabilities() {
                const context = this.getContext();
                const previewInfo = getLegionBossPreviewInfo(context, context.monster);
                if (context.legionBossId != null && canUsePreviewSkeleton() && previewInfo.monsters.length) {
                    return CAPABILITY.PREVIEW;
                }
                const cache = state.modeCaches.legionBoss;
                if (cache && cache.battleData) {
                    return CAPABILITY.HYBRID;
                }
                if (cache && cache.inputData) {
                    return CAPABILITY.REPLAY;
                }
                return CAPABILITY.NONE;
            },
            async ensureAuthorityData() {
                const context = this.getContext();
                const previewInfo = getLegionBossPreviewInfo(context, context.monster);
                if (context.legionBossId != null && canUsePreviewSkeleton() && previewInfo.monsters.length) {
                    return;
                }
                if (state.modeCaches.legionBoss && state.modeCaches.legionBoss.battleData) {
                    return;
                }
                if (context.legionBossId != null && previewInfo.monsters.length) {
                    throw new Error('俱乐部Boss目标已识别，但当前没有可复用的战斗骨架。请先切到主线或任意非PVP战斗页面，再回来模拟。');
                }
                throw new Error('俱乐部Boss当前既没有可复用骨架，也没有已抓到的权威 battleData。');
            },
            buildDraft() {
                const cache = state.modeCaches.legionBoss;
                const context = this.getContext();
                const previewInfo = getLegionBossPreviewInfo(context, context.monster);
                if (context.legionBossId != null && previewInfo.monsters.length && canUsePreviewSkeleton()) {
                    const baseSkeleton = Runtime.getReusableBattleSkeleton(true);
                    return createPreviewDraft('legionBoss', context, CAPABILITY.PREVIEW, (candidate, seed) => {
                        const battleData = createBattleDataFromPreview(
                            baseSkeleton,
                            'legionBoss',
                            context,
                            candidate,
                            seed,
                            previewInfo.monsters,
                            {
                                options: {
                                    legionBossId: Number(previewInfo.legionBossId || context.legionBossId || 0),
                                    legionBossShow: Number(previewInfo.legionBossShow || context.legionBossShow || 0),
                                },
                            },
                        );
                        applyEnemyCurrentHpOverride(battleData, context.currentHp);
                        return battleData;
                    }, (result, battleData) => {
                        const legionModule = Runtime.getModuleByTypeKey('LEGION');
                        if (legionModule && typeof legionModule.createBattleInputData === 'function') {
                            return Utils.safeCall(
                                () => legionModule.createBattleInputData(battleData, result),
                                buildLooseReplayInput(battleData, result, 'legionBoss', cache && cache.inputData ? cache.inputData : null),
                            );
                        }
                        return buildLooseReplayInput(battleData, result, 'legionBoss', cache && cache.inputData ? cache.inputData : null);
                    });
                }
                if (!cache || !cache.battleData) {
                    throw new Error('俱乐部Boss当前没有可用 battleData');
                }
                return createAuthorityDraft('legionBoss', context, this.capabilities(), cache, (innerCache, battleData, result) => {
                    const legionModule = Runtime.getModuleByTypeKey('LEGION');
                    if (legionModule && typeof legionModule.createBattleInputData === 'function') {
                        return Utils.safeCall(
                            () => legionModule.createBattleInputData(battleData, result),
                            buildLooseReplayInput(battleData, result, 'legionBoss', innerCache && innerCache.inputData ? innerCache.inputData : null),
                        );
                    }
                    return buildLooseReplayInput(battleData, result, 'legionBoss', innerCache && innerCache.inputData ? innerCache.inputData : null);
                });
            },
        },
        nightmareStar: {
            key: 'nightmareStar',
            label: MODE_LABELS.nightmareStar,
            getContext() {
                const cache = state.modeCaches.nightmareStar;
                const input = cache && cache.inputData ? cache.inputData : null;
                let remainStarFightCount = Utils.safeCall(() => cache.context.remainStarFightCount, null);
                let maxStarCount = Utils.safeCall(() => cache.context.maxStarCount, null);
                let nowStarIdxList = Utils.safeCall(() => cache.context.nowStarIdxList, []);
                if (input && input.options && typeof input.options.forEach === 'function') {
                    input.options.forEach((value) => {
                        if (value && typeof value === 'object' && value.bossId && value.remainStarFightCount != null) {
                            remainStarFightCount = value.remainStarFightCount;
                            maxStarCount = value.maxStarCount;
                            nowStarIdxList = value.nowStarIdxList || [];
                        }
                    });
                }
                const baseContext = applyManualContextOverrides('nightmareStar', {
                    bossId: Utils.safeCall(() => cache.context.bossId, null),
                    remainStarFightCount,
                    maxStarCount,
                    nowStarIdxList,
                    lordWeaponId: Utils.safeCall(() => cache.context.lordWeaponId, null),
                });
                const stageMeta = getNightmareStarStageMeta(baseContext && baseContext.bossId != null ? baseContext.bossId : null);
                const previewInfo = getNightmareStarPreviewInfo(baseContext, Utils.safeCall(() => cache.context.monster, null));
                return Object.assign({}, baseContext, {
                    stageNumber: stageMeta ? stageMeta.stageNumber : null,
                    bossName: stageMeta ? stageMeta.displayName : '',
                    monster: previewInfo.monsters.length
                        ? previewInfo.monsters.map((item) => [item.monsterId, item.index, item.level])
                        : Utils.safeCall(() => cache.context.monster, null),
                });
            },
            getScore() {
                let score = 0;
                const context = this.getContext();
                const previewInfo = getNightmareStarPreviewInfo(context, context.monster);
                if (context.bossId != null && canUsePreviewSkeleton() && previewInfo.monsters.length) {
                    score += 120;
                }
                if (state.modeCaches.nightmareStar && state.modeCaches.nightmareStar.capturedAt) {
                    score += 95;
                }
                if (Utils.safeCall(() => state.modeCaches.nightmareStar.context.bossId, null) != null) {
                    score += 20;
                }
                return score;
            },
            capabilities() {
                const context = this.getContext();
                const previewInfo = getNightmareStarPreviewInfo(context, context.monster);
                if (context.bossId != null && canUsePreviewSkeleton() && previewInfo.monsters.length) {
                    return CAPABILITY.PREVIEW;
                }
                const cache = state.modeCaches.nightmareStar;
                if (cache && cache.battleData) {
                    return CAPABILITY.HYBRID;
                }
                if (cache && cache.inputData) {
                    return CAPABILITY.REPLAY;
                }
                return CAPABILITY.NONE;
            },
            async ensureAuthorityData() {
                const context = this.getContext();
                const previewInfo = getNightmareStarPreviewInfo(context, context.monster);
                if (context.bossId != null && canUsePreviewSkeleton() && previewInfo.monsters.length) {
                    return;
                }
                if (state.modeCaches.nightmareStar && state.modeCaches.nightmareStar.battleData) {
                    return;
                }
                throw new Error('星级挑战还没有权威 battleData。请先切到目标 boss 并真实开一次战斗。');
            },
            buildDraft() {
                const cache = state.modeCaches.nightmareStar;
                const context = this.getContext();
                const previewInfo = getNightmareStarPreviewInfo(context, context.monster);
                if (context.bossId != null && previewInfo.monsters.length && canUsePreviewSkeleton()) {
                    const baseSkeleton = Runtime.getReusableBattleSkeleton(true);
                    return createPreviewDraft('nightmareStar', context, CAPABILITY.PREVIEW, (candidate, seed) => createBattleDataFromPreview(
                        baseSkeleton,
                        'nightmareStar',
                        context,
                        candidate,
                        seed,
                        previewInfo.monsters,
                    ), (result, battleData, candidate) => buildNightmareStarReplayInput(
                        context,
                        battleData,
                        result,
                        candidate,
                        cache && cache.inputData ? cache.inputData : null,
                    ));
                }
                if (!cache || !cache.battleData) {
                    throw new Error('星级挑战当前没有可用 battleData');
                }
                return createAuthorityDraft('nightmareStar', context, this.capabilities(), cache, (innerCache, battleData, result, candidate) => buildNightmareStarReplayInput(
                    context,
                    battleData,
                    result,
                    candidate,
                    innerCache && innerCache.inputData ? innerCache.inputData : null,
                ));
            },
        },
        nightmare: {
            key: 'nightmare',
            label: MODE_LABELS.nightmare,
            getContext() {
                const nightmareModule = Runtime.getModuleByTypeKey('NIGHTMARE');
                const roomInfo = Utils.safeCall(() => nightmareModule.roomData.roomInfo, null);
                const cache = state.modeCaches.nightmare;
                const currentMonsterCfgId = roomInfo
                    ? (roomInfo.curMonsterCfgId || roomInfo.lastMonsterId || null)
                    : null;
                const bossMeta = getNightmareBossMetaByMonsterCfgId(currentMonsterCfgId)
                    || getNightmareBossMetaByBossId(Utils.safeCall(() => cache.context.bossId, null));
                const previewInfo = getNightmarePreviewInfo({
                    bossId: Utils.safeCall(() => roomInfo.bossCfgId, null)
                        || Utils.safeCall(() => roomInfo.bossId, null)
                        || (bossMeta ? bossMeta.bossId : null)
                        || Utils.safeCall(() => cache.context.bossId, null),
                    monsterCfgId: currentMonsterCfgId,
                }, Utils.safeCall(() => cache.context.monster, null));
                return applyManualContextOverrides('nightmare', {
                    roomId: roomInfo ? roomInfo.roomId : Utils.safeCall(() => cache.context.roomId, null),
                    monsterCfgId: currentMonsterCfgId,
                    bossId: Utils.safeCall(() => roomInfo.bossCfgId, null)
                        || Utils.safeCall(() => roomInfo.bossId, null)
                        || (bossMeta ? bossMeta.bossId : null)
                        || Utils.safeCall(() => cache.context.bossId, null),
                    hallNumber: bossMeta ? bossMeta.hallNumber : Utils.safeCall(() => cache.context.hallNumber, null),
                    bossName: bossMeta ? bossMeta.displayName : '',
                    monster: previewInfo.monsters.length
                        ? previewInfo.monsters.map((item) => [item.monsterId, item.index, item.level])
                        : Utils.safeCall(() => cache.context.monster, null),
                    roleId: Utils.safeCall(() => cache.context.roleId, null),
                });
            },
            getScore() {
                let score = 0;
                const context = this.getContext();
                const previewInfo = getNightmarePreviewInfo(context, context.monster);
                if (context.bossId != null && canUsePreviewSkeleton() && previewInfo.monsters.length) {
                    score += 120;
                }
                if (state.modeCaches.nightmare && state.modeCaches.nightmare.capturedAt) {
                    score += 90;
                }
                if (context.bossId != null) {
                    score += 20;
                }
                return score;
            },
            capabilities() {
                const context = this.getContext();
                const previewInfo = getNightmarePreviewInfo(context, context.monster);
                if (context.bossId != null && canUsePreviewSkeleton() && previewInfo.monsters.length) {
                    return CAPABILITY.PREVIEW;
                }
                const cache = state.modeCaches.nightmare;
                if (cache && cache.battleData) {
                    return CAPABILITY.HYBRID;
                }
                if (cache && cache.inputData) {
                    return CAPABILITY.REPLAY;
                }
                return CAPABILITY.NONE;
            },
            async ensureAuthorityData() {
                const context = this.getContext();
                const previewInfo = getNightmarePreviewInfo(context, context.monster);
                if (context.bossId != null && canUsePreviewSkeleton() && previewInfo.monsters.length) {
                    return;
                }
                if (state.modeCaches.nightmare && state.modeCaches.nightmare.battleData) {
                    return;
                }
                throw new Error('十殿试炼还没有权威 battleData。请先进入目标试炼并真实开一次战斗。');
            },
            buildDraft() {
                const cache = state.modeCaches.nightmare;
                const context = this.getContext();
                const previewInfo = getNightmarePreviewInfo(context, context.monster);
                if (context.bossId != null && previewInfo.monsters.length && canUsePreviewSkeleton()) {
                    const baseSkeleton = Runtime.getReusableBattleSkeleton(true);
                    return createPreviewDraft('nightmare', context, CAPABILITY.PREVIEW, (candidate, seed) => createBattleDataFromPreview(
                        baseSkeleton,
                        'nightmare',
                        context,
                        candidate,
                        seed,
                        previewInfo.monsters,
                    ), (result, battleData) => buildNightmareReplayInput(
                        context,
                        battleData,
                        result,
                        cache && cache.inputData ? cache.inputData : null,
                    ));
                }
                if (!cache || !cache.battleData) {
                    throw new Error('十殿试炼当前没有可用 battleData');
                }
                return createAuthorityDraft('nightmare', context, this.capabilities(), cache, (innerCache, battleData, result) => buildNightmareReplayInput(
                    context,
                    battleData,
                    result,
                    innerCache && innerCache.inputData ? innerCache.inputData : null,
                ));
            },
        },
        capture: {
            key: 'capture',
            label: MODE_LABELS.capture,
            getContext() {
                return applyManualContextOverrides('capture', {
                    source: state.latestCapture ? state.latestCapture.source : '暂无',
                    modeKey: state.latestCapture ? state.latestCapture.modeKey : '',
                });
            },
            getScore() {
                if (state.latestCapture && state.latestCapture.input && !isPvpBattleInput(state.latestCapture.input)) {
                    return 60;
                }
                return 0;
            },
            capabilities() {
                if (state.latestCapture && state.latestCapture.input) {
                    return CAPABILITY.REPLAY;
                }
                return CAPABILITY.NONE;
            },
            async ensureAuthorityData() {
                if (!state.latestCapture || !state.latestCapture.input) {
                    throw new Error('当前没有最近捕获战斗');
                }
            },
            buildDraft() {
                if (!state.latestCapture || !state.latestCapture.input) {
                    throw new Error('当前没有最近捕获战斗');
                }
                const input = state.latestCapture.input;
                return {
                    mode: state.latestCapture.modeKey || 'capture',
                    label: MODE_LABELS.capture,
                    context: this.getContext(),
                    capability: this.capabilities(),
                    notes: [],
                    buildBattleData(candidate, seed) {
                        const battleData = Utils.deepClone(input.battleData);
                        battleData.id = Date.now() + seed;
                        battleData.randomSeed = seed;
                        applyCandidateToBattleData(battleData, candidate);
                        return battleData;
                    },
                    buildReplayInput(result, battleData) {
                        return buildReplayInputFromBase(input, battleData, result);
                    },
                };
            },
        },
    };

    Adapters.nightmare.ensureAuthorityData = async function ensureNightmareAuthorityData() {
        const context = this.getContext();
        const previewInfo = getNightmarePreviewInfo(context, context.monster);
        if (context.bossId != null && canUsePreviewSkeleton() && previewInfo.monsters.length) {
            return;
        }
        if (state.modeCaches.nightmare && state.modeCaches.nightmare.battleData) {
            return;
        }
        if (context.bossId != null && previewInfo.monsters.length) {
            throw new Error('十殿试炼目标已识别，但当前没有可复用的战斗骨架。请先切到主线或任意非 PVP 战斗页面，再回来模拟。');
        }
        throw new Error('十殿试炼当前既没有可复用骨架，也没有已抓到的权威 battleData。');
    };

    const AdapterList = [
        Adapters.evoTower,
        Adapters.tower,
        Adapters.genie,
        Adapters.legionBoss,
        Adapters.nightmareStar,
        Adapters.nightmare,
        Adapters.capture,
    ];

    function getAutoDetectedAdapter() {
        const ranked = AdapterList
            .map((adapter) => ({
                adapter,
                score: Utils.safeCall(() => adapter.getScore(), 0),
            }))
            .filter((item) => item.score > 0)
            .sort((left, right) => right.score - left.score);
        return ranked.length ? ranked[0].adapter : null;
    }

    function getActiveAdapter() {
        const manualKey = getManualAdapterKey();
        if (manualKey) {
            return Adapters[manualKey] || null;
        }
        return getAutoDetectedAdapter();
    }

    function legacy_syncSelectionFromCurrent() {
        const adapter = getAutoDetectedAdapter();
        if (!adapter) {
            throw new Error('当前页面没有可识别的非PVP玩法');
        }
        const context = adapter.getContext();
        let choice = adapter.key;
        let targetValue = '';
        if (adapter.key === 'tower' && context.stageId != null) {
            targetValue = `${context.stageId}`;
        } else if (adapter.key === 'evoTower' && context.towerId != null) {
            targetValue = `${context.towerId}`;
        } else if (adapter.key === 'nightmareStar' && context.bossId != null) {
            targetValue = `${context.bossId}`;
        } else if (adapter.key === 'nightmare' && context.bossId != null) {
            targetValue = `${context.bossId}`;
        } else if (adapter.key === 'legionBoss' && context.legionBossId != null) {
            targetValue = `${context.legionBossId}`;
        } else if (adapter.key === 'genie' && (context.genieLevelId != null || context.genieId != null)) {
            const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
            const shenhaiClubId = Configs && Configs.Club ? Configs.Club.SHENHAI : null;
            if (shenhaiClubId != null && context.clubId === shenhaiClubId) {
                choice = 'genieShenhai';
            }
            targetValue = `${context.genieLevelId != null ? context.genieLevelId : context.genieId}`;
        }
        const quickValue = resolveQuickTargetValue(choice, targetValue);
        if (quickValue) {
            targetValue = quickValue;
        }
        state.panelPrefs.modeChoice = choice;
        state.panelPrefs.targetValue = targetValue;
        savePanelState();
        renderPanel();
        return { adapter, context };
    }

    function syncSelectionFromCurrent() {
        const adapter = getAutoDetectedAdapter();
        if (!adapter) {
            throw new Error('当前页面没有可识别的非PVP玩法');
        }
        const context = adapter.getContext();
        let choice = adapter.key;
        let targetValue = '';
        if (adapter.key === 'tower' && context.stageId != null) {
            targetValue = formatTowerLikeStageText(context.stageId) || `${context.stageId}`;
        } else if (adapter.key === 'evoTower' && context.towerId != null) {
            targetValue = formatTowerLikeStageText(context.towerId) || `${context.towerId}`;
        } else if (adapter.key === 'nightmareStar' && context.bossId != null) {
            targetValue = `${context.bossId}`;
        } else if (adapter.key === 'nightmare' && context.bossId != null) {
            targetValue = `${context.bossId}`;
        } else if (adapter.key === 'genie' && (context.genieLevelId != null || context.genieId != null)) {
            const Configs = Utils.safeCall(() => Runtime.getConfigs(), null);
            const shenhaiClubId = Configs && Configs.Club ? Configs.Club.SHENHAI : null;
            if (shenhaiClubId != null && context.clubId === shenhaiClubId) {
                choice = 'genieShenhai';
            }
            targetValue = `${context.genieLevelId != null ? context.genieLevelId : context.genieId}`;
        }
        const quickValue = resolveQuickTargetValue(choice, targetValue);
        if (quickValue) {
            targetValue = getQuickTargetInputValue(choice, quickValue);
        }
        state.panelPrefs.modeChoice = choice;
        state.panelPrefs.targetValue = targetValue;
        if (isSplitTargetMode(choice)) {
            const splitParts = deriveSplitTargetParts(choice, targetValue);
            state.panelPrefs.targetMajor = splitParts.major;
            state.panelPrefs.targetMinor = splitParts.minor;
        }
        savePanelState();
        renderPanel();
        return { adapter, context };
    }

    async function withJob(title, runner) {
        if (state.activeJob) {
            throw new Error(`已有任务执行中：${state.activeJob.title}`);
        }
        state.stopRequested = false;
        state.activeJob = {
            title,
            startedAt: Utils.now(),
        };
        renderPanel();
        try {
            return await runner();
        } finally {
            state.activeJob = null;
            state.stopRequested = false;
            renderPanel();
        }
    }

    async function evaluateCurrentTeam(sampleCount, title) {
        return withJob(title, async () => {
            const adapter = getActiveAdapter();
            if (!adapter) {
                throw new Error('未识别到当前可模拟的非PVP玩法');
            }
            const context = Utils.safeCall(() => adapter.getContext(), null);
            const candidate = state.activeSwitchedCandidate || captureCurrentTeamSnapshot(context);
            await adapter.ensureAuthorityData();
            const draft = adapter.buildDraft(candidate);
            const seeds = buildSeedList(draft, sampleCount, candidate.signature);
            const report = await evaluateCandidate(adapter, draft, candidate, seeds, title);
            state.lastSingleRun = null;
            state.lastDebugError = null;
            state.lastReport = report;
            state.lastReports = [report];
            resetSeedRecordView(report);
            renderLastReport({
                title: `${draft.label} 单队模拟`,
                text: buildReportSummary(report),
            }, [report]);
            renderPanel();
            return report;
        });
    }

    async function compareCandidates(sampleCount) {
        return withJob(`批量比较 ${sampleCount} 次`, async () => {
            if (!state.candidates.length) {
                throw new Error('请先记录至少一套候选阵容');
            }
            const adapter = getActiveAdapter();
            if (!adapter) {
                throw new Error('未识别到当前可模拟的非PVP玩法');
            }
            await adapter.ensureAuthorityData();
            const referenceDraft = adapter.buildDraft(state.candidates[0]);
            const seeds = buildSeedList(referenceDraft, sampleCount, 'batch');
            const reports = [];
            for (let i = 0; i < state.candidates.length; i += 1) {
                if (state.stopRequested) {
                    break;
                }
                const candidate = state.candidates[i];
                const draft = adapter.buildDraft(candidate);
                const report = await evaluateCandidate(adapter, draft, candidate, seeds, `批量比较 ${i + 1}/${state.candidates.length}`);
                reports.push(report);
            }
            reports.sort(compareReports);
            reports.slice(1).forEach((item) => {
                if (!item) {
                    return;
                }
                item.seedRecords = [];
                item.replayBundle = null;
            });
            state.lastSingleRun = null;
            state.lastDebugError = null;
            state.lastReports = reports;
            state.lastReport = reports[0] || null;
            resetSeedRecordView(state.lastReport || null);
            if (state.lastReport) {
                renderLastReport({
                    title: `${referenceDraft.label} 批量比较完成`,
                    text: reports.slice(0, 5).map((item, index) => `${index + 1}. ${buildReportSummary(item)}`).join('\n'),
                }, reports.slice(0, 5));
            }
            renderPanel();
            return reports;
        });
    }

    async function replayLatest() {
        if (state.replayBusy) {
            Utils.pushDataSource('回放正在进行中，忽略重复点击');
            return;
        }
        state.replayBusy = true;
        setTimeout(function () { state.replayBusy = false; }, 5000);
        await _replayLatestInner();
    }

    async function _replayLatestInner() {
        const input = state.lastSingleRun && state.lastSingleRun.replayInput
            ? state.lastSingleRun.replayInput
            : state.lastReport && state.lastReport.replayInput
                ? state.lastReport.replayInput
                : state.latestCapture && state.latestCapture.input
                    ? state.latestCapture.input
                    : null;
        if (!input) {
            throw new Error('当前没有可回放的数据');
        }
        const battleUIManager = Runtime.getBattleUIManager();
        if (!battleUIManager) {
            throw new Error('BattleUIManager 不可用');
        }
        const modeKey = resolveModeKeyFromBattleData(
            input && input.battleData ? input.battleData : null,
            input,
        );
        const replayResult = input && input.battleResult
            ? input.battleResult
            : extractBattleResultFromInput(input);
        const replayContext = resolveReplayLaunchContext(modeKey, input);
        const nightmareContext = modeKey === 'nightmare'
            ? replayContext
            : resolveReplayLaunchContext('nightmare', input);
        if (modeKey === 'nightmare') {
            Utils.pushDataSource(`nightmare replay resolved context boss=${getNumericFieldValue(nightmareContext || {}, ['bossId'], null)} hall=${getNumericFieldValue(nightmareContext || {}, ['hallNumber'], null)} monster=${getNumericFieldValue(nightmareContext || {}, ['monsterCfgId'], null)}`);
        }
        const replayInput = modeKey === 'nightmare'
            ? buildNightmareReplayInput(
                nightmareContext,
                input && input.battleData ? input.battleData : null,
                replayResult,
                input,
            )
            : buildLooseReplayInput(
                input && input.battleData ? input.battleData : null,
                replayResult,
                modeKey,
                input,
            );
        const preferReplayUI = shouldPreferReplayUI(modeKey, replayInput);
        if (modeKey === 'nightmare') {
            await ensureNightmareReplayScene(nightmareContext, replayInput);
        }
        const backdropContext = modeKey === 'nightmare' ? nightmareContext : replayContext;
        await ensurePlaybackBackdrop(
            replayInput || input,
            modeKey,
            backdropContext,
            `replay:${modeKey || 'capture'}`,
        );
        if (!preferReplayUI && typeof battleUIManager.SHOW_BATTLE_UI === 'function' && replayInput && replayInput.battleData && replayInput.battleResult) {
            Utils.pushDataSource('使用 SHOW_BATTLE_UI 播放最近一次战斗，以保留原生结算返回');
            hidePlaybackBattleVisible(`SHOW_BATTLE_UI:${modeKey || 'capture'}`);
            armPlaybackRestoreTimer(`SHOW_BATTLE_UI:${modeKey || 'capture'}`);
            battleUIManager.SHOW_BATTLE_UI(
                prepareReplayInputForLaunch(replayInput, modeKey, false),
            );
            return;
        }
        if (typeof battleUIManager.SHOW_BATTLE_REPLAY_UI !== 'function') {
            throw new Error('BattleUIManager.SHOW_BATTLE_REPLAY_UI 不可用');
        }
        Utils.pushDataSource('使用 SHOW_BATTLE_REPLAY_UI 播放最近一次战斗');
        hidePlaybackBattleVisible(`SHOW_BATTLE_REPLAY_UI:${modeKey || 'capture'}`);
        armPlaybackRestoreTimer(`SHOW_BATTLE_REPLAY_UI:${modeKey || 'capture'}`);
        battleUIManager.SHOW_BATTLE_REPLAY_UI(
            prepareReplayInputForLaunch(replayInput || Utils.deepClone(input), modeKey, true),
        );
    }

    function showDataSources() {
        const lines = [];
        lines.push(`脚本: ${SCRIPT_NAME} v${SCRIPT_VERSION}`);
        lines.push(`最近捕获: ${state.latestCapture ? `${state.latestCapture.source} / ${state.latestCapture.modeKey} / ${Utils.formatTime(state.latestCapture.capturedAt)}` : '无'}`);
        lines.push(`单次调试: ${state.lastSingleRun ? `${state.lastSingleRun.label} / seed ${state.lastSingleRun.seed} / ${Utils.formatTime(state.lastSingleRun.capturedAt)}` : '无'}`);
        if (state.lastDebugError) {
            lines.push(`最近调试异常: ${state.lastDebugError.label} / seed ${state.lastDebugError.seed} / ${state.lastDebugError.errorMessage}`);
        }
        lines.push(`诊断样本: ${state.diagnosticSamples.length}`);
        if (state.diagnosticSamples.length) {
            lines.push(`最近诊断: ${buildDiagnosticHeadline(state.diagnosticSamples[0])}`);
        }
        ['tower', 'genie', 'evoTower', 'legionBoss', 'nightmareStar', 'nightmare'].forEach((key) => {
            const cache = state.modeCaches[key];
            lines.push(`${MODE_LABELS[key]}: ${cache ? `有缓存 / ${Utils.formatTime(cache.capturedAt)}` : '无缓存'}`);
        });
        lines.push('');
        lines.push('最近数据来源:');
        if (state.dataSourceLines.length) {
            lines.push(...state.dataSourceLines);
        } else {
            lines.push('暂无');
        }
        alert(lines.join('\n'));
    }

    function injectStyle() {
        if (document.getElementById('non-pvp-sim-style')) {
            return;
        }
        const style = document.createElement('style');
        style.id = 'non-pvp-sim-style';
        style.textContent = `
            #non-pvp-sim-panel {
                position: fixed;
                left: 18px;
                bottom: 18px;
                z-index: 999999;
                width: 410px;
                color: #1e293b;
                background: #ffffff;
                border: 1px solid rgba(0, 0, 0, 0.1);
                border-radius: 16px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
                font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
                overflow: hidden;
                transition: width 0.2s ease, height 0.2s ease, border-radius 0.2s ease, box-shadow 0.2s ease;
            }
            #non-pvp-sim-panel * {
                box-sizing: border-box;
            }
            #non-pvp-sim-panel .sim-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                border-bottom: 1px solid rgba(0, 0, 0, 0.1);
                background: rgba(255, 255, 255, 0.7);
                backdrop-filter: saturate(1.2);
                border-radius: 12px 12px 0 0;
                cursor: grab;
                user-select: none;
                touch-action: none;
            }
            #non-pvp-sim-panel .sim-brand {
                display: flex;
                align-items: center;
                gap: 12px;
                min-width: 0;
            }
            #non-pvp-sim-panel .sim-brand-mark {
                display: none;
            }
            #non-pvp-sim-panel .sim-brand-copy {
                min-width: 0;
            }
            #non-pvp-sim-panel .sim-title {
                font-weight: 700;
                font-size: 15px;
                color: #1e293b;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #non-pvp-sim-panel .sim-version {
                margin-top: 2px;
            }
            #non-pvp-sim-panel .sim-collapse-btn {
                background: transparent;
                border: none;
                border-radius: 8px;
                padding: 2px 8px;
                font-size: 14px;
                cursor: pointer;
                color: #718096;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
                box-shadow: none;
            }
            #non-pvp-sim-panel .sim-collapse-btn:hover {
                background: #f7fafc;
                border-color: #e53e3e;
                color: #e53e3e;
            }
            #non-pvp-sim-panel .sim-collapse-badge {
                display: none;
            }
            #non-pvp-sim-panel .sim-collapse-badge::before {
                content: "";
                position: absolute;
                inset: 2px;
                border-radius: inherit;
                background:
                    radial-gradient(circle at 30% 28%, rgba(179, 255, 235, 0.95), rgba(74, 179, 160, 0.92) 45%, rgba(16, 72, 68, 0.98) 100%);
                border: 1px solid rgba(255, 249, 218, 0.24);
            }
            #non-pvp-sim-panel .sim-collapse-badge::after {
                content: "";
                position: absolute;
                left: 4px;
                right: 4px;
                top: 3px;
                height: 32%;
                border-radius: 999px;
                background: linear-gradient(180deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.04));
                filter: blur(0.2px);
            }
            #non-pvp-sim-panel .sim-collapse-glyph {
                position: relative;
                z-index: 2;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                font-weight: 900;
                letter-spacing: 0;
                color: #fff2bd;
                text-shadow:
                    0 1px 0 rgba(89, 61, 18, 0.85),
                    0 0 6px rgba(255, 236, 180, 0.16);
                transform: translateY(-0.5px);
            }
            #non-pvp-sim-panel .sim-collapse-text {
                font-size: 12px;
                font-weight: 700;
                color: #1e293b;
            }
            #non-pvp-sim-panel .sim-body {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 12px 14px 14px;
                overflow: auto;
                max-height: calc(var(--panel-max-height) - 74px);
                overscroll-behavior: contain;
            }
            #non-pvp-sim-panel .sim-manual,
            #non-pvp-sim-panel .sim-grid,
            #non-pvp-sim-panel .sim-section {
                padding: 10px;
                border-radius: 12px;
                background: #ffffff;
                border: 1px solid rgba(0,0,0,0.06);
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                margin-bottom: 0;
            }
            #non-pvp-sim-panel .sim-grid {
                grid-template-columns: 86px minmax(0, 1fr);
            }
            #non-pvp-sim-panel .sim-mainpush-card {
                padding: 11px 12px;
                border-radius: 16px;
                background: #ffffff;
            }
            #non-pvp-sim-panel .sim-toolbar {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 8px;
                align-items: stretch;
            }
            #non-pvp-sim-panel .sim-sample-box {
                display: flex;
                align-items: center;
                gap: 10px;
                min-width: 0;
                padding: 8px 10px;
                border-radius: 12px;
                border: 1px solid #e2e8f0;
                background: #ffffff;
            }
            #non-pvp-sim-panel .sim-sample-label {
                flex: 0 0 auto;
                font-size: 11px;
                color: #718096;
                font-weight: 700;
            }
            #non-pvp-sim-panel .sim-sample-box input {
                flex: 1;
                min-width: 0;
                min-height: 22px;
                padding: 0;
                border: none;
                background: transparent;
                text-align: right;
                font-size: 13px;
                font-weight: 700;
                color: #d97706;
            }
            #non-pvp-sim-panel .sim-sample-box input:focus {
                outline: none;
            }
            #non-pvp-sim-panel .sim-debug-toggle {
                display: inline-flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                min-width: 118px;
                padding: 8px 12px;
                border-radius: 8px;
                background: #ffffff;
                border: 1px solid #e2e8f0;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }
            #non-pvp-sim-panel .sim-debug-toggle small {
                font-size: 11px;
                color: #d97706;
                font-weight: 700;
            }
            #non-pvp-sim-panel .sim-actions {
                grid-template-columns: repeat(2, minmax(0, 1fr));
                margin-bottom: 0;
            }
            
            #non-pvp-sim-panel .sim-debug-wrap {
                display: none;
            }
            #non-pvp-sim-panel.debug-open .sim-debug-wrap {
                display: block;
            }
            #non-pvp-sim-panel .sim-debug-actions {
                padding: 10px;
                border-radius: 14px;
                background: #ffffff;
                border: 1px solid #e2e8f0;
            }
            #non-pvp-sim-panel .sim-section {
                margin-top: 0;
                border-top: none;
                padding-top: 10px;
            }
            #non-pvp-sim-panel .sim-section-title {
                margin-bottom: 10px;
                color: #1e293b;
                letter-spacing: 0.04em;
            }
            #non-pvp-sim-panel .sim-candidate-list {
                max-height: min(21vh, 176px);
            }
            #non-pvp-sim-panel .sim-report {
                max-height: min(24vh, 220px);
                overflow: auto;
                border: 1px solid #e2e8f0;
                background: #ffffff;
            }
            #non-pvp-sim-panel.collapsed {
                display: none !important;
            }
            #non-pvp-sim-panel.collapsed .sim-head {
                min-height: var(--collapsed-size);
            }
            #non-pvp-sim-panel.collapsed .sim-brand {
                display: none;
            }
            #non-pvp-sim-panel.collapsed .sim-head-actions {
                width: 100%;
                height: 100%;
                justify-content: center;
            }
            #non-pvp-sim-panel.collapsed .sim-collapse-btn {
                width: var(--collapsed-size);
                min-width: var(--collapsed-size);
                height: var(--collapsed-size);
                min-height: var(--collapsed-size);
                padding: 0;
                border: none;
                border-radius: 24px;
                background: transparent;
                box-shadow: none;
                justify-content: center;
                cursor: grab;
            }
            #non-pvp-sim-panel.collapsed .sim-collapse-badge {
                width: var(--collapsed-core-size);
                height: var(--collapsed-core-size);
                box-shadow:
                    0 6px 14px rgba(0, 0, 0, 0.1),
                    inset 0 1px 0 rgba(255, 255, 255, 0.2),
                    0 0 0 1px rgba(203, 213, 225, 0.3);
                background:
                    linear-gradient(180deg, rgba(221, 193, 118, 0.98), rgba(129, 94, 45, 0.98));
            }
            #non-pvp-sim-panel.collapsed .sim-collapse-badge::before {
                inset: 3px;
                border-color: rgba(255, 250, 222, 0.24);
            }
            #non-pvp-sim-panel.collapsed .sim-collapse-glyph {
                font-size: max(12px, calc(var(--collapsed-core-size) * 0.34));
            }
            #non-pvp-sim-panel.collapsed .sim-collapse-text {
                display: none;
            }
            #non-pvp-sim-panel.dragging,
            #non-pvp-sim-panel.dragging * {
                cursor: grabbing !important;
            }
            #non-pvp-sim-panel.dragging {
                transition: none !important;
                box-shadow: 0 12px 28px rgba(0, 0, 0, 0.1);
            }
            #non-pvp-sim-panel .sim-debug-toggle,
            #non-pvp-sim-panel button[data-action="debugOnce"] {
                display: none !important;
            }
    
            @media (max-width: 520px) {
                #non-pvp-sim-panel {
                    left: 10px;
                    top: 10px;
                    --panel-max-width: calc(100vw - 20px);
                    --panel-max-height: calc(100vh - 20px);
                }
                #non-pvp-sim-panel .sim-toolbar,
                #non-pvp-sim-panel .sim-manual,
                #non-pvp-sim-panel .sim-actions {
                    grid-template-columns: 1fr;
                }
                #non-pvp-sim-panel .sim-grid {
                    grid-template-columns: 78px minmax(0, 1fr);
                }
                #non-pvp-sim-panel .sim-mainpush-metrics {
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                }
                #non-pvp-sim-panel .sim-split-target {
                    grid-template-columns: minmax(0, 1fr) 14px minmax(0, 1fr);
                }
            }
        `;
        document.head.appendChild(style);
    }

    function syncPanelViewportBounds() {
        if (!state.panel || !state.panel.root) {
            return;
        }
        const margin = window.innerWidth <= 520 ? 10 : 14;
        const responsiveWidth = Math.max(260, window.innerWidth - margin * 2);
        const maxWidth = responsiveWidth;
        const maxHeight = Math.max(72, window.innerHeight - margin * 2);
        const collapsedSize = Math.max(48, Math.min(62, Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.09)));
        const collapsedCoreSize = Math.max(30, Math.round(collapsedSize * 0.64));
        state.panel.root.style.setProperty('--panel-max-width', `${maxWidth}px`);
        state.panel.root.style.setProperty('--panel-max-height', `${maxHeight}px`);
        state.panel.root.style.setProperty('--collapsed-size', `${collapsedSize}px`);
        state.panel.root.style.setProperty('--collapsed-core-size', `${collapsedCoreSize}px`);
        state.panel.root.style.width = `${maxWidth}px`;
        state.panel.root.style.maxWidth = `${maxWidth}px`;
    }

    function normalizePanelPosition(x, y) {
        if (!state.panel || !state.panel.root) {
            return { x: 14, y: 14 };
        }
        const margin = window.innerWidth <= 520 ? 10 : 14;
        const rect = state.panel.root.getBoundingClientRect();
        const width = Math.max(48, Math.round(rect.width || state.panel.root.offsetWidth || 0));
        const height = Math.max(48, Math.round(rect.height || state.panel.root.offsetHeight || 0));
        const minX = margin;
        const minY = margin;
        const maxX = Math.max(minX, window.innerWidth - width - margin);
        const maxY = Math.max(minY, window.innerHeight - height - margin);
        const fallbackY = Math.max(minY, window.innerHeight - height - margin);
        const nextX = Number.isFinite(Number(x)) ? Number(x) : minX;
        const nextY = Number.isFinite(Number(y)) ? Number(y) : fallbackY;
        return {
            x: Math.min(maxX, Math.max(minX, Math.round(nextX))),
            y: Math.min(maxY, Math.max(minY, Math.round(nextY))),
        };
    }

    function applyPanelPosition(shouldPersist = false) {
        if (!state.panel || !state.panel.root) {
            return;
        }
        const normalized = normalizePanelPosition(state.panelPrefs.panelX, state.panelPrefs.panelY);
        state.panel.root.style.left = `${normalized.x}px`;
        state.panel.root.style.top = `${normalized.y}px`;
        state.panel.root.style.right = 'auto';
        state.panel.root.style.bottom = 'auto';
        const changed = Number(state.panelPrefs.panelX) !== normalized.x || Number(state.panelPrefs.panelY) !== normalized.y;
        state.panelPrefs.panelX = normalized.x;
        state.panelPrefs.panelY = normalized.y;
        if ((shouldPersist || changed) && !state.panelDragState) {
            savePanelState();
        }
    }

    function togglePanelCollapsed() {
        state.panelPrefs.collapsed = !state.panelPrefs.collapsed;
        savePanelState();
        renderPanel();
    }

    function finishPanelDrag(pointerId = null) {
        const dragState = state.panelDragState;
        if (!dragState) {
            return;
        }
        if (pointerId != null && dragState.pointerId !== pointerId) {
            return;
        }
        if (dragState.handle && typeof dragState.handle.releasePointerCapture === 'function') {
            Utils.safeCall(() => dragState.handle.releasePointerCapture(dragState.pointerId), null);
        }
        state.panel.root.classList.remove('dragging');
        const shouldToggleCollapsed = !dragState.moved;
        if (dragState.moved) {
            applyPanelPosition(true);
        }
        state.panelDragState = null;
        if (shouldToggleCollapsed) {
            togglePanelCollapsed();
        }
    }

    function startPanelDrag(event) {
        if (!state.panel || !state.panel.root || event.button !== 0) {
            return;
        }
        const handle = event.currentTarget;
        const normalized = normalizePanelPosition(state.panelPrefs.panelX, state.panelPrefs.panelY);
        state.panelDragState = {
            pointerId: event.pointerId,
            handle,
            startClientX: event.clientX,
            startClientY: event.clientY,
            originX: normalized.x,
            originY: normalized.y,
            moved: false,
        };
        state.panel.root.classList.add('dragging');
        if (handle && typeof handle.setPointerCapture === 'function') {
            Utils.safeCall(() => handle.setPointerCapture(event.pointerId), null);
        }
    }

    function movePanelDrag(event) {
        const dragState = state.panelDragState;
        if (!dragState || dragState.pointerId !== event.pointerId || !state.panel || !state.panel.root) {
            return;
        }
        const deltaX = event.clientX - dragState.startClientX;
        const deltaY = event.clientY - dragState.startClientY;
        if (!dragState.moved && (Math.abs(deltaX) >= 4 || Math.abs(deltaY) >= 4)) {
            dragState.moved = true;
        }
        const normalized = normalizePanelPosition(dragState.originX + deltaX, dragState.originY + deltaY);
        state.panelPrefs.panelX = normalized.x;
        state.panelPrefs.panelY = normalized.y;
        state.panel.root.style.left = `${normalized.x}px`;
        state.panel.root.style.top = `${normalized.y}px`;
        state.panel.root.style.right = 'auto';
        state.panel.root.style.bottom = 'auto';
    }

    function installPanelDrag(handle) {
        if (!handle || handle.__nonPvpDragInstalled) {
            return;
        }
        handle.addEventListener('pointerdown', startPanelDrag);
        handle.addEventListener('pointermove', movePanelDrag);
        handle.addEventListener('pointerup', (event) => finishPanelDrag(event.pointerId));
        handle.addEventListener('pointercancel', (event) => finishPanelDrag(event.pointerId));
        handle.__nonPvpDragInstalled = true;
    }

    // ========== 游戏主界面内嵌按钮 ==========

    /**
     * 在MainPanel注入FairyGUI原生"模拟"按钮以供游戏内唤出辅助面板
     */
    function injectMainPanelButton() {
        let checkCount = 0;
        const maxChecks = 120;
        const injectionInterval = setInterval(() => {
            checkCount++;
            if (checkCount >= maxChecks) {
                clearInterval(injectionInterval);
                return;
            }
            if (typeof window.__require !== 'function' || typeof fgui !== 'object') {
                return;
            }
            try {
                const MainPanel = window.__require('MainPanel');
                if (MainPanel && MainPanel.MainPanel) {
                    const originalOnShow = MainPanel.MainPanel.prototype.onShow;
                    const originalOnHide = MainPanel.MainPanel.prototype.onHide;

                    MainPanel.MainPanel.prototype.onShow = function (...args) {
                        originalOnShow.apply(this, args);
                        if (!this._simEmbedBtn) {
                            try {
                                const btn = fgui.UIPackage.createObject('ui_common', 'BtnInfo2');
                                if (!btn) return;
                                btn.title = '';
                                btn.icon = '';

                                // 隐藏原有图标
                                if (btn.numChildren > 0) {
                                    for (let i = 0; i < btn.numChildren; i++) {
                                        const child = btn.getChildAt(i);
                                        if (child && child.name === 'n0') {
                                            child.visible = false;
                                        }
                                    }
                                }

                                const textField = new fgui.GTextField();
                                textField.name = 'customLabel';
                                textField.text = '模拟';
                                textField.fontSize = 28;
                                textField.bold = true;
                                textField.color = '#FFFFFF';
                                textField.singleLine = true;
                                if (typeof cc !== 'undefined') {
                                    textField.shadowOffset = new cc.Vec2(0, 2);
                                    textField.shadowColor = new cc.Color(122, 69, 48, 200);
                                }

                                const textX = (btn.width - textField.width) / 2;
                                const textY = (btn.height - textField.height) / 2;
                                textField.setPosition(textX, textY);
                                textField.visible = true;
                                textField.touchable = false;
                                btn.addChild(textField);
                                btn.onClick(() => {
                                    if (typeof togglePanelCollapsed === 'function') {
                                        togglePanelCollapsed();
                                    }
                                });

                                // 定位在右上角
                                const paddingX = btn.width + 10;
                                const paddingY = 20;
                                btn.setPosition(this.ui.width - btn.width - paddingX, paddingY);

                                this.ui.addChild(btn);
                                this._simEmbedBtn = btn;
                            } catch (e) {
                                Utils.warn('内嵌按钮创建失败: ', e);
                            }
                        }
                    };

                    MainPanel.MainPanel.prototype.onHide = function (...args) {
                        if (this._simEmbedBtn) {
                            this._simEmbedBtn.dispose();
                            this._simEmbedBtn = null;
                        }
                        originalOnHide.apply(this, args);
                    };

                    clearInterval(injectionInterval);
                    Utils.log('【模拟】主界面内嵌接管成功');
                }
            } catch (error) {
            }
        }, 800);
    }

    function createPanel() {
        const requiredRefs = [
            'mainPushCard',
            'mainPushLamp',
            'mainPushStateLabel',
            'mainPushStateDesc',
            'mainPushLevel',
            'mainPushBoss',
            'mainPushRound',
            'mainPushReset',
            'mainPushTag',
            'mainPushBtn',
        ];
        const hasAllRequiredRefs = (refs) => requiredRefs.every((key) => refs && refs[key]);
        if (state.panel && state.panel.root && document.body.contains(state.panel.root)) {
            if (hasAllRequiredRefs(state.panel.refs)) {
                return;
            }
            state.panel.root.remove();
            state.panel = null;
        }
        const existingRoot = document.getElementById('non-pvp-sim-panel');
        if (existingRoot) {
            const existingRefs = {};
            existingRoot.querySelectorAll('[data-ref]').forEach((node) => {
                existingRefs[node.dataset.ref] = node;
            });
            if (!hasAllRequiredRefs(existingRefs)) {
                existingRoot.remove();
            } else if (!state.panel) {
                state.panel = {
                    root: existingRoot,
                    refs: existingRefs,
                };
                return;
            }
        }
        injectStyle();
        const root = document.createElement('div');
        root.id = 'non-pvp-sim-panel';
        root.innerHTML = `
            <div class="sim-head" data-ref="head">
                <div class="sim-brand" data-ref="dragHandle">
                    <div class="sim-brand-mark">SIM</div>
                    <div class="sim-brand-copy">
                        <div class="sim-title">${SCRIPT_NAME}</div>
                        <div class="sim-version">v${SCRIPT_VERSION}</div>
                    </div>
                </div>
                <div class="sim-head-actions">
                    <button data-ref="collapseBtn" class="sim-collapse-btn" type="button">
                        <span data-ref="collapseBadge" class="sim-collapse-badge"><span class="sim-collapse-glyph">战</span></span>
                        <span data-ref="collapseLabel" class="sim-collapse-text">收起</span>
                    </button>
                </div>
            </div>
            <div class="sim-body">
                <div class="sim-pvp-hint" data-ref="pvpHint">当前是玩家战斗场景，已隐藏模拟入口。</div>
                <div class="sim-manual" data-ref="manualBlock">
                    <select data-ref="modeSelect">
                        <option value="auto">自动识别</option>
                        <option value="tower">咸将塔</option>
                        <option value="evoTower">怪异塔</option>
                        <option value="genie">灯神</option>
                        <option value="genieShenhai">深海灯神</option>
                        <option value="legionBoss">俱乐部Boss</option>
                        <option value="nightmare">十殿试炼</option>
                        <option value="nightmareStar">星级挑战</option>
                        <option value="capture">最近捕获</option>
                    </select>
                    <div data-ref="splitTargetWrap" class="sim-split-target">
                        <input data-ref="targetMajorInput" type="text" inputmode="numeric" placeholder="前段">
                        <div class="sim-split-sep">-</div>
                        <input data-ref="targetMinorInput" type="text" inputmode="numeric" placeholder="后段">
                    </div>
                    <input data-ref="targetInput" type="text" placeholder="目标层数 / bossId / genieId">
                    <select data-ref="quickTargetSelect" class="sim-quick-target"></select>
                    <div class="sim-manual-hint" data-ref="targetHint">手动选择玩法和目标后直接评估即可</div>
                </div>
                <div class="sim-grid">
                    <div class="label">当前玩法</div><div class="value" data-ref="mode">-</div>
                    <div class="label">当前目标</div><div class="value" data-ref="context">-</div>
                    <div class="label">能力等级</div><div class="value" data-ref="capability">-</div>
                    <div class="label">当前阵容签名</div><div class="value" data-ref="signature">-</div>
                    <div class="label">候选阵容数量</div><div class="value" data-ref="candidateCount">0</div>
                    <div class="label">诊断样本</div><div class="value" data-ref="diagCount">0</div>
                    <div class="label">当前任务</div><div class="value" data-ref="job">空闲</div>
                </div>
                <div class="sim-mainpush-card" data-ref="mainPushCard">
                    <div class="sim-mainpush-top">
                        <div class="sim-mainpush-state">
                            <span class="sim-mainpush-lamp" data-ref="mainPushLamp" data-tone="idle"></span>
                            <div class="sim-mainpush-state-copy">
                                <div class="sim-mainpush-state-label" data-ref="mainPushStateLabel">已停止</div>
                                <div class="sim-mainpush-state-desc" data-ref="mainPushStateDesc">未启动</div>
                            </div>
                        </div>
                        <div class="sim-mainpush-tag" data-ref="mainPushTag">主线推关</div>
                    </div>
                    <div class="sim-mainpush-metrics">
                        <div class="sim-mainpush-metric">
                            <div class="sim-mainpush-metric-label">当前关卡</div>
                            <div class="sim-mainpush-metric-value" data-ref="mainPushLevel">-</div>
                        </div>
                        <div class="sim-mainpush-metric">
                            <div class="sim-mainpush-metric-label">当前 Boss</div>
                            <div class="sim-mainpush-metric-value" data-ref="mainPushBoss">-</div>
                        </div>
                        <div class="sim-mainpush-metric">
                            <div class="sim-mainpush-metric-label">当前轮次</div>
                            <div class="sim-mainpush-metric-value" data-ref="mainPushRound">-</div>
                        </div>
                        <div class="sim-mainpush-metric">
                            <div class="sim-mainpush-metric-label">重置次数</div>
                            <div class="sim-mainpush-metric-value" data-ref="mainPushReset">0</div>
                        </div>
                    </div>
                </div>
                <div class="sim-toolbar" data-ref="toolbar">
                    <label class="sim-sample-box">
                        <span class="sim-sample-label">模拟次数</span>
                        <input data-ref="sampleCountInput" type="text" inputmode="numeric" placeholder="1000">
                    </label>
                    <button data-ref="debugToggleBtn" class="sim-debug-toggle" type="button">
                        <span>调试工具</span>
                        <small data-ref="debugToggleLabel">展开</small>
                    </button>
                </div>
                <div class="sim-actions sim-primary-actions" data-ref="actions">
                    <button data-action="record">获取当前阵容</button>
                    <button data-action="quick">单队模拟</button>
                    <button data-action="mainPush" data-ref="mainPushBtn">模拟推关</button>
                    <button data-action="debugOnce">单次调试模拟</button>
                    <button data-action="replay">回放最近一次</button>
                    <button data-action="stop">停止当前</button>
                    <button data-action="clear">清空候选</button>
                </div>
                <div class="sim-debug-wrap" data-ref="debugWrap">
                    <div class="sim-actions sim-debug-actions" data-ref="debugActions">
                        <button data-action="sources">查看数据来源</button>
                        <button data-action="diag">查看诊断日志</button>
                        <button data-action="exportDiag">导出诊断日志</button>
                        <button data-action="clearDiag">清空诊断</button>
                    </div>
                </div>
                <div class="sim-section">
                    <div class="sim-section-title">候选阵容</div>
                    <div class="sim-candidate-list" data-ref="candidateList"></div>
                </div>
                <div class="sim-section">
                    <div class="sim-section-title">最近结果</div>
                    <div class="sim-report" data-ref="reportBody">暂无结果</div>
                </div>
                <div class="sim-section" data-ref="seedSection" style="display:none;">
                    <div class="sim-section-title">种子记录</div>
                    <div class="sim-seed-toolbar">
                        <div class="sim-seed-summary" data-ref="seedSummary">暂无批量种子记录</div>
                        <div class="sim-seed-pager-wrap">
                            <button type="button" data-action="seedPrevPage">上一页</button>
                            <div class="sim-seed-pager" data-ref="seedPager">0 / 0</div>
                            <button type="button" data-action="seedNextPage">下一页</button>
                        </div>
                    </div>
                    <div class="sim-seed-list" data-ref="seedList"></div>
                </div>
            </div>
        `;
        // === [重构为卡片式极简UI] ===
        document.getElementById('non-pvp-sim-style').textContent = `
            #non-pvp-sim-panel {
                --xc-primary: #3182ce; --xc-primary-bg: #ebf4ff; --xc-primary-border: #bee3f8;
                --xc-text: #4a5568; --xc-text-muted: #718096;
                --xc-bg: rgba(247, 250, 252, 0.94); --xc-card: rgba(255, 255, 255, 0.92);
                position: fixed; right: 14px; top: 14px; left: auto; z-index: 999999;
                width: calc(100vw - 28px); max-height: calc(100vh - 28px);
                background: var(--xc-bg); backdrop-filter: blur(14px);
                border: 1px solid rgba(255, 255, 255, 0.8); border-radius: 12px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.03);
                font-family: inherit; line-height: 1.6; font-size: 13px;
                display: flex; flex-direction: column; color: var(--xc-text); overflow: hidden;
            }
            #non-pvp-sim-panel * { box-sizing: border-box; }
            .xc-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: linear-gradient(135deg, #ebf8ff 0%, #f0f4ff 50%, #faf5ff 100%); border-bottom: 1px solid rgba(49,130,206,0.08); border-radius: 12px 12px 0 0; cursor: grab; user-select: none; touch-action: none; overflow: hidden; }
            .xc-brand { font-size: 14px; font-weight: 700; color: #2b6cb0; letter-spacing: 0.5px; display:flex; align-items:center; gap:8px; }
            .xc-brand-icon { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg, #3182ce, #6b46c1); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 2px 6px rgba(49,130,206,0.25); }
            .xc-brand-icon svg { width: 15px; height: 15px; stroke: #fff; fill: none; }
            .xc-brand-ver { font-size: 10px; font-weight: 400; color: #a0aec0; margin-left: 2px; }
            .xc-close { background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.04); font-size: 11px; color: var(--xc-text-muted); cursor: pointer; transition: all 0.2s; padding: 3px 10px; border-radius: 6px; }
            .xc-close:hover { background: #fee2e2; color: #c53030; border-color: #fed7d7; }
            .xc-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 16px; overflow-y: auto; overflow-x: hidden; }
            .xc-card { background: var(--xc-card); border-radius: 10px; padding: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.02); border: 1px solid rgba(0,0,0,0.04); overflow: hidden; }
            .xc-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: nowrap; overflow: hidden; }
            .xc-row:last-child { margin-bottom: 0; }
            .xc-select, .xc-input { flex: 1; min-width: 0; min-height: 38px; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px; font-size: 13px; color: var(--xc-text); background: #ffffff; }
            .xc-select:focus, .xc-input:focus { outline: none; border-color: var(--xc-primary-border); }
            .xc-hint { font-size: 12px; color: #e53e3e; background: #fff5f5; padding: 8px; border-radius: 6px; display: none; }
            .xc-label { font-size: 12px; color: var(--xc-text-muted); flex-shrink: 0; white-space: nowrap; }
            .xc-val { font-size: 13px; color: var(--xc-text); max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.6; }
            .xc-val-light { font-size: 13px; color: var(--xc-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%; }
            .xc-list-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px dashed rgba(0,0,0,0.04); flex-wrap: nowrap; overflow: hidden; }
            .xc-list-item:last-child { border-bottom: none; }
            .xc-status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; }
            .xc-status-item { display: flex; gap: 6px; align-items: center; padding: 5px 0; overflow: hidden; }
            .xc-status-label { font-size: 11px; color: var(--xc-text-muted); white-space: nowrap; flex-shrink: 0; }
            .xc-status-val { font-size: 12px; color: var(--xc-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .xc-status-val-light { font-size: 12px; color: var(--xc-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .xc-actions-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; overflow: hidden; }
            .xc-actions-grid:last-child { margin-bottom: 0; }
            .xc-actions-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; overflow: hidden; }
            .xc-btn { min-height: 36px; padding: 4px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; background: #ffffff; border: 1px solid #e2e8f0; color: var(--xc-text); display: inline-flex; align-items: center; justify-content: center; gap: 4px; transition: all 0.2s ease; line-height: 1.4; white-space: nowrap; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; }
            .xc-btn:hover { background: #f7fafc; border-color: #cbd5e1; }
            .xc-btn svg { flex-shrink: 0; vertical-align: middle; }
            .xc-btn-main { background: #ebf8ff !important; color: #2b6cb0 !important; border-color: #bee3f8 !important; font-weight: 600; }
            .xc-btn-main:hover { background: #d6ecff !important; border-color: #90cdf4 !important; }
            .xc-btn-accent { background: #fffaf0 !important; color: #c05621 !important; border-color: #feebc8 !important; font-weight: 600; }
            .xc-btn-accent:hover { background: #fef3e2 !important; border-color: #fbd38d !important; }
            .xc-btn-teal { background: #e6fffa !important; color: #276749 !important; border-color: #b2f5ea !important; }
            .xc-btn-teal:hover { background: #d2f5ed !important; border-color: #81e6d9 !important; }
            .xc-btn-purple { background: #faf5ff !important; color: #6b46c1 !important; border-color: #e9d8fd !important; }
            .xc-btn-purple:hover { background: #f0e4ff !important; border-color: #d6bcfa !important; }
            .xc-btn-warn { background: #fffbeb !important; color: #b7791f !important; border-color: #fefcbf !important; }
            .xc-btn-warn:hover { background: #fef9c3 !important; border-color: #faf089 !important; }
            .xc-btn-danger { background: #fff5f5 !important; color: #c53030 !important; border-color: #fed7d7 !important; }
            .xc-btn-danger:hover { background: #fee2e2 !important; border-color: #feb2b2 !important; }
            .xc-btn-sm { min-height: 26px; padding: 2px 8px; font-size: 11px; border-radius: 4px; background: #ffffff; border: 1px solid #e2e8f0; color: var(--xc-text); cursor: pointer; }
            .xc-section-title { font-size: 13px; color: var(--xc-text-muted); margin-bottom: 8px; line-height: 1.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .xc-candidates { display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto; overflow-x: hidden; }
            .xc-can-item { background: #f8fafc; border-radius: 6px; padding: 8px 10px; border: 1px solid #edf2f7; overflow: hidden; }
            .xc-can-sig { display: flex; justify-content: space-between; font-size: 12px; color: #dd6b20; margin-bottom: 4px; line-height: 1.6; overflow: hidden; }
            .sim-candidate-group { font-size: 11px; font-weight: 600; color: #718096; padding: 4px 2px 2px; border-bottom: 1px solid #e2e8f0; margin-bottom: 4px; }
            .sim-candidate-item { background: #f8fafc; border-radius: 8px; padding: 8px 10px; border: 1px solid #edf2f7; transition: all 0.2s; cursor: pointer; }
            .sim-candidate-item:hover { background: #edf2f7; }
            .sim-candidate-active { background: #ebf8ff; border-color: #90cdf4; box-shadow: 0 0 0 1px rgba(49,130,206,0.1); }
            .sim-candidate-active:hover { background: #ebf8ff; }
            .sim-candidate-badge { font-size: 10px; color: #3182ce; font-weight: 600; margin-bottom: 4px; }
            .sim-candidate-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .sim-candidate-team { display: flex; gap: 4px; flex-wrap: nowrap; align-items: center; flex: 1; min-width: 0; }
            .sim-candidate-del-btn { flex-shrink: 0; min-height: 24px; padding: 2px 10px; font-size: 11px; border-radius: 4px; background: #fff5f5; border: 1px solid #fed7d7; color: #e53e3e; cursor: pointer; transition: all 0.15s; }
            .sim-candidate-del-btn:active { background: #fee2e2; }
            .sim-candidate-meta { font-size: 10px; color: #a0aec0; margin-top: 5px; }
            .sim-toy-icon-img { flex-shrink: 0; width: 26px; height: 26px; border-radius: 5px; object-fit: cover; background: rgba(0,0,0,0.04); border: 1px solid #e9d8fd; margin-right: 2px; }
            .sim-hero-icon-img { flex: 1 1 0; max-width: 32px; min-width: 0; aspect-ratio: 1; border-radius: 6px; object-fit: cover; background: rgba(0,0,0,0.04); border: 0.5px solid rgba(0,0,0,0.08); }
            .xc-report { white-space: pre-wrap; font-size: 12px; line-height: 1.6; color: var(--xc-text); max-height: 200px; overflow-y: auto; overflow-x: hidden; padding: 4px; word-break: break-all; }
            .xc-report-html { white-space: normal; word-break: normal; padding: 0; }
            .xc-report-html .sim-candidate-team { justify-content: center; }
            .xc-report-title { font-size: 12px; font-weight: 600; color: var(--xc-text); margin-bottom: 4px; }
            .xc-report-item { margin-bottom: 4px; }
            .xc-report-multi { padding: 6px; background: #f8fafc; border-radius: 6px; border: 1px solid #edf2f7; }
            .xc-report-stats { font-size: 11px; color: #4a5568; line-height: 1.4; }
            .xc-report-extra { font-size: 10px; color: #718096; line-height: 1.4; }
            .xc-seed-list { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto; overflow-x: hidden; }
            .xc-seed-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: #f8fafc; border-radius: 6px; border: 1px solid #edf2f7; font-size: 11px; }
            .xc-seed-item.is-win { border-left: 3px solid #48bb78; }
            .xc-seed-item.is-lose { border-left: 3px solid #fc8181; }
            .xc-seed-body { flex: 1; min-width: 0; }
            .xc-seed-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
            .xc-seed-tag { font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 3px; }
            .xc-seed-tag.is-win { background: #f0fff4; color: #38a169; }
            .xc-seed-tag.is-lose { background: #fff5f5; color: #e53e3e; }
            .xc-seed-num { color: var(--xc-text); font-weight: 500; }
            .xc-seed-id { color: #a0aec0; font-size: 10px; }
            .xc-seed-detail { color: #718096; font-size: 10px; margin-top: 2px; }
            .xc-seed-replay { flex-shrink: 0; padding: 2px 8px; font-size: 10px; border-radius: 4px; background: #fff; border: 1px solid #e2e8f0; color: var(--xc-text-muted); cursor: pointer; }
            .xc-seed-sort-select { height: 22px; min-height: 22px; padding: 0 4px; font-size: 11px; color: var(--xc-text); background: #ffffff; border: 1px solid #e2e8f0; border-radius: 4px; outline: none; cursor: pointer; }
            .xc-seed-sort-select:focus { border-color: var(--xc-primary-border); }
            .xc-log-stream { max-height: 150px; overflow-y: auto; overflow-x: hidden; font-size: 11px; line-height: 1.5; color: var(--xc-text-muted); white-space: pre-wrap; word-break: break-all; }
            .mp-head { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; overflow: hidden; }
            .mp-tag { font-size: 12px; padding: 3px 8px; background: #e6fffa; color: #319795; border-radius: 4px; line-height: 1.6; white-space: nowrap; }
            .mp-lamp { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e0; flex-shrink: 0; }
            .mp-lamp[data-tone="running"] { background: #48bb78; box-shadow: 0 0 6px rgba(72,187,120,0.5); }
            .mp-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; overflow: hidden; }
            .mp-item { background: #f8fafc; padding: 6px; border-radius: 4px; text-align: center; overflow: hidden; }
            .mp-item label { display: block; font-size: 11px; color: #a0aec0; margin-bottom: 4px; line-height: 1.6; }
            .mp-item div { font-size: 13px; color: #dd6b20; line-height: 1.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #non-pvp-sim-panel.collapsed { display: none !important; }
            #non-pvp-sim-panel.dragging { opacity: 0.8; box-shadow: 0 12px 32px rgba(0,0,0,0.12); cursor: grabbing !important; }
            #non-pvp-sim-panel .target-wrap, #non-pvp-sim-panel [data-ref="targetHint"] { display: none !important; }
            .xc-tab-inputs { display: none !important; }
            .xc-tab-labels { display: flex; border-bottom: 1px solid rgba(0,0,0,0.05); margin-bottom: 2px; flex-shrink: 0; overflow: hidden; }
            .xc-tab-btn { flex: 1; text-align: center; padding: 8px 0; font-size: 14px; color: var(--xc-text-muted); cursor: pointer; transition: all 0.2s; border-bottom: 2px solid transparent; white-space: nowrap; overflow: hidden; }
            .xc-tab-content { display: none; flex-direction: column; gap: 10px; overflow-x: hidden; }
            #tab1:checked ~ .xc-tab-labels [for="tab1"], #tab2:checked ~ .xc-tab-labels [for="tab2"], #tab3:checked ~ .xc-tab-labels [for="tab3"] { color: var(--xc-primary); border-bottom-color: var(--xc-primary); font-weight: bold; }
            #tab1:checked ~ #content1, #tab2:checked ~ #content2, #tab3:checked ~ #content3 { display: flex; }
        `;

        root.innerHTML = `
            <div class="xc-head" data-ref="head">
                <div class="xc-brand" data-ref="dragHandle">
                    <div class="xc-brand-icon"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l3.5 3.5"/><path d="M19 21a2 2 0 0 0 0-4"/></svg></div>
                    <span>\u6a21\u62df\u5bf9\u6218</span>
                </div>
            </div>
            <div class="xc-body" style="padding-top: 4px;">
                <input type="radio" name="xctab" id="tab1" class="xc-tab-inputs" checked>
                <input type="radio" name="xctab" id="tab2" class="xc-tab-inputs">
                <input type="radio" name="xctab" id="tab3" class="xc-tab-inputs">
                <div class="xc-tab-labels">
                    <label for="tab1" class="xc-tab-btn">控制台</label>
                    <label for="tab2" class="xc-tab-btn">阵容</label>
                    <label for="tab3" class="xc-tab-btn">日志</label>
                </div>

                <div id="content1" class="xc-tab-content">
                    <div class="xc-hint" data-ref="pvpHint">玩家战斗场景隐藏</div>
                    <div class="xc-card" data-ref="manualBlock">
                        <div class="xc-row">
                            <select data-ref="modeSelect" class="xc-select">
                                <option value="auto">自动识别</option>
                                <option value="tower">咸将塔</option>
                                <option value="evoTower">怪异塔</option>
                                <option value="genie">灯神挑战</option>
                                <option value="genieShenhai">深海灯神</option>
                                <option value="legionBoss">俱乐部首领</option>
                                <option value="nightmare">十殿试炼</option>
                                <option value="nightmareStar">星级挑战</option>
                                <option value="capture">最近捕获记录</option>
                            </select>
                            <select data-ref="quickTargetSelect" class="xc-select" style="display:none;"></select>
                        </div>
                        <div class="xc-row target-wrap" data-ref="splitTargetWrap" style="display:none;">
                            <input data-ref="targetMajorInput" type="text" placeholder="主节点" class="xc-input">
                            <span style="color:#a0aec0; font-size:12px;">-</span>
                            <input data-ref="targetMinorInput" type="text" placeholder="次节点" class="xc-input">
                        </div>
                        <input data-ref="targetInput" type="text" style="display:none;">
                        <div class="xc-row" style="margin-bottom:0;">
                            <span class="xc-label" style="min-width:52px;">模拟次数</span>
                            <input data-ref="sampleCountInput" type="text" inputmode="numeric" placeholder="1000" class="xc-input" style="flex:1; text-align:center;">
                            <div style="font-size:10px; color:#a0aec0; white-space:nowrap;" data-ref="targetHint">配妥即可推开</div>
                        </div>
                    </div>
                    <div class="xc-card">
                        <div class="xc-status-grid">
                            <div class="xc-status-item"><span class="xc-status-label">玩法</span><span class="xc-status-val" data-ref="mode">-</span></div>
                            <div class="xc-status-item"><span class="xc-status-label">目标</span><span class="xc-status-val xc-status-val-light" data-ref="context">-</span></div>
                            <div class="xc-status-item"><span class="xc-status-label">等级</span><span class="xc-status-val" data-ref="capability">-</span></div>
                            <div class="xc-status-item"><span class="xc-status-label">任务</span><span class="xc-status-val xc-status-val-light" data-ref="job">空闲</span></div>
                        </div>
                    </div>
                    <div class="xc-card" data-ref="mainPushCard" style="display:none;">
                        <div class="mp-head">
                            <span class="mp-tag" data-ref="mainPushTag">主线推关中</span>
                            <span class="mp-lamp" data-ref="mainPushLamp"></span>
                            <span class="xc-val-light" data-ref="mainPushStateLabel" style="margin-left:auto;font-size:11px;">停止</span>
                            <span style="font-size:11px;color:#a0aec0;" data-ref="mainPushStateDesc">未启动</span>
                        </div>
                        <div class="mp-grid">
                            <div class="mp-item"><label>层级</label><div data-ref="mainPushLevel">-</div></div>
                            <div class="mp-item"><label>首领</label><div data-ref="mainPushBoss">-</div></div>
                            <div class="mp-item"><label>回合</label><div data-ref="mainPushRound">-</div></div>
                            <div class="mp-item"><label>重置</label><div data-ref="mainPushReset">0</div></div>
                        </div>
                    </div>
                    <div class="xc-card" data-ref="actions">
                        <div class="xc-actions-grid-3">
                            <button class="xc-btn xc-btn-main" data-action="mainPush" data-ref="mainPushBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>推关模拟</button>
                            <button class="xc-btn xc-btn-accent" data-action="quick"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>开始模拟</button>
                            <button class="xc-btn xc-btn-teal" data-action="record"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>同步阵容</button>
                            <button class="xc-btn xc-btn-purple" data-action="replay"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>回放对战</button>
                            <button class="xc-btn xc-btn-warn" data-action="stop"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>停止模拟</button>
                            <button class="xc-btn xc-btn-danger" data-action="clear"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>清空阵容</button>
                        </div>
                    </div>
                </div>

                <div id="content2" class="xc-tab-content">
                    <div class="xc-card">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                            <div class="xc-section-title" style="margin:0;">候选阵容</div>
                            <button class="xc-btn xc-btn-sm" data-action="record">同步阵容</button>
                        </div>
                        <div class="xc-candidates" data-ref="candidateList"></div>
                    </div>
                    <span data-ref="signature" style="display:none;">-</span>
                </div>

                <div id="content3" class="xc-tab-content">
                    <div class="xc-card">
                        <div class="xc-section-title" style="margin:0; padding-bottom:6px; border-bottom:1px solid rgba(0,0,0,0.03); margin-bottom:6px;">最近表现</div>
                        <div class="xc-report" data-ref="reportBody">暂无日志内容</div>
                    </div>
                    <div class="xc-card" data-ref="seedSection" style="display:none;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; flex-wrap:wrap; gap:4px;">
                            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                                <div class="xc-section-title" style="margin:0;">种子记录</div>
                                <select data-ref="seedSortSelect" class="xc-seed-sort-select" title="种子排序方式">
                                    <option value="default">默认顺序</option>
                                    <option value="roundAsc">回合 ↑ (少到多)</option>
                                    <option value="roundDesc">回合 ↓ (多到少)</option>
                                    <option value="winDesc">胜利优先</option>
                                    <option value="winAsc">失败优先</option>
                                </select>
                            </div>
                            <span data-ref="seedSummary" style="font-size:11px; color:var(--xc-text-muted);">暂无</span>
                        </div>
                        <div data-ref="seedList" class="xc-seed-list"></div>
                        <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-top:6px;">
                            <button class="xc-btn xc-btn-sm" data-action="seedPrevPage">上一页</button>
                            <span data-ref="seedPager" style="font-size:11px; color:var(--xc-text-muted);">0/0</span>
                            <button class="xc-btn xc-btn-sm" data-action="seedNextPage">下一页</button>
                        </div>
                    </div>
                    <div class="xc-card" data-ref="mainPushLogCard" style="display:none;">
                        <div class="xc-section-title" style="margin:0; padding-bottom:6px; border-bottom:1px solid rgba(0,0,0,0.03); margin-bottom:6px;">推关日志</div>
                        <div class="xc-log-stream" data-ref="mainPushLogBody">暂无日志</div>
                    </div>
                </div>

                <div style="display:none !important;">
                    <button data-ref="debugToggleBtn"><span data-ref="debugToggleLabel"></span></button>
                    <button data-action="debugOnce"></button>
                    <div data-ref="debugWrap"><div data-ref="debugActions">
                        <button data-action="sources"></button><button data-action="diag"></button><button data-action="exportDiag"></button><button data-action="clearDiag"></button>
                    </div></div>
                    <div data-ref="toolbar"></div>
                    <span data-ref="diagCount">0</span>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        const refs = {};
        root.querySelectorAll('[data-ref]').forEach((node) => {
            refs[node.dataset.ref] = node;
        });
        state.panel = {
            root,
            refs,
        };
        syncPanelViewportBounds();
        installPanelDrag(refs.head);
        refs.debugToggleBtn.addEventListener('click', () => {
            state.panelPrefs.debugExpanded = !state.panelPrefs.debugExpanded;
            savePanelState();
            renderPanel();
        });
        refs.modeSelect.addEventListener('change', () => {
            const previousChoice = state.panelPrefs.modeChoice || 'auto';
            state.panelPrefs.modeChoice = refs.modeSelect.value || 'auto';
            if (isSplitTargetMode(state.panelPrefs.modeChoice)) {
                const splitValue = buildSplitTargetValue(
                    state.panelPrefs.modeChoice,
                    state.panelPrefs.targetMajor,
                    state.panelPrefs.targetMinor,
                );
                state.panelPrefs.targetValue = splitValue;
                if (!splitValue && !isSplitTargetMode(previousChoice)) {
                    refs.targetMajorInput.value = '';
                    refs.targetMinorInput.value = '';
                }
            }
            const quickValue = resolveQuickTargetValue(state.panelPrefs.modeChoice, state.panelPrefs.targetValue);
            if (isQuickTargetMode(state.panelPrefs.modeChoice) && !isSplitTargetMode(state.panelPrefs.modeChoice)) {
                state.panelPrefs.targetValue = quickValue;
                refs.targetInput.value = '';
            }
            savePanelState();
            renderPanel();
        });
        const syncSplitTargetInput = () => {
            const choice = state.panelPrefs.modeChoice || 'auto';
            const majorValue = String(refs.targetMajorInput.value || '').replace(/[^\d]+/g, '');
            const minorValue = String(refs.targetMinorInput.value || '').replace(/[^\d]+/g, '');
            refs.targetMajorInput.value = majorValue;
            refs.targetMinorInput.value = minorValue;
            state.panelPrefs.targetMajor = majorValue;
            state.panelPrefs.targetMinor = minorValue;
            state.panelPrefs.targetValue = buildSplitTargetValue(choice, majorValue, minorValue);
            savePanelState();
            renderPanel();
        };
        const syncTargetInput = () => {
            const rawValue = refs.targetInput.value || '';
            const quickValue = resolveQuickTargetValue(state.panelPrefs.modeChoice || 'auto', rawValue);
            state.panelPrefs.targetValue = quickValue || rawValue;
            if (refs.quickTargetSelect) {
                refs.quickTargetSelect.value = resolveQuickTargetValue(state.panelPrefs.modeChoice || 'auto', state.panelPrefs.targetValue);
            }
            savePanelState();
            renderPanel();
        };
        refs.targetMajorInput.addEventListener('change', syncSplitTargetInput);
        refs.targetMajorInput.addEventListener('input', syncSplitTargetInput);
        refs.targetMinorInput.addEventListener('change', syncSplitTargetInput);
        refs.targetMinorInput.addEventListener('input', syncSplitTargetInput);
        refs.targetInput.addEventListener('change', syncTargetInput);
        refs.targetInput.addEventListener('input', syncTargetInput);
        refs.quickTargetSelect.addEventListener('change', () => {
            const value = refs.quickTargetSelect.value || '';
            refs.targetInput.value = '';
            state.panelPrefs.targetValue = value;
            savePanelState();
            renderPanel();
        });
        const syncSampleCountInput = () => {
            const sampleCount = getPanelSampleCount(refs.sampleCountInput.value || state.panelPrefs.sampleCount);
            refs.sampleCountInput.value = `${sampleCount}`;
            renderPanel();
        };
        refs.sampleCountInput.addEventListener('change', syncSampleCountInput);
        refs.sampleCountInput.addEventListener('input', () => {
            const text = String(refs.sampleCountInput.value || '').replace(/[^\d]+/g, '');
            refs.sampleCountInput.value = text;
            state.panelPrefs.sampleCount = text || state.panelPrefs.sampleCount || `${DEFAULT_SAMPLE_COUNT}`;
            savePanelState();
        });
        if (refs.seedSortSelect) {
            refs.seedSortSelect.addEventListener('change', () => {
                const sortBy = refs.seedSortSelect.value || 'default';
                state.seedRecordView.sortBy = sortBy;
                state.panelPrefs.seedSort = sortBy;
                state.seedRecordView.page = 0;
                state.seedRecordView.selectedIndex = 0;
                savePanelState();
                renderSeedRecords();
            });
        }
        window.addEventListener('resize', () => {
            syncPanelViewportBounds();
            applyPanelPosition(true);
        }, { passive: true });
        root.addEventListener('click', async (event) => {
            const actionNode = event.target.closest('[data-action]');
            const replaySeedNode = event.target.closest('[data-replay-seed-index]');
            const seedRecordNode = event.target.closest('[data-seed-record-index]');
            const removeNode = event.target.closest('[data-remove-candidate]');
            if (removeNode) {
                removeCandidate(removeNode.dataset.removeCandidate);
                renderPanel();
                return;
            }
            const switchNode = event.target.closest('[data-switch-candidate]');
            if (switchNode && !event.target.closest('[data-remove-candidate]')) {
                const cid = switchNode.dataset.switchCandidate;
                const target = state.candidates.find((c) => c.id === cid);
                if (target) {
                    syncReusableSkeletonFromCandidate(target, null, 'manualSwitch');
                    state.activeSwitchedCandidate = target;
                    _lastCandidateSignature = '';
                    renderPanel();
                    Utils.toast(`已切换阵容 ${formatSignatureShort(target.signature)}`, 'success');
                }
                return;
            }
            if (replaySeedNode) {
                try {
                    const report = getSeedRecordSourceReport();
                    const recordIndex = Number(replaySeedNode.dataset.replaySeedIndex || -1);
                    if (!report || !Array.isArray(report.seedRecords) || recordIndex < 0 || recordIndex >= report.seedRecords.length) {
                        throw new Error('当前没有可回放的种子记录');
                    }
                    const filteredRecords = getFilteredSeedRecords(report);
                    const filteredIndex = filteredRecords.findIndex(item => item.rawIndex === recordIndex);
                    if (filteredIndex >= 0) {
                        state.seedRecordView.selectedIndex = filteredIndex;
                        state.seedRecordView.page = Math.floor(filteredIndex / SEED_RECORD_PAGE_SIZE);
                    }
                    await replayRecordedSeed(report, report.seedRecords[recordIndex]);
                    Utils.toast(`已回放 seed ${report.seedRecords[recordIndex].seed}`, 'success');
                } catch (error) {
                    Utils.error(error);
                    Utils.toast(error.message || '种子回放失败', 'error');
                }
                return;
            }
            if (seedRecordNode) {
                const rawIndex = Number(seedRecordNode.dataset.seedRecordIndex || -1);
                if (rawIndex >= 0) {
                    const report = getSeedRecordSourceReport();
                    const filteredRecords = getFilteredSeedRecords(report);
                    const filteredIndex = filteredRecords.findIndex(item => item.rawIndex === rawIndex);
                    if (filteredIndex >= 0) {
                        state.seedRecordView.selectedIndex = filteredIndex;
                        state.seedRecordView.page = Math.floor(filteredIndex / SEED_RECORD_PAGE_SIZE);
                    }
                    renderPanel();
                }
                return;
            }
            if (!actionNode) {
                return;
            }
            const action = actionNode.dataset.action;
            const allowDuringStartup = new Set(['sources', 'diag', 'exportDiag']);
            try {
                if (!state.runtimeReady && !allowDuringStartup.has(action)) {
                    const remainMs = Math.max(0, Number(state.runtimeDelayedUntil || 0) - Utils.now());
                    throw new Error(`脚本正在等待主线自动战斗稳定，请稍后再试${remainMs > 0 ? `（约 ${Math.ceil(remainMs / 1000)} 秒）` : ''}`);
                }
                if (action === 'detect') {
                    const result = syncSelectionFromCurrent();
                    Utils.toast(`已回填 ${result.adapter.label} / ${buildContextText(result.adapter.key, result.context)}`, 'success');
                } else if (action === 'record') {
                    const adapter = getActiveAdapter();
                    const candidate = captureCurrentTeamSnapshot(adapter ? adapter.getContext() : null);
                    upsertCandidate(candidate);
                    state.activeSwitchedCandidate = null;
                    renderPanel();
                    Utils.toast(`已记录阵容 ${formatSignatureShort(candidate.signature)}`, 'success');
                } else if (action === 'mainPush') {
                    if (state.mainPush.isRunning) {
                        stopMainPush('button');
                        Utils.toast('已停止模拟推关', 'warning');
                    } else {
                        Utils.toast('正在启动模拟推关...', 'info');
                        await startMainPush();
                        Utils.toast('主线模拟推关已启动', 'success');
                    }
                } else if (action === 'debugOnce') {
                    Utils.toast('开始单次调试...', 'info');
                    const singleRun = await debugCurrentTeamOnce();
                    Utils.toast(`单次调试完成，${singleRun.stats && singleRun.stats.isWin ? '胜利' : '失败'} / 回合 ${singleRun.stats ? singleRun.stats.roundCount : 0}`, 'success');
                } else if (action === 'quick') {
                    const sampleCount = getPanelSampleCount(refs.sampleCountInput.value || state.panelPrefs.sampleCount);
                    Utils.toast(`开始模拟 ${sampleCount} 次...`, 'info');
                    const report = await evaluateCurrentTeam(sampleCount, `单队模拟 ${sampleCount} 次`);
                    Utils.toast(`单队模拟完成 ${sampleCount} 次，胜率 ${Utils.formatPercent(report.winRate)}`, 'success');
                } else if (action === 'compare') {
                    const sampleCount = getPanelSampleCount(refs.sampleCountInput.value || state.panelPrefs.sampleCount);
                    Utils.toast(`开始批量比较 ${sampleCount} 次...`, 'info');
                    const reports = await compareCandidates(sampleCount);
                    if (reports.length) {
                        Utils.toast(`批量比较完成，推荐 ${formatSignatureShort(reports[0].signature)}`, 'success');
                    } else {
                        Utils.toast('批量比较已停止或没有结果', 'info');
                    }
                } else if (action === 'seedPrevPage' || action === 'seedNextPage') {
                    const report = getSeedRecordSourceReport();
                    if (!report || !Array.isArray(report.seedRecords) || !report.seedRecords.length) {
                        throw new Error('当前没有批量种子记录');
                    }
                    ensureSeedRecordViewState(report);
                    const filteredRecords = getFilteredSeedRecords(report);
                    if (!filteredRecords.length) {
                        throw new Error('当前没有匹配的种子记录');
                    }
                    const maxPage = Math.max(0, Math.ceil(filteredRecords.length / SEED_RECORD_PAGE_SIZE) - 1);
                    const delta = action === 'seedPrevPage' ? -1 : 1;
                    state.seedRecordView.page = Math.max(0, Math.min(maxPage, Number(state.seedRecordView.page || 0) + delta));
                    const pageStart = state.seedRecordView.page * SEED_RECORD_PAGE_SIZE;
                    const pageEnd = Math.min(filteredRecords.length - 1, pageStart + SEED_RECORD_PAGE_SIZE - 1);
                    if (state.seedRecordView.selectedIndex < pageStart || state.seedRecordView.selectedIndex > pageEnd) {
                        state.seedRecordView.selectedIndex = pageStart;
                    }
                    renderPanel();
                    Utils.toast(`第 ${state.seedRecordView.page + 1}/${maxPage + 1} 页`, 'info');
                } else if (action === 'replay') {
                    Utils.toast('正在启动回放...', 'info');
                    await replayLatest();
                    Utils.toast('已启动回放', 'success');
                } else if (action === 'sources') {
                    showDataSources();
                } else if (action === 'diag') {
                    showDiagnosticLogs();
                } else if (action === 'exportDiag') {
                    const fileName = exportDiagnosticLogs();
                    Utils.toast(`诊断日志已导出: ${fileName}`, 'success');
                } else if (action === 'stop') {
                    if (state.mainPush.isRunning) {
                        stopMainPush('button');
                        Utils.toast('已停止模拟推关', 'warning');
                    } else {
                        state.stopRequested = true;
                        Utils.toast('已请求停止当前任务', 'info');
                    }
                } else if (action === 'clear') {
                    state.candidates = [];
                    saveCandidates();
                    renderPanel();
                    Utils.toast('候选阵容已清空', 'success');
                } else if (action === 'clearDiag') {
                    clearDiagnosticLogs();
                    renderPanel();
                    Utils.toast('诊断日志已清空', 'success');
                }
            } catch (error) {
                Utils.error(error);
                Utils.toast(error.message || '操作失败', 'error');
            }
        });
    }

    var _lastCandidateSignature = '';
    function renderCandidates() {
        if (!state.panel || !state.panel.refs.candidateList) {
            return;
        }
        const list = state.panel.refs.candidateList;
        var currentRoleId = Utils.safeCall(() => {
            var m = getRoleDisplayMeta();
            return m && m.roleId ? String(m.roleId) : '0';
        }, '0');
        if (!state.candidates.length) {
            if (_lastCandidateSignature !== '__empty__') {
                list.innerHTML = '<div class="sim-candidate-item"><div class="sim-candidate-meta">暂无候选阵容，点击"获取当前阵容"即可保存当前配置。</div></div>';
                _lastCandidateSignature = '__empty__';
            }
            return;
        }
        const sig = currentRoleId + '||' + (state.lastKnownSignature || '') + '||' + state.candidates.map((c) => c.id + ':' + c.signature).join('|');
        if (sig === _lastCandidateSignature) {
            list.querySelectorAll('.sim-hero-icon-img').forEach(async (img) => {
                if (img.src && img.src !== location.href && img.src !== '') return;
                const heroId = img.dataset.heroId;
                if (heroId) {
                    const url = await loadHeroIconUrl(parseInt(heroId));
                    if (url) img.src = url;
                }
            });
            return;
        }
        _lastCandidateSignature = sig;
        const currentSig = state.lastKnownSignature || '';
        var filtered = state.candidates.filter((candidate) => {
            var meta = Utils.safeCall(() => Utils.fromSerializable(candidate.leftTeamMeta || {}), {});
            var rid = meta && meta.roleId ? String(meta.roleId) : '0';
            return rid === '0' || currentRoleId === '0' || rid === currentRoleId;
        });
        if (!filtered.length) {
            list.innerHTML = '<div class="sim-candidate-item"><div class="sim-candidate-meta">当前账号暂无候选阵容，点击"获取当前阵容"即可保存当前配置。</div></div>';
            return;
        }
        var groups = new Map();
        filtered.forEach((candidate) => {
            var meta = Utils.safeCall(() => Utils.fromSerializable(candidate.leftTeamMeta || {}), {});
            var rid = meta && meta.roleId ? String(meta.roleId) : '0';
            var rname = meta && meta.name ? meta.name : '未知角色';
            if (!groups.has(rid)) groups.set(rid, { name: rname, items: [] });
            groups.get(rid).items.push(candidate);
        });
        var html = '';
        var showGroup = groups.size > 1;
        groups.forEach((group) => {
            if (showGroup) {
                html += `<div class="sim-candidate-group">${group.name}</div>`;
            }
            group.items.forEach((candidate) => {
                var isActive = currentSig && candidate.signature === currentSig;
                html += `<div class="sim-candidate-item${isActive ? ' sim-candidate-active' : ''}" data-switch-candidate="${candidate.id}">`;
                if (isActive) html += '<div class="sim-candidate-badge">当前阵容</div>';
                html += `<div class="sim-candidate-row"><div class="sim-candidate-team">${formatCandidateSummary(candidate)}</div><button class="sim-candidate-del-btn" data-remove-candidate="${candidate.id}">删除</button></div>`;
                html += `<div class="sim-candidate-meta">${Utils.formatTime(candidate.capturedAt)}</div></div>`;
            });
        });
        list.innerHTML = html;
        list.querySelectorAll('.sim-hero-icon-img').forEach(async (img) => {
            const heroId = img.dataset.heroId;
            if (heroId) {
                const url = await loadHeroIconUrl(parseInt(heroId));
                if (url) img.src = url;
            }
        });
    }

    function renderQuickTargetOptions(selectNode, choice, options, selectedValue) {
        if (!selectNode) {
            return;
        }
        const placeholder = getQuickTargetPlaceholder(choice);
        const signature = `${choice}:${options.length}:${options[0] ? options[0].value : ''}:${options[options.length - 1] ? options[options.length - 1].value : ''}`;
        if (selectNode.dataset.optionSignature !== signature) {
            selectNode.innerHTML = '';
            selectNode.appendChild(new Option(placeholder, ''));
            options.forEach((item) => {
                selectNode.appendChild(new Option(item.label, item.value));
            });
            selectNode.dataset.optionSignature = signature;
        }
        selectNode.value = selectedValue || '';
    }

    function updateMainPushBtnLabel(btn, isRunning) {
        if (!btn) return;
        var svg = btn.querySelector('svg');
        var label = isRunning ? '停止推关' : '推关模拟';
        if (svg) {
            Array.from(btn.childNodes).forEach((n) => { if (n !== svg) btn.removeChild(n); });
            btn.appendChild(document.createTextNode(label));
        } else {
            btn.textContent = label;
        }
    }

    function renderPanel() {
        createPanel();
        if (!state.panel) {
            return;
        }
        var refs = state.panel.refs;
        state.panel.root.classList.toggle('collapsed', !!state.panelPrefs.collapsed);
        if (refs.collapseLabel) { refs.collapseLabel.textContent = state.panelPrefs.collapsed ? '展开' : '收起'; }
        var isMainPush = !!(state.mainPush && state.mainPush.isRunning);
        refs.job.textContent = state.activeJob ? `${state.activeJob.title} / 运行中` : '空闲';
        updateMainPushBtnLabel(refs.mainPushBtn, isMainPush);
        if (refs.mainPushCard) {
            var mainPushState = getMainPushDisplayState();
            refs.mainPushCard.classList.toggle('visible', shouldShowMainPushCard());
            if (refs.mainPushLamp) refs.mainPushLamp.dataset.tone = mainPushState.tone;
            if (refs.mainPushStateLabel) refs.mainPushStateLabel.textContent = mainPushState.label;
            if (refs.mainPushStateDesc) refs.mainPushStateDesc.textContent = state.mainPush.lastStatusText || '未启动';
            if (refs.mainPushLevel) refs.mainPushLevel.textContent = state.mainPush.lastLevelId != null ? `${state.mainPush.lastLevelId}` : '-';
            if (refs.mainPushBoss) refs.mainPushBoss.textContent = state.mainPush.lastBossName || '-';
            if (refs.mainPushRound) refs.mainPushRound.textContent = state.mainPush.lastRoundId != null ? `${state.mainPush.lastRoundId}` : '-';
            if (refs.mainPushReset) refs.mainPushReset.textContent = `${state.mainPush.resetCount || 0}`;
            if (refs.mainPushTag) refs.mainPushTag.textContent = isMainPush ? '持续模拟中' : '主线推关';
        }
        if (isMainPush) {
            renderMainPushReport();
            if (refs.seedSection) refs.seedSection.style.display = 'none';
        } else {
            if (refs.mainPushLogCard) refs.mainPushLogCard.style.display = 'none';
        }
        if (state.activeJob) {
            if (!state.panelDragState) applyPanelPosition(false);
            return;
        }
        syncPanelViewportBounds();
        const runtimeReady = !!state.runtimeReady;
        const adapter = runtimeReady ? getActiveAdapter() : null;
        const latestIsPvp = !!(state.latestCapture && state.latestCapture.input && isPvpBattleInput(state.latestCapture.input));
        const hideManualForPvp = latestIsPvp && (state.panelPrefs.modeChoice || 'auto') === 'auto';
        const debugOpen = !!state.panelPrefs.debugExpanded;
        state.panel.root.classList.toggle('debug-open', debugOpen);
        refs.debugToggleLabel.textContent = debugOpen ? '收起' : '展开';
        const modeChoice = state.panelPrefs.modeChoice || 'auto';
        const quickTargetOptions = runtimeReady ? getManualTargetOptions(modeChoice) : [];
        const quickTargetValue = resolveQuickTargetValue(modeChoice, state.panelPrefs.targetValue || '');
        const showQuickSelect = shouldShowQuickTargetSelect(modeChoice, quickTargetOptions);
        const showSplitTarget = isSplitTargetMode(modeChoice) && modeChoice !== 'capture';
        const derivedSplitParts = showSplitTarget
            && !state.panelPrefs.targetMajor
            && !state.panelPrefs.targetMinor
            && state.panelPrefs.targetValue
            ? deriveSplitTargetParts(modeChoice, state.panelPrefs.targetValue || '')
            : { major: '', minor: '' };
        refs.modeSelect.value = modeChoice;
        refs.targetInput.value = quickTargetOptions.length
            ? getQuickTargetInputValue(modeChoice, state.panelPrefs.targetValue || '')
            : (state.panelPrefs.targetValue || '');
        refs.targetInput.placeholder = getTargetInputPlaceholder(modeChoice);
        if (document.activeElement !== refs.sampleCountInput) {
            refs.sampleCountInput.value = `${normalizeSampleCount(state.panelPrefs.sampleCount, DEFAULT_SAMPLE_COUNT)}`;
        }
        refs.targetMajorInput.value = state.panelPrefs.targetMajor || derivedSplitParts.major || '';
        refs.targetMinorInput.value = state.panelPrefs.targetMinor || derivedSplitParts.minor || '';
        refs.splitTargetWrap.style.display = showSplitTarget ? 'grid' : 'none';
        refs.targetInput.style.display = 'none';
        if (showQuickSelect) {
            renderQuickTargetOptions(refs.quickTargetSelect, modeChoice, quickTargetOptions, quickTargetValue);
        } else if (refs.quickTargetSelect) {
            refs.quickTargetSelect.innerHTML = '';
            refs.quickTargetSelect.dataset.optionSignature = '';
        }
        refs.quickTargetSelect.style.display = showQuickSelect ? 'block' : 'none';
        refs.targetHint.textContent = runtimeReady
            ? getTargetHintText(modeChoice)
            : '启动保护中：脚本会在主线自动战斗稳定后再接管，避免干扰登录后的自动主线战斗。';
        refs.mode.textContent = adapter ? adapter.label : '未识别';
        refs.context.textContent = runtimeReady
            ? (adapter ? buildContextText(adapter.key, adapter.getContext()) : '-')
            : '游戏启动后的主线自动战斗还在保护期';
        refs.capability.textContent = runtimeReady ? (adapter ? adapter.capabilities(adapter.getContext()) : CAPABILITY.NONE) : '等待接管';
        refs.signature.textContent = state.lastKnownSignature || '-';
        if (refs.candidateCount) refs.candidateCount.textContent = `${state.candidates.length}`;
        refs.diagCount.textContent = `${state.diagnosticSamples.length}`;
        refs.manualBlock.style.display = hideManualForPvp ? 'none' : 'grid';
        refs.toolbar.style.display = hideManualForPvp ? 'none' : 'grid';
        refs.actions.style.display = hideManualForPvp ? 'none' : 'grid';
        refs.debugWrap.style.display = hideManualForPvp || !debugOpen ? 'none' : 'block';
        refs.pvpHint.style.display = hideManualForPvp ? 'block' : 'none';
        renderCandidates();
        if (!isMainPush) {
            renderSeedRecords();
        }
        if (isMainPush || (state.mainPush.keepReport && state.mainPush.logLines.length && !state.lastDebugError && !state.lastSingleRun && !state.lastReport)) {
            renderMainPushReport();
        } else if (state.lastDebugError) {
            renderLastReport({
                title: `${state.lastDebugError.label} 单次调试失败`,
                text: `seed ${state.lastDebugError.seed}\n${state.lastDebugError.errorMessage}`,
            });
        } else if (state.lastSingleRun) {
            renderLastReport({
                title: `${state.lastSingleRun.label} 单次调试`,
                text: buildSingleRunSummarySafe(state.lastSingleRun),
            });
        } else if (!state.lastReport) {
            renderLastReport(null);
        } else {
            renderLastReport({
                title: `${MODE_LABELS[state.lastReport.adapterKey] || state.lastReport.adapterKey} 最近评估`,
                text: state.lastReports.length > 1
                    ? state.lastReports.slice(0, 5).map((item, index) => `${index + 1}. ${buildReportSummary(item)}`).join('\n')
                    : buildReportSummary(state.lastReport),
            }, state.lastReports.length > 1 ? state.lastReports.slice(0, 5) : [state.lastReport]);
        }
        if (!state.panelDragState) {
            applyPanelPosition(false);
        }
    }

    function exposeDebugApi() {
        Object.assign(window.__NON_PVP_SIMULATOR__, {
            getDiagnostics() {
                return Utils.deepClone(state.diagnosticSamples);
            },
            getLastReport() {
                return Utils.deepClone(state.lastReport);
            },
            getLastSingleRun() {
                return Utils.deepClone(state.lastSingleRun);
            },
            getLastDebugError() {
                return Utils.deepClone(state.lastDebugError);
            },
            runDebugOnce: debugCurrentTeamOnce,
            startMainPush,
            stopMainPush,
            showDiagnostics: showDiagnosticLogs,
            exportDiagnostics: exportDiagnosticLogs,
            clearDiagnostics: clearDiagnosticLogs,
            resetSeedCursor,
        });
    }

    function finishRuntimeActivation() {
        if (state.runtimeReady) {
            return;
        }
        Runtime.patchBattleCapture();
        state.runtimeReady = true;
        state.runtimeActivating = false;
        delete state.manualTargetOptions.legionBoss;
        loadReusableSkeleton(true);
        tryCaptureAutoLevelBattleSkeleton('startupActivate');
        if (state.startupCaptureTimer) {
            clearInterval(state.startupCaptureTimer);
            state.startupCaptureTimer = null;
        }
        let captureTries = 0;
        state.startupCaptureTimer = setInterval(() => {
            captureTries += 1;
            const captured = tryCaptureAutoLevelBattleSkeleton(`startupPolling#${captureTries}`);
            if (captured || captureTries >= STARTUP_LEVEL_CAPTURE_MAX_TRIES) {
                clearInterval(state.startupCaptureTimer);
                state.startupCaptureTimer = null;
            }
            renderPanel();
        }, STARTUP_LEVEL_CAPTURE_INTERVAL_MS);
        renderPanel();
    }

    function scheduleRuntimeActivation() {
        if (state.runtimeReady || state.runtimeActivating) {
            return;
        }
        state.runtimeActivating = true;
        const elapsed = Number.isFinite(performance.now()) ? performance.now() : 0;
        const waitMs = elapsed >= STARTUP_RUNTIME_DELAY_MS
            ? 0
            : Math.max(0, STARTUP_RUNTIME_DELAY_MS - elapsed);
        state.runtimeDelayedUntil = Utils.now() + waitMs;
        Utils.pushDataSource(`启动保护已启用，${waitMs}ms 后再接管战斗运行时`);
        setTimeout(() => {
            try {
                finishRuntimeActivation();
            } catch (error) {
                state.runtimeActivating = false;
                Utils.warn('延迟接管战斗运行时失败', error);
                setTimeout(scheduleRuntimeActivation, 2000);
            }
        }, waitMs);
    }

    async function init() {
        if (state.inited) {
            return;
        }
        loadCandidates();
        loadReusableSkeleton(false);
        loadPanelState();
        state.panelPrefs.collapsed = true;
        savePanelState();
        exposeDebugApi();
        createPanel();
        renderPanel();
        injectMainPanelButton();
        scheduleRuntimeActivation();
        state.inited = true;
        setInterval(() => {
            try {
                renderPanel();
            } catch (error) {
                Utils.warn('面板刷新失败', error);
            }
        }, 1500);
    }

    function bootstrap() {
        if (state.inited) {
            return;
        }
        if (!Runtime.isReady()) {
            setTimeout(bootstrap, 1000);
            return;
        }
        init().catch((error) => {
            Utils.error('初始化失败', error);
            setTimeout(bootstrap, 2000);
        });
    }

    bootstrap();
}());
