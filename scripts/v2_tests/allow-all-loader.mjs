// Только для автономных тестов клиента: подменяет политику записи тестовой
// заглушкой, чтобы проверять обработку HTTP и счётчик запросов отдельно от шлюза.
// Браузерная и серверная сборки этот загрузчик не используют.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./write-gate.js" && context.parentURL?.endsWith("/app/static/v2/api.js")) {
    return { url: new URL("./write-gate.allow-all.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
