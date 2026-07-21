// data/demo-teachers.js
// ════════════════════════════════════════════════════════════════════════════
//  SHOWCASE QUIZ — ENGLISH & MATHS (LaTeX demo)
//  Built for a live presentation of the site — mixes English-language
//  questions with a few maths questions that exercise KaTeX rendering.
// ════════════════════════════════════════════════════════════════════════════

export const DEMO_TEACHERS_QUESTIONS = [
  {
    cat: "📘 English Language",
    q: "Which word is the closest synonym of \"meticulous\"?",
    opts: ["Careless", "Thorough", "Hasty", "Indifferent"],
    ans: 1,
    exp: "\"Meticulous\" means showing great attention to detail, so \"thorough\" is the closest synonym. \"Careless,\" \"hasty,\" and \"indifferent\" all describe the opposite attitude."
  },
  {
    cat: "📘 English Language",
    q: "Choose the grammatically correct sentence.",
    opts: [
      "Neither of the students have finished their homework.",
      "Neither of the students has finished their homework.",
      "Neither of the student has finish their homework.",
      "Neither of the students finished they homework."
    ],
    ans: 1,
    exp: "\"Neither\" is grammatically singular, so it takes a singular verb (\"has\") even though it's followed by a plural noun (\"students\") — a classic subject-verb agreement trap."
  },
  {
    cat: "📘 English Language",
    q: "What is the correct comparative form of \"good\"?",
    opts: ["Gooder", "More good", "Better", "Best"],
    ans: 2,
    exp: "\"Good\" is an irregular adjective: comparative = \"better\", superlative = \"best\". \"Gooder\" and \"more good\" are not standard English."
  },
  {
    cat: "🧮 Mathematics",
    q: "What is the value of $\\displaystyle\\int_0^1 x^2\\,dx$?",
    opts: ["$\\dfrac{1}{2}$", "$\\dfrac{1}{3}$", "$1$", "$\\dfrac{2}{3}$"],
    ans: 1,
    exp: "$\\displaystyle\\int_0^1 x^2\\,dx = \\left[\\dfrac{x^3}{3}\\right]_0^1 = \\dfrac{1}{3}$."
  },
  {
    cat: "🧮 Mathematics",
    q: "Solve for $x$: $2x^2 - 8 = 0$.",
    opts: ["$x = 2$ only", "$x = -2$ only", "$x = \\pm 2$", "$x = \\pm 4$"],
    ans: 2,
    exp: "$2x^2 = 8 \\Rightarrow x^2 = 4 \\Rightarrow x = \\pm\\sqrt{4} = \\pm 2$."
  },
  {
    cat: "🧮 Mathematics",
    q: "What does Euler's identity state?",
    opts: [
      "$e^{i\\pi} + 1 = 0$",
      "$e^{i\\pi} - 1 = 0$",
      "$e^{i\\pi} = i$",
      "$e^{i\\pi} + i = 0$"
    ],
    ans: 0,
    exp: "Euler's identity links five fundamental constants in one equation: $e^{i\\pi} + 1 = 0$, obtained from $e^{i\\theta} = \\cos\\theta + i\\sin\\theta$ at $\\theta = \\pi$."
  },
  {
    cat: "🧮 Mathematics",
    q: "What is the derivative of $f(x) = \\sin(x^2)$?",
    opts: [
      "$\\cos(x^2)$",
      "$2x\\cos(x^2)$",
      "$2x\\sin(x^2)$",
      "$x^2\\cos(x)$"
    ],
    ans: 1,
    exp: "By the chain rule, $f'(x) = \\cos(x^2) \\cdot \\dfrac{d}{dx}(x^2) = 2x\\cos(x^2)$."
  }
];
