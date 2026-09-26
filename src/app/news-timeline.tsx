"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { News, NewsPage } from "@/lib/news";

type Props = {
  initialPage: NewsPage;
  types: string[];
  initialError: boolean;
  userName: string;
};

function typeLabel(type: string): string {
  if (type === "weekly_brand_inventory") return "Tồn kho theo Brand · Tuần";
  return type.replaceAll("_", " ");
}

function newsTitle(news: News): string {
  return news.content.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || typeLabel(news.news_type);
}

function newsPreviewContent(news: News): string {
  return news.content.replace(/^#{1,6}\s+.+(?:\r?\n|$)/m, "").trim();
}

const dateFormat = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function NewsTimeline({ initialPage, types, initialError, userName }: Props) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [selectedType, setSelectedType] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError ? "Không thể tải danh sách news." : "");
  const [initialLoadError, setInitialLoadError] = useState(initialError);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);

  const loadPage = useCallback(async (type: string, cursor: string | null, replace: boolean) => {
    if (!replace && (!cursor || loadingRef.current)) return;
    if (replace) controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    loadingRef.current = true;
    setLoading(true);
    setError("");

    const search = new URLSearchParams();
    if (type) search.set("type", type);
    if (cursor) search.set("cursor", cursor);
    try {
      const response = await fetch(`/api/news?${search}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = await response.json() as NewsPage;
      if (!Array.isArray(page.items) || !(typeof page.nextCursor === "string" || page.nextCursor === null)) {
        throw new Error("Invalid news response");
      }
      if (controller.signal.aborted) return;
      setInitialLoadError(false);
      setItems((previous) => {
        if (replace) return page.items;
        const seen = new Set(previous.map((item) => item.id));
        return [...previous, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error && cause.message === "HTTP 401"
          ? "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
          : "Không thể tải news. Vui lòng thử lại.");
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!nextCursor || loading || error || !sentinelRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void loadPage(selectedType, nextCursor, false);
    }, { rootMargin: "480px 0px" });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [error, loadPage, loading, nextCursor, selectedType]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  function selectType(type: string) {
    if (type === selectedType) return;
    setSelectedType(type);
    setItems([]);
    setNextCursor(null);
    setExpandedId(null);
    void loadPage(type, null, true);
  }

  function retry() {
    if (initialLoadError) {
      window.location.reload();
      return;
    }
    void loadPage(selectedType, nextCursor, items.length === 0);
  }

  return (
    <main className="min-h-screen bg-[#f5f7f4] text-slate-900">
      <div className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 lg:px-10">
        <header className="flex flex-wrap items-start justify-between gap-5 border-b border-slate-200 pb-8">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-teal-700">Batam · News archive</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Dòng thời gian tin tức</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
              Những bản tin mới nhất ở trên cùng. Chọn một loại tin và mở card để đọc toàn bộ nội dung.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="max-w-44 truncate text-slate-600" title={userName}>{userName}</span>
            <a href="/auth/logout" className="rounded-full border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 transition hover:border-teal-400 hover:text-teal-800">
              Đăng xuất
            </a>
          </div>
        </header>

        <div className="sticky top-0 z-20 -mx-4 border-b border-slate-200/80 bg-[#f5f7f4]/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
          <div className="mx-auto flex max-w-7xl items-center gap-2 overflow-x-auto" aria-label="Lọc theo loại news">
            {["", ...types].map((type) => (
              <button
                key={type || "all"}
                type="button"
                aria-pressed={selectedType === type}
                onClick={() => selectType(type)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition ${
                  selectedType === type
                    ? "bg-teal-800 text-white shadow-sm"
                    : "border border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:text-teal-800"
                }`}
              >
                {type ? typeLabel(type) : "Tất cả"}
              </button>
            ))}
          </div>
        </div>

        <section className="mx-auto max-w-6xl pt-9" aria-label="Dòng thời gian news">
          {items.length > 0 && (
            <div className="news-tree">
              {items.map((news, index) => {
                const expanded = expandedId === news.id;
                const created = new Date(news.created_at);
                return (
                  <div key={news.id} className={`news-entry ${index % 2 === 0 ? "news-entry-left" : "news-entry-right"}`}>
                    <div className="news-marker">
                      <span className="news-marker-dot" aria-hidden="true" />
                      <time dateTime={news.created_at} className="news-date">
                        <span>{dateFormat.format(created)}</span>
                        <span className="text-[11px] font-normal text-slate-500">{timeFormat.format(created)}</span>
                      </time>
                    </div>
                    <article className="news-card">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={expanded ? `news-content-${news.id}` : undefined}
                        onClick={() => setExpandedId(expanded ? null : news.id)}
                        className="block w-full cursor-pointer p-5 text-left sm:p-6"
                      >
                        <span className="inline-flex rounded-full bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800">
                          {typeLabel(news.news_type)}
                        </span>
                        <h2 className="mt-4 text-lg font-semibold leading-snug text-slate-900">{newsTitle(news)}</h2>
                        {!expanded && (
                          <div className="news-markdown news-preview mt-3" aria-label="Nội dung xem trước">
                            <Markdown remarkPlugins={[remarkGfm]}>{newsPreviewContent(news)}</Markdown>
                          </div>
                        )}
                        <span className="mt-5 inline-flex text-xs font-semibold text-teal-700">
                          {expanded ? "Thu gọn ↑" : "Đọc toàn bộ ↓"}
                        </span>
                      </button>
                      {expanded && (
                        <>
                          <div id={`news-content-${news.id}`} className="news-markdown border-t border-slate-100 px-5 pb-6 pt-5 sm:px-6">
                            <Markdown remarkPlugins={[remarkGfm]}>{news.content}</Markdown>
                          </div>
                          <button
                            type="button"
                            onClick={() => setExpandedId(null)}
                            className="mx-5 mb-5 inline-flex cursor-pointer text-xs font-semibold text-teal-700 hover:text-teal-900 sm:mx-6"
                          >
                            Thu gọn ↑
                          </button>
                        </>
                      )}
                    </article>
                  </div>
                );
              })}
            </div>
          )}

          {loading && <p role="status" className="py-10 text-center text-sm text-slate-500">Đang tải thêm news…</p>}
          {error && (
            <div role="alert" className="mx-auto my-10 max-w-md rounded-2xl border border-rose-200 bg-white p-5 text-center shadow-sm">
              <p className="text-sm text-rose-700">{error}</p>
              <button type="button" onClick={retry} className="mt-4 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
                Thử lại
              </button>
            </div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="mx-auto my-12 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <p className="text-lg font-semibold">Chưa có news</p>
              <p className="mt-2 text-sm text-slate-500">News của loại này sẽ xuất hiện ở đây khi được tạo.</p>
            </div>
          )}
          {!loading && !error && items.length > 0 && !nextCursor && (
            <p className="py-8 text-center text-xs font-medium uppercase tracking-widest text-slate-400">Đã xem hết news</p>
          )}
          <div ref={sentinelRef} className="h-4" aria-hidden="true" />
        </section>
      </div>
    </main>
  );
}
