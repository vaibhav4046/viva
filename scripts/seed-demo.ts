/** Seed / inspect the deterministic demo state (file store, local user). */
import { FileEventStore } from "../src/lib/store/file";
import { learnerDNA } from "../src/lib/store/index";

const store = new FileEventStore();
await store.seedDemoCourse("demo_local");
const mastery = await store.getMastery("demo_local");
const events = await store.listEvents("demo_local", 20);
console.log(`backend=file events=${events.length}`);
for (const [id, m] of Object.entries(mastery)) {
  console.log(`${id} mastery=${m.mastery} priority=${m.reviewPriority}`);
}
console.log(JSON.stringify(learnerDNA(mastery, events.filter((e) => e.intent === "confusion").map((e) => e.id), events.length), null, 2));
