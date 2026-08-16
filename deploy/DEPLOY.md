# TrailSense 部署记录

## 线上地址
- 域名: https://www.goitex.com (经 Cloudflare 代理, DNS → CF 边缘 IP)
- 直连源站: https://173.242.116.220/ (绕过 CF 测试用)
- 服务器: Bandwagon CN2 GIA (1GB RAM)

## 当前端口全景 (2026-08-15 最终态)
| 端口 | 服务 | 说明 |
|---|---|---|
| 80 | nginx | 301 → https |
| 443 | nginx + Let's Encrypt | **网站 HTTPS** (CF 回源目标) |
| 8443 | xray VLESS 入站 (TCP+TLS) | 手机 VPN, 证书 port.goitex.com |
| 5432 | 3x-ui 面板 | https://port.goitex.com:5432/i1GiPxPVQqSkCDFEdT/ |
| 2096 | 3x-ui 订阅 | ufw 已放行 |
| 22 | SSH | |

> ⚠️ 历史遗留: 曾用 xray SNI fallback 让 443 同时服务代理+网站 (旧方案, 见 git 历史 cfc5fe9~2ae9879)。
> 用户后续改为: 代理入站 8443 + nginx 直接 443。**当前 xray 不再监听 443。**

## 部署步骤(已执行)
1. 本地构建: 纯静态文件 index.html + css/ + js/ + manifest.json + sw.js + icons/
2. 上传: scp 打包到 VPS, 解压到 /var/www/html/trailsense/ (root 权限)
3. nginx: 复制 deploy/nginx-trailsense.conf 到 /etc/nginx/sites-available/trailsense,
   ln -sf 到 sites-enabled, nginx -t && systemctl reload nginx

## 更新部署
```bash
cd ~/hiking-gis-hazard && tar czf /tmp/trailsense.tar.gz index.html css js manifest.json sw.js icons
scp -i ~/.ssh/id_ed25519 /tmp/trailsense.tar.gz root@173.242.116.220:/tmp/
ssh root@173.242.116.220 "cd /var/www/html/trailsense && tar xzf /tmp/trailsense.tar.gz && rm /tmp/trailsense.tar.gz"
```

