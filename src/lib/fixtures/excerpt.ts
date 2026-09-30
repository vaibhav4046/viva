/**
 * The session excerpt shown on the landing page.
 *
 * Until a real recorded session exists in public/recordings, this is a fixture:
 * a scripted exchange built from the labelled sample course (Transformers,
 * Week 4, VIVA course notes). The quoted passage is copied verbatim from
 * ch_pos_2 of that course, and tests/landing-excerpt.test.ts fails if the quote
 * stops being a substring of the course text. The learner lines are written for
 * this excerpt; nobody said them. The caption says so.
 */
export const EXCERPT = {
  course: "Transformers, Week 4 (VIVA course notes, sample)",
  question: "Suppose we remove the positional encodings. What does the model lose?",
  learnerAnswer: "It loses track of which words are important, so the ranking of relevance is gone.",
  learnerWrong: "which words are important",
  stateLine: "Checking page 12",
  passage: {
    page: 12,
    section: "3 · Positional information",
    passageId: "ch_pos_2",
    before: "Because attention is permutation-equivariant, removing positional information makes the model treat a shuffled sentence nearly the same as the original: ",
    match: "it can still compare tokens and find which ones are related, but it cannot distinguish their order",
    after: ".",
    method: "Verbatim match, checked by code against your page.",
  },
  correction:
    "Not importance. Page 12 says the model can still tell which tokens are related. What it cannot recover is their order. Try the sentence again with that.",
} as const;

/** Caption when no recorded session exists yet. Honest about what this is. */
export const FIXTURE_CAPTION =
  "Scripted excerpt built from the sample course. The learner line is written, not recorded. A real recorded session replaces this when one is published.";
