import { redirect } from "next/navigation";

import { NewsTimeline } from "@/app/news-timeline";
import { currentUser } from "@/lib/current-user";
import { listNews, listNewsTypes, type NewsPage } from "@/lib/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  let initialPage: NewsPage = { items: [], nextCursor: null };
  let types: string[] = [];
  let initialError = false;
  try {
    [initialPage, types] = await Promise.all([listNews(), listNewsTypes()]);
  } catch (error) {
    console.error("Could not load news timeline", error);
    initialError = true;
  }

  return (
    <NewsTimeline
      initialPage={initialPage}
      types={types}
      initialError={initialError}
      userName={user.name || user.email || user.id}
    />
  );
}
