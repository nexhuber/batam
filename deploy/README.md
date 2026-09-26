# Deploy Batam

Batam dùng `deploy/deploy.sh` để build commit từ `origin/main` trong `releases/`, kiểm tra health rồi chuyển symlink `current` và restart systemd service `batam` trên `127.0.0.1:3105`. Script tự cài cron sau deploy và đồng bộ cron khi rollback. Lần restart có thể gây gián đoạn ngắn.

Domain cố định là **ba8.nexhubco.vn**, tương tự cách cấu hình Monarch. Nginx và HTTPS cài riêng một lần; deploy không tạo/sửa Nginx hoặc gọi Certbot. Không cần biến `BATAM_DOMAIN` hoặc `BATAM_CERTBOT_EMAIL`; có thể xóa các biến cũ khỏi env. Lệnh `--configure-web` được thay bằng quy trình cấu hình thủ công bên dưới.

## Chuẩn bị VPS

1. Cài Node.js 20.19+ (hoặc 22.13+/24+), Yarn 1, Git, systemd, curl, `ss`, cron và user `www-data`. Cho VPS quyền đọc repository `https://github.com/nexhuber/batam.git`.
2. Tạo `/var/www/html/batam/.env` với các biến trong `.env.example`; đặt `LARK_REDIRECT_URI=https://ba8.nexhubco.vn/auth/callback` và đăng ký đúng URL đó trong Lark console. Env có quyền `600`, nằm ngoài releases.
3. Có thể dùng `BATAM_ENV_SOURCE=/path/to/trusted.env` để nhập cấu hình lần đầu; script đặt callback Batam cố định, không sao chép callback của app nguồn.
4. Nếu dùng `GOOGLE_APPLICATION_CREDENTIALS=./credentials/<file>.json`, đặt JSON trong `/var/www/html/batam/credentials/`. Script chép vào release để `www-data` đọc được. Đường dẫn tuyệt đối ngoài releases hoặc ADC cũng được hỗ trợ.

## Deploy lần đầu và các lần sau

Từ checkout đã pull code mới:

```bash
sudo bash deploy/deploy.sh
```

Nếu checkout ở thư mục `source`:

```bash
cd /var/www/html/batam/source
sudo git pull --ff-only origin main
sudo bash deploy/deploy.sh
```

Nếu chưa có repository, clone trước:

```bash
sudo mkdir -p /var/www/html/batam
sudo git clone https://github.com/nexhuber/batam.git /var/www/html/batam/source
sudo bash /var/www/html/batam/source/deploy/deploy.sh
```

Script chỉ lấy commit từ `origin/main`, không lấy thay đổi chưa commit. Khi nâng cấp từ service `batam-dashboard`, script tự dừng/gỡ unit cũ và cài service `batam`. Tên site Nginx vẫn là `batam-dashboard`.

```bash
sudo bash /var/www/html/batam/current/deploy/deploy.sh --rollback
sudo bash /var/www/html/batam/current/deploy/deploy.sh --status
sudo bash /var/www/html/batam/current/deploy/deploy.sh --history
sudo bash /var/www/html/batam/current/deploy/deploy.sh --logs
```

Mặc định: `BATAM_APP_DIR=/var/www/html/batam`, `BATAM_PORT=3105`, `BATAM_GIT_BRANCH=main`, `BATAM_KEEP_RELEASES=5`. Nếu đổi `BATAM_ENV_FILE`, truyền cùng giá trị đó khi deploy/cài cron. Nếu đổi port, sửa `proxy_pass` trong Nginx tương ứng. Rollback phục hồi release khỏe mạnh trước đó và kiểm tra health.

## Nginx và HTTPS — cấu hình một lần

**Nếu HTTPS của Batam đang chạy bình thường thì bỏ qua bước này.** Giữ nguyên site đã được Certbot cấu hình, không chép đè bằng file HTTP mẫu.

Với VPS chưa có site: cài Nginx và Certbot Nginx plugin, trỏ DNS `ba8.nexhubco.vn` về VPS và mở cổng 80/443. Sau khi app đã chạy, từ checkout:

```bash
sudo cp -n deploy/nginx-batam.conf.example /etc/nginx/sites-available/batam-dashboard
sudo ln -s /etc/nginx/sites-available/batam-dashboard /etc/nginx/sites-enabled/batam-dashboard
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d ba8.nexhubco.vn
```

Nếu site hoặc symlink đã tồn tại, kiểm tra cấu hình đang dùng thay vì tạo site thứ hai. File mẫu đặt `server_name ba8.nexhubco.vn` và proxy về `127.0.0.1:3105`. Certbot bổ sung HTTPS vào file trên VPS; deploy sau đó giữ nguyên file này. Việc gia hạn chứng chỉ do lịch Certbot trên VPS đảm nhiệm, không phụ thuộc deploy app.

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
