# Deploy Batam

Batam dùng `deploy/deploy.sh` để phát hành commit từ `origin/main`. Mỗi bản được build trong `releases/` và kiểm tra tại cổng tạm trước khi chuyển symlink `current`. Systemd service `batam` chạy trên `127.0.0.1:3105`. Nginx site vẫn tên `batam-dashboard`. Khi nâng cấp từ bản cũ, script dừng và gỡ unit `batam-dashboard`, sau đó tạo và bật unit `batam`. Trên VPS, script tự tạo Nginx site lần đầu, cấp HTTPS bằng Certbot nếu cần và kiểm tra chứng chỉ. Lần restart service có thể gây gián đoạn ngắn.

## Chuẩn bị VPS (một lần)

1. Cài Node.js 20.19+ (hoặc 22.13+/24+), Yarn 1, Git, Nginx, Certbot Nginx plugin, systemd, curl và `ss`. Tạo user `www-data` nếu máy chưa có. Cho VPS quyền đọc Git repository `https://github.com/nexhuber/batam.git` hoặc đặt `BATAM_GIT_URL`.
2. Cho DNS của `ba8.nexhubco.vn` trỏ về VPS, mở cổng 80/443, rồi đăng ký chính xác `https://ba8.nexhubco.vn/auth/callback` trong Lark Custom App.
3. Tạo `/var/www/html/batam/.env` trên VPS với `SESSION_SECRET`, `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_REDIRECT_URI`, `BQ_PROJECT`, `BQ_DATASET`, `BQ_LOCATION`, `MONARCH_API_BASE_URL` và `BRAND_PIVOT_API_TOKEN`. File này nằm ngoài `releases/`, có quyền `600`. Nếu chưa có file, có thể truyền `BATAM_ENV_SOURCE=/path/to/trusted.env` trong lần deploy đầu; script chỉ nhập các biến Batam và đặt callback theo `BATAM_DOMAIN`.
4. Nếu dùng `GOOGLE_APPLICATION_CREDENTIALS=./credentials/<file>.json`, đặt JSON tại `/var/www/html/batam/credentials/<file>.json`. Script chép file vào từng release với quyền hạn chế để `www-data` đọc. Đường dẫn tuyệt đối ngoài `releases/` cũng được hỗ trợ nếu `www-data` đọc được. Có thể để trống khi VPS đã có Application Default Credentials.
5. Đặt `BATAM_DOMAIN=ba8.nexhubco.vn` khi deploy. Script tạo `/etc/nginx/sites-available/batam-dashboard` nếu chưa có, bật site, chạy `nginx -t`, reload và gọi Certbot khi chứng chỉ HTTPS chưa hợp lệ. Tên site Nginx độc lập với tên systemd service. Nếu Certbot chưa có tài khoản, truyền thêm `BATAM_CERTBOT_EMAIL=you@example.com`. Site đã được Certbot chỉnh TLS sẽ được giữ lại ở các lần deploy sau. Nếu site Batam có sẵn nhưng khác domain/cổng, script dừng và báo đường dẫn cần kiểm tra, tránh ghi đè cấu hình đang chạy.

## Deploy lần đầu và các lần sau

Khi đổi tên service từ `batam-dashboard` sang `batam`, trước tiên đưa thay đổi lên `origin/main`. Trên VPS, cập nhật checkout chứa script deploy rồi chạy script mới. Nếu checkout là `/var/www/html/batam/source`:

```bash
cd /var/www/html/batam/source
sudo git pull --ff-only origin main
sudo BATAM_DOMAIN='ba8.nexhubco.vn' bash deploy/deploy.sh
```

Nếu Git checkout nằm trực tiếp ở `/var/www/html/batam`, chạy `git pull` tại thư mục đó rồi chạy `sudo BATAM_DOMAIN='ba8.nexhubco.vn' bash deploy/deploy.sh`. Script sẽ dừng và disable unit cũ, cài `batam.service`, rồi deploy release mới. Sau deploy xác nhận bằng `sudo systemctl status batam --no-pager` và `sudo journalctl -u batam -n 100 --no-pager`.

Nếu VPS chưa có checkout, clone repo trên VPS rồi deploy (sau khi đã tạo `.env` như trên):

```bash
ssh user@vps
sudo mkdir -p /var/www/html/batam
sudo git clone https://github.com/nexhuber/batam.git /var/www/html/batam/source
sudo BATAM_DOMAIN='ba8.nexhubco.vn' bash /var/www/html/batam/source/deploy/deploy.sh
```

Nếu repo đã nằm ngay tại `/var/www/html/batam`, chạy script tại đó thay cho đường dẫn `source`. Mỗi lần deploy chỉ `fetch` và `archive` commit từ `origin/main`; không reset checkout hoặc lấy thay đổi chưa commit.

```bash
sudo BATAM_DOMAIN='ba8.nexhubco.vn' bash /var/www/html/batam/current/deploy/deploy.sh
bash /var/www/html/batam/current/deploy/deploy.sh --status
bash /var/www/html/batam/current/deploy/deploy.sh --history
bash /var/www/html/batam/current/deploy/deploy.sh --logs
sudo BATAM_DOMAIN='ba8.nexhubco.vn' bash /var/www/html/batam/current/deploy/deploy.sh --rollback
```

`BATAM_APP_DIR` mặc định `/var/www/html/batam` trên Linux, `BATAM_PORT=3105`, `BATAM_GIT_BRANCH=main` và `BATAM_KEEP_RELEASES=5`. `--rollback` dùng release khỏe mạnh ngay trước đó và kiểm tra lại health. Script giữ cả release hiện tại lẫn release rollback khi dọn bản cũ. Nếu dùng đường dẫn `.env` khác, đặt `BATAM_ENV_FILE` nhất quán khi deploy; systemd unit sẽ trỏ tới file đó.

