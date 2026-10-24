export function rankSources(sources) {
  return [...sources].sort((a, b) => b.score - a.score);
}
