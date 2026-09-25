# Deploy Batam trên VPS Ubuntu/Debian

Batam chạy thành service `batam-dashboard` qua systemd, mặc định nghe ở `127.0.0.1:3200`; Nginx proxy từ một hostname riêng. Dashboard nguồn dùng cổng 3100, không được đổi service hoặc Nginx của dashboard khi triển khai Batam.

## Điều kiện trước khi deploy

- VPS có Node.js 20.9+, Yarn 1, Nginx, rsync, curl, `ss`, systemd, user `www-data` và Certbot với plugin Nginx.
- Domain Batam đã trỏ DNS về VPS; cổng 80/443 tới được VPS.
- Lark Custom App cho phép redirect URL chính xác `https://<domain>/auth/callback`.
- Trên VPS có `/var/www/html/batam/.env` chứa các biến trong `.env.local.example`, với `LARK_REDIRECT_URI=https://<domain>/auth/callback` và credential Google đọc được bởi `www-data`. Có thể dùng `DEPLOY_ENV_SOURCE=/var/www/html/nexhub-dashboard/.env` trong lần đầu nếu cùng VPS với dashboard; script chỉ lấy các biến Batam cần và tạo env riêng.

## Deploy từ máy local

```bash
DEPLOY_HOST='user@vps' \
DEPLOY_DOMAIN='batam.example.com' \
DEPLOY_ENV_SOURCE='/var/www/html/nexhub-dashboard/.env' \
CERTBOT_EMAIL='admin@example.com' \
bash deploy/push.sh
```

`DEPLOY_ENV_SOURCE` chỉ dùng khi Batam chưa có env trên server. Nếu server khác hoặc dùng service account khác, hãy tạo `/var/www/html/batam/.env` trước, rồi bỏ biến này. `DEPLOY_PORT` mặc định là 3200. `DEPLOY_TLS=0` chỉ cấu hình HTTP để kiểm thử bước đầu; bật lại TLS khi DNS đã sẵn sàng.

Script upload source (không upload `.env` local), cài package bằng `yarn install --frozen-lockfile`, build trên VPS, chuyển release, khởi động service, kiểm tra `/api/health`, cấu hình Nginx và cấp chứng chỉ HTTPS bằng Certbot. Khi health check sau deploy lỗi, script khôi phục release trước nếu có.

## Kiểm tra trên VPS

```bash
sudo systemctl status batam-dashboard --no-pager
sudo journalctl -u batam-dashboard -n 100 --no-pager
curl -fsS http://127.0.0.1:3200/api/health
sudo nginx -t
curl -fsS https://<domain>/api/health
```

Health check chỉ xác nhận Next.js đang chạy. Đăng nhập Lark và truy vấn BigQuery cần kiểm tra riêng trên giao diện sau deploy.
