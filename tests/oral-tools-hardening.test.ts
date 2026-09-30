import { describe, expect, it } from "vitest";
import { runOralTool } from "@/lib/oral/tools";
import { getCourse, DEFAULT_COURSE_ID } from "@/lib/courses";
import { isStarterId, resolveSubject, SubjectNotFoundError } from "@/lib/courses/subject";

describe("a tool that throws", () => {
  it("returns no exception text in the result the model and browser see", async () => {
    const ctx = {
      subject: { title: "t", concepts: [] } as never,
      course: null,
      get chunks(): never {
        throw new Error("ECONNREFUSED 10.1.2.3:5432 password=hunter2");
      },
    };
    const { result, isError } = await runOralTool(ctx, "search_my_material", { query: "attention" });
    expect(isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3/);
  });
});

describe("course lookup by an id that names an inherited property", () => {
  it("getCourse falls back to the default instead of returning Object.prototype members", () => {
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(getCourse(id).id, id).toBe(DEFAULT_COURSE_ID);
    }
  });

  it("isStarterId is false for them", () => {
    for (const id of ["constructor", "__proto__", "toString"]) expect(isStarterId(id), id).toBe(false);
  });

  it("resolveSubject raises the not-found error a route turns into a 404, not a TypeError", async () => {
    const store = { getSubject: async () => null } as never;
    for (const id of ["constructor", "__proto__", "toString"]) {
      await expect(resolveSubject(store, "u", id), id).rejects.toBeInstanceOf(SubjectNotFoundError);
    }
  });
});
