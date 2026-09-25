import { redirect } from "next/navigation";
import { checkBigQueryConnection } from "@/lib/bigquery";
import { currentUser } from "@/lib/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  let result: number | null = null;
  let queryFailed = false;
  try {
    result = await checkBigQueryConnection();
  } catch (error) {
    console.error("BigQuery connection check failed", error);
    queryFailed = true;
  }

  return (
    <main className="mx-auto max-w-3xl p-6 md:p-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-blue-700">Batam Dashboard</p>
          <h1 className="mt-2 text-3xl font-bold">Kiểm tra kết nối BigQuery</h1>
          <p className="mt-2 text-slate-600">Đã đăng nhập qua Lark: {user.name || user.email || user.id}</p>
        </div>
        <a href="/auth/logout" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50">
          Đăng xuất
        </a>
      </header>
      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-500">Truy vấn chạy trên Next.js server</p>
        <code className="mt-3 block rounded-lg bg-slate-900 p-4 text-sm text-white">SELECT 1 AS connection_ok</code>
        {queryFailed ? (
          <p role="alert" className="mt-5 rounded-lg bg-red-50 p-4 text-red-700">
            Không thể truy vấn BigQuery. Kiểm tra BQ_PROJECT, BQ_LOCATION, credentials và quyền chạy query trong log server.
          </p>
        ) : (
          <p className="mt-5 rounded-lg bg-green-50 p-4 font-medium text-green-800">connection_ok = {result}</p>
        )}
      </section>
    </main>
  );
}
