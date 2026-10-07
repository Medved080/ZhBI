"""Размер каждого запроса помощника и повтор при меньшем контексте сервера."""
import json
import re
from app import rmr_router
from app.calc import qwen_client, runtime


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class Dialogue:
    def __init__(self, cfg, context_tokens, cancel, progress, stage, meter=None):
        self.cfg, self.cancel, self.progress, self.stage, self.meter = cfg, cancel, progress, stage, meter
        self.cloud = cfg.provider == rmr_router.PROVIDER
        # Настройка клиента не увеличивает уже загруженный контекст OpenAI-сервера.
        # До подтверждения сервером используем совместимый с 8K размер на ВСЕХ этапах.
        # У облачного роутера контекст не зависит от того, что загружено на локальном сервере: берём настроенный.
        self.context = context_tokens if self.cloud else min(context_tokens, 8192)
        self.factor = 1.4

    def _chat(self, messages, schema, name, output):
        cfg = self.cfg.model_copy(update={"maxTokens": output})
        if self.cloud:
            return rmr_router.chat(cfg, messages, schema, name, progress=self.progress, cancel=self.cancel, meter=self.meter)
        return qwen_client.chat(cfg, runtime.settings(), messages, schema, name, progress=self.progress, cancel=self.cancel,
                                context_tokens=self.context, disable_thinking=True, reasoning_guard=False)

    def call(self, messages, schema, name, shrink, max_tokens=None):
        thinking_retry = False
        for attempt in range(3):
            base_output = min(max_tokens or self.cfg.maxTokens, max(512, self.context // 3))
            output = min(self.cfg.maxTokens, 4096, self.context // 2) if thinking_retry else base_output
            budget = self.context - output - 512 - len(encoded(schema)) / self.factor
            while sum(len(m["content"]) for m in messages) / self.factor > budget:
                if self.cancel():
                    raise qwen_client.InferenceCancelled()
                if not shrink():
                    # Сохраняем обязательные данные поиска; резерв повторного ответа
                    # может быть меньше 4096, но должен превышать исходный.
                    available = int(self.context - 512 - len(encoded(schema))/self.factor - sum(len(m["content"]) for m in messages)/self.factor)
                    if thinking_retry and available > base_output:
                        output = min(output, available)
                        break
                    if not thinking_retry and available >= 512:
                        output = min(output, available)
                        self.stage("compact", "Сохраняем необходимые данные и уменьшаем резерв ответа", outputTokens=output)
                        break
                    raise qwen_client.InferenceError("Вопрос и необходимые данные не помещаются в контекст модели. Разделите вопрос на несколько частей.")
            try:
                return self._chat(messages, schema, name, output)
            except qwen_client.InferenceError as error:
                if isinstance(error, qwen_client.InferenceCancelled):
                    raise
                if isinstance(error, qwen_client.InferenceTruncated) and error.thinking:
                    if thinking_retry or attempt == 2 or min(self.cfg.maxTokens, 4096, self.context // 2) <= output:
                        raise qwen_client.InferenceError(
                            "Модель роутера потратила лимит на рассуждения и не вернула результат. Выберите модель без рассуждений или включите в параметрах роутера «Рассуждения: отключать»." if self.cloud else
                            "Модель потратила лимит на рассуждения и не вернула результат при запросе отключить рассуждения. Сервер не отключил Thinking по запросу сервиса — отключите этот режим в настройках загруженной модели на сервере ИИ.") from None
                    thinking_retry = True
                    self.stage("reasoning_retry", "Повторяем запрос с большим резервом для результата")
                    continue
                if isinstance(error, rmr_router.ContextOverflow):
                    # Облако называет предел структурно; он обычно БОЛЬШЕ нашего бюджета, поэтому «уменьшить до предела» ничего
                    # не сократило бы — сокращаем вдвое и калибруем оценку токенов по числу, названному сервером.
                    limit_n, tokens_n = error.n_ctx, error.n_prompt
                    overflow = True
                else:
                    text = str(error)
                    limit = re.search(r'(?:n_ctx[\s\"\'\\:]+|available context size\s*\(|context (?:size|length)\s*[:=]\s*)(\d+)', text)
                    tokens = re.search(r'(?:n_prompt_tokens[\s\"\'\\:]+|request\s*\()(\d+)', text)
                    overflow = "exceed" in text.lower() and "context" in text.lower()
                    limit_n, tokens_n = (int(limit[1]) if limit else None), (int(tokens[1]) if tokens else None)
                if not overflow:
                    raise
                if attempt == 2:
                    raise qwen_client.InferenceError(
                        "Модель роутера отклонила запрос из-за размера контекста даже после сокращения. Разделите вопрос на несколько частей или уменьшите «Контекст диалога»." if self.cloud else
                        "Сервер модели отклонил запрос из-за размера контекста даже после сокращения. Разделите вопрос на несколько частей или увеличьте контекст загруженной модели на сервере.") from None
                if self.cloud:
                    self.context = max(1024, min(self.context // 2, limit_n or self.context))
                elif limit_n:
                    self.context = min(self.context, limit_n)
                else:
                    self.context = max(1024, self.context // 2)
                # Калибруем оценку по фактическому числу токенов, если сервер его сообщил.
                if tokens_n:
                    self.factor = min(self.factor, sum(len(m["content"]) for m in messages) / max(1, tokens_n) * .75)
                else:
                    self.factor *= .65
                self.stage("compact", "Сокращаем контекст до лимита сервера и повторяем запрос", contextTokens=self.context)
        raise AssertionError("недостижимая ветка")


def trim_history(history):
    if len(history) > 2:
        del history[:2]
        return True
    for message in history:
        if len(message["content"]) > 500:
            message["content"] = message["content"][:300] + "…" + message["content"][-199:]
            return True
    return False
