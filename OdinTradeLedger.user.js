// ==UserScript==
// @name         Odin Trade Ledger (Weav3r Receipt + Pricelist)
// @version      1.0.1
// @downloadURL  https://github.com/bjornodinsson89/Odin-Trade-Ledger/raw/main/OdinTradeLedger.user.js
// @updateURL    https://github.com/bjornodinsson89/Odin-Trade-Ledger/raw/main/OdinTradeLedger.meta.js
// @author       BjornOdinsson89
// @description  Trade drawer: reads trade log, shows market/lowest bazaar/buy/profit, caches your Weav3r pricelist + receipt
// @icon         https://i.postimg.cc/BQ6bSYKM/file-000000004bb071f5a96fc52564bf26ad-(1).png
// @match        https://www.torn.com/trade.php*
// @match        https://torn.com/trade.php*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      api.torn.com
// @connect      weav3r.dev
// ==/UserScript==

(() => {
  "use strict";

  /******************************************************************
   * Storage Keys
   ******************************************************************/
  const STORE = {
    tornKey: "tth_torn_api_key_v1",
    me: "tth_me_v1", // {playerId,name,fetchedAt}
    itemsIndex: "tth_items_index_v3", // {nameToId, idToMeta, builtAt}
    itemsIndexTS: "tth_items_index_ts_v3",
trades: "tth_trades_v1",
priceListCache: "tth_pricelist_cache_v2", // { ts:number, list:any }
    priceListUi: "tth_pricelist_ui_v1", // { expandedCats: { [cat]: bool }, search: string, showUnpriced: bool }
    drawerDock: "tth_drawer_dock_v1", // 'left' | 'right'
    bazaarCache: "tth_bazaar_cache_v1", // { [itemId]: { ts:number, data:object } }
    marketCache: "tth_itemmarket_cache_v1", // { [itemId]: { ts:number, data:{lowest:number} } }
    tradeCartCache: "tth_trade_cart_cache_v1", // { [tradeKey]: { ts:number, cart:[[name,qty],...] } }
    profitMode: "tth_profit_mode_v1", // 'market' | 'bazaar'
  };

  function getDrawerDock() {
    const v = String(GM_getValue(STORE.drawerDock, "right") || "right").toLowerCase();
    return v === "left" ? "left" : "right";
  }
  function applyDrawerDock(drawerEl) {
    if (!drawerEl) return;
    const dock = getDrawerDock();
    if (dock === "left") drawerEl.classList.add("tth-dock-left");
    else drawerEl.classList.remove("tth-dock-left");
  }
  function setDrawerDock(nextDock) {
    const v = nextDock === "left" ? "left" : "right";
    GM_setValue(STORE.drawerDock, v);
    const drawerEl = document.getElementById("tth-drawer");
    applyDrawerDock(drawerEl);
  }
  function installMenuCommands() {
    if (typeof GM_registerMenuCommand !== "function") return;
    if (window.__tth_menuInstalled) return;
    window.__tth_menuInstalled = 1;
    GM_registerMenuCommand("Odin Ledger: Dock drawer LEFT", () => setDrawerDock("left"));
    GM_registerMenuCommand("Odin Ledger: Dock drawer RIGHT", () => setDrawerDock("right"));
    GM_registerMenuCommand("Odin Ledger: Toggle drawer side", () => {
      const cur = getDrawerDock();
      setDrawerDock(cur === "left" ? "right" : "left");
    });
  }

  /******************************************************************
   * Constants
   ******************************************************************/
  const TORN_ITEMS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const WEAVER_CACHE_TTL_MS = 10 * 60 * 1000;
  const PRICELIST_CACHE_TTL_MS = 5 * 60 * 1000;
  const CART_CACHE_TTL_MS = 3 * 60 * 1000;
  const MAX_CONCURRENCY = 3;
  const BAZAAR_CACHE_MAX_ITEMS = 250;
  const BAZAAR_CACHE_MAX_LISTINGS = 25;
  const bazaarInflight = new Map();

  let __tthScrollY = 0;
  let __tthBodyPrev = null;
  let __tthTouchBlockOff = null;

  function lockBackgroundScroll(drawerEl) {
    try {
      const b = document.body;
      if (!b) return;
      if (b.dataset && b.dataset.tthScrollLock === '1') return;

      __tthScrollY = window.scrollY || 0;
      __tthBodyPrev = {
        position: b.style.position,
        top: b.style.top,
        left: b.style.left,
        right: b.style.right,
        width: b.style.width,
        overflow: b.style.overflow,
        touchAction: b.style.touchAction,
        overscrollBehavior: b.style.overscrollBehavior
      };

      if (b.dataset) b.dataset.tthScrollLock = '1';
      b.style.position = 'fixed';
      b.style.top = '-' + __tthScrollY + 'px';
      b.style.left = '0';
      b.style.right = '0';
      b.style.width = '100%';
      b.style.overflow = 'hidden';
      b.style.touchAction = 'none';
      b.style.overscrollBehavior = 'none';

      if (__tthTouchBlockOff) {
        try { __tthTouchBlockOff(); } catch (_) { console.error("[Odin Ledger] Error:", _); }
        __tthTouchBlockOff = null;
      }

      const handler = (e) => {
        try {
          if (drawerEl && drawerEl.contains(e.target)) return;
          e.preventDefault();
        } catch (_) { console.error("[Odin Ledger] Error:", _); }
      };
      document.addEventListener('touchmove', handler, { passive: false });
      __tthTouchBlockOff = () => {
        try { document.removeEventListener('touchmove', handler, { passive: false }); } catch (_) { console.error("[Odin Ledger] Error:", _); }
      };
    } catch (_) { console.error("[Odin Ledger] Error:", _); }
  }

  function unlockBackgroundScroll() {
    try {
      const b = document.body;
      if (!b) return;
      if (!b.dataset || b.dataset.tthScrollLock !== '1') return;

      b.dataset.tthScrollLock = '';

      if (__tthTouchBlockOff) {
        try { __tthTouchBlockOff(); } catch (_) { console.error("[Odin Ledger] Error:", _); }
        __tthTouchBlockOff = null;
      }

      const prev = __tthBodyPrev || {};
      b.style.position = prev.position || '';
      b.style.top = prev.top || '';
      b.style.left = prev.left || '';
      b.style.right = prev.right || '';
      b.style.width = prev.width || '';
      b.style.overflow = prev.overflow || '';
      b.style.touchAction = prev.touchAction || '';
      b.style.overscrollBehavior = prev.overscrollBehavior || '';

      try { window.scrollTo(0, __tthScrollY); } catch (_) { console.error("[Odin Ledger] Error:", _); }
    } catch (_) { console.error("[Odin Ledger] Error:", _); }
  }

  function readBazaarCache(itemId) {
    try {
      const all = GM_getValue(STORE.bazaarCache, {}) || {};
      const ent = all[String(itemId)] || null;
      if (!ent || !ent.ts || !ent.data) return null;
      if ((nowTs() - Number(ent.ts)) > WEAVER_CACHE_TTL_MS) return null;
      return ent.data;
    } catch (_) {
      return null;
    }
  }

  function writeBazaarCache(itemId, data) {
    try {
      const all = GM_getValue(STORE.bazaarCache, {}) || {};
      const key = String(itemId);
      const cleaned = (data && typeof data === 'object') ? {
        item_id: Number(data.item_id || itemId) || Number(itemId) || 0,
        market_price: Number(data.market_price ?? data.marketPrice ?? data.market_value ?? data.marketValue ?? data.market_value_each ?? data.marketValueEach ?? 0) || 0,
        bazaar_average: Number(data.bazaar_average ?? data.bazaarAverage ?? 0) || 0,
        lowest_price: Number(data.lowest_price ?? data.lowestPrice ?? 0) || 0,
        listings: Array.isArray(data.listings)
          ? data.listings
              .map(l => ({
                player_id: Number(l.player_id || l.playerId || l.user_id || l.userId || 0) || 0,
                player_name: String(l.player_name || l.playerName || l.name || '').trim(),
                price: Number(l.price || l.cost_each || l.costEach || 0) || 0,
                quantity: Number(l.quantity || l.qty || 0) || 0,
                updated: Number(l.updated || l.last_update || l.lastUpdate || 0) || 0
              }))
              .filter(l => l.price > 0 && l.quantity > 0)
              .sort((a,b) => (a.price - b.price) || (b.quantity - a.quantity) || (b.updated - a.updated))
              .slice(0, BAZAAR_CACHE_MAX_LISTINGS)
          : []
      } : null;

      if (!cleaned) return;

      all[key] = { ts: nowTs(), data: cleaned };

      const entries = Object.entries(all)
        .map(([k,v]) => [k, Number(v?.ts || 0)])
        .sort((a,b) => b[1] - a[1]);

      const pruned = {};
      for (let i = 0; i < Math.min(entries.length, BAZAAR_CACHE_MAX_ITEMS); i++) {
        const k = entries[i][0];
        pruned[k] = all[k];
      }

      GM_setValue(STORE.bazaarCache, pruned);
    } catch (_) { console.error("[Odin Ledger] Error:", _); }
  }

  function readTradeCartCache(tradeKey) {
    try {
      if (!tradeKey) return null;
      const all = GM_getValue(STORE.tradeCartCache, {}) || {};
      const ent = all[String(tradeKey)] || null;
      if (!ent || !ent.ts || !ent.cart) return null;
      if ((nowTs() - Number(ent.ts)) > CART_CACHE_TTL_MS) return null;
      const m = new Map();
      for (const pair of (Array.isArray(ent.cart) ? ent.cart : [])) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const name = String(pair[0] || '').trim();
        const qty = Number(pair[1] || 0) || 0;
        if (!name || qty <= 0) continue;
        m.set(name, qty);
      }
      return m;
    } catch (_) {
      return null;
    }
  }

  function writeTradeCartCache(tradeKey, cartMap) {
    try {
      if (!tradeKey) return;
      const all = GM_getValue(STORE.tradeCartCache, {}) || {};
      const arr = [];
      for (const [k,v] of (cartMap instanceof Map ? cartMap.entries() : [])) {
        const name = String(k || '').trim();
        const qty = Number(v || 0) || 0;
        if (!name || qty <= 0) continue;
        arr.push([name, qty]);
      }
      all[String(tradeKey)] = { ts: nowTs(), cart: arr };

      const entries = Object.entries(all)
        .map(([k,v]) => [k, Number(v?.ts || 0)])
        .sort((a,b) => b[1] - a[1]);

      const pruned = {};
      for (let i = 0; i < Math.min(entries.length, 30); i++) {
        const k = entries[i][0];
        pruned[k] = all[k];
      }

      GM_setValue(STORE.tradeCartCache, pruned);
    } catch (_) { console.error("[Odin Ledger] Error:", _); }
  }

  function clearTradeCartCache(tradeKey) {
    try {
      if (!tradeKey) return;
      const all = GM_getValue(STORE.tradeCartCache, {}) || {};
      delete all[String(tradeKey)];
      GM_setValue(STORE.tradeCartCache, all);
    } catch (_) { console.error("[Odin Ledger] Error:", _); }
  }

  const WEAV3R_CATEGORIES = [
    "Alcohol","Armor","Artifact","Booster","Candy","Car","Clothing","Collectible","Drug",
    "Energy Drink","Enhancer","Flower","Jewelry","Material","Medical","Melee","Other",
    "Plushie","Primary","Secondary","Special","Supply Pack","Temporary","Tool"
  ];

  /******************************************************************
   * Utilities
   ******************************************************************/
  const nowTs = () => Date.now();

  function normKey(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripTrailingIdFromName(name, itemId) {
    const n = String(name || '').trim();
    const id = Number(itemId) || 0;
    if (!n) return n;
    if (id > 0) {
      const reId = new RegExp('(?:\s*[\(\[\{#]?' + id + '[\)\]\}]?\s*)$');
      return n.replace(reId, '').trim();
    }
    return n;
  }

  function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return "$" + Math.round(x).toLocaleString();
  }

  function safeJsonParse(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  async function copyToClipboard(text) {
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }

  function gmGetJson(url, { timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { "Accept": "application/json" },
        timeout,
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Request timed out")),
      });
    });
  }

  function gmSendJson(method, url, bodyObj, { timeout = 25000 } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        data: JSON.stringify(bodyObj),
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        timeout,
        onload: (r) => {
          const text = r.responseText || "";
          const data = safeJsonParse(text);
          if (r.status >= 400) {
            const msg = data?.message || data?.error || text || `HTTP ${r.status}`;
            return reject(new Error(msg));
          }
          if (!data) return reject(new Error("Response was not JSON."));
          resolve(data);
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Request timed out")),
      });
    });
  }

  /******************************************************************
   * Torn Logic
   ******************************************************************/
  async function fetchMyUserBasic(tornKey) {
    const url = `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(tornKey)}`;
    const data = await gmGetJson(url);
    if (data?.error) throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
    const playerId = data.player_id ?? data.user_id ?? null;
    const name = data.name ?? null;
    if (!playerId || !name) throw new Error("Unexpected Torn response: missing player_id/name.");
    return { playerId: Number(playerId), name: String(name), fetchedAt: nowTs(), raw: data };
  }

  function guessCategoryFromTornItem(item) {
    const raw = item?.type ?? item?.category ?? item?.item_type ?? item?.itemType ?? "";
    const s = String(raw || "").trim();
    if (!s) return "Other";
    const lc = s.toLowerCase();
    const match = WEAV3R_CATEGORIES.find(c => c.toLowerCase() === lc);
    if (match) return match;
    if (lc.includes("primary")) return "Primary";
    if (lc.includes("secondary")) return "Secondary";
    if (lc.includes("melee")) return "Melee";
    if (lc.includes("medical")) return "Medical";
    if (lc.includes("drug")) return "Drug";
    if (lc.includes("booster")) return "Booster";
    if (lc.includes("candy")) return "Candy";
    if (lc.includes("plush")) return "Plushie";
    if (lc.includes("flower")) return "Flower";
    if (lc.includes("alcohol")) return "Alcohol";
    if (lc.includes("energy")) return "Energy Drink";
    if (lc.includes("tool")) return "Tool";
    if (lc.includes("armor")) return "Armor";
    if (lc.includes("clothing")) return "Clothing";
    if (lc.includes("material")) return "Material";
    if (lc.includes("temporary")) return "Temporary";
    if (lc.includes("collect")) return "Collectible";
    if (lc.includes("special")) return "Special";
    if (lc.includes("supply")) return "Supply Pack";
    if (lc.includes("enhancer")) return "Enhancer";
    if (lc.includes("jewel")) return "Jewelry";
    if (lc.includes("artifact")) return "Artifact";
    if (lc.includes("car")) return "Car";
    return "Other";
  }

  function pickImageUrlFromTornItem(item) {
    const img = item?.image ?? item?.img ?? item?.icon ?? null;
    if (!img) return "";
    if (typeof img === "string") return img;
    if (typeof img === "object") {
      return img.large || img.full || img.preview || img.medium || img.small || img.thumbnail || "";
    }
    return "";
  }

  async function loadItemsIndex(tornKey) {
    const ts = Number(GM_getValue(STORE.itemsIndexTS, 0));
    const cached = GM_getValue(STORE.itemsIndex, null);
    if (cached && (nowTs() - ts) < TORN_ITEMS_TTL_MS) {
      const sanity = cached?.nameToId?.[normKey("Xanax")] || 0;
      if (Number(sanity) === 205) {
        GM_setValue(STORE.itemsIndexTS, "0");
      } else {
        return cached;
      }
    }

    try {
      const url = `https://api.torn.com/v2/torn?selections=items&key=${encodeURIComponent(tornKey)}`;
      const data = await gmGetJson(url);
      if (data?.error) throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
      const items = data?.items;
      if (!items || typeof items !== "object") throw new Error("Unexpected Torn items payload.");

      const nameToId = {};
      const idToMeta = {};

      for (const [idStr, item] of Object.entries(items)) {
        const id = Number(item?.id ?? item?.ID ?? item?.item_id ?? item?.itemID ?? idStr);
        const name = item?.name;
        if (!Number.isFinite(id) || !name) continue;

        const k = normKey(name);
        if (!(k in nameToId)) nameToId[k] = id;
        else if (nameToId[k] !== id) nameToId[k] = 0; // ambiguous (shouldn't happen, but guard)

        const category = guessCategoryFromTornItem(item);
        const imageUrl = pickImageUrlFromTornItem(item);

        idToMeta[id] = {
          id,
          name: String(name),
          category,
          imageUrl,
          raw: item
        };
      }

      const index = { nameToId, idToMeta, builtAt: nowTs() };
      GM_setValue(STORE.itemsIndex, index);
      GM_setValue(STORE.itemsIndexTS, String(nowTs()));
      return index;
    } catch (e) {
      if (cached) return cached;
      throw e;
    }
  }

  function resolveItemIdByName(itemsIndex, itemName) {
    const k = normKey(itemName);
    const id = itemsIndex?.nameToId?.[k] || 0;
    if (Number.isFinite(id) && id > 0) {
      const metaName = String(itemsIndex?.idToMeta?.[id]?.name || "");
      if (!metaName) return id;
      if (normKey(metaName) === k) return id;
    }

    const targetK = normKey(itemName);
    for (const [idStr, meta] of Object.entries(itemsIndex?.idToMeta || {})) {
      if (normKey(meta?.name || "") === targetK) return Number(idStr);
    }


    const stripped = String(itemName || "").replace(/\s*(?:\(|\[)?\s*\d+\s*(?:\)|\])?\s*$/, "").trim();
    if (stripped && stripped !== String(itemName || "")) {
      const id2 = resolveItemIdByName(itemsIndex, stripped);
      if (Number.isFinite(id2) && id2 > 0) return id2;
    }
    return 0;
  }

  /******************************************************************
   * Weav3r API & Caching
   ******************************************************************/
  const queue = [];
  let active = 0;

  async function withConcurrency(fn) {
    if (active >= MAX_CONCURRENCY) await new Promise(res => queue.push(res));
    active++;
    try { return await fn(); }
    finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  }
  async function weaverGetMarketplace(itemId) {
    const url = `https://weav3r.dev/api/marketplace/${encodeURIComponent(String(itemId))}`;
    const j = await gmGetJson(url, { cache: 'no-store' });
    const item_id = (j && (j.item_id ?? j.itemId)) ?? Number(itemId);
    const rawListings = (j && Array.isArray(j.listings)) ? j.listings : [];
    const market_price = (j && typeof j.market_price === 'number') ? j.market_price : ((j && typeof j.marketPrice === 'number') ? j.marketPrice : 0);
    const market_value = (j && typeof j.market_value === 'number') ? j.market_value : ((j && typeof j.marketValue === 'number') ? j.marketValue : 0);
    const bazaar_average = (j && typeof j.bazaar_average === 'number') ? j.bazaar_average : ((j && typeof j.bazaarAverage === 'number') ? j.bazaarAverage : 0);

    const listings = rawListings
      .map((l) => ({
        item_id: Number(l?.item_id ?? l?.itemId ?? item_id) || Number(item_id) || 0,
        player_id: Number(l?.player_id ?? l?.playerId ?? l?.user_id ?? l?.userId ?? 0) || 0,
        player_name: String(l?.player_name ?? l?.playerName ?? l?.name ?? '').trim(),
        price: Number(l?.price ?? l?.cost_each ?? l?.costEach ?? 0) || 0,
        quantity: Number(l?.quantity ?? l?.qty ?? 0) || 0,
        updated: Number(l?.updated ?? l?.last_update ?? l?.lastUpdate ?? 0) || 0,
        raw: l
      }))
      .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.quantity) && l.quantity > 0)
      .sort((a, b) => (a.price - b.price) || (b.quantity - a.quantity) || (b.updated - a.updated));

    return { item_id, market_price, market_value, bazaar_average, listings };
  }

  function extractBazaarLowest(mp) {
    const listings = mp && Array.isArray(mp.listings) ? mp.listings : [];
    let best = 0;
    for (const l of listings) {
      const price = Number(l && (l.price ?? l.cost_each ?? l.costEach));
      if (!Number.isFinite(price) || price <= 0) continue;
      if (best === 0 || price < best) best = price;
    }
    return best;
  }

  function extractMarketValue(mp) {
    if (!mp || typeof mp !== "object") return 0;
    const keys = ['market_price','marketPrice','market_value','marketValue','marketPriceEach','market_price_each','market'];
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(mp, k)) {
        const n = Number(mp[k]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    const nested = mp.market || mp.marketData || null;
    if (nested && typeof nested === "object") {
      for (const k of ['value','price','avg','average','market_price','market_value']) {
        const n = Number(nested[k]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return 0;
  }
async function weaverGetPriceList(userId, opts = {}) {
    const force = !!opts.force;
    const cached = GM_getValue(STORE.priceListCache, null);
    if (!force && cached?.ts && cached?.list && (nowTs() - cached.ts) < PRICELIST_CACHE_TTL_MS) return cached.list;

    const url = `https://weav3r.dev/api/pricelist/${encodeURIComponent(userId)}`;
    const list = await gmGetJson(url, { timeout: 20000 });
    GM_setValue(STORE.priceListCache, { ts: nowTs(), list });
    return list;
  }

  async function weaverGenerateReceipt(myUserId, myUsername, tradeId, items) {
    const url = `https://weav3r.dev/api/pricelist/${encodeURIComponent(myUserId)}`;
    const body = { username: myUsername, tradeID: tradeId, includeMessage: true, items };
    return gmSendJson("POST", url, body, { timeout: 25000 });
  }


  function startPricelistAutoRefresh(userId, onUpdate) {
    let timer = null;

    const tick = async () => {
      try {
        const cached = GM_getValue(STORE.priceListCache, null);
        if (!cached?.ts || (nowTs() - cached.ts) >= PRICELIST_CACHE_TTL_MS) {
          const pl = await weaverGetPriceList(userId, { force: true });
          if (typeof onUpdate === "function") onUpdate(pl);
        }
      } catch (e) {
        console.warn("[Odin Ledger] Pricelist auto-refresh failed", e);
      }
    };

    tick();
    timer = setInterval(tick, 30 * 60 * 1000);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tick();
    });

    return () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
  }

  function normalizeWeaverPricelist(list, itemsIndex) {
    const arr = Array.isArray(list) ? list : (Array.isArray(list?.items) ? list.items : []);
    const out = [];
    for (const raw of arr) {
      const itemId = Number(raw?.itemId ?? raw?.itemID ?? raw?.id);
      if (!Number.isFinite(itemId) || itemId <= 0) continue;

      const meta = itemsIndex?.idToMeta?.[itemId];
      const name = raw?.name || meta?.name || `Item ${itemId}`;
      const buyPrice = Number(raw?.buyPrice ?? raw?.fixedPrice ?? raw?.price ?? 0) || 0;
      const bulkThreshold = raw?.bulkThreshold ?? raw?.bulk_threshold ?? raw?.bulkQty ?? raw?.bulk_qty ?? null;
      const bulkBuyPrice = raw?.bulkBuyPrice ?? raw?.bulk_buy_price ?? raw?.bulkPrice ?? raw?.bulk_price ?? null;
      const marketValue = Number(raw?.market_value ?? raw?.marketValue ?? raw?.market ?? raw?.avg_market ?? raw?.market_price ?? raw?.marketPrice ?? 0) || 0;

      out.push({
        itemId,
        name: String(name),
        buyPrice,
        bulkThreshold: (bulkThreshold == null ? null : Number(bulkThreshold)),
        bulkBuyPrice: (bulkBuyPrice == null ? null : Number(bulkBuyPrice)),
        marketValue,
      });
    }
    return out;
  }

  /******************************************************************
   * Trade Log Watcher
   ******************************************************************/
  function getTradeLogRoot() {
    return document.querySelector("#trade-container ul.log") || document.querySelector("ul.log") || null;
  }

  function parseTradeAction(text) {
    let m = text.match(/\badded\b\s+(.*?)\s+\bto the trade\b/i);
    if (m) return { type: "added", items: parseItemList(m[1]) };
    m = text.match(/\bremoved\b\s+(.*?)\s+\bfrom the trade\b/i);
    if (m) return { type: "removed", items: parseItemList(m[1]) };
    return null;
  }

  function parseItemList(payload) {
    const parts = String(payload || "").split(",").map(s => s.trim()).filter(Boolean);
    const items = [];
    for (const part of parts) {
      const mm = part.match(/^(\d+)\s*x\s*(.+)$/i);
      if (mm) items.push({ qty: Number(mm[1]), name: mm[2].trim() });
    }
    return items;
  }

  function getCurrentTradeId() {
    const h = String(location.hash || "");
    let m = h.match(/\bID=(\d+)\b/i);
    if (m) return Number(m[1]);
    const qs = String(location.search || "");
    m = qs.match(/\bID=(\d+)\b/i);
    if (m) return Number(m[1]);
    return null;
  }

  function hashStr(s) {
    let h = 5381;
    const str = String(s || "");
    const n = Math.min(str.length, 6000);
    for (let i = 0; i < n; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h >>> 0;
    }
    return h.toString(16);
  }

  function getTradeKey() {
    const id = getCurrentTradeId();
    if (id) return `id:${id}`;
    const log = getTradeLogRoot();
    const sig = log ? log.textContent.replace(/\s+/g, " ").trim() : "";
    return `sig:${hashStr(sig)}`;
  }

  function buildCartFromLog(logEl) {
    const cartNorm = new Map();
    if (!logEl) return new Map();
    const msgs = logEl.querySelectorAll("div.msg, .msg");
    for (const msgEl of msgs) {
      const clone = msgEl.cloneNode(true);
      clone.querySelectorAll(".tt-log-value").forEach(n => n.remove());
      const text = clone.textContent.replace(/\s+/g, " ").trim();
      const action = parseTradeAction(text);
      if (!action) continue;
      const sign = action.type === "removed" ? -1 : 1;
      for (const it of action.items) {
        const nk = normKey(it.name);
        const prev = cartNorm.get(nk);
        const nextQty = (prev ? prev.qty : 0) + sign * it.qty;
        if (nextQty > 0) {
          cartNorm.set(nk, { name: prev?.name || it.name, qty: nextQty });
        } else {
          cartNorm.delete(nk);
        }
      }
    }
    const cart = new Map();
    for (const v of cartNorm.values()) cart.set(v.name, v.qty);
    return cart;
  }


  function syncCartFromTrade(drawer, opts) {
    const force = !!(opts && opts.force);
    const tradeKey = getTradeKey();
    drawer.state.activeTradeKey = tradeKey;

    if (!force) {
      const cached = readTradeCartCache(tradeKey);
      if (cached) {
        drawer.state.cart = cached;
        prefetchCartMarketplaces(drawer, cached);
        drawer.scheduleRender();
        return;
      }
    } else {
      clearTradeCartCache(tradeKey);
    }

    const log = getTradeLogRoot();
    const cart = buildCartFromLog(log);
    drawer.state.cart = cart;
    writeTradeCartCache(tradeKey, cart);
    prefetchCartMarketplaces(drawer, cart);
    drawer.scheduleRender();
  }

  function resetCartState({ state, scheduleRender }) {
    if (state && state.cart instanceof Map) state.cart.clear();
    else if (state) state.cart = new Map();
    if (state) {
      state.activeTradeKey = null;
      state.seller = null;
    }
    if (typeof scheduleRender === 'function') scheduleRender();
  }


  function watchTradeLog({ myUserId, onUpdate }) {
    let currentLog = null;
    let obs = null;
    let seen = new WeakSet();
    let cart = new Map();
    let seller = null;

    const cleanMsgText = (msgEl) => {
      const clone = msgEl.cloneNode(true);
      clone.querySelectorAll(".tt-log-value").forEach(n => n.remove());
      return clone.textContent.replace(/\s+/g, " ").trim();
    };

    const cartNorm = new Map();
    const touchCart = (itemName, qtyDelta) => {
      const nk = normKey(itemName);
      const prev = cartNorm.get(nk);
      const nextQty = (prev ? prev.qty : 0) + qtyDelta;
      if (nextQty > 0) cartNorm.set(nk, { name: prev?.name || itemName, qty: nextQty });
      else cartNorm.delete(nk);
    };
    const buildDisplayCart = () => {
      const out = new Map();
      for (const v of cartNorm.values()) out.set(v.name, v.qty);
      return out;
    };


    const rebuildFromAll = (logEl) => {
      cart = new Map();
      seller = null;
      seen = new WeakSet();
      cartNorm.clear();

      const msgs = logEl.querySelectorAll("div.msg, .msg");
      for (const msgEl of msgs) {
        seen.add(msgEl);

        const a = msgEl.querySelector('a[href*="profiles.php?XID="]');
        if (a) {
          const m = (a.getAttribute("href") || "").match(/XID=(\d+)/i);
          const actorId = m ? Number(m[1]) : null;
          if (!seller && actorId && actorId !== myUserId) {
            seller = { actorId, actorName: a.textContent.trim() };
          }
        }

        const action = parseTradeAction(cleanMsgText(msgEl));
        if (action) {
          const sign = action.type === "removed" ? -1 : 1;
          for (const it of action.items) {
            touchCart(it.name, sign * it.qty);
          }
        }
      }

      cart = buildDisplayCart();
      onUpdate?.({ cart, seller });
    };

    const scanNew = (logEl) => {
      const msgs = logEl.querySelectorAll("div.msg, .msg");
      let changed = false;

      for (const msgEl of msgs) {
        if (seen.has(msgEl)) continue;
        seen.add(msgEl);

        const a = msgEl.querySelector('a[href*="profiles.php?XID="]');
        if (a) {
          const m = (a.getAttribute("href") || "").match(/XID=(\d+)/i);
          const actorId = m ? Number(m[1]) : null;
          if (!seller && actorId && actorId !== myUserId) {
            seller = { actorId, actorName: a.textContent.trim() };
            changed = true;
          }
        }

        const action = parseTradeAction(cleanMsgText(msgEl));
        if (!action) continue;

        const sign = action.type === "removed" ? -1 : 1;
        for (const it of action.items) {
          touchCart(it.name, sign * it.qty);
          changed = true;
        }
      }

      if (changed) {
        cart = buildDisplayCart();
        onUpdate?.({ cart, seller });
      }
    };

    const attach = (logEl) => {
      currentLog = logEl;
      if (obs) {
        try { obs.disconnect(); } catch (_) { console.error("[Odin Ledger] Error:", _); }
        obs = null;
      }
      rebuildFromAll(logEl);
      obs = new MutationObserver(() => scanNew(logEl));
      obs.observe(logEl, { childList: true, subtree: true });
    };

    const tick = () => {
      const log = getTradeLogRoot();
      if (!log) return;
      if (log !== currentLog) attach(log);
    };

    tick();
    const timer = setInterval(tick, 1500);

    return {
      stop: () => {
        try { if (obs) obs.disconnect(); } catch (_) { console.error("[Odin Ledger] Error:", _); }
        clearInterval(timer);
      }
    };
  }


/******************************************************************
   * UI Styles (Weav3r-esque)
   ******************************************************************/
  function uiStyles() {
    if (document.getElementById("tth-main-styles")) return;
    const tag = document.createElement("style");
    tag.id = "tth-main-styles";
    tag.textContent = `
      #tth-drawer-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:9000;display:none;}
      #tth-drawer-backdrop.open{display:block;}
      #tth-drawer{position:fixed;top:50%;right:0;height:75vh;width:min(520px,95vw);background:#121212;color:#e2e2e2;z-index:9001;border-left:1px solid #333;box-shadow:-5px 0 25px rgba(0,0,0,.8);transform:translateX(110%) translateY(-50%);transition:transform .25s ease;display:flex;flex-direction:column;font-family: system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;}
      #tth-drawer.open{transform:translateX(0) translateY(-50%);}
      #tth-drawer header{padding:14px 14px 12px;background:#0f0f0f;border-bottom:1px solid #2a2a2a;display:flex;justify-content:space-between;align-items:center;gap:10px;}
      #tth-title{font-size:16px;font-weight:800;color:#fff;letter-spacing:.2px;}
      #tth-userchip{font-size:12px;color:#9aa0a6;margin-top:2px;}
      #tth-body{flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;padding:14px;background:#0b0b0b;}

      /* Tabs */
      #tth-tabs{display:flex;background:#0f0f0f;padding:0 6px;border-bottom:1px solid #2a2a2a;}
      #tth-tabs button{flex:1;padding:10px 8px;background:transparent;border:none;border-bottom:2px solid transparent;color:#7a7a7a;cursor:pointer;font-weight:700;transition: .15s;}
      #tth-tabs button.active{color:#7fb7ff;border-bottom-color:#7fb7ff;}

      /* Common */
      .tth-card{background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02));border:1px solid rgba(127,183,255,.20);border-radius:14px;padding:14px;margin-bottom:12px;}
      .tth-btn{padding:6px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#fff;font-weight:800;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;user-select:none;-webkit-tap-highlight-color:transparent;}
      .tth-btn.icon{width:34px;justify-content:center;padding:6px 0;}
      .tth-btn:active{transform:translateY(1px);filter:brightness(1.1);}
      .tth-btn.primary{background:linear-gradient(180deg,#3d7f3d 0%, #275127 100%);border-color:rgba(111,226,111,.35);color:#eaffea;}
      .tth-btn.danger{background:#ef4444;border-color:#dc2626;color:#fff;}
      .tth-btn.square{width:44px;min-width:44px;padding:6px 0;}
      .tth-btn.fee-active{box-shadow:0 0 0 1px rgba(21,211,154,.55), 0 0 12px rgba(21,211,154,.45);border-color:rgba(21,211,154,.75);}
      .tth-input, .tth-select{background:rgba(0,0,0,.35);border:1px solid rgba(127,183,255,.22);color:#fff;padding:10px;border-radius:10px;outline:none;}
      .tth-input:focus,.tth-select:focus{border-color:#7fb7ff;}

      /* Table */
      .tth-table-container{overflow:auto;flex:1;min-height:0;max-height:none;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-x pan-y;border-radius:14px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);}
      table.tth-table{width:100%;border-collapse:collapse;font-size:12px;color:#e8e8e8;}
      .tth-table th{background:rgba(255,255,255,.04);padding:14px 18px;text-align:left;color:#a0a0a0;font-weight:800;border-bottom:1px solid rgba(255,255,255,.10);}
      .tth-table thead th{position:sticky;top:0;z-index:5;background:rgba(15,15,15,.92);backdrop-filter:blur(6px);box-shadow:0 1px 0 rgba(255,255,255,.10);}
      .tth-table td{padding:12px 18px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:middle;color:#e8e8e8;}
      .tth-table th.num, .tth-table td.num{min-width:96px;}
      .tth-table th.num{padding-left:20px;padding-right:26px;}
      .tth-table td.num{padding-left:20px;padding-right:26px;letter-spacing:.2px;}
      .tth-table th:not(:last-child), .tth-table td:not(:last-child){border-right:1px solid rgba(255,255,255,.12);}
      .tth-table th:first-child, .tth-table td:first-child{padding-left:16px;}
      .tth-table tr:hover{background:rgba(255,255,255,.02);}
      .tth-table .num{text-align:left;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;white-space:nowrap;}
      .otl-item-cell{display:flex;align-items:center;gap:14px;min-width:180px;}
      .otl-item-img{width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);object-fit:contain;flex:0 0 auto;}
      .otl-item-name{font-weight:900;color:#f1f1f1;line-height:1.05;}
      .otl-item-sub{font-size:12px;color:#8c8c8c;margin-top:2px;}
      .otl-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid rgba(127,183,255,.22);background:rgba(127,183,255,.08);color:#7fb7ff;font-weight:900;font-size:12px;}
      .otl-profit{font-weight:900;}
      @media (max-width:520px){
        table.tth-table{font-size:12px;}
        .tth-table th,.tth-table td{padding:10px 16px;}
      }

      /* Price List */
      .pl-toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;}
      .pl-toolbar .left{display:flex;gap:10px;align-items:center;flex:1;min-width:240px;}
      .pl-toolbar .right{display:flex;gap:8px;align-items:center;justify-content:flex-end;}
      .pl-search{flex:1;min-width:160px;}
      .pl-pill{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(127,183,255,.18);background:rgba(127,183,255,.08);color:#7fb7ff;border-radius:999px;padding:5px 8px;font-size:11px;font-weight:900;}
      .pl-bulk{background:linear-gradient(145deg, rgba(127,183,255,.10), rgba(0,0,0,.20));border:1px solid rgba(127,183,255,.22);padding:12px;border-radius:14px;margin-bottom:12px;}
      .pl-input-group{display:flex;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);border-radius:10px;overflow:hidden;}
      .pl-input-group input{border:none;background:transparent;width:74px;padding:10px;color:#fff;text-align:center;outline:none;}
      .pl-input-addon{background:rgba(255,255,255,.06);padding:10px 12px;color:#b0b0b0;border-left:1px solid rgba(255,255,255,.10);font-weight:800;}
      .pl-categories{display:flex;gap:10px;margin-bottom:10px;}
      .pl-categories button{flex:1;}
      .pl-category{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.10);border-radius:14px;margin-bottom:10px;overflow:hidden;}
      .pl-cat-header{padding:12px 12px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:10px;}
      .pl-cat-header:active{transform:translateY(1px);}
      .pl-cat-left{display:flex;align-items:center;gap:10px;font-weight:900;}
      .pl-cat-arrow{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);color:#cfcfcf;}
      .pl-cat-count{display:flex;align-items:center;gap:8px;}
      .pl-badge{font-size:11px;padding:3px 9px;border-radius:999px;background:rgba(127,183,255,.10);color:#7fb7ff;border:1px solid rgba(127,183,255,.22);font-weight:900;white-space:nowrap;}
      .pl-cat-body{display:none;border-top:1px solid rgba(255,255,255,.08);padding:10px;}
      .pl-cat-body.open{display:block;}

      .pl-item{padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(0,0,0,.18);margin-bottom:10px;}
      .pl-item-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;}
      .pl-item-info{display:flex;gap:10px;align-items:center;min-width:0;}
      .pl-item-img{width:26px;height:26px;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);flex:0 0 auto;object-fit:contain;}
      .pl-item-name{font-weight:900;color:#f1f1f1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px;}
      .pl-item-sub{font-size:12px;color:#8c8c8c;margin-top:2px;}
      .pl-price{color:#15d39a;font-weight:900;}
      .pl-controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center;}
      .pl-mini{padding:8px 10px;border-radius:10px;font-weight:900;}
      .pl-mini.icon{width:36px;justify-content:center;padding:6px 0;}
      .pl-mini.danger{background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.35);color:#ffb3b3;}
      .pl-mini.on{background:rgba(21,211,154,.12);border-color:rgba(21,211,154,.28);color:#6ff0c8;}
      .pl-mini.off{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.12);color:#cfcfcf;}
      .pl-seg{display:flex;gap:8px;align-items:center;}
      .pl-help{font-size:12px;color:#8c8c8c;margin-top:6px;line-height:1.2;}
      .pl-muted{color:#8c8c8c;}
      #tth-open-host{display:inline-flex;align-items:center;gap:8px;pointer-events:none;}
      #tth-open{position:relative;z-index:8999;margin-right:8px;padding:5px 10px;background:linear-gradient(180deg,#3a3f44 0%, #2b2f33 100%);color:#e9eef3;border-radius:10px;border:1px solid rgba(255,255,255,.18);font-weight:900;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;letter-spacing:.15px;box-shadow:0 4px 10px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.10);transition:transform .12s ease, filter .12s ease, box-shadow .12s ease;}#tth-open:hover{filter:brightness(1.06);box-shadow:0 6px 14px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.12);}
      #tth-open:active{transform:translateY(1px) scale(.99);filter:brightness(.98);}
      body.tth-key-modal-open #tth-open{visibility:hidden!important;pointer-events:none!important;}
      .tth-press{transform:translateY(1px)!important;filter:brightness(1.08)!important;}
      .pl-mini.inflation.on{box-shadow:0 0 0 1px rgba(34,197,94,.55), 0 0 12px rgba(34,197,94,.35)!important;}

      /* Drawer docking */
      #tth-drawer.tth-dock-left{left:0!important;right:auto!important;border-radius:0 18px 18px 0!important;transform:translateX(-110%) translateY(-50%)!important;}
      #tth-drawer.tth-dock-left.open{transform:translateX(0) translateY(-50%)!important;}

      /* API Key Modal */
      #tth-key-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2147483646;display:none;}
      #tth-key-modal-backdrop.open{display:flex;align-items:center;justify-content:center;padding:18px;}
      #tth-key-modal{position:relative;z-index:2147483647;width:min(520px,92vw);max-height:86vh;overflow:auto;background:#0f0f0f;border:1px solid rgba(127,183,255,.22);border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.85);padding:16px;color:#e8e8e8;}
      #tth-key-modal h3{margin:0 0 10px;font-size:15px;font-weight:1000;color:#fff;letter-spacing:.2px;}
      #tth-key-modal .tth-disclaimer{font-size:12px;color:#b0b0b0;line-height:1.25;margin-bottom:12px;}
      #tth-key-modal .tth-disclaimer b{color:#eaeaea;}
      #tth-key-modal .tth-ack{display:flex;gap:10px;align-items:flex-start;margin:10px 0 12px;padding:10px;border:1px solid rgba(255,255,255,.10);border-radius:14px;background:rgba(255,255,255,.03);}
      #tth-key-modal .tth-ack input{margin-top:2px;transform:scale(1.05);}
      #tth-key-modal .tth-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;}
      #tth-key-modal .tth-status{font-size:12px;color:#ffb3b3;margin-top:8px;min-height:16px;}
      #tth-key-modal .tth-ok{color:#6ff0c8;}


    `;
    document.head.appendChild(tag);
  }

  /******************************************************************
   * Drawer Component
   ******************************************************************/
  function createDrawer() {
    uiStyles();
    const backdrop = document.createElement("div");
    backdrop.id = "tth-drawer-backdrop";
    const drawer = document.createElement("div");
    drawer.id = "tth-drawer";
    applyDrawerDock(drawer);
    drawer.innerHTML = `
      <header>
        <div style="min-width:0">
          <div id="tth-title">Odin Trade Ledger</div>
          <div id="tth-userchip">Loading user...</div>
        </div>
        <div style="display:flex;gap:8px;flex:0 0 auto;">
          <button class="tth-btn icon" id="tth-api-key" title="API Key">🔑</button>
          <button class="tth-btn icon" id="tth-refresh-all" title="Refresh">↻</button>
          <button class="tth-btn icon" id="tth-close-drawer" title="Close">✕</button>
        </div>
      </header>
      <div id="tth-body"></div>
    `;
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

let _pressEl = null;
const _pressSel = "button, [role='button'], .pl-cat-header";
const _setPress = (el) => {
  if (!el) return;
  if (_pressEl && _pressEl !== el) _pressEl.classList.remove("tth-press");
  _pressEl = el;
  _pressEl.classList.add("tth-press");
};
const _clearPress = () => {
  if (_pressEl) _pressEl.classList.remove("tth-press");
  _pressEl = null;
};
drawer.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(_pressSel);
  if (el) _setPress(el);
}, { capture: true, passive: true });
drawer.addEventListener("pointerup", _clearPress, { capture: true, passive: true });
drawer.addEventListener("pointercancel", _clearPress, { capture: true, passive: true });
drawer.addEventListener("pointerleave", _clearPress, { capture: true, passive: true });

    const state = {
      open: false,
      seller: null,
      cart: new Map(),
      activeTradeKey: null,
      itemsIndex: null,

      profitMode: String(GM_getValue(STORE.profitMode, "market") || "market").toLowerCase() === "bazaar" ? "bazaar" : "market",

      // Apply the 5% item market fee to profit calcs when enabled (display-only).
      marketFeeCut: false,

      pricelistRaw: [],
      pricelist: [],
      pricelistMap: new Map(),
      bazaarData: {},
      marketData: {},
working: false,
      lastStatus: "",
    };

    const apiBtn = drawer.querySelector('#tth-api-key');
    if (apiBtn) {
      apiBtn.onclick = (e) => {
        try { e.preventDefault(); } catch (_) { console.error("[Odin Ledger] Error:", _); }
        openApiKeyModal({ state }, { prefillKey: GM_getValue(STORE.tornKey, '') });
      };
    }

  function updateMarketplaceInDom(itemId) {
    scheduleRender();
  }


    let scheduleRender = () => {};

    const doRender = () => {
      const body = drawer.querySelector("#tth-body");
      body.innerHTML = "";

      if (state.lastStatus) {
        const status = document.createElement("div");
        status.style.cssText = "padding:8px 6px;font-size:12px;color:#a0a0a0;text-align:center;";
        status.textContent = state.lastStatus;
        body.appendChild(status);
      }

      renderTradeTab(body);
    };

    scheduleRender = () => {
      if (scheduleRender._pending) return;
      scheduleRender._pending = true;
      requestAnimationFrame(() => {
        scheduleRender._pending = false;
        doRender();
      });
    };

    function getItemMeta(itemId) {
      return state.itemsIndex?.idToMeta?.[itemId] || null;
    }

    function getItemImageUrl(itemId) {
      const meta = getItemMeta(itemId);
      let url = meta?.imageUrl || meta?.image || "";
      if (url && url.startsWith("//")) url = "https:" + url;
      if (url && url.startsWith("/")) url = "https://www.torn.com" + url;
      if (!url) url = `https://www.torn.com/images/items/${itemId}/large.png`;
      return url;
    }

    function ensureMarketplace(itemId) {
      if (!itemId) return;
      const now = nowTs();
      const cachedMem = state.bazaarData[itemId] || null;
      const cachedAt = Number(cachedMem?._fetchedAt || 0);
      if (cachedMem && (now - cachedAt) < WEAVER_CACHE_TTL_MS) return;

      const cachedDisk = readBazaarCache(itemId);
      if (cachedDisk && typeof cachedDisk === 'object') {
        const merged = { ...cachedDisk, _fetchedAt: now };
        state.bazaarData[itemId] = merged;
        updateMarketplaceInDom(itemId);
        return;
      }

      if (bazaarInflight.has(itemId)) return;

      const p = weaverGetMarketplace(itemId).then(data => {
        if (data && typeof data === 'object') {
          data._fetchedAt = nowTs();
          state.bazaarData[itemId] = data;
          writeBazaarCache(itemId, data);
          updateMarketplaceInDom(itemId);
        }
      }).catch((e) => {
        console.error("[Odin Ledger] Error:", e);
      }).finally(() => {
        bazaarInflight.delete(itemId);
      });

      bazaarInflight.set(itemId, p);
    }

    function renderTradeTab(body) {

      const actions = document.createElement("div");
      actions.className = "tth-card";
      actions.style.display = "flex";
      actions.style.gap = "8px";
      actions.innerHTML = `
        <button class="tth-btn primary" id="btn-complete-trade" style="flex:2">Complete Trade</button>
        <button class="tth-btn" id="btn-refresh-pricelist" style="flex:1">Refresh Pricelist</button>
        <button class="tth-btn square" id="btn-market-fee" title="Apply 5% item market fee to profit">-5% Fee</button>
        <button class="tth-btn" id="btn-profit-mode" style="flex:1"></button>
      `;
      body.appendChild(actions);

      const totalsBar = document.createElement("div");
      totalsBar.className = "tth-card";
      totalsBar.style.display = "flex";
      totalsBar.style.alignItems = "center";
      totalsBar.style.justifyContent = "space-between";
      totalsBar.style.gap = "10px";
      totalsBar.style.padding = "10px 12px";
      totalsBar.style.marginTop = "10px";
      totalsBar.style.marginBottom = "10px";

      const totalBuyLeft = document.createElement("div");
      totalBuyLeft.style.display = "flex";
      totalBuyLeft.style.alignItems = "baseline";
      totalBuyLeft.style.gap = "8px";
      totalBuyLeft.innerHTML = `<span style="color:rgba(255,255,255,0.65);font-weight:600;">Total Buy:</span><span id="tth-total-buy-val" style="color:#fff;font-weight:800;">—</span>`;

      const copyTotalBuyBtn = document.createElement("button");
      copyTotalBuyBtn.id = "btn-copy-total-buy";
      copyTotalBuyBtn.className = "tth-btn";
      copyTotalBuyBtn.textContent = "Copy";
      copyTotalBuyBtn.style.flex = "0 0 auto";
      copyTotalBuyBtn.style.padding = "10px 12px";

      totalsBar.appendChild(totalBuyLeft);
      totalsBar.appendChild(copyTotalBuyBtn);
      body.appendChild(totalsBar);

      const tableWrap = document.createElement("div");
      tableWrap.className = "tth-table-container";
      const table = document.createElement("table");
      table.className = "tth-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Qty</th>
            <th class="num">Market</th>
            <th class="num">Bazaar</th>
            <th class="num">Buy</th>
            <th class="num">Buy Total</th>
            <th class="num">Profit</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      const tbody = table.querySelector("tbody");

      let hasItems = false;
      let totalBuyAll = 0;
      for (const [key, qty] of state.cart) {
        hasItems = true;
        const itemId = resolveItemIdByName(state.itemsIndex, key);
        const meta = itemId ? getItemMeta(itemId) : null;
        const img = itemId ? getItemImageUrl(itemId) : "";

        const mp = itemId ? (state.bazaarData[itemId] || null) : null;
        const bazaarLowest = mp ? extractBazaarLowest(mp) : 0;
        const marketRaw = mp ? Number(mp.market_price ?? mp.marketPrice ?? 0) : 0;
        const marketPrice = (Number.isFinite(marketRaw) && marketRaw > 1) ? marketRaw : 0;

        const plEntry = itemId ? state.pricelistMap.get(Number(itemId)) : null;

        // Weav3r supports bulk pricing: if qty >= bulkThreshold, prefer bulkBuyPrice.
        let weaverBuy = plEntry ? Number(plEntry.buyPrice) : 0;
        const bulkThreshold = plEntry ? Number(plEntry.bulkThreshold) : NaN;
        const bulkBuyPrice = plEntry ? Number(plEntry.bulkBuyPrice) : NaN;
        if (
          Number.isFinite(bulkThreshold) && bulkThreshold > 0 &&
          Number.isFinite(bulkBuyPrice) && bulkBuyPrice > 0 &&
          Number(qty) >= bulkThreshold
        ) {
          weaverBuy = bulkBuyPrice;
        }
        let buyEa = 0;
        if (Number.isFinite(weaverBuy) && weaverBuy > 0) {
          buyEa = Math.round(weaverBuy);
        } else if (bazaarLowest > 0) {
          buyEa = Math.max(0, Math.round(bazaarLowest * 0.95));
        }

        const buyTotal = buyEa > 0 ? (buyEa * qty) : 0;

        if (buyTotal > 0) totalBuyAll += buyTotal;

        const _profitMode = state.profitMode === "bazaar" ? "bazaar" : "market";
        let profitBase = _profitMode === "bazaar"
          ? (bazaarLowest || 0)
          : ((marketPrice > 1) ? marketPrice : 0);

        // Optional: account for item market's 5% selling fee by reducing the market profit base.
        if (_profitMode === "market" && state.marketFeeCut && profitBase > 0) {
          profitBase = profitBase * 0.95;
        }
        const profitTotal = (profitBase > 0 && buyEa > 0) ? ((profitBase - buyEa) * qty) : 0;
        const profColor = profitTotal >= 0 ? "#15d39a" : "#ff5a5a";
        const profTxt = (profitBase > 0 && buyEa > 0) ? money(profitTotal) : "—";

        const tr = document.createElement("tr");
        tr.classList.add("otl-trade-row");
        tr.dataset.itemId = String(itemId || "");
        tr.dataset.qty = String(qty);
        tr.innerHTML = `
          <td>
            <div class="otl-item-cell">
              ${itemId ? `<img class="otl-item-img" src="${img}" alt="">` : ``}
              <div style="min-width:0;">
                <div class="otl-item-name">${stripTrailingIdFromName(meta?.name || key, itemId)}</div>
                <div class="otl-item-sub">${meta?.category || "Unknown"}</div>
              </div>
            </div>
          </td>
          <td class="num">${qty}</td>
          <td class="num">${(itemId && mp) ? (marketPrice > 1 ? money(marketPrice) : "$0.00") : "—"}</td>
          <td class="num">${bazaarLowest > 0 ? money(bazaarLowest) : "—"}</td>
          <td class="num">${buyEa > 0 ? money(buyEa) : "—"}</td>
          <td class="num">${buyEa > 0 ? money(buyTotal) : "—"}</td>
          <td class="num otl-profit" style="color:${(profitBase > 0 && buyEa > 0) ? profColor : "#8c8c8c"}">${profTxt}</td>
        `;
        tbody.appendChild(tr);
      }

      if (!hasItems) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:#8c8c8c;">No items in trade log...</td></tr>`;
      }

      const totalBuySpan = totalsBar.querySelector("#tth-total-buy-val");
      totalBuySpan.textContent = totalBuyAll > 0 ? money(Math.round(totalBuyAll)) : "—";
      copyTotalBuyBtn.disabled = !(totalBuyAll > 0);
      copyTotalBuyBtn.onclick = async () => {
        const txt = (totalBuySpan.textContent || "").trim();
        if (!txt || txt === "—") return;
        const ok = await copyToClipboard(txt);
        state.lastStatus = ok ? "Total buy copied." : "Copy failed.";
        scheduleRender();
      };

      tableWrap.appendChild(table);
      body.appendChild(tableWrap);

      actions.querySelector("#btn-complete-trade").onclick = completeTrade;

      const _profitBtn = actions.querySelector("#btn-profit-mode");
      if (_profitBtn) {
        _profitBtn.textContent = state.profitMode === "bazaar" ? "Profit: Bazaar" : "Profit: Market";
        _profitBtn.onclick = () => {
          state.profitMode = state.profitMode === "bazaar" ? "market" : "bazaar";
          GM_setValue(STORE.profitMode, state.profitMode);
          scheduleRender();
        };
      }

      const _feeBtn = actions.querySelector("#btn-market-fee");
      if (_feeBtn) {
        _feeBtn.classList.toggle("fee-active", !!state.marketFeeCut);
        _feeBtn.onclick = () => {
          state.marketFeeCut = !state.marketFeeCut;
          scheduleRender();
        };
      }

      actions.querySelector("#btn-refresh-pricelist").onclick = async () => {
        state.lastStatus = "Refreshing pricelist...";
        scheduleRender();
        try {
          GM_setValue(STORE.priceListCache, null);
          const pl = await weaverGetPriceList(state.me.playerId, { force: true });
          state.pricelistRaw = pl;
          state.pricelist = normalizeWeaverPricelist(pl, state.itemsIndex);
          state.pricelistMap = new Map(state.pricelist.map(i => [Number(i.itemId), i]));
          state.lastStatus = "Pricelist refreshed.";
        } catch (e) {
          state.lastStatus = "Pricelist refresh failed: " + e.message;
        }
        scheduleRender();
      };
    }


    // Money Engine
    async function completeTrade() {
      state.working = true;
      state.lastStatus = "Generating receipt...";
      scheduleRender();
      try {
        const items = [];
        for (const [key, qty] of state.cart) {
          const id = resolveItemIdByName(state.itemsIndex, key);
          if (id) items.push({ itemID: id, quantity: qty });
        }
	      const otherName = state.seller?.actorName && String(state.seller.actorName).trim() ? String(state.seller.actorName).trim() : state.me.name;
	      const resp = await weaverGenerateReceipt(state.me.playerId, otherName, Date.now(), items);
        state.lastStatus = "Trade Saved!";
        if (resp?.receiptURL) window.open(resp.receiptURL, "_blank");
      } catch (e) {
        state.lastStatus = "Error: " + e.message;
      } finally {
        state.working = false;
        scheduleRender();
      }
    }

    drawer.querySelector("#tth-close-drawer").onclick = () => {
      drawer.classList.remove("open");
      backdrop.classList.remove("open");
      unlockBackgroundScroll();
      const ob = document.getElementById("tth-open");
      if (ob) ob.style.display = "";
      resetCartState({ state, scheduleRender });
    };
    backdrop.onclick = () => {
      drawer.classList.remove("open");
      backdrop.classList.remove("open");
      unlockBackgroundScroll();
      const ob = document.getElementById("tth-open");
      if (ob) ob.style.display = "";
      resetCartState({ state, scheduleRender });
    };

    drawer.querySelector("#tth-refresh-all").onclick = async () => {
      state.lastStatus = "Refreshing items + pricelist...";
      scheduleRender();
      try {
        GM_setValue(STORE.itemsIndexTS, "0");
        GM_setValue(STORE.priceListCache, null);
        state.itemsIndex = await loadItemsIndex(state.tornKey);
        const pl = await weaverGetPriceList(state.me.playerId, { force: true });
        state.pricelistRaw = pl;
        state.pricelist = normalizeWeaverPricelist(pl, state.itemsIndex);
        state.pricelistMap = new Map(state.pricelist.map(i => [Number(i.itemId), i]));
        state.lastStatus = "Refreshed.";
      } catch (e) {
        state.lastStatus = "Refresh failed: " + e.message;
      }
      syncCartFromTrade({ state, scheduleRender }, { force: true });
      scheduleRender();
    };

    return {
      state,
      open: () => {
        const ob = document.getElementById("tth-open");
        if (ob) ob.style.display = "none";
        drawer.classList.add("open");
        backdrop.classList.add("open");
        lockBackgroundScroll(drawer);
        syncCartFromTrade({ state, scheduleRender }, { force: false });
        scheduleRender();
      },
      render: scheduleRender,
      scheduleRender: scheduleRender
    };
  }

  function prefetchCartMarketplaces(drawer, cart) {
    try {
      const ids = new Set();
      for (const [name] of (cart || new Map())) {
        const id = resolveItemIdByName(drawer.state.itemsIndex, name);
        if (id) ids.add(id);
      }
      const idArr = [...ids];
      if (!idArr.length) {
        drawer.scheduleRender();
        return;
      }

      const tasks = [];
      const now = nowTs();
      const apiKey = drawer.state.tornKey || GM_getValue(STORE.tornKey, '');

      for (const id of idArr) {
        tasks.push(withConcurrency(async () => {
          if (bazaarInflight.has(id)) return;

          const cachedMem = drawer.state.bazaarData[id] || null;
          const cachedAt = Number(cachedMem?._fetchedAt || 0);
          if (cachedMem && (now - cachedAt) < WEAVER_CACHE_TTL_MS) return;

          const cachedDisk = readBazaarCache(id);
          if (cachedDisk && typeof cachedDisk === 'object') {
            drawer.state.bazaarData[id] = { ...cachedDisk, _fetchedAt: now };
            return;
          }

          const p = weaverGetMarketplace(id).then(data => {
            if (data && typeof data === 'object') {
              data._fetchedAt = nowTs();
              drawer.state.bazaarData[id] = data;
              writeBazaarCache(id, data);
            }
          }).catch((e) => {
            console.error("[Odin Ledger] Error:", e);
          }).finally(() => {
            bazaarInflight.delete(id);
          });

          bazaarInflight.set(id, p);
          return p;
        }));
      }

      if (tasks.length) {
        Promise.all(tasks)
          .then(() => drawer.scheduleRender())
          .catch((e) => console.error("[Odin Ledger] Error:", e));
      } else {
        drawer.scheduleRender();
      }
    } catch (_) {
      console.error("[Odin Ledger] Error:", _);
      drawer.scheduleRender();
    }
  }



  function openApiKeyModal(drawer, opts = {}) {
    try {
      const currentKey = String(GM_getValue(STORE.tornKey, '') || '').trim();

      let bd = document.getElementById('tth-key-modal-backdrop');
      let modal = document.getElementById('tth-key-modal');

      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'tth-key-modal-backdrop';
        bd.innerHTML = `
          <div id="tth-key-modal" role="dialog" aria-modal="true">
            <h3>Odin Ledger • Torn API Key</h3>
            <div class="tth-disclaimer">
              <b>Disclaimer:</b> Odin Trade Ledger is a community userscript and is <b>not affiliated with Torn or Tornw3b</b>.
              Your API key is stored locally in your browser via your userscript manager (Tampermonkey/Violentmonkey) and is used only to fetch:
              <br>• <b>Torn basic account data</b> (your ID/name)
              <br>• <b>Tornw3b / Weav3r market + bazaar data</b> (lowest listings)
              <br>• <b>Your Weav3r price list</b> (for suggested buy prices)
              <br><br><span style="color:#8c8c8c">Never share your API key. Use the minimum-access key that still works for this script.</span>
            </div>

            <input id="tth-key-input" class="tth-input" style="width:100%" placeholder="Paste your public Torn API Key here" spellcheck="false" autocapitalize="off" autocomplete="off" />

            <label class="tth-ack">
              <input id="tth-key-ack" type="checkbox" />
              <div style="min-width:0">
                <div style="font-weight:900;color:#f1f1f1">I acknowledge this key will be used to pull market/bazaar data and my price list.</div>
                <div style="font-size:12px;color:#9aa0a6;margin-top:2px;line-height:1.2">I understand I am responsible for keeping my key private.</div>
              </div>
            </label>

            <div class="tth-actions">
              <button class="tth-btn" id="tth-key-cancel">Cancel</button>
              <button class="tth-btn primary" id="tth-key-save" disabled>Save Key</button>
            </div>
            <div class="tth-status" id="tth-key-status"></div>
          </div>
        `;
        document.body.appendChild(bd);
      }

      modal = document.getElementById('tth-key-modal');
      const input = document.getElementById('tth-key-input');
      const ack = document.getElementById('tth-key-ack');
      const save = document.getElementById('tth-key-save');
      const cancel = document.getElementById('tth-key-cancel');
      const status = document.getElementById('tth-key-status');

      if (!input || !ack || !save || !cancel || !status) return;

      const close = () => {
        try { bd.classList.remove('open'); } catch (_) { console.error("[Odin Ledger] Error:", _); }
        try { document.body.classList.remove('tth-key-modal-open'); } catch (_) { console.error("[Odin Ledger] Error:", _); }
      };

      const update = () => {
        const k = String(input.value || '').trim();
        const ok = k.length > 0 && !!ack.checked;
        save.disabled = !ok;
        if (!ok) {
          status.textContent = '';
          status.classList.remove('tth-ok');
        }
      };

      input.value = (opts.prefillKey != null ? String(opts.prefillKey) : currentKey) || '';
      ack.checked = false;
      status.textContent = '';
      status.classList.remove('tth-ok');
      save.disabled = true;

      input.oninput = update;
      ack.onchange = update;

      cancel.onclick = (e) => {
        e.preventDefault();
        close();
      };

      save.onclick = (e) => {
        e.preventDefault();
        const k = String(input.value || '').trim();
        if (!k) {
          status.textContent = 'Please paste your Torn API key.';
          status.classList.remove('tth-ok');
          return;
        }
        if (!ack.checked) {
          status.textContent = 'Please acknowledge the disclaimer checkbox before saving.';
          status.classList.remove('tth-ok');
          return;
        }
        try {
          GM_setValue(STORE.tornKey, k);
          if (drawer && drawer.state) drawer.state.tornKey = k;
          status.textContent = 'Saved. Reloading…';
          status.classList.add('tth-ok');
          setTimeout(() => {
            try { close(); } catch (_) { console.error("[Odin Ledger] Error:", _); }
            try { location.reload(); } catch (_) { console.error("[Odin Ledger] Error:", _); }
          }, 250);
        } catch (err) {
          status.textContent = 'Save failed: ' + (err?.message || String(err));
          status.classList.remove('tth-ok');
        }
      };

      bd.onclick = (e) => {
        if (e.target === bd) close();
      };

      try{document.body.classList.add('tth-key-modal-open');}catch (_) { console.error("[Odin Ledger] Error:", _); }
      bd.classList.add('open');
      setTimeout(() => {
        try { input.focus(); input.select(); } catch (_) { console.error("[Odin Ledger] Error:", _); }
      }, 50);
      update();
    } catch (_) { console.error("[Odin Ledger] Error:", _); }
  }
