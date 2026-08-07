import { HikeBuilder } from "@/components/builder/HikeBuilder";
import { loadBuilderPack } from "@/lib/packs/builder-pack";
import { loadPackCatalog } from "@/lib/packs/pack-catalog";

type HomeProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const catalog = await loadPackCatalog();
  const pack = await loadBuilderPack(first(params.pack));

  return (
    <HikeBuilder
      key={pack.id}
      pack={pack}
      regions={catalog.regions}
      restoreJobId={first(params.job)}
    />
  );
}
