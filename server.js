/**
 * 夸克转存适配服务（最小实现 / 模拟版）
 *
 * 用途：给 panxiaozi 的 QUARK_API 环境变量提供一个可用的 /transfer 接口，
 * 先用模拟响应把「点击 → 转存 → 缓存自己链接」整条链路跑通。
 *
 * 接口约定：
 *   POST /transfer
 *   body: { share_url, save_path, gen_passcode, expire_days }
 *     - expire_days: 0 = 永久有效（panxiaozi 运营策略要求）
 *   响应: { share_url }   ← 转存后站长自己的分享链接
 *
 * 模拟版行为：
 *   - 对同一个 share_url 总是返回同一个模拟链接（可测试缓存命中）
 *   - 不做任何真实转存
 *
 * 替换为真实实现时：保持接口不变，把 handler 换成调用夸克接口的逻辑即可。
 * 真实实现需要站长夸克小号的登录态（Cookie），部署时由站长在部署平台配置，
 * 不要写进代码、不要发到聊天里。
 *
 * 运行：node server.js [端口，默认 8787]
 */
const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.argv[2] || process.env.PORT || 8787);

function mockShareUrl(shareUrl, savePath) {
  const hash = crypto
    .createHash("sha256")
    .update(`${savePath}::${shareUrl}`)
    .digest("hex")
    .slice(0, 13);
  return `https://pan.quark.cn/s/${hash}`;
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/transfer") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      try {
        const { share_url, save_path, expire_days } = JSON.parse(body || "{}");
        if (!share_url || !/^https?:\/\//i.test(share_url)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "share_url 非法" }));
          return;
        }
        if (expire_days !== 0) {
          // 模拟版只支持永久；真实版可按需支持 1/7/30 天
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "模拟版仅支持 expire_days=0（永久）" }));
          return;
        }
        const url = mockShareUrl(share_url, save_path || "/");
        console.log(
          `[${new Date().toISOString()}] transfer ok: ${share_url} -> ${url}`,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ share_url: url, expire: "permanent", mock: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "请求体解析失败" }));
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mock: true }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`quark-transfer mock listening on :${PORT}`);
});
