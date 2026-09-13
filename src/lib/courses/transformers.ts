import type { SourceChunk } from "@/lib/types";
import type { Course } from "./types";

/**
 * Lab 1 — Introduction to Transformers.
 * Original educational text written for this project so every citation resolves
 * to a real chunk. Six topics, each with 2 chunks (12 total).
 */

const COURSE_ID = "course_transformers_w4";
const SOURCE_ID = "src_transformers_intro";

function chunk(id: string, ordinal: number, text: string, section: string, page: number): SourceChunk {
  return { id, sourceId: SOURCE_ID, ordinal, text, locator: { section, page } };
}

const SOURCE_CHUNKS: SourceChunk[] = [
  chunk(
    "ch_sa_1", 1,
    "Self-attention lets every token in a sequence compare itself with every other token. For each pair, the model computes a compatibility score, normalises the scores with a softmax into weights, and returns a weighted average of the value vectors. The result is a contextual representation: the same word gets a different vector depending on its neighbours.",
    "1 · Self-attention", 4
  ),
  chunk(
    "ch_sa_2", 2,
    "Attention weights answer 'how much should this token listen to each other token'. They do not encode order by themselves. If you permute the input tokens and permute the outputs the same way, the computation is unchanged: self-attention without position information is permutation-equivariant.",
    "1 · Self-attention", 5
  ),
  chunk(
    "ch_qkv_1", 3,
    "Each token is projected into three vectors: a query (what this token is looking for), a key (what this token offers to others), and a value (the content carried forward). The attention score between token i and token j is the dot product of query i and key j, scaled by the square root of the key dimension.",
    "2 · Queries, keys, values", 7
  ),
  chunk(
    "ch_qkv_2", 4,
    "Queries ask, keys advertise, values deliver. After softmax, the weights multiply the values: output_i = sum_j weight_ij · value_j. Two tokens can therefore have similar keys (both match a query) but carry different values (contribute different content).",
    "2 · Queries, keys, values", 8
  ),
  chunk(
    "ch_pos_1", 5,
    "A standard Transformer has no recurrence and no convolution, so by itself it cannot tell first from last: without positional information it does not know token order. Positional encodings (fixed sinusoidal patterns or learned vectors) are added to the token embeddings so that 'dog bites man' and 'man bites dog' produce different representations.",
    "3 · Positional information", 11
  ),
  chunk(
    "ch_pos_2", 6,
    "Because attention is permutation-equivariant, removing positional information makes the model treat a shuffled sentence nearly the same as the original: it can still compare tokens and find which ones are related, but it cannot distinguish their order. Exam questions on this point ask what property of the sequence is lost — the answer is order, not importance or relevance.",
    "3 · Positional information", 12
  ),
  chunk(
    "ch_mh_1", 7,
    "Multi-head attention runs the query-key-value computation h times in parallel, each in a smaller subspace. Different heads specialise: one may track subject-verb agreement, another coreference, another positional adjacency. Their outputs are concatenated and projected back to the model dimension.",
    "4 · Multi-head attention", 15
  ),
  chunk(
    "ch_mh_2", 8,
    "A single attention head computes one weighted average, which bottlenecks what it can express. With eight heads, the model computes eight different averages and combines them, so each layer captures several relation types at once instead of one.",
    "4 · Multi-head attention", 16
  ),
  chunk(
    "ch_bp_1", 9,
    "Backpropagation applies the chain rule to compute the gradient of the loss with respect to every weight. Gradient descent then steps each weight against its gradient, scaled by the learning rate. The learning rate is a step-size choice, not part of the gradient computation itself.",
    "5 · Optimisation background", 19
  ),
  chunk(
    "ch_bp_2", 10,
    "Backpropagation computes gradients; gradient descent uses them. Confusing the two is the most common error in this section: backprop answers 'which direction', the optimiser answers 'how far'.",
    "5 · Optimisation background", 20
  ),
  chunk(
    "ch_rl_1", 11,
    "Policy iteration alternates two steps: policy evaluation (compute values for the current policy) and policy improvement (act greedily with respect to those values). Value iteration instead applies the Bellman optimality update directly at every sweep, folding improvement into the update.",
    "6 · RL background", 23
  ),
  chunk(
    "ch_rl_2", 12,
    "Policy evaluation estimates how good the current behaviour is; policy improvement changes the behaviour. Value iteration skips the full evaluation and always updates toward the optimal value function. Mixing up 'improvement' with 'value iteration' signals a policy/value confusion.",
    "6 · RL background", 24
  ),
];

