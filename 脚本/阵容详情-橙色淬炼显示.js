// ==UserScript==
// @name         阵容详情-橙色淬炼显示
// @namespace    https://xianbei.assistant/
// @version      5.3.0
// @description  《咸鱼之王》阵容详情界面显示橙色淬炼小圆点及词条高亮（彻底解决字典对象适配与数字计数）
// @author       鸿运当头来 (逆向还原 & 全平台高兼容终极版)
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

/**
 * 阵容详情-橙色淬炼显示 v5.3.0 (高精度数据适配与无痕融合版)
 *
 * 核心原理解析与架构升级:
 * 1. 彻底解决底层数据结构（Object 字典 vs Array）不匹配的致命断层:
 *    - 《咸鱼之王》底层装备 (equipment/equips) 及淬炼槽位 (quenches/quenches2)
 *      均为数字键值对字典 (如 {1: slot1, 2: slot2})，绝非原生 Array。
 *    - 新增 toList 通用展开器，彻底打通所有数据字典与数组。
 * 2. 数字计数优雅呈现:
 *    - 灰色条左侧数字 m_redCount 原版只统计红淬炼；
 *    - 当存在橙色淬炼时，无缝呈现为 "${redCount}+${orangeCount}" (如 1+2)，
 *      紧凑清晰、绝不换行、无任何未解析标签代码！
 * 3. 完美圆点流式呈现:
 *    - 驱动 EquipQuenchColorDot 控制器 (m_color.selectedPage = "red" / "orange")；
 *    - 红点紧跟橙点紧凑排列在 quenchComp 之中。
 */
