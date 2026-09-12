import { redirect } from "next/navigation";

/** The study screen had three names. It has one now. */
export default function DemoRedirect() {
  redirect("/study");
}
