import type { SourceChunk } from "@/lib/types";
import type { Course } from "./types";

/**
 * Lab 2 — Probability Traps (STAT201).
 * Original educational text written for this project; every citation resolves
 * to a real chunk. Six topics, each with 2 chunks (12 total).
 */

const COURSE_ID = "course_probability";
const SOURCE_ID = "src_probability_traps";

function chunk(id: string, ordinal: number, text: string, section: string, page: number): SourceChunk {
  return { id, sourceId: SOURCE_ID, ordinal, text, locator: { section, page } };
}

const SOURCE_CHUNKS: SourceChunk[] = [
  chunk(
    "ch_pr_cond_1", 1,
    "Conditional probability is the probability of an event after we already know that another event happened. For events A and B, with P(B) greater than zero, P(A|B) = P(A and B) / P(B). The vertical bar is read 'given'. Conditioning is easiest to picture as shrinking the sample space: instead of all possible outcomes, we only consider the outcomes in B, and then renormalise so that the restricted probabilities add to one. Example: roll a fair six-sided die. The probability the result is even is 3/6. Given that the result is at least five, the sample space becomes {5, 6}; the probability it is even is now 1/2, because only 6 is even. Conditioning changed the denominator, not the event itself.",
    "1 · Conditional probability", 3
  ),
  chunk(
    "ch_pr_cond_2", 2,
    "Conditional probability is not symmetric: P(A|B) and P(B|A) answer different questions. P(A|B) restricts the sample space to B and asks how much of it lies in A; P(B|A) does the reverse. They are equal only in special cases, for example when P(A) and P(B) happen to be equal. A useful sanity check is to swap the events in a sentence and notice that the meaning changes: the probability of a positive test given a disease is not the probability of a disease given a positive test. Both are conditional probabilities, but one is a property of the test and the other is the updated belief about the patient. Bayes theorem is the tool that converts between the two.",
    "1 · Conditional probability", 4
  ),
  chunk(
    "ch_pr_indep_1", 3,
    "Two events are independent when knowing that one happened does not change the probability of the other: P(A|B) = P(A), and equivalently P(A and B) = P(A) × P(B). Independence is a modelling assumption about how the data were generated, not a quantity you read off a single data set. A fair coin landing heads on the first toss does not change the probability of heads on the second, so the two tosses are independent. Two draws from a deck without replacement are not independent: after the first card is taken, the deck has changed and the second probability depends on the first outcome. Independence can also be conditional: two variables may be independent within each group but dependent overall, a pattern known as Simpson's paradox.",
    "2 · Independence", 6
  ),
  chunk(
    "ch_pr_indep_2", 4,
    "Independence and mutual exclusivity are different ideas, and confusing them causes real errors. Events are mutually exclusive, or disjoint, when they cannot happen together: P(A and B) = 0. They are independent when the occurrence of one leaves the probability of the other unchanged: P(A and B) = P(A) × P(B). If both events have positive probability, mutual exclusivity implies dependence, not independence. Knowing that A happened tells you that B did not happen, which is the strongest possible change in B's probability. A coin landing heads and landing tails are mutually exclusive but dependent. The two ideas coincide only when at least one of the events has probability zero, which makes the coincidence uninteresting in practice.",
    "2 · Independence", 7
  ),
  chunk(
    "ch_pr_bayes_1", 5,
    "Bayes theorem turns a conditional probability around. It answers: given the evidence, how should I update my belief? The formula is P(hypothesis | evidence) = P(evidence | hypothesis) × P(hypothesis) / P(evidence). Each part has a name. P(hypothesis) is the prior: what we believed before seeing the evidence. P(evidence | hypothesis) is the likelihood: how well the hypothesis predicts the evidence. P(hypothesis | evidence) is the posterior: the updated belief. The denominator P(evidence) is the total probability of the evidence under all hypotheses; it normalises the posterior so the probabilities add to one. Because the denominator is the same for every hypothesis, people often write posterior proportional to likelihood times prior, then normalise at the end.",
    "3 · Bayes theorem", 9
  ),
  chunk(
    "ch_pr_bayes_2", 6,
    "A short example shows the updating mechanics. Suppose a rare disease has prior probability 0.001. A test is positive. The likelihood of a positive test given the disease is 0.99, and the probability of a positive test without the disease is 0.05. Bayes theorem multiplies the likelihood by the prior, 0.99 × 0.001 = 0.00099, and divides by the total probability of a positive test, 0.00099 + 0.05 × 0.999, which is about 0.051. The posterior is close to 0.019, or about 2%. The evidence raised the probability from 0.1% to about 2%, but the hypothesis is still unlikely because the prior was small. Updating is sequential: today's posterior becomes tomorrow's prior when new evidence arrives.",
    "3 · Bayes theorem", 10
  ),
  chunk(
    "ch_pr_baserate_1", 7,
    "Base rates are the background frequencies of a condition before any specific evidence arrives; in Bayes terms, they are the priors. Base-rate neglect is the tendency to ignore them and answer with the test's accuracy instead. Suppose a disease affects 1 person in 10,000. A test is 99% sensitive, so it detects 99% of true cases, and 99% specific, so 1% of healthy people falsely test positive. Picture 10,000 people: about 1 has the disease and tests positive; among the 9,999 healthy people, about 100 receive a false positive. Of roughly 101 positive results, only about 1 is a true case, so the probability of disease given a positive test is about 1%. The rare base rate makes false positives dominate even with an accurate test.",
    "4 · Base-rate neglect", 12
  ),
  chunk(
    "ch_pr_baserate_2", 8,
    "Base-rate neglect is usually explained by the representativeness heuristic: a vivid, specific description or a positive test result feels more informative than a dry background frequency, so people anchor on the evidence and underweight the prior. The error shrinks when the same information is presented as natural frequencies instead of conditional probabilities. Saying 'about 100 of every 10,000 healthy people test positive, and 1 sick person does too' makes the ratio of false positives to true positives visible, and most people then answer correctly. The corrective habit is to ask two questions before trusting a positive result: how common is the condition, and how often does the test fire without it? When the condition is rare, a positive result often says more about the test's false-positive rate than about the patient.",
    "4 · Base-rate neglect", 13
  ),
  chunk(
    "ch_pr_ev_1", 9,
    "The expected value of a random quantity is the probability-weighted average of its possible outcomes. For a discrete variable X, expected value is the sum over outcomes x of P(x) × x. A fair six-sided die has expected value (1+2+3+4+5+6)/6 = 3.5. No roll ever equals 3.5; the number describes the long-run average if the die were rolled many times. A gamble is called fair when its expected value equals what you pay to play. If a ticket costs 2 and pays 10 with probability 1 in 10, the expected payout is 1, so the ticket is a losing bet in expectation. Expected value is the standard tool for comparing uncertain options, but it describes averages, not what will happen on any single trial.",
    "5 · Expected value", 15
  ),
  chunk(
    "ch_pr_ev_2", 10,
    "Expected value is not the most likely outcome, and it is not a measure of risk. A lottery ticket can have a tiny chance of a huge prize and a large chance of losing the stake; the expected value summarises the average return, while the variance describes how spread out the outcomes are. Two gambles can share an expected value while one is nearly certain and the other is a long shot, and the right choice may depend on how much the decision maker can afford to lose. Expected value also assumes the probabilities are known. In practice they are estimated from data, so the expected value inherits the uncertainty of those estimates. Used carefully, it is a decision aid: it makes the trade-off between probabilities and payoffs explicit rather than leaving it to intuition.",
    "5 · Expected value", 16
  ),
  chunk(
    "ch_pr_monty_1", 11,
    "The Monty Hall problem: three doors hide one prize and two goats. You pick a door. The host, who knows where the prize is, always opens one of the other two doors to reveal a goat, and then always offers you the chance to switch to the remaining closed door. Should you switch? Your initial pick is correct with probability 1/3. The host's action does not move the prize, so the probability that your original door hides the prize stays 1/3. The other 2/3 of probability must sit on the single door the host chose not to open, because he avoided opening it for a reason when he could. Switching therefore wins with probability 2/3, while staying wins with probability 1/3. The host's behaviour is part of the rules of the game, not noise.",
    "6 · The Monty Hall update", 18
  ),
  chunk(
    "ch_pr_monty_2", 12,
    "Monty Hall is a conditional probability problem, not a choice between two equally likely doors. After the host opens a goat door, the two closed doors look symmetric, which tempts people to say the odds are 50/50. But the host's action is informative because it is constrained: he must open a goat door, he must not open your door, and he never reveals the prize. His choice reveals information about where the prize is not. A larger version makes the logic obvious. With 100 doors, your first pick wins 1% of the time. The host then opens 98 goat doors, carefully avoiding the prize. The chance that the remaining unopened door is the prize is 99%, because the host's constrained choices concentrated the probability there. Switching is not a gamble between equal doors; it is a Bayes update on the host's behaviour.",
    "6 · The Monty Hall update", 19
  ),
];

