// ==UserScript==
// @name         隐藏右上角区号水印
// @namespace    xianbei-builtin
// @version      1.0.1
// @description  屏蔽游戏右上角角色与区服调试水印，保持画面干净整洁
// @author       仙贝助手
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/**
 * 咸鱼之王 — 隐藏右上角区号水印 (隐藏右上角区号水印.js)
 *
 * 【安全设计】
 * 1. 仅拦截 ConsoleManager.prototype.showTip，彻底阻止水印创建
 * 2. 严禁修改 FairyGUI 根节点或任何全局 UILayer 的 visible 状态（避免阻塞启动与地图加载）
 * 3. 严禁调用 ConsoleManager 实例的 deinitialize()（避免清理用户角色登录状态）
 * 4. 支持动态开启/关闭与无损还原
 */
(function () {
  'use strict';

  if (window.__xianbeiHideWatermarkInstalled) {
    if (window.__xianbeiHideWatermark && typeof window.__xianbeiHideWatermark.apply === 'function') {
      window.__xianbeiHideWatermark.apply();
    }
    return;
  }
  window.__xianbeiHideWatermarkInstalled = true;

  var state = {
    enabled: true,
    patched: false,
    timer: 0,
    origShowTip: null,
    targetProto: null
  };

  function requireModule(name) {
    try {
      if (typeof window.__require !== 'function') return null;
      return window.__require(name);
    } catch (e) {
      return null;
    }
  }

  function getConsoleManagerClass() {
    var mod = requireModule('ConsoleManager') || requireModule('d1888nMuDxNM7kxdp1o0aLX');
    if (!mod) return null;
    return mod.ConsoleManager || mod.default || mod;
  }

  // 1. Hook ConsoleManager 原型链
  function patchConsoleManager() {
    var CM = getConsoleManagerClass();
    var proto = CM && CM.prototype;
    if (!proto) return false;

    if (!state.targetProto) {
      state.targetProto = proto;
      state.origShowTip = proto.showTip;
    }

    if (proto.showTip !== disabledShowTip) {
      proto.showTip = disabledShowTip;
    }

    // 若已经创建了水印实例，仅将其自身节点隐藏，切勿销毁或触碰全局图层
    hideExistingTip();

    state.patched = true;
    return true;
  }

  function disabledShowTip() {
    if (!state.enabled && typeof state.origShowTip === 'function') {
      return state.origShowTip.apply(this, arguments);
    }
    // 屏蔽状态下直接静默，不创建 _textInst，不往图层添加任何对象
  }

  // 2. 隐藏已存在的水印节点（安全操作：只操作组件自身的 ui 节点）
  function hideExistingTip() {
    try {
      var CM = getConsoleManagerClass();
      if (!CM) return;
      // 检查实例是否已经存在，避免主动触发懒加载 getter
      var inst = CM._instance || CM.instance;
      if (inst && inst._textInst && inst._textInst.inst && inst._textInst.inst.ui) {
        inst._textInst.inst.ui.visible = !state.enabled;
      }
    } catch (e) {}
  }

  function apply() {
    if (!state.enabled) return;
    patchConsoleManager();
  }

  function startMonitor() {
    if (state.timer) return;
    state.timer = window.setInterval(function () {
      if (!state.patched) {
        patchConsoleManager();
      } else {
        hideExistingTip();
      }
    }, 1000);
  }

  function enable() {
    state.enabled = true;
    apply();
    hideExistingTip();
    console.log('[水印屏蔽] 已启用：右上角账号与区服信息已隐藏');
  }

  function disable() {
    state.enabled = false;
    if (state.targetProto && state.origShowTip) {
      state.targetProto.showTip = state.origShowTip;
    }
    hideExistingTip();
    var CM = getConsoleManagerClass();
    if (CM && CM.instance && typeof CM.instance.showTip === 'function') {
      try { CM.instance.showTip(); } catch (e) {}
    }
    console.log('[水印屏蔽] 已禁用：恢复右上角信息显示');
  }

  // 初始化
  apply();
  startMonitor();

  // 导出全局控制 API
  var api = {
    version: '1.0.1',
    apply: apply,
    enable: enable,
    disable: disable,
    isEnabled: function () {
      return state.enabled;
    },
    destroy: function () {
      if (state.timer) {
        window.clearInterval(state.timer);
        state.timer = 0;
      }
      disable();
      delete window.__xianbeiHideWatermark;
      delete window.__xianbeiHideWatermarkInstalled;
    }
  };

  window.__xianbeiHideWatermark = api;
  console.log('[隐藏右上角区号水印.js] 右上角账号与区服水印屏蔽插件已就绪');
})();
