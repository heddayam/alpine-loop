import { HikeBuilder } from "@/components/builder/HikeBuilder";
import { loadBuilderPack } from "@/lib/packs/builder-pack";
import { loadPackCatalog } from "@/lib/packs/pack-catalog";

type HomeProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function selectedPackIds(params: Record<string, string | string[] | undefined>): string[] {
  const raw = first(params.packs);
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const catalog = await loadPackCatalog();
  const selected = selectedPackIds(params);
  const explicitlyEmpty = first(params.packs) === "none";
  const pack = await loadBuilderPack(first(params.pack) ?? (explicitlyEmpty ? undefined : selected[0]));

  return (
    <HikeBuilder
      pack={pack}
      regions={catalog.regions}
      initialSelectedPackIds={explicitlyEmpty ? [] : selected.length ? selected : [pack.id]}
      restoreJobId={first(params.job)}
    />
  );
}