/******************************************************************
   * Entry Point
   ******************************************************************/
  async function main() {
    installMenuCommands();
    const drawer = createDrawer();
    const key = GM_getValue(STORE.tornKey, "");

    if (!key) {
      ensureOdinUi(drawer);
      openApiKeyModal(drawer, {});
      return;
    }

    try {
      const me = await fetchMyUserBasic(key);
      drawer.state.me = me;
      drawer.state.tornKey = key;
      document.getElementById("tth-userchip").textContent = `${me.name} [${me.playerId}]`;

      drawer.state.itemsIndex = await loadItemsIndex(key);

      const pl = await weaverGetPriceList(me.playerId);
      drawer.state.pricelistRaw = pl;
      drawer.state.pricelist = normalizeWeaverPricelist(pl, drawer.state.itemsIndex);
      drawer.state.pricelistMap = new Map(drawer.state.pricelist.map(i => [Number(i.itemId), i]));

      startPricelistAutoRefresh(me.playerId, (pl) => {
        drawer.state.pricelistRaw = pl;
        drawer.state.pricelist = normalizeWeaverPricelist(pl, drawer.state.itemsIndex);
        drawer.state.pricelistMap = new Map(drawer.state.pricelist.map(i => [Number(i.itemId), i]));
        drawer.scheduleRender();
      });
      ensureOdinUi(drawer);

      watchTradeLog({
        myUserId: drawer.state.me.playerId,
        onUpdate: ({ cart, seller }) => {
          const key = getTradeKey();
          drawer.state.activeTradeKey = key;
          drawer.state.seller = seller || drawer.state.seller;
          drawer.state.cart = new Map(cart);
          writeTradeCartCache(key, drawer.state.cart);
          prefetchCartMarketplaces(drawer, drawer.state.cart);
          drawer.scheduleRender();
        }
      });

    } catch (e) {
      console.error("[Odin Ledger] Critical Init Error", e);
    }
  }
  function findTradeHeader() {
    const candidates = [
      '#trade-container .content-title',
      'div#trade-container .content-title',
      '#trade .content-title',
      '.trade-wrap .content-title',
      'div.content-title.m-bottom10',
      'div.content-title'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.closest('#tth-drawer')) continue;
      return el;
    }
    return null;
  }

  function findTradeTitleAnchor(headerEl) {
    if (!headerEl) return null;
    const nodes = headerEl.querySelectorAll('h1,h2,h3,h4,span,div,strong,b');
    for (const n of nodes) {
      const t = String(n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (/^Trade\b/i.test(t)) return n;
    }
    const own = String(headerEl.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^Trade\b/i.test(own)) return headerEl;
    return headerEl;
  }
    function pinHostToHeader(host) {
    host.style.position = 'relative';
    host.style.top = '8px';
    host.style.right = '';
    host.style.left = '';
    host.style.bottom = '';
    host.style.float = '';
    host.style.marginLeft = '10px';
    host.style.marginTop = '6px';
    host.style.display = 'inline-flex';
    host.style.alignItems = 'center';
    host.style.verticalAlign = 'middle';
    host.style.zIndex = '1200';
    host.style.pointerEvents = 'none';
  }
  function pinHostToCorner(host) {
    host.style.position = 'fixed';
    host.style.top = '68px';
    host.style.right = '10px';
    host.style.left = '';
    host.style.bottom = '';
    host.style.float = '';
    host.style.marginLeft = '';
    host.style.marginTop = '';
    host.style.zIndex = '1200';
    host.style.pointerEvents = 'none';
  }
  function ensureOdinUi(drawer) {
    try {
      let host = document.getElementById('tth-open-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'tth-open-host';
        document.body.appendChild(host);
      }
      const header = findTradeHeader();
      if (header) {
        const anchor = findTradeTitleAnchor(header);
        if (anchor && anchor !== header) {
          const needsMove = host.parentElement !== header || host.previousSibling !== anchor;
          if (needsMove) anchor.insertAdjacentElement('afterend', host);
        } else {
          if (host.parentElement !== header) header.appendChild(host);
        }
        pinHostToHeader(host);
      } else {
        if (host.parentElement !== document.body) document.body.appendChild(host);
        pinHostToCorner(host);
      }

      let btn = document.getElementById('tth-open');
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'tth-open';
        btn.textContent = 'Odin Ledger';
        btn.style.pointerEvents = 'auto';
        host.appendChild(btn);
      } else if (btn.parentElement !== host) {
        btn.style.pointerEvents = 'auto';
        host.appendChild(btn);
      }
      btn.onclick = () => drawer.open();
      if (window.__tth_uiObserver) {
        try { window.__tth_uiObserver.disconnect(); } catch (_) { console.error("[Odin Ledger] Error:", _); }
        window.__tth_uiObserver = null;
      }

      let t = 0;
      const kick = () => {
        if (t) return;
        t = window.setTimeout(() => {
          t = 0;
          ensureOdinUi(drawer);
        }, 50);
      };
      const obs = new MutationObserver(kick);
      obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
      window.__tth_uiObserver = obs;
    } catch (_) { console.error("[Odin Ledger] Error:", _); }
  }



  main();
})();
