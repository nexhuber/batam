# Deploy Batam

Batam dùng `deploy/deploy.sh` để phát hành commit từ `origin/main`. Mỗi bản được build trong `releases/` và kiểm tra tại cổng tạm trước khi chuyển symlink `current`. Service `batam-dashboard` chạy trên `127.0.0.1:3105`. Lần restart service có thể gây gián đoạn ngắn.

## Chuẩn bị VPS (một lần)

1. Cài Node.js 20.19+ (hoặc 22.13+/24+), Yarn 1, Git, Nginx, systemd, curl và `ss`. Tạo user `www-data` nếu máy chưa có. Cho VPS quyền đọc Git repository `https://github.com/nexhuber/batam.git` hoặc đặt `BATAM_GIT_URL`.
2. Tạo DNS cho domain Batam, rồi đăng ký chính xác `https://<domain>/auth/callback` trong Lark Custom App.
3. Tạo `/var/www/html/batam/.env` trên VPS với `SESSION_SECRET`, `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_REDIRECT_URI`, `BQ_PROJECT`, `BQ_DATASET`, `BQ_LOCATION`, `MONARCH_API_BASE_URL` và `BRAND_PIVOT_API_TOKEN`. File này nằm ngoài `releases/`, có quyền `600`. Nếu chưa có file, có thể truyền `BATAM_ENV_SOURCE=/path/to/trusted.env` trong lần deploy đầu; script chỉ nhập các biến Batam và đặt callback theo `BATAM_DOMAIN`.
4. Nếu dùng `GOOGLE_APPLICATION_CREDENTIALS=./credentials/<file>.json`, đặt JSON tại `/var/www/html/batam/credentials/<file>.json`. Script chép file vào từng release với quyền hạn chế để `www-data` đọc. Đường dẫn tuyệt đối ngoài `releases/` cũng được hỗ trợ nếu `www-data` đọc được. Có thể để trống khi VPS đã có Application Default Credentials.
5. Sau lần deploy đầu, dùng template trong release để tạo Nginx site, thay `__DOMAIN__` và `__PORT__` bằng domain và `3105`. Chạy các lệnh sau trên VPS, rồi cấp HTTPS khi DNS sẵn sàng. Script deploy không sửa Nginx hoặc TLS; nếu site cũ còn trỏ cổng `3200`, đổi `proxy_pass` sang `3105` trước khi phát hành.

```bash
sed -e 's/__DOMAIN__/batam.example.com/g' -e 's/__PORT__/3105/g' /var/www/html/batam/current/deploy/nginx.conf.template \
  | sudo tee /etc/nginx/sites-available/batam-dashboard >/dev/null
sudo ln -sfn /etc/nginx/sites-available/batam-dashboard /etc/nginx/sites-enabled/batam-dashboard
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx --redirect -d batam.example.com
```

## Deploy lần đầu và các lần sau

Nếu VPS chưa có checkout, clone repo trên VPS rồi deploy (sau khi đã tạo `.env` như trên):

```bash
ssh user@vps
sudo mkdir -p /var/www/html/batam
sudo git clone https://github.com/nexhuber/batam.git /var/www/html/batam/source
sudo BATAM_DOMAIN='batam.example.com' bash /var/www/html/batam/source/deploy/deploy.sh
```

Nếu repo đã nằm ngay tại `/var/www/html/batam`, chạy script tại đó thay cho đường dẫn `source`. Mỗi lần deploy chỉ `fetch` và `archive` commit từ `origin/main`; không reset checkout hoặc lấy thay đổi chưa commit.

```bash
sudo BATAM_DOMAIN='batam.example.com' bash /var/www/html/batam/current/deploy/deploy.sh
bash /var/www/html/batam/current/deploy/deploy.sh --status
bash /var/www/html/batam/current/deploy/deploy.sh --history
bash /var/www/html/batam/current/deploy/deploy.sh --logs
sudo BATAM_DOMAIN='batam.example.com' bash /var/www/html/batam/current/deploy/deploy.sh --rollback
```

`BATAM_APP_DIR` mặc định `/var/www/html/batam` trên Linux, `BATAM_PORT=3105`, `BATAM_GIT_BRANCH=main` và `BATAM_KEEP_RELEASES=5`. `--rollback` dùng release khỏe mạnh ngay trước đó và kiểm tra lại health. Script giữ cả release hiện tại lẫn release rollback khi dọn bản cũ. Nếu dùng đường dẫn `.env` khác, đặt `BATAM_ENV_FILE` nhất quán khi deploy; systemd unit sẽ trỏ tới file đó.

## Chạy bằng nohup trên máy local

Trên macOS, script mặc định dùng `nohup` và thư mục project hiện tại. Tạo `.env` riêng cho quy trình release (có thể sao chép cấu hình từ `.env.local`), đặt Lark callback phù hợp và chạy `bash deploy/deploy.sh`. Có thể chọn `BATAM_PM=nohup` trên Linux. Script vẫn lấy `origin/main`; `yarn dev` dùng `.env.local` và không phụ thuộc quy trình deploy này.

## Kiểm tra sau deploy

```bash
sudo systemctl status batam-dashboard --no-pager
sudo journalctl -u batam-dashboard -n 100 --no-pager
curl -fsS http://127.0.0.1:3105/api/health
curl -fsS https://batam.example.com/api/health
```

Health check chỉ xác nhận Next.js chạy. Kiểm tra thêm đăng nhập Lark, truy vấn BigQuery và API Monarch trên giao diện. Script không tạo cron cho `news:weekly`.
