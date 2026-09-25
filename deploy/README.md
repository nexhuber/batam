# Deploy Batam trên VPS Ubuntu/Debian

Batam chạy bằng systemd service `batam-dashboard` tại `127.0.0.1:3200`. Nginx dùng hostname riêng. Lệnh deploy từ Git và lệnh upload từ máy local đều gọi `install.sh`, nên dùng cùng quy trình build, health check, lịch sử và rollback.

## Chuẩn bị VPS

- Cài Node.js 20.9+, Yarn 1, Git, rsync, curl, Nginx, systemd, `ss`, user `www-data` và Certbot Nginx plugin.
- Cho VPS quyền đọc `https://github.com/nexhuber/batam.git` (hoặc đặt `BATAM_GIT_URL` khi `--setup`).
- Tạo DNS cho hostname Batam và đăng ký `https://<domain>/auth/callback` trong Lark Custom App.
- Tạo `/var/www/html/batam/.env` trên VPS, ngoài thư mục release. Cần `SESSION_SECRET`, `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_REDIRECT_URI`, `BQ_PROJECT`, `BQ_DATASET`, `BQ_LOCATION`, `MONARCH_API_BASE_URL` và `BRAND_PIVOT_API_TOKEN`. Nếu dùng service-account JSON, đặt `GOOGLE_APPLICATION_CREDENTIALS` là đường dẫn tuyệt đối ngoài `releases/`, đọc được bởi `www-data`. Redirect URI phải đúng `https://<domain>/auth/callback`.

Có thể truyền `BATAM_ENV_SOURCE=/path/to/existing/.env` trong lần đầu nếu file nguồn có đủ **toàn bộ** biến cần thiết. Script chỉ sao chép biến Batam và tự đặt redirect URI; nó không sao chép `PORT` của ứng dụng khác.

## Deploy từ Git trên VPS

Nếu đã clone repo vào `/var/www/html/batam`, tạo `.env` rồi chạy ngay `sudo BATAM_DOMAIN='batam.example.com' bash deploy/deploy.sh`. Không cần `--setup`; script nhận repo Git tại chính thư mục này. Nếu clone ở đường dẫn khác, đặt `BATAM_APP_DIR` bằng đường dẫn đó trong mọi lệnh deploy.

Lần đầu, chép script từ máy local lên VPS, đăng nhập SSH, rồi chạy:

```bash
scp deploy/deploy.sh user@vps:/tmp/batam-deploy.sh
ssh user@vps
sudo BATAM_DOMAIN='batam.example.com' \
  BATAM_GIT_URL='https://github.com/nexhuber/batam.git' \
  bash /tmp/batam-deploy.sh --setup
```

Script clone repo dạng bare vào `/var/www/html/batam/repo.git` nếu chưa có checkout, fetch `origin/main`, tạo release từ đúng commit, cài bằng `yarn install --frozen-lockfile`, build rồi kiểm tra `/api/health` trên cổng tạm. Sau khi chuyển release, script kiểm tra lại service ở cổng 3200. Nó tự khôi phục release trước nếu restart, health check hoặc Nginx reload thất bại.

Các lần sau chạy script trong release đang hoạt động trên VPS:

```bash
sudo BATAM_DOMAIN='batam.example.com' bash /var/www/html/batam/current/deploy/deploy.sh
bash /var/www/html/batam/current/deploy/deploy.sh --status
bash /var/www/html/batam/current/deploy/deploy.sh --history
bash /var/www/html/batam/current/deploy/deploy.sh --logs
sudo bash /var/www/html/batam/current/deploy/deploy.sh --rollback
```

`BATAM_APP_DIR` mặc định `/var/www/html/batam`, `BATAM_PORT` mặc định `3200`, `BATAM_GIT_BRANCH` mặc định `main`. `BATAM_KEEP_RELEASES` mặc định `5`; bản đang chạy và bản rollback luôn được giữ. `--rollback` dùng bản hoạt động ngay trước đó, rồi kiểm tra health và ghi lịch sử.

Nginx config chỉ được tạo ở lần đầu để giữ chỉnh sửa TLS của Certbot. Khi DNS sẵn sàng, cấp HTTPS:

```bash
sudo certbot --nginx --redirect -d batam.example.com
```

## Deploy từ máy local

`push.sh` vẫn upload source hiện tại, kể cả thay đổi chưa commit, qua SSH và gọi cùng `install.sh`. Dùng cách này khi cần phát hành bản chưa có trên Git remote:

```bash
DEPLOY_HOST='user@vps' \
DEPLOY_DOMAIN='batam.example.com' \
CERTBOT_EMAIL='admin@example.com' \
bash deploy/push.sh
```

`DEPLOY_ENV_SOURCE` chỉ dùng nếu Batam chưa có `.env` trên server. `DEPLOY_TLS=0` bỏ bước Certbot và kiểm tra HTTPS trong lần thử HTTP đầu tiên.

## Kiểm tra sau deploy

```bash
sudo systemctl status batam-dashboard --no-pager
sudo journalctl -u batam-dashboard -n 100 --no-pager
curl -fsS http://127.0.0.1:3200/api/health
sudo nginx -t
curl -fsS https://batam.example.com/api/health
```

Health check chỉ xác nhận Next.js chạy. Cần kiểm tra đăng nhập Lark, truy vấn BigQuery và gọi API Monarch riêng trên giao diện. Deploy không tạo cron cho `news:weekly`.
