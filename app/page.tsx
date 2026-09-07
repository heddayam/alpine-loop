import { HikeBuilder } from "@/components/builder/HikeBuilder";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { job } = await searchParams;
  return <HikeBuilder restoreJobId={Array.isArray(job) ? job[0] : job} />;
}
