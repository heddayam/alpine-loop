import { listManagedPacks, removeManagedPacks } from "../lib/packs/management";

try {
  const [command, ...ids] = process.argv.slice(2);
  if (command === "list" && ids.length === 0) {
    for (const pack of await listManagedPacks()) {
      console.log([pack.id, pack.label, Number(pack.installed), pack.size].join("\t"));
    }
  } else if (command === "remove" && ids.length) {
    await removeManagedPacks(ids);
  } else throw new Error("Usage: manage-packs.ts list | remove <pack-id> [...]");
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