export const TRANSFORMERS: Course = {
  id: COURSE_ID,
  code: "COMP532",
  title: "Transformers — Week 4",
  subject: "Machine Learning",
  demo: true,
  sources: [
    {
      id: SOURCE_ID,
      title: "Introduction to Transformers (VIVA course notes)",
      type: "notes",
      chunks: SOURCE_CHUNKS,
    },
  ],
  concepts: [
    {
      id: "c_self_attention",
      name: "Self-attention",
      aliases: ["self attention", "attention", "attentions"],
      description: "Mechanism that lets each token compare itself with every other token to build contextual representations.",
      related: ["c_qkv", "c_multihead", "c_position"],
    },
    {
      id: "c_qkv",
      name: "Queries, Keys, Values",
      aliases: ["queries", "keys", "values", "qkv", "query", "key", "value", "q/k/v"],
      description: "The three projections in attention: queries ask, keys advertise, values carry content; scores come from query-key comparison.",
      related: ["c_self_attention", "c_multihead"],
    },
    {
      id: "c_position",
      name: "Positional information",
      aliases: ["positional encoding", "position encoding", "positional information", "position information", "positions", "order", "sequence order", "positional"],
      description: "Injected order signal (sinusoidal or learned) without which attention is permutation-invariant and cannot distinguish token order.",
      related: ["c_self_attention"],
    },
    {
      id: "c_multihead",
      name: "Multi-head attention",
      aliases: ["multi-head", "multi head", "multihead", "heads"],
      description: "Multiple attention heads run in parallel subspaces so the model can track different relation types at once.",
      related: ["c_self_attention", "c_qkv"],
    },
    {
      id: "c_backprop",
      name: "Backpropagation",
      aliases: ["backprop", "backpropagation", "gradient descent", "learning rate"],
      description: "Gradient computation via the chain rule; gradient descent updates weights, scaled by the learning rate.",
      related: [],
    },
    {
      id: "c_policy_value",
      name: "Policy vs value iteration",
      aliases: ["policy iteration", "value iteration", "bellman"],
      description: "Two dynamic-programming planners: policy iteration alternates evaluation and improvement; value iteration applies the Bellman optimality update directly.",
      related: [],
    },
  ],
  examQuestions: [
    {
      id: "ex_pos_1",
      conceptId: "c_position",
      question: "Explain why positional information is necessary in a standard Transformer architecture.",
      requiredKeywords: ["order", "attention", "permutation"],
      hint: "Think about what self-attention alone is invariant to: if you shuffle the tokens, what changes — and what does not?",
    },
    {
      id: "ex_pos_2",
      conceptId: "c_position",
      question: "If a Transformer had no positional information, what important property of the sequence would it struggle to distinguish?",
      requiredKeywords: ["order"],
      hint: "It can still tell which tokens are related. What does it lose — importance, or something about arrangement?",
    },
    {
      id: "ex_sa_1",
      conceptId: "c_self_attention",
      question: "In one or two sentences, say what an attention weight means.",
      requiredKeywords: ["weight", "token"],
      hint: "Weights say how much one token listens to another before averaging values.",
    },
    {
      id: "ex_qkv_1",
      conceptId: "c_qkv",
      question: "What distinct roles do queries, keys and values play in attention?",
      requiredKeywords: ["quer", "key", "value"],
      hint: "One asks, one advertises, one delivers content. Which is which?",
    },
    {
      id: "ex_mh_1",
      conceptId: "c_multihead",
      question: "Why use multiple attention heads instead of one?",
      requiredKeywords: ["head", "relation"],
      hint: "One head computes one average. What do several heads let the layer track at once?",
    },
    // Every concept carries at least one question, so a ten-minute plan can
    // reach all six. These two had none: the plan could name backpropagation
    // or policy iteration as due and then have nothing to ask about it.
    {
      id: "ex_bp_1",
      conceptId: "c_backprop",
      question: "Backpropagation and gradient descent do different jobs. Say what each one computes.",
      requiredKeywords: ["gradient", "chain rule", "learning rate"],
      hint: "One answers 'which direction', the other answers 'how far'. Which is which, and what scales the step?",
    },
    {
      id: "ex_rl_1",
      conceptId: "c_policy_value",
      question: "How does value iteration differ from policy iteration?",
      requiredKeywords: ["policy", "value", "bellman"],
      hint: "Policy iteration alternates two steps. Which of those does value iteration fold into its update?",
    },
  ],
  teachback: {
    keywords: {
      c_position: ["order", "permutation", "positional", "sequence"],
      c_self_attention: ["token", "weight", "softmax", "compare"],
      c_qkv: ["query", "key", "value", "dot product"],
      c_multihead: ["head", "parallel", "relation", "subspace"],
      c_backprop: ["gradient", "chain rule", "learning rate", "weight"],
      c_policy_value: ["policy", "value", "bellman", "iteration"],
    },
    hints: {
      c_position: "What does attention lose when token order is removed — importance, or arrangement?",
      c_self_attention: "Say how much one token listens to another before values are averaged.",
      c_qkv: "One asks, one advertises, one delivers content. Which is which, and how are scores computed?",
      c_multihead: "One head computes one average. What do several heads in parallel let a layer track at once?",
      c_backprop: "Separate the two jobs: which step computes the direction, and which step decides how far to move?",
      c_policy_value: "Contrast alternating evaluation-plus-improvement with applying the Bellman optimality update directly.",
    },
  },
  explainers: {
    c_self_attention: {
      formal:
        "Self-attention computes a compatibility score between every pair of tokens, turns the scores into weights with a softmax, and returns a weighted average of the value vectors. The output is contextual: the same word gets a different vector depending on its neighbours (Week 4 §1, p.4).",
      jargonFree:
        "Think of a group chat where every word can ask every other word 'how relevant are you to me?'. Each word then blends the others' meanings in proportion to the answers, so the same word ends up meaning something slightly different in every sentence.",
      missing: ["attention weights average the values", "why the result is contextual"],
    },
    c_qkv: {
      formal:
        "Each token is projected into a query, a key, and a value. The score between tokens i and j is the scaled dot product of query i and key j; after softmax, those weights multiply the values. Queries ask, keys advertise, values carry content (Week 4 §2, p.7–8).",
      jargonFree:
        "Every word plays three roles: a question it is asking (query), a label it shows to attract relevant questions (key), and the content it hands over once chosen (value). Matching questions to labels decides whose content gets mixed in.",
      missing: ["query-key dot product", "weighted sum over the values"],
    },
    c_position: {
      formal:
        "Self-attention is permutation-equivariant: shuffle the tokens and the computation shuffles identically, so order information is absent. Positional encodings are added to the embeddings so that order becomes visible to the model (Week 4 §3, p.11–12).",
      jargonFree:
        "Think of attention as a meeting where everyone talks at once. Everyone hears everyone — but nobody knows who spoke first. Positional information is the seating order written on each name tag. Without it, the model hears the words but loses their order. Week 4 §3, p.11 has the exact passage.",
      missing: ["queries → keys → values"],
    },
    c_multihead: {
      formal:
        "Multi-head attention runs several attention computations in parallel, each in a lower-dimensional subspace, then concatenates and projects their outputs. Different heads can specialise in different relation types within the same layer (Week 4 §4, p.15–16).",
      jargonFree:
        "One attention head produces one blend of the sentence. Several heads are like several readers skimming the same page for different things at once — one tracks who did what to whom, another tracks order — and their notes get combined at the end.",
      missing: ["why one head bottlenecks", "what different heads specialise in"],
    },
    c_backprop: {
      formal:
        "Backpropagation applies the chain rule to compute the gradient of the loss with respect to every weight. Gradient descent then steps each weight against its gradient, scaled by the learning rate. Backprop answers 'which direction'; the optimiser answers 'how far' (Week 4 §5, p.19–20).",
      jargonFree:
        "Training is like finding your way downhill in fog. Backprop tells you which way is downhill for every knob in the network; the learning rate decides how big a step to take. A big step is fast but can overshoot; a small step is safe but slow.",
      missing: ["chain rule computes the gradients", "the learning rate is not part of the gradient calculation"],
    },
    c_policy_value: {
      formal:
        "Policy iteration alternates policy evaluation with policy improvement. Value iteration applies the Bellman optimality update directly at every sweep, folding improvement into the update. Evaluation estimates how good the current behaviour is; improvement changes it (Week 4 §6, p.23–24).",
      jargonFree:
        "Imagine navigating a maze. Policy iteration first scores your current route, then changes it, then scores again. Value iteration skips the full scoring pass and directly nudges every position toward its best next move. Both aim at the same optimal route.",
      missing: ["evaluation versus improvement", "the Bellman optimality update"],
    },
  },
  traps: [
    {
      id: "trap_importance_order",
      conceptId: "c_position",
      statement: "Attention weights already encode which words are important, so positional information only adds cosmetic order detail.",
      whyWrong:
        "Attention weights encode relevance to a query, not position. If you permute the input, the whole attention computation permutes identically, so without positional information the model cannot tell first from last — what is lost is order, not importance.",
      correct: "Positional information supplies sequence order; attention without it is permutation-equivariant.",
    },
    {
      id: "trap_backprop_gd",
      conceptId: "c_backprop",
      statement: "Backpropagation is the same thing as gradient descent.",
      whyWrong:
        "Backpropagation computes gradients with the chain rule; gradient descent is the optimiser that uses those gradients to update weights. They are different steps, and the learning rate belongs to the update, not to backprop.",
      correct: "Backprop computes the direction; gradient descent, scaled by the learning rate, decides how far to move.",
    },
  ],
  // Labelled starting map for the starter (§11): the shape a mid-week student
  // walks in with, so the first spoken sentence has something to move.
  priors: {
    c_self_attention: { exposureCount: 4, successfulRecallCount: 2, mastery: 0.68, confidence: 0.55, reviewPriority: 0.35, recalled: true },
    c_qkv: { exposureCount: 3, successfulRecallCount: 1, confusionCount: 1, mastery: 0.58, confidence: 0.5, reviewPriority: 0.45, recalled: true },
    c_position: { exposureCount: 2, confusionCount: 1, mastery: 0.44, confidence: 0.4, reviewPriority: 0.62 },
    c_multihead: { exposureCount: 1, mastery: 0.5, confidence: 0.35, reviewPriority: 0.5 },
  },
  opening: {
    conceptId: "c_multihead",
    chunkId: "ch_mh_1",
    text: "Multi-head attention runs several attention computations in parallel.",
  },
};
