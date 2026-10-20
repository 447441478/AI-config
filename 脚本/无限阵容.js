// ==UserScript==
// @name         无限阵容
// @namespace    http://tampermonkey.net/
// @version      1.42
// @description  保存和切换阵容及科技点，支持官方批量调级、普通/高级科技分离重置与增量升级、皮肤与灵宠玩具切换、全局信号刷新及七彩云S3对象存储云端同步
// @author       You
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";
    try {
        window.__xbInfiniteLineupStatus = "started";
    } catch (error) {}
    
    const LINEUP_EXPORT_SCHEMA_VERSION = 1;
    const LINEUP_DEBUG_ENABLED = true;
    const LINEUP_STORAGE_KEY_PREFIX = "lineup_data_list_";
    const LINEUP_STORAGE_COMPRESSED_PREFIX = "XB_LINEUP_LZW1:";
    function logLineupDebug(label, payload) {
        if (!LINEUP_DEBUG_ENABLED) {
            return;
        }
        try {
            console.log("[LINEUP_DEBUG] " + label, payload || {});
        } catch (error) {}
    }

    function getLineupDebugValueInfo(value) {
        const info = {
            isNull: value === null || value === undefined,
            type: Array.isArray(value) ? "array" : typeof value,
        };
        if (typeof value === "string") {
            info.length = value.length;
            try {
                const parsed = JSON.parse(value);
                info.parsedType = Array.isArray(parsed) ? "array" : typeof parsed;
                info.parsedCount = Array.isArray(parsed)
                    ? parsed.length
                    : parsed && Array.isArray(parsed.configs)
                        ? parsed.configs.length
                        : undefined;
            } catch (error) {
                info.parseError = error && error.message ? error.message : String(error);
            }
        } else if (Array.isArray(value)) {
            info.count = value.length;
        } else if (value && typeof value === "object") {
            info.keys = Object.keys(value).slice(0, 12);
            if (Array.isArray(value.configs)) {
                info.configCount = value.configs.length;
            }
        }
        return info;
    }

    function createLineupConfigId(fallbackIndex = 0) {
        if (
            typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function"
        ) {
            return crypto.randomUUID();
        }
        return (
            Date.now() +
            "-" +
            fallbackIndex +
            "-" +
            Math.random().toString(36).slice(2, 12)
        );
    }

    function ensureConfigIdentity(config, fallbackIndex = 0) {
        const source = config && typeof config === "object" ? config : {};
        const nowIso = new Date().toISOString();
        return {
            ...source,
            id: source.id || createLineupConfigId(fallbackIndex),
            createDate: source.createDate || source.updateDate || nowIso,
            updateDate: source.updateDate || source.createDate || nowIso,
        };
    }

    function mergeConfigsById(localConfigs, cloudConfigs) {
        const merged = new Map();
        // 1. 先把本地有效配置放入 Map（忽略已被本地标记删除的数据）
        (Array.isArray(localConfigs) ? localConfigs : []).forEach((config, index) => {
            const normalized = ensureConfigIdentity(config, index);
            if (!normalized.deleted) {
                merged.set(String(normalized.id), { ...normalized, source: "local" });
            }
        });

        // 2. 将云端配置覆盖进来：云端有效数据具有权威优先权，强制覆盖本地同 ID 配置；
        // 哪怕本地之前删过该 ID，只要云端有有效数据，也必须以云端为准
        (Array.isArray(cloudConfigs) ? cloudConfigs : []).forEach((config, index) => {
            const normalized = ensureConfigIdentity(config, index);
            const key = String(normalized.id);
            if (normalized.deleted) {
                merged.delete(key);
            } else {
                merged.set(key, { ...normalized, source: "cloud" });
            }
        });

        return Array.from(merged.values());
    }

    function formatLineupExportTimestamp(date = new Date()) {
        const pad = (value) => String(value).padStart(2, "0");
        return (
            date.getFullYear() +
            pad(date.getMonth() + 1) +
            pad(date.getDate()) +
            "-" +
            pad(date.getHours()) +
            pad(date.getMinutes()) +
            pad(date.getSeconds())
        );
    }

    function sanitizeLineupFileNamePart(value) {
        const sanitized = String(value || "default")
            .replace(/[\\/:*?"<>|]+/g, "_")
            .slice(0, 64);
        return sanitized || "default";
    }

    function buildLineupExportPayload(configs) {
        return {
            schemaVersion: LINEUP_EXPORT_SCHEMA_VERSION,
            app: "无限阵容",
            userId: String(getUserId()),
            storageKey: getLineupStorageKey(),
            exportedAt: new Date().toISOString(),
            configs: Array.isArray(configs) ? configs : [],
        };
    }

    function downloadLineupJsonFile(payload) {
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: "application/json;charset=utf-8" });
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download =
            "无限阵容-" +
            sanitizeLineupFileNamePart(payload.userId) +
            "-" +
            formatLineupExportTimestamp() +
            ".json";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }

    function readTextFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
            reader.readAsText(file, "utf-8");
        });
    }

    function extractLineupConfigsFromJson(jsonData) {
        if (Array.isArray(jsonData)) {
            return jsonData;
        }
        if (jsonData && Array.isArray(jsonData.configs)) {
            return jsonData.configs;
        }
        if (
            jsonData &&
            jsonData.data &&
            Array.isArray(jsonData.data.configs)
        ) {
            return jsonData.data.configs;
        }
        throw new Error("JSON 文件中未找到 configs 阵容数组");
    }

    function validateImportedLineupConfig(config, index) {
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            throw new Error("第 " + (index + 1) + " 条阵容不是有效对象");
        }
        if (
            !config.deleted &&
            !config.team &&
            !config.formation &&
            !config.research
        ) {
            throw new Error("第 " + (index + 1) + " 条阵容缺少阵容字段");
        }
    }

    async function readLineupConfigsFromJsonFile(file) {
        const text = await readTextFile(file);
        const jsonData = JSON.parse(text);
        const configs = extractLineupConfigsFromJson(jsonData);
        const seenIds = new Set();
        let reassignedIdCount = 0;
        const normalizedConfigs = configs.map((config, index) => {
            validateImportedLineupConfig(config, index);
            let normalizedConfig = ensureConfigIdentity(config, index);
            let configId = String(normalizedConfig.id);
            if (seenIds.has(configId)) {
                normalizedConfig = {
                    ...normalizedConfig,
                    id: createLineupConfigId(index),
                };
                configId = String(normalizedConfig.id);
                reassignedIdCount++;
            }
            seenIds.add(configId);
            return normalizedConfig;
        });
        const sourceUserId =
            jsonData && !Array.isArray(jsonData)
                ? jsonData.userId ||
                  (jsonData.data && jsonData.data.userId) ||
                  ""
                : "";
        return {
            configs: normalizedConfigs,
            sourceUserId: sourceUserId ? String(sourceUserId) : "",
            reassignedIdCount,
        };
    }

    // ==========================================
    // 七彩云对象存储 (7caiyun.com - AWS S3 / MinIO 官方规范) 云端同步模块
    // ==========================================
    const SEVEN_COLOR_STORAGE_KEY = "seven_color_cloud_lineup_config_s3";
    const DEFAULT_SEVEN_COLOR_CONFIG = {
        enabled: false,
        endpoint: "https://s3.7caiyun.com", // 七彩云官方 S3 Endpoint
        region: "us-west",                   // 七彩云官方默认 Region
        accessKey: "",                       // AccessKey
        secretKey: "",                       // SecretKey
        bucket: "",                          // 存储桶名称
        filePath: "xyzw/lineup_{userId}.json", // 对象路径，支持 {userId} 宏
        pathStyle: false,                    // false: 主机模式 (Virtual Host, 推荐), true: 路径模式 (Path Style)
        isPublicBucket: false,               // 是否为公有存储桶（公有桶下载可免签直连）
        autoSync: false,                     // 保存阵容时自动在后台静默推送到七彩云
        lastSyncTime: 0,
        lastSyncStatus: "",
    };

    function getSevenColorConfig() {
        let raw = null;
        try {
            if (typeof GM_getValue === "function") {
                raw = GM_getValue(SEVEN_COLOR_STORAGE_KEY, null);
            }
        } catch (e) {}
        if (!raw && typeof localStorage !== "undefined") {
            try {
                raw = localStorage.getItem(SEVEN_COLOR_STORAGE_KEY);
            } catch (e) {}
        }
        if (typeof raw === "string") {
            try {
                return { ...DEFAULT_SEVEN_COLOR_CONFIG, ...JSON.parse(raw) };
            } catch (e) {}
        } else if (raw && typeof raw === "object") {
            return { ...DEFAULT_SEVEN_COLOR_CONFIG, ...raw };
        }
        return { ...DEFAULT_SEVEN_COLOR_CONFIG };
    }

    function saveSevenColorConfig(newConfig) {
        const merged = { ...getSevenColorConfig(), ...newConfig };
        const str = JSON.stringify(merged);
        try {
            if (typeof GM_setValue === "function") {
                GM_setValue(SEVEN_COLOR_STORAGE_KEY, str);
            }
        } catch (e) {}
        try {
            if (typeof localStorage !== "undefined") {
                localStorage.setItem(SEVEN_COLOR_STORAGE_KEY, str);
            }
        } catch (e) {}
        return merged;
    }

    function buildSevenColorS3Url(cfg, userId) {
        const uid = String(userId || getUserId() || "default");
        const rawPath = String(cfg.filePath || "xyzw/lineup_{userId}.json").trim();
        const key = rawPath.split("{userId}").join(uid).split("{uid}").join(uid).replace(/^\/+/, "");
        const bucket = String(cfg.bucket || "").trim();
        let endpoint = String(cfg.endpoint || "https://s3.7caiyun.com").trim().replace(/\/+$/, "");
        if (!/^https?:\/\//i.test(endpoint)) {
            endpoint = "https://" + endpoint;
        }
        const urlObj = new URL(endpoint);

        if (cfg.pathStyle || !bucket) {
            // Path Style: https://s3.7caiyun.com/<bucket>/<key>
            const bucketPart = bucket ? "/" + encodeURIComponent(bucket) : "";
            return urlObj.origin + bucketPart + "/" + key.split("/").map(encodeURIComponent).join("/");
        } else {
            // Virtual Host Style: https://<bucket>.s3.7caiyun.com/<key>
            const host = bucket + "." + urlObj.host;
            return urlObj.protocol + "//" + host + "/" + key.split("/").map(encodeURIComponent).join("/");
        }
    }

    async function signAwsS3Request({
        method,
        url,
        headers = {},
        body = "",
        accessKey,
        secretKey,
        region = "us-west",
        service = "s3"
    }) {
        const cryptoObj = (typeof window !== "undefined" && window.crypto) || globalThis.crypto;
        if (!cryptoObj || !cryptoObj.subtle) {
            throw new Error("当前浏览器环境不支持 Web Crypto API，无法计算 S3 签名");
        }

        const parsedUrl = new URL(url);
        const host = parsedUrl.host;
        const pathname = parsedUrl.pathname || "/";
        const search = parsedUrl.search ? parsedUrl.search.slice(1) : "";

        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const amzDate = now.getUTCFullYear() +
            pad(now.getUTCMonth() + 1) +
            pad(now.getUTCDate()) + "T" +
            pad(now.getUTCHours()) +
            pad(now.getUTCMinutes()) +
            pad(now.getUTCSeconds()) + "Z";
        const dateStamp = amzDate.slice(0, 8);

        const encoder = new TextEncoder();
        const bodyBytes = typeof body === "string" ? encoder.encode(body) : (body || new Uint8Array(0));
        const payloadHashBuffer = await cryptoObj.subtle.digest("SHA-256", bodyBytes);
        const payloadHash = Array.from(new Uint8Array(payloadHashBuffer))
            .map(b => b.toString(16).padStart(2, "0")).join("");

        // 1. 规范化所有要发送的 HTTP 请求头
        const finalHeaders = {};
        for (const [k, v] of Object.entries(headers || {})) {
            if (v !== undefined && v !== null && String(k).trim()) {
                finalHeaders[String(k).toLowerCase().trim()] = String(v).trim();
            }
        }
        finalHeaders["host"] = host;
        finalHeaders["x-amz-date"] = amzDate;
        finalHeaders["x-amz-content-sha256"] = payloadHash;

        // 2. 筛选必须参与 AWS SigV4 签名的请求头
        // 核心规范：在浏览器/Tampermonkey 环境下，只签名 host 与 x-amz-* 核心安全头；
        // 普通头（如 content-type、accept 等）易被浏览器网络栈或代理格式化/改写，不签入 SignedHeaders 可彻底避免 SignatureDoesNotMatch
        const signableHeaders = {};
        for (const [k, v] of Object.entries(finalHeaders)) {
            if (k === "host" || k.startsWith("x-amz-")) {
                signableHeaders[k] = v;
            }
        }

        const headerKeys = Object.keys(signableHeaders).sort();
        const canonicalHeaders = headerKeys.map(k => k + ":" + signableHeaders[k] + "\n").join("");
        const signedHeaders = headerKeys.join(";");

        const canonicalUri = pathname.split("/").map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/") || "/";
        const canonicalQueryString = search.split("&").filter(Boolean).sort().join("&");

        const canonicalRequest = [
            method.toUpperCase(),
            canonicalUri,
            canonicalQueryString,
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join("\n");

        const canonicalRequestHashBuffer = await cryptoObj.subtle.digest("SHA-256", encoder.encode(canonicalRequest));
        const canonicalRequestHash = Array.from(new Uint8Array(canonicalRequestHashBuffer))
            .map(b => b.toString(16).padStart(2, "0")).join("");

        const credentialScope = dateStamp + "/" + region + "/" + service + "/aws4_request";
        const stringToSign = [
            "AWS4-HMAC-SHA256",
            amzDate,
            credentialScope,
            canonicalRequestHash
        ].join("\n");

        async function hmac(keyBytes, dataBytes) {
            const key = await cryptoObj.subtle.importKey(
                "raw",
                keyBytes,
                { name: "HMAC", hash: "SHA-256" },
                false,
                ["sign"]
            );
            return new Uint8Array(await cryptoObj.subtle.sign("HMAC", key, dataBytes));
        }

        const kSecret = encoder.encode("AWS4" + secretKey);
        const kDate = await hmac(kSecret, encoder.encode(dateStamp));
        const kRegion = await hmac(kDate, encoder.encode(region));
        const kService = await hmac(kRegion, encoder.encode(service));
        const kSigning = await hmac(kService, encoder.encode("aws4_request"));

        const signatureBytes = await hmac(kSigning, encoder.encode(stringToSign));
        const signature = Array.from(signatureBytes)
            .map(b => b.toString(16).padStart(2, "0")).join("");

        finalHeaders["Authorization"] = "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + credentialScope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

        return {
            url,
            headers: finalHeaders,
            body
        };
    }

    function sendUniversalHttpRequest(options) {
        return new Promise((resolve, reject) => {
            const method = (options.method || "GET").toUpperCase();
            const url = options.url;
            const headers = options.headers || {};
            const data = (options.data !== undefined && options.data !== null) ? String(options.data) : null;
            const timeout = options.timeout || 25000;

            const gmxhr = typeof GM_xmlhttpRequest === "function"
                ? GM_xmlhttpRequest
                : (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function" ? GM.xmlHttpRequest : null);

            if (gmxhr) {
                try {
                    gmxhr({
                        method,
                        url,
                        headers,
                        data,
                        timeout,
                        onload: (res) => {
                            resolve({
                                status: res.status,
                                statusText: res.statusText || "",
                                responseText: res.responseText || "",
                                responseHeaders: res.responseHeaders || "",
                            });
                        },
                        onerror: (err) => {
                            reject(new Error("网络请求失败: " + ((err && err.error) || (err && err.message) || "连接异常/跨域被拦截")));
                        },
                        ontimeout: () => {
                            reject(new Error("网络请求超时（" + Math.round(timeout / 1000) + "秒）"));
                        },
                    });
                    return;
                } catch (gmErr) {
                    console.warn("[七彩云S3] GM_xmlhttpRequest 调用异常，尝试回退 fetch:", gmErr);
                }
            }

            if (typeof fetch === "function") {
                const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
                const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
                fetch(url, {
                    method,
                    headers,
                    body: (method === "GET" || method === "HEAD") ? undefined : data,
                    signal: controller ? controller.signal : undefined,
                })
                .then(async (response) => {
                    if (timer) clearTimeout(timer);
                    const responseText = await response.text();
                    resolve({
                        status: response.status,
                        statusText: response.statusText,
                        responseText,
                    });
                })
                .catch((fetchErr) => {
                    if (timer) clearTimeout(timer);
                    reject(new Error("Fetch 失败: " + (fetchErr.message || String(fetchErr))));
                });
                return;
            }

            reject(new Error("当前运行环境不支持网络请求（缺少 GM_xmlhttpRequest 与 fetch）"));
        });
    }

    async function testSevenColorConnection(cfg) {
        if (!cfg.bucket || !cfg.bucket.trim()) {
            return { ok: false, message: "请先填写存储桶名称 (Bucket)" };
        }
        if (!cfg.accessKey || !cfg.accessKey.trim() || !cfg.secretKey || !cfg.secretKey.trim()) {
            return { ok: false, message: "请完整填写 AccessKey 与 SecretKey" };
        }

        const userId = String(getUserId() || "test_user");
        const s3Url = buildSevenColorS3Url(cfg, userId);

        try {
            // 对目标对象发送 HEAD 请求进行探测鉴权
            const signed = await signAwsS3Request({
                method: "HEAD",
                url: s3Url,
                headers: {},
                body: "",
                accessKey: cfg.accessKey.trim(),
                secretKey: cfg.secretKey.trim(),
                region: (cfg.region || "us-west").trim(),
            });

            const response = await sendUniversalHttpRequest({
                method: "HEAD",
                url: signed.url,
                headers: signed.headers,
                timeout: 12000,
            });

            if (response.status >= 200 && response.status < 300) {
                return { ok: true, message: "S3 连通成功！对象已存在 (HTTP " + response.status + ")" };
            }
            if (response.status === 404) {
                return { ok: true, message: "S3 连通与密钥鉴权成功！(云端暂无此角色备份，点击下方「立即上传」即可创建首次备份)" };
            }
            const errDetail = parseSevenColorS3Error(response, "HTTP " + response.status);
            if (response.status === 403) {
                return { ok: false, message: "鉴权失败 (HTTP 403 Forbidden)：" + errDetail + "（请检查 AccessKey/SecretKey、Bucket 名称或存储桶访问权限）" };
            }
            if (response.status === 400) {
                return { ok: false, message: "请求格式错误 (HTTP 400)：" + errDetail + "（请检查 Region 或切换「路径模式/主机模式」）" };
            }
            return { ok: false, message: "七彩云返回状态: HTTP " + response.status + " " + errDetail };
        } catch (error) {
            return { ok: false, message: "连接失败: " + error.message };
        }
    }

    function parseSevenColorS3Error(response, defaultMsg = "未知错误") {
        const text = (response && response.responseText) || "";
        console.error("[七彩云S3] 服务端返回原始响应:", {
            status: response && response.status,
            statusText: response && response.statusText,
            responseText: text,
        });

        const codeMatch = text.match(/<Code>(.*?)<\/Code>/i);
        const msgMatch = text.match(/<Message>(.*?)<\/Message>/i);
        const stringToSignMatch = text.match(/<StringToSign>(.*?)<\/StringToSign>/is);
        const canonicalReqMatch = text.match(/<CanonicalRequest>(.*?)<\/CanonicalRequest>/is);

        if (stringToSignMatch) {
            console.warn("[七彩云S3] 服务端期望的 StringToSign:\n" + stringToSignMatch[1].trim());
        }
        if (canonicalReqMatch) {
            console.warn("[七彩云S3] 服务端期望的 CanonicalRequest:\n" + canonicalReqMatch[1].trim());
        }

        if (codeMatch || msgMatch) {
            const code = codeMatch ? codeMatch[1].trim() : "";
            const msg = msgMatch ? msgMatch[1].trim() : "";
            return [code, msg].filter(Boolean).join(": ");
        }
        return (response && (response.statusText || text.slice(0, 120))) || defaultMsg;
    }

    async function uploadLineupToSevenColor(configs, explicitUserId = null) {
        const cfg = getSevenColorConfig();
        if (!cfg.enabled) {
            throw new Error("七彩云同步未启用，请在设置中开启");
        }
        if (!cfg.bucket || !cfg.bucket.trim()) {
            throw new Error("七彩云未配置存储桶 (Bucket)，请点击「七彩云」按钮完善配置");
        }
        if (!cfg.accessKey || !cfg.secretKey) {
            throw new Error("七彩云未配置 AccessKey / SecretKey");
        }

        const userId = String(explicitUserId || getUserId() || "default");
        const s3Url = buildSevenColorS3Url(cfg, userId);
        const payload = buildLineupExportPayload(configs);
        // 使用紧凑 JSON，杜绝多余缩进与换行符在跨进程/传输过程中被修改成 CRLF 的风险
        const jsonString = JSON.stringify(payload);

        const signed = await signAwsS3Request({
            method: "PUT",
            url: s3Url,
            headers: {
                "content-type": "application/json; charset=utf-8",
            },
            body: jsonString,
            accessKey: cfg.accessKey.trim(),
            secretKey: cfg.secretKey.trim(),
            region: (cfg.region || "us-west").trim(),
        });

        const response = await sendUniversalHttpRequest({
            method: "PUT",
            url: signed.url,
            headers: signed.headers,
            data: signed.body,
            timeout: 30000,
        });

        if (response.status >= 200 && response.status < 300) {
            const now = Date.now();
            saveSevenColorConfig({
                lastSyncTime: now,
                lastSyncStatus: "上传成功 (" + payload.configs.length + " 条阵容)",
            });
            console.log("[七彩云S3] 阵容云端备份上传成功:", {
                userId,
                url: s3Url,
                count: payload.configs.length,
            });
            return { ok: true, count: payload.configs.length, updatedAt: now };
        }

        const errDetail = parseSevenColorS3Error(response, "HTTP " + response.status);
        if (response.status === 403) {
            throw new Error("七彩云 S3 鉴权失败 (HTTP 403)：" + errDetail + "（请检查 AccessKey/SecretKey 是否正确或存储桶写入权限）");
        }
        throw new Error("七彩云 S3 上传失败: HTTP " + response.status + " " + errDetail);
    }

    async function downloadLineupFromSevenColor(explicitUserId = null) {
        const cfg = getSevenColorConfig();
        if (!cfg.enabled) {
            throw new Error("七彩云同步未启用，请在设置中开启");
        }
        if (!cfg.bucket || !cfg.bucket.trim()) {
            throw new Error("七彩云未配置存储桶 (Bucket)，请点击「七彩云」按钮完善配置");
        }

        const userId = String(explicitUserId || getUserId() || "default");
        const s3Url = buildSevenColorS3Url(cfg, userId);

        let finalHeaders = {
            "accept": "application/json, text/plain, */*",
        };

        // 如果是公有 Bucket 且未配置秘钥，可免签直接拉取；否则走标准 SigV4 签名
        if (!cfg.isPublicBucket || (cfg.accessKey && cfg.secretKey)) {
            const signed = await signAwsS3Request({
                method: "GET",
                url: s3Url,
                headers: finalHeaders,
                body: "",
                accessKey: cfg.accessKey.trim(),
                secretKey: cfg.secretKey.trim(),
                region: (cfg.region || "us-west").trim(),
            });
            finalHeaders = signed.headers;
        }

        const response = await sendUniversalHttpRequest({
            method: "GET",
            url: s3Url,
            headers: finalHeaders,
            timeout: 25000,
        });

        if (response.status === 404) {
            saveSevenColorConfig({
                lastSyncStatus: "云端暂无数据 (HTTP 404)",
            });
            return { ok: false, notFound: true, configs: [] };
        }

        if (response.status >= 200 && response.status < 300) {
            let parsed = null;
            try {
                parsed = JSON.parse(response.responseText);
            } catch (jsonErr) {
                throw new Error("七彩云返回的数据不是有效的 JSON 格式");
            }
            const remoteConfigs = extractLineupConfigsFromJson(parsed);
            if (!Array.isArray(remoteConfigs)) {
                throw new Error("七彩云数据中未提取到有效的阵容列表");
            }
            // 真实有效阵容（过滤掉 deleted: true 的墓碑记录）
            const activeConfigs = remoteConfigs.filter(
                (config) => config && !config.deleted && (config.team || config.formation || config.research),
            );
            const now = Date.now();
            saveSevenColorConfig({
                lastSyncTime: now,
                lastSyncStatus: "同步下载成功 (" + activeConfigs.length + " 条阵容)",
            });
            console.log("[七彩云S3] 阵容备份拉取成功:", {
                userId,
                url: s3Url,
                count: remoteConfigs.length,
            });
            return { ok: true, configs: remoteConfigs, updatedAt: now };
        }

        const errDetail = parseSevenColorS3Error(response, response.statusText || "HTTP " + response.status);
        if (response.status === 403) {
            throw new Error("七彩云 S3 鉴权失败 (HTTP 403)：" + errDetail + "（请检查 AccessKey/SecretKey 是否正确或存储桶读取权限）");
        }
        throw new Error("七彩云 S3 下载失败: HTTP " + response.status + " " + errDetail);
    }

    // 七彩云自动后台防抖上传队列
    const sevenColorPendingUploads = new Map();
    function queueSevenColorUpload(userId, configs) {
        const key = String(userId || getUserId() || "default");
        const cfg = getSevenColorConfig();
        if (!cfg.enabled || !cfg.autoSync) {
            return;
        }
        const snapshot = JSON.parse(JSON.stringify(Array.isArray(configs) ? configs : []));
        let state = sevenColorPendingUploads.get(key);
        if (!state) {
            state = { configs: null, timer: null, inFlight: false };
            sevenColorPendingUploads.set(key, state);
        }
        state.configs = snapshot;
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        if (!state.inFlight) {
            state.timer = setTimeout(() => flushSevenColorUpload(key, state), 1200);
        }
    }

    async function flushSevenColorUpload(userId, state) {
        if (!state || state.inFlight) return;
        state.timer = null;
        state.inFlight = true;
        let retryNeeded = false;
        while (state.configs) {
            const snapshot = state.configs;
            state.configs = null;
            try {
                await uploadLineupToSevenColor(snapshot, userId);
            } catch (err) {
                if (!state.configs) state.configs = snapshot;
                retryNeeded = true;
                console.warn("[七彩云S3] 自动静默上传失败，稍后将重试:", err);
                break;
            }
        }
        state.inFlight = false;
        if (retryNeeded || state.configs) {
            state.timer = setTimeout(() => flushSevenColorUpload(userId, state), 20000);
        } else {
            sevenColorPendingUploads.delete(userId);
        }
    }

    async function uploadToCloud() {
        const cfg = getSevenColorConfig();
        const configs = readSavedConfigs();

        if (cfg.enabled) {
            const res = await uploadLineupToSevenColor(configs);
            return res.ok;
        } else {
            throw new Error("七彩云未启用。请点击顶栏「七彩云」按钮开启并配置！");
        }
    }

    async function syncFromCloud(options = {}) {
        const cfg = getSevenColorConfig();
        if (!cfg.enabled) {
            throw new Error("七彩云未启用。请点击顶栏「七彩云」按钮开启并配置！");
        }

        const res = await downloadLineupFromSevenColor();
        if (!res.ok) {
            if (res.notFound) return { ok: false, notFound: true, count: 0 };
            throw new Error(res.error || "七彩云同步拉取失败");
        }

        const cloudConfigs = res.configs;
        if (!Array.isArray(cloudConfigs) || cloudConfigs.length === 0) {
            return { ok: true, count: 0, total: readSavedConfigs().length, empty: true, configs: [] };
        }

        // 仅保留有效阵容，彻底过滤排除历史已删除的墓碑数据（deleted: true）
        const activeCloudConfigs = cloudConfigs.filter(
            (config) => config && !config.deleted && (config.team || config.formation || config.research),
        );
        const cleanedTombstoneCount = cloudConfigs.length - activeCloudConfigs.length;

        // 标准化清洗（与本地导入文件保持完全一致的标准，保证结构与ID完整性）
        const seenIds = new Set();
        let reassignedIdCount = 0;
        const normalizedCloudConfigs = activeCloudConfigs.map((config, index) => {
            try {
                validateImportedLineupConfig(config, index);
            } catch (e) {}
            let normalized = ensureConfigIdentity(config, index);
            let configId = String(normalized.id);
            if (seenIds.has(configId)) {
                normalized = {
                    ...normalized,
                    id: createLineupConfigId(index),
                };
                configId = String(normalized.id);
                reassignedIdCount++;
            }
            seenIds.add(configId);
            return normalized;
        });

        const localConfigs = readSavedConfigs();
        let finalConfigs = [];
        // 默认采用完整覆盖恢复（与本地导入文件保持 100% 一致的行为，确保必定成功生效）
        if (options.forceOverwrite !== false) {
            finalConfigs = normalizedCloudConfigs;
        } else {
            finalConfigs = mergeConfigsById(localConfigs, normalizedCloudConfigs);
        }

        writeSavedConfigs(finalConfigs);
        return {
            ok: true,
            count: normalizedCloudConfigs.length,
            total: finalConfigs.length,
            configs: finalConfigs,
            reassignedIdCount,
            cleanedTombstoneCount,
        };
    }

    // 获取用户ID，用于每个ID独立保存阵容
    function getUserId() {
        try {
            if (typeof window.__require !== "function") {
                logLineupDebug("getUserId runtime not ready", {
                    requireType: typeof window.__require,
                });
                return "default";
            }
            const ServerData = window.__require("ServerData");
            const role = ServerData.ROLE;
            // 尝试获取用户ID，不同游戏可能有不同的属性名
            const userId = role.roleId || role.id || role.userId || role.user_id || role.uid || "default";
            logLineupDebug("getUserId resolved", {
                userId,
                roleId: role && role.roleId,
                id: role && role.id,
                userIdField: role && role.userId,
                uid: role && role.uid,
            });
            return userId;
        } catch (error) {
            console.warn("获取用户ID失败:", error);
            return "default";
        }
    }
    
    // 生成包含用户ID的存储键
    function getLineupStorageKey() {
        const userId = getUserId();
        return LINEUP_STORAGE_KEY_PREFIX + userId;
    }
    const XYZW_RESOURCE_CDN_BASE = "https://xxz-xyzw-res.hortorgames.com/remote";
    const XYZW_RESOURCE_MANIFEST_URL =
        "https://xxz-xyzw.hortorgames.com/login/manifest?platform=hortor&version=0.32.0-android";
    const XYZW_RESOURCE_CACHE_PREFIX = "xyzw_resource_mapper_v3_";
    const XYZW_LEGACY_MAPPING_CACHE_KEY = "xyzw_legacy_resource_mapping_v1";
    const xyzwResourceMapper = createXyzwResourceMapper();
    window.XYZWResourceMapper = xyzwResourceMapper;
    window.importXYZWResourceMapping = (mapping) =>
        xyzwResourceMapper.importLegacyMapping(mapping);

    function createXyzwResourceMapper() {
        const state = {
            bundleVers: null,
            bundleConfigPromises: new Map(),
            bundleConfigs: new Map(),
            bundleAssetIndexes: new Map(),
            configAssetPromises: new Map(),
            configAssets: new Map(),
            configTablePromises: new Map(),
            iconPathIndex: null,
            configLanguageTextMap: null,
            configLanguageTextPromise: null,
            languageTextMap: null,
            languageTextPromise: null,
            legacyIndex: null,
            importJsonPromises: new Map(),
        };
        const getJson = async (url, options = {}) => {
            const response = await fetch(url, {
                cache: options.cache || "force-cache",
                method: options.method || "GET",
                headers: options.headers || undefined,
                body: options.body,
            });
            if (!response.ok) {
                try {
                    const list = (window.__XYZW_ICON_DEBUG__ =
                        window.__XYZW_ICON_DEBUG__ || []);
                    list.push({
                        event: "fetch-failed",
                        time: Date.now(),
                        payload: { url, status: response.status },
                    });
                } catch (error) {}
                throw new Error("资源请求失败: " + response.status + " " + url);
            }
            return response.json();
        };
        const getRuntimeBundleVers = () => {
            const bundleVers =
                window._CCSettings && window._CCSettings.bundleVers;
            return bundleVers && typeof bundleVers === "object"
                ? { ...bundleVers }
                : null;
        };
        const parseManifestBundleVers = (manifest) => {
            let source = manifest;
            if (typeof source === "string") {
                source = JSON.parse(source);
            }
            let body =
                source && (source.body || source.data || source.result || source);
            if (typeof body === "string") {
                body = JSON.parse(body);
            }
            let bundleVers =
                (body && body.bundleVers) ||
                (source && source.bundleVers) ||
                (body && body.data && body.data.bundleVers);
            if (typeof bundleVers === "string") {
                bundleVers = JSON.parse(bundleVers);
            }
            return bundleVers && typeof bundleVers === "object"
                ? bundleVers
                : null;
        };
        const loadBundleVers = async () => {
            if (state.bundleVers && state.bundleVers.icons) {
                return state.bundleVers;
            }
            const runtimeBundleVers = getRuntimeBundleVers();
            try {
                if (typeof window.loadRemoteBundleVers === "function") {
                    await window.loadRemoteBundleVers();
                    const loadedRuntimeBundleVers = getRuntimeBundleVers();
                    if (loadedRuntimeBundleVers) {
                        state.bundleVers = loadedRuntimeBundleVers;
                        return state.bundleVers;
                    }
                }
            } catch (error) {
                console.warn("[资源映射] app.asar 远程版本加载失败，改用独立 manifest 请求", error);
            }
            try {
                const manifest = await getJson(XYZW_RESOURCE_MANIFEST_URL, {
                    method: "POST",
                    cache: "no-store",
                    headers: {
                        Accept: "application/json,text/plain,*/*",
                        "Content-Type": "application/json;charset=UTF-8",
                    },
                    body: "",
                });
                const remoteBundleVers = parseManifestBundleVers(manifest);
                if (remoteBundleVers) {
                    state.bundleVers = {
                        ...(runtimeBundleVers || {}),
                        ...remoteBundleVers,
                    };
                    if (window._CCSettings && window._CCSettings.bundleVers) {
                        Object.assign(
                            window._CCSettings.bundleVers,
                            state.bundleVers,
                        );
                    }
                    return state.bundleVers;
                }
            } catch (error) {
                console.warn("[资源映射] 线上 manifest 读取失败，使用运行时版本", error);
            }
            state.bundleVers = runtimeBundleVers || {};
            return state.bundleVers;
        };
        const getBundleConfig = async (bundleName) => {
            if (state.bundleConfigs.has(bundleName)) {
                return state.bundleConfigs.get(bundleName);
            }
            if (state.bundleConfigPromises.has(bundleName)) {
                return state.bundleConfigPromises.get(bundleName);
            }
            const promise = (async () => {
                const bundleVers = await loadBundleVers();
                const version = bundleVers[bundleName];
                if (!version) {
                    throw new Error("缺少分包版本: " + bundleName);
                }
                const cacheKey =
                    XYZW_RESOURCE_CACHE_PREFIX + bundleName + "_" + version;
                const cachedValue = localStorage.getItem(cacheKey);
                if (cachedValue) {
                    const cachedConfig = JSON.parse(cachedValue);
                    state.bundleConfigs.set(bundleName, cachedConfig);
                    return cachedConfig;
                }
                const url =
                    XYZW_RESOURCE_CDN_BASE +
                    "/" +
                    bundleName +
                    "/config." +
                    version +
                    ".json";
                const config = await getJson(url);
                try {
                    localStorage.setItem(cacheKey, JSON.stringify(config));
                } catch (error) {
                    console.warn("[资源映射] 分包缓存写入失败", bundleName, error);
                }
                state.bundleConfigs.set(bundleName, config);
                return config;
            })();
            state.bundleConfigPromises.set(bundleName, promise);
            return promise;
        };
        const parseCocosJsonAssetPayload = (assetJson) => {
            if (
                assetJson &&
                Array.isArray(assetJson[5]) &&
                assetJson[5][0] &&
                assetJson[5][0][2] &&
                typeof assetJson[5][0][2] === "object"
            ) {
                return assetJson[5][0][2];
            }
            return null;
        };
        const decodeUuid = (uuid) => {
            if (!uuid || typeof uuid !== "string") {
                return "";
            }
            if (uuid.indexOf("-") >= 0 || uuid.length !== 22) {
                return uuid;
            }
            try {
                if (
                    window.cc &&
                    cc.assetManager &&
                    cc.assetManager.utils &&
                    typeof cc.assetManager.utils.decodeUuid === "function"
                ) {
                    const decoded = cc.assetManager.utils.decodeUuid(uuid);
                    if (decoded && decoded.indexOf("-") >= 0) {
                        return decoded;
                    }
                }
            } catch (error) {}
            try {
                const base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
                const base64Values = new Array(123).fill(64);
                for (let index = 0; index < base64Chars.length; index += 1) {
                    base64Values[base64Chars.charCodeAt(index)] = index;
                }
                const hexChars = "0123456789abcdef";
                const slots = [
                    "", "", "", "", "", "", "", "", "-",
                    "", "", "", "", "-", "", "", "", "", "-",
                    "", "", "", "", "-", "", "", "", "", "", "", "", "", "", "", "", "",
                ];
                const writableIndexes = slots
                    .map((slot, index) => (slot === "-" ? Number.NaN : index))
                    .filter(Number.isFinite);
                slots[0] = uuid[0];
                slots[1] = uuid[1];
                for (let sourceIndex = 2, targetIndex = 2; sourceIndex < 22; sourceIndex += 2) {
                    const left = base64Values[uuid.charCodeAt(sourceIndex)];
                    const right = base64Values[uuid.charCodeAt(sourceIndex + 1)];
                    slots[writableIndexes[targetIndex]] = hexChars[left >> 2];
                    targetIndex += 1;
                    slots[writableIndexes[targetIndex]] =
                        hexChars[((left & 3) << 2) | (right >> 4)];
                    targetIndex += 1;
                    slots[writableIndexes[targetIndex]] = hexChars[right & 15];
                    targetIndex += 1;
                }
                return slots.join("");
            } catch (error) {
                return uuid;
            }
        };
        const versionMapFromArray = (versions) => {
            const result = new Map();
            for (let index = 0; index < (versions || []).length; index += 2) {
                result.set(String(versions[index]), versions[index + 1]);
            }
            return result;
        };
        const convertRemoteAssetUrl = (relativePath) => {
            if (!relativePath) {
                return "";
            }
            if (
                !relativePath.startsWith("assets/") ||
                relativePath.startsWith("assets/internal")
            ) {
                return relativePath;
            }
            let remoteUrl =
                XYZW_RESOURCE_CDN_BASE + "/" + relativePath.slice("assets/".length);
            if (
                (relativePath.startsWith("assets/game") ||
                    relativePath.startsWith("assets/launcher") ||
                    relativePath.startsWith("assets/TEST_REMOTE_MODULE")) &&
                (relativePath.endsWith(".js") || relativePath.endsWith(".jsc"))
            ) {
                remoteUrl += "c";
            }
            return remoteUrl;
        };
        const ensureBundleAssetIndex = async (bundleName) => {
            if (state.bundleAssetIndexes.has(bundleName)) {
                return state.bundleAssetIndexes.get(bundleName);
            }
            const config = await getBundleConfig(bundleName);
            const importVersions = versionMapFromArray(
                config.versions && config.versions.import,
            );
            const nativeVersions = versionMapFromArray(
                config.versions && config.versions.native,
            );
            const pathMap = new Map();
            const uuidToIndex = new Map();
            const entries = [];
            Object.keys(config.uuids || {}).forEach((index) => {
                const uuid = config.uuids[index];
                uuidToIndex.set(uuid, String(index));
                const decodedUuid = decodeUuid(uuid);
                uuidToIndex.set(decodedUuid, String(index));
            });
            Object.keys(config.paths || {}).forEach((index) => {
                const item = config.paths[index];
                if (!item || !item[0]) {
                    return;
                }
                const path = item[0];
                const assetType = config.types && config.types[item[1]];
                const uuidIndex = String(index);
                const uuid = config.uuids && config.uuids[uuidIndex];
                const entry = {
                    index: String(index),
                    uuidIndex,
                    path,
                    assetType,
                    uuid,
                    decodedUuid: decodeUuid(uuid),
                    importHash: importVersions.get(uuidIndex) || importVersions.get(String(index)),
                    nativeHash: nativeVersions.get(uuidIndex) || nativeVersions.get(String(index)),
                };
                if (!pathMap.has(path)) {
                    pathMap.set(path, []);
                }
                pathMap.get(path).push(entry);
                entries.push(entry);
            });
            const index = {
                pathMap,
                uuidToIndex,
                importVersions,
                nativeVersions,
                entries,
            };
            state.bundleAssetIndexes.set(bundleName, index);
            return index;
        };
        const findBundleAssetEntry = async (bundleName, assetPath, typeName) => {
            const index = await ensureBundleAssetIndex(bundleName);
            const entries = index.pathMap.get(assetPath) || [];
            return (
                entries.find((entry) => !typeName || entry.assetType === typeName) ||
                entries[0] ||
                null
            );
        };
        const nativeAssetUrl = (bundleName, uuid, hash, ext = ".png") => {
            const decodedUuid = decodeUuid(uuid);
            if (!decodedUuid) {
                return "";
            }
            const folder = decodedUuid.slice(0, 2);
            const relativePath =
                "assets/" +
                bundleName +
                "/native/" +
                folder +
                "/" +
                decodedUuid +
                (hash ? "." + hash : "") +
                ext;
            return convertRemoteAssetUrl(relativePath);
        };
        const importAssetUrl = (bundleName, uuid, hash) => {
            const decodedUuid = decodeUuid(uuid);
            if (!decodedUuid) {
                return "";
            }
            const folder = decodedUuid.slice(0, 2);
            const relativePath =
                "assets/" +
                bundleName +
                "/import/" +
                folder +
                "/" +
                decodedUuid +
                (hash ? "." + hash : "") +
                ".json";
            return convertRemoteAssetUrl(relativePath);
        };
        const loadJsonAsset = async (bundleName, assetPath) => {
            const cacheKey = bundleName + ":" + assetPath;
            if (state.configAssets.has(cacheKey)) {
                return state.configAssets.get(cacheKey);
            }
            if (state.configAssetPromises.has(cacheKey)) {
                return state.configAssetPromises.get(cacheKey);
            }
            const promise = (async () => {
                const entry = await findBundleAssetEntry(
                    bundleName,
                    assetPath,
                    "cc.JsonAsset",
                );
                if (!entry) {
                    return null;
                }
                const assetJson = await getImportJson(
                    importAssetUrl(
                        bundleName,
                        entry.decodedUuid || entry.uuid,
                        entry.importHash,
                    ),
                );
                const payload = parseCocosJsonAssetPayload(assetJson);
                state.configAssets.set(cacheKey, payload);
                return payload;
            })();
            state.configAssetPromises.set(cacheKey, promise);
            return promise;
        };
        const ensureIconPathIndex = async () => {
            if (state.iconPathIndex) {
                return state.iconPathIndex;
            }
            state.iconPathIndex = await ensureBundleAssetIndex("icons");
            return state.iconPathIndex;
        };
        const getImportJson = async (url) => {
            if (!url) {
                return null;
            }
            if (!state.importJsonPromises.has(url)) {
                state.importJsonPromises.set(url, getJson(url));
            }
            return state.importJsonPromises.get(url);
        };
        const parseSpriteFrameImport = (spriteFrameJson) => {
            const frameData =
                spriteFrameJson &&
                Array.isArray(spriteFrameJson[5]) &&
                spriteFrameJson[5][0] &&
                typeof spriteFrameJson[5][0] === "object"
                    ? spriteFrameJson[5][0]
                    : {};
            const textureUuid =
                spriteFrameJson &&
                Array.isArray(spriteFrameJson[1]) &&
                spriteFrameJson[1][0]
                    ? spriteFrameJson[1][0]
                    : "";
            return {
                textureUuid,
                name: frameData.name || "",
                rect: Array.isArray(frameData.rect)
                    ? {
                          x: frameData.rect[0],
                          y: frameData.rect[1],
                          width: frameData.rect[2],
                          height: frameData.rect[3],
                      }
                    : null,
                offset: Array.isArray(frameData.offset)
                    ? {
                          x: frameData.offset[0],
                          y: frameData.offset[1],
                      }
                    : null,
                originalSize: Array.isArray(frameData.originalSize)
                    ? {
                          width: frameData.originalSize[0],
                          height: frameData.originalSize[1],
                      }
                    : null,
                rotated: !!frameData.rotated,
                capInsets: frameData.capInsets || null,
            };
        };
        const parseLanguageXml = (text) => {
            const result = new Map();
            const decodeEntity = (value) =>
                String(value || "")
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .replace(/&amp;/g, "&")
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'");
            const pattern = /<string\s+[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g;
            let match = pattern.exec(text || "");
            while (match) {
                result.set(match[1], decodeEntity(match[2]));
                match = pattern.exec(text || "");
            }
            return result;
        };
        const ensureConfigLanguageTextMap = async () => {
            if (state.configLanguageTextMap) {
                return state.configLanguageTextMap;
            }
            if (state.configLanguageTextPromise) {
                return state.configLanguageTextPromise;
            }
            state.configLanguageTextPromise = (async () => {
                const result = new Map();
                const payload = await loadJsonAsset("config", "language").catch(
                    () => null,
                );
                const languageConf = payload && payload.LanguageConf;
                const groups = [
                    languageConf && languageConf.languageConfNew,
                    languageConf && languageConf.languageConfOnline,
                    languageConf && languageConf.languageConfMultiTower,
                ];
                groups.forEach((group) => {
                    Object.keys(group || {}).forEach((key) => {
                        const item = group[key];
                        const value =
                            item && item.chinese !== undefined
                                ? item.chinese
                                : item && item.text !== undefined
                                  ? item.text
                                  : "";
                        if (value !== "") {
                            result.set(key, String(value));
                        }
                    });
                });
                state.configLanguageTextMap = result;
                return result;
            })().catch((error) => {
                console.warn("[资源映射] config/language 解析失败", error);
                state.configLanguageTextMap = new Map();
                return state.configLanguageTextMap;
            });
            return state.configLanguageTextPromise;
        };
        const ensureLanguageTextMap = async () => {
            if (state.languageTextMap) {
                return state.languageTextMap;
            }
            if (state.languageTextPromise) {
                return state.languageTextPromise;
            }
            state.languageTextPromise = (async () => {
                const config = await getBundleConfig("language");
                const importVersions = versionMapFromArray(
                    config.versions && config.versions.import,
                );
                let chineseEntry = null;
                Object.keys(config.paths || {}).some((index) => {
                    const item = config.paths[index];
                    if (item && item[0] === "chinese") {
                        chineseEntry = {
                            index: String(index),
                            uuid: config.uuids[index],
                            importHash: importVersions.get(String(index)),
                        };
                        return true;
                    }
                    return false;
                });
                if (!chineseEntry) {
                    state.languageTextMap = new Map();
                    return state.languageTextMap;
                }
                const textAssetJson = await getImportJson(
                    importAssetUrl(
                        "language",
                        chineseEntry.uuid,
                        chineseEntry.importHash,
                    ),
                );
                const text =
                    textAssetJson &&
                    Array.isArray(textAssetJson[5]) &&
                    textAssetJson[5][0] &&
                    textAssetJson[5][0][2]
                        ? textAssetJson[5][0][2]
                        : "";
                state.languageTextMap = parseLanguageXml(text);
                return state.languageTextMap;
            })().catch((error) => {
                console.warn("[资源映射] language/chinese 解析失败", error);
                state.languageTextMap = new Map();
                return state.languageTextMap;
            });
            return state.languageTextPromise;
        };
        const normalizeIconPathCandidates = (iconPath) => {
            const rawPath = String(iconPath || "").trim().replace(/\\/g, "/");
            const result = [];
            const push = (value) => {
                const normalized = String(value || "")
                    .trim()
                    .replace(/\\/g, "/")
                    .replace(/^assets\/icons\//, "")
                    .replace(/^icons\//, "")
                    .replace(/^\.\//, "");
                if (!normalized || result.includes(normalized)) {
                    return;
                }
                result.push(normalized);
                if (/\.(png|jpg|jpeg|webp)$/i.test(normalized)) {
                    result.push(normalized.replace(/\.(png|jpg|jpeg|webp)$/i, ""));
                }
            };
            push(rawPath);
            push(rawPath.replace(/^assets\/icons\//, ""));
            push(rawPath.replace(/^icons\//, ""));
            push(rawPath.replace(/^resources\//, ""));
            return result;
        };
        const resolveIconPath = async (iconPath) => {
            if (!iconPath) {
                return null;
            }
            if (/^https?:\/\//i.test(iconPath)) {
                return {
                    iconPath,
                    iconUrl: iconPath,
                    atlasUrl: iconPath,
                    rect: null,
                };
            }
            const index = await ensureIconPathIndex();
            const iconPathCandidates = normalizeIconPathCandidates(iconPath);
            let matchedIconPath = iconPathCandidates[0] || iconPath;
            let entries = [];
            for (const candidatePath of iconPathCandidates) {
                entries = index.pathMap.get(candidatePath) || [];
                if (entries.length) {
                    matchedIconPath = candidatePath;
                    break;
                }
            }
            const spriteFrameEntry =
                entries.find((entry) => entry.assetType === "cc.SpriteFrame") ||
                null;
            if (spriteFrameEntry) {
                const importUrl = importAssetUrl(
                    "icons",
                    spriteFrameEntry.decodedUuid || spriteFrameEntry.uuid,
                    spriteFrameEntry.importHash,
                );
                const spriteFrameJson = await getImportJson(importUrl);
                const frame = parseSpriteFrameImport(spriteFrameJson);
                const textureUuid = frame.textureUuid || "";
                const decodedTextureUuid = decodeUuid(textureUuid);
                const textureIndex =
                    index.uuidToIndex.get(textureUuid) ||
                    index.uuidToIndex.get(decodedTextureUuid);
                const textureHash = index.nativeVersions.get(textureIndex);
                const atlasUrl = nativeAssetUrl(
                    "icons",
                    decodedTextureUuid || textureUuid,
                    textureHash,
                    ".png",
                );
                return {
                    iconPath: matchedIconPath,
                    rawIconPath: iconPath,
                    iconUrl: atlasUrl,
                    atlasUrl,
                    frameUrl: importUrl,
                    rect: frame.rect,
                    offset: frame.offset,
                    originalSize: frame.originalSize,
                    rotated: frame.rotated,
                    capInsets: frame.capInsets,
                    spriteFrameUuid: spriteFrameEntry.decodedUuid,
                    textureUuid: decodedTextureUuid || textureUuid,
                };
            }
            const textureEntry =
                entries.find((entry) => entry.assetType === "cc.Texture2D") ||
                entries[0];
            if (!textureEntry) {
                return {
                    iconPath: matchedIconPath,
                    rawIconPath: iconPath,
                    iconUrl: "",
                    atlasUrl: "",
                    rect: null,
                };
            }
            const iconUrl = nativeAssetUrl(
                "icons",
                textureEntry.decodedUuid || textureEntry.uuid,
                textureEntry.nativeHash,
                ".png",
            );
            return {
                iconPath: matchedIconPath,
                rawIconPath: iconPath,
                iconUrl,
                atlasUrl: iconUrl,
                rect: null,
                textureUuid: textureEntry.decodedUuid,
            };
        };
        const tryRequire = (...moduleNames) => {
            if (!window.__require) {
                return null;
            }
            for (const moduleName of moduleNames) {
                try {
                    const moduleExports = window.__require(moduleName);
                    if (moduleExports) {
                        return moduleExports;
                    }
                } catch (error) {
                    // 不同包名在不同构建中可能被压缩为短名，失败即尝试下一个。
                }
            }
            return null;
        };
        const getConfigs = () => tryRequire("Configs", "launcher/config/Configs");
        const getLanguageExt = () =>
            tryRequire(
                "LanguageExt",
                "extras/config/extensions/LanguageExt",
                "../../../../extras/config/extensions/LanguageExt",
            );
        const getConfById = (tableName, id) => {
            const Configs = getConfigs();
            const table = Configs && Configs[tableName];
            if (!table || !id) {
                return null;
            }
            if (typeof table.getById === "function") {
                return table.getById(id);
            }
            if (typeof table.getByID === "function") {
                return table.getByID(id);
            }
            if (typeof table.get === "function") {
                return table.get(id) || table.get(String(id));
            }
            return table[id] || table[String(id)] || null;
        };
        const getConfigAssetPathForTable = (tableName) => {
            if (
                [
                    "HeroConf",
                    "ItemConf",
                    "ArtifactConf",
                    "WeaponConf",
                ].includes(tableName)
            ) {
                return "language";
            }
            if (["AvatarConf"].includes(tableName)) {
                return "level";
            }
            if (["PetConf", "SkinConf"].includes(tableName)) {
                return "config";
            }
            if (
                [
                    "EquipmentConf",
                    "EquipmentLvConf",
                    "EquipmentSetConf",
                    "EquipConf",
                    "EquipItemConf",
                    "OtherItemConf",
                ].includes(tableName)
            ) {
                return "config_ap";
            }
            return "config";
        };
        const getOnlineConfTable = async (tableName) => {
            const cacheKey = tableName;
            if (state.configTablePromises.has(cacheKey)) {
                return state.configTablePromises.get(cacheKey);
            }
            const promise = (async () => {
                const candidates = [
                    getConfigAssetPathForTable(tableName),
                    "language",
                    "config",
                    "level",
                    "config_ap",
                ].filter((value, index, array) => value && array.indexOf(value) === index);
                for (const assetPath of candidates) {
                    const payload = await loadJsonAsset("config", assetPath).catch(
                        () => null,
                    );
                    if (payload && payload[tableName]) {
                        return payload[tableName];
                    }
                }
                return null;
            })();
            state.configTablePromises.set(cacheKey, promise);
            return promise;
        };
        const getConfByIdAsync = async (tableName, id) => {
            if (!id && toNumber(id, -1) !== 0) {
                return null;
            }
            const table = await getOnlineConfTable(tableName).catch(() => null);
            const onlineConf = table ? table[id] || table[String(id)] || null : null;
            return onlineConf || getConfById(tableName, id);
        };
        const resolveText = (textOrKey, fallback = "") => {
            if (textOrKey === undefined || textOrKey === null || textOrKey === "") {
                return fallback;
            }
            const rawText = String(textOrKey);
            const LanguageExt = getLanguageExt();
            for (const fnName of ["GET_CONTENT", "GET_CONTENT_EXT"]) {
                if (LanguageExt && typeof LanguageExt[fnName] === "function") {
                    try {
                        const value = LanguageExt[fnName](rawText);
                        if (value && value !== rawText) {
                            return String(value);
                        }
                    } catch (error) {
                        // 语言 key 不存在时回退原文。
                    }
                }
            }
            return rawText || fallback;
        };
        const resolveTextAsync = async (textOrKey, fallback = "") => {
            if (textOrKey === undefined || textOrKey === null || textOrKey === "") {
                return fallback;
            }
            const runtimeValue = resolveText(textOrKey, fallback);
            const configLanguageTextMap = await ensureConfigLanguageTextMap();
            if (configLanguageTextMap.has(String(textOrKey))) {
                return configLanguageTextMap.get(String(textOrKey));
            }
            if (
                runtimeValue &&
                runtimeValue !== String(textOrKey) &&
                runtimeValue !== fallback
            ) {
                return runtimeValue;
            }
            const textMap = await ensureLanguageTextMap();
            return textMap.get(String(textOrKey)) || runtimeValue || fallback;
        };
        const pickField = (source, fields) => {
            if (!source) {
                return "";
            }
            for (const field of fields) {
                if (source[field] !== undefined && source[field] !== null && source[field] !== "") {
                    return source[field];
                }
            }
            return "";
        };
        const importLegacyMapping = (mapping) => {
            if (!mapping || typeof mapping !== "object") {
                return false;
            }
            try {
                localStorage.setItem(
                    XYZW_LEGACY_MAPPING_CACHE_KEY,
                    JSON.stringify(mapping),
                );
            } catch (error) {
                console.warn("[资源映射] 映射表缓存写入失败", error);
            }
            window.XYZW_RESOURCE_MAPPING = mapping;
            state.legacyIndex = null;
            return true;
        };
        const getAvatarConf = (heroId, skinId) => {
            const heroConf = getConfById("HeroConf", heroId);
            const avatarId =
                toNumber(skinId, -1) > 0
                    ? toNumber(skinId, 0)
                    : toNumber(
                          pickField(heroConf, ["avatar"]) ||
                              (heroConf &&
                                  Array.isArray(heroConf.skinList) &&
                                  heroConf.skinList[0]),
                          0,
                      );
            return {
                heroConf,
                avatarConf: getConfById("AvatarConf", avatarId),
                avatarId,
            };
        };
        const getAvatarConfAsync = async (heroId, skinId) => {
            const heroConf = await getConfByIdAsync("HeroConf", heroId);
            const skinIdNumber = toNumber(skinId, -1);
            const skinConf =
                skinIdNumber > 0
                    ? await getConfByIdAsync("SkinConf", skinIdNumber)
                    : null;
            let avatarId = 0;
            if (skinConf) {
                avatarId = toNumber(
                    pickField(skinConf, ["avatar", "avatarId"]),
                    0,
                );
            }
            if (!avatarId) {
                avatarId = toNumber(
                    pickField(heroConf, ["avatar", "avatarId"]) ||
                        (heroConf &&
                            Array.isArray(heroConf.skinList) &&
                            heroConf.skinList[0]),
                    0,
                );
            }
            if (!avatarId && skinIdNumber > 0) {
                avatarId = skinIdNumber;
            }
            return {
                heroConf,
                skinConf,
                avatarConf: await getConfByIdAsync("AvatarConf", avatarId),
                avatarId,
            };
        };
        const normalizeResourceInfo = async (info) => {
            if (!info) {
                return null;
            }
            const iconInfo = await resolveIconPath(
                info.iconPath || info.webiconUrl || "",
            ).catch((error) => {
                console.warn("[资源映射] 图标解析失败", info.iconPath, error);
                return null;
            });
            return {
                ...info,
                iconUrl:
                    info.webiconUrl ||
                    (iconInfo && iconInfo.iconUrl) ||
                    info.iconUrl ||
                    "",
                atlasUrl: (iconInfo && iconInfo.atlasUrl) || info.atlasUrl || "",
                rect: (iconInfo && iconInfo.rect) || info.rect || null,
                offset: iconInfo && iconInfo.offset,
                originalSize: iconInfo && iconInfo.originalSize,
                rotated: iconInfo && iconInfo.rotated,
            };
        };
        const resolveHero = async (heroId, skinId = -1) => {
            const id = toNumber(heroId, 0);
            if (!id) {
                return null;
            }
            const { heroConf, skinConf, avatarConf, avatarId } =
                await getAvatarConfAsync(id, skinId);
            const name = await resolveTextAsync(
                pickField(skinConf, ["skinName", "name"]) ||
                    pickField(heroConf, ["nickName", "name"]) ||
                    pickField(avatarConf, ["nickName", "name"]),
                "武将" + id,
            );
            const iconPath = pickField(avatarConf, [
                    "smallHeadIcon",
                    "smallHead",
                    "headIcon",
                    "icon",
                    "path",
                ]);
            return normalizeResourceInfo({
                type: "hero",
                id,
                name,
                desc: await resolveTextAsync(
                    pickField(heroConf, ["description", "desc"]),
                    "",
                ),
                iconPath,
                rawConf: heroConf,
                avatarId,
            });
        };
        const resolveSkin = async (skinId) => {
            const id = toNumber(skinId, 0);
            if (!id) {
                return null;
            }
            const skinConf = await getConfByIdAsync("SkinConf", id);
            const avatarConf = await getConfByIdAsync(
                "AvatarConf",
                pickField(skinConf, ["avatar", "avatarId", "id"]) || id,
            );
            const iconPath =
                pickField(avatarConf, ["headIcon", "smallHeadIcon", "icon", "path"]) ||
                pickField(skinConf, ["headIcon", "icon", "path"]);
            return normalizeResourceInfo({
                type: "skin",
                id,
                name: await resolveTextAsync(
                    pickField(skinConf, ["skinName", "name"]),
                    "皮肤" + id,
                ),
                desc: await resolveTextAsync(
                    pickField(skinConf, ["description", "desc"]),
                    "",
                ),
                iconPath,
                rawConf: skinConf,
            });
        };
        const resolveItem = async (itemId) => {
            const id = toNumber(itemId, 0);
            if (!id) {
                return null;
            }
            const itemConf =
                (await getConfByIdAsync("ItemConf", id)) ||
                (await getConfByIdAsync("OtherItemConf", id)) ||
                (await getConfByIdAsync("ArtifactConf", id));
            return normalizeResourceInfo({
                type: "item",
                id,
                name: await resolveTextAsync(
                    pickField(itemConf, ["name", "title"]),
                    "物品" + id,
                ),
                desc: await resolveTextAsync(
                    pickField(itemConf, ["description", "desc", "tips"]),
                    "",
                ),
                iconPath: pickField(itemConf, ["icon", "smallIcon", "path"]),
                rawConf: itemConf,
            });
        };
        const resolveArtifact = async (artifactId) => {
            const rawArtifactConf =
                (await getConfByIdAsync("ArtifactConf", artifactId)) ||
                (await getConfByIdAsync(
                    "ArtifactConf",
                    String(artifactId) + "1",
                ));
            const itemId = toNumber(
                rawArtifactConf && (rawArtifactConf.starItem || rawArtifactConf.id),
                toNumber(artifactId, 0),
            );
            const itemInfo = await resolveItem(itemId);
            if (!itemInfo) {
                return null;
            }
            return {
                ...itemInfo,
                type: "artifact",
                id: toNumber(artifactId, itemInfo.id),
                rawArtifactConf,
            };
        };
        const resolveEquipment = async (equipment) => {
            const source =
                equipment && typeof equipment === "object" ? equipment : { id: equipment };
            const id = toNumber(
                pickField(source, [
                    "id",
                    "itemId",
                    "equipId",
                    "equipmentId",
                    "configId",
                    "templateId",
                    "tplId",
                ]),
                0,
            );
            const itemInfo = id ? await resolveItem(id) : null;
            if (
                itemInfo &&
                (itemInfo.rawConf ||
                    itemInfo.iconPath ||
                    itemInfo.iconUrl ||
                    itemInfo.webiconUrl)
            ) {
                return {
                    ...itemInfo,
                    type: "equipment",
                    rawEquipmentSource: source,
                };
            }
            const equipConf = id
                ? (await getConfByIdAsync("EquipmentConf", id)) ||
                  (await getConfByIdAsync("EquipConf", id)) ||
                  (await getConfByIdAsync("EquipItemConf", id))
                : null;
            return normalizeResourceInfo({
                type: "equipment",
                id,
                name: await resolveTextAsync(
                    pickField(equipConf, ["name", "title"]) ||
                        pickField(source, ["name", "title"]),
                    id ? "装备" + id : "装备",
                ),
                desc: await resolveTextAsync(
                    pickField(equipConf, ["description", "desc", "tips"]) ||
                        pickField(source, ["description", "desc", "tips"]),
                    "",
                ),
                iconPath:
                    pickField(source, ["icon", "iconPath", "smallIcon", "path"]) ||
                    pickField(equipConf, ["icon", "smallIcon", "path"]),
                rawConf: equipConf,
                rawEquipmentSource: source,
            });
        };
        const resolveWeapon = async (weaponId) => {
            const id = toNumber(weaponId, 0);
            if (!id) {
                return null;
            }
            const weaponConf = await getConfByIdAsync("WeaponConf", id);
            return normalizeResourceInfo({
                type: "weapon",
                id,
                name: await resolveTextAsync(pickField(weaponConf, ["name"]), "玩具" + id),
                desc: await resolveTextAsync(
                    pickField(weaponConf, ["description", "desc"]),
                    "",
                ),
                iconPath: pickField(weaponConf, [
                    "bigIcon",
                    "icon",
                    "smallIcon",
                    "path",
                ]),
                rawConf: weaponConf,
            });
        };
        const resolvePet = async (petId) => {
            const id = toNumber(petId, 0);
            if (!id) {
                return null;
            }
            const petConf = await getConfByIdAsync("PetConf", id);
            const iconPath = pickField(petConf, [
                "icon",
                "iconBattle",
                "headIcon",
                "bookIconUnlock",
                "bookIconLock",
                "bookIcon",
                "path",
                "spine",
            ]);
            return normalizeResourceInfo({
                type: "pet",
                id,
                name: await resolveTextAsync(
                    pickField(petConf, ["petName", "name"]),
                    "宠物" + id,
                ),
                desc: await resolveTextAsync(
                    pickField(petConf, ["petDes", "description", "desc"]),
                    "",
                ),
                iconPath,
                rawConf: petConf,
            });
        };
        const XYZW_PEARL_SKILL_NAME_FALLBACK = {
            1033007: "碎盾",
            1033008: "冥想",
            1033009: "定心",
            1033010: "冰清",
            1033011: "攻心",
            1033012: "强权",
            1033013: "盾击",
            1033014: "合力",
            1033015: "仁心",
            1033016: "游龙",
            1033017: "回元",
        };
        const normalizePearlSkillKey = (value) => {
            const raw = String(value || "").trim();
            const numeric = raw.match(/\d+/);
            return numeric ? String(toNumber(numeric[0], 0)) : raw;
        };
        const extractPearlSkillId = (pearl) => {
            const value = pickField(pearl, [
                "pearlSkillId",
                "skillType",
                "skillTypeId",
                "skillConfId",
                "skillConfigId",
                "skillItemId",
                "effectId",
                "effectType",
                "attrId",
                "abilityId",
                "passiveSkillId",
                "appendSkillId",
                "appendSkill",
            ]);
            if (Array.isArray(value)) {
                return value.find((item) => toNumber(item, 0) > 0) || 0;
            }
            const direct = toNumber(value, 0);
            if (direct > 0) {
                return direct;
            }
            const maybeLevel = toNumber(pearl && pearl.skillId, 0);
            return maybeLevel > 100 ? maybeLevel : 0;
        };
        const resolvePearlSkillName = async (pearlSkillId, pearl = null) => {
            const directName = await resolveTextAsync(
                pickField(pearl, ["skillName", "name", "title", "effectName"]),
                "",
            );
            if (directName) {
                return directName;
            }
            const skillKey = normalizePearlSkillKey(pearlSkillId || extractPearlSkillId(pearl));
            if (!skillKey) {
                return "";
            }
            const tableNames = [
                "PearlSkillConf",
                "FishPearlSkillConf",
                "GemSkillConf",
                "JewelSkillConf",
                "TreasureSkillConf",
                "BeadSkillConf",
                "BallSkillConf",
            ];
            for (const tableName of tableNames) {
                const conf = await getConfByIdAsync(tableName, skillKey).catch(() => null);
                const name = await resolveTextAsync(
                    pickField(conf, ["name", "skillName", "title", "skillDesc", "desc"]),
                    "",
                );
                if (name) {
                    return name;
                }
            }
            return XYZW_PEARL_SKILL_NAME_FALLBACK[skillKey] || "";
        };
        const resolvePearl = async (pearlId, pearlSkillId, pearl = null) => {
            const id = toNumber(pearlId || (pearl && (pearl.id || pearl.uid || pearl.pearlId)), 0);
            const pearlItem = id
                ? await getConfByIdAsync("ItemConf", id).catch(() => null)
                : null;
            const resolvedSkillId = pearlSkillId || extractPearlSkillId(pearl);
            const pearlSkillName = await resolvePearlSkillName(resolvedSkillId, pearl);
            const pearlItemName = await resolveTextAsync(
                pickField(pearlItem, ["name", "title"]),
                "",
            );
            return normalizeResourceInfo({
                type: "pearl",
                id,
                name: pearlSkillName || pearlItemName || "鱼珠",
                desc: await resolveTextAsync(
                    pickField(pearlItem, ["description", "desc", "tips"]),
                    "",
                ),
                iconPath:
                    pickField(pearlItem, ["icon", "smallIcon", "path"]) ||
                    "items/xiaohao_lingzhu",
            });
        };
        const resolveResource = async (type, id, extra = {}) => {
            const resourceType = String(type || "").toLowerCase();
            switch (resourceType) {
                case "hero":
                case "heroes":
                case "武将":
                case "英雄":
                    return resolveHero(id, pickField(extra, ["skinId", "avatarId"]) || -1);
                case "skin":
                case "skins":
                case "皮肤":
                    return resolveSkin(id);
                case "equipment":
                case "equip":
                case "equips":
                case "装备":
                    return resolveEquipment(id);
                case "artifact":
                case "fish":
                case "fish_spirit":
                case "鱼灵":
                    return resolveArtifact(id);
                case "weapon":
                case "toy":
                case "玩具":
                    return resolveWeapon(id);
                case "pet":
                case "pets":
                case "宠物":
                    return resolvePet(id);
                case "pearl":
                case "fish_pearl":
                case "鱼珠":
                case "珍珠":
                    return resolvePearl(id, pickField(extra, ["skillId", "pearlSkillId"]), extra && (extra.pearl || extra.rawConf));
                case "icon":
                case "icon_path":
                case "图标":
                    return resolveIconPath(id);
                case "item":
                case "items":
                case "物品":
                default:
                    return resolveItem(id);
            }
        };
        const resolveResources = async (requests) => {
            const entries = Array.isArray(requests) ? requests : [];
            return Promise.all(
                entries.map((request) =>
                    resolveResource(
                        request && request.type,
                        request && request.id,
                        request && request.extra ? request.extra : request || {},
                    ),
                ),
            );
        };
        const isTextField = (field) =>
            /(name|desc|text|title|memo|introduction|unlock|tips|des)$/i.test(
                field,
            );
        const isImageField = (field) =>
            /(icon|url|spine|banner|image|img|texture|avatar|head|body)/i.test(
                field,
            );
        const getSourcePayloads = async () => ({
            language: await loadJsonAsset("config", "language").catch(() => null),
            config: await loadJsonAsset("config", "config").catch(() => null),
            level: await loadJsonAsset("config", "level").catch(() => null),
            configAp: await loadJsonAsset("config", "config_ap").catch(() => null),
        });
        const listTables = async (options = {}) => {
            const keyword = String(options.keyword || "").toLowerCase();
            const sourceFilter = options.source ? String(options.source) : "";
            const payloads = await getSourcePayloads();
            const tableMap = new Map();
            Object.keys(payloads).forEach((source) => {
                const payload = payloads[source];
                if (!payload || typeof payload !== "object") {
                    return;
                }
                Object.keys(payload).forEach((name) => {
                    const table = payload[name];
                    if (!table || typeof table !== "object" || Array.isArray(table)) {
                        return;
                    }
                    if (keyword && !name.toLowerCase().includes(keyword)) {
                        return;
                    }
                    if (sourceFilter && sourceFilter !== source) {
                        return;
                    }
                    if (!tableMap.has(name)) {
                        tableMap.set(name, { name, sources: [], count: 0 });
                    }
                    const record = tableMap.get(name);
                    record.sources.push(source);
                    record.count = Math.max(record.count, Object.keys(table).length);
                });
            });
            return [...tableMap.values()].sort((left, right) =>
                left.name.localeCompare(right.name),
            );
        };
        const getResource = async (path, bundleName = "icons") => {
            const index = await ensureBundleAssetIndex(bundleName);
            const entry = (index.pathMap.get(path) || [])[0];
            if (!entry) {
                return null;
            }
            return {
                bundle: bundleName,
                path: entry.path,
                type: entry.assetType,
                uuid: entry.decodedUuid || entry.uuid,
                importUrl: importAssetUrl(
                    bundleName,
                    entry.decodedUuid || entry.uuid,
                    entry.importHash,
                ),
                nativeUrl: nativeAssetUrl(
                    bundleName,
                    entry.decodedUuid || entry.uuid,
                    entry.nativeHash,
                ),
            };
        };
        const listResources = async (options = {}) => {
            const bundleName = options.bundle || "icons";
            const prefix = options.prefix || "";
            const limit = toNumber(options.limit, 0);
            const index = await ensureBundleAssetIndex(bundleName);
            const resources = [];
            for (const entry of index.entries) {
                if (!entry.path || (prefix && !entry.path.startsWith(prefix))) {
                    continue;
                }
                resources.push({
                    bundle: bundleName,
                    path: entry.path,
                    type: entry.assetType,
                    uuid: entry.decodedUuid || entry.uuid,
                    importUrl: importAssetUrl(
                        bundleName,
                        entry.decodedUuid || entry.uuid,
                        entry.importHash,
                    ),
                    nativeUrl: nativeAssetUrl(
                        bundleName,
                        entry.decodedUuid || entry.uuid,
                        entry.nativeHash,
                    ),
                });
                if (limit > 0 && resources.length >= limit) {
                    break;
                }
            }
            return resources;
        };
        const resolveImage = resolveIconPath;
        const listByResolver = async (tableName, resolver, options = {}) => {
            const table = await getOnlineConfTable(tableName).catch(() => null);
            if (!table || typeof table !== "object") {
                return [];
            }
            const limit = toNumber(options.limit, 0);
            const keys = Object.keys(table).sort((left, right) => {
                const leftNumber = Number(left);
                const rightNumber = Number(right);
                return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
                    ? leftNumber - rightNumber
                    : left.localeCompare(right);
            });
            const result = [];
            for (const key of keys) {
                result.push(await resolver(key));
                if (limit > 0 && result.length >= limit) {
                    break;
                }
            }
            return result.filter(Boolean);
        };
        const listItems = (options = {}) =>
            listByResolver("ItemConf", resolveItem, options);
        const listHeroes = (options = {}) =>
            listByResolver("HeroConf", resolveHero, options);
        const listSkins = async (options = {}) => {
            const records = await listByResolver("SkinConf", resolveSkin, options);
            const heroId = toNumber(options.heroId, 0);
            return heroId
                ? records.filter((item) =>
                      toNumber(item && item.rawConf && item.rawConf.heroId, 0) === heroId,
                  )
                : records;
        };
        const listPets = (options = {}) =>
            listByResolver("PetConf", resolvePet, options);
        const getSummary = async () => {
            const [tables, iconResources, items, heroes, skins, pets] =
                await Promise.all([
                    listTables().catch(() => []),
                    listResources({ bundle: "icons", limit: 0 }).catch(() => []),
                    getOnlineConfTable("ItemConf").catch(() => null),
                    getOnlineConfTable("HeroConf").catch(() => null),
                    getOnlineConfTable("SkinConf").catch(() => null),
                    getOnlineConfTable("PetConf").catch(() => null),
                ]);
            return {
                bundleVers: state.bundleVers,
                counts: {
                    tables: tables.length,
                    iconResources: iconResources.length,
                    items: items ? Object.keys(items).length : 0,
                    heroes: heroes ? Object.keys(heroes).length : 0,
                    skins: skins ? Object.keys(skins).length : 0,
                    pets: pets ? Object.keys(pets).length : 0,
                },
                tables,
            };
        };
        const mapGenericRecord = async (tableName, key, raw) => {
            const resolved = {};
            const imagePaths = {};
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                Object.keys(raw).forEach((field) => {
                    const value = raw[field];
                    if (!isImageField(field) && isTextField(field) && typeof value === "string") {
                        resolved[field] = value;
                    }
                    if (isImageField(field) && typeof value === "string" && value) {
                        imagePaths[field] = value;
                    }
                });
            }
            await Promise.all(
                Object.keys(resolved).map(async (field) => {
                    resolved[field] = await resolveTextAsync(resolved[field], resolved[field]);
                }),
            );
            const images = {};
            await Promise.all(
                Object.keys(imagePaths).map(async (field) => {
                    images[field] = await resolveIconPath(imagePaths[field]).catch(
                        () => null,
                    );
                }),
            );
            return {
                table: tableName,
                key,
                id:
                    raw && typeof raw === "object"
                        ? raw.id ?? raw.Id ?? raw.ID ?? key
                        : key,
                name:
                    pickField(resolved, [
                        "name",
                        "petName",
                        "skinName",
                        "artifactName",
                        "skillName",
                        "trumpName",
                        "nickName",
                    ]) || undefined,
                description:
                    pickField(resolved, [
                        "description",
                        "desc",
                        "petDes",
                        "artifactDes",
                        "skillDesc",
                        "memoTDesc",
                    ]) || undefined,
                imagePaths,
                images,
                resolved,
                raw,
            };
        };
        const getTableRecord = async (tableName, id) => {
            const table = await getOnlineConfTable(tableName).catch(() => null);
            if (!table || typeof table !== "object") {
                return null;
            }
            const key = String(id);
            const raw = table[key] !== undefined ? table[key] : table[id];
            return raw === undefined ? null : mapGenericRecord(tableName, key, raw);
        };
        const listTableRecords = async (tableName, options = {}) => {
            const table = await getOnlineConfTable(tableName).catch(() => null);
            if (!table || typeof table !== "object") {
                return [];
            }
            const limit = toNumber(options.limit, 0);
            const keys = Object.keys(table).sort((left, right) => {
                const leftNumber = Number(left);
                const rightNumber = Number(right);
                return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
                    ? leftNumber - rightNumber
                    : left.localeCompare(right);
            });
            const result = [];
            for (const key of keys) {
                result.push(await mapGenericRecord(tableName, key, table[key]));
                if (limit > 0 && result.length >= limit) {
                    break;
                }
            }
            return result;
        };
        return {
            ensureReady: async () => {
                await loadBundleVers();
                await Promise.all([
                    getBundleConfig("config").catch(() => null),
                    getBundleConfig("language").catch(() => null),
                    getBundleConfig("icons").catch(() => null),
                ]);
                await Promise.all([
                    loadJsonAsset("config", "language").catch(() => null),
                    loadJsonAsset("config", "config").catch(() => null),
                    loadJsonAsset("config", "level").catch(() => null),
                    loadJsonAsset("config", "config_ap").catch(() => null),
                    ensureLanguageTextMap().catch(() => null),
                    ensureIconPathIndex().catch(() => null),
                    getOnlineConfTable("ItemConf").catch(() => null),
                    getOnlineConfTable("HeroConf").catch(() => null),
                    getOnlineConfTable("EquipmentConf").catch(() => null),
                    getOnlineConfTable("SkinConf").catch(() => null),
                    getOnlineConfTable("PetConf").catch(() => null),
                ]);
                return true;
            },
            importLegacyMapping,
            resolveIconPath,
            resolveHero,
            resolveSkin,
            resolveItem,
            resolveArtifact,
            resolveEquipment,
            resolveWeapon,
            resolvePet,
            resolvePearl,
            resolveResource,
            resolveResources,
            resolveImage,
            getResource,
            listResources,
            listItems,
            listHeroes,
            listSkins,
            listPets,
            getSummary,
            getBundleVers: () => state.bundleVers,
            getConfById,
            getOnlineConfById: getConfByIdAsync,
            getOnlineConfTable,
            listTables,
            getTableRecord,
            listTableRecords,
            mapGenericRecord,
            decodeUuid,
            importAssetUrl,
            nativeAssetUrl,
            resolveText,
            resolveTextAsync,
        };
    }

    const lineupRuntimeState = {
        isSwitching: false,
        isSaving: false,
        initializedStorageKey: "",
        suppressNextOpenerClick: false,
        renderSavedConfigs: null,
    };
    const LINEUP_OPENER_POSITION_KEY_PREFIX = "lineup_opener_position_v1_";
    const LINEUP_PANEL_MARGIN = 8;
    const LINEUP_PANEL_GAP = 12;
    const LINEUP_UI_STYLE = {
        openerButton: `
            position: fixed;
            top: 70px;
            left: 0;
            z-index: 2147483001;
            width: 36px;
            height: 36px;
            min-width: 36px;
            padding: 0;
            border-radius: 50%;
            background: linear-gradient(135deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.98) 100%);
            color: #fbbf24;
            border: 1.5px solid rgba(251, 191, 36, 0.6);
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4), 0 0 8px rgba(251, 191, 36, 0.25);
            cursor: pointer;
            font-family: 'Segoe UI', system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
            font-size: 18px;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            appearance: none;
            -webkit-appearance: none;
            outline: none;
            user-select: none;
            touch-action: none;
            pointer-events: auto;
            opacity: 0.72;
            transform: translateX(-50%);
            transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease, box-shadow 0.2s ease;
        `,
        panel: `
            position: fixed;
            top: 0;
            left: 0;
            right: auto;
            width: 360px;
            max-width: calc(100vw - 16px);
            background: rgba(255, 255, 255, 0.95);
            border: 1px solid rgba(226, 232, 240, 0.85);
            border-radius: 20px;
            padding: 14px 14px 8px 14px;
            z-index: 10000;
            box-shadow: 0 20px 48px -10px rgba(15, 23, 42, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.6) inset;
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            font-family: 'Segoe UI', system-ui, -apple-system, 'PingFang SC','Microsoft YaHei', sans-serif;
            color: #1e293b;
            display: none;
            visibility: hidden;
            flex-direction: column;
            max-height: min(88vh, 780px);
            overflow: hidden;
            pointer-events: auto;
            gap: 8px;
            box-sizing: border-box;
        `,
        panelHeader: `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
        `,
        panelTitle: `
            font-weight: 800;
            color: #0f172a;
            font-size: 17px;
            letter-spacing: 0.3px;
            background: linear-gradient(135deg, #0f172a 0%, #334155 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 6px;
        `,
        configList: `
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: min(54vh, 480px);
            overflow-y: auto;
            margin-bottom: 4px;
            padding-right: 2px;
        `,
        statusText: `
            margin-top: 4px;
            font-size: 12px;
            color: #64748b;
            text-align: center;
            min-height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2px 8px;
            border-radius: 6px;
            transition: all 0.2s ease;
        `,
        emptyState: `
            text-align: center;
            color: #64748b;
            font-size: 13px;
            padding: 28px 16px;
            background: rgba(248, 250, 252, 0.85);
            border: 1px dashed #cbd5e1;
            border-radius: 12px;
            margin: 4px 0;
            line-height: 1.6;
        `,
    };
    const LINEUP_SCROLLBAR_STYLE = `
        #lineup-list::-webkit-scrollbar {
            width: 5px;
        }
        #lineup-list::-webkit-scrollbar-track {
            background: transparent;
        }
        #lineup-list::-webkit-scrollbar-thumb {
            background: rgba(203, 213, 225, 0.75);
            border-radius: 10px;
        }
        #lineup-list::-webkit-scrollbar-thumb:hover {
            background: rgba(148, 163, 184, 0.95);
        }
    `;
    const LINEUP_CARD_STYLE = `
        .lineup-list {
            padding: 2px;
            width: 100%;
            box-sizing: border-box;
        }
        .lineup-card {
            background: #ffffff;
            border-radius: 14px;
            padding: 12px;
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 2px 6px rgba(15, 23, 42, 0.04);
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .lineup-card:hover {
            box-shadow: 0 6px 14px rgba(15, 23, 42, 0.08);
        }
        .lineup-info {
            display: flex;
            flex-direction: column;
        }
        .lineup-name {
            font-size: 15px;
            font-weight: 700;
            color: #1e293b;
            cursor: pointer;
            transition: color 0.15s ease;
        }
        .lineup-name:hover {
            color: #2563eb;
        }
        .lineup-sub {
            font-size: 11px;
            color: #64748b;
            margin-top: 4px;
        }
        .lineup-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .delete-btn {
            background: transparent;
            border: none;
            font-size: 16px;
            color: #94a3b8;
            cursor: pointer;
            padding: 4px;
            border-radius: 6px;
            transition: all 0.15s ease;
        }
        .delete-btn:hover {
            background: #fee2e2;
            color: #ef4444;
        }
        .switch-btn {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            border: none;
            color: #fff;
            padding: 6px 16px;
            border-radius: 20px;
            cursor: pointer;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 4px;
            font-weight: 700;
            box-shadow: 0 2px 8px rgba(16, 185, 129, 0.35);
            transition: all 0.15s ease;
        }
        .switch-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.45);
        }
        .icon {
            width: 16px;
            height: 16px;
            cursor: pointer;
        }
        .lineup-delete-btn:hover {
            background: #fee2e2 !important;
            color: #ef4444 !important;
        }
        .lineup-sort-btn:hover {
            background: #e2e8f0 !important;
            color: #0f172a !important;
            border-color: #cbd5e1 !important;
        }
        .lineup-switch-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.45) !important;
        }
    `;
    function createDomNode(tagName, options = {}) {
        const node = document.createElement(tagName);
        if (options.id) {
            node.id = options.id;
        }
        if (options.text !== undefined) {
            node.textContent = options.text;
        }
        if (options.html !== undefined) {
            node.innerHTML = options.html;
        }
        if (options.title !== undefined) {
            node.title = options.title;
        }
        if (options.value !== undefined) {
            node.value = options.value;
        }
        if (options.cssText) {
            node.style.cssText = options.cssText;
        }
        if (options.dataset) {
            Object.keys(options.dataset).forEach((key) => {
                node.dataset[key] = String(options.dataset[key]);
            });
        }
        if (options.events) {
            Object.keys(options.events).forEach((eventName) => {
                node[eventName] = options.events[eventName];
            });
        }
        if (options.children) {
            appendChildren(node, ...options.children);
        }
        return node;
    }
    function appendChildren(parentNode, ...children) {
        children
            .filter((child) => child !== null && child !== undefined)
            .forEach((child) => parentNode.appendChild(child));
        return parentNode;
    }
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function ensureLineupScrollbarStyle() {
        if (document.getElementById("lineup-scrollbar-style")) {
            return;
        }
        appendChildren(
            document.head,
            createDomNode("style", {
                id: "lineup-scrollbar-style",
                text: LINEUP_SCROLLBAR_STYLE + LINEUP_CARD_STYLE,
            }),
        );
    }
    function clearStatusTextLater(statusText, markers, delayMs = 3000) {
        setTimeout(() => {
            if (
                markers.some((marker) =>
                    statusText.textContent.includes(marker),
                )
            ) {
                statusText.textContent = "";
            }
        }, delayMs);
    }
    function getRoleTeamSlotCount(role) {
        const maxSlotCount = 6;
        const candidateValues = [
            role && role.teamSlotNum,
            role && role.paidTeamSlotNum,
            role && role.teamNum,
            role && role.presetTeamNum,
            role && role.presetSlotNum,
            role && role.teamSlotCount,
            role && role.slotTeamNum,
        ];
        for (const candidateValue of candidateValues) {
            const slotCount = toNumber(candidateValue, 0);
            if (slotCount > 0) {
                return Math.min(Math.max(slotCount, 1), maxSlotCount);
            }
        }
        const presetCollections = [
            role && role.presetTeam,
            role && role.presetTeams,
            role && role.presetTeamInfo,
            role && role.teamPreset,
            role && role.teamPresets,
        ];
        for (const presetCollection of presetCollections) {
            const entryCount = listCollectionEntries(presetCollection).length;
            if (entryCount > 0) {
                return Math.min(Math.max(entryCount, 1), maxSlotCount);
            }
        }
        try {
            const Configs = window.__require("Configs");
            const ModuleManager = window.__require("ModuleManager");
            const VIPModule = ModuleManager.GET_MODULE(Configs.ModuleType.VIP);
            const vipTeamSlotValue =
                VIPModule && typeof VIPModule.teamSlotNum === "function"
                    ? VIPModule.teamSlotNum()
                    : VIPModule && VIPModule.teamSlotNum;
            const vipSlotCount = toNumber(
                vipTeamSlotValue,
                0,
            );
            if (vipSlotCount > 0) {
                return Math.min(Math.max(vipSlotCount, 1), maxSlotCount);
            }
        } catch (error) {}
        return 3;
    }
    function getCurrentPresetTeamId(role) {
        const candidateValues = [
            role && role.presetTeamId,
            role && role.currentPresetTeamId,
            role && role.curPresetTeamId,
            role && role.teamId,
            role && role.currentTeamId,
        ];
        for (const candidateValue of candidateValues) {
            const teamId = toNumber(candidateValue, 0);
            if (teamId > 0) {
                return teamId;
            }
        }
        return 1;
    }
    function getPresetSlotButtonStyle(isActive) {
        return `
            min-width: 25px;
            height: 24px;
            padding: 0 7px;
            border-radius: 12px;
            border: 1px solid ${isActive ? "#f59e0b" : "rgba(203, 213, 225, 0.85)"};
            background: ${isActive ? "linear-gradient(135deg, #f59e0b 0%, #ea580c 100%)" : "rgba(241, 245, 249, 0.9)"};
            color: ${isActive ? "#ffffff" : "#475569"};
            box-shadow: ${isActive ? "0 2px 8px rgba(245, 158, 11, 0.35)" : "none"};
            cursor: pointer;
            font-size: 12px;
            font-weight: ${isActive ? "800" : "600"};
            line-height: 1;
            opacity: 1;
            transition: all 0.15s ease;
        `;
    }
    function hasTampermonkeyStorage() {
        return typeof GM_setValue === "function" && typeof GM_getValue === "function";
    }
    function decompressLineupStorageText(value) {
        if (
            typeof value !== "string" ||
            !value.startsWith(LINEUP_STORAGE_COMPRESSED_PREFIX)
        ) {
            return value;
        }
        if (typeof TextDecoder !== "function") {
            throw new Error("当前环境不支持解压阵容数据");
        }
        const payload = value.slice(LINEUP_STORAGE_COMPRESSED_PREFIX.length);
        if (!payload.length) {
            return "";
        }
        let dictionary = [];
        let nextCode = 256;
        let previousPhrase = String.fromCharCode(payload.charCodeAt(0));
        let currentCharacter = previousPhrase.charAt(0);
        const output = [previousPhrase];
        for (let index = 1; index < payload.length; index++) {
            const currentCode = payload.charCodeAt(index);
            let phrase;
            if (currentCode < 256) {
                phrase = String.fromCharCode(currentCode);
            } else if (dictionary[currentCode] !== undefined) {
                phrase = dictionary[currentCode];
            } else if (currentCode === nextCode) {
                phrase = previousPhrase + currentCharacter;
            } else {
                throw new Error("压缩阵容数据已损坏");
            }
            output.push(phrase);
            currentCharacter = phrase.charAt(0);
            if (nextCode < 65535) {
                dictionary[nextCode] = previousPhrase + currentCharacter;
                nextCode++;
            } else {
                dictionary = [];
                nextCode = 256;
            }
            previousPhrase = phrase;
        }
        const byteLength = output.reduce(
            (length, chunk) => length + chunk.length,
            0,
        );
        const bytes = new Uint8Array(byteLength);
        let byteOffset = 0;
        output.forEach((chunk) => {
            for (let index = 0; index < chunk.length; index++) {
                bytes[byteOffset++] = chunk.charCodeAt(index);
            }
        });
        return new TextDecoder("utf-8").decode(bytes);
    }
    function compressLineupStorageText(value) {
        const source = typeof value === "string" ? value : String(value || "");
        if (
            !source.length ||
            source.startsWith(LINEUP_STORAGE_COMPRESSED_PREFIX) ||
            typeof TextEncoder !== "function" ||
            typeof TextDecoder !== "function"
        ) {
            return source;
        }
        const bytes = new TextEncoder().encode(source);
        if (!bytes.length) {
            return source;
        }
        let dictionary = new Map();
        let nextCode = 256;
        let phrase = String.fromCharCode(bytes[0]);
        const output = [];
        for (let index = 1; index < bytes.length; index++) {
            const currentCharacter = String.fromCharCode(bytes[index]);
            const combinedPhrase = phrase + currentCharacter;
            if (dictionary.has(combinedPhrase)) {
                phrase = combinedPhrase;
                continue;
            }
            const phraseCode =
                phrase.length === 1
                    ? phrase.charCodeAt(0)
                    : dictionary.get(phrase);
            if (phraseCode === undefined) {
                return source;
            }
            output.push(String.fromCharCode(phraseCode));
            if (nextCode < 65535) {
                dictionary.set(combinedPhrase, nextCode);
                nextCode++;
            } else {
                dictionary = new Map();
                nextCode = 256;
            }
            phrase = currentCharacter;
        }
        const finalCode =
            phrase.length === 1
                ? phrase.charCodeAt(0)
                : dictionary.get(phrase);
        if (finalCode === undefined) {
            return source;
        }
        output.push(String.fromCharCode(finalCode));
        const compressed =
            LINEUP_STORAGE_COMPRESSED_PREFIX + output.join("");
        if (
            compressed.length >= source.length ||
            decompressLineupStorageText(compressed) !== source
        ) {
            return source;
        }
        return compressed;
    }
    function compressInactiveLineupAccountStorage(activeStorageKey) {
        if (hasTampermonkeyStorage()) {
            if (typeof GM_listValues !== "function") {
                return;
            }
            let inactiveKeys = [];
            try {
                inactiveKeys = GM_listValues().filter(
                    (key) =>
                        typeof key === "string" &&
                        key.startsWith(LINEUP_STORAGE_KEY_PREFIX) &&
                        key !== activeStorageKey,
                );
            } catch (error) {
                console.warn("[无限阵容] 读取其他账号 GM 存储列表失败", error);
                return;
            }
            inactiveKeys.forEach((storageKey) => {
                try {
                    const storedValue = GM_getValue(storageKey, null);
                    if (
                        typeof storedValue !== "string" ||
                        !storedValue.length ||
                        storedValue.startsWith(LINEUP_STORAGE_COMPRESSED_PREFIX)
                    ) {
                        return;
                    }
                    const compressedValue = compressLineupStorageText(storedValue);
                    if (compressedValue === storedValue) {
                        return;
                    }
                    GM_setValue(storageKey, compressedValue);
                    if (GM_getValue(storageKey, null) !== compressedValue) {
                        throw new Error("inactive GM lineup compression verification failed");
                    }
                    logLineupDebug("inactive GM account compressed", {
                        storageKey,
                        originalLength: storedValue.length,
                        compressedLength: compressedValue.length,
                    });
                } catch (error) {
                    console.warn("[无限阵容] 压缩其他账号 GM 阵容失败", storageKey, error);
                }
            });
            return;
        }
        const inactiveKeys = [];
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (
                key &&
                key.startsWith(LINEUP_STORAGE_KEY_PREFIX) &&
                key !== activeStorageKey
            ) {
                inactiveKeys.push(key);
            }
        }
        inactiveKeys.forEach((storageKey) => {
            const storedValue = localStorage.getItem(storageKey);
            if (
                typeof storedValue !== "string" ||
                !storedValue.length ||
                storedValue.startsWith(LINEUP_STORAGE_COMPRESSED_PREFIX)
            ) {
                return;
            }
            try {
                const compressedValue = compressLineupStorageText(storedValue);
                if (compressedValue === storedValue) {
                    return;
                }
                localStorage.setItem(storageKey, compressedValue);
                if (localStorage.getItem(storageKey) !== compressedValue) {
                    throw new Error("inactive lineup compression verification failed");
                }
                logLineupDebug("inactive account compressed", {
                    storageKey,
                    originalLength: storedValue.length,
                    compressedLength: compressedValue.length,
                });
            } catch (error) {
                console.warn("[无限阵容] 压缩其他账号阵容失败", storageKey, error);
            }
        });
    }
    function isQuotaExceededError(error) {
        if (!error) {
            return false;
        }
        return (
            error.name === "QuotaExceededError" ||
            error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
            error.code === 22 ||
            error.code === 1014
        );
    }
    function clearLineupOptionalCaches() {
        const removableKeys = [];
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (!key) {
                continue;
            }
            if (
                key.startsWith("xyzw_resource_mapper_v3_") ||
                key === "xyzw_legacy_resource_mapping_v1"
            ) {
                removableKeys.push(key);
            }
        }
        removableKeys.forEach((key) => localStorage.removeItem(key));
        if (removableKeys.length) {
            console.warn("[无限阵容] localStorage 空间不足，已清理资源缓存", removableKeys.length);
        }
    }
    function getLineupStoredText(storageKey) {
        if (hasTampermonkeyStorage()) {
            try {
                const gmValue = GM_getValue(storageKey, null);
                logLineupDebug("GM_getValue result", {
                    storageKey,
                    valueInfo: getLineupDebugValueInfo(gmValue),
                });
                if (typeof gmValue === "string") {
                    return decompressLineupStorageText(gmValue);
                }
                if (Array.isArray(gmValue)) {
                    return gmValue;
                }
                if (gmValue && typeof gmValue === "object") {
                    return gmValue;
                }
                if (gmValue !== null && gmValue !== undefined) {
                    return String(gmValue);
                }
            } catch (error) {
                console.warn("[无限阵容] 读取 GM 存储失败，回退到 localStorage", error);
            }
        }
        const localValue = localStorage.getItem(storageKey);
        const decodedLocalValue = decompressLineupStorageText(localValue);
        logLineupDebug("localStorage get result", {
            storageKey,
            compressed:
                typeof localValue === "string" &&
                localValue.startsWith(LINEUP_STORAGE_COMPRESSED_PREFIX),
            valueInfo: getLineupDebugValueInfo(decodedLocalValue),
        });
        return decodedLocalValue;
    }
    function setLineupStoredText(storageKey, text) {
        logLineupDebug("write start", {
            storageKey,
            textLength: typeof text === "string" ? text.length : 0,
            hasGM: hasTampermonkeyStorage(),
        });
        if (hasTampermonkeyStorage()) {
            const writeAndVerifyGmValue = () => {
                const writeResult = GM_setValue(storageKey, text);
                const verifyValue = GM_getValue(storageKey, null);
                logLineupDebug("GM_setValue result", {
                    storageKey,
                    writeResult,
                    verifyInfo: getLineupDebugValueInfo(verifyValue),
                });
                if (writeResult === false) {
                    throw new Error("GM_setValue returned false");
                }
                if (verifyValue !== text) {
                    throw new Error("GM_setValue write verification failed");
                }
            };
            try {
                writeAndVerifyGmValue();
                return;
            } catch (error) {
                console.warn("[无限阵容] 首次写入 GM 存储失败，清理后重试", error);
                try {
                    clearLineupOptionalCaches();
                    compressInactiveLineupAccountStorage(storageKey);
                    writeAndVerifyGmValue();
                    return;
                } catch (retryError) {
                    console.error("[无限阵容] 重试写入 GM 存储失败", retryError);
                    const reason =
                        retryError && retryError.message
                            ? retryError.message
                            : String(retryError || "未知错误");
                    throw new Error("阵容存储写入失败：" + reason);
                }
            }
        }
        try {
            localStorage.setItem(storageKey, text);
            const verifyValue = localStorage.getItem(storageKey);
            logLineupDebug("localStorage set result", {
                storageKey,
                verifyInfo: getLineupDebugValueInfo(verifyValue),
            });
            if (verifyValue !== text) {
                throw new Error("localStorage write verification failed");
            }
        } catch (error) {
            if (!isQuotaExceededError(error)) {
                throw error;
            }
            clearLineupOptionalCaches();
            try {
                localStorage.setItem(storageKey, text);
            } catch (retryError) {
                if (isQuotaExceededError(retryError)) {
                    throw new Error("内存储存已满，请删除部分旧阵容后重试");
                }
                throw retryError;
            }
            const verifyValue = localStorage.getItem(storageKey);
            logLineupDebug("localStorage set after cache cleanup", {
                storageKey,
                verifyInfo: getLineupDebugValueInfo(verifyValue),
            });
            if (verifyValue !== text) {
                throw new Error("阵容写入后校验失败，数据未保存");
            }
        }
    }
    function initializeLineupStorageMigration(storageKey) {
        if (!hasTampermonkeyStorage()) {
            return;
        }
        try {
            const gmValue = GM_getValue(storageKey, null);
            if (
                (typeof gmValue === "string" && gmValue.length) ||
                Array.isArray(gmValue) ||
                (gmValue && typeof gmValue === "object")
            ) {
                return;
            }
            const legacyValue = localStorage.getItem(storageKey);
            if (legacyValue !== null) {
                GM_setValue(storageKey, legacyValue);
            }
        } catch (error) {
            console.warn("[无限阵容] 迁移阵容存储失败", error);
        }
    }
    function hasOwnLineupField(source, fieldName) {
        return !!(
            source &&
            Object.prototype.hasOwnProperty.call(source, fieldName)
        );
    }
    function getFormationActiveSlots(formation) {
        const battleTeam = formation && formation.battleTeam;
        if (!battleTeam || typeof battleTeam !== "object") {
            return [];
        }
        return Object.keys(battleTeam).filter(
            (slotIndex) => toNumber(battleTeam[slotIndex], 0) > 0,
        );
    }
    function hasCompleteFormationSlotCoverage(formation, allowHeroFallback) {
        const activeSlots = getFormationActiveSlots(formation);
        if (!activeSlots.length) {
            return false;
        }
        const heroSlots = formation && formation.heroSlots;
        const heroes = formation && formation.heroes;
        return activeSlots.every((slotIndex) => {
            const heroId = toNumber(formation.battleTeam[slotIndex], 0);
            const slotState =
                heroSlots &&
                (heroSlots[slotIndex] || heroSlots[String(slotIndex)]);
            if (slotState && typeof slotState === "object") {
                return true;
            }
            if (!allowHeroFallback) {
                return false;
            }
            const heroState =
                heroes && (heroes[heroId] || heroes[String(heroId)]);
            return !!(heroState && typeof heroState === "object");
        });
    }
    function areLineupValuesEqual(left, right) {
        try {
            return JSON.stringify(left) === JSON.stringify(right);
        } catch (error) {
            return false;
        }
    }
    function compactSavedConfigForStorage(config) {
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            return config;
        }
        if (config.deleted) {
            return {
                id: config.id,
                name: config.name || "",
                deleted: true,
                createDate: config.createDate,
                updateDate: config.updateDate,
                deleteDate: config.deleteDate,
            };
        }
        const compactConfig = { ...config };
        delete compactConfig.source;
        if (!isFormationConfig(compactConfig)) {
            if (
                compactConfig.team &&
                typeof compactConfig.team === "object" &&
                !Array.isArray(compactConfig.team)
            ) {
                compactConfig.team = Object.fromEntries(
                    Object.entries(compactConfig.team).map(([slotIndex, slotConfig]) => {
                        const compactSlot = { ...(slotConfig || {}) };
                        delete compactSlot.battleSlot;
                        return [slotIndex, compactSlot];
                    }),
                );
            }
            return compactConfig;
        }
        const formation = { ...compactConfig.formation };
        const hasCompleteHeroSlots =
            hasCompleteFormationSlotCoverage(formation, false);
        const hasCompleteFormationTeam =
            hasCompleteFormationSlotCoverage(formation, true);
        if (hasCompleteHeroSlots) {
            delete formation.heroes;
        }
        if (
            hasOwnLineupField(formation, "enchantMap") &&
            formation.equipmentEnchant &&
            hasOwnLineupField(formation.equipmentEnchant, "enchantMap") &&
            areLineupValuesEqual(
                formation.enchantMap,
                formation.equipmentEnchant.enchantMap,
            )
        ) {
            delete formation.enchantMap;
        }
        compactConfig.formation = formation;
        if (hasCompleteFormationTeam) {
            delete compactConfig.team;
        }
        if (hasOwnLineupField(formation, "legionResearch")) {
            delete compactConfig.research;
        }
        if (hasOwnLineupField(formation, "presetTeamId")) {
            delete compactConfig.teamId;
        }
        if (hasOwnLineupField(formation, "lordWeaponId")) {
            delete compactConfig.weaponId;
        }
        if (hasOwnLineupField(formation, "pet")) {
            delete compactConfig.pet;
        }
        if (hasOwnLineupField(formation, "equipmentEnchant")) {
            delete compactConfig.equipmentEnchant;
        }
        return compactConfig;
    }
    function prepareSavedConfigsForStorage(savedConfigs) {
        return (Array.isArray(savedConfigs) ? savedConfigs : []).map(
            compactSavedConfigForStorage,
        );
    }
    function writeSavedConfigs(savedConfigs, syncBackup = false) {
        const userId = String(getUserId());
        const storageKey = getLineupStorageKey();
        const storedConfigs = prepareSavedConfigsForStorage(savedConfigs);
        const serializedConfigs = JSON.stringify(storedConfigs);
        const storageText = compressLineupStorageText(serializedConfigs);
        logLineupDebug("writeSavedConfigs", {
            userId: getUserId(),
            storageKey,
            count: storedConfigs.length,
            originalLength: serializedConfigs.length,
            storedLength: storageText.length,
            compressed: storageText !== serializedConfigs,
            visibleCount: storedConfigs.filter(
                (config) => !(config && config.deleted),
            ).length,
        });
        setLineupStoredText(
            storageKey,
            storageText,
        );
        // 若开启七彩云自动静默同步，加入防抖自动上传队列（仅上传有效阵容）
        try {
            queueSevenColorUpload(userId, storedConfigs.filter((c) => !(c && c.deleted)));
        } catch (syncErr) {
            console.warn("[无限阵容] 触发七彩云自动同步失败:", syncErr);
        }
        return storedConfigs;
    }
    function readAllSavedConfigs() {
        const storageKey = getLineupStorageKey();
        logLineupDebug("readAllSavedConfigs start", {
            userId: getUserId(),
            storageKey,
        });
        initializeLineupStorageMigration(storageKey);
        const savedConfigs = getLineupStoredText(storageKey);
        if (!savedConfigs) {
            logLineupDebug("readAllSavedConfigs empty", {
                storageKey,
            });
            return [];
        }
        if (Array.isArray(savedConfigs)) {
            logLineupDebug("readAllSavedConfigs array", {
                storageKey,
                count: savedConfigs.length,
            });
            return savedConfigs;
        }
        if (savedConfigs && typeof savedConfigs === "object") {
            logLineupDebug("readAllSavedConfigs object", {
                storageKey,
                valueInfo: getLineupDebugValueInfo(savedConfigs),
            });
            return Array.isArray(savedConfigs.configs)
                ? savedConfigs.configs
                : [];
        }
        const parsedConfigs = JSON.parse(savedConfigs);
        logLineupDebug("readAllSavedConfigs parsed", {
            storageKey,
            count: Array.isArray(parsedConfigs) ? parsedConfigs.length : -1,
        });
        return parsedConfigs;
    }
    function readSavedConfigs() {
        return readAllSavedConfigs().filter((config) => !(config && config.deleted));
    }
    function writeVisibleSavedConfigs(visibleConfigs) {
        const deletedConfigs = readAllSavedConfigs().filter(
            (config) => config && config.deleted,
        );
        writeSavedConfigs(
            [...(Array.isArray(visibleConfigs) ? visibleConfigs : []), ...deletedConfigs],
            true,
        );
    }
    function initializeSavedConfigsStorage() {
        const activeStorageKey = getLineupStorageKey();
        if (lineupRuntimeState.initializedStorageKey === activeStorageKey) {
            return;
        }
        compressInactiveLineupAccountStorage(activeStorageKey);
        if (getLineupStoredText(activeStorageKey) === null) {
            writeSavedConfigs([]);
        }
        lineupRuntimeState.initializedStorageKey = activeStorageKey;
    }
    function getLineupOpenerPositionKey() {
        return LINEUP_OPENER_POSITION_KEY_PREFIX + getUserId();
    }
    function clampLineupOpenerPosition(left, top, buttonNode) {
        const buttonWidth = buttonNode ? buttonNode.offsetWidth || 40 : 40;
        const buttonHeight = buttonNode ? buttonNode.offsetHeight || 40 : 40;
        const maxLeft = Math.max(0, window.innerWidth - buttonWidth);
        const maxTop = Math.max(0, window.innerHeight - buttonHeight);
        return {
            left: Math.min(Math.max(toNumber(left, 0), 0), maxLeft),
            top: Math.min(Math.max(toNumber(top, 70), 0), maxTop),
        };
    }
    function readLineupOpenerPosition(buttonNode) {
        try {
            const rawValue = localStorage.getItem(getLineupOpenerPositionKey());
            const parsedValue = rawValue ? JSON.parse(rawValue) : null;
            if (!parsedValue || typeof parsedValue !== "object") {
                return null;
            }
            return clampLineupOpenerPosition(
                parsedValue.left,
                parsedValue.top,
                buttonNode,
            );
        } catch (error) {
            return null;
        }
    }
    function writeLineupOpenerPosition(left, top, buttonNode) {
        const position = clampLineupOpenerPosition(left, top, buttonNode);
        localStorage.setItem(
            getLineupOpenerPositionKey(),
            JSON.stringify(position),
        );
        return position;
    }
    function applyLineupOpenerPosition(buttonNode, position) {
        if (!buttonNode || !position) {
            return;
        }
        buttonNode.style.left = position.left + "px";
        buttonNode.style.top = position.top + "px";
        buttonNode.style.right = "auto";
        if (typeof updateOpenerDockState === "function") {
            updateOpenerDockState(buttonNode, false);
        }
    }
    function clampLineupPanelPosition(left, top, panelNode) {
        const panelWidth = panelNode ? panelNode.offsetWidth || 300 : 300;
        const panelHeight = panelNode ? panelNode.offsetHeight || 200 : 200;
        const maxLeft = Math.max(
            LINEUP_PANEL_MARGIN,
            window.innerWidth - panelWidth - LINEUP_PANEL_MARGIN,
        );
        const maxTop = Math.max(
            LINEUP_PANEL_MARGIN,
            window.innerHeight - panelHeight - LINEUP_PANEL_MARGIN,
        );
        return {
            left: Math.min(
                Math.max(toNumber(left, LINEUP_PANEL_MARGIN), LINEUP_PANEL_MARGIN),
                maxLeft,
            ),
            top: Math.min(
                Math.max(toNumber(top, LINEUP_PANEL_MARGIN), LINEUP_PANEL_MARGIN),
                maxTop,
            ),
        };
    }
    function getLineupPanelPosition(buttonNode, panelNode) {
        if (!buttonNode) {
            return {
                left: LINEUP_PANEL_MARGIN,
                top: LINEUP_PANEL_MARGIN,
            };
        }
        const buttonRect = buttonNode.getBoundingClientRect();
        const panelWidth = panelNode ? panelNode.offsetWidth || 360 : 360;
        const panelHeight = panelNode ? panelNode.offsetHeight || 520 : 520;

        // 竖屏或窄屏窗口下自适应居中，左右留出对称边距
        if (window.innerWidth <= panelWidth + LINEUP_PANEL_MARGIN * 2 + 50) {
            const centerLeft = Math.max(LINEUP_PANEL_MARGIN, Math.round((window.innerWidth - panelWidth) / 2));
            const topPos = Math.min(
                Math.max(buttonRect.top - 8, LINEUP_PANEL_MARGIN),
                Math.max(LINEUP_PANEL_MARGIN, window.innerHeight - panelHeight - LINEUP_PANEL_MARGIN)
            );
            return clampLineupPanelPosition(centerLeft, topPos, panelNode);
        }

        const preferRightLeft = buttonRect.right + LINEUP_PANEL_GAP;
        const canPlaceRight =
            preferRightLeft + panelWidth <=
            window.innerWidth - LINEUP_PANEL_MARGIN;
        const rawLeft = canPlaceRight
            ? preferRightLeft
            : buttonRect.left - panelWidth - LINEUP_PANEL_GAP;
        const rawTop = buttonRect.top - 8;
        return clampLineupPanelPosition(rawLeft, rawTop, panelNode);
    }
    function applyLineupPanelPosition(panelNode, position) {
        if (!panelNode || !position) {
            return;
        }
        panelNode.style.left = position.left + "px";
        panelNode.style.top = position.top + "px";
        panelNode.style.right = "auto";
    }
    function syncLineupPanelPosition(buttonNode, panelNode) {
        if (!buttonNode || !panelNode) {
            return;
        }
        applyLineupPanelPosition(
            panelNode,
            getLineupPanelPosition(buttonNode, panelNode),
        );
    }
    function queueSyncLineupPanelPosition(buttonNode, panelNode) {
        if (!buttonNode || !panelNode) {
            return;
        }
        requestAnimationFrame(() => {
            syncLineupPanelPosition(buttonNode, panelNode);
            requestAnimationFrame(() => {
                syncLineupPanelPosition(buttonNode, panelNode);
            });
        });
    }
    // 侧边栏吸附与半隐弹出状态管理
    function updateOpenerDockState(buttonNode, isHovered = false) {
        if (!buttonNode) return;
        const curLeft = parseFloat(buttonNode.style.left || "0");
        const btnWidth = buttonNode.offsetWidth || 36;
        const screenWidth = window.innerWidth;
        const isRightSide = (curLeft + btnWidth / 2) > (screenWidth / 2);

        buttonNode.dataset.dockSide = isRightSide ? "right" : "left";

        if (isHovered) {
            // hover 时完全弹出
            buttonNode.style.transform = "translateX(0)";
            buttonNode.style.opacity = "1";
            buttonNode.style.boxShadow = "0 4px 16px rgba(0, 0, 0, 0.45), 0 0 12px rgba(251, 191, 36, 0.4)";
        } else {
            // 失去焦点/离开后吸附贴边，显示一半按钮
            buttonNode.style.opacity = "0.72";
            buttonNode.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.3)";
            if (isRightSide) {
                buttonNode.style.transform = "translateX(50%)";
            } else {
                buttonNode.style.transform = "translateX(-50%)";
            }
        }
    }

    function bindDraggableLineupOpener(buttonNode, onPositionChange = null) {
        if (!buttonNode) {
            return;
        }
        let dragState = null;

        // Hover 展开与离开吸附半隐事件
        buttonNode.addEventListener("mouseenter", () => {
            if (!dragState) updateOpenerDockState(buttonNode, true);
        });
        buttonNode.addEventListener("mouseleave", () => {
            if (!dragState) updateOpenerDockState(buttonNode, false);
        });
        buttonNode.addEventListener("focus", () => {
            if (!dragState) updateOpenerDockState(buttonNode, true);
        });
        buttonNode.addEventListener("blur", () => {
            if (!dragState) updateOpenerDockState(buttonNode, false);
        });
        const readPointer = (event) => {
            const touch =
                event.touches && event.touches.length
                    ? event.touches[0]
                    : event.changedTouches && event.changedTouches.length
                      ? event.changedTouches[0]
                      : event;
            return {
                x: touch.clientX,
                y: touch.clientY,
            };
        };
        const finishDrag = (event) => {
            if (!dragState) {
                return;
            }
            const moved = dragState.moved;
            if (moved) {
                const btnWidth = buttonNode.offsetWidth || 36;
                const curLeft = parseFloat(buttonNode.style.left || "0");
                const screenWidth = window.innerWidth;
                const isRightSide = (curLeft + btnWidth / 2) > (screenWidth / 2);
                // 自动吸附到最近的侧边栏 (贴左或贴右)
                const dockedLeft = isRightSide ? (screenWidth - btnWidth) : 0;
                const curTop = parseFloat(buttonNode.style.top || "70");

                buttonNode.style.left = dockedLeft + "px";
                writeLineupOpenerPosition(
                    dockedLeft,
                    curTop,
                    buttonNode,
                );
                updateOpenerDockState(buttonNode, false);
                lineupRuntimeState.suppressNextOpenerClick = true;
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }
            document.removeEventListener("mousemove", handleMove, true);
            document.removeEventListener("mouseup", finishDrag, true);
            document.removeEventListener("touchmove", handleMove, true);
            document.removeEventListener("touchend", finishDrag, true);
            document.removeEventListener("touchcancel", finishDrag, true);
            dragState = null;
        };
        const handleMove = (event) => {
            if (!dragState) {
                return;
            }
            const pointer = readPointer(event);
            const deltaX = pointer.x - dragState.startX;
            const deltaY = pointer.y - dragState.startY;
            if (!dragState.moved && Math.hypot(deltaX, deltaY) < 6) {
                return;
            }
            dragState.moved = true;
            const nextPosition = clampLineupOpenerPosition(
                dragState.startLeft + deltaX,
                dragState.startTop + deltaY,
                buttonNode,
            );
            applyLineupOpenerPosition(buttonNode, nextPosition);
            if (typeof onPositionChange === "function") {
                onPositionChange();
            }
            event.preventDefault();
            event.stopPropagation();
        };
        const startDrag = (event) => {
            if (event.button !== undefined && event.button !== 0) {
                return;
            }
            const pointer = readPointer(event);
            const rect = buttonNode.getBoundingClientRect();
            dragState = {
                startX: pointer.x,
                startY: pointer.y,
                startLeft: rect.left,
                startTop: rect.top,
                moved: false,
            };
            document.addEventListener("mousemove", handleMove, true);
            document.addEventListener("mouseup", finishDrag, true);
            document.addEventListener("touchmove", handleMove, {
                capture: true,
                passive: false,
            });
            document.addEventListener("touchend", finishDrag, true);
            document.addEventListener("touchcancel", finishDrag, true);
        };
        buttonNode.addEventListener("mousedown", startDrag, true);
        buttonNode.addEventListener("touchstart", startDrag, {
            capture: true,
            passive: false,
        });
        window.addEventListener("resize", () => {
            const position = writeLineupOpenerPosition(
                parseFloat(buttonNode.style.left || "0"),
                parseFloat(buttonNode.style.top || "70"),
                buttonNode,
            );
            applyLineupOpenerPosition(buttonNode, position);
            if (typeof onPositionChange === "function") {
                onPositionChange();
            }
        });
    }
    function toNumber(value, fallback = 0) {
        const numericValue = Number(value);
        return Number.isFinite(numericValue) ? numericValue : fallback;
    }
    function firstPositiveNumber(...values) {
        for (const value of values) {
            const numericValue = toNumber(value, 0);
            if (numericValue > 0) {
                return numericValue;
            }
        }
        return 0;
    }
    function pickRuntimeField(source, fields) {
        if (!source) {
            return "";
        }
        for (const field of fields) {
            const value = source[field];
            if (value !== undefined && value !== null && value !== "") {
                return value;
            }
        }
        return "";
    }
    function extractPearlRuntimeSkillId(pearl) {
        const value = pickRuntimeField(pearl, [
            "pearlSkillId",
            "skillType",
            "skillTypeId",
            "skillConfId",
            "skillConfigId",
            "skillItemId",
            "effectId",
            "effectType",
            "attrId",
            "abilityId",
            "passiveSkillId",
            "appendSkillId",
            "appendSkill",
        ]);
        if (Array.isArray(value)) {
            return toNumber(value.find((item) => toNumber(item, 0) > 0), 0);
        }
        const direct = toNumber(value, 0);
        if (direct > 0) {
            return direct;
        }
        const maybeLevel = toNumber(pearl && pearl.skillId, 0);
        return maybeLevel > 100 ? maybeLevel : 0;
    }
    function escapeHtml(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
    function formatPowerValue(value) {
        const numericValue = toNumber(value, 0);
        if (numericValue <= 0) {
            return "";
        }
        if (numericValue >= 100000000) {
            return (numericValue / 100000000).toFixed(2) + "亿";
        }
        if (numericValue >= 10000) {
            return (numericValue / 10000).toFixed(2) + "万";
        }
        return String(Math.round(numericValue));
    }
    function getHeroSpeed(hero) {
        if (!hero) {
            return 0;
        }
        const directSpeed = toNumber(
            hero.speed ||
                hero.battleSpeed ||
                hero.finalSpeed ||
                hero.totalSpeed ||
                (hero.attribute && hero.attribute.speed) ||
                (hero.attrs && hero.attrs.speed) ||
                (hero.totalAttribute && hero.totalAttribute.speed),
            0,
        );
        if (directSpeed > 0) {
            return directSpeed;
        }
        if (hero.attribute && typeof hero.attribute.get === "function") {
            return toNumber(
                hero.attribute.get("speed") ||
                    hero.attribute.get("SPEED") ||
                    hero.attribute.get(4),
                0,
            );
        }
        return 0;
    }
    function getHeroPower(hero) {
        if (!hero) {
            return 0;
        }
        return toNumber(
            hero.power ||
                hero.fightPower ||
                hero.combatPower ||
                hero.calculatePower,
            0,
        );
    }
    function normalizeLineupSlotIndex(value) {
        const numericValue = toNumber(value, -1);
        if (numericValue >= 0 && numericValue < 5) {
            return numericValue;
        }
        if (numericValue >= 1 && numericValue <= 5) {
            return numericValue - 1;
        }
        return -1;
    }
    function getBattleSlotPositionIndex(battleSlot, fallbackIndex) {
        if (battleSlot) {
            const keys = [
                "pos",
                "position",
                "site",
                "seat",
                "slot",
                "battlePos",
                "battlePosition",
                "teamPos",
                "formationPos",
                "standPos",
                "location",
                "index",
            ];
            for (const key of keys) {
                const normalized = normalizeLineupSlotIndex(battleSlot[key]);
                if (normalized >= 0) {
                    return normalized;
                }
            }
        }
        return normalizeLineupSlotIndex(fallbackIndex);
    }
    function getLineupVisualSlotIndex(slotConfig, fallbackSlotIndex) {
        const savedVisualIndex = normalizeLineupSlotIndex(
            slotConfig && slotConfig.visualSlotIndex,
        );
        if (savedVisualIndex >= 0) {
            return savedVisualIndex;
        }
        const savedPositionIndex = normalizeLineupSlotIndex(
            slotConfig && slotConfig.positionIndex,
        );
        if (savedPositionIndex >= 0) {
            return savedPositionIndex;
        }
        return normalizeLineupSlotIndex(fallbackSlotIndex);
    }
    function getLineupVisualGridStyle(slotIndex, slotConfig) {
        const visualSlotIndex = getLineupVisualSlotIndex(slotConfig, slotIndex);
        const visualPositions = {
            0: "grid-column: 2; grid-row: 1;",
            1: "grid-column: 2; grid-row: 2;",
            2: "grid-column: 1; grid-row: 1;",
            3: "grid-column: 1; grid-row: 2;",
            4: "grid-column: 1; grid-row: 3;",
        };
        return visualPositions[visualSlotIndex] || "";
    }
    function getTeamSlots(teamConfig) {
        const result = [];
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const slotConfig =
                teamConfig &&
                (teamConfig[slotIndex] || teamConfig[String(slotIndex)]);
            if (!slotConfig || !toNumber(slotConfig.heroId, 0)) {
                continue;
            }
            result.push({
                slotIndex,
                slotConfig,
                speed: toNumber(slotConfig.speed, 0),
            });
        }
        return result;
    }
    function getSpeedRankMap(teamSlots) {
        const sortedSlots = [...teamSlots].sort((left, right) => {
            const speedDiff = toNumber(right.speed, 0) - toNumber(left.speed, 0);
            return speedDiff || left.slotIndex - right.slotIndex;
        });
        const result = new Map();
        sortedSlots.forEach((slot, index) => {
            result.set(slot.slotIndex, index + 1);
        });
        return result;
    }
    function shortResourceName(resourceInfo, fallback) {
        const name = resourceInfo && resourceInfo.name ? resourceInfo.name : fallback;
        return String(name || "").replace(/碎片$/, "");
    }
    //#region debug-point lineup-icons-blank
    function reportLineupIconDebug(event, payload) {
        try {
            const list = (window.__XYZW_ICON_DEBUG__ =
                window.__XYZW_ICON_DEBUG__ || []);
            list.push({ event, time: Date.now(), payload });
            if (list.length > 200) {
                list.splice(0, list.length - 200);
            }
        } catch (error) {}
    }
    //#endregion debug-point lineup-icons-blank
    function setResourceImage(imgNode, resourceInfo, fallbackLabel) {
        if (!imgNode || !resourceInfo) {
            return;
        }
        const iconUrl = resourceInfo.iconUrl || resourceInfo.webiconUrl || "";
        //#region debug-point lineup-icons-blank
        reportLineupIconDebug("set-resource-image", {
            fallbackLabel,
            name: resourceInfo.name,
            type: resourceInfo.type,
            id: resourceInfo.id,
            iconPath: resourceInfo.iconPath,
            rawIconPath: resourceInfo.rawIconPath,
            iconUrl,
            atlasUrl: resourceInfo.atlasUrl,
            rect: resourceInfo.rect,
            nodeWidth: imgNode.clientWidth,
            nodeHeight: imgNode.clientHeight,
            currentSrc: imgNode.getAttribute("src"),
        });
        //#endregion debug-point lineup-icons-blank
        imgNode.title = [
            resourceInfo.name || fallbackLabel || "",
            resourceInfo.iconPath ? "path: " + resourceInfo.iconPath : "",
            resourceInfo.rawIconPath ? "raw: " + resourceInfo.rawIconPath : "",
            resourceInfo.atlasUrl ? "atlas: " + resourceInfo.atlasUrl : "",
            resourceInfo.rect ? "rect: " + JSON.stringify(resourceInfo.rect) : "",
        ]
            .filter(Boolean)
            .join("\n");
        imgNode.alt = resourceInfo.name || fallbackLabel || "";
        if (!iconUrl) {
            return;
        }
        imgNode.decoding = "async";
        imgNode.loading = "eager";
        imgNode.referrerPolicy = "no-referrer";
        const rect = resourceInfo.rect;
        if (rect && resourceInfo.atlasUrl) {
            const width = Math.max(1, toNumber(rect.width, 0));
            const height = Math.max(1, toNumber(rect.height, 0));
            const targetNode = imgNode.parentElement || imgNode;
            const displayWidth = imgNode.clientWidth || targetNode.clientWidth || toNumber(imgNode.width, 0) || 38;
            const displayHeight = imgNode.clientHeight || targetNode.clientHeight || toNumber(imgNode.height, 0) || displayWidth;
            const scaleX = displayWidth / width;
            const scaleY = displayHeight / height;
            imgNode.removeAttribute("src");
            imgNode.style.visibility = "hidden";
            targetNode.style.backgroundImage = "url(\"" + resourceInfo.atlasUrl + "\")";
            targetNode.style.backgroundRepeat = "no-repeat";
            targetNode.style.backgroundPosition =
                "-" + toNumber(rect.x, 0) * scaleX + "px -" + toNumber(rect.y, 0) * scaleY + "px";
            targetNode.style.backgroundSize = "auto";
            targetNode.style.backgroundColor = "transparent";
            targetNode.style.borderRadius = targetNode.style.borderRadius || imgNode.style.borderRadius || "8px";
            const atlasImage = new Image();
            atlasImage.referrerPolicy = "no-referrer";
            atlasImage.onload = () => {
                targetNode.style.backgroundSize =
                    atlasImage.naturalWidth * scaleX + "px " +
                    atlasImage.naturalHeight * scaleY + "px";
                targetNode.style.opacity = "1";
            };
            atlasImage.onerror = () => {
                console.warn("[资源映射] 图集加载失败", {
                    name: resourceInfo.name,
                    iconPath: resourceInfo.iconPath,
                    atlasUrl: resourceInfo.atlasUrl,
                });
                targetNode.style.opacity = "0.35";
            };
            atlasImage.src = resourceInfo.atlasUrl;
            targetNode.style.opacity = "1";
            return;
        }
        imgNode.onerror = () => {
            console.warn("[资源映射] 图片加载失败", {
                name: resourceInfo.name,
                iconPath: resourceInfo.iconPath,
                rawIconPath: resourceInfo.rawIconPath,
                iconUrl,
                atlasUrl: resourceInfo.atlasUrl,
            });
            imgNode.style.opacity = "0.35";
        };
        imgNode.onload = () => {
            imgNode.style.opacity = "1";
        };
        const imageParent = imgNode.parentElement;
        if (imageParent) {
            imageParent.style.backgroundImage = "";
            imageParent.style.opacity = "1";
        }
        imgNode.style.visibility = "visible";
        imgNode.style.backgroundImage = "";
        imgNode.src = iconUrl;
        imgNode.style.opacity = "1";
    }
    async function hydrateLineupCardResources(cardElement, activeConfig) {
        if (!cardElement || !activeConfig) {
            return;
        }
        try {
            xyzwResourceMapper.ensureReady().catch((error) => {
                console.warn("[资源映射] 初始化失败，继续使用运行时配置", error);
            });
            const teamSlots = getTeamSlots(activeConfig.team);
            await Promise.all(
                teamSlots.map(async ({ slotIndex, slotConfig }) => {
                    const heroId = toNumber(slotConfig.heroId, 0);
                    const skinId = toNumber(slotConfig.useSkin, -1);
                    const heroInfo = await xyzwResourceMapper.resolveHero(
                        heroId,
                        skinId,
                    );
                    //#region debug-point lineup-icons-blank
                    reportLineupIconDebug("resolved-hero", {
                        slotIndex,
                        heroId,
                        skinId,
                        name: heroInfo && heroInfo.name,
                        iconPath: heroInfo && heroInfo.iconPath,
                        rawIconPath: heroInfo && heroInfo.rawIconPath,
                        iconUrl: heroInfo && heroInfo.iconUrl,
                        atlasUrl: heroInfo && heroInfo.atlasUrl,
                        rect: heroInfo && heroInfo.rect,
                        avatarId: heroInfo && heroInfo.avatarId,
                    });
                    //#endregion debug-point lineup-icons-blank
                    const fallbackName =
                        slotConfig.name || slotConfig.nickName || "武将" + heroId;
                    const heroName = shortResourceName(heroInfo, fallbackName);
                    const nameNode = cardElement.querySelector(
                        `[data-lineup-hero-name="${slotIndex}"]`,
                    );
                    if (nameNode) {
                        nameNode.textContent = heroName;
                    }
                    setResourceImage(
                        cardElement.querySelector(
                            `[data-lineup-img="hero"][data-slot="${slotIndex}"]`,
                        ),
                        heroInfo,
                        fallbackName,
                    );
                    if (toNumber(slotConfig.artifactId, 0) > 0) {
                        const artifactInfo =
                            await xyzwResourceMapper.resolveArtifact(
                                slotConfig.artifactId,
                            );
                        const artifactNode = cardElement.querySelector(
                            `[data-lineup-artifact-name="${slotIndex}"]`,
                        );
                        if (artifactNode) {
                            artifactNode.textContent = shortResourceName(
                                artifactInfo,
                                "鱼灵" + slotConfig.artifactId,
                            );
                            artifactNode.title = artifactInfo && artifactInfo.name
                                ? artifactInfo.name
                                : "鱼灵" + slotConfig.artifactId;
                        }
                    }
                    if (toNumber(slotConfig.pearlId, 0) > 0) {
                        const savedAppendPearlSkillId = Array.isArray(slotConfig.appendSkill)
                            ? slotConfig.appendSkill
                                  .map((skillId) => toNumber(skillId, 0))
                                  .find((skillId) => skillId >= 1033007 && skillId <= 1033017)
                            : 0;
                        const pearlInfo = await xyzwResourceMapper.resolvePearl(
                            slotConfig.pearlId,
                            savedAppendPearlSkillId || slotConfig.pearlSkillId,
                            slotConfig.pearl,
                        );
                        const pearlNode = cardElement.querySelector(
                            `[data-lineup-pearl-name="${slotIndex}"]`,
                        );
                        if (pearlNode) {
                            pearlNode.textContent = shortResourceName(
                                pearlInfo,
                                "鱼珠" + slotConfig.pearlId,
                            );
                            pearlNode.title = pearlInfo && pearlInfo.name
                                ? pearlInfo.name
                                : "鱼珠" + slotConfig.pearlId;
                        }
                    }
                }),
            );
            if (toNumber(activeConfig.weaponId, 0) > 0) {
                const weaponInfo = await xyzwResourceMapper.resolveWeapon(
                    activeConfig.weaponId,
                );
                setResourceImage(
                    cardElement.querySelector('[data-lineup-img="weapon"]'),
                    weaponInfo,
                    "玩具" + activeConfig.weaponId,
                );
                const labelNode = cardElement.querySelector(
                    '[data-lineup-label="weapon"]',
                );
                if (labelNode) {
                    labelNode.textContent = shortResourceName(
                        weaponInfo,
                        "玩具" + activeConfig.weaponId,
                    );
                }
            }
            const petId = toNumber(activeConfig.pet && activeConfig.pet.petId, 0);
            if (petId > 0) {
                const petInfo = await xyzwResourceMapper.resolvePet(petId);
                setResourceImage(
                    cardElement.querySelector('[data-lineup-img="pet"]'),
                    petInfo,
                    "宠物" + petId,
                );
                const labelNode = cardElement.querySelector(
                    '[data-lineup-label="pet"]',
                );
                if (labelNode) {
                    labelNode.textContent = shortResourceName(
                        petInfo,
                        "宠物" + petId,
                    );
                }
            }
        } catch (error) {
            console.warn("[资源映射] 队伍卡片贴图刷新失败", error);
        }
    }
    function buildLineupCardHtml(savedConfig, activeConfig, configIndex, isCurrentLineup = false) {
        const teamSlots = getTeamSlots(activeConfig.team);
        const rankMap = getSpeedRankMap(teamSlots);
        const powerText = formatPowerValue(
            (activeConfig.formation && activeConfig.formation.power) ||
                activeConfig.power ||
                savedConfig.power,
        );
        const title = savedConfig.name || `阵容${configIndex + 1}`;
        const group = savedConfig.group || "PVP";
        const groupStyles = {
            "PVP": { bg: "#f5f3ff", color: "#6d28d9", border: "#ddd6fe", icon: "⚔️" },
            "PVE": { bg: "#ecfdf5", color: "#047857", border: "#a7f3d0", icon: "🛡️" },
            "星级挑战": { bg: "#fff7ed", color: "#c2410c", border: "#fed7aa", icon: "🌟" },
        };
        const gMeta = groupStyles[group] || groupStyles["PVP"];
        const groupBadge = `<span class="lineup-group-badge" data-group="${escapeHtml(group)}" style="display:inline-flex;align-items:center;gap:2px;padding:2px 6px;border-radius:6px;background:${gMeta.bg};color:${gMeta.color};border:1px solid ${gMeta.border};font-size:10px;font-weight:700;line-height:13px;cursor:pointer;margin-right:5px;" title="点击可快速切换分组">${gMeta.icon} ${escapeHtml(group)}</span>`;

        const currentLineupBadge = isCurrentLineup
            ? `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:6px;padding:2px 7px;border-radius:6px;background:linear-gradient(135deg, #3b82f6, #2563eb);color:#ffffff;font-size:10px;font-weight:800;line-height:13px;box-shadow:0 1px 4px rgba(37,99,235,0.3);letter-spacing:0.3px;"><span style="font-size:8px;">●</span>当前生效</span>`
            : "";
        const powerBadge = powerText
            ? `<span style="display:inline-flex;align-items:center;gap:2px;padding:2px 6px;border-radius:6px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;font-size:10px;font-weight:700;line-height:13px;margin-right:5px;"><span style="color:#d97706;">⚡</span>${escapeHtml(powerText)}</span>`
            : "";
        const teamSlotBadge = activeConfig.teamId
            ? `<span style="display:inline-flex;align-items:center;padding:2px 6px;border-radius:6px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;font-size:10px;font-weight:600;line-height:13px;">槽位 ${escapeHtml(activeConfig.teamId)}</span>`
            : `<span style="display:inline-flex;align-items:center;padding:2px 6px;border-radius:6px;background:#f8fafc;color:#94a3b8;font-size:10px;line-height:13px;">未绑卡槽</span>`;

        const speedRankBadgeStyle = (rank) => {
            if (rank === 1) {
                return 'background: linear-gradient(135deg, #ef4444, #f59e0b); color: #fff; box-shadow: 0 1px 3px rgba(239, 68, 68, 0.4);';
            } else if (rank === 2) {
                return 'background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff;';
            } else {
                return 'background: linear-gradient(135deg, #3b82f6, #0ea5e9); color: #fff;';
            }
        };

        const heroTiles = teamSlots
            .map(({ slotIndex, slotConfig }) => {
                const heroId = toNumber(slotConfig.heroId, 0);
                const speed = toNumber(slotConfig.speed, 0);
                const speedRank = rankMap.get(slotIndex) || slotIndex + 1;
                const name = slotConfig.name || slotConfig.nickName || "武将" + heroId;
                const artifactVisible = toNumber(slotConfig.artifactId, 0) > 0 ? "" : "display:none;";
                const pearlVisible = toNumber(slotConfig.pearlId, 0) > 0 ? "" : "display:none;";
                return `
                    <div class="lineup-hero-tile" data-slot="${slotIndex}" style="${getLineupVisualGridStyle(slotIndex, slotConfig)}">
                        <div class="lineup-hero-label">
                            <span data-lineup-hero-name="${slotIndex}">${escapeHtml(name)}</span>
                            <span class="lineup-speed-badge">${speed ? escapeHtml(speed) : ""}</span>
                        </div>
                        <div class="lineup-hero-icons">
                            <div class="lineup-hero-avatar" title="阵位${slotIndex + 1}，速度排名${speedRank}${speed ? "，速度" + escapeHtml(speed) : ""}">
                                <img data-lineup-img="hero" data-slot="${slotIndex}" data-hero-id="${heroId}" data-skin-id="${toNumber(slotConfig.useSkin, -1)}" />
                                <span class="lineup-slot-badge" style="${speedRankBadgeStyle(speedRank)}" title="速度排名${speedRank}">${speedRank}</span>
                            </div>
                            <div class="lineup-attach-icons">
                                <span class="lineup-artifact-text" data-lineup-artifact-name="${slotIndex}" style="${artifactVisible}">${toNumber(slotConfig.artifactId, 0) > 0 ? "鱼灵" + escapeHtml(slotConfig.artifactId) : ""}</span>
                                <span class="lineup-pearl-text" data-lineup-pearl-name="${slotIndex}" style="${pearlVisible}">${toNumber(slotConfig.pearlId, 0) > 0 ? "鱼珠" + escapeHtml(slotConfig.pearlId) : ""}</span>
                            </div>
                        </div>
                    </div>
                `;
            })
            .join("");
        return `
            <style>
                .lineup-card-visual img {
                    background: transparent;
                    border-radius: 8px;
                    object-fit: cover;
                    opacity: .25;
                }
                .lineup-speed-row {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    overflow-x: auto;
                    padding: 5px 0 2px;
                    scrollbar-width: none;
                }
                .lineup-speed-pill {
                    flex: 0 0 auto;
                    padding: 2px 6px;
                    border-radius: 999px;
                    background: #eef6ff;
                    color: #2563eb;
                    font-size: 10px;
                    line-height: 16px;
                    white-space: nowrap;
                }
                .lineup-speed-pill b {
                    margin-right: 3px;
                    color: #0f766e;
                }
                .lineup-hero-grid {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 5px;
                    flex: 1;
                    min-width: 0;
                }
                .lineup-hero-tile {
                    min-width: 0;
                }
                .lineup-hero-label {
                    display: flex;
                    align-items: center;
                    gap: 3px;
                    color: #047857;
                    font-size: 10px;
                    font-weight: 700;
                    line-height: 14px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .lineup-speed-badge {
                    color: #7c3aed;
                    font-size: 10px;
                    font-weight: 700;
                }
                .lineup-hero-icons {
                    display: flex;
                    align-items: flex-start;
                    gap: 5px;
                    margin-top: 2px;
                }
                .lineup-hero-avatar {
                    position: relative;
                    width: 40px;
                    height: 40px;
                    flex: 0 0 auto;
                    border-radius: 9px;
                    background: #e2e8f0;
                    overflow: hidden;
                    border: 1px solid rgba(226, 232, 240, 0.9);
                }
                .lineup-hero-avatar img {
                    width: 40px;
                    height: 40px;
                    display: block;
                    object-fit: cover;
                }
                .lineup-slot-badge {
                    position: absolute;
                    right: -1px;
                    bottom: -1px;
                    min-width: 14px;
                    height: 14px;
                    padding: 0 3px;
                    border-radius: 4px;
                    font-size: 9px;
                    line-height: 14px;
                    text-align: center;
                    font-weight: 800;
                    box-sizing: border-box;
                }
                .lineup-attach-icons {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    min-width: 46px;
                    padding-top: 1px;
                }
                .lineup-attach-icons img {
                    width: 18px;
                    height: 18px;
                    border-radius: 5px;
                    display: block;
                }
                .lineup-attach-icon-wrap {
                    position: relative;
                    width: 18px;
                    height: 18px;
                    border-radius: 5px;
                    overflow: hidden;
                    background: transparent;
                    display: block;
                }
                .lineup-artifact-text,
                .lineup-pearl-text {
                    display: block;
                    max-width: 52px;
                    font-size: 11px;
                    line-height: 14px;
                    font-weight: 700;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    text-align: left;
                    -webkit-font-smoothing: antialiased;
                }
                .lineup-artifact-text {
                    color: #d97706;
                }
                .lineup-pearl-text {
                    color: #7c3aed;
                }
                .lineup-side-assets {
                    width: 46px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    flex-shrink: 0;
                }
                .lineup-side-asset {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 2px;
                    color: #64748b;
                    font-size: 10px;
                    line-height: 12px;
                }
                .lineup-side-asset img {
                    width: 32px;
                    height: 32px;
                    display: block;
                }
                .lineup-side-icon-wrap {
                    position: relative;
                    width: 32px;
                    height: 32px;
                    border-radius: 8px;
                    overflow: hidden;
                    background: transparent;
                    display: block;
                }
            </style>
            <div class="lineup-card-visual">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                    <div class="lineup-name-container" style="font-size: 15px; font-weight: 700; color: #0f172a; cursor: pointer; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; display: flex; align-items: center; gap: 5px;" title="点击名称可直接重命名">
                        <span class="lineup-name-text" style="outline: none; border-radius: 4px; padding: 0 2px;">${escapeHtml(String(title || '').replace(/✏️/g, '').trim())}</span>
                        <span class="lineup-rename-hint" style="font-size: 11px; color: #94a3b8; opacity: 0.7; user-select: none;">✏️</span>
                    </div>
                    <button data-action="delete" title="删除阵容" class="lineup-delete-btn" style="background: transparent; border: none; font-size: 16px; color: #94a3b8; cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; border-radius: 6px; flex-shrink: 0; transition: all 0.15s ease;"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M5.75 3V1.5h4.5V3zm-1.5 0V1a1 1 0 0 1 1-1h5.5a1 1 0 0 1 1 1v2h2.5a.75.75 0 0 1 0 1.5h-.365l-.743 9.653A2 2 0 0 1 11.148 16H4.852a2 2 0 0 1-1.994-1.847L2.115 4.5H1.75a.75.75 0 0 1 0-1.5zm-.63 1.5h8.76l-.734 9.538a.5.5 0 0 1-.498.462H4.852a.5.5 0 0 1-.498-.462z" clip-rule="evenodd"></path></svg></button>
                </div>
                <div style="margin-top: 4px; color: #64748b; font-size: 11px; text-align: left; display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
                    ${currentLineupBadge}${groupBadge}${powerBadge}${teamSlotBadge}
                </div>
                <div style="display:flex;align-items:flex-start;gap:6px;margin-top:6px;">
                    <div class="lineup-hero-grid">${heroTiles}</div>
                    <div class="lineup-side-assets">
                        <div class="lineup-side-asset" style="${activeConfig.weaponId ? "" : "display:none;"}">
                            <span class="lineup-side-icon-wrap"><img data-lineup-img="weapon" /></span>
                            <span data-lineup-label="weapon">${activeConfig.weaponId ? "玩具" + escapeHtml(activeConfig.weaponId) : ""}</span>
                        </div>
                        <div class="lineup-side-asset" style="${activeConfig.pet && activeConfig.pet.petId ? "" : "display:none;"}">
                            <span class="lineup-side-icon-wrap"><img data-lineup-img="pet" /></span>
                            <span data-lineup-label="pet">${activeConfig.pet && activeConfig.pet.petId ? "宠物" + escapeHtml(activeConfig.pet.petId) : ""}</span>
                        </div>
                    </div>
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; padding-top: 4px; border-top: 1px solid rgba(241, 245, 249, 0.8);">
                    <div style="display: flex; align-items: center; gap: 5px; font-size: 11px; text-align: left; min-width: 0; flex: 1;">
                        <button class="lineup-sort-btn" style="background: #f1f5f9; border: 1px solid #e2e8f0; color: #64748b; font-size: 11px; width: 24px; height: 24px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: all 0.15s ease;" data-action="move-up" data-index="${configIndex}" title="上移阵容">▲</button>
                        <button class="lineup-sort-btn" style="background: #f1f5f9; border: 1px solid #e2e8f0; color: #64748b; font-size: 11px; width: 24px; height: 24px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: all 0.15s ease;" data-action="move-down" data-index="${configIndex}" title="下移阵容">▼</button>
                    </div>
                    <div class="lineup-actions" style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
                        <button data-action="switch" class="lineup-switch-btn" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); border: none; color: #fff; padding: 6px 16px; border-radius: 20px; cursor: pointer; font-size: 12px; font-weight: 700; display: flex; align-items: center; gap: 4px; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3); transition: all 0.15s ease;">⟳ 切换</button>
                    </div>
                </div>
            </div>
        `;
    }
    function listCollectionEntries(collection) {
        if (!collection) {
            return [];
        }
        if (typeof collection.entries === "function") {
            return Array.from(collection.entries());
        }
        if (Array.isArray(collection)) {
            return collection.map((value, index) => [index, value]);
        }
        if (typeof collection.forEach === "function") {
            const entries = [];
            collection.forEach((value, key) => {
                entries.push([key, value]);
            });
            return entries;
        }
        return Object.keys(collection).map((key) => [key, collection[key]]);
    }
    function normalizeUidString(value) {
        if (value === undefined || value === null) {
            return "";
        }
        const normalized = String(value);
        if (
            !normalized ||
            normalized === "0" ||
            normalized === "undefined" ||
            normalized === "null"
        ) {
            return "";
        }
        return normalized;
    }
    function getHeroUid(hero) {
        if (!hero) {
            return "";
        }
        return normalizeUidString(hero.attachmentUid || hero.uId || hero.uid);
    }
    function findLiveHeroByBattleSlot(role, battleSlot, fallbackSlotIndex = -1) {
        if (!role || !battleSlot) {
            return null;
        }
        const targetHeroId = toNumber(battleSlot.heroId, 0);
        const targetUid = normalizeUidString(
            battleSlot.attachmentUid ||
                battleSlot.uId ||
                battleSlot.uid ||
                battleSlot.heroUid ||
                battleSlot.containerId,
        );
        const candidates = [];
        if (role.heroes && typeof role.heroes.values === "function") {
            for (const hero of role.heroes.values()) {
                if (toNumber(hero && hero.heroId, 0) === targetHeroId) {
                    candidates.push(hero);
                }
            }
        }
        if (targetUid) {
            const uidMatched = candidates.find((hero) => getHeroUid(hero) === targetUid);
            if (uidMatched) {
                return uidMatched;
            }
        }
        const slotMatched = candidates.find(
            (hero) =>
                normalizeLineupSlotIndex(hero && hero.battleTeamSlot) ===
                normalizeLineupSlotIndex(fallbackSlotIndex),
        );
        if (slotMatched) {
            return slotMatched;
        }
        return candidates.length === 1
            ? candidates[0]
            : role.getHeroById(targetHeroId);
    }
    function getHeroCarrierMeta(hero) {
        return {
            order: getHeroOrder(hero),
            color: toNumber(hero && hero.color, 0),
            star: toNumber(hero && hero.star, 0),
            level: getHeroLevel(hero),
            speed: getHeroSpeed(hero),
            power: getHeroPower(hero),
            artifactId: toNumber(hero && hero.artifactId, 0),
            pearlId: toNumber(hero && hero.pearlId, 0),
            attachmentUid: getHeroUid(hero),
        };
    }
    function findLiveHeroBySlotConfig(role, slotConfig) {
        if (!role || !slotConfig) {
            return null;
        }
        const targetHeroId = toNumber(slotConfig.heroId, 0);
        const targetUid = normalizeUidString(
            slotConfig.attachmentUid ||
                slotConfig.containerId ||
                slotConfig.carrierMeta && slotConfig.carrierMeta.attachmentUid,
        );
        const candidates = [];
        if (role.heroes && typeof role.heroes.values === "function") {
            for (const hero of role.heroes.values()) {
                if (toNumber(hero && hero.heroId, 0) === targetHeroId) {
                    candidates.push(hero);
                }
            }
        }
        if (targetUid) {
            const uidMatched = candidates.find((hero) => getHeroUid(hero) === targetUid);
            if (uidMatched) {
                return uidMatched;
            }
        }
        if (slotConfig.equipment) {
            let best = null;
            const targetFingerprint = buildEquipmentFingerprint(slotConfig.equipment);
            candidates.forEach((hero) => {
                const confidence = scoreEquipmentFingerprint(
                    targetFingerprint,
                    buildEquipmentFingerprint(getHeroEquipmentState(hero)),
                );
                if (!best || confidence > best.confidence) {
                    best = { hero, confidence };
                }
            });
            if (best && best.confidence >= 0.55) {
                return best.hero;
            }
        }
        return candidates.length === 1
            ? candidates[0]
            : role.getHeroById(targetHeroId);
    }
    function resolveLiveHeroForTargetSlot(role, targetSlotConfig) {
        if (!role || !targetSlotConfig) {
            return null;
        }
        const resolvedHero = findLiveHeroBySlotConfig(role, targetSlotConfig);
        if (resolvedHero) {
            return resolvedHero;
        }
        const targetHeroId = toNumber(targetSlotConfig.heroId, 0);
        return targetHeroId > 0 ? role.getHeroById(targetHeroId) : null;
    }
    function getHeroLevel(hero) {
        return hero ? toNumber(hero.level, 1) : 1;
    }
    function getHeroOrder(hero) {
        return hero ? toNumber(hero.order, 0) : 0;
    }
    function getEquipmentData(hero, part) {
        if (!hero) {
            return null;
        }
        const readFromCollection = (collection) => {
            if (!collection) {
                return null;
            }
            if (typeof collection.get === "function") {
                const isZeroBased =
                    collection.has(0) || collection.has("0");
                if (isZeroBased) {
                    return (
                        collection.get(part - 1) ||
                        collection.get(String(part - 1)) ||
                        null
                    );
                }
                return (
                    collection.get(part) ||
                    collection.get(String(part)) ||
                    null
                );
            }
            if (Array.isArray(collection)) {
                return collection[part - 1] || null;
            }
            if (typeof collection === "object") {
                const isZeroBased =
                    Object.prototype.hasOwnProperty.call(collection, 0) ||
                    Object.prototype.hasOwnProperty.call(collection, "0");
                if (isZeroBased) {
                    return collection[part - 1] || collection[String(part - 1)] || null;
                }
                return collection[part] || collection[String(part)] || null;
            }
            return null;
        };
        return (
            readFromCollection(hero.equipment) ||
            readFromCollection(hero.equipments) ||
            readFromCollection(hero.equips) ||
            null
        );
    }
    function cloneSerializable(value) {
        if (value === undefined || value === null) {
            return value;
        }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
    }
    function mapToPlainObject(mapLike) {
        const result = {};
        if (!mapLike) {
            return result;
        }
        if (typeof mapLike.forEach === "function") {
            mapLike.forEach((value, key) => {
                result[key] = cloneSerializable(value);
            });
            return result;
        }
        Object.keys(mapLike).forEach((key) => {
            result[key] = cloneSerializable(mapLike[key]);
        });
        return result;
    }
    function normalizeCollectionToArray(collection) {
        const result = [];
        if (!collection) {
            return result;
        }
        if (typeof collection.forEach === "function") {
            collection.forEach((value, key) => {
                result.push([key, value]);
            });
            return result;
        }
        Object.keys(collection).forEach((key) => {
            result.push([key, collection[key]]);
        });
        return result;
    }
    function getCollectionValue(collection, key) {
        if (!collection) {
            return undefined;
        }
        if (typeof collection.get === "function") {
            return collection.get(key) || collection.get(String(key));
        }
        return collection[key] || collection[String(key)];
    }
    function cloneQuenchMap(quenches) {
        const result = {};
        normalizeCollectionToArray(quenches).forEach(([slotKey, quench]) => {
            if (!quench) {
                return;
            }
            result[slotKey] = {
                attrId: toNumber(quench.attrId, 0),
                colorId: toNumber(quench.colorId, 0),
                attrNum: toNumber(quench.attrNum, 0),
                isLocked: !!(quench.isLocked || quench.locked),
            };
        });
        return result;
    }
    function getEquipmentPartIndex(equipmentData, fallbackPart) {
        const rawPart = toNumber(
            equipmentData && equipmentData.part,
            fallbackPart - 1,
        );
        return rawPart >= 1 && rawPart <= 4 ? rawPart - 1 : rawPart;
    }
    function cloneEquipmentPartState(equipmentData, part) {
        if (!equipmentData) {
            return {
                part: part - 1,
                curQuenchId: 0,
            };
        }
        return {
            ...cloneSerializable(equipmentData),
            part: getEquipmentPartIndex(equipmentData, part),
            level: toNumber(equipmentData.level, 0),
            color: toNumber(equipmentData.color, 0),
            forge: toNumber(equipmentData.forge, 0),
            forgeExp: toNumber(equipmentData.forgeExp, 0),
            attack: toNumber(equipmentData.attack, 0),
            defense: toNumber(equipmentData.defense, 0),
            hp: toNumber(equipmentData.hp, 0),
            curQuenchId: toNumber(equipmentData.curQuenchId, 0),
            reverseQuenchId: getEquipmentPartReverseQuenchId(equipmentData),
            quenchTimes: toNumber(equipmentData.quenchTimes, 0),
            quenchTimes2: toNumber(equipmentData.quenchTimes2, 0),
            quenchAttackExt: toNumber(equipmentData.quenchAttackExt, 0),
            quenchDefenseExt: toNumber(equipmentData.quenchDefenseExt, 0),
            quenchHpExt: toNumber(equipmentData.quenchHpExt, 0),
            enchantUId: toNumber(equipmentData.enchantUId, 0),
            enchantUId2: toNumber(equipmentData.enchantUId2, 0),
            curEnchantUId: getEquipmentPartCurEnchantUId(equipmentData),
            reverseEnchantUId: getEquipmentPartReverseEnchantUId(equipmentData),
            quenches: cloneQuenchMap(equipmentData.quenches),
            quenches2: cloneQuenchMap(equipmentData.quenches2),
        };
    }
    function getEquipmentPart(equipment, part) {
        if (!equipment) {
            return null;
        }
        if (typeof equipment.get === "function") {
            return equipment.get(part) || equipment.get(String(part)) || null;
        }
        return equipment[part] || equipment[String(part)] || null;
    }
    function getHeroEquipmentState(hero) {
        const equipmentState = {};
        for (let part = 1; part <= 4; part++) {
            const equipmentData = getEquipmentData(hero, part);
            equipmentState[part] = cloneEquipmentPartState(equipmentData, part);
        }
        return equipmentState;
    }
    function scoreCloseNumber(left, right, tolerance, points) {
        const leftNumber = toNumber(left, 0);
        const rightNumber = toNumber(right, 0);
        if (leftNumber === rightNumber) {
            return points;
        }
        const diff = Math.abs(leftNumber - rightNumber);
        if (tolerance <= 0 || diff > tolerance) {
            return 0;
        }
        return points * (1 - diff / tolerance);
    }
    function sumNumberArray(values) {
        return (values || []).reduce(
            (total, value) => total + toNumber(value, 0),
            0,
        );
    }
    function scoreVectorFingerprint(targetVector, liveVector, tolerance, points) {
        const targetValues = Array.isArray(targetVector) ? targetVector : [];
        const liveValues = Array.isArray(liveVector) ? liveVector : [];
        const length = Math.max(targetValues.length, liveValues.length);
        if (!length) {
            return points;
        }
        let slotScore = 0;
        for (let index = 0; index < length; index++) {
            slotScore += scoreCloseNumber(
                targetValues[index],
                liveValues[index],
                tolerance,
                1,
            );
        }
        const averageScore = slotScore / length;
        const totalScore = scoreCloseNumber(
            sumNumberArray(targetValues),
            sumNumberArray(liveValues),
            tolerance * Math.max(2, length) * 1.5,
            1,
        );
        return points * (averageScore * 0.7 + totalScore * 0.3);
    }
    function pushQuenchFingerprintTokens(tokenBucket, part, groupName, quenches) {
        const quenchMap = quenches || {};
        Object.keys(quenchMap).forEach((slotKey) => {
            const quench = quenchMap[slotKey] || {};
            const attrId = toNumber(quench.attrId, 0);
            const colorId = toNumber(quench.colorId, 0);
            if (!attrId && !colorId) {
                return;
            }
            const globalPrefix = groupName + ":g";
            const partPrefix = groupName + ":p" + part;
            if (attrId) {
                tokenBucket.attr.push(globalPrefix + ":a" + attrId);
                tokenBucket.attr.push(partPrefix + ":a" + attrId);
            }
            if (colorId) {
                tokenBucket.color.push(globalPrefix + ":c" + colorId);
                tokenBucket.color.push(partPrefix + ":c" + colorId);
            }
            const pairToken = (attrId || 0) + "#" + (colorId || 0);
            tokenBucket.pair.push(globalPrefix + ":q" + pairToken);
            tokenBucket.pair.push(partPrefix + ":q" + pairToken);
        });
    }
    function buildTokenCounter(tokens) {
        const counter = new Map();
        (tokens || []).forEach((token) => {
            counter.set(token, (counter.get(token) || 0) + 1);
        });
        return counter;
    }
    function scoreTokenOverlap(targetTokens, liveTokens, points) {
        const targetCounter = buildTokenCounter(targetTokens);
        const liveCounter = buildTokenCounter(liveTokens);
        let targetCount = 0;
        let liveCount = 0;
        let overlapCount = 0;
        targetCounter.forEach((count) => {
            targetCount += count;
        });
        liveCounter.forEach((count, token) => {
            liveCount += count;
            if (!targetCounter.has(token)) {
                return;
            }
            overlapCount += Math.min(targetCounter.get(token), count);
        });
        const totalCount = targetCount + liveCount;
        if (!totalCount) {
            return points;
        }
        return points * ((2 * overlapCount) / totalCount);
    }
    function buildSinglePartEquipmentState(equipmentPart, part) {
        const equipment = {};
        equipment[part] = equipmentPart || {};
        return equipment;
    }
    function buildEquipmentFingerprint(equipment) {
        const fingerprint = {
            levelVector: [],
            quenchTimesVector: [],
            quenchTimes2Vector: [],
            attackExtVector: [],
            defenseExtVector: [],
            hpExtVector: [],
            primaryQuenchTokens: {
                attr: [],
                color: [],
                pair: [],
            },
            secondaryQuenchTokens: {
                attr: [],
                color: [],
                pair: [],
            },
        };
        for (let part = 1; part <= 4; part++) {
            const equipmentPart = getEquipmentPart(equipment, part) || {};
            fingerprint.levelVector.push(toNumber(equipmentPart.level, 0));
            fingerprint.quenchTimesVector.push(
                toNumber(equipmentPart.quenchTimes, 0),
            );
            fingerprint.quenchTimes2Vector.push(
                toNumber(equipmentPart.quenchTimes2, 0),
            );
            fingerprint.attackExtVector.push(
                toNumber(equipmentPart.quenchAttackExt, 0),
            );
            fingerprint.defenseExtVector.push(
                toNumber(equipmentPart.quenchDefenseExt, 0),
            );
            fingerprint.hpExtVector.push(
                toNumber(equipmentPart.quenchHpExt, 0),
            );
            pushQuenchFingerprintTokens(
                fingerprint.primaryQuenchTokens,
                part,
                "main",
                equipmentPart.quenches,
            );
            pushQuenchFingerprintTokens(
                fingerprint.secondaryQuenchTokens,
                part,
                "sub",
                equipmentPart.quenches2,
            );
        }
        return fingerprint;
    }
    function ensureEquipmentFingerprint(source) {
        if (
            source &&
            Array.isArray(source.levelVector) &&
            source.primaryQuenchTokens
        ) {
            return source;
        }
        return buildEquipmentFingerprint(source);
    }
    function scoreEquipmentFingerprint(targetEquipment, liveEquipment) {
        const targetFingerprint = ensureEquipmentFingerprint(targetEquipment);
        const liveFingerprint = ensureEquipmentFingerprint(liveEquipment);
        let score = 0;
        let maxScore = 0;
        maxScore += 16;
        score += scoreVectorFingerprint(
            targetFingerprint.levelVector,
            liveFingerprint.levelVector,
            15,
            16,
        );
        maxScore += 18;
        score += scoreVectorFingerprint(
            targetFingerprint.quenchTimesVector,
            liveFingerprint.quenchTimesVector,
            60,
            18,
        );
        maxScore += 6;
        score += scoreVectorFingerprint(
            targetFingerprint.quenchTimes2Vector,
            liveFingerprint.quenchTimes2Vector,
            40,
            6,
        );
        maxScore += 12;
        score += scoreVectorFingerprint(
            targetFingerprint.attackExtVector,
            liveFingerprint.attackExtVector,
            500,
            12,
        );
        maxScore += 12;
        score += scoreVectorFingerprint(
            targetFingerprint.defenseExtVector,
            liveFingerprint.defenseExtVector,
            500,
            12,
        );
        maxScore += 12;
        score += scoreVectorFingerprint(
            targetFingerprint.hpExtVector,
            liveFingerprint.hpExtVector,
            5000,
            12,
        );
        maxScore += 16;
        score += scoreTokenOverlap(
            targetFingerprint.primaryQuenchTokens.pair,
            liveFingerprint.primaryQuenchTokens.pair,
            16,
        );
        maxScore += 10;
        score += scoreTokenOverlap(
            targetFingerprint.primaryQuenchTokens.attr,
            liveFingerprint.primaryQuenchTokens.attr,
            10,
        );
        maxScore += 8;
        score += scoreTokenOverlap(
            targetFingerprint.primaryQuenchTokens.color,
            liveFingerprint.primaryQuenchTokens.color,
            8,
        );
        if (
            targetFingerprint.secondaryQuenchTokens.pair.length ||
            liveFingerprint.secondaryQuenchTokens.pair.length
        ) {
            maxScore += 4;
            score += scoreTokenOverlap(
                targetFingerprint.secondaryQuenchTokens.pair,
                liveFingerprint.secondaryQuenchTokens.pair,
                4,
            );
        }
        if (
            targetFingerprint.secondaryQuenchTokens.attr.length ||
            liveFingerprint.secondaryQuenchTokens.attr.length
        ) {
            maxScore += 3;
            score += scoreTokenOverlap(
                targetFingerprint.secondaryQuenchTokens.attr,
                liveFingerprint.secondaryQuenchTokens.attr,
                3,
            );
        }
        if (
            targetFingerprint.secondaryQuenchTokens.color.length ||
            liveFingerprint.secondaryQuenchTokens.color.length
        ) {
            maxScore += 2;
            score += scoreTokenOverlap(
                targetFingerprint.secondaryQuenchTokens.color,
                liveFingerprint.secondaryQuenchTokens.color,
                2,
            );
        }
        return maxScore ? score / maxScore : 0;
    }
    function scoreHeroEquipmentMatch(targetSlotConfig, hero) {
        if (!targetSlotConfig || !targetSlotConfig.equipment || !hero) {
            return 0;
        }
        return scoreEquipmentFingerprint(
            targetSlotConfig.equipment,
            getHeroEquipmentState(hero),
        );
    }
    function assertHeroEquipmentMatchesTarget(targetSlotConfig, hero, stageName, minimumConfidence = 0.55) {
        const confidence = scoreHeroEquipmentMatch(targetSlotConfig, hero);
        if (confidence >= minimumConfidence) {
            return confidence;
        }
        throw new Error(
            "武将 " +
                toNumber(targetSlotConfig && targetSlotConfig.heroId, 0) +
                " 当前装备指纹与保存数据不匹配(" +
                stageName +
                ": " +
                roundFingerprintConfidence(confidence) +
                " < " +
                roundFingerprintConfidence(minimumConfidence) +
                ", uid=" +
                getHeroUid(hero) +
                ")",
        );
    }
    function buildCurrentLineupSnapshotFromRole() {
        try {
            const ServerData = window.__require("ServerData");
            const role = ServerData && ServerData.ROLE;
            if (!role || !role.battleTeam) {
                return null;
            }
            const team = {};
            listCollectionEntries(role && role.battleTeam).forEach(([slotIndex, battleSlot]) => {
                slotIndex = toNumber(slotIndex, -1);
                if (slotIndex < 0 || !battleSlot) {
                    return;
                }
                const visualSlotIndex = getBattleSlotPositionIndex(
                    battleSlot,
                    slotIndex,
                );
                const currentHero = findLiveHeroByBattleSlot(
                    role,
                    battleSlot,
                    slotIndex,
                );
                if (!currentHero) {
                    return;
                }
                const artifactState = getHeroArtifactStateFromHero(
                    role,
                    currentHero,
                );
                const trumpState = getHeroTrumpState(currentHero);
                team[slotIndex] = {
                    heroId: toNumber(battleSlot && battleSlot.heroId, 0),
                    slotIndex,
                    visualSlotIndex,
                    positionIndex: visualSlotIndex,
                    carrierMeta: getHeroCarrierMeta(currentHero),
                    level: getHeroLevel(currentHero),
                    order: getHeroOrder(currentHero),
                    color: toNumber(currentHero && currentHero.color, 0),
                    star: toNumber(currentHero && currentHero.star, 0),
                    artifactId: artifactState.artifactId,
                    pearlId: artifactState.pearlId,
                    pearlSkillId: artifactState.pearlSkillId,
                    pearl: artifactState.pearl,
                    curTrump: trumpState.trumpId,
                    trumpId: trumpState.trumpId,
                    trumpId2: trumpState.trumpId2,
                    transTrumpId: trumpState.transTrumpId,
                    trump: trumpState,
                    equipment: getHeroEquipmentState(currentHero),
                    attachmentUid: getHeroUid(currentHero),
                    containerId: getHeroUid(currentHero),
                    appendSkill: getHeroAppendSkillState(
                        currentHero,
                        artifactState.pearlSkillId,
                    ),
                    useSkin: toNumber(currentHero && currentHero.useSkin, -1),
                };
            });
            return {
                teamId: getCurrentPresetTeamId(role),
                team,
                weaponId: toNumber(role.lordWeaponId, 0),
                pet: getCurrentPetState(),
            };
        } catch (error) {
            console.log("[当前阵容] 读取当前阵容失败:", error);
            return null;
        }
    }
    function getLineupMatchArtifactId(slotConfig) {
        return toNumber(
            slotConfig && slotConfig.artifactId,
            toNumber(slotConfig && slotConfig.carrierMeta && slotConfig.carrierMeta.artifactId, 0),
        );
    }
    function scoreSavedConfigAgainstCurrentLineup(savedConfig, currentSnapshot) {
        if (!savedConfig || !currentSnapshot || !currentSnapshot.team) {
            return 0;
        }
        const activeConfig = normalizeSavedConfig(savedConfig);
        const savedTeamId = toNumber(activeConfig && activeConfig.teamId, 0);
        const currentTeamId = toNumber(currentSnapshot.teamId, 0);
        if (savedTeamId && currentTeamId && savedTeamId !== currentTeamId) {
            return 0;
        }
        const teamSlots = getTeamSlots(activeConfig && activeConfig.team);
        if (!teamSlots.length) {
            return 0;
        }
        const currentSlots = getTeamSlots(currentSnapshot.team);
        if (teamSlots.length !== currentSlots.length) {
            return 0;
        }
        let fuzzyScoreTotal = 0;
        for (const { slotIndex, slotConfig } of teamSlots) {
            const currentSlot =
                currentSnapshot.team[slotIndex] ||
                currentSnapshot.team[String(slotIndex)] ||
                null;
            if (!currentSlot) {
                return 0;
            }
            if (
                toNumber(slotConfig.heroId, 0) ===
                toNumber(currentSlot.heroId, 0)
            ) {
                // 当前阵容识别只把位置、武将、鱼灵当硬条件。
            } else {
                return 0;
            }
            if (
                getLineupVisualSlotIndex(slotConfig, slotIndex) !==
                getLineupVisualSlotIndex(currentSlot, slotIndex)
            ) {
                return 0;
            }
            if (
                getLineupMatchArtifactId(slotConfig) !==
                getLineupMatchArtifactId(currentSlot)
            ) {
                return 0;
            }
            if (toNumber(slotConfig.pearlId, 0) > 0) {
                fuzzyScoreTotal +=
                    toNumber(slotConfig.pearlId, 0) ===
                    toNumber(currentSlot.pearlId, 0)
                        ? 0.2
                        : 0;
            }
            if (toNumber(slotConfig.pearlSkillId, 0) > 0) {
                fuzzyScoreTotal +=
                    toNumber(slotConfig.pearlSkillId, 0) ===
                    toNumber(currentSlot.pearlSkillId, 0)
                        ? 0.1
                        : 0;
            }
            fuzzyScoreTotal += scoreEquipmentFingerprint(
                slotConfig.equipment,
                currentSlot.equipment,
            ) * 0.3;
        }
        if (
            toNumber(activeConfig.weaponId, 0) &&
            toNumber(activeConfig.weaponId, 0) ===
                toNumber(currentSnapshot.weaponId, 0)
        ) {
            fuzzyScoreTotal += 0.2;
        }
        if (activeConfig.pet && toNumber(activeConfig.pet.petId, 0) > 0) {
            const petScore = scorePetSnapshot(activeConfig.pet, currentSnapshot.pet);
            fuzzyScoreTotal += petScore * 0.2;
        }
        return 1 + fuzzyScoreTotal / Math.max(teamSlots.length, 1);
    }
    function findCurrentSavedConfigIndex(savedConfigs) {
        const currentSnapshot = buildCurrentLineupSnapshotFromRole();
        if (!currentSnapshot || !Array.isArray(savedConfigs)) {
            return -1;
        }
        let bestIndex = -1;
        let bestScore = 0;
        savedConfigs.forEach((savedConfig, index) => {
            const score = scoreSavedConfigAgainstCurrentLineup(
                savedConfig,
                currentSnapshot,
            );
            if (score > bestScore) {
                bestScore = score;
                bestIndex = index;
            }
        });
        return bestScore > 0 ? bestIndex : -1;
    }
    function getCurrentFirstSavedConfigItems(savedConfigs, currentIndex) {
        return (savedConfigs || [])
            .map((savedConfig, configIndex) => ({
                savedConfig,
                configIndex,
                isCurrentLineup: configIndex === currentIndex,
            }))
            .sort((left, right) => {
                if (left.isCurrentLineup !== right.isCurrentLineup) {
                    return left.isCurrentLineup ? -1 : 1;
                }
                return left.configIndex - right.configIndex;
            });
    }
    function getEquipmentPartFallbackCurEnchantUId(equipmentPart) {
        return toNumber(equipmentPart && equipmentPart.curQuenchId, 0) === 0
            ? toNumber(equipmentPart && equipmentPart.enchantUId, 0)
            : toNumber(equipmentPart && equipmentPart.enchantUId2, 0);
    }
    function getEquipmentPartFallbackReverseEnchantUId(equipmentPart) {
        return toNumber(equipmentPart && equipmentPart.curQuenchId, 0) === 0
            ? toNumber(equipmentPart && equipmentPart.enchantUId2, 0)
            : toNumber(equipmentPart && equipmentPart.enchantUId, 0);
    }
    function getEquipmentPartCurEnchantUId(equipmentPart) {
        return (
            getEquipmentPartFallbackCurEnchantUId(equipmentPart) ||
            toNumber(equipmentPart && equipmentPart.curEnchantUId, 0)
        );
    }
    function getEquipmentPartReverseEnchantUId(equipmentPart) {
        return (
            getEquipmentPartFallbackReverseEnchantUId(equipmentPart) ||
            toNumber(equipmentPart && equipmentPart.reverseEnchantUId, 0)
        );
    }
    function getEquipmentPartMatchedEnchantSide(equipmentPart, targetUid) {
        const normalizedTargetUid = toNumber(targetUid, 0);
        if (!normalizedTargetUid) {
            return "";
        }
        if (getEquipmentPartCurEnchantUId(equipmentPart) === normalizedTargetUid) {
            return "current";
        }
        if (getEquipmentPartReverseEnchantUId(equipmentPart) === normalizedTargetUid) {
            return "reverse";
        }
        return "";
    }
    function getEquipmentPartPreferredEnchantTargetUid(
        equipmentPart,
        preferredSide,
        fallbackUid = 0,
    ) {
        const currentTargetUid = getEquipmentPartCurEnchantUId(equipmentPart);
        const reverseTargetUid = getEquipmentPartReverseEnchantUId(equipmentPart);
        if (preferredSide === "reverse") {
            return reverseTargetUid || currentTargetUid || toNumber(fallbackUid, 0);
        }
        if (preferredSide === "current") {
            return currentTargetUid || reverseTargetUid || toNumber(fallbackUid, 0);
        }
        return currentTargetUid || reverseTargetUid || toNumber(fallbackUid, 0);
    }
    function getEquipmentPartEnchantSideByUid(
        equipmentPart,
        enchantUid,
        fallbackSide = "",
    ) {
        return (
            getEquipmentPartMatchedEnchantSide(equipmentPart, enchantUid) ||
            fallbackSide ||
            ""
        );
    }
    function getEquipmentPartEnchantUIds(equipmentPart) {
        const seen = new Set();
        return [
            toNumber(equipmentPart && equipmentPart.enchantUId, 0),
            toNumber(equipmentPart && equipmentPart.enchantUId2, 0),
            getEquipmentPartCurEnchantUId(equipmentPart),
            getEquipmentPartReverseEnchantUId(equipmentPart),
        ].filter((uid) => {
            if (!uid || seen.has(uid)) {
                return false;
            }
            seen.add(uid);
            return true;
        });
    }
    async function cancelEquipmentPartEnchantRelations(role, hero, equipmentPart, part) {
        const sourceUids = getEquipmentPartEnchantUIds(equipmentPart);
        if (!sourceUids.length) {
            return;
        }
        const cancelledSourceUids = new Set();
        const fallbackHeroId = toNumber(hero && hero.heroId, 0);
        const cancelSource = async (source) => {
            const sourceUid = toNumber(source && source.sourceUid, 0);
            if (!sourceUid || cancelledSourceUids.has(sourceUid)) {
                return;
            }
            const normalizedSource = {
                heroId: toNumber(source && source.heroId, fallbackHeroId),
                part: toNumber(source && source.part, part),
                sourceUid,
            };
            const didCancel = await cancelEnchantBySource(normalizedSource);
            if (!didCancel) {
                throw new Error(
                    "cancel enchant failed before quench flip(sourceUid=" +
                        sourceUid +
                        ")",
                );
            }
            cancelledSourceUids.add(sourceUid);
        };
        for (const uid of sourceUids) {
            const mappedTargetUid = toNumber(
                getCollectionValue(role && role.enchantMap, uid),
                0,
            );
            if (mappedTargetUid > 0) {
                await cancelSource({ heroId: fallbackHeroId, part, sourceUid: uid });
            }
            const occupiedSource = findCurrentEnchantSourceByTargetUid(uid);
            if (occupiedSource) {
                await cancelSource(occupiedSource);
            }
        }
        if (cancelledSourceUids.size > 0) {
            refreshEnchantUiState();
            await waitForEquipmentRuntimeRefresh();
        }
    }
    function hasEquipmentPartField(equipmentPart, fieldName) {
        return (
            equipmentPart &&
            equipmentPart[fieldName] !== undefined &&
            equipmentPart[fieldName] !== null
        );
    }
    function getEquipmentPartCurQuenchId(equipmentPart) {
        return toNumber(equipmentPart && equipmentPart.curQuenchId, 0);
    }
    function getEquipmentPartReverseQuenchId(equipmentPart) {
        const curQuenchId = getEquipmentPartCurQuenchId(equipmentPart);
        return curQuenchId === 0 ? 1 : 0;
    }
    async function waitForEquipmentRuntimeRefresh() {
        await new Promise((resolve) => setTimeout(resolve, 120));
        try {
            const RoleService = window.__require("data-index").RoleService;
            if (RoleService && typeof RoleService.getRoleInfo === "function") {
                await RoleService.getRoleInfo({});
            }
        } catch (error) {
            console.log("[装备] 刷新角色信息失败:", error);
        }
    }
    async function waitForPearlRuntimeRefresh() {
        await waitForEquipmentRuntimeRefresh();
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
    async function quenchFlipWithRetry(EquipmentModule, heroId, part) {
        try {
            const firstResult = await EquipmentModule.quenchFilp(heroId, part);
            if (firstResult) {
                return true;
            }
        } catch (error) {
            console.log("[装备] 首次洗练翻面调用失败，准备刷新后重试:", error);
        }
        await waitForEquipmentRuntimeRefresh();
        try {
            return !!(await EquipmentModule.quenchFilp(heroId, part));
        } catch (error) {
            console.log("[装备] 二次洗练翻面调用失败:", error);
            return false;
        }
    }
    function getEnchantSourceStateFromPart(hero, equipmentPart, part, sideName) {
        const isReverse = sideName === "reverse";
        const sourceUid = isReverse
            ? getEquipmentPartReverseEnchantUId(equipmentPart)
            : getEquipmentPartCurEnchantUId(equipmentPart);
        const quenchId = isReverse
            ? getEquipmentPartReverseQuenchId(equipmentPart)
            : getEquipmentPartCurQuenchId(equipmentPart);
        const quenches = isReverse
            ? equipmentPart && equipmentPart.quenches2
            : equipmentPart && equipmentPart.quenches;
        return {
            heroId: toNumber(hero && hero.heroId, 0),
            equipIndex: part - 1,
            part,
            quenchId,
            sourceUid,
            sourceSide: sideName,
            sourceEquipment: cloneEquipmentPartState(equipmentPart, part),
            sourceFingerprint: buildEquipmentFingerprint(
                buildSinglePartEquipmentState(equipmentPart, part),
            ),
            redQuenchCount: normalizeCollectionToArray(quenches).reduce(
                (count, [, quench]) =>
                    count + (toNumber(quench && quench.colorId, 0) === 6 ? 1 : 0),
                0,
            ),
        };
    }
    function buildLiveEnchantSources(role) {
        const sources = [];
        if (!role || !role.heroes || typeof role.heroes.forEach !== "function") {
            return sources;
        }
        role.heroes.forEach((hero) => {
            for (let part = 1; part <= 4; part++) {
                const equipmentPart = getEquipmentData(hero, part);
                if (!equipmentPart) {
                    continue;
                }
                const currentSource = getEnchantSourceStateFromPart(
                    hero,
                    equipmentPart,
                    part,
                    "current",
                );
                if (currentSource.sourceUid > 0) {
                    sources.push(currentSource);
                }
                const reverseSource = getEnchantSourceStateFromPart(
                    hero,
                    equipmentPart,
                    part,
                    "reverse",
                );
                if (reverseSource.sourceUid > 0) {
                    sources.push(reverseSource);
                }
            }
        });
        return sources;
    }
    function buildEquipmentEnchantSnapshot(role, teamSnapshot) {
        const enchantMap = mapToPlainObject(role && role.enchantMap);
        const sourceByUid = new Map();
        buildLiveEnchantSources(role).forEach((source) => {
            sourceByUid.set(source.sourceUid, source);
        });
        const links = [];
        Object.keys(enchantMap).forEach((sourceUidKey) => {
            const sourceUid = toNumber(sourceUidKey, 0);
            const targetUid = toNumber(enchantMap[sourceUidKey], 0);
            const sourceState = sourceByUid.get(sourceUid);
            if (!sourceUid || !targetUid || !sourceState) {
                return;
            }
            let targetSlotIndex = -1;
            let targetHeroId = 0;
            let targetPart = sourceState.part;
            let targetEquipment = null;
            let targetSide = "";
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const targetSlotConfig = teamSnapshot[slotIndex];
                if (!targetSlotConfig || !targetSlotConfig.equipment) {
                    continue;
                }
                for (let part = 1; part <= 4; part++) {
                    const equipmentPart = getEquipmentPart(
                        targetSlotConfig.equipment,
                        part,
                    );
                    const matchedTargetSide = getEquipmentPartMatchedEnchantSide(
                        equipmentPart,
                        targetUid,
                    );
                    if (!matchedTargetSide) {
                        continue;
                    }
                    targetSlotIndex = slotIndex;
                    targetHeroId = toNumber(targetSlotConfig.heroId, 0);
                    targetPart = part;
                    targetEquipment = equipmentPart;
                    targetSide = matchedTargetSide;
                    break;
                }
                if (targetSlotIndex >= 0) {
                    break;
                }
            }
            links.push({
                sourceUid,
                targetUid,
                source: sourceState,
                targetSlotIndex,
                targetHeroId,
                targetPart,
                targetSide,
                targetEquipment: cloneEquipmentPartState(
                    targetEquipment,
                    targetPart,
                ),
                targetTeamFingerprint:
                    targetSlotIndex >= 0 && teamSnapshot[targetSlotIndex]
                        ? buildEquipmentFingerprint(
                              teamSnapshot[targetSlotIndex].equipment,
                          )
                        : null,
            });
        });
        return {
            enchantMap,
            links,
        };
    }
    function buildEquipmentEnchantLinksFromMap(equipmentEnchantConfig, targetTeamConfig) {
        const enchantMap = mapToPlainObject(
            equipmentEnchantConfig && equipmentEnchantConfig.enchantMap,
        );
        const sourceByUid = new Map();
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const targetSlotConfig = targetTeamConfig[slotIndex];
            if (!targetSlotConfig || !targetSlotConfig.equipment) {
                continue;
            }
            const sourceHero = { heroId: toNumber(targetSlotConfig.heroId, 0) };
            for (let part = 1; part <= 4; part++) {
                const equipmentPart = getEquipmentPart(
                    targetSlotConfig.equipment,
                    part,
                );
                if (!equipmentPart) {
                    continue;
                }
                ["current", "reverse"].forEach((sideName) => {
                    const sourceState = getEnchantSourceStateFromPart(
                        sourceHero,
                        equipmentPart,
                        part,
                        sideName,
                    );
                    if (sourceState.sourceUid > 0) {
                        sourceByUid.set(sourceState.sourceUid, sourceState);
                    }
                });
            }
        }
        const links = [];
        Object.keys(enchantMap).forEach((sourceUidKey) => {
            const sourceUid = toNumber(sourceUidKey, 0);
            const targetUid = toNumber(enchantMap[sourceUidKey], 0);
            const sourceState = sourceByUid.get(sourceUid);
            if (!sourceUid || !targetUid || !sourceState) {
                return;
            }
            let targetSlotIndex = -1;
            let targetHeroId = 0;
            let targetPart = sourceState.part;
            let targetEquipment = null;
            let targetSide = "";
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const targetSlotConfig = targetTeamConfig[slotIndex];
                if (!targetSlotConfig || !targetSlotConfig.equipment) {
                    continue;
                }
                for (let part = 1; part <= 4; part++) {
                    const equipmentPart = getEquipmentPart(
                        targetSlotConfig.equipment,
                        part,
                    );
                    const matchedTargetSide = getEquipmentPartMatchedEnchantSide(
                        equipmentPart,
                        targetUid,
                    );
                    if (!matchedTargetSide) {
                        continue;
                    }
                    targetSlotIndex = slotIndex;
                    targetHeroId = toNumber(targetSlotConfig.heroId, 0);
                    targetPart = part;
                    targetEquipment = equipmentPart;
                    targetSide = matchedTargetSide;
                    break;
                }
                if (targetSlotIndex >= 0) {
                    break;
                }
            }
            links.push({
                sourceUid,
                targetUid,
                source: sourceState,
                targetSlotIndex,
                targetHeroId,
                targetPart,
                targetSide,
                targetEquipment: cloneEquipmentPartState(
                    targetEquipment,
                    targetPart,
                ),
                targetTeamFingerprint:
                    targetSlotIndex >= 0 && targetTeamConfig[targetSlotIndex]
                        ? buildEquipmentFingerprint(
                              targetTeamConfig[targetSlotIndex].equipment,
                          )
                        : null,
            });
        });
        return links;
    }
    function normalizeEquipmentEnchantSourceState(source, fallbackSourceUid = 0) {
        const normalized = cloneSerializable(source) || {};
        const sourceUid =
            toNumber(fallbackSourceUid, 0) ||
            toNumber(normalized.sourceUid, 0);
        const part = toNumber(
            normalized.part,
            toNumber(normalized.equipIndex, 0) + 1,
        );
        normalized.sourceUid = sourceUid;
        normalized.part = part;
        normalized.equipIndex = toNumber(
            normalized.equipIndex,
            Math.max(part - 1, 0),
        );
        if (normalized.sourceEquipment) {
            normalized.sourceEquipment = cloneEquipmentPartState(
                normalized.sourceEquipment,
                part || 1,
            );
            normalized.sourceSide =
                getEquipmentPartEnchantSideByUid(
                    normalized.sourceEquipment,
                    sourceUid,
                    normalized.sourceSide || "current",
                ) || "current";
            normalized.quenchId =
                normalized.sourceSide === "reverse"
                    ? getEquipmentPartReverseQuenchId(normalized.sourceEquipment)
                    : getEquipmentPartCurQuenchId(normalized.sourceEquipment);
        } else {
            normalized.sourceSide = normalized.sourceSide || "current";
            normalized.quenchId = toNumber(normalized.quenchId, 0);
        }
        return normalized;
    }
    function normalizeEquipmentEnchantLink(link) {
        const normalized = cloneSerializable(link) || {};
        const sourceUid =
            toNumber(normalized.sourceUid, 0) ||
            toNumber(normalized.source && normalized.source.sourceUid, 0);
        const targetUid = toNumber(normalized.targetUid, 0);
        normalized.sourceUid = sourceUid;
        normalized.targetUid = targetUid;
        normalized.source = normalizeEquipmentEnchantSourceState(
            normalized.source,
            sourceUid,
        );
        const targetPart = toNumber(
            normalized.targetPart,
            toNumber(normalized.source && normalized.source.part, 1),
        );
        normalized.targetPart = targetPart;
        if (normalized.targetEquipment) {
            normalized.targetEquipment = cloneEquipmentPartState(
                normalized.targetEquipment,
                targetPart || 1,
            );
            normalized.targetSide =
                getEquipmentPartEnchantSideByUid(
                    normalized.targetEquipment,
                    targetUid,
                    normalized.targetSide || "current",
                ) || "current";
        } else {
            normalized.targetSide = normalized.targetSide || "current";
        }
        return normalized;
    }
    function getEquipmentEnchantLinks(equipmentEnchantConfig, targetTeamConfig) {
        const savedLinks =
            equipmentEnchantConfig && Array.isArray(equipmentEnchantConfig.links)
                ? equipmentEnchantConfig.links.map(normalizeEquipmentEnchantLink)
                : [];
        const rebuiltLinks = buildEquipmentEnchantLinksFromMap(
            equipmentEnchantConfig,
            targetTeamConfig,
        ).map(normalizeEquipmentEnchantLink);
        if (!savedLinks.length) {
            return rebuiltLinks;
        }
        const seen = new Set(
            savedLinks.map(
                (link) =>
                    toNumber(link && link.sourceUid, 0) +
                    "->" +
                    toNumber(link && link.targetUid, 0),
            ),
        );
        return savedLinks.concat(
            rebuiltLinks.filter((link) => {
                const key =
                    toNumber(link && link.sourceUid, 0) +
                    "->" +
                    toNumber(link && link.targetUid, 0);
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            }),
        );
    }
    function roundFingerprintConfidence(confidence) {
        return Math.round(confidence * 10000) / 10000;
    }
    function scoreCarrierMeta(targetSlotConfig, liveHero) {
        if (!targetSlotConfig || !liveHero) {
            return 0;
        }
        let score = 0;
        let maxScore = 0;
        const targetMeta = targetSlotConfig.carrierMeta || {};
        maxScore += 12;
        if (toNumber(targetSlotConfig.heroId, 0) === toNumber(liveHero.heroId, 0)) {
            score += 12;
        }
        maxScore += 10;
        if (toNumber(targetSlotConfig.order, toNumber(targetMeta.order, 0)) === toNumber(liveHero.order, 0)) {
            score += 10;
        }
        maxScore += 8;
        if (toNumber(targetSlotConfig.color, toNumber(targetMeta.color, 0)) === toNumber(liveHero.color, 0)) {
            score += 8;
        }
        maxScore += 6;
        if (toNumber(targetSlotConfig.star, toNumber(targetMeta.star, 0)) === toNumber(liveHero.star, 0)) {
            score += 6;
        }
        maxScore += 8;
        if (toNumber(targetSlotConfig.artifactId, toNumber(targetMeta.artifactId, 0)) === toNumber(liveHero.artifactId, 0)) {
            score += 8;
        }
        maxScore += 8;
        if (toNumber(targetSlotConfig.pearlId, toNumber(targetMeta.pearlId, 0)) === toNumber(liveHero.pearlId, 0)) {
            score += 8;
        }
        return maxScore ? score / maxScore : 0;
    }
    function buildFingerprintCandidateMatrix(
        targetSlots,
        liveHeroes,
        candidateLimit,
    ) {
        return targetSlots.map((targetSlot) => {
            const scoredCandidates = liveHeroes
                .map((hero) => {
                    const metaConfidence = scoreCarrierMeta(
                        targetSlot.slotConfig,
                        hero.hero,
                    );
                    const equipmentConfidence = scoreEquipmentFingerprint(
                        targetSlot.fingerprint,
                        hero.fingerprint,
                    );
                    return {
                        slotIndex: targetSlot.slotIndex,
                        heroId: hero.heroId,
                        attachmentUid: hero.attachmentUid,
                        carrierKey: hero.carrierKey,
                        metaConfidence,
                        equipmentConfidence,
                        confidence: equipmentConfidence * 0.78 + metaConfidence * 0.22,
                    };
                })
                .sort((left, right) => right.confidence - left.confidence);
            const bestConfidence = scoredCandidates.length
                ? scoredCandidates[0].confidence
                : 0;
            const candidates = scoredCandidates
                .filter(
                    (candidate, index) =>
                        index < candidateLimit ||
                        candidate.confidence >= bestConfidence - 0.1,
                )
                .slice(0, candidateLimit + 4);
            return {
                slotIndex: targetSlot.slotIndex,
                candidates: candidates.length
                    ? candidates
                    : scoredCandidates.slice(0, candidateLimit),
            };
        });
    }
    function searchBestFingerprintAssignment(slotCandidates) {
        const orderedSlots = slotCandidates
            .map((slotEntry) => ({
                slotIndex: slotEntry.slotIndex,
                candidates: slotEntry.candidates
                    .slice()
                    .sort(
                        (left, right) => right.confidence - left.confidence,
                    ),
            }))
            .sort((left, right) => left.candidates.length - right.candidates.length);
        if (orderedSlots.some((slotEntry) => !slotEntry.candidates.length)) {
            return null;
        }
        const upperBounds = new Array(orderedSlots.length + 1).fill(0);
        for (let index = orderedSlots.length - 1; index >= 0; index--) {
            const bestConfidence = orderedSlots[index].candidates.length
                ? orderedSlots[index].candidates[0].confidence
                : 0;
            upperBounds[index] = upperBounds[index + 1] + bestConfidence;
        }
        let bestResult = null;
        const usedCarriers = new Set();
        const currentAssignments = [];
        function dfs(index, totalScore) {
            if (index >= orderedSlots.length) {
                if (!bestResult || totalScore > bestResult.totalScore) {
                    bestResult = {
                        totalScore,
                        assignments: currentAssignments.map((assignment) => ({
                            ...assignment,
                        })),
                    };
                }
                return;
            }
            if (
                bestResult &&
                totalScore + upperBounds[index] <= bestResult.totalScore
            ) {
                return;
            }
            const slotEntry = orderedSlots[index];
            for (const candidate of slotEntry.candidates) {
                const carrierKey =
                    candidate.carrierKey ||
                    candidate.attachmentUid ||
                    "hero:" + candidate.heroId;
                if (usedCarriers.has(carrierKey)) {
                    continue;
                }
                usedCarriers.add(carrierKey);
                currentAssignments.push(candidate);
                dfs(index + 1, totalScore + candidate.confidence);
                currentAssignments.pop();
                usedCarriers.delete(carrierKey);
            }
        }
        dfs(0, 0);
        return bestResult;
    }
    function summarizeFingerprintCandidates(slotCandidates) {
        return slotCandidates.map((slotEntry) => ({
            slotIndex: slotEntry.slotIndex,
            candidates: slotEntry.candidates.slice(0, 3).map((candidate) => ({
                heroId: candidate.heroId,
                attachmentUid: candidate.attachmentUid,
                carrierKey: candidate.carrierKey,
                confidence: roundFingerprintConfidence(candidate.confidence),
                equipmentConfidence: roundFingerprintConfidence(candidate.equipmentConfidence || 0),
                metaConfidence: roundFingerprintConfidence(candidate.metaConfidence || 0),
            })),
        }));
    }
    function buildFingerprintCarrierHeroAssignment(targetTeamConfig, role) {
        const targetSlots = [];
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const targetSlotConfig = targetTeamConfig[slotIndex];
            if (
                !targetSlotConfig ||
                !toNumber(targetSlotConfig.heroId, 0) ||
                !targetSlotConfig.equipment
            ) {
                continue;
            }
            targetSlots.push({
                    slotIndex,
                    slotConfig: targetSlotConfig,
                    fingerprint: buildEquipmentFingerprint(
                        targetSlotConfig.equipment,
                    ),
                });
        }
        if (!targetSlots.length) {
            return new Map();
        }
        const liveHeroes = [];
        for (const hero of role.heroes.values()) {
            const heroId = toNumber(hero.heroId, 0);
            const attachmentUid = getHeroUid(hero);
            liveHeroes.push({
                heroId,
                hero,
                attachmentUid,
                carrierKey: attachmentUid || "hero:" + heroId,
                fingerprint: buildEquipmentFingerprint(
                    getHeroEquipmentState(hero),
                ),
            });
        }
        let bestAttempt = null;
        let lastCandidateMatrix = [];
        [6, 10, 14].forEach((candidateLimit) => {
            if (bestAttempt && bestAttempt.isAccepted) {
                return;
            }
            const candidateMatrix = buildFingerprintCandidateMatrix(
                targetSlots,
                liveHeroes,
                candidateLimit,
            );
            lastCandidateMatrix = candidateMatrix;
            const assignmentResult =
                searchBestFingerprintAssignment(candidateMatrix);
            if (
                !assignmentResult ||
                assignmentResult.assignments.length !== targetSlots.length
            ) {
                return;
            }
            const averageConfidence =
                assignmentResult.totalScore / targetSlots.length;
            const minimumConfidence = assignmentResult.assignments.reduce(
                (minimum, assignment) =>
                    Math.min(minimum, assignment.confidence),
                1,
            );
            const attempt = {
                assignmentResult,
                averageConfidence,
                minimumConfidence,
                isAccepted:
                    averageConfidence >= 0.6 && minimumConfidence >= 0.45,
            };
            if (
                !bestAttempt ||
                attempt.assignmentResult.totalScore >
                    bestAttempt.assignmentResult.totalScore
            ) {
                bestAttempt = attempt;
            }
        });
        if (
            !bestAttempt ||
            !bestAttempt.assignmentResult ||
            bestAttempt.assignmentResult.assignments.length !==
                targetSlots.length ||
            bestAttempt.averageConfidence < 0.55 ||
            bestAttempt.minimumConfidence < 0.38
        ) {
            console.log("[阵容] 整套装备指纹近似匹配置信度不足", {
                averageConfidence: bestAttempt
                    ? roundFingerprintConfidence(
                          bestAttempt.averageConfidence,
                      )
                    : 0,
                minimumConfidence: bestAttempt
                    ? roundFingerprintConfidence(
                          bestAttempt.minimumConfidence,
                      )
                    : 0,
                candidates: summarizeFingerprintCandidates(lastCandidateMatrix),
            });
            return null;
        }
        const carrierHeroAssignment = new Map();
        bestAttempt.assignmentResult.assignments.forEach((assignment) => {
            carrierHeroAssignment.set(assignment.slotIndex, {
                heroId: assignment.heroId,
                attachmentUid: assignment.attachmentUid,
                carrierKey:
                    assignment.carrierKey ||
                    assignment.attachmentUid ||
                    "hero:" + assignment.heroId,
                confidence: assignment.confidence,
                equipmentConfidence: assignment.equipmentConfidence,
                metaConfidence: assignment.metaConfidence,
            });
        });
        console.log("[阵容] 已使用整套装备指纹近似匹配载体", {
            averageConfidence: roundFingerprintConfidence(
                bestAttempt.averageConfidence,
            ),
            minimumConfidence: roundFingerprintConfidence(
                bestAttempt.minimumConfidence,
            ),
            assignments: bestAttempt.assignmentResult.assignments
                .slice()
                .sort((left, right) => left.slotIndex - right.slotIndex)
                .map((assignment) => ({
                    slotIndex: assignment.slotIndex,
                    heroId: assignment.heroId,
                    attachmentUid: assignment.attachmentUid,
                    carrierKey: assignment.carrierKey,
                    confidence: roundFingerprintConfidence(
                        assignment.confidence,
                    ),
                    equipmentConfidence: roundFingerprintConfidence(
                        assignment.equipmentConfidence || 0,
                    ),
                    metaConfidence: roundFingerprintConfidence(
                        assignment.metaConfidence || 0,
                    ),
                })),
        });
        return carrierHeroAssignment;
    }
    function getHeroTrumpState(hero) {
        if (!hero) {
            return {
                trumpId: 0,
                trumpId2: 0,
                activeId: 0,
                inactiveId: 0,
                transTrumpId: 0,
            };
        }
        const trump = hero.trump || hero.trumpInfo || null;
        const trumpId = firstPositiveNumber(
            hero.trumpId,
            hero.curTrump,
            trump && trump.trumpId,
            trump && trump.activeId,
        );
        const trumpId2 = firstPositiveNumber(
            hero.trumpId2,
            trump && trump.trumpId2,
            trump && trump.inactiveId,
        );
        const transTrumpId = firstPositiveNumber(
            hero.transTrumpId,
            trump && trump.transTrumpId,
        );
        return {
            trumpId,
            trumpId2,
            activeId: firstPositiveNumber(trump && trump.activeId, trumpId),
            inactiveId: firstPositiveNumber(trump && trump.inactiveId, trumpId2),
            transTrumpId,
        };
    }
    function getHeroAppendSkillState(hero, pearlSkillId) {
        if (hero && Array.isArray(hero.appendSkill)) {
            return hero.appendSkill.map((skillId) => toNumber(skillId, 0)).filter(Boolean);
        }
        const skillId = toNumber(pearlSkillId, 0);
        return skillId > 0 ? [skillId] : [];
    }
    function getHeroArtifactStateFromHero(role, hero) {
        const artifactId = toNumber(hero ? hero.artifactId : 0, 0);
        const pearlId = toNumber(hero ? hero.pearlId : 0, 0);
        const pearl = pearlId > 0 ? role.pearlMap.get(pearlId) : null;
        const appendSkill = hero && Array.isArray(hero.appendSkill) ? hero.appendSkill : [];
        const appendPearlSkillId = appendSkill
            .map((skillId) => toNumber(skillId, 0))
            .find((skillId) => skillId >= 1033007 && skillId <= 1033017) || 0;
        const pearlSkillId = appendPearlSkillId || (pearlId > 0 && pearl ? extractPearlRuntimeSkillId(pearl) : 0);
        return {
            artifactId,
            pearlId,
            pearlSkillId,
            pearl: cloneSerializable(pearl),
        };
    }
    function getHeroArtifactState(role, heroId) {
        return getHeroArtifactStateFromHero(role, role.getHeroById(heroId));
    }
    function getRolePetData() {
        try {
            const ServerData = window.__require("ServerData");
            return (
                (ServerData.SERVER_DATA && ServerData.SERVER_DATA.rolePet) ||
                ServerData.rolePet ||
                (ServerData.ROLE && ServerData.ROLE.rolePet) ||
                null
            );
        } catch (error) {
            return null;
        }
    }
    function getPetBySlotOrUid(rolePet, slotOrUid) {
        if (!rolePet) {
            return null;
        }
        if (typeof rolePet.getPet === "function") {
            return rolePet.getPet(slotOrUid) || null;
        }
        if (rolePet.pets && typeof rolePet.pets.get === "function") {
            if (typeof slotOrUid === "number") {
                return rolePet.pets.get(slotOrUid) || null;
            }
            const slot = rolePet.petsReverse
                ? rolePet.petsReverse.get(slotOrUid)
                : undefined;
            return rolePet.pets.get(slot) || null;
        }
        return null;
    }
    function getPetSlotByUid(rolePet, petUid) {
        if (!rolePet || !petUid) {
            return 0;
        }
        if (rolePet.petsReverse && typeof rolePet.petsReverse.get === "function") {
            return toNumber(rolePet.petsReverse.get(petUid), 0);
        }
        if (rolePet.pets && typeof rolePet.pets.forEach === "function") {
            let foundSlot = 0;
            rolePet.pets.forEach((pet, slot) => {
                if (!foundSlot && pet && pet.uId === petUid) {
                    foundSlot = toNumber(slot, 0);
                }
            });
            return foundSlot;
        }
        return 0;
    }
    function clonePetQuenchMap(quenches) {
        const result = {};
        normalizeCollectionToArray(quenches).forEach(([slotKey, quench]) => {
            if (!quench) {
                return;
            }
            result[slotKey] = {
                attrId: toNumber(quench.attrId, 0),
                attrNum: toNumber(quench.attrNum, 0),
                color: toNumber(quench.color, toNumber(quench.colorId, 0)),
                colorId: toNumber(quench.colorId, toNumber(quench.color, 0)),
                locked: !!(quench.locked || quench.isLocked),
            };
        });
        return result;
    }
    function clonePetState(pet, slot = 0) {
        if (!pet) {
            return {
                slot,
                uId: "",
                petId: 0,
            };
        }
        return {
            ...cloneSerializable(pet),
            slot,
            uId: String(pet.uId || ""),
            petId: toNumber(pet.petId, 0),
            level: toNumber(pet.level, 0),
            star: toNumber(pet.star, 0),
            quenches: clonePetQuenchMap(pet.quenches),
        };
    }
    function getCurrentPetState() {
        const rolePet = getRolePetData();
        const currentPet = getPetBySlotOrUid(rolePet, -1);
        return clonePetState(currentPet, -1);
    }
    function scorePetSnapshot(targetPet, livePet) {
        if (!targetPet || !livePet) {
            return 0;
        }
        if (targetPet.uId && livePet.uId && targetPet.uId === livePet.uId) {
            return 1;
        }
        let score = 0;
        let maxScore = 0;
        maxScore += 30;
        if (toNumber(targetPet.petId, 0) === toNumber(livePet.petId, 0)) {
            score += 30;
        }
        maxScore += 10;
        score += scoreCloseNumber(targetPet.level, livePet.level, 20, 10);
        maxScore += 6;
        score += scoreCloseNumber(targetPet.star, livePet.star, 2, 6);
        const targetTokens = [];
        const liveTokens = [];
        Object.keys(targetPet.quenches || {}).forEach((key) => {
            const quench = targetPet.quenches[key] || {};
            targetTokens.push(
                toNumber(quench.attrId, 0) +
                    "#" +
                    toNumber(quench.colorId || quench.color, 0),
            );
        });
        Object.keys(livePet.quenches || {}).forEach((key) => {
            const quench = livePet.quenches[key] || {};
            liveTokens.push(
                toNumber(quench.attrId, 0) +
                    "#" +
                    toNumber(quench.colorId || quench.color, 0),
            );
        });
        maxScore += 10;
        score += scoreTokenOverlap(targetTokens, liveTokens, 10);
        return maxScore ? score / maxScore : 0;
    }
    function getResearchLevel(role, researchId) {
        return toNumber(role ? role.legionResearch.get(researchId) : 0, 0);
    }
    function isFormationConfig(savedConfig) {
        return !!(
            savedConfig &&
            savedConfig.formation &&
            savedConfig.formation.schemaVersion >= 2 &&
            savedConfig.formation.battleTeam &&
            (savedConfig.formation.heroes || savedConfig.formation.heroSlots)
        );
    }
    function buildLegacyTeamFromFormation(formation) {
        const teamSnapshot = {};
        const battleTeam = formation && formation.battleTeam ? formation.battleTeam : {};
        const heroes = formation && formation.heroes ? formation.heroes : {};
        const heroSlots = formation && formation.heroSlots ? formation.heroSlots : {};
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const heroId = toNumber(battleTeam[slotIndex], 0);
            if (!heroId) {
                continue;
            }
            const heroState =
                heroSlots[slotIndex] ||
                heroSlots[String(slotIndex)] ||
                heroes[heroId] ||
                heroes[String(heroId)] ||
                {};
            const appendSkill = Array.isArray(heroState.appendSkill)
                ? heroState.appendSkill
                : [];
            const trumpState = heroState.trump || {};
            const savedTrumpId = firstPositiveNumber(
                heroState.trumpId,
                trumpState.trumpId,
                trumpState.activeId,
                heroState.curTrump,
            );
            const savedTrumpId2 = firstPositiveNumber(
                heroState.trumpId2,
                trumpState.trumpId2,
                trumpState.inactiveId,
            );
            const savedTransTrumpId = firstPositiveNumber(
                heroState.transTrumpId,
                trumpState.transTrumpId,
            );
            const slotSnapshot = {
                heroId,
                slotIndex,
                visualSlotIndex: getLineupVisualSlotIndex(heroState, slotIndex),
                positionIndex: getLineupVisualSlotIndex(heroState, slotIndex),
                level: toNumber(heroState.level, 1) || 1,
                order: toNumber(heroState.order, 0),
                color: toNumber(heroState.color, 0),
                star: toNumber(heroState.star, 0),
                name: heroState.name || "",
                speed: toNumber(heroState.speed, 0),
                power: toNumber(heroState.power, 0),
                carrierMeta: cloneSerializable(heroState.carrierMeta),
                artifactId: toNumber(heroState.artifactId, 0),
                pearlId: toNumber(heroState.pearlId, 0),
                pearlSkillId: toNumber(heroState.pearlSkillId, toNumber(appendSkill[0], 0)),
                pearl: cloneSerializable(heroState.pearl),
                curTrump: savedTrumpId,
                trumpId: savedTrumpId,
                trumpId2: savedTrumpId2,
                transTrumpId: savedTransTrumpId,
                trump: cloneSerializable(heroState.trump) || {
                    trumpId: savedTrumpId,
                    trumpId2: savedTrumpId2,
                    activeId: savedTrumpId,
                    inactiveId: savedTrumpId2,
                    transTrumpId: savedTransTrumpId,
                },
                equipment: cloneSerializable(heroState.equipment) || {},
                attachmentUid: heroState.attachmentUid || heroState.containerId || "",
                bindingMode: heroState.bindingMode || formation.bindingMode || "",
                containerId: heroState.containerId || "",
                appendSkill: cloneSerializable(appendSkill),
                useSkin: toNumber(heroState.useSkin, -1),
            };
            if (heroState.equipmentEnchant) {
                slotSnapshot.equipmentEnchant = cloneSerializable(
                    heroState.equipmentEnchant,
                );
            }
            if (heroState.order !== undefined) {
                slotSnapshot.order = toNumber(heroState.order, 0);
            }
            teamSnapshot[slotIndex] = slotSnapshot;
        }
        return teamSnapshot;
    }
    function normalizeSavedConfig(savedConfig) {
        if (!isFormationConfig(savedConfig)) {
            return savedConfig;
        }
        const formation = savedConfig.formation;
        return {
            ...savedConfig,
            team: savedConfig.team || buildLegacyTeamFromFormation(formation),
            research: savedConfig.research || formation.legionResearch || {},
            teamId: savedConfig.teamId || formation.presetTeamId || 0,
            weaponId: savedConfig.weaponId || formation.lordWeaponId || 0,
            power: savedConfig.power || formation.power || 0,
            pet: savedConfig.pet || formation.pet || { uId: "", petId: 0 },
            equipmentEnchant:
                savedConfig.equipmentEnchant ||
                formation.equipmentEnchant ||
                {
                    enchantMap: formation.enchantMap || {},
                    links: [],
                },
        };
    }
    function buildFormationFromLiveRole(role, teamSnapshot, researchSnapshot, currentTeamId) {
        const equipmentEnchantSnapshot = buildEquipmentEnchantSnapshot(
            role,
            teamSnapshot,
        );
        const formation = {
            schemaVersion: 4,
            bindingMode: "equipment-ledger-v1",
            roleId: toNumber(role && (role.id || role.userId || role.user_id || role.uid), 0),
            presetTeamId: toNumber(currentTeamId, 1),
            power: toNumber(role && (role.power || role.fightPower || role.combatPower), 0),
            lordWeaponId: toNumber(role && role.lordWeaponId, 0),
            battleTeam: {},
            heroes: {},
            heroSlots: {},
            enchantMap: mapToPlainObject(role && role.enchantMap),
            equipmentEnchant: equipmentEnchantSnapshot,
            pet: getCurrentPetState(),
            legionResearch: cloneSerializable(researchSnapshot) || {},
        };
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const slotConfig = teamSnapshot[slotIndex];
            const heroId = toNumber(slotConfig && slotConfig.heroId, 0);
            if (!heroId) {
                continue;
            }
            const liveHero = role
                ? resolveLiveHeroForTargetSlot(role, slotConfig) ||
                  role.getHeroById(heroId)
                : null;
            const trumpState =
                cloneSerializable(slotConfig.trump) ||
                getHeroTrumpState(liveHero);
            const savedTrumpId = firstPositiveNumber(
                slotConfig.trumpId,
                trumpState && trumpState.trumpId,
                trumpState && trumpState.activeId,
                slotConfig.curTrump,
                liveHero && liveHero.trumpId,
                liveHero && liveHero.curTrump,
            );
            const savedTrumpId2 = firstPositiveNumber(
                slotConfig.trumpId2,
                trumpState && trumpState.trumpId2,
                trumpState && trumpState.inactiveId,
                liveHero && liveHero.trumpId2,
            );
            const savedTransTrumpId = firstPositiveNumber(
                slotConfig.transTrumpId,
                trumpState && trumpState.transTrumpId,
                liveHero && liveHero.transTrumpId,
            );
            const normalizedTrumpState = {
                ...(trumpState || {}),
                trumpId: savedTrumpId,
                trumpId2: savedTrumpId2,
                activeId: firstPositiveNumber(
                    trumpState && trumpState.activeId,
                    savedTrumpId,
                ),
                inactiveId: firstPositiveNumber(
                    trumpState && trumpState.inactiveId,
                    savedTrumpId2,
                ),
                transTrumpId: savedTransTrumpId,
            };
            formation.battleTeam[slotIndex] = heroId;
            const heroState = {
                heroId,
                slotIndex,
                visualSlotIndex: getLineupVisualSlotIndex(slotConfig, slotIndex),
                positionIndex: getLineupVisualSlotIndex(slotConfig, slotIndex),
                carrierMeta: cloneSerializable(slotConfig.carrierMeta) || getHeroCarrierMeta(liveHero),
                level: toNumber(slotConfig.level, getHeroLevel(liveHero)),
                order: toNumber(slotConfig.order, getHeroOrder(liveHero)),
                color: toNumber(slotConfig.color, liveHero ? liveHero.color : 0),
                star: toNumber(slotConfig.star, liveHero ? liveHero.star : 0),
                name:
                    slotConfig.name ||
                    (liveHero && (liveHero.nickName || liveHero.name)) ||
                    "",
                speed: toNumber(slotConfig.speed, getHeroSpeed(liveHero)),
                power: toNumber(slotConfig.power, getHeroPower(liveHero)),
                artifactId: toNumber(slotConfig.artifactId, liveHero ? liveHero.artifactId : 0),
                pearlId: toNumber(slotConfig.pearlId, liveHero ? liveHero.pearlId : 0),
                pearlSkillId: toNumber(slotConfig.pearlSkillId, 0),
                pearl: cloneSerializable(slotConfig.pearl),
                curTrump: savedTrumpId,
                trumpId: savedTrumpId,
                trumpId2: savedTrumpId2,
                transTrumpId: savedTransTrumpId,
                useSkin: toNumber(slotConfig.useSkin, liveHero ? liveHero.useSkin : -1),
                trump: normalizedTrumpState,
                equipment: cloneSerializable(slotConfig.equipment) || getHeroEquipmentState(liveHero),
                appendSkill: cloneSerializable(slotConfig.appendSkill) || getHeroAppendSkillState(liveHero, slotConfig.pearlSkillId),
                attachmentUid: slotConfig.attachmentUid || getHeroUid(liveHero),
                bindingMode: "equipment-ledger-v1",
                containerId: slotConfig.containerId || slotConfig.attachmentUid || getHeroUid(liveHero),
            };
            formation.heroSlots[slotIndex] = cloneSerializable(heroState);
            formation.heroes[heroId] = cloneSerializable(heroState);
            const slotEnchantLinks = equipmentEnchantSnapshot.links.filter(
                (link) => toNumber(link.targetSlotIndex, -1) === slotIndex,
            );
            if (slotEnchantLinks.length) {
                formation.heroSlots[slotIndex].equipmentEnchant = slotEnchantLinks;
                formation.heroes[heroId].equipmentEnchant = slotEnchantLinks;
            }
        }
        return formation;
    }
    function resolveLiveSlotHero(slotIndex, fallbackHeroId = 0) {
        const ServerData = window.__require("ServerData");
        const role = ServerData.ROLE;
        const battleSlot = role.battleTeam.get(slotIndex);
        const slotHeroId = toNumber(battleSlot && battleSlot.heroId, 0);
        const heroId = slotHeroId || toNumber(fallbackHeroId, 0);
        const hero = battleSlot
            ? findLiveHeroByBattleSlot(role, battleSlot, slotIndex)
            : role.getHeroById(heroId);
        return {
            heroId,
            attachmentUid: getHeroUid(hero),
            hero,
        };
    }
    function getLiveBattleSlotState(slotIndex) {
        const liveBinding = resolveLiveSlotHero(slotIndex);
        return {
            slotIndex,
            heroId: liveBinding.heroId,
            attachmentUid: liveBinding.attachmentUid,
        };
    }
    function buildTargetSlotRestoreState(targetSlotConfig) {
        const targetHeroId = toNumber(targetSlotConfig.heroId, 0);
        const hasOrder = targetSlotConfig.order !== undefined;
        return {
            heroId: targetHeroId,
            level: toNumber(targetSlotConfig.level, 1) || 1,
            order: hasOrder ? toNumber(targetSlotConfig.order, 0) : 0,
            hasOrder,
            attachmentUid:
                normalizeUidString(targetSlotConfig.attachmentUid) ||
                normalizeUidString(targetSlotConfig.containerId),
        };
    }
    function buildExactCarrierHeroAssignment(targetTeamConfig) {
        const ServerData = window.__require("ServerData");
        const role = ServerData.ROLE;
        const carrierHeroAssignment = new Map();
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const targetSlotState = buildTargetSlotRestoreState(
                targetTeamConfig[slotIndex],
            );
            if (!targetSlotState.heroId) {
                continue;
            }
            const targetAttachmentUid = String(
                targetSlotState.attachmentUid || "",
            );
            if (!targetAttachmentUid) {
                return buildFingerprintCarrierHeroAssignment(targetTeamConfig, role);
            }
            let carrierHero = null;
            for (const hero of role.heroes.values()) {
                if (getHeroUid(hero) !== targetAttachmentUid) {
                    continue;
                }
                carrierHero = hero;
                break;
            }
            if (!carrierHero) {
                return buildFingerprintCarrierHeroAssignment(targetTeamConfig, role);
            }
            const carrierHeroId = toNumber(carrierHero.heroId, 0);
            carrierHeroAssignment.set(slotIndex, {
                heroId: carrierHeroId,
                attachmentUid: targetAttachmentUid,
                carrierKey: targetAttachmentUid || "hero:" + carrierHeroId,
                confidence: 1,
            });
        }
        return carrierHeroAssignment;
    }
    async function clearEmptyTargetSlots(targetTeamConfig) {
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const targetSlotConfig = targetTeamConfig[slotIndex];
            const currentSlotState = getLiveBattleSlotState(slotIndex);
            if (
                (!targetSlotConfig || !toNumber(targetSlotConfig.heroId, 0)) &&
                currentSlotState.heroId > 0
            ) {
                console.log(
                    "[阵位] 位置 " +
                        slotIndex +
                        " 目标为空，先下阵当前武将 " +
                        currentSlotState.heroId,
                );
                await goBackBattleFromSlot(slotIndex);
            }
        }
    }
    async function restoreBattleCarriersByAssignment(targetTeamConfig) {
        const ServerData = window.__require("ServerData");
        const carrierHeroAssignment =
            buildExactCarrierHeroAssignment(targetTeamConfig);
        if (!carrierHeroAssignment) {
            return false;
        }
        const desiredCarrierInfos = new Array(5).fill(null);
        carrierHeroAssignment.forEach((carrierInfo, targetSlotIndex) => {
            desiredCarrierInfos[targetSlotIndex] = carrierInfo;
        });
        let restoreRounds = 0;
        while (restoreRounds < 10) {
            restoreRounds += 1;
            const liveSlotStates = [];
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                liveSlotStates.push(getLiveBattleSlotState(slotIndex));
            }
            let hasMoved = false;
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const desiredCarrierInfo = desiredCarrierInfos[slotIndex];
                const desiredCarrierHeroId = toNumber(
                    desiredCarrierInfo && desiredCarrierInfo.heroId,
                    0,
                );
                const desiredCarrierUid = normalizeUidString(
                    desiredCarrierInfo && desiredCarrierInfo.attachmentUid,
                );
                if (!desiredCarrierHeroId) {
                    continue;
                }
                if (
                    liveSlotStates[slotIndex].heroId === desiredCarrierHeroId &&
                    (!desiredCarrierUid ||
                        liveSlotStates[slotIndex].attachmentUid === desiredCarrierUid)
                ) {
                    continue;
                }
                const sourceSlotState = liveSlotStates.find(
                    (slotState) =>
                        slotState.heroId === desiredCarrierHeroId &&
                        (!desiredCarrierUid ||
                            slotState.attachmentUid === desiredCarrierUid),
                );
                const desiredCarrierHero =
                    ServerData.ROLE.getHeroById(desiredCarrierHeroId);
                if (!desiredCarrierHero) {
                    return false;
                }
                console.log(
                    "[阵位] 位置 " +
                        slotIndex +
                        " 需要载体武将 " +
                        desiredCarrierHeroId +
                        "，当前位于位置 " +
                        (sourceSlotState
                            ? sourceSlotState.slotIndex
                            : toNumber(desiredCarrierHero.battleTeamSlot, -1)),
                );
                await goIntoBattleAtSlot(
                    slotIndex,
                    desiredCarrierHeroId,
                    desiredCarrierUid || getHeroUid(desiredCarrierHero),
                );
                hasMoved = true;
                break;
            }
            if (!hasMoved) {
                return true;
            }
        }
        return false;
    }
    async function restoreHeroCultivationCarriers(targetTeamConfig) {
        let restoreRounds = 0;
        while (restoreRounds < 20) {
            restoreRounds += 1;
            const carrierHeroAssignment =
                buildExactCarrierHeroAssignment(targetTeamConfig);
            if (!carrierHeroAssignment) {
                return false;
            }
            let hasExchanged = false;
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const targetSlotConfig = targetTeamConfig[slotIndex];
                const targetHeroId = toNumber(
                    targetSlotConfig && targetSlotConfig.heroId,
                    0,
                );
                if (!targetHeroId) {
                    continue;
                }
                const carrierInfo = carrierHeroAssignment.get(slotIndex);
                const carrierHeroId = toNumber(
                    carrierInfo && carrierInfo.heroId,
                    0,
                );
                const carrierAttachmentUid = normalizeUidString(
                    carrierInfo && carrierInfo.attachmentUid,
                );
                if (!carrierHeroId) {
                    return false;
                }
                if (carrierHeroId === targetHeroId) {
                    const targetSlotState =
                        buildTargetSlotRestoreState(targetSlotConfig);
                    const targetAttachmentUid =
                        targetSlotState.attachmentUid || carrierAttachmentUid;
                    const currentAttachmentUid = getHeroUid(
                        resolveLiveHeroForTargetSlot(
                            window.__require("ServerData").ROLE,
                            targetSlotConfig,
                        ),
                    );
                    if (
                        targetAttachmentUid &&
                        currentAttachmentUid !== targetAttachmentUid
                    ) {
                        console.log(
                            "[养成载体] 武将 " +
                                targetHeroId +
                                " 存在同名/同ID不同载体，切换到保存UID " +
                                targetAttachmentUid,
                        );
                        await goIntoBattleAtSlot(
                            slotIndex,
                            targetHeroId,
                            targetAttachmentUid,
                        );
                        hasExchanged = true;
                        break;
                    }
                    continue;
                }
                console.log(
                    "[养成载体] 位置 " +
                        slotIndex +
                        " 保存的养成载体当前在武将 " +
                        carrierHeroId +
                        "，先无损交换回目标武将 " +
                        targetHeroId,
                );
                await sendHeroExchangeByService(carrierHeroId, targetHeroId);
                hasExchanged = true;
                break;
            }
            if (!hasExchanged) {
                const ServerData = window.__require("ServerData");
                for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                    const targetSlotConfig = targetTeamConfig[slotIndex];
                    const targetHeroId = toNumber(
                        targetSlotConfig && targetSlotConfig.heroId,
                        0,
                    );
                    if (!targetHeroId || !targetSlotConfig.equipment) {
                        continue;
                    }
                    assertHeroEquipmentMatchesTarget(
                        targetSlotConfig,
                        resolveLiveHeroForTargetSlot(
                            ServerData.ROLE,
                            targetSlotConfig,
                        ),
                        "养成载体恢复后",
                        0.68,
                    );
                }
                return true;
            }
        }
        return false;
    }
    async function restoreFinalBattleTeam(targetTeamConfig) {
        await clearEmptyTargetSlots(targetTeamConfig);
        let restoreRounds = 0;
        while (restoreRounds < 20) {
            restoreRounds += 1;
            let hasChanged = false;
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const targetSlotConfig = targetTeamConfig[slotIndex];
                const targetHeroId = toNumber(
                    targetSlotConfig && targetSlotConfig.heroId,
                    0,
                );
                const liveSlotState = getLiveBattleSlotState(slotIndex);
                if (!targetHeroId) {
                    if (liveSlotState.heroId > 0) {
                        await goBackBattleFromSlot(slotIndex);
                        hasChanged = true;
                        break;
                    }
                    continue;
                }
                const targetSlotState =
                    buildTargetSlotRestoreState(targetSlotConfig);
                const targetAttachmentUid = targetSlotState.attachmentUid;
                if (liveSlotState.heroId === targetHeroId) {
                    if (
                        targetAttachmentUid &&
                        liveSlotState.attachmentUid !== targetAttachmentUid
                    ) {
                        console.log(
                            "[阵位] 最终站位恢复：位置 " +
                                slotIndex +
                                " 是同ID武将但UID不一致，切换到保存UID " +
                                targetAttachmentUid,
                        );
                        await goIntoBattleAtSlot(
                            slotIndex,
                            targetHeroId,
                            targetAttachmentUid,
                        );
                        hasChanged = true;
                        break;
                    }
                    continue;
                }
                if (liveSlotState.heroId > 0) {
                    console.log(
                        "[阵位] 最终站位恢复：先下阵位置 " +
                            slotIndex +
                            " 的武将 " +
                            liveSlotState.heroId,
                    );
                    await goBackBattleFromSlot(slotIndex);
                    hasChanged = true;
                    break;
                }
                const targetHero = window
                    .__require("ServerData")
                    .ROLE.getHeroById(targetHeroId);
                if (!targetHero) {
                    throw new Error("最终站位恢复失败：武将 " + targetHeroId + " 不存在");
                }
                const finalAttachmentUid =
                    targetAttachmentUid || getHeroUid(targetHero);
                console.log(
                    "[阵位] 最终站位恢复：移动武将 " +
                        targetHeroId +
                        " 到位置 " +
                        slotIndex,
                );
                await goIntoBattleAtSlot(
                    slotIndex,
                    targetHeroId,
                    finalAttachmentUid,
                );
                hasChanged = true;
                break;
            }
            if (!hasChanged) {
                return true;
            }
        }
        return false;
    }
    async function restorePearlSkillsByExchange(targetTeamConfig) {
        const ServerData = window.__require("ServerData");
        const Configs = window.__require("Configs");
        const PearlModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.PEARL_SYSTEM);
        let exchangeRounds = 0;
        while (exchangeRounds < 30) {
            exchangeRounds += 1;
            const role = ServerData.ROLE;
            const targetSkillByPearlId = new Map();
            const currentSkillByPearlId = new Map();
            const skillHolderIds = new Map();
            role.pearlMap.forEach((pearl, pearlId) => {
                const currentSkillId = toNumber(pearl && pearl.skillId, 0);
                currentSkillByPearlId.set(pearlId, currentSkillId);
                if (currentSkillId <= 0) {
                    return;
                }
                const holderIds = skillHolderIds.get(currentSkillId) || [];
                holderIds.push(pearlId);
                skillHolderIds.set(currentSkillId, holderIds);
            });
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const targetSlotConfig = targetTeamConfig[slotIndex];
                const targetPearlId = toNumber(
                    targetSlotConfig && targetSlotConfig.pearlId,
                    0,
                );
                if (!targetPearlId) {
                    continue;
                }
                targetSkillByPearlId.set(
                    targetPearlId,
                    toNumber(targetSlotConfig && targetSlotConfig.pearlSkillId, 0),
                );
            }
            const demandPearlIds = [];
            targetSkillByPearlId.forEach((targetSkillId, pearlId) => {
                if (targetSkillId <= 0) {
                    return;
                }
                const currentSkillId = toNumber(currentSkillByPearlId.get(pearlId), 0);
                if (currentSkillId === targetSkillId) {
                    return;
                }
                demandPearlIds.push(pearlId);
            });
            if (!demandPearlIds.length) {
                return true;
            }
            const demandPearlIdSet = new Set(demandPearlIds);
            const isProtectedPearl = (pearlId) =>
                targetSkillByPearlId.has(pearlId) &&
                toNumber(currentSkillByPearlId.get(pearlId), 0) ===
                    toNumber(targetSkillByPearlId.get(pearlId), 0);
            const findSourcePearlId = (targetSkillId) => {
                const holderIds = skillHolderIds.get(targetSkillId) || [];
                let fallbackPearlId = 0;
                for (const holderId of holderIds) {
                    if (isProtectedPearl(holderId)) {
                        continue;
                    }
                    if (!demandPearlIdSet.has(holderId)) {
                        return holderId;
                    }
                    if (!fallbackPearlId) {
                        fallbackPearlId = holderId;
                    }
                }
                return fallbackPearlId;
            };
            let exchangePlan = null;
            for (const startPearlId of demandPearlIds) {
                const path = [];
                const pathIndex = new Map();
                let cursorPearlId = startPearlId;
                while (true) {
                    if (pathIndex.has(cursorPearlId)) {
                        const cyclePearlIds = path.slice(
                            pathIndex.get(cursorPearlId),
                        );
                        if (cyclePearlIds.length > 1) {
                            exchangePlan = [];
                            for (
                                let index = 0;
                                index < cyclePearlIds.length - 1;
                                index++
                            ) {
                                exchangePlan.push([
                                    cyclePearlIds[index],
                                    cyclePearlIds[index + 1],
                                ]);
                            }
                        }
                        break;
                    }
                    pathIndex.set(cursorPearlId, path.length);
                    path.push(cursorPearlId);
                    const sourcePearlId = findSourcePearlId(
                        toNumber(targetSkillByPearlId.get(cursorPearlId), 0),
                    );
                    if (!sourcePearlId || sourcePearlId === cursorPearlId) {
                        break;
                    }
                    if (!demandPearlIdSet.has(sourcePearlId)) {
                        exchangePlan = [];
                        for (let index = 0; index < path.length; index++) {
                            exchangePlan.push([
                                path[index],
                                index === path.length - 1
                                    ? sourcePearlId
                                    : path[index + 1],
                            ]);
                        }
                        break;
                    }
                    cursorPearlId = sourcePearlId;
                }
                if (exchangePlan && exchangePlan.length > 0) {
                    break;
                }
            }
            if (!exchangePlan || !exchangePlan.length) {
                return true;
            }
            let exchangedThisRound = false;
            for (const [leftPearlId, rightPearlId] of exchangePlan) {
                const leftSkillId = toNumber(currentSkillByPearlId.get(leftPearlId), 0);
                const rightSkillId = toNumber(
                    currentSkillByPearlId.get(rightPearlId),
                    0,
                );
                if (leftSkillId === rightSkillId) {
                    continue;
                }
                console.log(
                    "[鱼珠] 执行鱼珠技能交换: 珠 " +
                        leftPearlId +
                        "(" +
                        leftSkillId +
                        ") <-> 珠 " +
                        rightPearlId +
                        "(" +
                        rightSkillId +
                        ")",
                );
                const didExchange = await PearlModule.sendExchangeSkill(
                    leftPearlId,
                    rightPearlId,
                );
                if (!didExchange) {
                    throw new Error("鱼珠技能交换失败");
                }
                await waitForPearlRuntimeRefresh();
                exchangedThisRound = true;
                break;
            }
            if (!exchangedThisRound) {
                return true;
            }
        }
        return false;
    }
    async function restoreBattleHeroesByExchange(targetTeamConfig) {
        const ServerData = window.__require("ServerData");
        let restoreRounds = 0;
        while (restoreRounds < 20) {
            restoreRounds += 1;
            const liveSlotStates = [];
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                liveSlotStates.push(getLiveBattleSlotState(slotIndex));
            }
            let hasChanged = false;
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const targetSlotConfig = targetTeamConfig[slotIndex];
                const targetHeroId = toNumber(
                    targetSlotConfig && targetSlotConfig.heroId,
                    0,
                );
                if (!targetHeroId) {
                    continue;
                }
                const currentHeroId = liveSlotStates[slotIndex].heroId;
                if (currentHeroId === targetHeroId) {
                    continue;
                }
                if (!currentHeroId) {
                    const targetAttachmentUid = getHeroUid(
                        ServerData.ROLE.getHeroById(targetHeroId),
                    );
                    console.log(
                        "[换将] 位置 " +
                            slotIndex +
                            " 当前为空，直接上阵目标武将 " +
                            targetHeroId,
                    );
                    await goIntoBattleAtSlot(
                        slotIndex,
                        targetHeroId,
                        targetAttachmentUid,
                    );
                } else {
                    console.log(
                        "[换将] 位置 " +
                            slotIndex +
                            "：武将 " +
                            currentHeroId +
                            " 无损换将为 " +
                            targetHeroId,
                    );
                    await sendHeroExchangeByService(
                        currentHeroId,
                        targetHeroId,
                    );
                    const afterExchangeSlot = getLiveBattleSlotState(slotIndex);
                    if (afterExchangeSlot.heroId !== targetHeroId) {
                        const targetAttachmentUid = getHeroUid(
                            ServerData.ROLE.getHeroById(targetHeroId),
                        );
                        await goIntoBattleAtSlot(
                            slotIndex,
                            targetHeroId,
                            targetAttachmentUid,
                        );
                    }
                }
                hasChanged = true;
                break;
            }
            if (!hasChanged) {
                return true;
            }
        }
        return false;
    }
    function findArtifactOwnerHeroId(
        role,
        targetArtifactId,
        targetPearlId = 0,
    ) {
        const expectedArtifactId = toNumber(targetArtifactId, 0);
        const expectedPearlId = toNumber(targetPearlId, 0);
        for (const hero of role.heroes.values()) {
            const candidateHeroId = toNumber(hero.heroId, 0);
            const candidateState = getHeroArtifactStateFromHero(role, hero);
            if (candidateState.artifactId !== expectedArtifactId) {
                continue;
            }
            if (
                expectedPearlId > 0 &&
                candidateState.pearlId !== expectedPearlId
            ) {
                continue;
            }
            return candidateHeroId;
        }
        return -1;
    }
    async function callServiceMethod(service, methodName, params, label) {
        const result = await service[methodName](params);
        const responseCode = Number(result.code);
        if (responseCode !== 0) {
            throw new Error(label + " 失败: " + responseCode);
        }
        return result;
    }
    async function sendGoIntoBattleByService(slotIndex, heroId, attachmentUid) {
        const HeroService = window.__require("data-index").HeroService;
        const Configs = window.__require("Configs");
        const HeroModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.HERO);
        const GlobalSignal = window.__require("GlobalSignal").GlobalSignal;
        const params = {
            slot: slotIndex,
            heroId: heroId,
        };
        if (attachmentUid) {
            params.uid = attachmentUid;
            params.attachmentUid = attachmentUid;
        }
        await callServiceMethod(
            HeroService,
            "goIntoBattle",
            params,
            "位置 " + slotIndex + " 上阵武将 " + heroId,
        );
        if (HeroModule) {
            HeroModule.isBattleTeamChanged = true;
        }
        GlobalSignal.EventRefreshHeroTeamPanel.emit();
    }
    async function sendHeroExchangeByService(heroId, targetHeroId) {
        const ServerData = window.__require("ServerData");
        const HeroService = window.__require("data-index").HeroService;
        const Configs = window.__require("Configs");
        const HeroModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.HERO);
        const EquipmentModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.EQUIP);
        const GlobalSignal = window.__require("GlobalSignal").GlobalSignal;
        const role = ServerData.ROLE;
        const sourceHero = role.getHeroById(heroId);
        const targetHero = role.getHeroById(targetHeroId);
        const refreshSlots = [
            sourceHero ? sourceHero.battleTeamSlot : undefined,
            targetHero ? targetHero.battleTeamSlot : undefined,
        ].filter((slot) => Number.isFinite(Number(slot)));
        await callServiceMethod(
            HeroService,
            "exchange",
            {
                heroId: heroId,
                targetHeroId: targetHeroId,
            },
            "无损换将 " + heroId + " -> " + targetHeroId,
        );
        if (HeroModule) {
            HeroModule.isBattleTeamChanged = true;
        }
        EquipmentModule.resetEquipColor(sourceHero);
        EquipmentModule.resetEquipColor(targetHero);
        GlobalSignal.EventRefreshHeroTeamPanel.emit(refreshSlots);
    }
    async function sendHeroUpgradeLevelByService(heroId, upgradeNum) {
        const Configs = window.__require("Configs");
        const HeroService = window.__require("data-index").HeroService;
        const HeroModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.HERO);
        await callServiceMethod(
            HeroService,
            "heroUpgradeLevel",
            {
                heroId: heroId,
                upgradeNum: upgradeNum,
            },
            "武将 " + heroId + " 升级 " + upgradeNum + " 级",
        );
        if (HeroModule) {
            HeroModule.singleHeroAttrDirty += 1;
        }
    }
    async function sendHeroStageUpByService(heroId) {
        const Configs = window.__require("Configs");
        const HeroService = window.__require("data-index").HeroService;
        const HeroModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.HERO);
        await callServiceMethod(
            HeroService,
            "heroUpgradeOrder",
            {
                heroId: heroId,
            },
            "武将 " + heroId + " 升阶",
        );
        if (HeroModule) {
            HeroModule.singleHeroAttrDirty += 1;
        }
    }
    async function sendHeroRebirthByService(heroId) {
        const ServerData = window.__require("ServerData");
        const Configs = window.__require("Configs");
        const HeroService = window.__require("data-index").HeroService;
        const HeroModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.HERO);
        const EquipmentModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.EQUIP);
        const LevelBattleModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.LEVEL_BATTLE);
        const liveHero = ServerData.ROLE.getHeroById(heroId);
        await callServiceMethod(
            HeroService,
            "rebirth",
            {
                heroId: heroId,
            },
            "武将 " + heroId + " 重置",
        );
        if (HeroModule) {
            HeroModule.singleHeroAttrDirty += 1;
        }
        EquipmentModule.resetEquipColor(liveHero);
        if (liveHero && liveHero.isInBattleTeam()) {
            LevelBattleModule.resetLevelBattle();
        }
    }
    function setSwitchButtonsBusy(isBusy, activeButton = null) {
        document
            .querySelectorAll('[data-lineup-switch="1"]')
            .forEach((button) => {
                button.disabled = isBusy;
                button.style.opacity = isBusy ? "0.5" : "1";
                if (!isBusy || button !== activeButton) {
                    button.textContent = button.dataset.originalText;
                }
            });
    }
    async function refreshLineupRoleInfo() {
        try {
            const dataIndex = window.__require("data-index");
            const RoleService = dataIndex && dataIndex.RoleService;
            if (RoleService && typeof RoleService.getRoleInfo === "function") {
                await RoleService.getRoleInfo({});
                return true;
            }
        } catch (error) {
            console.log("[阵容槽] 刷新角色信息失败:", error);
        }
        return false;
    }
    async function switchPresetTeamSlot(targetTeamId, options = {}) {
        const {
            setStatusText = null,
            silentWhenCurrent = false,
            activeButton = null,
        } = options;
        const ServerData = window.__require("ServerData");
        const Configs = window.__require("Configs");
        const HeroModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.HERO);
        const SHOW_TIP = window.__require("TipsManager").SHOW_TIP;
        const role = ServerData.ROLE;
        const normalizedTargetTeamId = toNumber(targetTeamId, 0);
        if (normalizedTargetTeamId <= 0) {
            throw new Error("无效的阵容槽编号");
        }
        const currentTeamId = getCurrentPresetTeamId(role);
        if (currentTeamId === normalizedTargetTeamId) {
            if (!silentWhenCurrent) {
                if (typeof setStatusText === "function") {
                    setStatusText("当前已在阵容槽 " + normalizedTargetTeamId, ["当前"]);
                }
                SHOW_TIP("当前已在阵容槽 " + normalizedTargetTeamId);
            }
            return {
                changed: false,
                currentTeamId: normalizedTargetTeamId,
            };
        }
        if (typeof setStatusText === "function") {
            setStatusText("正在切换到阵容槽 " + normalizedTargetTeamId + "..."); 
        }
        if (activeButton) {
            activeButton.disabled = true;
            activeButton.style.opacity = "0.72";
        }
        const didSwitch = await HeroModule.sendSavePresetTeam(normalizedTargetTeamId);
        if (!didSwitch) {
            throw new Error("切换阵容槽失败");
        }
        await sleep(120);
        await refreshLineupRoleInfo();
        if (typeof setStatusText === "function") {
            setStatusText("已切换到阵容槽 " + normalizedTargetTeamId, ["成功", "阵容槽"]);
        }
        return {
            changed: true,
            currentTeamId: normalizedTargetTeamId,
        };
    }
    async function goBackBattleFromSlot(slotIndex) {
        const Configs = window.__require("Configs");
        const HeroModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.HERO);
        await HeroModule.sendGoBackBattle(slotIndex);
    }
    async function goIntoBattleAtSlot(slotIndex, heroId, attachmentUid) {
        const Configs = window.__require("Configs");
        const HeroModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.HERO);
        if (!attachmentUid) {
            await HeroModule.sendGoBattle(slotIndex, heroId);
        } else {
            await sendGoIntoBattleByService(slotIndex, heroId, attachmentUid);
        }
    }
    async function applyArtifactConfig(targetSlotConfig) {
        const ServerData = window.__require("ServerData");
        const Configs = window.__require("Configs");
        const ArtifactModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.ARTIFACT);
        if (!targetSlotConfig || !targetSlotConfig.heroId) {
            return;
        }
        const liveHero = findLiveHeroBySlotConfig(ServerData.ROLE, targetSlotConfig);
        let liveArtifactState = getHeroArtifactStateFromHero(
            ServerData.ROLE,
            liveHero,
        );
        const targetArtifactId = toNumber(targetSlotConfig.artifactId, 0);
        const targetPearlId = toNumber(targetSlotConfig.pearlId, 0);
        const needsArtifactSwitch =
            liveArtifactState.artifactId !== targetArtifactId ||
            liveArtifactState.pearlId !== targetPearlId;
        if (needsArtifactSwitch) {
            console.log(
                "[装备] 武将 " +
                    targetSlotConfig.heroId +
                    " 准备切换鱼灵，当前: " +
                    liveArtifactState.artifactId +
                    "/" +
                    liveArtifactState.pearlId +
                    " -> 目标: " +
                    targetArtifactId +
                    "/" +
                    targetPearlId,
            );
            if (liveArtifactState.artifactId > 0) {
                const didDetach = await ArtifactModule.sendDetach(
                    targetSlotConfig.heroId,
                    liveArtifactState.pearlId,
                    liveArtifactState.artifactId,
                );
                if (!didDetach) {
                    throw new Error(
                        "卸下武将 " + targetSlotConfig.heroId + " 的鱼灵失败",
                    );
                }
            }
            if (targetArtifactId > 0) {
                const latestRole = ServerData.ROLE;
                const currentArtifactOwnerHeroId = findArtifactOwnerHeroId(
                    latestRole,
                    targetArtifactId,
                    targetPearlId,
                );
                const didAttach = await ArtifactModule.sendAttach(
                    targetSlotConfig.heroId,
                    targetArtifactId,
                    targetPearlId,
                    currentArtifactOwnerHeroId !== -1 &&
                        currentArtifactOwnerHeroId !== targetSlotConfig.heroId
                        ? currentArtifactOwnerHeroId
                        : -1,
                );
                if (!didAttach) {
                    throw new Error(
                        "武将 " + targetSlotConfig.heroId + " 穿戴目标鱼灵失败",
                    );
                }
            }
        }
    }
    async function applyPearlSkillConfig(targetSlotConfig) {
        const ServerData = window.__require("ServerData");
        const Configs = window.__require("Configs");
        const PearlModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.PEARL_SYSTEM);
        if (!targetSlotConfig || !targetSlotConfig.heroId) {
            return;
        }
        const targetPearlId = toNumber(targetSlotConfig.pearlId, 0);
        const targetPearlSkillId = toNumber(targetSlotConfig.pearlSkillId, 0);
        const liveHero = findLiveHeroBySlotConfig(ServerData.ROLE, targetSlotConfig);
        const liveArtifactState = getHeroArtifactStateFromHero(
            ServerData.ROLE,
            liveHero,
        );
        if (targetPearlId <= 0 || liveArtifactState.pearlId <= 0) {
            return;
        }
        if (
            targetPearlSkillId > 0 &&
            liveArtifactState.pearlSkillId !== targetPearlSkillId
        ) {
            console.log(
                "[鱼珠] 武将 " +
                    targetSlotConfig.heroId +
                    " 执行单向装上鱼珠技能: 当前=" +
                    liveArtifactState.pearlSkillId +
                    " -> 目标=" +
                    targetPearlSkillId,
            );
            const replaceResult = await PearlModule.sendReplaceSkill(
                liveArtifactState.pearlId,
                targetPearlSkillId,
            );
            if (!replaceResult) {
                throw new Error(
                    "武将 " + targetSlotConfig.heroId + " 切换鱼珠技能失败",
                );
            }
            await waitForPearlRuntimeRefresh();
            return;
        }
        if (targetPearlSkillId <= 0 && liveArtifactState.pearlSkillId > 0) {
            console.log(
                "[鱼珠] 武将 " +
                    targetSlotConfig.heroId +
                    " 执行单向卸下鱼珠技能: 当前=" +
                    liveArtifactState.pearlSkillId,
            );
            const didUnload = await PearlModule.sendUnLoadSkill(
                liveArtifactState.pearlId,
            );
            if (!didUnload) {
                throw new Error(
                    "武将 " + targetSlotConfig.heroId + " 卸下鱼珠失败",
                );
            }
            await waitForPearlRuntimeRefresh();
        }
    }
    function findCurrentEnchantSourceByUid(sourceUid) {
        return buildLiveEnchantSources(window.__require("ServerData").ROLE).find(
            (source) => source.sourceUid === sourceUid,
        );
    }
    function findCurrentEnchantSourceByTargetUid(targetUid) {
        const normalizedTargetUid = toNumber(targetUid, 0);
        if (!normalizedTargetUid) {
            return null;
        }
        const role = window.__require("ServerData").ROLE;
        return buildLiveEnchantSources(role).find(
            (source) =>
                toNumber(getCollectionValue(role.enchantMap, source.sourceUid), 0) ===
                normalizedTargetUid,
        );
    }
    function findBestEnchantSource(targetSource) {
        const sources = buildLiveEnchantSources(window.__require("ServerData").ROLE);
        if (!targetSource) {
            return null;
        }
        const targetUid = toNumber(targetSource.sourceUid, 0);
        if (targetUid > 0) {
            const exactSource = sources.find(
                (source) => source.sourceUid === targetUid,
            );
            if (exactSource) {
                return exactSource;
            }
        }
        const targetPart = toNumber(
            targetSource.part,
            toNumber(targetSource.equipIndex, 0) + 1,
        );
        const targetFingerprint =
            targetSource.sourceFingerprint ||
            buildEquipmentFingerprint(
                buildSinglePartEquipmentState(
                    targetSource.sourceEquipment,
                    targetPart,
                ),
            );
        const scoredSources = sources
            .filter(
                (source) =>
                    source.part === targetPart &&
                    source.sourceSide === targetSource.sourceSide,
            )
            .map((source) => ({
                source,
                confidence: scoreEquipmentFingerprint(
                    targetFingerprint,
                    source.sourceFingerprint,
                ),
            }))
            .sort((left, right) => right.confidence - left.confidence);
        const best = scoredSources[0];
        if (!best || best.confidence < 0.55) {
            console.log("[赐福] 未找到足够可信的赐福源", {
                targetPart,
                confidence: best ? roundFingerprintConfidence(best.confidence) : 0,
            });
            return null;
        }
        return best.source;
    }
    function findBestEnchantTargetHeroId(link, targetTeamConfig) {
        if (link && toNumber(link.targetHeroId, 0) > 0) {
            return toNumber(link.targetHeroId, 0);
        }
        const targetSlotIndex = toNumber(link && link.targetSlotIndex, -1);
        if (
            targetSlotIndex >= 0 &&
            targetTeamConfig[targetSlotIndex] &&
            toNumber(targetTeamConfig[targetSlotIndex].heroId, 0) > 0
        ) {
            return toNumber(targetTeamConfig[targetSlotIndex].heroId, 0);
        }
        if (link && link.targetTeamFingerprint) {
            let best = null;
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const targetSlotConfig = targetTeamConfig[slotIndex];
                if (!targetSlotConfig || !targetSlotConfig.equipment) {
                    continue;
                }
                const confidence = scoreEquipmentFingerprint(
                    link.targetTeamFingerprint,
                    buildEquipmentFingerprint(targetSlotConfig.equipment),
                );
                if (!best || confidence > best.confidence) {
                    best = {
                        heroId: toNumber(targetSlotConfig.heroId, 0),
                        confidence,
                    };
                }
            }
            if (best && best.confidence >= 0.55) {
                return best.heroId;
            }
        }
        return 0;
    }
    async function cancelEnchantBySource(source) {
        if (!source || source.sourceUid <= 0) {
            return true;
        }
        const EquipmentService = window.__require("data-index").EquipmentService;
        const result = await EquipmentService.cancelEnchant({
            heroId: source.heroId,
            part: source.part,
            enchantUId: source.sourceUid,
        });
        return Number(result.code) === 0;
    }
    async function applyEnchantBySource(source, targetHeroId) {
        if (!source || !targetHeroId) {
            return false;
        }
        const normalizedSource = normalizeEquipmentEnchantSourceState(
            source,
            source.sourceUid,
        );
        const EquipmentService = window.__require("data-index").EquipmentService;
        const params = {
            oriHeroId: normalizedSource.heroId,
            oriPart: normalizedSource.part,
            tarHeroId: targetHeroId,
            oriQuenchId: normalizedSource.quenchId,
        };
        const result = await EquipmentService.enchant(params);
        if (Number(result.code) !== 0) {
            console.log("[赐福] 装备赐福调用失败", {
                params,
                result,
                source,
            });
            return false;
        }
        return true;
    }
    function refreshEnchantUiState() {
        try {
            const Configs = window.__require("Configs");
            const EquipmentModule = window
                .__require("ModuleManager")
                .GET_MODULE(Configs.ModuleType.EQUIP);
            const HeroModule = window
                .__require("ModuleManager")
                .GET_MODULE(Configs.ModuleType.HERO);
            const GlobalSignal = window.__require("GlobalSignal").GlobalSignal;
            if (
                EquipmentModule &&
                EquipmentModule.equipEnchantData &&
                typeof EquipmentModule.equipEnchantData.rebuildEnchantSourceList ===
                    "function"
            ) {
                EquipmentModule.equipEnchantData.rebuildEnchantSourceList();
            }
            if (HeroModule) {
                HeroModule.isBattleTeamEnchantChanged = true;
            }
            if (GlobalSignal) {
                if (GlobalSignal.FixHeroEquipments) {
                    GlobalSignal.FixHeroEquipments.dispatch();
                }
                if (GlobalSignal.EventRefreshEnchantUI) {
                    GlobalSignal.EventRefreshEnchantUI.dispatch();
                }
            }
        } catch (error) {
            console.log("[赐福] 刷新赐福状态失败:", error);
        }
    }
    async function applyEquipmentEnchantConfig(equipmentEnchantConfig, targetTeamConfig) {
        const links = getEquipmentEnchantLinks(
            equipmentEnchantConfig,
            targetTeamConfig,
        );
        if (!links.length) {
            return;
        }
        const targetPairs = links
            .map((link) => ({
                link,
                source: findBestEnchantSource(link.source),
                targetHeroId: findBestEnchantTargetHeroId(link, targetTeamConfig),
                targetSlotIndex: toNumber(link && link.targetSlotIndex, -1),
                targetPart: toNumber(
                    link && link.targetPart,
                    toNumber(link && link.source && link.source.part, 0),
                ),
                targetSide: (link && link.targetSide) || "current",
                targetUid: toNumber(link.targetUid, 0),
            }))
            .filter((pair) => pair.source && pair.targetHeroId);
        if (!targetPairs.length) {
            return;
        }
        const role = window.__require("ServerData").ROLE;
        for (const pair of targetPairs) {
            const liveSource = findCurrentEnchantSourceByUid(pair.source.sourceUid);
            const source = liveSource || pair.source;
            const mappedTargetUid = toNumber(
                getCollectionValue(
                    role.enchantMap,
                    source.sourceUid,
                ),
                0,
            );
            const targetSlotConfig =
                pair.targetSlotIndex >= 0
                    ? targetTeamConfig[pair.targetSlotIndex]
                    : null;
            const targetHero = targetSlotConfig
                ? resolveLiveHeroForTargetSlot(role, targetSlotConfig) ||
                  role.getHeroById(pair.targetHeroId)
                : role.getHeroById(pair.targetHeroId);
            const targetPartData = targetHero
                ? getEquipmentData(targetHero, pair.targetPart || source.part)
                : null;
            const expectedTargetUid = getEquipmentPartPreferredEnchantTargetUid(
                targetPartData,
                pair.targetSide,
                pair.targetUid,
            );
            if (!expectedTargetUid) {
                continue;
            }
            if (mappedTargetUid && mappedTargetUid === expectedTargetUid) {
                continue;
            }
            const occupiedSource =
                findCurrentEnchantSourceByTargetUid(expectedTargetUid);
            if (occupiedSource && occupiedSource.sourceUid !== source.sourceUid) {
                const didCancel = await cancelEnchantBySource(occupiedSource);
                if (!didCancel) {
                    throw new Error(
                        "reset equipment enchant failed: " +
                            occupiedSource.sourceUid,
                    );
                }
            }
            if (mappedTargetUid && mappedTargetUid !== expectedTargetUid) {
                const didCancel = await cancelEnchantBySource(source);
                if (!didCancel) {
                    throw new Error("重置装备赐福失败: " + source.sourceUid);
                }
            }
            const didEnchant = await applyEnchantBySource(source, pair.targetHeroId);
            if (!didEnchant) {
                throw new Error(
                    "装备赐福失败: " +
                        source.sourceUid +
                        " -> " +
                        pair.targetHeroId,
                );
            }
        }
        refreshEnchantUiState();
    }
    function findBestPetSlot(targetPet) {
        const rolePet = getRolePetData();
        if (!rolePet || !targetPet || !toNumber(targetPet.petId, 0)) {
            return 0;
        }
        const targetUid = String(targetPet.uId || "");
        if (targetUid) {
            const exactSlot = getPetSlotByUid(rolePet, targetUid);
            if (exactSlot) {
                return exactSlot;
            }
        }
        let best = null;
        if (rolePet.pets && typeof rolePet.pets.forEach === "function") {
            rolePet.pets.forEach((pet, slot) => {
                if (!pet || slot === -1) {
                    return;
                }
                const livePet = clonePetState(pet, slot);
                const confidence = scorePetSnapshot(targetPet, livePet);
                if (!best || confidence > best.confidence) {
                    best = {
                        slot: toNumber(slot, 0),
                        confidence,
                    };
                }
            });
        }
        if (!best || best.confidence < 0.55) {
            console.log("[宠物] 未找到足够可信的宠物", {
                petId: toNumber(targetPet.petId, 0),
                confidence: best ? roundFingerprintConfidence(best.confidence) : 0,
            });
            return 0;
        }
        return best.slot;
    }
    async function applyPetConfig(targetPet) {
        if (!targetPet || !toNumber(targetPet.petId, 0)) {
            return;
        }
        const rolePet = getRolePetData();
        if (!rolePet) {
            throw new Error("宠物切换失败：当前运行时没有宠物数据");
        }
        const currentPet = getPetBySlotOrUid(rolePet, -1);
        if (
            currentPet &&
            ((targetPet.uId && currentPet.uId === targetPet.uId) ||
                (!targetPet.uId &&
                    toNumber(currentPet.petId, 0) === toNumber(targetPet.petId, 0)))
        ) {
            return;
        }
        const targetSlot = findBestPetSlot(targetPet);
        if (!targetSlot) {
            throw new Error("宠物切换失败：未找到匹配的宠物");
        }
        const targetLivePet = getPetBySlotOrUid(rolePet, targetSlot);
        const PetService = window.__require("data-index").PetService;
        const result = await PetService.load({
            slotUId: {
                slot: targetSlot,
                uId: targetLivePet ? targetLivePet.uId : targetPet.uId,
            },
        });
        if (Number(result.code) !== 0 || result.error) {
            throw new Error(
                "宠物切换失败: " + (result.error || Number(result.code)),
            );
        }
        let verifiedPet = null;
        for (let attempt = 0; attempt < 20; attempt++) {
            const refreshedRolePet = getRolePetData();
            verifiedPet = getPetBySlotOrUid(refreshedRolePet, -1);
            if (
                verifiedPet &&
                ((targetPet.uId && verifiedPet.uId === targetPet.uId) ||
                    (!targetPet.uId &&
                        toNumber(verifiedPet.petId, 0) ===
                            toNumber(targetPet.petId, 0)))
            ) {
                break;
            }
            verifiedPet = null;
            await sleep(100);
        }
        if (!verifiedPet) {
            throw new Error("宠物切换后状态校验失败");
        }
        try {
            const GlobalSignal = window.__require("GlobalSignal").GlobalSignal;
            if (GlobalSignal.LevelBattleReset) {
                GlobalSignal.LevelBattleReset.emit();
            }
            if (GlobalSignal.EventPetBoardLoadChanged) {
                GlobalSignal.EventPetBoardLoadChanged.emit(targetSlot, -1);
            }
        } catch (error) {
            console.log("[宠物] 宠物刷新信号触发失败:", error);
        }
    }
    async function applyQuenchFlipConfig(targetSlotConfig) {
        const ServerData = window.__require("ServerData");
        const Configs = window.__require("Configs");
        const EquipmentModule = window
            .__require("ModuleManager")
            .GET_MODULE(Configs.ModuleType.EQUIP);
        const targetEquipment = targetSlotConfig.equipment;
        if (!targetSlotConfig || !targetSlotConfig.heroId || !targetEquipment) {
            return;
        }
        const currentHero = resolveLiveHeroForTargetSlot(
            ServerData.ROLE,
            targetSlotConfig,
        );
        if (!currentHero) {
            throw new Error("武将 " + targetSlotConfig.heroId + " 不存在");
        }
        assertHeroEquipmentMatchesTarget(
            targetSlotConfig,
            currentHero,
            "洗练翻面前",
            0.68,
        );
        for (let part = 1; part <= 4; part++) {
            const targetEquipmentData = targetEquipment[part];
            if (!targetEquipmentData) {
                continue;
            }
            const liveHeroForPart = resolveLiveHeroForTargetSlot(
                ServerData.ROLE,
                targetSlotConfig,
            );
            let currentEquipmentData = getEquipmentData(liveHeroForPart, part);
            if (!currentEquipmentData) {
                await waitForEquipmentRuntimeRefresh();
                currentEquipmentData = getEquipmentData(
                    resolveLiveHeroForTargetSlot(ServerData.ROLE, targetSlotConfig),
                    part,
                );
            }
            const targetCurQuenchId = toNumber(
                targetEquipmentData.curQuenchId,
                0,
            );
            const currentCurQuenchId = getEquipmentPartCurQuenchId(currentEquipmentData);
            const currentReverseQuenchId = getEquipmentPartReverseQuenchId(currentEquipmentData);
            const reverseQuenchKnown = hasEquipmentPartField(
                currentEquipmentData,
                "reverseQuenchId",
            );
            if (currentCurQuenchId === targetCurQuenchId) {
                continue;
            }
            const canAttemptBlindFlip =
                currentCurQuenchId === 0 && currentReverseQuenchId === 0;
            if (
                reverseQuenchKnown &&
                currentReverseQuenchId !== targetCurQuenchId &&
                !canAttemptBlindFlip
            ) {
                throw new Error(
                    "武将 " +
                        targetSlotConfig.heroId +
                        " 部位 " +
                        part +
                        " 当前装备洗练面与保存数据不匹配(当前=" +
                        currentCurQuenchId +
                        ", 反面=" +
                        currentReverseQuenchId +
                        ", 目标=" +
                        targetCurQuenchId +
                        ", uid=" +
                        getHeroUid(liveHeroForPart) +
                        ")",
                );
            }
            if (!reverseQuenchKnown || canAttemptBlindFlip) {
                console.log(
                    "[装备] 武将 " +
                        targetSlotConfig.heroId +
                        " 部位 " +
                        part +
                        " 未确认反面洗练 ID，尝试直接翻面恢复: 当前=" +
                        currentCurQuenchId +
                        ", 反面=" +
                        currentReverseQuenchId +
                        ", 目标=" +
                        targetCurQuenchId,
                );
            }
            const flipHeroId = toNumber(
                liveHeroForPart && liveHeroForPart.heroId,
                targetSlotConfig.heroId,
            );
            await cancelEquipmentPartEnchantRelations(
                ServerData.ROLE,
                liveHeroForPart,
                currentEquipmentData,
                part,
            );
            const flipResult = await quenchFlipWithRetry(
                EquipmentModule,
                flipHeroId,
                part,
            );
            if (!flipResult) {
                throw new Error(
                    "武将 " +
                        targetSlotConfig.heroId +
                        " 部位 " +
                        part +
                        " 洗练翻面失败(当前=" +
                        currentCurQuenchId +
                        ", 反面=" +
                        currentReverseQuenchId +
                        ", 目标=" +
                        targetCurQuenchId +
                        ", uid=" +
                        getHeroUid(liveHeroForPart) +
                        ", liveHeroId=" +
                        flipHeroId +
                        ")",
                );
            }
            await waitForEquipmentRuntimeRefresh();
            let refreshedHero = resolveLiveHeroForTargetSlot(
                ServerData.ROLE,
                targetSlotConfig,
            );
            let refreshedEquipmentData = getEquipmentData(
                refreshedHero,
                part,
            );
            let refreshedCurQuenchId = getEquipmentPartCurQuenchId(refreshedEquipmentData);
            if (refreshedCurQuenchId !== targetCurQuenchId) {
                await waitForEquipmentRuntimeRefresh();
                refreshedHero = resolveLiveHeroForTargetSlot(
                    ServerData.ROLE,
                    targetSlotConfig,
                );
                refreshedEquipmentData = getEquipmentData(refreshedHero, part);
                refreshedCurQuenchId = getEquipmentPartCurQuenchId(refreshedEquipmentData);
            }
            if (
                refreshedCurQuenchId !== targetCurQuenchId
            ) {
                throw new Error(
                    "武将 " +
                        targetSlotConfig.heroId +
                        " 部位 " +
                        part +
                        " 洗练翻面后状态校验失败(当前=" +
                        refreshedCurQuenchId +
                        ", 目标=" +
                        targetCurQuenchId +
                        ", uid=" +
                        getHeroUid(refreshedHero) +
                        ")",
                );
            }
        }
    }
    async function applyTrumpFlipConfig(targetSlotConfig) {
        const ServerData = window.__require("ServerData");
        const TrumpService = window.__require("data-index").TrumpService;
        const targetHeroId = toNumber(
            targetSlotConfig ? targetSlotConfig.heroId : 0,
            0,
        );
        if (!targetSlotConfig) {
            return;
        }
        if (!targetHeroId) {
            return;
        }
        const currentHero = resolveLiveHeroForTargetSlot(
            ServerData.ROLE,
            targetSlotConfig,
        );
        if (!currentHero) {
            throw new Error("武将 " + targetHeroId + " 不存在");
        }
        const targetTrumpState = targetSlotConfig.trump || {};
        const targetTrumpId = firstPositiveNumber(
            targetSlotConfig.trumpId,
            targetTrumpState.trumpId,
            targetTrumpState.activeId,
            targetSlotConfig.curTrump,
        );
        if (!targetTrumpId) {
            return;
        }
        const currentTrumpState = getHeroTrumpState(currentHero);
        if (currentTrumpState.trumpId === targetTrumpId) {
            return;
        }
        if (currentTrumpState.trumpId2 !== targetTrumpId) {
            throw new Error(
                "武将 " +
                    targetHeroId +
                    " 梦魇水晶目标面不存在(当前=" +
                    currentTrumpState.trumpId +
                    ", 反面=" +
                    currentTrumpState.trumpId2 +
                    ", 目标=" +
                    targetTrumpId +
                    ")",
            );
        }
        console.log(
            "[梦魇水晶] 武将 " +
                targetHeroId +
                " 执行翻面修正: 当前=" +
                currentTrumpState.trumpId +
                " -> 目标=" +
                targetTrumpId,
        );
        const changeResult = await TrumpService.change({
            heroId: targetHeroId,
        });
        if (Number(changeResult.code) !== 0) {
            throw new Error(
                "武将 " +
                    targetHeroId +
                    " 梦魇水晶翻面失败: " +
                    Number(changeResult.code),
            );
        }
        await waitForEquipmentRuntimeRefresh();
        const refreshedHero = resolveLiveHeroForTargetSlot(
            ServerData.ROLE,
            targetSlotConfig,
        );
        const refreshedTrumpState = getHeroTrumpState(refreshedHero);
        if (refreshedTrumpState.trumpId !== targetTrumpId) {
            throw new Error(
                "武将 " +
                    targetHeroId +
                    " 梦魇水晶翻面后状态校验失败(当前=" +
                    refreshedTrumpState.trumpId +
                    ", 目标=" +
                    targetTrumpId +
                    ")",
            );
        }
    }
    function mountLineupPanel() {
        try {
            window.__xbInfiniteLineupStatus = "mounting";
        } catch (error) {}
        initializeSavedConfigsStorage();
        if (document.getElementById("lineup-wrapper")) {
            try {
                window.__xbInfiniteLineupStatus = "mounted";
            } catch (error) {}
            return;
        }

        ensureLineupScrollbarStyle();
        const panelWrapper = createDomNode("div", {
            id: "lineup-wrapper",
            cssText: `
                position: fixed;
                inset: 0;
                z-index: 2147483000;
                pointer-events: none;
                overflow: visible;
            `,
        });
        const panel = createDomNode("div", {
            id: "lineup-panel",
            cssText: LINEUP_UI_STYLE.panel,
        });
        const openerButton = createDomNode("button", {
            id: "lineup-opener",
            html: `<span style="font-size:18px;line-height:1;display:inline-block;filter:drop-shadow(0 0 3px rgba(251,191,36,0.7));pointer-events:none;">♾️</span>`,
            title: "无限阵容 (点击展开/悬停弹出/吸附贴边)",
            cssText: LINEUP_UI_STYLE.openerButton,
        });
        const isPanelVisible = () => panel.style.display !== "none";
        const setPanelVisible = (isVisible) => {
            if (isVisible) {
                openerButton.style.display = "none"; // 展开面板时优雅隐藏把手，避免遮挡标题
                panel.style.visibility = "hidden";
                panel.style.display = "flex";
                updatePresetSlotButtons();
                renderSavedConfigs();
                syncLineupPanelPosition(openerButton, panel);
                panel.style.visibility = "visible";
                queueSyncLineupPanelPosition(openerButton, panel);
                refreshLineupRoleInfo().then(() => {
                    if (!isPanelVisible()) {
                        return;
                    }
                    updatePresetSlotButtons();
                    renderSavedConfigs();
                });
                return;
            }
            openerButton.style.display = "flex"; // 关闭面板时恢复显示把手
            openerButton.style.background = "linear-gradient(135deg, rgba(30, 41, 59, 0.92) 0%, rgba(15, 23, 42, 0.96) 100%)";
            openerButton.style.boxShadow = "0 4px 16px rgba(0, 0, 0, 0.35), 0 0 12px rgba(251, 191, 36, 0.25)";
            panel.style.display = "none";
            panel.style.visibility = "hidden";
        };
        const togglePanelVisible = () => {
            setPanelVisible(!isPanelVisible());
        };
        applyLineupOpenerPosition(
            openerButton,
            readLineupOpenerPosition(openerButton) || { left: 0, top: 70 },
        );
        bindDraggableLineupOpener(openerButton, () => {
            if (isPanelVisible()) {
                syncLineupPanelPosition(openerButton, panel);
            }
        });

        // 点击事件
        openerButton.addEventListener("click", (event) => {
            if (lineupRuntimeState.suppressNextOpenerClick) {
                lineupRuntimeState.suppressNextOpenerClick = false;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            togglePanelVisible();
        });
        const panelHeader = createDomNode("div", {
            cssText: LINEUP_UI_STYLE.panelHeader,
        });
        const panelTitle = createDomNode("div", {
            html: `<span style="-webkit-text-fill-color: initial; -webkit-background-clip: initial; font-size: 16px; margin-right: 2px; filter: drop-shadow(0 1px 2px rgba(99,102,241,0.3));">♾️</span><span>无限阵容</span><span style="font-size:10px;background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff;padding:1px 6px;border-radius:4px;font-weight:800;letter-spacing:0.5px;box-shadow:0 1px 3px rgba(245,158,11,0.3);margin-left:4px;display:inline-block;line-height:1.2;-webkit-text-fill-color: #ffffff;">PRO</span>`,
            cssText: LINEUP_UI_STYLE.panelTitle + "; white-space: nowrap; flex-shrink: 0;",
        });
        const panelTitleGroup = createDomNode("div", {
            cssText: `
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
            `,
        });

        let activeTab = "lineup"; // "lineup" | "merge" | "cloud"
        let diffContainer = null;
        let refreshDiffView = () => {};
        let sevenColorContainer = null;
        let refreshSevenColorInlineView = () => {};

        const tabBar = createDomNode("div", {
            cssText: `
                display: flex;
                align-items: center;
                background: #f1f5f9;
                padding: 3px;
                border-radius: 9px;
                border: 1px solid #e2e8f0;
                gap: 3px;
                width: 100%;
                box-sizing: border-box;
                margin-bottom: 2px;
            `,
        });

        const tabBtnBaseStyle = `
            flex: 1;
            height: 28px;
            padding: 0 4px;
            border-radius: 7px;
            border: none;
            font-size: 11.5px;
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.15s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 3px;
        `;

        const tabLineupBtn = createDomNode("button", {
            text: "📋 阵容列表",
            title: "切换到主线阵容列表",
            cssText: tabBtnBaseStyle + `
                background: #ffffff;
                color: #0f172a;
                font-weight: 700;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
            `,
            events: {
                onclick: () => switchTab("lineup"),
            },
        });
        const tabMergeBtn = createDomNode("button", {
            text: "🔀 差异合并",
            title: "比对本地与七彩云端阵容差异，支持双向同名覆盖与智能合并",
            cssText: tabBtnBaseStyle + `
                background: transparent;
                color: #64748b;
                font-weight: 600;
            `,
            events: {
                onclick: () => switchTab("merge"),
            },
        });
        const tabCloudBtn = createDomNode("button", {
            text: "⚙️ 云端设置",
            title: "七彩云 S3 对象存储配置与接入参数",
            cssText: tabBtnBaseStyle + `
                background: transparent;
                color: #64748b;
                font-weight: 600;
            `,
            events: {
                onclick: () => switchTab("cloud"),
            },
        });
        appendChildren(tabBar, tabLineupBtn, tabMergeBtn, tabCloudBtn);

        const updateTabButtonStyles = (activeKey) => {
            const tabs = [
                { key: "lineup", btn: tabLineupBtn },
                { key: "merge", btn: tabMergeBtn },
                { key: "cloud", btn: tabCloudBtn },
            ];
            tabs.forEach(({ key, btn }) => {
                if (key === activeKey) {
                    btn.style.background = (key === "merge" || key === "cloud")
                        ? "linear-gradient(135deg, #8b5cf6, #6366f1)"
                        : "#ffffff";
                    btn.style.color = (key === "merge" || key === "cloud") ? "#ffffff" : "#0f172a";
                    btn.style.fontWeight = "700";
                    btn.style.boxShadow = (key === "merge" || key === "cloud")
                        ? "0 2px 6px rgba(99, 102, 241, 0.35)"
                        : "0 1px 3px rgba(0, 0, 0, 0.08)";
                } else {
                    btn.style.background = "transparent";
                    btn.style.color = "#64748b";
                    btn.style.fontWeight = "600";
                    btn.style.boxShadow = "none";
                }
            });
        };

        const switchTab = (tabName) => {
            activeTab = tabName;
            updateTabButtonStyles(activeTab);

            if (activeTab === "lineup") {
                headerActionRow.style.display = "flex";
                if (typeof groupFilterBar !== "undefined") groupFilterBar.style.display = "flex";
                configList.style.display = "block";
                if (diffContainer) diffContainer.style.display = "none";
                if (sevenColorContainer) sevenColorContainer.style.display = "none";
                renderSavedConfigs();
            } else if (activeTab === "merge") {
                headerActionRow.style.display = "none";
                if (typeof groupFilterBar !== "undefined") groupFilterBar.style.display = "none";
                configList.style.display = "none";
                if (sevenColorContainer) sevenColorContainer.style.display = "none";
                if (diffContainer) {
                    diffContainer.style.display = "flex";
                }
                if (typeof refreshDiffView === "function") {
                    refreshDiffView();
                }
            } else if (activeTab === "cloud") {
                headerActionRow.style.display = "none";
                if (typeof groupFilterBar !== "undefined") groupFilterBar.style.display = "none";
                configList.style.display = "none";
                if (diffContainer) diffContainer.style.display = "none";
                if (sevenColorContainer) {
                    sevenColorContainer.style.display = "flex";
                }
                if (typeof refreshSevenColorInlineView === "function") {
                    refreshSevenColorInlineView();
                }
            }
            queueSyncLineupPanelPosition(openerButton, panel);
        };
        const headerRightTools = createDomNode("div", {
            cssText: `
                display: flex;
                align-items: center;
                gap: 6px;
                flex-shrink: 0;
            `,
        });
        const headerActionRow = createDomNode("div", {
            cssText: `
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
                margin-bottom: 8px;
            `,
        });
        const presetSlotBar = createDomNode("div", {
            cssText: `
                display: flex;
                align-items: center;
                gap: 4px;
                flex-wrap: wrap;
            `,
        });
        const headerButtons = createDomNode("div", {
            cssText: `
                display: flex;
                align-items: center;
                gap: 6px;
                width: 100%;
                box-sizing: border-box;
            `,
        });
        const refreshButton = createDomNode("button", {
            html: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`,
            title: "刷新阵容列表",
            cssText: `
                width: 26px;
                height: 26px;
                border-radius: 50%;
                background: #f1f5f9;
                color: #64748b;
                border: 1px solid #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                padding: 0;
                transition: all 0.15s ease;
            `,
            events: {
                onclick: () => {
                    setStatusText("正在刷新...");
                    renderSavedConfigs();
                    setStatusText("刷新成功!", ["成功"]);
                },
            },
        });
        const saveButtonHeader = createDomNode("button", {
            text: "💾 保存当前",
            title: "保存当前出战阵容到无限阵容库",
            cssText: `
                flex: 1.4;
                height: 28px;
                border-radius: 8px;
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: #ffffff;
                border: none;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                padding: 0 8px;
                font-size: 12px;
                font-weight: 700;
                white-space: nowrap;
                box-shadow: 0 2px 6px rgba(16, 185, 129, 0.28);
                transition: all 0.15s ease;
            `,
            events: {
                onclick: async () => {
                    if (lineupRuntimeState.isSaving) {
                        setStatusText("已有保存操作正在进行，请稍候", ["保存"]);
                        return;
                    }
                    if (lineupRuntimeState.isSwitching) {
                        setStatusText("阵容正在切换，请稍候再保存", ["切换"]);
                        return;
                    }
                    const initialConfigs = readSavedConfigs();
                    const defaultName = `阵容${initialConfigs.length + 1}`;
                    openSaveLineupDialog(defaultName, currentSelectedSaveGroup || "PVP");
                },
            },
        });
        // 阵容差异比对计算引擎
function computeLineupDiff(localConfigs = [], cloudConfigs = []) {
    const localActive = (localConfigs || []).filter(c => c && !c.deleted && (c.team || c.formation || c.research));
    const cloudActive = (cloudConfigs || []).filter(c => c && !c.deleted && (c.team || c.formation || c.research));

    const localMapByName = new Map();
    const localUsed = new Set();
    localActive.forEach((item, idx) => {
        const key = (item.name || "").trim() || `__unnamed_id_${item.id || idx}`;
        localMapByName.set(key, { item, idx });
    });

    const diffResults = [];

    // 1. 遍历云端，寻找同名匹配
    cloudActive.forEach((cloudItem, cloudIdx) => {
        const key = (cloudItem.name || "").trim() || `__unnamed_id_${cloudItem.id || cloudIdx}`;
        if (localMapByName.has(key)) {
            const { item: localItem, idx: localIdx } = localMapByName.get(key);
            localUsed.add(key);

            // 解压规范化后对比实际队伍配置
            const normLocal = normalizeSavedConfig(localItem);
            const normCloud = normalizeSavedConfig(cloudItem);
            const isIdentical = JSON.stringify(normLocal.formation || normLocal.team || {}) === JSON.stringify(normCloud.formation || normCloud.team || {}) &&
                                JSON.stringify(normLocal.research || {}) === JSON.stringify(normCloud.research || {});

            diffResults.push({
                type: isIdentical ? "same" : "conflict",
                name: (cloudItem.name || localItem.name || "未命名阵容").trim(),
                local: localItem,
                cloud: cloudItem,
                localIdx,
                cloudIdx,
            });
        } else {
            // 云端独有
            diffResults.push({
                type: "cloud_only",
                name: (cloudItem.name || "未命名阵容").trim(),
                local: null,
                cloud: cloudItem,
                localIdx: -1,
                cloudIdx,
            });
        }
    });

    // 2. 本地独有
    localActive.forEach((localItem, localIdx) => {
        const key = (localItem.name || "").trim() || `__unnamed_id_${localItem.id || localIdx}`;
        if (!localUsed.has(key)) {
            diffResults.push({
                type: "local_only",
                name: (localItem.name || "未命名阵容").trim(),
                local: localItem,
                cloud: null,
                localIdx,
                cloudIdx: -1,
            });
        }
    });

    // 排序：冲突排第一，独有排第二，一致排最后
    const priority = { conflict: 1, local_only: 2, cloud_only: 3, same: 4 };
    diffResults.sort((a, b) => (priority[a.type] || 99) - (priority[b.type] || 99));

    return {
        items: diffResults,
        conflictCount: diffResults.filter(r => r.type === "conflict").length,
        localOnlyCount: diffResults.filter(r => r.type === "local_only").length,
        cloudOnlyCount: diffResults.filter(r => r.type === "cloud_only").length,
        sameCount: diffResults.filter(r => r.type === "same").length,
        totalLocal: localActive.length,
        totalCloud: cloudActive.length,
    };
}

// 差异合并视图组件
function createLineupDiffInlineView() {
    let isWorking = false;

    const container = createDomNode("div", {
        cssText: `
            display: none;
            flex-direction: column;
            gap: 10px;
            font-size: 13px;
            box-sizing: border-box;
            width: 100%;
            max-height: min(62vh, 520px);
            overflow-y: auto;
            overflow-x: hidden;
            -webkit-overflow-scrolling: touch;
            overscroll-behavior: contain;
            touch-action: pan-y;
            padding-right: 4px;
            padding-bottom: 16px;
            scrollbar-width: thin;
            scrollbar-color: #cbd5e1 transparent;
        `,
    });
    container.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    container.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });

    // 1. 顶部操作栏
    const topBar = createDomNode("div", {
        cssText: `
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: linear-gradient(135deg, #f8fafc, #f1f5f9);
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            padding: 8px 10px;
            flex-wrap: wrap;
            gap: 6px;
        `,
    });

    const summaryText = createDomNode("div", {
        html: '<span style="color:#64748b;font-size:12px;">正在比对本地与云端阵容...</span>',
        cssText: "font-weight: 600; font-size: 12px; color: #334155;",
    });

    const toolBtnRow = createDomNode("div", {
        cssText: "display: flex; align-items: center; gap: 6px;",
    });

    const refreshDiffBtn = createDomNode("button", {
        text: "🔄 刷新比对",
        title: "重新拉取七彩云端数据并比对差异",
        cssText: `
            height: 24px;
            padding: 0 8px;
            border-radius: 6px;
            border: 1px solid #cbd5e1;
            background: #ffffff;
            color: #334155;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
        `,
        events: {
            onclick: () => loadAndRenderDiff(),
        },
    });

    appendChildren(toolBtnRow, refreshDiffBtn);
    appendChildren(topBar, summaryText, toolBtnRow);

    // 全量快捷动作栏
    const bulkActionRow = createDomNode("div", {
        cssText: "display: flex; gap: 6px; width: 100%; box-sizing: border-box;",
    });
    const bulkUploadBtn = createDomNode("button", {
        text: "⬆️ 本地覆盖云端 (全部)",
        title: "将当前本地的所有有效阵容推送到云端覆盖",
        cssText: `
            flex: 1;
            height: 26px;
            border-radius: 6px;
            border: 1px solid #ddd6fe;
            background: #f5f3ff;
            color: #6d28d9;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
            white-space: nowrap;
        `,
        events: {
            onclick: async () => {
                if (isWorking) return;
                const confirmed = confirm("确认将【本地全部有效阵容】推送到云端完全覆盖？\n云端已有的差异将被本地数据替代。");
                if (!confirmed) return;
                try {
                    isWorking = true;
                    bulkUploadBtn.disabled = true;
                    bulkUploadBtn.textContent = "⏳ 推送中...";
                    const localConfigs = readSavedConfigs();
                    await uploadLineupToSevenColor(localConfigs);
                    setStatusText("✅ 已将本地阵容完全推送到云端", ["成功"]);
                    await loadAndRenderDiff();
                } catch (e) {
                    setStatusText("❌ 推送失败：" + e.message, ["失败"]);
                } finally {
                    isWorking = false;
                    bulkUploadBtn.disabled = false;
                    bulkUploadBtn.textContent = "⬆️ 本地覆盖云端 (全部)";
                }
            },
        },
    });

    const bulkDownloadBtn = createDomNode("button", {
        text: "⬇️ 云端覆盖本地 (全部)",
        title: "从云端拉取全部阵容并直接覆盖本地",
        cssText: `
            flex: 1;
            height: 26px;
            border-radius: 6px;
            border: 1px solid #bfdbfe;
            background: #eff6ff;
            color: #1d4ed8;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
            white-space: nowrap;
        `,
        events: {
            onclick: async () => {
                if (isWorking) return;
                const confirmed = confirm("确认从云端拉取全部阵容并【完全覆盖本地】？\n本地尚未同步的改动将被云端覆盖。");
                if (!confirmed) return;
                try {
                    isWorking = true;
                    bulkDownloadBtn.disabled = true;
                    bulkDownloadBtn.textContent = "⏳ 拉取中...";
                    await syncFromCloud({ forceOverwrite: true });
                    setStatusText("✅ 已从云端完全恢复到本地", ["成功"]);
                    renderSavedConfigs();
                    await loadAndRenderDiff();
                } catch (e) {
                    setStatusText("❌ 拉取恢复失败：" + e.message, ["失败"]);
                } finally {
                    isWorking = false;
                    bulkDownloadBtn.disabled = false;
                    bulkDownloadBtn.textContent = "⬇️ 云端覆盖本地 (全部)";
                }
            },
        },
    });
    appendChildren(bulkActionRow, bulkUploadBtn, bulkDownloadBtn);

    // 比对列表卡片区
    const diffList = createDomNode("div", {
        cssText: "display: flex; flex-direction: column; gap: 8px; width: 100%;",
    });

    appendChildren(container, topBar, bulkActionRow, diffList);

    // 辅助格式化与阵容详情提取
    const formatTime = (isoStr) => {
        if (!isoStr) return "未知时间";
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return "未知时间";
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    const getDetailedLineupInfo = async (rawConfig) => {
        if (!rawConfig) return null;
        const active = normalizeSavedConfig(rawConfig);
        const teamSlots = getTeamSlots(active.team);

        const powerNum = (active.formation && active.formation.power) || active.power || 0;
        const powerText = formatPowerValue(powerNum) || "0";
        const slotId = active.teamId || (active.formation && active.formation.presetTeamId) || 0;

        // 1. 玩具 (Weapon) 解析
        const weaponId = toNumber(
            active.weaponId ||
            active.lordWeaponId ||
            (active.formation && (active.formation.lordWeaponId || active.formation.weaponId)),
            0
        );
        let weaponName = "";
        if (weaponId > 0 && typeof xyzwResourceMapper !== "undefined" && xyzwResourceMapper.resolveWeapon) {
            try {
                const weaponInfo = await xyzwResourceMapper.resolveWeapon(weaponId);
                weaponName = shortResourceName(weaponInfo, "玩具" + weaponId);
            } catch (e) {
                weaponName = "玩具" + weaponId;
            }
        }

        // 2. 武将列表、鱼灵 (Artifact)、鱼珠 (Pearl) 解析
        const heroList = await Promise.all(teamSlots.map(async ({ slotIndex, slotConfig }) => {
            const heroId = toNumber(slotConfig.heroId, 0);
            const rawName = slotConfig.name || slotConfig.nickName || ("武将" + heroId);
            // 彻底去除阶数后缀（如+5、+6），仅保留武将基础名称
            const name = String(rawName).replace(/\+\d+$/, "").trim();
            const level = toNumber(slotConfig.level, 0);

            // 鱼灵解析
            const artifactId = toNumber(slotConfig.artifactId, 0);
            let artifactName = "";
            if (artifactId > 0 && typeof xyzwResourceMapper !== "undefined" && xyzwResourceMapper.resolveArtifact) {
                try {
                    const artifactInfo = await xyzwResourceMapper.resolveArtifact(artifactId);
                    artifactName = shortResourceName(artifactInfo, "鱼灵" + artifactId);
                } catch (e) {
                    artifactName = "鱼灵" + artifactId;
                }
            }

            // 鱼珠解析
            const pearlId = toNumber(slotConfig.pearlId, 0);
            let pearlName = "";
            if (pearlId > 0 && typeof xyzwResourceMapper !== "undefined" && xyzwResourceMapper.resolvePearl) {
                try {
                    const savedAppendPearlSkillId = Array.isArray(slotConfig.appendSkill)
                        ? slotConfig.appendSkill
                              .map((skillId) => toNumber(skillId, 0))
                              .find((skillId) => skillId >= 1033007 && skillId <= 1033017)
                        : 0;
                    const pearlInfo = await xyzwResourceMapper.resolvePearl(
                        pearlId,
                        savedAppendPearlSkillId || slotConfig.pearlSkillId,
                        slotConfig.pearl,
                    );
                    pearlName = shortResourceName(pearlInfo, "鱼珠" + pearlId);
                } catch (e) {
                    pearlName = "鱼珠" + pearlId;
                }
            }

            return {
                slotIndex: slotIndex + 1,
                heroId,
                name,
                rawLevel: level,
                levelText: level > 0 ? `${level}级` : "",
                artifactId,
                artifactName,
                pearlId,
                pearlName,
            };
        }));

        const timeStr = formatTime(active.updateDate || active.createDate);
        return {
            active,
            powerText,
            slotId,
            weaponId,
            weaponName,
            heroList,
            timeStr,
        };
    };

    const isHeroMatch = (h1, h2) => {
        if (!h1 || !h2) return false;
        return (
            toNumber(h1.heroId, 0) === toNumber(h2.heroId, 0) &&
            toNumber(h1.rawLevel, 0) === toNumber(h2.rawLevel, 0) &&
            toNumber(h1.artifactId, 0) === toNumber(h2.artifactId, 0) &&
            toNumber(h1.pearlId, 0) === toNumber(h2.pearlId, 0)
        );
    };

    const renderHeroChipsHtml = (info, compareInfo = null) => {
        if (!info || !info.heroList || info.heroList.length === 0) {
            return '<div style="color:#94a3b8;font-size:11px;">(暂无武将数据)</div>';
        }
        const chips = info.heroList.map((h) => {
            let chipStyle = `
                box-sizing: border-box;
                flex: 1 1 calc(50% - 4px);
                min-width: 135px;
                padding: 4px 6px;
                border-radius: 6px;
                box-shadow: 0 1px 2px rgba(0,0,0,0.02);
                transition: all 0.15s ease;
            `;
            let badgeBg = "#eff6ff";
            let badgeColor = "#2563eb";

            if (compareInfo && compareInfo.heroList) {
                const targetHero = compareInfo.heroList.find(th => th.slotIndex === h.slotIndex);
                const matched = isHeroMatch(h, targetHero);

                if (matched) {
                    // 无差异：绿线框
                    chipStyle += `
                        background: #f0fdf4;
                        border: 1.5px solid #10b981;
                    `;
                    badgeBg = "#d1fae5";
                    badgeColor = "#047857";
                } else {
                    // 存在差异：红线框高亮
                    chipStyle += `
                        background: #fef2f2;
                        border: 1.5px solid #ef4444;
                        box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.15);
                    `;
                    badgeBg = "#fee2e2";
                    badgeColor = "#dc2626";
                }
            } else {
                // 独有或普通详情
                chipStyle += `
                    background: #ffffff;
                    border: 1px solid #cbd5e1;
                `;
            }

            const fullName = h.name;
            const tip = `站位${h.slotIndex}: ${fullName} ${h.levelText}` +
                (h.artifactName ? ` | 鱼灵: ${h.artifactName}` : '') +
                (h.pearlName ? ` | 鱼珠: ${h.pearlName}` : '');

            return `
                <div style="${chipStyle}" title="${tip}">
                    <div style="display:flex;align-items:center;gap:4px;">
                        <span style="display:inline-block;width:14px;height:14px;line-height:14px;text-align:center;border-radius:50%;background:${badgeBg};color:${badgeColor};font-size:9px;font-weight:700;flex-shrink:0;">${h.slotIndex}</span>
                        <span style="font-weight:700;font-size:11.5px;color:#0f172a;">${fullName}</span>
                        ${h.levelText ? `<span style="font-size:10px;color:#64748b;margin-left:1px;">${h.levelText}</span>` : ''}
                    </div>
                    <div style="display:flex;align-items:center;gap:3px;margin-top:2px;font-size:9.5px;">
                        <span style="display:inline-flex;align-items:center;gap:1px;padding:1px 4px;border-radius:3px;background:${h.artifactName ? '#f0f9ff' : '#f8fafc'};color:${h.artifactName ? '#0284c7' : '#94a3b8'};border:1px solid ${h.artifactName ? '#bae6fd' : '#e2e8f0'};white-space:nowrap;">
                            🐟 ${h.artifactName || '无鱼灵'}
                        </span>
                        ${h.pearlName ? `
                            <span style="display:inline-flex;align-items:center;gap:1px;padding:1px 4px;border-radius:3px;background:#faf5ff;color:#9333ea;border:1px solid #f3e8ff;white-space:nowrap;">
                                🔮 ${h.pearlName}
                            </span>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join("");

        return `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:4px;">${chips}</div>`;
    };

    // 单个武将紧凑小卡片渲染 (用于左右分栏)
    const renderSingleHeroChip = (h, matched) => {
        if (!h) {
            return `
                <div style="box-sizing:border-box;height:100%;min-height:36px;border:1px dashed #cbd5e1;border-radius:6px;background:#f8fafc;color:#94a3b8;font-size:10px;display:flex;align-items:center;justify-content:center;">
                    (空位)
                </div>
            `;
        }

        let chipStyle = `
            box-sizing: border-box;
            height: 100%;
            min-height: 36px;
            padding: 3px 6px;
            border-radius: 6px;
            transition: all 0.15s ease;
            display: flex;
            flex-direction: column;
            justify-content: center;
        `;
        let badgeBg = "#eff6ff";
        let badgeColor = "#2563eb";

        if (matched) {
            chipStyle += `
                background: #f0fdf4;
                border: 1.5px solid #10b981;
            `;
            badgeBg = "#d1fae5";
            badgeColor = "#047857";
        } else {
            chipStyle += `
                background: #fef2f2;
                border: 1.5px solid #ef4444;
                box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.15);
            `;
            badgeBg = "#fee2e2";
            badgeColor = "#dc2626";
        }

        const tip = `站位${h.slotIndex}: ${h.name} ${h.levelText}` +
            (h.artifactName ? ` | 鱼灵: ${h.artifactName}` : '') +
            (h.pearlName ? ` | 鱼珠: ${h.pearlName}` : '');

        return `
            <div style="${chipStyle}" title="${tip}">
                <div style="display:flex;align-items:center;gap:3px;overflow:hidden;white-space:nowrap;">
                    <span style="display:inline-block;width:13px;height:13px;line-height:13px;text-align:center;border-radius:50%;background:${badgeBg};color:${badgeColor};font-size:8.5px;font-weight:700;flex-shrink:0;">${h.slotIndex}</span>
                    <span style="font-weight:700;font-size:11px;color:#0f172a;overflow:hidden;text-overflow:ellipsis;">${h.name}</span>
                    ${h.levelText ? `<span style="font-size:9.5px;color:#64748b;margin-left:1px;flex-shrink:0;">${h.levelText}</span>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:2px;margin-top:2px;font-size:9px;overflow:hidden;white-space:nowrap;">
                    <span style="display:inline-flex;align-items:center;padding:0 3px;border-radius:3px;background:${h.artifactName ? '#f0f9ff' : '#f8fafc'};color:${h.artifactName ? '#0284c7' : '#94a3b8'};border:1px solid ${h.artifactName ? '#bae6fd' : '#e2e8f0'};max-width:68px;overflow:hidden;text-overflow:ellipsis;">
                        🐟${h.artifactName || '无'}
                    </span>
                    ${h.pearlName ? `
                        <span style="display:inline-flex;align-items:center;padding:0 3px;border-radius:3px;background:#faf5ff;color:#9333ea;border:1px solid #f3e8ff;max-width:62px;overflow:hidden;text-overflow:ellipsis;">
                            🔮${h.pearlName}
                        </span>
                    ` : ''}
                </div>
            </div>
        `;
    };

    // 左右分栏逐行比对 (1~5号站位平行对齐)
    const renderSideBySideHeroRows = (localInfo, cloudInfo) => {
        const slots = [1, 2, 3, 4, 5];
        return slots.map(slotIdx => {
            const localHero = (localInfo.heroList || []).find(h => h.slotIndex === slotIdx);
            const cloudHero = (cloudInfo.heroList || []).find(h => h.slotIndex === slotIdx);
            const matched = isHeroMatch(localHero, cloudHero);

            const leftHtml = renderSingleHeroChip(localHero, matched);
            const rightHtml = renderSingleHeroChip(cloudHero, matched);

            return `
                <div style="display:flex;align-items:center;gap:4px;margin-bottom:4px;">
                    <div style="flex:1;min-width:0;">${leftHtml}</div>
                    <div style="display:flex;align-items:center;justify-content:center;width:14px;flex-shrink:0;font-size:11px;font-weight:800;color:${matched ? '#10b981' : '#ef4444'};">
                        ${matched ? '＝' : '≠'}
                    </div>
                    <div style="flex:1;min-width:0;">${rightHtml}</div>
                </div>
            `;
        }).join("");
    };

    // 核心加载比对并渲染
    async function loadAndRenderDiff() {
        const cfg = getSevenColorConfig();
        if (!cfg.enabled || !cfg.bucket || !cfg.accessKey || !cfg.secretKey) {
            summaryText.innerHTML = '<span style="color:#eab308;">⚠️ 七彩云 S3 未配置完成</span>';
            diffList.innerHTML = `
                <div style="text-align:center;padding:24px 12px;background:#fffbeb;border:1px dashed #fde68a;border-radius:10px;color:#92400e;">
                    <div style="font-size:20px;margin-bottom:6px;">☁️</div>
                    <div style="font-weight:700;font-size:13px;margin-bottom:4px;">未配置七彩云 S3 对象存储</div>
                    <div style="font-size:11px;color:#b45309;margin-bottom:10px;">需配置 Endpoint、Bucket 及密钥后方可比对云端差异</div>
                    <button id="btn-goto-cloud-settings" style="height:26px;padding:0 12px;border-radius:6px;border:none;background:#8b5cf6;color:#fff;font-size:11px;font-weight:700;cursor:pointer;">👉 前往【云端设置】配置</button>
                </div>
            `;
            const gotoBtn = diffList.querySelector("#btn-goto-cloud-settings");
            if (gotoBtn) gotoBtn.onclick = () => switchTab("cloud");
            return;
        }

        summaryText.innerHTML = '<span style="color:#64748b;">⏳ 正在连接七彩云对比数据...</span>';
        diffList.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;font-size:12px;">正在从 S3 检索云端阵容数据并比对指纹...</div>';

        let localConfigs = readSavedConfigs();
        let cloudConfigs = [];

        try {
            const res = await downloadLineupFromSevenColor();
            if (res && res.ok && Array.isArray(res.configs)) {
                cloudConfigs = res.configs.filter(c => c && !c.deleted && (c.team || c.formation || c.research));
            } else if (res && res.notFound) {
                cloudConfigs = [];
            }
        } catch (err) {
            summaryText.innerHTML = `<span style="color:#ef4444;">❌ 拉取失败: ${err.message}</span>`;
            diffList.innerHTML = `<div style="text-align:center;padding:20px;color:#ef4444;font-size:12px;">无法获取云端数据: ${err.message}</div>`;
            return;
        }

        // 计算差异
        const diffData = computeLineupDiff(localConfigs, cloudConfigs);
        const { items, conflictCount, localOnlyCount, cloudOnlyCount, sameCount, totalLocal, totalCloud } = diffData;

        summaryText.innerHTML = `本地 <strong style="color:#0f172a;">${totalLocal}</strong> | 云端 <strong style="color:#6366f1;">${totalCloud}</strong> | 差异 <strong style="color:#ef4444;">${conflictCount}</strong> | 独有 <strong style="color:#f59e0b;">${localOnlyCount + cloudOnlyCount}</strong>`;

        diffList.replaceChildren();

        if (items.length === 0) {
            diffList.innerHTML = '<div style="text-align:center;padding:28px 12px;color:#94a3b8;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;">本地与云端暂无任何阵容数据</div>';
            return;
        }

        // 预热资源配置（鱼灵、鱼珠、玩具等）
        if (typeof xyzwResourceMapper !== "undefined" && xyzwResourceMapper.ensureReady) {
            await xyzwResourceMapper.ensureReady().catch(() => {});
        }

        for (const item of items) {
            const card = createDomNode("div", {
                cssText: `
                    background: #ffffff;
                    border: 1px solid ${item.type === "conflict" ? "#fca5a5" : item.type === "same" ? "#e2e8f0" : "#cbd5e1"};
                    border-radius: 10px;
                    padding: 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
                `,
            });

            // 头部：阵容名 + 状态徽章
            const headerRow = createDomNode("div", {
                cssText: "display: flex; align-items: center; justify-content: space-between;",
            });
            const nameEl = createDomNode("div", {
                text: item.name,
                cssText: "font-weight: 700; font-size: 13px; color: #0f172a;",
            });

            let badgeHtml = "";
            if (item.type === "conflict") {
                badgeHtml = '<span style="background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700;">⚠️ 存在差异</span>';
            } else if (item.type === "local_only") {
                badgeHtml = '<span style="background:#fef3c7;color:#b45309;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700;">💻 仅本地</span>';
            } else if (item.type === "cloud_only") {
                badgeHtml = '<span style="background:#e0e7ff;color:#4338ca;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700;">☁️ 仅云端</span>';
            } else {
                badgeHtml = '<span style="background:#ecfdf5;color:#047857;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700;">✅ 内容一致</span>';
            }

            const badgeEl = createDomNode("div", { html: badgeHtml });
            appendChildren(headerRow, nameEl, badgeEl);

            // 详情内容区
            const detailRow = createDomNode("div", {
                cssText: "display: flex; flex-direction: column; gap: 6px; font-size: 11px; color: #475569; background: #f8fafc; padding: 8px 10px; border-radius: 8px; border: 1px solid #f1f5f9;",
            });

            if (item.type === "conflict") {
                const localInfo = await getDetailedLineupInfo(item.local);
                const cloudInfo = await getDetailedLineupInfo(item.cloud);
                const hasWeaponDiff = localInfo.weaponId !== cloudInfo.weaponId;
                const localToyStyle = hasWeaponDiff
                    ? "background:#fef2f2;color:#b91c1c;border:1px solid #fca5a5;"
                    : "background:#fef3c7;color:#92400e;border:1px solid #fde68a;";
                const cloudToyStyle = hasWeaponDiff
                    ? "background:#fef2f2;color:#b91c1c;border:1px solid #fca5a5;"
                    : "background:#e0e7ff;color:#3730a3;border:1px solid #c7d2fe;";

                detailRow.innerHTML = `
                    <!-- 左右分栏头部对照 -->
                    <div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;">
                        <!-- 左列：本地阵容概览 -->
                        <div style="flex:1;min-width:0;background:#ffffff;border:1px solid #e2e8f0;border-radius:6px;padding:4px 6px;">
                            <div style="display:flex;align-items:center;justify-content:space-between;gap:2px;">
                                <span style="font-weight:700;color:#0f172a;font-size:11px;">💻 本地阵容</span>
                                <span style="color:#94a3b8;font-size:9.5px;">${localInfo.timeStr}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:3px;margin-top:2px;font-size:10px;flex-wrap:wrap;">
                                ${localInfo.powerText ? '<span style="color:#d97706;font-weight:700;font-size:10px;">⚡' + localInfo.powerText + '</span>' : ''}
                                ${localInfo.slotId ? '<span style="color:#64748b;font-size:9.5px;">(槽' + localInfo.slotId + ')</span>' : ''}
                                <span style="display:inline-flex;align-items:center;padding:0 3px;border-radius:3px;font-size:9px;font-weight:600;${localToyStyle};">
                                    🧸${localInfo.weaponName || '无玩具'}
                                </span>
                            </div>
                        </div>

                        <div style="display:flex;align-items:center;justify-content:center;width:14px;color:#94a3b8;font-size:11px;font-weight:700;flex-shrink:0;">
                            ⇄
                        </div>

                        <!-- 右列：云端阵容概览 -->
                        <div style="flex:1;min-width:0;background:#ffffff;border:1px solid #e2e8f0;border-radius:6px;padding:4px 6px;">
                            <div style="display:flex;align-items:center;justify-content:space-between;gap:2px;">
                                <span style="font-weight:700;color:#4338ca;font-size:11px;">☁️ 云端阵容</span>
                                <span style="color:#94a3b8;font-size:9.5px;">${cloudInfo.timeStr}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:3px;margin-top:2px;font-size:10px;flex-wrap:wrap;">
                                ${cloudInfo.powerText ? '<span style="color:#6366f1;font-weight:700;font-size:10px;">⚡' + cloudInfo.powerText + '</span>' : ''}
                                ${cloudInfo.slotId ? '<span style="color:#64748b;font-size:9.5px;">(槽' + cloudInfo.slotId + ')</span>' : ''}
                                <span style="display:inline-flex;align-items:center;padding:0 3px;border-radius:3px;font-size:9px;font-weight:600;${cloudToyStyle};">
                                    🧸${cloudInfo.weaponName || '无玩具'}
                                </span>
                            </div>
                        </div>
                    </div>

                    <!-- 1~5号站位左右逐行对照 -->
                    <div style="display:flex;flex-direction:column;gap:1px;">
                        ${renderSideBySideHeroRows(localInfo, cloudInfo)}
                    </div>

                    <!-- 底部图例与玩具状态 -->
                    <div style="display:flex;align-items:center;justify-content:space-between;font-size:10.5px;color:#64748b;padding-top:4px;border-top:1px dashed #e2e8f0;flex-wrap:wrap;gap:4px;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span><strong style="color:#ef4444;">■ 红框/≠</strong> 差异项</span>
                            <span><strong style="color:#10b981;">■ 绿框/＝</strong> 一致项</span>
                        </div>
                        ${hasWeaponDiff ? '<span style="color:#dc2626;font-weight:600;">⚠️ 玩具不同</span>' : ''}
                    </div>
                `;
            } else if (item.type === "local_only") {
                const localInfo = await getDetailedLineupInfo(item.local);
                detailRow.innerHTML = `
                    <div>
                        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">
                            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                                <span>💻 <strong>本地详情:</strong></span>
                                ${localInfo.powerText ? '<span style="color:#d97706;font-weight:700;">⚡ ' + localInfo.powerText + '</span>' : ''}
                                ${localInfo.slotId ? '<span style="color:#64748b;font-size:10.5px;">(槽位' + localInfo.slotId + ')</span>' : ''}
                                <span style="display:inline-flex;align-items:center;gap:2px;padding:1px 5px;border-radius:4px;font-size:10px;font-weight:600;background:#fef3c7;color:#92400e;border:1px solid #fde68a;">
                                    🧸 ${localInfo.weaponName || '无玩具'}
                                </span>
                            </div>
                            <span style="color:#94a3b8;font-size:10.5px;">${localInfo.timeStr}</span>
                        </div>
                        ${renderHeroChipsHtml(localInfo)}
                        <div style="color:#d97706;margin-top:4px;font-size:10.5px;">💡 云端尚未备份此阵容，点击下方按钮一键追加推送</div>
                    </div>
                `;
            } else if (item.type === "cloud_only") {
                const cloudInfo = await getDetailedLineupInfo(item.cloud);
                detailRow.innerHTML = `
                    <div>
                        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">
                            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                                <span>☁️ <strong>云端详情:</strong></span>
                                ${cloudInfo.powerText ? '<span style="color:#6366f1;font-weight:700;">⚡ ' + cloudInfo.powerText + '</span>' : ''}
                                ${cloudInfo.slotId ? '<span style="color:#64748b;font-size:10.5px;">(槽位' + cloudInfo.slotId + ')</span>' : ''}
                                <span style="display:inline-flex;align-items:center;gap:2px;padding:1px 5px;border-radius:4px;font-size:10px;font-weight:600;background:#e0e7ff;color:#3730a3;border:1px solid #c7d2fe;">
                                    🧸 ${cloudInfo.weaponName || '无玩具'}
                                </span>
                            </div>
                            <span style="color:#94a3b8;font-size:10.5px;">${cloudInfo.timeStr}</span>
                        </div>
                        ${renderHeroChipsHtml(cloudInfo)}
                        <div style="color:#4338ca;margin-top:4px;font-size:10.5px;">💡 本地尚未保存此阵容，点击下方按钮一键下载到本地</div>
                    </div>
                `;
            } else {
                const localInfo = await getDetailedLineupInfo(item.local);
                detailRow.innerHTML = `
                    <div>
                        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">
                            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                                <span>✅ <strong>阵容详情:</strong></span>
                                ${localInfo.powerText ? '<span style="color:#059669;font-weight:700;">⚡ ' + localInfo.powerText + '</span>' : ''}
                                ${localInfo.slotId ? '<span style="color:#64748b;font-size:10.5px;">(槽位' + localInfo.slotId + ')</span>' : ''}
                                <span style="display:inline-flex;align-items:center;gap:2px;padding:1px 5px;border-radius:4px;font-size:10px;font-weight:600;background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;">
                                    🧸 ${localInfo.weaponName || '无玩具'}
                                </span>
                            </div>
                            <span style="color:#94a3b8;font-size:10.5px;">${localInfo.timeStr}</span>
                        </div>
                        ${renderHeroChipsHtml(localInfo)}
                        <div style="color:#059669;margin-top:4px;font-size:10.5px;">阵容武将与战力完全一致，无需合并</div>
                    </div>
                `;
            }

            // 操作按钮条
            const actionRow = createDomNode("div", {
                cssText: "display: flex; justify-content: flex-end; gap: 6px; padding-top: 2px;",
            });

            if (item.type === "conflict") {
                // 1. 云端替换本地
                const cloudToLocalBtn = createDomNode("button", {
                    text: "⬇️ 云端覆盖本地",
                    title: "使用云端的这套阵容覆盖替换掉本地的同名阵容",
                    cssText: `
                        height: 24px;
                        padding: 0 8px;
                        border-radius: 5px;
                        border: 1px solid #bfdbfe;
                        background: #eff6ff;
                        color: #1e40af;
                        font-size: 11px;
                        font-weight: 600;
                        cursor: pointer;
                    `,
                    events: {
                        onclick: async () => {
                            try {
                                cloudToLocalBtn.disabled = true;
                                cloudToLocalBtn.textContent = "⏳ 覆盖中...";
                                const curLocals = readSavedConfigs();
                                const targetIdx = curLocals.findIndex(l => (l.name || "").trim() === item.name || l.id === item.local.id);
                                if (targetIdx >= 0) {
                                    curLocals[targetIdx] = { ...item.cloud, id: curLocals[targetIdx].id || item.cloud.id };
                                } else {
                                    curLocals.push(item.cloud);
                                }
                                writeSavedConfigs(curLocals);
                                renderSavedConfigs();
                                setStatusText(`✅ 已使用云端版本覆盖本地「${item.name}」`, ["成功"]);
                                await loadAndRenderDiff();
                            } catch (e) {
                                setStatusText("❌ 覆盖失败: " + e.message, ["失败"]);
                            }
                        },
                    },
                });

                // 2. 本地替换云端
                const localToCloudBtn = createDomNode("button", {
                    text: "⬆️ 本地覆盖云端",
                    title: "使用本地的这套阵容覆盖替换掉云端的同名阵容并推送到 S3",
                    cssText: `
                        height: 24px;
                        padding: 0 8px;
                        border-radius: 5px;
                        border: 1px solid #ddd6fe;
                        background: #f5f3ff;
                        color: #6d28d9;
                        font-size: 11px;
                        font-weight: 600;
                        cursor: pointer;
                    `,
                    events: {
                        onclick: async () => {
                            try {
                                localToCloudBtn.disabled = true;
                                localToCloudBtn.textContent = "⏳ 推送中...";
                                const targetCloudIdx = cloudConfigs.findIndex(c => (c.name || "").trim() === item.name || c.id === item.cloud.id);
                                if (targetCloudIdx >= 0) {
                                    cloudConfigs[targetCloudIdx] = { ...item.local, id: cloudConfigs[targetCloudIdx].id || item.local.id };
                                } else {
                                    cloudConfigs.push(item.local);
                                }
                                await uploadLineupToSevenColor(cloudConfigs);
                                setStatusText(`✅ 已使用本地版本覆盖云端「${item.name}」`, ["成功"]);
                                await loadAndRenderDiff();
                            } catch (e) {
                                setStatusText("❌ 推送覆盖失败: " + e.message, ["失败"]);
                            }
                        },
                    },
                });

                appendChildren(actionRow, cloudToLocalBtn, localToCloudBtn);
            } else if (item.type === "local_only") {
                const uploadSingleBtn = createDomNode("button", {
                    text: "⬆️ 追加到云端",
                    title: "将本地此阵容追加合并到云端备份中",
                    cssText: `
                        height: 24px;
                        padding: 0 8px;
                        border-radius: 5px;
                        border: 1px solid #cbd5e1;
                        background: #f8fafc;
                        color: #334155;
                        font-size: 11px;
                        font-weight: 600;
                        cursor: pointer;
                    `,
                    events: {
                        onclick: async () => {
                            try {
                                uploadSingleBtn.disabled = true;
                                uploadSingleBtn.textContent = "⏳ 上传中...";
                                cloudConfigs.push(item.local);
                                await uploadLineupToSevenColor(cloudConfigs);
                                setStatusText(`✅ 已将「${item.name}」追加备份至云端`, ["成功"]);
                                await loadAndRenderDiff();
                            } catch (e) {
                                setStatusText("❌ 追加失败: " + e.message, ["失败"]);
                            }
                        },
                    },
                });
                appendChildren(actionRow, uploadSingleBtn);
            } else if (item.type === "cloud_only") {
                const downloadSingleBtn = createDomNode("button", {
                    text: "⬇️ 下载到本地",
                    title: "将云端此阵容追加保存到本地阵容库中",
                    cssText: `
                        height: 24px;
                        padding: 0 8px;
                        border-radius: 5px;
                        border: 1px solid #bfdbfe;
                        background: #eff6ff;
                        color: #1e40af;
                        font-size: 11px;
                        font-weight: 600;
                        cursor: pointer;
                    `,
                    events: {
                        onclick: async () => {
                            try {
                                downloadSingleBtn.disabled = true;
                                downloadSingleBtn.textContent = "⏳ 保存中...";
                                const curLocals = readSavedConfigs();
                                curLocals.push(item.cloud);
                                writeSavedConfigs(curLocals);
                                renderSavedConfigs();
                                setStatusText(`✅ 已将云端「${item.name}」下载至本地`, ["成功"]);
                                await loadAndRenderDiff();
                            } catch (e) {
                                setStatusText("❌ 保存失败: " + e.message, ["失败"]);
                            }
                        },
                    },
                });
                appendChildren(actionRow, downloadSingleBtn);
            }

            appendChildren(card, headerRow, detailRow);
            if (actionRow.children.length > 0) {
                appendChildren(card, actionRow);
            }
            appendChildren(diffList, card);
        }
    }

    return {
        container,
        refresh: loadAndRenderDiff,
    };
}



        // 内嵌七彩云设置面板定义
function createSevenColorInlineView() {
    let currentCfg = getSevenColorConfig();
    let isWorking = false;

    const container = createDomNode("div", {
        cssText: `
            display: none;
            flex-direction: column;
            gap: 12px;
            font-size: 13px;
            box-sizing: border-box;
            width: 100%;
            max-height: min(62vh, 520px);
            overflow-y: auto;
            overflow-x: hidden;
            -webkit-overflow-scrolling: touch;
            overscroll-behavior: contain;
            touch-action: pan-y;
            padding-right: 4px;
            padding-bottom: 16px;
            scrollbar-width: thin;
            scrollbar-color: #cbd5e1 transparent;
        `,
    });
    // 防止底层 Canvas 游戏拦截面板内部的滚轮和手势
    container.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    container.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });

    // 1. 顶部操作条（返回阵容列表 + 状态指示）
    const navBar = createDomNode("div", {
        cssText: `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 10px;
            background: linear-gradient(135deg, #f8fafc, #f1f5f9);
            border-radius: 10px;
            border: 1px solid #e2e8f0;
        `,
    });
    const backBtn = createDomNode("button", {
        text: "← 返回阵容列表",
        title: "切回无限阵容列表",
        cssText: `
            display: inline-flex;
            align-items: center;
            gap: 4px;
            height: 26px;
            padding: 0 10px;
            border-radius: 6px;
            border: 1px solid #cbd5e1;
            background: #ffffff;
            color: #334155;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
            transition: all 0.15s;
        `,
        events: {
            onclick: () => switchTab("lineup"),
        },
    });
    const statusBadge = createDomNode("div", {
        cssText: `
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            font-weight: 600;
        `,
    });
    appendChildren(navBar, backBtn, statusBadge);

    // 2. 状态信息卡片
    const statusCard = createDomNode("div", {
        cssText: `
            padding: 10px 12px;
            background: #ffffff;
            border-radius: 10px;
            border: 1px solid #e2e8f0;
            font-size: 12px;
            color: #475569;
            line-height: 1.6;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
        `,
    });

    const updateStatusDisplay = (msg, isError = false) => {
        const isEnabled = !!enableCheckbox.checked;
        statusBadge.innerHTML = isEnabled
            ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;"></span><span style="color:#059669;">云同步已启用</span>'
            : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#94a3b8;"></span><span style="color:#64748b;">未启用</span>';

        const timeStr = currentCfg.lastSyncTime ? new Date(currentCfg.lastSyncTime).toLocaleString("zh-CN") : "从未同步";
        statusCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;flex-wrap:wrap;gap:4px;">
                <span>角色ID: <code style="color:#6366f1;font-weight:700;">${getUserId()}</code></span>
                <span>上次同步: <strong>${timeStr}</strong></span>
            </div>
            <div>云端状态: <span style="color:${isError ? '#ef4444' : '#10b981'};font-weight:600;">${msg || currentCfg.lastSyncStatus || '未同步'}</span></div>
        `;
    };

    // 3. 启用主开关
    const enableRow = createDomNode("div", {
        cssText: `
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: #f8fafc;
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid #e2e8f0;
        `,
    });
    const enableLabel = createDomNode("div", {
        html: '<strong>启用七彩云端同步</strong><div style="font-size:11px;color:#64748b;margin-top:2px;">开启后使用七彩云 S3 对象存储备份与拉取阵容</div>',
    });
    const enableCheckbox = createDomNode("input", {
        cssText: "width: 18px; height: 18px; cursor: pointer; accent-color: #8b5cf6;",
    });
    enableCheckbox.type = "checkbox";
    enableCheckbox.checked = !!currentCfg.enabled;
    enableCheckbox.onchange = () => updateStatusDisplay();
    appendChildren(enableRow, enableLabel, enableCheckbox);

    // 快捷剪贴板多号速配
    const copyPasteRow = createDomNode("div", {
        cssText: "display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: -4px;",
    });
    const copyConfigBtn = createDomNode("button", {
        text: "📋 复制 S3 配置",
        title: "将当前 S3 配置复制到剪贴板，便于其他角色/多开快速粘贴",
        cssText: `
            height: 24px;
            padding: 0 8px;
            border-radius: 6px;
            border: 1px solid #cbd5e1;
            background: #f8fafc;
            color: #475569;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.15s;
        `,
        events: {
            onclick: () => {
                try {
                    const cfg = collectCurrentInput();
                    const jsonStr = JSON.stringify({
                        endpoint: cfg.endpoint,
                        region: cfg.region,
                        bucket: cfg.bucket,
                        accessKey: cfg.accessKey,
                        secretKey: cfg.secretKey,
                        pathStyle: cfg.pathStyle,
                        isPublicBucket: cfg.isPublicBucket,
                        autoSync: cfg.autoSync,
                    });
                    const b64 = btoa(unescape(encodeURIComponent(jsonStr)));
                    GM_setClipboard(b64);
                    setStatusText("✅ S3 配置已复制到剪贴板", ["配置"]);
                } catch (e) {
                    setStatusText("❌ 复制失败：" + e.message, ["失败"]);
                }
            },
        },
    });
    const pasteConfigBtn = createDomNode("button", {
        text: "📥 粘贴 S3 配置",
        title: "从剪贴板读取并填充 S3 配置",
        cssText: `
            height: 24px;
            padding: 0 8px;
            border-radius: 6px;
            border: 1px solid #cbd5e1;
            background: #f8fafc;
            color: #475569;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.15s;
        `,
        events: {
            onclick: async () => {
                try {
                    let text = "";
                    if (navigator.clipboard && navigator.clipboard.readText) {
                        text = await navigator.clipboard.readText();
                    } else {
                        text = prompt("请在此处粘贴导出的 S3 配置字符串：") || "";
                    }
                    text = (text || "").trim();
                    if (!text) return;
                    let parsed = null;
                    try {
                        const decoded = decodeURIComponent(escape(atob(text)));
                        parsed = JSON.parse(decoded);
                    } catch (e) {
                        parsed = JSON.parse(text);
                    }
                    if (parsed && typeof parsed === "object") {
                        if (parsed.endpoint) endpointField.input.value = parsed.endpoint;
                        if (parsed.region) regionField.input.value = parsed.region;
                        if (parsed.bucket) bucketField.input.value = parsed.bucket;
                        if (parsed.accessKey) akField.input.value = parsed.accessKey;
                        if (parsed.secretKey) skField.input.value = parsed.secretKey;
                        if (typeof parsed.pathStyle === "boolean") {
                            const radio = container.querySelector(`input[name="inlineS3PathStyle"][value="${parsed.pathStyle ? 'path' : 'vhost'}"]`);
                            if (radio) radio.checked = true;
                        }
                        if (typeof parsed.isPublicBucket === "boolean") publicBucketCheckbox.checked = parsed.isPublicBucket;
                        if (typeof parsed.autoSync === "boolean") autoSyncCheckbox.checked = parsed.autoSync;
                        enableCheckbox.checked = true;
                        updateStatusDisplay();
                        setStatusText("✅ S3 配置已成功填入，点击底部保存即可", ["导入"]);
                    } else {
                        throw new Error("格式无效");
                    }
                } catch (e) {
                    setStatusText("❌ 粘贴配置失败：" + e.message, ["失败"]);
                }
            },
        },
    });
    appendChildren(copyPasteRow, copyConfigBtn, pasteConfigBtn);

    // 通用输入框创建工具
    const createField = (label, placeholder, defaultValue, type = "text", tip = "") => {
        const wrap = createDomNode("div", {
            cssText: "display: flex; flex-direction: column; gap: 4px;",
        });
        const lbl = createDomNode("label", {
            text: label,
            cssText: "font-weight: 600; color: #334155; font-size: 12px;",
        });
        const inputWrap = createDomNode("div", {
            cssText: "position: relative; display: flex; align-items: center;",
        });
        const input = createDomNode("input", {
            value: defaultValue || "",
            cssText: `
                width: 100%;
                height: 32px;
                padding: 0 10px;
                border-radius: 8px;
                border: 1px solid #cbd5e1;
                font-size: 12px;
                box-sizing: border-box;
                background: #ffffff;
                outline: none;
                transition: border-color 0.15s;
            `,
        });
        input.placeholder = placeholder;
        input.type = type;
        input.onfocus = () => { input.style.borderColor = "#8b5cf6"; };
        input.onblur = () => { input.style.borderColor = "#cbd5e1"; };
        appendChildren(inputWrap, input);

        if (type === "password") {
            const toggleEye = createDomNode("button", {
                text: "👁️",
                title: "显示/隐藏明文",
                cssText: `
                    position: absolute;
                    right: 6px;
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    font-size: 13px;
                    padding: 2px 4px;
                `,
                events: {
                    onclick: (e) => {
                        e.preventDefault();
                        input.type = input.type === "password" ? "text" : "password";
                    },
                },
            });
            appendChildren(inputWrap, toggleEye);
        }

        appendChildren(wrap, lbl, inputWrap);
        if (tip) {
            const tipNode = createDomNode("div", {
                html: tip,
                cssText: "font-size: 11px; color: #64748b; line-height: 1.4;",
            });
            appendChildren(wrap, tipNode);
        }
        return { wrap, input };
    };

    // 核心表单
    const endpointField = createField(
        "S3 Endpoint (接入点)",
        "https://s3.7caiyun.com",
        currentCfg.endpoint || "https://s3.7caiyun.com",
        "text",
        "七彩云对象存储官方接入地址，默认为 <code>https://s3.7caiyun.com</code>"
    );

    const bucketField = createField(
        "存储桶名称 (Bucket)",
        "例如 xyzw-backup",
        currentCfg.bucket,
        "text",
        "您在七彩云控制台创建的存储桶名称"
    );

    const akField = createField(
        "AccessKey (访问密钥 ID)",
        "从七彩云控制台获取的 AccessKey",
        currentCfg.accessKey,
        "text"
    );

    const skField = createField(
        "SecretKey (私有密钥)",
        "从七彩云控制台获取的 SecretKey",
        currentCfg.secretKey,
        "password",
        "密钥仅安全保存在您的本地浏览器中"
    );

    const regionField = createField(
        "Region (区域)",
        "us-west",
        currentCfg.region || "us-west",
        "text",
        "七彩云默认区域推荐为 <code>us-west</code>"
    );

    const pathField = createField(
        "对象路径 (Object Key)",
        "xyzw/lineup_{userId}.json",
        currentCfg.filePath || "xyzw/lineup_{userId}.json",
        "text",
        "支持 <code>{userId}</code> 占位符自动替换为当前角色 ID"
    );

    // 对象路径快捷药丸
    const pathPillRow = createDomNode("div", {
        cssText: "display: flex; gap: 6px; margin-top: -2px;",
    });
    const pillUserBtn = createDomNode("button", {
        text: "👤 角色专属路径",
        title: "不同角色各自拥有独立的云端阵容文件",
        cssText: `
            height: 22px;
            padding: 0 8px;
            border-radius: 6px;
            border: 1px solid #bfdbfe;
            background: #eff6ff;
            color: #1d4ed8;
            font-size: 11px;
            cursor: pointer;
        `,
        events: {
            onclick: () => {
                pathField.input.value = "xyzw/lineup_{userId}.json";
            },
        },
    });
    const pillSharedBtn = createDomNode("button", {
        text: "🌐 全号通用路径",
        title: "所有小号/角色共享同一份云端阵容文件（跨号一键同步）",
        cssText: `
            height: 22px;
            padding: 0 8px;
            border-radius: 6px;
            border: 1px solid #ddd6fe;
            background: #f5f3ff;
            color: #6d28d9;
            font-size: 11px;
            cursor: pointer;
        `,
        events: {
            onclick: () => {
                pathField.input.value = "xyzw/lineup_shared.json";
            },
        },
    });
    appendChildren(pathPillRow, pillUserBtn, pillSharedBtn);
    appendChildren(pathField.wrap, pathPillRow);

    // 高级设置卡片
    const advancedBox = createDomNode("div", {
        cssText: "background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px;",
    });
    const advancedTitle = createDomNode("div", {
        text: "⚙️ 访问风格与高级选项",
        cssText: "font-weight: 600; font-size: 12px; color: #334155;",
    });

    // 访问风格
    const styleRow = createDomNode("div", {
        cssText: "display: flex; gap: 14px; font-size: 12px;",
    });
    const vhostRadioLabel = createDomNode("label", {
        cssText: "display: flex; align-items: center; gap: 4px; cursor: pointer;",
        html: '<input type="radio" name="inlineS3PathStyle" value="vhost" ' + (!currentCfg.pathStyle ? 'checked' : '') + ' style="accent-color:#8b5cf6;"> 主机模式 (Virtual Host, 推荐)',
    });
    const pathRadioLabel = createDomNode("label", {
        cssText: "display: flex; align-items: center; gap: 4px; cursor: pointer;",
        html: '<input type="radio" name="inlineS3PathStyle" value="path" ' + (currentCfg.pathStyle ? 'checked' : '') + ' style="accent-color:#8b5cf6;"> 路径模式 (Path Style)',
    });
    appendChildren(styleRow, vhostRadioLabel, pathRadioLabel);

    // 公有桶直读开关
    const publicBucketRow = createDomNode("label", {
        cssText: "display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: #475569;",
    });
    const publicBucketCheckbox = createDomNode("input", {
        cssText: "cursor: pointer; accent-color: #8b5cf6;",
    });
    publicBucketCheckbox.type = "checkbox";
    publicBucketCheckbox.checked = !!currentCfg.isPublicBucket;
    appendChildren(publicBucketRow, publicBucketCheckbox, createDomNode("span", {
        text: "存储桶已设为公有读取（下载时可直接访问）",
    }));

    // 自动同步开关
    const autoSyncRow = createDomNode("label", {
        cssText: "display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: #334155; font-weight: 600;",
    });
    const autoSyncCheckbox = createDomNode("input", {
        cssText: "cursor: pointer; accent-color: #8b5cf6;",
    });
    autoSyncCheckbox.type = "checkbox";
    autoSyncCheckbox.checked = !!currentCfg.autoSync;
    appendChildren(autoSyncRow, autoSyncCheckbox, createDomNode("span", {
        text: "保存阵容时自动静默备份到七彩云 S3（推荐勾选）",
    }));

    // 云端恢复时直接覆盖本地阵容开关
    const forceOverwriteRow = createDomNode("label", {
        cssText: "display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: #334155;",
    });
    const forceOverwriteCheckbox = createDomNode("input", {
        cssText: "cursor: pointer; accent-color: #8b5cf6;",
    });
    forceOverwriteCheckbox.type = "checkbox";
    forceOverwriteCheckbox.checked = true; // 默认勾选：与本地导入一致，直接覆盖恢复
    appendChildren(forceOverwriteRow, forceOverwriteCheckbox, createDomNode("span", {
        html: "从云端恢复时直接<strong>完整覆盖</strong>本地阵容（推荐，等同于导入文件）",
    }));

    appendChildren(advancedBox, advancedTitle, styleRow, publicBucketRow, autoSyncRow, forceOverwriteRow);

    const collectCurrentInput = () => {
        const selectedStyle = container.querySelector('input[name="inlineS3PathStyle"]:checked');
        return {
            enabled: enableCheckbox.checked,
            endpoint: endpointField.input.value.trim() || "https://s3.7caiyun.com",
            region: regionField.input.value.trim() || "us-west",
            bucket: bucketField.input.value.trim(),
            accessKey: akField.input.value.trim(),
            secretKey: skField.input.value.trim(),
            filePath: pathField.input.value.trim() || "xyzw/lineup_{userId}.json",
            pathStyle: selectedStyle ? selectedStyle.value === "path" : false,
            isPublicBucket: publicBucketCheckbox.checked,
            autoSync: autoSyncCheckbox.checked,
        };
    };

    const testResultNode = createDomNode("div", {
        cssText: `
            font-size: 12px;
            padding: 10px 12px;
            border-radius: 8px;
            display: none;
            line-height: 1.5;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
        `,
    });

    // 快捷操作工具行（测试 / 立即上传 / 立即下载）
    const quickActionRow = createDomNode("div", {
        cssText: "display: flex; gap: 8px; flex-wrap: wrap; padding-top: 4px;",
    });

    const actionBtnStyle = `
        flex: 1 1 calc(33.33% - 6px);
        min-width: 90px;
        height: 32px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 0 8px;
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        color: #334155;
        transition: all 0.15s;
    `;

    const testBtn = createDomNode("button", {
        text: "⚡ 测试连接",
        cssText: actionBtnStyle,
        events: {
            onclick: async () => {
                if (isWorking) return;
                isWorking = true;
                testBtn.disabled = true;
                testBtn.textContent = "⏳ 正在测试...";
                testResultNode.style.display = "block";
                testResultNode.style.background = "#f1f5f9";
                testResultNode.style.color = "#475569";
                testResultNode.textContent = "正在计算 S3 签名并测试七彩云连接，请稍候...";

                const draftCfg = collectCurrentInput();
                const result = await testSevenColorConnection(draftCfg);
                testBtn.disabled = false;
                testBtn.textContent = "⚡ 测试连接";
                isWorking = false;

                if (result.ok) {
                    testResultNode.style.background = "#ecfdf5";
                    testResultNode.style.color = "#047857";
                    testResultNode.innerHTML = '✅ <strong>连通成功！</strong> ' + result.message;
                } else {
                    testResultNode.style.background = "#fef2f2";
                    testResultNode.style.color = "#b91c1c";
                    testResultNode.innerHTML = '❌ <strong>连接失败：</strong> ' + result.message;
                }
            },
        },
    });

    const uploadNowBtn = createDomNode("button", {
        text: "☁️ 立即上传",
        cssText: actionBtnStyle,
        events: {
            onclick: async () => {
                if (isWorking) return;
                const draftCfg = collectCurrentInput();
                if (!draftCfg.enabled) {
                    draftCfg.enabled = true;
                    enableCheckbox.checked = true;
                }
                saveSevenColorConfig(draftCfg);
                isWorking = true;
                uploadNowBtn.disabled = true;
                uploadNowBtn.textContent = "⏳ 上传中...";
                try {
                    const activeConfigs = readSavedConfigs();
                    const res = await uploadLineupToSevenColor(activeConfigs);
                    currentCfg = getSevenColorConfig();
                    updateStatusDisplay('已成功上传 ' + res.count + ' 条阵容');
                    testResultNode.style.display = "block";
                    testResultNode.style.background = "#ecfdf5";
                    testResultNode.style.color = "#047857";
                    testResultNode.innerHTML = '✅ <strong>上传成功！</strong> 已将 ' + res.count + ' 条阵容备份至七彩云 S3';
                    setStatusText("✅ 七彩云上传成功 (" + res.count + " 条)", ["成功"]);
                } catch (err) {
                    updateStatusDisplay("上传失败", true);
                    testResultNode.style.display = "block";
                    testResultNode.style.background = "#fef2f2";
                    testResultNode.style.color = "#b91c1c";
                    testResultNode.innerHTML = '❌ <strong>上传失败：</strong> ' + err.message;
                    setStatusText("❌ 上传失败：" + err.message, ["失败"]);
                } finally {
                    isWorking = false;
                    uploadNowBtn.disabled = false;
                    uploadNowBtn.textContent = "☁️ 立即上传";
                }
            },
        },
    });

    const downloadNowBtn = createDomNode("button", {
        text: "📥 从云端恢复",
        title: "从七彩云 S3 拉取云端备份并恢复到当前角色的无限阵容库",
        cssText: actionBtnStyle,
        events: {
            onclick: async () => {
                if (isWorking) return;
                const draftCfg = collectCurrentInput();
                if (!draftCfg.enabled) {
                    draftCfg.enabled = true;
                    enableCheckbox.checked = true;
                }
                saveSevenColorConfig(draftCfg);
                isWorking = true;
                downloadNowBtn.disabled = true;
                downloadNowBtn.textContent = "⏳ 拉取中...";
                try {
                    const forceOverwrite = forceOverwriteCheckbox.checked;
                    const res = await syncFromCloud({ forceOverwrite });
                    if (res && res.ok) {
                        currentCfg = getSevenColorConfig();
                        updateStatusDisplay("同步恢复成功 (" + res.count + " 条)");
                        testResultNode.style.display = "block";
                        testResultNode.style.background = "#ecfdf5";
                        testResultNode.style.color = "#047857";

                        const sampleNames = (res.configs || [])
                            .slice(0, 4)
                            .map(c => `「${c.name || '未命名阵容'}」`)
                            .join("、");

                        const cleanedNote = res.cleanedTombstoneCount > 0
                            ? `<div style="font-size:11px;color:#64748b;margin-bottom:4px;">(已自动过滤并清理云端备份中的 ${res.cleanedTombstoneCount} 条历史已删除记录)</div>`
                            : '';
                        testResultNode.innerHTML = `
                            <div style="font-weight:700;margin-bottom:4px;">✅ 云端拉取恢复成功！已从七彩云恢复 ${res.count} 条阵容</div>
                            ${cleanedNote}
                            ${sampleNames ? '<div style="color:#065f46;font-size:11px;margin-bottom:6px;">包含：' + sampleNames + '</div>' : ''}
                            <button id="btn-goto-lineup-after-sync" style="margin-top:4px;padding:4px 10px;border-radius:6px;border:none;background:#059669;color:#fff;font-size:11px;font-weight:700;cursor:pointer;">👉 点击切回阵容列表查看</button>
                        `;
                        const gotoBtn = testResultNode.querySelector("#btn-goto-lineup-after-sync");
                        if (gotoBtn) {
                            gotoBtn.onclick = () => switchTab("lineup");
                        }
                        setStatusText("✅ 七彩云恢复完成 (" + res.count + " 条)", ["成功"]);
                    } else if (res && res.notFound) {
                        testResultNode.style.display = "block";
                        testResultNode.style.background = "#fffbeb";
                        testResultNode.style.color = "#b45309";
                        testResultNode.innerHTML = `⚠️ <strong>云端暂无当前角色的备份文件</strong><br><span style="font-size:11px;color:#92400e;margin-top:3px;display:inline-block;">💡 提示：对象路径默认按 <code>{userId}</code> 分离。若想跨账号共享，请点击上方「🌐 全号通用路径」并保存。</span>`;
                    } else {
                        testResultNode.style.display = "block";
                        testResultNode.style.background = "#fffbeb";
                        testResultNode.style.color = "#b45309";
                        testResultNode.innerHTML = `⚠️ 云端备份文件内容为空或无有效阵容`;
                    }
                } catch (err) {
                    updateStatusDisplay("拉取失败", true);
                    testResultNode.style.display = "block";
                    testResultNode.style.background = "#fef2f2";
                    testResultNode.style.color = "#b91c1c";
                    testResultNode.innerHTML = '❌ <strong>拉取失败：</strong> ' + err.message;
                    setStatusText("❌ 拉取失败：" + err.message, ["失败"]);
                } finally {
                    isWorking = false;
                    downloadNowBtn.disabled = false;
                    downloadNowBtn.textContent = "📥 从云端恢复";
                }
            },
        },
    });

    appendChildren(quickActionRow, testBtn, uploadNowBtn, downloadNowBtn);

    // 底部保存条
    const footerBar = createDomNode("div", {
        cssText: `
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            padding-top: 6px;
            border-top: 1px solid #e2e8f0;
        `,
    });
    const saveOnlyBtn = createDomNode("button", {
        text: "仅保存配置",
        title: "保存当前 S3 配置并停留在云同步页面",
        cssText: `
            height: 32px;
            padding: 0 12px;
            border-radius: 8px;
            border: 1px solid #cbd5e1;
            background: #ffffff;
            color: #475569;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
        `,
        events: {
            onclick: () => {
                const newCfg = collectCurrentInput();
                saveSevenColorConfig(newCfg);
                currentCfg = newCfg;
                updateStatusDisplay();
                setStatusText("✅ 七彩云 S3 配置已保存", ["保存"]);
            },
        },
    });
    const saveAndReturnBtn = createDomNode("button", {
        text: "💾 保存并返回阵容",
        title: "保存当前 S3 配置并切回无限阵容主列表",
        cssText: `
            height: 32px;
            padding: 0 16px;
            border-radius: 8px;
            border: none;
            background: linear-gradient(135deg, #8b5cf6, #6366f1);
            color: #ffffff;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 2px 6px rgba(99, 102, 241, 0.35);
        `,
        events: {
            onclick: () => {
                const newCfg = collectCurrentInput();
                saveSevenColorConfig(newCfg);
                currentCfg = newCfg;
                updateStatusDisplay();
                setStatusText("✅ 七彩云 S3 配置已保存", ["保存"]);
                switchTab("lineup");
            },
        },
    });
    appendChildren(footerBar, saveOnlyBtn, saveAndReturnBtn);

    appendChildren(
        container,
        navBar,
        statusCard,
        enableRow,
        copyPasteRow,
        endpointField.wrap,
        bucketField.wrap,
        akField.wrap,
        skField.wrap,
        regionField.wrap,
        pathField.wrap,
        advancedBox,
        quickActionRow,
        testResultNode,
        footerBar
    );

    const refresh = () => {
        currentCfg = getSevenColorConfig();
        enableCheckbox.checked = !!currentCfg.enabled;
        endpointField.input.value = currentCfg.endpoint || "https://s3.7caiyun.com";
        regionField.input.value = currentCfg.region || "us-west";
        bucketField.input.value = currentCfg.bucket || "";
        akField.input.value = currentCfg.accessKey || "";
        skField.input.value = currentCfg.secretKey || "";
        pathField.input.value = currentCfg.filePath || "xyzw/lineup_{userId}.json";
        const radio = container.querySelector(`input[name="inlineS3PathStyle"][value="${currentCfg.pathStyle ? 'path' : 'vhost'}"]`);
        if (radio) radio.checked = true;
        publicBucketCheckbox.checked = !!currentCfg.isPublicBucket;
        autoSyncCheckbox.checked = !!currentCfg.autoSync;
        updateStatusDisplay();
        testResultNode.style.display = "none";
    };

    return {
        container,
        refresh,
    };
}


        const exportJsonButton = createDomNode("button", {
            text: "📤 导出",
            title: "导出本地阵容 JSON 文件",
            cssText: `
                flex: 1;
                height: 28px;
                border-radius: 8px;
                background: #f8fafc;
                color: #334155;
                border: 1px solid #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                padding: 0 6px;
                font-size: 12px;
                font-weight: 600;
                white-space: nowrap;
                transition: all 0.15s ease;
            `,
            events: {
                onclick: () => {
                    try {
                        const payload = buildLineupExportPayload(readSavedConfigs());
                        downloadLineupJsonFile(payload);
                        setStatusText(
                            "✅ 已导出 " + payload.configs.length + " 条阵容",
                            ["导出"],
                        );
                    } catch (error) {
                        const errorMessage = error && error.message ? error.message : String(error);
                        setStatusText("❌ 导出失败：" + errorMessage, ["失败"]);
                    }
                },
            },
        });
        const importJsonInput = createDomNode("input", {
            cssText: "display: none;",
        });
        importJsonInput.type = "file";
        importJsonInput.accept = "application/json,.json";
        const importJsonButton = createDomNode("button", {
            text: "📥 导入",
            title: "从 JSON 文件导入并覆盖本地阵容列表",
            cssText: `
                flex: 1;
                height: 28px;
                border-radius: 8px;
                background: #f8fafc;
                color: #334155;
                border: 1px solid #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                padding: 0 6px;
                font-size: 12px;
                font-weight: 600;
                white-space: nowrap;
                transition: all 0.15s ease;
            `,
            events: {
                onclick: () => {
                    importJsonInput.click();
                },
            },
        });
        importJsonInput.onchange = async () => {
            const file = importJsonInput.files && importJsonInput.files[0];
            importJsonInput.value = "";
            if (!file) {
                return;
            }
            if (lineupRuntimeState.isSaving || lineupRuntimeState.isSwitching) {
                setStatusText("当前有阵容操作正在进行，请稍候再导入", ["稍候"]);
                return;
            }
            lineupRuntimeState.isSaving = true;
            setStatusText("正在导入 JSON...");
            try {
                const importedPayload = await readLineupConfigsFromJsonFile(file);
                const currentUserId = String(getUserId());
                const isDifferentAccount =
                    importedPayload.sourceUserId &&
                    importedPayload.sourceUserId !== currentUserId;
                const confirmMessage = isDifferentAccount
                    ? "导入文件属于账号 " +
                      importedPayload.sourceUserId +
                      "，当前账号为 " +
                      currentUserId +
                      "。继续会覆盖当前账号阵容，是否继续？"
                    : "导入会覆盖当前本地阵容数据，是否继续？";
                if (!window.confirm(confirmMessage)) {
                    setStatusText("已取消导入", ["取消"]);
                    return;
                }
                const importedConfigs = importedPayload.configs;
                writeSavedConfigs(importedConfigs);
                renderSavedConfigs();
                setStatusText(
                    "✅ 已导入 " +
                        importedConfigs.length +
                        " 条阵容" +
                        (importedPayload.reassignedIdCount
                            ? "，已修复 " +
                              importedPayload.reassignedIdCount +
                              " 个重复 ID"
                            : ""),
                    ["导入"],
                );
            } catch (error) {
                reportLineupActionFailure("导入", error);
            } finally {
                lineupRuntimeState.isSaving = false;
            }
        };
        const closeButton = createDomNode("button", {
            html: `<svg class="icon" id="close-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"></path></svg>`,
            title: "关闭面板",
            cssText: `
                width: 26px;
                height: 26px;
                border-radius: 50%;
                background: #f1f5f9;
                color: #64748b;
                border: 1px solid #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                padding: 0;
                transition: all 0.15s ease;
            `,
            events: {
                onclick: () => {
                    setPanelVisible(false);
                },
            },
        });
        const configList = createDomNode("div", {
            id: "lineup-list",
            cssText: LINEUP_UI_STYLE.configList,
        });
        const statusText = createDomNode("div", {
            cssText: LINEUP_UI_STYLE.statusText,
        });
        const setStatusText = (text, clearMarkers) => {
            statusText.textContent = text;
            if (clearMarkers && clearMarkers.length > 0) {
                clearStatusTextLater(statusText, clearMarkers);
            }
        };
        const reportLineupActionFailure = (actionLabel, error) => {
            const errorMessage =
                error && error.message ? error.message : String(error);
            const message = actionLabel + "失败：" + errorMessage;
            setStatusText("❌ " + message, ["失败"]);
            try {
                window.__require("TipsManager").SHOW_TIP(message);
            } catch (tipError) {}
        };
        const updatePresetSlotButtons = () => {
            const ServerData = window.__require("ServerData");
            const role = ServerData && ServerData.ROLE;
            const currentTeamId = getCurrentPresetTeamId(role);
            const slotCount = getRoleTeamSlotCount(role);
            presetSlotBar.replaceChildren();
            for (let slotIndex = 1; slotIndex <= slotCount; slotIndex++) {
                const isActiveSlot = slotIndex === currentTeamId;
                const slotButton = createDomNode("button", {
                    text: String(slotIndex),
                    title: isActiveSlot
                        ? "当前主线阵容槽 " + slotIndex
                        : "切换到阵容槽 " + slotIndex,
                    dataset: {
                        presetSlotButton: "1",
                        slotId: slotIndex,
                        active: isActiveSlot ? "1" : "0",
                    },
                    cssText: getPresetSlotButtonStyle(isActiveSlot),
                    events: {
                        onclick: async () => {
                            if (lineupRuntimeState.isSwitching) {
                                return;
                            }
                            if (lineupRuntimeState.isSaving) {
                                setStatusText("阵容正在保存，请稍候再切换", ["保存"]);
                                return;
                            }
                            try {
                                lineupRuntimeState.isSwitching = true;
                                await switchPresetTeamSlot(slotIndex, {
                                    setStatusText,
                                    activeButton: slotButton,
                                });
                                renderSavedConfigs();
                            } catch (error) {
                                const errorMessage = error && error.message ? error.message : String(error);
                                setStatusText("切换阵容槽失败: " + errorMessage, ["失败"]);
                            } finally {
                                lineupRuntimeState.isSwitching = false;
                                updatePresetSlotButtons();
                            }
                        },
                    },
                });
                slotButton.onmouseover = () => {
                    if (!slotButton.disabled && !isActiveSlot) {
                        slotButton.style.transform = "translateY(-1px)";
                        slotButton.style.boxShadow = "0 4px 10px rgba(148, 163, 184, 0.2)";
                    }
                };
                slotButton.onmouseout = () => {
                    slotButton.style.transform = "translateY(0)";
                    slotButton.style.boxShadow = isActiveSlot
                        ? "0 4px 10px rgba(249, 115, 22, 0.28)"
                        : "none";
                };
                appendChildren(presetSlotBar, slotButton);
            }
        };
        function showLineupConfirm(message, options = {}) {
            return new Promise((resolve) => {
                const overlay = createDomNode("div", {
                    cssText: `
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0, 0, 0, 0.55);
                        z-index: 2147483647;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 16px;
                        box-sizing: border-box;
                    `,
                });
                const dialog = createDomNode("div", {
                    cssText: `
                        width: min(320px, calc(100vw - 32px));
                        background: #ffffff;
                        border-radius: 10px;
                        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
                        color: #374151;
                        overflow: hidden;
                        font-family: 'Segoe UI', system-ui, -apple-system, 'PingFang SC','Microsoft YaHei', sans-serif;
                    `,
                });
                const titleNode = createDomNode("div", {
                    text: options.title || "确认",
                    cssText: `
                        padding: 16px 18px 14px;
                        text-align: center;
                        font-size: 18px;
                        font-weight: 600;
                        border-bottom: 1px solid #e5e7eb;
                    `,
                });
                const messageNode = createDomNode("div", {
                    text: message,
                    cssText: `
                        padding: 24px 20px;
                        text-align: center;
                        font-size: 16px;
                        line-height: 1.55;
                        white-space: pre-wrap;
                    `,
                });
                const actionRow = createDomNode("div", {
                    cssText: `
                        display: flex;
                        justify-content: flex-end;
                        gap: 10px;
                        padding: 14px 16px 16px;
                        border-top: 1px solid #e5e7eb;
                    `,
                });
                const cleanup = (confirmed) => {
                    overlay.remove();
                    resolve(confirmed);
                };
                const cancelButton = createDomNode("button", {
                    text: options.cancelText || "取消",
                    cssText: `
                        min-width: 74px;
                        height: 38px;
                        border-radius: 8px;
                        background: #ffffff;
                        border: 1px solid #e5e7eb;
                        color: #374151;
                        font-size: 15px;
                        cursor: pointer;
                    `,
                    events: {
                        onclick: () => cleanup(false),
                    },
                });
                const confirmButton = createDomNode("button", {
                    text: options.confirmText || "确定",
                    cssText: `
                        min-width: 74px;
                        height: 38px;
                        border-radius: 8px;
                        background: #ef4444;
                        border: none;
                        color: #ffffff;
                        font-size: 15px;
                        font-weight: 600;
                        cursor: pointer;
                    `,
                    events: {
                        onclick: () => cleanup(true),
                    },
                });
                overlay.onclick = (event) => {
                    if (event.target === overlay) {
                        cleanup(false);
                    }
                };
                appendChildren(actionRow, cancelButton, confirmButton);
                appendChildren(dialog, titleNode, messageNode, actionRow);
                appendChildren(overlay, dialog);
                appendChildren(document.body, overlay);
                confirmButton.focus();
            });
        }
        async function overwriteSavedConfig(savedConfig, configIndex, savedConfigs) {
            if (lineupRuntimeState.isSwitching) {
                setStatusText("阵容正在切换，请稍候再覆盖", ["切换"]);
                return;
            }
            if (lineupRuntimeState.isSaving) {
                setStatusText("已有保存操作正在进行，请稍候", ["保存"]);
                return;
            }
            if (!savedConfig) {
                setStatusText("没有可覆盖的保存阵容", ["失败"]);
                return;
            }
            lineupRuntimeState.isSaving = true;
            try {
                const SHOW_TIP = window.__require("TipsManager").SHOW_TIP;
                const initialStorageKey = getLineupStorageKey();
                const targetId = String(savedConfig.id);
                const currentConfigs = readAllSavedConfigs();
                const currentIndex = currentConfigs.findIndex(
                    (config) => String(config && config.id) === targetId,
                );
                if (currentIndex < 0 || currentConfigs[currentIndex].deleted) {
                    throw new Error("要覆盖的阵容已不存在");
                }
                const currentSavedConfig = currentConfigs[currentIndex];
                const preservedName =
                    currentSavedConfig.name ||
                    savedConfig.name ||
                    `阵容${configIndex + 1}`;
                const preservedMeta = {
                    id: currentSavedConfig.id || savedConfig.id,
                    name: preservedName,
                    createDate:
                        currentSavedConfig.createDate ||
                        savedConfig.createDate,
                };
                const overwrittenConfig = await buildCurrentSavedConfig(preservedMeta);
                if (getLineupStorageKey() !== initialStorageKey) {
                    throw new Error("覆盖期间账号已切换，本次覆盖已取消");
                }
                const latestConfigs = readAllSavedConfigs();
                const latestIndex = latestConfigs.findIndex(
                    (config) => String(config && config.id) === targetId,
                );
                if (latestIndex < 0 || latestConfigs[latestIndex].deleted) {
                    throw new Error("要覆盖的阵容已不存在");
                }
                latestConfigs[latestIndex] = overwrittenConfig;
                    writeSavedConfigs(latestConfigs);
                renderSavedConfigs();
                setStatusText("已覆盖当前保存", ["覆盖"]);
                SHOW_TIP("已用当前主线阵容覆盖此保存");
            } catch (error) {
                reportLineupActionFailure("覆盖", error);
            } finally {
                lineupRuntimeState.isSaving = false;
            }
        };
        appendChildren(panelWrapper, openerButton, panel);
        appendChildren(panelTitleGroup, panelTitle);
        appendChildren(headerRightTools, presetSlotBar, refreshButton, closeButton);
        appendChildren(panelHeader, panelTitleGroup, headerRightTools);
        appendChildren(
            headerButtons,
            saveButtonHeader,
            exportJsonButton,
            importJsonButton,
            importJsonInput,
        );
        appendChildren(headerActionRow, headerButtons);

        // 分组筛选栏 (全部 / PVP / PVE / 星级挑战)
        let currentGroupFilter = "all";
        const filterOptions = [
            { key: "all", label: "全部" },
            { key: "PVP", label: "⚔️ PVP", color: "#6d28d9", bg: "#f5f3ff", border: "#ddd6fe" },
            { key: "PVE", label: "🛡️ PVE", color: "#047857", bg: "#ecfdf5", border: "#a7f3d0" },
            { key: "星级挑战", label: "🌟 星级挑战", color: "#c2410c", bg: "#fff7ed", border: "#fed7aa" },
        ];

        const groupFilterBar = createDomNode("div", {
            cssText: `
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 1px 0 4px 0;
                width: 100%;
                box-sizing: border-box;
                overflow-x: auto;
                scrollbar-width: none;
            `,
        });

        const filterButtons = {};
        const updateFilterBtnStyles = () => {
            filterOptions.forEach(opt => {
                const btn = filterButtons[opt.key];
                if (!btn) return;
                if (opt.key === currentGroupFilter) {
                    if (opt.key === "all") {
                        btn.style.background = "#3b82f6";
                        btn.style.color = "#ffffff";
                        btn.style.borderColor = "#3b82f6";
                        btn.style.boxShadow = "0 1px 3px rgba(59, 130, 246, 0.3)";
                    } else {
                        btn.style.background = opt.bg;
                        btn.style.color = opt.color;
                        btn.style.borderColor = opt.border;
                        btn.style.boxShadow = `0 1px 3px ${opt.border}`;
                    }
                    btn.style.fontWeight = "700";
                } else {
                    btn.style.background = "#ffffff";
                    btn.style.color = "#64748b";
                    btn.style.borderColor = "#cbd5e1";
                    btn.style.boxShadow = "none";
                    btn.style.fontWeight = "600";
                }
            });
        };

        filterOptions.forEach(opt => {
            const btn = createDomNode("button", {
                text: opt.label,
                type: "button",
                cssText: `
                    flex: 1;
                    height: 25px;
                    padding: 0 4px;
                    border-radius: 6px;
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    border: 1px solid #cbd5e1;
                    background: #ffffff;
                    color: #64748b;
                    white-space: nowrap;
                    transition: all 0.15s ease;
                `,
                events: {
                    onclick: () => {
                        currentGroupFilter = opt.key;
                        updateFilterBtnStyles();
                        renderSavedConfigs();
                    },
                },
            });
            filterButtons[opt.key] = btn;
            appendChildren(groupFilterBar, btn);
        });
        updateFilterBtnStyles();

        // 保存弹窗组件
        let currentSelectedSaveGroup = "PVP";
        const saveModalOverlay = createDomNode("div", {
            id: "lineup-save-modal-overlay",
            cssText: `
                position: absolute;
                inset: 0;
                background: rgba(15, 23, 42, 0.45);
                backdrop-filter: blur(2px);
                z-index: 999;
                border-radius: 16px;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 16px;
                box-sizing: border-box;
            `,
        });

        const saveModalBox = createDomNode("div", {
            cssText: `
                background: #ffffff;
                border-radius: 14px;
                padding: 16px;
                width: 100%;
                max-width: 310px;
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.25), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
                border: 1px solid #e2e8f0;
                display: flex;
                flex-direction: column;
                gap: 12px;
                box-sizing: border-box;
            `,
        });

        const saveModalTitle = createDomNode("div", {
            html: '<div style="font-size:14px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:6px;"><span>💾</span><span>保存当前阵容</span></div>',
        });

        const nameField = createDomNode("div", {
            cssText: "display: flex; flex-direction: column; gap: 4px;",
        });
        const nameLabel = createDomNode("label", {
            text: "阵容名称",
            cssText: "font-size: 11.5px; font-weight: 600; color: #475569;",
        });
        const nameInput = createDomNode("input", {
            type: "text",
            id: "lineup-save-name-input",
            placeholder: "请输入阵容名称",
            cssText: `
                height: 32px;
                border: 1.5px solid #cbd5e1;
                border-radius: 8px;
                padding: 0 10px;
                font-size: 12px;
                color: #0f172a;
                outline: none;
                box-sizing: border-box;
                width: 100%;
                transition: border 0.15s;
            `,
        });
        nameInput.onfocus = () => { nameInput.style.borderColor = "#3b82f6"; };
        nameInput.onblur = () => { nameInput.style.borderColor = "#cbd5e1"; };
        appendChildren(nameField, nameLabel, nameInput);

        const groupField = createDomNode("div", {
            cssText: "display: flex; flex-direction: column; gap: 4px;",
        });
        const groupLabel = createDomNode("label", {
            text: "所属分组",
            cssText: "font-size: 11.5px; font-weight: 600; color: #475569;",
        });
        const groupBtnRow = createDomNode("div", {
            cssText: "display: flex; gap: 6px; width: 100%; box-sizing: border-box;",
        });

        const modalGroupButtons = {};
        const updateModalGroupBtnStyles = () => {
            filterOptions.filter(o => o.key !== "all").forEach(opt => {
                const btn = modalGroupButtons[opt.key];
                if (!btn) return;
                if (opt.key === currentSelectedSaveGroup) {
                    btn.style.background = opt.bg;
                    btn.style.color = opt.color;
                    btn.style.borderColor = opt.border;
                    btn.style.boxShadow = `0 1px 3px ${opt.border}`;
                    btn.style.fontWeight = "700";
                } else {
                    btn.style.background = "#f8fafc";
                    btn.style.color = "#64748b";
                    btn.style.borderColor = "#cbd5e1";
                    btn.style.boxShadow = "none";
                    btn.style.fontWeight = "600";
                }
            });
        };

        filterOptions.filter(o => o.key !== "all").forEach(opt => {
            const btn = createDomNode("button", {
                text: opt.label,
                type: "button",
                cssText: `
                    flex: 1;
                    height: 30px;
                    border-radius: 7px;
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    border: 1px solid #cbd5e1;
                    background: #f8fafc;
                    color: #64748b;
                    transition: all 0.15s;
                `,
                events: {
                    onclick: () => {
                        currentSelectedSaveGroup = opt.key;
                        updateModalGroupBtnStyles();
                    },
                },
            });
            modalGroupButtons[opt.key] = btn;
            appendChildren(groupBtnRow, btn);
        });
        appendChildren(groupField, groupLabel, groupBtnRow);

        const modalFooterRow = createDomNode("div", {
            cssText: "display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;",
        });

        const modalCancelBtn = createDomNode("button", {
            text: "取消",
            type: "button",
            cssText: `
                height: 30px;
                padding: 0 14px;
                border-radius: 8px;
                border: 1px solid #cbd5e1;
                background: #ffffff;
                color: #475569;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
            `,
            events: {
                onclick: () => closeSaveLineupDialog(),
            },
        });

        const modalConfirmBtn = createDomNode("button", {
            text: "💾 确认保存",
            type: "button",
            cssText: `
                height: 30px;
                padding: 0 16px;
                border-radius: 8px;
                border: none;
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: #ffffff;
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
                box-shadow: 0 2px 6px rgba(16, 185, 129, 0.3);
            `,
            events: {
                onclick: async () => {
                    const finalName = nameInput.value.trim() || `阵容${readSavedConfigs().length + 1}`;
                    const finalGroup = currentSelectedSaveGroup || "PVP";
                    modalConfirmBtn.disabled = true;
                    modalConfirmBtn.textContent = "正在保存...";
                    try {
                        lineupRuntimeState.isSaving = true;
                        saveButtonHeader.disabled = true;
                        setStatusText("正在保存...");
                        await saveCurrentConfig({
                            name: finalName,
                            group: finalGroup,
                        });
                        setStatusText("✅ 保存成功！", ["成功"]);
                        closeSaveLineupDialog();
                        renderSavedConfigs();
                    } catch (err) {
                        reportLineupActionFailure("保存", err);
                    } finally {
                        lineupRuntimeState.isSaving = false;
                        saveButtonHeader.disabled = false;
                        modalConfirmBtn.disabled = false;
                        modalConfirmBtn.textContent = "💾 确认保存";
                    }
                },
            },
        });

        nameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                modalConfirmBtn.click();
            } else if (e.key === "Escape") {
                closeSaveLineupDialog();
            }
        });

        appendChildren(modalFooterRow, modalCancelBtn, modalConfirmBtn);
        appendChildren(saveModalBox, saveModalTitle, nameField, groupField, modalFooterRow);
        appendChildren(saveModalOverlay, saveModalBox);

        function openSaveLineupDialog(defaultName, defaultGroup = "PVP") {
            nameInput.value = defaultName || "";
            currentSelectedSaveGroup = defaultGroup;
            updateModalGroupBtnStyles();
            saveModalOverlay.style.display = "flex";
            setTimeout(() => {
                nameInput.focus();
                nameInput.select();
            }, 60);
        };

        function closeSaveLineupDialog() {
            saveModalOverlay.style.display = "none";
        };

        function createConfigItem(savedConfig, configIndex, savedConfigs, isCurrentLineup = false) {
            const activeConfig = normalizeSavedConfig(savedConfig);
            const isCurrent = Boolean(isCurrentLineup);
            const cardElement = createDomNode("div", {
                cssText: `
                    background: ${isCurrent ? "linear-gradient(180deg, #f0f7ff 0%, #ffffff 100%)" : "#ffffff"};
                    border: ${isCurrent ? "1.5px solid #3b82f6" : "1px solid #e2e8f0"};
                    border-radius: 14px;
                    padding: 12px 12px 8px 12px;
                    margin-bottom: 8px;
                    box-shadow: ${isCurrent ? "0 4px 16px rgba(59, 130, 246, 0.16), 0 0 0 1px rgba(59, 130, 246, 0.15) inset" : "0 2px 6px rgba(15, 23, 42, 0.04)"};
                    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                `,
            });
            cardElement.onmouseover = () => {
                if (!isCurrent) {
                    cardElement.style.borderColor = "#cbd5e1";
                    cardElement.style.boxShadow = "0 6px 14px rgba(15, 23, 42, 0.08)";
                }
            };
            cardElement.onmouseout = () => {
                if (!isCurrent) {
                    cardElement.style.borderColor = "#e2e8f0";
                    cardElement.style.boxShadow = "0 2px 6px rgba(15, 23, 42, 0.04)";
                }
            };
            
            cardElement.innerHTML = buildLineupCardHtml(
                savedConfig,
                activeConfig,
                configIndex,
                isCurrentLineup,
            );
            hydrateLineupCardResources(cardElement, activeConfig);
            
            // 内联编辑功能（精准作用于文字，彻底剥离✏️图标）
            const nameContainer = cardElement.querySelector('.lineup-name-container') || cardElement.querySelector('.lineup-name');
            const nameTextEl = cardElement.querySelector('.lineup-name-text') || (nameContainer && nameContainer.querySelector('span'));
            const renameHintEl = cardElement.querySelector('.lineup-rename-hint');

            const startRename = () => {
                if (!nameTextEl) return;
                // 保存清洗后的纯净文本（过滤掉可能遗留的铅笔符号）
                nameTextEl.dataset.originalText = nameTextEl.textContent.replace(/✏️/g, '').trim();
                nameTextEl.textContent = nameTextEl.dataset.originalText;
                nameTextEl.contentEditable = "true";
                if (renameHintEl) renameHintEl.style.display = "none";
                nameTextEl.style.borderBottom = "1.5px dashed #3b82f6";
                nameTextEl.style.background = "#eff6ff";

                // 聚焦并将光标定位到最后面（不全选）
                nameTextEl.focus();
                const range = document.createRange();
                const selection = window.getSelection();
                range.selectNodeContents(nameTextEl);
                range.collapse(false); // 折叠到末尾，光标定在最后
                selection.removeAllRanges();
                selection.addRange(range);
            };

            // 点击容器或文字进入编辑模式
            if (nameContainer) {
                nameContainer.onclick = (e) => {
                    e.stopPropagation();
                    startRename();
                };
            }

            // 分组标签点击切换
            const groupBadgeEl = cardElement.querySelector('.lineup-group-badge');
            if (groupBadgeEl) {
                groupBadgeEl.onclick = (e) => {
                    e.stopPropagation();
                    const availableGroups = ["PVP", "PVE", "星级挑战"];
                    const curGroup = savedConfig.group || "PVP";
                    const nextIdx = (availableGroups.indexOf(curGroup) + 1) % availableGroups.length;
                    const nextGroup = availableGroups[nextIdx];
                    savedConfig.group = nextGroup;
                    savedConfig.updateDate = new Date().toISOString();
                    const allConfigs = readAllSavedConfigs();
                    const targetIdx = allConfigs.findIndex(c => String(c && c.id) === String(savedConfig.id));
                    if (targetIdx >= 0) {
                        allConfigs[targetIdx].group = nextGroup;
                        allConfigs[targetIdx].updateDate = savedConfig.updateDate;
                        writeSavedConfigs(allConfigs);
                        renderSavedConfigs();
                        setStatusText(`已将分组更改为「${nextGroup}」`, ["分组"]);
                    }
                };
            }

            if (nameTextEl) {
                // 失焦保存
                nameTextEl.onblur = () => {
                    nameTextEl.contentEditable = "false";
                    nameTextEl.style.borderBottom = "none";
                    nameTextEl.style.background = "transparent";
                    if (renameHintEl) renameHintEl.style.display = "inline";

                    const rawInput = nameTextEl.textContent.replace(/✏️/g, '').trim();
                    const newName = rawInput || nameTextEl.dataset.originalText || (savedConfig.name || '').replace(/✏️/g, '').trim() || `阵容${configIndex + 1}`;
                    nameTextEl.textContent = newName;

                    if (newName === nameTextEl.dataset.originalText) {
                        return;
                    }

                    const previousName = savedConfig.name;
                    const previousUpdateDate = savedConfig.updateDate;
                    try {
                        savedConfig.name = newName;
                        savedConfig.updateDate = new Date().toISOString();
                        writeVisibleSavedConfigs(savedConfigs);
                        statusText.textContent = "名称已保存";
                        setTimeout(() => statusText.textContent = "", 1500);
                    } catch (error) {
                        savedConfig.name = previousName;
                        savedConfig.updateDate = previousUpdateDate;
                        nameTextEl.textContent = previousName || `阵容${configIndex + 1}`;
                        reportLineupActionFailure("名称保存", error);
                    }
                };

                // 按 Enter 保存，按 Escape 取消
                nameTextEl.onkeydown = (e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        nameTextEl.blur();
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        nameTextEl.contentEditable = "false";
                        nameTextEl.style.borderBottom = "none";
                        nameTextEl.style.background = "transparent";
                        if (renameHintEl) renameHintEl.style.display = "inline";
                        nameTextEl.textContent = nameTextEl.dataset.originalText || savedConfig.name || `阵容${configIndex + 1}`;
                    }
                };
            }

            // 向上按钮点击事件
            const moveUpButton = cardElement.querySelector('[data-action="move-up"]');
            if (moveUpButton) {
                moveUpButton.onclick = (e) => {
                    e.stopPropagation();
                    const index = parseInt(moveUpButton.dataset.index);
                    if (index > 0) {
                        const temp = savedConfigs[index];
                        savedConfigs[index] = savedConfigs[index - 1];
                        savedConfigs[index - 1] = temp;
                        try {
                            writeVisibleSavedConfigs(savedConfigs);
                            renderSavedConfigs();
                            statusText.textContent = "阵容顺序已调整";
                            setTimeout(() => statusText.textContent = "", 1500);
                        } catch (error) {
                            savedConfigs[index - 1] = savedConfigs[index];
                            savedConfigs[index] = temp;
                            reportLineupActionFailure("顺序调整", error);
                        }
                    }
                };
            }

            // 向下按钮点击事件
            const moveDownButton = cardElement.querySelector('[data-action="move-down"]');
            if (moveDownButton) {
                moveDownButton.onclick = (e) => {
                    e.stopPropagation();
                    const index = parseInt(moveDownButton.dataset.index);
                    if (index < savedConfigs.length - 1) {
                        const temp = savedConfigs[index];
                        savedConfigs[index] = savedConfigs[index + 1];
                        savedConfigs[index + 1] = temp;
                        try {
                            writeVisibleSavedConfigs(savedConfigs);
                            renderSavedConfigs();
                            statusText.textContent = "阵容顺序已调整";
                            setTimeout(() => statusText.textContent = "", 1500);
                        } catch (error) {
                            savedConfigs[index + 1] = savedConfigs[index];
                            savedConfigs[index] = temp;
                            reportLineupActionFailure("顺序调整", error);
                        }
                    }
                };
            }
            
            const deleteButton = cardElement.querySelector('[data-action="delete"]');
            deleteButton.onclick = () => {
                try {
                    const allSavedConfigs = readAllSavedConfigs();
                    const targetId = savedConfig && savedConfig.id;
                    const deleteIndex = allSavedConfigs.findIndex(
                        (config) =>
                            String(config && config.id) === String(targetId),
                    );
                    const nowIso = new Date().toISOString();
                    if (deleteIndex < 0) {
                        throw new Error("要删除的阵容已不存在");
                    }
                    allSavedConfigs[deleteIndex] = {
                        ...allSavedConfigs[deleteIndex],
                        deleted: true,
                        deleteDate: nowIso,
                        updateDate: nowIso,
                    };
                    writeSavedConfigs(allSavedConfigs);
                    renderSavedConfigs();
                } catch (error) {
                    reportLineupActionFailure("删除", error);
                }
            };
            
            const switchButton = cardElement.querySelector('[data-action="switch"]');
            const overwriteButton = createDomNode("button", {
                text: "覆盖",
                title: "用当前主线阵容覆盖此保存",
                cssText: `
                    background: #f8fafc;
                    border: 1px solid #cbd5e1;
                    color: #475569;
                    padding: 5px 12px;
                    border-radius: 20px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.15s ease;
                `,
            });
            overwriteButton.onmouseover = () => {
                overwriteButton.style.background = "#e2e8f0";
                overwriteButton.style.color = "#0f172a";
            };
            overwriteButton.onmouseout = () => {
                overwriteButton.style.background = "#f8fafc";
                overwriteButton.style.color = "#475569";
            };
            if (switchButton && switchButton.parentNode) {
                switchButton.parentNode.insertBefore(overwriteButton, switchButton);
            }
            overwriteButton.onclick = async (event) => {
                event.stopPropagation();
                const configName =
                    (savedConfig && savedConfig.name) ||
                    `阵容${configIndex + 1}`;
                const confirmed = await showLineupConfirm(
                    "确定用当前阵容覆盖「" + configName + "」吗？",
                    {
                        title: "确认",
                        confirmText: "确定",
                        cancelText: "取消",
                    },
                );
                if (!confirmed) {
                    return;
                }
                await overwriteSavedConfig(savedConfig, configIndex, savedConfigs);
            };

            switchButton.dataset.lineupSwitch = "1";
            switchButton.dataset.originalText = "⟳ 切换";
            switchButton.onclick = async () => {
                const ServerData = window.__require("ServerData");
                const Configs = window.__require("Configs");
                const HeroModule = window
                    .__require("ModuleManager")
                    .GET_MODULE(Configs.ModuleType.HERO);
                const SHOW_TIP =
                    window.__require("TipsManager").SHOW_TIP;
                if (lineupRuntimeState.isSwitching) {
                    return;
                }
                if (lineupRuntimeState.isSaving) {
                    setStatusText("阵容正在保存，请稍候再切换", ["保存"]);
                    return;
                }
                lineupRuntimeState.isSwitching = true;
                setSwitchButtonsBusy(true, switchButton);
                switchButton.textContent = "切换中...";
                setPanelVisible(false);
                try {
                    const role = ServerData.ROLE;
                    const activeConfig = normalizeSavedConfig(savedConfig);
                    const skippedSwitchItems = [];
                    const runSwitchStep = async (itemName, action) => {
                        try {
                            await action();
                            return true;
                        } catch (error) {
                            const errorMessage =
                                error && error.message
                                    ? error.message
                                    : String(error);
                            skippedSwitchItems.push(itemName);
                            console.warn(
                                "[无限阵容] 已跳过" + itemName + "切换:",
                                errorMessage,
                                error,
                            );
                            return false;
                        }
                    };

                    // 切换卡槽
                    let presetTeamReady = true;
                    if (activeConfig.teamId) {
                        presetTeamReady = await runSwitchStep(
                            "卡槽",
                            async () => {
                                const currentTeamId = getCurrentPresetTeamId(role);
                                const targetTeamId = toNumber(
                                    activeConfig.teamId,
                                    0,
                                );
                                if (currentTeamId !== targetTeamId) {
                                    setStatusText(
                                        "🔄 正在切换到卡槽 " +
                                            targetTeamId +
                                            "...",
                                    );
                                    console.log(
                                        "[卡槽] 当前卡槽 " +
                                            currentTeamId +
                                            "，准备切换到卡槽 " +
                                            targetTeamId,
                                    );
                                    const didSave =
                                        await HeroModule.sendSavePresetTeam(
                                            targetTeamId,
                                        );
                                    if (!didSave) {
                                        throw new Error("切换卡槽失败");
                                    }
                                } else {
                                    console.log(
                                        "[卡槽] 当前已经在卡槽 " +
                                            targetTeamId +
                                            "，无需切换",
                                    );
                                }
                            },
                        );
                    }
                    
                    // 切换玩具（在卡槽之后）
                    if (activeConfig.weaponId !== undefined && activeConfig.weaponId !== null && activeConfig.weaponId !== 0) {
                        await runSwitchStep("玩具", async () => {
                            setStatusText("🔄 正在切换玩具...");
                            const currentWeaponId = role.lordWeaponId || 0;
                            console.log(`[玩具] 当前: ${currentWeaponId}, 目标: ${activeConfig.weaponId}`);
                            
                            if (currentWeaponId !== activeConfig.weaponId) {
                                const dataIndex = window.__require("data-index");
                                const LordWeaponService = dataIndex.LordWeaponService;
                                const weaponResult =
                                    await LordWeaponService.changeDefaultWeapon({
                                        weaponId: activeConfig.weaponId,
                                    });
                                if (
                                    weaponResult &&
                                    (Number(weaponResult.code) !== 0 || weaponResult.error)
                                ) {
                                    throw new Error(
                                        "玩具切换失败: " +
                                            (weaponResult.error || Number(weaponResult.code)),
                                    );
                                }
                                let weaponChanged = false;
                                for (let i = 0; i < 30; i++) {
                                    await sleep(100);
                                    if (
                                        toNumber(ServerData.ROLE.lordWeaponId, 0) ===
                                        toNumber(activeConfig.weaponId, 0)
                                    ) {
                                        weaponChanged = true;
                                        break;
                                    }
                                }
                                if (!weaponChanged) {
                                    throw new Error("玩具切换后状态校验失败");
                                }
                                console.log(`✅ 玩具切换成功`);
                                SHOW_TIP(`玩具已切换 (ID: ${activeConfig.weaponId})`);
                            }
                        });
                    }
                    
                    setStatusText("🔄 正在切换阵容...");
                    if (activeConfig.pet && toNumber(activeConfig.pet.petId, 0) > 0) {
                        await runSwitchStep("宠物", async () => {
                            setStatusText("正在切换宠物...");
                            await applyPetConfig(activeConfig.pet);
                        });
                    }
                    if (presetTeamReady) {
                        await runSwitchStep("阵容", async () => {
                            setStatusText("🔄 正在切换阵容...");
                            await applyTeamConfig(
                                activeConfig.team,
                                activeConfig.equipmentEnchant,
                                () => skippedSwitchItems.push("阵容"),
                            );
                        });
                        // 吸收岚山优点：英雄皮肤切换支持
                        await runSwitchStep("皮肤", async () => {
                            await applyHeroSkinConfig(
                                activeConfig.team,
                                () => skippedSwitchItems.push("皮肤"),
                            );
                        });
                    } else {
                        console.warn(
                            "[无限阵容] 卡槽未能切换，已跳过阵容，避免修改错误卡槽",
                        );
                        skippedSwitchItems.push("阵容");
                    }
                    await runSwitchStep("科技", async () => {
                        setStatusText("🔄 正在切换科技...");
                        await applyResearchConfig(
                            activeConfig.research,
                            (message) => {
                                setStatusText("🔄 " + message);
                            },
                            () => skippedSwitchItems.push("科技"),
                        );
                    });
                    
                    if (skippedSwitchItems.length > 0) {
                        const skippedSummary = Array.from(
                            new Set(skippedSwitchItems),
                        ).join("、");
                        setStatusText(
                            "⚠️ 切换完成，已跳过：" + skippedSummary,
                            ["跳过"],
                        );
                        SHOW_TIP("切换已完成，已跳过：" + skippedSummary);
                    } else {
                        setStatusText("✅ 切换完成！", ["完成"]);
                        SHOW_TIP("阵容与科技点切换完成");
                    }

                    // 吸收岚山优点：发射全局信号刷新推图阵位、武将列表与鱼灵队伍面板
                    refreshAllLineupSignals();
                } catch (error) {
                    console.error("[无限阵容] 切换失败:", error);
                    const errorMessage = error && error.message ? error.message : String(error);
                    setStatusText("❌ 切换失败：" + errorMessage, ["失败"]);
                    SHOW_TIP("阵容切换失败：" + errorMessage);
                } finally {
                    lineupRuntimeState.isSwitching = false;
                    setSwitchButtonsBusy(false);
                }
            };
            
            return cardElement;
        }
        function renderSavedConfigs() {
            let savedConfigs = [];
            try {
                updatePresetSlotButtons();
                savedConfigs = readSavedConfigs();
                if (currentGroupFilter && currentGroupFilter !== "all") {
                    savedConfigs = savedConfigs.filter(c => (c.group || "PVP") === currentGroupFilter);
                }
                logLineupDebug("renderSavedConfigs start", {
                    userId: getUserId(),
                    storageKey: getLineupStorageKey(),
                    count: savedConfigs.length,
                    ids: savedConfigs.slice(0, 8).map((config) => config && config.id),
                });
                configList.replaceChildren();
                if (savedConfigs.length === 0) {
                    const emptyTitle = (currentGroupFilter && currentGroupFilter !== "all")
                        ? `暂无【${currentGroupFilter}】分组的阵容`
                        : "暂无保存的阵容";
                    appendChildren(
                        configList,
                        createDomNode("div", {
                            html: `<div style="font-size:24px;margin-bottom:6px;">📋</div><div style="font-weight:700;color:#334155;margin-bottom:4px;">${emptyTitle}</div><div style="font-size:11px;color:#94a3b8;">点击上方【💾 保存当前】快速记录并归类阵容</div>`,
                            cssText: LINEUP_UI_STYLE.emptyState,
                        }),
                    );
                    queueSyncLineupPanelPosition(openerButton, panel);
                    return;
                }
                const currentIndex = findCurrentSavedConfigIndex(savedConfigs);
                const displayItems = getCurrentFirstSavedConfigItems(
                    savedConfigs,
                    currentIndex,
                );
                const nodes = [];
                displayItems.forEach(({ savedConfig, configIndex, isCurrentLineup }) => {
                    try {
                        nodes.push(
                            createConfigItem(
                                savedConfig,
                                configIndex,
                                savedConfigs,
                                isCurrentLineup,
                            ),
                        );
                    } catch (error) {
                        console.error("[LINEUP_DEBUG] createConfigItem failed", {
                            configIndex,
                            savedConfig,
                            error,
                        });
                        nodes.push(createDomNode("div", {
                            text: "阵容" + (configIndex + 1) + "显示失败：" + (error && error.message ? error.message : String(error)),
                            cssText: LINEUP_UI_STYLE.emptyState,
                        }));
                    }
                });
                appendChildren(configList, ...nodes);
                queueSyncLineupPanelPosition(openerButton, panel);
                logLineupDebug("renderSavedConfigs done", {
                    count: savedConfigs.length,
                    renderedCount: nodes.length,
                });
            } catch (error) {
                console.error("[LINEUP_DEBUG] renderSavedConfigs failed", error);
                configList.replaceChildren(
                    createDomNode("div", {
                        text: "阵容列表读取失败：" + (error && error.message ? error.message : String(error)),
                        cssText: LINEUP_UI_STYLE.emptyState,
                    }),
                );
                queueSyncLineupPanelPosition(openerButton, panel);
                setStatusText("阵容列表读取失败：" + (error && error.message ? error.message : String(error)), ["失败"]);
            }
        }
        const inlineDiffView = createLineupDiffInlineView();
        diffContainer = inlineDiffView.container;
        refreshDiffView = inlineDiffView.refresh;

        const inlineSevenColor = createSevenColorInlineView();
        sevenColorContainer = inlineSevenColor.container;
        refreshSevenColorInlineView = inlineSevenColor.refresh;

        appendChildren(
            panel,
            panelHeader,
            tabBar,
            headerActionRow,
            groupFilterBar,
            configList,
            diffContainer,
            sevenColorContainer,
            statusText,
            saveModalOverlay,
        );
        appendChildren(document.body, panelWrapper);
        try {
            window.__xbInfiniteLineupStatus = "mounted";
        } catch (error) {}
        lineupRuntimeState.renderSavedConfigs = renderSavedConfigs;
        renderSavedConfigs();
    }
    async function buildCurrentSavedConfig(savedConfigBase = {}) {
        await waitForEquipmentRuntimeRefresh();
        const ServerData = window.__require("ServerData");
        const role = ServerData.ROLE;
        const currentTeamId = getCurrentPresetTeamId(role);
        console.log(
            "[保存] 当前获取到的卡槽ID为: " + currentTeamId + "，ROLE对象为:",
            role,
        );
        const teamSnapshot = {};
        listCollectionEntries(role && role.battleTeam).forEach(([slotIndex, battleSlot]) => {
            slotIndex = toNumber(slotIndex, -1);
            if (slotIndex < 0 || !battleSlot) {
                return;
            }
            const visualSlotIndex = getBattleSlotPositionIndex(battleSlot, slotIndex);
            const currentHero = findLiveHeroByBattleSlot(role, battleSlot, slotIndex);
            const artifactState = getHeroArtifactStateFromHero(role, currentHero);
            const equipmentState = getHeroEquipmentState(currentHero);
            const trumpState = getHeroTrumpState(currentHero);
            const heroName =
                currentHero && (currentHero.nickName || currentHero.name)
                    ? currentHero.nickName || currentHero.name
                    : "";
            const heroSnapshot = {
                heroId: battleSlot.heroId,
                slotIndex,
                visualSlotIndex,
                positionIndex: visualSlotIndex,
                battleSlot: cloneSerializable(battleSlot),
                carrierMeta: getHeroCarrierMeta(currentHero),
                level: getHeroLevel(currentHero),
                order: getHeroOrder(currentHero),
                color: toNumber(currentHero ? currentHero.color : 0, 0),
                star: toNumber(currentHero ? currentHero.star : 0, 0),
                name: heroName,
                speed: getHeroSpeed(currentHero),
                power: getHeroPower(currentHero),
                artifactId: artifactState.artifactId,
                pearlId: artifactState.pearlId,
                pearlSkillId: artifactState.pearlSkillId,
                pearl: artifactState.pearl,
                curTrump: trumpState.trumpId,
                trumpId: trumpState.trumpId,
                trumpId2: trumpState.trumpId2,
                transTrumpId: trumpState.transTrumpId,
                trump: trumpState,
                equipment: equipmentState,
                attachmentUid: getHeroUid(currentHero),
                bindingMode: "equipment-ledger-v1",
                containerId: getHeroUid(currentHero),
                appendSkill: getHeroAppendSkillState(currentHero, artifactState.pearlSkillId),
                useSkin: toNumber(currentHero ? currentHero.useSkin : -1, -1),
            };
            teamSnapshot[slotIndex] = heroSnapshot;
        });

        const researchSnapshot = {};
        listCollectionEntries(role && role.legionResearch).forEach(([researchId, researchLevel]) => {
            researchSnapshot[researchId] = researchLevel;
        });
        const nowIso = new Date().toISOString();
        const formation = buildFormationFromLiveRole(
            role,
            teamSnapshot,
            researchSnapshot,
            currentTeamId,
        );
        return {
            id: savedConfigBase.id || createLineupConfigId(),
            name: savedConfigBase.name || "",
            group: savedConfigBase.group || "PVP",
            formation,
            team: teamSnapshot,
            research: researchSnapshot,
            teamId: currentTeamId,
            weaponId: toNumber(role && role.lordWeaponId, 0),
            pet: cloneSerializable(formation.pet),
            equipmentEnchant: cloneSerializable(formation.equipmentEnchant),
            createDate: savedConfigBase.createDate || nowIso,
            updateDate: nowIso,
        };
    }
    async function saveCurrentConfig(options = {}) {
        const SHOW_TIP = window.__require("TipsManager").SHOW_TIP;
        const initialStorageKey = getLineupStorageKey();
        const initialConfigs = readAllSavedConfigs();
        const visibleCount = initialConfigs.filter(
            (config) => !(config && config.deleted),
        ).length;
        logLineupDebug("saveCurrentConfig before build", {
            userId: getUserId(),
            storageKey: getLineupStorageKey(),
            allCount: initialConfigs.length,
            visibleCount,
        });
        const savedConfig = await buildCurrentSavedConfig({
            name: options.name || `阵容${visibleCount + 1}`,
            group: options.group || "PVP",
        });
        logLineupDebug("saveCurrentConfig built", {
            id: savedConfig && savedConfig.id,
            name: savedConfig && savedConfig.name,
            teamId: savedConfig && savedConfig.teamId,
            teamSlots: savedConfig && savedConfig.team ? Object.keys(savedConfig.team) : [],
            hasFormation: !!(savedConfig && savedConfig.formation),
        });
        if (getLineupStorageKey() !== initialStorageKey) {
            throw new Error("保存期间账号已切换，本次保存已取消");
        }
        const latestConfigs = readAllSavedConfigs();
        latestConfigs.unshift(savedConfig);
        writeSavedConfigs(latestConfigs);
        const readBackConfigs = readAllSavedConfigs();
        const readBackSavedConfig = readBackConfigs.find(
            (config) => String(config && config.id) === String(savedConfig.id),
        );
        logLineupDebug("saveCurrentConfig readback", {
            userId: getUserId(),
            storageKey: getLineupStorageKey(),
            readBackCount: readBackConfigs.length,
            firstId: readBackConfigs[0] && readBackConfigs[0].id,
            firstName: readBackConfigs[0] && readBackConfigs[0].name,
        });
        if (
            !readBackSavedConfig ||
            readBackSavedConfig.updateDate !== savedConfig.updateDate
        ) {
            throw new Error("阵容写入后校验失败，数据未保存");
        }
        console.log("已保存阵容数据", savedConfig);
        SHOW_TIP("阵容与科技已保存至本地");
    }
    async function rebirthHero(heroId) {
        await sendHeroRebirthByService(heroId);
    }
    async function upgradeHeroToTarget(
        heroId,
        targetLevel,
        targetOrder,
        currentLevel,
        shouldEnforceTargetOrder = false,
        targetSlotConfig = null,
    ) {
        const ServerData = window.__require("ServerData");
        const resolveLiveHero = () =>
            resolveLiveHeroForTargetSlot(ServerData.ROLE, targetSlotConfig) ||
            ServerData.ROLE.getHeroById(heroId);
        let workingLevel = currentLevel;
        let workingOrder = 0;
        let liveHero = resolveLiveHero();
        if (liveHero) {
            workingOrder = toNumber(liveHero.order, 0);
            workingLevel = getHeroLevel(liveHero);
        }
        console.log(
            "[武将] 开始将武将 " +
                heroId +
                " 从 " +
                workingLevel +
                "级(" +
                workingOrder +
                "阶) 调整到目标状态 " +
                targetLevel +
                "级(" +
                targetOrder +
                "阶)",
        );
        const levelCapByOrder = {
            0: 100,
            1: 100,
            2: 200,
            3: 300,
            4: 500,
            5: 700,
            6: 900,
            7: 1100,
            8: 1300,
            9: 1500,
            10: 1800,
            11: 2100,
            12: 2400,
            13: 2800,
            14: 3200,
            15: 3600,
            16: 4000,
            17: 4500,
            18: 5000,
            19: 5500,
            20: 6000,
        };
        function getOrderLevelCap(order) {
            const nextOrder = order + 1;
            if (levelCapByOrder[nextOrder]) {
                return levelCapByOrder[nextOrder];
            }
            return 6000;
        }
        while (
            workingLevel < targetLevel ||
            (shouldEnforceTargetOrder && workingOrder < targetOrder)
        ) {
            const currentOrderLevelCap = getOrderLevelCap(workingOrder);
            const needsOrderUpgrade =
                shouldEnforceTargetOrder && workingOrder < targetOrder;
            if (needsOrderUpgrade && workingLevel >= currentOrderLevelCap) {
                console.log(
                    "[武将] 武将 " +
                        heroId +
                        " 当前状态(" +
                        workingLevel +
                        "级/" +
                        workingOrder +
                        "阶) 已满足进阶条件，准备向目标阶数 " +
                        targetOrder +
                        " 推进...",
                );
                await sendHeroStageUpByService(heroId);
                liveHero = resolveLiveHero();
                const nextOrder = getHeroOrder(liveHero);
                if (nextOrder <= workingOrder) {
                    throw new Error("武将 " + heroId + " 进阶失败");
                }
                workingOrder = nextOrder;
                workingLevel = getHeroLevel(liveHero);
                continue;
            }
            if (workingLevel >= targetLevel) {
                console.log(
                    "[武将] 武将 " +
                        heroId +
                        " 已达到目标等级，但未满足目标阶数 " +
                        targetOrder +
                        "，停止修正。",
                );
                break;
            }
            if (workingLevel >= currentOrderLevelCap) {
                console.log(
                    "[武将] 武将 " +
                        heroId +
                        " 当前等级(" +
                        workingLevel +
                        ")已达到 " +
                        workingOrder +
                        "阶 上限(" +
                        currentOrderLevelCap +
                        ")，正在发送进阶命令...",
                );
                await sendHeroStageUpByService(heroId);
                liveHero = resolveLiveHero();
                const nextOrder = getHeroOrder(liveHero);
                if (nextOrder <= workingOrder) {
                    throw new Error("武将 " + heroId + " 进阶失败");
                }
                workingOrder = nextOrder;
                workingLevel = getHeroLevel(liveHero);
                console.log(
                    "[武将] 武将 " +
                        heroId +
                        " 进阶成功，当前阶数: " +
                        workingOrder,
                );
                continue;
            }
            const remainingLevelSteps =
                Math.min(targetLevel, currentOrderLevelCap) - workingLevel;
            let upgradeBatchSize = 1;
            if (remainingLevelSteps >= 50) {
                upgradeBatchSize = 50;
            } else if (remainingLevelSteps >= 10) {
                upgradeBatchSize = 10;
            } else if (remainingLevelSteps >= 5) {
                upgradeBatchSize = 5;
            } else {
                upgradeBatchSize = 1;
            }
            await sendHeroUpgradeLevelByService(heroId, upgradeBatchSize);
            liveHero = resolveLiveHero();
            const nextLevel = getHeroLevel(liveHero);
            if (nextLevel <= workingLevel) {
                throw new Error("武将 " + heroId + " 升级失败");
            }
            workingLevel = nextLevel;
            workingOrder = getHeroOrder(liveHero);
        }
        console.log(
            "[武将] 武将 " +
                heroId +
                " 升级流程结束，最终状态: " +
                workingLevel +
                "级 (" +
                workingOrder +
                "阶)",
        );
    }
    async function runBestEffortSwitchAction(
        scopeName,
        itemName,
        onSkip,
        action,
    ) {
        try {
            await action();
            return true;
        } catch (error) {
            const errorMessage =
                error && error.message ? error.message : String(error);
            console.warn(
                "[" + scopeName + "] 已跳过" + itemName + ":",
                errorMessage,
                error,
            );
            if (typeof onSkip === "function") {
                try {
                    onSkip(itemName, errorMessage);
                } catch (callbackError) {
                    console.warn("[无限阵容] 跳过项回调失败:", callbackError);
                }
            }
            return false;
        }
    }
    async function applyHeroBatchSetLevel(targetTeam, onSkip) {
        const requireFn = window.__require;
        if (typeof requireFn !== "function") return false;
        const dataIndex = requireFn("data-index");
        const heroService = dataIndex && dataIndex.HeroService;
        if (!heroService || typeof heroService.batchSetLevel !== "function") {
            return false;
        }
        const ServerData = requireFn("ServerData");
        const role = ServerData && ServerData.ROLE;
        if (!role) return false;

        const levelMap = new Map();
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const slotConfig = targetTeam[slotIndex];
            if (slotConfig && slotConfig.heroId) {
                const targetSlotState = buildTargetSlotRestoreState(slotConfig);
                const targetLevel = targetSlotState.level || 1;
                const currentHero = resolveLiveHeroForTargetSlot(role, slotConfig) || (role.getHeroById && role.getHeroById(slotConfig.heroId));
                const currentLevel = getHeroLevel(currentHero);
                if (currentLevel !== targetLevel) {
                    levelMap.set(Number(slotConfig.heroId), Number(targetLevel));
                }
            }
        }

        if (levelMap.size === 0) {
            console.log("[武将] 所有武将等级已与目标一致，无需批量调级");
            return true;
        }

        console.log("[武将] 正在通过官方 HeroService.batchSetLevel 批量调级 (吸收自岚山核心协议)...", Array.from(levelMap.entries()));

        // 上限检查
        const HeroModuleExports = requireFn("HeroModule");
        const HeroModule = HeroModuleExports && HeroModuleExports.HeroModule;
        if (HeroModule && typeof HeroModule.getLimitLevel === "function") {
            for (const [heroId, targetLevel] of levelMap.entries()) {
                const limitLevel = Number(HeroModule.getLimitLevel(heroId));
                if (Number.isFinite(limitLevel) && targetLevel > limitLevel) {
                    console.warn(`[武将] 武将 ${heroId} 目标等级 ${targetLevel} 超过官方上限 ${limitLevel}，已自动调整为 ${limitLevel}`);
                    levelMap.set(heroId, limitLevel);
                }
            }
        }

        // 检查需要调级的武将是否在当前阵型中（若未上阵，借用临时槽位上阵以确保服务端响应生效）
        const battleTeam = role.battleTeam;
        const currentHeroIds = new Set();
        if (battleTeam) {
            listCollectionEntries(battleTeam).forEach(([s, bs]) => {
                if (bs && bs.heroId) currentHeroIds.add(Number(bs.heroId));
            });
        }

        let temporarySlot = null;
        let originalHeroId = null;
        const missingHeroId = Array.from(levelMap.keys()).find(id => !currentHeroIds.has(id));
        if (missingHeroId !== undefined && typeof heroService.goIntoBattle === "function") {
            const slots = [0, 1, 2, 3, 4];
            temporarySlot = slots.find(s => !battleTeam || !battleTeam[s] || !battleTeam[s].heroId);
            if (temporarySlot === undefined) temporarySlot = 4;
            originalHeroId = battleTeam && battleTeam[temporarySlot] ? battleTeam[temporarySlot].heroId : null;
            try {
                console.log(`[武将] 调级武将 ${missingHeroId} 暂未上阵，临时借用槽位 ${temporarySlot} (原武将: ${originalHeroId})`);
                await heroService.goIntoBattle({ slot: temporarySlot, heroId: missingHeroId });
                await sleep(100);
            } catch (tempErr) {
                console.warn("[武将] 临时上阵失败，尝试直接发送调级请求", tempErr);
                temporarySlot = null;
            }
        }

        try {
            const response = await heroService.batchSetLevel({ levelMap });
            if (response && (Number(response.code) !== 0 || response.error)) {
                throw new Error(response.error || ("错误代码: " + response.code));
            }
            // 刷新本地 speedControlData
            const Configs = requireFn("Configs");
            const ModuleManager = requireFn("ModuleManager");
            const heroModule = ModuleManager && ModuleManager.GET_MODULE && ModuleManager.GET_MODULE(Configs && Configs.ModuleType && Configs.ModuleType.HERO);
            const speedControlData = heroModule && heroModule.speedControlData;
            if (response && response.rawData && speedControlData && speedControlData.batchSetLevelResp) {
                if (typeof speedControlData.batchSetLevelResp.reset === "function") {
                    speedControlData.batchSetLevelResp.reset();
                }
                if (typeof speedControlData.batchSetLevelResp.setValue === "function") {
                    speedControlData.batchSetLevelResp.setValue(response.rawData);
                }
            }
            console.log("[武将] ✅ 官方批量调级 (batchSetLevel) 成功完成！");
            return true;
        } finally {
            if (temporarySlot !== null) {
                try {
                    if (originalHeroId !== null && originalHeroId !== undefined) {
                        await heroService.goIntoBattle({ slot: temporarySlot, heroId: originalHeroId });
                    } else if (typeof heroService.goBackBattle === "function") {
                        await heroService.goBackBattle({ slot: temporarySlot });
                    }
                    await sleep(100);
                } catch (restoreErr) {
                    console.warn("[武将] 恢复原槽位武将异常", restoreErr);
                }
            }
        }
    }
    async function applyHeroSkinConfig(targetTeam, onSkip = null) {
        const requireFn = window.__require;
        if (typeof requireFn !== "function") return;
        const dataIndex = requireFn("data-index");
        const HeroService = dataIndex && dataIndex.HeroService;
        if (!HeroService || typeof HeroService.useSkin !== "function") return;
        const ServerData = requireFn("ServerData");
        const role = ServerData && ServerData.ROLE;
        if (!role) return;

        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const slotConfig = targetTeam[slotIndex];
            if (!slotConfig || !slotConfig.heroId) continue;
            const targetSkinId = toNumber(slotConfig.useSkin, -1);
            if (targetSkinId < 0) continue;
            const currentHero = resolveLiveHeroForTargetSlot(role, slotConfig) || (role.getHeroById && role.getHeroById(slotConfig.heroId));
            const currentSkinId = toNumber(currentHero && currentHero.useSkin, 0);
            if (currentSkinId !== targetSkinId) {
                await runBestEffortSwitchAction(
                    "皮肤",
                    `武将 ${slotConfig.heroId} 皮肤`,
                    onSkip,
                    async () => {
                        console.log(`[皮肤] 正在切换武将 ${slotConfig.heroId} 皮肤: ${currentSkinId} -> ${targetSkinId}`);
                        const result = await HeroService.useSkin({
                            heroId: Number(slotConfig.heroId),
                            skinId: Number(targetSkinId),
                        });
                        if (result && (Number(result.code) !== 0 || result.error)) {
                            throw new Error(result.error || ("错误代码: " + result.code));
                        }
                    }
                );
            }
        }
    }
    function refreshAllLineupSignals() {
        try {
            const requireFn = window.__require;
            if (typeof requireFn !== "function") return;
            const GlobalSignal = requireFn("GlobalSignal");
            if (GlobalSignal) {
                if (GlobalSignal.SyncBattleTeam && typeof GlobalSignal.SyncBattleTeam.emit === "function") {
                    GlobalSignal.SyncBattleTeam.emit();
                }
                if (GlobalSignal.SyncHeroArtifact && typeof GlobalSignal.SyncHeroArtifact.emit === "function") {
                    GlobalSignal.SyncHeroArtifact.emit();
                }
                if (GlobalSignal.SyncHeroList && typeof GlobalSignal.SyncHeroList.emit === "function") {
                    GlobalSignal.SyncHeroList.emit();
                }
                if (GlobalSignal.EventRefreshHeroTeamPanel && typeof GlobalSignal.EventRefreshHeroTeamPanel.emit === "function") {
                    GlobalSignal.EventRefreshHeroTeamPanel.emit();
                }
                if (GlobalSignal.LevelBattleReset && typeof GlobalSignal.LevelBattleReset.emit === "function") {
                    GlobalSignal.LevelBattleReset.emit();
                }
            }
            const RoleService = requireFn("data-index") && requireFn("data-index").RoleService;
            if (RoleService && typeof RoleService.getRoleInfo === "function") {
                RoleService.getRoleInfo({});
            }
            console.log("[刷新] ✅ 全局阵容与队伍界面刷新信号发射完成");
        } catch (e) {
            console.warn("[刷新] 刷新信号发射失败:", e);
        }
    }
    async function applyTeamConfig(
        targetTeamConfig,
        equipmentEnchantConfig = null,
        onSkip = null,
    ) {
        const ServerData = window.__require("ServerData");
        const targetTeam = targetTeamConfig || {};
        console.log("[阵容] 开始恢复养成载体...");
        const restoredCarriers =
            await restoreHeroCultivationCarriers(targetTeam);
        if (!restoredCarriers) {
            const hasEquipmentSnapshot = Object.keys(targetTeam).some(
                (slotKey) => {
                    const slotConfig = targetTeam[slotKey];
                    return !!(slotConfig && slotConfig.equipment);
                },
            );
            if (hasEquipmentSnapshot) {
                throw new Error(
                    "恢复养成载体失败：无法区分同名/同 ID 武将的装备载体",
                );
            }
            console.log(
                "[阵容] 未能通过 attachmentUid/装备指纹恢复养成载体，旧存档回退为按 heroId 恢复。",
            );
            const restoredByHeroId =
                await restoreBattleHeroesByExchange(targetTeam);
            if (!restoredByHeroId) {
                throw new Error("恢复养成载体失败");
            }
        }
        console.log("[阵容] 养成载体恢复完成，开始按目标修正等级和阶数...");
        let batchSuccess = false;
        try {
            batchSuccess = await applyHeroBatchSetLevel(targetTeam, onSkip);
        } catch (batchErr) {
            console.warn("[武将] 官方批量调级异常，将使用传统逐阶升级/重生流程回退", batchErr);
            batchSuccess = false;
        }

        if (!batchSuccess) {
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const targetSlotConfig = targetTeam[slotIndex];
                if (targetSlotConfig && targetSlotConfig.heroId) {
                    await runBestEffortSwitchAction(
                        "阵容",
                        "位置 " + (slotIndex + 1) + " 武将重置",
                        onSkip,
                        async () => {
                            const targetSlotState =
                                buildTargetSlotRestoreState(targetSlotConfig);
                            const targetLevel = targetSlotState.level || 1;
                            const targetOrder = targetSlotState.order || 0;
                            const currentHero = resolveLiveHeroForTargetSlot(
                                ServerData.ROLE,
                                targetSlotConfig,
                            );
                            const currentLevel = getHeroLevel(currentHero);
                            const currentOrder = getHeroOrder(currentHero);
                            if (
                                currentLevel > targetLevel ||
                                (targetSlotState.hasOrder && currentOrder > targetOrder)
                            ) {
                                console.log(
                                    "[武将] 发现位置 " +
                                        slotIndex +
                                        " 武将 " +
                                        targetSlotConfig.heroId +
                                        " 当前状态(" +
                                        currentLevel +
                                        "级/" +
                                        currentOrder +
                                        "阶) 高于目标状态(" +
                                        targetLevel +
                                        "级/" +
                                        targetOrder +
                                        "阶)，准备重置。",
                                );
                                const battleSlot = toNumber(
                                    currentHero && currentHero.battleTeamSlot,
                                    -1,
                                );
                                if (battleSlot >= 0) {
                                    await goBackBattleFromSlot(battleSlot);
                                }
                                await rebirthHero(targetSlotConfig.heroId);
                            }
                        }
                    );
                }
            }
            for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
                const targetSlotConfig = targetTeam[slotIndex];
                if (targetSlotConfig && targetSlotConfig.heroId) {
                    await runBestEffortSwitchAction(
                        "阵容",
                        "位置 " + (slotIndex + 1) + " 武将升级",
                        onSkip,
                        async () => {
                            const targetSlotState =
                                buildTargetSlotRestoreState(targetSlotConfig);
                            const targetLevel = targetSlotState.level || 1;
                            const targetOrder = targetSlotState.order || 0;
                            const currentHero = resolveLiveHeroForTargetSlot(
                                ServerData.ROLE,
                                targetSlotConfig,
                            );
                            const currentLevel = getHeroLevel(currentHero);
                            const currentOrder = getHeroOrder(currentHero);
                            if (
                                currentLevel < targetLevel ||
                                (targetSlotState.hasOrder && currentOrder < targetOrder)
                            ) {
                                console.log(
                                    "[武将] 发现位置 " +
                                        slotIndex +
                                        " 武将 " +
                                        targetSlotConfig.heroId +
                                        " 状态(" +
                                        currentLevel +
                                        "级/" +
                                        currentOrder +
                                        "阶) 低于目标状态(" +
                                        targetLevel +
                                        "级/" +
                                        targetOrder +
                                        "阶)，正在补充升级/进阶...",
                                );
                                await upgradeHeroToTarget(
                                    targetSlotConfig.heroId,
                                    targetLevel,
                                    targetSlotState.order,
                                    currentLevel,
                                    targetSlotState.hasOrder,
                                    targetSlotConfig,
                                );
                            }
                        },
                    );
                }
            }
        } else {
            console.log("[阵容] 武将等级已由批量调级 (batchSetLevel) 极速完成！");
        }
        console.log("[阵容] 等级与阶数修正完成，开始修正鱼灵与鱼珠...");
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const targetSlotConfig = targetTeam[slotIndex];
            if (targetSlotConfig && targetSlotConfig.heroId) {
                await runBestEffortSwitchAction(
                    "阵容",
                    "位置 " + (slotIndex + 1) + " 鱼灵",
                    onSkip,
                    () => applyArtifactConfig(targetSlotConfig),
                );
            }
        }
        await runBestEffortSwitchAction(
            "阵容",
            "鱼珠数据刷新",
            onSkip,
            () => waitForPearlRuntimeRefresh(),
        );
        console.log("[阵容] 鱼灵挂载完成，开始按交换优先恢复鱼珠技能...");
        await runBestEffortSwitchAction(
            "阵容",
            "鱼珠技能交换",
            onSkip,
            () => restorePearlSkillsByExchange(targetTeam),
        );
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const targetSlotConfig = targetTeam[slotIndex];
            if (targetSlotConfig && targetSlotConfig.heroId) {
                await runBestEffortSwitchAction(
                    "阵容",
                    "位置 " + (slotIndex + 1) + " 鱼珠技能",
                    onSkip,
                    () => applyPearlSkillConfig(targetSlotConfig),
                );
            }
        }
        console.log("[阵容] 鱼灵与鱼珠修正完成，开始修正淬炼翻面...");
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const targetSlotConfig = targetTeam[slotIndex];
            if (targetSlotConfig && targetSlotConfig.heroId) {
                await runBestEffortSwitchAction(
                    "阵容",
                    "位置 " + (slotIndex + 1) + " 淬炼翻面",
                    onSkip,
                    () => applyQuenchFlipConfig(targetSlotConfig),
                );
            }
        }
        console.log("[阵容] 淬炼翻面修正完成，开始修正装备赐福...");
        if (equipmentEnchantConfig) {
            await runBestEffortSwitchAction(
                "阵容",
                "装备赐福",
                onSkip,
                async () => {
                    await applyEquipmentEnchantConfig(
                        equipmentEnchantConfig,
                        targetTeam,
                    );
                    await waitForEquipmentRuntimeRefresh();
                },
            );
        }
        console.log("[阵容] 装备赐福修正完成，开始修正梦魇水晶翻面...");
        for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
            const targetSlotConfig = targetTeam[slotIndex];
            if (targetSlotConfig && targetSlotConfig.heroId) {
                await runBestEffortSwitchAction(
                    "阵容",
                    "位置 " + (slotIndex + 1) + " 梦魇水晶翻面",
                    onSkip,
                    () => applyTrumpFlipConfig(targetSlotConfig),
                );
            }
        }
        console.log("[阵容] 养成状态恢复完成，开始恢复最终站位...");
        await runBestEffortSwitchAction(
            "阵容",
            "最终站位",
            onSkip,
            async () => {
                const finalBattleTeamRestored =
                    await restoreFinalBattleTeam(targetTeam);
                if (!finalBattleTeamRestored) {
                    throw new Error("恢复最终阵位失败");
                }
            },
        );
    }
    function createResearchProgressNotifier(onProgress) {
        const SHOW_TIP = window.__require("TipsManager").SHOW_TIP;
        let lastTipAt = 0;
        return (message, force = false) => {
            if (typeof onProgress === "function") {
                onProgress(message);
            }
            const now = Date.now();
            if (force || now - lastTipAt >= 1200) {
                SHOW_TIP(message);
                lastTipAt = now;
            }
        };
    }
    async function waitForResearchLevelAtLeast(
        researchId,
        minimumLevel,
        maxAttempts = 8,
    ) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const currentLevel = getResearchLevel(
                window.__require("ServerData").ROLE,
                researchId,
            );
            if (currentLevel >= minimumLevel) {
                return currentLevel;
            }
            await sleep(100);
        }
        return getResearchLevel(
            window.__require("ServerData").ROLE,
            researchId,
        );
    }
    async function resetResearchBranch(researchType, isAdvanced, notifyResearchProgress) {
        const LegionService = window.__require("data-index").LegionService;
        const SHOW_TIP = window.__require("TipsManager").SHOW_TIP;
        const resetResult = await LegionService.resetResearch({
            type: researchType,
            advanced: isAdvanced,
        });
        if (resetResult.code !== 0) {
            const errorMessage =
                "科技职业 " + researchType + " 重置失败: " + resetResult.code;
            if (typeof notifyResearchProgress === "function") {
                notifyResearchProgress(errorMessage, true);
            } else {
                SHOW_TIP("重置失败: " + resetResult.code);
            }
            throw new Error("科技职业 " + researchType + " 重置失败");
        }
        if (typeof notifyResearchProgress === "function") {
            notifyResearchProgress("科技职业 " + researchType + " 重置成功", true);
        } else {
            SHOW_TIP("重置成功");
        }
    }
    async function applyResearchConfig(targetResearchConfig, onProgress, onSkip = null) {
        const ServerData = window.__require("ServerData");
        const Configs = window.__require("Configs");
        const LegionService = window.__require("data-index").LegionService;
        const notifyResearchProgress =
            createResearchProgressNotifier(onProgress);
        if (!targetResearchConfig || Object.keys(targetResearchConfig).length === 0) {
            notifyResearchProgress("当前保存没有科技数据，跳过科技恢复", true);
            return;
        }
        notifyResearchProgress("开始恢复科技...", true);
        const role = ServerData.ROLE;
        // 吸收岚山优点：精准区分普通科技与高级科技，避免盲目重置整个职业
        const normalResetWorks = new Set();
        const advancedResetWorks = new Set();
        listCollectionEntries(role.legionResearch).forEach(
            ([researchId, currentLevel]) => {
                const currentResearchLevel = toNumber(currentLevel, 0);
                if (currentResearchLevel <= 0) {
                    return;
                }
                const targetLevel = toNumber(
                    targetResearchConfig[researchId],
                    0,
                );
                if (targetLevel < currentResearchLevel) {
                    const researchConfig = Configs.ResearchConf.getByID(
                        toNumber(researchId, 0),
                    );
                    if (researchConfig && researchConfig.work !== undefined) {
                        const isAdvanced = Boolean(researchConfig.advanced);
                        if (isAdvanced) {
                            advancedResetWorks.add(researchConfig.work);
                        } else {
                            normalResetWorks.add(researchConfig.work);
                        }
                    } else {
                        console.warn("[科技] 找不到科技配置，跳过重置:", researchId);
                    }
                }
            },
        );
        if (normalResetWorks.size > 0 || advancedResetWorks.size > 0) {
            notifyResearchProgress(
                `检测到科技降级，需重置 ${normalResetWorks.size} 个职业普通科技, ${advancedResetWorks.size} 个职业高级科技`,
                true,
            );
            console.log(
                "[科技] 精准分析科技差异结果: 普通科技需重置",
                Array.from(normalResetWorks),
                "高级科技需重置",
                Array.from(advancedResetWorks),
            );
            // 步骤 2a: 重置普通科技
            for (const workType of normalResetWorks) {
                console.log("[科技] 正在自动重置职业 " + workType + " 普通科技 (归还普通科技点)");
                notifyResearchProgress("正在重置职业 " + workType + " 普通科技...", true);
                await runBestEffortSwitchAction(
                    "科技",
                    "职业 " + workType + " 普通科技重置",
                    onSkip,
                    () =>
                        resetResearchBranch(
                            workType,
                            false,
                            notifyResearchProgress,
                        ),
                );
            }
            // 步骤 2b: 重置高级科技
            for (const workType of advancedResetWorks) {
                console.log("[科技] 正在自动重置职业 " + workType + " 高级科技 (归还高级科技点)");
                notifyResearchProgress("正在重置职业 " + workType + " 高级科技...", true);
                await runBestEffortSwitchAction(
                    "科技",
                    "职业 " + workType + " 高级科技重置",
                    onSkip,
                    () =>
                        resetResearchBranch(
                            workType,
                            true,
                            notifyResearchProgress,
                        ),
                );
            }
        } else {
            console.log("[科技] 检测到无任何降级需求，直接增量升级科技 (零重置，保留全部已有科技点)");
        }
        let upgradedResearchCount = 0;
        const sortedResearchIds = Object.keys(targetResearchConfig)
            .map(Number)
            .sort((left, right) => left - right);
        for (const researchId of sortedResearchIds) {
            await runBestEffortSwitchAction(
                "科技",
                "科技 " + researchId,
                onSkip,
                async () => {
                    const targetLevel = toNumber(targetResearchConfig[researchId], 0);
                    let currentLevel = getResearchLevel(ServerData.ROLE, researchId);
                    if (currentLevel >= targetLevel) {
                        return;
                    }
                    const researchConfig = Configs.ResearchConf.getByID(researchId);
                    if (!researchConfig) {
                        throw new Error("找不到科技配置");
                    }
                    const researchMaxLevel = researchConfig.researchMaxLevel;
                    const effectiveTargetLevel = Math.min(
                        targetLevel,
                        researchMaxLevel,
                    );
                if (effectiveTargetLevel >= researchMaxLevel) {
                    notifyResearchProgress(
                        "正在一键升级科技 " +
                            researchId +
                            " 到 " +
                            effectiveTargetLevel +
                            " 级",
                        true,
                    );
                    console.log(
                        "[科技] 正在自动升级科技 " +
                            researchId +
                            " (目标: " +
                            effectiveTargetLevel +
                            ", 满级: " +
                            researchMaxLevel +
                            ") - 使用一键满级",
                    );
                    const upgradeResult = await LegionService.research({
                        researchId: researchId,
                        isMax: true,
                    });
                    if (Number(upgradeResult.code) !== 0 || upgradeResult.error) {
                        throw new Error(
                            "科技 " +
                                researchId +
                                " 一键满级失败: " +
                                (upgradeResult.error || Number(upgradeResult.code)),
                        );
                    }
                    const verifiedLevel = await waitForResearchLevelAtLeast(
                        researchId,
                        effectiveTargetLevel,
                    );
                    if (verifiedLevel < effectiveTargetLevel) {
                        throw new Error(
                            "科技 " + researchId + " 满级后状态校验失败",
                        );
                    }
                    upgradedResearchCount++;
                    notifyResearchProgress(
                        "科技 " + researchId + " 已恢复到目标等级",
                        true,
                    );
                } else {
                    notifyResearchProgress(
                        "正在升级科技 " +
                            researchId +
                            "：" +
                            currentLevel +
                            "/" +
                            effectiveTargetLevel,
                        true,
                    );
                    console.log(
                        "[科技] 正在自动升级科技 " +
                            researchId +
                            " (当前: " +
                            currentLevel +
                            ", 目标: " +
                            effectiveTargetLevel +
                            ", 满级: " +
                            researchMaxLevel +
                            ") - 逐级升级",
                    );
                    while (currentLevel < effectiveTargetLevel) {
                        const previousLevel = currentLevel;
                        const upgradeResult = await LegionService.research({
                            researchId: researchId,
                            isMax: false,
                        });
                        if (Number(upgradeResult.code) !== 0 || upgradeResult.error) {
                            throw new Error(
                                "科技 " +
                                    researchId +
                                    " 逐级升级失败: " +
                                    (upgradeResult.error || Number(upgradeResult.code)),
                            );
                        }
                        currentLevel = await waitForResearchLevelAtLeast(
                            researchId,
                            previousLevel + 1,
                        );
                        if (currentLevel <= previousLevel) {
                            throw new Error(
                                "科技 " +
                                    researchId +
                                    " 升级后等级没有变化，已停止重试",
                            );
                        }
                        upgradedResearchCount++;
                        if (
                            currentLevel >= effectiveTargetLevel ||
                            currentLevel % 5 === 0
                        ) {
                            notifyResearchProgress(
                                "科技 " +
                                    researchId +
                                    " 进度 " +
                                    currentLevel +
                                    "/" +
                                    effectiveTargetLevel,
                                currentLevel >= effectiveTargetLevel,
                            );
                        }
                    }
                    }
                },
            );
        }
        if (upgradedResearchCount > 0) {
            console.log("[科技] 已全自动完成科技升级操作");
        }
        notifyResearchProgress("科技恢复完成", true);
    }
    if (document.readyState === "complete") {
        mountLineupPanel();
    } else {
        window.addEventListener("load", mountLineupPanel);
    }
    setInterval(mountLineupPanel, 3000);
})();
