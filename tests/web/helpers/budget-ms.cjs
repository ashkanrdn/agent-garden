function budgetMs(ms) {
  const scale = process.env.PERF_BUDGET_SCALE === undefined
    ? (process.env.CI ? 4 : 1)
    : Number(process.env.PERF_BUDGET_SCALE);
  return ms * scale;
}

module.exports = { budgetMs };
