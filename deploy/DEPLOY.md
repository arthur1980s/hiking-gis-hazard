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
