# Batam Dashboard skeleton

Một ứng dụng Next.js cho giao diện và server. Người dùng đăng nhập bằng Lark; server dùng Google BigQuery SDK chạy `SELECT 1 AS connection_ok` và hiển thị kết quả. Không có credentials BigQuery trong trình duyệt.

## Chạy local

Yêu cầu Node.js 20.9+ và Yarn 1.

```bash
yarn install
cp .env.local.example .env.local
```

Điền các biến trong `.env.local`:

- `SESSION_SECRET`: khóa bí mật để ký OAuth state và session cookie; có thể tạo bằng `openssl rand -hex 32`.
- `LARK_APP_ID`, `LARK_APP_SECRET`: thông tin Lark Custom App.
- `LARK_REDIRECT_URI`: URL callback đăng ký trong Lark console; khi chạy local là `http://localhost:3000/auth/callback`.
- `GOOGLE_APPLICATION_CREDENTIALS`: đường dẫn tuyệt đối tới service-account JSON. Có thể để trống nếu môi trường đã có Application Default Credentials (ADC).
- `BQ_PROJECT`, `BQ_LOCATION`: Google Cloud project chạy query và BigQuery job location.
- `BATAM_PORTFOLIO_FILE`: đường dẫn tuyệt đối tới `portfolio-quan-tri-gia.xlsx` mà Monarch đang dùng; tiến trình Batam cần quyền đọc file.

```bash
yarn dev
```

Mở `http://localhost:3000`. Trang chính yêu cầu đăng nhập Lark. Sau khi đăng nhập, trang gọi BigQuery từ Next.js server và hiển thị `connection_ok = 1` khi query thành công. User đăng nhập thành công qua Lark app đều có thể vào; skeleton không có allowlist.

## Kiểm tra source

```bash
yarn lint
yarn typecheck
yarn build
```

Lark app cần được cấu hình cho đăng nhập web và redirect URI phải khớp chính xác. Service account hoặc ADC cần quyền tạo BigQuery job trong `BQ_PROJECT` (ví dụ `bigquery.jobs.create`). Trang chính vẫn chỉ chạy `SELECT 1` để kiểm tra kết nối.

## Báo cáo tồn kho theo Brand

Gọi hai function server-side để lấy dữ liệu hai Chủ nhật gần nhất theo giờ Việt Nam và tạo bảng Markdown:

```ts
import { getLatestSundayBrandInventoryComparison } from "@/lib/weekly-brand-inventory";
import { formatWeeklyBrandInventoryComparisonMarkdown } from "@/lib/weekly-brand-inventory-markdown";

const data = await getLatestSundayBrandInventoryComparison();
const markdown = formatWeeklyBrandInventoryComparisonMarkdown(data);
```

Các function nằm trong `src/lib/weekly-brand-inventory.ts` và `src/lib/weekly-brand-inventory-markdown.ts`; không có trang hoặc API route mới. Mỗi kỳ là một ngày snapshot, không phải tổng các ngày trong tuần. Nếu thiếu snapshot Chủ nhật hoặc file Portfolio, function báo lỗi. Trên VPS, đặt `BATAM_PORTFOLIO_FILE` trong `/var/www/html/batam/.env` trỏ tới file Monarch lưu và cấp quyền đọc cho `www-data`.

## Deploy

Nginx, systemd và script deploy VPS nằm trong [deploy/README.md](deploy/README.md). Batam dùng một service và cổng riêng, mặc định `127.0.0.1:3200`.
