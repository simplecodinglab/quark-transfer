# 夸克转存适配服务

给 panxiaozi 的 `QUARK_API` 环境变量提供 `/transfer` 接口。
panxiaozi 的懒转存流程：访客点击资源 → `POST /api/resource-disk/update` →
本服务转存 → 返回站长自己的分享链接 → panxiaozi 缓存复用。

## 三个版本

| 文件 | 用途 |
|---|---|
| `server.js` | 模拟版。本地开发联调用，不碰真实夸克账号 |
| `real.js` | 真实版（Node）。备用：自有服务器部署时用，需要 `QUARK_COOKIE` |
| `worker.js` | 真实版（Cloudflare Workers）。**生产用这个**，无依赖，`fetch` 直连夸克 |

三者接口完全一致，切换只需改 `QUARK_API` 指向，无需改 panxiaozi 代码。

## 生产部署（Cloudflare Workers）

1. 把本目录推到 GitHub（单独一个仓库，如 `quark-transfer`）
2. Cloudflare 控制台 → Workers → 连接该 GitHub 仓库，Build 命令留空，
   Deploy 命令填 `npx wrangler deploy`（或直接 `wrangler deploy`）
3. Worker → Settings → Variables and Secrets → 添加 Secret：
   `QUARK_COOKIE` = 夸克小号的 Cookie（获取方法见下）
4. 部署后访问 `https://quark-transfer.<你的子域>.workers.dev/health`
   应返回 `{"ok":true,"mode":"real-worker","cookie":true}`
5. 把这个地址填到 panxiaozi 的 `QUARK_API` 环境变量

本地调试：`npx wrangler dev`（需先 `wrangler login`）

## 接口

```
POST /transfer
body: { share_url, save_path, gen_passcode, expire_days, title? }

  share_url    第三方夸克分享链接，必填
               提取码可附在链接里：?pwd=xxxx 或 "密码：xxxx"
  save_path    存到自己网盘的目录，如 "/短剧"，不存在自动创建
  gen_passcode false = 公开链接无提取码（默认）；true = 生成 4 位提取码
  expire_days  0 = 永久有效（运营策略只允许 0）
  title        分享页标题（可选）

成功: { "share_url": "https://pan.quark.cn/s/xxxx" }
失败: { "message": "中文错误说明" }

GET /health → { ok, mode, cookie: true/false }
```

## 真实版流程（real.js）

1. 解析分享链接 → `pwd_id`（+ 提取码）
2. 建目录：`save_path` 下建 `px_<md5(pwd_id)>` 子目录（确定性命名，重试可复用）
3. 子目录已有文件 → 跳过转存；否则：
   - 取分享 `stoken`（公开接口）→ 列分享文件 → 调转存接口存到子目录 → 轮询等完成
4. 对子目录内文件创建**永久公开分享** → 返回分享链接

环境变量：

- `QUARK_COOKIE`（必填）：夸克小号登录后的 Cookie
- `PORT`（可选，默认 8787）

运行：`QUARK_COOKIE='...' node real.js [端口]`

## 如何获取 QUARK_COOKIE（站长操作，在自己电脑上）

1. 电脑浏览器登录 `pan.quark.cn`（用转存专用小号，别用主号）
2. 按 F12 → 网络（Network）→ 刷新页面 → 点任意一个 `drive-pc.quark.cn` 的请求
3. 复制请求头里的 `Cookie:` 整串（很长，以 `__pus=` 等开头）
4. 粘贴到**部署平台的环境变量** `QUARK_COOKIE` 里，重启服务

注意：Cookie 会过期（一般几周到几个月）。转存失败告警里出现
`AUTH_EXPIRED` 就是过期了，重新按上面步骤获取并更新。

## 风控提示

- 务必用专用小号，别用主号
- 懒转存（用户点击才转）已经是最低频模式，不要改成批量预转存
- 容量告警：`capacity limit` 表示小号网盘满了，去夸克客户端清理

## 本地测试

```bash
# 模拟版
node server.js 8787
# 真实版（无 Cookie 时只能测参数校验；公开分享链接解析可通）
QUARK_COOKIE='...' node real.js 8788
curl http://127.0.0.1:8788/health
```
