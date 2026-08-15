# TrailSense 部署记录

## 线上地址
- IP 直访: http://173.242.116.220/ (80 端口)
- 域名: www.goitex.com (用户将在 DNS 绑定 → 173.242.116.220)
- 服务器: Bandwagon CN2 GIA (1GB RAM), nginx, 与 x-ui/xray(443) 共存

## 部署步骤(已执行)
1. 本地构建: 纯静态文件 index.html + css/ + js/ + manifest.json + sw.js + icons/
2. 上传: scp 打包到 VPS, 解压到 /var/www/html/trailsense/ (root 权限)
3. nginx: 复制 deploy/nginx-trailsense.conf 到 /etc/nginx/sites-available/trailsense,
   ln -sf 到 sites-enabled, nginx -t && systemctl reload nginx

## 更新部署
cd ~/hiking-gis-hazard && tar czf /tmp/trailsense.tar.gz index.html css js manifest.json sw.js icons
scp -i ~/.ssh/id_ed25519 /tmp/trailsense.tar.gz root@173.242.116.220:/tmp/
ssh root@173.242.116.220 "cd /var/www/html/trailsense && tar xzf /tmp/trailsense.tar.gz && rm /tmp/trailsense.tar.gz"

## HTTPS 配置(2026-08-15, 已上线)

### 架构: xray SNI fallback + 网站共存(单 443 端口)
- DNS: goitex.com / www.goitex.com → 173.242.116.220 (用户已绑定)
- 证书: certbot webroot 申请, /etc/letsencrypt/live/goitex.com/ (有效期 90 天, certbot.timer 自动续期)
- 443 端口: xray (x-ui 3.6.0 / MHSanaei 3x-ui) 按 SNI 分流:
  * SNI=port.goitex.com + WS path=/p1 → VLESS 代理流量 → fallback 到内部 127.0.0.1:2097 (WS inbound, 无 TLS)
  * SNI=goitex.com / www.goitex.com → 浏览器 HTTPS → fallback 到 nginx:80 (nginx 无 TLS, 由 xray 终止)
- 客户端连接参数不变: 443 + SNI port.goitex.com + path /p1 + VLESS

### 关键坑 (实测踩过, 改配置时注意)
1. **不要直接改 /usr/local/x-ui/bin/config.json** — x-ui 重启时用 SQLite (/etc/x-ui/x-ui.db) 重新生成, 手改会被覆盖
2. **必须改数据库**: UPDATE inbounds SET settings/stream_settings WHERE port=443
3. **fallbacks 子元素存在时, tlsSettings.alpn 只能 ["http/1.1"]**(不能有 h2)
4. **新增内部 inbound 时 node_id 必须为 NULL** — 3x-ui 的 GetXrayConfig 会跳过 NodeID != nil 的 inbound(多节点同步用), 否则生成的 config.json 里没有它
5. **fallback 只支持 TCP+TLS 传输** — 原 443 是 WS+TLS, 必须改成 network=tcp + 内部 WS inbound 承接 (path 分流)
6. 证书条目加 serverName 字段 (port.goitex.com / goitex.com / www.goitex.com 各一条), xray 按 SNI 选证书
7. 内部 inbound (2097) listen=127.0.0.1, 外部不可达

### 验证命令
```bash
echo | openssl s_client -connect 173.242.116.220:443 -servername goitex.com 2>/dev/null | openssl x509 -noout -subject  # CN=goitex.com
curl -s https://goitex.com/ | grep title
python3 /tmp/vless_test.py  # VLESS+WS 代理链路测试
```
