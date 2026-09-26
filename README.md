# Batam News

Ứng dụng Next.js hiển thị lịch sử news từ BigQuery cho người dùng đăng nhập bằng Lark. News mới nhất ở trên cùng, có thể lọc theo loại, mở nội dung Markdown và cuộn để tải thêm. Credentials BigQuery chỉ nằm trên server.

## Chạy local

Yêu cầu Node.js 20.19+ (hoặc 22.13+/24+) và Yarn 1.

```bash
yarn install
cp .env.example .env.local
```

Điền các biến trong `.env.local`:

- `PORT`: cổng chạy local, mặc định 3105. Deploy VPS cấu hình riêng bằng `BATAM_PORT`.
- `SESSION_SECRET`: khóa bí mật để ký OAuth state và session cookie; có thể tạo bằng `openssl rand -hex 32`.
- `LARK_APP_ID`, `LARK_APP_SECRET`: thông tin Lark Custom App.
- `LARK_REDIRECT_URI`: URL callback đăng ký trong Lark console; khi chạy local là `http://localhost:3105/auth/callback`.
- `GOOGLE_APPLICATION_CREDENTIALS`: đường dẫn `./credentials/<file>.json` hoặc đường dẫn tuyệt đối tới service-account JSON. Có thể để trống nếu môi trường đã có Application Default Credentials (ADC).
- `BQ_PROJECT`, `BQ_DATASET`, `BQ_LOCATION`: Google Cloud project, dataset lưu news và BigQuery job location.
- `MONARCH_API_BASE_URL`: origin Monarch (ví dụ `https://monarch.example.com`) dùng cho báo cáo tồn kho theo Brand.
- `BRAND_PIVOT_API_TOKEN`: bearer token server-side, phải trùng với cấu hình trong Monarch.

```bash
yarn dev
```

Mở `http://localhost:3105`. Trang chính yêu cầu đăng nhập Lark, tải 10 news đầu tiên và các loại news hiện có từ BigQuery. News ẩn không được hiển thị. Khi cuộn xuống, trình duyệt gọi `GET /api/news?type=&cursor=` để tải từng lượt 10 news. Bộ lọc loại news và cursor được xử lý trên server. Người dùng đăng nhập thành công qua Lark app đều có thể vào; hiện không có allowlist.

## Kiểm tra source

```bash
yarn lint
yarn typecheck
yarn build
```

Lark app cần được cấu hình cho đăng nhập web và redirect URI phải khớp chính xác. Service account hoặc ADC cần quyền tạo BigQuery job trong `BQ_PROJECT` (ví dụ `bigquery.jobs.create`) và quyền đọc bảng `news_history`.

## Báo cáo tồn kho theo Brand

Các function server-side nhận hai ngày snapshot cụ thể để so sánh. Helper weekly tự tính hai Chủ nhật gần nhất theo giờ Việt Nam:

```ts
import { getBrandInventoryData, getWeeklyBrandInventoryData } from "@/lib/brand-inventory";
import { formatBrandInventoryMarkdown } from "@/lib/brand-inventory-markdown";

const weeklyData = await getWeeklyBrandInventoryData();
const weeklyMarkdown = formatBrandInventoryMarkdown(weeklyData);

const customData = await getBrandInventoryData("2026-09-13", "2026-09-20", "week");
const customMarkdown = formatBrandInventoryMarkdown(customData);
```

Các function nằm trong `src/lib/brand-inventory.ts` và `src/lib/brand-inventory-markdown.ts`; không có trang hoặc API route mới. Mỗi kỳ là một ngày snapshot, không phải tổng các ngày trong khoảng. Batam gọi API Brand × Kỳ của Monarch với đúng hai snapshot cần so sánh; Monarch dùng Portfolio Pricing làm nguồn Brand và giá vốn. Nếu thiếu snapshot, API không sẵn sàng hoặc cấu hình token sai, function báo lỗi thay vì thay ngày khác. Đặt `MONARCH_API_BASE_URL` và cùng một `BRAND_PIVOT_API_TOKEN` ở cả hai môi trường server.

## Lưu lịch sử news

Tạo dataset `news` ở cùng location với `BQ_LOCATION`, rồi chạy [schema SQL](sql/news_history.sql) một lần trong project `BQ_PROJECT`. Dataset và table không được đặt thời hạn tự xóa nếu cần giữ lịch sử lâu dài. Service account cần quyền `bigquery.jobs.create` trong project và `bigquery.tables.getData`, `bigquery.tables.updateData` trong dataset.