export const PROBABILITY: Course = {
  id: COURSE_ID,
  code: "STAT201",
  title: "Probability Traps",
  subject: "Probability & Statistics",
  demo: true,
  sources: [
    {
      id: SOURCE_ID,
      title: "Probability Traps (VIVA course notes)",
      type: "notes",
      chunks: SOURCE_CHUNKS,
    },
  ],
  concepts: [
    {
      id: "c_cond",
      name: "Conditional probability",
      aliases: ["conditional probability", "conditional", "given that", "conditioning", "condition on", "p(a|b)"],
      description: "Restricting the sample space to the outcomes where an event happened and renormalising: P(A|B) = P(A∩B)/P(B).",
      related: ["c_bayes", "c_indep"],
    },
    {
      id: "c_indep",
      name: "Independence",
      aliases: ["independence", "independent", "dependent", "dependence"],
      description: "Two events are independent when one happening leaves the other's probability unchanged: P(A∩B) = P(A)P(B).",
      related: ["c_cond"],
    },
    {
      id: "c_bayes",
      name: "Bayes theorem",
      aliases: ["bayes theorem", "bayes' theorem", "bayes rule", "bayes", "posterior", "prior", "likelihood", "p(b|a)"],
      description: "Updating beliefs: posterior proportional to likelihood times prior, normalised by the total probability of the evidence.",
      related: ["c_cond", "c_baserate"],
    },
    {
      id: "c_baserate",
      name: "Base-rate neglect",
      aliases: ["base-rate neglect", "base rate neglect", "base-rate", "base rate", "base rates"],
      description: "Underweighting the prior prevalence when interpreting evidence; rare conditions make false positives dominate.",
      related: ["c_bayes"],
    },
    {
      id: "c_ev",
      name: "Expected value",
      aliases: ["expected value", "expectation", "expected payoff", "expected utility"],
      description: "The probability-weighted average of outcomes: E[X] = Σ P(x)·x; a long-run average, not a prediction of one trial.",
      related: [],
    },
    {
      id: "c_monty",
      name: "The Monty Hall update",
      aliases: ["monty hall", "monty hall problem", "monty", "switching doors", "switch doors"],
      description: "A constrained host action carries information: the initial 1/3 stays put while the remaining 2/3 concentrates on the door the host avoided.",
      related: ["c_cond", "c_bayes"],
    },
  ],
  examQuestions: [
    {
      id: "ex_pr_cond_1",
      conceptId: "c_cond",
      question: "State the definition of P(A|B) and explain what conditioning does to the sample space.",
      requiredKeywords: ["conditional", "sample space", "renormal"],
      hint: "Start from P(A and B) divided by something, then say which outcomes you keep and how the probabilities are rescaled.",
    },
    {
      id: "ex_pr_indep_1",
      conceptId: "c_indep",
      question: "If two events with positive probability are mutually exclusive, what does that tell you about their independence? Explain.",
      requiredKeywords: ["dependent", "zero", "probability"],
      hint: "What is P(A and B) for disjoint events, and what would the independence multiplication rule require?",
    },
    {
      id: "ex_pr_bayes_1",
      conceptId: "c_bayes",
      question: "Write Bayes theorem and say what the prior, the likelihood and the posterior each represent.",
      requiredKeywords: ["prior", "likelihood", "posterior"],
      hint: "Name the three ingredients, then explain which one is updated and what plays the normalising role.",
    },
    {
      id: "ex_pr_baserate_1",
      conceptId: "c_baserate",
      question: "A rare disease affects 1 in 10,000 people. A test is 99% sensitive and 99% specific. A person tests positive. Explain why their chance of having the disease is around 1%, not 99%.",
      requiredKeywords: ["false positive", "base rate", "rare"],
      hint: "Imagine 10,000 people and count the expected true positives against the expected false positives.",
    },
    {
      id: "ex_pr_ev_1",
      conceptId: "c_ev",
      question: "What is the expected value of a fair six-sided die, and what does that number actually mean?",
      requiredKeywords: ["average", "outcome", "probability"],
      hint: "Multiply each outcome by its probability and add. Does any single roll equal the total?",
    },
  ],
  teachback: {
    keywords: {
      c_cond: ["conditional", "given", "sample space", "denominator"],
      c_indep: ["independent", "product", "probabilities", "assumption"],
      c_bayes: ["prior", "likelihood", "posterior"],
      c_baserate: ["base rate", "prior", "false positive", "rare"],
      c_ev: ["expected value", "outcome", "probability", "average"],
      c_monty: ["switch", "host", "two thirds", "information"],
    },
    hints: {
      c_cond: "Define P(A|B) and say what conditioning does to the denominator.",
      c_indep: "State the multiplication rule and say whether independence is an assumption or a measured fact.",
      c_bayes: "Name the three ingredients — prior, likelihood, posterior — and where the normalising denominator comes from.",
      c_baserate: "Imagine 10,000 people and count the false positives. What does the base rate do to the answer?",
      c_ev: "Multiply each outcome by its probability and add. What does that total actually describe?",
      c_monty: "Why is the host's choice informative? Compare the 1/3 you started with to the 2/3 behind the remaining door.",
    },
  },
  explainers: {
    c_cond: {
      formal:
        "For events A and B with P(B) > 0, P(A|B) = P(A∩B) / P(B). Conditioning restricts the sample space to outcomes where B occurred and renormalises by P(B) so the restricted probabilities sum to one (§1, p.3).",
      jargonFree:
        "A conditional probability shrinks the world to the cases you already know about, then asks how often the event you care about happens inside that smaller world. If you know the die roll is at least five, the world is just {5, 6}.",
      missing: ["the formula P(A|B) = P(A∩B) / P(B)", "why conditioning changes the denominator"],
    },
    c_indep: {
      formal:
        "A and B are independent when P(A∩B) = P(A)P(B), equivalently P(A|B) = P(A) when P(B) > 0. Independence is an assumption about the data-generating process, not something a single data set proves (§2, p.6).",
      jargonFree:
        "Two events are independent when one happening teaches you nothing about the other. A coin does not remember its last toss, so the second toss is unaffected by the first.",
      missing: ["the multiplication rule P(A∩B) = P(A)P(B)", "independence is a modelling assumption"],
    },
    c_bayes: {
      formal:
        "Bayes theorem states P(H|E) = P(E|H)P(H) / P(E), or posterior proportional to likelihood times prior. The denominator P(E) is the total probability of the evidence and normalises the posterior (§3, p.9).",
      jargonFree:
        "Start with what you believed (the prior). See how well the new evidence fits each explanation (the likelihood). Multiply and renormalise, and you get your updated belief (the posterior): beliefs move toward whichever explanation predicted the evidence better.",
      missing: ["posterior proportional to likelihood times prior", "the normalising denominator"],
    },
    c_baserate: {
      formal:
        "Base-rate neglect is discounting the prior prevalence P(H) when interpreting evidence. For a rare condition, false positives from the large healthy group can outnumber true positives, so P(H|E) stays small even with an accurate test (§4, p.12).",
      jargonFree:
        "If a disease is very rare, most positive tests come from the huge number of healthy people rather than from the few sick people. Counting 10,000 people makes the ratio obvious: about 100 false positives against roughly 1 true one.",
      missing: ["the base rate is the prior", "false positives dominate when the condition is rare"],
    },
    c_ev: {
      formal:
        "The expected value of a discrete random variable is E[X] = Σ P(x)·x, the probability-weighted average of its outcomes. It describes long-run behaviour, not the result of any single trial (§5, p.15).",
      jargonFree:
        "Roll a die many times and average the results: you will hover near 3.5. Expected value is that long-run average — a number no individual roll can produce.",
      missing: ["the probability-weighted sum", "expected value is a long-run average"],
    },
    c_monty: {
      formal:
        "In Monty Hall the host always reveals a goat and always offers the switch. The initial choice wins with probability 1/3; the host's constrained action concentrates the remaining 2/3 on the other unopened door, so switching wins with probability 2/3 (§6, p.18).",
      jargonFree:
        "Your first pick is almost certainly wrong (2 times out of 3). The host knows where the prize is and must show you a goat, so when he skips a door he is telling you where the prize probably is. Switch.",
      missing: ["the host's action is constrained", "switching wins with probability 2/3"],
    },
  },
  traps: [
    {
      id: "trap_cond_symmetry",
      conceptId: "c_cond",
      statement: "P(A|B) and P(B|A) are the same thing, so the order of the bar does not matter.",
      whyWrong:
        "Conditioning is not symmetric: P(A|B) renormalises by P(B) while P(B|A) renormalises by P(A). The two are equal only in special cases such as P(A) = P(B). A positive test given a disease and a disease given a positive test are very different quantities.",
      correct: "P(A|B) = P(A∩B)/P(B) and P(B|A) = P(A∩B)/P(A); Bayes theorem is exactly the tool that converts one into the other.",
    },
    {
      id: "trap_indep_exclusive",
      conceptId: "c_indep",
      statement: "Mutually exclusive events are independent.",
      whyWrong:
        "If A happens, B cannot happen, so knowing A changes B's probability to zero — the strongest possible dependence. Mutual exclusivity means P(A∩B) = 0; independence means P(A∩B) = P(A)P(B). With positive probabilities the two cannot both hold.",
      correct: "Mutually exclusive implies dependent (when both probabilities are positive); independence requires the multiplication rule to hold.",
    },
    {
      id: "trap_monty_fifty",
      conceptId: "c_monty",
      statement: "After the host opens a goat door, the two unopened doors are equally likely, so switching does not matter.",
      whyWrong:
        "The host's choice is constrained: he must avoid your door, must open a goat, and never reveals the prize. His action concentrates probability rather than splitting it evenly, so the two closed doors are not symmetric.",
      correct: "Your first pick wins with probability 1/3 and stays there; the other unopened door carries the remaining 2/3, so switching wins twice as often.",
    },
  ],
};