## HTTPS 证书
- certbot webroot 申请: `/etc/letsencrypt/live/goitex.com/` (Let's Encrypt, 90 天)
- 自动续期: certbot.timer (systemd), 续期后 nginx reload
- 面板/订阅/代理共用另一张证书: `/root/cert/port.goitex.com/` (也是 Let's Encrypt, 手动管理)

## CSP 维护要点 (2026-08-15 部署)

**当前策略** (nginx `add_header Content-Security-Policy $csp always;`):
```
default-src 'self';
script-src 'self' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com 'unsafe-inline';
style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline';
img-src 'self' data: blob: https://*.tile.opentopomap.org https://server.arcgisonline.com https://*.basemaps.cartocdn.com https://gibs.earthdata.nasa.gov https://tilecache.rainviewer.com;
connect-src 'self' https://earthquake.usgs.gov https://api.open-meteo.com https://api.rainviewer.com https://firms.modaps.eosdis.nasa.gov https://gibs.earthdata.nasa.gov;
font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests
```

**新增外部资源时必须同步更新 CSP, 否则会被静默拦截** (浏览器 console 报 securitypolicyviolation, 页面功能缺失但无报错弹窗):

| 资源类型 | 要改的指令 | 例子 |
|---|---|---|
| 新 CDN 脚本/库 | `script-src` | 加 `https://cdn.jsdelivr.net` 这种域 |
| 新 CSS 库 | `style-src` | Leaflet css 来自 jsdelivr |
| 新地图瓦片/图片源 | `img-src` | OpenTopoMap/Esri/CartoDB/GIBS |
| 新数据 API (fetch) | `connect-src` | USGS/Open-Meteo/RainViewer/FIRMS |
| 新字体 | `font-src` | 一般 data: 即可 |

**修改方法**:
```bash
ssh root@173.242.116.220
# 编辑 /etc/nginx/sites-available/trailsense 里的 $csp 变量
# nginx -t && systemctl reload nginx
# 验证: curl -sI https://www.goitex.com/ | grep -i content-security
```

**排查 CSP 问题**:
1. 浏览器 console: `securitypolicyviolation` 事件 / "Refused to load ... because it violates"
2. 注意: `add_header` 在 location 里会**覆盖** server 级, 所以每个 location 都要带 (当前配置已用 `always` + 各 location 单独加)
3. `'unsafe-inline'` 目前用于 script (CDN 降级 document.write) 和 style (Leaflet 动态样式), 如需严格化可改用 hash/nonce, 但需改 index.html

---

# 2026-08-15 排障经验教训 (踩坑实录)

## 1. x-ui (3x-ui) 配置管理
- **千万别手改 /usr/local/x-ui/bin/config.json** — x-ui 重启时从 SQLite (/etc/x-ui/x-ui.db) 重新生成, 手改必被覆盖
- 正确改法: 直接 UPDATE 数据库 `inbounds` 表 (`settings`/`stream_settings` 列是 JSON 字符串), 然后 `systemctl restart x-ui`
- 面板端口: `x-ui setting -port 5432` (注意是 `-port` 不是 `-webPort`)
- **新增 inbound 的 node_id 必须为 NULL** — 3x-ui 生成配置时跳过 `NodeID != nil` 的 inbound (多节点同步用), 否则"配置在数据库里但 config.json 里没有"
- fallbacks 子元素存在时, TLS `alpn` 只能 `["http/1.1"]` (带 h2 会出问题)
- xray VLESS fallback 只支持 **TCP+TLS** 传输; WS+TLS 的 inbound 无法直接用 fallbacks (需拆成 TCP 主入口 + 内部 WS inbound 用 path 分流)

## 2. 防火墙 (ufw) — 最大的坑
- **ufw 区分 TCP/UDP**: `ufw allow 8443/udp` 只放 UDP! VLESS 入站是 TCP, 必须 `ufw allow 8443/tcp`
- 症状: 服务明明在监听 (ss 能看到), 但外部连不上 — 先查 `ufw status | grep <port>` 的协议
- 手机 VPN 连不上的常见原因排序: 防火墙协议没放行 > 证书过期 > SNI 不匹配 > 端口没监听

## 3. Cloudflare 代理 + 源站
- 域名走 CF 代理后, DNS 解析到 CF 边缘 IP (104.21.x.x / 172.67.x.x), **源站 IP 对外不可见**
- **CF 521 错误 = Cloudflare 无法连接源站** — 几乎总是源站端口没监听/被防火墙挡
- CF 回源默认打 443: 源站 443 必须活着且有有效证书 (SSL 模式 Full/Full Strict 都要)
- 排障: `curl -sk https://<源站IP>/` (绕过 CF 直连) 看源站本身通不通; 通 = 问题在 CF 配置, 不通 = 源站问题
- 本机 DNS 解析 goitex.com 得到 CF IP 是正常的, 别误判

## 4. nginx 细节
- nginx 1.22 的 HTTP/2: `listen 443 ssl http2;` (不是 `http2 on;` 独立指令, 会报 unknown directive)
- `add_header` 继承陷阱: 子 location 里写了 add_header 就不会继承 server 级 — CSP 等安全头每个 location 都要显式加, 用 `always` 保证带上
- 网站改 HTTPS 后记得把 80 也 301: `return 301 https://$host$request_uri;`

## 5. VLESS 链路验证 (自研测试脚本)
- `/tmp/vless_tcp_test.py`: 模拟真实 VLESS+TCP+TLS 客户端 (SNI=port.goitex.com, 8443)
- 关键: VLESS 头地址类型 0x01=IPv4 / 0x02=域名 / 0x03=IPv6 — 域名目标必须用 **0x02**, 写错则连接建立但无响应
- 验证通过标准: TLS 握手 → 收到上游 HTTP 响应 (哪怕 400/404 也说明链路通了)

## 6. 其他
- Bandwagon VPS 有 root 免密 SSH (id_ed25519), 无需 sudo 密码: `ssh root@173.242.116.220`
- 面板登录用户名/密码: 数据库 `users` 表 (bcrypt), 忘记时可用 `x-ui setting -username/-password` 重置
- 3x-ui 面板地址 = `https://port.goitex.com:5432/<webBasePath>/` (webBasePath 在 settings 表)

## 安全加固 (2026-08-15 第二轮, 按安全评估报告)

| 风险项 | 措施 | 状态 |
|---|---|---|
| CDN 劫持/依赖漏洞 (中) | **SRI 完整性校验**: 4 个 CDN 库 (Leaflet/Turf/Chart/html2canvas) + Leaflet CSS, 主源+备用源各自带 integrity hash | ✅ |
| FIRMS API Key 暴露 (中) | Key 仅存本机 localStorage, UI 增加透明提示; 建议生产用 Cloudflare Worker 代理 (见下) | ✅ |
| 恶意文件上传 (高) | 浏览器端 FileReader 解析 (纯前端不上传), 新增 10MB 大小上限 + 20 万点上限 | ✅ |
| 安全响应头缺失 (低) | X-Content-Type-Options: nosniff / Referrer-Policy / X-Frame-Options: DENY / Permissions-Policy / COOP / CORP | ✅ |
| CORS (低) | 未开 Access-Control-Allow-Origin 通配符 (默认严格); 无跨域需求, 不额外放开 | ✅ |
| Server 版本泄露 (低) | server_tokens off (源站显示 "nginx" 无版本号) | ✅ |

### SRI 维护要点 (重要!)
- **改 CDN 库版本时必须同步更新 hash**: `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`
- **不同 CDN 的同一库文件内容可能不同** (实测: chart.js 在 jsdelivr 与 cdnjs 的 hash 不同) → 主源和备用源**各自用自己文件的 hash**
- 备用源 document.write 中的 `<\/script>` 是 JS 字符串转义 (单反斜杠!), 不能写成 `\\/script`
- 加 SRI 的 script 必须带 `crossorigin="anonymous"` 属性

### FIRMS Key 后端代理 (可选后续)
当前 Key 存用户浏览器 localStorage, 仅直连 NASA 使用。如需彻底隐藏:
- 用 Cloudflare Worker 代理 `https://firms.modaps.eosdis.nasa.gov` (Key 放 Worker 环境变量)
- 前端 connect-src 加 Worker 域名, 移除 localStorage 方案
- 纯静态 PWA 无后端, 当前方案风险已可控 (Key 不经过本站服务器)

### 部署权限坑 (再次踩到)
- 用 tar 覆盖部署后 **必须** `chown -R root:root` + `chmod -R 755` — 否则 tar 保留本地文件属主,
  nginx worker (www-data) 读不了 → **403 Permission denied** (症状: 突然全部 403, 但 TLS 正常)

## 线上部署更新 (2026-08-16, v8)
- 资源版本号: index.html 本地资源引用全部加 ?v=8(每次改版 bump, 配合 CF 缓存)
- nginx: HTML no-cache(CF 不再缓存 HTML, 每次回源), 带版本号静态资源 7d 长缓存
- CSP 新增 https://s3.amazonaws.com (3D 地形 DEM 瓦片)
- **CF 缓存坑**: 无参数请求拿到旧版(29300B app.js), 带 ?v= 拿到新版(58863B) — 必须资源加版本号 + HTML no-cache
- **大陆网络 CDN 现状**: jsdelivr 000 不可达, unpkg 200 可用 — 依赖 document.write 备用源降级(已验证 unpkg 文件 SRI 与 jsdelivr 一致)
- 部署: tar 打包 → scp → 解压 chown → reload nginx
