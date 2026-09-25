import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { safeNextPath } from "@/lib/session";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  invalid_callback: "Lark không trả về mã đăng nhập hợp lệ. Vui lòng thử lại.",
  invalid_state: "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng thử lại.",
  lark_error: "Không thể xác thực với Lark. Vui lòng thử lại.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  if (await currentUser()) redirect("/");
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const loginUrl = `/auth/login?next=${encodeURIComponent(next)}`;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-widest text-blue-700">Batam</p>
        <h1 className="mt-2 text-2xl font-bold">Đăng nhập dashboard</h1>
        <p className="mt-2 text-sm text-slate-600">Sử dụng tài khoản Lark của bạn.</p>
        {params.error && (
          <p role="alert" className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {messages[params.error] || "Đăng nhập thất bại. Vui lòng thử lại."}
          </p>
        )}
        <a href={loginUrl} className="mt-6 block rounded-lg bg-blue-700 px-4 py-3 text-center font-medium text-white hover:bg-blue-800">
          Đăng nhập bằng Lark
        </a>
      </div>
    </main>
  );
}