Nếu ứng dụng đã chạy nhưng HTTPS đang trả chứng chỉ của domain khác, cập nhật script trên VPS rồi chạy riêng:

```bash
sudo BATAM_DOMAIN='ba8.nexhubco.vn' bash /var/www/html/batam/source/deploy/deploy.sh --configure-web
```

Lệnh này kiểm tra service ở cổng 3105, cấu hình Nginx/Certbot và xác thực chứng chỉ qua HTTPS mà không build lại ứng dụng. Nếu build trước đó chưa tạo `current`, chạy deploy bình thường trước.

## Chạy bằng nohup trên máy local

Trên macOS, script mặc định dùng `nohup` và thư mục project hiện tại. Tạo `.env` riêng cho quy trình release (có thể sao chép cấu hình từ `.env.local`), đặt Lark callback phù hợp và chạy `bash deploy/deploy.sh`. Có thể chọn `BATAM_PM=nohup` trên Linux. Script vẫn lấy `origin/main`; `yarn dev` dùng `.env.local` và không phụ thuộc quy trình deploy này.

## Kiểm tra sau deploy

```bash
sudo systemctl status batam --no-pager
sudo journalctl -u batam -n 100 --no-pager
curl -fsS http://127.0.0.1:3105/api/health
curl -fsS https://ba8.nexhubco.vn/api/health
```

Health check chỉ xác nhận Next.js chạy. Kiểm tra thêm đăng nhập Lark, truy vấn BigQuery và API Monarch trên giao diện. Script cài Linux cron gọi API job riêng; `news:weekly` vẫn chỉ tạo/lưu news.

## Linux cron

Thêm vào env VPS (giữ quyền `600`, không commit):

```dotenv
CRON_SECRET=<secret riêng tạo bằng openssl rand -hex 32>
LARK_WEBHOOK_URL=<URL webhook Lark custom bot>
```

`BATAM_ENV_SOURCE` cũng nhập hai biến này nếu có. Chạy cron cần các cấu hình Monarch và BigQuery đang dùng, cùng bảng `news_history` đã tạo; không có migration mới. Lark bot phải chấp nhận text webhook với cấu hình bảo mật của bot hiện tại.

VPS cần `crontab`, daemon `cron` hoặc `crond` đang active, `curl` hỗ trợ `--fail-with-body`, Node và systemd. Installer kiểm tra timezone process daemon (biến `TZ` nếu có), hoặc timezone hệ thống với `timedatectl` và `/etc/timezone`. Nếu hai cấu hình hệ thống không khớp, không xác định được hoặc timezone không hỗ trợ thì dừng cài lịch và giữ crontab cũ. Script không đổi timezone hay cài/bật daemon thay quản trị viên. Nếu crontab hiện có `CRON_TZ`, installer dừng để tránh kế thừa timezone khác từ cron cũ; cần xử lý override đó trước.

- Daemon UTC (kể cả alias Etc/UTC, GMT, Etc/GMT): `0 1 * * 1`.
- Daemon Asia/Ho_Chi_Minh: `0 8 * * 1`.

Cả hai đều là 08:00 GMT+7 thứ Hai. Sau khi thay timezone máy/daemon, cần restart cron phù hợp và chạy lại installer. Không dùng biến `TZ` trong crontab để giả định đổi giờ lập lịch.

Deploy khỏe mạnh tự cài block `# BEGIN BATAM CRON` đến `# END BATAM CRON` trong crontab root, giữ các lịch khác. Nếu cài cron thất bại, app vẫn hoạt động nhưng deploy báo lỗi rõ; sửa cấu hình rồi chạy riêng:

```bash
sudo bash /var/www/html/batam/current/deploy/deploy.sh --setup-cron
sudo crontab -l
sudo systemctl status cron --no-pager  # dùng crond nếu distro chạy crond
```

Cron gọi wrapper ở `current/deploy/run-cron.sh`, đọc secret từ env; secret không nằm trong crontab hoặc đối số curl. Wrapper gọi app trực tiếp ở loopback, timeout kết nối 10 giây, timeout request 900 giây, không retry cả request. Vượt 900 giây không đảm bảo tác vụ trong app đã dừng: xem log trước khi chạy lại. App chỉ retry phần webhook.

Rollback đồng bộ lịch với release phục hồi; rollback về bản chưa có cron sẽ gỡ block Batam. Installer chỉ chạy khi dùng Linux/systemd; không tự cài trên macOS hoặc chế độ nohup. Nếu đổi `BATAM_ENV_FILE`, tiếp tục truyền cùng giá trị đó khi cài lại cron.

Chạy thủ công **có ghi BigQuery và gửi Lark thật**:

```bash
sudo bash /var/www/html/batam/current/deploy/run-cron.sh \
  /var/www/html/batam /var/www/html/batam/.env 3105 weekly-brand-inventory
```

Job chạy lại cùng kỳ vẫn gửi lại news cũ. Không lưu trạng thái giao tin, không tự chạy bù khi VPS tắt lúc lịch chạy.

```bash
sudo tail -n 100 /var/www/html/batam/.cron.log
sudo journalctl -u batam -n 100 --no-pager
sudo bash /var/www/html/batam/current/deploy/deploy.sh --logs
```

Log wrapper nằm ngoài release nên tồn tại qua deploy/rollback; cấu hình logrotate theo vận hành VPS nếu cần. Log app ghi job, thời gian chạy, kết quả và từng lần gửi thất bại, không ghi secret/webhook URL. `/api/health` chỉ xác nhận app hoạt động, không chứng minh cron, Monarch, BigQuery hay Lark đã chạy thành công.
