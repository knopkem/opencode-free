const CHECKED_AT = "2026-11-04"

const FAMILY_DEFINITIONS = {
  "deepseek-v4.1-flash": {
    sourceModel: "DeepSeek V4.1 Flash",
    matches: ["opencode/deepseek-v4.1-flash-free"],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 90.9,
        scale: 100,
        url: "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "DeepSWE v1.1",
        dimension: "coding",
        score: 74.2,
        scale: 100,
        url: "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "Terminal-Bench 2.1",
        dimension: "toolUse",
        score: 90.6,
        scale: 100,
        url: "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "glm-5.3-flash": {
    sourceModel: "GLM-5.3 Flash",
    matches: ["opencode/glm-5.3-flash-free"],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 86.36,
        scale: 100,
        url: "https://www.vals.ai/models/zai_glm-5.3-flash",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 92.0,
        scale: 100,
        url: "https://www.vals.ai/benchmarks/swebench",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "Toolathlon Verified",
        dimension: "toolUse",
        score: 78.4,
        scale: 100,
        url: "https://z.ai/blog/glm-5.3-flash",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "mimo-v2.6-flash": {
    sourceModel: "MiMo V2.6 Flash",
    matches: ["opencode/mimo-v2.6-flash-free"],
    priors: {
      reasoning: 0.68,
      coding: 0.66,
      toolUse: 0.64,
      instructionFollowing: 0.74,
      confidence: 0.6,
    },
    evidence: [],
  },
  "qwen3-30b-a3b-instruct-2507": {
    sourceModel: "Qwen3-30B-A3B-Instruct-2507",
    matches: [
      "lmstudio/qwen/qwen3-30b-a3b-2507",
      "openrouter/qwen/qwen3-30b-a3b-instruct-2507:free",
    ],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 70.4,
        scale: 100,
        url: "https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "LiveCodeBench v6",
        dimension: "coding",
        score: 43.2,
        scale: 100,
        url: "https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "BFCL-v3",
        dimension: "toolUse",
        score: 65.1,
        scale: 100,
        url: "https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "IFEval",
        dimension: "instructionFollowing",
        score: 84.7,
        scale: 100,
        url: "https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "qwen3-coder-30b-a3b-instruct": {
    sourceModel: "Qwen3-Coder-30B-A3B-Instruct",
    matches: [
      "lmstudio/qwen/qwen3-coder-30b",
      "openrouter/qwen/qwen3-coder-30b-a3b-instruct:free",
    ],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 51.6,
        scale: 100,
        url: "https://artificialanalysis.ai/models/qwen3-coder-30b-a3b-instruct",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 60.4,
        scale: 100,
        url: "https://www.swebench.com/",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "LiveCodeBench",
        dimension: "coding",
        score: 40.3,
        scale: 100,
        url: "https://artificialanalysis.ai/models/qwen3-coder-30b-a3b-instruct",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "BFCL-v3",
        dimension: "toolUse",
        score: 62.2,
        scale: 100,
        url: "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "IFBench",
        dimension: "instructionFollowing",
        score: 32.7,
        scale: 100,
        url: "https://artificialanalysis.ai/models/qwen3-coder-30b-a3b-instruct",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "gemma-4-26b-a4b": {
    sourceModel: "Gemma 4 26B A4B",
    matches: [
      "openrouter/google/gemma-4-26b-a4b-it:free",
      "lmstudio/google/gemma-4-26b-a4b",
    ],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 82.3,
        scale: 100,
        url: "https://ai.google.dev/gemma/docs/core/model_card_4",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "LiveCodeBench v6",
        dimension: "coding",
        score: 77.1,
        scale: 100,
        url: "https://ai.google.dev/gemma/docs/core/model_card_4",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "tau2 average",
        dimension: "toolUse",
        score: 68.2,
        scale: 100,
        url: "https://ai.google.dev/gemma/docs/core/model_card_4",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "IFBench",
        dimension: "instructionFollowing",
        score: 72.4,
        scale: 100,
        url: "https://artificialanalysis.ai/models/gemma-4-26b-a4b",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "gemma-4-31b": {
    sourceModel: "Gemma 4 31B",
    matches: [
      "openrouter/google/gemma-4-31b-it:free",
      "lmstudio/google/gemma-4-31b",
    ],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 84.3,
        scale: 100,
        url: "https://ai.google.dev/gemma/docs/core/model_card_4",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "LiveCodeBench v6",
        dimension: "coding",
        score: 80.0,
        scale: 100,
        url: "https://ai.google.dev/gemma/docs/core/model_card_4",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "tau2 average",
        dimension: "toolUse",
        score: 76.9,
        scale: 100,
        url: "https://ai.google.dev/gemma/docs/core/model_card_4",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "gpt-oss-20b": {
    sourceModel: "GPT-OSS-20B",
    matches: [
      "lmstudio/openai/gpt-oss-20b",
      "openrouter/openai/gpt-oss-20b:free",
    ],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 71.5,
        scale: 100,
        url: "https://deploymentsafety.openai.com/gpt-oss/model-architecture-data-training-and-evaluations",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 60.7,
        scale: 100,
        url: "https://deploymentsafety.openai.com/gpt-oss/model-architecture-data-training-and-evaluations",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "tau-bench average",
        dimension: "toolUse",
        score: 46.2,
        scale: 100,
        url: "https://deploymentsafety.openai.com/gpt-oss/model-architecture-data-training-and-evaluations",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "IFBench",
        dimension: "instructionFollowing",
        score: 65.1,
        scale: 100,
        url: "https://artificialanalysis.ai/models/gpt-oss-20b",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "glm-4.7-flash": {
    sourceModel: "GLM-4.7-Flash",
    matches: ["huggingface/zai-org/GLM-4.7-Flash"],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 75.2,
        scale: 100,
        url: "https://huggingface.co/zai-org/GLM-4.7-Flash",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 59.2,
        scale: 100,
        url: "https://huggingface.co/zai-org/GLM-4.7-Flash",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "tau2 average",
        dimension: "toolUse",
        score: 79.5,
        scale: 100,
        url: "https://huggingface.co/zai-org/GLM-4.7-Flash",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "nemotron-3.5-lightning-30b-a3b": {
    sourceModel: "Nemotron 3.5 Lightning 30B A3B",
    matches: [
      "opencode/nemotron-3.5-lightning-free",
      "openrouter/nvidia/nemotron-3.5-lightning:free",
    ],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 75.44,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 51.56,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "tau2 Telecom",
        dimension: "toolUse",
        score: 59.65,
        scale: 100,
        url: "https://docs.nvidia.com/nemotron/nightly/nemotron/lightning35/evaluate.html",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "IFBench",
        dimension: "instructionFollowing",
        score: 71.88,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "nemotron-3.5-super-vl-120b-a12b": {
    sourceModel: "Nemotron 3.5 Super VL 120B A12B",
    matches: [
      "opencode/nemotron-3.5-super-vl-free",
      "openrouter/nvidia/nemotron-3.5-super-vl:free",
    ],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 89.52,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b/modelcard",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 71.1,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b/modelcard",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "tau2 average",
        dimension: "toolUse",
        score: 72.98,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b/modelcard",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "IFBench",
        dimension: "instructionFollowing",
        score: 70.86,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b/modelcard",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "nemotron-3-ultra-550b-a55b": {
    sourceModel: "Nemotron 3 Ultra 550B A55B",
    matches: ["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 87.0,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 71.9,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "TauBench V3 average",
        dimension: "toolUse",
        score: 70.9,
        scale: 100,
        url: "https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "kimi-k3": {
    sourceModel: "Kimi K3",
    matches: [
      "kimi-code-plan-global/k3",
      "kimi-code-plan-global/k3-256k",
    ],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 93.5,
        scale: 100,
        url: "https://huggingface.co/moonshotai/Kimi-K3",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 93.4,
        scale: 100,
        url: "https://www.vals.ai/benchmarks/swebench",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "Toolathlon Verified",
        dimension: "toolUse",
        score: 76.5,
        scale: 100,
        url: "https://huggingface.co/moonshotai/Kimi-K3",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "north-mini-code-1.0": {
    sourceModel: "North Mini Code 1.0",
    matches: ["openrouter/cohere/north-mini-code:free"],
    evidence: [
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 67.6,
        scale: 100,
        url: "https://huggingface.co/CohereLabs/North-Mini-Code-1.0",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "tau2 Telecom",
        dimension: "toolUse",
        score: 37.0,
        scale: 100,
        url: "https://huggingface.co/CohereLabs/North-Mini-Code-1.0",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "lfm2.5-2.6b": {
    sourceModel: "LFM2.5-2.6B",
    matches: ["openrouter/liquid/lfm-2.5-2.6b:free"],
    evidence: [
      {
        benchmark: "AIME 2025",
        dimension: "reasoning",
        score: 51.87,
        scale: 100,
        url: "https://huggingface.co/LiquidAI/LFM2.5-2.6B",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "LiveCodeBench v6",
        dimension: "coding",
        score: 59.41,
        scale: 100,
        url: "https://huggingface.co/LiquidAI/LFM2.5-2.6B",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "BFCLv4",
        dimension: "toolUse",
        score: 56.88,
        scale: 100,
        url: "https://huggingface.co/LiquidAI/LFM2.5-2.6B",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "IFBench",
        dimension: "instructionFollowing",
        score: 59.17,
        scale: 100,
        url: "https://huggingface.co/LiquidAI/LFM2.5-2.6B",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  "inkling-small": {
    sourceModel: "Inkling-Small",
    matches: ["openrouter/thinkingmachines/inkling-small:free"],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 89.5,
        scale: 100,
        url: "https://thinkingmachines.ai/model-card/inkling-small/",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 80.2,
        scale: 100,
        url: "https://thinkingmachines.ai/model-card/inkling-small/",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "Toolathlon Verified",
        dimension: "toolUse",
        score: 54.4,
        scale: 100,
        url: "https://thinkingmachines.ai/model-card/inkling-small/",
        checkedAt: CHECKED_AT,
      },
    ],
  },
  inkling: {
    sourceModel: "Inkling",
    matches: ["openrouter/thinkingmachines/inkling:free"],
    evidence: [
      {
        benchmark: "GPQA Diamond",
        dimension: "reasoning",
        score: 87.2,
        scale: 100,
        url: "https://thinkingmachines.ai/model-card/inkling/",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "SWE-bench Verified",
        dimension: "coding",
        score: 77.6,
        scale: 100,
        url: "https://thinkingmachines.ai/model-card/inkling/",
        checkedAt: CHECKED_AT,
      },
      {
        benchmark: "MCP Atlas",
        dimension: "toolUse",
        score: 76.0,
        scale: 100,
        url: "https://thinkingmachines.ai/model-card/inkling/",
        checkedAt: CHECKED_AT,
      },
    ],
  },
}

function freezeFamily(family) {
  return Object.freeze({
    ...family,
    matches: Object.freeze([...family.matches]),
    evidence: Object.freeze(
      (family.evidence || []).map((item) => Object.freeze({ ...item })),
    ),
    priors: family.priors ? Object.freeze({ ...family.priors }) : undefined,
  })
}

export const PRIOR_FAMILIES = Object.freeze(
  Object.fromEntries(
    Object.entries(FAMILY_DEFINITIONS).map(([id, family]) => [id, freezeFamily(family)]),
  ),
)

const MODEL_TO_FAMILY = new Map()
const MODELS = {}
for (const [id, family] of Object.entries(PRIOR_FAMILIES)) {
  const record = Object.freeze({ id, family })
  for (const key of family.matches) {
    if (MODEL_TO_FAMILY.has(key)) {
      throw new Error(`Duplicate public-prior model match: ${key}`)
    }
    MODEL_TO_FAMILY.set(key, record)
    MODELS[key] = family
  }
}

export const QUALITY_PRIORS = Object.freeze({
  updatedAt: CHECKED_AT,
  version: 3,
  source: "public-benchmark-family-estimate",
  families: PRIOR_FAMILIES,
  models: Object.freeze(MODELS),
})

export function priorFamilyForModel(base) {
  return MODEL_TO_FAMILY.get(base)
}
