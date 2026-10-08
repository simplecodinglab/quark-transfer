/**
 * 夸克转存适配服务（真实实现）
 *
 * 接口（与模拟版 server.js 完全一致，panxiaozi 无需改动即可切换）：
 *   POST /transfer
 *   body: { share_url, save_path, gen_passcode, expire_days, title? }
 *     - share_url: 第三方夸克分享链接（可附 ?pwd=提取码 或 "密码：xxxx"）
 *     - save_path: 存到自己网盘的目录，如 "/短剧"（不存在自动创建）
 *     - gen_passcode: false = 公开链接（默认）；true = 生成 4 位提取码
 *     - expire_days: 0 = 永久有效（运营策略要求只传 0）
 *     - title: 分享标题（可选，默认用资源名）
 *   成功响应: { share_url }   ← 站长自己的分享链接（已缓存到 panxiaozi）
 *   失败响应: { message }     ← 中文错误说明，panxiaozi 会推送告警
 *
 *   GET /health → { ok, mode: "real", cookie: true/false }
 *
 * 环境变量：
 *   QUARK_COOKIE  必填。站长夸克小号的 Cookie（在自己电脑浏览器登录
 *                 pan.quark.cn 后复制请求头里的 Cookie 字符串）。
 *                 部署时填到部署平台的环境变量里，不要发到聊天里，
 *                 不要写进代码仓库。
 *   PORT          可选，默认 8787。
 *
 * 流程：解析分享链接 → 取 stoken → 列分享文件 → 转存到自己网盘
 *       （/短剧/px_<hash>/，已存在则跳过转存）→ 创建永久公开分享 → 返回链接。
 *
 * 运行：QUARK_COOKIE='...' node real.js [端口]
 */
const http = require("node:http");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const COOKIE = (process.env.QUARK_COOKIE || "").trim();

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

/** 用 curl 发请求（本机 Node 的 fetch 出站被沙箱拦截，curl 可用；生产环境两者皆可） */
function curlJson(method, urlStr, { body, withCookie = true } = {}) {
  return new Promise((resolve, reject) => {
    if (withCookie && !COOKIE) {
      reject(new Error("NO_COOKIE:未配置 QUARK_COOKIE"));
      return;
    }
    const args = [
      "-sS",
      "--max-time",
      "30",
      "-X",
      method,
      urlStr,
      "-H",
      `User-Agent: ${UA}`,
      "-H",
      "Origin: https://pan.quark.cn",
      "-H",
      "Referer: https://pan.quark.cn/",
      "-H",
      "Accept: application/json, text/plain, */*",
      "-H",
      "Content-Type: application/json",
      "-H",
      "Accept-Language: zh-CN,zh;q=0.9",
      "-w",
      "\n%{http_code}",
    ];
    if (withCookie) args.push("-H", `Cookie: ${COOKIE}`);
    if (body !== undefined) args.push("--data", JSON.stringify(body));
    execFile("curl", args, { timeout: 35000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`CURL_FAIL:网络请求失败(${stderr.trim().slice(0, 120) || err.message})`));
        return;
      }
      const idx = stdout.lastIndexOf("\n");
      const httpCode = Number((stdout.slice(idx + 1) || "").trim());
      const text = stdout.slice(0, idx);
      resolve({ httpCode, text });
    });
  });
}

