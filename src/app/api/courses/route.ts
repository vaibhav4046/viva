/**
 * GET /api/courses — the older name for GET /api/subjects.
 *
 * Same handler, same payload, so nothing that already calls this path has to
 * change on the day the last caller moves over.
 */
export { GET } from "../subjects/route";
