/**
 * 夸克转存服务 — Cloudflare Workers 版
 *
 * 接口（与 Node 版 real.js / 模拟版 server.js 完全一致，panxiaozi 无需改动）：
 *   POST /transfer
 *   body: { share_url, save_path, gen_passcode, expire_days, title? }
 *     - share_url: 第三方夸克分享链接（可附 ?pwd=提取码 或 "密码：xxxx"）
 *     - save_path: 存到自己网盘的目录，如 "/短剧"（不存在自动创建）
 *     - gen_passcode: false = 公开链接（默认）；true = 生成 4 位提取码
 *     - expire_days: 0 = 永久有效（运营策略要求只传 0）
 *     - title: 分享标题（可选，默认用资源名）
 *   成功响应: { share_url, expire: "permanent" }  ← 站长自己的分享链接
 *   失败响应: { message }                        ← 中文错误说明，panxiaozi 会推送告警
 *
 *   GET /health → { ok, mode: "real-worker", cookie: true/false }
 *
 * Secret（在 Cloudflare 控制台 Settings → Variables and Secrets 设置）：
 *   QUARK_COOKIE  站长夸克小号的 Cookie（浏览器登录 pan.quark.cn 后复制请求头里的 Cookie）
 *
 * 流程：解析分享链接 → 取 stoken → 列分享文件 → 转存到自己网盘
 *       （/短剧/px_<pwdId>/，已存在则跳过转存）→ 创建永久公开分享 → 返回链接。
 *
 * 部署：npx wrangler deploy
 * 本地调试：npx wrangler dev
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PC_BASE = "https://drive-pc.quark.cn/1/clouddrive";
const SHARE_BASE = "https://drive.quark.cn/1/clouddrive";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function q(url, params = {}) {
  const p = {
    pr: "ucpro",
    fr: "pc",
    uc_param_str: "",
    __dt: 1000,
    __t: Date.now(),
    ...params,
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) qs.append(k, String(v));
  return `${url}?${qs.toString()}`;
}

/** 统一的夸克 API 调用，带超时与错误归一化 */
async function api(cookie, method, urlStr, { body, withCookie = true } = {}) {
  if (withCookie && !cookie) {
    throw new Error("NO_COOKIE:未配置 QUARK_COOKIE");
  }
  const headers = {
    "User-Agent": UA,
    Origin: "https://pan.quark.cn",
    Referer: "https://pan.quark.cn/",
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  if (withCookie) headers["Cookie"] = cookie;

  let resp;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    resp = await fetch(urlStr, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 120);
    throw new Error(`NET_FAIL:网络请求失败(${reason})`);
  }

  const httpCode = resp.status;
  if (httpCode === 401 || httpCode === 403) {
    throw new Error("AUTH_EXPIRED:Cookie 已失效或被拒绝，请重新获取后更新 QUARK_COOKIE");
  }
  const text = await resp.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`BAD_JSON:接口返回非 JSON(HTTP ${httpCode})`);
  }
  if (httpCode >= 400) {
    throw new Error(`HTTP_${httpCode}:${data.message || "请求失败"}`);
  }
  const code = data.code;
  const status = data.status;
  const msg = String(data.message || data.msg || "");
  if (code && code !== 0) {
    if (/login|auth|passport|expired|logout/i.test(msg)) {
      throw new Error("AUTH_EXPIRED:" + (msg || "登录态失效"));
    }
    throw new Error(`API_${code}:${msg || "接口返回异常"}`);
  }
  if (status !== undefined && status !== 200 && status !== "success") {
    if (/login|auth|passport|expired|logout/i.test(msg)) {
      throw new Error("AUTH_EXPIRED:" + (msg || "登录态失效"));
    }
    throw new Error(`API_${status}:${msg || "接口返回异常"}`);
  }
  return data.data !== undefined ? data.data : data;
}

function capacityGuard(text) {
  if (/capacity/i.test(String(text))) {
    throw new Error("capacity limit: 网盘容量不足，请清理空间后重试");
  }
}

/** 解析分享链接 → { pwdId, passcode } */
function parseShareUrl(shareUrl) {
  const m = String(shareUrl).match(/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/);
  if (!m) throw new Error("BAD_URL:不是有效的夸克分享链接");
  let passcode = "";
  const pm =
    String(shareUrl).match(/[?&](?:pwd|password|passcode)=([a-zA-Z0-9]+)/i) ||
    String(shareUrl).match(/密码[：:]\s*([a-zA-Z0-9]+)/);
  if (pm) passcode = pm[1];
  return { pwdId: m[1], passcode };
}