/** 统一的夸克 API 调用，带超时与错误归一化 */
async function api(method, urlStr, { body, withCookie = true } = {}) {
  const { httpCode, text } = await curlJson(method, urlStr, { body, withCookie });
  if (httpCode === 401 || httpCode === 403) {
    throw new Error("AUTH_EXPIRED:Cookie 已失效或被拒绝，请重新获取后更新 QUARK_COOKIE");
  }
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

async function listDir(fid, onlyDirs = false) {
  const data = await api(
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

async function ensureFolder(parentFid, name) {
  const dirs = await listDir(parentFid, true);
  const hit = dirs.find((x) => x.file_name === name);
  if (hit) return hit.fid;
  const data = await api("POST", q(`${PC_BASE}/file`), {
    body: { pdir_fid: parentFid, file_name: name, dir_init_lock: false, dir_path: "" },
  });
  let fid = data.fid || data.file_id || null;
  if (!fid) {
    const again = await listDir(parentFid, true);
    const hit2 = again.find((x) => x.file_name === name);
    fid = hit2 ? hit2.fid : null;
  }
  if (!fid) throw new Error("MKDIR_FAIL:创建目录失败：" + name);
  return fid;
}

async function waitTask(taskId, timeoutMs, label) {
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < timeoutMs) {
    let d;
    try {
      d = await api("GET", q(`${PC_BASE}/task`, { task_id: taskId, retry_index: i++ }));
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

/**
 * 核心转存流程
 * @returns 站长自己的分享链接
 */
async function transfer({ share_url, save_path, gen_passcode, expire_days, title }) {
  if (!COOKIE) throw new Error("NO_COOKIE:转存服务未配置 QUARK_COOKIE，无法转存");
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
  for (const p of parts) parent = await ensureFolder(parent, p);
  const subName = "px_" + crypto.createHash("md5").update(pwdId).digest("hex").slice(0, 10);
  const subFid = await ensureFolder(parent, subName);

  // 2. 子目录已有文件 → 跳过转存，直接用现有文件分享
  let files = await listDir(subFid);
  files = files.filter((x) => x.fid);
  if (files.length === 0) {
    // 取分享 token（公开接口，不需要登录态）
    const tokenData = await api("POST", q(`${SHARE_BASE}/share/sharepage/token`), {
      withCookie: false,
      body: { pwd_id: pwdId, passcode: passcode || "", support_visit_limit_private_share: true },
    });
    const stoken = tokenData.stoken;
    if (!stoken) throw new Error("TOKEN_FAIL:获取分享 token 失败，链接可能已失效或需要提取码");

    // 列分享文件（公开接口）
    const detail = await api(
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
      saveResp = await api("POST", q(`${SHARE_BASE}/share/sharepage/save`), {
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
      await waitTask(taskId, 120000, "转存");
    } else {
      await sleep(3000); // 无 task_id 时给服务端一点落盘时间
    }
    files = (await listDir(subFid)).filter((x) => x.fid);
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
    passcodeOut = crypto.randomBytes(2).toString("hex");
    shareBody.url_type = 2;
    shareBody.passcode = passcodeOut;
  }
  const shareResp = await api("POST", q(`${PC_BASE}/share`), { body: shareBody });
  const shareTaskId = shareResp.task_id;
  if (!shareTaskId) throw new Error("SHARE_FAIL:创建分享未返回任务 ID");
  const done = await waitTask(shareTaskId, 60000, "分享");
  const shareId = done.share_id;
  if (!shareId) throw new Error("SHARE_FAIL:分享任务完成但未拿到 share_id");

  const info = await api("POST", q(`${PC_BASE}/share/password`), {
    body: { share_id: shareId },
  });
  const out = info.share_url || info.url;
  if (!out) throw new Error("SHARE_FAIL:未拿到分享链接");
  return { share_url: out, passcode: passcodeOut || undefined };
}

/* ---------------- HTTP 服务 ---------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error("请求体过大"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && req.url === "/health") {
    json(200, { ok: true, mode: "real", cookie: !!COOKIE });
    return;
  }

  if (req.method === "POST" && req.url === "/transfer") {
    let params;
    try {
      params = JSON.parse(await readBody(req));
    } catch {
      json(400, { message: "请求体不是合法 JSON" });
      return;
    }
    const { share_url, save_path, gen_passcode, expire_days, title } = params || {};
    if (!share_url || !/^https?:\/\//i.test(share_url)) {
      json(400, { message: "share_url 非法" });
      return;
    }
    try {
      const t0 = Date.now();
      const result = await transfer({ share_url, save_path, gen_passcode, expire_days, title });
      console.log(
        `[${new Date().toISOString()}] transfer ok (${Date.now() - t0}ms): ${share_url} -> ${result.share_url}`,
      );
      json(200, { share_url: result.share_url, expire: "permanent" });
    } catch (e) {
      const msg = e.message || "转存失败";
      console.error(`[${new Date().toISOString()}] transfer fail: ${share_url} :: ${msg}`);
      const code = /^BAD_|^NO_COOKIE/.test(msg) ? 400 : 500;
      json(code, { message: msg });
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`quark-transfer real listening on :${PORT} (cookie: ${COOKIE ? "已配置" : "未配置"})`);
  });
}

module.exports = { parseShareUrl, transfer, server, api, q, listDir, ensureFolder, waitTask };