```bash
bq --project_id=YOUR_PROJECT mk --dataset --location=asia-southeast1 news
bq --project_id=YOUR_PROJECT --location=asia-southeast1 query --use_legacy_sql=false < sql/news_history.sql
```

Sau khi tạo Markdown cho báo cáo weekly, lưu news bằng ngày Chủ nhật hiện tại làm khóa kỳ:

```ts
import { storeNews } from "@/lib/news";

const { news, created } = await storeNews({
  newsType: "weekly_brand_inventory",
  periodKey: weeklyData.current_snapshot,
  content: weeklyMarkdown,
});
```

Để chạy toàn bộ bước lấy báo cáo, format và lưu đúng một news trên máy local, dùng `execute()` trong `src/lib/brand-inventory-markdown.ts` hoặc lệnh sau. Lệnh tự nạp `.env.local`/`.env`, yêu cầu đã tạo bảng và cấu hình Monarch cùng BigQuery:

```bash
yarn news:weekly
```

`storeNews` trả lại bản ghi cũ với `created: false` khi cron chạy lại cùng `newsType` và `periodKey`. Mỗi news mới có UUID, thời điểm tạo UTC và `is_hide=false`. Function chỉ chạy trên server; Linux cron gọi job tự động theo lịch bên dưới. BigQuery không thực thi ràng buộc unique, nên cron không nên chạy đồng thời với nhiều cấu hình ghi khác nhau cho cùng khóa kỳ.

## Deploy

Nginx, systemd và script deploy VPS nằm trong [deploy/README.md](deploy/README.md). Batam dùng một service và cổng riêng, mặc định `127.0.0.1:3105`.

## Cron bản tin tồn kho

Linux cron trên VPS gọi `POST /api/cron/weekly-brand-inventory` lúc **08:00 GMT+7 mỗi thứ Hai**. API dùng `Authorization: Bearer <CRON_SECRET>`, không dùng phiên đăng nhập Lark. Secret thiếu trả 503, token thiếu/sai trả 401, job không có trả 404, cùng job đang chạy trả 409, xử lý lỗi trả 500. Response thành công có `jobId`, `newsId`, `periodKey`, `created`, `attempts`, `durationMs`.

Job lấy hai Chủ nhật gần nhất bằng helper hiện có, lưu news rồi gửi toàn bộ nội dung đã lưu qua `LARK_WEBHOOK_URL` dạng text (Markdown là văn bản, không phải bảng tương tác của Lark). Ví dụ ngày 28/09/2026 so sánh 27/09 và 20/09. Thiếu snapshot hoặc lỗi lưu news thì không gửi. News cùng kỳ đã có được giữ nguyên và vẫn gửi lại.

Webhook có tối đa **3 lần gọi**, chờ 2 giây rồi 5 giây giữa các lần lỗi; mỗi lần timeout 30 giây. Chỉ bước gửi được retry, không tạo lại news. Hết lượt thì job báo lỗi và giữ news đã lưu. Không lưu trạng thái gửi: chạy lại hoặc timeout sau khi Lark đã nhận có thể gây tin nhắn trùng. Không tự chạy bù lịch bị bỏ lỡ. Giả định một VPS, một process app; khóa trong bộ nhớ chặn chạy đồng thời cùng job và tự giải phóng khi job kết thúc.

`yarn news:weekly` vẫn chỉ tạo/lưu news, không gửi Lark. Cách cài lịch, chạy toàn bộ job thủ công và xem log: [hướng dẫn deploy](deploy/README.md#linux-cron).

### Thêm job mới

1. Viết handler trong `src/lib/cron/jobs/`, trả về các thông tin kết quả có thể ghi log (không chứa secrets).
2. Đăng ký handler theo ID trong `src/lib/cron/registry.ts`.
3. Thêm cùng ID vào `src/lib/cron/schedules.json`: `timezone: "Asia/Ho_Chi_Minh"`, `schedule` là lịch giờ Việt Nam và `utcSchedule` là lịch UTC tương đương (nhớ đổi cả thứ/ngày khi qua nửa đêm). Registry này là nguồn lịch dùng chung cho app và installer.
4. Thêm test rồi deploy hoặc chạy `--setup-cron`. API và runner tự dùng job mới; không cần thêm route.