async function listDir(cookie, fid, onlyDirs = false) {
  const data = await api(
    cookie,
    "GET",
    q(`${PC_BASE}/file/sort`, {
      pdir_fid: fid,
      _page: 1,
      _size: 200,
      _fetch_total: false,
      _fetch_sub_dirs: 1,
    }),
  );
  const list = data.list || [];
  return onlyDirs ? list.filter((x) => x.file_type === 0) : list;
}

async function ensureFolder(cookie, parentFid, name) {
  const dirs = await listDir(cookie, parentFid, true);
  const hit = dirs.find((x) => x.file_name === name);
  if (hit) return hit.fid;
  const data = await api(cookie, "POST", q(`${PC_BASE}/file`), {
    body: { pdir_fid: parentFid, file_name: name, dir_init_lock: false, dir_path: "" },
  });
  let fid = data.fid || data.file_id || null;
  if (!fid) {
    const again = await listDir(cookie, parentFid, true);
    const hit2 = again.find((x) => x.file_name === name);
    fid = hit2 ? hit2.fid : null;
  }
  if (!fid) throw new Error("MKDIR_FAIL:创建目录失败：" + name);
  return fid;
}

async function waitTask(cookie, taskId, timeoutMs, label) {
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < timeoutMs) {
    let d;
    try {
      d = await api(cookie, "GET", q(`${PC_BASE}/task`, { task_id: taskId, retry_index: i++ }));
    } catch (e) {
      capacityGuard(e.message);
      throw e;
    }
    capacityGuard(d.message);
    const st = d.status;
    if (st === 2) return d;
    if (st === 3) {
      capacityGuard(d.message);
      throw new Error(`TASK_FAIL:${label}任务失败：${d.message || ""}`);
    }
    await sleep(1500);
  }
  throw new Error(`TASK_TIMEOUT:${label}任务超时（>${Math.round(timeoutMs / 1000)}s）`);
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * 核心转存流程
 * @returns 站长自己的分享链接
 */
async function transfer(cookie, { share_url, save_path, gen_passcode, expire_days, title }) {
  if (!cookie) throw new Error("NO_COOKIE:转存服务未配置 QUARK_COOKIE，无法转存");
  if (expire_days !== 0 && expire_days !== undefined) {
    throw new Error("BAD_EXPIRE:运营策略要求永久有效，expire_days 必须为 0");
  }
  const { pwdId, passcode } = parseShareUrl(share_url);

  // 1. 准备目录：save_path 下建确定性子目录（重试可复用，天然幂等）
  const parts = String(save_path || "/短剧")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  let parent = "0";
  for (const p of parts) parent = await ensureFolder(cookie, parent, p);
  const subName = "px_" + pwdId;
  const subFid = await ensureFolder(cookie, parent, subName);

  // 2. 子目录已有文件 → 跳过转存，直接用现有文件分享
  let files = await listDir(cookie, subFid);
  files = files.filter((x) => x.fid);
  if (files.length === 0) {
    // 取分享 token（公开接口，不需要登录态）
    const tokenData = await api(cookie, "POST", q(`${SHARE_BASE}/share/sharepage/token`), {
      withCookie: false,
      body: { pwd_id: pwdId, passcode: passcode || "", support_visit_limit_private_share: true },
    });
    const stoken = tokenData.stoken;
    if (!stoken) throw new Error("TOKEN_FAIL:获取分享 token 失败，链接可能已失效或需要提取码");

    // 列分享文件（公开接口）
    const detail = await api(
      cookie,
      "GET",
      q(`${SHARE_BASE}/share/sharepage/detail`, {
        pwd_id: pwdId,
        stoken,
        pdir_fid: "0",
        force: "0",
        _page: 1,
        _size: 50,
        _fetch_banner: 1,
        _fetch_share: 1,
        _fetch_total: 1,
        _sort: "file_type:asc,updated_at:desc",
      }),
      { withCookie: false },
    );
    const list = (detail.list || []).filter((x) => x.fid);
    if (list.length === 0) throw new Error("EMPTY_SHARE:分享内容为空或已失效");

    // 转存到自己网盘
    let saveResp;
    try {
      saveResp = await api(cookie, "POST", q(`${SHARE_BASE}/share/sharepage/save`), {
        body: {
          fid_list: list.map((x) => x.fid),
          fid_token_list: list.map((x) => x.share_fid_token || ""),
          to_pdir_fid: subFid,
          pwd_id: pwdId,
          stoken,
          pdir_fid: "0",
          scene: "link",
        },
      });
    } catch (e) {
      capacityGuard(e.message);
      throw e;
    }
    const taskId = saveResp.task_id;
    if (taskId) {
      await waitTask(cookie, taskId, 120000, "转存");
    } else {
      await sleep(3000); // 无 task_id 时给服务端一点落盘时间
    }
    files = (await listDir(cookie, subFid)).filter((x) => x.fid);
    if (files.length === 0) throw new Error("SAVE_EMPTY:转存后目录仍为空，请检查原链接");
  }

  // 3. 创建自己的分享（永久；gen_passcode=false → 公开链接无提取码）
  let passcodeOut = "";
  const shareBody = {
    fid_list: files.map((x) => x.fid),
    title: title || subName,
    url_type: 1,
    expired_type: 1, // 1=永久（expire_days=0）
  };
  if (gen_passcode) {
    passcodeOut = randomHex(2);
    shareBody.url_type = 2;
    shareBody.passcode = passcodeOut;
  }
  const shareResp = await api(cookie, "POST", q(`${PC_BASE}/share`), { body: shareBody });
  const shareTaskId = shareResp.task_id;
  if (!shareTaskId) throw new Error("SHARE_FAIL:创建分享未返回任务 ID");
  const done = await waitTask(cookie, shareTaskId, 60000, "分享");
  const shareId = done.share_id;
  if (!shareId) throw new Error("SHARE_FAIL:分享任务完成但未拿到 share_id");

  const info = await api(cookie, "POST", q(`${PC_BASE}/share/password`), {
    body: { share_id: shareId },
  });
  const out = info.share_url || info.url;
  if (!out) throw new Error("SHARE_FAIL:未拿到分享链接");
  return { share_url: out, passcode: passcodeOut || undefined };
}

