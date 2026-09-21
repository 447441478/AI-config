(function (global) {
    "use strict";

    var API_NAME = "ActivityGiftPopupBlocker";
    var RETRY_INTERVAL = 100;
    var MAX_RETRIES = 300;

    if (global[API_NAME] && global[API_NAME].installed) {
        return;
    }

    var state = {
        installed: false,
        retries: 0,
        timer: null,
        managerClass: null,
        originalPushDialogQueue: null,
        wrappedPushDialogQueue: null,
        firstFaceManagerClass: null,
        originalSetActive: null,
        wrappedSetActive: null,
        blockAllFirstFaces: true,
        blockedNames: [
            "ActivityFestivalSpringFaceDialog24",
            "TimeGiftDialog",
            "TimeComboGiftDialog",
            "ActivitySummer26SpecialFaceDialog"
        ],
        blockedUrls: [
            "ui://qjlsptznv89r0",
            "ui://p11vy2jyxlhgu",
            "ui://09xubnz2l3lx0",
            "ui://xxrehu57lbbx0"
        ]
    };

    function isBlocked(uiProxyClass) {
        var metadata = uiProxyClass && uiProxyClass.uiProxyMetadata;
        var uiClass = metadata && metadata.ui;
        var uiUrl = uiClass && uiClass.URL;
        return state.blockedUrls.indexOf(uiUrl) !== -1;
    }

    function install() {
        if (state.installed) {
            return true;
        }

        var requireFn = global.__require;
        if (typeof requireFn !== "function") {
            return false;
        }

        var uiManagerModule = null;
        try {
            uiManagerModule = requireFn("UIManager");
        } catch (error) {
            return false;
        }

        var UIManager = uiManagerModule && uiManagerModule.UIManager;
        if (!UIManager || !UIManager.prototype ||
            typeof UIManager.prototype.pushDialogQueue !== "function") {
            return false;
        }

        state.managerClass = UIManager;
        state.originalPushDialogQueue = UIManager.prototype.pushDialogQueue;
        state.wrappedPushDialogQueue = function (uiProxyClass) {
            if (isBlocked(uiProxyClass)) {
                return Promise.resolve();
            }
            return state.originalPushDialogQueue.apply(this, arguments);
        };

        UIManager.prototype.pushDialogQueue = state.wrappedPushDialogQueue;

        var firstFaceManagerModule = null;
        try {
            firstFaceManagerModule = requireFn("FirstFaceToPlayerManager");
        } catch (error) {
            UIManager.prototype.pushDialogQueue = state.originalPushDialogQueue;
            state.managerClass = null;
            state.originalPushDialogQueue = null;
            state.wrappedPushDialogQueue = null;
            return false;
        }

        var FirstFaceToPlayerManager = firstFaceManagerModule &&
            firstFaceManagerModule.FirstFaceToPlayerManager;
        if (!FirstFaceToPlayerManager || !FirstFaceToPlayerManager.prototype ||
            typeof FirstFaceToPlayerManager.prototype.setActive !== "function") {
            UIManager.prototype.pushDialogQueue = state.originalPushDialogQueue;
            state.managerClass = null;
            state.originalPushDialogQueue = null;
            state.wrappedPushDialogQueue = null;
            return false;
        }

        state.firstFaceManagerClass = FirstFaceToPlayerManager;
        state.originalSetActive = FirstFaceToPlayerManager.prototype.setActive;
        state.wrappedSetActive = function () {
            if (state.blockAllFirstFaces) {
                return;
            }
            return state.originalSetActive.apply(this, arguments);
        };
        FirstFaceToPlayerManager.prototype.setActive = state.wrappedSetActive;
        state.installed = true;

        if (global.console && typeof global.console.info === "function") {
            global.console.info(
                "[PopupBlocker] Installed: all first-face popups; exact queue blocks:",
                state.blockedNames.join(", ")
            );
        }

        return true;
    }

    function uninstall() {
        if (!state.installed || !state.managerClass) {
            return;
        }

        var prototype = state.managerClass.prototype;
        if (prototype.pushDialogQueue === state.wrappedPushDialogQueue) {
            prototype.pushDialogQueue = state.originalPushDialogQueue;
        }

        var firstFacePrototype = state.firstFaceManagerClass &&
            state.firstFaceManagerClass.prototype;
        if (firstFacePrototype &&
            firstFacePrototype.setActive === state.wrappedSetActive) {
            firstFacePrototype.setActive = state.originalSetActive;
        }

        state.installed = false;
        if (global.console && typeof global.console.info === "function") {
            global.console.info("[PopupBlocker] Uninstalled");
        }
    }

    global[API_NAME] = {
        get installed() {
            return state.installed;
        },
        get blockedNames() {
            return state.blockedNames.slice();
        },
        get blockAllFirstFaces() {
            return state.blockAllFirstFaces;
        },
        install: install,
        uninstall: uninstall
    };

    if (!install()) {
        state.timer = global.setInterval(function () {
            state.retries += 1;
            if (install() || state.retries >= MAX_RETRIES) {
                global.clearInterval(state.timer);
                state.timer = null;

                if (!state.installed && global.console &&
                    typeof global.console.warn === "function") {
                    global.console.warn(
                        "[PopupBlocker] Installation timed out"
                    );
                }
            }
        }, RETRY_INTERVAL);
    }
})(typeof window !== "undefined" ? window : globalThis);