(() => {
  "use strict";

  const SCRIPT_TAG = "[阵容详情-橙色淬炼 v5.3]";
  const ORANGE_COLOR_HEX = 0xff9500;
  const RED_COLOR_HEX = 0xff3b30;

  function getFgui() {
    return window.fgui || window.fairygui;
  }

  function getRequire() {
    return window.__require || window.require;
  }

  function toList(val) {
    if (!val || typeof val !== "object") return [];
    if (Array.isArray(val)) return val;
    return Object.values(val);
  }

  function getQuenchConf(attrId) {
    try {
      const req = getRequire();
      if (!req) return null;
      const Configs = req("Configs");
      if (Configs && Configs.QuenchAttrConf && typeof Configs.QuenchAttrConf.getById === "function") {
        return Configs.QuenchAttrConf.getById(attrId);
      }
    } catch (_) {}
    return null;
  }

  /**
   * 判断淬炼词条的品质颜色: 'red' | 'orange' | 'other'
   */
  function getQuenchColor(slot) {
    if (!slot) return "other";
    const colorId = Number(slot.colorId || slot.color || slot.quality || 0);
    if (colorId === 6) return "red";
    if (colorId === 5) return "orange";

    const attrId = slot.attrId || slot.id || slot.curQuenchId;
    if (attrId && typeof attrId === "number") {
      const conf = getQuenchConf(attrId);
      if (conf) {
        const confColor = String(conf.color || "").toLowerCase();
        const confColorId = Number(conf.colorId || conf.quality || 0);
        if (confColor === "red" || confColorId === 6) return "red";
        if (confColor === "orange" || confColorId === 5) return "orange";
      }
    }

    const rawColor = String(slot.color || "").toLowerCase();
    if (rawColor === "red" || rawColor === "6") return "red";
    if (rawColor === "orange" || rawColor === "5") return "orange";

    return "other";
  }

  /**
   * 从参数列表与上下文中全方位解析 UI 容器与装备数据
   */
  function resolveQuenchContext(thisArg, args) {
    let quenchComp = null;
    let equipData = null;

    for (const arg of args) {
      if (!arg || typeof arg !== "object") continue;
      if (arg.m_quenchComp) {
        quenchComp = arg.m_quenchComp;
      }
      if (arg.equipment || arg.equips || arg.m_equips || arg.equipList) {
        equipData = arg;
      }
    }

    if (!quenchComp && thisArg) {
      quenchComp = thisArg.m_quenchComp || thisArg.contentPane?.getChild?.("m_quenchComp");
    }
    if (!equipData && thisArg) {
      equipData = thisArg.equipment || thisArg.equips || thisArg.m_hero || thisArg._data || thisArg.data || thisArg;
    }

    return { quenchComp, equipData };
  }

  /**
   * 从装备数据模型中提取所有淬炼词条并分类为红/橙两组 (兼容数组与键值对字典)
   */
  function extractQuenchLists(equipData, args) {
    const redQuenches = [];
    const orangeQuenches = [];

    function processEquip(equip) {
      if (!equip || typeof equip !== "object") return;

      // 方案选择: curQuenchId (1: quenches, 2: quenches2)
      let activeRaw = null;
      if (equip.curQuenchId === 2 && equip.quenches2) {
        activeRaw = equip.quenches2;
      } else if (equip.quenches) {
        activeRaw = equip.quenches;
      } else if (equip.quenches2) {
        activeRaw = equip.quenches2;
      }

      const activeSlots = toList(activeRaw);
      for (const slot of activeSlots) {
        if (!slot || typeof slot !== "object") continue;
        const color = getQuenchColor(slot);
        if (color === "red") redQuenches.push(slot);
        else if (color === "orange") orangeQuenches.push(slot);
      }

      // 淬华词条 (blessQuenches)
      if (equip.blessQuenches) {
        const blessSlots = toList(equip.blessQuenches);
        for (const slot of blessSlots) {
          if (!slot || typeof slot !== "object") continue;
          const color = getQuenchColor(slot);
          if (color === "red") redQuenches.push(slot);
          else if (color === "orange") orangeQuenches.push(slot);
        }
      }
    }

    function searchTarget(target) {
      if (!target || typeof target !== "object") return false;
      const rawEquips = target.equipment || target.equips || target.m_equips || target.equipList;
      if (rawEquips && typeof rawEquips === "object") {
        const list = toList(rawEquips);
        if (list.length > 0) {
          list.forEach(processEquip);
          return redQuenches.length > 0 || orangeQuenches.length > 0;
        }
      }
      return false;
    }

    if (equipData && searchTarget(equipData)) {
      return { redQuenches, orangeQuenches };
    }

    for (const arg of args) {
      if (arg && searchTarget(arg)) {
        return { redQuenches, orangeQuenches };
      }
    }

    return { redQuenches, orangeQuenches };
  }

  /**
   * 核心渲染逻辑
   */
  function renderQuenchInternal(quenchComp, redQuenches, orangeQuenches) {
    const fgui = getFgui();
    if (!quenchComp || !fgui || !fgui.UIPackage) return;

    try {
      const redCount = redQuenches.length;
      const orangeCount = orangeQuenches.length;
      const allQuenches = [...redQuenches, ...orangeQuenches];

      // 1. 更新灰色条左侧的数字计数 m_redCount
      if (quenchComp.m_redCount) {
        if (orangeCount > 0) {
          // 有橙色淬炼时，显示为 "红+橙" (如 "1+2")
          quenchComp.m_redCount.text = `${redCount}+${orangeCount}`;
          quenchComp.m_redCount.visible = true;
          if (quenchComp.m_redCount.width < 50) quenchComp.m_redCount.width = 50;
        } else {
          // 仅有红色时保持原生格式
          quenchComp.m_redCount.text = String(redCount);
          quenchComp.m_redCount.visible = true;
        }
      }

      // 2. 清理旧圆点
      if (!Array.isArray(quenchComp._totalDots)) {
        quenchComp._totalDots = [];
      }
      quenchComp._totalDots.forEach((dot) => {
        try {
          if (dot && typeof dot.removeFromParent === "function") dot.removeFromParent();
        } catch (_) {}
      });
      quenchComp._totalDots = [];

      if (typeof quenchComp.numChildren === "number") {
        for (let i = quenchComp.numChildren - 1; i >= 0; i--) {
          try {
            const child = quenchComp.getChildAt(i);
            if (child && (child.m_color || child.name === "EquipQuenchColorDot" || child.resourceURL?.includes("EquipQuenchColorDot"))) {
              quenchComp.removeChild(child);
            }
          } catch (_) {}
        }
      }

      const totalDots = redCount + orangeCount;
      if (totalDots <= 0) return;

      // 3. 流式排布小圆点
      const compWidth = quenchComp.width || 120;
      const dotSpacing = 24;
      const totalWidth = (totalDots - 1) * dotSpacing;
      const startX = Math.max(0, (compWidth - totalWidth) / 2);

      let dotIndex = 0;
      function createQuenchDot(pageColor) {
        try {
          const dot = fgui.UIPackage.createObject("ui_common", "EquipQuenchColorDot");
          if (!dot) return null;

          if (dot.m_color) {
            if (typeof dot.m_color.setSelectedPage === "function") dot.m_color.setSelectedPage(pageColor);
            else dot.m_color.selectedPage = pageColor;
          }
          const ctrl = typeof dot.getController === "function" ? (dot.getController("m_color") || dot.getController("c1")) : null;
          if (ctrl && ctrl.hasPage && ctrl.hasPage(pageColor)) {
            ctrl.selectedPage = pageColor;
          }

          if (typeof dot.setScale === "function") {
            dot.setScale(0.86, 0.86);
          } else {
            dot.scaleX = 0.86;
            dot.scaleY = 0.86;
          }
          if (dot.node) {
            dot.node.scale = 0.86;
          }

          dot.x = startX + dotIndex * dotSpacing;
          dot.y = 0;
          dotIndex++;

          quenchComp.addChild(dot);
          quenchComp._totalDots.push(dot);
          return dot;
        } catch (e) {
          console.warn(`${SCRIPT_TAG} 创建圆点异常:`, e);
          return null;
        }
      }

      for (let i = 0; i < redCount; i++) createQuenchDot("red");
      for (let i = 0; i < orangeCount; i++) createQuenchDot("orange");

      // 4. 重构词条列表 (若存在)
      if (quenchComp.m_quenchList && allQuenches.length > 0) {
        try {
          if (typeof quenchComp.m_quenchList.setColumnCount === "function") quenchComp.m_quenchList.setColumnCount(3);
          quenchComp.m_quenchList.itemRenderer = function (index, item) {
            if (!item) return;
            const isOrange = index >= redCount;
            const pageColor = isOrange ? "orange" : "red";
            if (item.m_bkType) {
              if (typeof item.m_bkType.setSelectedPage === "function") item.m_bkType.setSelectedPage(pageColor);
              else item.m_bkType.selectedPage = pageColor;
            }
            item.m_fullRed = !isOrange;
            if (isOrange) {
              const orangeCc = window.cc?.color ? window.cc.color(255, 149, 0) : ORANGE_COLOR_HEX;
              if (item.m_color) item.m_color.color = orangeCc;
              if (item.m_simpleAttrName) item.m_simpleAttrName.color = orangeCc;
              if (item.m_fullAttrName) item.m_fullAttrName.color = orangeCc;
            }
          };
          quenchComp.m_quenchList.numItems = allQuenches.length;
        } catch (_) {}
      }

      console.log(`${SCRIPT_TAG} 成功渲染淬炼: 红=${redCount}, 橙=${orangeCount}, 总数=${totalDots}`);
    } catch (err) {
      console.warn(`${SCRIPT_TAG} 渲染异常:`, err);
    }
  }

  function enhanceRenderQuench(thisArg, ...args) {
    try {
      const { quenchComp, equipData } = resolveQuenchContext(thisArg, args);
      if (!quenchComp) return;

      const { redQuenches, orangeQuenches } = extractQuenchLists(equipData, args);
      renderQuenchInternal(quenchComp, redQuenches, orangeQuenches);
    } catch (err) {
      console.warn(`${SCRIPT_TAG} 调度异常:`, err);
    }
  }

  function hookDialogClass(DialogClass, aliasName = "") {
    if (!DialogClass || !DialogClass.prototype) return false;
    const proto = DialogClass.prototype;
    const name = DialogClass.name || aliasName || "UnknownClass";

    let hookedAny = false;

    if (typeof proto._renderQuench === "function" && !proto.__orange_render_hooked__) {
      const origRenderQuench = proto._renderQuench;
      proto.__orange_render_hooked__ = true;
      proto._renderQuench = function (...args) {
        const ret = origRenderQuench.apply(this, args);
        enhanceRenderQuench(this, ...args);
        return ret;
      };
      hookedAny = true;
    }

    if (!proto.__orange_shown_hooked__) {
      const origOnShown = proto.onShown;
      proto.__orange_shown_hooked__ = true;
      proto.onShown = function (...args) {
        const ret = origOnShown ? origOnShown.apply(this, args) : undefined;
        enhanceRenderQuench(this, ...args);
        return ret;
      };
      hookedAny = true;
    }

    if (typeof proto._refreshQuenchItemGlowEffect === "function" && !proto.__orange_glow_hooked__) {
      const origRefreshGlow = proto._refreshQuenchItemGlowEffect;
      proto.__orange_glow_hooked__ = true;
      proto._refreshQuenchItemGlowEffect = function (item, data, ...args) {
        const ret = origRefreshGlow.call(this, item, data, ...args);
        try {
          const color = getQuenchColor(data);
          if (color === "orange" && item) {
            const orangeCc = window.cc?.color ? window.cc.color(255, 149, 0) : ORANGE_COLOR_HEX;
            if (item.m_color) item.m_color.color = orangeCc;
            if (item.m_simpleAttrName) item.m_simpleAttrName.color = orangeCc;
            if (item.m_fullAttrName) item.m_fullAttrName.color = orangeCc;
            if (item.m_fullRed !== undefined) item.m_fullRed = false;
          }
        } catch (_) {}
        return ret;
      };
      hookedAny = true;
    }

    if (hookedAny) {
      console.log(`${SCRIPT_TAG} 成功注入类原型: ${name}`);
    }
    return hookedAny;
  }

  function startInit() {
    const candidateNames = [
      "SpecificsTeamTotalDialog",
      "SpecificsTeamDialog",
      "SpecificsTeamDialogNew",
      "SpecificsTeamTotalDialogNew",
      "TeamSpecificsDialog",
      "HeroDetailDialog"
    ];

    let count = 0;
    const timer = setInterval(() => {
      count++;
      const req = getRequire();

      if (req) {
        for (const name of candidateNames) {
          try {
            const mod = req(name);
            if (mod) {
              const cls = mod[name] || mod.default || mod;
              if (cls && typeof cls === "function") hookDialogClass(cls, name);
            }
          } catch (_) {}
        }
      }

      for (const name of candidateNames) {
        if (window[name] && typeof window[name] === "function") {
          hookDialogClass(window[name], name);
        }
      }

      if (window.cc?.js?._nameToClass) {
        const map = window.cc.js._nameToClass;
        for (const name of candidateNames) {
          if (map[name] && typeof map[name] === "function") {
            hookDialogClass(map[name], name);
          }
        }
        for (const [k, v] of Object.entries(map)) {
          if (v && v.prototype && typeof v.prototype._renderQuench === "function") {
            hookDialogClass(v, k);
          }
        }
      }

      if (count >= 120) clearInterval(timer);
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startInit);
  } else {
    startInit();
  }
})();
