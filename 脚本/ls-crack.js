// ==UserScript==
// @name         ls破解
// @namespace    qa-enhance-standalone
// @version      2.0.0
// @author       qa-trim
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const LOG_TAG = '[QA-Hook]';
  const log = (msg) => {
    console.log(LOG_TAG, msg);
  };

  log('0_xyzw_enhance.user.js 启动，正在初始化底层 Hook 网...');

  // ==========================================
  // 1. Hook Object.freeze 截获 AuthManager 鉴权对象
  // ==========================================
  const rawObjectFreeze = Object.freeze;
  Object.freeze = function (target) {
    if (target && typeof target === 'object') {
      // 判定是否为核心鉴权管理对象 AuthManager
      const isAuthManager =
        'hasPaidRuntimeSession' in target ||
        'validateCardKeyEnvelope' in target ||
        'updatePaidCompatSession' in target ||
        'createPaidWebSocketProof' in target;

      if (isAuthManager) {
        log('🎯 成功截获游戏核心鉴权管理对象 (AuthManager)！正在注入永久 Pro 凭证...');

        // 注入持久化 Pro 授权方法
        target.hasPaidRuntimeSession = function () {
          return true;
        };
        target.isPaidCompatSession = function () {
          return true;
        };
        target.getPaidAuthToken = function () {
          return 'VIP_PERMANENT_PRO';
        };
        target.getPaidAuthMode = function () {
          return 'pro';
        };
        target.getPaidCompatRoleId = function (roleId) {
          return roleId || (window.ROLE && window.ROLE.roleId) || '1';
        };
        target.getPaidCompatRefreshToken = function () {
          return 'VIP_PERMANENT_PRO';
        };
        target.loadPaidCompatRefreshToken = function () {
          return 'VIP_PERMANENT_PRO';
        };
        target.loadPaidCompatSecondaryPassword = function () {
          return '';
        };
        target.loadPaidResumeRuntime = function () {
          return {
            token: 'VIP_PERMANENT_PRO',
            status: 'active'
          };
        };
        target.getPaidProofTime = function () {
          return Date.now();
        };
        target.validateCardKeyEnvelope = function () {
          return true;
        };
        target.establishPaidRuntimeSession = function () {
          return true;
        };
        target.establishPaidCompatSession = function () {
          return true;
        };
        target.updatePaidCompatSession = function () {
          return true;
        };
        target.updatePaidRuntimeToken = function () {
          return true;
        };
        target.persistPaidCompatRefreshToken = function () {
          return true;
        };
        target.persistPaidResumeRuntime = function () {
          return true;
        };
        target.persistPaidCompatSecondaryPassword = function () {
          return true;
        };
        target.clearPaidCompatRefreshToken = function () {
          return Promise.resolve(true);
        };
        target.probePaidCompatStorage = function () {
          return true;
        };
        target.probePaidRuntimeCapabilities = function () {
          return {
            isSupported: true,
            isPaid: true,
            mode: 'pro'
          };
        };
        target.createVerifyPayload = function () {
          return {
            status: 'active',
            cardKey: 'VIP-PERMANENT-PRO',
            tier: 'pro',
            validUntil: 4102415999000,
            features: ['*']
          };
        };
        target.createTakeoverPayload = function () {
          return {};
        };
        target.createResumePayload = function () {
          return {};
        };
        target.createPaidWebSocketProof = function () {
          return '';
        };
        target.clearPaidRuntimeSession = function () { };

        log('✅ AuthManager 永久授权注入完成！');
      }
    }
    return rawObjectFreeze.apply(this, arguments);
  };

  // ==========================================
  // 2. 授权状态与增强功能配置
  // ==========================================
  const ENHANCE_CONFIG = {
  };

  const CARD_STATUS = {
    status: 'active',
    cardKey: 'VIP-PERMANENT-PRO',
    validUntil: 4102415999000,
    tier: 'pro',
    features: ['*']
  };

  const MOCK_AUTH_RESPONSE = {
    code: 'SUCCESS',
    status: 200,
    message: 'success',
    success: true,
    data: {
      status: 'active',
      cardKey: 'VIP-PERMANENT-PRO',
      validUntil: 4102415999000,
      tier: 'pro',
      features: ['*'],
      appliedCount: 1,
      layoutGroupId: 'default',
      layoutGroupID: 'default',
      layoutRevision: 1
    },
    result: {
      status: 'active',
      validUntil: 4102415999000,
      tier: 'pro',
      features: ['*'],
      appliedCount: 1,
      cardStatus: CARD_STATUS,
      layoutGroupId: 'default',
      layoutGroupID: 'default',
      layoutRevision: 1
    },
    payload: {
      status: 'active',
      success: true,
      cardKey: 'VIP-PERMANENT-PRO',
      validUntil: 4102415999000,
      tier: 'pro'
    },
    cardStatus: {
      status: 'active',
      cardKey: 'VIP-PERMANENT-PRO',
      validUntil: 4102415999000,
      tier: 'pro',
      features: ['*']
    }
  };

  // ==========================================
  // 3. Hook 本地存储 (Storage.getItem / removeItem)
  // ==========================================
  const rawGetItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    const rawVal = rawGetItem.call(this, key);
    if (typeof key === 'string') {
      // 拦截并伪造鉴权 Token
      if (
        key === 'qa_auth_token' ||
        key.includes('paid_token') ||
        key.includes('auth_token') ||
        key.includes('refresh_token')
      ) {
        return JSON.stringify({
          token: 'VIP_PERMANENT_PRO',
          refreshToken: 'VIP_PERMANENT_PRO',
          accessToken: 'VIP_PERMANENT_PRO',
          validUntil: 4102415999000,
          status: 'active',
          tier: 'pro'
        });
      }

      // 拦截功能配置项，自动补齐所有增强开关
      if (key.startsWith('qa-game-enhance')) {
        if (!rawVal) return JSON.stringify(ENHANCE_CONFIG);
        try {
          const parsed = JSON.parse(rawVal);
          for (const [k, v] of Object.entries(ENHANCE_CONFIG)) {
            if (parsed[k] === undefined) {
              parsed[k] = v;
            }
          }
          return JSON.stringify(parsed);
        } catch (e) {
          return JSON.stringify(ENHANCE_CONFIG);
        }
      }
    }
    return rawVal;
  };

  const rawRemoveItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (key) {
    // 阻止删除永久授权 Token
    if (key === 'qa_auth_token') return;
    return rawRemoveItem.call(this, key);
  };

  // 初始化写入永久 token 并清理历史追踪
  try {
    localStorage.removeItem('qa-boot-trace');
    localStorage.setItem(
      'qa_auth_token',
      JSON.stringify({
        token: 'VIP_PERMANENT_PRO',
        validUntil: 4102415999000,
        status: 'active'
      })
    );
  } catch (e) { }

  // ==========================================
  // 4. 网络鉴权请求拦截与伪造 (fetch / XHR)
  // ==========================================
  const isAuthRequest = (url) => {
    if (typeof url !== 'string') return false;

    // 排除版本检查相关接口
    if (
      url.includes('version-updates') ||
      url.includes('/versions/') ||
      url.includes('check-update') ||
      url.includes('updates/latest')
    ) {
      return false;
    }

    // 匹配鉴权相关接口
    return (
      url.includes('/device-auth') ||
      url.includes('/device-config') ||
      url.includes('redeem-codes') ||
      url.includes('donation') ||
      url.includes('ldxp.cn') ||
      (url.includes('47.108.20.10') &&
        (url.includes('auth') ||
          url.includes('card') ||
          url.includes('device') ||
          url.includes('layout')))
    );
  };

  // Hook fetch
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function (input, init) {
      const url =
        typeof input === 'string'
          ? input
          : input && input.url
            ? input.url
            : '';

      if (isAuthRequest(url)) {
        log('📡 拦截到鉴权网络请求 (fetch): ' + url);
        return Promise.resolve(
          new Response(JSON.stringify(MOCK_AUTH_RESPONSE), {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          })
        );
      }
      return rawFetch.apply(this, arguments);
    };
  }

  // Hook XMLHttpRequest
  const rawXhrOpen = XMLHttpRequest.prototype.open;
  const rawXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._isAuthRequest = isAuthRequest(url);
    return rawXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (this._isAuthRequest) {
      log('📡 拦截到鉴权网络请求 (XHR)');
      Object.defineProperty(this, 'status', { value: 200, writable: false });
      Object.defineProperty(this, 'readyState', { value: 4, writable: false });
      Object.defineProperty(this, 'responseText', {
        value: JSON.stringify(MOCK_AUTH_RESPONSE),
        writable: false
      });

      setTimeout(() => {
        if (typeof this.onreadystatechange === 'function') {
          this.onreadystatechange();
        }
        if (typeof this.onload === 'function') {
          this.onload();
        }
      }, 0);
      return;
    }
    return rawXhrSend.apply(this, arguments);
  };

  // ==========================================
  // 5. 周期触发卡密激活与状态就绪事件
  // ==========================================
  function dispatchAuthEvents() {
    window.dispatchEvent(
      new CustomEvent('cardKeyActivated', {
        detail: {
          cardKey: 'VIP-PERMANENT-PRO'
        }
      })
    );
    window.dispatchEvent(
      new CustomEvent('cardKeyStatusChanged', {
        detail: {
          active: true
        }
      })
    );
  }

  setTimeout(dispatchAuthEvents, 1000);
  setTimeout(dispatchAuthEvents, 2500);

  // ==========================================
  // 6. 注入全局 CSS 隐藏弹窗与水印
  // ==========================================
  const styleEl = document.createElement('style');
  styleEl.id = 'qa-enhance-standalone-style';
  styleEl.textContent = `
    /* 彻底隐藏所有卡密相关弹窗、绑定按钮与报错浮层 */
    #qa-card-key-modal,
    .qa-card-key-modal,
    [data-layout-action="show-card-key"],
    [data-layout-action="change-paid-secondary-password"],
    [data-layout-action="unbind-card-key"],
    [data-layout-action="refresh-card-key-bindings"],
    div[style*="background: rgba(0, 0, 0, 0.8)"][style*="z-index: 999999"],
    div[style*="background:rgba(0,0,0,0.8)"][style*="z-index:999999"],
    /* 彻底隐藏并移除 roleId / 岚山 全局与面板水印 */
    #qa-watermark,
    #qa-formation-watermark,
    .qa-watermark,
    .qa-watermark-pattern,
    .qa-watermark-item,
    div[class*="watermark"],
    span[class*="watermark"] {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
      width: 0 !important;
      height: 0 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(styleEl);

  // ==========================================
  // 7. 动态监听与清理残留卡密弹窗与水印 (MutationObserver)
  // ==========================================
  const removeModalsAndWatermarks = () => {
    // 隐藏并移除带 watermark 的 DOM 节点
    const watermarkNodes = document.querySelectorAll(
      '#qa-watermark, #qa-formation-watermark, .qa-watermark, .qa-watermark-pattern, .qa-watermark-item, [class*="watermark"]'
    );
    for (const node of watermarkNodes) {
      node.style.setProperty('display', 'none', 'important');
      try {
        node.remove();
      } catch (e) { }
    }

    // 扫描匹配包含卡密/付费提示的弹窗文本
    const candidateNodes = document.querySelectorAll('div, span, p');
    for (const el of candidateNodes) {
      if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
        const text = el.textContent || '';
        if (
          text.includes('付费认证') ||
          text.includes('卡密已过期') ||
          text.includes('功能已停止') ||
          text.includes('PAID_') ||
          text.includes('卡密验证')
        ) {
          log('🛡️ 捕获并清除卡密弹窗文字: ' + text.substring(0, 25));

          // 向上遍历父节点，查找高 z-index (>999) 遮罩浮层并移除
          let cur = el;
          let removedParent = false;
          while (cur && cur.tagName !== 'BODY') {
            const z = parseInt(window.getComputedStyle(cur).zIndex, 10);
            if (!isNaN(z) && z > 999) {
              cur.style.setProperty('display', 'none', 'important');
              try {
                cur.remove();
              } catch (e) { }
              removedParent = true;
              break;
            }
            cur = cur.parentElement;
          }

          // 若未找到高 z-index 容器，移除最近的 div 容器或当前元素
          if (!removedParent) {
            const target = el.closest('div') || el;
            target.style.setProperty('display', 'none', 'important');
            try {
              target.remove();
            } catch (e) { }
          }
        }
      }
    }
  };

  const observer = new MutationObserver(removeModalsAndWatermarks);
  const initObserver = () => {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }
})();