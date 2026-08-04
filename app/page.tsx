import { HikeBuilder } from "@/components/builder/HikeBuilder";
import { loadBuilderPack } from "@/lib/packs/builder-pack";

export default async function Home() {
  return <HikeBuilder pack={await loadBuilderPack()} />;
}