/* ---------------- Worker 入口 ---------------- */


/** Server酱微信推送（NOTICE_API 未配置则静默跳过） */
async function sendNotice(noticeApi, title, desp) {
  if (!noticeApi) return;
  try {
    if (String(noticeApi).includes("sctapi.ftqq.com")) {
      const form = new URLSearchParams();
      form.set("title", title);
      form.set("desp", desp);
      await fetch(noticeApi, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    }
  } catch (e) {
    console.error("notice fail:", e);
  }
}

/** 探活：用根目录列表验证 Cookie 是否有效（轻量，1 次请求） */
async function checkCookie(cookie) {
  await listDir(cookie, "0");
}

export default {
  // 每天定时探活（wrangler.jsonc triggers.crons）：Cookie 失效立刻微信告警
  async scheduled(event, env, ctx) {
    const cookie = (env.QUARK_COOKIE || "").trim();
    const noticeApi = (env.NOTICE_API || "").trim();
    const now = new Date().toISOString();
    if (!cookie) {
      await sendNotice(noticeApi, "短剧库探活：未配置 QUARK_COOKIE", `时间：${now}\n请在 Cloudflare 控制台补上 QUARK_COOKIE`);
      return;
    }
    try {
      await checkCookie(cookie);
      console.log(`cookie check ok @ ${now}`);
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.error(`cookie check fail @ ${now}:`, msg);
      await sendNotice(
        noticeApi,
        "短剧库探活：夸克 Cookie 失效",
        `探活失败：${msg}\n\n时间：${now}\n请重新获取 Cookie 后更新 QUARK_COOKIE（5 分钟操作）`,
      );
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const cookie = (env.QUARK_COOKIE || "").trim();
    const json = (code, obj) =>
      new Response(JSON.stringify(obj), {
        status: code,
        headers: { "Content-Type": "application/json" },
      });

    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true, mode: "real-worker", cookie: !!cookie });
    }

    if (request.method === "POST" && url.pathname === "/transfer") {
      let params;
      try {
        params = await request.json();
      } catch {
        return json(400, { message: "请求体不是合法 JSON" });
      }
      const { share_url, save_path, gen_passcode, expire_days, title } = params || {};
      if (!share_url || !/^https?:\/\//i.test(share_url)) {
        return json(400, { message: "share_url 非法" });
      }
      try {
        const t0 = Date.now();
        const result = await transfer(cookie, {
          share_url,
          save_path,
          gen_passcode,
          expire_days,
          title,
        });
        console.log(
          `transfer ok (${Date.now() - t0}ms): ${share_url} -> ${result.share_url}`,
        );
        return json(200, { share_url: result.share_url, expire: "permanent" });
      } catch (e) {
        const msg = (e && e.message) || "转存失败";
        console.error(`transfer fail: ${share_url} :: ${msg}`);
        const code = /^BAD_|^NO_COOKIE/.test(msg) ? 400 : 500;
        return json(code, { message: msg });
      }
    }

    return new Response("not found", { status: 404 });
  },
};
