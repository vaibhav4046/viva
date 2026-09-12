import { redirect } from "next/navigation";

/** "Memory" was our word for it. Students call it the map. */
export default function MemoryRedirect() {
  redirect("/map");
}
